import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-wave2-readtext", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, "wave2-tools-stderr.log"))}`],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const parse = (res) => { const t = res?.content?.[0]?.text; try { return JSON.parse(t); } catch { return { raw: String(t).slice(0, 300) }; } };
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }));

const r4 = await call("fetch_url", { url: "https://en.wikipedia.org/wiki/China", options: { extract_mode: "markdown" } });
const ref = r4.data?.envelope?.ref;
console.log("SPILL ref:", ref, "total_bytes:", r4.data?.envelope?.total_bytes);

const p1 = await call("read_text", { ref });
console.log("PAGE1:", JSON.stringify({ text_head: String(p1.text ?? "").slice(0, 60), text_len: (p1.text ?? "").length, eof: p1.eof, total_bytes: p1.total_bytes, error: p1.error }));
const p2 = await call("read_text", { ref, offset: 100000 });
console.log("PAGE2(offset=100000):", JSON.stringify({ text_head: String(p2.text ?? "").slice(0, 60), text_len: (p2.text ?? "").length, eof: p2.eof, total_bytes: p2.total_bytes, error: p2.error }));
// 与 spill 文件 100000 偏移处对齐验证
const p3 = await call("read_text", { ref, offset: 130000 });
console.log("PAGE3(offset=130000,近EOF):", JSON.stringify({ text_len: (p3.text ?? "").length, eof: p3.eof, error: p3.error }));
const p4 = await call("read_text", { ref, offset: 200000 });
console.log("PAGE4(offset=200000,超EOF):", JSON.stringify({ text_len: (p4.text ?? "").length, eof: p4.eof, error: p4.error }));
const p5 = await call("read_text", { ref: "@o999" });
console.log("BAD_REF:", JSON.stringify(p5));
await transport.close().catch(() => {});
process.exit(0);
