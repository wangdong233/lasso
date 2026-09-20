/**
 * deps.ts（doc/bugs/12 §八——合并批次的装配层：DownloadDeps 实装）
 *
 * 把 WT-core（store/kill/reconcile/filename）与 WT-engines（route/start/进度
 * 解析）组装成 tools/download.ts 的 DownloadDeps 接口。本文件是**唯一的**
 * 跨 WT 粘合点（合并前两 WT 无法互见；接线语义全部收敛于此，index.ts 一行
 * wireDownloadTools(buildDownloadDeps(...)) 完成）。
 *
 * 进度刷新模型（决议 D14 + WT-tools 契约）：无常驻轮询器——status/wait 的
 * enrichTask 拉取 readEngineSnapshot 后写回任务表（agent 轮询模式，验收
 * §七「status <50ms 读任务文件非进程」）。spawnEngine 只负责启动与终态回写。
 */
import { randomUUID } from "node:crypto";
import process from "node:process";
import { logger } from "../util/logger.js";
import type {
  DownloadEngineName,
  DownloadKindInput,
  DownloadTaskRecord,
  EngineProgressSnapshot,
  RoutedDownload,
} from "./types.js";
import { DEFAULT_MAX_BYTES } from "./types.js";
import {
  createTaskSync,
  readTask,
  listTasks,
  updateTaskSync,
} from "./store.js";
import { killEngineTree as killEngineTreeImpl } from "./kill.js";
import { reconcileOrphansSync as reconcileOrphansImpl } from "./reconcile.js";
// 终态检测层（审查修复批 P0-1/P0-2/P1-3/P1-6 的单一真源）
import {
  finalizeTaskOnExit,
  maybeFinalizeOnPoll,
  enforceMaxBytes,
  enforceIdleHardCap,
} from "./finalize.js";
import {
  resolveFilename,
  loadDefaultOutDirAllowlist,
  assertOutDirAllowed as assertOutDirAllowedImpl,
} from "./filename.js";
import {
  startEngineDownload,
  type DownloadStartOptions,
} from "./engines/start.js";
import { routeKind } from "./engines/route.js";
import { tailFile } from "./engines/spawn.js";
import { parseAria2Progress, parseAria2SummaryLine } from "./engines/aria2.js";
import { parseYtDlpProgress } from "./engines/ytdlp.js";
import type {
  DownloadDeps,
  EngineSnapshotWithPeers,
  EngineSpawnOptions,
  StartTaskInput,
} from "../tools/download.js";

// ============================================================
// undici in-process 任务的 controller 注册表（P1-3：cancel 的 abort 面）
// ============================================================
const undiciControllers = new Map<string, AbortController>();

/** 活跃任务总量帽（D13/H2：防无界任务/引擎累积；env 可调）。 */
export const MAX_ACTIVE_ENV = "LASSO_DOWNLOAD_MAX_ACTIVE";
export const DEFAULT_MAX_ACTIVE = 16;

export function maxActiveTasks(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[MAX_ACTIVE_ENV]);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_MAX_ACTIVE;
}

// ============================================================
// 装配
// ============================================================
/**
 * 生产装配（index.ts 启动期一次）。
 * @param ssrfConfig  http kind 的 SSRF 守门 config——**tools 层已在 start 链
 *   自己过 ssrfGuard**（与 fetch_url 同函数同 config）；此处透传给引擎层是
 *   undici 降级路径的**逐跳重定向复检**用（undici-fallback 内部每跳 fresh
 *   DNS 重查——引擎自跟随重定向面的补漏，D12/H8 诚实边界的机械部分）。
 */
