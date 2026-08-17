/**
 * fetch_feed tool 注册（doc/24 颠覆性调研 verdict D-GO-2，2026-08-18）。
 *
 * **为什么存在（zero-base §3-I3 / scan-edge §4）**：
 *  - SERP 索引滞后小时~天级；RSS/Atom 是**推模型**——发布即推送，零索引滞后，
 *    是唯一确定性的 freshness 解。
 *  - 本用户画像 I3（新鲜度事实）占 15-20%（E 级估计）：「X 什么时候退役」「最新版本号」
 *    类查询当前只有「过滤已索引」一解（freshness 过滤），无「直接问源」一解。
 *
 * **设计立场（守简单架构红线 + 横切关注点边界）**：
 *  - **无状态纯原语**：拉一个 feed URL → 结构化条目列表。不轮询、不聚合、不落盘、
 *    零守护进程（scan-edge §4.4 明确否决常驻 Miniflux/RSSHub 形态）。
 *  - **独立 tool**，不进 search 降级链（与 wayback_lookup 同范式）：CC 对「最新动态」
 *    类查询显式调本 tool（官方博客/发布页的 feed 常在页头 <link rel=alternate>，
 *    browse 已能发现）。freshness 路由编排是 CC 的判断力范围，不做进 Lasso。
 *  - L-COST：200-500ms / $0 / 输出条目列表（title+url+published+summary 截断）。
 *
 * **复用范式（INV-56 家族）**：
 *  - 必经 ssrfGuard + doFetchUrl（与 fetch_url / wayback_lookup 同函数同 config；
 *    不自造第二套 fetch）。
 *  - bounded output 由 doFetchUrl 内部 applyOutputEnvelope 承担；>48KiB 的 feed
 *    只拿 16KiB preview —— 解析器**截断容忍**（只认完整 <item>/<entry> 块），
 *    truncated_input=true 标记让 CC 知道拿到的是部分条目。
 *
 * **解析策略（零依赖，不上 XML 解析库）**：
 *  - RSS 2.0：<item>…</item> 完整块正则 + 字段抽取（title/link/pubDate/description/dc:date）。
 *  - Atom：<entry>…</entry> 完整块 + <link href> / <updated>/<published> / <summary>/<content>。
 *  - JSON Feed 1.1：items[] 数组（title/url/date_published/content_text）。
 *  - CDATA 与 HTML 实体解码；summary 截 500 字符（token 经济，zero-base D5）。
 *  - 截断的尾部条目天然不匹配完整块正则 → 被安全丢弃，不会产出半条假条目。
 *
 * 借鉴：tools/wayback.ts（独立 tool + doFetchUrl 复用范式）；tools/fetch-url.ts。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InteractResult } from "../types.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { ssrfGuard, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { doFetchUrl } from "./fetch-url.js";
import { FETCH_FEED_DESCRIPTION } from "./descriptions.js";
import { fetchFeedAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";

// ============================================================
// Schema
// ============================================================
export const fetchFeedSchema = {
  /** feed URL（RSS / Atom / JSON Feed 均可；发现 feed 的责任在 caller） */
  url: z.string().url(),
  /** 最多返回条数（默认 10，上限 50；token 经济） */
  limit: z.number().int().min(1).max(50).default(10),
};

// ============================================================
// 包装 helper（与 wayback.ts 同范式）
// ============================================================
function payloadContent<T>(result: InteractResult<T>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}

// ============================================================
// 返回数据形状
// ============================================================
export interface FeedEntryData {
  /** 条目标题（已解码实体/CDATA；缺失时回退 url） */
  title?: string;
  /** 条目链接（RSS <link> / Atom <link href> / JSON Feed url） */
  url?: string;
  /** 发布时间原文（RSS RFC822 / Atom ISO / JSON Feed ISO；不归一——CC 自解析） */
  published?: string;
  /** 摘要（description/summary/content 前 500 字符，纯文本化） */
  summary?: string;
}

