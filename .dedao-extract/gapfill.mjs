#!/usr/bin/env node
// gapfill.mjs — 「大空缺 + 下方有图 → 缩小补入；不行则删图；文字绝不丢」共享规则模块（P23）
//
// 用户裁决（2026-08-19）原文语义：
//   空缺足够大（≥ 页内容高 ~35-40%）且下方（次页顶）有图片 → 尝试等比缩小放入（下限防过小，≥200px 高）；
//   放不下或缩后仍溢出 → 删除该图（记日志：哪章哪图为何删）；文字块永不动。
//
// 单一规则权威：终局合并渲染器（render-merge-b.mjs）与单章 produce 管线（engine.mjs）
// 同源引用本模块，禁两套漂移。两级阈值：
//   big 档（freePct ≥ 35）：缩图下限 200px；缩不进 → 删图（用户规则本体）。
//   cosmetic 档（12% ≤ freePct < 35%）：缩图下限 120px（engine v2 传承灵敏度），永不删图——
//     小空缺不值得动图，避免对 419 章全量引入无谓删除。
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pdfImages, holeReport, CONTENT_H_PT } from "./analyze.mjs";

export const RULES = {
  GAP_BIG_PCT: 35,        // 「空缺足够大」阈值（用户裁决 ~35-40% 取下限）
  GAP_ASSERT_PCT: 40,     // 复验断言阈值：≥40% 空缺且次页顶有图未处理 = FAIL
  GAP_COSMETIC_PCT: 12,   // 小空缺美化缩图档检测门（与 holeReport tailPct 默认一致）
  IMG_MIN_CSS: 200,       // big 档缩图下限（css px，防过小）
  IMG_MIN_COSMETIC_CSS: 120, // cosmetic 档缩图下限（engine v2 传承）
  FIG_VMARGIN_CSS: 38,    // figure 上下 margin 2×1.35em@10.5pt≈14px 行距字
  SAFETY_CSS: 10,         // 行内图基线隙/碎片化舍入安全垫
};

// ---- 核心裁决（纯函数，两管线共用） ----
// 输入：freePt=该页版面自由空间(pt, holeReport freePt)；freePct=同上百分比；
//       printHCss=候选图当前打印显示高(css px)；natDisplayCss=等宽自然显示高（上限，不放大）。
// 输出：{action: 'shrink'|'delete'|'leave', maxCss, availCss, tier, reason}
export function decideGapFill({ freePt, freePct, printHCss, natDisplayCss = Infinity }) {
  const freeCss = (freePt * 96) / 72;
  const availCss = freeCss - RULES.FIG_VMARGIN_CSS - RULES.SAFETY_CSS;
  const big = freePct >= RULES.GAP_BIG_PCT;
  const floor = big ? RULES.IMG_MIN_CSS : RULES.IMG_MIN_COSMETIC_CSS;
  const tier = big ? "big" : "cosmetic";
  if (printHCss <= availCss) return { action: "leave", reason: "fits", availCss: Math.round(availCss), tier };
  if (availCss >= floor) {
    const maxCss = Math.max(1, Math.floor(Math.min(availCss, natDisplayCss)));
    if (printHCss <= maxCss) return { action: "leave", reason: "nat-capped-fits", availCss: Math.round(availCss), tier };
    return { action: "shrink", maxCss, availCss: Math.round(availCss), tier };
  }
  if (big) return { action: "delete", reason: `avail(${Math.round(availCss)}css)<floor(${floor}css)`, availCss: Math.round(availCss), tier };
  return { action: "leave", reason: `cosmetic-below-floor(${Math.round(availCss)}<${floor})`, availCss: Math.round(availCss), tier };
}

// ---- DOM 图元 ↔ PDF 图像对齐（engine alignFigures 泛化；文档序 + 自然尺寸匹配） ----
// figs: [{key, natW, natH, ...}]（文档序）；返回追加 actualPage + printHCss(=h/yppi*96)。
export function matchFigsToPdf(figs, pdf) {
  const rows = pdfImages(pdf).filter((r) => r.type === "image").sort((a, b) => a.page - b.page);
  const out = figs.map((f) => ({ ...f, actualPage: null, printHCss: null }));
  const match = (f, r) => f.natW === r.w && f.natH === r.h;
  let di = 0;
  for (const r of rows) {
    if (di < out.length && match(out[di], r)) {
      out[di].actualPage = r.page; out[di].printHCss = Math.round((r.h / r.yppi) * 96); di++; continue;
    }
    const k = out.findIndex((f, j) => j >= di && match(f, r));
    if (k === -1) continue;
    di = k;
    out[di].actualPage = r.page; out[di].printHCss = Math.round((r.h / r.yppi) * 96); di++;
  }
  return out;
}

