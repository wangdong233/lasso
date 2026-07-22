/**
 * wayback_lookup tool 注册（parse10 §3.3 v0.9 Phase A —— 独立 tool）。
 *
 * **关键设计决策（parse10 §1 决策 3 + INV-58）**：
 *  - wayback 死链救援是 **独立 tool**（wayback_lookup），**不自动探测** search result 死链
 *    （守横切关注点边界 INV-58）。CC 看到 search result URL 404 / timeout 时显式调本 tool。
 *  - search 主路径（tools/search.ts / MultiSourceFanout.ts）**不调用** 本 tool。
 *
 * 为什么独立 tool 不内置（守简单性 02 §5 + 横切关注点）：
 *  - search 的职责是「返回 query → 结果列表」，死链判定是后续 caller-tier 的事；
 *    若 search 自动对每条 result 探测死链 + 自动调 wayback，等于在 search 主路径里
 *    塞了「N 次额外 HTTP 调用 + N 次探测 + N 次回填」，延迟和成本失控。
 *  - 独立 tool 让 CC 显式控制「何时救死链」—— 通常只在用户点击/关注某条 URL 失败时才调。
 *
 * SSRF 守门（parse10 §3.3 + INV-56 = INV-31 同源）：
 *  - 用户传入的 url 必经 ssrfGuard（守 fetch_url 同范式）—— 即便只是传给 archive.org 当 query
 *    参数，也要拒私网 URL（防 archive.org 成为 SSRF 探测代理 + 防内部 URL 泄漏到 archive.org 日志）。
 *  - archive.org API URL 本身是公网知名 host，走 doFetchUrl 内部 SSRF（同 fetch_url 范式）。
 *
 * 不变量 INV-56：本 tool 必经 ssrfGuard + doFetchUrl（grep `ssrfGuard(` + `doFetchUrl(`）。
 *
 * 复用范式：
 *  - tools/fetch-url.ts::doFetchUrl（HTTP 抓取 + bounded output + SSRF 内嵌）
 *  - ssrf/ssrf-guard.ts::ssrfGuard（与 browse_headless 同函数同 config）
 *
 * 借鉴：parse10 §3.3；fetch-url.ts（doFetchUrl 范式）；browse.ts（payloadContent 包装）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InteractResult } from "../types.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { ssrfGuard, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { doFetchUrl } from "./fetch-url.js";
import { WAYBACK_DESCRIPTION } from "./descriptions.js";
import { waybackAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";

// ============================================================
// Schema（parse10 §3.3）
// ============================================================
export const waybackSchema = {
  url: z.string().url(),
};

// ============================================================
// 包装 helper（与 fetch-url.ts 同范式）
// ============================================================
function payloadContent<T>(result: InteractResult<T>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}

// ============================================================
// Wayback API 形状（https://archive.org/wayback/available）
// ============================================================
/**
 * Response 形状：
 *   {
 *     "url": "example.com",
 *     "archived_snapshots": {
 *       "closest": {
 *         "available": true,
 *         "url": "http://web.archive.org/web/20240101000000/http://example.com",
 *         "timestamp": "20240101000000",
 *         "status": "200"
 *       }
 *     }
 *   }
 *
 * 无 snapshot 时：archived_snapshots: {}（空对象）或 closest 缺失。
 */
interface WaybackAvailableResponse {
  url?: string;
  archived_snapshots?: {
    closest?: {
      available?: boolean;
      url?: string;
      timestamp?: string;
      status?: string;
    };
  };
}

// ============================================================
// 返回数据形状
// ============================================================
export interface WaybackLookupResult {
  /** 用户输入的原始 URL（必回显，便于 caller 对齐） */
  url: string;
  /** 是否在 wayback 找到可用 snapshot（INV-58 attributed 标记：archived:true/false） */
  archived: boolean;
  /** wayback snapshot URL（archived=true 时填，caller 二次调 fetch_url 取内容） */
  snapshot_url?: string;
  /** snapshot 抓取时刻（YYYYMMDDhhmmss 字符串） */
  snapshot_timestamp?: string;
  /** snapshot 抓取时的 HTTP status（"200" / "404" / ...） */
  snapshot_status?: string;
  /** 调用的 wayback availability API URL（便于 caller audit） */
  availability_api_url: string;
}

// ============================================================
// 核心：doWaybackLookup（独立可测，parse10 §3.3）
// ============================================================
/**
 * wayback_lookup 的纯函数实装 —— 单元测直接调，不经 MCP server.tool 装配。
 *
 * 流程（parse10 §3.3 伪码逐条对齐）：
 *  1. SSRF 守门用户 URL（INV-56；与 fetch_url 同函数同 config）
 *     即便只是传给 archive.org 当 query 参数，也拒私网 URL（防 archive.org 成为 SSRF 探测代理）。
 *  2. 构造 wayback availability API URL（https://archive.org/wayback/available?url=<encoded>）
 *  3. doFetchUrl 抓 wayback API JSON（INV-56：doFetchUrl 内部再过 SSRF —— 双重守门）
 *  4. 解析 archived_snapshots.closest → archived:true/false
 *  5. 返 InteractResult<WaybackLookupResult>（archived:true 标 attributed）
 */
