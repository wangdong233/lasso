/**
 * fetch_url tool 注册（parse6 §3.1 v0.5 M0.5a 新增）
 *
 * 单一独立 HTTP 抓取工具 —— 不开浏览器、不渲染 JS、不带 cookie、不 fallback。
 *
 * 与 browse_headless 的边界（parse6 §1.4 决策表）：
 *  - fetch_url 给原始字节（HTML 源码 / JSON / 文本 / 二进制），browse_headless 给渲染后 DOM
 *  - fetch_url 是 caller-tier 工具，不挂 FallbackDecider 链（INV-23 衍生：禁 fetch ↔ browse 互 fallback）
 *  - 反爬站点（Cloudflare）必走 browse_headless / browserbase；fetch 必被拦（无 JS 指纹）
 *
 * 铁律（parse6 §1.5 + §4.1）：
 *  - SSRF 必经：与 browse_headless 同函数同 config 对象（INV-31）
 *  - 连接池必经：经 SubprocessManager.acquireHttpClient，禁 new Agent / 禁裸 fetch（INV-32）
 *  - redirect:"manual"：3xx 不跟随，返 location 给 caller 二次显式调用（防 169.254.169.254 元数据绕过）
 *  - bounded output：响应 body 经 applyOutputEnvelope，>48KiB 自动落盘 .txt（INV-15 衍生 INV-34 同源）
 *
 * 借鉴：
 *  - browse.ts::registerBrowseTools（ssrfBlocked / browseResultContent 包装范式）
 *  - BraveChannel._doRequest（httpClient.fetch + AbortController 范式）
 *  - parse6 §3.1.2-3 伪码（结构原样照搬）
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  FetchUrlOptions,
  FetchUrlResult,
  InteractResult,
} from "../types.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { ssrfGuard, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { applyOutputEnvelope } from "../util/output-envelope.js";
import { routeContentType } from "../browse/content-type-router.js";
import { FETCH_URL_DESCRIPTION } from "./descriptions.js";
import { fetchUrlAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";

// ============================================================
// Schema（parse6 §3.1.2）
// ============================================================
export const fetchUrlSchema = {
  url: z.string().url(),
  options: z
    .object({
      // v0.5 只支持 GET / HEAD；POST/PUT 推 v0.6 评估（守边界，避免无脑扩攻击面）
      method: z.enum(["GET", "HEAD"]).default("GET"),
      // 用户自定义 header（User-Agent / Accept / Authorization 等）。
      // fetch_url 不主动加 Authorization / Cookie —— caller 显式 opt-in（parse6 §6.5）。
      headers: z.record(z.string()).optional(),
      timeout_ms: z.number().int().positive().max(60_000).default(30_000),
      // 单条上限 16 MiB（与 output-envelope SINGLE_CAP 对齐，超限截断 + didnt）
      max_bytes: z
        .number()
        .int()
        .positive()
        .max(16 * 1024 * 1024)
        .default(2 * 1024 * 1024),
      no_cache: z.boolean().default(false),
    })
    .default({}),
};

// ============================================================
// 包装 helper（与 browse.ts 同范式）
// ============================================================
function payloadContent<T>(result: InteractResult<T>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}

// ============================================================
// 核心：doFetchUrl（独立可测，parse6 §3.1.3 实装）
// ============================================================
/**
 * fetch_url 的纯函数实装 —— 单元测直接调，不经 MCP server.tool 装配。
 *
 * 流程（parse6 §3.1.3 伪码逐条对齐）：
 *  1. SSRF 守门（INV-31）—— 与 browse_headless 同函数同 config
 *  2. 取 host 专属 keep-alive client（INV-32）—— 经 SubprocessManager.acquireHttpClient
 *  3. 发请求（method + headers + timeout；redirect:"manual"）
 *  4. 响应大小硬上限（content-length > max_bytes → didnt 提前返回）
 *  5. content-type 分流（content-type-router.ts）
 *  6. body 解码 + applyOutputEnvelope
 *  7. 返 InteractResult<FetchUrlResult>
 */
