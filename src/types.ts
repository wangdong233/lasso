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
 * A1 质量轴（v1.17 Phase B，doc/governance/05 decision-A A1 + doc/governance/06 裁决①）：
 *  - "api"    结构化 API 响应（search.machine_mcp / search.brave，含 fanout 聚合）
 *  - "scrape" 页面抓取产物（serp_http:* / browse_headless / browse_logged_in / browse_cloud_*）
 *  - "stale"  录制回放（recording_replay，过去快照）
 * 静态映射零启发式；单一真源 src/search/QualityTag.ts；optional——缺省不影响任何既有形状。
 */
export type SearchQuality = "api" | "scrape" | "stale";

/**
 * 所有 channel 返回给 tool 层（再给 MCP client）的统一信封。
 *  - served_by        : 实际服务的 channel（如 "search.machine_mcp" / "browse_headless"）
 *  - fallback_used    : primary 失败、由 fallback 路径服务时为 true
 *  - retrieval_method : 具体手段（"machine_mcp_api" / "serp_scrape_baidu" / "chrome_devtools_mcp"）
 *  - actions_and_results : Skyvern 风格审计链（每次尝试一行，v0.1 简化版，v0.3 升级为 Step 粒度）
 *  - quality          : A1 质量轴（v1.17 Phase B；静态映射 by served_by，可选字段）
 */
export interface InteractResult<T = unknown> {
  outcome: Outcome;
  data: T | null;
  served_by: string;
  fallback_used: boolean;
  retrieval_method: string;
  /** v1.17 Phase B（A1）：质量轴（api/scrape/stale）；仅在 search 工具出口打标，缺省=未标 */
  quality?: SearchQuality;
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
/**
 * A2′ 第二跳 per-result 状态（v1.17 Phase C，doc/governance/06 裁决② + parse24 §3.2 步骤 5；
 * 单一真源 src/search/ContentSecondHop.ts）：
 *  - "ok"            拿到裁剪后正文（content 必填）
 *  - "fetch_failed"  SSRF 拒 / 网络错 / 超时 / 非 2xx / 3xx 未跟随 / 超预算跳过
 *  - "not_html"      content-type 非 HTML，如实跳过
 *  - "extract_failed" 抽取引擎失败或空正文
 * tri-state 诚实：第二跳失败不改变主结果 outcome/served_by（enrichment 非 fallback）。
 */
export type ContentBlockStatus = "ok" | "fetch_failed" | "not_html" | "extract_failed";

/**
 * 蓝链基线形状 {title,url,snippet,source?}（INV-11 契约）+ A2′ 第二跳可选增强字段
 * （content_blocks=N opt-in 时仅 top N 条携带；缺省 = 全部缺席 = byte-identical 基线）。
 */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  /** A2′（v1.17 Phase C）：content_blocks opt-in 时第二跳抓取的查询相关裁剪正文 */
  content?: string;
  /** A2′：content 为不完整子集时 true（裁剪丢段或 body 字节级截断）；缺省 = 完整 */
  truncated?: boolean;
  /** A2′：第二跳四态标注（top N 条必带；抓失败条目保留蓝链字段 + 此标注） */
  content_status?: ContentBlockStatus;
}

export interface SearchResult {
  query: string;
  results: SearchResultItem[];
  count: number;
  engine: string; // "machine_mcp" / "brave" / "multi" / "baidu_serp" / "serp_http_ddg"
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
  // ============================================================
  // v1.1 新增（parse12 §3.3.1）—— markdown 档抽取元数据（仅 extract_mode=markdown* 填）
  // ============================================================
  /** markdown 档：defuddle 抽出的作者（若有）；raw 档不填（v1.0 调用方不读） */
  byline?: string;
  /** markdown_cited 档：去重引用表（applyCitations 产出；角标编号 1-based） */
  citations?: Array<{ n: number; url: string }>;
  /** markdown 档：服务引擎名（"defuddle+turndown" / fallback "turndown-only"） */
  markdown_engine?: string;
  /**
   * v1.17 Phase F（parse24 §6.2 C2 + 冲突 #8）：extract_mode 未传/"raw" 且
   * options.include_refs=true 时填 true——raw 档运行时忽略 include_refs 并诚实
   * 标注（宽松进严格出，schema 不拒）。缺省关时无此字段（byte-identical）。
   */
  ignored_include_refs?: boolean;
}

// ============================================================
// BrowseOptions（附录 A；steps v1.8 Phase D 实装、expect 由 wait action 消费）
// ============================================================
/**
 * expect 后置条件（steps 内 step.expect 由 StepEngine 三态消费；
 * 顶层 expect 由 action=wait 消费——doWait 读 expect.text，BrowseChannel doWait）
 */
export interface ExpectCondition {
  text?: string;
  selector?: string;
  url_contains?: string;
  gone?: boolean;
  timeout_ms?: number;
}

