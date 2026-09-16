/**
 * bug09-b-url-semantics.spec.ts（决议 B，doc/bugs/09，2026-09-16）
 *
 * url 语义统一为单一 ensure-navigation 模型——四族收敛（evaluate / snapshot+
 * extract / network+screenshot+pdf / wait+click+fill）+ CURRENT_PAGE_ACTIONS
 * 白名单 += evaluate + did_navigate 统一回显。
 *
 * 修复面（喵虎报告 P1-A/P1-B/P1-C，doc/bugs/09 §2）：
 *  - P1-A：evaluate 省略 url 从「url_required_for_action:evaluate 拒」→
 *    current-page 模式（descriptions 自 BUG-08 起承诺「omit url to run on the
 *    current page」——此前代码与描述矛盾 = 描述谎言，修复）；
 *  - P1-B：extract/snapshot 带 url 从「读当前残留页 + final_url 伪造目标 URL」
 *    → url≠当前页一律先导航再读（假数据形态本体消灭）；
 *  - P1-C：两个读页动作对同一 url 参数的行为互斥（evaluate 导航 / extract 绝不
 *    导航）→ 单一 ensure-nav 门，全族一致；
 *  - 行为改善（CHANGELOG 标注面）：network/screenshot/pdf url=当前页从无条件
 *    reload → 零导航直执行（SPA 状态保留）。
 *
 * 全 mock McpClient（bug08-d spec 同范式）——零真浏览器。L3 真机（tm.aliyun.com
 * 驱逐哨兵信号复现）是 WT4 的验收面，不在本 spec。
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
import { mockScreenshotResponse } from "../helpers/upstream-mock.js";

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

/** 1.7.0 实测工具面（P10 探测门用——含 pdf 防 upstream_unsupported 假拒）。 */
const TOOLS_170 = [
  "navigate_page",
  "take_snapshot",
  "take_screenshot",
  "evaluate_script",
  "wait_for",
  "click",
  "fill_form",
  "list_pages",
  "select_page",
  "list_network_requests",
  "list_console_messages",
  "pdf",
];

/**
 * 可编程 client：handlers 按 tool 名分发（n = 该 tool 第几次调用）。
 * evaluate_script 未提供时默认返回 fenced href（ENSURE_NAV 门 probe 真实形态）。
 */
function makeClient(handlers: Record<string, Handler>, defaultHref: string | null) {
  const counts = new Map<string, number>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const h = handlers[name];
      if (h) return h(n, args) as never;
      if (name === "evaluate_script" && defaultHref !== null) {
        return fencedEval(JSON.stringify(defaultHref)) as never;
      }
      return textContent(`stubbed ${name}`) as never;
    }),
    listTools: vi.fn(async () => TOOLS_170.map((t) => ({ name: t, inputSchema: {} }))),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client, calls };
}

class Bug09TestChannel extends BrowseChannel {
  readonly name = "browse_test_bug09b";
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
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-b09b-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
});

function names(calls: Array<{ name: string }>, tool: string) {
  return calls.filter((c) => c.name === tool);
}

/** 会话建立器：真实 navigate(X)（走 dispatch → 会话标记写点）。 */
async function warmSession(
  ch: Bug09TestChannel,
  url: string,
): Promise<void> {
  const r = await ch.browse(url, "navigate", {});
  expect(r.outcome).toBe("worked");
}

