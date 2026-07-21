/**
 * FallbackDecider + PolicyGate 集成单测（parse5 §3.4.2 + §6.1 #7 + task #3/#8）
 *
 * 覆盖：
 *  - 未注入 PolicyGate → runWithFallback 行为完全等价 v0.3.5（零回归 byte-identical）
 *  - 注入 PolicyGate + 全部 channel policy_blocked → outcome=didnt + retrieval_method=policy_blocked
 *  - 注入 PolicyGate + 部分 channel blocked → 剩余 chain 继续走既有 fallback 路径
 *  - 注入 PolicyGate + primary blocked → fallback channel 接管（fallback_used=true）
 *  - policy_blocked channel 记入 actions_and_results 审计链
 *  - budgetTracker 仍生效（policy_blocked 路径也走 flushInto）
 *
 * 关键断言（parse5 §3.4.2）：
 *  - policy_blocked 的 channel 不调 breaker（不是 channel 故障）
 *  - policy_blocked 路径 retrieval_method === "policy_blocked"
 *  - policy_blocked 路径 actions_and_results 含每个 blocked channel 的审计行
 *
 * 零回归承诺：
 *  - FallbackDecider 新构造（无第 2 参）→ runWithFallback byte-identical v0.3.5
 *  - 所有 v0.3.5 fallback-decider.spec.ts 行为在新构造下保持完全一致
 */
import { describe, it, expect, vi } from "vitest";
import {
  FallbackDecider,
  type FallbackPlan,
} from "../../src/fallback/FallbackDecider.js";
import { PolicyGate } from "../../src/fallback/PolicyGate.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import type { InteractResult, ProviderConfig } from "../../src/types.js";

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

const ACQUIRED_PROV: ProviderConfig = {
  name: "acquired-provider",
  type: "api_key",
  endpoint_url: "https://example.com",
  keys: [],
  free_quota_per_month: 0,
  quota_model: "request",
  fallback_order: 1,
  policy_risk: "acquired",
};

const SAFE_PROV: ProviderConfig = {
  name: "safe-provider",
  type: "self_hosted",
  endpoint_url: null,
  keys: [],
  free_quota_per_month: 0,
  quota_model: "request",
  fallback_order: 0,
  policy_risk: "safe",
};

const BROWSERBASE_PROV: ProviderConfig = {
  name: "browserbase",
  type: "api_key",
  endpoint_url: "wss://cdp.browserbase.com",
  keys: [],
  free_quota_per_month: 0,
  quota_model: "request",
  fallback_order: 10,
  policy_risk: "watched",
  tags: ["browse", "cloud"],
};

/** 构造一个会让指定 channel 名 blocked 的 PolicyGate。 */
function makeGate(opts: {
  allowCloudBrowser?: boolean;
  cloudBrowserKeys?: ReadonlySet<string>;
  tavilyWatch?: boolean;
  providers?: Record<string, ProviderConfig>;
}): PolicyGate {
  return new PolicyGate(
    {
      allowCloudBrowser: opts.allowCloudBrowser,
      cloudBrowserKeys: opts.cloudBrowserKeys,
      tavilyWatch: opts.tavilyWatch,
    },
    {
      get: (name: string) =>
        opts.providers?.[name]
          ? { config: opts.providers[name] }
          : undefined,
    },
  );
}

// ============================================================
// 零回归 byte-identical（核心承诺）
// ============================================================
describe("FallbackDecider + PolicyGate — 未注入零回归（byte-identical v0.3.5）", () => {
  it("新构造（无第 2 参）→ runWithFallback 走 v0.3.5 路径", async () => {
    // 不传第 2 参：等价 new FallbackDecider(breakers)
    const decider = new FallbackDecider(new Map());
    const plan: FallbackPlan = {
      primary: "browse_cloud_browserbase",
      fallbacks: ["safe-provider"],
      cross_modal: false,
    };
    const exec = vi.fn(async (name: string) =>
      name === "browse_cloud_browserbase"
        ? ok({ cloud: true }, name)
        : ok({ safe: true }, name),
    );
    const r = await decider.runWithFallback(plan, exec);
    // 未注入 PolicyGate：browse_cloud_browserbase 即使理论上应被 policy gate 阻断，
    // 此处也照常执行（零回归承诺）
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("browse_cloud_browserbase");
    expect(r.fallback_used).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("browse_cloud_browserbase");
  });

  it("显式传 null 第 2 参 → 同样零回归", async () => {
    const decider = new FallbackDecider(new Map(), null);
    const plan: FallbackPlan = {
      primary: "primary",
      fallbacks: ["secondary"],
      cross_modal: false,
    };
    const exec = vi.fn(async (name: string) =>
      name === "primary"
        ? unknown("primary", "timeout")
        : ok({}, "secondary"),
    );
    const r = await decider.runWithFallback(plan, exec);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("secondary");
    expect(r.fallback_used).toBe(true);
  });

  it("未注入时 plan 全是 cloud browser → 仍照常执行（不被自动阻断）", async () => {
    const decider = new FallbackDecider(new Map());
    const plan: FallbackPlan = {
      primary: "browse_cloud_browserbase",
      fallbacks: ["browse_cloud_stagehand"],
      cross_modal: false,
    };
    const exec = vi.fn(async () => ok({}, "stub"));
    const r = await decider.runWithFallback(plan, exec);
    expect(r.outcome).toBe("worked");
    expect(exec).toHaveBeenCalledTimes(1); // primary 短路
  });
});

