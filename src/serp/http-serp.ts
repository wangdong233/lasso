/**
 * serp_http —— 裸 HTTP SERP 快探层（v1.15 Phase B；parse22 + verify 真机修订）
 *
 * 定位：search fallback 链在 browse_headless（冷启动 ~11s + Chromium 树）**之前**
 * 的 ~1s 级快探。白盒证据（doc/governance/02-搜索方案重审 + v1.14 实测）：裸 curl 打
 * search.brave.com 返 200 + 22 条结果，而真 Chrome 反吃验证码——无浏览器客户端
 * 对部分 SERP 反而更不容易被判 bot。故 API 层全挂时先用裸 HTTP 探一次，
 * 探不到再升真浏览器。
 *
 * 新降级链：machine_mcp → brave → **serp_http** → browse_headless → recording_replay
 * （v1.17 A3：zhipu 直连档已删，INV-80 墓碑守卫）。
 *
 * verify 真机修订（2026-08-17，两处正确性修复）：
 *  - 归一化剥噪声块：转换前剥 <style>/<script>/<noscript>、转换后删 markdown
 *    图片语法——否则 brave 内联 @font-face 字体 CSS / 缩略图 URL 会被抽取器
 *    当结果收割（实测 20/20 全垃圾、0 真实结果）。
 *  - 软挡检测：终态 URL host/path 偏离请求的 SERP URL → unknown
 *    serp_http_redirect_blocked——百度 wappass 验证码/首页壳 200 伪成功同拦。
 *
 * 架构红线（parse22 §0）：
 *  - 单 fallback 引擎不变（INV-4/55）：本模块只是 plan 里一个 channel 档的实现体，
 *    仍由 FallbackDecider.runWithFallback 串行调度；模块内无 executor 循环。
 *  - 禁第二套 selector：URL 构造复用 serpUrlFor、引擎分流复用 serpEngineForQuery、
 *    抽取复用 extractResultsFromSnapshot、改版检测复用 SerpHealthMonitor.onResult、
 *    bot marker 复用 CLOUDFLARE_DETECTION_REGEX。本文件零新增 selector 表
 *    （噪声剥除与 URL 形状校验是无状态归一化/传输层检查，非 selector/marker 集）。
 *  - tri-state 诚实：一切失败路径（超时/非 200/验证码/空抽取/SSRF 拒/软挡重定向）
 *    → unknown，让 decider 升 browse_headless；**绝不**把「裸 HTTP 被挡」伪造成 didnt。
 *
 * escalation-safe error 命名（parse22 §1.4，关键正确性点）：
 *  FallbackDecider 对 unknown 先问 isFallbackWorthy；error 含 "403"/"404"/"forbidden"/
 *  "nxdomain" 等子串 → 判「不值得 fallback」→ 链终止在快探层，browse_headless
 *  永远不会被调——违背本层意图。故 error 全部用语义桶命名，不内嵌原始状态码 /
 *  DNS 错误原文（细节走 logger）。
 *
 * SSRF（parse22 §1.2 步骤 2-3）：搜索 URL 是固定引擎域名白名单（不走用户输入 URL），
 * 仍过一遍 ssrfGuard 防御纵深（与 fetch_url / browse 同函数同 config）。
 *
 * 连接池单一真源（INV-32 同精神）：本模块**不 new Agent**；fetch 经注入的
 * pooled fetchImpl（index.ts 用 subproc.acquireHttpClient(origin).fetch 包装）。
 */