export interface ScreenshotSpec {
  full?: boolean;
  // review-r2 裁决留档的 element? 死字段已于 P2 处置轮删除（零写入零读取；
  // zod wire 面早在 r2 已删，此处是内部类型残留——上游 0.3.0 只接 fullPage）。
}

export interface BrowseOptions {
  selectors?: Record<string, string>;
  js?: string;
  steps?: unknown[]; // browse() 入口消费：非空 → StepEngine.runChain（BrowseChannel browse 入口分流）
  expect?: ExpectCondition; // action=wait 消费（doWait 读 expect.text，必需）；其余 action 忽略
  // review-r2 裁决留档的 wait_until? / timeout_ms? 死字段已于 P2 处置轮删除
  // （全链路零写入零读取；doNavigate 只透传 {type,url,ignoreCache}，
  //  network 面用 network_timeout_ms 独立字段）。
  screenshot?: ScreenshotSpec;
  no_cache?: boolean;
  /**
   * v1.18.2（doc/governance/10 F3+Y1）：steps chain 总时间预算（ms），默认 120s。
   * 慢站/长 SPA/多步表单等合法长链可显式放宽（钳制上限 600s=10min——
   * BudgetTracker.MAX_CHAIN_BUDGET_MS；防误配 1e9 之类的失控值）。
   * 超预算终止语义是 unknown（自限=瞬态可重试），不是 didnt（doc/governance/10 F3）。
   */
  budget_ms?: number;
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
  /** v0.5 注入时代的采集窗口；v1.11 原生直调后无行为消费（cdp-actions.ts），字段保留仅为 zod 契约稳定 */
  network_timeout_ms?: number;
  // ============================================================
  // v1.1 新增（parse12 §1.3 + §2.2）—— MarkdownExtractor mode-aware 三模式
  // ============================================================
  /**
   * extract_mode 控制 BrowseChannel `extract` action 的输出形态（v1.1 parse12 §1.3）。
   *
   * 用户硬约束（parse12 §1.3 最高优先级）：
   *  - undefined / "raw"     : v1.0 行为 byte-identical（take_snapshot → a11y 文本树）
   *  - "markdown"            : defuddle+turndown 精炼为 LLM 友好 markdown（opt-in）
   *  - "markdown_cited"      : markdown + ⟨N⟩ 引用角标 + References 段（RAG opt-in）
   *
   * 铁律：schema 用 z.enum(...).optional()（无 .default()），防 zod 自动注入致
   *       raw byte-identical 断言失真；undefined 与 "raw" 在代码内等价但测试能区分
   *       「字段不存在」vs「字段显式传 raw」。仅 `extract` action 读此字段；
   *       snapshot/navigate/screenshot 等忽略（守 raw 路径 byte-identical v1.0）。
   */
  extract_mode?: "raw" | "markdown" | "markdown_cited";
  /**
   * v1.17 Phase F（parse24 §6.2 C2）：extract 的交互句柄 opt-in（缺省关）。
   *
   *  - true + extract_mode=markdown/markdown_cited：抽取 expr 顺带注入
   *    data-lasso-uid="r1".. 到交互元素（a/button/input/select/textarea/[role=…]
   *    等，cap 50/页），markdown 末尾追加 "## Interactive refs" 附录（正文零内嵌
   *    标记）；后续 click/fill 的 selectors 键传 "r1".. 即按 ref 定位（JS click +
   *    native value setter）。ref 失效（页面已变）→ didnt + ref_stale_re_snapshot
   *    （不猜不自动重试——重新 extract 取新 refs）。
   *  - true + extract_mode 未传/"raw"：运行时忽略 + 返回 ignored_include_refs:true
   *    诚实标注（宽松进严格出，schema 不拒；冲突 #8 定案）。
   *  - 缺省（undefined/false）：现行行为 byte-identical（INV-66 手法）。
   */
  include_refs?: boolean;
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
 *  - L2=免费层需Key（智谱、Tavily 1000、Jina）
 *  - L3=远程 URL 免Key（Exa、Jina read_url）
 *  - L4=付费（Perplexity/Serper/Google CSE；Brave 2026-02 免费档取消后改判 L4；
 *    Bing 已于 2025-08-11 退役——2026-08-17 核实，v1.15 Phase A 死层已清除，
 *    见 doc/usage/01-KEY-GUIDE.md）
 *
 * 10 §2.5 核心洞察：免 Key ≠ 零成本（SearXNG 要自建），需 Key ≠ 付费（Exa 有免费层）。
 */
export type FreeTierLevel = "L1" | "L2" | "L3" | "L4";

/**
 * v1.11（round1 T6）：search 时效性过滤枚举（透传各引擎）。
 *  - 智谱上游 `search_recency_filter`（oneDay/oneWeek/oneMonth/oneYear）
 *  - Brave `freshness`（pd/pw/pm/py）
 *  - browse_headless SERP 兜底走 ddg `df=`（v1.12 round2 T2-5）
 *  - （v1.15 Phase A：Bing 源已死层清除，freshness Day/Week/Month 分支随之移除。）
 * 不传 = 不限时效（byte-identical 基线行为；与 extract_mode 同款守护手法）。
 */
export type SearchFreshness = "day" | "week" | "month" | "year";

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
 * CC 可据此在结果中看到「这条来自 machine_mcp / 这条来自 brave」。
 */
export interface AttributedResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  /** "search.machine_mcp" / "search.brave" / "browse_headless" */
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
  /**
   * v1.1 新增（parse12 §1.3 + §3.3.2）：HTML→markdown 抽取模式。
   *
   *  - undefined / "raw" : v1.0 行为 byte-identical（原始 HTML/JSON/text 字节）
   *  - "markdown"        : route.kind=html 时 bodyText 过 MarkdownExtractor（opt-in）
   *  - "markdown_cited"  : markdown + ⟨N⟩ 引用角标（RAG opt-in）
   *
   * 非 html route（json/text/binary）忽略此字段（文档化：强行走 markdown 语义错；
   * 守 raw byte-identical v1.0）。schema 用 .optional() 无 default（parse12 §1.3）。
   */
  extract_mode?: "raw" | "markdown" | "markdown_cited";
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
  // ============================================================
  // v1.1 新增（parse12 §3.3.2）—— markdown_cited 档引用表（仅 extract_mode=markdown_cited 且 route=html 填）
  // ============================================================
  /** markdown_cited 档：去重引用表（applyCitations 产出；raw/undefined 档不填） */
  citations?: Array<{ n: number; url: string }>;
}

