/**
 * RpmLimiter v0.3 单测（parse3 §5.1 + §3.6）
 *
 * 覆盖：
 *  - 默认 defaultMax=Infinity → allow 永远 true（v0.2 兼容）
 *  - 滑动窗过期清理：60s 后旧 record 不计入
 *  - allow=false 不计数（不调 record 就不占窗口配额）
 *  - record 后才计数（成功调用占配额）
 *  - 不同 provider 独立窗口
 *  - allow + record 配合：达到 max 即 allow=false
 *  - currentUsage 反映已清理窗口
 *  - cap=0 → 禁用（allow=false）
 *  - 默认 windowMs=60_000
 *  - reset 清空所有 provider
 *  - 时间戳源 now() 可注入（确定性测试）
 */
import { describe, it, expect } from "vitest";
import {
  RpmLimiter,
  DEFAULT_RPM_WINDOW_MS,
} from "../../src/util/rpm-limiter.js";

// ============================================================
// Mock 时钟
// ============================================================
/**
 * 用可控时钟替代 Date.now()。
 *  - t.value 即当前时间戳（ms）
 *  - advance(ms) 推进时间
 */
function makeClock(start = 1_000_000): {
  t: { value: number };
  now: () => number;
  advance: (ms: number) => void;
} {
  const t = { value: start };
  return {
    t,
    now: () => t.value,
    advance: (ms) => {
      t.value += ms;
    },
  };
}

// ============================================================
// 默认值 / 构造
// ============================================================
describe("RpmLimiter — 默认值 + 构造", () => {
  it("DEFAULT_RPM_WINDOW_MS = 60_000", () => {
    expect(DEFAULT_RPM_WINDOW_MS).toBe(60_000);
  });

  it("默认构造：defaultMax=Infinity → 不传 max 时 allow 永远 true（v0.2 行为）", () => {
    const l = new RpmLimiter();
    // record 1000 次仍 allow（未显式传 max → 走 defaultMax=Infinity）
    for (let i = 0; i < 1000; i++) l.record("p");
    expect(l.allow("p")).toBe(true);
    // 但显式传 max=5 时按 5 算（max 参数优先于 defaultMax）
    expect(l.allow("p", 5)).toBe(false);
  });

  it("默认 max 不传 → 走 defaultMax=Infinity（allow=true）", () => {
    const l = new RpmLimiter();
    expect(l.allow("p")).toBe(true);
  });
});

// ============================================================
// allow + record：基本节流
// ============================================================
describe("RpmLimiter — allow + record 节流", () => {
  it("max=3 + record 3 次 → 第 4 次 allow=false", () => {
    const { t, now } = makeClock();
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    expect(l.allow("p", 3)).toBe(true);
    l.record("p");
    expect(l.allow("p", 3)).toBe(true);
    l.record("p");
    expect(l.allow("p", 3)).toBe(true);
    l.record("p");
    // 窗口内已有 3 条 → 第 4 次 allow=false
    expect(l.allow("p", 3)).toBe(false);
    expect(t.value).toBe(1_000_000); // 时钟未推进（无 sleep）
  });

  it("allow=false 时不计数（不调 record）", () => {
    const { now } = makeClock();
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    l.record("p");
    l.record("p");
    expect(l.currentUsage("p")).toBe(2);
    // 多次 allow（被拒）不增 usage
    expect(l.allow("p", 2)).toBe(false);
    expect(l.allow("p", 2)).toBe(false);
    expect(l.currentUsage("p")).toBe(2);
  });

  it("allow=true 但不 record → 不占配额（调用方负责记账）", () => {
    const { now } = makeClock();
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    expect(l.allow("p", 2)).toBe(true);
    expect(l.allow("p", 2)).toBe(true); // 未 record，仍 allow
    expect(l.allow("p", 2)).toBe(true);
    expect(l.currentUsage("p")).toBe(0);
  });

  it("cap=0 → 禁用（allow 永远 false）", () => {
    const { now } = makeClock();
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    expect(l.allow("p", 0)).toBe(false);
  });

  it("cap=1 + record 1 → 第 2 次 allow=false", () => {
    const { now } = makeClock();
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    expect(l.allow("p", 1)).toBe(true);
    l.record("p");
    expect(l.allow("p", 1)).toBe(false);
  });
});

