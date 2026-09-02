/**
 * render-chrome.spec.ts（v1.19 渲染档设计决议 3.6/3.7 —— CLI 契约）
 *
 * 守护点（设计决议 §8.1）：
 *  - parseRenderChromeArgs
 *  - ensure：stdout **单行 JSON 纯净性**（stderr 分流断言）+ 字段齐
 *    （wsEndpoint/port/startedAt/reused/touchPath）+ exit 0
 *  - 🔴 r2：reused 分支也补拉 guardian（guardian probe pid_dead → 重新 spawn）
 *  - 退出码映射：2（chrome 缺）/ 3（陈账+端口被占）/ 4（超时）/ 5（内部错误）
 *  - status：running/idleMs/lastUseAt/renderSessions（/json/list 实时计数）/touchPath
 *  - stop：幂等 exit 0 + {"stopped":[{port,pid,action}]} + modes 只收 render +
 *    提案 §6.1 三态（未设=跨 port 全收 / 显式合法=只收该 port / 非法=exit 1）
 *  - touchPath 字段 = chromeTouchPath(port)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ChildProcess } from "node:child_process";
import { runRenderChromeCli, parseRenderChromeArgs } from "../../src/render/render-chrome.js";
import { recordLaunch, readLedgerSync, type LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";
import { chromeTouchPath } from "../../src/launcher/chrome-touch.js";

let tmpDir: string;
let ledgerPath: string;
let lockDir: string;
let profileBase: string;
let touchDir: string;

const WS = "ws://127.0.0.1:9224/devtools/browser/cli-uuid-0001";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-render-cli-"));
  ledgerPath = path.join(tmpDir, "launched-chromes.json");
  lockDir = path.join(tmpDir, "locks");
  profileBase = path.join(tmpDir, "profiles");
  touchDir = path.join(tmpDir, "touch");
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
  process.env.LASSO_CHROME_TOUCH_DIR = touchDir;
  delete process.env.LASSO_RENDER_IDLE_MS;
  delete process.env.LASSO_RENDER_PORT;
});

afterEach(async () => {
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_CHROME_TOUCH_DIR;
  delete process.env.LASSO_RENDER_IDLE_MS;
  delete process.env.LASSO_RENDER_PORT;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** stdout/stderr/exit 三面板捕获。 */
function makePanels() {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  return {
    out,
    err,
    exits,
    opts: {
      writeStdout: (s: string) => void out.push(s),
      writeStderr: (s: string) => void err.push(s),
      exitFn: ((code?: number) => {
        exits.push(code ?? -1);
      }) as unknown as (code?: number) => void,
    },
  };
}

function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9224,
    pid: 4242,
    profileDir: "/tmp/render-chrome-profile-cli-0001",
    launchedAt: Date.now(),
    status: "ready",
    launchMode: "render",
    ...overrides,
  };
}

function ownerPs(profileDir: string) {
  return () => `/Applications/Google Chrome.app --headless=new --user-data-dir=${profileDir} --remote-debugging-port=9224\n`;
}

