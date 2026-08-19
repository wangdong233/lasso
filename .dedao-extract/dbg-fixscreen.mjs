#!/usr/bin/env node
// dbg-fixscreen.mjs — 捕获 JS_FIX_SCREEN 的原始 evaluate 返回（定位 dropped=undefined 根因）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import * as fs from "node:fs";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const OUT = path.join(ROOT, ".dedao-extract");
const TARGET = "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz";

// 从 extract-v2.mjs 源码原样抽取 JS_FIX_SCREEN（保证测的就是产线代码）
const src = fs.readFileSync(path.join(OUT, "extract-v2.mjs"), "utf8");
const m = src.match(/const JS_FIX_SCREEN = `([\s\S]*?)`;/);
if (!m) { console.error("extract failed"); process.exit(1); }
const PAGE_CSS = 1046;
const JS_FIX_SCREEN = m[1].replace("${PAGE_CSS}", String(PAGE_CSS));

const client = new Client({ name: "dedao-dbg-fs", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(OUT, "server-dbg-stderr.log"))}`],
  cwd: ROOT, env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
async function browse(action, options = {}, timeoutMs = 180000) {
  const res = await client.callTool({ name: "browse_logged_in", arguments: { url: TARGET, action, options } }, undefined, { timeout: timeoutMs });
  return JSON.parse(res.content[0].text);
}

// navigate 先行（P6：新 server 会话需先绑定 page）
const nav = await browse("navigate", {});
console.log("[nav]", JSON.stringify(nav).slice(0, 120));
await new Promise((r) => setTimeout(r, 2500));
const t = await browse("evaluate", { js: `return JSON.stringify({title:(document.querySelector('div.article-body-wrap .article-title')||{textContent:''}).textContent.trim().slice(0,30),figs:document.querySelectorAll('div.article-body-wrap figure').length});` });
console.log("[state]", t.data?.preview ?? JSON.stringify(t).slice(0, 200));

const r = await browse("evaluate", { js: JS_FIX_SCREEN }, undefined, { timeout: 120000 });
console.log("[outcome]", r.outcome, "| [error]", r.error ?? null);
console.log("[preview]", (r.data?.preview ?? "").slice(0, 1500));
await transport.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
