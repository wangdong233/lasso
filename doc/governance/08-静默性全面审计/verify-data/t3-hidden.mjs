#!/usr/bin/env node
/** T3 launch-chrome hidden 复核（v1.17.1 真机）：零窗口 / frontmost 不变 / 静音+反节流 flag / 台账 / Dock ASN / chrome-stop 清理 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { frontmost, windowsOfPid, chromeAsns, sleep, ts, portAlive } from "./probe.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const out = { started: ts() };
const sh = (c, o = {}) => { try { return execSync(c, { encoding: "utf8", timeout: 30000, ...o }).trim(); } catch (e) { return (e.stdout || "") + "|ERR:" + String(e.message).slice(0, 100); } };

out.baseline = { frontmost: frontmost(), asnRaw: sh(`lsappinfo list 2>/dev/null | grep -c '"Google Chrome" ASN'`), ledger: sh(`cat ~/.cache/lasso/launched-chromes.json 2>/dev/null`) };

// ---- 起 hidden（默认档，无任何 flag） ----
const t0 = Date.now();
const launchOut = sh(`cd ${REPO} && node dist/index.js launch-chrome --port 9225 2>&1`);
out.launch = { ms: Date.now() - t0, stdout: launchOut.slice(0, 500) };
await sleep(3500);

// ---- 采样 ----
const ver = JSON.parse(sh(`curl -s -m 3 http://localhost:9225/json/version 2>/dev/null || echo '{}'`) || "{}");
const list = sh(`curl -s -m 3 http://localhost:9225/json/list 2>/dev/null`);
let targets = null;
try { targets = JSON.parse(list || "[]").length; } catch { targets = `parse_fail:${list.slice(0, 80)}`; }
const ledgerAfter = JSON.parse(sh(`cat ~/.cache/lasso/launched-chromes.json 2>/dev/null`) || "[]");
const rec = ledgerAfter.find((r) => r.port === 9225) ?? ledgerAfter[0];
const pid = rec?.pid;
const cmd = pid ? sh(`ps -o command= -p ${pid} 2>/dev/null`) : "";
out.at3s = {
  frontmost: frontmost(),
  pid,
  windows: pid ? windowsOfPid(pid) : null,
  browserVer: ver.Browser ?? null,
  targets,
  ledgerRec: rec ? { port: rec.port, pid: rec.pid, launchMode: rec.launchMode, idleMs: rec.idleMs } : null,
  flags: cmd ? {
    noStartupWindow: cmd.includes("--no-startup-window"),
    muteAudio: cmd.includes("--mute-audio"),
    noFirstRun: cmd.includes("--no-first-run"),
    noDefaultBrowserCheck: cmd.includes("--no-default-browser-check"),
    antiThrottleTrio: cmd.includes("--disable-backgrounding-occluded-windows") && cmd.includes("--disable-background-timer-throttling") && cmd.includes("--disable-renderer-backgrounding"),
    remoteDebuggingPort: (cmd.match(/--remote-debugging-port=(\d+)/) || [])[1] ?? null,
    userDataDir: (cmd.match(/--user-data-dir=(\S+)/) || [])[1] ?? null,
  } : null,
  cmdHead: cmd.slice(0, 260),
  asnEntries: chromeAsns().entries.filter((e) => e.name === "Google Chrome"),
};
console.log(`[T3] launch ${out.launch.ms}ms → pid=${pid} windows=${out.at3s.windows} targets=${targets} frontmost=${out.at3s.frontmost}`);
console.log(`[T3] flags=${JSON.stringify(out.at3s.flags)}`);
console.log(`[T3] asn=${JSON.stringify(out.at3s.asnEntries)}`);

// ---- CDP 后台 tab + 一步操作（复核 V5 核心：操作不抢焦） ----
// 用裸 WS 验证 /json 面即可，不做复杂操作（V5 已证；这里只验 0-target 状态 + 无窗口）
await sleep(2000);
out.at8s = { frontmost: frontmost(), windows: pid ? windowsOfPid(pid) : null };

// ---- chrome-stop 清理 ----
const t1 = Date.now();
const stopOut = sh(`cd ${REPO} && node dist/index.js chrome-stop --port 9225 2>&1`);
await sleep(2500);
out.stop = {
  ms: Date.now() - t1,
  stdout: stopOut.slice(0, 300),
  pidAlive: (() => { try { process.kill(pid, 0); return true; } catch { return false; } })(),
  portReleased: !portAlive(9225),
  ledgerAfter: sh(`cat ~/.cache/lasso/launched-chromes.json 2>/dev/null`),
  frontmostFinal: frontmost(),
};
console.log(`[T3] stop → alive=${out.stop.pidAlive} portReleased=${out.stop.portReleased} ledger=${out.stop.ledgerAfter.slice(0, 60)} frontmost=${out.stop.frontmostFinal}`);

fs.writeFileSync(path.join(here, "t3-result.json"), JSON.stringify(out, null, 2));
process.exit(0);
