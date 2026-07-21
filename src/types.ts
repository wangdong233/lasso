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
  /** v0.5 新增（parse6 §3.3.5）—— pdf action 专用字段（cdp-actions.ts doPdf 读） */
  /** PDF 纸张大小；chrome-devtools-mcp `pdf` 工具透传 CDP Page.printToCDP paperSize */
  pdf_format?: "A4" | "Letter" | "Legal" | "Tabloid";
  /** 横向打印（默认 false = 纵向） */
  pdf_landscape?: boolean;
  /** 是否打印背景 CSS（默认 true） */
  pdf_print_background?: boolean;
  /** 页边距（英寸）；上下左右独立 */
  pdf_margin_top?: number;
  pdf_margin_bottom?: number;
  pdf_margin_left?: number;
  pdf_margin_right?: number;
  // ============================================================
  // v0.5 新增（parse6 §3.4 + §3.4.3）—— network action 专用字段（cdp-actions.ts doNetwork 读）
  // ============================================================
  /** 资源过滤维度（默认 "all" 不过滤） */
  network_filter?: "xhr" | "fetch" | "img" | "3rd-party" | "all";
  /** 是否抓 response body（v0.5 不实装，文档化推迟 v0.6） */
  network_include_bodies?: boolean;
  /** PerformanceObserver 采集窗口（默认 3000ms；超时后断开 observer 读 entries） */
  network_timeout_ms?: number;
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
  // ============================================================
  // v0.6 新增（parse7 §3.4，全可选，不破 v0.5 实例化）—— ToS 元数据标记
  // ============================================================
  /**
   * v0.6: ToS 文档 URL（doctor warn + audit log 显示用；不影响路由）。
   *
   * 复用 ProviderConfig.policy_risk 三态做路由判断（PolicyGate 已实装）；
   * tos_url 仅元数据，doctor 显示时附链接，不参与 PolicyGate.check() 路由逻辑。
   */
  tos_url?: string;
  /**
   * v0.6: ToS ack 状态（默认 false = 未确认）。
   *
   *  - false : 未确认（doctor warn，不阻断 —— 复用 policy_risk 走 manual-switch）
   *  - true  : 已确认（默认 v0.5 行为；用户已读 ToS）
   *
   * PolicyGate.check() 路由零改（task §8 铁律）；doctor 在 v0.6 后续阶段消费此字段。
   */
  tos_ack?: boolean;
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

// ============================================================
// v0.5 新增类型（parse6 §3.1 fetch_url）
// ============================================================
/**
 * FetchUrlOptions（parse6 §3.1.2 schema 子集）。
 *
 * v0.5 立场（守简单性 + 守边界）：
 *  - method 只允许 GET / HEAD（POST/PUT/DELETE 推 v0.6 评估，避免无脑扩大攻击面）
 *  - headers 由 caller 显式提供（fetch_url 默认不导出 cookie / Authorization）
 *  - max_bytes 硬上限 16 MiB（与 output-envelope SINGLE_CAP_BYTES 对齐，超限直接截断）
 *  - no_cache 注入 `Cache-Control: no-cache`（不发 If-Modified-Since 等 conditional）
 */
export interface FetchUrlOptions {
  method: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeout_ms: number;
  max_bytes: number;
  no_cache: boolean;
}

/**
 * FetchUrlResult（fetch_url 工具返回的 data 形状）。
 *
 *  - body_kind    : "html" | "text" | "json" | "binary:<subtype>"
 *  - body_bytes   : 原始响应字节数（base64 编码前；便于 CC 判断大小）
 *  - final_url    : undici 跟随重定向后的最终 URL（fetch_url 用 redirect:"manual"，
 *                    3xx 时 body_kind/location 在 data.location；200 时 final_url === url）
 *  - location     : 3xx 时的 Location header（caller 显式二次调 fetch_url 走 SSRF）
 *  - envelope     : bounded output（≤48KiB 原样 / >48KiB 自动落盘 .txt + @oN ref）
 */
