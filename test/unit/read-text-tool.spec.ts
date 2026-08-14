/**
 * read-text-tool.spec.ts（D1 修复，v1.8 Phase D）
 *
 * 守护点：read_text 工具必须真正注册进 MCP server 并可调用 —— read-text.ts
 * v0.3 已写好但 index.ts 从未装配，browse/StepEngine 超 48KiB spill 后
 * continue_hint 指向的 read_text({ref:"@oN"}) 经 MCP 不可达（wave1
 * T-TOOLS-13 / T-TOOLS-08 采证：6 处 description 指向 + continue_hint 落空）。
 *
 * 测试策略：
 *  - 真 McpServer + InMemoryTransport + Client（与 fallback.spec.ts 同范式）：
 *    1. tools/list 含 read_text（注册生效）
 *    2. applyOutputEnvelope 真落盘一个 > 48KiB spill → callTool read_text 续页
 *    3. 未知 ref → 结构化 error payload（不抛异常）
 *  - 源码装配断言：index.ts 必须调 registerReadTextTool + V5_TOOL_TO_CHANNEL
 *    含 read_text（防装配再次丢失；grep 级守护，与 invariants 同手段）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerReadTextTool } from "../../src/tools/read-text.js";
import { applyOutputEnvelope } from "../../src/util/output-envelope.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function startServer(): Promise<{
  client: Client;
  shutdown: () => Promise<void>;
}> {
  const server = new McpServer({ name: "lasso-test", version: "0.1.0-test" });
  registerReadTextTool(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return {
    client,
    shutdown: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("read_text 工具（D1 注册修复）", () => {
  it("tools/list 含 read_text（注册经 McpServer 生效）", async () => {
    const { client, shutdown } = await startServer();
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain("read_text");
    } finally {
      await shutdown();
    }
  });

  it("调用 read_text 读 spill 文件：applyOutputEnvelope 落盘 → 续页返回 {text,eof,total_bytes}", async () => {
    // 造一个 > 48KiB 的内容触发真 spill（48KiB + 若干余量，单行避免 2000 行上限先行触发）
    const big = "x".repeat(49 * 1024);
    const env = applyOutputEnvelope(big, "test refine hint");
    expect(env.truncated).toBe(true);
    expect(env.ref).toMatch(/^@o\d+$/);

    const { client, shutdown } = await startServer();
    try {
      const resp = (await client.callTool({
        name: "read_text",
        arguments: { ref: env.ref, offset: 0, limit: 4096 },
      })) as { content: Array<{ type: string; text: string }> };
      const page = JSON.parse(resp.content[0]!.text) as {
        text: string;
        eof: boolean;
        total_bytes: number;
      };
      expect(page.total_bytes).toBe(Buffer.byteLength(big, "utf8"));
      expect(page.text).toBe("x".repeat(4096));
      expect(page.eof).toBe(false);
    } finally {
      await shutdown();
    }
  });

  it("未知 ref → 结构化 error payload（不向 SDK 抛异常）", async () => {
    const { client, shutdown } = await startServer();
    try {
      const resp = (await client.callTool({
        name: "read_text",
        arguments: { ref: "@o999999", offset: 0 },
      })) as { content: Array<{ type: string; text: string }> };
      const payload = JSON.parse(resp.content[0]!.text) as {
        eof: boolean;
        error?: string;
      };
      expect(payload.eof).toBe(true);
      expect(payload.error).toContain("unknown ref");
    } finally {
      await shutdown();
    }
  });

  it("index.ts 装配断言：registerReadTextTool(server) 被调用 + V5_TOOL_TO_CHANNEL 含 read_text", () => {
    const indexPath = path.join(REPO_ROOT, "src", "index.ts");
    const src = readFileSync(indexPath, "utf8");
    // 注册调用（防装配再次丢失——D1 的本质是注册缺席）
    expect(src).toMatch(/registerReadTextTool\(server\)/);
    // ToolManager caller-tier 映射（装配范式第 4 处联动）
    expect(src).toMatch(/read_text:\s*"read_text"/);
    // import 存在（防 import 被删后注册行变成对局部函数的误引）
    expect(src).toMatch(/from\s+"\.\/tools\/read-text\.js"/);
    // 本测试自身不依赖 __dirname 之外的布局
    expect(url.pathToFileURL(indexPath)).toBeTruthy();
  });
});
