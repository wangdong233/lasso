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
   */
  launchMode?: "hidden" | "visible" | "render";
  /**
   * v1.10（parse18 §2.5）：per-launch idle 覆盖（CLI --idle-ms 传入）。
   * undefined = 用全局默认（config.launchIdleMs）；显式 0 = 该记录禁用回收。
   * 用途：某次 launch 明确是「长会话抓取」时单独放行，不污染全局默认。
   */
  idleMs?: number;
}

/** 台账路径（env LASSO_LAUNCHED_CHROMES_PATH 可覆盖；测试隔离用）。 */
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
      launchMode:
        typeof r.launchMode === "string" &&
        (r.launchMode === "hidden" || r.launchMode === "visible" || r.launchMode === "render")
          ? r.launchMode
          : undefined,
      idleMs: typeof r.idleMs === "number" && Number.isFinite(r.idleMs) ? r.idleMs : undefined,
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
