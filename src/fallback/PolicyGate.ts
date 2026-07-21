/**
 * PolicyGate（parse5 §3.4，F3.4.6 政策风险 gate）
 *
 * 政策风险 gate —— cloud 浏览器通道必经 manual-switch + provider policy_risk 过滤。
 *
 * 三条规则（parse5 §3.4.1）：
 *  1. cloud 浏览器通道（channel 名 `browse_cloud_*`）必经：
 *     - `LASSO_ALLOW_CLOUD_BROWSER=true`（manual-switch 显式 opt-in）**AND**
 *     - 对应 provider keys.length > 0（API key 已配置，双重解锁）
 *     任一不满足 → 该 channel 被 filter（policy_blocked）
 *  2. provider `policy_risk="acquired"`（如 Tavily 收购完成）→ **禁用**（doctor fail）
 *  3. provider `policy_risk="watched"`（收购观察期）+ 未配 watch flag → warn skip
 *     若用户显式设 `LASSO_TAVILY_WATCH=true` → 放行（用户已知风险）
 *
 * 接入点（parse5 §3.4.2）：FallbackDecider.runWithFallback 前置可选注入；
 *   未注入 → runWithFallback 行为完全等价 v0.3.5（零回归承诺）；
 *   注入   → 每个 channel 先 PolicyGate.check，policy_blocked 的被跳过；
 *            全部 channel 被 filter → outcome="didnt" + retrieval_method="policy_blocked"。
 *
 * 关键铁律（parse5 §3.4.1，借鉴 Argus manual-switch 范式）：
 *  - 政策风险不替用户判断 ToS 合规（永远是 doctor warn + manual-switch，不做自动绕过）
 *  - env 直读只在 PolicyGate 构造期（装配时由 index.ts 从 process.env 读一次传入）；
 *    runtime 不读 process.env，防 LLM 通过 channel 改 env 绕过（anti-gaming，类比 INV-14）
 *  - PolicyGate 不感知 channel 实例（只接 channel 名 + ProviderConfig 数据）
 *
 * INV-25（parse5 §2.3）：cloud 浏览器通道必经 manual-switch
 *   （grep PolicyGate.ts 必须出现 LASSO_ALLOW_CLOUD_BROWSER 字面量 +
 *    ProviderConfig.policy_risk 三态字段）。
 */
import type { ProviderConfig } from "../types.js";

// ============================================================
// 类型
// ============================================================
/**
 * PolicyGate 环境快照（构造期注入，runtime 不读 env）。
 *
 * 字段语义：
 *  - allowCloudBrowser : 来自 LASSO_ALLOW_CLOUD_BROWSER=true（cloud 浏览器总开关）
 *  - tavilyWatch       : 来自 LASSO_TAVILY_WATCH=true（Tavily 观察期 opt-in）
 *  - cloudBrowserKeys  : 已配置 API key 的 cloud 浏览器 provider 名集合
 *                        （如 new Set(["browserbase", "stagehand"])）
 */
export interface PolicyGateEnv {
  allowCloudBrowser?: boolean;
  tavilyWatch?: boolean;
  /** 已配置 API key 的 provider 名集合（cloud 浏览器双重解锁用）。 */
  cloudBrowserKeys?: ReadonlySet<string>;
}

/**
 * PolicyGate 查询句柄（最小接口；解耦 ProviderRegistry）。
 *
 * 实际注入的是 ProviderRegistry 实例（结构子类型），测试可 mock。
 */
export interface PolicyGateRegistry {
  /** 按 provider 名查（如 "browserbase" / "tavily"）。 */
  get: (name: string) => { config: ProviderConfig } | undefined;
}

/** PolicyGate 判决结果。 */
export interface PolicyGateVerdict {
  /** true=放行；false=该 channel 被 policy gate 阻断 */
  allowed: boolean;
  /** 阻断原因（allowed=false 时必填，audit log 用） */
  reason?: string;
}

// ============================================================
// PolicyGate
// ============================================================
/**
 * 政策风险 gate（parse5 §3.4.1）。
 *
 * 无状态：所有判断基于构造期注入的 env 快照 + registry 引用。
 * 可安全在 FallbackDecider / InteractDispatcher / doctor 多处共享同一实例。
 */
export class PolicyGate {
  constructor(
    private readonly env: PolicyGateEnv,
    private readonly registry: PolicyGateRegistry,
  ) {}

