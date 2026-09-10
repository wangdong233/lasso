/**
 * bug07-current-page-screenshot.spec.ts（BUG-07 决议 A⁺，doc/bugs/07 §5，2026-09-10）
 *
 * 消费方台账 L-4：两条截图路径均必经重导航，状态敏感截图（CSS 动画
 * getAnimations().pause() 冻结在 35% 的中间帧取证）不可达——消费方被迫借道
 * playwright（违反单一交互抓手定位）。
 *
 * 修复面（决议 A⁺ 混合定案）：
 *  - url 在 browse_headless / browse_logged_in / 独立 screenshot 三处 schema
 *    可选化：省略 + action=screenshot = current-page 模式（零导航直接截当前
 *    受管页）；有 url = 现状 NAV_FIRST 字节级不变；
 *  - 无活动会话显式报错（didnt + no_active_session:current_page_screenshot，
 *    不静默新开、不静默截 about:blank 伪造状态）；
 *  - r1 三穿透口封堵：heal 换页（层 1 同 client / 层 2 respawn）与 P6 恢复
 *    都 invalidate current-page 会话；current-page 模式禁两条自愈重试；
 *  - 熔断纯净性：no-session 全程 early-return（无 recordFailure 污染）+
 *    classify / isFallbackWorthy 双兜底。
 *
 * 全 mock McpClient（BrowseChannel 子类注入）——零真浏览器。真机验证义务
 * （冻结动画 35% 中间帧）另见 bug doc §5.6 实施记录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import { isFallbackWorthy } from "../../src/fallback/outcome.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { IProfileRegistry } from "../../src/logged-in/ProfileRegistry.js";
import type { BrowseOptions, InteractResult } from "../../src/types.js";

/** 上游 McpContext.js:253 整串（真机楔死时 isError 响应文本即此）。 */
const WEDGE_TEXT =
  "The selected page has been closed. Call list_pages to see open pages.";

const NO_SESSION_ERROR = "no_active_session:current_page_screenshot";

// ============================================================
// helpers（e2-screenshot-dual-path / bug04-wedge-selfheal 同范式）
// ============================================================
/** >100 字节的合法 PNG 头缓冲（magic + 填充；最终校验只看头 8 字节）。 */
function pngBytes(minSize = 200): Buffer {
  const buf = Buffer.alloc(minSize, 0xab);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  return buf;
}

function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

type Handler = (n: number, args: Record<string, unknown>) => unknown;

function makeClient(handlers: Record<string, Handler>): {
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

/** take_screenshot 上游直写形态：把合法 PNG 写到 args.filePath（路径 1）。 */
function shotWriteHandler(): Handler {
  return (_n, args) => {
    writeFileSync(String(args.filePath), pngBytes());
    return textContent("# take_screenshot response");
  };
}

/**
 * 可观测 headless 形态通道：getMcpClient / heal / P6 三钩子计数 + 可换 client
 *（respawn 模拟）。
 */
class Bug07TestChannel extends BrowseChannel {
  readonly name = "browse_test_bug07";
  getCalls = 0;
  healCalls = 0;
  recoverCalls = 0;
  constructor(private readonly clientSupplier: () => McpClient) {
    super();
  }
  protected getMcpClient(): Promise<McpClient> {
    this.getCalls++;
    return Promise.resolve(this.clientSupplier());
  }
  protected override async healUpstreamWedge(c: McpClient): Promise<McpClient | null> {
    this.healCalls++;
    return c; // 层 1 形态：返回原 client
  }
  protected override async recoverNoPageSelected(_c: McpClient): Promise<boolean> {
    this.recoverCalls++;
    return true;
  }
}

let tempCache: string;
let shotDir: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-bug07-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
  shotDir = mkdtempSync(path.join(os.tmpdir(), "lasso-bug07-out-"));
  // BUG-05 决议 E：显式 filePath 须落在 LASSO_SCREENSHOT_DIR 写根内（T9 用）
  process.env.LASSO_SCREENSHOT_DIR = shotDir;
  // 台账隔离（LoggedInChannel 构造/getMcpClient 路径会 readLedgerSync）
  process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tempCache, "launched-chromes.json");
  process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(tempCache, "desired-hidden.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LASSO_SCREENSHOT_DIR;
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  delete process.env.LASSO_DESIRED_HIDDEN_PATH;
  rmSync(tempCache, { recursive: true, force: true });
  rmSync(shotDir, { recursive: true, force: true });
});

