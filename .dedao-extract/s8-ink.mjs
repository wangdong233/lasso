#!/usr/bin/env node
// s8-ink.mjs — 对 5 个 PDF 变体做逐页墨迹尾空白分析（复用 r2-analyze 的 pgmInk）
import * as fs from "node:fs";
import * as path from "node:path";
const S = "/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/scratch";
const variants = process.argv.slice(2).length ? process.argv.slice(2) : ["fk-r3-base", "fk-r3-s09", "fk-r3-fix", "l003-r3-base", "l003-r3-fix"];

function pgmInk(file) {
  const buf = fs.readFileSync(file);
  let p = 0;
  const readToken = () => {
    while (p < buf.length && (buf[p] === 0x20 || buf[p] === 0x0a || buf[p] === 0x0d || buf[p] === 0x09)) p++;
    if (buf[p] === 0x23) { while (p < buf.length && buf[p] !== 0x0a) p++; return readToken(); }
    const s = p;
    while (p < buf.length && !(buf[p] === 0x20 || buf[p] === 0x0a || buf[p] === 0x0d || buf[p] === 0x09)) p++;
    return buf.toString("latin1", s, p);
  };
  const magic = readToken();
  if (magic !== "P5") throw new Error(`not P5: ${magic}`);
  const w = +readToken(), h = +readToken(); readToken(); p++;
  const data = buf.subarray(p, p + w * h);
  let lastInk = -1, firstInk = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] < 242) { if (firstInk < 0) firstInk = y; break; }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    let ink = false;
    for (let x = 0; x < w; x++) if (data[y * w + x] < 242) { ink = true; break; }
    if (ink) { lastInk = y; break; }
  }
  return { h, firstInk, lastInk, tailBlankPct: +(((h - 1 - lastInk) / h) * 100).toFixed(1) };
}

const report = {};
for (const v of variants) {
  const re = new RegExp(`^(pp-)?${v.replace(/[-]/g, "[-]")}-\\d+\\.pgm$`);
  const files = fs.readdirSync(S).filter((f) => re.test(f)).sort((a, b) => +a.match(/-(\d+)\.pgm$/)[1] - +b.match(/-(\d+)\.pgm$/)[1]);
  if (!files.length) { console.log(`${v}: NO PGM (skip)`); continue; }
  const rows = files.map((f, i) => {
    const r = pgmInk(path.join(S, f));
    return { pg: i + 1, ...r, hole: r.tailBlankPct > 25 && i < files.length - 1 ? "MID-HOLE" : (r.tailBlankPct > 25 ? "tail(last-page)" : "") };
  });
  report[v] = { pages: files.length, midHoles: rows.filter((r) => r.hole === "MID-HOLE").map((r) => `p${r.pg}:${r.tailBlankPct}%`), rows };
  console.log(`\n== ${v} (${files.length}p) midHoles=${JSON.stringify(report[v].midHoles)}`);
  rows.forEach((r) => console.log(`  p${String(r.pg).padStart(2)} lastInk=${r.lastInk}/${r.h} tailBlank=${r.tailBlankPct}% ${r.hole}`));
}
fs.writeFileSync(path.join(S, "s8-ink-report.json"), JSON.stringify(report, null, 2));
