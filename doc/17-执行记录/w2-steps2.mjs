import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "w2-steps2", version: "1" });
const t = new StdioClientTransport({ command: "/bin/zsh", args: ["-c", "exec node dist/index.js 2>>w2-browse-stderr.log"], cwd: "/Users/wangdong/Documents/Project/cc-control-all/lasso", env: { ...process.env } });
await c.connect(t);
const r = await c.callTool({ name: "browse_headless", arguments: { url: "https://example.com", action: "navigate", options: { steps: [
  { action: "snapshot", label: "snap" },
  { action: "wait", expect: { text: "Example Domain" }, label: "wait-title" },
  { action: "evaluate", js: "return document.title", label: "eval-title" },
]}}}, undefined, { timeout: 120000 });
const m = JSON.parse(r.content[0].text); const ch = m.data.chain;
console.log("outcome=", m.outcome, "chain keys:", Object.keys(ch).join(","));
console.log("budget_used_ms=", ch.budget_used_ms, "stopped_at=", JSON.stringify(ch.stopped_at));
for (const row of ch.actions_and_results) { const rr = row.results[0]; console.log(`step=${row.step.action}(${row.step.label||""}) outcome=${rr.outcome} expect_check=${rr.expect_check ?? "-"} dur=${rr.duration_ms} preview=${(rr.preview||"").slice(0,50).replace(/\n/g," ")}`); }
const t0 = Date.now();
const r2 = await c.callTool({ name: "browse_headless", arguments: { url: "https://example.com", action: "navigate", options: { steps: [
  { action: "evaluate", js: "return 1+1" },
  { action: "wait", expect: { text: "THIS TEXT DOES NOT EXIST XYZ", timeout_ms: 3000 }, label: "wait-impossible" },
  { action: "evaluate", js: "return 2+2", label: "never-reach" },
]}}}, undefined, { timeout: 120000 });
const m2 = JSON.parse(r2.content[0].text);
console.log("neg outcome=", m2.outcome, "error=", m2.error ?? "-", `[${Date.now()-t0}ms]`);
console.log("neg stopped_at=", JSON.stringify(m2.data?.chain?.stopped_at), "steps_done=", (m2.data?.chain?.actions_and_results||[]).map(x=>x.step.action).join(">"));
await t.close();