export async function doFetchUrl(
  rawUrl: string,
  opts: FetchUrlOptions,
  subproc: SubprocessManager,
  ssrfConfig: SsrfConfig,
): Promise<InteractResult<FetchUrlResult>> {
  // ---------- 1. SSRF 守门（INV-31；与 browse_headless 同函数同 config） ----------
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

  // ---------- 2. 取 host 专属 keep-alive client（INV-32） ----------
  // origin 含 scheme + host（可选 :port），不含 path/query —— 与 SubprocessManager 装配 BraveChannel 同源
  let origin: string;
  try {
    origin = new URL(rawUrl).origin;
  } catch {
    // ssrfGuard 已经过 URL 解析，理论不可达；兜底 didnt
    return {
      outcome: "didnt",
      data: null,
      served_by: "fetch_url",
      fallback_used: false,
      retrieval_method: "invalid_url",
      error: "invalid_url_post_ssrf",
    };
  }
  const httpClient = subproc.acquireHttpClient(origin);

  // ---------- 3. 发请求（method + headers + timeout；redirect:"manual"） ----------
  // 自报身份 lasso-mcp/0.5（不伪装浏览器；与 browse_headless 默认 UA 区分，避免反爬误判）
  const reqHeaders: Record<string, string> = {
    "User-Agent": "lasso-mcp/0.5 (fetch_url)",
    Accept: "*/*",
    ...(opts.no_cache ? { "Cache-Control": "no-cache" } : {}),
    ...opts.headers,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout_ms);

  let resp: Response;
  try {
    resp = await httpClient.fetch(rawUrl, {
      method: opts.method,
      headers: reqHeaders,
      signal: controller.signal,
      // parse6 §4.1：拒跟随重定向，防 SSRF 绕过（200 OK → 302 → 169.254.169.254 元数据）
      // undici 7.x 已验证返 status=30x + headers.get("location")（实测 2026-07-22）
      redirect: "manual",
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = String(e);
    logger.warn({ evt: "fetch_url_error", url: rawUrl, error: msg });
    return {
      outcome: outcomeFromFetchError(e),
      data: null,
      served_by: "fetch_url",
      fallback_used: false,
      retrieval_method: "undici_keepalive",
      error: msg,
    };
  }
  clearTimeout(timer);

  // ---------- 3a. 3xx manual redirect → didnt + location（caller 二次显式调） ----------
  // undici 7.x 在 redirect:"manual" 下返 status=30x + Location header（实测）。
  // 守 SSRF：不在 fetch 层重做 SSRF 守卫（R-CI-02：不新造范式）；让 caller 二次 fetch_url 时再过 SSRF。
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get("location") ?? "";
    const result: InteractResult<FetchUrlResult> = {
      outcome: "didnt",
      data: {
        url: rawUrl,
        final_url: rawUrl,
        status: resp.status,
        content_type: resp.headers.get("content-type") ?? "",
        body_kind: "redirect",
        body_bytes: 0,
        ...(location ? { location } : {}),
      },
      served_by: "fetch_url",
      fallback_used: false,
      retrieval_method: "redirect_not_followed",
      ...(location ? {} : { error: `redirect_${resp.status}_no_location` }),
    };
    return result;
  }

  // ---------- 4. 响应大小硬上限（content-length > max_bytes） ----------
  const contentLengthHdr = resp.headers.get("content-length");
  if (contentLengthHdr !== null) {
    const cl = parseInt(contentLengthHdr, 10);
    if (Number.isFinite(cl) && cl > opts.max_bytes) {
      return {
        outcome: "didnt",
        data: {
          url: rawUrl,
          final_url: rawUrl,
          status: resp.status,
          content_type: resp.headers.get("content-type") ?? "",
          body_kind: "oversize",
          body_bytes: cl,
        },
        served_by: "fetch_url",
        fallback_used: false,
        retrieval_method: "max_bytes_exceeded",
        error: `content_length_exceeds_max:${cl}>${opts.max_bytes}`,
      };
    }
  }

  // ---------- 5. content-type 分流 ----------
  const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
  const route = routeContentType(contentType);

  // 读 body（HEAD 请求通常 0 字节；2xx/4xx/5xx 都读以便 4xx 给 caller 看 body）
  let bodyBuf: ArrayBuffer;
  try {
    bodyBuf = await resp.arrayBuffer();
  } catch (e) {
    const msg = String(e);
    return {
      outcome: "unknown",
      data: null,
      served_by: "fetch_url",
      fallback_used: false,
      retrieval_method: "undici_keepalive",
      error: `body_read_failed:${msg}`,
    };
  }

  // 二次校验实际字节（content-length 可能缺失 / 不准）
  if (bodyBuf.byteLength > opts.max_bytes) {
    return {
      outcome: "didnt",
      data: {
        url: rawUrl,
        final_url: rawUrl,
        status: resp.status,
        content_type: contentType,
        body_kind: "oversize",
        body_bytes: bodyBuf.byteLength,
      },
      served_by: "fetch_url",
      fallback_used: false,
      retrieval_method: "max_bytes_exceeded",
      error: `body_exceeds_max:${bodyBuf.byteLength}>${opts.max_bytes}`,
    };
  }

  // ---------- 6. 按 route 解码 + applyOutputEnvelope ----------
  let bodyText: string;
  let bodyKind: string;
  if (route.kind === "binary") {
    bodyText = Buffer.from(bodyBuf).toString("base64");
    bodyKind = `binary:${route.subtype ?? "octet-stream"}`;
  } else if (route.kind === "json") {
    bodyText = new TextDecoder("utf-8").decode(bodyBuf);
    bodyKind = "json";
  } else {
    bodyText = new TextDecoder("utf-8").decode(bodyBuf);
    bodyKind = route.kind; // "html" | "text"
  }

  // envelope（48KiB / 2000 行自动落盘 .txt + 16KiB preview + @oN ref）
  // INV-34 同源：所有独立 tool 输出必经 applyOutputEnvelope 或 writeState
  const envelope = applyOutputEnvelope(
    bodyText,
    "fetch_url: narrow by URL path or use Range header to reduce size",
  );

  // ---------- 7. 返 InteractResult<FetchUrlResult> ----------
  // 4xx = didnt（明确语义）；2xx = worked；5xx = unknown（transient，caller-tier 决定）
  const outcome = resp.ok ? "worked" : resp.status >= 500 ? "unknown" : "didnt";
  const result: InteractResult<FetchUrlResult> = {
    outcome,
    data: {
      url: rawUrl,
      final_url: rawUrl, // redirect:"manual" 下无跟随，final_url === url（3xx 上面已早返）
      status: resp.status,
      content_type: contentType,
      body_kind: bodyKind,
      body_bytes: bodyBuf.byteLength,
      envelope,
    },
    served_by: "fetch_url",
    fallback_used: false,
    retrieval_method: "undici_keepalive",
    ...(outcome === "worked" ? {} : { error: `http_${resp.status}` }),
  };
  return result;
}

/**
 * fetch 错误 → tri-state outcome（parse6 §3.1.3 outcomeFromFetchError）。
 *  - ENOTFOUND / NXDOMAIN → didnt（明确「这个 host 不存在」）
 *  - abort / timeout      → unknown（caller-tier 可重试）
 *  - 其他（网络挂 / 连接重置 / TLS） → unknown
 */
function outcomeFromFetchError(e: unknown): "didnt" | "unknown" {
  const m = String(e).toLowerCase();
  if (m.includes("enotfound") || m.includes("nxdomain")) return "didnt";
  if (m.includes("econnrefused")) return "didnt";
  // AbortError（controller.abort）/ timeout → unknown（transient）
  return "unknown";
}

// ============================================================
// 注册器（parse6 §3.1.2）
// ============================================================
/**
 * @param server     MCP server
 * @param subproc    SubprocessManager（acquireHttpClient 拿 undici keep-alive Agent）
 * @param ssrfConfig SSRF allowRanges / denyRanges（从 env 加载，与 browse_headless 共用）
 */
export function registerFetchUrlTool(
  server: McpServer,
  subproc: SubprocessManager,
  ssrfConfig: SsrfConfig,
): void {
  server.tool(
    "fetch_url",
    FETCH_URL_DESCRIPTION,
    fetchUrlSchema,
    fetchUrlAnnotations,
    async (args) => {
      const url: string = args.url;
      // zod .default({}) 已注入所有默认值；headers undefined → undefined（TextEncoder 容忍）
      const opts: FetchUrlOptions = {
        method: args.options.method,
        headers: args.options.headers,
        timeout_ms: args.options.timeout_ms,
        max_bytes: args.options.max_bytes,
        no_cache: args.options.no_cache,
      };

      const result = await doFetchUrl(url, opts, subproc, ssrfConfig);
      // doFetchUrl 把 ssrf_blocked / 4xx / 5xx / 2xx 都包成 InteractResult；
      // 这里只需序列化。SSRF 拒绝风格与 browse.ts::ssrfBlocked 同构（同 served_by / retrieval_method）。
      return payloadContent(result);
    },
  );
}
