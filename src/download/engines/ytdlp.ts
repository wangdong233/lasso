/**
 * ytdlp.ts（doc/bugs/12 D9 流媒体引擎 / D10 lazy 引导 / D14 机读进度 / D15 字幕 json3）
 *
 * 机读协议：`--newline --progress-template "download:<id>|<percent>|<bytes>|
 * <total>|<speed>|<eta>"`——`|` 分隔 6 字段，行首 `download:` 锚。模板串是
 * builder 与 parser 的**共享常量**（改模板必同改 parser，fixture 假引擎锁协议）。
 *
 * 字幕（D15）：源格式 json3（词级干净真源——luceo §2.3 定罪 auto-caption
 * vtt 滚动重复 2.6×）；`--convert-subs srt` 产 .srt；若 convert 失败遗留
 * .json3，finalizeSubtitles 用本文件 json3ToSrt 兜底（滚动去重规则）。
 *
 * argv 归属标记 = staging 路径（`--paths <root>/staging/<taskId>`；yt-dlp
 * 同样拒未知长参数）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { EngineProgressSnapshot, EngineSpawnSpec } from "../types.js";
import { parseEtaToSec, parseSpeedBps, formatSrtTimestamp } from "./units.js";
import { acquireStagingDir, stdioFileForTask } from "./staging.js";
import { stripProxyEnv } from "./proxy.js";
import { ytDlpBinDir } from "./bin-dir.js";

// ============================================================
// 路径解析（检测序①env ②bin 缓存 ③PATH；引导=bootstrap.ts）
// ============================================================

/** ①`LASSO_YTDLP_PATH` ②`<binDir>/yt-dlp_macos`（存在+可执行）③PATH yt-dlp。 */
export function resolveYtDlpPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = (env.LASSO_YTDLP_PATH ?? "").trim();
  if (explicit) return explicit;
  const cached = path.join(ytDlpBinDir(env), "yt-dlp_macos");
  try {
    fs.accessSync(cached, fs.constants.X_OK);
    return cached;
  } catch {
    // 落到 PATH
  }
  // PATH 扫描（避免引 spawn.ts 依赖环——内联同型三态门）
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, "yt-dlp");
    try {
      const st = fs.statSync(p);
      if (st.isFile()) {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      }
    } catch {
      // 继续
    }
  }
  return null;
}

// ============================================================
// argv 构建
// ============================================================

/** 机读进度模板（builder/parser/fixture 三方锚定的单一真源，D14）。 */
export const YTDLP_PROGRESS_TEMPLATE =
  "download:%(info.id)s|%(progress._percent_str)s|%(progress._downloaded_bytes)s|%(progress._total_bytes)s|%(progress._speed_str)s|%(progress._eta_str)s";

export interface YtDlpEngineOptions {
  taskId: string;
  source: string;
  outDir: string;
  /** null=引擎自命名（`%(title)s.%(ext)s`）。 */
  filename: string | null;
  subs: boolean;
  audioOnly: boolean;
  proxy: string | null;
  /** 字幕语言（默认 zh,en）。 */
  subLangs?: string;
  env?: NodeJS.ProcessEnv;
}

export function buildYtDlpArgs(opts: YtDlpEngineOptions): string[] {
  const args: string[] = [
    "--newline",
    "--no-playlist",
    "--js-runtimes",
    "node",
    "--progress-template",
    YTDLP_PROGRESS_TEMPLATE,
  ];
  if (opts.audioOnly) {
    args.push("-f", "bestaudio", "-x");
  }
  if (opts.subs) {
    args.push(
      "--write-auto-subs",
      "--sub-format",
      "json3",
      "--convert-subs",
      "srt",
      "--sub-langs",
      opts.subLangs ?? "zh,en",
    );
  }
  if (opts.proxy) {
    args.push("--proxy", opts.proxy);
  }
  return args;
}

export interface YtDlpSpawnPlan {
  command: string;
  spec: EngineSpawnSpec;
  stagingDir: string;
}

/** 组装 spawn 计划（--paths 指 staging=归属标记；-o 相对 staging）。 */
export function planYtDlpSpawn(
  opts: YtDlpEngineOptions,
  ytdlpPath: string,
): YtDlpSpawnPlan {
  const env = opts.env ?? process.env;
  const stagingDir = acquireStagingDir(opts.taskId, env);
  const stdioFile = stdioFileForTask(opts.taskId, env);
  const args = buildYtDlpArgs(opts);
  args.push("--paths", stagingDir);
  args.push("-o", opts.filename ?? "%(title)s.%(ext)s");
  args.push(opts.source);
  const baseEnv = opts.proxy ? { ...env } : stripProxyEnv(env);
  const spec: EngineSpawnSpec = {
    engine: "yt-dlp",
    args,
    env: { ...baseEnv, LASSO_DOWNLOAD_TASK: opts.taskId },
    stdioFile,
    cwd: stagingDir,
  };
  return { command: ytdlpPath, spec, stagingDir };
}

// ============================================================
// D14 机读进度解析
// ============================================================

/**
 * progress 日志 → 最近快照（tail 语义）。行样例（真实 yt-dlp 形态）：
 * `download:dQw4w9WgXcQ|  5.0%|  18253611|   365211840|    1.20MiB/s|    05:03`
 * 容错：`Unknown %`/`NA`（未知总量）→ null 字段；缺列（旧模板）不炸。
 */
