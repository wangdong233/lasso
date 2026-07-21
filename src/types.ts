/**
 * Lasso 共享类型（parse1 §3.1）
 *
 * tri-state outcome + 统一交付信封 + 三个 surface 的结果/选项 + ProviderConfig。
 * 纯类型，无运行时依赖。
 *
 * 借鉴：
 *  - 08 附录 A（ProviderConfig / BrowseOptions）
 *  - 12 F.1 injaneity actions.ts 的 outcomeAfterCheck（tri-state 语义）
 *  - 10 §D.1 isFallbackWorthy 扩展集（HTTP 202 空响应 / 200 但 0 结果）
 */

// ============================================================
// tri-state outcome（F3.4.11）
// ============================================================
/**
 * 动作结果三态。
 *  - worked  : 语义成功（已验证交付）
 *  - didnt   : 语义否定（404 / 403 / NXDOMAIN / NEEDS_MANUAL_2FA 等明确「否」）
 *  - unknown : 不确定（限流 / 超时 / 5xx / 空响应 / 网络错）→ fallback 引擎的真正触发器
 *
 * 架构铁律（08 §0 原则 5）：event delivery alone is never treated as semantic success.
 */
export type Outcome = "worked" | "didnt" | "unknown";

// ============================================================
// 统一交付信封（InteractResult）
// ============================================================
/**
 * 所有 channel 返回给 tool 层（再给 MCP client）的统一信封。
 *  - served_by        : 实际服务的 channel（如 "search.zhipu" / "browse_headless"）
 *  - fallback_used    : primary 失败、由 fallback 路径服务时为 true
 *  - retrieval_method : 具体手段（"zhipu_api" / "serp_scrape_baidu" / "chrome_devtools_mcp"）
 *  - actions_and_results : Skyvern 风格审计链（每次尝试一行，v0.1 简化版，v0.3 升级为 Step 粒度）
 */
export interface InteractResult<T = unknown> {
  outcome: Outcome;
  data: T | null;
  served_by: string;
  fallback_used: boolean;
  retrieval_method: string;
  actions_and_results?: Array<{
    channel: string;
    outcome: Outcome | "error";
    error?: string;
  }>;
  error?: string;
  /** v0.2 新增（F3.9.7）：多源扇出时部分源失败的诚实记录 */
  partial_failures?: PartialFailure[];
}

// ============================================================
// SearchResult（search channel 输出）
// ============================================================
export interface SearchResult {
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source?: string;
  }>;
  count: number;
  engine: string; // "zhipu" / "baidu_serp"
  region: string; // "cn" / "us"
}

// ============================================================
// BrowseResult（短指针 + 磁盘外置，token ≤ 1k）
// ============================================================
/**
 * browse_* channel 输出。
 *  - state_id    : 短指针（UUID），CC 用它回查完整状态（不发整页 50k+ tokens 回去）
 *  - content_path: 完整快照的磁盘绝对路径（~/.cache/lasso/<run_id>/<channel>-<state_id>.{json,html,png}）
 *  - preview     : ≤1k tokens 预览（首屏文本 / 截图占位）
 *
 * v0.3 扩展（全可选，v0.2 兼容）：
 *  - stopped_at     : chain 中止时的精确边界（仅 steps 路径产生）
 *  - bounded_output : chain 结果超 48KiB 时落盘 + 16KiB preview + @oN ref
 *  - chain          : 小 chain 的完整 actions_and_results 审计链
 */
export interface BrowseResult {
  url: string;
  action: string;
  state_id?: string;
  content_path?: string;
  preview: string;
  title?: string;
  final_url?: string; // 重定向后
  /** v0.3：chain 中止边界（仅 steps 路径产生；v0.2 单 action 不填） */
  stopped_at?: import("./browse/steps-types.js").StoppedAt;
  /** v0.3：bounded output 落盘信息（chain result 超 48KiB 时填） */
  bounded_output?: import("./util/output-envelope.js").BoundedOutput;
  /** v0.3：完整 chain 结果（actions_and_results 审计链；仅小 chain 直传） */
  chain?: import("./browse/steps-types.js").ChainResult;
}

// ============================================================
// BrowseOptions（附录 A，v0.1 子集；steps/expect 仅类型定义占位，v0.3 实装）
// ============================================================
/** v0.1 仅类型，v0.3 实装（expect 后置条件 tri-state） */
export interface ExpectCondition {
  text?: string;
  selector?: string;
  url_contains?: string;
  gone?: boolean;
  timeout_ms?: number;
}

