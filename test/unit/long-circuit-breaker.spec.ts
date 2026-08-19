/**
 * LongCircuitBreaker 单测（parse8 §3.1 / §5.1）
 *
 * 覆盖状态机迁移 + 滑动窗 + onOpen 回调 + reset：
 *  closed   --windowMs 内 threshold 次-->  open (+ onOpen 调 bag.disable)
 *  open     --resetMs-->                  half-open
 *  half-open --success-->                 closed
 *  half-open --failure-->                 open (+ onOpen)
 *  windowMs 外的失败时间戳被剔除（不累积）
 *  reset() 回 closed（admin 手工唤醒）
 *  onOpen 抛错不污染状态（保守吞错）
 *  INV-41：复用 BreakerState（不重定义）
 *  INV-42：onOpen 回调由装配层调 bag.disable（这里 mock 验证回调被调）
 */
import { describe, it, expect, vi } from "vitest";
import { LongCircuitBreaker } from "../../src/fallback/LongCircuitBreaker.js";
import type { BreakerState } from "../../src/fallback/CircuitBreaker.js";

// ============================================================
// helpers
// ============================================================
/**
 * 快进 windowMs / resetMs（让早期失败时间戳被剔除；让 open 态转 half-open）。
 *
 * 实现：直接调 _forceElapsedForTests（已实装 backdate + filter 同步老化）。
 * 不依赖 fake timers（与 CircuitBreaker 同范式，测试更稳定）。
 */
function fastForwardWindow(b: LongCircuitBreaker, ms: number): void {
  (b as unknown as { _forceElapsedForTests: (ms: number) => void })._forceElapsedForTests(ms);
}

