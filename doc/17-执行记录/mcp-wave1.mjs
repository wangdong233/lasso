#!/usr/bin/env node
// wave1 面板私有 MCP 客户端（稳定版，多调用同会话支持）
// 用法: node mcp-wave1.mjs <tool> '<json>' [tool '<json>' ...] | tools-list
// env: MCP_TIMEOUT_MS (默认 240000)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length === 0) { console.error("usage: mcp-wave1.mjs tools-list | <tool> '<json>' [...]"); process.exit(2); }

const client = new Client({ name: "lasso-wave1-harness", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: ROOT,
  env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")),
});
const t0 = Date.now();
await client.connect(transport);
const timeoutMs = Number(process.env.MCP_TIMEOUT_MS ?? 240000);
function line(o) { process.stdout.write(JSON.stringify({ ...o, at_ms: Date.now() - t0 }) + "\n"); }

try {
  if (args[0] === "tools-list") {
    const res = await client.listTools();
    line({ tool: "tools/list", ok: true, count: res.tools.length, names: res.tools.map(t => t.name) });
  } else {
    for (let i = 0; i < args.length; i += 2) {
      const tool = args[i];
      const raw = args[i + 1] ?? "{}";
      let params;
      try { params = raw === "-" ? {} : JSON.parse(raw); }
      catch (e) { line({ index: i / 2, tool, ok: false, harness_error: "bad json: " + e.message }); continue; }
      try {
        const res = await client.callTool({ name: tool, arguments: params }, undefined, { timeout: timeoutMs });
        line({ index: i / 2, tool, params, ok: true, result: res });
      } catch (e) {
        line({ index: i / 2, tool, params, ok: false, call_error: String(e && e.message ? e.message : e) });
      }
    }
  }
} finally {
  await transport.close().catch(() => {});
}