export interface FetchUrlResult {
  url: string;
  final_url?: string;
  status: number;
  content_type: string;
  body_kind: string;
  body_bytes: number;
  /** 3xx manual-redirect 时填，给 caller 二次调用 fetch_url 用 */
  location?: string;
  /** bounded output（preview + truncated 标记 + @oN ref） */
  envelope?: import("./util/output-envelope.js").BoundedOutput;
}

// ============================================================
// v0.5 新增类型（parse6 §3.2 screenshot + §3.3 pdf，M0.5b）
// ============================================================
/**
 * ScreenshotOptions（parse6 §3.2.2 schema 子集）。
 *
 * v0.5 立场（守简单性 + 守边界）：
 *  - 仅 URL 入参；pageRef 推 v0.6 forest 合并后（4 工具不接受 @pN / @wN rootRef）
 *  - format v0.5 接受但 doScreenshot 现不映射（上游 chrome-devtools-mcp take_screenshot
 *    已固定 format=png；format 字段为 v0.6+ 预留）
 *  - region v0.5 接受但 doScreenshot 现不映射（v0.6+ 评估）
 *  - viewport v0.5 接受但 doScreenshot 现不映射（mobile emulation 推 v0.6+）
 *
 * 设计原则：schema 接受 → browseOpts 不映射 → 文档明确「未接入字段」（守 R-CI-02）。
 *            不抛错（避免 caller 误以为格式错）；CC 据 description 知道哪些字段生效。
 */
export interface ScreenshotOptions {
  full_page: boolean;
  viewport?: { width: number; height: number };
  region?: { x: number; y: number; width: number; height: number };
  format: "png" | "jpeg";
  quality?: number;
  wait_until: "load" | "domcontentloaded" | "networkidle";
  timeout_ms: number;
}

/**
 * ScreenshotResult（screenshot 工具返回的 data 形状）。
 *
 *  - path     : PNG 文件磁盘绝对路径（doScreenshot 写盘；CC 用 read_text / shell 读）
 *  - preview  : doScreenshot 写盘后的占位字符串（"screenshot saved to /tmp/..."）
 *  - state_id : BrowseChannel 写盘 state-store 的短指针（用于 read_text 续查快照元数据）
 *
 * INV-34 衍生：screenshot 经 writeState（doScreenshot 已落盘 + BrowseChannel.browse()
 *              内部 writeState）—— channel.browse 调用链自动满足 INV-34，本工具
 *              不再独立 applyOutputEnvelope（避免双重落盘）。
 */
export interface ScreenshotResult {
  url: string;
  /** PNG 文件磁盘绝对路径（doScreenshot 写到 /tmp/lasso-screenshot-<uuid>.png） */
  path?: string;
  /** doScreenshot 的 preview 字符串（含路径占位） */
  preview?: string;
  /** BrowseChannel.browse() 写盘的 state 短指针 */
  state_id?: string;
}

/**
 * PdfOptions（parse6 §3.3 pdf schema 子集）。
 */
export interface PdfOptions {
  format: "A4" | "Letter" | "Legal" | "Tabloid";
  landscape: boolean;
  print_background: boolean;
  margin_top?: number;
  margin_bottom?: number;
  margin_left?: number;
  margin_right?: number;
  wait_until: "load" | "domcontentloaded" | "networkidle";
  timeout_ms: number;
}

/**
 * PdfResult（pdf 工具返回的 data 形状）。
 *
 *  - envelope   : bounded output（base64 PDF 字符串过 applyOutputEnvelope 落 .pdf）
 *  - state_id   : BrowseChannel 写盘 state-store 的短指针
 *  - spill_path : envelope.truncated=true 时填，指向 /tmp/lasso-output/@oN.pdf（mode 0o600）
 *  - next_step  : Go/No-Go F1 上游不支持 pdf 工具时填，给 CC 降级路径建议
 *
 * INV-34 + INV-15 衍生：pdf 经 applyOutputEnvelope(text, hint, ".pdf")，spill mode 0o600。
 */