export function parseYtDlpProgress(logText: string): EngineProgressSnapshot {
  let last: string[] | null = null;
  for (const line of logText.split("\n")) {
    const t = line.trim();
    if (t.startsWith("download:")) {
      last = t.slice("download:".length).split("|");
    }
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
  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const t = v.trim().replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const [, percentRaw, downloadedRaw, totalRaw, speedRaw, etaRaw] = last;
  const percent =
    percentRaw !== undefined && /\d/.test(percentRaw)
      ? num(percentRaw.replace("%", ""))
      : null;
  const downloaded = num(downloadedRaw);
  const total = num(totalRaw);
  const progress =
    percent !== null
      ? percent / 100
      : downloaded !== null && total !== null && total > 0
        ? downloaded / total
        : null;
  return {
    progress: progress !== null ? Math.min(1, progress) : null,
    speedBps: speedRaw ? parseSpeedBps(speedRaw) : null,
    etaSec: etaRaw ? parseEtaToSec(etaRaw) : null,
    downloadedBytes: downloaded,
    totalBytes: total,
    exitCode: null,
  };
}

// ============================================================
// 退出码语义（引擎调研定谳）
// ============================================================

export interface YtDlpExitVerdict {
  state: "completed" | "failed" | "cancelled";
  diagnosis: string | null;
}

/**
 * 退出码映射：0=completed；2=参数错误（我方 argv 组装 bug）；101=cancelled；
 * 其余（含 ≥1000）=failed。exitCode=null=被信号杀死。日志尾含 extractor
 * 失效特征词 → diagnosis 提示引擎过期重引导（D10 闭环面）。
 */
export function interpretYtDlpExit(
  exitCode: number | null,
  logTail = "",
): YtDlpExitVerdict {
  if (exitCode === 0) return { state: "completed", diagnosis: null };
  if (exitCode === 2) {
    return {
      state: "failed",
      diagnosis: "yt-dlp 参数错误（exit 2）——argv 组装 bug，请上报 lasso",
    };
  }
  if (exitCode === 101) return { state: "cancelled", diagnosis: null };
  if (exitCode === null) {
    return { state: "failed", diagnosis: "引擎进程被信号杀死（exitCode=null）" };
  }
  if (/unable to extract|failed to extract|no video formats/i.test(logTail)) {
    return {
      state: "failed",
      diagnosis:
        "yt-dlp extractor 失效特征（unable to extract）——引擎过期，建议 bootstrapYtDlp 重拉 latest",
    };
  }
  return { state: "failed", diagnosis: null };
}

// ============================================================
// D15 json3 → srt 极简转换器（纯函数 + 落盘兜底）
// ============================================================

interface Json3Seg {
  utf8?: string;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}
export interface Json3Doc {
  events?: Json3Event[];
}

/**
 * 词级滚动去重：若 cur 的词前缀与 prev 的词后缀重合（滚动字幕把上一行
 * 尾巴重复到下一行开头），剥掉 cur 的重叠前缀（取最长重合）。
 */
export function stripRollingOverlap(prev: string, cur: string): string {
  const pw = prev.split(/\s+/).filter(Boolean);
  const cw = cur.split(/\s+/).filter(Boolean);
  if (pw.length === 0 || cw.length === 0) return cur;
  const max = Math.min(pw.length, cw.length);
  for (let n = max; n > 0; n--) {
    const tail = pw.slice(pw.length - n).join(" ");
    const head = cw.slice(0, n).join(" ");
    if (tail === head) {
      return cw.slice(n).join(" ");
    }
  }
  return cur;
}

/**
 * json3 → SRT 文本（D15 兜底；规则参考 luceo scripts/media/json3_to_srt.py）：
 *  1. events 展开（segs.utf8 拼接、换行平化）；
 *  2. 相邻事件滚动去重（stripRollingOverlap——同族词级尾部剥除）；
 *  3. 句级聚合（ terminator .?! 断句；聚合上限 6s 防长句漂移；
 *     时长=首末事件窗，缺 dDurationMs 兜 2000ms）。
 */
export function json3ToSrt(doc: unknown): string {
  const events = (doc as Json3Doc)?.events ?? [];
  type Cue = { start: number; end: number; text: string };
  const cues: Cue[] = [];
  let prevText = "";
  for (const e of events) {
    if (!e?.segs) continue;
    const raw = e.segs.map((s) => s?.utf8 ?? "").join("");
    let text = raw.replace(/\n/g, " ").trim();
    if (!text) continue;
    text = stripRollingOverlap(prevText, text);
    prevText = raw.replace(/\n/g, " ").trim();
    if (!text) continue;
    const start = e.tStartMs ?? 0;
    const dur = e.dDurationMs ?? 2000;
    const last = cues[cues.length - 1];
    const endsWithTerminator = last
      ? /[.?!]$/.test(last.text.replace(/\s+$/, ""))
      : true;
    if (
      last &&
      !endsWithTerminator &&
      start - last.start < 6000
    ) {
      last.text = `${last.text} ${text}`.trim();
      last.end = start + dur;
    } else {
      cues.push({ start, end: start + dur, text });
    }
  }
  const blocks: string[] = [];
  cues.forEach((c, i) => {
    blocks.push(
      `${i + 1}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${c.text}\n`,
    );
  });
  return blocks.join("\n");
}

/**
 * 落盘兜底：扫目录（含一级子目录——yt-dlp --paths 布局）下遗留 .json3 →
 * 同名 .srt。单个文件解析失败 warn+跳过（绝不整目录失效）。返回产出
 * .srt 绝对路径清单（任务表 subsFile 候选真源）。
 */
export function finalizeSubtitles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !/\.json3$/i.test(ent.name)) continue;
    const src = path.join(dir, ent.name);
    try {
      const doc = JSON.parse(fs.readFileSync(src, "utf8"));
      const srt = json3ToSrt(doc);
      const dest = src.replace(/\.json3$/i, ".srt");
      fs.writeFileSync(dest, srt, "utf8");
      out.push(dest);
    } catch {
      // 单文件损坏不阻塞其余字幕
    }
  }
  return out;
}
