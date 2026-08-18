#!/usr/bin/env node
/**
 * ft-r11-life-reaper-watch.mjs — T-LIFE-08 idle reaper 观察窗
 * 起 server（env LASSO_LAUNCH_IDLE_MS 决定 reaper 档），先 touch 活动，
 * 然后静置观察台账 9231 是否被收（15s 周期轮询 + idleMs 阈值）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const LEDGER = path.join(process.env.HOME, ".cache/lasso/launched-chromes.json");
const idleMs = Number(process.env.LASSO_LAUNCH_IDLE_MS ?? 60000);

if (idleMs === 0) {
  // T-LIFE-09：禁用档——只起 server 6s 抓日志后退出
  const c0 = new Client({ name: "lasso-ft-r11-l9", version: "1.0.0" });
  const t0 = new StdioClientTransport({
    command: "/bin/zsh",
    args: ["-c", "exec node dist/index.js 2>>doc/17-执行记录/ft-r11-life-stderr.log"],
    cwd: repoRoot, env: { ...process.env },
  });
  await c0.connect(t0);
  await new Promise((r) => setTimeout(r, 4000));
  await t0.close();
  process.exit(0);
}

const client = new Client({ name: "lasso-ft-r11-l8", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", "exec node dist/index.js 2>>doc/17-执行记录/ft-r11-life-stderr.log"],
  cwd: repoRoot, env: { ...process.env },
});
await client.connect(transport);
const snap = () => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")).map((e) => e.port).join(","); } catch { return "ERR"; } };
const probe = async (port) => {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }); return r.status; } catch { return "DEAD"; }
};
try {
  // 活动期：browse_logged_in touch（T-LIFE-10 打点在 stderr）
  await new Promise((r) => setTimeout(r, 2000));
  const t1 = Date.now();
  await client.callTool({ name: "browse_logged_in", arguments: { url: "https://example.com", action: "navigate" } }, undefined, { timeout: 60000 });
  console.log(`[L5-1] activity browse done ${Date.now() - t1}ms; ledger=[${snap()}]; probe9231=${await probe(9231)}`);
  // 静置观察：每 3s 采一次，最长 idleMs + 45s
  const deadline = Date.now() + idleMs + 45000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const ports = snap();
    const st = await probe(9231);
    console.log(`[L5-watch] +${Math.round((Date.now() - t1) / 1000)}s ledger=[${ports}] probe9231=${st}`);
    if (!ports.includes("9231")) { console.log("[L5-RESULT] REAPED"); break; }
    if (st === "DEAD") { console.log("[L5-RESULT] PROCESS_DEAD (ledger pending)"); break; }
  }
} finally {
  await transport.close();
  await new Promise((r) => setTimeout(r, 1500));
}
