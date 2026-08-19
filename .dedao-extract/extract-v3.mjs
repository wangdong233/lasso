#!/usr/bin/env node
/**
 * extract-v3.mjs — 清理管线 v3 = v2 + ①课后思考整段删除 + ②每章 .md + 本地 images/ 正典产物
 *
 * v3 增量（用户 2026-08-19 新要求）：
 *   ①课后思考：div.article-header.header-2 文本恰为「课后思考」→ 删 header + 后随内容兄弟
 *     （停止界：下一 article-header / 任意 figure / 空 junk；div.tips 注释保留——红线保守）。
 *     删前 DOM 断言（headerIndex/phraseCount/otherHits/deleted 明细）全部落 meta。
 *   ②MD=规范化中间产物：清理后 DOM → markdown（标题/段落/列表/图/注释块），
 *     图片下载到 <模块目录>/images/ 并改相对引用；PDF 仍为单章预览。
 * 宪法不变：文字绝对不可丢（基准=课后思考删除后的 cleanup 态 innerText，刻意删除有审计）；
 *   宣传图 M2∧M3∧M4 位置门控删除；S-A/S-A' 分页闭环；静默+PID 定向复隐。
 * 白盒依据：P14 §7（v2 配方）+ s9-sikao.json（课后思考结构 3 章实证）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { holeReport, promoInPdf, textZeroLoss, chromeGuard, PAGE_CSS } from "./analyze.mjs";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const SCRATCH = path.join(OUT, "scratch");
const BASE = "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学";
const TARGET = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
const CDP = "http://127.0.0.1:9226";
const PROMO_MD5 = "7127ed550d5aeb9b75697030579c9aa4";
const SIKAO = "课后思考";

const ARTICLES = [
  { tag: "fk", chapterDir: "课前必读(1讲)", title: "发刊词丨只给你地道的经济学思维", expectAudio: false },
  { tag: "l001", chapterDir: "01-经济学本源之一：东西不够(110讲)", title: "第001讲丨战俘营里的经济组织", expectAudio: true },
  { tag: "l002", chapterDir: "01-经济学本源之一：东西不够(110讲)", title: "第002讲丨马粪争夺案", expectAudio: true },
];

const log = [];
const t0 = Date.now();
const save = (n, o) => fs.writeFileSync(path.join(OUT, n), typeof o === "string" ? o : JSON.stringify(o, null, 2));
const note = (m) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`; console.log(l); log.push(l); };

// ---------------- 直连 CDP printToPDF（batch3/v2 同参数） ----------------
async function cdpPrint(outName) {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const tab = tabs.find((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"));
  if (!tab) return { ok: false, err: "no-dedao-tab" };
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(`ws:${String(e)}`)); });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}:${JSON.stringify(m.error)}`)) : res(m.result)));
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
    const p = path.join(SCRATCH, outName);
    fs.writeFileSync(p, buf);
    return { ok: true, bytes: buf.length, path: p };
  } finally { ws.close(); }
}

// ---------------- lasso MCP ----------------
const client = new Client({ name: "dedao-extract-v3", version: "3.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-v3-stderr.log"))}`],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
async function browse(action, options = {}, timeoutMs = 180000) {
  const res = await client.callTool({ name: "browse_logged_in", arguments: { url: TARGET, action, options } }, undefined, { timeout: timeoutMs });
  return JSON.parse(res.content[0].text);
}
async function ev(js, timeoutMs = 120000) {
  const r = await browse("evaluate", { js }, timeoutMs);
  const p = r?.data?.preview ?? "";
  if (r?.outcome !== "worked" && r?.outcome !== undefined) return { _outcome: r.outcome, _error: r.error };
  try { return JSON.parse(p); } catch { return { _raw: p.slice(0, 500) }; }
}

// ---------------- DOM 片段（v2 验证配方原样 + v3 增量） ----------------
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
    url:location.href,
    title:title?(title.textContent||'').trim().slice(0,40):null,
    hasWrap:!!wrap, cover:!!(wrap&&wrap.querySelector('.article-cover')),
    ddAudio:wrap?wrap.querySelectorAll('.dd-audio').length:0,
    audioTags:wrap?wrap.querySelectorAll('audio').length:0,
    timeInfo:!!(wrap&&wrap.querySelector(':scope > div.article-time-info')),
    bodyLen:body?(body.innerText||'').length:0
  });
})()`;

// batch3 v3.1 清理（v2 原样：排除清单 + 高度归一化 + 尾部 margin 归零）
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
  chainEls.forEach(e=>{e.style.setProperty('margin-bottom','0','important');e.style.setProperty('padding-bottom','0','important');});
  rep.docHAfter=document.documentElement.scrollHeight;
  rep.residual={cover:qa('.article-cover').length,ddAudio:qa('.dd-audio').length,timeInfo:qa('.article-time-info').length,myComment:qa('.my-comment').length,messageV2:qa('.message-v2').length};
  return JSON.stringify(rep);
})()`;

// ===== v3 增量①：课后思考整段删除（删前断言审计 + 位置门控删除一体） =====
// 判据（s9-sikao.json 3 章白盒）：顶层 div.article-header.header-2 文本恰=「课后思考」；
// 段范围 = header 起的后随兄弟，停止界=下一 article-header / 任意 figure / 空 junk；
// div.tips（注释/引证）跨段保留——文字红线保守侧。刻意删除 ≠ 丢失：明细全落审计。
const JS_SIKAO_DEL = `return (()=>{
  const body=document.querySelector('div.article-body-wrap .article-body');
  const show=body?(body.querySelector('.editor-show')||body):null;
  if(!show) return JSON.stringify({err:'no-show'});
  const kids=[...show.children];
  const isHeader=(el)=>el&&el.tagName==='DIV'&&el.classList&&el.classList.contains('article-header');
  const headers=kids.filter(isHeader);
  const target=headers.find(h=>(h.textContent||'').trim()===${JSON.stringify(SIKAO)});
  const rep={found:!!target,headerCount:headers.length,
    headersText:headers.map(h=>(h.textContent||'').trim().slice(0,16)),
    phraseCount:(show.innerText||'').split(${JSON.stringify(SIKAO)}).length-1};
  if(!target) return JSON.stringify(rep);
  rep.headerIndex=kids.indexOf(target);
  // 断言：除目标 header 外的叶子级命中（正文合法提及不阻断，仅记录）
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
  rep.docHAfter=document.documentElement.scrollHeight;
  return JSON.stringify(rep);
})()`;

const JS_INNERTEXT = `return (()=>{
  const wrap=document.querySelector('div.article > div.article-wrap > div.article-body-wrap');
  return JSON.stringify({t:(wrap?wrap.innerText||'':'')});
})()`;

// 宣传图判据审计（v2 原样：M2∧M3∧M4）
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

// figure pagemap（v2 原样）
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
    return {i,src:img?(img.currentSrc||img.src||'').split('/').pop():null,
      natW:img?img.naturalWidth:0,natH:img?img.naturalHeight:0,
      chunked:f.hasAttribute('data-dz-chunked'),
      figH:Math.round(r.height),imgH:ir?Math.round(ir.height):0,mh:img?(img.style.maxHeight||null):null,rel,pg};
  });
  return JSON.stringify({PAGE,figs,docH:document.documentElement.scrollHeight});
})()`;

// S-A 首过（v2 原样：删宣传图 + 逐图缩放 + 超页高条带化 + orphans/widows）
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

// S-A' 打印反馈过（v2 原样）
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

// ===== v3 增量②：清理后 DOM → 结构化块（MD 正典源；条带化 figure 折叠为单图） =====
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
    // 可见性门：与 innerText/print 语义对齐——display:none 与 fixed/absolute 浮层不进 MD
    const cs=getComputedStyle(c);
    if(cs.display==='none') continue;
    if(cs.position==='fixed'||cs.position==='absolute') continue;
    const tg=c.tagName.toLowerCase();
    const cls=(typeof c.className==='string'&&c.classList&&c.classList.contains)?Array.from(c.classList):[];
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
  window.__dzMd={blocks,imgs};
  return JSON.stringify({n:blocks.length,imgs:imgs.length,unknown,title:(titleEl?(titleEl.textContent||'').trim():'')});
})()`;
const JS_MD_SLICE = (i, ch) => `return (()=>{
  const M=window.__dzMd;
  if(!M) return JSON.stringify({err:'no-state'});
  return JSON.stringify({i:${i},blocks:M.blocks.slice(${i}*${ch},(${i}+1)*${ch}),imgs:M.imgs});
})()`;

// ---------------- DOM↔PDF 对齐 + 洞→缩放目标（v2 原样） ----------------
import { pdfImages } from "./analyze.mjs";
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

// ---------------- MD 渲染 + 图片落地（Node 侧） ----------------
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
  L.push("pipeline: extract-v3（cleanup + 课后思考整段删除 + 宣传图位置门控删除 + 分页适配）");
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
  for (const src of imgs) {
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
  meta.images = report;
  return imgMap;
}

// ---------------- 主流程 ----------------
let nav = await browse("navigate", {});
save("v3-01-navigate.json", nav);
if (nav.outcome !== "worked") { note(`[FATAL] navigate ${nav.outcome}`); save("v3-99-log.json", log); process.exit(1); }
note(`[navigate] worked`);
let ready = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1200));
  ready = await ev(`return JSON.stringify({rs:document.readyState,title:(document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,40),len:(document.body&&document.body.innerText||'').length});`);
  if (ready?.rs === "complete" && (ready?.len ?? 0) > 800 && ready?.title) break;
}
note(`[ready] ${ready?.title}`);
if (!ready?.title) { note("[FATAL] article-title 未出现"); save("v3-99-log.json", log); process.exit(1); }

const results = [];
const ONLY = process.argv[2] || null;
for (let i = 0; i < ARTICLES.length; i++) {
  const a = ARTICLES[i];
  if (ONLY && a.tag !== ONLY) continue;
  const tag = `v3-${a.tag}`;
  note(`\n===== [${i + 1}/${ARTICLES.length}] ${a.title} =====`);
  const meta = { ...a, phases: {}, droppedImages: [], iterations: [] };

  const sw = await ev(JS_SWITCH(a.title));
  meta.phases.switch = sw;
  if (sw?.mode !== "already" && sw?.mode !== "clicked") { meta.fatal = `switch_failed:${sw?.mode}`; results.push(meta); save(`${tag}-meta.json`, meta); continue; }
  note(`[switch] ${sw.mode}`);

  const st = await ev(JS_STABILIZE, 180000);
  meta.phases.stabilize = st;
  note(`[stabilize] ok=${st?.ok} imgs=${st?.imgs} notLoaded=${st?.imgsNotLoaded}`);
  if (!st?.ok) { meta.fatal = `stabilize_failed:${st?.err}`; results.push(meta); save(`${tag}-meta.json`, meta); continue; }

  const as = await ev(JS_ASSERT);
  meta.phases.assert = as;
  const assertFails = [];
  if (!as?.hasWrap) assertFails.push("no-wrap");
  if (!as?.timeInfo) assertFails.push("no-time-info");
  if (!as?.cover) assertFails.push("no-cover");
  if (as?.title !== a.title) assertFails.push(`title-mismatch:${as?.title}`);
  if (as?.ddAudio === 0 && a.expectAudio) assertFails.push("audio-but-no-dd-audio");
  meta.assertFails = assertFails;
  if (assertFails.some((f) => f.startsWith("no-wrap") || f.startsWith("no-time") || f.startsWith("title-"))) {
    meta.fatal = `assert_failed:${assertFails.join(",")}`; results.push(meta); save(`${tag}-meta.json`, meta); continue;
  }

  const cl = await ev(JS_CLEANUP);
  meta.phases.cleanup = { ok: cl?.ok, del: cl?.del, docH: [cl?.docHBefore, cl?.docHAfter], residual: cl?.residual };
  note(`[cleanup] ok=${cl?.ok} docH ${cl?.docHBefore}->${cl?.docHAfter}`);
  if (!cl?.ok || (cl.residual && (cl.residual.cover || cl.residual.ddAudio || cl.residual.timeInfo || cl.residual.myComment || cl.residual.messageV2))) {
    meta.fatal = `cleanup_residual:${JSON.stringify(cl?.residual)}`; results.push(meta); save(`${tag}-meta.json`, meta); continue;
  }

  // ===== v3①：课后思考整段删除（基准快照之前——刻意删除不入零丢失基准） =====
  const sk = await ev(JS_SIKAO_DEL);
  save(`${tag}-sikao.json`, sk);
  meta.sikao = sk;
  note(`[sikao] found=${sk?.found} headers=${JSON.stringify(sk?.headersText)} del=${sk?.deletedBlocks}块/${sk?.deletedChars}字 keptTips=${sk?.keptTips?.length} stop=${sk?.stopReason} phraseAfter=${sk?.phraseCountAfter}`);
  if (sk?.err || sk?._outcome) { meta.fatal = `sikao_eval_error:${JSON.stringify(sk).slice(0, 120)}`; results.push(meta); save(`${tag}-meta.json`, meta); continue; }
  if (sk?.found && sk?.phraseCountAfter !== (sk?.otherHits?.length || 0)) {
    meta.fatal = `sikao_residual_phrase:${sk?.phraseCountAfter}vsOtherHits${sk?.otherHits?.length}`;
    results.push(meta); save(`${tag}-meta.json`, meta); continue;
  }

  // 清理+课后思考删除态 innerText（零丢失基准）
  const it = await ev(JS_INNERTEXT);
  const innerPath = path.join(SCRATCH, `${tag}-clean-inner.txt`);
  fs.writeFileSync(innerPath, it.t || "");
  note(`[innerText] ${(it.t || "").length} chars`);

  const pa = await ev(JS_PROMO_AUDIT);
  save(`${tag}-promo-audit.json`, pa);
  meta.promoAudit = pa;
  note(`[promo-audit] M2=${pa?.M2} M3=${pa?.M3} M4=${pa?.M4} decision=${pa?.decision}`);
  if (pa?.srcAbs) {
    try {
      const buf = Buffer.from(await (await fetch(pa.srcAbs, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
      meta.promoMd5 = { md5: createHash("md5").update(buf).digest("hex"), bytes: buf.length, match: createHash("md5").update(buf).digest("hex") === PROMO_MD5 };
      note(`[promo-md5] match=${meta.promoMd5.match}`);
    } catch (e) { meta.promoMd5 = { err: String(e).slice(0, 80) }; }
  }

  // S-A 首过
  const fx1 = await ev(JS_FIX_SCREEN);
  save(`${tag}-fix-screen.json`, fx1);
  meta.fixScreen = fx1;
  meta.droppedImages = fx1?.dropped ?? [];
  note(`[fix-screen] dropped=${(fx1?.dropped || []).length} shrunk=${(fx1?.shrunk || []).length} chunked=${(fx1?.chunked || []).length}`);

  const it2 = await ev(JS_INNERTEXT);
  meta.innerTextInvariant = (it2.t || "") === (it.t || "");
  note(`[innerText-invariant] ${meta.innerTextInvariant}`);

  // ===== v3②：MD 块抽取（最终 DOM 态：promo 已删/条带化已折叠） =====
  const mdb = await ev(JS_MD_BUILD);
  if (mdb?.err || mdb?._outcome) { meta.fatal = `md_build_error:${JSON.stringify(mdb).slice(0, 120)}`; results.push(meta); save(`${tag}-meta.json`, meta); continue; }
  const blocks = [], imgs = [];
  const CH = 30;
  let mdSliceErr = null;
  for (let s = 0; s * CH < mdb.n && !mdSliceErr; s++) {
    const sl = await ev(JS_MD_SLICE(s, CH));
    if (sl?.err || sl?._outcome) { mdSliceErr = `md_slice_error:${s}:${JSON.stringify(sl).slice(0, 80)}`; break; }
    blocks.push(...sl.blocks);
    if (s === 0) imgs.push(...(sl.imgs || []));
  }
  if (mdSliceErr) { meta.fatal = mdSliceErr; results.push(meta); save(`${tag}-meta.json`, meta); continue; }
  meta.md = { title: mdb.title, blocks: blocks.length, imgs: imgs.length, unknown: mdb.unknown || {} };
  note(`[md-blocks] blocks=${blocks.length} imgs=${imgs.length} unknown=${JSON.stringify(mdb.unknown || {})}`);

  // print 闭环（v2 原样）
  let iter = 0, pdfPath = null, holes = [];
  const prints = [];
  while (iter <= 2) {
    iter++;
    pdfPath = (await cdpPrint(`${tag}-it${iter}.pdf`)).path;
    holes = holeReport(pdfPath).holes;
    prints.push({ iter, path: pdfPath, holes });
    meta.iterations.push({ iter, pdf: path.basename(pdfPath), holes: holes.map((h) => ({ page: h.page, tailPct: h.tailPct })) });
    note(`[print#${iter}] holes=${JSON.stringify(holes.map((h) => `p${h.page}:${h.tailPct}%`))}`);
    if (!holes.length) break;
    if (iter > 2) break;
    const figsNow = await ev(JS_FIGS);
    save(`${tag}-figs-it${iter}.json`, figsNow);
    const aligned = alignFigures(figsNow.figs, pdfPath);
    const targets = targetsForHoles(holes, aligned);
    save(`${tag}-targets-it${iter}.json`, { aligned, targets });
    const appl = targets.filter((t) => !t.unfixable);
    if (!appl.length) { note(`[fix-print#${iter}] 无可施缩放目标，停止`); break; }
    const fr = await ev(JS_FIX_PRINT(appl));
    note(`[fix-print#${iter}] applied=${fr?.applied?.length}`);
  }
  const score = (hs) => hs.reduce((s, h) => s + h.tailPct, 0) + hs.length * 0.01;
  prints.sort((a, b) => score(a.holes) - score(b.holes));
  pdfPath = prints[0].path;
  meta.bestIter = prints[0].iter;

  // ---- 终检（v2 三门禁 + v3 两门禁：课后思考零残留 / MD 图片全落地） ----
  const finalPdf = pdfPath;
  const qc = {};
  qc.zeroLoss = textZeroLoss(finalPdf, it.t || "");
  qc.promo = promoInPdf(finalPdf);
  const hr = holeReport(finalPdf);
  qc.holes = hr.holes; qc.pages = hr.pages;
  qc.innerTextInvariant = meta.innerTextInvariant;
  // 课后思考残留门禁：PDF 内出现次数 == 基准 innerText 残留次数（both 应为 otherHits 数）
  const pdfTxt = execFileSync("pdftotext", [finalPdf, "-"], { maxBuffer: 128 << 20 }).toString();
  qc.sikaoPdfCount = pdfTxt.split(SIKAO).length - 1;
  qc.sikaoExpected = sk?.found ? (sk.otherHits || []).length : (it.t || "").split(SIKAO).length - 1;
  meta.qc = qc;
  note(`[QC] missing=${qc.zeroLoss.missing.slice(0, 5)} inOrder=${qc.zeroLoss.inOrder} promo=${qc.promo.length} holes=${qc.holes.length} pages=${qc.pages} sikao=${qc.sikaoPdfCount}/${qc.sikaoExpected}`);
  const pass = qc.zeroLoss.missingEmpty && qc.zeroLoss.inOrder && qc.promo.length === 0 && qc.innerTextInvariant && qc.sikaoPdfCount === qc.sikaoExpected;

  if (pass) {
    const outDir = path.join(BASE, a.chapterDir);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${a.title}.pdf`);
    fs.copyFileSync(finalPdf, outPath);
    meta.pdfPath = outPath;
    meta.pdfBytes = fs.statSync(outPath).size;
    meta.sha256 = createHash("sha256").update(fs.readFileSync(outPath)).digest("hex");
    // MD + images 落地
    const imgMap = await downloadImages(imgs, outDir, a.tag, meta);
    const mdPath = path.join(outDir, `${a.title}.md`);
    const head = { title: a.title, module: a.chapterDir, url: as?.url, producedAt: new Date().toISOString() };
    fs.writeFileSync(mdPath, renderMd(head, blocks, imgs, imgMap));
    meta.mdPath = mdPath;
    meta.mdBytes = fs.statSync(mdPath).size;
    if (meta.images.failed.length) note(`[WARN] 图片下载失败 ${meta.images.failed.length} 张（MD 保留远程引用）`);
    note(`[PDF v3] ${outPath} (${(meta.pdfBytes / 1024 / 1024).toFixed(2)} MiB)`);
    note(`[MD v3] ${mdPath} (${meta.mdBytes} B, imgs ${meta.images.downloaded}新+${meta.images.reused}复用)`);
  } else {
    meta.fatal = `qc_failed:${!qc.zeroLoss.missingEmpty ? "text-loss:" + qc.zeroLoss.missing.slice(0, 3) : ""}${!qc.zeroLoss.inOrder ? "+order" : ""}${qc.promo.length ? "+promo-present" : ""}${!qc.innerTextInvariant ? "+inner-changed" : ""}${qc.sikaoPdfCount !== qc.sikaoExpected ? "+sikao-residual" : ""}`;
    note(`[QC-FAIL] ${meta.fatal} — 不落正式产物`);
  }
  save(`${tag}-meta.json`, meta);
  results.push(meta);
  const g = chromeGuard();
  note(`[chrome-guard] ${JSON.stringify(g)}`);
}

save("v3-98-results.json", results);
save("v3-99-log.json", log);
note("\n===== SUMMARY =====");
for (const r of results) note(`${r.fatal ? "FAIL" : "OK  "} ${r.title} -> ${r.pdfPath ?? r.fatal}`);
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
