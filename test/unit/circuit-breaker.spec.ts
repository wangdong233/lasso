/**
 * CircuitBreaker 单测（parse1 §5.1）
 *
 * 覆盖状态机所有迁移：
 *  closed   --3 fails-->     open
 *  open     --resetMs-->     half-open
 *  half-open --success-->    closed
 *  half-open --failure-->    open
 *  open 期间 allow()=false
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";

describe("CircuitBreaker — closed 态", () => {
  it("初始状态 closed + allow=true", () => {
    const b = new CircuitBreaker();
    expect(b.state).toBe("closed");
    expect(b.allow()).toBe(true);
  });

  it("单次失败不打开（threshold=3）", () => {
    const b = new CircuitBreaker(3, 60_000);
    b.recordFailure();
    expect(b.state).toBe("closed");
    expect(b.failureCountReadOnly).toBe(1);
    b.recordFailure();
    expect(b.state).toBe("closed");
    expect(b.failureCountReadOnly).toBe(2);
    expect(b.allow()).toBe(true);
  });

  it("第 3 次失败 → open", () => {
    const b = new CircuitBreaker(3, 60_000);
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.failureCountReadOnly).toBe(3);
  });

  it("success 清零失败计数（closed 态）", () => {
    const b = new CircuitBreaker();
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    expect(b.failureCountReadOnly).toBe(0);
    expect(b.state).toBe("closed");
  });
});

describe("CircuitBreaker — open 态", () => {
  it("open 时 allow=false", () => {
    const b = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.allow()).toBe(false);
  });

  it("未过 resetMs 仍 open", () => {
    const b = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) b.recordFailure();
    b._forceElapsedForTests(30_000); // 30s < 60s
    expect(b.allow()).toBe(false);
    expect(b.state).toBe("open");
  });

  it("过 resetMs 后 allow 转 half-open 并放行 probe", () => {
    const b = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) b.recordFailure();
    b._forceElapsedForTests(60_001); // 60s+
    expect(b.allow()).toBe(true);
    expect(b.state).toBe("half-open");
  });
});

describe("CircuitBreaker — half-open 态", () => {
  beforeEach(() => {}); // 无全局 setup，每个 it 自带 setup

  it("half-open 后 recordSuccess → closed + 清零计数", () => {
    const b = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) b.recordFailure();
    b._forceElapsedForTests(60_001);
    expect(b.allow()).toBe(true); // 触发 half-open
    expect(b.state).toBe("half-open");

    b.recordSuccess();
    expect(b.state).toBe("closed");
    expect(b.failureCountReadOnly).toBe(0);
  });

  it("half-open 后 recordFailure → 立即回 open（重置计时）", () => {
    const b = new CircuitBreaker(3, 60_000);
    for (let i = 0; i < 3; i++) b.recordFailure();
    b._forceElapsedForTests(60_001);
    b.allow(); // → half-open

    b.recordFailure();
    expect(b.state).toBe("open");
    // 新 openedAt 应是"刚刚"，allow() 应再次为 false
    expect(b.allow()).toBe(false);
  });
});

describe("CircuitBreaker — 自定义参数", () => {
  it("threshold=5 需要 5 次失败才 open", () => {
    const b = new CircuitBreaker(5, 60_000);
    for (let i = 0; i < 4; i++) b.recordFailure();
    expect(b.state).toBe("closed");
    b.recordFailure();
    expect(b.state).toBe("open");
  });

  it("resetMs=1000 1 秒后就 half-open", () => {
    const b = new CircuitBreaker(2, 1000);
    b.recordFailure();
    b.recordFailure();
    expect(b.state).toBe("open");
    b._forceElapsedForTests(1001);
    expect(b.allow()).toBe(true);
    expect(b.state).toBe("half-open");
  });
});

describe("CircuitBreaker — openedAtReadOnly", () => {
  it("未 open 过 → 0", () => {
    const b = new CircuitBreaker();
    expect(b.openedAtReadOnly).toBe(0);
  });
  it("open 后 > 0（接近 Date.now()）", () => {
    const b = new CircuitBreaker();
    const before = Date.now();
    for (let i = 0; i < 3; i++) b.recordFailure();
    const after = Date.now();
    expect(b.openedAtReadOnly).toBeGreaterThanOrEqual(before);
    expect(b.openedAtReadOnly).toBeLessThanOrEqual(after);
  });
});