export interface FeedResult {
  /** 用户输入的原始 feed URL（必回显） */
  url: string;
  /** 实际响应 URL（重定向后；redirect:manual 下通常同 url） */
  final_url?: string;
  /** 识别的 feed 格式 */
  format: "rss" | "atom" | "json";
  /** feed/channel 级标题 */
  title?: string;
  /** 站点 HTML 首页（Atom rel=alternate / RSS channel link） */
  site_url?: string;
  /** feed 级最近更新时间（lastBuildDate / atom updated —— freshness 信号） */
  updated?: string;
  /** 实际返回条数（≤ limit） */
  count: number;
  entries: FeedEntryData[];
  /** true = 输入 body 被截断（>48KiB 走 16KiB preview），条目可能不全 */
  truncated_input: boolean;
}

// ============================================================
// 解析器（零依赖，截断容忍）
// ============================================================
/** CDATA 剥壳 + 常用 HTML 实体解码 + 控制字符清理 */
function decodeXmlText(raw: string): string {
  let s = raw.trim();
  const cdata = s.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) s = cdata[1]!;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&amp;/g, "&") // amp 最后解码（防 &amp;lt; 双重解码错位）
    .replace(/\s+/g, " ")
    .trim();
}

/** 抽取块内第一个 <tag>…</tag> 的解码文本 */
function tagText(block: string, tag: string): string | undefined {
  const m = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"),
  );
  return m ? decodeXmlText(m[1]!) : undefined;
}

/** summary 纯文本化 + 截断（token 经济：500 字符帽） */
function toSummary(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .replace(/<[^>]+>/g, " ") // 去内联 HTML 标签
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

const ITEM_BLOCK_RE = /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi;
const ENTRY_BLOCK_RE = /<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi;

/**
 * 截断尾部的「头字段抢救」：全内容 feed（单条含整篇文章，24KiB+）在 16KiB preview
 * 里可能没有任何完整块。此时从第一个未闭合块的开头提取 title/link/published
 * （这三者在 <content>/<summary> 之前出现），summary 丢弃（诚实：不猜）。
 * 抢救不出 title 且 url → 返 null（宁缺毋滥）。
 */
function extractHeadEntry(tail: string, isAtom: boolean): FeedEntryData | null {
  const head = tail.split(/<(content|summary|description)[\s>]/i)[0]!;
  if (isAtom) {
    const href = head.match(/<link[^>]*href="([^"]*)"/i)?.[1];
    return {
      title: tagText(head, "title"),
      url: href ? decodeXmlText(href) : undefined,
      published: tagText(head, "published") ?? tagText(head, "updated"),
    };
  }
  return {
    title: tagText(head, "title"),
    url: tagText(head, "link"),
    published: tagText(head, "pubDate") ?? tagText(head, "date"),
  };
}

function parseRssOrAtom(
  body: string,
  isAtom: boolean,
  limit: number,
): { meta: { title?: string; site_url?: string; updated?: string }; entries: FeedEntryData[] } {
  // feed 级元数据取「首个条目块之前」的头部（channel 段 / feed 根属性段）
  const firstItemIdx = body.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = firstItemIdx === -1 ? body : body.slice(0, firstItemIdx);
  const blocks = (
    isAtom ? body.match(ENTRY_BLOCK_RE) : body.match(ITEM_BLOCK_RE)
  )?.slice(0, limit);

  const entries: FeedEntryData[] = (blocks ?? []).map((b) => {
    if (isAtom) {
      // Atom link：优先 rel=alternate（站点页），否则第一个带 href 的 link
      let link: string | undefined;
      let firstHref: string | undefined;
      const linkRe = /<link(?:\s[^>]*)?>/gi;
      let lm: RegExpExecArray | null;
      while ((lm = linkRe.exec(b))) {
        const href = lm[0].match(/href="([^"]*)"/i)?.[1];
        if (!href) continue;
        if (/rel="alternate"/i.test(lm[0]) || !/rel=/i.test(lm[0])) {
          link = href; // alternate 或无 rel（spec 默认即 alternate）
          break;
        }
        firstHref ??= href;
      }
      link ??= firstHref;
      return {
        title: tagText(b, "title"),
        url: link ? decodeXmlText(link) : undefined,
        published: tagText(b, "published") ?? tagText(b, "updated"),
        summary: toSummary(tagText(b, "summary") ?? tagText(b, "content")),
      };
    }
    // RSS：<link>text</link>（老式）；无文本时回退 url 字符串提取
    const linkText = tagText(b, "link");
    const linkAttr = b.match(/<link[^>]*href="([^"]*)"/i)?.[1];
    return {
      title: tagText(b, "title"),
      url: linkText ?? (linkAttr ? decodeXmlText(linkAttr) : undefined),
      published: tagText(b, "pubDate")
        ?? tagText(b, "date") // dc:date 命名空间前缀变体兜底
        ?? tagText(b, "updated"),
      summary: toSummary(tagText(b, "description")),
    };
  });

  const meta: { title?: string; site_url?: string; updated?: string } = {
    title: tagText(head, "title"),
    updated: tagText(head, "lastBuildDate") ?? tagText(head, "updated"),
  };
  if (isAtom) {
    const m =
      head.match(/<link[^>]*rel="alternate"[^>]*href="([^"]*)"/i) ??
      head.match(/<link[^>]*href="([^"]*)"[^>]*rel="alternate"/i);
    meta.site_url = m ? decodeXmlText(m[1]!) : undefined;
  } else {
    const linkText = tagText(head, "link");
    meta.site_url = linkText || undefined;
  }
  // 0 完整块 + 尾部有未闭合块起点 → 头字段抢救（全内容 feed 截断场景）
  if (entries.length === 0) {
    const tailMatch = body.match(
      isAtom ? /<entry(?:\s[^>]*)?>[\s\S]*$/i : /<item(?:\s[^>]*)?>[\s\S]*$/i,
    );
    if (tailMatch) {
      const rescued = extractHeadEntry(tailMatch[0]!, isAtom);
      if (rescued && (rescued.title || rescued.url)) entries.push(rescued);
    }
  }
  return { meta, entries };
}

