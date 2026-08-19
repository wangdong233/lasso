#!/usr/bin/env node
/**
 * scout7-round2.mjs — 二轮探察（P14）
 *
 * 任务：
 *  A. 尾部宣传图特征：3 篇已抽文章 dump 正文 figure 清单 + 末尾结构（打印前态）
 *  B. 分页断点测量：cleanup 后页映射（屏幕布局 vs PAGE_H=(11.693-0.8)*96=1045.728px），
 *     再直连 CDP printToPDF 出「before」PDF 供 pdftoppm/pdfimages 实证空白页尾
 *  C. 零丢失基线：cleanup 后 body.innerText 存盘（切片拉取，绕 preview 4000 截断）
 *  D. 逐阶段计时（全量 113 章预研）
 *
 * 全部产物落 .dedao-extract/r2-*.json / scratch/，不写正式章节目录。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const SCRATCH = path.join(OUT, "scratch");
fs.mkdirSync(SCRATCH, { recursive: true });
const CDP = "http://127.0.0.1:9226";
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const ARTICLES = [
  { tag: "fk", title: "发刊词丨只给你地道的经济学思维", print: true },
  { tag: "l001", title: "第001讲丨战俘营里的经济组织", print: true },
  { tag: "l002", title: "第002讲丨马粪争夺案", print: true },
];

const log = [];
const t0 = Date.now();
function save(name, obj) {
  fs.writeFileSync(
    path.join(OUT, name),
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
  );
}
function note(msg) {
  const el = Date.now() - t0;
  const line = `[${(el / 1000).toFixed(1)}s] ${msg}`;
  console.log(line);
  log.push(line);
}

// ---------------- 直连 CDP：Page.printToPDF（与 extract-batch3 一字不差） ----------------
async function cdpPrint(outPath) {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const tab = tabs.find(
    (t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"),
  );
  if (!tab) return { ok: false, err: "no-dedao-tab" };
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error(`ws_error:${String(e)}`));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, (m) =>
        m.error ? rej(new Error(`${method}:${JSON.stringify(m.error)}`)) : res(m.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    const r = await send("Page.printToPDF", {
      landscape: false,
      printBackground: true,
      paperWidth: 8.268,
      paperHeight: 11.693,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
      scale: 1,
      preferCSSPageSize: false,
    });
    const buf = Buffer.from(r.data, "base64");
    fs.writeFileSync(outPath, buf);
    return { ok: true, bytes: buf.length };
  } finally {
    ws.close();
  }
}

// ---------------- lasso MCP 客户端（与 b3 同款） ----------------
const client = new Client({ name: "dedao-scout7-r2", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [
    "-c",
    `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-r2-stderr.log"))}`,
  ],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);

async function browse(action, options = {}, timeoutMs = 180000) {
  const res = await client.callTool(
    { name: "browse_logged_in", arguments: { url: TARGET, action, options } },
    undefined,
    { timeout: timeoutMs },
  );
  return JSON.parse(res.content[0].text);
}
async function ev(js, timeoutMs = 120000) {
  const r = await browse("evaluate", { js }, timeoutMs);
  const p = r?.data?.preview ?? "";
  if (r?.outcome !== "worked" && r?.outcome !== undefined) {
    return { _outcome: r?.outcome, _error: r?.error, _raw: p.slice(0, 300) };
  }
  try {
    return JSON.parse(p);
  } catch {
    return { _raw: p.slice(0, 600), _outcome: r?.outcome };
  }
}
// 长文本切片拉取（绕 preview 4000 截断）
async function evText(expr, est) {
  const chunks = [];
  for (let off = 0; off < est + 2000; off += 1800) {
    const r = await ev(
      `return JSON.stringify((${expr}).slice(${off},${off + 1800}));`,
    );
    if (typeof r !== "string") return chunks.join("");
    chunks.push(r);
    if (r.length < 1800) break;
  }
  return chunks.join("");
}

// ---------------- Phase 1: navigate + ready ----------------
let ts = Date.now();
let nav = await browse("navigate", {});
save("r2-01-navigate.json", nav);
if (nav.outcome !== "worked") {
  note(`[FATAL] navigate ${nav.outcome} ${nav.error}`);
  save("r2-99-log.json", log);
  process.exit(1);
}
let ready = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1200));
  ready = await ev(
    `return JSON.stringify({rs:document.readyState,title:(document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,40),len:(document.body&&document.body.innerText||'').length});`,
  );
  if (ready?.rs === "complete" && (ready?.len ?? 0) > 800 && ready?.title) break;
}
note(`[ready ${(Date.now() - ts) / 1000}s] ${JSON.stringify(ready)}`);
if (!ready?.title) {
  note("[FATAL] article-title 未出现（登录态/加载问题）");
  save("r2-99-log.json", log);
  process.exit(1);
}

// ---------------- JS_SWITCH（b3 原样） ----------------
const JS_SWITCH = (want) => `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const want=${JSON.stringify(want)};
  const cur=q('div.article-body-wrap .article-title');
  const curT=cur?(cur.textContent||'').trim():'';
  if(curT===want){return JSON.stringify({mode:'already',title:curT,url:location.href});}
  const find=()=>[...document.querySelectorAll('div.course-nav ul.course-module>li')]
    .find(li=>(li.textContent||'').trim().replace(/\\s+/g,' ').startsWith(want));
  let li=find();
  if(!li){const ps=q('div.course-nav div.ps');if(ps){ps.scrollTop=0;await new Promise(r=>setTimeout(r,700));}li=find();}
  if(!li){return JSON.stringify({mode:'notfound',curTitle:curT});}
  li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  const t0=Date.now();
  while(Date.now()-t0<20000){
    await new Promise(r=>setTimeout(r,400));
    const t=q('div.article-body-wrap .article-title');
    const tt=t?(t.textContent||'').trim():'';
    if(tt===want){return JSON.stringify({mode:'clicked',title:tt,url:location.href});}
  }
  const t=q('div.article-body-wrap .article-title');
  return JSON.stringify({mode:'timeout',curTitle:t?(t.textContent||'').trim():''});
})()`;

// lite 稳定：只等正文图片 complete（b3 全量 stabilize 的滚动段对已急加载图片非必需，计时对照用）
const JS_STABILIZE_LITE = `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const body=q('div.article-body-wrap .article-body');
  if(!body) return JSON.stringify({ok:false,err:'no-body'});
  let imgs=[];
  for(let i=0;i<25;i++){
    imgs=[...document.querySelectorAll('div.article-body img')];
    if(imgs.every(im=>im.complete&&(im.naturalWidth>0||!im.src)))break;
    await new Promise(r=>setTimeout(r,400));
  }
  return JSON.stringify({ok:true,bodyLen:(body.innerText||'').length,imgs:imgs.length,imgsNotLoaded:imgs.filter(im=>!(im.complete&&im.naturalWidth>0)).length});
})()`;

// ---------------- A. DOM dump：figure 清单 + 尾部结构（清理前） ----------------
const JS_DUMP = `return (()=>{
  const show=document.querySelector('div.article-body div.editor-show');
  if(!show) return JSON.stringify({err:'no-editor-show'});
  const kids=[...show.children];
  const figs=[...show.querySelectorAll('figure')];
  const figInfo=figs.map((f,i)=>{
    const im=f.querySelector('img');
    const r=f.getBoundingClientRect();
    const imr=im?im.getBoundingClientRect():null;
    return {i,
      figCls:(typeof f.className==='string'?f.className.trim():'').slice(0,30),
      src:im?(im.currentSrc||im.getAttribute('src')||'').split('/').pop().slice(0,52):null,
      nat:im?im.naturalWidth+'x'+im.naturalHeight:null,
      disp:imr?Math.round(imr.width)+'x'+Math.round(imr.height):null,
      top:Math.round(r.top+window.scrollY),h:Math.round(r.height),
      cap:(f.querySelector('figcaption')?(f.querySelector('figcaption').textContent||'').trim().slice(0,40):null)};
  });
  const tailKids=kids.slice(-8).map((c,idx)=>({idx:kids.length-8+idx,tag:c.tagName,
    cls:(typeof c.className==='string'?c.className.trim().split(/\\s+/)[0]:'').slice(0,26),
    tl:(c.textContent||'').trim().length,txt:(c.textContent||'').replace(/\\s+/g,' ').slice(0,30)}));
  const lastFig=figs[figs.length-1];
  const lastKid=kids[kids.length-1];
  const after=lastFig&&lastFig.nextElementSibling?(lastFig.nextElementSibling.tagName+'.'+(typeof lastFig.nextElementSibling.className==='string'?lastFig.nextElementSibling.className.trim().split(/\\s+/)[0]:'')):'NONE';
  const lastFigHtml=lastFig?lastFig.outerHTML.replace(/\\s+/g,' ').slice(0,260):null;
  const bodyTxt=(show.textContent||'').replace(/\\s+/g,' ');
  // 网络线索：课程大纲 API（供 113 章 URL 直连快路径评估）
  const api=performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/course|article|chapter|outline|catalog/i.test(n)).slice(-10);
  return JSON.stringify({url:location.href.slice(0,90),
    title:(document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,34),
    editorChildren:kids.length,figCount:figs.length,figs:figInfo,
    tailKids,lastFigIsLastChild:lastFig===lastKid,afterLastFig:after,lastFigHtml,
    showTxtTail:bodyTxt.trim().slice(-100),apiHit:api.length,api:api.slice(0,6)});
})()`;

// ---------------- B. cleanup（b3 JS_CLEANUP 原样） ----------------
const JS_CLEANUP = `return (()=>{
  const q=(s,r)=>(r||document).querySelector(s);
  const qa=(s,r)=>[...(r||document).querySelectorAll(s)];
  const rep={ok:true,del:{},hid:{},residual:{}};
  const wrap=q('div.article > div.article-wrap > div.article-body-wrap');
  if(!wrap){return JSON.stringify({ok:false,err:'no-wrap'});}
  const pc=qa(':scope > div.pageControl',wrap);rep.del.pageControl=pc.length;pc.forEach(n=>n.remove());
  const c=q('.article-cover',wrap);rep.del.cover=!!c;if(c)c.remove();
  const da=qa('.dd-audio',wrap);rep.del.ddAudio=da.length;da.forEach(n=>n.remove());
  const au=qa('audio',wrap);rep.del.audioTags=au.length;au.forEach(n=>n.remove());
  const ti=q(':scope > div.article-time-info',wrap);rep.del.timeInfo=!!ti;
  if(ti){let n=ti,cnt=0;while(n){const nx=n.nextElementSibling;n.remove();n=nx;cnt++;}rep.del.tailSiblingsRemoved=cnt;}
  for(const sel of ['.iget-header','div.course-nav','aside.iget-side-button','div.course-nav-mask','.iget-audio-player','.article-note-editor','aside.notes-wrap','.iget-global-prompt']){
    const els=qa(sel);els.forEach(e=>e.style.setProperty('display','none','important'));rep.hid[sel]=els.length;
  }
  const art=q('div.iget-articles > div.article');
  const r1=art?art.getBoundingClientRect():null;
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

// ---------------- B2. cleanup 后页映射（分页断点白盒测量） ----------------
const JS_PAGEMAP = `return (()=>{
  const PAGE=(11.693-0.8)*96; // 1045.728 CSS px / 页（A4 内容高 @scale1）
  const wrap=document.querySelector('div.article > div.article-wrap > div.article-body-wrap');
  const show=wrap&&wrap.querySelector('.article-body .editor-show');
  if(!show) return JSON.stringify({err:'no-show'});
  const figs=[...show.querySelectorAll('figure')];
  const rows=figs.map((f,i)=>{
    const im=f.querySelector('img');
    const r=f.getBoundingClientRect();
    const top=r.top+window.scrollY;
    const pg=Math.floor(top/PAGE);
    const rem=PAGE*(pg+1)-top;
    return {i,src:im?(im.currentSrc||im.getAttribute('src')||'').split('/').pop().slice(0,44):null,
      top:Math.round(top),h:Math.round(r.height),pg,rem:Math.round(rem),fitsNow:r.height<=rem};
  });
  const wr=wrap.getBoundingClientRect();
  const sr=show.getBoundingClientRect();
  return JSON.stringify({PAGE:Math.round(PAGE*1000)/1000,
    docH:document.documentElement.scrollHeight,
    wrapTop:Math.round(wr.top+window.scrollY),
    showTop:Math.round(sr.top+window.scrollY),showW:Math.round(sr.width),showH:Math.round(sr.height),
    figs:rows});
})()`;

// ---------------- 主循环 ----------------
const results = [];
for (let i = 0; i < ARTICLES.length; i++) {
  const a = ARTICLES[i];
  note(`\n===== [${i + 1}/${ARTICLES.length}] ${a.title} =====`);
  const meta = { ...a, phases: {}, ms: {} };

  ts = Date.now();
  const sw = await ev(JS_SWITCH(a.title));
  meta.ms.switch = Date.now() - ts;
  meta.phases.switch = sw;
  if (sw?.mode !== "already" && sw?.mode !== "clicked") {
    meta.fatal = `switch:${sw?.mode}`;
    results.push(meta);
    continue;
  }

  ts = Date.now();
  const st = await ev(JS_STABILIZE_LITE);
  meta.ms.stabilizeLite = Date.now() - ts;
  meta.phases.stabilizeLite = st;

  ts = Date.now();
  const dp = await ev(JS_DUMP);
  meta.ms.dump = Date.now() - ts;
  meta.phases.dump = dp;
  save(`r2-${a.tag}-dump.json`, dp);
  note(`[dump] figs=${dp.figCount} lastIsLast=${dp.lastFigIsLastChild} afterLast=${dp.afterLastFig}`);

  ts = Date.now();
  const cl = await ev(JS_CLEANUP);
  meta.ms.cleanup = Date.now() - ts;
  meta.phases.cleanup = { ok: cl.ok, docHBefore: cl.docHBefore, docHAfter: cl.docHAfter, tailChain: cl.tailChain, residual: cl.residual };

  ts = Date.now();
  const pm = await ev(JS_PAGEMAP);
  meta.ms.pagemap = Date.now() - ts;
  meta.phases.pagemap = pm;
  save(`r2-${a.tag}-pagemap.json`, pm);
  note(`[pagemap] docH=${pm.docH} showW=${pm.showW} figs=${JSON.stringify(pm.figs?.map(f=>({i:f.i,pg:f.pg,top:f.top,h:f.h,rem:f.rem,fit:f.fitsNow})) ?? pm)}`);

  // 零丢失基线：cleanup 后 body.innerText（display:none 已被 innerText 排除）
  ts = Date.now();
  const txt = await evText(`document.body.innerText`, st?.bodyLen ? st.bodyLen + 1200 : 6000);
  meta.ms.textFetch = Date.now() - ts;
  fs.writeFileSync(path.join(SCRATCH, `${a.tag}-dom-inner.txt`), txt);
  meta.innerTextChars = txt.replace(/\s/g, "").length;
  meta.innerTextFetched = txt.length;

  if (a.print) {
    ts = Date.now();
    let pr = null;
    try {
      pr = await cdpPrint(path.join(SCRATCH, `${a.tag}-before.pdf`));
    } catch (e) {
      pr = { ok: false, err: String(e) };
    }
    meta.ms.print = Date.now() - ts;
    meta.phases.print = pr;
    note(`[print] ${JSON.stringify(pr)}`);
  }
  meta.ms.total = Object.values(meta.ms).reduce((x, y) => x + y, 0);
  results.push(meta);
}

save("r2-98-results.json", results);
save("r2-99-log.json", log);
note("===== DONE =====");
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
