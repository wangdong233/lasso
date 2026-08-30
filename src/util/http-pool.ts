/**
 * http-pool（parse2 §3.6.2 / F3.5.7 连接池；review-r1 自 SubprocessManager.ts 迁出）
 *
 * v0.2 起 undici keep-alive Agent 池寄居在 SubprocessManager——与子进程管理零语义
 * 关系（R-DEP-01：manager public 面 18 方法），且迫使纯 HTTP 工具（fetch_url /
 * wayback / fetch_feed）为拿连接池持 SubprocessManager 句柄。review-r1 抽为独立
 * util（与 kill-tree 同级）：模块级 Map 单一真源， INV-32 断言不变（禁 new Agent /
 * 禁裸 fetch，必经 acquireHttpClient）。
 *
 * 行为零变化：同一 origin 多次调用返同一个 Agent，TCP/TLS 连接在
 * keepAliveTimeout=30s 内复用。智谱 + Brave 同 host 并发请求 p95 改善（V5 风险
 * 缓解）；不破坏 v0.1 fetch 行为（V7 风险：dispatcher 注入是 undici 标准路径，
 * headers/redirect/SSRF 守卫都透传）。
 *
 * 设计：返回 `{ fetch }` 而非裸 Agent，便于 BraveChannel 注入测试 mock 同构。
 */
import { Agent } from "undici";
import { logger } from "./logger.js";

/** 模块级连接池（key = host origin；每 host 一个独立 undici Agent）。 */
const httpAgents = new Map<string, Agent>();

/**
 * 取一个 host 专属的 keep-alive HTTP client。
 *
 * @param origin host origin，如 "https://api.search.brave.com"。
 *                含 scheme + host（可选 :port），不含 path/query。
 */
export function acquireHttpClient(origin: string): { fetch: typeof fetch } {
  if (!httpAgents.has(origin)) {
    httpAgents.set(
      origin,
      new Agent({
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000,
        connections: 8,
      }),
    );
    logger.info({ evt: "http_pool_created", origin });
  }
  const agent = httpAgents.get(origin)!;
  // 注：cast 仅为平息 undici-types 与 @types/node Dispatcher 在 FormData
  // 子类型上的形状差异（V7 风险点）。运行时 undici Agent 直接被 global fetch
  // 接收（Node 内置 undici），无 runtime 开销。
  const dispatcher = agent as unknown as Parameters<typeof fetch>[1] extends
    | { dispatcher?: infer D }
    | undefined
    ? D
    : never;
  return {
    fetch: ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(url, { ...init, dispatcher })) as typeof fetch,
  };
}

/** 全停清池（关闭所有 keep-alive Agent 避免进程 hang；幂等）。 */
export async function closeAllHttpAgents(): Promise<void> {
  await Promise.all(
    [...httpAgents.values()].map((a) =>
      a.close().catch((e: unknown) =>
        logger.warn({ evt: "http_pool_close_error", error: String(e) }),
      ),
    ),
  );
  httpAgents.clear();
}
