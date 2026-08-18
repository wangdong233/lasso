#!/usr/bin/env node
/**
 * ft-r11-cost.mjs — L-COST-04（browse_headless 搜索兜底）+ L-COST-14（include_refs 开销 A/B）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const out = [];
const client = new Client({ name: "lasso-ft-r11-cost", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", "exec node dist/index.js 2>>doc/17-执行记录/ft-r11-cost-stderr.log"],
  cwd: repoRoot, env: { ...process.env },
});
async function call(id, tool, args) {
  await new Promise((r) => setTimeout(r, 2000));
  const t0 = Date.now();
  const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90000 });
  const ms = Date.now() - t0;
  const p = JSON.parse(res.content?.[0]?.text ?? "{}");
  out.push({ id, ms, payload: p });
  console.log(`[${id}] ${ms}ms outcome=${p.outcome} prev=${String(p.data?.preview ?? "").slice(0, 70).replace(/\n/g, " ")}`);
  return { ms, p };
}
await client.connect(transport);
try {
  // L-COST-04：browse_headless 搜索兜底（百度 SERP 直访，观察验证码/结果条数）
  const t0 = Date.now();
  const n1 = await call("C4-1-nav-baidu", "browse_headless", { url: "https://www.baidu.com/s?wd=lasso+mcp+github", action: "navigate" });
  const n2 = await call("C4-2-extract-baidu", "browse_headless", { url: "https://www.baidu.com/s?wd=lasso+mcp+github", action: "extract", options: { extract_mode: "markdown" } });
  const md = n2.p.data?.markdown ?? "";
  const resultHints = (md.match(/result[-_ ]?c-/g) ?? []).length;
  const captcha = /安全验证|百度安全验证|wappass/.test(md);
  console.log(`L-COST-04: nav ${n1.ms}ms + extract ${n2.ms}ms; md_len=${md.length}; result_hints=${resultHints}; captcha=${captcha}`);

  // L-COST-14：github 同页 A/B ×3（先导航一次，随后交替 refs off/on）
  await call("C14-nav", "browse_headless", { url: "https://github.com/microsoft/vscode", action: "navigate" });
  const deltas = [];
  for (let i = 1; i <= 3; i++) {
    const off = await call(`C14-${i}a-off`, "browse_headless", { url: "https://github.com/microsoft/vscode", action: "extract", options: { extract_mode: "markdown" } });
    const on = await call(`C14-${i}b-refs`, "browse_headless", { url: "https://github.com/microsoft/vscode", action: "extract", options: { extract_mode: "markdown", include_refs: true } });
    deltas.push(on.ms - off.ms);
    const m = on.p.data?.markdown ?? "";
    console.log(`  pair${i}: off=${off.ms}ms(${(off.p.data?.markdown ?? "").length}B) on=${on.ms}ms(${m.length}B) delta=${on.ms - off}ms`.replace("off=", "off="));
  }
  console.log("L-COST-14 deltas:", JSON.stringify(deltas));
} finally {
  await transport.close();
  await new Promise((r) => setTimeout(r, 1500));
  fs.writeFileSync(path.join(here, "ft-r11-cost-out.json"), JSON.stringify(out, null, 1));
}
