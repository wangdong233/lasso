/**
 * SSRF 守门（parse1 §3.10 ssrf-guard.ts + §4.3）
 *
 * 完整流程：
 *  1. URL 解析               → 失败：invalid_url
 *  2. userinfo 防伪          → evil.com@trusted.com 伪装拦截
 *  3. 协议白名单             → 只放 http/https
 *  4. fresh DNS lookup all   → 防 DNS rebind（不缓存）
 *  5. 逐 IP 判定：
 *      a. 命中 denyRanges        → 拒（最高优先级）
 *      b. 命中 PRIVATE_RANGES
 *         且不在 effectiveAllow  → 拒
 *  6. 全部 IP 通过 → allowed=true
 *
 * effectiveAllow = DEFAULT_ALLOW_RANGES + 用户 env allowRanges。
 *
 * 关键设计（不变量级）：
 *  - 默认拒：私网必须显式 allow 才放行（不是默认 allow 私网）
 *  - 拒优先于 allow：同一 IP 若同时在 deny 和 allow，按 deny
 *  - DNS 必须 fresh：navigation 前现查，防 rebind；subresource 缓存 v0.3 加
 *  - userinfo / 协议在 DNS 前快速失败，省一次网络往返
 */
import { lookup } from "node:dns/promises";
import { cidrContains, isPrivateIp } from "./cidr.js";
import { DEFAULT_ALLOW_RANGES, PRIVATE_RANGES } from "./defaults.js";

// ============================================================
// 配置类型
// ============================================================
export interface SsrfConfig {
  /** 用户 env 提供的额外 allow 段（与 DEFAULT_ALLOW_RANGES 合并）。 */
  allowRanges: string[];
  /** 显式拒段（优先级最高，覆盖 allow）。 */
  denyRanges: string[];
}

export interface SsrfCheckResult {
  allowed: boolean;
  reason: string;
  /** DNS 实际解析出的 IP 列表（便于日志/调试；失败时为空）。 */
  resolvedIps: string[];
}

// ============================================================
// v1.18.2（doc/governance/10 F1）：SSRF 拒绝 reason 二分 —— 策略确定性 vs 环境瞬态
// ============================================================
/**
 * 「环境瞬态」reason：DNS 解析不出来（dns_failed / dns_empty）。
 *
 * 这是**环境条件**（TUN 断网、DNS 间歇抖动、captive portal——单用户本地部署
 * 的高频真实场景），不是策略判决。守卫无法区分「域名真不存在」与「此刻
 * 解析器不可用」，而误判成策略拦截会把可重试的瞬态变成终答「明确否」
 * （得到全量首跑 104 章 DNS 间歇失败实证）。
 */
export function isSsrfEnvTransientReason(reason: string): boolean {
  return reason === "dns_empty" || reason.startsWith("dns_failed");
}

/**
 * 把一次 SSRF 拒绝映射为 tri-state 语义（9 个消费工具共用，禁各自手搓）：
 *  - 策略确定性（invalid_url / userinfo_present / protocol / deny_range / private_ip）
 *    → outcome=didnt（真策略拦截，不可重试）
 *  - 环境瞬态（dns_failed / dns_empty）
 *    → outcome=unknown（可重试；CC 可择机重试，fallback 语义畅通）
 *
 * retrieval_method 相应区分 ssrf_blocked / ssrf_dns_unresolved。
 */
export function ssrfDenial(reason: string): {
  outcome: "didnt" | "unknown";
  retrieval_method: "ssrf_blocked" | "ssrf_dns_unresolved";
  error: string;
} {
  if (isSsrfEnvTransientReason(reason)) {
    return {
      outcome: "unknown",
      retrieval_method: "ssrf_dns_unresolved",
      error: `ssrf_dns_unresolved:${reason}`,
    };
  }
  return {
    outcome: "didnt",
    retrieval_method: "ssrf_blocked",
    error: `ssrf_blocked:${reason}`,
  };
}

