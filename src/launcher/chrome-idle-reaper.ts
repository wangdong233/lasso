/**
 * chrome-idle-reaper.ts（v1.10 parse18 §2 机制一 —— 台账 Chrome idle 用完即关）
 *
 * 设计原理（parse18 §2.1「第二消费者，不是第二套调度」）：
 *  launched Chrome（detached + unref）与 SubprocessManager 的 procs map 零交集
 *  （白盒 §1.4），zombie reaper 结构性看不见它。本 reaper 只做三件事——
 *   1. 读磁盘台账（readLedgerSync）
 *   2. 判 idle（now - max(launchedAt, touch) > idleMs）
 *   3. 调既有 stopLaunchedChromes({port})（归属验证/树杀/删账 100% 复用 chrome-stop.ts）
 *  **零新 kill 原语、零第二份 pgrep 递归**（INV-78c 守：本文件函数体不含
 *  killTreeSync / process.kill 直接调用——杀必须经 chrome-stop 验证路径）。
 *
 * 与 zombie reaper 的分工（两个数据域、两个调度器、一个致死原语族）：
 *  - zombie reaper 管 procs（MCP shim→node 树，LASSO_HEADLESS_IDLE_MS）
 *  - chrome reaper 管 ledger（detached Chrome，LASSO_LAUNCH_IDLE_MS）
 *  两者都最终走 util/kill-tree.ts / chrome-stop 的验证杀。
 *
 * 活动源：LoggedInChannel 每次 browse 经注入回调 onChromeUse → touch(port)。
 * touchMap 是「reaper 读 / LoggedInChannel 经回调写」单写多读形态（R-INT-07 自查：
 * reaper 不写 touchMap，只读；与 SubprocessManager.lastUsedAt 同范式）。
 *
 * 只活在 server 进程（index.ts 装配）——CLI 单独 launch-chrome 无 reaper，chrome-stop
 * 仍是显式出口（诚实边界 parse18 §5.1）。
 *
 * INV-64 合规：只 import node:* 内置 + 同目录 chrome-ledger.js / chrome-stop.js。
 */
import {
  readLedgerSync,
  type LaunchedChromeRecord,
  type LedgerLogFn,
} from "./chrome-ledger.js";
import { stopLaunchedChromes } from "./chrome-stop.js";

// ============================================================
// 类型
// ============================================================
export interface ChromeIdleReaperOptions {
  /** 调度周期（默认 15_000；parse18 §2.2 裁决 4：关窗最坏延迟 = idle + 周期）。 */
  intervalMs?: number;
  /** 全局默认 idle 阈值 ms（= config.launchIdleMs；≤0 时调用方不启动本 reaper）。 */
  defaultIdleMs: number;
  /** 装配时已知的活动端口（= config.cdpPort；启动即 touch 一次给宽限）。 */
  touchPorts?: Set<number>;
  /** 测试注入：读台账（默认 readLedgerSync）。 */
  readLedgerFn?: () => LaunchedChromeRecord[];
  /** 测试注入：时钟（默认 Date.now）。 */
  nowFn?: () => number;
  /** 测试注入：回收出口（默认 stopLaunchedChromes({port})）。 */
  stopFn?: (opts: { port: number }) => Promise<unknown>;
  /** 结构化日志注入（index.ts 用 logger 包）。 */
  logFn?: LedgerLogFn;
}

export interface ChromeIdleReaper {
  /** LoggedInChannel 注入回调打点（browse 活动源；重置该 port 的 lastUse）。 */
  touch(port: number): void;
  /** 清 interval（server 停机 best-effort；幂等）。 */
  stop(): void;
}

/** 默认调度周期 15s（parse18 §2.2：读一个小 JSON 文件的定时器开销可忽略）。 */
export const CHROME_IDLE_REAPER_INTERVAL_MS = 15_000;

// ============================================================
// 主入口
// ============================================================
/**
 * 启动台账 Chrome idle reaper。
 *
 * 每 tick（单条记录，parse18 §2.3）：
 *  1. rec.idleMs ?? defaultIdleMs ≤ 0 → 跳过（record 级 0=禁用；全局 0 调用方不启动）
 *  2. lastUse = max(rec.launchedAt, touchMap.get(rec.port) ?? 0)
 *  3. now - lastUse > idleMs → await stopFn({port: rec.port})
 *  4. 单条 stop 抛错 → logFn warn 继续（reaper 不因一条记录死）
 *
 * @returns ChromeIdleReaper（timer unref 不阻退出）；defaultIdleMs ≤ 0 → null
 *          （不启 timer；index.ts 侧配 chrome_idle_reaper_disabled 日志）。
 */
export function startChromeIdleReaper(
  opts: ChromeIdleReaperOptions,
): ChromeIdleReaper | null {
  const intervalMs = opts.intervalMs ?? CHROME_IDLE_REAPER_INTERVAL_MS;
  const defaultIdleMs = opts.defaultIdleMs;
  if (defaultIdleMs <= 0) return null; // 0=禁用（parse18 §2.4；调用方记 disabled 日志）
  const readLedgerFn = opts.readLedgerFn ?? readLedgerSync;
  const nowFn = opts.nowFn ?? (() => Date.now());
  const logFn = opts.logFn ?? (() => {});
  const stopFn =
    opts.stopFn ??
    (async (o: { port: number }) =>
      stopLaunchedChromes({ port: o.port, logFn }));

  /** port → 最后活动时间（touch 写 / tick 读；单写多读）。 */
  const touchMap = new Map<number, number>();
  const now0 = nowFn();
  for (const p of opts.touchPorts ?? []) touchMap.set(p, now0);

  let stopped = false;
  let ticking = false; // 上一 tick 的 async stop 未完时不叠 tick（守并发）
  const timer = setInterval(() => {
    if (stopped || ticking) return;
    ticking = true;
    void tick()
      .catch(() => {
        /* tick 整体异常不致死（readLedgerFn 已容错；防御外部注入抛错） */
      })
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  timer.unref();

  async function tick(): Promise<void> {
    const now = nowFn();
    const ledger = readLedgerFn();
    for (const rec of ledger) {
      // P1（v1.17.3，得到实战根因）：visible 档 Chrome 是**用户拥有的窗口**
      // （用户在里面登录/查看），永不 idle 收割——关闭出口只有显式 chrome-stop。
      // hidden 档维持「用完即关」语义。
      if (rec.launchMode === "visible") continue;
      const idleMs = rec.idleMs ?? defaultIdleMs;
      if (idleMs <= 0) continue; // record 级禁用（parse18 §2.5 per-launch 覆盖）
      const lastUse = Math.max(rec.launchedAt, touchMap.get(rec.port) ?? 0);
      if (now - lastUse <= idleMs) continue;
      try {
        await stopFn({ port: rec.port });
        logFn({
          evt: "chrome_idle_reaped",
          port: rec.port,
          pid: rec.pid,
          idle_ms: idleMs,
          idle_for_ms: now - lastUse,
        });
      } catch (e) {
        // 单条失败继续（reaper 不死）；下次 tick 重试（台账条目未被删时）
        logFn({
          evt: "chrome_idle_reap_error",
          port: rec.port,
          pid: rec.pid,
          error: String(e),
        });
      }
    }
  }

  return {
    touch(port: number) {
      touchMap.set(port, nowFn());
    },
    stop() {
      if (stopped) return; // 幂等
      stopped = true;
      clearInterval(timer);
    },
  };
}