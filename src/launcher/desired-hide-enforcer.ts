/**
 * desired-hide-enforcer.ts（bug02 隐藏全生命周期 v1.18.5 —— 独立执守进程）
 *
 * 背景（doc/bugs/02 隐藏洞调查）：粘滞复隐看门狗「只活在 server 进程」，而
 * Chrome 是 detached+unref（设计为长于拉起进程）。失配窗口实存：
 *  ① server 崩溃/被 SIGKILL（shutdown 清理链完全跳过）
 *  ② 停机收尾 stopLaunchedChromes 3s race 失败（Chrome 活 + 台账已删）
 *  ③ 纯终端 CLI 拉起（无任何 CC 会话）——launch-chrome hidden 档写粘滞账后
 *     若无 server 存活，掀出无人压回（用户实测「有时隐藏不住」的主根因）
 *
 * 机制：chrome-hide 成功 / launch-chrome hidden 记账后 ensureHideEnforcerRunning()
 * ——pidfile + ps cmdline 标记复验的 detached 单例执守进程：
 *  - pidfile：~/.cache/lasso/desired-hide-enforcer.json {pid, startedAt}
 *    （env LASSO_HIDE_ENFORCER_PID_PATH 覆盖；测试隔离用）
 *  - 复验：pid 活 **且** ps cmdline 含 "hide-enforcer" 标记（防 pid 复用假阳性
 *    ——只看 pid 活会误判「执守在世」；E8 误伤红线的 pidfile 侧同源纪律）
 *  - 执守体 = `node <dist|src>/index.js hide-enforcer`（复用 startDesiredHideWatchdog
 *    单一调度真源 + exitWhenIdleTicks 自退——账空 2 tick 即退，不留常驻 node）
 *  - BUG-03 决议 A1（doc/bugs/03）：执守体扩双职责——粘滞复隐 + hidden 档 idle
 *    收割（startEnforcerIdleReaper，见下）；双职责都自退且两账皆空才 exit
 *    （BUG-03 adversarial r3 F1：死窗内账面重填 → 自愈监护复活对应职责）
 *  - 幂等：执守存活即跳过 spawn；并发双起时后到者在入口自检发现前者即 exit
 *
 * 与 server 内看门狗并发安全：reassert 原语是「可见才压回」幂等（先读后写），
 * 双执守最坏一次重复 AX 读——无竞态恶化面。
 *
 * INV-64 合规：只 import node:* 内置 + 同目录模块（./desired-hide-watchdog.js）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  readDesiredHiddenSync,
} from "./desired-hide-state.js";
import {
  startDesiredHideWatchdog,
  type DesiredHideWatchdog,
  type DesiredHideWatchdogOptions,
} from "./desired-hide-watchdog.js";
// BUG-03 决议 A1（doc/bugs/03 §4 A1）：执守进程语义扩为「粘滞复隐 + 日常档
// （hidden/headless）idle 收割」双职责——复用既有 hide-enforcer 单例（零新守护
// 进程，守用户红线「不出现新的项目之外的组件」；render 档不动，render-guardian
// 自管）。
import {
  startChromeIdleReaper,
  type ChromeIdleReaper,
} from "./chrome-idle-reaper.js";
import {
  readLedgerSync,
  CLI_LAUNCH_IDLE_DEFAULT_MS,
  type LaunchedChromeRecord,
  type LedgerLogFn,
} from "./chrome-ledger.js";

/** 执守进程 ps cmdline 标记（spawn argv 自带；复验用——pidfile 数字之外的结构证据）。 */
export const HIDE_ENFORCER_CMDLINE_MARKER = "hide-enforcer";

/** pidfile 路径（env LASSO_HIDE_ENFORCER_PID_PATH 覆盖；测试隔离用）。 */
export function hideEnforcerPidPath(): string {
  const override = process.env.LASSO_HIDE_ENFORCER_PID_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".cache", "lasso", "desired-hide-enforcer.json");
}

