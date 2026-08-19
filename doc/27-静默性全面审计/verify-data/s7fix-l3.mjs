#!/usr/bin/env mjs
// L3 真机验证：S-7 修复机制（doc/27 fix.md F-1）在真实 Chrome + 真实上游 1.7.0 下的行为。
// 纪律：隔离临时 profile + --no-startup-window + --mute-audio（零窗口零声音）；
//       串行 + 前台基线前后采样 + 结束清理（kill pid + 删临时目录 + 端口复核）。
//
// 验证点：
//  V1 select_page{pageId}（不带 bringToFront）不抢 OS frontmost、不激活窗口
//  V2 lasso 流程后 pages[0]（替身"用户 tab"）内容不被改写（S-7 修复核心断言）
//  V3 自建 tab 被 navigate 到目标 URL；会话页归属正确
//  V4 窗口计数恒 0；全进程 cmdline 含 --mute-audio
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const PORT = 9231;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const frontmost = () =>
  spawnSync(
    "osascript",
    ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
    { encoding: "utf8" },
  ).stdout.trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const listPages = async () =>
  (await httpJson("/json/list")).filter((t) => t.type === "page");

const result = { baseline_frontmost: frontmost() };

// ---------- 1. 起「替身用户 Chrome」（非 lasso 台账 = 无 ledger 记录） ----------
const profileDir = mkdtempSync(path.join(tmpdir(), "lasso-s7fix-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  "--no-startup-window",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
], { detached: true, stdio: "ignore" });
chrome.unref();
result.chrome_pid = chrome.pid;

// 等端口就绪
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try { await httpJson("/json/version"); ready = true; break; } catch {}
}
if (!ready) { console.error("chrome_not_ready"); process.exit(1); }

// ---------- 2. 预置两个「用户 tab」（WS createTarget background:true，零激活） ----------
// 用一次性 WS（复用 lasso 同款 undici WebSocket 手法太重，这里用 CDP HTTP 的
// 替代：Target.createTarget 必须经 WS；用 node 内置手写最小 WS 客户端不可行——
// 改用 npx chrome-devtools-mcp 的 createTarget 不暴露 → 用 /json/list 观察 +
// puppeteer-core? 无依赖环境 → 简化：用 Chrome 的 PUT /json/new?background 不存在。
// 最稳妥零依赖路径：启动时直接给 Chrome 传两个初始 URL（--no-startup-window 与
// 初始 URL 互斥）→ 改为不传 --no-startup-window，用 --window-position 离屏?  会抢焦。
// ——最终方案：先用 CDP WS（undici 在 lasso node_modules 里可用）。
const { WebSocket } = await import(
  path.join(process.env.LASSO_ROOT, "node_modules/undici/index.js")
);
const ver = await httpJson("/json/version");
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
  if (typeof msg.id !== "number") return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
});
const cdp = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const mkTab = async (url) =>
  (await cdp("Target.createTarget", { url, background: true })).targetId;
const userTabA = await mkTab("https://example.org/"); // pages[0]（替身用户首 tab）
const userTabB = await mkTab("https://example.com/");
await sleep(500);
result.tabs_before = (await listPages()).map((t) => ({ id: t.id.slice(0, 8), url: t.url }));
result.user_tab_a_url_before = (await listPages()).find((t) => t.id === userTabA)?.url;

// ---------- 3. 连上游 cdm 1.7.0（lasso 同款）并执行 lasso 修复流程 ----------
const cdm = spawn(
  "npx",
  ["-y", "chrome-devtools-mcp@1.7.0", `--browser-url=http://localhost:${PORT}`, "--no-usage-statistics"],
  { stdio: ["pipe", "pipe", "pipe"] },
);
result.cdm_pid = cdm.pid;
let buf = "";
const reads = [];
const readMsg = () =>
  new Promise((resolve) => {
    if (reads.length) return resolve(reads.shift());
    const on = (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) reads.push(JSON.parse(line));
      }
      if (reads.length) { cdm.stdout.off("data", on); resolve(reads.shift()); }
    };
    cdm.stdout.on("data", on);
  });
let rpcId = 1;
const rpc = async (method, params) => {
  cdm.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) + "\n");
  for (;;) {
    const msg = await readMsg();
    if (msg.id === rpcId - 1) return msg.result ?? msg.error;
    // notifications (logging) 跳过
  }
};
await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "s7fix-l3", version: "1.0.0" },
});
await rpc("notifications/initialized", {});

