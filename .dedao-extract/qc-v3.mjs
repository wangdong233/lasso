#!/usr/bin/env node
// qc-v3.mjs — v3 三层质检终检：MD 断言 / PDF 文本断言 / v2↔v3 刻意删除差 / 墨迹洞检（避开 fk 条带页）
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { inkReport, holeReport } from "./analyze.mjs";

const BASE = "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学";
const SCRATCH = "/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/scratch";
const CH = [
  { tag: "fk", dir: "课前必读(1讲)", title: "发刊词丨只给你地道的经济学思维", sikaoDeleted: 0, skipInkPages: [4] },
  { tag: "l001", dir: "01-经济学本源之一：东西不够(110讲)", title: "第001讲丨战俘营里的经济组织", sikaoDeleted: 96, skipInkPages: [] },
  { tag: "l002", dir: "01-经济学本源之一：东西不够(110讲)", title: "第002讲丨马粪争夺案", sikaoDeleted: 40, skipInkPages: [] },
];
const pdftxt = (p) => execFileSync("pdftotext", [p, "-"], { maxBuffer: 128 << 20 }).toString();
const norm = (s) => s.normalize("NFC").replace(/[\s­​]/g, "");
const out = { chapters: [] };
let fails = 0;

for (const c of CH) {
  const r = { tag: c.tag, checks: {} };
  const pdf = path.join(BASE, c.dir, `${c.title}.pdf`);
  const md = path.join(BASE, c.dir, `${c.title}.md`);
  const mdTxt = fs.readFileSync(md, "utf8");
  const pdfT = pdftxt(pdf);

  // ---- MD 断言（frontmatter 剥离：pipeline 字串自含「课后思考」、标题自含课程标语，均非正文） ----
  const mdBody = mdTxt.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^# [^\n]*\n/, "");
  r.checks.mdExists = fs.existsSync(md);
  r.checks.mdNoSikao = !mdBody.includes("课后思考");
  r.checks.mdNoFloater = !mdBody.includes("写笔记");
  r.checks.mdNoPromoPhrase = !mdBody.includes("商务合作") && !mdBody.includes("敬请关注");
  const refs = [...mdTxt.matchAll(/!\[\]\((images\/[^)]+)\)/g)].map((m) => m[1]);
  const missingFiles = refs.filter((p2) => !fs.existsSync(path.join(BASE, c.dir, p2)));
  r.checks.mdImgRefs = refs.length;
  r.checks.mdImgAllLocal = missingFiles.length === 0;
  r.checks.mdImgRemote = (mdTxt.match(/!\[\]\(http/g) || []).length;
  const imgDir = path.join(BASE, c.dir, "images");
  const files = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).length : 0;
  r.checks.imgDirFiles = files;

  // ---- PDF 文本断言 ----
  r.checks.pdfNoSikao = !pdfT.includes("课后思考");
  r.checks.pdfNoFloater = !pdfT.includes("写笔记");
  r.checks.pdfNoPromo = !pdfT.includes("商务合作");

  // ---- v2↔v3 刻意删除差：v3 PDF 文本 = v2 PDF 文本 - sikao 段（字符多重集差恰=删除字数） ----
  const v2s = fs.readdirSync(SCRATCH).filter((f) => f.startsWith(`v2-${c.tag}-it`) && f.endsWith(".pdf"));
  if (v2s.length) {
    // v2 最优迭代 = 无洞优先，否则取最后
    const byIter = v2s.map((f) => ({ f, it: +f.match(/it(\d)/)[1] })).sort((a, b) => a.it - b.it);
    let v2pdf = null;
    for (const cand of byIter) { if (holeReport(path.join(SCRATCH, cand.f)).holes.length === 0) { v2pdf = cand.f; break; } }
    v2pdf = v2pdf || byIter.at(-1).f;
    const v2T = norm(pdftxt(path.join(SCRATCH, v2pdf)));
    const v3T = norm(pdfT);
    // v2 多出的字符 = 刻意删除（课后思考段 + 可能的浮层零星）
    const cnt = new Map();
    for (const ch of v3T) cnt.set(ch, (cnt.get(ch) || 0) + 1);
    const extra = new Map();
    for (const ch of v2T) { const l = cnt.get(ch) || 0; if (l > 0) cnt.set(ch, l - 1); else extra.set(ch, (extra.get(ch) || 0) + 1); }
    const extraChars = [...extra.entries()].reduce((s, [, n]) => s + n, 0);
    r.checks.v2Baseline = v2pdf;
    r.checks.v2extraChars = extraChars;
    r.checks.v2extraSample = [...extra.entries()].slice(0, 12).map(([ch, n]) => `${ch}x${n}`).join("");
    r.checks.deliberateDeltaOk = extraChars >= c.sikaoDeleted && extraChars <= c.sikaoDeleted + 8;
  }

  // ---- 墨迹洞检（fk 跳过条带页 p4：pdftoppm 分钟级超时） ----
  const pages = holeReport(pdf).pages;
  const ranges = [];
  if (c.skipInkPages.length) {
    let a = 1;
    for (const p of [...c.skipInkPages, pages + 1]) { if (p > a) ranges.push([a, p - 1]); a = p + 1; }
  } else ranges.push([1, pages]);
  const ink = [];
  for (const [f, l] of ranges) ink.push(...inkReport(pdf, { first: f, last: l }));
  r.checks.inkPages = ink.length;
  r.checks.inkMidHoles = ink.filter((p) => p.tailBlankPct > 25 && p.page !== pages).map((p) => `p${p.page}:${p.tailBlankPct}%`);
  r.checks.inkTail = `p${pages}:${ink.find((p) => p.page === pages)?.tailBlankPct ?? "skipped"}%`;

  const chFails = Object.entries(r.checks).filter(([k, v]) => v === false);
  if (chFails.length) fails += chFails.length;
  r.fails = chFails.map(([k]) => k);
  out.chapters.push(r);
  console.log(`${c.tag}: ${chFails.length ? "FAIL " + chFails.map(([k]) => k).join(",") : "PASS"} ` + JSON.stringify(r.checks));
}
out.fails = fails;
fs.writeFileSync(path.join(path.dirname(SCRATCH), "v3-qc-final.json"), JSON.stringify(out, null, 2));
console.log(fails === 0 ? "QC-v3 ALL PASS" : `QC-v3 FAILED(${fails})`);
process.exit(fails === 0 ? 0 : 1);
