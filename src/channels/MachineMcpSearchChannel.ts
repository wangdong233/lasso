/**
 * MachineMcpSearchChannel —— v1.4 Phase A 机器 MCP 复用通道。
 *
 * 与 ZhipuSearchChannel 同形（McpClient.connectHttp + callTool web_search_prime），
 * 区别在 key 来源：
 *  - ZhipuSearchChannel：endpoint + apiKey 来自 Lasso config（Lasso 自己的 key）
 *  - MachineMcpSearchChannel：endpoint + authorization 来自 ~/.claude.json 探测
 *    （CC 已配过的 web-search-prime MCP key，Lasso 借力不拥有）
 *
 * **零配置优先**：机器装过 web-search-prime MCP 就能搜，不需用户单独配 ZHIPU_API_KEY。
 *
 * **零回归**（INV-72）：detectMachineSearchMcp() 返 null 时 index.ts 不实例化本类
 *  → FallbackChain 跳过 search.machine_mcp → 行为等价 v1.3（byte-identical）。
 *
 * 失败策略（额度不足/网络/解析）→ outcome=didnt/unknown → fallback 链自动降级到
 * search.zhipu（现有 FallbackDecider 机制；本类不自造 fallback 循环，守 INV-4）。
 *
 * 安全（INV-72）：
 *  - 构造接 { url, authorization }（来自 detector，不直接读 ~/.claude.json）
 *  - 永不 log authorization 值（log 只说 detected/missing；由 index.ts 装配段负责）
 *  - search() 失败只 log 简短 error 字符串（绝不回显 authorization）
 *
 * 借鉴：ZhipuSearchChannel（同 McpClient.connectHttp + callTool web_search_prime 范式）。
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
import { logger } from "../util/logger.js";

// ============================================================
// 公共选项（与 ZhipuSearchChannel.SearchOpts 同构，便于 caller 复用）
// ============================================================
export interface MachineMcpSearchOpts {
  limit: number;
  engine: string;
  /** "cn" / "us"。 */
  region: string;
  no_cache: boolean;
}

// ============================================================
// MachineMcpSearchChannel
// ============================================================
export class MachineMcpSearchChannel extends BaseChannel {
  readonly name = "search.machine_mcp";
  private client: McpClient | null = null;

  constructor(
    /**
     * web_search_prime MCP endpoint（来自 ~/.claude.json mcpServers[*].url）。
     */
    private readonly endpoint: string,
    /**
     * 完整 Authorization header 值（"Bearer xxx"；来自 ~/.claude.json headers.Authorization）。
     * INV-72：永不 log 此字段；只用于 McpClient.connectHttp headers。
     */
    private readonly authorization: string,
  ) {
    super();
  }

  async isAvailable(): Promise<boolean> {
    // 不触网：只看 authorization + endpoint 合法性。
    return (
      !!this.authorization &&
      this.authorization.trim().length > 0 &&
      this.endpoint.startsWith("https://")
    );
  }

  async status(): Promise<ChannelStatus> {
    if (!(await this.isAvailable())) {
      return {
        available: false,
        note: !this.authorization
          ? "machine_mcp_authorization_missing"
          : "machine_mcp_endpoint_not_https",
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
   * 调一次 web_search_prime（同 ZhipuSearchChannel.callTool 参数）。
   * 永不抛异常——所有路径走 InteractResult。
   */
  async search(
    query: string,
    opts: MachineMcpSearchOpts,
  ): Promise<InteractResult<SearchResult>> {
    if (!(await this.isAvailable())) {
      return {
        outcome: "unknown", // 配置缺失不是 definitive 否；让 fallback 链尝试 search.zhipu
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "machine_mcp_api",
        error: !this.authorization
          ? "machine_mcp_authorization_missing"
          : "endpoint_invalid",
      };
    }
    try {
      const c = await this._getClient();
      const resp = (await c.callTool("web_search_prime", {
        search_query: query,
        search_intent: true,
        count: opts.limit,
      })) as { content?: Array<{ type: string; text?: string }> };

      const parsed = parseMachineMcpContent(resp?.content);
      // 同 ZhipuSearchChannel §D.1：200 但 0 结果 = unknown（触发跨模态 fallback）
      const outcome: Outcome = parsed.length === 0 ? "unknown" : "worked";

      return {
        outcome,
        data: {
          query,
          results: parsed,
          count: parsed.length,
          engine: "machine_mcp",
          region: opts.region,
        },
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "machine_mcp_api",
      };
    } catch (e) {
      // INV-72 安全：error 串只含异常 message（authorization 永不在 exception 里）
      const msg = String(e);
      logger.warn({ evt: "machine_mcp_call_error", error: msg });
      return {
        outcome: classifyError(e),
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "machine_mcp_api",
        error: msg,
      };
    }
  }

  // ============================================================
  // 私有
  // ============================================================
  private async _getClient(): Promise<McpClient> {
    if (this.client) return this.client;
    // 直接传完整 Authorization 串（detector 已保证含 "Bearer " 前缀；与 ZhipuSearchChannel 同范式）
    this.client = await McpClient.connectHttp(
      { name: "lasso-search-machine-mcp", version: "1.4.0" },
      this.endpoint,
      { Authorization: this.authorization },
    );
    return this.client;
  }
}

// ============================================================
// 响应解析（与 ZhipuSearchChannel.parseZhipuContent 同形；抽到本文件以便独立测）
// ============================================================
/**
 * web_search_prime MCP 返回 content[0].text 是 JSON 字符串：
 *   { search_results: [{ title, link, content, media, ... }] }
 * 兼容 { results: [...] } 变体。任何解析失败 → 返回空数组（触发 unknown fallback）。
 */
export function parseMachineMcpContent(content: unknown): SearchResult["results"] {
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
 * 错误 → outcome（与 ZhipuSearchChannel.classifyError 同源 10 §D.1）。
 * 404/403/NXDOMAIN/ENOTFOUND = didnt（明确否）；其余（timeout/429/5xx/网络）= unknown。
 */
function classifyError(e: unknown): Outcome {
  const msg = String(e).toLowerCase();
  if (msg.includes("404") || msg.includes("not_found")) return "didnt";
  if (msg.includes("403") || msg.includes("forbidden")) return "didnt";
  if (msg.includes("enotfound") || msg.includes("nxdomain")) return "didnt";
  return "unknown";
}
