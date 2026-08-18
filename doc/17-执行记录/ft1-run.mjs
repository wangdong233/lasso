#!/usr/bin/env node
/**
 * ft-round1 搜索域执行器（doc/17 §0.2 / §5 配套）。
 *
 * 用法：node ft1-run.mjs <scenario.json> <out.jsonl>
 *   scenario.json = { env: {K:V,...}, gapMs: 2000,
 *                     calls: [{ label, tool, args, sleepMs? }] }
 *   每个 call 输出一行 {label, tool, args, ms, ok, isError, text, parsed} 到 out.jsonl
 *   text 截 4000 字符存证；parsed 为完整 JSON（仅成功解析时）。
 * 纪律：串行 + 场景内 call 间默认 2s 间隔（§0.2，不与用户浏览器争资源）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as cp from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const scenario = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const outFile = path.resolve(process.argv[3]);
const gapMs = scenario.gapMs ?? 2000;
const stderrLog = outFile.replace(/\.jsonl$/, "-stderr.log");

// --- 资源三采样（§0.2 第 6 条；与 test/helpers/resource-meter.ts 同特征口径） ---
function sampleLassoTree() {
  const out = cp.spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
  const procs = [];
  for (const lineRaw of out.stdout.split("\n")) {
    const m = lineRaw.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] });
  }
  const roots = procs.filter((p) =>
    (/--user-data-dir=/.test(p.cmd) && /lasso/.test(p.cmd)) ||
    (/chrome-devtools-mcp/.test(p.cmd) && /--disable-blink-features/.test(p.cmd)) ||
    (/dist\/index\.js/.test(p.cmd)),
  );
  const byPpid = new Map();
  for (const p of procs) {
    if (!byPpid.has(p.ppid)) byPpid.set(p.ppid, []);
    byPpid.get(p.ppid).push(p);
  }
  const seen = new Set();
  const tree = [];
  const walk = (p) => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    tree.push(p);
    for (const c of byPpid.get(p.pid) ?? []) walk(c);
  };
  for (const r of roots) walk(r);
  return { count: tree.length, rssKb: tree.reduce((a, p) => a + p.rss, 0) };
}

const res = { before: null, peak: null, after: null, pollTimer: null };
if (scenario.resourceMeter) {
  res.before = sampleLassoTree();
  res.peak = { ...res.before };
  res.pollTimer = setInterval(() => {
    const s = sampleLassoTree();
    if (s.count > res.peak.count || s.rssKb > res.peak.rssKb) res.peak = s;
  }, 500);
  res.pollTimer.unref?.();
}

const client = new Client({ name: "lasso-ft1", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: repoRoot,
  env: { ...process.env, ...(scenario.env ?? {}) },
  stderr: "pipe",
});
const out = fs.createWriteStream(outFile);
const errOut = fs.createWriteStream(stderrLog, { flags: "w" });
const line = (o) => out.write(JSON.stringify(o) + "\n");
const t0All = Date.now();

try {
  await client.connect(transport);
  transport.stderr?.pipe(errOut);
  line({ label: "$connect", ms: Date.now() - t0All, at: new Date().toISOString(), env: scenario.env ?? {} });
  for (const c of scenario.calls) {
    if (c.sleepMs) await new Promise((r) => setTimeout(r, c.sleepMs));
    else if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    const t0 = Date.now();
    let rec = { label: c.label, tool: c.tool, args: c.args ?? {} };
    try {
      const r = await client.callTool({ name: c.tool, arguments: c.args ?? {} }, undefined, {
        timeout: c.timeoutMs ?? 120000,
      });
      rec.ms = Date.now() - t0;
      rec.ok = true;
      rec.isError = !!r.isError;
      const text = (r.content ?? []).map((b) => b.text ?? "").join("\n");
      rec.text = text.slice(0, 4000);
      try { rec.parsed = JSON.parse(text); } catch { /* 非 JSON 文本 */ }
    } catch (e) {
      rec.ms = Date.now() - t0;
      rec.ok = false;
      rec.call_error = String(e?.message ?? e).slice(0, 2000);
    }
    line(rec);
  }
} finally {
  if (res.pollTimer) clearInterval(res.pollTimer);
  try {
    if (scenario.resourceMeter) res.after = sampleLassoTree();
  } catch {}
  await transport.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  line({ label: "$done", totalMs: Date.now() - t0All, resource: scenario.resourceMeter ? res : undefined });
  out.end();
  errOut.end();
  process.exit(0);
}
