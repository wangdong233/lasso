/**
 * MachineMcpSearchChannel —— v1.4 Phase A 机器 MCP 复用通道。
 *
 * McpClient.connectHttp + callTool web_search_prime 范式（v1.17 A3 起
 * 是该范式在 Lasso 内的唯一持有者——zhipu 直连 API channel 已删除，
 * doc/governance/06 裁决③：保留 machine_mcp，删除 Lasso 自有 key 的直连档）：
 *  - endpoint + authorization 来自 ~/.claude.json 探测
 *    （CC 已配过的 web-search-prime MCP key，Lasso 借力不拥有）
 *
 * **零配置优先**：机器装过 web-search-prime MCP 就能搜（fallback_chain 首位 +
 * engine="auto" 扇出源；v1.17 A3 起不再要求用户单独配任何搜索 key）。
 *
 * **零回归**（INV-72）：detectMachineSearchMcp() 返 null 时 index.ts 不实例化本类
 *  → FallbackChain 跳过 search.machine_mcp → 行为等价（byte-identical）。
 *
 * 失败策略（额度不足/网络/解析）→ outcome=didnt/unknown → fallback 链自动降级到
 * search.brave → serp_http → browse_headless（现有 FallbackDecider 机制；本类
 * 不自造 fallback 循环，守 INV-4）。
 *
 * 安全（INV-72）：
 *  - 构造接 { url, authorization }（来自 detector，不直接读 ~/.claude.json）
 *  - 永不 log authorization 值（log 只说 detected/missing；由 index.ts 装配段负责）
 *  - search() 失败只 log 简短 error 字符串（绝不回显 authorization）
 *
 * 借鉴：McpClient.connectHttp + callTool web_search_prime 范式（v1.4 起源自 zhipu 直连
 * channel；v1.17 A3 该直连档删除后本类是范式唯一持有者）。
 */
import { BaseChannel } from "./BaseChannel.js";
import type {
  ChannelStatus,
  Health,
  InteractResult,
  Outcome,
  SearchResult,
  SearchFreshness,
} from "../types.js";
import { McpClient } from "../subprocess/McpClient.js";
import { logger } from "../util/logger.js";
// v1.17 A3（doc/governance/06 裁决③）：ZHIPU_RECENCY_MAP 随 zhipu 直连 channel 删除迁入本文件
// （单一消费者，就近持有）。v1.12（round2 T2-5）实证：web_search_prime 上游参数名
// search_recency_filter，枚举 oneDay/oneWeek/oneMonth/oneYear。
/**
 * SearchFreshness → web_search_prime 上游 search_recency_filter 值映射。
 * 上游枚举（MCP tool schema 实证）：oneDay/oneWeek/oneMonth/oneYear。
 * （v1.11 起实证；v1.17 A3 从 channels/SearchChannel.ts 迁入——INV-80 墓碑容许本常量，
 *   名字保留「ZHIPU」是因为上游本就是智谱 web_search_prime API。）
 */
export const ZHIPU_RECENCY_MAP: Record<string, string> = {
  day: "oneDay",
  week: "oneWeek",
  month: "oneMonth",
  year: "oneYear",
};