interface JsonFeedShape {
  title?: string;
  home_page_url?: string;
  updated?: string;
  items?: Array<{
    title?: string;
    url?: string;
    external_url?: string;
    date_published?: string;
    date_modified?: string;
    content_text?: string;
    summary?: string;
  }>;
}

/**
 * 解析 feed body → FeedResult。
 * 截断容忍：只认完整 item/entry 块；0 条完整块 → 抛错（caller 转 didnt）。
 */
export function parseFeedBody(
  body: string,
  limit: number,
): Omit<FeedResult, "url" | "final_url" | "truncated_input"> {
  const trimmed = body.replace(/^﻿/, "").trimStart();

  // JSON Feed（{ "version": "https://jsonfeed.org/…", items: [...] }）
  if (trimmed.startsWith("{")) {
    try {
      const jf = JSON.parse(trimmed) as JsonFeedShape;
      if (Array.isArray(jf.items)) {
        return {
          format: "json",
          title: jf.title,
          site_url: jf.home_page_url,
          updated: jf.updated,
          count: Math.min(jf.items.length, limit),
          entries: jf.items.slice(0, limit).map((it) => ({
            title: it.title,
            url: it.url ?? it.external_url,
            published: it.date_published ?? it.date_modified,
            summary: toSummary(it.summary ?? it.content_text),
          })),
        };
      }
    } catch {
      // 落到 XML 判定（body 以 { 开头但不是 JSON Feed → 下面统一 didnt）
    }
  }

  // XML：RSS / Atom 判定（feed 根骨架即可——0 条 item 的空 feed 也算识别成功，
  // entries=[] 由 caller 转 didnt feed_has_no_entries；截断丢掉全部 item 同理）
  const isAtom = /<feed[\s>]/i.test(trimmed);
  const isRss = /<(rss|channel)[\s>]/i.test(trimmed);
  if (isAtom || isRss) {
    const { meta, entries: list } = parseRssOrAtom(trimmed, isAtom, limit);
    return {
      format: isAtom ? "atom" : "rss",
      title: meta.title,
      site_url: meta.site_url,
      updated: meta.updated,
      count: list.length,
      entries: list,
    };
  }

  throw new Error("not_a_feed");
}

// ============================================================
// 核心：doFetchFeed（独立可测）
// ============================================================
/**
 * fetch_feed 的纯函数实装 —— 单元测直接调，不经 MCP server.tool 装配。
 *
 * 流程：
 *  1. SSRF 守门用户 URL（INV-56 家族；与 fetch_url / wayback 同函数同 config）
 *  2. doFetchUrl GET（15s 超时 / 2MiB 上限 —— feed 偶见数百 KiB 全文输出，48KiB
 *     envelope 不够但 2MiB 足够 bounded）
 *  3. content-type 检查：binary:* → didnt（非 feed 形态）
 *  4. parseFeedBody（截断容忍）→ entries[:limit]
 *  5. 返 InteractResult<FeedResult>
 */
