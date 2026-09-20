/**
 * store.ts（doc/bugs/12 下载器批——D6/H6 任务表，WT-core）
 *
 * 每任务一文件 `<tasksRoot>/<taskId>.json`（chrome-ledger 台账纪律的 per-task 形态）：
 *  - 路径：env `LASSO_DOWNLOADS_PATH` 覆盖任务表根目录（types.ts DOWNLOADS_DIR_ENV，
 *    测试隔离）；缺省 `~/.cache/lasso/downloads/tasks/`（DEFAULT_DOWNLOADS_DIR_SUFFIX）。
 *  - 原子写：同目录 `.tmp-<pid>-<ms>` 后缀 tmp + renameSync（并发读者永不读半截
 *    JSON——chrome-ledger / headless-stack-ledger 同款）。
 *  - 容错（守 spawn/下载成功不被台账失败拖死）：写失败 warn 不抛（best-effort）；
 *    单文件损坏 / 形状不对 → 跳过该文件 + warn（listTasks 绝不因单文件损坏整目录
 *    失效——「空输出≠空属性」同族纪律：跳过必须留痕）。
 *  - taskId 强制 UUID 校验（crypto.randomUUID 输出形状，小写十六进制）——防
 *    `../../evil` 类路径穿越进文件名（红队 H5 邻面：filename 守卫在 filename.ts，
 *    taskId 守卫在此）。
 *
 * 并发安全（红队 H6，决议 D6）：
 *  - 跨任务零竞争：每任务一文件，天然无共享写面（并行 ≥4 任务互不阻塞——验收
 *    §七「高效」判据的结构前提）。
 *  - 同任务 RMW：writeFileSync 同步块（单事件循环内不可交错——chrome-ledger 先例）
 *    + 模块级 per-task Promise 链串行队列（异步调用方按入队序执行；禁引入锁库，
 *    决议 D6「简单 Promise 链即可」）。队列尾巴恒 resolve（吞错保链）+ 自清
 *    （Map 不随历史任务数无界增长）。
 */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";
import { logger } from "../util/logger.js";
import {
  DOWNLOADS_DIR_ENV,
  DEFAULT_DOWNLOADS_DIR_SUFFIX,
  type DownloadEngineName,
  type DownloadKind,
  type DownloadState,
  type DownloadTaskRecord,
} from "./types.js";

// ============================================================
// 路径 + taskId 守卫
// ============================================================
/**
 * 任务表根目录（直接容纳 `<taskId>.json`；types.ts 注释锚：「任务表根目录 env
 * 可覆盖」——env 值即根目录本体，不再拼 suffix）。缺省 `~/.cache/lasso` +
 * downloads/tasks（doc/bugs/12 D6 全路径真源）。
 */
export function downloadTasksRoot(): string {
  const override = process.env[DOWNLOADS_DIR_ENV];
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".cache", "lasso", DEFAULT_DOWNLOADS_DIR_SUFFIX);
}

/**
 * taskId 合法形状 = crypto.randomUUID 输出（8-4-4-4-12 小写十六进制）。
 * 是任务清单给定 `/^[a-f0-9-]{36}$/` 的收紧子集（36 位全 `-` 也匹配宽松式，
 * 但不是任何 UUID 产物——收紧到 canonical 形状，穿越面更小、误放行为零）。
 */
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** taskId 是否合法 UUID（createTask/updateTask/readTask/deleteTask 入口共门）。 */
export function isValidTaskId(taskId: string): boolean {
  return TASK_ID_RE.test(taskId);
}

/** taskId 非法 → 显式抛错（调用方 bug 档，不吞不猜）。错误码 = invalid_task_id。 */
export class InvalidTaskIdError extends Error {
  readonly code = "invalid_task_id";
  constructor(taskId: string) {
    super(`invalid_task_id: ${JSON.stringify(taskId)} 不是 canonical UUID（防路径穿越）`);
    this.name = "InvalidTaskIdError";
  }
}

function assertTaskId(taskId: string): void {
  if (!isValidTaskId(taskId)) throw new InvalidTaskIdError(taskId);
}

function taskFilePath(taskId: string): string {
  return path.join(downloadTasksRoot(), `${taskId}.json`);
}

// ============================================================
// 形状解析守卫（chrome-ledger「单条形状不对跳过」同款）
// ============================================================
const KINDS: readonly DownloadKind[] = ["http", "stream", "torrent"];
const ENGINES: readonly DownloadEngineName[] = ["aria2c", "yt-dlp", "undici"];
const STATES: readonly DownloadState[] = [
  "starting",
  "downloading",
  "completed",
  "failed",
  "cancelled",
  "orphaned",
  "oversize",
];

