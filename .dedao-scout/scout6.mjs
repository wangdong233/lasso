#!/usr/bin/env node
/** scout6.mjs — 第六轮：慢滚动合并枚举每个主要章节的前 3 个子章节 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-scout");
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-scout6", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [
    "-c",
    `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server6-stderr.log"))}`,
  ],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);

async function browse(action, options = {}) {
  const res = await client.callTool(
    { name: "browse_logged_in", arguments: { url: TARGET, action, options } },
    undefined,
    { timeout: 180000 },
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

const tree = await ev(
  `return (async () => {
  const ps=document.querySelector('div.course-nav div.ps');
  if(!ps) return JSON.stringify({found:false});
  const map=new Map();
  const snap=()=>{
    for(const m of document.querySelectorAll('div.course-nav div.chapter-mod')){
      const h=m.querySelector('.chapterp-header');
      if(!h) continue;
      const name=(h.textContent||'').trim().replace(/\\s+/g,' ');
      if(!name) continue;
      let e=map.get(name);
      if(!e){e={name,subs:[],maxLiSeen:0};map.set(name,e);}
      const lis=[...m.querySelectorAll('ul.course-module>li')];
      e.maxLiSeen=Math.max(e.maxLiSeen,lis.length);
      for(const li of lis){
        const t=(li.textContent||'').trim().replace(/\\s+/g,' ');
        if(t&&!e.subs.includes(t)) e.subs.push(t);
      }
    }
  };
  snap();
  const step=Math.max(200,Math.floor(ps.clientHeight*0.7));
  let last=-1;
  for(let y=0;y<=ps.scrollHeight;y+=step){
    ps.scrollTop=y;
    await new Promise(r=>setTimeout(r,350));
    snap();
    last=y;
  }
  ps.scrollTop=ps.scrollHeight;
  await new Promise(r=>setTimeout(r,500));
  snap();
  const out=[...map.values()].map(e=>({chapter:e.name,nRendered:e.maxLiSeen,first3:e.subs.slice(0,3)}));
  return JSON.stringify({nChapters:out.length,chapters:out,psScrollH:ps.scrollHeight});
})()`,
);
save("60-chapter-tree.json", tree);

await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
