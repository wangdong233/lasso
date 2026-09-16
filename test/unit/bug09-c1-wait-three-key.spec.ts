/**
 * bug09-c1-wait-three-key.spec.ts（决议 C1，doc/bugs/09，2026-09-16）
 *
 * wait 的 expect 校验三键统一——链内与顶层同一契约（ExpectPoll.
 * validateCondition：text / selector / url_contains 至少一项）。
 *
 * 修复面（喵虎报告 P2-A 现象一，doc/bugs/09 §3 C1）：
 *  - 修复前：steps 里 wait 步传 expect:{selector:"input"} → 报
 *    "Error: wait: opts.expect.text required"（doWait text-only 检查），而顶层
 *    wait 动作接受 selector 期待——同一动作两套校验（本 spec 的「修复前红」锚）。
 *  - 修复后：doWait 走 validateCondition 三键；text-only（非 gone）保持上游
 *    wait_for 原生快路 byte-compatible；selector/url_contains（及 gone:true
 *    反向语义）走 ExpectPoll 100ms 轮询（与 steps postcondition 同引擎）。
 *
 * 全 mock McpClient（bug09-b spec 同范式）——零真浏览器。
 * （P2-A 现象二 worked+error 并存是决议 C2 = StepEngine 域，不在本 spec。）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions } from "../../src/types.js";
import type { Step } from "../../src/browse/steps-types.js";

// ============================================================
// helpers
// ============================================================
function fencedEval(value: string) {
  return { content: [{ type: "text", text: "```\n" + value + "\n```" }], isError: false };
}
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

type Handler = (n: number, args: Record<string, unknown>) => unknown;

/**
 * 可编程 client：evaluate_script 按载荷路由——
 *  - ENSURE_NAV 门 probe（() => location.href）→ 当前页 URL
 *  - quickSnapshot（含 body_text）→ {url, body_text}
 *  - ExpectPoll 条件 expr / 其余 → evalValue 可编程（"true"/"false"）
 */
function makeClient(opts: {
  evalValue?: "true" | "false";
  handlers?: Record<string, Handler>;
}) {
  const evalValue = opts.evalValue ?? "true";
  const counts = new Map<string, number>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const h = opts.handlers?.[name];
      if (h) return h(n, args) as never;
      if (name === "evaluate_script") {
        const fn = String(args.function ?? "");
        if (fn.trim() === "() => location.href") {
          return fencedEval(JSON.stringify("https://example.com/")) as never;
        }
        if (fn.includes("body_text")) {
          return fencedEval(
            JSON.stringify(
              JSON.stringify({
                url: "https://example.com/dashboard",
                body_text: "Welcome",
              }),
            ),
          ) as never;
        }
        return fencedEval(evalValue) as never;
      }
      return textContent(`stubbed ${name}`) as never;
    }),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client, calls };
}

class C1TestChannel extends BrowseChannel {
  readonly name = "browse_test_bug09c1";
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
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-b09c1-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
});

function names(calls: Array<{ name: string }>, tool: string) {
  return calls.filter((c) => c.name === tool);
}