// ============================================================
// 全部 policy_blocked 路径（核心新增）
// ============================================================
describe("FallbackDecider + PolicyGate — 全部 policy_blocked", () => {
  it("全部 channel policy_blocked → outcome=didnt + retrieval_method=policy_blocked", async () => {
    // 用 acquired provider 让所有 channel 都 blocked
    const gate = makeGate({
      providers: {
        "acquired-a": { ...ACQUIRED_PROV, name: "acquired-a" },
        "acquired-b": { ...ACQUIRED_PROV, name: "acquired-b" },
      },
    });
    const decider = new FallbackDecider(new Map(), gate);
    const plan: FallbackPlan = {
      primary: "acquired-a",
      fallbacks: ["acquired-b"],
      cross_modal: false,
    };
    const exec = vi.fn(async () => ok({}, "never"));
    const r = await decider.runWithFallback(plan, exec);
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("policy_blocked");
    expect(r.error).toBe("all_channels_policy_blocked");
    expect(r.fallback_used).toBe(false);
    expect(r.served_by).toBe("acquired-a"); // plan.primary
    expect(r.data).toBe(null);
    // executor 永不被调（policy gate 前置阻断）
    expect(exec).not.toHaveBeenCalled();
  });

  it("policy_blocked channel 记入 actions_and_results 审计链", async () => {
    const gate = makeGate({
      providers: {
        "acquired-a": { ...ACQUIRED_PROV, name: "acquired-a" },
        "acquired-b": { ...ACQUIRED_PROV, name: "acquired-b" },
      },
    });
    const decider = new FallbackDecider(new Map(), gate);
    const plan: FallbackPlan = {
      primary: "acquired-a",
      fallbacks: ["acquired-b"],
      cross_modal: false,
    };
    const r = await decider.runWithFallback(plan, async () => ok({}, ""));
    expect(r.actions_and_results).toHaveLength(2);
    expect(r.actions_and_results).toEqual([
      {
        channel: "acquired-a",
        outcome: "error",
        error: expect.stringMatching(/policy_blocked:policy_risk_acquired/),
      },
      {
        channel: "acquired-b",
        outcome: "error",
        error: expect.stringMatching(/policy_blocked:policy_risk_acquired/),
      },
    ]);
  });

  it("cloud 浏览器 manual-switch 关 → browse_cloud_* 全 blocked", async () => {
    const gate = makeGate({
      allowCloudBrowser: false, // 默认关
      providers: { browserbase: BROWSERBASE_PROV },
    });
    const decider = new FallbackDecider(new Map(), gate);
    const plan: FallbackPlan = {
      primary: "browse_cloud_browserbase",
      fallbacks: ["browse_cloud_stagehand"],
      cross_modal: false,
    };
    const r = await decider.runWithFallback(plan, async () => ok({}, ""));
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("policy_blocked");
    expect(r.actions_and_results!.length).toBe(2);
    // 两个 channel 都因 manual-switch 关被 blocked
    expect(
      r.actions_and_results!.every((a) =>
        /cloud_browser_requires_manual_switch/.test(a.error ?? ""),
      ),
    ).toBe(true);
  });
});

