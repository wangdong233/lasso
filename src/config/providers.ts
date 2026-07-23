/**
 * v0.1 内置 ProviderConfig 声明（parse1 §2 config/providers.ts）
 *
 * 三条通道对应三条 ProviderConfig。不变量 INV-3：ProviderConfig 的
 * interface 定义只在 types.ts；这里只是 import + 实例化，不 redefine。
 *
 * v0.2 升级（parse2 §3.1.2）：
 *  - ZHIPU 补 6 字段
 *  - 新增 BRAVE（结构化 API 第二源，仅引三项硬数据）
 *  - 新增 TAVILY_WATCH（policy_risk=acquired，enabled=false 占位）
 *  - BROWSE_HEADLESS / BROWSE_LOGGED_IN 补 enabled + tags
 *
 * 不变量 INV-9：ProviderRegistry 类的定义只在 config/provider-registry.ts（单一真源）。
 * 加 provider = 这里加一项常量 + push 到 BUILTIN_PROVIDERS（开闭，≤2 处改动）。
 */
import type { ProviderConfig } from "../types.js";

/**
 * 智谱 web-search-prime —— 唯一的 api_key 型 provider（search 主通道）。
 * endpoint 来自智谱 MCP 文档（parse1 §4.1）：streamable-http + Bearer header。
 *
 * v0.2 补字段：L2（免费层需 Key，token 计费），中文主力 fallback_order=0。
 */
const ZHIPU: ProviderConfig = {
  name: "zhipu",
  type: "api_key",
  endpoint_url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
  keys: [], // 从 process.env.ZHIPU_API_KEY 注入（见 config.ts）
  free_quota_per_month: 0, // 智谱未公开精确值（doctor warn）
  quota_model: "token", // 智谱按 token 计费（v0.2 在 QuotaLedger 退化为按请求计数）
  fallback_order: 0, // 中文主力
  free_tier_level: "L2",
  policy_risk: "safe",
  licence: "mit",
  commercial_safe: true,
  tags: ["search"],
  enabled: true,
};

/**
 * chrome-devtools-mcp --headless --isolated —— self_hosted 型（无 key、无 quota）。
 * 版本由 SubprocessManager.LOCKED_CDP_MCP_VERSION 锁（Phase C）。
 */
const BROWSE_HEADLESS: ProviderConfig = {
  name: "browse_headless",
  type: "self_hosted",
  endpoint_url: null,
  keys: [],
  free_quota_per_month: 0,
  quota_model: "request",
  fallback_order: 1,
  free_tier_level: "L1", // self_hosted 等价零成本
  policy_risk: "safe",
  licence: "apache2",
  commercial_safe: true,
  tags: ["browse"],
  enabled: true,
};

/**
 * chrome-devtools-mcp --browser-url=http://localhost:9222 —— self_hosted 型。
 * 复用本机已登录 Chrome；CDP port 由 LASSO_CDP_PORT 配（默认 9222）。
 */
const BROWSE_LOGGED_IN: ProviderConfig = {
  name: "browse_logged_in",
  type: "self_hosted",
  endpoint_url: null,
  keys: [],
  free_quota_per_month: 0,
  quota_model: "request",
  fallback_order: 2,
  free_tier_level: "L1",
  policy_risk: "safe",
  licence: "apache2",
  commercial_safe: true,
  tags: ["browse"],
  enabled: true,
};

/**
 * Brave Search —— 结构化 REST API 第二源（parse2 §3.1.2 / §4.1）。
 *
 * 仅引三项硬数据（10 §4.3）：669ms / 14.89 Agent Score / 2000 query/月。
 * 不写「最优」（05 §0-3 否决因果延伸 AIMultiple 单一来源）；
 * 是否真主力由 in-house A/B 实测决定（benchmark/run-ab-benchmark.ts，验收 #1）。
 *
 * Key 池：config.ts 从 BRAVE_API_KEYS CSV 注入到 keys[]，QuotaLedger 多 Key 合并 = N×2000/月。
 * 不变量 INV-10：BraveChannel 禁直接读 process.env.BRAVE_API_KEYS，必须经 QuotaLedger。
 */
