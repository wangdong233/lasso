/**
 * search tool 注册（parse1 §3.12 + parse2 §3.3.4 v0.2 升级 + parse10 §3 v0.9 Phase B）
 *
 * v0.1：单一 fallback 链 search.zhipu → browse_headless（cross_modal=true）。
 * v0.2：加 engine enum / free_only / attributed / 多源扇出 / SearchCache。
 * v0.9 Phase B（parse10 §3 + §1 决策 4）：加 engine="fallback_chain" 显式 opt-in。
 * v1.17 A3（doc/25 裁决③）：zhipu 直连 API channel 删除——engine enum 去 "zhipu" 值；
 * auto 路径源集合动态化 [machine_mcp?, brave?]；free_only 过滤后 API 源全空且
 * machine_mcp 已注入 → 降级 machine_mcp 单源（L1 ≤ 任何档位）。
 *
 * v1.17 A3 兼容性：
 *  - 显式传 engine="zhipu" 的旧调用收 zod 校验错误（错误信息自动列出合法值）——
 *    诚实破坏（CC 动态读 tool schema，无静默错路由风险）；README/CHANGELOG 写明。
 *  - registerSearchTool 签名收敛为「可选源注入」风格（search: SearchChannel 参数
 *    已删；machineMcp / brave 均可选注入）。
 *
 * v0.9 兼容性（parse10 §1 决策 4 + 零回归承诺）：
 *  - engine="auto" 默认行为 = 动态源集合扇出（machine_mcp + brave 两源齐 → fanout；
 *    单源 → 单源 primary；零 API 源 → serp_http→browse_headless 免费兜底链）
 *  - engine="fallback_chain" 是显式 opt-in：经 FallbackChain 构造 plan
 *    （machine_mcp → brave → serp_http → browse_headless 串行 fallback；v1.15
 *    Phase B 起 browse_headless 之前多一层 serp_http 裸 HTTP 快探），仍走
 *    FallbackDecider.runWithFallback（INV-4 / INV-55 单一 fallback 引擎铁律）。
 *    （v0.9 的 bing 第三源已于 v1.15 Phase A 死层清除；zhipu 直连档已于
 *    v1.17 A3 删除——INV-54 / INV-80 墓碑守卫。）
 *  - engine="fallback_chain" 全源熔断 → tri-state didnt（诚实，不伪造）+
 *    命中 RecordingStore.replay 最后兜底（若过去录过同 query 的 fixture）。
 *
 * v0.2 兼容性（parse2 §2.2）：
 *  - free_only / attributed 全可选默认值，不传 = 现行行为
 *  - registerSearchTool 签名：v0.2 加可选 brave / registry / cache
 *    → 旧调用方零改动；装配在 index.ts 显式传 brave/cache/recordingStore
 *    → v0.9 装配在 index.ts 显式传 recordingStore
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
  SearchFreshness,
  SearchResult,
} from "../types.js";
// v1.17 A3（zhipu 直连删除）：SearchChannel import 已删（INV-80 墓碑守卫）
import type { BraveChannel } from "../channels/BraveChannel.js";
// v1.15 Phase A（Bing 死层清除）：BingChannel 第三源 import 已删（INV-54 墓碑守卫）
// v1.4 Phase A（parse-v1.4 §Phase A）：MachineMcpSearchChannel 机器 MCP 复用
// 守 INV-72：本通道仅在 detectMachineSearchMcp() 命中时由 index.ts 注入；否则为 undefined
//            → channelOrder 不含 search.machine_mcp（零回归 byte-identical）
import type { MachineMcpSearchChannel } from "../channels/MachineMcpSearchChannel.js";
import type { ProviderRegistry } from "../config/provider-registry.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import type { ChannelExecutor } from "../fallback/FallbackDecider.js";
import type { BrowseExec } from "../serp/extract.js";
import { serpScrapeFallback } from "../serp/extract.js";
// v1.15 Phase B（parse22）：serp_http 裸 HTTP 快探层——browse_headless 之前的 ~1s 级探针
import type { HttpSerpExec } from "../serp/http-serp.js";
import type { SerpHealthMonitor } from "../serp/SerpHealthMonitor.js";
import { fanOutSearch, allocateLimit } from "../search/MultiSourceFanout.js";
import type { FanoutRpmOptions } from "../search/MultiSourceFanout.js";
import type { RpmLimiter } from "../util/rpm-limiter.js";
import type { CallerTierTracker } from "../runtime/CallerTierTracker.js";
import {
  callerIdFromMeta,
  callerCapExceededResult,
} from "../runtime/CallerTierTracker.js";
import { withAttribution } from "../search/AttributedSearch.js";
// v1.17 Phase B（A1 质量轴）：served_by → quality 静态映射（零启发式单一真源）
import { tagQuality } from "../search/QualityTag.js";
// v1.17 Phase C（A2′ 自研第二跳）：content_blocks opt-in 正文富化（parse24 §3）
import { enrichWithContentBlocks, type ContentSecondHopDeps } from "../search/ContentSecondHop.js";
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
   * v0.2 enum：auto（动态源扇出，默认）/ brave（单源英文）。
   * v1.17 A3：**"zhipu" 值已删**（zhipu 直连 API channel 死层清除；显式传
   * engine="zhipu" 收 zod 校验错误——错误信息自动列出合法值，诚实破坏）。
   * 智谱能力现行载体 = machine_mcp（机器 web-search-prime MCP 复用，auto/fallback_chain
   * 自动首位，无单源档——它的身份是「借机器 key」不是「Lasso 直连源」）。
   *
   * v0.9 Phase B 新增（parse10 §1 决策 4）：fallback_chain —— 显式 opt-in 串行
   * fallback（machine_mcp → brave → serp_http → browse_headless），仍走
   * FallbackDecider.runWithFallback（INV-55）。用于「search ≈永不失败」目标场景
   * （高可靠需求）。
   */
  engine: z.enum(["auto", "brave", "fallback_chain"]).default("auto"),
  region: z.string().default("cn"),
  no_cache: z.boolean().default(false),
  /** v0.2 新增（parse2 §3.3.3）：L1/L2/L3/L4 四级分级路由 */
  free_only: z.enum(["L1", "L2", "L3", "L4"]).optional(),
  /** v0.2 新增（parse2 §3.3.2）：true 时每条结果带 served_by 标签 */
  attributed: z.boolean().default(false),
  /**
   * v1.11 新增（round1 T6）：时效性过滤，透传各引擎（智谱 search_recency_filter /
   * Brave freshness=pd/pw/pm/py；browse_headless SERP 走 ddg df=）。
   * optional 无 default —— 不传 = 不限时效 = byte-identical 基线（与 extract_mode
   * 同款守护手法）。（v1.15 Phase A 前 Bing 源已清除。）
   */
  freshness: z.enum(["day", "week", "month", "year"]).optional(),
  /**
   * v1.17 Phase C 新增（A2′ 自研第二跳，doc/25 裁决② + parse24 §3）：
   * 拿到搜索结果后对 top N 条并发裸 HTTP 抓正文（raw HTTP，不起浏览器），
   * defuddle 抽取 + 查询相关裁剪（~6k 字符/条），零付费依赖。
   * optional 无 default —— 不传 = 关 = 现行行为 byte-identical（与
   * freshness/extract_mode 同款守护手法）。护栏：SSRF 必过 / 连接池 / 5s 超时 /
   * 256KB 字节闸 / 并发 3 / 整体 15s 软预算。
   * 失败条目如实 content_status 标注（fetch_failed/not_html/extract_failed），
   * 不改变主结果 outcome/served_by（tri-state 诚实；enrichment 非 fallback）。
   * cache 语义：蓝链照常缓存 7 天（content_blocks 不入 cache key），正文每次实抓。
   */
  content_blocks: z.number().int().min(1).max(5).optional(),
};

