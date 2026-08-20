/**
 * launch-chrome（parse11 §3.3 v1.0 Phase D 跨平台 Chrome launcher）
 *
 * 职责（单一，简单）：探测本机 Chrome / Chromium 二进制 → spawn 子进程
 * 带 `--remote-debugging-port=9222`（供 browse_logged_in 复用登录态）。
 *
 * 不做的事（守 R-CI-02 + INV-64）：
 *  - 不引新 npm dep（仅 node:child_process / node:path / node:fs / node:process / node:url；
 *    INV-64 grep 守：launcher/*.ts 只 import node:* 内置 + 同目录模块 + ../util/kill-tree.js 豁免）
 *  - 不装 Chrome（parse11 §1.2 守；用户手动装；本 launcher 只探测 + spawn）
 *  - **v1.9（parse17 §3.3 机制二）承诺修订**：spawn 后仍 detached、进程内不做 lifecycle
 *    管理；但 spawn 成功（含 cdp_not_ready 慢启动）即登记磁盘台账
 *    ~/.cache/lasso/launched-chromes.json（port/pid/profileDir）——`lasso-mcp
 *    chrome-stop` 子命令与 server 停机路径按台账收尾（只杀台账在案且 cmdline
 *    验证 `--user-data-dir` 归属的 pid）。
 *  - 不缓存路径探测结果（每次 launch 都重探；用户可能在不同 shell 装到不同路径）
 *
 * 与 doctor #5 chrome_binary 关系（守不开第二套）：
 *  - doctor #5 只验「Chrome 存在」（pass/warn，不 spawn）
 *  - launch-chrome 多一步：找到后 spawn 加 --remote-debugging-port=9222
 *  - 两者复用 chrome-paths.ts 候选路径表（单一真源；R-CI-02）
 *
 * INV-21 衍生：本文件无平台 AX / UIA / AT-SPI 字面量。
 *
 * macOS-only 现实红线（parse11 §1.3）：本机 macOS-only 可证 spawn；
 * Win/Linux 路径仅 CI Linux runner 验 shape；真机 spawn 手测留 parse11-acceptance.md
 * #W7（Windows）/ #L7（Linux）pending。
 *
 * CLI 入口：经 index.ts 子命令路由（`lasso launch-chrome`），转调 runLaunchChromeCli。
 * 本文件是纯模块，不在底部 auto-execute（避免 dist/launcher/launch-chrome.js 单独可执行
 * 与 index.ts 子命令路由重复）。
 *
 * 借鉴：parse11 §3.3；puppeteer.launch({ executablePath }) 范式（不引 puppeteer）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as Net from "node:net";
import os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  chromeCandidatesForPlatform,
  type ChromePathCandidate,
} from "./chrome-paths.js";
import { recordLaunch, type LedgerLogFn } from "./chrome-ledger.js";
// v1.10（parse18 §3.3 机制二）：macOS 隐藏保险丝（PID 定向；非 mac no-op）
// P31（v1.18.3 同类横扫 S4）：默认走异步 hideChromeByPidAsync（execFile）——
// 本函数经 MCP chrome-launch 工具进 server 进程，spawnSync osascript（2s 上限）
// 在请求路径上同步阻塞事件循环（与 P27 已修的 watchdog 同机制同阻塞面）。
import { hideChromeByPidAsync, type ChromeHideResult } from "./chrome-hide.js";

// ============================================================
// 类型
// ============================================================
/**
 * launchChrome 的入参。
 *
 *  - port           ：CDP 端口（默认 9222，与 doctor #6 cdp_9222_logged_in 对齐）
 *  - profileDir     ：user-data-dir（可选；多 profile 隔离用；默认走 Chrome 内置 profile）
 *  - extraArgs      ：附加命令行参数（如 --incognito / --start-maximized）
 *  - platform       ：注入 platform（测试 mock 用）；生产路径走 process.platform
 *  - programFiles等 ：Windows env 注入（测试 mock 用）
 */
