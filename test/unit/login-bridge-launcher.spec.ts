/**
 * login-bridge-launcher.spec.ts（v1.31 F4——方案 §六：launcher 行为面）
 *
 * DI 全注入（render-launcher.spec 同范式）：二进制探测/reuse 三条件门/fresh spawn
 * 旗标断言（LOGIN_FLAGS+持久 profile+端口+allow-origins 逗号多值）/cdp_not_ready
 * 诚实记录/foreign 占口错误。台账走 LASSO_LAUNCHED_CHROMES_PATH tmp 隔离
 * （bug04/15 范式）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { ensureLoginChrome, acquireLoginLaunchLock, loginProfileDir } from "../../src/login-bridge/launcher.js";
import { LOGIN_FLAGS, LOGIN_PROFILE_PREFIX } from "../../src/login-bridge/login-flags.js";
import { recordLaunch, readLedgerSync } from "../../src/launcher/chrome-ledger.js";
import { parseChromeStopArgs } from "../../src/launcher/chrome-stop.js";

let ledgerDir = "";
let baseDir = "";
const origEnv = process.env.LASSO_LAUNCHED_CHROMES_PATH;

beforeEach(() => {
  ledgerDir = mkdtempSync(path.join(os.tmpdir(), "lasso-lb-"));
  baseDir = mkdtempSync(path.join(os.tmpdir(), "lasso-lb-profile-"));
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(ledgerDir, "chromes.json");
});
afterEach(() => {
  if (origEnv === undefined) delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  else process.env.LASSO_LAUNCHED_CHROMES_PATH = origEnv;
  rmSync(ledgerDir, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});

const CHROME_BIN = "/fake/chrome";
const profile = () => loginProfileDir("default", baseDir);
const OLD = Date.now() - 3_600_000;

/** probeExists 桩：候选表首个即认（chromeCandidatesForPlatform 是真候选表——
 * stub 只管「存在性」，路径真假无关：spawnFn/fetchFn 全注入）。 */
const probeFirst = async (_p: string) => true;

function fakeChild(): ChildProcess {
  return {
    pid: 4242,
    on: () => {},
    unref: () => {},
  } as unknown as ChildProcess;
}

/** fetchFn 状态机：gate 探活失败 N 次后成功（模拟 spawn→CDP ready 序列）。 */
function fetchAfter(failTimes: number, wsUrl = "ws://127.0.0.1:9225/devtools/browser/uuid-x") {
  let gateCalls = 0;
  return async () => {
    gateCalls += 1;
    if (gateCalls <= failTimes) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ webSocketDebuggerUrl: wsUrl }) };
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    port: 9225,
    ns: "default",
    allowOrigins: ["http://100.1.2.3:9226"],
    profileBaseDir: baseDir,
    lockDir: ledgerDir,
    probeExists: probeFirst,
    spawnFn: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      return fakeChild();
    },
    fetchFn: fetchAfter(2), // gate①fail + pre-bind②fail + poll③ok（fresh 流程序）
    tcpProbeFn: async () => false,
    aliveFn: () => true,
    psFn: () => `"/fake/chrome" --user-data-dir=${profile()} --remote-debugging-port=9225`,
    stopFn: async () => {},
    launchTimeoutMs: 2_000,
    probeIntervalMs: 10,
    ...over,
  } as never;
}

const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