export function buildDownloadDeps(ssrfConfig?: Parameters<typeof startEngineDownload>[0]["ssrfConfig"]): DownloadDeps {
  return {
    routeKind: (source: string, explicit: DownloadKindInput): RoutedDownload =>
      routeKind(source, explicit),

    resolveFilename,

    assertOutDirAllowed: (outDir: string): string =>
      assertOutDirAllowedImpl(outDir, loadDefaultOutDirAllowlist().dirs),

    // ---- 任务表（同步面：tools 接口同步；见 store.ts 同步导出头注） ----
    createTask: (input: StartTaskInput): DownloadTaskRecord => {
      const now = new Date().toISOString();
      const record: DownloadTaskRecord = {
        taskId: randomUUID(),
        kind: input.kind,
        source: input.source,
        outDir: input.outDir,
        filename: input.filename,
        createdAt: now,
        updatedAt: now,
        ownerPid: process.pid,
        engine: null,
        enginePid: null,
        engineCmdline: [],
        stdioFile: null,
        progress: {
          state: "starting",
          progress: null,
          speedBps: null,
          etaSec: null,
          downloadedBytes: null,
          totalBytes: null,
        },
        files: [],
        diagnosis: null,
        proxyUsed: null,
        maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
        subsFile: null,
      };
      // D13 总量帽：非终态任务数达上限 → 拒新任务（防无界累积——审查 P1-6）
      const active = listTasks().filter(
        (t) =>
          t.progress.state === "starting" || t.progress.state === "downloading",
      ).length;
      if (active >= maxActiveTasks()) {
        throw new Error(
          `too_many_active_downloads: ${active} active tasks >= cap ${maxActiveTasks()}（cancel/wait 收口后再发；LASSO_DOWNLOAD_MAX_ACTIVE 可调）`,
        );
      }
      // P1-8 续传复用：同 source+outDir 的 failed 任务 → 复用其 taskId（staging
      // 里的 .aria2 控制文件是字节级续传载体——aria2 -c 在同目录复活续传链路）
      const resumable = listTasks().find(
        (t) =>
          t.progress.state === "failed" &&
          t.source === input.source &&
          t.outDir === input.outDir,
      );
      if (resumable !== undefined) {
        const revived: DownloadTaskRecord = {
          ...record,
          taskId: resumable.taskId, // 复用 = staging/控制文件/任务文件三连同源
          createdAt: resumable.createdAt,
        };
        if (!createTaskSync(revived)) {
          throw new Error("task_store_write_failed: cannot persist task record before engine spawn");
        }
        logger.info({
          evt: "download_task_resumed",
          task_id: revived.taskId,
          note: "reused failed task slot — .aria2 control file enables byte-level resume",
        });
        return revived;
      }
      // 台账先于引擎（store.createTaskSync 头注：start 返回前已在盘上）；
      // 写失败=不可观测的裸引擎风险 → 抛错让 start 显式 didnt（不猜）。
      if (!createTaskSync(record)) {
        throw new Error("task_store_write_failed: cannot persist task record before engine spawn");
      }
      return record;
    },

    spawnEngine: (record: DownloadTaskRecord, opts: EngineSpawnOptions): void => {
      // fire-and-forget：spawn 是异步编排（引擎探测/bootstrap），start 工具
      // 调用不被下载时长阻塞（决议 §四：返回 starting 态，进度走 status/wait）。
      void runSpawnPipeline(record, opts, ssrfConfig);
    },

    readTask,
    listTasks,
    updateTask: (taskId, patch) => updateTaskSync(taskId, patch),

    killEngineTree: (record: DownloadTaskRecord): boolean => {
      // P1-3：undici in-process 引擎无 pid 可杀——abort controller 是其唯一
      // 停止面（abort 后 promise 以 aborted 失败收尾，幂等守卫保 cancelled 态）
      if (record.engine === "undici") {
        const controller = undiciControllers.get(record.taskId);
        if (controller !== undefined) {
          controller.abort();
          undiciControllers.delete(record.taskId);
          return true;
        }
        return false; // 已收场（promise 完成或已取消）
      }
      return killEngineTreeImpl(record, "user-cancel").killed;
    },

    reconcileOrphans: (): number => {
      return reconcileOrphansImpl(process.pid).adopted.length;
    },

    readEngineSnapshot: (record: DownloadTaskRecord): EngineSnapshotWithPeers => {
      // 拉快照=一次任务健康检查（审查修复批语义）：
      //  1. pid 死兜底定谳（lasso 重启后 exit 回调丢失的收敛路径）
      //  2. max_bytes 强制点（aria2/ytdlp 主路径的尺寸帽——L3 实证失效面）
      //  3. idle 硬顶（非终态任务的 24h 收口）
      if (maybeFinalizeOnPoll(record) || enforceMaxBytes(record) || enforceIdleHardCap(record)) {
        const fresh = readTask(record.taskId);
        if (fresh !== null) return snapshotFromRecord(fresh, null); // 定谳后快照即终态
      }
      // undici in-process：进度由任务表承载（promise 回调写回），无 stdio 日志
      if (record.engine === "undici" || record.engine === null || record.stdioFile === null) {
        return snapshotFromRecord(record, null);
      }
      const log = tailFile(record.stdioFile);
      if (record.engine === "yt-dlp") {
        return { ...parseYtDlpProgress(log ?? ""), peers: null };
      }
      // aria2（http/torrent）：进度 + torrent 诊断面（CN 活动连接数=peers）
      const snap = parseAria2Progress(log ?? "");
      let peers: number | null = null;
      if (record.kind === "torrent") {
        // tail 语义取最后一条 summary 行（与 parseAria2Progress 同源判定）
        let last: ReturnType<typeof parseAria2SummaryLine> = null;
        for (const line of (log ?? "").split("\n")) {
          const f = parseAria2SummaryLine(line);
          if (f) last = f;
        }
        peers = last?.connections ?? null;
      }
      return { ...snap, peers };
    },
  };
}

