#!/usr/bin/env node
/** T2 browse_headless 全生命周期静默性：npx 起 → navigate → extract → server 退出 → 树死
 *  S-1：全程 250ms 轮询 lsappinfo（抓 Foreground Chrome ASN 闪现 = Dock/cmd-tab 注册）
 *  S-2：chrome cmdline 含 --mute-audio 实证；S-4：资源峰值；退出路径：server SIGTERM → killAllSync */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { frontmost, chromeAsns, sleep, ts } from "./probe.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const stderrLog = path.join(here, "t2-server-stderr.log");
const pollLog = path.join(here, "t2-asn-poll.jsonl");
const out = { meta: { started: ts() }, steps: [], pollSummary: {} };

const chromePids = () => {
  const a = execSync(`pgrep -f "MacOS/Google Chrome" 2>/dev/null || true`, { encoding: "utf8" });
  return [...new Set(a.split("\n").filter((l) => /^\d+$/.test(l)).map(Number))];
};

const cmdlineOf = (pid) => { try { return execSync(`ps -o command= -p ${pid} 2>/dev/null`, { encoding: "utf8" }).trim(); } catch { return ""; } };
function ppidOf(pid) { try { return Number(execSync(`ps -o ppid= -p ${pid} 2>/dev/null`, { encoding: "utf8" }).trim()); } catch { return null; } }

