/**
 * BingChannel —— Bing Web Search API v7 直调（parse10 §3.1 v0.9 第三源）。
 *
 * 为什么独立 class 不抽 OpenSearchChannel 通用类（parse10 §1 决策 1；守 02 §5 R-CI-02 / R-ABS-01）：
 *  - Brave / Bing / 智谱 三源真实共性只有「都是 HTTP」一层；
 *    认证 header（X-Subscription-Token vs Ocp-Apim-Subscription-Key vs Bearer）、
 *    response 形状（web.results vs webPages.value vs search_results）、query param 名
 *    （country vs mkt vs 无）、分页上限（20 vs 50 vs MCP 内部）都不同。
 *  - 过早抽象反增缠绕（R-ABS-01 警告）—— 保 BraveChannel / BingChannel 两独立 class，
 *    代码相似度容忍。复用 BraveChannel 的 REST + ProviderConfig + QuotaLedger 范式（加 provider ≤2 处改动）。
 *
 * Bing Web Search API v7（https://api.bing.microsoft.com/v7.0/search）：
 *  - 认证：Ocp-Apim-Subscription-Key header（Azure 订阅 key，不是 Bearer）。
 *  - Query params：q / count（1-50）/ mkt（market，如 en-US / zh-CN）/ safeSearch。
 *  - Response：{ webPages: { value: [{ name, url, snippet, dateLastCrawled, ... }] } }。
 *
 * Key 池注入（INV-54 = INV-10 衍生）：每次 search 前 ledger.pickKey() 选余量最多且未 exhausted 的 Key。
 *  - 429 / quota exceeded → ledger.markExhausted(key, retryAfter)（与 BraveChannel 同范式）。
 *  - key=[] 时构造不抛（QuotaLedger 容忍空 keys 数组），isAvailable() 返 false
 *    （Azure F0 免费层不强依赖；fallback_order 仍配但 ProviderRegistry 行为等价 v0.8）。
 *
 * outcome 分类（parse10 §3.1，与 BraveChannel 同源 10 §D.1）：
 *  - 200 + 非空 webPages.value → worked
 *  - 200 + 空 value              → unknown（200 但 0 结果，10 §D.1 关键信号）
 *  - 202 + 空 body               → unknown（outcomeFromHttp）
 *  - 429 / 5xx                   → unknown（transient）+ markExhausted
 *  - 4xx（非 429）               → didnt（definitive negative）
 *  - timeout / network           → unknown（catch 兜底）
 *
 * 不变量 INV-54：**禁止** 直接读 BING_API_KEYS / BING_API_KEY env 变量，必须经 QuotaLedger。
 */
import { BaseChannel } from "./BaseChannel.js";
import type {
  ChannelStatus,
  Health,
  InteractResult,
  Outcome,
  SearchResult,
} from "../types.js";
import type { QuotaLedger } from "../config/quota-ledger.js";
import { hashKey } from "../config/quota-ledger.js";
import { outcomeFromHttp } from "../fallback/outcome.js";
import { logger } from "../util/logger.js";

// ============================================================
// 公共选项（与 BraveChannel 同构，便于 caller 复用）
// ============================================================
export interface BingOpts {
  limit: number;
  /**
   * Bing market code（如 "en-US" / "zh-CN" / "ja-JP"）。
   * 与 Brave 的 ISO 国家码不同 —— Bing 用 market 表达区域 + 语言。
   * 上层 caller 据 region 别名映射。
   */
  market: string;
  no_cache: boolean;
}

/**
 * 注入式 HTTP client，便于测试 mock fetch（与 BraveChannel 同范式）。
 * 生产走 SubprocessManager.acquireHttpClient（keep-alive 池）。
 */
export interface BingHttpClient {
  fetch: typeof fetch;
}

// ============================================================
// BingChannel
// ============================================================
export class BingChannel extends BaseChannel {
  readonly name = "search.bing";

  constructor(
    /** Bing REST endpoint：https://api.bing.microsoft.com/v7.0/search */
    private readonly endpoint: string,
    /** 多 Key 池账本（INV-54：禁直读 env，必须经 ledger）。 */
    private readonly ledger: QuotaLedger,
    /** HTTP client（注入，便于测试 mock；生产走 SubprocessManager.acquireHttpClient）。 */
    private readonly httpClient: BingHttpClient,
  ) {
    super();
  }

  async isAvailable(): Promise<boolean> {
    // 不触网：只看 ledger 是否还有可用 Key + endpoint 合法。
    // key=[] 时 hasAvailableKey 返 false → isAvailable=false（构造不抛，INV-54 容忍空 keys）。
    return this.endpoint.startsWith("https://") && this.ledger.hasAvailableKey();
  }

  async status(): Promise<ChannelStatus> {
    if (!(await this.isAvailable())) {
      return {
        available: false,
        note: "Bing key exhausted or endpoint invalid",
      };
    }
    // 触网只做最小 query 探活（与 BraveChannel.status 同范式）。
    try {
      const t0 = Date.now();
      const key = this.ledger.pickKey();
      if (!key) {
        return { available: false, note: "no available key (race)" };
      }
      const r = await this._doRequest("ping", 1, "en-US", key);
      // outcome "didnt" 也算"endpoint 活着但查询无结果"，仍视为 available（HTTP 通道正常）。
      const available = r.outcome !== "unknown";
      return {
        available,
        latency_ms: Date.now() - t0,
        note: available ? undefined : `status=${r.status}`,
      };
    } catch (e) {
      return { available: false, note: String(e) };
    }
  }

  async healthCheck(): Promise<Health> {
    const s = await this.status();
    if (!s.available) return "down";
    if (s.latency_ms !== undefined && s.latency_ms > 2000) return "degraded";
    return "healthy";
  }

