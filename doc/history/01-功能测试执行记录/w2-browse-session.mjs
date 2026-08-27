import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "w2-browse", version: "1.0.0" });
const t = new StdioClientTransport({ command: "/bin/zsh", args: ["-c", "exec node dist/index.js 2>>/Users/wangdong/Documents/Project/cc-control-all/lasso/doc/17-执行记录/w2-browse-stderr.log"], cwd: "/Users/wangdong/Documents/Project/cc-control-all/lasso", env: { ...process.env } });
await c.connect(t);
async function call(label, args) {
  const t0 = Date.now();
  try {
    const r = await c.callTool({ name: "browse_headless", arguments: args }, undefined, { timeout: 120000 });
    const m = JSON.parse(r.content[0].text);
    console.log(`### ${label} [${Date.now()-t0}ms] isError=${r.isError} outcome=${m.outcome} error=${m.error ?? "-"}`);
    console.log("data:", JSON.stringify(m.data).slice(0, 700));
  } catch (e) { console.log(`### ${label} THREW: ${String(e).slice(0,200)}`); }
}
// 单会话：navigate → evaluate（stealth 生效性）
await call("nav", { url: "https://example.com", action: "navigate" });
await call("eval-webdriver", { url: "https://example.com", action: "evaluate", options: { js: "return navigator.webdriver" } });
await call("eval-multi", { url: "https://example.com", action: "evaluate", options: { js: "return [typeof navigator.webdriver, navigator.languages.join(','), navigator.hardwareConcurrency, navigator.plugins.length, navigator.userAgent.slice(0,60)].join(' | ')" } });
// steps 链（D2 修复验证）
await call("steps-chain", { url: "https://example.com", action: "navigate", options: { steps: [
  { action: "snapshot", label: "snap" },
  { action: "wait", expect: { text: "Example Domain" }, label: "wait-title" },
  { action: "evaluate", js: "return document.title", label: "eval-title" },
]}});
// 404 诚实 didnt
await call("404", { url: "https://example.com/404", action: "navigate" });
// NXDOMAIN 诚实 didnt
await call("nxdomain", { url: "https://nonexistent-lasso-test-xyz123.invalid", action: "navigate" });
await t.close();
