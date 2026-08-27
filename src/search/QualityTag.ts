/**
 * QualityTag —— A1 质量轴（doc/governance/05 decision-A A1 + doc/governance/06 裁决①；v1.17 Phase B）。
 *
 * InteractResult.quality 的**单一真源**：`qualityForServedBy(servedBy)` 按
 * served_by **静态映射**，零启发式（decision-A A1 风险条原文「判定逻辑按
 * served_by 静态映射即可」——不做内容嗅探 / 延迟猜测 / 域名分类）。
 *
 * 三档语义（对 LLM caller 的诚实信号，不是价值判断）：
 *  - "api"    ：结构化 API 响应（搜索 API / MCP 复用；蓝链契约源头）
 *  - "scrape" ：页面抓取产物（SERP 抽取 / 浏览器提取；结构性噪声天然更高）
 *  - "stale"  ：录制回放（过去某时刻的快照；freshness 查询要警惕）
 *
 * 映射表（v1.17 A3 后的链形状；**不含已删除的 zhipu 直连档**——INV-80 墓碑）：
 *  - search.machine_mcp / search.brave（含 fanout 聚合串）      → "api"
 *  - serp_http:* / browse_headless / browse_logged_in /
 *    browse_cloud_*                                              → "scrape"
 *  - recording_replay                                            → "stale"
 *  - 其他 / 空串 / 混档聚合                                       → undefined（不标，诚实）
 *
 * fanout 聚合串语义：`"search.machine_mcp,search.brave"` 逐段映射，全部同档才定档
 * （现行扇出源集合全是 api 档；未来若混档扇出则该条不标——宁缺毋假）。
 *
 * `quality` 是 optional 输出轴：缺省（undefined）= 不影响任何既有 JSON 形状；
 * 只在 search 工具三条路径出口统一打标（fanout / 单源 / fallback_chain+replay）。
 */
import type { InteractResult, SearchQuality } from "../types.js";

/** 精确 served_by → 档位（顶级 const，INV 风格单一真源；禁运行时改写）。 */
const QUALITY_BY_SERVED_BY: Readonly<Record<string, SearchQuality>> = {
  // API 档：结构化搜索 API / MCP 复用（v1.17 A3 后仅此两家 API 源）
  "search.machine_mcp": "api",
  "search.brave": "api",
  // scrape 档：页面抓取（SERP / 浏览器）
  browse_headless: "scrape",
  browse_logged_in: "scrape",
  "browse_cloud_browserbase": "scrape",
  "browse_cloud_stagehand": "scrape",
  "browse_cloud_steel": "scrape",
  // stale 档：录制回放（过去快照）
  recording_replay: "stale",
};

/**
 * scrape 档的 served_by 前缀集：serp_http 的 served_by 带引擎后缀
 * （"serp_http:ddg" 等，http-serp.ts 实测形状）——按前缀静态匹配，仍零启发式。
 */
const SCRAPE_SERVED_BY_PREFIXES: readonly string[] = ["serp_http"];

/** 单段 served_by → 档位（精确表 + 声明式前缀；查不到返 undefined）。 */
function qualityOfSegment(segment: string): SearchQuality | undefined {
  const exact = QUALITY_BY_SERVED_BY[segment];
  if (exact !== undefined) return exact;
  for (const prefix of SCRAPE_SERVED_BY_PREFIXES) {
    if (segment.startsWith(prefix)) return "scrape";
  }
  return undefined;
}

/**
 * served_by（单源或 fanout 聚合串）→ quality 档位。
 *
 * - 聚合串逐段映射，全部同档才返回该档（混档 / 任一段未知 → undefined）
 * - 空串 / undefined / "fanout(empty)" 等防御值 → undefined
 */
export function qualityForServedBy(
  servedBy: string | undefined,
): SearchQuality | undefined {
  if (!servedBy || servedBy.length === 0) return undefined;
  const parts = servedBy
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const first = qualityOfSegment(parts[0]!);
  if (first === undefined) return undefined;
  for (const p of parts.slice(1)) {
    if (qualityOfSegment(p) !== first) return undefined;
  }
  return first;
}

/**
 * 给 search 工具的 InteractResult 打 quality 标（三路径出口统一调用）。
 * 纯函数：返回新对象（不动入参）；查不到档位时原样返回（不新增字段，
 * 既有 JSON 快照零扰动）。
 */
export function tagQuality<T>(result: InteractResult<T>): InteractResult<T> {
  const q = qualityForServedBy(result.served_by);
  if (q === undefined) return result;
  return { ...result, quality: q };
}
