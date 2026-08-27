#!/usr/bin/env node
/**
 * engine.mjs — 得到课程 PDF 全量生产引擎（裁决 c：确定性脚本，零 LLM token）
 *
 * 依据：全量处理方案.md（架构师轮）+ v2 管线 3/3 章全绿（extract-v2.mjs 参数原样复用）
 *      + P7 慢滚合并枚举 + P16/P19 静默纪律 + P18 全量分母修正。
 *
 * 用法：
 *   node engine.mjs enumerate                     # 侧栏慢滚合并 → manifest.json（全量分母）
 *   node engine.mjs produce [--only a,b] [--limit N] [--retry] [--force]
 *   node engine.mjs status
 *
 * 硬门禁（每章，失败不落产物、state=failed 后继续下一章）：
 *   ①文字零丢失（pdftotext vs cleanup+课后思考删除态 innerText，字符多重集+保序，missing 必空）
 *   ②宣传图零出现（删前 M2∧M3∧M4 位置门控；出厂 pdfimages 无 1080×607）
 *   ③图操作前后 innerText 逐字节不变
 *   ④课后思考零残留（PDF 出现次数 == 基准残留次数，正常 both=0）
 *   ⑤MD 图片全本地化（下载失败记 failed 清单，MD 保底远程引用）
 * v3 增量（2026-08-19 用户令）：课后思考整段删除（div.article-header 文本恰匹配，段界=
 *   下一 header/figure/空 junk，div.tips 注释保留）+ 每章 .md + 模块 images/ 正典产物。
 * 静默：全程复用既有 tab；每章后 chromeGuard() PID 定向复隐。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  holeReport, promoInPdf, textZeroLoss, chromeGuard, PAGE_CSS, pdfImages,
} from "/Users/wangdong/Documents/Project/claude技能/lasso/.dedao-extract/analyze.mjs";
import { RULES, decideGapFill } from "/Users/wangdong/Documents/Project/claude技能/lasso/.dedao-extract/gapfill.mjs";

// —— 课程配置（2026-08-20 F1 整改）：课程相关常量唯一入口 = ./config.mjs，换课程只改该文件 ——
import { LASSO_ROOT, ENGINE, BASE, TARGET, CDP, PROMO_MD5S, SIKAO } from "./config.mjs";
const SCRATCH = path.join(ENGINE, "scratch");
const STATE_PATH = path.join(ENGINE, "state.json");
const MANIFEST_PATH = path.join(ENGINE, "manifest.json");
const PROD_STATE_PATH = path.join(BASE, ".production-state.json");
const CHAPTER_WATCHDOG_MS = 10 * 60 * 1000; // 单章硬上限
const SPA_RESET_EVERY = 25; // 每 N 章整页复位（SPA 内存增长保险）
const MAX_ATTEMPTS = 3;

fs.mkdirSync(SCRATCH, { recursive: true });

// ---------------- CLI ----------------
const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const opt = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] ?? true : d;
};
// PERF-T2：--worker k/K 并发分片（K=2 双进程，各带独立 lasso/上游实例）。有 --only 时
// 不做奇偶分片（--only 集即工作集，由 run-k2.mjs 均分）；worker 同时决定日志前缀 [Kk]、
// 独立日志文件、独立 server-stderr、章间 jitter、SPA 复位间隔 25→15。
const workerArg = opt("worker", null);
let workerK = null, workerN = 1;
if (workerArg) {
  const m = String(workerArg).match(/^(\d+)\/(\d+)$/);
  if (!m || +m[1] >= +m[2]) { console.log("[FATAL] --worker 须为 k/K 形如 0/2 且 k<K"); process.exit(1); }
  workerK = +m[1]; workerN = +m[2];
}
const KTAG = workerK != null ? `[K${workerK}] ` : "";

// ---------------- 日志 ----------------
const RUN_TS = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 17);
const LOG_PATH = path.join(ENGINE, "logs", `${RUN_TS}-${cmd}${workerK != null ? `-w${workerK}` : ""}.log`);
const logLines = [];
function note(m) {
  const l = `[${new Date().toISOString().slice(11, 19)}] ${KTAG}${m}`;
  console.log(l);
  logLines.push(l);
  fs.appendFileSync(LOG_PATH, l + "\n");
}
function atomicJson(p, o) {
  const t = p + ".tmp";
  fs.writeFileSync(t, JSON.stringify(o, null, 2));
  fs.renameSync(t, p);
}

// ---------------- 环境自检（宪法第 0 步） ----------------
async function envCheck() {
  try {
    const v = await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
    note(`[env] Chrome alive: ${v.Browser}`);
  } catch (e) {
    note(`[FATAL] Chrome 9226 不可达：${String(e).slice(0, 120)}`);
    process.exit(1);
  }
}

// ---------------- lasso MCP ----------------
const client = new Client({ name: "dedao-engine", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(ENGINE, `server-stderr${workerK != null ? `-w${workerK}` : ""}.log`))}`],
  cwd: LASSO_ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226", LASSO_CALLER_CAP_DEFAULT: "1000000" },  // P25: 引擎单 server 高频调用被 anonymous 100/60s 限流（192 章失败）——批量场景配额抬升
});
async function browse(action, options = {}, timeoutMs = 180000) {
  // P25-③ 瞬态重试：TUN 间歇 DNS 失败（ssrf_blocked:dns_failed:getaddrinfo ENOTFOUND，
  // 104 章连续阵亡）与上游 MCP 协议超时是可重试语义——章级 attempts<3 只跨批次生效，
  // 单次网络抖动即烧掉一次整章尝试。此处调用级重试至 3 次（2s/4s 退避），不改网络栈。
  const TRANSIENT_RE = /ssrf_blocked:dns_failed|McpError|timed out|ETIMEDOUT|ECONNRESET|fetch failed/i;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r = null;
    try {
      const res = await client.callTool({ name: "browse_logged_in", arguments: { url: TARGET, action, options } }, undefined, { timeout: timeoutMs });
      r = JSON.parse(res.content[0].text);
    } catch (e) {
      const s = String(e && e.message || e);
      if (attempt < 3 && TRANSIENT_RE.test(s)) { note(`[browse-retry] ${action} 第${attempt}次瞬态失败：${s.slice(0, 90)}`); await new Promise((x) => setTimeout(x, 2000 * attempt)); continue; }
      throw e;
    }
    const err = String(r?.error || "");
    if (r?.outcome && r.outcome !== "worked" && attempt < 3 && TRANSIENT_RE.test(err)) {
      note(`[browse-retry] ${action} 第${attempt}次瞬态 outcome=${r.outcome}：${err.slice(0, 90)}`);
      await new Promise((x) => setTimeout(x, 2000 * attempt));
      continue;
    }
    return r;
  }
}
async function ev(js, timeoutMs = 180000) {
  const r = await browse("evaluate", { js }, timeoutMs);
  if (r?.outcome && r.outcome !== "worked") throw new Error(`eval_upstream:${r.outcome}:${String(r.error).slice(0, 120)}`);
  const p = r?.data?.preview ?? "";
  if (!p) throw new Error("eval_empty_preview"); // P14 §7.3：undefined 必须 fatal
  try { return JSON.parse(p); } catch {
    // P25-② 大 JSON 被 lasso preview 4000 字符软上限截断（问答章 innerText JSON ≈5-6k 字符）
    // → eval_unparseable。lasso 同响应把完整 preview 落盘在 data.content_path（writeState
    // 全量 JSON），从盘上回读再解析；盘上也没有/仍解析失败才 fatal。
    const cp = r?.data?.content_path;
    if (cp && fs.existsSync(cp)) {
      try {
        const full = JSON.parse(fs.readFileSync(cp, "utf8")).preview;
        if (typeof full === "string") return JSON.parse(full);
      } catch { /* 落盘兜底失败 → 原错误路径 */ }
    }
    throw new Error(`eval_unparseable:${p.slice(0, 120)}`);
  }
}

// ---------------- 直连 CDP printToPDF（batch3/v2 同参数） ----------------
// P25-①白盒补：多 dedao tab 病理——lasso 会预建后台 tab，用户 Chrome 里也可能有既有
// dedao tab；旧实现 tabs.find(第一个 URL 匹配) 在 >1 tab 时打印错 tab（实测打出
// 探针 tab 的第13周问答 → text-loss+promo 假失败）。改为按当前章标题内容匹配选 tab，
// 且打印前校验选中 tab 标题——不匹配即 fail fast（不烧 QC 轮次）。
function cdpWs(tab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("ws-open-timeout")), 15000);
    ws.onopen = () => { clearTimeout(to); res(ws); };
    ws.onerror = (e) => { clearTimeout(to); rej(new Error(`ws:${String(e && e.message || e)}`)); };
  });
}
async function cdpTabTitle(tab) {
  // P25-①白盒补：双 tab 同章病理——探针 tab 与工作 tab 可能显示同一章（标题同），
  // 纯标题匹配无法消歧。加引擎足迹信号：仅工作 tab 带 window.__dzItJ（innerText 分片
  // 快照）/#dz-chrome-hide（chrome 隐藏样式表）——足迹+标题双命中优先。
  const ws = await cdpWs(tab);
  try {
    const r = await new Promise((res, rej) => {
      const id = 1;
      const to = setTimeout(() => rej(new Error("title-eval-timeout")), 10000);
      ws.onmessage = (evt) => {
        const m = JSON.parse(typeof evt.data === "string" ? evt.data : "");
        if (m.id === id) { clearTimeout(to); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
      };
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: "var e=document.querySelector('div.article-body-wrap .article-title');var t=e?String(e.textContent||'').trim():'';if(!t)t=String(document.title||'').split(' - 得到')[0].trim();JSON.stringify({title:t,foot:!!document.getElementById('dz-chrome-hide')})", returnByValue: true } }));
    });
    if (r?.exceptionDetails) return { title: "EXC:" + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "").slice(0, 60), foot: false };
    try { return JSON.parse(String(r?.result?.value || "{}")); } catch { return { title: "", foot: false }; }
  } finally { ws.close(); }
}
// PERF-T0⑤：大 JSON（innerText / MD blocks）走裸 CDP Runtime.evaluate——绕过 lasso preview
// 4000 截断（P25-② 分片方案的根治版）+ 省分片往返。tab 解析复用 P25 {title,foot} 双信号
// （多 worker 时 foot 可能多 tab，靠 title 消歧——分片保证两 worker 不同章）。
async function resolveWorkTab(expectTitle) {
  const tabs = (await (await fetch(`${CDP}/json/list`)).json())
    .filter((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"));
  if (!tabs.length) throw new Error("no-dedao-tab");
  if (tabs.length === 1) return tabs[0];
  let titleHit = null;
  for (const t of tabs) {
    try {
      const p = await cdpTabTitle(t);
      if (!titleMatches(p.title, expectTitle)) continue;
      if (p.foot) return t;
      titleHit = titleHit || t;
    } catch { /* 探测失败试下一个 */ }
  }
  return titleHit || tabs[0];
}
async function rawEv(js, expectTitle, timeoutMs = 60000) {
  const tab = await resolveWorkTab(expectTitle);
  const ws = await cdpWs(tab);
  try {
    const r = await new Promise((res, rej) => {
      const id = 1;
      const to = setTimeout(() => rej(new Error("rawEv-timeout")), timeoutMs);
      ws.onmessage = (evt) => {
        const m = JSON.parse(typeof evt.data === "string" ? evt.data : "");
        if (m.id === id) { clearTimeout(to); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
      };
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: `(() => {\n${js}\n})()`, awaitPromise: true, returnByValue: true } }));
    });
    if (r.exceptionDetails) throw new Error(`rawEv-exception:${String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 120)}`);
    const v = r?.result?.value;
    if (typeof v !== "string" || !v) throw new Error("rawEv-empty");
    return JSON.parse(v);
  } finally { ws.close(); }
}
async function cdpPrint(outName, expectTitle) {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const candidates = tabs.filter((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"));
  if (!candidates.length) throw new Error("no-dedao-tab");
  let tab = candidates[0];
  if (expectTitle && candidates.length > 1) {
    let titleHit = null;
    for (const t of candidates) {
      try {
        const p = await cdpTabTitle(t);
        if (!titleMatches(p.title, expectTitle)) continue;
        if (p.foot) { tab = t; break; } // 足迹+标题双命中 = 引擎工作 tab
        titleHit = titleHit || t;       // 仅标题命中（可能同章的他 tab）退而记之
      } catch { /* 该 tab 探测失败 → 试下一个 */ }
    }
    if (tab === candidates[0] && titleHit) tab = titleHit;
  }
  const ws = await cdpWs(tab);
  let seq = 0; const pending = new Map();
  ws.onmessage = (evt) => {
    const m = JSON.parse(typeof evt.data === "string" ? evt.data : "");
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    const to = setTimeout(() => { pending.delete(id); rej(new Error(`${method}:timeout`)); }, 120000);
    pending.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(`${method}:${JSON.stringify(m.error)}`)) : res(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    const r = await send("Page.printToPDF", {
      landscape: false, printBackground: true,
      paperWidth: 8.268, paperHeight: 11.693,
      marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
      scale: 1, preferCSSPageSize: false,
    });
    const buf = Buffer.from(r.data, "base64");
    if (expectTitle) {
      const p = await cdpTabTitle(tab);
      if (!titleMatches(p.title, expectTitle)) { note(`[print-debug] tabTitle=${JSON.stringify(p.title)} want=${JSON.stringify(expectTitle)} foot=${p.foot}`); throw new Error(`print_wrong_tab:${String(tab.url).slice(-24)}`); } // P25 fail fast：tab 漂移防御
    }
    const p = path.join(SCRATCH, outName);
    fs.writeFileSync(p, buf);
    return { ok: true, bytes: buf.length, path: p };
  } finally { ws.close(); }
}

// ---------------- 状态台账（断点续跑） ----------------
// PERF-T2：state 写入锁（K 进程读-改-写竞态防丢更新）。O_CREAT|O_EXCL 原子抢锁，
// 25-75ms 抖动重试，>30s 陈锁自动打破（崩溃残留）。临界区内**重读盘上最新态再合并**——
// 本进程内存副本可能落后于另一 worker 的写入。
const LOCK_PATH = path.join(ENGINE, "state.lock");
async function withStateLock(fn, tries = 400) {
  for (let i = 0; i < tries; i++) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      fs.closeSync(fd);
      try { return await fn(); } finally { fs.rmSync(LOCK_PATH, { force: true }); }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const stt = fs.statSync(LOCK_PATH);
        if (Date.now() - stt.mtimeMs > 30000) { fs.rmSync(LOCK_PATH, { force: true }); continue; } // 陈锁打破
      } catch { /* 锁刚被释放 → 直接重试 */ }
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  throw new Error("state_lock_timeout");
}
function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const st = { chapters: {}, created: new Date().toISOString() };
  // 从既有生产台账播种（3 章 v2 已完成）
  if (fs.existsSync(PROD_STATE_PATH)) {
    const prod = JSON.parse(fs.readFileSync(PROD_STATE_PATH, "utf8"));
    for (const [title, e] of Object.entries(prod.chapters || {})) {
      if (e.status === "done") st.chapters[title] = { title, chapterDir: e.chapterDir, status: "done", attempts: 1, seededFrom: "v2", sha256: e.sha256, qc: e.qc, pdfPath: e.pdfPath };
    }
    note(`[state] 播种 ${Object.keys(st.chapters).length} 章自 .production-state.json`);
  }
  atomicJson(STATE_PATH, st);
  return st;
}
async function persistEntry(st, entry) {
  // PERF-T2：单锁临界区内双台账合并写（state.json + .production-state.json）
  await withStateLock(() => {
    const disk = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    disk.chapters[entry.title] = { ...(disk.chapters[entry.title] || {}), ...entry };
    atomicJson(STATE_PATH, disk);
    st.chapters[entry.title] = disk.chapters[entry.title]; // 内存镜像同步
    let prod = fs.existsSync(PROD_STATE_PATH) ? JSON.parse(fs.readFileSync(PROD_STATE_PATH, "utf8")) : { chapters: {} };
    prod.chapters = prod.chapters || {};
    prod.chapters[entry.title] = {
      title: entry.title, chapterDir: entry.chapterDir, status: entry.status, attempts: entry.attempts,
      pdfPath: entry.pdfPath || null, sha256: entry.sha256 || null, qc: entry.qc || null,
      fatal: entry.fatal || undefined, producedBy: entry.producedBy || "engine 1.1 (v3)",
    };
    atomicJson(PROD_STATE_PATH, prod);
  });
}

