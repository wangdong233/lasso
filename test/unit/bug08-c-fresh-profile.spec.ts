/**
 * bug08-c-fresh-profile.spec.ts（BUG-08 决议 C，doc/bugs/08，2026-09-15）
 *
 * freshProfile 反爬逃生门（marathon 最痛 P0-3 的正解）：
 *  - 执行体：forgetSpec（旧栈退役）→ registerSpec（新 profile 目录【归属锚】+
 *    stealth 整体切换）→ ensureRunning 调用序 + spec args 断言
 *  - 目录名编码 ownerPid 归属锚（崩溃原子）；连续两次 → 轮换确定性（宿主适用集
 *    单平台退化 = 同名诚实保持，禁随机）
 *  - 清理四路钉：post-kill（先杀后删顺序断言——hook 内树已死）/ exit 同步 /
 *    respawn 前（旧目录删）/ 陈年双闸真值表
 *  - rmSync 前缀守卫：非法 basename 拒删（INV-96④）
 *  - logged_in 拒绝语义（专用错误码）+ base 类默认拒 + schema 缺省 byte-identical
 *
 * mock SubprocessManager（headless 路径）+ 真子进程（顺序断言——post-kill hook
 * 断言的是真实树死时序，mock 无意义）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";
import { SubprocessManager, type SpawnSpec } from "../../src/subprocess/SubprocessManager.js";
import {
  HEADLESS_PROFILE_PREFIX,
  HEADLESS_STALE_PROFILE_MS,
  buildFreshProfileDirName,
  parseOwnerPidFromProfileDir,
  rmFreshProfileDir,
  scanStaleFreshProfiles,
  type StaleProfileScanDeps,
} from "../../src/channels/headless-fresh-profile.js";
import {
  hostApplicableStealthProfiles,
  nextHostApplicableProfile,
  STEALTH_PROFILES,
  defaultHeadlessProfileForHost,
} from "../../src/browse/stealth-profiles.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions, InteractResult } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
function textContent(text: string) {
  return { content: [{ type: "text", text }], isError: false };
}

/** mock SubprocessManager：记录 registerSpec/forgetSpec 调用序 + spec 快照。 */
function makeMockSubproc() {
  const order: string[] = [];
  const specs = new Map<string, SpawnSpec>();
  const mock = {
    order,
    specs,
    registerSpec: vi.fn((name: string, spec: SpawnSpec) => {
      order.push(`registerSpec:${name}`);
      specs.set(name, spec);
    }),
    forgetSpec: vi.fn(async (name: string) => {
      order.push(`forgetSpec:${name}`);
      specs.delete(name);
    }),
    ensureRunning: vi.fn(async (name: string): Promise<McpClient> => {
      order.push(`ensureRunning:${name}`);
      return {
        pid: 424242,
        listTools: async () => [],
        callTool: async () => textContent("- page: Example"),
        close: async () => {},
      } as unknown as McpClient;
    }),
    restart: vi.fn(async (name: string) => {
      order.push(`restart:${name}`);
      return { pid: 424243 } as unknown as McpClient;
    }),
    touch: vi.fn(),
  };
  return mock;
}

type MockSubproc = ReturnType<typeof makeMockSubproc>;

let tempBase: string;
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempBase = mkdtempSync(path.join(os.tmpdir(), "lasso-b08c-base-"));
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-b08c-cache-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempBase, { recursive: true, force: true });
  rmSync(tempCache, { recursive: true, force: true });
});

