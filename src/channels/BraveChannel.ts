/**
 * BraveChannel —— Brave Search REST API 直调（parse2 §3.2 + §4.1）。
 *
 * 为什么 REST 不 MCP（parse2 §4.1）：
 *  - Brave 官方提供 REST（GET https://api.search.brave.com/res/v1/web/search），
 *    认证走 `X-Subscription-Token` header（不是 Bearer）。
 *  - 与智谱 streamable-http 在 Lasso 内同抽象（都是 HTTP 直调），
 *    不增加 SubprocessManager 进程。community brave-search-mcp 是额外 wrapper，无收益。
 *
 * Key 池注入（INV-10 + parse2 §3.2.1 / §4.2）：
 *  - 每次 search 前 `ledger.pickKey()` 选余量最多且未 exhausted 的 Key（贪心）。
 *  - 429 / quota exceeded → `ledger.markExhausted(key, retryAfter)` 短期禁用该 Key；
 *    其他 Key 仍可用（多 Key 合并 = N×2000/月，验收 #2）。
 *  - 全部 Key exhausted → pickKey 返 null → isAvailable() 返 false → fallback 链触发。
 *
 * 不变量 INV-10：**禁止** 直接读 BRAVE_API_KEYS env 变量，必须经 QuotaLedger。
 *
 * 429 + Retry-After（parse2 §3.2 V3 风险）：
 *  - Retry-After header 缺失时 fallback `now + 60s`（保守值，避免短重试连环 429）。
 *  - markExhausted 取「现有 resetAt」与「传入 resetAt」较大值（不回滚长熔断）。
 *
 * outcome 分类（parse2 §3.2 + §4.1 + 10 §D.1）：
 *  - 200 + 非空 web.results → worked
 *  - 200 + 空 results        → unknown（关键信号：200 但 0 结果，10 §D.1）
 *  - 202 + 空 body           → unknown（outcomeFromHttp）
 *  - 429 / 5xx               → unknown（transient）+ markExhausted
 *  - 4xx（非 429）           → didnt（definitive negative）
 *  - timeout / network       → unknown（catch 兜底）
 *
 * Brave 引用仅三项硬数据（10 §4.3）：669ms / 14.89 Agent Score / 2000/月。
 * 是否真主力由 in-house A/B 实测决定（benchmark/run-ab-benchmark.ts）。
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
// 公共选项
// ============================================================
export interface BraveOpts {
  limit: number;
  /** "CN" / "US" / "ALL"（Brave 用 ISO 国家码）。 */
  region: string;
  no_cache: boolean;
}

/**
 * 注入式 HTTP client，便于测试 mock fetch。
 * SubprocessManager.acquireHttpClient 返回 keep-alive 版；测试返 vi.fn().
 */
export interface BraveHttpClient {
  fetch: typeof fetch;
}

// ============================================================
// BraveChannel
// ============================================================
export class BraveChannel extends BaseChannel {
  readonly name = "search.brave";

  constructor(
    /** Brave REST endpoint：https://api.search.brave.com/res/v1/web/search */
    private readonly endpoint: string,
    /** 多 Key 池账本（INV-10：禁直读 env，必须经 ledger）。 */
    private readonly ledger: QuotaLedger,
    /** HTTP client（注入，便于测试 mock；生产走 SubprocessManager.acquireHttpClient）。 */
    private readonly httpClient: BraveHttpClient,
  ) {
    super();
  }

  async isAvailable(): Promise<boolean> {
    // 不触网：只看 ledger 是否还有可用 Key + endpoint 合法。
    return this.endpoint.startsWith("https://") && this.ledger.hasAvailableKey();
  }

