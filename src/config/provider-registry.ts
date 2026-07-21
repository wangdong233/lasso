/**
 * ProviderRegistry —— ProviderConfig 注册表 + CapabilityBag 自动生成（parse2 §3.1.3）。
 *
 * 单一真源（不变量 INV-9）：ProviderRegistry 类定义只在 config/provider-registry.ts。
 * 加 provider = providers.ts 加一项常量 + push 到 BUILTIN_PROVIDERS（开闭，≤2 处改动）。
 * CapabilityBag 据配置自动生成（byCapability map），新增 provider 不需要改 channel/tool 代码。
 *
 * 设计：
 *  - 构造时遍历 configs，跳过 enabled=false 的（TAVILY_WATCH）
 *  - api_key 型 + 有 keys → 创建 QuotaLedger；browse/self_hosted → null（无配额）
 *  - 按 tags[0] 归类到 capability（"search" / "browse" / "desktop"）
 *  - byCapability 内部按 fallback_order 排序（fallback 引擎读到的就是已排好的顺序）
 *
 * 借鉴：08 §3.6 CapabilityBag 自动生成；10 §2.2 三层能力袋。
 */
import type { ProviderConfig, FreeTierLevel } from "../types.js";
import { QuotaLedger } from "./quota-ledger.js";

export type Capability = "search" | "browse" | "desktop";

export interface RegisteredProvider {
  config: ProviderConfig;
  /** browse / self_hosted / 无 key 的 api_key → null（无配额账本） */
  ledger: QuotaLedger | null;
  capability: Capability;
}

const CAPABILITY_TAGS: ReadonlySet<string> = new Set(["search", "browse", "desktop"]);

/** 从 tags[0] 推断 capability，未知则默认 "search"。 */
function classifyCapability(cfg: ProviderConfig): Capability {
  const tag = cfg.tags?.[0];
  if (tag && CAPABILITY_TAGS.has(tag)) return tag as Capability;
  return "search";
}

/**
 * v0.4 M0.4a（parse5 §3.4.3）：get() 可选 policy 过滤参数。
 *
 * 用于 PolicyGate / doctor / interact_* 等调用方按政策风险过滤 provider。
 * 未传 → 行为完全等价 v0.3.5（零回归承诺）。
 */
export interface PolicyFilterOptions {
  /**
   * 排除指定 policy_risk 值的 provider。
   * 例：["acquired"] 排除 Tavily（Nebius 收购完成）；
   *     ["acquired", "watched"] 排除所有非 safe provider。
   */
  excludePolicyRisk?: ProviderConfig["policy_risk"][];
  /**
   * cloud 浏览器 manual-switch：
   *  - undefined / true：不过滤（保留 cloud 浏览器）
   *  - false：排除 tags 含 "cloud" 的 provider（PolicyGate 据此实现 manual-switch）
   */
  allowCloudBrowser?: boolean;
}

export class ProviderRegistry {
  private byName = new Map<string, RegisteredProvider>();
  private byCapability = new Map<Capability, RegisteredProvider[]>();

  constructor(private readonly configs: readonly ProviderConfig[]) {
    for (const c of configs) {
      // INV: enabled=false 的 provider（TAVILY_WATCH）不进注册表
      if (c.enabled === false) continue;

      const cap = classifyCapability(c);
      const ledger =
        c.type === "api_key" && c.keys.length > 0
          ? new QuotaLedger(c.name, c.keys, c.free_quota_per_month, c.quota_model)
          : null;

      const entry: RegisteredProvider = { config: c, ledger, capability: cap };
      this.byName.set(c.name, entry);

      if (!this.byCapability.has(cap)) this.byCapability.set(cap, []);
      this.byCapability.get(cap)!.push(entry);
    }
    // 每个 capability 内按 fallback_order 升序排（主力在前）
    for (const list of this.byCapability.values()) {
      list.sort((a, b) => a.config.fallback_order - b.config.fallback_order);
    }
  }

  /** 所有原始 configs（含 enabled=false 的，doctor 诊断用）。 */
  getAllConfigs(): readonly ProviderConfig[] {
    return this.configs;
  }

  /**
   * 按 provider 名字查（如 "zhipu" / "brave"）。
   *
   * v0.4 M0.4a（parse5 §3.4.3）：加可选 policyFilter 参数。
   *  - 未传 → 行为完全等价 v0.3.5（零回归）
   *  - 传   → 按 policy_risk / cloud 浏览器过滤；不符合的返回 undefined
   *
   * 注意：ProviderRegistry 构造时已跳过 enabled=false 的 provider（如 TAVILY_WATCH）。
   * policyFilter 是在已注册集合上的二次过滤（不重新读 enabled）。
   */
  get(
    name: string,
    policyFilter?: PolicyFilterOptions,
  ): RegisteredProvider | undefined {
    const entry = this.byName.get(name);
    if (!entry) return undefined;
    if (policyFilter) {
      const cfg = entry.config;
      // 排除指定 policy_risk 值
      if (
        policyFilter.excludePolicyRisk &&
        cfg.policy_risk &&
        policyFilter.excludePolicyRisk.includes(cfg.policy_risk)
      ) {
        return undefined;
      }
      // cloud 浏览器 manual-switch 过滤
      if (
        policyFilter.allowCloudBrowser === false &&
        cfg.tags?.includes("cloud")
      ) {
        return undefined;
      }
    }
    return entry;
  }

  /** 取某个 capability 下所有已注册 provider（按 fallback_order 排好序）。 */
  byCap(cap: Capability): RegisteredProvider[] {
    return this.byCapability.get(cap) ?? [];
  }

  /** 所有已注册 provider 的 name 列表（doctor + 测试用）。 */
  listNames(): string[] {
    return Array.from(this.byName.keys());
  }

  /**
   * free_only 四级过滤（F3.1.10）。
   * 返回 search capability 下 free_tier_level ≤ maxLevel 的 provider 列表。
   */
  filterByFreeTier(level: FreeTierLevel): ProviderConfig[] {
    const order: Record<FreeTierLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
    const maxOrd = order[level];
    return this.byCapability
      .get("search")!
      .filter((p) => order[p.config.free_tier_level ?? "L2"] <= maxOrd)
      .map((p) => p.config);
  }
}
