import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const client = new Client({ name: "dbg3", version: "1" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>/tmp/dbg3-stderr.log`],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
const call = (action, options) =>
  client.callTool({ name: "browse_logged_in", arguments: { url: "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz", action, options } }, undefined, { timeout: 90000 }).then((r) => r.content[0].text);
console.log("nav FULL:", await call("navigate", {}));
await new Promise(r => setTimeout(r, 5000));
console.log("A:", await call("evaluate", { js: `return (document.body.innerText||'').length;` }));
await transport.close();
setTimeout(() => process.exit(0), 300);
