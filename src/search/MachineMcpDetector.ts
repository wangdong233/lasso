/**
 * MachineMcpDetector —— v1.4 Phase A（parse-v1.4 §Phase A 机器 MCP 复用）。
 *
 * 用户需求：零配置优先——如果机器已配过 web-search-prime MCP（CC 全局 ~/.claude.json），
 * Lasso 直接复用它的 Authorization Bearer key 先搜；额度不足/失败 → fallback 链自动
 * 降级到 search.zhipu（Lasso 自己 key）→ brave → bing → browse_headless。
 *
 * **安全红线（INV-72）**：
 *  - 只读 ~/.claude.json（永不写；永不 rename / unlink）
 *  - 只取 web_search_prime / bigmodel.cn 的 http entry 的 url + headers.Authorization
 *  - **永不 log Authorization 值**（log 只说 detected/missing；hashKey 也不打——本 provider 无 ledger）
 *  - 文件不存在 / JSON 损坏 / 无目标 MCP → 返 null 不抛（graceful skip → 链路降级 search.zhipu）
 *  - type 非 http（如 stdio / sse）→ skip（不混用 transport）
 *  - 缺 headers.Authorization → null（没 key 等于没配）
 *
 * 零回归承诺：~/.claude.json 不存在 / 无 web-search-prime / 缺 auth → detectMachineSearchMcp()
 * 返 null → index.ts 不实例化 MachineMcpSearchChannel → FallbackChain 跳过 → 行为等价 v1.3。
 *
 * 借鉴：config.ts.loadConfigFileEnv（read-only + JSON parse 错返空范式）+
 *       cc-control-all/doc/00-总览.md §机器 MCP 复用调研结论（headers.Authorization 非 env）。
 */
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";

/**
 * 探测结果：仅 url + Authorization（不暴露裸 key 给 log；只用于注入 MachineMcpSearchChannel）。
 *
 * 字段语义：
 *  - url：web_search_prime MCP endpoint（streamable-http；如
 *         https://open.bigmodel.cn/api/mcp/web_search_prime/mcp）
 *  - authorization：完整 "Bearer xxx" 串（来自 ~/.claude.json headers.Authorization）
 */
export interface MachineSearchMcp {
  url: string;
  authorization: string;
}

/**
 * 默认 ~/.claude.json 路径（CC 全局配置）。
 * LASSO_MACHINE_CLAUDE_JSON_PATH env 可覆盖（绝对路径，便于测试 + 多实例隔离）。
 *
 * 注意（守用户硬约束②）：这里读的是 CC 全局配置而非 ~/.lasso/config.json。
 * 用户硬约束是「Lasso 自己的 key 在 ~/.lasso/config.json 配」；而「机器 MCP 复用」
 * 是另一回事——它读的是用户在 CC 全局配过的 web-search-prime MCP，Lasso 借力不拥有。
 */
export function getClaudeJsonPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LASSO_MACHINE_CLAUDE_JSON_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".claude.json");
}

/**
 * URL 启发式：是否像 web_search_prime / bigmodel.cn 搜索 MCP。
 * 同形 entry 名可能不固定（web-search-prime / zhipu-search / etc.），
 * 故以 URL 作稳定信号（与 main loop 预查结论一致）。
 */
function looksLikeSearchMcp(url: string): boolean {
  return (
    typeof url === "string" &&
    (url.includes("web_search_prime") || url.includes("bigmodel.cn"))
  );
}

/**
 * 探测机器的 web_search_prime MCP 配置（read-only，永不抛错）。
 *
 * 算法：
 *  1. readFileSync(getClaudeJsonPath()) —— 文件不存在/不可读 → 返 null
 *  2. JSON.parse —— 损坏 → 返 null（不 log key；仅 log detected/missing）
 *  3. 顶层非对象 / 无 mcpServers 字段 → 返 null
 *  4. 遍历 mcpServers entries：找 type=http 且 url 含 web_search_prime/bigmodel.cn
 *     且 headers.Authorization 存在的 entry
 *  5. 找到 → 返 { url, authorization }；找不到 → 返 null
 *
 * 安全：
 *  - 只用 readFileSync（不写、不 stat、不 rename）
 *  - 函数体内永不 console.log / logger.* 任何含 authorization 字段的内容
 *  - 调用方（index.ts）也只能 log「detected/missing」布尔，禁止 log authorization
 */
export function detectMachineSearchMcp(
  env: NodeJS.ProcessEnv = process.env,
): MachineSearchMcp | null {
  const filePath = getClaudeJsonPath(env);
  let body: string;
  try {
    body = readFileSync(filePath, "utf8");
  } catch {
    // 文件不存在 / 不可读 → graceful skip（零配置兼容）
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // JSON 损坏 → graceful skip（用户配置形态不在 Lasso 控制内；不崩）
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as { mcpServers?: unknown };
  const servers = root.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return null;
  }
  // 遍历 entries —— 找第一个匹配的 http + search-url + Authorization 三元组
  for (const [, val] of Object.entries(servers as Record<string, unknown>)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const entry = val as {
      type?: unknown;
      url?: unknown;
      headers?: unknown;
    };
    // type 必须 = "http"（stdio / sse / 缺省都跳过；不混用 transport）
    if (entry.type !== "http") continue;
    if (typeof entry.url !== "string" || !looksLikeSearchMcp(entry.url)) {
      continue;
    }
    const headers = entry.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
      continue;
    }
    const auth = (headers as { Authorization?: unknown }).Authorization;
    if (typeof auth !== "string" || auth.trim().length === 0) continue;
    // 命中：返 url + 完整 Authorization 串（含 "Bearer " 前缀，McpClient.connectHttp 直接用）
    return { url: entry.url, authorization: auth };
  }
  return null;
}
