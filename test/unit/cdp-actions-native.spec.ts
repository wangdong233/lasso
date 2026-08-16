/**
 * cdp-actions-native.spec.ts（v1.11 round1 T5 —— doNetwork/doConsole 原生化）
 *
 * 验证：
 *  1. doNetwork 调 1.7.0 原生 list_network_requests（不再 evaluate_script 注入）
 *     - filter → resourceTypes 映射（xhr→xhr / fetch→fetch / img→image / all 不传）
 *     - 上游 concise 文本行（reqid=N METHOD url [status]）解析成结构化 entries
 *     - 错误路径保留 upstream_network_error: 前缀（network.ts Go/No-Go F2 识别）
 *  2. doConsole 从占位变实装（list_console_messages；msgid 行解析）
 *  3. PerformanceObserver 注入代码路径零残留（grep 源文件）
 */
import { describe, it, expect, vi } from "vitest";
import {
  doNetwork,
  doConsole,
  parseNetworkRequestLines,
  parseConsoleMessageLines,
  CDP_UPSTREAM_TOOL_NAMES,
} from "../../src/browse/cdp-actions.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ============================================================
// helpers
// ============================================================
type Call = { name: string; args: Record<string, unknown> };

function makeClient(responses: Record<string, unknown>): {
  client: McpClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name in responses) {
        const v = responses[name];
        if (v instanceof Error) throw v;
        return v;
      }
      return { content: [{ type: "text", text: `stubbed ${name}` }] };
    }),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
  } as unknown as McpClient;
  return { client, calls };
}

