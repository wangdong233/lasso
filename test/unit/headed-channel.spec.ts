/**
 * headed-channel.spec.ts（W2，doc/bugs/09 决议 A.4/A.7，2026-09-16）
 *
 * 守护 HeadedChannel（L2 有头档）+ browse_headed 工具契约：
 *  1. spec 组成（INV-97 单测镜像）：无 --headless / 无裸 --isolated / 必含
 *     lasso-owned --user-data-dir（HEADED_PROFILE_PREFIX 前缀 + 归属锚 -p<pid>）/
 *     --no-usage-statistics / automation 面两抹 / reapPolicy 三元组挂载
 *  2. 构造零磁盘副作用（默认注册 ≠ 每次启动建目录——S1 静默守则）
 *  3. getMcpClient 懒链：首调用建 profile + 注册 spec + ensureRunning + 起探测器
 *  4. 接管探测器：hasFocus=true → markUserTaken 粘滞 + 停表；false → 续跑；
 *     not connected → 停表（respawn 后由 getMcpClient 重启）；5s 调用上界实参
 *  5. 探测器不 touch/ensureRunning（态一 idle 收割不被饿死——设计禁令）
 *  6. applyFreshProfile：显式拒（headless 域语义）
 *  7. afterHeadedStackKilled：profile 删除（受守卫）+ 下一 epoch 换新目录
 *  8. cleanupHeadedProfilesSync：exit 钩子同步清理 + 停表
 *  9. 陈年双闸：owner 活跳过 / age<24h 跳过 / 双过才删 / 非前缀不动
 * 10. rmHeadedProfileDir 前缀守卫拒删
 * 11. browse_headed 工具：注册形态（name/desc 首行 consent/schema/annotations）、
 *     终端 plan（fallbacks 恒空——INV-23）、window_opened:true 回显
 *
 * mock 策略（steel-channel.spec.ts 同范式）：SubprocessManager stub + stub
 * McpClient；工具段 mock McpServer 捕获 handler + ssrf stub（不触网）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HeadedChannel,
  HEADED_PROFILE_PREFIX,
  HEADED_STALE_PROFILE_MS,
  buildHeadedProfileDirName,
  rmHeadedProfileDir,
} from "../../src/channels/HeadedChannel.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { SpawnSpec } from "../../src/subprocess/SubprocessManager.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// 工具段 SSRF stub（browse-tool-steps-schema.spec.ts 同范式——不触网）
const ALWAYS_OK_SSRF: SsrfConfig = { allowRanges: [], denyRanges: [] };
vi.mock("../../src/ssrf/ssrf-guard.js", () => ({
  ssrfGuard: vi.fn(async () => ({
    allowed: true,
    reason: "stub_ok",
    resolvedIps: ["93.184.216.34"],
  })),
  ssrfDenial: vi.fn((reason: string) => ({
    outcome: "didnt",
    retrieval_method: `ssrf_${reason}`,
    error: `blocked:${reason}`,
  })),
  loadSsrfConfig: vi.fn(() => ALWAYS_OK_SSRF),
}));

// ============================================================
// Mock helpers
// ============================================================
interface CapturedSpec {
  name: string;
  spec: SpawnSpec;
}

function makeStubSubproc(hasFocusValue: unknown = false) {
  const specs = new Map<string, SpawnSpec>();
  const calls: string[] = [];
  const stubClient = {
    pid: 4711,
    close: async () => {},
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === "evaluate_script") {
        return {
          content: [
            {
              type: "text",
              text: `# evaluate_script response\nScript ran on page and returned:\n\`\`\`json\n${JSON.stringify(
                typeof hasFocusValue === "function" ? hasFocusValue() : hasFocusValue,
              )}\n\`\`\``,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "ok" }] };
    }),
  } as unknown as McpClient;
  const subproc = {
    registerSpec: vi.fn((name: string, spec: SpawnSpec) => {
      specs.set(name, spec);
    }),
    ensureRunning: vi.fn(async () => {
      calls.push("ensureRunning");
      return stubClient;
    }),
    touch: vi.fn(),
    forgetSpec: vi.fn(async () => {}),
    markUserTaken: vi.fn(() => true),
    isUserTaken: vi.fn(() => false),
  } as unknown as SubprocessManager;
  return { subproc, stubClient, specs, calls, captured: [] as CapturedSpec[] };
}

function lastSpec(specs: Map<string, SpawnSpec>): SpawnSpec | undefined {
  return specs.get("headed");
}

function specArgs(spec: SpawnSpec): string[] {
  return spec.args as string[];
}

function tmpBase(): string {
  return mkdtempSync(path.join(os.tmpdir(), "headed-test-"));
}

// ============================================================
// Channel 契约
// ============================================================
describe("HeadedChannel — spawn spec 组成（INV-97 单测镜像）", () => {
  it("getMcpClient 首调注册 spec：无 --headless / 无 --isolated / 有五项关键 flag", async () => {
    const base = tmpBase();
    const { subproc, specs } = makeStubSubproc();
    const ch = new HeadedChannel(subproc, { profileBase: base, idleMs: 1234, hardCapMs: 5678 });
    await (ch as unknown as { getMcpClient(): Promise<McpClient> }).getMcpClient();
    const spec = lastSpec(specs);
    expect(spec).toBeDefined();
    const args = specArgs(spec!);
    expect(args).toContain("--no-usage-statistics");
    expect(args).toContain("--chromeArg=--disable-blink-features=AutomationControlled");
    expect(args).toContain("--ignoreDefaultChromeArg=--enable-automation");
    expect(args.some((a) => a === "--headless")).toBe(false); // 有头本体
    expect(args.some((a) => a === "--isolated")).toBe(false); // 显式 user-data-dir 替代裸 isolated
    const udd = args.find((a) => a.startsWith("--chromeArg=--user-data-dir="));
    expect(udd).toBeDefined();
    const dir = udd!.split("=").slice(2).join("=");
    expect(path.basename(dir).startsWith(HEADED_PROFILE_PREFIX)).toBe(true);
    expect(dir.startsWith(base)).toBe(true); // lasso-owned 基目录（非上游共享 profile）
    expect(existsSync(dir)).toBe(true); // 已 mkdir
    expect(spec!.mcpClientName).toBe("lasso-browse-headed");
    expect(spec!.command).toBe("npx");
  });

  it("reapPolicy 三元组挂载：idleMs/stickyExempt/hardCapMs 从构造 opts 透传", async () => {
    const { subproc, specs } = makeStubSubproc();
    const ch = new HeadedChannel(subproc, { profileBase: tmpBase(), idleMs: 42_000, hardCapMs: 99_000 });
    await (ch as unknown as { getMcpClient(): Promise<McpClient> }).getMcpClient();
    expect(lastSpec(specs)!.reapPolicy).toEqual({
      idleMs: 42_000,
      stickyExempt: true, // 态二粘滞豁免恒开
      hardCapMs: 99_000,
    });
  });

  it("构造零磁盘副作用：不建 profile 目录、不注册 spec（默认注册工具 ≠ 启动即建目录）", () => {
    const base = tmpBase();
    const { subproc, specs } = makeStubSubproc();
    new HeadedChannel(subproc, { profileBase: base });
    expect(specs.size).toBe(0);
    expect(existsSync(path.join(base, HEADED_PROFILE_PREFIX + "anything"))).toBe(false);
  });
});

describe("HeadedChannel — 接管探测器（态二粘滞写径）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function spawnProbe(hasFocusValue: unknown) {
    const { subproc, stubClient, calls, specs } = makeStubSubproc(hasFocusValue);
    const ch = new HeadedChannel(subproc, { profileBase: tmpBase() });
    await (ch as unknown as { getMcpClient(): Promise<McpClient> }).getMcpClient();
    return { ch, subproc, stubClient, calls, specs };
  }

  it("hasFocus=true → markUserTaken 粘滞 + 探测器停表", async () => {
    const { ch, subproc, stubClient } = await spawnProbe(true);
    expect(ch.isTakeoverProbeActive()).toBe(true);
    await vi.advanceTimersByTimeAsync(HeadedChannel.TAKEOVER_PROBE_INTERVAL_MS + 100);
    expect(subproc.markUserTaken).toHaveBeenCalledWith("headed");
    expect(stubClient.callTool).toHaveBeenCalledWith(
      "evaluate_script",
      { function: "() => document.hasFocus()" },
      HeadedChannel.TAKEOVER_PROBE_TIMEOUT_MS, // 5s 调用上界（并发安全锚）
    );
    expect(ch.isTakeoverProbeActive()).toBe(false); // 粘滞命中停表
  });

  it("hasFocus=false → 不标记，探测器续跑（多轮）", async () => {
    const { ch, subproc } = await spawnProbe(false);
    await vi.advanceTimersByTimeAsync(HeadedChannel.TAKEOVER_PROBE_INTERVAL_MS * 3 + 100);
    expect(subproc.markUserTaken).not.toHaveBeenCalled();
    expect(ch.isTakeoverProbeActive()).toBe(true);
  });

  it("探测器不 ensureRunning（首调除外）/ 不 touch——态一 idle 收割不被饿死", async () => {
    const { ch, subproc } = await spawnProbe(false);
    await vi.advanceTimersByTimeAsync(HeadedChannel.TAKEOVER_PROBE_INTERVAL_MS * 3 + 100);
    expect(subproc.touch).not.toHaveBeenCalled();
    // ensureRunning 只在 getMcpClient 首调一次；探测器 tick 不再调
    expect(subproc.ensureRunning).toHaveBeenCalledTimes(1);
    expect(ch.isTakeoverProbeActive()).toBe(true);
  });

  it("client 句柄失效（not connected）→ 停表待 getMcpClient 重启", async () => {
    const { subproc, stubClient } = makeStubSubproc();
    (stubClient.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("McpClient not connected"),
    );
    const ch = new HeadedChannel(subproc, { profileBase: tmpBase() });
    await (ch as unknown as { getMcpClient(): Promise<McpClient> }).getMcpClient();
    await vi.advanceTimersByTimeAsync(HeadedChannel.TAKEOVER_PROBE_INTERVAL_MS + 100);
    expect(ch.isTakeoverProbeActive()).toBe(false);
  });

  it("stop()：停表 + forgetSpec（lasso 侧显式关闭出口）", async () => {
    const { ch, subproc } = await spawnProbe(false);
    await ch.stop();
    expect(ch.isTakeoverProbeActive()).toBe(false);
    expect(subproc.forgetSpec).toHaveBeenCalledWith("headed");
  });
});

describe("HeadedChannel — 生命周期清理", () => {
  it("afterHeadedStackKilled：profile 目录删除 + 下一 epoch 换新目录", async () => {
    const base = tmpBase();
    const { subproc, specs } = makeStubSubproc();
    const ch = new HeadedChannel(subproc, { profileBase: base });
    await (ch as unknown as { getMcpClient(): Promise<McpClient> }).getMcpClient();
    const dir1 = specArgs(lastSpec(specs)!)
      .find((a) => a.startsWith("--chromeArg=--user-data-dir="))!
      .split("=").slice(2).join("=");
    expect(existsSync(dir1)).toBe(true);

    await ch.afterHeadedStackKilled();
    expect(existsSync(dir1)).toBe(false); // 先杀后删（post-kill 语义）

    // 复用：下次 getMcpClient 分配新 epoch 目录（新身份）
    await (ch as unknown as { getMcpClient(): Promise<McpClient> }).getMcpClient();
    const dir2 = specArgs(lastSpec(specs)!)
      .find((a) => a.startsWith("--chromeArg=--user-data-dir="))!
      .split("=").slice(2).join("=");
    expect(dir2).not.toBe(dir1);
    expect(existsSync(dir2)).toBe(true);
  });

  it("cleanupHeadedProfilesSync：同步删除 + 停表（exit 钩子路径）", async () => {
    vi.useFakeTimers();
    try {
      const base = tmpBase();
      const { subproc, specs } = makeStubSubproc(false);
      const ch = new HeadedChannel(subproc, { profileBase: base });
      await (ch as unknown as { getMcpClient(): Promise<McpClient> }).getMcpClient();
      const dir = specArgs(lastSpec(specs)!)
        .find((a) => a.startsWith("--chromeArg=--user-data-dir="))!
        .split("=").slice(2).join("=");
      ch.cleanupHeadedProfilesSync();
      expect(existsSync(dir)).toBe(false);
      expect(ch.isTakeoverProbeActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HeadedChannel — freshProfile 逃生门（headless 域语义，显式拒）", () => {
  it("applyFreshProfile → didnt + fresh_profile_not_supported_on_headed + hint", async () => {
    const { subproc } = makeStubSubproc();
    const ch = new HeadedChannel(subproc, { profileBase: tmpBase() });
    const r = await (
      ch as unknown as {
        applyFreshProfile(): Promise<import("../../src/types.js").InteractResult<
          import("../../src/types.js").BrowseResult
        > | null>;
      }
    ).applyFreshProfile();
    expect(r?.outcome).toBe("didnt");
    expect(r?.error).toBe("fresh_profile_not_supported_on_headed");
    expect(r?.hint).toBeTruthy();
  });

  it("retrievalMethod 标 chrome_devtools_mcp_headed（观测区分）", () => {
    const { subproc } = makeStubSubproc();
    const ch = new HeadedChannel(subproc, { profileBase: tmpBase() });
    expect(
      (ch as unknown as { retrievalMethod(): string }).retrievalMethod(),
    ).toBe("chrome_devtools_mcp_headed");
  });
});

describe("HeadedChannel — profile 守卫 + 陈年双闸", () => {
  it("rmHeadedProfileDir：非前缀 basename 拒删", () => {
    expect(() => rmHeadedProfileDir("/tmp/some-evil-dir")).toThrow(
      /headed_profile_refuse_delete/,
    );
    expect(() =>
      rmHeadedProfileDir(path.join("/tmp", "headless-profile-1-abc-p1")),
    ).toThrow(/headed_profile_refuse_delete/); // headless 域前缀也不许经 headed 出口删
  });

  it("sweepStaleHeadedProfiles：owner 活跳过 / age<24h 跳过 / 双过才删 / 非前缀不动", () => {
    const base = tmpBase();
    const ownerAlive = 1111;
    const ownerDead = 2222;
    const mk = (name: string) => {
      const d = path.join(base, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, "marker"), "x");
      return d;
    };
    const dAlive = mk(buildHeadedProfileDirName(ownerAlive, 1, "aaaaaa")); // owner 活 → 跳过
    const dFresh = mk(buildHeadedProfileDirName(ownerDead, Date.now(), "bbbbbb")); // age<24h → 跳过
    const dStale = mk(buildHeadedProfileDirName(ownerDead, Date.now() - HEADED_STALE_PROFILE_MS - 1000, "cccccc")); // 双过 → 删
    mkdirSync(path.join(base, "unrelated-dir"), { recursive: true }); // 非前缀 → 不动

    const r = new HeadedChannel(makeStubSubproc().subproc, { profileBase: base }).sweepStaleHeadedProfiles(
      { isPidAlive: (pid) => pid === ownerAlive },
    );
    expect(r.removed).toEqual([dStale]);
    expect(r.kept).toEqual(expect.arrayContaining([dAlive, dFresh]));
    expect(existsSync(dStale)).toBe(false);
    expect(existsSync(dAlive)).toBe(true);
    expect(existsSync(dFresh)).toBe(true);
    expect(existsSync(path.join(base, "unrelated-dir"))).toBe(true);
  });
});

// ============================================================
// browse_headed 工具（注册形态 + 终端 plan + window_opened 回显）
// ============================================================
describe("registerHeadedTool — browse_headed MCP 入口", () => {
  it("注册形态：name/description 首行 consent/schema= browseSchema 族/annotations", async () => {
    const { registerHeadedTool } = await import("../../src/tools/headed.js");
    const { BROWSE_HEADED_DESCRIPTION } = await import("../../src/tools/descriptions.js");
    const captured: Array<{
      name: string;
      desc: string;
      schema: Record<string, unknown>;
      handler: (args: never, extra: unknown) => Promise<unknown>;
    }> = [];
    const server = {
      tool: vi.fn(
        (
          name: string,
          desc: string,
          schema: Record<string, unknown>,
          _ann: unknown,
          handler: (args: never, extra: unknown) => Promise<unknown>,
        ) => {
          captured.push({ name, desc, schema, handler });
          return { enabled: true, disable() {}, enable() {}, remove() {}, update() {} };
        },
      ),
    } as unknown as Parameters<typeof registerHeadedTool>[0];
    const { subproc } = makeStubSubproc();
    const headed = new HeadedChannel(subproc, { profileBase: tmpBase() });
    const { FallbackDecider } = await import("../../src/fallback/FallbackDecider.js");
    const decider = new FallbackDecider(new Map());
    registerHeadedTool(server, headed, decider, ALWAYS_OK_SSRF);

    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe("browse_headed");
    // consent 契约首行钉死（A.4⑥r1）
    expect(
      captured[0].desc
        .split("\n")[0]
        .includes("opens a real on-screen window"),
    ).toBe(true);
    expect(captured[0].desc).toContain("explicit user consent");
    // schema 与 browse_headless 同族（url/action/options 键在）
    expect(captured[0].schema).toHaveProperty("url");
    expect(captured[0].schema).toHaveProperty("action");
    expect(captured[0].schema).toHaveProperty("options");
  });

  it("handler：终端 plan（fallbacks 恒空——不自动回退）+ window_opened:true 回显", async () => {
    const { registerHeadedTool } = await import("../../src/tools/headed.js");
    const captured: Array<{
      name: string;
      handler: (args: never, extra: unknown) => Promise<unknown>;
    }> = [];
    const server = {
      tool: vi.fn(
        (
          name: string,
          _desc: string,
          _schema: Record<string, unknown>,
          _ann: unknown,
          handler: (args: never, extra: unknown) => Promise<unknown>,
        ) => {
          captured.push({ name, handler });
          return { enabled: true, disable() {}, enable() {}, remove() {}, update() {} };
        },
      ),
    } as unknown as Parameters<typeof registerHeadedTool>[0];
    const { subproc } = makeStubSubproc();
    const headed = new HeadedChannel(subproc, { profileBase: tmpBase() });
    // browse() 走真 BrowseChannel dispatch——stub getMcpClient 返回 navigate fixture
    const navClient = {
      pid: 4712,
      close: async () => {},
      callTool: vi.fn(async (name: string) => {
        if (name === "navigate_page") {
          return { content: [{ type: "text", text: "navigated" }] };
        }
        if (name === "take_snapshot") {
          return { content: [{ type: "text", text: "# take_snapshot response\n\n- heading \"Example\" [ref=e1]" }] };
        }
        return { content: [{ type: "text", text: "ok" }] };
      }),
    } as unknown as McpClient;
    (headed as unknown as {
      getMcpClient: () => Promise<McpClient>;
    }).getMcpClient = async () => navClient;

    const { FallbackDecider } = await import("../../src/fallback/FallbackDecider.js");
    const decider = new FallbackDecider(new Map());
    registerHeadedTool(server, headed, decider, ALWAYS_OK_SSRF);

    const out = (await captured[0].handler(
      { url: "https://example.com/", action: "snapshot", options: {} } as never,
      { _meta: {} },
    )) as { content: Array<{ text: string }> };
    const payload = JSON.parse(out.content[0].text) as {
      outcome: string;
      data: { window_opened?: boolean } | null;
      served_by: string;
    };
    expect(payload.served_by).toBe("browse_headed");
    expect(payload.data?.window_opened).toBe(true); // 归属锚②：如实回显窗口已开
  });
});
