/**
 * desired-hide（P27 v1.18.3）回归测试：
 *
 * A. 粘滞台账（desired-hide-state）：
 *  1. add 同 pid 覆盖（一 pid 至多一条）→ read 回读形状完整
 *  2. remove 后 read 为空；损坏 JSON / 非数组顶层 → []（容错）
 *  3. rewriteSync 落盘（watchdog 剔除路径）
 *
 * B. 看门狗（desired-hide-watchdog，全注入 + fake timers——不真跑 osascript）：
 *  4. 粘滞账 pid 活着 + 归属通过 + 被掀出（reassert wasVisible）→ 压回一次 +
 *     desired_hidden_reasserted 日志（P27 观测点）
 *  5. 本就隐藏（wasVisible=false）→ 无 reasserted 日志
 *  6. pid 死亡 → 剔除 + rewrite 落盘 + pruned(pid_dead) 日志；不施 osascript
 *  7. 归属复验失败（pid 复用）→ 剔除 + pruned(pid_reused)；**绝不 reassert**
 *  8. 非 darwin → 返 null（不启 timer）
 *  9. stop() 幂等清 interval；stop 后 tick 不再发生
 * 10. 空 → tick 零副作用（不读 ps 不 reassert）
 *
 * C. CLI/装配接线（源码断言，P1 spec 同范式）：
 * 11. chrome-hideshow-cli：hide 成功 addDesiredHidden / show 成功 removeDesiredHidden
 * 12. index.ts：server 启动 startDesiredHideWatchdog + shutdown 调 stop
 *
 * D. reassert 原语（chrome-hide.ts，execFn 注入——不真跑 osascript）：
 * 13. "hidden" 信号 → {ok:true, wasVisible:true}；"already" → wasVisible:false；
 *     "nomatch" → {ok:false, process_not_found}；非零退出 → ok:false
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readDesiredHiddenSync,
  addDesiredHidden,
  removeDesiredHidden,
  rewriteDesiredHiddenSync,
  desiredHiddenPath,
  type DesiredHiddenRecord,
} from "../../src/launcher/desired-hide-state.js";
import {
  startDesiredHideWatchdog,
  DESIRED_HIDE_WATCHDOG_INTERVAL_MS,
} from "../../src/launcher/desired-hide-watchdog.js";
import { reassertChromeHiddenByPid } from "../../src/launcher/chrome-hide.js";

// ============================================================
// 台账隔离（chrome-ledger.spec 同范式）
// ============================================================
let __tmpDir: string;

beforeEach(async () => {
  __tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lasso-desired-hide-"));
  process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(__tmpDir, "desired-hidden.json");
});

afterEach(async () => {
  delete process.env.LASSO_DESIRED_HIDDEN_PATH;
  await fs.promises.rm(__tmpDir, { recursive: true, force: true });
});

function makeRec(overrides: Partial<DesiredHiddenRecord> = {}): DesiredHiddenRecord {
  return {
    pid: 111,
    port: 9226,
    profileDir: "/tmp/lasso-profile-test",
    hiddenAt: 1_000_000,
    ...overrides,
  };
}

// ============================================================
// A. 粘滞台账
// ============================================================
describe("desired-hide-state 粘滞台账", () => {
  it("add 同 pid 覆盖 + read 回读形状完整", async () => {
    await addDesiredHidden(makeRec());
    await addDesiredHidden(makeRec({ hiddenAt: 2_000_000 })); // 同 pid 覆盖
    const out = readDesiredHiddenSync();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pid: 111, port: 9226, hiddenAt: 2_000_000 });
  });

  it("remove 清账；损坏 JSON / 非数组顶层 → []", async () => {
    await addDesiredHidden(makeRec());
    await removeDesiredHidden(111);
    expect(readDesiredHiddenSync()).toEqual([]);
    // 损坏 JSON
    fs.writeFileSync(desiredHiddenPath(), "{not-json", "utf8");
    expect(readDesiredHiddenSync()).toEqual([]);
    // 非数组顶层
    fs.writeFileSync(desiredHiddenPath(), '{"pid":1}', "utf8");
    expect(readDesiredHiddenSync()).toEqual([]);
  });

  it("rewriteSync 落盘剔除结果（watchdog 剔除路径零 await 纪律）", () => {
    addDesiredHiddenSyncForTest(makeRec({ pid: 1 }));
    rewriteDesiredHiddenSync([]);
    expect(readDesiredHiddenSync()).toEqual([]);
  });
});

// 同步桥：add 是 async（原子 rename 用 fsp）——测试里直接写初始态
function addDesiredHiddenSyncForTest(rec: DesiredHiddenRecord): void {
  fs.writeFileSync(desiredHiddenPath(), JSON.stringify([rec], null, 2), "utf8");
}

// ============================================================
// B. 看门狗（全注入 + fake timers）
// ============================================================
function makeWatchdog(
  state: DesiredHiddenRecord[],
  opts: {
    alive?: (pid: number) => boolean;
    ps?: (pid: number) => string;
    reassert?: (pid: number) => Promise<{ ok: boolean; wasVisible?: boolean; reason?: string }>;
  } = {},
) {
  const reassertCalls: number[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const rewrites: DesiredHiddenRecord[][] = [];
  const wd = startDesiredHideWatchdog({
    platform: "darwin", // CI-linux：被测的是 watchdog 机制非平台门（平台门另有 it 单测）
    intervalMs: DESIRED_HIDE_WATCHDOG_INTERVAL_MS,
    readStateFn: () => state,
    rewriteStateFn: (records) => rewrites.push(records),
    aliveFn: opts.alive ?? (() => true),
    psFn: opts.ps ?? (() => `--user-data-dir=${state[0]?.profileDir ?? "/x"} \n`),
    reassertFn:
      opts.reassert ??
      (async (pid) => {
        reassertCalls.push(pid);
        return { ok: true, wasVisible: false };
      }),
    logFn: (p) => logs.push(p),
  });
  return { wd, reassertCalls, logs, rewrites };
}

describe("desired-hide-watchdog 粘滞复隐看门狗", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("被掀出（wasVisible）→ 压回 + desired_hidden_reasserted 日志（P27 观测点）", async () => {
    const { wd, logs, reassertCalls } = makeWatchdog([makeRec()], {
      reassert: async (pid) => {
        reassertCalls.push(pid);
        return { ok: true, wasVisible: true };
      },
    });
    await vi.advanceTimersByTimeAsync(DESIRE_D_HIDE_TICK);
    expect(reassertCalls).toEqual([111]);
    expect(logs.some((l) => l.evt === "desired_hidden_reasserted")).toBe(true);
    wd.stop();
  });

  it("本就隐藏（wasVisible=false）→ 无 reasserted 日志（零噪音）", async () => {
    const { wd, logs } = makeWatchdog([makeRec()]);
    await vi.advanceTimersByTimeAsync(DESIRE_D_HIDE_TICK);
    expect(logs.some((l) => l.evt === "desired_hidden_reasserted")).toBe(false);
    wd.stop();
  });

  it("pid 死亡 → 剔除落盘 + pruned(pid_dead)；不施 osascript", async () => {
    const { wd, logs, rewrites, reassertCalls } = makeWatchdog([makeRec()], {
      alive: () => false,
    });
    await vi.advanceTimersByTimeAsync(DESIRE_D_HIDE_TICK);
    expect(reassertCalls).toEqual([]);
    expect(rewrites).toEqual([[]]); // 剔除后落盘空
    expect(logs.some((l) => l.evt === "desired_hidden_pruned" && l.reason === "pid_dead")).toBe(true);
    wd.stop();
  });

  it("归属复验失败（pid 复用）→ 剔除 + pruned(pid_reused)；绝不 reassert（E8 红线）", async () => {
    const { wd, logs, rewrites, reassertCalls } = makeWatchdog([makeRec()], {
      ps: () => "/Applications/Google Chrome --user-data-dir=/别的profile \n",
    });
    await vi.advanceTimersByTimeAsync(DESIRE_D_HIDE_TICK);
    expect(reassertCalls).toEqual([]);
    expect(rewrites).toEqual([[]]);
    expect(logs.some((l) => l.evt === "desired_hidden_pruned" && l.reason === "pid_reused")).toBe(true);
    wd.stop();
  });

  it("非 darwin → 返 null（不启 timer）", () => {
    expect(startDesiredHideWatchdog({ platform: "linux" })).toBeNull();
  });

  it("stop() 后 tick 不再发生", async () => {
    const { wd, reassertCalls } = makeWatchdog([makeRec()]);
    wd.stop();
    wd.stop(); // 幂等
    await vi.advanceTimersByTimeAsync(DESIRE_D_HIDE_TICK * 3);
    expect(reassertCalls).toEqual([]);
  });

  it("空 → tick 零副作用（不读 ps 不 reassert）", async () => {
    const { wd, logs, rewrites, reassertCalls } = makeWatchdog([]);
    await vi.advanceTimersByTimeAsync(DESIRE_D_HIDE_TICK);
    expect(reassertCalls).toEqual([]);
    expect(rewrites).toEqual([]);
    expect(logs).toEqual([]);
    wd.stop();
  });
});

const DESIRE_D_HIDE_TICK = DESIRED_HIDE_WATCHDOG_INTERVAL_MS + 10;

// ============================================================
// C. CLI/装配接线（源码断言）
// ============================================================
describe("desired-hide 接线", () => {
  it("chrome-hideshow-cli：hide 成功 addDesiredHidden / show 成功 removeDesiredHidden", () => {
    const src = readFileSync("src/launcher/chrome-hideshow-cli.ts", "utf8");
    expect(src).toContain("if (show) {");
    expect(src).toContain("await removeDesiredHidden(rec.pid)");
    expect(src).toContain("await addDesiredHidden({");
    expect(src).toMatch(/if \(r\.ok\)\s*\{/);
  });

  it("P2：chrome-hideshow-cli 默认执守拉起透传 logFn（entry_missing/spawn_error/pidfile_error 不再被吞）", () => {
    const src = readFileSync("src/launcher/chrome-hideshow-cli.ts", "utf8");
    // 默认 ensureEnforcer 分支必须给 ensureHideEnforcerRunning 传 logFn（stderr 结构化）
    expect(src).toMatch(/ensureHideEnforcerRunning\(\{\s*logFn:/);
  });

  it("index.ts：server 启动 startDesiredHideWatchdog + shutdown 调 stop", () => {
    const src = readFileSync("src/index.ts", "utf8");
    expect(src).toMatch(/startDesiredHideWatchdog\(\{/);
    expect(src).toMatch(/desiredHideWatchdog\?\.stop\(\)/);
  });
});

// ============================================================
// E. --pid 变体归属解析（resolvePidTarget 纯函数）
// ============================================================
describe("resolvePidTarget --pid 地面真源归属", () => {
  const NS = path.join(os.homedir(), ".cache", "lasso");
  const okCmd = (dir: string) =>
    `/Applications/Google Chrome --remote-debugging-port=9226 --user-data-dir=${dir} \n`;

  it("lasso 命名空间内 profile + 端口标记 → 通过并提取 port/profileDir", async () => {
    const { resolvePidTarget } = await import("../../src/launcher/chrome-hideshow-cli.js");
    const r = resolvePidTarget(85359, () => okCmd(`${NS}/dedao-profile`));
    expect(r.ok).toBe(true);
    expect(r.pid).toBe(85359);
    expect(r.port).toBe(9226);
    expect(r.profileDir).toBe(path.resolve(`${NS}/dedao-profile`));
  });

  it("用户日常 Chrome（无 --user-data-dir）→ 拒绝 pid_not_lasso_profile", async () => {
    const { resolvePidTarget } = await import("../../src/launcher/chrome-hideshow-cli.js");
    expect(resolvePidTarget(1, () => "/Applications/Google Chrome \n").reason).toBe("pid_not_lasso_profile");
  });

  it("profile 在命名空间外（用户自建目录/pid 复用）→ 拒绝", async () => {
    const { resolvePidTarget } = await import("../../src/launcher/chrome-hideshow-cli.js");
    expect(resolvePidTarget(1, () => okCmd("/Users/x/chrome-profile")).reason).toBe("pid_not_lasso_profile");
  });

  it("进程不存在（ps 空）→ pid_not_found；非法 pid → invalid_pid", async () => {
    const { resolvePidTarget } = await import("../../src/launcher/chrome-hideshow-cli.js");
    expect(resolvePidTarget(1, () => "").reason).toBe("pid_not_found");
    expect(resolvePidTarget(-3, () => "x").reason).toBe("invalid_pid");
  });

  it("无 --remote-debugging-port → port=0 诊断降级不阻断", async () => {
    const { resolvePidTarget } = await import("../../src/launcher/chrome-hideshow-cli.js");
    const r = resolvePidTarget(1, () => `--user-data-dir=${NS}/p1 \n`);
    expect(r.ok).toBe(true);
    expect(r.port).toBe(0);
  });
});

// ============================================================
// D. reassert 原语（execFn 注入）
// ============================================================
describe("reassertChromeHiddenByPid 原语", () => {
  const mk = (stdout: string, status = 0) =>
    reassertChromeHiddenByPid(111, {
      platform: "darwin",
      execFn: () => ({ status, stdout }),
    });

  it('"hidden" 信号 → {ok:true, wasVisible:true}', () => {
    expect(mk("hidden")).toEqual({ ok: true, wasVisible: true });
  });
  it('"already" 信号 → wasVisible:false', () => {
    expect(mk("already")).toEqual({ ok: true, wasVisible: false });
  });
  it('"nomatch" 信号 → {ok:false, process_not_found}', () => {
    expect(mk("nomatch")).toEqual({ ok: false, reason: "process_not_found" });
  });
  it("非零退出 → ok:false（TCC 缺失等降级语义）", () => {
    expect(mk("", -1743).ok).toBe(false);
  });
  it("非 darwin / 无 pid → no-op", () => {
    expect(reassertChromeHiddenByPid(111, { platform: "linux" })).toEqual({ ok: false, reason: "non_mac_noop" });
    expect(reassertChromeHiddenByPid(undefined, { platform: "darwin" })).toEqual({ ok: false, reason: "no_pid" });
  });
});
