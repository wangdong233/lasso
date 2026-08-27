#!/usr/bin/env node
/**
 * v19 验证 V1：headless 空闲关停（LASSO_HEADLESS_IDLE_MS=10000）真机验证。
 *
 * 流程（doc/17 §0.2 纪律：资源三采样 + 释放判定）：
 *  before 采样 → browse_headless extract 一次（Chrome 树拉起）→ 记录 server 后代中
 *  chrome-devtools-mcp pid 集 → 等 15s → 验证树全灭（pid 级 pgrep）→ 再 browse 一次
 *  （冷启动自愈）→ after 采样 + released() 判定 → stderr 日志 grep idle_shutdown 证据。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import { ResourceMeter, sampleLassoTree } from "../../../test/helpers/resource-meter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const stderrLog = path.join(here, "v19-idle-stderr.log");
try { fs.unlinkSync(stderrLog); } catch {}

const meter = new ResourceMeter();
const mb = (kb) => Math.round(kb / 1024);

const URL_ = "https://example.com/";

const client = new Client({ name: "v19-verify-v1", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  env: { ...process.env, LASSO_HEADLESS_IDLE_MS: "10000" },
});
await client.connect(transport);

const call = (name, args) =>
  client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });

const report = { steps: [] };
const note = (s) => { report.steps.push(s); console.log(s); };

try {
  // ---- before ----
  const before = meter.before();
  note(`before: count=${before.count} rss=${mb(before.rssKb)}MB cpu=${before.cpuSeconds.toFixed(1)}s procs=[${before.procs.map(p=>p.pid+":"+p.matchedBy).join(",")}]`);

  // ---- browse #1（拉起 Chrome 树）----
  const t0 = Date.now();
  const r1 = await call("browse_headless", { url: URL_, action: "extract", options: { extract_mode: "markdown" } });
  const dt1 = Date.now() - t0;
  const j1 = JSON.parse(r1.content?.[0]?.text ?? "{}");
  note(`browse#1: ${dt1}ms outcome=${j1.outcome} method=${j1.retrieval_method} md_len=${(j1.data?.markdown ?? j1.data?.text ?? "").length}`);

  const midTree = sampleLassoTree();
  const serverPid = midTree.procs.find(p => p.matchedBy === "lasso-server")?.pid;
  const cdpPids = midTree.procs.filter(p => p.matchedBy?.startsWith("chrome-devtools-mcp") || String(p.matchedBy).startsWith("descendant")).map(p => p.pid);
  note(`after browse#1 tree: count=${midTree.count} rss=${mb(midTree.rssKb)}MB server_pid=${serverPid} chrome_tree_pids=[${cdpPids.join(",")}]`);

  // ---- 等 idle 生效（reaper tick=60s + idle=10s → 轮询至 90s 上界，记录真实回收时延）----
  const idleStart = Date.now();
  let reapedAt = null;
  while (Date.now() - idleStart < 90_000) {
    await new Promise(r => setTimeout(r, 2_000));
    const t = sampleLassoTree();
    if (!t.procs.some(p => cdpPids.includes(p.pid))) { reapedAt = Date.now() - idleStart; break; }
  }
  const idleTree = sampleLassoTree();
  const survivors = idleTree.procs.filter(p => cdpPids.includes(p.pid));
  note(`after idle: reaped_in=${reapedAt === null ? "NOT_REAPED(>90s)" : reapedAt + "ms"} count=${idleTree.count} rss=${mb(idleTree.rssKb)}MB survivors=[${survivors.map(p=>p.pid).join(",")||"NONE"}]`);
  report.idle_tree_gone = survivors.length === 0;
  report.reaped_after_ms = reapedAt;

  // ---- browse #2（冷启动自愈）----
  const t2 = Date.now();
  const r2 = await call("browse_headless", { url: URL_, action: "extract", options: { extract_mode: "markdown" } });
  const dt2 = Date.now() - t2;
  const j2 = JSON.parse(r2.content?.[0]?.text ?? "{}");
  note(`browse#2(cold): ${dt2}ms outcome=${j2.outcome} method=${j2.retrieval_method} md_len=${(j2.data?.markdown ?? j2.data?.text ?? "").length}`);
  report.cold_restart_ok = j2.outcome !== "didnt" && Boolean((j2.data?.markdown ?? j2.data?.text ?? "").length);

  // 等 idle 二次回收（同样轮询至 90s），让 after 采样干净
  const idle2Start = Date.now();
  let reaped2At = null;
  while (Date.now() - idle2Start < 90_000) {
    await new Promise(r => setTimeout(r, 2_000));
    const t = sampleLassoTree();
    if (!t.procs.some(p => p.matchedBy?.includes("chrome-devtools-mcp") || String(p.matchedBy).startsWith("descendant"))) { reaped2At = Date.now() - idle2Start; break; }
  }
  note(`second idle reap: ${reaped2At === null ? "NOT_REAPED(>90s)" : reaped2At + "ms"}`);
  await new Promise(r => setTimeout(r, 2_000));

  const peak = meter.peak();
  const after = meter.after();
  note(`peak: count=${peak.count} rss=${mb(peak.rssKb)}MB cpu=${peak.cpuSeconds.toFixed(1)}s`);
  note(`after: count=${after.count} rss=${mb(after.rssKb)}MB cpu=${after.cpuSeconds.toFixed(1)}s procs=[${after.procs.map(p=>p.pid+":"+p.matchedBy).join(",")}]`);
  report.peak = { count: peak.count, rssMb: mb(peak.rssKb), cpuS: +peak.cpuSeconds.toFixed(1) };
  report.after = { count: after.count, rssMb: mb(after.rssKb), cpuS: +after.cpuSeconds.toFixed(1) };
  report.released = meter.released(before, after);
  note(`released()=${report.released}`);
} catch (e) {
  report.error = String(e);
  console.error("V1 FAILED:", String(e));
  process.exitCode = 1;
} finally {
  meter.stop();
  await transport.close();
  await new Promise(r => setTimeout(r, 500));
  const logs = fs.readFileSync(stderrLog, "utf8");
  const idleLines = logs.split("\n").filter(l => /zombie_reaped|idle_watchdog|reap_hook/.test(l));
  report.idle_log_evidence = idleLines.slice(0, 10);
  console.log("--- idle log evidence ---");
  for (const l of idleLines.slice(0, 10)) console.log(l);
  fs.writeFileSync(path.join(here, "v19-v1-idle.json"), JSON.stringify(report, null, 2));
}