export interface LaunchChromeOptions {
  port?: number;
  profileDir?: string;
  extraArgs?: string[];
  platform?: "mac" | "win" | "linux" | "unknown";
  programFiles?: string;
  programFilesX86?: string;
  localAppData?: string;
  /** 测试注入：mock existsSync（生产路径走 node:fs.access X_OK） */
  probeExists?: (p: string) => Promise<boolean>;
  /** 测试注入：mock spawn（生产路径走 node:child_process.spawn） */
  spawnFn?: (
    cmd: string,
    args: string[],
    opts: { detached: boolean; stdio: "ignore" | "pipe" },
  ) => ChildProcess;
  /**
   * 测试注入：mock /json/version 探活 fetch（W1-DEF-7）。
   * 生产路径走 global fetch + 1s 超时；返回 { ok } 即可（只看 HTTP 可达）。
   */
  fetchFn?: (url: string) => Promise<{ ok: boolean }>;
  /** 探活轮询间隔（默认 300ms；测试传 1ms 提速）。W1-DEF-7。 */
  probeIntervalMs?: number;
  /**
   * 探活轮询次数覆盖（P8 v1.18.1 测试注入）。缺省按 launchMode 分档：
   * hidden = CDP_PROBE_ATTEMPTS（3s）；visible = CDP_PROBE_ATTEMPTS_VISIBLE（12s）。
   */
  probeAttempts?: number;
  /**
   * 覆盖默认隔离 profile 目录（测试注入）。
   * 生产默认 ~/.cache/lasso/chrome-profile-default（W1-DEF-7）。
   */
  defaultProfileDir?: string;
  /**
   * v1.10（parse18 §3.2 机制二）：启动档。模块默认保守 "visible"（v1.9 形态）；
   * "hidden" 由 CLI/config 层传入（config 默认层 LASSO_LAUNCH_MODE=hidden）。
   * hidden = `--no-startup-window`（mac/linux，E7 实证零打扰）+
   *          win 追加 `--start-minimized`；visible = v1.9 现状 + 恒加三件套。
   */
  launchMode?: "hidden" | "visible";
  /** v1.10（parse18 §2.5）：per-launch idle 覆盖（落台账；reaper 按记录判定）。 */
  idleMs?: number;
  /** 测试注入：mock 隐藏保险丝（生产走 chrome-hide.ts hideChromeByPidAsync——
   *  P31 起异步；返回 Promise 或裸结果均可，调用点统一 await）。 */
  hideFn?: (pid: number | undefined) => ChromeHideResult | Promise<ChromeHideResult>;
  /** 保险丝延迟（默认 1.5s；测试传 1ms 提速）。 */
  fuseDelayMs?: number;
  /**
   * P3（v1.17.3，得到实战）：TCP 层占用探测注入。预检 /json/version 非 ok/抛错
   * 但端口 TCP 可连时，说明端口被**非 CDP 进程**占住（实测：用户日常 Chrome 的
   * 内部服务占 9222 IPv4）——继续 spawn 会导致 Chrome CDP 绑定静默失败
   * （报 cdp_not_ready 而进程活着，难排查）。注入式设计：核心缺省不探测
   * （既有测试 preCheckOk:false 语义不破），CLI 装配层传真实实现。
   */
  tcpProbeFn?: (port: number) => Promise<boolean>;
  /** 结构化日志注入（默认 stderr 单行 JSON；index.ts 侧可用 logger 包）。 */
  logFn?: LedgerLogFn;
}

/**
 * P3：真实 TCP 可连性探测（300ms 超时）。connect 成功=端口被某进程占住。
 * 仅 CLI 装配层注入；单测注入 stub。
 */
export function tcpConnectable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Net.Socket();
    socket.setTimeout(300);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

/**
 * launchChrome 的输出。
 *
 *  - ok         : true=成功 spawn；false=未找到 Chrome 或 spawn 失败
 *  - binaryPath : 找到的 Chrome 二进制路径（ok=true 时）
 *  - pid        : spawn 的子进程 pid（ok=true 时）
 *  - port       : CDP 端口（echo back；用户接 browse_logged_in 用）
 *  - candidateSources : 探测过的候选路径来源（debug 用；ok=false 时用户看哪条没找到）
 *  - error      : 失败原因（ok=false 时）
 */
