/**
 * BrowseChannel 上游契约回归单测（v1.8 Phase A，W1-DEF-1/2/3/5）
 *
 * 上游真实契约锚点（chrome-devtools-mcp@1.7.0，round1 T1 tarball 白盒 + wave1 实测）：
 *  - evaluate_script 的 function 参数要**函数表达式**（上游 eval 成函数后调用），
 *    不是 IIFE 语句串 → mock 按 `eval("(" + fn + ")")` 真实执行（非函数即 isError）
 *  - wait_for.text 要非空 string 数组（1.7.0 zod.array().min(1)；0.3.0 是 string）
 *  - take_screenshot 不传 filePath（Lasso 自落盘 + stat 校验语义更强）
 *  - navigate 对 404 页 / Chrome DNS 错误页同样返成功 → navigate 后必须校验加载结果
 *
 * 覆盖：
 *  - W1-DEF-2：wait action → wait_for 传 [string] 数组（1.7.0 契约）
 *  - W1-DEF-3：screenshot → 不传 filePath；base64 落盘 + fs 校验（文件真实存在且非空）；
 *              空 base64 / 上游 isError → outcome=didnt + screenshot_write_failed
 *  - W1-DEF-1：evaluate（markdown 抽取 / network 注入）传的必须是可 eval 的函数表达式，
 *              且 mock 真实调用该函数（IIFE 语句串会直接 isError）
 *  - W1-DEF-5：navigate 正常页仍 worked；404 页 → didnt + http_404；
 *              Chrome 错误页 / 上游 ERR_NAME_NOT_RESOLVED → didnt + dns_or_nav_error；
 *              校验快照通道失败 → 保持 worked（校验 best-effort）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import {
  mockEvalResponse,
  mockScreenshotResponse,
  VALID_PNG_BASE64,
} from "../helpers/upstream-mock.js";
import type {
  BrowseOptions,
  BrowseResult,
  InteractResult,
} from "../../src/types.js";

// ============================================================
// 真实上游 mock：按 chrome-devtools-mcp@0.3.0 契约执行
// ============================================================
function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

interface UpstreamFixture {
  /** navigate_page 返回（默认成功 + final_url） */
  navigate?: () => Promise<{ content: unknown[]; isError?: boolean }> | never;
  /** take_snapshot 返回文本（默认正常页） */
  snapshotText?: string;
  /** take_snapshot 抛错（模拟校验通道断开） */
  snapshotThrows?: boolean;
  /** take_screenshot 返回（默认 1x1 PNG base64） */
  screenshotBase64?: string;
  /** take_screenshot 返 isError */
  screenshotIsError?: boolean;
  /** evaluate_script 覆盖（默认按真实契约 eval+调用） */
  evalOverride?: (fn: string) => { content: unknown[]; isError?: boolean };
  /** wait_for 返 isError（上游超时形态；默认成功） */
  waitIsError?: boolean;
}

function makeUpstreamClient(fx: UpstreamFixture = {}): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "navigate_page") {
        if (fx.navigate) return await fx.navigate();
        return textContent("navigated to https://example.com/");
      }
      if (name === "take_snapshot") {
        if (fx.snapshotThrows) throw new Error("snapshot_channel_down");
        return textContent(fx.snapshotText ?? "Example Domain\n\nMore information...");
      }
      if (name === "wait_for") {
        if (fx.waitIsError) return textContent("Timeout waiting for text", true);
        return textContent("text found");
      }
      if (name === "take_screenshot") {
        if (fx.screenshotIsError) return textContent("page screenshot failed", true);
        // W1-DEF-1b 真实契约：base64 在 image block（不在 text），见 helpers/upstream-mock
        return mockScreenshotResponse(fx.screenshotBase64 ?? VALID_PNG_BASE64);
      }
      if (name === "evaluate_script") {
        if (fx.evalOverride) return fx.evalOverride(String(args.function ?? ""));
        // W1-DEF-1 真实契约：上游把 function 参数 eval 成函数再调用；
        // IIFE 语句串（旧代码形态）eval 会炸 / 非函数 → isError
        let fn: unknown;
        try {
          fn = eval(`(${String(args.function ?? "")})`);
        } catch {
          return textContent("fn is not a function", true);
        }
        if (typeof fn !== "function") {
          return textContent("fn is not a function", true);
        }
        const v = await (fn as () => unknown)();
        // W1-DEF-1b 真实契约：上游把脚本返回值 JSON.stringify 后包进 ```json 围栏
        return mockEvalResponse(v === undefined ? null : v);
      }
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client, calls };
}

