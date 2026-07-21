/**
 * content-type-router（parse6 §3.5 v0.5 新增，fetch_url 专用）
 *
 * HTTP response content-type → 解码策略分流。决定 fetch_url 的 body 走：
 *  - html   → 原样文本（与 browse_headless 渲染后 DOM 不同，fetch_url 给的是原始字节）
 *  - text   → 原样文本（text/plain / css / csv / xml / javascript）
 *  - json   → 原样文本（application/json；CC 自行 JSON.parse）
 *  - binary → base64 编码后当文本（image/* / video/* / font/* / octet-stream / pdf）
 *
 * 守 R-CI-02（02 §5.5）：禁新造第二套 HTTP 解析范式；本 router 仅服务 fetch_url（browse 通道
 * 走 chrome-devtools-mcp 自带 DOM 解析，不经此 router）。
 *
 * 守简单性（02 §6.3 review 三问）：
 *  - 不引入第二套做法：复用既有「Map<RegExp, kind>」单维度查表风格（类比 HighRiskGate /
 *    StealthProfiles 的顶级 const 模式）
 *  - 暴露 what（content-type → kind）不暴露 how（不做解码；解码在 fetch-url.ts 里用
 *    TextDecoder / Buffer.toString("base64") 完成）
 *  - 不被 caller 拉扯：routeContentType 是纯函数，无副作用，无状态
 *
 * 借鉴：08 §5.2 + 13 §0；mime 类型分类参考 Apache mime.types 主流分组。
 */

// ============================================================
// 类型
// ============================================================
export type ContentKind = "html" | "text" | "json" | "binary";

export interface ContentRoute {
  kind: ContentKind;
  /** binary 时给具体 subtype（如 "png" / "pdf" / "octet-stream"）；其他 kind 不填 */
  subtype?: string;
}

// ============================================================
// 路由表（顶级 const，parse6 §3.5；类比 INV-14/27/30 anti-gaming 模式）
// ============================================================
/**
 * 顺序敏感：先匹配的先生效。html/json 优先级高于 text。
 *
 * 不变量：禁 if-else 链；新增类型只追加 entry（守 R-CI-02 + R-CHG-01）。
 */
const ROUTING_TABLE: ReadonlyArray<{ pattern: RegExp; kind: ContentKind }> = [
  // html（含 XHTML）
  { pattern: /^text\/html\b/, kind: "html" },
  { pattern: /^application\/xhtml\+xml\b/, kind: "html" },
  // json（application/json + 各种 +json 后缀）
  { pattern: /^application\/json\b/, kind: "json" },
  { pattern: /\+json\b/, kind: "json" },
  // text 主流子类型
  {
    pattern: /^text\/(plain|css|javascript|csv|markdown|xml|tab-separated-values)\b/,
    kind: "text",
  },
  { pattern: /^application\/xml\b/, kind: "text" },
  { pattern: /^application\/(javascript|ecmascript)\b/, kind: "text" },
  { pattern: /^application\/x-www-form-urlencoded\b/, kind: "text" },
];

// ============================================================
// 主路由函数
// ============================================================
/**
 * 把 HTTP `Content-Type` header 值映射到 {kind, subtype?}。
 *
 * @param contentType Content-Type header 原始值（如 "text/html; charset=utf-8"）；
 *                    允许空串 / undefined → 默认 application/octet-stream → binary
 */
export function routeContentType(contentType: string | null | undefined): ContentRoute {
  // 取分号前的主类型（去 charset 等 parameter）；空 → octet-stream 兜底
  const raw = (contentType ?? "application/octet-stream").toLowerCase();
  const ct = raw.split(";")[0]!.trim() || "application/octet-stream";

  for (const r of ROUTING_TABLE) {
    if (r.pattern.test(ct)) return { kind: r.kind };
  }

  // 其余一律 binary（image/* / video/* / audio/* / font/* / application/octet-stream /
  // application/pdf / application/zip / ...）
  // subtype 取 "application/<subtype>" 的 <subtype> 部分（去 +xml 后缀）；
  // 形如 "image/png" → "png"；"application/vnd.foo+json" 上面已命中 json，不会落到这里。
  const subtype = ct.split("/")[1]?.split("+")[0] ?? "octet-stream";
  return { kind: "binary", subtype };
}
