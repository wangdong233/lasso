#!/usr/bin/env node
/**
 * v19 验证 V2：chrome-stop 收尾 + pid 复用防护（真机）。
 *
 *  A) launch-chrome --port 9225（隔离 profile）→ chrome-stop --port 9225
 *     → Chrome 进程灭 + 台账清空 + 端口释放。
 *  B) pid 复用防护：伪造台账条目 pid → 指向无关进程（本脚本 spawn 的 sleep），
 *     chrome-stop 必须拒绝 kill（verifyOwnership 失败），仅清陈旧条目。
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { ResourceMeter, sampleLassoTree } from "../../../test/helpers/resource-meter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const LEDGER = path.join(os.homedir(), ".cache", "lasso", "launched-chromes.json");
const mb = (kb) => Math.round(kb / 1024);
const PORT = 9225;

const report = { a: {}, b: {} };
const note = (s) => { console.log(s); report.steps ??= []; report.steps.push(s); };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000, cwd: repoRoot });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return []; } };
const portOpen = (p) => {
  const r = spawnSync("nc", ["-z", "127.0.0.1", String(p)], { encoding: "utf8", timeout: 5000 });
  return r.status === 0;
};
const chromeProcsOnPort = (port) => {
  const r = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return r.stdout.split("\n").filter(l => l.includes(`--remote-debugging-port=${port}`)).map(l => l.trim().split(/\s+/)[0]);
};

const meter = new ResourceMeter();
const before = meter.before();

// ---------- A) 正常收尾 ----------
const meterA = new ResourceMeter();
const beforeA = meterA.before();
const lc = run("node", ["dist/index.js", "launch-chrome", "--port", String(PORT)]);
note(`A.launch-chrome: exit=${lc.code} out=${lc.out.trim().slice(0, 220)}`);
let la = {};
try { la = JSON.parse(lc.out); } catch {}
await new Promise(r => setTimeout(r, 1500));
const aProcs = chromeProcsOnPort(PORT);
report.a.launched_pid = la.pid;
report.a.processes_after_launch = aProcs.length;
report.a.port_open_after_launch = portOpen(PORT);
report.a.ledger_after_launch = readLedger();
note(`A.after launch: chrome_procs=${aProcs.length} pid=${la.pid} port_open=${portOpen(PORT)} ledger=${JSON.stringify(readLedger())}`);

const cs = run("node", ["dist/index.js", "chrome-stop", "--port", String(PORT)]);
note(`A.chrome-stop: exit=${cs.code} out=${cs.out.trim().slice(0, 300)}`);
await new Promise(r => setTimeout(r, 2000));
report.a.processes_after_stop = chromeProcsOnPort(PORT).length;
report.a.port_open_after_stop = portOpen(PORT);
report.a.ledger_after_stop = readLedger();
note(`A.after stop: chrome_procs=${chromeProcsOnPort(PORT).length} port_open=${portOpen(PORT)} ledger=${JSON.stringify(readLedger())}`);
const peakA = meterA.peak();
const afterA = meterA.after();
report.a.peak = { count: peakA.count, rssMb: mb(peakA.rssKb) };
report.a.after = { count: afterA.count, rssMb: mb(afterA.rssKb) };
report.a.released = meterA.released(beforeA, afterA);
note(`A.resource: peak=${mb(peakA.rssKb)}MB/${peakA.count}procs after=${mb(afterA.rssKb)}MB/${afterA.count}procs released=${report.a.released}`);

// 幂等复跑
const cs2 = run("node", ["dist/index.js", "chrome-stop", "--port", String(PORT)]);
report.a.idempotent_exit = cs2.code;
note(`A.chrome-stop again: exit=${cs2.code} out=${cs2.out.trim().slice(0, 120)}`);

// ---------- B) pid 复用防护 ----------
// spawn 无关进程（sleep 300），把台账伪造成 {port: 9225b, pid: sleepPid, profileDir: 真隔离 profile}
const victim = spawn("sleep", ["300"], { stdio: "ignore", detached: false });
await new Promise(r => setTimeout(r, 500));
const victimAlive = () => { const r = spawnSync("kill", ["-0", String(victim.pid)], { encoding: "utf8" }); return r.status === 0; };
if (!victimAlive()) { console.error("B setup failed: victim not alive"); process.exit(1); }

// 伪造条目：pid 指向 sleep（cmdline 无 --user-data-dir）→ verifyOwnership 必败
// （schema 用真实字段名 launchedAt/status——readLedgerSync 会丢弃形状不对的条目）
const forged = [{ port: 9224, pid: victim.pid, profileDir: path.join(os.homedir(), ".cache", "lasso", "chrome-profile-default"), launchedAt: Date.now(), status: "ready" }];
fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
fs.writeFileSync(LEDGER, JSON.stringify(forged));
note(`B.forged ledger: pid=${victim.pid}(sleep) written`);

const csB = run("node", ["dist/index.js", "chrome-stop", "--port", "9224"]);
note(`B.chrome-stop: exit=${csB.code} out=${csB.out.trim().slice(0, 400)}`);
await new Promise(r => setTimeout(r, 500));
report.b.victim_survived = victimAlive();
report.b.ledger_after = readLedger();
note(`B.result: victim(sleep) survived=${victimAlive()} ledger=${JSON.stringify(readLedger())}`);
victim.kill("SIGKILL");
await new Promise(r => setTimeout(r, 300));

const after = meter.after();
report.after = { count: after.count, rssMb: mb(after.rssKb) };
report.released = meter.released(before, after);
note(`overall released=${report.released} after=${mb(after.rssKb)}MB/${after.count}procs`);

fs.writeFileSync(path.join(here, "v19-v2-chrome-stop.json"), JSON.stringify(report, null, 2));
process.exit(0);