const BRAVE: ProviderConfig = {
  name: "brave",
  type: "api_key",
  endpoint_url: "https://api.search.brave.com/res/v1/web/search",
  keys: [], // config.ts 从 BRAVE_API_KEYS CSV 注入
  free_quota_per_month: 2000, // 10 §4.3 硬数据
  quota_model: "monthly",
  fallback_order: 3, // 英文/质量层（zhipu=0 主力，brave=3 兜底英文）
  free_tier_level: "L2",
  policy_risk: "safe", // 无收购风险（对照 Tavily=Nebius 2026-02）
  licence: "apache2",
  commercial_safe: true,
  tags: ["search"],
  enabled: true,
};

/**
 * Tavily —— v0.2 仅占位（parse2 §3.1.2 / 10 §4.4 watch-list）。
 *
 * policy_risk=acquired：2026-02 Nebius 收购，条款未明。
 * enabled=false：ProviderRegistry 跳过，不生成 channel，仅 schema 占位。
 * doctor 第 14 项 check `tavily_policy_watch` warn 提醒（验收 #5）。
 * 6 个月稳定后再考虑接入（届时改 enabled=true 即可，开闭）。
 */
const TAVILY_WATCH: ProviderConfig = {
  name: "tavily",
  type: "api_key",
  endpoint_url: "https://api.tavily.com/search",
  keys: [],
  free_quota_per_month: 1000,
  quota_model: "request",
  fallback_order: 99, // 不实际参与 fallback
  free_tier_level: "L2",
  policy_risk: "acquired",
  licence: "mit",
  commercial_safe: false, // 收购后条款未明
  tags: ["search"],
  enabled: false, // v0.2 不接入
};

// ============================================================
// v0.3.5 desktop providers（parse4 §3.2 + §config）
// ============================================================
/**
 * desktop.ax —— AXAPI 主路径 provider（parse4 §3.2.1 + §3.5）。
 *
 * 与 zhipu/brave 的差异：
 *  - type=self_hosted（无 key、无 quota；本机 rust helper）
 *  - 不经 QuotaLedger（doctor #13 quota_ledger_initialized 跳过）
 *  - endpoint_url=null（IPC 走 stdin/stdout JSON-lines，非 HTTP）
 *  - fallback_order=4（desktop 内部首选；不参与 search/browse 跨 surface fallback）
 *
 * INV-20（F3.9.9 e）：provider 名形如 desktop.*。本条 name="desktop.ax"。
 */
const DESKTOP_AX: ProviderConfig = {
  name: "desktop.ax",
  type: "self_hosted",
  endpoint_url: null,
  keys: [],
  free_quota_per_month: 0,
  quota_model: "request",
  fallback_order: 4,
  free_tier_level: "L1", // self_hosted 等价零成本
  policy_risk: "safe",
  licence: "mit",
  commercial_safe: true,
  tags: ["desktop"],
  enabled: true,
};

/**
 * desktop.screenshotVlm —— canvas/Metal 兜底 provider（parse4 §3.2.1 + D10）。
 *
 *  - type=self_hosted（VLM endpoint 可选；未配时返 didnt 不阻断 ax 主路径）
 *  - endpoint_url=null（运行时从 LASSO_VLM_ENDPOINT 读；不进 ProviderConfig 静态字段）
 *  - fallback_order=5（desktop 内部 fallback；不参与跨 surface fallback，INV-23）
 *
 * INV-20：provider 名形如 desktop.*。本条 name="desktop.screenshotVlm"。
 */
const DESKTOP_VLM: ProviderConfig = {
  name: "desktop.screenshotVlm",
  type: "self_hosted",
  endpoint_url: null,
  keys: [],
  free_quota_per_month: 0,
  quota_model: "request",
  fallback_order: 5,
  free_tier_level: "L1",
  policy_risk: "safe",
  licence: "mit",
  commercial_safe: true,
  tags: ["desktop"],
  enabled: true,
};

/**
 * v0.3.5 desktop providers（parse4 §3.2 + §config）。
 *
 * 单独导出，**不进 BUILTIN_PROVIDERS**（parse4 §5.4 零回归承诺）：
 *  - 桌面通道不经 QuotaLedger（doctor #13 不查 desktop）
 *  - ProviderRegistry v0.3 byCap("desktop") 测试断言 [] 仍绿
 *  - INV-20 只要求 provider 名形如 desktop.*（grep DESKTOP_AX/DESKTOP_VLM），
 *    不要求进 BUILTIN_PROVIDERS
 *  - v0.4+ 若需要统一 registry 管理，把此 export 改为 push BUILTIN_PROVIDERS 即可
 */
