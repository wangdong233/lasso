/**
 * headless-stack-ledger.ts（BUG-08 决议 B-2，doc/bugs/08，2026-09-15）
 *
 * 内部 MCP 栈（chrome-devtools-mcp 系，SubprocessManager 进程内 spawn）的跨进程
 * 可见性 sidecar——「spawn 即登记 + 任意 spawn 前扫除」（Selenium Grid 先例直译）。
 *
 * 为什么需要：SubprocessManager 的 procs map / lifecyclePids 都是**进程内**内存态，
 * server SIGKILL 崩溃后无人可见——marathon 实锤「1:06AM 与 1:12AM 两代栈并存」
 * （两套 chrome-devtools-mcp + watchdog 常驻，台账对两者都无感知）。与
 * chrome-ledger（detached 端口 Chrome 域）分域：一个账本一个域（chrome-stop /
 * reaper / chrome-status 三方消费面零改动）。
 *
 * 文件：~/.cache/lasso/headless-stacks.json（env LASSO_HEADLESS_STACKS_PATH 测试
 * 隔离）。数组形态 [{specName, pid, ownerPid, spawnedAt}]。登记面 = 全部 spec
 * （headless / logged_in / browserbase / steel 共用 _spawnWithBackoff 通路）——
 **必然多 spec 混载，这正是判杀必须 pid 级归并的原因**（R1：同 pid 任一记录的
 * ownerPid 仍活 → 整组零动作；逐记录独立判定会被「陈旧记录的 pid 被活 server B
 * 的栈复用」击穿——四 channel 共拼同一包串，条件②对任何 lasso 栈恒真）。
 *
 * 判杀算法（R1 pid 归并版，顺序即实现序——INV-96③ 文本锚）：
 *   pid 归并（同 pid 任一 owner 活 → 整组零动作）→ alive → 包串 →
 *   lstart 与 spawnedAt 一致 → owner 死 → killTreeSync
 *
 * 防误伤红线（永不 kill 用户浏览器——用户浏览器无登记 + 无本包串，三重守卫
 * 前两道即天然排除）：杀的对象永远 = 「lasso 登记过 + 无任何活 owner 认领 +
 * cmdline 仍是 lasso 锁定上游 + 进程起始时间与登记一致 + 全组 owner 已死」的
 * 进程树——任一条件不满足即零动作（只清记录，绝不杀）。
 *
 * 容错（守 spawn 成功不被清理失败拖死）：读写全部 best-effort——写失败 warn 不抛；
 * 读侧损坏 → []；ps/lstart 解析失败 → fail-safe 只清记录绝不杀（决议 §7 残余 3：
 * lstart 核对是加严守卫，不可成为新误杀面）。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { logger } from "../util/logger.js";
// 致死原语单一真源（SubprocessManager._killTreeSync / chrome-stop 共用同一实现）
import { killTreeSync } from "../util/kill-tree.js";

// ============================================================
// 类型 + 路径
// ============================================================
/** 一条栈登记（spawn 成功即追加；pid + ownerPid 双键）。 */
export interface HeadlessStackRecord {
  /** SubprocessManager spec 名（"headless" / "logged_in:<profile>" / ...）。 */
  specName: string;
  /** 栈根 pid（McpClient.transport.pid = npx shim 直子进程）。 */
  pid: number;
  /** spawn 者（lasso server 进程）pid——归属锚；同 pid 记录任一 owner 活 → 整组豁免。 */
  ownerPid: number;
  /** 登记时刻 epoch ms（与 lifecyclePids 同写点：connectStdio 返回后）。 */
  spawnedAt: number;
}

/** sidecar 路径（env 覆盖测试隔离；与 chrome-ledger 同容错哲学）。 */
export function stacksLedgerPath(): string {
  const override = process.env.LASSO_HEADLESS_STACKS_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".cache", "lasso", "headless-stacks.json");
}

// ============================================================
// 读写（tmp+rename 原子写；全 best-effort）
// ============================================================
/** 读全部登记（文件缺失/损坏/非数组 → []，不抛）。 */
export function readStacksSync(): HeadlessStackRecord[] {
  try {
    const body = readFileSync(stacksLedgerPath(), "utf8");
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return [];
    const out: HeadlessStackRecord[] = [];
    for (const r of parsed) {
      if (
        r &&
        typeof r === "object" &&
        typeof (r as HeadlessStackRecord).specName === "string" &&
        typeof (r as HeadlessStackRecord).pid === "number" &&
        typeof (r as HeadlessStackRecord).ownerPid === "number" &&
        typeof (r as HeadlessStackRecord).spawnedAt === "number"
      ) {
        out.push(r as HeadlessStackRecord);
      }
      // 未知字段忽略（前向兼容，chrome-ledger 同款）
    }
    return out;
  } catch {
    return [];
  }
}

