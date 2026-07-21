/**
 * ProviderRegistry 集成测（parse2 §5.2）。
 *
 * 覆盖：
 *  - 加载 5 个 builtin provider（zhipu / brave / browse_headless / browse_logged_in / tavily-watch）
 *  - enabled=false（tavily）不进注册表
 *  - CapabilityBag 按 fallback_order 排序
 *  - filterByFreeTier 正确（L1/L2/L4 三档）
 *  - byCap("search") / byCap("browse") 分桶正确
 *  - get(name) 返 RegisteredProvider + ledger
 *  - api_key 型 + 有 keys → 创建 QuotaLedger；self_hosted → null
 *
 * 走 loadConfig 真实装配（注入 env），验证端到端 registry 正确性。
 */
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { ProviderRegistry } from "../../src/config/provider-registry.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";
import type { ProviderConfig } from "../../src/types.js";

// ============================================================
// fixture
// ============================================================
const ZHIPU_KEY = "test-zhipu-key";
const BRAVE_KEYS = "brave-key-1,brave-key-2,brave-key-3";

function makeRegistry(
  providers: ProviderConfig[],
  opts: { zhipuKey?: string; braveKeys?: string } = {},
): ProviderRegistry {
  // 模拟 loadConfig 的 key 注入：构造时 copy 后填 keys
  const filled = providers.map((p) => ({ ...p }));
  if (opts.zhipuKey) {
    const z = filled.find((p) => p.name === "zhipu");
    if (z) z.keys = [opts.zhipuKey];
  }
  if (opts.braveKeys) {
    const b = filled.find((p) => p.name === "brave");
    if (b)
      b.keys = opts.braveKeys
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return new ProviderRegistry(filled);
}

// ============================================================
// builtin provider 加载
// ============================================================
describe("ProviderRegistry — builtin 加载", () => {
  it("BUILTIN_PROVIDERS 含 5 个 provider（zhipu/browse_headless/browse_logged_in/brave/tavily）", () => {
    const names = BUILTIN_PROVIDERS.map((p) => p.name).sort();
    expect(names).toEqual(
      ["brave", "browse_headless", "browse_logged_in", "tavily", "zhipu"].sort(),
    );
  });

  it("loadConfig + env → registry 列表 4 个（tavily enabled=false 跳过）", () => {
    const cfg = loadConfig({
      runId: "test-run",
      env: {
        ZHIPU_API_KEY: ZHIPU_KEY,
        BRAVE_API_KEYS: BRAVE_KEYS,
      },
    });
    const names = cfg.registry.listNames().sort();
    expect(names).toEqual(
      ["brave", "browse_headless", "browse_logged_in", "zhipu"].sort(),
    );
    // tavily 被 enabled=false 过滤
    expect(names).not.toContain("tavily");
  });

  it("tavily 在 getAllConfigs 中（doctor 诊断用）但不在注册表", () => {
    const cfg = loadConfig({ runId: "test", env: {} });
    const allNames = cfg.registry.getAllConfigs().map((c) => c.name);
    expect(allNames).toContain("tavily");
    expect(cfg.registry.listNames()).not.toContain("tavily");
  });
});

// ============================================================
// CapabilityBag 分桶 + 排序
// ============================================================
describe("ProviderRegistry — CapabilityBag 分桶", () => {
  it("byCap('search') 含 zhipu + brave（按 fallback_order 排序）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], {
      zhipuKey: ZHIPU_KEY,
      braveKeys: BRAVE_KEYS,
    });
    const search = r.byCap("search");
    expect(search.map((p) => p.config.name)).toEqual(["zhipu", "brave"]);
  });

  it("byCap('browse') 含 browse_headless + browse_logged_in", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS]);
    const browse = r.byCap("browse");
    expect(browse.map((p) => p.config.name).sort()).toEqual([
      "browse_headless",
      "browse_logged_in",
    ]);
  });

  it("byCap('desktop') 空（v0.2 无 DesktopChannel）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS]);
    expect(r.byCap("desktop")).toEqual([]);
  });

  it("未知 capability → 返空数组（不抛错）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS]);
    expect(r.byCap("unknown" as never)).toEqual([]);
  });
});