/** 最小具体子类：直接注入 mock McpClient。 */
class TestBrowseChannel extends BrowseChannel {
  readonly name = "browse_test";
  constructor(private readonly c: McpClient) {
    super();
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.c);
  }
}

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-contract-"));
  setStateStoreContext({ runId, cacheDir: tempCache });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    /* teardown 尽力而为 */
  }
});

// ============================================================
// W1-DEF-2：wait_for.text 非空 string 数组（v1.11 随 1.7.0 翻转）
// ============================================================
describe("W1-DEF-2 — wait action 传非空 string 数组（1.7.0 契约）", () => {
  it("wait_for.args.text 是 [string] 数组，且 call 成功 → outcome=worked", async () => {
    const { client, calls } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { text: "Welcome" },
    } as BrowseOptions);
    const waitCall = calls.find((c) => c.name === "wait_for");
    expect(waitCall).toBeTruthy();
    // v1.11（round1 T1）：chrome-devtools-mcp 1.7.0 wait_for.text =
    // zod.array(zod.string()).min(1)（waitForTextOnPage 对 text.flatMap）——
    // 单条 string 会被 zod 拒（0.3.0 契约相反）
    expect(waitCall!.args.text).toEqual(["Welcome"]);
    expect(Array.isArray(waitCall!.args.text)).toBe(true);
    expect(r.outcome).toBe("worked");
  });

  // W-DEF-R11-1（v1.17.3 ft-round1 R11 真机修）：probe2 W1/W2 实证两缺口——
  // ① expect.timeout_ms 被静默忽略（恒烧上游默认 30s）；② 上游超时以 isError
  // 响应返回（callTool 不 throw），不检则文本从未出现仍报 worked（假成功）。
  it("expect.timeout_ms 透传 wait_for.timeout（ms 整数）", async () => {
    const { client, calls } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { text: "Welcome", timeout_ms: 3000 },
    } as BrowseOptions);
    const waitCall = calls.find((c) => c.name === "wait_for");
    expect(waitCall!.args.timeout).toBe(3000);
    expect(r.outcome).toBe("worked");
  });

  it("wait_for 返 isError（上游超时）→ 不再假 worked；error 含 wait_timeout（classify → unknown）", async () => {
    const { client } = makeUpstreamClient({ waitIsError: true });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { text: "Never Appears", timeout_ms: 3000 },
    } as BrowseOptions);
    expect(r.outcome).not.toBe("worked");
    expect(r.outcome).toBe("unknown"); // wait_timeout → 可 fallback 档（页面慢可重试）
    expect(String(r.error)).toContain("wait_timeout");
  });
});

// ============================================================
// W1-DEF-3：screenshot base64 落盘 + fs 校验
// ============================================================
describe("W1-DEF-3 — screenshot 落盘真实文件（禁伪造路径）", () => {
  it("不传 filePath；上游 base64 → Lasso 落盘 /tmp/lasso-screenshot-*.png 且文件非空", async () => {
    const { client, calls } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    const r: InteractResult<BrowseResult> = await ch.browse(
      "https://example.com/",
      "screenshot",
      {} as BrowseOptions,
    );
    const shotCall = calls.find((c) => c.name === "take_screenshot");
    expect(shotCall).toBeTruthy();
    expect(shotCall!.args.filePath).toBeUndefined(); // 0.3.0 无此参数
    expect(r.outcome).toBe("worked");
    const m = r.data!.preview!.match(/(\/tmp\/lasso-screenshot-[^\s]+\.png)/);
    expect(m).toBeTruthy();
    const st = await fs.stat(m![1]);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBeGreaterThan(0);
    await fs.rm(m![1], { force: true });
  });

  it("上游返空 base64 → outcome=didnt + screenshot_write_failed（不伪造路径）", async () => {
    const { client } = makeUpstreamClient({ screenshotBase64: "" });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "screenshot", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("screenshot_write_failed");
    expect(r.data).toBeNull();
  });

  it("上游返 isError → outcome=didnt + screenshot_write_failed", async () => {
    const { client } = makeUpstreamClient({ screenshotIsError: true });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "screenshot", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("screenshot_write_failed");
  });
});

