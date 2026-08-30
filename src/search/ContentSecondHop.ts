/**
 * ContentSecondHop —— A2′ 自研第二跳（doc/governance/06 裁决② + parse24 §3；v1.17 Phase C）。
 *
 * 定位：search 第一跳（蓝链）之后的**可选内容富化**——拿 top N 结果并发裸 HTTP
 * 抓正文（defuddle 抽取 + 查询相关裁剪），零付费依赖、不起浏览器（裁决②原文
 * 「留给 CC 自己 browse」——重站/JS 渲染页如实 fetch_failed，不自动升级）。
 *
 * 架构红线（parse24 §3.2/§3.4 逐条）：
 *  - **enrichment 不是 fallback**：第二跳任何失败**不改变**主结果
 *    outcome / served_by / quality / fallback_used（tri-state 诚实；无循环，
 *    INV-4/55 注释自证范式照 http-serp.ts 头注释）。抓失败的条目保留原蓝链
 *    字段 + content_status 如实标注。
 *  - **SSRF 必过 ssrfGuard**（INV-31 同函数同 config）——第二跳 URL 来自搜索
 *    结果 = 外部输入，SSRF 风险高于固定引擎域名（比 http-serp 更必须）。
 *    redirect:"manual"（照 fetch_url SSRF 红线）：3xx 不跟随，防
 *    「公开域 302 → 169.254.169.254」重定向绕过；跳转链页如实 fetch_failed。
 *  - **连接池单一真源**（INV-32 同精神）：本模块**不 new Agent**；fetch 经注入
 *    的 pooled fetchImpl（index.ts 装配：acquireHttpClient(origin).fetch（util/http-pool）
 *    包装，与 serpHttpExec 同款）。
 *  - **零新增 npm 依赖**：并发 = 自实现 Promise 工作池 + 计数器；裁剪 = 空白
 *    分词 + CJK bigram + 长度归一打分（parse24 §3.3 机械化算法）。
 *  - **cache 零污染**（INV-11 不动）：content_blocks 不入 cache key；蓝链缓存
 *    7 天不变，第二跳每次实抓（接线序 = search.ts 先 cache.set 再 enrich，
 *    且本模块永不改写入参对象——纯函数返回新信封）。
 *
 * 单条护栏（全部复用既有机器，照 fetch-url.ts 范式）：
 *  - timeout 5s（AbortController，fetch-url.ts 同款）
 *  - max_bytes 256KB 两段式：content-length 预检（超限不下载）+ 流式读截断
 *    （字节级硬顶，防恶意巨页内存放大——比 fetch-url 的「全读后拒」更严）
 *  - content-type 非 HTML → 如实 not_html（routeContentType 单一真源）
 *  - HTML → MarkdownExtractor mode:"markdown"（defuddle 抽正文；INV-67 内部
 *    子组件定位不变；dynamic import 守缺省不加载 defuddle/turndown）
 *
 * 预算护栏（parse24 §3.2 步骤 6）：
 *  - 每条裁剪预算 ~6k 字符（budgetChars）；整体 wall-clock 软上限 15s
 *    （budgetMs；并发 3 × 单条 5s 最坏两轮）——超时未**开始**的条目如实
 *    fetch_failed 跳过，不阻塞已完成条目。
 *
 * fetched_via 语义（parse24 §3.4 定案不落字段）：本版第二跳恒 raw_http 不起
 * 浏览器，写死在 tool description（SEARCH_DESCRIPTION）；语义留存 parse24。
 */