// ============================================================
// v0.5 新增类型（parse6 §3.2 screenshot + §3.3 pdf，M0.5b）
// ============================================================
/**
 * ScreenshotOptions（parse6 §3.2.2 schema 子集）。
 *
 * v0.5 立场（守简单性 + 守边界）：
 *  - 仅 URL 入参；pageRef 推 v0.6 forest 合并后（4 工具不接受 @pN / @wN rootRef）
 *
 * review-r1（2026-08-31）：viewport / region / format / quality 四字段删除——
 * 自 v0.5 起「schema 接受 → browseOpts 不映射」的静默丢弃是接口面死角（调用方传
 * region 得到整页 PNG）；deferred 依据（上游 0.3.0 只接 fullPage+format）已随 v1.11
 * 锁 1.7.0 失效。未来接入 format 时须连同 doScreenshot 的 PNG magic 校验 / 扩展名 /
 * extractScreenshotPath 一起实装后再回 schema + 类型。
 *
 * review-r2（2026-08-31）：wait_until / timeout_ms 同理由删除——doNavigate 只透传
 * {type,url,ignoreCache}，两参数全链路零消费（review-r1 F3 同族接口面死角）。
 */
export interface ScreenshotOptions {
  full_page: boolean;
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
  // review-r2：wait_until / timeout_ms 已删（channel 零消费；与 ScreenshotOptions 同步）
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
 *  - timeout_ms 默认 3000ms（v1.11 T5：字段保留；原生工具即时返回）
 *  - review-r2：wait_until 已删——doNavigate 只透传 {type,url,ignoreCache}，
 *    全链路零等待语义（接口面死角；与 screenshot/pdf 同步诚实化）
 *
 * 设计原则：schema 接受 → doNetwork 透传 → 简化或文档化未实装字段（守 R-CI-02）。
 */
export interface NetworkOptions {
  filter: "xhr" | "fetch" | "img" | "3rd-party" | "all";
  /** v0.5 接受但 doNetwork 不实装（schema forward-compat；落盘文档化推迟 v0.6） */
  include_bodies: boolean;
  /** v1.11 T5：字段保留（原生工具即时返回，不再控制采集窗口）；默认 3000ms */
  timeout_ms: number;
}

/**
 * NetworkResult（network 工具返回的 data 形状）。
 *
 *  - page_host         : URL 解析的 host（用于 3rd-party 判定；v0.5 简化 host 精确匹配）
 *  - resource_count    : 过滤后剩的资源条数（filter=all 时 = 全部；filter=3rd-party 时 = 跨 host）
 *  - third_party_count : 跨 host 的资源条数（不论 filter；CC 据 filter=all 时可知全量 vs 3rd-party 占比）
 *  - envelope          : bounded output（资源列表 JSON.stringify 后过 applyOutputEnvelope 落 .txt）
 *  - state_id          : BrowseChannel 写盘 state-store 的短指针
 *  - next_step         : 抓取量偏低启发式提示（<5 entries 多半页面真实简单；v1.11 原生采集无 TUN timing 干扰面）
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
  /** 抓取量偏低启发式提示（<5 entries 多半页面真实简单；v1.11 原生采集无 TUN timing 干扰面） */
  next_step?: string;
}