// ============================================================
// 主检查
// ============================================================
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * 对一个 rawUrl 做 SSRF 全量检查。
 * 不抛错——所有失败路径都返回 `{ allowed: false, reason, resolvedIps }`。
 */
export async function ssrfGuard(
  rawUrl: string,
  config: SsrfConfig,
): Promise<SsrfCheckResult> {
  // 1. URL 解析
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid_url", resolvedIps: [] };
  }

  // 2. userinfo 防伪（evil.com@trusted.com）
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: "userinfo_present", resolvedIps: [] };
  }

  // 3. 协议白名单
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      allowed: false,
      reason: `protocol_not_allowed:${parsed.protocol}`,
      resolvedIps: [],
    };
  }

  // 4. fresh DNS lookup（all records，不缓存）
  // ft-round1（FT-DEF-3）：IPv6 字面量 URL 的 parsed.hostname 带方括号（Node 24 实测
  // `new URL("http://[::1]:80/").hostname === "[::1]"`）。带括号串不是合法 IP 字面量：
  // ① 直连环境 lookup 抛错 → dns_failed（误拒非私网判定路径）；② TUN fake-ip 环境
  // （ClashX 198.18.0.0/15）把它当域名解析成 fake-ip → 命中 DEFAULT_ALLOW_RANGES →
  // **IPv6 loopback/ULA/IPv4-mapped 全部绕过**（真机实测 ALLOWED）。修复：lookup 前
  // 剥括号——剥后 "::1" 被 node:dns 识别为字面量直接返回，进 isPrivateIp → 拒。
  const hostname = parsed.hostname.replace(/^\[(.+)\]$/, "$1");
  let records: { address: string }[];
  try {
    records = await lookup(hostname, { all: true });
  } catch (e) {
    return {
      allowed: false,
      reason: `dns_failed:${(e as Error).message}`,
      resolvedIps: [],
    };
  }
  // lookup({all:true}) 在某些平台上 IPv6 缺失会返回 []，统一兜底拒
  if (records.length === 0) {
    return {
      allowed: false,
      reason: "dns_empty",
      resolvedIps: [],
    };
  }
  const ips = records.map((r) => r.address);

  // 5. 逐 IP 检查
  const effectiveAllow = [...DEFAULT_ALLOW_RANGES, ...config.allowRanges];

  for (const ip of ips) {
    // 5a. deny 优先
    if (config.denyRanges.some((cidr) => cidrContains(cidr, ip))) {
      return { allowed: false, reason: `deny_range:${ip}`, resolvedIps: ips };
    }
    // 5b. 私网 + 未 allow
    if (
      isPrivateIp(ip, PRIVATE_RANGES) &&
      !effectiveAllow.some((cidr) => cidrContains(cidr, ip))
    ) {
      return { allowed: false, reason: `private_ip:${ip}`, resolvedIps: ips };
    }
  }

  return { allowed: true, reason: "ok", resolvedIps: ips };
}

// ============================================================
// env → SsrfConfig
// ============================================================
/**
 * 从 process.env 读 LASSO_SSRF_ALLOW_RANGES / LASSO_SSRF_DENY_RANGES。
 *  - 格式：CSV，"10.0.0.0/8,172.16.0.0/12"
 *  - 缺失 / 空串 → 空数组（DEFAULT_ALLOW_RANGES 永远生效，见 ssrfGuard）
 *  - 非法 CIDR 不在加载时校验（留给 cidrContains 的 try/catch 兜底，保持启动健壮）
 */
export function loadSsrfConfig(env: NodeJS.ProcessEnv = process.env): SsrfConfig {
  const csv = (v: string | undefined): string[] =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    allowRanges: csv(env.LASSO_SSRF_ALLOW_RANGES),
    denyRanges: csv(env.LASSO_SSRF_DENY_RANGES),
  };
}
