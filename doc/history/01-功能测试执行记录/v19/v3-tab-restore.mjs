#!/usr/bin/env node
/**
 * v19 验证 V3（重跑）：tab 快照恢复红线（真机，port 9226）。
 *
 * 事实澄清（白盒）：lasso browse_logged_in 不开新 tab（chrome-devtools-mcp 导航当前
 * tab；NAV_FIRST_ACTIONS={network,screenshot,pdf}），TabSession 的 diff 语义针对
 * 「快照后出现的任何 page target」。本用例：
 *   launch 9226 → 开 2 个用户 tab → browse_logged_in navigate（首附着快照 3 tab）
 *   → CDP /json/new 开 1 个新 tab（模拟 lasso/自动化遗留）→ admin tab_restore
 *   → 验证：新 tab 关闭、快照内 3 tab（含被 navigate 过的）完好。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import { ResourceMeter } from "../../../test/helpers/resource-meter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const PORT = 9226;
const BASE = `http://127.0.0.1:${PORT}`;
const mb = (kb) => Math.round(kb / 1024);
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000, cwd: repoRoot });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const listPages = () => {
  const r = spawnSync("curl", ["-s", `${BASE}/json/list`], { encoding: "utf8", timeout: 10_000 });
  return JSON.parse(r.stdout).filter(t => t.type === "page");
};
const newTab = (url) => {
  const r = spawnSync("curl", ["-s", "-X", "PUT", `${BASE}/json/new?${encodeURIComponent(url)}`], { encoding: "utf8", timeout: 10_000 });
  try { return JSON.parse(r.stdout); } catch { return null; }
};

const report = {};
const note = (s) => { console.log(s); (report.steps ??= []).push(s); };
const meter = new ResourceMeter();
const before = meter.before();

// ---- launch Chrome 9226 ----
const lc = run("node", ["dist/index.js", "launch-chrome", "--port", String(PORT)]);
const la = JSON.parse(lc.out.slice(0, lc.out.indexOf("\n{"))); // 首个 JSON 对象（后面跟 recordLaunch 日志行）
note(`launch-chrome 9226: ok=${la.ok} pid=${la.pid}`);
await new Promise(r => setTimeout(r, 1500));

// ---- 2 个用户 tab ----
newTab("https://example.com/");
newTab("https://example.org/");
await new Promise(r => setTimeout(r, 2500));
const userTabs = listPages();
note(`user tabs: ${userTabs.map(t => t.id.slice(0, 8) + ":" + t.url.slice(0, 28)).join(" | ")}`);
const userIds = new Set(userTabs.map(t => t.id));
report.user_tab_count = userTabs.length;

// ---- 经 Lasso browse_logged_in navigate（首附着 = 快照）----
const stderrLog = path.join(here, "v19-v3-stderr.log");
try { fs.unlinkSync(stderrLog); } catch {}
const client = new Client({ name: "v19-verify-v3", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  env: { ...process.env, LASSO_CDP_PORT: String(PORT) },
});
await client.connect(transport);

try {
  const r1 = await client.callTool({ name: "browse_logged_in", arguments: { url: "https://httpbin.org/html", action: "navigate" } }, undefined, { timeout: 90_000 });
  const j1 = JSON.parse(r1.content?.[0]?.text ?? "{}");
  note(`browse_logged_in navigate: outcome=${j1.outcome} final_url=${j1.data?.final_url} err=${j1.error ?? "none"}`);
  const snapTabs = listPages();
  const snapIds = new Set(snapTabs.map(t => t.id));
  note(`snapshot-time tabs: ${snapTabs.length} → ${snapTabs.map(t => t.id.slice(0, 8) + ":" + t.url.slice(0, 28)).join(" | ")}`);
  report.snapshot_tab_count = snapTabs.length;
  report.user_tabs_in_snapshot = [...userIds].every(id => snapIds.has(id));

  // ---- 快照后开 1 个「遗留」tab（模拟 lasso/自动化开的 tab）----
  const extra = newTab("https://example.net/");
  await new Promise(r => setTimeout(r, 1500));
  const preRestore = listPages();
  note(`extra tab opened: ${extra?.id?.slice(0, 8)} → now ${preRestore.length} pages`);
  report.extra_tab_id = extra?.id;

  // ---- admin tab_restore（带 reason）----
  const rr = await client.callTool({ name: "admin", arguments: { action: "tab_restore", reason: "v19 验证 V3：功能测试收尾恢复原 tab 列表" } }, undefined, { timeout: 30_000 });
  const jr = JSON.parse(rr.content?.[0]?.text ?? "{}");
  note(`admin tab_restore: ${JSON.stringify(jr)}`);
  report.tab_restore_result = jr;

  // ---- 验证：extra 关闭、快照 tab 完好 ----
  await new Promise(r => setTimeout(r, 1500));
  const afterRestore = listPages();
  const afterIds = new Set(afterRestore.map(t => t.id));
  const snapIntact = [...snapIds].every(id => afterIds.has(id));
  const userIntact = [...userIds].every(id => afterIds.has(id));
  const extraClosed = !afterIds.has(extra?.id ?? "NONE");
  note(`after restore: ${afterRestore.length} pages; snapshot_intact=${snapIntact} user_intact=${userIntact} extra_closed=${extraClosed} → ${afterRestore.map(t => t.id.slice(0, 8) + ":" + t.url.slice(0, 28)).join(" | ")}`);
  report.snapshot_tabs_intact = snapIntact;
  report.user_tabs_intact = userIntact;
  report.extra_tab_closed = extraClosed;

  // 无 reason 必须拒（mutation 纪律）
  const rn = await client.callTool({ name: "admin", arguments: { action: "tab_restore" } }, undefined, { timeout: 30_000 });
  const jn = JSON.parse(rn.content?.[0]?.text ?? "{}");
  note(`tab_restore without reason: ok=${jn.ok} error=${jn.error ?? "none"}`);
  report.no_reason_rejected = jn.ok === false;
} catch (e) {
  report.error = String(e);
  console.error("V3 FAILED:", String(e));
  process.exitCode = 1;
} finally {
  meter.stop();
  await transport.close();
  await new Promise(r => setTimeout(r, 2500));
}

// ---- 资源 + 残留 ----
const after = meter.after();
const peak = meter.peak();
report.peak = { count: peak.count, rssMb: mb(peak.rssKb) };
report.after = { count: after.count, rssMb: mb(after.rssKb) };
report.released = meter.released(before, after);
const portStill = spawnSync("nc", ["-z", "127.0.0.1", String(PORT)]).status === 0;
note(`resource: peak=${report.peak.rssMb}MB/${report.peak.count}procs after=${report.after.rssMb}MB/${report.after.count}procs released=${report.released}; port9226_closed_by_server_shutdown=${!portStill}`);
report.port_closed = !portStill;

fs.writeFileSync(path.join(here, "v19-v3-tab-restore.json"), JSON.stringify(report, null, 2));