export async function doWaybackLookup(
  rawUrl: string,
  subproc: SubprocessManager,
  ssrfConfig: SsrfConfig,
): Promise<InteractResult<WaybackLookupResult>> {
  // ---------- 1. SSRF 守门用户 URL（INV-56；与 fetch_url 同函数同 config） ----------
  // 防御：archive.org 不应成为「把私网 URL 写进第三方日志」的代理。
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

  // ---------- 2. 构造 wayback availability API URL ----------
  const availabilityApiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(rawUrl)}`;

  // ---------- 3. doFetchUrl 抓 wayback API JSON（INV-56） ----------
  // doFetchUrl 内部再过 SSRF（archive.org 是公网已知 host，会通过）；
  // 返 InteractResult<FetchUrlResult> —— 复用 bounded output + undici keep-alive 连接池。
  const fetchResult = await doFetchUrl(
    availabilityApiUrl,
    {
      method: "GET",
      timeout_ms: 15_000,
      max_bytes: 256 * 1024, // wayback availability API 响应很小（≤几 KB）；256 KiB 上限足够
      no_cache: false,
    },
    subproc,
    ssrfConfig,
  );

  // fetch 失败 → 透传 outcome（unknown / didnt 都按原语义保留）
  if (fetchResult.outcome !== "worked") {
    return {
      outcome: fetchResult.outcome,
      data: null,
      served_by: "wayback_lookup",
      fallback_used: false,
      retrieval_method: "wayback_availability_api",
      error: fetchResult.error ?? `wayback_fetch_${fetchResult.outcome}`,
    };
  }

  // ---------- 4. 解析 archived_snapshots.closest ----------
  // applyOutputEnvelope 对 ≤48KiB 响应返 truncated=false + preview=原文（wayback API
  // 响应通常几 KB，必走 inline 分支）；>48KiB 时 truncated=true，preview 仅前 16KiB。
  // wayback availability API 响应不大，但兜底处理 truncated 情形（不试图解析截断 JSON）。
  const envelope = fetchResult.data?.envelope;
  if (!envelope || envelope.truncated) {
    // 大响应理论上不会发生（wayback API 几 KB）；若真发生则视为 unknown（不可解析）
    return {
      outcome: "unknown",
      data: null,
      served_by: "wayback_lookup",
      fallback_used: false,
      retrieval_method: "wayback_availability_api",
      error: envelope ? "wayback_response_truncated" : "wayback_no_envelope",
    };
  }
  const rawBody = envelope.preview;
  let parsed: WaybackAvailableResponse | null = null;
  try {
    parsed = JSON.parse(rawBody) as WaybackAvailableResponse;
  } catch (e) {
    logger.warn({
      evt: "wayback_parse_failed",
      url: rawUrl,
      error: String(e),
    });
    return {
      outcome: "unknown",
      data: null,
      served_by: "wayback_lookup",
      fallback_used: false,
      retrieval_method: "wayback_availability_api",
      error: "wayback_response_unparseable",
    };
  }

  const closest = parsed?.archived_snapshots?.closest;
  const archived = !!(closest && closest.available === true && closest.url);

  // ---------- 5. 返 InteractResult<WaybackLookupResult> ----------
  // archived=false 也是 worked（API 成功响应，只是没 snapshot —— 不是 fetch 失败）。
  // attribution 字段 archived:true/false 让 CC 知道是否值得二次调 fetch_url 取 snapshot。
  const data: WaybackLookupResult = {
    url: rawUrl,
    archived,
    availability_api_url: availabilityApiUrl,
    ...(archived && closest
      ? {
          snapshot_url: closest.url,
          snapshot_timestamp: closest.timestamp,
          snapshot_status: closest.status,
        }
      : {}),
  };

  return {
    outcome: "worked",
    data,
    served_by: "wayback_lookup",
    fallback_used: false,
    retrieval_method: "wayback_availability_api",
    ...(archived ? {} : { error: "no_snapshot_available" }),
  };
}

// ============================================================
// 注册器（parse10 §3.3）
// ============================================================
/**
 * @param server     MCP server
 * @param subproc    SubprocessManager（doFetchUrl 经 acquireHttpClient 拿 undici keep-alive Agent）
 * @param ssrfConfig SSRF allowRanges / denyRanges（与 fetch_url / browse_headless 共用）
 *
 * 注：本 tool 的 ToolAnnotations 走 readOnlyHint + openWorldHint（与 fetch_url 同语义）。
 */
export function registerWaybackTool(
  server: McpServer,
  subproc: SubprocessManager,
  ssrfConfig: SsrfConfig,
): void {
  server.tool(
    "wayback_lookup",
    WAYBACK_DESCRIPTION,
    waybackSchema,
    waybackAnnotations,
    async (args) => {
      const result = await doWaybackLookup(args.url, subproc, ssrfConfig);
      return payloadContent(result);
    },
  );
}
