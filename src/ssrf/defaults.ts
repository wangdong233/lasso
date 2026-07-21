/**
 * SSRF 默认 CIDR 表（parse1 §3.10 + §4.3）
 *
 *  - PRIVATE_RANGES        : 默认拒（私有 / 保留 / loopback / link-local /
 *                             ULA / non-global IPv6）。命中且不在 allowlist 即拒。
 *  - DEFAULT_ALLOW_RANGES  : 写死的逃生口，不依赖 env。命中即放行。
 *     · 198.18.0.0/15  —— RFC 2544 benchmarking 段；Surge/Clash/Mihomo TUN
 *                        fake-ip 默认段。用户 MEMORY 直接命中
 *                        （"push 走 HTTPS 因代理 fake-ip 拦 SSH"）。
 *     · 127.0.0.1/32   —— browse_logged_in 连本机 CDP :9222 必须放行。
 *
 * 设计注记：198.18.0.0/15 当前**不在** PRIVATE_RANGES（parse1 §3.10 原文），
 * 因此它的 DEFAULT_ALLOW_RANGES 条目现阶段是冗余的防御深度；若未来把该段
 * 加入 PRIVATE_RANGES（符合多数 SSRF hardening 指南），allow 条目立即生效。
 * 127.0.0.1/32 则是真正的 load-bearing：127.0.0.0/8 整段私有，只有 /32
 * 被放行，所以 127.0.0.2/127.1.2.3 等会被拒。
 *
 * 用户扩展路径：env `LASSO_SSRF_ALLOW_RANGES="a,b,c"` → loadSsrfConfig() 合并。
 */

/** 默认拒的私网/保留段（IPv4 + IPv6）。 */
export const PRIVATE_RANGES = [
  // IPv4
  "10.0.0.0/8", // RFC 1918 private
  "172.16.0.0/12", // RFC 1918 private
  "192.168.0.0/16", // RFC 1918 private
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local
  "100.64.0.0/10", // CGNAT (RFC 6598)
  "0.0.0.0/8", // "this network"
  // IPv6
  "fc00::/7", // ULA
  "fe80::/10", // link-local
  "::1/128", // loopback
] as const;

/**
 * 写死的默认 allowlist。和用户的 env allowRanges 合并（env 可扩展但不能缩小）。
 *  - 198.18.0.0/15 : fake-ip 段（代理 TUN 场景）
 *  - 127.0.0.1/32  : 本机 CDP :9222（browse_logged_in 唯一的 localhost 入口）
 */
export const DEFAULT_ALLOW_RANGES = [
  "198.18.0.0/15",
  "127.0.0.1/32",
] as const;
