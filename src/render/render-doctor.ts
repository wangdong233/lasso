/**
 * render-doctor.ts（v1.19 渲染档设计决议 3.9 —— R4 孤儿检测 + 陈年 profile 清理）
 *
 * 孤儿定义：命令行命中**指纹对**（--run-all-compositor-stages-before-draw 且
 * --font-render-hinting=full 同时命中——单旗标可能撞他家用法）+ 台账无对应记录 +
 * etime > 10min。🔴 不以 `puppeteer_dev_chrome_profile` 判定（puppeteer 通用名，
 * chrome-devtools-mcp 等他家用，会误伤——对接说明边界 3）。
 *
 * --clean 才动手（默认 dry-run 只报告）。清理动作 = 指纹对 + `--user-data-dir` 含
 * render-chrome-profile- 前缀**双重证据**命中才树杀 + rmSync profile。这是全仓
 * **唯一**不经台账归属验证的杀路径——窄化为 R4 显式设计（孤儿定义即无台账），
 * 双证据 + 10min 年龄线 + dry-run 默认三重护栏（真身 Chrome 零误伤测试钉死）。
 * 杀原语仍单源 util/kill-tree（INV-64 修订 b 豁免沿用，与 chrome-stop 同源）。
 *
 * 陈年 profile：`~/.cache/lasso/render-chrome-profile-*` 不被任何台账记录引用且
 * age > 24h → 报告 / --clean 删除（24h 线避免与拉起窗口竞态）。
 *
 * INV-64 修订合规：只 import node:* 内置 + ../launcher/* + ../util/kill-tree.js
 * （豁免沿用）+ ./render-flags.js。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import { readLedgerSync, type LaunchedChromeRecord, type LedgerLogFn } from "../launcher/chrome-ledger.js";
import { killTreeSync } from "../util/kill-tree.js";
import {
  renderFingerprintMatch,
  RENDER_PROFILE_PREFIX,
} from "./render-flags.js";

/** 孤儿年龄线（设计决议 3.9：拉起窗口外的陈留才判孤儿）。 */
export const RENDER_ORPHAN_MIN_AGE_SEC = 600; // 10min
/** 陈年 profile 年龄线（24h——避免与拉起窗口竞态）。 */
export const RENDER_STALE_PROFILE_MS = 24 * 60 * 60 * 1000;

export interface RenderDoctorOrphan {
  pid: number;
  etimeSec: number;
  /** 命令行中的 --user-data-dir（双证据命中时才有——clean 的对象）。 */
  profileDir?: string;
  /** true = 双证据齐（指纹对 + profile 前缀），--clean 可执行。 */
  cleanable: boolean;
  command: string;
}

export interface RenderDoctorReport {
  orphans: RenderDoctorOrphan[];
  staleProfiles: Array<{ dir: string; ageHours: number }>;
  /** --clean 实际执行结果（dry-run 恒 0）。 */
  cleaned: { orphansKilled: number; profilesRemoved: number };
  clean: boolean;
}

export interface RenderDoctorOptions {
  /** 执行清理（默认 false = dry-run 只报告）。 */
  clean?: boolean;
  /** profile 基目录（默认 ~/.cache/lasso；测试隔离注入 tmp）。 */
  profileBaseDir?: string;
  /** 测试注入：全量进程表（默认 `ps -Axo pid=,etime=,command=`）。 */
  psAllFn?: () => string;
  /** 测试注入：读台账（默认 readLedgerSync）。 */
  readLedgerFn?: () => LaunchedChromeRecord[];
  /** 测试注入：时钟（默认 Date.now）。 */
  nowFn?: () => number;
  /** 测试注入：树杀原语（默认 util/kill-tree killTreeSync）。 */
  killTreeFn?: (pid: number, tag?: string) => void;
  logFn?: LedgerLogFn;
}

/**
 * etime 解析（macOS/Linux 同形：`[[dd-]hh:]mm:ss`，如 "1-03:04:05" / "03:04:05" /
 * "04:55"）→ 秒。不可解析 → 0（保守：年龄线判不过 = 不动，失效方向安全）。
 */
export function parseEtimeSeconds(etime: string): number {
  const s = etime.trim();
  if (s === "") return 0;
  let days = 0;
  let rest = s;
  const dash = s.indexOf("-");
  if (dash !== -1) {
    days = parseInt(s.slice(0, dash), 10);
    if (Number.isNaN(days)) return 0;
    rest = s.slice(dash + 1);
  }
  const parts = rest.split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p; // [ss] / [mm:ss] / [hh:mm:ss] 逐级 ×60
  return sec + days * 86_400;
}

/** 命令行中提取 --user-data-dir=<dir> 的值（无则 undefined）。 */
function extractUserDataDir(command: string): string | undefined {
  const m = command.match(/--user-data-dir=(\S+)/);
  return m?.[1];
}