// ============================================================
// 部分 policy_blocked → 剩余 chain 继续走
// ============================================================
describe("FallbackDecider + PolicyGate — 部分 blocked", () => {
  it("primary blocked → fallback channel 接管（fallback_used=true）", async () => {
    const gate = makeGate({
      providers: {
        "acquired-primary": { ...ACQUIRED_PROV, name: "acquired-primary" },
        "safe-fallback": { ...SAFE_PROV, name: "safe-fallback" },
      },
    });
    const decider = new FallbackDecider(new Map(), gate);
    const plan: FallbackPlan = {
      primary: "acquired-primary",
      fallbacks: ["safe-fallback"],
      cross_modal: false,
    };
    const exec = vi.fn(async (name: string) =>
      name === "safe-fallback" ? ok({ safe: true }, name) : ok({}, "wrong"),
    );
    const r = await decider.runWithFallback(plan, exec);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("safe-fallback");
    expect(r.fallback_used).toBe(true); // primary 被 policy block，走了 fallback
    // exec 只被调了一次（safe-fallback；primary 被 policy gate 前置阻断）
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("safe-fallback");
    // 审计链：primary policy_blocked + fallback worked
    expect(r.actions_and_results).toEqual([
      {
        channel: "acquired-primary",
        outcome: "error",
        error: expect.stringMatching(/policy_blocked/),
      },
      { channel: "safe-fallback", outcome: "worked", error: undefined },
    ]);
  });

  it("中间 channel blocked → 剩余继续 fallback", async () => {
    const gate = makeGate({
      providers: {
        "safe-primary": { ...SAFE_PROV, name: "safe-primary" },
        "acquired-middle": { ...ACQUIRED_PROV, name: "acquired-middle" },
        "safe-tail": { ...SAFE_PROV, name: "safe-tail" },
      },
    });
    const decider = new FallbackDecider(new Map(), gate);
    const plan: FallbackPlan = {
      primary: "safe-primary",
      fallbacks: ["acquired-middle", "safe-tail"],
      cross_modal: false,
    };
    const exec = vi.fn(async (name: string) => {
      if (name === "safe-primary") return unknown("safe-primary", "timeout");
      if (name === "safe-tail") return ok({ tail: true }, "safe-tail");
      return ok({}, "wrong");
    });
    const r = await decider.runWithFallback(plan, exec);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("safe-tail");
    // exec 被调了 2 次：safe-primary（unknown 升） + safe-tail（worked）
    // acquired-middle 被 policy gate 前置阻断，不调 exec
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, "safe-primary");
    expect(exec).toHaveBeenNthCalledWith(2, "safe-tail");
  });

  it("policy_blocked channel 不调 breaker（不是 channel 故障）", async () => {
    const breakerForAcquired = new CircuitBreaker();
    const breakerForSafe = new CircuitBreaker();
    const gate = makeGate({
      providers: {
        "acquired-x": { ...ACQUIRED_PROV, name: "acquired-x" },
        "safe-y": { ...SAFE_PROV, name: "safe-y" },
      },
    });
    const decider = new FallbackDecider(
      new Map([
        ["acquired-x", breakerForAcquired],
        ["safe-y", breakerForSafe],
      ]),
      gate,
    );
    const plan: FallbackPlan = {
      primary: "acquired-x",
      fallbacks: ["safe-y"],
      cross_modal: false,
    };
    await decider.runWithFallback(plan, async () => ok({}, ""));
    // breakerForAcquired 不应被 record（policy_blocked 不算故障）
    expect(breakerForAcquired.failureCountReadOnly).toBe(0);
    // breakerForSafe 应被 recordSuccess（executed + worked）
    expect(breakerForSafe.failureCountReadOnly).toBe(0);
  });
});

// ============================================================
// policy_blocked + budget 透传
// ============================================================
describe("FallbackDecider + PolicyGate — budget 透传", () => {
  it("policy_blocked 路径仍走 budget.flushInto（如果有 budget）", async () => {
    const { BudgetTracker } = await import("../../src/fallback/BudgetTracker.js");
    const budget = new BudgetTracker();
    const gate = makeGate({
      providers: {
        "acquired-only": { ...ACQUIRED_PROV, name: "acquired-only" },
      },
    });
    const decider = new FallbackDecider(new Map(), gate);
    const plan: FallbackPlan = {
      primary: "acquired-only",
      fallbacks: [],
      cross_modal: false,
    };
    const r = await decider.runWithFallback(
      plan,
      async () => ok({}, ""),
      budget,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("policy_blocked");
    // budget.flushInto 不破坏 result 形状
    expect(r.actions_and_results).toHaveLength(1);
  });
});

// ============================================================
// cloud 浏览器 manual-switch 双重解锁场景
// ============================================================
describe("FallbackDecider + PolicyGate — cloud 浏览器双重解锁", () => {
  it("manual-switch=true + API key 配 → cloud 浏览器走起", async () => {
    const gate = makeGate({
      allowCloudBrowser: true,
      cloudBrowserKeys: new Set(["browserbase"]),
      providers: { browserbase: BROWSERBASE_PROV },
    });
    const decider = new FallbackDecider(new Map(), gate);
    const plan: FallbackPlan = {
      primary: "browse_cloud_browserbase",
      fallbacks: [],
      cross_modal: false,
    };
    const exec = vi.fn(async () => ok({ cloud: true }, "browse_cloud_browserbase"));
    const r = await decider.runWithFallback(plan, exec);
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("browse_cloud_browserbase");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("manual-switch=true 但 API key 缺 → cloud 浏览器 blocked（双重解锁）", async () => {
    const gate = makeGate({
      allowCloudBrowser: true,
      cloudBrowserKeys: new Set(), // 空
      providers: { browserbase: BROWSERBASE_PROV },
    });
    const decider = new FallbackDecider(new Map(), gate);
    const plan: FallbackPlan = {
      primary: "browse_cloud_browserbase",
      fallbacks: [],
      cross_modal: false,
    };
    const r = await decider.runWithFallback(plan, async () => ok({}, ""));
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("policy_blocked");
    expect(r.actions_and_results![0].error).toMatch(
      /policy_blocked:cloud_browser_missing_api_key/,
    );
  });
});