export interface LaunchChromeResult {
  ok: boolean;
  binaryPath?: string;
  pid?: number;
  port: number;
  /** 实际使用的 --user-data-dir（W1-DEF-7：默认注入隔离 profile；echo back 便于复用） */
  profileDir?: string;
  candidateSources?: Array<{ source: string; path: string; desc: string }>;
  error?: string;
  /**
   * P8（v1.18.1）：error=cdp_not_ready 时为 true——Chrome 可能仍在慢启动，
   * 调用方可选择等待复探（curl /json/version）而非判死。
   */
  mayStillBeStarting?: boolean;
}

// ============================================================
// W1-DEF-7（v1.8 Phase B）常量：CDP 探活
// ============================================================
/** 探活轮询次数（hidden 档）：3s 窗口内 10 次（默认 300ms 间隔）。 */
export const CDP_PROBE_ATTEMPTS = 10;
/**
 * P8（v1.18.1，得到实战问题集 P8）：visible 档探活轮询次数——12s 窗口。
 * 可见档冷启动（首窗口创建 + profile 恢复，重 profile / 低速盘 / 高负载时）
 * 实测可超 3s（主循环亲历 ok:false cdp_not_ready 但 Chrome 实起）；hidden 档
 * 无窗口创建，1.7s 内即通（chrome_ledger_recorded→chrome_hide_fuse_ok 实测），
 * 维持 10 次。
 */
export const CDP_PROBE_ATTEMPTS_VISIBLE = 40;
/** 探活轮询默认间隔。 */
export const CDP_PROBE_INTERVAL_MS = 300;
/** 单次探活 fetch 超时（默认 fetchFn 用 AbortSignal.timeout）。 */
const CDP_PROBE_FETCH_TIMEOUT_MS = 1_000;

/**
 * 默认隔离 profile 目录（W1-DEF-7）：~/.cache/lasso/chrome-profile-default。
 *
 * 背景（wave1 U-04-1 / T-LI-11）：不带 --user-data-dir 时 Chrome 136+ 对默认
 * profile 禁远程调试 + 单例转发 → spawn 立即退出、9222 永不可用。
 */
export function defaultChromeProfileDir(): string {
  return path.join(os.homedir(), ".cache", "lasso", "chrome-profile-default");
}

/** CDP /json/version 探活 URL（只绑 127.0.0.1，与 --remote-debugging-port 一致）。 */
function cdpVersionUrl(port: number): string {
  return `http://127.0.0.1:${port}/json/version`;
}

// ============================================================
// v1.10（parse18 §3.2 机制二）：hidden 档 flag 集 + 反节流三件套
// ============================================================
/**
 * 反节流三件套 + 静音（**两档恒加**，parse18 §3.2）：对齐 puppeteer-core
 * defaultArgs 产业标准（ChromeLauncher.js:150/151/163）——后台/遮挡窗口的 rAF 与
 * 定时器不被钳档（V7 实测 200ms interval 被钳 1s；E-量化 ~35-40% 合并开销）；
 * agent 浏览器永不发声（visible 档也静音，文档明示）。flag 字面量直接写在
 * args 构造处（INV-78a grep 圈定 hidden 分支控制流）。
 */
/** fallback 离屏档（E5：窗口出屏但接受 <1s 焦点闪现；对未文档化开关漂移的保险）。 */
export const OFFSCREEN_POSITION_FLAG = "--window-position=-32000,-32000";

/** macOS 隐藏保险丝延迟（spawn 稳定后补一次 PID 定向 hide）。 */
export const HIDE_FUSE_DELAY_MS = 1_500;

/** exact-string 去重（用户 extraArgs 与默认 flag 同串不双发；parse18 §3.2）。 */
function dedupeArgs(args: string[]): string[] {
  return [...new Set(args)];
}

