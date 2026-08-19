#!/usr/bin/env node
/**
 * scout2.mjs — 第二轮深度探察：侧栏章节树 / 音频行归属 / 标题节点 /
 * 滚动容器 / 点击目标 / article-body-wrap 块序 / 懒加载状态
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-scout");
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-scout2", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [
    "-c",
    `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server2-stderr.log"))}`,
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
    return { _raw: p, _outcome: r?.outcome, _err: r?.error };
  }
}
function save(name, obj) {
  fs.writeFileSync(
    path.join(OUT, name),
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
  );
  console.log(`saved ${name}`);
}
const HELPERS = `
function pathOf(el,k=16){const parts=[];let n=el;while(n&&n!==document.body&&parts.length<k){let s=n.tagName.toLowerCase();if(n.id)s+='#'+n.id;const c=(typeof n.className==='string')?n.className.trim().split(/\\s+/)[0]:'';if(c)s+='.'+c;const sib=[...n.parentElement.children].indexOf(n);parts.unshift(s+':'+sib);n=n.parentElement;}return parts.join('>');}
function txt(el,n=28){const t=(el.textContent||'').trim().replace(/\\s+/g,' ');return t.slice(0,n);}
`;

await browse("navigate", {});
let ready = null;
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  ready = await ev(
    `return JSON.stringify({rs:document.readyState,t:document.title,len:(document.body&&document.body.innerText||'').length});`,
  );
  if (ready?.rs === "complete" && /得到/.test(ready?.t ?? "") && (ready?.len ?? 0) > 800) break;
}
save("20-ready.json", ready);

// A: 侧栏 course-nav 全结构（4 层）+ 章节头/子项枚举 + 滚动容器
const pa = await ev(
  `${HELPERS}
const nav=document.querySelector('div.iget-articles>div.course-nav');
if(!nav) return JSON.stringify({found:false});
const headers=[...nav.querySelectorAll('.chapterp-header')].map(h=>({t:txt(h,40),p:pathOf(h,6),nextUlSib:(()=>{let s=h.parentElement.nextElementSibling;return s?('ul'+(s.tagName==='UL'?'.course-module':'')+' li='+s.querySelectorAll('li').length):null;})()}));
const lis=[...nav.querySelectorAll('ul.course-module>li')].map((li,i)=>({i,t:txt(li,36),cls:li.className.split(/\\s+/).slice(0,3).join('.'),attrs:Object.fromEntries([...li.attributes].filter(a=>a.name.startsWith('data-')).map(a=>[a.name,a.value])),a:(()=>{const a=li.querySelector('a');return a?{href:a.getAttribute('href'),t:txt(a,20)}:null;})()}));
const scrollers=[...nav.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+40).map(e=>({cls:(typeof e.className==='string'?e.className.trim().split(/\\s+/)[0]:''),sh:e.scrollHeight,ch:e.clientHeight}));
return JSON.stringify({navKids:[...nav.children].map(k=>({tag:k.tagName.toLowerCase(),cls:k.className.split(/\\s+/)[0],kids:k.childElementCount,t:txt(k,20)})),headers,nHeader:headers.length,lis:nLis=lis.length,liSample:lis.slice(0,14),scrollers});`,
);
save("21-sidebar-deep.json", pa);

// B: 右栏 article-body-wrap 块序 + div:1 内部（cover/title/info 顺序）
const pb = await ev(
  `${HELPERS}
const w=document.querySelector('div.article>div.article-wrap>div.article-body-wrap');
if(!w) return JSON.stringify({found:false});
const kids=[...w.children].map((k,i)=>({i,tag:k.tagName.toLowerCase(),cls:k.className.split(/\\s+/).slice(0,2).join('.'),h:Math.round(k.getBoundingClientRect().height),t:txt(k,24)}));
const inner=w.children[1]?[...w.children[1].children].map((k,i)=>({i,tag:k.tagName.toLowerCase(),cls:k.className.split(/\\s+/).slice(0,2).join('.'),h:Math.round(k.getBoundingClientRect().height),t:txt(k,26)})):[];
return JSON.stringify({found:true,kids,inner});`,
);
save("22-right-blocks.json", pb);

// B2: 标题节点精确定位
const pb2 = await ev(
  `${HELPERS}
const els=[...document.querySelectorAll('.article-title,[class*="article-title"]')].map(e=>({tag:e.tagName.toLowerCase(),cls:e.className.split(/\\s+/).slice(0,2).join('.'),t:txt(e,40),p:pathOf(e,9),h:Math.round(e.getBoundingClientRect().height)}));
const cover=document.querySelector('.article-cover');
const info=document.querySelector('.article-info');
return JSON.stringify({titles:els,coverP:cover?pathOf(cover,9):null,infoP:info?pathOf(info,9):null});`,
);
save("23-title.json", pb2);

// C: play-btn 行列表的归属容器（深路径）
const pc = await ev(
  `${HELPERS}
const btns=[...document.querySelectorAll('.play-btn')];
const roots=[...new Set(btns.map(b=>{let n=b;while(n&&n.parentElement&&n!==document.body){if(n.tagName==='UL'&&n.className.includes('course-module'))return n;n=n.parentElement;}return null;}))];
return JSON.stringify({nBtn:btns.length,roots:roots.map(r=>({p:pathOf(r),li:r.children.length,firstLi:txt(r.children[0],40),inCourseNav:!!r.closest('div.course-nav'),rect:(r2=>({x:Math.round(r2.x),y:Math.round(r2.y),w:Math.round(r2.width),h:Math.round(r2.height)}))(r.getBoundingClientRect())}))});`,
);
save("24-playbtn-roots.json", pc);

// D: 侧栏是否虚拟滚动：当前 li 数 vs 章节声明数；chapterp-header 的父结构
const pd = await ev(
  `${HELPERS}
const nav=document.querySelector('div.course-nav');
const chapterMods=[...nav.querySelectorAll('.chapter-mod')].map((m,i)=>({i,cls:m.className.split(/\\s+/).slice(0,2).join('.'),header:txt(m.querySelector('.chapterp-header'),36),liCount:m.querySelectorAll('ul.course-module>li').length,liTitles:[...m.querySelectorAll('ul.course-module>li')].slice(0,4).map(li=>txt(li,30))}));
const ps=nav.querySelector('.ps');
return JSON.stringify({chapterMods,psInfo:ps?{sh:ps.scrollHeight,ch:ps.clientHeight}:null});`,
);
save("25-chapter-mods.json", pd);

// E: 正文 figure/图片 + 懒加载属性 + 段落结构
const pe = await ev(
  `${HELPERS}
const body=document.querySelector('div.article-body');
if(!body) return JSON.stringify({found:false});
const ed=body.querySelector('.editor-show');
const figs=[...(ed?ed.children:[])].map((k,i)=>({i,tag:k.tagName.toLowerCase(),cls:k.className.split(/\\s+/)[0]||undefined,t:txt(k,16),img:k.querySelector('img')?{loading:k.querySelector('img').getAttribute('loading'),nat:k.querySelector('img').naturalWidth}:null}));
return JSON.stringify({found:true,bodyCls:body.className.split(/\\s+/).slice(0,2).join('.'),nChildren:(ed?ed.children.length:0),figs:figs.slice(0,30)});`,
);
save("26-editor-children.json", pe);

// F: 全局音频播放器（iget-audio-player）与正文音频关系
const pf = await ev(
  `${HELPERS}
const ap=document.querySelector('.iget-audio-player');
const bodyAudio=[...document.querySelectorAll('div.article-body audio,div.article-body iframe,div.article-body [class*="audio" i]')].map(e=>({tag:e.tagName.toLowerCase(),cls:(typeof e.className==='string'?e.className.trim().split(/\\s+/).slice(0,2).join('.'):''),p:pathOf(e,8)}));
return JSON.stringify({playerExists:!!ap,playerP:ap?pathOf(ap,4):null,playerH:ap?Math.round(ap.getBoundingClientRect().height):0,bodyAudio});`,
);
save("27-audio.json", pf);

// G: 首次发布节点同层及之后的兄弟（删除边界确认）+ 该节点上方紧邻块
const pg = await ev(
  `${HELPERS}
const ti=document.querySelector('.article-time-info');
if(!ti) return JSON.stringify({found:false});
const w=ti.parentElement;
const idx=[...w.children].indexOf(ti);
const sibs=[...w.children].map((k,i)=>({i,tag:k.tagName.toLowerCase(),cls:k.className.split(/\\s+/).slice(0,2).join('.'),h:Math.round(k.getBoundingClientRect().height),t:txt(k,22)}));
return JSON.stringify({found:true,parentCls:w.className.split(/\\s+/)[0],tiIdx:idx,sibs});`,
);
save("28-timeinfo-siblings.json", pg);

// H: 页面滚动体系（window vs 内部容器）
const ph = await ev(
  `${HELPERS}
const se=document.scrollingElement;
const inner=[...document.querySelectorAll('div.iget-articles *')].filter(e=>e.scrollHeight>e.clientHeight+200&&e.clientHeight>300).map(e=>({cls:e.className.split(/\\s+/).slice(0,2).join('.'),sh:e.scrollHeight,ch:e.clientHeight})).slice(0,6);
return JSON.stringify({docSH:se.scrollHeight,docCH:se.clientHeight,inner});`,
);
save("29-scroll.json", ph);

await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
