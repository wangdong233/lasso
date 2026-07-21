/**
 * ZhipuSearchChannel（parse1 §3.4 + §4.1；v0.2 改名 + QuotaLedger 可选注入）
 *
 * 唯一搜索主通道：调智谱 web_search_prime MCP（streamable-http），返回
 * InteractResult<SearchResult>。
 *
 * v0.2 改动（parse2 §3.3.4 / §2.2 兼容性表）：
 *  - 类名 SearchChannel → ZhipuSearchChannel（语义清晰，与 BraveChannel 对齐）
 *  - 导出别名 `SearchChannel = ZhipuSearchChannel`，**v0.1 既有 import 零改动**
 *  - 接受可选 QuotaLedger（第 3 参数，v0.1 实例化两参仍可用）；v0.2 多源扇出
 *    时由 ProviderRegistry 注入，用于 doctor 报告配额余量。channel 内部不主动
 *    扣减（智谱按 token 计费，v0.2 退化为按请求计数近似；v0.3 升级精确计）。
 *
 * 连接策略（§4.1）：McpClient.connectHttp 直连智谱 MCP endpoint，Authorization
 * header 走 Bearer。懒连接：首次 search() 触发，进程内复用 client。
 *
 * 错误 → outcome 映射（10 §D.1）：
 *  - 200 + 0 结果 → unknown（关键信号，触发 fallback 到 browse_headless 实搜百度）
 *  - timeout / 429 / 5xx / network → unknown
 *  - 404 / 403 / NXDOMAIN / ENOTFOUND → didnt
 *  - 正常解析且 results ≥ 1 → worked
 *
 * 降级备选（§4.1）：若 MCP 握手不稳，未来可切智谱 REST API
 * （POST /api/paas/v4/web_search_prime）。v0.1 先 MCP 路径；同 channel 内部切换，外不感知。
 *
 * 借鉴：08 §3.1；10 §D.1 isFallbackWorthy 扩展集（200 但 0 结果）；智谱
 * web_search_prime 响应形状（JSON in text block：{ search_results: [{title, link, content, media}] }）。
 */
import { BaseChannel } from "./BaseChannel.js";
import type {
  ChannelStatus,
  Health,
  InteractResult,
  Outcome,
  SearchResult,
} from "../types.js";
import { McpClient } from "../subprocess/McpClient.js";
import type { QuotaLedger } from "../config/quota-ledger.js";
import { logger } from "../util/logger.js";

// ============================================================
// 公共选项
// ============================================================
export interface SearchOpts {
  limit: number;
  /** v0.1 固定 "zhipu"。 */
  engine: string;
  /** "cn" / "us"。 */
  region: string;
  no_cache: boolean;
}

// ============================================================
// ZhipuSearchChannel（v0.1 名 SearchChannel，v0.2 起语义改名 + 保留别名）
// ============================================================
export class ZhipuSearchChannel extends BaseChannel {
  readonly name = "search.zhipu";
  private client: McpClient | null = null;

  constructor(
    /**
     * 智谱 web_search_prime MCP endpoint。
     * 默认值在 config/providers.ts / config.ts 注入；这里只持有。
     */
    private readonly endpoint: string,
    /** 智谱 API key（process.env.ZHIPU_API_KEY）；未配则 channel unavailable。 */
    private readonly apiKey: string | undefined,
    /**
     * v0.2 新增（可选）：QuotaLedger 注入。channel 内部不主动扣减（智谱 token 计费，
     * v0.2 退化为按请求近似），doctor 读取余量做 readiness 判定。null/undefined 时
     * 不影响 v0.1 行为（search 照常返结果，只是 doctor 报告 "no ledger"）。
     */
    private readonly ledger?: QuotaLedger | null,
  ) {
    super();
  }

  async isAvailable(): Promise<boolean> {
    // 不触网：只看 key + endpoint 合法性。
    return !!this.apiKey && this.endpoint.startsWith("https://");
  }

