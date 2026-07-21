/**
 * FreeTierRouter 单元测（parse2 §5.1 / §3.3.3）。
 *
 * 覆盖：
 *  - L1/L2/L3/L4 过滤边界
 *  - 默认推断（free_tier_level 缺失视为 L2）
 *  - Tavily policy_risk=acquired 不影响 L4 默认
 *  - freeTierOrder 数字映射
 */
import { describe, it, expect } from "vitest";
import {
  filterByFreeTier,
  freeTierOrder,
} from "../../src/search/FreeTierRouter.js";
import type { FreeTierLevel, ProviderConfig } from "../../src/types.js";

function makeProvider(
  name: string,
  level: FreeTierLevel | undefined,
  extra: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    name,
    type: "api_key",
    endpoint_url: `https://${name}.test/`,
    keys: [],
    free_quota_per_month: 1000,
    quota_model: "monthly",
    fallback_order: 0,
    ...(level !== undefined ? { free_tier_level: level } : {}),
    ...extra,
  };
}

describe("filterByFreeTier — 四级分级", () => {
  it("L1：只允许 L1 provider（zhipu=L2 / brave=L2 都被过滤）", () => {
    const providers = [
      makeProvider("ddg", "L1"),
      makeProvider("zhipu", "L2"),
      makeProvider("brave", "L2"),
    ];
    const r = filterByFreeTier(providers, "L1");
    expect(r.map((p) => p.name)).toEqual(["ddg"]);
  });

  it("L2：允许 L1 + L2", () => {
    const providers = [
      makeProvider("ddg", "L1"),
      makeProvider("zhipu", "L2"),
      makeProvider("exa", "L3"),
      makeProvider("perplexity", "L4"),
    ];
    const r = filterByFreeTier(providers, "L2");
    expect(r.map((p) => p.name).sort()).toEqual(["ddg", "zhipu"]);
  });

  it("L3：允许 L1 + L2 + L3", () => {
    const providers = [
      makeProvider("ddg", "L1"),
      makeProvider("zhipu", "L2"),
      makeProvider("exa", "L3"),
      makeProvider("perplexity", "L4"),
    ];
    const r = filterByFreeTier(providers, "L3");
    expect(r.map((p) => p.name).sort()).toEqual(["ddg", "exa", "zhipu"]);
  });

  it("L4：全允许（默认）", () => {
    const providers = [
      makeProvider("ddg", "L1"),
      makeProvider("zhipu", "L2"),
      makeProvider("exa", "L3"),
      makeProvider("perplexity", "L4"),
    ];
    const r = filterByFreeTier(providers, "L4");
    expect(r).toHaveLength(4);
  });

  it("free_tier_level 缺失 → 视为 L2（默认推断）", () => {
    const providers = [
      makeProvider("no-level", undefined), // 视为 L2
      makeProvider("ddg", "L1"),
    ];
    // L1 → no-level 被过滤（因为视作 L2 > L1）
    expect(filterByFreeTier(providers, "L1").map((p) => p.name)).toEqual(["ddg"]);
    // L2 → 都通过
    expect(filterByFreeTier(providers, "L2")).toHaveLength(2);
  });

  it("Tavily policy_risk=acquired 不影响 L4 默认（policy_risk 与 free_tier_level 独立）", () => {
    const tavily = makeProvider("tavily", "L2", {
      policy_risk: "acquired",
      commercial_safe: false,
    });
    const r = filterByFreeTier([tavily], "L4");
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("tavily");
  });

  it("纯函数：不修改输入数组", () => {
    const providers = [
      makeProvider("a", "L1"),
      makeProvider("b", "L4"),
    ];
    const snapshot = providers.map((p) => ({ ...p }));
    filterByFreeTier(providers, "L2");
    expect(providers).toEqual(snapshot);
  });

  it("空数组 → 返空数组", () => {
    expect(filterByFreeTier([], "L4")).toEqual([]);
  });

  it("实际 v0.2 内置：zhipu + brave 都是 L2 → L2 都通过", () => {
    const v02builtins = [
      makeProvider("zhipu", "L2"),
      makeProvider("brave", "L2"),
    ];
    expect(filterByFreeTier(v02builtins, "L2")).toHaveLength(2);
    expect(filterByFreeTier(v02builtins, "L1")).toHaveLength(0);
  });
});

describe("freeTierOrder — 数字映射", () => {
  it("L1=1 / L2=2 / L3=3 / L4=4", () => {
    expect(freeTierOrder("L1")).toBe(1);
    expect(freeTierOrder("L2")).toBe(2);
    expect(freeTierOrder("L3")).toBe(3);
    expect(freeTierOrder("L4")).toBe(4);
  });
});
