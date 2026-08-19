#!/usr/bin/env node
// debug text fetch — 看 evaluate 原始返回
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const client = new Client({ name: "dbg", version: "1" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>/tmp/dbg-stderr.log`],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
const call = (js) =>
  client
    .callTool(
      { name: "browse_logged_in", arguments: { url: "https://www.dedao.cn/course/article?id=1", action: "evaluate", options: { js } } },
      undefined,
      { timeout: 60000 },
    )
    .then((r) => r.content[0].text);
console.log("A:", await call(`return JSON.stringify((document.body.innerText).slice(0,60));`));
console.log("B:", await call(`return (document.body.innerText||'').length;`));
await transport.close();
setTimeout(() => process.exit(0), 300);