/**
 * CLI 入口 js 路径。**真机实锤（2026-08-27 验证发现，bug01 同族）**：launcher/
 * 到 index.js 只隔**一级**（dist/launcher/ → dist/index.js；package.json bin 即
 * dist/index.js）——初版 `../../index.js` 落到仓库根（不存在）→ accessSync 诚实
 * 降级 entry_missing → 执守从未真起。`../index.js` 对 **dist 布局**（生产真路径）
 * 成立；src 布局下解析为 src/index.js（不存在，源是 .ts）→ 同样诚实降级
 * entry_missing（tsx 开发形态无执守，server 内看门狗兜底——可接受）。
 */
export function hideEnforcerEntryPath(): string {
  return fileURLToPath(new URL("../index.js", import.meta.url));
}

export interface HideEnforcerProbe {
  running: boolean;
  /** pidfile 记录的 pid（可读时；诊断用）。 */
  pid?: number;
  /** not_running 的结构化原因。 */
  reason: "no_pidfile" | "pidfile_invalid" | "pid_dead" | "pid_reused" | "ok";
}

/**
 * 探测执守进程是否在世（纯读；DI 注入测试）。
 * 活判定三重：pidfile 可读 + pid 活 + ps cmdline 含 marker（防 pid 复用假阳性）。
 */
export function probeHideEnforcer(
  opts: {
    readPidFn?: () => string;
    psFn?: (pid: number) => string;
    aliveFn?: (pid: number) => boolean;
  } = {},
): HideEnforcerProbe {
  const readPidFn =
    opts.readPidFn ??
    (() => {
      try {
        return readFileSync(hideEnforcerPidPath(), "utf8");
      } catch {
        return "";
      }
    });
  const aliveFn =
    opts.aliveFn ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const psFn =
    opts.psFn ??
    ((pid: number) => {
      try {
        return (
          spawnSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: 1_000,
          }).stdout ?? ""
        );
      } catch {
        return "";
      }
    });

  const body = readPidFn();
  if (!body.trim()) return { running: false, reason: "no_pidfile" };
  let pid: number;
  try {
    const parsed = JSON.parse(body) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) {
      return { running: false, reason: "pidfile_invalid" };
    }
    pid = parsed.pid;
  } catch {
    return { running: false, reason: "pidfile_invalid" };
  }
  if (!aliveFn(pid)) return { running: false, pid, reason: "pid_dead" };
  // pid 复用：数字在世但 cmdline 已无 marker（被无关进程占用）→ 判死重建
  if (!psFn(pid).includes(HIDE_ENFORCER_CMDLINE_MARKER)) {
    return { running: false, pid, reason: "pid_reused" };
  }
  return { running: true, pid, reason: "ok" };
}

export interface EnsureHideEnforcerResult {
  /** true = 本次调用拉起了新执守；false = 已在世跳过 / 拉起失败（best-effort）。 */
  spawned: boolean;
  pid?: number;
  reason: string;
}

/**
 * PERF-2a（2026-09-02 性能轮，doc/性能准确率优化裁决表.md §2）：server 装配侧让位。
 *
 * 根因：server 进程内看门狗 + 独立 hide-enforcer 执守同时以 1.5s tick 各跑一轮
 * osascript reassert——正确性幂等（reassert 是「可见才压回」先读后写，双执守最坏
 * 一次重复 AX 读），但 CPU 成本双倍：perf 轮真机实测 reassert nomatch 纯枚举路径
 * ~873ms/次（平凡 osascript 基线 288ms）→ 单宿主 ≈58% 单核，双宿主 >100% 单核
 * 持续占用（System Events 进程）。
 *
 * 修法：probeHideEnforcer() 为 running 则 server 不自起（执守为权威宿主——
 * chrome-hide / launch-chrome hidden 记账后 ensureHideEnforcerRunning 保证
 * 「账非空 ⟹ 执守在世或即将被 respawn」）；probe not running 才自起兜底
 * （server 内看门狗仍是「无执守」形态的主执守面，如 src 布局开发形态）。
 *
 * 零语义变化：闪现上限仍 1.5s（由执守承载）；server 侧本就是冗余 belt。
 *
 * @returns DesiredHideWatchdog | null（null = 让位给执守 / 非 darwin）
 */
