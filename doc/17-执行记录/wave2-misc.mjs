import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-wave2-misc", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, "wave2-misc-stderr.log"))}`],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const parse = (res) => { const t = res?.content?.[0]?.text; try { return JSON.parse(t); } catch { return { raw: String(t).slice(0, 250) }; } };
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }));

// --- T-RT-05 三只读 action ---
for (const a of ["metrics_snapshot", "breaker_status", "serp_health"]) {
  const r = await call("admin", { action: a });
  console.log("RT05", a, JSON.stringify({ ok: r.ok, has_data: !!r.data, breaker_kinds: a === "breaker_status" ? (r.data?.breakers ?? r.data ?? []).map?.(b => b.kind) ?? Object.keys(r.data ?? {}) : undefined }));
}
// --- 造 @p0：browse navigate ---
const nav = await call("browse_headless", { url: "https://example.com", action: "navigate" });
console.log("NAV:", JSON.stringify({ outcome: nav.outcome, state_id: nav.data?.state_id?.slice(0, 8) }));
// --- 造 @w0：desktop roots（ax_snapshot 走 desktop channel mint root）---
const roots1 = await call("interact_roots", {});
console.log("ROOTS(before desktop):", JSON.stringify(roots1.data ?? roots1.roots ?? roots1).slice(0, 200));
// --- T-FOREST-02 前缀路由 ---
const p0 = await call("interact_observe", { root_ref: "@p0" });
console.log("F02 @p0 observe:", JSON.stringify({ outcome: p0.outcome, served_by: p0.served_by, error: p0.error }));
const w0 = await call("interact_observe", { root_ref: "@w0" });
console.log("F02 @w0 observe:", JSON.stringify({ outcome: w0.outcome, served_by: w0.served_by, error: w0.error }));
const p99 = await call("interact_act", { root_ref: "@p99" });
console.log("F02 @p99 act:", JSON.stringify({ outcome: p99.outcome, served_by: p99.served_by, error: p99.error }));
const roots2 = await call("interact_roots", {});
console.log("ROOTS(after):", JSON.stringify(roots2.data ?? roots2.roots ?? roots2).slice(0, 250));
try {
  await client.callTool({ name: "interact_observe", arguments: { root_ref: "@x0" } }, undefined, { timeout: 30000 });
  console.log("F02 @x0: NO ERROR (unexpected)");
} catch (e) { console.log("F02 @x0 zod:", String(e.message).slice(0, 140)); }
// --- T-TOOLS-14 doctor MCP runtime_state ---
const doc = await call("doctor", {});
const rs = doc.runtime_state ?? doc.data?.runtime_state;
console.log("T14 checks:", doc.checks?.length, "runtime_state keys:", rs ? Object.keys(rs) : "MISSING");
console.log("T14 caller_caps:", JSON.stringify(rs?.caller_caps).slice(0, 120), "| breakers n:", (rs?.breakers ?? []).length, "| profiles keys:", JSON.stringify((rs?.profiles ?? [])[0] ? Object.keys(rs.profiles[0]) : []));
// --- U-01-4 机器 MCP 搜索 ---
const s = await call("search", { query: "lasso mcp 是什么", limit: 5, engine: "fallback_chain" });
console.log("U01-4:", JSON.stringify({ outcome: s.outcome, served_by: s.served_by, n: Array.isArray(s.results) ? s.results.length : undefined, actions: (s.actions_and_results ?? []).map(a => a.channel).slice(0, 5), error: s.error }));
await transport.close().catch(() => {});
process.exit(0);
