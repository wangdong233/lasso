/**
 * launch-chrome（parse11 §3.3 v1.0 Phase D 跨平台 Chrome launcher）
 *
 * 职责（单一，简单）：探测本机 Chrome / Chromium 二进制 → spawn 子进程
 * 带 `--remote-debugging-port=9222`（供 browse_logged_in 复用登录态）。
 *
 * 不做的事（守 R-CI-02 + INV-64）：
 *  - 不引新 npm dep（仅 node:child_process / node:path / node:fs / node:process / node:url；
 *    INV-64 grep 守：launcher/*.ts 只 import node:* 内置）
 *  - 不装 Chrome（parse11 §1.2 守；用户手动装；本 launcher 只探测 + spawn）
 *  - 不接管 Chrome lifecycle（spawn 后 detached；chrome 自己管 SIGTERM）
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
import os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  chromeCandidatesForPlatform,
  type ChromePathCandidate,
} from "./chrome-paths.js";

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
   * 覆盖默认隔离 profile 目录（测试注入）。
   * 生产默认 ~/.cache/lasso/chrome-profile-default（W1-DEF-7）。
   */
  defaultProfileDir?: string;
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
}

// ============================================================
// W1-DEF-7（v1.8 Phase B）常量：CDP 探活
// ============================================================
/** 探活轮询次数：3s 窗口内 10 次（默认 300ms 间隔）。 */
export const CDP_PROBE_ATTEMPTS = 10;
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
    // 连不上 = 端口空闲，继续
  }

  // 4. 构造 args（W1-DEF-7：始终带 --user-data-dir，默认隔离 profile）
  const args: string[] = [
    `--remote-debugging-port=${port}`,
    `--no-first-run`,
    `--no-default-browser-check`,
    `--user-data-dir=${profileDir}`,
  ];
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }
  // 隔离 profile 目录 best-effort 创建（不存在时 Chrome 会自建，失败不阻断）
  try {
    await fs.mkdir(profileDir, { recursive: true });
  } catch {
    /* best-effort */
  }

  // 5. spawn
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  let child: ChildProcess;
  try {
    child = spawnFn(found.path, args, {
      detached: true,
      stdio: "ignore",
    });
  } catch (e) {
    return {
      ok: false,
      binaryPath: found.path,
      port,
      profileDir,
      candidateSources,
      error: String(e),
    };
  }
  // W1-DEF-7：子进程早退检测（默认 profile 单例 / 二进制损坏时 spawn 后立即退出）
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.unref();
  const pid = child.pid ?? undefined;

  // 6. CDP 探活轮询（W1-DEF-7）：3s 窗口内 10 次 /json/version，通才 ok:true
  for (let attempt = 0; attempt < CDP_PROBE_ATTEMPTS; attempt++) {
    if (exited) break;
    try {
      const r = await fetchFn(cdpVersionUrl(port));
      if (r.ok) {
        return {
          ok: true,
          binaryPath: found.path,
          pid,
          port,
          profileDir,
        };
      }
    } catch {
      /* 未就绪，继续轮询 */
    }
    await new Promise((r) => setTimeout(r, probeIntervalMs));
  }

  // 探活失败：诚实返 ok:false + 原因（chrome_exited / cdp_not_ready）。
  // 注意：cdp_not_ready 时 Chrome 可能仍在慢启动——按既有设计不接管 lifecycle，不代 kill。
  return {
    ok: false,
    binaryPath: found.path,
    pid,
    port,
    profileDir,
    candidateSources,
    error: exited ? "chrome_exited" : "cdp_not_ready",
  };
}

// ============================================================
// CLI 入口（`lasso launch-chrome [--port N] [--profile <dir>]`）
// ============================================================
/**
 * CLI argv 解析 + 调 launchChrome + 打印 JSON 结果。
 *
 * 用法：
 *   lasso launch-chrome                          # 默认 :9222
 *   lasso launch-chrome --port 9223              # 改端口
 *   lasso launch-chrome --profile /tmp/lasso-chrome-profile  # 隔离 profile
 *   lasso launch-chrome --incognito              # 加 --incognito 参数
 *
 * exit code：
 *  - 0  → ok=true（Chrome 已 spawn）
 *  - 1  → ok=false（未找到 Chrome / spawn 失败 / unsupported_platform）
 *
 * 不接管 Chrome lifecycle：spawn 后本 CLI 退出，Chrome detached 继续跑。
 * 用户手动 kill Chrome 或 OS 关机时退出。
 *
 * INV-64 衍生：本函数只解析 argv + 调 launchChrome；不引新 dep。
 */
export async function runLaunchChromeCli(
  argv: string[] = process.argv.slice(3),
): Promise<void> {
  const opts = parseLaunchChromeArgs(argv);
  const result = await launchChrome(opts);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

/**
 * argv → LaunchChromeOptions 解析（parse11 §3.3）。
 *
 * 单独导出便于单测直接调用（不每次 spawn child_process）。
 *
 * 支持的 flag：
 *  - --port <N>          ：CDP 端口（默认 9222）
 *  - --profile <dir>     ：user-data-dir
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
