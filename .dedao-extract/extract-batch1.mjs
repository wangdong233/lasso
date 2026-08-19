#!/usr/bin/env node
/**
 * .dedao-extract/extract-batch1.mjs — 得到·薛兆丰的经济学课 首批 3 子章节 PDF 抽取
 *
 * 白盒流程（探察报告 00 §5）：
 *   navigate → ready → [每讲] ensure/click → stabilize+lazyload → assertProbe
 *   → browse(action:"evaluate", options.steps:[{evaluate 清理},{pdf}])（链内 pdf 无 NAV_FIRST）
 *   → bounded_output.ref → 直读 os.tmpdir()/lasso-output/@oN.txt（回退 read_text 翻页）
 *   → base64 解码落盘 → %PDF 魔数校验
 *
 * 红线遵守：
 *   - 清理与 pdf 必须同一 browse 调用的 steps 链（BrowseChannel browseSingle L311
 *     NAV_FIRST vs executeStep L473 不重导航）
 *   - 单 server 进程完成全部动作；Chrome(pid 85359) 不在本 server 台账，退出不杀
 *   - evaluate 返回 preview 硬截 4000 字符 → 各 probe 返回紧凑 JSON
 *   - 异步 evaluate 写 return (async()=>{...})()
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
fs.mkdirSync(OUT, { recursive: true });
const BASE = "/Users/wangdong/Documents/Project/cc-control-all/得到_薛兆丰的经济学";
const TARGET =
  "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

// 首批 3 子章节（章节树.json：课前必读×1 + 01 章前 2 讲）
const ARTICLES = [
  {
    chapterDir: "课前必读(1讲)",
    title: "发刊词丨只给你地道的经济学思维",
    expectAudio: false,
  },
  {
    chapterDir: "01-经济学本源之一：东西不够(110讲)",
    title: "第001讲丨战俘营里的经济组织",
    expectAudio: true,
  },
  {
    chapterDir: "01-经济学本源之一：东西不够(110讲)",
    title: "第002讲丨马粪争夺案",
    expectAudio: true,
  },
];

const log = [];
function save(name, obj) {
  fs.writeFileSync(
    path.join(OUT, name),
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
  );
}
function note(msg) {
  console.log(msg);
  log.push(msg);
}

const client = new Client({ name: "dedao-extract-b1", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: [
    "-c",
    `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-b1-stderr.log"))}`,
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
  if (r?.outcome !== "worked" && r?.outcome !== undefined) {
    return { _outcome: r?.outcome, _error: r?.error, _raw: p.slice(0, 300) };
  }
  try {
    return JSON.parse(p);
  } catch {
    return { _raw: p.slice(0, 600), _outcome: r?.outcome };
  }
}

// ---------------- Phase 1: navigate + ready ----------------
let nav = await browse("navigate", {});
save("b1-01-navigate.json", nav);
if (nav.outcome !== "worked") {
  note(`[FATAL] navigate outcome=${nav.outcome} error=${nav.error}`);
  save("b1-99-log.json", log);
  process.exit(1);
}
let ready = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1200));
  ready = await ev(
    `return JSON.stringify({rs:document.readyState,title:(document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,40),len:(document.body&&document.body.innerText||'').length});`,
  );
  if (ready?.rs === "complete" && (ready?.len ?? 0) > 800 && ready?.title) break;
}
save("b1-02-ready.json", ready);
note(`[ready] ${JSON.stringify(ready)}`);
if (!ready?.title) {
  note("[FATAL] article-title 未出现");
  save("b1-99-log.json", log);
  process.exit(1);
}

// ---------------- 每讲公共 evaluate 片段 ----------------
const JS_SWITCH = (want) => `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const want=${JSON.stringify(want)};
  const cur=q('div.article-body-wrap .article-title');
  const curT=cur?(cur.textContent||'').trim():'';
  if(curT===want){return JSON.stringify({mode:'already',title:curT,url:location.href});}
  const find=()=>[...document.querySelectorAll('div.course-nav ul.course-module>li')]
    .find(li=>(li.textContent||'').trim().replace(/\\s+/g,' ').startsWith(want));
  let li=find();
  if(!li){const ps=q('div.course-nav div.ps');if(ps){ps.scrollTop=0;await new Promise(r=>setTimeout(r,700));}li=find();}
  if(!li){return JSON.stringify({mode:'notfound',curTitle:curT});}
  li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
  const t0=Date.now();
  while(Date.now()-t0<20000){
    await new Promise(r=>setTimeout(r,400));
    const t=q('div.article-body-wrap .article-title');
    const tt=t?(t.textContent||'').trim():'';
    if(tt===want){return JSON.stringify({mode:'clicked',title:tt,url:location.href});}
  }
  const t=q('div.article-body-wrap .article-title');
  return JSON.stringify({mode:'timeout',curTitle:t?(t.textContent||'').trim():''});
})()`;

const JS_STABILIZE = `return (async()=>{
  const q=(s)=>document.querySelector(s);
  const body=q('div.article-body-wrap .article-body');
  if(!body) return JSON.stringify({ok:false,err:'no-body'});
  let last=-1,stable=0;
  for(let i=0;i<40;i++){
    const len=(body.innerText||'').length+body.querySelectorAll('img').length*1000;
    if(len===last){stable++;if(stable>=3)break;}else{stable=0;last=len;}
    await new Promise(r=>setTimeout(r,400));
  }
  const H=Math.max(document.scrollingElement?document.scrollingElement.scrollHeight:0,document.documentElement.scrollHeight);
  const step=Math.max(600,Math.floor(window.innerHeight*1.5));
  let n=0;
  for(let y=0;y<H&&n<90;y+=step,n++){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,150));}
  window.scrollTo(0,H);await new Promise(r=>setTimeout(r,600));
  let imgs=[];
  for(let i=0;i<25;i++){
    imgs=[...document.querySelectorAll('div.article-body img')];
    if(imgs.every(im=>im.complete&&(im.naturalWidth>0||!im.src)))break;
    await new Promise(r=>setTimeout(r,400));
  }
  window.scrollTo(0,0);await new Promise(r=>setTimeout(r,400));
  try{await document.fonts.ready;}catch(e){}
  return JSON.stringify({ok:true,bodyLen:(body.innerText||'').length,imgs:imgs.length,imgsNotLoaded:imgs.filter(im=>!(im.complete&&im.naturalWidth>0)).length,docH:document.documentElement.scrollHeight});
})()`;

const JS_ASSERT = `return (()=>{
  const q=(s)=>document.querySelector(s);
  const wrap=q('div.article > div.article-wrap > div.article-body-wrap');
  const title=q('div.article-body-wrap .article-title');
  const body=wrap?wrap.querySelector('.article-body'):null;
  return JSON.stringify({
    url:location.href,
    title:title?(title.textContent||'').trim().slice(0,40):null,
    hasWrap:!!wrap,
    cover:!!(wrap&&wrap.querySelector('.article-cover')),
    ddAudio:wrap?wrap.querySelectorAll('.dd-audio').length:0,
    audioTags:wrap?wrap.querySelectorAll('audio').length:0,
    timeInfo:!!(wrap&&wrap.querySelector(':scope > div.article-time-info')),
    wrapChildren:wrap?[...wrap.children].map(c=>c.tagName+'.'+(typeof c.className==='string'?c.className.trim().split(/\\s+/)[0]:'')).slice(0,8):[],
    bodyLen:body?(body.innerText||'').length:0
  });
})()`;

// 清理：排除①标题上方图 ②音频(dd-audio/audio) ③首次发布起后缀；删工具条；
// 隐藏左栏/顶栏/右缘条/底部播放条；article 列 x>60 时做布局重置（A4 可容纳 700px 栏）
const JS_CLEANUP = `return (()=>{
  const q=(s,r)=>(r||document).querySelector(s);
  const qa=(s,r)=>[...(r||document).querySelectorAll(s)];
  const rep={ok:true,del:{},hid:{},residual:{}};
  const wrap=q('div.article > div.article-wrap > div.article-body-wrap');
  if(!wrap){return JSON.stringify({ok:false,err:'no-wrap'});}
  const pc=qa(':scope > div.pageControl',wrap);rep.del.pageControl=pc.length;pc.forEach(n=>n.remove());
  const c=q('.article-cover',wrap);rep.del.cover=!!c;if(c)c.remove();
  const da=qa('.dd-audio',wrap);rep.del.ddAudio=da.length;da.forEach(n=>n.remove());
  const au=qa('audio',wrap);rep.del.audioTags=au.length;au.forEach(n=>n.remove());
  const ti=q(':scope > div.article-time-info',wrap);rep.del.timeInfo=!!ti;
  if(ti){let n=ti,cnt=0;while(n){const nx=n.nextElementSibling;n.remove();n=nx;cnt++;}rep.del.tailSiblingsRemoved=cnt;}
  for(const sel of ['.iget-header','div.course-nav','aside.iget-side-button','div.course-nav-mask','.iget-audio-player']){
    const els=qa(sel);els.forEach(e=>e.style.setProperty('display','none','important'));rep.hid[sel]=els.length;
  }
  const art=q('div.iget-articles > div.article');
  const r1=art?art.getBoundingClientRect():null;
  rep.rectBefore=r1?{x:Math.round(r1.x),y:Math.round(r1.y),w:Math.round(r1.width)}:null;
  if(art&&r1&&r1.x>60){
    const arts=q('div.iget-articles');
    if(arts){arts.style.setProperty('padding','0','important');arts.style.setProperty('margin','0','important');}
    art.style.setProperty('position','static','important');
    art.style.setProperty('left','auto','important');
    art.style.setProperty('margin','0','important');
    art.style.setProperty('transform','none','important');
    document.body.style.setProperty('margin','0','important');
  }
  const r2=art?art.getBoundingClientRect():null;
  rep.rectAfter=r2?{x:Math.round(r2.x),y:Math.round(r2.y),w:Math.round(r2.width)}:null;
  rep.residual={cover:qa('.article-cover').length,ddAudio:qa('.dd-audio').length,timeInfo:qa('.article-time-info').length,myComment:qa('.my-comment').length,messageV2:qa('.message-v2').length};
  return JSON.stringify(rep);
})()`;

// ---------------- 取回 chain JSON（spill 直读，回退 read_text 翻页） ----------------
async function retrieveChainJson(data) {
  if (data?.chain) return JSON.stringify(data.chain);
  const ref = data?.bounded_output?.ref;
  if (!ref) return null;
  const spill = path.join(os.tmpdir(), "lasso-output", `${ref}.txt`);
  if (fs.existsSync(spill)) {
    return fs.readFileSync(spill, "utf8");
  }
  // 回退：read_text 16KiB/64KiB 翻页
  let off = 0;
  const chunks = [];
  for (let i = 0; i < 600; i++) {
    const res = await client.callTool(
      { name: "read_text", arguments: { ref, offset: off, limit: 65536 } },
      undefined,
      { timeout: 60000 },
    );
    const p = JSON.parse(res.content[0].text);
    chunks.push(p.text);
    off += Buffer.byteLength(p.text, "utf8");
    if (p.eof) break;
  }
  return chunks.join("");
}

// ---------------- Phase 2: 逐讲抽取 ----------------
const results = [];
for (let i = 0; i < ARTICLES.length; i++) {
  const a = ARTICLES[i];
  const tag = `b1-a${i + 1}`;
  note(`\n===== [${i + 1}/${ARTICLES.length}] ${a.title} =====`);
  const meta = { ...a, phases: {} };

  // 2.1 切换/确认子章节
  const sw = await ev(JS_SWITCH(a.title));
  meta.phases.switch = sw;
  save(`${tag}-switch.json`, sw);
  note(`[switch] ${JSON.stringify(sw)}`);
  if (sw?.mode !== "already" && sw?.mode !== "clicked") {
    meta.fatal = `switch_failed:${sw?.mode}`;
    results.push(meta);
    continue;
  }

  // 2.2 稳定 + 懒加载
  const st = await ev(JS_STABILIZE, 180000);
  meta.phases.stabilize = st;
  save(`${tag}-stabilize.json`, st);
  note(`[stabilize] ${JSON.stringify(st)}`);
  if (!st?.ok) {
    meta.fatal = `stabilize_failed:${st?.err}`;
    results.push(meta);
    continue;
  }

  // 2.3 删前断言（白盒定位准确才允许清理）
  const as = await ev(JS_ASSERT);
  meta.phases.assert = as;
  save(`${tag}-assert.json`, as);
  note(`[assert] ${JSON.stringify(as)}`);
  const assertFails = [];
  if (!as?.hasWrap) assertFails.push("no-wrap");
  if (!as?.timeInfo) assertFails.push("no-time-info(exclude3-boundary)");
  if (!as?.cover) assertFails.push("no-cover(exclude1)");
  if (as?.title !== a.title) assertFails.push(`title-mismatch:${as?.title}`);
  if (as?.ddAudio === 0 && a.expectAudio) assertFails.push("audio-article-but-no-dd-audio");
  meta.assertFails = assertFails;
  if (assertFails.some((f) => f.startsWith("no-wrap") || f.startsWith("no-time") || f.startsWith("title-"))) {
    meta.fatal = `assert_failed:${assertFails.join(",")}`;
    results.push(meta);
    continue;
  }

  // 2.4 清理 + PDF（同一 steps 链；链内 pdf 不重导航）
  const chainRes = await browse(
    "evaluate",
    {
      steps: [
        { action: "evaluate", js: JS_CLEANUP, timeout_ms: 30000, label: "cleanup" },
        { action: "pdf", label: "print-pdf" },
      ],
    },
    300000,
  );
  save(`${tag}-chain.json`, {
    outcome: chainRes.outcome,
    error: chainRes.error,
    stopped_at: chainRes.data?.stopped_at ?? null,
    bounded: chainRes.data?.bounded_output
      ? {
          ref: chainRes.data.bounded_output.ref,
          total_bytes: chainRes.data.bounded_output.total_bytes,
        }
      : null,
    has_chain_inline: !!chainRes.data?.chain,
    preview_head: (chainRes.data?.preview ?? "").slice(0, 200),
  });
  if (chainRes.outcome !== "worked" || chainRes.data?.stopped_at) {
    meta.fatal = `chain_failed:${chainRes.outcome}:${chainRes.error ?? JSON.stringify(chainRes.data?.stopped_at)}`;
    note(`[FATAL] ${meta.fatal}`);
    results.push(meta);
    continue;
  }

  const chainJson = await retrieveChainJson(chainRes.data);
  if (!chainJson) {
    meta.fatal = "no_chain_payload";
    results.push(meta);
    continue;
  }
  let chain = null;
  try {
    chain = JSON.parse(chainJson);
  } catch (e) {
    meta.fatal = `chain_json_parse_failed:${String(e).slice(0, 120)}`;
    results.push(meta);
    continue;
  }
  const aar = chain.actions_and_results ?? [];
  const cleanupStep = aar.find((x) => x.step.action === "evaluate");
  const pdfStep = aar.find((x) => x.step.action === "pdf");
  meta.cleanup = cleanupStep ? cleanupStep.results[0] : null;
  save(`${tag}-cleanup.json`, cleanupStep ? cleanupStep.results[0] : null);
  note(`[cleanup] ${cleanupStep ? cleanupStep.results[0].preview : "(none)"}`);
  if (!pdfStep || pdfStep.results[0].outcome !== "worked") {
    meta.fatal = `pdf_step_failed:${pdfStep ? JSON.stringify(pdfStep.results[0]).slice(0, 300) : "no-pdf-step"}`;
    results.push(meta);
    continue;
  }
  const b64 = pdfStep.results[0].preview ?? "";
  const buf = Buffer.from(b64.replace(/\s+/g, ""), "base64");
  if (buf.length < 5000 || buf.slice(0, 5).toString("latin1") !== "%PDF-") {
    meta.fatal = `bad_pdf_magic:len=${buf.length},head=${buf.slice(0, 10).toString("latin1")}`;
    results.push(meta);
    continue;
  }
  const outDir = path.join(BASE, a.chapterDir);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${a.title}.pdf`);
  fs.writeFileSync(outPath, buf);
  meta.pdfPath = outPath;
  meta.pdfBytes = buf.length;
  note(`[PDF] ${outPath} (${(buf.length / 1024 / 1024).toFixed(2)} MiB)`);
  results.push(meta);
}

save("b1-98-results.json", results);
save("b1-99-log.json", log);
note("\n===== SUMMARY =====");
for (const r of results) {
  note(`${r.fatal ? "FAIL" : "OK  "} ${r.title} -> ${r.pdfPath ?? r.fatal}`);
}
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
