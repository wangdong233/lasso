/**
 * render-guardian.ts（v1.19 渲染档设计决议 裁决一 —— detached 渲染执守进程）
 *
 * 形态 (c)：照 desired-hide-enforcer 既有模式逐条复刻——pidfile 单例 + ps cmdline
 * 标记复验 + 后到者让位 + 账空自退（连续 2 tick 台账无 render 记录）。
 *
 * 关键解耦（设计决议 1.1）：Chrome 本体持有者 =「无人」（detached PPID=1 + 磁盘台账
 * 共有制）。执守进程不是持有者，只是**收割调度器**（chrome-idle-reaper）的宿主——
 * 消费方 / lasso server / 执守任一方死亡均不杀 Chrome。
 *
 * 🔴 持活（r2 修订，独立进程生死线）：startChromeIdleReaper 的调度 timer 是
 * unref()（为「server 进程内」形态设计）——执守是独立进程，若不另持 ref'd
 * keep-alive，入口函数返回后事件循环即空 → 毫秒级退出，执守出生即死。照
 * runHideEnforcerCli（desired-hide-enforcer.ts）既有解法持一个 **ref'd**
 * `setInterval(() => {}, 60_000)`；onIdleExit 与 SIGTERM/SIGINT 统一清除后
 * process.exit(0)；主流程不裸 process.exit。进程级真退由
 * test/integration/render-guardian-process.spec.ts 钉死（DI 单测测不出）。
 *
 * 拉起时机（r2：ensure 成功路径全分支）：`render-chrome --ensure` 一切 exit 0 出口
 * （fresh / reused:true / 单飞败者转正）均调 ensureRenderGuardianRunning()——
 * guardian 一死（kill -9 / 机器事件）后续 ensure 全走 reused:true 永不补拉 →
 * 无收割宿主 → Chrome + profile 无限期滞留（P0 泄漏形态复活）。probe = readFile +
 * kill(0) + ps 三 syscall 级开销，guardian 在世时零 spawn。server 启动**不**拉执守
 * （渲染档与 MCP server 生命周期零耦合 = R2「--ensure 不依赖 server 存活」的反向对称）。
 *
 * INV-64 修订合规：只 import node:* 内置 + ../launcher/* + ./render-flags.js。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readLedgerSync, type LedgerLogFn } from "../launcher/chrome-ledger.js";
import { stopLaunchedChromes } from "../launcher/chrome-stop.js";
import {
  startChromeIdleReaper,
  CHROME_IDLE_REAPER_INTERVAL_MS,
  type ChromeIdleReaper,
} from "../launcher/chrome-idle-reaper.js";
import { renderIdleDefaultMs } from "./render-flags.js";

/** 执守进程 ps cmdline 标记（spawn argv 自带；复验防 pid 复用假阳性）。 */
export const RENDER_GUARDIAN_CMDLINE_MARKER = "render-guardian";

/** pidfile 路径（env LASSO_RENDER_GUARDIAN_PID_PATH 覆盖；测试隔离 + 并行验收隔离用，配方见 doc/渲染档-并行验收隔离配方.md）。 */
export function renderGuardianPidPath(): string {
  const override = process.env.LASSO_RENDER_GUARDIAN_PID_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".cache", "lasso", "render-guardian.json");
}

/**
 * CLI 入口 js 路径（hideEnforcerEntryPath 同款「dist 布局一级之隔」教训直接继承：
 * dist/render/ → dist/index.js；src 布局下解析为 src/index.js（不存在，源是 .ts）
 * → accessSync 诚实降级 entry_missing——tsx 开发形态无执守，server 内 reaper 兜底）。
 */
export function renderGuardianEntryPath(): string {
  return fileURLToPath(new URL("../index.js", import.meta.url));
}

export interface RenderGuardianProbe {
  running: boolean;
  pid?: number;
  reason: "no_pidfile" | "pidfile_invalid" | "pid_dead" | "pid_reused" | "ok";
}

/**
 * 探测执守进程是否在世（纯读；DI 注入测试）。活判定三重（hide-enforcer 同款）：
 * pidfile 可读 + pid 活 + ps cmdline 含 marker（防 pid 复用假阳性）。
 */
