#!/usr/bin/env node
/** T4c（补洞轮）：S-9 焦点仿真机制级验证 + click/fill 真跑 + 干净阳性对照（每对照前还原 Finder）
 *  + S-10 close_page 契约错配实测 + 快照格式留档。 */
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
const launch = sh(`cd ${REPO} && LASSO_LAUNCH_MODE=visible node dist/index.js launch-chrome --port 9233 --profile /tmp/lasso-t4c-profile 2>&1`);
await sleep(3500);
const rec = JSON.parse(sh(`cat ~/.cache/lasso/launched-chromes.json`) || "[]").find((r) => r.port === 9233);
const chromePid = rec?.pid;
out.chrome = { pid: chromePid, atLaunch: snapState("visible-launch") };
const bcdp = await Cdp.connect(jsonVersion().webSocketDebuggerUrl);

// tabA（窗口内活动页）→ example.com；tabB 后台 example.org
const firstPage = jsonList().find((t) => t.type === "page");
const acdp = await Cdp.connect(firstPage.webSocketDebuggerUrl);
await acdp.send("Page.navigate", { url: "https://example.com" }); await sleep(1500); acdp.close();
await bcdp.send("Target.createTarget", { url: "https://example.org", background: true }); await sleep(1200);
out.tabsReady = snapState("tabs-ready");

// ---------- S-9：pre / connect / post / 机制验证 / 断开后 ----------
out.s9 = {};
out.s9.pre = { tabA: await evalOnPage("example.com", "document.hasFocus()"), tabB: await evalOnPage("example.org", "document.hasFocus()") };
setFinder(); await sleep(800);
out.s9.frontBeforeConnect = frontmost();

const cdm = new Client({ name: "t4c", version: "1.0.0" });
const cdmT = new StdioClientTransport({ command: "/bin/zsh", args: ["-c", `exec npx -y chrome-devtools-mcp@1.7.0 --browser-url=http://localhost:9233 2>>${JSON.stringify(path.join(here, "t4c-cdm-stderr.log"))}`], cwd: REPO, env: { ...process.env } });
await cdm.connect(cdmT); await sleep(2500);
out.s9.post2s = { frontmost: frontmost(), tabA: await evalOnPage("example.com", "document.hasFocus()"), tabB: await evalOnPage("example.org", "document.hasFocus()") };

// 机制验证：自己直接调 Emulation.setFocusEmulationEnabled(true) 在 tabB
{
  const t = jsonList().find((t) => t.type === "page" && (t.url || "").includes("example.org"));
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  const r = await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await sleep(400);
  out.s9.manualEmulation = { cdpResult: r.result === undefined ? "ok" : r.result, tabB_hasFocus: await evalOnPage("example.org", "document.hasFocus()"), frontmost: frontmost() };
  c.close();
}
console.log(`[T4c] S-9: pre=${JSON.stringify(out.s9.pre)} post2s=${JSON.stringify(out.s9.post2s)} manual=${JSON.stringify(out.s9.manualEmulation)}`);

const call = async (name, args, timeout = 60000) => cdm.callTool({ name, arguments: args }, undefined, { timeout });

async function step(label, fn) {
  setFinder(); await sleep(700);
  const before = snapState(`${label}#before`);
  if (before.frontmost !== "Finder") { out.steps.push({ label, note: "SKIP: Finder not frontmost", got: before.frontmost }); return { rec: null }; }
  const s = Date.now(); let res, err;
  try { res = await fn(); } catch (e) { err = String(e.message).slice(0, 180); }
  const ms = Date.now() - s;
  const immediate = frontmost(); await sleep(1000);
  const late = frontmost(); const after = snapState(`${label}#after`);
  const r = { label, ms, err, frontmost: { before: "Finder", immediate, late }, windows: { before: before.windows, after: after.windows }, pagesBefore: before.pages, pagesAfter: after.pages };
  out.steps.push(r);
  console.log(`[T4c] ${label} ${ms}ms err=${err ? err.slice(0, 70) : "none"} Finder→imm=${immediate} late=${late} win ${before.windows}->${after.windows} pages ${before.pages.length}->${after.pages.length}`);
  await sleep(1500);
  return { rec: r, res };
}

