/**
 * ProviderRegistry 集成测（parse2 §5.2）。
 *
 * 覆盖：
 *  - 加载 4 个 builtin provider（brave / browse_headless / browse_logged_in / tavily-watch；
 *    v1.17 A3：zhipu 已随直连死层删除，INV-80 墓碑守卫）
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
const BRAVE_KEYS = "brave-key-1,brave-key-2,brave-key-3";

function makeRegistry(
  providers: ProviderConfig[],
  opts: { braveKeys?: string } = {},
): ProviderRegistry {
  // 模拟 loadConfig 的 key 注入：构造时 copy 后填 keys
  // （v1.17 A3：zhipu provider 已删——无 zhipuKey 注入路径）
  const filled = providers.map((p) => ({ ...p }));
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
  it("BUILTIN_PROVIDERS 含 4 个 provider（brave/browse_headless/browse_logged_in/tavily；v1.17 A3 无 zhipu）", () => {
    const names = BUILTIN_PROVIDERS.map((p) => p.name).sort();
    expect(names).toEqual(
      ["brave", "browse_headless", "browse_logged_in", "tavily"].sort(),
    );
    // v1.17 A3：zhipu provider 已删（INV-80 墓碑——BUILTIN 永不出 zhipu）
    expect(names).not.toContain("zhipu");
  });

  it("loadConfig + env → registry 列表 3 个（tavily enabled=false 跳过；ZHIPU_API_KEY 容忍不注册）", () => {
    const cfg = loadConfig({
      runId: "test-run",
      env: {
        // v1.17 A3：ZHIPU_API_KEY 容忍读但不消费——静默忽略，不注册 provider
        ZHIPU_API_KEY: "retired-zhipu-key",
        BRAVE_API_KEYS: BRAVE_KEYS,
      },
    });
    const names = cfg.registry.listNames().sort();
    expect(names).toEqual(
      ["brave", "browse_headless", "browse_logged_in"].sort(),
    );
    // tavily 被 enabled=false 过滤；zhipu 已删永不注册
    expect(names).not.toContain("tavily");
    expect(names).not.toContain("zhipu");
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
  it("byCap('search') 含 brave（v1.17 A3：唯一 api_key 型 search provider）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], {
      braveKeys: BRAVE_KEYS,
    });
    const search = r.byCap("search");
    expect(search.map((p) => p.config.name)).toEqual(["brave"]);
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
  it("v1.17 A3：get('zhipu') → undefined（provider 已删；ZHIPU_API_KEY 不再注入任何 provider）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], { braveKeys: BRAVE_KEYS });
    expect(r.get("zhipu")).toBeUndefined();
  });

  it("get('brave') 返 config + ledger（3 Key 池）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], { braveKeys: BRAVE_KEYS });
    const b = r.get("brave");
    expect(b).toBeDefined();
    expect(b!.ledger).not.toBeNull();
    expect(b!.ledger!.keyCount).toBe(3);
    // 3 Key × 1000/月 = 3000（S-1：Brave 2026-02 免费档取消，$5 赠送额度 ≈1000/月）
    expect(b!.ledger!.totalRemaining()).toBe(3000);
  });

  it("self_hosted provider（browse_headless）→ ledger=null", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS]);
    const h = r.get("browse_headless");
    expect(h).toBeDefined();
    expect(h!.ledger).toBeNull();
  });

  it("api_key 型但 keys=[] → ledger=null（brave 未配 key）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS]); // 无 key 注入
    const b = r.get("brave");
    expect(b).toBeDefined();
    expect(b!.ledger).toBeNull(); // 无 key → 无 ledger
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
  it("L4（默认）→ brave 通过", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], {
      braveKeys: BRAVE_KEYS,
    });
    const filtered = r.filterByFreeTier("L4").map((p) => p.name).sort();
    expect(filtered).toEqual(["brave"]);
  });

  it("L2 → 空（v1.17 A3：zhipu L2 已删；brave L4 被滤——machine_mcp L1 在 registry 外由 auto 路径兑现）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], {
      braveKeys: BRAVE_KEYS,
    });
    const filtered = r.filterByFreeTier("L2").map((p) => p.name).sort();
    expect(filtered).toEqual([]);
  });

  it("L1 → 空（registry 内无 L1 search provider；machine_mcp enabled=false 不进 registry）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], {
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

// ============================================================
// S-1（21-搜索方案重审）：运营事实回归锁 —— Brave 配额与层级 + Bing 死层清除
// 防止「文档修了、运行时仍旧」的失实再次回归（d3d1b24 补全）。
// ============================================================
describe("ProviderRegistry — S-1 运营事实锁（2026-08-17 核实）", () => {
  it("BRAVE：free_quota_per_month=1000（$5 赠送额度口径）且 free_tier_level=L4（2026-02 免费档取消）", () => {
    const brave = BUILTIN_PROVIDERS.find((p) => p.name === "brave");
    expect(brave).toBeDefined();
    expect(brave!.free_quota_per_month).toBe(1000);
    expect(brave!.free_tier_level).toBe("L4");
  });

  it("BING 死层清除（v1.15 Phase A）：配 BING_API_KEYS → provider 永不注册（存量 config 不炸但静默忽略）", () => {
    // Bing Search APIs 2025-08-11 全量退役——loadConfig 容忍读 BING_API_KEYS
    // 但 providers 表不再注册 bing（doctor #11c bing_keys_retired 提示删除；INV-54 墓碑守卫）
    const cfg = loadConfig({
      runId: "s1-bing-dead-layer",
      env: {
        ...process.env,
        BING_API_KEYS: "dead-key-1,dead-key-2",
      },
    });
    expect(cfg.registry.get("bing")).toBeUndefined();
    expect(
      cfg.registry.byCap("search").map((p) => p.config.name),
    ).not.toContain("bing");
  });

  it("ZHIPU 死层清除（v1.17 A3）：配 ZHIPU_API_KEY → provider 永不注册（存量 config 不炸但静默忽略）", () => {
    // zhipu 直连 API channel 已删除（doc/25 裁决③）——loadConfig 容忍读 ZHIPU_API_KEY
    // 但 providers 表不再注册 zhipu（doctor zhipu_keys_retired 提示删除；INV-80 墓碑守卫）
    const cfg = loadConfig({
      runId: "a3-zhipu-dead-layer",
      env: {
        ...process.env,
        ZHIPU_API_KEY: "retired-key-1",
        ZHIPU_ENDPOINT: "https://open.bigmodel.cn/retired",
      },
    });
    expect(cfg.registry.get("zhipu")).toBeUndefined();
    expect(
      cfg.registry.byCap("search").map((p) => p.config.name),
    ).not.toContain("zhipu");
  });

  it("QuotaLedger 记账不高估：3 Key Brave 池 totalRemaining=3000（非旧 2000/Key）", () => {
    const r = makeRegistry([...BUILTIN_PROVIDERS], { braveKeys: BRAVE_KEYS });
    expect(r.get("brave")!.ledger!.totalRemaining()).toBe(3000);
  });
});
