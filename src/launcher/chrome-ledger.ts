/**
 * chrome-ledger.ts（v1.9 parse17 §3.2 机制二 —— launch-chrome 磁盘台账）
 *
 * 跨进程所有权记录：launch-chrome 是独立 CLI 进程，spawn 后即 process.exit()
 * （launch-chrome.ts runLaunchChromeCli）——内存台账（SubprocessManager.lifecyclePids
 * 同款）天然不可用，因为消费方（chrome-stop / server 停机）在不同进程。所有权必须落盘。
 *
 * 文件：~/.cache/lasso/launched-chromes.json（env LASSO_LAUNCHED_CHROMES_PATH 可
 * 覆盖，测试隔离用）。数组形态，一 port 至多一条（同 port 覆盖）。
 *
 * INV-64 衍生：本文件只 import node:* 内置 + 同目录模块（chrome-stop / launch-chrome
 * 互引合规）；结构化日志经注入的 logFn（默认走 console.warn 兜底——launcher 禁引
 * ../util/logger 之外的业务内部，index.ts 装配侧用 logger 包一层）。
 *
 * 容错（守 launch 成功不被清理失败拖死）：
 *  - 写失败（磁盘满 / 权限）→ warn 不抛（best-effort；台账写失败不让 launch 失败）
 *  - 读侧文件损坏 / 不存在 → []（不 throw；未知字段忽略，前向兼容）
 *  - tmp+rename 原子写（并发 chrome-stop / 停机收尾读不到半截 JSON）
 */
import { promises as fsp, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";

// ============================================================
// 类型
// ============================================================
/** 一条台账记录（launch-chrome spawn 成功/慢启动后落盘）。 */
export interface LaunchedChromeRecord {
  /** CDP 端口（台账主键；一 port 至多一条）。 */
  port: number;
  /** spawn 的 Chrome 根进程 pid（杀前 cmdline 验证归属）。 */
  pid: number;
  /** spawn 时注入的 --user-data-dir（lasso 隔离 profile 标记）。 */
  profileDir: string;
  /** epoch ms。 */
  launchedAt: number;
  /** "ready" = CDP 探活通过；"cdp_not_ready" = 慢启动窗口内未通（真实存在，wave2 pid 74620）。 */
  status: "ready" | "cdp_not_ready";
  /**
   * v1.10（parse18 §2.5）：spawn 档冗余记录（诊断 / audit 用；reaper 预建判定读）。
   * 可选 = 前向兼容（v1.9 台账无此字段仍可读）。
   * v1.19（渲染档设计决议 3.1 落点 1）：扩第三值 "render"——渲染档（确定性 headless，
   * 服务 media-gen-mcp 等外部消费方）。readLedgerSync 解析守卫同步三值
   * （🔴 守卫漏改则 render 记录被静默降级 undefined = 按 hidden 处理，表面能跑语义错）。
   * BUG-03 决议 B2（doc/bugs/03 §4 B2）：扩第四值 "headless"——日常档的可选无头
   * 形态（--mode headless）：零窗口/零 AX 面。🔴 对抗复审 r1（2026-09-08）真机
   * 证伪 B2 原始声明「不占 Dock 槽位」——激活仍被同 bundle id 单实例吸收（见
   * launch-chrome headless_dock_slot_caveat）；无法 chrome-show（登录交互流破碎），
   * 故不切默认，有人用的机器用 hidden。
   */
  launchMode?: "hidden" | "visible" | "render" | "headless";
  /**
   * v1.10（parse18 §2.5）：per-launch idle 覆盖（CLI --idle-ms 传入）。
   * undefined = 用全局默认（config.launchIdleMs）；显式 0 = 该记录禁用回收。
   * 用途：某次 launch 明确是「长会话抓取」时单独放行，不污染全局默认。
   */
  idleMs?: number;
  /**
   * BUG-03 决议 A1（2026-09-07，doc/bugs/03 §4 A1）：拉起者归属——停机不连坐的
   * 主键。spawn 进程记录自己的 pid；任何进程退出只许收 `ownerPid === 自己` 的
   * Chrome。旧台账无此字段的陈留记录 = 归「无人」——永不因他人退出被杀（失败
   * 方向安全：只会少杀不会多杀），只走 idle 超时收割或显式 chrome-stop。
   */
  ownerKind?: "server" | "cli";
  /** 见 ownerKind（typeof 守卫解析，前向兼容同 launchMode/idleMs）。 */
  ownerPid?: number;
  /**
   * BUG-03 决议 B1/F4（doc/bugs/03 §4 B1）：用户认领时刻（epoch ms）。
   * 两条落写路径：B1 用户激活确认窗（连续 N tick 双判据门）+ chrome-show 成功
   * （显式操作 > 任何启发式）。落写后：粘滞执守对本 pid 退位、idle 收割禁用、
   * 停机/exit 收割豁免（等同 visible 红线）——唯一关闭出口 = 用户自己关或显式
   * chrome-stop。显式 chrome-hide 重武装时清除（双向可逆）。
   */
  userTakenAt?: number;
}

/**
 * BUG-03 决议 A1 单一真源常量：CLI 显式拉起的默认 idle（30min）。
 *
 * 语义：「有活动（touch 续命）就活，无消费者到期自动收」——hidden 档获得自己的
 * 退场默认（bug02 §9.1 的 idleMs:0 拆掉了「用完即关」出口，8.5h 级常驻是激活
 * 劫持可达性的放大器）。显式 `--idle-ms 0` 与显式 env/config 配置仍最高优先
 * （既有消费者零破坏）；外部 CDP 消费者一行 `touch ~/.cache/lasso/chrome-touch-<port>`
 * 即续命（承诺口径修订为 "stay alive while in use"）。
 * 放本文件（chrome-ledger 零依赖）：launch-chrome / desired-hide-enforcer / index.ts
 * 三方共用，避免 launcher 目录内循环 import。
 */
export const CLI_LAUNCH_IDLE_DEFAULT_MS = 30 * 60 * 1000;

/** 台账路径（env LASSO_LAUNCHED_CHROMES_PATH 可覆盖；测试隔离 + 同机多 agent 并行验收隔离用，配方见 doc/渲染档-并行验收隔离配方.md）。 */
export function launchedChromesPath(): string {
  const override = process.env.LASSO_LAUNCHED_CHROMES_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".cache", "lasso", "launched-chromes.json");
}

