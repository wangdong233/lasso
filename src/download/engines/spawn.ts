/**
 * spawn.ts（doc/bugs/12 D4 detached + D5/H1 stdio 文件化——引擎 spawn 原语）
 *
 * 与 SubprocessManager **零依赖**（决议 D2/白盒 §1.3：manager 绑 MCP stdio
 * 生命周期，下载引擎是 detached 长跑进程，语义不同源）。语义：
 *  - detached + unref：引擎跨 lasso 重启存活（D4，render-chrome 先例同款）；
 *  - stdio = ["ignore", fd, fd]（H1 技术死穴的解）：fd=fs.openSync(stdioFile,"a")，
 *    spawn 后父进程 closeSync——子进程持有 dup，lasso 死后引擎继续写文件
 *    而非 SIGPIPE 自毁。**禁 stdio pipe**（决议红线，本文件是唯一 spawn 口）。
 *  - spawn 前可执行门（rustSpawnGate 同型 fail-fast）：ENOENT/EACCES 是确定性
 *    失败，结构化错误直接抛（不烧退避不烧 watchdog）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EngineSpawnSpec } from "../types.js";
import { logger } from "../../util/logger.js";

/**
 * 可执行文件解析（PATH 查找 + X_OK 三态门）。
 * 绝对/相对路径直接验证；裸命令名沿 PATH 扫描。返回 null=不可用。
 */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const isPathForm = command.includes("/");
  const candidates = isPathForm
    ? [path.resolve(command)]
    : (env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((d) => path.join(d, command));
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // 缺失/不可执行 → 下一候选
    }
  }
  return null;
}

export interface DetachedEngineHandle {
  pid: number;
  child: ChildProcess;
}

/**
 * detached 引擎 spawn（本批唯一 spawn 口；cmdline 归属验证依赖 argv 含
 * staging/<taskId>——由调用方 buildAria2Args/buildYtDlpArgs 保证）。
 * 返回 pid 供任务表落 enginePid。
 */
export function spawnDetachedEngine(
  command: string,
  spec: EngineSpawnSpec,
  env: NodeJS.ProcessEnv = process.env,
): DetachedEngineHandle {
  const resolved = resolveExecutable(command, { ...env, ...spec.env });
  if (!resolved) {
    throw new Error(
      `engine_not_spawnable:${command} — 二进制缺失或无执行权限；检测/引导见 bootstrap.ts`,
    );
  }
  fs.mkdirSync(path.dirname(spec.stdioFile), { recursive: true });
  // H1：stdout/stderr 同落一个追加写 fd（aria2 summary 与 yt-dlp progress
  // 模板都走 stdout；错误走 stderr——同文件混合，parser 各自锚行前缀）
  const fd = fs.openSync(spec.stdioFile, "a");
  try {
    const child = spawn(resolved, spec.args, {
      stdio: ["ignore", fd, fd],
      detached: true,
      cwd: spec.cwd,
      env: { ...env, ...spec.env },
    });
    child.unref();
    // detached+unref 后异步 spawn 错误（竞态消失等）无处投递——挂日志防
    // unhandled 'error' 崩主进程；确定性缺失已被 resolveExecutable 前置拦。
    child.on("error", (e) =>
      logger.warn({ evt: "download_engine_spawn_error", error: String(e) }),
    );
    if (typeof child.pid !== "number") {
      throw new Error(`engine_spawn_no_pid:${command}`);
    }
    logger.info({
      evt: "download_engine_spawned",
      engine: spec.engine,
      pid: child.pid,
      stdio_file: spec.stdioFile,
    });
    return { pid: child.pid, child };
  } finally {
    // 子进程已 dup fd；父进程句柄即刻关闭（否则 lasso 侧 fd 泄漏）
    fs.closeSync(fd);
  }
}

/**
 * 读文件尾部（进度 tail 解析用）。文件不存在→null；不足 maxBytes 全读。
 * 64KiB 缺省远超一次 summary/progress 窗口（5s 间隔 × 多行），够还原最近快照。
 */
export function tailFile(file: string, maxBytes = 64 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const read = Math.min(size, maxBytes);
    const buf = Buffer.alloc(read);
    fs.readSync(fd, buf, 0, read, size - read);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
