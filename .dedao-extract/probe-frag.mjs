#!/usr/bin/env node
// probe-frag.mjs — 探察 fk 课程表 figure 的碎片化样式与行为（只读 + 单变量实验，禁开新窗）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { holeReport, pdfImages } from "./analyze.mjs";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const SCRATCH = path.join(OUT, "scratch");
const TARGET = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";
const CDP = "http://127.0.0.1:9226";

async function cdpPrint(outName) {
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const tab = tabs.find((t) => t.type === "page" && t.url.startsWith("https://www.dedao.cn/course/article"));
  if (!tab) return { ok: false, err: "no-dedao-tab" };
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(`ws:${String(e)}`)); });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}:${JSON.stringify(m.error)}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    const r = await send("Page.printToPDF", {
      landscape: false, printBackground: true, paperWidth: 8.268, paperHeight: 11.693,
      marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4, scale: 1, preferCSSPageSize: false,
    });
    const buf = Buffer.from(r.data, "base64");
    const p = path.join(SCRATCH, outName);
    fs.writeFileSync(p, buf);
    return { ok: true, path: p };
  } finally { ws.close(); }
}

const client = new Client({ name: "dedao-probe-frag", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-probe-stderr.log"))}`],
  cwd: ROOT, env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
async function ev(js) {
  const res = await client.callTool({ name: "browse_logged_in", arguments: { url: TARGET, action: "evaluate", options: { js } } }, undefined, { timeout: 120000 });
  const r = JSON.parse(res.content[0].text);
  const p = r?.data?.preview ?? "";
  try { return JSON.parse(p); } catch { return { _raw: p.slice(0, 400), _outcome: r?.outcome }; }
}

const JS_PROBE = `return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  const figs=[...show.querySelectorAll('figure')];
  const tall=figs.find(f=>{const im=f.querySelector('img');return im&&im.naturalHeight>5000;});
  if(!tall) return JSON.stringify({err:'no-tall-fig',figCount:figs.length});
  const img=tall.querySelector('img');
  const cs=getComputedStyle(tall), cis=getComputedStyle(img);
  // 站点 CSS 里 figure 相关规则
  let rules=[];
  try{for(const ss of document.styleSheets){let rl;try{rl=ss.cssRules;}catch(e){continue;}
    for(const r of rl){if(r.selectorText&&/figure|editor-show/.test(r.selectorText)&&r.style&&(r.style.breakInside||r.style.pageBreakInside||r.style.marginBottom))
      rules.push(r.selectorText+'{break-inside:'+r.style.breakInside+';page-break-inside:'+r.style.pageBreakInside+';mb:'+r.style.marginBottom+'}');}}}catch(e){}
  return JSON.stringify({figH:Math.round(tall.getBoundingClientRect().height),
    figCS:{breakInside:cs.breakInside,pageBreakInside:cs.pageBreakInside,display:cs.display,contain:cs.contain},
    imgCS:{breakInside:cis.breakInside,display:cis.display,objectFit:cis.objectFit,height:cis.height,maxHeight:cis.maxHeight},
    rules:rules.slice(0,12)});
})()`;

// 实验A：双属性（legacy+modern）+ img display:block 强制
const JS_EXP_A = `return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  const tall=[...show.querySelectorAll('figure')].find(f=>{const im=f.querySelector('img');return im&&im.naturalHeight>5000;});
  if(!tall) return JSON.stringify({err:'no-tall-fig'});
  for(const el of [tall,tall.querySelector('img')]){
    el.style.setProperty('break-inside','auto','important');
    el.style.setProperty('page-break-inside','auto','important');
  }
  const cs=getComputedStyle(tall);
  return JSON.stringify({ok:true,figCS:{breakInside:cs.breakInside,pageBreakInside:cs.pageBreakInside}});
})()`;

// 实验B：条带化（sprite 分块）——把超页高图切成 ~88px 条带块，块可自然流入页内剩余空间
const JS_EXP_B = (chunk) => `return (()=>{
  const show=document.querySelector('div.article-body-wrap .article-body .editor-show')||document.querySelector('div.article-body-wrap .article-body');
  const tall=[...show.querySelectorAll('figure')].find(f=>{const im=f.querySelector('img');return im&&im.naturalHeight>5000;});
  if(!tall) return JSON.stringify({err:'no-tall-fig'});
  const img=tall.querySelector('img');
  const W=img.getBoundingClientRect().width, H=img.getBoundingClientRect().height;
  const src=img.currentSrc||img.src;
  const nat=img.naturalWidth+'x'+img.naturalHeight;
  const c=${chunk};
  const n=Math.ceil(H/c);
  const frag=document.createDocumentFragment();
  for(let k=0;k<n;k++){
    const d=document.createElement('div');
    const hh=Math.min(c,H-k*c);
    d.style.cssText='height:'+hh+'px;overflow:hidden;position:relative;margin:0;padding:0;font-size:0;line-height:0;';
    const im=document.createElement('img');
    im.src=src;
    im.style.cssText='position:absolute;top:'+(-k*c)+'px;left:0;width:'+Math.round(W)+'px;height:auto;max-height:none;display:block;';
    d.appendChild(im);
    frag.appendChild(d);
  }
  tall.innerHTML='';
  tall.appendChild(frag);
  return JSON.stringify({ok:true,chunked:n,chunkPx:c,W:Math.round(W),H:Math.round(H),nat});
})()`;

console.log("[probe]", JSON.stringify(await ev(JS_PROBE)));
console.log("[expA]", JSON.stringify(await ev(JS_EXP_A)));
let pa = await cdpPrint("probe-fk-expA.pdf");
const ra = holeReport(pa.path);
console.log("[expA holes]", JSON.stringify(ra.holes.map(h=>({p:h.page,tail:h.tailPct}))));
console.log("[expA table pages]", JSON.stringify([...new Set(pdfImages(pa.path).filter(r=>r.h>5000).map(r=>r.page))]));
console.log("[expB]", JSON.stringify(await ev(JS_EXP_B(88))));
let pb = await cdpPrint("probe-fk-expB.pdf");
const rb = holeReport(pb.path);
console.log("[expB holes]", JSON.stringify(rb.holes.map(h=>({p:h.page,tail:h.tailPct}))));
console.log("[expB pages]", rb.pages);
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
