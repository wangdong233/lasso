/**
 * 配置加载（parse1 §2 + parse2 §3.1.4 v0.2 升级 + parse10 §3 v0.9 Phase B + v1.3 Phase A config 文件机制）
 *
 * 真源（优先级低→高）：
 *   1. config 文件 ~/.lasso/config.json（v1.3 新增；扁平 JSON，key 名同 env；user-friendly 默认层）
 *   2. env (ZHIPU_API_KEY / BRAVE_API_KEYS / BING_API_KEYS / LASSO_CDP_PORT /
 *           LASSO_CACHE_DIR / LASSO_SEARCH_FREE_ONLY / LASSO_SSRF_*) —— 覆盖 config 文件（向后兼容）
 *
 * v1.3 Phase A（本提交）：config 文件机制落地。
 *   - DONE v1.3：读 ~/.lasso/config.json 扁平 JSON（LASSO_CONFIG_PATH 可覆盖路径）；
 *     合并顺序 file(base) → env(覆盖)。既有 -e KEY=VAL 装时 env 用户不破；零配置（无文件）仍可跑。
 *   - 不读 ~/.claude.json（早期 TODO 提及的路径已废弃；改走 ~/.lasso/config.json 独立文件，
 *     避免 CC 全局配置污染 + 用户难发现 lasso 段）。
 *
 * 单一真相：LassoConfig 是整个进程读配置的唯一入口，channel 工具都从这里拿值。
 *
 * v0.2 新增（parse2 §3.1.4，全保留 v0.1 env 与字段）：
 *  - BRAVE_API_KEYS / BRAVE_API_KEY CSV 多 Key 解析 → providers.get("brave").keys
 *  - LASSO_SEARCH_FREE_ONLY（默认 L4=全部允许；设 L2 则禁付费）
 *  - ProviderRegistry 装配（CapabilityBag 自动生成）
 *  - searchCacheDir（~/.cache/lasso/search-cache/，F3.1.4 cache 落盘根）
 *
 * v0.9 Phase B 新增（parse10 §3 + §1 决策 6 + INV-54）：
 *  - BING_API_KEYS / BING_API_KEY CSV 多 Key 解析 → conditionally add BING provider
 *  - **零回归承诺**：BING_API_KEYS 未配 → keys=[] → BING provider 不进 providers map
 *    → ProviderRegistry byCap("search") 不含 bing → 行为完全等价 v0.8。
 *  - 配 BING_API_KEYS → SEARCH_FALLBACK_PROVIDERS[0] (BING) 加进 providers map；
 *    ProviderRegistry 构造时 keys.length>0 → 创建 QuotaLedger → byCap("search") 含 bing。
 *  - BING 不进 BUILTIN_PROVIDERS（parse10 §3.1 + providers.ts 注释），保 v0.8 测试断言
 *    「byCap("search") 不含 bing」在 BING_API_KEYS 未配时仍绿。
 */
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import type { FreeTierLevel, ProviderConfig } from "../types.js";
import { BUILTIN_PROVIDERS, SEARCH_FALLBACK_PROVIDERS } from "./providers.js";
import { ProviderRegistry } from "./provider-registry.js";
import { logger } from "../util/logger.js";

export interface LassoConfig {
  runId: string;
  providers: Map<string, ProviderConfig>;
  zhipuApiKey: string | undefined;
  zhipuEndpoint: string;
  cdpPort: number;
  cacheDir: string;
  // --- v0.2 新增 ---
  /** ProviderRegistry 实例（v0.2 Phase A 落地，后续 channel/search 从这里查） */
  registry: ProviderRegistry;
  /** search cache 落盘根（~/.cache/lasso/search-cache/） */
  searchCacheDir: string;
  /** free_only 全局默认（env LASSO_SEARCH_FREE_ONLY，默认 L4=全部允许） */
  searchFreeOnly: FreeTierLevel;
}

export interface LoadConfigOptions {
  runId: string;
  env?: NodeJS.ProcessEnv;
}

function defaultCacheDir(): string {
  return path.join(os.homedir(), ".cache", "lasso");
}

// ============================================================
// v1.3 Phase A：config 文件机制（~/.lasso/config.json 扁平 JSON）
// ============================================================
/**
 * 默认 config 文件路径：~/.lasso/config.json。
 * 可用 env LASSO_CONFIG_PATH 覆盖（绝对路径，便于测试 + 多实例隔离）。
 *
 * 设计（守简单性 架构想法/01/02）：
 *  - 扁平 JSON，key 名与 env 同名（ZHIPU_API_KEY / BRAVE_API_KEYS / ...）；
 *    用户已在 KEY-GUIDE 认识这些 key 名，扁平 JSON 最低摩擦。
 *  - 不搞嵌套 schema（缠绕）。
 *  - 独立于 ~/.claude.json（避免 CC 全局配置污染；用户易发现 lasso 专属目录）。
 */
