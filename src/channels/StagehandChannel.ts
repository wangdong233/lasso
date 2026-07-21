/**
 * StagehandChannel（parse5 §3.2.3 + §4.2，F3.12.2）
 *
 *  - extends UiChannel（**不 extends BrowseChannel**，因不走 CDP；parse5 §4.2 决策）
 *  - 仅 expose observe(verify|extract)，**不 act**（agent loop 越界；parse5 §3.2.1 边界）
 *  - 走 stagehand REST API：POST /verify { prompt } → bool；POST /extract { prompt, schema } → JSON
 *
 * 用途（parse5 §3.2.3）：
 *  CC 在 browse_logged_in 走完多步后，调 stagehand.verify(prompt) 做语义验证（比
 *  chrome-devtools-mcp evaluate_script 写 JS 更自然），或 stagehand.extract(prompt, schema)
 *  抽结构化数据。
 *
 * 懒连接 + 无 key 短路（与 BrowserbaseChannel 同范式）：
 *  - 构造**永不抛**（apiKey="" 也允许）
 *  - 首次 observe() 时 preflight apiKey → 缺 → outcome=didnt + cloud_no_key
 *  - act() 显式返 outcome=didnt + retrieval_method=stagehand_observe_only（边界明示）
 *
 * 不变量：
 *  - INV-2：extends UiChannel 守护（经 UiChannel → BaseChannel）
 *  - INV-23：stagehand 不在 desktop fallback plan，反向亦然（FallbackDecider 守）
 *  - INV-25：cloud 浏览器必经 LASSO_ALLOW_CLOUD_BROWSER=true + STAGEHAND_API_KEY 双重解锁
 *
 * 借鉴：12 §2.1.4 Stagehand `verify(prompt) → bool` + `extract(prompt, zod_schema) → VerificationResult`；
 *       12 §3.5.12 「verify(prompt) 作为 CC 友好 API 形状」（v0.3 评估项 → v0.4 实装）。
 */
import { UiChannel } from "./UiChannel.js";
import type {
  ChannelStatus,
  Health,
  InteractResult,
  Outcome,
} from "../types.js";
import { logger } from "../util/logger.js";

// ============================================================
// 公共类型
// ============================================================
/** observe 支持的 AI 原语（仅 verify / extract；act 不在内 —— 边界明示）。 */
export type StagehandAction = "verify" | "extract";

/** observe 返回的数据（verify → verified；extract → data）。 */
export interface StagehandObserveData {
  verified?: boolean;
  data?: unknown;
}

/** observe options：verify 仅需 prompt；extract 可选 schema（zod-like JSON schema）。 */
export interface StagehandObserveOptions {
  prompt: string;
  /** extract 用：zod schema 序列化后的 JSON（stagehand 实际接 zod schema 字符串） */
  schema?: Record<string, unknown>;
}

/** capabilities：obsOnly 标识 + 不能 act（FallbackDecider / tool 层查询）。 */
export interface StagehandCapabilities {
  canObserve: true;
  canAct: false;
  observeLatencyMs: number;
  dataModel: "ai";
}

/** HTTP client 接口（解耦 fetch，便于测试 mock；与 BraveChannel 同范式）。 */
export interface StagehandHttpClient {
  post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    timeoutMs?: number,
  ): Promise<{ status: number; json: unknown; text: string }>;
}

// ============================================================
// 默认 HTTP client（包装 global.fetch）
// ============================================================
/**
 * 默认 StagehandHttpClient 实装：走 global.fetch + AbortSignal.timeout。
 * 测试时注入 mock client（parse5 §5.4：global.fetch 覆写，返回 fixture JSON）。
 */
export const defaultStagehandHttpClient: StagehandHttpClient = {
  async post(url, body, headers, timeoutMs = 30_000) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应：保留 text 给 caller 判错
    }
    return { status: res.status, json, text };
  },
};

