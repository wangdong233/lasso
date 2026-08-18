#!/usr/bin/env node
/** ft-round1 T-OBS + T-RT + T-FALL：admin 治理组全家桶（单 server 连接，串行 + 2s 间隔） */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stderrLog = path.join(here, "ft-admin-stderr.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: "ft-admin-flow", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  env: { ...process.env },
});
await client.connect(transport);

// tools/list_changed 通知捕获（T-RT-01 / U-10-2）
const listChanged = [];
try {
  client.setNotificationHandler?.("notifications/tools/list_changed", () => {
    listChanged.push(Date.now());
  });
} catch { /* SDK 版本不支持则靠 listTools 轮询 */ }

async function admin(args) {
  const r = await client.callTool({ name: "admin", arguments: args }, undefined, { timeout: 60000 });
  return JSON.parse(r.content[0].text);
}
async function search(q) {
  const t = Date.now();
  const r = await client.callTool(
    { name: "search", arguments: { query: q, limit: 3 } }, undefined, { timeout: 90000 });
  return { ms: Date.now() - t, j: JSON.parse(r.content[0].text) };
}

const out = {};
try {
  // ---- T-RT-02 tool_list ----
  const tl = await admin({ action: "tool_list" });
  out.tool_list = { total: tl.total_tools, channels: Object.fromEntries(Object.entries(tl.channels).map(([k, v]) => [k, v.length])) };

  // ---- T-OBS-01 cold metrics ----
  const m0 = await admin({ action: "metrics_snapshot" });
  out.metrics_cold = {
    configured: m0.configured,
    channels: m0.channels.length,
    first: m0.channels[0] ? { channel: m0.channels[0].channel, total: m0.channels[0].total } : null,
    alerts: m0.alerts.length,
  };

  // ---- 2 searches（machine_mcp 命中口径）----
  const s1 = await search("lasso mcp github");
  out.search1 = { ms: s1.ms, outcome: s1.j.outcome, served_by: s1.j.served_by, results: s1.j.data?.results?.length ?? 0, has_audit: Array.isArray(s1.j.actions_and_results) };
  await sleep(2000);
  const s2 = await search("lasso-mcp npm package");
  out.search2 = { ms: s2.ms, outcome: s2.j.outcome, served_by: s2.j.served_by, results: s2.j.data?.results?.length ?? 0 };
  await sleep(2000);

  // ---- T-OBS-01 after ----
  const m1 = await admin({ action: "metrics_snapshot" });
  const sm = m1.channels.find((c) => c.channel.includes("machine_mcp")) ?? m1.channels.find((c) => c.total > 0);
  out.metrics_after = {
    channels_with_total: m1.channels.filter((c) => c.total > 0).map((c) => `${c.channel}=${c.total}`),
    hot_channel: sm ? { channel: sm.channel, total: sm.total, p50_ms: sm.p50_ms, p95_ms: sm.p95_ms, success_rate: sm.success_rate } : null,
  };

  // ---- T-OBS-03 / T-RT-05 serp_health ----
  const sh = await admin({ action: "serp_health" });
  out.serp_health = { configured: sh.configured, engines: (sh.engines ?? []).map((e) => `${e.engine ?? e.name}:hit=${e.hit_rate ?? e.hitRate}`), redesign_suspected: sh.redesign_suspected };

  // ---- T-RT-05 / T-FALL-02/03 breaker_status ----
  const bs = await admin({ action: "breaker_status" });
  out.breaker_status = {
    configured: bs.configured,
    short_count: bs.breakers.filter((b) => b.kind === "short").length,
    long_count: bs.breakers.filter((b) => b.kind === "long").length,
    all_closed: bs.breakers.every((b) => b.state === "closed"),
    sample: bs.breakers.slice(0, 4).map((b) => `${b.channel}/${b.kind}:${b.state}`),
  };

  // ---- T-FALL-03b breaker_reset：unknown name → fail ----
  const br1 = await admin({ action: "breaker_reset", name: "no.such.channel", reason: "ft-test" });
  out.breaker_reset_unknown = { ok: br1.ok, error: (br1.error ?? "").slice(0, 60) };
  await sleep(2000);
  // ---- 真名 reset：closed→closed，reset_short=true ----
  const br2 = await admin({ action: "breaker_reset", name: "search.brave", reason: "ft-round1 验证 reset 出口" });
  out.breaker_reset_real = { ok: br2.ok, name: br2.name, reset_short: br2.reset_short, before: br2.before, after: br2.after };

  // ---- T-RT-04 provider 热插拔 ----
  const pa = await admin({ action: "provider_add", config: { name: "ft-probe-1", type: "api_key", endpoint_url: "https://example.invalid/api", keys: ["SHOULD_BE_STRIPPED"] }, reason: "ft" });
  out.provider_add = { ok: pa.ok, keys_from_env: pa.keys_from_env, note: pa.note ?? pa.error ?? "" };
  const pa2 = await admin({ action: "provider_add", config: { name: "ft-probe-1", type: "api_key", endpoint_url: "https://example.invalid/api" }, reason: "dup" });
  out.provider_add_dup = { ok: pa2.ok, error: (pa2.error ?? "").slice(0, 70) };
  const pst = await admin({ action: "provider_set_tos", name: "ft-probe-1", tos_ack: true });
  out.provider_set_tos = { ok: pst.ok, tos_ack: pst.tos_ack };
  const pr = await admin({ action: "provider_remove", name: "ft-probe-1", reason: "ft cleanup" });
  out.provider_remove = { ok: pr.ok, removed: pr.removed };
  const pr2 = await admin({ action: "provider_remove", name: "ft-probe-1", reason: "already gone" });
  out.provider_remove_again = { ok: pr2.ok, removed: pr2.removed };
  await sleep(2000);

  // ---- T-RT-06 caller cap ----
  const cs = await admin({ action: "caller_cap_set", callerId: "anonymous", cap: 5 });
  out.cap_set = { ok: cs.ok, cap: cs.cap };
  const caps = [];
  for (let i = 0; i < 6; i++) {
    const r = await search("cap probe identical query");
    caps.push(`${r.j.outcome}/${r.j.retrieval_method}`);
    await sleep(1500);
  }
  out.cap_probe_6 = caps;
  out.cap_6th_refused = caps[5].includes("caller_cap_exceeded");
  const cl = await admin({ action: "caller_cap_list" });
  out.cap_list = { callers: cl.callers };
  // cap=0 封禁验证
  const cs0 = await admin({ action: "caller_cap_set", callerId: "ft-banned", cap: 0 });
  const banned = await admin({ action: "caller_cap_list" });
  out.cap_zero = { set_ok: cs0.ok, entry: banned.callers.find((c) => c.callerId === "ft-banned") ?? null };
  // 解除 anonymous 限制（不留脏状态）
  await admin({ action: "caller_cap_set", callerId: "anonymous", cap: 1000000 });

  // ---- T-RT-01 capability 启停 ----
  const cd = await admin({ action: "capability_disable", name: "browse_headless", reason: "ft-round1 T-RT-01" });
  out.cap_disable = { ok: cd.ok, changed: cd.changed };
  await sleep(300);
  const toolsAfter = await client.listTools();
  out.browse_gone = !toolsAfter.tools.some((t) => t.name === "browse_headless");
  out.list_changed_fired = listChanged.length > 0;
  const ce = await admin({ action: "capability_enable", name: "browse_headless" });
  out.cap_enable = { ok: ce.ok, changed: ce.changed };
  await sleep(300);
  const toolsRestored = await client.listTools();
  out.browse_back = toolsRestored.tools.some((t) => t.name === "browse_headless");
  await sleep(2000);

  // ---- T-RT-08 错误面 ----
  const e1 = await admin({ action: "capability_disable", name: "browse_headless" });
  out.missing_reason = { ok: e1.ok, error: e1.error };
  try {
    const r = await client.callTool({ name: "admin", arguments: { action: "no_such_action" } }, undefined, { timeout: 30000 });
    out.unknown_action = { isError: r.isError, text: (r.content?.[0]?.text ?? "").slice(0, 90) };
  } catch (e) {
    out.unknown_action = { thrown: String(e).slice(0, 100) };
  }
  try {
    const r = await client.callTool({ name: "admin", arguments: {} }, undefined, { timeout: 30000 });
    out.no_args = { isError: r.isError, text: (r.content?.[0]?.text ?? "").slice(0, 90) };
  } catch (e) {
    out.no_args = { thrown: String(e).slice(0, 100) };
  }

  // ---- T-FALL-01 三态观察（成功侧）：search audit 链 ----
  const s3 = await search("tri-state engine probe");
  const audit = s3.j.actions_and_results ?? [];
  out.tri_state = {
    final_outcome: s3.j.outcome,
    chain: audit.map((a) => `${a.channel ?? a.engine ?? "?"}:${a.outcome}`),
    fallback_used: s3.j.fallback_used,
  };
} finally {
  await transport.close();
  await sleep(400);
}
console.log(JSON.stringify(out, null, 1));
