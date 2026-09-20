/**
 * aria2.ts（doc/bugs/12 D9 引擎栈 HTTP+BT / D14 机读进度 / D16 BT 直连形态）
 *
 * 定位（§二 BT 定谳）：aria2 BT **非主力**——「诊断即功能」降格。v1 直连
 * 形态：DHT bootstrap IP 直写（本机实测 router.bittorrent.com 被 DNS 污染到
 * Meta 段 157.240.17.36，印证 §二「IP 直写才是解」）+ bundled 冻结 tracker
 * 表（不做列表维护跑步机，Rejected-by-design）。
 *
 * argv 归属标记 = staging 路径（`--dir <root>/staging/<taskId>`，见
 * staging.ts 头注；aria2 拒未知长参数——本机 1.37.0 实测定罪）。
 */
import type { EngineProgressSnapshot, EngineSpawnSpec } from "../types.js";
import { parseByteSize, parseEtaToSec, parseSpeedBps } from "./units.js";
import { acquireStagingDir, stdioFileForTask } from "./staging.js";
import { stripProxyEnv } from "./proxy.js";

// ============================================================
// BT 冻结常量（D16；快照 2026-09-20，禁运行时刷新——维护跑步机 Rejected）
// ============================================================

/**
 * DHT bootstrap（IP 直写解 DNS 污染）。快照来源与置信注：
 *  - 212.129.33.59 = dht.transmissionbt.com 本机解析命中（Online.net 段，
 *    transmission 官方 bootstrap 长期公开记载 IP）；
 *  - 82.221.103.244 = router.bittorrent.com 历史公开记载 IP（本机该域名已被
 *    污染至 Meta 段无法对照验证——按决议「不可验证只注明」收录，非实证值）。
 * aria2 接受重复 --dht-entry-point（1.37.0 实测）。
 */
export const BT_DHT_BOOTSTRAP_ENTRIES: readonly string[] = Object.freeze([
  "212.129.33.59:6881",
  "82.221.103.244:6881",
]);

/** bundled tracker 表（ngosang/trackerslist best 精选 ≤15 条冻结快照）。 */
export const BT_TRACKERS: readonly string[] = Object.freeze([
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://tracker.leechiens.com:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://opentracker.io:6969/announce",
  "http://tracker.opentrackr.org:1337/announce",
]);

// ============================================================
// argv 构建
// ============================================================