export const DESKTOP_PROVIDERS: readonly ProviderConfig[] = [
  DESKTOP_AX,
  DESKTOP_VLM,
];

/** 单独导出便于 INV-20 grep + 测试断言（DESKTOP_AX / DESKTOP_VLM 名形如 desktop.*）。 */
export { DESKTOP_AX, DESKTOP_VLM };

// ============================================================
// v0.4 M0.4a cloud 浏览器 providers（parse5 §3.4.3，F3.12.1 / F3.12.2）
// ============================================================
/**
 * browserbase —— 云 Chrome 反爬通道（F3.12.1，v0.4 M0.4c 实装）。
 *
 *  - policy_risk="watched"：商用 ToS 需联系销售（parse5 §3.4.3 设为 watched 观察期，
 *    比 acquired 宽松：用户显式 opt-in LASSO_ALLOW_CLOUD_BROWSER=true 即放行）
 *  - commercial_safe=false：付费 + credits 账本（cloud 浏览器都属商业风险）
 *  - tags=["browse","cloud"]：browse capability + cloud 子标签
 *    （PolicyGate 据通道名前缀 browse_cloud_* 判定，不依赖 tags；tags 用于 doctor 统计）
 *  - enabled=false：默认禁用，双重解锁（LASSO_ALLOW_CLOUD_BROWSER + BROWSERBASE_API_KEY）
 *    M0.4a 阶段：ProviderConfig schema 占位；M0.4c 才在 index.ts 条件注册 BrowserbaseChannel
 *
 * INV-25：PolicyGate.cloud 浏览器必经 manual-switch（grep LASSO_ALLOW_CLOUD_BROWSER）。
 *
 * 单独导出，**不进 BUILTIN_PROVIDERS**（参照 DESKTOP_PROVIDERS 范式，保零回归）：
 *  - v0.3.5 ProviderRegistry 构造 BUILTIN_PROVIDERS 时不感知 cloud 浏览器
 *  - byCap("browse") 测试断言仍只含 browse_headless / browse_logged_in
 *  - M0.4c 实装时把此 export 加进条件装配即可（开闭）
 */
const BROWSERBASE: ProviderConfig = {
  name: "browserbase", // channel 名 browse_cloud_browserbase
  type: "api_key",
  endpoint_url: "wss://cdp.browserbase.com", // ws URL（非 http）
  keys: [], // 从 process.env.BROWSERBASE_API_KEY 注入（M0.4c 装配期）
  free_quota_per_month: 0, // 100 free minutes trial（付费为主）
  quota_model: "request",
  fallback_order: 10, // cloud 是 fallback 链尾
  free_tier_level: "L4", // 付费
  policy_risk: "watched", // 商用 ToS 观察期（manual-switch opt-in 解锁）
  licence: "commercial", // browserbase ToS 商用需联系销售
  commercial_safe: false,
  tags: ["browse", "cloud"],
  enabled: false, // 默认禁用；LASSO_ALLOW_CLOUD_BROWSER=true + BROWSERBASE_API_KEY 双重解锁
};

/**
 * stagehand —— AI-friendly verify/extract（F3.12.2，v0.4 M0.4c 实装）。
 *
 * 同 browserbase 付费路径，仅 observe 不 act（act 越界，parse5 §3.2.1）。
 *  - policy_risk="watched"：同 browserbase，付费 + 商用 ToS 观察期
 *  - 仅接 verify/extract 两个 AI 原语（13 §3.4 不做 Skyvern 风格 workflow engine）
 */
const STAGEHAND: ProviderConfig = {
  name: "stagehand", // channel 名 browse_cloud_stagehand
  type: "api_key",
  endpoint_url: "https://api.stagehand.dev",
  keys: [], // 从 process.env.STAGEHAND_API_KEY 注入（M0.4c 装配期）
  free_quota_per_month: 0,
  quota_model: "token",
  fallback_order: 11, // 在 browserbase 之后
  free_tier_level: "L4",
  policy_risk: "watched",
  licence: "commercial",
  commercial_safe: false,
  tags: ["browse", "cloud"],
  enabled: false, // 同 browserbase 双重解锁
};