import type { InteractResult, SearchResult, SearchResultItem } from "../types.js";
import { ssrfGuard, loadSsrfConfig, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { routeContentType } from "../browse/content-type-router.js";
import { logger } from "../util/logger.js";

// ============================================================
// 类型（parse24 §3.2 步骤 5：输出轴只有 content_status 四态 + content/truncated）
// ============================================================
/**
 * 第二跳 per-result 状态（四态，诚实标注）：
 *  - "ok"            ：拿到裁剪后正文（content 必填；truncated=true 表示裁剪丢弃了段落）
 *  - "fetch_failed"  ：SSRF 拒 / 网络错 / 超时 / 非 2xx / 3xx 未跟随 / 超预算跳过
 *  - "not_html"      ：content-type 非 HTML（PDF/图片/JSON…），如实跳过
 *  - "extract_failed"：抽取引擎失败或抽出空正文（页面无 extractable 内容）
 */
export type ContentBlockStatus = "ok" | "fetch_failed" | "not_html" | "extract_failed";

/** fetchContentBlocks 的单条产出（对齐 SearchResultItem 的可选增强字段形状）。 */
export interface ContentBlockOutcome {
  content_status: ContentBlockStatus;
  /** 仅 "ok" 填：裁剪后正文（文档序保留段落） */
  content?: string;
  /** 仅 "ok" 且裁剪丢弃了段落时 true（省略 = 未裁剪/完整） */
  truncated?: boolean;
}

/** 第二跳可注入依赖（照 http-serp HttpSerpOptions 范式；全可选，缺省零装配可测）。 */
export interface ContentSecondHopDeps {
  /**
   * pooled fetch（INV-32：index.ts 装配 acquireHttpClient(origin).fetch（util/http-pool）包装；
   * 缺省 global fetch——仅单测/直调用，生产装配恒注入池包装，模块本体不 new Agent）。
   */
  fetchImpl?: typeof fetch;
  /** SSRF 配置（缺省 loadSsrfConfig()；单测注入可控段） */
  ssrfConfig?: SsrfConfig;
  /**
   * MarkdownExtractor 注入口（缺省 dynamic import 真引擎 extractMarkdown；
   * 单测注入 mock/throw 以覆盖 extract_failed 态——照 deps 注入范式，不改引擎本体）。
   */
  extractImpl?: (html: string, url: string) => Promise<{ markdown: string }>;
  /** 时间源（缺省 Date.now；单测注入计数器做确定性预算跳过断言） */
  now?: () => number;
}

/** 第二跳护栏参数（全可选带缺省；单测收小 timeout/budget/maxBytes 做确定性断言）。 */
export interface ContentSecondHopOptions {
  /** 单条抓取超时 ms（缺省 5000；AbortController 硬超时） */
  timeoutMs?: number;
  /** 单条 body 字节硬顶（缺省 256 * 1024；content-length 预检 + 流式截断两段式） */
  maxBytes?: number;
  /** 整体 wall-clock 软上限 ms（缺省 15000；超时未开始的条目如实 fetch_failed） */
  budgetMs?: number;
  /** 并发度（缺省 3；parse24 §3.2「并发 3」定案值） */
  concurrency?: number;
  /** 每条裁剪字符预算（缺省 6000；parse24 §3.2「~6k 字符」） */
  budgetChars?: number;
}

// ============================================================
// 护栏缺省（顶级 const，INV 风格单一真源）
// ============================================================
export const CONTENT_HOP_DEFAULTS = Object.freeze({
  timeoutMs: 5_000,
  maxBytes: 256 * 1024,
  budgetMs: 15_000,
  concurrency: 3,
  budgetChars: 6_000,
});

// ============================================================
// §3.3 查询相关裁剪（纯函数，零依赖，机械化可测）
// ============================================================
/**
 * CJK 码位区间（UTF-16 code unit 级；parse24 §3.3「UTF-16 码位级」定案——
 * 不处理代理对（CJK Ext B+ 天平面字符在查询词中极罕见，bigram 语义不变））：
 * 平假名/片假名 + CJK Ext A + CJK 统一表意 + 谚文音节节块 + 兼容表意。
 */
const CJK_CODE_UNIT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x30ff], // 仮名（平假名 + 片假名）
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK 统一表意
  [0xac00, 0xd7a3], // 谚文音节节块
  [0xf900, 0xfaff], // CJK 兼容表意
];

function isCjkCodeUnit(u: number): boolean {
  for (const [lo, hi] of CJK_CODE_UNIT_RANGES) {
    if (u >= lo && u <= hi) return true;
  }
  return false;
}

/**
 * query 分词（parse24 §3.3 定案算法）：
 *  - 拉丁段：空白切分 → lowercase（大小写不敏感命中，机械化无启发式）
 *  - CJK 段：连续 CJK 码位两两成对（bigram）；单字孤立段回退 unigram
 *  - 混合 token（"MCP架构"）按码位切成 CJK 段 / 非 CJK 段分别产出
 *  - 去重（Set 保序）
 */
export function tokenizeQuery(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (t.length === 0 || seen.has(t)) return;
    seen.add(t);
    terms.push(t);
  };
  for (const token of query.split(/\s+/)) {
    if (token.length === 0) continue;
    // 码位扫描：切出极大 CJK 段 / 极大非 CJK 段
    let i = 0;
    while (i < token.length) {
      const cjkRun = isCjkCodeUnit(token.charCodeAt(i));
      let j = i + 1;
      while (j < token.length && isCjkCodeUnit(token.charCodeAt(j)) === cjkRun) j++;
      const segment = token.slice(i, j);
      if (cjkRun) {
        if (segment.length >= 2) {
          for (let k = 0; k + 1 < segment.length; k++) {
            push(segment.slice(k, k + 2));
          }
        } else {
          push(segment); // 孤立单字回退 unigram
        }
      } else {
        push(segment.toLowerCase());
      }
      i = j;
    }
  }
  return terms;
}