// ============================================================
// A. 有会话的成功路径（T1 / T12 / T7 / T9）
// ============================================================
describe("BUG-07A · current-page 截图成功路径", () => {
  it("T1. navigate → screenshot(无 url)：第二次 browse 零 navigate_page、take_screenshot 被调、worked、preview 含 /tmp 路径", async () => {
    const { client, calls } = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: shotWriteHandler(),
    });
    const ch = new Bug07TestChannel(() => client);

    const nav = await ch.browse("https://example.com/", "navigate", {});
    expect(nav.outcome).toBe("worked");

    const shot = await ch.browse(undefined, "screenshot", {});
    expect(shot.outcome).toBe("worked");
    // 核心：current-page 模式零重导航（旧行为会先 navigate_page 洗掉冻结态）
    expect(calls.filter((c) => c.name === "navigate_page")).toHaveLength(1);
    expect(calls.filter((c) => c.name === "take_screenshot")).toHaveLength(1);
    expect(shot.data?.preview).toMatch(/screenshot saved to \/tmp\/lasso-screenshot-/);
  });

  it("T12. 响应形状：current-page 成功 data.url='current-page'、final_url 同值回显", async () => {
    const { client } = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: shotWriteHandler(),
    });
    const ch = new Bug07TestChannel(() => client);
    await ch.browse("https://example.com/", "navigate", {});
    const shot = await ch.browse(undefined, "screenshot", {});
    expect(shot.outcome).toBe("worked");
    expect(shot.data?.url).toBe("current-page");
    expect(shot.data?.final_url).toBe("current-page");
  });

  it("T7. ignored_options 模式感知：current-page 传 no_cache 必标（无导航=死键）；url-present 对照不标", async () => {
    // current-page：no_cache 只经导航消费 → 必须出现在 ignored_options
    const { client } = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: shotWriteHandler(),
    });
    const ch = new Bug07TestChannel(() => client);
    await ch.browse("https://example.com/", "navigate", {});
    const shot = await ch.browse(undefined, "screenshot", { no_cache: true });
    expect(shot.outcome).toBe("worked");
    expect(shot.data?.ignored_options).toContain("no_cache");

    // url-present 对照：NAV_FIRST 先导航消费 no_cache → 不标
    const fresh = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: shotWriteHandler(),
    });
    const ch2 = new Bug07TestChannel(() => fresh.client);
    const shot2 = await ch2.browse("https://example.com/", "screenshot", { no_cache: true });
    expect(shot2.outcome).toBe("worked");
    expect(shot2.data?.ignored_options).toBeUndefined();
  });

  it("T9. current-page + 显式 filePath + 写根配置：守卫过 → 落盘成功（决议 E 正交）", async () => {
    const target = path.join(shotDir, "cur-frame.png");
    const { client } = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: shotWriteHandler(),
    });
    const ch = new Bug07TestChannel(() => client);
    await ch.browse("https://example.com/", "navigate", {});
    const shot = await ch.browse(undefined, "screenshot", {
      screenshot: { filePath: target },
    });
    expect(shot.outcome).toBe("worked");
    expect(existsSync(target)).toBe(true);
  });
});

// ============================================================
// B. 无活动会话：显式报错，不静默新开（T2 / T3）
// ============================================================
describe("BUG-07B · 无活动会话错误契约", () => {
  it("T2. 冷通道 screenshot(无 url)：didnt + no_active_session + hint；getMcpClient 未被调（不 spawn）", async () => {
    const { client } = makeClient({ take_screenshot: shotWriteHandler() });
    const ch = new Bug07TestChannel(() => client);
    const r = await ch.browse(undefined, "screenshot", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe(NO_SESSION_ERROR);
    expect(r.retrieval_method).toBe("current_page_no_session");
    expect(r.hint).toContain("current-page screenshot requires an active session");
    // 「不静默新开」：level-1 pre-check 在 getMcpClient 之前（不拉浏览器子进程）
    expect(ch.getCalls).toBe(0);
  });

  it("T3. respawn 后（client 换实例）screenshot(无 url)：同错误契约（不静默截空白页）", async () => {
    const a = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
    });
    const b = makeClient({ take_screenshot: shotWriteHandler() });
    let current = a.client;
    const ch = new Bug07TestChannel(() => current);
    const nav = await ch.browse("https://example.com/", "navigate", {});
    expect(nav.outcome).toBe("worked");

    current = b.client; // 上游 respawn：getMcpClient 换新实例（新浏览器=空白页）
    const r = await ch.browse(undefined, "screenshot", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe(NO_SESSION_ERROR);
    expect(ch.getCalls).toBe(2);
    expect(b.calls.filter((c) => c.name === "take_screenshot")).toHaveLength(0);
  });
});

