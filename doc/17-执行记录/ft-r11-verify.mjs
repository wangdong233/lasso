#!/usr/bin/env node
/**
 * ft-r11-verify.mjs — W-DEF-R11-1/2 修复后真机复测（原用例 + 相邻）
 *  A: wait 三态（在场快速 / 不在场短超时 unknown+wait_timeout / 不在场默认档）
 *  B: tab_restore 正路径（隔离台账，launch 9235 → navigate 既有 tab → window.open 新 tab → restore 关新 tab）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const LEDGER = "/tmp/ft-r11-verify-ledger.json";
const PORT = 9235;
async function call(client, id, tool, args) {
  const t0 = Date.now();
  const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90000 });
  const ms = Date.now() - t0;
  const p = JSON.parse(res.content?.[0]?.text ?? "{}");
  console.log(`[${id}] ${ms}ms outcome=${p.outcome} served_by=${p.served_by} err=${String(p.error ?? p.reason ?? "-").slice(0, 120)} prev=${String(p.data?.preview ?? p.closed ?? "").slice(0, 60).replace(/\n/g, " ")}`);
  return { ms, p };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- A: wait 三态 ----------
{
  const client = new Client({ name: "lasso-ft-r11-va", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh", args: ["-c", "exec node dist/index.js 2>>doc/17-执行记录/ft-r11-verify-stderr.log"],
    cwd: repoRoot, env: { ...process.env },
  });
  await client.connect(transport);
  try {
    await call(client, "VA-0-nav", "browse_headless", { url: "https://example.com", action: "navigate" });
    await sleep(2000);
    await call(client, "VA-1-wait-present", "browse_headless", { url: "https://example.com", action: "wait", options: { expect: { text: "Example Domain" } } });
    await sleep(2000);
    await call(client, "VA-2-wait-absent-3s", "browse_headless", { url: "https://example.com", action: "wait", options: { expect: { text: "Absolutely Not Present Text 12345", timeout_ms: 3000 } } });
    await sleep(2000);
    await call(client, "VA-3-wait-adjacent-snapshot", "browse_headless", { url: "https://example.com", action: "snapshot" });
  } finally { await transport.close(); await sleep(1500); }
}

// ---------- B: tab_restore 正路径 ----------
try { fs.rmSync(LEDGER, { force: true }); } catch {}
const lr = spawnSync("node", ["dist/index.js", "launch-chrome", "--port", String(PORT), "--mode", "hidden", "--profile", `${process.env.HOME}/.cache/lasso/ft-p9235`, "--idle-ms", "90000"], { cwd: repoRoot, encoding: "utf8", timeout: 30000, env: { ...process.env, LASSO_LAUNCHED_CHROMES_PATH: LEDGER } });
console.log("[VB-launch] exit=", lr.status, lr.stdout.trim().split("\n").slice(-4).join(" ").slice(0, 160));
{
  const client = new Client({ name: "lasso-ft-r11-vb", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh", args: ["-c", "exec node dist/index.js 2>>doc/17-执行记录/ft-r11-verify-stderr.log"],
    cwd: repoRoot, env: { ...process.env, LASSO_CDP_PORT: String(PORT), LASSO_LAUNCH_IDLE_MS: "90000", LASSO_LAUNCHED_CHROMES_PATH: LEDGER },
  });
  await client.connect(transport);
  const probe = async () => { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) }); const j = await r.json(); return j.filter((t) => t.type === "page").map((t) => t.url.slice(0, 40)); } catch { return "DEAD"; } };
  try {
    console.log("[VB] pages before:", await probe());
    await call(client, "VB-1-nav-existing-tab", "browse_logged_in", { url: "https://example.com", action: "navigate" });
    await call(client, "VB-2-open-new-tab", "browse_logged_in", { url: "https://example.com", action: "evaluate", options: { js: "window.open('https://example.org'); return 2" } });
    await sleep(1500);
    console.log("[VB] pages after open:", await probe());
    await call(client, "VB-3-tab-restore", "admin", { action: "tab_restore", reason: "ft-r11-verify" });
    await sleep(1000);
    console.log("[VB] pages after restore:", await probe());
    await call(client, "VB-4-adjacent-nav", "browse_logged_in", { url: "https://example.com", action: "snapshot" });
  } finally { await transport.close(); await sleep(1500); }
}
// 收尾：chrome-stop 隔离台账
const sr = spawnSync("node", ["dist/index.js", "chrome-stop", "--all"], { cwd: repoRoot, encoding: "utf8", timeout: 30000, env: { ...process.env, LASSO_LAUNCHED_CHROMES_PATH: LEDGER } });
console.log("[VB-cleanup] chrome-stop exit=", sr.status, sr.stdout.trim().slice(0, 120));