function textResponse(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

const UPSTREAM_NETWORK_TEXT = [
  "## Network requests",
  "Showing 3 of 3 requests",
  "reqid=1 GET https://example.com/ [200]",
  "reqid=2 POST https://api.example.com/data [201]",
  "reqid=3 GET https://cdn.third.com/img.png [pending]",
].join("\n");

const UPSTREAM_CONSOLE_TEXT = [
  "## Console messages",
  "msgid=1 [log] page loaded (0 args)",
  "msgid=2 [error] Uncaught TypeError: x is not a function (1 args)",
  "msgid=3 [warn] deprecated API (2 args) [5 times]",
].join("\n");

// ============================================================
// 1. doNetwork 原生工具直调
// ============================================================
describe("T5 — doNetwork 原生 list_network_requests", () => {
  it("CDP_UPSTREAM_TOOL_NAMES.network_log = list_network_requests（0.3.0 注入路径删）", () => {
    expect(CDP_UPSTREAM_TOOL_NAMES.network_log).toBe("list_network_requests");
    expect(CDP_UPSTREAM_TOOL_NAMES.network_get).toBe("get_network_request");
    expect(CDP_UPSTREAM_TOOL_NAMES.console_log).toBe("list_console_messages");
  });

  it("filter=all → 不传 resourceTypes；返回真请求列表（mock 断言）", async () => {
    const { client, calls } = makeClient({
      list_network_requests: textResponse(UPSTREAM_NETWORK_TEXT),
    });
    const r = await doNetwork(client, "https://example.com/", {
      network_filter: "all",
    });
    const call = calls.find((c) => c.name === "list_network_requests");
    expect(call).toBeTruthy();
    expect(call!.args.resourceTypes).toBeUndefined();
    const entries = JSON.parse((r.preview as string) ?? "[]");
    expect(entries.length).toBe(3);
    expect(entries[0]).toEqual({
      name: "https://example.com/",
      type: "",
      reqid: 1,
      method: "GET",
      status: "200",
    });
    // 非数字 status（pending）原样保留
    expect(entries[2].status).toBe("pending");
  });

  it("filter=xhr → resourceTypes=['xhr'] + entry.type 回填 canonical initiatorType", async () => {
    const { client, calls } = makeClient({
      list_network_requests: textResponse(UPSTREAM_NETWORK_TEXT),
    });
    const r = await doNetwork(client, "https://example.com/", {
      network_filter: "xhr",
    });
    const call = calls.find((c) => c.name === "list_network_requests");
    expect(call!.args.resourceTypes).toEqual(["xhr"]);
    const entries = JSON.parse((r.preview as string) ?? "[]");
    // 上游已过滤；type 回填 xmlhttprequest（network.ts filterResources 直通）
    expect(entries.every((e: { type: string }) => e.type === "xmlhttprequest")).toBe(true);
  });

  it("filter=img → resourceTypes=['image'] + type 回填 img", async () => {
    const { client, calls } = makeClient({
      list_network_requests: textResponse(UPSTREAM_NETWORK_TEXT),
    });
    await doNetwork(client, "https://example.com/", {
      network_filter: "img",
    });
    const call = calls.find((c) => c.name === "list_network_requests");
    expect(call!.args.resourceTypes).toEqual(["image"]);
  });

  it("上游 callTool reject → upstream_network_error:tool_call_failed（F2 识别前缀保留）", async () => {
    const { client } = makeClient({
      list_network_requests: new Error("Unknown tool: list_network_requests"),
    });
    await expect(
      doNetwork(client, "https://example.com/", {}),
    ).rejects.toThrow(/upstream_network_error:tool_call_failed/);
  });

  it("上游 isError → upstream_network_error:is_error", async () => {
    const { client } = makeClient({
      list_network_requests: textResponse("no page selected", true),
    });
    await expect(
      doNetwork(client, "https://example.com/", {}),
    ).rejects.toThrow(/upstream_network_error:is_error/);
  });

  it("doNetwork 不再调 evaluate_script（注入路径删除）", async () => {
    const { client, calls } = makeClient({
      list_network_requests: textResponse(UPSTREAM_NETWORK_TEXT),
    });
    await doNetwork(client, "https://example.com/", {});
    expect(
      calls.filter((c) => c.name === "evaluate_script"),
    ).toHaveLength(0);
  });
});

// ============================================================
// 2. parseNetworkRequestLines / parseConsoleMessageLines（1.7.0 concise 格式）
// ============================================================
describe("T5 — 上游 concise 文本行解析", () => {
  it("parseNetworkRequestLines：reqid 行抽取；非请求行（头/分页/selected 后缀）跳过", () => {
    const lines = parseNetworkRequestLines(
      [
        "## Network requests",
        "Showing 1 of 1 requests",
        "reqid=7 GET https://a.b/c [200] [selected in the DevTools Network panel]",
        "No requests found.",
      ].join("\n"),
    );
    expect(lines).toEqual([
      {
        name: "https://a.b/c",
        type: "",
        reqid: 7,
        method: "GET",
        status: "200",
      },
    ]);
  });

  it("parseConsoleMessageLines：msgid 行抽取 + count 后缀 + 非消息行跳过", () => {
    const msgs = parseConsoleMessageLines(UPSTREAM_CONSOLE_TEXT);
    expect(msgs.length).toBe(3);
    expect(msgs[0]).toEqual({
      id: 1,
      type: "log",
      text: "page loaded",
      argsCount: 0,
    });
    expect(msgs[2].count).toBe(5);
    expect(msgs[2].text).toBe("deprecated API");
  });
});

// ============================================================
// 3. doConsole 实装（原 v0.5 占位废除）
// ============================================================
describe("T5 — doConsole 原生 list_console_messages（占位 → 实装）", () => {
  it("调 list_console_messages；返回 messages JSON（不再是 placeholder 文本）", async () => {
    const { client, calls } = makeClient({
      list_console_messages: textResponse(UPSTREAM_CONSOLE_TEXT),
    });
    const r = await doConsole(client, "https://example.com/", {});
    const call = calls.find((c) => c.name === "list_console_messages");
    expect(call).toBeTruthy();
    const msgs = JSON.parse((r.preview as string) ?? "[]");
    expect(msgs.length).toBe(3);
    expect(msgs[1].type).toBe("error");
    expect((r.preview as string)?.includes("placeholder")).toBe(false);
  });

  it("上游 callTool reject → upstream_console_error:tool_call_failed", async () => {
    const { client } = makeClient({
      list_console_messages: new Error("Unknown tool"),
    });
    await expect(
      doConsole(client, "https://example.com/", {}),
    ).rejects.toThrow(/upstream_console_error:tool_call_failed/);
  });

  it("空响应（No console messages found）→ 空 messages JSON", async () => {
    const { client } = makeClient({
      list_console_messages: textResponse(
        "## Console messages\n<no console messages found>",
      ),
    });
    const r = await doConsole(client, "https://example.com/", {});
    expect(JSON.parse((r.preview as string) ?? "[]")).toEqual([]);
  });
});

// ============================================================
// 4. PerformanceObserver 注入路径零残留（round1 T5 验收）
// ============================================================
describe("T5 — 旧注入路径零残留", () => {
  it("cdp-actions.ts 无 PerformanceObserver 注入代码（源码 grep）", () => {
    const filePath = fileURLToPath(
      new URL("../../src/browse/cdp-actions.ts", import.meta.url),
    );
    const text = readFileSync(filePath, "utf8");
    // 注入脚本主体特征：new PerformanceObserver / obs.observe
    expect(text).not.toMatch(/new PerformanceObserver/);
    expect(text).not.toMatch(/obs\.observe/);
    // 文档注释里的历史提法允许（描述为什么删除），代码路径零残留即可
  });
});
