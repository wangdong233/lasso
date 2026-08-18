/**
 * search content_blocks 集成测（v1.17 Phase C / A2′ 第二跳；parse24 §3.2/§3.4）。
 *
 * 端到端验证工具层接线（真 McpServer + Client + registerSearchTool；channel /
 * 第二跳 fetch / 抽取全 stub 隔离网络）：
 *  - 缺省关：不传 content_blocks → 输出 byte-identical 基线（无增强字段 + 零 fetch）
 *  - content_blocks=N → top N 富化 + N 外条目原样；主信封（outcome/served_by/quality）不动
 *  - cache 交互：蓝链入缓存、正文不入（cache 文件零 content 字段）；cache 命中
 *    路径同样富化且正文每次实抓；channel 不重搜
 *  - attributed + content_blocks 共存（字段并集）
 *  - fallback_chain 出口路径富化
 *  - 全失败诚实：条目 fetch_failed 但 outcome 仍 worked
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
import { SearchCache } from "../../src/search/SearchCache.js";
import { registerSearchTool } from "../../src/tools/search.js";
import type { ContentSecondHopDeps } from "../../src/search/ContentSecondHop.js";
import type { MachineMcpSearchChannel } from "../../src/channels/MachineMcpSearchChannel.js";
import type {
  AttributedResult,
  InteractResult,
  SearchResult,
  SearchResultItem,
} from "../../src/types.js";
import type { BrowseExec } from "../../src/serp/extract.js";

// ============================================================
// stubs（channel / 第二跳 fetch / 抽取——隔离网络）
// ============================================================
function makeStubMachineMcp(impl: {
  search: (
    q: string,
    opts: { limit: number; engine: string; region: string; no_cache: boolean },
  ) => Promise<InteractResult<SearchResult>>;
}): MachineMcpSearchChannel {
  return {
    name: "search.machine_mcp",
    search: vi.fn(impl.search),
    isAvailable: vi.fn(async () => true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  } as unknown as MachineMcpSearchChannel;
}

function machineMcpWorked(
  query: string,
  results: Array<{ title: string; url: string }>,
): InteractResult<SearchResult> {
  return {
    outcome: "worked",
    data: {
      query,
      results: results.map((r) => ({ title: r.title, url: r.url, snippet: "snip" })),
      count: results.length,
      engine: "machine_mcp",
      region: "cn",
    },
    served_by: "search.machine_mcp",
    fallback_used: false,
    retrieval_method: "machine_mcp_api",
  };
}

/** 第二跳 deps：URL 分流 mock fetch（默认 200 HTML）+ 假抽取器。 */
function makeContentDeps(behavior: {
  statusFor?: (url: string) => number;
  contentTypeFor?: (url: string) => string;
} = {}): ContentSecondHopDeps & { fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(async (url: unknown) => {
    const u = String(url);
    const status = behavior.statusFor?.(u) ?? 200;
    const ct = behavior.contentTypeFor?.(u) ?? "text/html; charset=utf-8";
    if (status !== 200) {
      return new Response("nope", { status, headers: { "content-type": ct } });
    }
    return new Response(
      `<html><body><article><h1>Doc ${u}</h1><p>alpha mentions wasm runtime here.</p><p>beta filler.</p></article></body></html>`,
      { status, headers: { "content-type": ct } },
    );
  }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
  return {
    fetchImpl,
    extractImpl: async (html: string) => ({
      markdown: `# Doc\n\nalpha mentions wasm runtime here.\n\nbeta filler.\n\n(heavy page ${html.length} bytes)`,
    }),
    ssrfConfig: { allowRanges: [], denyRanges: [] },
  };
}

const noopBrowseExec: BrowseExec = async () => ({
  outcome: "unknown",
  data: null,
  error: "no_browse_in_test",
});

// ============================================================
// setup / harness
// ============================================================
let tempCache: string;
let tempSearchCacheDir: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-cbh-"));
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

async function startServer(
  register: (server: McpServer) => void,
): Promise<{ client: Client; shutdown: () => Promise<void> }> {
  const server = new McpServer({ name: "lasso-test", version: "0.1.0-test" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
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

/** 递归读 tempSearchCacheDir 下全部 cache 文件内容（断言零 content 污染用）。 */
async function readAllCacheFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 = 零文件
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".json")) out.push(await fs.readFile(p, "utf-8"));
    }
  }
  await walk(tempSearchCacheDir);
  return out;
}

