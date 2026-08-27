import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-wave2-search", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, "wave2-search-stderr.log"))}`],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const parse = (res) => { const t = res?.content?.[0]?.text; try { return JSON.parse(t); } catch { return { raw: String(t).slice(0, 300) }; } };
const call = async (name, args) => { try { return await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); } catch (e) { return { call_error: String(e?.message ?? e) }; } };

const q = "wave2 cache probe lasso";
const s = [];
const show = (tag, r) => {
  if (r.call_error) return console.log(tag, "CALL_ERROR:", r.call_error.slice(0, 150));
  const j = parse(r);
  console.log(tag, JSON.stringify({ outcome: j.outcome, served_by: j.served_by, retrieval_method: j.retrieval_method, cached: j.cached, n: Array.isArray(j.results) ? j.results.length : undefined, error: j.error }));
};

// T-SEARCH-11
show("S1 L1:", await call("search", { query: q, limit: 3, free_only: "L1" }));
show("S2 L4:", await call("search", { query: q, limit: 3, free_only: "L4" }));
show("S3 omit:", await call("search", { query: q, limit: 3 }));
// T-SEARCH-12 缓存
show("S4 repeat(=S3):", await call("search", { query: q, limit: 3 }));
show("S5 no_cache:", await call("search", { query: q, limit: 3, no_cache: true }));
show("S6 limit 3->5:", await call("search", { query: q, limit: 5 }));
show("S7 engine zhipu:", await call("search", { query: q, limit: 3, engine: "zhipu" }));
// T-SEARCH-29 zod 边界
show("S8 empty query:", await call("search", { query: "", limit: 3 }));
show("S9 limit 51:", await call("search", { query: q, limit: 51 }));
await transport.close().catch(() => {});
process.exit(0);
