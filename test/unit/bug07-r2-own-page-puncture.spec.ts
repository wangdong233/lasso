/**
 * bug07-r2-own-page-puncture.spec.ts（BUG-07 对抗复审 r2，doc/bugs/07 §8，2026-09-10）
 *
 * 第 4 穿透口（验收轮实证，真机级保真模型复现后收口）：
 *  LoggedInChannel.ensureOwnPageSelected（非 ledger 用户 Chrome 路径）在 own 页被
 *  外部关闭（用户手关）后，于下一次 getMcpClient 内**静默自建新 about:blank own
 *  页并 select_page**——无错误签名、r1 三处 invalidation 调用点（heal 层 1/层 2/
 *  recoverNoPageSelected）全不经过 → current-page 截图 level-1/level-2 全过 →
 *  worked + 空白页伪造，击穿决议 §5.9「用户手关 → 显式 didnt」承诺。
 *
 * 封法（与 r1 三调用点同族）：ensureOwnPageSelected 的换页 commit 点
 * （select_page 成功 + ownPageId 登记后）调用 invalidateCurrentPageSession——
 * url-bearing 调用随后经导航重建 lastNavigatedClient，零影响（T17-c 验证非粘滞）。
 *
 * 保真模型：CdpClient vi.mock（createBackgroundTarget = 向页面视图推入新页）；
 * take_screenshot = selected 指针指向已消失页时抛上游楔死签名（既定行为）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { IProfileRegistry } from "../../src/logged-in/ProfileRegistry.js";

const WEDGE_TEXT =
  "The selected page has been closed. Call list_pages to see open pages.";
const NO_SESSION_ERROR = "no_active_session:current_page_screenshot";

/** 页面视图（上游 list_pages 所见）+ 上游选中指针。 */
type Pg = { pageId: number; url: string; selected: boolean };
const model = vi.hoisted(() => ({
  pages: [] as Array<{ pageId: number; url: string; selected: boolean }>,
  upstreamSelected: null as number | null,
  nextId: 10,
  reset() {
    this.pages = [{ pageId: 10, url: "https://user-tab.example/", selected: true }];
    this.upstreamSelected = 10; // 上游连接即选 pages[0]
    this.nextId = 0; // 首次 createBackgroundTarget → +101 = 101（第二次 → 202）
  },
  render() {
    return (
      "## Pages\n\n" +
      this.pages
        .map((p) => `${p.pageId}: ${p.url} ${p.selected ? "[selected]" : ""}`)
        .join("\n")
    );
  },
}));

const cdpMock = vi.hoisted(() => ({
  createCalls: [] as string[],
  createBackgroundTarget: vi.fn(async (url: string) => {
    // 真实语义：Target.createTarget 确认即页存在——同步推入视图
    model.nextId += 101;
    model.pages.push({ pageId: model.nextId, url, selected: false });
    return `t-${model.nextId}`;
  }),
  closeTarget: vi.fn(async () => true),
  close: vi.fn(async () => {}),
}));

vi.mock("../../src/logged-in/CdpClient.js", () => ({
  CdpClient: vi.fn(() => cdpMock),
}));

function pngBytes(minSize = 200): Buffer {
  const buf = Buffer.alloc(minSize, 0xff);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  return buf;
}
const textContent = (text: string, isError = false) =>
  ({ content: [{ type: "text", text }], isError });

