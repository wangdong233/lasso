// wave2 T-RT-06 重测：caller-tier 配额接线（W1-DEF-10 修复验证）
// 单会话：admin caller_cap_set → 6 次真实 search 调用（_meta.callerId="t"）→ list → cap=0 封禁 → anonymous fallback
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stderrLog = path.join(here, "wave2-rt06-stderr.log");

const client = new Client({ name: "lasso-wave2-rt06", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  env: { ...process.env },
});
await client.connect(transport);

const brief = (res) => {
  if (!res?.content?.[0]?.text) return { raw: res };
  try {
    const j = JSON.parse(res.content[0].text);
    return {
      outcome: j.outcome,
      served_by: j.served_by,
      retrieval_method: j.retrieval_method,
      error: j.error,
      n_results: Array.isArray(j.results) ? j.results.length : undefined,
      ok: j.ok,
      callers: j.callers ?? j.caller_caps ?? j.data ?? undefined,
    };
  } catch { return { text: res.content[0].text.slice(0, 300) }; }
};
const call = async (name, args, meta) => {
  const req = { name, arguments: args };
  if (meta) req._meta = meta;
  const res = await client.callTool(req, undefined, { timeout: 180000 });
  return brief(res);
};

const out = [];
// 场景1：cap=5 + _meta.callerId="t" + 6 次 search
out.push({ step: "cap_set t=5", r: await call("admin", { action: "caller_cap_set", callerId: "t", cap: 5 }) });
for (let i = 1; i <= 6; i++) {
  out.push({ step: `search#${i} (caller=t)`, r: await call("search", { query: `caller cap wiring test ${i}`, limit: 1, engine: "fallback_chain" }, { callerId: "t" }) });
}
out.push({ step: "cap_list after 6", r: await call("admin", { action: "caller_cap_list" }) });
// 场景2：cap=0 封禁
out.push({ step: "cap_set t=0", r: await call("admin", { action: "caller_cap_set", callerId: "t", cap: 0 }) });
out.push({ step: "search after ban (caller=t)", r: await call("search", { query: "after ban", limit: 1 }, { callerId: "t" }) });
// 场景3：anonymous fallback（不带 _meta；单独 caller 不受 t 影响）
out.push({ step: "search anonymous (no _meta)", r: await call("search", { query: "anonymous caller", limit: 1 }) });
out.push({ step: "cap_list final", r: await call("admin", { action: "caller_cap_list" }) });

console.log(JSON.stringify(out, null, 1));
await transport.close().catch(() => {});
process.exit(0);
