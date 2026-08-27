#!/usr/bin/env node
// P25 白盒探针：问答/预告页 DOM 结构随时间演化(只读 + 可选一次点击切换)
// 用法: node probe-dom.mjs [wantTitle] [--watch N秒]
import * as fs from "node:fs";
const CDP = "http://127.0.0.1:9226";
const argv = process.argv.slice(2);
const want = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
const watchIdx = argv.indexOf("--watch");
const watchS = watchIdx >= 0 ? +argv[watchIdx + 1] : 30;

const TARGET_URL = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
let tabs = await (await fetch(`${CDP}/json/list`)).json();
let tab = tabs.find((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"));
let needNav = false;
if (!tab) {
  tab = tabs.find((t) => t.type === "page");
  needNav = true;
}
if (!tab) { console.log("no-page-tab"); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error("ws-open-timeout")), 15000); ws.onopen = () => { clearTimeout(to); res(); }; ws.onerror = (e) => { clearTimeout(to); rej(new Error(String(e))); }; });
let seq = 0; const pending = new Map();
ws.onmessage = (evt) => { const m = JSON.parse(typeof evt.data === "string" ? evt.data : ""); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const to = setTimeout(() => { pending.delete(id); rej(new Error(`${method}:timeout`)); }, 120000);
  pending.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(`${method}:${JSON.stringify(m.error)}`)) : res(m.result); });
  ws.send(JSON.stringify({ id, method, params }));
});

const PROBE = `return (()=>{
  const qa=(s,r)=>[...(r||document).querySelectorAll(s)];
  const q=(s)=>document.querySelector(s);
  const strict=q('div.article > div.article-wrap > div.article-body-wrap');
  const allTitles=qa('div.article-body-wrap .article-title').map(e=>(e.textContent||'').trim().slice(0,40));
  const strictAll=qa('div.article > div.article-wrap >div.article-body-wrap');
  const desc=(el)=>{ if(!el) return null; let chain=[]; let n=el; for(let i=0;i<6&&n;i++){ chain.push(n.tagName.toLowerCase()+(typeof n.className==='string'?'.'+n.className.trim().split(/\\s+/).slice(0,3).join('.'):'')); n=n.parentElement; } return chain; };
  const body=q('div.article-body-wrap .article-body');
  return JSON.stringify({
    url:location.href.slice(-50),
    firstTitle:allTitles[0]||null,
    nBodyWrap:qa('div.article-body-wrap').length,
    nStrict:strictAll.length,
    nArticle:qa('div.article').length,
    strictInnerTextHead:(strict?(strict.innerText||'').replace(/\\s+/g,' ').slice(0,100):null),
    strictDesc:desc(strict),
    bodyLen:body?(body.innerText||'').length:null,
    hasEditorShow:!!(body&&body.querySelector('.editor-show')),
    audioAutoplay: qa('audio').map(a=>a.autoplay),
  });
})()`;

async function evJS(js) {
  const r = await send("Runtime.evaluate", { expression: `(${js.replace(/^return /, "")})`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
}
function fmt(v) {
  const o = typeof v === "string" ? JSON.parse(v) : v;
  return `title=${JSON.stringify(o.firstTitle)} nBW=${o.nBodyWrap} nStrict=${o.nStrict} nArticle=${o.nArticle} bodyLen=${o.bodyLen} audio=${JSON.stringify(o.audioAutoplay)}\n  innerHead=${JSON.stringify(o.strictInnerTextHead)}\n  chain=${JSON.stringify(o.strictDesc)}`;
}

if (needNav) {
  await send("Page.enable");
  await send("Page.navigate", { url: TARGET_URL });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const v = await evJS(`return document.querySelector('div.article-body-wrap .article-title') ? 'ready' : 'wait'`);
      if (v === "ready") break;
    } catch {}
  }
  console.log("[nav] navigated to course page");
}

console.log(`[t=0] ${fmt(await evJS(PROBE))}`);

if (want) {
  // 仿 JS_SWITCH_V3 点击侧栏
  const SWITCH = (w) => `return (async()=>{
    const q=(s)=>document.querySelector(s);
    const want=${JSON.stringify(w)};
    const nav=q('div.course-nav');
    if(nav&&nav.style.display==='none'){nav.style.removeProperty('display');}
    const ps=q('div.course-nav div.ps');
    if(!ps){return JSON.stringify({mode:'no-sidebar'});}
    const norm=(t)=>(t||'').trim().replace(/\\s+/g,' ');
    const liMatch=()=>[...document.querySelectorAll('div.course-nav ul.course-module>li')]
      .find(li=>norm(li.textContent).startsWith(want));
    let li=liMatch();
    if(!li){const step=Math.max(180,Math.floor(ps.clientHeight*0.6));let maxH=ps.scrollHeight;
      for(let y=0;y<=maxH;y+=step){ps.scrollTop=y;await new Promise(r=>setTimeout(r,250));maxH=Math.max(maxH,ps.scrollHeight);li=liMatch();if(li)break;}}
    if(!li){return JSON.stringify({mode:'notfound'});}
    li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    const t0=Date.now();
    while(Date.now()-t0<20000){await new Promise(r=>setTimeout(r,400));
      const t=q('div.article-body-wrap .article-title');
      if(t&&norm(t.textContent)===want){return JSON.stringify({mode:'clicked',url:location.href});}}
    return JSON.stringify({mode:'clicked-but-title-never',now:(q('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,40)});
  })()`;
  console.log(`[switch] want=${JSON.stringify(want)} → ${await evJS(SWITCH(want))}`);
  const t0 = Date.now();
  while (Date.now() - t0 < watchS * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    const t = ((Date.now() - t0) / 1000).toFixed(0);
    try { console.log(`[t=${t}] ${fmt(await evJS(PROBE))}`); } catch (e) { console.log(`[t=${t}] probe-err ${String(e).slice(0, 100)}`); }
  }
}
ws.close();
process.exit(0);
