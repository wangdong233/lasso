#!/usr/bin/env node
/**
 * ft-round1 资源三采样器（§0.2 第 6 条）——语义与 test/helpers/resource-meter.ts 对齐：
 * 特征根 = cmdline 含 `--user-data-dir=` 且路径含 lasso / `chrome-devtools-mcp`+`--disable-blink-features`
 *          / `dist/index.js`；匹配根 + ppid 后代闭包 = lasso 特征进程树。
 * 用法：node ft-meter.mjs before|peak|after|released <statefile> [peakMs]
 *   before  <statefile>       采样基线并把快照写 statefile（同时后台轮询 peak 到 statefile.peak）
 *   peak    <statefile>       读当前 peak（轮询由 before 内联后台循环承担；after 停止）
 *   after   <statefile>       收尾采样 + 停轮询，输出 after 样本
 *   released <statefile>      输出 released 判定（count ≤ before 且 rss 回基线 +10%+50MB）
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

const POLL_MS = 500;

function sample() {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8" });
  const rows = (ps.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const procs = rows.map((l) => {
    const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s(.*)$/);
    if (!m) return null;
    const [_, pid, ppid, rss, time, cmd] = m;
    const cpuSeconds = time.split(":").reduce((a, p) => a * 60 + Number(p), 0);
    return { pid: +pid, ppid: +ppid, rssKb: +rss, cpuSeconds, cmd };
  }).filter(Boolean);
  const isRoot = (p) =>
    (/--user-data-dir=/.test(p.cmd) && p.cmd.includes("lasso")) ||
    (p.cmd.includes("chrome-devtools-mcp") && p.cmd.includes("--disable-blink-features")) ||
    p.cmd.includes("dist/index.js");
  const roots = procs.filter(isRoot);
  const rootPids = new Set(roots.map((r) => r.pid));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const desc = (pid) => {
    const out = new Set();
    const stack = [pid];
    while (stack.length) {
      const cur = stack.pop();
      if (out.has(cur)) continue;
      out.add(cur);
      for (const p of procs) if (p.ppid === cur && !out.has(p.pid)) stack.push(p.pid);
    }
    return out;
  };
  let count = 0, rssKb = 0, cpuSeconds = 0, matched = [];
  for (const r of roots) {
    for (const pid of desc(r.pid)) {
      const p = byPid.get(pid);
      if (!p) continue;
      count++; rssKb += p.rssKb; cpuSeconds += p.cpuSeconds;
      matched.push(`${p.pid}:${p.cmd.slice(0, 80)}`);
    }
  }
  void rootPids;
  return { at: Date.now(), count, rssKb, cpuSeconds, matched };
}

const [mode, statefile] = process.argv.slice(2);
if (mode === "before") {
  const s = sample();
  fs.writeFileSync(statefile, JSON.stringify(s));
  fs.writeFileSync(statefile + ".peak", JSON.stringify(s));
  const t = setInterval(() => {
    try {
      const cur = sample();
      const pk = JSON.parse(fs.readFileSync(statefile + ".peak", "utf8"));
      if (cur.count > pk.count || cur.rssKb > pk.rssKb) fs.writeFileSync(statefile + ".peak", JSON.stringify(cur));
    } catch {}
  }, POLL_MS);
  t.unref();
  console.log(JSON.stringify({ count: s.count, rssKb: s.rssKb, cpuSeconds: s.cpuSeconds }));
} else if (mode === "peak" || mode === "after") {
  if (mode === "after") {
    const s = sample();
    fs.writeFileSync(statefile + ".after", JSON.stringify(s));
    console.log(JSON.stringify({ count: s.count, rssKb: s.rssKb, cpuSeconds: s.cpuSeconds }));
  } else {
    const pk = JSON.parse(fs.readFileSync(statefile + ".peak", "utf8"));
    console.log(JSON.stringify({ count: pk.count, rssKb: pk.rssKb, cpuSeconds: pk.cpuSeconds }));
  }
} else if (mode === "released") {
  const before = JSON.parse(fs.readFileSync(statefile, "utf8"));
  const after = JSON.parse(fs.readFileSync(statefile + ".after", "utf8"));
  const ok = after.count <= before.count && after.rssKb <= before.rssKb * 1.1 + 50 * 1024;
  console.log(JSON.stringify({ released: ok, beforeCount: before.count, afterCount: after.count, beforeRssKb: before.rssKb, afterRssKb: after.rssKb }));
} else {
  console.error("usage: ft-meter.mjs before|peak|after|released <statefile>");
  process.exit(2);
}
