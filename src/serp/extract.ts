/**
 * SERP 兜底抽取（parse1 §3.13 + 10 §D.1）
 *
 * search → browse_headless 的跨模态 fallback 路径（parse1 §4.4 fallback 链）：
 *  1. 智谱限流 / 空结果 → outcome=unknown → FallbackDecider 升 browse_headless
 *  2. 本模块用 browse_headless 实搜百度（GET https://www.baidu.com/s?wd=...&rn=...）
 *  3. 从快照文本里抽链接 + 标题（v0.1 简化版：正则抽 URL，selector 级联 v0.7 加）
 *
 * **不绕过 BaseChannel 不变量 INV-2**：本模块不直接调 chrome-devtools-mcp，
 * 而是接受一个注入的 browseExec（HeadlessChannel.browse 的 thin wrapper），
 * 由 tools/search.ts 在注册时拼好。这样 serp 模块对 channel 无硬依赖，单测可注入 mock。
 *
 * 借鉴：08 §3.8 F3.8.1-8（百度/Google selector + 级联）；
 * open-webSearch selector 级联风格；10 §D.1「SERP 是债不是资产」。
 */
import type { InteractResult, Outcome, SearchResult } from "../types.js";
import type { SerpHealthMonitor } from "./SerpHealthMonitor.js";

// ============================================================
// 类型
// ============================================================
/**
 * 注入的 browse 执行器——由 tools/search.ts 提供具体实现
 * （通常是 HeadlessChannel.browse(url, "snapshot", {}) 的 wrapper）。
 *
 * 不直接依赖 BrowseChannel 类型，避免 serp → channels 的循环依赖。
 */
export type BrowseExec = (
  url: string,
) => Promise<{ outcome: Outcome; data: { preview?: string } | null; error?: string }>;

// ============================================================
// 主入口
// ============================================================
/**
 * serpScrapeFallback：用注入的 browse 执行器搜百度，从快照文本抽结果。
 *
 *  - browseExec 返回 worked + preview 非空 → 抽链接，回 outcome=worked
 *  - browseExec 返回 worked 但 preview 空 → outcome=unknown（让外层 fallback_decider
 *    走完链，最终记录 fallback_exhausted）
 *  - browseExec 返回 didnt/unknown → 透传给上游
 *
 * v0.7（parse8 §3.4）：可选第 4 参 serpHealth 注入：
 *  - 未注入（null / undefined）→ 行为完全等价 v0.6（零回归）
 *  - 注入                     → worked 分支末尾按命中数调 onResult
 *                              （>0 结果 = hit；0 结果 = miss；触发 HitRateStats 告警链）
 */
export async function serpScrapeFallback(
  query: string,
  limit: number,
  browseExec: BrowseExec,
  serpHealth?: SerpHealthMonitor | null,
): Promise<InteractResult<SearchResult>> {
  const serpUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${limit}`;

  const browseResult = await browseExec(serpUrl);

  if (browseResult.outcome !== "worked") {
    return {
      outcome: browseResult.outcome,
      data: null,
      served_by: "browse_headless",
      fallback_used: true,
      retrieval_method: "serp_scrape_baidu",
      error: browseResult.error ?? "serp_scrape_failed",
    };
  }

  const preview = browseResult.data?.preview ?? "";
  if (!preview) {
    // v0.7：preview 空 = miss（抽取 0 条）；通知 serpHealth（注入时）
    serpHealth?.onResult("baidu", "v1", query, "", false);
    return {
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: true,
      retrieval_method: "serp_scrape_baidu",
      error: "serp_scrape_empty_preview",
    };
  }

  const data = extractResultsFromSnapshot(preview, query);
  // v0.7：按命中数通知 serpHealth（count > 0 = hit；否则 miss）
  serpHealth?.onResult("baidu", "v1", query, preview, data.count > 0);

  return {
    outcome: "worked",
    data,
    served_by: "browse_headless",
    fallback_used: true,
    retrieval_method: "serp_scrape_baidu",
  };
}

// ============================================================
// 快照解析
// ============================================================
/**
 * 从 SERP 快照文本抽结果（v0.1 简化版）。
 *
 * chrome-devtools-mcp 的 take_snapshot 返回 a11y 树文本——HTML 标签已剥，
 * 但 URL 会保留为可读字符串（如 "example.com https://example.com/... "）。
 * 所以这里走 URL 正则 + 上下文窗口抓 snippet，不走 DOM selector。
 *
 * v0.7 升级：注入 headlessChannel.browse(url, "evaluate", { js: selector 抽 DOM })
 * 走真正的 selector 级联 + 改版检测（selectors.ts 已就位，等 v0.7 接入）。
 */
const URL_RE = /https?:\/\/[^\s)"'<>一-鿿]+/g;
// 搜索引擎自家链接（跳转页 / 占位）排除
const SELF_HOST_RE =
  /^(https?:\/\/)?(www\.)?(baidu|google|m\.baidu)\.(com|cn)\//i;
// 用户查询词本身防止回显成「结果」
function isSelfLink(url: string, _query: string): boolean {
  return SELF_HOST_RE.test(url);
}

export function extractResultsFromSnapshot(
  snapshotText: string,
  query: string,
): SearchResult {
  const matches = snapshotText.match(URL_RE) ?? [];
  const deduped = new Set<string>();
  const results: SearchResult["results"] = [];

  for (const rawUrl of matches) {
    const url = rawUrl.replace(/[.,;:)\]!]+$/, ""); // 去尾标点
    if (isSelfLink(url, query)) continue;
    if (deduped.has(url)) continue;
    deduped.add(url);

    // snippet：粗略取 URL 前后 80 字符上下文（v0.7 升级到 selector 抽 .c-abstract）
    const idx = snapshotText.indexOf(rawUrl);
    const start = Math.max(0, idx - 80);
    const end = Math.min(snapshotText.length, idx + url.length + 80);
    const snippet = snapshotText
      .slice(start, end)
      .replace(/\s+/g, " ")
      .trim();

    results.push({
      title: extractTitle(url, snapshotText, idx),
      url,
      snippet,
    });
    if (results.length >= 20) break; // 上限保护
  }

  return {
    query,
    results,
    count: results.length,
    engine: "baidu_serp",
    region: "cn",
  };
}

/** 标题：粗取 URL 前一个非空行（SERP a11y 树里通常是 h3 文本）。 */
function extractTitle(
  _url: string,
  text: string,
  urlIdx: number,
): string {
  if (urlIdx < 0) return "";
  const before = text.slice(0, urlIdx);
  const lastLine = before.split("\n").map((s) => s.trim()).filter(Boolean).pop();
  return (lastLine ?? "").slice(-120); // 标题软上限
}
