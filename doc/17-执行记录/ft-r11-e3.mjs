#!/usr/bin/env node
/**
 * ft-r11-e3.mjs — E2 重跑（紧凑窗口）：launch 9233 → 立即 server → tab 舞步 + 活动保活 + idle 回收观察
 * 用法：node ft-r11-e3.mjs（内部自己 launch chrome，窗口最小化减少兄弟面板干扰面）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const LEDGER = process.env.LASSO_LAUNCHED_CHROMES_PATH ?? path.join(process.env.HOME, ".cache/lasso/launched-chromes.json");
const PORT = 9233;
const snap = () => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")).map((e) => `${e.port}:${e.idleMs}ms`).join(","); } catch { return "ERR"; } };
const probe = async () => { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) }); return r.status; } catch { return "DEAD"; } };
const log = (s) => console.log(`[+${Math.round((Date.now() - T0) / 1000)}s] ${s}`);

// 1. launch chrome（同步 CLI）
const T0 = Date.now();
const lr = spawnSync("node", ["dist/index.js", "launch-chrome", "--port", String(PORT), "--mode", "hidden", "--profile", `${process.env.HOME}/.cache/lasso/ft-p9233`, "--idle-ms", "20000"], { cwd: repoRoot, encoding: "utf8", timeout: 30000, env: { ...process.env, LASSO_LAUNCHED_CHROMES_PATH: process.env.LASSO_LAUNCHED_CHROMES_PATH ?? "/tmp/ft-r11-ledger.json" } });
console.log("[launch]", lr.stdout.trim().split("\n").slice(-5).join(" ").slice(0, 220), "exit=", lr.status);
log(`probe=${await probe()} ledger=${snap()}`);

// 2. server（env 指向 9233）
const client = new Client({ name: "lasso-ft-r11-e3", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", "exec node dist/index.js 2>>doc/17-执行记录/ft-r11-e3-stderr.log"],
  cwd: repoRoot, env: { ...process.env, LASSO_CDP_PORT: String(PORT), LASSO_LAUNCH_IDLE_MS: "20000", LASSO_LAUNCHED_CHROMES_PATH: process.env.LASSO_LAUNCHED_CHROMES_PATH ?? "/tmp/ft-r11-ledger.json" },
});
await client.connect(transport);
async function call(id, tool, args) {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    const txt = res.content?.[0]?.text ?? "";
    let p; try { p = JSON.parse(txt); } catch { p = { raw: txt.slice(0, 200) }; }
    console.log(`[${id}] ${Date.now() - t0}ms :: ${JSON.stringify(p).slice(0, 260)}`);
    return p;
  } catch (e) { console.log(`[${id}] FAILED ${String(e).slice(0, 160)}`); return null; }
}
try {
  const n1 = await call("E3-1-nav", "browse_logged_in", { url: "https://example.com", action: "navigate" });
  log(`after-nav probe=${await probe()} ledger=${snap()}`);
  await call("E3-2-open-tab", "browse_logged_in", { url: "https://example.com", action: "evaluate", options: { js: "window.open('https://example.org'); return 2" } });
  await new Promise((r) => setTimeout(r, 1200));
  await call("E3-3-roots", "interact_roots", {});
  await call("E3-4-tab-restore", "admin", { action: "tab_restore", reason: "ft-r11-e3" });
  await call("E3-5-roots-after", "interact_roots", {});
  if (n1?.outcome !== "worked") { console.log("[E3] nav failed — abort watch"); }
  else {
    // 活动保活 3 轮（每 8s，> 20s idle 阈值）
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 8000));
      await call(`E3-keep-${i}`, "browse_logged_in", { url: "https://example.com", action: "snapshot" });
      log(`keep${i} probe=${await probe()} ledger=${snap()}`);
      if ((await probe()) === "DEAD") { console.log("[E3] DIED during activity — FAIL(keepalive)"); break; }
    }
    // 静置等回收
    console.log("[E3] idle watching…");
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      log(`probe=${await probe()} ledger=${snap()}`);
      if (!snap().includes(String(PORT))) { console.log("[E3-RESULT] REAPED_AFTER_IDLE ✓"); break; }
    }
  }
} finally {
  await transport.close();
  await new Promise((r) => setTimeout(r, 1200));
}
