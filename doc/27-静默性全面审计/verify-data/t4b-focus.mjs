#!/usr/bin/env node
/** T4b（S-8 主实验）：可见窗口 Chrome(9233, 隔离 profile) = 「用户自开 Chrome」安全替身
 *  前台先切 Finder → 连 chrome-devtools-mcp@1.7.0 --browser-url（lasso 同款上游）
 *  逐操作采样 frontmost/窗口/targets；含三个阳性对照（new_page 默认前台 / 裸 CDP createTarget 默认 /
 *  select_page bringToFront）+ S-7 tab 劫持 diff + S-9 焦点仿真 hasFocus 前后对照。
 *  结束：还原前台 Windows App + chrome-stop + 删 profile。 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { frontmost, windowsOfPid, sleep, ts } from "./probe.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const sh = (c, o = {}) => { try { return execSync(c, { encoding: "utf8", timeout: 60000, ...o }).trim(); } catch (e) { return (e.stdout || "") + "|ERR:" + String(e.message).slice(0, 150); } };
const out = { started: ts(), steps: [] };

// ---------- 裸 CDP 客户端（node24 全局 WebSocket） ----------
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m); }
      else if (m.method && this.handlers.has(m.method)) this.handlers.get(m.method)(m.params); }); }
  static async connect(wsUrl) { const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }); return new Cdp(ws); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve) => { this.pending.set(id, { resolve }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { this.ws.close(); }
}
const jsonList = (p) => JSON.parse(sh(`curl -s -m 3 http://localhost:${p}/json/list`) || "[]");
const jsonVersion = (p) => JSON.parse(sh(`curl -s -m 3 http://localhost:${p}/json/version`) || "{}");
async function evalOnPage(port, urlSubstr, expr) {
  const t = jsonList(port).find((t) => t.type === "page" && (t.url || "").includes(urlSubstr));
  if (!t) return { err: "no_target:" + urlSubstr };
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  c.close();
  return r.result?.result?.value ?? { err: JSON.stringify(r).slice(0, 120) };
}

// ---------- 1. 起 visible Chrome 9233 ----------
const launch = sh(`cd ${REPO} && LASSO_LAUNCH_MODE=visible node dist/index.js launch-chrome --port 9233 --profile /tmp/lasso-t4b-profile 2>&1`);
await sleep(3500);
const rec = JSON.parse(sh(`cat ~/.cache/lasso/launched-chromes.json`) || "[]").find((r) => r.port === 9233);
const chromePid = rec?.pid;
const snap = (label) => ({ t: ts(), label, frontmost: frontmost(), windows: windowsOfPid(chromePid), targets: jsonList(9233).filter((t) => t.type === "page").map((t) => (t.url || "").slice(0, 48)) });
out.chrome = { pid: chromePid, mode: rec?.launchMode, launchOut: launch.slice(0, 200), atLaunch: snap("visible-launch") };
console.log(`[T4b] visible chrome pid=${chromePid} windows=${out.chrome.atLaunch.windows} frontmost=${out.chrome.atLaunch.frontmost} targets=${JSON.stringify(out.chrome.atLaunch.targets)}`);

// ---------- 2. 预置 tabA(example.com 前台) + tabB(example.org 后台) ----------
const browserWs = jsonVersion(9233).webSocketDebuggerUrl;
const bcdp = await Cdp.connect(browserWs);
// tabA：把现有首个 page 导到 example.com
const firstPage = jsonList(9233).find((t) => t.type === "page");
const acdp = await Cdp.connect(firstPage.webSocketDebuggerUrl);
await acdp.send("Page.navigate", { url: "https://example.com" });
await sleep(1500); acdp.close();
// tabB：后台建
const mkB = await bcdp.send("Target.createTarget", { url: "https://example.org", background: true });
await sleep(1200);
out.tabs = { tabA: "example.com", tabB_targetId: mkB.result?.targetId, after: snap("tabs-ready") };
console.log(`[T4b] tabs ready: ${JSON.stringify(out.tabs.after.targets)} windows=${out.tabs.after.windows}`);

// ---------- 3. S-9(a) 前测：tabB hasFocus ----------
out.s9_pre = await evalOnPage(9233, "example.org", "document.hasFocus()");
console.log(`[T4b] S-9 pre: tabB(example.org, 后台) document.hasFocus() = ${out.s9_pre}`);

// ---------- 4. 前台切 Finder ----------
sh(`osascript -e 'tell application "System Events" to set frontmost of process "Finder" to true'`);
await sleep(800);
out.finderFront = frontmost();
console.log(`[T4b] frontmost now: ${out.finderFront} (期望 Finder)`);

// ---------- 5. 连 cdm（lasso 同款上游 spawn） ----------
const cdm = new Client({ name: "t4b-s8", version: "1.0.0" });
const cdmT = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec npx -y chrome-devtools-mcp@1.7.0 --browser-url=http://localhost:9233 2>>${JSON.stringify(path.join(here, "t4b-cdm-stderr.log"))}`],
  cwd: REPO, env: { ...process.env },
});
const t0 = Date.now();
await cdm.connect(cdmT);
await sleep(500);
out.connect = { ms: Date.now() - t0, frontmostAfterConnect: frontmost(), s9_post: await evalOnPage(9233, "example.org", "document.hasFocus()") };
console.log(`[T4b] cdm connected ${out.connect.ms}ms frontmost=${out.connect.frontmostAfterConnect} S-9 post: tabB hasFocus()=${out.connect.s9_post}`);

const tl = await cdm.listTools();
out.cdmTools = tl.tools.map((t) => t.name);
const call = async (name, args, timeout = 60000) => { const r = await cdm.callTool({ name, arguments: args }, undefined, { timeout }); return r; };

// ---------- 逐操作 ----------
async function step(label, fn, { raw = false } = {}) {
  const before = snap(`${label}#before`);
  const s = Date.now();
  let res, err;
  try { res = await fn(); } catch (e) { err = String(e.message).slice(0, 200); }
  const ms = Date.now() - s;
  const immediate = frontmost();
  await sleep(1000);
  const late = frontmost();
  const after = snap(`${label}#after`);
  const rec_ = { label, ms, err, frontmost: { before: before.frontmost, immediate, late, after: after.frontmost }, windows: { before: before.windows, after: after.windows }, targetsBefore: before.targets, targetsAfter: after.targets, resBrief: null };
  out.steps.push(rec_);
  console.log(`[T4b] ${label} ${ms}ms err=${err ? err.slice(0, 60) : "none"} frontmost ${before.frontmost} → imm=${immediate} late=${late} | win ${before.windows}->${after.windows} | pages ${before.targets.length}->${after.targets.length}`);
  await sleep(2000);
  return { rec: rec_, res };
}

// a. navigate_page（S-7 观察：哪个 tab 被换）
const nav = await step("navigate_page", () => call("navigate_page", { url: "https://example.com/?s8=nav" }));
// b. take_snapshot
const snapRes = await step("take_snapshot", () => call("take_snapshot", {}));
let snapText = "";
try { snapText = (snapRes.res.content ?? []).map((c) => c.text ?? "").join("\n"); } catch {}
const linkUid = (snapText.match(/- link \[([^\]]+)\][^]*?uid: (\d+)/) || [])[2] ?? (snapText.match(/uid: (\d+)[^\n]*link/) || [])[1] ?? null;
out.snapshotFind = { len: snapText.length, linkUid, linkCtx: (snapText.match(/[^\n]*More information[^\n]*/) || [])[0]?.slice(0, 120) ?? null };
console.log(`[T4b] snapshot len=${snapText.length} linkUid=${linkUid} ctx=${out.snapshotFind.linkCtx}`);
// c. click（example.com 的 More information 链接 → iana.org）
if (linkUid) await step("click", () => call("click", { uid: linkUid }));
// d. navigate 到 duckduckgo（为 fill 准备输入框）
await step("navigate_page#ddg", () => call("navigate_page", { url: "https://duckduckgo.com/?q=hello" }));
const snapRes2 = await step("take_snapshot#ddg", () => call("take_snapshot", {}));
let snap2 = "";
try { snap2 = (snapRes2.res.content ?? []).map((c) => c.text ?? "").join("\n"); } catch {}
const inputUid = (snap2.match(/- textbox[^\n]*\n?[^\n]*uid: (\d+)/) || [])[1] ?? (snap2.match(/uid: (\d+)[^\n]*(?:textbox|search)/i) || [])[1] ?? null;
out.ddgFind = { len: snap2.length, inputUid, ctx: (snap2.match(/[^\n]*searchbox[^\n]*/i) || [])[0]?.slice(0, 120) ?? null };
console.log(`[T4b] ddg snapshot len=${snap2.length} inputUid=${inputUid}`);
// e. fill
if (inputUid) await step("fill", () => call("fill", { uid: inputUid, value: "lasso silence test" }));
// f. evaluate_script
await step("evaluate_script", () => call("evaluate_script", { function: "() => ({title: document.title, focused: document.hasFocus()})" }));
// g. take_screenshot
await step("take_screenshot", () => call("take_screenshot", { format: "png" }));
// h. wait_for
await step("wait_for", () => call("wait_for", { text: "lasso silence test", timeout: 3000 }));
// i. list_pages
const lp = await step("list_pages", () => call("list_pages", {}));
let lpText = ""; try { lpText = (lp.res.content ?? []).map((c) => c.text ?? "").join("\n"); } catch {}
out.listPagesBrief = lpText.slice(0, 400);
// j. 阳性对照1：new_page（上游默认 background:false = 前台开 tab；lasso 零调用的激活原语）
await step("POSITIVE:new_page(default fg)", () => call("new_page", { url: "https://example.org/?np=1" }));
// k. 阳性对照2：裸 CDP Target.createTarget 默认（不带 background）
await step("POSITIVE:cdp.createTarget(default)", async () => { await bcdp.send("Target.createTarget", { url: "about:blank?pos2" }); });
// l. 阴性对照：裸 CDP Target.createTarget {background:true}（lasso precreate 同款）
await step("NEGATIVE:cdp.createTarget{bg:true}", async () => { await bcdp.send("Target.createTarget", { url: "about:blank?neg", background: true }); });
// m. 阳性对照3：select_page bringToFront（INV-78d 禁的原语；验方法灵敏度）
await step("POSITIVE:select_page{bringToFront}", () => call("select_page", { pageIdx: 0, bringToFront: true }));