/**
 * 未知值解析（联合类型守卫；非法形态 → undefined，调用方按损坏跳过）。
 * 前向兼容哲学同 chrome-ledger：新增枚举值须同步本表，否则新台账被旧 lasso
 * 静默降级（漏改即测试红——见 spec「枚举守卫往返」用例）。
 */
function parseEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

/**
 * 宽松解析一条任务记录（readTask/listTasks 共用）。
 * 返回 null = 损坏 / 形状不对（调用方跳过 + warn，绝不整目录失效）。
 */
export function parseTaskRecord(raw: unknown): DownloadTaskRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.taskId !== "string" || !isValidTaskId(r.taskId)) return null;
  const kind = parseEnum(r.kind, KINDS);
  if (kind === undefined) return null;
  if (
    typeof r.source !== "string" ||
    typeof r.outDir !== "string" ||
    typeof r.createdAt !== "string" ||
    typeof r.updatedAt !== "string" ||
    typeof r.ownerPid !== "number" ||
    !Array.isArray(r.engineCmdline) ||
    !r.engineCmdline.every((a) => typeof a === "string") ||
    typeof r.maxBytes !== "number"
  ) {
    return null;
  }
  const filename = r.filename === null ? null : r.filename;
  if (filename !== null && typeof filename !== "string") return null;
  // progress 子形状（state 是任务状态唯一宿主——契约把 state 收在 progress 里）
  const p = r.progress;
  if (p === null || typeof p !== "object") return null;
  const pr = p as Record<string, unknown>;
  const state = parseEnum(pr.state, STATES);
  if (state === undefined) return null;
  const numOrNull = (v: unknown): number | null | undefined =>
    (typeof v === "number" && Number.isFinite(v)) || v === null ? (v as number | null) : undefined;
  const pProgress = numOrNull(pr.progress);
  const pSpeed = numOrNull(pr.speedBps);
  const pEta = numOrNull(pr.etaSec);
  const pDownloaded = numOrNull(pr.downloadedBytes);
  const pTotal = numOrNull(pr.totalBytes);
  if (
    pProgress === undefined ||
    pSpeed === undefined ||
    pEta === undefined ||
    pDownloaded === undefined ||
    pTotal === undefined
  ) {
    return null;
  }
  const progress = {
    state,
    progress: pProgress,
    speedBps: pSpeed,
    etaSec: pEta,
    downloadedBytes: pDownloaded,
    totalBytes: pTotal,
  };
  const nullableString = (v: unknown): string | null | undefined =>
    v === null ? null : typeof v === "string" ? v : undefined;
  const engine = r.engine === null ? null : parseEnum(r.engine, ENGINES);
  if (engine === undefined) return null;
  const stdioFile = nullableString(r.stdioFile);
  const diagnosis = nullableString(r.diagnosis);
  const proxyUsed = nullableString(r.proxyUsed);
  const subsFile = nullableString(r.subsFile);
  if (stdioFile === undefined || diagnosis === undefined || proxyUsed === undefined || subsFile === undefined) {
    return null;
  }
  if (!Array.isArray(r.files) || !r.files.every((f) => typeof f === "string")) return null;
  if (r.enginePid !== null && typeof r.enginePid !== "number") return null;
  return {
    taskId: r.taskId,
    kind,
    source: r.source,
    outDir: r.outDir,
    filename,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ownerPid: r.ownerPid,
    engine,
    enginePid: r.enginePid as number | null,
    engineCmdline: r.engineCmdline as string[],
    stdioFile,
    progress,
    files: r.files as string[],
    diagnosis,
    proxyUsed,
    maxBytes: r.maxBytes,
    subsFile,
  };
}

// ============================================================
// per-task 串行队列（红队 H6：同任务 RMW 不交错）
// ============================================================
const taskQueues = new Map<string, Promise<void>>();

/**
 * 入队一次 per-task 操作：按入队序串行执行；返回原始结果/异常给调用方。
 * 尾巴恒 resolve（前序失败不断链）+ 自清（队头即尾时删 Map 项，零泄漏）。
 */
function enqueueTaskOp<T>(taskId: string, op: () => T): Promise<T> {
  const prev = taskQueues.get(taskId) ?? Promise.resolve();
  const run = prev.then(() => op());
  const tail = run.then(
    () => {
      if (taskQueues.get(taskId) === tail) taskQueues.delete(taskId);
    },
    () => {
      if (taskQueues.get(taskId) === tail) taskQueues.delete(taskId);
    },
  );
  taskQueues.set(taskId, tail);
  return run;
}

