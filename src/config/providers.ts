/**
 * v0.1 内置 ProviderConfig 声明（parse1 §2 config/providers.ts）
 *
 * 三条通道对应三条 ProviderConfig。不变量 INV-3：ProviderConfig 的
 * interface 定义只在 types.ts；这里只是 import + 实例化，不 redefine。
 */
import type { ProviderConfig } from "../types.js";

/**
 * 智谱 web-search-prime —— 唯一的 api_key 型 provider（search 主通道）。
 * endpoint 来自智谱 MCP 文档（parse1 §4.1）：streamable-http + Bearer header。
 */
const ZHIPU: ProviderConfig = {
  name: "zhipu",
  type: "api_key",
  endpoint_url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
  keys: [], // 从 process.env.ZHIPU_API_KEY 注入（见 config.ts）
  free_quota_per_month: 0, // TODO v0.2 文档未公开精确值，doctor 检测时跳过
  quota_model: "monthly",
  fallback_order: 0,
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
};

export const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  ZHIPU,
  BROWSE_HEADLESS,
  BROWSE_LOGGED_IN,
];
