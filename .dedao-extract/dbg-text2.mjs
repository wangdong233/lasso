import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const client = new Client({ name: "dbg2", version: "1" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>/tmp/dbg2-stderr.log`],
  cwd: ROOT,
  env: { ...process.env, LASSO_CDP_PORT: "9226" },
});
await client.connect(transport);
const call = (action, options) =>
  client.callTool({ name: "browse_logged_in", arguments: { url: "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz", action, options } }, undefined, { timeout: 90000 }).then((r) => r.content[0].text);
console.log("nav:", (await call("navigate", {})).slice(0, 120));
await new Promise(r => setTimeout(r, 4000));
console.log("A body.innerText len:", await call("evaluate", { js: `return (document.body.innerText||'').length + ' | head=' + (document.body.innerText||'').slice(0,30);` }));
console.log("B wrap innerText len:", await call("evaluate", { js: `return (document.querySelector('div.article-body-wrap').innerText||'').length;` }));
console.log("C textContent len:", await call("evaluate", { js: `return (document.querySelector('div.article-body-wrap').textContent||'').length;` }));
await transport.close();
setTimeout(() => process.exit(0), 300);
