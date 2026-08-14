import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-wave2-rt06b", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, "wave2-rt06-stderr.log"))}`],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const parse = (res) => { const t = res?.content?.[0]?.text; try { return JSON.parse(t); } catch { return { raw: String(t).slice(0, 200) }; } };
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 }));
console.log("cap_set anonymous=2:", JSON.stringify(await call("admin", { action: "caller_cap_set", callerId: "anonymous", cap: 2 })).slice(0, 80));
for (let i = 1; i <= 3; i++) {
  const r = await call("fetch_url", { url: "https://example.com" });
  console.log(`fetch_url#${i}:`, JSON.stringify({ outcome: r.outcome, retrieval_method: r.retrieval_method }));
}
const s = await call("search", { query: "cap scope probe", limit: 1 });
console.log("search#1:", JSON.stringify({ outcome: s.outcome, retrieval_method: s.retrieval_method }));
const s2 = await call("search", { query: "cap scope probe 2", limit: 1 });
console.log("search#2:", JSON.stringify({ outcome: s2.outcome, retrieval_method: s2.retrieval_method }));
const l = await call("admin", { action: "caller_cap_list" });
console.log("cap_list:", JSON.stringify(l.callers ?? l.data ?? l).slice(0, 200));
await transport.close().catch(() => {});
process.exit(0);
