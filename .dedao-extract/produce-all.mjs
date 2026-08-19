#!/usr/bin/env node
// [已废弃 2026-08-19] 正典引擎 = 得到_薛兆丰的经济学/.engine/engine.mjs（v3）。本文件为 v2 期草稿，勿用于生产。
/**
 * produce-all.mjs — 薛兆丰经济学课 全量子章节 PDF 生产线（v2 管线，断点续跑）
 *
 * 裁决（性能 vs 质量，P14 §4.2 + 本轮实测）：
 *  - 单 Chrome(9226, 隐藏态) 1-tab 串行：每章 15-25s（switch+stabilize+闭环 2-3 print+快测）。
 *    实测枚举全课程共 419 子章节（14 模块；用户预估 113 偏低）→ 全量 ≈ 1.7-2.9h；
 *    2-tab 流水理论 1.5-2× 但放大 P16 可见面与内存面 → **从 1-tab 起步**。
 *  - 多 Chrome 实例否决（profile 冷拷贝+可见窗口管理面倍增）。
 *  - skill 化否决为主形态（每章一次 agent 调用 = token/延迟放大）；**工作流脚本为主**，
 *    幂等+断点续跑使失败重跑成本 O(1 章)，QC 硬门禁（文字零丢失/promo 零出现）逐章强制。
 *  - 出厂墨迹抽检（pdftoppm 慢，含课程表章单页可达分钟级）不进本章内联，
 *    跑完后用 qc-final.mjs 模式对 chunked/带洞章抽样。
 *
 * 用法：
 *   LASSO_CDP_PORT=9226 node produce-all.mjs            # 全量（自动枚举+断点续跑）
 *   LASSO_CDP_PORT=9226 node produce-all.mjs --dry      # 仅枚举章节清单不打印（已验证：419 章/14 模块）
 *   LASSO_CDP_PORT=9226 node produce-all.mjs --only="第003讲丨看得见的和看不见的"
 *
 * 状态：BASE/.production-state.json（done 章节跳过；--retry-failed 重试失败章）
 * 静默：禁开新窗；每章后 chromeGuard() PID 定向复隐（P16）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { holeReport, promoInPdf, textZeroLoss, chromeGuard, pdfImages, PAGE_CSS } from "./analyze.mjs";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const SCRATCH = path.join(OUT, "scratch");
const BASE = "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学";
const STATE = path.join(BASE, ".production-state.json");
const TARGET = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
const CDP = "http://127.0.0.1:9226";
const PROMO_MD5 = "7127ed550d5aeb9b75697030579c9aa4";

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry");
const ONLY = (ARGS.find((a) => a.startsWith("--only=")) || "").slice(7) || null;

const log = [];
const t0 = Date.now();
const save = (n, o) => fs.writeFileSync(path.join(OUT, n), typeof o === "string" ? o : JSON.stringify(o, null, 2));
const note = (m) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`; console.log(l); log.push(l); };
const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { chapters: {} });
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

// ---------------- 直连 CDP printToPDF ----------------
async function cdpPrint(outName) {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const tab = tabs.find((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"));
  if (!tab) return { ok: false, err: "no-dedao-tab" };
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(`ws:${String(e)}`)); });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}:${JSON.stringify(m.error)}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    const r = await send("Page.printToPDF", {
      landscape: false, printBackground: true, paperWidth: 8.268, paperHeight: 11.693,
      marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4, scale: 1, preferCSSPageSize: false,
    });
    const buf = Buffer.from(r.data, "base64");
    const p = path.join(SCRATCH, outName);
    fs.writeFileSync(p, buf);
    return { ok: true, bytes: buf.length, path: p };
  } finally { ws.close(); }
}

// ---------------- lasso MCP ----------------
const client = new Client({ name: "dedao-produce-all", version: "2.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-prod-stderr.log"))}`],
  cwd: ROOT, env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
async function browse(action, options = {}, timeoutMs = 180000) {
  const res = await client.callTool({ name: "browse_logged_in", arguments: { url: TARGET, action, options } }, undefined, { timeout: timeoutMs });
  return JSON.parse(res.content[0].text);
}
async function ev(js, timeoutMs = 120000) {
  const r = await browse("evaluate", { js }, timeoutMs);
  const p = r?.data?.preview ?? "";
  if (r?.outcome !== "worked" && r?.outcome !== undefined) return { _fatal: true, outcome: r.outcome, error: r.error };
  try { const v = JSON.parse(p); if (v && v.err && typeof v.err === "string") v._fatal = true; return v; } catch { return { _fatal: true, raw: p.slice(0, 300) }; }
}

// ---------------- DOM 片段（extract-v2 已验证原样复用；SWITCH 升级为全侧栏扫描） ----------------
const JS_SWITCH = (want) => `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const want=${JSON.stringify(want)};
  const cur=q('div.article-body-wrap .article-title');
  const curT=cur?(cur.textContent||'').trim():'';
  if(curT===want){return JSON.stringify({mode:'already',title:curT});}
  const norm=(s)=>(s||'').trim().replace(/\\s+/g,' ');
  const ps=q('div.course-nav div.ps');
  if(!ps){return JSON.stringify({mode:'nops',curTitle:curT});}
  // 虚拟列表全扫描（P7/P18）：从 0 逐步滚到底，每步找目标 li
  const find=()=>[...document.querySelectorAll('div.course-nav ul.course-module>li')]
    .find(li=>norm(li.textContent).startsWith(want));
  let li=find();
  const step=Math.max(200,Math.floor(ps.clientHeight*0.8));
  for(let y=0;y<=ps.scrollHeight+step&&!li;y+=step){
    ps.scrollTop=y;
    await new Promise(r=>setTimeout(r,350));
    li=find();
    if(y>60000)break;
  }
  if(!li){ps.scrollTop=0;await new Promise(r=>setTimeout(r,500));li=find();}
  if(!li){return JSON.stringify({mode:'notfound',curTitle:curT});}
  li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  const t0=Date.now();
  while(Date.now()-t0<25000){
    await new Promise(r=>setTimeout(r,400));
    const t=q('div.article-body-wrap .article-title');
    const tt=t?(t.textContent||'').trim():'';
    if(tt===want){return JSON.stringify({mode:'clicked',title:tt});}
  }
  return JSON.stringify({mode:'timeout'});
})()`;

const JS_STABILIZE = `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const body=q('div.article-body-wrap .article-body');
  if(!body) return JSON.stringify({ok:false,err:'no-body'});
  let last=-1,stable=0;
  for(let i=0;i<40;i++){
    const len=(body.innerText||'').length+body.querySelectorAll('img').length*1000;
    if(len===last){stable++;if(stable>=3)break;}else{stable=0;last=len;}
    await new Promise(r=>setTimeout(r,400));
  }
  const H=Math.max(document.scrollingElement?document.scrollingElement.scrollHeight:0,document.documentElement.scrollHeight);
  const step=Math.max(600,Math.floor(window.innerHeight*1.5));
  let n=0;
  for(let y=0;y<H&&n<90;y+=step,n++){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,150));}
  window.scrollTo(0,H);await new Promise(r=>setTimeout(r,600));
  let imgs=[];
  for(let i=0;i<25;i++){
    imgs=[...document.querySelectorAll('div.article-body img')];
    if(imgs.every(im=>im.complete&&(im.naturalWidth>0||!im.src)))break;
    await new Promise(r=>setTimeout(r,400));
  }
  window.scrollTo(0,0);await new Promise(r=>setTimeout(r,400));
  try{await document.fonts.ready;}catch(e){}
  return JSON.stringify({ok:true,bodyLen:(body.innerText||'').length,imgs:imgs.length,imgsNotLoaded:imgs.filter(im=>!(im.complete&&im.naturalWidth>0)).length,docH:document.documentElement.scrollHeight});
})()`;

const JS_ASSERT = `return (()=>{
  const q=(s)=>document.querySelector(s);
  const wrap=q('div.article > div.article-wrap > div.article-body-wrap');
  const title=q('div.article-body-wrap .article-title');
  const body=wrap?wrap.querySelector('.article-body'):null;
  return JSON.stringify({
    url:location.href, title:title?(title.textContent||'').trim().slice(0,40):null,
    hasWrap:!!wrap, cover:!!(wrap&&wrap.querySelector('.article-cover')),
    ddAudio:wrap?wrap.querySelectorAll('.dd-audio').length:0,
    timeInfo:!!(wrap&&wrap.querySelector(':scope > div.article-time-info')),
    bodyLen:body?(body.innerText||'').length:0
  });
})()`;

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
  chainEls.forEach(e=>{e.style.setProperty('margin-bottom','0','important');e.style.setProperty('padding-bottom','0','important');});
  rep.docHAfter=document.documentElement.scrollHeight;
  rep.residual={cover:qa('.article-cover').length,ddAudio:qa('.dd-audio').length,timeInfo:qa('.article-time-info').length,myComment:qa('.my-comment').length,messageV2:qa('.message-v2').length};
  return JSON.stringify(rep);
})()`;

const JS_INNERTEXT = `return (()=>{
  const wrap=document.querySelector('div.article > div.article-wrap > div.article-body-wrap');
  return JSON.stringify({t:(wrap?wrap.innerText||'':'')});
})()`;

const JS_PROMO_AUDIT = `return (async()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const figs=[...show.querySelectorAll('figure')];
  const last=figs[figs.length-1];
  if(!last) return JSON.stringify({figCount:0,decision:'no-figure'});
  const img=last.querySelector('img');
  const src=img?(img.currentSrc||img.src||''):null;
  const after=[...last.parentElement.children].slice([...last.parentElement.children].indexOf(last)+1);
  const afterTxt=after.map(n=>(n.innerText||'').trim().replace(/\\s+/g,' ').slice(0,30)).filter(Boolean);
  let fetchBytes=null;
  try{const resp=await fetch(src);fetchBytes=(await resp.arrayBuffer()).byteLength;}catch(e){fetchBytes='fetch-fail';}
  const m2=img&&img.naturalWidth===1080&&img.naturalHeight===607;
  const m3=src?/2017022\\d{12,}\\.(jpg|png)/.test(src):false;
  const m4=afterTxt.length===0;
  return JSON.stringify({figCount:figs.length,lastSrc:src?src.split('/').pop():null,srcAbs:src,
    lastNat:img?img.naturalWidth+'x'+img.naturalHeight:null,M2:!!m2,M3:m3,M4:m4,afterSummary:afterTxt,fetchBytes,
    decision:(m2&&m3&&m4)?'drop':'keep-watch'});
})()`;

const JS_FIGS = `return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const wrapTop=(()=>{let e=show,y=0;while(e){y+=e.offsetTop;e=e.offsetParent;}return y;})();
  const PAGE=${PAGE_CSS};
  const figs=[...show.querySelectorAll('figure')].map((f,i)=>{
    const img=f.querySelector('img');
    const r=f.getBoundingClientRect();
    const rel=Math.round(r.top+window.scrollY)-wrapTop;
    const pg=Math.floor(rel/PAGE);
    return {i,src:img?(img.currentSrc||img.src||'').split('/').pop():null,
      natW:img?img.naturalWidth:0,natH:img?img.naturalHeight:0,
      chunked:f.hasAttribute('data-dz-chunked'),
      figH:Math.round(r.height),rel,pg};
  });
  return JSON.stringify({PAGE,figs,docH:document.documentElement.scrollHeight});
})()`;

const JS_FIX_SCREEN = `return (async()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const rep={dropped:[],shrunk:[],skipped:[],chunked:[]};
  const wrapTop=(()=>{let e=show,y=0;while(e){y+=e.offsetTop;e=e.offsetParent;}return y;})();
  const PAGE=${PAGE_CSS};
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
    if(m2&&m3&&m4){rep.dropped.push({src:src.split('/').pop(),nat:img.naturalWidth+'x'+img.naturalHeight});last.remove();figs.pop();}
    else rep.skipped.push({why:'last-fig-not-promo(m2m3m4-fail)',m2:!!m2,m3,m4,src:src?src.split('/').pop():null,afterSummary:afterTxt});
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
      f.innerHTML='';
      f.appendChild(frag);
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
  return JSON.stringify(rep);
})()`;

// ---------------- 枚举（虚拟侧栏全扫描，分步跨多次 evaluate——单调用受 60s MCP 上限约束） ----------------
const JS_ENUM_STEP = `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const ps=q('div.course-nav div.ps');
  if(!ps) return JSON.stringify({err:'no-ps'});
  if(!window.__dzEnum){
    window.__dzEnum={y:0,map:new Map(),rounds:0};
    ps.scrollTop=0;
    await new Promise(r=>setTimeout(r,400));
  }
  const E=window.__dzEnum;
  const snap=()=>{
    for(const ul of document.querySelectorAll('div.course-nav ul.course-module')){
      let modName='';
      let p=ul.previousElementSibling;
      while(p&&!modName){const t=(p.textContent||'').trim();if(t)modName=t.slice(0,40);p=p.previousElementSibling;}
      for(const li of ul.children){
        const raw=(li.textContent||'').trim().replace(/\\s+/g,' ');
        const title=raw.split(/\\s+\\d[\\d,]*(分\\d+秒|人学过)/)[0].trim();
        if(title&&!E.map.has(title))E.map.set(title,{title,module:modName});
      }
    }
  };
  const step=Math.max(200,Math.floor(ps.clientHeight*0.8));
  const t0=Date.now();
  let prevSH=-1;
  while(Date.now()-t0<6000){
    snap();
    if(E.y>ps.scrollHeight+step*2){break;}
    ps.scrollTop=E.y;
    await new Promise(r=>setTimeout(r,250));
    E.y+=step;
    if(ps.scrollHeight!==prevSH&&ps.scrollHeight<E.y){prevSH=ps.scrollHeight;}
    if(E.y>160000){break;}
  }
  snap();
  const done=E.y>ps.scrollHeight;
  if(done){ps.scrollTop=0;await new Promise(r=>setTimeout(r,300));}
  return JSON.stringify({done,count:E.map.size,y:E.y,sh:ps.scrollHeight});
})()`;

const JS_ENUM_LIST = (i) => `return (()=>{
  const E=window.__dzEnum;
  if(!E) return JSON.stringify({err:'no-state'});
  const all=[...E.map.values()];
  const CH=20;
  const slice=all.slice(${i}*CH,(${i}+1)*CH);
  return JSON.stringify({i:${i},total:all.length,slice});
})()`;

async function enumerate() {
  let done = false, count = 0;
  for (let k = 0; k < 40 && !done; k++) {
    const r = await ev(JS_ENUM_STEP, 50000);
    if (r?._fatal) { note(`[enum-step${k}] fatal ${JSON.stringify(r).slice(0, 120)}`); return null; }
    if (r?.err) { note(`[enum-step${k}] err ${r.err}`); return null; }
    done = !!r?.done; count = r?.count ?? count;
    if (k % 5 === 0) note(`[enum] step${k} count=${r?.count} y=${r?.y}/${r?.sh}`);
  }
  if (!done) { note("[enum] 40 步未收敛"); return null; }
  const list = [];
  for (let i = 0; i * 20 < count && i < 40; i++) {
    const r = await ev(JS_ENUM_LIST(i), 50000);
    if (r?._fatal || !r?.slice) { note(`[enum-list${i}] fatal`); return null; }
    list.push(...r.slice);
  }
  return { done, count, list };
}

// ---------------- 对齐与目标（extract-v2 同款） ----------------
function alignFigures(figs, pdf) {
  const rows = pdfImages(pdf).sort((a, b) => a.page - b.page);
  const out = figs.map((f) => ({ ...f, actualPage: null, printImgH: null }));
  const match = (f, r) => f.natW === r.w && f.natH === r.h;
  let di = 0;
  for (const r of rows) {
    if (di < out.length && match(out[di], r)) { out[di].actualPage = r.page; out[di].printImgH = Math.round((r.h / r.yppi) * 96); di++; continue; }
    const k = out.findIndex((f, j) => j >= di && match(f, r));
    if (k === -1) continue;
    di = k; out[di].actualPage = r.page; out[di].printImgH = Math.round((r.h / r.yppi) * 96); di++;
  }
  return out;
}
function targetsForHoles(holes, aligned) {
  const targets = [];
  for (const h of holes) {
    const holeCss = (h.tailPt * 96) / 72;
    const cand = aligned.filter((f) => !f.chunked && f.actualPage === h.page + 1 && f.printImgH > holeCss * 0.5);
    if (!cand.length) { targets.push({ holePage: h.page, holeCss: Math.round(holeCss), unfixable: "no-figure-on-next-page" }); continue; }
    const t = cand[0];
    const mh = Math.round(holeCss - 42);
    if (mh < 120) { targets.push({ holePage: h.page, holeCss: Math.round(holeCss), unfixable: `mh-below-floor(${mh})`, targetIdx: t.i }); continue; }
    targets.push({ holePage: h.page, holeCss: Math.round(holeCss), idx: t.i, src: t.src, fromPrintH: t.printImgH, mh });
  }
  return targets;
}
const sanitizeDir = (m) => m.replace(/\s*[|\uff5c]\s*/g, "-").replace(/[\/:]/g, "-").trim();

