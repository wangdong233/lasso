// 同会话批量 MCP 客户端（doc/17 执行器辅助；与 mcp.mjs 互补，不替代）
// 用途：缓存命中（T-SEARCH-12）、capability_disable→tools/list_changed（T-RT-01）、
//       forest 复用（T-FOREST-01）等必须共享同一 server 进程的场景；
//       以及需要向子进程注入 LASSO_* env 的场景（T-SSRF-02，StdioClientTransport
//       默认 env 白名单不透传 LASSO_*，须显式传 process.env）。
// 用法：node mcp-batch.mjs <tool> '<json>' [tool '<json>' ...]
//       node mcp-batch.mjs tools/list
// 输出：每次调用一行 JSON（result 原样）+ 末尾 notifications 汇总行
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const args = process.argv.slice(2);
if (args.length === 0) { console.error("usage: node mcp-batch.mjs <tool> '<json>' [...]"); process.exit(2); }

const client = new Client({ name: "lasso-17-batch", version: "1.0.0" });
const notifications = [];
client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
  notifications.push({ type: "tools/list_changed", at: new Date().toISOString() });
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: repoRoot,
  env: { ...process.env },
});
await client.connect(transport);
const timeoutMs = Number(process.env.MCP_TIMEOUT_MS ?? 180000);
const line = (o) => process.stdout.write(JSON.stringify(o) + "\n");
try {
  if (args[0] === "tools/list") {
    const res = await client.listTools();
    line({ tool: "tools/list", tools: res.tools.map((t) => t.name), count: res.tools.length });
  } else {
    for (let i = 0; i < args.length; i += 2) {
      const tool = args[i];
      if (tool === "tools/list") { i -= 1; // 无参数对，回退一格
        const res = await client.listTools();
        line({ index: i / 2 + 0.5, tool: "tools/list", tools: res.tools.map((t) => t.name), count: res.tools.length });
        continue;
      }
      let params = {};
      if (args[i + 1] && args[i + 1] !== "-") { try { params = JSON.parse(args[i + 1]); } catch { line({ index: i / 2, tool, harness_error: "bad json" }); continue; } }
      const before = notifications.length;
      try {
        const res = await client.callTool({ name: tool, arguments: params }, undefined, { timeout: timeoutMs });
        line({ index: i / 2, tool, params, ok: true, new_notifications: notifications.length - before, result: res });
      } catch (e) {
        line({ index: i / 2, tool, params, ok: false, new_notifications: notifications.length - before, call_error: String(e?.message ?? e) });
      }
    }
  }
} finally {
  await transport.close().catch(() => {});
}
