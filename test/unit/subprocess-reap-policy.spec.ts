/**
 * subprocess-reap-policy.spec.ts（W2，doc/bugs/09 决议 A.4⑤r1，2026-09-16）
 *
 * 守护 per-spec reapPolicy 三元组（两态生命周期）契约：
 *  1. 存量回归锚：spec 无 reapPolicy → 行为与 v1.26.0 字节级等价（全局阈值；
 *     policy.idleMs 不越权覆盖）
 *  2. 态一（未接管）：policy.idleMs 独立阈值生效（宽于/严于全局都对）
 *  3. 态二（已接管粘滞）：markUserTaken 后 idle 收割豁免（永不回落）
 *  4. 硬顶兜底：hardCapMs 超龄 → 即使 userTaken 粘滞也回收（唯一兜底出口）
 *  5. hardCapMs=0 → 部署级禁用硬顶（粘滞 + 超龄 → 保留）
 *  6. markUserTaken 契约：命中返 true；missing/closed 返 false；幂等；
 *     respawn（新 ManagedProc）后标记重置
 *  7. 判定序：hard cap 优先于 sticky 豁免（_reapReason 序：cap → sticky → idle）
 *  8. config 解析：LASSO_HEADED_IDLE_MS（默认 30min≠headless 5min）/
 *     LASSO_HEADED_HARD_CAP_MS（默认 24h；显式 0 部署级禁用）/
 *     LASSO_FALLBACK_CROSS_CHANNEL（默认 false）
 *
 * 测试策略：仿 subprocess-idle-watchdog.spec.ts——vi.mock util/kill-tree.js，
 * procs 私有 map 白盒注入伪 ManagedProc（不真 spawn MCP）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/util/kill-tree.js", () => ({
  killTreeSync: vi.fn(),
}));

import { killTreeSync } from "../../src/util/kill-tree.js";
import {
  SubprocessManager,
  type SpawnSpec,
} from "../../src/subprocess/SubprocessManager.js";
import {
  parseHeadedIdleMs,
  parseHeadedHardCapMs,
  DEFAULT_HEADED_IDLE_MS,
  DEFAULT_HEADED_HARD_CAP_MS,
  loadConfig,
} from "../../src/config/config.js";

const killTreeMock = vi.mocked(killTreeSync);

const SPEC = (reapPolicy?: SpawnSpec["reapPolicy"]): SpawnSpec => ({
  command: "npx",
  args: ["-y", "chrome-devtools-mcp@1.7.0"],
  mcpClientName: "lasso-browse-headed",
  ...(reapPolicy ? { reapPolicy } : {}),
});

/** 白盒注入伪 ManagedProc（spawnedAt / lastUsedAt 独立偏移——硬顶测试需要）。 */
function injectProc(
  mgr: SubprocessManager,
  name: string,
  pid: number,
  spawnedAgoMs: number,
  lastUsedAgoMs: number,
  userTaken = false,
): void {
  (mgr as unknown as {
    procs: Map<string, unknown>;
  }).procs.set(name, {
    client: { pid, close: async () => {} },
    spawnedAt: Date.now() - spawnedAgoMs,
    lastUsedAt: Date.now() - lastUsedAgoMs,
    restartCount: 0,
    closed: false,
    ...(userTaken ? { userTaken } : {}),
  });
}

function procNames(mgr: SubprocessManager): string[] {
  return Array.from(
    (mgr as unknown as { procs: Map<string, unknown> }).procs.keys(),
  );
}