/** launcher 侧结构化日志兜底（同 chrome-ledger defaultLog 形态；INV-64 不引 logger）。 */
function defaultLaunchLog(payload: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ ts: Date.now(), ...payload })}\n`);
}

/**
 * 默认探活 fetch：global fetch + 1s 超时。
 * 网络错（ECONNREFUSED / 超时）→ throw → 调用方按「未就绪」处理。
 */
async function defaultProbeFetch(url: string): Promise<{ ok: boolean }> {
  return fetch(url, { signal: AbortSignal.timeout(CDP_PROBE_FETCH_TIMEOUT_MS) });
}

// ============================================================
// 主入口
// ============================================================
/**
 * 探测 Chrome → spawn with --remote-debugging-port=N → CDP 探活（W1-DEF-7）。
 *
 * 设计（parse11 §3.3 + v1.8 Phase B W1-DEF-7）：
 *  1. chromeCandidatesForPlatform() 按平台取候选列表
 *  2. 顺序 fs.access(p, X_OK) 探测；第一个存在的胜出
 *  3. 端口占用预检：/json/version 已有响应 → ok=false + "port_in_use"
 *  4. spawn(binaryPath, [--remote-debugging-port=N, --user-data-dir=<隔离 profile>, ...extraArgs])
 *     - detached: true → 父进程退出后 Chrome 继续（parse11 §3.3 不接管 lifecycle）
 *     - stdio: 'ignore' → 不接管 Chrome stdout/stderr（避免 IPC 噪声）
 *     - --user-data-dir 始终注入（默认 ~/.cache/lasso/chrome-profile-default；
 *       Chrome 136+ 默认 profile 禁调试 + 单例退出，wave1 U-04-1 实锤）
 *  5. unref() → 父进程不等待 Chrome（否则 npm script 不会退出）
 *  6. CDP 探活：3s 窗口 10 次 /json/version；通才 ok:true
 *     （子进程早退 → "chrome_exited"；窗口内未通 → "cdp_not_ready"）
 *
 * 失败处理（不抛错，tri-state 诚实）：
 *  - 平台 unsupported（unknown） → ok=false + error="unsupported_platform:..."
 *  - 候选路径全不存在 → ok=false + error="chrome_not_found" + candidateSources 帮 debug
 *  - 端口被既有 Chrome 占住 → ok=false + error="port_in_use"
 *  - 子进程 spawn 后立即退出 → ok=false + error="chrome_exited"
 *  - 探活窗口内 /json/version 不通 → ok=false + error="cdp_not_ready"
 *  - spawn 同步抛错（ENOENT 等） → ok=false + error=String(e)
 *
 * @param opts 见 LaunchChromeOptions
 * @returns LaunchChromeResult（tri-state；ok=false 时 error 字段说明原因）
 */
export async function launchChrome(
  opts: LaunchChromeOptions = {},
): Promise<LaunchChromeResult> {
  const port = opts.port ?? 9222;
  const fetchFn = opts.fetchFn ?? defaultProbeFetch;
  const probeIntervalMs = opts.probeIntervalMs ?? CDP_PROBE_INTERVAL_MS;
  const mode0 = opts.launchMode ?? "visible"; // 模块默认保守 visible；hidden 由 CLI/config 层传
  // P8（v1.18.1）：探活窗口按档分档——visible 冷启动（首窗口 + profile 恢复）
  // 实测可超 3s，给 12s；hidden 无窗口创建维持 3s。
  const probeAttempts =
    opts.probeAttempts ??
    (mode0 === "visible" ? CDP_PROBE_ATTEMPTS_VISIBLE : CDP_PROBE_ATTEMPTS);
  // W1-DEF-7：默认注入隔离 --user-data-dir（显式 --profile 优先）。
  const profileDir =
    opts.profileDir ?? opts.defaultProfileDir ?? defaultChromeProfileDir();

  // 1. 取候选列表
  const candidates = chromeCandidatesForPlatform({
    platform: opts.platform,
    programFiles: opts.programFiles,
    programFilesX86: opts.programFilesX86,
    localAppData: opts.localAppData,
  });

  if (candidates.length === 0) {
    return {
      ok: false,
      port,
      error: `unsupported_platform:${opts.platform ?? process.platform}`,
    };
  }

  // 2. 顺序探测
  const probe = opts.probeExists ?? defaultProbe;
  let found: ChromePathCandidate | null = null;
  const candidateSources: LaunchChromeResult["candidateSources"] = [];
  for (const c of candidates) {
    const exists = await probe(c.path);
    candidateSources.push({
      source: c.source,
      path: c.path,
      desc: c.desc,
    });
    if (exists) {
      found = c;
      break;
    }
  }

  if (!found) {
    return {
      ok: false,
      port,
      candidateSources,
      error: "chrome_not_found",
    };
  }

  // 3. 端口占用预检（W1-DEF-7）：spawn 前探一次 /json/version——
  //    已有响应说明端口被既有 Chrome 占住（wave1 实锤：旧 Chrome pid 占 9222，
  //    新 Chrome 立即退出但占口者代答，曾误报 ok:true）。拒绝启动。
  try {
    const pre = await fetchFn(cdpVersionUrl(port));
    if (pre.ok) {
      return {
        ok: false,
        binaryPath: found.path,
        port,
        profileDir,
        candidateSources,
        error: "port_in_use",
      };
    }
  } catch {
    // 连不上 = 端口空闲或被非 CDP 进程占住（P3：tcpProbeFn 注入时区分）
  }
  // P3（v1.17.3）：/json/version 非 ok / 抛错，但 TCP 层可连 → 非 CDP 进程占口。
  // 继续spawn 会让 Chrome 绑定静默失败（cdp_not_ready 假象）。诚实拒绝并建议换口。
  if (opts.tcpProbeFn && (await opts.tcpProbeFn(port))) {
    return {
      ok: false,
      binaryPath: found.path,
      port,
      profileDir,
      candidateSources,
      error: `port_in_use_non_cdp:port ${port} is TCP-occupied by a non-CDP process (Chrome bind would silently fail); launch with a different --port`,
    };
  }

  // 4. 构造 args（W1-DEF-7：始终带 --user-data-dir，默认隔离 profile；
  //    v1.10 parse18 §3.2：launchMode 分档 + 反节流三件套/mute 两档恒加 + 去重）
  const mode = mode0; // P8：解析上移至函数头（探活窗口分档需先知 mode）
  const plat = opts.platform ?? process.platform;
  const log = opts.logFn ?? defaultLaunchLog;
  const hideFn = opts.hideFn ?? ((pid: number | undefined) => hideChromeByPidAsync(pid));
  const args: string[] = [
    `--remote-debugging-port=${port}`,
    `--no-first-run`,
    `--no-default-browser-check`,
    `--user-data-dir=${profileDir}`,
    // 反节流三件套 + 静音：两档恒加（visible 档无窗口之争但后台 tab 同样受益）
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--mute-audio",
  ];
  if (mode === "hidden") {
    // 平台分档（platform 注入已有，测试可 mock win）
    if (plat === "win") args.push("--start-minimized");
    // win 同加 --no-startup-window：--start-minimized 对部分 Chrome 版本被忽略
    args.push("--no-startup-window");
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }
  const finalArgs = dedupeArgs(args);
  // 隔离 profile 目录 best-effort 创建（不存在时 Chrome 会自建，失败不阻断）
  try {
    await fs.mkdir(profileDir, { recursive: true });
  } catch {
    /* best-effort */
  }

  // 5. 单次 spawn + CDP 探活 attempt（v1.10 抽出为本地闭包以支撑 hidden 档 fallback 链）
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  type AttemptOutcome = "ok" | "exited" | "not_ready" | "spawn_error";
  const attempt = async (
    spawnArgs: string[],
  ): Promise<{ outcome: AttemptOutcome; pid?: number; error?: string }> => {
    let child: ChildProcess;
    try {
      child = spawnFn(found.path, spawnArgs, {
        detached: true,
        stdio: "ignore",
      });
    } catch (e) {
      return { outcome: "spawn_error", error: String(e) };
    }
    // W1-DEF-7：子进程早退检测（默认 profile 单例 / 二进制损坏时 spawn 后立即退出）
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    child.unref();
    const pid = child.pid ?? undefined;
    // 6. CDP 探活轮询（W1-DEF-7）：3s 窗口内 10 次 /json/version，通才 ok
    for (let attemptNo = 0; attemptNo < probeAttempts; attemptNo++) {
      if (exited) break;
      try {
        const r = await fetchFn(cdpVersionUrl(port));
        if (r.ok) return { outcome: "ok", pid };
      } catch {
        /* 未就绪，继续轮询 */
      }
      await new Promise((r) => setTimeout(r, probeIntervalMs));
    }
    return { outcome: exited ? "exited" : "not_ready", pid };
  };

  // macOS 隐藏保险丝（parse18 §3.3）：hidden 档 spawn 成功后补一次 PID 定向
  // hide（chrome-hide 内部非 mac no-op / TCC 缺失降级不 fail）。
  // F1（v1.10.0 收尾修复，真机验证 03 发现）：原 1.5s 延迟 timer 在 CLI 路径被
  // process.exit 击败（fuse 永不触发）——改为立即执行（osascript 对刚 spawn 的
  // pid 即有效）；fuseDelayMs 保留参数兼容但不再延迟。
  // P31（v1.18.3 同类横扫 S4）：hideFn 默认 execFile 异步（MCP chrome-launch
  // 请求路径零事件循环阻塞）后，**await 在 launchChrome 返回前完成**——CLI 路径
  // runLaunchChromeCli 返回后随即 process.exit，fire-and-forget 会重演 F1
  // 「保险丝被 exit 击败」；await 形态下 fuse 完成（或 4s 超时上限）先于返回，
  // F1 修复在异步形态下保持。
  const scheduleHideFuse = async (pid: number | undefined): Promise<void> => {
    if (mode !== "hidden") return;
    const r = await hideFn(pid);
    log({
      evt: r.ok ? "chrome_hide_fuse_ok" : "chrome_hide_fuse_denied",
      pid,
      ...(r.reason ? { reason: r.reason } : {}),
    });
  };

  const okResult = (pid: number | undefined): LaunchChromeResult => ({
    ok: true,
    binaryPath: found.path,
    pid,
    port,
    profileDir,
  });

  // 7. primary attempt
  const primary = await attempt(finalArgs);
  if (primary.outcome === "spawn_error") {
    return {
      ok: false,
      binaryPath: found.path,
      port,
      profileDir,
      candidateSources,
      error: primary.error,
    };
  }
  if (primary.outcome === "ok") {
    // v1.9（parse17 §3.3 机制二）：ok=true 返回前落盘台账（chrome-stop /
    // server 停机 / v1.10 idle reaper 按记录收尾）。pid undefined（spawn 竞态）
    // 跳过；写失败 best-effort（recordLaunch 内部 catch）。
    if (primary.pid !== undefined) {
      await recordLaunch({
        port,
        pid: primary.pid,
        profileDir,
        launchedAt: Date.now(),
        status: "ready",
        launchMode: mode,
        idleMs: opts.idleMs,
      });
    }
    await scheduleHideFuse(primary.pid);
    return okResult(primary.pid);
  }

  // 8. fallback 链（parse18 §3.2）：hidden 档 primary 启动即退（未来 Chrome 移除
  //    未文档化 --no-startup-window 的形态）→ 离屏 --window-position 重试一次；
  //    再失败按现状返 chrome_exited（不第三次重试）。
  if (primary.outcome === "exited" && mode === "hidden") {
    log({
      evt: "launch_mode_fallback",
      from: "--no-startup-window",
      to: OFFSCREEN_POSITION_FLAG,
      port,
    });
    const second = await attempt(
      finalArgs.map((a) => (a === "--no-startup-window" ? OFFSCREEN_POSITION_FLAG : a)),
    );
    if (second.outcome === "ok") {
      if (second.pid !== undefined) {
        await recordLaunch({
          port,
          pid: second.pid,
          profileDir,
          launchedAt: Date.now(),
          status: "ready",
          launchMode: mode,
          idleMs: opts.idleMs,
        });
      }
      await scheduleHideFuse(second.pid);
      return okResult(second.pid);
    }
    if (second.outcome === "spawn_error") {
      return {
        ok: false,
        binaryPath: found.path,
        port,
        profileDir,
        candidateSources,
        error: second.error,
      };
    }
    return {
      ok: false,
      binaryPath: found.path,
      pid: second.pid,
      port,
      profileDir,
      candidateSources,
      error: "chrome_exited",
    };
  }

  // 探活失败：诚实返 ok:false + 原因（chrome_exited / cdp_not_ready）。
  // 注意：cdp_not_ready 时 Chrome 可能仍在慢启动——launch 时刻仍不代 kill（会误杀
  // 慢启动 Chrome，wave2 U-04-1 实证 pid 74620）；但 v1.9 起登记台账，后续
  // chrome-stop / 停机收尾 / v1.10 idle reaper 可按记录（cmdline 验证归属后）
  // 关闭——这是对「不代 kill」承诺的精确化而非推翻：不在 launch 时刻杀，在收尾
  // 时刻杀（归属可验证）。
  const exited = primary.outcome === "exited";
  const pid = primary.pid;
  if (!exited && pid !== undefined) {
    await recordLaunch({
      port,
      pid,
      profileDir,
      launchedAt: Date.now(),
      status: "cdp_not_ready",
      launchMode: mode,
      idleMs: opts.idleMs,
    });
  }
  return {
    ok: false,
    binaryPath: found.path,
    pid,
    port,
    profileDir,
    candidateSources,
    error: exited ? "chrome_exited" : "cdp_not_ready",
    // P8（v1.18.1）：cdp_not_ready ≠ 启动失败——Chrome 可能仍在慢启动（探活窗口
    // 已按 visible 档放宽到 12s，仍超窗时显式告知调用方「可等待复探后再判」，
    // 别按 ok:false 走清理/重试逻辑误杀活进程）。chrome_exited 不带此标记。
    ...(exited ? {} : { mayStillBeStarting: true }),
  };
}

// ============================================================
// CLI 入口（`lasso launch-chrome [--port N] [--profile <dir>]`）
// ============================================================
/**
 * CLI argv 解析 + 调 launchChrome + 打印 JSON 结果。
 *
 * 用法：
 *   lasso launch-chrome                          # 默认 :9222（mode 走 config 层默认 hidden）
 *   lasso launch-chrome --port 9223              # 改端口
 *   lasso launch-chrome --profile /tmp/lasso-chrome-profile  # 隔离 profile
 *   lasso launch-chrome --mode hidden            # 0 窗口零打扰档（默认）
 *   lasso launch-chrome --mode visible           # v1.9 可见行为
 *   lasso launch-chrome --idle-ms 3600000        # 本次 launch 的 idle 覆盖（1h）
 *   lasso launch-chrome --incognito              # 加 --incognito 参数
 *
 * 优先级：argv > config.json（index.ts CLI 入口先 loadConfig 再经 defaults 传入；
 * launcher 不 import config 模块保 INV-64）> 内置默认（visible——保守）。
 *
 * exit code：
 *  - 0  → ok=true（Chrome 已 spawn）
 *  - 1  → ok=false（未找到 Chrome / spawn 失败 / unsupported_platform）
 *
 * 进程内不接管 Chrome lifecycle：spawn 后本 CLI 退出，Chrome detached 继续跑。
 * v1.9（parse17 机制二）：spawn 已登记磁盘台账 launched-chromes.json——
 * `lasso-mcp chrome-stop [--port N|--all]` 与 server 停机路径按台账收尾
 * （只杀 cmdline 验证 `--user-data-dir` 归属的 pid）。
 * v1.10（parse18 §5.1 诚实边界）：CLI 短命进程无 idle reaper——「用完即关」
 * 调度器只活在 server 进程；CLI 起的 Chrome 关闭出口是 chrome-stop / 手动。
 *
 * INV-64 衍生：本函数只解析 argv + 调 launchChrome；不引新 dep。
 */
export async function runLaunchChromeCli(
  argv: string[] = process.argv.slice(3),
  defaults?: { launchMode?: "hidden" | "visible"; idleMs?: number; tcpProbeFn?: (port: number) => Promise<boolean> },
): Promise<void> {
  const opts = mergeLaunchDefaults(parseLaunchChromeArgs(argv), defaults);
  const result = await launchChrome(opts);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

/**
 * argv > config.json 文件层 > 内置默认 的合并（parse18 §8.3 跨边界同步对 2）。
 *
 * 单独导出纯函数便于单测（不 spawn）——index.ts CLI 入口先 loadConfig 解析
 * config.json 再以 defaults 传入；launcher 不 import config 模块保 INV-64。
 */
export function mergeLaunchDefaults(
  opts: LaunchChromeOptions,
  defaults?: { launchMode?: "hidden" | "visible"; idleMs?: number; tcpProbeFn?: (port: number) => Promise<boolean> },
): LaunchChromeOptions {
  if (!opts.launchMode && defaults?.launchMode) opts.launchMode = defaults.launchMode;
  // P3（v1.17.3）：CLI 装配层注入的 TCP 探测透传（核心缺省不探测）
  if (!opts.tcpProbeFn && defaults?.tcpProbeFn) opts.tcpProbeFn = defaults.tcpProbeFn;
  if (opts.idleMs === undefined && defaults?.idleMs !== undefined) {
    opts.idleMs = defaults.idleMs;
  }
  return opts;
}

/**
 * argv → LaunchChromeOptions 解析（parse11 §3.3 + parse18 §3.2 v1.10）。
 *
 * 单独导出便于单测直接调用（不每次 spawn child_process）。
 *
 * 支持的 flag：
 *  - --port <N>          ：CDP 端口（默认 9222）
 *  - --profile <dir>     ：user-data-dir
 *  - --mode <hidden|visible>：启动档（v1.10；非法值忽略走 config/内置默认）
 *  - --idle-ms <N>       ：per-launch idle 覆盖（v1.10；负数忽略）
 *  - --incognito         ：等价 --extra-args=--incognito 的快捷 flag
 *  - --extra-args <args> ：附加 Chrome 命令行参数（逗号分隔，如 "--incognito,--start-maximized"）
 *  - --help / -h         ：打印用法（解析忽略，由 caller 处理）
 */
export function parseLaunchChromeArgs(
  argv: string[],
): LaunchChromeOptions {
  const opts: LaunchChromeOptions = {};
  const extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") continue; // caller 处理
    if (a === "--port") {
      const v = argv[i + 1];
      const n = v ? parseInt(v, 10) : NaN;
      if (!Number.isNaN(n)) opts.port = n;
      i++;
    } else if (a === "--profile") {
      opts.profileDir = argv[i + 1];
      i++;
    } else if (a === "--mode") {
      const v = argv[i + 1];
      if (v === "hidden" || v === "visible") opts.launchMode = v;
      i++;
    } else if (a === "--idle-ms") {
      const v = argv[i + 1];
      const n = v ? parseInt(v, 10) : NaN;
      if (!Number.isNaN(n) && n >= 0) opts.idleMs = n;
      i++;
    } else if (a === "--incognito") {
      extra.push("--incognito");
    } else if (a === "--extra-args") {
      const v = argv[i + 1] ?? "";
      for (const piece of v.split(",").map((s) => s.trim()).filter(Boolean)) {
        extra.push(piece);
      }
      i++;
    }
    // 未知 flag 忽略（forward-compat；不抛错守简单性）
  }
  if (extra.length > 0) opts.extraArgs = extra;
  return opts;
}

// ============================================================
// 默认 probe / spawn（生产路径用；测试 mock 注入）
// ============================================================
/**
 * 默认 existsSync 探测：fs.access(p, X_OK) → true/false。
 *
 * node:fs.access X_OK 检查可执行位（Linux/macOS）；Windows 上 X_OK 是 no-op
 * （Windows 无可执行位概念；access 仍返 0 = 路径存在）。
 */
async function defaultProbe(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 默认 spawn：透传 node:child_process.spawn。
 *
 * 单独包一层是为了让测试 mock spawnFn 时不污染 node:child_process module。
 */
function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { detached: boolean; stdio: "ignore" | "pipe" },
): ChildProcess {
  return spawn(cmd, args, opts);
}

// ============================================================
// 测试用导出（internal；生产路径不调）
// ============================================================
/**
 * import.meta.url → file path 的安全包装（兼容 Node 20+ 的 URL 格式；测试 mock 路径用）。
 *
 * 单独导出便于 launch-chrome.spec.ts 测 isMain 判定逻辑（不在此处自动 invoke；
 * CLI 入口经 index.ts 子命令路由）。
 */
export function fileUrlToPathSafe(url: string): string {
  try {
    return fileURLToPath(url);
  } catch {
    return url;
  }
}

/**
 * 测试 only：暴露 defaultProbe / defaultSpawn 让单测覆盖默认路径
 * （不污染 import 级 mock）。
 */
export const __testDefaults = {
  defaultProbe,
  defaultSpawn,
};
