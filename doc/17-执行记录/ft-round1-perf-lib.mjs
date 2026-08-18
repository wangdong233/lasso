#!/usr/bin/env node
/** ft-r11 L-COST 公共库：串行 MCP 计时 + lasso 进程树采样（对齐 test/helpers/resource-meter.ts 三特征） */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";

export const REPO = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export function sampleLasso() {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (!r.stdout) return { count: 0, rssKb: 0 };
  const procs = r.stdout.split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] } : null;
  }).filter(Boolean);
  const isRoot = (p) =>
    (p.cmd.includes("--user-data-dir=") && /lasso/.test(p.cmd)) ||
    (p.cmd.includes("chrome-devtools-mcp") && p.cmd.includes("--disable-blink-features")) ||
    p.cmd.includes("dist/index.js");
  const pids = new Set(procs.filter(isRoot).map((p) => p.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of procs) if (!pids.has(p.pid) && pids.has(p.ppid)) { pids.add(p.pid); changed = true; }
  }
  const tree = procs.filter((p) => pids.has(p.pid));
  return { count: tree.length, rssKb: tree.reduce((a, p) => a + p.rss, 0) };
}

export async function withServer(env, fn) {
  const client = new Client({ name: "ft-r11-lcost", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh",
    args: ["-c", "exec node dist/index.js 2>>/tmp/ft-r11-server-stderr.log"],
    cwd: REPO,
    env: { ...process.env, ...env },
  });
  const t0 = Date.now();
  await client.connect(transport);
  const connectMs = Date.now() - t0;
  try { return await fn(client, connectMs); }
  finally { await transport.close(); await sleep(400); }
}

export async function timedCall(client, name, args, timeoutMs = 180000) {
  const t0 = Date.now();
  let res = null, threw = null;
  try { res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }); }
  catch (e) { threw = String(e).slice(0, 200); }
  const ms = Date.now() - t0;
  let p = null;
  const text = res?.content?.[0]?.text;
  if (text) { try { p = JSON.parse(text); } catch { p = { raw: String(text).slice(0, 300) }; } }
  return { ms, isError: !!res?.isError, threw, p };
}

/** 从 search 响应抽摘要 */
export function sumSearch(r) {
  const d = r.p?.data ?? r.p ?? {};
  const results = d.results?.length ?? null;
  const first = d.results?.[0] ?? {};
  return {
    ms: r.ms, isError: r.isError, threw: r.threw,
    outcome: d.outcome ?? r.p?.outcome,
    served_by: d.served_by ?? r.p?.served_by,
    results, first_url: (first.url ?? "").slice(0, 48),
    actions: (d.actions_and_results ?? r.p?.actions_and_results ?? []).map((a) => `${a.action ?? a.channel}:${a.outcome ?? a.result}`).join(","),
    content_status: (d.results ?? []).map((x) => x.content_status).filter(Boolean).slice(0, 5),
    content_chars: (d.results ?? []).reduce((a, x) => a + (x.content?.length ?? 0), 0),
    error: (d.error ?? r.p?.error ?? "").toString().slice(0, 80),
  };
}