export function getConfigFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LASSO_CONFIG_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".lasso", "config.json");
}

/**
 * 读 config 文件（~/.lasso/config.json）扁平 JSON → Record<string,string>。
 *
 * 行为（守零配置启动 + 不崩）：
 *  - 文件不存在 / 不可读 → 返空对象（不报错；零配置无文件仍可跑）
 *  - JSON 解析错 → 返空对象 + logger.warn（不崩）
 *  - 顶层非对象（null/array/primitive） → 返空对象 + logger.warn
 *  - 值规范化（env 全字符串）：
 *      - string → 原样保留（含 CSV 如 BRAVE_API_KEYS）
 *      - boolean → "true" / "false"
 *      - number → String(n)（如 LASSO_CDP_PORT: 9222 → "9222"）
 *      - 其他类型（null/array/object）跳过
 *  - 下划线前缀字段（_comment 等）跳过（init 模板用 _comment 作 JSON 内文档）
 *
 * 返回的形状与 process.env 一致（全字符串值），可直接参与 env 合并。
 */
export function loadConfigFileEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const filePath = getConfigFilePath(env);
  let body: string;
  try {
    body = readFileSync(filePath, "utf8");
  } catch {
    // 文件不存在 / 不可读 → 零配置（正常情况，不 warn）
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    logger.warn({
      evt: "config_file_parse_error",
      path: filePath,
      error: String(e),
    });
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.warn({
      evt: "config_file_invalid_shape",
      path: filePath,
      detail: "top-level value is not an object",
    });
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // 跳过 _comment 等 metadata 字段（init 模板用）
    if (k.startsWith("_")) continue;
    if (typeof v === "string") {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v ? "true" : "false";
    } else if (typeof v === "number") {
      out[k] = String(v);
    }
    // null / array / object 跳过（不支持嵌套；扁平 JSON 红线）
  }
  return out;
}

/**
 * config init 模板（v1.3 Phase A）：所有已知 key 空值占位 + _comment 说明段。
 *
 * JSON 无注释，故用 _comment 字段作内嵌文档（用户首次打开可见说明）。
 * 用户填需要的 key 即可；未填的 key 留空字符串 → 等价 env 未设（channel 自报 unavailable）。
 */
export const CONFIG_TEMPLATE: Record<string, unknown> = {
  _comment:
    "Lasso config file. Flat JSON: keys match env variable names (see doc/KEY-GUIDE.md). Fill only the keys you need. Booleans use true/false; CSV keys like BRAVE_API_KEYS are comma-separated strings. Env variables override this file (backward compatible).",
  ZHIPU_API_KEY: "",
  BRAVE_API_KEYS: "",
  BING_API_KEYS: "",
  LASSO_ALLOW_CLOUD_BROWSER: false,
  BROWSERBASE_API_KEY: "",
  STAGEHAND_API_KEY: "",
  LASSO_COOKIE_PASSPHRASE: "",
  ZHIPU_ENDPOINT: "",
  LASSO_CDP_PORT: 9222,
  LASSO_CACHE_DIR: "",
  LASSO_SEARCH_FREE_ONLY: "L4",
  LASSO_VLM_ENDPOINT: "",
  LASSO_RECORD_SEARCH: false,
  LASSO_CALLER_CAP_DEFAULT: 100,
  LASSO_PROVIDERS_FILE: "",
};

/**
 * 写 config init 模板到 getConfigFilePath(env)。
 *
 * 行为：
 *  - 文件已存在 → 不覆盖（created=false；打印提示让用户手改）
 *  - 文件不存在 → mkdir -p ~/.lasso + 写模板（created=true）
 *  - mkdir/writeFile 失败 → 抛错（CLI 顶层 catch 转 exit 1）
 *
 * 返回 { path, created } 让 CLI 打印友好消息。
 */
export async function writeConfigTemplate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; created: boolean }> {
  const { promises: fsP } = await import("node:fs");
  const filePath = getConfigFilePath(env);
  // 已存在则不覆盖（保用户手改内容）
  try {
    await fsP.access(filePath);
    return { path: filePath, created: false };
  } catch {
    // 不存在，继续创建
  }
  await fsP.mkdir(path.dirname(filePath), { recursive: true });
  await fsP.writeFile(
    filePath,
    JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n",
    "utf8",
  );
  return { path: filePath, created: true };
}

