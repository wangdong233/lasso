#!/usr/bin/env node
/**
 * v19 验证 V5：抽样性能用例（每类 1 条，串行 + 用例间 sleep 2s + 资源三采样）。
 *  1 navigate+extract markdown / 2 screenshot / 3 network / 4 search(fallback_chain) / 5 desktop snapshot
 * 阈值：单用例 peak RSS > 600MB 或 after 残留 → 超标清单（根因审查）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import { ResourceMeter } from "../../../test/helpers/resource-meter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const mb = (kb) => Math.round(kb / 1024);

const stderrLog = path.join(here, "v19-v5-stderr.log");
try { fs.unlinkSync(stderrLog); } catch {}
const client = new Client({ name: "v19-verify-v5", version: "1" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  env: { ...process.env, LASSO_HEADLESS_IDLE_MS: "0" }, // 用例串行期间不让 idle 回收搅动采样；收尾统一 teardown
});
await client.connect(transport);
const call = (name, args, t = 90_000) => client.callTool({ name, arguments: args }, undefined, { timeout: t });

const cases = [];
async function runCase(id, label, fn) {
  await new Promise(r => setTimeout(r, 2000)); // 用例间静默
  const meter = new ResourceMeter();
  const before = meter.before();
  const t0 = Date.now();
  let detail = "", ok = false;
  try { detail = await fn(); ok = true; } catch (e) { detail = "EXC:" + String(e).slice(0, 120); }
  const ms = Date.now() - t0;
  const peak = meter.peak();
  const after = meter.after();
  const rec = {
    id, label, ok, ms, detail: String(detail).slice(0, 140),
    before: { count: before.count, rssMb: mb(before.rssKb) },
    peak: { count: peak.count, rssMb: mb(peak.rssKb), cpuS: +peak.cpuSeconds.toFixed(1) },
    after: { count: after.count, rssMb: mb(after.rssKb) },
    released: meter.released(before, after),
    overThreshold: mb(peak.rssKb) > 600 || (after.count > before.count),
  };
  cases.push(rec);
  console.log(`[${id}] ${label}: ${ms}ms ok=${ok} peak=${rec.peak.rssMb}MB/${rec.peak.count}p after=${rec.after.rssMb}MB/${rec.after.count}p released=${rec.released}${rec.overThreshold ? " ⚠️OVER" : ""}`);
  console.log(`     ${rec.detail}`);
}

const getUrl = (r) => { try { return JSON.parse(r.content[0].text); } catch { return {}; } };

// 1. navigate + extract markdown（两调用代表真实用法）
await runCase("V5-1", "navigate+extract markdown (headless)", async () => {
  const r1 = getUrl(await call("browse_headless", { url: "https://example.com/", action: "navigate" }));
  const r2 = getUrl(await call("browse_headless", { url: "https://example.com/", action: "extract", options: { extract_mode: "markdown" } }));
  const f = r2.data?.content_path && JSON.parse(fs.readFileSync(r2.data.content_path, "utf8"));
  return `nav=${r1.outcome} extract=${r2.outcome} title=${JSON.stringify(f?.title)} md_head=${JSON.stringify((f?.preview ?? "").slice(0, 60))}`;
});

// 2. screenshot（full page）
await runCase("V5-2", "screenshot (headless fullPage)", async () => {
  const r = getUrl(await call("browse_headless", { url: "https://example.com/", action: "screenshot", options: { screenshot: { full: true } } }));
  const p = (r.data?.preview ?? "").match(/\/tmp\/lasso-screenshot-.*\.png/)?.[0];
  const sz = p ? fs.statSync(p).size : 0;
  return `${r.outcome} file=${p ?? "none"} size=${sz}`;
});

// 3. network
await runCase("V5-3", "network (headless)", async () => {
  const r = getUrl(await call("network", { url: "https://example.com/" }));
  const entries = r.data?.entries ?? r.data?.count ?? "?";
  return `${r.outcome} method=${r.retrieval_method} entries=${entries}`;
});

// 4. search fallback_chain
await runCase("V5-4", "search (fallback chain)", async () => {
  const r = getUrl(await call("search", { query: "example domain site:example.com", max_results: 3 }), 120_000);
  return `${r.outcome} method=${r.retrieval_method} results=${(r.data?.results ?? []).length} err=${r.error ?? "none"}`;
});

// 5. desktop snapshot（AXAPI；无权限/无 rust-helper 则诚实记录）
await runCase("V5-5", "desktop snapshot (AXAPI+rust)", async () => {
  const r = getUrl(await call("desktop", { action: "snapshot" }), 60_000);
  return `${r.outcome} method=${r.retrieval_method} err=${r.error ?? "none"} preview=${JSON.stringify((r.data?.preview ?? r.data?.text ?? "").slice(0, 60))}`;
});

// ---- teardown：server 优雅关（killAllSync 收 headless 树）----
const meterT = new ResourceMeter();
const beforeT = meterT.before();
await transport.close();
await new Promise(r => setTimeout(r, 3000));
const afterT = meterT.after();
console.log(`[teardown] server exit: before=${beforeT.count}p/${mb(beforeT.rssKb)}MB after=${afterT.count}p/${mb(afterT.rssKb)}MB released=${meterT.released(beforeT, afterT)}`);

fs.writeFileSync(path.join(here, "v19-v5-perf.json"), JSON.stringify({ cases, teardown: { before: beforeT.count, after: afterT.count, released: meterT.released(beforeT, afterT) } }, null, 2));
