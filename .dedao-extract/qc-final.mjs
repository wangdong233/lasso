#!/usr/bin/env node
// qc-final.mjs — v2 出厂三层质检（页范围可控版）
// ①逐页墨迹尾空（fk 含 119 条带图 → 全量 pdftoppm 单调用必超时，按关键页子集跑）
// ②before/after 洞页对比 ③关键页 PNG 渲染（供视觉抽检）
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { inkReport, holeReport, promoInPdf } from "./analyze.mjs";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const S = path.join(ROOT, ".dedao-extract", "scratch");
const BASE = "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学";
const QC = path.join(BASE, ".qc-v2");
fs.mkdirSync(QC, { recursive: true });

const FINALS = [
  { tag: "fk", pdf: `${BASE}/课前必读(1讲)/发刊词丨只给你地道的经济学思维.pdf`, before: `${S}/fk-r3-base.pdf`, inkPages: [1, 2, 3, 4, 14], pngPages: [2, 4, 5, 14] },
  { tag: "l001", pdf: `${BASE}/01-经济学本源之一：东西不够(110讲)/第001讲丨战俘营里的经济组织.pdf`, before: `${S}/l001-before.pdf`, inkPages: "all", pngPages: [1, 2] },
  { tag: "l002", pdf: `${BASE}/01-经济学本源之一：东西不够(110讲)/第002讲丨马粪争夺案.pdf`, before: `${S}/l002-before.pdf`, inkPages: "all", pngPages: [1] },
];

function inkPages(pdf, pages) {
  const total = holeReport(pdf).pages;
  const want = pages === "all" ? [...Array(total).keys()].map((i) => i + 1) : pages;
  const out = [];
  for (const p of want) {
    try {
      const r = inkReport(pdf, { first: p, last: p, dpi: 36 });
      out.push(...r);
      console.log(`  ink p${p}: tail=${r[0]?.tailBlankPct}%`);
    } catch (e) { out.push({ page: p, tailBlankPct: "timeout" }); console.log(`  ink p${p}: TIMEOUT/err`); }
  }
  return { total, out };
}

const report = {};
for (const f of FINALS) {
  const fast = holeReport(f.pdf);
  const promo = promoInPdf(f.pdf);
  const ink = inkPages(f.pdf, f.inkPages);
  const beforeHead = (() => { try { return inkReport(f.before, { first: 1, last: Math.min(4, fast.pages), dpi: 36 }).map((p) => `p${p.page}:${p.tailBlankPct}%`); } catch { return ["err"]; } })();
  report[f.tag] = {
    pdf: f.pdf, pages: ink.total,
    fastHoles: fast.holes.map((h) => `p${h.page}:${h.tailPct}%`),
    promo1080x607: promo.length,
    ink: ink.out.map((p) => `p${p.page}:${p.tailBlankPct}%`),
    beforeHead,
  };
  console.log(`== ${f.tag} pages=${ink.total} fastHoles=${report[f.tag].fastHoles.join(",") || "none"} promo=${promo.length} before=${beforeHead.join(" ")}`);

  for (const pg of f.pngPages) {
    try {
      execFileSync("pdftoppm", ["-f", String(pg), "-l", String(pg), "-r", "72", "-png", f.pdf, path.join(QC, `${f.tag}-after-p${pg}`)], { timeout: 570000 });
      console.log(`  png after p${pg} ok`);
    } catch (e) { console.log(`  png after p${pg} err`); }
  }
  for (const pg of [1, 2]) {
    try {
      execFileSync("pdftoppm", ["-f", String(pg), "-l", String(pg), "-r", "72", "-png", f.before, path.join(QC, `${f.tag}-before-p${pg}`)], { timeout: 300000 });
      console.log(`  png before p${pg} ok`);
    } catch (e) { console.log(`  png before p${pg} err`); }
  }
}
fs.writeFileSync(path.join(ROOT, ".dedao-extract", "v2-qc-final.json"), JSON.stringify(report, null, 2));
console.log("QC-DONE; PNG in", QC);
