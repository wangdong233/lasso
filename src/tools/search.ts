/**
 * search tool 注册（parse1 §3.12 + parse2 §3.3.4 v0.2 升级）
 *
 * v0.1：单一 fallback 链 search.zhipu → browse_headless（cross_modal=true）。
 * v0.2：加 engine enum / free_only / attributed / 多源扇出 / SearchCache。
 *
 * v0.2 兼容性（parse2 §2.2）：
 *  - engine 默认从 "zhipu" 改为 "auto"，但 brave 未注入时 auto 走单源 zhipu
 *    （功能等价 v0.1）→ v0.1 调用方零感知
 *  - free_only / attributed 全可选默认值，不传 = v0.1 行为
 *  - registerSearchTool 签名：v0.1 前 4 参保留，v0.2 加可选 brave / registry / cache
 *    → v0.1 调用方零改动；v0.2 装配在 index.ts 显式传 brave/cache
 *
 * 多源扇出走 FallbackDecider 不开第二套（INV-4）：fanout 是 primary="fanout" 的
 * executor 内部策略，不绕过 fallback 引擎。fanout 失败 → decider 自动升 browse_headless。
 *
 * SearchCache 7 天 TTL（parse2 §3.4）：cache key 含 engine+region+limit（INV-11），
 * 命中后若 attributed=true 再走 withAttribution（attribution 不入 cache key）。
 *
 * 借鉴：parse2 §3.3.4；10 §2.2 三层能力袋；附录 B SEARCH_DESCRIPTION。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  FreeTierLevel,
  InteractResult,
  SearchResult,
} from "../types.js";
import type { SearchChannel } from "../channels/SearchChannel.js";
import type { BraveChannel } from "../channels/BraveChannel.js";
import type { ProviderRegistry } from "../config/provider-registry.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import type { ChannelExecutor } from "../fallback/FallbackDecider.js";
import type { BrowseExec } from "../serp/extract.js";
import { serpScrapeFallback } from "../serp/extract.js";
import type { SerpHealthMonitor } from "../serp/SerpHealthMonitor.js";
import { fanOutSearch, allocateLimit } from "../search/MultiSourceFanout.js";
import { withAttribution } from "../search/AttributedSearch.js";
import { filterByFreeTier } from "../search/FreeTierRouter.js";
import type { SearchCache } from "../search/SearchCache.js";
import { SEARCH_DESCRIPTION } from "./descriptions.js";
import { searchAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";

// ============================================================
// Schema（v0.1 全保留 + v0.2 加 enum + free_only + attributed）
// ============================================================
export const searchSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  /**
   * v0.2 enum：auto（多源扇出，默认）/ zhipu（单源中文主力）/ brave（单源英文）。
   * v0.1 默认 "zhipu" 改为 "auto"：brave 未注入时降级为单源 zhipu，功能等价 v0.1。
   */
  engine: z.enum(["zhipu", "brave", "auto"]).default("auto"),
  region: z.string().default("cn"),
  no_cache: z.boolean().default(false),
  /** v0.2 新增（parse2 §3.3.3）：L1/L2/L3/L4 四级分级路由 */
  free_only: z.enum(["L1", "L2", "L3", "L4"]).optional(),
  /** v0.2 新增（parse2 §3.3.2）：true 时每条结果带 served_by 标签 */
  attributed: z.boolean().default(false),
};

// ============================================================
// 注册器（v0.1 前 4 参 + v0.2 可选 brave/registry/cache）
// ============================================================
/**
 * @param server              MCP server
 * @param search              SearchChannel（智谱）
 * @param decider             单一 fallback 引擎
 * @param browseHeadlessExec  跨模态降级执行器
 * @param brave               v0.2 可选：BraveChannel（多源扇出时注入）
 * @param registry            v0.2 可选：ProviderRegistry（free_only 过滤 + quota 查询）
 * @param cache               v0.2 可选：SearchCache（命中/写入）
 */
