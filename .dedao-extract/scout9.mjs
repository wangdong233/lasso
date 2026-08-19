#!/usr/bin/env node
/**
 * scout9.mjs — 探察「课后思考」段 DOM 结构（用户 2026-08-19 新要求：标题+内容整段删）
 * 白盒：三章各 dump 尾部兄弟序列 + 课后思考 命中元素链 + 父级结构，产出可机械判据。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const TARGET = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-scout9", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-s9-stderr.log"))}`],
  cwd: ROOT, env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
async function browse(action, options = {}, timeoutMs = 180000) {
  const res = await client.callTool({ name: "browse_logged_in", arguments: { url: TARGET, action, options } }, undefined, { timeout: timeoutMs });
  return JSON.parse(res.content[0].text);
}
async function ev(js, timeoutMs = 120000) {
  const r = await browse("evaluate", { js }, timeoutMs);
  const p = r?.data?.preview ?? "";
  if (r?.outcome !== "worked" && r?.outcome !== undefined) return { _err: r.outcome, error: r.error };
  try { return JSON.parse(p); } catch { return { _raw: p.slice(0, 400) }; }
}
const save = (n, o) => fs.writeFileSync(path.join(OUT, n), JSON.stringify(o, null, 2));

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

const JS_STABILIZE = `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const body=q('div.article-body-wrap .article-body');
  if(!body) return JSON.stringify({ok:false,err:'no-body'});
  let last=-1,stable=0;
  for(let i=0;i<30;i++){
    const len=(body.innerText||'').length+body.querySelectorAll('img').length*1000;
    if(len===last){stable++;if(stable>=3)break;}else{stable=0;last=len;}
    await new Promise(r=>setTimeout(r,400));
  }
  const H=Math.max(document.scrollingElement?document.scrollingElement.scrollHeight:0,document.documentElement.scrollHeight);
  const step=Math.max(600,Math.floor(window.innerHeight*1.5));
  let n=0;
  for(let y=0;y<H&&n<90;y+=step,n++){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,150));}
  window.scrollTo(0,H);await new Promise(r=>setTimeout(r,600));
  let imgs=[...document.querySelectorAll('div.article-body img')];
  for(let i=0;i<20;i++){
    imgs=[...document.querySelectorAll('div.article-body img')];
    if(imgs.every(im=>im.complete&&(im.naturalWidth>0||!im.src)))break;
    await new Promise(r=>setTimeout(r,400));
  }
  window.scrollTo(0,0);await new Promise(r=>setTimeout(r,400));
  return JSON.stringify({ok:true,imgs:imgs.length});
})()`;

// 探察主体：编辑器块尾序列 + 课后思考命中链
const JS_SCOUT = `return (()=>{
  const body=document.querySelector('div.article-body-wrap .article-body');
  const show=body?(body.querySelector('.editor-show')||body):null;
  if(!show) return JSON.stringify({err:'no-show'});
  const kids=[...show.children];
  const desc=(el,i)=>{
    const r=el.getBoundingClientRect();
    const img=el.querySelector('img');
    return {i,tag:el.tagName.toLowerCase(),cls:(typeof el.className==='string'?el.className.trim().split(/\\s+/).slice(0,3).join('.'):''),
      txt:(el.innerText||'').trim().replace(/\\s+/g,' ').slice(0,60),h:Math.round(r.height),
      img:img?((img.currentSrc||img.src||'').split('/').pop()+' '+img.naturalWidth+'x'+img.naturalHeight):null};
  };
  // 课后思考命中：文本含该词的元素（叶子优先）
  const hits=[...show.querySelectorAll('*')].filter(el=>{
    const t=(el.childElementCount===0?(el.textContent||''):'');
    return t.includes('课后思考')||t.includes('课后作业')||t.includes('思考题');
  }).map(el=>({
    tag:el.tagName.toLowerCase(),cls:(typeof el.className==='string'?el.className:''),
    txt:(el.textContent||'').trim().slice(0,80),
    chain:(()=>{let a=[],n=el;for(let d=0;d<6&&n&&n!==show;d++){a.push(n.tagName.toLowerCase()+'.'+(typeof n.className==='string'?n.className.trim().split(/\\s+/)[0]:''));n=n.parentElement;}return a;})()
  }));
  return JSON.stringify({totalKids:kids.length,tail:kids.slice(-14).map(desc),hits});
})()`;

const nav = await browse("navigate", {});
if (nav.outcome !== "worked") { console.log("navigate fail", nav.outcome); process.exit(1); }
await new Promise((r) => setTimeout(r, 5000));

const CHAPTERS = ["发刊词丨只给你地道的经济学思维", "第001讲丨战俘营里的经济组织", "第002讲丨马粪争夺案"];
const out = {};
for (const t of CHAPTERS) {
  const sw = await ev(JS_SWITCH(t));
  const st = await ev(JS_STABILIZE);
  const sc = await ev(JS_SCOUT);
  out[t] = { switch: sw, stabilize: st?.ok, scout: sc };
  console.log(`\n===== ${t} ===== switch=${sw?.mode} stabilize=${st?.ok}`);
  console.log(JSON.stringify(sc, null, 1).slice(0, 3000));
}
save("s9-sikao.json", out);
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
