/**
 * reconcile.ts（doc/bugs/12 下载器批——D4 孤儿收养，WT-core）
 *
 * detached 引擎跨 lasso 重启存活（D4：shutdown 默认不杀只标 orphaned）——
 * 重启后的 status 触发本收养扫描（render-chrome 台账共有制 + cmdline 复验先例
 * 的任务表形态）：
 *  - 候选面：listTasks 里 ownerPid ≠ currentPid 且 progress.state ∈
 *    {starting, downloading}（终态任务零参与——幂等收敛）。
 *  - enginePid 活 + cmdline 归属验证过 → **收养**：state=downloading +
 *    ownerPid=currentPid（引擎继续跑，断点续传载体是 .aria2 控制文件非会话态）。
 *  - enginePid 死 / 无 enginePid / cmdline 归属不成立（pid 被无关进程复用）→
 *    state=failed + diagnosis="engine died while lasso was away"（引擎死了，
 *    没有可收养的本体；pid 复用场景引擎同样不存在——同判 failed，diagnosis
 *    追加复用嫌疑注记）。
 *
 * 纯磁盘操作（幂等；无杀路径——杀只属于 kill.ts 的谓词出口）。只在 status
 * action 触发时调用（决议 D4；不在 server 启动钩子里抢跑——避免拖慢启动）。
 */
import process from "node:process";
import { logger } from "../util/logger.js";
import { updateTaskSync, listTasks } from "./store.js";
import { shouldKillEngine, isEnginePidAlive, readCmdlineArgv } from "./kill.js";
import type { DownloadTaskRecord } from "./types.js";

/** 收养扫描结果（status 响应 / doctor 可观测）。 */
export interface ReconcileResult {
  /** 被收养（引擎确认存活且归属成立）的 taskId。 */
  adopted: string[];
  /** 被判 failed（引擎死了 / 从未 spawn / pid 复用）的 taskId。 */
  failed: string[];
  /** 非候选（终态或本会话自有）任务数。 */
  untouched: number;
}

/** reconcile 可注入依赖（测试注入假 ps；生产缺省真实实现）。 */
export interface ReconcileDeps {
  isPidAlive?: (pid: number) => boolean;
  psCommand?: (pid: number) => string[] | null;
  log?: (payload: Record<string, unknown>) => void;
}

/** 死引擎的统一诊断语（doc/bugs/12 D4 原文锚）。 */
export const ENGINE_DIED_DIAGNOSIS = "engine died while lasso was away";

/**
 * 单任务收养判定（纯判定核，导出供测试）：
 *  - "adopt"：enginePid 活 + shouldKillEngine 四要素判定过（复用杀谓词的归属
 *    语义——收养与杀必须认同一只引擎，禁止两套归属标准漂移）；
 *  - "fail:dead"：pid 死 / 台账无 enginePid；
 *  - "fail:reused"：pid 活但归属不成立（pid 复用——引擎本体已不存在）。
 */
export function classifyOrphan(
  record: DownloadTaskRecord,
  deps: Pick<ReconcileDeps, "isPidAlive" | "psCommand"> = {},
): "adopt" | "fail:dead" | "fail:reused" {
  const isPidAlive = deps.isPidAlive ?? isEnginePidAlive;
  const psCommand = deps.psCommand ?? readCmdlineArgv;
  const enginePid = record.enginePid;
  if (enginePid === null || !Number.isInteger(enginePid) || enginePid <= 0) {
    return "fail:dead"; // 引擎从未 spawn（spawn 窗口内 lasso 死了）
  }
  if (!isPidAlive(enginePid)) return "fail:dead";
  const cmdlineNow = psCommand(enginePid);
  if (cmdlineNow === null) return "fail:reused"; // 无法验证 = 不收养（fail-closed）
  return shouldKillEngine({ record, enginePid, cmdlineNow }) ? "adopt" : "fail:reused";
}

/**
 * 孤儿收养扫描（幂等，纯磁盘操作）。currentPid = 本次 lasso 进程 pid
 * （收养后的新 ownerPid）。逐任务独立 updateTask（每任务一文件，互不阻塞）。
 */
export async function reconcileOrphans(
  currentPid: number = process.pid,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  // 逐任务独立 updateTask（每任务一文件）——并发重复扫描幂等收敛，无需全局队列
  return Promise.resolve(reconcileOrphansSync(currentPid, deps));
}

/**
 * 同步版（2026-09-20 合并批次：deps 装配层的 DownloadDeps.reconcileOrphans
 * 是同步接口）。全链磁盘+ps 同步操作（updateTaskSync 同块原子），status 的
 * 调用点无 await 面。语义/日志与 async 版完全一致（async 版委托本实现）。
 */
export function reconcileOrphansSync(
  currentPid: number = process.pid,
  deps: ReconcileDeps = {},
): ReconcileResult {
  const log = deps.log ?? ((p: Record<string, unknown>) => logger.info(p));
  const tasks = listTasks();
  const adopted: string[] = [];
  const failed: string[] = [];
  let untouched = 0;

  for (const rec of tasks) {
    const state = rec.progress.state;
    const orphanCandidate =
      rec.ownerPid !== currentPid && (state === "starting" || state === "downloading");
    if (!orphanCandidate) {
      untouched++;
      continue;
    }
    const verdict = classifyOrphan(rec, deps);
    if (verdict === "adopt") {
      // 收养：state 钉 downloading（starting→downloading 同步升级——引擎活到了
      // 收养时刻，证明 spawn 已完成）+ ownerPid 换防
      const next = updateTaskSync(rec.taskId, {
        ownerPid: currentPid,
        progress: { ...rec.progress, state: "downloading" },
      });
      if (next !== null) {
        adopted.push(rec.taskId);
        log({ evt: "download_orphan_adopted", task_id: rec.taskId, pid: rec.enginePid });
      } else {
        // 收养写盘失败（文件被并发删）→ 留待下次 status 重扫（幂等收敛）
        untouched++;
      }
    } else {
      const diagnosis =
        verdict === "fail:reused"
          ? `${ENGINE_DIED_DIAGNOSIS} (pid reused by unrelated process)`
          : ENGINE_DIED_DIAGNOSIS;
      const next = updateTaskSync(rec.taskId, {
        progress: { ...rec.progress, state: "failed" },
        diagnosis,
      });
      if (next !== null) {
        failed.push(rec.taskId);
        log({ evt: "download_orphan_failed", task_id: rec.taskId, verdict, diagnosis });
      } else {
        untouched++;
      }
    }
  }
  return { adopted, failed, untouched };
}
