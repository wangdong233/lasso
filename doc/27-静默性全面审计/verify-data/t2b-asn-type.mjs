#!/usr/bin/env node
/** T2b：browse_headless 运行中抓全量 lsappinfo —— 确认新 Chrome ASN 的 type（Dock/cmd-tab 资格） */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { sleep, frontmost } from "./probe.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const client = new Client({ name: "t2b-asn-type", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node /Users/wangdong/Documents/Project/cc-control-all/lasso/dist/index.js 2>>${path.join(here, "t2b-stderr.log")}`],
  cwd: "/Users/wangdong/Documents/Project/cc-control-all/lasso",
  env: { ...process.env },
});
await client.connect(transport);

// 异步 navigate；同时抓 lsappinfo 全量
const navP = client.callTool({ name: "browse_headless", arguments: { url: "https://example.com", action: "navigate" } }, undefined, { timeout: 120000 })
  .catch((e) => ({ err: String(e.message).slice(0, 100) }));
await sleep(6000); // npx 已起、chrome 主进程已出
const lsFull = execSync("lsappinfo list 2>/dev/null", { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
fs.writeFileSync(path.join(here, "t2b-lsappinfo-during.txt"), lsFull);
const during = { frontmost: frontmost(), chromeHeaders: [] };
for (const m of lsFull.matchAll(/"Google Chrome[^"]*" ASN:(0x[0-9A-Fa-f-]+)[\s\S]{0,400}?type="([^"]+)"/g)) {
  during.chromeHeaders.push({ asn: m[1], type: m[2] });
}
console.log("[T2b] during-op frontmost:", during.frontmost);
console.log("[T2b] Chrome ASN headers during op:", JSON.stringify(during.chromeHeaders));
const r = await navP;
console.log("[T2b] navigate outcome:", r?.content ? JSON.parse(r.content[0].text).outcome : r?.err ?? "?");
await client.close().catch(() => {});
await sleep(3000);
process.exit(0);
