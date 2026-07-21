/**
 * PolicyGate 单测（parse5 §3.4.1 + §6.1 #5/#6 + task #2/#8）
 *
 * 覆盖：
 *  - cloud 浏览器通道（browse_cloud_*）必经 LASSO_ALLOW_CLOUD_BROWSER=true（INV-25）
 *  - cloud 浏览器通道双重解锁：manual-switch AND API key 已配
 *  - provider policy_risk="acquired" → 禁用（blocked）
 *  - provider policy_risk="watched" → warn skip（默认阻断；tavilyWatch=true 放行）
 *  - provider policy_risk="safe" → 放行
 *  - checkPlan 批量 API（保留至少 1 个 channel 放行）
 *  - 非 cloud channel + safe provider → 放行
 *
 * 关键断言（INV-25）：
 *  - PolicyGate.ts 必须出现 LASSO_ALLOW_CLOUD_BROWSER 字面量（grep invariant）
 *  - cloud 浏览器 manual-switch = false 时，browse_cloud_* 一律 blocked
 *  - cloud 浏览器 manual-switch = true 但 API key 缺失 → blocked（双重解锁）
 */
import { describe, it, expect } from "vitest";
import {
  PolicyGate,
  toProviderName,
  type PolicyGateEnv,
  type PolicyGateRegistry,
} from "../../src/fallback/PolicyGate.js";
import type { ProviderConfig } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
function makeRegistry(
  configs: Record<string, ProviderConfig>,
): PolicyGateRegistry {
  return {
    get: (name: string) =>
      configs[name] ? { config: configs[name] } : undefined,
  };
}

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

const WATCHED_PROV: ProviderConfig = {
  name: "watched-provider",
  type: "api_key",
  endpoint_url: "https://example.com",
  keys: [],
  free_quota_per_month: 0,
  quota_model: "request",
  fallback_order: 2,
  policy_risk: "watched",
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

// ============================================================
// toProviderName 工具
// ============================================================
describe("PolicyGate — toProviderName 反查", () => {
  it("剥 browse_cloud_ / search. / browse. 前缀", () => {
    expect(toProviderName("browse_cloud_browserbase")).toBe("browserbase");
    expect(toProviderName("browse_cloud_stagehand")).toBe("stagehand");
    expect(toProviderName("search.tavily")).toBe("tavily");
    expect(toProviderName("browse.headless")).toBe("headless");
  });

  it("无前缀可剥的原样返回", () => {
    expect(toProviderName("browse_headless")).toBe("browse_headless");
    expect(toProviderName("desktop.ax")).toBe("desktop.ax");
    expect(toProviderName("zhipu")).toBe("zhipu");
  });
});

// ============================================================
// cloud 浏览器 manual-switch + API key 双重解锁
// ============================================================
describe("PolicyGate — cloud 浏览器双重解锁（INV-25）", () => {
  it("LASSO_ALLOW_CLOUD_BROWSER=false（默认）→ browse_cloud_* blocked", () => {
    const env: PolicyGateEnv = { allowCloudBrowser: false };
    const gate = new PolicyGate(env, makeRegistry({ browserbase: BROWSERBASE_PROV }));
    const v = gate.check("browse_cloud_browserbase");
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/cloud_browser_requires_manual_switch/);
    expect(v.reason).toMatch(/LASSO_ALLOW_CLOUD_BROWSER/);
  });

  it("LASSO_ALLOW_CLOUD_BROWSER=true + BROWSERBASE_API_KEY 已配 → 放行", () => {
    const env: PolicyGateEnv = {
      allowCloudBrowser: true,
      cloudBrowserKeys: new Set(["browserbase"]),
    };
    const gate = new PolicyGate(env, makeRegistry({ browserbase: BROWSERBASE_PROV }));
    const v = gate.check("browse_cloud_browserbase");
    expect(v.allowed).toBe(true);
  });

  it("LASSO_ALLOW_CLOUD_BROWSER=true 但 API key 未配 → blocked（双重解锁）", () => {
    const env: PolicyGateEnv = {
      allowCloudBrowser: true,
      cloudBrowserKeys: new Set(), // 空：没有 cloud 浏览器配 key
    };
    const gate = new PolicyGate(env, makeRegistry({ browserbase: BROWSERBASE_PROV }));
    const v = gate.check("browse_cloud_browserbase");
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/cloud_browser_missing_api_key:browserbase/);
  });

  it("cloudBrowserKeys 未传（undefined）→ 视为空集合 → blocked", () => {
    const env: PolicyGateEnv = { allowCloudBrowser: true }; // cloudBrowserKeys 缺失
    const gate = new PolicyGate(env, makeRegistry({ browserbase: BROWSERBASE_PROV }));
    const v = gate.check("browse_cloud_browserbase");
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/cloud_browser_missing_api_key/);
  });

  it("stagehand 同等适用 cloud 浏览器双重解锁", () => {
    const env: PolicyGateEnv = {
      allowCloudBrowser: true,
      cloudBrowserKeys: new Set(["browserbase"]), // 只配了 browserbase，没 stagehand
    };
    const stagehandProv: ProviderConfig = {
      ...BROWSERBASE_PROV,
      name: "stagehand",
    };
    const gate = new PolicyGate(env, makeRegistry({ stagehand: stagehandProv }));
    const v = gate.check("browse_cloud_stagehand");
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/cloud_browser_missing_api_key:stagehand/);
  });
});

