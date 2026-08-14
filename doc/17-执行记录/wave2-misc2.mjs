import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-wave2-misc2", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, "wave2-misc-stderr.log"))}`],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const raw = async (name, args) => {
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    return { isError: r.isError, text: String(r.content?.[0]?.text ?? "").slice(0, 500) };
  } catch (e) { return { thrown: String(e.message).slice(0, 300) }; }
};

// NAV 重试（先前 ERR_CONNECTION_CLOSED 瞬态）
console.log("NAV retry:", JSON.stringify(await raw("browse_headless", { url: "https://example.com", action: "navigate" })).slice(0, 400));
console.log("ROOTS:", JSON.stringify(await raw("interact_roots", {})).slice(0, 400));
// @p0 observe 原样
console.log("OBSERVE @p0:", JSON.stringify(await raw("interact_observe", { root_ref: "@p0", action: "snapshot" })).slice(0, 500));
// @x0 原样
console.log("OBSERVE @x0:", JSON.stringify(await raw("interact_observe", { root_ref: "@x0", action: "snapshot" })));
// RT05 原样
console.log("METRICS:", JSON.stringify(await raw("admin", { action: "metrics_snapshot" })).slice(0, 300));
console.log("BREAKER:", JSON.stringify(await raw("admin", { action: "breaker_status" })).slice(0, 400));
console.log("SERP:", JSON.stringify(await raw("admin", { action: "serp_health" })).slice(0, 300));
await transport.close().catch(() => {});
process.exit(0);
