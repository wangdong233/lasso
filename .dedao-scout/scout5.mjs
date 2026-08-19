#!/usr/bin/env node
/** scout5.mjs — 第五轮（修 JS bug）：音频型文章（第001讲）右侧结构特征 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-scout");
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-scout5", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [
    "-c",
    `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server5-stderr.log"))}`,
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

// 点击第001讲 + 等待切换
const clk = await ev(
  `return (async () => {
  const lis=[...document.querySelectorAll('div.course-nav ul.course-module>li')];
  const target=lis.find(li=>(li.textContent||'').includes('第001讲'));
  if(!target) return JSON.stringify({found:false});
  target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,500)); const t=(document.querySelector('.article-title')||{textContent:''}).textContent.trim(); if(t.includes('第001讲')) return JSON.stringify({found:true,ok:true,url:location.href}); }
  return JSON.stringify({found:true,ok:false,url:location.href});
})()`,
);
save("50-click.json", clk);
await new Promise((r) => setTimeout(r, 2500));

// 音频型文章结构
const c = await ev(
  `return (async () => {
  const w=document.querySelector('div.article>div.article-wrap>div.article-body-wrap');
  if(!w) return JSON.stringify({found:false});
  const kids=[...w.children].map((k,i)=>({i,tag:k.tagName.toLowerCase(),cls:(typeof k.className==='string'?k.className.trim().split(/\\s+/).slice(0,2).join('.'):''),h:Math.round(k.getBoundingClientRect().height),t:(k.textContent||'').trim().replace(/\\s+/g,' ').slice(0,32)}));
  const aud=[...w.querySelectorAll('audio,iframe,[class*="play" i],[class*="audio" i],[class*="listen" i],[class*="voice" i],[class*="sound" i]')].map(e=>({tag:e.tagName.toLowerCase(),cls:(typeof e.className==='string'?e.className.trim().split(/\\s+/).slice(0,2).join('.'):''),txt:(e.textContent||'').trim().slice(0,16)}));
  const body=w.querySelector('.article-body');
  const bodyKids=body?[...body.children].map((k,i)=>({i,tag:k.tagName.toLowerCase(),cls:(typeof k.className==='string'?k.className.trim().split(/\\s+/).slice(0,2).join('.'):''),h:Math.round(k.getBoundingClientRect().height),t:(k.textContent||'').trim().replace(/\\s+/g,' ').slice(0,26)})):[];
  return JSON.stringify({url:location.href,title:(w.querySelector('.article-title')||{textContent:''}).textContent.trim(),kids,audInWrapN:aud.length,audInWrap:aud.slice(0,10),bodyKidsN:bodyKids.length,bodyKids:bodyKids.slice(0,12)});
})()`,
);
save("51-audio-structure.json", c);

await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