export function probeRenderGuardian(
  opts: {
    readPidFn?: () => string;
    psFn?: (pid: number) => string;
    aliveFn?: (pid: number) => boolean;
  } = {},
): RenderGuardianProbe {
  const readPidFn =
    opts.readPidFn ??
    (() => {
      try {
        return readFileSync(renderGuardianPidPath(), "utf8");
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
  if (!psFn(pid).includes(RENDER_GUARDIAN_CMDLINE_MARKER)) {
    return { running: false, pid, reason: "pid_reused" };
  }
  return { running: true, pid, reason: "ok" };
}

export interface EnsureRenderGuardianResult {
  /** true = 本次调用拉起了新执守；false = 已在世跳过 / 拉起失败（best-effort）。 */
  spawned: boolean;
  pid?: number;
  reason: string;
}

/** 写 pidfile（best-effort；执守子进程入口也自写——双写收敛，后到者自检让位）。 */
function writeGuardianPidfile(
  pid: number | undefined,
  logFn: (p: Record<string, unknown>) => void = () => {},
): void {
  if (pid === undefined) return;
  try {
    const target = renderGuardianPidPath();
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ pid, startedAt: Date.now() })}\n`, "utf8");
  } catch (e) {
    logFn({ evt: "render_guardian_pidfile_error", error: String(e) });
  }
}

/**
 * 确保执守进程在世（launchRenderChrome 一切 exit 0 出口调用；r2 全分支补拉）。
 * detached + stdio:ignore + unref——调用方（短命 ensure CLI）退出后执守继续。
 * best-effort：spawn/写 pidfile 失败不抛（执守是增强面，永不阻断 ensure 主流程）。
 * LASSO_RENDER_IDLE_MS ≤ 0 = 显式 opt-out 不收割 → 不拉执守（无收割对象，
 * 拉了也会立即自退——防「ensure → spawn → 秒退 → 下次 ensure 再 spawn」噪声循环）。
 */
export async function ensureRenderGuardianRunning(
  opts: {
    spawnFn?: (cmd: string, args: string[]) => ChildProcess;
    probe?: RenderGuardianProbe;
    entry?: string;
    /** 测试注入：idle opt-out 判定（默认 renderIdleDefaultMs()）。 */
    idleMs?: number;
    logFn?: (payload: Record<string, unknown>) => void;
  } = {},
): Promise<EnsureRenderGuardianResult> {
  const logFn = opts.logFn ?? (() => {});
  const idleMs = opts.idleMs ?? renderIdleDefaultMs();
  if (idleMs <= 0) {
    return { spawned: false, reason: "idle_opt_out" };
  }
  const probe = opts.probe ?? probeRenderGuardian();
  if (probe.running) {
    return { spawned: false, pid: probe.pid, reason: "already_running" };
  }
  const entry = opts.entry ?? renderGuardianEntryPath();
  try {
    accessSync(entry);
  } catch {
    // 布局异常（无 index.js）——诚实降级：server 内 reaper 仍在（若 server 存活）
    logFn({ evt: "render_guardian_entry_missing", entry });
    return { spawned: false, reason: "entry_missing" };
  }
  const spawnFn =
    opts.spawnFn ??
    ((cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: "ignore" }));
  try {
    const child = spawnFn(process.execPath, [entry, RENDER_GUARDIAN_CMDLINE_MARKER]);
    child.unref();
    const pid = child.pid;
    writeGuardianPidfile(pid, logFn);
    logFn({ evt: "render_guardian_spawned", pid, previous: probe.reason });
    return { spawned: true, pid, reason: "spawned" };
  } catch (e) {
    logFn({ evt: "render_guardian_spawn_error", error: String(e) });
    return { spawned: false, reason: `spawn_error:${String(e).slice(0, 80)}` };
  }
}

// ============================================================
// 执守体（CLI 主体——index.ts 子命令 `render-guardian` 路由）
// ============================================================
/** 执守内嵌 reaper 的调度周期压缩 env（默认 15s；测试/基准压缩用——非产品旋钮）。 */
export function renderGuardianReaperIntervalMs(): number {
  const raw = process.env.LASSO_RENDER_REAPER_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return CHROME_IDLE_REAPER_INTERVAL_MS;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return CHROME_IDLE_REAPER_INTERVAL_MS;
  return n;
}

export interface AssembledRenderGuardian {
  /** ref'd keep-alive（r2 生死线：无它执守出生即死——hasRef() 断言钉死）。 */
  keepAlive: NodeJS.Timeout;
  reaper: ChromeIdleReaper;
  /** 统一停机口（onIdleExit / SIGTERM / SIGINT 三路共用）。 */
  shutdown(): void;
}

/**
 * 执守装配体（DI 可注入；runRenderGuardianCli 的可测内核）：
 * 入口让位自检已由调用方完成，本函数只负责「reaper + keep-alive + 信号面」装配。
 * reaper timer 是 unref 的（server 进程内形态语义）——独立进程必须持 ref'd
 * keep-alive 才不退（desired-hide-enforcer runHideEnforcerCli 同款）。
 */
export function assembleRenderGuardian(
  opts: {
    defaultIdleMs?: number;
    intervalMs?: number;
    startReaperFn?: typeof startChromeIdleReaper;
    readLedgerFn?: () => ReturnType<typeof readLedgerSync>;
    stopFn?: (o: { port: number }) => Promise<unknown>;
    logFn?: LedgerLogFn;
    onShutdown?: () => void;
  } = {},
): AssembledRenderGuardian | null {
  const cliLogFn: LedgerLogFn =
    opts.logFn ?? ((p) => process.stderr.write(`${JSON.stringify({ ts: Date.now(), ...p })}\n`));
  const defaultIdleMs = opts.defaultIdleMs ?? renderIdleDefaultMs();
  const startReaper = opts.startReaperFn ?? startChromeIdleReaper;
  // 过滤 render 记录 = 零核心改动（DI 注入既有的读面——设计决议 1.3）
  const readLedgerFn =
    opts.readLedgerFn ?? (() => readLedgerSync().filter((r) => r.launchMode === "render"));
  const stopFn =
    opts.stopFn ??
    (async (o: { port: number }) => stopLaunchedChromes({ port: o.port, logFn: cliLogFn }));
  // reaper timer 全 unref（chrome-idle-reaper.ts:192）——独立进程的持活由下方
  // ref'd keep-alive 承担（r2）
  const reaper = startReaper({
    defaultIdleMs,
    intervalMs: opts.intervalMs ?? renderGuardianReaperIntervalMs(),
    readLedgerFn,
    stopFn,
    exitWhenLedgerEmptyTicks: 2, // 账空自退（设计决议 1.2）
    onIdleExit: () => {
      guardianShutdown();
    },
    logFn: cliLogFn,
  });
  if (!reaper) {
    // defaultIdleMs ≤ 0：无收割对象（显式 opt-out）——不装配，调用方直接退
    return null;
  }
  // 🔴 ref'd keep-alive（不 unref！）：reaper timer 全 unref 下独立进程的生死线
  const keepAlive = setInterval(() => {}, 60_000);
  let stopped = false;
  const guardianShutdown = () => {
    if (stopped) return; // 幂等（onIdleExit 与信号双触发）
    stopped = true;
    clearInterval(keepAlive);
    reaper.stop();
    opts.onShutdown?.();
  };
  return {
    keepAlive,
    reaper,
    shutdown: guardianShutdown,
  };
}

/**
 * CLI 入口（index.ts 子命令 `render-guardian` 路由）——执守进程主体。
 *
 * 行为（runHideEnforcerCli 同形）：
 *  1. 入口自检：probe 发现「别的执守在世」（pid ≠ 自己）→ 立即 exit 0 让位
 *  2. 自写 pidfile（父进程可能没写成 / 已被覆盖——自己 pid 是唯一权威）
 *  3. assembleRenderGuardian：内嵌 reaper（readLedgerFn 过滤 render + 账空 2 tick
 *     自退）+ **ref'd keep-alive 持活**
 *  4. SIGTERM/SIGINT / 账空自退 → 统一 shutdown（清 keep-alive + reaper.stop +
 *     exit 0，不挣扎）
 */
export async function runRenderGuardianCli(
  opts: {
    probe?: RenderGuardianProbe;
    assemble?: typeof assembleRenderGuardian;
    exitFn?: (code?: number) => never;
  } = {},
): Promise<void> {
  const exit = opts.exitFn ?? ((code?: number) => process.exit(code));
  const probe = opts.probe ?? probeRenderGuardian();
  if (probe.running && probe.pid !== process.pid) {
    // 并发双起收敛：已在世的执守继续，本进程让位
    exit(0);
    return;
  }
  const cliLogFn: LedgerLogFn = (p) =>
    process.stderr.write(`${JSON.stringify({ ts: Date.now(), ...p })}\n`);
  writeGuardianPidfile(process.pid, cliLogFn);
  logGuardianUp(cliLogFn);
  const assemble = opts.assemble ?? assembleRenderGuardian;
  // 账空自退（onIdleExit）与 SIGTERM/SIGINT 三路统一收口到 shutdown：
  // 清 keep-alive + reaper.stop + exit(0)（设计决议 1.2 持活项 / 3.8）
  const g = assemble({ logFn: cliLogFn, onShutdown: () => exit(0) });
  if (!g) {
    // idle opt-out（LASSO_RENDER_IDLE_MS ≤ 0）：无收割对象，立即退
    exit(0);
    return;
  }
  const bye = () => {
    g.shutdown();
    exit(0);
  };
  process.once("SIGTERM", bye);
  process.once("SIGINT", bye);
  // 不裸 process.exit——keep-alive 持活，等账空自退（onIdleExit → shutdown）或信号
}

/** 执守上线日志（stderr 单行 JSON；日志经注入 logFn 走 stderr——设计决议 3.8）。 */
function logGuardianUp(logFn: LedgerLogFn): void {
  logFn({
    evt: "render_guardian_up",
    pid: process.pid,
    idle_ms: renderIdleDefaultMs(),
    interval_ms: renderGuardianReaperIntervalMs(),
  });
}
