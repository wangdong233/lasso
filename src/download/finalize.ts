/**
 * finalize.ts（审查修复批 P0-1/P0-2/P1-3/P1-6——终态检测层，2026-09-20）
 *
 * fresh 审查定罪（NOT-PASS 主阻断）：三 WT 零件各自正确，但装配层缺
 * 「发动机与变速箱之间的传动轴」——detached 引擎 spawn 后无人消费其退出：
 * 任务永不 completed、交付物永滞留 staging、cancelled 被 inprocess 回调
 * 覆盖、max_bytes 存而不用。本文件是终态定谳的**单一真源**，三个触发面
 * 收敛到同一定谳函数：
 *
 *  1. exit 回调（lasso 活着）：deps.runSpawnPipeline 持 child 句柄挂
 *     "exit" 事件 → finalizeTaskOnExit(record, code)——即时定谳。
 *  2. 轮询兜底（lasso 重启后 exit 回调丢失）：readEngineSnapshot 顺带
 *     maybeFinalizeOnPoll——state 非终态 + pid 死 → 按日志内容定谳。
 *  3. 守门检查（每次拉快照）：enforceMaxBytes / enforceIdleHardCap——
 *     超帽杀树标 oversize；超时硬顶杀树标 failed。
 *
 * 幂等守卫（P1-3）：定谳写终态前 readTask 复查——state 已 cancelled/终态
 * 即跳过（多写者竞态的单一收敛点：cancel 先赢，引擎退出回调后到不覆盖）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { logger } from "../util/logger.js";
import type { DownloadTaskRecord } from "./types.js";
import { readTask, updateTaskSync } from "./store.js";
import { killEngineTree, isEnginePidAlive } from "./kill.js";
import { releaseStaging, discardStaging, stagingDirForTask } from "./engines/staging.js";
import { tailFile } from "./engines/spawn.js";
import { interpretYtDlpExit, finalizeSubtitles } from "./engines/ytdlp.js";
import { parseAria2Progress } from "./engines/aria2.js";

/** 任务级 idle 硬顶（D13/H2「不满足即回炉」项）：非终态任务 updatedAt 距今超此值即杀树收口。 */
export const DEFAULT_IDLE_HARD_CAP_MS = 24 * 60 * 60 * 1000; // 24h
/** env 覆盖键（doctor/测试可调）。 */
export const IDLE_HARD_CAP_ENV = "LASSO_DOWNLOAD_IDLE_HARD_CAP_MS";

export function idleHardCapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[IDLE_HARD_CAP_ENV]);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_IDLE_HARD_CAP_MS;
}

/** 终态集合（幂等守卫判据——与 store STATES 终态语义一致）。 */
export function isTerminalState(state: string): boolean {
  return (
    state === "completed" || state === "failed" || state === "cancelled" || state === "oversize"
  );
}

// ============================================================
// 定谳核心（exit 回调与轮询兜底收敛于此）
// ============================================================
/**
 * detached 引擎退出后的终态定谳（幂等——state 已终态跳过）。
 *
 * @param record    定谳时的任务记录（exit 回调传 spawn 前快照亦可——内部重读）
 * @param exitCode  引擎退出码（exit 回调可得；轮询兜底路径传 null 按日志定谳）
 */
export function finalizeTaskOnExit(
  record: DownloadTaskRecord,
  exitCode: number | null,
): void {
  const fresh = readTask(record.taskId);
  if (fresh === null) return; // 任务文件已删（测试清理）——无事可做
  if (isTerminalState(fresh.progress.state)) return; // 幂等守卫（P1-3：cancel 先赢不覆盖）

  const logTail = fresh.stdioFile ? tailFile(fresh.stdioFile, 16 * 1024) ?? "" : "";
  const stagingDir = stagingDirForTask(fresh.taskId);

  let verdict: { state: "completed" | "failed" | "cancelled"; diagnosis: string | null };
  if (fresh.engine === "yt-dlp") {
    verdict = interpretYtDlpExit(exitCode, logTail);
  } else if (exitCode === 0) {
    verdict = { state: "completed", diagnosis: null };
  } else if (exitCode === null) {
    // 轮询兜底路径（lasso 重启后引擎自然退出）：按 staging 内容定谳——
    // aria2 无退出码可考，日志末快照 100% 或 staging 非空按完成论处（乐观但
    // 保守校验在 releaseStaging 的实际搬运——空 staging 搬不出 files 即 failed）
    const snap = parseAria2Progress(logTail);
    const hasStaging =
      fs.existsSync(stagingDir) && fs.readdirSync(stagingDir).length > 0;
    verdict =
      hasStaging && (snap.progress === null || snap.progress >= 1)
        ? { state: "completed", diagnosis: null }
        : { state: "failed", diagnosis: "engine exited while lasso was away (poll fallback)" };
  } else {
    verdict = {
      state: "failed",
      diagnosis: `engine exit code ${exitCode}${summarizeLog(logTail)}`,
    };
  }

  if (verdict.state === "completed") {
    // 交付：staging → 最终目录（files 回填=跨会话交付物本体，决议 §四）
    const files = releaseStaging(fresh.taskId, fresh.outDir);
    const subsFiles =
      fresh.engine === "yt-dlp" ? finalizeSubtitles(fresh.outDir) : [];
    const allFiles = [...files, ...subsFiles];
    updateTaskSync(fresh.taskId, {
      files: allFiles,
      subsFile: subsFiles[0] ?? null,
      progress: {
        state: "completed",
        progress: 1,
        speedBps: null,
        etaSec: null,
        downloadedBytes: null,
        totalBytes: null,
      },
    });
    logger.info({ evt: "download_completed", task_id: fresh.taskId, files: allFiles.length });
    return;
  }

  if (verdict.state === "cancelled") {
    // 引擎自报取消（yt-dlp exit 101）：清理 staging 残留（无交付物）
    discardStaging(fresh.taskId);
    updateTaskSync(fresh.taskId, {
      progress: {
        state: "cancelled",
        progress: null,
        speedBps: null,
        etaSec: null,
        downloadedBytes: null,
        totalBytes: null,
      },
    });
    return;
  }

  // failed：staging 保留（续传载体=.aria2 控制文件——P1-8 续传复用的基础）
  updateTaskSync(fresh.taskId, {
    progress: {
      state: "failed",
      progress: null,
      speedBps: null,
      etaSec: null,
      downloadedBytes: null,
      totalBytes: null,
    },
    diagnosis: verdict.diagnosis,
  });
  logger.warn({ evt: "download_failed", task_id: fresh.taskId, diagnosis: verdict.diagnosis });
}

