/**
 * attributed-search 集成测（parse2 §5.2；v1.17 A3 修订：zhipu 直连档已删，
 * 动态源集合 = [machine_mcp?, brave?]，INV-80 墓碑守卫）。
 *
 * 端到端验证 v0.2 多源扇出 + attributed + cache：
 *  - engine="auto" + 两源可用 → 多源扇出（served_by="search.machine_mcp,search.brave"）
 *  - attributed=true → 每条结果带 served_by + original_rank
 *  - machine_mcp 单源（brave 未注入时 auto 退化）→ served_by="search.machine_mcp"
 *  - engine="brave" 单源 → 走 search.brave
 *  - cache 命中：第二次同 query → cached=true
 *  - engine="auto" + brave 不可用 → 退化为单源 machine_mcp
 *  - free_only=L1（无 machine_mcp）→ empty didnt 结果（诚实空）
 *  - free_only=L2 + machine_mcp 注入 → 降级 machine_mcp 单源（L1 ≤ 任何档，新语义）
 *  - engine="zhipu" → zod 拒绝（enum 已删该值；诚实破坏）
 *
 * 走真实 McpServer + Client + registerSearchTool + 真实 ProviderRegistry；
 * channels 用 stub 隔离网络。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { ProviderRegistry } from "../../src/config/provider-registry.js";
import { SearchCache } from "../../src/search/SearchCache.js";
import { registerSearchTool } from "../../src/tools/search.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";
import type { AttributedResult, InteractResult, SearchResult } from "../../src/types.js";
import type { MachineMcpSearchChannel } from "../../src/channels/MachineMcpSearchChannel.js";
import type { BraveChannel } from "../../src/channels/BraveChannel.js";
import type { BrowseExec } from "../../src/serp/extract.js";

// ============================================================
// 注入类型避循环依赖
// ============================================================
// 注：测试为隔离协议层，用对象字面量 + cast 模拟 channel。
// ============================================================
function makeStubMachineMcp(impl: {
  search: (
    q: string,
    opts: { limit: number; engine: string; region: string; no_cache: boolean },
  ) => Promise<InteractResult<SearchResult>>;
  available?: boolean;
}): MachineMcpSearchChannel {
  const ch = {
    name: "search.machine_mcp",
    search: vi.fn(impl.search),
    isAvailable: vi.fn(async () => impl.available ?? true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  };
  return ch as unknown as MachineMcpSearchChannel;
}

function makeStubBrave(impl: {
  search: (
    q: string,
    opts: { limit: number; region: string; no_cache: boolean },
  ) => Promise<InteractResult<SearchResult>>;
  available?: boolean;
}): BraveChannel {
  const ch = {
    name: "search.brave",
    search: vi.fn(impl.search),
    isAvailable: vi.fn(async () => impl.available ?? true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  };
  return ch as unknown as BraveChannel;
}

// ============================================================
// fixture：模拟 channel 返回的 worked 结果
// ============================================================
function machineMcpWorked(
  query: string,
  results: Array<{ title: string; url: string }>,
): InteractResult<SearchResult> {
  return {
    outcome: "worked",
    data: {
      query,
      results: results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: "",
      })),
      count: results.length,
      engine: "machine_mcp",
      region: "cn",
    },
    served_by: "search.machine_mcp",
    fallback_used: false,
    retrieval_method: "machine_mcp_api",
  };
}

function braveWorked(
  query: string,
  results: Array<{ title: string; url: string }>,
): InteractResult<SearchResult> {
  return {
    outcome: "worked",
    data: {
      query,
      results: results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: "",
      })),
      count: results.length,
      engine: "brave",
      region: "US",
    },
    served_by: "search.brave",
    fallback_used: false,
    retrieval_method: "brave_api",
  };
}

// ============================================================
// setup
// ============================================================
let tempCache: string;
let tempSearchCacheDir: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-attr-"));
  tempSearchCacheDir = path.join(tempCache, "search-cache");
  setStateStoreContext({ runId, cacheDir: tempCache });
});

afterEach(async () => {
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ============================================================
// startServer helper
// ============================================================
async function startServer(
  register: (server: McpServer) => void,
): Promise<{ client: Client; shutdown: () => Promise<void> }> {
  const server = new McpServer({ name: "lasso-test", version: "0.1.0-test" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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

function parseToolResult(text: string): InteractResult<SearchResult> {
  return JSON.parse(text) as InteractResult<SearchResult>;
}

// 构造带 brave keys 的 ProviderRegistry（v1.17 A3：zhipu provider 已删不进 registry）
function makeRegistry(): ProviderRegistry {
  const filled = BUILTIN_PROVIDERS.map((p) => ({ ...p }));
  const b = filled.find((p) => p.name === "brave");
  if (b) b.keys = ["brave-key-1", "brave-key-2"];
  return new ProviderRegistry(filled);
}

// noop browse exec (跨模态 fallback 路径不主测)
const noopBrowseExec: BrowseExec = async () => ({
  outcome: "unknown",
  data: null,
  error: "no_browse_in_test",
});

// ============================================================
// cases
// ============================================================
describe("engine='auto' + 多源扇出", () => {
  it("两源都可用 + 都 worked → outcome=worked + engine=multi", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) =>
        machineMcpWorked(q, [
          { title: "M1", url: "https://m1.test" },
          { title: "M2", url: "https://m2.test" },
        ]),
      ),
    });
    const brave = makeStubBrave({
      search: vi.fn(async (q) =>
        braveWorked(q, [{ title: "B1", url: "https://b1.test" }]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(
      new Map([
        ["fanout", new CircuitBreaker()],
        ["search.machine_mcp", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        brave,
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "rust async", limit: 10 },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.data!.engine).toBe("multi");
      expect(result.served_by).toBe("search.machine_mcp,search.brave");
      // A1 质量轴（v1.17 Phase B）：fanout 聚合串双 api 源 → quality="api"
      expect(result.quality).toBe("api");
      // 两源都调过
      expect(machineMcp.search).toHaveBeenCalled();
      expect(brave.search).toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });

  it("attributed=true → 每条结果带 served_by + original_rank", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) =>
        machineMcpWorked(q, [{ title: "M1", url: "https://m1.test" }]),
      ),
    });
    const brave = makeStubBrave({
      search: vi.fn(async (q) =>
        braveWorked(q, [{ title: "B1", url: "https://b1.test" }]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        brave,
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "rust", limit: 10, attributed: true },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      const attributed = result.data!.results as unknown as AttributedResult[];
      expect(attributed.length).toBeGreaterThan(0);
      // 每条都有 served_by（fanout 模式下是合并字符串）
      expect(attributed.every((a) => typeof a.served_by === "string")).toBe(true);
      // 每条都有 original_rank（>= 1）
      expect(
        attributed.every((a) => typeof a.original_rank === "number" && a.original_rank >= 1),
      ).toBe(true);
    } finally {
      await shutdown();
    }
  });

  it("brave 不可用 → 自动退化为单源 machine_mcp（动态源集合单源态）", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) =>
        machineMcpWorked(q, [{ title: "M1", url: "https://m1.test" }]),
      ),
    });
    const brave = makeStubBrave({
      available: false,
      search: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        brave,
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "rust", limit: 5 },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.served_by).toBe("search.machine_mcp");
      expect(result.data!.engine).toBe("machine_mcp");
      expect(brave.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });
});

describe("machine_mcp 单源（auto 动态源集合单源态；engine='zhipu' 值已删）", () => {
  it("仅 machine_mcp 注入（brave 未注入）→ 不扇出，单走 search.machine_mcp", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) =>
        machineMcpWorked(q, [{ title: "M1", url: "https://m1.test" }]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        undefined, // brave：未注入（单源退化态）
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "rust" },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.served_by).toBe("search.machine_mcp");
      expect(result.data!.engine).toBe("machine_mcp");
      // A1 质量轴：machine_mcp API 源 → quality="api"
      expect(result.quality).toBe("api");
    } finally {
      await shutdown();
    }
  });

  it("attributed=true + 单源 → 每条带 served_by='search.machine_mcp'", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) =>
        machineMcpWorked(q, [
          { title: "M1", url: "https://m1.test" },
          { title: "M2", url: "https://m2.test" },
        ]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        undefined,
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "rust", attributed: true },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      const attributed = result.data!.results as unknown as AttributedResult[];
      expect(attributed.every((a) => a.served_by === "search.machine_mcp")).toBe(true);
      expect(attributed[0].original_rank).toBe(1);
      expect(attributed[1].original_rank).toBe(2);
    } finally {
      await shutdown();
    }
  });

  it("v1.17 A3：engine='zhipu' → zod 校验拒绝（enum 已删该值；诚实破坏不静默路由）", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) => machineMcpWorked(q, [])),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        undefined,
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      // zod 校验失败 → MCP 协议层 isError + -32602 invalid params（不静默走任何引擎）
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "rust", engine: "zhipu" },
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(resp.isError).toBe(true);
      expect(resp.content[0]!.text).toContain("-32602");
      // 错误信息自动列出合法值（诚实破坏；CC 动态读 schema 可自纠）
      expect(resp.content[0]!.text).toContain("'auto' | 'brave' | 'fallback_chain'");
      expect(resp.content[0]!.text).toContain("received 'zhipu'");
      expect(machineMcp.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });
});

describe("engine='brave' 单源", () => {
  it("engine='brave' → 不扇出，单走 search.brave", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    });
    const brave = makeStubBrave({
      search: vi.fn(async (q) =>
        braveWorked(q, [{ title: "B1", url: "https://b1.test" }]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        brave,
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "rust", engine: "brave" },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.served_by).toBe("search.brave");
      expect(result.data!.engine).toBe("brave");
      expect(machineMcp.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });
});

describe("SearchCache 命中（同 query 第二次走 cache）", () => {
  it("第一次写入 cache + 第二次命中 cached=true", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) =>
        machineMcpWorked(q, [{ title: "M1", url: "https://m1.test" }]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        undefined,
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      // 第一次：未命中，走 machine_mcp，写 cache
      const resp1 = (await client.callTool({
        name: "search",
        arguments: { query: "cache-test" },
      })) as { content: Array<{ type: string; text: string }> };
      const r1 = parseToolResult(resp1.content[0]!.text);
      expect(r1.outcome).toBe("worked");
      expect(machineMcp.search).toHaveBeenCalledTimes(1);

      // 第二次：命中 cache，不再调 machine_mcp
      const resp2 = (await client.callTool({
        name: "search",
        arguments: { query: "cache-test" },
      })) as { content: Array<{ type: string; text: string }> };
      const r2 = JSON.parse(resp2.content[0]!.text) as InteractResult<SearchResult> & {
        cached?: boolean;
      };
      expect(r2.cached).toBe(true);
      expect(machineMcp.search).toHaveBeenCalledTimes(1); // 仍是 1 次
    } finally {
      await shutdown();
    }
  });

  it("no_cache=true → 跳过 cache 读写", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) =>
        machineMcpWorked(q, [{ title: "M1", url: "https://m1.test" }]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        undefined,
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      // 第一次：no_cache=true → 不写 cache
      await client.callTool({
        name: "search",
        arguments: { query: "no-cache", no_cache: true },
      });
      // 第二次：no_cache=false 但 cache 没写入 → 走 machine_mcp
      await client.callTool({
        name: "search",
        arguments: { query: "no-cache" },
      });
      // machine_mcp 应被调 2 次（第一次 no_cache 不写，第二次 cache 未命中）
      expect(machineMcp.search).toHaveBeenCalledTimes(2);
    } finally {
      await shutdown();
    }
  });
});

describe("free_only 过滤（v1.17 A3：machine_mcp L1 不过滤 + 降级新语义）", () => {
  it("free_only=L1 + 无 machine_mcp → empty didnt 结果（诚实空，不伪装）", async () => {
    const brave = makeStubBrave({
      search: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        brave,
        registry,
        cache,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "x", free_only: "L1" },
      })) as { content: Array<{ type: string; text: string }> };
      const r = parseToolResult(resp.content[0]!.text);
      expect(r.outcome).toBe("didnt");
      expect(r.data!.results).toEqual([]);
      expect(r.retrieval_method).toBe("free_only_filtered");
      expect(r.error).toContain("L1");
      expect(brave.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });

  it("v1.17 A3 新语义：free_only=L2（brave L4 被滤除）+ machine_mcp 注入 → 降级 machine_mcp 单源（L1 ≤ 任何档）", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) =>
        machineMcpWorked(q, [{ title: "M1", url: "https://m1.test" }]),
      ),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => {
        throw new Error("brave filtered out by free_only=L2; must not be called");
      }),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        noopBrowseExec,
        brave,
        registry,
        cache,
        undefined,
        undefined,
        machineMcp,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "x", free_only: "L2" },
      })) as { content: Array<{ type: string; text: string }> };
      const r = parseToolResult(resp.content[0]!.text);
      // 降级 machine_mcp 单源（不是 free_only_filtered 空结果——L1 ≤ L2）
      expect(r.outcome).toBe("worked");
      expect(r.served_by).toBe("search.machine_mcp");
      expect(r.retrieval_method).not.toBe("free_only_filtered");
      expect(brave.search).not.toHaveBeenCalled();
      expect(machineMcp.search).toHaveBeenCalledTimes(1);
    } finally {
      await shutdown();
    }
  });
});

// ============================================================
// v1.17 A3（parse24 §2.3-3）：auto 三态专项——双源 fanout / 单源 / 零 API 源兜底链
// ============================================================
describe("engine='auto' 动态源集合三态（v1.17 A3）", () => {
  it("零 API 源（machine_mcp 未注入 + brave 未配 key）→ 直达免费兜底 browse_headless", async () => {
    // brave 注入但 isAvailable=false（模拟未配 key）
    const brave = makeStubBrave({
      available: false,
      search: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());
    // browse_headless 兜底：SERP preview 带 URL
    const browseExec: BrowseExec = async () => ({
      outcome: "worked",
      data: {
        preview:
          "Example Results\nhttps://zero-api.test/article1\nhttps://zero-api.test/article2",
      },
      error: undefined,
    });

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        browseExec,
        brave,
        registry,
        cache,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "zero api query", no_cache: true },
      })) as { content: Array<{ type: string; text: string }> };
      const r = parseToolResult(resp.content[0]!.text);
      // KEY-GUIDE 既有承诺「一家不配也有搜索」：免费兜底链仍可服务
      expect(r.outcome).toBe("worked");
      expect(r.served_by).toBe("browse_headless");
      // A1 质量轴：免费兜底实搜 → quality="scrape"（诚实降档标注）
      expect(r.quality).toBe("scrape");
      expect(brave.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });

  it("单 brave 源（machine_mcp 未注入 + brave 可用）→ 单源 primary=search.brave", async () => {
    const brave = makeStubBrave({
      search: vi.fn(async (q) =>
        braveWorked(q, [{ title: "B1", url: "https://b1.test" }]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());
    const browseExec: BrowseExec = async () => ({
      outcome: "unknown",
      data: null,
      error: "no_browse_in_test",
    });

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        decider,
        browseExec,
        brave,
        registry,
        cache,
      );
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "single brave", no_cache: true },
      })) as { content: Array<{ type: string; text: string }> };
      const r = parseToolResult(resp.content[0]!.text);
      expect(r.outcome).toBe("worked");
      expect(r.served_by).toBe("search.brave");
      expect(r.data!.engine).toBe("brave");
      // A1 质量轴：brave API 源 → quality="api"
      expect(r.quality).toBe("api");
    } finally {
      await shutdown();
    }
  });
});
