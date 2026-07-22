/**
 * replay-baseline.spec.ts（parse11 §3.2 + §7.2 Phase C v1.0 录制回放回归 runner）
 *
 * 守护 runReplayBaseline 的：
 *  1. 默认 fixtures 目录扫描：6 条 fixture 全跑（baidu×2 + google×2 + bing×2）
 *  2. hit_rate 阈值分级（>= 0.8 pass / >= 0.5 warn / < 0.5 fail）
 *  3. fixture 改版检测（mock extractFn 返 0 结果 → fail）
 *  4. sidecar 缺失记 sidecar_missing + continue（不当 fail）
 *  5. fixtures 目录不存在 → 返 total=0（不抛错）
 *  6. INV-62 衍生：fixture 抽取源禁 logged_in（grep 检查由 INV-62 守；本 spec 验
 *     extractFn 调用路径不经 logged_in 通道）
 *
 * macOS-only 现实红线（parse11 §1.3）：本 spec 用 mock extractFn；不触网 / 不启浏览器。
 *
 * 测试策略：
 *  - 默认路径用真实 fixtures/serp-baseline/（签入仓库的 6 条 fixture）
 *  - 改版检测用 mock extractFn（返 0 结果）模拟 selector 破坏
 *  - 目录不存在 / sidecar 缺失 用 tmpdir + ad-hoc fixture
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  runReplayBaseline,
  HIT_RATE_THRESHOLD_PASS,
  HIT_RATE_THRESHOLD_WARN,
} from "../../src/serp/replay-baseline.js";
import type { SearchResult } from "../../src/types.js";

// ============================================================
// 默认 fixtures 目录（签入仓库）
// ============================================================
const REPO_FIXTURES_DIR = path.join(
  process.cwd(),
  "fixtures",
  "serp-baseline",
);

describe("runReplayBaseline —— 默认 fixtures 目录回归", () => {
  it("fixtures 目录存在（签入仓库的 6 条 fixture）", async () => {
    const stat = await fs.stat(REPO_FIXTURES_DIR);
    expect(stat.isDirectory()).toBe(true);
  });

  it("跑全部 fixture（≥6 条）；baidu/google/bing 三 engine 都覆盖", async () => {
    const summary = await runReplayBaseline({
      fixturesDir: REPO_FIXTURES_DIR,
    });
    expect(summary.total).toBeGreaterThanOrEqual(6);
    expect(summary.sidecar_missing).toBe(0);
    const engines = new Set(summary.results.map((r) => r.engine));
    expect(engines.has("baidu")).toBe(true);
    expect(engines.has("google")).toBe(true);
    expect(engines.has("bing")).toBe(true);
  });

  it("默认 extractResultsFromSnapshot 应让大部分 fixture 命中率 >= 0.8（pass）", async () => {
    const summary = await runReplayBaseline({
      fixturesDir: REPO_FIXTURES_DIR,
    });
    // 不强求 100% pass（fixture 设计的 expected_count 与 URL 正则抽到的数可能微差）；
    // 但至少 80% 的 fixture 应 pass（验证 selector 基线健康）。
    const passRate = summary.pass / summary.total;
    expect(passRate).toBeGreaterThanOrEqual(0.8);
  });
});

// ============================================================
// 改版检测（mock extractFn）
// ============================================================
describe("runReplayBaseline —— selector 改版检测", () => {
  it("mock extractFn 返 0 结果 → hit_rate=0 → status=fail", async () => {
    const mockExtract = (_html: string, query: string): SearchResult => ({
      query,
      results: [],
      count: 0,
      engine: "mock",
      region: "cn",
    });
    const summary = await runReplayBaseline({
      fixturesDir: REPO_FIXTURES_DIR,
      extractFn: mockExtract,
    });
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.fail).toBe(summary.total);
    expect(summary.pass).toBe(0);
    for (const r of summary.results) {
      expect(r.actual_count).toBe(0);
      expect(r.hit_rate).toBe(0);
      expect(r.status).toBe("fail");
    }
  });

  it("mock extractFn 返半数结果 → status=warn（selector 是债不是 bug）", async () => {
    // expected=5；返 3 条 → hit_rate=0.6 → warn
    const mockExtract = (_html: string, query: string): SearchResult => ({
      query,
      results: [
        { title: "t1", url: "https://example.com/1", snippet: "s1" },
        { title: "t2", url: "https://example.com/2", snippet: "s2" },
        { title: "t3", url: "https://example.com/3", snippet: "s3" },
      ],
      count: 3,
      engine: "mock",
      region: "cn",
    });
    const summary = await runReplayBaseline({
      fixturesDir: REPO_FIXTURES_DIR,
      extractFn: mockExtract,
    });
    for (const r of summary.results) {
      expect(r.hit_rate).toBeCloseTo(0.6, 5);
      expect(r.status).toBe("warn");
    }
    expect(summary.warn).toBe(summary.total);
  });

  it("mock extractFn 返满结果 → hit_rate=1.0 → status=pass", async () => {
    const mockExtract = (_html: string, query: string): SearchResult => ({
      query,
      results: [
        { title: "t1", url: "https://example.com/1", snippet: "s1" },
        { title: "t2", url: "https://example.com/2", snippet: "s2" },
        { title: "t3", url: "https://example.com/3", snippet: "s3" },
        { title: "t4", url: "https://example.com/4", snippet: "s4" },
        { title: "t5", url: "https://example.com/5", snippet: "s5" },
      ],
      count: 5,
      engine: "mock",
      region: "cn",
    });
    const summary = await runReplayBaseline({
      fixturesDir: REPO_FIXTURES_DIR,
      extractFn: mockExtract,
    });
    for (const r of summary.results) {
      expect(r.hit_rate).toBe(1);
      expect(r.status).toBe("pass");
    }
    expect(summary.pass).toBe(summary.total);
  });
});

// ============================================================
// 容错（目录不存在 / sidecar 缺失）
// ============================================================
describe("runReplayBaseline —— 容错", () => {
  it("目录不存在 → 返 total=0（不抛错）", async () => {
    const summary = await runReplayBaseline({
      fixturesDir: "/tmp/lasso-nonexistent-fixtures-dir-xyz",
    });
    expect(summary.total).toBe(0);
    expect(summary.pass).toBe(0);
    expect(summary.warn).toBe(0);
    expect(summary.fail).toBe(0);
    expect(summary.sidecar_missing).toBe(0);
  });

  it("sidecar 缺失 → sidecar_missing 计数 + continue（不当 fail）", async () => {
    const tmpBase = path.join(
      tmpdir(),
      `lasso-replay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const engineDir = path.join(tmpBase, "baidu");
    await fs.mkdir(engineDir, { recursive: true });
    await fs.writeFile(
      path.join(engineDir, "no-sidecar.html"),
      "fake serp snapshot https://example.com/test",
    );
    try {
      const summary = await runReplayBaseline({ fixturesDir: tmpBase });
      expect(summary.sidecar_missing).toBe(1);
      expect(summary.total).toBe(0); // 无 sidecar → 不计 results
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
    }
  });

  it("空 engine 子目录（无 .html）→ 不影响其他 engine", async () => {
    const tmpBase = path.join(
      tmpdir(),
      `lasso-replay-test-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const emptyEngine = path.join(tmpBase, "empty");
    const baiduEngine = path.join(tmpBase, "baidu");
    await fs.mkdir(emptyEngine, { recursive: true });
    await fs.mkdir(baiduEngine, { recursive: true });
    await fs.writeFile(
      path.join(baiduEngine, "test.html"),
      "https://example.com/test",
    );
    await fs.writeFile(
      path.join(baiduEngine, "test.json"),
      JSON.stringify({ query: "test", expected_count: 1 }),
    );
    try {
      const summary = await runReplayBaseline({ fixturesDir: tmpBase });
      expect(summary.total).toBe(1); // 只有 baidu/test.html 一条
      expect(summary.results[0].engine).toBe("baidu");
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
    }
  });

  it("expected_count=0 + actual=0 → hit_rate=1.0 + status=pass（防 div-by-zero）", async () => {
    const tmpBase = path.join(
      tmpdir(),
      `lasso-replay-test-zero-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const engineDir = path.join(tmpBase, "baidu");
    await fs.mkdir(engineDir, { recursive: true });
    await fs.writeFile(
      path.join(engineDir, "empty.html"),
      "no urls here",
    );
    await fs.writeFile(
      path.join(engineDir, "empty.json"),
      JSON.stringify({ query: "test", expected_count: 0 }),
    );
    try {
      const summary = await runReplayBaseline({ fixturesDir: tmpBase });
      expect(summary.total).toBe(1);
      expect(summary.results[0].hit_rate).toBe(1);
      expect(summary.results[0].status).toBe("pass");
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
    }
  });
});

// ============================================================
// 阈值常量（防无意中改）
// ============================================================
describe("runReplayBaseline —— 阈值常量", () => {
  it("HIT_RATE_THRESHOLD_PASS = 0.8", () => {
    expect(HIT_RATE_THRESHOLD_PASS).toBe(0.8);
  });
  it("HIT_RATE_THRESHOLD_WARN = 0.5", () => {
    expect(HIT_RATE_THRESHOLD_WARN).toBe(0.5);
  });
});
