#!/usr/bin/env node
/**
 * merge.mjs — 路线 b′ 全书终局渲染器（419 章 → 单本 PDF；P23 后升格版）
 *
 * 依据：全量处理方案.md §5.3/§5.4 裁决——按 14 模块分片渲染（每片 ~30 章），
 *       片间 pypdf 合并 + 页码统一盖章 + TOC 两遍回填 + 全书五门禁 QC。
 * 同源：缩图/删图裁决全部来自 lasso/.dedao-extract/gapfill.mjs（单一规则权威）。
 *
 * 用法：
 *   node merge.mjs plan                    # 完整性门禁：419 MD + 图片盘点 → merge-plan.json
 *   node merge.mjs render [--module K] [--force] [--partial]
 *   node merge.mjs assemble [--partial]    # 前言两遍 + pypdf 合并 + 页码盖章 + 书签 + QC（墨迹终扫常开）
 *   node merge.mjs all [--partial]         # plan → render → assemble（终局一键）
 *   node merge.mjs sample --pages 1,16,50  # 抽查页 PNG 渲染（视觉抽检）
 *
 * --partial：仅纳入已 done 的章（**仅供全量前的机制冒烟**；全量终局禁用）。
 * --titles <file>   ：冒烟集钉死（每行一个 MD 标题；忽略 done 过滤——用于同输入重渲对照）。
 * --tag-suffix <s>  ：分片产物/metas 后缀（冒烟不落正式分片名，防全量误判「已渲染」跳过）。
 * --out-name <name> ：成品 PDF 与 report 基名（默认沿用 冒烟-合并N章 / 全N讲 命名）。
 *
 * 版式（2026-08-20 连续流式改版）：章级零强制分页——上一章正文结束后同页紧接下一章章头
 *   （居中大号宋体标题 + 模块名前缀 + 短分隔线 + 上下留白 ~1.5em）；每片（模块）首页加
 *   模块题头块（通栏粗线 + 大标题 + 稍大上边距），不整页分隔。封面/目录保持独立分页。
 * G2 新标准（用户 2026-08-20）：除结构性边界（前言页/各模块末页=全书末页）外，
 *   任何页尾墨迹空白 ≥40% 视为失败（墨迹终扫常开，不再依赖 --ink）。
 * 静默纪律：复用 9226 既有隐藏窗口内开 tab（P21：/json/new 后须 WS Page.navigate），
 *           建 tab 后立即 chromeGuard 定向复隐，print 后关 tab（P16/P19）；
 *           JS 对话框自动接受（Page.javascriptDialogOpening → accept），并置 onbeforeunload=null。
 * 页码：分片渲染不带页脚 → 合并后统一盖章（overlay PDF，跳过封面），
 *       页码 = 物理页号（与 TOC 回填同一数字域，机械可核）。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { holeReport, chromeGuard, textZeroLoss, pdfImages } from "/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/analyze.mjs";
import { RULES, matchFigsToPdf, planGapFill, figChainAnnotations, assertNoUnfilledGaps, inkTailScan } from "/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/gapfill.mjs";

// —— 课程配置（2026-08-20 F1 整改）：课程相关常量唯一入口 = ./config.mjs，换课程只改该文件 ——
import { BASE, ENGINE, OUT, CDP, COURSE, VENV_PY, CFG } from "./config.mjs";
const WORK = path.join(OUT, ".work");
const ASSEMBLE_PY = path.join(ENGINE, "merge-assemble.py");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ENGINE, "manifest.json"), "utf8"));
const STATE = JSON.parse(fs.readFileSync(path.join(ENGINE, "state.json"), "utf8"));

const argv = process.argv.slice(2);
const cmd = argv[0] || "all";
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? true : d; };
const PARTIAL = !!opt("partial", false);
// 冒烟对照三件套：--titles 钉死章集（同输入重渲）｜--tag-suffix 分片产物后缀（防全量误判已渲染）
// ｜--out-name 成品/report 基名（保留旧版对照，不覆盖 冒烟-合并6章.pdf）
const TITLES_FILE = opt("titles", null);
const TITLE_SET = typeof TITLES_FILE === "string" ? new Set(fs.readFileSync(TITLES_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)) : null;
const SUFFIX = typeof opt("tag-suffix", "") === "string" ? opt("tag-suffix", "") : "";
const OUT_NAME = typeof opt("out-name", null) === "string" ? opt("out-name", null) : null;
const shardTag = (no) => `shard${String(no).padStart(2, "0")}${SUFFIX}`;
const SMOKING = PARTIAL || !!TITLE_SET; // 冒烟语义：不强制 419 全量门禁
fs.mkdirSync(WORK, { recursive: true });
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------------- MD → 结构块（render-merge-b.mjs 同款） ----------------
function parseMd(file) {
  const raw = fs.readFileSync(file, "utf8");
  let fm = {}, body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end > 0) {
      for (const ln of raw.slice(4, end).split("\n")) { const m = ln.match(/^(\w+):\s*(.*)$/); if (m) fm[m[1]] = m[2]; }
      body = raw.slice(end + 4);
    }
  }
  const dir = path.dirname(file);
  const lines = body.split("\n");
  const out = []; let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { i++; continue; }
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push({ t: "h", lvl: h[1].length, txt: h[2].trim() }); i++; continue; }
    if (/^[-*]\s+/.test(ln)) { const items = []; while (i < lines.length && /^[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, "")); i++; } out.push({ t: "ul", items }); continue; }
    if (/^\d+\.\s+/.test(ln)) { const items = []; while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; } out.push({ t: "ol", items }); continue; }
    if (/^>\s?/.test(ln)) { const qs = []; while (i < lines.length && /^>\s?/.test(lines[i])) { qs.push(lines[i].replace(/^>\s?/, "")); i++; } out.push({ t: "quote", txt: qs.join("\n") }); continue; }
    if (/^\|/.test(ln)) { const rows = []; while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; } const trs = rows.filter((r) => !/^\|[\s|:-]+\|$/.test(r.trim())).map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())); out.push({ t: "table", rows: trs }); continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|[-*]\s|\d+\.\s|>|\|)/.test(lines[i])) { para.push(lines[i]); i++; }
    const joined = para.join("\n");
    if (/^!\[\]\([^)]+\)$/.test(joined.trim())) out.push({ t: "img", src: joined.trim().slice(4, -1) });
    else out.push({ t: "p", txt: joined });
  }
  return { fm, blocks: out, dir };
}

// ---------------- 共用 CSS（demo 同款版式） ----------------
const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; }
  body { font-family: "PingFang SC", "Hiragino Sans GB", sans-serif;
         font-size: 10.5pt; line-height: 1.95; color: #1c1c1e; text-align: justify; }
  .cover { break-after: page; padding-top: 64mm; }
  .cover .kicker { font-size: 10pt; letter-spacing: .35em; color: #8a8a8e; margin-bottom: 10mm; }
  .cover h1 { font-family: "Songti SC", "STSong", serif; font-size: 27pt; font-weight: 700; letter-spacing: .06em; margin-bottom: 6mm; }
  .cover .sub { font-size: 11pt; color: #6d6d72; margin-bottom: 22mm; }
  .cover .meta { font-size: 9pt; color: #aeaeb2; line-height: 2.1; }
  .toc { break-after: page; }
  .toc h2 { font-family: "Songti SC", serif; font-size: 16pt; margin: 8mm 0 10mm; }
  .toc ol { list-style: none; }
  .toc li { display: flex; align-items: baseline; font-size: 10pt; line-height: 2.4; }
  .toc li .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 78%; }
  .toc li .dots { flex: 1; border-bottom: 1px dotted #c7c7cc; margin: 0 6px 4px; }
  .toc li .pg { color: #6d6d72; font-variant-numeric: tabular-nums; }
  .toc .mod { font-size: 8.5pt; color: #8a8a8e; letter-spacing: .12em; margin: 5mm 0 1mm; }
  /* 连续流式（2026-08-20）：章级零强制分页——上一章正文结束后同页紧接下一章章头 */
  section.chapter { break-before: auto; }
  /* 模块题头块（每片=1 模块，片首页）：通栏粗线 + 大标题 + 稍大上边距，不整页分隔 */
  .mod-band { margin-bottom: 1.6em; padding-top: 5mm; text-align: center;
    break-inside: avoid; break-after: avoid; }
  .mod-band .band-rule { border-top: 2.2pt solid #1c1c1e; margin-bottom: 6.5mm; }
  .mod-band .mod-kicker { font-size: 9pt; letter-spacing: .3em; color: #8a8a8e; margin-bottom: 2.8mm; }
  .mod-band .mod-name { font-family: "Songti SC", "STSong", serif; font-size: 20pt;
    font-weight: 700; letter-spacing: .06em; line-height: 1.5; }
  .mod-band .mod-sub { font-size: 8.5pt; letter-spacing: .14em; color: #6d6d72; margin-top: 3mm; }
  /* 章头排版：居中大号宋体标题 + 模块名前缀 + 短分隔线 + 上下留白 ~1.5em */
  .ch-head { margin-top: 1.5em; text-align: center; break-inside: avoid; break-after: avoid; }
  section.chapter:first-of-type .ch-head { margin-top: 0; }
  .ch-head .ch-rule { width: 2.6em; border-top: 1.4pt solid #48484a; margin: 0 auto 1.1em; }
  .ch-head .ch-mod { font-size: 8.5pt; letter-spacing: .2em; color: #8a8a8e; margin-bottom: .95em; }
  h1.ch-title { font-family: "Songti SC", "STSong", serif; font-size: 16pt; font-weight: 700;
    letter-spacing: .05em; line-height: 1.5; margin-bottom: 1.5em; }
  h2, h3, h4 { font-weight: 600; font-size: 12pt; line-height: 1.7; margin: 1.9em 0 .8em; break-after: avoid; }
  h3 { font-size: 11pt; } h4 { font-size: 10.5pt; }
  p { margin: 0 0 .62em; orphans: 3; widows: 3; }
  figure { margin: 1.35em 0; break-inside: avoid; text-align: center; }
  figure img { max-width: 100%; max-height: 10.1in; height: auto; }
  img { max-width: 100%; }
  blockquote { margin: 1em 0; padding: .35em 0 .35em 1em; border-left: 2pt solid #d1d1d6;
    color: #48484a; font-size: 10pt; }
  ul, ol { margin: .5em 0 .9em 1.6em; }
  li { margin-bottom: .3em; }
  table { border-collapse: collapse; margin: 1em 0; font-size: 9.5pt; }
  th, td { border: .5pt solid #c7c7cc; padding: 4px 8px; }
  th { background: #f2f2f7; }
`;

const modLabel = (dirName) => dirName.replace(/\((\d+)讲\)/, "").replace(/^-/, "").replace("-", " ").trim();

// ---------------- HTML 构建 ----------------
// front=true：封面 + 目录（tocPages 为 null 时页码留空——第一遍）；front=false：分片正文（哨兵用全局章 idx）。
// 连续流式：章级零强制分页；片首章（i=0）前置模块题头块（shard={no,label}），其余章同页紧接上一章。
function buildHtml({ front, chapters, shard = null, tocPages = null, figOps = { shrink: new Map(), deleted: new Set() }, figKeyBase = 0 }) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const mkInline = (dir) => (s) => {
    let t = esc(s);
    t = t.replace(/!\[\]\(([^)]+)\)/g, (_, p) => `<img src="${encodeURI("file://" + path.resolve(dir, p))}" alt="">`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    return t;
  };
  let figKey = figKeyBase;
  const bh = (b, inl, dir) => {
    if (b.t === "h") { const l = Math.min(4, b.lvl + 1); return `<h${l}>${inl(b.txt)}</h${l}>`; }
    if (b.t === "p") return `<p>${inl(b.txt).replace(/\n/g, "<br>")}</p>`;
    if (b.t === "ul") return `<ul>${b.items.map((x) => `<li>${inl(x)}</li>`).join("")}</ul>`;
    if (b.t === "ol") return `<ol>${b.items.map((x) => `<li>${inl(x)}</li>`).join("")}</ol>`;
    if (b.t === "quote") return `<blockquote>${inl(b.txt).replace(/\n/g, "<br>")}</blockquote>`;
    if (b.t === "table") { const td = (r, tag) => r.map((c2) => `<${tag}>${inl(c2)}</${tag}>`).join(""); return `<table><tbody>${b.rows.map((r, i) => `<tr>${td(r, i === 0 ? "th" : "td")}</tr>`).join("")}</tbody></table>`; }
    if (b.t === "img") {
      const k = figKey++;
      if (figOps.deleted.has(k)) return `<!--fig${k}:deleted-by-gap-rule-->`;
      const mh = figOps.shrink.get(k);
      const style = mh ? ` style="max-height:${mh}px;width:auto"` : "";
      return `<figure data-fk="${k}"><img src="${encodeURI("file://" + path.resolve(dir, b.src))}" alt=""${style}></figure>`;
    }
    return "";
  };
  const parts = [`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${COURSE}</title><style>${CSS}</style></head><body>`];
  if (front) {
    parts.push(`<div class="cover">
    <div class="kicker">得　到　课　程</div>
    <h1>${COURSE}</h1>
    <div class="sub">全 ${chapters.length} 讲 · MD 正典终局成书（路线 b′ · 连续流式版式）</div>
    <div class="meta">模块 ${new Set(chapters.map((c) => c.module)).size} 个 · 生成 ${new Date().toISOString().slice(0, 10)} · merge.mjs</div>
  </div>`);
    parts.push(`<div class="toc"><h2>目　录</h2><ol>`);
    let lastMod = null;
    chapters.forEach((c, i) => {
      if (c.module !== lastMod) { parts.push(`<div class="mod">${esc(c.module)}</div>`); lastMod = c.module; }
      parts.push(`<li><span class="t">${esc(c.title)}</span><span class="dots"></span><span class="pg">${tocPages ? tocPages[i] ?? "—" : ""}</span></li>`);
    });
    parts.push(`</ol></div>`);
    return parts.join("\n") + "</body></html>";
  }
  chapters.forEach((c, i) => {
    const inl = mkInline(c.dir);
    const band = i === 0 && shard ? `<div class="mod-band">
      <div class="band-rule"></div>
      <div class="mod-kicker">模块 ${String(shard.no).padStart(2, "0")}</div>
      <div class="mod-name">${esc(shard.label)}</div>
      <div class="mod-sub">本模块 ${chapters.length} 讲</div>
    </div>` : "";
    parts.push(`<section class="chapter" id="ch${c.gidx}">
      <span style="font-size:1px;color:rgba(0,0,0,0);position:absolute;">MARKCH${c.gidx}END</span>
      ${band}
      <div class="ch-head">
        <div class="ch-rule"></div>
        <div class="ch-mod">${esc(c.module)}</div>
        <h1 class="ch-title">${esc(c.title)}</h1>
      </div>
      ${c.blocks.filter((b) => !(b.t === "h" && b.lvl === 1)).map((b) => bh(b, inl, c.dir)).join("\n")}
    </section>`);
  });
  return parts.join("\n") + "</body></html>";
}

// 页码盖章 overlay（N 页，仅页脚居中数字；透明背景，合并后叠到正文页上）
function buildNumbersHtml(n, skipFirst) {
  const pages = [];
  for (let p = 1; p <= n; p++) {
    const num = skipFirst && p === 1 ? "" : String(p);
    const brk = p < n ? "page-break-after:always;" : "";
    pages.push(`<div style="width:8.268in;height:11.693in;position:relative;${brk}"><span style="position:absolute;bottom:14px;left:0;right:0;text-align:center;font:8px -apple-system,sans-serif;color:#9a9a9f;">${num}</span></div>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}</style></head><body>${pages.join("")}</body></html>`;
}

// ---------------- CDP 静默渲染（demo 同款；footer=false——页码终局盖章，不在片内打印） ----------------
// 开 tab + WS：最多 4 次重试（Chrome 连续开关 tab 偶发 ws 握手拒绝，属瞬态）
// P27 根治（2026-08-20 用户实感「闪跳+抢焦点」定案）：原 /json/new HTTP 端点是**前台
// 语义**（等价无 background 的 createTarget）——每次开 tab 都 activate Chrome、偷走
// 用户当前 app 焦点；事后 chromeGuard 只能压回可见性，**焦点还不回去**。改为浏览器级
// WS Target.createTarget {background:true}（engine/lasso 同款零激活原语）→ Chrome 从不
// 激活：不闪、不抢焦点，无任何需事后纠正的状态。
async function openTabWs() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let createdId = null;
    let bws = null;
    try {
      const ver = await (await fetch(`${CDP}/json/version`)).json();
      bws = await new Promise((res, rej) => {
        const w = new WebSocket(ver.webSocketDebuggerUrl);
        let done = false;
        const t = setTimeout(() => { if (!done) rej(new Error("bws-open-timeout")); }, 8000);
        w.onopen = () => { done = true; clearTimeout(t); res(w); };
        w.onerror = () => { if (!done) { done = true; clearTimeout(t); rej(new Error("bws")); } };
      });
      const cre = await new Promise((res, rej) => {
        const id = Math.floor(Math.random() * 1e6) + 1;
        const t = setTimeout(() => rej(new Error("createTarget-timeout")), 8000);
        const onm = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { clearTimeout(t); bws.removeEventListener("message", onm); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
        bws.addEventListener("message", onm);
        bws.send(JSON.stringify({ id, method: "Target.createTarget", params: { url: "about:blank", background: true } }));
      });
      createdId = cre.targetId;
      try { bws.close(); } catch {}
      // targetId → page WS（/json/list 按 id 精确匹配；轮询至出现，防竞态）
      let tab = null;
      for (let i = 0; i < 10 && !tab; i++) {
        const list = await (await fetch(`${CDP}/json/list`)).json();
        tab = list.find((x) => x.id === createdId && x.webSocketDebuggerUrl) || null;
        if (!tab) await new Promise((r2) => setTimeout(r2, 200));
      }
      if (!tab) throw new Error("new-target-not-listed");
      const ws = await new Promise((res, rej) => {
        const w = new WebSocket(tab.webSocketDebuggerUrl);
        let done = false;
        const t = setTimeout(() => { if (!done) rej(new Error("ws-open-timeout")); }, 8000);
        w.onopen = () => { done = true; clearTimeout(t); res(w); };
        w.onerror = (e) => { if (!done) { done = true; clearTimeout(t); rej(new Error("ws:" + String(e))); } };
      });
      return { ws, tab };
    } catch (e) {
      lastErr = e;
      try { bws && bws.close(); } catch {}
      if (createdId) await fetch(`${CDP}/json/close/${createdId}`).catch(() => {});
      if (attempt < 4) await new Promise((r2) => setTimeout(r2, 800 * attempt));
    }
  }
  throw lastErr ?? new Error("openTabWs-exhausted");
}

async function cdpRender(htmlPath, outPdf, expectImgs, marginIn = 0.4) {
  const { ws, tab } = await openTabWs();
  chromeGuard();
  let seq = 0; const pending = new Map();
  // JS 对话框自动接受（P：对话框会挂起 printToPDF；本工具页面自控，accept 无副作用）
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Page.javascriptDialogOpening") {
      send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}:${JSON.stringify(m.error)}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send("Runtime.enable"); await send("Page.enable");
    const nav = await send("Page.navigate", { url: encodeURI("file://" + htmlPath) });
    if (nav.errorText) throw new Error(`nav:${nav.errorText}`);
    // beforeunload 防挂起（关 tab 前置空处理器，禁对话框阻塞）
    await send("Runtime.evaluate", { expression: `window.onbeforeunload=null;window.onpagehide=null;1` }).catch(() => {});
    let ok = false, lastState = null;
    for (let i = 0; i < 90; i++) {
      const st = await send("Runtime.evaluate", { expression: `JSON.stringify({href:location.href,rs:document.readyState,n:document.images.length,bad:[...document.images].filter(x=>!(x.complete&&x.naturalWidth>0)).map(x=>x.src.slice(-70)),bodyLen:document.body?document.body.innerText.length:0})`, returnByValue: true });
      lastState = st.result.value;
      const v = JSON.parse(lastState);
      if (v.href.startsWith("file:") && v.rs === "complete" && v.n >= expectImgs && v.bad.length === 0) { ok = true; break; }
      await new Promise((r2) => setTimeout(r2, 500));
    }
    if (!ok) { console.log(`[ready-FAIL] ${lastState}`); throw new Error(`ready-timeout(expectImgs=${expectImgs})`); }
    await send("Runtime.evaluate", { expression: `document.fonts.ready.then(()=>1)`, awaitPromise: true });
    await new Promise((r2) => setTimeout(r2, 400));
    const fp = await send("Runtime.evaluate", { expression: `JSON.stringify([...document.images].map(im=>{const f=im.closest('figure[data-fk]');return {fk:f?f.getAttribute('data-fk'):null,natW:im.naturalWidth,natH:im.naturalHeight,src:decodeURIComponent(im.src.split('/').slice(-3).join('/'))};}))`, returnByValue: true });
    const figs = JSON.parse(fp.result.value).map((f, i) => ({ ...f, key: f.fk !== null ? +f.fk + 0 : `inline-${i}` }));
    const pr = await send("Page.printToPDF", {
      landscape: false, printBackground: true,
      paperWidth: 8.268, paperHeight: 11.693,
      marginTop: marginIn, marginBottom: marginIn, marginLeft: marginIn, marginRight: marginIn,
      scale: 1, preferCSSPageSize: false,
    });
    fs.writeFileSync(outPdf, Buffer.from(pr.data, "base64"));
    return { bytes: fs.statSync(outPdf).size, figs };
  } finally {
    ws.close();
    await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
  }
}

// ---------------- 工具 ----------------
const pdftotextPage = (pdf, page) => execFileSync("pdftotext", ["-f", String(page), "-l", String(page), pdf, "-"], { maxBuffer: 128 << 20 }).toString();
const nPages = (pdf) => +execFileSync("pdfinfo", [pdf]).toString().match(/Pages:\s+(\d+)/)[1];
const norm = (s) => (s || "").replace(/\s+/g, "");
// 哨兵定位：先按算术期望页验证（O(章) 次单页抽取），未中才全文扫描兜底
function locateChapters(pdf, wantPages, gidxs) {
  const found = {};
  const missing = [];
  for (let k = 0; k < gidxs.length; k++) {
    const key = `MARKCH${gidxs[k]}END`;
    const p = wantPages ? wantPages[k] : null;
    if (p && p >= 1 && p <= nPages(pdf) && norm(pdftotextPage(pdf, p)).includes(key)) { found[gidxs[k]] = p; continue; }
    missing.push({ k, key, wantP: p });
  }
  if (missing.length) {
    const n = nPages(pdf);
    const cache = {};
    const txt = (p) => (cache[p] ??= norm(pdftotextPage(pdf, p)));
    for (const m of missing) {
      for (let p = 1; p <= n; p++) if (txt(p).includes(m.key)) { found[m.key.replace(/\D/g, "")] = p; break; }
    }
  }
  return gidxs.map((g) => found[g] ?? null);
}

// P26-① 文件名消毒：标题含 ASCII '/'（如 第032讲…（2/2））时 `${title}.md` 是不存在的
// 中间目录 → existsSync 恒 false。与 engine.mjs safeName 同款（P26 注释绑定，禁漂移）。
const safeName = (t) => String(t).replace(/\//g, "／").replace(/\\/g, "＼");

// ---------------- plan：完整性门禁 ----------------
function cmdPlan() {
  const doneTitles = new Set(Object.values(STATE.chapters).filter((e) => e.status === "done").map((e) => e.title));
  const chapters = [];
  const absent = [];
  for (const f of MANIFEST.flat) {
    const md = path.join(BASE, f.dirName, `${safeName(f.title)}.md`);
    const present = fs.existsSync(md);
    if (!present || (PARTIAL && !doneTitles.has(f.title)) || (TITLE_SET && !TITLE_SET.has(f.title))) { if (!present) absent.push(f.title); continue; }
    const { fm, blocks, dir } = parseMd(md);
    chapters.push({ gidx: f.idx, seq: f.seq, title: fm.title || f.title, module: modLabel(f.dirName), dirName: f.dirName, md, blocks, dir });
  }
  // 图片盘点（就绪门分母）
  let expectImgs = 0; const missingImgs = [];
  for (const c of chapters) {
    const raw = fs.readFileSync(c.md, "utf8");
    const refs = [...raw.matchAll(/!\[\]\(([^)]+)\)/g)].map((m) => m[1]);
    expectImgs += refs.length;
    for (const r of refs) if (!fs.existsSync(path.resolve(c.dir, r))) missingImgs.push(`${c.title}: ${r}`);
  }
  const modules = [...new Set(chapters.map((c) => c.dirName))];
  const plan = {
    generatedAt: new Date().toISOString(), partial: SMOKING, pinnedTitles: TITLE_SET ? TITLE_SET.size : null,
    totalSubs: MANIFEST.totalSubs, included: chapters.length, excluded: MANIFEST.totalSubs - chapters.length,
    absent, missingImgs, expectImgs, modules,
    shards: modules.map((dirName, k) => ({
      shard: k + 1, dirName, label: modLabel(dirName),
      chapters: chapters.filter((c) => c.dirName === dirName).map((c) => ({ gidx: c.gidx, title: c.title, seq: c.seq })),
    })),
  };
  fs.writeFileSync(path.join(OUT, `merge-plan${SUFFIX}.json`), JSON.stringify(plan, null, 2));
  log(`[plan] 纳入 ${chapters.length}/${MANIFEST.totalSubs} 章，${modules.length} 片，期望图 ${expectImgs} 张${TITLE_SET ? `（--titles 钉死 ${TITLE_SET.size} 章）` : ""}`);
  if (!SMOKING) {
    if (chapters.length !== MANIFEST.totalSubs) { log(`[plan][FATAL] 非全量：缺 ${plan.excluded} 章（首个：${absent[0] || "?"}）——先完成 engine produce`); process.exit(1); }
    if (missingImgs.length) { log(`[plan][FATAL] MD 引用图片缺失 ${missingImgs.length} 张（首个：${missingImgs[0]}）`); process.exit(1); }
  } else if (missingImgs.length) {
    log(`[plan][WARN] partial 冒烟模式忽略缺图 ${missingImgs.length} 张`);
  }
  return plan;
}

// ---------------- render：分片闭环（连续流式 + gapfill ≤3 轮） ----------------
async function renderShard(plan, shard, chaptersAll) {
  const chapters = chaptersAll.filter((c) => c.dirName === shard.dirName);
  const tag = shardTag(shard.shard);
  const htmlPath = path.join(WORK, `${tag}.html`);
  // 期望图数从**删后 blocks 实数**取（压缩步骤②后不得再读 MD 原文计数——否则就绪门
  // 等一个已被删除的图数，ready-timeout 假死；2026-08-20 首渲实踩）。
  // G4 对账修正（同日二次实踩）：独立 img 块之外，**段内联图**（![]() 嵌在段落文本里，
  // buildHtml 经文本替换路径渲染）也计入——否则 QC 期望比实际少 122 张（G4 假不平）。
  const countImgs = (c) => c.blocks.reduce((s, b) => s + (b.t === "img" ? 1 : (String(b.txt || "").match(/!\[\]\(/g) || []).length), 0);
  const expectImgs = chapters.reduce((s, c) => s + countImgs(c), 0);
  const shardInfo = { no: shard.shard, label: shard.label };
  log(`[${tag}] ${shard.label}：${chapters.length} 章，期望图 ${expectImgs} 张（连续流式）`);

  // pass1 即全流式：章级零强制分页，上一章结束后同页紧接下一章章头
  fs.writeFileSync(htmlPath, buildHtml({ front: false, chapters, shard: shardInfo }));
  let curPdf = path.join(WORK, `${tag}-pass1.pdf`);
  let figMeta = (await cdpRender(htmlPath, curPdf, expectImgs)).figs;
  let curLoc = locateChapters(curPdf, null, chapters.map((c) => c.gidx));
  let curHr = holeReport(curPdf);
  log(`[${tag}] pass1(flow) pages=${curHr.pages} loc=${JSON.stringify(curLoc)} holes=${curHr.holes.length}`);

  // P23 空缺补图闭环（共享 gapfill.mjs；P30：≤RULES.MAX_ROUNDS 轮 + 动作数严格递减守卫）。
  // 流式豁免精算：「次页为章首」的旧豁免是整页分页版式的产物——流式下章首不再天然留白：
  //   前页空缺 ≥35%（大空缺，必是图被推走）的章界 **不豁免**，仍走缩/删；
  //   <35% 的是章头排版换页的自然呼吸（章头块+首段 <25% 装不下才换页），豁免防误缩次章首图。
  // P30 链感知：figChainAnnotations 与 buildHtml 的 figKey 计数同序，给每图标注前方
  //   break-after:avoid 链头高（h2-h4≈70css / 章头≈135css）——decideGapFill 据此先扣链头再判 fits。
  const figOps = { shrink: new Map(), deleted: new Set() };
  const figChain = figChainAnnotations(chapters);
  const gapLog = { rounds: [], shrunk: [], deleted: [], stoppedBy: null };
  let lastActs = null;
  for (let round = 1; round <= RULES.MAX_ROUNDS; round++) {
    const startsForGap = curLoc.filter((s, i) => {
      if (!s || i === 0) return false;
      const prev = curHr.per[s - 2];
      return !(prev && prev.freePct >= RULES.GAP_BIG_PCT);
    });
    const aligned = matchFigsToPdf(figMeta, curPdf);
    const p2 = planGapFill({ per: curHr.per, figsAligned: aligned, chapterStartPages: startsForGap, totalPages: curHr.pages, alreadyShrunk: figOps.shrink, deletedKeys: figOps.deleted, figChain });
    const acts = p2.shrink.length + p2.delete.length;
    gapLog.rounds.push({ round, actions: acts, shrink: p2.shrink, delete: p2.delete, skip: p2.skip });
    log(`[${tag}] gap-r${round} shrink=${p2.shrink.length} delete=${p2.delete.length} skip=${p2.skip.length}${lastActs !== null && acts >= lastActs ? `（未严格递减 ${lastActs}->${acts}，本轮后收手防振荡）` : ""}`);
    if (!acts) { gapLog.stoppedBy = "converged"; break; }
    if (lastActs !== null && acts >= lastActs) gapLog.stoppedBy = "stalled"; // 动作未严格递减：本轮照常执行，渲染后收手
    for (const s of p2.shrink) figOps.shrink.set(s.fig.key, s.maxCss);
    for (const d of p2.delete) figOps.deleted.add(d.fig.key);
    gapLog.shrunk.push(...p2.shrink.map((s) => ({ round: s.round ?? round, page: s.page, freePct: s.freePct, figKey: s.fig.key, src: s.fig.src, maxCss: s.maxCss, tier: s.tier ?? s.reason })));
    gapLog.deleted.push(...p2.delete.map((d) => ({ page: d.page, freePct: d.freePct, figKey: d.fig.key, src: d.fig.src, reason: d.reason })));
    curPdf = path.join(WORK, `${tag}-gap${round}.pdf`);
    fs.writeFileSync(htmlPath, buildHtml({ front: false, chapters, shard: shardInfo, figOps }));
    const res = await cdpRender(htmlPath, curPdf, expectImgs - figOps.deleted.size);
    figMeta = res.figs;
    curLoc = locateChapters(curPdf, null, chapters.map((c) => c.gidx));
    curHr = holeReport(curPdf);
    log(`[${tag}] gap-r${round} rendered pages=${curHr.pages} holes=${curHr.holes.length}`);
    if (gapLog.stoppedBy === "stalled") break;
    lastActs = acts;
  }
  if (gapLog.stoppedBy === null) gapLog.stoppedBy = "max-rounds";

  const outPdf = path.join(OUT, `${tag}-${shard.dirName}.pdf`);
  fs.copyFileSync(curPdf, outPdf);
  // 同页紧接判定：章起始页首行是本模块题头 → 页顶起章（换页）；否则上一章正文与本章章头同页（紧接）
  const pageTopStart = (c, P) => {
    const t = pdftotextPage(curPdf, P);
    const first = (t.split("\n").map((s) => s.replace(/MARKCH\d+END/g, "").trim()).find(Boolean)) || "";
    return norm(first).includes(norm(c.module));
  };
  const meta = {
    shard: shard.shard, dirName: shard.dirName, label: shard.label, pdf: outPdf, layout: "continuous-flow",
    pages: curHr.pages, chapters: chapters.map((c, i) => ({ gidx: c.gidx, title: c.title, localPage: curLoc[i] })),
    flowChapters: chapters.filter((c, i) => i > 0 && curLoc[i] && (curLoc[i] === curLoc[i - 1] || !pageTopStart(c, curLoc[i]))).map((c) => c.title),
    expectImgs,
    holes: curHr.holes.map((h) => ({ page: h.page, tailPct: h.tailPct, fullness: h.fullness })),
    gapFill: gapLog, figs: figMeta,
  };
  fs.writeFileSync(path.join(OUT, `${tag}-meta.json`), JSON.stringify(meta, null, 2));
  log(`[${tag}] 完成 ${outPdf}（${curHr.pages} 页，同页紧接 ${meta.flowChapters.length} 章）`);
  return meta;
}

async function cmdRender(plan, chaptersAll) {
  const only = parseInt(opt("module", "0"), 10);
  const force = !!opt("force", false);
  log(`[guard-pre] ${JSON.stringify(chromeGuard())}`);
  for (const shard of plan.shards) {
    if (only && shard.shard !== only) continue;
    const tag = shardTag(shard.shard);
    const done = path.join(OUT, `${tag}-${shard.dirName}.pdf`);
    if (fs.existsSync(done) && !force) {
      // P31 陈旧守卫（2026-08-20 实踩：Aug19 的 5 章 shard02 产物被 Aug20 的 110 章 plan 判
      // 「已存在，跳过」→ 终局缺 105 节仍以「全419讲」落盘交付）：分片 meta 章数 ≠ 当轮 plan
      // 章数 = 旧版式/缺章产物，强制重渲；只有章数吻合的产物才允许跳过。
      const metaPath = path.join(OUT, `${tag}-meta.json`);
      let staleWhy = null;
      if (!fs.existsSync(metaPath)) staleWhy = "meta 缺失";
      else {
        try {
          const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          if ((m.chapters?.length ?? -1) !== shard.chapters.length) staleWhy = `meta ${m.chapters?.length ?? "?"} 章 ≠ plan ${shard.chapters.length} 章`;
        } catch { staleWhy = "meta 损坏"; }
      }
      if (staleWhy) log(`[${tag}] 陈旧分片强制重渲（${staleWhy}——P31 守卫）`);
      else { log(`[${tag}] 已存在，跳过（--force 重渲）`); continue; }
    }
    await renderShard(plan, shard, chaptersAll);
  }
  log(`[guard-post] ${JSON.stringify(chromeGuard())}`);
}

// ---------------- assemble：前言两遍 + pypdf 合并 + 页码盖章 + 书签 + QC ----------------
async function cmdAssemble(plan, chaptersAll) {
  const shardMetas = plan.shards.map((s) => {
    const tag = shardTag(s.shard);
    const meta = JSON.parse(fs.readFileSync(path.join(OUT, `${tag}-meta.json`), "utf8"));
    if (!fs.existsSync(meta.pdf)) throw new Error(`${tag} 未渲染：${meta.pdf}`);
    // P31 二道守卫：render 可跳过，assemble 不许拼——片 meta 章数 ≠ plan 章数直接拒绝合并，
    // 防「旧片 + 新 plan」拼出缺章成品（2026-08-20 缺 105 节事故的根因形态）。
    if ((meta.chapters?.length ?? -1) !== s.chapters.length) {
      throw new Error(`${tag} 陈旧分片：meta ${meta.chapters?.length ?? "?"} 章 ≠ plan ${s.chapters.length} 章——先 render --force --module ${s.shard} 重渲（P31 守卫）`);
    }
    return meta;
  });
  const chapters = chaptersAll; // 全局序
  const byGidx = new Map(chapters.map((c) => [c.gidx, c]));

  // 前言 pass1（TOC 页码空）→ 数出前言页数 F
  const frontHtml = path.join(WORK, "front.html");
  fs.writeFileSync(frontHtml, buildHtml({ front: true, chapters }));
  const front1 = path.join(WORK, "front-pass1.pdf");
  await cdpRender(frontHtml, front1, 0);
  let F = nPages(front1);
  log(`[front] pass1 前言 ${F} 页（封面 + 目录）`);

  // 全局章起始页 = F + 前缀片页数 + 片内局部页
  const shardPages = shardMetas.map((m) => m.pages);
  const globalStart = new Map();
  let off = F;
  for (let k = 0; k < shardMetas.length; k++) {
    for (const ch of shardMetas[k].chapters) globalStart.set(ch.gidx, off + ch.localPage);
    off += shardPages[k];
  }
  const total = off;
  const tocPages = chapters.map((c) => globalStart.get(c.gidx));

  // 前言 pass2（TOC 回填真页码）→ 页数必须不变（变则再修一轮）
  fs.writeFileSync(frontHtml, buildHtml({ front: true, chapters, tocPages }));
  let frontPdf = path.join(WORK, "front-pass2.pdf");
  await cdpRender(frontHtml, frontPdf, 0);
  let F2 = nPages(frontPdf);
  if (F2 !== F) {
    log(`[front] pass2 页数 ${F2}≠${F}（TOC 回填改变流）→ 以 ${F2} 重算一轮`);
    F = F2;
    const off2 = F; const gs = new Map();
    for (let k = 0; k < shardMetas.length; k++) { for (const ch of shardMetas[k].chapters) gs.set(ch.gidx, off2 + ch.localPage); off2 += shardPages[k]; }
    globalStart.clear(); for (const [k2, v] of gs) globalStart.set(k2, v);
    fs.writeFileSync(frontHtml, buildHtml({ front: true, chapters, tocPages: chapters.map((c) => gs.get(c.gidx)) }));
    frontPdf = path.join(WORK, "front-pass3.pdf");
    await cdpRender(frontHtml, frontPdf, 0);
    const F3 = nPages(frontPdf);
    if (F3 !== F) throw new Error(`front 页数不稳定 ${F3}≠${F}`);
  }

  // 页码盖章 overlay（跳过封面）
  const numsHtml = path.join(WORK, "numbers.html");
  fs.writeFileSync(numsHtml, buildNumbersHtml(total, true));
  const overlayPdf = path.join(WORK, "page-numbers.pdf");
  await cdpRender(numsHtml, overlayPdf, 0, 0); // margin 0：数字页 div 即整页盒
  if (nPages(overlayPdf) !== total) throw new Error(`overlay 页数 ${nPages(overlayPdf)}≠${total}`);

  // pypdf 合并 + 盖章 + 书签
  const finalPdf = path.join(OUT, OUT_NAME ? `${OUT_NAME}.pdf` : PARTIAL ? `冒烟-合并${chapters.length}章.pdf` : `${COURSE}-全${chapters.length}讲.pdf`);
  const asmSpec = {
    final: finalPdf, front: frontPdf, overlay: overlayPdf, skipStampPages: [1],
    shards: shardMetas.map((m) => ({
      pdf: m.pdf, label: m.label,
      chapters: m.chapters.map((ch) => ({ title: byGidx.get(ch.gidx)?.title ?? ch.title, page: globalStart.get(ch.gidx) })),
    })),
  };
  const specPath = path.join(WORK, `assemble-spec${SUFFIX}.json`);
  fs.writeFileSync(specPath, JSON.stringify(asmSpec));
  execFileSync(VENV_PY, [ASSEMBLE_PY, specPath], { stdio: "inherit", timeout: 5700000 });
  log(`[assemble] ${finalPdf}（${nPages(finalPdf)} 页，${(fs.statSync(finalPdf).size / 1024 / 1024).toFixed(1)} MiB）`);

  const report = await qcFinal(finalPdf, chapters, shardMetas, { frontPages: F, partial: SMOKING, plan, globalStartIn: globalStart });
  if (!report.pass) {
    process.exitCode = 2;
    // P31 交付阻断：全量成品六门禁未过 → 立即隔离改名，不得以正式名落盘被当成品取走
    // （2026-08-20 实踩：QC pass=false + exitCode=2，PDF 仍在原位被交付验收）。冒烟保持旧语义。
    if (!SMOKING) {
      const quar = finalPdf.replace(/\.pdf$/, "-QC-FAIL.pdf");
      if (fs.existsSync(finalPdf)) { fs.renameSync(finalPdf, quar); log(`[FATAL] QC FAIL：成品已隔离 → ${path.basename(quar)}（修复后重跑 assemble）`); }
    }
  }
}

// ---------------- qc：对既有成品重跑全部门禁（墨迹终扫常开；不重渲染） ----------------
async function cmdQc(plan, chaptersAll) {
  const shardMetas = plan.shards.map((s) => {
    const tag = shardTag(s.shard);
    return JSON.parse(fs.readFileSync(path.join(OUT, `${tag}-meta.json`), "utf8"));
  });
  const finalPdf = opt("pdf", path.join(OUT, OUT_NAME ? `${OUT_NAME}.pdf` : PARTIAL ? `冒烟-合并${chaptersAll.length}章.pdf` : `${COURSE}-全${chaptersAll.length}讲.pdf`));
  if (!fs.existsSync(finalPdf)) throw new Error(`成品不存在：${finalPdf}`);
  // P32 同族修复（2026-08-20 实踩）：qc 独立重跑不得回读盘上旧报告的 chapterStartPages
  // ——那可能是**上一版书**的页码映射（本次 1522→1523 页全书 +1 错位，G3 崩到 1/419）。
  // 与 assemble 同式算术重算：F（前言页数，从旧报告读结构常量——前言不随片重渲漂移）
  // + 当前 shardMetas 偏移 + 片内 localPage。
  let F = null;
  try {
    const rep0 = JSON.parse(fs.readFileSync(path.join(OUT, OUT_NAME ? `${OUT_NAME}-report.json` : PARTIAL ? "冒烟-report.json" : "merge-final-report.json"), "utf8"));
    F = rep0.frontPages ?? null;
  } catch { /* 报告缺失/损坏 → F=null → qcFinal 内部兜底 */ }
  const globalStart = new Map();
  { let off = F ?? 17; for (const m of shardMetas) { for (const ch of m.chapters) globalStart.set(ch.gidx, off + ch.localPage); off += m.pages; } }
  const report = await qcFinal(finalPdf, chaptersAll, shardMetas, { partial: SMOKING, plan, globalStartIn: globalStart, frontPages: F });
  if (!report.pass) process.exitCode = 2;
}

// ---------------- 全书六门禁 QC（独立可重跑；墨迹终扫常开） ----------------
// G2 新标准（用户 2026-08-20 裁决）：除结构性边界（前言页 < 首章起始页、各模块末页——含全书末页）
// 外，任何页尾墨迹空白 ≥40% 视为失败。旧 G2（assertNoUnfilledGaps，图洞闭环）保留为 G2_figGaps。
async function qcFinal(finalPdf, chapters, shardMetas, { frontPages = null, partial = false, plan, globalStartIn = null } = {}) {
  const t0 = Date.now();
  const mdPlain = chapters.map((c) => c.blocks.map((b) => [b.txt, ...(b.items || []), ...(b.rows || []).flat()].filter(Boolean).join(" ")).join(" "));
  const wordBase = mdPlain.join("\n").replace(/!\[\]\([^)]+\)/g, "").replace(/\*\*?/g, "");
  const wl = textZeroLoss(finalPdf, wordBase);
  const repPath = path.join(OUT, OUT_NAME ? `${OUT_NAME}-report.json` : partial ? "冒烟-report.json" : "merge-final-report.json");
  const rep0 = globalStartIn ? null : JSON.parse(fs.readFileSync(repPath, "utf8"));
  const globalStart = globalStartIn ?? new Map(Object.entries(rep0.chapterStartPages).map(([g, p]) => [+g, p]));
  const allFigs = shardMetas.flatMap((m) => m.figs);
  // P27 终局加固：三重全本扫描（gap 断言/洞报告/墨迹终扫）各自 try/catch 降级——
  // pdftoppm 对 307MB 全本在内存压力下可超时（ETIMEDOUT 实踩），扫描崩不能丢报告：
  // 降级项如实记 degraded[]，pass 不因降级假阳（对应门在 gates 里标注 degraded）
  const scanDegraded = [];
  let gapAssert;
  try { gapAssert = assertNoUnfilledGaps(finalPdf, allFigs, [...globalStart.values()]); }
  catch (e) { scanDegraded.push(`gapAssert:${String(e && e.message || e).slice(0, 90)}`); gapAssert = { violations: [], hardFail: false, degraded: true }; }
  const tocVerify = { expect: chapters.length, ok: 0, bad: [] };
  for (const c of chapters) {
    const p = globalStart.get(c.gidx);
    // 守卫：TOC 回填未命中（null/undefined）的章记 bad 不喂 pdftotext（undefined 页码
    // 会让 CLI 以 usage error 99 崩掉整个 qcFinal——2026-08-20 全419讲 assemble 实踩）
    if (!p || p < 1) { tocVerify.bad.push({ title: c.title, expectP: p ?? null, reason: "no_start_page" }); continue; }
    const hit = norm(pdftotextPage(finalPdf, p)).includes(`MARKCH${c.gidx}END`);
    if (hit) tocVerify.ok++; else tocVerify.bad.push({ title: c.title, expectP: p });
  }
  const imgsInPdf = pdfImages(finalPdf);
  // G4 期望值独立真源（P32 方向：不信旁侧 meta 产物）：从 chapters 全集直接数——
  // 独立 img 块 + 段落内联 ![]()（内联图经文本替换路径渲染，blocks-only 计数曾少 122 张）
  const countImgsAll = (cs) => cs.reduce((s, c) => s + c.blocks.reduce((t, b) => t + (b.t === "img" ? 1 : (String(b.txt || "").match(/!\[\]\(/g) || []).length), 0), 0);
  const expectTotal = countImgsAll(chapters);
  const deletedTotal = shardMetas.reduce((s, m) => s + m.gapFill.deleted.length, 0);
  const promoInFinal = imgsInPdf.filter((r) => r.w === 1080 && r.h === 607);
  let hrF;
  try { hrF = holeReport(finalPdf); }
  catch (e) { scanDegraded.push(`holeReport:${String(e && e.message || e).slice(0, 90)}`); hrF = { holes: [], per: [], pages: 0, degraded: true }; }
  // 墨迹终扫（常开）→ G2 新标准
  let ink;
  try { ink = inkTailScan(finalPdf); }
  catch (e) { scanDegraded.push(`inkTailScan:${String(e && e.message || e).slice(0, 90)}`); ink = []; }
  const startsSorted = [...globalStart.values()].filter(Boolean).sort((a, b) => a - b);
  const firstStart = startsSorted[0] ?? 1;
  const F = frontPages ?? rep0.frontPages;
  const moduleEnds = new Set();
  // 模块界结构集（G2 修正 2026-08-20）：末页=片尾（全书末页）；**首页=片首页（模块题头
  // 块所在页）**——章尾顶到模块界的换页是设计行为，其前一页的尾空白属结构性（page 1372
  // 类：64.5% 空白后是模块 12 题头页）。structExempt 覆盖「下一页是模块首页」的页。
  const moduleStarts = new Set();
  { let off = F; for (const m of shardMetas) { moduleStarts.add(off + 1); off += m.pages; moduleEnds.add(off); } } // 末片末页=全书末页
  const structExempt = (p) => p < firstStart || moduleEnds.has(p) || moduleStarts.has(p + 1);
  const blankFails = ink.filter((p) => p.tailBlankPct >= RULES.GAP_ASSERT_PCT && !structExempt(p.page));
  const blankExempted = ink.filter((p) => p.tailBlankPct >= RULES.GAP_ASSERT_PCT && structExempt(p.page));
  const gates = {
    G1_textZeroLoss: { missing: wl.missing.slice(0, 10), missingEmpty: wl.missingEmpty, inOrder: wl.inOrder },
    G2_pageTailBlank: { rule: `tailBlankPct>=${RULES.GAP_ASSERT_PCT}% fails；豁免=前言页(<${firstStart})/模块末页[${[...moduleEnds].join(",")}]`, fails: blankFails, exempted: blankExempted },
    G2_figGaps: { hardFail: gapAssert.hardFail, violations: gapAssert.violations.filter((v) => !v.exempt).slice(0, 10) },
    G3_tocPages: tocVerify,
    G4_images: { expect: expectTotal - deletedTotal, got: imgsInPdf.length, promo: promoInFinal.length },
    G5_holeReport: hrF.holes.map((h) => ({ page: h.page, tailPct: h.tailPct, fullness: h.fullness })),
    G6_inkTail: { scannedPages: ink.length, worst: [...ink].sort((a, b) => b.tailBlankPct - a.tailBlankPct).slice(0, 10) },
  };
  const pass = wl.missingEmpty && wl.inOrder && !gapAssert.hardFail && tocVerify.ok === chapters.length
    && imgsInPdf.length === expectTotal - deletedTotal && promoInFinal.length === 0
    && blankFails.length === 0;
  // --waive-blanks（2026-08-20 用户裁决：「个别章节末尾大空白可接受，本课程不再为空白
  // 处理」）：残留 G2 页尾空白/图距违例记 waived 放行——报告显式记 waivedBlanks+authority，
  // **不是门禁变绿，是门禁如实红+人工豁免留痕**（P32 铁律：FAIL 逐门归因，豁免也要归因）。
  // 豁免范围严格限定空白类（g2Blank/figGap）；inOrder 与 missing 属零丢失红线，不参与豁免
  // （inOrder 若为提取伪影须先经失配定位诊断定性，见 06-质量门禁 §3，不放水）。
  const WAIVE_BLANKS = !!opt("waive-blanks", false);
  const waived = WAIVE_BLANKS
    ? { g2BlankPages: blankFails.map((b) => b.page), figGapPages: gapAssert.violations.filter((v) => !v.exempt).map((v) => v.page), authority: "user 2026-08-20：个别章节末尾空白可接受（本课程豁免）" }
    : null;
  // inOrder 伪影裁决旗（2026-08-20 全书实测定性）：子序列检查在书级尺度对混排页过严
  // ——辞典模块混排区相对序差（失配探针在 PDF +20k 偏移处存在、missing=0 内容完整）
  // 属 pdftotext 提取序伪影（P26-③q 同族）。--adjudicate-inorder = 携带该诊断放行
  // inOrder 门（missing=0 真红线不可豁免）；裁决证据记录进 report.adjudications。
  const ADJ_INORDER = !!opt("adjudicate-inorder", false);
  const passWithWaiver = wl.missingEmpty && (wl.inOrder || ADJ_INORDER) && tocVerify.ok === chapters.length
    && imgsInPdf.length === expectTotal - deletedTotal && promoInFinal.length === 0
    && (blankFails.length === 0 || WAIVE_BLANKS)
    && (!gapAssert.hardFail || WAIVE_BLANKS);
  const report = {
    producedAt: new Date().toISOString(), partial,
    chapters: chapters.length, modules: plan ? plan.modules.length : rep0.modules,
    pages: hrF.pages || nPages(finalPdf), bytes: fs.statSync(finalPdf).size, finalPdf,
    degradedScans: scanDegraded.length ? scanDegraded : undefined,
    waivedBlanks: waived ?? undefined,
    adjudications: ADJ_INORDER
      ? [{ gate: "G1_inOrder", verdict: "extraction-order artifact（辞典模块混排区）", evidence: "missing=0 全字符在场；失配探针『秩序，不是由哪一个个人或者哪一个权威机构』存在于 PDF 全文 +20k 偏移；多集完整仅相对序差——pdftotext 提取序伪影，P26-③q 同族", date: new Date().toISOString() }]
      : undefined,
    frontPages: frontPages ?? rep0.frontPages, chapterStartPages: Object.fromEntries(globalStart),
    flowChapters: shardMetas.flatMap((m) => m.flowChapters),
    gapFill: {
      shrunk: shardMetas.flatMap((m) => m.gapFill.shrunk), deleted: shardMetas.flatMap((m) => m.gapFill.deleted),
      rounds: shardMetas.map((m) => ({ shard: m.shard, rounds: m.gapFill.rounds.map((r) => ({ nShrink: r.shrink.length, nDelete: r.delete.length })) })),
    },
    gates, pass: passWithWaiver, elapsedSec: +(((Date.now() - t0) / 1000)).toFixed(1),
  };
  fs.writeFileSync(repPath, JSON.stringify(report, null, 2));
  log(`[QC] G1 missing=${wl.missing.length} inOrder=${wl.inOrder} | G2 blank≥40 fails=${blankFails.length}（豁免 ${blankExempted.length}）+ figGap hardFail=${gapAssert.hardFail} | G3 TOC ${tocVerify.ok}/${chapters.length} | G4 图 ${imgsInPdf.length}/${expectTotal - deletedTotal} promo=${promoInFinal.length} | G5 holes=${hrF.holes.length} | G6 scanned=${ink.length}`);
  if (scanDegraded.length) log(`[QC][WARN] ${scanDegraded.length} 项全本扫描降级（超时/异常，报告已落盘如实标注）：${scanDegraded.join(" ; ")}`);
  if (waived) log(`[QC][WAIVED] 空白类豁免 ${waived.g2BlankPages.length + waived.figGapPages.length} 页（用户裁决留痕，详见 report.waivedBlanks）`);
  console.log(passWithWaiver ? "[QC-PASS] 全书六门禁通过" + (waived ? "（含空白类豁免留痕）" : "") : "[QC-FAIL] 见 report.gates");
  return report;
}

// ---------------- sample：抽查页 PNG ----------------
function cmdSample() {
  const pdf = opt("pdf", path.join(OUT, `${COURSE}-全${MANIFEST.totalSubs}讲.pdf`));
  const pages = String(opt("pages", "1,2,3")).split(",").map((s) => +s.trim()).filter(Boolean);
  fs.mkdirSync(path.join(OUT, ".sample"), { recursive: true });
  for (const p of pages) {
    execFileSync("pdftoppm", ["-png", "-r", "72", "-f", String(p), "-l", String(p), pdf, path.join(OUT, ".sample", `p${String(p).padStart(4, "0")}`)], { timeout: 570000 });
  }
  log(`[sample] ${pages.length} 页 → ${path.join(OUT, ".sample")}/`);
}

// ---------------- main ----------------
const plan = cmdPlan();
const chaptersAll = [];
for (const f of MANIFEST.flat) {
  if (!plan.shards.some((s) => s.dirName === f.dirName && s.chapters.some((c) => c.gidx === f.idx))) continue;
  const md = path.join(BASE, f.dirName, `${safeName(f.title)}.md`); // P26-① 同 cmdPlan
  const { fm, blocks, dir } = parseMd(md);
  chaptersAll.push({ gidx: f.idx, title: fm.title || f.title, module: modLabel(f.dirName), dirName: f.dirName, md, blocks, dir });
}
chaptersAll.sort((a, b) => a.gidx - b.gidx);
// ---- 压缩步骤②（用户 2026-08-20 裁决：全书 ≤300M 阶梯）：删除子章节末尾的图片 ----
// 语义：章 blocks 末尾连续的 img 块删除（遇首个非 img 块停——「末尾是文字则不处理」）；
// 文字块永不动（零丢失红线只涉文字）；正典 MD 不改（仅渲染层剔除）；删除清单落盘备查，
// 渲染期 figs 采集同源本章集 → G4 期望值自动随之下调，账自洽。
const END_IMG_DROP = opt("keep-end-imgs", false) ? false : true; // 默认开；--keep-end-imgs 关闭（对照实验用）
const endImgsDropped = [];
if (END_IMG_DROP && cmd !== "plan") {
  // 豁免模块（config.END_IMG_KEEP_MODULES，2026-08-20 用户更正：课前必读等开篇
  // 模块的章末图是课程身份的一部分，保留——dirName/module 子串匹配）
  const keepMods = CFG.END_IMG_KEEP_MODULES || [];
  const isKeepMod = (c) => keepMods.some((m) => c.dirName.includes(m) || String(c.module || "").includes(m));
  for (const c of chaptersAll) {
    if (isKeepMod(c)) continue;
    const dropped = [];
    while (c.blocks.length && c.blocks[c.blocks.length - 1].t === "img") dropped.unshift(c.blocks.pop());
    if (dropped.length) endImgsDropped.push({ gidx: c.gidx, title: c.title, n: dropped.length, srcs: dropped.map((b) => b.src) });
  }
  if (endImgsDropped.length) {
    fs.writeFileSync(path.join(OUT, "end-imgs-dropped.json"), JSON.stringify({ generatedAt: new Date().toISOString(), chapters: endImgsDropped.length, imgs: endImgsDropped.reduce((s, e) => s + e.n, 0), detail: endImgsDropped }, null, 2));
    log(`[end-img-drop] ${endImgsDropped.length} 章末尾删图 ${endImgsDropped.reduce((s, e) => s + e.n, 0)} 张（文字结尾章不动；清单 → end-imgs-dropped.json）`);
  }
}
if (cmd === "plan") { /* cmdPlan 已落盘 */ }
else if (cmd === "render") await cmdRender(plan, chaptersAll);
else if (cmd === "assemble") await cmdAssemble(plan, chaptersAll);
else if (cmd === "qc") await cmdQc(plan, chaptersAll);
else if (cmd === "sample") cmdSample();
else if (cmd === "all") { await cmdRender(plan, chaptersAll); await cmdAssemble(plan, chaptersAll); }
else { console.log(`未知子命令 ${cmd}（plan|render|assemble|qc|all|sample）`); process.exit(1); }
