/**
 * chrome-touch.ts（bug02 闭环 v1.18.5 —— 外部 CDP 消费者 touch 活动信号）
 *
 * 背景（doc/bugs/02，R-INT-07 活案例）：chrome-idle-reaper 的 touch 活动源唯一
 * （LoggedInChannel browse 回调）——外部 CDP 直连消费者（media-gen FlowProvider /
 * chrome-devtools-mcp 等）对 reaper 完全不可见，台账 Chrome 60s 后被误收割。
 *
 * 机制（档案 §6 建议 3 的结构级正解）：**约定文件 mtime 即活动信号**——
 *  `~/.cache/lasso/chrome-touch-<port>` 的 mtime 就是「该 port 最近一次外部使用」。
 * 任何第二消费者（shell / 外部 MCP workflow）一行 `touch` 即续命，不需要 lasso
 * API、不需要改 reaper 写路径：
 *   touch ~/.cache/lasso/chrome-touch-9223
 * reaper 每 tick 顺带 stat（chromeTouchMtimeSync）；launch-chrome 成功时自 touch
 * 一次（touchChromePort）确立约定文件存在性。
 *
 * 红线（与 chrome-ledger / desired-hide-state 同款）：
 *  - 全程 best-effort：touch/stat 失败不抛、不影响 launch/收割主流程
 *  - tmp+rename 不需要（无内容读取方；mtime 是唯一消费面）
 *  - INV-64 合规：只 import node:* 内置
 */
import { promises as fsp, statSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";
import type { LedgerLogFn } from "./chrome-ledger.js";

/**
 * touch 文件路径（env LASSO_CHROME_TOUCH_DIR 覆盖目录；测试隔离用）。
 * 文件名约定 `chrome-touch-<port>` 与档案 §6 建议 3 逐字一致（外部消费者按此
 * 约定写 shell `touch`，改名即破坏跨仓库契约）。
 */
export function chromeTouchPath(port: number): string {
  const dirOverride = process.env.LASSO_CHROME_TOUCH_DIR;
  const dir =
    dirOverride && dirOverride.trim().length > 0
      ? dirOverride
      : path.join(os.homedir(), ".cache", "lasso");
  return path.join(dir, `chrome-touch-${port}`);
}

/**
 * 打一次活动信号（launch-chrome 成功路径自 touch；外部消费者也可直接 shell
 * `touch` 同一文件——本函数只是 node 侧单一真源出口）。
 * 实现：文件已存在 → utimes 刷 mtime；不存在 → 写入时间戳内容（mtime 即诞生）。
 * best-effort：mkdir / utimes / write 任一失败 → logFn warn 不抛。
 */
export async function touchChromePort(
  port: number,
  logFn: LedgerLogFn = () => {},
): Promise<void> {
  const target = chromeTouchPath(port);
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const now = new Date();
    try {
      await fsp.utimes(target, now, now); // 已存在：只刷 mtime（不重写内容）
    } catch {
      await fsp.writeFile(target, `${Date.now()}\n`, "utf8"); // ENOENT：创建
    }
    logFn({ evt: "chrome_touched", port, path: target });
  } catch (e) {
    logFn({ evt: "chrome_touch_error", port, error: String(e) });
  }
}

/**
 * 读 touch 信号 mtime（reaper tick 用；同步 = tick 内零 await 面）。
 * 文件不存在 / stat 失败 → undefined（= 无外部信号，不影响既有 lastUse 计算）。
 */
export function chromeTouchMtimeSync(port: number): number | undefined {
  try {
    return statSync(chromeTouchPath(port)).mtimeMs;
  } catch {
    return undefined;
  }
}
