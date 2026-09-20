/**
 * kill.ts（doc/bugs/12 下载器批——D7/H10 cancel 杀谓词，WT-core）
 *
 * 任务定向杀（headless-stack-ledger 判杀纪律 + chrome-stop verifyOwnership 先例
 * 的 download 域直译）：cancel 永远只允许杀「自己台账在案 + 归属四要素全过」的
 * 引擎树——**任一要素不满足即零动作**（反向证据必须停，项目全局红线；
 * 「永不 kill 用户进程」的机械锚）。
 *
 * 四要素（types.ts KillPredicateFn 契约）：
 *  ① 任务表在案（调用方保证——record 必须来自 store.readTask，不是调用方臆造）；
 *  ② pid 活：process.kill(pid, 0) 探测（killEngineTree 内做——谓词本身收
 *     cmdlineNow 现值，纯函数可单测）；
 *  ③ cmdlineNow 含 LASSO_DOWNLOAD_ARGV_MARKER（引擎 argv 归属标记）；
 *  ④ cmdlineNow 与 record.engineCmdline 匹配（argv 集合包含关系：记录的全部
 *     argv 元素必须在场——marker + taskId 串由此共同钉死，taskId 不可伪造面）。
 *
 * cmdline 读取：`ps -ww -p <pid> -o command=`，execFileSync 无 shell 层
 * （PERF-5 假阳性教训：shell 层会把 stderr 当失败信号）。-ww = 不截断宽输出
 * （长 URL argv 被 ps 截断 → ④假阴性 → 拒杀，虽是安全方向但制造收不了的孤儿；
 * -ww 从根上消掉该面）。
 *
 * argv 还原注意：ps 输出是空格拼接的单行（引号已剥落），按空白切分回 argv 是
 * 近似——含空格的 argv 元素会被切碎 → ④不命中 → 拒杀。失败方向安全（宁可不杀
 * 不可误杀）；引擎 argv（aria2c/yt-dlp）实测面均为无空格元素（URL 百分号编码）。
 */
import { execFileSync } from "node:child_process";
import process from "node:process";
import { logger } from "../util/logger.js";
// 致死原语单一真源（SubprocessManager / chrome-stop / headless-stack-ledger 共用）
import { killTreeSync } from "../util/kill-tree.js";
import { LASSO_DOWNLOAD_ARGV_MARKER, type DownloadTaskRecord, type KillPredicateInput } from "./types.js";

// ============================================================
// 谓词（纯函数——四要素 ③④ 的机械判定）
// ============================================================
/**
 * cancel 杀谓词（types.ts KillPredicateFn 契约实现）。
 *
 * 输入的 record/enginePid/cmdlineNow 均由调用方采集（①台账在案 + ②pid 活在
 * killEngineTree 侧保证——谓词只做可注入可单测的纯判定）：
 *  - enginePid 必须与 record.enginePid 一致（探的不是台账那只 pid → 拒）；
 *  - cmdlineNow 必须含 marker（③）；
 *  - record.engineCmdline 非空且每个元素都在 cmdlineNow 在场（④集合包含）——
 *    engineCmdline 空（引擎从未 spawn / 已清场）→ 拒（防空集 vacuous-true）。
 */
export function shouldKillEngine(input: KillPredicateInput): boolean {
  const { record, enginePid, cmdlineNow } = input;
  // ②'：探测 pid 与台账 pid 同一（不同 → 调用方时序错位，拒）
  if (typeof enginePid !== "number" || !Number.isInteger(enginePid) || enginePid <= 0) return false;
  if (record.enginePid !== enginePid) return false;
  if (!Array.isArray(cmdlineNow) || cmdlineNow.length === 0) return false;
  // ③：marker 必须在场（独立于④——防 engineCmdline 忘带 marker 的脏台账）
  if (!cmdlineNow.includes(LASSO_DOWNLOAD_ARGV_MARKER)) return false;
  // ④：argv 集合包含关系（marker+taskId 串由此共同钉死；空 cmdline 拒）
  if (record.engineCmdline.length === 0) return false;
  return record.engineCmdline.every((arg) => cmdlineNow.includes(arg));
}