// 树采样：给定新 chrome 主进程集，ppid 闭包 3 跳收 helper
function treeOf(mainPids) {
  const pids = new Set(mainPids);
  for (let i = 0; i < 3; i++) {
    for (const p of chromePids()) {
      if (!pids.has(p) && pids.has(ppidOf(p))) pids.add(p);
    }
  }
  let rss = 0, cpu = 0, n = 0;
  for (const pid of pids) {
    try {
      const ps = execSync(`ps -o pcpu=,rss= -p ${pid} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (!ps) continue;
      const [c, r] = ps.split(/\s+/);
      cpu += Number(c); rss += Number(r); n++;
    } catch {}
  }
  return { procs: n, rssKb: rss, cpuPct: Number(cpu.toFixed(1)), pidList: [...pids].sort((a, b) => a - b) };
}

// ---------- 起 lasso server ----------
const client = new Client({ name: "t2-headless-verify", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node /Users/wangdong/Documents/Project/cc-control-all/lasso/dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: "/Users/wangdong/Documents/Project/cc-control-all/lasso",
  env: { ...process.env },
});
await client.connect(transport);
const serverPid = Number(execSync(`pgrep -f "dist/index.js$" | tail -1`).toString().trim());
out.meta.serverPid = serverPid;

const baselineChromePids = new Set(chromePids());
out.baseline = { t: ts(), frontmost: frontmost(), chromePids: [...baselineChromePids], asn: chromeAsns().entries.filter((e) => e.name === "Google Chrome") };

// ---------- 轮询器（S-1：Foreground Chrome ASN 闪现 + frontmost 变化） ----------
let polling = true;
const pollStates = [];
(async () => {
  while (polling) {
    const a = chromeAsns();
    pollStates.push({ t: ts(), fgChrome: a.chromeForeground, chromeAsnTotal: a.raw_grep_count, frontmost: frontmost(), cdm: a.cdmEntries });
    await sleep(250);
  }
})();

const call = async (name, args, timeout = 120000) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  return JSON.parse(r.content[0].text);
};

// ---------- navigate（含 npx 冷启动） ----------
let t0 = Date.now();
const nav = await call("browse_headless", { url: "https://example.com", action: "navigate" });
const navMs = Date.now() - t0;
await sleep(500);
const newPids1 = chromePids().filter((p) => !baselineChromePids.has(p));
const mainOf = (p) => { const c = cmdlineOf(p); return c.startsWith("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") && c.includes("--headless"); };
const tree1 = treeOf(newPids1.filter(mainOf));
out.steps.push({
  step: "navigate(cold)", ms: navMs,
  outcome: nav.outcome, served_by: nav.served_by ?? nav.retrieval_method, retrieval: nav.retrieval_method,
  newChromePids: newPids1, tree: tree1,
  chromeMainCmdFlags: (() => {
    const main = newPids1.map((p) => cmdlineOf(p)).find((c) => c.includes("--headless"));
    return main ? { headless: main.includes("--headless=new"), muteAudio: main.includes("--mute-audio"), remotePipe: main.includes("--remote-debugging-pipe"), tmpProfile: main.includes("puppeteer_dev_chrome_profile") } : null;
  })(),
});
console.log(`[T2] navigate ${navMs}ms outcome=${nav.outcome} tree=${JSON.stringify({ procs: tree1.procs, rssKb: tree1.rssKb })} flags=${JSON.stringify(out.steps[0].chromeMainCmdFlags)}`);

await sleep(2000);

// ---------- extract ----------
t0 = Date.now();
const ext = await call("browse_headless", { url: "https://example.com", action: "extract" });
const extMs = Date.now() - t0;
await sleep(300);
const tree2 = treeOf(chromePids().filter((p) => !baselineChromePids.has(p) && mainOf(p)));
out.steps.push({ step: "extract", ms: extMs, outcome: ext.outcome, title: ext.data?.title ?? null, textLen: ext.data?.text?.length ?? ext.data?.content?.length ?? null, tree: tree2 });
console.log(`[T2] extract ${extMs}ms outcome=${ext.outcome} title=${out.steps[1].title} textLen=${out.steps[1].textLen}`);

await sleep(2000);

// ---------- evaluate（stealth 在位抽验） ----------
t0 = Date.now();
let ev = null, evErr = null;
try { ev = await call("browse_headless", { url: "https://example.com", action: "evaluate", options: { js: "return {webdriver: typeof navigator.webdriver, ua: navigator.userAgent.slice(0, 40)}" } }); } catch (e) { evErr = String(e.message).slice(0, 120); }
const evMs = Date.now() - t0;
out.steps.push({ step: "evaluate", ms: evMs, err: evErr, outcome: ev?.outcome, data: ev?.data ?? null });
console.log(`[T2] evaluate ${evMs}ms err=${evErr} outcome=${ev?.outcome} data=${JSON.stringify(ev?.data)?.slice(0, 100)}`);

// ---------- 退出：关 server → 树死验证 ----------
await sleep(1000);
t0 = Date.now();
await client.close().catch(() => {});
await sleep(4000);
const survived = chromePids().filter((p) => !baselineChromePids.has(p));
out.exit = {
  serverCloseMs: Date.now() - t0,
  chromeSurvivedAfterClose: survived,
  serverAlive: (() => { try { process.kill(serverPid, 0); return true; } catch { return false; } })(),
  preExistingChromeUntouched: [...baselineChromePids].every((p) => { try { process.kill(p, 0); return true; } catch { return false; } }),
};
console.log(`[T2] exit: survived=${JSON.stringify(survived)} serverAlive=${out.exit.serverAlive} preExistingUntouched=${out.exit.preExistingChromeUntouched}`);

// ---------- 轮询汇总 ----------
polling = false;
await sleep(300);
fs.appendFileSync(pollLog, pollStates.map((s) => JSON.stringify(s)).join("\n") + "\n");
const fgSeen = pollStates.filter((s) => s.fgChrome > 1); // 基线 fg=1（用户 Chrome）
out.pollSummary = {
  samples: pollStates.length,
  windowSec: Number(((new Date(pollStates.at(-1).t) - new Date(pollStates[0].t)) / 1000).toFixed(1)),
  fgChromeMax: Math.max(...pollStates.map((s) => s.fgChrome)),
  fgAboveBaselineSamples: fgSeen.length,
  chromeAsnTotalMax: Math.max(...pollStates.map((s) => s.chromeAsnTotal)),
  frontmostValues: [...new Set(pollStates.map((s) => s.frontmost))],
  cdmMax: Math.max(...pollStates.map((s) => s.cdm)),
};
out.finalFrontmost = frontmost();
console.log(`[T2] poll: ${out.pollSummary.samples} samples / ${out.pollSummary.windowSec}s fgMax=${out.pollSummary.chromeAsnTotalMax ? out.pollSummary.fgChromeMax : "?"} asnTotalMax=${out.pollSummary.chromeAsnTotalMax} frontmost=${JSON.stringify(out.pollSummary.frontmostValues)}`);

fs.writeFileSync(path.join(here, "t2-result.json"), JSON.stringify(out, null, 2));
process.exit(0);
