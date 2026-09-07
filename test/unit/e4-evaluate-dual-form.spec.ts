/**
 * e4-evaluate-dual-form.spec.ts（BUG-03 决议 E④，doc/bugs/03 §4 E，消费方④根治）
 *
 * 毒点（cc-control 实战）：doEvaluate 把 opts.js 无条件包进 `() => {\n${js}\n}`
 * 函数体——调用方按 lasso 工具描述传**函数表达式**（`() => document.title`，与
 * 上游契约一致）时被包成「函数体内的函数表达式语句」，求值不 return →
 * **恒 undefined（静默错值）**。
 *
 * 修复三件：
 *  1. evaluateFunctionArg 形态探测归一：函数表达式原样透传 / 语句体维持包裹
 *  2. evalFence 围栏正则改贪婪：返回值内部含 ``` 的字符串不再提前截断
 *  3. 会话轮换错误（"No page selected"）归类 session_rotated（可重试语义 +
 *     提示重 snapshot），不再落泛 unknown 文案
 *
 * 全 mock McpClient——零真浏览器。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowseChannel, evaluateFunctionArg } from "../../src/channels/BrowseChannel.js";
import { evalFence, parseEvalResult } from "../../src/browse/upstream-response.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions } from "../../src/types.js";

function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function fencedEval(value: string) {
  return textContent(
    `# evaluate_script response\nScript ran on page and returned:\n\`\`\`json\n${value}\n\`\`\``,
  );
}

function makeClient(handlers: Record<string, (args: Record<string, unknown>, n: number) => unknown>) {
  const counts = new Map<string, number>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const h = handlers[name];
      if (!h) return textContent(`stubbed ${name}`) as never;
      return h(args, n) as never;
    }),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client, calls };
}

class TestBrowseChannel extends BrowseChannel {
  readonly name = "browse_test_e4";
  constructor(private readonly c: McpClient) {
    super();
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.c);
  }
}

let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-e4-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(async () => {
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
});

// ============================================================
// 1. evaluateFunctionArg 形态探测归一
// ============================================================
describe("E④ · evaluateFunctionArg 双形态", () => {
  it("1a. 函数表达式形态原样透传（上游自调用）", () => {
    for (const fn of [
      "() => document.title",
      "async () => 1",
      "(() => 42)",
      "(function() { return 1; })",
      "function f() { return 1; }",
      "async function f() { return 1; }",
      "x => x + 1",
      "async x => x",
    ]) {
      expect(evaluateFunctionArg(fn)).toBe(fn); // byte 透传
    }
  });

  it("1b. 语句体形态维持包裹（return / 声明 / 裸表达式 / 多语句）", () => {
    for (const stmt of [
      "return document.title",
      "const a = 1; return a",
      "document.title",
      "var x = 1;\nx + 2",
      "await new Promise(r => setTimeout(r, 10)); return 1",
    ]) {
      expect(evaluateFunctionArg(stmt)).toBe(`() => {\n${stmt}\n}`);
    }
  });

  it("1c. 判定方向保守：误判为「透传语句体」（响亮语法错）优于「包裹函数表达式」（静默 undefined）", () => {
    // 非函数起手的语句体（含 return）绝不透传；只有白名单起手 token 才透传
    expect(evaluateFunctionArg("return () => 1")).not.toBe("return () => 1");
    expect(evaluateFunctionArg("[1,2,3].map(x => x * 2)")).toMatch(/^\(\) => \{/);
  });
});

// ============================================================
// 2. doEvaluate 双形态行为验证（mock 上游回显 function 参数求值结果）
// ============================================================
describe("E④ · doEvaluate 双形态行为", () => {
  it("2a. 函数表达式入参 → 上游收到原样函数（不再被包成恒 undefined 的语句体）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: () => fencedEval(JSON.stringify("page-title")),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "() => document.title",
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(calls.find((c) => c.name === "evaluate_script")!.args.function).toBe(
      "() => document.title",
    );
    expect(r.data?.preview).toBe("page-title");
  });

  it("2b. 语句体入参（return 形态）→ 依旧包裹（W1-DEF-1b 语义不回退）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: () => fencedEval("42"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "return 42",
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(calls.find((c) => c.name === "evaluate_script")!.args.function).toBe(
      "() => {\nreturn 42\n}",
    );
    expect(r.data?.preview).toBe("42");
  });
});

// ============================================================
// 3. evalFence 贪婪围栏（返回值含 ``` 不截断）
// ============================================================
describe("E④ · evalFence 贪婪围栏", () => {
  it("3a. 值内部含 ``` 的字符串完整取回（旧非贪婪在内部 ``` 截断）", () => {
    const value = JSON.stringify("before ```\ninside fence``` after"); // 页面源码片段类
    const r = evalFence(fencedEval(value));
    expect(r).toBe(value); // 完整围栏（含内部 ```）
    expect(parseEvalResult(fencedEval(value))).toBe("before ```\ninside fence``` after");
  });

  it("3b. 常规值行为不变（对象/数字/嵌套）", () => {
    expect(evalFence(fencedEval('{"a":1}'))).toBe('{"a":1}');
    expect(evalFence(fencedEval("123"))).toBe("123");
    const nested = JSON.stringify({ code: "```json\n{}\n```" });
    expect(parseEvalResult(fencedEval(nested))).toEqual({ code: "```json\n{}\n```" });
  });
});

// ============================================================
// 4. session_rotated 透明化
// ============================================================
describe("E④ · 会话轮换错误归类 session_rotated", () => {
  it("4a. isError + No page selected → outcome=unknown（可重试）+ error=session_rotated: 前缀 + 重 snapshot 提示", async () => {
    const { client } = makeClient({
      evaluate_script: () => textContent("No page selected", true),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "() => document.title",
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown"); // 可重试档（classifyBrowseError 显式归类）
    expect(r.error).toContain("session_rotated:No page selected");
    expect(r.error).toMatch(/snapshot/);
  });

  it("4b. 无 isError 标志但文本即错误本体（P5 形态）→ 同归类", async () => {
    const { client } = makeClient({
      evaluate_script: () => textContent("No page selected"), // isError 缺失
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "return 1",
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("session_rotated:");
  });

  it("4c. 其余上游错误签名维持 eval_upstream_error（不误伤）", async () => {
    const { client } = makeClient({
      evaluate_script: () =>
        textContent(
          "Network.enable timed out. Increase the 'protocolTimeout' setting",
          true,
        ),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "return 1",
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("eval_upstream_error:");
  });
});
