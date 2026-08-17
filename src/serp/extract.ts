/**
 * SERP 兜底抽取（parse1 §3.13 + 10 §D.1；v1.11 round1 T9 双引擎分流；v1.14 S-4 非 CJK 双引擎级联）
 *
 * search → browse_headless 的跨模态 fallback 路径（parse1 §4.4 fallback 链）：
 *  1. 智谱限流 / 空结果 → outcome=unknown → FallbackDecider 升 browse_headless
 *  2. 本模块用 browse_headless 实搜（v1.11 T9 按 query 语言分流）：
 *     - CJK query    → 百度（GET https://www.baidu.com/s?wd=...&rn=...）
 *     - 非 CJK query → DuckDuckGo（GET https://html.duckduckgo.com/html/?q=...
 *       纯 HTML 端点；社区共识零 Key 兜底——firecrawl/open-webSearch 同选）
 *  3. 从快照文本里抽链接 + 标题（v0.1 简化版：正则抽 URL，selector 级联 v0.7 加）
 *
 * v1.14（21-搜索方案重审 S-4）：非 CJK 双引擎级联。
 *  - 白盒证据：DDG html/lite 端点 2026-08-17 两次实测持续 202 挑战（IP 级 flag）；
 *    search.brave.com SERP 同日两次不同 query 实测 200 各 ~20 条结果
 *    （open-webSearch 生产级先例：axios+cheerio 抓 #results .snippet）。
 *  - 级联判据：ddg `outcome !== "worked" || data.count === 0`（202 挑战页 /
 *    改版 / 空结果都落入）→ 用 brave URL 再调一次 browseExec；brave 有结果 →
 *    返 brave 结果；brave 也无 → **原样返回 ddg 结果**（失败语义与级联前完全一致）。
 *  - CJK 路径（百度）不动。
 *  - 红线守护：级联在本函数内部、单一 bail-out 重试一次，非新 FallbackDecider
 *    （INV-4 单一 fallback 引擎不受触；INV-55 断言域在 FallbackChain.ts 不涉 serp）；
 *    仅在兜底层生效（主路径智谱/Brave API 不变）——「SERP 是债不是资产」立场不变。
 *
 * **不绕过 BaseChannel 不变量 INV-2**：本模块不直接调 chrome-devtools-mcp，
 * 而是接受一个注入的 browseExec（HeadlessChannel.browse 的 thin wrapper），
 * 由 tools/search.ts 在注册时拼好。这样 serp 模块对 channel 无硬依赖，单测可注入 mock。
 *
 * 借鉴：08 §3.8 F3.8.1-8（百度/Google selector + 级联）；
 * open-webSearch selector 级联风格 + brave SERP 引擎范式；10 §D.1「SERP 是债不是资产」。
 */
import type { InteractResult, Outcome, SearchResult } from "../types.js";
import type { SerpEngine } from "./selectors.js";
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
/**
 * v1.11（round1 T9）：query 是否含 CJK 字符（与 MultiSourceFanout.allocateLimit
 * 同款正则——CJK 启发式双处一致，语言判定不漂移）。
 */
const CJK_RE = /[一-鿿぀-ヿ가-힯]/;

/**
 * v1.11（round1 T9）：按 query 语言选 SERP 引擎。
 *  - CJK    → "baidu"（百度；现状保留）
 *  - 非 CJK → "ddg"（DuckDuckGo html 端点；修复「英文 query 落百度」缺位）
 */
export function serpEngineForQuery(query: string): "baidu" | "ddg" {
  return CJK_RE.test(query) ? "baidu" : "ddg";
}

/**
 * freshness → DDG `df=` 值（html.duckduckgo.com 原生参数；三方文档一致）。
 * baidu 无对应参数不拼（诚实降级——round2 T2-5）。
 */
const DDG_FRESHNESS_DF: Record<string, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

