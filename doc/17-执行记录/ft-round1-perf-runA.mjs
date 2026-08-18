#!/usr/bin/env node
/** ft-r11 Part A：L-COST-01..07（搜索链各层）。串行 + 用例间 2s。先做 browse 预热（npx 下载不计入测量）。 */
import { withServer, timedCall, sumSearch, sleep, median } from "./ft-round1-perf-lib.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const Q_EN = "rust tokio tutorial";
const Q_CN = "智谱 GLM API 文档";
const RUNS = 3;

async function runSearch(label, env, args, runs = RUNS) {
  const out = [];
  for (let i = 0; i < runs; i++) {
    await withServer(env, async (c) => { out.push(sumSearch(await timedCall(c, "search", args))); });
    log(label, `run${i + 1}`, JSON.stringify(out[out.length - 1]));
    await sleep(2000);
  }
  const m = median(out.map((o) => o.ms));
  log(label, "MEDIAN_MS=" + m, "results=" + (out[0].results ?? "-"), "served_by=" + out[0].served_by);
  return { label, median: m, runs: out };
}

async function runIncrement(label, env, query, cb) {
  const out = [];
  for (let i = 0; i < RUNS; i++) {
    await withServer(env, async (c) => {
      const fill = sumSearch(await timedCall(c, "search", { query, limit: 10, no_cache: true }));
      await sleep(2000);
      const base = sumSearch(await timedCall(c, "search", { query, limit: 10 }));
      await sleep(2000);
      const withCb = sumSearch(await timedCall(c, "search", { query, limit: 10, content_blocks: cb }));
      out.push({ fill, base, withCb, increment: withCb.ms - base.ms });
    });
    const r = out[out.length - 1];
    log(label, `run${i + 1}`, `fill=${fill_ms(r)}ms base=${r.base.ms}ms cb=${r.withCb.ms}ms inc=${r.increment}ms cb_chars=${r.withCb.content_chars} cs=${JSON.stringify(r.withCb.content_status)}`);
    function fill_ms(r) { return r.fill.ms; }
    await sleep(2000);
  }
  log(label, "MEDIAN_INCREMENT_MS=" + median(out.map((o) => o.increment)));
  return { label, median: median(out.map((o) => o.increment)), runs: out.map(({ increment, base, withCb }) => ({ inc: increment, base: base.ms, cb: withCb.ms, chars: withCb.content_chars, cs: withCb.content_status })) };
}

// ---------- 预热：browse_headless（npx 下载 chrome-devtools-mcp@1.7.0，不计入测量） ----------
log("warmup browse_headless start (npx cache fill)...");
await withServer({}, async (c) => {
  const r = await timedCall(c, "browse_headless", { url: "https://example.com", action: "snapshot" }, 240000);
  log("warmup ms=" + r.ms, "isError=" + r.isError, (r.p?.data?.outcome ?? r.p?.outcome ?? r.threw ?? ""));
});
await sleep(2000);

const results = {};
// L-COST-01 第一跳 machine_mcp
results["L-COST-01"] = await runSearch("L01-machine_mcp", {}, { query: Q_EN, limit: 10, no_cache: true });
// L-COST-02 serp_http EN（禁 machine_mcp → 级联 ddg→brave）
results["L-COST-02"] = await runSearch("L02-serp_http-EN", { LASSO_MACHINE_CLAUDE_JSON_PATH: "/nonexistent" }, { query: Q_EN, limit: 10, no_cache: true });
// L-COST-03 serp_http CN（baidu）
results["L-COST-03"] = await runSearch("L03-serp_http-CN", { LASSO_MACHINE_CLAUDE_JSON_PATH: "/nonexistent" }, { query: Q_CN, limit: 10, no_cache: true });
// L-COST-05/06/07 第二跳增量（cache-hit 基线法）
results["L-COST-05"] = await runIncrement("L05-cb3-EN", {}, Q_EN, 3);
results["L-COST-06"] = await runIncrement("L06-cb5-EN", {}, Q_EN, 5);
results["L-COST-07"] = await runIncrement("L07-cb3-CN", {}, Q_CN, 3);

console.log("\n=== SUMMARY PART A ===");
for (const [k, v] of Object.entries(results)) console.log(k, "median_ms=" + v.median, JSON.stringify(v.runs?.map ? v.runs.map((x) => x.ms ?? x.inc) : v.runs));