export function startWatchdogUnlessEnforcerRunning(
  opts: {
    /** 测试注入：probe 结果（默认真调 probeHideEnforcer）。 */
    probe?: HideEnforcerProbe;
    /** 透传给 startDesiredHideWatchdog 的选项（logFn/readStateFn/platform 等）。 */
    watchdogOpts?: DesiredHideWatchdogOptions;
    /** 让位事件的日志出口（与 watchdog logFn 同形）。 */
    logFn?: (p: Record<string, unknown>) => void;
  } = {},
): DesiredHideWatchdog | null {
  const logFn = opts.logFn ?? (() => {});
  const probe = opts.probe ?? probeHideEnforcer();
  if (probe.running) {
    logFn({
      evt: "desired_hide_watchdog_deferred_to_enforcer",
      pid: probe.pid,
      note: "PERF-2a：执守进程为权威宿主，server 不自起看门狗（双宿主 = 每 1.5s 双倍 osascript AX 枚举）；闪现上限语义不变",
    });
    return null;
  }
  return startDesiredHideWatchdog(opts.watchdogOpts ?? {});
}

/**
 * 确保执守进程在世（chrome-hide 成功 / launch-chrome hidden 记账后调用）。
 * detached + stdio:ignore + unref——调用方（短命 CLI）退出后执守继续。
 * best-effort：spawn/写 pidfile 失败不抛（执守是增强面，永不阻断主流程）。
 */
export async function ensureHideEnforcerRunning(
  opts: {
    spawnFn?: (cmd: string, args: string[]) => ChildProcess;
    probe?: HideEnforcerProbe;
    /** 测试注入：CLI 入口路径（默认 hideEnforcerEntryPath）。 */
    entry?: string;
    logFn?: (payload: Record<string, unknown>) => void;
  } = {},
): Promise<EnsureHideEnforcerResult> {
  const logFn = opts.logFn ?? (() => {});
  const probe = opts.probe ?? probeHideEnforcer();
  if (probe.running) {
    return { spawned: false, pid: probe.pid, reason: "already_running" };
  }
  const entry = opts.entry ?? hideEnforcerEntryPath();
  try {
    accessSync(entry);
  } catch {
    // 布局异常（无 index.js）——诚实降级：server 内看门狗仍是主执守面
    logFn({ evt: "hide_enforcer_entry_missing", entry });
    return { spawned: false, reason: "entry_missing" };
  }
  const spawnFn =
    opts.spawnFn ??
    ((cmd: string, args: string[]) =>
      spawn(cmd, args, { detached: true, stdio: "ignore" }));
  try {
    const child = spawnFn(process.execPath, [entry, HIDE_ENFORCER_CMDLINE_MARKER]);
    child.unref();
    const pid = child.pid;
    // P2 处置轮（contract 路发现）：透传 logFn——原默认 no-op 把 pidfile 写失败
    // 完全吞掉（参数存在却从未接线，错误不吞红线边角违例）。
    writeEnforcerPidfile(pid, logFn);
    logFn({ evt: "hide_enforcer_spawned", pid, previous: probe.reason });
    return { spawned: true, pid, reason: "spawned" };
  } catch (e) {
    logFn({ evt: "hide_enforcer_spawn_error", error: String(e) });
    return { spawned: false, reason: `spawn_error:${String(e).slice(0, 80)}` };
  }
}

