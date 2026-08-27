#!/usr/bin/env node
/** ft-round1 T-FOREST-01/02：roots 复用 + 前缀路由（单 server + headless 浏览器一次 spawn） */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stderrLog = path.join(here, "ft-forest-stderr.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 资源采样（与 resource-meter 同特征：user-data-dir lasso / chrome-devtools-mcp / dist/index.js + ppid 闭包）---
function sample() {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
  const rows = (ps.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => l.match(/^(\d+)\s+(\d+)\s+(\d+)\s(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }));
  const roots = rows.filter((p) =>
    (/--user-data-dir=/.test(p.cmd) && p.cmd.includes("lasso")) ||
    (p.cmd.includes("chrome-devtools-mcp") && p.cmd.includes("--disable-blink-features")) ||
    p.cmd.includes("dist/index.js"));
  let count = 0, rss = 0;
  for (const rt of roots) {
    const st = [rt.pid], seen = new Set();
    while (st.length) {
      const cur = st.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const p = rows.find((r) => r.pid === cur);
      if (p) { count++; rss += p.rss; }
      for (const q of rows) if (q.ppid === cur && !seen.has(q.pid)) st.push(q.pid);
    }
  }
  return { count, rssKb: rss };
}
const before = sample();
const peakSampler = setInterval(() => {
  const c = sample();
  if (c.count > (peak.count ?? 0) || c.rssKb > (peak.rssKb ?? 0)) { peak.count = c.count; peak.rssKb = c.rssKb; }
}, 500);
const peak = {};

const client = new Client({ name: "ft-forest-flow", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  env: { ...process.env },
});
await client.connect(transport);

const call = (n, a) => client.callTool({ name: n, arguments: a }, undefined, { timeout: 120000 });
const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return { RAW: r.content?.[0]?.text?.slice(0, 120) }; } };

const out = { resource: {} };
try {
  // 1. navigate 两个不同 url（触发 headless spawn + roots 注册）
  let t = Date.now();
  const n1 = parse(await call("browse_headless", { url: "https://example.com", action: "navigate" }));
  out.nav1 = { ms: Date.now() - t, outcome: n1.outcome };
  await sleep(2000);
  t = Date.now();
  const n2 = parse(await call("browse_headless", { url: "https://example.org", action: "navigate" }));
  out.nav2 = { ms: Date.now() - t, outcome: n2.outcome };
  await sleep(2000);

  // 2. interact_roots ×2：@pN 分配 + 复用（同 url）
  const r1 = parse(await call("interact_roots", {}));
  out.roots1 = { count: r1.count ?? r1.data?.count, roots: (r1.roots ?? r1.data?.roots ?? []).map((x) => `${x.rootRef} ${x.source} ${(x.subtitle ?? "").slice(0, 30)}`) };
  await sleep(2000);
  const n1b = parse(await call("browse_headless", { url: "https://example.com", action: "navigate" }));
  out.nav1_again = { outcome: n1b.outcome };
  const r2 = parse(await call("interact_roots", {}));
  out.roots2 = { count: r2.count ?? r2.data?.count, roots: (r2.roots ?? r2.data?.roots ?? []).map((x) => `${x.rootRef} ${x.source} ${(x.subtitle ?? "").slice(0, 30)}`) };
  // 复用判定：example.com 两次后 rootRef 不变
  const p1_first = out.roots1.roots.find((x) => x.includes("example.com"));
  const p1_second = out.roots2.roots.find((x) => x.includes("example.com"));
  out.reuse_same_ref = !!p1_first && p1_first === p1_second;

  // 3. 前缀路由正向：interact_observe @pN（第一个 browse root）
  const pRef = (out.roots2.roots[0] ?? "").split(" ")[0];
  t = Date.now();
  const ob = parse(await call("interact_observe", { rootRef: pRef, action: "snapshot" }));
  out.observe_p = { ref: pRef, ms: Date.now() - t, outcome: ob.outcome, method: ob.retrieval_method, preview_head: (ob.data?.preview ?? "").slice(0, 40) };
  await sleep(2000);

  // 4. 错误路径：@w0（无 desktop root）/ @x0（未知前缀）/ @p99（stale）
  for (const ref of ["@w0", "@x0", "@p99"]) {
    const e = parse(await call("interact_observe", { rootRef: ref, action: "snapshot" }));
    out[`err_${ref}`] = { outcome: e.outcome, method: e.retrieval_method, error: (e.error ?? "").slice(0, 60) };
    await sleep(1500);
  }
} finally {
  await transport.close();
  await sleep(1500);
}
clearInterval(peakSampler);
const after = sample();
out.resource = {
  before: `${before.count} procs / ${Math.round(before.rssKb / 1024)}MB`,
  peak: `${peak.count} procs / ${Math.round((peak.rssKb ?? 0) / 1024)}MB`,
  after: `${after.count} procs / ${Math.round(after.rssKb / 1024)}MB`,
  released: after.count <= before.count || after.rssKb <= before.rssKb * 1.1 + 50 * 1024,
};
console.log(JSON.stringify(out, null, 1));
