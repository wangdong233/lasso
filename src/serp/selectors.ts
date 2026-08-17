/**
 * SERP selectors（parse1 §3.13 + 08 §3.8 F3.8.1-8；v1.11 round1 T9 改版）
 *
 * 百度 / DuckDuckGo 搜索结果页的 selector 级联（主 → 备）。
 * open-webSearch 风格：每条 selector 集包含 result_container / title / link / snippet
 * 四件套；命中失败时按顺序降级到下一条。
 *
 * v1.11（round1 T9）：
 *  - Google selector **删除**（死配置清理——grep 零生产调用方，R-INT 卫生；
 *    与 INV-23 全程走 browse_headless 的立场一致，google SERP 从未接线）
 *  - DDG selector 接线：html.duckduckgo.com 纯 HTML 端点是零 Key 英文兜底的
 *    社区共识引擎（firecrawl/open-webSearch 同选）；CJK query 走百度（现状）、
 *    非 CJK query 走 DDG（修复「英文 query 落百度」的免费层英文兜底缺位）
 *
 * v1.14（21-搜索方案重审 S-4）：
 *  - SerpEngine 扩 "brave"：search.brave.com SERP 作为非 CJK 兜底的**第二引擎**
 *    （ddg 失败/0 结果时一次级联）。白盒证据：DDG html/lite 端点 2026-08-17 两次
 *    实测持续 202 挑战（IP 级）；search.brave.com SERP 同日两次实测 200 各 ~20 条。
 *  - BRAVE_SERP_SELECTORS 锚点与 open-webSearch（Aas-ee）src/engines/brave/brave.ts
 *    同款（SvelteKit SSR `#results .snippet`）；当前抽取仍走 a11y 正则（R-7：
 *    selector 集是遗产备胎占位，不为切换）。
 *
 * 设计注记（10 §D.1）：**SERP 是债不是资产**——主路径走结构化 API（智谱），
 * 这里只是 search → browse_headless 跨模态 fallback 时的兜底抽链接。
 * v0.7 会加改版检测；v0.1 用宽松正则保底（见 extract.ts）。
 *
 * 借鉴：open-webSearch selector 级联风格；08 §3.8。
 */

export type SerpEngine = "baidu" | "ddg" | "brave";

export interface SerpSelectorSet {
  engine: SerpEngine;
  /** 单条搜索结果的容器节点（querySelectorAll 入口）。 */
  result_container: string;
  /** 容器内的标题节点（取 textContent）。 */
  title: string;
  /** 容器内的链接节点（取 href）。 */
  link: string;
  /** 容器内的摘要节点（取 textContent）。 */
  snippet: string;
}

// ============================================================
// 百度（open-webSearch 风格主备级联）
// ============================================================
export const BAIDU_SELECTORS: SerpSelectorSet[] = [
  {
    engine: "baidu",
    result_container: "div.c-container",
    title: "h3",
    link: "h3 a",
    snippet: "div.c-abstract",
  },
  {
    engine: "baidu",
    result_container: ".result.c-container",
    title: ".t a",
    link: ".t a",
    snippet: ".c-abstract",
  },
];

// ============================================================
// DuckDuckGo（v1.11 T9：非 CJK query 兜底；html.duckduckgo.com 纯 HTML 端点）
// ============================================================
export const DDG_SELECTORS: SerpSelectorSet[] = [
  {
    engine: "ddg",
    result_container: "div.result",
    title: "a.result__a",
    link: "a.result__a",
    snippet: "a.result__snippet",
  },
  {
    engine: "ddg",
    result_container: "div.web-result",
    title: ".result__title a",
    link: ".result__title a",
    snippet: ".result__snippet",
  },
];

// ============================================================
// Brave SERP（v1.14 S-4：非 CJK 兜底第二引擎；ddg 失败/0 结果时一次级联）
// ============================================================
export const BRAVE_SERP_SELECTORS: SerpSelectorSet[] = [
  {
    engine: "brave",
    result_container: ".snippet",
    title: ".search-snippet-title",
    link: ".result-content > a",
    snippet: ".generic-snippet",
  },
];

// ============================================================
// 工具
// ============================================================
/**
 * 选引擎对应的 selector 集（按优先级）。
 * 默认走 baidu（CJK query / fake-ip 国内网络更稳）；
 * 非 CJK query 由 extract.ts 分流到 ddg（v1.11 T9），
 * ddg 失败时级联 brave（v1.14 S-4）。
 */
export function selectorsFor(engine: SerpEngine = "baidu"): SerpSelectorSet[] {
  if (engine === "ddg") return DDG_SELECTORS;
  if (engine === "brave") return BRAVE_SERP_SELECTORS;
  return BAIDU_SELECTORS;
}