// ---- 空缺补图计划（每页扫描：空缺达标 ∧ 次页非章首 ∧ 次页文档序第一图为候选） ----
// per = holeReport(pdf).per；figsAligned = matchFigsToPdf(...)（key 必填，建议带 src/chapter）；
// chapterStartPages = 各章起始页（次页为章首的空缺是刻意的章尾留白，不动）。
// alreadyShrunk: Map<key, maxCss>（上一轮已缩仍候选 → 缩后仍溢出 → 按 big 规则删）。
export function planGapFill({ per, figsAligned, chapterStartPages = [], totalPages, alreadyShrunk = new Map(), deletedKeys = new Set() }) {
  const starts = new Set(chapterStartPages);
  const plan = { shrink: [], delete: [], skip: [] };
  for (let i = 0; i < per.length; i++) {
    const p = per[i];
    if (p.isLast || totalPages && p.page >= totalPages) continue;
    if (starts.has(p.page + 1)) { if (p.freePct >= RULES.GAP_COSMETIC_PCT) plan.skip.push({ page: p.page, freePct: p.freePct, why: "next-is-chapter-start" }); continue; }
    if (p.freePct < RULES.GAP_COSMETIC_PCT) continue;
    const onPage = figsAligned.filter((f) => f.actualPage === p.page + 1 && !deletedKeys.has(f.key));
    if (!onPage.length) { plan.skip.push({ page: p.page, freePct: p.freePct, why: "no-fig-on-next-page" }); continue; }
    const fig = onPage.reduce((a, b) => (a.key <= b.key ? a : b)); // 文档序第一图
    if (typeof fig.key !== "number") { plan.skip.push({ page: p.page, freePct: p.freePct, why: "inline-fig-not-addressable" }); continue; } // 行内图属文字流，不可独立操作（规则红线旁路）
    const d = decideGapFill({ freePt: p.freePt, freePct: p.freePct, printHCss: fig.printHCss ?? Infinity, natDisplayCss: fig.natDisplayCss ?? Infinity });
    const prev = alreadyShrunk.get(fig.key);
    if (d.action === "shrink" && prev !== undefined) {
      // 上轮已缩到 prev 仍被推到次页顶（如标题 break-after:avoid 随行占位）→ 缩后仍溢出 → 删（big 规则）
      if (p.freePct >= RULES.GAP_BIG_PCT) {
        plan.delete.push({ page: p.page, freePct: p.freePct, freePt: p.freePt, fig, reason: `still-overflow-after-shrink(${prev}css)`, prevMax: prev });
        continue;
      }
      const maxCss = Math.max(RULES.IMG_MIN_COSMETIC_CSS, Math.floor(d.availCss - RULES.SAFETY_CSS));
      if (maxCss < prev) plan.shrink.push({ page: p.page, freePct: p.freePct, freePt: p.freePt, fig, maxCss, tier: "cosmetic-retry", reason: `retry-shrink-${prev}->${maxCss}` });
      else plan.skip.push({ page: p.page, freePct: p.freePct, why: `shrink-stalled(${prev})` });
      continue;
    }
    if (d.action === "shrink") plan.shrink.push({ page: p.page, freePct: p.freePct, freePt: p.freePt, fig, maxCss: d.maxCss, tier: d.tier, reason: d.reason, availCss: d.availCss });
    else if (d.action === "delete") plan.delete.push({ page: p.page, freePct: p.freePct, freePt: p.freePt, fig, reason: d.reason });
    else plan.skip.push({ page: p.page, freePct: p.freePct, why: `${d.action}:${d.reason}` });
  }
  return plan;
}

// ---- 复验断言：无 ≥40% 空缺且次页顶有图未处理（big 违例 = FAIL） ----
export function assertNoUnfilledGaps(pdf, figs, chapterStartPages = []) {
  const per = holeReport(pdf).per;
  const aligned = matchFigsToPdf(figs, pdf);
  const starts = new Set(chapterStartPages);
  const violations = [];
  for (const p of per) {
    if (p.isLast) continue;
    if (p.freePct < RULES.GAP_ASSERT_PCT) continue;
    if (starts.has(p.page + 1)) { violations.push({ page: p.page, freePct: p.freePct, exempt: "next-is-chapter-start" }); continue; }
    const onPage = aligned.filter((f) => f.actualPage === p.page + 1);
    if (onPage.length) violations.push({ page: p.page, freePct: p.freePct, figKeys: onPage.map((f) => f.key) });
  }
  return { violations, hardFail: violations.some((v) => !v.exempt) };
}

// ---- 墨迹终扫（复验用：pdftoppm 低清灰度 → 内容区末行墨迹；页脚区裁掉） ----
// contentFrac = 内容底界占页高比例（A4+0.4in 边距 → 813.12/841.92 = 0.9659）。
export function inkTailScan(pdf, { dpi = 36, tailInkTh = 242, contentFrac = 813.12 / 841.92 } = {}) {
  const dir = path.join(os.tmpdir(), `dz-gap-${process.pid}-${path.basename(pdf)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("pdftoppm", ["-r", String(dpi), "-gray", pdf, path.join(dir, "p")], { maxBuffer: 64 << 20, timeout: 570000 });
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".pgm")).sort();
  const out = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    let p = 0;
    const tok = () => {
      while (p < buf.length && (buf[p] === 0x20 || buf[p] === 0x0a || buf[p] === 0x0d || buf[p] === 0x09)) p++;
      if (buf[p] === 0x23) { while (p < buf.length && buf[p] !== 0x0a) p++; return tok(); }
      const s = p;
      while (p < buf.length && !(buf[p] === 0x20 || buf[p] === 0x0a || buf[p] === 0x0d || buf[p] === 0x09)) p++;
      return buf.toString("latin1", s, p);
    };
    if (tok() !== "P5") continue;
    const w = +tok(), h = +tok(); tok(); p++;
    const data = buf.subarray(p, p + w * h);
    const hContent = Math.floor(h * contentFrac); // 页脚区（页码）裁掉，只看内容区墨迹
    let lastInk = -1;
    for (let y = hContent - 1; y >= 0; y--) {
      let ink = false;
      for (let x = 0; x < w; x++) if (data[y * w + x] < tailInkTh) { ink = true; break; }
      if (ink) { lastInk = y; break; }
    }
    const tailBlankPct = lastInk < 0 ? 100 : +(((hContent - 1 - lastInk) / ((CONTENT_H_PT / 841.92) * h)) * 100).toFixed(1);
    out.push({ page: +f.match(/(\d+)\.pgm$/)[1], lastInkRow: lastInk, tailBlankPct });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
