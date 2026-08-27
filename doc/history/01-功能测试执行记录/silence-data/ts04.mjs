#!/usr/bin/env node
/** T-SILENCE-04 执行器 — launch-chrome hidden：零窗口/前台不动/flags 断言/Dock=已知边界
 * （+ T-SILENCE-07 hidden 侧）。流程：launch → 采样 → ps flags → chrome-stop → 终态复核。 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const { frontmost, chromeAsns, sleep } = await import(
  path.join(repoRoot, "doc/27-静默性全面审计/verify-data/probe.mjs")
);
const PORT = 9235;
const windowsOf = (pid) =>
  spawnSync("osascript", ["-e",
    `tell application "System Events" to count windows of (first application process whose unix id is ${pid})`],
    { encoding: "utf8" }).stdout.trim();
const httpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const sh = (cmd) => spawnSync("sh", ["-c", cmd], { encoding: "utf8" }).stdout.trim();

const result = { case: ["T-SILENCE-04", "T-SILENCE-07(hidden)"], port: PORT };
result.fm_before = frontmost();
result.fg_asn_before = chromeAsns().chromeForeground;

// ---- launch hidden ----
const t0 = Date.now();
const launch = spawnSync("node", [path.join(repoRoot, "dist/index.js"),
  "launch-chrome", "--mode", "hidden", "--port", String(PORT)], { encoding: "utf8", timeout: 60000 });
result.launch_ms = Date.now() - t0;
result.launch_exit = launch.status;
try { result.launch_json = JSON.parse(launch.stdout); } catch { result.launch_stdout = launch.stdout.slice(0, 200); }
const pid = result.launch_json?.pid ?? null;
result.pid = pid;
await sleep(1000);
result.fm_after_launch = frontmost();          // ① 前台不动
result.fg_asn_after = chromeAsns().chromeForeground; // ③ Dock（预期 +1 = 已知边界）
result.windows_of_pid = pid ? windowsOf(pid) : null; // ② 零窗口

// ---- flags（T-SILENCE-04 ④ + T-SILENCE-07 hidden 侧：活进程 cmdline 断言） ----
const cmdline = pid ? sh(`ps -o command= -p ${pid}`) : "";
result.ts04_flags = {
  no_startup_window: cmdline.includes("--no-startup-window"),
  mute_audio: cmdline.includes("--mute-audio"),
  no_first_run: cmdline.includes("--no-first-run"),
  no_default_browser_check: cmdline.includes("--no-default-browser-check"),
  remote_debugging_port: cmdline.includes(`--remote-debugging-port=${PORT}`),
};
result.cmdline_head = cmdline.slice(0, 180);

// ---- page targets = 0 ----
try {
  const list = await httpJson("/json/list");
  result.page_targets = list.filter((t) => t.type === "page").length;
  result.all_target_types = [...new Set(list.map((t) => t.type))];
} catch (e) { result.page_targets_error = String(e.message).slice(0, 80); }

// ---- ledger ----
result.ledger_during = sh(`cat ~/.cache/lasso/launched-chromes.json 2>/dev/null | head -c 300`);

// ---- chrome-stop ----
await sleep(2000);
const stop = spawnSync("node", [path.join(repoRoot, "dist/index.js"), "chrome-stop", "--port", String(PORT)],
  { encoding: "utf8", timeout: 60000 });
result.stop_exit = stop.status;
result.stop_stdout = stop.stdout.trim().slice(0, 300);
await sleep(1500);
result.pid_alive_after_stop = pid ? sh(`ps -p ${pid} -o pid=`).length > 0 : null;
result.port_freed = await (async () => { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return false; } catch { return true; } })();
result.ledger_after = sh(`cat ~/.cache/lasso/launched-chromes.json 2>/dev/null | head -c 200`);
result.fg_asn_final = chromeAsns().chromeForeground;
result.fm_final = frontmost();

fs.writeFileSync(path.join(here, "ts04-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
