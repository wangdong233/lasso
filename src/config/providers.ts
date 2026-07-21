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

export const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  ZHIPU,
  BROWSE_HEADLESS,
  BROWSE_LOGGED_IN,
  BRAVE,
  TAVILY_WATCH,
];