// ============================================================
// 公共选项（v1.17 A3 起是 search MCP 源的唯一 opts 形）
// ============================================================
export interface MachineMcpSearchOpts {
  limit: number;
  engine: string;
  /** "cn" / "us"。 */
  region: string;
  no_cache: boolean;
  /**
   * v1.12（round2 T2-5）：时效性过滤。machine_mcp 是 FallbackChain 首位引擎——
   * 此前无此字段，用户传 freshness 时首位引擎静默忽略（tri-state 同构小违背）。
   * 不传 = 不限时效（v1.11 行为）。
   */
  freshness?: SearchFreshness;
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
   * 调一次 web_search_prime（connectHttp + callTool 范式）。
   * 永不抛异常——所有路径走 InteractResult。
   */
  async search(
    query: string,
    opts: MachineMcpSearchOpts,
  ): Promise<InteractResult<SearchResult>> {
    if (!(await this.isAvailable())) {
      return {
        outcome: "unknown", // 配置缺失不是 definitive 否；让 fallback 链降级 search.brave → 兜底链
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
      // review-r3 F4：wire 参数对齐 producer schema（2026-08-31 本机 tools/list
      // L2 实证：web_search_prime 仅收 search_query / search_domain_filter /
      // search_recency_filter / content_size / location——无 count、无 search_intent，
      // zod strip 静默丢弃）。此前发送的 count: opts.limit 与 search_intent: true
      // 是死 wire 参数（L3：limit=2 实返 10 条），全链移除。
      const resp = (await c.callTool("web_search_prime", {
        search_query: query,
        // v1.12（round2 T2-5）：freshness 透传（同一上游同参数名；不传 = 不限时效）
        ...(opts.freshness
          ? { search_recency_filter: ZHIPU_RECENCY_MAP[opts.freshness] ?? opts.freshness }
          : {}),
      })) as { content?: Array<{ type: string; text?: string }> };

      const parsed = parseMachineMcpContent(resp?.content);
      // review-r3 F4：上游无 count 参数（恒返默认 ~10 条）→ limit 在本层落实
      // （slice 到调用方声明的上限；工具 schema 契约「limit 1-50」自此真实生效。
      // 此前单源路径（machine_mcp 是零配置默认源）limit 完全被忽略）。
      const results = parsed.slice(0, opts.limit);
      // 10 §D.1：200 但 0 结果 = unknown（触发跨模态 fallback）
      const outcome: Outcome = results.length === 0 ? "unknown" : "worked";

      return {
        outcome,
        data: {
          query,
          results,
          count: results.length,
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
    // 直接传完整 Authorization 串（detector 已保证含 "Bearer " 前缀）
    this.client = await McpClient.connectHttp(
      { name: "lasso-search-machine-mcp", version: "1.4.0" },
      this.endpoint,
      { Authorization: this.authorization },
    );
    return this.client;
  }
}

// ============================================================
// 响应解析（抽到本文件以便独立测；search_results / results / 裸数组 / 双重编码 四兼容）
// ============================================================
/**
 * web_search_prime MCP 返回 content[0].text 是 JSON 字符串，历史形态：
 *   { search_results: [{ title, link, content, media, ... }] }
 * 兼容 { results: [...] } 变体。
 *
 * **v1.17 真机实测（doc/governance/06 verify ②）**：上游现行形态是**双重编码裸数组**——
 * text = JSON.stringify(JSON.stringify([{ title, link, content, refer }, ...]))，
 * 即 JSON.parse 一次得到 string、再 parse 一次才得到数组（2026-08-18 本机
 * open.bigmodel.cn 实抓实证；items 键 = title/link/content/refer）。旧单次
 * 解析对此恒得 [] → outcome=unknown → 每次 machine_mcp 真机搜索都静默降级
 * scrape 链（A3「智谱能力唯一载体」失效）——本修复为 verify 轮必修项。
 * 任何解析失败 → 返回空数组（触发 unknown fallback）。
 */
export function parseMachineMcpContent(content: unknown): SearchResult["results"] {
  if (!Array.isArray(content)) return [];
  const textBlock = content.find(
    (b: { type: string; text?: string }) => b.type === "text",
  );
  if (!textBlock?.text) return [];
  try {
    // 剥层：最多 3 次（实测 2 次；上限防病态深编码）。非 string 即停。
    let parsed: unknown = textBlock.text;
    for (let i = 0; i < 3 && typeof parsed === "string"; i++) {
      parsed = JSON.parse(parsed);
    }
    // 形态归一：裸数组（现行上游）或 { search_results | results } 对象（历史/兼容）。
    const arr: unknown = Array.isArray(parsed)
      ? parsed
      : ((parsed as Record<string, unknown>)?.search_results ??
        (parsed as Record<string, unknown>)?.results ?? []);
    if (!Array.isArray(arr)) return [];
    return (arr as Array<Record<string, unknown>>)
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