/** 每词项命中次数 cap（防关键词页霸榜；parse24 §3.3 定案值 3）。 */
export const SCORE_CAP_PER_TERM = 3;
/** 正文前导语无条件保留字符数（新闻导语定律；parse24 §3.3 定案值 200）。 */
export const LEDE_KEEP_CHARS = 200;

/** 段落切分：markdown 按空行分块，trim 后留非空块（文档序保持）。 */
function splitParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** 段内词项命中次数（CJK 词项码位精确计数 / 拉丁词项大小写不敏感 indexOf 计数）。 */
function countTermHits(paragraph: string, term: string): number {
  const isCjkTerm = isCjkCodeUnit(term.charCodeAt(0));
  const hay = isCjkTerm ? paragraph : paragraph.toLowerCase();
  let count = 0;
  let idx = hay.indexOf(term);
  while (idx !== -1) {
    count++;
    idx = hay.indexOf(term, idx + term.length);
  }
  return count;
}

/** 段落分 = Σ(min(命中, cap)) / sqrt(段长)（长度归一；parse24 §3.3 定案式）。 */
export function scoreParagraph(paragraph: string, terms: readonly string[]): number {
  if (paragraph.length === 0 || terms.length === 0) return 0;
  let sum = 0;
  for (const term of terms) {
    sum += Math.min(countTermHits(paragraph, term), SCORE_CAP_PER_TERM);
  }
  return sum / Math.sqrt(paragraph.length);
}

export interface TrimResult {
  /** 裁剪后正文（文档序拼接选中段落，\n\n 连接） */
  content: string;
  /** 选中段落数 < 全部段落数 → true（诚实标注不完整） */
  truncated: boolean;
}

/**
 * scoreAndTrim —— 查询相关裁剪主函数（parse24 §3.3 保留策略）：
 *  1. 正文前 LEDE_KEEP_CHARS 字符覆盖的段落无条件保留（导语定律）；
 *  2. 其余段落按分数**降序**贪心收录直至 budgetChars（软预算：跨线段落整段收录）；
 *  3. 输出按**文档序**拼接（可读性；分数序只决定收录与否）；
 *  4. truncated = 选中数 < 总段数。
 *
 * 确定性：稳定排序（同分按原文顺序），无随机性，黄金用例可测。
 */
export function scoreAndTrim(
  markdown: string,
  query: string,
  budgetChars: number = CONTENT_HOP_DEFAULTS.budgetChars,
): TrimResult {
  const paragraphs = splitParagraphs(markdown);
  if (paragraphs.length === 0) {
    return { content: "", truncated: false };
  }
  const terms = tokenizeQuery(query);

  // 1. 导语段：起点 offset < LEDE_KEEP_CHARS 的段落无条件保留
  const selected = new Set<number>();
  let offset = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    if (offset < LEDE_KEEP_CHARS) {
      selected.add(i);
    }
    offset += paragraphs[i]!.length + 2; // +2 = 输出拼接的 \n\n
  }

  // 2. 其余段落：分数降序稳定贪心（软预算：跨线段落整段收录，永不返空）
  const candidates = paragraphs
    .map((p, i) => ({ i, score: scoreParagraph(p, terms) }))
    .filter((c) => !selected.has(c.i))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i));

  let total = [...selected].reduce((acc, i) => acc + paragraphs[i]!.length, 0);
  for (const c of candidates) {
    if (total >= budgetChars) break;
    selected.add(c.i);
    total += paragraphs[c.i]!.length;
  }

  // 3. 文档序输出
  const ordered = [...selected].sort((a, b) => a - b);
  return {
    content: ordered.map((i) => paragraphs[i]!).join("\n\n"),
    truncated: selected.size < paragraphs.length,
  };
}

// ============================================================
// 单条抓取护栏（fetch-url.ts 范式：SSRF → 池 fetch → 两段式字节闸 → content-type）
// ============================================================
/**
 * 流式带上界的 body 读取（两段式第二闸；比 fetch-url 的「全读后拒」更严——
 * 恶意巨页在 cap 字节处即 cancel，不进内存）：
 *  1. content-length 预检：CL > cap → 返 null（不下载，带宽/内存双护）
 *  2. 无 body 流（部分 mock / 204）：arrayBuffer 兜底 + 事后截断
 *  3. reader 逐 chunk 累积，跨 cap 即截断 + cancel（truncated=true）
 */