describe("SubprocessManager — W2 per-spec reapPolicy（两态生命周期）", () => {
  beforeEach(() => {
    killTreeMock.mockClear();
  });

  it("存量回归锚：无 reapPolicy → 全局阈值（与 v1.26.0 等价；policy 概念不越权）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headless", SPEC());
    injectProc(mgr, "headless", 5001, 6 * 60_000, 6 * 60_000);
    await mgr.cleanupZombies(300_000);
    expect(procNames(mgr)).not.toContain("headless");
    expect(killTreeMock).toHaveBeenCalledWith(5001, "headless");
  });

  it("存量回归锚（反向）：无 reapPolicy + 超过任意 policy 量级但未过全局阈值 → 保留", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headless", SPEC());
    injectProc(mgr, "headless", 5002, 10 * 60_000, 10 * 60_000);
    await mgr.cleanupZombies(3_600_000); // 全局 1h：10min 未到 → 不杀
    expect(procNames(mgr)).toContain("headless");
    expect(killTreeMock).not.toHaveBeenCalled();
  });

  it("态一：policy.idleMs 独立阈值生效（宽于全局——全局 10s 早过但仍按 60s 判）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headed", SPEC({ idleMs: 60_000, stickyExempt: true, hardCapMs: 86_400_000 }));
    injectProc(mgr, "headed", 5101, 30_000, 30_000);
    await mgr.cleanupZombies(10_000); // 全局阈值 10s（早已超）——policy 60s 未到 → 保留
    expect(procNames(mgr)).toContain("headed");
    expect(killTreeMock).not.toHaveBeenCalled();
  });

  it("态一：超过 policy.idleMs → 回收", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headed", SPEC({ idleMs: 60_000, stickyExempt: true, hardCapMs: 86_400_000 }));
    injectProc(mgr, "headed", 5102, 90_000, 90_000);
    await mgr.cleanupZombies(3_600_000); // 全局 1h 未到——policy 60s 已过 → 杀
    expect(procNames(mgr)).not.toContain("headed");
    expect(killTreeMock).toHaveBeenCalledWith(5102, "headed");
  });

  it("态二：markUserTaken 粘滞 → idle 豁免（超龄 idleMs 数倍也不杀）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headed", SPEC({ idleMs: 60_000, stickyExempt: true, hardCapMs: 86_400_000 }));
    injectProc(mgr, "headed", 5103, 3_600_000, 3_600_000); // 1h 无调用
    expect(mgr.markUserTaken("headed")).toBe(true);
    expect(mgr.isUserTaken("headed")).toBe(true);
    await mgr.cleanupZombies(60_000);
    expect(procNames(mgr)).toContain("headed"); // 粘滞豁免
    expect(killTreeMock).not.toHaveBeenCalled();
  });

  it("态二粘滞永不回落：多次 cleanupZombies 周期后仍豁免（无任何回落写径）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headed", SPEC({ idleMs: 60_000, stickyExempt: true, hardCapMs: 86_400_000 }));
    injectProc(mgr, "headed", 5104, 3_600_000, 3_600_000);
    mgr.markUserTaken("headed");
    for (let i = 0; i < 3; i++) await mgr.cleanupZombies(60_000);
    expect(procNames(mgr)).toContain("headed");
    expect(killTreeMock).not.toHaveBeenCalled();
  });

  it("硬顶兜底：userTaken 粘滞 + 超 hardCapMs → 回收（唯一兜底出口）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headed", SPEC({ idleMs: 60_000, stickyExempt: true, hardCapMs: 3_600_000 }));
    // spawned 2h 前（> hardCap 1h）但 lastUsed 1s 前（idle 未过 + touch 活跃）
    injectProc(mgr, "headed", 5105, 2 * 3_600_000, 1_000, true);
    await mgr.cleanupZombies(60_000);
    expect(procNames(mgr)).not.toContain("headed");
    expect(killTreeMock).toHaveBeenCalledWith(5105, "headed");
  });

  it("硬顶 0 = 部署级禁用：粘滞 + 超龄 → 保留（无顶）", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headed", SPEC({ idleMs: 60_000, stickyExempt: true, hardCapMs: 0 }));
    injectProc(mgr, "headed", 5106, 10 * 86_400_000, 10 * 86_400_000, true);
    await mgr.cleanupZombies(60_000);
    expect(procNames(mgr)).toContain("headed");
    expect(killTreeMock).not.toHaveBeenCalled();
  });

  it("判定序：hard cap 先于 sticky（超 cap + 未接管也走 cap 而非 idle）", async () => {
    const mgr = new SubprocessManager();
    // idleMs 极大（永不 idle）+ cap 1h：spawned 2h → 必因 cap 回收
    mgr.registerSpec("headed", SPEC({ idleMs: 86_400_000, stickyExempt: true, hardCapMs: 3_600_000 }));
    injectProc(mgr, "headed", 5107, 2 * 3_600_000, 1_000);
    await mgr.cleanupZombies(60_000);
    expect(procNames(mgr)).not.toContain("headed");
  });

  it("markUserTaken 契约：missing spec → false；幂等二次 true 不抛", async () => {
    const mgr = new SubprocessManager();
    expect(mgr.markUserTaken("nonexistent")).toBe(false);
    expect(mgr.isUserTaken("nonexistent")).toBe(false);
    mgr.registerSpec("headed", SPEC({ idleMs: 60_000, stickyExempt: true, hardCapMs: 86_400_000 }));
    injectProc(mgr, "headed", 5108, 0, 0);
    expect(mgr.markUserTaken("headed")).toBe(true);
    expect(mgr.markUserTaken("headed")).toBe(true); // 幂等
    expect(mgr.isUserTaken("headed")).toBe(true);
  });

  it("respawn 语义：新 ManagedProc（重注入）不带旧标记——userTaken 不跨代", async () => {
    const mgr = new SubprocessManager();
    mgr.registerSpec("headed", SPEC({ idleMs: 60_000, stickyExempt: true, hardCapMs: 86_400_000 }));
    injectProc(mgr, "headed", 5109, 3_600_000, 3_600_000);
    mgr.markUserTaken("headed");
    // 模拟 idle 前旧进程已退出 + respawn（ensureRunning 新对象）
    (mgr as unknown as { procs: Map<string, unknown> }).procs.delete("headed");
    injectProc(mgr, "headed", 5110, 3_600_000, 3_600_000);
    expect(mgr.isUserTaken("headed")).toBe(false); // 新窗口 = 未接管
    await mgr.cleanupZombies(60_000);
    expect(procNames(mgr)).not.toContain("headed"); // 态一 idle 正常收割
  });
});

