#!/usr/bin/env node
/** T-SILENCE-01/02 执行器 — search / fetch_url / fetch_feed / search_local 纯查询零打扰。
 * 纪律（doc/17 §2.17）：单 server 串行 4 op + 2s 间隔；每 op 前后 frontmost 双采（立即+1s）
 * + Foreground ASN 计数 + lasso Chromium 树 + 用户 Chrome 窗口数；server 关闭后残留复核。 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const { frontmost, chromeAsns, sleep } = await import(
  path.join(repoRoot, "doc/27-静默性全面审计/verify-data/probe.mjs")
);

const PREEXISTING = String(process.env.PREEXISTING_PIDS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const lassoTree = () => {
  const out = spawnSync("pgrep", ["-if", "user-data-dir=.*lasso"], { encoding: "utf8" }).stdout.trim();
  const pids = out ? out.split("\n").filter(/^\d+$/.test.bind(/^\d+$/)) : [];
  return { count: pids.length, pids };
};
const userChromeWindows = () => {
  const pid = process.env.USER_CHROME_PID;
  if (!pid) return null;
  return spawnSync("osascript", ["-e",
    `tell application "System Events" to count windows of (first application process whose unix id is ${pid})`],
    { encoding: "utf8" }).stdout.trim();
};

async function sample(label) {
  return {
    t: new Date().toISOString(), label,
    frontmost: frontmost(),
    fgChromeAsn: chromeAsns().chromeForeground,
    lassoTree: lassoTree().count,
    userChromeWindows: userChromeWindows(),
  };
}

const result = { case: ["T-SILENCE-01", "T-SILENCE-02"], ops: [] };
result.baseline = await sample("baseline");

// ---- server（StdioClientTransport 托管子进程；stderr 收集在内存） ----
const client = new Client({ name: "silence-ts0102", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: "node", args: [path.join(repoRoot, "dist/index.js")], cwd: repoRoot,
  stderr: "pipe",
}));
let stderrText = "";
client.transport.stderr?.on("data", (d) => { stderrText += d.toString(); });

async function runOp(id, tool, args) {
  await sleep(2000); // §0.2 串行 2s 间隔
  const before = await sample(`${id}:before`);
  const t0 = Date.now();
  let ok = null, preview = "";
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    ms = Date.now() - t0;
    ok = !res.isError;
    preview = JSON.stringify(res.structuredContent ?? res.content?.[0]?.text ?? "").slice(0, 160);
  } catch (e) {
    ms = Date.now() - t0;
    ok = false; preview = String(e.message).slice(0, 160);
  }
  const immediate = await sample(`${id}:after-imm`);
  await sleep(1000);
  const late = await sample(`${id}:after-1s`);
  result.ops.push({ id, tool, ms, ok, preview, before, immediate, late });
  return ok;
}
let ms = 0;

await runOp("T-SILENCE-01", "search", { query: "lasso mcp silence test", limit: 10 });
await runOp("T-SILENCE-02a", "fetch_url", { url: "https://example.com" });
await runOp("T-SILENCE-02b", "fetch_feed", { url: "https://github.com/anthropics/claude-code/releases.atom" });
await runOp("T-SILENCE-02c", "search_local", { query: "lasso", source: "files", limit: 5 });

// ---- 关闭 + 残留 ----
await client.close();
await sleep(1500);
result.after_close = await sample("after_close");
result.residual_lasso_tree = lassoTree();
result.residual_new_pids = (() => {
  const out = spawnSync("pgrep", ["-if", "chrome-devtools-mcp"], { encoding: "utf8" }).stdout.trim();
  const now = out ? out.split("\n").filter(/^\d+$/.test.bind(/^\d+$/)) : [];
  return now.filter((p) => !PREEXISTING.includes(p));
})();
result.stderr_has_notification_or_osascript = /display notification|afplay|osascript/.test(stderrText);
result.stderr_lines = stderrText.split("\n").filter(Boolean).length;
fs.writeFileSync(path.join(here, "ts01-02-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  ops: result.ops.map((o) => ({ id: o.id, ok: o.ok, ms: o.ms,
    fm: `${o.before.frontmost}->${o.immediate.frontmost}/${o.late.frontmost}`,
    asn: `${o.before.fgChromeAsn}->${o.late.fgChromeAsn}`, tree: o.before.lassoTree })),
  after_close_fm: result.after_close.frontmost,
  residual_new_pids: result.residual_new_pids,
}, null, 2));
process.exit(0);