// ============================================================
// StagehandChannel
// ============================================================
export interface StagehandChannelOptions {
  /** endpoint base URL，默认 https://api.stagehand.dev（标准 stagehand cloud） */
  endpoint?: string;
  /** HTTP client，默认 defaultStagehandHttpClient（测试注入 mock） */
  httpClient?: StagehandHttpClient;
  /** observe 超时，默认 30s（stagehand verify/extract 含 LLM 调用，较慢） */
  timeoutMs?: number;
}

export class StagehandChannel extends UiChannel {
  readonly name = "browse_cloud_stagehand";

  private readonly endpoint: string;
  private readonly httpClient: StagehandHttpClient;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    opts: StagehandChannelOptions = {},
  ) {
    super();
    this.endpoint = opts.endpoint ?? "https://api.stagehand.dev";
    this.httpClient = opts.httpClient ?? defaultStagehandHttpClient;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * capabilities：observe-only，不能 act（parse5 §3.2.3 边界）。
   * FallbackDecider / tool 层据此决定是否把 stagehand 放进 plan。
   */
  capabilities(): StagehandCapabilities {
    return {
      canObserve: true,
      canAct: false,
      observeLatencyMs: 5000,
      dataModel: "ai",
    };
  }

  // ============================================================
  // BaseChannel 抽象方法实装
  // ============================================================
  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    // 不主动触网（避免计费）；仅静态判定 apiKey 已配
    return true;
  }

  async status(): Promise<ChannelStatus> {
    if (!this.apiKey) {
      return { available: false, note: "cloud_no_key" };
    }
    // 不主动 HEAD（stagehand cloud 可能无 HEAD 端点）；返静态 available
    return { available: true, note: "stagehand_cloud_ready" };
  }

  async healthCheck(): Promise<Health> {
    if (!this.apiKey) return "down";
    return "healthy";
  }

  // ============================================================
  // observe：唯一支持的操作（verify / extract）
  // ============================================================
  /**
   * observe 仅支持 verify / extract 两个 AI 原语（parse5 §3.2.3）。
   *
   * 返回语义：
   *  - 200 + { verified: true }  → outcome="worked" + data.verified=true
   *  - 200 + { verified: false } → outcome="didnt"（明确"否"，不 fallback）
   *  - 200 + { data: {...} }     → outcome="worked" + data.data=extracted
   *  - 5xx / 网络错              → outcome="unknown"（fallback 链可重试）
   *  - apiKey 缺                  → outcome="didnt" + retrieval_method="cloud_no_key"
   *
   * @param action "verify" | "extract"
   * @param opts { prompt, schema? }
   */
  async observe(
    action: StagehandAction,
    opts: StagehandObserveOptions,
  ): Promise<InteractResult<StagehandObserveData>> {
    // 1. preflight：apiKey 缺 → cloud_no_key
    if (!this.apiKey) {
      return {
        outcome: "didnt",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "cloud_no_key",
        error: "STAGEHAND_API_KEY missing; cloud browser disabled",
      };
    }

    // 2. dispatch to REST endpoint
    try {
      const r = await this.httpClient.post(
        `${this.endpoint}/${action}`,
        {
          prompt: opts.prompt,
          ...(opts.schema ? { schema: opts.schema } : {}),
        },
        {
          Authorization: `Bearer ${this.apiKey}`,
        },
        this.timeoutMs,
      );

      // 3. status code 路由
      if (r.status >= 200 && r.status < 300) {
        return parseObserveSuccess(action, r.json);
      }
      if (r.status === 401 || r.status === 403) {
        // apiKey 错 → didnt（明确否，不 fallback；caller 应 doctor warn）
        return {
          outcome: "didnt",
          data: null,
          served_by: this.name,
          fallback_used: false,
          retrieval_method: "stagehand_rest",
          error: `stagehand_unauthorized:${r.status}:${truncate(r.text, 200)}`,
        };
      }
      if (r.status === 429) {
        // 限流 → unknown（caller 可重试 / 切 fallback）
        return {
          outcome: "unknown",
          data: null,
          served_by: this.name,
          fallback_used: false,
          retrieval_method: "stagehand_rest",
          error: `stagehand_rate_limited:${r.status}`,
        };
      }
      // 5xx / 其他 → unknown（transient）
      return {
        outcome: "unknown",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "stagehand_rest",
        error: `stagehand_http_${r.status}:${truncate(r.text, 200)}`,
      };
    } catch (e) {
      // 网络错 / timeout → unknown
      logger.warn({
        evt: "stagehand_observe_failed",
        action,
        error: String(e),
      });
      return {
        outcome: "unknown",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "stagehand_rest",
        error: `stagehand_network_error:${truncate(String(e), 200)}`,
      };
    }
  }

  /**
   * act 显式返 outcome=didnt + retrieval_method=stagehand_observe_only（parse5 §3.2.3）。
   *
   * 设计：**stagehand 不 act**（agent loop 越界）；若 caller 误调 act，本方法返明确
   * 「不可」信号而非 TypeError。caller（FallbackDecider）据 retrieval_method 路由到
   * 真正能 act 的 channel（browse_logged_in / desktop.ax）。
   *
   * 边界铁律：**本方法永远不触网 / 不调 stagehand endpoint**（即使有 act API 也不调）。
   */
  async act(
    _action: string,
    _opts?: Record<string, unknown>,
  ): Promise<InteractResult<null>> {
    return {
      outcome: "didnt",
      data: null,
      served_by: this.name,
      fallback_used: false,
      retrieval_method: "stagehand_observe_only",
      error: "stagehand_channel_does_not_act_parse5_3_2_3_boundary",
    };
  }

  // ============================================================
  // test-only helpers
  // ============================================================
  /** @internal test-only：暴露 endpoint / apiKey 状态给单测 */
  _testGetEndpoint(): string {
    return this.endpoint;
  }
}

