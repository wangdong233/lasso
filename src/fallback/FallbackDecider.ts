/**
 * 单一 fallback 引擎（parse1 §3.9 + §4.4，不变量 INV-4）
 *
 * 整个项目只有一个 FallbackDecider 类——search / browse_headless / browse_logged_in
 * 共用同一套：worked/didnt 短路返回；unknown + isFallbackWorthy 才升下一个 channel。
 *
 * 关键语义（§4.4）：
 *  - worked → 立即返回，breaker.recordSuccess
 *  - didnt  → 立即返回（channel 工作正常，只是答案为"否"），breaker.recordSuccess
 *  - unknown:
 *      · isFallbackWorthy → recordFailure + continue 试下一个
 *      · 否则（如 NEEDS_MANUAL_2FA）→ 立即返回（明确"需人"信号，不 fallback）
 *  - executor 抛异常 → 视为 unknown + recordFailure + 视情况 continue
 *
 * actions_and_results 审计链：每次尝试记一行 {channel, outcome, error?}，
 * 最终 result 永远携带完整链（Skyvern 风格，便于排查到底走了哪些 channel）。
 *
 * 不做：长熔断 / 多源扇出 / cross-surface fallback（INV-8 / v0.2+）。
 */
import type { InteractResult } from "../types.js";
import { CircuitBreaker } from "./CircuitBreaker.js";
import { isFallbackWorthy } from "./outcome.js";
import type { BudgetTracker } from "./BudgetTracker.js";

// ============================================================
// 计划 & 执行器
// ============================================================
export interface FallbackPlan {
  primary: string;
  /** 顺序遍历的 fallback channel 列表（不含 primary）。 */
  fallbacks: string[];
  /**
   * 是否跨模态：search→browse_headless = true；browse_headless→browse_logged_in = false。
   * v0.1 仅用于日志 / 报表；v0.4+ 跨 surface 时此字段会被 INV-8 校验拦截。
   */
  cross_modal: boolean;
}

/** 单个 channel 的执行回调，返回 InteractResult。允许抛异常。 */
export type ChannelExecutor<T> = (
  channelName: string,
) => Promise<InteractResult<T>>;

// ============================================================
// FallbackDecider
// ============================================================
export class FallbackDecider {
  constructor(
    /** channel 名 → breaker。缺失视为无熔断（always allow）。 */
    private readonly breakers: Map<string, CircuitBreaker>,
  ) {}

  /**
   * 单一 fallback 引擎入口。
   *
   * 同一 plan 内，从 primary 开始遍历 [primary, ...fallbacks]：
   *  - 熔断中（breaker.allow()=false）→ 跳过，记 error=circuit_open
   *  - executor 返回 / 抛异常 → 按上面语义处理
   * 所有 channel 耗尽仍无 worked/didnt → 返回 outcome=didnt,
   * retrieval_method="fallback_exhausted"。
   *
   * v0.3（parse3 §3.7）：可选第 3 参 budget 用于跨 channel 聚合 partial_failures。
   *  - 每次 fallback 尝试 outcome≠worked 时 recordPartial() 入 budget
   *  - plan 跑完 flushInto() 透传到最终 InteractResult.partial_failures
   *  - budget=null（缺省）→ 完全等价 v0.2 行为（兼容承诺：349 tests 不改 1 行）
   */
  async runWithFallback<T>(
    plan: FallbackPlan,
    executor: ChannelExecutor<T>,
    budget?: BudgetTracker | null,
  ): Promise<InteractResult<T>> {
    const chain = [plan.primary, ...plan.fallbacks];
    const actions_and_results: NonNullable<
      InteractResult<T>["actions_and_results"]
    > = [];

    for (let i = 0; i < chain.length; i++) {
      const channelName = chain[i];
      const breaker = this.breakers.get(channelName);

      if (breaker && !breaker.allow()) {
        actions_and_results.push({
          channel: channelName,
          outcome: "error",
          error: "circuit_open",
        });
        budget?.recordPartial({
          channel: channelName,
          error: "circuit_open",
        });
        continue;
      }

      let result: InteractResult<T> | null = null;
      let thrownError: string | null = null;

      try {
        result = await executor(channelName);
      } catch (e) {
        // 优先取 .message（Error 实例），否则降级 String(e)（保留原信息）
        thrownError =
          e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
      }

      // ---- executor 抛异常：视为 unknown + recordFailure ----
      if (thrownError !== null) {
        breaker?.recordFailure();
        actions_and_results.push({
          channel: channelName,
          outcome: "error",
          error: thrownError,
        });
        budget?.recordPartial({ channel: channelName, error: thrownError });
        if (!isFallbackWorthy("unknown", thrownError)) {
          // 明确的"否"信号被抛出（如 NEEDS_MANUAL_2FA）——终止链
          const terminal: InteractResult<T> = {
            outcome: "didnt",
            data: null,
            served_by: channelName,
            fallback_used: i > 0,
            retrieval_method: "error",
            error: thrownError,
            actions_and_results,
          };
          return budget ? budget.flushInto(terminal) : terminal;
        }
        continue;
      }

      // ---- executor 正常返回 ----
      const r = result!;
      actions_and_results.push({
        channel: channelName,
        outcome: r.outcome,
        error: r.error,
      });
      if (r.outcome !== "worked") {
        budget?.recordPartial({
          channel: channelName,
          error: r.error ?? r.outcome,
        });
      }

      if (r.outcome === "worked") {
        breaker?.recordSuccess();
        const terminal: InteractResult<T> = {
          ...r,
          fallback_used: i > 0,
          actions_and_results,
        };
        return budget ? budget.flushInto(terminal) : terminal;
      }

      if (r.outcome === "didnt") {
        // channel 自己工作正常，只是 negative answer
        breaker?.recordSuccess();
        const terminal: InteractResult<T> = {
          ...r,
          fallback_used: i > 0,
          actions_and_results,
        };
        return budget ? budget.flushInto(terminal) : terminal;
      }

      // outcome === "unknown"
      breaker?.recordFailure();
      if (!isFallbackWorthy(r.outcome, r.error)) {
        // unknown 但明确"不该 fallback"（2FA / 404 / 403 / NXDOMAIN 被误报成 unknown）
        const terminal: InteractResult<T> = {
          ...r,
          fallback_used: i > 0,
          actions_and_results,
        };
        return budget ? budget.flushInto(terminal) : terminal;
      }
      // 否则 continue 试下一个 channel
    }

    // 所有 channel 耗尽 / 全部熔断：返回 didnt + fallback_exhausted
    const lastChannel = chain[chain.length - 1] ?? plan.primary;
    const exhausted: InteractResult<T> = {
      outcome: "didnt",
      data: null,
      served_by: lastChannel,
      fallback_used: chain.length > 1,
      retrieval_method: "fallback_exhausted",
      error: "all_channels_failed_or_skipped",
      actions_and_results,
    };
    return budget ? budget.flushInto(exhausted) : exhausted;
  }
}

// ============================================================
// 便于外部（如 doctor / unit test）直接复用同一套判定
// ============================================================
export { isFallbackWorthy } from "./outcome.js";
