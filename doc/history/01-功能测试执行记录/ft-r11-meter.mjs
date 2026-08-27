#!/usr/bin/env node
/**
 * ft-r11-meter.mjs — R11 浏览域资源三采样器（doc/17 §0.2 第 6 条）
 *
 * 复刻 test/helpers/resource-meter.ts 的三条特征 + ppid 后代闭包（macOS 无 /proc，
 * ps -axo 单次快照 + 进程内过滤）。CLI 形态供 shell 编排：
 *   node ft-r11-meter.mjs          # 单次采样，输出 JSON {at,count,rssKb,cpuSeconds}
 */
import { spawnSync } from "node:child_process";

function matchRoot(cmd) {
  if (cmd.includes("--user-data-dir=") && cmd.includes("lasso")) return "user-data-dir-lasso";
  if (cmd.includes("chrome-devtools-mcp") && cmd.includes("--disable-blink-features")) return "chrome-devtools-mcp-headless";
  if (cmd.includes("dist/index.js")) return "lasso-server";
  return null;
}

function sample() {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const procs = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), cpu: m[4], cmd: m[5] });
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const roots = procs.filter((p) => matchRoot(p.cmd));
  const keep = new Set();
  for (const root of roots) {
    let frontier = [root.pid];
    while (frontier.length) {
      const cur = frontier;
      frontier = [];
      for (const pid of cur) {
        if (keep.has(pid)) continue;
        keep.add(pid);
        for (const p of procs) if (p.ppid === pid) frontier.push(p.pid);
      }
    }
  }
  let rssKb = 0, cpuSeconds = 0;
  const detail = [];
  for (const p of procs) {
    if (!keep.has(p.pid)) continue;
    rssKb += p.rssKb;
    const t = p.cpu.match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
    if (t) cpuSeconds += (Number(t[1] ?? 0)) * 60 + Number(t[2]) + Number(t[3] ?? 0) / (t[3].includes(".") ? 1 : 1);
    detail.push({ pid: p.pid, rssKb: p.rssKb, cmd: p.cmd.slice(0, 160) });
  }
  return { at: Date.now(), count: keep.size, rssKb, cpuSeconds, detail };
}

console.log(JSON.stringify(sample()));
