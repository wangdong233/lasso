#!/usr/bin/env node
/**
 * scout3.mjs — 第三轮：侧栏滚动枚举全章节 / 点击子章节验证 SPA 跳转 /
 * 音频型文章（第001讲）右侧结构（音频块特征）/ 正文图片懒加载属性
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-scout");
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-scout3", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [
    "-c",
    `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server3-stderr.log"))}`,
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
    `return JSON.stringify({rs:document.readyState,t:document.title,len:(document.body&&document.body.innerText||'').length});`,
  );
  if (r?.rs === "complete" && (r?.len ?? 0) > 800) break;
}

// A: 侧栏滚动到底（多轮），枚举全部 chapterp-header + 每个 chapter-mod 的 li 数
const scrollScan = await ev(
  `(async () => {
  const ps=document.querySelector('div.course-nav div.ps');
  if(!ps) return JSON.stringify({found:false});
  const seen=[];
  for(let round=0;round<12;round++){
    ps.scrollTop=ps.scrollHeight;
    await new Promise(r=>setTimeout(r,400));
    const mods=[...document.querySelectorAll('div.course-nav div.chapter-mod')].map(m=>{
      const h=m.querySelector('.chapterp-header');
      return {chapter:(h?h.textContent.trim().replace(/\\s+/g,' '):'?').slice(0,50),li:m.querySelectorAll('ul.course-module>li').length,liFirst:(m.querySelector('ul.course-module>li')?.textContent||'').trim().replace(/\\s+/g,' ').slice(0,32)};
    });
    seen.length=0; seen.push(...mods);
  }
  return JSON.stringify({nMods:seen.length,mods:seen,psScrollH:ps.scrollHeight});
})()`,
);
save("30-sidebar-scroll.json", scrollScan);

// B: 点击第001讲 li（JS click），观察 URL/标题变化
const before = await ev(
  `return JSON.stringify({url:location.href,title:(document.querySelector('.article-title')||{}).textContent});`,
);
const clickRes = await ev(
  `(async () => {
  const lis=[...document.querySelectorAll('div.course-nav ul.course-module>li')];
  const target=lis.find(li=>(li.textContent||'').includes('第001讲'));
  if(!target) return JSON.stringify({found:false,n:lis.length});
  const r=target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  return JSON.stringify({found:true,clickedTxt:(target.textContent||'').trim().slice(0,30),y:Math.round(r.y)});
})()`,
);
save("31-click-001.json", { before, clickRes });

// 等内容切换
let after = null;
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  after = await ev(
    `return JSON.stringify({url:location.href,title:(document.querySelector('.article-title')||{}).textContent});`,
  );
  if (after?.title && after.title !== before?.title) break;
}
save("32-after-click.json", after);

// C: 第001讲（音频型文章）右侧结构
const audioArticle = await ev(
  `(async () => {
  const w=document.querySelector('div.article>div.article-wrap>div.article-body-wrap');
  if(!w) return JSON.stringify({found:false});
  const kids=[...w.children].map((k,i)=>({i,tag:k.tagName.toLowerCase(),cls:(typeof k.className==='string'?k.className.trim().split(/\\s+/).slice(0,2).join('.'):''),h:Math.round(k.getBoundingClientRect().height),t:(k.textContent||'').trim().replace(/\\s+/g,' ').slice(0,26)}));
  // 音频块候选：正文内 audio/iframe/play 元素
  const aud=[...w.querySelectorAll('audio,iframe,[class*="play" i],[class*="audio" i],[class*="listen" i]')].map(e=>({tag:e.tagName.toLowerCase(),cls:(typeof e.className==='string'?e.className.trim().split(/\\s+/).slice(0,2).join('.'):''),t:(e.textContent||'').trim().slice(0,20)}));
  // 标题上方图
  const cover=w.querySelector('.article-cover');
  return JSON.stringify({url:location.href,kids,audInBody:aud.slice(0,8),coverExists:!!cover,title:(w.querySelector('.article-title')||{}).textContent});
})()`,
);
save("33-audio-article.json", audioArticle);

// D: 正文图片懒加载属性（发刊词已知，看第001讲正文 or 回发刊词都行）
const lazy = await ev(
  `return JSON.stringify([...document.querySelectorAll('div.article-body img')].slice(0,20).map(im=>({loading:im.getAttribute('loading'),nat:im.naturalWidth,src:(im.currentSrc||im.src||'').slice(-30)})));`,
);
save("34-img-lazy.json", lazy);

await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
