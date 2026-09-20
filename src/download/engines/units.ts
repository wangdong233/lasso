/**
 * units.ts（doc/bugs/12 D14 机读进度——字节/时长解析共享原语）
 *
 * aria2 summary（`31MiB/38MiB`、`DL:2.5MiB`、`ETA:1m30s`）与 yt-dlp
 * progress-template（`1.20MiB/s`、`00:30`）两套人类可读单位在此收口为
 * 单一解析面——两引擎共用同一容错语义（解析失败返 null，绝不 NaN 下渗
 * 任务表）。R-INT-01：纯函数，同输入同输出。
 */

/** aria2/yt-dlp 尺寸串 → 字节数。`0B`→0；`31MiB`→32505856；非法/`Unknown`→null。 */
export function parseByteSize(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult: Record<string, number> = {
    B: 1,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  };
  return Math.round(n * mult[m[2]]);
}

/** 速度串 → B/s。`2.5MiB/s`→2621440；`Unknown`/`NA`/`Unknown B/s`→null。 */
export function parseSpeedBps(s: string): number | null {
  const t = s.trim().replace(/\/s$/i, "").trim();
  if (t === "Unknown" || t === "NA" || t === "" || t === "0B") {
    // 0B/s 是真实零速（BT 零 peer 诊断信号）——保留 0 而非 null。
    return t === "0B" ? 0 : null;
  }
  return parseByteSize(t);
}

/**
 * ETA 串 → 秒。两族形态：
 *  - aria2 段式：`30s` / `1m30s` / `1h2m3s` / `unknown`→null
 *  - yt-dlp 时钟式：`00:30`→30 / `01:00:30`→3630 / `Unknown`→null
 */
export function parseEtaToSec(s: string): number | null {
  const t = s.trim();
  if (t === "" || /^unknown$/i.test(t) || t === "--:--:--" || t === "NA") {
    return null;
  }
  // 时钟式 hh:mm:ss / mm:ss（yt-dlp）
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  if (clock) {
    const h = clock[1] ? Number(clock[1]) : 0;
    return h * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  }
  // 段式 h/m/s（aria2）
  const seg = /^((\d+)h)?((\d+)m)?((\d+)s)?$/.exec(t);
  if (seg && (seg[2] || seg[4] || seg[6])) {
    const h = seg[2] ? Number(seg[2]) : 0;
    const m = seg[4] ? Number(seg[4]) : 0;
    const s = seg[6] ? Number(seg[6]) : 0;
    return h * 3600 + m * 60 + s;
  }
  const plain = /^\d+$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(plain) ? plain : null;
}

/** 毫秒 → SRT 时间戳 `HH:MM:SS,mmm`。 */
export function formatSrtTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}
