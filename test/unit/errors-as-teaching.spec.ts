/**
 * errors-as-teaching.spec.ts（doc/usage/04 决议 C + E.2/E.3，2026-09-16 P0）
 *
 * 错误自描述升级的行为锚：高频 didnt 类错误的 hint 必须内嵌正确形态的可复制
 * 片段（Anthropic errors-as-teaching——七份消费方报告的「逆向 workaround 才
 * 学会」痛点根治面）。全部 mock McpClient（bug09-b spec 同范式）——零真浏览器。
 *
 * 锚面：
 *  1. unknown_action：合法值从 actionDispatch keys 运行时派生（drift-free by
 *     construction——Map 增删 action，hint 自动同步）+ current-page 家族指路；
 *  2. BROWSE_ACTIONS ↔ actionDispatch keys 相等性（单一真源列表与 Map 不漂移
 *     ——新增 action 漏登记任一侧即红）；
 *  3. url_required_for_action：家族清单动态派生 + 正确形态 call shape 内嵌；
 *  4. no-session 三族（screenshot / wait / evaluate）：additive Recovery 片段
 *     （INV-95/bug09 族既有断言全部 toContain——additive suffix 兼容，已核对）；
 *  5. evictionHint：consent 语序钉（ASK THE USER FIRST 在 browse_headed({ 之前
 *     ——决议 C 红线）+ call shape 片段在场。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BrowseChannel,
  BROWSE_ACTIONS,
} from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

// ============================================================
// helpers（bug09-b-url-semantics.spec 同范式）
// ============================================================
type Handler = (n: number, args: Record<string, unknown>) => unknown;

function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function makeClient() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
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

class TeachingTestChannel extends BrowseChannel {
  readonly name = "browse_test_teaching";
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
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-eat-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
});

// ============================================================
// 1 + 2：unknown_action 动态 hint + BROWSE_ACTIONS 同源
// ============================================================
describe("unknown_action — 合法值运行时派生 + 家族指路（决议 C/E.2）", () => {
  it("hint 列出 actionDispatch 全部合法 action（Map 增删 action，hint 自动同步——单测即文档承诺）", async () => {
    const { client } = makeClient();
    const ch = new TeachingTestChannel(client);
    const r = await ch.browse("https://example.com/", "eval", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("unknown_action:eval");
    expect(r.hint).toBeTruthy();
    for (const a of (ch as unknown as { actionDispatch: Map<string, unknown> })
      .actionDispatch.keys()) {
      expect(r.hint).toContain(a);
    }
  });

  it("hint 半句指路 current-page 家族（省 url 语义的唯一正典入口）", async () => {
    const { client } = makeClient();
    const ch = new TeachingTestChannel(client);
    const r = await ch.browse("https://example.com/", "bogus", {});
    expect(r.hint).toContain("omitted url (current-page mode)");
  });

  it("BROWSE_ACTIONS 与 actionDispatch keys 集合相等（单一真源列表 ↔ Map 不漂移；漏登记任一侧即红）", () => {
    const { client } = makeClient();
    const ch = new TeachingTestChannel(client);
    const dispatchKeys = [
      ...(ch as unknown as { actionDispatch: Map<string, unknown> })
        .actionDispatch.keys(),
    ].sort();
    expect([...BROWSE_ACTIONS].sort()).toEqual(dispatchKeys);
    // 顺序也一致（hint join 的稳定呈现）
    expect([...BROWSE_ACTIONS]).toEqual([
      ...(ch as unknown as { actionDispatch: Map<string, unknown> })
        .actionDispatch.keys(),
    ]);
  });
});

// ============================================================
// 3：url_required_for_action — 家族动态 + call shape 内嵌
// ============================================================
describe("url_required_for_action — 家族派生 + 正确形态内嵌（决议 C）", () => {
  it("hint 家族清单从 CURRENT_PAGE_ACTIONS 派生（含既有锚子串「screenshot / wait / evaluate」）+ call shape 教本次 action 的正确形态", async () => {
    const { client } = makeClient();
    const ch = new TeachingTestChannel(client);
    const r = await ch.browse(undefined, "extract", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("url_required_for_action:extract");
    expect(r.hint).toContain("url is optional only for action=screenshot / wait / evaluate");
    expect(r.hint).toContain(
      'browse_headless({url:"https://example.com", action:"extract"})',
    );
  });

  it("steps 链形态的 url_required（screenshot + steps）也拿到含本 action 的 call shape", async () => {
    const { client } = makeClient();
    const ch = new TeachingTestChannel(client);
    const r = await ch.browse(undefined, "screenshot", {
      steps: [{ action: "click", selectors: { click: "x" } }],
    });
    expect(r.error).toBe("url_required_for_action:screenshot");
    expect(r.hint).toContain('action:"screenshot"');
  });
});

// ============================================================
// 4：no-session 三族 — additive Recovery 片段
// ============================================================
describe("no_active_session — Recovery 片段在场（INV-95/bug09 锚定区的 additive suffix）", () => {
  it("screenshot 族：一步形态 + 先导航再省 url 双指引", async () => {
    const { client } = makeClient();
    const ch = new TeachingTestChannel(client);
    const r = await ch.browse(undefined, "screenshot", {});
    expect(r.error).toBe("no_active_session:current_page_screenshot");
    expect(r.hint).toContain('screenshot({url:"https://example.com"})');
    expect(r.hint).toContain("navigate first then screenshot({})");
  });

  it("wait 族：先建会话（url 形态）再省 url", async () => {
    const { client } = makeClient();
    const ch = new TeachingTestChannel(client);
    const r = await ch.browse(undefined, "wait", { expect: { text: "x" } });
    expect(r.error).toBe("no_active_session:current_page_wait");
    expect(r.hint).toContain(
      'browse_headless({url:"https://example.com", action:"snapshot"})',
    );
  });

  it("evaluate 族：ensure-navigation 单调用形态（含 js 三形态之一直传例）", async () => {
    const { client } = makeClient();
    const ch = new TeachingTestChannel(client);
    const r = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(r.error).toBe("no_active_session:current_page_evaluate");
    expect(r.hint).toContain(
      'browse_headless({url:"https://example.com", action:"evaluate", options:{js:"() => document.title"}})',
    );
  });
});

// ============================================================
// 5：evictionHint — consent 语序钉 + call shape 片段
// ============================================================
describe("evictionHint — consent 前提不得后移 + 可复制片段（决议 C/E9 红线）", () => {
  it("consent 语序：ASK THE USER FIRST 在 browse_headed({ 之前，片段紧随其后", () => {
    const { client } = makeClient();
    const ch = new TeachingTestChannel(client);
    const h = (
      ch as unknown as { evictionHint(): string }
    ).evictionHint();
    // 语序锚（决议 E 闸 1b 的运行时同款）
    expect(h).toMatch(
      /ASK THE USER FIRST, then retry with browse_headed\(\{url, action:'snapshot'\}\)/,
    );
    // consent 不得后移：browse_headed({ 首现位置必须在 ASK THE USER FIRST 之后
    const consentIdx = h.indexOf("ASK THE USER FIRST");
    const callIdx = h.indexOf("browse_headed({");
    expect(consentIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(consentIdx);
    // 既有锚（INV-98(e)/eviction-sentinel spec 全 toContain——additive 兼容）
    expect(h).toContain("suspected eviction OR unattributed cross-host move");
    expect(h).toContain("not confirmed");
  });
});