async function readBodyCapped(
  resp: Response,
  cap: number,
): Promise<{ bytes: Uint8Array; truncated: boolean } | null> {
  // 1. content-length 预检
  const clHeader = resp.headers.get("content-length");
  if (clHeader !== null) {
    const cl = parseInt(clHeader, 10);
    if (Number.isFinite(cl) && cl > cap) return null;
  }
  // 2. 无流兜底
  if (!resp.body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > cap) {
      return { bytes: buf.slice(0, cap), truncated: true };
    }
    return { bytes: buf, truncated: false };
  }
  // 3. 流式硬顶
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (total + value.byteLength > cap) {
      const take = cap - total;
      if (take > 0) chunks.push(value.slice(0, take));
      total = cap;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  if (truncated) {
    try {
      await reader.cancel();
    } catch {
      /* cancel 失败不影响已读字节 */
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { bytes: out, truncated };
}

/** 单条第二跳：URL → {content_status, content?, truncated?}（永不 throw，失败如实标注）。 */
async function fetchOneContentBlock(
  item: SearchResultItem,
  query: string,
  opts: Required<Pick<ContentSecondHopOptions, "timeoutMs" | "maxBytes" | "budgetChars">>,
  deps: ContentSecondHopDeps,
): Promise<ContentBlockOutcome> {
  const url = item.url;

  // ---------- 1. SSRF 守门（INV-31 同函数同 config；外部输入 URL 必过） ----------
  try {
    const guard = await ssrfGuard(url, deps.ssrfConfig ?? loadSsrfConfig());
    if (!guard.allowed) {
      logger.info({ evt: "content_hop_ssrf_blocked", reason: guard.reason });
      return { content_status: "fetch_failed" };
    }
  } catch (e) {
    logger.warn({ evt: "content_hop_ssrf_error", error: String(e).slice(0, 120) });
    return { content_status: "fetch_failed" };
  }

  // ---------- 2. 池 fetch（redirect:"manual" + AbortController 硬超时） ----------
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: "GET",
        headers: {
          // 自报身份（照 fetch_url：不伪装浏览器；反爬站点如实 fetch_failed）
          "User-Agent": "lasso-mcp/1.17 (search content_blocks)",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout =
        e instanceof Error &&
        (e.name === "TimeoutError" || e.name === "AbortError" || /aborted|timed?\s?out/i.test(msg));
      logger.info({
        evt: "content_hop_fetch_failed",
        host: safeHost(url),
        reason: isTimeout ? "timeout" : "network",
      });
      return { content_status: "fetch_failed" };
    }

    // 3xx：不跟随（SSRF 红线；跳转链页如实 fetch_failed，CC 可自行 browse 兜底）
    if (resp.status >= 300 && resp.status < 400) {
      logger.info({ evt: "content_hop_redirect_not_followed", status: resp.status });
      return { content_status: "fetch_failed" };
    }
    if (!resp.ok) {
      logger.info({ evt: "content_hop_non_2xx", status: resp.status });
      return { content_status: "fetch_failed" };
    }

    // ---------- 3. content-type 非 HTML → 如实 not_html（routeContentType 单一真源） ----------
    const route = routeContentType(resp.headers.get("content-type"));
    if (route.kind !== "html") {
      logger.info({ evt: "content_hop_not_html", kind: route.kind });
      return { content_status: "not_html" };
    }

    // ---------- 4. 两段式字节闸（CL 预检不下载 / 流式截断） ----------
    const body = await readBodyCapped(resp, opts.maxBytes);
    if (body === null) {
      logger.info({ evt: "content_hop_oversize", cap: opts.maxBytes });
      return { content_status: "fetch_failed" };
    }
    const html = new TextDecoder("utf-8").decode(body.bytes);

    // ---------- 5. MarkdownExtractor（mode:"markdown"；INV-67 内部子组件） ----------
    let markdown: string;
    try {
      const extract =
        deps.extractImpl ??
        (async (htmlIn: string, pageUrl: string) => {
          const { extractMarkdown } = await import("../browse/markdown-extractor.js");
          const r = await extractMarkdown(htmlIn, {
            mode: "markdown",
            // T2-3 同款：URL 透传激活 defuddle 站点 extractor + 相对链接绝对化
            url: pageUrl,
            headingStyle: "atx",
            bulletMarker: "-",
          });
          return { markdown: r.markdown };
        });
      const r = await extract(html, url);
      markdown = r.markdown;
    } catch (e) {
      logger.warn({ evt: "content_hop_extract_failed", error: String(e).slice(0, 120) });
      return { content_status: "extract_failed" };
    }
    if (!markdown || markdown.trim().length === 0) {
      // 空正文 = 页面无 extractable 内容（fetch 成功但抽取落空）——诚实 extract_failed
      return { content_status: "extract_failed" };
    }

    // ---------- 6. 查询相关裁剪 + 输出 ----------
    const trimmed = scoreAndTrim(markdown, query, opts.budgetChars);
    return {
      content_status: "ok",
      content: trimmed.content,
      // 裁剪丢段 或 body 字节级截断 → truncated（内容不完整的诚实并集）
      ...(trimmed.truncated || body.truncated ? { truncated: true } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// ============================================================
// fetchContentBlocks —— 编排（并发池 + wall-clock 预算；parse24 §3.2 步骤 2/6）
// ============================================================
/**
 * 对 results 的前 N 条并发抓正文，返回与 results **同序等长**的 per-item 产出数组
 * （未进 top N 的槽位 = null，调用方原样保留该条）。
 *
 *  - 并发度 3（自实现工作池：next 游标 + min(concurrency, N) 个 worker；零依赖）
 *  - budgetMs 软上限：条目**开抓前**检查 deadline，超时槽位如实 fetch_failed
 *    （不阻塞已完成条目；在飞条目由自身 5s 硬超时兜底，总 wall-clock 有界）
 *  - 单条永不 throw（fetchOneContentBlock 内部全捕获）
 */
export async function fetchContentBlocks(
  results: readonly SearchResultItem[],
  query: string,
  topN: number,
  opts: ContentSecondHopOptions = {},
  deps: ContentSecondHopDeps = {},
): Promise<Array<ContentBlockOutcome | null>> {
  const timeoutMs = opts.timeoutMs ?? CONTENT_HOP_DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? CONTENT_HOP_DEFAULTS.maxBytes;
  const budgetMs = opts.budgetMs ?? CONTENT_HOP_DEFAULTS.budgetMs;
  const budgetChars = opts.budgetChars ?? CONTENT_HOP_DEFAULTS.budgetChars;
  const concurrency = opts.concurrency ?? CONTENT_HOP_DEFAULTS.concurrency;
  const now = deps.now ?? Date.now;

  const outcomes: Array<ContentBlockOutcome | null> = results.map(() => null);
  const n = Math.max(0, Math.min(topN, results.length));
  if (n === 0) return outcomes;

  const start = now();
  let next = 0;
  const perItem = { timeoutMs, maxBytes, budgetChars };

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      // 开抓前预算检查（超时未开始的条目如实 fetch_failed，不进网络）
      if (now() - start > budgetMs) {
        logger.info({ evt: "content_hop_budget_skipped", index: i });
        outcomes[i] = { content_status: "fetch_failed" };
        continue;
      }
      outcomes[i] = await fetchOneContentBlock(results[i]!, query, perItem, deps);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, n)) },
    () => worker(),
  );
  await Promise.all(workers);
  return outcomes;
}

// ============================================================
// enrichWithContentBlocks —— 信封级入口（search.ts 三路径统一出口调用）
// ============================================================
/**
 * worked 结果的信封级内容富化（纯函数：返回新信封，永不改写入参——cache 零污染）。
 *
 *  - outcome !== "worked" / data 空 / results 空 / topN < 1 → 原样返回（零富化）
 *  - top N 条：合并 content_status/content/truncated 字段（新对象，不动原条目）
 *  - N 之外条目原样保留（增强字段缺席 = 未尝试，与缺省基线 byte-identical）
 *  - 主信封字段（outcome/served_by/quality/fallback_used/...）逐字节不动
 *    （tri-state 诚实红线：enrichment 不是 fallback）
 */
export async function enrichWithContentBlocks(
  result: InteractResult<SearchResult>,
  query: string,
  topN: number,
  opts: ContentSecondHopOptions = {},
  deps: ContentSecondHopDeps = {},
): Promise<InteractResult<SearchResult>> {
  if (
    result.outcome !== "worked" ||
    !result.data ||
    !Array.isArray(result.data.results) ||
    result.data.results.length === 0 ||
    !Number.isInteger(topN) ||
    topN < 1
  ) {
    return result;
  }
  const outcomes = await fetchContentBlocks(
    result.data.results,
    query,
    topN,
    opts,
    deps,
  );
  const enriched = result.data.results.map((item, i) => {
    const o = outcomes[i];
    if (!o) return item; // 未尝试（> top N）——原对象原样
    return { ...item, ...o };
  });
  return {
    ...result,
    data: { ...result.data, results: enriched },
  };
}
