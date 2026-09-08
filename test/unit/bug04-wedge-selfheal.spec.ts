/**
 * bug04-wedge-selfheal.spec.ts（BUG-04 决议 B，doc/bugs/04 §5，2026-09-08）
 *
 * 上游 chrome-devtools-mcp@1.7.0 选中页死锁（P1 通道级）自愈回归：
 *  - 根因（npm tarball 逐行复核）：ToolHandler.js:189
 *    `const targetPage = page ?? context.getSelectedMcpPage()` 无条件执行——选中页
 *    被关后**任何**工具调用（含 list_pages）在此 throw 落外层 catch，绕过唯一
 *    自愈点 createPagesSnapshot()。核查员真机复现配方：/json/close 选中页 →
 *    evaluate/list_pages 全报同一错误，new_page 可解除。
 *  - lasso 侧放大因：TabRegistry.reconcile 把签名吞成
 *    tab_reconcile_unparseable_list warn（零检测零自愈）。
 *
 * 修复面（决议 B 三层）：
 *  A. 检测：UPSTREAM_WEDGE_SIGNATURE 单一真源（src/browse/upstream-wedge.ts）
 *     + classifyBrowseError → unknown（upstream_wedge_* 透明前缀）；
 *  B. 自愈：healUpstreamWedge 两层（层 1 new_page background 重置选中页 = 上游
 *     结构性逃逸口；层 2 subproc.restart respawn npx 子进程——永不触碰 Chrome）；
 *  C. 重试：browseSingle heal 后原样重试一次；主动面 reconcile 类型化信号 →
 *     getMcpClient 返回 client 前先 heal。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import {
  UPSTREAM_WEDGE_SIGNATURE,
  isUpstreamWedgeError,
  isUpstreamWedgeTypedSignal,
} from "../../src/browse/upstream-wedge.js";
import { TabRegistry } from "../../src/logged-in/TabRegistry.js";
import { isFallbackWorthy } from "../../src/fallback/outcome.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { IProfileRegistry } from "../../src/logged-in/ProfileRegistry.js";
import type { BrowseOptions } from "../../src/types.js";

/** 上游 McpContext.js:253 整串（真机楔死时 isError 响应文本即此）。 */
const WEDGE_TEXT =
  "The selected page has been closed. Call list_pages to see open pages.";

function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function makeClient(
  handlers: Record<string, (n: number) => unknown>,
): { client: McpClient; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const counts = new Map<string, number>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const h = handlers[name];
      if (!h) return textContent(`stubbed ${name}`);
      return h(n) as never;
    }),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client, calls };
}

let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-bug04-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
  // 台账隔离（LoggedInChannel 构造/getMcpClient 路径会 readLedgerSync）
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tempCache, "launched-chromes.json");
  process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(tempCache, "desired-hidden.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_DESIRED_HIDDEN_PATH;
  rmSync(tempCache, { recursive: true, force: true });
});

// ============================================================
// A. 检测：签名常量 + 判定函数
// ============================================================
describe("BUG-04B · 签名单一真源", () => {
  it("1. 匹配上游整串错误文本；不误伤 No page selected / 正常文本", () => {
    expect(isUpstreamWedgeError(WEDGE_TEXT)).toBe(true);
    expect(isUpstreamWedgeError("Error: something at pptr:evaluateHandle")).toBe(false);
    expect(isUpstreamWedgeError("No page selected")).toBe(false);
    expect(isUpstreamWedgeError("normal page content")).toBe(false);
    expect(String(UPSTREAM_WEDGE_SIGNATURE)).toContain("The selected page has been closed");
  });

  it("2. 类型化信号判定（reconcile 抛出形态 vs 普通 reconcile 失败）", () => {
    expect(isUpstreamWedgeTypedSignal(`upstream_wedge:${WEDGE_TEXT}`)).toBe(true);
    expect(isUpstreamWedgeTypedSignal("upstream_wedge:x")).toBe(true);
    expect(isUpstreamWedgeTypedSignal("some other reconcile failure")).toBe(false);
  });
});

