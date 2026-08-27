#!/usr/bin/env node
// P26 白盒：指定章全部 figure 的 nat/src（找非末位 1080×607 宣传图变体）+ Node 侧 md5
import { createHash } from "node:crypto";
const CDP = "http://127.0.0.1:9226";
const TARGET_URL = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
const want = process.argv[2];

let tabs = await (await fetch(`${CDP}/json/list`)).json();
let tab = tabs.find((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"));
let needNav = !tab;
if (!tab) tab = tabs.find((t) => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
async function evJS(js) {
  const r = await send("Runtime.evaluate", { expression: `(() => {\n${js}\n})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  const v = r?.result?.value;
  return typeof v === "string" ? JSON.parse(v) : v;
}
if (needNav) {
  await send("Page.enable"); await send("Page.navigate", { url: TARGET_URL });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) { await new Promise(r => setTimeout(r, 1500)); try { if (await evJS("return document.querySelector('div.article-body-wrap .article-title') ? 1 : 0") === 1) break; } catch {} }
}
const sw = await evJS(`return (async()=>{
  const q=(s)=>document.querySelector(s);
  const want=${JSON.stringify(want)};
  const norm=(t)=>(t||'').trim().replace(/\\s+/g,' ');
  const CUT=/\\s+\\d+分\\d+秒|\\s+\\d+人学过|\\s+\\|/;
  const parseLi=(t)=>{const n=norm(t);const m=n.split(CUT)[0];return m||n;};
  const lis=()=>[...document.querySelectorAll('div.course-nav ul.course-module>li')];
  const nav=q('div.course-nav'); if(nav&&nav.style.display==='none'){nav.style.removeProperty('display');}
  const sh=document.getElementById('dz-chrome-hide'); if(sh) sh.remove();
  const ps=q('div.course-nav div.ps'); if(!ps) return JSON.stringify('no-sidebar');
  const find=()=>{const all=lis();return all.find(li=>parseLi(li.textContent)===want)||all.find(li=>norm(li.textContent).startsWith(want));};
  let li=find();
  if(!li){const step=Math.max(180,Math.floor(ps.clientHeight*0.6));let maxH=ps.scrollHeight;
    for(let y=0;y<=maxH;y+=step){ps.scrollTop=y;await new Promise(r=>setTimeout(r,250));maxH=Math.max(maxH,ps.scrollHeight);li=find();if(li)break;}}
  if(!li) return JSON.stringify('notfound');
  li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  await new Promise(r=>setTimeout(r,5000));
  return JSON.stringify('ok:'+norm((q('div.article-body-wrap .article-title')||{textContent:''}).textContent).slice(0,30));
})()`);
console.log("[switch]", sw);
await new Promise(r => setTimeout(r, 3000));
// 全 figure dump
const figs = await evJS(`return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show) return {err:'no-show'};
  // 滚到底触发懒加载
  return JSON.stringify({figs:[...show.querySelectorAll('figure')].map((f,i)=>{
    const img=f.querySelector('img');
    return {i,src:img?(img.currentSrc||img.src||'').split('/').pop():null,srcAbs:img?(img.currentSrc||img.src||''):null,
      nat:img?img.naturalWidth+'x'+img.naturalHeight:null,hasCap:!!f.querySelector('figcaption'),
      capTxt:(f.querySelector('figcaption')?(f.querySelector('figcaption').textContent||'').trim().slice(0,20):null)};
  })});
})()`);
for (const f of (figs.figs || [])) {
  let md5 = null;
  if (f.srcAbs) { try { const buf = Buffer.from(await (await fetch(f.srcAbs, { signal: AbortSignal.timeout(15000) })).arrayBuffer()); md5 = createHash("md5").update(buf).digest("hex").slice(0, 12) + `(${buf.length}B)`; } catch (e) { md5 = "fetch-fail"; } }
  console.log(`fig#${f.i} ${f.nat} md5=${md5} cap=${f.hasCap ? JSON.stringify(f.capTxt) : "-"} ${f.src}`);
}
ws.close(); process.exit(0);