describe("config — W2 headed 生命周期 + C3 逃生门解析", () => {
  it("parseHeadedIdleMs：默认 30min（≠ headless 域 5min——引错域防线）；env 覆盖；非法回退", () => {
    expect(DEFAULT_HEADED_IDLE_MS).toBe(1_800_000);
    expect(DEFAULT_HEADED_IDLE_MS).not.toBe(300_000); // 非 headless 默认
    expect(parseHeadedIdleMs(undefined)).toBe(1_800_000);
    expect(parseHeadedIdleMs("")).toBe(1_800_000);
    expect(parseHeadedIdleMs("600000")).toBe(600_000);
    expect(parseHeadedIdleMs("-1")).toBe(1_800_000);
    expect(parseHeadedIdleMs("abc")).toBe(1_800_000);
  });

  it("parseHeadedHardCapMs：默认 24h；显式 0 = 部署级禁用；非法回退默认", () => {
    expect(DEFAULT_HEADED_HARD_CAP_MS).toBe(86_400_000);
    expect(parseHeadedHardCapMs(undefined)).toBe(86_400_000);
    expect(parseHeadedHardCapMs("0")).toBe(0);
    expect(parseHeadedHardCapMs("-5")).toBe(86_400_000);
    expect(parseHeadedHardCapMs("xyz")).toBe(86_400_000);
  });

  it("loadConfig：两键进 LassoConfig（env 源 + 默认源）", () => {
    const dflt = loadConfig({ runId: "t", env: {} });
    expect(dflt.headedIdleMs).toBe(1_800_000);
    expect(dflt.headedHardCapMs).toBe(86_400_000);

    const custom = loadConfig({
      runId: "t",
      env: {
        LASSO_HEADED_IDLE_MS: "120000",
        LASSO_HEADED_HARD_CAP_MS: "3600000",
      },
    });
    expect(custom.headedIdleMs).toBe(120_000);
    expect(custom.headedHardCapMs).toBe(3_600_000);
  });
});