// ============================================================
// B. reconcile 类型化信号（不再吞成 unparseable）
// ============================================================
describe("BUG-04B · TabRegistry.reconcile 类型化信号", () => {
  it("3. list_pages 响应即楔死签名 → throw upstream_wedge: 前缀（不再静默 no-op）", async () => {
    const { client } = makeClient({ list_pages: () => textContent(WEDGE_TEXT, true) });
    const reg = new TabRegistry(10);
    await expect(reg.reconcile(client)).rejects.toThrow(/^upstream_wedge:/);
  });

  it("4. 健康页列表行为不回退（正常 reconcile 零 throw）", async () => {
    const { client, calls } = makeClient({
      list_pages: () => textContent("## Pages\n\n1: about:blank (about:blank) [selected]"),
    });
    const reg = new TabRegistry(10);
    const r = await reg.reconcile(client);
    expect(r.kept).toBe(0); // 未登记 own 页 → 不入册
    expect(calls.filter((c) => c.name === "close_page")).toHaveLength(0);
  });

  it("5. 真正的格式漂移仍走保守 no-op（unparseable 不受楔死分支影响）", async () => {
    const { client } = makeClient({ list_pages: () => textContent("## Pages\n") });
    const reg = new TabRegistry(10);
    const r = await reg.reconcile(client); // 空列表 → no-op，不 throw
    expect(r).toEqual({ reaped: [], kept: 0 });
  });
});

// ============================================================
// C. browseSingle 被动检测 + heal + 单次重试
// ============================================================
/** 可注入楔死自愈钩子的最小具体子类。 */
class WedgeTestChannel extends BrowseChannel {
  readonly name = "browse_test_wedge";
  healCalls = 0;
  /** undefined = heal 成功返回原 client；null = heal 失败。 */
  healResult: McpClient | null | undefined;
  constructor(
    private readonly c: McpClient,
    opts: { healResult?: McpClient | null } = {},
  ) {
    super();
    this.healResult = opts.healResult;
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.c);
  }
  protected override async healUpstreamWedge(_c: McpClient): Promise<McpClient | null> {
    this.healCalls++;
    return this.healResult === undefined ? _c : this.healResult;
  }
}

