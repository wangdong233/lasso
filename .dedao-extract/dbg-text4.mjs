import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const client = new Client({ name: "dbg4", version: "1" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>/tmp/dbg4-stderr.log`],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
const call = (action, options) =>
  client.callTool({ name: "browse_logged_in", arguments: { url: "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz", action, options } }, undefined, { timeout: 90000 }).then((r) => r.content[0].text);
console.log("nav:", (await call("navigate", {})).slice(0, 80));
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 1200));
  const j = JSON.parse(await call("evaluate", { js: `return JSON.stringify({rs:document.readyState,t:!!document.querySelector('.article-title'),len:(document.body.innerText||'').length});` }));
  const p = j?.data?.preview;
  console.log(i, p);
  if (p && p.includes('"t":true')) break;
}
// 精确复刻 evText 第一片
const raw = await call("evaluate", { js: `return JSON.stringify((document.body.innerText).slice(0,1800));` });
const rj = JSON.parse(raw);
console.log("outcome:", rj.outcome, "| preview len:", (rj.data?.preview ?? "").length, "| preview head:", JSON.stringify((rj.data?.preview ?? "").slice(0, 80)));
await transport.close();
setTimeout(() => process.exit(0), 300);
