#!/usr/bin/env node
// P26 白盒：定位 wrap 内"笔记"类 UI 元素（不进打印但进 innerText 的尾部按钮）
import * as fs from "node:fs";
const CDP = "http://127.0.0.1:9226";
const TARGET_URL = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
const want = process.argv[2] || "第023讲丨谁用得好就归谁";

let tabs = await (await fetch(`${CDP}/json/list`)).json();
let tab = tabs.find((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"));
let needNav = false;
if (!tab) { tab = tabs.find((t) => t.type === "page"); needNav = true; }
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
async function evJS(js) {
  const r = await send("Runtime.evaluate", { expression: `(() => {\n${js}\n})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  const v = r?.result?.value;
  return typeof v === "string" ? JSON.parse(v) : v;
}
if (needNav) {
  await send("Page.enable");
  await send("Page.navigate", { url: TARGET_URL });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 1500));
    try { const v = await evJS("return document.querySelector('div.article-body-wrap .article-title') ? 1 : 0"); if (v === 1) break; } catch {}
  }
}
// 切章
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
  await new Promise(r=>setTimeout(r,4000));
  return JSON.stringify('clicked:'+norm((q('div.article-body-wrap .article-title')||{textContent:''}).textContent).slice(0,30));
})()`);
console.log("[switch]", sw);
await new Promise((r) => setTimeout(r, 4000));

// 找 wrap 内叶子文本恰为「笔记」的元素 + 祖先链
const probe = await evJS(`return (()=>{
  const wrap=document.querySelector('div.article > div.article-wrap > div.article-body-wrap');
  if(!wrap) return {err:'no-wrap'};
  const hits=[];
  for(const el of wrap.querySelectorAll('*')){
    if(el.childElementCount>0) continue;
    const t=(el.textContent||'').trim();
    if(t!=='笔记'&&t!=='写笔记'&&t!=='加载中...'&&!/^\\d+$/.test(t)) continue;
    const cs=getComputedStyle(el);
    let chain=[]; let n=el; for(let i=0;i<8&&n;i++){chain.push(n.tagName.toLowerCase()+(typeof n.className==='string'&&n.className?'.'+n.className.trim().split(/\\s+/).slice(0,3).join('.'):''));n=n.parentElement;}
    hits.push({t,display:cs.display,vis:cs.visibility,h:Math.round(el.getBoundingClientRect().height),chain:chain.join(' < ')});
  }
  const tail=(wrap.innerText||'').replace(/\\s+/g,'').slice(-30);
  return {hits:hits.slice(0,12),tail};
})()`);
console.log(JSON.stringify(probe, null, 1));
ws.close(); process.exit(0);
