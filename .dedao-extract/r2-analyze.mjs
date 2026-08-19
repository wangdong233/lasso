#!/usr/bin/env node
// r2-analyze.mjs — 三层实证：①PGM 逐页墨迹范围（页尾空白）②pdfimages 逐图落页 ③pdftotext 词级零丢失 diff
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SCRATCH = "/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/scratch";
const tags = ["fk", "l001", "l002"];

// ---------- PGM(P5) 解析：每页最后一行含墨迹的行号 → 页尾空白 ----------
function pgmInk(file) {
  const buf = fs.readFileSync(file);
  // header: P5\n[#comment]\n<w> <h>\n<max>\n<binary>
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
  const w = +readToken(), h = +readToken(), maxv = +readToken();
  p++; // single whitespace after max
  const data = buf.subarray(p, p + w * h);
  const inkRow = new Int32Array(h).fill(-1);
  let firstInk = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] < 242) { if (firstInk < 0) firstInk = y; inkRow[y] = x; break; }
    }
  }
  let lastInk = -1;
  for (let y = h - 1; y >= 0; y--) { if (inkRow[y] >= 0) { lastInk = y; break; } }
  return { w, h, firstInk, lastInk, tailBlankPx: h - 1 - lastInk, tailBlankPct: +(((h - 1 - lastInk) / h) * 100).toFixed(1) };
}

// ---------- 归一化 + 词级 diff ----------
const norm = (s) => s.replace(/[\s 　]/g, "").replace(/­/g, "");
function zeroLoss(domTxt, pdfTxt) {
  const A = norm(domTxt), B = norm(pdfTxt);
  // 多重集双向 diff
  const cnt = new Map();
  for (const ch of A) cnt.set(ch, (cnt.get(ch) || 0) + 1);
  for (const ch of B) cnt.set(ch, (cnt.get(ch) || 0) - 1);
  const domMissing = [], pdfExtra = [];
  for (const [ch, n] of cnt) { if (n > 0) domMissing.push([ch, n]); else if (n < 0) pdfExtra.push([ch, -n]); }
  // 顺序包含：DOM 字符流必须是 PDF 字符流的子序列（保序）
  let j = 0, firstBreak = -1;
  for (let i = 0; i < A.length; i++) {
    const ch = A[i];
    let found = false;
    while (j < B.length) { if (B[j] === ch) { found = true; j++; break; } j++; }
    if (!found) { firstBreak = i; break; }
  }
  return {
    domChars: A.length, pdfChars: B.length,
    domMissingInPdf: domMissing.slice(0, 30), pdfExtraNotInDom: pdfExtra.slice(0, 30),
    inOrder: firstBreak === -1, firstBreakAt: firstBreak,
    firstBreakCtx: firstBreak >= 0 ? A.slice(Math.max(0, firstBreak - 12), firstBreak + 12) : null,
  };
}

for (const tag of tags) {
  const pdf = path.join(SCRATCH, `${tag}-before.pdf`);
  console.log(`\n========== ${tag} ==========`);
  // 1) render
  execSync(`pdftoppm -gray -r 40 ${JSON.stringify(pdf)} ${path.join(SCRATCH, tag)}`, { stdio: "ignore" });
  const pages = fs.readdirSync(SCRATCH).filter((f) => f.startsWith(`${tag}-`) && f.endsWith(".pgm")).sort((a, b) => {
    const n = (s) => +s.match(/-(\d+)\.pgm$/)[1];
    return n(a) - n(b);
  });
  console.log("page | lastInkRow/height | tailBlank(px@40dpi) | tailBlank(%)");
  pages.forEach((f, i) => {
    const r = pgmInk(path.join(SCRATCH, f));
    const flag = r.tailBlankPct > 25 ? "  <== 大空白页尾" : "";
    console.log(`${String(i + 1).padStart(4)} | ${r.lastInk}/${r.h} | ${r.tailBlankPx} | ${r.tailBlankPct}${flag}`);
  });
  // 2) images per page
  const il = execSync(`pdfimages -list ${JSON.stringify(pdf)}`, { encoding: "utf8" });
  const imgRows = il.split("\n").filter((l) =>/^\s+\d+\s+\d+\s+image/.test(l));
  const perPage = {};
  for (const row of imgRows) {
    const m = row.trim().split(/\s+/);
    const pg = +m[0], w = +m[3], hh = +m[4];
    (perPage[pg] = perPage[pg] || []).push(`${w}x${hh}`);
  }
  console.log("images-on-page:", JSON.stringify(perPage));
  // 3) zero-loss
  execSync(`pdftotext ${JSON.stringify(pdf)} ${JSON.stringify(path.join(SCRATCH, `${tag}-pdftotext.txt`))}`);
  const dom = fs.readFileSync(path.join(SCRATCH, `${tag}-dom-inner.txt`), "utf8");
  const pdft = fs.readFileSync(path.join(SCRATCH, `${tag}-pdftotext.txt`), "utf8");
  console.log("zeroLoss:", JSON.stringify(zeroLoss(dom, pdft)));
  fs.writeFileSync(path.join(SCRATCH, `${tag}-analysis.json`), JSON.stringify({ pages: pages.length, perPage }, null, 2));
}
