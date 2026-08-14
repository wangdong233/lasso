import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-wave2-misc3", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, "wave2-misc-stderr.log"))}`],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const parse = (res) => { const t = res?.content?.[0]?.text; try { return JSON.parse(t); } catch { return { raw: String(t).slice(0, 250) }; } };
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }));

// U-01-4 审计链细节
const s = await call("search", { query: "lasso mcp 是什么", limit: 5, engine: "fallback_chain" });
console.log("U01-4 served_by:", s.served_by, "| outcome:", s.outcome);
for (const a of s.actions_and_results ?? []) console.log("  chain:", JSON.stringify(a).slice(0, 160));
// @w 路由
const roots = await call("interact_roots", {});
const w = (roots.roots ?? []).find((r) => r.kind === "window");
console.log("window root:", JSON.stringify(w));
if (w) {
  const o = await call("interact_observe", { root_ref: w.rootRef, action: "snapshot" });
  console.log("OBSERVE", w.rootRef, ":", JSON.stringify({ outcome: o.outcome, served_by: o.served_by, error: o.error, preview_head: String(o.data?.preview ?? "").slice(0, 50) }));
}
// breaker short+long
const b = await call("admin", { action: "breaker_status" });
const kinds = {};
for (const x of b.breakers ?? []) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
console.log("BREAKER kinds:", JSON.stringify(kinds), "n:", (b.breakers ?? []).length);
await transport.close().catch(() => {});
process.exit(0);
