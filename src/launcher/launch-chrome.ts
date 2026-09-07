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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { recordLaunch, readLedgerSync, isUserOwnedRecord, type LedgerLogFn, type LaunchedChromeRecord } from "./chrome-ledger.js";
// BUG-03 决议 A2/E①（doc/bugs/03 §4 A2）：port_in_use_non_cdp 前的台账归因——
// 自家挂死 Chrome（CDP 死进程活）收尸重拉（render 档 ensure 四条件门同语义）。
import { verifyOwnership, stopLaunchedChromes } from "./chrome-stop.js";
// v1.10（parse18 §3.3 机制二）：macOS 隐藏保险丝（PID 定向；非 mac no-op）
// P31（v1.18.3 同类横扫 S4）：默认走异步 hideChromeByPidAsync（execFile）——
// 本函数经 MCP chrome-launch 工具进 server 进程，spawnSync osascript（2s 上限）
// 在请求路径上同步阻塞事件循环（与 P27 已修的 watchdog 同机制同阻塞面）。
import { hideChromeByPidAsync, type ChromeHideResult } from "./chrome-hide.js";
// bug02 隐藏全生命周期（v1.18.5，doc/bugs/02 隐藏洞）：hidden 档出生写粘滞账 +
// 独立执守进程；外部 touch 活动信号（reaper 侧消费，此处成功路径自 touch）。
import { addDesiredHidden } from "./desired-hide-state.js";
import { ensureHideEnforcerRunning } from "./desired-hide-enforcer.js";
import { touchChromePort } from "./chrome-touch.js";

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
   * BUG-03 决议 B2（doc/bugs/03 §4 B2）：扩 "headless"——`--headless=new` 可选档：
   * 零窗口/零 AX 面的纯抓取形态（复用 render 档 headless 经验）。
   * 🔴 对抗复审 r1（2026-09-08）真机证伪：B2 原始声明「不注册 Foreground LS
   * session、结构性不占 Dock 槽位」**不成立**——仅有 headless 实例在世时
   * `open -a "Google Chrome"` 不另起新实例，激活仍被同 bundle id 单实例槽位吸收
   * 且零可见反馈（症状②的无窗变体）。有人用的机器用 hidden（+B1 让位门）。
   * 代价 = 无法 chrome-show（登录交互流破碎）——不切默认（hidden+B1 让位门
   * 仍默认），仅 CLI `--mode headless` 显式可选；config 层 launchMode 不扩
   * （LASSO_LAUNCH_MODE 仍 hidden|visible，防误配把登录工作流切到无头形态）。
   */
  launchMode?: "hidden" | "visible" | "headless";
  /** v1.10（parse18 §2.5）：per-launch idle 覆盖（落台账；reaper 按记录判定）。 */
  idleMs?: number;
  /**
   * BUG-03 决议 A1（doc/bugs/03 §4 A1）：拉起者身份（落台账 ownerKind/ownerPid——
   * 停机不连坐的归属主键）。缺省 "cli"（launchChrome 现网唯一在世入口 =
   * runLaunchChromeCli 短命进程，spawn 后即 process.exit 且不注册 exit 收割钩子，
   * 其 ownerPid 天然不在任何 server 的收割范围 = CLI 起的 Chrome 不被 server 退出
   * 连坐）。MCP chrome-launch 工具若复活（P31 历史在案）传 "server"。
   */
  ownerKind?: "server" | "cli";
  /** 测试注入：mock 隐藏保险丝（生产走 chrome-hide.ts hideChromeByPidAsync——
   *  P31 起异步；返回 Promise 或裸结果均可，调用点统一 await）。 */
  hideFn?: (pid: number | undefined) => ChromeHideResult | Promise<ChromeHideResult>;
  // P2 处置轮：删除 fuseDelayMs? 死参数——F1（v1.10）改立即执行后实现零读取
  // （v1.10 起只余「保留参数兼容」的假注释，5 处测试传 1 是 placebo）。
  /**
   * bug02（v1.18.5）测试注入：隐藏全生命周期的执守启动（默认
   * ensureHideEnforcerRunning——真实 spawn detached 进程；测试注入 no-op 防真起）。
   * 粘滞账写盘走真实 addDesiredHidden（spec 侧 env LASSO_DESIRED_HIDDEN_PATH 隔离，
   * 与台账 LASSO_LAUNCHED_CHROMES_PATH 同款范式）。
   */
  ensureEnforcerFn?: () => Promise<unknown>;
  /**
   * P3（v1.17.3，得到实战）：TCP 层占用探测注入。预检 /json/version 非 ok/抛错
   * 但端口 TCP 可连时，说明端口被**非 CDP 进程**占住（实测：用户日常 Chrome 的
   * 内部服务占 9222 IPv4）——继续 spawn 会导致 Chrome CDP 绑定静默失败
   * （报 cdp_not_ready 而进程活着，难排查）。注入式设计：核心缺省不探测
   * （既有测试 preCheckOk:false 语义不破），CLI 装配层传真实实现。
   */
  tcpProbeFn?: (port: number) => Promise<boolean>;
  /**
   * BUG-03 决议 A2/E①（doc/bugs/03 §4 A2）测试注入：TCP 占用归因用的台账读
   * （默认 readLedgerSync）。占用者 == 台账在案 pid 且归属验证通过 → 判自家
   * 挂死 Chrome → 收尸重拉（stopZombieFn）。
   */
  readLedgerFn?: () => LaunchedChromeRecord[];
  /** A2 测试注入：僵尸收尸出口（默认 stopLaunchedChromes({port})——验证杀路径）。 */
  stopZombieFn?: (o: { port: number }) => Promise<unknown>;
  /** A2 测试注入：pid 探活（默认 process.kill(pid,0)）。 */
  aliveFn?: (pid: number) => boolean;
  /** A2 测试注入：ps cmdline（归属验证；默认 spawnSync ps）。 */
  psFn?: (pid: number) => string;
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
  //    （BUG-03 A2 起结构化日志在此步前可用——僵尸归因分支需要打点）
  const log = opts.logFn ?? defaultLaunchLog;
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
    // BUG-03 决议 A2/E①（doc/bugs/03 §4 A2，消费方①僵尸占位根治）：占用者归因——
    // 台账在案 + pid 活 + cmdline 归属验证通过 = **自家挂死 Chrome**（CDP 死进程活，
    // 曾被误归因「非 CDP 进程」建议换口 → doctor 死循环）→ 收尸重拉（render 档
    // ensure 的 stale_record_collected 同语义：stopLaunchedChromes 验证路径收尸后
    // 走下方正常 spawn，不提前 return）；归因不成立 = 用户资产/外部进程占口 →
    // 三分类出口（决议 C：永不代杀用户资产——禁 kill 指引进错误契约）。
    const readLedgerFn = opts.readLedgerFn ?? readLedgerSync;
    const zombieStopFn =
      opts.stopZombieFn ?? (async (o: { port: number }) => stopLaunchedChromes({ port: o.port }));
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
    const psFn = opts.psFn ?? ((pid: number) => psCommandlineForZombie(pid));
    const zombie = readLedgerFn().find((r) => r.port === port);
    // BUG-03 adversarial r2 F1（2026-09-08）：僵尸可收面收窄——**用户拥有记录
    // （isUserOwnedRecord：userTakenAt 已认领 / visible 登录窗）永不进程序化收尸**。
    // r1 事故型真机复现：chrome-show 认领（userTakenAt 落账）+ SIGSTOP 模拟 CDP
    // 死 → relaunch 同口 → A2 门整窗杀掉已认领 Chrome——违反 markUserTakenByPid
    // 契约「唯一关闭出口 = 用户自己关或显式 chrome-stop」（v1.17.3 P1 同型）。
    // render 档记录同样不收（render-guardian 自管，日常档入口不越权）。
    const zombieOwnedAlive =
      zombie !== undefined &&
      aliveFn(zombie.pid) &&
      verifyOwnership(zombie.pid, zombie.profileDir, psFn);
    const zombieCollectible =
      zombieOwnedAlive &&
      zombie !== undefined &&
      !isUserOwnedRecord(zombie) &&
      zombie.launchMode !== "render";
    if (zombieCollectible && zombie) {
      log({
        evt: "ledger_zombie_collected",
        port,
        pid: zombie.pid,
        note: "self-owned dead-CDP chrome detected at port_in_use_non_cdp gate; collecting via verified stop path then relaunching",
      });
      await zombieStopFn({ port });
      // 收尸后端口已释放 → 落入正常 spawn 流程（primary attempt）
    } else if (zombieOwnedAlive && zombie) {
      // BUG-03 adversarial r2 F1：占用者 = 台账在案且归属验证通过、但**用户拥有**
      // （isUserOwnedRecord）或非本门管辖（render）→ 永不自动收尸，如实拒绝。
      // 这是 r1 事故型（已认领窗口被 relaunch 整窗杀掉）的根治分支。
      log({
        evt: "ledger_user_owned_not_collected",
        port,
        pid: zombie.pid,
        userTakenAt: zombie.userTakenAt,
        launchMode: zombie.launchMode,
        note: "occupier is ledger-recorded but user-owned (claimed/visible) or guardian-managed (render); never auto-killed; only exits are the user closing it or an explicit chrome-stop",
      });
      return {
        ok: false,
        binaryPath: found.path,
        port,
        profileDir,
        candidateSources,
        error:
          `port_in_use_non_cdp:port ${port} is TCP-occupied by a lasso-launched Chrome that is currently ` +
          `USER-OWNED (user_taken_asset:${zombie.userTakenAt !== undefined ? "claimed via user activation or explicit chrome-show" : `launchMode=${zombie.launchMode}`})` +
          `${zombie.launchMode === "render" ? " or guardian-managed (render)" : ""}. ` +
          `lasso will NEVER auto-kill it (never_kill_user_asset) — its ONLY exits are the user closing the window ` +
          `themselves or the user explicitly running chrome-stop --port ${port}. ` +
          `Options: (1) retry with a different --port; (2) report to the user to decide (they close it or run ` +
          `chrome-stop themselves). Agents must not run chrome-stop against a user_taken_asset on their own`,
      };
    } else {
      return {
        ok: false,
        binaryPath: found.path,
        port,
        profileDir,
        candidateSources,
        error:
          `port_in_use_non_cdp:port ${port} is TCP-occupied by a non-CDP process (Chrome bind would silently fail). ` +
          `Options: (1) retry with a different --port; (2) a lasso ledger zombie is self-healed automatically ` +
          `(ledger_zombie_collected event); (3) if the occupier is YOUR own Chrome or another user asset: ` +
          `lasso will NEVER kill it (never_kill_user_asset) — report to the user to decide (close it manually ` +
          `or pick another port). lasso provides no kill escape hatch for non-ledger assets by design`,
      };
    }
  }

  // 4. 构造 args（W1-DEF-7：始终带 --user-data-dir，默认隔离 profile；
  //    v1.10 parse18 §3.2：launchMode 分档 + 反节流三件套/mute 两档恒加 + 去重）
  const mode = mode0; // P8：解析上移至函数头（探活窗口分档需先知 mode）
  const plat = opts.platform ?? process.platform;
  // log 定义已上移至步骤 3 前（BUG-03 A2 僵尸归因分支打点需要）
  const hideFn = opts.hideFn ?? ((pid: number | undefined) => hideChromeByPidAsync(pid));
  const ensureEnforcerFn = opts.ensureEnforcerFn ?? (async () => { await ensureHideEnforcerRunning({ logFn: (p) => log(p) }); });
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
  if (mode === "headless") {
    // BUG-03 B2：无头档——零窗口/零 AX 面（无隐藏保险丝、无粘滞账执守），
    // 适合无人值守机器的纯抓取/外部 CDP 消费。flag 形态取 render 档冻结快照
    // 的 headless 经验（--headless=new；不 import render 模块守 INV-64——字面量
    // 本地 + render-flags provenance 注记）。
    args.push("--headless=new");
    // 对抗复审补丁（BUG-03 adversarial r1，2026-09-08 真机证伪）：macOS 上
    // `open -a "Google Chrome"` 在仅有 headless 实例在世时**不会**另起新实例——
    // 激活被同 bundle id 的 headless 实例吸收（零窗口、用户看不到任何反馈），
    // 症状②「点 Chrome 打不开」在 headless 形态下**依旧成立**（且比 hidden 更
    // 静默：hidden 有 B1 让位门会掀出窗口，headless 无窗可掀）。B2 原始声明
    // 「不占 Dock 槽位」不成立，文档已订正；此处打点让消费方可观测。
    // （plat 两种 mac 值：生产 process.platform="darwin" / 测试注入别名 "mac"，
    // 与 chrome-paths detectPlatformSimple 的归一别名同源。）
    if (plat === "darwin" || plat === "mac") {
      log({
        evt: "headless_dock_slot_caveat",
        port,
        note: "B2 claim falsified on macOS real-machine (adversarial r1): headless instance still absorbs Dock/open -a activation of com.google.Chrome (single-instance slot) with zero visible feedback; prefer hidden (+B1 yield gate) on machines a human may use",
      });
    }
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
  // pid 即有效）；fuseDelayMs 死参数已于 P2 处置轮删除（v1.10 起实现零读取）。
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
    // bug02 隐藏全生命周期（v1.18.5，doc/bugs/02 隐藏洞真机实锤）：hidden 档此前
    // 「出生即无粘滞保护」——粘滞账全库唯一写入方是 chrome-hide CLI，launch 从不
    // 写；外部 CDP 消费者掀出后（Target.createTarget 无 background / bringToFront /
    // 页面 focus）server 全活也无人复隐。fuse hide 成功即写粘滞账 + 确保独立执守
    // 进程（与 chrome-hide CLI 同语义：hide 成功 → desiredHidden 记账；chrome-show
    // 清账解除；hide 失败（非 mac / TCC 缺失）不记——与既有 CLI 降级形态一致）。
    if (r.ok && pid !== undefined) {
      await addDesiredHidden(
        { pid, port, profileDir, hiddenAt: Date.now() },
        (p) => log({ ...p, scope: "launch_hidden_birth" }),
      );
      await ensureEnforcerFn();
      log({ evt: "launch_hidden_sticky_recorded", pid, port });
    }
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
  // BUG-03 A1：归属字段（每次 recordLaunch 共用；见 LaunchChromeOptions.ownerKind 注）
  const ownerRec = {
    ownerKind: opts.ownerKind ?? "cli",
    ownerPid: process.pid,
  };
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
        ...ownerRec,
      });
      // bug02（v1.18.5）：launch 事件本身是一次活动信号（自 touch 确立约定文件）
      await touchChromePort(port, log);
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
          ...ownerRec,
        });
        await touchChromePort(port, log);
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
      ...ownerRec,
    });
    await touchChromePort(port, log);
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
 *   lasso launch-chrome --help / -h              # 打印 usage + exit 0（不 spawn Chrome）
 *
 * 优先级：argv > config.json（index.ts CLI 入口先 loadConfig 再经 defaults 传入；
 * launcher 不 import config 模块保 INV-64）> 内置默认（visible——保守）。
 *
 * exit code：
 *  - 0  → ok=true（Chrome 已 spawn）**或 --help/-h（usage 打印后短路退出）**
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
/**
 * CLI 装配层（index.ts）与测试注入共用的 defaults 包（v1.18.7 #5 起独立导出接口）。
 *
 *  - launchMode / idleMs / tcpProbeFn ：config 层默认（见 mergeLaunchDefaults）
 *  - helpText  ：--help/-h 时打印的 usage 文本。**单一真源在 index.ts CLI_USAGE**，
 *    launcher 不 import index（守 INV-64 单向依赖）→ 经注入流入。生产 CLI 恒注入；
 *    未注入时 --help 仍 exit 0 不 spawn（silent——防直调方拿到「help 反而启动
 *    Chrome」的旧 bug 形态）。
 *  - spawnFn   ：测试注入（#5 spec 断言 --help 不 spawn 用）；生产不传。
 */
