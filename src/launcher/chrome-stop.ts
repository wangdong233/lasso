/**
 * chrome-stop.ts（v1.9 parse17 §3.4 机制二 —— 按台账收尾 lasso 起的 Chrome）
 *
 * 单条记录的关闭流程（红线机械化——只杀「记录在案且 cmdline 验证归属」的 pid）：
 *   1. process.kill(pid, 0) 探活 → ESRCH → already_dead → 删台账条目，返回
 *   2. ps -p <pid> -o command= 读完整命令行
 *      ├ 含 `--user-data-dir=${profileDir}`（lasso 隔离 profile 标记）→ 归属验证通过
 *      └ 不含 → pid 已被复用或不是我们的 Chrome → **绝不 kill** → pid_reused_skipped → 删陈旧条目
 *   3. SIGTERM → 轮询存活 ≤2s（200ms 步进）
 *   4. 仍活 → killTreeSync(pid)（pgrep -P 递归 SIGKILL，收 Chrome helper 子进程）
 *   5. 删台账条目 → killed
 *
 * 与 SubprocessManager 共享 util/kill-tree.ts 单一树杀真源（INV-77a 守；
 * 禁第二套 pgrep 递归实现漂移）。
 *
 * CLI：`lasso-mcp chrome-stop [--port N|--all]`（index.ts 子命令路由）。
 * 无 flag = --all（台账本身已 scoped 到 lasso-owned + 验证归属，全清是安全默认）。
 * 幂等：无记录也 exit 0。
 *
 * INV-64 衍生：只 import node:* 内置 + ../util/kill-tree.js（v1.9 显式豁免的
 * 共享 lifecycle 原语；INV-64 (b) 白名单）+ ./chrome-ledger.js 同目录互引。
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { killTreeSync } from "../util/kill-tree.js";
import {
  readLedgerSync,
  removeLedgerEntries,
  removeLedgerEntriesSync,
  type LedgerLogFn,
} from "./chrome-ledger.js";

// ============================================================
// 类型
// ============================================================
export interface ChromeStopOptions {
  /** 只关这个 port 的记录；与 all 二选一；都不传 = --all。 */
  port?: number;
  /** 全部台账记录。 */
  all?: boolean;
  /** 测试注入：pid 探活（默认 process.kill(pid, 0)）。 */
  aliveFn?: (pid: number) => boolean;
  /** 测试注入：ps -p <pid> -o command= 输出（默认真实 spawnSync ps）。 */
  psFn?: (pid: number) => string;
  /** 测试注入：树杀原语（默认 util/kill-tree killTreeSync）。 */
  killTreeFn?: (pid: number) => void;
  /** 测试注入：SIGTERM 后轮询等待（默认 200ms 步进 × ≤2s）。 */
  sleepFn?: (ms: number) => Promise<void>;
  /** 结构化日志注入（index.ts 用 logger 包）。 */
  logFn?: LedgerLogFn;
}

export type ChromeStopAction = "killed" | "already_dead" | "pid_reused_skipped";

export interface ChromeStopResult {
  stopped: Array<{ port: number; pid: number; action: ChromeStopAction }>;
}

// ============================================================
// 归属验证（红线：只杀验证通过的 pid）
// ============================================================
/**
 * cmdline 归属验证：ps -p <pid> -o command= 输出含 `--user-data-dir=<profileDir>`
 * 精确子串（lasso spawn 时始终注入的隔离 profile 标记，W1-DEF-7）才认定 pid 仍是
 * 我们起的 Chrome。pid 复用（台账是陈旧记录、pid 已被无关进程占用）在此被拦截。
 *
 * 精确性：marker 后必须是空白或命令行结尾（`--user-data-dir=/x/y` 不匹配
 * `--user-data-dir=/x/y-evil` 前缀拼接种）。
 */
export function verifyOwnership(
  pid: number,
  profileDir: string,
  psFn: (pid: number) => string,
): boolean {
  // 真机形状：ps 输出行尾恒带 "\n"（v1.9 真机验证 V2 白盒实锤——marker 是 Chrome
  // cmdline 最后一参时 after === "\n"，不剥行尾换行会把刚 launch 的 Chrome 误判
  // pid_reused_skipped → 只清台账不杀 → 孤儿 Chrome。单测注入 psFn 无换行曾掩盖此路径）。
  // 只剥「行尾」换行：换行后还有内容（换行拼接种）仍不通过。
  const cmdline = psFn(pid).replace(/[\r\n]+$/, "");
  const marker = `--user-data-dir=${profileDir}`;
  const idx = cmdline.indexOf(marker);
  if (idx === -1) return false;
  const after = cmdline[idx + marker.length];
  return after === undefined || after === " " || after === "\t";
}

/** 默认 ps 读取（macOS/Linux 同形：`ps -p <pid> -o command=` 输出完整命令行）。 */
function defaultPsFn(pid: number): string {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1000,
    });
    // 行尾换行的规范化在 verifyOwnership 内统一做（单一真源；此处原样返回）。
    return r.stdout ?? "";
  } catch {
    return "";
  }
}

