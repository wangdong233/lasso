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
import { LongCircuitBreaker } from "./LongCircuitBreaker.js";
import { isFallbackWorthy } from "./outcome.js";
import type { BudgetTracker } from "./BudgetTracker.js";
import type { PolicyGate } from "./PolicyGate.js";
import type { MetricsCollector } from "../observ/MetricsCollector.js";

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
    /**
     * v0.4（parse5 §3.4.2）：可选 PolicyGate 前置注入。
     *
     *  - 未注入（undefined / null）→ runWithFallback 行为完全等价 v0.3.5（零回归承诺）
     *  - 注入                     → chain 中每个 channel 先经 PolicyGate.check；
     *                              policy_blocked 的 channel 被剔除；全部被剔除 →
     *                              outcome="didnt" + retrieval_method="policy_blocked"
     *
     * 构造期注入（装配时由 index.ts 决定是否启用政策 gate）；
     * 单例共享给所有调用方（search / browse / desktop / interact_*）。
     */
    private readonly policyGate?: PolicyGate | null,
    /**
     * v0.7（parse8 §3.1）：可选长熔断 Map（与 breakers 同 key，独立状态机）。
     *
     *  - 未注入（undefined / null）→ runWithFallback 行为完全等价 v0.6（零回归承诺）
     *  - 注入                     → 主循环双 breaker 串联检查（短先长后）；
     *                              任一 open 都跳过当次 + 记 circuit_open / long_circuit_open
     *
     * 与短熔断独立：短熔断 3 次连续失败 open 60s（瞬时毛刺）；
     *               长熔断 1h 内 10 次 open 60min（持续故障 / 月配额耗尽）。
     *
     * INV-42（parse8 §5.3）：长熔断 open 经 onOpen 回调（由 index.ts 装配调 bag.disable）。
     *
     * 非 readonly —— late-binding 支持（见 attachLongBreakers setter）：bag 在装配段后期
     * 构造，onOpen 闭包需 bag 引用 → longBreakers 必然在 bag 之后构造 → setter 注入。
     */
    private longBreakers?: Map<string, LongCircuitBreaker> | null,
    /**
     * v0.7（parse8 §3.2）：可选 MetricsCollector 注入。
     *
     *  - 未注入（undefined / null）→ runWithFallback 行为完全等价 v0.6（零回归承诺）
     *  - 注入                     → 主路径终端分支（worked/didnt/unknown/error）调
     *                              metrics.record(channelName, outcome, latencyMs)
     *
     * INV-44（parse8 §5.3）：record 必带 channel 名（per-channel 维度）。
     *
     * 非 readonly —— late-binding（见 attachMetrics setter）；与 longBreakers 同范式。
     */
    private metrics?: MetricsCollector | null,
  ) {}

  /**
   * v0.7：late-binding setter —— 当装配层无法在构造期注入 longBreakers 时使用。
   *
   * 设计（parse8 §3.1 装配边界）：
   *  - bag 在 index.ts 装配段后期构造（晚于 decider）
   *  - longBreakers 的 onOpen 需要 bag.disable 句柄 → 必然在 bag 之后构造
   *  - 提供 setter 让装配层两阶段注入（构造期 + 装配后期），避免重构 200+ 行装配顺序
   *
   * 不允许覆盖已有 longBreakers（防误改运行时状态）。
   */
  attachLongBreakers(longBreakers: Map<string, LongCircuitBreaker>): void {
    if (this.longBreakers) {
      throw new Error("FallbackDecider.longBreakers already set");
    }
    this.longBreakers = longBreakers;
  }

  /**
   * v0.7：late-binding setter —— MetricsCollector 同 longBreakers 范式。
   *
   * 设计：装配层（index.ts）在 metrics 实例化后挂回 decider。
   * 不允许覆盖已有 metrics。
   */
  attachMetrics(metrics: MetricsCollector): void {
    if (this.metrics) {
      throw new Error("FallbackDecider.metrics already set");
    }
    this.metrics = metrics;
  }

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
    const originalChain = [plan.primary, ...plan.fallbacks];
    const actions_and_results: NonNullable<
      InteractResult<T>["actions_and_results"]
    > = [];

    // ====================================================
    // v0.4 前置（parse5 §3.4.2）：PolicyGate 可选注入
    //  - 未注入 → chain 完全等价 v0.3.5 [plan.primary, ...plan.fallbacks]
    //  - 注入   → 每个 channel 先 PolicyGate.check，policy_blocked 的被剔除
    //            全部被剔除 → 立即返回 outcome=didnt + retrieval_method=policy_blocked
    //            部分剔除  → 剩余 chain 继续走既有 fallback 路径（零行为差异）
    // ====================================================
    let chain = originalChain;
    /**
     * 是否有 channel 在 PolicyGate 前置过滤中被剔除。
     * 用于计算 fallback_used：当原 primary 被 policy block，后续 chain 即使是
     * 第 0 项，语义上也确实 fallback 了（policy_blocked 等价于"primary 不可用"）。
     */
    let anyPolicyBlocked = false;
    if (this.policyGate) {
      const allowed: string[] = [];
      for (const ch of originalChain) {
        const verdict = this.policyGate.check(ch);
        if (verdict.allowed) {
          allowed.push(ch);
        } else {
          // policy_blocked channel 记入审计链（不调 breaker；不是 channel 故障）
          anyPolicyBlocked = true;
          actions_and_results.push({
            channel: ch,
            outcome: "error",
            error: `policy_blocked:${verdict.reason ?? "unknown"}`,
          });
        }
      }
      if (allowed.length === 0) {
        // 全部 channel 被 policy gate 阻断 → 返回 policy_blocked outcome
        const blocked: InteractResult<T> = {
          outcome: "didnt",
          data: null,
          served_by: plan.primary,
          fallback_used: false,
          retrieval_method: "policy_blocked",
          error: "all_channels_policy_blocked",
          actions_and_results,
        };
        return budget ? budget.flushInto(blocked) : blocked;
      }
      chain = allowed;
    }

    for (let i = 0; i < chain.length; i++) {
      const channelName = chain[i];
      /**
       * v0.4：fallback_used 计算纳入 policy_blocked 维度。
       *  - i > 0              → 走到 chain 第二项及以后（v0.3.5 语义）
       *  - anyPolicyBlocked   → 原始 chain 的某些 channel 被 policy gate 剔除（v0.4 新增）
       * 任一为 true → 确实 fallback 了（非原始 primary 直接服务）。
       */
      const usedFallback = i > 0 || anyPolicyBlocked;
      const breaker = this.breakers.get(channelName);
      const longBreaker = this.longBreakers?.get(channelName);

      // ====================================================
      // v0.7 双 breaker 串联检查（parse8 §3.1）
      //  - 短先：breaker.allow() = false → 跳过当次（瞬时毛刺）
      //  - 长后：longBreaker.allow() = false → 跳过 + 联动 bag.disable（持续故障）
      //  - 未注入 longBreakers（null）→ longB 永远 undefined → 行为等价 v0.6
      // ====================================================
      if ((breaker && !breaker.allow()) || (longBreaker && !longBreaker.allow())) {
        const error = longBreaker && !longBreaker.allow()
          ? "long_circuit_open"
          : "circuit_open";
        actions_and_results.push({
          channel: channelName,
          outcome: "error",
          error,
        });
        budget?.recordPartial({
          channel: channelName,
          error,
        });
        // v0.7：熔断跳过也记 metrics（admin / doctor 可见 channel 被熔断的频次）
        this.metrics?.record(channelName, "error", 0);
        continue;
      }

      // v0.7：记录每次尝试的开始时间（metrics latency 用）
      const attemptStart = Date.now();

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
        // v0.7：长熔断也记失败（可能触发 open → bag.disable）；await 保证 onOpen 完成
        await longBreaker?.recordFailure();
        // v0.7：metrics 记一次失败
        this.metrics?.record(channelName, "error", Date.now() - attemptStart);
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
            fallback_used: usedFallback,
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
      // v0.7：metrics 记录（所有 outcome 都入窗，区分 success/failure 由 outcome 字段决定）
      this.metrics?.record(channelName, r.outcome, Date.now() - attemptStart);
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
        longBreaker?.recordSuccess();
        const terminal: InteractResult<T> = {
          ...r,
          fallback_used: usedFallback,
          actions_and_results,
        };
        return budget ? budget.flushInto(terminal) : terminal;
      }

      if (r.outcome === "didnt") {
        // channel 自己工作正常，只是 negative answer
        breaker?.recordSuccess();
        longBreaker?.recordSuccess();
        const terminal: InteractResult<T> = {
          ...r,
          fallback_used: usedFallback,
          actions_and_results,
        };
        return budget ? budget.flushInto(terminal) : terminal;
      }

      // outcome === "unknown"
      breaker?.recordFailure();
      await longBreaker?.recordFailure();
      if (!isFallbackWorthy(r.outcome, r.error)) {
        // unknown 但明确"不该 fallback"（2FA / 404 / 403 / NXDOMAIN 被误报成 unknown）
        const terminal: InteractResult<T> = {
          ...r,
          fallback_used: usedFallback,
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
      fallback_used: chain.length > 1 || anyPolicyBlocked,
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
