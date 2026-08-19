#!/usr/bin/env node
/** T4a：hidden Chrome(9223) + lasso browse_logged_in 出厂路径（precreateBackgroundTabIfHidden 生效面）
 *  每 op 前后：frontmost / 窗口数 / targets；结束 chrome-stop。 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { frontmost, windowsOfPid, sleep, ts } from "./probe.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const sh = (c, o = {}) => { try { return execSync(c, { encoding: "utf8", timeout: 30000, ...o }).trim(); } catch (e) { return (e.stdout || "") + "|ERR:" + String(e.message).slice(0, 100); } };
const out = { started: ts(), steps: [] };

// ---- 起 hidden Chrome 9223（隔离 profile） ----
const launch1 = sh(`cd ${REPO} && node dist/index.js launch-chrome --port 9223 --profile /tmp/lasso-t4a-profile 2>&1`);
await sleep(3000);
const ledger = JSON.parse(sh(`cat ~/.cache/lasso/launched-chromes.json`) || "[]");
const rec = ledger.find((r) => r.port === 9223);
const chromePid = rec?.pid;
out.chrome = { pid: chromePid, launchMode: rec?.launchMode, out: launch1.slice(0, 200) };
const targetsOf = () => { try { return JSON.parse(sh(`curl -s -m 3 http://localhost:9223/json/list`) || "[]"); } catch { return []; } };
const snap = (label) => ({ t: ts(), label, frontmost: frontmost(), windows: windowsOfPid(chromePid), targets: targetsOf().map((t) => ({ type: t.type, url: (t.url || "").slice(0, 40) })) });

out.pre = snap("pre");
console.log(`[T4a] hidden chrome pid=${chromePid} mode=${rec?.launchMode} windows=${out.pre.windows} frontmost=${out.pre.frontmost} targets=${out.pre.targets.length}`);

// ---- lasso server 指向 9223 ----
const client = new Client({ name: "t4a-logged-in", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node ${REPO}/dist/index.js 2>>${JSON.stringify(path.join(here, "t4a-server-stderr.log"))}`],
  cwd: REPO,
  env: { ...process.env, LASSO_CDP_PORT: "9223" },
});
await client.connect(transport);
const call = async (name, args, timeout = 120000) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  return JSON.parse(r.content[0].text);
};

async function op(label, args) {
  const before = snap(`${label}#before`);
  const t0 = Date.now();
  let res, err;
  try { res = await call("browse_logged_in", args); } catch (e) { err = String(e.message).slice(0, 150); }
  const ms = Date.now() - t0;
  await sleep(400);
  const after = snap(`${label}#after`);
  out.steps.push({ label, ms, err, outcome: res?.outcome ?? null, served_by: res?.served_by ?? res?.retrieval_method ?? null, before: { frontmost: before.frontmost, windows: before.windows, targets: before.targets }, after: { frontmost: after.frontmost, windows: after.windows, targets: after.targets } });
  console.log(`[T4a] ${label} ${ms}ms outcome=${res?.outcome ?? "ERR:" + (err || "").slice(0, 50)} frontmost=${before.frontmost}->${after.frontmost} windows=${before.windows}->${after.windows} targets=${before.targets.length}->${after.targets.length}`);
  await sleep(2000);
  return res;
}

try {
  await op("navigate", { url: "https://example.com", action: "navigate" });
  await op("extract", { url: "https://example.com", action: "extract" });
  await op("evaluate", { url: "https://example.com", action: "evaluate", options: { js: "return {title: document.title, ua: navigator.userAgent.slice(0,30)}" } });
  await op("screenshot", { url: "https://example.com", action: "screenshot" });
} finally {
  await client.close().catch(() => {});
  await sleep(2500);
  out.afterServerClose = snap("after-server-close");
  // TabSession restore：server 退出后 targets 应还原（lasso 自建 tab 被关）
  const stop = sh(`cd ${REPO} && node dist/index.js chrome-stop --port 9223 2>&1`);
  await sleep(2000);
  out.cleanup = { stopOut: stop.slice(0, 200), frontmost: frontmost(), pidAlive: (() => { try { process.kill(chromePid, 0); return true; } catch { return false; } })(), ledger: sh(`cat ~/.cache/lasso/launched-chromes.json`) };
  sh(`rm -rf /tmp/lasso-t4a-profile`);
  fs.writeFileSync(path.join(here, "t4a-result.json"), JSON.stringify(out, null, 2));
  console.log(`[T4a] cleanup: pidAlive=${out.cleanup.pidAlive} ledger=${out.cleanup.ledger.slice(0, 40)} frontmost=${out.cleanup.frontmost}`);
  process.exit(0);
}
