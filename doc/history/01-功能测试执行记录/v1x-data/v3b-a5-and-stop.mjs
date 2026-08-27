// V3b A5 严格版 + chrome-stop 显式出口
//  A5     新起 9227（rec.idleMs=60000，launchedAt=now）+ server 全局 2000
//         → 20s 时记录年龄 <60s 必须存活；若 reaper 误用全局 2000 则首个 tick(15s)即死
//  EXIT   20s 存活判定后 chrome-stop --port 9227 显式关 → 台账清 + 进程灭
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";

const LEDGER = process.env.HOME + "/.cache/lasso/launched-chromes.json";
const D = "/Users/wangdong/Documents/Project/cc-control-all/lasso/doc/17-执行记录/v1x-data";
const REPO = "/Users/wangdong/Documents/Project/cc-control-all/lasso";

const sample = (t) => ({
  t,
  ledger9227: JSON.parse(fs.readFileSync(LEDGER, "utf8")).filter((r) => r.port === 9227),
  p9227: execSync("pgrep -f 'remote-debugging-port=9227' | wc -l").toString().trim(),
});

const launchOut = execSync(
  "node dist/index.js launch-chrome --port 9227 --profile /tmp/lasso-v110-profile-9227",
  { cwd: REPO, encoding: "utf8" },
);
const launched = JSON.parse(launchOut.slice(launchOut.indexOf("{")));

const err = fs.openSync(D + "/v3b-server-stderr.log", "w");
const server = spawn("node", ["dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, LASSO_LAUNCH_IDLE_MS: "2000" },
  stdio: ["pipe", "pipe", err],
});
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v1x-verify", version: "1.0" } } }) + "\n");
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const samples = [sample(0)];
await new Promise((r) => setTimeout(r, 20000));
samples.push(sample(20));
server.kill();
fs.closeSync(err);

const a5_survived = samples[1].p9227 !== "0" && samples[1].ledger9227.length === 1;

// chrome-stop 显式出口（对 9227）
const stopOut = execSync("node dist/index.js chrome-stop --port 9227", { cwd: REPO, encoding: "utf8" });
await new Promise((r) => setTimeout(r, 1500));
const after = {
  stopStdout: stopOut.slice(stopOut.indexOf("{")),
  ledger9227: JSON.parse(fs.readFileSync(LEDGER, "utf8")).filter((r) => r.port === 9227),
  p9227: execSync("pgrep -f 'remote-debugging-port=9227' | wc -l").toString().trim(),
};
const verdict = { launched9227: { pid: launched.pid, ledgerIdleMs: samples[0].ledger9227[0]?.idleMs }, samples, a5_perRecordOverride_survived20s: a5_survived, explicitChromeStop: after };
fs.writeFileSync(D + "/v3b-a5-and-stop.json", JSON.stringify(verdict, null, 2));
console.log(JSON.stringify(verdict, null, 2));
process.exit(0);