// ---------- click / fill（快照格式留档 + uid 提取） ----------
// 当前 cdm 选中页 = pages[0]；先把它导航回 example.com（有已知链接）
await step("navigate_page(example.com)", () => call("navigate_page", { url: "https://example.com" }));
const snp = await step("take_snapshot", () => call("take_snapshot", {}));
let snapText = ""; try { snapText = (snp.res?.content ?? []).map((c) => c.text ?? "").join("\n"); } catch {}
fs.writeFileSync(path.join(here, "t4c-snapshot-example.txt"), snapText);
const linkUid = (snapText.match(/- link "More information[^"]*"[^\n]*?uid=(\d+)/) || snapText.match(/uid=(\d+)[^\n]*link/i) || [])[1] ?? null;
out.uidFind = { snapshotLen: snapText.length, linkUid, sample: snapText.slice(0, 300) };
console.log(`[T4c] snapshot sample: ${JSON.stringify(snapText.slice(0, 220))}`);
if (linkUid) await step("click(link)", () => call("click", { uid: linkUid }));

await step("navigate_page(DDG)", () => call("navigate_page", { url: "https://duckduckgo.com/?q=hello" }));
const snp2 = await step("take_snapshot(DDG)", () => call("take_snapshot", {}));
let snap2 = ""; try { snap2 = (snp2.res?.content ?? []).map((c) => c.text ?? "").join("\n"); } catch {}
fs.writeFileSync(path.join(here, "t4c-snapshot-ddg.txt"), snap2);
const inputUid = (snap2.match(/- textbox[^\n]*uid=(\d+)/i) || snap2.match(/uid=(\d+)[^\n]*textbox/i) || [])[1] ?? null;
out.uidFind.inputUid = inputUid;
if (inputUid) await step("fill(textbox)", () => call("fill", { uid: inputUid, value: "lasso silence test" }));

// ---------- S-10：close_page 契约错配实测 ----------
const cp1 = await step("close_page{url}(错配形态)", () => call("close_page", { url: "https://example.org/" })).catch((e) => ({ err: String(e).slice(0, 120) }));
const cp2 = await step("close_page{pageIdx}(正确形态)", () => call("close_page", { pageIdx: 1 })).catch((e) => ({ err: String(e).slice(0, 120) }));

// ---------- 干净阳性对照 ----------
await step("POS:cdp.createTarget(default)", async () => { await bcdp.send("Target.createTarget", { url: "about:blank?posA" }); });
await step("NEG:cdp.createTarget{bg:true}", async () => { await bcdp.send("Target.createTarget", { url: "about:blank?negA", background: true }); });
await step("POS:select_page{bringToFront}", () => call("select_page", { pageIdx: 0, bringToFront: true }));

// ---------- 断开 cdm 后 S-9(c) ----------
await cdm.close().catch(() => {}); await sleep(2500);
out.s9.afterDisconnect = { tabA: await evalOnPage("example.com", "document.hasFocus()"), tabAny: await evalOnPage("example.org", "document.hasFocus()"), frontmost: frontmost() };
console.log(`[T4c] S-9 after disconnect: ${JSON.stringify(out.s9.afterDisconnect)}`);

// ---------- 收尾 ----------
sh(`osascript -e 'tell application "System Events" to set frontmost of process "Windows App" to true'`); await sleep(600);
out.restored = frontmost();
bcdp.close();
const stop = sh(`cd ${REPO} && node dist/index.js chrome-stop --port 9233 2>&1`); await sleep(2000);
out.cleanup = { stopOut: stop.slice(0, 150), pidAlive: (() => { try { process.kill(chromePid, 0); return true; } catch { return false; } })(), ledger: sh(`cat ~/.cache/lasso/launched-chromes.json`), frontmost: frontmost() };
sh(`rm -rf /tmp/lasso-t4c-profile`);
fs.writeFileSync(path.join(here, "t4c-result.json"), JSON.stringify(out, null, 2));
console.log(`[T4c] DONE restored=${out.restored} now=${out.cleanup.frontmost} pidAlive=${out.cleanup.pidAlive} ledger=${out.cleanup.ledger.slice(0, 40)}`);
process.exit(0);