// ============================================================
// C. url-present 回归锁（T4）：NAV_FIRST 原样
// ============================================================
describe("BUG-07C · 有 url 路径字节级不变", () => {
  it("T4. screenshot 带 url → navigate_page 先于 take_screenshot（NAV_FIRST 原样）+ data.url=入参", async () => {
    const { client, calls } = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: shotWriteHandler(),
    });
    const ch = new Bug07TestChannel(() => client);
    const r = await ch.browse("https://example.com/", "screenshot", {});
    expect(r.outcome).toBe("worked");
    const names = calls.map((c) => c.name);
    const navIdx = names.indexOf("navigate_page");
    const shotIdx = names.indexOf("take_screenshot");
    expect(navIdx).toBeGreaterThanOrEqual(0);
    expect(shotIdx).toBeGreaterThan(navIdx);
    expect(r.data?.url).toBe("https://example.com/");
  });
});

// ============================================================
// D. url 省略的分发语义门（T5）
// ============================================================
describe("BUG-07D · url_required_for_action 分发语义", () => {
  it("T5. 无 url + navigate / snapshot（缺省 action）/ steps 链 → didnt url_required_for_action:<action>", async () => {
    const { client } = makeClient({});
    const ch = new Bug07TestChannel(() => client);

    const nav = await ch.browse(undefined, "navigate", {});
    expect(nav.outcome).toBe("didnt");
    expect(nav.error).toBe("url_required_for_action:navigate");
    expect(nav.hint).toContain("url is optional only for action=screenshot");

    const snap = await ch.browse(undefined, "snapshot", {});
    expect(snap.outcome).toBe("didnt");
    expect(snap.error).toBe("url_required_for_action:snapshot");

    const steps = await ch.browse(undefined, "screenshot", {
      steps: [{ action: "navigate" }],
    } as BrowseOptions);
    expect(steps.outcome).toBe("didnt");
    expect(steps.error).toBe("url_required_for_action:screenshot");

    // 三者都是策略拒：不 spawn 浏览器子进程
    expect(ch.getCalls).toBe(0);
  });
});

