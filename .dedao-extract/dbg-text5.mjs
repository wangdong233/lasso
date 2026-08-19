import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const client = new Client({ name: "dbg5", version: "1" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>/tmp/dbg5-stderr.log`],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
const call = (action, options) =>
  client.callTool({ name: "browse_logged_in", arguments: { url: "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz", action, options } }, undefined, { timeout: 90000 }).then((r) => r.content[0].text);
console.log("nav ok:", JSON.parse(await call("navigate", {})).outcome);
await new Promise(r => setTimeout(r, 4000));
// b3 JS_CLEANUP 原样（从 scout7 文件抽取，保证一字不差）
const src = fs.readFileSync(".dedao-extract/scout7-round2.mjs", "utf8");
const m = src.match(/const JS_CLEANUP = `return \(\(\)=>\{[\s\S]*?\}\)\(\)`;/);
await call("evaluate", { js: m[0].replace("const JS_CLEANUP = ", "").replace(/;$/, "") });
const raw = await call("evaluate", { js: `return JSON.stringify((document.body.innerText).slice(0,1800));` });
const rj = JSON.parse(raw);
const p = rj?.data?.preview ?? "";
console.log("outcome:", rj.outcome, "| preview len:", p.length);
console.log("preview head:", JSON.stringify(p.slice(0, 120)));
console.log("preview tail:", JSON.stringify(p.slice(-120)));
try { const s = JSON.parse(p); console.log("parse OK, string len:", s.length, "| head:", JSON.stringify(s.slice(0, 40))); } catch (e) { console.log("parse FAIL:", e.message); }
const raw2 = await call("evaluate", { js: `return JSON.stringify((document.body.innerText||'').length);` });
console.log("innerText len direct:", JSON.parse(raw2)?.data?.preview);
await transport.close();
setTimeout(() => process.exit(0), 300);