/**
 * v0.4 M0.4a cloud 浏览器 providers（parse5 §3.4.3）。
 *
 * 单独导出，**不进 BUILTIN_PROVIDERS**（参照 DESKTOP_PROVIDERS 范式，保零回归）：
 *  - v0.3.5 ProviderRegistry 测试断言 byCap("browse") 不含 cloud 浏览器仍绿
 *  - INV-25 只要求 PolicyGate.ts 出现 LASSO_ALLOW_CLOUD_BROWSER 字面量
 *    （不要求 cloud providers 进 BUILTIN_PROVIDERS）
 *  - M0.4c 实装时在 index.ts 条件装配 BrowserbaseChannel + StagehandChannel
 */
export const CLOUD_BROWSER_PROVIDERS: readonly ProviderConfig[] = [
  BROWSERBASE,
  STAGEHAND,
];

/** 单独导出便于 INV-25 grep + 测试断言（tags 含 "cloud" 子标签）。 */
export { BROWSERBASE, STAGEHAND };

// ============================================================
// v0.9 Phase A 新增（parse10 §3.1 第三源 Bing Web Search API v7）
// ============================================================
/**
 * Bing Web Search —— 第三源 search provider（parse10 §3.1 / §1 决策 6）。
 *
 * **v0.9 立场（parse10 §4 未明点）**：
 *  - Bing Azure F0 免费层对新订阅的可用性基于既有知识（2023-08 调整后多 region 受限），
 *    v0.9 接入结构**不强依赖 F0 必可用** —— key=[] 时 ProviderRegistry 跳过 bing，
 *    行为完全等价 v0.8（零回归承诺）。
 *  - fallback_order=4：在 search.bing 配置位置上（brave=3 之后，tavily=99 之前）。
 *  - 与 ZHIPU/BRAVE 同结构（api_key + monthly quota），但 policy_risk="watched"
 *    （Azure 商用条款观察期 —— Azure 商用 ToS 较严格，doctor warn 提醒）。
 *
 * INV-54（parse10 §1）：BingChannel 禁直接读 process.env.BING_API_KEYS，必须经 QuotaLedger。
 *
 * 单独导出，**不进 BUILTIN_PROVIDERS**（参照 DESKTOP_PROVIDERS / CLOUD_BROWSER_PROVIDERS 范式，保零回归）：
 *  - v0.8 ProviderRegistry byCap("search") 测试断言不含 bing 仍绿（只有 zhipu / brave）
 *  - M（v0.9+）实装时在 index.ts 条件装配 BingChannel（BING_API_KEYS 注入时）
 *  - 用户配 BING_API_KEYS env → config.ts 注入 keys → registry 自动 byCap 含 bing
 *  - 用户不配 → keys=[] → ProviderRegistry 因 c.keys.length===0 不创 QuotaLedger（同 brave）
 *
 * Endpoint: https://api.bing.microsoft.com/v7.0/search（parse10 §3.1）
 * Auth: Ocp-Apim-Subscription-Key header（BingChannel.ts 实装）
 */
const BING: ProviderConfig = {
  name: "bing",
  type: "api_key",
  endpoint_url: "https://api.bing.microsoft.com/v7.0/search",
  keys: [], // config.ts 从 BING_API_KEYS CSV 注入
  free_quota_per_month: 1000, // Azure F0 免费层（transient availability，parse10 §4）
  quota_model: "monthly",
  fallback_order: 4, // 第三源兜底（zhipu=0 主力，brave=3 英文，bing=4 兜底）
  free_tier_level: "L2",
  policy_risk: "watched", // Azure 商用 ToS 观察期（manual-switch，doctor warn）
  licence: "commercial", // Azure 商用服务
  commercial_safe: false, // 付费商用（与 browserbase/stagehand 同档）
  tags: ["search"],
  enabled: true,
};

/**
 * v0.9 Phase A Bing provider（parse10 §3.1）。
 *
 * 单独导出，**不进 BUILTIN_PROVIDERS**（参照 DESKTOP_PROVIDERS / CLOUD_BROWSER_PROVIDERS 范式）：
 *  - v0.8 ProviderRegistry 测试断言 byCap("search") 不含 bing 仍绿（零回归承诺）
 *  - INV-54 grep BING 字面量在 providers.ts 即合规（不要求进 BUILTIN_PROVIDERS）
 *  - M（v0.9+）实装时在 index.ts 条件装配：BING_API_KEYS 注入时 new BingChannel
 */
export const SEARCH_FALLBACK_PROVIDERS: readonly ProviderConfig[] = [BING];

