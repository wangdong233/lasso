#!/usr/bin/env node
/** b4-diag：定位发刊词清理后 docH 尾部溢出的来源元素 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-extract-b4diag", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [
    "-c",
    `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-b4-stderr.log"))}`,
  ],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);

async function browse(action, options = {}, timeoutMs = 180000) {
  const res = await client.callTool(
    { name: "browse_logged_in", arguments: { url: TARGET, action, options } },
    undefined,
    { timeout: timeoutMs },
  );
  return JSON.parse(res.content[0].text);
}
async function ev(js, timeoutMs = 120000) {
  const r = await browse("evaluate", { js }, timeoutMs);
  const p = r?.data?.preview ?? "";
  try {
    return JSON.parse(p);
  } catch {
    return { _raw: p.slice(0, 800) };
  }
}

await browse("navigate", {});
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1200));
  const r = await ev(
    `return JSON.stringify({t:(document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,20),rs:document.readyState});`,
  );
  if (r?.t?.startsWith("发刊词")) break;
}

// 与 batch3 相同的清理
const cleanup = await ev(`return (()=>{
  const q=(s,r)=>(r||document).querySelector(s);
  const qa=(s,r)=>[...(r||document).querySelectorAll(s)];
  const wrap=q('div.article > div.article-wrap > div.article-body-wrap');
  const pc=qa(':scope > div.pageControl',wrap);pc.forEach(n=>n.remove());
  const c=q('.article-cover',wrap);if(c)c.remove();
  qa('.dd-audio',wrap).forEach(n=>n.remove());qa('audio',wrap).forEach(n=>n.remove());
  const ti=q(':scope > div.article-time-info',wrap);
  if(ti){let n=ti;while(n){const nx=n.nextElementSibling;n.remove();n=nx;}}
  for(const sel of ['.iget-header','div.course-nav','aside.iget-side-button','div.course-nav-mask','.iget-audio-player']){qa(sel).forEach(e=>e.style.setProperty('display','none','important'));}
  return JSON.stringify({cleaned:true});
})()`);

// 尾部诊断
const diag = await ev(`return (()=>{
  const vis=(e)=>{const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&parseFloat(s.opacity||'1')>0.01;};
  const H=document.documentElement.scrollHeight;
  const tails=[];
  for(const e of document.querySelectorAll('body *')){
    if(!vis(e))continue;
    const r=e.getBoundingClientRect();
    if(r.bottom>H-80){
      const cs=getComputedStyle(e);
      tails.push({tag:e.tagName.toLowerCase(),cls:(typeof e.className==='string'?e.className.trim().split(/\\s+/).slice(0,2).join('.'):'').slice(0,40),bottom:Math.round(r.bottom),h:Math.round(r.height),mb:cs.marginBottom,pb:cs.paddingBottom,txt:(e.textContent||'').trim().slice(0,20)});
    }
  }
  tails.sort((a,b)=>b.bottom-a.bottom);
  let maxBottom=0;
  for(const e of document.querySelectorAll('body *')){if(!vis(e))continue;const r=e.getBoundingClientRect();if(r.bottom>maxBottom)maxBottom=r.bottom;}
  const bcs=getComputedStyle(document.body);
  return JSON.stringify({scrollH:H,maxVisibleBottom:Math.round(maxBottom),gap:Math.round(H-maxBottom),bodyMb:bcs.marginBottom,htmlH:getComputedStyle(document.documentElement).height,pageRemainder:Math.round(H%1046),tails:tails.slice(0,10)});
})()`);

fs.writeFileSync(path.join(OUT, "b4-diag.json"), JSON.stringify({ cleanup, diag }, null, 2));
console.log(JSON.stringify({ cleanup, diag }, null, 2));
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
