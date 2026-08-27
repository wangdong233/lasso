#!/usr/bin/env node
/**
 * ft-r11-browse.mjs — R11 浏览与交互域主执行器（T-BROWSE 核心 + T-REFS + stealth 真机）
 *
 * 纪律（doc/17 §0.2）：串行执行 + 用例间 2s 间隔；每 call 计时；资源三采样；
 * 结果落 ft-r11-browse-out.json。单 server 会话（headless 子进程跨用例复用）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stderrLog = path.join(here, "ft-r11-browse-stderr.log");
const outFile = path.join(here, "ft-r11-browse-out.json");

// ---- 资源采样（复刻 resource-meter.ts 特征） ----
function resSample(tag) {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const procs = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: +m[1], ppid: +m[2], rssKb: +m[3], cmd: m[4] });
  }
  const matchRoot = (cmd) =>
    (cmd.includes("--user-data-dir=") && cmd.includes("lasso")) ? "udid" :
    (cmd.includes("chrome-devtools-mcp") && cmd.includes("--disable-blink-features")) ? "headless" :
    cmd.includes("dist/index.js") ? "server" : null;
  const roots = procs.filter((p) => matchRoot(p.cmd));
  const keep = new Set();
  for (const root of roots) {
    const frontier = [root.pid];
    while (frontier.length) {
      const cur = [...frontier];
      frontier.length = 0;
      for (const pid of cur) {
        if (keep.has(pid)) continue;
        keep.add(pid);
        for (const p of procs) if (p.ppid === pid) frontier.push(p.pid);
      }
    }
  }
  let rssKb = 0;
  for (const p of procs) if (keep.has(p.pid)) rssKb += p.rssKb;
  return { tag, at: new Date().toISOString(), count: keep.size, rssKb };
}

const results = [];
async function call(client, id, tool, args, opts = {}) {
  await new Promise((r) => setTimeout(r, 2000)); // §0.2 串行 2s 间隔
  const t0 = Date.now();
  let ms = 0;
  let entry;
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: Number(process.env.MCP_TIMEOUT_MS ?? 120000) });
    ms = Date.now() - t0;
    const text = res.content?.[0]?.text ?? "";
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* keep text */ }
    entry = { id, tool, args, ms, isError: !!res.isError, payload, text: payload ? undefined : text.slice(0, 400) };
  } catch (e) {
    entry = { id, tool, args, ms: Date.now() - t0, callError: String(e).slice(0, 300) };
  }
  if (opts.resTag) entry.res = resSample(opts.resTag);
  results.push(entry);
  const p = entry.payload;
  const brief = p ? `outcome=${p.outcome} err=${p.error ?? "-"} prev=${String(p.data?.preview ?? "").slice(0, 80).replace(/\n/g, " ")}` : (entry.callError ?? entry.text ?? "");
  console.log(`[${id}] ${tool} ${ms}ms :: ${brief}`);
  return entry;
}

const client = new Client({ name: "lasso-ft-r11", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  env: { ...process.env },
});

const R = { beforeServer: resSample("before-server"), cases: [], peak: null, afterShutdown: null };
await client.connect(transport);

