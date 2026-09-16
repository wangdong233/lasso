/**
 * bug08-d-nav-semantics.spec.ts（BUG-08 决议 D，doc/bugs/08，2026-09-15）
 *
 * 假数据面三修（比崩溃危险一个数量级——产出「看起来成功的错误数据」）：
 *  - D-1 hash/same-document 导航检测 → 默认补 reload（marathon 最危险时刻：
 *    哒哒真值 3718 差点被写成 0 条干净）；no_reload opt-out 只标注；
 *    ?v=2 类查询串变更不 reload；URL 读取失败 → 现状路径。
 *  - D-2 evaluate url = ensure-navigation（先导导航）：url≠当前页 → navigate
 *    先行 + final_url=nav 真值；url=当前页 → 零导航原地跑；url 省略 = 现状；
 *    组合语义：evaluate 到 hash-only 目标 → 先导导航触发 D-1 reload。
 *  - D-3 wait 支持当前页（CURRENT_PAGE_ACTIONS += wait；BUG-07 会话守卫
 *    level-1/2 自动生效——无会话 no_active_session:current_page_wait 拒）。
 *
 * 全 mock McpClient（bug07 spec 同范式）——零真浏览器。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BrowseChannel,
  isSameDocumentNavigation,
} from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions, InteractResult } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
function fencedEval(value: string) {
  return { content: [{ type: "text", text: "```\n" + value + "\n```" }], isError: false };
}
function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

type Handler = (n: number, args: Record<string, unknown>) => unknown;

function makeClient(handlers: Record<string, Handler>) {
  const counts = new Map<string, number>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const h = handlers[name];
      if (!h) return textContent(`stubbed ${name}`) as never;
      return h(n, args) as never;
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
  readonly name = "browse_test_bug08d";
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
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-b08d-"));
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
// D-1 纯函数
// ============================================================
describe("BUG-08 D-1 — isSameDocumentNavigation 纯函数", () => {
  it("hash-only 差异 → true；?v=2 查询变更 → false；完整串相同 → false", () => {
    expect(isSameDocumentNavigation("https://x.test/#/search?q=a", "https://x.test/#/search?q=b")).toBe(true);
    expect(isSameDocumentNavigation("https://x.test/?v=1", "https://x.test/?v=2")).toBe(false);
    expect(isSameDocumentNavigation("https://x.test/", "https://x.test/")).toBe(false);
    expect(isSameDocumentNavigation("https://x.test/a", "https://x.test/b")).toBe(false);
    // 无 hash 侧 + 有 hash 侧：去 hash 后相等 + 串不同 → true（首挂 hash 形态）
    expect(isSameDocumentNavigation("https://x.test/search", "https://x.test/search#results")).toBe(true);
  });

  // ---- BUG-08 对抗复审轮 1（t7 真机实锤）：URL 规范化边界 ----
  it("t7 空路径省略斜杠变体 → true（http://x#/q=b 是 http://x/#/q=a 的 same-document——raw 串比较漏检的假数据复活口）", () => {
    expect(isSameDocumentNavigation("http://127.0.0.1:18765/#/q=eps", "http://127.0.0.1:18765#/q=zeta")).toBe(true);
  });

  it("规范化族其余成员：默认端口消解 / host 大小写 → true（规范化后同页的正确合并，不产假阳性）", () => {
    expect(isSameDocumentNavigation("http://x.test:80/#/a", "http://x.test#/b")).toBe(true);
    expect(isSameDocumentNavigation("http://X.test/#/a", "http://x.test/#/b")).toBe(true);
    // 不同文档规范化后仍必不等（假阳性排除）
    expect(isSameDocumentNavigation("http://x.test:8080/#/a", "http://x.test/#/b")).toBe(false);
    expect(isSameDocumentNavigation("https://x.test/#/a", "http://x.test/#/b")).toBe(false);
  });

  it("解析失败侧退化 raw 去-hash 比较（保守 = 至多回到修复前行为）", () => {
    // 相对/畸形串（非绝对 URL）解析失败 → 退化 strip 串比较，语义与修复前一致
    expect(isSameDocumentNavigation("not a url#frag1", "not a url#frag2")).toBe(true);
    expect(isSameDocumentNavigation("not a url#frag1", "other#frag2")).toBe(false);
  });
});

// ============================================================
// D-1 doNavigate 行为
// ============================================================
describe("BUG-08 D-1 — doNavigate hash 检测 + 默认 reload", () => {
  const CURRENT = "https://tm.aliyun.com/#/search?q=dada";

  function navClient(currentHref: string | null) {
    return makeClient({
      evaluate_script: () => (currentHref === null ? textContent("") : fencedEval(JSON.stringify(currentHref))),
      navigate_page: () => textContent(`Navigated to ${CURRENT}`),
      take_snapshot: () => textContent("- page: ok"),
    });
  }

  it("hash-only 目标 → navigate 后补 navigate_page{type:reload} + 双标注", async () => {
    const { client, calls } = navClient(CURRENT);
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://tm.aliyun.com/#/search?q=wengweng", "navigate", {});
    expect(r.outcome).toBe("worked");
    const data = r.data!;
    expect(data.same_document_navigated).toBe(true);
    expect(data.same_document_reloaded).toBe(true);
    const navCalls = names(calls, "navigate_page");
    expect(navCalls).toHaveLength(2);
    expect(navCalls[0]!.args.type).toBe("url");
    expect(navCalls[1]!.args.type).toBe("reload"); // marathon 假数据根治
  });

  it("no_reload:true → 只标注不重载（opt-out 逃生；reloaded:false）", async () => {
    const { client, calls } = navClient(CURRENT);
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://tm.aliyun.com/#/search?q=wengweng", "navigate", {
      no_reload: true,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.same_document_navigated).toBe(true);
    expect(r.data!.same_document_reloaded).toBe(false);
    expect(names(calls, "navigate_page")).toHaveLength(1); // 无 reload
    // no_reload 被 navigate 消费 → 不进 ignored_options
    expect(r.data!.ignored_options ?? []).not.toContain("no_reload");
  });

  it("?v=2 类查询变更（去 hash 不等）→ 不 reload 零标注（常规跨页零行为变化）", async () => {
    const { client, calls } = navClient("https://x.test/?v=1");
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://x.test/?v=2", "navigate", {});
    expect(r.outcome).toBe("worked");
    expect(r.data!.same_document_navigated).toBeUndefined();
    expect(names(calls, "navigate_page")).toHaveLength(1);
  });

  it("t7 行为级：空路径省略斜杠的 hash-only 目标 → 检测命中 + 补 reload + 双标注（真机假数据复活口的行为钉）", async () => {
    // location.href 恒为规范化形态（带 /）；调用方目标少打斜杠——raw 比较漏检形态
    const { client, calls } = navClient("http://127.0.0.1:18765/#/q=eps");
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("http://127.0.0.1:18765#/q=zeta", "navigate", {});
    expect(r.outcome).toBe("worked");
    expect(r.data!.same_document_navigated).toBe(true);
    expect(r.data!.same_document_reloaded).toBe(true);
    const navCalls = names(calls, "navigate_page");
    expect(navCalls).toHaveLength(2);
    expect(navCalls[1]!.args.type).toBe("reload");
  });

  it("当前页 URL 读取失败（evaluate 抛错/空串）→ 跳过检测走现状路径", async () => {
    const { client, calls } = makeClient({
      evaluate_script: () => {
        throw new Error("no page context");
      },
      navigate_page: () => textContent("Navigated"),
      take_snapshot: () => textContent("- page: ok"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://x.test/#/a", "navigate", {});
    expect(r.outcome).toBe("worked");
    expect(r.data!.same_document_navigated).toBeUndefined();
    expect(names(calls, "navigate_page")).toHaveLength(1);
  });
});

// ============================================================
// D-2 evaluate url = ensure-navigation
// ============================================================
describe("BUG-08 D-2 — evaluate 先导导航语义", () => {
  it("url ≠ 当前页 → navigate 先行 + final_url = 导航真值（伪造路径消灭）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: (n) =>
        n === 1
          ? fencedEval(JSON.stringify("https://example.com/")) // 读 href
          : fencedEval(JSON.stringify(42)), // doEvaluate 执行
      navigate_page: () => textContent("Navigated to https://target.test/real"),
      take_snapshot: () => textContent("- page: ok"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://target.test/eval", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    // 先导导航真实发生（wrapNavigate 链 → navigate_page{type:url}）
    const navCalls = names(calls, "navigate_page");
    expect(navCalls).toHaveLength(1);
    expect(navCalls[0]!.args.url).toBe("https://target.test/eval");
    // final_url = 导航返回的真实 URL（非回显请求 url；非「preview 当前页+final_url 目标」自相矛盾）
    expect(r.data!.final_url).toBe("https://target.test/real");
  });

  it("url = 当前页 → 零导航原地执行（存量调用模式零扰动）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: (n) =>
        n === 1
          ? fencedEval(JSON.stringify("https://example.com/")) // 读 href
          : fencedEval(JSON.stringify(7)),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(0); // 零导航调用
    expect(r.data!.preview).toBe("7");
  });

  it("复审轮 1 t7 配套：url 为当前页的规范化变体（空路径省略斜杠）→ 同页零导航原地执行（免一次无谓整页 reload——SPA 会话态保护）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: (n) =>
        n === 1
          ? fencedEval(JSON.stringify("http://127.0.0.1:18765/#/q=eps")) // location.href 规范化形态
          : fencedEval(JSON.stringify(42)),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("http://127.0.0.1:18765#/q=eps", "evaluate", { js: "() => 2" });
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(0); // 规范化后同页 → 不先导导航
    expect(r.data!.preview).toBe("42");
  });

  it("url 省略 → 决议 B（doc/bugs/09）新契约：evaluate 加入 current-page 家族——冷通道 no_active_session:current_page_evaluate 拒（P1-A 修复：此前 url_required_for_action:evaluate 与 descriptions「omit url to run on the current page」承诺矛盾）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: () => fencedEval(JSON.stringify("done")),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    // level-1 会话守卫（BUG-07 家族自动生效——同 screenshot/wait 契约）
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("no_active_session:current_page_evaluate");
    expect(r.hint).toBeTruthy();
    expect(names(calls, "evaluate_script")).toHaveLength(0); // wrapper 未触达
  });

  it("组合语义：evaluate 到 hash-only 目标 → 先导导航触发 D-1 reload（两决议组合钉）", async () => {
    const CURRENT = "https://tm.aliyun.com/#/search?q=dada";
    const TARGET = "https://tm.aliyun.com/#/search?q=wengweng";
    const { client, calls } = makeClient({
      // n=1 wrapper 读 href；n=2 doNavigate 内 D-1 再读 href；n>=3 执行体
      evaluate_script: (n) =>
        n <= 2 ? fencedEval(JSON.stringify(CURRENT)) : fencedEval(JSON.stringify(1)),
      navigate_page: (n) =>
        textContent(n === 1 ? `Navigated to ${TARGET}` : "Reloaded"),
      take_snapshot: () => textContent("- page: ok"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse(TARGET, "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    const navCalls = names(calls, "navigate_page");
    expect(navCalls).toHaveLength(2); // url + reload（D-1 在先导导航链内触发）
    expect(navCalls[1]!.args.type).toBe("reload");
    expect(r.data!.final_url).toBe(TARGET);
  });

  it("先导导航后本 client 成为已导航会话（current-page wait 随即合法——写点语义）", async () => {
    const { client, calls } = makeClient({
      evaluate_script: (n) =>
        n === 1 ? fencedEval(JSON.stringify("https://example.com/")) : fencedEval(JSON.stringify(1)),
      navigate_page: () => textContent("Navigated to https://target.test/"),
      take_snapshot: () => textContent("- page: ok"),
      wait_for: () => textContent("done"),
    });
    const ch = new TestBrowseChannel(client);
    await ch.browse("https://target.test/eval", "evaluate", { js: "() => 1" });
    // 先导导航已标记会话 → 无 url 的 wait（D-3）合法
    const r2 = await ch.browse(undefined, "wait", { expect: { text: "done" } } as BrowseOptions);
    expect(r2.outcome).toBe("worked");
    expect(r2.data!.preview).toContain("done");
  });
});

// ============================================================
// D-3 wait 当前页
// ============================================================
describe("BUG-08 D-3 — wait 支持当前页", () => {
  it("有会话：url 省略 wait → 当前页 wait_for（零导航）", async () => {
    const { client, calls } = makeClient({
      navigate_page: () => textContent("Navigated to https://example.com/"),
      take_snapshot: () => textContent("- page: ok"),
      wait_for: () => textContent("done"),
    });
    const ch = new TestBrowseChannel(client);
    // 建会话（navigate with url）
    await ch.browse("https://example.com/", "navigate", {});
    const r = await ch.browse(undefined, "wait", { expect: { text: "done" } } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(1); // wait 零额外导航
    expect(r.data!.url).toBe("current-page");
  });

  it("无会话（冷通道 level-1）：不 spawn 即拒 didnt + no_active_session:current_page_wait", async () => {
    const { client, calls } = makeClient({
      wait_for: () => textContent("done"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse(undefined, "wait", { expect: { text: "x" } } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("no_active_session:current_page_wait");
    expect(r.hint).toBeTruthy();
  });

  it("url_required hint 文案更新（screenshot / wait / evaluate——决议 B 三 action 现族）", async () => {
    const { client } = makeClient({});
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse(undefined, "extract", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("url_required_for_action:extract");
    expect(r.hint).toContain("screenshot / wait / evaluate");
  });

  it("有 url 的 wait 路径不变（wait 非 NAV_FIRST——作用于当前页语义保持）", async () => {
    const { client, calls } = makeClient({
      navigate_page: () => textContent("Navigated"),
      take_snapshot: () => textContent("- page: ok"),
      wait_for: () => textContent("done"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "wait", { expect: { text: "done" } } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(0); // wait 保持原语义（不 NAV_FIRST）
  });
});
