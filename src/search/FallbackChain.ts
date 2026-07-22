/**
 * FallbackChain —— 三层 search fallback 的 plan 构造器（parse10 §3.2 v0.9 Phase A）。
 *
 * **关键设计决策（parse10 §1 决策 2 + INV-55）**：
 *  本模块是 **plan 构造器**，**不是第二套串行 fallback 引擎**。
 *  仍走 `FallbackDecider.runWithFallback`（INV-4 单一 fallback 引擎铁律）。
 *
 * 为什么不开第二套引擎（守 02 §5 R-CI-02 / §5.5 R-ABS-01）：
 *  - INV-4 已定下「项目内 FallbackDecider 类定义 ≤1」—— 若 FallbackChain 自造串行循环，
 *    就成了第二套 fallback 范式，与 CircuitBreaker / actions_and_results / BudgetTracker
 *    三套审计链脱节，缠绕而非简化。
 *  - FallbackChain 的职责是「**从 fallback_order 顺序 + availability 过滤** 拼出一个 FallbackPlan」，
 *    然后交给 FallbackDecider 执行。等于在 search 主路径之上加一层 plan-shaping helper。
 *
 * 接口：
 *  - buildFallbackPlan(channelNames, opts?) → FallbackPlan：纯函数 plan 构造器。
 *    取 channelNames 中第一个 isAvailable 的作 primary；其余作 fallbacks（保序）。
 *    若 caller 不传 availabilityPredicate，退化为「全部当可用，按 fallback_order 拼 plan」
 *    （让 FallbackDecider 内部熔断器 / PolicyGate 负责剔除）。
 *  - runFallbackChain(decider, channelNames, executor, opts?) → Promise<InteractResult<T>>：
 *    构造 plan 后直调 decider.runWithFallback（INV-55）。
 *
 * 默认 fallback_order（parse10 §1 决策 6 + parse10 §3.2）：
 *  - ["search.zhipu", "search.brave", "search.bing"]
 *  - key=[] 时 ProviderRegistry 跳过 bing → byCap("search") 不含 bing
 *    → 行为完全等价 v0.8（零回归承诺）。
 *
 * 不替换 fanout 默认（parse10 §1 决策 4）：
 *  - tools/search.ts 中 engine="auto" 默认行为 byte-identical v0.8（zhipu+brave 多源扇出）；
 *  - engine="fallback_chain" 才是显式 opt-in 走本模块；
 *  - 「search ≈永不失败」目标场景：caller 显式 engine="fallback_chain" + 配齐 bing key
 *    时，多一层 Bing 兜底（zhipu 失败 → brave → bing）。
 *
 * 借鉴：FallbackDecider.runWithFallback（plan 形状 + executor + budget 范式）；
 *       MultiSourceFanout（Promise.allSettled 并发 —— 本模块**不并发**，是串行 fallback）。
 */
import type { InteractResult } from "../types.js";
import type {
  ChannelExecutor,
  FallbackPlan,
} from "../fallback/FallbackDecider.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import type { BudgetTracker } from "../fallback/BudgetTracker.js";

/**
 * 默认 fallback_order（parse10 §1 决策 6）。
 * 单独导出便于 index.ts / doctor / 单测引用（不重新 hardcode）。
 *
 * 顺序语义：
 *  - search.zhipu   —— 中文主力（fallback_order=0）
 *  - search.brave   —— 英文/质量层（fallback_order=3）
 *  - search.bing    —— 兜底第三源（fallback_order=4，v0.9 新增）
 */
export const DEFAULT_FALLBACK_ORDER: readonly string[] = [
  "search.zhipu",
  "search.brave",
  "search.bing",
] as const;

/**
 * 构造 plan 时的可选参数。
 */
export interface BuildFallbackPlanOptions {
  /**
   * availabilityPredicate?: (channelName: string) => Promise<boolean> | boolean
   * 用来过滤出「实际可用」的 channel 序列：
   *  - 传入时：取第一个 isAvailable 的作 primary；其余保序作 fallbacks。
   *  - 不传：全部 channelNames 都视为「可尝试」，按顺序拼 plan
   *    （让 FallbackDecider 内部熔断器 / PolicyGate 做实际剔除 —— INV-4 单一 fallback 引擎职责）。
   *
   * 注意：availabilityPredicate 仅做 **plan 形状过滤**，不执行 channel 调用；
   *       实际 channel.search 由 executor 在 runWithFallback 内调。
   */
  availabilityPredicate?: (
    channelName: string,
  ) => Promise<boolean> | boolean;