// ============================================================
// E. 自愈禁令（r1 铁则 (a)：current-page 模式禁两条自愈重试）
// ============================================================
describe("BUG-07E · current-page 模式自愈禁令", () => {
  it("T-e1. 有会话 + take_screenshot 抛楔死签名 → didnt no_active_session；healUpstreamWedge 未被调（禁楔死自愈）", async () => {
    const { client, calls } = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: () => {
        throw new Error(WEDGE_TEXT);
      },
    });
    const ch = new Bug07TestChannel(() => client);
    await ch.browse("https://example.com/", "navigate", {});
    const r = await ch.browse(undefined, "screenshot", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe(NO_SESSION_ERROR);
    expect(ch.healCalls).toBe(0); // 铁则 (a)：不调 heal
    expect(calls.filter((c) => c.name === "new_page")).toHaveLength(0);
    expect(calls.filter((c) => c.name === "take_screenshot")).toHaveLength(1); // 零重试
  });

  it("T15. 有会话 + take_screenshot 抛 'No page selected' → didnt 同错误契约；recoverNoPageSelected 未被调（r1 ③ 第三穿透口）", async () => {
    const { client, calls } = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: () => {
        throw new Error("No page selected");
      },
    });
    const ch = new Bug07TestChannel(() => client);
    await ch.browse("https://example.com/", "navigate", {});
    const r = await ch.browse(undefined, "screenshot", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe(NO_SESSION_ERROR);
    expect(ch.recoverCalls).toBe(0); // 铁则 (a)：不调 P6 恢复
    expect(calls.filter((c) => c.name === "take_screenshot")).toHaveLength(1); // 无重试后 worked
  });

  it("T16. url-present 对照：楔死自愈与 P6 恢复重试照旧发生（铁则 (a) 只禁 current-page——INV-89/P6 行为零变化）", async () => {
    // (a) 楔死自愈：navigate_page 首调楔死 → heal → 重试成功
    const wedge = makeClient({
      navigate_page: (n) =>
        n === 1
          ? textContent(WEDGE_TEXT, true)
          : textContent("navigated to https://example.com/"),
      take_screenshot: shotWriteHandler(),
    });
    const chW = new Bug07TestChannel(() => wedge.client);
    const rW = await chW.browse("https://example.com/", "screenshot", {});
    expect(rW.outcome).toBe("worked");
    expect(chW.healCalls).toBe(1);
    expect(wedge.calls.filter((c) => c.name === "navigate_page")).toHaveLength(2);

    // (b) P6 恢复：navigate_page 首调 "No page selected" → recover → 重试成功
    const p6 = makeClient({
      navigate_page: (n) =>
        n === 1
          ? (() => {
              throw new Error("No page selected");
            })()
          : textContent("navigated to https://example.com/"),
      take_screenshot: shotWriteHandler(),
    });
    const chP = new Bug07TestChannel(() => p6.client);
    const rP = await chP.browse("https://example.com/", "screenshot", {});
    expect(rP.outcome).toBe("worked");
    expect(chP.recoverCalls).toBe(1);
    expect(p6.calls.filter((c) => c.name === "navigate_page")).toHaveLength(2);
  });
});

// ============================================================
// F. logged_in 通道 parity（T6 / T6b / T13）
// ============================================================
async function makeLoggedInChannel(handlers: Record<string, Handler>): Promise<{
  ch: import("../../src/channels/LoggedInChannel.js").LoggedInChannel;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  restart: ReturnType<typeof vi.fn>;
}> {
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
    touch: vi.fn(), // LoggedInChannel.touchKeepalive（browse 路径每 action 调）
  } as unknown as SubprocessManager;
  const ch = new LoggedInChannel(subproc, 9333, profiles, () => ({}) as never);
  return { ch, calls, restart };
}

const HEALTHY_PAGES = () =>
  textContent("## Pages\n\n1: about:blank (about:blank) [selected]");

