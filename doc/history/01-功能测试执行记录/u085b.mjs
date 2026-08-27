import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
const repoRoot = "/Users/wangdong/Documents/Project/cc-control-all/lasso";
const client = new Client({ name: "t", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], cwd: repoRoot,
  env: { ...process.env } });
await client.connect(transport);
const res = await client.callTool({ name: "search", arguments: { query: "u085 unique qq-0815b", engine: "fallback_chain" } }, undefined, { timeout: 150000 });
console.log(JSON.stringify(JSON.parse(res.content[0].text)).slice(0, 900));
await transport.close();
