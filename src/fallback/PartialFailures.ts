/**
 * PartialFailures —— 多源扇出 partial_failures 聚合（parse2 §3.6.1 / F3.9.7）。
 *
 * 场景：多源扇出时，zhipu worked 但 brave 429；总 outcome=worked（用户拿到结果），
 * 但要诚实记录"哪些源失败了"，便于 doctor / 告警 / 排查。
 *
 * 透传路径（parse2 §3.6.1）：
 *   per-source result[] → aggregatePartialFailures() → PartialFailure[]
 *   → InteractResult.partial_failures（types.ts 已声明，可选字段）
 *   → tools/search.ts 透传到 MCP 返回
 *
 * 与 MultiSourceFanout.fanOutSearch 的关系：
 *   fanOutSearch 内部已做 Promise.allSettled 聚合，自带 partial_failures；
 *   aggregatePartialFailures 是独立的纯函数，给非 fanOut 路径（如 doctor 诊断、
 *   自定义多源 plan、未来 CrossSurface 扩展）复用同样的聚合逻辑。
 *
 * 简单性铁律（01）：本模块是纯函数，无新状态，无副作用；时间戳由 caller 决定
 *   （默认 Date.now()，可注入便于测试）。
 *
 * 借鉴：parse2 §3.6.1；08 §3.9 F3.9.7（partial_failures 诚实透传）。
 */
import type { Outcome, PartialFailure } from "../types.js";

// ============================================================
// 输入类型
// ============================================================
/**
 * 单源结果输入（聚合的 minimal 形状）。
 * 与 InteractResult 兼容（只要 outcome + 可选 channel / error / partial_count）。
 */
export interface PerSourceResult {
  /** channel 全名（如 "search.zhipu" / "search.brave"）。 */
  channel: string;
  /** 该源的 outcome。 */
  outcome: Outcome;
  /** 错误信息（outcome !== "worked" 时透传）。 */
  error?: string;
  /**
   * 部分成功：该 channel 返回了部分结果（< limit），但 outcome=worked。
   * v0.2 范围：本函数对 worked 一律不算 partial_failure；partial_count 留作 v0.3 升级
   * （届时 worked 但 partial_count < limit 也会记入 partial_failures）。
   */
  partial_count?: number;
}

// ============================================================
// aggregatePartialFailures
// ============================================================
/**
 * 把 per-source 结果列表聚合为 partial_failures 数组（F3.9.7）。
 *
 * 规则：
 *  - outcome === "worked" → 不计入 partial_failures（无论 partial_count 多少，v0.2 简化）
 *  - outcome !== "worked"（unknown / didnt） → 计入，error = error ?? outcome
 *  - timestamp = now（参数化：now 可注入，便于测试断言确定性）
 *
 * @param perSource 各源的 minimal 结果
 * @param now       可选，时间戳注入（测试用；默认 Date.now()）
 * @returns         PartialFailure[]（可能为空数组）
 */
export function aggregatePartialFailures(
  perSource: readonly PerSourceResult[],
  now: number = Date.now(),
): PartialFailure[] {
  return perSource
    .filter((p) => p.outcome !== "worked")
    .map((p) => ({
      channel: p.channel,
      error: p.error ?? p.outcome,
      timestamp: now,
    }));
}

/**
 * 判定 InteractResult 是否携带 partial_failures（doctor / 告警用）。
 * v0.2 简化：truthy + length > 0。
 */
export function hasPartialFailures(
  r: { partial_failures?: PartialFailure[] },
): boolean {
  return Array.isArray(r.partial_failures) && r.partial_failures.length > 0;
}

/**
 * 统计 partial_failures 涉及的唯一 channel 数（doctor 报告用）。
 */
export function countFailedChannels(
  failures: readonly PartialFailure[],
): number {
  const set = new Set<string>();
  for (const f of failures) set.add(f.channel);
  return set.size;
}