// ---------------- 主流程 ----------------
const nav = await browse("navigate", {});
if (nav.outcome !== "worked") { note(`[FATAL] navigate ${nav.outcome}`); process.exit(1); }
note("[navigate] worked");
let ready = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1200));
  ready = await ev(`return JSON.stringify({rs:document.readyState,title:(document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,40),len:(document.body&&document.body.innerText||'').length});`);
  if (ready?.rs === "complete" && (ready?.len ?? 0) > 800 && ready?.title) break;
}
note(`[ready] ${ready?.title}`);

const en = await enumerate();
save("prod-enumeration.json", en);
if (!en?.list?.length) { note(`[FATAL] 枚举失败 ${JSON.stringify(en).slice(0, 200)}`); process.exit(1); }
const chapters = en.list
  .map((c) => ({ ...c, chapterDir: sanitizeDir(c.module), num: (c.title.match(/第(\d+)讲/) || [0, 0])[1] }))
  .sort((a, b) => a.chapterDir.localeCompare(b.chapterDir, "zh") || (+a.num - +b.num) || a.title.localeCompare(b.title, "zh") || 0);
note(`[enumerate] ${chapters.length} 子章节，模块 ${[...new Set(chapters.map((c) => c.chapterDir))].length} 个`);
if (DRY) {
  save("prod-chapters-dry.json", chapters);
  note("[dry] 清单已写 prod-chapters-dry.json，退出");
  note(`[guard-final] ${JSON.stringify(chromeGuard())}`);
  await transport.close(); process.exit(0);
}