  /**
   * cross_modal?: 默认 false（fallback 链全在 search surface 内，不跨 surface）。
   * 与 FallbackDecider.FallbackPlan.cross_modal 同语义。
   */
  cross_modal?: boolean;
}

/**
 * 纯函数 plan 构造器（parse10 §3.2 INV-55 守护）。
 *
 * 算法：
 *  1. 若无 availabilityPredicate → primary=channelNames[0], fallbacks=channelNames[1..]
 *     （让 FallbackDecider 内部熔断器 / PolicyGate 做剔除 —— INV-4 单一 fallback 引擎职责）
 *  2. 若有 availabilityPredicate → 顺序遍历，逐个 await predicate；
 *     第一个返 true 的为 primary，其余返 true 的保序作 fallbacks。
 *  3. 若全部 predicate=false → 返 plan {primary: channelNames[0], fallbacks: [], cross_modal}
 *     （让 FallbackDecider 立即落 fallback_exhausted 分支，行为诚实不掩盖失败）。
 *
 * **INV-55 红线**：本函数不调用任何 channel.search / executor；
 *                 它只返数据（FallbackPlan），不执行 fallback 循环。
 */
export async function buildFallbackPlan(
  channelNames: readonly string[],
  opts?: BuildFallbackPlanOptions,
): Promise<FallbackPlan> {
  const crossModal = opts?.cross_modal ?? false;
  const predicate = opts?.availabilityPredicate;

  // 无 predicate → 直拼 plan（保 channelNames 顺序，让 decider 做剔除）
  if (!predicate) {
    if (channelNames.length === 0) {
      // 防御：空输入返空 plan（decider 会落 fallback_exhausted 分支）
      return { primary: "", fallbacks: [], cross_modal: crossModal };
    }
    return {
      primary: channelNames[0],
      fallbacks: channelNames.slice(1),
      cross_modal: crossModal,
    };
  }

  // 有 predicate → 顺序过滤
  const available: string[] = [];
  for (const name of channelNames) {
    const ok = await predicate(name);
    if (ok) available.push(name);
  }

  if (available.length === 0) {
    // 全部不可用 → 返首项 primary + 空 fallbacks（让 decider 落 fallback_exhausted）
    // primary 即便不可用也填上（让 decider 内 breaker.allow()=false → continue → exhausted）。
    const fallbackPrimary = channelNames[0] ?? "";
    return { primary: fallbackPrimary, fallbacks: [], cross_modal: crossModal };
  }

  return {
    primary: available[0],
    fallbacks: available.slice(1),
    cross_modal: crossModal,
  };
}

/**
 * 三层 fallback 编排入口（parse10 §3.2 + INV-55 守护）。
 *
 * 流程：
 *  1. buildFallbackPlan 构造 plan（按 fallback_order + availabilityPredicate 过滤）
 *  2. decider.runWithFallback(plan, executor, budget) —— **单一 fallback 引擎**（INV-4 / INV-55）
 *
 * 不开第二套串行 fallback 引擎：本函数体内**禁止** for/while 循环调 executor；
 * 只调 decider.runWithFallback 一次（INV-55 grep 断言）。
 *
 * @param decider        FallbackDecider 单例（INV-4 单一 fallback 引擎）
 * @param channelNames   fallback_order 顺序（默认 DEFAULT_FALLBACK_ORDER）
 * @param executor       channel 名 → InteractResult 的执行回调（由 decider 在 plan 路径上调）
 * @param opts           可选 availabilityPredicate + cross_modal
 * @param budget         可选 BudgetTracker（聚合 partial_failures，与 runWithFallback 第 3 参同源）
 */
export async function runFallbackChain<T>(
  decider: FallbackDecider,
  channelNames: readonly string[],
  executor: ChannelExecutor<T>,
  opts?: BuildFallbackPlanOptions,
  budget?: BudgetTracker | null,
): Promise<InteractResult<T>> {
  // INV-55 红线：调 decider.runWithFallback 一次 —— 不自造串行 fallback 循环。
  const plan = await buildFallbackPlan(channelNames, opts);
  return decider.runWithFallback<T>(plan, executor, budget);
}