// ============================================================
// 顶层 wait 三键
// ============================================================
describe("决议 C1 — 顶层 wait 三键（与链内同一契约）", () => {
  it("wait expect:{selector} → ExpectPoll 轮询（修复前红锚：doWait 报 wait: opts.expect.text required）", async () => {
    const { client, calls } = makeClient({ evalValue: "true" });
    const ch = new C1TestChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { selector: "input" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // 条件 expr 含 document.querySelector（ExpectPoll buildConditionExpr）
    expect(
      calls.some(
        (c) =>
          c.name === "evaluate_script" &&
          String(c.args.function).includes("document.querySelector"),
      ),
    ).toBe(true);
    // 不走 wait_for（text-only 原生快路）——selector 走轮询
    expect(names(calls, "wait_for")).toHaveLength(0);
  });

  it("wait expect:{url_contains} → 轮询命中 worked", async () => {
    const { client } = makeClient({ evalValue: "true" });
    const ch = new C1TestChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { url_contains: "dashboard" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toContain("url_contains");
  });

  it("wait expect:{text} 保持 wait_for 原生快路（byte-compatible，W1-DEF-2 契约不回退）", async () => {
    const { client, calls } = makeClient({
      handlers: { wait_for: () => textContent("done") },
    });
    const ch = new C1TestChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { text: "done" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    const wf = names(calls, "wait_for");
    expect(wf).toHaveLength(1);
    expect(wf[0]!.args.text).toEqual(["done"]); // 1.7.0 array(string) 契约
  });

  it("wait expect 三键全缺 → validateCondition 拒（与链内 postcondition 同一错误）", async () => {
    const { client } = makeClient({ evalValue: "true" });
    const ch = new C1TestChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: {},
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown"); // 调用方参数错（可改参重试），classify 缺省档
    expect(r.error).toContain(
      "expect: at least one of text/selector/url_contains required",
    );
  });

  it("wait expect:{text, gone:true} → 反向语义走 ExpectPoll（原生 wait_for 表达不了「等文本消失」）", async () => {
    const { client, calls } = makeClient({ evalValue: "false" });
    const ch = new C1TestChannel(client);
    // gone:true + 条件不成立（evalValue=false → holds=false → gone 满足）→ verified
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { text: "loading", gone: true, timeout_ms: 50 },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(names(calls, "wait_for")).toHaveLength(0); // 不走原生快路
  });

  it("wait expect:{selector} 轮询超时 → wait_timeout（可重试 unknown 档）", async () => {
    const { client } = makeClient({ evalValue: "false" });
    const ch = new C1TestChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { selector: "input", timeout_ms: 50 },
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("wait_timeout:");
  });
});

// ============================================================
// steps 链内 wait 三键（P2-A 现象一复现锚）
// ============================================================
describe("决议 C1 — steps 链内 wait 三键（修复前红：wait: opts.expect.text required）", () => {
  it("steps wait 步传 expect:{selector} → worked（修复前：didnt/unknown + wait: opts.expect.text required）", async () => {
    const { client } = makeClient({ evalValue: "true" });
    const ch = new C1TestChannel(client);
    const steps: Step[] = [
      { action: "navigate" },
      { action: "wait", expect: { selector: "input" } },
      { action: "snapshot" },
    ];
    const r = await ch.browse("https://example.com/", "navigate", { steps });
    expect(r.outcome).toBe("worked");
    const chain = r.data!.chain!;
    expect(chain.actions_and_results).toHaveLength(3);
    const waitResult = chain.actions_and_results[1].results[0];
    expect(waitResult.outcome).toBe("worked");
    expect(waitResult.error).toBeUndefined();
  });

  it("steps wait 步传 expect:{url_contains} → worked + postcondition preexisting 诚实报告", async () => {
    const { client } = makeClient({ evalValue: "true" });
    const ch = new C1TestChannel(client);
    // quickSnapshot url=https://example.com/dashboard 含 "dashboard" →
    // doWait 轮询 verified + StepEngine postcondition 判 preexisting（act 前
    // 条件已成立的诚实三态，INV-13 域）
    const steps: Step[] = [
      { action: "navigate" },
      { action: "wait", expect: { url_contains: "dashboard" } },
    ];
    const r = await ch.browse("https://example.com/", "navigate", { steps });
    expect(r.outcome).toBe("worked");
    const waitResult = r.data!.chain!.actions_and_results[1].results[0];
    expect(waitResult.outcome).toBe("worked");
    expect(["verified", "preexisting"]).toContain(waitResult.expect_check);
  });

  it("steps wait 步传 expect:{text} → 既有 wait_for 路径照旧（链内 text 形态 byte-compatible）", async () => {
    const { client, calls } = makeClient({
      handlers: { wait_for: () => textContent("done") },
    });
    const ch = new C1TestChannel(client);
    const steps: Step[] = [
      { action: "navigate" },
      { action: "wait", expect: { text: "done" } },
    ];
    const r = await ch.browse("https://example.com/", "navigate", { steps });
    expect(r.outcome).toBe("worked");
    expect(names(calls, "wait_for")).toHaveLength(1);
    const waitResult = r.data!.chain!.actions_and_results[1].results[0];
    expect(waitResult.outcome).toBe("worked");
  });
});