try {
  // ============ Batch A：T-BROWSE 核心 ============
  await call(client, "A01-T-BROWSE-01a-navigate", "browse_headless", { url: "https://example.com", action: "navigate" }, { resTag: "A01-after-first-browse-peak" });
  await call(client, "A02-T-BROWSE-02-snapshot", "browse_headless", { url: "https://example.com", action: "snapshot" });
  await call(client, "A03-T-BROWSE-03-extract-raw", "browse_headless", { url: "https://example.com", action: "extract" });
  await call(client, "A04-T-BROWSE-04-extract-md", "browse_headless", { url: "https://example.com", action: "extract", options: { extract_mode: "markdown" } });
  await call(client, "A05-T-BROWSE-05-cited", "browse_headless", { url: "https://news.ycombinator.com", action: "navigate" });
  await call(client, "A05b-cited-extract", "browse_headless", { url: "https://news.ycombinator.com", action: "extract", options: { extract_mode: "markdown_cited" } });
  await call(client, "A06-T-BROWSE-08-wait", "browse_headless", { url: "https://example.com", action: "wait", options: { expect: { text: "Example Domain" } } });
  await call(client, "A06b-wait-missing", "browse_headless", { url: "https://example.com", action: "wait", options: {} });
  await call(client, "A07-T-BROWSE-09-eval-webdriver", "browse_headless", { url: "https://example.com", action: "evaluate", options: { js: "return navigator.webdriver" } });
  await call(client, "A08-T-BROWSE-32-stealth-trio", "browse_headless", { url: "https://example.com", action: "evaluate", options: { js: "return JSON.stringify({langs: navigator.languages.join(','), hc: navigator.hardwareConcurrency, plat: navigator.platform})" } });
  await call(client, "A09-T-BROWSE-01b-404", "browse_headless", { url: "https://example.com/lasso-ft-404-missing", action: "navigate" });
  await call(client, "A10-T-BROWSE-01c-nxdomain", "browse_headless", { url: "https://nonexistent-lasso-ft-20260818.invalid/", action: "navigate" });
  await call(client, "A11-T-BROWSE-17-ssrf-nav", "browse_headless", { url: "http://192.168.1.1/", action: "navigate" });
  await call(client, "A11b-ssrf-pdf", "pdf", { url: "http://192.168.1.1/" });
  await call(client, "A11c-ssrf-screenshot", "screenshot", { url: "http://192.168.1.1/" });
  await call(client, "A11d-ssrf-network", "network", { url: "http://192.168.1.1/", options: { filter: "all" } });
  await call(client, "A12-T-BROWSE-27-unknown-action", "browse_headless", { url: "https://example.com", action: "foo" });
  await call(client, "A13-T-BROWSE-10-pdf", "pdf", { url: "https://example.com", options: { format: "A4", landscape: false } });
  await call(client, "A14-T-BROWSE-11-network", "network", { url: "https://example.com", options: { filter: "all" } });
  await call(client, "A15a-net-3p-nav", "browse_headless", { url: "https://www.selenium.dev/", action: "navigate" });
  await call(client, "A15b-T-BROWSE-29-3p", "network", { url: "https://www.selenium.dev/", options: { filter: "3rd-party" } });
  await call(client, "A16a-T-BROWSE-13-shot-tool", "screenshot", { url: "https://example.com", options: { full_page: true } });
  await call(client, "A16b-shot-region", "screenshot", { url: "https://example.com", options: { region: { x: 10, y: 10, width: 200, height: 100 } } });
  await call(client, "A16c-shot-action", "browse_headless", { url: "https://example.com", action: "screenshot" });
  await call(client, "A17a-console-log-eval", "browse_headless", { url: "https://example.com", action: "evaluate", options: { js: "console.log('lasso-ft-console-marker'); return 1" } });
  await call(client, "A17b-T-BROWSE-12-console", "browse_headless", { url: "https://example.com", action: "console" });

  // ============ Batch B：T-REFS（books.toscrape） ============
  await call(client, "B00-refs-nav", "browse_headless", { url: "https://books.toscrape.com/", action: "navigate" });
  await call(client, "B01-T-REFS-02-refs-on", "browse_headless", { url: "https://books.toscrape.com/", action: "extract", options: { extract_mode: "markdown", include_refs: true } });
  await call(client, "B02-T-REFS-03-refs-off", "browse_headless", { url: "https://books.toscrape.com/", action: "extract", options: { extract_mode: "markdown" } });
  await call(client, "B05-T-REFS-08-raw-refs", "browse_headless", { url: "https://books.toscrape.com/", action: "extract", options: { extract_mode: "raw", include_refs: true } });

  // T-BROWSE-28 + T-REFS-04 长页（维基百科长条目）
  await call(client, "C00-wiki-nav", "browse_headless", { url: "https://en.wikipedia.org/wiki/Chromium_(web_browser)", action: "navigate" });
  await call(client, "C01-T-BROWSE-28-cap", "browse_headless", { url: "https://en.wikipedia.org/wiki/Chromium_(web_browser)", action: "extract", options: { extract_mode: "markdown" } });
  await call(client, "C02-T-REFS-04-cap-refs", "browse_headless", { url: "https://en.wikipedia.org/wiki/Chromium_(web_browser)", action: "extract", options: { extract_mode: "markdown", include_refs: true } });

  // T-BROWSE-31 markdown 引擎 + URL 透传（GitHub repo 页，站点 extractor + 链接绝对化）
  await call(client, "D00-gh-nav", "browse_headless", { url: "https://github.com/microsoft/vscode", action: "navigate" });
  await call(client, "D01-T-BROWSE-31-engine", "browse_headless", { url: "https://github.com/microsoft/vscode", action: "extract", options: { extract_mode: "markdown" } });

  // T-BROWSE-33 会话语义：extract 单发不导航（当前页仍 wiki）
  await call(client, "E01-T-BROWSE-33-extract-no-nav", "browse_headless", { url: "https://example.org", action: "extract", options: { extract_mode: "markdown" } });

  // T-BROWSE-14 steps 链（MCP schema v1.8 已含 steps）
  await call(client, "F01-T-BROWSE-14-steps", "browse_headless", {
    url: "https://books.toscrape.com/",
    action: "navigate",
    options: {
      steps: [
        { action: "navigate", label: "go" },
        { action: "extract", options: { extract_mode: "markdown" }, label: "read", expect: { text: "books", timeout_ms: 15000 } },
      ],
    },
  });

  // T-REFS-05 ref→click 往返（books.toscrape 侧栏分类链接）
  await call(client, "G00-refs2-nav", "browse_headless", { url: "https://books.toscrape.com/", action: "navigate" });
  await call(client, "G01-refs2-extract", "browse_headless", { url: "https://books.toscrape.com/", action: "extract", options: { extract_mode: "markdown", include_refs: true } });
  await call(client, "G02-T-REFS-05-ref-click", "browse_headless", { url: "https://books.toscrape.com/", action: "click", options: { selectors: { click: "r1" } } });
  await call(client, "G03-click-verify", "browse_headless", { url: "https://books.toscrape.com/", action: "snapshot" });
  await call(client, "G04-ref-stale", "browse_headless", { url: "https://books.toscrape.com/", action: "click", options: { selectors: { click: "r77" } } });

  // T-REFS-06 ref→fill（the-internet 登录表单）
  await call(client, "H00-form-nav", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "navigate" });
  await call(client, "H01-form-extract", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "extract", options: { extract_mode: "markdown", include_refs: true } });
  await call(client, "H02-T-REFS-06-ref-fill", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "fill", options: { selectors: { r1: "tomsmith", r2: "SuperSecretPassword!" } } });
  await call(client, "H03-fill-login-click", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "extract", options: { extract_mode: "markdown", include_refs: true } });
} finally {
  R.peak = resSample("peak-before-shutdown");
  await transport.close();
  await new Promise((r) => setTimeout(r, 2500)); // 给退出钩子/树杀时间
  R.afterShutdown = resSample("after-shutdown");
  fs.writeFileSync(outFile, JSON.stringify({ resources: R, results }, null, 1));
  console.log("RESOURCES:", JSON.stringify({ before: R.beforeServer, peak: R.peak, after: R.afterShutdown }, null, 1));
  console.log("WROTE", outFile);
}
