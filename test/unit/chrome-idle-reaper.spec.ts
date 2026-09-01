/**
 * chrome-idle-reaper.spec.ts（v1.10 parse18 §7.1 机制一 1-9）
 *
 * 守护台账 Chrome idle 用完即关 reaper：
 *  1. 60s idle + 15s 周期：launchedAt 75s 前 → stopFn 以 {port} 被调
 *  2. launchedAt 30s 前 → 不调
 *  3. touch(port) 后重算（touch 重置 lastUse → 不杀）
 *  4. rec.idleMs per-record 覆盖全局默认（3600000 → 不杀）
 *  5. idleMs=0（record 级）→ 跳过；defaultIdleMs=0 → 返 null（不启 timer）
 *  6. stopFn reject → warn 继续处理下一条（reaper 不死）
 *  7. stop() 清 interval（幂等；stop 后 tick 不再发生）
 *  8. 两条记录只杀超时那条（port 精确性）
 *  9. 源码 grep 断言：chrome-idle-reaper.ts 无 killTreeSync / process.kill 直接
 *     调用（INV-78c 的测试面镜像；杀必须经 chrome-stop 验证路径）
 *
 * 全注入（readLedgerFn / nowFn / stopFn / logFn + fake timers）——不触真实台账
 * / 不真杀进程 / 不等真实 15s。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  startChromeIdleReaper,
  CHROME_IDLE_REAPER_INTERVAL_MS,
} from "../../src/launcher/chrome-idle-reaper.js";
import type { LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";

// ============================================================
// helpers
// ============================================================
function makeRec(overrides: Partial<LaunchedChromeRecord> = {}): LaunchedChromeRecord {
  return {
    port: 9222,
    pid: 111,
    profileDir: "/tmp/lasso-profile-test",
    launchedAt: 0,
    status: "ready",
    ...overrides,
  };
}

/** 测试装配：可控时钟 + 可控台账 + 记录型 stopFn/logFn。 */
function makeReaper(
  ledger: LaunchedChromeRecord[],
  opts: { defaultIdleMs?: number; now?: number } = {},
) {
  let now = opts.now ?? 1_000_000;
  const stopCalls: Array<{ port: number }> = [];
  const warnLogs: Array<Record<string, unknown>> = [];
  const reaper = startChromeIdleReaper({
    defaultIdleMs: opts.defaultIdleMs ?? 60_000,
    readLedgerFn: () => ledger,
    nowFn: () => now,
    // bug02（v1.18.5）：默认注入「无外部信号」——既有用例不读真实
    // ~/.cache/lasso/chrome-touch-*（hermetic；外部信号专测见 it 10-12）
    touchStatFn: () => undefined,
    stopFn: async (o) => {
      stopCalls.push({ port: o.port });
    },
    logFn: (p) => {
      warnLogs.push(p);
    },
    intervalMs: CHROME_IDLE_REAPER_INTERVAL_MS,
  });
  return {
    reaper,
    stopCalls,
    warnLogs,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
  };
}