export interface PdfResult {
  url: string;
  /** base64 PDF 字符串过 envelope（truncated=true 时含 16KiB preview + @oN ref） */
  envelope?: import("./util/output-envelope.js").BoundedOutput;
  /** BrowseChannel.browse() 写盘的 state 短指针 */
  state_id?: string;
  /** envelope.truncated=true 时填（CC 用 read_text({ref:@oN}) 续读 base64） */
  spill_path?: string;
  /** Go/No-Go F1：chrome-devtools-mcp 不暴露 pdf 工具时填降级建议 */
  next_step?: string;
}

// ============================================================
// v0.5 新增类型（parse6 §3.4 network，M0.5c）
// ============================================================
/**
 * NetworkOptions（parse6 §3.4 schema 子集）。
 *
 * v0.5 立场（守简单性 + 守边界）：
 *  - 仅 URL 入参；pageRef 推 v0.6 forest 合并后（与 screenshot/pdf 同立场）
 *  - filter 维度 = xhr / fetch / img / 3rd-party / all（5 case 单维度 switch；parse6 §3.4.3）
 *  - include_bodies v0.5 接受但 doNetwork 不实装（文档化推迟 v0.6；schema forward-compat）
 *  - timeout_ms 默认 3000ms（PerformanceObserver 采集窗口）
 *  - wait_until 默认 "load"（与 screenshot/pdf 同档；先 navigate 完再注入 observer）
 *
 * 设计原则：schema 接受 → doNetwork 透传 → 简化或文档化未实装字段（守 R-CI-02）。
 */
export interface NetworkOptions {
  filter: "xhr" | "fetch" | "img" | "3rd-party" | "all";
  /** v0.5 接受但 doNetwork 不实装（schema forward-compat；落盘文档化推迟 v0.6） */
  include_bodies: boolean;
  /** PerformanceObserver 采集窗口；默认 3000ms */
  timeout_ms: number;
  wait_until: "load" | "domcontentloaded" | "networkidle";
}

/**
 * NetworkResult（network 工具返回的 data 形状）。
 *
 *  - page_host         : URL 解析的 host（用于 3rd-party 判定；v0.5 简化 host 精确匹配）
 *  - resource_count    : 过滤后剩的资源条数（filter=all 时 = 全部；filter=3rd-party 时 = 跨 host）
 *  - third_party_count : 跨 host 的资源条数（不论 filter；CC 据 filter=all 时可知全量 vs 3rd-party 占比）
 *  - envelope          : bounded output（资源列表 JSON.stringify 后过 applyOutputEnvelope 落 .txt）
 *  - state_id          : BrowseChannel 写盘 state-store 的短指针
 *  - next_step         : Go/No-Go F2 提示（PerformanceObserver 在 fake-ip TUN 下可能抓不全时填）
 *
 * INV-34 衍生：network 经 applyOutputEnvelope（资源列表 JSON 字符串过 envelope 落 .txt，mode 0o600）。
 */
export interface NetworkResult {
  url: string;
  /** URL host（3rd-party 判定基线；v0.5 host 精确匹配，eTLD+1 推 v0.6） */
  page_host: string;
  /** 过滤后剩的资源条数 */
  resource_count: number;
  /** 跨 host 的资源条数（3rd-party；不论 filter） */
  third_party_count: number;
  /** 资源列表 JSON 过 envelope（truncated=true 时含 16KiB preview + @oN ref） */
  envelope?: import("./util/output-envelope.js").BoundedOutput;
  /** BrowseChannel.browse() 写盘的 state 短指针 */
  state_id?: string;
  /** Go/No-Go F2：PerformanceObserver 在 SSRF-allowlisted fake-ip TUN 下可能抓不全时填 */
  next_step?: string;
}
