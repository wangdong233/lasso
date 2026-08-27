#!/usr/bin/env node
/** ft-round1 T-READ + L-COST-13：同一 server 进程内 fetch_url 触发 spill → read_text 续页全家桶 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stderrLog = path.join(here, "ft-read-server-stderr.log");

// 与 ft-http-fixture.mjs 相同的 BIG 生成逻辑（本地复算期望字节）
const LINES = [];
for (let i = 0; i < 1600; i++) LINES.push(String(i).padStart(6, "0") + " x".repeat(56));
const BIG = LINES.join("\n");
const BIG_BUF = Buffer.from(BIG, "utf8");

async function connect() {
  const client = new Client({ name: "ft-read-flow", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "/bin/zsh",
    args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
    cwd: repoRoot,
    env: { ...process.env },
  });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  return r;
}

function parse(r) {
  return JSON.parse(r.content[0].text);
}

const out = {};
const { client, transport } = await connect();
try {
  // 1. fetch_url 触发 spill
  const t0 = Date.now();
  const fr = call(client, "fetch_url", { url: "http://127.0.0.1:18191/big.txt" });
  const frRes = await fr;
  out.fetch_ms = Date.now() - t0;
  const fj = parse(frRes);
  const envl = fj.data?.envelope ?? {};
  out.spill = {
    outcome: fj.outcome,
    body_kind: fj.data?.body_kind,
    body_bytes: fj.data?.body_bytes,
    truncated: envl.truncated,
    ref: envl.ref,
    total_bytes: envl.total_bytes,
    continue_hint: envl.continue_hint,
    preview_bytes: Buffer.byteLength(envl.preview ?? "", "utf8"),
    preview_head: (envl.preview ?? "").slice(0, 26),
  };

  // 2. T-READ-01 续页 offset=16384
  let t = Date.now();
  const p1 = parse(await call(client, "read_text", { ref: envl.ref, offset: 16384 }));
  out.page_16384 = {
    ms: Date.now() - t,
    head: p1.text.slice(0, 20),
    expect_head: BIG_BUF.subarray(16384, 16404).toString("utf8"),
    bytes: Buffer.byteLength(p1.text, "utf8"),
    eof: p1.eof,
    total_bytes: p1.total_bytes,
    match: p1.text === BIG_BUF.subarray(16384, 16384 + 16384).toString("utf8"),
  };

  // 3. offset=0 首页
  const p0 = parse(await call(client, "read_text", { ref: envl.ref, offset: 0 }));
  out.page_0 = { match: p0.text === BIG_BUF.subarray(0, 16384).toString("utf8"), eof: p0.eof };

  // 4. 超尾 offset（> 190399）
  const ptail = parse(await call(client, "read_text", { ref: envl.ref, offset: 999999, limit: 4096 }));
  out.page_beyond_eof = { text_empty: ptail.text === "", eof: ptail.eof, total_bytes: ptail.total_bytes };

  // 5. 精确尾页
  const lastOff = Math.floor(BIG_BUF.length / 16384) * 16384;
  const pl = parse(await call(client, "read_text", { ref: envl.ref, offset: lastOff }));
  out.page_last = { offset: lastOff, eof: pl.eof, bytes: Buffer.byteLength(pl.text, "utf8"), tail_match: pl.text.endsWith(LINES[1599]) };

  // 6. 未知 ref
  const pu = parse(await call(client, "read_text", { ref: "@o99" }));
  out.unknown_ref = { has_error: !!pu.error, error: (pu.error ?? "").slice(0, 40), eof: pu.eof };

  // 7. limit 越界（zod 拒绝：callTool 抛错）
  try {
    await call(client, "read_text", { ref: envl.ref, limit: 65537 });
    out.limit_zod = "NOT_REJECTED";
  } catch (e) {
    out.limit_zod = String(e).includes("max") || String(e).includes("less than or equal") ? "rejected" : String(e).slice(0, 80);
  }
  // 7b. ref 格式非法（zod regex）
  try {
    await call(client, "read_text", { ref: "@x1" });
    out.ref_regex = "NOT_REJECTED";
  } catch (e) {
    out.ref_regex = String(e).includes("@o") ? "rejected" : String(e).slice(0, 80);
  }

  // 8. L-COST-13 计时 ×3
  out.lcost13_ms = [];
  for (let i = 0; i < 3; i++) {
    t = Date.now();
    await call(client, "read_text", { ref: envl.ref, offset: 16384 * (i + 1) });
    out.lcost13_ms.push(Date.now() - t);
    await new Promise((r) => setTimeout(r, 200));
  }

  out.ref_for_restart = envl.ref;
} finally {
  await transport.close();
  await new Promise((r) => setTimeout(r, 300));
}

// 9. T-READ-03：重启 server 后旧 ref 失效（进程级 in-memory）
const second = await connect();
try {
  const p = parse(await call(second.client, "read_text", { ref: out.ref_for_restart, offset: 0 }));
  out.after_restart = { has_error: !!p.error, error: (p.error ?? "").slice(0, 40) };
} finally {
  await second.transport.close();
  await new Promise((r) => setTimeout(r, 200));
}

console.log(JSON.stringify(out, null, 1));
