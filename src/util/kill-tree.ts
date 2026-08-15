/**
 * kill-tree.ts（v1.9 parse17 §3.5 共享树杀原语）
 *
 * 从 SubprocessManager._killTreeSync 原样搬出的 pgrep -P 递归 SIGKILL（W2-DEF-N2，
 * v1.8.1 实证有效：shim→node→Chromium 三层）。
 *
 * 单一真源（禁第二份 pgrep 递归实现漂移）：
 *  - SubprocessManager._killTreeSync 薄委托到本函数（保既有调用点与 INV-76 (n) 兼容）
 *  - chrome-stop（launcher/chrome-stop.ts）消费同一原语关台账在案的 Chrome
 *
 * 语义（与 v1.8.1 SubprocessManager._killTreeSync 完全一致）：
 *  - 对 pid 及其全部后代递归 SIGKILL（best-effort，单点失败不抛）
 *  - macOS 无 /proc，用 pgrep -P 逐层枚举子进程；pgrep 不可用 → 退化为只杀根 pid
 *  - guard 64 层防环
 */

import { spawnSync } from "node:child_process";
import { logger } from "./logger.js";

/**
 * 对 pid 及其全部后代递归 SIGKILL（同步、best-effort、幂等安全）。
 *
 * @param pid    根 pid（MCP shim / 台账在案的 Chrome 根进程）
 * @param logTag 日志归属标签（SubprocessManager 传 spec name；chrome-stop 传 "chrome-stop:<port>"）
 */
export function killTreeSync(pid: number, logTag?: string): void {
  const name = logTag ?? "kill-tree";
  const queue = [pid];
  const victims: number[] = [];
  let guard = 0;
  while (queue.length > 0 && guard++ < 64) {
    const p = queue.shift()!;
    victims.push(p);
    try {
      const r = spawnSync("pgrep", ["-P", String(p)], {
        encoding: "utf8",
        timeout: 1000,
      });
      if (r.stdout) {
        for (const line of r.stdout.split("\n")) {
          if (/^\d+$/.test(line.trim())) queue.push(Number(line.trim()));
        }
      }
    } catch {
      // pgrep 不可用——退化为只杀根 pid
    }
  }
  for (const v of victims) {
    try {
      process.kill(v, "SIGKILL");
      logger.info({ evt: "subproc_exit_kill", name, pid: v, signal: "SIGKILL" });
    } catch {
      // 已死（ESRCH）或权限不足（EPERM）——best-effort，不抛
    }
  }
}
