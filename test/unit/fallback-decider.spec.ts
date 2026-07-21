/**
 * FallbackDecider 单测（parse1 §5.1 + §4.4）
 *
 * 覆盖：
 *  - worked 短路（primary / fallback）
 *  - didnt 短路（primary 正常工作只是"否"）
 *  - unknown + isFallbackWorthy → 升 fallback
 *  - unknown + 排除集（NEEDS_MANUAL_2FA）→ 立即返回不 fallback
 *  - executor 抛异常 → 视为 unknown；抛 NEEDS_MANUAL_2FA → 终止
 *  - 熔断中 channel 被 skip（actions_and_results 记 circuit_open）
 *  - 全部 fallback 耗尽 → outcome=didnt + retrieval_method=fallback_exhausted
 *  - fallback_used 标志位（i>0 时 true）
 *  - actions_and_results 审计链完整
 *  - breaker.recordSuccess / recordFailure 被正确调
 */
import { describe, it, expect, vi } from "vitest";
import { FallbackDecider, type FallbackPlan } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import type { InteractResult } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
function ok<T>(data: T, served_by: string): InteractResult<T> {
  return {
    outcome: "worked",
    data,
    served_by,
    fallback_used: false,
    retrieval_method: "stub",
  };
}
function nope(served_by: string, error?: string): InteractResult<unknown> {
  return {
    outcome: "didnt",
    data: null,
    served_by,
    fallback_used: false,
    retrieval_method: "stub",
    error,
  };
}
function unknown(served_by: string, error?: string): InteractResult<unknown> {
  return {
    outcome: "unknown",
    data: null,
    served_by,
    fallback_used: false,
    retrieval_method: "stub",
    error,
  };
}

const PLAN_PRIMARY_ONLY: FallbackPlan = {
  primary: "primary",
  fallbacks: [],
  cross_modal: false,
};
const PLAN_TWO: FallbackPlan = {
  primary: "primary",
  fallbacks: ["secondary"],
  cross_modal: false,
};
const PLAN_THREE: FallbackPlan = {
  primary: "primary",
  fallbacks: ["secondary", "tertiary"],
  cross_modal: true,
};

// ============================================================
// worked 短路
// ============================================================
describe("FallbackDecider — worked 短路", () => {
  it("primary 返回 worked → 直接返回，不走 fallback", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) =>
      name === "primary"
        ? ok({ a: 1 }, "primary")
        : ok({ wrong: true }, name),
    );
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("worked");
    expect(r.data).toEqual({ a: 1 });
    expect(r.served_by).toBe("primary");
    expect(r.fallback_used).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenNthCalledWith(1, "primary");
    // 审计链只 1 条
    expect(r.actions_and_results).toHaveLength(1);
    expect(r.actions_and_results![0]).toEqual({
      channel: "primary",
      outcome: "worked",
      error: undefined,
    });
  });

  it("primary unknown → secondary worked → fallback_used=true", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) => {
      if (name === "primary") return unknown("primary", "timeout");
      return ok({ b: 2 }, "secondary");
    });
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("worked");
    expect(r.data).toEqual({ b: 2 });
    expect(r.served_by).toBe("secondary");
    expect(r.fallback_used).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(r.actions_and_results).toHaveLength(2);
    expect(r.actions_and_results).toEqual([
      { channel: "primary", outcome: "unknown", error: "timeout" },
      { channel: "secondary", outcome: "worked", error: undefined },
    ]);
  });

  it("primary + secondary 都 unknown → tertiary worked（三段链）", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) => {
      if (name === "primary") return unknown("primary", "timeout");
      if (name === "secondary") return unknown("secondary", "500");
      return ok({ c: 3 }, "tertiary");
    });
    const r = await decider.runWithFallback(PLAN_THREE, exec);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("tertiary");
    expect(r.fallback_used).toBe(true);
    expect(r.actions_and_results).toHaveLength(3);
  });
});

