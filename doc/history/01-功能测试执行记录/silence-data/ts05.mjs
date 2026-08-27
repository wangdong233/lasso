#!/usr/bin/env node
/** T-SILENCE-05 执行器 — F-1 验收：连「用户 Chrome」browse_logged_in 不劫持 pages[0]。
 * 环境：替身用户 Chrome（隔离临时 profile + --no-startup-window + --mute-audio，不经 lasso 起
 * = 无台账记录 → 走 F-1 ensureOwnPageSelected 路径）+ CDP WS 预置 2 个用户 tab。
 * 断言：①navigate 前后 pages[0] URL 不变（F-1 核心）②frontmost 不变 ③navigate 落自建 tab
 * ④stderr 有 logged_in_own_page_selected ⑤SIGTERM 后 restore 只关自建 tab。 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const { frontmost, chromeAsns, sleep } = await import(
  path.join(repoRoot, "doc/27-静默性全面审计/verify-data/probe.mjs")
);
const PORT = Number(process.env.TS05_PORT ?? 9233);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NAV_URL = "https://example.com/?silence=05";
const httpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const listPages = async () => (await httpJson("/json/list")).filter((t) => t.type === "page");

const result = { case: ["T-SILENCE-05"], port: PORT };
result.fm_baseline = frontmost();

// ---------- 1. 替身用户 Chrome（非台账） ----------
const profileDir = mkdtempSync(path.join(tmpdir(), "lasso-ts05-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  "--no-startup-window", "--mute-audio", "--no-first-run", "--no-default-browser-check",
], { detached: true, stdio: "ignore" });
chrome.unref();
result.substitute_pid = chrome.pid;
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try { await httpJson("/json/version"); ready = true; break; } catch {}
}
if (!ready) { console.error("substitute_chrome_not_ready"); process.exit(1); }

// ---------- 2. 预置 2 个用户 tab（WS createTarget background:true 零激活） ----------
const { WebSocket } = await import(path.join(repoRoot, "node_modules/undici/index.js"));
const ver = await httpJson("/json/version");
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
  if (typeof msg.id !== "number") return;
  const p = pending.get(msg.id); if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
});
const cdp = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const mkTab = async (url) => (await cdp("Target.createTarget", { url, background: true })).targetId;
const userTabA = await mkTab("https://example.org/");   // pages[0]（用户首 tab）
const userTabB = await mkTab("https://example.com/");
await sleep(800);
result.tabs_before = (await listPages()).map((t) => ({ id: t.id.slice(0, 8), url: t.url }));
result.pages0_url_before = (await listPages())[0]?.url;
result.user_tab_a_url_before = (await listPages()).find((t) => t.id === userTabA)?.url;
result.user_tab_b_url_before = (await listPages()).find((t) => t.id === userTabB)?.url;
result.fm_after_setup = frontmost();

// ---------- 3. 真 lasso dist server + browse_logged_in navigate ----------
const client = new Client({ name: "silence-ts05", version: "1.0.0" }, { capabilities: {} });
let stderrText = "";
const transport = new StdioClientTransport({
  command: "node", args: [path.join(repoRoot, "dist/index.js")], cwd: repoRoot, stderr: "pipe",
  env: { ...process.env, LASSO_CDP_PORT: String(PORT) },
});
await client.connect(transport);
transport.stderr?.on("data", (d) => { stderrText += d.toString(); });

const t0 = Date.now();
let navOk = null, navPreview = "";
try {
  const res = await client.callTool({ name: "browse_logged_in",
    arguments: { url: NAV_URL, action: "navigate" } }, undefined, { timeout: 120000 });
  navOk = !res.isError;
  navPreview = JSON.stringify(res.structuredContent ?? res.content?.[0]?.text ?? "").slice(0, 160);
} catch (e) { navOk = false; navPreview = String(e.message).slice(0, 160); }
result.nav = { ok: navOk, ms: Date.now() - t0, preview: navPreview };
result.fm_immediate_after_nav = frontmost();
await sleep(1000);
result.fm_1s_after_nav = frontmost();

// ---------- 4. 核心断言：pages[0] 不变 + 自建 tab 承接 navigate ----------
await sleep(500);
const pagesAfter = await listPages();
result.tabs_after_nav = pagesAfter.map((t) => ({ id: t.id.slice(0, 8), url: t.url }));
result.pages0_url_after = pagesAfter[0]?.url;
result.user_tab_a_url_after = pagesAfter.find((t) => t.id === userTabA)?.url;
result.user_tab_b_url_after = pagesAfter.find((t) => t.id === userTabB)?.url;
result.own_tab_url_after = pagesAfter.find((t) => t.url.includes("silence=05"))?.url ?? null;
result.tab_count_before_after = [result.tabs_before.length, pagesAfter.length];
result.F1_CORE_pages0_unchanged = result.pages0_url_before === result.pages0_url_after;
result.F1_user_tabs_unchanged =
  result.user_tab_a_url_before === result.user_tab_a_url_after &&
  result.user_tab_b_url_before === result.user_tab_b_url_after;
result.log_has_own_page_selected = /logged_in_own_page_selected/.test(stderrText);
result.log_own_page_lines = stderrText.split("\n").filter((l) => /logged_in_own_page/.test(l)).slice(0, 3);

// ---------- 5. SIGTERM → restore 只关自建 tab ----------
const serverPid = transport._process?.pid;
await client.close(); // SIGTERM → 优雅停机含 restoreTabs
await sleep(2500);
result.tabs_after_restore = (await listPages()).map((t) => ({ id: t.id.slice(0, 8), url: t.url }));
result.restore_user_tabs_survive =
  result.tabs_after_restore.filter((t) => t.url.startsWith("https://example.org/") || t.url.startsWith("https://example.com/")).length;
result.restore_own_tab_gone = !result.tabs_after_restore.some((t) => t.url.includes("silence=05"));
result.fm_final = frontmost();
result.fg_asn_final = chromeAsns().chromeForeground;

// ---------- 6. 清理 ----------
try { ws.close(); } catch {}
try { process.kill(-chrome.pid, "SIGKILL"); } catch { try { chrome.kill("SIGKILL"); } catch {} }
await sleep(800);
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
result.cleanup_port_freed = await (async () => { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return false; } catch { return true; } })();
const { spawnSync } = await import("node:child_process");
result.cleanup_residual = spawnSync("pgrep", ["-f", `user-data-dir=${profileDir}`], { encoding: "utf8" }).stdout.trim();
fs.writeFileSync(path.join(here, "ts05-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  fm: `${result.fm_baseline} | after_nav ${result.fm_immediate_after_nav}/${result.fm_1s_after_nav} | final ${result.fm_final}`,
  nav: result.nav,
  pages0: `${result.pages0_url_before} -> ${result.pages0_url_after}`,
  F1_CORE_pages0_unchanged: result.F1_CORE_pages0_unchanged,
  F1_user_tabs_unchanged: result.F1_user_tabs_unchanged,
  own_tab_url_after: result.own_tab_url_after,
  tab_count: result.tab_count_before_after,
  log_has_own_page_selected: result.log_has_own_page_selected,
  tabs_after_restore: result.tabs_after_restore,
  restore_own_tab_gone: result.restore_own_tab_gone,
  cleanup_port_freed: result.cleanup_port_freed,
}, null, 2));
process.exit(0);