/** 日志摘要（diagnosis 可读性——错误行优先，无则空）。 */
function summarizeLog(logTail: string): string {
  const errLines = logTail
    .split("\n")
    .filter((l) => /error|exception|failed/i.test(l))
    .slice(-2)
    .map((l) => l.trim().slice(0, 120));
  return errLines.length > 0 ? ` — ${errLines.join(" | ")}` : "";
}

// ============================================================
// 轮询兜底 + 守门（readEngineSnapshot 的顺带副作用——「拉快照=健康检查」）
// ============================================================
/**
 * pid 死检测兜底（lasso 重启场景）：state 非终态 + detached 引擎已死 →
 * 走 finalizeTaskOnExit(record, null)（按日志/staging 内容定谳）。
 * 返回 true=本次触发了定谳（调用方可重读任务拿终态）。
 */
export function maybeFinalizeOnPoll(record: DownloadTaskRecord): boolean {
  if (isTerminalState(record.progress.state)) return false;
  if (record.engine === "undici" || record.enginePid === null) return false; // in-process 路无 pid
  if (isEnginePidAlive(record.enginePid)) return false;
  finalizeTaskOnExit(record, null);
  return true;
}

/**
 * max_bytes 强制点（P0-2：aria2/ytdlp 主路径的尺寸帽——审查实证 L3 失效面）。
 * 超帽 → killEngineTree（四要素谓词）+ state=oversize + 清 staging。
 * 返回 true=本次执行了超帽拦截。
 */
export function enforceMaxBytes(record: DownloadTaskRecord): boolean {
  if (isTerminalState(record.progress.state)) return false;
  const snap = readTask(record.taskId);
  if (snap === null) return false;
  const total = snap.progress.totalBytes;
  const downloaded = snap.progress.downloadedBytes;
  const exceeded =
    (total !== null && total > snap.maxBytes) ||
    (downloaded !== null && downloaded > snap.maxBytes);
  if (!exceeded) return false;
  killEngineTree(snap, "oversize-watchdog");
  discardStaging(snap.taskId);
  updateTaskSync(snap.taskId, {
    progress: {
      state: "oversize",
      progress: null,
      speedBps: null,
      etaSec: null,
      downloadedBytes: snap.progress.downloadedBytes,
      totalBytes: total,
    },
    diagnosis: `oversize: ${describeBytes(total ?? downloaded ?? 0)} > cap ${describeBytes(snap.maxBytes)}`,
  });
  logger.warn({ evt: "download_oversize_killed", task_id: snap.taskId });
  return true;
}

/**
 * 任务级 idle 硬顶（P1-6/D13）：非终态 + updatedAt 距今超硬顶 → 杀树 + failed。
 * 覆盖「任务永不终态→文件/staging/引擎无界累积」的收口面。
 */
export function enforceIdleHardCap(
  record: DownloadTaskRecord,
  now = Date.now(),
): boolean {
  if (isTerminalState(record.progress.state)) return false;
  const updatedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  if (now - updatedAt < idleHardCapMs()) return false;
  const snap = readTask(record.taskId);
  if (snap === null) return false;
  killEngineTree(snap, "idle-hard-cap");
  discardStaging(snap.taskId);
  updateTaskSync(snap.taskId, {
    progress: {
      state: "failed",
      progress: null,
      speedBps: null,
      etaSec: null,
      downloadedBytes: null,
      totalBytes: null,
    },
    diagnosis: "idle hard cap exceeded (default 24h) — engine killed and task closed",
  });
  logger.warn({ evt: "download_idle_hard_cap", task_id: snap.taskId });
  return true;
}

function describeBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${n}B`;
}

// path 引用保留给后续扩展（releaseStaging 内部消费）——显式标记意图。
export const _internal = { path };
