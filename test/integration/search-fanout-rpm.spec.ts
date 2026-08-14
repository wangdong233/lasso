/**
 * v1.8 Phase E / D6：fanout rpmOptions 接线测试。
 *
 * 缺陷：MultiSourceFanout.fanOutSearch 自 v0.3 起支持第 4 参 rpmOptions
 * （RpmLimiter 主动降级，F3.1.12），但 search.ts 的 fanout executor 调用点
 * 只传 4 参（query/limit/sources/executor）→ rpmOptions 恒 undefined →
 * 整条 RPM 限频链路从未生效。
 *
 * 修复：registerSearchTool 新增可选 rpmLimiter（index.ts 注入 per-process
 * RpmLimiter 单例）；fanout 调用点经 buildFanoutRpmOptions 补传第 4 参。
 *
 * 本文件验证：
 *  1. buildFanoutRpmOptions：ledger.rpmMax → maxBySource 映射；未配 → 空映射
 *  2. 端到端：defaultMax=1 的 limiter 注入后，第 1 次 fanout 两源各跑 1 次并记账；
 *     第 2 次 fanout 两源均被 rpm_limited 跳过（channel.search 不再被调）
 *  3. 零回归：rpmLimiter 未注入 → 连续两次 fanout 均正常执行（v1.7 行为）
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  registerSearchTool,
  buildFanoutRpmOptions,
} from "../../src/tools/search.js";
import { RpmLimiter } from "../../src/util/rpm-limiter.js";
import { QuotaLedger } from "../../src/config/quota-ledger.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { ProviderRegistry } from "../../src/config/provider-registry.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";
import type { InteractResult, SearchResult } from "../../src/types.js";
import type { SearchChannel } from "../../src/channels/SearchChannel.js";
import type { BraveChannel } from "../../src/channels/BraveChannel.js";
import type { BrowseExec } from "../../src/serp/extract.js";
import type { ProviderRegistry as IProviderRegistry } from "../../src/config/provider-registry.js";

// ============================================================
// stubs（与 attributed-search.spec / fallback.spec 同范式）
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

function makeStubBrave(): BraveChannel {
  const ch = {
    name: "search.brave",
    search: vi.fn(async (q: string): Promise<InteractResult<SearchResult>> => ({
      outcome: "worked",
      data: {
        query: q,
        results: [{ title: `B:${q}`, url: `https://b.test/${q}`, snippet: "" }],
        count: 1,
        engine: "brave",
        region: "US",
      },
      served_by: "search.brave",
      fallback_used: false,
      retrieval_method: "brave_api",
    })),
    isAvailable: vi.fn(async () => true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  };
  return ch as unknown as BraveChannel;
}

function makeRegistry(): ProviderRegistry {
  const filled = BUILTIN_PROVIDERS.map((p) => ({ ...p }));
  const z = filled.find((p) => p.name === "zhipu");
  if (z) z.keys = ["zhipu-test-key"];
  const b = filled.find((p) => p.name === "brave");
  if (b) b.keys = ["brave-key-1"];
  return new ProviderRegistry(filled);
}

const noopBrowseExec: BrowseExec = async () => ({
  outcome: "unknown",
  data: null,
  error: "no_browse_in_test",
});

function makeDecider(): FallbackDecider {
  return new FallbackDecider(
    new Map([
      ["fanout", new CircuitBreaker()],
      ["search.zhipu", new CircuitBreaker()],
      ["search.brave", new CircuitBreaker()],
      ["browse_headless", new CircuitBreaker()],
    ]),
  );
}

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

async function callSearch(client: Client, query: string) {
  const r = await client.callTool({
    name: "search",
    arguments: { query, limit: 4, engine: "auto", no_cache: true },
  });
  const text = (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  return JSON.parse(text) as InteractResult<SearchResult>;
}

// ============================================================
// 1. buildFanoutRpmOptions 单元映射
// ============================================================
describe("buildFanoutRpmOptions（D6 映射构造）", () => {
  it("ledger.rpmMax 配了 → maxBySource 逐源映射；limiter 透传", () => {
    const limiter = new RpmLimiter();
    const zhipuLedger = new QuotaLedger("zhipu", ["k"], 1000, "monthly", 5);
    const braveLedger = new QuotaLedger("brave", ["k"], 2000, "monthly", 9);
    const registry = {
      get: (n: string) =>
        n === "zhipu"
          ? { ledger: zhipuLedger }
          : n === "brave"
            ? { ledger: braveLedger }
            : undefined,
    } as unknown as IProviderRegistry;
    const opts = buildFanoutRpmOptions(limiter, registry);
    expect(opts.limiter).toBe(limiter);
    expect(opts.maxBySource).toEqual({
      "search.zhipu": 5,
      "search.brave": 9,
    });
  });

  it("ledger.rpmMax 全未配（v1.8 默认配置面）→ maxBySource 空对象（defaultMax=Infinity 不限频）", () => {
    const limiter = new RpmLimiter();
    const opts = buildFanoutRpmOptions(limiter, makeRegistry());
    expect(opts.limiter).toBe(limiter);
    expect(opts.maxBySource).toEqual({});
  });

  it("registry 未注入 → 同样空映射（不抛）", () => {
    const limiter = new RpmLimiter();
    expect(buildFanoutRpmOptions(limiter).maxBySource).toEqual({});
  });
});

// ============================================================
// 2. 端到端：rpmLimiter 注入后 fanout 真被限频
// ============================================================
describe("search fanout × rpmLimiter 端到端（D6 接线）", () => {
  it("defaultMax=1：第 1 次两源各跑 1 次；第 2 次两源 rpm_limited 跳过（channel.search 不再被调）", async () => {
    const search = makeStubSearch();
    const brave = makeStubBrave();
    // defaultMax=1：每源 60s 窗口 1 次（未配 ledger.rpmMax 的源走 defaultMax）
    const limiter = new RpmLimiter(60_000, 1);

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        search,
        makeDecider(),
        noopBrowseExec,
        brave,
        makeRegistry(),
        undefined, // cache：不注入（隔离）
        null,
        null,
        null,
        undefined, // machineMcp
        undefined, // callerTier
        limiter, // ← D6 接线点
      );
    });

    try {
      // 第 1 次：两源都允许（usage 0/1）→ worked engine=multi + 记账
      const r1 = await callSearch(client, "q1");
      expect(r1.outcome).toBe("worked");
      expect(r1.data?.engine).toBe("multi");
      expect(search.search).toHaveBeenCalledTimes(1);
      expect(brave.search).toHaveBeenCalledTimes(1);
      expect(limiter.currentUsage("search.zhipu")).toBe(1);
      expect(limiter.currentUsage("search.brave")).toBe(1);

      // 第 2 次：两源 usage 1/1 → rpm_limited 跳过（channel.search 计数不变）
      //   fanout → unknown(all_sources_rpm_limited) → decider 升 browse_headless
      //   （noop exec → 不 worked）→ 最终非 worked，但 RPM 跳过才是断言核心。
      const r2 = await callSearch(client, "q2");
      expect(r2.outcome).not.toBe("worked");
      expect(search.search).toHaveBeenCalledTimes(1); // 未被再次调用
      expect(brave.search).toHaveBeenCalledTimes(1); // 未被再次调用
      expect(limiter.currentUsage("search.zhipu")).toBe(1); // 失败不记账
    } finally {
      await shutdown();
    }
  });

  it("零回归：rpmLimiter 未注入 → 连续两次 fanout 均正常执行（v1.7 行为）", async () => {
    const search = makeStubSearch();
    const brave = makeStubBrave();

    const { client, shutdown } = await startServer((server) => {
      registerSearchTool(
        server,
        search,
        makeDecider(),
        noopBrowseExec,
        brave,
        makeRegistry(),
        undefined,
        null,
        null,
        null,
        undefined,
        undefined, // callerTier 未注入
        // rpmLimiter 未注入（v1.7 调用形状）
      );
    });

    try {
      const r1 = await callSearch(client, "q1");
      const r2 = await callSearch(client, "q2");
      expect(r1.outcome).toBe("worked");
      expect(r2.outcome).toBe("worked");
      expect(search.search).toHaveBeenCalledTimes(2);
      expect(brave.search).toHaveBeenCalledTimes(2);
    } finally {
      await shutdown();
    }
  });
});
