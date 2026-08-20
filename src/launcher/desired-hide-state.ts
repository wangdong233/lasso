/**
 * desired-hide-state.ts（P27 v1.18.3 —— desiredHidden 粘滞台账）
 *
 * 背景（得到全量实战 P27 闪现实锤链）：
 *  - Chrome（台账 visible 档，登录流程产物）经 chrome-hide 转后台后，运行期间
 *    仍会被**未知激活源**反复掀出（上游 CDP 操作 / 页面 JS / Chrome 内部行为），
 *    引擎侧只能章尾守卫复隐——闪现窗口 ≤ 单章时长（实测 8-12s），用户可感知。
 *  - 用户裁决（2026-08-20）：「彻底解决」+ P17 定性——静默性是**工具层机制职责**，
 *    不是工作流纪律。引擎纪律（章尾守卫）只能缓解，不能根治。
 *
 * 机制：chrome-hide 成功时**粘滞记账**（desiredHidden=true），chrome-show 清账；
 * 任何 lasso server 进程内的 desired-hide-watchdog 每 tick 读账复隐——把闪现
 * 上限从「章时长」压到「tick 间隔」（ms 级），且与触发源无关（防御任意 unhide）。
 *
 * 文件：~/.cache/lasso/desired-hidden.json（env LASSO_DESIRED_HIDDEN_PATH 可覆盖，
 * 测试隔离用；与 chrome-ledger 同范式）。数组形态，一 pid 至多一条。
 *
 * INV-64 合规：只 import node:* 内置；日志经注入 logFn（同 LedgerLogFn 形状）。
 * 容错：tmp+rename 原子写；读侧损坏 → []；写失败 warn 不抛（best-effort——
 * 粘滞账写失败不让 chrome-hide 失败，watchdog 只是增强而非主路径）。
 */
import { promises as fsp, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import process from "node:process";
import type { LedgerLogFn } from "./chrome-ledger.js";

/** 一条粘滞记录（chrome-hide 成功时写入；chrome-show 移除）。 */
export interface DesiredHiddenRecord {
  /** Chrome 根进程 pid（watchdog 复隐 + 归属复验的主键）。 */
  pid: number;
  /** CDP 端口（诊断用；与 launched-chromes 台账按 port 对应）。 */
  port: number;
  /** profile 目录（watchdog 每 tick 复验 cmdline 归属，防 pid 复用误伤）。 */
  profileDir: string;
  /** epoch ms（chrome-hide 成功时刻；诊断「粘滞多久」）。 */
  hiddenAt: number;
}

/** 台账路径（env LASSO_DESIRED_HIDDEN_PATH 可覆盖；测试隔离用）。 */
export function desiredHiddenPath(): string {
  const override = process.env.LASSO_DESIRED_HIDDEN_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".cache", "lasso", "desired-hidden.json");
}

/**
 * 同步读粘滞账（watchdog tick / 测试用）。
 * 文件不存在 / JSON 损坏 / 顶层非数组 → []（不 throw）；单条形状不对跳过。
 */
export function readDesiredHiddenSync(): DesiredHiddenRecord[] {
  let body: string;
  try {
    body = readFileSync(desiredHiddenPath(), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DesiredHiddenRecord[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.pid !== "number" || typeof r.port !== "number") continue;
    if (typeof r.profileDir !== "string" || typeof r.hiddenAt !== "number") continue;
    out.push({ pid: r.pid, port: r.port, profileDir: r.profileDir, hiddenAt: r.hiddenAt });
  }
  return out;
}

/** 落盘一条粘滞记录（同 pid 覆盖；tmp+rename 原子；best-effort）。 */
export async function addDesiredHidden(
  rec: DesiredHiddenRecord,
  logFn: LedgerLogFn = () => {},
): Promise<void> {
  try {
    const target = desiredHiddenPath();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const existing = readDesiredHiddenSync().filter((r) => r.pid !== rec.pid);
    const next = [...existing, rec];
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, target);
    logFn({ evt: "desired_hidden_recorded", pid: rec.pid, port: rec.port });
  } catch (e) {
    logFn({ evt: "desired_hidden_record_error", error: String(e), pid: rec.pid, port: rec.port });
  }
}

/** 移除粘滞记录（chrome-show 成功时；按 pid）。 */
export async function removeDesiredHidden(
  pid: number,
  logFn: LedgerLogFn = () => {},
): Promise<void> {
  try {
    const remaining = readDesiredHiddenSync().filter((r) => r.pid !== pid);
    const target = desiredHiddenPath();
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(remaining, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, target);
    logFn({ evt: "desired_hidden_cleared", pid });
  } catch (e) {
    logFn({ evt: "desired_hidden_clear_error", error: String(e), pid });
  }
}

/** 同步批量重写（watchdog tick 剔除死 pid / pid 复用后落盘；零 await 纪律）。 */
export function rewriteDesiredHiddenSync(
  records: DesiredHiddenRecord[],
  logFn: LedgerLogFn = () => {},
): void {
  try {
    const target = desiredHiddenPath();
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", "utf8");
    renameSync(tmp, target);
  } catch (e) {
    logFn({ evt: "desired_hidden_rewrite_error", error: String(e) });
  }
}
