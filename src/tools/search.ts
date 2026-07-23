/**
 * search tool 注册（parse1 §3.12 + parse2 §3.3.4 v0.2 升级 + parse10 §3 v0.9 Phase B）
 *
 * v0.1：单一 fallback 链 search.zhipu → browse_headless（cross_modal=true）。
 * v0.2：加 engine enum / free_only / attributed / 多源扇出 / SearchCache。
 * v0.9 Phase B（parse10 §3 + §1 决策 4）：加 engine="fallback_chain" 显式 opt-in。
 *
 * v0.9 兼容性（parse10 §1 决策 4 + 零回归承诺）：
 *  - engine="auto" 默认行为 byte-identical v0.8（MultiSourceFanout 多源扇出）
 *  - engine="fallback_chain" 是显式 opt-in：经 FallbackChain 构造 plan
 *    （zhipu → brave → bing → browse_headless 串行 fallback），仍走
 *    FallbackDecider.runWithFallback（INV-4 / INV-55 单一 fallback 引擎铁律）。
 *  - engine="fallback_chain" 全源熔断 → tri-state didnt（诚实，不伪造）+
 *    命中 RecordingStore.replay 最后兜底（若过去录过同 query 的 fixture）。
 *
 * v0.2 兼容性（parse2 §2.2）：
 *  - engine 默认从 "zhipu" 改为 "auto"，但 brave 未注入时 auto 走单源 zhipu
 *    （功能等价 v0.1）→ v0.1 调用方零感知
 *  - free_only / attributed 全可选默认值，不传 = v0.1 行为
 *  - registerSearchTool 签名：v0.1 前 4 参保留，v0.2 加可选 brave / registry / cache
 *    → v0.1 调用方零改动；v0.2 装配在 index.ts 显式传 brave/cache
 *    → v0.9 装配在 index.ts 显式传 bing / recordingStore
 *
 * 多源扇出走 FallbackDecider 不开第二套（INV-4）：fanout 是 primary="fanout" 的
 * executor 内部策略，不绕过 fallback 引擎。fanout 失败 → decider 自动升 browse_headless。
 *
 * v0.9 fallback_chain 走 FallbackDecider 不开第二套（INV-55 衍生）：FallbackChain
 * 是 plan 构造器（纯函数），构造完 plan 后交 decider.runWithFallback 执行。
 *
 * SearchCache 7 天 TTL（parse2 §3.4）：cache key 含 engine+region+limit（INV-11），
 * 命中后若 attributed=true 再走 withAttribution（attribution 不入 cache key）。
 *
 * 借鉴：parse2 §3.3.4；parse10 §3；10 §2.2 三层能力袋；附录 B SEARCH_DESCRIPTION。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  FreeTierLevel,
  InteractResult,
  ProviderConfig,
  SearchResult,
} from "../types.js";
import type { SearchChannel } from "../channels/SearchChannel.js";
import type { BraveChannel } from "../channels/BraveChannel.js";
// v0.9 Phase B（parse10 §3.1）：BingChannel 第三源
import type { BingChannel } from "../channels/BingChannel.js";
// v1.4 Phase A（parse-v1.4 §Phase A）：MachineMcpSearchChannel 机器 MCP 复用
// 守 INV-72：本通道仅在 detectMachineSearchMcp() 命中时由 index.ts 注入；否则为 undefined
//            → channelOrder 不含 search.machine_mcp（零回归 byte-identical v1.3）
import type { MachineMcpSearchChannel } from "../channels/MachineMcpSearchChannel.js";
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
// v0.9 Phase B（parse10 §3.2 + §3.4）：FallbackChain plan 构造器 + RecordingStore 兜底
import { runFallbackChain } from "../search/FallbackChain.js";
import type { RecordingStore } from "../serp/RecordingStore.js";
import { SEARCH_DESCRIPTION } from "./descriptions.js";
import { searchAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";

// ============================================================
// Schema（v0.1 全保留 + v0.2 加 enum + free_only + attributed + v0.9 加 fallback_chain）
// ============================================================
export const searchSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  /**
   * v0.2 enum：auto（多源扇出，默认）/ zhipu（单源中文主力）/ brave（单源英文）。
   * v0.1 默认 "zhipu" 改为 "auto"：brave 未注入时降级为单源 zhipu，功能等价 v0.1。
   *
   * v0.9 Phase B 新增（parse10 §1 决策 4）：fallback_chain —— 显式 opt-in 三层串行
   * fallback（zhipu → brave → bing → browse_headless），仍走 FallbackDecider.runWithFallback
   * （INV-55）。用于「search ≈永不失败」目标场景（高可靠需求）；engine="auto" 默认行为
   * byte-identical v0.8（不替换 fanout 默认，零回归）。
   */
  engine: z.enum(["zhipu", "brave", "auto", "fallback_chain"]).default("auto"),
  region: z.string().default("cn"),
  no_cache: z.boolean().default(false),
  /** v0.2 新增（parse2 §3.3.3）：L1/L2/L3/L4 四级分级路由 */
  free_only: z.enum(["L1", "L2", "L3", "L4"]).optional(),
  /** v0.2 新增（parse2 §3.3.2）：true 时每条结果带 served_by 标签 */
  attributed: z.boolean().default(false),
};