function makeDecider(): FallbackDecider {
  return new FallbackDecider(
    new Map([
      ["fanout", new CircuitBreaker()],
      ["search.machine_mcp", new CircuitBreaker()],
      ["search.brave", new CircuitBreaker()],
      ["browse_headless", new CircuitBreaker()],
    ]),
  );
}

const THREE_RESULTS = [
  { title: "R1", url: "https://r1.test/doc" },
  { title: "R2", url: "https://r2.test/doc" },
  { title: "R3", url: "https://r3.test/doc" },
];

// ============================================================
// cases
// ============================================================
describe("content_blocks 缺省 = byte-identical 基线", () => {
  it("不传 content_blocks → 条目零增强字段 + 第二跳零 fetch", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) => machineMcpWorked(q, THREE_RESULTS)),
    });
    const contentDeps = makeContentDeps();
    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        makeDecider(),
        noopBrowseExec,
        undefined, // brave 未注入 → 单源 machine_mcp
        undefined,
        new SearchCache(tempSearchCacheDir),
        undefined,
        undefined,
        machineMcp,
        undefined,
        undefined,
        undefined,
        contentDeps,
      );
    });
    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "wasm runtime", limit: 10 },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.quality).toBe("api"); // A1 轴不受影响
      // 每条蓝链零增强字段（byte-identical：无 content/content_status/truncated 键）
      for (const r of result.data!.results as SearchResultItem[]) {
        expect(Object.keys(r).sort()).toEqual(["snippet", "title", "url"]);
      }
      // 第二跳零网络
      expect(contentDeps.fetchImpl).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });

  it("contentDeps 未注入 → 传 content_blocks 也被诚实忽略（条目零增强字段）", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) => machineMcpWorked(q, THREE_RESULTS)),
    });
    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        makeDecider(),
        noopBrowseExec,
        undefined,
        undefined,
        new SearchCache(tempSearchCacheDir),
        undefined,
        undefined,
        machineMcp,
      );
    });
    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "wasm runtime", limit: 10, content_blocks: 3 },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      for (const r of result.data!.results as SearchResultItem[]) {
        expect(Object.keys(r).sort()).toEqual(["snippet", "title", "url"]);
      }
    } finally {
      await shutdown();
    }
  });
});