  async status(): Promise<ChannelStatus> {
    if (!(await this.isAvailable())) {
      return {
        available: false,
        note: "Brave key exhausted or endpoint invalid",
      };
    }
    // 触网只做最小 query 探活（实际无 list 端点 → ping 类轻量查询）。
    try {
      const t0 = Date.now();
      const key = this.ledger.pickKey();
      if (!key) {
        return { available: false, note: "no available key (race)" };
      }
      const r = await this._doRequest("ping", 1, "ALL", key);
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
   * 调一次 Brave Web Search。
   * 永不抛异常——所有路径走 InteractResult。
   */
  async search(
    query: string,
    opts: BraveOpts,
  ): Promise<InteractResult<SearchResult>> {
    if (!(await this.isAvailable())) {
      return {
        outcome: "unknown",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "brave_api",
        error: "brave_keys_exhausted",
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
        retrieval_method: "brave_api",
        error: "brave_keys_exhausted",
      };
    }

    try {
      const { outcome, data, status, retryAfter } = await this._doRequest(
        query,
        opts.limit,
        opts.region,
        key,
      );

      if (status === 429) {
        // V3 风险：Retry-After 缺失则保守 60s（避免短重试连环 429）。
        // _doRequest 返的 retryAfter 是 offset (ms)，markExhausted 要绝对 epoch ms。
        const resetAt = retryAfter
          ? Date.now() + retryAfter
          : Date.now() + 60_000;
        this.ledger.markExhausted(key, resetAt);
        logger.warn({
          evt: "brave_429",
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
                engine: "brave",
                region: opts.region,
              }
            : null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "brave_api",
        error: outcome === "worked" ? undefined : `brave_status_${status}`,
      };
    } catch (e) {
      const msg = String(e);
      logger.warn({ evt: "brave_call_error", key_hash: hashKey(key), error: msg });
      return {
        outcome: "unknown",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "brave_api",
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
    country: string,
    key: string,
  ): Promise<{
    outcome: Outcome;
    data: SearchResult["results"] | null;
    status: number;
    retryAfter?: number;
  }> {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(count, 20))); // Brave 单次 max 20
    url.searchParams.set("country", country);

    const resp = await this.httpClient.fetch(url, {
      headers: {
        "X-Subscription-Token": key,
        Accept: "application/json",
      },
      // 10s 超时（V5 风险缓解：避免 Promise.allSettled 慢源阻塞）
      signal: AbortSignal.timeout(10_000),
    });

    const retryAfterHeader = resp.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader
      ? parseInt(retryAfterHeader, 10) * 1000
      : undefined;

    if (resp.status === 429) {
      // 429 优先返回（body 可能缺，不浪费解析）
      return { outcome: "unknown", data: null, status: 429, retryAfter: retryAfterMs };
    }

    const body = await resp.json().catch(() => null);
    const outcome = outcomeFromHttp(resp.status, body);
    if (outcome !== "worked") {
      return { outcome, data: null, status: resp.status };
    }

    // 200 + 非空 body：解析 Brave 形状 → 如果 web.results 为空，降级 unknown（10 §D.1）。
    const results = parseBraveResults(body);
    return {
      outcome: results.length === 0 ? "unknown" : "worked",
      data: results,
      status: resp.status,
    };
  }
}

// ============================================================
// Brave 响应解析（parse2 §3.2 / §4.1）
// ============================================================
/**
 * Brave Web Search 响应形状：
 *   { web: { results: [{ title, url, description, profile: { name }, ... }] }, query: {...} }
 *
 * 兼容多种 key（V2 风险：API 形状可能变）：
 *  - snippet = description ?? snippet（两者都见过）
 *  - source = profile?.name（部分结果无 profile）
 *  - 过滤 url 缺失项（不健康的 result）
 */
export function parseBraveResults(body: unknown): SearchResult["results"] {
  if (!body || typeof body !== "object") return [];
  const web = (body as { web?: unknown }).web;
  if (!web || typeof web !== "object") return [];
  const arr = (web as { results?: unknown }).results;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => {
      const item = r as Record<string, unknown>;
      const profile = item.profile as Record<string, unknown> | undefined;
      return {
        title: String(item.title ?? ""),
        url: String(item.url ?? ""),
        snippet: String(item.description ?? item.snippet ?? ""),
        source: profile?.name != null ? String(profile.name) : undefined,
      };
    })
    .filter((r) => r.url);
}
