/**
 * b1-user-activation-gate.spec.ts（BUG-03 决议 B1，doc/bugs/03 §4 B1 + §4.0-F1/F2/F4）
 *
 * 症状②根治的行为面回归：hidden 档 Chrome（同 bundle id）捕获用户 Dock 激活后，
 * 执守 1.5s tick 无条件压回 =「打不开」。修复 = reassert 原语接入用户激活让位门
 * （双判据 AND + 确认窗），watchdog 状态机消费让位信号。
 *
 * 真机 hid 年龄 / frontmost CI 不可模拟 → 判定经注入式 DI 钉死（INV-85 断言面）：
 *  1. gated 信号解析四分支（pending/hidden/already/nomatch + gate_unavailable）
 *  2. 脚本体源码锚：双判据读取与判定先于压回（INV-85 (a) 测试面镜像）
 *  3. 确认窗状态机四分支：
 *     ① 真激活确认窗满（连续 20 tick）→ markUserTaken（唯一台账写）
 *     ② frontmost=false 程序掀出 → 照常压回 + 零 userTakenAt
 *     ③ 窗内失守（any 中断）→ 计数清零 + 复压；重新计满 20 才认领
 *     ④ 判据不可得 → 零账面突变（不压回信号 / 不确认 / 不落账）+ 计数清零
 *  4. 账面突变禁令锚：放行/暂停/失败路径对粘滞账（rewriteStateFn）与台账
 *     （markUserTakenFn）零 mutation（账本快照断言；§4.0-F2）
 *  5. 认领后退位：ledger userTakenAt → reassert 不再被调（粘滞账记录保留）
 *  6. chrome-show/hide 与台账联动（F4 对齐 / 重武装）源码锚 + 台账读写函数行为
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  reassertChromeHiddenGatedAsync,
  reassertGatedScript,
  USER_ACTIVATION_HID_THRESHOLD_MS,
  USER_ACTIVATION_CONFIRM_TICKS,
  type ChromeReassertGatedResult,
} from "../../src/launcher/chrome-hide.js";
import { startDesiredHideWatchdog, DESIRED_HIDE_WATCHDOG_INTERVAL_MS } from "../../src/launcher/desired-hide-watchdog.js";
import type { DesiredHiddenRecord } from "../../src/launcher/desired-hide-state.js";
import {
  recordLaunch,
  markUserTakenByPid,
  clearUserTakenByPid,
  readLedgerSync,
  type LaunchedChromeRecord,
} from "../../src/launcher/chrome-ledger.js";

const DESIRED_D_HIDE_TICK = DESIRED_HIDE_WATCHDOG_INTERVAL_MS;
const PROFILE = "/tmp/lasso-b1-profile";

// ============================================================
// helpers
// ============================================================
function makeSticky(overrides: Partial<DesiredHiddenRecord> = {}): DesiredHiddenRecord {
  return { pid: 55111, port: 9222, profileDir: PROFILE, hiddenAt: 0, ...overrides };
}

function makeLedgerRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9222,
    pid: 55111,
    profileDir: PROFILE,
    launchedAt: 0,
    status: "ready",
    launchMode: "hidden",
    ...overrides,
  };
}

const pending = (hidMs = 1_200): ChromeReassertGatedResult => ({
  ok: true,
  wasVisible: true,
  userPending: true,
  frontmost: true,
  hidIdleMs: hidMs,
});
const pressed = (hidMs = 90_000): ChromeReassertGatedResult => ({
  ok: true,
  wasVisible: true,
  userPending: false,
  frontmost: false,
  hidIdleMs: hidMs,
});
const already = (): ChromeReassertGatedResult => ({ ok: true, wasVisible: false });
const unavailable = (): ChromeReassertGatedResult => ({ ok: false, reason: "gate_unavailable" });

/** 装配全 DI 看门狗（零真 osascript / 零真账本写）。 */
function makeWatchdog(
  script: Array<() => ChromeReassertGatedResult>,
  opts: { ledger?: () => LaunchedChromeRecord[] } = {},
) {
  const sticky: DesiredHiddenRecord[] = [makeSticky()];
  let ledgerRecords: LaunchedChromeRecord[] = opts.ledger?.() ?? [makeLedgerRec()];
  const reassertCalls: number[] = [];
  const marked: number[] = [];
  const rewrites: unknown[][] = [];
  const logs: Array<Record<string, unknown>> = [];
  const wd = startDesiredHideWatchdog({
    intervalMs: DESIRED_D_HIDE_TICK,
    platform: "darwin",
    readStateFn: () => sticky,
    rewriteStateFn: (records) => rewrites.push(records),
    aliveFn: () => true,
    psFn: () => `/Applications/Google Chrome --user-data-dir=${PROFILE} --remote-debugging-port=9222\n`,
    reassertFn: async (pid) => {
      reassertCalls.push(pid);
      const step = script.shift() ?? already();
      return step();
    },
    readLedgerFn: () => ledgerRecords,
    markUserTakenFn: async (pid) => {
      marked.push(pid);
      // 认领后台账面变化（真实 markUserTakenByPid 效果的 DI 镜像）
      ledgerRecords = ledgerRecords.map((r) => (r.pid === pid ? { ...r, userTakenAt: Date.now() } : r));
    },
    logFn: (p) => logs.push(p),
  });
  return {
    wd,
    sticky,
    reassertCalls,
    marked,
    rewrites,
    logs,
    setLedger: (next: LaunchedChromeRecord[]) => {
      ledgerRecords = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// 1. gated 信号解析（经 execFn 注入钉死真机 osascript 输出契约）
// ============================================================
describe("B1 · reassertChromeHiddenGatedAsync 信号解析", () => {
  it("1a. pending:1:1500 → 让位（userPending + frontmost + hidIdleMs 回传）", async () => {
    const r = await reassertChromeHiddenGatedAsync(55111, {
      platform: "darwin",
      execFn: () => ({ status: 0, stdout: "pending:1:1500\n" }),
    });
    expect(r).toEqual({ ok: true, wasVisible: true, userPending: true, frontmost: true, hidIdleMs: 1500 });
  });

  it("1b. hidden:0:90000 → 压回执行（程序掀出：非 frontmost / hid 超阈值）", async () => {
    const r = await reassertChromeHiddenGatedAsync(55111, {
      platform: "darwin",
      execFn: () => ({ status: 0, stdout: "hidden:0:90000" }),
    });
    expect(r.userPending).toBe(false);
    expect(r.wasVisible).toBe(true);
    expect(r.frontmost).toBe(false);
    expect(r.hidIdleMs).toBe(90_000);
  });

  it("1c. already / nomatch / 形状漂移 → 既有信号语义不变", async () => {
    const a = await reassertChromeHiddenGatedAsync(55111, { platform: "darwin", execFn: () => ({ status: 0, stdout: "already" }) });
    expect(a).toEqual({ ok: true, wasVisible: false });
    const n = await reassertChromeHiddenGatedAsync(55111, { platform: "darwin", execFn: () => ({ status: 0, stdout: "nomatch" }) });
    expect(n).toEqual({ ok: false, reason: "process_not_found" });
    const w = await reassertChromeHiddenGatedAsync(55111, { platform: "darwin", execFn: () => ({ status: 0, stdout: "weird-signal" }) });
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/unexpected_signal/);
  });

  it("1d. 判据不可得（gate_unavailable stderr）→ 识别归类；其余非零退按退出码", async () => {
    const g = await reassertChromeHiddenGatedAsync(55111, {
      platform: "darwin",
      execFn: () => ({ status: 1, stderr: 'execution error: gate_unavailable (-2700)' }),
    });
    expect(g).toEqual({ ok: false, reason: "gate_unavailable" });
    const t = await reassertChromeHiddenGatedAsync(55111, {
      platform: "darwin",
      execFn: () => ({ status: 1743, stderr: "not authorized" }),
    });
    expect(t).toEqual({ ok: false, reason: "osascript_exit_1743" });
  });

  it("1e. 平台 / pid 守卫（非 darwin no-op；非法 pid no-op）", async () => {
    expect(await reassertChromeHiddenGatedAsync(1, { platform: "win32", execFn: () => ({ status: 0 }) })).toEqual({ ok: false, reason: "non_mac_noop" });
    expect(await reassertChromeHiddenGatedAsync(undefined, { platform: "darwin", execFn: () => ({ status: 0 }) })).toEqual({ ok: false, reason: "no_pid" });
  });
});

// ============================================================
// 2. 脚本体源码锚（INV-85 (a) 测试面镜像——判定先于压回）
// ============================================================
describe("B1 · reassertGatedScript 双判据门源码锚", () => {
  it("2a. HIDIdleTime 与 frontmost 的读取/判定均先于压回；判据不可得走 error（压回不发生）", () => {
    const body = reassertGatedScript(55111, USER_ACTIVATION_HID_THRESHOLD_MS);
    const hidIdx = body.indexOf("HIDIdleTime");
    const fmIdx = body.indexOf("frontmost of p");
    const gateIdx = body.indexOf('"pending:"');
    const pressIdx = body.indexOf("set visible of p to false");
    expect(hidIdx).toBeGreaterThan(-1);
    expect(fmIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(pressIdx).toBeGreaterThan(-1);
    expect(hidIdx).toBeLessThan(pressIdx);
    expect(fmIdx).toBeLessThan(pressIdx);
    expect(gateIdx).toBeLessThan(pressIdx); // 判定（pending 分支）先于压回
    expect(body).toContain('error "gate_unavailable"');
    expect(body).toContain("unix id of p is 55111"); // E8 PID 定向红线延续
    expect(body).toContain(`hidMs < ${USER_ACTIVATION_HID_THRESHOLD_MS}`); // 阈值插值单点
  });

  it("2b. 常量单一真源：阈值 10s（F1 修订 60s→10s）+ 确认窗 20 tick（≈30s）", () => {
    expect(USER_ACTIVATION_HID_THRESHOLD_MS).toBe(10_000);
    expect(USER_ACTIVATION_CONFIRM_TICKS).toBe(20);
  });
});

// ============================================================
// 3. 确认窗状态机四分支（watchdog DI）
// ============================================================
describe("B1 · 看门狗确认窗状态机", () => {
  it("3a. 真激活：连续 20 tick 让位 → markUserTaken 恰一次；粘滞账零重写（账面突变禁令）", async () => {
    const t = makeWatchdog(Array.from({ length: 40 }, () => pending));
    await vi.advanceTimersByTimeAsync(DESIRED_D_HIDE_TICK * (USER_ACTIVATION_CONFIRM_TICKS + 2));
    expect(t.marked).toEqual([55111]); // 恰一次（后续 tick 走认领退位）
    expect(t.rewrites).toHaveLength(0); // 粘滞账零 mutation
    expect(t.logs.some((p) => p.evt === "user_activation_taken")).toBe(true);
    expect(t.logs.some((p) => p.evt === "user_activation_pending")).toBe(true);
    t.wd?.stop();
  });

  it("3b. 程序掀出（frontmost=false / hid 超阈值）→ 照常压回 + 零 userTakenAt", async () => {
    const t = makeWatchdog(Array.from({ length: 25 }, () => pressed));
    await vi.advanceTimersByTimeAsync(DESIRED_D_HIDE_TICK * 25);
    expect(t.marked).toHaveLength(0);
    expect(t.logs.some((p) => p.evt === "desired_hidden_reasserted")).toBe(true);
    expect(t.rewrites).toHaveLength(0);
    t.wd?.stop();
  });

  it("3c. 窗内失守 → 计数清零复压；需重新连续计满 20 才认领（v1.18.3 武装保持）", async () => {
    // 19 tick pending → 1 tick 失守（压回）→ 19 tick pending：不应认领（非连续）
    const script = [
      ...Array.from({ length: 19 }, () => pending),
      pressed,
      ...Array.from({ length: 19 }, () => pending),
      ...Array.from({ length: 30 }, () => pending),
    ];
    const t = makeWatchdog(script);
    await vi.advanceTimersByTimeAsync(DESIRED_D_HIDE_TICK * 19);
    expect(t.marked).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DESIRED_D_HIDE_TICK * 19); // 失守 + 19 pending
    expect(t.marked).toHaveLength(0); // 窗中断：39 tick 中最大连续 19 < 20
    await vi.advanceTimersByTimeAsync(DESIRED_D_HIDE_TICK * 5); // 连续计满 20
    expect(t.marked).toEqual([55111]);
    t.wd?.stop();
  });

  it("3d. 判据不可得 → 零账面突变（不确认不落账）+ 确认窗计数清零（确认要求连续可观测）", async () => {
    const script = [
      ...Array.from({ length: 19 }, () => pending),
      unavailable, // 第 20 tick 判据不可得 → 窗破
      pending,
      ...Array.from({ length: 25 }, () => pending),
    ];
    const t = makeWatchdog(script);
    await vi.advanceTimersByTimeAsync(DESIRED_D_HIDE_TICK * 21);
    expect(t.marked).toHaveLength(0); // 不可得 tick 不认领
    expect(t.rewrites).toHaveLength(0); // 粘滞账零 mutation
    expect(t.logs.some((p) => p.evt === "desired_hidden_reassert_error" && p.reason === "gate_unavailable")).toBe(true);
    await vi.advanceTimersByTimeAsync(DESIRED_D_HIDE_TICK * 25); // 重新连续计满
    expect(t.marked).toEqual([55111]);
    t.wd?.stop();
  });

  it("3e. already（本就隐藏）中断确认窗（真激活应持续可见）", async () => {
    const script = [
      ...Array.from({ length: 10 }, () => pending),
      already,
      ...Array.from({ length: 9 }, () => pending),
    ];
    const t = makeWatchdog(script);
    await vi.advanceTimersByTimeAsync(DESIRED_D_HIDE_TICK * 20);
    expect(t.marked).toHaveLength(0); // 10 + 9 = 非连续 19，未认领
    t.wd?.stop();
  });

  it("3f. 认领后退位：台账 userTakenAt 在案 → reassert 不再被调，粘滞账记录保留", async () => {
    const t = makeWatchdog([pending], {
      ledger: () => [makeLedgerRec({ userTakenAt: Date.now() })],
    });
    await vi.advanceTimersByTimeAsync(DESIRED_D_HIDE_TICK * 3);
    expect(t.reassertCalls).toHaveLength(0); // 退位：不施压
    expect(t.rewrites).toHaveLength(0); // 粘滞账记录保留不动
    expect(t.logs.some((p) => p.evt === "desired_hidden_user_taken_deferred")).toBe(true);
    t.wd?.stop();
  });
});

// ============================================================
// 6. 台账 userTakenAt 读写 + hideshow 联动锚
// ============================================================
describe("B1 · 台账 userTakenAt 写路径", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-b1-ledger-"));
    process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tmpDir, "launched-chromes.json");
    process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(tmpDir, "desired-hidden.json");
  });
  afterEach(async () => {
    delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
    delete process.env.LASSO_DESIRED_HIDDEN_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("6a. markUserTakenByPid：只标匹配 pid；其余记录与其余字段原样", async () => {
    await recordLaunch(makeLedgerRec({ port: 9222, pid: 55111 }));
    await recordLaunch(makeLedgerRec({ port: 9223, pid: 55222 }));
    await markUserTakenByPid(55111);
    const rs = readLedgerSync();
    expect(rs.find((r) => r.pid === 55111)?.userTakenAt).toBeGreaterThan(0);
    expect(rs.find((r) => r.pid === 55222)?.userTakenAt).toBeUndefined();
  });

  it("6b. clearUserTakenByPid：清字段（重武装）；未认领零写（幂等）", async () => {
    await recordLaunch(makeLedgerRec({ pid: 55111 }));
    await markUserTakenByPid(55111);
    await clearUserTakenByPid(55111);
    const rs = readLedgerSync();
    expect(rs[0]!.userTakenAt).toBeUndefined();
    expect(rs[0]!.pid).toBe(55111); // 记录本身保留
  });

  it("6c. hideshow 联动源码锚（F4 对齐 + 重武装）：show 成功 markUserTaken / hide 成功 clearUserTaken", () => {
    const src = readFileSync("src/launcher/chrome-hideshow-cli.ts", "utf8");
    expect(src).toMatch(/import \{ readLedgerSync, markUserTakenByPid, clearUserTakenByPid \} from "\.\/chrome-ledger\.js";/);
    // --pid 与台账两路径都接线（两处 await markUserTaken / await clearUserTaken）
    expect(src.match(/await markUserTaken\(/g)?.length).toBe(2);
    expect(src.match(/await clearUserTaken\(/g)?.length).toBe(2);
  });

  it("6d. watchdog 默认 reassertFn 为 gated 原语（旧无条件原语不再是默认）", () => {
    const src = readFileSync("src/launcher/desired-hide-watchdog.ts", "utf8");
    expect(src).toMatch(/\(\(pid\) => reassertChromeHiddenGatedAsync\(pid\)\)/);
  });
});
