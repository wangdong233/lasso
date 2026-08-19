#!/usr/bin/env node
// scout7c — 定稿补测：①真·cleanup（剥反引号）→ 清理态 innerText 基线 ②article_list API 响应体
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const SCRATCH = path.join(OUT, "scratch");
const TARGET = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
const ARTICLES = [
  { tag: "fk", title: "发刊词丨只给你地道的经济学思维" },
  { tag: "l001", title: "第001讲丨战俘营里的经济组织" },
  { tag: "l002", title: "第002讲丨马粪争夺案" },
];
const t0 = Date.now();
const note = (m) => console.log(`[${(Date.now() - t0) / 1000}s] ${m}`);
const client = new Client({ name: "dedao-scout7c", version: "1" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-r2c-stderr.log"))}`],
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
  if (r?.outcome !== "worked" && r?.outcome !== undefined) return { _outcome: r?.outcome, _err: r?.error, _raw: p.slice(0, 200) };
  try { return JSON.parse(p); } catch { return { _raw: p.slice(0, 300) }; }
}
const JS_SWITCH = (want) => `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const want=${JSON.stringify(want)};
  const cur=q('div.article-body-wrap .article-title');
  if(cur&&(cur.textContent||'').trim()===want){return JSON.stringify({mode:'already'});}
  const find=()=>[...document.querySelectorAll('div.course-nav ul.course-module>li')]
    .find(li=>(li.textContent||'').trim().replace(/\\s+/g,' ').startsWith(want));
  let li=find();
  if(!li){const ps=q('div.course-nav div.ps');if(ps){ps.scrollTop=0;await new Promise(r=>setTimeout(r,700));}li=find();}
  if(!li){return JSON.stringify({mode:'notfound'});}
  li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  const t0=Date.now();
  while(Date.now()-t0<20000){
    await new Promise(r=>setTimeout(r,400));
    const t=q('div.article-body-wrap .article-title');
    if(t&&(t.textContent||'').trim()===want){return JSON.stringify({mode:'clicked'});}
  }
  return JSON.stringify({mode:'timeout'});
})()`;
// 从 scout7 源码抽 CLEANUP，剥掉模板反引号
const src = fs.readFileSync(path.join(OUT, "scout7-round2.mjs"), "utf8");
const JS_CLEANUP = src.match(/const JS_CLEANUP = `([\s\S]*?)`;;/) ??
  src.match(/const JS_CLEANUP = `([\s\S]*?)`;/);
const CLEANUP_BODY = JS_CLEANUP[1].replace(/^return /, "");
const JS_API = `return (async()=>{
  try{
    const r=await fetch('https://www.dedao.cn/pc/bauhinia/pc/class/purchase/article_list',{method:'POST',headers:{'content-type':'application/json'},credentials:'include',body:JSON.stringify({count:3})});
    const t=await r.text();
    return JSON.stringify({status:r.status,len:t.length,head:t.slice(0,600)});
  }catch(e){return JSON.stringify({err:String(e).slice(0,100)});}
})()`;
let nav = await browse("navigate", {});
note(`nav ${nav.outcome}`);
for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 1200));
  const rd = await ev(`return JSON.stringify({t:!!document.querySelector('div.article-body-wrap .article-title')});`);
  if (rd?.t) break;
}
note(`[api] ${JSON.stringify(await ev(JS_API)).slice(0, 700)}`);
for (const a of ARTICLES) {
  const sw = await ev(JS_SWITCH(a.title));
  note(`[${a.tag}] switch=${sw?.mode}`);
  for (let k = 0; k < 20; k++) {
    const st = await ev(`return (async()=>{const ims=[...document.querySelectorAll('div.article-body img')];return JSON.stringify({n:ims.length,ok:ims.every(im=>im.complete&&im.naturalWidth>0)});})()`);
    if (st?.ok) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const cl = await ev(CLEANUP_BODY);
  note(`[${a.tag}] cleanup ok=${cl?.ok} docH=${cl?.docHBefore}->${cl?.docHAfter} tailDel=${cl?.del?.tailSiblingsRemoved}`);
  const lenR = await ev(`return JSON.stringify({n:(document.body.innerText||'').length});`);
  const total = lenR?.n ?? 0;
  let txt = "";
  for (let off = 0; off < total; off += 1500) {
    const r = await ev(`return JSON.stringify({t:(document.body.innerText||'').slice(${off},${off + 1500})});`);
    if (typeof r?.t !== "string") { note(`[${a.tag}] FETCH FAIL ${off}`); break; }
    txt += r.t;
    if (r.t.length < 1500) break;
  }
  fs.writeFileSync(path.join(SCRATCH, `${a.tag}-dom-inner.txt`), txt);
  note(`[${a.tag}] cleaned innerText total=${total} fetched=${txt.length} head=${JSON.stringify(txt.slice(0, 60))}`);
}
note("DONE");
await transport.close();
setTimeout(() => process.exit(0), 300);