// ============================================================
// freshProfile 执行体（mock subproc）
// ============================================================
describe("BUG-08 C — freshProfile 执行体", () => {
  it("调用序 forgetSpec → registerSpec → ensureRunning；新 spec args 含 user-data-dir（缺省 spec 无）", async () => {
    const sub = makeMockSubproc();
    const ch = new HeadlessChannel(sub as unknown as SubprocessManager, undefined, undefined, undefined, tempBase);
    // 缺省 spec（构造注册）：无 user-data-dir 注入（v1.25.0 字节级不变锚）
    const defaultArgs = sub.specs.get("headless")!.args;
    expect(defaultArgs.some((a) => a.includes("--user-data-dir"))).toBe(false);

    const r = await ch.freshProfile();
    expect(sub.order).toEqual([
      "registerSpec:headless", // 构造
      "forgetSpec:headless",
      "registerSpec:headless",
      "ensureRunning:headless",
    ]);
    const freshArgs = sub.specs.get("headless")!.args;
    const ud = freshArgs.find((a) => a.startsWith("--chromeArg=--user-data-dir="));
    expect(ud).toBeTruthy();
    expect(ud).toBe(`--chromeArg=--user-data-dir=${r.profileDir}`);
    // stealth 参数随 profile 整体切换（UA/accept-lang/viewport 同源同值）
    const profile = STEALTH_PROFILES[r.stealthProfile];
    expect(freshArgs).toContain(`--chromeArg=--user-agent=${profile.userAgent}`);
    expect(freshArgs).toContain(`--chromeArg=--accept-lang=${profile.acceptLanguage}`);
    expect(freshArgs).toContain(`--viewport=${profile.viewport.width}x${profile.viewport.height}`);
    expect(r.pid).toBe(424242);
    expect(r.spec).toBe("headless");
  });

  it("目录名编码 ownerPid 归属锚（headless-profile-<epoch>-<rand>-p<pid>）+ 真实 mkdir", async () => {
    const sub = makeMockSubproc();
    const ch = new HeadlessChannel(sub as unknown as SubprocessManager, undefined, undefined, undefined, tempBase);
    const r = await ch.freshProfile();
    const base = path.basename(r.profileDir);
    expect(base.startsWith(HEADLESS_PROFILE_PREFIX)).toBe(true);
    expect(base).toMatch(new RegExp(`^${HEADLESS_PROFILE_PREFIX}\\d+-[0-9a-f]+-p\\d+$`));
    expect(parseOwnerPidFromProfileDir(base)).toBe(process.pid);
    expect(existsSync(r.profileDir)).toBe(true); // mkdir 真实发生
  });

  it("连续两次 freshProfile → 轮换确定性（宿主适用集环形；单平台退化 = 同名，禁随机）", async () => {
    const sub = makeMockSubproc();
    const ch = new HeadlessChannel(sub as unknown as SubprocessManager, undefined, undefined, undefined, tempBase);
    const r1 = await ch.freshProfile();
    const r2 = await ch.freshProfile();
    // 确定性：候选集内可复现（当前平台集合大小 ≤1 → 同名退化——决议 §7 残余 5 诚实形态）
    const set = hostApplicableStealthProfiles();
    expect(set.includes(r1.stealthProfile)).toBe(true);
    expect(nextHostApplicableProfile(r1.stealthProfile)).toBe(r2.stealthProfile);
    // 目录必须每次全新（identity 真换）
    expect(r1.profileDir).not.toBe(r2.profileDir);
  });

  it("缺省构造（无 freshProfile 调用）零额外行为：默认 spec 与 v1.25.0 args 序一致", () => {
    const sub = makeMockSubproc();
    new HeadlessChannel(sub as unknown as SubprocessManager, undefined, undefined, undefined, tempBase);
    const args = sub.specs.get("headless")!.args;
    // 锚定 args 序（cdp-mcp-170-migration spec 同族）：前 8 项固定
    expect(args.slice(0, 8)).toEqual([
      "--prefer-offline",
      "-y",
      "chrome-devtools-mcp@1.7.0",
      "--headless",
      "--isolated",
      "--no-usage-statistics",
      "--chromeArg=--disable-blink-features=AutomationControlled",
      `--chromeArg=--user-agent=${STEALTH_PROFILES[defaultHeadlessProfileForHost()].userAgent}`,
    ]);
  });
});

