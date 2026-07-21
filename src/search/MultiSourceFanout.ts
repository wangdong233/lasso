/**
 * MultiSourceFanout —— 多源扇出 + limit 跨源分配（parse2 §3.3.1 / F3.1.6 + F3.1.7）。
 *
 * fanOutSearch：Promise.allSettled 并发所有源，聚合 worked 结果，partial_failures
 *   诚实记录（F3.9.7）；任一源 worked 即聚合；全失败 → outcome=unknown 让外层
 *   FallbackDecider 升 browse_headless。
 *
 * allocateLimit：按 quotaRemaining 比例 × 语言启发式（CJK vs EN）分配 limit 到各源。
 *
 * v0.3 Phase D 新增（parse3 §3.6，F3.1.12）：可选 RpmLimiter 集成。
 *   - 调用前 limiter.allow(source, rpm_max)；超限 → 跳过 + partial_failures reason="rpm_limited:N/M"
 *   - 成功后 limiter.record(source)（仅 worked 记账；429/timeout 不占窗口配额）
 *   - 默认不注入 → 保持 v0.2 行为（兼容）
 *
 * 简单性铁律（01）：本模块是纯函数 + Promise.allSettled，无新状态，无副作用；
 *   partial_failures 只透传不改 outcome，让外层 decider 单一范式判定（INV-4）。
 *
 * 借鉴：parse2 §3.3.1；10 §2.3 limit 跨源分配；mcp-web-search 三源 fallback 风格；
 *   parse3 §3.6 RpmLimiter 滑动窗主动降级。
 */
import type {
  AttributedResult,
  InteractResult,
  SearchResult,
} from "../types.js";
import type { RpmLimiter } from "../util/rpm-limiter.js";

// ============================================================
// 类型
// ============================================================
export interface FanoutSource {
  /** channel 全名（如 "search.zhipu" / "search.brave"），由 caller 给定 */
  name: string;
  /** 该源此次分配的 limit（由 allocateLimit 算出） */
  capacity: number;
}

/** fanOutSearch 内部聚合用的部分失败记录；映射到 InteractResult.partial_failures。 */
export interface FanoutPartialFailure {
  channel: string;
  error: string;
}

/**
 * v0.3 Phase D：fanOutSearch 的 RPM 限频配置（parse3 §3.6）。
 * 全部 optional —— 不传时 fanOutSearch 保持 v0.2 行为（不限频）。
 */
export interface FanoutRpmOptions {
  /** 共享的滑动窗限频器（per-process 单例，由 caller 持有） */
  limiter: RpmLimiter;
  /**
   * source.name → rpm_max 映射；缺失的源不限频（走 limiter.defaultMax）。
   * 例：{ "search.brave": 5 } 表示 brave 60s 窗口内最多 5 次调用。
   */
  maxBySource?: Record<string, number>;
}

// ============================================================
// fanOutSearch —— Promise.allSettled 聚合
// ============================================================
/**
 * 并发执行所有 sources，聚合结果。
 *
 * @param query    原始 query
 * @param limit    总 limit（聚合后按 original_rank 排序后截断到这个数）
 * @param sources  每个源的 name + capacity（由 allocateLimit 算出）
 * @param executor 把 (channelName, subLimit) 路由到具体 channel.search
 *
 * 返回 InteractResult<SearchResult>：
 *  - 任一源 worked 且聚合非空 → outcome=worked
 *  - 全失败 / 全空 → outcome=unknown + partial_failures 全记（外层 FallbackDecider 接手）
 *
 * 内部聚合阶段保留 served_by（AttributedResult），但最终 InteractResult.data.results
 * 是 SearchResult 形状（无 served_by）—— v0.1 形状零破坏。若 caller 要 attributed 输出，
 * 由 tools/search.ts 在 args.attributed=true 时显式走 withAttribution；fanout 不外泄
 * served_by 字段，保持 search cache key 稳定（cache 只看 engine+region+limit，不看 attribution）。
 */