/** 引擎 → SERP URL 构造。 */
export function serpUrlFor(
  engine: SerpEngine,
  query: string,
  limit: number,
  /**
   * v1.12（round2 T2-5）：可选时效过滤。ddg 分支拼原生 `&df=`（d/w/m/y）；
   * baidu 无对应参数不拼（诚实降级）。不传 = v1.11 URL byte-identical。
   * v1.14（S-4）：brave 分支同 baidu——freshness 无原生参数不拼（诚实降级，
   * 不猜私有参数）。
   */
  freshness?: "day" | "week" | "month" | "year",
): string {
  if (engine === "ddg") {
    // html.duckduckgo.com 纯 HTML 端点（无 JS 也能渲染；browse_headless 渲染后同款快照正则抽取）
    const df = freshness ? DDG_FRESHNESS_DF[freshness] : undefined;
    return (
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` +
      (df ? `&df=${df}` : "")
    );
  }
  if (engine === "brave") {
    // v1.14 S-4：search.brave.com SERP（SvelteKit SSR 渲染；a11y 快照正则天然兼容）。
    // 2026-08-17 两次实测 200 各 ~20 条（DDG html 同日持续 202 挑战）。
    return `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  }
  return `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${limit}`;
}

/** 引擎 → retrieval_method 标签（S-4：brave 级联结果显式标 serp_scrape_brave）。 */
const SERP_RETRIEVAL_METHOD: Record<SerpEngine, string> = {
  baidu: "serp_scrape_baidu",
  ddg: "serp_scrape_ddg",
  brave: "serp_scrape_brave",
};

/**
 * 单引擎一次实搜 + 抽取（v1.14 S-4 从 serpScrapeFallback 抽出，级联复用）。
 * 行为与 v1.13 的 serpScrapeFallback 主体逐分支一致（零语义漂移）。
 */
async function scrapeEngineOnce(
  engine: SerpEngine,
  query: string,
  limit: number,
  browseExec: BrowseExec,
  serpHealth: SerpHealthMonitor | null | undefined,
  freshness: "day" | "week" | "month" | "year" | undefined,
): Promise<InteractResult<SearchResult>> {
  const serpUrl = serpUrlFor(engine, query, limit, freshness);
  const retrievalMethod = SERP_RETRIEVAL_METHOD[engine];

  const browseResult = await browseExec(serpUrl);

  if (browseResult.outcome !== "worked") {
    return {
      outcome: browseResult.outcome,
      data: null,
      served_by: "browse_headless",
      fallback_used: true,
      retrieval_method: retrievalMethod,
      error: browseResult.error ?? "serp_scrape_failed",
    };
  }

  const preview = browseResult.data?.preview ?? "";
  if (!preview) {
    // v0.7：preview 空 = miss（抽取 0 条）；通知 serpHealth（注入时）
    serpHealth?.onResult(engine, "v1", query, "", false);
    return {
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: true,
      retrieval_method: retrievalMethod,
      error: "serp_scrape_empty_preview",
    };
  }

  const data = extractResultsFromSnapshot(preview, query);
  // v1.14 S-4：brave 级联结果显式标 engine/region（extract 默认按 CJK 判
  // ddg_serp——brave 尝试必须覆盖，字段不许撒谎）
  if (engine === "brave") {
    data.engine = "brave_serp";
    data.region = "us";
  }
  // v0.7：按命中数通知 serpHealth（count > 0 = hit；否则 miss）
  serpHealth?.onResult(engine, "v1", query, preview, data.count > 0);

  return {
    outcome: "worked",
    data,
    served_by: "browse_headless",
    fallback_used: true,
    retrieval_method: retrievalMethod,
  };
}

export async function serpScrapeFallback(
  query: string,
  limit: number,
  browseExec: BrowseExec,
  serpHealth?: SerpHealthMonitor | null,
  /**
   * v1.12（round2 T2-5）：可选时效过滤（兜底路径此前静默丢显式参数）。
   * 不传 = v1.11 行为（URL 不拼 df=）。
   */
  freshness?: "day" | "week" | "month" | "year",
): Promise<InteractResult<SearchResult>> {
  // v1.11（round1 T9）：CJK/非 CJK 分流（百度 / DDG）
  const engine = serpEngineForQuery(query);

  // CJK 路径（百度）不动（S-4 红线）
  if (engine === "baidu") {
    return scrapeEngineOnce("baidu", query, limit, browseExec, serpHealth, freshness);
  }

  // ---------- 非 CJK：DDG → 失败/0 结果时 Brave 一次级联（v1.14 S-4） ----------
  const ddgResult = await scrapeEngineOnce("ddg", query, limit, browseExec, serpHealth, freshness);

  // 级联判据：outcome 非 worked（含 202 挑战页→unknown / didnt）或 0 结果
  const ddgEmpty =
    ddgResult.outcome !== "worked" || (ddgResult.data?.count ?? 0) === 0;
  if (!ddgEmpty) {
    return ddgResult; // 默认行为 byte-identical（ddg 成功 → 不级联）
  }

  const braveResult = await scrapeEngineOnce("brave", query, limit, browseExec, serpHealth, freshness);
  const braveHasResults =
    braveResult.outcome === "worked" && (braveResult.data?.count ?? 0) > 0;
  // brave 也无 → 原样返回 ddg 结果（失败语义与级联前完全一致，单一 bail-out）
  return braveHasResults ? braveResult : ddgResult;
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
// v1.11 T9：+ duckduckgo（ddg 路径自家 /l/?uddg= 跳转链与 y.js 占位链）
// v1.14 S-4：+ search.brave（brave 级联路径自家 search.brave.com 链）
const SELF_HOST_RE =
  /^(https?:\/\/)?(www\.)?(baidu|google|m\.baidu|duckduckgo|search\.brave)\.(com|cn|ca)\//i;
// 用户查询词本身防止回显成「结果」
function isSelfLink(url: string, _query: string): boolean {
  return SELF_HOST_RE.test(url);
}

/**
 * v1.11（round1 T9）：DDG 结果链接解包。
 * html.duckduckgo.com 的结果链接是跳转壳 `https://duckduckgo.com/l/?uddg=<urlencoded>&rut=...`；
 * 解 uddg 参数还原真实目标 URL（a11y 快照文本里保留的是 href 字面量）。
 */
export function unwrapDdgRedirect(url: string): string {
  const m = url.match(/[?&]uddg=([^&\s]+)/);
  if (!m) return url;
  try {
    const decoded = decodeURIComponent(m[1]!);
    return /^https?:\/\//.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

export function extractResultsFromSnapshot(
  snapshotText: string,
  query: string,
): SearchResult {
  const matches = snapshotText.match(URL_RE) ?? [];
  const deduped = new Set<string>();
  const results: SearchResult["results"] = [];

  for (const rawUrl of matches) {
    // v1.11 T9：DDG 跳转壳先解包（非 DDG 链接原样返回）
    const unwrapped = unwrapDdgRedirect(rawUrl);
    const url = unwrapped.replace(/[.,;:)\]!]+$/, ""); // 去尾标点
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
    // v1.11 T9：引擎名/region 按 query 语言标（CJK=baidu_serp/cn；非CJK=ddg_serp/us——
    // review03 F5：英文 query 走 DDG 却回显 region=cn 是字段撒谎）
    engine: CJK_RE.test(query) ? "baidu_serp" : "ddg_serp",
    region: CJK_RE.test(query) ? "cn" : "us",
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
