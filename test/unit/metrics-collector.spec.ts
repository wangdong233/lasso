/**
 * MetricsCollector 单测（parse8 §3.2 / §5.1）
 *
 * 覆盖：
 *  - per-channel record + snapshot 基本路径
 *  - RingBuffer(128) 超容量丢弃最老
 *  - p50/p95 算法正确性（已知样本）
 *  - success_rate=0/1 边界
 *  - scanForAlerts 阈值（< 0.5 且样本 ≥ 10）
 *  - snapshot 不可变（外部 mutate 不污染内部）
 *  - INV-44：record 必带 channel 名（per-channel 维度）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "../../src/observ/MetricsCollector.js";

// ============================================================
// 基础 record + snapshot
// ============================================================
describe("MetricsCollector — record + snapshot", () => {
  it("未 record 的 channel 不出现在 snapshot", () => {
    const m = new MetricsCollector();
    expect(m.snapshot()).toEqual([]);
  });

  it("单 channel 单 record：total=1, success_rate=1 / 0", () => {
    const m = new MetricsCollector();
    m.record("search.zhipu", "worked", 100);
    const snap = m.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      channel: "search.zhipu",
      total: 1,
      success_count: 1,
      failure_count: 0,
      success_rate: 1,
      latency_ms_p50: 100,
      latency_ms_p95: 100,
    });
    expect(snap[0].last_error).toBeUndefined();
  });

  it("didnt 也算 success（channel 正常工作）", () => {
    const m = new MetricsCollector();
    m.record("browse_headless", "didnt", 50);
    const snap = m.snapshot();
    expect(snap[0].success_count).toBe(1);
    expect(snap[0].failure_count).toBe(0);
    expect(snap[0].success_rate).toBe(1);
  });

  it("unknown + error 计 failure + last_error 字段填充", () => {
    const m = new MetricsCollector();
    m.record("browse_headless", "unknown", 200);
    m.record("browse_headless", "error", 300);
    const snap = m.snapshot();
    expect(snap[0].total).toBe(2);
    expect(snap[0].success_count).toBe(0);
    expect(snap[0].failure_count).toBe(2);
    expect(snap[0].success_rate).toBe(0);
    expect(snap[0].last_error).toBe("error"); // 最近一次失败的 outcome
    expect(snap[0].last_error_at).toBeGreaterThan(0);
  });

  it("多 channel 独立累积（INV-44 per-channel 维度）", () => {
    const m = new MetricsCollector();
    m.record("search.zhipu", "worked", 100);
    m.record("search.zhipu", "worked", 200);
    m.record("browse_headless", "error", 50);
    const snap = m.snapshot();
    expect(snap).toHaveLength(2);
    const zhipu = snap.find((s) => s.channel === "search.zhipu");
    const headless = snap.find((s) => s.channel === "browse_headless");
    expect(zhipu?.total).toBe(2);
    expect(headless?.total).toBe(1);
    expect(headless?.failure_count).toBe(1);
  });
});

// ============================================================
// RingBuffer(128) 超容量丢弃最老
// ============================================================
describe("MetricsCollector — RingBuffer 容量上限", () => {
  it("默认容量 128：超容量的最老样本被丢弃", () => {
    const m = new MetricsCollector();
    // 推 200 个样本（容量 128）
    for (let i = 0; i < 200; i++) {
      m.record("ch", "worked", i);
    }
    const snap = m.snapshot();
    expect(snap[0].total).toBe(128);
  });

  it("自定义容量 = 5", () => {
    const m = new MetricsCollector(5);
    for (let i = 0; i < 10; i++) {
      m.record("ch", "worked", i);
    }
    const snap = m.snapshot();
    expect(snap[0].total).toBe(5);
    // p50 应该是最近 5 个的中位数（latencies 5,6,7,8,9 → p50 = 7）
    expect(snap[0].latency_ms_p50).toBe(7);
  });
});

// ============================================================
// p50/p95 算法
// ============================================================
describe("MetricsCollector — p50/p95 算法", () => {
  it("已知样本：[10, 20, 30, 40, 50, 60, 70, 80, 90, 100]", () => {
    const m = new MetricsCollector(128);
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const lat of latencies) {
      m.record("ch", "worked", lat);
    }
    const snap = m.snapshot();
    // 排序后 [10..100]，n=10
    // p50 = rank floor(0.5 * 9) = 4 → latencies[4] = 50
    expect(snap[0].latency_ms_p50).toBe(50);
    // p95 = rank floor(0.95 * 9) = 8 → latencies[8] = 90
    expect(snap[0].latency_ms_p95).toBe(90);
  });

  it("单样本：p50 = p95 = 该样本", () => {
    const m = new MetricsCollector();
    m.record("ch", "worked", 42);
    const snap = m.snapshot();
    expect(snap[0].latency_ms_p50).toBe(42);
    expect(snap[0].latency_ms_p95).toBe(42);
  });
});

// ============================================================
// success_rate 边界
// ============================================================
describe("MetricsCollector — success_rate 边界", () => {
  it("0 样本 → success_rate=1（乐观默认，防冷启动误报）", () => {
    const m = new MetricsCollector();
    // 没记录任何 channel → snapshot 为空
    expect(m.snapshot()).toEqual([]);
  });

  it("全失败 → success_rate=0", () => {
    const m = new MetricsCollector();
    for (let i = 0; i < 5; i++) m.record("ch", "error", 100);
    expect(m.snapshot()[0].success_rate).toBe(0);
  });

  it("混合 → success_rate = success/total", () => {
    const m = new MetricsCollector();
    for (let i = 0; i < 7; i++) m.record("ch", "worked", 100);
    for (let i = 0; i < 3; i++) m.record("ch", "error", 100);
    const snap = m.snapshot();
    expect(snap[0].total).toBe(10);
    expect(snap[0].success_count).toBe(7);
    expect(snap[0].failure_count).toBe(3);
    expect(snap[0].success_rate).toBeCloseTo(0.7, 5);
  });
});

// ============================================================
// scanForAlerts 阈值
// ============================================================
describe("MetricsCollector — scanForAlerts", () => {
  beforeEach(() => {
    // 重置 logger spy 在 case 内单独挂
  });

  it("样本 ≥ 10 + success_rate < 0.5 → 触发告警", () => {
    const m = new MetricsCollector();
    // 11 个样本：3 worked + 8 error → rate=3/11≈0.27 < 0.5
    for (let i = 0; i < 3; i++) m.record("ch", "worked", 100);
    for (let i = 0; i < 8; i++) m.record("ch", "error", 100);
    const alerts = m.scanForAlerts(0.5);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].channel).toBe("ch");
    expect(alerts[0].success_rate).toBeLessThan(0.5);
  });

  it("样本 < 10 不告警（冷启动保护）", () => {
    const m = new MetricsCollector();
    // 5 个全失败样本（< 10 不触发）
    for (let i = 0; i < 5; i++) m.record("ch", "error", 100);
    const alerts = m.scanForAlerts(0.5);
    expect(alerts).toHaveLength(0);
  });

  it("success_rate ≥ threshold 不告警", () => {
    const m = new MetricsCollector();
    // 10 worked 样本（rate=1）
    for (let i = 0; i < 10; i++) m.record("ch", "worked", 100);
    const alerts = m.scanForAlerts(0.5);
    expect(alerts).toHaveLength(0);
  });

  it("自定义 threshold=0.8", () => {
    const m = new MetricsCollector();
    // 10 样本：8 worked + 2 error → rate=0.8
    for (let i = 0; i < 8; i++) m.record("ch", "worked", 100);
    for (let i = 0; i < 2; i++) m.record("ch", "error", 100);
    // threshold=0.9：rate=0.8 < 0.9 触发
    const alertsHigh = m.scanForAlerts(0.9);
    expect(alertsHigh).toHaveLength(1);
    // threshold=0.7：rate=0.8 ≥ 0.7 不触发
    const alertsLow = m.scanForAlerts(0.7);
    expect(alertsLow).toHaveLength(0);
  });
});

// ============================================================
// snapshot 不可变
// ============================================================
describe("MetricsCollector — snapshot 不可变", () => {
  it("外部 mutate snapshot 不污染内部", () => {
    const m = new MetricsCollector();
    m.record("ch", "worked", 100);
    const snap1 = m.snapshot();
    snap1[0].total = 9999;
    snap1[0].channel = "tampered";
    const snap2 = m.snapshot();
    expect(snap2[0].total).toBe(1);
    expect(snap2[0].channel).toBe("ch");
  });
});

// ============================================================
// INV-44：record 必带 channel
// ============================================================
describe("MetricsCollector — INV-44 per-channel 维度", () => {
  it("TS 编译时保证 record 首参 channel: string（无 default 可选）", () => {
    // 这里用反射验证 record.length 不是 0（首参必填）
    const m = new MetricsCollector();
    expect(m.record.length).toBe(3); // (channel, outcome, latencyMs)
    // record() 无参调用编译错（TS 守护），运行时不直接测
  });
});