// ============================================================
// 注册器（v1.17 A3 收敛为「可选源注入」风格：machineMcp / brave 均可选）
// ============================================================
/**
 * @param server              MCP server
 * @param decider             单一 fallback 引擎
 * @param browseHeadlessExec  跨模态降级执行器
 * @param brave               v0.2 可选：BraveChannel（多源扇出时注入）
 * @param registry            v0.2 可选：ProviderRegistry（free_only 过滤 + quota 查询）
 * @param cache               v0.2 可选：SearchCache（命中/写入）
 * @param serpHealth          v0.7 可选：SerpHealthMonitor（serp 抽完结果后通知 hit/miss）
 *                            （v0.9 的 bing 参数已随 v1.15 Phase A Bing 死层清除删除；
 *                             v1.17 A3 的 search: SearchChannel 参数已随 zhipu 直连删除）
 * @param recordingStore      v0.9 可选：RecordingStore（全源熔断时 replay 最后兜底）
 */
/**
 * F-1（v1.14.0 收尾）：free_only 最终生效值——args 显式传参 > LASSO_SEARCH_FREE_ONLY env
 * （loadConfig 启动期已把 config 文件合并进 process.env，故 config 文件同路径生效）>
 * undefined（缺省 L4 全允许，由下游 `freeOnly ?? "L4"` 兜底）。导出供单测。
 */
