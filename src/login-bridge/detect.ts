/**
 * detect.ts（v1.31 登录接力档）——cookieDelta 登录检测（方案 §二 C4，纯函数）
 *
 * 语义（F2 裁决 #4）：字段名禁 loginLikely（诱导 agent 终判）——只报
 * cookieDelta 事实（按域新增计数）；噪声 cookie（风控轮换类）过滤；
 * 「登录前就有 cookie 的站」靠**增量**语义天然不误报（基线在 start 时刻快照）。
 * agent 终判（它知道目标站的登录标志位/URL 变化）。
 *
 * INV-64 精神：零 import。
 */

/** CDP cookie 最小面（CdpCookie 结构子集——检测只消费 name/domain）。 */
export interface DetectCookie {
  name: string;
  domain: string;
}

/**
 * 噪声 cookie 名单（增量误报源）：Cloudflare 风控轮换（__cf_bm 每 ~30min 换）、
 * cf_clearance 挑战态、GA 家族、常见营销像素。新增噪声名走本名单单一真源。
 */
export const NOISE_COOKIE_NAMES: ReadonlySet<string> = new Set([
  "__cf_bm",
  "__cfduid",
  "__cfruid",
  "cf_clearance",
  "_ga",
  "_gid",
  "_gat",
  "_gat_gtag",
  "_gat_UA-",
  "__utma",
  "__utmb",
  "__utmz",
  "__utmc",
  "_fbp",
  "_gcl_au",
  "__hstc",
  "hubspotutk",
]);

/** 域名归一（Chrome cookie domain 常带前导点）。 */
export function normalizeDomain(domain: string): string {
  return domain.replace(/^\.+/, "").toLowerCase();
}

/** cookie 稳定键（name@domain——同名跨域计两键）。 */
export function cookieKey(c: DetectCookie): string {
  return `${c.name}@${normalizeDomain(c.domain)}`;
}

/** 是否噪声 cookie（名单精确匹配 + _ga/_gat 测量族前缀匹配）。 */
export function isNoiseCookie(c: DetectCookie): boolean {
  if (NOISE_COOKIE_NAMES.has(c.name)) return true;
  // GA 测量族变体：_ga_XXXX / _gat_XXXX（名单静态值盖不全）
  if (/^_ga_[A-Z0-9]+$/.test(c.name) || /^_gat_[A-Z0-9-]+$/.test(c.name)) return true;
  return false;
}

/** 基线快照（start 时刻）：非噪声 cookie 键集合。 */
export function snapshotCookieKeys(cookies: DetectCookie[]): Set<string> {
  const s = new Set<string>();
  for (const c of cookies) {
    if (isNoiseCookie(c)) continue;
    s.add(cookieKey(c));
  }
  return s;
}

export interface CookieDelta {
  /** 域名 → 该域新增（非噪声）cookie 数。 */
  domains: Record<string, number>;
  /** 新增总数。 */
  totalNew: number;
}

/**
 * 增量 diff：after 中存在而基线快照没有的（非噪声）cookie，按域计数。
 * SSO 多跳天然成立：多个域的新增都会出现在 domains 里，agent 自行关联判断。
 */
export function cookieDelta(before: Set<string>, after: DetectCookie[]): CookieDelta {
  const domains: Record<string, number> = {};
  let totalNew = 0;
  const seen = new Set<string>();
  for (const c of after) {
    if (isNoiseCookie(c)) continue;
    const key = cookieKey(c);
    if (before.has(key) || seen.has(key)) continue;
    seen.add(key);
    const domain = normalizeDomain(c.domain);
    domains[domain] = (domains[domain] ?? 0) + 1;
    totalNew += 1;
  }
  return { domains, totalNew };
}
