#!/usr/bin/env node
/**
 * extract-v2.mjs — 清理管线 v2：删尾部宣传图 + S-A/S-A' 分页连续性修复 + 三层质检
 *
 * 宪法（用户本轮）：①尾部宣传图不进 PDF（M2∧M3∧M4 判据，仅最后 figure 位置门控）；
 * ②分页连续性——图放不下优先缩小（屏幕 S-A 首过 + 打印产物反馈 S-A' 闭环 ≤2 迭代），
 *   版面微调（orphans/widows 卫生项），实在不行记问题集人工裁决（课程表等内容图不丢）；
 * ③文字绝对不可丢——每章打印前后词级零丢失验证（missing 必须为空）。
 * 白盒依据：P14-探察-二轮.md §1/§3（配方已 4/4 章验证）。
 * 静默：全程复用既有 tab，禁开新窗；每章后 chromeGuard() PID 定向复隐（P16）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { holeReport, promoInPdf, textZeroLoss, chromeGuard, PAGE_CSS } from "./analyze.mjs";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const SCRATCH = path.join(OUT, "scratch");
const BASE = "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学";
const TARGET = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
const CDP = "http://127.0.0.1:9226";
const PROMO_MD5 = "7127ed550d5aeb9b75697030579c9aa4";

const ARTICLES = [
  { tag: "fk", chapterDir: "课前必读(1讲)", title: "发刊词丨只给你地道的经济学思维", expectAudio: false },
  { tag: "l001", chapterDir: "01-经济学本源之一：东西不够(110讲)", title: "第001讲丨战俘营里的经济组织", expectAudio: true },
  { tag: "l002", chapterDir: "01-经济学本源之一：东西不够(110讲)", title: "第002讲丨马粪争夺案", expectAudio: true },
];

const log = [];
const t0 = Date.now();
const save = (n, o) => fs.writeFileSync(path.join(OUT, n), typeof o === "string" ? o : JSON.stringify(o, null, 2));
const note = (m) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`; console.log(l); log.push(l); };

// ---------------- 直连 CDP printToPDF（batch3 同参数） ----------------
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
const client = new Client({ name: "dedao-extract-v2", version: "2.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-v2-stderr.log"))}`],
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

// ---------------- 既有片段（extract-batch3.mjs 原样复用） ----------------
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

// batch3 v3.1 清理（原样：排除清单 + 高度归一化 + 尾部 margin 归零）
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
  rep.tailChain=chainEls.map(e=>e.tagName.toLowerCase()+'.'+(typeof e.className==='string'?e.className.trim().split(/\\s+/)[0]:'').slice(0,24));
  chainEls.forEach(e=>{e.style.setProperty('margin-bottom','0','important');e.style.setProperty('padding-bottom','0','important');});
  rep.docHAfter=document.documentElement.scrollHeight;
  rep.residual={cover:qa('.article-cover').length,ddAudio:qa('.dd-audio').length,timeInfo:qa('.article-time-info').length,myComment:qa('.my-comment').length,messageV2:qa('.message-v2').length};
  return JSON.stringify(rep);
})()`;

const JS_INNERTEXT = `return (()=>{
  const wrap=document.querySelector('div.article > div.article-wrap > div.article-body-wrap');
  return JSON.stringify({t:(wrap?wrap.innerText||'':'')});
})()`;

// 宣传图判据审计（删前 DOM 断言留证）：M2 尺寸 ∧ M3 src 窗口 ∧ M4 位置门控（最后 figure 且其后无正文）
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

// figure pagemap（含 src/nat/显示高/已设 max-height）——DOM↔PDF 对齐用
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

// S-A 首过（屏幕几何）：删宣传图 + 逐图缩放进屏幕剩余空间 + 超页高图条带化 + orphans/widows 卫生项
const JS_FIX_SCREEN = `return (async()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const rep={dropped:[],shrunk:[],skipped:[],chunked:[]};
  const wrapTop=(()=>{let e=show,y=0;while(e){y+=e.offsetTop;e=e.offsetParent;}return y;})();
  const PAGE=${PAGE_CSS};
  let figs=[...show.querySelectorAll('figure')];
  // 1) 宣传图：仅最后一个 figure 位置门控 + M2∧M3∧M4（与 JS_PROMO_AUDIT 同判据）
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
  // 2) 逐图：放得下不动；可缩则缩；超页高（课程表类）条带化
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
      // 超页高图：Chrome 打印把整体锁定到页边界起切片（break-inside:auto 实测无效，probe 复证）
      // → 前页必然留大洞（fk p4 62.4% 级联实证）。条带化：切成 ~88px overflow:hidden 条带块，
      //   条带可流入页内剩余空间（装箱损失 ≤88px≈8.4%<12% 门槛），后续页视觉与切片完全一致。
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
  // 3) 版面微调卫生项：文本孤行控制（S-B 附带，P14 §3 裁决允许）
  if(!document.getElementById('dz-v2-hy')){
    const st=document.createElement('style');st.id='dz-v2-hy';
    st.textContent='p{orphans:3;widows:3;}';
    document.head.appendChild(st);rep.hygiene='orphans-widows';
  }
  rep.docHAfter=document.documentElement.scrollHeight;
  return JSON.stringify(rep);
})()`;

// S-A' 打印反馈过：按 PDF 实测洞对指定 figure 设 max-height（键=doc-order index）
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

// ---------------- DOM↔PDF figure 对齐（pdfimages 落页 → 实际打印页） ----------------
// 规则：行匹配当前 DOM figure → 赋页并前进；行不匹配任何剩余 figure（头像等非 figure 资产、
// 课程表切片的续行）→ 跳过该行；行只匹配更靠后的 figure → 中间 figure 未落 PDF，跳到 k。
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
    if (k === -1) continue; // 非 figure 资产 / 切片续行
    di = k; // 中间 figure 未落 PDF（未加载），跳到匹配者
    out[di].actualPage = r.page;
    out[di].printImgH = Math.round((r.h / r.yppi) * 96);
    di++;
  }
  return out;
}

// ---------------- 洞→缩放目标（hole page p 的被推图 = actualPage==p+1 且打印高 > 洞 Css×0.5 的第一张） ----------------
function targetsForHoles(holes, aligned) {
  const targets = [];
  for (const h of holes) {
    const holeCss = (h.tailPt * 96) / 72;
    const cand = aligned.filter((f) => !f.chunked && f.actualPage === h.page + 1 && f.printImgH > holeCss * 0.5);
    if (!cand.length) { targets.push({ holePage: h.page, holeCss: Math.round(holeCss), unfixable: "no-figure-on-next-page" }); continue; }
    const t = cand[0];
    const mh = Math.round(holeCss - 42); // 14 图隙 + 12 题注 + 16 屏幕/打印漂移安全量
    if (mh < 120) { targets.push({ holePage: h.page, holeCss: Math.round(holeCss), unfixable: `mh-below-floor(${mh})`, targetIdx: t.i }); continue; }
    targets.push({ holePage: h.page, holeCss: Math.round(holeCss), idx: t.i, src: t.src, fromPrintH: t.printImgH, mh });
  }
  return targets;
}

// ---------------- 主流程 ----------------
let nav = await browse("navigate", {});
save("v2-01-navigate.json", nav);
if (nav.outcome !== "worked") { note(`[FATAL] navigate ${nav.outcome}`); save("v2-99-log.json", log); process.exit(1); }
note(`[navigate] worked`);
let ready = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1200));
  ready = await ev(`return JSON.stringify({rs:document.readyState,title:(document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,40),len:(document.body&&document.body.innerText||'').length});`);
  if (ready?.rs === "complete" && (ready?.len ?? 0) > 800 && ready?.title) break;
}
note(`[ready] ${JSON.stringify(ready)}`);
if (!ready?.title) { note("[FATAL] article-title 未出现"); save("v2-99-log.json", log); process.exit(1); }

const results = [];
const ONLY = process.argv[2] || null; // 章过滤：node extract-v2.mjs fk
for (let i = 0; i < ARTICLES.length; i++) {
  const a = ARTICLES[i];
  if (ONLY && a.tag !== ONLY) continue;
  const tag = `v2-${a.tag}`;
  note(`\n===== [${i + 1}/${ARTICLES.length}] ${a.title} =====`);
  const meta = { ...a, phases: {}, droppedImages: [], iterations: [] };

  const sw = await ev(JS_SWITCH(a.title));
  meta.phases.switch = sw;
  if (sw?.mode !== "already" && sw?.mode !== "clicked") { meta.fatal = `switch_failed:${sw?.mode}`; results.push(meta); continue; }
  note(`[switch] ${sw.mode}`);

  const st = await ev(JS_STABILIZE, 180000);
  meta.phases.stabilize = st;
  note(`[stabilize] ok=${st?.ok} imgs=${st?.imgs}/${st?.imgs} notLoaded=${st?.imgsNotLoaded}`);
  if (!st?.ok) { meta.fatal = `stabilize_failed:${st?.err}`; results.push(meta); continue; }

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
    meta.fatal = `assert_failed:${assertFails.join(",")}`; results.push(meta); continue;
  }

  const cl = await ev(JS_CLEANUP);
  meta.phases.cleanup = { ok: cl?.ok, del: cl?.del, docH: [cl?.docHBefore, cl?.docHAfter], residual: cl?.residual };
  note(`[cleanup] ok=${cl?.ok} docH ${cl?.docHBefore}->${cl?.docHAfter} residual=${JSON.stringify(cl?.residual)}`);
  if (!cl?.ok || (cl.residual && (cl.residual.cover || cl.residual.ddAudio || cl.residual.timeInfo || cl.residual.myComment || cl.residual.messageV2))) {
    meta.fatal = `cleanup_residual:${JSON.stringify(cl?.residual)}`; results.push(meta); continue;
  }

  // 清理态 innerText（零丢失基准，P14 教训：必须 cleanup 后打印前同态）
  const it = await ev(JS_INNERTEXT);
  const innerPath = path.join(SCRATCH, `${tag}-clean-inner.txt`);
  fs.writeFileSync(innerPath, it.t || "");
  note(`[innerText] ${(it.t || "").length} chars`);

  // 宣传图判据审计（删前 DOM 断言）
  const pa = await ev(JS_PROMO_AUDIT);
  save(`${tag}-promo-audit.json`, pa);
  meta.promoAudit = pa;
  note(`[promo-audit] M2=${pa?.M2} M3=${pa?.M3} M4=${pa?.M4} decision=${pa?.decision} bytes=${pa?.fetchBytes}`);
  // M1 金标（Node 侧 md5，非致命）
  if (pa?.srcAbs) {
    try {
      const buf = Buffer.from(await (await fetch(pa.srcAbs, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
      meta.promoMd5 = { md5: createHash("md5").update(buf).digest("hex"), bytes: buf.length, match: createHash("md5").update(buf).digest("hex") === PROMO_MD5 };
      note(`[promo-md5] ${meta.promoMd5.md5} match=${meta.promoMd5.match}`);
    } catch (e) { meta.promoMd5 = { err: String(e).slice(0, 80) }; }
  }

  // ---- S-A 首过（屏幕几何）----
  const fx1 = await ev(JS_FIX_SCREEN);
  save(`${tag}-fix-screen.json`, fx1);
  meta.fixScreen = fx1;
  meta.droppedImages = fx1?.dropped ?? [];
  note(`[fix-screen] dropped=${JSON.stringify(fx1?.dropped)} shrunk=${JSON.stringify(fx1?.shrunk)} skipped=${JSON.stringify(fx1?.skipped)}`);

  // 图操作后 innerText 不变性断言（文字零影响）
  const it2 = await ev(JS_INNERTEXT);
  meta.innerTextInvariant = (it2.t || "") === (it.t || "");
  note(`[innerText-invariant] ${meta.innerTextInvariant}`);

  // ---- print#1 + S-A' 反馈闭环（≤2 迭代）；保留最优迭代（Σ洞% 最小，平手取洞数少） ----
  let iter = 0, pdfPath = null, holes = [];
  const prints = []; // {iter, path, holes}
  while (iter <= 2) {
    iter++;
    pdfPath = (await cdpPrint(`${tag}-it${iter}.pdf`)).path;
    holes = holeReport(pdfPath).holes;
    prints.push({ iter, path: pdfPath, holes });
    meta.iterations.push({ iter, pdf: path.basename(pdfPath), holes: holes.map((h) => ({ page: h.page, tailPct: h.tailPct, tailPt: h.tailPt, fullness: h.fullness })) });
    note(`[print#${iter}] holes=${JSON.stringify(holes.map((h) => `p${h.page}:${h.tailPct}%/full${h.fullness}`))}`);
    if (!holes.length) break;
    if (iter > 2) break;
    const figsNow = await ev(JS_FIGS);
    save(`${tag}-figs-it${iter}.json`, figsNow);
    const aligned = alignFigures(figsNow.figs, pdfPath);
    const targets = targetsForHoles(holes, aligned);
    save(`${tag}-targets-it${iter}.json`, { aligned, targets });
    const appl = targets.filter((t) => !t.unfixable);
    const unfix = targets.filter((t) => t.unfixable);
    if (unfix.length) meta.iterations.at(-1).unfixable = unfix;
    if (!appl.length) { note(`[fix-print#${iter}] 无可施缩放目标，停止迭代`); break; }
    const fr = await ev(JS_FIX_PRINT(appl));
    note(`[fix-print#${iter}] ${JSON.stringify(fr)}`);
  }
  const score = (hs) => hs.reduce((s, h) => s + h.tailPct, 0) + hs.length * 0.01;
  prints.sort((a, b) => score(a.holes) - score(b.holes));
  pdfPath = prints[0].path;
  meta.bestIter = prints[0].iter;
  note(`[best] it${prints[0].iter} (Σ=${score(prints[0].holes).toFixed(1)})`);

  // ---- 终检三层 ----
  const finalPdf = pdfPath;
  const qc = {};
  qc.zeroLoss = textZeroLoss(finalPdf, it.t || "");
  qc.promo = promoInPdf(finalPdf);
  const hr = holeReport(finalPdf);
  qc.holes = hr.holes; qc.pages = hr.pages;
  qc.innerTextInvariant = meta.innerTextInvariant;
  meta.qc = qc;
  note(`[QC] zeroLoss.missing=${qc.zeroLoss.missing.slice(0, 5)} inOrder=${qc.zeroLoss.inOrder} promo=${qc.promo.length} holes=${qc.holes.length} pages=${qc.pages}`);
  const pass = qc.zeroLoss.missingEmpty && qc.zeroLoss.inOrder && qc.promo.length === 0 && qc.innerTextInvariant;

  if (pass) {
    const outDir = path.join(BASE, a.chapterDir);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${a.title}.pdf`);
    fs.copyFileSync(finalPdf, outPath);
    meta.pdfPath = outPath;
    meta.pdfBytes = fs.statSync(outPath).size;
    meta.sha256 = createHash("sha256").update(fs.readFileSync(outPath)).digest("hex");
    note(`[PDF v2] ${outPath} (${(meta.pdfBytes / 1024 / 1024).toFixed(2)} MiB) holes=${qc.holes.length}`);
  } else {
    meta.fatal = `qc_failed:${!qc.zeroLoss.missingEmpty ? "text-loss:" + qc.zeroLoss.missing.slice(0, 3) : ""}${!qc.zeroLoss.inOrder ? "+order" : ""}${qc.promo.length ? "+promo-present" : ""}${!qc.innerTextInvariant ? "+inner-changed" : ""}`;
    note(`[QC-FAIL] ${meta.fatal} — 不落正式产物`);
  }
  save(`${tag}-meta.json`, meta);
  results.push(meta);
  const g = chromeGuard();
  note(`[chrome-guard] ${JSON.stringify(g)}`);
}

save("v2-98-results.json", results);
save("v2-99-log.json", log);
note("\n===== SUMMARY =====");
for (const r of results) note(`${r.fatal ? "FAIL" : "OK  "} ${r.title} -> ${r.pdfPath ?? r.fatal}`);
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
