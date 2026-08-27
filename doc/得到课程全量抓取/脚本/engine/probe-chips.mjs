#!/usr/bin/env node
// P26 收官白盒：第七单元串讲 双 term chip 的结构与布局机制（零 timer 切换 + dump）
const CDP = "http://127.0.0.1:9226";
const TARGET = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
const WANT = "第七单元串讲";

let tab = (await (await fetch(`${CDP}/json/list`)).json()).find(t => t.type === "page" && t.url.startsWith("https://www.dedao.cn"));
let needNav = !tab;
if (!tab) tab = (await (await fetch(`${CDP}/json/list`)).json()).find(t => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); rej(new Error(method + ":TIMEOUT")); }, to); pending.set(id, m => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); }); ws.send(JSON.stringify({ id, method, params })); });
async function evJS(js, to = 30000) {
  const r = await send("Runtime.evaluate", { expression: `(() => {\n${js}\n})()`, returnByValue: true }, to);
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || "").slice(0, 200));
  const v = r?.result?.value;
  return typeof v === "string" ? JSON.parse(v) : v;
}
if (needNav) {
  await send("Page.enable");
  await send("Page.navigate", { url: TARGET });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) { await new Promise(r => setTimeout(r, 2000)); try { if (await evJS("return document.querySelector('div.course-nav ul.course-module>li')?1:0") === 1) break; } catch {} }
}
// 零 timer 切换（引擎同款 SW_STEP 范式）
const norm = s => String(s || "").trim().replace(/\s+/g, "");
const STEP = `return (()=>{
  const q=s=>document.querySelector(s);
  const want=${JSON.stringify(WANT)};
  const nav=q('div.course-nav'); if(nav&&nav.style.display==='none'){nav.style.removeProperty('display');}
  const sh=document.getElementById('dz-chrome-hide');if(sh){sh.remove();}
  const ps=q('div.course-nav div.ps'); if(!ps)return JSON.stringify({err:'no-sidebar'});
  const CUT=/\\s+\\d+分\\d+秒|\\s+\\d+人学过|\\s+\\|/;
  const nl=t=>(t||'').trim().replace(/\\s+/g,' ');
  const parseLi=t=>{const n=nl(t);const m=n.split(CUT)[0];return m||n;};
  const all=()=>[...document.querySelectorAll('div.course-nav ul.course-module>li')];
  const li=all().find(x=>parseLi(x.textContent)===want)||all().find(x=>nl(x.textContent).startsWith(want));
  if(li){li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));return JSON.stringify({clicked:1});}
  return JSON.stringify({clicked:0,maxH:ps.scrollHeight});
})()`;
const SCROLL = y => `return (()=>{const ps=document.querySelector('div.course-nav div.ps');if(!ps)return JSON.stringify({err:1});ps.scrollTop=${y};return JSON.stringify({maxH:ps.scrollHeight});})()`;
let clicked = false; let maxH = 0, noGrow = 0;
for (let y = 0; y < 200000 && !clicked; y += 700) {
  const rs = await evJS(SCROLL(y)).catch(() => null);
  if (rs && rs.maxH && rs.maxH > maxH) { maxH = rs.maxH; noGrow = 0; } else noGrow++;
  await new Promise(r => setTimeout(r, 260));
  const r = await evJS(STEP).catch(() => null);
  if (r && r.maxH && r.maxH > maxH) { maxH = r.maxH; noGrow = 0; }
  if (r && r.clicked) { clicked = true; break; }
  if (y > maxH + 3000 && noGrow > 10) break;
}
if (!clicked) { console.log("switch notfound"); ws.close(); process.exit(1); }
// 轮询标题
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 750));
  const t = await evJS("return ((document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim()||document.title).split(' - 得到')[0]").catch(() => "");
  if (norm(String(t)) === norm(WANT)) { console.log("[switch] ok"); break; }
}
await new Promise(r => setTimeout(r, 3000));
// dump 钞票/货币的价值 chip 结构
const probe = await evJS(`return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  if(!show)return {err:'no-show'};
  const hits=[];
  for(const el of show.querySelectorAll('*')){
    if(el.children.length>0)continue;
    const t=(el.textContent||'').trim();
    if(t!=='钞票'&&t!=='货币的价值')continue;
    const cs=getComputedStyle(el);const r=el.getBoundingClientRect();
    let chain=[];let n=el;for(let i=0;i<6&&n;i++){chain.push(n.tagName.toLowerCase()+(typeof n.className==='string'&&n.className?'.'+n.className.trim().split(/\\s+/).slice(0,2).join('.'):''));n=n.parentElement;}
    hits.push({t,tag:el.tagName.toLowerCase(),cls:(typeof el.className==='string'?el.className.trim().slice(0,40):''),
      display:cs.display,float:cs.float,position:cs.position,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),chain:chain.join(' < ')});
  }
  // 兄弟序：各自父容器的 children 序
  const sibs=hits.map(h=>{const el=[...show.querySelectorAll('*')].find(e=>e.children.length===0&&(e.textContent||'').trim()===h.t);
    if(!el)return null;const p=el.parentElement;return {t:h.t,parentCls:(typeof p.className==='string'?p.className.trim().slice(0,40):''),parentTag:p.tagName.toLowerCase(),
      nSib:p.children.length,sibTexts:[...p.children].map(c=>(c.textContent||'').trim().slice(0,12)),
      parentDisplay:getComputedStyle(p).display,parentFlex:getComputedStyle(p).flexDirection};});
  return {hits,sibs};
})()`);
console.log(JSON.stringify(probe, null, 1));
ws.close(); process.exit(0);
