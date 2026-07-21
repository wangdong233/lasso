/**
 * SearchChannel 集成测（parse1 §5.2）
 *
 * 用 vi.mock 把 McpClient.connectHttp 替换成 stub client，验证：
 *  - worked 路径：智谱返回非空 search_results → outcome=worked
 *  - unknown 路径（10 §D.1 关键）：智谱返回空 content/空数组 → outcome=unknown
 *    （这是触发跨模态 fallback 到 browse_headless 的关键信号）
 *  - didnt 路径：404 错误 → outcome=didnt
 *  - 网络错误（timeout）→ outcome=unknown
 *  - ZHIPU_API_KEY 缺失 → outcome=unknown + error
 *
 * 不测真实网络——只验 Lasso 的解析/判定逻辑。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";

// ============================================================
// stub McpClient
// ============================================================
const stubCall = vi.fn();
const stubList = vi.fn();

vi.mock("../../src/subprocess/McpClient.js", () => ({
  McpClient: {
    connectHttp: vi.fn(async () => ({
      callTool: stubCall,
      listTools: stubList,
      close: vi.fn(async () => {}),
      pid: null,
      stderr: null,
      isConnected: true,
    })),
  },
}));

// SUT 必须在 vi.mock 之后 import
import { SearchChannel } from "../../src/channels/SearchChannel.js";

// ============================================================
// fixture
// ============================================================
function zhipuResponse(results: Array<Record<string, unknown>>) {
  return {
    content: [
      { type: "text", text: JSON.stringify({ search_results: results }) },
    ],
  };
}

const NONEMPTY = zhipuResponse([
  {
    title: "Rust async tokio",
    link: "https://tokio.rs/",
    content: "Tokio is an async runtime for Rust",
    media: "tokio.rs",
  },
  {
    title: "Async Rust Guide",
    link: "https://async.rs/",
    content: "async/await in Rust",
  },
]);

const EMPTY_RESULTS = zhipuResponse([]);

const EMPTY_CONTENT = { content: [] };

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-test-"));
  setStateStoreContext({ runId, cacheDir: tempCache });

  stubCall.mockReset();
  stubList.mockReset();
  stubList.mockResolvedValue([{ name: "web_search_prime", inputSchema: {} }]);
});

// ============================================================
// cases
// ============================================================
describe("SearchChannel.search — 解析 + outcome 判定", () => {
  it("非空 search_results → outcome=worked", async () => {
    stubCall.mockResolvedValue(NONEMPTY);
    const ch = new SearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "fake-key",
    );
    const r = await ch.search("rust tokio", {
      limit: 10,
      engine: "zhipu",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("worked");
    expect(r.data).not.toBeNull();
    expect(r.data!.results).toHaveLength(2);
    expect(r.data!.results[0].url).toBe("https://tokio.rs/");
    expect(r.data!.results[0].source).toBe("tokio.rs");
    expect(r.data!.engine).toBe("zhipu");
    expect(r.served_by).toBe("search.zhipu");
    expect(r.fallback_used).toBe(false);
    expect(r.retrieval_method).toBe("zhipu_api");
  });

  it("空 search_results → outcome=unknown（触发 fallback 关键信号，10 §D.1）", async () => {
    stubCall.mockResolvedValue(EMPTY_RESULTS);
    const ch = new SearchChannel("https://x.test/mcp", "fake-key");
    const r = await ch.search("nothing-here", {
      limit: 10,
      engine: "zhipu",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.data).not.toBeNull();
    expect(r.data!.count).toBe(0);
    expect(r.error).toBeUndefined();
  });

  it("空 content 数组（异常响应）→ outcome=unknown", async () => {
    stubCall.mockResolvedValue(EMPTY_CONTENT);
    const ch = new SearchChannel("https://x.test/mcp", "fake-key");
    const r = await ch.search("broken-response", {
      limit: 5,
      engine: "zhipu",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
  });

  it("JSON 解析失败 → outcome=unknown（不抛异常）", async () => {
    stubCall.mockResolvedValue({
      content: [{ type: "text", text: "not-json-{{{" }],
    });
    const ch = new SearchChannel("https://x.test/mcp", "fake-key");
    const r = await ch.search("garbage", {
      limit: 5,
      engine: "zhipu",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.data!.count).toBe(0);
  });

  it("callTool 抛 404 → outcome=didnt（明确否，不 fallback）", async () => {
    stubCall.mockRejectedValue(new Error("HTTP 404 Not Found"));
    const ch = new SearchChannel("https://x.test/mcp", "fake-key");
    const r = await ch.search("404-test", {
      limit: 5,
      engine: "zhipu",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("didnt");
  });

  it("callTool 抛 timeout → outcome=unknown（fallback-worthy）", async () => {
    stubCall.mockRejectedValue(new Error("request timeout"));
    const ch = new SearchChannel("https://x.test/mcp", "fake-key");
    const r = await ch.search("timeout-test", {
      limit: 5,
      engine: "zhipu",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("timeout");
  });

  it("callTool 抛 429 → outcome=unknown（transient）", async () => {
    stubCall.mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
    const ch = new SearchChannel("https://x.test/mcp", "fake-key");
    const r = await ch.search("rate-limited", {
      limit: 5,
      engine: "zhipu",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
  });
});

describe("SearchChannel.isAvailable / status", () => {
  it("key 缺失 → isAvailable=false", async () => {
    const ch = new SearchChannel("https://x.test/mcp", undefined);
    expect(await ch.isAvailable()).toBe(false);
  });

  it("endpoint 非 https → isAvailable=false", async () => {
    const ch = new SearchChannel("http://insecure.test/mcp", "key");
    expect(await ch.isAvailable()).toBe(false);
  });

  it("key 缺失时 search() 直接返 unknown + error", async () => {
    const ch = new SearchChannel("https://x.test/mcp", undefined);
    const r = await ch.search("x", {
      limit: 5,
      engine: "zhipu",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("ZHIPU_API_KEY");
    expect(stubCall).not.toHaveBeenCalled();
  });

  it("status() healthy：listTools 通 → available=true + latency_ms", async () => {
    stubList.mockResolvedValue([{ name: "web_search_prime", inputSchema: {} }]);
    const ch = new SearchChannel("https://x.test/mcp", "key");
    const s = await ch.status();
    expect(s.available).toBe(true);
    expect(s.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// teardown：清理 tempdir
// ============================================================
import { afterEach } from "vitest";
afterEach(async () => {
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
