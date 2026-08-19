#!/usr/bin/env node
/**
 * scout4.mjs — 第四轮（修正 async 返回）：
 *   A. 侧栏滚动枚举全部主要章节（chapterp-header 全量）
 *   B. 点击第001讲 → 音频型文章右侧结构（audio 块特征）
 *   C. 音频型文章的 article-body 内部块（清理脚本特征）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-scout");
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-scout4", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [
    "-c",
    `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server4-stderr.log"))}`,
  ],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);

async function browse(action, options = {}) {
  const res = await client.callTool(
    { name: "browse_logged_in", arguments: { url: TARGET, action, options } },
    undefined,
    { timeout: 120000 },
  );
  return JSON.parse(res.content[0].text);
}
async function ev(js) {
  const r = await browse("evaluate", { js });
  const p = r?.data?.preview ?? "";
  try {
    return JSON.parse(p);
  } catch {
    return { _raw: p, _outcome: r?.outcome };
  }
}
function save(name, obj) {
  fs.writeFileSync(
    path.join(OUT, name),
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
  );
  console.log(`saved ${name}`);
}

await browse("navigate", {});
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const r = await ev(
    `return JSON.stringify({rs:document.readyState,len:(document.body&&document.body.innerText||'').length});`,
  );
  if (r?.rs === "complete" && (r?.len ?? 0) > 800) break;
}

// A: 滚动侧栏枚举全部主要章节
const a = await ev(
  `return (async () => {
  const ps=document.querySelector('div.course-nav div.ps');
  if(!ps) return JSON.stringify({found:false});
  const mods=[];
  const snap=()=>{ for(const m of document.querySelectorAll('div.course-nav div.chapter-mod')){
    const h=m.querySelector('.chapterp-header');
    const key=h?h.textContent.trim():('#'+m.offsetTop);
    if(!mods.find(x=>x.key===key)) mods.push({key,chapter:(h?h.textContent:'').trim().replace(/\\s+/g,' ').slice(0,50),li:m.querySelectorAll('ul.course-module>li').length});
  }};
  snap();
  for(let round=0;round<20;round++){
    const before=ps.scrollHeight+':'+mods.length;
    ps.scrollTop=ps.scrollHeight;
    await new Promise(r=>setTimeout(r,450));
    snap();
    const after=ps.scrollHeight+':'+mods.length;
    if(after===before) break;
  }
  return JSON.stringify({nMods:mods.length,psScrollH:ps.scrollHeight,mods});
})()`,
);
save("40-all-chapters.json", a);

// B: 点击第001讲（JS click）
const b1 = await ev(
  `return (async () => {
  const lis=[...document.querySelectorAll('div.course-nav ul.course-module>li')];
  const target=lis.find(li=>(li.textContent||'').includes('第001讲'));
  if(!target) return JSON.stringify({found:false,n:lis.length});
  target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,500)); const t=(document.querySelector('.article-title')||{textContent:''}).textContent.trim(); if(t.includes('第001讲')) return JSON.stringify({found:true,ok:true,url:location.href,title:t}); }
  return JSON.stringify({found:true,ok:false,url:location.href,title:(document.querySelector('.article-title')||{textContent:''}).textContent.trim()});
})()`,
);
save("41-click-001.json", b1);

// C: 音频型文章右侧结构（等待完成后的稳态）
await new Promise((r) => setTimeout(r, 2500));
const c = await ev(
  `return (async () => {
  const w=document.querySelector('div.article>div.article-wrap>div.article-body-wrap');
  if(!w) return JSON.stringify({found:false});
  const kids=[...w.children].map((k,i)=>({i,tag:k.tagName.toLowerCase(),cls:(typeof k.className==='string'?k.className.trim().split(/\\s+/).slice(0,2).join('.'):''),h:Math.round(k.getBoundingClientRect().height),t:(k.textContent||'').trim().replace(/\\s+/g,' ').slice(0,30)}));
  const aud=[...w.querySelectorAll('audio,iframe,[class*="play" i],[class*="audio" i],[class*="listen" i],[class*="voice" i]')].map(e=>({tag:e.tagName.toLowerCase(),cls:(typeof e.className==='string'?e.className.trim().split(/\\s+/).slice(0,2).join('.'):''),p:(e.closest('[class]')||{}).className?t:null,txt:(e.textContent||'').trim().slice(0,16)}));
  const body=w.querySelector('.article-body');
  const bodyKids=body?[...body.children].map((k,i)=>({i,cls:(typeof k.className==='string'?k.className.trim().split(/\\s+/).slice(0,2).join('.'):''),h:Math.round(k.getBoundingClientRect().height),t:(k.textContent||'').trim().replace(/\\s+/g,' ').slice(0,24)})):[];
  return JSON.stringify({url:location.href,title:(w.querySelector('.article-title')||{textContent:''}).textContent.trim(),kids,audInWrap:aud.slice(0,10),bodyKids:bodyKids.slice(0,12)});
})()`,
);
save("42-audio-article-structure.json", c);

await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