/** 默认探活（signal 0）。 */
function defaultAliveFn(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** SIGTERM 优雅窗口（parse17 §3.4 步骤 3）：2s / 200ms 步进。 */
const GRACE_POLL_MS = 200;
const GRACE_TOTAL_MS = 2_000;

// ============================================================
// 主入口（async 路径：CLI / server 优雅停机）
// ============================================================
export async function stopLaunchedChromes(
  opts: ChromeStopOptions = {},
): Promise<ChromeStopResult> {
  const log = opts.logFn ?? (() => {});
  const aliveFn = opts.aliveFn ?? defaultAliveFn;
  const psFn = opts.psFn ?? defaultPsFn;
  const killTreeFn = opts.killTreeFn ?? ((pid: number) => killTreeSync(pid, "chrome-stop"));
  const sleepFn = opts.sleepFn ?? defaultSleep;

  const ledger = readLedgerSync();
  const targets = opts.port !== undefined
    ? ledger.filter((r) => r.port === opts.port)
    : ledger; // 无 port = --all

  const stopped: ChromeStopResult["stopped"] = [];
  for (const rec of targets) {
    // 1. 探活
    if (!aliveFn(rec.pid)) {
      stopped.push({ port: rec.port, pid: rec.pid, action: "already_dead" });
      continue;
    }
    // 2. cmdline 归属验证（红线：验证不通过绝不 kill）
    if (!verifyOwnership(rec.pid, rec.profileDir, psFn)) {
      log({
        evt: "chrome_stop_pid_reused_skipped",
        port: rec.port,
        pid: rec.pid,
        note: "cmdline lacks --user-data-dir marker; stale ledger entry removed without kill",
      });
      stopped.push({ port: rec.port, pid: rec.pid, action: "pid_reused_skipped" });
      continue;
    }
    // 3. SIGTERM 优雅 + 轮询 ≤2s
    try {
      process.kill(rec.pid, "SIGTERM");
    } catch {
      // SIGTERM 发出失败（权限/竞态死亡）→ 走树杀兜底
    }
    let dead = false;
    for (let waited = 0; waited < GRACE_TOTAL_MS; waited += GRACE_POLL_MS) {
      await sleepFn(GRACE_POLL_MS);
      if (!aliveFn(rec.pid)) {
        dead = true;
        break;
      }
    }
    // 4. 仍活 → 树杀（共享原语；收 Chrome helper 子进程）
    if (!dead) killTreeFn(rec.pid);
    stopped.push({ port: rec.port, pid: rec.pid, action: "killed" });
    log({ evt: "chrome_stop_result", port: rec.port, pid: rec.pid, action: "killed", tree_kill: !dead });
  }

  // 5. 删台账条目（全部已处理记录——含 already_dead / pid_reused_skipped 的陈旧条目）
  if (stopped.length > 0) {
    await removeLedgerEntries(
      stopped.map((s) => s.port),
      log,
    );
  }
  return { stopped };
}

// ============================================================
// 同步路径（process.on("exit") 钩子；零 await 纪律——W1-DEF-6 先例）
// ============================================================
/**
 * 同步版收尾：readLedgerSync + ps 验证 + killTreeSync 直杀（跳过 SIGTERM 优雅步
 * ——exit 钩子不能等）。红线同上：cmdline 验证不通过绝不 kill，只清陈旧台账。
 */
export function stopLaunchedChromesSync(logFn?: LedgerLogFn): ChromeStopResult {
  const log = logFn ?? (() => {});
  const ledger = readLedgerSync();
  const stopped: ChromeStopResult["stopped"] = [];
  for (const rec of ledger) {
    if (!defaultAliveFn(rec.pid)) {
      stopped.push({ port: rec.port, pid: rec.pid, action: "already_dead" });
      continue;
    }
    if (!verifyOwnership(rec.pid, rec.profileDir, defaultPsFn)) {
      stopped.push({ port: rec.port, pid: rec.pid, action: "pid_reused_skipped" });
      continue;
    }
    killTreeSync(rec.pid, "chrome-stop-exit");
    stopped.push({ port: rec.port, pid: rec.pid, action: "killed" });
  }
  if (stopped.length > 0) {
    removeLedgerEntriesSync(
      stopped.map((s) => s.port),
      log,
    );
  }
  return { stopped };
}

// ============================================================
// CLI 入口（`lasso-mcp chrome-stop [--port N|--all]`）
// ============================================================
/**
 * argv 解析：--port N / --all / --help。都不传 = --all（安全默认）。
 * 单独导出便于单测（不 spawn 真进程）。
 */
export function parseChromeStopArgs(argv: string[]): ChromeStopOptions {
  const opts: ChromeStopOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") continue;
    if (a === "--port") {
      const n = argv[i + 1] ? parseInt(argv[i + 1]!, 10) : NaN;
      if (!Number.isNaN(n)) opts.port = n;
      i++;
    } else if (a === "--all") {
      opts.all = true;
    }
    // 未知 flag 忽略（forward-compat）
  }
  return opts;
}

/** CLI 主入口：打印 JSON 结果 + exit 0（幂等：无记录也 0）。 */
export async function runChromeStopCli(
  argv: string[] = process.argv.slice(3),
): Promise<void> {
  const opts = parseChromeStopArgs(argv);
  const result = await stopLaunchedChromes(opts);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}
