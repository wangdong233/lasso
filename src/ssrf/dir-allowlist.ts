/**
 * dir-allowlist.ts（BUG-05 决议 B/E 共享底座，doc/bugs/05 §4 + §6-E）
 *
 * 两个 opt-in 目录白名单的共享装载与匹配逻辑：
 *  - LASSO_ALLOW_FILE_FROM（决议 B：file:// 读面白名单，browse 两工具入口）
 *  - LASSO_SCREENSHOT_DIR（决议 E：options.screenshot.filePath 写根，doScreenshot）
 *
 * 设计（决议 B1/B2，🔴 红线：白名单必须是加法且 opt-in，默认行为不变）：
 *  - 分隔符 = 冒号（POSIX 路径名禁冒号——NUL 与 `/` 之外唯一禁字符；路径可含逗号）。
 *    与 LASSO_SSRF_ALLOW_RANGES 的 CSV（CIDR 不含逗号）是同一选型逻辑，不可互换。
 *  - 装载时逐条 realpathSync 规范化（macOS /tmp → /private/tmp 符号链接归一——
 *    白名单双侧必须 realpath 才可能匹配，doc/bugs/05 §2-5 实测锚）。
 *  - 不存在 / 不可解析的条目**丢弃并记 dropped 清单**（doctor 降级可见），
 *    绝不静默含糊（「空输出≠空属性」同族纪律）。
 *  - 匹配 = path-boundary 子树匹配（path-is-inside 语义）：
 *    `p === dir || p.startsWith(dir + path.sep)`。禁朴素字符串前缀
 *    （/allow 不得覆盖 /allowdev——决议 B2 绕过面表「前缀伪造」行）。
 */
import { realpathSync } from "node:fs";
import * as path from "node:path";

export interface DirAllowlistResult {
  /** realpath 规范化后的有效目录（仅实际存在条目）。 */
  dirs: string[];
  /** 装载时被丢弃的条目原样（不存在 / realpath 不可解析；doctor 降级可见）。 */
  dropped: string[];
}

/**
 * 冒号分隔目录 env → realpath 规范化白名单。
 * 空串 / 纯空白条目过滤；不存在条目进 dropped（不进 dirs）。
 */
export function loadColonDirAllowlist(
  envValue: string | undefined,
): DirAllowlistResult {
  const raw = (envValue ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  const dirs: string[] = [];
  const dropped: string[] = [];
  for (const entry of raw) {
    try {
      dirs.push(realpathSync(entry));
    } catch {
      dropped.push(entry);
    }
  }
  return { dirs, dropped };
}

/**
 * path-boundary 子树匹配（决议 B1 第 6 步；path-is-inside.js 边界语义）。
 * 两侧都应是已 realpath 规范化的绝对路径（loadColonDirAllowlist / realpathSync 产物）。
 */
export function isPathInside(p: string, dir: string): boolean {
  const d =
    dir.endsWith(path.sep) && dir !== path.sep ? dir.slice(0, -1) : dir;
  if (p === d) return true;
  if (d === path.sep) return p.startsWith(path.sep);
  return p.startsWith(d + path.sep);
}
