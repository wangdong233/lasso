/**
 * SERP selectors（parse1 §3.13 + 08 §3.8 F3.8.1-8）
 *
 * 百度 / Google 搜索结果页的 selector 级联（主 → 备）。
 * open-webSearch 风格：每条 selector 集包含 result_container / title / link / snippet
 * 四件套；命中失败时按顺序降级到下一条。
 *
 * 设计注记（10 §D.1）：**SERP 是债不是资产**——主路径走结构化 API（智谱），
 * 这里只是 search → browse_headless 跨模态 fallback 时的兜底抽链接。
 * v0.7 会加改版检测；v0.1 用宽松正则保底（见 extract.ts）。
 *
 * 借鉴：open-webSearch selector 级联风格；08 §3.8。
 */

export type SerpEngine = "baidu" | "google";

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
// Google
// ============================================================
export const GOOGLE_SELECTORS: SerpSelectorSet[] = [
  {
    engine: "google",
    result_container: "div.g",
    title: "h3",
    link: "div.yuRUbf a",
    snippet: "div.VwiC3b",
  },
  {
    engine: "google",
    result_container: "div.tF2Cxc",
    title: "h3",
    link: "a",
    snippet: "div.VwiC3b",
  },
];

// ============================================================
// 工具
// ============================================================
/**
 * 选引擎对应的 selector 集（按优先级）。
 * 默认走 baidu（fake-ip / 国内网络更稳，且与 parse1 §3.13 主路径一致）。
 */
export function selectorsFor(engine: SerpEngine = "baidu"): SerpSelectorSet[] {
  return engine === "google" ? GOOGLE_SELECTORS : BAIDU_SELECTORS;
}