// ============================================================
// 归属采集（生产实现；可注入）
// ============================================================
/** pid 存活探测（signal 0；ESRCH/EPERM 均 = 不活）。 */
export function isEnginePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `ps -ww -p <pid> -o command=` → argv 数组（空白切分）。
 * ps 失败 / 进程消失 → null（fail-closed：调用方按无法验证归属处理，绝不杀）。
 */
export function readCmdlineArgv(pid: number): string[] | null {
  try {
    const out = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim().split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

// ============================================================
// killEngineTree（谓词通过 → killTreeSync；不过 → 零动作）
// ============================================================
/** cancel 杀结果（status/doctor 可观测；action 显式错误码纪律）。 */
export interface KillEngineResult {
  killed: boolean;
  action:
    | "killed" // 四要素全过 → killTreeSync 已发
    | "no_engine_pid" // 台账无 enginePid（引擎从未 spawn / 已收场）
    | "engine_pid_not_alive" // ②不过：pid 已死（无事可杀）
    | "cmdline_unverifiable" // ps 失败（无法验证归属 → 零动作）
    | "ownership_rejected"; // ③/④不过：归属不成立 → 零动作（红线分支）
  reason: string;
}

/** killEngineTree 可注入依赖（测试注入假 ps/kill；生产缺省真实实现）。 */
export interface KillEngineDeps {
  isPidAlive?: (pid: number) => boolean;
  psCommand?: (pid: number) => string[] | null;
  killTree?: (pid: number, logTag?: string) => void;
  log?: (payload: Record<string, unknown>) => void;
}

/**
 * cancel 的唯一杀出口（决议 D7：谓词四要素 → killTreeSync 单一真源）。
 *
 * 谓词不过 → 返回 {killed:false} 且**零动作**（反向证据必须停——绝不带着
 * 不确定归属进 killTreeSync）。调用方（WT-tools cancel action）依据返回值改
 * 任务 state（cancelled / failed），本函数不改台账（单一职责：只杀）。
 */
export function killEngineTree(
  record: DownloadTaskRecord,
  reason: string,
  deps: KillEngineDeps = {},
): KillEngineResult {
  const log = deps.log ?? ((p: Record<string, unknown>) => logger.info(p));
  const isPidAlive = deps.isPidAlive ?? isEnginePidAlive;
  const psCommand = deps.psCommand ?? readCmdlineArgv;
  const killTree = deps.killTree ?? ((pid: number, tag?: string) => killTreeSync(pid, tag));

  const enginePid = record.enginePid;
  if (enginePid === null || !Number.isInteger(enginePid) || enginePid <= 0) {
    return { killed: false, action: "no_engine_pid", reason: "台账无 enginePid——引擎从未 spawn 或已收场" };
  }
  // ② pid 活
  if (!isPidAlive(enginePid)) {
    return { killed: false, action: "engine_pid_not_alive", reason: "engine pid 已死（无需杀）" };
  }
  // ③④ 前置采集：ps 取 cmdline 现值（失败 → 无法验证归属，零动作）
  const cmdlineNow = psCommand(enginePid);
  if (cmdlineNow === null) {
    log({ evt: "download_kill_ps_failed", task_id: record.taskId, pid: enginePid, clear_only: false });
    return { killed: false, action: "cmdline_unverifiable", reason: "ps 读取失败——归属无法验证，零动作" };
  }
  if (!shouldKillEngine({ record, enginePid, cmdlineNow })) {
    // 红线分支：pid 活但 cmdline 不是台账那只引擎（pid 复用 / 脏台账）——绝不杀
    log({
      evt: "download_kill_ownership_rejected",
      task_id: record.taskId,
      pid: enginePid,
      cmdline_head: cmdlineNow.slice(0, 4).join(" "),
    });
    return { killed: false, action: "ownership_rejected", reason: "cmdline 归属验证不通过（pid 复用嫌疑）——零动作" };
  }
  // 全过 → 杀整树（单一真源；logTag 任务定向可 grep）
  killTree(enginePid, `download-cancel:${record.taskId}`);
  log({ evt: "download_engine_killed", task_id: record.taskId, pid: enginePid, reason });
  return { killed: true, action: "killed", reason };
}
