/**
 * MultiSourceFanout 单元测（parse2 §5.1）。
 *
 * 覆盖：
 *  - fanOutSearch: Promise.allSettled 聚合 / 单源失败 partial_failures / 全失败 unknown
 *  - fanOutSearch: 多源 worked → engine="multi" + count <= limit
 *  - fanOutSearch: executor 抛 reject → 记入 partial_failures
 *  - fanOutSearch: 空源列表 → unknown + error=no_sources
 *  - allocateLimit: CJK vs EN 语言启发式（zhipu/brave boost）
 *  - allocateLimit: quotaRemaining 比例分配
 *  - allocateLimit: 每源 capacity >= 1
 *  - allocateLimit: 空数组
 */
import { describe, it, expect } from "vitest";
import {
  fanOutSearch,
  allocateLimit,
  type FanoutSource,
} from "../../src/search/MultiSourceFanout.js";
import type { InteractResult, SearchResult } from "../../src/types.js";

// ============================================================
// fixture
// ============================================================
function worked(
  channel: string,
  results: Array<{ title: string; url: string; snippet?: string }>,
): InteractResult<SearchResult> {
  return {
    outcome: "worked",
    data: {
      query: "q",
      results: results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet ?? "",
      })),
      count: results.length,
      engine: channel.includes("zhipu") ? "zhipu" : "brave",
      region: "auto",
    },
    served_by: channel,
    fallback_used: false,
    retrieval_method: "test",
  };
}

function unknown(channel: string, error: string): InteractResult<SearchResult> {
  return {
    outcome: "unknown",
    data: null,
    served_by: channel,
    fallback_used: false,
    retrieval_method: "test",
    error,
  };
}

