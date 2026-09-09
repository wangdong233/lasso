/**
 * file-guard.ts（BUG-05 决议 B，doc/bugs/05 §4 —— L-2 file:// 目录白名单）
 *
 * 消费方事故（novel-engine 台账 L-2）：ssrfGuard 一刀切拦 file://，
 * 本地静态文件测试（单文件 HTML 交付形态）断路。file:// 威胁模型与远程
 * 攻击面不同（本地文件读取 vs 内网元数据探测）——本模块把它从协议白名单
 * 旁路到**目录 opt-in 白名单**（LASSO_ALLOW_FILE_FROM，默认关）。
 *
 * 威胁模型显式化（决议 B2）：白名单收敛的是「agent 经 lasso 可读的本地目录面」
 * ——防 prompt-injected agent 借 file:// + snapshot/extract 把 ~/.ssh 等读进
 * 模型上下文。目录 opt-in 把该面压缩到用户明示子树；与 IP/CIDR allowRanges
 * 机制正交（第三维：路径维）。
 *
 * 🔴 红线（INV-90 锚）：本模块是**入口旁路加法**——ssrfGuard 本体零改动，
 * ALLOWED_PROTOCOLS 恒 {http:, https:}；allowDirs 为空时拒绝 reason 与旧
 * ssrfGuard 输出逐字节相等（`protocol_not_allowed:file:`，默认行为不变）。
 *
 * 七步判定（决议 B1）与绕过面封口（B2 表）：
 *  1. URL 解析失败 → invalid_url
 *  2. 非空 host（UNC/SMB 潜在语义，file://evil.com/x）→ file_url_host_not_allowed
 *     （WHATWG 把 file://localhost 归一为空 host——node 实测锚 §2-5）
 *  3. decodeURIComponent 单次解码（%2E%2E 编码穿越已在 WHATWG 解析期归一；
 *     单次与 Chrome 取路径语义一致，禁双重解码）
 *  4. realpathSync 归一（词法 ../ 与 symlink 逃逸一并消解；macOS /tmp 即
 *     symlink）；ENOENT → file_url_not_found（Chrome 本也会错误页，诚实前置）
 *  5. allowDirs 由装载方 realpath 规范化（dir-allowlist.ts，双侧同规范才可能匹配）
 *  6. path-boundary 子树匹配（isPathInside；/allow 不覆盖 /allowdev）
 *  7. 全条目不命中 → file_not_in_allowlist
 *  大小写变体：realpath 后失配方向=拒（误拒不误放——安全方向）。
 *  TOCTOU（realpath 与 Chrome 打开之间换文件）：接受——单用户本地场景，
 *  与上游 validatePath 同窗（决议 B2 表）。
 *
 * 边界（决议 B1「明确不做」）：本守卫只接 browse_headless / browse_logged_in
 * 两个入口；screenshot/pdf/network/fetch_url/fetch_feed/wayback 等独立工具
 * 保持 http(s)-only。fetch_url 开 file:// = 纯文本任意读，永不由本决议顺带打开。
 */
import { realpathSync } from "node:fs";
import { isPathInside } from "./dir-allowlist.js";
import type { SsrfCheckResult } from "./ssrf-guard.js";

/** 入口路由用：URL 是否 file: 协议（解析失败 → false，交给 ssrfGuard 报 invalid_url）。 */
export function isFileProtocol(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * file:// URL → 目录白名单判定（同步；file:// 无 DNS 面，不经 ssrfGuard）。
 * allowDirs 必须是 loadColonDirAllowlist 产物（已 realpath）；空数组 = 默认拒。
 */
export function checkFileUrl(
  rawUrl: string,
  allowDirs: string[],
): SsrfCheckResult {
  // 空白名单：恒拒，reason 与旧 ssrfGuard 协议白名单输出**逐字节相等**
  // （默认零配置行为不变；INV-90 字节锚）。不走后续步骤——空表无从匹配。
  if (allowDirs.length === 0) {
    return { allowed: false, reason: "protocol_not_allowed:file:", resolvedIps: [] };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid_url", resolvedIps: [] };
  }

  if (parsed.host !== "") {
    return {
      allowed: false,
      reason: `file_url_host_not_allowed:${parsed.host}`,
      resolvedIps: [],
    };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    // 畸形百分号序列（decodeURIComponent 抛 URIError）→ invalid_url
    return { allowed: false, reason: "invalid_url", resolvedIps: [] };
  }

  let real: string;
  try {
    real = realpathSync(decoded);
  } catch {
    return { allowed: false, reason: "file_url_not_found", resolvedIps: [] };
  }

  if (!allowDirs.some((d) => isPathInside(real, d))) {
    return { allowed: false, reason: "file_not_in_allowlist", resolvedIps: [] };
  }
  return { allowed: true, reason: "ok", resolvedIps: [] };
}

/** file: 族拒绝 reason 识别（browse 入口 hint 标注用）。 */
export function isFileGuardReason(reason: string): boolean {
  return (
    reason === "protocol_not_allowed:file:" ||
    reason === "file_not_in_allowlist" ||
    reason === "file_url_not_found" ||
    reason.startsWith("file_url_host_not_allowed:")
  );
}

/**
 * 决议 B3：拒绝 payload 的可选 hint 文案（error 字符串字节不变，hint 是并列
 * 新字段——InteractResult additive，quality/partial_failures 先例）。
 * 返回 undefined = 非 file: 族 reason（不加 hint，非 file 拒绝 byte-identical）。
 */
export function fileGuardHint(
  reason: string,
  allowDirs: string[],
): string | undefined {
  if (!isFileGuardReason(reason)) return undefined;
  if (reason === "protocol_not_allowed:file:") {
    // 白名单空：默认拒 + opt-in 指引
    return "file:// blocked by default; opt-in: LASSO_ALLOW_FILE_FROM='<colon-separated dirs>' (browse_headless/browse_logged_in only)";
  }
  if (reason === "file_not_in_allowlist") {
    return `file:// target outside the ${allowDirs.length} configured LASSO_ALLOW_FILE_FROM dir(s); fix the path or extend LASSO_ALLOW_FILE_FROM`;
  }
  if (reason === "file_url_not_found") {
    return "file:// target does not exist on disk (realpath failed)";
  }
  // file_url_host_not_allowed:<host>
  return "file:// URL with non-empty host (UNC/SMB semantics) is rejected regardless of LASSO_ALLOW_FILE_FROM";
}