// ============================================================
// get(name) + ledger 注入
// ============================================================
describe("ProviderRegistry — get + ledger", () => {
  it("get('zhipu') 返 config + ledger（keys 注入后）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], { zhipuKey: ZHIPU_KEY });
    const z = r.get("zhipu");
    expect(z).toBeDefined();
    expect(z!.config.name).toBe("zhipu");
    expect(z!.ledger).not.toBeNull();
    expect(z!.ledger!.keyCount).toBe(1);
    // 智谱 quotaPerMonth=0（未公开精确值），totalRemaining 也为 0；
    // 但 ledger 实例存在（key 注入成功）。
    expect(z!.ledger!.quotaModel).toBe("token");
  });

  it("get('brave') 返 config + ledger（3 Key 池）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], { braveKeys: BRAVE_KEYS });
    const b = r.get("brave");
    expect(b).toBeDefined();
    expect(b!.ledger).not.toBeNull();
    expect(b!.ledger!.keyCount).toBe(3);
    // 3 Key × 2000/月 = 6000
    expect(b!.ledger!.totalRemaining()).toBe(6000);
  });

  it("self_hosted provider（browse_headless）→ ledger=null", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS]);
    const h = r.get("browse_headless");
    expect(h).toBeDefined();
    expect(h!.ledger).toBeNull();
  });

  it("api_key 型但 keys=[] → ledger=null（zhipu 未配 key）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS]); // 无 key 注入
    const z = r.get("zhipu");
    expect(z).toBeDefined();
    expect(z!.ledger).toBeNull(); // 无 key → 无 ledger
  });

  it("get('tavily') → undefined（enabled=false 不在注册表）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS]);
    expect(r.get("tavily")).toBeUndefined();
  });

  it("get('unknown') → undefined（不抛错）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS]);
    expect(r.get("does-not-exist")).toBeUndefined();
  });
});

// ============================================================
// filterByFreeTier
// ============================================================
describe("ProviderRegistry — filterByFreeTier", () => {
  it("L4（默认）→ zhipu + brave 都通过", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], {
      zhipuKey: ZHIPU_KEY,
      braveKeys: BRAVE_KEYS,
    });
    const filtered = r.filterByFreeTier("L4").map((p) => p.name).sort();
    expect(filtered).toEqual(["brave", "zhipu"]);
  });

  it("L2 → zhipu + brave 都通过（两者都是 L2）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], {
      zhipuKey: ZHIPU_KEY,
      braveKeys: BRAVE_KEYS,
    });
    const filtered = r.filterByFreeTier("L2").map((p) => p.name).sort();
    expect(filtered).toEqual(["brave", "zhipu"]);
  });

  it("L1 → 都不过滤通过（v0.2 无 L1 search provider）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], {
      zhipuKey: ZHIPU_KEY,
      braveKeys: BRAVE_KEYS,
    });
    expect(r.filterByFreeTier("L1")).toEqual([]);
  });
});

// ============================================================
// 开闭原则：加 provider ≤2 处改动（验收 #6）
// ============================================================
describe("ProviderRegistry — 开闭（验收 #6）", () => {
  it("加新 provider 只需 push 到数组（不动 Registry 类）", () => {
    // 模拟加一个新 provider EXA
    const EXA: ProviderConfig = {
      name: "exa",
      type: "api_key",
      endpoint_url: "https://api.exa.ai/search",
      keys: ["exa-key"],
      free_quota_per_month: 1000,
      quota_model: "request",
      fallback_order: 5,
      free_tier_level: "L3",
      tags: ["search"],
      enabled: true,
    };
    const r = new ProviderRegistry([...BUILTIN_PROVIDERS, EXA]);
    // 新 provider 自动进入 byCap("search")
    const search = r.byCap("search");
    expect(search.map((p) => p.config.name)).toContain("exa");
    // 自动创建 ledger
    expect(r.get("exa")?.ledger).not.toBeNull();
    // filterByFreeTier L3 仍能查到
    expect(r.filterByFreeTier("L3").map((p) => p.name)).toContain("exa");
  });
});
