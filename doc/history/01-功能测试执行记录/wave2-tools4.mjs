import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-wave2-tools4", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, "wave2-tools-stderr.log"))}`],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const parse = (res) => { const t = res?.content?.[0]?.text; try { return JSON.parse(t); } catch { return { raw: String(t).slice(0, 300) }; } };
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }));

const r3 = await call("fetch_url", { url: "https://example.com", options: { extract_mode: "markdown" } });
console.log("R3c markdown:", JSON.stringify({ outcome: r3.outcome, body_kind: r3.data?.body_kind, preview_head: String(r3.data?.envelope?.preview ?? "").slice(0, 80) }));

const r4 = await call("fetch_url", { url: "https://en.wikipedia.org/wiki/China", options: { extract_mode: "markdown" } });
const env4 = r4.data?.envelope ?? {};
console.log("R4c spill:", JSON.stringify({ outcome: r4.outcome, body_kind: r4.data?.body_kind, body_bytes: r4.data?.body_bytes, env_keys: Object.keys(env4), truncated: env4.truncated, ref: env4.ref, total_bytes: env4.total_bytes, spill_path: env4.spill_path, hint: String(env4.continue_hint ?? env4.hint ?? "").slice(0, 100) }));
const ref = env4.ref;
if (ref) {
  const want = path.join(os.tmpdir(), "lasso-output", `${ref}.txt`);
  console.log("SPILL_FILE:", fs.existsSync(want) ? JSON.stringify({ path: want, size: fs.statSync(want).size, mode: fs.statSync(want).mode.toString(8) }) : "NOT FOUND");
  const rt1 = await call("read_text", { ref });
  console.log("RT1 full:", JSON.stringify({ outcome: rt1.outcome, served_by: rt1.served_by, retrieval_method: rt1.retrieval_method, data_keys: rt1.data ? Object.keys(rt1.data) : null, bytes: rt1.data?.bytes, text_head: String(rt1.data?.text ?? rt1.data?.content ?? "").slice(0, 60), error: rt1.error }));
  const rt2 = await call("read_text", { ref, offset: 100000 });
  console.log("RT2 offset=100000:", JSON.stringify({ outcome: rt2.outcome, bytes: rt2.data?.bytes, text_head: String(rt2.data?.text ?? rt1.data?.content ?? "").slice(0, 60), error: rt2.error }));
  const rt3 = await call("read_text", { ref: "@o999" });
  console.log("RT3 bad ref:", JSON.stringify({ outcome: rt3.outcome, retrieval_method: rt3.retrieval_method, error: rt3.error }));
  const rt4 = await call("read_text", { ref });
  console.log("RT4 repeat full (beyond EOF):", JSON.stringify({ outcome: rt4.outcome, error: rt4.error }));
} else {
  console.log("NO_REF — spill 未触发，envelope:", JSON.stringify(env4).slice(0, 300));
}
await transport.close().catch(() => {});
process.exit(0);
