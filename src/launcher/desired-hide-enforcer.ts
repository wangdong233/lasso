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
 *    收割（startEnforcerIdleReaper，见下）；双职责都账空自退才 exit
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
  startDesiredHideWatchdog,
  type DesiredHideWatchdog,
  type DesiredHideWatchdogOptions,
} from "./desired-hide-watchdog.js";
// BUG-03 决议 A1（doc/bugs/03 §4 A1）：执守进程语义扩为「粘滞复隐 + hidden 档
// idle 收割」双职责——复用既有 hide-enforcer 单例（零新守护进程，守用户红线
// 「不出现新的项目之外的组件」；render 档不动，render-guardian 自管）。
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
 * readLedgerFn 过滤 launchMode==="hidden"（不动 render：render-guardian 自管；
 * visible 由 reaper 内部既有豁免）。touch 续命契约不变
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
      (() => readLedgerSync().filter((r) => r.launchMode === "hidden")),
    nowFn: opts.nowFn,
    stopFn: opts.stopFn,
    touchStatFn: opts.touchStatFn,
    exitWhenLedgerEmptyTicks: opts.exitWhenLedgerEmptyTicks ?? 2,
    onIdleExit: opts.onIdleExit,
    logFn: opts.logFn,
  });
}

/**
 * CLI 入口（index.ts 子命令 `hide-enforcer` 路由）——执守进程主体。
 *
 * 行为：
 *  1. 入口自检：probe 发现「别的执守在世」（pid ≠ 自己）→ 立即 exit 0 让位
 *     （并发双起的收敛出口）
 *  2. 自写 pidfile（父进程可能没写成 / 已被覆盖——自己 pid 是唯一权威）
 *  3. startDesiredHideWatchdog({ exitWhenIdleTicks: 2 })——粘滞账连续 2 tick
 *     为空自退；watchdog timer 是 unref 的，另持一个 ref'd keep-alive 维持进程
 *  4. BUG-03 A1：startEnforcerIdleReaper 双职责第二职责（hidden 档 idle 收割）；
 *     两职责各配独立自退——**双职责都自退才 process.exit**（单职责退出不杀另一
 *     职责：粘滞账空但 hidden 台账仍活跃时执守必须留下收割；反之亦然）
 *  5. SIGTERM/SIGINT → 干净退出（不挣扎）
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
  // P2 处置轮：CLI 主体统一 stderr 结构化日志（与 watchdog logFn 同款）——
  // 自写 pidfile 失败不再被默认 no-op logFn 吞掉（hide_enforcer_pidfile_error
  // 事件此前全库不可达）。
  const cliLogFn = (p: Record<string, unknown>) =>
    process.stderr.write(`${JSON.stringify({ ts: Date.now(), ...p })}\n`);
  writeEnforcerPidfile(process.pid, cliLogFn);
  // BUG-03 A1：双职责自退闩——两职责都 idle 自退才 exit（单职责退出只标记）。
  let stickyIdleExited = false;
  let reapIdleExited = false;
  const tryExit = (): void => {
    if (stickyIdleExited && reapIdleExited) process.exit(0);
  };
  // PERF-2a 起改静态 import（同目录模块，INV-64 合规；
  // startWatchdogUnlessEnforcerRunning 也需要同步引用）
  const watchdog = startDesiredHideWatchdog({
    exitWhenIdleTicks: 2,
    onIdleExit: () => {
      stickyIdleExited = true;
      tryExit();
    },
    logFn: cliLogFn,
  });
  if (!watchdog) {
    // 非 darwin：无执守对象（reassert 原语 darwin-only），立即退
    process.exit(0);
  }
  // BUG-03 A1 第二职责：hidden 档 idle 收割（defaultIdleMs ≤ 0 = 显式禁用收割，
  // 返回 null 只标记该职责已空，不阻粘滞复隐职责）
  const reaper = startEnforcerIdleReaper({
    defaultIdleMs: opts.defaultIdleMs,
    logFn: (p) => cliLogFn({ ...p, scope: "enforcer_reaper" }),
    onIdleExit: () => {
      reapIdleExited = true;
      tryExit();
    },
  });
  if (!reaper) reapIdleExited = true;
  // watchdog timer unref（不阻 server 退出）——独立进程需显式持活
  const keepAlive = setInterval(() => {}, 60_000);
  const bye = () => {
    clearInterval(keepAlive);
    watchdog.stop();
    reaper?.stop();
    process.exit(0);
  };
  process.once("SIGTERM", bye);
  process.once("SIGINT", bye);
  // 不 process.exit——keep-alive 持活，等双职责自退闩 / 信号
}
