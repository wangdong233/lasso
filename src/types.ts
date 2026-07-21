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
 */
export interface BrowseResult {
  url: string;
  action: string;
  state_id?: string;
  content_path?: string;
  preview: string;
  title?: string;
  final_url?: string; // 重定向后
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
 */
export interface ProviderConfig {
  name: string;
  type: "api_key" | "broker" | "self_hosted";
  endpoint_url: string | null;
  keys: string[];
  free_quota_per_month: number;
  quota_model: "monthly" | "rpm" | "token" | "request";
  fallback_order: number;
}

// ============================================================
// ChannelStatus / Health
// ============================================================
export interface ChannelStatus {
  available: boolean;
  latency_ms?: number;
  note?: string;
}

export type Health = "healthy" | "degraded" | "down";