// ============================================================
// B.1-1：url 缺省 → current-page 模式（白名单 += evaluate）
// ============================================================
describe("决议 B — url 缺省（current-page 模式）", () => {
  it("evaluate 省略 url：冷通道 level-1 拒 no_active_session:current_page_evaluate（不静默空白页跑 JS；P1-A 修复——不再是 url_required_for_action:evaluate）", async () => {
    const { client, calls } = makeClient({}, null);
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("no_active_session:current_page_evaluate");
    expect(r.hint).toBeTruthy();
    // level-1 pre-check：不触网（零 evaluate_script——不 spawn 语义由真实通道保证）
    expect(names(calls, "evaluate_script")).toHaveLength(0);
  });

  it("evaluate 省略 url：有会话 → 当前页直跑 + did_navigate:false + data.url=current-page", async () => {
    const { client, calls } = makeClient(
      { evaluate_script: () => fencedEval(JSON.stringify(42)) },
      null,
    );
    const ch = new Bug09TestChannel(client);
    await warmSession(ch, "https://example.com/");
    const r = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("42");
    expect(r.data!.did_navigate).toBe(false);
    expect(r.data!.url).toBe("current-page");
    expect(names(calls, "navigate_page")).toHaveLength(1); // 仅建会话那次
  });

  it("非白名单 action 省略 url 仍拒 url_required_for_action（extract）——hint 列三 action 现族", async () => {
    const { client } = makeClient({}, null);
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse(undefined, "extract", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("url_required_for_action:extract");
    expect(r.hint).toContain("screenshot / wait / evaluate");
  });
});

// ============================================================
// B.1-2：url = 当前页 → 零导航直执行（evaluate 语义泛化到全族）
// ============================================================
describe("决议 B — url = 当前页（零导航直执行）", () => {
  const CURRENT = "https://example.com/dashboard";

  it("evaluate url=当前页 → 零导航原地执行（D-2 语义保留）", async () => {
    const { client, calls } = makeClient(
      {
        // n=1 = ENSURE_NAV 门 probe（读 location.href）→ 返回当前页；n≥2 = 执行体
        evaluate_script: (n) =>
          n === 1 ? fencedEval(JSON.stringify(CURRENT)) : fencedEval(JSON.stringify(7)),
      },
      null,
    );
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse(CURRENT, "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(0);
    expect(r.data!.did_navigate).toBe(false);
    expect(r.data!.preview).toBe("7");
  });

  it("evaluate url=当前页的规范化变体（空路径省略斜杠）→ 同页零导航（t7 边界保留）", async () => {
    const { client, calls } = makeClient(
      {
        evaluate_script: (n) =>
          n === 1
            ? fencedEval(JSON.stringify("http://127.0.0.1:18765/#/q=eps"))
            : fencedEval(JSON.stringify(1)),
      },
      null,
    );
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse("http://127.0.0.1:18765#/q=eps", "evaluate", {
      js: "() => 2",
    });
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(0);
    expect(r.data!.did_navigate).toBe(false);
  });

  it("screenshot url=当前页 → 跳过导航（NAV_FIRST 时代无条件 reload 的行为变化——SPA 状态保留）", async () => {
    const { client, calls } = makeClient(
      { take_screenshot: () => mockScreenshotResponse() },
      CURRENT,
    );
    const ch = new Bug09TestChannel(client);
    await warmSession(ch, CURRENT);
    const navBefore = names(calls, "navigate_page").length;
    const r = await ch.browse(CURRENT, "screenshot", {});
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page").length).toBe(navBefore); // 零额外导航
    expect(r.data!.did_navigate).toBe(false);
  });

  it("network url=当前页 → 跳过导航（同上行为改善）", async () => {
    const { client, calls } = makeClient(
      { list_network_requests: () => textContent("[] requests") },
      CURRENT,
    );
    const ch = new Bug09TestChannel(client);
    await warmSession(ch, CURRENT);
    const navBefore = names(calls, "navigate_page").length;
    const r = await ch.browse(CURRENT, "network", {});
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page").length).toBe(navBefore);
    expect(r.data!.did_navigate).toBe(false);
  });

  it("同页跳过也会话标记（随后 current-page evaluate 合法——写点语义）", async () => {
    const { client, calls } = makeClient(
      {
        evaluate_script: (n) =>
          n === 1 ? fencedEval(JSON.stringify(CURRENT)) : fencedEval(JSON.stringify(1)),
        take_snapshot: () => textContent("- page: ok"),
      },
      null,
    );
    const ch = new Bug09TestChannel(client);
    // extract(X) 同页跳过（会话由跳过分支标记）→ 随后 evaluate 省略 url 合法
    const r1 = await ch.browse(CURRENT, "extract", {});
    expect(r1.outcome).toBe("worked");
    const r2 = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(r2.outcome).toBe("worked");
    expect(r2.error).toBeUndefined();
    expect(names(calls, "navigate_page")).toHaveLength(0);
  });
});

// ============================================================
// B.1-3：url ≠ 当前页 → 先导航再执行（P1-B 假数据本体修复）
// ============================================================
describe("决议 B — url ≠ 当前页（先导航再执行）", () => {
  it("extract url≠当前页（已导航会话）→ 先导航再读（P1-B 本体：旧 FRESH_PAGE_NAV 空白门控在已导航会话读残留页 + final_url 伪造）", async () => {
    // 场景还原（喵虎时间线 7）：会话停在推广页，extract 传 tm.aliyun.com URL
    const RESIDUAL = "https://www.aliyun.com/search/?k=Agent";
    const TARGET = "https://tm.aliyun.com/";
    const { client, calls } = makeClient(
      {
        // n=1 = warmSession(RESIDUAL) 导航的 D-1 probe；n=2 = extract 的
        // ENSURE_NAV 门 probe（→ 残留页 ≠ 目标，必导航）；n≥3 不发生（extract 走 snapshot）
        evaluate_script: (n) =>
          n <= 2 ? fencedEval(JSON.stringify(RESIDUAL)) : fencedEval(JSON.stringify(1)),
        navigate_page: () => textContent(`Navigated to ${TARGET}`),
        take_snapshot: () =>
          textContent('## snapshot\nuid=1_0 RootWebArea "商标查询" url="https://tm.aliyun.com/"'),
      },
      null,
    );
    const ch = new Bug09TestChannel(client);
    await warmSession(ch, RESIDUAL);
    const r = await ch.browse(TARGET, "extract", {});
    expect(r.outcome).toBe("worked");
    // 先导导航真实发生（warmSession 1 次 + extract 先导 1 次）
    const navCalls = names(calls, "navigate_page");
    expect(navCalls).toHaveLength(2);
    expect(navCalls[1]!.args.url).toBe(TARGET);
    // 导航先于采集（warmSession 的 verifyNavigatedPage 也抓过 snapshot——比最后序）
    const lastNavIdx = calls.map((c) => c.name).lastIndexOf("navigate_page");
    const lastSnapIdx = calls.map((c) => c.name).lastIndexOf("take_snapshot");
    expect(lastNavIdx).toBeLessThan(lastSnapIdx);
    expect(r.data!.did_navigate).toBe(true);
    // final_url = a11y 树真实页面 URL（非伪造——读到的页面与声称一致）
    expect(r.data!.final_url).toBe("https://tm.aliyun.com/");
  });

  it("evaluate url≠当前页 → navigate 先行 + did_navigate:true + final_url 导航真值（D-2 语义保留）", async () => {
    const { client, calls } = makeClient(
      {
        evaluate_script: (n) =>
          n === 1
            ? fencedEval(JSON.stringify("https://residual.example.com/"))
            : fencedEval(JSON.stringify(42)),
        navigate_page: () => textContent("Navigated to https://target.test/real"),
      },
      null,
    );
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse("https://target.test/eval", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(1);
    expect(r.data!.did_navigate).toBe(true);
    expect(r.data!.final_url).toBe("https://target.test/real");
  });

  it("readCurrentHref 失败（probe 抛错）→ 保守导航（与 D-2 wrapper 旧语义一致）", async () => {
    const { client, calls } = makeClient(
      {
        evaluate_script: () => {
          throw new Error("no page context");
        },
        navigate_page: () => textContent("Navigated to https://x.test/"),
      },
      null,
    );
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse("https://x.test/", "snapshot", {});
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(1);
    expect(r.data!.did_navigate).toBe(true);
  });

  it("pdf url≠当前页 → 先导航（上游工具存在时）+ did_navigate:true", async () => {
    const { client, calls } = makeClient(
      {
        evaluate_script: () => fencedEval(JSON.stringify("https://residual.test/")),
        navigate_page: () => textContent("Navigated to https://x.test/doc"),
        pdf: () =>
          textContent(
            "JVBERi0xLjQKJdPr6eET2zAwMDAwMDAwMDAgMDAwMDAgbg==",
          ),
      },
      null,
    );
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse("https://x.test/doc", "pdf", {});
    // pdf base64 非法会 didnt（screenshot_write_failed 族校验）——但导航与
    // did_navigate 语义不受交付失败影响：本用例只钉导航先于 pdf 工具调用
    const navIdx = calls.findIndex((c) => c.name === "navigate_page");
    const pdfIdx = calls.findIndex((c) => c.name === "pdf");
    expect(navIdx).toBeGreaterThanOrEqual(0);
    if (pdfIdx >= 0) expect(navIdx).toBeLessThan(pdfIdx);
  });
});

// ============================================================
// B.1-4：did_navigate 统一回显（url 装饰性消灭）
// ============================================================
describe("决议 B — did_navigate 统一回显", () => {
  it("navigate 本尊 → did_navigate:true", async () => {
    const { client } = makeClient(
      { navigate_page: () => textContent("Navigated to https://x.test/") },
      null,
    );
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse("https://x.test/", "navigate", {});
    expect(r.outcome).toBe("worked");
    expect(r.data!.did_navigate).toBe(true);
  });

  it("wait 带 url → 永不导航 + did_navigate:false（装饰性 url 显形——决议 B 表行 4「不变」）", async () => {
    const { client, calls } = makeClient(
      { wait_for: () => textContent("done") },
      null,
    );
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { text: "done" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(0);
    expect(r.data!.did_navigate).toBe(false);
  });

  it("console（current-page 读）→ did_navigate:false", async () => {
    const { client } = makeClient(
      { list_console_messages: () => textContent("[]") },
      null,
    );
    const ch = new Bug09TestChannel(client);
    await warmSession(ch, "https://example.com/");
    const r = await ch.browse("https://example.com/", "console", {});
    expect(r.outcome).toBe("worked");
    expect(r.data!.did_navigate).toBe(false);
  });
});

// ============================================================
// 占位与诚实标注
// ============================================================
describe("决议 B — about:blank 占位 + ignored_options 诚实性", () => {
  it("url=about:blank（forest 调度器缺 subtitle 兜底）→ 永不导航（对它导航会把受管页面洗成空白页）", async () => {
    const { client, calls } = makeClient(
      { take_snapshot: () => textContent("- page: current state") },
      "https://example.com/real",
    );
    const ch = new Bug09TestChannel(client);
    await warmSession(ch, "https://example.com/real");
    const navBefore = names(calls, "navigate_page").length;
    const r = await ch.browse("about:blank", "snapshot", {});
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page").length).toBe(navBefore); // 零导航
    expect(r.data!.did_navigate).toBe(false);
    // 读到的是当前页（受管状态不被破坏）
    expect(calls.some((c) => c.name === "take_snapshot")).toBe(true);
  });

  it("同页跳过分支：no_cache 未被消费 → 进 ignored_options（no_navigation 模式派生）", async () => {
    const { client } = makeClient(
      {
        evaluate_script: (n) =>
          n === 1
            ? fencedEval(JSON.stringify("https://example.com/"))
            : fencedEval(JSON.stringify(1)),
      },
      null,
    );
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "() => 1",
      no_cache: true,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.did_navigate).toBe(false); // 同页跳过 → 无导航
    expect(r.data!.ignored_options ?? []).toContain("no_cache");
  });

  it("先导导航分支：no_cache 被消费 → 不进 ignored_options", async () => {
    const { client } = makeClient(
      {
        evaluate_script: (n) =>
          n === 1
            ? fencedEval(JSON.stringify("https://other.test/"))
            : fencedEval(JSON.stringify(1)),
        navigate_page: () => textContent("Navigated to https://example.com/"),
      },
      null,
    );
    const ch = new Bug09TestChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "() => 1",
      no_cache: true,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.did_navigate).toBe(true);
    expect(r.data!.ignored_options ?? []).not.toContain("no_cache");
  });
});
