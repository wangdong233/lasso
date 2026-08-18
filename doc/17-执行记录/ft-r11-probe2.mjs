#!/usr/bin/env node
/**
 * ft-r11-probe2.mjs — R11 二轮聚焦探针：
 *  W1/W2 wait 语义与计时（30s 全烧之谜 + timeout_ms 是否被 honor）
 *  R1 the-internet ref 注入持久性 + ref→fill 正路径（r2/r3 输入框）
 *  S1/S2 steps 链正路径（expect 命中）+ timeout honor
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outFile = path.join(here, "ft-r11-probe2-out.json");
const results = [];

async function call(client, id, tool, args) {
  await new Promise((r) => setTimeout(r, 2000));
  const t0 = Date.now();
  let ms = 0;
  let entry;
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90000 });
    ms = Date.now() - t0;
    const text = res.content?.[0]?.text ?? "";
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    entry = { id, tool, args, ms, isError: !!res.isError, payload };
  } catch (e) {
    entry = { id, tool, args, ms: Date.now() - t0, callError: String(e).slice(0, 300) };
  }
  results.push(entry);
  const p = entry.payload;
  console.log(`[${id}] ${ms}ms :: ${p ? `outcome=${p.outcome} err=${p.error ?? "-"} prev=${String(p.data?.preview ?? "").slice(0, 100).replace(/\n/g, " ")}` : entry.callError}`);
  return entry;
}

const client = new Client({ name: "lasso-ft-r11-p2", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", "exec node dist/index.js 2>>doc/17-执行记录/ft-r11-probe2-stderr.log"],
  cwd: repoRoot,
  env: { ...process.env },
});
await client.connect(transport);
try {
  // W1: 文本在场 → 应快速返回
  await call(client, "W1-nav", "browse_headless", { url: "https://example.com", action: "navigate" });
  await call(client, "W1-wait-present", "browse_headless", { url: "https://example.com", action: "wait", options: { expect: { text: "Example Domain" } } });
  // W2: 文本不在场 + 显式短 timeout_ms → 观察 outcome 与耗时
  await call(client, "W2-wait-absent-3s", "browse_headless", { url: "https://example.com", action: "wait", options: { expect: { text: "Absolutely Not Present Text 12345", timeout_ms: 3000 } } });

  // R1: the-internet 注入持久性 + 正确的输入框 ref 填充
  await call(client, "R1-nav", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "navigate" });
  await call(client, "R1-extract", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "extract", options: { extract_mode: "markdown", include_refs: true } });
  await call(client, "R1-attr-count", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "evaluate", options: { js: "return JSON.stringify({n: document.querySelectorAll('[data-lasso-uid]').length, first: document.querySelector('[data-lasso-uid]')?.tagName, loc: location.href})" } });
  await call(client, "R1-fill-r2r3", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "fill", options: { selectors: { r2: "tomsmith", r3: "SuperSecretPassword!" } } });
  await call(client, "R1-values", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "evaluate", options: { js: "return JSON.stringify({u: document.querySelector('input[type=text]')?.value, p: document.querySelector('input[type=password]')?.value ? 'SET' : 'EMPTY'})" } });
  await call(client, "R1-click-r4-login", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "click", options: { selectors: { click: "r4" } } });
  await call(client, "R1-after-login", "browse_headless", { url: "https://the-internet.herokuapp.com/login", action: "snapshot" });

  // S1: steps 正路径（expect 命中）
  await call(client, "S1-steps-ok", "browse_headless", {
    url: "https://books.toscrape.com/",
    action: "navigate",
    options: {
      steps: [
        { action: "navigate", label: "go" },
        { action: "snapshot", label: "look", expect: { text: "All products", timeout_ms: 10000 } },
      ],
    },
  });
  // S2: steps expect 超时（timeout honor）
  await call(client, "S2-steps-timeout", "browse_headless", {
    url: "https://books.toscrape.com/",
    action: "navigate",
    options: {
      steps: [
        { action: "navigate", label: "go" },
        { action: "snapshot", label: "look", expect: { text: "Definitely Not Here XYZ", timeout_ms: 3000 } },
      ],
    },
  });
} finally {
  await transport.close();
  await new Promise((r) => setTimeout(r, 2000));
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
  console.log("WROTE", outFile);
}
