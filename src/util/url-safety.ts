/**
 * URL 基础安全检查（parse1 §2 util/url-safety.ts）
 *
 * 轻量的 URL 解析 + userinfo 防伪 + 协议白名单。
 * 注意：这只是 SSRF 防护的**前置快筛**，**完整的 DNS + CIDR 检查在 src/ssrf/**
 * （Phase B 实装）。这里只挡明显的格式级陷阱，避免在 Phase A 引入 ip-cidr 依赖。
 */

export interface UrlSafetyResult {
  ok: boolean;
  reason: string;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * 检查 URL 的格式级安全性。
 *  - invalid URL         → ok=false reason="invalid_url"
 *  - 含 userinfo（user:pass@host） → ok=false reason="userinfo_present"
 *    （防 evil.com@trusted.com 伪装）
 *  - 非 http/https 协议  → ok=false reason="protocol_not_allowed:<proto>"
 *  - 其他                → ok=true  reason="ok"
 *
 * 不做 DNS lookup / 私网判定（那是 src/ssrf/ssrf-guard.ts 的活儿）。
 */
export function checkUrlSafety(rawUrl: string): UrlSafetyResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "userinfo_present" };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `protocol_not_allowed:${parsed.protocol}` };
  }
  return { ok: true, reason: "ok" };
}