// ============================================================
// 注册器（v0.1 前 4 参 + v0.2 可选 brave/registry/cache + v0.9 可选 bing/recordingStore）
// ============================================================
/**
 * @param server              MCP server
 * @param search              SearchChannel（智谱）
 * @param decider             单一 fallback 引擎
 * @param browseHeadlessExec  跨模态降级执行器
 * @param brave               v0.2 可选：BraveChannel（多源扇出时注入）
 * @param registry            v0.2 可选：ProviderRegistry（free_only 过滤 + quota 查询）
 * @param cache               v0.2 可选：SearchCache（命中/写入）
 * @param serpHealth          v0.7 可选：SerpHealthMonitor（serp 抽完结果后通知 hit/miss）
 * @param bing                v0.9 可选：BingChannel（engine="fallback_chain" 第三源兜底）
 * @param recordingStore      v0.9 可选：RecordingStore（全源熔断时 replay 最后兜底；
 *                            engine="auto" 默认路径不注入 → byte-identical v0.8）
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
  /**
   * v0.9 Phase B 可选（parse10 §3 + §1 决策 4）：BingChannel 第三源。
   * 未注入 / null → engine="fallback_chain" 路径中 bing 兜底层不可用（仍走 zhipu → brave →
   *                 browse_headless 三层；byte-identical v0.8 fallback 链 + 多一档 headless）。
   * 注入          → engine="fallback_chain" 时 bing 作 search.bing 兜底层（key=[] 时
   *                 BingChannel.isAvailable 自返 false，FallbackChain 过滤掉）。
   */
  bing?: BingChannel | null,
  /**
   * v0.9 Phase B 可选（parse10 §3.4 + INV-57）：RecordingStore。
   * 未注入 / null → engine="fallback_chain" 全源熔断时返 tri-state didnt（诚实不伪造），
   *                 byte-identical v0.8 fallback_exhausted 行为。
   * 注入          → 全源熔断后调 recordingStore.replay 作最后兜底档；命中返 worked +
   *                 served_by="recording_replay"；未命中仍返 didnt（INV-57 默认 OFF 守：
   *                 replay 查的是过去录制 fixture，与本次 LASSO_RECORD_SEARCH 开关无关）。
   */
  recordingStore?: RecordingStore | null,
  /**
   * v1.4 Phase A 可选（parse-v1.4 §Phase A）：MachineMcpSearchChannel 机器 MCP 复用。
   * 未注入 / null / undefined → engine="fallback_chain" 路径 channelOrder 不含 search.machine_mcp
   *                             （行为 byte-identical v1.3；INV-72 零回归承诺）。
   * 注入          → channelOrder 首位 unshift search.machine_mcp（零配置优先，machine key 先试；
   *                 失败 → fallback 链自动降级到 search.zhipu → brave → bing → browse_headless）。
   * 注：machine_mcp 是 self_hosted L1，永远在 free_only 任何档位下（L1 ≤ L1/L2/L3/L4），
   *     故不参与 free_only 过滤剔除（不同于 zhipu/brave/bing 经 allowedSearchProviders 过滤）。
   */
  machineMcp?: MachineMcpSearchChannel | null,
): void {
  server.tool(
    "search",
    SEARCH_DESCRIPTION,
    searchSchema,
    searchAnnotations,
    async (args) => {
      const query: string = args.query;
      const limit: number = args.limit;
      const engine: "zhipu" | "brave" | "auto" | "fallback_chain" = args.engine;
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

      // ============================================================
      // v0.9 Phase B（parse10 §3 + §1 决策 4）：engine="fallback_chain" 显式 opt-in
      // ============================================================
      // 守 INV-55：经 FallbackChain.runFallbackChain → decider.runWithFallback
      //           （单一 fallback 引擎；不开第二套串行 fallback 循环）。
      // 守 INV-57：recordingStore 默认 OFF；replay 查的是过去录制 fixture，与本次录制开关无关。
      // 守 INV-58：本路径内不调 wayback_lookup（wayback 是独立 tool）。
      // 守 INV-59：saveIfRecording 是 sync void，fire-and-forget；search 主路径不 await。
      // 零回归：engine="auto" / "zhipu" / "brave" 路径完全等价 v0.8（不进此分支）。
      if (engine === "fallback_chain") {
        const fbResult = await runFallbackChainEngine(
          query,
          limit,
          region,
          noCache,
          search,
          brave ?? null,
          bing ?? null,
          browseHeadlessExec,
          decider,
          recordingStore ?? null,
          // free_only 过滤：fallback_chain 也尊重 L1-L4 路由
          braveAllowedByFreeTier,
          zhipuAllowedByFreeTier,
          allowedSearchProviders,
          // v1.4 Phase A：machine MCP 复用注入（detector 命中时由 index.ts 传入）
          machineMcp ?? null,
        );

        // ---------- attributed 后处理（与 v0.8 路径同范式）----------
        if (attributed && fbResult.data) {
          fbResult.data = {
            ...fbResult.data,
            results: withAttribution(
              fbResult.data,
              fbResult.served_by,
            ) as unknown as SearchResult["results"],
          };
        }

        // ---------- cache 写入（仅 worked + !no_cache + cache 注入）----------
        // 与 v0.8 路径同范式：engine 字段是 cache key 一部分（fallback_chain 独立 key 空间）。
        if (fbResult.outcome === "worked" && !noCache && cache) {
          try {
            await cache.set(query, engine, region, limit, fbResult);
          } catch (e) {
            logger.warn({
              evt: "search_cache_set_error",
              engine: "fallback_chain",
              error: String(e),
            });
          }
        }

        return {
          content: [
            { type: "text", text: JSON.stringify(fbResult, null, 2) },
          ],
        };
      }

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

// ============================================================
// v0.9 Phase B（parse10 §3.2 + §3.4）：fallback_chain engine 主路径
// ============================================================
/**
 * engine="fallback_chain" 的主路径 —— 独立 helper 让 registerSearchTool 顶层 if 分支保持薄。
 *
 * 流程（parse10 §3 伪码 + §3.4 录制回放兜底）：
 *  1. 构造 channelOrder：默认 DEFAULT_FALLBACK_ORDER [zhipu, brave, bing]；
 *     按 channel 是否注入 + free_only 过滤剔除不可用源；
 *     末尾追加 browse_headless（cross_modal 兜底，parse10 §3.5）。
 *  2. FallbackChain.runFallbackChain 构造 plan + 调 decider.runWithFallback
 *     （INV-55 单一 fallback 引擎；本函数不自造循环）。
 *  3. worked → saveIfRecording（fire-and-forget；INV-59）。
 *  4. 全源 didnt/unknown → recordingStore.replay 最后兜底（parse10 §3.4）：
 *     命中 → worked + served_by="recording_replay"；
 *     未命中 → 透传原 didnt（tri-state 诚实，INV-57）。
 *
 * 守：
 *  - INV-55：本函数体内禁 for/while 调 executor（runFallbackChain 内部已 grep 守）；
 *            这里只在 runFallbackChain 之后做一次 replay 兜底，非循环。
 *  - INV-57：recordingStore 未注入（null）→ 跳过 replay，直接返 didnt。
 *  - INV-58：本函数不调 wayback_lookup（wayback 是独立 tool）。
 *  - INV-59：saveIfRecording 是 sync void，主路径不 await。
 *
 * 单独导出便于集成测直接调（不经 MCP server.tool 装配）。
 */
export async function runFallbackChainEngine(
  query: string,
  limit: number,
  region: string,
  noCache: boolean,
  search: SearchChannel,
  brave: BraveChannel | null,
  bing: BingChannel | null,
  browseHeadlessExec: BrowseExec,
  decider: FallbackDecider,
  recordingStore: RecordingStore | null,
  braveAllowedByFreeTier: boolean,
  zhipuAllowedByFreeTier: boolean,
  allowedSearchProviders: ProviderConfig[] | null,
  /**
   * v1.4 Phase A（parse-v1.4 §Phase A）：MachineMcpSearchChannel 机器 MCP 复用。
   * 未注入 / null → channelOrder 不含 search.machine_mcp（byte-identical v1.3）。
   * 注入         → channelOrder 首位 unshift（machine key 先试；失败 fallback 链降级）。
   */
  machineMcp: MachineMcpSearchChannel | null = null,
): Promise<InteractResult<SearchResult>> {
  // ---------- 1. 构造 channelOrder（parse10 §3.2 + §3.5 + v1.4 Phase A machine_mcp）----------
  // 默认顺序 DEFAULT_FALLBACK_ORDER = [search.machine_mcp, search.zhipu, search.brave, search.bing]；
  // 按 channel 是否注入 + free_only 过滤剔除。
  const bingAllowedByFreeTier = allowedSearchProviders
    ? allowedSearchProviders.some((p) => p.name === "bing")
    : true;

  const channelOrder: string[] = [];
  // v1.4 Phase A：machine_mcp 首位（零配置优先）。
  // machine_mcp 是 self_hosted L1（providers.ts），永远在 free_only 任何档位下（L1 ≤ L1/L2/L3/L4）；
  // 故不参与 allowedSearchProviders 过滤剔除（不同于 zhipu/brave/bing 经 ProviderRegistry 过滤）。
  // 只看是否注入（注入即 channelOrder 首位；channel.isAvailable 由 decider 运行时判）。
  if (machineMcp) channelOrder.push("search.machine_mcp");
  if (zhipuAllowedByFreeTier) channelOrder.push("search.zhipu");
  if (brave && braveAllowedByFreeTier) channelOrder.push("search.brave");
  if (bing && bingAllowedByFreeTier) channelOrder.push("search.bing");

  // 末尾追加 browse_headless（cross_modal 兜底；parse10 §3.5 cross_modal=true）。
  // 注意：browse_headless 是 SERP scrape，与三源 API 不同 surface。
  channelOrder.push("browse_headless");

  // ---------- 2. FallbackChain 走 decider.runWithFallback（INV-55）----------
  // availabilityPredicate：只对真正注入的 channel 返 true；
  //   - brave / bing / machine_mcp 未注入 → 从 channelOrder 已剔除（上面 if 守）
  //   - 实际可用性（key 是否 exhausted / detector 是否命中）交给 decider 内部 breaker +
  //     channel.isAvailable 做运行时剔除；这里仅做「channel 是否注入」过滤（plan 形状层面）。
  const executor: ChannelExecutor<SearchResult> = async (channelName) => {
    if (channelName === "search.machine_mcp" && machineMcp) {
      return machineMcp.search(query, {
        limit,
        engine: "machine_mcp",
        region,
        no_cache: noCache,
      });
    }
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
    if (channelName === "search.bing" && bing) {
      // Bing market code：region="cn" → "zh-CN"，否则 "en-US"（与 Brave region 映射同风格）。
      const market = region === "cn" ? "zh-CN" : "en-US";
      return bing.search(query, {
        limit,
        market,
        no_cache: noCache,
      });
    }
    if (channelName === "browse_headless") {
      // SERP scrape fallback（与 v0.8 同函数；serpHealth hook 省略 —— fallback_chain
      // 是 caller-tier 显式 opt-in 路径，不再叠加 SerpHealthMonitor 计数；守简单性）。
      return serpScrapeFallback(query, limit, browseHeadlessExec, null);
    }
    throw new Error(`unknown_fallback_chain_channel:${channelName}`);
  };

  const fbResult = await runFallbackChain<SearchResult>(
    decider,
    channelOrder,
    executor,
    // cross_modal=true：search → browse_headless 是跨 surface fallback（parse10 §3.5）
    { cross_modal: true },
  );

  // ---------- 3. worked → saveIfRecording（fire-and-forget；INV-59）----------
  // 仅当 recordingStore 注入 + outcome=worked + data 存在 → 触发 fire-and-forget save。
  // saveIfRecording 内部检查 LASSO_RECORD_SEARCH env；OFF 时立即 return（INV-57）。
  // 注：engine key 用 "fallback_chain" 让录制空间与 engine="auto" 隔离（避免污染）。
  if (fbResult.outcome === "worked" && fbResult.data && recordingStore) {
    try {
      const snapshot = JSON.stringify(fbResult.data);
      recordingStore.saveIfRecording("fallback_chain", query, snapshot);
    } catch (e) {
      // saveIfRecording 内部已有 .catch；此处兜底防 JSON.stringify 抛错（极端 data 形状）
      logger.warn({
        evt: "fallback_chain_record_failed",
        error: String(e),
      });
    }
  }

  // ---------- 4. 全源熔断 → recordingStore.replay 最后兜底（parse10 §3.4）----------
  // INV-57：replay 与录制开关独立 —— 过去录过的 fixture 即便本次录制 OFF 仍可回放。
  // 仅当 fallback_chain 全源失败（outcome !== worked）+ recordingStore 注入时尝试。
  if (fbResult.outcome !== "worked" && recordingStore) {
    try {
      const replayResult = await recordingStore.replay("fallback_chain", query);
      if (replayResult.outcome === "worked" && replayResult.snapshot) {
        // 命中录制 → 解析回 SearchResult 形状，标 served_by="recording_replay"
        // 解析失败仍透传原 didnt（不伪造；tri-state 诚实）
        try {
          const replayedData = JSON.parse(
            replayResult.snapshot,
          ) as SearchResult;
          const replayed: InteractResult<SearchResult> = {
            outcome: "worked",
            data: replayedData,
            served_by: "recording_replay",
            fallback_used: true,
            retrieval_method: "recording_replay",
            error: undefined,
            // 保留原 actions_and_results（让 caller 看到全源熔断的审计链）
            actions_and_results: fbResult.actions_and_results,
          };
          logger.info({
            evt: "fallback_chain_replay_hit",
            query_len: query.length,
            recorded_at: replayResult.recorded_at,
          });
          return replayed;
        } catch (e) {
          logger.warn({
            evt: "fallback_chain_replay_parse_failed",
            error: String(e),
          });
        }
      }
    } catch (e) {
      // replay 异常不应影响主路径返（recordingStore 是兜底，不应让兜底拖垮请求）
      logger.warn({
        evt: "fallback_chain_replay_error",
        error: String(e),
      });
    }
  }

  return fbResult;
}
