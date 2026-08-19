/**
 * P6（v1.18.1，得到实战问题集 P6）："No page selected" 零页面自愈回归测试。
 *
 * 事故形态（server4-stderr.log 05:26:04 白盒实证）：上一代 server 停机清账后
 * 遗留的 hidden Chrome（--no-startup-window，0 page target）——
 *  - precreateBackgroundTabIfHidden 判定门（台账 launchMode==="hidden"）跳过；
 *  - ensureOwnPageSelected 因 list_pages 零页列表 parse null 而 silent bail；
 *  - 上游所有页级调用经 getSelectedMcpPage 抛 "No page selected"
 *    （chrome-devtools-mcp McpContext.js:250）。
 *
 * 修复（两层）：
 *  A. BrowseChannel.browseSingle：action 抛 "No page selected" 且
 *     recoverNoPageSelected(c) 返 true → 原样重试一次（默认钩子 false = 零变化）；
 *  B. LoggedInChannel.recoverNoPageSelected：CDP createBackgroundTarget 预建
 *     about:blank + list_pages id-diff 归因 + select_page（零激活指针切换）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { IProfileRegistry } from "../../src/logged-in/ProfileRegistry.js";
import type { BrowseOptions } from "../../src/types.js";

// ---- CdpClient mock（LoggedInChannel 自愈路径的预建原语；vi.hoisted 防提升 TDZ）----
const mocks = vi.hoisted(() => ({
  createBackgroundTarget: vi.fn(async () => "TESTTARGET1"),
}));
vi.mock("../../src/logged-in/CdpClient.js", () => ({
  CdpClient: class {
    constructor(_port: number) {}
    createBackgroundTarget = mocks.createBackgroundTarget;
    close = vi.fn(async () => {});
  },
}));

function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function makeClient(handlers: Record<string, (n: number) => unknown>): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
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

/** 可注入自愈钩子的最小具体子类（BrowseChannel 层重试编排验证）。 */
class TestBrowseChannel extends BrowseChannel {
  readonly name = "browse_test";
  recoverCalls = 0;
  recoverResult: boolean;
  constructor(
    private readonly c: McpClient,
    opts: { recoverResult?: boolean } = {},
  ) {
    super();
    this.recoverResult = opts.recoverResult ?? true;
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.c);
  }
  protected override async recoverNoPageSelected(_c: McpClient): Promise<boolean> {
    this.recoverCalls++;
    return this.recoverResult;
  }
}

/** 默认钩子子类（不 override —— HeadlessChannel 形态零变化验证）。 */
class DefaultHookChannel extends TestBrowseChannel {
  protected override recoverNoPageSelected(_c: McpClient): Promise<boolean> {
    void _c;
    return false; // 显式镜像基类默认（防 TestBrowseChannel 干扰）
  }
}

let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-p6-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
  mocks.createBackgroundTarget.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    /* teardown 尽力而为 */
  }
});

