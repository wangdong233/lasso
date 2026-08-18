#!/usr/bin/env node
/** ft-round1 T-RT-03：SIGHUP 热更新 + T-RT-07 profile_list（无 Chrome 侧） */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stderrLog = path.join(here, "ft-sighup-stderr.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const providersFile = path.join(os.tmpdir(), "ft-providers.json");
fs.writeFileSync(providersFile, JSON.stringify({
  providers: [
    { name: "ft-hot-1", type: "api_key", endpoint_url: "https://example.invalid/x" },
  ],
}));

const client = new Client({ name: "ft-sighup", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  env: { ...process.env, LASSO_PROVIDERS_FILE: providersFile },
});
await client.connect(transport);

// transport 子进程 pid：StdioClientTransport->_spawn? 用 ps 找带该 env 的 server 不易；
// 改用 admin provider 视角验证 + 对 transport 的 child process 发 HUP。
// SDK transport 暴露 _process? 尝试常见字段。
const childPid =
  transport._process?.pid ?? transport._child?.pid ?? transport._transport?._process?.pid ?? null;

const out = { childPid };
try {
  // 1. HUP 前无 ft-hot-1
  const before = await client.callTool(
    { name: "admin", arguments: { action: "capability_list" } }, undefined, { timeout: 30000 });
  const beforeJ = JSON.parse(before.content[0].text);
  out.before_has_ft_hot_1 = JSON.stringify(beforeJ).includes("ft-hot-1");

  // 2. 发 SIGHUP（hot_plug）
  if (childPid) {
    process.kill(childPid, "SIGHUP");
    await sleep(1200);
  }
  const after = await client.callTool(
    { name: "admin", arguments: { action: "capability_list" } }, undefined, { timeout: 30000 });
  const afterJ = JSON.parse(after.content[0].text);
  out.after_has_ft_hot_1 = JSON.stringify(afterJ).includes("ft-hot-1");

  // 3. 坏 JSON：写坏文件再 HUP（不崩 + warn 日志）
  fs.writeFileSync(providersFile, "{broken!!");
  if (childPid) {
    process.kill(childPid, "SIGHUP");
    await sleep(1200);
  }
  const alive = await client.callTool(
    { name: "admin", arguments: { action: "serp_health" } }, undefined, { timeout: 30000 });
  out.server_alive_after_bad_json_hup = !!JSON.parse(alive.content[0].text).action;

  // 4. 删 provider（hot_unplug）
  fs.writeFileSync(providersFile, JSON.stringify({ providers: [] }));
  if (childPid) {
    process.kill(childPid, "SIGHUP");
    await sleep(1200);
  }
  const gone = await client.callTool(
    { name: "admin", arguments: { action: "capability_list" } }, undefined, { timeout: 30000 });
  out.after_remove_has_ft_hot_1 = JSON.stringify(JSON.parse(gone.content[0].text)).includes("ft-hot-1");

  // 5. T-RT-07：profile_list（本机无 9222 Chrome 活动会话的 configured 状态）
  const pl = await client.callTool(
    { name: "admin", arguments: { action: "profile_list" } }, undefined, { timeout: 30000 });
  const plJ = JSON.parse(pl.content[0].text);
  out.profile_list = { ok: plJ.ok, configured: plJ.configured, current: plJ.current ?? null, profiles: (plJ.profiles ?? []).length };
} finally {
  await transport.close();
  await sleep(400);
}
// stderr 日志证据
const log = fs.readFileSync(stderrLog, "utf8");
out.hot_plug_logged = /hot_plug|provider.*ft-hot-1/.test(log) || log.includes("ft-hot-1");
out.hot_unplug_logged = /hot_unplug/.test(log);
out.bad_json_logged = /parse|invalid|broken|reload_failed/i.test(log) && log.includes("SIGHUP") || /hot_reload/.test(log);
const sighupLines = log.split("\n").filter((l) => /sighup|hot_reload|providers_file/i.test(l)).slice(0, 6);
out.sighup_log_sample = sighupLines.map((l) => l.slice(0, 160));
console.log(JSON.stringify(out, null, 1));
