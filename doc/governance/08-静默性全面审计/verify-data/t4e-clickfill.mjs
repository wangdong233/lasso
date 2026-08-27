#!/usr/bin/env node
/** T4e（click/fill 真效，唯一遗留洞）：全文快照落盘 → 正确 uid 提取 → click 验证页面跳转 + fill 验证输入值。 */
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
const snapState = (label) => ({ t: ts(), label, frontmost: frontmost(), windows: windowsOfPid(chromePid), pages: jsonList().filter((t) => t.type === "page").map((t) => (t.url || "").slice(0, 44)) });
const setFinder = () => sh(`osascript -e 'tell application "System Events" to set frontmost of process "Finder" to true'`);

sh(`cd ${REPO} && LASSO_LAUNCH_MODE=visible node dist/index.js launch-chrome --port 9233 --profile /tmp/lasso-t4e-profile 2>&1`);
await sleep(3500);
const rec = JSON.parse(sh(`cat ~/.cache/lasso/launched-chromes.json`) || "[]").find((r) => r.port === 9233);
const chromePid = rec?.pid;
const firstPage = jsonList().find((t) => t.type === "page");
const acdp = await Cdp.connect(firstPage.webSocketDebuggerUrl);
await acdp.send("Page.navigate", { url: "https://example.com" }); await sleep(1800); acdp.close();
setFinder(); await sleep(800);

const cdm = new Client({ name: "t4e", version: "1.0.0" });
const cdmT = new StdioClientTransport({ command: "/bin/zsh", args: ["-c", `exec npx -y chrome-devtools-mcp@1.7.0 --browser-url=http://localhost:9233 2>>${JSON.stringify(path.join(here, "t4e-cdm-stderr.log"))}`], cwd: REPO, env: { ...process.env } });
await cdm.connect(cdmT); await sleep(1500);

const callText = async (name, args, timeout = 60000) => {
  try { const r = await cdm.callTool({ name, arguments: args }, undefined, { timeout });
    return { isError: r.isError === true, text: (r.content ?? []).map((c) => c.text ?? "").join("\n") }; }
  catch (e) { return { isError: true, text: "THROW:" + String(e.message).slice(0, 150) }; }
};
async function step(label, fn) {
  setFinder(); await sleep(700);
  const before = snapState(`${label}#before`);
  const s = Date.now(); const res = await fn();
  const ms = Date.now() - s;
  const immediate = frontmost(); await sleep(1200); const late = frontmost();
  const after = snapState(`${label}#after`);
  out.steps.push({ label, ms, frontmost: { before: before.frontmost, immediate, late }, windows: { before: before.windows, after: after.windows }, pagesBefore: before.pages, pagesAfter: after.pages, isError: res.isError, resHead: res.text.slice(0, 120) });
  console.log(`[T4e] ${label} ${ms}ms isError=${res.isError} Finder→imm=${immediate} late=${late} win ${before.windows}->${after.windows} pages ${before.pages.length}->${after.pages.length}`);
  await sleep(1500);
  return res;
}

// snapshot 全文
const snap1 = await step("take_snapshot(example.com)", () => callText("take_snapshot", {}));
fs.writeFileSync(path.join(here, "t4e-snapshot-example-full.txt"), snap1.text);
const linkLine = (snap1.text.match(/[^\n]*link[^\n]*/i) || [])[0] ?? null;
const linkUid = (snap1.text.match(/uid=(\d+_\d+) link\b/) || [])[1] ?? null;
out.link = { line: linkLine, uid: linkUid, textLen: snap1.text.length };
console.log(`[T4e] linkLine=${JSON.stringify(linkLine)} uid=${linkUid}`);
if (linkUid) {
  await step("click(uid)", () => callText("click", { uid: linkUid }));
}

await step("navigate_page(DDG)", () => callText("navigate_page", { url: "https://duckduckgo.com/?q=hello" }));
const snap2 = await step("take_snapshot(DDG)", () => callText("take_snapshot", {}));
fs.writeFileSync(path.join(here, "t4e-snapshot-ddg-full.txt"), snap2.text);
const tbLine = (snap2.text.match(/[^\n]*textbox[^\n]*/i) || [])[0] ?? null;
const tbUid = (snap2.text.match(/uid=(\d+_\d+) textbox\b/i) || [])[1] ?? (snap2.text.match(/uid=(\d+_\d+)[^\n]*searchbox/i) || [])[1] ?? null;
out.textbox = { line: tbLine, uid: tbUid, textLen: snap2.text.length };
console.log(`[T4e] textboxLine=${JSON.stringify(tbLine)} uid=${tbUid}`);
if (tbUid) {
  await step("fill(uid)", () => callText("fill", { uid: tbUid, value: "lasso silence test" }));
  await step("evaluate_script(input value)", () => callText("evaluate_script", { function: "() => ({val: (document.querySelector('input')||{}).value ?? null})" }));
}

await cdm.close().catch(() => {}); await sleep(1500);
sh(`osascript -e 'tell application "System Events" to set frontmost of process "Windows App" to true'`); await sleep(600);
out.restored = frontmost();
const stop = sh(`cd ${REPO} && node dist/index.js chrome-stop --port 9233 2>&1`); await sleep(2000);
out.cleanup = { pidAlive: (() => { try { process.kill(chromePid, 0); return true; } catch { return false; } })(), ledger: sh(`cat ~/.cache/lasso/launched-chromes.json`), frontmost: frontmost() };
sh(`rm -rf /tmp/lasso-t4e-profile`);
fs.writeFileSync(path.join(here, "t4e-result.json"), JSON.stringify(out, null, 2));
console.log(`[T4e] DONE restored=${out.restored} now=${out.cleanup.frontmost} pidAlive=${out.cleanup.pidAlive} ledger=${out.cleanup.ledger.slice(0, 30)}`);
process.exit(0);
