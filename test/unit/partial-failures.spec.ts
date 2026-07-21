/**
 * PartialFailures 单元测（parse2 §5.1 / §3.6.1 / F3.9.7）。
 *
 * 覆盖：
 *  - aggregatePartialFailures：全 worked → 空数组
 *  - aggregatePartialFailures：全 unknown/didnt → 全记
 *  - aggregatePartialFailures：worked + failed 混合 → 只记失败的
 *  - aggregatePartialFailures：error 缺省回退到 outcome 字符串
 *  - aggregatePartialFailures：timestamp 参数化（now 注入）
 *  - aggregatePartialFailures：空输入 → 空数组
 *  - hasPartialFailures：truthy 判定
 *  - countFailedChannels：唯一 channel 数
 *  - 与 InteractResult.partial_failures 字段兼容
 */
import { describe, it, expect } from "vitest";
import {
  aggregatePartialFailures,
  hasPartialFailures,
  countFailedChannels,
  type PerSourceResult,
} from "../../src/fallback/PartialFailures.js";
import type { InteractResult, PartialFailure, SearchResult } from "../../src/types.js";

// ============================================================
// fixture helpers
// ============================================================
function worked(channel: string): PerSourceResult {
  return { channel, outcome: "worked" };
}
function unknown(channel: string, error?: string): PerSourceResult {
  return { channel, outcome: "unknown", error };
}
function didnt(channel: string, error?: string): PerSourceResult {
  return { channel, outcome: "didnt", error };
}

// ============================================================
// cases
// ============================================================
describe("aggregatePartialFailures — 基础聚合", () => {
  it("空输入 → 空数组", () => {
    expect(aggregatePartialFailures([])).toEqual([]);
  });

  it("全 worked → 空数组（v0.2 简化：worked 一律不算 partial_failure）", () => {
    const r = aggregatePartialFailures([
      worked("search.zhipu"),
      worked("search.brave"),
    ]);
    expect(r).toEqual([]);
  });

  it("全 unknown/didnt → 全记（按原顺序）", () => {
    const now = 1_700_000_000_000;
    const r = aggregatePartialFailures(
      [unknown("search.zhipu", "timeout"), didnt("search.brave", "429")],
      now,
    );
    expect(r).toEqual([
      { channel: "search.zhipu", error: "timeout", timestamp: now },
      { channel: "search.brave", error: "429", timestamp: now },
    ]);
  });

  it("worked + failed 混合 → 只记失败的（worked 过滤掉）", () => {
    const now = 1_700_000_000_000;
    const r = aggregatePartialFailures(
      [
        worked("search.zhipu"),
        unknown("search.brave", "brave_status_429"),
        didnt("search.ddg", "blocked"),
      ],
      now,
    );
    expect(r).toHaveLength(2);
    expect(r[0].channel).toBe("search.brave");
    expect(r[1].channel).toBe("search.ddg");
  });

  it("error 缺省 → 用 outcome 字符串做 error", () => {
    const now = 1_700_000_000_000;
    const r = aggregatePartialFailures([unknown("search.brave")], now);
    expect(r[0].error).toBe("unknown");
  });

  it("timestamp 默认 = Date.now()（不注入时）", () => {
    const before = Date.now();
    const r = aggregatePartialFailures([unknown("x")]);
    const after = Date.now();
    expect(r[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(r[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("partial_count 字段不影响 v0.2 行为（worked + partial_count → 仍不算失败）", () => {
    const r = aggregatePartialFailures([
      { channel: "search.zhipu", outcome: "worked", partial_count: 3 },
    ]);
    expect(r).toEqual([]);
  });
});

describe("aggregatePartialFailures — PerSourceResult 兼容 InteractResult 形状", () => {
  it("可直接接受 InteractResult（含 outcome + 可选 error）作为输入", () => {
    const now = 1_700_000_000_000;
    const r1: InteractResult<SearchResult> = {
      outcome: "unknown",
      data: null,
      served_by: "search.brave",
      fallback_used: false,
      retrieval_method: "brave_api",
      error: "brave_status_429",
    };
    const r2: InteractResult<SearchResult> = {
      outcome: "worked",
      data: { query: "x", results: [], count: 0, engine: "zhipu", region: "cn" },
      served_by: "search.zhipu",
      fallback_used: false,
      retrieval_method: "zhipu_api",
    };
    // InteractResult 与 PerSourceResult 形状兼容（多了字段不影响）
    const aggregated = aggregatePartialFailures(
      [
        { channel: r2.served_by, outcome: r2.outcome },
        { channel: r1.served_by, outcome: r1.outcome, error: r1.error },
      ],
      now,
    );
    expect(aggregated).toEqual([
      { channel: "search.brave", error: "brave_status_429", timestamp: now },
    ]);
  });
});

describe("hasPartialFailures", () => {
  it("空数组 → false", () => {
    expect(hasPartialFailures({ partial_failures: [] })).toBe(false);
  });

  it("undefined → false", () => {
    expect(hasPartialFailures({})).toBe(false);
  });

  it("非空数组 → true", () => {
    const pf: PartialFailure[] = [
      { channel: "x", error: "boom", timestamp: 1 },
    ];
    expect(hasPartialFailures({ partial_failures: pf })).toBe(true);
  });
});

describe("countFailedChannels", () => {
  it("空 → 0", () => {
    expect(countFailedChannels([])).toBe(0);
  });

  it("相同 channel 多次失败 → 只计 1（unique）", () => {
    const pf: PartialFailure[] = [
      { channel: "search.brave", error: "429", timestamp: 1 },
      { channel: "search.brave", error: "429", timestamp: 2 },
      { channel: "search.brave", error: "5xx", timestamp: 3 },
    ];
    expect(countFailedChannels(pf)).toBe(1);
  });

  it("多 channel 各一次 → 全计", () => {
    const pf: PartialFailure[] = [
      { channel: "search.brave", error: "429", timestamp: 1 },
      { channel: "search.zhipu", error: "timeout", timestamp: 2 },
      { channel: "browse_headless", error: "serp_scrape_empty", timestamp: 3 },
    ];
    expect(countFailedChannels(pf)).toBe(3);
  });
});

describe("aggregatePartialFailures — 与 fanOutSearch 内嵌聚合等价", () => {
  /**
   * 本用例验证 fanOutSearch 内部 Promise.allSettled 后构造的 partial_failures
   * 与 aggregatePartialFailures 走相同语义（错误来自 error ?? outcome）。
   * 不直接 import fanOutSearch（已在 multi-source-fanout.spec.ts 测过），
   * 只比对 PureFunction 输出形状。
   */
  it("典型 3 源：1 worked + 1 unknown + 1 rejected → 2 partial_failures", () => {
    const now = 1_700_000_000_000;
    const r = aggregatePartialFailures(
      [
        worked("search.zhipu"),
        unknown("search.brave", "brave_status_429"),
        // 模拟 rejected：caller 已 safeStr 成 error string
        unknown("search.exa", "429"),
      ],
      now,
    );
    expect(r).toEqual([
      { channel: "search.brave", error: "brave_status_429", timestamp: now },
      { channel: "search.exa", error: "429", timestamp: now },
    ]);
  });
});
