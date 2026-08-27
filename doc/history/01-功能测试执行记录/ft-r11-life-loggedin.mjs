#!/usr/bin/env node
/**
 * ft-r11-life-loggedin.mjs — T-LIFE-12 tab_restore + T-LIFE-10 活动打点
 * 以 LASSO_CDP_PORT=9230 起 server，跑 logged_in 序列 + admin tab_restore 两态。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const client = new Client({ name: "lasso-ft-r11-life", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", "exec node dist/index.js 2>>doc/17-执行记录/ft-r11-life-stderr.log"],
  cwd: repoRoot,
  env: { ...process.env },
});
await client.connect(transport);
async function call(id, tool, args) {
  await new Promise((r) => setTimeout(r, 2000));
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    const p = JSON.parse(res.content?.[0]?.text ?? "{}");
    console.log(`[${id}] ${Date.now() - t0}ms outcome=${p.outcome} served_by=${p.served_by} err=${p.error ?? "-"} prev=${String(p.data?.preview ?? p.data ?? "").slice(0, 110).replace(/\n/g, " ")}`);
    return p;
  } catch (e) {
    console.log(`[${id}] FAILED ${String(e).slice(0, 200)}`);
    return null;
  }
}
try {
  await call("L3-1-tab-restore-before-connect", "admin", { action: "tab_restore", reason: "ft-r11-before" });
  await call("L3-2-logged-in-nav", "browse_logged_in", { url: "https://example.com", action: "navigate" });
  await call("L3-3-logged-in-nav2", "browse_logged_in", { url: "https://example.org", action: "navigate" });
  await call("L3-4-tab-restore-after", "admin", { action: "tab_restore", reason: "ft-r11-after" });
  await call("L3-5-roots", "interact_roots", {});
} finally {
  await transport.close();
  await new Promise((r) => setTimeout(r, 1500));
}
