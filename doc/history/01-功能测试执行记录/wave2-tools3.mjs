import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-wave2-tools3", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, "wave2-tools-stderr.log"))}`],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const parse = (res) => { const t = res?.content?.[0]?.text; try { return JSON.parse(t); } catch { return { raw: String(t).slice(0, 300) }; } };
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }));
const r3 = await call("fetch_url", { url: "https://example.com", extract_mode: "markdown" });
console.log("FULL R3:", JSON.stringify(r3).slice(0, 1200));
const r4 = await call("fetch_url", { url: "https://en.wikipedia.org/wiki/China", extract_mode: "markdown" });
console.log("FULL R4 keys:", Object.keys(r4), "data keys:", r4.data && Object.keys(r4.data));
console.log("FULL R4:", JSON.stringify(r4).slice(0, 600));
await transport.close().catch(() => {});
process.exit(0);