function writeStacksSync(records: HeadlessStackRecord[]): void {
  const file = stacksLedgerPath();
  try {
    if (records.length === 0) {
      // 空账直接删文件（不留 [] 残骸——doctor stealth-check 等真实 spawn 用例的
      // kill 收尾路径会把账清空；unlink 幂等吞掉不存在）
      try {
        unlinkSync(file);
      } catch {
        // best-effort
      }
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(records), "utf8");
    renameSync(tmp, file);
  } catch (e) {
    // best-effort：登记写失败不阻断 spawn（chrome-ledger 容错同款）
    logger.warn({ evt: "headless_stacks_write_failed", error: String(e) });
  }
}

/** spawn 成功即追加登记（与 SubprocessManager.lifecyclePids 同写点）。 */
export function appendStackRecord(rec: HeadlessStackRecord): void {
  const all = readStacksSync();
  // 同 pid+owner 双键去重（respawn 重试窗内不重复膨胀）
  if (all.some((r) => r.pid === rec.pid && r.ownerPid === rec.ownerPid)) return;
  all.push(rec);
  writeStacksSync(all);
}

/** 清除指定 pid 集合的全部登记条目（kill 后 / 判定后收尾）。 */
export function removeStackRecords(pids: number[]): void {
  if (pids.length === 0) return;
  const drop = new Set(pids);
  writeStacksSync(readStacksSync().filter((r) => !drop.has(r.pid)));
}

/** 清除某 owner 的全部登记（server 正常停机 exit 钩子，best-effort；空账删文件）。 */
export function removeStackRecordsForOwner(ownerPid: number): void {
  const before = readStacksSync();
  const after = before.filter((r) => r.ownerPid !== ownerPid);
  if (after.length === before.length) return; // 无变化零写（幂等，含文件不存在）
  writeStacksSync(after); // 空数组 → 删文件（writeStacksSync 内收口）
}

// ============================================================
// 判杀算法（R1 pid 归并版；全依赖可注入，导出供测试）
// ============================================================
/**
 * 进程起始时间交叉核对的容差（决议 B-2 ③）：
 *  - 前向（pid 复用方向）：+5s——lstart 比 spawnedAt **晚** 超过 5s = 该 pid 已被
 *    任何新进程复用（哪怕是另一 lasso 栈），只清记录绝不杀。
 *  - 后向（spawn 窗口方向）：-60s——spawnedAt 在 connectStdio 返回后落笔
 *    （lifecyclePids 同点），真实进程 lstart 早于它一个 MCP 握手窗（健康
 *    ~3-6s / 首装极值 17.2s / 握手预算顶 20s → 60s 保守界）。决议原文「±5s」
 *    隐含 spawnedAt≈进程起点；握手窗是实施期修正（方向 = 少杀，安全向），
 *    见本文件头注释与 doc/bugs/08 §7 残余 3。
 */
export const LSTART_FORWARD_TOLERANCE_MS = 5_000;
export const LSTART_BACKWARD_BOUND_MS = 60_000;

/** sweep 可注入依赖（测试真值表注入假 ps/kill；生产缺省真实实现）。 */
export interface SweepDeps {
  /** pid 存活探测（signal 0）。 */
  isPidAlive?: (pid: number) => boolean;
  /** `ps -p <pid> -o command=` 输出（null = ps 失败/无此进程）。 */
  psCommand?: (pid: number) => string | null;
  /** `ps -p <pid> -o lstart=` 输出（null = 失败；解析由 parseLstartToEpochMs 做）。 */
  psLstart?: (pid: number) => string | null;
  /** 致死原语（生产 = killTreeSync，单一真源）。 */
  killTree?: (pid: number) => void;
  /** lasso 锁定上游包串（条件②精确匹配；生产由 SubprocessManager 拼 LOCKED_CDP_MCP_VERSION）。 */
  expectedPackageToken: string;
  /** 日志（测试静默注入）。 */
  log?: (payload: Record<string, unknown>) => void;
}

/** sweep 结果（doctor / 测试可观测）。 */
export interface SweepResult {
  /** 被树杀的孤儿栈 pid（全组 owner 死 + 三重判定 + lstart 全过）。 */
  killed: number[];
  /** 只清了记录、未杀的 pid（pid 复用嫌疑 / pid 已死 / 解析 fail-safe）。 */
  recordsClearedOnly: number[];
  /** 活 owner 豁免的 pid 组（零动作——多 lasso server 并存合法）。 */
  skippedLiveOwner: number[];
}

/**
 * 解析 `ps -o lstart=` 输出 → epoch ms。
 * macOS/Linux 输出形如 "Mon Sep 15 18:34:17 2026"（DAY MON DD HH:MM:SS YYYY；
 * 日字段双空格填充）。规范化空白后 Date.parse（V8 宽容该形态）；解析失败 → null
 * （调用方 fail-safe 只清记录绝不杀）。
 */