// ============================================================
// closed 态
// ============================================================
describe("LongCircuitBreaker — closed 态", () => {
  it("初始状态 closed + allow=true", () => {
    const b = new LongCircuitBreaker();
    expect(b.state).toBe("closed");
    expect(b.allow()).toBe(true);
    expect(b.windowFailureCount).toBe(0);
    expect(b.openedAtReadOnly).toBe(0);
  });

  it("threshold-1 次失败仍 closed", async () => {
    const onOpen = vi.fn(async () => {});
    const b = new LongCircuitBreaker(10, 3_600_000, 3_600_000, onOpen, "test");
    for (let i = 0; i < 9; i++) await b.recordFailure();
    expect(b.state).toBe("closed");
    expect(b.windowFailureCount).toBe(9);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("threshold 次失败 → open + onOpen 回调被调", async () => {
    const onOpen = vi.fn(async () => {});
    const b = new LongCircuitBreaker(10, 3_600_000, 3_600_000, onOpen, "test.channel");
    for (let i = 0; i < 10; i++) await b.recordFailure();
    expect(b.state).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("test.channel");
    expect(b.openedAtReadOnly).toBeGreaterThan(0);
  });

  it("recordSuccess 清零失败时间戳 + 回 closed", async () => {
    const b = new LongCircuitBreaker(5, 3_600_000, 3_600_000, undefined, "test");
    for (let i = 0; i < 4; i++) await b.recordFailure();
    expect(b.windowFailureCount).toBe(4);
    b.recordSuccess();
    expect(b.state).toBe("closed");
    expect(b.windowFailureCount).toBe(0);
  });
});

// ============================================================
// 滑动窗
// ============================================================
describe("LongCircuitBreaker — 滑动窗剔除", () => {
  it("windowMs 外的失败被剔除（不计入 threshold）", async () => {
    const onOpen = vi.fn(async () => {});
    const b = new LongCircuitBreaker(5, 1000, 3_600_000, onOpen, "test"); // windowMs=1s
    // 4 次失败
    for (let i = 0; i < 4; i++) await b.recordFailure();
    expect(b.windowFailureCount).toBe(4);
    // 快进 1.5s（超过 windowMs=1s）—— 4 个老时间戳被剔除
    fastForwardWindow(b, 1500);
    expect(b.windowFailureCount).toBe(0); // 老 4 个全被剔
    // 再 4 次失败 —— 不够 threshold=5
    for (let i = 0; i < 4; i++) await b.recordFailure();
    expect(b.windowFailureCount).toBe(4); // 新 4 个（窗口未老化）
    expect(b.state).toBe("closed");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("短间隔内连续 threshold 次 → open（窗口未老化）", async () => {
    const onOpen = vi.fn(async () => {});
    const b = new LongCircuitBreaker(3, 3_600_000, 3_600_000, onOpen, "test");
    await b.recordFailure();
    await b.recordFailure();
    await b.recordFailure();
    expect(b.state).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// open 态 + half-open
// ============================================================
describe("LongCircuitBreaker — open → half-open → closed/open", () => {
  it("open 时 allow=false", async () => {
    const b = new LongCircuitBreaker(3, 3_600_000, 3_600_000, undefined, "test");
    for (let i = 0; i < 3; i++) await b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.allow()).toBe(false);
  });

  it("未过 resetMs 仍 open", async () => {
    const b = new LongCircuitBreaker(3, 3_600_000, 60_000, undefined, "test");
    for (let i = 0; i < 3; i++) await b.recordFailure();
    fastForwardWindow(b, 30_000); // 30s < 60s resetMs
    expect(b.allow()).toBe(false);
    expect(b.state).toBe("open");
  });

  it("过 resetMs 后 allow 转 half-open 并放 probe", async () => {
    const b = new LongCircuitBreaker(3, 3_600_000, 60_000, undefined, "test");
    for (let i = 0; i < 3; i++) await b.recordFailure();
    fastForwardWindow(b, 60_001); // > 60s
    expect(b.allow()).toBe(true);
    expect(b.state).toBe("half-open");
  });

  it("half-open 后 recordSuccess → closed", async () => {
    const b = new LongCircuitBreaker(3, 3_600_000, 60_000, undefined, "test");
    for (let i = 0; i < 3; i++) await b.recordFailure();
    fastForwardWindow(b, 60_001);
    b.allow(); // → half-open
    b.recordSuccess();
    expect(b.state).toBe("closed");
    expect(b.windowFailureCount).toBe(0);
  });

  it("half-open 后 recordFailure → 立即回 open + onOpen 再次被调", async () => {
    const onOpen = vi.fn(async () => {});
    const b = new LongCircuitBreaker(3, 3_600_000, 60_000, onOpen, "test");
    for (let i = 0; i < 3; i++) await b.recordFailure();
    expect(onOpen).toHaveBeenCalledTimes(1);
    fastForwardWindow(b, 60_001);
    b.allow(); // → half-open
    await b.recordFailure(); // 立即回 open
    expect(b.state).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(2); // half-open failure 也触发 onOpen
  });

  it("open 态 recordFailure 幂等（不重复 onOpen）", async () => {
    const onOpen = vi.fn(async () => {});
    const b = new LongCircuitBreaker(3, 3_600_000, 60_000, onOpen, "test");
    for (let i = 0; i < 3; i++) await b.recordFailure();
    expect(onOpen).toHaveBeenCalledTimes(1);
    // open 态再调 recordFailure（模拟主路径仍 flow 失败）
    await b.recordFailure();
    await b.recordFailure();
    expect(onOpen).toHaveBeenCalledTimes(1); // 幂等不重发
  });
});

// ============================================================
// reset() admin 唤醒
// ============================================================
describe("LongCircuitBreaker — reset() admin 手工唤醒", () => {
  it("reset() 强制回 closed + 清零", async () => {
    const b = new LongCircuitBreaker(3, 3_600_000, 60_000, undefined, "test");
    for (let i = 0; i < 3; i++) await b.recordFailure();
    expect(b.state).toBe("open");
    b.reset();
    expect(b.state).toBe("closed");
    expect(b.windowFailureCount).toBe(0);
    expect(b.openedAtReadOnly).toBe(0);
    expect(b.allow()).toBe(true);
  });
});

// ============================================================
// onOpen 错误隔离
// ============================================================
describe("LongCircuitBreaker — onOpen 错误隔离", () => {
  it("onOpen 抛错不污染 breaker 状态（仍 open）", async () => {
    const onOpen = vi.fn(async () => {
      throw new Error("bag.disable failed");
    });
    const b = new LongCircuitBreaker(3, 3_600_000, 60_000, onOpen, "test");
    for (let i = 0; i < 3; i++) await b.recordFailure();
    // breaker 仍 open（不因 onOpen 抛错回滚）
    expect(b.state).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(b.allow()).toBe(false);
  });
});

// ============================================================
// INV-41 守护：BreakerState 类型复用
// ============================================================
describe("LongCircuitBreaker — INV-41 类型复用", () => {
  it("state 字段类型 = BreakerState（不重定义）", () => {
    const b = new LongCircuitBreaker();
    // 类型断言：state 必须可赋给 BreakerState（编译时检查）
    const s: BreakerState = b.state;
    expect(["closed", "open", "half-open"]).toContain(s);
  });
});

// ============================================================
// v1.18.2（doc/29 F2）：喂入分类 + 恢复闭环 onClose
// ============================================================
describe("LongCircuitBreaker — F2a 喂入分类（环境瞬态不计数）", () => {
  it("TUN 断网风暴：20 次 DNS/timeout 瞬态失败 → 仍 closed（不升级 60min disable）", async () => {
    const onOpen = vi.fn(async () => {});
    const b = new LongCircuitBreaker(10, 3_600_000, 3_600_000, onOpen, "browse_headless");
    // 模拟用户断网 10 分钟：每分钟 2 次 unknown（DNS 失败 / 超时 / 连接拒）
    for (let i = 0; i < 20; i++) {
      await b.recordFailure("getaddrinfo ENOTFOUND site.example.com");
      await b.recordFailure("request timeout after 30000ms");
    }
    expect(b.state).toBe("closed");
    expect(b.windowFailureCount).toBe(0); // 瞬态一次都不计
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("裸 unknown（无 error 的 200 空响应类）→ 不计数", async () => {
    const b = new LongCircuitBreaker(10, 3_600_000, 3_600_000);
    for (let i = 0; i < 15; i++) await b.recordFailure("unknown");
    expect(b.state).toBe("closed");
    expect(b.windowFailureCount).toBe(0);
  });

  it("持续故障类（brave_status_429）正常计数 → threshold 次 open", async () => {
    const onOpen = vi.fn(async () => {});
    const b = new LongCircuitBreaker(10, 3_600_000, 3_600_000, onOpen, "search.brave");
    for (let i = 0; i < 10; i++) await b.recordFailure("brave_status_429");
    expect(b.state).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("no-arg recordFailure 保持旧语义（计数）——既有调用方零回归", async () => {
    const b = new LongCircuitBreaker(3, 3_600_000, 3_600_000);
    for (let i = 0; i < 3; i++) await b.recordFailure();
    expect(b.state).toBe("open");
  });

  it("half-open 态收到瞬态失败 → 保持 half-open（不 re-open 60min，留给下次 probe）", async () => {
    const onOpen = vi.fn(async () => {});
    const b = new LongCircuitBreaker(2, 3_600_000, 3_600_000, onOpen, "ch");
    await b.recordFailure("quota_exhausted");
    await b.recordFailure("quota_exhausted");
    expect(b.state).toBe("open");
    fastForwardWindow(b, 3_600_001);
    expect(b.allow()).toBe(true); // → half-open
    expect(b.state).toBe("half-open");
    // probe 期间 DNS 抖动失败 → 不 re-open
    await b.recordFailure("getaddrinfo ENOTFOUND x.test");
    expect(b.state).toBe("half-open");
  });
});

describe("LongCircuitBreaker — F2c 恢复闭环（onClose）", () => {
  it("open → half-open → recordSuccess：onClose 被调（装配层联动 bag.enable）", async () => {
    const onOpen = vi.fn(async () => {});
    const onClose = vi.fn(async () => {});
    const b = new LongCircuitBreaker(2, 3_600_000, 3_600_000, onOpen, "ch", onClose);
    await b.recordFailure("quota_exhausted");
    await b.recordFailure("quota_exhausted");
    expect(b.state).toBe("open");
    fastForwardWindow(b, 3_600_001);
    b.allow(); // → half-open
    b.recordSuccess(); // probe 成功 → closed + onClose
    expect(b.state).toBe("closed");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("ch");
  });

  it("closed 态常规 recordSuccess 不触发 onClose（无恢复转换）", () => {
    const onClose = vi.fn(async () => {});
    const b = new LongCircuitBreaker(2, 3_600_000, 3_600_000, undefined, "ch", onClose);
    b.recordSuccess();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("onClose 抛错被吞（不 rethrow、不影响状态）", async () => {
    const onClose = vi.fn(async () => {
      throw new Error("bag.enable failed");
    });
    const b = new LongCircuitBreaker(1, 3_600_000, 3_600_000, undefined, "ch", onClose);
    await b.recordFailure("quota_exhausted");
    expect(b.state).toBe("open");
    fastForwardWindow(b, 3_600_001);
    b.allow();
    expect(() => b.recordSuccess()).not.toThrow();
    expect(b.state).toBe("closed");
    // fire-and-forget 是异步的——让微任务队列排空再断言
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