// ---------- 6. S-9(c)：断开 cdm 后仿真是否回滚 ----------
await cdm.close().catch(() => {});
await sleep(2500);
out.s9_afterDisconnect = await evalOnPage(9233, "example.org", "document.hasFocus()");
out.frontAfterCdmClose = frontmost();
console.log(`[T4b] S-9 after cdm close: tabB hasFocus()=${out.s9_afterDisconnect} frontmost=${out.frontAfterCdmClose}`);

// ---------- 7. 收尾：还原前台 + chrome-stop ----------
sh(`osascript -e 'tell application "System Events" to set frontmost of process "Windows App" to true'`);
await sleep(800);
out.restoredFrontmost = frontmost();
bcdp.close();
const stop = sh(`cd ${REPO} && node dist/index.js chrome-stop --port 9233 2>&1`);
await sleep(2000);
out.cleanup = { stopOut: stop.slice(0, 200), pidAlive: (() => { try { process.kill(chromePid, 0); return true; } catch { return false; } })(), ledger: sh(`cat ~/.cache/lasso/launched-chromes.json`), frontmost: frontmost() };
sh(`rm -rf /tmp/lasso-t4b-profile`);
fs.writeFileSync(path.join(here, "t4b-result.json"), JSON.stringify(out, null, 2));
console.log(`[T4b] DONE restored=${out.restoredFrontmost} now=${out.cleanup.frontmost} pidAlive=${out.cleanup.pidAlive} ledger=${out.cleanup.ledger.slice(0, 40)}`);
process.exit(0);
