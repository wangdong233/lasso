import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-wave2-tools2", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, "wave2-tools-stderr.log"))}`],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const parse = (res) => { const t = res?.content?.[0]?.text; try { return JSON.parse(t); } catch { return { raw: String(t).slice(0, 300) }; } };
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }));

const r3 = await call("fetch_url", { url: "https://example.com", extract_mode: "markdown" });
console.log("R3b markdown:", JSON.stringify({ outcome: r3.outcome, body_kind: r3.data?.body_kind, preview_head: String(r3.data?.preview ?? "").slice(0, 60) }));

const r4 = await call("fetch_url", { url: "https://en.wikipedia.org/wiki/China", extract_mode: "markdown" });
console.log("R4b spill:", JSON.stringify({ outcome: r4.outcome, truncated: r4.truncated, ref: r4.ref, total_bytes: r4.total_bytes, continue_hint: String(r4.continue_hint ?? r4.data?.continue_hint ?? "").slice(0, 100), error: r4.error }));
const ref = r4.ref;
if (ref) {
  const spillDir = path.join(os.tmpdir(), "lasso-output");
  const want = path.join(spillDir, `${ref}.txt`);
  if (fs.existsSync(want)) {
    const st = fs.statSync(want);
    console.log("SPILL_FILE:", JSON.stringify({ path: want, size: st.size, mode: st.mode.toString(8) }));
  } else {
    console.log("SPILL_FILE: not found; dir=", fs.existsSync(spillDir) ? fs.readdirSync(spillDir).slice(-5) : "missing");
  }
  const rt1 = await call("read_text", { ref });
  console.log("RT1 full:", JSON.stringify({ outcome: rt1.outcome, retrieval_method: rt1.retrieval_method, keys: rt1.data ? Object.keys(rt1.data) : null, bytes: rt1.data?.bytes ?? rt1.data?.total_bytes, text_head: String(rt1.data?.text ?? rt1.data?.preview ?? rt1.data?.content ?? "").slice(0, 60), error: rt1.error }));
  const rt2 = await call("read_text", { ref, offset: 100000 });
  console.log("RT2 offset=100000:", JSON.stringify({ outcome: rt2.outcome, bytes: rt2.data?.bytes, text_head: String(rt2.data?.text ?? rt2.data?.preview ?? rt2.data?.content ?? "").slice(0, 60), error: rt2.error }));
  const rt3 = await call("read_text", { ref: "@o999" });
  console.log("RT3 bad ref:", JSON.stringify({ outcome: rt3.outcome, retrieval_method: rt3.retrieval_method, error: rt3.error }));
}
await transport.close().catch(() => {});
process.exit(0);