export async function doFetchFeed(
  rawUrl: string,
  limit: number,
  subproc: SubprocessManager,
  ssrfConfig: SsrfConfig,
): Promise<InteractResult<FeedResult>> {
  // ---------- 1. SSRF 守门（INV-56 家族） ----------
  const ssrfResult = await ssrfGuard(rawUrl, ssrfConfig);
  if (!ssrfResult.allowed) {
    return {
      outcome: "didnt",
      data: null,
      served_by: "lasso.ssr_guard",
      fallback_used: false,
      retrieval_method: "ssrf_blocked",
      error: `ssrf_blocked:${ssrfResult.reason}`,
    };
  }

  // ---------- 2. doFetchUrl（复用 bounded fetch + 内嵌二次 SSRF） ----------
  const fetchResult = await doFetchUrl(
    rawUrl,
    {
      method: "GET",
      timeout_ms: 15_000,
      max_bytes: 2 * 1024 * 1024,
      no_cache: false,
      // feed 抓取自报用途（不伪装浏览器）
      headers: { Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, */*" },
    },
    subproc,
    ssrfConfig,
  );

  if (fetchResult.outcome !== "worked") {
    return {
      outcome: fetchResult.outcome,
      data: null,
      served_by: "fetch_feed",
      fallback_used: false,
      retrieval_method: "direct_fetch",
      error: fetchResult.error ?? `feed_fetch_${fetchResult.outcome}`,
    };
  }

  // ---------- 3. content-type 检查 ----------
  const bodyKind = fetchResult.data?.body_kind ?? "";
  if (bodyKind.startsWith("binary:")) {
    return {
      outcome: "didnt",
      data: null,
      served_by: "fetch_feed",
      fallback_used: false,
      retrieval_method: "direct_fetch",
      error: `unsupported_content_type:${fetchResult.data?.content_type}`,
    };
  }
  const envelope = fetchResult.data?.envelope;
  if (!envelope) {
    return {
      outcome: "unknown",
      data: null,
      served_by: "fetch_feed",
      fallback_used: false,
      retrieval_method: "direct_fetch",
      error: "no_envelope",
    };
  }

  // ---------- 4. 解析（截断容忍） ----------
  const truncated = envelope.truncated === true;
  let parsed: ReturnType<typeof parseFeedBody>;
  try {
    parsed = parseFeedBody(envelope.preview, limit);
  } catch (e) {
    logger.warn({ evt: "fetch_feed_parse_failed", url: rawUrl, error: String(e) });
    return {
      outcome: "didnt",
      data: null,
      served_by: "fetch_feed",
      fallback_used: false,
      retrieval_method: "feed_parse",
      error: "not_a_feed",
    };
  }
  if (parsed.entries.length === 0) {
    return {
      outcome: "didnt",
      data: null,
      served_by: "fetch_feed",
      fallback_used: false,
      retrieval_method: "feed_parse",
      error: truncated ? "no_complete_entries_truncated_body" : "feed_has_no_entries",
    };
  }

  // ---------- 5. 返 ----------
  const data: FeedResult = {
    url: rawUrl,
    final_url: fetchResult.data?.final_url,
    truncated_input: truncated,
    ...parsed,
  };
  return {
    outcome: "worked",
    data,
    served_by: "fetch_feed",
    fallback_used: false,
    retrieval_method: "direct_fetch",
  };
}

// ============================================================
// 注册器
// ============================================================
/**
 * @param server     MCP server
 * @param subproc    SubprocessManager（doFetchUrl 经 acquireHttpClient 拿 undici keep-alive Agent）
 * @param ssrfConfig SSRF allowRanges / denyRanges（与 fetch_url / wayback 共用）
 */
export function registerFetchFeedTool(
  server: McpServer,
  subproc: SubprocessManager,
  ssrfConfig: SsrfConfig,
): void {
  server.tool(
    "fetch_feed",
    FETCH_FEED_DESCRIPTION,
    fetchFeedSchema,
    fetchFeedAnnotations,
    async (args) => {
      const result = await doFetchFeed(
        args.url,
        args.limit,
        subproc,
        ssrfConfig,
      );
      return payloadContent(result);
    },
  );
}
