#!/usr/bin/env node
/** ft-round1 T-SSRF-01/02 + T-FALL-01/06：SSRF 拦截矩阵 + deny 优先 + outcome 归一化 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(envExtra, logName) {
  const client = new Client({ name: "ft-ssrf", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh",
    args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(path.join(here, logName))}`],
    cwd: repoRoot,
    env: { ...process.env, ...envExtra },
  });
  await client.connect(transport);
  return { client, transport };
}
const fetchUrl = async (c, url) => {
  const t = Date.now();
  try {
    const r = await c.callTool({ name: "fetch_url", arguments: { url } }, undefined, { timeout: 45000 });
    const j = JSON.parse(r.content[0].text);
    return { ms: Date.now() - t, outcome: j.outcome, method: j.retrieval_method, error: (j.error ?? "").slice(0, 60), status: j.data?.status };
  } catch (e) {
    return { ms: Date.now() - t, THROWN: String(e).slice(0, 80) };
  }
};

const out = { ssrf_default: {}, ssrf_deny: {}, fall: {} };

// ---- 连接 1：默认 SSRF config ----
const a = await connect({}, "ft-ssrf-stderr.log");
try {
  const cases = [
    ["private_192", "http://192.168.1.1/"],
    ["private_10", "http://10.0.0.1/"],
    ["userinfo", "http://evil.com@trusted.com/"],
    ["ftp_proto", "ftp://x/"],
    ["ipv6_loopback", "http://[::1]:18191/"],
    ["metadata_169", "http://169.254.169.254/latest/meta-data/"],
    ["loopback_allowed", "http://127.0.0.1:18191/"],
    ["fakeip_allowed", "http://198.18.5.5:18191/"],
  ];
  for (const [tag, url] of cases) {
    out.ssrf_default[tag] = await fetchUrl(a.client, url);
    await sleep(2000);
  }
  // T-FALL-06 outcome 归一化（本地 404/500/302）
  out.fall.e404 = await fetchUrl(a.client, "http://127.0.0.1:18191/404");
  await sleep(1500);
  out.fall.e500 = await fetchUrl(a.client, "http://127.0.0.1:18191/500");
  await sleep(1500);
  const redir = await a.client.callTool(
    { name: "fetch_url", arguments: { url: "http://127.0.0.1:18191/redir" } }, undefined, { timeout: 45000 });
  const rj = JSON.parse(redir.content[0].text);
  out.fall.redirect = { outcome: rj.outcome, method: rj.retrieval_method, location: rj.data?.location, body_kind: rj.data?.body_kind };
  // T-FALL-01 佐证：empty200（unknown 分支语义——200 空响应）
  const empty = await a.client.callTool(
    { name: "fetch_url", arguments: { url: "http://127.0.0.1:18191/empty200" } }, undefined, { timeout: 45000 });
  const ej = JSON.parse(empty.content[0].text);
  out.fall.empty200 = { outcome: ej.outcome, body_bytes: ej.data?.body_bytes };
} finally {
  await a.transport.close();
  await sleep(400);
}

// ---- 连接 2：LASSO_SSRF_DENY_RANGES=203.0.113.0/24（deny 优先级）----
const b = await connect({ LASSO_SSRF_DENY_RANGES: "203.0.113.0/24" }, "ft-ssrf-deny-stderr.log");
try {
  out.ssrf_deny.deny_range_hit = await fetchUrl(b.client, "http://203.0.113.9/");
  await sleep(1500);
  out.ssrf_deny.loopback_still_allowed = await fetchUrl(b.client, "http://127.0.0.1:18191/");
  // doctor ssrf_config check
  const d = await b.client.callTool({ name: "doctor", arguments: {} }, undefined, { timeout: 60000 });
  const dj = JSON.parse(d.content[0].text);
  const sc = dj.checks.find((c) => c.name === "ssrf_config");
  out.ssrf_deny.doctor_ssrf_config = { status: sc.status, detail: (sc.detail ?? "").slice(0, 100) };
} finally {
  await b.transport.close();
  await sleep(400);
}
console.log(JSON.stringify(out, null, 1));