describe("BUG-07F · logged_in 通道 parity", () => {
  it("T6. navigate → screenshot(无 url) worked（第二次零 navigate_page）", async () => {
    const { ch, calls } = await makeLoggedInChannel({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_snapshot: () => textContent("ok page"),
      list_pages: () => HEALTHY_PAGES(),
      take_screenshot: shotWriteHandler(),
    });
    const nav = await ch.browse("https://example.com/", "navigate", {});
    expect(nav.outcome).toBe("worked");
    const shot = await ch.browse(undefined, "screenshot", {});
    expect(shot.outcome).toBe("worked");
    expect(shot.data?.url).toBe("current-page");
    expect(calls.filter((c) => c.name === "navigate_page")).toHaveLength(1);
    expect(calls.filter((c) => c.name === "take_screenshot")).toHaveLength(1);
  });

  it("T6-cold. 冷通道 logged_in screenshot(无 url)：同错误契约（level-1 在拉 npx 上游之前）", async () => {
    const { ch } = await makeLoggedInChannel({
      list_pages: () => HEALTHY_PAGES(),
      take_snapshot: () => textContent("ok page"),
    });
    const r = await ch.browse(undefined, "screenshot", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe(NO_SESSION_ERROR);
    expect(r.hint).toBeTruthy();
  });

  it("T6b. logged_in 有会话 + take_screenshot 抛楔死签名 → 显式 didnt（healUpstreamWedge 未被调、new_page 零调用）", async () => {
    const { ch, calls } = await makeLoggedInChannel({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_snapshot: () => textContent("ok page"),
      list_pages: () => HEALTHY_PAGES(),
      take_screenshot: () => {
        throw new Error(WEDGE_TEXT);
      },
    });
    await ch.browse("https://example.com/", "navigate", {});
    const r = await ch.browse(undefined, "screenshot", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe(NO_SESSION_ERROR);
    // 楔死/自愈换页必须落显式 didnt 而非自愈后 worked（空白 PNG 伪造）
    expect(calls.filter((c) => c.name === "new_page")).toHaveLength(0);
  });

  it("T13. getMcpClient 主动 heal（reconcile 楔死→层 1 new_page）后 current-page 截图 → didnt no_active_session（invalidateCurrentPageSession 已置 null）", async () => {
    // list_pages 计数：第 1/2 次 = 首次 getMcpClient（navigate 的
    // ensureOwnPageSelected + reconcile）；第 3 次 = 第二次 getMcpClient 的
    // ensureOwnPageSelected（健康）；第 4 次 = reconcile → 楔死 → 主动 heal。
    const { ch, calls } = await makeLoggedInChannel({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_snapshot: () => textContent("ok page"),
      list_pages: (n) => (n === 4 ? textContent(WEDGE_TEXT, true) : HEALTHY_PAGES()),
      new_page: () => HEALTHY_PAGES(),
      take_screenshot: shotWriteHandler(),
    });
    await ch.browse("https://example.com/", "navigate", {});
    const r = await ch.browse(undefined, "screenshot", {});
    // heal 层 1 发生（new_page 被调）→ invalidation → level-2 拒（非 worked+空白 PNG）
    expect(calls.filter((c) => c.name === "new_page")).toHaveLength(1);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe(NO_SESSION_ERROR);
    expect(calls.filter((c) => c.name === "take_screenshot")).toHaveLength(0);
  });
});

// ============================================================
// G. 守卫组合 + 熔断纯净性（T8 / T14）
// ============================================================
describe("BUG-07G · 守卫组合与熔断纯净性", () => {
  it("T8. current-page + 显式 filePath + 空写根 → LASSO_SCREENSHOT_DIR 守卫照拒（决议 E 正交性）", async () => {
    delete process.env.LASSO_SCREENSHOT_DIR; // 空写根（默认关）
    const { client } = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: shotWriteHandler(),
    });
    const ch = new Bug07TestChannel(() => client);
    await ch.browse("https://example.com/", "navigate", {});
    const r = await ch.browse(undefined, "screenshot", {
      screenshot: { filePath: "/tmp/lasso-bug07-evil/x.png" },
    });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("screenshot_path_not_allowed");
  });

  it("T14. 熔断纯净性：连续 3 次冷通道 current-page → 三次均 didnt（非 all_channels_failed_or_skipped）+ hint 在场；decider fallbacks=[] 原样保留 error", async () => {
    const { client } = makeClient({ take_screenshot: shotWriteHandler() });
    const ch = new Bug07TestChannel(() => client);
    // channel 级三次：early-return 全程 didnt（无 unknown → 无 recordFailure 喂点）
    for (let i = 0; i < 3; i++) {
      const r = await ch.browse(undefined, "screenshot", {});
      expect(r.outcome).toBe("didnt");
      expect(r.error).toBe(NO_SESSION_ERROR);
      expect(r.hint).toBeTruthy();
    }
    // decider 级（tools/browse.ts current-page 请求 fallbacks=[]）：didnt 短路
    // 原样返回——error/hint 不落 fallback_exhausted 吞噬形态
    const decider = new FallbackDecider(new Map());
    const plan = { primary: "browse_headless", fallbacks: [] as string[], cross_modal: false };
    const dr = (await decider.runWithFallback(plan, async () =>
      ch.browse(undefined, "screenshot", {}),
    )) as InteractResult;
    expect(dr.outcome).toBe("didnt");
    expect(dr.error).toBe(NO_SESSION_ERROR);
    expect(dr.hint).toBeTruthy();
    expect(dr.retrieval_method).toBe("current_page_no_session");
  });

  it("T14b. classify 兜底行为锚：复合串 upstream_wedge_unhealed:no_active_session:x 落 didnt（规则序不截胡）", async () => {
    const { client } = makeClient({
      navigate_page: () => textContent("navigated to https://example.com/"),
      take_screenshot: () => {
        // 模拟残余 throw 路径产出 unknown+码的形态（铁则落地后本不可达——
        // 本用例钉 classify 规则序：no_active_session 先于 upstream_wedge）
        throw new Error("upstream_wedge_unhealed:no_active_session:x");
      },
    });
    const ch = new Bug07TestChannel(() => client);
    await ch.browse("https://example.com/", "navigate", {});
    const r = await ch.browse(undefined, "screenshot", {});
    expect(r.outcome).toBe("didnt"); // 旧规则序会落 unknown（upstream_wedge 截胡）
  });

  it("T14c. isFallbackWorthy 排除集锚：unknown+no_active_session / url_required_for_action 不 fallback", () => {
    expect(isFallbackWorthy("unknown", "no_active_session:current_page_screenshot")).toBe(false);
    expect(isFallbackWorthy("unknown", "url_required_for_action:snapshot")).toBe(false);
    // 对照：通道错仍 fallback-worthy（语义未收窄）
    expect(isFallbackWorthy("unknown", "upstream_wedge_unhealed:timeout")).toBe(true);
  });
});

