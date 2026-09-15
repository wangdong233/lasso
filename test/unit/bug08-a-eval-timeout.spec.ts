/**
 * bug08-a-eval-timeout.spec.ts（BUG-08 决议 A，doc/bugs/08，2026-09-15）
 *
 * marathon 毒点（P0-1 + P2-3）：长 evaluate（>30s 批量 JS）触发 SDK 缺省 60s
 * 超时（McpClient.callTool 不传 timeout → protocol.js
 * DEFAULT_REQUEST_TIMEOUT_MSEC——60s 不是设计值，是缺省事故）→ -32001 裸 unknown
 * （调用方零分辨力，误判「Chrome 死了」）；budget_ms 传入被 ignored_options
 * 回显（收了不生效）。
 *
 * 修复三件（决议 A）：
 *  - A-1 callTool 第三参 timeoutMs 透传 SDK RequestOptions.timeout（不传 = 现状）
 *  - A-2 evaluate 调用预算：budget_ms ?? env(LASSO_EVAL_TIMEOUT_MS) ?? 120s
 *  - A-3① 超时类型化：-32001/"Request timed out" → mcp_request_timeout: 前缀
 *    + hint 教学；outcome 维持 unknown（可重试 + fallback-worthy 零变化）
 *
 * Part 1 真子进程（吞 tools/call 的最小 MCP stdio 服务器——超时断言的是真实
 * SDK 超时语义，不 mock）；Part 2-4 全 mock McpClient（bug07 spec 同范式）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpClient } from "../../src/subprocess/McpClient.js";
import {
  DEFAULT_EVAL_CALL_TIMEOUT_MS,
  defaultEvalTimeoutMs,
  parseEvalTimeoutMs,
} from "../../src/subprocess/McpClient.js";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { isFallbackWorthy } from "../../src/fallback/outcome.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient as McpClientType } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions, InteractResult } from "../../src/types.js";

// ============================================================
// helpers（e4-evaluate-dual-form / bug07 spec 同范式）
// ============================================================
function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

/**
 * mock client——callTool 记录第三参（timeoutMs）供 A-1/A-2 断言
 * （既有 spec 的两参 mock 会静默丢弃第三参，这里必须显式记录）。
 */
function makeClient(handlers: Record<string, (args: Record<string, unknown>, n: number) => unknown>) {
  const counts = new Map<string, number>();
  const calls: Array<{ name: string; args: Record<string, unknown>; timeoutMs?: number }> = [];
  const client: McpClientType = {
    callTool: vi.fn(
      async (name: string, args: Record<string, unknown>, timeoutMs?: number) => {
        calls.push({ name, args, timeoutMs });
        const n = (counts.get(name) ?? 0) + 1;
        counts.set(name, n);
        const h = handlers[name];
        if (!h) return textContent(`stubbed ${name}`) as never;
        return h(args, n) as never;
      },
    ),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClientType;
  return { client, calls };
}

class TestBrowseChannel extends BrowseChannel {
  readonly name = "browse_test_bug08a";
  constructor(private readonly c: McpClientType) {
    super();
  }
  protected getMcpClient(): Promise<McpClientType> {
    return Promise.resolve(this.c);
  }
}

let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-bug08a-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
  delete process.env.LASSO_EVAL_TIMEOUT_MS;
});

afterEach(async () => {
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
  delete process.env.LASSO_EVAL_TIMEOUT_MS;
});

