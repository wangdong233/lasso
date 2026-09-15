/**
 * headless-fresh-profile.ts（BUG-08 决议 C，doc/bugs/08，2026-09-15）
 *
 * freshProfile（反爬逃生门）的纯函数面：临时 profile 目录命名（归属锚编码进
 * 目录名）+ rmSync 前缀守卫 + 崩溃孤儿陈年扫描（render-doctor
 * RENDER_STALE_PROFILE_MS=24h 先例直译：age 线避免与拉起窗口竞态 + 双闸
 * fail-safe，禁 glob 全删）。
 *
 * 身份隔离铁则（FP-Block ESORICS 2015 / Crawlee Session 模型）：换脸 = 整个新
 * 一致身份（profile 目录 + stealth profile 同步切换）；「换脸后用完即弃」的
 * 清理三路即时 + 一路陈年兜底，全部 rmSync 带 `headless-profile-` basename
 * 前缀守卫（cleanupRenderProfile「删目录与杀进程同红线」镜像）。
 *
 * 目录命名：`headless-profile-<epochMs>-<rand6>-p<ownerPid>/`——ownerPid 归属锚
 * 直接编码进目录名（崩溃原子、无侧车写竞态；profile 的孤儿判定不依赖任何
 * 外部状态）。镜像 RENDER_PROFILE_PREFIX 形态 + R1 归属锚后缀。
 */
import { rmSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";

/** 全部 rmSync 的 basename 前缀守卫锚（INV-96④）。 */
export const HEADLESS_PROFILE_PREFIX = "headless-profile-";

/**
 * 陈年兜底 age 线（24h）。freshProfile 身份生命期上界 = idle reaper 5min 级，
 * 24h 线极保守（render-doctor 先例同值）；作用 = 避免与拉起窗口竞态——
 * 刚 mkdir 还未 spawn 的目录不会被任何一方误删。
 */
export const HEADLESS_STALE_PROFILE_MS = 24 * 60 * 60 * 1000;

/** fresh profile 基目录（render-launcher profileBaseDir 同款：~/.cache/lasso）。 */
export function headlessProfileBaseDir(): string {
  return path.join(os.homedir(), ".cache", "lasso");
}

/** 构造带归属锚的 fresh profile 目录名（导出供测试断言形态）。 */
export function buildFreshProfileDirName(
  ownerPid: number,
  nowMs: number,
  rand: string,
): string {
  return `${HEADLESS_PROFILE_PREFIX}${nowMs}-${rand}-p${ownerPid}`;
}

/**
 * 从目录名解析归属锚 ownerPid（`...-p<digits>` 尾锚）；无锚/畸形 → null。
 */
export function parseOwnerPidFromProfileDir(name: string): number | null {
  const m = name.match(/-p(\d+)$/);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * 受守卫的 rmSync（全部 fresh profile 删除的唯一出口——INV-96④ tripwire：
 * 禁任何裸 rmSync 指向 fresh profile 目录）。
 *  - basename 必须以 HEADLESS_PROFILE_PREFIX 起头（非法 basename 拒删）；
 *  - recursive + force（树已死无竞态；陈年兜底对半损目录幂等）。
 */
export function rmFreshProfileDir(dir: string): void {
  const base = path.basename(dir);
  if (!base.startsWith(HEADLESS_PROFILE_PREFIX)) {
    throw new Error(
      `fresh_profile_refuse_delete: basename "${base}" lacks prefix guard ${HEADLESS_PROFILE_PREFIX}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

// ============================================================
// 崩溃孤儿陈年扫描（清理路径④——封死 SIGKILL 泄漏）
// ============================================================
/**
 * 双闸全过才删（两闸皆 fail-safe）：
 *  1. 目录名编码的 ownerPid 已死（pid 复用只会让死 owner 显活 → 跳过——泄漏
 *     顺延到下一轮，永不误删活 server 的在用 profile）；
 *  2. age > 24h（age 线 = 目录名 epoch；锚缺失退化 mtime）。
 * 无归属锚（-p<digits>）+ age>24h → 删（本 feature 唯一产物都带锚；无锚老目录
 * 只能是残骸——按决策 C 真值表删除）。前缀不符 → 跳过（不属本域）。
 * 🔴 明确禁止 glob `headless-profile-*` 无条件全删（并发双 server 会删掉对方
 * 在用活 profile——macOS 上 in-use 目录被 rm → 对方 Chromium 新写失败）。
 */
export interface StaleProfileScanDeps {
  /** pid 存活探测（生产 process.kill(pid,0)；测试注入）。 */
  isPidAlive: (pid: number) => boolean;
  /** 目录枚举（生产 readdirSync withFileTypes；测试注入）。 */
  readDir: (base: string) => Array<{ name: string; isDirectory: boolean }>;
  /** 目录 age 数据（生产 statSync mtimeMs；测试注入）。 */
  statAgeMs: (dir: string) => number | null;
  /** 受守卫删除（生产 rmFreshProfileDir；测试注入）。 */
  remove: (dir: string) => void;
  /** 时钟（测试注入）。 */
  now: () => number;
}

export interface StaleProfileScanResult {
  removed: string[];
  /** 留守目录 + 原因（可观测：doctor/日志）。 */
  kept: Array<{ dir: string; reason: string }>;
}

export function scanStaleFreshProfiles(
  baseDir: string,
  deps: StaleProfileScanDeps,
): StaleProfileScanResult {
  const removed: string[] = [];
  const kept: Array<{ dir: string; reason: string }> = [];
  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    entries = deps.readDir(baseDir);
  } catch {
    return { removed, kept }; // 基目录不存在 → 空
  }
  for (const e of entries) {
    if (!e.isDirectory || !e.name.startsWith(HEADLESS_PROFILE_PREFIX)) continue;
    const dir = path.join(baseDir, e.name);
    // age：目录名 epoch 优先（identity 诞生时刻，Chromium 写盘不刷新）；锚缺失退化 mtime
    const epochMatch = e.name.slice(HEADLESS_PROFILE_PREFIX.length).match(/^(\d+)-/);
    let ageMs: number;
    if (epochMatch) {
      ageMs = deps.now() - Number(epochMatch[1]);
    } else {
      const mtime = deps.statAgeMs(dir);
      if (mtime === null) {
        kept.push({ dir, reason: "stat_failed" });
        continue;
      }
      ageMs = deps.now() - mtime;
    }
    if (ageMs <= HEADLESS_STALE_PROFILE_MS) {
      kept.push({ dir, reason: "age_below_24h" });
      continue;
    }
    const ownerPid = parseOwnerPidFromProfileDir(e.name);
    if (ownerPid === null) {
      // 无归属锚 + 超龄 → 残骸删除（真值表行）；有锚走 owner 闸
      deps.remove(dir);
      removed.push(dir);
      continue;
    }
    if (deps.isPidAlive(ownerPid)) {
      kept.push({ dir, reason: "owner_alive" });
      continue;
    }
    deps.remove(dir);
    removed.push(dir);
  }
  return { removed, kept };
}