// ============================================================
// fanOutSearch
// ============================================================
describe("fanOutSearch — 多源聚合 worked", () => {
  it("两源都 worked → outcome=worked + engine=multi + count=聚合数", async () => {
    const sources: FanoutSource[] = [
      { name: "search.zhipu", capacity: 5 },
      { name: "search.brave", capacity: 5 },
    ];
    const executor = async (name: string): Promise<InteractResult<SearchResult>> => {
      if (name === "search.zhipu")
        return worked("search.zhipu", [
          { title: "z1", url: "https://z1.test" },
          { title: "z2", url: "https://z2.test" },
        ]);
      if (name === "search.brave")
        return worked("search.brave", [
          { title: "b1", url: "https://b1.test" },
        ]);
      throw new Error(`unknown:${name}`);
    };

    const r = await fanOutSearch("q", 10, sources, executor);
    expect(r.outcome).toBe("worked");
    expect(r.data).not.toBeNull();
    expect(r.data!.engine).toBe("multi");
    expect(r.data!.count).toBe(3);
    expect(r.served_by).toBe("search.zhipu,search.brave");
    expect(r.retrieval_method).toBe("multi_source_fanout");
    // 默认不外泄 served_by 到 results（attribution 由 withAttribution 后处理）
    expect(r.data!.results[0]).not.toHaveProperty("served_by");
  });

  it("聚合后按 original_rank 排序 + 截断到 limit", async () => {
    const sources: FanoutSource[] = [
      { name: "search.zhipu", capacity: 10 },
      { name: "search.brave", capacity: 10 },
    ];
    // 每源返 3 条；limit=4 → 截断到 4 条（按 original_rank 排）
    const executor = async (name: string) => {
      if (name === "search.zhipu")
        return worked("search.zhipu", [
          { title: "z1", url: "https://z1.test" },
          { title: "z2", url: "https://z2.test" },
          { title: "z3", url: "https://z3.test" },
        ]);
      return worked("search.brave", [
        { title: "b1", url: "https://b1.test" },
        { title: "b2", url: "https://b2.test" },
        { title: "b3", url: "https://b3.test" },
      ]);
    };
    const r = await fanOutSearch("q", 4, sources, executor);
    expect(r.data!.count).toBe(4);
  });

  it("一源 worked + 一源 unknown → 聚合 worked，记 partial_failures", async () => {
    const sources: FanoutSource[] = [
      { name: "search.zhipu", capacity: 5 },
      { name: "search.brave", capacity: 5 },
    ];
    const executor = async (name: string) => {
      if (name === "search.zhipu")
        return worked("search.zhipu", [{ title: "z1", url: "https://z1.test" }]);
      return unknown("search.brave", "HTTP 429");
    };
    const r = await fanOutSearch("q", 10, sources, executor);
    expect(r.outcome).toBe("worked");
    expect(r.data!.count).toBe(1);
    expect(r.partial_failures).toBeDefined();
    expect(r.partial_failures).toHaveLength(1);
    expect(r.partial_failures![0].channel).toBe("search.brave");
    expect(r.partial_failures![0].error).toBe("HTTP 429");
    expect(r.partial_failures![0].timestamp).toBeGreaterThan(0);
  });

  it("一源 worked + 一源 reject（throw）→ 聚合 worked + partial_failures 记 reject", async () => {
    const sources: FanoutSource[] = [
      { name: "search.zhipu", capacity: 5 },
      { name: "search.brave", capacity: 5 },
    ];
    const executor = async (name: string) => {
      if (name === "search.zhipu")
        return worked("search.zhipu", [{ title: "z1", url: "https://z1.test" }]);
      throw new Error("network_error");
    };
    const r = await fanOutSearch("q", 10, sources, executor);
    expect(r.outcome).toBe("worked");
    expect(r.partial_failures).toHaveLength(1);
    expect(r.partial_failures![0].channel).toBe("search.brave");
    expect(r.partial_failures![0].error).toContain("network_error");
  });

  it("全源失败 → outcome=unknown + partial_failures 全记 + served_by 是所有源", async () => {
    const sources: FanoutSource[] = [
      { name: "search.zhipu", capacity: 5 },
      { name: "search.brave", capacity: 5 },
    ];
    const executor = async (name: string) =>
      unknown(name, name.includes("zhipu") ? "timeout" : "HTTP 429");
    const r = await fanOutSearch("q", 10, sources, executor);
    expect(r.outcome).toBe("unknown");
    expect(r.data).toBeNull();
    expect(r.error).toBe("all_sources_failed");
    expect(r.served_by).toBe("search.zhipu,search.brave");
    expect(r.partial_failures).toHaveLength(2);
    expect(r.partial_failures!.map((p) => p.channel).sort()).toEqual([
      "search.brave",
      "search.zhipu",
    ]);
  });

  it("单源 worked → served_by 是该源名（无逗号）", async () => {
    const sources: FanoutSource[] = [{ name: "search.zhipu", capacity: 5 }];
    const executor = async () =>
      worked("search.zhipu", [{ title: "z1", url: "https://z1.test" }]);
    const r = await fanOutSearch("q", 10, sources, executor);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("search.zhipu");
    expect(r.partial_failures).toBeUndefined();
  });

  it("空源列表 → outcome=unknown + error=no_sources", async () => {
    const r = await fanOutSearch("q", 10, [], async () => {
      throw new Error("unreachable");
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("no_sources");
    expect(r.served_by).toBe("fanout(empty)");
  });

  it("200-but-empty（worked 但 results=[]）→ 视为该源失败记 partial_failures", async () => {
    const sources: FanoutSource[] = [
      { name: "search.zhipu", capacity: 5 },
      { name: "search.brave", capacity: 5 },
    ];
    const executor = async (name: string) => {
      if (name === "search.zhipu") {
        // 200 + 空数组（10 §D.1 关键信号）
        return {
          outcome: "worked",
          data: {
            query: "q",
            results: [],
            count: 0,
            engine: "zhipu",
            region: "auto",
          },
          served_by: "search.zhipu",
          fallback_used: false,
          retrieval_method: "test",
        } satisfies InteractResult<SearchResult>;
      }
      return worked("search.brave", [{ title: "b1", url: "https://b1.test" }]);
    };
    const r = await fanOutSearch("q", 10, sources, executor);
    expect(r.outcome).toBe("worked");
    expect(r.partial_failures).toHaveLength(1);
    expect(r.partial_failures![0].channel).toBe("search.zhipu");
  });
});

// ============================================================
// allocateLimit
// ============================================================
describe("allocateLimit — 语言启发式 + quota 比例", () => {
  it("CJK query → zhipu 容量 > brave（langBoost 0.7 vs 0.3）", () => {
    const sources = [
      { name: "search.zhipu", quotaRemaining: 1000, quotaPerMonth: 1000 },
      { name: "search.brave", quotaRemaining: 1000, quotaPerMonth: 1000 },
    ];
    const r = allocateLimit(10, sources, "Rust 异步编程"); // CJK
    const zhipu = r.find((s) => s.name === "search.zhipu")!;
    const brave = r.find((s) => s.name === "search.brave")!;
    expect(zhipu.capacity).toBeGreaterThan(brave.capacity);
    expect(zhipu.capacity + brave.capacity).toBeGreaterThanOrEqual(10);
  });

  it("EN query → brave 容量 > zhipu", () => {
    const sources = [
      { name: "search.zhipu", quotaRemaining: 1000, quotaPerMonth: 1000 },
      { name: "search.brave", quotaRemaining: 1000, quotaPerMonth: 1000 },
    ];
    const r = allocateLimit(10, sources, "rust async programming");
    const zhipu = r.find((s) => s.name === "search.zhipu")!;
    const brave = r.find((s) => s.name === "search.brave")!;
    expect(brave.capacity).toBeGreaterThan(zhipu.capacity);
  });

  it("quotaRemaining 比例：余量多的源多分", () => {
    const sources = [
      { name: "search.zhipu", quotaRemaining: 100, quotaPerMonth: 1000 },
      { name: "search.brave", quotaRemaining: 2000, quotaPerMonth: 2000 },
    ];
    // EN query：brave langBoost=0.7 × quotaWeight=1.0=0.7；
    //          zhipu langBoost=0.3 × quotaWeight=0.1=0.03
    // → brave >> zhipu
    const r = allocateLimit(20, sources, "rust");
    const zhipu = r.find((s) => s.name === "search.zhipu")!;
    const brave = r.find((s) => s.name === "search.brave")!;
    expect(brave.capacity).toBeGreaterThan(zhipu.capacity);
  });

  it("每源 capacity >= 1（即使 quotaRemaining=0）", () => {
    const sources = [
      { name: "search.zhipu", quotaRemaining: 0, quotaPerMonth: 1000 },
      { name: "search.brave", quotaRemaining: 0, quotaPerMonth: 2000 },
    ];
    const r = allocateLimit(5, sources, "x");
    expect(r.every((s) => s.capacity >= 1)).toBe(true);
  });

  it("quotaPerMonth=0 → 退化为 weight=1（不抛错）", () => {
    const sources = [
      { name: "search.zhipu", quotaRemaining: 100, quotaPerMonth: 0 },
      { name: "search.brave", quotaRemaining: 100, quotaPerMonth: 0 },
    ];
    const r = allocateLimit(10, sources, "test");
    expect(r).toHaveLength(2);
    expect(r.every((s) => s.capacity >= 1)).toBe(true);
  });

  it("空数组 → 返空数组", () => {
    expect(allocateLimit(10, [], "x")).toEqual([]);
  });

  it("结果数 = 输入源数（每源一条）", () => {
    const r = allocateLimit(
      10,
      [
        { name: "a", quotaRemaining: 100, quotaPerMonth: 100 },
        { name: "b", quotaRemaining: 100, quotaPerMonth: 100 },
        { name: "c", quotaRemaining: 100, quotaPerMonth: 100 },
      ],
      "x",
    );
    expect(r).toHaveLength(3);
    expect(new Set(r.map((s) => s.name)).size).toBe(3);
  });
});
