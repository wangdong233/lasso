#!/usr/bin/env node
/**
 * scout8.mjs — 二轮探察 live 白盒（Chrome 9226 隐藏态，复用既有 about:blank tab，禁开新窗口）
 *
 * 目标：
 *  A) 发刊词基线重产（cleanup 态 innerText 快照 + print）→ 清理态零丢失 diff 的正确配对
 *  B) 实验1 printToPDF scale=0.9（同 DOM 态）→ 证明等比缩放不改变相对 fit（空洞按比例保留）
 *  C) 实验2 S-A 修复配方：删尾部宣传图（M1-M4 判据）+ 逐图 max-height 缩放进剩余页空间
 *     → 洞消除验证 + 文字零丢失（inner Text 与基线 diff 必须为空）
 *  D) 第003讲（未见章节）判据泛化 + 同配方端到端
 *  E) 全程计时 → 113 章全量预估
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const SCRATCH = path.join(OUT, "scratch");
const TARGET = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
const CDP = "http://127.0.0.1:9226";
const PROMO_MD5 = "7127ed550d5aeb9b75697030579c9aa4";

const log = [];
const t0 = Date.now();
const save = (n, o) => fs.writeFileSync(path.join(OUT, n), typeof o === "string" ? o : JSON.stringify(o, null, 2));
const note = (m) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`; console.log(l); log.push(l); };

// ---------- 直连 CDP printToPDF（可带额外参数） ----------
async function cdpPrint(extra = {}, outName) {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const tab = tabs.find((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"));
  if (!tab) return { ok: false, err: "no-dedao-tab" };
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(`ws:${String(e)}`)); });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}:${JSON.stringify(m.error)}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    const base = {
      landscape: false, printBackground: true,
      paperWidth: 8.268, paperHeight: 11.693,
      marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
      scale: 1, preferCSSPageSize: false,
    };
    const r = await send("Page.printToPDF", { ...base, ...extra });
    const buf = Buffer.from(r.data, "base64");
    fs.writeFileSync(path.join(SCRATCH, outName), buf);
    return { ok: true, bytes: buf.length, path: path.join(SCRATCH, outName) };
  } finally { ws.close(); }
}

// ---------- lasso MCP ----------
const client = new Client({ name: "dedao-scout8", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-s8-stderr.log"))}`],
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
  if (r?.outcome !== "worked" && r?.outcome !== undefined) return { _outcome: r?.outcome, _error: r?.error };
  try { return JSON.parse(p); } catch { return { _raw: p.slice(0, 400) }; }
}

// ---------- 既有片段（extract-batch3.mjs 原样复用） ----------
const JS_SWITCH = (want) => `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const want=${JSON.stringify(want)};
  const cur=q('div.article-body-wrap .article-title');
  const curT=cur?(cur.textContent||'').trim():'';
  if(curT===want){return JSON.stringify({mode:'already',title:curT});}
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
    if(t&&(t.textContent||'').trim()===want){return JSON.stringify({mode:'clicked'});}
  }
  return JSON.stringify({mode:'timeout'});
})()`;

const JS_STABILIZE_LITE = `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const body=q('div.article-body-wrap .article-body');
  if(!body) return JSON.stringify({ok:false,err:'no-body'});
  let last=-1,stable=0;
  for(let i=0;i<30;i++){
    const len=(body.innerText||'').length+body.querySelectorAll('img').length*1000;
    if(len===last){stable++;if(stable>=3)break;}else{stable=0;last=len;}
    await new Promise(r=>setTimeout(r,300));
  }
  const H=Math.max(document.scrollingElement?document.scrollingElement.scrollHeight:0,document.documentElement.scrollHeight);
  const step=Math.max(600,Math.floor(window.innerHeight*1.5));
  let n=0;
  for(let y=0;y<H&&n<90;y+=step,n++){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,120));}
  window.scrollTo(0,H);await new Promise(r=>setTimeout(r,400));
  let imgs=[];
  for(let i=0;i<20;i++){
    imgs=[...document.querySelectorAll('div.article-body img')];
    if(imgs.every(im=>im.complete&&(im.naturalWidth>0||!im.src)))break;
    await new Promise(r=>setTimeout(r,300));
  }
  window.scrollTo(0,0);await new Promise(r=>setTimeout(r,300));
  try{await document.fonts.ready;}catch(e){}
  return JSON.stringify({ok:true,imgs:imgs.length,imgsNotLoaded:imgs.filter(im=>!(im.complete&&im.naturalWidth>0)).length,docH:document.documentElement.scrollHeight});
})()`;

// 页图映射（r2 同款算法）：PAGE=每页内容高(css px)，fig→页/剩余/是否放下
const JS_PAGEMAP = `return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const wrapTop=(()=>{let e=show,y=0;while(e){y+=e.offsetTop;e=e.offsetParent;}return y;})();
  const PAGE=Math.round((11.693-0.8)*96);
  const figs=[...show.querySelectorAll('figure')].map((f,i)=>{
    const img=f.querySelector('img');
    const r=f.getBoundingClientRect();
    const top=Math.round(r.top+window.scrollY);
    const rel=top-wrapTop;
    const pg=Math.floor(rel/PAGE);
    const rem=PAGE-(rel-pg*PAGE);
    return {i,src:img?(img.currentSrc||img.src||'').split('/').pop():null,nat:img?img.naturalWidth+'x'+img.naturalHeight:null,
      h:Math.round(r.height),top:rel,pg,rem,fitsNow:r.height<=rem};
  });
  return JSON.stringify({PAGE,docH:document.documentElement.scrollHeight,showTop:wrapTop,showH:Math.round(show.getBoundingClientRect().height),figs});
})()`;

// 宣传图判据 dump：M1(md5 需抓取端配)、M2(nat 1080x607)、M3(src 20170223 窗口)、M4(其后无正文文本)
const JS_PROMO_DUMP = `return (async()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const figs=[...show.querySelectorAll('figure')];
  const last=figs[figs.length-1];
  if(!last) return JSON.stringify({figCount:0});
  const img=last.querySelector('img');
  let bytes=null,md5=null;
  try{
    const src=img.currentSrc||img.src;
    const resp=await fetch(src);
    bytes=(await resp.arrayBuffer()).byteLength;
  }catch(e){bytes='fetch-fail:'+String(e).slice(0,60);}
  const after=[...last.parentElement.children].slice([...last.parentElement.children].indexOf(last)+1);
  const afterTxt=after.map(n=>(n.innerText||'').trim().replace(/\\s+/g,' ').slice(0,30)).filter(Boolean);
  return JSON.stringify({figCount:figs.length,lastFigIdx:figs.length-1,
    lastSrc:(img?(img.currentSrc||img.src):'').split('/').pop(),
    lastNat:img?img.naturalWidth+'x'+img.naturalHeight:null,
    M2:img&&img.naturalWidth===1080&&img.naturalHeight===607,
    M3:/2017022\\d{12,}\\.(jpg|png)/.test(img?(img.currentSrc||img.src):''),
    M4:afterTxt.length===0, afterSummary:afterTxt, fetchBytes:bytes});
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
    art.style.setProperty('position','static','important');art.style.setProperty('left','auto','important');
    art.style.setProperty('margin','0','important');art.style.setProperty('transform','none','important');
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
  rep.residual={cover:qa('.article-cover').length,ddAudio:qa('.dd-audio').length,timeInfo:qa('.article-time-info').length};
  return JSON.stringify(rep);
})()`;

const JS_INNERTEXT = `return (()=>{
  const wrap=document.querySelector('div.article > div.article-wrap > div.article-body-wrap');
  return JSON.stringify({t:(wrap?wrap.innerText||'':'')});
})()`;

// S-A 修复：删宣传图（M2&&M3&&M4 全中才删，位置=最后 figure）+ 逐图缩放进剩余空间
const JS_FIX = `return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return JSON.stringify({err:'no-show'});
  const rep={dropped:[],shrunk:[],skipped:[]};
  const wrapTop=(()=>{let e=show,y=0;while(e){y+=e.offsetTop;e=e.offsetParent;}return y;})();
  const PAGE=Math.round((11.693-0.8)*96);
  const figs=[...show.querySelectorAll('figure')];
  // 1) 宣传图：仅最后一个 figure 且 M2&&M3（nat 1080x607 + src 20170223 窗口）
  const last=figs[figs.length-1];
  if(last){
    const img=last.querySelector('img');
    const m2=img&&img.naturalWidth===1080&&img.naturalHeight===607;
    const m3=img&&/2017022\\d{12,}\\.(jpg|png)/.test(img.currentSrc||img.src||'');
    if(m2&&m3){rep.dropped.push((img.currentSrc||img.src).split('/').pop());last.remove();figs.pop();}
    else rep.skipped.push({why:'last-fig-not-promo',m2,m3,src:img?(img.currentSrc||img.src).split('/').pop():null});
  }
  // 2) 逐图缩放（删图后重测几何）
  for(const f of [...show.querySelectorAll('figure')]){
    const img=f.querySelector('img'); if(!img) continue;
    const r=f.getBoundingClientRect();
    const rel=Math.round(r.top+window.scrollY)-wrapTop;
    const pg=Math.floor(rel/PAGE);
    const rem=PAGE-(rel-pg*PAGE);
    if(r.height<=rem) continue;                       // 放得下
    if(r.height<=PAGE*0.85){                          // 可缩进剩余空间
      const mh=Math.max(120,Math.floor(rem)-14);
      img.style.setProperty('max-height',mh+'px','important');
      img.style.setProperty('width','auto','important');
      rep.shrunk.push({src:(img.currentSrc||img.src).split('/').pop(),from:Math.round(r.height),to:mh,rem});
    } else {
      rep.skipped.push({why:'too-tall-to-shrink',src:(img.currentSrc||img.src).split('/').pop(),h:Math.round(r.height),rem});
    }
  }
  rep.docHAfter=document.documentElement.scrollHeight;
  return JSON.stringify(rep);
})()`;

// ================= 主流程 =================
let nav = await browse("navigate", {});
save("s8-01-navigate.json", nav);
if (nav.outcome !== "worked") { note(`[FATAL] ${nav.outcome}`); save("s8-99-log.json", log); process.exit(1); }
let ready = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1200));
  ready = await ev(`return JSON.stringify({rs:document.readyState,title:(document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,40),len:(document.body&&document.body.innerText||'').length});`);
  if (ready?.rs === "complete" && (ready?.len ?? 0) > 800 && ready?.title) break;
}
note(`[ready] ${JSON.stringify(ready)}`);

async function chapter(tag, title, experiments) {
  note(`\n===== ${title} =====`);
  const ts = Date.now();
  const sw = await ev(JS_SWITCH(title));
  note(`[switch ${(Date.now() - ts) / 1000 | 0}s] ${JSON.stringify(sw)}`);
  if (sw?.mode !== "already" && sw?.mode !== "clicked") return { fatal: "switch" };
  const tst = Date.now();
  const st = await ev(JS_STABILIZE_LITE, 180000);
  note(`[stabilize ${(Date.now() - tst) / 1000 | 0}s] ${JSON.stringify(st)}`);
  const pm = await ev(JS_PAGEMAP);
  save(`s8-${tag}-pagemap-pre.json`, pm);
  note(`[pagemap] ${JSON.stringify(pm).slice(0, 500)}`);
  const pd = await ev(JS_PROMO_DUMP);
  save(`s8-${tag}-promo.json`, pd);
  note(`[promo] ${JSON.stringify(pd)}`);
  const tc = Date.now();
  const cl = await ev(JS_CLEANUP);
  note(`[cleanup ${(Date.now() - tc) / 1000 | 0}s] docH ${cl?.docHBefore}->${cl?.docHAfter}`);
  // 清理态 innerText 基线
  const it = await ev(JS_INNERTEXT);
  fs.writeFileSync(path.join(SCRATCH, `${tag}-clean-inner.txt`), it.t || "");
  note(`[innerText] ${(it.t || "").length} chars`);
  const out = { title, switchMs: Date.now() - ts, inner: (it.t || "").length };
  if (experiments.base) {
    const tp = Date.now();
    const p = await cdpPrint({}, `${tag}-r3-base.pdf`);
    note(`[print-base ${(Date.now() - tp) / 1000 | 0}s] ${JSON.stringify(p)}`);
    out.base = p;
  }
  if (experiments.scale) {
    const tp = Date.now();
    const p = await cdpPrint({ scale: 0.9 }, `${tag}-r3-s09.pdf`);
    note(`[print-s09 ${(Date.now() - tp) / 1000 | 0}s] ${JSON.stringify(p)}`);
    out.s09 = p;
  }
  if (experiments.fix) {
    const tf = Date.now();
    const fx = await ev(JS_FIX);
    save(`s8-${tag}-fix.json`, fx);
    note(`[fix ${(Date.now() - tf) / 1000 | 0}s] ${JSON.stringify(fx)}`);
    const it2 = await ev(JS_INNERTEXT);
    fs.writeFileSync(path.join(SCRATCH, `${tag}-fix-inner.txt`), it2.t || "");
    out.fixInner = (it2.t || "").length;
    out.fixSameAsBase = (it2.t || "") === (it.t || "");
    const pm2 = await ev(JS_PAGEMAP);
    save(`s8-${tag}-pagemap-post.json`, pm2);
    const tp = Date.now();
    const p = await cdpPrint({}, `${tag}-r3-fix.pdf`);
    note(`[print-fix ${(Date.now() - tp) / 1000 | 0}s] ${JSON.stringify(p)}`);
    out.fix = p;
  }
  out.totalMs = Date.now() - ts;
  return out;
}

const results = [];
results.push(await chapter("fk", "发刊词丨只给你地道的经济学思维", { base: true, scale: true, fix: true }));
results.push(await chapter("l003", "第003讲丨看得见的和看不见的", { base: true, fix: true }));
save("s8-98-results.json", results);
save("s8-99-log.json", log);
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
