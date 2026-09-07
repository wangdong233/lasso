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
 * BUG-03 决议 B1（2026-09-07，doc/bugs/03 §4 B1 + §4.0-F1/F2 复审修订）：压回
 * 决策接入**用户激活让位门**——reassert 原语改 gated 形态（双判据 AND 在单次
 * osascript 内判定：(a) hidSystemState 年龄 < 10s AND (b) 本 Chrome frontmost；
 * 判定先于压回，判据不可得整体跳过零副作用）。看门狗侧确认窗状态机：连续
 * USER_ACTIVATION_CONFIRM_TICKS（20 ≈ 30s）tick 门命中才落台账 userTakenAt
 * （认领后执守退位 + idle/停机收割豁免）；放行单 tick / 暂停 / 失败路径对粘滞
 * 账与台账**零 mutation**（§4.0-F2 账面突变禁令）。残余风险（诚实声明）：双判据
 * 仍无法区分「用户 Dock 激活」与「用户在场期间的 CDP activateTarget/弹窗夺焦」，
 * 确认窗把误认领成本升为持续 30s 夺焦存活，按用户主权方向校准接受并记录。
 *
 * 宿主形态两种（bug02 v1.18.5 起）：① server 进程（index.ts 装配，永不自退）；
 * ② 独立执守进程 hide-enforcer（desired-hide-enforcer.ts spawn 的 detached
 * node ——server 不在时兜执守；粘滞账连续 N tick 为空自退，不留常驻进程）。
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
import {
  reassertChromeHiddenGatedAsync,
  USER_ACTIVATION_CONFIRM_TICKS,
  type ChromeReassertGatedResult,
} from "./chrome-hide.js";
import { verifyOwnership } from "./chrome-stop.js";
import { readLedgerSync, markUserTakenByPid, type LaunchedChromeRecord, type LedgerLogFn } from "./chrome-ledger.js";

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
   * 测试注入：异步复隐原语。默认 reassertChromeHiddenGatedAsync——BUG-03 B1
   * （doc/bugs/03 §4 B1）起压回决策带用户激活让位门（双判据 AND 在 reassert
   * 原语内判定，真激活让位信号 userPending 由本看门狗确认窗状态机消费）。
   */
  reassertFn?: (pid: number) => Promise<ChromeReassertGatedResult>;
  /**
   * BUG-03 B1 测试注入：读台账（默认 readLedgerSync）——每 tick 查 userTakenAt
   * 认领状态（已认领的 pid 执守退位：不再 reassert，粘滞账记录保留不动）。
   */
  readLedgerFn?: () => LaunchedChromeRecord[];
  /**
   * BUG-03 B1 测试注入：确认窗满后落 userTakenAt（默认 markUserTakenByPid——
   **唯一**台账写路径；放行/暂停/失败路径零账面突变，§4.0-F2）。
   */
  markUserTakenFn?: (pid: number) => Promise<void>;
  /** 测试注入：平台（非 darwin 整体 no-op）。 */
  platform?: string;
  /**
   * bug02 隐藏全生命周期（v1.18.5）：连续 N 个 tick 粘滞账为空 → 自动 stop +
   * onIdleExit 回调（独立执守进程 hide-enforcer 的自退出口——账空即无执守对象，
   * 不留常驻 node 进程）。缺省 undefined = 永不自退（server 进程内既有形态）。
   */
  exitWhenIdleTicks?: number;
  /** exitWhenIdleTicks 触发时回调（执守进程在此 process.exit；server 不配）。 */
  onIdleExit?: () => void;
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
  const reassertFn = opts.reassertFn ?? ((pid) => reassertChromeHiddenGatedAsync(pid));
  const readLedgerFn = opts.readLedgerFn ?? readLedgerSync;
  const markUserTakenFn = opts.markUserTakenFn ?? ((pid) => markUserTakenByPid(pid));
  const logFn = opts.logFn ?? (() => {});

  let stopped = false;
  let ticking = false; // 上一 tick 的异步 osascript 未完时不叠 tick（守并发+防堆积）
  // bug02（v1.18.5）：exitWhenIdleTicks 空转计数（有任何记录即清零）
  let emptyTicks = 0;
  // BUG-03 B1（doc/bugs/03 §4 B1）：确认窗状态机（进程内态，不落盘——放行/暂停/
  // 失败路径零账面突变 §4.0-F2；userTakenAt 只在确认窗满后经 markUserTakenFn 落）
  /** pid → 连续命中双判据门的 tick 数（失守/already/判据不可得即清零）。 */
  const pendingTicks = new Map<number, number>();
  /** 已认领（userTakenAt 落写）的 pid——一次性退位日志防每 tick 刷屏。 */
  const takenNotified = new Set<number>();
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
    if (records.length === 0) {
      // bug02（v1.18.5）：独立执守进程自退——连续 N tick 空账 = 无执守对象
      if (opts.exitWhenIdleTicks !== undefined) {
        emptyTicks++;
        if (emptyTicks >= opts.exitWhenIdleTicks) {
          stopped = true;
          clearInterval(timer);
          logFn({ evt: "desired_hide_watchdog_idle_exit", empty_ticks: emptyTicks });
          opts.onIdleExit?.();
        }
      }
      return;
    }
    emptyTicks = 0;
    // BUG-03 B1：每 tick 读一次台账 userTakenAt 认领集（已认领的 pid 执守退位）
    const takenPids = new Set(
      readLedgerFn()
        .filter((r) => r.userTakenAt !== undefined)
        .map((r) => r.pid),
    );
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
      // BUG-03 B1（doc/bugs/03 §4 B1）：用户已认领（userTakenAt = 确认窗满或
      // chrome-show 落写）→ 粘滞执守对本 pid 退位——不再 reassert；粘滞账记录
      // **保留不动**（唯一清账路径 chrome-show；唯一重挂路径显式 chrome-hide——
      // 双向可逆，账面与执守态一致）。显式 chrome-hide 重武装时清 userTakenAt 恢复。
      if (takenPids.has(rec.pid)) {
        if (!takenNotified.has(rec.pid)) {
          takenNotified.add(rec.pid);
          pendingTicks.delete(rec.pid);
          logFn({ evt: "desired_hidden_user_taken_deferred", pid: rec.pid, port: rec.port });
        }
        continue;
      }
      const r = await reassertFn(rec.pid);
      if (r.ok && r.userPending) {
        // B1 确认窗：双判据门命中（(a) hid 年龄 < 阈值 AND (b) frontmost）——
        // **本 tick 不压回**（让位单 tick，零账面突变）；连续 N tick 命中才落
        // userTakenAt（§4.0-F1：hidSystemState 无 per-app 归因，单判据在互动
        // 会话 ≈ 恒真——确认窗把误认领成本从「瞬时永久 disarm」升为「持续 30s
        // 夺焦存活」；窗内失守即恢复压回，v1.18.3 防
        // 闪契约的武装保持）。
        const n = (pendingTicks.get(rec.pid) ?? 0) + 1;
        pendingTicks.set(rec.pid, n);
        logFn({ evt: "user_activation_pending", pid: rec.pid, port: rec.port, pending_ticks: n });
        if (n >= USER_ACTIVATION_CONFIRM_TICKS) {
          await markUserTakenFn(rec.pid);
          pendingTicks.delete(rec.pid);
          logFn({
            evt: "user_activation_taken",
            pid: rec.pid,
            port: rec.port,
            confirm_ticks: USER_ACTIVATION_CONFIRM_TICKS,
            note: "sticky enforcement retires for this pid; idle reaping & shutdown/exit collection exempt (INV-86); re-arm via explicit chrome-hide",
          });
        }
      } else if (r.ok && r.wasVisible) {
        // 一次闪现被压回的实证（P27 观测点）+ 确认窗失守（frontmost=false 的
        // 程序掀出 / hid 超阈值 → 照常压回，计数清零）
        if (pendingTicks.has(rec.pid)) pendingTicks.delete(rec.pid);
        logFn({ evt: "desired_hidden_reasserted", pid: rec.pid, port: rec.port });
      } else if (r.ok && !r.wasVisible) {
        // already（本就隐藏）——确认窗中断（真激活应持续可见），计数清零
        if (pendingTicks.has(rec.pid)) pendingTicks.delete(rec.pid);
      } else if (!r.ok && r.reason && r.reason !== "process_not_found") {
        // TCC 缺失 / AX 超时 / **判据不可得（gate_unavailable）**等持续失败 →
        // warn（doctor 可查）；nomatch 交给下轮 alive/归属判定。
        // B1 §4.0-F2：判据不可得路径**跳过本 tick 零账面突变**——不压回（错误
        // 早于压回发生）、不确认、不落账；确认窗计数清零（确认要求连续可观测）。
        if (pendingTicks.has(rec.pid)) pendingTicks.delete(rec.pid);
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