export function resolveFreeOnly(
  argFreeOnly: FreeTierLevel | undefined,
): FreeTierLevel | undefined {
  if (argFreeOnly) return argFreeOnly;
  const env = process.env.LASSO_SEARCH_FREE_ONLY;
  return env === "L1" || env === "L2" || env === "L3" || env === "L4"
    ? env
    : undefined;
}

export function registerSearchTool(
  server: McpServer,
  decider: FallbackDecider,
  browseHeadlessExec: BrowseExec,
  // v0.2 可选注入（不传 = 无 brave 源）
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
   * 未注入 / null / undefined → channelOrder 不含 search.machine_mcp、auto 源集合
   *                             不含该源（零回归；INV-72 零回归承诺）。
   * 注入          → fallback_chain channelOrder 首位 + auto 扇出源（零配置优先，
   *                 machine key 先试；失败 → fallback 链降级到 brave → 兜底链）。
   * 注：machine_mcp 是 self_hosted L1，永远在 free_only 任何档位下（L1 ≤ L1/L2/L3/L4），
   *     故不参与 free_only 过滤剔除（不同于 brave 经 allowedSearchProviders 过滤）。
   */
  machineMcp?: MachineMcpSearchChannel | null,
  /**
   * v1.8 Phase E（W1-DEF-10）：CallerTierTracker per-caller 滑动窗配额。
   * 未注入 / null / undefined → 无事前 gate（零回归，byte-identical v1.7）。
   * 注入          → handler 入口 tryAcquire（callerId 取 request _meta.callerId，
   *                 CC 不传则 "anonymous"）；超额 → tri-state didnt +
   *                 retrieval_method="caller_cap_exceeded" 透明返回（parse7 §3.3）。
   */
  callerTier?: CallerTierTracker | null,
  /**
   * v1.8 Phase E（D6）：共享 RPM 滑动窗限频器（per-process 单例，由 index.ts 持有）。
   * 未注入 / null / undefined → fanOutSearch 不传 rpmOptions（byte-identical v1.7）。
   * 注入          → engine="auto" 多源扇出经 buildFanoutRpmOptions 接入
   *                 （maxBySource 从 registry ledger.rpmMax 读；未配置的源走
   *                 limiter.defaultMax=Infinity 即不限频，行为等价）。
   */
  rpmLimiter?: RpmLimiter | null,
  /**
   * v1.15 Phase B 可选（parse22 §2.1）：serp_http 裸 HTTP 快探执行器。
   * 未注入 / null / undefined → 三处 plan 的 fallbacks 仍为 ["browse_headless"]
   *   （零回归 byte-identical 基线，INV-72 同款注入式手法）。
   * 注入          → fallbacks 变 ["serp_http", "browse_headless"]：browse_headless
   *                 实搜（冷启动 ~11s）之前先 ~1s 级裸 HTTP 探一次（v1.14 重审实测：
   *                 裸 curl 打 search.brave.com 返 200+22 条而真 Chrome 反吃验证码）。
   * serp_http unknown（被挡/空/超时）→ decider 升 browse_headless 原路径不变。
   */
  httpSerp?: HttpSerpExec | null,
  /**
   * v1.17 Phase C 可选（A2′ 自研第二跳，parse24 §3）：content_blocks 正文富化依赖。
   * 未注入 / null / undefined → content_blocks 参数被诚实忽略（条目不带
   *   content_status；照 httpSerp 未注入的注入式手法，零回归 byte-identical）。
   * 注入          → 三条路径（fanout / 单源 / fallback_chain+replay）+ cache 命中
   *                 路径的 worked 结果统一富化 top content_blocks 条。
   * fetchImpl 由 index.ts 装 subproc.acquireHttpClient(origin).fetch 池包装（INV-32）。
   */
  contentDeps?: ContentSecondHopDeps | null,
): void {
  server.tool(
    "search",
    SEARCH_DESCRIPTION,
    searchSchema,
    searchAnnotations,
    async (args, extra) => {
      // ---------- 0. caller-tier 事前 gate（v1.8 Phase E / W1-DEF-10）----------
      // parse7 §3.3 设计意图落地：handler 入口 tryAcquire；超额 transparent didnt。
      // 未注入 callerTier → 跳过（零回归）。cap=0（admin caller_cap_set）= 该 caller 封禁。
      if (callerTier) {
        const callerId = callerIdFromMeta(extra?._meta);
        if (!callerTier.tryAcquire(callerId)) {
          const denied = callerCapExceededResult(
            callerId,
            callerTier.currentUsage(callerId),
            callerTier.currentCap(callerId),
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(denied, null, 2) },
            ],
          };
        }
      }

      const query: string = args.query;
      const limit: number = args.limit;
      const engine: "auto" | "brave" | "fallback_chain" = args.engine;
      const region: string = args.region;
      const noCache: boolean = args.no_cache;
      const attributed: boolean = args.attributed;
      // F-1（v1.14.0 收尾修复）：LASSO_SEARCH_FREE_ONLY env 此前是死配置——
      // config.ts 解析了但零消费者，KEY-GUIDE 承诺的「env 排 Brave」运行时不兑现。
      // 现为 args.free_only 的默认回退（per-call 显式传参仍最高优先）。
      const freeOnly: FreeTierLevel | undefined = resolveFreeOnly(args.free_only);
      // v1.11（round1 T6）：时效性过滤（透传三引擎 + 入 cache key）
      const freshness: SearchFreshness | undefined = args.freshness;
      // v1.17 Phase C（A2′ 第二跳）：content_blocks opt-in（缺省 undefined = 关；
      // contentDeps 未注入时参数被诚实忽略——照 httpSerp 注入式手法）
      const contentBlocks: number | undefined = args.content_blocks;

      // ---------- 1. cache 命中（除非 no_cache）----------
      if (!noCache && cache) {
        const cached = await cache.get(query, engine, region, limit, freshness);
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
                  // v1.17 Phase C（A2′）：cache 命中路径同样富化（蓝链来自 cache，
                  // 正文每次实抓——parse24 §3.2「cache 命中与新查均适用」；
                  // enrich 纯函数不改写 cached 信封本体，零 cache 污染）
                  {
                    ...(contentBlocks && contentDeps
                      ? await maybeEnrichContent(outResult, query, contentBlocks, contentDeps)
                      : outResult),
                    cached: true,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      // ---------- 2. 选源：v1.17 A3 动态源集合 [machine_mcp?, brave?] ----------
      const braveAvailable =
        brave !== undefined && (await brave.isAvailable());

      // free_only 过滤（v0.2 §3.3.3）：L1/L2/L3/L4 四级。
      // 取 registry 中所有 search providers 过滤后判定 brave 是否在允许集。
      // 默认 L4 = 全允许（brave=L4 计量计费——2026-02 免费档取消，21-搜索方案重审
      // S-1 改判；默认路径 Brave 仍参与扇出）。
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

      // v1.17 A3 联动（§2.3-4）：free_only 过滤后 API 源全空（brave 被滤除）且
      // machine_mcp 已注入 → 降级 machine_mcp 单源（L1 ≤ 任何档位；与 fallback_chain
      // 路径的既有语义对齐）；无 machine_mcp 才诚实返 free_only_filtered 空结果。
      const apiSourcesExhaustedByFreeTier =
        allowedSearchProviders !== null && !braveAllowedByFreeTier;
      if (apiSourcesExhaustedByFreeTier && !machineMcp) {
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

      // v1.17 A3（§2.3-3）：auto 路径源集合动态构造——
      //   machine_mcp：注入即参与（isAvailable 由 decider 运行时判，与 fallback_chain
      //               channelOrder 同款「只看注入」语义）；不参与 free_only 过滤（L1）。
      //   brave：available 且 free_tier 允许时参与。
      // 三态：两源齐 → fanout；单源 → 单源 primary；零 API 源 → serp_http→browse_headless
      //       免费兜底链（KEY-GUIDE 既有承诺「一家不配也有搜索」保持）。
      const autoSources: string[] = [];
      if (machineMcp) autoSources.push("search.machine_mcp");
      if (braveAvailable && braveAllowedByFreeTier) autoSources.push("search.brave");
      // free_only 降级修正：API 源被滤空且 machine_mcp 在 → 源集合就是 machine_mcp 单源
      // （上面 apiSourcesExhaustedByFreeTier && machineMcp 时 brave 不在集合，天然成立）。

      const canFanout =
        engine === "auto" &&
        autoSources.length >= 2 &&
        registry !== undefined;

      // ============================================================
      // v0.9 Phase B（parse10 §3 + §1 决策 4）：engine="fallback_chain" 显式 opt-in
      // ============================================================
      // 守 INV-55：经 FallbackChain.runFallbackChain → decider.runWithFallback
      //           （单一 fallback 引擎；不开第二套串行 fallback 循环）。
      // 守 INV-57：recordingStore 默认 OFF；replay 查的是过去录制 fixture，与本次录制开关无关。
      // 守 INV-58：本路径内不调 wayback_lookup（wayback 是独立 tool）。
      // 守 INV-59：saveIfRecording 是 sync void，fire-and-forget；search 主路径不 await。
      // 零回归：engine="auto" / "brave" 路径完全等价（不进此分支）。
      if (engine === "fallback_chain") {
        const fbResult = await runFallbackChainEngine(
          query,
          limit,
          region,
          noCache,
          freshness,
          brave ?? null,
          browseHeadlessExec,
          decider,
          recordingStore ?? null,
          // free_only 过滤：fallback_chain 也尊重 L1-L4 路由
          braveAllowedByFreeTier,
          // v1.4 Phase A：machine MCP 复用注入（detector 命中时由 index.ts 传入）
          machineMcp ?? null,
          // v1.15 Phase B（parse22 §2.2）：serp_http 快探注入（browse_headless 之前）
          httpSerp ?? null,
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
        // v1.17 Phase C（A2′）：cache.set 恒在 content 富化**之前**——蓝链入缓存，
        // 正文不入（第二跳每次实抓；INV-11 cache key 不含 content_blocks）。
        if (fbResult.outcome === "worked" && !noCache && cache) {
          try {
            await cache.set(query, engine, region, limit, fbResult, freshness);
          } catch (e) {
            logger.warn({
              evt: "search_cache_set_error",
              engine: "fallback_chain",
              error: String(e),
            });
          }
        }

        // ---------- v1.17 Phase C（A2′）：第二跳富化（出口三：fallback_chain+replay）----------
        const fbOut =
          contentBlocks && contentDeps
            ? await maybeEnrichContent(fbResult, query, contentBlocks, contentDeps)
            : fbResult;

        return {
          content: [
            { type: "text", text: JSON.stringify(fbOut, null, 2) },
          ],
        };
      }

      let plan: { primary: string; fallbacks: string[]; cross_modal: boolean };
      let executor: ChannelExecutor<SearchResult>;

      // v1.15 Phase B（parse22 §2.2）：注入 httpSerp 时 browse_headless 之前先快探一层。
      // 未注入 → 空数组 → fallbacks 仍为 ["browse_headless"]（零回归 byte-identical）。
      const serpHttpLayer: string[] = httpSerp ? ["serp_http"] : [];

      if (canFanout) {
        // ---------- 多源扇出（v1.17 A3：machine_mcp + brave 动态源集合）----------
        // S-1（21-搜索方案重审）：配额 hint 缺省 0（registry 未装配该 provider 时
        // allocateLimit 视为无配额信息）。machine_mcp 不进 registry / 无 ledger →
        // quotaRemaining=0/quotaPerMonth=0 → allocateLimit 退化为 weight=1 兜底（可测）。
        const sources = allocateLimit(
          limit,
          [
            {
              name: "search.machine_mcp",
              quotaRemaining:
                registry.get("machine_mcp")?.ledger?.totalRemaining() ?? 0,
              quotaPerMonth:
                registry.get("machine_mcp")?.config.free_quota_per_month || 0,
            },
            {
              name: "search.brave",
              quotaRemaining:
                registry.get("brave")?.ledger?.totalRemaining() ?? 0,
              quotaPerMonth:
                registry.get("brave")?.config.free_quota_per_month || 0,
            },
          ],
          query,
        );

        plan = {
          primary: "fanout",
          fallbacks: [...serpHttpLayer, "browse_headless"],
          cross_modal: true,
        };
        executor = async (channelName) => {
          if (channelName === "fanout") {
            // v1.8 Phase E（D6）：rpmOptions 接线——v1.7 前此调用只传 4 参，
            // RpmLimiter/F3.1.12 设计从未生效。limiter 注入时传入（maxBySource 从
            // registry ledger.rpmMax 读）；未注入保持 v1.7 调用形状（零回归）。
            return fanOutSearch(
              query,
              limit,
              sources,
              async (cn, sub) => {
                if (cn === "search.machine_mcp" && machineMcp) {
                  return machineMcp.search(query, {
                    limit: sub,
                    engine: "machine_mcp",
                    region,
                    no_cache: noCache,
                    ...(freshness ? { freshness } : {}),
                  });
                }
                if (cn === "search.brave" && brave) {
                  return brave.search(query, {
                    limit: sub,
                    region: region === "cn" ? "CN" : "US",
                    no_cache: noCache,
                    ...(freshness ? { freshness } : {}),
                  });
                }
                throw new Error(`unknown_fanout_channel:${cn}`);
              },
              rpmLimiter ? buildFanoutRpmOptions(rpmLimiter, registry) : undefined,
            );
          }
          if (channelName === "serp_http" && httpSerp) {
            // v1.15 Phase B（parse22 §2.2）：裸 HTTP SERP 快探（~1s；成功短路，
            // unknown/空由 decider 升 browse_headless 慢路径兜底）
            return httpSerp(query, { region, freshness, limit });
          }
          if (channelName === "browse_headless") {
            // v1.12（round2 T2-5）：freshness 透传（ddg df=）
            return serpScrapeFallback(query, limit, browseHeadlessExec, serpHealth, freshness);
          }
          throw new Error(`unknown_channel:${channelName}`);
        };
      } else {
        // ---------- 单源（v1.17 A3：动态源集合首个 / 免费兜底链）----------
        // engine="brave" 显式指名 brave（不可用/被滤除时降级到源集合首个——
        // 与 v0.2「zhipu 不允许时强制 brave」同型的偏好语义，方向反转）；
        // engine="auto" 单源退化：源集合首个（machine_mcp 或 brave）；
        // 零 API 源（machine_mcp 未注入 + brave 未配 key/被滤）→ 免费兜底链：
        // serp_http（注入时快探）否则直达 browse_headless。
        const wantBrave =
          engine === "brave" && braveAvailable && braveAllowedByFreeTier;
        const target = wantBrave
          ? "search.brave"
          : autoSources.length > 0
            ? autoSources[0]
            : httpSerp
              ? "serp_http"
              : "browse_headless";

        // primary 已是兜底链成员时去重（browse_headless primary 无 fallback 可降；
        // serp_http primary 的 fallback 是 browse_headless 慢路径）
        const fallbacks =
          target === "browse_headless"
            ? []
            : target === "serp_http"
              ? ["browse_headless"]
              : [...serpHttpLayer, "browse_headless"];

        plan = {
          primary: target,
          fallbacks,
          cross_modal: true,
        };
        executor = async (channelName) => {
          if (channelName === "search.machine_mcp" && machineMcp) {
            return machineMcp.search(query, {
              limit,
              engine: "machine_mcp",
              region,
              no_cache: noCache,
              ...(freshness ? { freshness } : {}),
            });
          }
          if (channelName === "search.brave" && brave) {
            return brave.search(query, {
              limit,
              region: region === "cn" ? "CN" : "US",
              no_cache: noCache,
              ...(freshness ? { freshness } : {}),
            });
          }
          if (channelName === "serp_http" && httpSerp) {
            // v1.15 Phase B（parse22 §2.2）：裸 HTTP SERP 快探（~1s；成功短路，
            // unknown/空由 decider 升 browse_headless 慢路径兜底）
            return httpSerp(query, { region, freshness, limit });
          }
          if (channelName === "browse_headless") {
            // v1.12（round2 T2-5）：freshness 透传（ddg df=）
            return serpScrapeFallback(query, limit, browseHeadlessExec, serpHealth, freshness);
          }
          throw new Error(`unknown_channel:${channelName}`);
        };
      }

      // ---------- A1 质量轴打标（v1.17 Phase B）----------
      // fanout / 单源两路径统一出口：machine_mcp/brave → api；serp_http/browse_headless →
      // scrape（含聚合串 "search.machine_mcp,search.brave" → api）。
      const result = tagQuality(await decider.runWithFallback(plan, executor));

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
      // v1.17 Phase C（A2′）：cache.set 恒在 content 富化**之前**——蓝链入缓存，
      // 正文不入（第二跳每次实抓；INV-11 cache key 不含 content_blocks）。
      if (result.outcome === "worked" && !noCache && cache) {
        try {
          await cache.set(query, engine, region, limit, result, freshness);
        } catch (e) {
          logger.warn({
            evt: "search_cache_set_error",
            error: String(e),
          });
        }
      }

      // ---------- 5. v1.17 Phase C（A2′）：第二跳富化（出口一/二：fanout / 单源）----------
      const finalOut =
        contentBlocks && contentDeps
          ? await maybeEnrichContent(result, query, contentBlocks, contentDeps)
          : result;

      return {
        content: [
          { type: "text", text: JSON.stringify(finalOut, null, 2) },
        ],
      };
    },
  );
}

// ============================================================
// v1.17 Phase C（A2′ 第二跳）：富化出口 helper
// ============================================================
/**
 * 三路径 + cache 命中路径统一调用的第二跳出口。
 *
 *  - topN < 1 / 非 worked / 空 results → enrichWithContentBlocks 内部原样返回
 *  - 外层 catch 是 belt（per-item 失败已在 ContentSecondHop 内部消化为
 *    content_status；此处只兜程序性异常）：富化**永不**让 search 主路径失败，
 *    也永不改变 outcome/served_by/quality（tri-state 诚实红线）
 */
async function maybeEnrichContent(
  result: InteractResult<SearchResult>,
  query: string,
  topN: number,
  deps: ContentSecondHopDeps,
): Promise<InteractResult<SearchResult>> {
  try {
    return await enrichWithContentBlocks(result, query, topN, undefined, deps);
  } catch (e) {
    logger.warn({ evt: "content_second_hop_error", error: String(e).slice(0, 200) });
    return result;
  }
}

// ============================================================
// v1.8 Phase E（D6）：fanout RPM 限频配置构造
// ============================================================
/**
 * 从 registry 各 search provider 的 QuotaLedger.rpmMax 构造 FanoutRpmOptions。
 *
 *  - ledger.rpmMax 未配置（当前 v1.8 配置面默认）→ maxBySource 空对象；
 *    limiter.defaultMax=Infinity → allow 恒 true，行为等价不限频（零回归），
 *    但 record() 记账生效（worked 调用入窗，为后续配置 cap 后立即可用）。
 *  - ledger.rpmMax 配了（QuotaLedger 构造第 5 参，parse3 §3.6 既有路径）→
 *    该源 60s 窗口超限被 MultiSourceFanout 跳过 + 记 partial_failures
 *    reason="rpm_limited:N/M"。
 *
 * 单独导出便于单测直接断言映射（不经 MCP 装配）。
 */
export function buildFanoutRpmOptions(
  limiter: RpmLimiter,
  registry?: ProviderRegistry,
): FanoutRpmOptions {
  const maxBySource: Record<string, number> = {};
  // v1.17 A3：zhipuRpm 项已删（zhipu 直连死层清除）。machine_mcp 不进 registry /
  // 无 ledger → rpmMax undefined → 不入 maxBySource（走 limiter.defaultMax，行为可测）；
  // 保留此查询是给 machine_mcp 未来进 registry 留门（开闭）。
  const machineMcpRpm = registry?.get("machine_mcp")?.ledger?.rpmMax;
  if (typeof machineMcpRpm === "number") {
    maxBySource["search.machine_mcp"] = machineMcpRpm;
  }
  const braveRpm = registry?.get("brave")?.ledger?.rpmMax;
  if (typeof braveRpm === "number") maxBySource["search.brave"] = braveRpm;
  return { limiter, maxBySource };
}

// ============================================================
// v0.9 Phase B（parse10 §3.2 + §3.4）：fallback_chain engine 主路径
// ============================================================
/**
 * engine="fallback_chain" 的主路径 —— 独立 helper 让 registerSearchTool 顶层 if 分支保持薄。
 *
 * 流程（parse10 §3 伪码 + §3.4 录制回放兜底 + v1.17 A3 链形状）：
 *  1. 构造 channelOrder：默认 DEFAULT_FALLBACK_ORDER [machine_mcp, brave]；
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
  /**
   * v1.11（round1 T6）：时效性过滤（透传 machine_mcp/brave 两源 + browse_headless SERP；
   * 不传 = 不限时效 = byte-identical 基线）。
   */
  freshness: SearchFreshness | undefined,
  brave: BraveChannel | null,
  browseHeadlessExec: BrowseExec,
  decider: FallbackDecider,
  recordingStore: RecordingStore | null,
  braveAllowedByFreeTier: boolean,
  /**
   * v1.4 Phase A（parse-v1.4 §Phase A）：MachineMcpSearchChannel 机器 MCP 复用。
   * 未注入 / null → channelOrder 不含 search.machine_mcp（零回归）。
   * 注入         → channelOrder 首位（machine key 先试；失败 fallback 链降级）。
   */
  machineMcp: MachineMcpSearchChannel | null = null,
  /**
   * v1.15 Phase B 可选（parse22 §2.2）：serp_http 裸 HTTP 快探执行器。
   * 未注入 / null → channelOrder 不含 serp_http 档（byte-identical Phase A 基线）。
   * 注入         → browse_headless 之前插入 serp_http（链：
   *                 machine_mcp → brave → serp_http → browse_headless → replay）。
   */
  httpSerp: HttpSerpExec | null = null,
): Promise<InteractResult<SearchResult>> {
  // ---------- 1. 构造 channelOrder（parse10 §3.2 + §3.5 + v1.4 Phase A machine_mcp）----------
  // 默认顺序 DEFAULT_FALLBACK_ORDER = [search.machine_mcp, search.brave]；
  // 按 channel 是否注入 + free_only 过滤剔除。
  // （v1.15 Phase A：search.bing 档已删——Bing 死层清除，INV-54 墓碑守卫。）
  // （v1.17 A3：search.zhipu 档已删——zhipu 直连死层清除，INV-80 墓碑守卫。）
  // （v1.15 Phase B：browse_headless 之前插 serp_http 快探档——注入时。）

  const channelOrder: string[] = [];
  // v1.4 Phase A：machine_mcp 首位（零配置优先）。
  // machine_mcp 是 self_hosted L1（providers.ts），永远在 free_only 任何档位下（L1 ≤ L1/L2/L3/L4）；
  // 故不参与 allowedSearchProviders 过滤剔除（不同于 brave 经 ProviderRegistry 过滤）。
  // 只看是否注入（注入即 channelOrder 首位；channel.isAvailable 由 decider 运行时判）。
  if (machineMcp) channelOrder.push("search.machine_mcp");
  if (brave && braveAllowedByFreeTier) channelOrder.push("search.brave");

  // v1.15 Phase B（parse22 §2.2）：serp_http 快探层——browse_headless 之前。
  // 裸 HTTP ~1s 探针先试（v1.14 重审实测：curl 打 search.brave.com 返 200+22 条
  // 而真 Chrome 反吃验证码）；unknown/空 → decider 升下面的 browse_headless 慢路径。
  if (httpSerp) channelOrder.push("serp_http");

  // 末尾追加 browse_headless（cross_modal 兜底；parse10 §3.5 cross_modal=true）。
  // 注意：browse_headless 是 SERP scrape，与两源 API 不同 surface。
  channelOrder.push("browse_headless");

  // ---------- 2. FallbackChain 走 decider.runWithFallback（INV-55）----------
  // availabilityPredicate：只对真正注入的 channel 返 true；
  //   - brave / machine_mcp 未注入 → 从 channelOrder 已剔除（上面 if 守）
  //   - 实际可用性（key 是否 exhausted / detector 是否命中）交给 decider 内部 breaker +
  //     channel.isAvailable 做运行时剔除；这里仅做「channel 是否注入」过滤（plan 形状层面）。
  const executor: ChannelExecutor<SearchResult> = async (channelName) => {
    if (channelName === "search.machine_mcp" && machineMcp) {
      return machineMcp.search(query, {
        limit,
        engine: "machine_mcp",
        region,
        no_cache: noCache,
        // v1.12（round2 T2-5）：freshness 透传（首位引擎此前静默忽略显式参数）
        ...(freshness ? { freshness } : {}),
      });
    }
    if (channelName === "search.brave" && brave) {
      return brave.search(query, {
        limit,
        region: region === "cn" ? "CN" : "US",
        no_cache: noCache,
        ...(freshness ? { freshness } : {}),
      });
    }
    if (channelName === "serp_http" && httpSerp) {
      // v1.15 Phase B（parse22 §2.2）：裸 HTTP SERP 快探（~1s；成功短路，
      // unknown/空由 decider 升 browse_headless 慢路径兜底）
      return httpSerp(query, { region, freshness, limit });
    }
    if (channelName === "browse_headless") {
      // SERP scrape fallback（与 v0.8 同函数；serpHealth hook 省略 —— fallback_chain
      // 是 caller-tier 显式 opt-in 路径，不再叠加 SerpHealthMonitor 计数；守简单性）。
      // v1.12（round2 T2-5）：freshness 透传（ddg df=）
      return serpScrapeFallback(query, limit, browseHeadlessExec, null, freshness);
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
      // ZB-3b（doc/24 verdict D-GO-1，2026-08-18）：freshness 查询的回放新鲜度门。
      // replay 键只有 (engine, query)，不含 freshness —— 不设门则 freshness=day 的查询
      // 在全源熔断时会拿到数月前录的 fixture 标 worked（freshness 倒挂：链尾是最陈源）。
      // 门规则：fixture 年龄 > freshness 窗口 → 视为 replay_miss（返原 fbResult，诚实 didnt/unknown）。
      // day→24h / week→7d / month→30d；year 与不传 freshness 不过门（基线语义不受影响）。
      const freshnessWindowMs =
        freshness === "day"
          ? 24 * 60 * 60 * 1000
          : freshness === "week"
            ? 7 * 24 * 60 * 60 * 1000
            : freshness === "month"
              ? 30 * 24 * 60 * 60 * 1000
              : 0; // year / 未传：不过门
      const replayAgeMs =
        replayResult.recorded_at !== undefined
          ? Date.now() - replayResult.recorded_at
          : 0;
      const replayStale =
        freshnessWindowMs > 0 && replayAgeMs > freshnessWindowMs;
      if (replayStale) {
        logger.info({
          evt: "fallback_chain_replay_stale_rejected",
          freshness,
          age_ms: replayAgeMs,
          window_ms: freshnessWindowMs,
        });
      } else if (replayResult.outcome === "worked" && replayResult.snapshot) {
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
          // A1 质量轴（v1.17 Phase B）：回放是过去快照 → quality="stale"
          // （tagQuality 在本引擎统一出口打标——engine 拥有自己的信封）
          return tagQuality(replayed);
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

  // A1 质量轴（v1.17 Phase B）：fallback_chain 统一出口打标——
  // machine_mcp/brave → "api"；serp_http/browse_headless → "scrape"；
  // （replay 命中路径已在上方早返处标 "stale"；didnt/unknown 也如实标路径轴）
  return tagQuality(fbResult);
}
