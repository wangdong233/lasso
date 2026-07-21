/**
 * AttributedSearch —— attributed 后处理（parse2 §3.3.2 / F3.1.8）。
 *
 * 在多源扇出或单源 search 后，把每条结果打上 served_by 标签，让 CC 能看到
 * 「这条来自 search.zhipu / search.brave / browse_headless」。
 *
 * 设计：
 *  - 默认 false（保持 v0.1 SearchResult.results 元素形状：title/url/snippet/source?）
 *  - args.attributed=true 时由 tools/search.ts 调 withAttribution 显式包装
 *  - 不破坏 search cache：cache key 不含 attributed（cache 只看 engine+region+limit），
 *    cache 命中后若 attributed=true 再走一次 withAttribution
 *
 * v0.2 限制（parse2 §3.3.2）：fanout 模式下每条 served_by 是合并字符串
 * "search.zhipu,search.brave"（不区分单条出自哪家）；v0.3 升级 per-item attribution
 * 需把 fanOutSearch 内部 aggregated 暴露到 InteractResult（新增 attributed_results 字段）。
 *
 * 借鉴：parse2 §3.3.2；05 §4.4 DDG 静默空响应 attribution 案例。
 */
import type { AttributedResult, SearchResult } from "../types.js";

/**
 * 给 SearchResult 的每条结果打 served_by + original_rank。
 *
 * @param result   fanout 或单源 search 的 SearchResult
 * @param servedBy 聚合 served_by 字符串（fanout 是 "src1,src2"，单源是 "search.zhipu"）
 *
 * 返回 AttributedResult[]，由 tools/search.ts 写回 result.data.results（cast 突破类型）。
 */
export function withAttribution(
  result: SearchResult,
  servedBy: string,
): AttributedResult[] {
  return result.results.map((r, i) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    ...(r.source !== undefined ? { source: r.source } : {}),
    served_by: servedBy,
    original_rank: i + 1,
  }));
}