// ============================================================
// tests
// ============================================================
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("chrome-idle-reaper —— 台账 Chrome idle 用完即关（parse18 §2）", () => {
  it("1. 60s idle：launchedAt 75s 前 → 首个 15s tick 即 stopFn({port})", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0 })], { now: 75_000 });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([{ port: 9222 }]);
    t.reaper?.stop();
  });

  it("2. launchedAt 30s 前 → 未到 60s 阈值不杀；75s 时杀", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0 })], { now: 30_000 });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.now = 75_000;
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([{ port: 9222 }]);
    t.reaper?.stop();
  });

  it("3. touch(port) 重置 lastUse → 不杀（browse 活动源）", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0 })], { now: 50_000 });
    t.reaper!.touch(9222); // now=50s 打点
    t.now = 100_000; // 距 touch 仅 50s < 60s
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();
  });

  it("4. rec.idleMs=3600000 per-record 覆盖全局默认 → 不杀（长会话放行）", async () => {
    const t = makeReaper(
      [makeRec({ launchedAt: 0, idleMs: 3_600_000 })],
      { now: 75_000 },
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();
  });

  it("5. rec.idleMs=0 → record 级禁用跳过；defaultIdleMs=0 → 返 null（不启 timer）", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0, idleMs: 0 })], { now: 75_000 });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();

    const disabled = startChromeIdleReaper({
      defaultIdleMs: 0,
      readLedgerFn: () => [makeRec({ launchedAt: 0 })],
      stopFn: async () => {
        throw new Error("should_not_start");
      },
    });
    expect(disabled).toBeNull();
  });

  it("6. stopFn reject → warn 继续（reaper 不死；台账仍在则下轮重试）", async () => {
    const ledger = [makeRec({ port: 9222, launchedAt: 0 }), makeRec({ port: 9333, pid: 222, launchedAt: 0 })];
    let throwOnce = true;
    let now = 75_000;
    const stopCalls: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const reaper = startChromeIdleReaper({
      defaultIdleMs: 60_000,
      readLedgerFn: () => ledger,
      nowFn: () => now,
      stopFn: async (o) => {
        stopCalls.push(o.port);
        if (throwOnce) {
          throwOnce = false;
          throw new Error("stop_boom");
        }
      },
      logFn: (p) => logs.push(p),
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    // 两条都被尝试（第一条抛错不影响第二条）
    expect(stopCalls.sort()).toEqual([9222, 9333]);
    expect(logs.some((p) => p.evt === "chrome_idle_reap_error")).toBe(true);
    reaper!.stop();
  });

  it("7. stop() 清 interval（幂等；stop 后时间推进不再杀）", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0 })], { now: 10_000 });
    t.reaper!.stop();
    t.reaper!.stop(); // 幂等不抛
    t.now = 1_000_000;
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS * 3);
    expect(t.stopCalls).toEqual([]);
  });

  it("8. 两条记录只杀超时那条（port 精确性）", async () => {
    const t = makeReaper(
      [
        makeRec({ port: 9222, pid: 111, launchedAt: 0 }),
        makeRec({ port: 9333, pid: 222, launchedAt: 50_000 }),
      ],
      { now: 75_000 },
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([{ port: 9222 }]);
    t.reaper?.stop();
  });

  it("9. 源码断言：无 killTreeSync / process.kill 直接调用（INV-78c 测试面镜像）", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/launcher/chrome-idle-reaper.ts", import.meta.url)),
      "utf8",
    );
    // 剥注释（块 + 行）后扫真实代码
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toContain("killTreeSync");
    expect(code).not.toContain("process.kill");
    // kill 出口必须经 chrome-stop（import 契约）
    expect(code).toContain("stopLaunchedChromes");
  });

  // ----- bug02 闭环（v1.18.5，doc/bugs/02）：外部 touch 文件活动信号 -----

  it("10. bug02：外部 touch mtime（30s 前）晚于 launchedAt（75s 前）→ 三源取 max 不杀", async () => {
    const stopCalls: Array<{ port: number }> = [];
    const reaper = startChromeIdleReaper({
      defaultIdleMs: 60_000,
      readLedgerFn: () => [makeRec({ launchedAt: 0 })],
      nowFn: () => 75_000,
      touchStatFn: () => 45_000, // 外部消费者 30s 前 touch 过
      stopFn: async (o) => {
        stopCalls.push({ port: o.port });
      },
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(stopCalls).toEqual([]); // lastUse=45s → 距今 30s < 60s
    reaper?.stop();
  });

  it("11. bug02：外部 touch 信号陈旧（65s 前无再 touch）→ 照杀（信号不是免死金牌）", async () => {
    const stopCalls: Array<{ port: number }> = [];
    const reaper = startChromeIdleReaper({
      defaultIdleMs: 60_000,
      readLedgerFn: () => [makeRec({ launchedAt: 0 })],
      nowFn: () => 75_000,
      touchStatFn: () => 10_000, // 65s 前的陈旧信号（> 60s idle 窗）
      stopFn: async (o) => {
        stopCalls.push({ port: o.port });
      },
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(stopCalls).toEqual([{ port: 9222 }]); // max(0, 0, 10s)=10s → 距今 65s > 60s
    reaper?.stop();
  });

  it("12. bug02：touchStatFn 缺省接线 chrome-touch（外部信号单一真源；undefined=无信号）", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/launcher/chrome-idle-reaper.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain('from "./chrome-touch.js"');
    expect(src).toMatch(/touchStatFn = opts\.touchStatFn \?\? \(\(port: number\) => chromeTouchMtimeSync\(port\)\)/);
    // 三源取 max：外部信号只会延后收割、永不提前
    expect(src).toMatch(/Math\.max\(\s*rec\.launchedAt,\s*touchMap\.get\(rec\.port\) \?\? 0,\s*touchStatFn\(rec\.port\) \?\? 0,/);
  });

  // ============================================================
  // v1.19（渲染档设计决议 1.3）：exitWhenLedgerEmptyTicks 账空自退（opt-in）
  // ============================================================
  it("13. exitWhenLedgerEmptyTicks=2：连续 2 tick 空账 → onIdleExit 被调 + 自停（后续 tick 零动作）", async () => {
    let ledger: ReturnType<typeof makeRec>[] = [];
    let idleExitCalls = 0;
    const stopCalls: Array<{ port: number }> = [];
    const reaper = startChromeIdleReaper({
      defaultIdleMs: 60_000,
      readLedgerFn: () => ledger,
      nowFn: () => 1_000_000,
      stopFn: async (o) => {
        stopCalls.push({ port: o.port });
      },
      exitWhenLedgerEmptyTicks: 2,
      onIdleExit: () => {
        idleExitCalls++;
      },
    });
    expect(reaper).not.toBeNull();
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // 空账 tick 1
    expect(idleExitCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // 空账 tick 2 → 自退
    expect(idleExitCalls).toBe(1);
    // 自停后再走 3 个 tick：无重复 onIdleExit、无 stopFn
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS * 3);
    expect(idleExitCalls).toBe(1);
    expect(stopCalls).toEqual([]);
    reaper?.stop();
  });

  it("14. 计数器在非空 tick 清零：空→有→空 两轮不提前退（须重新连续 2 tick）", async () => {
    let ledger: ReturnType<typeof makeRec>[] = [makeRec({ launchedAt: 1_000_000, idleMs: 3_600_000 })];
    let idleExitCalls = 0;
    const reaper = startChromeIdleReaper({
      defaultIdleMs: 60_000,
      readLedgerFn: () => ledger,
      nowFn: () => 1_000_000,
      exitWhenLedgerEmptyTicks: 2,
      onIdleExit: () => {
        idleExitCalls++;
      },
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // 非空 tick → 计数清零
    ledger = []; // 转空
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // 空 tick 1（重新计数）
    expect(idleExitCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS); // 空 tick 2 → 退
    expect(idleExitCalls).toBe(1);
    reaper?.stop();
  });

  it("15. 不传 exitWhenLedgerEmptyTicks：空账永不自退（默认零变化锚——server 进程内形态）", async () => {
    let idleExitCalls = 0;
    const reaper = startChromeIdleReaper({
      defaultIdleMs: 60_000,
      readLedgerFn: () => [],
      nowFn: () => 1_000_000,
      onIdleExit: () => {
        idleExitCalls++;
      },
    });
    expect(reaper).not.toBeNull();
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS * 5);
    expect(idleExitCalls).toBe(0);
    reaper?.stop();
  });
});