describe("content_blocks=N 富化（单源出口路径）", () => {
  it("top N 条 content_status=ok + content；N 外条目原样；主信封不动", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) => machineMcpWorked(q, THREE_RESULTS)),
    });
    const contentDeps = makeContentDeps();
    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        makeDecider(),
        noopBrowseExec,
        undefined,
        undefined,
        new SearchCache(tempSearchCacheDir),
        undefined,
        undefined,
        machineMcp,
        undefined,
        undefined,
        undefined,
        contentDeps,
      );
    });
    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "wasm runtime", limit: 10, content_blocks: 2 },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      // 主信封不动（tri-state 诚实：enrichment 不是 fallback）
      expect(result.outcome).toBe("worked");
      expect(result.served_by).toBe("search.machine_mcp");
      expect(result.quality).toBe("api"); // A1 轴与 A2′ 轴共存（parse24 冲突 2 定案）
      expect(result.fallback_used).toBe(false);
      // top 2 富化
      const rs = result.data!.results as SearchResultItem[];
      expect(rs[0]!.content_status).toBe("ok");
      expect(rs[0]!.content).toContain("wasm");
      expect(rs[1]!.content_status).toBe("ok");
      expect(rs[1]!.content).toContain("wasm");
      // 第 3 条原样（不带增强键）
      expect(Object.keys(rs[2]!).sort()).toEqual(["snippet", "title", "url"]);
      // 恰好 fetch top 2
      expect(contentDeps.fetchImpl).toHaveBeenCalledTimes(2);
      // 蓝链字段保留
      expect(rs[0]!.title).toBe("R1");
      expect(rs[0]!.url).toBe("https://r1.test/doc");
    } finally {
      await shutdown();
    }
  });

  it("全失败诚实：所有条目 fetch_failed，outcome 仍 worked", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) => machineMcpWorked(q, THREE_RESULTS)),
    });
    const contentDeps = makeContentDeps({ statusFor: () => 403 });
    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        makeDecider(),
        noopBrowseExec,
        undefined,
        undefined,
        new SearchCache(tempSearchCacheDir),
        undefined,
        undefined,
        machineMcp,
        undefined,
        undefined,
        undefined,
        contentDeps,
      );
    });
    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: { query: "wasm runtime", limit: 10, content_blocks: 3 },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.served_by).toBe("search.machine_mcp");
      const rs = result.data!.results as SearchResultItem[];
      expect(rs.every((r) => r.content_status === "fetch_failed")).toBe(true);
      expect(rs.every((r) => r.content === undefined)).toBe(true);
      expect(rs.every((r) => r.title.length > 0 && r.url.length > 0)).toBe(true);
    } finally {
      await shutdown();
    }
  });

  it("attributed=true + content_blocks=1 → 字段并集（served_by/original_rank + content 轴）", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) => machineMcpWorked(q, THREE_RESULTS)),
    });
    const contentDeps = makeContentDeps();
    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        makeDecider(),
        noopBrowseExec,
        undefined,
        undefined,
        new SearchCache(tempSearchCacheDir),
        undefined,
        undefined,
        machineMcp,
        undefined,
        undefined,
        undefined,
        contentDeps,
      );
    });
    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: {
          query: "wasm runtime",
          limit: 10,
          attributed: true,
          content_blocks: 1,
        },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      const rs = result.data!.results as unknown as Array<
        AttributedResult & SearchResultItem
      >;
      expect(rs[0]!.served_by).toBe("search.machine_mcp");
      expect(rs[0]!.original_rank).toBe(1);
      expect(rs[0]!.content_status).toBe("ok");
      expect(rs[0]!.content).toContain("wasm");
      expect(rs[1]!.content_status).toBeUndefined(); // N 外条目不受富化影响
    } finally {
      await shutdown();
    }
  });
});

