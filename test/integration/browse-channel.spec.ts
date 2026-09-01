/**
 * BrowseChannel 集成测（parse1 §5.2）
 *
 * Mock SubprocessManager.ensureRunning 返回 stub client，验证：
 *  - snapshot/navigate/screenshot 等 action 正确分发到 chrome-devtools-mcp 工具名
 *  - 工作路径：outcome=worked + state_id 非空 + content_path 文件实际存在
 *  - preview ≤1k tokens 软上限（PREVIEW_MAX_CHARS = 4000 chars，粗算 4 chars/token）
 *  - 未知 action → outcome=didnt（不发请求）
 *  - chrome-devtools-mcp 抛错 → classifyBrowseError 映射到正确 outcome
 *
 * 不 spawn 真实 chrome-devtools-mcp——只测 Lasso 的 dispatch + 写盘 + 信号映射。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import { mockEvalResponse, mockScreenshotResponse } from "../helpers/upstream-mock.js";

// ============================================================
// fixture helpers
// ============================================================
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

function makeStubClient(): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const stub: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "navigate_page") {
        return textContent("navigated to https://example.com/");
      }
      if (name === "take_snapshot") {
        return textContent(
          "Example Domain\n\nThis domain is for use in illustrative examples in documents.",
        );
      }
      if (name === "take_screenshot") {
        // W1-DEF-1b 真实契约：base64 在 image block，见 helpers/upstream-mock
        return mockScreenshotResponse();
      }
      if (name === "click") return textContent("clicked");
      if (name === "fill_form") return textContent("filled");
      if (name === "wait_for") return textContent("text appeared");
      // W1-DEF-1b 真实契约：```json 围栏包裹
      if (name === "evaluate_script") return mockEvalResponse(42);
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () => [
      { name: "navigate_page", inputSchema: {} },
      { name: "take_snapshot", inputSchema: {} },
      { name: "take_screenshot", inputSchema: {} },
      { name: "click", inputSchema: {} },
      { name: "fill_form", inputSchema: {} },
      { name: "wait_for", inputSchema: {} },
      { name: "evaluate_script", inputSchema: {} },
    ]),
    close: vi.fn(async () => {}),
    pid: 12345,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client: stub, calls };
}

// ============================================================
// setup
// ============================================================
let tempCache: string;
let stubInfo: ReturnType<typeof makeStubClient>;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-browse-"));
  setStateStoreContext({ runId, cacheDir: tempCache });
  stubInfo = makeStubClient();
});

afterEach(async () => {
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// helper: 构造一个 HeadlessChannel 但用 stub client 替换 subproc.ensureRunning
function makeHeadlessWithStub(): {
  channel: HeadlessChannel;
  getCalls: () => Array<{ name: string; args: Record<string, unknown> }>;
  setClient: (c: McpClient) => void;
} {
  // SubprocessManager 是真实实例，但 ensureRunning mock 掉
  // 不需要 registerSpec（mock 后 spec 不被读）
  const fakeSubproc: Pick<
    import("../../src/subprocess/SubprocessManager.js").SubprocessManager,
    "registerSpec" | "ensureRunning" | "shutdown" | "healthProbe" | "touch"
  > = {
    registerSpec: vi.fn(),
    touch: vi.fn(),
    ensureRunning: vi.fn(async () => stubInfo.client),
    shutdown: vi.fn(async () => {}),
    healthProbe: vi.fn(async () => "healthy"),
  };
  const channel = new HeadlessChannel(
    fakeSubproc as unknown as import("../../src/subprocess/SubprocessManager.js").SubprocessManager,
  );
  return {
    channel,
    getCalls: () => stubInfo.calls ?? [],
    setClient: (c: McpClient) => {
      stubInfo.client = c;
    },
  };
}

// ============================================================
// cases
// ============================================================
describe("HeadlessChannel.browse — action 分发", () => {
  it("snapshot action → take_snapshot 工具被调 + outcome=worked + 写盘", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    const r = await channel.browse(
      "https://example.com/",
      "snapshot",
      {},
    );
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("browse_headless");
    expect(r.data).not.toBeNull();
    expect(r.data!.state_id).toBeTruthy();
    expect(r.data!.content_path).toBeTruthy();
    expect(r.data!.preview).toContain("Example Domain");

    // 写盘文件真实存在
    const stat = await fs.stat(r.data!.content_path!);
    expect(stat.isFile()).toBe(true);

    // dispatch Map 命中 take_snapshot
    const calls = getCalls();
    expect(calls.some((c) => c.name === "take_snapshot")).toBe(true);
  });

  it("navigate action → navigate_page + final_url 回传", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    const r = await channel.browse(
      "https://example.com/",
      "navigate",
      {},
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.final_url).toContain("https://example.com/");
    expect(getCalls().some((c) => c.name === "navigate_page")).toBe(true);
  });

  // ============================================================
  // review-r3 F3：空白会话门控导航（blank-gated nav-first for snapshot/extract）
  // ============================================================
  it("review-r3 F3：空白会话单发 snapshot → 先 navigate_page 再 take_snapshot（兑现 url 定向契约）", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    const r = await channel.browse(
      "https://example.com/",
      "snapshot",
      {},
    );
    expect(r.outcome).toBe("worked");
    const calls = getCalls();
    const navIdx = calls.findIndex((c) => c.name === "navigate_page");
    const snapIdx = calls.findIndex((c) => c.name === "take_snapshot");
    // 空白会话（本 client 从未导航，L3 实证恒 about:blank）必须先导航再采集
    expect(navIdx).toBeGreaterThanOrEqual(0);
    expect(snapIdx).toBeGreaterThan(navIdx);
  });

  it("review-r3 F3：已导航会话的 snapshot 不回灌导航（保持「作用于当前页」语义）", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    await channel.browse("https://example.com/", "navigate", {});
    const navCount = getCalls().filter((c) => c.name === "navigate_page").length;
    const r = await channel.browse("https://example.com/", "snapshot", {});
    expect(r.outcome).toBe("worked");
    // navigate 之后的 snapshot 不再触发 navigate_page——navigate → click →
    // extract/snapshot 的点击后观察态不被回灌导航破坏（interact forest 同享）
    expect(
      getCalls().filter((c) => c.name === "navigate_page").length,
    ).toBe(navCount);
  });

  it("review-r3 F3：空白会话单发 extract（raw）→ 先导航再 take_snapshot", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    const r = await channel.browse(
      "https://example.com/",
      "extract",
      {},
    );
    expect(r.outcome).toBe("worked");
    const calls = getCalls();
    const navIdx = calls.findIndex((c) => c.name === "navigate_page");
    expect(navIdx).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((c) => c.name === "take_snapshot")).toBeGreaterThan(navIdx);
  });

  it("review-r3 F3：snapshot final_url 取 a11y 树 RootWebArea 真实页面 URL（不回显未被消费的请求 url）", async () => {
    const custom = {
      callTool: vi.fn(async (name: string) => {
        if (name === "take_snapshot") {
          // 页面真实位置 ≠ 请求 url（如 SPA 跳转后 / 点击后态）。
          // L3 真机格式（review-r3 实抓）：RootWebArea 与 url= 之间带 title。
          return textContent(
            '## Latest page snapshot\nuid=1_0 RootWebArea "SPA" url="https://actual.example.com/spa"\n  uid=1_1 heading "After click"',
          );
        }
        return textContent("stubbed");
      }),
      listTools: vi.fn(async () => [
        { name: "navigate_page", inputSchema: {} },
        { name: "take_snapshot", inputSchema: {} },
      ]),
      close: vi.fn(async () => {}),
      pid: 1,
      stderr: null,
      isConnected: true,
    } as unknown as McpClient;
    const { channel, setClient } = makeHeadlessWithStub();
    setClient(custom);
    const r = await channel.browse(
      "https://requested.example.com/",
      "snapshot",
      {},
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.final_url).toBe("https://actual.example.com/spa");
  });

  it("screenshot action → take_screenshot 被调", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    const r = await channel.browse(
      "https://example.com/",
      "screenshot",
      { screenshot: { full: true } },
    );
    expect(r.outcome).toBe("worked");
    const ss = getCalls().find((c) => c.name === "take_screenshot");
    expect(ss).toBeTruthy();
    expect(ss!.args).toMatchObject({ format: "png", fullPage: true });
  });

  it("click action 缺 selectors → outcome=unknown（handler 抛错走 classifyBrowseError）", async () => {
    const { channel } = makeHeadlessWithStub();
    const r = await channel.browse(
      "https://example.com/",
      "click",
      {} as never,
    );
    // doClick 缺 selectors.click 抛 Error，被 classifyBrowseError → unknown
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("selectors.click");
  });

  it("未知 action → outcome=didnt（直接返回，不触网）", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    const r = await channel.browse(
      "https://example.com/",
      "totally_made_up",
      {},
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("unknown_action");
    expect(getCalls()).toHaveLength(0);
  });
});

describe("HeadlessChannel.browse — preview token 经济学", () => {
  it("超长 snapshot 被 truncate 到 ≤4000 chars + 省略号标记", async () => {
    const longText = "x".repeat(10_000);
    const { channel, setClient } = makeHeadlessWithStub();
    setClient({
      ...stubInfo.client,
      callTool: vi.fn(async () => textContent(longText)),
    } as unknown as McpClient);

    const r = await channel.browse(
      "https://example.com/",
      "snapshot",
      {},
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview.length).toBeLessThanOrEqual(4000 + 30); // 截断 + 后缀
    expect(r.data!.preview).toContain("[truncated by lasso]");
  });
});

describe("HeadlessChannel.browse — 错误 → outcome 映射", () => {
  it("callTool 抛 NEEDS_MANUAL_2FA → outcome=didnt（明确否，不 fallback）", async () => {
    const { channel, setClient } = makeHeadlessWithStub();
    setClient({
      ...stubInfo.client,
      callTool: vi.fn(async () => {
        throw new Error("NEEDS_MANUAL_2FA");
      }),
    } as unknown as McpClient);

    const r = await channel.browse(
      "https://example.com/",
      "snapshot",
      {},
    );
    expect(r.outcome).toBe("didnt");
  });

  it("callTool 抛 timeout → outcome=unknown（fallback-worthy）", async () => {
    const { channel, setClient } = makeHeadlessWithStub();
    setClient({
      ...stubInfo.client,
      callTool: vi.fn(async () => {
        throw new Error("navigation timeout");
      }),
    } as unknown as McpClient);

    const r = await channel.browse(
      "https://example.com/",
      "snapshot",
      {},
    );
    expect(r.outcome).toBe("unknown");
  });
});

describe("HeadlessChannel.browse — 写盘短指针", () => {
  it("state_id 是 UUID 形状；content_path 指向真实 JSON 文件", async () => {
    const { channel } = makeHeadlessWithStub();
    const r = await channel.browse(
      "https://example.com/",
      "snapshot",
      {},
    );
    expect(r.data!.state_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const content = (await fs.readFile(
      r.data!.content_path!,
      "utf8",
    )).toString();
    const parsed = JSON.parse(content);
    expect(parsed.channel).toBe("browse_headless");
    expect(parsed.state_id).toBe(r.data!.state_id);
    expect(parsed.url).toBe("https://example.com/");
  });
});

// ============================================================
// PERF-4（2026-09-02 perf/acc 轮 2）：evaluate 超限 object/array 截断快路
// ============================================================
// 白盒证据：旧路径对大返回值付 O(n) 全量 JSON.parse + O(n) 全量 JSON.stringify
// 后只取前 4000 字符（真机基准 8MiB 围栏 58.5ms → 快路 2.2ms ≈ 26×）。快路前提
// = 上游围栏文本恰为页内 JSON.stringify(返回值)（performEvaluation 实读 +
// upstream-response.ts 实测契约）→ 对 {/[ 起头的超限围栏直接切片，与
// JSON.stringify(JSON.parse(fence)).slice(0,4000) 逐字节一致。
describe("HeadlessChannel.browse — evaluate 超限截断快路（PERF-4）", () => {
  function mkBigObjectRows(sizeChars: number): { rows: unknown[]; count: number } {
    const rows: unknown[] = [];
    let total = 0;
    for (let n = 0; total < sizeChars; n++) {
      const row = { i: n, cls: `row-${n}`, text: "x".repeat(96), href: `https://example.com/item/${n}` };
      rows.push(row);
      total += JSON.stringify(row).length;
    }
    return { rows, count: rows.length };
  }

  it("E1 超限大对象 → preview 与旧路径（stringify(v).slice）逐字节一致", async () => {
    const value = mkBigObjectRows(64 * 1024); // fence ≈ 64KiB ≫ 4000
    const { channel, setClient } = makeHeadlessWithStub();
    setClient({
      ...stubInfo.client,
      callTool: vi.fn(async () => mockEvalResponse(value)),
    } as unknown as McpClient);
    const r = await channel.browse("https://example.com/", "evaluate", {
      js: "return 1",
    });
    expect(r.outcome).toBe("worked");
    // 旧路径期望值（语义基线）：JSON.stringify(v).slice(0, PREVIEW_MAX_CHARS)
    const expected = JSON.stringify(value).slice(0, 4000);
    expect(r.data!.preview).toBe(expected);
    expect(r.data!.preview.length).toBe(4000);
  });

  it("E2 超限大数组（[ 起头）→ 同样走快路且逐字节一致", async () => {
    const arr = Array.from({ length: 300 }, (_, i) => ({ id: i, pad: "z".repeat(64) }));
    const { channel, setClient } = makeHeadlessWithStub();
    setClient({
      ...stubInfo.client,
      callTool: vi.fn(async () => mockEvalResponse(arr)),
    } as unknown as McpClient);
    const r = await channel.browse("https://example.com/", "evaluate", {
      js: "return 1",
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe(JSON.stringify(arr).slice(0, 4000));
  });

  it("E3 超限字符串返回值 → 行为不变（完整字符串 → truncatePreview 标记）", async () => {
    const bigString = "y".repeat(10_000);
    const { channel, setClient } = makeHeadlessWithStub();
    setClient({
      ...stubInfo.client,
      callTool: vi.fn(async () => mockEvalResponse(bigString)),
    } as unknown as McpClient);
    const r = await channel.browse("https://example.com/", "evaluate", {
      js: "return 1",
    });
    expect(r.outcome).toBe("worked");
    // 字符串值不走快路（双层解码语义需完整 parse）：v = 原串 → truncatePreview
    expect(r.data!.preview.startsWith("yyyy")).toBe(true);
    expect(r.data!.preview).toContain("[truncated by lasso]");
  });

  it("E4 小对象 → 既有路径不变（全量 JSON，无截断标记）", async () => {
    const { channel } = makeHeadlessWithStub();
    // 默认 stub evaluate_script 返回 mockEvalResponse(42)（数字，短于上限）
    const r = await channel.browse("https://example.com/", "evaluate", {
      js: "return 42",
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("42");
  });

  it("E5 上限内对象（fence ≤ 4000）→ 不进快路，preview 为完整 JSON", async () => {
    const small = mkBigObjectRows(2_000); // fence ≈ 2KiB < 4000
    const { channel, setClient } = makeHeadlessWithStub();
    setClient({
      ...stubInfo.client,
      callTool: vi.fn(async () => mockEvalResponse(small)),
    } as unknown as McpClient);
    const r = await channel.browse("https://example.com/", "evaluate", {
      js: "return 1",
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe(JSON.stringify(small));
  });
});
