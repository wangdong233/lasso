#!/usr/bin/env node
/** T4e2：fill 终验（DDG combobox uid）+ evaluate 取值。 */
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
const out = { started: ts() };
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m); } }); }
  static async connect(wsUrl) { const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }); return new Cdp(ws); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve) => { this.pending.set(id, { resolve }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { this.ws.close(); }
}
const jsonList = () => JSON.parse(sh(`curl -s -m 3 http://localhost:9233/json/list`) || "[]");
const setFinder = () => sh(`osascript -e 'tell application "System Events" to set frontmost of process "Finder" to true'`);

sh(`cd ${REPO} && LASSO_LAUNCH_MODE=visible node dist/index.js launch-chrome --port 9233 --profile /tmp/lasso-t4e2-profile 2>&1`);
await sleep(3500);
const rec = JSON.parse(sh(`cat ~/.cache/lasso/launched-chromes.json`) || "[]").find((r) => r.port === 9233);
const chromePid = rec?.pid;
const firstPage = jsonList().find((t) => t.type === "page");
const acdp = await Cdp.connect(firstPage.webSocketDebuggerUrl);
await acdp.send("Page.navigate", { url: "https://duckduckgo.com/?q=hello" }); await sleep(2500); acdp.close();
setFinder(); await sleep(800);
const cdm = new Client({ name: "t4e2", version: "1.0.0" });
const cdmT = new StdioClientTransport({ command: "/bin/zsh", args: ["-c", `exec npx -y chrome-devtools-mcp@1.7.0 --browser-url=http://localhost:9233 2>>${JSON.stringify(path.join(here, "t4e2-cdm-stderr.log"))}`], cwd: REPO, env: { ...process.env } });
await cdm.connect(cdmT); await sleep(1500);
const callText = async (name, args, timeout = 60000) => { try { const r = await cdm.callTool({ name, arguments: args }, undefined, { timeout }); return { isError: r.isError === true, text: (r.content ?? []).map((c) => c.text ?? "").join("\n") }; } catch (e) { return { isError: true, text: "THROW:" + String(e.message).slice(0, 150) }; } };

const mk = (label) => ({ label, beforeFm: frontmost() });
const finish = (st) => { const fm = frontmost(); out[st.label] = { ...out[st.label], immediateFm: fm, windows: windowsOfPid(chromePid) }; console.log(`[T4e2] ${st.label}: ${st.beforeFm} → ${fm} isError=${out[st.label].isError} res=${(out[st.label].resHead || "").slice(0, 90)}`); };

let st = mk("snapshot");
const snap = await callText("take_snapshot", {});
out.snapshot = { isError: snap.isError, resHead: snap.text.slice(0, 100), len: snap.text.length };
finish(st);
const comboboxUid = (snap.text.match(/uid=(\d+_\d+) combobox[^\n]*/) || [])[1] ?? null;
out.comboboxUid = comboboxUid; out.comboboxLine = (snap.text.match(/[^\n]*combobox[^\n]*/) || [])[0];
console.log(`[T4e2] comboboxUid=${comboboxUid} line=${out.comboboxLine}`);

if (comboboxUid) {
  st = mk("fill"); await sleep(1500);
  const fr = await callText("fill", { uid: comboboxUid, value: "lasso silence test" });
  out.fill = { isError: fr.isError, resHead: fr.text.slice(0, 150) }; finish(st);
  await sleep(1500);
  st = mk("evaluate_value");
  const ev = await callText("evaluate_script", { function: "() => ({val: (document.querySelector('input')||{}).value ?? null, focused: document.hasFocus()})" });
  out.evaluate_value = { isError: ev.isError, resHead: ev.text.slice(0, 150) }; finish(st);
}
await cdm.close().catch(() => {}); await sleep(1500);
sh(`osascript -e 'tell application "System Events" to set frontmost of process "Windows App" to true'`); await sleep(600);
out.restored = frontmost();
const stop = sh(`cd ${REPO} && node dist/index.js chrome-stop --port 9233 2>&1`); await sleep(2000);
out.cleanup = { pidAlive: (() => { try { process.kill(chromePid, 0); return true; } catch { return false; } })(), ledger: sh(`cat ~/.cache/lasso/launched-chromes.json`), frontmost: frontmost() };
sh(`rm -rf /tmp/lasso-t4e2-profile`);
fs.writeFileSync(path.join(here, "t4e2-result.json"), JSON.stringify(out, null, 2));
console.log(`[T4e2] DONE restored=${out.restored} now=${out.cleanup.frontmost} pidAlive=${out.cleanup.pidAlive} ledger=${out.cleanup.ledger.slice(0, 30)}`);
process.exit(0);