export function registerSearchTool(
  server: McpServer,
  search: SearchChannel,
  decider: FallbackDecider,
  browseHeadlessExec: BrowseExec,
  // v0.2 可选注入（不传 = v0.1 行为）
  brave?: BraveChannel,
  registry?: ProviderRegistry,
  cache?: SearchCache,
  /**
   * v0.7 可选（parse8 §3.4）：SerpHealthMonitor 注入。
   * 未注入（null / undefined）→ serpScrapeFallback 行为完全等价 v0.6（零回归）。
   * 注入                     → browse_headless 抽完结果后通知 serpHealth（hit/miss 计数）。
   */
  serpHealth?: SerpHealthMonitor | null,
): void {
  server.tool(
    "search",
    SEARCH_DESCRIPTION,
    searchSchema,
    searchAnnotations,
    async (args) => {
      const query: string = args.query;
      const limit: number = args.limit;
      const engine: "zhipu" | "brave" | "auto" = args.engine;
      const region: string = args.region;
      const noCache: boolean = args.no_cache;
      const attributed: boolean = args.attributed;
      const freeOnly: FreeTierLevel | undefined = args.free_only;

      // ---------- 1. cache 命中（除非 no_cache）----------
      if (!noCache && cache) {
        const cached = await cache.get(query, engine, region, limit);
        if (cached) {
          // attribution 不入 cache key —— 命中后若 attributed=true 再走一次 wrap
          const outResult: InteractResult<SearchResult> = { ...cached };
          if (attributed && outResult.data) {
            outResult.data = {
              ...outResult.data,
              results: withAttribution(
                outResult.data,
                outResult.served_by,
              ) as unknown as SearchResult["results"],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ...outResult, cached: true },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      // ---------- 2. 选源：engine="auto" + brave 可用 → 多源；否则单源 ----------
      const braveAvailable =
        brave !== undefined && (await brave.isAvailable());
      const zhipuAvailable = await search.isAvailable();

      // free_only 过滤（v0.2 §3.3.3）：L1/L2/L3/L4 四级。
      // 取 registry 中所有 search providers 过滤后判定 brave / zhipu 是否在允许集。
      // 默认 L4 = 全允许（zhipu=L2, brave=L2，都属于免费层）。
      // L1 → 都禁（无 provider 满足），返回 empty 结果（不让 zhipu 偷偷走）。
      // 未注入 registry（v0.1 兼容模式）→ 跳过过滤，视为全允许。
      const freeTierFilter: FreeTierLevel = freeOnly ?? "L4";
      const allowedSearchProviders = registry
        ? filterByFreeTier(
            registry.byCap("search").map((p) => p.config),
            freeTierFilter,
          )
        : null;
      const braveAllowedByFreeTier = allowedSearchProviders
        ? allowedSearchProviders.some((p) => p.name === "brave")
        : true;
      const zhipuAllowedByFreeTier = allowedSearchProviders
        ? allowedSearchProviders.some((p) => p.name === "zhipu")
        : true;

      // 极端情形：free_only 把所有 search provider 都过滤光（如 L1 + v0.2 无 L1 provider）
      // → 返回 empty didnt 结果（不抛错；保留 fallback_exhausted 风格的 retrieval_method）。
      // 仅在 registry 注入时生效——v0.1 兼容模式不走此分支。
      if (
        allowedSearchProviders !== null &&
        !braveAllowedByFreeTier &&
        !zhipuAllowedByFreeTier
      ) {
        const emptyResult: InteractResult<SearchResult> = {
          outcome: "didnt",
          data: {
            query,
            results: [],
            count: 0,
            engine: "filtered",
            region,
          },
          served_by: "none",
          fallback_used: false,
          retrieval_method: "free_only_filtered",
          error: `free_only=${freeTierFilter} excluded all search providers`,
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(emptyResult, null, 2),
            },
          ],
        };
      }

      const canFanout =
        engine === "auto" &&
        braveAvailable &&
        zhipuAvailable &&
        braveAllowedByFreeTier &&
        zhipuAllowedByFreeTier &&
        registry !== undefined;

      let plan: { primary: string; fallbacks: string[]; cross_modal: boolean };
      let executor: ChannelExecutor<SearchResult>;

      if (canFanout) {
        // ---------- 多源扇出 ----------
        const sources = allocateLimit(
          limit,
          [
            {
              name: "search.zhipu",
              quotaRemaining: registry.get("zhipu")?.ledger?.totalRemaining() ?? 1000,
              quotaPerMonth:
                registry.get("zhipu")?.config.free_quota_per_month || 1000,
            },
            {
              name: "search.brave",
              quotaRemaining: registry.get("brave")?.ledger?.totalRemaining() ?? 2000,
              quotaPerMonth:
                registry.get("brave")?.config.free_quota_per_month || 2000,
            },
          ],
          query,
        );

        plan = {
          primary: "fanout",
          fallbacks: ["browse_headless"],
          cross_modal: true,
        };
        executor = async (channelName) => {
          if (channelName === "fanout") {
            return fanOutSearch(query, limit, sources, async (cn, sub) => {
              if (cn === "search.zhipu") {
                return search.search(query, {
                  limit: sub,
                  engine: "zhipu",
                  region,
                  no_cache: noCache,
                });
              }
              if (cn === "search.brave" && brave) {
                return brave.search(query, {
                  limit: sub,
                  region: region === "cn" ? "CN" : "US",
                  no_cache: noCache,
                });
              }
              throw new Error(`unknown_fanout_channel:${cn}`);
            });
          }
          if (channelName === "browse_headless") {
            return serpScrapeFallback(query, limit, browseHeadlessExec, serpHealth);
          }
          throw new Error(`unknown_channel:${channelName}`);
        };
      } else {
        // ---------- 单源（v0.1 行为）----------
        // engine="brave" 强制走 brave（若不可用降级 zhipu 由 fallback 链处理）
        const wantBrave =
          engine === "brave" && braveAvailable && braveAllowedByFreeTier;
        // zhipu 不允许时强制走 brave（即使 brave 不可用也试一次让 fallback 链处理）
        const target =
          wantBrave || !zhipuAllowedByFreeTier ? "search.brave" : "search.zhipu";

        plan = {
          primary: target,
          fallbacks: ["browse_headless"],
          cross_modal: true,
        };
        executor = async (channelName) => {
          if (channelName === "search.zhipu") {
            return search.search(query, {
              limit,
              engine: "zhipu",
              region,
              no_cache: noCache,
            });
          }
          if (channelName === "search.brave" && brave) {
            return brave.search(query, {
              limit,
              region: region === "cn" ? "CN" : "US",
              no_cache: noCache,
            });
          }
          if (channelName === "browse_headless") {
            return serpScrapeFallback(query, limit, browseHeadlessExec, serpHealth);
          }
          throw new Error(`unknown_channel:${channelName}`);
        };
      }

      const result = await decider.runWithFallback(plan, executor);

      // ---------- 3. attributed 后处理 ----------
      if (attributed && result.data) {
        result.data = {
          ...result.data,
          results: withAttribution(
            result.data,
            result.served_by,
          ) as unknown as SearchResult["results"],
        };
      }

      // ---------- 4. cache 写入（仅 worked + !no_cache + cache 注入）----------
      if (result.outcome === "worked" && !noCache && cache) {
        try {
          await cache.set(query, engine, region, limit, result);
        } catch (e) {
          logger.warn({
            evt: "search_cache_set_error",
            error: String(e),
          });
        }
      }

      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
