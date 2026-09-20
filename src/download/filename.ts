/**
 * filename.ts（doc/bugs/12 下载器批——D12/H5 落盘面守卫，WT-core）
 *
 * 两道写前闸（红队 H5/H8 落点；把「引擎往哪写、写什么名」从引擎自由度收窄
 * 到 lasso 可背书面）：
 *  1. resolveFilename：filename 强制 basename——null 透传（引擎自命名档）；
 *     含 `/`（或 `\` 跨平台防御）或 `..` 段 → 抛 filename_must_be_basename
 *     （didnt 档显式错误，不猜）。其余 path.basename() 归一防御（理论上已是
 *     basename，仍走一遍——纵深，非冗余）。
 *  2. assertOutDirAllowed：out_dir 白名单——dir-allowlist 模板直译（BUG-05
 *     决议 B1/B2：realpath 双侧 + path-boundary 子树匹配，禁朴素字符串前缀）。
 *     默认白名单 = ~/Downloads + env LASSO_DOWNLOAD_DIR_ALLOWLIST（冒号分隔，
 *     POSIX 路径名禁冒号——与 LASSO_ALLOW_FILE_FROM 同一选型逻辑）追加。
 */
import { realpathSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";
import { loadColonDirAllowlist, isPathInside, type DirAllowlistResult } from "../ssrf/dir-allowlist.js";

/** env 名单一源（types.ts 未收——D12 落盘面常量归本文件）。 */
export const DOWNLOAD_DIR_ALLOWLIST_ENV = "LASSO_DOWNLOAD_DIR_ALLOWLIST";

// ============================================================
// resolveFilename（D12/H5：basename 强制）
// ============================================================
/** filename 违例错误（显式错误码；types.ts ResolveFilenameFn 契约锚）。 */
export class FilenameNotBasenameError extends Error {
  readonly code = "filename_must_be_basename";
  constructor(filename: string) {
    super(
      `filename_must_be_basename: ${JSON.stringify(filename)} 含路径分隔符或 .. 段（D12/H5：只允许纯文件名）`,
    );
    this.name = "FilenameNotBasenameError";
  }
}

/**
 * filename 归一（types.ts ResolveFilenameFn 契约实现）：
 *  - null/undefined → null（引擎自命名档，语义与契约字段注释一致）；
 *  - 含 `/` 或 `\`（任一平台的路径分隔）→ 抛；
 *  - 分段含 `..`（无分隔符时即整名 === ".."）→ 抛；
 *  - 其余 path.basename() 归一透传（防御：即便调用方传了裸名也走一遍）。
 */
export function resolveFilename(filename: string | null | undefined): string | null {
  if (filename === null || filename === undefined) return null;
  if (filename.includes("/") || filename.includes("\\")) {
    throw new FilenameNotBasenameError(filename);
  }
  // 段级判定：分隔符已拒，段集 = { filename }；只拒整段 ".."（"a..b" 是合法名）
  if (filename === "..") {
    throw new FilenameNotBasenameError(filename);
  }
  return path.basename(filename);
}

// ============================================================
// out_dir 白名单（D12：dir-allowlist 模板）
// ============================================================
/**
 * 装载默认 out_dir 白名单：~/Downloads（realpath 归一；不存在 → dropped 可见，
 * 绝不静默含糊）+ env LASSO_DOWNLOAD_DIR_ALLOWLIST 冒号分隔追加。
 * 复用 loadColonDirAllowlist（dropped 清单纪律 doctor 可查——单一真源）。
 */
export function loadDefaultOutDirAllowlist(): DirAllowlistResult {
  const defaults = [path.join(os.homedir(), "Downloads")];
  const envExtra = process.env[DOWNLOAD_DIR_ALLOWLIST_ENV] ?? "";
  // 两段拼接后过同一 realpath 装载器：默认段与 env 段同一容错语义
  return loadColonDirAllowlist([...defaults, ...envExtra.split(":")].join(":"));
}

/** out_dir 违例错误（显式错误码）。 */
export class OutDirNotAllowedError extends Error {
  readonly code = "out_dir_not_allowed";
  constructor(outDir: string, detail: string) {
    super(`out_dir_not_allowed: ${JSON.stringify(outDir)} ${detail}`);
    this.name = "OutDirNotAllowedError";
  }
}

/**
 * out_dir 白名单断言（realpath 双侧 + path-boundary 子树匹配）：
 *  - outDir realpath 失败（不存在 / 不可达）→ 抛（fail-closed：无法规范化的
 *    路径不进白名单判定——调用方须先 mkdir 再断言）；
 *  - 任一白名单条目 isPathInside 命中 → 通过（返回 realpath 后的 outDir，
 *    任务表 outDir 字段的规范化来源）；
 *  - 全不命中 → 抛 out_dir_not_allowed。
 */
export function assertOutDirAllowed(outDir: string, allowlist: string[]): string {
  let real: string;
  try {
    real = realpathSync(outDir);
  } catch {
    throw new OutDirNotAllowedError(outDir, "（目录不存在或不可解析——先 mkdir 再断言）");
  }
  for (const dir of allowlist) {
    if (isPathInside(real, dir)) return real;
  }
  throw new OutDirNotAllowedError(outDir, `（不在白名单内：${allowlist.join(" : ")}）`);
}
