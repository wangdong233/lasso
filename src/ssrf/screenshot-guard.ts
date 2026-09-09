/**
 * screenshot-guard.ts（BUG-05 决议 E，doc/bugs/05 §6-E —— options.screenshot.filePath 写根约束）
 *
 * 问题定性（决议 E0，live 双证）：options.screenshot.filePath 全链零路径约束——
 * doScreenshot 的 target 任意取值 + mkdir recursive best-effort 造父目录 +
 * 三条写路径直写（上游兑现 filePath / image-block base64 解码 / ≥2MB 上游
 * 临时文件物化）；上游 1.7.0 validatePath 因未协商 roots 拒一切 filePath →
 * 恒走「不带 filePath 重试」→ 实际写者几乎总是 lasso 自己的 writeFile。
 * 暴露面：prompt-injected agent 可让 lasso 覆写任意可写路径（~/.zshrc 类）。
 *
 * 形态（决议 E1，🔴 红线对齐 E3）：env LASSO_SCREENSHOT_DIR 冒号分隔写根
 * 目录列表，默认空=关（加法·opt-in）。默认（无 env）唯一行为变化 = 显式
 * filePath 从「任意路径写盘」**收紧为拒**——这是收窄暴露面，不是削弱守卫；
 * 依赖默认管理路径的调用方零感知（byte-identical）。拒时**绝不静默回退**
 * 随机 /tmp 名（把错误输入伪装成成功比拒绝更糟——「空输出≠空属性」同族）。
 *
 * 判定 = 双重 containment（决议 E1 第 3 步，绕过面同决议 B2 表）：
 *  1. path.resolve 词法归一后 path-boundary 匹配（封 ../ 词法穿越 +
 *     前缀伪造 /allow vs /allowdev）
 *  2. 最近存在祖先（父目录可不存在——向上取最近存在者）realpath 后边界
 *     匹配（封 symlink 逃逸；双侧 realpath——macOS /tmp→/private/tmp 类
 *     前缀归一，dir-allowlist.ts 同纪律）
 *  大小写变体：realpath 后失配即拒（误拒不误放——安全方向）。
 *  TOCTOU（realpath 与写盘之间换文件）：接受——单用户本地场景，与上游
 *  validatePath 同窗（决议 E2）。
 */
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { isPathInside, loadColonDirAllowlist } from "./dir-allowlist.js";

export interface ScreenshotWriteRoots {
  /** realpath 规范化后的有效写根（仅存在条目）。 */
  roots: string[];
  /** 装载时被丢弃的条目原样（doctor 降级可见）。 */
  dropped: string[];
}

/** LASSO_SCREENSHOT_DIR → 写根白名单（与 LASSO_ALLOW_FILE_FROM 同装载纪律）。 */
export function loadScreenshotWriteRoots(
  env: NodeJS.ProcessEnv = process.env,
): ScreenshotWriteRoots {
  const { dirs, dropped } = loadColonDirAllowlist(env.LASSO_SCREENSHOT_DIR);
  return { roots: dirs, dropped };
}

/**
 * 已存在前缀 realpath 化 + 未存在尾段保形（决议 E2 双重 containment 的实装形）：
 *
 * 为什么不能只对 target 做 path.resolve 边界匹配：macOS 上用户传入
 * `/var/folders/.../wroot/x.png`（/var 是 /private/var 的 symlink），写根装载时
 * realpath 成 `/private/var/.../wroot`——词法前缀失配 → 误拒合法目标
 *（写根内嵌套新目录是 opt-in 的核心场景）。
 *
 * 为什么不能对整个 target realpath：目标常不存在（嵌套父目录待 mkdir）。
 *
 * 正确形：对 path.resolve 后的绝对路径（无 `..` 段——词法穿越已坍缩），从其
 * 父目录**向上走**到最近存在祖先，把祖先换成 realpath，途经的未存在段
 *（纯名字段，无 `..`，symlink 不可能存在于未存在路径——写时才创建）
 * 原样拼回。产物与同样 realpath 化的写根做 path-boundary 匹配：
 *  - ../ 词法穿越：path.resolve 坍缩 → 出根后 canonical 不在根内 → 拒
 *  - symlink 逃逸：已存在前缀 realpath 解引用 → 换成真实位置 → 拒
 *  - 前缀伪造（/wroot vs /wrootdev）：isPathInside 边界 → 拒
 *  - 大小写变体：realpath 后失配=拒（误拒不误放——安全方向）
 *
 * 返 null = 到文件系统根仍无可解析祖先（拒绝，不猜）。
 */
function canonicalizeExistingPrefix(lexicalAbs: string): string | null {
  let dir = path.dirname(lexicalAbs);
  const missingTail: string[] = []; // 途经未存在段（浅→深收集，逆序拼回）
  for (;;) {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      missingTail.push(path.basename(dir));
      const parent = path.dirname(dir);
      if (parent === dir) return null; // 到达文件系统根仍不可解析
      dir = parent;
      continue;
    }
    // dir 存在：realpath 形态 + 未存在尾段 + 目标 basename
    return [real, ...missingTail.reverse(), path.basename(lexicalAbs)].join(
      path.sep,
    );
  }
}

/**
 * 显式 filePath 写根判定。roots 须是 loadScreenshotWriteRoots 产物
 *（已 realpath）。返回 allowed=false 时 reason 以 screenshot_path_not_allowed:
 * 起头（classifyBrowseError 归 didnt——策略拒与交付失败分流）。
 */
export function checkScreenshotTarget(
  filePath: string,
  roots: string[],
): { allowed: boolean; reason?: string } {
  if (roots.length === 0) {
    // 默认关：显式 filePath 恒拒（opt-in 指引内嵌 reason；不静默回退 /tmp 管理名）
    return {
      allowed: false,
      reason:
        `screenshot_path_not_allowed:${filePath.slice(0, 200)} — explicit options.screenshot.filePath is rejected by default ` +
        `(arbitrary-path write was a non-contract exposure); opt-in: LASSO_SCREENSHOT_DIR='<colon-separated write roots>' ` +
        `(browse_headless/browse_logged_in only)`,
    };
  }

  // 双重 containment（决议 E1 第 3 步 / E2 绕过面表）：词法归一（path.resolve
  // 坍缩 ../）+ 已存在前缀 realpath（消 symlink 逃逸 + macOS /var 前缀归一）
  // → canonical 与 realpath 化写根做 path-boundary 匹配
  const lexical = path.resolve(filePath);
  const canonical = canonicalizeExistingPrefix(lexical);
  if (canonical !== null && roots.some((r) => isPathInside(canonical, r))) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      `screenshot_path_not_allowed:${filePath.slice(0, 200)} outside the ${roots.length} configured ` +
      `LASSO_SCREENSHOT_DIR write root(s); fix the path or extend LASSO_SCREENSHOT_DIR`,
  };
}
