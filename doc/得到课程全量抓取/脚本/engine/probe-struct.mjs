#!/usr/bin/env node
// P26 白盒：wrap 子结构 dump（找评论区/笔记区边界）
const CDP = "http://127.0.0.1:9226";
const ws = new WebSocket((await (await fetch(CDP + "/json/list")).json()).find((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article")).webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
const js = `return (()=>{
  const wrap=document.querySelector('div.article > div.article-wrap > div.article-body-wrap');
  const out=[];
  let n=wrap;
  for(let d=0;d<4&&n;d++){
    const kids=[...n.children];
    out.push({depth:d,parent:n.tagName.toLowerCase()+'.'+(typeof n.className==='string'?n.className.trim().split(/\\s+/).slice(0,3).join('.'):''),
      kids:kids.map(k=>({tag:k.tagName.toLowerCase(),cls:(typeof k.className==='string'?k.className.trim().split(/\\s+/).slice(0,3).join('.'):''),txtHead:(k.innerText||'').replace(/\\s+/g,' ').slice(0,26),h:Math.round(k.getBoundingClientRect().height)}))});
    n=kids[kids.length-1];
  }
  return JSON.stringify(out);
})()`;
const r = await send("Runtime.evaluate", { expression: `(() => {\n${js}\n})()`, returnByValue: true });
console.log(JSON.stringify(JSON.parse(r.result.value), null, 1));
ws.close(); process.exit(0);