/** launcher 侧结构化日志（INV-64：不 import ../util/logger；由调用方注入）。 */
export type LedgerLogFn = (payload: Record<string, unknown>) => void;

/** 默认日志兜底：stderr 单行 JSON（无 logger 依赖；index.ts 侧用 logger 包）。 */
function defaultLog(payload: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ ts: Date.now(), ...payload })}\n`,
  );
}

// ============================================================
// 读（容错解析）
// ============================================================
/**
 * 同步读台账（exit 钩子路径用；chrome-stop CLI 也用）。
 * 文件不存在 / JSON 损坏 / 顶层非数组 → []（不 throw）。
 * 未知字段忽略（前向兼容）；单条形状不对（缺 port/pid number）跳过。
 */
export function readLedgerSync(): LaunchedChromeRecord[] {
  let body: string;
  try {
    body = readFileSync(launchedChromesPath(), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    defaultLog({ evt: "chrome_ledger_parse_error", path: launchedChromesPath() });
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: LaunchedChromeRecord[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.port !== "number" || typeof r.pid !== "number") continue;
    if (typeof r.profileDir !== "string" || typeof r.launchedAt !== "number") continue;
    out.push({
      port: r.port,
      pid: r.pid,
      profileDir: r.profileDir,
      launchedAt: r.launchedAt,
      status: r.status === "cdp_not_ready" ? "cdp_not_ready" : "ready",
      // v1.10（parse18 §2.5）：两可选字段 typeof 守卫解析（前向兼容；
      // 非法形态降级 undefined = 走全局默认档）
      // v1.19（渲染档设计决议 3.1 落点 1）：launchMode 扩第三值 "render"（守卫
      // 同步三值——漏改则 render 记录被静默读成 undefined，chrome-ledger.spec
      // 「render 写读往返」用例钉死）
      // BUG-03 B2：扩第四值 "headless"（守卫同步——同上漏改风险）
      launchMode:
        typeof r.launchMode === "string" &&
        (r.launchMode === "hidden" || r.launchMode === "visible" || r.launchMode === "render" || r.launchMode === "headless")
          ? r.launchMode
          : undefined,
      idleMs: typeof r.idleMs === "number" && Number.isFinite(r.idleMs) ? r.idleMs : undefined,
      // BUG-03 A1/B1：归属三字段同款 typeof 守卫（前向兼容；非法形态降级 undefined =
      // 无人归属 / 未认领——两个降级方向都偏「不杀」侧，失败方向安全）
      ownerKind:
        typeof r.ownerKind === "string" && (r.ownerKind === "server" || r.ownerKind === "cli")
          ? r.ownerKind
          : undefined,
      ownerPid:
        typeof r.ownerPid === "number" && Number.isInteger(r.ownerPid) ? r.ownerPid : undefined,
      userTakenAt:
        typeof r.userTakenAt === "number" && Number.isFinite(r.userTakenAt) ? r.userTakenAt : undefined,
    });
  }
  return out;
}

// ============================================================
// 写（tmp + rename 原子；best-effort）
// ============================================================
/**
 * 落盘一条记录：读旧 → 同 port 覆盖（一 port 至多一条）→ tmp+rename 原子写。
 * 全程 try/catch best-effort——台账写失败不让 launch 失败，但必须 warn（doctor 可查）。
 */
export async function recordLaunch(
  rec: LaunchedChromeRecord,
  logFn: LedgerLogFn = defaultLog,
): Promise<void> {
  try {
    const target = launchedChromesPath();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const existing = readLedgerSync().filter((r) => r.port !== rec.port);
    const next = [...existing, rec];
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, target);
    logFn({ evt: "chrome_ledger_recorded", port: rec.port, pid: rec.pid, status: rec.status });
  } catch (e) {
    logFn({ evt: "chrome_ledger_write_error", error: String(e), port: rec.port, pid: rec.pid });
  }
}

/** 批量删台账条目（按 port；chrome-stop 消费后清账）。best-effort 同上。 */
export async function removeLedgerEntries(
  ports: number[],
  logFn: LedgerLogFn = defaultLog,
): Promise<void> {
  try {
    const remaining = readLedgerSync().filter((r) => !ports.includes(r.port));
    const target = launchedChromesPath();
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(remaining, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, target);
  } catch (e) {
    logFn({ evt: "chrome_ledger_remove_error", error: String(e), ports });
  }
}

/** 同步删台账条目（exit 钩子路径；零 await 纪律）。 */
export function removeLedgerEntriesSync(
  ports: number[],
  logFn: LedgerLogFn = defaultLog,
): void {
  try {
    const remaining = readLedgerSync().filter((r) => !ports.includes(r.port));
    const target = launchedChromesPath();
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify(remaining, null, 2) + "\n", "utf8");
    renameSync(tmp, target);
  } catch (e) {
    logFn({ evt: "chrome_ledger_remove_error", error: String(e), ports });
  }
}

// ============================================================
// BUG-03 决议 B1/F4（doc/bugs/03 §4 B1）：userTakenAt 落写/清除
// ============================================================
/**
 * 落 userTakenAt（按 pid）。**全库仅两条合法调用路径**（INV-85 账面突变禁令锚）：
 *  1. desired-hide-watchdog 确认窗满（连续 USER_ACTIVATION_CONFIRM_TICKS tick
 *     双判据门命中）；
 *  2. chrome-show 成功（显式操作 > 任何启发式，§4.0-F4——B1 启发式拿到的保护
 *     待遇不得高于显式操作）。
 * 其余字段原样保留（同 pid 覆盖式 read-modify-write；best-effort 不抛）。
 * 已认领记录的效果：粘滞执守退位 + idle 收割禁用 + 停机/exit 收割豁免
 * （INV-86 exemptUserTaken）——唯一关闭出口 = 用户自己关或显式 chrome-stop。
 */
export async function markUserTakenByPid(
  pid: number,
  logFn: LedgerLogFn = defaultLog,
): Promise<void> {
  try {
    const target = launchedChromesPath();
    const next = readLedgerSync().map((r) =>
      r.pid === pid && r.userTakenAt === undefined ? { ...r, userTakenAt: Date.now() } : r,
    );
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, target);
    logFn({ evt: "chrome_ledger_user_taken", pid });
  } catch (e) {
    logFn({ evt: "chrome_ledger_user_taken_error", error: String(e), pid });
  }
}

/**
 * 记录是否「用户拥有」（BUG-03 adversarial r2 F1，2026-09-08）——**一切程序化
 * 收割/自愈门不得触碰**的记录面（A2 僵尸门 / doctor 归因共用）：
 *  - `userTakenAt` 已落（B1 确认窗或显式 chrome-show 认领）——契约见
 *    markUserTakenByPid 头注：「唯一关闭出口 = 用户自己关或显式 chrome-stop」；
 *  - `launchMode === "visible"`——v1.17.3 P1 红线（用户登录窗口永不后台杀）。
 * r1 实锤事故型：A2 自愈门曾把 userTakenAt 已认领的 Chrome（真机 chrome-show
 * 认领 + SIGSTOP 模拟 CDP 死）在 relaunch 时整窗杀掉——「唯一关闭出口」契约
 * 被 third kill path 逃逸（doc/bugs/03 §9 r2-F1）。本谓词是该契约的机械锚。
 */
export function isUserOwnedRecord(rec: LaunchedChromeRecord): boolean {
  return rec.userTakenAt !== undefined || rec.launchMode === "visible";
}

/**
 * 清 userTakenAt（按 pid）——**唯一调用路径 = 显式 chrome-hide 成功**（重武装：
 * 写粘滞账恢复执守 + 同步清台账认领标记——让位/武装两态与粘滞账/台账双账一致，
 * 不留「已重武装但仍收割豁免」的混合态）。幂等（未认领记录零写）。
 */
export async function clearUserTakenByPid(
  pid: number,
  logFn: LedgerLogFn = defaultLog,
): Promise<void> {
  try {
    const current = readLedgerSync();
    if (!current.some((r) => r.pid === pid && r.userTakenAt !== undefined)) return;
    const target = launchedChromesPath();
    const next = current.map((r) => {
      if (r.pid !== pid || r.userTakenAt === undefined) return r;
      const { userTakenAt: _drop, ...rest } = r;
      return rest;
    });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, target);
    logFn({ evt: "chrome_ledger_user_taken_cleared", pid });
  } catch (e) {
    logFn({ evt: "chrome_ledger_user_taken_clear_error", error: String(e), pid });
  }
}