describe("BUG-04B · browseSingle 被动自愈编排", () => {
  it("6. 首调抛楔死签名，heal 返回 client → 原样重试一次成功 → outcome=worked", async () => {
    const { client, calls } = makeClient({
      navigate_page: (n) =>
        n === 1 ? textContent(WEDGE_TEXT, true) : textContent("navigated to https://example.com/"),
    });
    const ch = new WedgeTestChannel(client);
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(calls.filter((c) => c.name === "navigate_page")).toHaveLength(2);
    expect(ch.healCalls).toBe(1);
  });

  it("7. evaluate 路径楔死（isError → eval_upstream_error:楔死签名）也触发 heal——检测点在错误文本签名", async () => {
    const { client, calls } = makeClient({
      evaluate_script: (n) =>
        n === 1
          ? textContent(WEDGE_TEXT, true)
          : textContent("Script ran on page and returned:\n```json\n\"ok\"\n```"),
    });
    const ch = new WedgeTestChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", { js: "() => 1" } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(calls.filter((c) => c.name === "evaluate_script")).toHaveLength(2);
  });

  it("8. heal 失败（null）→ 透明前缀 upstream_wedge_selected_page_closed + unknown（fallback-worthy）", async () => {
    const { client } = makeClient({
      navigate_page: () => textContent(WEDGE_TEXT, true),
    });
    const ch = new WedgeTestChannel(client, { healResult: null });
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("upstream_wedge_selected_page_closed:");
    expect(isFallbackWorthy("unknown", r.error)).toBe(true); // 通道错 → fallback 正确
  });

  it("9. heal 成功但重试仍楔死 → upstream_wedge_unhealed + unknown（不无限重试）", async () => {
    const { client, calls } = makeClient({
      navigate_page: () => textContent(WEDGE_TEXT, true),
    });
    const ch = new WedgeTestChannel(client); // heal 返回同 client，handler 恒楔死
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("upstream_wedge_unhealed:");
    expect(calls.filter((c) => c.name === "navigate_page")).toHaveLength(2); // 恰一次重试
    expect(ch.healCalls).toBe(1);
  });

  it("10. 默认钩子（不 override）→ 楔死错误原样透传 classify unknown（HeadlessChannel 零变化）", async () => {
    const { client } = makeClient({ navigate_page: () => textContent(WEDGE_TEXT, true) });
    class DefaultHealChannel extends BrowseChannel {
      readonly name = "browse_test_default";
      constructor(private readonly c: McpClient) { super(); }
      protected getMcpClient(): Promise<McpClient> { return Promise.resolve(this.c); }
    }
    const ch = new DefaultHealChannel(client);
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("The selected page has been closed");
  });

  it("11. 非楔死错误（http_404）不触发 heal（窄匹配防误伤）", async () => {
    const { client } = makeClient({
      navigate_page: () => textContent("navigated"),
      take_snapshot: () => textContent("404 Not Found\n\nnot found"),
    });
    const ch = new WedgeTestChannel(client);
    const r = await ch.browse("https://example.com/x", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(ch.healCalls).toBe(0);
  });
});

// ============================================================
// D. LoggedInChannel.healUpstreamWedge 两层
// ============================================================
describe("BUG-04B · LoggedInChannel heal 两层", () => {
  async function makeChannel(restartMock: SubprocessManager["restart"]) {
    const { LoggedInChannel } = await import("../../src/channels/LoggedInChannel.js");
    const profiles = {
      getCurrent: () => ({ name: "default" }),
      currentName: () => "default",
      list: () => [],
      add: vi.fn(async () => {}),
      switch: vi.fn(async () => {}),
    } as unknown as IProfileRegistry;
    const subproc = {
      registerSpec: vi.fn(),
      forgetSpec: vi.fn(async () => {}),
      ensureRunning: vi.fn(async () => null),
      restart: restartMock,
    } as unknown as SubprocessManager;
    const ch = new LoggedInChannel(subproc, 9333, profiles, () => ({}) as never);
    // lastSpecName 初始化（heal 层 2 restart 需要 spec 名）
    await (ch as unknown as { ensureProfileSpec(): Promise<void> }).ensureProfileSpec();
    return { ch: ch as unknown as { healUpstreamWedge(c: McpClient): Promise<McpClient | null> } };
  }

  it("12. 层 1 成功：new_page {background:true} 重置选中页 → 返回原 client + 登记 own 页", async () => {
    const { client, calls } = makeClient({
      new_page: () =>
        textContent("## Pages\n\n1: about:blank (about:blank) [selected]\n2: user tab (https://example.com/)"),
    });
    const { ch } = await makeChannel(vi.fn(async () => { throw new Error("must not respawn"); }));
    const healed = await ch.healUpstreamWedge(client);
    expect(healed).toBe(client); // 同 client——选中页已被 new_page 重置
    const np = calls.find((c) => c.name === "new_page")!;
    expect(np.args).toEqual({ url: "about:blank", background: true }); // 零抢焦形态
  });

  it("13. 层 1 失败（isError）→ 层 2 respawn：只杀 npx 子进程（subproc.restart），返回新 client", async () => {
    const { client, calls } = makeClient({
      new_page: () => textContent(WEDGE_TEXT, true), // 连 new_page 都楔死（isError）
    });
    const client2 = makeClient({}).client;
    const restart = vi.fn(async () => client2);
    const { ch } = await makeChannel(restart as unknown as SubprocessManager["restart"]);
    const healed = await ch.healUpstreamWedge(client);
    expect(healed).toBe(client2);
    expect(restart).toHaveBeenCalledWith("logged_in:default");
    expect(calls.find((c) => c.name === "new_page")).toBeTruthy(); // 先试过层 1
  });

  it("14. 双失败（层 1 isError + 层 2 restart 抛错）→ 返 null（永不 throw）", async () => {
    const { client } = makeClient({ new_page: () => textContent(WEDGE_TEXT, true) });
    const { ch } = await makeChannel(vi.fn(async () => { throw new Error("respawn failed"); }) as never);
    const healed = await ch.healUpstreamWedge(client);
    expect(healed).toBeNull();
  });
});

// ============================================================
// E. 主动面：getMcpClient 在返回 client 前 heal
// ============================================================
describe("BUG-04B · getMcpClient 主动自愈（reconcile 类型化信号消费）", () => {
  async function makeProactiveChannel(handlers: Record<string, (n: number) => unknown>) {
    const { LoggedInChannel } = await import("../../src/channels/LoggedInChannel.js");
    const profiles = {
      getCurrent: () => ({ name: "default" }),
      currentName: () => "default",
      list: () => [],
      add: vi.fn(async () => {}),
      switch: vi.fn(async () => {}),
    } as unknown as IProfileRegistry;
    const { client, calls } = makeClient(handlers);
    const restart = vi.fn(async () => makeClient({}).client);
    const subproc = {
      registerSpec: vi.fn(),
      forgetSpec: vi.fn(async () => {}),
      ensureRunning: vi.fn(async () => client),
      restart,
    } as unknown as SubprocessManager;
    const ch = new LoggedInChannel(subproc, 9333, profiles, () => ({}) as never);
    const get = (ch as unknown as { getMcpClient(): Promise<McpClient> }).getMcpClient.bind(ch);
    return { client, calls, restart, get };
  }

  it("15. getMcpClient 末尾 reconcile 楔死 → heal 层 1 后返回（下一个 action 永远看不到楔死态）", async () => {
    const { client, calls, get } = await makeProactiveChannel({
      // 楔死态：ensureOwnPageSelected 的 list（n=1）与 reconcile 的 list（n=2）
      // 都报签名；heal 用 new_page 重置后恢复健康
      list_pages: (n) =>
        n <= 2 ? textContent(WEDGE_TEXT, true) : textContent("## Pages\n\n1: about:blank (about:blank) [selected]"),
      new_page: () => textContent("## Pages\n\n1: about:blank (about:blank) [selected]"),
      take_snapshot: () => textContent("ok page"),
    });
    const got = await get();
    expect(got).toBe(client);
    expect(calls.find((c) => c.name === "new_page")).toBeTruthy();
  });

  it("16. 主动 heal 层 1 失败 → 层 2 respawn：getMcpClient 返回新 client", async () => {
    const client2 = makeClient({}).client;
    const profiles = {
      getCurrent: () => ({ name: "default" }),
      currentName: () => "default",
      list: () => [],
      add: vi.fn(async () => {}),
      switch: vi.fn(async () => {}),
    } as unknown as IProfileRegistry;
    const { LoggedInChannel } = await import("../../src/channels/LoggedInChannel.js");
    const { client } = makeClient({
      list_pages: () => textContent(WEDGE_TEXT, true),
      new_page: () => textContent(WEDGE_TEXT, true),
      take_snapshot: () => textContent("ok"),
    });
    const restart = vi.fn(async () => client2);
    const subproc = {
      registerSpec: vi.fn(),
      forgetSpec: vi.fn(async () => {}),
      ensureRunning: vi.fn(async () => client),
      restart,
    } as unknown as SubprocessManager;
    const ch = new LoggedInChannel(subproc, 9333, profiles, () => ({}) as never);
    const got = await (ch as unknown as { getMcpClient(): Promise<McpClient> }).getMcpClient();
    expect(got).toBe(client2);
    expect(restart).toHaveBeenCalled();
  });
});

// ============================================================
// 源码锚（INV-89 测试面镜像）
// ============================================================
describe("BUG-04B 源码锚", () => {
  it("17. INV-89 镜像：heal 函数体零 Chrome 生命周期调用（只 new_page + subproc.restart）", () => {
    const src = readFileSync("src/channels/LoggedInChannel.ts", "utf8");
    const heal = src.match(/protected override async healUpstreamWedge\([\s\S]*?\n  \}/);
    expect(heal).toBeTruthy();
    // 剥注释后禁 Chrome kill/生命周期原语
    const body = heal![0].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(body).not.toMatch(/killTree|stopLaunchedChromes|process\.kill|chrome-stop|hideChrome/);
    expect(body).toMatch(/new_page/);
    expect(body).toMatch(/subproc\.restart/);
  });
});