export interface ScreenshotSpec {
  full?: boolean;
  element?: string;
}

export interface BrowseOptions {
  selectors?: Record<string, string>;
  js?: string;
  steps?: unknown[]; // v0.1 忽略
  expect?: ExpectCondition; // v0.1 忽略
  wait_until?: "load" | "domcontentloaded" | "networkidle";
  screenshot?: ScreenshotSpec;
  timeout_ms?: number;
  no_cache?: boolean;
}

// ============================================================
// ProviderConfig（附录 A，v0.1 子集；多 Key 池/三态 type v0.2 补）
// ============================================================
/**
 * 不变量 INV-3：ProviderConfig 的 interface 定义只在 types.ts（单一真源）。
 * config/providers.ts 只能 import 这个类型，不能 redefine。
 *
 * v0.2 扩 6 字段（全可选 → v0.1 实例化不破）。新字段语义见 parse2 §3.1.1。
 */
export interface ProviderConfig {
  name: string;
  type: "api_key" | "broker" | "self_hosted";
  endpoint_url: string | null;
  keys: string[];
  free_quota_per_month: number;
  quota_model: "monthly" | "rpm" | "token" | "request";
  fallback_order: number;
  // --- v0.2 新增（全可选，不破 v0.1 实例化）---
  /** L1/L2/L3/L4，默认按 type 推断（parse2 §3.1.1 / F3.1.10 四级分级） */
  free_tier_level?: FreeTierLevel;
  /** Tavily=acquired，默认 safe；policy_risk=acquired 时不阻塞但 doctor warn */
  policy_risk?: "safe" | "acquired" | "watched";
  /** Jina=non_commercial，SearXNG=agpl；默认不约束；commercial=付费服务无开源 licence（v0.4 加） */
  licence?: "mit" | "apache2" | "agpl" | "non_commercial" | "commercial";
  /** Jina false，其余默认 true（policy_risk=acquired 时建议 false） */
  commercial_safe?: boolean;
  /** ["search","browse","desktop"] 等，CapabilityBag 据第一个 tag 归类 */
  tags?: string[];
  /** false 时 CapabilityBag 不生成 channel，默认 true（TAVILY_WATCH=false） */
  enabled?: boolean;
}

// ============================================================
// FreeTierLevel（F3.1.10 四级分级，parse2 §3.1.1）
// ============================================================
/**
 *  - L1=完全免费零Key（DDG/SearXNG 自建）
 *  - L2=免费层需Key（Brave 2000/月、智谱、Tavily 1000、Jina）
 *  - L3=远程 URL 免Key（Exa、Jina read_url）
 *  - L4=付费（Perplexity/Serper/Google CSE/Bing）
 *
 * 10 §2.5 核心洞察：免 Key ≠ 零成本（SearXNG 要自建），需 Key ≠ 付费（Brave/Exa 有免费层）。
 */
export type FreeTierLevel = "L1" | "L2" | "L3" | "L4";

// ============================================================
// ChannelStatus / Health
// ============================================================
export interface ChannelStatus {
  available: boolean;
  latency_ms?: number;
  note?: string;
}

export type Health = "healthy" | "degraded" | "down";

// ============================================================
// v0.2 新增类型（parse2 §3.1.1）
// ============================================================
/**
 * AttributedResult（F3.1.8，多源扇出后单条结果带来源标签）。
 * CC 可据此在结果中看到「这条来自 zhipu / 这条来自 brave」。
 */
export interface AttributedResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  /** "search.zhipu" / "search.brave" / "browse_headless" */
  served_by: string;
  /** 原引擎内排名（rerank 用） */
  original_rank?: number;
}

/**
 * SearchCacheEntry（F3.1.4，7 天 TTL cache 单条记录）。
 * INV-11：key 必须含 engine + region + limit（防跨 provider 误命中）。
 */
export interface SearchCacheEntry<T = unknown> {
  /** attribution key（sha1 of canonical(query)|engine|region|limit） */
  key: string;
  query: string;
  engine: string;
  region: string;
  limit: number;
  result: T; // InteractResult<SearchResult>
  /** epoch ms */
  created_at: number;
  hits: number;
}

/**
 * PartialFailure（F3.9.7，多源扇出时部分源失败的诚实记录）。
 * 透传路径：MultiSourceFanout → InteractResult.partial_failures → tools/search.ts。
 */
export interface PartialFailure {
  channel: string;
  error: string;
  timestamp: number;
  /** 部分成功：该 channel 返回了部分结果（< limit），但 outcome=worked */
  partial_count?: number;
}