  /**
   * 调一次 Bing Web Search。
   * 永不抛异常——所有路径走 InteractResult（与 BraveChannel.search 同范式）。
   */
  async search(
    query: string,
    opts: BingOpts,
  ): Promise<InteractResult<SearchResult>> {
    if (!(await this.isAvailable())) {
      return {
        outcome: "unknown",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "bing_api",
        error: "bing_keys_exhausted",
      };
    }
    const key = this.ledger.pickKey();
    if (!key) {
      // isAvailable 之后又一次 pickKey 返 null（race / rollover 边界）——直接 unknown。
      return {
        outcome: "unknown",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "bing_api",
        error: "bing_keys_exhausted",
      };
    }

    try {
      const { outcome, data, status, retryAfter } = await this._doRequest(
        query,
        opts.limit,
        opts.market,
        key,
      );

      if (status === 429) {
        // V3 风险：Retry-After 缺失则保守 60s（与 BraveChannel 同范式，避免短重试连环 429）。
        // _doRequest 返的 retryAfter 是 offset (ms)，markExhausted 要绝对 epoch ms。
        const resetAt = retryAfter
          ? Date.now() + retryAfter
          : Date.now() + 60_000;
        this.ledger.markExhausted(key, resetAt);
        logger.warn({
          evt: "bing_429",
          key_hash: hashKey(key),
          retry_after_ms: retryAfter,
        });
      } else if (outcome === "worked") {
        this.ledger.recordSuccess(key, 1);
      }

      return {
        outcome,
        data:
          outcome === "worked"
            ? {
                query,
                results: data ?? [],
                count: data?.length ?? 0,
                engine: "bing",
                region: opts.market,
              }
            : null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "bing_api",
        error: outcome === "worked" ? undefined : `bing_status_${status}`,
      };
    } catch (e) {
      const msg = String(e);
      logger.warn({ evt: "bing_call_error", key_hash: hashKey(key), error: msg });
      return {
        outcome: "unknown",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "bing_api",
        error: msg,
      };
    }
  }

  // ============================================================
  // 私有：单次 HTTP 调用 + outcome 判定
  // ============================================================
  private async _doRequest(
    query: string,
    count: number,
    market: string,
    key: string,
  ): Promise<{
    outcome: Outcome;
    data: SearchResult["results"] | null;
    status: number;
    retryAfter?: number;
  }> {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(count, 50))); // Bing 单次 max 50
    url.searchParams.set("mkt", market);
    // safeSearch=Off 让结果是未经 adult 过滤的「原始 SERP」（与 Brave 同语义层级；上层可配）。
    url.searchParams.set("safeSearch", "Moderate");
    url.searchParams.set("textDecorations", "false");
    url.searchParams.set("textFormat", "Raw");

    const resp = await this.httpClient.fetch(url, {
      headers: {
        // Bing v7 认证：Ocp-Apim-Subscription-Key header（不是 Bearer）。
        "Ocp-Apim-Subscription-Key": key,
        Accept: "application/json",
        // Bing 要求 bing-api-market 头（部分 region 需）—— 不强制，缺省走 mkt param。
      },
      // 10s 超时（与 BraveChannel 同范式；V5 风险缓解）。
      signal: AbortSignal.timeout(10_000),
    });

    const retryAfterHeader = resp.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader
      ? parseInt(retryAfterHeader, 10) * 1000
      : undefined;

    if (resp.status === 429) {
      // 429 优先返回（body 可能缺，不浪费解析）。
      return { outcome: "unknown", data: null, status: 429, retryAfter: retryAfterMs };
    }

    const body = await resp.json().catch(() => null);
    const outcome = outcomeFromHttp(resp.status, body);
    if (outcome !== "worked") {
      return { outcome, data: null, status: resp.status };
    }

    // 200 + 非空 body：解析 Bing 形状 → 如果 webPages.value 为空，降级 unknown（10 §D.1）。
    const results = parseBingResults(body);
    return {
      outcome: results.length === 0 ? "unknown" : "worked",
      data: results,
      status: resp.status,
    };
  }
}

// ============================================================
// Bing 响应解析（parse10 §3.1）
// ============================================================
/**
 * Bing Web Search API v7 响应形状：
 *   {
 *     _type: "SearchResponse",
 *     webPages: {
 *       webSearchUrl: "...",
 *       totalEstimatedMatches: 123,
 *       value: [
 *         { id, name, url, isFamilyFriendly, displayUrl, snippet,
 *           dateLastCrawled, language, isNavigational, ... }
 *       ]
 *     },
 *     images: { ... }, news: { ... }, ...
 *   }
 *
 * 兼容多种 key（V2 风险：API 形状可能变）：
 *  - title = name ?? title（name 是 Bing 规范字段，title 兜底）
 *  - snippet = snippet ?? description
 *  - source = displayUrl 的 host（Bing 无 profile.name；从 url 推 host）
 *  - 过滤 url 缺失项（不健康的 result，与 parseBraveResults 同范式）
 */
export function parseBingResults(body: unknown): SearchResult["results"] {
  if (!body || typeof body !== "object") return [];
  const webPages = (body as { webPages?: unknown }).webPages;
  if (!webPages || typeof webPages !== "object") return [];
  const arr = (webPages as { value?: unknown }).value;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => {
      const item = r as Record<string, unknown>;
      const url = String(item.url ?? "");
      let source: string | undefined;
      // 从 url 推 host 作为 source（Bing 无 Brave 的 profile.name）
      if (url) {
        try {
          source = new URL(url).host;
        } catch {
          source = undefined;
        }
      }
      return {
        title: String(item.name ?? item.title ?? ""),
        url,
        snippet: String(item.snippet ?? item.description ?? ""),
        source,
      };
    })
    .filter((r) => r.url);
}