export function parseLstartToEpochMs(raw: string): number | null {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

/**
 * 任意 spawn 前的孤儿栈扫除（触发面：全部 spec 的 spawn——陈旧记录的清理收敛性
 * 不依赖同 spec 再被使用）。
 *
 * 判定序（= 实现序，INV-96③ 文本锚）：
 *  1. **pid 归并**：全部记录按 pid 分组；组内任一记录 ownerPid 活 → 整组零动作
 *     （仅清组内 owner 已死的条目）——封死跨记录 pid 复用误杀活栈。
 *  2. 组内全部 ownerPid 死 → pid 三重判定：
 *     ① pid 存活；② ps command 含精确包串；③ lstart 与 spawnedAt 一致
 *     （前向 +5s / 后向 -60s 容差，见常量注释）。
 *  3. ①不成立 → 清记录；②或③不成立（或解析失败）→ **只清记录绝不杀**；
 *     全过 → killTreeSync(pid)（npx→node→Chromium 整树，systemd 单元级组杀
 *     对应物）+ 清该组记录。
 */
export function sweepOrphanStacks(deps: SweepDeps): SweepResult {
  const log = deps.log ?? ((p: Record<string, unknown>) => logger.info(p));
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const psCommand = deps.psCommand ?? defaultPsCommand;
  const psLstart = deps.psLstart ?? defaultPsLstart;
  const killTree = deps.killTree ?? ((pid: number) => killTreeSync(pid, "headless-stack-mutex"));

  const records = readStacksSync();
  if (records.length === 0) return { killed: [], recordsClearedOnly: [], skippedLiveOwner: [] };

  // ---- 1. pid 级归并 ----
  const groups = new Map<number, HeadlessStackRecord[]>();
  for (const r of records) {
    const g = groups.get(r.pid);
    if (g) g.push(r);
    else groups.set(r.pid, [r]);
  }

  const killed: number[] = [];
  const clearedOnly: number[] = [];
  const skippedLiveOwner: number[] = [];
  let mutated = false;
  let next = records;

  for (const [pid, group] of groups) {
    const anyLiveOwner = group.some((r) => isPidAlive(r.ownerPid));
    if (anyLiveOwner) {
      // 整组零动作——但组内 owner 已死的陈旧条目仍清（收敛性）
      const stale = group.filter((r) => !isPidAlive(r.ownerPid));
      if (stale.length > 0) {
        next = next.filter((r) => !stale.includes(r));
        mutated = true;
      }
      skippedLiveOwner.push(pid);
      continue;
    }

    // ---- 2. 全组 owner 死 → pid 三重判定 ----
    // ① pid 存活
    if (!isPidAlive(pid)) {
      next = next.filter((r) => r.pid !== pid);
      mutated = true;
      clearedOnly.push(pid);
      continue;
    }
    // ② cmdline 仍是 lasso 锁定上游（精确包串——排除任何非 lasso 进程复用该 pid）
    const cmd = psCommand(pid);
    if (cmd === null || !cmd.includes(deps.expectedPackageToken)) {
      next = next.filter((r) => r.pid !== pid);
      mutated = true;
      clearedOnly.push(pid);
      log({ evt: "headless_stack_sweep_pid_reuse_suspect", pid, clear_only: true });
      continue;
    }
    // ③ lstart 与 spawnedAt 交叉核对（解析失败 fail-safe 只清记录绝不杀）
    const newestSpawnedAt = Math.max(...group.map((r) => r.spawnedAt));
    const oldestSpawnedAt = Math.min(...group.map((r) => r.spawnedAt));
    const lstartRaw = psLstart(pid);
    const lstartMs = lstartRaw === null ? null : parseLstartToEpochMs(lstartRaw);
    const lstartConsistent =
      lstartMs !== null &&
      lstartMs <= newestSpawnedAt + LSTART_FORWARD_TOLERANCE_MS &&
      lstartMs >= oldestSpawnedAt - LSTART_BACKWARD_BOUND_MS;
    if (!lstartConsistent) {
      next = next.filter((r) => r.pid !== pid);
      mutated = true;
      clearedOnly.push(pid);
      log({ evt: "headless_stack_sweep_lstart_mismatch", pid, clear_only: true });
      continue;
    }

    // ---- 3. 全过 → 杀整树 + 清组记录 ----
    killTree(pid);
    killed.push(pid);
    next = next.filter((r) => r.pid !== pid);
    mutated = true;
    log({
      evt: "headless_stack_sweep_killed",
      pid,
      spec_names: group.map((r) => r.specName),
      reason: "headless-stack-mutex",
    });
  }

  if (mutated) writeStacksSync(next);
  return { killed, recordsClearedOnly: clearedOnly, skippedLiveOwner };
}

// ============================================================
// 生产缺省实现（ps 同步短超时；异常 → null 上浮 fail-safe）
// ============================================================
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runPs(pid: number, args: string[]): string | null {
  try {
    const r = spawnSync("ps", ["-p", String(pid), ...args], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (r.status !== 0 || r.error) return null;
    return r.stdout ?? null;
  } catch {
    return null;
  }
}

function defaultPsCommand(pid: number): string | null {
  return runPs(pid, ["-o", "command="]);
}

function defaultPsLstart(pid: number): string | null {
  return runPs(pid, ["-o", "lstart="]);
}