/** 写 pidfile（best-effort；执守子进程入口也自写——双写收敛，后到者自检让位）。 */
function writeEnforcerPidfile(pid: number | undefined, logFn: (p: Record<string, unknown>) => void = () => {}): void {
  if (pid === undefined) return;
  try {
    const target = hideEnforcerPidPath();
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ pid, startedAt: Date.now() })}\n`, "utf8");
  } catch (e) {
    logFn({ evt: "hide_enforcer_pidfile_error", error: String(e) });
  }
}

/**
 * BUG-03 决议 A1（doc/bugs/03 §4 A1）：执守进程第二职责——hidden 档 idle 收割。
 *
 * CLI 显式拉起默认 idleMs:0 时代（bug02 §9.1），CLI 起的 Chrome 无任何收割宿主
 * （reaper 只活在 server 进程）——「用完即关」出口被拆掉，8.5h 级常驻是激活
 * 劫持可达性的放大器。A1 把 CLI 默认翻为有限值（CLI_LAUNCH_IDLE_DEFAULT_MS
 * 30min）后，需要一个「server 不在时也活着」的收割宿主：复用本执守进程
 * （pidfile 单例 / 账空自退既有机制零改动）装配 startChromeIdleReaper——
 * readLedgerFn 过滤日常档（hidden + B2 headless；不动 render：render-guardian
 * 自管；visible 由 reaper 内部既有豁免）。touch 续命契约不变
 * （~/.cache/lasso/chrome-touch-<port>，bug02 §6 建议 3 跨仓库契约）。
 *
 * @returns ChromeIdleReaper | null（null = defaultIdleMs ≤ 0（显式 env/config 禁用
 *          收割 = 用户裁决，执守只保留粘滞复隐职责））
 */
export function startEnforcerIdleReaper(
  opts: {
    /** 全局 idle 阈值（= config.launchIdleMs；缺省 CLI_LAUNCH_IDLE_DEFAULT_MS）。 */
    defaultIdleMs?: number;
    /** 测试注入：读台账（默认 readLedgerSync 过滤 hidden 档）。 */
    readLedgerFn?: () => LaunchedChromeRecord[];
    /** 测试注入：时钟。 */
    nowFn?: () => number;
    /** 测试注入：收割出口。 */
    stopFn?: (o: { port: number }) => Promise<unknown>;
    /** 测试注入：touch 文件 mtime。 */
    touchStatFn?: (port: number) => number | undefined;
    /** 账空自退 tick 数（缺省 2，与执守粘滞账自退同款）。 */
    exitWhenLedgerEmptyTicks?: number;
    /** 账空自退回调（执守进程在此参与双职责退出闩）。 */
    onIdleExit?: () => void;
    /** 结构化日志注入。 */
    logFn?: LedgerLogFn;
  } = {},
): ChromeIdleReaper | null {
  return startChromeIdleReaper({
    defaultIdleMs: opts.defaultIdleMs ?? CLI_LAUNCH_IDLE_DEFAULT_MS,
    readLedgerFn:
      opts.readLedgerFn ??
      (() =>
        readLedgerSync().filter((r) =>
          // 日常档两形态（hidden + B2 headless）进收割域；缺省 launchMode 按
          // hidden（与 chrome-stop modes 过滤同款前向兼容）；render 不动
          // （render-guardian 自管）；visible 由 reaper 内部既有豁免
          ["hidden", "headless"].includes(r.launchMode ?? "hidden"),
        )),
    nowFn: opts.nowFn,
    stopFn: opts.stopFn,
    touchStatFn: opts.touchStatFn,
    exitWhenLedgerEmptyTicks: opts.exitWhenLedgerEmptyTicks ?? 2,
    onIdleExit: opts.onIdleExit,
    logFn: opts.logFn,
  });
}

/**
 * BUG-03 adversarial r3 F1（2026-09-08 真机定罪修复）：双职责自愈监护。
 *
 * 事故型：runHideEnforcerCli 的双职责闩原实现里，两个调度器各自「账空 2 tick
 * 即自杀」且**自杀是终态**（startDesiredHideWatchdog/startChromeIdleReaper 的
 * stopped+clearInterval 无复活路径）。当粘滞看门狗先自杀（如 chrome-stop 清两账
 * 后 ~4.5s）而 idle 收割职责仍在计数（15s × 2 = 30s 死窗）或台账仍有他记录
 * （无限期）时，执守**进程**活着但粘滞执守已死——死窗内任何新 hidden launch 的
 * ensureHideEnforcerRunning probe 判 already_running 跳过重生 → 新 Chrome 的
 * 粘滞账记录**永无执守压回**（v1.18.3 P27 防闪契约静默失效）、**永不清账**
 * （死 pid 记录堆积）。真机复现（r3）：stop A → 8s 后 relaunch B → 掀出 B
 * 8s+ 零压回；本会话更早一段 3 条死 pid 粘滞记录滞留 11 分钟。
 *
 * 修法：自愈监护（reconcile）——职责自杀后若其账面重新非空（死窗内新 launch）
 * 则**复活该职责**（重建调度器 + 重置闩旗）；退出判定改为「两职责都自杀且
 * **此刻**两账都空」（退出时新鲜读双账，读非空即复活不退出——check-then-exit
 * 竞态收窄到 ms 级）。reconcile 由周期 timer（默认 3s）与每个 onIdleExit 双驱动。
 */
export interface DualDutyEnforcerOptions {
  /** 粘滞执守职责工厂（null = 非 darwin 无对象；runHideEnforcerCli 预检后不会为 null）。 */
  stickyDutyFn: (onIdleExit: () => void) => DesiredHideWatchdog | null;
  /** idle 收割职责工厂（null = 显式禁用收割——终态不复活）。 */
  reapDutyFn: (onIdleExit: () => void) => ChromeIdleReaper | null;
  /** 粘滞账此刻非空？（复活判定 + 退出前新鲜读）。 */
  stickyNonEmptyFn: () => boolean;
  /** 收割域（hidden/headless 台账）此刻非空？ */
  reapNonEmptyFn: () => boolean;
  /** 两职责都自杀且两账皆空 → 进程退出回调。 */
  onBothIdle: () => void;
  /** 监护周期（默认 3s = 2× 粘滞 tick；测试注入）。 */
  reconcileIntervalMs?: number;
  /** 结构化日志注入。 */
  logFn?: (p: Record<string, unknown>) => void;
}

export interface DualDutyEnforcer {
  /** 立即跑一轮监护（timer 之外；测试与 onIdleExit 双驱动共用）。 */
  reconcile(): void;
  /** 停监护（信号退出路径；不再触发 onBothIdle）。 */
  stop(): void;
}

export function startDualDutyEnforcer(
  opts: DualDutyEnforcerOptions,
): DualDutyEnforcer {
  const logFn = opts.logFn ?? (() => {});
  const reconcileIntervalMs = opts.reconcileIntervalMs ?? 3_000;
  let stickyIdleExited = false;
  let reapIdleExited = false;
  /** 收割工厂返 null（显式禁用）——终态：永不复活、也不阻退出。 */
  let reapDone = false;
  let stopped = false;

  const reviveSticky = (): void => {
    const w = opts.stickyDutyFn(() => {
      stickyIdleExited = true;
      reconcile();
    });
    stickyIdleExited = w === null; // 非 darwin 防御（runHideEnforcerCli 已预检）
  };

  const reviveReap = (): void => {
    const r = opts.reapDutyFn(() => {
      reapIdleExited = true;
      reconcile();
    });
    if (r === null) {
      reapIdleExited = true;
      reapDone = true;
    } else {
      reapIdleExited = false;
    }
  };

  function reconcile(): void {
    if (stopped) return;
    if (stickyIdleExited && opts.stickyNonEmptyFn()) {
      logFn({
        evt: "hide_enforcer_duty_revived",
        duty: "sticky",
        note: "R3-F1: sticky account refilled after watchdog idle-exit (dead-window relaunch); re-arming reassert host",
      });
      reviveSticky();
    }
    if (!reapDone && reapIdleExited && opts.reapNonEmptyFn()) {
      logFn({
        evt: "hide_enforcer_duty_revived",
        duty: "idle_reaper",
        note: "R3-F1: ledger refilled after reaper idle-exit; re-arming idle reaper",
      });
      reviveReap();
    }
    const bothIdleExited = stickyIdleExited && reapIdleExited;
    // 收割显式禁用（reapDone）时台账非空不阻退出（a1 spec 5c 语义：禁用收割
    // = 用户裁决，执守只保留粘滞复隐职责——台账内容由 chrome-stop/停机收尾）。
    const reapSideClear = reapDone || !opts.reapNonEmptyFn();
    if (bothIdleExited && !opts.stickyNonEmptyFn() && reapSideClear) {
      // 退出前新鲜读双账（任一非空已被上方复活分支拦截）——check-then-exit
      // 的竞态窗收窄到本函数内 ms 级。
      stopped = true;
      clearInterval(timer);
      opts.onBothIdle();
    }
  }

  const timer = setInterval(reconcile, reconcileIntervalMs);
  timer.unref();
  // 首启经同一 revive 入口（首启与复活同路径，无第二套装配）
  reviveSticky();
  reviveReap();
  return {
    reconcile,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * CLI 入口（index.ts 子命令 `hide-enforcer` 路由）——执守进程主体。
 *
 * 行为：
 *  1. 入口自检：probe 发现「别的执守在世」（pid ≠ 自己）→ 立即 exit 0 让位
 *     （并发双起的收敛出口）
 *  2. 自写 pidfile（父进程可能没写成 / 已被覆盖——自己 pid 是唯一权威）
 *  3. startDualDutyEnforcer 双职责自愈监护（R3-F1）：
 *     - 粘滞复隐职责：startDesiredHideWatchdog({ exitWhenIdleTicks: 2 })
 *     - idle 收割职责：startEnforcerIdleReaper（BUG-03 A1 第二职责）
 *     - 职责自杀后账面重新非空 → 复活（死窗内新 launch 重新获得执守）
 *     - 两职责都自杀且两账皆空（退出前新鲜读）→ process.exit
 *  4. SIGTERM/SIGINT → 干净退出（不挣扎）
 *
 * @param opts.defaultIdleMs 收割阈值（index.ts 路由传 config.launchIdleMs——
 *        显式 env/config 禁用收割（0）时执守只保留粘滞复隐职责，尊重用户裁决）
 */
export async function runHideEnforcerCli(
  opts: { defaultIdleMs?: number } = {},
): Promise<void> {
  const probe = probeHideEnforcer();
  if (probe.running && probe.pid !== process.pid) {
    // 并发双起收敛：已在世的执守继续，本进程让位
    process.exit(0);
  }
  // 非 darwin：reassert 原语 darwin-only（startDesiredHideWatchdog 唯一返 null
  // 条件），无执守对象立即退（既有语义）
  if (process.platform !== "darwin") {
    process.exit(0);
  }
  // P2 处置轮：CLI 主体统一 stderr 结构化日志（与 watchdog logFn 同款）——
  // 自写 pidfile 失败不再被默认 no-op logFn 吞掉（hide_enforcer_pidfile_error
  // 事件此前全库不可达）。
  const cliLogFn = (p: Record<string, unknown>) =>
    process.stderr.write(`${JSON.stringify({ ts: Date.now(), ...p })}\n`);
  writeEnforcerPidfile(process.pid, cliLogFn);
  // PERF-2a 起改静态 import（同目录模块，INV-64 合规；
  // startWatchdogUnlessEnforcerRunning 也需要同步引用）
  const dual = startDualDutyEnforcer({
    stickyDutyFn: (onIdleExit) =>
      startDesiredHideWatchdog({
        exitWhenIdleTicks: 2,
        onIdleExit,
        logFn: cliLogFn,
      }),
    reapDutyFn: (onIdleExit) =>
      startEnforcerIdleReaper({
        defaultIdleMs: opts.defaultIdleMs,
        logFn: (p) => cliLogFn({ ...p, scope: "enforcer_reaper" }),
        onIdleExit,
      }),
    stickyNonEmptyFn: () => readDesiredHiddenSync().length > 0,
    reapNonEmptyFn: () =>
      readLedgerSync().some((r) =>
        // 与 startEnforcerIdleReaper 缺省 readLedgerFn 同款过滤（日常档两形态；
        // 单一真源常量无法直接复用——此处是谓词非全量读，注释锚定同源语义）
        ["hidden", "headless"].includes(r.launchMode ?? "hidden"),
      ),
    onBothIdle: () => process.exit(0),
    logFn: cliLogFn,
  });
  // watchdog timer unref（不阻 server 退出）——独立进程需显式持活
  const keepAlive = setInterval(() => {}, 60_000);
  const bye = () => {
    clearInterval(keepAlive);
    dual.stop();
    process.exit(0);
  };
  process.once("SIGTERM", bye);
  process.once("SIGINT", bye);
  // 不 process.exit——keep-alive 持活，等双职责自退闩 / 信号
}