// ============================================================
// didnt 短路
// ============================================================
describe("FallbackDecider — didnt 短路", () => {
  it("primary 返回 didnt → 立即返回（channel 工作正常，只是否）", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) =>
      name === "primary" ? nope("primary", "404") : ok({}, "secondary"),
    );
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("didnt");
    expect(r.served_by).toBe("primary");
    expect(r.fallback_used).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("primary unknown → secondary didnt → 立即返回（不试 tertiary）", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) => {
      if (name === "primary") return unknown("primary", "timeout");
      if (name === "secondary") return nope("secondary", "404");
      return ok({}, "tertiary");
    });
    const r = await decider.runWithFallback(PLAN_THREE, exec);
    expect(r.outcome).toBe("didnt");
    expect(r.served_by).toBe("secondary");
    expect(r.fallback_used).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2); // 没调 tertiary
  });
});

// ============================================================
// unknown + isFallbackWorthy
// ============================================================
describe("FallbackDecider — unknown 升级规则", () => {
  it("unknown + timeout（fallback-worthy）→ 试下一个", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) => {
      if (name === "primary") return unknown("primary", "request timeout");
      return ok({}, "secondary");
    });
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("secondary");
  });

  it("unknown + 200 空响应（无 error）→ fallback-worthy → 升", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) => {
      if (name === "primary") return unknown("primary"); // 无 error
      return ok({ results: [1] }, "secondary");
    });
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("secondary");
  });

  it("unknown + NEEDS_MANUAL_2FA → 立即返回（不掠信号）", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) => {
      if (name === "primary") return unknown("primary", "NEEDS_MANUAL_2FA");
      return ok({}, "secondary"); // 不应该被调
    });
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("unknown"); // 透传原 unknown
    expect(r.served_by).toBe("primary");
    expect(r.fallback_used).toBe(false);
    expect(r.error).toBe("NEEDS_MANUAL_2FA");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("unknown + 404（误报成 unknown）→ 立即返回（不 fallback）", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) => {
      if (name === "primary") return unknown("primary", "HTTP 404");
      return ok({}, "secondary");
    });
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("unknown");
    expect(r.served_by).toBe("primary");
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// executor 抛异常
// ============================================================
describe("FallbackDecider — executor 抛异常", () => {
  it("primary 抛 timeout（fallback-worthy）→ 升 fallback", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) => {
      if (name === "primary") throw new Error("network timeout");
      return ok({}, "secondary");
    });
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("secondary");
    expect(r.actions_and_results![0]).toEqual({
      channel: "primary",
      outcome: "error",
      error: "network timeout",
    });
  });

  it("primary 抛 NEEDS_MANUAL_2FA → 终止链（转 didnt + error）", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async (name: string) => {
      if (name === "primary") throw new Error("NEEDS_MANUAL_2FA");
      return ok({}, "secondary");
    });
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("didnt");
    expect(r.served_by).toBe("primary");
    expect(r.retrieval_method).toBe("error");
    expect(r.error).toBe("NEEDS_MANUAL_2FA");
    expect(r.fallback_used).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("所有 channel 都抛 timeout → 耗尽 fallback_exhausted", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async () => {
      throw new Error("timeout");
    });
    const r = await decider.runWithFallback(PLAN_THREE, exec);
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("fallback_exhausted");
    expect(r.error).toBe("all_channels_failed_or_skipped");
    expect(r.actions_and_results).toHaveLength(3);
    expect(r.actions_and_results!.every((a) => a.outcome === "error")).toBe(true);
  });
});