const callTool = (name, args) =>
  rpc("tools/call", { name, arguments: args });

// 3a. before-list（上游 1.7.0 真实文本格式）
const beforeText = await callTool("list_pages", {});
const parse = (r) => {
  const text = (r.content ?? []).map((b) => b.text ?? "").join("\n");
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+):\s+(.*)$/);
    if (m) out.push({ pageId: +m[1], selected: /\[selected\]/.test(m[2]), raw: m[2] });
  }
  return out;
};
const before = parse(beforeText);
result.upstream_before = before.map((p) => ({ ...p, raw: p.raw.slice(0, 60) }));
const beforeSel = before.find((p) => p.selected);
result.upstream_selected_at_connect = beforeSel?.pageId ?? null; // 预期 = pages[0] = 用户 tab

// 3b. lasso 流程：WS createTarget{background:true}（E7 原语）
const ownTargetId = (await cdp("Target.createTarget", { url: "about:blank", background: true })).targetId;

// 3c. after-list + id-diff（两轮 300ms 重试——与 lasso 实装同款容错）
let news = [];
let afterTextRaw = "";
for (let attempt = 0; attempt < 3 && news.length === 0; attempt++) {
  if (attempt > 0) await sleep(300);
  const r = await callTool("list_pages", {});
  afterTextRaw = (r.content ?? []).map((b) => b.text ?? "").join("\n");
  const after = parse(r);
  const beforeIds = new Set(before.map((p) => p.pageId));
  news = after.filter((p) => !beforeIds.has(p.pageId));
  result.id_diff_attempts = attempt + 1;
}
result.id_diff_news = news.map((p) => p.pageId);
result.after_list_raw_first3 = afterTextRaw.split("\n").slice(0, 5);
if (news.length !== 1) {
  result.verdict_preliminary = "diff_not_unique";
  console.log(JSON.stringify(result, null, 2));
  // 清理后退出
  try { cdm.kill("SIGKILL"); } catch {}
  try { ws.close(); } catch {}
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exit(2);
}

// 3d. select_page{pageId} 不带 bringToFront（S-7 修复唯一新原语）
const fmBeforeSelect = frontmost();
const selR = await callTool("select_page", { pageId: news[0].pageId });
await sleep(1000); // 立即+1s 双采
result.fm_before_select = fmBeforeSelect;
result.fm_after_select = frontmost();
result.select_result_isError = selR?.isError ?? null;

// 3e. navigate（lasso 主操作）→ 断言落在自建 tab、用户 tab 不动
const navR = await callTool("navigate_page", { type: "url", url: "https://example.com/?s7fix=l3" });
await sleep(1200);
const pagesAfter = await listPages();
result.user_tab_a_url_after = pagesAfter.find((t) => t.id === userTabA)?.url;
result.user_tab_b_url_after = pagesAfter.find((t) => t.id === userTabB)?.url;
result.own_tab_url_after = pagesAfter.find((t) => t.id === ownTargetId)?.url;
result.nav_isError = navR?.isError ?? null;
result.fm_after_nav = frontmost();

// 3f. 上游选中页 = 自建页（navigate 后 list 的 [selected] 标记）
const final = parse(await callTool("list_pages", {}));
result.upstream_selected_after = final.find((p) => p.selected)?.pageId ?? null;

// ---------- 4. 窗口/静音复核 ----------
const winCount = spawnSync("osascript", ["-e",
  'tell application "System Events" to tell process "Google Chrome" to count windows'],
  { encoding: "utf8" }).stdout.trim();
result.chrome_windows = winCount;
const cmdl = spawnSync("ps", ["-p", String(chrome.pid), "-o", "command="], { encoding: "utf8" }).stdout;
result.chrome_mute_flag = cmdl.includes("--mute-audio");

// ---------- 5. 清理 ----------
cdm.kill("SIGKILL");
ws.close();
try { process.kill(-chrome.pid, "SIGKILL"); } catch { try { chrome.kill("SIGKILL"); } catch {} }
await sleep(800);
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
let portFreed = false;
try { await fetch(`http://127.0.0.1:${PORT}/json/version`); } catch { portFreed = true; }
result.port_freed = portFreed;
result.residual_pids = spawnSync("pgrep", ["-f", `user-data-dir=${profileDir}`], { encoding: "utf8" }).stdout.trim();
result.fm_final = frontmost();

console.log(JSON.stringify(result, null, 2));
