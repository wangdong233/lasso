#!/usr/bin/env node
// P26-③n 白盒：侧栏 li 是否携带 articleId（视频章直接 URL 导航的钥匙）
const CDP = "http://127.0.0.1:9226";
const tab = (await (await fetch(`${CDP}/json/list`)).json()).find((t) => t.type === "page" && t.url.includes("dedao.cn"));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, to = 30000) => new Promise((res, rej) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); rej(new Error(method + ":TIMEOUT")); }, to); pending.set(id, m => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); }); ws.send(JSON.stringify({ id, method, params })); });
const js = `return (()=>{
  const li=document.querySelector('div.course-nav ul.course-module>li');
  if(!li)return JSON.stringify({err:'no-li'});
  const dump=(el)=>({tag:el.tagName.toLowerCase(),attrs:[...el.attributes].map(a=>a.name+'='+(a.value||'').slice(0,44))});
  const attrs=[dump(li),...[...li.querySelectorAll('*')].slice(0,10).map(dump)];
  return JSON.stringify(attrs);
})()`;
const r = await send("Runtime.evaluate", { expression: `(() => {\n${js}\n})()`, returnByValue: true });
console.log(r.result.value);
ws.close(); process.exit(0);
