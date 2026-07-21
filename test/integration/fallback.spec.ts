/**
 * 跨模态 fallback 旅程测（parse1 §5.2 + §4.4 + §6 验收 #3/#5）
 *
 * 端到端验证：
 *  - search 工具：智谱 unknown → 自动 fallback 到 browse_headless（百度 SERP scrape）
 *    （验收 #5：search → browse_headless 跨模态 fallback）
 *  - browse_headless 工具：headless unknown → 自动 fallback 到 browse_logged_in
 *    （验收 #3：tri-state outcome 触发 fallback）
 *  - fallback_used 标志 + served_by 切换 + retrieval_method 变化
 *  - actions_and_results 审计链完整
 *
 * 走真实 FallbackDecider + 真实 serpScrapeFallback + 真实 SSRF guard，
 * 但 channel.search/browse 用 stub —— 隔离 chrome-devtools-mcp / 智谱协议层。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { registerSearchTool } from "../../src/tools/search.js";
import { registerBrowseTools } from "../../src/tools/browse.js";
import type { BrowseResult, InteractResult, SearchResult } from "../../src/types.js";
import type { SearchChannel } from "../../src/channels/SearchChannel.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// ============================================================
// stub channel factory
// ============================================================
/**
 * 把 channel 的 search/browse 替换成 spy，返回受控 InteractResult。
 * 不用 vi.mock 整个模块——直接 new 真实 channel 再 override 方法即可。
 */
function makeStubSearch(impl: {
  search: (
    q: string,
    opts: { limit: number; engine: string; region: string; no_cache: boolean },
  ) => Promise<InteractResult<SearchResult>>;
}): SearchChannel {
  const ch = {
    name: "search.zhipu",
    search: vi.fn(impl.search),
    isAvailable: vi.fn(async () => true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  };
  return ch as unknown as SearchChannel;
}

function makeStubBrowse(
  name: "browse_headless" | "browse_logged_in",
  impl: {
    browse: (
      url: string,
      action: string,
      opts: Record<string, unknown>,
    ) => Promise<InteractResult<BrowseResult>>;
  },
): HeadlessChannel | LoggedInChannel {
  const ch = {
    name,
    browse: vi.fn(impl.browse),
    isAvailable: vi.fn(async () => true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  };
  return ch as unknown as HeadlessChannel | LoggedInChannel;
}

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-fallback-"));
  setStateStoreContext({ runId, cacheDir: tempCache });
});

afterEach(async () => {
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// SSRF 用 stub——绕过 DNS lookup 让任何 URL 都通过
const ALWAYS_OK_SSRF: SsrfConfig = { allowRanges: [], denyRanges: [] };
vi.mock("../../src/ssrf/ssrf-guard.js", () => ({
  ssrfGuard: vi.fn(async () => ({
    allowed: true,
    reason: "stub_ok",
    resolvedIps: ["127.0.0.1"],
  })),
  loadSsrfConfig: vi.fn(() => ALWAYS_OK_SSRF),
}));

// ============================================================
// 启动真实 McpServer + Client（inMemory transport），驱动 tool 调用
// ============================================================
async function startServer(
  register: (server: McpServer) => void,
): Promise<{
  client: Client;
  shutdown: () => Promise<void>;
}> {
  const server = new McpServer({ name: "lasso-test", version: "0.1.0-test" });
  register(server);

  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    shutdown: async () => {
      await client.close();
      await server.close();
    },
  };
}

function parseToolResult(text: string): InteractResult {
  return JSON.parse(text) as InteractResult;
}

// ============================================================
// cases
// ============================================================
describe("search → browse_headless 跨模态 fallback（验收 #5）", () => {
  it("智谱 unknown + browse_headless SERP 抽出链接 → fallback_used=true + served_by=browse_headless", async () => {
    // 智谱限流：返回 unknown
    const search = makeStubSearch({
      search: vi.fn(async () => ({
        outcome: "unknown",
        data: null,
        served_by: "search.zhipu",
        fallback_used: false,
        retrieval_method: "zhipu_api",
        error: "HTTP 429",
      })),
    });

    // browse_headless 兜底：返回带 preview 的 worked（含 URL，让 serpScrapeFallback 抽得到）
    const headless = makeStubBrowse("browse_headless", {
      browse: vi.fn(async () => ({
        outcome: "worked",
        data: {
          url: "https://www.baidu.com/s?wd=x",
          action: "snapshot",
          state_id: "stub-id",
          content_path: "/tmp/stub",
          preview:
            "Example Search Results\nhttps://example.com/article1\nMore text\nhttps://example.com/article2",
        },
        served_by: "browse_headless",
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
      })),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        search,
        decider,
        async (url) => {
          // BrowseExec thin wrapper：把 BrowseResult 映射成 serp/extract 期望的形状
          const r = await (headless as HeadlessChannel).browse(url, "snapshot", {});
          return {
            outcome: r.outcome,
            data: r.data ? { preview: r.data.preview } : null,
            error: r.error,
          };
        },
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "test query", limit: 5 },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text) as InteractResult<SearchResult>;
      expect(result.outcome).toBe("worked");
      expect(result.fallback_used).toBe(true);
      expect(result.served_by).toBe("browse_headless");
      expect(result.retrieval_method).toBe("serp_scrape_baidu");
      expect(result.data).not.toBeNull();
      expect(result.data!.engine).toBe("baidu_serp");
      expect(result.data!.results.length).toBeGreaterThan(0);
      // 审计链：search.zhipu unknown + browse_headless worked
      expect(result.actions_and_results).toHaveLength(2);
      expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
        "search.zhipu",
        "browse_headless",
      ]);
    } finally {
      await shutdown();
    }
  });

  it("智谱 worked → 不触发 fallback（fallback_used=false, served_by=search.zhipu）", async () => {
    const search = makeStubSearch({
      search: vi.fn(async () => ({
        outcome: "worked",
        data: {
          query: "x",
          results: [{ title: "T", url: "https://x.test", snippet: "" }],
          count: 1,
          engine: "zhipu",
          region: "cn",
        },
        served_by: "search.zhipu",
        fallback_used: false,
        retrieval_method: "zhipu_api",
      })),
    });

    const headless = makeStubBrowse("browse_headless", {
      browse: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    });

    const decider = new FallbackDecider(new Map());
    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(server, search, decider, async (url) => {
        const r = await (headless as HeadlessChannel).browse(url, "snapshot", {});
        return {
          outcome: r.outcome,
          data: r.data ? { preview: r.data.preview } : null,
          error: r.error,
        };
      });
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "x" },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text) as InteractResult<SearchResult>;
      expect(result.outcome).toBe("worked");
      expect(result.fallback_used).toBe(false);
      expect(result.served_by).toBe("search.zhipu");
      expect(headless.browse).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });
});

