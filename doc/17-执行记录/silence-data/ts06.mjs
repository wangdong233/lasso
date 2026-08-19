#!/usr/bin/env node
/** T-SILENCE-06 执行器 — F-2 验收：close_page 登记制所有权。
 * 12 个用户 tab（> LRU cap 10）+ browse_logged_in navigate（触发 reconcile——close_page
 * 唯一调用面）→ 断言 12 用户 tab 全数存活 URL 不变；自建 tab 是唯一新增；
 * SIGTERM restore 只关自建 tab。PID 级 frontmost 轮询同 ts05b。 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const PORT = Number(process.env.TS06_PORT ?? 9234);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NAV_URL = "https://example.com/?silence=06";
const sh = (args) => spawnSync("osascript", args, { encoding: "utf8" }).stdout.trim();
const fmPid = () => Number(sh(["-e", 'tell application "System Events" to get unix id of first application process whose frontmost is true']));
const httpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const listPages = async () => (await httpJson("/json/list")).filter((t) => t.type === "page");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = { case: ["T-SILENCE-06"], port: PORT, fm_trace: [] };
const baselinePid = fmPid();
result.baseline_pid = baselinePid;

// ---------- 替身 + 12 用户 tab ----------
const profileDir = mkdtempSync(path.join(tmpdir(), "lasso-ts06-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  "--no-startup-window", "--mute-audio", "--no-first-run", "--no-default-browser-check",
], { detached: true, stdio: "ignore" });
chrome.unref();
const SUB_PID = chrome.pid;
result.substitute_pid = SUB_PID;
for (let i = 0; i < 40; i++) { await sleep(250); try { await httpJson("/json/version"); break; } catch {} }

const { WebSocket } = await import(path.join(repoRoot, "node_modules/undici/index.js"));
const ver = await httpJson("/json/version");
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
  if (typeof msg.id !== "number") return;
  const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
});
const cdp = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const userTabIds = [];
for (let i = 1; i <= 12; i++) {
  const tid = (await cdp("Target.createTarget", { url: `https://example.org/?u=${i}`, background: true })).targetId;
  userTabIds.push(tid);
}
await sleep(1200);
const before = await listPages();
result.user_tabs_before = userTabIds.map((id) => before.find((t) => t.id === id)?.url);
result.user_tab_count_before = result.user_tabs_before.filter(Boolean).length;

// ---------- PID 级轮询 ----------
const MY_PIDS = new Set([SUB_PID]);
const poll = setInterval(() => {
  const pid = fmPid();
  result.fm_trace.push({ t: Date.now(), pid, isMine: MY_PIDS.has(pid) });
}, 200);

// ---------- lasso server + navigate（第二次也触发 reconcile 热路径） ----------
const transport = new StdioClientTransport({
  command: "node", args: [path.join(repoRoot, "dist/index.js")], cwd: repoRoot, stderr: "pipe",
  env: { ...process.env, LASSO_CDP_PORT: String(PORT) },
});
const client = new Client({ name: "silence-ts06", version: "1.0.0" }, { capabilities: {} });
let stderrText = "";
await client.connect(transport);
transport.stderr?.on("data", (d) => { stderrText += d.toString(); });
if (transport._process?.pid) MY_PIDS.add(transport._process.pid);

for (const url of [NAV_URL, "https://example.com/?silence=06b"]) {
  const t0 = Date.now();
  const res = await client.callTool({ name: "browse_logged_in",
    arguments: { url, action: "navigate" } }, undefined, { timeout: 120000 });
  result.navi = result.navi ?? [];
  result.navi.push({ url, ok: !res.isError, ms: Date.now() - t0 });
  await sleep(1500);
}

const after = await listPages();
result.user_tabs_after_navi = userTabIds.map((id) => after.find((t) => t.id === id)?.url);
result.user_tab_count_after = result.user_tabs_after_navi.filter(Boolean).length;
result.F2_user_tabs_all_survive = JSON.stringify(result.user_tabs_before) === JSON.stringify(result.user_tabs_after_navi);
result.own_tabs_after = after.filter((t) => t.url.includes("silence=06")).map((t) => t.url);
result.total_tabs_after = after.length;

// ---------- SIGTERM restore ----------
await client.close();
await sleep(2500);
const restored = await listPages();
result.tabs_after_restore_urls = restored.map((t) => t.url);
result.restore_user_tab_count = userTabIds.filter((id) => restored.some((t) => t.id === id)).length;
result.restore_own_tabs_gone = restored.every((t) => !t.url.includes("silence=06"));

clearInterval(poll);
result.focus_analysis = {
  baseline_pid: baselinePid, samples: result.fm_trace.length,
  foreign_pids: [...new Set(result.fm_trace.filter((s) => s.pid !== baselinePid).map((s) => s.pid))],
  any_test_pid_frontmost: result.fm_trace.some((s) => MY_PIDS.has(s.pid)),
};
result.log_own_page_selected_count = (stderrText.match(/logged_in_own_page_selected/g) ?? []).length;
result.log_reconcile_events = stderrText.split("\n").filter((l) => /tab_re|close_page|reaped/.test(l)).slice(0, 5);

// ---------- 清理 ----------
try { ws.close(); } catch {}
try { process.kill(-SUB_PID, "SIGKILL"); } catch { try { chrome.kill("SIGKILL"); } catch {} }
await sleep(800);
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
result.cleanup_port_freed = await (async () => { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return false; } catch { return true; } })();
fs.writeFileSync(path.join(here, "ts06-stderr.log"), stderrText);
fs.writeFileSync(path.join(here, "ts06-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  user_tab_count: `${result.user_tab_count_before} -> ${result.user_tab_count_after} (restore: ${result.restore_user_tab_count})`,
  F2_user_tabs_all_survive: result.F2_user_tabs_all_survive,
  urls_unchanged_check: result.user_tabs_before.every((u, i) => u === result.user_tabs_after_navi[i]),
  own_tabs_after: result.own_tabs_after, total_tabs_after: result.total_tabs_after,
  restore_own_tabs_gone: result.restore_own_tabs_gone,
  navi: result.navi, focus_analysis: result.focus_analysis,
  log_own_page_selected_count: result.log_own_page_selected_count,
  cleanup_port_freed: result.cleanup_port_freed,
}, null, 2));
process.exit(0);