/**
 * 读 env、合并 BUILTIN_PROVIDERS、注入 env-derived keys。
 * 不抛错——缺 key 时 channel 自报 unavailable（doctor 也会标 fail）。
 *
 * v1.3 Phase A 合并顺序：config 文件（base）→ env（覆盖）。
 *   - env 优先（向后兼容：既有 -e KEY=VAL 装时 env 用户不破；shell env 也仍生效）
 *   - config 文件兜底默认（user-friendly：安装零配置 + 改文件即配 key）
 *   - opts.env（测试注入）替换 process.env（保持 v1.2 测试契约：opts.env 提供时 process.env 不参与）
 */
export function loadConfig(opts: LoadConfigOptions): LassoConfig {
  const envSource = opts.env ?? process.env;
  // v1.3 Phase A：config 文件（base）→ env（覆盖）。fileEnv 用 envSource 的 LASSO_CONFIG_PATH 定位。
  const fileEnv = loadConfigFileEnv(envSource);
  const env = { ...fileEnv, ...envSource };

  const providers = new Map<string, ProviderConfig>();
  for (const p of BUILTIN_PROVIDERS) providers.set(p.name, { ...p });

  // v0.1：注入 ZHIPU_API_KEY（单值）
  const zhipuKey = env.ZHIPU_API_KEY;
  if (zhipuKey) {
    const zhipu = providers.get("zhipu");
    if (zhipu) zhipu.keys = [zhipuKey];
  }

  // v0.2 新增：Brave 多 Key CSV（parse2 §3.1.4 / §4.2）
  // BRAVE_API_KEYS="key1,key2,key3" 优先；兼容单值 BRAVE_API_KEY。
  const braveKeysCsv = env.BRAVE_API_KEYS ?? env.BRAVE_API_KEY ?? "";
  const braveKeys = braveKeysCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (braveKeys.length > 0) {
    const brave = providers.get("brave");
    if (brave) brave.keys = braveKeys;
  }

  // v0.9 Phase B 新增（parse10 §3 + §1 决策 6 + INV-54）：Bing 多 Key CSV
  // BING_API_KEYS="key1,key2" 优先；兼容单值 BING_API_KEY。
  // **零回归守**：keys=[] 时**不**把 BING 加进 providers map（让 ProviderRegistry
  //   byCap("search") 不含 bing，行为完全等价 v0.8）。
  // BING 来自 SEARCH_FALLBACK_PROVIDERS[0]（providers.ts 单独导出，不进 BUILTIN_PROVIDERS）。
  const bingKeysCsv = env.BING_API_KEYS ?? env.BING_API_KEY ?? "";
  const bingKeys = bingKeysCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (bingKeys.length > 0) {
    // 浅拷贝 SEARCH_FALLBACK_PROVIDERS[0] (BING) 避免污染模块级常量
    const bingConfig: ProviderConfig = {
      ...SEARCH_FALLBACK_PROVIDERS[0]!,
      keys: bingKeys,
    };
    providers.set("bing", bingConfig);
  }

  const zhipuEndpoint =
    env.ZHIPU_ENDPOINT ?? providers.get("zhipu")?.endpoint_url ?? "";

  const cdpPort = parseInt(env.LASSO_CDP_PORT ?? "9222", 10);

  const cacheDir = env.LASSO_CACHE_DIR ?? defaultCacheDir();

  // v0.2 新增：ProviderRegistry 装配（parse2 §3.1.3）
  // 用 [...providers.values()] 而非 BUILTIN_PROVIDERS，确保上面 env 注入的 keys 生效。
  const registry = new ProviderRegistry([...providers.values()]);

  // v0.2 新增：free_only 全局默认（L4=全部允许，L2=禁付费）
  const rawFreeOnly = (env.LASSO_SEARCH_FREE_ONLY ?? "L4") as FreeTierLevel;
  const searchFreeOnly: FreeTierLevel = ["L1", "L2", "L3", "L4"].includes(
    rawFreeOnly,
  )
    ? rawFreeOnly
    : "L4";

  return {
    runId: opts.runId,
    providers,
    registry,
    zhipuApiKey: zhipuKey,
    zhipuEndpoint,
    cdpPort,
    cacheDir,
    searchCacheDir: path.join(cacheDir, "search-cache"),
    searchFreeOnly,
  };
}
