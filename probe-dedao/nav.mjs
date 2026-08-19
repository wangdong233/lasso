import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const repoRoot = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const client = new Client({ name: "dedao-probe", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", "exec node dist/index.js 2>>/tmp/dedao-probe-stderr.log"],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const t0 = Date.now();
try {
  const res = await client.callTool({ name: "browse_logged_in", arguments: {
    url: "https://www.dedao.cn/course/article?id=6EBOqDNZ27YlVdg8oKm4bQ1odMAkgz",
    action: "navigate",
    options: { wait_until: "load", timeout_ms: 45000 },
  }}, undefined, { timeout: 60000 });
  console.log("ELAPSED", Date.now()-t0);
  console.log(JSON.stringify(res).slice(0, 2500));
} catch (e) {
  console.log("CALL_FAILED:", String(e).slice(0, 800));
} finally {
  await transport.close();
  await new Promise(r => setTimeout(r, 300));
}