describe("ensureLoginChrome", () => {
  it("fresh launch：旗标全集断言（LOGIN_FLAGS+持久 profile+端口+allow-origins 逗号值）", async () => {
    const r = await ensureLoginChrome(deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reused).toBe(false);
    expect(r.port).toBe(9225);
    expect(r.wsEndpoint).toContain("ws://127.0.0.1:9225");
    expect(r.profileDir).toBe(profile());
    expect(spawnCalls.length).toBe(1);
    const args = spawnCalls[0]!.args;
    for (const f of LOGIN_FLAGS) expect(args).toContain(f);
    expect(args).toContain(`--user-data-dir=${profile()}`);
    expect(args).toContain("--remote-debugging-port=9225");
    expect(args).toContain("--remote-allow-origins=http://100.1.2.3:9226");
    // 台账：launchMode login + ready
    const rec = readLedgerSync().find((x) => x.port === 9225);
    expect(rec?.launchMode).toBe("login");
    expect(rec?.status).toBe("ready");
    expect(rec?.profileDir).toBe(profile());
  });

  it("多 allow-origins（0.0.0.0 形态）逗号拼接单旗标", async () => {
    spawnCalls.length = 0;
    await ensureLoginChrome(
      deps({ allowOrigins: ["http://192.168.1.5:9226", "http://10.0.0.9:9226"] }),
    );
    const flag = spawnCalls[0]!.args.find((a) => a.startsWith("--remote-allow-origins="));
    expect(flag).toBe("--remote-allow-origins=http://192.168.1.5:9226,http://10.0.0.9:9226");
  });

  it("reuse 门：台账 login 记录+pid 活+归属+CDP 健康 → reused（不再 spawn）", async () => {
    await recordLaunch({
      port: 9225,
      pid: 4242,
      profileDir: profile(),
      launchedAt: OLD,
      status: "ready",
      launchMode: "login",
      idleMs: 1_800_000,
    });
    spawnCalls.length = 0;
    const r = await ensureLoginChrome(
      deps({ fetchFn: fetchAfter(0) }), // gate 探活即成功
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reused).toBe(true);
    expect(spawnCalls.length).toBe(0);
  });

  it("reuse 拒绝：pid 死 → 收尸委托后重拉", async () => {
    await recordLaunch({
      port: 9225,
      pid: 4242,
      profileDir: profile(),
      launchedAt: OLD,
      status: "ready",
      launchMode: "login",
      idleMs: 1_800_000,
    });
    let stopped = false;
    spawnCalls.length = 0;
    const r = await ensureLoginChrome(
      deps({
        aliveFn: () => false, // 陈留：pid 已死
        stopFn: async () => {
          stopped = true;
        },
        fetchFn: fetchAfter(2), // 收尸后 fresh 流程序（gate+pre-bind 均 fail，poll ok）
      }),
    );
    expect(stopped).toBe(true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reused).toBe(false);
    expect(spawnCalls.length).toBe(1);
  });

  it("foreign 占口：CDP 有响应但无台账 login 记录 → login_port_in_use", async () => {
    const r = await ensureLoginChrome(
      deps({ fetchFn: fetchAfter(0) }), // gate 即健康，但台账空
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("login_port_in_use");
  });

  it("二进制全 miss → 可教学错误（chrome-paths 候选内无一存在）", async () => {
    const r = await ensureLoginChrome(deps({ probeExists: async () => false }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("login_chrome_not_found");
    expect(r.error).toContain("puppeteer cache");
  });

  it("拉起窗口内 CDP 永不就绪 → cdp_not_ready 诚实记录（下一次 ensure 收尸）", async () => {
    spawnCalls.length = 0;
    const r = await ensureLoginChrome(
      deps({ fetchFn: fetchAfter(10_000), launchTimeoutMs: 150, probeIntervalMs: 20 }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("login_launch_timeout");
    const rec = readLedgerSync().find((x) => x.port === 9225);
    expect(rec?.status).toBe("cdp_not_ready");
    expect(rec?.launchMode).toBe("login");
  });
});

describe("单飞锁与 profile 命名空间", () => {
  it("wx 锁互斥；release 后可重取", () => {
    const a = acquireLoginLaunchLock(9225, { lockDir: ledgerDir, nowFn: () => Date.now() });
    expect(a.locked).toBe(true);
    const b = acquireLoginLaunchLock(9225, { lockDir: ledgerDir, nowFn: () => Date.now() });
    expect(b.locked).toBe(false);
    a.release();
    const c = acquireLoginLaunchLock(9225, { lockDir: ledgerDir, nowFn: () => Date.now() });
    expect(c.locked).toBe(true);
    c.release();
  });
  it("profileDir 前缀契约（rmSync 归属守卫镜像 LOGIN_PROFILE_PREFIX）", () => {
    expect(path.basename(path.dirname(loginProfileDir("ns1", baseDir)))).toBe(LOGIN_PROFILE_PREFIX);
    expect(loginProfileDir("ns1", baseDir).endsWith(path.join(LOGIN_PROFILE_PREFIX, "ns1"))).toBe(true);
  });
});

describe("chrome-stop 集成面（--modes 值域扩 login）", () => {
  it("parseChromeStopArgs 接受 login（CLI 显式收尾通道）", () => {
    const opts = parseChromeStopArgs(["--modes", "login"]);
    expect(opts.modes).toEqual(["login"]);
  });
  it("非法值仍拒（值域护栏不弱化）", () => {
    expect(() => parseChromeStopArgs(["--modes", "bogus"])).toThrow(/expected hidden\|visible\|render\|headless\|login/);
  });
});

// ============================================================
// R1（2026-10-26 需求单，提案 v2 Task 3）：locale / extraArgs
// ============================================================
describe("R1 · ensureLoginChrome locale / extraArgs（提案 v2）", () => {
  it("locale zh-CN → args 含 --lang=zh-CN + Preferences 写入 + extraArgs 于 about:blank 前", async () => {
    spawnCalls.length = 0;
    const r = await ensureLoginChrome(
      deps({ locale: "zh-CN", extraArgs: ["--window-size=1920,1080"] }),
    );
    expect(r.ok).toBe(true);
    const args = spawnCalls[0]!.args;
    expect(args).toContain("--lang=zh-CN");
    // 需求方参数集验收锚：window-size 含逗号完整单 flag，且在位置参数前
    const wsIdx = args.indexOf("--window-size=1920,1080");
    const blankIdx = args.indexOf("about:blank");
    expect(wsIdx).toBeGreaterThan(-1);
    expect(blankIdx).toBeGreaterThan(wsIdx);
    // Preferences 写入（真 fs——profile 在 tmp baseDir）
    const prefs = JSON.parse(
      readFileSync(path.join(profile(), "Default", "Preferences"), "utf8"),
    );
    expect(prefs.intl.accept_languages).toBe("zh-CN,zh;q=0.9");
    expect(prefs.intl.selected_languages).toBe("zh-CN");
  });

  it("无 locale/extraArgs → 零写入 + 无 --lang（缺省路径零写入零变更锚）", async () => {
    spawnCalls.length = 0;
    await ensureLoginChrome(deps());
    expect(spawnCalls[0]!.args.some((a) => a.startsWith("--lang="))).toBe(false);
    expect(existsSync(path.join(profile(), "Default", "Preferences"))).toBe(false);
  });

  it("非法 locale（zh_CN）→ failed{invalid_tag} 日志 + 无 --lang + 启动仍 ok（best-effort 非门禁）", async () => {
    spawnCalls.length = 0;
    const events: Array<Record<string, unknown>> = [];
    const r = await ensureLoginChrome(
      deps({ locale: "zh_CN", logFn: (p: Record<string, unknown>) => events.push(p) }),
    );
    expect(r.ok).toBe(true);
    expect(spawnCalls[0]!.args.some((a) => a.startsWith("--lang="))).toBe(false);
    expect(
      events.some(
        (e) => e.evt === "chrome_locale_prefs_failed" && String(e.reason).includes("invalid_tag"),
      ),
    ).toBe(true);
  });

  it("reused + locale → chrome_locale_prefs_skipped_reused 诚实打点（不补写）", async () => {
    await recordLaunch({
      port: 9225,
      pid: 4242,
      profileDir: profile(),
      launchedAt: OLD,
      status: "ready",
      launchMode: "login",
      idleMs: 1_800_000,
    });
    spawnCalls.length = 0;
    const events: Array<Record<string, unknown>> = [];
    const r = await ensureLoginChrome(
      deps({ fetchFn: fetchAfter(0), locale: "zh-CN", logFn: (p: Record<string, unknown>) => events.push(p) }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reused).toBe(true);
    expect(events.some((e) => e.evt === "chrome_locale_prefs_skipped_reused")).toBe(true);
  });

  it("台账守卫：同 profileDir 活记录（异端口 9777 在案）→ 跳过写入 + skipped_profile_busy", async () => {
    await recordLaunch({
      port: 9777,
      pid: 4242,
      profileDir: profile(),
      launchedAt: Date.now(),
      status: "ready",
      launchMode: "login",
      idleMs: 1_800_000,
    });
    spawnCalls.length = 0;
    const events: Array<Record<string, unknown>> = [];
    await ensureLoginChrome(
      deps({ locale: "zh-CN", logFn: (p: Record<string, unknown>) => events.push(p) }),
    );
    expect(existsSync(path.join(profile(), "Default", "Preferences"))).toBe(false);
    expect(events.some((e) => e.evt === "chrome_locale_prefs_skipped_profile_busy")).toBe(true);
  });
});