// ---------------- manifest ----------------
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) { note("[FATAL] manifest.json 不存在——先跑 `node engine.mjs enumerate`"); process.exit(1); }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

// ---------------- P26-① 文件名消毒 ----------------
// 7 章 ENOENT copyfile 根因：标题含 ASCII '/'（第032讲…（2/2）——全角括号内的半角斜杠是
// 路径分隔符，dest 被解析为不存在的中间目录）。src/dir 均在，纯文件名问题（白盒手工复现
// copyFileSync 同错）。斜杠→全角／；反斜杠同理。merge.mjs cmdPlan 同款（P26 注释绑定，禁漂移）。
const safeName = (t) => String(t).replace(/\//g, "／").replace(/\\/g, "＼");

// ---------------- P26-③b chrome 隐藏清单（单一来源） ----------------
// 既有浮层 + P26 新增：笔记/留言区（div.my-comment / div.message-v2 在 cleanup 尾扫已删，
// 但 React 懒加载会 REMOUNT——白盒：基线尾部混入「笔记笔记」UI 对而打印不含 → order 断裂；
// iget-note-list/note-item-wrapper 为笔记条目容器）。三处消费：CLEANUP 内联+样式表、
// JS_IT_BASE、JS_MD_BUILD 尾部（经 CHROME_HIDE_CSS/CHROME_HIDE_JS 注入，禁三处手抄漂移）。
const CHROME_HIDE = [
  ".iget-header", "div.course-nav", "aside.iget-side-button", "div.course-nav-mask",
  ".iget-audio-player", ".article-note-editor", "aside.notes-wrap", ".iget-global-prompt",
  ".my-comment", ".message-v2", ".iget-note-list", ".note-item-wrapper",
];
const CHROME_HIDE_CSS = CHROME_HIDE.join(",") + "{display:none !important;} div.article-header{text-align:left !important;}";
// P26-③q：串讲页 header 对齐混排（钞票/选票 center、货币的价值 justify 同页并存）——
// 居中 header 打印落 x=283、左对齐落 x=43，pdftotext 按 x 流分组把居中词排到下一条左对齐
// header 之后（提取序伪影，视觉序/DOM 序本一致，白盒 -bbox y584<622 实证）。统一左对齐：
// 书排版正字 + 提取回 y 序。样式表注入（抗 React remount）。
const CHROME_HIDE_JS = `for(const sel of ${JSON.stringify(CHROME_HIDE)}){document.querySelectorAll(sel).forEach(e=>e.style.setProperty('display','none','important'));}`;
// P26-③k：内容区 UI 清扫（svg 图标文本/辞典字母徽章/交互动作标签/一键直达导航链接）。
// 关键病理：这些元素**懒挂载**——cleanup 时刻尚不在 DOM（辞典12 白盒：zhitda=[] 而
// 基线含 6 个），cleanup 扫一遍不够；须在每个捕获边界（IT_BASE/MD_BUILD 头部）幂等重扫，
// 基线/MD/打印三侧才一致。show 入参可选（cleanup 传 wrap 内 show，其余用默认查找）。
const JS_UI_SWEEP = (wrapSel) => `{
  const scope=${wrapSel ? `document.querySelector(${JSON.stringify(wrapSel)})` : `document.querySelector('div.article-body-wrap')`};
  if(scope){
    // 穿 shadow DOM 组合树收集（辞典12 白盒：一键直达链接挂在 shadow root 内，光 light DOM
    // querySelectorAll 永远扫不到，而 innerText 含 shadow 文本）
    const all=[];
    const walk=(r)=>{for(const el of r.querySelectorAll('*')){all.push(el);if(el.shadowRoot)walk(el.shadowRoot);}};
    walk(scope);
    for(const s of all){ if(s.tagName==='SVG'){
      const t=[...s.querySelectorAll('text,tspan,title')].map(e=>(e.textContent||'').trim()).filter(Boolean).join('');
      if(t)s.remove();
    }}
    for(const sp of all){ if(sp.tagName==='SPAN'&&/^[A-Za-z]$/.test((sp.textContent||'').trim())&&sp.parentElement&&sp.parentElement.classList&&sp.parentElement.classList.contains('article-header')){
      sp.remove();
    }}
    for(const el of all){ if(el.closest&&el.closest('svg'))continue;
      if(el.children&&el.children.length>1)continue;
      const t=(el.textContent||'').trim();
      if(!t)continue;
      if(/^(划重点|添加到笔记|划重点添加到笔记|收藏|点赞|投诉)$/.test(t)){el.remove();continue;}
      // P26-③p：视频课页播放器 UI（leaf 精确匹配：倍速/自动/全屏/静音/高清/纯时间戳）
      if(el.children&&el.children.length===0&&(/^(倍速|自动|全屏|静音|高清|标清|选集)$/.test(t)||/^\\d{1,2}:\\d{2}$/.test(t)||/^\\d{1,2}:\\d{2}\\/\\d{1,2}:\\d{2}$/.test(t))){el.remove();continue;}
      if(t.includes('您上次观看到')){let blk=el;while(blk&&blk!==scope&&!/^(P|DIV|SECTION|LI)$/.test(blk.tagName))blk=blk.parentElement;(blk&&blk!==scope?blk:el).remove();continue;} // 续播提示浮层
      if(t.startsWith('一键直达：')&&t.length<80){
        // 整块删（label span 与 <a>第N讲…</a> 常为兄弟——只删匹配叶会留孤儿链接文本，
        // 白盒：基线残留「第121讲丨收入的高低…」而打印无）。向上找最近块级祖先。
        let blk=el;
        while(blk&&blk!==scope&&!/^(P|DIV|SECTION|LI)$/.test(blk.tagName))blk=blk.parentElement;
        (blk&&blk!==scope?blk:el).remove();
        continue;
      }
    }
  }
}`;

// ---------------- P25-② 标题宽容匹配 ----------------
// 病理：enumerate 的 TITLE_CUT 在半角竖线处截断（`\s+\|`）→ manifest 收「第8周问答」，
// 而页面 article-title 渲染为「第8周问答 | 人们为什么送礼而不送钱？」→ 严格等值断言
// 必 title-mismatch。归一化：去空白 + 全角丨/｜ 统一为半角 |；匹配：全等 或
// 页面标题 === want + "|" + 剩余（竖线即侧栏截断边界）。switch 与 assert 同用一套。
const NORM_T = (s) => String(s || "").replace(/^\d{1,2}:\d{2}\s*/, "").replace(/[\s　]+/g, "").replace(/[丨｜]/g, "|"); // P26-③n：剥「12:27 」时长前缀（视频课章 manifest 带时长、页面标题无——此前引擎侧漏剥致 clicked-but-title ×12）
function titleMatches(pageTitle, want, allowPrefix = true) {
  const p = NORM_T(pageTitle), w = NORM_T(want);
  if (!w) return false;
  if (p === w) return true;
  return allowPrefix && p.startsWith(w + "|");
}

// ---------------- P28：JS 弹窗自动接受看门狗 + renderer 楔死自愈 ----------------
// 病理：脚本导航/刷新触发 beforeunload「离开此页面？」确认框 → renderer 阻塞等人工，
// 全部 evaluate 挂死（白盒实测：Runtime.evaluate 超时而 handleJavaScriptDialog 秒回
// "No dialog is showing"——弹窗归属浏览器层时页面级事件根本收不到）。导航意图本就是
// 引擎发起的，接受离开是正确选择。三层防御：
//   ① 事件层：每个 dedao page tab 常驻 WS + Page.enable，javascriptDialogOpening →
//      立即 handleJavaScriptDialog({accept:true})，记日志 dialog_auto_accepted；
//   ② 兜底层：每 15s 对常驻 WS 盲发 handleJavaScriptDialog（无对话框时报错无害，
//      正是「探测挂起对话框并接受」——覆盖事件丢失/他会话打开的弹窗）；
//   ③ 自愈层：章前 responsiveness 探测（evaluate 8s 超时 = renderer 楔死，白盒实测
//      连 Page.enable 都挂）→ 浏览器级 Target 换 tab（lasso P6 自愈会重新选中/预建）。
const dialogWatch = { stop: false, tabs: new Map(), seq: 0 };
function dialogWatchAttach(tab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: ++dialogWatch.seq, method: "Page.enable" }));
    dialogWatch.tabs.set(tab.id, ws);
  };
  ws.onmessage = (evt) => {
    const m = JSON.parse(typeof evt.data === "string" ? evt.data : "");
    if (m.method === "Page.javascriptDialogOpening") {
      note(`[P28] dialog_auto_accepted type=${m.params?.type} msg=${String(m.params?.message || "").slice(0, 40)} tab=${String(tab.url).slice(-16)}`);
      ws.send(JSON.stringify({ id: ++dialogWatch.seq, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
    }
  };
  ws.onclose = () => { dialogWatch.tabs.delete(tab.id); };
  ws.onerror = () => {};
}
async function dialogWatchLoop() {
  while (!dialogWatch.stop) {
    try {
      const tabs = (await (await fetch(`${CDP}/json/list`)).json()).filter((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn"));
      const want = new Set(tabs.map((t) => t.id));
      for (const [id, ws] of dialogWatch.tabs) if (!want.has(id)) { try { ws.close(); } catch {} dialogWatch.tabs.delete(id); }
      for (const t of tabs) if (!dialogWatch.tabs.has(t.id)) dialogWatchAttach(t);
    } catch { /* /json/list 抖动 → 下轮再试 */ }
    await new Promise((r) => setTimeout(r, 30000));
  }
}
async function dialogFallbackLoop() {
  while (!dialogWatch.stop) {
    await new Promise((r) => setTimeout(r, 15000));
    for (const [, ws] of dialogWatch.tabs) {
      if (ws.readyState !== 1) continue;
      try { ws.send(JSON.stringify({ id: ++dialogWatch.seq, method: "Page.handleJavaScriptDialog", params: { accept: true } })); } catch { /* 无对话框时报错响应，无人认领，无害 */ }
    }
  }
}
async function probeTabAlive(tab) {
  const ws = await cdpWs(tab);
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("renderer-stall")), 8000);
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 777) { clearTimeout(to); m.error ? rej(new Error(m.error.message)) : res(); } };
      ws.send(JSON.stringify({ id: 777, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } }));
    });
    return true;
  } finally { try { ws.close(); } catch {} }
}
async function swapStuckTab(stuck) {
  // P28-③修订：只关不建——原 createTarget(about:blank) 会留孤儿 blank tab（lasso 从不收养，
  // 自己另建），多轮后 tab 堆积；lasso P6 自愈（recoverNoPageSelected）会自动预建新 tab。
  const ver = await (await fetch(`${CDP}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++dialogWatch.seq;
    const to = setTimeout(() => rej(new Error(method + ":timeout")), 15000);
    const onm = (e) => { const m = JSON.parse(e.data); if (m.id === id) { clearTimeout(to); ws.removeEventListener("message", onm); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
    ws.addEventListener("message", onm);
    ws.send(JSON.stringify({ id, method, params }));
  });
  try { await send("Target.closeTarget", { targetId: stuck.id }); } catch { /* 已被关 */ }
  note(`[P28] 楔死 tab ${String(stuck.id).slice(0, 8)} 已关闭（lasso 自愈将预建新 tab）`);
  ws.close();
}
async function closeAllPageTabs() {
  // P26-③j：tab 清场——孤儿 dedao/blank page tab 堆积（历次崩溃/换 tab/lasso respawn 预建）
  // 会让 lasso respawn 后的页面选择在多 tab 间漂移（各相位跑不同 tab：title-mismatch/
  // print_wrong_tab/「卡上章」全系此根）。**保留一个 tab**（优先 dedao，无则建 blank）：
  // 全关会死锁——lasso 零页自愈被「Chrome 隐藏」门禁跳过（no_page_selfheal_not_visible
  // 白盒），上游启动时会自动选中留下的这个 tab。
  try {
    let tabs = (await (await fetch(`${CDP}/json/list`)).json()).filter((t) => t.type === "page");
    if (tabs.length === 0) {
      // 零 page tab（如上次全关崩在 boot）→ 建一个 blank 供上游启动时自动选中（lasso 零页
      // 自愈被隐藏门禁跳过，不能指望它自己建）
      const ver0 = await (await fetch(`${CDP}/json/version`)).json();
      const ws0 = new WebSocket(ver0.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = rej; });
      await new Promise((res) => { const id = ++dialogWatch.seq; const onm = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws0.removeEventListener("message", onm); res(m); } }; ws0.addEventListener("message", onm); ws0.send(JSON.stringify({ id, method: "Target.createTarget", params: { url: "about:blank", background: true } })); }); // P27 根治：background:true 零激活（前台档会 activate 抢用户焦点）
      ws0.close();
      note("[P28] 零 page tab → 已建 1 个 blank 供上游选中");
      return 0;
    }
    if (tabs.length <= 1) return 0;
    const keep = tabs.find((t) => t.url.startsWith("https://www.dedao.cn")) || tabs[0];
    const ver = await (await fetch(`${CDP}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++dialogWatch.seq;
      const onm = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener("message", onm); res(m); } };
      ws.addEventListener("message", onm);
      ws.send(JSON.stringify({ id, method, params }));
    });
    let n = 0;
    for (const t of tabs) { if (t.id !== keep.id) { await send("Target.closeTarget", { targetId: t.id }); n++; } }
    ws.close();
    note(`[P28] 启动清场：关闭 ${n} 个多余 page tab（保留 ${String(keep.url).slice(-18)}），回到单 tab 世界`);
    return n;
  } catch (e) { note(`[P28] 清场失败继续：${String(e && e.message || e).slice(0, 60)}`); return 0; }
}
async function ensurePagesResponsive() {
  try {
    const tabs = (await (await fetch(`${CDP}/json/list`)).json()).filter((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn"));
    for (const t of tabs) {
      try { await probeTabAlive(t); } catch (e) { await swapStuckTab(t); }
    }
  } catch (e) { note(`[P28] responsiveness 探测异常继续：${String(e && e.message || e).slice(0, 60)}`); }
}

// ---------------- DOM 片段（v2 验证配方原样 + switch-V3 深章节强化） ----------------
const JS_READY = `return JSON.stringify({rs:document.readyState,title:((document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim()||((document.title||'').replace(/\\s*-\\s*得到.*$/,'').trim())).slice(0,40),len:(document.body&&document.body.innerText||'').length});`; // P26-③n 视频课页回退

// PERF-T0①：稳定窗 3×400→2×250ms；滚动步进 1.5h→2.2h、驻留 150→90ms、底部 600→300ms、
// 回顶 400→200ms；**imgs-complete 快路径**——稳定窗后若全图已完备（懒加载无可触发）直接跳过
// 整段滚动（未完备才滚，保留懒加载触发兜底；预览/短章/缓存命中章零滚动成本）。
const JS_STABILIZE = `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const body=q('div.article-body-wrap .article-body');
  if(!body) return JSON.stringify({ok:false,err:'no-body'});
  let last=-1,stable=0;
  for(let i=0;i<40;i++){
    const len=(body.innerText||'').length+body.querySelectorAll('img').length*1000;
    if(len===last){stable++;if(stable>=2)break;}else{stable=0;last=len;}
    await new Promise(r=>setTimeout(r,250));
  }
  const snap=()=>[...document.querySelectorAll('div.article-body img')];
  const allDone=(ims)=>ims.every(im=>im.complete&&(im.naturalWidth>0||!im.src));
  let imgs=snap();
  let fastPath=allDone(imgs);
  if(!fastPath){
    const H=Math.max(document.scrollingElement?document.scrollingElement.scrollHeight:0,document.documentElement.scrollHeight);
    const step=Math.max(600,Math.floor(window.innerHeight*2.2));
    let n=0;
    for(let y=0;y<H&&n<90;y+=step,n++){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,90));}
    window.scrollTo(0,H);await new Promise(r=>setTimeout(r,300));
    for(let i=0;i<25;i++){
      imgs=snap();
      if(allDone(imgs))break;
      await new Promise(r=>setTimeout(r,300));
    }
    window.scrollTo(0,0);await new Promise(r=>setTimeout(r,200));
  }
  try{await document.fonts.ready;}catch(e){}
  return JSON.stringify({ok:true,fastPath,bodyLen:(body.innerText||'').length,imgs:imgs.length,imgsNotLoaded:imgs.filter(im=>!(im.complete&&im.naturalWidth>0)).length,docH:document.documentElement.scrollHeight});
})()`;

// PERF-T0②：ASSERT 并入 CLEANUP 头部（省 1 eval 往返）——先收集断言字段，硬断言不过则
// **不变异原样返回**（失败路径行为与分离版等价）；过后再执行 cleanup 变异。标题宽容匹配与
// JS_SWITCH_V3 同源（normWant/isWant 注入）。
const JS_CLEANUP_ASSERT = (wantTitle, allowPrefix = true) => `return (()=>{
  const q=(s,r)=>(r||document).querySelector(s);
  const qa=(s,r)=>[...(r||document).querySelectorAll(s)];
  const normWant=${JSON.stringify(NORM_T(wantTitle))};
  const allowPrefix=${JSON.stringify(allowPrefix === true)};
  const isWant=(t)=>{const p=String(t||'').replace(/[\\s　]+/g,'').replace(/[丨｜]/g,'|');return !!p&&(p===normWant||(allowPrefix&&p.startsWith(normWant+'|')));};
  const wrap=q('div.article > div.article-wrap > div.article-body-wrap');
  const titleEl=q('div.article-body-wrap .article-title');
  const body=wrap?wrap.querySelector('.article-body'):null;
  const asrt={
    url:location.href,
    title:((titleEl?(titleEl.textContent||'').trim():'')||((document.title||'').trim())).replace(/\\s*-\\s*得到.*$/,'').trim().slice(0,40), // P26-③n 视频课页：两侧路径统一剥后缀
    hasWrap:!!wrap, cover:!!(wrap&&wrap.querySelector('.article-cover')),
    ddAudio:wrap?wrap.querySelectorAll('.dd-audio').length:0,
    audioTags:wrap?wrap.querySelectorAll('audio').length:0,
    timeInfo:!!(wrap&&wrap.querySelector(':scope > div.article-time-info')),
    bodyLen:body?(body.innerText||'').length:0
  };
  const af=[];
  if(!asrt.hasWrap)af.push('no-wrap');
  if(!asrt.timeInfo)af.push('no-time-info');
  if(!asrt.cover)af.push('no-cover');
  if(!isWant(asrt.title))af.push('title-mismatch:'+asrt.title);
  if(af.some(f=>f.startsWith('no-wrap')||f.startsWith('no-time')||f.startsWith('title-'))){
    return JSON.stringify({ok:false,assert:asrt,assertFails:af});
  }
  const rep={ok:true,assert:asrt,assertFails:af,del:{},hid:{}};
  const pc=qa(':scope > div.pageControl',wrap);rep.del.pageControl=pc.length;pc.forEach(n=>n.remove());
  // P26-③b/e/f/i：内容区 UI 清扫统一走共享 JS_UI_SWEEP（懒挂载元素在各捕获边界重扫）
  ${JS_UI_SWEEP()}
  const c=q('.article-cover',wrap);rep.del.cover=!!c;if(c)c.remove();
  const da=qa('.dd-audio',wrap);rep.del.ddAudio=da.length;da.forEach(n=>n.remove());
  const au=qa('audio',wrap);rep.del.audioTags=au.length;au.forEach(n=>n.remove());
  const vd=qa('video',wrap);rep.del.videos=vd.length;vd.forEach(n=>n.remove()); // P26-③p：视频课页播放器实时时间码（03:30→03:31）致 it1≠it2 必炸——与 audio 同列删除
  const ti=q(':scope > div.article-time-info',wrap);rep.del.timeInfo=!!ti;
  if(ti){let n=ti,cnt=0;while(n){const nx=n.nextElementSibling;n.remove();n=nx;cnt++;}rep.del.tailSiblingsRemoved=cnt;}
  for(const sel of ${JSON.stringify(CHROME_HIDE)}){
    const els=qa(sel);els.forEach(e=>e.style.setProperty('display','none','important'));rep.hid[sel]=els.length;
  }
  // P25-①白盒补：React 重渲染会替换 course-nav 等节点（异步课程更新通知实测把内联
  // display:none 连节点一起换掉）→ 侧栏回流打印 PDF。内联隐藏只作用于当节点；注入样式表
  // 对重渲染后的新节点同样生效（P26-③b：笔记/留言区 remount 同治）。JS_SWITCH_V3 用侧栏
  // 前会摘除本样式表（display:none 容器 scrollTop 无效）。
  if(!document.getElementById('dz-chrome-hide')){
    const sh=document.createElement('style');sh.id='dz-chrome-hide';
    sh.textContent=${JSON.stringify(CHROME_HIDE_CSS)};
    document.head.appendChild(sh);rep.chromeHideStyle='injected';
  }
  const art=q('div.iget-articles > div.article');
  const r1=art?art.getBoundingClientRect():null;
  rep.rectBefore=r1?{x:Math.round(r1.x),y:Math.round(r1.y),w:Math.round(r1.width)}:null;
  if(art&&r1&&r1.x>60){
    const arts=q('div.iget-articles');
    if(arts){arts.style.setProperty('padding','0','important');arts.style.setProperty('margin','0','important');}
    art.style.setProperty('position','static','important');
    art.style.setProperty('left','auto','important');
    art.style.setProperty('margin','0','important');
    art.style.setProperty('transform','none','important');
    document.body.style.setProperty('margin','0','important');
  }
  rep.docHBefore=document.documentElement.scrollHeight;
  for(const el of [document.documentElement,document.body,q('div.iget-pc'),q('div.iget-articles'),art,q('div.article > div.article-wrap'),wrap]){
    if(el){el.style.setProperty('height','auto','important');el.style.setProperty('min-height','0','important');}
  }
  const chainEls=[wrap];
  let node=wrap;
  for(let d=0;d<12&&node;d++){
    const kids=[...node.children].filter(k=>{
      const cs=getComputedStyle(k);
      return cs.display!=='none'&&cs.position!=='fixed'&&cs.position!=='absolute';
    });
    if(kids.length===0)break;
    node=kids[kids.length-1];
    chainEls.push(node);
  }
  rep.tailChain=chainEls.map(e=>e.tagName.toLowerCase()+'.'+(typeof e.className==='string'?e.className.trim().split(/\\s+/)[0]:'').slice(0,24));
  chainEls.forEach(e=>{e.style.setProperty('margin-bottom','0','important');e.style.setProperty('padding-bottom','0','important');});
  rep.docHAfter=document.documentElement.scrollHeight;
  rep.residual={cover:qa('.article-cover').length,ddAudio:qa('.dd-audio').length,timeInfo:qa('.article-time-info').length,myComment:qa('.my-comment').length,messageV2:qa('.message-v2').length};
  return JSON.stringify(rep);
})()`;

// ===== v3①：课后思考整段删除（删前断言审计 + 位置门控一体；s9-sikao.json 3 章白盒） =====
// PERF-T0②③：并入宣传图尾部审计（原独立 JS_PROMO_AUDIT 的 M2/M3/M4 + srcAbs；页内
// fetch(src) 的 fetchBytes 无消费者已删——md5 由 Node 侧一次性下载）。审计在删除后做，
// 恰为 promo 门控所需的真实终态（课后思考段已除，M4 更准）。
const JS_SIKAO_DEL = `return (()=>{
  const body=document.querySelector('div.article-body-wrap .article-body');
  const show=body?(body.querySelector('.editor-show')||body):null;
  if(!show) return JSON.stringify({err:'no-show'});
  const audit=(()=>{
    const sh=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
    if(!sh) return {err:'no-show'};
    const figs=[...sh.querySelectorAll('figure')];
    const last=figs[figs.length-1];
    if(!last) return {figCount:0,decision:'no-figure'};
    const img=last.querySelector('img');
    const src=img?(img.currentSrc||img.src||''):null;
    const after=[...last.parentElement.children].slice([...last.parentElement.children].indexOf(last)+1);
    const afterTxt=after.map(n=>(n.innerText||'').trim().replace(/\\s+/g,' ').slice(0,30)).filter(Boolean);
    const m2=img&&img.naturalWidth===1080&&img.naturalHeight===607;
    const m3=src?/2017022\\d{12,}\\.(jpg|png)/.test(src):false;
    const m4=afterTxt.length===0;
    // P26-②：非末位宣传图——白盒第074讲：末图是另一张 PNG 而 1080×607 经典 promo 藏在
    // 正文中段（8 章 promo-present 全此形态）。收集全部 1080×607 候选交引擎 md5 裁决。
    const promoCands=figs.map((f,i)=>{
      const im=f.querySelector('img');
      if(!im||!(im.naturalWidth===1080&&im.naturalHeight===607)) return null;
      return {i,src:im.currentSrc||im.src||''};
    }).filter(Boolean);
    // P26-③m：视频课页（模块12）的 promo 是非 figure 裸 img——figure 扫描漏掉；全 img 收集
    const seen=new Set(promoCands.map(c=>c.src));
    [...sh.querySelectorAll('img')].forEach((im,k)=>{
      const s=im.currentSrc||im.src||'';
      if(!s||seen.has(s))return;
      if(im.naturalWidth===1080&&im.naturalHeight===607){seen.add(s);promoCands.push({i:'bare-'+k,src:s});}
    });
    return {figCount:figs.length,lastSrc:src?src.split('/').pop():null,srcAbs:src,lastNat:img?img.naturalWidth+'x'+img.naturalHeight:null,M2:!!m2,M3:m3,M4:m4,afterSummary:afterTxt,decision:(m2&&m3&&m4)?'drop':'keep-watch',promoCands};
  })();
  const kids=[...show.children];
  const isHeader=(el)=>el&&el.tagName==='DIV'&&el.classList&&el.classList.contains('article-header');
  const headers=kids.filter(isHeader);
  const target=headers.find(h=>(h.textContent||'').trim()===${JSON.stringify(SIKAO)});
  const rep={found:!!target,headerCount:headers.length,
    headersText:headers.map(h=>(h.textContent||'').trim().slice(0,16)),
    phraseCount:(show.innerText||'').split(${JSON.stringify(SIKAO)}).length-1};
  if(!target){rep.audit=audit;return JSON.stringify(rep);}
  rep.headerIndex=kids.indexOf(target);
  rep.otherHits=[...show.querySelectorAll('*')].filter(el=>{
    if(el===target||target.contains(el)||el.contains(target))return false;
    return el.childElementCount===0&&(el.textContent||'').includes(${JSON.stringify(SIKAO)});
  }).map(el=>el.tagName.toLowerCase()+'.'+(typeof el.className==='string'?el.className.trim().split(/\\s+/)[0]:''));
  const delInfo=[];const delEls=[];const keptTips=[];let stopReason='end';
  let sib=target.nextElementSibling;
  while(sib){
    if(isHeader(sib)){stopReason='next-header';break;}
    if(sib.tagName==='FIGURE'){stopReason='figure';break;}
    const t=(sib.innerText||'').trim();
    if(!t&&!sib.querySelector('img')){stopReason='junk';break;}
    if(sib.tagName==='DIV'&&sib.classList&&sib.classList.contains('tips')){
      keptTips.push(t.slice(0,60));sib=sib.nextElementSibling;continue;
    }
    delInfo.push({tag:sib.tagName.toLowerCase(),
      cls:(typeof sib.className==='string'?sib.className.trim().split(/\\s+/).slice(0,2).join('.'):''),
      txt:t.replace(/\\s+/g,' ').slice(0,90),chars:t.replace(/\\s+/g,'').length,h:Math.round(sib.getBoundingClientRect().height)});
    delEls.push(sib);
    sib=sib.nextElementSibling;
  }
  rep.stopReason=stopReason;rep.deleted=delInfo;rep.keptTips=keptTips;
  rep.deletedChars=delInfo.reduce((s,d)=>s+d.chars,0);
  rep.deletedBlocks=delInfo.length;
  delEls.forEach(n=>n.remove());
  target.remove();
  rep.phraseCountAfter=(show.innerText||'').split(${JSON.stringify(SIKAO)}).length-1;
  // P26-③d：删除后复点 otherHits——原 otherHits 在删除前统计，「课后思考」若出现在被删
  // 随段里会先计入后被删 → phraseCountAfter 与之必失配（第031讲 0vsOtherHits1 白盒）。
  rep.otherHitsAfter=[...show.querySelectorAll('*')].filter(el=>el.childElementCount===0&&(el.textContent||'').includes(${JSON.stringify(SIKAO)})).map(el=>el.tagName.toLowerCase()+'.'+(typeof el.className==='string'?el.className.trim().split(/\\s+/)[0]:''));
  rep.docHAfter=document.documentElement.scrollHeight;
  rep.audit=audit;
  return JSON.stringify(rep);
})()`;

// ===== v3②：清理后 DOM → 结构化块（MD 正典源；可见性门对齐 innerText/print 语义） =====
const JS_MD_BUILD = `return (()=>{
  const body=document.querySelector('div.article-body-wrap .article-body');
  const show=body?(body.querySelector('.editor-show')||body):null;
  if(!show) return JSON.stringify({err:'no-show'});
  const imgs=[];
  const pushImg=(im)=>{const s=im?(im.currentSrc||im.src||''):'';if(!s)return '';const i=imgs.findIndex(x=>x===s);const k=i>=0?i:imgs.push(s)-1;return '{{img:'+k+'}}';};
  const inline=(el)=>{
    let out='';
    for(const n of el.childNodes){
      if(n.nodeType===3){out+=n.textContent;}
      else if(n.nodeType===1){
        const tg=n.tagName.toLowerCase();
        if(tg==='br'){out+='\\n';}
        else if(tg==='strong'||tg==='b'){const s=inline(n);if(s.trim())out+='**'+s+'**';}
        else if(tg==='em'||tg==='i'){const s=inline(n);if(s.trim())out+='*'+s+'*';}
        else if(tg==='img'){out+=pushImg(n);}
        else{out+=inline(n);}
      }
    }
    return out;
  };
  const blocks=[];const unknown={};
  for(const c of [...show.children]){
    const cs=getComputedStyle(c);
    if(cs.display==='none') continue;
    if(cs.position==='fixed'||cs.position==='absolute') continue;
    const tg=c.tagName.toLowerCase();
    const cls=(typeof c.className==='string'&&c.classList)?Array.from(c.classList):[];
    if(tg==='div'&&cls.includes('article-header')){
      blocks.push({t:'h',lvl:2,txt:(c.textContent||'').trim()});
    } else if(/^h[1-6]$/.test(tg)){
      blocks.push({t:'h',lvl:+tg[1],txt:(c.textContent||'').trim()});
    } else if(tg==='p'){
      const md=inline(c).trim();
      if(md) blocks.push({t:'p',md});
    } else if(tg==='ol'||tg==='ul'){
      const items=[...c.children].filter(li=>li.tagName==='LI').map(li=>inline(li).trim()).filter(Boolean);
      if(items.length) blocks.push({t:tg,items});
    } else if(tg==='figure'){
      const img=c.querySelector('img');
      const cap=c.querySelector('figcaption');
      if(img){blocks.push({t:'img',ref:pushImg(img),cap:cap?(cap.textContent||'').trim():null,chunked:c.hasAttribute('data-dz-chunked')});}
    } else if((tg==='div'&&cls.includes('tips'))||tg==='blockquote'){
      const md=inline(c).trim();
      if(md) blocks.push({t:'quote',md});
    } else if(tg==='table'){
      const rows=[...c.querySelectorAll('tr')].map(tr=>[...tr.children].map(td=>inline(td).trim()));
      if(rows.length) blocks.push({t:'table',rows});
    } else {
      const md=inline(c).trim();
      if(md){blocks.push({t:'p',md});unknown[tg+(cls[0]?'.'+cls[0]:'')]=(unknown[tg+(cls[0]?'.'+cls[0]:'')]||0)+1;}
    }
  }
  const titleEl=document.querySelector('div.article-body-wrap .article-title');
  // PERF-T0②④：it2 不变量基线并入本 eval 尾部（原独立 INNERTEXT2 采样）；
  // P25-①白盒补 + P26-③b 笔记/留言区 remount：读取前幂等复隐 chrome + 样式表再注入；
  // P26-③k：捕获边界重扫懒挂载 UI（与 JS_IT_BASE 同一清扫，保 it1==it2 双侧一致）。
  ${JS_UI_SWEEP()}
  ${CHROME_HIDE_JS}
  if(!document.getElementById('dz-chrome-hide')){
    const sh=document.createElement('style');sh.id='dz-chrome-hide';
    sh.textContent=${JSON.stringify(CHROME_HIDE_CSS)};
    document.head.appendChild(sh);
  }
  const wrapEl=document.querySelector('div.article > div.article-wrap > div.article-body-wrap');
  const it2=(wrapEl?wrapEl.innerText||'':'');
  return JSON.stringify({blocks,imgs,unknown,title:(titleEl?(titleEl.textContent||'').trim():''),it2});
})()`;

// PERF-T0⑤：innerText 基线走裸 CDP 单次全量回传（原 lasso 通道需 OPEN+1900字符分片——
// 4000 截断的绕行版；rawEv 无截断直收全文）。捕获前幂等复隐 chrome + 样式表再注入（P25）。
const JS_IT_BASE = `return (()=>{
  ${JS_UI_SWEEP()} // P26-③k：捕获边界重扫（懒挂载 UI：一键直达/徽章/动作标签/svg 文本）
  ${CHROME_HIDE_JS}
  if(!document.getElementById('dz-chrome-hide')){
    const sh=document.createElement('style');sh.id='dz-chrome-hide';
    sh.textContent=${JSON.stringify(CHROME_HIDE_CSS)};
    document.head.appendChild(sh);
  }
  const wrap=document.querySelector('div.article > div.article-wrap > div.article-body-wrap');
  const rawT=(wrap?wrap.innerText||'':'');
  let uiHits=[]; // P26-③b 诊断（尾部「笔记」类 UI 文本元素链）
  if(/笔记$/.test(rawT.replace(/\s+/g,''))){
    for(const el of (wrap?wrap.querySelectorAll('*'):[])){
      if(el.childElementCount>0)continue;
      if((el.textContent||'').trim()!=='笔记')continue;
      let chain=[];let n=el;for(let i=0;i<9&&n;i++){chain.push(n.tagName.toLowerCase()+(typeof n.className==='string'&&n.className?'.'+n.className.trim().split(/\\s+/).slice(0,2).join('.'):''));n=n.parentElement;}
      uiHits.push(chain.join(' < '));
    }
  }
  // P26-③k 诊断：基线仍含一键直达时回传组合树节点链（定位挂载点：light/shadow/位置）
  let dbgHits=[];
  if(rawT.includes('一键直达：第121')){
    const show2=document.querySelector('div.article-body-wrap');
    const walk=(r,shadow)=>{for(const el of r.querySelectorAll('*')){
      if(el.shadowRoot)walk(el.shadowRoot,true);
      if(el.children.length>0)return;
      const t=(el.textContent||'');
      if(t.includes('一键直达：第121')){
        const chain=[];let n=el;for(let i=0;i<8&&n;i++){chain.push((n.host?'#shadow>':'')+(n.tagName||'?').toLowerCase()+(typeof n.className==='string'&&n.className?'.'+n.className.trim().split(/\\s+/).slice(0,2).join('.'):''));n=n.parentElement||n.host;}
        dbgHits.push(chain.join(' < '));
      }
    }};
    if(show2){walk(show2,false);dbgHits=dbgHits.slice(0,3);}
  }
  return JSON.stringify({t:rawT,uiHits,dbgHits});
})()`;

const JS_FIGS = `return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const wrapTop=(()=>{let e=show,y=0;while(e){y+=e.offsetTop;e=e.offsetParent;}return y;})();
  const PAGE=${PAGE_CSS};
  const figs=[...show.querySelectorAll('figure')].map((f,i)=>{
    const img=f.querySelector('img');
    const r=f.getBoundingClientRect();
    const ir=img?img.getBoundingClientRect():null;
    const rel=Math.round(r.top+window.scrollY)-wrapTop;
    const pg=Math.floor(rel/PAGE);
    return {i,src:img?(img.currentSrc||img.src||'').split('/').pop():null,srcAbs:img?(img.currentSrc||img.src||''):null,
      nat:img?img.naturalWidth+'x'+img.naturalHeight:null,natW:img?img.naturalWidth:0,natH:img?img.naturalHeight:0,
      chunked:f.hasAttribute('data-dz-chunked'),
      figH:Math.round(r.height),imgH:ir?Math.round(ir.height):0,mh:img?(img.style.maxHeight||null):null,rel,pg};
  });
  return JSON.stringify({PAGE,figs,docH:document.documentElement.scrollHeight});
})()`;

// P25-①：宣传图删除判据 M3（文件名日期前缀 2017022*）对同图再上传误报 keep——
// promo 与内容图同用 umiwi 数字命名，课程方分批重传同一张宣传图（md5 恒 7127ed…），
// 文件名日期前缀漂移（201703…/201704…）→ M3=false → 不删 → QC promo-present（48 章）。
// 判据改内容寻址：promoAudit 落 srcAbs → 引擎侧 fetch+md5（已有逻辑）→ 与 PROMO_MD5
// 全等才放行删除；M3 降级为 md5 取数失败时的降级通道。M2(1080x607)∧M4(尾部无文) 保留。
const JS_FIX_SCREEN = (promoSrcs) => `return (async()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const rep={dropped:[],shrunk:[],skipped:[],chunked:[]};
  const wrapTop=(()=>{let e=show,y=0;while(e){y+=e.offsetTop;e=e.offsetParent;}return y;})();
  const PAGE=${PAGE_CSS};
  // P26-②：md5 全等集（引擎侧对全部 1080×607 候选取 md5 后传入）——非末位 promo 一并删；
  // 末位再保留 M2∧M4∧M3 文件名降级通道（md5 取数失败时的兜底）。
  const promoSet=new Set(${JSON.stringify(promoSrcs || [])});
  for(const im of [...show.querySelectorAll('img')]){
    const s=im?(im.currentSrc||im.src||''):null;
    if(s&&promoSet.has(s)){
      const f=im.closest('figure');
      if(f&&!(f.innerText||'').trim()){rep.dropped.push({src:s.split('/').pop(),by:'md5-any'});f.remove();}
      else{rep.dropped.push({src:s.split('/').pop(),by:'md5-bare-img'});im.remove();} // P26-③m：裸 img promo / 带文 figure——只删图
    }
  }
  let figs=[...show.querySelectorAll('figure')];
  const last=figs[figs.length-1];
  if(last){
    const img=last.querySelector('img');
    const src=img?(img.currentSrc||img.src||''):null;
    const after=[...last.parentElement.children].slice([...last.parentElement.children].indexOf(last)+1);
    const afterTxt=after.map(n=>(n.innerText||'').trim().replace(/\\s+/g,' ').slice(0,30)).filter(Boolean);
    const m2=img&&img.naturalWidth===1080&&img.naturalHeight===607;
    const m3=src?/2017022\\d{12,}\\.(jpg|png)/.test(src):false;
    const m4=afterTxt.length===0;
    if(m2&&m4&&m3){rep.dropped.push({src:src.split('/').pop(),nat:img.naturalWidth+'x'+img.naturalHeight,by:'m3-last'});last.remove();figs.pop();}
    else if(!(m2&&m3&&m4))rep.skipped.push({why:'last-fig-not-promo',m2:!!m2,m3,m4,src:src?src.split('/').pop():null,afterSummary:afterTxt});
  }
  for(const f of [...show.querySelectorAll('figure')]){
    const img=f.querySelector('img'); if(!img) continue;
    const r=f.getBoundingClientRect();
    const rel=Math.round(r.top+window.scrollY)-wrapTop;
    const pg=Math.floor(rel/PAGE);
    const rem=PAGE-(rel-pg*PAGE);
    if(r.height<=rem) continue;
    if(r.height<=PAGE*0.85){
      const mh=Math.max(120,Math.floor(rem)-14);
      img.style.setProperty('max-height',mh+'px','important');
      img.style.setProperty('width','auto','important');
      rep.shrunk.push({src:(img.currentSrc||img.src).split('/').pop(),from:Math.round(r.height),to:mh,rem:Math.round(rem)});
    } else {
      const src=img.currentSrc||img.src;
      const W=img.getBoundingClientRect().width, H=img.getBoundingClientRect().height;
      const c=88, n=Math.ceil(H/c);
      const frag=document.createDocumentFragment();
      for(let k=0;k<n;k++){
        const d=document.createElement('div');
        const hh=Math.min(c,H-k*c);
        d.style.cssText='height:'+hh+'px;overflow:hidden;position:relative;margin:0;padding:0;font-size:0;line-height:0;';
        const im=document.createElement('img');
        im.src=src;
        im.style.cssText='position:absolute;top:'+(-k*c)+'px;left:0;width:'+Math.round(W)+'px;height:auto;max-height:none;display:block;';
        d.appendChild(im);
        frag.appendChild(d);
      }
      // P26-③：条带化只替换 img，**保留 figcaption 等其余子节点且不改变相对顺序**——旧版
      // f.innerHTML='' 连图注清掉必炸不变量；插到 firstChild 则把「图前内容」挤到条带后
      // 改变 innerText 字节序（新书首发 chunked=1 白盒）。插回首个被删 img 的原位。
      {
        const firstImg=f.querySelector('img');
        const anchor=firstImg?firstImg.nextSibling:f.firstChild;
        f.querySelectorAll('img').forEach(im=>im.remove());
        f.insertBefore(frag,anchor);
      }
      f.setAttribute('data-dz-chunked',String(c));
      f.style.setProperty('break-inside','auto','important');
      const t0=Date.now();
      while(Date.now()-t0<8000){
        const ims=[...f.querySelectorAll('img')];
        if(ims.every(im=>im.complete&&im.naturalWidth>0))break;
        await new Promise(r2=>setTimeout(r2,200));
      }
      rep.chunked.push({src:src.split('/').pop(),from:Math.round(H),strips:n,chunkPx:c});
    }
  }
  if(!document.getElementById('dz-v2-hy')){
    const st=document.createElement('style');st.id='dz-v2-hy';
    st.textContent='p{orphans:3;widows:3;}';
    document.head.appendChild(st);rep.hygiene='orphans-widows';
  }
  rep.docHAfter=document.documentElement.scrollHeight;
  return JSON.stringify(rep);
})()`;

const JS_FIX_PRINT = (targets) => `return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const rep={applied:[],missed:[]};
  const figs=[...show.querySelectorAll('figure')];
  for(const t of ${JSON.stringify(targets)}){
    const f=figs[t.idx];
    if(!f){rep.missed.push({...t,why:'no-fig'});continue;}
    const img=f.querySelector('img');
    if(!img){rep.missed.push({...t,why:'no-img'});continue;}
    img.style.setProperty('max-height',Math.round(t.mh)+'px','important');
    img.style.setProperty('width','auto','important');
    rep.applied.push({idx:t.idx,src:(img.currentSrc||img.src).split('/').pop(),mh:Math.round(t.mh)});
  }
  rep.docHAfter=document.documentElement.scrollHeight;
  return JSON.stringify(rep);
})()`;

// P25-② 标题宽容匹配：isWant 归一化（去空白+丨/｜→|）后全等或（allowPrefix 时）竖线前缀
// 匹配——「第8周问答」want vs 页面「第8周问答 | 副题」此前永不等值 → clickAndAwait 20s 超时。
// allowPrefix=false（want 是他章标题严格前缀，如「加餐」vs「加餐丨大学没有围墙」）只允许全等，
// 防错章假阳性。liMatch 先精确（enumerate 同款 TITLE_CUT 解析）后前缀。
const JS_SWITCH_V3 = (want, allowPrefix = true) => `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const want=${JSON.stringify(want)};
  const normWant=${JSON.stringify(NORM_T(want))};
  const allowPrefix=${JSON.stringify(allowPrefix === true)};
  const isWant=(t)=>{const p=String(t||'').replace(/[\\s　]+/g,'').replace(/[丨｜]/g,'|');return !!p&&(p===normWant||(allowPrefix&&p.startsWith(normWant+'|')));};
  const titleOf=()=>{const e=q('div.article-body-wrap .article-title');const t=e?(e.textContent||'').trim():'';return t||((document.title||'').replace(/\\s*-\\s*得到.*$/,'').trim());}; // P26-③n：视频课页 .article-title 为空——回退 document.title
  const curT=titleOf();
  if(isWant(curT)){return JSON.stringify({mode:'already',title:curT,url:location.href});}
  const nav=q('div.course-nav');
  if(nav&&nav.style.display==='none'){nav.style.removeProperty('display');}
  const dzch=document.getElementById('dz-chrome-hide');if(dzch){dzch.remove();} // P25-①白盒补：摘除样式表隐藏，恢复侧栏可滚
  const ps=q('div.course-nav div.ps');
  if(!ps){return JSON.stringify({mode:'no-sidebar',curTitle:curT});}
  const norm=(t)=>(t||'').trim().replace(/\\s+/g,' ');
  const CUT=/\\s+\\d+分\\d+秒|\\s+\\d+人学过|\\s+\\|/;
  const parseLi=(t)=>{const n=norm(t);const m=n.split(CUT)[0];return m||n;};
  const lis=()=>[...document.querySelectorAll('div.course-nav ul.course-module>li')];
  const liMatch=()=>{
    const all=lis();
    const exact=all.find(li=>parseLi(li.textContent)===want);
    if(exact) return exact;
    return all.find(li=>norm(li.textContent).startsWith(want));
  };
  const clickAndAwait=async(li)=>{
    li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    for(const w of [400,600,1000,2000,4000,8000]){ // P26-③n：渐进等待——节流下 6 次封顶（400ms 循环被 1/s 节流拖成 200s+ 超时白盒）
      await new Promise(r=>setTimeout(r,w));
      if(isWant(titleOf())){return true;}
    }
    return false;
  };
  let li=liMatch();
  if(li){const ok=await clickAndAwait(li);if(ok)return JSON.stringify({mode:'clicked',from:'viewport',url:location.href});}
  const startAt=ps.scrollTop;
  const step=Math.max(180,Math.floor(ps.clientHeight*0.6));
  let maxH=ps.scrollHeight, newY=startAt, noNew=0;
  const tLoop=Date.now();
  for(let round=0;round<2;round++){
    if(Date.now()-tLoop>45000){break;} // P26-③n：墙钟预算（节流下步进等待会拖死）
    const from=round===0?startAt:0;
    const to=round===0?Math.max(maxH,startAt+100000):startAt;
    for(let y=from;y<=to;y+=step){
      ps.scrollTop=y;
      await new Promise(r=>setTimeout(r,320));
      maxH=Math.max(maxH,ps.scrollHeight);
      li=liMatch();
      if(li){
        const ok=await clickAndAwait(li);
        if(ok)return JSON.stringify({mode:'clicked',from:'scroll:'+Math.round(y),url:location.href});
        li=null;
      }
      noNew++;
      if(noNew>400)break;
    }
  }
  ps.scrollTop=0;
  return JSON.stringify({mode:'notfound',curTitle:titleOf(),scrollH:maxH,url:location.href});
})()`;

// ---------------- DOM↔PDF figure 对齐（v2 原样） ----------------
function alignFigures(figs, pdf) {
  const rows = pdfImages(pdf).sort((a, b) => a.page - b.page);
  const out = figs.map((f) => ({ ...f, actualPage: null, printImgH: null }));
  const match = (f, r) => f.natW === r.w && f.natH === r.h;
  let di = 0;
  for (const r of rows) {
    if (di < out.length && match(out[di], r)) {
      out[di].actualPage = r.page;
      out[di].printImgH = Math.round((r.h / r.yppi) * 96);
      di++;
      continue;
    }
    const k = out.findIndex((f, j) => j >= di && match(f, r));
    if (k === -1) continue;
    di = k;
    out[di].actualPage = r.page;
    out[di].printImgH = Math.round((r.h / r.yppi) * 96);
    di++;
  }
  return out;
}
// P23 同源接入：缩图/删图裁决改由共享规则模块 gapfill.mjs 决定（与终局合并渲染器
// render-merge-b.mjs 同一实现，禁两套漂移）。两级：big（freePct≥35%）缩图下限 200px、
// 缩不进删图；cosmetic（12-35%）下限 120px 只缩不删（engine v2 传承灵敏度）。
function targetsForHoles(holes, aligned) {
  const targets = [];
  for (const h of holes) {
    const holeCss = (h.tailPt * 96) / 72;
    const cand = aligned.filter((f) => !f.chunked && f.actualPage === h.page + 1 && f.printImgH > holeCss * 0.5);
    if (!cand.length) { targets.push({ holePage: h.page, holeCss: Math.round(holeCss), unfixable: "no-figure-on-next-page" }); continue; }
    const t = cand[0];
    // P24 输入对齐：契约输入 = holeReport freePt/freePct（加性保守模型，与 planGapFill 同源）；
    // 此前误传 tailPt/tailPct（纯文本尾距，忽略页内图 → 乐观偏置，engine 与合并渲染器漂移）。
    const d = decideGapFill({ freePt: h.freePt, freePct: h.freePct, printHCss: t.printImgH });
    if (d.action === "shrink") {
      targets.push({ holePage: h.page, holeCss: Math.round(holeCss), idx: t.i, src: t.src, fromPrintH: t.printImgH, mh: d.maxCss, rule: `gapfill/${d.tier}` });
    } else {
      targets.push({ holePage: h.page, holeCss: Math.round(holeCss), unfixable: `${d.action}:${d.reason}`, targetIdx: t.i, decision: d });
    }
  }
  return targets;
}
// P23 删除档执行器：只删「无文字」的 figure（figcaption/内文有字 → 跳过，保护 innerText 不变量）
const JS_DEL_FIGS = (targets) => `return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const rep={removed:[],skipped:[]};
  const figs=[...show.querySelectorAll('figure')];
  for(const t of ${JSON.stringify(targets)}){
    const f=figs[t.idx];
    if(!f){rep.skipped.push({...t,why:'no-fig'});continue;}
    if((f.innerText||'').trim()){rep.skipped.push({...t,why:'fig-has-text'});continue;}
    rep.removed.push({idx:t.idx,src:(f.querySelector('img')?(f.querySelector('img').currentSrc||f.querySelector('img').src:'').split('/').pop():null),reason:t.decision&&t.decision.reason});
    f.remove();
  }
  rep.docHAfter=document.documentElement.scrollHeight;
  return JSON.stringify(rep);
})()`;

// ---------------- 导航/就绪 ----------------
// PERF-T0⑥：chromeGuard 异步版（execFile 回调链，不阻塞主循环；语义与 analyze.mjs 同步版
// 一致——PID 定向，仅可见时复隐；幂等可重叠）。启动时的同步守卫保留（批前一次性）。
function chromeGuardAsync() {
  execFile("zsh", ["-c", "lsof -nP -iTCP:9226 -sTCP:LISTEN | awk 'NR>1{print $2}' | sort -u | head -1"], (err, stdout) => {
    if (err) return;
    const pid = String(stdout).trim();
    if (!pid || !/^\d+$/.test(pid)) return;
    execFile("osascript", ["-e", `tell application "System Events" to get visible of (first process whose unix id is ${pid})`], (e2, out) => {
      if (e2 || String(out).trim() !== "true") return;
      execFile("osascript", ["-e", `tell application "System Events" to set visible of (first process whose unix id is ${pid}) to false`], (e3) => {
        note(e3 ? `[chrome-guard] async 复隐失败 ${String(e3).slice(0, 60)}` : "[chrome-guard] async 复隐");
      });
    });
  });
}
async function navigateOnce() {
  const nav = await browse("navigate", {});
  if (nav.outcome !== "worked") throw new Error(`navigate:${nav.outcome}`);
  let ready = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    try { ready = await ev(JS_READY, 30000); } catch { continue; }
    if (ready?.rs === "complete" && (ready?.len ?? 0) > 800 && ready?.title) break;
  }
  if (!ready?.title) throw new Error("article-title 未出现（登录态或页面异常）");
  note(`[ready] ${ready.title}`);
  return ready;
}

// ---------------- MD 渲染 + 图片落地（v3②） ----------------
function renderMd(head, blocks, imgs, imgMap) {
  const ref = (k) => {
    const src = imgs[k];
    const local = imgMap.get(src);
    return `![](${local ? local.rel : src})`;
  };
  const expand = (md) => md.replace(/\{\{img:(\d+)\}\}/g, (_, k) => ref(+k));
  const L = [];
  L.push("---");
  L.push(`title: ${head.title}`);
  L.push(`module: ${head.module}`);
  if (head.url) L.push(`source: ${head.url}`);
  L.push(`producedAt: ${head.producedAt}`);
  L.push("pipeline: engine v3（cleanup + 课后思考整段删除 + 宣传图位置门控删除 + 分页适配）");
  L.push("---", "");
  L.push(`# ${head.title}`, "");
  for (const b of blocks) {
    if (b.t === "h") { L.push(`${"#".repeat(Math.min(6, Math.max(2, b.lvl)))} ${b.txt}`, ""); }
    else if (b.t === "p") { L.push(expand(b.md), ""); }
    else if (b.t === "ol") { b.items.forEach((it, i) => L.push(`${i + 1}. ${expand(it)}`)); L.push(""); }
    else if (b.t === "ul") { b.items.forEach((it) => L.push(`- ${expand(it)}`)); L.push(""); }
    else if (b.t === "img") { L.push(expand(b.ref) + (b.cap ? `\n\n${b.cap}` : ""), ""); }
    else if (b.t === "quote") { expand(b.md).split("\n").forEach((ln) => L.push(`> ${ln}`)); L.push(""); }
    else if (b.t === "table") {
      if (b.rows.length) {
        const nCol = Math.max(...b.rows.map((r) => r.length));
        b.rows.forEach((r, i) => {
          const cells = [...r, ...Array(Math.max(0, nCol - r.length)).fill("")];
          L.push(`| ${cells.join(" | ")} |`);
          if (i === 0) L.push(`|${Array(nCol).fill(" --- ").join("|")}|`);
        });
        L.push("");
      }
    }
  }
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function downloadImages(imgs, outDir, tag, meta) {
  fs.mkdirSync(path.join(outDir, "images"), { recursive: true });
  const imgMap = new Map();
  const report = { total: imgs.length, downloaded: 0, reused: 0, collision: 0, failed: [] };
  // PERF-T0⑥：串行 for-await → 并发 4（图多章收益更大；JS 单线程下计数器无撕裂，失败照旧进清单）
  let cursor = 0;
  const dlOne = async () => {
    while (cursor < imgs.length) {
      const src = imgs[cursor++];
      try {
        const base = src.split("/").pop().replace(/[?#].*$/, "");
        let rel = `images/${base}`;
        let abs = path.join(outDir, rel);
        const buf = Buffer.from(await (await fetch(src, { signal: AbortSignal.timeout(30000) })).arrayBuffer());
        const h = createHash("md5").update(buf).digest("hex");
        if (fs.existsSync(abs)) {
          const ex = createHash("md5").update(fs.readFileSync(abs)).digest("hex");
          if (ex === h) { report.reused++; imgMap.set(src, { rel, md5: h }); continue; }
          rel = `images/${tag}-${base}`; abs = path.join(outDir, rel);
          report.collision++;
          if (fs.existsSync(abs)) { imgMap.set(src, { rel, md5: createHash("md5").update(fs.readFileSync(abs)).digest("hex") }); continue; }
        }
        fs.writeFileSync(abs, buf);
        report.downloaded++;
        imgMap.set(src, { rel, md5: h });
      } catch (e) { report.failed.push({ src, err: String(e).slice(0, 80) }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, imgs.length)) }, dlOne));
  meta.images = report;
  return imgMap;
}

// ---------------- 单章生产 ----------------
// ---------------- P26-③n 零 timer 切换（引擎侧驱动） ----------------
// 页内片段全部同步单语句；等待都在 Node 侧。evIn 是 zev（围栏版 ev）。
const JS_SW_TITLE = `return JSON.stringify({t:(((document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim()||((document.title||'').trim())).replace(/\\s*-\\s*得到.*$/,'').trim()),u:location.href});`; // P26-③n：两路径统一剥后缀
const JS_SW_STEP = (want) => `return (()=>{
  const q=(s)=>document.querySelector(s);
  const want=${JSON.stringify(want)};
  const normWant=${JSON.stringify(NORM_T(want))};
  const isWant=(t)=>{const p=String(t||'').replace(/^[0-9]{1,2}:[0-9]{2}\\s*/,'').replace(/[\\s　]+/g,'').replace(/[丨｜]/g,'|');return !!p&&(p===normWant||p.startsWith(normWant+'|'));};
  const titleOf=()=>{const e=q('div.article-body-wrap .article-title');const t=e?(e.textContent||'').trim():'';return t||((document.title||'').replace(/\\s*-\\s*得到.*$/,'').trim());};
  const nav=q('div.course-nav');
  if(nav&&nav.style.display==='none'){nav.style.removeProperty('display');}
  const sh=document.getElementById('dz-chrome-hide');if(sh){sh.remove();}
  const ps=q('div.course-nav div.ps');
  if(!ps)return JSON.stringify({err:'no-sidebar',t:titleOf()});
  const norm=(t)=>(t||'').trim().replace(/\\s+/g,' ');
  const CUT=/\\s+\\d+分\\d+秒|\\s+\\d+人学过|\\s+\\|/;
  const parseLi=(t)=>{const n=norm(t);const m=n.split(CUT)[0];return m||n;};
  const all=()=>[...document.querySelectorAll('div.course-nav ul.course-module>li')];
  const find=()=>all().find(li=>parseLi(li.textContent)===want)||all().find(li=>norm(li.textContent).startsWith(want));
  let li=find();
  if(li){li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));return JSON.stringify({clicked:1,t:titleOf(),u:location.href});}
  return JSON.stringify({clicked:0,maxH:ps.scrollHeight,curT:titleOf(),top:ps.scrollTop});
})()`;
const JS_SW_SCROLL = (y) => `return (()=>{const ps=document.querySelector('div.course-nav div.ps');if(!ps)return JSON.stringify({err:'no-ps'});ps.scrollTop=${y};return JSON.stringify({top:ps.scrollTop,maxH:ps.scrollHeight});})()`;
async function switchVia(evIn, want, allowPrefix = true, budgetMs = 90000) {
  const t0 = Date.now();
  // 0) 已在本章？
  const cur = await evIn(JS_SW_TITLE, 30000);
  const isW = (t) => titleMatches(t, want, allowPrefix);
  if (isW(cur.t)) return { mode: "already", from: null, url: cur.u };
  // 1) 侧栏滚动搜索（引擎侧步进；步长≈0.6 视口，先快扫后精扫一轮）
  for (let round = 0; round < 2 && Date.now() - t0 < budgetMs; round++) {
    await evIn(JS_SW_SCROLL(0), 30000);
    let maxH = 0, noGrow = 0;
    const step = 700;
    // 虚拟列表 scrollHeight 随滚动渐进增长（初始 ≈ 视口高），固定大范围遍历 + 停滞检测
    for (let y = 0; y < 200000 && Date.now() - t0 < budgetMs; y += step) {
      const rs = await evIn(JS_SW_SCROLL(y), 30000);
      if (rs.maxH && rs.maxH > maxH) { maxH = rs.maxH; noGrow = 0; } else noGrow++;
      await new Promise((r) => setTimeout(r, 200));
      const r = await evIn(JS_SW_STEP(want), 30000);
      if (r.err) return { mode: r.err, curTitle: r.t };
      if (r.maxH && r.maxH > maxH) { maxH = r.maxH; noGrow = 0; }
      if (r.clicked) {
        // 引擎侧轮询标题（页内零等待）
        for (let i = 0; i < 40; i++) { // P26-③n：视频课页加载慢，轮询窗 30s
          await new Promise((r2) => setTimeout(r2, 750));
          const t = await evIn(JS_SW_TITLE, 30000);
          if (isW(t.t)) return { mode: "clicked", from: `scroll:${y}`, url: t.u };
          if (Date.now() - t0 > budgetMs + 30000) break;
        }
        const tEnd = await evIn(JS_SW_TITLE, 30000);
        return { mode: "clicked-but-title", curTitle: tEnd.t, url: tEnd.u }; // P26-③n：带回末次实测标题
      }
      if (y > maxH + 3000 && noGrow > 8) break; // 已到底且无增长
    }
  }
  const fin = await evIn(JS_SW_TITLE, 30000);
  return { mode: "notfound", curTitle: fin.t, url: fin.u };
}

async function produceChapter(flat, st, fence = { dead: false }) {
  // P26-③k 僵尸章围栏：watchdog/MCP 超时被 Promise.race 拒绝后本函数仍在跑（僵尸），其
  // 后续 eval 与下一章相位交叠 → print_wrong_tab/innerText_changed/「卡上章」连坐（终轮
  // 白盒：直播回顾 MCP 超时章后的加餐系列全毁）。所有远端调用过围栏：章被宣告死亡后
  // 僵尸的下一个调用即刻抛错，配合失败后整页 reload（清在途脚本文档）双保险。
  const zev = (...a) => { if (fence.dead) throw new Error("zombie_fenced"); return ev(...a); };
  const zrawEv = (...a) => { if (fence.dead) throw new Error("zombie_fenced"); return rawEv(...a); };
  const zcdpPrint = (...a) => { if (fence.dead) throw new Error("zombie_fenced"); return cdpPrint(...a); };
  const a = { ...flat, expectAudio: /^第\d+讲/.test(flat.title) };
  const tag = `e${String(flat.idx).padStart(4, "0")}`;
  const meta = { ...a, phases: {}, droppedImages: [], iterations: [], attempts: (st.chapters[a.title]?.attempts || 0) + 1 };
  const allowPrefix = !a.titleAmbiguous; // P25-② 前缀歧义章（如「加餐」）只允许全等匹配

  // P26-③n：零 timer 切换——视频课页（模块12）后台 timer 被深度节流（单个 400ms setTimeout
  // 实际 ≥60s → JS_SWITCH_V3 整体 180s MCP 超时，6+ 章确定性阵亡）。改为引擎侧驱动：
  // 页内片段只做同步单语句（滚动/扫描/点击/读标题），全部等待在 Node 侧 sleep——
  // 节流对无 timer 的单语句 eval 无效（白盒：简单 probe 秒回）。
  const sw = await switchVia(zev, a.title, allowPrefix);
  meta.phases.switch = { mode: sw.mode, from: sw.from };
  meta.articleId = sw.url ? (sw.url.split("id=")[1] || null) : null;
  if (sw?.mode !== "already" && sw?.mode !== "clicked") {
    // 兜底：整页重导航后再搜一轮（虚拟列表病理态）
    note(`[switch] ${sw.mode} → 兜底重导航`);
    await navigateOnce();
    const sw2 = await switchVia(zev, a.title, allowPrefix);
    meta.phases.switch2 = { mode: sw2.mode, from: sw2.from };
    meta.articleId = sw2.url ? (sw2.url.split("id=")[1] || null) : meta.articleId;
    if (sw2?.mode !== "already" && sw2?.mode !== "clicked") throw new Error(`switch_failed:${sw2.mode}:${String(sw2.curTitle || "").slice(0, 40)}`);
  }
  note(`[switch] ok (${sw.from || "already"}) id=${meta.articleId}`);

  const stb = await zev(JS_STABILIZE, 180000);
  meta.phases.stabilize = { ok: stb?.ok, fastPath: stb?.fastPath, imgs: stb?.imgs, imgsNotLoaded: stb?.imgsNotLoaded };
  if (!stb?.ok) throw new Error(`stabilize_failed:${stb?.err}`);

  // PERF-T0②：ASSERT+CLEANUP 单 eval（断言不过则页内零变异原样返回）
  const cl = await zev(JS_CLEANUP_ASSERT(a.title, allowPrefix));
  meta.phases.assert = cl?.assert;
  note(`[assert-debug] ${JSON.stringify(cl?.assert || null).slice(0, 160)}`);
  const assertFails = [...(cl?.assertFails || [])];
  if (cl?.assert?.ddAudio === 0 && a.expectAudio) assertFails.push("audio-but-no-dd-audio");
  meta.assertFails = assertFails;
  if (assertFails.some((f) => f.startsWith("no-wrap") || f.startsWith("title-"))) { // P26-③n：no-time/cover 软化（视频课页无此二件；错页由 wrap+标题守）
    throw new Error(`assert_failed:${assertFails.join(",")}`);
  }
  meta.phases.cleanup = { ok: cl?.ok, del: cl?.del, docH: [cl?.docHBefore, cl?.docHAfter] };
  note(`[cleanup-debug] zhitda=${JSON.stringify(cl?.del?.zhitdaRefs || [])} letters=${JSON.stringify(cl?.del?.letterBadges || [])} svg=${JSON.stringify(cl?.del?.svgTextIcons || [])} ui=${JSON.stringify(cl?.del?.uiActionLabels || [])}`);
  if (!cl?.ok || (cl.residual && (cl.residual.cover || cl.residual.ddAudio || cl.residual.timeInfo || cl.residual.myComment || cl.residual.messageV2))) {
    throw new Error(`cleanup_residual:${JSON.stringify(cl?.residual)}`);
  }

  // ===== v3①：课后思考整段删除（基准快照之前——刻意删除不入零丢失基准）=====
  // PERF-T0②③：同 eval 带回宣传图尾部审计（M2/M3/M4/srcAbs；页内 fetch 已删，md5 由
  // Node 侧下载且仅在 M2 命中时——非 1080×607 尾图零下载）
  const sk = await zev(JS_SIKAO_DEL);
  meta.sikao = { found: sk?.found, headerIndex: sk?.headerIndex, deletedBlocks: sk?.deletedBlocks, deletedChars: sk?.deletedChars, keptTips: sk?.keptTips, stopReason: sk?.stopReason, deleted: sk?.deleted, phraseCount: sk?.phraseCount, phraseCountAfter: sk?.phraseCountAfter, otherHits: sk?.otherHits };
  if (sk?.err || sk?._outcome) throw new Error(`sikao_eval_error:${JSON.stringify(sk).slice(0, 120)}`);
  if (sk?.found && sk?.phraseCountAfter !== (sk?.otherHitsAfter?.length || 0)) { // P26-③d：与删除后复点对账（原 otherHits 删前统计必失配）
    throw new Error(`sikao_residual_phrase:${sk?.phraseCountAfter}vsOtherHits${sk?.otherHits?.length}`);
  }
  note(`[sikao] found=${sk?.found} del=${sk?.deletedBlocks ?? 0}块/${sk?.deletedChars ?? 0}字 keptTips=${(sk?.keptTips || []).length} stop=${sk?.stopReason} phraseAfter=${sk?.phraseCountAfter}`);

  // PERF-T0⑤：innerText 基线走裸 CDP 单次全量（无 4000 截断，免分片往返）
  const it = await zrawEv(JS_IT_BASE, a.title);
  if ((it.uiHits || []).length) note(`[it-debug] 笔记残留链：${JSON.stringify(it.uiHits)}`); // P26-③b 定位用
  if ((it.dbgHits || []).length) note(`[it-debug] 一键直达残留链：${JSON.stringify(it.dbgHits)}`); // P26-③k 定位用
  fs.writeFileSync(path.join(SCRATCH, `${tag}-clean-inner.txt`), it.t || "");
  meta.cleanInnerChars = (it.t || "").length;

  const pa = sk?.audit;
  meta.promoAudit = pa;
  // P26-②：对全部 1080×607 候选（含非末位）逐一 md5 裁决，命中的 src 集合交给 FIX_SCREEN 删除
  const promoSrcs = [];
  for (const c of pa?.promoCands || []) {
    if (!c.src) continue;
    try {
      const buf = Buffer.from(await (await fetch(c.src, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
      const md5 = createHash("md5").update(buf).digest("hex");
      const match = PROMO_MD5S.has(md5);
      (meta.promoMd5s = meta.promoMd5s || []).push({ src: c.src.split("/").pop(), i: c.i, md5, match }); // P26：存全量 md5（变体扩充取证用）
      if (match) promoSrcs.push(c.src);
    } catch (e) { (meta.promoMd5s = meta.promoMd5s || []).push({ src: String(c.src).split("/").pop(), i: c.i, err: String(e).slice(0, 60) }); } // 取数失败 → 末位 M3 降级通道兜底
  }
  note(`[promo-audit] last: M2=${pa?.M2} M3=${pa?.M3} M4=${pa?.M4} decision=${pa?.decision}；cands=${(pa?.promoCands || []).length} md5Hit=${promoSrcs.length}${(meta.promoMd5s || []).map((x) => ` ${x.md5 ?? "?"}${x.match ? "*" : ""}`).join("")}`);

  const fx1 = await zev(JS_FIX_SCREEN(promoSrcs));
  meta.fixScreen = fx1;
  meta.droppedImages = fx1?.dropped ?? [];
  note(`[fix-screen] dropped=${(fx1?.dropped || []).length} shrunk=${(fx1?.shrunk || []).length} chunked=${(fx1?.chunked || []).length} skipped=${JSON.stringify(fx1?.skipped || [])}`);

  // ===== v3②：MD 块抽取（最终 DOM 态：promo 已删/条带化已折叠/浮层已滤）=====
  // PERF-T0②⑤：一次性裸 CDP 全量回传 blocks+imgs+it2（不变量基线并入，免 INNERTEXT2 与分片）
  const mdb = await zrawEv(JS_MD_BUILD, a.title);
  if (mdb?.err || mdb?._outcome) throw new Error(`md_build_error:${JSON.stringify(mdb).slice(0, 120)}`);
  const mdBlocks = mdb.blocks || [], mdImgs = mdb.imgs || [];
  meta.innerTextInvariant = (mdb.it2 || "") === (it.t || "");
  if (!meta.innerTextInvariant) {
    const A = it.t || "", B = mdb.it2 || ""; // P26 诊断：首个差分上下文
    let k = 0; while (k < A.length && k < B.length && A[k] === B[k]) k++;
    note(`[invariant-debug] len ${A.length} vs ${B.length}；首个差分 @${k}：it1=…${JSON.stringify(A.slice(Math.max(0, k - 15), k + 15))} it2=…${JSON.stringify(B.slice(Math.max(0, k - 15), k + 15))}`);
    throw new Error("innerText_changed_by_figure_ops");
  }
  meta.md = { blocks: mdBlocks.length, imgs: mdImgs.length, unknown: mdb.unknown || {} };
  note(`[md-blocks] blocks=${mdBlocks.length} imgs=${mdImgs.length} unknown=${JSON.stringify(mdb.unknown || {})}`);

  let iter = 0, pdfPath = null, holes = [];
  const prints = [];
  while (iter <= 2) {
    iter++;
    pdfPath = (await zcdpPrint(`${tag}-it${iter}.pdf`, a.title)).path;
    const hrIter = holeReport(pdfPath); // PERF-T0④：QC 复用本轮 holes/pages，不再重算
    holes = hrIter.holes;
    prints.push({ iter, path: pdfPath, holes, pages: hrIter.pages });
    meta.iterations.push({ iter, holes: holes.map((h) => ({ page: h.page, tailPct: h.tailPct })) });
    note(`[print#${iter}] holes=${JSON.stringify(holes.map((h) => `p${h.page}:${h.tailPct}%`))}`);
    if (!holes.length) break;
    if (iter > 2) break;
    const figsNow = await zrawEv(JS_FIGS, a.title); // P26-③g：年度清单类图多章 JSON>4k 被 lasso preview 截断 → eval_unparseable；裸 CDP 全量直收
    const aligned = alignFigures(figsNow.figs, pdfPath);
    const targets = targetsForHoles(holes, aligned);
    fs.writeFileSync(path.join(SCRATCH, `${tag}-targets-it${iter}.json`), JSON.stringify({ aligned, targets }, null, 2));
    // P23 删除档：大空缺（≥RULES.GAP_BIG_PCT）缩不进（下限 200px）→ 删图（记日志；文字绝不动）
    const dels = targets.filter((t) => t.decision && t.decision.action === "delete");
    const appl = targets.filter((t) => !t.unfixable && !(t.decision && t.decision.action === "delete"));
    if (dels.length) {
      const del = await zev(JS_DEL_FIGS(dels));
      meta.deletedByGapRule = (meta.deletedByGapRule || []).concat(del.removed || []);
      note(`[gap-del#${iter}] removed=${JSON.stringify(del.removed)} skipped=${JSON.stringify(del.skipped)}`);
      const itd = await zrawEv(JS_IT_BASE, a.title);
      if ((itd.t || "") !== (it.t || "")) throw new Error("innerText_changed_by_gap_delete");
    }
    if (!appl.length && !dels.length) { note(`[fix-print#${iter}] 无可施缩放目标，停止迭代`); break; }
    if (appl.length) await zev(JS_FIX_PRINT(appl));
  }
  const score = (hs) => hs.reduce((s, h) => s + h.tailPct, 0) + hs.length * 0.01;
  prints.sort((x, y) => score(x.holes) - score(y.holes));
  pdfPath = prints[0].path;
  meta.bestIter = prints[0].iter;

  const qc = {};
  qc.zeroLoss = textZeroLoss(pdfPath, (it.t || "").replace(/-/g, "")); // P26-③c: pdftotext 行尾去连字符 artifact（"xxx-\nyyy"→"xxxyyy"）会把 DOM 侧 ASCII 连字符吃成 missing:-x1；b 侧剥离后 PDF 侧连字符退化为良性多余字符（顺序子序列不受影响）
  qc.promo = promoInPdf(pdfPath);
  qc.holes = prints[0].holes.map((h) => `p${h.page}:${h.tailPct}%`); // PERF-T0④：复用胜出轮
  qc.pages = prints[0].pages;
  qc.innerTextInvariant = meta.innerTextInvariant;
  // v3④：课后思考零残留（PDF 出现次数 == 基准残留次数，正常 both=0）
  const pdfTxtAll = execFileSync("pdftotext", [pdfPath, "-"], { maxBuffer: 128 << 20 }).toString();
  qc.sikaoPdfCount = pdfTxtAll.split(SIKAO).length - 1;
  qc.sikaoExpected = sk?.found ? (sk.otherHitsAfter || []).length : (it.t || "").split(SIKAO).length - 1; // P26-③d：found 时以删除后复点对账
  meta.qc = qc;
  note(`[QC] missing=${JSON.stringify(qc.zeroLoss.missing.slice(0, 5))} inOrder=${qc.zeroLoss.inOrder} promo=${qc.promo.length} holes=${qc.holes.length} pages=${qc.pages} sikao=${qc.sikaoPdfCount}/${qc.sikaoExpected}`);
  const pass = qc.zeroLoss.missingEmpty && qc.zeroLoss.inOrder && qc.promo.length === 0 && qc.innerTextInvariant && qc.sikaoPdfCount === qc.sikaoExpected;
  if (!pass) {
    throw new Error(`qc_failed:${!qc.zeroLoss.missingEmpty ? "text-loss:" + qc.zeroLoss.missing.slice(0, 3) : ""}${!qc.zeroLoss.inOrder ? "+order" : ""}${qc.promo.length ? "+promo-present" : ""}${!qc.innerTextInvariant ? "+inner-changed" : ""}${qc.sikaoPdfCount !== qc.sikaoExpected ? "+sikao-residual" : ""}`);
  }

  const outDir = path.join(BASE, a.dirName);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${safeName(a.title)}.pdf`); // P26-①：标题含 ASCII '/' 时 dest 目录解析必 ENOENT
  fs.copyFileSync(pdfPath, outPath);
  meta.pdfPath = outPath;
  meta.pdfBytes = fs.statSync(outPath).size;
  meta.sha256 = createHash("sha256").update(fs.readFileSync(outPath)).digest("hex");
  note(`[PDF] ${outPath} (${(meta.pdfBytes / 1024 / 1024).toFixed(2)} MiB)`);
  // v3②：MD + images 落地（正典中间产物，供全量合并）
  const imgMap = await downloadImages(mdImgs, outDir, `e${String(flat.idx).padStart(4, "0")}`, meta);
  const mdPath = path.join(outDir, `${safeName(a.title)}.md`); // P26-①
  const mdHead = { title: a.title, module: a.dirName, url: meta.articleId ? `${TARGET.split("?")[0]}?id=${meta.articleId}` : null, producedAt: new Date().toISOString() };
  fs.writeFileSync(mdPath, renderMd(mdHead, mdBlocks, mdImgs, imgMap));
  meta.mdPath = mdPath;
  meta.mdBytes = fs.statSync(mdPath).size;
  if (meta.images.failed.length) note(`[WARN] 图片下载失败 ${meta.images.failed.length} 张（MD 保底远程引用）`);
  note(`[MD] ${mdPath} (${meta.mdBytes} B, imgs ${meta.images.downloaded}新+${meta.images.reused}复用)`);
  return meta;
}

// ---------------- 子命令：enumerate ----------------
// P7 慢滚合并 + 快照内有序插入（跨 pass 乱序问题）；多 pass 收敛。状态存 window.__dzEnum。
const JS_ENUM_PASS = `return (async()=>{
  const ps=document.querySelector('div.course-nav div.ps');
  if(!ps) return JSON.stringify({err:'no-sidebar'});
  const E=window.__dzEnum=window.__dzEnum||{mods:new Map()};
  const TITLE_CUT=/\\s+\\d+分\\d+秒|\\s+\\d+人学过|\\s+\\|/;
  const parseLi=(t)=>{const n=(t||'').trim().replace(/\\s+/g,' ');const m=n.split(TITLE_CUT)[0];return m||n;};
  let added=0, snapItems=0;
  const snap=()=>{
    const mods=[...document.querySelectorAll('div.course-nav div.chapter-mod')];
    for(const m of mods){
      const h=m.querySelector('.chapterp-header');
      if(!h) continue;
      const name=(h.textContent||'').trim().replace(/\\s+/g,' ');
      if(!name) continue;
      let e=E.mods.get(name);
      if(!e){e={name,subs:[]};E.mods.set(name,e);}
      const lis=[...m.querySelectorAll('ul.course-module>li')].map(li=>parseLi(li.textContent)).filter(Boolean);
      snapItems+=lis.length;
      // 快照内有序插入：锚定同快照中已存在的邻居
      for(let i=0;i<lis.length;i++){
        const t=lis[i];
        if(e.subs.includes(t)) continue;
        let after=null;
        for(let j=i-1;j>=0;j--){if(e.subs.includes(lis[j])){after=lis[j];break;}}
        let before=null;
        if(!after){for(let j=i+1;j<lis.length;j++){if(e.subs.includes(lis[j])){before=lis[j];break;}}}
        if(after){e.subs.splice(e.subs.indexOf(after)+1,0,t);}
        else if(before){e.subs.splice(e.subs.indexOf(before),0,t);}
        else{e.subs.push(t);}
        added++;
      }
    }
  };
  snap();
  const step=Math.max(200,Math.floor(ps.clientHeight*0.7));
  let maxH=ps.scrollHeight;
  for(let y=0;y<=maxH;y+=step){
    ps.scrollTop=y;
    await new Promise(r=>setTimeout(r,350));
    maxH=Math.max(maxH,ps.scrollHeight);
    snap();
  }
  ps.scrollTop=ps.scrollHeight;
  await new Promise(r=>setTimeout(r,600));
  snap();
  ps.scrollTop=0;
  await new Promise(r=>setTimeout(r,400));
  return JSON.stringify({added,snapItems,mods:E.mods.size,maxH,subsTotal:[...E.mods.values()].reduce((s,e)=>s+e.subs.length,0)});
})()`;

// 逐模块分片 dump（整树 JSON 超 evaluate preview 截断上限——实测 419 子章节被截）
const JS_ENUM_DUMP_N = `return (()=>{
  const E=window.__dzEnum;
  if(!E) return JSON.stringify({err:'no-state'});
  return JSON.stringify({n:E.mods.size});
})()`;
const JS_ENUM_DUMP_MOD = (i) => `return (()=>{
  const E=window.__dzEnum;
  if(!E) return JSON.stringify({err:'no-state'});
  const arr=[...E.mods.values()];
  const m=arr[${i}];
  if(!m) return JSON.stringify({done:true});
  return JSON.stringify({name:m.name,subs:m.subs});
})()`;

function buildManifest(dump) {
  const flat = [];
  const modules = [];
  const seen = new Set();
  const duplicates = [];
  for (const m of dump.mods) {
    const dirName = m.name.replace(/\s*[|｜]\s*/, "-").trim();
    const declaredM = m.name.match(/\((\d+)讲\)/);
    const mods = { name: m.name, dirName, declared: declaredM ? +declaredM[1] : null, nSubs: m.subs.length, subs: [] };
    for (const t of m.subs) {
      const seqM = t.match(/^第(\d+)讲/);
      mods.subs.push({ title: t, seq: seqM ? +seqM[1] : null });
    }
    // 序号单调性校验（第NNN讲 全课程连续编号）
    const numbered = mods.subs.filter((s) => s.seq !== null);
    const sortedOk = numbered.every((s, i) => i === 0 || s.seq > numbered[i - 1].seq);
    mods.seqMonotonic = sortedOk;
    if (!sortedOk) mods.subs.sort((x, y) => (x.seq ?? 1e9) - (y.seq ?? 1e9));
    modules.push(mods);
    for (const s of mods.subs) {
      if (seen.has(s.title)) { duplicates.push({ title: s.title, module: m.name }); continue; } // 状态键=title，跨模块重名会撞台账
      seen.add(s.title);
      flat.push({ idx: flat.length, module: m.name, dirName, title: s.title, seq: s.seq });
    }
  }
  return {
    generatedAt: new Date().toISOString(), source: "sidebar slow-scroll merge (P7)+ordered insert",
    totalSubs: flat.length, modules, flat, duplicates,
    countsSanity: modules.filter((m) => m.declared != null && m.declared !== m.nSubs).map((m) => `${m.name}: merged ${m.nSubs}/declared ${m.declared}`),
  };
}

// ---------------- 子命令实现 ----------------
async function cmdEnumerate() {
  await envCheck();
  await client.connect(transport);
  const g = chromeGuard(); note(`[chrome-guard] ${JSON.stringify(g)}`);
  await navigateOnce();
  let prevTotal = -1, pass = 0;
  const passLog = [];
  while (pass < 4) {
    pass++;
    const r = await ev(JS_ENUM_PASS, 600000);
    passLog.push(r);
    note(`[enum-pass${pass}] added=${r.added} mods=${r.mods} subsTotal=${r.subsTotal} maxH=${r.maxH}`);
    if (r.subsTotal === prevTotal && r.added === 0) break;
    prevTotal = r.subsTotal;
  }
  const n = (await ev(JS_ENUM_DUMP_N)).n;
  const mods = [];
  for (let i = 0; i < n; i++) {
    const m = await ev(JS_ENUM_DUMP_MOD(i));
    if (m.done) break;
    mods.push(m);
  }
  const manifest = buildManifest({ mods });
  atomicJson(MANIFEST_PATH, manifest);
  note(`[manifest] ${manifest.totalSubs} 子章节 / ${manifest.modules.length} 模块 → ${MANIFEST_PATH}`);
  note(`[manifest] 分母核对(declared vs merged)：${JSON.stringify(manifest.countsSanity)}`);
  note(`[manifest] 序号非单调模块：${JSON.stringify(manifest.modules.filter((m) => !m.seqMonotonic).map((m) => m.name))}`);
  note(`[manifest] 跨模块重名：${JSON.stringify(manifest.duplicates)}`);
  fs.writeFileSync(path.join(ENGINE, "logs", `${RUN_TS}-enum-passes.json`), JSON.stringify(passLog, null, 2));
  await transport.close();
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0);
}

async function cmdProduce() {
  const only = opt("only", null);
  const limit = parseInt(opt("limit", "0"), 10);
  const retry = !!opt("retry", false);
  const force = !!opt("force", false);
  const manifest = loadManifest();
  const st = loadState();
  let list = manifest.flat.filter((f) => {
    const e = st.chapters[f.title];
    if (force) return true;
    if (!e || e.status === "pending") return true; // 新章
    if (e.status === "failed") {
      if (retry) return true; // --retry：无视次数上限重跑失败章
      return (e.attempts || 0) < MAX_ATTEMPTS; // 默认：未到上限自动重试
    }
    return false; // done 跳过（断点续跑）
  });
  if (only) {
    const keys = String(only).split(",").map((s) => s.trim()).filter(Boolean);
    list = manifest.flat.filter((f) => keys.some((k) => f.title.includes(k)));
  }
  if (limit > 0) list = list.slice(0, limit);
  // PERF-T2：无 --only 时按 manifest.idx 奇偶分片（--only 集即工作集，由 run-k2.mjs 均分）
  if (workerN > 1 && !only) {
    list = list.filter((f) => f.idx % workerN === workerK);
  }
  // P25-② 前缀歧义标记：want（归一化后）是其他章标题的严格前缀（如「加餐」vs
  // 「加餐丨大学没有围墙」）→ 宽容匹配关闭竖线前缀形态，只允许全等，防错章假阳性。
  // P26-③o：歧义范围收窄到「本批仍要生产的章」——姊妹章已 done 后风险消解（「加餐/
  // 直播回顾」裸题章的页面标题即竖线形态，全等永不可过，白盒 clicked-but-title）。
  const todoNormTitles = list.map((x) => NORM_T(x.title));
  for (const f of list) {
    const w = NORM_T(f.title);
    f.titleAmbiguous = todoNormTitles.some((n) => n !== w && n.startsWith(w));
  }
  const nAmb = list.filter((f) => f.titleAmbiguous).length;
  note(`[produce] 计划 ${list.length} 章（全量分母 ${manifest.totalSubs}；台账 done=${Object.values(st.chapters).filter((e) => e.status === "done").length}；前缀歧义章 ${nAmb} 走全等匹配）${workerN > 1 ? ` worker=${workerK}/${workerN}` : ""}${only ? ` only=${only}` : ""}${retry ? " retry" : ""}${force ? " force" : ""}`);
  if (!list.length) { note("[produce] 无待处理章节"); process.exit(0); }

  await envCheck();
  await closeAllPageTabs(); // P26-③j：启动清场（client.connect 前——lasso 首连自建唯一 tab，回到单 tab 世界）
  await client.connect(transport);
  // PERF-T2：worker 存活栅栏——lasso shutdown 的 tab restore 会关「本实例快照之后新增的
  // 所有 tab」（不只自己建的，TabSession.restore diff 语义）→ 先完工的 worker 退出会
  // 关掉仍在生产的另一 worker 工作 tab（K=2 首跑实测：K0 退出 → K1 print 120s 超时 +
  // "selected page has been closed"）。栅栏：全部 worker 完工前谁都不 transport.close。
  const aliveMarker = path.join(ENGINE, `k2-alive-${workerK}`);
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const othersAlive = () => {
    for (let k = 0; k < workerN; k++) {
      if (k === workerK) continue;
      const p = path.join(ENGINE, `k2-alive-${k}`);
      if (!fs.existsSync(p)) continue;
      try { const m = JSON.parse(fs.readFileSync(p, "utf8")); if (pidAlive(m.pid) && Date.now() - Date.parse(m.ts) < 6 * 3600e3) return true; } catch { return true; }
    }
    return false;
  };
  if (workerN > 1) {
    atomicJson(aliveMarker, { pid: process.pid, ts: new Date().toISOString() });
    process.on("exit", () => { try { fs.rmSync(aliveMarker, { force: true }); } catch { /* 崩溃清理尽力 */ } });
  }
  // P28：弹窗自动接受看门狗（事件层 + 15s 兜底层）常驻本 produce 生命周期
  dialogWatch.stop = false;
  dialogWatchLoop();
  dialogFallbackLoop();
  async function barrierWait() {
    if (workerN <= 1) return;
    // 语义：marker 在 = 仍在生产。完工者**先撤自己的 marker**再等他人 marker 消失——
    // 若等"进程退出"会死锁（对方也可能已完工在栅栏处等，K=2 二跑实测踩中）。
    try { fs.rmSync(aliveMarker, { force: true }); } catch { /* 已撤 */ }
    const cap = Date.now() + 35 * 60 * 1000; // 3× 单章看门狗上限，防死等
    while (othersAlive() && Date.now() < cap) await new Promise((r) => setTimeout(r, 1000));
    if (othersAlive()) note("[k2-barrier] 等待其他 worker 超时（35min），强制收尾——若对方仍在产，其 tab 可能被本实例 restore 关闭");
    else note("[k2-barrier] 其他 worker 已完工 → 安全收尾（tab restore 无害）");
  }
  const g0 = chromeGuard(); note(`[chrome-guard] ${JSON.stringify(g0)}`);
  await ensurePagesResponsive(); // P28-③：冷启动也要探测——楔死 tab 连 lasso navigate 都会 3×3min 超时（白盒：browse-retry 连烧 Network.enable timed out）
  // P26-③j：冷启动导航韧性——清场后 lasso 首导航可能 "No page selected"/瞬时 unknown，
  // 失败→关全部 page tab 重建单 blank→再试（共 3 轮），不再一次崩掉整批。
  {
    let booted = false;
    for (let i = 1; i <= 3 && !booted; i++) {
      try { await navigateOnce(); booted = true; }
      catch (e) {
        note(`[boot] 第${i}次导航失败：${String(e && e.message || e).slice(0, 80)}`);
        if (i < 3) { await closeAllPageTabs(); await new Promise((r) => setTimeout(r, 3000)); }
      }
    }
    if (!booted) { note("[FATAL] 冷启动导航 3 轮失败，退出（重跑 produce 续）"); await transport.close().catch(() => {}); process.exit(1); }
  }

  const t0 = Date.now();
  const durations = [];
  let sinceReset = 0;
  // P25 批级熔断器（内建看门狗，不依赖外部监控）：
  //  ① 连续 FAIL ≥5 章 → 暂停（PAUSED_BATCH_BREAKER，台账已逐章落盘，断点续跑）
  //  ② 本批累计 FAIL >15 章 → 中止（ABORT_BATCH_BREAKER）
  //  ③ 20 分钟无任何 [OK] → 中止（ABORT_BATCH_BREAKER）
  const BREAKER_CONSEC_FAIL = 5, BREAKER_CUM_FAIL_MAX = 15, BREAKER_STALL_MS = 20 * 60 * 1000;
  function breakerTripReason(consecFail, cumFail, msSinceLastOk) {
    if (consecFail >= BREAKER_CONSEC_FAIL) return `PAUSED_BATCH_BREAKER: 连续失败 ${consecFail} 章（≥${BREAKER_CONSEC_FAIL}）自动暂停`;
    if (cumFail > BREAKER_CUM_FAIL_MAX) return `ABORT_BATCH_BREAKER: 本批累计失败 ${cumFail} 章（>${BREAKER_CUM_FAIL_MAX}）中止`;
    if (msSinceLastOk > BREAKER_STALL_MS) return `ABORT_BATCH_BREAKER: ${Math.round(msSinceLastOk / 60000)} 分钟无成功章（>${BREAKER_STALL_MS / 60000}min）中止`;
    return null;
  }
  let consecFail = 0, cumFail = 0, lastOkAt = Date.now(), breakerTrip = null;
  // PERF-T2：全局跳闸文件（跨进程）。任一 worker 触发批级熔断 → 写 BREAKER.trip → 所有
  // worker 在下一章边界停机（K 进程下各自计数会漏全局模式，如 dedao 开始限流时两 worker
  // 各自慢慢烧）。run-k2.mjs 启动时清理；单进程模式同样写（复用同一停机协议）。
  const TRIP_PATH = path.join(ENGINE, "BREAKER.trip");
  function tripGlobal(reason) {
    try { atomicJson(TRIP_PATH, { ts: new Date().toISOString(), worker: KTAG.trim() || "solo", reason }); } catch { /* 尽力写 */ }
  }
  function readGlobalTrip() {
    if (workerN <= 1) return null; // P28 边界：solo 模式不读跨 worker 跳闸文件（K=2 编排工件，run-k2 启动时清理；solo 误读会被上轮残留卡死）
    try {
      if (!fs.existsSync(TRIP_PATH)) return null;
      const t = JSON.parse(fs.readFileSync(TRIP_PATH, "utf8"));
      if (Date.now() - Date.parse(t.ts) > 6 * 3600 * 1000) return null; // 陈旧跳闸（>6h）忽略
      return `GLOBAL_TRIP by ${t.worker}: ${String(t.reason).slice(0, 120)}`;
    } catch { return null; }
  }
  const SPA_RESET_N = workerN > 1 ? 15 : SPA_RESET_EVERY; // PERF-T2：worker 档复位加密（内存保险）
  for (let i = 0; i < list.length; i++) {
    const gt = readGlobalTrip();
    if (gt) { breakerTrip = gt; note(`[BREAKER] ${gt} —— 本 worker 在第 ${i + 1}/${list.length} 章前停机`); break; }
    await ensurePagesResponsive(); // P28-③：章前 renderer 楔死探测 + 换 tab 自愈
    const f = list[i];
    const tc = Date.now();
    note(`\n===== [${i + 1}/${list.length}] ${f.title} (${f.module}) =====`);
    let meta = null, fatal = null;
    const fence = { dead: false }; // P26-③k：章围栏（见 produceChapter 头注）
    try {
      meta = await Promise.race([
        produceChapter(f, st, fence),
        new Promise((_, rej) => setTimeout(() => rej(new Error("chapter_watchdog_timeout")), CHAPTER_WATCHDOG_MS)),
      ]);
    } catch (e) { fatal = String(e && e.message || e).slice(0, 300); }
    if (fatal) fence.dead = true; // 僵尸围栏拉起：其下一个远端调用即抛 zombie_fenced
    const dur = ((Date.now() - tc) / 1000).toFixed(1);
    durations.push(+dur);
    if (fatal) {
      consecFail++; cumFail++;
      note(`[FAIL] ${f.title}: ${fatal}`);
      // P26-③k：失败后整页复位——清掉僵尸在途脚本的文档态（配合围栏双保险）
      try { await navigateOnce(); } catch (e) { note(`[post-fail-reset] 失败继续：${String(e && e.message || e).slice(0, 60)}`); }
      const prev = st.chapters[f.title] || {};
      const entry = { title: f.title, chapterDir: f.dirName, status: "failed", attempts: (prev.attempts || 0) + 1, fatal, durSec: +dur, producedBy: "engine 1.1 (v3)" };
      await persistEntry(st, entry);

    } else {
      consecFail = 0; lastOkAt = Date.now();
      const entry = { title: f.title, chapterDir: f.dirName, status: "done", attempts: meta.attempts, articleId: meta.articleId, sha256: meta.sha256, pdfPath: meta.pdfPath, pdfBytes: meta.pdfBytes, mdPath: meta.mdPath, mdBytes: meta.mdBytes, sikao: { found: meta.sikao?.found, deletedChars: meta.sikao?.deletedChars, keptTips: (meta.sikao?.keptTips || []).length }, durSec: +dur, qc: { missingEmpty: meta.qc.zeroLoss.missingEmpty, inOrder: meta.qc.zeroLoss.inOrder, promo: meta.qc.promo.length, holes: meta.qc.holes, pages: meta.qc.pages, sikaoPdf: meta.qc.sikaoPdfCount }, producedBy: "engine 1.1 (v3)" };
      await persistEntry(st, entry);

      fs.writeFileSync(path.join(SCRATCH, `e${String(f.idx).padStart(4, "0")}-meta.json`), JSON.stringify(meta, null, 2));
      const mean = durations.reduce((s, d) => s + d, 0) / durations.length;
      const remain = (list.length - i - 1) * mean;
      note(`[OK] ${f.title} ${dur}s | 进度 ${i + 1}/${list.length} 均值 ${mean.toFixed(1)}s ETA ${(remain / 60).toFixed(1)}min`);
    }
    chromeGuardAsync(); // PERF-T0⑥：不阻塞主循环（原同步 lsof+osascript ≈0.2-0.4s/章）
    // ---- 熔断判定（每章后；台账已写，停机即安全断点）----
    if (!breakerTrip) breakerTrip = breakerTripReason(consecFail, cumFail, Date.now() - lastOkAt);
    if (breakerTrip) {
      note(`\n[BREAKER] ${breakerTrip} —— 第 ${i + 1}/${list.length} 章后停机；state 已写，` +
        `续跑：node engine.mjs produce（done 跳过；失败章 attempts<${MAX_ATTEMPTS} 自动重试）`);
      if (workerN > 1) tripGlobal(breakerTrip); // PERF-T2：全局跳闸广播（K=2 时另一 worker 章边界停）
      break;
    }
    if (workerN > 1) await new Promise((r) => setTimeout(r, 200 + Math.random() * 600)); // PERF-T2 jitter：dedao 请求间隔随机化 200-800ms
    sinceReset++;
    if (sinceReset >= SPA_RESET_N && i < list.length - 1) {
      note(`[spa-reset] 每 ${SPA_RESET_N} 章整页复位`);
      try { await navigateOnce(); sinceReset = 0; } catch (e) { note(`[spa-reset] 失败继续：${String(e).slice(0, 80)}`); }
    }
  }
  const totalMin = ((Date.now() - t0) / 60000).toFixed(1);
  const nOk = list.length - list.filter((f) => st.chapters[f.title]?.fatal && st.chapters[f.title]?.status === "failed" && durations[list.indexOf(f)] != null).length;
  const fails = list.filter((f) => st.chapters[f.title]?.status === "failed").map((f) => f.title);
  note(`\n===== BATCH DONE ${totalMin}min：${list.length} 章处理，失败 ${fails.length}${fails.length ? "：" + fails.join(" / ") : ""}${breakerTrip ? ` ｜ ${breakerTrip}` : ""} =====`);
  await barrierWait(); // PERF-T2：存活栅栏——其他 worker 未完工前不 close（tab restore 会误杀对方工作 tab）
  await transport.close();
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0);
}

async function cmdStatus() {
  const st = loadState();
  let manifest = null;
  if (fs.existsSync(MANIFEST_PATH)) manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const entries = Object.values(st.chapters);
  const done = entries.filter((e) => e.status === "done");
  const failed = entries.filter((e) => e.status === "failed");
  console.log(`manifest: ${manifest ? `${manifest.totalSubs} 子章节 / ${manifest.modules.length} 模块 (${manifest.generatedAt})` : "未生成（先 enumerate）"}`);
  console.log(`state: done=${done.length} failed=${failed.length}${manifest ? ` pending≈${manifest.totalSubs - done.length - failed.length}` : ""}`);
  if (manifest) console.log(`分母核对: ${JSON.stringify(manifest.countsSanity)}`);
  for (const f of failed) console.log(`  FAIL(${f.attempts}) ${f.title}: ${String(f.fatal).slice(0, 140)}`);
  const durs = done.map((e) => e.durSec).filter(Boolean);
  if (manifest && durs.length) {
    const mean = durs.reduce((s, d) => s + d, 0) / durs.length;
    const remain = manifest.totalSubs - done.length;
    console.log(`耗时: 均值 ${mean.toFixed(1)}s/章（n=${durs.length}）→ 剩余 ${remain} 章 ≈ ${(remain * mean / 60).toFixed(0)} min`);
  }
}

// ---------------- main ----------------
function selftest() {
  // P14 §7.3 门禁：所有内嵌 JS 片段过 new Function 语法闸（含插值后真串）
  const frags = {
    JS_READY, JS_STABILIZE, JS_SIKAO_DEL, JS_MD_BUILD, JS_IT_BASE, JS_FIGS, JS_ENUM_PASS, JS_ENUM_DUMP_N,
    JS_CLEANUP_ASSERT: JS_CLEANUP_ASSERT("第001讲丨测试", true),
    JS_CLEANUP_ASSERT_AMB: JS_CLEANUP_ASSERT("加餐", false),
    JS_ENUM_DUMP_MOD: JS_ENUM_DUMP_MOD(0),
    JS_SWITCH_V3: JS_SWITCH_V3("第001讲丨测试"),
    JS_SWITCH_V3_PIPE: JS_SWITCH_V3("第8周问答"),
    JS_FIX_PRINT: JS_FIX_PRINT([{ idx: 0, mh: 200 }]),
    JS_FIX_SCREEN_DROP: JS_FIX_SCREEN(["https://piccdn3.umiwi.com/img/x.jpg"]),
    JS_FIX_SCREEN_KEEP: JS_FIX_SCREEN([]),
  };
  let bad = 0;
  for (const [k, v] of Object.entries(frags)) {
    try { new Function(v); } catch (e) { bad++; console.log(`FAIL ${k}: ${e.message}`); }
  }
  // P25-② titleMatches 宽容匹配机械校验（归一化全角竖线/空白 + 竖线前缀 + 歧义关闭）
  const tm = [
    ["第8周问答 | 人们为什么送礼而不送钱？", "第8周问答", true, true],
    ["第8周问答丨人们为什么送礼而不送钱？", "第8周问答", true, true],
    ["第8周问答 | 人们为什么送礼而不送钱？", "第9周问答", false, true],
    ["第13周问答丨城市兴衰有其内在规律", "第13周问答丨城市兴衰有其内在规律", true, true],
    ["第040讲 | 庆十万：陪你排队买早餐的经济学家", "第040讲", true, true],
    ["第056讲丨产权保护物理属性而非经济属性", "第055讲丨自由不等于免费", false, true],
    ["预告丨你的权利从哪里来？", "预告丨你的权利从哪里来？", true, true],
    [null, "第4周问答", false, true],
    ["加餐丨大学没有围墙", "加餐", true, true],   // 无歧义标记时会前缀命中（引擎侧用 titleAmbiguous 关闭）
    ["加餐丨大学没有围墙", "加餐", false, false],  // 歧义章（allowPrefix=false）只允许全等 → 拒绝
    ["加餐", "加餐", true, false],
  ];
  for (const [p, w, exp, ap] of tm) {
    const got = titleMatches(p, w, ap);
    if (got !== exp) { bad++; console.log(`FAIL titleMatches(${JSON.stringify(p)}, ${JSON.stringify(w)}, ${ap}) = ${got}, 期望 ${exp}`); }
  }
  console.log(bad === 0 ? `selftest OK (${Object.keys(frags).length} fragments + ${tm.length} titleMatches)` : `selftest FAILED (${bad})`);
  process.exit(bad === 0 ? 0 : 1);
}
if (cmd === "selftest") selftest();
else if (cmd === "enumerate") await cmdEnumerate();
else if (cmd === "produce") await cmdProduce();
else await cmdStatus();
