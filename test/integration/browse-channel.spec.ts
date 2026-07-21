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
        return textContent("screenshot saved");
      }
      if (name === "click") return textContent("clicked");
      if (name === "fill_form") return textContent("filled");
      if (name === "wait_for") return textContent("text appeared");
      if (name === "evaluate_script") return textContent("42");
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
    "registerSpec" | "ensureRunning" | "shutdown" | "healthProbe"
  > = {
    registerSpec: vi.fn(),
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