export interface Aria2EngineOptions {
  taskId: string;
  /** http(s) URL / magnet: / .torrent 绝对路径。 */
  source: string;
  /** http=多线程直下；torrent=magnet/.torrent。 */
  kind: "http" | "torrent";
  /** 最终目录（白名单内 realpath 后；产物完成后从 staging rename 过来）。 */
  outDir: string;
  /** 仅 http 形态有效（aria2 禁 --out 于 BT 下载）；BT 引擎自命名。 */
  filename: string | null;
  /** 1-16。 */
  maxConn: number;
  /** resolveProxy 产物（null=直连，且子进程剥 proxy env）。 */
  proxy: string | null;
  /** 测试隔离注入（staging root 覆盖）。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * HTTP 形态 argv（决议模板逐字锚）：
 * `-x/-s` 分片并发、`-k 1M` 分片、`--file-allocation=none` 免预分配（staging
 * 同盘 rename 语义成立的前提）、`--summary-interval=5` 机读进度源、
 * `--download-result=hide --console-log-level=warn` 噪声压制、`-c` 断点续传
 * （.aria2 控制文件在 staging 内）、`--auto-file-renaming=false
 * --allow-overwrite=true` 产物文件名确定性（release 语义前提）。
 */
export function buildAria2Args(opts: Aria2EngineOptions): string[] {
  const conn = String(Math.max(1, Math.min(16, opts.maxConn)));
  const args: string[] = [
    "-x",
    conn,
    "-s",
    conn,
    "-k",
    "1M",
    "--file-allocation=none",
    "--summary-interval=5",
    "--download-result=hide",
    "--console-log-level=warn",
    "-c",
    "--auto-file-renaming=false",
    "--allow-overwrite=true",
  ];
  if (opts.kind === "torrent") {
    // BT 形态（D16）：DHT IP 直写 + bundled tracker + 完成即停（不保种）。
    args.push("--enable-dht=true");
    for (const entry of BT_DHT_BOOTSTRAP_ENTRIES) {
      args.push("--dht-entry-point", entry);
    }
    args.push("--bt-tracker", BT_TRACKERS.join(","), "--seed-time", "0");
  }
  if (opts.proxy) {
    args.push("--all-proxy", opts.proxy);
  }
  return args;
}

export interface Aria2SpawnPlan {
  command: string;
  spec: EngineSpawnSpec;
  stagingDir: string;
}

/**
 * 组装完整 spawn 计划（argv 末位才贴 source；`--dir` 指 staging=归属标记；
 * env 双保险 LASSO_DOWNLOAD_TASK；proxy=null 剥 proxy env 防 aria2 env 拾取）。
 * aria2c 命令解析在 start.ts（detect→降级判定属 spawn 时逻辑）。
 */
export function planAria2Spawn(
  opts: Aria2EngineOptions,
  aria2Path: string,
): Aria2SpawnPlan {
  const env = opts.env ?? process.env;
  const stagingDir = acquireStagingDir(opts.taskId, env);
  const stdioFile = stdioFileForTask(opts.taskId, env);
  const args = buildAria2Args(opts);
  args.push("--dir", stagingDir);
  if (opts.kind === "http" && opts.filename) {
    args.push("--out", opts.filename);
  }
  args.push(opts.source);
  const baseEnv = opts.proxy ? { ...env } : stripProxyEnv(env);
  const spec: EngineSpawnSpec = {
    engine: "aria2c",
    args,
    env: { ...baseEnv, LASSO_DOWNLOAD_TASK: opts.taskId },
    stdioFile,
    cwd: stagingDir,
  };
  return { command: aria2Path, spec, stagingDir };
}

// ============================================================
// D14 机读进度解析（summary 行；真实样本 2026-09-20 本机 aria2 1.37.0 捕获）
// ============================================================

/**
 * 单行 summary 解析。真实格式（本机捕获，cat -v 无 ANSI）：
 *  - 已知大小：`[#128c91 31MiB/38MiB(81%) CN:4 DL:31MiB]`（快下载无 ETA 段）
 *  - 已知大小+ETA：`[#gid 45MiB/120MiB(37%) CN:8 DL:2.5MiB ETA:30s]`
 *  - 未知大小（chunked）：`[#979bb8 1.1MiB/0B CN:1 DL:1.0MiB]`——总量 0B、
 *    无百分比段；总量未知 → totalBytes=null / progress=null
 *  - SEED 态：`[#gid SEED 128MiB(98%) ...]`
 */
export interface Aria2SummaryFields {
  downloadedBytes: number | null;
  totalBytes: number | null;
  progress: number | null;
  speedBps: number | null;
  etaSec: number | null;
  /** CN: 活动连接数（BT 零 peer 双因诊断的 60s 窗观测源，§二）。 */
  connections: number | null;
  seeding: boolean;
}

const ARIA2_SUMMARY_RE =
  /^\[#[^\s]+\s+(?:(SEED)\s+)?([\d.]+[KMGT]?i?B)(?:\/([\d.]+[KMGT]?i?B))?(?:\((\d+)%\))?(?:\s+CN:(\d+))?(?:\s+DL:([\d.]+[KMGT]?i?B|Unknown))?(?:\s+ETA:([\dhms]+|unknown))?/;

/** 解析单行；非 summary 行（FILE:/页眉页脚/错误行）返 null。 */
export function parseAria2SummaryLine(line: string): Aria2SummaryFields | null {
  const m = ARIA2_SUMMARY_RE.exec(line.trim());
  if (!m) return null;
  const downloaded = parseByteSize(m[2]);
  const rawTotal = m[3] === undefined ? null : parseByteSize(m[3]);
  // 未知总量形态=「0B」占位（本机 chunked 实测）；SEED 单尺寸形态无 /total
  const total = rawTotal && rawTotal > 0 ? rawTotal : null;
  const pct = m[4] ? Number(m[4]) / 100 : null;
  const progress =
    pct !== null
      ? pct
      : downloaded !== null && total !== null && total > 0
        ? downloaded / total
        : null;
  return {
    downloadedBytes: downloaded,
    totalBytes: total,
    progress,
    speedBps: m[6] ? parseSpeedBps(m[6]) : null,
    etaSec: m[7] ? parseEtaToSec(m[7]) : null,
    connections: m[5] ? Number(m[5]) : null,
    seeding: m[1] === "SEED",
  };
}

/**
 * 进度日志全文 → 最近快照（tail 语义：最后一个 summary 行胜出）。
 * exitCode 恒 null——退出态由 pid 轮询层（tools/status reconcile）判定，
 * 进度日志不承载退出信号（契约字段注释同义）。
 */
export function parseAria2Progress(logText: string): EngineProgressSnapshot {
  let last: Aria2SummaryFields | null = null;
  for (const line of logText.split("\n")) {
    const f = parseAria2SummaryLine(line);
    if (f) last = f;
  }
  if (!last) {
    return {
      progress: null,
      speedBps: null,
      etaSec: null,
      downloadedBytes: null,
      totalBytes: null,
      exitCode: null,
    };
  }
  return {
    progress: last.progress,
    speedBps: last.speedBps,
    etaSec: last.etaSec,
    downloadedBytes: last.downloadedBytes,
    totalBytes: last.totalBytes,
    exitCode: null,
  };
}

/** BT 零 peer 诊断观测（§二双因报因：CN 与 DL 都为零才计一个观测点）。 */
export function isAria2ZeroPeerSnapshot(f: Aria2SummaryFields | null): boolean {
  return !!f && (f.connections === 0 || f.connections === null) && f.speedBps === 0;
}
