import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "w2-time", version: "1.0.0" });
const t = new StdioClientTransport({ command: "/bin/zsh", args: ["-c", "exec node dist/index.js 2>>/tmp/w2-time-stderr.log"], cwd: "/Users/wangdong/Documents/Project/cc-control-all/lasso", env: { ...process.env, LASSO_RUST_HELPER_PATH: "/nonexistent" } });
await c.connect(t);
const t0 = Date.now();
try { const r = await c.callTool({ name: "desktop", arguments: { action: "snapshot", options: { app: "Finder", max_depth: 2 } } }, undefined, { timeout: 15000 });
  console.log("isError=", r.isError, "text=", r.content?.[0]?.text?.slice(0,120));
} catch (e) { console.log("THREW:", String(e).slice(0,120)); }
console.log("callTool_ms=", Date.now() - t0);
await t.close();
