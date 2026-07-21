/**
 * benchmark 集成测（parse2 §5.2 / §3.7）。
 *
 * 不触网：直接调 benchmark 内部导出的函数（runColdWarm / runConcurrent / summarize /
 * renderMarkdown / makeStubChannel / parseArgs）。
 *
 * 覆盖：
 *  - makeStubChannel 返回 worked + 模拟 latency
 *  - runColdWarm 产出 cold + warm 两组 samples（每 query × 每 provider × rounds）
 *  - runConcurrent 产出 concurrent 组 samples（batch size 控制）
 *  - summarize p50/p95 + success_rate 在合理范围
 *  - renderMarkdown 输出合法 markdown，**禁止 "最优" 字眼**
 *  - parseArgs：--queries / --report / --rounds / --concurrent / --real 解析
 *  - scripts/ab-queries.json：至少 5 中 + 5 英（验收 #1 硬指标）
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  runColdWarm,
  runConcurrent,
  summarize,
  renderMarkdown,
  makeStubChannel,
  parseArgs,
  type BenchReport,
} from "../../src/benchmark/run-ab-benchmark.js";

// ============================================================
// fixture
// ============================================================
const queries: Array<{ q: string; lang: "zh" | "en" }> = [
  { q: "Rust 教程", lang: "zh" },
  { q: "TypeScript 入门", lang: "zh" },
  { q: "rust async", lang: "en" },
  { q: "typescript generics", lang: "en" },
  { q: "vitest tutorial", lang: "en" },
];

// ============================================================
// cases
// ============================================================
describe("makeStubChannel", () => {
  it("返回 outcome=worked + 含 engine 字段", async () => {
    const exec = makeStubChannel("brave");
    const r = await exec("test");
    expect(r.outcome).toBe("worked");
    expect(r.data?.engine).toBe("brave");
    expect(r.data?.region).toBe("US");
    expect(r.served_by).toBe("search.brave");
  });

  it("zhipu stub region=cn", async () => {
    const r = await makeStubChannel("zhipu")("test");
    expect(r.data?.region).toBe("cn");
  });
});

describe("runColdWarm", () => {
  it("每 query × 每 provider × rounds 产出 2 * rounds * (cold + warm) samples", async () => {
    // 用同步 fast stub（不依赖 setTimeout，避免测试变慢）
    const fastZhipu = (q: string) =>
      Promise.resolve({
        outcome: "worked" as const,
        data: {
          query: q,
          results: [{ title: "z", url: "u", snippet: "" }],
          count: 1,
          engine: "zhipu",
          region: "cn",
        },
        served_by: "search.zhipu",
        fallback_used: false,
        retrieval_method: "stub",
      });
    const fastBrave = (q: string) =>
      Promise.resolve({
        outcome: "worked" as const,
        data: {
          query: q,
          results: [{ title: "z", url: "u", snippet: "" }],
          count: 1,
          engine: "brave",
          region: "US",
        },
        served_by: "search.brave",
        fallback_used: false,
        retrieval_method: "stub",
      });
    const providers = { zhipu: fastZhipu, brave: fastBrave };
    const rounds = 3;
    const samples = await runColdWarm(queries, providers, rounds);
    // 5 query × 2 provider × 2 mode (cold/warm) × 3 rounds = 60
    expect(samples).toHaveLength(5 * 2 * 2 * rounds);
    // mode 分布：cold == warm == 5*2*3 = 30
    const cold = samples.filter((s) => s.mode === "cold");
    const warm = samples.filter((s) => s.mode === "warm");
    expect(cold).toHaveLength(30);
    expect(warm).toHaveLength(30);
  }, 15_000);

  it("所有 sample outcome=worked（stub 永远成功）", async () => {
    const providers = {
      zhipu: makeStubChannel("zhipu"),
      brave: makeStubChannel("brave"),
    };
    const samples = await runColdWarm(queries.slice(0, 2), providers, 1);
    expect(samples.every((s) => s.outcome === "worked")).toBe(true);
  }, 15_000);
});

describe("runConcurrent", () => {
  it("batch size 控制 samples 数 = batch × provider × rounds", async () => {
    const providers = {
      zhipu: makeStubChannel("zhipu"),
      brave: makeStubChannel("brave"),
    };
    const batchSize = 3;
    const rounds = 2;
    const samples = await runConcurrent(queries, providers, rounds, batchSize);
    // 3 (batch) × 2 (provider) × 2 (rounds) = 12
    expect(samples).toHaveLength(batchSize * 2 * rounds);
    expect(samples.every((s) => s.mode === "concurrent")).toBe(true);
  });

  it("batch size > queries.length 时 clamp 到 queries.length", async () => {
    const providers = {
      zhipu: makeStubChannel("zhipu"),
      brave: makeStubChannel("brave"),
    };
    const samples = await runConcurrent(queries.slice(0, 2), providers, 1, 10);
    // 实际 batch = min(10, 2) = 2；2 × 2 provider × 1 round = 4
    expect(samples).toHaveLength(4);
  });
});

describe("summarize", () => {
  it("p50/p95 在合理范围 + success_rate ∈ [0, 1]", async () => {
    // 用同步 fast stub 避免 setTimeout 拖慢
    const fastZhipu = (q: string) =>
      Promise.resolve({
        outcome: "worked" as const,
        data: {
          query: q,
          results: [{ title: "z", url: "u", snippet: "" }],
          count: 1,
          engine: "zhipu",
          region: "cn",
        },
        served_by: "search.zhipu",
        fallback_used: false,
        retrieval_method: "stub",
      });
    const fastBrave = (q: string) =>
      Promise.resolve({
        outcome: "worked" as const,
        data: {
          query: q,
          results: [{ title: "z", url: "u", snippet: "" }],
          count: 1,
          engine: "brave",
          region: "US",
        },
        served_by: "search.brave",
        fallback_used: false,
        retrieval_method: "stub",
      });
    const providers = { zhipu: fastZhipu, brave: fastBrave };
    const samples = [
      ...(await runColdWarm(queries.slice(0, 3), providers, 1)),
      ...(await runConcurrent(queries.slice(0, 3), providers, 1, 2)),
    ];
    const summary = summarize(samples);
    expect(summary.length).toBeGreaterThan(0);
    for (const r of summary) {
      expect(r.p50_ms).toBeGreaterThanOrEqual(0);
      expect(r.p95_ms).toBeGreaterThanOrEqual(r.p50_ms);
      expect(r.success_rate).toBeGreaterThanOrEqual(0);
      expect(r.success_rate).toBeLessThanOrEqual(1);
    }
  }, 15_000);
});

describe("renderMarkdown", () => {
  it("输出含表头 + 数据行 + Brave 三项硬数据引用", () => {
    const report: BenchReport = {
      timestamp: "2026-07-21T00:00:00.000Z",
      lasso_version: "0.2.0-dev",
      real_channels: false,
      rounds: 1,
      queries: { zh: 2, en: 3 },
      samples: [],
      summary: [
        { provider: "zhipu", mode: "cold", p50_ms: 400, p95_ms: 600, success_rate: 1.0, samples: 5 },
        { provider: "brave", mode: "cold", p50_ms: 700, p95_ms: 900, success_rate: 0.95, samples: 5 },
      ],
      external_citations: {
        brave_aimultiple_p95_ms: 669,
        brave_aimultiple_agent_score: 14.89,
        brave_free_quota_per_month: 2000,
        note: "外部硬数据引用，非「最优」归因",
      },
    };
    const md = renderMarkdown(report);
    expect(md).toContain("# Lasso A/B Provider Matrix");
    expect(md).toContain("| provider | mode |");
    expect(md).toContain("669 ms");
    expect(md).toContain("14.89");
    expect(md).toContain("2000 query/月");
  });

  it("禁止「最优」/「全场最优」结论字眼（05 §0-3 否决）", () => {
    const report: BenchReport = {
      timestamp: "2026-07-21T00:00:00.000Z",
      lasso_version: "0.2.0-dev",
      real_channels: false,
      rounds: 1,
      queries: { zh: 1, en: 1 },
      samples: [],
      summary: [],
      external_citations: {
        brave_aimultiple_p95_ms: 669,
        brave_aimultiple_agent_score: 14.89,
        brave_free_quota_per_month: 2000,
        note: "",
      },
    };
    const md = renderMarkdown(report);
    // 必须显式否定「全场最优」结论（出现"否决"或"非「最优」"或"不引用"任一即可）
    expect(md).toMatch(/否决|非「最优」|不引用/);
  });
});

describe("parseArgs", () => {
  it("默认值：queriesPath=scripts/ab-queries.json, rounds=3, concurrentBatch=5, real=false", () => {
    const opts = parseArgs([]);
    expect(opts.queriesPath).toBe("scripts/ab-queries.json");
    expect(opts.rounds).toBe(3);
    expect(opts.concurrentBatch).toBe(5);
    expect(opts.real).toBe(false);
  });

  it("--queries / --report / --rounds / --concurrent / --real 解析", () => {
    const opts = parseArgs([
      "--queries", "x.json",
      "--report", "y.json",
      "--rounds", "5",
      "--concurrent", "10",
      "--real",
    ]);
    expect(opts.queriesPath).toBe("x.json");
    expect(opts.reportPath).toBe("y.json");
    expect(opts.rounds).toBe(5);
    expect(opts.concurrentBatch).toBe(10);
    expect(opts.real).toBe(true);
  });

  it("未传 --report → 默认 reports/ab-<date>.json（含今天日期）", () => {
    const opts = parseArgs([]);
    const today = new Date().toISOString().slice(0, 10);
    expect(opts.reportPath).toContain(today);
    expect(opts.reportPath.startsWith("reports/")).toBe(true);
  });
});

describe("scripts/ab-queries.json — 验收 #1 硬指标", () => {
  it("至少 5 中 + 5 英（v0.2 验收硬指标）", async () => {
    const p = path.resolve("scripts/ab-queries.json");
    const raw = JSON.parse(await fs.readFile(p, "utf8"));
    expect(Array.isArray(raw.zh)).toBe(true);
    expect(Array.isArray(raw.en)).toBe(true);
    expect(raw.zh.length).toBeGreaterThanOrEqual(5);
    expect(raw.en.length).toBeGreaterThanOrEqual(5);
  });
});