  /**
   * 检查单个 channel 是否政策合规（parse5 §3.4.1 + task #2 签名）。
   *
   * @param channelName  channel 名（如 "browse_cloud_browserbase" / "search.tavily"）
   * @param _action      预留 action 字段（v0.4 不区分 action；保留以兼容未来更细粒度政策）
   * @returns {allowed: true} 放行 / {allowed: false, reason} 阻断
   *
   * INV-25：cloud 浏览器通道（browse_cloud_*）必经 manual-switch + API key 双重解锁。
   *
   * 规则优先级（前条命中即返回）：
   *  1. cloud 浏览器（browse_cloud_*）：
   *     - manual-switch 关 → blocked
   *     - manual-switch 开 + API key 缺 → blocked（双重解锁）
   *     - manual-switch 开 + API key 配 + provider policy_risk="acquired" → blocked
   *     - manual-switch 开 + API key 配 + 其他（含 watched） → 放行
   *       （manual-switch 已是显式 opt-in，不再要求 tavilyWatch 双重 opt-in）
   *  2. 非 cloud provider policy_risk 检查：
   *     - policy_risk="acquired" → blocked
   *     - policy_risk="watched" + 未配 tavilyWatch → blocked（Tavily 范式）
   *     - 其他（safe / watched+tavilyWatch=true / 未注册） → 放行
   */
  check(channelName: string, _action?: string): PolicyGateVerdict {
    // ===== 规则 1：cloud 浏览器通道双重解锁 =====
    if (channelName.startsWith("browse_cloud_")) {
      // 1a. manual-switch：LASSO_ALLOW_CLOUD_BROWSER=true
      if (!this.env.allowCloudBrowser) {
        return {
          allowed: false,
          reason: "cloud_browser_requires_manual_switch:LASSO_ALLOW_CLOUD_BROWSER",
        };
      }
      // 1b. API key 双重：对应 provider 必须在 cloudBrowserKeys 集合中
      //     （channel 名 "browse_cloud_browserbase" → provider 名 "browserbase"）
      const cloudProviderName = channelName.replace(/^browse_cloud_/, "");
      const hasKey =
        this.env.cloudBrowserKeys?.has(cloudProviderName) ?? false;
      if (!hasKey) {
        return {
          allowed: false,
          reason: `cloud_browser_missing_api_key:${cloudProviderName}`,
        };
      }
      // 1c. cloud 浏览器通过了双重解锁；仍检查 acquired（收购完成 = 永久 blocked）
      //     但 watched 不再要求 tavilyWatch（manual-switch 已是 opt-in）
      const cloudProv = this.registry.get(cloudProviderName);
      if (cloudProv?.config.policy_risk === "acquired") {
        return {
          allowed: false,
          reason: `policy_risk_acquired:${cloudProviderName}`,
        };
      }
      // cloud 浏览器双重解锁 + 非 acquired → 放行
      return { allowed: true };
    }

    // ===== 规则 2 & 3：非 cloud provider policy_risk 检查 =====
    // channel 名 → provider 名反查（剥前缀）
    const providerName = toProviderName(channelName);
    const prov = this.registry.get(providerName);
    if (prov) {
      // 规则 2：policy_risk="acquired" → 禁用
      if (prov.config.policy_risk === "acquired") {
        return {
          allowed: false,
          reason: `policy_risk_acquired:${providerName}`,
        };
      }
      // 规则 3：policy_risk="watched" + 未配 watch flag → warn skip（视作阻断）
      if (prov.config.policy_risk === "watched" && !this.env.tavilyWatch) {
        return {
          allowed: false,
          reason: `policy_risk_watched_requires_opt_in:${providerName}`,
        };
      }
    }

    // 全部通过
    return { allowed: true };
  }

  /**
   * 批量检查 fallback plan（parse5 §3.4.1 原始批量 API）。
   *
   * 保留此方法是为了与 parse5 §3.4.1 文档签名对齐（部分调用方可能希望一次性过滤）；
   * FallbackDecider 内部走 `check(channel)` 单档 API（task #3 要求"每个 provider 先 PolicyGate.check"）。
   *
   * @returns allowed=true 至少 1 个 channel 放行；filtered=被阻断的 channel 清单
   */
  checkPlan(plan: {
    primary: string;
    fallbacks: string[];
  }): { allowed: boolean; filtered: string[] } {
    const all = [plan.primary, ...plan.fallbacks];
    const filtered: string[] = [];
    for (const ch of all) {
      const verdict = this.check(ch);
      if (!verdict.allowed) filtered.push(ch);
    }
    return {
      allowed: filtered.length < all.length,
      filtered,
    };
  }
}

// ============================================================
// 工具
// ============================================================
/**
 * channel 名 → provider 名反查（剥 channel 类型前缀）。
 *
 *   "browse_cloud_browserbase" → "browserbase"
 *   "browse_cloud_stagehand"   → "stagehand"
 *   "search.tavily"            → "tavily"
 *   "browse_headless"          → "browse_headless"（无前缀可剥，原样返回）
 *   "desktop.ax"               → "desktop.ax"
 *
 * 注：本函数不依赖 provider 注册表，纯字符串变换（无副作用）。
 */
export function toProviderName(channelName: string): string {
  return channelName
    .replace(/^browse_cloud_/, "")
    .replace(/^search\./, "")
    .replace(/^browse\./, "");
}