/** 默认全量进程表读取（macOS/Linux 同形）。 */
function defaultPsAllFn(): string {
  try {
    return spawnSync("ps", ["-Axo", "pid=,etime=,command="], { encoding: "utf8", timeout: 3_000 }).stdout ?? "";
  } catch {
    return "";
  }
}

/**
 * 渲染档 doctor：孤儿扫描 + 陈年 profile 清单 + （--clean）执行清理。
 * 恒不 throw（报告型 CLI）；单条清理失败记日志继续。
 */
export function renderDoctor(opts: RenderDoctorOptions = {}): RenderDoctorReport {
  const clean = opts.clean === true;
  const logFn = opts.logFn ?? (() => {});
  const nowFn = opts.nowFn ?? (() => Date.now());
  const readLedgerFn = opts.readLedgerFn ?? readLedgerSync;
  const killTreeFn = opts.killTreeFn ?? ((pid: number, tag?: string) => killTreeSync(pid, tag));
  const base = opts.profileBaseDir ?? path.join(os.homedir(), ".cache", "lasso");

  // ---- 1. 孤儿扫描（指纹对 + 台账缺位 + 年龄线）----
  const ledger = readLedgerFn();
  const ledgerPids = new Set(ledger.map((r) => r.pid));
  const orphans: RenderDoctorOrphan[] = [];
  const psAll = (opts.psAllFn ?? defaultPsAllFn)();
  for (const line of psAll.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = trimmed.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1]!, 10);
    const etimeSec = parseEtimeSeconds(m[2]!);
    const command = m[3]!;
    // 三重证据第一重：指纹对（单旗标撞他家用法不命中）
    if (!renderFingerprintMatch(command)) continue;
    // 第二重：台账在案 = 不是孤儿（lasso 拥有的健康渲染档）
    if (ledgerPids.has(pid)) continue;
    // 第三重：年龄线（刚拉起未记账的竞态窗口容忍）
    if (etimeSec <= RENDER_ORPHAN_MIN_AGE_SEC) continue;
    const profileDir = extractUserDataDir(command);
    const cleanable =
      profileDir !== undefined && path.basename(profileDir).startsWith(RENDER_PROFILE_PREFIX);
    orphans.push({ pid, etimeSec, profileDir: cleanable ? profileDir : undefined, cleanable, command });
  }

  // ---- 2. 陈年 profile 扫描（不被任何台账记录引用 + age > 24h）----
  const referenced = new Set(ledger.map((r) => r.profileDir));
  const staleProfiles: Array<{ dir: string; ageHours: number }> = [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    entries = []; // 基目录不存在 → 空
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(RENDER_PROFILE_PREFIX)) continue;
    const dir = path.join(base, e.name);
    if (referenced.has(dir)) continue;
    let ageMs = 0;
    try {
      ageMs = nowFn() - statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs <= RENDER_STALE_PROFILE_MS) continue;
    staleProfiles.push({ dir, ageHours: Math.round((ageMs / 3_600_000) * 10) / 10 });
  }

  // ---- 3. --clean 执行（默认 dry-run 不动手）----
  const cleaned = { orphansKilled: 0, profilesRemoved: 0 };
  if (clean) {
    for (const o of orphans) {
      // 双证据护栏：指纹对（扫描已过）+ profile 前缀（cleanable）——单证据只报告不动手
      if (!o.cleanable || o.profileDir === undefined) continue;
      try {
        killTreeFn(o.pid, `render-doctor:${o.pid}`);
        rmSync(o.profileDir, { recursive: true, force: true });
        cleaned.orphansKilled++;
        logFn({ evt: "render_doctor_orphan_cleaned", pid: o.pid, profileDir: o.profileDir, etime_sec: o.etimeSec });
      } catch (e) {
        logFn({ evt: "render_doctor_orphan_clean_error", pid: o.pid, error: String(e) });
      }
    }
    for (const p of staleProfiles) {
      try {
        rmSync(p.dir, { recursive: true, force: true });
        cleaned.profilesRemoved++;
        logFn({ evt: "render_doctor_stale_profile_removed", dir: p.dir, age_hours: p.ageHours });
      } catch (e) {
        logFn({ evt: "render_doctor_stale_profile_remove_error", dir: p.dir, error: String(e) });
      }
    }
  }

  return { orphans, staleProfiles, cleaned, clean };
}

/** 读取 fixture/文本形状的进程表时复用的行解析（导出供测试对齐真实 ps 形状）。 */
export function parsePsLine(line: string): { pid: number; etime: string; command: string } | null {
  const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
  if (!m) return null;
  return { pid: parseInt(m[1]!, 10), etime: m[2]!, command: m[3]! };
}