  async status(): Promise<ChannelStatus> {
    if (!(await this.isAvailable())) {
      return {
        available: false,
        note: !this.apiKey
          ? "ZHIPU_API_KEY missing"
          : "ZHIPU_ENDPOINT not https",
      };
    }
    try {
      const c = await this._getClient();
      const t0 = Date.now();
      await c.listTools();
      return { available: true, latency_ms: Date.now() - t0 };
    } catch (e) {
      // 探测失败：把当前 client 作废，下次重连。
      this.client = null;
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
   * 调一次智谱 web_search_prime。
   * 永不抛异常——所有路径走 InteractResult。
   */
  async search(
    query: string,
    opts: SearchOpts,
  ): Promise<InteractResult<SearchResult>> {
    if (!(await this.isAvailable())) {
      return {
        outcome: "unknown", // 配置缺失不是 definitive 否，让 fallback 链尝试 browse_headless
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "zhipu_api",
        error: !this.apiKey ? "ZHIPU_API_KEY missing" : "endpoint_invalid",
      };
    }
    try {
      const c = await this._getClient();
      const resp = (await c.callTool("web_search_prime", {
        search_query: query,
        search_intent: true,
        count: opts.limit,
      })) as { content?: Array<{ type: string; text?: string }> };

      const parsed = parseZhipuContent(resp?.content);
      // 10 §D.1 关键：200 但 0 结果 = unknown（触发跨模态 fallback）
      const outcome: Outcome = parsed.length === 0 ? "unknown" : "worked";

      // v0.2：成功调用扣减 ledger（token 模型退化成按请求计数近似）。
      // 智谱单 Key（this.apiKey 即 QuotaLedger 构造时传入的同一字符串）。
      if (outcome === "worked" && this.ledger && this.apiKey) {
        this.ledger.recordSuccess(this.apiKey, 1);
      }

      return {
        outcome,
        data: {
          query,
          results: parsed,
          count: parsed.length,
          engine: "zhipu",
          region: opts.region,
        },
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "zhipu_api",
      };
    } catch (e) {
      const msg = String(e);
      logger.warn({ evt: "zhipu_call_error", error: msg });
      return {
        outcome: classifyError(e),
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "zhipu_api",
        error: msg,
      };
    }
  }

  // ============================================================
  // 私有
  // ============================================================
  private async _getClient(): Promise<McpClient> {
    if (this.client) return this.client;
    this.client = await McpClient.connectHttp(
      { name: "lasso-search", version: "0.1.0" },
      this.endpoint,
      { Authorization: `Bearer ${this.apiKey}` },
    );
    return this.client;
  }
}

// ============================================================
// 智谱响应解析
// ============================================================
/**
 * 智谱 web_search_prime MCP 返回 content[0].text 是 JSON 字符串：
 *   { search_results: [{ title, link, content, media, ... }] }
 * 兼容 { results: [...] } 变体。任何解析失败 → 返回空数组（触发 unknown fallback）。
 */
function parseZhipuContent(content: unknown): SearchResult["results"] {
  if (!Array.isArray(content)) return [];
  const textBlock = content.find(
    (b: { type: string; text?: string }) => b.type === "text",
  );
  if (!textBlock?.text) return [];
  try {
    const obj = JSON.parse(textBlock.text) as Record<string, unknown>;
    const arr = (obj.search_results ?? obj.results ?? []) as Array<
      Record<string, unknown>
    >;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.link ?? r.url ?? ""),
        snippet: String(r.content ?? r.snippet ?? ""),
        source: r.media != null ? String(r.media) : (r.source as string | undefined),
      }))
      .filter((r) => r.url);
  } catch {
    return [];
  }
}

/**
 * 错误 → outcome（10 §D.1）。
 * 404/403/NXDOMAIN/ENOTFOUND = didnt（明确否）；其余（timeout/429/5xx/网络）= unknown。
 */
function classifyError(e: unknown): Outcome {
  const msg = String(e).toLowerCase();
  if (msg.includes("404") || msg.includes("not_found")) return "didnt";
  if (msg.includes("403") || msg.includes("forbidden")) return "didnt";
  if (msg.includes("enotfound") || msg.includes("nxdomain")) return "didnt";
  return "unknown";
}

// ============================================================
// v0.1 兼容别名（parse2 §2.2 / §3.3.4）
// ============================================================
/**
 * v0.1 用 `import { SearchChannel } from ".../SearchChannel.js"`，
 * v0.2 改名为 ZhipuSearchChannel 但保留 SearchChannel 别名 → v0.1 既有 import 零改动。
 * 不变量 INV-2 扫描的是 `class \w*Channel` —— alias 是 const，不会被误判为绕过 extends。
 *
 * 同时导出 type alias（同名 type space）→ `import type { SearchChannel }` 也兼容。
 */
export const SearchChannel = ZhipuSearchChannel;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type SearchChannel = ZhipuSearchChannel;
