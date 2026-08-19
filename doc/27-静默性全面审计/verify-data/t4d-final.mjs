#!/usr/bin/env node
/** T4d（终补）：正确 uid 格式（uid=1_5）下的 click/fill 真效验证 + close_page 三形态（url 错配 / pageId 正确）
 *  + S-9 残余检查（navigate 后选中页 hasFocus）。结束还原 Windows App + chrome-stop。 */
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

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m); } }); }
  static async connect(wsUrl) { const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }); return new Cdp(ws); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve) => { this.pending.set(id, { resolve }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { this.ws.close(); }
}
const jsonList = () => JSON.parse(sh(`curl -s -m 3 http://localhost:9233/json/list`) || "[]");
const jsonVersion = () => JSON.parse(sh(`curl -s -m 3 http://localhost:9233/json/version`) || "{}");
async function evalOnPage(urlSubstr, expr) {
  const t = jsonList().find((t) => t.type === "page" && (t.url || "").includes(urlSubstr));
  if (!t) return { err: "no_target:" + urlSubstr };
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  c.close();
  return r.result?.result?.value ?? { err: JSON.stringify(r).slice(0, 100) };
}
const snapState = (label) => ({ t: ts(), label, frontmost: frontmost(), windows: windowsOfPid(chromePid), pages: jsonList().filter((t) => t.type === "page").map((t) => (t.url || "").slice(0, 44)) });
const setFinder = () => sh(`osascript -e 'tell application "System Events" to set frontmost of process "Finder" to true'`);

// ---------- 起 visible Chrome ----------
sh(`cd ${REPO} && LASSO_LAUNCH_MODE=visible node dist/index.js launch-chrome --port 9233 --profile /tmp/lasso-t4d-profile 2>&1`);
await sleep(3500);
const rec = JSON.parse(sh(`cat ~/.cache/lasso/launched-chromes.json`) || "[]").find((r) => r.port === 9233);
const chromePid = rec?.pid;
const firstPage = jsonList().find((t) => t.type === "page");
const acdp = await Cdp.connect(firstPage.webSocketDebuggerUrl);
await acdp.send("Page.navigate", { url: "https://example.com" }); await sleep(1500); acdp.close();
// 第二 tab（后台）供 close_page 用
const bcdp = await Cdp.connect(jsonVersion().webSocketDebuggerUrl);
await bcdp.send("Target.createTarget", { url: "https://example.org", background: true }); await sleep(1200);
out.initial = snapState("tabs-ready");
setFinder(); await sleep(800);

const cdm = new Client({ name: "t4d", version: "1.0.0" });
const cdmT = new StdioClientTransport({ command: "/bin/zsh", args: ["-c", `exec npx -y chrome-devtools-mcp@1.7.0 --browser-url=http://localhost:9233 2>>${JSON.stringify(path.join(here, "t4d-cdm-stderr.log"))}`], cwd: REPO, env: { ...process.env } });
await cdm.connect(cdmT); await sleep(2000);
out.s9_selected_afterConnect = await evalOnPage("example.com", "document.hasFocus()");

const callRaw = async (name, args, timeout = 60000) => {
  try {
    const r = await cdm.callTool({ name, arguments: args }, undefined, { timeout });
    return { isError: r.isError === true, text: (r.content ?? []).map((c) => (c.text ?? "").slice(0, 200)).join(" | ").slice(0, 300) };
  } catch (e) { return { isError: true, text: "THROW:" + String(e.message).slice(0, 150) }; }
};
async function step(label, fn) {
  setFinder(); await sleep(700);
  const before = snapState(`${label}#before`);
  const s = Date.now(); const res = await fn();
  const ms = Date.now() - s;
  const immediate = frontmost(); await sleep(1000); const late = frontmost();
  const after = snapState(`${label}#after`);
  out.steps.push({ label, ms, frontmost: { before: before.frontmost, immediate, late }, windows: { before: before.windows, after: after.windows }, pagesBefore: before.pages, pagesAfter: after.pages, res });
  console.log(`[T4d] ${label} ${ms}ms isError=${res.isError} Finder→imm=${immediate} late=${late} win ${before.windows}->${after.windows} pages ${before.pages.length}->${after.pages.length} res=${res.text.slice(0, 80)}`);
  await sleep(1500);
  return { res, after };
}

// ---------- snapshot + 正确 uid click ----------
const s1 = await step("take_snapshot", () => callRaw("take_snapshot", {}));
const snapText = s1.res.text;
fs.writeFileSync(path.join(here, "t4d-snapshot.txt"), snapText);
const linkUid = (snapText.match(/uid=(\d+_\d+) link "More information[^"]*"/) || [])[1] ?? null;
out.linkUid = linkUid;
console.log(`[T4d] linkUid=${linkUid}`);
if (linkUid) await step("click(link→iana)", () => callRaw("click", { uid: linkUid }));

// ---------- navigate DDG + fill ----------
await step("navigate_page(DDG)", () => callRaw("navigate_page", { url: "https://duckduckgo.com/?q=hello" }));
const s2 = await step("take_snapshot(DDG)", () => callRaw("take_snapshot", {}));
const ddgText = s2.res.text;
const inputUid = (ddgText.match(/uid=(\d+_\d+) textbox[^\n]*/) || [])[1] ?? null;
out.inputUid = inputUid; out.ddgTextboxLine = (ddgText.match(/[^\n]*textbox[^\n]*/i) || [])[0]?.slice(0, 140) ?? null;
console.log(`[T4d] inputUid=${inputUid} line=${out.ddgTextboxLine}`);
if (inputUid) {
  await step("fill(textbox)", () => callRaw("fill", { uid: inputUid, value: "lasso silence test" }));
  await step("evaluate_script(value check)", () => callRaw("evaluate_script", { function: "() => ({val: (document.querySelector('input')||{}).value ?? null, focused: document.hasFocus()})" }));
}

// ---------- close_page 三形态 ----------
const lp = await step("list_pages", () => callRaw("list_pages", {}));
out.listPagesText = lp.res.text;
await step("close_page{url}(lasso TabRegistry 形态)", () => callRaw("close_page", { url: "https://example.org/" }));
await step("close_page{pageId:<错的数字形态 999>}", () => callRaw("close_page", { pageId: 999 }));
// 找真实 pageId：list_pages 文本 "2: Example Domain (url)" —— 上游 pageId 是数字
const realId = (lp.res.text.match(/^2: /m) ? 2 : 1);
await step(`close_page{pageId:${realId}}(正确形态)`, () => callRaw("close_page", { pageId: realId }));

// ---------- S-9 残余：navigate 后选中页 hasFocus ----------
out.s9_afterOps = await evalOnPage("duckduckgo", "document.hasFocus()");

// ---------- 收尾 ----------
await cdm.close().catch(() => {}); await sleep(1500);
sh(`osascript -e 'tell application "System Events" to set frontmost of process "Windows App" to true'`); await sleep(600);
out.restored = frontmost();
bcdp.close();
const stop = sh(`cd ${REPO} && node dist/index.js chrome-stop --port 9233 2>&1`); await sleep(2000);
out.cleanup = { stopOut: stop.slice(0, 120), pidAlive: (() => { try { process.kill(chromePid, 0); return true; } catch { return false; } })(), ledger: sh(`cat ~/.cache/lasso/launched-chromes.json`), frontmost: frontmost() };
sh(`rm -rf /tmp/lasso-t4d-profile`);
fs.writeFileSync(path.join(here, "t4d-result.json"), JSON.stringify(out, null, 2));
console.log(`[T4d] DONE s9_sel_afterConnect=${out.s9_selected_afterConnect} s9_afterOps=${out.s9_afterOps} restored=${out.restored} now=${out.cleanup.frontmost} pidAlive=${out.cleanup.pidAlive} ledger=${out.cleanup.ledger.slice(0, 30)}`);
process.exit(0);
