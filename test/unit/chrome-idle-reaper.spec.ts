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
  opts: {
    defaultIdleMs?: number;
    now?: number;
    hardCapMs?: number;
    touchStat?: (port: number) => number | undefined;
  } = {},
) {
  let now = opts.now ?? 1_000_000;
  const stopCalls: Array<{ port: number }> = [];
  const warnLogs: Array<Record<string, unknown>> = [];
  const reaper = startChromeIdleReaper({
    defaultIdleMs: opts.defaultIdleMs ?? 60_000,
    hardCapMs: opts.hardCapMs,
    readLedgerFn: () => ledger,
    nowFn: () => now,
    // bug02（v1.18.5）：默认注入「无外部信号」——既有用例不读真实
    // ~/.cache/lasso/chrome-touch-*（hermetic；外部信号专测见 it 10-12 / BUG-06 27）
    touchStatFn: opts.touchStat ?? (() => undefined),
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
      // BUG-03 A1 顺手修（hermeticity）：本用例自建 reaper 未注入 touchStatFn——
      // 默认读真实 ~/.cache/lasso/chrome-touch-9222（真机残留 mtime）会让 9222
      // 永不 idle → 机器状态依赖性假红。注入「无外部信号」与其余用例对齐。
      touchStatFn: () => undefined,
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

  // ============================================================
  // BUG-06 决议 A（doc/bugs/06，2026-09-10，r1 修订后语义）：24h 硬顶天花板
  // 共享层 hardCapMs 缺省=0（关）——下列 cap 用例一律显式传 hardCapMs；
  // 缺省形态=旧语义=既有测试 1-15 零改（§5 r1 反转的测试面体现）。
  // ============================================================

  it("16. BUG-06：idleMs=0 + 龄 > hardCapMs → 收且日志 bound=hard_cap（12h 幽灵事故根治点）", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0, idleMs: 0 })], {
      now: 25 * 3_600_000, // 25h > 24h cap
      hardCapMs: 24 * 3_600_000,
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([{ port: 9222 }]);
    const reaped = t.warnLogs.find((p) => p.evt === "chrome_idle_reaped");
    expect(reaped?.bound).toBe("hard_cap");
    expect(reaped?.hard_cap_ms).toBe(24 * 3_600_000);
    t.reaper?.stop();
  });

  it("17. BUG-06：idleMs=0 + 龄 < cap → 不收（硬顶前不动作）", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0, idleMs: 0 })], {
      now: 12 * 3_600_000, // 12h < 24h（事故时长形态——新行为=继续活，24h 才收）
      hardCapMs: 24 * 3_600_000,
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();
  });

  it("18. BUG-06：idleMs=0 + 龄 > cap 但 touch 文件新鲜 → 不收（cap 基=lastUse 三源 max——「在用永不杀」红线钉子）", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0, idleMs: 0 })], {
      now: 25 * 3_600_000,
      hardCapMs: 24 * 3_600_000,
      touchStat: () => 24.5 * 3_600_000, // 半小时前有外部 touch
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();
  });

  it("19. BUG-06：idleMs=7d > cap=24h → 按 cap 收（ZooKeeper 式 min 夹紧）+ bound=hard_cap", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0, idleMs: 7 * 24 * 3_600_000 })], {
      now: 25 * 3_600_000,
      hardCapMs: 24 * 3_600_000,
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([{ port: 9222 }]);
    const reaped = t.warnLogs.find((p) => p.evt === "chrome_idle_reaped");
    expect(reaped?.bound).toBe("hard_cap");
    t.reaper?.stop();
  });

  it("20. BUG-06：idleMs=30min + cap=24h → 按 30min 收 + bound=idle（idleMs>0 且 ≤cap 零回归锚）", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0, idleMs: 30 * 60_000 })], {
      now: 75 * 60_000,
      hardCapMs: 24 * 3_600_000,
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([{ port: 9222 }]);
    const reaped = t.warnLogs.find((p) => p.evt === "chrome_idle_reaped");
    expect(reaped?.bound).toBe("idle");
    t.reaper?.stop();
  });

  it("21. BUG-06：hardCapMs=0（显式关）+ idleMs=0 → 永不收（旧语义钉死；=缺省形态显式钉）", async () => {
    const t = makeReaper([makeRec({ launchedAt: 0, idleMs: 0 })], {
      now: 100 * 24 * 3_600_000, // 100d ≫ 一切
      hardCapMs: 0,
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS * 3);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();
    // 缺省形态（不传 hardCapMs）与显式 0 同义——共享函数档位无关（r1 反转）
    const d = makeReaper([makeRec({ launchedAt: 0, idleMs: 0 })], {
      now: 100 * 24 * 3_600_000,
    });
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(d.stopCalls).toEqual([]);
    d.reaper?.stop();
  });

  it("22. BUG-06：hardCapExempt=true（--no-hard-cap 落盘）+ idleMs=0 + 龄≫cap → 永不收（双意图钉死）", async () => {
    const t = makeReaper(
      [makeRec({ launchedAt: 0, idleMs: 0, hardCapExempt: true })],
      { now: 100 * 24 * 3_600_000, hardCapMs: 24 * 3_600_000 },
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();
  });

  it("23. BUG-06：visible 档 + idleMs=0 + 龄≫cap → 永不收（豁免继承——cap 谓词在 visible continue 之后）", async () => {
    const t = makeReaper(
      [makeRec({ launchedAt: 0, idleMs: 0, launchMode: "visible" })],
      { now: 100 * 24 * 3_600_000, hardCapMs: 24 * 3_600_000 },
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();
  });

  it("24. BUG-06：userTakenAt 已落 + idleMs=0 + 龄≫cap → 永不收（豁免继承——BUG-03 B1/A1 契约零变化）", async () => {
    const t = makeReaper(
      [makeRec({ launchedAt: 0, idleMs: 0, userTakenAt: 123 })],
      { now: 100 * 24 * 3_600_000, hardCapMs: 24 * 3_600_000 },
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();
  });

  it("25. BUG-06：launchMode=render + idleMs=0 + 龄≫cap → 永不收（渲染档交叉污染零钉死；server 域 readLedgerFn 不过滤的形态）", async () => {
    // server reaper 无 launchMode 过滤（全量读）——render 门是唯一防线（INV-94 ①）
    const t = makeReaper(
      [makeRec({ launchedAt: 0, idleMs: 0, launchMode: "render" })],
      { now: 100 * 24 * 3_600_000, hardCapMs: 24 * 3_600_000 },
    );
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(t.stopCalls).toEqual([]);
    t.reaper?.stop();
  });

  it("26. BUG-06 A-4/D2：cap-only 模式（defaultIdleMs=0 + hardCapMs>0）→ 非 null 且收 idle0 超龄记录；账空自退仍工作", async () => {
    let ledger: LaunchedChromeRecord[] = [makeRec({ launchedAt: 0, idleMs: 0 })];
    let idleExitCalls = 0;
    const stopCalls: Array<{ port: number }> = [];
    const reaper = startChromeIdleReaper({
      defaultIdleMs: 0, // 全局 env LASSO_LAUNCH_IDLE_MS=0 形态
      hardCapMs: 24 * 3_600_000,
      readLedgerFn: () => ledger,
      nowFn: () => 25 * 3_600_000,
      touchStatFn: () => undefined,
      stopFn: async (o) => {
        stopCalls.push({ port: o.port });
      },
      exitWhenLedgerEmptyTicks: 2,
      onIdleExit: () => {
        idleExitCalls++;
      },
    });
    expect(reaper).not.toBeNull(); // 旧语义此处 null（reaper 整体不启）——D2 修复本体
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
    expect(stopCalls).toEqual([{ port: 9222 }]);
    ledger = [];
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS * 2);
    expect(idleExitCalls).toBe(1); // cap-only 不破坏账空自退（执守形态退出闩）
    reaper?.stop();
  });

  it("27. BUG-06 A-4：双关（defaultIdleMs=0 + hardCapMs=0）→ null（旧 disabled 钉死）", () => {
    const disabled = startChromeIdleReaper({
      defaultIdleMs: 0,
      hardCapMs: 0,
      readLedgerFn: () => [makeRec({ launchedAt: 0, idleMs: 0 })],
      stopFn: async () => {
        throw new Error("should_not_start");
      },
    });
    expect(disabled).toBeNull();
  });

  it("28. BUG-06 A-7（r1/否定轮 N1）：执守宿主形态（touchMap 恒空）+ idleMs=0 + 龄>cap + touch 文件新鲜 → 不收；touch 陈旧 → 收（跨进程真源接线活性对照）", async () => {
    vi.useFakeTimers();
    try {
      // 形态钉：经 startEnforcerIdleReaper（执守装配——不传 touchPorts，touchMap 恒空）
      const { startEnforcerIdleReaper } = await import(
        "../../src/launcher/desired-hide-enforcer.js"
      );
      const stopCalls: Array<{ port: number }> = [];
      // 新鲜 touch（server 侧 onChromeUse 落盘后对执守可见——A-7 写侧的读侧形态钉）
      let touchMtime: number | undefined = 24.9 * 3_600_000;
      const mkEnforcer = () =>
        startEnforcerIdleReaper({
          defaultIdleMs: 0,
          readLedgerFn: () => [makeRec({ launchedAt: 0, idleMs: 0 })],
          nowFn: () => 25 * 3_600_000,
          touchStatFn: () => touchMtime,
          stopFn: async (o) => {
            stopCalls.push({ port: o.port });
          },
          logFn: () => {},
        });
      const r = mkEnforcer();
      expect(r).not.toBeNull(); // wrapper 缺省 hardCapMs=24h（装配层「失效方向偏有顶」）
      await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
      expect(stopCalls).toEqual([]); // touch 新鲜：跨进程活动可见 → 不收
      touchMtime = undefined; // 无信号（陈旧）
      await vi.advanceTimersByTimeAsync(CHROME_IDLE_REAPER_INTERVAL_MS);
      expect(stopCalls).toEqual([{ port: 9222 }]); // 接线活性对照：真收
      r?.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
