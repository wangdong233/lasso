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
  /**
   * P10（v1.18.1）：listTools 返回的工具名集合。默认 = 锁定 1.7.0 真实面
   * （含 list_network_requests / list_console_messages，**不含 pdf**——与
   * npx 缓存白盒核实一致）；测试可传 ["pdf"] 模拟暴露 pdf 的假想上游。
   */
  toolNames?: string[];
}

/** P10：chrome-devtools-mcp@1.7.0 实测工具面（npx 缓存 tools/ 目录白盒）。 */
const UPSTREAM_170_TOOLS = [
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
];

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
    listTools: vi.fn(async () =>
      (fx.toolNames ?? UPSTREAM_170_TOOLS).map((name) => ({
        name,
        inputSchema: {},
      })),
    ),
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
// P5（v1.18.1，得到实战问题集 P5）：evaluate 上游错误假成功治理
// 实测三形态（.dedao-scout 探察 JSON 白盒证据）：
//  ① 协议超时 isError 响应："Network.enable timed out. Increase the 'protocolTimeout'…"
//  ② 脚本异常序列化（无围栏）："Error: t is not defined\npptr:evaluateHandle; …"
//  ③ 零页面（无围栏）："No page selected"（上游 McpContext.js:250）
// 此前 doEvaluate 不检 isError / 不识错误签名 → 三形态全报 outcome=worked，
// 错误文本被塞进 data.preview。修复 = doWait（W-DEF-R11-1）同范式：
// isError / 签名命中 → throw eval_upstream_error → classifyBrowseError 落 unknown。
// ============================================================
describe("P5 — evaluate 上游错误不再假 worked（isError + 错误签名）", () => {
  it("① isError（Network.enable timed out 形态）→ outcome=unknown + eval_upstream_error", async () => {
    const { client } = makeUpstreamClient({
      evalOverride: () =>
        textContent(
          "Network.enable timed out. Increase the 'protocolTimeout' setting in launch()/connect().",
          true,
        ),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "return document.title",
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown"); // classifyBrowseError 未识别 → unknown（可重试）
    expect(r.error).toContain("eval_upstream_error");
    expect(r.error).toContain("Network.enable timed out");
  });

  it("② 脚本异常序列化（Error:…\\npptr:，无围栏无 isError）→ 不再 worked", async () => {
    const { client } = makeUpstreamClient({
      evalOverride: () =>
        textContent("Error: t is not defined\npptr:evaluateHandle; docs: …"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "return t",
    } as BrowseOptions);
    expect(r.outcome).not.toBe("worked");
    expect(r.error).toContain("eval_upstream_error");
  });

  it("③ 零页面（整串恰为 No page selected，无围栏）→ 不再 worked", async () => {
    const { client } = makeUpstreamClient({
      evalOverride: () => textContent("No page selected"),
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "return 1",
    } as BrowseOptions);
    expect(r.outcome).not.toBe("worked");
    expect(r.error).toContain("eval_upstream_error");
  });

  it("④ 防误伤：脚本合法返回的字符串值恰含错误样式文案（围栏内）→ 仍 worked", async () => {
    // 默认 mock 按真实契约 eval+调用：返回值 "No page selected" 走 ```json 围栏
    const { client } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: 'return "No page selected"',
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("No page selected");
  });

  it("⑤ 回归：正常 evaluate（围栏返回值）→ worked 语义不变", async () => {
    const { client } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "return 1 + 1",
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("2");
  });
});

// ============================================================
// P10（v1.18.1，得到实战问题集 P10）：上游工具缺失前置门 + 诚实分类
// 锁定的 chrome-devtools-mcp@1.7.0 无 `pdf` 工具（-32602 "Tool pdf not found"，
// extract-batch1.mjs 实测 chain_failed:unknown）。修复：
//  ① browseSingle 导航**前**经 listTools 判缺失 → didnt +
//    retrieval_method=upstream_unsupported:<action>（不再 NAV_FIRST 白导航）；
//  ② classifyBrowseError 识别 tool-not-found / upstream_unsupported → didnt
//    （steps 链 pdf step 死后不再假 unknown 可重试）。
// ============================================================
describe("P10 — 上游工具缺失前置门（导航前诚实 didnt）", () => {
  it("① pdf 工具缺失（1.7.0 真实面）→ didnt + upstream_unsupported:pdf + 零导航", async () => {
    const { client, calls } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "pdf", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("upstream_unsupported:pdf");
    expect(r.error).toContain("upstream_unsupported:pdf");
    // 前置门在 NAV_FIRST 之前——白导航被消除
    expect(calls.find((c) => c.name === "navigate_page")).toBeUndefined();
    expect(calls.find((c) => c.name === "pdf")).toBeUndefined();
  });

  it("② pdf 工具在列（假想上游）→ 前置门放行 → 正常调用 pdf 工具", async () => {
    const { client, calls } = makeUpstreamClient({
      toolNames: [...UPSTREAM_170_TOOLS, "pdf"],
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "pdf", {} as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(calls.find((c) => c.name === "pdf")).toBeTruthy();
  });

  it("③ listTools 探测失败 → 放行（不猜；真实调用浮出真错误）", async () => {
    const { client } = makeUpstreamClient();
    (client.listTools as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("listTools down"),
    );
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "pdf", {} as BrowseOptions);
    // 放行后 pdf 工具 stubbed 返回 → 走到 handler（不为探测失败拦成 didnt）
    expect(r.outcome).toBe("worked");
  });

  it("④ per-client 缓存：同 client 第二次 action 不再 listTools", async () => {
    const { client } = makeUpstreamClient();
    const ch = new TestBrowseChannel(client);
    await ch.browse("https://example.com/", "pdf", {} as BrowseOptions);
    await ch.browse("https://example.com/", "pdf", {} as BrowseOptions);
    const lt = client.listTools as ReturnType<typeof vi.fn>;
    expect(lt).toHaveBeenCalledTimes(1);
  });

  it("⑤ classifyBrowseError：Tool not found / upstream_unsupported → didnt（steps 路径诚实）", async () => {
    // 直传形态（绕过前置门的兜底）：上游 -32602 isError 在 callTool 返回时
    const { client } = makeUpstreamClient({
      toolNames: [...UPSTREAM_170_TOOLS, "pdf"],
    });
    (client.callTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string) => {
        if (name === "pdf") {
          return textContent("MCP error -32602: Tool pdf not found", true);
        }
        return textContent("stubbed");
      },
    );
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "pdf", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt"); // 不再 unknown 假可重试
    expect(r.error).toContain("Tool pdf not found");
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
