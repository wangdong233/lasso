#!/usr/bin/env node
/** 静默性真机验证 probe 库（doc/27 verify 轮专用；只读采样，零 src/test 改动） */
import { execSync } from "node:child_process";

const sh = (cmd, opts = {}) => {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 15000, ...opts }).trim();
  } catch (e) {
    return e.stdout ? e.stdout.trim() : `__ERR__:${String(e.message).slice(0, 120)}`;
  }
};

/** ① 前台 app 名（System Events；查询本身不改焦点） */
export const frontmost = () =>
  sh(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`);

/** ② 某 unix pid 的窗口数 */
export const windowsOfPid = (pid) =>
  Number(
    sh(`osascript -e 'tell application "System Events" to count windows of (first application process whose unix id is ${pid})'`) || "NaN",
  );

/** ③ Dock/LaunchServices 注册面：所有名为 Google Chrome 的 ASN 摘要 + Foreground 型计数 */
export function chromeAsns() {
  const out = sh(`lsappinfo list 2>/dev/null | grep -A2 '"Google Chrome"'`);
  const entries = [];
  const re = /"Google Chrome" ASN:(0x[0-9A-Fa-f-]+)/g;
  let m;
  const full = sh(`lsappinfo list 2>/dev/null`);
  // 每个条目块解析：ASN 行 + 后续 type= 行
  const blocks = full.split(/\n\s*\d+\)\s/).filter((b) => b.includes('"Google Chrome"') || b.includes("chrome-devtools-mcp"));
  for (const b of blocks) {
    const nameM = b.match(/^"([^"]+)"/) || b.match(/"([^"]+)" ASN:/);
    const asnM = b.match(/ASN:(0x[0-9A-Fa-f-]+)/);
    const typeM = b.match(/type="([^"]+)"/);
    const pidM = b.match(/pid = (\d+)/);
    entries.push({
      name: nameM ? nameM[1] : "?",
      asn: asnM ? asnM[1] : "?",
      type: typeM ? typeM[1] : "?",
      pid: pidM ? Number(pidM[1]) : null,
    });
  }
  const chromeForeground = entries.filter((e) => e.name === "Google Chrome" && e.type === "Foreground").length;
  const cdmEntries = entries.filter((e) => e.name.includes("chrome-devtools-mcp")).length;
  return { raw_grep_count: (out.match(/"Google Chrome" ASN/g) || []).length, chromeForeground, cdmEntries, entries };
}

/** ⑥ 进程采样：按 pgrep 模式收进程树（pid/ppid/pcpu/rss/cmdline 首 80 字） */
export function procsMatching(pattern) {
  const out = sh(`pgrep -if "${pattern}" 2>/dev/null`);
  if (!out || out.startsWith("__ERR__")) return [];
  return out
    .split("\n")
    .filter(/^\d+$/.test.bind(/^\d+$/))
    .map((pid) => {
      const ps = sh(`ps -o ppid=,pcpu=,rss=,command= -p ${pid} 2>/dev/null`);
      if (!ps) return null;
      const parts = ps.trim().split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(parts[0]),
        pcpu: Number(parts[1]),
        rssKb: Number(parts[2]),
        cmd: parts.slice(3).join(" ").slice(0, 120),
      };
    })
    .filter(Boolean);
}

/** ⑥ 资源三采样：Chromium 树（按 user-data-dir 归属）——树 pid 集合 + RSS/CPU 总和 */
export function chromiumTreeSum(matchFlag) {
  const list = procsMatching(matchFlag);
  const pids = new Set(list.map((p) => p.pid));
  // 追 helper 子进程（ppid 闭包两跳）
  for (let i = 0; i < 2; i++) {
    for (const p of procsMatching("Google Chrome")) {
      if (pids.has(p.ppid)) pids.add(p.pid);
    }
  }
  let rss = 0,
    cpu = 0,
    n = 0;
  for (const pid of pids) {
    const ps = sh(`ps -o pcpu=,rss= -p ${pid} 2>/dev/null`);
    if (!ps) continue;
    const [c, r] = ps.trim().split(/\s+/);
    cpu += Number(c);
    rss += Number(r);
    n++;
  }
  return { procs: n, rssKb: rss, cpuPct: Number(cpu.toFixed(1)), pidList: [...pids].sort((a, b) => a - b) };
}

/** 某 pid 的完整 cmdline（ps） */
export const cmdlineOf = (pid) => sh(`ps -o command= -p ${pid} 2>/dev/null`);

/** 时间戳 */
export const ts = () => new Date().toISOString();

/** 单步采样包（①②③⑥ 一次抓齐） */
export function sample(label, { chromePid = null, treeFlag = null } = {}) {
  const s = { t: ts(), label, frontmost: frontmost() };
  if (chromePid) s.chromeWindows = windowsOfPid(chromePid);
  if (treeFlag) Object.assign(s, chromiumTreeSum(treeFlag));
  return s;
}

/** 端口探活 */
export const portAlive = (port) =>
  sh(`curl -s -m 2 http://localhost:${port}/json/version 2>/dev/null`).includes("Browser") ||
  sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null`).length > 0;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CPU/RSS 峰值采样器（对某 pid；返回 stop 函数） */
export function cpuPeakSampler(pid, intervalMs = 150) {
  const peak = { maxPcpu: 0, maxRssKb: 0, samples: 0 };
  const timer = setInterval(() => {
    const ps = sh(`ps -o pcpu=,rss= -p ${pid} 2>/dev/null`);
    if (!ps) return;
    const [c, r] = ps.trim().split(/\s+/);
    peak.maxPcpu = Math.max(peak.maxPcpu, Number(c));
    peak.maxRssKb = Math.max(peak.maxRssKb, Number(r));
    peak.samples++;
  }, intervalMs);
  return { stop: () => (clearInterval(timer), peak) };
}