import type { InteractResult, SearchFreshness, SearchResult } from "../types.js";
import {
  serpEngineForQuery,
  serpUrlFor,
  extractResultsFromSnapshot,
} from "./extract.js";
import type { SerpEngine } from "./selectors.js";
import type { SerpHealthMonitor } from "./SerpHealthMonitor.js";
import { STEALTH_PROFILES, CLOUDFLARE_DETECTION_REGEX } from "../browse/stealth-profiles.js";
// 引擎复用：turndown 全页转换（markdown-extractor 同款配置工厂）。
// **不走 extractMarkdown 的 defuddle 管线**——实测（2026-08-17）defuddle 正文抽取
// 对 SERP 页有害：把结果标题 <a> 升格为 heading 丢 href、丢摘要 div；SERP 需要
// 保住全部 <a href> 的全页转换（= markdown-extractor 的 turndown-only 降级路径同款）。
import { createTurndownService } from "../browse/markdown-extractor.js";
import { ssrfGuard, loadSsrfConfig, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { logger } from "../util/logger.js";

// ============================================================
// 类型
// ============================================================
export interface HttpSerpOptions {
  /** 结果 data.region 标注（"cn" / "us"；引擎分流仍按 query 语言，与 browse 层一致） */
  region?: string;
  /** 时效过滤（复用 serpUrlFor 的 df= 逻辑：ddg 拼参；baidu/brave 诚实不拼） */
  freshness?: SearchFreshness;
  /** baidu rn= 参数（默认 10） */
  limit?: number;
  /** 单次引擎尝试超时（默认 5000ms；级联时总上界 ≈ 2×） */
  timeoutMs?: number;
  /** 注入 pooled fetch（缺省 global fetch；index.ts 装配时传 httpAgents 池包装） */
  fetchImpl?: typeof fetch;
  serpHealth?: SerpHealthMonitor | null;
  /** SSRF 配置（缺省 loadSsrfConfig()；单测注入可控段） */
  ssrfConfig?: SsrfConfig;
}

/**
 * search.ts 注入的快探执行器形状（parse22 §2.1）。
 * index.ts 装配：`(q, o) => rawSerpSearch(q, { ...o, fetchImpl, ssrfConfig, serpHealth })`。
 * 未注入 → search 三处 plan 不含 serp_http 档（零回归 byte-identical）。
 */
export type HttpSerpExec = (
  query: string,
  opts: {
    region: string;
    freshness?: SearchFreshness;
    limit: number;
  },
) => Promise<InteractResult<SearchResult>>;

// ============================================================
// 引擎域名白名单（parse22 §1.2 步骤 2）
// ============================================================
/**
 * serp_http 允许请求的引擎 host（固定白名单——搜索 URL 不走用户输入，
 * 但仍显式锁定防未来 serpUrlFor 扩引擎时意外放行陌生域）。
 */
export const SERP_HTTP_ALLOWED_HOSTS: readonly string[] = [
  "www.baidu.com",
  "html.duckduckgo.com",
  "search.brave.com",
] as const;

// ============================================================
// 浏览器级 headers（复用 STEALTH_PROFILES 既有值；parse22 §1.2 步骤 4）
// ============================================================
/**
 * profile 选择规则与 HeadlessChannel.defaultHeadlessProfileForHost 一致
 * （darwin→mac_chrome，否则 windows_chrome_120）。不 import channels/ 防止
 * serp→channels 缠绕——与 extract.ts BrowseExec 注入同立场（提取器不硬依赖通道）。
 */
function httpSerpProfileName(): "mac_chrome" | "windows_chrome_120" {
  return process.platform === "darwin" ? "mac_chrome" : "windows_chrome_120";
}

/**
 * 引擎 → 浏览器级请求头。
 *  - 基座取宿主对齐 stealth profile 的 UA / sec-ch-ua / sec-fetch 全家桶
 *    （网络层头与 browse_headless 浏览器看到的同一套值，不自相矛盾）。
 *  - baidu 覆写 Accept-Language=zh-CN（复用 mac_safari_17 的 acceptLanguage 值；
 *    中文引擎发 en-US 头是无谓的指纹矛盾）。
 *  - 不设 accept-encoding（交给 undici 协商，避免声明不支持的 br/zstd）。
 */
function httpSerpHeaders(engine: SerpEngine): Record<string, string> {
  const profile = STEALTH_PROFILES[httpSerpProfileName()];
  const zhLang = STEALTH_PROFILES.mac_safari_17.acceptLanguage; // "zh-CN,zh;q=0.9"
  const headers: Record<string, string> = {
    "user-agent": profile.userAgent,
    accept: profile.accept,
    "accept-language":
      engine === "baidu" ? zhLang : profile.acceptLanguage,
    "upgrade-insecure-requests": profile.upgradeInsecureRequests ? "1" : "0",
  };
  // sec-ch-ua 家族：Safari/Firefox profile 原生不发（空串）——chrome profile 恒非空
  if (profile.secChUa) {
    headers["sec-ch-ua"] = profile.secChUa;
    headers["sec-ch-ua-mobile"] = profile.secChUaMobile;
    headers["sec-ch-ua-platform"] = profile.secChUaPlatform;
  }
  headers["sec-fetch-site"] = profile.secFetchSite;
  headers["sec-fetch-mode"] = profile.secFetchMode;
  headers["sec-fetch-user"] = profile.secFetchUser;
  headers["sec-fetch-dest"] = profile.secFetchDest;
  return headers;
}

// ============================================================
// HTML → 可抽取文本（turndown 全页转换；parse22 §1.2 步骤 7 实施修订
// + verify 真机修订 2026-08-17：噪声块剥除）
// ============================================================
/**
 * HTML 非内容块剥除：`<style>` / `<script>` / `<noscript>` 整块删除。
 *
 * verify 真机证据（2026-08-17，search.brave.com 实抓 246KB HTML）：brave 是
 * SvelteKit 页，内联 `<style>` 含十余条 `@font-face { src: url(https://cdn…) }`。
 * turndown 默认把 style 文本当正文保留 → 字体 CSS 行被 a11y 抽取器当结果收割
 * （实测 20 条「结果」全部是 font-face 垃圾，0 条真实结果——伪造成功的质量事故）。
 * a11y 快照（browse 层同款输入）天然不含 CSS/JS 文本，故抽取器的输入契约本就
 * 是「无 style/script」。本剥除是把 HTML 归一化回该契约，无状态正则、非 selector。
 */
export function stripNonContentBlocks(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
}

/**
 * markdown 图片语法删除：`![alt](url)` → 空。
 *
 * verify 真机证据（同上）：turndown 输出的 `![…](…)` 图片语法会 (a) 污染相邻
 * 链接摊平后的标题（`[![Brave logo](` 残骸），(b) 让 imgs.search.brave.com
 * 缩略图 / cdn logo 被当结果收割。a11y 快照不含图片节点——删除即归一化回契约。
 */
export function dropMarkdownImages(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
}

/**
 * markdown 链接摊平：`[title](url)` → `title url`。
 * 让 a11y-快照抽取器（extractResultsFromSnapshot 的 URL 正则 + 前行取标题）
 * 可直接消费 markdown 文本——一条正则的确定性归一化，**不是** selector。
 */
export function flattenMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, "$1 $2");
}

