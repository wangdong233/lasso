/**
 * proxy.ts（doc/bugs/12 D11——download 工具族 proxy 三级显式解析单一真源）
 *
 * 语义（红队 H7）：
 *  - explicit `"off"` → null（直连；且 spawn 子进程须剥 proxy env 防引擎 env 拾取，
 *    见 stripProxyEnv）；
 *  - explicit 非 off 串（`host:port` 或 `http://host:port`）→ 归一为
 *    `http://host:port` 透传；
 *  - explicit `"auto"`/未提供 → 三级链：
 *      ① env LASSO_PROXY（与 browse 出口代理同名同源）
 *      ② env HTTPS_PROXY || https_proxy || HTTP_PROXY || http_proxy
 *      ③ null（直连）
 *
 * 返回形态统一 `http://host:port`（aria2 `--all-proxy` / yt-dlp `--proxy` /
 * undici ProxyAgent 三消费方同构）。分叉语义（env 代理 vs 显式）写死在本
 * 文件——D11「分叉写 doc」的代码侧锚点即此。
 */
import { ProxyAgent, type Dispatcher } from "undici";

export type ProxyInput = "auto" | "off" | string | null | undefined;

/** 归一：trim、空→null、无 scheme 补 `http://`、去尾 `/`。非法（无 host）→null。 */
export function normalizeProxyUrl(raw: string): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t) ? t : `http://${t}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * 三级解析（D11）。返回 `http://host:port` 或 null（直连）。
 * env 参数可注入（测试隔离）；缺省读 process.env。
 */
export function resolveProxy(
  explicit: ProxyInput,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit === "off") return null;
  if (explicit && explicit !== "auto") return normalizeProxyUrl(explicit);
  // auto：① LASSO_PROXY ② HTTPS_PROXY/https_proxy/HTTP_PROXY/http_proxy ③ null
  const chain = [
    env.LASSO_PROXY,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ];
  for (const candidate of chain) {
    const n = normalizeProxyUrl(candidate ?? "");
    if (n) return n;
  }
  return null;
}

const PROXY_ENV_KEYS = [
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
] as const;

/**
 * 给 spawn 子进程剥 proxy env（resolved=null 时必调——aria2/yt-dlp 都会拾取
 * env 代理，`proxy:"off"` 的用户意图会被环境变量静默推翻）。
 */
export function stripProxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if ((PROXY_ENV_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * undici 降级路 dispatcher（D11：EnvHttpProxyAgent 对齐语义的落点——
 * auto 解析到的就是 env 代理值，ProxyAgent(resolved) 与 EnvHttpProxyAgent
 * 等效且单一解析口在本文件）。返回 undefined=直连。
 * 调用方负责 close（bootstrap/undici-fallback 均一次性使用）。
 */
export function makeProxyDispatcher(proxy: string | null): ProxyAgent | undefined {
  return proxy ? new ProxyAgent(proxy) : undefined;
}

export type { Dispatcher };
