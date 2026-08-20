/**
 * desired-hide-watchdog.ts（P27 v1.18.3 —— 粘滞复隐看门狗）
 *
 * 设计（与 chrome-idle-reaper 同范式：单调度器 + DI 注入 + timer unref）：
 *  - 每 tick 读 desired-hidden 粘滞账（chrome-hide 写 / chrome-show 清）；
 *  - 逐条：pid 死亡 → 剔除落盘；ps 归属复验失败（pid 复用风险）→ 剔除 + warn
 *    （**永不向非本台账 pid 施加 osascript**——E8 误伤红线的 watchdog 侧延伸）；
 *  - reassertChromeHiddenByPid：单 osascript「可见才压回」；wasVisible=true 时打
 *    desired_hidden_reasserted —— 这是产品级闪现观测点（P27 触发源定位的持久数据）。
 *
 * 与 idle-reaper 的分工：reaper 管「什么时候关」（idle kill / autoHide）；本看门狗
 * 管「隐藏态保持」（desiredHidden 粘滞执行）。两调度器数据域正交（ledger vs
 * desired-hidden），R-CI-02 守（不共用账本、不互相写）。
 *
 * 闪现上限：intervalMs（默认 1.5s）。任何激活源（上游 CDP / 页面 JS / Chrome 内部）
 * 掀出的窗口至多存活一个 tick——引擎侧章尾守卫降级为第三道 belt。
 *
 * 只活在 server 进程（index.ts 装配）；CLI chrome-hide/show 不启动（进程退出即无
 * 看门狗——粘滞账是跨进程契约，长命 server 消费）。
 *
 * INV-64 合规：只 import node:* 内置 + 同目录模块。
 */
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  readDesiredHiddenSync,
  rewriteDesiredHiddenSync,
  type DesiredHiddenRecord,
} from "./desired-hide-state.js";
import { reassertChromeHiddenByPidAsync } from "./chrome-hide.js";
import { verifyOwnership } from "./chrome-stop.js";
import type { LedgerLogFn } from "./chrome-ledger.js";

export interface DesiredHideWatchdogOptions {
  /** 调度周期（默认 1_500ms = 闪现上限）。 */
  intervalMs?: number;
  /** 测试注入：读粘滞账（默认 readDesiredHiddenSync）。 */
  readStateFn?: () => DesiredHiddenRecord[];
  /** 测试注入：剔除后落盘（默认 rewriteDesiredHiddenSync）。 */
  rewriteStateFn?: (records: DesiredHiddenRecord[]) => void;
  /** 测试注入：pid 存活（默认 process.kill(pid,0) try/catch）。 */
  aliveFn?: (pid: number) => boolean;
  /** 测试注入：ps cmdline（归属复验；默认 spawnSync ps，chrome-stop 同款）。 */
  psFn?: (pid: number) => string;
  /**
   * 测试注入：异步复隐原语（默认 reassertChromeHiddenByPidAsync——execFile
   * 回调形态，**零事件循环阻塞**；Chrome 忙时 AX 枚举可 >2s，同步形态会阻塞
   * server 的 MCP 请求处理——真机实证 P27 v1.18.3 复盘）。
   */
  reassertFn?: (pid: number) => Promise<{ ok: boolean; wasVisible?: boolean; reason?: string }>;
  /** 测试注入：平台（非 darwin 整体 no-op）。 */
  platform?: string;
  /** 结构化日志注入（index.ts 用 logger 包）。 */
  logFn?: LedgerLogFn;
}

export interface DesiredHideWatchdog {
  /** 清 interval（server 停机 best-effort；幂等）。 */
  stop(): void;
}

/** 默认调度周期 1.5s（闪现可感知下限之上、osascript 开销可忽略之下）。 */
export const DESIRED_HIDE_WATCHDOG_INTERVAL_MS = 1_500;

/**
 * 启动粘滞复隐看门狗。非 darwin / 粘滞账为空启动时仍启动（chrome-hide 可能在
 * server 启动后才写入——tick 首读为空只意味着零成本空转一次读文件）。
 * @returns watchdog（timer unref 不阻退出）
 */
export function startDesiredHideWatchdog(
  opts: DesiredHideWatchdogOptions = {},
): DesiredHideWatchdog | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return null;

  const intervalMs = opts.intervalMs ?? DESIRED_HIDE_WATCHDOG_INTERVAL_MS;
  const readStateFn = opts.readStateFn ?? readDesiredHiddenSync;
  const rewriteStateFn = opts.rewriteStateFn ?? ((records) => rewriteDesiredHiddenSync(records));
  const aliveFn = opts.aliveFn ?? ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const psFn = opts.psFn ?? ((pid) => { try { return psCommandline(pid); } catch { return ""; } });
  const reassertFn = opts.reassertFn ?? ((pid) => reassertChromeHiddenByPidAsync(pid));
  const logFn = opts.logFn ?? (() => {});

  let stopped = false;
  let ticking = false; // 上一 tick 的异步 osascript 未完时不叠 tick（守并发+防堆积）
  const timer = setInterval(() => {
    if (stopped || ticking) return;
    ticking = true;
    void tick()
      .catch(() => {
        /* tick 整体异常不致死（读账已容错；防御注入抛错） */
      })
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  timer.unref();

  async function tick(): Promise<void> {
    const records = readStateFn();
    if (records.length === 0) return;
    const keep: DesiredHiddenRecord[] = [];
    for (const rec of records) {
      if (!aliveFn(rec.pid)) {
        logFn({ evt: "desired_hidden_pruned", pid: rec.pid, port: rec.port, reason: "pid_dead" });
        continue;
      }
      // 归属复验（每 tick）：pid 复用后 cmdline 不再含本台账 profileDir 标记 →
      // 剔除该条（宁可不压回，绝不向陌生进程施 osascript——E8 红线）
      if (!verifyOwnership(rec.pid, rec.profileDir, psFn)) {
        logFn({ evt: "desired_hidden_pruned", pid: rec.pid, port: rec.port, reason: "pid_reused" });
        continue;
      }
      keep.push(rec);
      const r = await reassertFn(rec.pid);
      if (r.ok && r.wasVisible) {
        // 一次闪现被压回的实证（P27 观测点：频率×时刻可反推触发源）
        logFn({ evt: "desired_hidden_reasserted", pid: rec.pid, port: rec.port });
      } else if (!r.ok && r.reason && r.reason !== "process_not_found") {
        // TCC 缺失 / AX 超时等持续失败 → warn（doctor 可查）；nomatch 交给下轮 alive/归属判定
        logFn({ evt: "desired_hidden_reassert_error", pid: rec.pid, port: rec.port, reason: r.reason });
      }
    }
    if (keep.length !== records.length) rewriteStateFn(keep);
  }

  return {
    stop() {
      if (stopped) return; // 幂等
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** ps cmdline 读取（chrome-stop defaultPsFn 同形：ps -p PID -o command=）。 */
function psCommandline(pid: number): string {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    return r.stdout ?? "";
  } catch {
    return "";
  }
}