export async function fanOutSearch(
  query: string,
  limit: number,
  sources: FanoutSource[],
  executor: (
    channelName: string,
    subLimit: number,
  ) => Promise<InteractResult<SearchResult>>,
  /**
   * v0.3 Phase D（parse3 §3.6）：可选 RPM 限频。
   * 不传 = v0.2 行为（不限频）。传了但 maxBySource 不含某源 → 该源走 limiter.defaultMax。
   */
  rpmOptions?: FanoutRpmOptions,
): Promise<InteractResult<SearchResult>> {
  // 边界：无源直接 unknown（防御，外层 caller 应保证 ≥1 源）
  if (sources.length === 0) {
    return {
      outcome: "unknown",
      data: null,
      served_by: "fanout(empty)",
      fallback_used: false,
      retrieval_method: "multi_source_fanout",
      error: "no_sources",
    };
  }

  // ------------------------------------------------------------
  // v0.3 Phase D：RPM 预检 —— 超限的源跳过 + 记 partial_failure
  // ------------------------------------------------------------
  /** 跳过的源（RPM 超限），与 settled 的 partialFailures 合并 */
  const rpmSkipped: FanoutPartialFailure[] = [];
  /** 实际下发的源（保序：与 sources 子集一致） */
  const activeSources: FanoutSource[] = [];
  for (const s of sources) {
    if (rpmOptions) {
      const cap = rpmOptions.maxBySource?.[s.name];
      // cap===undefined → limiter.allow 走 defaultMax；若 defaultMax=Infinity → 永远 allow
      if (!rpmOptions.limiter.allow(s.name, cap)) {
        const current = rpmOptions.limiter.currentUsage(s.name);
        rpmSkipped.push({
          channel: s.name,
          error: `rpm_limited:${current}/${cap ?? "infinity"}`,
        });
        continue;
      }
    }
    activeSources.push(s);
  }

  // 边界：所有源都被 RPM 跳过 → outcome=unknown + 全部记 partial_failures
  // （外层 FallbackDecider 可识别此情形：所有源瞬时频率过高，应换路径或退避）
  if (activeSources.length === 0) {
    return {
      outcome: "unknown",
      data: null,
      served_by: sources.map((s) => s.name).join(","),
      fallback_used: false,
      retrieval_method: "multi_source_fanout",
      error: "all_sources_rpm_limited",
      partial_failures: rpmSkipped.map((p) => ({
        channel: p.channel,
        error: p.error,
        timestamp: Date.now(),
      })),
    };
  }

  const settled = await Promise.allSettled(
    activeSources.map((s) => executor(s.name, s.capacity)),
  );

  const partialFailures: FanoutPartialFailure[] = [...rpmSkipped];
  /** 内部带 served_by 的聚合（attribution 留作后处理） */
  const aggregated: AttributedResult[] = [];
  /** 实际 worked 的源名（用作 served_by 合并字符串） */
  const workedSources: string[] = [];

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const sourceName = activeSources[i].name;
    if (s.status === "rejected") {
      partialFailures.push({
        channel: sourceName,
        error: safeStr(s.reason) || "unknown_rejection",
      });
      continue;
    }
    const r = s.value;
    if (r.outcome !== "worked" || !r.data || r.data.results.length === 0) {
      partialFailures.push({
        channel: sourceName,
        error: r.error ?? r.outcome,
      });
      continue;
    }
    // worked → 记 RPM（仅成功调用占窗口配额，parse3 §3.6）
    if (rpmOptions) {
      rpmOptions.limiter.record(sourceName);
    }
    workedSources.push(sourceName);
    for (let j = 0; j < r.data.results.length; j++) {
      const item = r.data.results[j];
      aggregated.push({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        ...(item.source !== undefined ? { source: item.source } : {}),
        served_by: sourceName,
        original_rank: j + 1,
      });
    }
  }

  // 全失败 → unknown + partial_failures
  if (aggregated.length === 0) {
    return {
      outcome: "unknown",
      data: null,
      served_by: sources.map((s) => s.name).join(","),
      fallback_used: false,
      retrieval_method: "multi_source_fanout",
      error: "all_sources_failed",
      partial_failures: partialFailures.map((p) => ({
        channel: p.channel,
        error: p.error,
        timestamp: Date.now(),
      })),
    };
  }

  // 按 original_rank 排序后截断到 limit（round-robin 风格简化；v0.3 升级为跨源交错）
  aggregated.sort((a, b) => (a.original_rank ?? 0) - (b.original_rank ?? 0));
  const trimmed = aggregated.slice(0, limit);

  return {
    outcome: "worked",
    data: {
      query,
      results: trimmed.map(stripAttribution),
      count: trimmed.length,
      engine: "multi",
      region: "auto",
    },
    served_by: workedSources.join(","),
    fallback_used: false,
    retrieval_method: "multi_source_fanout",
    partial_failures:
      partialFailures.length > 0
        ? partialFailures.map((p) => ({
            channel: p.channel,
            error: p.error,
            timestamp: Date.now(),
          }))
        : undefined,
  };
}