// ============================================================
// A. BrowseChannel.browseSingle 自愈重试编排
// ============================================================
describe("P6A — browseSingle：No page selected → 自愈成功后原样重试一次", () => {
  it("1. navigate 首调抛 No page selected，钩子成功 → 重试成功 → outcome=worked", async () => {
    const { client, calls } = makeClient({
      navigate_page: (n) =>
        n === 1
          ? textContent("No page selected", true)
          : textContent("navigated to https://example.com/"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(calls.filter((c) => c.name === "navigate_page")).toHaveLength(2);
    expect(ch.recoverCalls).toBe(1);
  });

  it("2. 默认钩子（false）→ 错误原样透传（HeadlessChannel 行为零变化）", async () => {
    const { client } = makeClient({
      navigate_page: () => textContent("No page selected", true),
    });
    const ch = new DefaultHookChannel(client);
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("unknown"); // classifyBrowseError 未识别 → unknown
    expect(r.error).toContain("No page selected");
  });

  it("3. 非 No-page 错误（如 404 校验）不触发自愈", async () => {
    const { client, calls } = makeClient({
      navigate_page: () => textContent("navigated"),
      take_snapshot: () => textContent("404 Not Found\n\nnot found here"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse(
      "https://example.com/missing",
      "navigate",
      {} as BrowseOptions,
    );
    expect(r.outcome).toBe("didnt"); // http_404 语义不受 P6 影响
    expect(ch.recoverCalls).toBe(0);
    expect(calls.filter((c) => c.name === "take_snapshot")).toHaveLength(1);
  });

  it("4. 自愈后重试仍失败 → 第二次错误透传（不无限重试）", async () => {
    const { client } = makeClient({
      navigate_page: () => textContent("No page selected", true),
    });
    const ch = new TestBrowseChannel(client, { recoverResult: true });
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("No page selected");
    expect(ch.recoverCalls).toBe(1); // 只自愈一次
  });
});

// ============================================================
// B. LoggedInChannel.recoverNoPageSelected（预建 + 归因 + 选中）
// ============================================================
describe("P6B — LoggedInChannel 自愈原语（CDP 预建 + id-diff 归因 + select_page）", () => {
  async function makeChannel() {
    const { LoggedInChannel } = await import("../../src/channels/LoggedInChannel.js");
    const profiles = {
      getCurrent: () => ({ name: "default" }),
      currentName: () => "default",
      list: () => [],
      add: vi.fn(async () => {}),
      switch: vi.fn(async () => {}),
    } as unknown as IProfileRegistry;
    const ch = new LoggedInChannel(
      {} as SubprocessManager,
      9333,
      profiles,
      () => ({}) as never,
    );
    return { ch: ch as unknown as { recoverNoPageSelected(c: McpClient): Promise<boolean> } };
  }

  it("5. 零页起步：list 前空 → 建后归因唯一 → select_page 后返 true", async () => {
    const { client, calls } = makeClient({
      list_pages: (n) =>
        n === 1
          ? textContent("## Pages\n") // 零页（parse null）
          : textContent("## Pages\n\n1: about:blank (about:blank) [selected]"),
      select_page: () => textContent("ok"),
    });
    const { ch } = await makeChannel();
    const ok = await ch.recoverNoPageSelected(client);
    expect(ok).toBe(true);
    expect(mocks.createBackgroundTarget).toHaveBeenCalledWith("about:blank");
    const sel = calls.find((c) => c.name === "select_page");
    expect(sel).toBeTruthy();
    expect(sel!.args).toEqual({ pageId: 1 });
  });

  it("6. 归因不唯一（建后冒出 2 页）→ 放弃返 false（宁失败不误选）", async () => {
    const { client, calls } = makeClient({
      list_pages: (n) =>
        n === 1
          ? textContent("## Pages\n")
          : textContent("## Pages\n\n1: a (about:blank)\n2: b (about:blank)"),
    });
    const { ch } = await makeChannel();
    const ok = await ch.recoverNoPageSelected(client);
    expect(ok).toBe(false);
    expect(calls.find((c) => c.name === "select_page")).toBeUndefined();
  });

  it("7. CDP 预建失败（返 null）→ false、不 select", async () => {
    mocks.createBackgroundTarget.mockResolvedValueOnce(null);
    const { client, calls } = makeClient({
      list_pages: () => textContent("## Pages\n"),
    });
    const { ch } = await makeChannel();
    const ok = await ch.recoverNoPageSelected(client);
    expect(ok).toBe(false);
    expect(calls.find((c) => c.name === "select_page")).toBeUndefined();
  });
});

// ============================================================
// 源码锚（防回潮）
// ============================================================
describe("P6 源码锚", () => {
  it("8. browseSingle 只在 No page selected 签名 + 钩子成功时重试（NO_PAGE_SELECTED_RE 存在）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/channels/BrowseChannel.ts", "utf8");
    expect(src).toMatch(/NO_PAGE_SELECTED_RE\.test\(String\(e\)\)/);
    expect(src).toMatch(/recoverNoPageSelected\(c\)/);
    // 基类默认 false（子类不 override = 零变化）
    expect(src).toMatch(/protected async recoverNoPageSelected\(_c: McpClient\): Promise<boolean> \{\s*return false;/);
  });
});