// ============================================================
// 滑动窗：过期清理
// ============================================================
describe("RpmLimiter — 滑动窗过期清理", () => {
  it("60s 后旧 record 不计入（窗口滑动）", () => {
    const { now, advance } = makeClock(0);
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    // t=0：record 3 次
    l.record("p");
    l.record("p");
    l.record("p");
    expect(l.currentUsage("p")).toBe(3);
    expect(l.allow("p", 3)).toBe(false);

    // 推进 60s + 1ms（边界：60s 后的算过期）
    advance(60_001);
    expect(l.currentUsage("p")).toBe(0);
    expect(l.allow("p", 3)).toBe(true);
  });

  it("59s 内仍计入（边界：59s 不算过期）", () => {
    const { now, advance } = makeClock(0);
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    l.record("p");
    l.record("p");
    advance(59_999);
    expect(l.currentUsage("p")).toBe(2);
    expect(l.allow("p", 2)).toBe(false);
  });

  it("部分过期：窗口内混合新旧的 record", () => {
    const { now, advance } = makeClock(0);
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    l.record("p"); // t=0
    advance(40_000);
    l.record("p"); // t=40s
    advance(40_000); // 总 t=80s
    // 第 1 条（t=0）已过期；第 2 条（t=40s）仍在 80s 窗口内（80-40=40 < 60）
    expect(l.currentUsage("p")).toBe(1);
  });

  it("自定义 windowMs=10s", () => {
    const { now, advance } = makeClock(0);
    const l = new RpmLimiter(10_000, Number.POSITIVE_INFINITY, now);
    l.record("p");
    advance(9_999);
    expect(l.currentUsage("p")).toBe(1);
    advance(2); // 共 10s + 1ms
    expect(l.currentUsage("p")).toBe(0);
  });
});

// ============================================================
// 多 provider 隔离
// ============================================================
describe("RpmLimiter — 多 provider 隔离", () => {
  it("不同 provider 独立窗口（互不影响）", () => {
    const { now } = makeClock();
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    // brave 用满
    l.record("search.brave");
    l.record("search.brave");
    expect(l.allow("search.brave", 2)).toBe(false);
    // zhipu 不受影响
    expect(l.allow("search.zhipu", 2)).toBe(true);
    l.record("search.zhipu");
    expect(l.currentUsage("search.zhipu")).toBe(1);
    expect(l.currentUsage("search.brave")).toBe(2);
  });

  it("3 个 provider 同时记账 → 各自独立", () => {
    const { now } = makeClock();
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    for (const p of ["a", "b", "c"]) {
      l.record(p);
      l.record(p);
    }
    expect(l.currentUsage("a")).toBe(2);
    expect(l.currentUsage("b")).toBe(2);
    expect(l.currentUsage("c")).toBe(2);
  });
});

// ============================================================
// currentUsage + reset
// ============================================================
describe("RpmLimiter — currentUsage + reset", () => {
  it("currentUsage 反映已清理窗口", () => {
    const { now, advance } = makeClock(0);
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    l.record("p");
    l.record("p");
    expect(l.currentUsage("p")).toBe(2);
    advance(61_000);
    expect(l.currentUsage("p")).toBe(0);
  });

  it("reset 清空所有 provider", () => {
    const { now } = makeClock();
    const l = new RpmLimiter(60_000, Number.POSITIVE_INFINITY, now);
    l.record("a");
    l.record("b");
    l.reset();
    expect(l.currentUsage("a")).toBe(0);
    expect(l.currentUsage("b")).toBe(0);
  });

  it("未记账的 provider currentUsage=0（不抛错）", () => {
    const l = new RpmLimiter();
    expect(l.currentUsage("unknown")).toBe(0);
  });
});

// ============================================================
// defaultMax 显式设为有限值
// ============================================================
describe("RpmLimiter — defaultMax 有限值", () => {
  it("defaultMax=5 + 未显式传 max → 按 5 算", () => {
    const { now } = makeClock();
    const l = new RpmLimiter(60_000, 5, now);
    for (let i = 0; i < 5; i++) l.record("p");
    expect(l.allow("p")).toBe(false);
  });

  it("defaultMax=5 + 显式传 max=10 → 按 10 算（max 参数优先）", () => {
    const { now } = makeClock();
    const l = new RpmLimiter(60_000, 5, now);
    for (let i = 0; i < 5; i++) l.record("p");
    // defaultMax 已满，但显式 max=10 放过
    expect(l.allow("p", 10)).toBe(true);
  });
});