export interface LaunchChromeCliDefaults {
  launchMode?: "hidden" | "visible";
  idleMs?: number;
  tcpProbeFn?: (port: number) => Promise<boolean>;
  helpText?: string;
  spawnFn?: LaunchChromeOptions["spawnFn"];
}

export async function runLaunchChromeCli(
  argv: string[] = process.argv.slice(3),
  defaults?: LaunchChromeCliDefaults,
): Promise<void> {
  // #5（v1.18.7 审查 P2 修复）：--help / -h 短路。此前 parseLaunchChromeArgs 吞掉
  // --help（注释称 "caller 处理"）但本函数从不检查 → `lasso launch-chrome --help`
  // 直接落入 launchChrome **真启动 Chrome**。修复：检测到 help flag → 打印 usage
  // （helpText 由 index.ts 以 CLI_USAGE 单一真源注入）+ exit 0，绝不进 launch 路径。
  if (argv.includes("--help") || argv.includes("-h")) {
    if (defaults?.helpText !== undefined) {
      process.stdout.write(defaults.helpText + "\n");
    }
    process.exit(0);
    return;
  }
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
  defaults?: LaunchChromeCliDefaults,
): LaunchChromeOptions {
  if (!opts.launchMode && defaults?.launchMode) opts.launchMode = defaults.launchMode;
  // P3（v1.17.3）：CLI 装配层注入的 TCP 探测透传（核心缺省不探测）
  if (!opts.tcpProbeFn && defaults?.tcpProbeFn) opts.tcpProbeFn = defaults.tcpProbeFn;
  if (opts.idleMs === undefined && defaults?.idleMs !== undefined) {
    opts.idleMs = defaults.idleMs;
  }
  // #5（v1.18.7）：测试注入 spawnFn 透传（生产不传；spec 断言 --help 短路不 spawn 用）
  if (!opts.spawnFn && defaults?.spawnFn) opts.spawnFn = defaults.spawnFn;
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
 *  - --help / -h         ：解析层忽略；runLaunchChromeCli 入口短路（打印 usage + exit 0，
 *                          #5 v1.18.7 修复——此前无人处理导致 --help 误启动 Chrome）
 */
export function parseLaunchChromeArgs(
  argv: string[],
): LaunchChromeOptions {
  const opts: LaunchChromeOptions = {};
  const extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") continue; // runLaunchChromeCli 入口短路处理（#5）
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
      // BUG-03 B2：扩 headless（CLI 显式可选；config 层不扩——防误配切默认）
      if (v === "hidden" || v === "visible" || v === "headless") opts.launchMode = v;
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

/**
 * BUG-03 A2：僵尸归因的 ps cmdline 读取（chrome-stop defaultPsFn 同形：
 * `ps -p PID -o command=`；verifyOwnership 归属验证消费）。
 */
function psCommandlineForZombie(pid: number): string {
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
