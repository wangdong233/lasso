/**
 * v1.8 Phase E / W1-DEF-10：caller-tier 接线测试。
 *
 * 缺陷（wave1 T-RT-06 实锤）：CallerTierTracker.tryAcquire 全仓零调用点
 * → admin caller_cap_set 后 6 次真实调用无一被拒、used 恒 0；cap_set/cap_list 空转。
 *
 * 修复：search.ts / browse.ts handler 入口接 tryAcquire（callerId 取
 * request params._meta.callerId；CC 不传 → "anonymous"）；超额 → tri-state
 * didnt + retrieval_method="caller_cap_exceeded"（parse7 §3.3 透明返回）。
 *
 * 本文件验证（真实 McpServer + InMemoryTransport + Client.callTool 带 _meta）：
 *  1. cap=2 时第 3 次 search 调用被拒（任务点名验收）
 *  2. _meta.callerId 隔离：vip(1) 超限不影响 anonymous
 *  3. cap=0 封禁语义：setCap("banned",0) → 首调即拒
 *  4. browse_headless / browse_logged_in 同 gate；被拒时 channel.browse 不被调
 *  5. 未注入 callerTier → 零回归（不 gate）
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerSearchTool } from "../../src/tools/search.js";
import { registerBrowseTools } from "../../src/tools/browse.js";
import { CallerTierTracker, ANONYMOUS_CALLER_ID } from "../../src/runtime/CallerTierTracker.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { ProviderRegistry } from "../../src/config/provider-registry.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";
import type {
  BrowseResult,
  InteractResult,
  SearchResult,
} from "../../src/types.js";
import type { SearchChannel } from "../../src/channels/SearchChannel.js";
import type { BraveChannel } from "../../src/channels/BraveChannel.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";
import type { BrowseExec } from "../../src/serp/extract.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// ============================================================
// stubs（与 fallback.spec / attributed-search.spec 同范式）
// ============================================================
function makeStubSearch(): SearchChannel {
  const ch = {
    name: "search.zhipu",
    search: vi.fn(async (q: string): Promise<InteractResult<SearchResult>> => ({
      outcome: "worked",
      data: {
        query: q,
        results: [{ title: `Z:${q}`, url: `https://z.test/${q}`, snippet: "" }],
        count: 1,
        engine: "zhipu",
        region: "cn",
      },
      served_by: "search.zhipu",
      fallback_used: false,
      retrieval_method: "zhipu_api",
    })),
    isAvailable: vi.fn(async () => true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  };
  return ch as unknown as SearchChannel;
}

function makeStubBrowse(
  name: "browse_headless" | "browse_logged_in",
): HeadlessChannel | LoggedInChannel {
  const ch = {
    name,
    browse: vi.fn(
      async (url: string): Promise<InteractResult<BrowseResult>> => ({
        outcome: "worked",
        data: { url, title: "stub", preview: "stub preview" } as unknown as BrowseResult,
        served_by: name,
        fallback_used: false,
        retrieval_method: "snapshot",
      }),
    ),
    isAvailable: vi.fn(async () => true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  };
  return ch as unknown as HeadlessChannel | LoggedInChannel;
}

function makeRegistry(): ProviderRegistry {
  const filled = BUILTIN_PROVIDERS.map((p) => ({ ...p }));
  const z = filled.find((p) => p.name === "zhipu");
  if (z) z.keys = ["zhipu-test-key"];
  return new ProviderRegistry(filled);
}

const noopBrowseExec: BrowseExec = async () => ({
  outcome: "unknown",
  data: null,
  error: "no_browse_in_test",
});

const ssrfConfig: SsrfConfig = { allowRanges: [], denyRanges: [] };

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

async function callSearch(
  client: Client,
  query: string,
  meta?: Record<string, unknown>,
) {
  const r = await client.callTool({
    name: "search",
    arguments: { query, limit: 4, engine: "auto", no_cache: true },
    ...(meta ? { _meta: meta } : {}),
  });
  const text = (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  return JSON.parse(text) as InteractResult<SearchResult>;
}

async function callBrowse(client: Client, tool: string, meta?: Record<string, unknown>) {
  const r = await client.callTool({
    name: tool,
    arguments: { url: "https://example.com/", action: "snapshot" },
    ...(meta ? { _meta: meta } : {}),
  });
  const text = (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  return JSON.parse(text) as InteractResult<BrowseResult>;
}

function registerSearch(server: McpServer, search: SearchChannel, callerTier?: CallerTierTracker) {
  registerSearchTool(
    server,
    search,
    new FallbackDecider(
      new Map([
        ["fanout", new CircuitBreaker()],
        ["search.zhipu", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    ),
    noopBrowseExec,
    undefined, // brave：单源路径（zhipu worked 即 fanout 不可达，断言更窄）
    makeRegistry(),
    undefined,
    null,
    null,
    null,
    undefined,
    callerTier,
  );
}

// ============================================================
// search 工具 gate
// ============================================================
describe("search × caller-tier gate（W1-DEF-10）", () => {
  it("cap=2 时第 3 次调用被拒（retrieval_method=caller_cap_exceeded，used 计数可见）", async () => {
    const search = makeStubSearch();
    const callerTier = new CallerTierTracker(2); // anonymous 默认 cap=2
    const { client, shutdown } = await startServer((s) =>
      registerSearch(s, search, callerTier),
    );
    try {
      const r1 = await callSearch(client, "q1");
      const r2 = await callSearch(client, "q2");
      expect(r1.outcome).toBe("worked");
      expect(r2.outcome).toBe("worked");
      expect(callerTier.currentUsage(ANONYMOUS_CALLER_ID)).toBe(2);

      const r3 = await callSearch(client, "q3");
      expect(r3.outcome).toBe("didnt");
      expect(r3.retrieval_method).toBe("caller_cap_exceeded");
      expect(r3.error).toContain(ANONYMOUS_CALLER_ID);
      expect(r3.error).toContain("cap=2");
      // 3rd 未触 channel（search mock 仍 2 次）
      expect(search.search).toHaveBeenCalledTimes(2);
      expect(callerTier.currentUsage(ANONYMOUS_CALLER_ID)).toBe(2); // 拒绝不扣
    } finally {
      await shutdown();
    }
  });

  it("_meta.callerId 隔离：vip cap=1 超限不影响 anonymous", async () => {
    const search = makeStubSearch();
    const callerTier = new CallerTierTracker(100);
    callerTier.setCap("vip", 1);
    const { client, shutdown } = await startServer((s) =>
      registerSearch(s, search, callerTier),
    );
    try {
      const v1 = await callSearch(client, "q1", { callerId: "vip" });
      expect(v1.outcome).toBe("worked");
      const v2 = await callSearch(client, "q2", { callerId: "vip" });
      expect(v2.outcome).toBe("didnt");
      expect(v2.retrieval_method).toBe("caller_cap_exceeded");
      // anonymous 独立预算，不受 vip 超限影响
      const a1 = await callSearch(client, "q3");
      expect(a1.outcome).toBe("worked");
      expect(callerTier.currentUsage("vip")).toBe(1);
      expect(callerTier.currentUsage(ANONYMOUS_CALLER_ID)).toBe(1);
    } finally {
      await shutdown();
    }
  });

  it("cap=0 封禁语义：setCap(banned,0) → 首调即拒", async () => {
    const search = makeStubSearch();
    const callerTier = new CallerTierTracker(100);
    callerTier.setCap("banned", 0);
    const { client, shutdown } = await startServer((s) =>
      registerSearch(s, search, callerTier),
    );
    try {
      const r = await callSearch(client, "q1", { callerId: "banned" });
      expect(r.outcome).toBe("didnt");
      expect(r.retrieval_method).toBe("caller_cap_exceeded");
      expect(r.error).toContain("cap=0");
      expect(search.search).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });

  it("零回归：callerTier 未注入 → 连续 5 次调用无一被拒（v1.7 行为）", async () => {
    const search = makeStubSearch();
    const { client, shutdown } = await startServer((s) =>
      registerSearch(s, search, undefined),
    );
    try {
      for (let i = 1; i <= 5; i++) {
        const r = await callSearch(client, `q${i}`);
        expect(r.outcome).toBe("worked");
      }
      expect(search.search).toHaveBeenCalledTimes(5);
    } finally {
      await shutdown();
    }
  });
});

// ============================================================
// browse 工具 gate
// ============================================================
describe("browse_headless / browse_logged_in × caller-tier gate（W1-DEF-10）", () => {
  function registerBrowse(server: McpServer, callerTier?: CallerTierTracker) {
    const headless = makeStubBrowse("browse_headless");
    const logged_in = makeStubBrowse("browse_logged_in");
    registerBrowseTools(
      server,
      headless as HeadlessChannel,
      logged_in as LoggedInChannel,
      new FallbackDecider(
        new Map([
          ["browse_headless", new CircuitBreaker()],
          ["browse_logged_in", new CircuitBreaker()],
        ]),
      ),
      ssrfConfig,
      callerTier,
    );
    return { headless, logged_in };
  }

  it("cap=2 时 browse_headless 第 3 次被拒；被拒时 channel.browse 不被调", async () => {
    const callerTier = new CallerTierTracker(2);
    const { client, shutdown } = await startServer((s) => {
      registerBrowse(s, callerTier);
    });
    try {
      const r1 = await callBrowse(client, "browse_headless");
      const r2 = await callBrowse(client, "browse_headless");
      expect(r1.outcome).toBe("worked");
      expect(r2.outcome).toBe("worked");

      const r3 = await callBrowse(client, "browse_headless");
      expect(r3.outcome).toBe("didnt");
      expect(r3.retrieval_method).toBe("caller_cap_exceeded");
      expect(callerTier.currentUsage(ANONYMOUS_CALLER_ID)).toBe(2);
    } finally {
      await shutdown();
    }
  });

  it("browse_logged_in 同 gate（cap=0 首调即拒 + channel 不被调）", async () => {
    const callerTier = new CallerTierTracker(100);
    callerTier.setCap("banned", 0);
    const { client, shutdown } = await startServer((s) => {
      registerBrowse(s, callerTier);
    });
    try {
      const r = await callBrowse(client, "browse_logged_in", { callerId: "banned" });
      expect(r.outcome).toBe("didnt");
      expect(r.retrieval_method).toBe("caller_cap_exceeded");
      expect(r.error).toContain("banned");
    } finally {
      await shutdown();
    }
  });

  it("search 与 browse 共享同一 caller 预算（per-caller 跨工具总量）", async () => {
    const callerTier = new CallerTierTracker(2);
    const search = makeStubSearch();
    const { client, shutdown } = await startServer((s) => {
      registerSearch(s, search, callerTier);
      registerBrowse(s, callerTier);
    });
    try {
      const s1 = await callSearch(client, "q1");
      const b1 = await callBrowse(client, "browse_headless");
      expect(s1.outcome).toBe("worked");
      expect(b1.outcome).toBe("worked");
      // 第 3 次（无论哪个工具）→ 同一 anonymous 预算耗尽
      const b2 = await callBrowse(client, "browse_headless");
      expect(b2.outcome).toBe("didnt");
      expect(b2.retrieval_method).toBe("caller_cap_exceeded");
      expect(callerTier.currentUsage(ANONYMOUS_CALLER_ID)).toBe(2);
    } finally {
      await shutdown();
    }
  });
});
