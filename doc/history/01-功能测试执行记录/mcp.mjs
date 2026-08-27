#!/usr/bin/env node
/**
 * Lasso 功能测试用 JSON-RPC MCP 客户端（doc/17 §0 执行工具）。
 *
 * 用法：
 *   node mcp.mjs tools-list                # 列出工具（tools/list 自检）
 *   node mcp.mjs <tool-name> '<json-args>' # 调用工具，参数为 JSON 字符串（可省略）
 *   env MCP_TIMEOUT_MS=120000              # callTool 超时（默认 120s）
 *
 * 连接：@modelcontextprotocol/sdk Client + StdioClientTransport
 * spawn：node dist/index.js（cwd = 仓库根），stderr 追加写入本目录 server-stderr.log
 * （lasso_start/lasso_ready 等结构化日志走 stderr，tee 到文件留证）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stderrLog = path.join(here, "server-stderr.log");

const client = new Client({ name: "lasso-17-test-cli", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/bin/zsh",
  args: ["-c", `exec node dist/index.js 2>>${JSON.stringify(stderrLog)}`],
  cwd: repoRoot,
  // SDK 默认 env 白名单会滤掉 LASSO_* 自定义变量，必须显式透传
  env: { ...process.env },
});

await client.connect(transport);

const timeoutMs = Number(process.env.MCP_TIMEOUT_MS ?? 120000);

try {
  if (process.argv[2] === "tools-list") {
    const res = await client.listTools();
    console.log(JSON.stringify(res.tools.map((t) => t.name), null, 2));
  } else if (process.argv[2] === "tools-full") {
    const res = await client.listTools();
    console.log(JSON.stringify(res.tools, null, 2));
  } else if (process.argv[2]) {
    const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
    const res = await client.callTool(
      { name: process.argv[2], arguments: args },
      undefined,
      { timeout: timeoutMs },
    );
    if (res.isError) {
      console.log("TOOL_ERROR");
    }
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.error("usage: node mcp.mjs <tools-list|tool-name> [json-args]");
    process.exitCode = 2;
  }
} catch (e) {
  console.error("CALL_FAILED: " + String(e));
  process.exitCode = 1;
} finally {
  await transport.close();
  // 给子进程一点时间落盘退出
  await new Promise((r) => setTimeout(r, 200));
  void fs;
}