/** 把 AttributedResult 剥回 SearchResult.results 元素形状（去掉 served_by / original_rank）。 */
function stripAttribution(r: AttributedResult): SearchResult["results"][number] {
  const out: SearchResult["results"][number] = {
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  };
  if (r.source !== undefined) out.source = r.source;
  return out;
}

/** 安全把 unknown reason 转 string（Error / string / 其他）。 */
function safeStr(x: unknown): string {
  if (x instanceof Error) return x.message;
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

// ============================================================
// allocateLimit —— F3.1.7 limit 跨源分配
// ============================================================
/**
 * 按 quotaRemaining 比例 × 语言启发式分配 limit 到各源。
 *
 *  - quotaWeight = max(0.1, quotaRemaining / quotaPerMonth)
 *    （quotaPerMonth=0 时退化为 1；quotaRemaining=0 仍保 0.1 兜底，让该源拿到至少 1 条）
 *  - langBoost：CJK query → 含 "zhipu" 的源 *0.7 / 其他 *0.3
 *               非 CJK    → 含 "brave" 的源 *0.7 / 其他 *0.3
 *  - 每源 capacity = max(1, round(totalLimit × weight_i / Σweight))
 *
 * 不变性：
 *  - 每源 capacity >= 1（让每源至少探一次，验证存活）
 *  - Σcapacity 可能略 > totalLimit（fanOutSearch 末段 slice 保证最终不超过 limit）
 *  - 空数组输入 → 返空数组（fanOutSearch 走 unknown 分支）
 */
export function allocateLimit(
  totalLimit: number,
  sources: Array<{
    name: string;
    quotaRemaining: number;
    quotaPerMonth: number;
  }>,
  query: string,
): FanoutSource[] {
  if (sources.length === 0) return [];

  const isCJK = /[一-鿿぀-ヿ가-힯]/.test(query);

  const weights = sources.map((s) => {
    const quotaWeight =
      s.quotaPerMonth > 0
        ? Math.max(0.1, s.quotaRemaining / s.quotaPerMonth)
        : 1;
    const langBoost = isCJK
      ? s.name.includes("zhipu")
        ? 0.7
        : 0.3
      : s.name.includes("brave")
        ? 0.7
        : 0.3;
    return quotaWeight * langBoost;
  });

  const totalW = weights.reduce((a, b) => a + b, 0);
  if (totalW <= 0) {
    // 防御：权重全 0 时均分
    const even = Math.max(1, Math.floor(totalLimit / sources.length));
    return sources.map((s) => ({ name: s.name, capacity: even }));
  }

  return sources.map((s, i) => ({
    name: s.name,
    capacity: Math.max(1, Math.round((totalLimit * weights[i]) / totalW)),
  }));
}
