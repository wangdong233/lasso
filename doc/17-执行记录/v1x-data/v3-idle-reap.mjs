// V3 用完即关真机验证：server 进程内 chrome idle reaper
// 场景：
//  A5-lite  既有台账 port 9225（rec.idleMs=60000，launchedAt 已 7min+）+ 全局 2000
//           → per-record 覆盖应存活 ≥35s（若覆盖失效首个 tick 即死）
//  A3-lite  新台账 port 9226（--idle-ms 2000）→ 15s tick 内被 reap
// 采样：0/10/20/35s 台账 + 两端口进程存活
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import * as fs from "node:fs";

const LEDGER = process.env.HOME + "/.cache/lasso/launched-chromes.json";
const ERRLOG = "/Users/wangdong/Documents/Project/cc-control-all/lasso/doc/17-执行记录/v1x-data/v3-server-stderr.log";
const OUT = "/Users/wangdong/Documents/Project/cc-control-all/lasso/doc/17-执行记录/v1x-data/v3-idle-reap.json";

const sample = (t) => ({
  t,
  ledger: JSON.parse(fs.readFileSync(LEDGER, "utf8")),
  p9225: execSync("pgrep -f 'remote-debugging-port=9225' | wc -l").toString().trim(),
  p9226: execSync("pgrep -f 'remote-debugging-port=9226' | wc -l").toString().trim(),
});

// 1. 新起 9226（--idle-ms 2000；隔离 profile——与 9225 同 user-data-dir 会触发
//    Chrome 单例转发 chrome_exited，见 v1x 文档「并行多开须 --profile 隔离」）
const launchOut = execSync(
  "node dist/index.js launch-chrome --port 9226 --idle-ms 2000 --profile /tmp/lasso-v110-profile-9226",
  { cwd: "/Users/wangdong/Documents/Project/cc-control-all/lasso", encoding: "utf8" },
);
const launched = JSON.parse(launchOut.slice(launchOut.indexOf("{")));

// 2. 起 server（全局 LASSO_LAUNCH_IDLE_MS=2000；reaper 只活在 server 进程）
const err = fs.openSync(ERRLOG, "w");
const server = spawn("node", ["dist/index.js"], {
  cwd: "/Users/wangdong/Documents/Project/cc-control-all/lasso",
  env: { ...process.env, LASSO_LAUNCH_IDLE_MS: "2000" },
  stdio: ["pipe", "pipe", err],
});
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v1x-verify", version: "1.0" } } }) + "\n");
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const samples = [sample(0)];
for (const t of [10, 20, 35]) {
  await new Promise((r) => setTimeout(r, t === 10 ? 10000 : 10000));
  samples.push(sample(t));
}
server.kill();
fs.closeSync(err);

const verdict = {
  launched9226: { pid: launched.pid, idleMsArg: 2000 },
  samples,
  a3_reaped_9226: samples.at(-1).p9226 === "0" && !samples.at(-1).ledger.some((r) => r.port === 9226),
  a5_survived_9225: samples.every((s) => s.p9225 !== "0"),
  reapLatency: (() => {
    const gone = samples.find((s) => s.t > 0 && s.p9226 === "0");
    return gone ? `<=${gone.t}s` : "not reaped";
  })(),
  stderrEvents: fs.readFileSync(ERRLOG, "utf8").split("\n").filter((l) => l.includes("chrome_idle_reaped") || l.includes("chrome_stop_result") || l.includes("reaper")),
};
fs.writeFileSync(OUT, JSON.stringify(verdict, null, 2));
console.log(JSON.stringify(verdict, null, 2));
process.exit(0);