/** ensure 注入包（fetchFn 路由 /json/version 与 /json/list）。 */
function cdpFetch(versionOk: boolean, pages: Array<{ type: string; url: string }> = []) {
  return (async (url: string) => {
    if (url.endsWith("/json/version")) {
      return versionOk
        ? { ok: true, json: async () => ({ webSocketDebuggerUrl: WS, Browser: "Chrome/140" }) }
        : { ok: false, json: async () => ({}) };
    }
    if (url.endsWith("/json/list")) {
      return { ok: true, json: async () => pages };
    }
    return { ok: false, json: async () => ({}) };
  }) as unknown as (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}

function fakeSpawn(pid = 55701) {
  return ((() =>
    ({ pid, unref: () => {}, on: () => {} }) as unknown as ChildProcess) as unknown as (
    cmd: string,
    args: string[],
    opts: { detached: boolean; stdio: "ignore" },
  ) => ChildProcess) as never;
}

function launchOpts(extra: Record<string, unknown> = {}) {
  return {
    platform: "mac" as const,
    probeExists: async () => true,
    spawnFn: fakeSpawn(),
    profileBaseDir: profileBase,
    lockDir,
    tcpProbeFn: async () => false,
    ensureGuardianFn: async () => {},
    probeIntervalMs: 1,
    launchTimeoutMs: 500,
    ...extra,
  };
}

describe("parseRenderChromeArgs", () => {
  it("flag 形态 + doctor 子命令 + --clean + --help + 未知忽略（默认 ensure）", () => {
    expect(parseRenderChromeArgs(["--ensure"])).toEqual({ command: "ensure" });
    expect(parseRenderChromeArgs([])).toEqual({ command: "ensure" });
    expect(parseRenderChromeArgs(["--status"])).toEqual({ command: "status" });
    expect(parseRenderChromeArgs(["--stop"])).toEqual({ command: "stop" });
    expect(parseRenderChromeArgs(["doctor"])).toEqual({ command: "doctor" });
    expect(parseRenderChromeArgs(["doctor", "--clean"])).toEqual({ command: "doctor", clean: true });
    expect(parseRenderChromeArgs(["--bogus"])).toEqual({ command: "ensure" });
    expect(parseRenderChromeArgs(["--help"])).toEqual({ command: "ensure", help: true });
  });
});

describe("render-chrome --ensure —— stdout 纯净性 + 字段 + 退出码", () => {
  it("fresh 成功：stdout 恰一行可 parse JSON 字段齐 + exit 0；日志走 stderr", async () => {
    const p = makePanels();
    let calls = 0;
    await runRenderChromeCli(["--ensure"], {
      ...p.opts,
      fetchFn: (async (url: string) => {
        if (url.endsWith("/json/version")) {
          return ++calls >= 3
            ? { ok: true, json: async () => ({ webSocketDebuggerUrl: WS }) }
            : { ok: false, json: async () => ({}) };
        }
        return { ok: false, json: async () => ({}) };
      }) as never,
      launchOpts: launchOpts(),
    });
    expect(p.exits).toEqual([0]);
    // stdout 纯净性：恰一行、可 parse、字段齐（消费方 JSON.parse 强依赖）
    expect(p.out).toHaveLength(1);
    const j = JSON.parse(p.out[0]!) as Record<string, unknown>;
    expect(j.wsEndpoint).toBe(WS);
    expect(j.port).toBe(9224);
    expect(typeof j.startedAt).toBe("number");
    expect(j.reused).toBe(false);
    expect(j.touchPath).toBe(chromeTouchPath(9224));
    expect(j.pid).toBe(55701);
    // 与台账 launchedAt 同源
    expect(j.startedAt).toBe(readLedgerSync()[0]!.launchedAt);
  });

  it("reused 四条件门正例：台账+pid 活+marker+CDP 200 → reused:true 零 spawn；🔴 r2 guardian 也补拉", async () => {
    const rec0 = makeRec({ pid: 4242 });
    await recordLaunch(rec0);
    const p = makePanels();
    const guardianCalls: number[] = [];
    await runRenderChromeCli(["--ensure"], {
      ...p.opts,
      fetchFn: cdpFetch(true) as never,
      launchOpts: launchOpts({
        spawnFn: (() => {
          throw new Error("must_not_spawn_on_reuse");
        }) as never,
        aliveFn: () => true,
        psFn: ownerPs(rec0.profileDir),
        ensureGuardianFn: async () => {
          guardianCalls.push(1);
        },
      }),
    });
    expect(p.exits).toEqual([0]);
    const j = JSON.parse(p.out[0]!) as Record<string, unknown>;
    expect(j.reused).toBe(true);
    expect(j.startedAt).toBe(rec0.launchedAt);
    expect(guardianCalls).toHaveLength(1); // r2：reused 分支也拉执守
  });

  it("exit 2：Chrome 二进制不存在（stderr 结构化、stdout 空）", async () => {
    const p = makePanels();
    await runRenderChromeCli(["--ensure"], {
      ...p.opts,
      launchOpts: launchOpts({ probeExists: async () => false }),
    });
    expect(p.exits).toEqual([2]);
    expect(p.out).toEqual([]); // stdout 纯净：失败信息只走 stderr
    expect(p.err.length).toBeGreaterThan(0);
    expect(JSON.parse(p.err[p.err.length - 1]!).exitCode).toBe(2);
  });

  it("🔴 r2 负例浓缩（陈账 pid 死 + 端口被第三方占）→ 收尸 → exit 3", async () => {
    const rec0 = makeRec({ pid: 4242 });
    await recordLaunch(rec0);
    const p = makePanels();
    const stopCalls: Array<{ port: number }> = [];
    await runRenderChromeCli(["--ensure"], {
      ...p.opts,
      fetchFn: cdpFetch(true) as never, // 第三方 CDP 200
      launchOpts: launchOpts({
        aliveFn: () => false, // 陈账 pid 死
        tcpProbeFn: async () => true, // 重拉 TCP 探测：被占
        stopFn: async (o) => {
          stopCalls.push(o);
        },
      }),
    });
    expect(p.exits).toEqual([3]);
    expect(stopCalls).toEqual([{ port: 9224 }]);
    expect(p.out).toEqual([]);
  });

  it("exit 4：拉起超时（CDP 永不就绪 + cdp_not_ready 记录）", async () => {
    const p = makePanels();
    await runRenderChromeCli(["--ensure"], {
      ...p.opts,
      fetchFn: cdpFetch(false) as never,
      launchOpts: launchOpts({ launchTimeoutMs: 200 }),
    });
    expect(p.exits).toEqual([4]);
    expect(readLedgerSync()[0]!.status).toBe("cdp_not_ready");
  });

  it("exit 5：内部错误（探活探测抛错上浮 → 通用失败路径）", async () => {
    const p = makePanels();
    await runRenderChromeCli(["--ensure"], {
      ...p.opts,
      launchOpts: launchOpts({
        probeExists: (async () => {
          throw new Error("probe exploded");
        }) as never,
      }),
    });
    expect(p.exits).toEqual([5]);
    expect(p.err.some((l) => l.includes("render_chrome_internal_error"))).toBe(true);
  });
});

describe("render-chrome --status（恒 exit 0）", () => {
  it("运行中：running + pid/wsEndpoint/startedAt/idleMs/lastUseAt/renderSessions/touchPath", async () => {
    const rec0 = makeRec({ pid: 4242 });
    await recordLaunch(rec0);
    const p = makePanels();
    await runRenderChromeCli(["--status"], {
      ...p.opts,
      fetchFn: cdpFetch(true, [
        { type: "page", url: "about:blank" },
        { type: "page", url: "chrome://newtab" },
        { type: "iframe", url: "x" }, // 非 page 不计
      ]) as never,
    });
    expect(p.exits).toEqual([0]);
    const j = JSON.parse(p.out[0]!) as Record<string, unknown>;
    expect(j.running).toBe(true);
    expect(j.pid).toBe(4242);
    expect(j.wsEndpoint).toBe(WS);
    expect(j.startedAt).toBe(rec0.launchedAt);
    expect(j.idleMs).toBe(600_000); // rec.idleMs ?? renderIdleDefault
    expect(typeof j.lastUseAt).toBe("number");
    expect(j.renderSessions).toBe(2); // page 数实时计数（3.7 诚实降级）
    expect(j.touchPath).toBe(chromeTouchPath(9224));
  });

  it("不在运行（无台账）：running:false + 默认 idleMs + touchPath（恒 exit 0 查询语义）", async () => {
    const p = makePanels();
    await runRenderChromeCli(["--status"], {
      ...p.opts,
      fetchFn: cdpFetch(false) as never,
    });
    expect(p.exits).toEqual([0]);
    const j = JSON.parse(p.out[0]!) as Record<string, unknown>;
    expect(j.running).toBe(false);
    expect(j.idleMs).toBe(600_000);
    expect(j.renderSessions).toBe(0);
    expect(j.touchPath).toBe(chromeTouchPath(9224));
    expect(j.pid).toBeUndefined();
  });
});

describe("render-chrome --stop（幂等 exit 0 + modes 只收 render）", () => {
  it("输出 {stopped:[{port,pid,action}]}；hidden 记录不动（modes 精确匹配）", async () => {
    await recordLaunch(makeRec({ port: 9224, pid: 888001 })); // render（pid 不存在→already_dead）
    await recordLaunch(makeRec({ port: 9225, pid: 888002, launchMode: "hidden" }));
    const p = makePanels();
    await runRenderChromeCli(["--stop"], p.opts);
    expect(p.exits).toEqual([0]);
    const j = JSON.parse(p.out[0]!) as { stopped: Array<{ port: number; pid: number; action: string }> };
    expect(j.stopped).toEqual([{ port: 9224, pid: 888001, action: "already_dead" }]);
    // hidden 记录不动
    expect(readLedgerSync().map((r) => r.port)).toEqual([9225]);
  });

  it("无 render 记录 → 空 stopped + exit 0（幂等）", async () => {
    const p = makePanels();
    await runRenderChromeCli(["--stop"], p.opts);
    expect(p.exits).toEqual([0]);
    expect(JSON.parse(p.out[0]!).stopped).toEqual([]);
  });

  // 2026-09-02 提案 §6.1 裁决落地：原「stop 收台账内全部 render 记录（跨 port）」
  // 单用例 tripwire 拆为三态——
  //  ① 未设 env → 跨 port 全收（设计决议 3.7 **未设分支**钉死保留——单用户维护窗零影响）；
  //  ② env 显式合法 → 只收该 port（与 ensure/status 对称；他人 port 记录留存台账）；
  //  ③ env 显式非法 → exit 1 用法错 + 台账零改动（kubectl #1272 教训：不猜作用域）。
  it("① 未设 LASSO_RENDER_PORT → 跨 port 全收——设计决议 3.7 未设分支钉死", async () => {
    await recordLaunch(makeRec({ port: 9224, pid: 888001 })); // 本机默认口
    await recordLaunch(makeRec({ port: 9324, pid: 888003 })); // 另一 agent 的并行命名空间口
    const p = makePanels();
    await runRenderChromeCli(["--stop"], p.opts);
    expect(p.exits).toEqual([0]);
    const j = JSON.parse(p.out[0]!) as { stopped: Array<{ port: number; pid: number; action: string }> };
    // 两 port 全收（含未设 LASSO_RENDER_PORT 时对非默认口的记录）——未设即全局收
    expect(j.stopped).toEqual([
      { port: 9224, pid: 888001, action: "already_dead" },
      { port: 9324, pid: 888003, action: "already_dead" },
    ]);
    expect(readLedgerSync()).toEqual([]); // render 记录全清账
  });

  it("② LASSO_RENDER_PORT 显式合法 → 只收该 port；他人 port 的 render 记录留存台账", async () => {
    process.env.LASSO_RENDER_PORT = "9224";
    await recordLaunch(makeRec({ port: 9224, pid: 888001 })); // 自己（scope 内）
    await recordLaunch(makeRec({ port: 9324, pid: 888003 })); // 他人（scope 外——不得互杀）
    const p = makePanels();
    await runRenderChromeCli(["--stop"], p.opts);
    expect(p.exits).toEqual([0]);
    const j = JSON.parse(p.out[0]!) as { stopped: Array<{ port: number; pid: number; action: string }> };
    expect(j.stopped).toEqual([{ port: 9224, pid: 888001, action: "already_dead" }]);
    expect(readLedgerSync().map((r) => r.port)).toEqual([9324]); // 9324 留存台账（并行隔离）
  });

  it("③ LASSO_RENDER_PORT 显式非法 → exit 1 用法错（stderr 注明 env 名+原值）+ 台账零改动", async () => {
    await recordLaunch(makeRec({ port: 9224, pid: 888001 }));
    process.env.LASSO_RENDER_PORT = "not-a-port";
    const p = makePanels();
    await runRenderChromeCli(["--stop"], p.opts);
    expect(p.exits).toEqual([1]); // 1 用法错（3.6 退出码全集内，零新增退出码）
    expect(p.out).toEqual([]); // 不产 stopped 报告
    const err = JSON.parse(p.err[p.err.length - 1]!) as Record<string, unknown>;
    expect(err.env).toBe("LASSO_RENDER_PORT");
    expect(err.raw).toBe("not-a-port");
    expect(readLedgerSync().map((r) => r.port)).toEqual([9224]); // 不动台账
  });
});
