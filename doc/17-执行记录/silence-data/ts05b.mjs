#!/usr/bin/env node
/** T-SILENCE-05b 复核轮 — PID 级 frontmost 轮询（150ms）分辨「焦点转移来源」：
 * 若 frontmost 变更指向替身 pid / 本测试 spawn 的任何 pid → 产品缺陷；
 * 若指向与测试无关的 pid（如用户自己的 Chrome 2420）→ 用户自发活动（环境事件）。
 * 同时记录替身窗口计数 + 用户 Chrome 窗口计数轨迹 + stderr 全文落盘。 */
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
const PORT = Number(process.env.TS05_PORT ?? 9233);
const USER_CHROME_PID = Number(process.env.USER_CHROME_PID ?? 2420);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NAV_URL = "https://example.com/?silence=05b";
const sh = (args) => spawnSync("osascript", args, { encoding: "utf8" }).stdout.trim();
const fmPid = () => sh(["-e", 'tell application "System Events" to get unix id of first application process whose frontmost is true']);
const fmName = (pid) => sh(["-e", `tell application "System Events" to get name of (first application process whose unix id is ${pid})`]);
const winOf = (pid) => Number(sh(["-e", `tell application "System Events" to count windows of (first application process whose unix id is ${pid})`]) || "NaN");
const httpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const listPages = async () => (await httpJson("/json/list")).filter((t) => t.type === "page");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = { case: ["T-SILENCE-05b"], port: PORT, fm_trace: [], user_chrome_win_trace: [] };
result.baseline = { pid: Number(fmPid()), at: new Date().toISOString() };
result.baseline.name = fmName(result.baseline.pid);

// ---------- 替身 ----------
const profileDir = mkdtempSync(path.join(tmpdir(), "lasso-ts05b-"));
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
const userTabA = (await cdp("Target.createTarget", { url: "https://example.org/", background: true })).targetId;
const userTabB = (await cdp("Target.createTarget", { url: "https://example.com/", background: true })).targetId;
await sleep(800);
result.tabs_before = (await listPages()).map((t) => ({ id: t.id.slice(0, 8), url: t.url }));
result.user_tabs_before = { a: (await listPages()).find((t) => t.id === userTabA)?.url, b: (await listPages()).find((t) => t.id === userTabB)?.url };
result.fm_after_setup = Number(fmPid());

// ---------- PID 级轮询（150ms） ----------
const MY_PIDS = new Set([SUB_PID]);
let polling = true;
const poll = setInterval(() => {
  const pid = Number(fmPid());
  result.fm_trace.push({ t: Date.now(), pid, isSubstitute: pid === SUB_PID, isMine: MY_PIDS.has(pid) });
}, 150);
const winPoll = setInterval(() => {
  result.user_chrome_win_trace.push({ t: Date.now(), wins: winOf(USER_CHROME_PID), subWins: winOf(SUB_PID) });
}, 500);

// ---------- lasso server ----------
const transport = new StdioClientTransport({
  command: "node", args: [path.join(repoRoot, "dist/index.js")], cwd: repoRoot, stderr: "pipe",
  env: { ...process.env, LASSO_CDP_PORT: String(PORT) },
});
const client = new Client({ name: "silence-ts05b", version: "1.0.0" }, { capabilities: {} });
let stderrText = "";
await client.connect(transport);
transport.stderr?.on("data", (d) => { stderrText += d.toString(); });
const serverPid = transport._process?.pid;
if (serverPid) MY_PIDS.add(serverPid);

const t0 = Date.now();
const res = await client.callTool({ name: "browse_logged_in",
  arguments: { url: NAV_URL, action: "navigate" } }, undefined, { timeout: 120000 });
result.nav = { ok: !res.isError, ms: Date.now() - t0 };
await sleep(1500);

const pagesAfter = await listPages();
result.user_tabs_after = {
  a: pagesAfter.find((t) => t.id === userTabA)?.url, b: pagesAfter.find((t) => t.id === userTabB)?.url,
};
result.own_tab_url_after = pagesAfter.find((t) => t.url.includes("silence=05b"))?.url ?? null;
result.tab_counts = [result.tabs_before.length, pagesAfter.length];
result.F1_user_tabs_unchanged = result.user_tabs_before.a === result.user_tabs_after.a && result.user_tabs_before.b === result.user_tabs_after.b;
result.F1_nav_on_own_tab = result.own_tab_url_after === NAV_URL || (result.own_tab_url_after ?? "").startsWith("https://example.com/?silence=05b");

// ---------- 关闭 + restore ----------
await client.close();
await sleep(2500);
result.tabs_after_restore = (await listPages()).map((t) => ({ id: t.id.slice(0, 8), url: t.url }));
result.restore_own_tab_gone = !result.tabs_after_restore.some((t) => t.url.includes("silence=05b"));

// ---------- 焦点轨迹分析 ----------
clearInterval(poll); clearInterval(winPoll);
const baselinePid = result.baseline.pid;
const foreignTransitions = [];
for (const s of result.fm_trace) {
  if (s.pid !== baselinePid && !foreignTransitions.some((f) => f.pid === s.pid)) foreignTransitions.push(s);
}
result.focus_analysis = {
  baseline_pid: baselinePid,
  samples: result.fm_trace.length,
  distinct_foreign_pids: foreignTransitions.map((f) => ({
    pid: f.pid, name: fmName(f.pid), isSubstitute: f.pid === SUB_PID, isMine: MY_PIDS.has(f.pid),
    first_seen_at_ms: f.t - t0,
  })),
  any_test_pid_became_frontmost: result.fm_trace.some((s) => MY_PIDS.has(s.pid)),
};

// 若焦点仍在替身（意外）→ 还原到基线 app
const finalPid = Number(fmPid());
if (finalPid === SUB_PID) {
  spawnSync("osascript", ["-e", `tell application (first application process whose unix id is ${baselinePid}) to activate`]);
  result.focus_restored = true;
}

// ---------- 清理 ----------
try { ws.close(); } catch {}
try { process.kill(-SUB_PID, "SIGKILL"); } catch { try { chrome.kill("SIGKILL"); } catch {} }
await sleep(800);
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
result.cleanup_port_freed = await (async () => { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return false; } catch { return true; } })();
fs.writeFileSync(path.join(here, "ts05b-stderr.log"), stderrText);
fs.writeFileSync(path.join(here, "ts05b-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  baseline: result.baseline, substitute_pid: SUB_PID, server_pid: serverPid,
  nav: result.nav, F1_user_tabs_unchanged: result.F1_user_tabs_unchanged, F1_nav_on_own_tab: result.F1_nav_on_own_tab,
  tab_counts: result.tab_counts, restore_own_tab_gone: result.restore_own_tab_gone,
  focus_analysis: result.focus_analysis,
  user_chrome_win_first_last: [result.user_chrome_win_trace[0], result.user_chrome_win_trace.at(-1)],
  cleanup_port_freed: result.cleanup_port_freed,
}, null, 2));
process.exit(0);