// ============================================================
// provider policy_risk 三态
// ============================================================
describe("PolicyGate — provider policy_risk 三态（parse5 §3.4.1）", () => {
  it('policy_risk="safe" → 放行', () => {
    const gate = new PolicyGate({}, makeRegistry({ "safe-provider": SAFE_PROV }));
    const v = gate.check("safe-provider");
    expect(v.allowed).toBe(true);
  });

  it('policy_risk="acquired" → 禁用（blocked）', () => {
    const gate = new PolicyGate(
      {},
      makeRegistry({ "acquired-provider": ACQUIRED_PROV }),
    );
    const v = gate.check("acquired-provider");
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/policy_risk_acquired:acquired-provider/);
  });

  it('policy_risk="watched" + 未配 tavilyWatch flag → warn skip（blocked）', () => {
    const gate = new PolicyGate(
      {}, // tavilyWatch 未设
      makeRegistry({ "watched-provider": WATCHED_PROV }),
    );
    const v = gate.check("watched-provider");
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/policy_risk_watched_requires_opt_in:watched-provider/);
  });

  it('policy_risk="watched" + tavilyWatch=true → 放行（用户显式 opt-in）', () => {
    const gate = new PolicyGate(
      { tavilyWatch: true },
      makeRegistry({ "watched-provider": WATCHED_PROV }),
    );
    const v = gate.check("watched-provider");
    expect(v.allowed).toBe(true);
  });

  it("未注册的 provider → 放行（无 policy_risk 数据 → 不阻断）", () => {
    const gate = new PolicyGate({}, makeRegistry({}));
    const v = gate.check("unknown-provider");
    expect(v.allowed).toBe(true);
  });
});

// ============================================================
// checkPlan 批量 API
// ============================================================
describe("PolicyGate — checkPlan 批量 API", () => {
  it("全部放行 → allowed=true, filtered=[]", () => {
    const gate = new PolicyGate(
      {},
      makeRegistry({ "safe-a": SAFE_PROV, "safe-b": { ...SAFE_PROV, name: "safe-b" } }),
    );
    const v = gate.checkPlan({ primary: "safe-a", fallbacks: ["safe-b"] });
    expect(v.allowed).toBe(true);
    expect(v.filtered).toEqual([]);
  });

  it("全部 blocked → allowed=false, filtered=全", () => {
    const gate = new PolicyGate(
      {},
      makeRegistry({ "acquired-a": { ...ACQUIRED_PROV, name: "acquired-a" } }),
    );
    const v = gate.checkPlan({
      primary: "acquired-a",
      fallbacks: ["acquired-a"],
    });
    expect(v.allowed).toBe(false);
    expect(v.filtered).toEqual(["acquired-a", "acquired-a"]);
  });

  it("部分 blocked → allowed=true, filtered=被阻的部分", () => {
    const gate = new PolicyGate(
      {},
      makeRegistry({
        "safe-x": { ...SAFE_PROV, name: "safe-x" },
        "acquired-y": { ...ACQUIRED_PROV, name: "acquired-y" },
      }),
    );
    const v = gate.checkPlan({
      primary: "safe-x",
      fallbacks: ["acquired-y"],
    });
    expect(v.allowed).toBe(true);
    expect(v.filtered).toEqual(["acquired-y"]);
  });
});

// ============================================================
// action 参数（v0.4 占位，不区分）
// ============================================================
describe("PolicyGate — action 参数 v0.4 占位", () => {
  it("传或不传 action 都同样判定（v0.4 不区分 action）", () => {
    const gate = new PolicyGate(
      {},
      makeRegistry({ "acquired-z": { ...ACQUIRED_PROV, name: "acquired-z" } }),
    );
    const v1 = gate.check("acquired-z");
    const v2 = gate.check("acquired-z", "navigate");
    const v3 = gate.check("acquired-z", "snapshot");
    expect(v1).toEqual(v2);
    expect(v1).toEqual(v3);
    expect(v1.allowed).toBe(false);
  });
});
