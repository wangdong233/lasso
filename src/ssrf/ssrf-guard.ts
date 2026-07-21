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
  let records: { address: string }[];
  try {
    records = await lookup(parsed.hostname, { all: true });
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