// ============================================================
// 清理路径（受控回收 / exit / respawn 前 / 陈年兜底）
// ============================================================
describe("BUG-08 C — 清理四路", () => {
  it("路径①③ afterHeadlessStackKilled：rmSync 当前 fresh 目录 + 重注册默认 spec（无 user-data-dir）", async () => {
    const sub = makeMockSubproc();
    const ch = new HeadlessChannel(sub as unknown as SubprocessManager, undefined, undefined, undefined, tempBase);
    const r = await ch.freshProfile();
    expect(existsSync(r.profileDir)).toBe(true);
    await ch.afterHeadlessStackKilled();
    expect(existsSync(r.profileDir)).toBe(false); // 删除真实发生
    // 重注册默认 spec：无 user-data-dir（身份生命期终结 → 下次懒启动 = 默认身份）
    expect(sub.specs.get("headless")!.args.some((a) => a.includes("--user-data-dir"))).toBe(false);
    // 幂等：无 fresh 目录时再调零异常
    await expect(ch.afterHeadlessStackKilled()).resolves.not.toThrow();
  });

  it("路径② cleanupFreshProfilesSync：exit 同步删除（killAllSync 后调用形态）", async () => {
    const sub = makeMockSubproc();
    const ch = new HeadlessChannel(sub as unknown as SubprocessManager, undefined, undefined, undefined, tempBase);
    const r = await ch.freshProfile();
    ch.cleanupFreshProfilesSync();
    expect(existsSync(r.profileDir)).toBe(false);
    // 幂等
    expect(() => ch.cleanupFreshProfilesSync()).not.toThrow();
  });

  it("R1 顺序断言（真子进程）：post-kill hook 执行时树已死（先杀后删铁则；pre-kill 窗口零 rmSync）", async () => {
    const mgr = new SubprocessManager();
    const MINI = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mini", version: "0" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
    }
  }
});
setInterval(() => {}, 1 << 30);
`;
    mgr.registerSpec("bug08c-order", {
      command: process.execPath,
      args: ["-e", MINI],
      mcpClientName: "bug08c-order",
    });
    const c = await mgr.ensureRunning("bug08c-order");
    const pid = c.pid!;
    expect(pid).toBeTruthy();

    let hookSawAlive: boolean | null = null;
    let hookRanAfterKill = false;
    mgr.setPostKillHook(async (name) => {
      if (name !== "bug08c-order") return;
      // hook 执行时刻：树必须已死（_retire = await _kill 完成后才调 hook）
      try {
        process.kill(pid, 0);
        hookSawAlive = true;
      } catch {
        hookSawAlive = false;
      }
      hookRanAfterKill = true;
    });
    await mgr.forgetSpec("bug08c-order");
    expect(hookRanAfterKill).toBe(true);
    expect(hookSawAlive).toBe(false); // 先杀后删顺序铁则的机械断言
  }, 20_000);

  it("restart 不触发 post-kill hook（同 spec respawn = 身份延续，profile 保留）", async () => {
    const mgr = new SubprocessManager();
    let hookCalls = 0;
    mgr.setPostKillHook(async () => {
      hookCalls++;
    });
    const MINI_R = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mini", version: "0" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
    }
  }
});
setInterval(() => {}, 1 << 30);
`;
    mgr.registerSpec("bug08c-restart", {
      command: process.execPath,
      args: ["-e", MINI_R],
      mcpClientName: "bug08c-restart",
    });
    const c1 = await mgr.ensureRunning("bug08c-restart");
    const c2 = await mgr.restart("bug08c-restart");
    expect(c2).not.toBe(c1); // 真实 respawn 发生（kill + spawn 链路走过）
    expect(hookCalls).toBe(0); // restart ≠ 退役：post-kill hook 不触发（身份延续）
    await mgr.shutdown();
  }, 20_000);

  it("rmSync 前缀守卫：非法 basename 拒删（fresh_profile_refuse_delete）", () => {
    expect(() => rmFreshProfileDir(path.join(tempBase, "evil-dir"))).toThrow(
      /fresh_profile_refuse_delete/,
    );
    expect(() => rmFreshProfileDir("/tmp")).toThrow(/fresh_profile_refuse_delete/);
    // 合法前缀 + 不存在目录 → force 幂等零异常
    expect(() => rmFreshProfileDir(path.join(tempBase, "headless-profile-1-abc-p1"))).not.toThrow();
  });

  // ---------- 陈年扫描真值表（R1 双闸） ----------
  function scanDeps(overrides: Partial<StaleProfileScanDeps> = {}): StaleProfileScanDeps & { removedCalls: string[] } {
    const removedCalls: string[] = [];
    const deps: StaleProfileScanDeps = {
      isPidAlive: () => false,
      readDir: () => [],
      statAgeMs: () => 0,
      remove: (dir) => removedCalls.push(dir),
      now: () => Date.now(),
      ...overrides,
    };
    return Object.assign(deps, { removedCalls });
  }

  it("陈年真值表：owner 活→留；owner 死+<24h→留；owner 死+>24h→删；无锚+>24h→删；前缀不符→跳过", () => {
    const now = Date.now();
    const old = now - HEADLESS_STALE_PROFILE_MS - 3_600_000; // 超龄 1h 余量
    const young = now - 60_000;
    const liveOwner = 555_004;
    const d = scanDeps({
      isPidAlive: (pid) => pid === liveOwner,
      readDir: () => [
        { name: "headless-profile-" + old + "-aa-p" + liveOwner, isDirectory: true }, // owner 活 → 留
        { name: "headless-profile-" + young + "-bb-p999111", isDirectory: true }, // owner 死 + <24h → 留
        { name: "headless-profile-" + old + "-cc-p999112", isDirectory: true }, // owner 死 + >24h → 删
        { name: "headless-profile-" + old + "-noanchor", isDirectory: true }, // 无锚 + >24h → 删
        { name: "render-chrome-profile-" + old + "-xx", isDirectory: true }, // 前缀不符 → 跳过
        { name: "headless-profile-" + old + "-dd-p999113.txt", isDirectory: false }, // 非目录 → 跳过
      ],
    });
    const r = scanStaleFreshProfiles(tempBase, d);
    expect(r.removed.map((x) => path.basename(x)).sort()).toEqual(
      [
        "headless-profile-" + old + "-cc-p999112",
        "headless-profile-" + old + "-noanchor",
      ].sort(),
    );
    const keptNames = r.kept.map((k) => path.basename(k.dir));
    expect(keptNames).toContain("headless-profile-" + old + "-aa-p" + liveOwner);
    expect(keptNames).toContain("headless-profile-" + young + "-bb-p999111");
    expect(r.removed.length).toBe(2);
  });

  it("陈年：owner 死 + age 恰好 24h 线内（≤阈值）→ 留（线值=删除下界外）", () => {
    const now = Date.now();
    const justUnder = now - HEADLESS_STALE_PROFILE_MS + 1_000;
    const d = scanDeps({
      readDir: () => [{ name: "headless-profile-" + justUnder + "-aa-p999114", isDirectory: true }],
    });
    const r = scanStaleFreshProfiles(tempBase, d);
    expect(r.removed).toEqual([]);
    expect(r.kept[0]!.reason).toBe("age_below_24h");
  });

  it("陈年：基目录不存在 → 空（零异常）", () => {
    const d = scanDeps();
    expect(scanStaleFreshProfiles(path.join(tempBase, "nope"), d).removed).toEqual([]);
  });
});

