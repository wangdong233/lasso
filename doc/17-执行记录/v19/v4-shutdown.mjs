#!/usr/bin/env node
/**
 * v19 验证 V4：停机清理 —— server 退出 → launch 台账的 Chrome 被关闭。
 *
 * 两路：SIGTERM（优雅 shutdown：stopLaunchedChromes 3s race 先于 killAllSync）
 *       SIGKILL（exit 钩子不可达 → 残留（诚实记录，验证「优雅路径」承诺边界）……
 *       实际上 SIGKILL 无 exit 钩子——记录为设计边界，机制出口是 chrome-stop 兜底）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { ResourceMeter } from "../../../test/helpers/resource-meter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const LEDGER = path.join(os.homedir(), ".cache", "lasso", "launched-chromes.json");
const mb = (kb) => Math.round(kb / 1024);
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000, cwd: repoRoot });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const portOpen = (p) => spawnSync("nc", ["-z", "127.0.0.1", String(p)], { encoding: "utf8", timeout: 5000 }).status === 0;
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return []; } };

const report = {};
const note = (s) => { console.log(s); (report.steps ??= []).push(s); };

// ============ 路 A：SIGTERM 优雅停机（server 内部 stopLaunchedChromes）============
const PORT_A = 9228;
const meterA = new ResourceMeter();
const beforeA = meterA.before();
const lc = run("node", ["dist/index.js", "launch-chrome", "--port", String(PORT_A)]);
const la = JSON.parse(lc.out.slice(0, lc.out.indexOf("\n{")));
note(`A.launch-chrome 9228: pid=${la.pid}`);
await new Promise(r => setTimeout(r, 1500));

const stderrA = path.join(here, "v19-v4a-stderr.log");
try { fs.unlinkSync(stderrA); } catch {}
const client = new Client({ name: "v19-verify-v4", version: "1" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrA)}`],
  cwd: repoRoot,
});
await client.connect(transport);
// 起一个 headless 子进程（browse 一次）让 killAllSync 有东西可杀
const rb = await client.callTool({ name: "browse_headless", arguments: { url: "https://example.com/", action: "navigate" } }, undefined, { timeout: 90_000 });
note(`A.browse_headless: ${JSON.parse(rb.content[0].text).outcome}`);

// SIGTERM（StdioClientTransport close 走 SIGTERM；显式 kill 更可控——直接 close）
const t0 = Date.now();
await transport.close();
// 等 shutdown 完成
for (let i = 0; i < 20 && (portOpen(PORT_A) || meterA.peak()); i++) await new Promise(r => setTimeout(r, 500));
await new Promise(r => setTimeout(r, 2500));
const afterA = meterA.after();
report.a = {
  chrome_killed: !portOpen(PORT_A),
  ledger_after: readLedger(),
  ms: Date.now() - t0,
  after: { count: afterA.count, rssMb: mb(afterA.rssKb) },
  released: meterA.released(beforeA, afterA),
};
note(`A.after SIGTERM close: port_closed=${report.a.chrome_killed} ledger=${JSON.stringify(report.a.ledger_after)} released=${report.a.released} after=${report.a.after.rssMb}MB/${report.a.after.count}procs`);
const logsA = fs.readFileSync(stderrA, "utf8");
report.a.shutdown_log = logsA.split("\n").filter(l => /chrome_stop_result|lasso_shutdown|zombie_reaped|subproc_exit_kill/.test(l)).map(l => l.slice(0, 180)).slice(0, 8);
for (const l of report.a.shutdown_log) console.log("  " + l);

// ============ 路 B：SIGKILL 硬杀（exit 钩子同样不可达——真实边界记录）============
const PORT_B = 9229;
const lc2 = run("node", ["dist/index.js", "launch-chrome", "--port", String(PORT_B)]);
const la2 = JSON.parse(lc2.out.slice(0, lc2.out.indexOf("\n{")));
note(`B.launch-chrome 9229: pid=${la2.pid}`);
await new Promise(r => setTimeout(r, 1500));
const stderrB = path.join(here, "v19-v4b-stderr.log");
try { fs.unlinkSync(stderrB); } catch {}
const client2 = new Client({ name: "v19-verify-v4b", version: "1" });
const transport2 = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrB)}`],
  cwd: repoRoot,
});
await client2.connect(transport2);
// 直接 SIGKILL server 进程（找 lasso-server pid：transport 子进程树内 dist/index.js）
const psOut = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;
const zshPid = transport2.pid ?? null;
// 从 ps 里找 command 含 dist/index.js 且为 transport2 子孙的进程
const lines = psOut.split("\n").map(l => l.trim()).filter(Boolean);
const byPid = new Map(lines.map(l => { const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/); return m ? [Number(m[1]), { ppid: Number(m[2]), cmd: m[3] }] : null; }).filter(Boolean));
let serverPid = null;
for (const [pid, p] of byPid) {
  if (!p.cmd.includes("dist/index.js")) continue;
  let cur = pid, hops = 0;
  while (cur && hops < 16) { if (cur === zshPid) { serverPid = pid; break; } const pp = byPid.get(cur); if (!pp) break; cur = pp.ppid; hops++; }
  if (serverPid) break;
}
note(`B.server pid=${serverPid} (transport zsh=${zshPid})`);
if (serverPid) process.kill(serverPid, "SIGKILL");
await new Promise(r => setTimeout(r, 3000));
report.b = {
  chrome_killed: !portOpen(PORT_B),
  ledger_after: readLedger(),
  note: "SIGKILL 不可达 exit 钩子（Node 语义）——残留 Chrome 的机制出口是 chrome-stop 台账兜底",
};
note(`B.after SIGKILL: port_closed=${report.b.chrome_killed} ledger=${JSON.stringify(report.b.ledger_after)}`);
// chrome-stop 兜底收尾
const cs = run("node", ["dist/index.js", "chrome-stop", "--port", String(PORT_B)]);
note(`B.chrome-stop fallback: ${cs.out.replace(/\s+/g, " ").slice(0, 160)}`);
await new Promise(r => setTimeout(r, 2000));
report.b.fallback_closed = !portOpen(PORT_B);
note(`B.after fallback: port_closed=${report.b.fallback_closed}`);
try { await client2.close(); } catch {}
await new Promise(r => setTimeout(r, 1000));

fs.writeFileSync(path.join(here, "v19-v4-shutdown.json"), JSON.stringify(report, null, 2));
