#!/usr/bin/env node
/** T1 纯查询通道静默性真机验证：search / fetch_url / fetch_feed / search_local
 *  纪律：串行 + 2s 间隔；每 op 前后采 frontmost/窗口/Dock/资源；结束清理。 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { frontmost, windowsOfPid, chromeAsns, chromiumTreeSum, cpuPeakSampler, sleep, ts, portAlive } from "./probe.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const stderrLog = path.join(here, "t1-server-stderr.log");
const out = { meta: { started: ts(), env_note: "engine=auto 默认；机器 key 来自 ~/.claude.json" }, ops: [], notes: [] };

// ---------- 起 lasso server（MCP stdio） ----------
const client = new Client({ name: "t1-silence-verify", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node ${JSON.stringify("/Users/wangdong/Documents/Project/cc-control-all/lasso/dist/index.js")} 2>>${JSON.stringify(stderrLog)}`],
  cwd: "/Users/wangdong/Documents/Project/cc-control-all/lasso",
  env: { ...process.env },
});
await client.connect(transport);
const serverPid = transport.pid ?? Number(execSync("pgrep -f 'dist/index.js$' | tail -1").toString().trim());
out.meta.serverPid = serverPid;

const call = async (name, args, timeout = 90000) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  return JSON.parse(r.content[0].text);
};

function fullSample(label) {
  return {
    t: ts(),
    label,
    frontmost: frontmost(),
    userChromeWindows: windowsOfPid(2420),
    asn: (() => { const a = chromeAsns(); return { raw: a.raw_grep_count, fg: a.chromeForeground, cdm: a.cdmEntries }; })(),
    lassoTree: (() => { const s = chromiumTreeSum("user-data-dir.*lasso|chrome-devtools-mcp@1.7.0"); return { procs: s.procs, rssKb: s.rssKb }; })(),
  };
}

async function runOp(label, fn) {
  const before = fullSample(`${label}#before`);
  const sampler = cpuPeakSampler(serverPid, 120);
  const t0 = Date.now();
  let result = null,
    err = null;
  try { result = await fn(); } catch (e) { err = String(e.message).slice(0, 200); }
  const ms = Date.now() - t0;
  const peak = sampler.stop();
  await sleep(300);
  const after = fullSample(`${label}#after`);
  out.ops.push({
    label, ms, err,
    result_brief: result ? {
      outcome: result.outcome ?? result.status ?? null,
      served_by: result.served_by ?? result.engine ?? null,
      keys: Object.keys(result).slice(0, 12),
      n: result.data?.results?.length ?? result.results?.length ?? (Array.isArray(result.data) ? result.data.length : null) ?? null,
    } : null,
    before, after,
    serverCpuPeak: { maxPcpu: peak.maxPcpu, maxRssKb: peak.maxRssKb, samples: peak.samples },
  });
  console.log(`[T1] ${label}: ${ms}ms err=${err ? err.slice(0, 60) : "none"} frontmost=${after.frontmost} cpuPeak=${peak.maxPcpu}%`);
  await sleep(2000);
}

out.baseline = fullSample("baseline");
console.log(`[T1] baseline frontmost=${out.baseline.frontmost} asn=${JSON.stringify(out.baseline.asn)}`);

try {
  await runOp("search", () => call("search", { query: "lasso mcp npm", limit: 3 }));
  await runOp("fetch_url", () => call("fetch_url", { url: "https://example.com" }));
  await runOp("fetch_feed", () => call("fetch_feed", { url: "https://hnrss.org/frontpage" }));
  await runOp("search_local", () => call("search_local", { query: "lasso", limit: 5 }));
} finally {
  await client.close().catch(() => {});
  await sleep(2500);
  out.final = fullSample("final(after server close)");
  out.residual = {
    chromiumTreeLasso: chromiumTreeSum("user-data-dir.*lasso|chrome-devtools-mcp@1.7.0"),
    serverAlive: (() => { try { process.kill(serverPid, 0); return true; } catch { return false; } })(),
  };
  fs.writeFileSync(path.join(here, "t1-result.json"), JSON.stringify(out, null, 2));
  console.log(`[T1] done. final frontmost=${out.final.frontmost} residual=${JSON.stringify(out.residual.chromiumTreeLasso)}`);
  process.exit(0);
}
