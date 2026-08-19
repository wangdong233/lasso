#!/usr/bin/env node
// analyze.mjs — v2 管线共享分析器（零光栅快测 + 墨迹终检 + 文字零丢失）
// 白盒依据：P14-探察-二轮 §3（S-A' 闭环：pdfimages 0.1s + pdftotext -bbox 0.07s/页；
// pdftoppm 对含课程表 PDF 约 2min/份，只作出厂终检，禁入主管线）
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 打印参数（extract-batch3 同款）：A4、四边 0.4in → pt 域
export const PT_PER_IN = 72;
export const PAGE_W_IN = 8.268, PAGE_H_IN = 11.693, MARGIN_IN = 0.4;
export const CONTENT_TOP = MARGIN_IN * 72; // 28.8pt
export const PAGE_H_PT = PAGE_H_IN * 72; // 841.92
export const CONTENT_BOTTOM = PAGE_H_PT - MARGIN_IN * 72; // 813.12
export const CONTENT_H_PT = CONTENT_BOTTOM - CONTENT_TOP; // 784.32
export const PAGE_CSS = Math.round((PAGE_H_IN - 2 * MARGIN_IN) * 96); // 1046 css px/页
export const PROMO_NAT = { w: 1080, h: 607 }; // P14 §1.1 尾部宣传图自然尺寸指纹

function tmp(pdf) {
  return path.join(os.tmpdir(), `dz-ana-${process.pid}-${path.basename(pdf)}`);
}

// ---- pdfimages -list 解析 ----
export function pdfImages(pdf) {
  const out = execFileSync("pdfimages", ["-list", pdf], { maxBuffer: 64 << 20 }).toString();
  const rows = [];
  for (const line of out.split("\n").slice(2)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 14 || !/^\d+$/.test(t[0])) continue;
    rows.push({
      page: +t[0], num: +t[1], type: t[2], w: +t[3], h: +t[4],
      enc: t[8], xppi: +t[t.length - 4], yppi: +t[t.length - 3],
    });
  }
  return rows.filter((r) => r.type === "image"); // smask=同对象 alpha 通道，不计
}

// ---- pdftotext -bbox 解析（词级坐标） ----
export function bboxWords(pdf) {
  const out = execFileSync("pdftotext", ["-bbox", pdf, "-"], { maxBuffer: 128 << 20 }).toString();
  const pages = [];
  let page = null;
  const re = /<page width="([\d.]+)" height="([\d.]+)">|<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g;
  let m;
  while ((m = re.exec(out))) {
    if (m[1]) { page = { w: +m[1], h: +m[2], words: [] }; pages.push(page); }
    else if (page) {
      page.words.push({ x0: +m[3], y0: +m[4], x1: +m[5], y1: +m[6], text: m[7] });
    }
  }
  return pages;
}

// ---- 快测洞报告（S-A' 闭环核心） ----
// 判定：非末页 ∧ 文本尾空 >12% ∧ 版面充满度 <0.88（文本跨距 + 图显示高 + 图间隙）
// 课程表切片页（全页图）被充满度豁免；图片收尾页被充满度豁免（bbox 只见文字的假洞）
// P23 修复：页脚页码（displayHeaderFooter，y≈821-827 > CONTENT_BOTTOM=813.12）必须排除——
// 路线b 合并 PDF 带页码页脚，计入会把 textBottom 钉死在页脚 → tailPct 恒 0 → 洞检测全盲。
// 单章管线（engine）无页脚，此过滤为无操作，行为不变。
export function holeReport(pdf, { tailPct = 12, fullFloor = 0.88, gapPt = 24 } = {}) {
  const imgs = pdfImages(pdf);
  const pages = bboxWords(pdf);
  const n = pages.length;
  const per = pages.map((pg, i) => {
    const contentWords = pg.words.filter((w) => w.y1 <= CONTENT_BOTTOM + 0.75); // 页脚词排除
    const ys = contentWords.map((w) => w.y1);
    const textBottom = ys.length ? Math.max(...ys) : null;
    const textTop = contentWords.length ? Math.min(...contentWords.map((w) => w.y0)) : null;
    const imgsOnPage = imgs.filter((r) => r.page === i + 1);
    const imgPt = Math.min(
      CONTENT_H_PT,
      imgsOnPage.reduce((s, r) => s + (r.yppi > 0 ? (r.h / r.yppi) * PT_PER_IN : 0), 0),
    );
    const textSpan = textBottom !== null ? textBottom - CONTENT_TOP : 0;
    const used = Math.max(textSpan, 0) + imgPt + imgsOnPage.length * gapPt;
    const fullness = +(used / CONTENT_H_PT).toFixed(3);
    const tailPt = textBottom !== null ? CONTENT_BOTTOM - textBottom : CONTENT_H_PT;
    const tailPctV = +(Math.max(0, tailPt) / CONTENT_H_PT * 100).toFixed(1);
    const isLast = i === n - 1;
    const hole = !isLast && tailPctV > tailPct && fullness < fullFloor;
    const freePt = +Math.max(0, CONTENT_H_PT - used).toFixed(1); // 版面自由空间（保守：文本跨距+图高+图间隙的加性模型）
    const freePct = +(freePt / CONTENT_H_PT * 100).toFixed(1);
    return { page: i + 1, textBottom, textTop, imgCount: imgsOnPage.length, imgPt: Math.round(imgPt), fullness, tailPt: +tailPt.toFixed(1), tailPct: tailPctV, freePt, freePct, isLast, hole };
  });
  return { pdf, pages: n, holes: per.filter((p) => p.hole), per };
}