// ============================================================
// spawn 管线（fire-and-forget 终态回写）
// ============================================================
async function runSpawnPipeline(
  record: DownloadTaskRecord,
  opts: EngineSpawnOptions,
  ssrfConfig: DownloadStartOptions["ssrfConfig"],
): Promise<void> {
  try {
    const result = await startEngineDownload({
      taskId: record.taskId,
      kind: record.kind,
      source: record.source,
      outDir: record.outDir,
      filename: record.filename,
      maxConn: opts.maxConn,
      proxy: opts.proxy,
      subs: opts.subs,
      audioOnly: opts.audioOnly,
      maxBytes: record.maxBytes,
      ssrfConfig,
    });

    if (result.status === "detached") {
      // detached 引擎：台账登记 pid+cmdline（cancel 归属验证的四要素源）
      updateTaskSync(record.taskId, {
        engine: result.engine,
        enginePid: result.pid,
        engineCmdline: [result.command, ...result.spec.args],
        stdioFile: result.spec.stdioFile,
        proxyUsed: result.proxyUsed,
        progress: {
          state: "downloading",
          progress: null,
          speedBps: null,
          etaSec: null,
          downloadedBytes: null,
          totalBytes: null,
        },
      });
      logger.info({
        evt: "download_engine_detached",
        task_id: record.taskId,
        engine: result.engine,
        pid: result.pid,
      });
      // P0-1（审查修复批）：exit 回调=终态定谳的即时路径——引擎退出即
      // finalizeTaskOnExit（completed→releaseStaging 回填 files / failed→
      // diagnosis）。lasso 死后此回调丢失，由 readEngineSnapshot 的
      // maybeFinalizeOnPoll 轮询兜底（双路径收敛同一真源）。
      result.child.on("exit", (code) => {
        try {
          finalizeTaskOnExit(record, code);
        } catch (e) {
          logger.warn({
            evt: "download_finalize_error",
            task_id: record.taskId,
            error: String(e instanceof Error ? e.message : e).slice(0, 200),
          });
        }
      });
      return;
    }

    if (result.status === "inprocess") {
      updateTaskSync(record.taskId, {
        engine: "undici",
        proxyUsed: result.proxyUsed,
        progress: {
          state: "downloading",
          progress: null,
          speedBps: null,
          etaSec: null,
          downloadedBytes: null,
          totalBytes: null,
        },
      });
      // P1-3（审查修复批）：controller 注册——cancel 对 undici 路的 abort 面
      undiciControllers.set(record.taskId, result.controller);
      result.promise
        .then((r) => {
          undiciControllers.delete(record.taskId);
          // 幂等守卫：cancel 先赢（state=cancelled）则引擎终态不覆盖
          const fresh = readTask(record.taskId);
          if (fresh !== null && fresh.progress.state === "cancelled") return;
          if (r.ok) {
            updateTaskSync(record.taskId, {
              files: [r.filePath],
              progress: {
                state: "completed",
                progress: 1,
                speedBps: null,
                etaSec: null,
                downloadedBytes: r.bytes,
                totalBytes: r.bytes,
              },
            });
            logger.info({ evt: "download_completed", task_id: record.taskId, bytes: r.bytes });
          } else if (r.code === "oversize") {
            // oversize 是独立终态（决议 §四状态机）——undici HEAD 预检/流式
            // watchdog 的超帽失败映射到 oversize 而非 failed（审查 P0-2 语义）
            updateTaskSync(record.taskId, {
              progress: oversizeProgress(null, null),
              diagnosis: `oversize: ${r.message}`,
            });
            logger.warn({ evt: "download_oversize_killed", task_id: record.taskId });
          } else {
            updateTaskSync(record.taskId, {
              progress: failedProgress(),
              diagnosis: `${r.code}: ${r.message}`,
            });
            logger.warn({ evt: "download_failed", task_id: record.taskId, code: r.code });
          }
        })
        .catch((e: unknown) => {
          undiciControllers.delete(record.taskId);
          const fresh = readTask(record.taskId);
          if (fresh !== null && fresh.progress.state === "cancelled") return; // cancel 先赢
          updateTaskSync(record.taskId, {
            progress: failedProgress(),
            diagnosis: `undici_exception: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`,
          });
        });
      return;
    }

    // unavailable：引擎缺失（BT 无降级引擎 / stream 引导失败）——显式失败+可操作 hint
    updateTaskSync(record.taskId, {
      progress: failedProgress(),
      diagnosis: `engine_unavailable: ${result.message} — ${result.hint}`,
    });
    logger.warn({ evt: "download_engine_unavailable", task_id: record.taskId, message: result.message });
  } catch (e) {
    // 编排层自身异常（引擎探测抛错等）——任务不许卡 starting
    updateTaskSync(record.taskId, {
      progress: failedProgress(),
      diagnosis: `spawn_pipeline_error: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`,
    });
    logger.warn({ evt: "download_spawn_pipeline_error", task_id: record.taskId });
  }
}

function oversizeProgress(downloadedBytes: number | null, totalBytes: number | null) {
  return {
    state: "oversize" as const,
    progress: null,
    speedBps: null,
    etaSec: null,
    downloadedBytes,
    totalBytes,
  };
}

function failedProgress() {
  return {
    state: "failed" as const,
    progress: null,
    speedBps: null,
    etaSec: null,
    downloadedBytes: null,
    totalBytes: null,
  };
}

/** 任务表 progress → 快照形态（undici/无日志引擎的读回路径）。 */
function snapshotFromRecord(
  record: DownloadTaskRecord,
  _engine: unknown,
): EngineSnapshotWithPeers {
  const p = record.progress;
  const snap: EngineProgressSnapshot = {
    progress: p.progress,
    speedBps: p.speedBps,
    etaSec: p.etaSec,
    downloadedBytes: p.downloadedBytes,
    totalBytes: p.totalBytes,
    exitCode: null,
  };
  return { ...snap, peers: null };
}

// 保留 engine 名字面量的类型引用（避免未使用导入告警的显式声明意图）
export type { DownloadEngineName };