const state = loadState();
let ok = 0, fail = 0, skip = 0;
const started = Date.now();
for (let i = 0; i < chapters.length; i++) {
  const a = chapters[i];
  if (ONLY && a.title !== ONLY) continue;
  const prev = state.chapters[a.title];
  if (prev?.status === "done" && fs.existsSync(prev.pdfPath)) { skip++; continue; }
  if (prev?.attempts >= 2 && prev?.status === "failed") { skip++; continue; }
  const tag = `p-${String(i).padStart(3, "0")}`;
  note(`\n===== [${i + 1}/${chapters.length}] ${a.title} =====`);
  const meta = { title: a.title, chapterDir: a.chapterDir, attempts: (prev?.attempts || 0) + 1, startedAt: new Date().toISOString() };
  try {
    const sw = await ev(JS_SWITCH(a.title));
    if (sw?._fatal || (sw?.mode !== "already" && sw?.mode !== "clicked")) throw new Error(`switch:${sw?.mode ?? JSON.stringify(sw).slice(0, 80)}`);
    const st = await ev(JS_STABILIZE, 180000);
    if (!st?.ok) throw new Error(`stabilize:${st?.err}`);
    const asr = await ev(JS_ASSERT);
    if (!asr?.hasWrap || !asr?.timeInfo || asr?.title !== a.title) throw new Error(`assert:${JSON.stringify(asr).slice(0, 120)}`);
    const cl = await ev(JS_CLEANUP);
    if (!cl?.ok || (cl.residual && (cl.residual.cover || cl.residual.ddAudio || cl.residual.timeInfo || cl.residual.myComment || cl.residual.messageV2))) throw new Error(`cleanup:${JSON.stringify(cl.residual)}`);
    const it = await ev(JS_INNERTEXT);
    const inner = it.t || "";
    const pa = await ev(JS_PROMO_AUDIT);
    meta.promoAudit = { decision: pa?.decision, lastSrc: pa?.lastSrc, M2: pa?.M2, M3: pa?.M3, M4: pa?.M4 };
    const fx = await ev(JS_FIX_SCREEN);
    if (fx?._fatal || typeof fx?.dropped !== "object") throw new Error(`fix-screen:${JSON.stringify(fx).slice(0, 120)}`);
    meta.dropped = fx.dropped; meta.chunked = fx.chunked; meta.shrunk = fx.shrunk;
    const it2 = await ev(JS_INNERTEXT);
    if ((it2.t || "") !== inner) throw new Error("inner-text-changed-by-fix");
    let iter = 0, pdfPath = null;
    const prints = [];
    while (iter <= 2) {
      iter++;
      const pr = await cdpPrint(`${tag}-it${iter}.pdf`);
      if (!pr.ok) throw new Error(`print:${pr.err}`);
      pdfPath = pr.path;
      const holes = holeReport(pdfPath).holes;
      prints.push({ iter, path: pdfPath, holes });
      meta.iterations = prints.map((p) => ({ iter: p.iter, holes: p.holes.map((h) => `p${h.page}:${h.tailPct}%`) }));
      note(`  [it${iter}] holes=${meta.iterations.at(-1).holes.join(",") || "none"}`);
      if (!holes.length || iter > 2) break;
      const figsNow = await ev(JS_FIGS);
      const aligned = alignFigures(figsNow.figs, pdfPath);
      const targets = targetsForHoles(holes, aligned);
      const appl = targets.filter((t) => !t.unfixable);
      if (!appl.length) break;
      await ev(JS_FIX_PRINT(appl));
    }
    const score = (hs) => hs.reduce((s, h) => s + h.tailPct, 0) + hs.length * 0.01;
    prints.sort((x, y) => score(x.holes) - score(y.holes));
    pdfPath = prints[0].path;
    const qc = {};
    qc.zeroLoss = textZeroLoss(pdfPath, inner);
    qc.promo = promoInPdf(pdfPath).length;
    qc.holes = holeReport(pdfPath).holes.length;
    qc.pages = holeReport(pdfPath).pages;
    meta.qc = { missingEmpty: qc.zeroLoss.missingEmpty, inOrder: qc.zeroLoss.inOrder, promo: qc.promo, holes: qc.holes, pages: qc.pages };
    if (!(qc.zeroLoss.missingEmpty && qc.zeroLoss.inOrder && qc.promo === 0)) throw new Error(`qc:${JSON.stringify(meta.qc)}`);
    const outDir = path.join(BASE, a.chapterDir);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${a.title}.pdf`);
    fs.copyFileSync(pdfPath, outPath);
    meta.pdfPath = outPath; meta.pdfBytes = fs.statSync(outPath).size;
    meta.sha256 = createHash("sha256").update(fs.readFileSync(outPath)).digest("hex");
    meta.status = "done"; meta.finishedAt = new Date().toISOString();
    state.chapters[a.title] = meta; saveState(state);
    ok++;
    note(`  [OK] ${qc.pages}p holes=${qc.holes} promo=0 -> ${outPath}`);
  } catch (e) {
    meta.status = "failed"; meta.error = String(e).slice(0, 300);
    state.chapters[a.title] = meta; saveState(state);
    fail++;
    note(`  [FAIL] ${meta.error}`);
  }
  const g = chromeGuard();
  if (g.was === "visible") note(`  [guard] rehidden pid=${g.pid}`);
}
saveState(state);
note(`\n===== DONE ok=${ok} fail=${fail} skip=${skip} 用时 ${((Date.now() - started) / 60000).toFixed(1)}min =====`);
const failed = Object.values(state.chapters).filter((c) => c.status === "failed");
if (failed.length) note(`失败章（重跑：node produce-all.mjs --retry-failed 或 --only="标题"）：\n${failed.map((f) => `  ${f.title}: ${f.error}`).join("\n")}`);
note(`[guard-final] ${JSON.stringify(chromeGuard())}`);
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