// ---- 宣传图断言：PDF 内不得存在 1080×607 图 ----
export function promoInPdf(pdf) {
  return pdfImages(pdf).filter((r) => r.w === PROMO_NAT.w && r.h === PROMO_NAT.h);
}

// ---- 文字零丢失（P14 §3 定案：cleanup 态 innerText vs pdftotext，missing 必须为空） ----
export function textZeroLoss(pdf, innerTxt) {
  const pdftxt = execFileSync("pdftotext", [pdf, "-"], { maxBuffer: 128 << 20 }).toString();
  const norm = (s) => s.normalize("NFC").replace(/[\s­​‌‍﻿]/g, "");
  const a = norm(pdftxt), b = norm(innerTxt); // a=PDF 侧，b=DOM 侧
  // 多重集 diff（字符级，CJK 字≈词；PDF 侧多出字符=良性：CSS 列表序号等）
  const cnt = new Map();
  for (const ch of a) cnt.set(ch, (cnt.get(ch) || 0) + 1);
  const missCnt = new Map();
  for (const ch of b) {
    const left = cnt.get(ch) || 0;
    if (left > 0) cnt.set(ch, left - 1);
    else missCnt.set(ch, (missCnt.get(ch) || 0) + 1);
  }
  const missing = [...missCnt.entries()].map(([ch, c]) => `${ch}x${c}`);
  // 保序检查：b 必须是 a 的子序列
  let j = 0;
  for (let i = 0; i < a.length && j < b.length; i++) if (a[i] === b[j]) j++;
  return { missing, missingEmpty: missing.length === 0, inOrder: j === b.length, pdfChars: a.length, domChars: b.length };
}

// ---- 墨迹终检（慢：pdftoppm PGM，仅出厂抽检/3 章对比证据） ----
export function inkReport(pdf, { first = 1, last = null, tailInkTh = 242, dpi = 36 } = {}) {
  const dir = tmp(pdf);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const npages = last ?? bboxWords(pdf).length;
  const args = ["-f", String(first), "-l", String(last ?? npages), "-r", String(dpi), "-gray", pdf, path.join(dir, "p")];
  execFileSync("pdftoppm", args, { maxBuffer: 64 << 20, timeout: 570000 });
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
    let lastInk = -1, firstInk = -1;
    for (let y = 0; y < h && firstInk < 0; y++)
      for (let x = 0; x < w; x++) if (data[y * w + x] < tailInkTh) { firstInk = y; break; }
    for (let y = h - 1; y >= 0; y--) {
      let ink = false;
      for (let x = 0; x < w; x++) if (data[y * w + x] < tailInkTh) { ink = true; break; }
      if (ink) { lastInk = y; break; }
    }
    out.push({ page: +f.match(/(\d+)\.pgm$/)[1], tailBlankPct: +(((h - 1 - lastInk) / h) * 100).toFixed(1), headBlankPct: firstInk < 0 ? 100 : +((firstInk / h) * 100).toFixed(1) });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

// ---- Chrome 可见性守卫（P16：PID 定向，禁进程名全量） ----
export function chromeGuard() {
  try {
    const pid = execFileSync("zsh", ["-c", "lsof -nP -iTCP:9226 -sTCP:LISTEN | awk 'NR>1{print $2}' | sort -u | head -1"])
      .toString().trim();
    if (!pid || !/^\d+$/.test(pid)) return { ok: false, err: "no-pid" };
    const vis = execFileSync("osascript", ["-e",
      `tell application "System Events" to get visible of (first process whose unix id is ${pid})`]).toString().trim();
    if (vis === "true") {
      execFileSync("osascript", ["-e",
        `tell application "System Events" to set visible of (first process whose unix id is ${pid}) to false`]);
      return { ok: true, pid, was: "visible", action: "rehidden" };
    }
    return { ok: true, pid, was: "hidden", action: "none" };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 120) };
  }
}