// ============================================================
// 写（同步块 + tmp/rename 原子；best-effort）
// ============================================================
/**
 * 原子写一条任务记录（同步块：单事件循环内 read-modify-write 不可交错）。
 * best-effort：失败 warn 不抛（chrome-ledger 容错同款——台账失败不拖死下载），
 * 返回 false 让调用方可观测（createTask 透传；updateTask 失败返 null——磁盘是
 * 真源，不返回没落盘的幻影记录）。成功后 tmp 已被 rename 消费，无残骸。
 */
function writeTaskSync(record: DownloadTaskRecord): boolean {
  const target = taskFilePath(record.taskId);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
    renameSync(tmp, target);
    return true;
  } catch (e) {
    // 写失败 → 清 tmp 残骸（不留无主半截文件）+ warn 不抛
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 未写成——无残骸可清
    }
    logger.warn({
      evt: "download_store_write_error",
      task_id: record.taskId,
      error: String(e),
    });
    return false;
  }
}

/**
 * 落盘新任务（taskId 必须已由调用方生成 UUID；非法 id 显式抛）。
 * 返回 false = 写盘失败（warn 已记）——调用方（start 流程）据此可不 spawn
 * 引擎（零任务表的裸引擎 = 无法 cancel 的孤儿，宁可不起）。
 */
export async function createTask(record: DownloadTaskRecord): Promise<boolean> {
  assertTaskId(record.taskId);
  return enqueueTaskOp(record.taskId, () => writeTaskSync(record));
}

// ============================================================
// 读（纯磁盘读，非进程探测——验收 §七「status <50ms」判据的根基）
// ============================================================
/** 读单任务：文件缺失 / 损坏 / 形状不对 / taskId 非法 → null（不 throw）。 */
export function readTask(taskId: string): DownloadTaskRecord | null {
  if (!isValidTaskId(taskId)) return null;
  let body: string;
  try {
    body = readFileSync(taskFilePath(taskId), "utf8");
  } catch {
    return null; // 不存在（或不可读）
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // 损坏 JSON → null + warn（跳过单文件必须留痕）
    logger.warn({ evt: "download_task_parse_error", task_id: taskId });
    return null;
  }
  const rec = parseTaskRecord(parsed);
  if (rec === null) {
    logger.warn({ evt: "download_task_shape_invalid", task_id: taskId });
  }
  return rec;
}

/**
 * 列全部任务：目录不存在 → []；只认 `<canonical-uuid>.json` 文件名（其余文件
 * 零读取——tmp 残骸 / 用户杂物不进任务面）；单文件损坏跳过 + warn。
 */
export function listTasks(): DownloadTaskRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(downloadTasksRoot());
  } catch {
    return [];
  }
  const out: DownloadTaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const taskId = entry.slice(0, -".json".length);
    if (!isValidTaskId(taskId)) continue; // 非 UUID 文件名零读取
    const rec = readTask(taskId);
    if (rec !== null) out.push(rec);
  }
  // 稳定序：创建时间升序（status:"all" 的跨会话寻址面可预测）
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return out;
}

// ============================================================
// 改 / 删（RMW 走 per-task 队列）
// ============================================================
/**
 * 读-改-写一条任务（浅合并 patch；updatedAt 自动戳新——台账纪律：审计面不由
 * 调用方手工维护）。返回合并后的落盘记录；taskId 非法 → 抛；文件不存在 /
 * 写盘失败 → null（不隐式创建——upsert 语义会掩盖调用方时序 bug；写盘失败
 * 已 warn 留痕，磁盘是真源不返幻影）。
 */
export async function updateTask(
  taskId: string,
  patch: Partial<DownloadTaskRecord>,
): Promise<DownloadTaskRecord | null> {
  assertTaskId(taskId);
  return enqueueTaskOp(taskId, () => {
    const current = readTask(taskId);
    if (current === null) return null;
    const next: DownloadTaskRecord = {
      ...current,
      ...patch,
      taskId, // 主键不可被 patch 篡改（RMW 永远写回自己的文件）
      updatedAt: new Date().toISOString(),
    };
    return writeTaskSync(next) ? next : null;
  });
}

/**
 * 删任务文件（cancel 后收尾 / 测试清理）。返回 true = 已删；false = 不存在
 * （幂等）或 IO 失败（warn 不抛）。
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  assertTaskId(taskId);
  return enqueueTaskOp(taskId, () => {
    try {
      unlinkSync(taskFilePath(taskId));
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false; // 幂等：不存在 = 未删
      logger.warn({ evt: "download_store_delete_error", task_id: taskId, error: String(e) });
      return false;
    }
  });
}