describe("content_blocks × cache（parse24 §3.4：蓝链缓存、正文不缓存）", () => {
  it("先无 content_blocks 入缓存 → cache 文件零 content 字段；带 content_blocks 命中缓存仍富化 + channel 不重搜 + cache 仍零污染 + 正文每次实抓", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) => machineMcpWorked(q, THREE_RESULTS)),
    });
    const contentDeps = makeContentDeps();
    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        makeDecider(),
        noopBrowseExec,
        undefined,
        undefined,
        new SearchCache(tempSearchCacheDir),
        undefined,
        undefined,
        machineMcp,
        undefined,
        undefined,
        undefined,
        contentDeps,
      );
    });
    const args = { query: "wasm runtime cache", limit: 10 };
    try {
      // 1. 第一次调用（无 content_blocks）→ 入缓存
      const resp1 = (await client.callTool({
        name: "search",
        arguments: args,
      })) as { content: Array<{ type: string; text: string }> };
      const result1 = parseToolResult(resp1.content[0]!.text);
      expect((result1 as { cached?: boolean }).cached).toBeUndefined();
      expect(machineMcp.search).toHaveBeenCalledTimes(1);
      expect(contentDeps.fetchImpl).not.toHaveBeenCalled();

      // cache 落盘零 content 污染（content_blocks 不入 key、正文不入值）
      const files1 = await readAllCacheFiles();
      expect(files1.length).toBe(1);
      expect(files1[0]!.includes("content_status")).toBe(false);
      expect(files1[0]!.includes('"content"')).toBe(false);

      // 2. 第二次同 query + content_blocks=2 → cache 命中（cached:true）仍富化
      const resp2 = (await client.callTool({
        name: "search",
        arguments: { ...args, content_blocks: 2 },
      })) as { content: Array<{ type: string; text: string }> };
      const result2 = parseToolResult(resp2.content[0]!.text);
      expect((result2 as unknown as { cached: boolean }).cached).toBe(true);
      expect(machineMcp.search).toHaveBeenCalledTimes(1); // 蓝链来自 cache，channel 不重搜
      expect(contentDeps.fetchImpl).toHaveBeenCalledTimes(2); // 正文每次实抓
      const rs2 = result2.data!.results as SearchResultItem[];
      expect(rs2[0]!.content_status).toBe("ok");
      expect(rs2[1]!.content_status).toBe("ok");
      expect(Object.keys(rs2[2]!).sort()).toEqual(["snippet", "title", "url"]);

      // cache 文件仍零 content 污染（富化只进响应，不回写缓存）
      const files2 = await readAllCacheFiles();
      expect(files2.length).toBe(1);
      expect(files2[0]!.includes("content_status")).toBe(false);
      expect(files2[0]!.includes('"content"')).toBe(false);

      // 3. 第三次再带 content_blocks → 正文再实抓（证明第二次的正文不是从缓存来的）
      await client.callTool({
        name: "search",
        arguments: { ...args, content_blocks: 1 },
      });
      expect(contentDeps.fetchImpl).toHaveBeenCalledTimes(3);
      expect(machineMcp.search).toHaveBeenCalledTimes(1);
    } finally {
      await shutdown();
    }
  });
});

describe("content_blocks × fallback_chain 出口路径", () => {
  it("engine=fallback_chain worked → 同样富化 + served_by/quality 不动", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) => machineMcpWorked(q, THREE_RESULTS)),
    });
    const contentDeps = makeContentDeps();
    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        makeDecider(),
        noopBrowseExec,
        undefined,
        undefined,
        new SearchCache(tempSearchCacheDir),
        undefined,
        undefined,
        machineMcp,
        undefined,
        undefined,
        undefined,
        contentDeps,
      );
    });
    try {
      const resp = (await client.callTool({
        name: "search",
        arguments: {
          query: "wasm runtime",
          limit: 10,
          engine: "fallback_chain",
          content_blocks: 1,
        },
      })) as { content: Array<{ type: string; text: string }> };
      const result = parseToolResult(resp.content[0]!.text);
      expect(result.outcome).toBe("worked");
      expect(result.served_by).toBe("search.machine_mcp");
      expect(result.quality).toBe("api");
      const rs = result.data!.results as SearchResultItem[];
      expect(rs[0]!.content_status).toBe("ok");
      expect(rs[0]!.content).toContain("wasm");
      expect(Object.keys(rs[2]!).sort()).toEqual(["snippet", "title", "url"]);
      expect(contentDeps.fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await shutdown();
    }
  });
});

describe("content_blocks 参数校验（zod）", () => {
  it("content_blocks=0 / =6 / 非整数 → zod 拒绝（1-5 硬界）", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async (q) => machineMcpWorked(q, THREE_RESULTS)),
    });
    const contentDeps = makeContentDeps();
    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        makeDecider(),
        noopBrowseExec,
        undefined,
        undefined,
        new SearchCache(tempSearchCacheDir),
        undefined,
        undefined,
        machineMcp,
        undefined,
        undefined,
        undefined,
        contentDeps,
      );
    });
    try {
      for (const bad of [0, 6, 2.5]) {
        // zod 校验失败 → MCP 协议层 isError（不静默走任何引擎；与 engine="zhipu"
        // 拒绝测试同范式）
        const resp = (await client.callTool({
          name: "search",
          arguments: { query: "wasm", limit: 10, content_blocks: bad },
        })) as { isError?: boolean };
        expect(resp.isError).toBe(true);
      }
      expect(machineMcp.search).not.toHaveBeenCalled();
      expect(contentDeps.fetchImpl).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });
});
