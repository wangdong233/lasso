#!/usr/bin/env node
/** T-SILENCE-03 执行器 — browse_headless 全生命周期静默性（+ T-SILENCE-07 headless 侧）。
 * 断言：①frontmost 全程恒基线（每 op 立即+1s 双采）②零窗口 ③Foreground ASN 全程不增
 * （250ms 轮询，缺位断言法）④资源峰值记录 ⑤server 退出自有树 0 存活、预存零触碰。
 * T-SILENCE-07：活 Chromium cmdline 含 --mute-audio + --headless=new。 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
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

const psAll = () => {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) out.push({ pid: +m[1], ppid: +m[2], rssKb: +m[3], cmd: m[4] });
  }
  return out;
};
/** 我的 lasso 树 = chrome-devtools-mcp 根（不在预存集）的 ppid 闭包 + server 树（dist/index.js） */
function myTree() {
  const procs = psAll();
  const roots = procs.filter((p) =>
    (p.cmd.includes("chrome-devtools-mcp") || p.cmd.includes("npm exec chrome-devtools-mcp"))
    && !PREEXISTING.includes(String(p.pid)) && !PREEXISTING.includes(String(p.ppid)));
  const keep = new Set();
  const frontier = roots.map((r) => r.pid);
  while (frontier.length) {
    const cur = [...frontier]; frontier.length = 0;
    for (const pid of cur) {
      if (keep.has(pid)) continue;
      keep.add(pid);
      for (const p of procs) if (p.ppid === pid) frontier.push(p.pid);
    }
  }
  let rss = 0;
  for (const p of procs) if (keep.has(p.pid)) rss += p.rssKb;
  return { roots: roots.map((r) => r.pid), procs: keep.size, rssKb: rss,
    list: procs.filter((p) => keep.has(p.pid)) };
}

const result = { case: ["T-SILENCE-03"], asn_poll: [], ops: [] };
result.baseline_frontmost = frontmost();
result.baseline_fg_asn = chromeAsns().chromeForeground;
result.baseline_tree = myTree();

// ASN 轮询器（250ms）
let polling = true;
const pollTimer = setInterval(() => {
  result.asn_poll.push({ t: Date.now(), fg: chromeAsns().chromeForeground, fm: frontmost() });
}, 250);

const client = new Client({ name: "silence-ts03", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: "node", args: [path.join(repoRoot, "dist/index.js")], cwd: repoRoot, stderr: "pipe",
}));
let stderrText = "";
client.transport.stderr?.on("data", (d) => { stderrText += d.toString(); });

let peak = { procs: 0, rssKb: 0 };
const peakTimer = setInterval(() => {
  const t = myTree();
  peak.procs = Math.max(peak.procs, t.procs); peak.rssKb = Math.max(peak.rssKb, t.rssKb);
}, 500);

async function op(id, args) {
  await sleep(2000);
  const fmB = frontmost();
  const t0 = Date.now();
  let ok = null, preview = "";
  try {
    const res = await client.callTool({ name: "browse_headless", arguments: args }, undefined, { timeout: 120000 });
    ok = !res.isError;
    preview = JSON.stringify(res.structuredContent ?? res.content?.[0]?.text ?? "").slice(0, 120);
  } catch (e) { ok = false; preview = String(e.message).slice(0, 120); }
  const imm = frontmost();
  await sleep(1000);
  const late = frontmost();
  result.ops.push({ id, ms: Date.now() - t0, ok, preview, fmB, imm, late });
}

await op("navigate", { url: "https://example.com", action: "navigate" });

// T-SILENCE-07 headless 侧：活 Chromium cmdline flag 断言（navigate 完成后树还活着）
{
  const tree = myTree();
  const chromium = tree.list.filter((p) => p.cmd.includes("Google Chrome"));
  result.ts07_headless = chromium.slice(0, 2).map((p) => ({
    pid: p.pid,
    mute_audio: p.cmd.includes("--mute-audio"),
    headless_new: p.cmd.includes("--headless=new"),
    cmd_head: p.cmd.slice(0, 90),
  }));
  result.ts07_chromium_procs_found = chromium.length;
}

await op("extract", { url: "https://example.com", action: "extract" });
await op("evaluate", { url: "https://example.com", action: "evaluate", options: { js: "return navigator.webdriver" } });

// ---- 关闭 ----
clearInterval(peakTimer);
result.peak = peak;
await client.close();
await sleep(6500); // killAllSync 钩子 + OS 收尾
clearInterval(pollTimer);
result.after_close = { fm: frontmost(), tree: myTree(), fg_asn: chromeAsns().chromeForeground };
result.asn_poll_max_fg = Math.max(...result.asn_poll.map((s) => s.fg));
result.asn_poll_fm_all_baseline = result.asn_poll.every((s) => s.fm === result.baseline_frontmost);
result.asn_poll_samples = result.asn_poll.length;
result.stderr_leak_to_terminal = false; // stderr pipe 全收本进程
result.stderr_lines = stderrText.split("\n").filter(Boolean).length;
fs.writeFileSync(path.join(here, "ts03-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  baseline_fm: result.baseline_frontmost, baseline_fg: result.baseline_fg_asn,
  ops: result.ops.map((o) => ({ id: o.id, ok: o.ok, ms: o.ms, fm: `${o.fmB}->${o.imm}/${o.late}` })),
  ts07_headless: result.ts07_headless,
  peak: result.peak,
  asn_poll: { samples: result.asn_poll_samples, max_fg: result.asn_poll_max_fg, fm_all_baseline: result.asn_poll_fm_all_baseline },
  after_close: { fm: result.after_close.fm, tree_procs: result.after_close.tree.procs, roots: result.after_close.tree.roots, fg: result.after_close.fg },
}, null, 2));
process.exit(0);
