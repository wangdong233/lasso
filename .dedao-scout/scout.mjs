#!/usr/bin/env node
/**
 * .dedao-scout/scout.mjs — 得到课程页白盒探察（探察员，一次性全量）
 *
 * 连接 lasso server（LASSO_CDP_PORT=9226），browse_logged_in：
 *   navigate → 就绪轮询 → P1 侧栏章节发现 → P2 章节树全量分片
 *   → P3 右侧内容特征（标题/标题上方图/音频/首次发布/块序列）→ P4 选中态
 * 所有 probe 结果落盘 .dedao-scout/out-*.json，供报告提炼。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-scout");
fs.mkdirSync(OUT, { recursive: true });
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

const client = new Client({ name: "dedao-scout", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [
    "-c",
    `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-stderr.log"))}`,
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

// 公共 helper（每个 evaluate 自包含，注入到 js 头部）
const HELPERS = `
function pathOf(el,k=8){const parts=[];let n=el;while(n&&n!==document.body&&parts.length<k){let s=n.tagName.toLowerCase();if(n.id)s+='#'+n.id;const c=(typeof n.className==='string')?n.className.trim().split(/\\s+/)[0]:'';if(c)s+='.'+c;const sib=[...n.parentElement.children].indexOf(n);parts.unshift(s+':'+sib);n=n.parentElement;}return parts.join('>');}
function txt(el,n=30){const t=(el.textContent||'').trim().replace(/\\s+/g,' ');return t.slice(0,n);}
`;

const log = [];
function step(name, fn) {
  return fn().then(
    (v) => {
      log.push({ name, ok: true });
      console.log(`[ok] ${name}`);
      return v;
    },
    (e) => {
      log.push({ name, ok: false, error: String(e) });
      console.log(`[FAIL] ${name}: ${e}`);
      return null;
    },
  );
}

// ---------- Phase 1: navigate ----------
const nav = await step("navigate", () => browse("navigate", {}));
save("01-navigate.json", nav);

// ---------- Phase 2: readiness ----------
let ready = null;
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const r = await ev(
    `return JSON.stringify({rs:document.readyState,t:document.title,len:(document.body&&document.body.innerText||'').length});`,
  );
  ready = r;
  if (r?.rs === "complete" && (r?.len ?? 0) > 500) break;
}
save("02-ready.json", ready);

// ---------- P1: 侧栏章节条目发现 ----------
const p1 = await ev(
  `${HELPERS}
const out=[];
for(const el of document.querySelectorAll('*')){
  if(el.childElementCount>0) continue;
  const t=(el.textContent||'').trim();
  if(!t||t.length>50) continue;
  if(/^(发刊词|课前必读)/.test(t)||/\\(\\d+讲\\)/.test(t)||/^\\d+\\s*\\|/.test(t)){
    out.push({t:t.slice(0,45),p:pathOf(el.parentElement)});
  }
}
return JSON.stringify({n:out.length,items:out.slice(0,16)});`,
);
save("03-sidebar-hits.json", p1);

// ---------- P2: 章节树容器定位（含命中数最多的祖先） ----------
const p2 = await ev(
  `${HELPERS}
// 找同时包含 >=3 个章节型文本的最深元素
const isChap=(t)=>/^(发刊词|课前必读)/.test(t)||/\\(\\d+讲\\)/.test(t)||/^\\d+\\s*\\|/.test(t);
let best=null;
for(const el of document.querySelectorAll('div,ul,ol,nav,aside,section')){
  let c=0;
  for(const li of el.querySelectorAll('*')){
    if(li.childElementCount===0){const t=(li.textContent||'').trim(); if(t.length<50&&isChap(t))c++;}
  }
  if(c>=3){ if(!best||c>=best.c) best={c,el}; }
}
if(!best) return JSON.stringify({found:false});
const el=best.el;
const kids=[...el.children].map(k=>({tag:k.tagName.toLowerCase(),cls:(typeof k.className==='string'?k.className.trim().split(/\\s+/).slice(0,2).join('.'):''),kids:k.childElementCount,t:txt(k,25)}));
return JSON.stringify({found:true,count:best.c,path:pathOf(el),rect:(r=>({x:r.x,y:r.y,w:r.width,h:r.height}))(el.getBoundingClientRect()),childCount:el.children.length,kids:kids.slice(0,20)});`,
);
save("04-sidebar-container.json", p2);

// ---------- P2b: 章节树全量（分片拉取叶子文本序列） ----------
const total = await ev(
  `${HELPERS}
const isChap=(t)=>/^(发刊词|课前必读)/.test(t)||/\\(\\d+讲\\)/.test(t)||/^\\d+\\s*\\|/.test(t);
const leaves=[];
for(const el of document.querySelectorAll('*')){
  if(el.childElementCount===0){const t=(el.textContent||'').trim(); if(t.length<60&&isChap(t))leaves.push(el);}
}
window.__ddLeaves=leaves;
return JSON.stringify({total:leaves.length});`,
);
save("05-sidebar-total.json", total);
const N = total?.total ?? 0;
const CH = 12;
for (let a = 0; a < N && a < 120; a += CH) {
  const r = await ev(
    `${HELPERS}
const L=window.__ddLeaves||[];
const out=[];
for(let i=${a};i<Math.min(${a + CH},L.length);i++){
  const el=L[i];
  out.push({i,t:(el.textContent||'').trim().slice(0,45),tag:el.tagName.toLowerCase(),cls:(typeof el.className==='string'?el.className.trim().split(/\\s+/).slice(0,2).join('.'):''),clickable:!!el.closest('a,button,[role="button"],[class*="item" i]'),href:(el.closest('a')||{}).href||''});
}
return JSON.stringify(out);`,
  );
  save(`06-sidebar-slice-${String(a).padStart(3, "0")}.json`, r);
}

// ---------- P3: 右侧内容特征 ----------
// P3a: 「首次发布」标记
const p3a = await ev(
  `${HELPERS}
const out=[];
for(const el of document.querySelectorAll('*')){
  if(el.childElementCount===0){
    const t=(el.textContent||'').trim();
    if(t==='首次发布'||/^首次发布/.test(t)){
      out.push({t:t.slice(0,30),p:pathOf(el),parentKids:[...(el.parentElement?.children||[])].map(k=>k.tagName.toLowerCase()+'.'+(typeof k.className==='string'?k.className.trim().split(/\\s+/)[0]:'')+'('+txt(k,18)+')').slice(0,8)});
    }
  }
}
return JSON.stringify({n:out.length,items:out.slice(0,5)});`,
);
save("07-firstpub.json", p3a);

// P3b: 标题候选 + 音频 + 图片
const p3b = await ev(
  `${HELPERS}
const heads=[...document.querySelectorAll('h1,h2,h3')].map(h=>({tag:h.tagName.toLowerCase(),t:txt(h,40),p:pathOf(h)})).filter(x=>x.t).slice(0,10);
const auds=[...document.querySelectorAll('audio,iframe,[class*="audio" i],[class*="player" i]')].map(a=>({tag:a.tagName.toLowerCase(),cls:(typeof a.className==='string'?a.className.trim().split(/\\s+/).slice(0,2).join('.'):''),src:(a.src||a.getAttribute('src')||'').slice(0,60),p:pathOf(a)})).slice(0,10);
return JSON.stringify({heads,audN:auds.length,auds});`,
);
save("08-heads-audio.json", p3b);

const p3c = await ev(
  `${HELPERS}
const imgs=[...document.querySelectorAll('img')].map(im=>{const r=im.getBoundingClientRect();return {src:(im.currentSrc||im.src||'').replace(/^https?:\\/\\/[^/]+/,'').slice(0,50),nat:im.naturalWidth+'x'+im.naturalHeight,cli:Math.round(r.width)+'x'+Math.round(r.height),top:Math.round(r.y),alt:(im.alt||'').slice(0,15),p:pathOf(im)};}).filter(x=>!x.src.includes('icon')&&!x.src.includes('.svg'));
return JSON.stringify({n:imgs.length,items:imgs.slice(0,18)});`,
);
save("09-images.json", p3c);

// P3d: 正文容器块序列（标题与首次发布的公共祖先的直接子树）
const p3d = await ev(
  `${HELPERS}
let firstPub=null,h1=null;
for(const el of document.querySelectorAll('*')){
  if(el.childElementCount===0&&(el.textContent||'').trim()==='首次发布'&&!firstPub) firstPub=el;
}
h1=document.querySelector('h1')||document.querySelector('h2');
if(!firstPub||!h1) return JSON.stringify({found:!!firstPub,h1:!!h1});
let a=h1,b=firstPub,anc=null;
const set=new Set();let n=a;while(n){set.add(n);n=n.parentElement;}
n=b;while(n){if(set.has(n)){anc=n;break;}n=n.parentElement;}
if(!anc||anc===document.body) {anc=h1.closest('div[class]')||h1.parentElement;}
const dump=(el,d)=>{const o=[];for(const k of el.children){if(d>=3)break;o.push({d,tag:k.tagName.toLowerCase(),cls:(typeof k.className==='string'?k.className.trim().split(/\\s+/)[0]:'')||undefined,kids:k.childElementCount,t:txt(k,22),im:k.querySelector('img')?1:0});if(d<2&&k.childElementCount>0&&k.childElementCount<12)o.push(...dump(k,d+1));}return o;};
return JSON.stringify({ancPath:pathOf(anc),ancCls:(typeof anc.className==='string'?anc.className:''),blocks:dump(anc,0).slice(0,40)});`,
);
save("10-content-blocks.json", p3d);

// ---------- P4: 当前选中子章节 ----------
const p4 = await ev(
  `${HELPERS}
const out=[];
for(const el of document.querySelectorAll('[aria-current],[aria-selected],[class*="active" i],[class*="selected" i],[class*="current" i]')){
  if(el.childElementCount<12){
    const t=(el.textContent||'').trim().replace(/\\s+/g,' ');
    if(t.length>2&&t.length<60&&(pathOf(el).length<200)) out.push({t:t.slice(0,40),tag:el.tagName.toLowerCase(),cls:(typeof el.className==='string'?el.className.trim().split(/\\s+/).slice(0,3).join('.'):''),aria:el.getAttribute('aria-current')||el.getAttribute('aria-selected')||'',p:pathOf(el)});
  }
}
return JSON.stringify({n:out.length,items:out.slice(0,12)});`,
);
save("11-selected.json", p4);

// ---------- P5: 整页布局骨架（左栏/右栏容器） ----------
const p5 = await ev(
  `${HELPERS}
// 找视口内最高的两个纵向容器（侧栏 vs 内容列）
const cand=[];
for(const el of document.querySelectorAll('div,aside,nav,section,main')){
  const r=el.getBoundingClientRect();
  if(r.height>600&&r.width>150&&r.width<900&&el!==document.body){
    cand.push({w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),cls:(typeof el.className==='string'?el.className.trim().split(/\\s+/).slice(0,2).join('.'):''),p:pathOf(el,5)});
  }
}
cand.sort((a,b)=>b.h-a.h);
return JSON.stringify({n:cand.length,items:cand.slice(0,10)});`,
);
save("12-layout.json", p5);

save("99-log.json", log);
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