// ============================================================
// 熔断
// ============================================================
describe("FallbackDecider — 熔断中 channel 被 skip", () => {
  it("primary 熔断中 → 直接走 secondary", async () => {
    const primaryBreaker = new CircuitBreaker(3, 60_000);
    // 打开 primary 熔断
    primaryBreaker.recordFailure();
    primaryBreaker.recordFailure();
    primaryBreaker.recordFailure();
    expect(primaryBreaker.state).toBe("open");

    const decider = new FallbackDecider(
      new Map([
        ["primary", primaryBreaker],
        ["secondary", new CircuitBreaker()],
      ]),
    );
    const exec = vi.fn(async (name: string) =>
      name === "primary" ? ok({}, "primary") : ok({}, "secondary"),
    );
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("secondary");
    expect(exec).toHaveBeenCalledTimes(1); // primary 被 skip，未调
    expect(exec).toHaveBeenCalledWith("secondary");
    expect(r.actions_and_results).toEqual([
      { channel: "primary", outcome: "error", error: "circuit_open" },
      { channel: "secondary", outcome: "worked", error: undefined },
    ]);
  });

  it("所有 channel 熔断 → 全部 skip + fallback_exhausted", async () => {
    const open1 = new CircuitBreaker(3, 60_000);
    open1.recordFailure();
    open1.recordFailure();
    open1.recordFailure();
    const open2 = new CircuitBreaker(3, 60_000);
    open2.recordFailure();
    open2.recordFailure();
    open2.recordFailure();

    const decider = new FallbackDecider(
      new Map([
        ["primary", open1],
        ["secondary", open2],
      ]),
    );
    const exec = vi.fn(async () => ok({}, "never"));
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("fallback_exhausted");
    expect(exec).not.toHaveBeenCalled();
    expect(r.actions_and_results).toEqual([
      { channel: "primary", outcome: "error", error: "circuit_open" },
      { channel: "secondary", outcome: "error", error: "circuit_open" },
    ]);
  });
});

// ============================================================
// breaker 副作用
// ============================================================
describe("FallbackDecider — breaker 副作用", () => {
  it("primary worked → primary breaker.recordSuccess", async () => {
    const breaker = new CircuitBreaker(3, 60_000);
    breaker.recordFailure(); // 先污染
    expect(breaker.failureCountReadOnly).toBe(1);
    const decider = new FallbackDecider(new Map([["primary", breaker]]));
    const exec = vi.fn(async () => ok({}, "primary"));
    await decider.runWithFallback(PLAN_PRIMARY_ONLY, exec);
    expect(breaker.failureCountReadOnly).toBe(0); // 被 success 清零
  });

  it("primary didnt → primary breaker.recordSuccess（正常 negative answer）", async () => {
    const breaker = new CircuitBreaker(3, 60_000);
    breaker.recordFailure();
    const decider = new FallbackDecider(new Map([["primary", breaker]]));
    const exec = vi.fn(async () => nope("primary", "404"));
    await decider.runWithFallback(PLAN_PRIMARY_ONLY, exec);
    expect(breaker.failureCountReadOnly).toBe(0); // 也被清零
  });

  it("primary unknown+timeout → primary breaker.recordFailure", async () => {
    const breaker = new CircuitBreaker(3, 60_000);
    const decider = new FallbackDecider(
      new Map([
        ["primary", breaker],
        ["secondary", new CircuitBreaker()],
      ]),
    );
    const exec = vi.fn(async (name: string) =>
      name === "primary" ? unknown("primary", "timeout") : ok({}, "secondary"),
    );
    await decider.runWithFallback(PLAN_TWO, exec);
    expect(breaker.failureCountReadOnly).toBe(1);
  });
});

// ============================================================
// fallback_exhausted
// ============================================================
describe("FallbackDecider — 全部 fallback 耗尽", () => {
  it("primary + secondary 都 unknown+timeout → didnt + fallback_exhausted", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async () => unknown("x", "timeout"));
    const r = await decider.runWithFallback(PLAN_TWO, exec);
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("fallback_exhausted");
    expect(r.error).toBe("all_channels_failed_or_skipped");
    expect(r.served_by).toBe("secondary"); // 链尾
    expect(r.fallback_used).toBe(true);
    expect(r.actions_and_results).toHaveLength(2);
    expect(r.data).toBe(null);
  });

  it("primary 单链 unknown+timeout → 耗尽（无 fallback）", async () => {
    const decider = new FallbackDecider(new Map());
    const exec = vi.fn(async () => unknown("x", "timeout"));
    const r = await decider.runWithFallback(PLAN_PRIMARY_ONLY, exec);
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("fallback_exhausted");
    expect(r.fallback_used).toBe(false); // 只有一个 channel
  });
});