/** 单独导出便于 INV-54 grep + 测试断言（policy_risk=watched + fallback_order=4）。 */
export { BING };

// ============================================================
// v1.4 Phase A 新增（parse-v1.4 §Phase A —— 机器 MCP 复用 provider）
// ============================================================
/**
 * Machine MCP —— v1.4 Phase A：复用 CC 全局 ~/.claude.json 已配的 web-search-prime MCP。
 *
 * **零配置优先**（parse-v1.4 §1 用户需求）：
 *  - 用户机器已装过 web-search-prime MCP（headers.Authorization 含 Bearer key）
 *    时，Lasso 直接借力该 key 先搜；额度不足/失败 → fallback 链降级到 search.zhipu。
 *  - 不需用户在 Lasso config 再配一遍 ZHIPU_API_KEY（key 来自机器，不在 Lasso 拥有域内）。
 *
 * **conditional 装配**（INV-72 守）：
 *  - 默认 enabled=false（占位；不进 BUILTIN_PROVIDERS，保 v1.3 测试断言）
 *  - index.ts 装配段调 detectMachineSearchMcp()：
 *      - 命中 → 实例化 MachineMcpSearchChannel + 注册到 registry（临时 enabled=true）
 *      - 未命中 → skip（链路降级到 search.zhipu，byte-identical v1.3）
 *  - 用户 key 在 headers.Authorization（非 env）—— 与 ZHIPU/BRAVE/BING 三源的本质差异：
 *    本 provider 不走 QuotaLedger（机器 key 不在 Lasso 计费域内；失败就 fallback）
 *
 * **安全红线（INV-72）**：
 *  - 永不 log Authorization 值；detector 返 { url, authorization } 仅用于 McpClient.connectHttp
 *  - 读 ~/.claude.json 只读，永不写 / rename / unlink
 *  - 文件不存在 / 无 web-search-prime / 缺 auth → graceful skip 不崩
 *
 * INV-72 grep：本 provider 单独导出，不进 BUILTIN_PROVIDERS（保零回归范式）。
 */
const MACHINE_MCP: ProviderConfig = {
  name: "machine_mcp", // channel 名 search.machine_mcp（与 MachineMcpSearchChannel.name 对齐）
  type: "self_hosted", // 复用机器已配 MCP（Lasso 不付钱、不经 QuotaLedger；type=self_hosted 最贴近）
  endpoint_url: null, // 运行时由 detector 注入（来自 ~/.claude.json）；不进静态 schema
  keys: [], // 不走 env / 不走 QuotaLedger；authorization 由 detector 直接传 channel 构造器
  free_quota_per_month: 0, // 机器 key 配额归 CC 用户域，Lasso 不感知
  quota_model: "request", // 失败就 fallback；不计费
  fallback_order: -1, // v1.4 默认 order 最前（search.machine_mcp 在 DEFAULT_FALLBACK_ORDER[0]）
  free_tier_level: "L1", // 借力已有 MCP，对 Lasso 是零成本
  policy_risk: "safe", // 读自己机器的 CC 全局配置，不外发
  licence: "mit",
  commercial_safe: true,
  tags: ["search"],
  enabled: false, // 默认禁用；index.ts 探测命中时条件注册（INV-72）
};

/**
 * v1.4 Phase A 机器 MCP provider（parse-v1.4 §Phase A）。
 *
 * 单独导出，**不进 BUILTIN_PROVIDERS**（参照 DESKTOP_PROVIDERS / CLOUD_BROWSER_PROVIDERS /
 * SEARCH_FALLBACK_PROVIDERS 范式，保 v1.3 零回归）：
 *  - v1.3 ProviderRegistry 测试断言 byCap("search") 不含 machine_mcp 仍绿
 *  - INV-72 grep MACHINE_MCP 字面量在 providers.ts 即合规（不要求进 BUILTIN_PROVIDERS）
 *  - index.ts 装配段：detectMachineSearchMcp() 命中时 new MachineMcpSearchChannel
 */
export const MACHINE_MCP_PROVIDERS: readonly ProviderConfig[] = [MACHINE_MCP];

/** 单独导出便于 INV-72 grep + 测试断言（tags=["search"] + enabled=false 默认禁用）。 */
export { MACHINE_MCP };

export const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  ZHIPU,
  BROWSE_HEADLESS,
  BROWSE_LOGGED_IN,
  BRAVE,
  TAVILY_WATCH,
];
