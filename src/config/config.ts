/**
 * 配置加载（parse1 §2 + parse2 §3.1.4 v0.2 升级 + parse10 §3 v0.9 Phase B）
 *
 * 真源：env (ZHIPU_API_KEY / BRAVE_API_KEYS / BING_API_KEYS / LASSO_CDP_PORT /
 *       LASSO_CACHE_DIR / LASSO_SEARCH_FREE_ONLY / LASSO_SSRF_*)。
 * TODO v0.3：再合并 ~/.claude.json 的 lasso 段（Phase A 不读盘，保持简单）。
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
import type { FreeTierLevel, ProviderConfig } from "../types.js";
import { BUILTIN_PROVIDERS, SEARCH_FALLBACK_PROVIDERS } from "./providers.js";
import { ProviderRegistry } from "./provider-registry.js";

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

/**
 * 读 env、合并 BUILTIN_PROVIDERS、注入 env-derived keys。
 * 不抛错——缺 key 时 channel 自报 unavailable（doctor 也会标 fail）。
 */
export function loadConfig(opts: LoadConfigOptions): LassoConfig {
  const env = opts.env ?? process.env;

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