// ============================================================
// Part 1 — A-1 callTool timeout 透传（真子进程：吞 tools/call 的最小服务器）
// ============================================================
/** 最小 MCP stdio 服务器：initialize / tools/list 应答，tools/call 吞掉不应答。 */
const CALL_SWALLOWING_SERVER = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
          capabilities: {},
          serverInfo: { name: "swallow-mcp", version: "0.0.1" },
        },
      }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [] },
      }) + "\\n");
    }
    // tools/call：故意不应答（模拟上游 toolMutex 楔死期）
  }
});
setInterval(() => {}, 1 << 30);
`;

describe("BUG-08 A-1 — callTool timeoutMs 透传 SDK RequestOptions（真子进程）", () => {
  it("T1 吞 tools/call 服务器 + timeoutMs=700 → 快速 reject（-32001/Request timed out），不烧 SDK 60s 缺省", async () => {
    const c = await McpClient.connectStdio(
      { name: "bug08a-spec", version: "0.1.0" },
      { command: process.execPath, args: ["-e", CALL_SWALLOWING_SERVER] },
      15_000,
    );
    const pid = c.pid;
    try {
      const t0 = Date.now();
      await expect(c.callTool("evaluate_script", { function: "() => 1" }, 700))
        .rejects.toThrow(/-32001|Request timed out/);
      const dt = Date.now() - t0;
      // 700ms 预算 + SDK 清理余量——绝不该等缺省 60s（marathon 毒点的核心）
      expect(dt).toBeLessThan(10_000);
    } finally {
      await c.close();
      if (pid !== null) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
            await new Promise((r) => setTimeout(r, 50));
          } catch {
            break;
          }
        }
      }
    }
  }, 20_000);

  it("T2 不传 timeoutMs = 现状字节级不变（SDK 缺省路径，shape 探针：resolve 形态不受影响）", async () => {
    const c = await McpClient.connectStdio(
      { name: "bug08a-spec", version: "0.1.0" },
      {
        command: process.execPath,
        args: ["-e", CALL_SWALLOWING_SERVER.replace("// tools/call：故意不应答（模拟上游 toolMutex 楔死期）", `
    else if (msg.method === "tools/call") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
    }`)],
      },
      15_000,
    );
    try {
      // 无第三参 → 正常 resolve（透传通道存在不改变缺省行为）
      const r = await c.callTool("evaluate_script", { function: "() => 1" });
      expect(r).toBeTruthy();
    } finally {
      await c.close();
    }
  });
});

// ============================================================
// Part 2 — A-2 evaluate 调用预算传导（mock client）
// ============================================================
describe("BUG-08 A-2 — evaluate 单调用预算（budget_ms 死键兑现）", () => {
  it("T3 options.budget_ms=300000 → callTool 第三参 300000（marathon 配方直译）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: () => textContent("```json\n42\n```"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "() => 1",
      budget_ms: 300_000,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    const evalCall = calls.find((c) => c.name === "evaluate_script");
    expect(evalCall).toBeTruthy();
    expect(evalCall!.timeoutMs).toBe(300_000);
    // budget_ms 被 evaluate 消费 → 不进 ignored_options（A-2 兑现的核心断言）
    expect((r as InteractResult<{ ignored_options?: string[] }>).data?.ignored_options ?? []).not.toContain("budget_ms");
  });

  it("T4 缺省 budget_ms → env LASSO_EVAL_TIMEOUT_MS；env 缺省 → 120s 常量", async () => {
    const mk = () => {
      const m = makeClient({
        evaluate_script: () => textContent("```json\n1\n```"),
      });
      return { ch: new TestBrowseChannel(m.client), calls: m.calls };
    };
    // env 缺省 → 常量
    let h = mk();
    await h.ch.browse("https://example.com/", "evaluate", { js: "() => 1" } as BrowseOptions);
    expect(h.calls.find((c) => c.name === "evaluate_script")!.timeoutMs).toBe(
      DEFAULT_EVAL_CALL_TIMEOUT_MS,
    );
    // env 覆盖
    process.env.LASSO_EVAL_TIMEOUT_MS = "90000";
    h = mk();
    await h.ch.browse("https://example.com/", "evaluate", { js: "() => 1" } as BrowseOptions);
    expect(h.calls.find((c) => c.name === "evaluate_script")!.timeoutMs).toBe(90_000);
    // budget_ms 恒赢 env
    h = mk();
    await h.ch.browse("https://example.com/", "evaluate", {
      js: "() => 1",
      budget_ms: 200_000,
    } as BrowseOptions);
    expect(h.calls.find((c) => c.name === "evaluate_script")!.timeoutMs).toBe(200_000);
  });

  it("T5 snapshot 传 budget_ms 仍进 ignored_options（非 evaluate action 消费面不变）", async () => {
    const { client } = makeClient({
      take_snapshot: () => textContent("- page: Example"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "snapshot", {
      budget_ms: 300_000,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(
      (r as InteractResult<{ ignored_options?: string[] }>).data?.ignored_options,
    ).toContain("budget_ms");
  });
});

// ============================================================
// Part 3 — A-3① 超时类型化（不连坐、不 respawn、归因保真）
// ============================================================
describe("BUG-08 A-3① — -32001 类型化 + hint 教学 + unknown 语义保持", () => {
  it("T6 callTool 抛 McpError -32001 → error 前缀 mcp_request_timeout: + hint 含 budget_ms 教学；outcome=unknown", async () => {
    const { client } = makeClient({
      evaluate_script: () => {
        throw new Error(
          "McpError: MCP error -32001: Request timed out",
        );
      },
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "() => 1",
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(r.error!.startsWith("mcp_request_timeout:")).toBe(true);
    expect(r.error).toContain("-32001");
    expect(r.hint).toBeTruthy();
    expect(r.hint!).toContain("budget_ms");
    // hint 只教正门（budget_ms / 自愈），不给 kill/respawn 指引
    expect(r.hint!.toLowerCase()).not.toContain("kill");
    expect(r.hint!.toLowerCase()).not.toContain("respawn");
  });

  it("T7 非 MCP 超时错误零污染：普通导航错误原文透传（无前缀、无 hint）", async () => {
    const { client } = makeClient({
      navigate_page: () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      },
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "navigate", {});
    expect(r.error!.startsWith("mcp_request_timeout:")).toBe(false);
    expect(r.hint).toBeUndefined();
  });

  it("T8 classify + fallback-worthy：mcp_request_timeout → unknown + isFallbackWorthy=true（语义与旧裸 unknown 一致）", () => {
    // T6 已断言 outcome=unknown；这里钉 fallback 语义零漂移（headless 超时仍可
    // 升 logged_in——通道级瞬态，非调用方坏 JS）
    expect(isFallbackWorthy("unknown", "mcp_request_timeout:McpError: MCP error -32001")).toBe(true);
  });
});

// ============================================================
// Part 4 — parseEvalTimeoutMs 三态（决议 A-2 测试面）
// ============================================================
describe("BUG-08 A-2 — parseEvalTimeoutMs 三态 + defaultEvalTimeoutMs env 接线", () => {
  it("T9 未设/空 → 120s；合法值 → 原值；NaN/负/0 → 回默认", () => {
    expect(parseEvalTimeoutMs(undefined)).toBe(DEFAULT_EVAL_CALL_TIMEOUT_MS);
    expect(parseEvalTimeoutMs("")).toBe(DEFAULT_EVAL_CALL_TIMEOUT_MS);
    expect(parseEvalTimeoutMs("  ")).toBe(DEFAULT_EVAL_CALL_TIMEOUT_MS);
    expect(parseEvalTimeoutMs("300000")).toBe(300_000);
    expect(parseEvalTimeoutMs("abc")).toBe(DEFAULT_EVAL_CALL_TIMEOUT_MS);
    expect(parseEvalTimeoutMs("-5")).toBe(DEFAULT_EVAL_CALL_TIMEOUT_MS);
    expect(parseEvalTimeoutMs("0")).toBe(DEFAULT_EVAL_CALL_TIMEOUT_MS);
  });

  it("T10 defaultEvalTimeoutMs 读 process.env.LASSO_EVAL_TIMEOUT_MS", () => {
    process.env.LASSO_EVAL_TIMEOUT_MS = "240000";
    expect(defaultEvalTimeoutMs()).toBe(240_000);
    process.env.LASSO_EVAL_TIMEOUT_MS = "bogus";
    expect(defaultEvalTimeoutMs()).toBe(DEFAULT_EVAL_CALL_TIMEOUT_MS);
  });
});
