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

export const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  ZHIPU,
  BROWSE_HEADLESS,
  BROWSE_LOGGED_IN,
  BRAVE,
  TAVILY_WATCH,
];