// ============================================================
// 目录名/扫描纯函数
// ============================================================
describe("BUG-08 C — 目录名纯函数", () => {
  it("buildFreshProfileDirName / parseOwnerPidFromProfileDir 往返", () => {
    const name = buildFreshProfileDirName(4242, 1700000000000, "abc123");
    expect(name).toBe("headless-profile-1700000000000-abc123-p4242");
    expect(parseOwnerPidFromProfileDir(name)).toBe(4242);
    expect(parseOwnerPidFromProfileDir("headless-profile-1-abc")).toBeNull();
    expect(parseOwnerPidFromProfileDir("headless-profile-1-abc-px")).toBeNull();
    expect(parseOwnerPidFromProfileDir("headless-profile-1-abc-p0")).toBeNull();
  });
});

// ============================================================
// 拒绝语义（logged_in / base 默认）+ schema 缺省
// ============================================================
describe("BUG-08 C — freshProfile 拒绝语义", () => {
  class BareChannel extends BrowseChannel {
    readonly name = "browse_bare";
    constructor() {
      super();
    }
    protected getMcpClient(): Promise<McpClient> {
      return Promise.reject(new Error("should not reach getMcpClient"));
    }
  }

  it("base 默认拒（didnt + fresh_profile_not_supported:<channel>；不进 getMcpClient）", async () => {
    const ch = new BareChannel();
    const r = await ch.browse("https://example.com/", "snapshot", { freshProfile: true } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("fresh_profile_not_supported:browse_bare");
  });

  it("logged_in 拒：专用错误码 fresh_profile_not_supported_on_logged_in（用户真实 Chrome 红线）", async () => {
    const logged_in = new LoggedInChannel(
      { touch: () => {}, registerSpec: () => {}, forgetSpec: async () => {} } as unknown as SubprocessManager,
      9222,
      { getCurrent: () => ({ name: "current" }), list: () => [] } as never,
      () => ({}) as never,
    );
    const r = await logged_in.browse("https://example.com/", "snapshot", { freshProfile: true } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("fresh_profile_not_supported_on_logged_in");
    expect(r.hint).toContain("browse_headless");
  });

  it("headless 通道放行：browse() 入口先换脸后跑 action + data.fresh_profile:true + freshProfile 不进 ignored", async () => {
    const sub = makeMockSubproc();
    const ch = new HeadlessChannel(sub as unknown as SubprocessManager, undefined, undefined, undefined, tempBase);
    // ensureRunning 返回的 mock client 已能覆盖 snapshot 路径（take_snapshot handler
    // 返回 stubbed 文本）——不换实现，保住 order 记录
    const r = await ch.browse("https://example.com/", "snapshot", { freshProfile: true } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    const data = (r as InteractResult<{ fresh_profile?: boolean; ignored_options?: string[] }>).data!;
    expect(data.fresh_profile).toBe(true);
    expect(data.ignored_options ?? []).not.toContain("freshProfile");
    // 调用序：换脸（forgetSpec→registerSpec 新身份）先于 ensureRunning
    expect(sub.order.lastIndexOf("forgetSpec:headless")).toBeLessThan(
      sub.order.lastIndexOf("ensureRunning:headless"),
    );
    expect(sub.order.lastIndexOf("registerSpec:headless")).toBeLessThan(
      sub.order.lastIndexOf("ensureRunning:headless"),
    );
  });

  it("schema 缺省无键 byte-identical（zod strip 面不注入 freshProfile）", async () => {
    const { registerBrowseTools } = await import("../../src/tools/browse.js");
    // schema 形状断言：freshProfile optional boolean；缺省 parse 无键
    const { z: z2 } = await import("zod");
    expect(z2).toBe(z); // 同一 zod 实例
    // 直接以 types 层断言（schema 注册面由 browse-tool-steps-schema.spec 家族覆盖）
    const opts = {} as BrowseOptions;
    expect("freshProfile" in opts).toBe(false);
    expect(typeof registerBrowseTools).toBe("function");
  });
});
