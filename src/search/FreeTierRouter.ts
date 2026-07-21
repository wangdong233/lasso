/**
 * FreeTierRouter —— free_only 四级分级路由（parse2 §3.3.3 / F3.1.10 + 10 §2.5）。
 *
 * 用户在 tool args 或 env LASSO_SEARCH_FREE_ONLY 传：
 *  - L1：只允许完全免费零 Key（DDG/SearXNG 自建）— v0.2 暂无 L1 provider，返回空
 *  - L2：允许免费层需 Key（Brave 2000/月、智谱、Tavily）
 *  - L3：再加远程 URL 免 Key（Exa、Jina read_url）— v0.2 暂无
 *  - L4：再加付费（默认，全允许）
 *
 * 10 §2.5 核心洞察：免 Key ≠ 零成本（SearXNG 要自建），需 Key ≠ 付费（Brave/Exa 有免费层）。
 *
 * 设计：与 ProviderRegistry.filterByFreeTier 平行——后者是注册表实例方法（含已排序的
 * byCapability），本函数是纯函数版（接受任意 ProviderConfig[]）。这样 tools/search.ts
 * 可以在 cache 层 / test fixture 中独立调用，不强耦合 ProviderRegistry 实例。
 *
 * 借鉴：parse2 §3.3.3；10 §2.5 四级分级定义。
 */
import type { FreeTierLevel, ProviderConfig } from "../types.js";

const LEVEL_ORDER: Record<FreeTierLevel, number> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

/**
 * 过滤 providers：保留 free_tier_level ≤ maxLevel 的。
 * 未指定 free_tier_level 的 provider 默认视为 L2（parse2 §3.1.1 默认推断）。
 *
 * 不变性：
 *  - 输入数组不被修改（pure filter）
 *  - 未知 level 字符串（不属 L1/L2/L3/L4）按 L2 处理（不抛错，保持简单）
 */
export function filterByFreeTier(
  providers: readonly ProviderConfig[],
  maxLevel: FreeTierLevel,
): ProviderConfig[] {
  const maxOrd = LEVEL_ORDER[maxLevel];
  return providers.filter((p) => {
    const raw = p.free_tier_level ?? "L2";
    const ord = LEVEL_ORDER[raw] ?? LEVEL_ORDER.L2;
    return ord <= maxOrd;
  });
}

/**
 * 把 L1/L2/L3/L4 字符串映射到数字序（测试 + doctor 显示用）。
 * 未知值降级 L2。
 */
export function freeTierOrder(level: FreeTierLevel): number {
  return LEVEL_ORDER[level] ?? LEVEL_ORDER.L2;
}
