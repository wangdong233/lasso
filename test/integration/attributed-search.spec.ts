/**
 * attributed-search 集成测（parse2 §5.2）。
 *
 * 端到端验证 v0.2 多源扇出 + attributed + cache：
 *  - engine="auto" + 两源可用 → 多源扇出（served_by="search.zhipu,search.brave"）
 *  - attributed=true → 每条结果带 served_by + original_rank
 *  - engine="zhipu" 单源 → v0.1 行为（served_by="search.zhipu"）
 *  - engine="brave" 单源 → 走 search.brave
 *  - cache 命中：第二次同 query → cached=true
 *  - engine="auto" + brave 不可用 → 退化为单源 zhipu
 *  - free_only=L1 → empty didnt 结果（无 search provider 满足）
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
import type { SearchChannel } from "../../src/channels/SearchChannel.js";
import type { BraveChannel } from "../../src/channels/BraveChannel.js";
import type { BrowseExec } from "../../src/serp/extract.js";

// ============================================================
// 注入类型避循环依赖
// ============================================================
// 注：测试为隔离协议层，用对象字面量 + cast 模拟 channel。
// ============================================================
function makeStubSearch(impl: {
  search: (
    q: string,
    opts: { limit: number; engine: string; region: string; no_cache: boolean },
  ) => Promise<InteractResult<SearchResult>>;
  available?: boolean;
}): SearchChannel {
  const ch = {
    name: "search.zhipu",
    search: vi.fn(impl.search),
    isAvailable: vi.fn(async () => impl.available ?? true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  };
  return ch as unknown as SearchChannel;
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
function zhipuWorked(
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
      engine: "zhipu",
      region: "cn",
    },
    served_by: "search.zhipu",
    fallback_used: false,
    retrieval_method: "zhipu_api",
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

// 构造带 zhipu + brave keys 的 ProviderRegistry
function makeRegistry(): ProviderRegistry {
  const filled = BUILTIN_PROVIDERS.map((p) => ({ ...p }));
  const z = filled.find((p) => p.name === "zhipu");
  if (z) z.keys = ["zhipu-test-key"];
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
    const search = makeStubSearch({
      search: vi.fn(async (q) =>
        zhipuWorked(q, [
          { title: "Z1", url: "https://z1.test" },
          { title: "Z2", url: "https://z2.test" },
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
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        search,
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
        arguments: { query: "rust async", limit: 10 },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.data!.engine).toBe("multi");
      expect(result.served_by).toBe("search.zhipu,search.brave");
      // 两源都调过
      expect(search.search).toHaveBeenCalled();
      expect(brave.search).toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });

  it("attributed=true → 每条结果带 served_by + original_rank", async () => {
    const search = makeStubSearch({
      search: vi.fn(async (q) =>
        zhipuWorked(q, [{ title: "Z1", url: "https://z1.test" }]),
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
        search,
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

  it("brave 不可用 → 自动退化为单源 zhipu（v0.1 兼容）", async () => {
    const search = makeStubSearch({
      search: vi.fn(async (q) =>
        zhipuWorked(q, [{ title: "Z1", url: "https://z1.test" }]),
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
        search,
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
        arguments: { query: "rust", limit: 5 },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.served_by).toBe("search.zhipu");
      expect(result.data!.engine).toBe("zhipu");
      expect(brave.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });
});

describe("engine='zhipu' 单源（v0.1 行为保留）", () => {
  it("engine='zhipu' → 不扇出，单走 search.zhipu", async () => {
    const search = makeStubSearch({
      search: vi.fn(async (q) =>
        zhipuWorked(q, [{ title: "Z1", url: "https://z1.test" }]),
      ),
    });
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
        search,
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
        arguments: { query: "rust", engine: "zhipu" },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.served_by).toBe("search.zhipu");
      expect(result.data!.engine).toBe("zhipu");
      expect(brave.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });

  it("attributed=true + 单源 → 每条带 served_by='search.zhipu'", async () => {
    const search = makeStubSearch({
      search: vi.fn(async (q) =>
        zhipuWorked(q, [
          { title: "Z1", url: "https://z1.test" },
          { title: "Z2", url: "https://z2.test" },
        ]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(server, search, decider, noopBrowseExec, undefined, registry, cache);
    });

    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "rust", engine: "zhipu", attributed: true },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      const attributed = result.data!.results as unknown as AttributedResult[];
      expect(attributed.every((a) => a.served_by === "search.zhipu")).toBe(true);
      expect(attributed[0].original_rank).toBe(1);
      expect(attributed[1].original_rank).toBe(2);
    } finally {
      await shutdown();
    }
  });
});

describe("engine='brave' 单源", () => {
  it("engine='brave' → 不扇出，单走 search.brave", async () => {
    const search = makeStubSearch({
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
        search,
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
        arguments: { query: "rust", engine: "brave" },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.served_by).toBe("search.brave");
      expect(result.data!.engine).toBe("brave");
      expect(search.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });
});

describe("SearchCache 命中（同 query 第二次走 cache）", () => {
  it("第一次写入 cache + 第二次命中 cached=true", async () => {
    const search = makeStubSearch({
      search: vi.fn(async (q) =>
        zhipuWorked(q, [{ title: "Z1", url: "https://z1.test" }]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(server, search, decider, noopBrowseExec, undefined, registry, cache);
    });

    try {
      // 第一次：未命中，走 zhipu，写 cache
      const resp1 = (await client.callTool({
        name: "search",
        arguments: { query: "cache-test", engine: "zhipu" },
      })) as { content: Array<{ type: string; text: string }> };
      const r1 = parseToolResult(resp1.content[0]!.text);
      expect(r1.outcome).toBe("worked");
      expect(search.search).toHaveBeenCalledTimes(1);

      // 第二次：命中 cache，不再调 zhipu
      const resp2 = (await client.callTool({
        name: "search",
        arguments: { query: "cache-test", engine: "zhipu" },
      })) as { content: Array<{ type: string; text: string }> };
      const r2 = JSON.parse(resp2.content[0]!.text) as InteractResult<SearchResult> & {
        cached?: boolean;
      };
      expect(r2.cached).toBe(true);
      expect(search.search).toHaveBeenCalledTimes(1); // 仍是 1 次
    } finally {
      await shutdown();
    }
  });

  it("no_cache=true → 跳过 cache 读写", async () => {
    const search = makeStubSearch({
      search: vi.fn(async (q) =>
        zhipuWorked(q, [{ title: "Z1", url: "https://z1.test" }]),
      ),
    });
    const registry = makeRegistry();
    const cache = new SearchCache(tempSearchCacheDir);
    const decider = new FallbackDecider(new Map());

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(server, search, decider, noopBrowseExec, undefined, registry, cache);
    });

    try {
      // 第一次：no_cache=true → 不写 cache
      await client.callTool({
        name: "search",
        arguments: { query: "no-cache", engine: "zhipu", no_cache: true },
      });
      // 第二次：no_cache=false 但 cache 没写入 → 走 zhipu
      await client.callTool({
        name: "search",
        arguments: { query: "no-cache", engine: "zhipu" },
      });
      // zhipu 应被调 2 次（第一次 no_cache 不写，第二次 cache 未命中）
      expect(search.search).toHaveBeenCalledTimes(2);
    } finally {
      await shutdown();
    }
  });
});

describe("free_only 过滤", () => {
  it("free_only=L1 + zhipu/brave 都 L2 → empty didnt 结果", async () => {
    const search = makeStubSearch({
      search: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    });
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
        search,
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
      expect(search.search).not.toHaveBeenCalled();
      expect(brave.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });
});