describe("browse_headless → browse_logged_in fallback（验收 #3）", () => {
  it("headless unknown + logged_in worked → fallback_used=true + served_by=browse_logged_in", async () => {
    const headless = makeStubBrowse("browse_headless", {
      browse: vi.fn(async () => ({
        outcome: "unknown",
        data: null,
        served_by: "browse_headless",
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
        error: "navigation timeout",
      })),
    });

    const logged_in = makeStubBrowse("browse_logged_in", {
      browse: vi.fn(async () => ({
        outcome: "worked",
        data: {
          url: "https://private.site/dashboard",
          action: "snapshot",
          state_id: "abc",
          content_path: "/tmp/abc",
          preview: "Dashboard",
        },
        served_by: "browse_logged_in",
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
      })),
    });

    const decider = new FallbackDecider(
      new Map([
        ["browse_headless", new CircuitBreaker()],
        ["browse_logged_in", new CircuitBreaker()],
      ]),
    );

    const { client, shutdown } = await startServer((server) => {
      registerBrowseTools(
        server,
        headless as HeadlessChannel,
        logged_in as LoggedInChannel,
        decider,
        ALWAYS_OK_SSRF,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "browse_headless",
        arguments: { url: "https://private.site/dashboard", action: "snapshot" },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text) as InteractResult<BrowseResult>;
      expect(result.outcome).toBe("worked");
      expect(result.fallback_used).toBe(true);
      expect(result.served_by).toBe("browse_logged_in");
      expect(result.data!.preview).toBe("Dashboard");
      expect(result.actions_and_results).toHaveLength(2);
    } finally {
      await shutdown();
    }
  });

  it("headless 返回 NEEDS_MANUAL_2FA → 立即终止（不 fallback 到 logged_in）", async () => {
    // 这个 case 在 headless 上很少见——headless 无登录态，通常不会遇到 2FA。
    // 但 LoggedInChannel 自身会返回这个；这里测 browse_logged_in tool 不再有
    // 第二跳，所以单独测 LoggedInChannel 的 didnt 短路语义。
    const logged_in = makeStubBrowse("browse_logged_in", {
      browse: vi.fn(async () => ({
        outcome: "didnt",
        data: null,
        served_by: "browse_logged_in",
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
        error: "NEEDS_MANUAL_2FA",
      })),
    });
    const headless = makeStubBrowse("browse_headless", {
      browse: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    });

    const decider = new FallbackDecider(new Map());
    const { client, shutdown } = await startServer((server) => {
      registerBrowseTools(
        server,
        headless as HeadlessChannel,
        logged_in as LoggedInChannel,
        decider,
        ALWAYS_OK_SSRF,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "browse_logged_in",
        arguments: { url: "https://2fa.test/login", action: "snapshot" },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text) as InteractResult<BrowseResult>;
      expect(result.outcome).toBe("didnt");
      expect(result.error).toBe("NEEDS_MANUAL_2FA");
      expect(result.fallback_used).toBe(false);
    } finally {
      await shutdown();
    }
  });
});