// ============================================================
// H. 独立 screenshot 工具（T10）+ url-present 透传（T11 补充锚）
// ============================================================
describe("BUG-07H · 独立 screenshot 工具", () => {
  it("T10a. 无 url + 无会话 → 同错误契约直通（hint 透传；SSRF 整体跳过）", async () => {
    const { doScreenshotTool } = await import("../../src/tools/screenshot.js");
    const browseMock = vi.fn(async () => ({
      outcome: "didnt",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "current_page_no_session",
      error: NO_SESSION_ERROR,
      hint: "current-page screenshot requires an active session",
    }));
    const headless = { browse: browseMock } as never;
    const r = await doScreenshotTool(undefined, { full_page: false }, headless, {
      allowRanges: [],
      denyRanges: [],
    });
    expect(browseMock).toHaveBeenCalledWith(undefined, "screenshot", {
      screenshot: { full: false },
    });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe(NO_SESSION_ERROR);
    expect(r.hint).toContain("current-page screenshot requires an active session");
  });

  it("T10b. 无 url + 有会话（channel worked）→ data.path 抽出成功 + data.url='current-page'", async () => {
    const { doScreenshotTool } = await import("../../src/tools/screenshot.js");
    const browseMock = vi.fn(async () => ({
      outcome: "worked",
      data: {
        url: "current-page",
        action: "screenshot",
        preview: "screenshot saved to /tmp/lasso-screenshot-abc.png",
        final_url: "current-page",
        state_id: "s1",
      },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    }));
    const headless = { browse: browseMock } as never;
    const r = await doScreenshotTool(undefined, { full_page: false }, headless, {
      allowRanges: [],
      denyRanges: [],
    });
    expect(r.outcome).toBe("worked");
    expect(r.data?.path).toBe("/tmp/lasso-screenshot-abc.png");
    expect(r.data?.url).toBe("current-page");
  });

  it("T10c. schema：url 可选且无 default 注入（absent=undefined）", async () => {
    const { screenshotSchema } = await import("../../src/tools/screenshot.js");
    const parsed = z.object(screenshotSchema).parse({});
    expect(parsed.url).toBeUndefined();
    expect("url" in parsed).toBe(false); // zod 不注入键（无 .default()）
    const withUrl = z
      .object(screenshotSchema)
      .parse({ url: "https://example.com/" });
    expect(withUrl.url).toBe("https://example.com/");
  });

  it("T11-锚. url-present 全链透传：doScreenshotTool 带 url → browse(url, 'screenshot', opts) 不变", async () => {
    const { doScreenshotTool } = await import("../../src/tools/screenshot.js");
    const browseMock = vi.fn(async () => ({
      outcome: "worked",
      data: {
        url: "https://example.com/",
        preview: "screenshot saved to /tmp/lasso-screenshot-x.png",
      },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    }));
    const headless = { browse: browseMock } as never;
    const r = await doScreenshotTool(
      "https://example.com/",
      { full_page: true },
      headless,
      { allowRanges: [], denyRanges: [] },
    );
    expect(browseMock).toHaveBeenCalledWith("https://example.com/", "screenshot", {
      screenshot: { full: true },
    });
    expect(r.data?.url).toBe("https://example.com/");
    expect(r.data?.path).toBe("/tmp/lasso-screenshot-x.png");
  });
});