// ============================================================
// W1-DEF-1：evaluate_script 函数表达式契约
// ============================================================
describe("W1-DEF-1 — evaluate_script 传函数表达式（mock 按真实契约 eval+调用）", () => {
  it("extract markdown 档：函数表达式被上游接受 → outcome=worked（IIFE 形态会 isError）", async () => {
    vi.stubGlobal("document", {
      documentElement: {
        outerHTML:
          "<html><head><title>Example</title></head><body><h1>Hello</h1><p>World</p></body></html>",
      },
      title: "Example",
    });
    vi.stubGlobal("window", { location: { href: "https://example.com/" } });
    const { client, calls } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "extract", {
      extract_mode: "markdown",
    } as BrowseOptions);
    // mock 的 evaluate_script 按真实契约 eval——IIFE 语句串会返 isError 使 extract 抛错；
    // worked 即证明传的是合法函数表达式
    expect(r.outcome).toBe("worked");
    const evalCall = calls.find((c) => c.name === "evaluate_script");
    expect(evalCall).toBeTruthy();
    const fn = eval(`(${evalCall!.args.function})`);
    expect(typeof fn).toBe("function");
  });

  it("network action：v1.11 T5 调原生 list_network_requests（不再注入 evaluate_script）", async () => {
    const { client, calls } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "network", {
      network_timeout_ms: 100,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // 原生工具被调（1.7.0 list_network_requests；0.3.0 注入路径已删）
    const listCall = calls.find((c) => c.name === "list_network_requests");
    expect(listCall).toBeTruthy();
    // mock stub 无 reqid= 行 → 空 entries（合法结果）
    expect(r.data!.preview).toBe("[]");
    // doNetwork 自身不再调 evaluate_script（navigate 校验路径的 evaluate 除外——
    // 该调用发生在 list_network_requests 之前）
    const listIdx = calls.indexOf(listCall!);
    const evalAfter = calls
      .slice(listIdx)
      .find((c) => c.name === "evaluate_script");
    expect(evalAfter).toBeUndefined();
  });
});

// ============================================================
// W1-DEF-5：navigate 后校验真实加载结果
// ============================================================
describe("W1-DEF-5 — navigate 校验（404 / DNS 错误页不再是假 worked）", () => {
  it("正常页 → outcome=worked（worked 语义不变）", async () => {
    const { client } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.final_url).toBe("https://example.com/");
  });

  it("404 页（title '404 Not Found'）→ outcome=didnt + http_404", async () => {
    const { client } = makeUpstreamClient({
      snapshotText: "404 Not Found\n\nThe page you requested was not found.",
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/missing", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("http_404");
  });

  it("Chrome DNS 错误页（This site can't be reached + ERR_NAME_NOT_RESOLVED）→ didnt + dns_or_nav_error", async () => {
    const { client } = makeUpstreamClient({
      snapshotText:
        "This site can’t be reached\n\nwww.nonexistent-example.com’s server IP address could not be found.\nDNS_PROBE_FINISHED_NXDOMAIN",
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://www.nonexistent-example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("dns_or_nav_error");
  });

  it("上游 navigate 直接抛 ERR_NAME_NOT_RESOLVED → didnt + dns_or_nav_error", async () => {
    const { client } = makeUpstreamClient({
      navigate: (() => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED at https://no-such-host.invalid/");
      }) as never,
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://no-such-host.invalid/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("dns_or_nav_error");
  });

  it("校验快照通道失败（take_snapshot 抛错）→ 保持 worked（校验 best-effort 不误伤）", async () => {
    const { client } = makeUpstreamClient({ snapshotThrows: true });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("worked");
  });

  it("正常页正文含 '404' 字样但非 404 特征（如 'error 4040 reported'）→ 仍 worked", async () => {
    const { client } = makeUpstreamClient({
      snapshotText: "Example Domain\n\nWe fixed error 4040 in our tracker.",
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "navigate", {} as BrowseOptions);
    expect(r.outcome).toBe("worked");
  });
});
