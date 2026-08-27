#!/usr/bin/env node
/**
 * ft-r11-e2.mjs — T-LIFE-08 活动期存活臂 + T-LIFE-12 restore 正路径
 * 前置（shell 编排）：launch-chrome --port 9232 --idle-ms 20000 --profile ft-p9232
 * 本脚本 env：LASSO_CDP_PORT=9232 LASSO_LAUNCH_IDLE_MS=20000（touch 命中台账端口）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const LEDGER = path.join(process.env.HOME, ".cache/lasso/launched-chromes.json");
const client = new Client({ name: "lasso-ft-r11-e2", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", "exec node dist/index.js 2>>doc/17-执行记录/ft-r11-e2-stderr.log"],
  cwd: repoRoot, env: { ...process.env },
});
const snap = () => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")).map((e) => e.port).join(","); } catch { return "ERR"; } };
const probe = async () => { try { const r = await fetch("http://127.0.0.1:9232/json/version", { signal: AbortSignal.timeout(2000) }); return r.status; } catch { return "DEAD"; } };
async function call(id, tool, args) {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    const ms = Date.now() - t0;
    const txt = res.content?.[0]?.text ?? "";
    let p; try { p = JSON.parse(txt); } catch { p = { raw: txt.slice(0, 300) }; }
    console.log(`[${id}] ${ms}ms :: ${JSON.stringify(p).slice(0, 220)}`);
    return p;
  } catch (e) { console.log(`[${id}] FAILED ${String(e).slice(0, 200)}`); return null; }
}
await client.connect(transport);
const T0 = Date.now();
try {
  console.log("[E2] probe9232=", await probe(), "ledger=", snap());
  await call("E2-1-nav", "browse_logged_in", { url: "https://example.com", action: "navigate" });
  // 开新 tab（window.open）→ roots 应见 2 个页面 target
  await call("E2-2-open-tab", "browse_logged_in", { url: "https://example.com", action: "evaluate", options: { js: "window.open('https://example.org'); return 1" } });
  await new Promise((r) => setTimeout(r, 1500));
  await call("E2-3-roots", "interact_roots", {});
  await call("E2-4-tab-restore", "admin", { action: "tab_restore", reason: "ft-r11-e2-restore" });
  await call("E2-5-roots-after-restore", "interact_roots", {});

  // 活动期存活臂：每 8s browse 一次，共 3 轮（24s > idleMs 20s，活动应保活）
  for (let i = 1; i <= 3; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    await call(`E2-keepalive-${i}`, "browse_logged_in", { url: "https://example.com", action: "snapshot" });
    console.log(`[E2-watch] +${Math.round((Date.now() - T0) / 1000)}s ledger=${snap()} probe=${await probe()}`);
  }
  // 停止活动 → 等 idle 回收（20s idle + 15s 周期 → ≤40s 窗）
  console.log("[E2] stop touching; waiting for idle reap…");
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`[E2-watch] +${Math.round((Date.now() - T0) / 1000)}s ledger=${snap()} probe=${await probe()}`);
    if (!snap().includes("9232")) { console.log("[E2-RESULT] REAPED_AFTER_IDLE"); break; }
  }
} finally {
  await transport.close();
  await new Promise((r) => setTimeout(r, 1500));
}
