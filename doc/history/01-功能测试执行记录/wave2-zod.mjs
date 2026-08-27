import * as path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], cwd: path.resolve(here, "..", ".."), env: { ...process.env } });
const c = new Client({ name: "w2zod", version: "1" });
await c.connect(t);
for (const args of [{ query: "", limit: 3 }, { query: "x", limit: 51 }]) {
  try {
    const r = await c.callTool({ name: "search", arguments: args }, undefined, { timeout: 60000 });
    console.log(args.limit, "isError:", r.isError, "|", String(r.content?.[0]?.text ?? "").slice(0, 220).replace(/\n/g, " "));
  } catch (e) { console.log(args.limit, "PROTO_ERR:", String(e.message).slice(0, 220)); }
}
await t.close().catch(() => {}); process.exit(0);
