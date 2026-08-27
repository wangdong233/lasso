/**
 * resource-meter.spec.ts（v1.9 parse17 资源测算基建配套单测）
 *
 * 守护 test/helpers/resource-meter.ts：
 *  1. released()：after 进程数与 RSS 回到 before 基线 → true；进程数增加 → false；
 *     RSS 超容差 → false；容差内 → true
 *  2. before()/peak()/after() 三采样生命周期：peak 捕捉轮询期间最大值；after 停止轮询
 *  3. parseCpuTime：MM:SS / HH:MM:SS / DD-HH:MM:SS 解析
 *  4. sampleLassoTree 真实路径：ps 可用 → 结构健全（count/rss/cpu 字段自洽）
 *  5. 特征匹配 + ppid 后代归属：根匹配三特征、Chromium helper 经 ppid 闭包入树
 *
 * 测试策略：核心逻辑用注入 sampleFn mock（确定性）；真实 ps 路径只验「结构自洽」
 * 不验具体数值（本机共存 CC 会话进程会干扰绝对值——released 用差值判定不受影响）。
 */
import { describe, it, expect, vi } from "vitest";
import {
  ResourceMeter,
  parseCpuTime,
  type ResourceSample,
} from "../helpers/resource-meter.js";
import { readFileSync } from "node:fs";

function makeSample(overrides: Partial<ResourceSample> = {}): ResourceSample {
  return {
    at: Date.now(),
    count: 2,
    rssKb: 100_000,
    cpuSeconds: 1.5,
    procs: [],
    ...overrides,
  };
}

describe("resource-meter —— released() 判定（doc/testing/01 §0.2 第 6 条纪律口径）", () => {
  it("after 进程数 ≤ before 且 RSS 回基线 → true", () => {
    const meter = new ResourceMeter({ sampleFn: () => makeSample() });
    const before = makeSample({ count: 3, rssKb: 200_000 });
    const after = makeSample({ count: 3, rssKb: 200_000 });
    expect(meter.released(before, after)).toBe(true);
    // 进程数下降（释放了）也算回到基线
    expect(meter.released(before, makeSample({ count: 0, rssKb: 0 }))).toBe(true);
  });

  it("after 进程数增加 → false（残留进程）", () => {
    const meter = new ResourceMeter({ sampleFn: () => makeSample() });
    const before = makeSample({ count: 2, rssKb: 100_000 });
    const after = makeSample({ count: 5, rssKb: 400_000 });
    expect(meter.released(before, after)).toBe(false);
  });

  it("RSS 超容差 → false；容差内（默认 10% + 50MB slack）→ true", () => {
    const meter = new ResourceMeter({ sampleFn: () => makeSample() });
    const before = makeSample({ count: 2, rssKb: 100_000 }); // 100MB
    // 超 10%+50MB：100MB → 165MB+ = 超
    expect(
      meter.released(before, makeSample({ count: 2, rssKb: 170_000 })),
    ).toBe(false);
    // 容差内：100MB + 10% + 50MB = 160MB 上界
    expect(
      meter.released(before, makeSample({ count: 2, rssKb: 150_000 })),
    ).toBe(true);
    // 自定义容差
    expect(
      meter.released(before, makeSample({ count: 2, rssKb: 101_000 }), {
        tolerancePct: 0,
        slackKb: 0,
      }),
    ).toBe(false);
  });
});

describe("resource-meter —— before/peak/after 三采样生命周期", () => {
  it("peak 捕捉轮询期间最大 RSS 样本；after 停止轮询（后续样本不再进 peak）", async () => {
    vi.useFakeTimers();
    try {
      let current = makeSample({ count: 2, rssKb: 100_000 });
      const meter = new ResourceMeter({
        sampleFn: () => current,
        pollMs: 100,
      });
      const before = meter.before();
      expect(before.rssKb).toBe(100_000);

      // 期间资源上涨（被测用例 spawn 浏览器树）
      current = makeSample({ count: 8, rssKb: 800_000 });
      await vi.advanceTimersByTimeAsync(150);
      expect(meter.peak().rssKb).toBe(800_000);

      // 回落
      current = makeSample({ count: 2, rssKb: 102_000 });
      const after = meter.after();
      expect(after.rssKb).toBe(102_000);
      expect(meter.released(before, after)).toBe(true);

      // after 后轮询已停：再涨也不进 peak
      current = makeSample({ count: 9, rssKb: 900_000 });
      await vi.advanceTimersByTimeAsync(300);
      expect(meter.peak().rssKb).toBe(800_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("未 before() 直接 peak() → 立即采一次（不崩）", () => {
    const meter = new ResourceMeter({
      sampleFn: () => makeSample({ count: 1, rssKb: 42_000 }),
    });
    expect(meter.peak().rssKb).toBe(42_000);
  });
});

describe("resource-meter —— parseCpuTime（ps time 列格式）", () => {
  it("MM:SS / HH:MM:SS / DD-HH:MM:SS / 坏值", () => {
    expect(parseCpuTime("1:30.50")).toBeCloseTo(90.5, 5);
    expect(parseCpuTime("01:02:03")).toBeCloseTo(3723, 5);
    expect(parseCpuTime("2-01:00:00")).toBeCloseTo(176_400, 5); // 2 天 + 1h = 49h
    expect(parseCpuTime("garbage")).toBe(0);
  });
});

describe("resource-meter —— 真实 ps 采样路径（结构自洽）", () => {
  it("sampleLassoTree：ps 可用 → 字段自洽（count===procs.length；rss/cpu 为 procs 求和）", async () => {
    const { sampleLassoTree } = await import("../helpers/resource-meter.js");
    const s = sampleLassoTree();
    expect(s.count).toBe(s.procs.length);
    expect(s.rssKb).toBe(s.procs.reduce((n, p) => n + p.rssKb, 0));
    expect(s.cpuSeconds).toBeGreaterThanOrEqual(0);
    expect(s.at).toBeGreaterThan(0);
    // 本机 vitest worker 自身 cmdline 不含特征 → 不应把自己算进树（除非链上命中）
    for (const p of s.procs) {
      expect(p.matchedBy).toBeTruthy();
    }
  });
});

describe("resource-meter —— 特征匹配 + ppid 后代归属（源码级断言）", () => {
  it("三条 pgrep 等价特征 + ppid 闭包 + released 差值口径都在实现内", () => {
    const src = readFileSync(
      new URL("../helpers/resource-meter.ts", import.meta.url),
      "utf8",
    );
    // 三特征（与 doc/testing/01 §0.2 第 6 条 / 任务口径逐字对应）
    expect(src).toContain("--user-data-dir=");
    expect(src).toContain("chrome-devtools-mcp");
    expect(src).toContain("--disable-blink-features");
    expect(src).toContain("dist/index.js");
    // ppid 后代归属（Chromium helper 不重复 user-data-dir，必须靠树归属）
    expect(src).toMatch(/ppid/);
    expect(src).toMatch(/descendant-of/);
    // 三采样 + released API 面
    expect(src).toMatch(/before\(\)/);
    expect(src).toMatch(/peak\(\)/);
    expect(src).toMatch(/after\(\)/);
    expect(src).toMatch(/released\(/);
  });
});
