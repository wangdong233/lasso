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
 * 决议 B（doc/bugs/10，2026-09-17）扩展：两条表达式路由（括号表达式 + 单行
 * 裸表达式——修复实机报告 P2 的 `JSON.stringify({...})` 恒 undefined 与
 * `({...})` 报 fn is not a function）+ B.2 错误教学（js_form 回执 +
 * is-not-a-function hint）。
 *
 * 全 mock McpClient——零真浏览器。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BrowseChannel,
  evaluateFunctionArg,
  evaluateJsForm,
  isIifeString,
  isParenExpression,
  isSingleLineExpression,
} from "../../src/channels/BrowseChannel.js";
import { isFallbackWorthy } from "../../src/fallback/outcome.js";
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

  it("1b. 语句体形态维持包裹（return / 声明 / 多语句）", () => {
    // bug10 决议 B.1：单行裸表达式（旧语料 `document.title`）已迁出语句体 →
    // 表达式路由自动返回值（见 B.1 describe 块）；语句体只剩 return/声明/
    // 多语句/多行四类。
    for (const stmt of [
      "return document.title",
      "const a = 1; return a",
      "var x = 1;\nx + 2",
      "await new Promise(r => setTimeout(r, 10)); return 1",
    ]) {
      expect(evaluateFunctionArg(stmt)).toBe(`() => {\n${stmt}\n}`);
    }
  });

  it("1c. 判定方向保守：误判为「透传语句体」（响亮语法错）优于「包裹函数表达式」（静默 undefined）", () => {
    // 非函数起手的语句体（含 return）绝不透传；只有白名单起手 token 才透传
    expect(evaluateFunctionArg("return () => 1")).not.toBe("return () => 1");
    // bug10 决议 B.1 翻转：单行裸表达式（含 `[1,2,3].map(...)`）从语句体包裹
    //（恒 undefined）迁到表达式路由（值自动返回）——旧 /^\(\) => \{/ 断言随之
    // 作废（doc/bugs/10 §2 B.1 裸表达式路由目标用例）。
    expect(evaluateFunctionArg("[1,2,3].map(x => x * 2)")).toBe(
      "() => (\n[1,2,3].map(x => x * 2)\n)",
    );
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
    // BUG-08 D-2: wrapEvaluateEnsureNav 先导读 location.href（首个 evaluate_script）——执行体断言取最后一次调用
    expect(calls.filter((c) => c.name === "evaluate_script").at(-1)!.args.function).toBe(
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
    // BUG-08 D-2: wrapEvaluateEnsureNav 先导读 location.href（首个 evaluate_script）——执行体断言取最后一次调用
    expect(calls.filter((c) => c.name === "evaluate_script").at(-1)!.args.function).toBe(
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

  it("4c. 其余上游错误签名维持 eval_upstream_error——C2 起归 didnt（换通道救不了坏 JS，不拉响 fallback）", async () => {
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
    // BUG-04 决议 C2（报告 §9-②b）：脚本错从 unknown+fallback 变 didnt+直达错误
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("eval_upstream_error:");
    expect(isFallbackWorthy(r.outcome, r.error)).toBe(false); // didnt 永不 fallback
  });
});

// ============================================================
// 5. BUG-04 决议 C1：IIFE 第三形态（doc/bugs/04 §7）
// ============================================================
// 机理（上游 tarball 逐行复核）：performEvaluation（script.js:158-165）=
// `evaluateHandle('(' + fnString + ')')` 后 `fn(...args)`——IIFE 串求值成
// **结果**而非函数 → `fn is not a function`（报告 §9-②a 消费方实测）。
// 修：IIFE 探测（结构化尾部调用判定）命中 → 包成表达式体箭头 `() => (\n${t}\n)`。
describe("C1 · evaluate IIFE 第三形态", () => {
  it("5a. 三 IIFE 形态包成表达式体箭头（求值即得结果）", () => {
    for (const iife of [
      "(async () => { const t = await Promise.resolve(1); return t; })()",
      "(() => { return 42 })()",
      "(function() { return 1; })()",
      "(async function(){ return 2; })()",
      "(() => { return 3 })();", // 尾分号形态
    ]) {
      const out = evaluateFunctionArg(iife);
      expect(out).toBe(`() => (\n${iife.replace(/;\s*$/, "")}\n)`);
      expect(out).not.toBe(iife); // 原样透传 = 上游 fn is not a function（毒点）
    }
  });

  it("5b. isIifeString 反例锚：箭头尾调用/尾参非空括号/截断——维持透传（静默变更风险大于响亮报错）", () => {
    // 箭头尾调用：上游直接自调用箭头，透传语义正确（决议指定反例）
    expect(isIifeString("() => document.getElementById('x').click()")).toBe(false);
    expect(evaluateFunctionArg("() => document.getElementById('x').click()")).toBe(
      "() => document.getElementById('x').click()",
    );
    // 尾参非空括号组：(x) 不是 ()——维持透传（文档化取向）
    expect(isIifeString("() => (foo)(x)")).toBe(false);
    expect(evaluateFunctionArg("() => (foo)(x)")).toBe("() => (foo)(x)");
    // 括号函数表达式（非调用）——透传（既有 E④ 语义不回退）
    expect(isIifeString("(() => 42)")).toBe(false);
    expect(isIifeString("(function() { return 1; })")).toBe(false);
    // 平衡破坏（截断/畸形）——不判 IIFE，交上游响亮报错
    expect(isIifeString("(() => { return 1 })(")).toBe(false);
    // 字符串内的括号不计数
    expect(isIifeString('(function(){ return ")("; })()')).toBe(true);
  });

  it("5c. doEvaluate 行为：IIFE 入参 → 上游收到表达式体箭头 + 结果直达（不再 fn is not a function）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: () => fencedEval("7"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "(async () => { const x = await Promise.resolve(7); return x; })()",
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // BUG-08 D-2：同上——执行体取最后一次 evaluate_script 调用
    const fnArg = String(calls.filter((c) => c.name === "evaluate_script").at(-1)!.args.function);
    expect(fnArg).toMatch(/^\(\) => \(\n\(async/); // 包裹形态
    expect(r.data?.preview).toBe("7");
  });

  it("5d. E④ 既有语料不回退（函数表达式透传 / 语句体包裹——全向量复跑）", () => {
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
      expect(evaluateFunctionArg(fn)).toBe(fn);
    }
    for (const stmt of [
      "return document.title",
      "const a = 1; return a",
      "var x = 1;\nx + 2",
    ]) {
      expect(evaluateFunctionArg(stmt)).toBe(`() => {\n${stmt}\n}`);
    }
  });
});

// ============================================================
// 6. 决议 B.1（doc/bugs/10，2026-09-17）：两条表达式路由
//    （实机报告 P2：`JSON.stringify({...})` 落语句体恒 undefined；
//     `({...})` 透传报 fn is not a function）
// ============================================================
describe("B.1 · 表达式路由（括号 + 单行裸表达式）", () => {
  it("6a. 单行裸表达式 → 表达式体包裹（值自动返回——修复恒 undefined）", () => {
    for (const expr of [
      "JSON.stringify({a:1})",
      "document.title",
      "1+2",
      "[1,2,3].map(x => x * 2)",
      "document.querySelector('a').href",
    ]) {
      expect(evaluateFunctionArg(expr)).toBe(`() => (\n${expr}\n)`);
      expect(evaluateJsForm(expr)).toBe("single_expression");
    }
    // 尾分号形态：剥尾 `;` 后包裹（表达式体内 `;` 是语法错）
    expect(evaluateFunctionArg("document.title;")).toBe(
      "() => (\ndocument.title\n)",
    );
  });

  it("6b. 括号表达式路由：`({...})`/`(1+2)` → 表达式体包裹（修复 fn is not a function）", () => {
    for (const expr of ["({a:1})", "(1+2)", "(a+b)", "(foo)(x)", '("(" + x)']) {
      expect(evaluateFunctionArg(expr)).toBe(`() => (\n${expr}\n)`);
      expect(evaluateJsForm(expr)).toBe("paren_expression");
      expect(isParenExpression(expr)).toBe(true);
    }
  });

  it("6c. 函数表达式族保守排除（判伪方向=维持现行透传，字节级不变）", () => {
    // (a,b)=>a：首闭合组后接 => （箭头参数组）
    expect(evaluateFunctionArg("(a,b)=>a")).toBe("(a,b)=>a");
    expect(evaluateJsForm("(a,b)=>a")).toBe("function_expression");
    // `(() => 42)`：首闭合组（内层空参）后接 => → 透传（E④ 1a 语料不回退）
    expect(evaluateFunctionArg("(() => 42)")).toBe("(() => 42)");
    // `(function(){...})`：外组内容 function 起手 → 透传（E④ 1a 语料不回退）
    expect(evaluateFunctionArg("(function() { return 1; })")).toBe(
      "(function() { return 1; })",
    );
    // `(async () => 1)`：外组内容 async 起手 → 透传
    expect(evaluateFunctionArg("(async () => 1)")).toBe("(async () => 1)");
    // `(x => x)`：外组内容单标识符箭头 → 透传（保守排除集）
    expect(evaluateFunctionArg("(x => x)")).toBe("(x => x)");
    // 嵌套括号对象 `(({a:1}))`：外组内容 `(` 起手 → 保守透传（响亮错误方向）
    expect(evaluateFunctionArg("(({a:1}))")).toBe("(({a:1}))");
  });

  it("6d. 语句体三闸不回退：语句关键字 / 串外分号 / 多行 → 维持语句体包裹", () => {
    for (const stmt of [
      "const x = 1", // 声明关键字
      "if (x) y", // 语句关键字（非表达式）
      "let a = 1", //
      "a = 1; b = 2", // 串外分号（多语句）
      "JSON.stringify({\na:1\n})", // 多行（诚实边界：B.2 教学回执兜住）
      "x; y", // 串外分号
    ]) {
      expect(evaluateFunctionArg(stmt)).toBe(`() => {\n${stmt}\n}`);
      expect(evaluateJsForm(stmt)).toBe("statement_body");
    }
    // 词边界反例：document 不被 `do` 误伤 / classroom 不被 `class` 误伤
    expect(isSingleLineExpression("document.title")).toBe(true);
    expect(isSingleLineExpression("classroom + 1")).toBe(true);
    expect(isSingleLineExpression("do { x } while (0)")).toBe(false);
    // 串内分号不计数（引号感知）
    expect(isSingleLineExpression("document.querySelector('a;b').href")).toBe(
      true,
    );
    // 不平衡 → 不判表达式（交上游响亮报错）
    expect(isSingleLineExpression("(({a:1)")).toBe(false);
    expect(isParenExpression("(({a:1)")).toBe(false);
  });

  it("6e. IIFE 用例字节级回归锚（B.1 扩展不扰动 C1 语义）", () => {
    const iife = "(async () => { const x = await Promise.resolve(7); return x; })()";
    expect(evaluateFunctionArg(iife)).toBe(
      `() => (\n${iife.replace(/;\s*$/, "")}\n)`,
    );
    expect(evaluateJsForm(iife)).toBe("iife");
  });

  it("6f. doEvaluate 行为：裸表达式入参 → 上游收到表达式体箭头 + 值直达（不再 undefined）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: () => fencedEval('{"a":1}'),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "JSON.stringify({a:1})",
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // BUG-08 D-2：执行体断言取最后一次 evaluate_script 调用
    expect(calls.filter((c) => c.name === "evaluate_script").at(-1)!.args.function).toBe(
      "() => (\nJSON.stringify({a:1})\n)",
    );
    expect(r.data?.preview).toBe('{"a":1}');
    // 值非 undefined → 无教学回执（byte-identical 增量面）
    expect(r.data?.js_form).toBeUndefined();
  });
});

// ============================================================
// 7. 决议 B.2（doc/bugs/10）：错误教学（js_form 回执 + is-not-a-function hint）
// ============================================================
describe("B.2 · evaluate 语句体教学回执", () => {
  it("7a. 语句体 + 返回 undefined → data.js_form='statement_body' + js_form_hint（错误即教学）", async () => {
    const { client } = makeClient({
      evaluate_script: () => fencedEval("undefined"), // 上游围栏契约：JSON.stringify(undefined) → 字面 "undefined"
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "JSON.stringify({\na:1\n})", // 多行 → 语句体（6d 诚实边界用例）
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data?.js_form).toBe("statement_body");
    expect(r.data?.js_form_hint).toMatch(/statement bodies return undefined/);
    expect(r.data?.js_form_hint).toMatch(/`return`/);
  });

  it("7b. 形态-值合取防噪音：函数表达式合法返回 undefined / 语句体有值 → 无教学回执", async () => {
    // 函数表达式 `() => undefined`：合法返回 undefined——不教学
    const { client: c1 } = makeClient({
      evaluate_script: () => fencedEval("undefined"),
    });
    const ch1 = new TestBrowseChannel(c1);
    const r1 = await ch1.browse("https://example.com/", "evaluate", {
      js: "() => undefined",
    } as BrowseOptions);
    expect(r1.outcome).toBe("worked");
    expect(r1.data?.js_form).toBeUndefined();
    // 语句体 + 有值（return 42）：不教学
    const { client: c2 } = makeClient({
      evaluate_script: () => fencedEval("42"),
    });
    const ch2 = new TestBrowseChannel(c2);
    const r2 = await ch2.browse("https://example.com/", "evaluate", {
      js: "return 42",
    } as BrowseOptions);
    expect(r2.outcome).toBe("worked");
    expect(r2.data?.js_form).toBeUndefined();
  });

  it("7c. 上游错误含 is not a function → 错误文案追加同款教学句（eval_upstream_error 前缀语义不变）", async () => {
    const { client } = makeClient({
      evaluate_script: () =>
        textContent("TypeError: intercept is not a function", true),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "(() => 42)(", // 截断形态：透传 → 上游求值为非函数
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt"); // BUG-04 决议 C2：脚本错不 fallback
    expect(r.error).toContain("eval_upstream_error:");
    expect(r.error).toContain("is not a function");
    expect(r.error).toMatch(/js form hint: statement bodies return undefined/);
  });

  it("7d. 其余上游错误不带教学句（窄匹配防误伤）", async () => {
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
    expect(r.error).toContain("eval_upstream_error:");
    expect(r.error).not.toContain("js form hint");
  });
});
