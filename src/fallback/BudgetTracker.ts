/**
 * BudgetTracker v0.3（parse3 §3.7，F3.4.8-9）
 *
 * 每个 StepEngine.runChain() 调用实例化一个 BudgetTracker，承担两件事：
 *  1. chain 时间预算（默认 120s）：每 step spend(duration_ms)，超预算 → 引擎
 *     stop("budget_exceeded")。给 CC 一个确定性边界：「chain 不会无限烧时间」。
 *  2. partial_failures 聚合：每步出现 outcome≠worked 的 partial 都 record 入数组；
 *     chain 结束时 flushInto(result) 把它们透传到 InteractResult.partial_failures。
 *
 * 与 v0.2 PartialFailures.aggregatePartialFailures 的关系（parse2 §3.6.1）：
 *  - aggregatePartialFailures 是**纯函数**：per-source 数组 → PartialFailure[]
 *    （扇出场景：zhipu worked / brave 429）。本无状态、无副作用。
 *  - BudgetTracker 是**有状态累加器**：随 chain 推进逐步 recordPartial()，最后
 *    flushInto() 一次性透传。两者形状一致（都往 InteractResult.partial_failures
 *    写），方便 doctor / 告警统一处理。
 *
 * 与 RPM 滑动窗口限频（F3.1.12）的关系：正交。
 *  - RPM 是 per-provider **调用次数** 维度（60s 窗口内允许 N 次调用）
 *  - BudgetTracker 是 per-chain **时间** 维度（整个 chain 总耗时 ≤ budgetMs）
 *
 * 简单性铁律（01 思想）：本类仅累加，不主动降级——降级决策归 StepEngine / FallbackDecider。
 *
 * 借鉴：parse3 §3.7 + §3.1；Skyvern budget pool（12 §3.5.10）。
 */
import type { InteractResult, PartialFailure } from "../types.js";

// ============================================================
// 默认值
// ============================================================
/**
 * chain 总预算（ms）。默认 120s = 2 分钟（parse3 §3.7 / §4.5）。
 * 一个典型 chain：5 步 × 平均 2-5s/步 = 10-25s；120s 留 5-10× 余量。
 * 超长 chain（如 50 步 form 填充）应在 BrowseChannel 入口显式覆盖。
 */
export const DEFAULT_CHAIN_BUDGET_MS = 120_000;

// ============================================================
// BudgetTracker
// ============================================================
/**
 * 每个 chain 实例化一个；不跨 chain 复用（避免上一个 chain 的 elapsed 污染下一个）。
 *
 * 用法（StepEngine.runChain 内）：
 *   const budget = new BudgetTracker(120_000);
 *   for (const step of steps) {
 *     if (budget.exhausted()) return stop("budget_exceeded", ...);
 *     const t0 = Date.now();
 *     const partial = await channel.executeStep(url, step);
 *     budget.spend(Date.now() - t0);
 *     if (partial.outcome !== "worked") budget.recordPartial({ ... });
 *   }
 *   return budget.flushInto(result);
 */
export class BudgetTracker {
  private elapsedMs = 0;
  private partials: PartialFailure[] = [];

  constructor(
    private readonly budgetMs: number = DEFAULT_CHAIN_BUDGET_MS,
    /** 时间戳源（默认 Date.now）—— 测试时注入固定值 */
    private readonly now: () => number = Date.now,
  ) {}

  // ============================================================
  // 时间预算
  // ============================================================
  /** 记一步耗时（ms）。负数忽略（防御性，不应发生）。 */
  spend(ms: number): void {
    if (ms <= 0) return;
    this.elapsedMs += ms;
  }

  /** 是否已超预算。等于也算超（边界：恰好花完即停）。 */
  exhausted(): boolean {
    return this.elapsedMs >= this.budgetMs;
  }

  /** 剩余预算（ms）；floor 到 0。 */
  remaining(): number {
    return Math.max(0, this.budgetMs - this.elapsedMs);
  }

  /** 已花费时间（ms）。调试 / 报表用。 */
  used(): number {
    return this.elapsedMs;
  }

  /** 原始预算上限（ms）。 */
  cap(): number {
    return this.budgetMs;
  }

  // ============================================================
  // partial_failures 聚合
  // ============================================================
  /**
   * 记一条 partial_failure（携带当前时间戳）。
   * 调用方负责填 channel + error；timestamp 由 BudgetTracker 注入（一致性 + 测试可控）。
   */
  recordPartial(p: Omit<PartialFailure, "timestamp">): void {
    this.partials.push({ ...p, timestamp: this.now() });
  }

  /** 已累计 partial_failures（只读副本；外部修改不影响内部）。 */
  getPartials(): PartialFailure[] {
    return [...this.partials];
  }

  /** 已累计 partial_failures 数量。 */
  partialCount(): number {
    return this.partials.length;
  }

  // ============================================================
  // chain 结束时合并到 InteractResult
  // ============================================================
  /**
   * 把累计的 partial_failures 透传到 InteractResult.partial_failures。
   *  - 无 partials → 原样返回 result（不增字段）
   *  - 有 partials → 与 result.partial_failures 合并（不覆盖既有项）
   *
   * parse3 §3.7：chain 结束时调用方调一次；多次调幂等（重复添加相同 partials）。
   */
  flushInto<T>(result: InteractResult<T>): InteractResult<T> {
    if (this.partials.length === 0) return result;
    const existing = result.partial_failures ?? [];
    return {
      ...result,
      partial_failures: [...existing, ...this.partials],
    };
  }
}
