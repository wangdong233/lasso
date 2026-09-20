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

    killEngineTree: (record: DownloadTaskRecord): boolean =>
      killEngineTreeImpl(record, "user-cancel").killed,

    reconcileOrphans: (): number => {
      return reconcileOrphansImpl(process.pid).adopted.length;
    },

    readEngineSnapshot: (record: DownloadTaskRecord): EngineSnapshotWithPeers => {
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
      return; // 终态由 reconcile/enrichTask 判定（detached 引擎自生自灭于任务表视角）
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
      result.promise
        .then((r) => {
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
          } else {
            updateTaskSync(record.taskId, {
              progress: failedProgress(),
              diagnosis: `${r.code}: ${r.message}`,
            });
            logger.warn({ evt: "download_failed", task_id: record.taskId, code: r.code });
          }
        })
        .catch((e: unknown) => {
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
