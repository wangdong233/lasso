#!/usr/bin/env node
// scout7b — 补测：①cleanup 后 innerText（对象包裹切片，绕 lasso preview JSON-string 解包）②逐 figure data-module-type+margin ③article_list API 探测
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
const client = new Client({ name: "dedao-scout7b", version: "1" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-r2b-stderr.log"))}`],
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
  if (r?.outcome !== "worked" && r?.outcome !== undefined) return { _outcome: r?.outcome, _raw: p.slice(0, 200) };
  try { return JSON.parse(p); } catch { return { _raw: p.slice(0, 400) }; }
}
const JS_SWITCH = (want) => `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const want=${JSON.stringify(want)};
  const cur=q('div.article-body-wrap .article-title');
  if(cur&&(cur.textContent||'').trim()===want){return JSON.stringify({mode:'already',url:location.href});}
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
    if(t&&(t.textContent||'').trim()===want){return JSON.stringify({mode:'clicked',url:location.href});}
  }
  return JSON.stringify({mode:'timeout'});
})()`;
// 清理（同 b3）
const src = fs.readFileSync(path.join(OUT, "scout7-round2.mjs"), "utf8");
const JS_CLEANUP = src.match(/const JS_CLEANUP = `return \(\(\)=>\{[\s\S]*?\}\)\(\)`;/)[0].replace("const JS_CLEANUP = ", "").replace(/;$/, "");
// 逐 figure 属性+margin（清理前测，且把 promo 判据要的字段全收）
const JS_FIGATTR = `return (()=>{
  const show=document.querySelector('div.article-body div.editor-show');
  if(!show) return JSON.stringify({err:'no-show'});
  const figs=[...show.querySelectorAll('figure')];
  const rows=figs.map((f,i)=>{
    const im=f.querySelector('img');
    const cs=getComputedStyle(f);
    return {i,dmt:f.getAttribute('data-module-type'),
      styleAttr:(f.getAttribute('style')||'').slice(0,40),
      mT:cs.marginTop,mB:cs.marginBottom,
      src:im?(im.currentSrc||'').split('/').pop().slice(0,40):null,
      nat:im?im.naturalWidth+'x'+im.naturalHeight:null};
  });
  const last=figs[figs.length-1];
  const im=last&&last.querySelector('img');
  return JSON.stringify({rows,lastNat:im?{w:im.naturalWidth,h:im.naturalHeight}:null});
})()`;
// article_list API 探测（同源 fetch，带登录 cookie）
const JS_API = `return (async()=>{
  const r=await fetch('https://www.dedao.cn/pc/bauhinia/pc/class/purchase/article_list',{method:'POST',headers:{'content-type':'application/json'},credentials:'include',body:JSON.stringify({chapter_id:'',count:5})}).then(x=>({status:x.status})).catch(e=>({err:String(e).slice(0,80)}));
  return JSON.stringify(r);
})()`;

let nav = await browse("navigate", {});
note(`nav ${nav.outcome}`);
if (nav.outcome !== "worked") process.exit(1);
for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 1200));
  const rd = await ev(`return JSON.stringify({t:!!document.querySelector('div.article-body-wrap .article-title')});`);
  if (rd?.t) break;
}
// API 探测（一次）
note(`[api] ${JSON.stringify(await ev(JS_API))}`);
for (const a of ARTICLES) {
  const sw = await ev(JS_SWITCH(a.title));
  note(`[${a.tag}] switch=${sw?.mode}`);
  await new Promise(r => setTimeout(r, 1500));
  for (let k = 0; k < 20; k++) {
    const st = await ev(`return (async()=>{const ims=[...document.querySelectorAll('div.article-body img')];return JSON.stringify({n:ims.length,ok:ims.every(im=>im.complete&&im.naturalWidth>0)});})()`);
    if (st?.ok) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const fa = await ev(JS_FIGATTR);
  fs.writeFileSync(path.join(OUT, `r2-${a.tag}-figattr.json`), JSON.stringify(fa, null, 2));
  note(`[${a.tag}] figattr dmt=${JSON.stringify(fa?.rows?.map(r=>r.dmt))}`);
  const cl = await ev(JS_CLEANUP);
  note(`[${a.tag}] cleanup ok=${cl?.ok} docH=${cl?.docHAfter}`);
  // innerText 对象包裹切片拉取
  const lenR = await ev(`return JSON.stringify({n:(document.body.innerText||'').length});`);
  const total = lenR?.n ?? 0;
  let txt = "";
  for (let off = 0; off < total; off += 1500) {
    const r = await ev(`return JSON.stringify({t:(document.body.innerText||'').slice(${off},${off + 1500})});`);
    if (typeof r?.t !== "string") { note(`[${a.tag}] FETCH FAIL at ${off}: ${JSON.stringify(r).slice(0,120)}`); break; }
    txt += r.t;
    if (r.t.length < 1500) break;
  }
  fs.writeFileSync(path.join(SCRATCH, `${a.tag}-dom-inner.txt`), txt);
  note(`[${a.tag}] innerText total=${total} fetched=${txt.length}`);
}
note("DONE");
await transport.close();
setTimeout(() => process.exit(0), 300);