// ============================================================
// parseObserveSuccess：200 响应 → outcome + data（纯函数，可单测）
// ============================================================
/**
 * 把 stagehand 200 响应解析为 InteractResult。
 *
 * verify 路径：
 *  - { verified: true }  → outcome=worked + data.verified=true
 *  - { verified: false } → outcome=didnt + data.verified=false（明确"否"）
 *  - 缺 verified 字段     → outcome=unknown（响应结构异常）
 *
 * extract 路径：
 *  - { data: {...} } → outcome=worked + data.data=extracted
 *  - 缺 data 字段    → outcome=unknown
 */
export function parseObserveSuccess(
  action: StagehandAction,
  json: unknown,
): InteractResult<StagehandObserveData> {
  const servedBy = "browse_cloud_stagehand";
  const retrievalMethod = "stagehand_rest";

  if (action === "verify") {
    const obj = (json ?? {}) as { verified?: unknown };
    if (obj.verified === true) {
      return {
        outcome: "worked",
        data: { verified: true },
        served_by: servedBy,
        fallback_used: false,
        retrieval_method: retrievalMethod,
      };
    }
    if (obj.verified === false) {
      return {
        outcome: "didnt",
        data: { verified: false },
        served_by: servedBy,
        fallback_used: false,
        retrieval_method: retrievalMethod,
      };
    }
    return {
      outcome: "unknown",
      data: null,
      served_by: servedBy,
      fallback_used: false,
      retrieval_method: retrievalMethod,
      error: "stagehand_verify_response_missing_verified_field",
    };
  }

  // action === "extract"
  const obj = (json ?? {}) as { data?: unknown };
  if (obj.data !== undefined && obj.data !== null) {
    return {
      outcome: "worked",
      data: { data: obj.data },
      served_by: servedBy,
      fallback_used: false,
      retrieval_method: retrievalMethod,
    };
  }
  return {
    outcome: "unknown",
    data: null,
    served_by: servedBy,
    fallback_used: false,
    retrieval_method: retrievalMethod,
    error: "stagehand_extract_response_missing_data_field",
  };
}

// ============================================================
// 内部 helper
// ============================================================
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

/** narrowing helper：constraints Outcome type literal */
export function _isOutcome(s: string): s is Outcome {
  return s === "worked" || s === "didnt" || s === "unknown";
}
