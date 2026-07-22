/**
 * MarkdownExtractor（parse12 §3.1 v1.1 新增）
 *
 * mode-aware HTML→markdown 抽取器。BrowseChannel doExtract + fetch_url doFetchUrl
 * 的内部子组件（INV-67：不是新通道，不 extends BaseChannel，不经 FallbackDecider）。
 *
 * 三档（用户硬约束 parse12 §1.3：raw 默认保 v1.0，markdown opt-in）：
 *  - "raw"            : passthrough（返原始 html 不变；INV-66 守）
 *  - "markdown"       : defuddle 抽正文 HTML → turndown 转 markdown
 *  - "markdown_cited" : markdown + ⟨N⟩ 引用角标（content-filter-cite.ts）
 *
 * 引擎选型（parse12 §4 决策表）：JS 原生 defuddle + turndown，非 Trafilatura Python。
 * 守 INV-68：禁 spawn/exec python；引擎必须是 JS import 可加载。
 *
 * 借鉴源：
 *  - defuddle（MIT，FiveFilters）内容抽取 — 替代 Mozilla Readability（避 jsdom 重依赖）
 *  - turndown v7.2.4（MIT，@mixmark-io/domino 轻量 DOM）HTML→markdown
 *  - Crawl4AI markdown_generation_strategy.py（Apache-2.0，fit_markdown 思路借鉴不 vendored）
 *  - 08 §3.2 BrowseOptions 对象化范式（extract_mode 是 options 字段，非新 action）
 */
// defuddle/node：函数式 API，接受 HTML string（内部自含 DOM 解析；守 INV-68 纯 JS）
import { Defuddle } from "defuddle/node";
import TurndownService from "turndown";
import { applyCitations, type CitationResult } from "./content-filter-cite.js";
import { logger } from "../util/logger.js";

// ============================================================
// 类型
// ============================================================
export type ExtractMode = "raw" | "markdown" | "markdown_cited";

export interface MarkdownExtractOptions {
  mode: ExtractMode;
  /** turndown 配置：heading style（"atx" = # 风格，LLM 友好；默认 "atx"） */
  headingStyle?: "atx" | "setext";
  /** bullet list marker（默认 "-"） */
  bulletMarker?: "-" | "*" | "+";
  /** markdown_cited 档：是否启用 ⟨N⟩ 角标（默认 true；false = 仅 markdown 不加角标） */
  enableCitations?: boolean;
}

export interface MarkdownExtractResult {
  /** 抽取后的 markdown 文本（raw 档 = 原始 html 不变） */
  markdown: string;
  /** defuddle 抽出的页面标题（若有） */
  title?: string;
  /** defuddle 抽出的作者（若有） */
  byline?: string;
  /** defuddle 抽出的摘要（若有） */
  excerpt?: string;
  /** 仅 markdown_cited 档填：去重引用表 */
  citations?: CitationResult[];
  /** 引擎实际服务的 extractor 名（"raw" / "defuddle+turndown" / fallback "turndown-only"） */
  served_by: string;
}

// ============================================================
// 顶级 const（INV-68 衍生：引擎名集中，doctor 读）
// ============================================================
export const MARKDOWN_ENGINE = Object.freeze({
  extractor: "defuddle", // 内容抽取器（替代 Readability，避 jsdom）
  converter: "turndown", // HTML→markdown 转换器
  pipeline: "defuddle+turndown",
});

// ============================================================
// 主 API：extractMarkdown（纯函数，无副作用，可单测）
// ============================================================
/**
 * @param html    原始 HTML 字符串（fetch_url bodyText / browse evaluate_script outerHTML）
 * @param opts    模式 + 配置（mode 必传）
 * @returns       MarkdownExtractResult（markdown + 元数据 + 可选 citations）
 *
 * 失败容忍（守 raw 默认零回归 + 不阻断主路径）：
 *  - mode="raw" → 直接返原始 html（INV-66 passthrough；不经 defuddle/turndown）
 *  - defuddle 抽取失败 → 降级 turndown-only（served_by="turndown-only"，跳过正文抽取直接转全页 HTML）
 *  - turndown 失败 → 抛 Error("[markdown-extractor]") 前缀，调用方 catch 后 outcome=unknown
 */