/** ATX heading 前缀剥除（`## Title` → `Title`）——同样是无状态归一化，非 selector。 */
function stripAtxHeadings(text: string): string {
  return text.replace(/^#{1,6}[ \t]+/gm, "");
}

/**
 * SERP HTML → a11y-快照形文本：剥非内容块 → turndown 全页转 markdown →
 * 删图片语法 → 摊平链接 → 剥 heading 记号。
 * 产出形态 `Title https://url snippet…` 与 browse 层 take_snapshot 文本同构，
 * 供 extractResultsFromSnapshot 原样消费（抽取器单一真源，禁第二套 selector）。
 */
export function serpHtmlToSnapshotText(html: string): string {
  const md = createTurndownService().turndown(stripNonContentBlocks(html));
  return stripAtxHeadings(flattenMarkdownLinks(dropMarkdownImages(md)));
}

// ============================================================
// 单引擎一次快探（parse22 §1.2）
// ============================================================
/**
 * 单引擎尝试。返回形状与 scrapeEngineOnce 对齐（同形 InteractResult<SearchResult>），
 * served_by 标 `serp_http:<engine>`。
 *
 * 一切失败路径 → outcome=unknown + escalation-safe error（见文件头）；
 * 成功（count>0）→ worked。
 */
async function httpEngineOnce(
  engine: SerpEngine,
  query: string,
  opts: HttpSerpOptions,
): Promise<InteractResult<SearchResult>> {
  const limit = opts.limit ?? 10;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retrievalMethod = `serp_http_${engine}`;

  const serpUrl = serpUrlFor(engine, query, limit, opts.freshness);

  // ---------- 域名白名单（固定引擎域；防未来扩引擎时意外放行） ----------
  let host: string;
  try {
    host = new URL(serpUrl).host;
  } catch {
    return unknownResult(engine, retrievalMethod, "serp_http_host_not_allowed");
  }
  if (!SERP_HTTP_ALLOWED_HOSTS.includes(host)) {
    return unknownResult(engine, retrievalMethod, "serp_http_host_not_allowed");
  }

  // ---------- SSRF 纵深（与 fetch_url / browse 同函数；parse22 §1.2 步骤 3） ----------
  const ssrfConfig = opts.ssrfConfig ?? loadSsrfConfig();
  const ssrf = await ssrfGuard(serpUrl, ssrfConfig);
  if (!ssrf.allowed) {
    logger.warn({ evt: "serp_http_ssrf_blocked", engine, reason: ssrf.reason });
    return unknownResult(engine, retrievalMethod, "serp_http_ssrf_blocked");
  }

  // ---------- 裸 HTTP fetch（浏览器级 headers + 硬超时） ----------
  let response: Response;
  try {
    response = await fetchImpl(serpUrl, {
      headers: httpSerpHeaders(engine),
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 超时 / 网络错 → unknown（escalation-safe：不内嵌原始错误原文）
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout =
      e instanceof Error &&
      (e.name === "TimeoutError" || e.name === "AbortError" || /timed?\s?out|aborted/i.test(msg));
    logger.warn({ evt: "serp_http_fetch_failed", engine, error: msg.slice(0, 200) });
    return unknownResult(
      engine,
      retrievalMethod,
      isTimeout ? "serp_http_timeout" : "serp_http_fetch_failed",
    );
  }

  // ---------- 状态码分诊（escalation-safe 桶命名；parse22 §1.4） ----------
  const status = response.status;
  if (status !== 200) {
    // 读 body 供健康监测记 miss（与 browse 层「挑战页 preview 走抽取 → miss」同语义；
    // 读失败不阻断分诊）。
    let errBody = "";
    try {
      errBody = await response.text();
    } catch {
      /* body 读失败不影响分诊 */
    }
    if (errBody) {
      opts.serpHealth?.onResult(engine, "v1", query, errBody, false);
    }
    logger.info({ evt: "serp_http_non_200", engine, status });
    if (status === 202) {
      // DDG anomaly 挑战页实测形态（doc/governance/02：html.duckduckgo.com 202）
      return unknownResult(engine, retrievalMethod, "serp_http_challenge");
    }
    if (status === 429) {
      return unknownResult(engine, retrievalMethod, "serp_http_rate_limited");
    }
    if (status >= 500) {
      return unknownResult(engine, retrievalMethod, "serp_http_upstream_error");
    }
    // 其余非 200（401/403/404…）：裸 HTTP 被挡恰是「真浏览器或许能过」的信号 →
    // unknown 升链，绝不落 didnt（tri-state 诚实）
    return unknownResult(engine, retrievalMethod, "serp_http_engine_blocked");
  }

  // ---------- body 读取（带上界保护） ----------
  let html: string;
  try {
    html = await response.text();
  } catch (e) {
    logger.warn({ evt: "serp_http_body_read_failed", engine, error: String(e).slice(0, 200) });
    return unknownResult(engine, retrievalMethod, "serp_http_fetch_failed");
  }
  if (!html || html.length === 0) {
    return unknownResult(engine, retrievalMethod, "serp_http_empty");
  }
  if (html.length > 2_000_000) {
    // 异常巨页（SE 不会发这么大 SERP）——按空探处理升链
    return unknownResult(engine, retrievalMethod, "serp_http_empty");
  }

  // ---------- 软挡检测：重定向偏离 SERP 路径（verify 真机修订 2026-08-17） ----------
  // 真机证据：百度对无 cookie 裸 HTTP 302 → wappass.baidu.com 图形验证码 / 或退回
  // 首页壳（200 + 全导航链接、0 自然结果）——三既有闸门全漏：状态 200、无
  // Cloudflare marker（百度不用 CF）、抽取 count>0（导航链接被当结果）。结果
  // 是「worked + 17 条 hao123/登录/帮助垃圾」的伪造成功，browse_headless 永远
  // 不会被升。修法是**传输层形状校验**（非 marker/selector）：fetch 后终态 URL
  // 的 host/path 必须与请求的 SERP URL 一致——被重定向到验证码域/首页即软挡，
  // unknown 升浏览器复核。对三引擎通用（ddg anomaly 跳主页同理可拦）。
  const finalUrl = typeof response.url === "string" ? response.url : "";
  if (finalUrl) {
    try {
      const reqUrl = new URL(serpUrl);
      const resUrl = new URL(finalUrl);
      if (resUrl.host !== reqUrl.host || resUrl.pathname !== reqUrl.pathname) {
        logger.info({
          evt: "serp_http_redirect_blocked",
          engine,
          requested: `${reqUrl.host}${reqUrl.pathname}`,
          final: `${resUrl.host}${resUrl.pathname}`,
        });
        return unknownResult(engine, retrievalMethod, "serp_http_redirect_blocked");
      }
    } catch {
      // URL 解析异常不阻断（保守：继续走既有闸门）
    }
  }

  // ---------- bot 探测（复用 CLOUDFLARE_DETECTION_REGEX；不造第二套 marker） ----------
  if (CLOUDFLARE_DETECTION_REGEX.test(html)) {
    logger.info({ evt: "serp_http_bot_detected", engine });
    // 被挡也是 miss（与 browse 层挑战页语义一致——喂给健康监测）
    opts.serpHealth?.onResult(engine, "v1", query, html, false);
    return unknownResult(engine, retrievalMethod, "serp_http_bot_detected");
  }

  // ---------- HTML → a11y 快照形文本 → 复用抽取（parse22 §1.2 步骤 7-8） ----------
  let flattened: string;
  try {
    flattened = serpHtmlToSnapshotText(html);
  } catch (e) {
    // turndown 彻底挂（引擎异常）→ unknown 升链
    logger.warn({ evt: "serp_http_extract_engine_failed", engine, error: String(e).slice(0, 200) });
    return unknownResult(engine, retrievalMethod, "serp_http_extract_failed");
  }

  const data = extractResultsFromSnapshot(flattened, query);
  // 字段诚实（parse22 §1.2 步骤 9）：engine/region 显式标，不沿用 CJK 启发式默认
  data.engine = `serp_http_${engine}`;
  data.region = engine === "baidu" ? "cn" : "us";

  // ---------- 改版检测 / 命中率（复用 SerpHealthMonitor 原链路） ----------
  opts.serpHealth?.onResult(engine, "v1", query, html, data.count > 0);

  // ---------- tri-state 收口：空 → unknown 升浏览器复核（不伪造） ----------
  if (data.count === 0) {
    return unknownResult(engine, retrievalMethod, "serp_http_empty");
  }

  return {
    outcome: "worked",
    data,
    served_by: `serp_http:${engine}`,
    fallback_used: true,
    retrieval_method: retrievalMethod,
  };
}

/** unknown 快捷构造（escalation-safe error 只用固定枚举字符串）。 */
function unknownResult(
  engine: SerpEngine,
  retrievalMethod: string,
  error: string,
): InteractResult<SearchResult> {
  return {
    outcome: "unknown",
    data: null,
    served_by: `serp_http:${engine}`,
    fallback_used: true,
    retrieval_method: retrievalMethod,
    error,
  };
}

// ============================================================
// 主入口（parse22 §1.3：与 serpScrapeFallback 同策略 + S-4 级联）
// ============================================================
/**
 * rawSerpSearch：裸 HTTP SERP 快探。
 *
 *  - CJK query    → baidu 单发（S-4 红线：百度路径不动）
 *  - 非 CJK query → ddg 先发；`outcome !== "worked" || count === 0` → brave 一次
 *    bail-out 级联（202 挑战 / 改版 / 空结果都落入）；brave 有结果 → 返 brave；
 *    brave 也无 → 原样返 ddg 结果（失败语义与级联前完全一致——镜像 extract.ts）
 *
 * 级联控制流镜像 serpScrapeFallback；共享基座（URL/抽取/健康监测/引擎分流）单源复用。
 */
export async function rawSerpSearch(
  query: string,
  opts: HttpSerpOptions = {},
): Promise<InteractResult<SearchResult>> {
  const engine = serpEngineForQuery(query);

  // CJK 路径（百度）不动（S-4 红线）
  if (engine === "baidu") {
    return httpEngineOnce("baidu", query, opts);
  }

  // ---------- 非 CJK：DDG → 失败/0 结果时 Brave 一次级联（v1.14 S-4 同判据） ----------
  const ddgResult = await httpEngineOnce("ddg", query, opts);

  const ddgEmpty =
    ddgResult.outcome !== "worked" || (ddgResult.data?.count ?? 0) === 0;
  if (!ddgEmpty) {
    return ddgResult; // ddg 成功 → 不级联
  }

  const braveResult = await httpEngineOnce("brave", query, opts);
  const braveHasResults =
    braveResult.outcome === "worked" && (braveResult.data?.count ?? 0) > 0;
  // brave 也无 → 原样返回 ddg 结果（失败语义与级联前完全一致，单一 bail-out）
  return braveHasResults ? braveResult : ddgResult;
}
