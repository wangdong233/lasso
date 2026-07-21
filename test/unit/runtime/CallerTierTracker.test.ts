/**
 * CallerTierTracker 单元测（parse7 §3.3 + §5.2 ~10 用例）
 *
 * 覆盖：
 *  - tryAcquire：窗口内累计；超额返 false
 *  - per-caller 隔离（A 满 B 仍可用）
 *  - 滑动窗自动重置（窗口过期后 used 归零）
 *  - setCap：per-caller override；cap=0 等价禁用
 *  - snapshot：脱敏 + 窗口过期 used 显示 0
 *  - INV-38：DEFAULT_CALLER_CAP 模块顶级 const + readCallerCapFromEnv env 覆盖
 *  - defaultCap 从构造期注入（运行时不读 env）
 *  - cost 累计 + cost 超额返 false
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CallerTierTracker,
  DEFAULT_CALLER_CAP,
  DEFAULT_WINDOW_MS,
  readCallerCapFromEnv,
} from "../../../src/runtime/CallerTierTracker.js";

describe("CallerTierTracker — INV-38 模块顶级 const", () => {
  it("DEFAULT_CALLER_CAP 是 100（INV-38 选 100 依据 parse7 §3.3）", () => {
    expect(DEFAULT_CALLER_CAP).toBe(100);
  });

  it("DEFAULT_WINDOW_MS 是 60000（60s 滑动窗）", () => {
    expect(DEFAULT_WINDOW_MS).toBe(60_000);
  });

  it("default 构造用 DEFAULT_CALLER_CAP（无 env 时）", () => {
    const t = new CallerTierTracker();
    // 通过 snapshot 验证 defaultCap（首 caller 触发 _getOrCreate）
    for (let i = 0; i < 100; i++) {
      expect(t.tryAcquire("user")).toBe(true);
    }
    // 第 101 次超额
    expect(t.tryAcquire("user")).toBe(false);
  });
});

describe("CallerTierTracker.readCallerCapFromEnv — env 覆盖", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("env 未设 → 返 DEFAULT_CALLER_CAP", () => {
    vi.stubEnv("LASSO_CALLER_CAP_DEFAULT", "");
    expect(readCallerCapFromEnv()).toBe(DEFAULT_CALLER_CAP);
  });

  it("env='50' → 返 50", () => {
    vi.stubEnv("LASSO_CALLER_CAP_DEFAULT", "50");
    expect(readCallerCapFromEnv()).toBe(50);
  });

  it("env='0' → 返 0（禁用所有 caller）", () => {
    vi.stubEnv("LASSO_CALLER_CAP_DEFAULT", "0");
    expect(readCallerCapFromEnv()).toBe(0);
  });

  it("env 非数字 → fallback DEFAULT_CALLER_CAP", () => {
    vi.stubEnv("LASSO_CALLER_CAP_DEFAULT", "not-a-number");
    expect(readCallerCapFromEnv()).toBe(DEFAULT_CALLER_CAP);
  });

  it("env 负数 → fallback DEFAULT_CALLER_CAP", () => {
    vi.stubEnv("LASSO_CALLER_CAP_DEFAULT", "-1");
    expect(readCallerCapFromEnv()).toBe(DEFAULT_CALLER_CAP);
  });
});

describe("CallerTierTracker.tryAcquire — 窗口内累计", () => {
  it("default cap=100 时前 100 次返 true", () => {
    const t = new CallerTierTracker();
    for (let i = 0; i < 100; i++) {
      expect(t.tryAcquire("a")).toBe(true);
    }
  });

  it("default cap=100 时第 101 次返 false", () => {
    const t = new CallerTierTracker();
    for (let i = 0; i < 100; i++) t.tryAcquire("a");
    expect(t.tryAcquire("a")).toBe(false);
  });

  it("cap=3 显式构造：前 3 次通过，第 4 次拒绝", () => {
    const t = new CallerTierTracker(3);
    expect(t.tryAcquire("x")).toBe(true);
    expect(t.tryAcquire("x")).toBe(true);
    expect(t.tryAcquire("x")).toBe(true);
    expect(t.tryAcquire("x")).toBe(false);
  });

  it("cost=2 累计：cap=5 时第 3 次超额（2+2+2=6>5）", () => {
    const t = new CallerTierTracker(5);
    expect(t.tryAcquire("x", 2)).toBe(true); // used=2
    expect(t.tryAcquire("x", 2)).toBe(true); // used=4
    expect(t.tryAcquire("x", 2)).toBe(false); // 4+2=6>5
  });

  it("cost 超过 cap：单次 cost>cap 直接返 false", () => {
    const t = new CallerTierTracker(5);
    expect(t.tryAcquire("x", 10)).toBe(false);
  });
});

describe("CallerTierTracker — per-caller 隔离", () => {
  it("caller A 满，caller B 仍可用", () => {
    const t = new CallerTierTracker(3);
    t.tryAcquire("A");
    t.tryAcquire("A");
    t.tryAcquire("A");
    expect(t.tryAcquire("A")).toBe(false); // A 满
    expect(t.tryAcquire("B")).toBe(true); // B 仍可用
    expect(t.tryAcquire("B")).toBe(true);
    expect(t.tryAcquire("B")).toBe(true);
    expect(t.tryAcquire("B")).toBe(false); // B 也满
  });

  it("setCap A=0 不影响 B（B 仍用 defaultCap）", () => {
    const t = new CallerTierTracker(10);
    t.setCap("A", 0);
    expect(t.tryAcquire("A")).toBe(false); // A 立即拒绝
    expect(t.tryAcquire("B")).toBe(true); // B 仍可用
  });
});

describe("CallerTierTracker.setCap — per-caller override", () => {
  it("setCap(callerId, 5) 后该 caller cap=5", () => {
    const t = new CallerTierTracker(100);
    t.setCap("X", 5);
    for (let i = 0; i < 5; i++) {
      expect(t.tryAcquire("X")).toBe(true);
    }
    expect(t.tryAcquire("X")).toBe(false);
  });

  it("setCap=0 → 立即拒绝", () => {
    const t = new CallerTierTracker(100);
    t.setCap("X", 0);
    expect(t.tryAcquire("X")).toBe(false);
  });

  it("setCap 负数 → clamp 到 0", () => {
    const t = new CallerTierTracker(100);
    t.setCap("X", -5);
    expect(t.tryAcquire("X")).toBe(false);
  });

  it("setCap 小数 → 向下取整", () => {
    const t = new CallerTierTracker(100);
    t.setCap("X", 3.7);
    // floor(3.7) = 3
    expect(t.tryAcquire("X")).toBe(true);
    expect(t.tryAcquire("X")).toBe(true);
    expect(t.tryAcquire("X")).toBe(true);
    expect(t.tryAcquire("X")).toBe(false);
  });
});

describe("CallerTierTracker — 滑动窗自动重置", () => {
  it("窗口内 used 累计；窗口外自动归零", () => {
    // 用极短窗口（10ms）便于测试
    const t = new CallerTierTracker(2, 10);
    expect(t.tryAcquire("X")).toBe(true);
    expect(t.tryAcquire("X")).toBe(true);
    expect(t.tryAcquire("X")).toBe(false);
    // 等窗口过期
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // 窗口已重置
        expect(t.tryAcquire("X")).toBe(true);
        resolve();
      }, 30);
    });
  });
});

describe("CallerTierTracker.snapshot — 脱敏 + 窗口过期清零", () => {
  it("snapshot 列出所有 caller + used + cap + windowMs", () => {
    const t = new CallerTierTracker(10, 60_000);
    t.tryAcquire("A");
    t.tryAcquire("A");
    t.tryAcquire("B");
    const snap = t.snapshot();
    const map = new Map(snap.map((s) => [s.callerId, s]));
    expect(map.get("A")?.used).toBe(2);
    expect(map.get("A")?.cap).toBe(10);
    expect(map.get("A")?.windowMs).toBe(60_000);
    expect(map.get("B")?.used).toBe(1);
  });

  it("snapshot 窗口过期的 caller used 显示 0", () => {
    const t = new CallerTierTracker(10, 5);
    t.tryAcquire("X");
    t.tryAcquire("X");
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const snap = t.snapshot();
        const x = snap.find((s) => s.callerId === "X");
        expect(x?.used).toBe(0); // 窗口过期 → 显示 0
        resolve();
      }, 20);
    });
  });
});

describe("CallerTierTracker.currentUsage / currentCap", () => {
  it("currentUsage 不影响计数（只读）", () => {
    const t = new CallerTierTracker(10);
    t.tryAcquire("X");
    t.tryAcquire("X");
    expect(t.currentUsage("X")).toBe(2);
    expect(t.currentUsage("X")).toBe(2); // 再次读不变
    // 之后仍可用
    expect(t.tryAcquire("X")).toBe(true);
  });

  it("currentUsage 未注册 caller 返 0", () => {
    const t = new CallerTierTracker(10);
    expect(t.currentUsage("nonexistent")).toBe(0);
  });

  it("currentCap 未注册 caller 返 defaultCap", () => {
    const t = new CallerTierTracker(7);
    expect(t.currentCap("nonexistent")).toBe(7);
  });

  it("currentCap 已 setCap 的 caller 返 override 值", () => {
    const t = new CallerTierTracker(7);
    t.setCap("X", 3);
    expect(t.currentCap("X")).toBe(3);
  });
});

describe("CallerTierTracker.reset — 测试用", () => {
  it("reset 清空所有 caller 状态", () => {
    const t = new CallerTierTracker(3);
    t.tryAcquire("A");
    t.tryAcquire("A");
    t.tryAcquire("A");
    expect(t.tryAcquire("A")).toBe(false);
    t.reset();
    // 重置后 A 又可用 3 次
    expect(t.tryAcquire("A")).toBe(true);
    expect(t.snapshot()).toHaveLength(1); // caller A 重新 _getOrCreate
  });
});

describe("CallerTierTracker — CC fallback 'anonymous' 场景", () => {
  it("CC 不传 callerId 时所有请求共享 'anonymous' 配额", () => {
    const t = new CallerTierTracker(100);
    // 模拟 50 次匿名请求
    for (let i = 0; i < 50; i++) {
      expect(t.tryAcquire("anonymous")).toBe(true);
    }
    // 第 51 次仍可用（cap=100）
    expect(t.tryAcquire("anonymous")).toBe(true);
  });
});