describe("BUG-07R2 · 第 4 穿透口：ensureOwnPageSelected 静默换页", () => {
  let tempCache: string;
  let client: McpClient;
  let allCalls: Array<{ name: string; args: Record<string, unknown> }>;
  let shotCalls: number;
  let wedges: number;
  let selectCalls: number[];

  beforeEach(() => {
    _resetRunIdForTests();
    newRunId();
    tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-bug07r2-"));
    setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
    process.env.LASSO_LAUNCHED_CHROMES_PATH = path.join(tempCache, "launched.json");
    writeFileSync(process.env.LASSO_LAUNCHED_CHROMES_PATH, "[]"); // 非 ledger（用户自开 Chrome）
    process.env.LASSO_DESIRED_HIDDEN_PATH = path.join(tempCache, "hidden.json");
    process.env.LASSO_SCREENSHOT_DIR = mkdtempSync(path.join(os.tmpdir(), "lasso-bug07r2-out-"));

    model.reset();
    cdpMock.createCalls.length = 0;
    cdpMock.createBackgroundTarget.mockClear();
    allCalls = [];
    shotCalls = 0;
    wedges = 0;
    selectCalls = [];

    client = {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
        allCalls.push({ name, args });
        if (name === "list_pages") return textContent(model.render()) as never;
        if (name === "select_page") {
          selectCalls.push(Number(args.pageId));
          model.upstreamSelected = Number(args.pageId);
          for (const p of model.pages) p.selected = p.pageId === model.upstreamSelected;
          return textContent(`Selected page ${args.pageId}`) as never;
        }
        if (name === "navigate_page") {
          if (!model.pages.some((p) => p.pageId === model.upstreamSelected)) {
            throw new Error(WEDGE_TEXT);
          }
          return textContent("navigated") as never;
        }
        if (name === "take_snapshot") return textContent("# ok page") as never;
        if (name === "take_screenshot") {
          shotCalls++;
          // 保真：selected 指向已消失页 → 上游楔死签名；存活（含新空白页）→ 成功
          if (!model.pages.some((p) => p.pageId === model.upstreamSelected)) {
            wedges++;
            throw new Error(WEDGE_TEXT);
          }
          writeFileSync(String(args.filePath), pngBytes());
          return textContent("# take_screenshot response") as never;
        }
        return textContent(`stubbed ${name}`) as never;
      }),
      listTools: vi.fn(async () => []),
      close: vi.fn(async () => {}),
      pid: 99999,
      stderr: null,
      isConnected: true,
    } as unknown as McpClient;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
    delete process.env.LASSO_DESIRED_HIDDEN_PATH;
    delete process.env.LASSO_SCREENSHOT_DIR;
    rmSync(tempCache, { recursive: true, force: true });
  });

  async function makeChannel() {
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
      ensureRunning: vi.fn(async () => client),
      restart: vi.fn(async () => client),
      touch: vi.fn(),
    } as unknown as SubprocessManager;
    return new LoggedInChannel(subproc, 9461, profiles, () => ({}) as never);
  }

  it("T17. navigate 建会话 → 用户手关 own 页 → current-page 截图 = 显式 didnt（第 4 穿透口已封）", async () => {
    const ch = await makeChannel();

    // 步骤 1：navigate 建会话（S-7：非 ledger → 自建后台 own 页 101 并选中）
    const nav = await ch.browse("https://example.com/", "navigate", {});
    expect(nav.outcome).toBe("worked");
    expect(selectCalls).toEqual([101]);
    expect(shotCalls).toBe(0);

    // 步骤 2：用户手关 own 页（外部行为：页从视图消失，用户 tab 复选）
    model.pages = model.pages.filter((p) => p.pageId !== 101);
    model.pages[0]!.selected = true;
    model.upstreamSelected = model.pages[0]!.pageId;

    // 步骤 3：current-page 截图（无 url）
    const r = await ch.browse(undefined, "screenshot", {});

    // 契约（§5.9）：显式 didnt —— 绝不静默截新自建空白页伪造 worked
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe(NO_SESSION_ERROR);
    expect(r.hint).toContain("current-page screenshot requires an active session");
    // 静默换页本身照旧发生（S-7 url-bearing 语义不变）——但截图被守卫拦下：
    expect(selectCalls).toEqual([101, 202]); // ensureOwnPageSelected 又自建+选中了 202
    expect(shotCalls).toBe(0); // take_screenshot 零调用（修复前=1 且 wedges=0）
    expect(wedges).toBe(0);
  });

  it("T17-c. 非粘滞：invalidation 后 url-bearing navigate 即重建会话，current-page 恢复可用", async () => {
    const ch = await makeChannel();
    await ch.browse("https://example.com/", "navigate", {});
    expect(selectCalls).toEqual([101]);
    // 手关 → current-page 拒
    model.pages = model.pages.filter((p) => p.pageId !== 101);
    model.pages[0]!.selected = true;
    model.upstreamSelected = model.pages[0]!.pageId;
    const denied = await ch.browse(undefined, "screenshot", {});
    expect(denied.outcome).toBe("didnt");
    expect(denied.error).toBe(NO_SESSION_ERROR);
    // 重建：url-bearing navigate（own 202 已选中，早退无换页）→ 会话恢复
    const renavigated = await ch.browse("https://example.com/again", "navigate", {});
    expect(renavigated.outcome).toBe("worked");
    const shot = await ch.browse(undefined, "screenshot", {});
    expect(shot.outcome).toBe("worked");
    expect(shot.data?.url).toBe("current-page");
    expect(shotCalls).toBe(1);
  });
});
