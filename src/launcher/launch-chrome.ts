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
  candidateSources?: Array<{ source: string; path: string; desc: string }>;
  error?: string;
}

// ============================================================
// 主入口
// ============================================================
/**
 * 探测 Chrome → spawn with --remote-debugging-port=N。
 *
 * 设计（parse11 §3.3）：
 *  1. chromeCandidatesForPlatform() 按平台取候选列表
 *  2. 顺序 fs.access(p, X_OK) 探测；第一个存在的胜出
 *  3. spawn(binaryPath, [--remote-debugging-port=N, --user-data-dir=..., ...extraArgs])
 *     - detached: true → 父进程退出后 Chrome 继续（parse11 §3.3 不接管 lifecycle）
 *     - stdio: 'ignore' → 不接管 Chrome stdout/stderr（避免 IPC 噪声）
 *  4. unref() → 父进程不等待 Chrome（否则 npm script 不会退出）
 *
 * 失败处理（不抛错，tri-state 诚实）：
 *  - 平台 unsupported（unknown） → ok=false + error="unsupported_platform"
 *  - 候选路径全不存在 → ok=false + error="chrome_not_found" + candidateSources 帮 debug
 *  - spawn 抛错（ENOENT 等） → ok=false + error=String(e)
 *
 * @param opts 见 LaunchChromeOptions
 * @returns LaunchChromeResult（tri-state；ok=false 时 error 字段说明原因）
 */
export async function launchChrome(
  opts: LaunchChromeOptions = {},
): Promise<LaunchChromeResult> {
  const port = opts.port ?? 9222;

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

  // 3. 构造 args
  const args: string[] = [
    `--remote-debugging-port=${port}`,
    `--no-first-run`,
    `--no-default-browser-check`,
  ];
  if (opts.profileDir) {
    args.push(`--user-data-dir=${opts.profileDir}`);
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  // 4. spawn
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  try {
    const child = spawnFn(found.path, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return {
      ok: true,
      binaryPath: found.path,
      pid: child.pid ?? undefined,
      port,
    };
  } catch (e) {
    return {
      ok: false,
      binaryPath: found.path,
      port,
      candidateSources,
      error: String(e),
    };
  }
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
