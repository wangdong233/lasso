/**
 * 配置加载（parse1 §2 config/config.ts）
 *
 * 真源：env (ZHIPU_API_KEY / LASSO_CDP_PORT / LASSO_CACHE_DIR / LASSO_SSRF_*)。
 * TODO v0.2：再合并 ~/.claude.json 的 lasso 段（Phase A 不读盘，保持简单）。
 *
 * 单一真相：LassoConfig 是整个进程读配置的唯一入口，channel 工具都从这里拿值。
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderConfig } from "../types.js";
import { BUILTIN_PROVIDERS } from "./providers.js";

export interface LassoConfig {
  runId: string;
  providers: Map<string, ProviderConfig>;
  zhipuApiKey: string | undefined;
  zhipuEndpoint: string;
  cdpPort: number;
  cacheDir: string;
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

  const zhipuKey = env.ZHIPU_API_KEY;
  if (zhipuKey) {
    const zhipu = providers.get("zhipu");
    if (zhipu) zhipu.keys = [zhipuKey];
  }

  const zhipuEndpoint =
    env.ZHIPU_ENDPOINT ?? providers.get("zhipu")?.endpoint_url ?? "";

  const cdpPort = parseInt(env.LASSO_CDP_PORT ?? "9222", 10);

  const cacheDir = env.LASSO_CACHE_DIR ?? defaultCacheDir();

  return {
    runId: opts.runId,
    providers,
    zhipuApiKey: zhipuKey,
    zhipuEndpoint,
    cdpPort,
    cacheDir,
  };
}