export async function extractMarkdown(
  html: string,
  opts: MarkdownExtractOptions,
): Promise<MarkdownExtractResult> {
  // ---------- 0. 空输入兜底 ----------
  if (!html || html.length === 0) {
    return { markdown: "", served_by: opts.mode === "raw" ? "raw" : MARKDOWN_ENGINE.pipeline };
  }

  // ---------- 0b. raw 档 passthrough（INV-66：不经 defuddle/turndown） ----------
  if (opts.mode === "raw") {
    return { markdown: html, served_by: "raw" };
  }

  // ---------- 1. defuddle 抽正文 HTML（去导航/广告/样板） ----------
  let articleHtml: string | null = null;
  let title: string | undefined;
  let byline: string | undefined;
  let excerpt: string | undefined;

  try {
    // defuddle/node Defuddle 函数：接 (html_string, url, options) → Promise<DefuddleResponse>
    // url 传空串（defuddle 内部用于相对链接解析；空串容忍）
    const result = await Defuddle(html, "", {});
    if (result && result.content) {
      articleHtml = result.content;
      title = result.title || undefined;
      byline = result.author || undefined;
      excerpt = result.description || undefined;
    }
  } catch (e) {
    // defuddle 失败 → 降级 turndown-only（served_by 标记降级；不阻断）
    logger.warn({ evt: "defuddle_failed", error: String(e).slice(0, 200) });
    articleHtml = null;
  }

  // ---------- 2. turndown HTML→markdown ----------
  const turndown = new TurndownService({
    headingStyle: opts.headingStyle ?? "atx",
    bulletListMarker: opts.bulletMarker ?? "-",
    codeBlockStyle: "fenced",
  });

  const inputHtml = articleHtml ?? html; // defuddle 失败时降级转全页
  const servedBy = articleHtml ? MARKDOWN_ENGINE.pipeline : "turndown-only";

  let markdown: string;
  try {
    markdown = turndown.turndown(inputHtml);
  } catch (e) {
    // turndown 失败 = 引擎彻底挂，抛错让调用方走 outcome=unknown
    throw new Error(`[markdown-extractor] turndown failed: ${String(e).slice(0, 200)}`);
  }

  // ---------- 3. markdown_cited 档：⟨N⟩ 引用角标 ----------
  let citations: CitationResult[] | undefined;
  if (opts.mode === "markdown_cited" && opts.enableCitations !== false) {
    const cited = applyCitations(markdown);
    markdown = cited.markdown;
    citations = cited.citations;
  }

  return {
    markdown,
    title,
    byline,
    excerpt,
    ...(citations ? { citations } : {}),
    served_by: servedBy,
  };
}

// ============================================================
// helper：smoke-test 入口（doctor #33/#34 + CI 可调）
// ============================================================
/**
 * 对固定 fixture HTML 跑一次 extractMarkdown，验引擎可用。
 * doctor #33/#34 调；CI 可选跑（不阻断，warn-only）。
 * @returns { ok, engine, elapsed_ms, markdown_preview }
 */
export async function smokeTestMarkdownEngine(): Promise<{
  ok: boolean;
  engine: string;
  elapsed_ms: number;
  markdown_preview: string;
}> {
  const fixture =
    `<html><head><title>Test</title></head><body>` +
    `<nav>nav junk</nav><article><h1>Hello</h1><p>World <a href="https://example.com">link</a></p></article>` +
    `<footer>footer junk</footer></body></html>`;
  const t0 = Date.now();
  try {
    const r = await extractMarkdown(fixture, { mode: "markdown" });
    return {
      ok: r.markdown.length > 0 && r.markdown.includes("Hello"),
      engine: r.served_by,
      elapsed_ms: Date.now() - t0,
      markdown_preview: r.markdown.slice(0, 200),
    };
  } catch {
    return {
      ok: false,
      engine: "failed",
      elapsed_ms: Date.now() - t0,
      markdown_preview: "",
    };
  }
}
