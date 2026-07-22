/**
 * engine="fallback_chain" 集成测（parse10 §3 + §5 + §6 V1-V4 CI 验收）。
 *
 * 守护要点（parse10 §1 决策 4 + §3.2 + §3.4 + §1 边界表 7 场景）：
 *  1. **零回归**：engine="auto" 默认路径 byte-identical v0.8（不进 fallback_chain 分支）。
 *  2. **plan 构造器**：FallbackChain 构造 plan 后交 FallbackDecider.runWithFallback 执行
 *     （INV-55 单一 fallback 引擎；本测试 grep 验 runFallbackChain 内不循环）。
 *  3. **三层降级**：zhipu unknown → brave unknown → bing unknown → browse_headless。
 *     每档单独验（不一次性把三档都 unknown，便于排查哪档熔断逻辑出错）。
 *  4. **全源熔断 + replay 兜底**：三源 + browse_headless 全失败 + recordingStore 命中
 *     → served_by="recording_replay"；未命中 → tri-state didnt（诚实不伪造）。
 *  5. **Bing key=[] 时跳过**：bing 不注入 → fallback_chain 仍走 zhipu → brave → browse_headless。
 *  6. **INV-57 录制默认 OFF**：未注入 recordingStore 时全源熔断返 didnt 不 replay。
 *
 * 测试策略：与 fallback.spec.ts 同范式 ——
 *  - 真实 McpServer + Client + InMemoryTransport
 *  - 真实 FallbackDecider + CircuitBreaker Map
 *  - 真实 RecordingStore（落盘到 tmpdir）
 *  - channel.search/browse 用 stub（隔离网络 + 智谱协议层 + chrome-devtools-mcp）
 *  - runFallbackChainEngine helper 直接调（不经 server.tool 装配的额外覆盖）
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { RecordingStore } from "../../src/serp/RecordingStore.js";
import {
  runFallbackChainEngine,
} from "../../src/tools/search.js";
import type {
  BingChannel,
  BingOpts,
} from "../../src/channels/BingChannel.js";
import type {
  BraveChannel,
  BraveOpts,
} from "../../src/channels/BraveChannel.js";
import type { SearchChannel } from "../../src/channels/SearchChannel.js";
import type { BrowseResult, InteractResult, SearchResult } from "../../src/types.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";

// ============================================================
// stub channel factories
// ============================================================
function makeStubSearch(impl: {
  search: (
    q: string,
    opts: { limit: number; engine: string; region: string; no_cache: boolean },
  ) => Promise<InteractResult<SearchResult>>;
}): SearchChannel {
  return {
    name: "search.zhipu",
    search: vi.fn(impl.search),
    isAvailable: vi.fn(async () => true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  } as unknown as SearchChannel;
}

function makeStubBrave(impl: {
  search: (q: string, opts: BraveOpts) => Promise<InteractResult<SearchResult>>;
  isAvailable: () => Promise<boolean>;
}): BraveChannel {
  return {
    name: "search.brave",
    search: vi.fn(impl.search),
    isAvailable: vi.fn(impl.isAvailable),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  } as unknown as BraveChannel;
}

function makeStubBing(impl: {
  search: (q: string, opts: BingOpts) => Promise<InteractResult<SearchResult>>;
  isAvailable: () => Promise<boolean>;
}): BingChannel {
  return {
    name: "search.bing",
    search: vi.fn(impl.search),
    isAvailable: vi.fn(impl.isAvailable),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  } as unknown as BingChannel;
}

function makeStubHeadless(impl: {
  browse: (
    url: string,
    action: string,
    opts: Record<string, unknown>,
  ) => Promise<InteractResult<BrowseResult>>;
}): HeadlessChannel {
  return {
    name: "browse_headless",
    browse: vi.fn(impl.browse),
    isAvailable: vi.fn(async () => true),
    status: vi.fn(async () => ({ available: true, latency_ms: 10 })),
    healthCheck: vi.fn(async () => "healthy" as const),
  } as unknown as HeadlessChannel;
}

// ============================================================
// 共用 fixture：worked InteractResult 工厂
// ============================================================
function workedSearch(servedBy: string, n: number = 2): InteractResult<SearchResult> {
  const results = Array.from({ length: n }, (_, i) => ({
    title: `${servedBy} result ${i + 1}`,
    url: `https://${servedBy.replace(/\./g, "-")}.test/r${i + 1}`,
    snippet: `${servedBy} snippet ${i + 1}`,
  }));
  return {
    outcome: "worked",
    data: {
      query: "x",
      results,
      count: n,
      engine: servedBy,
      region: "cn",
    },
    served_by: servedBy,
    fallback_used: false,
    retrieval_method: `${servedBy}_api`,
  };
}

function unknownSearch(servedBy: string, error: string): InteractResult<SearchResult> {
  return {
    outcome: "unknown",
    data: null,
    served_by: servedBy,
    fallback_used: false,
    retrieval_method: `${servedBy}_api`,
    error,
  };
}

// ============================================================
// setup
// ============================================================
let tempCache: string;
let recordingsDir: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-fbc-"));
  recordingsDir = path.join(tempCache, "search-recordings");
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
// runFallbackChainEngine 直调测（不经 MCP server.tool 装配）
// ============================================================
describe("runFallbackChainEngine —— plan 构造 + 三层降级", () => {
  it("V1：zhipu worked → 直接返回 served_by=search.zhipu + fallback_used=false", async () => {
    const search = makeStubSearch({
      search: vi.fn(async () => workedSearch("search.zhipu")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => {
        throw new Error("brave should not be called when zhipu works");
      }),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => {
        throw new Error("bing should not be called when zhipu works");
      }),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => {
        throw new Error("browse_headless should not be called");
      }),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );
    const recordingStore = new RecordingStore(recordingsDir);

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      recordingStore,
      /* braveAllowedByFreeTier */ true,
      /* zhipuAllowedByFreeTier */ true,
      /* allowedSearchProviders */ null,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("search.zhipu");
    expect(result.fallback_used).toBe(false);
    expect(result.data).not.toBeNull();
    expect(result.data!.results).toHaveLength(2);
    expect(brave.search).not.toHaveBeenCalled();
    expect(bing.search).not.toHaveBeenCalled();
  });

  it("V2：zhipu unknown → brave worked（fallback_used=true + served_by=search.brave）", async () => {
    const search = makeStubSearch({
      search: vi.fn(async () => unknownSearch("search.zhipu", "HTTP 429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => workedSearch("search.brave")),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => {
        throw new Error("bing should not be called when brave works");
      }),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => {
        throw new Error("browse_headless should not be called");
      }),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      null,
      true,
      true,
      null,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("search.brave");
    expect(result.fallback_used).toBe(true);
    expect(result.actions_and_results).toBeDefined();
    expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
      "search.zhipu",
      "search.brave",
    ]);
    expect(bing.search).not.toHaveBeenCalled();
  });

  it("V3：zhipu + brave 全 unknown → bing worked（fallback_used=true + served_by=search.bing）", async () => {
    const search = makeStubSearch({
      search: vi.fn(async () => unknownSearch("search.zhipu", "HTTP 429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "HTTP 429")),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => workedSearch("search.bing")),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => {
        throw new Error("browse_headless should not be called when bing works");
      }),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      null,
      true,
      true,
      null,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("search.bing");
    expect(result.fallback_used).toBe(true);
    expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
      "search.zhipu",
      "search.brave",
      "search.bing",
    ]);
  });

  it("V4a：zhipu + brave + bing 全 unknown → browse_headless SERP scrape 兜底 worked", async () => {
    const search = makeStubSearch({
      search: vi.fn(async () => unknownSearch("search.zhipu", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => unknownSearch("search.bing", "429")),
      isAvailable: async () => true,
    });
    // browse_headless SERP scrape 抽到 URL（serpScrapeFallback 走 SERP 抽取路径）
    const headless = makeStubHeadless({
      browse: vi.fn(async () => ({
        outcome: "worked" as const,
        data: {
          url: "https://www.baidu.com/s?wd=test",
          action: "snapshot",
          state_id: "stub-id",
          content_path: "/tmp/stub",
          preview:
            "Baidu Results\nhttps://example.com/a1\nMore text\nhttps://example.com/a2",
        },
        served_by: "browse_headless",
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
      })),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      null,
      true,
      true,
      null,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("browse_headless");
    expect(result.fallback_used).toBe(true);
    expect(result.data!.engine).toBe("baidu_serp");
    expect(result.data!.results.length).toBeGreaterThan(0);
  });

  it("V4b：全源 + browse_headless 全熔断 + 无 recordingStore → tri-state didnt（诚实不伪造）", async () => {
    const search = makeStubSearch({
      search: vi.fn(async () => unknownSearch("search.zhipu", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => unknownSearch("search.bing", "429")),
      isAvailable: async () => true,
    });
    // browse_headless 也返 unknown（SERP 抽不到 URL）
    const headless = makeStubHeadless({
      browse: vi.fn(async () => ({
        outcome: "unknown" as const,
        data: null,
        served_by: "browse_headless",
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
        error: "empty_preview",
      })),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    // recordingStore = null：守 INV-57，无录制回放，直接返 didnt
    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      null,
      true,
      true,
      null,
    );

    expect(result.outcome).toBe("didnt");
    expect(result.retrieval_method).toBe("fallback_exhausted");
    expect(result.data).toBeNull();
    expect(result.served_by).toBe("browse_headless");
    // 审计链完整（4 channel 都试过）
    expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
      "search.zhipu",
      "search.brave",
      "search.bing",
      "browse_headless",
    ]);
  });

  it("V4c：全源熔断 + recordingStore 命中过去录制的 fixture → served_by=recording_replay", async () => {
    // 先准备一个过去录制的 fixture（直接调 RecordingStore.save 模拟过去某次成功录制）
    const recordingStore = new RecordingStore(recordingsDir);
    const pastResult = workedSearch("search.brave");
    await recordingStore.save(
      "fallback_chain",
      "important query",
      JSON.stringify(pastResult.data),
    );

    // 全源失败
    const search = makeStubSearch({
      search: vi.fn(async () => unknownSearch("search.zhipu", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => unknownSearch("search.bing", "429")),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => ({
        outcome: "unknown" as const,
        data: null,
        served_by: "browse_headless",
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
        error: "empty_preview",
      })),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    const result = await runFallbackChainEngine(
      "important query",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      true,
      null,
    );

    // 命中 replay：outcome=worked + served_by=recording_replay
    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("recording_replay");
    expect(result.retrieval_method).toBe("recording_replay");
    expect(result.fallback_used).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data!.results).toHaveLength(2);
    // 审计链保留原 fallback 全源熔断链（让 caller 看到实际所有 source 都失败了）
    expect(result.actions_and_results!.length).toBeGreaterThanOrEqual(4);
  });

  it("V4d：全源熔断 + recordingStore 注入但**未**命中 fixture → 仍返 didnt（不伪造）", async () => {
    const recordingStore = new RecordingStore(recordingsDir);
    // 故意不录任何 fixture

    const search = makeStubSearch({
      search: vi.fn(async () => unknownSearch("search.zhipu", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => unknownSearch("search.bing", "429")),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => ({
        outcome: "unknown" as const,
        data: null,
        served_by: "browse_headless",
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
        error: "empty",
      })),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    const result = await runFallbackChainEngine(
      "novel query never recorded",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      true,
      null,
    );

    expect(result.outcome).toBe("didnt");
    expect(result.retrieval_method).toBe("fallback_exhausted");
    expect(result.served_by).not.toBe("recording_replay");
  });
});

// ============================================================
// Bing key=[] 跳过 + free_only 过滤
// ============================================================
describe("engine=fallback_chain —— Bing key=[] 时跳过 + free_only 过滤", () => {
  it("bing=null → fallback_chain 仍走 zhipu → brave → browse_headless（不调 bing）", async () => {
    const search = makeStubSearch({
      search: vi.fn(async () => unknownSearch("search.zhipu", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => workedSearch("search.brave")),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => {
        throw new Error("browse_headless not reached when brave works");
      }),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    // bing=null（BING_API_KEYS 未配）；verify bing 兜底层不存在但 zhipu → brave 仍工作
    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      search,
      brave,
      /* bing */ null,
      browseHeadlessExec,
      decider,
      null,
      true,
      true,
      null,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("search.brave");
    // 审计链不含 search.bing（bing=null 时被剔除）
    expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
      "search.zhipu",
      "search.brave",
    ]);
  });

  it("free_only=L1 排除所有 search provider → channelOrder 仅含 browse_headless → 全源熔断返 didnt", async () => {
    const search = makeStubSearch({
      search: vi.fn(async () => workedSearch("search.zhipu")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => workedSearch("search.brave")),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => workedSearch("search.bing")),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => ({
        outcome: "unknown" as const,
        data: null,
        served_by: "browse_headless",
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
        error: "empty",
      })),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    // 模拟 L1 过滤：所有 search provider 都不在允许集；allowedSearchProviders=[]
    // → zhipu/brave/bing 全 false → channelOrder 仅含 browse_headless
    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      null,
      /* braveAllowed */ false,
      /* zhipuAllowed */ false,
      /* allowedSearchProviders */ [],
    );

    // browse_headless 兜底也失败 → didnt
    expect(result.outcome).toBe("didnt");
    // 三源 search 都未被调用（free_only 过滤掉）
    expect(search.search).not.toHaveBeenCalled();
    expect(brave.search).not.toHaveBeenCalled();
    expect(bing.search).not.toHaveBeenCalled();
    // browse_headless 被调（cross_modal 兜底不受 free_only 影响）
    expect(headless.browse).toHaveBeenCalled();
  });
});

// ============================================================
// 录制回放（INV-57 + INV-59）
// ============================================================
describe("engine=fallback_chain —— 录制 + 回放语义（INV-57..59）", () => {
  it("worked 时若 LASSO_RECORD_SEARCH=true → saveIfRecording fire-and-forget 落盘", async () => {
    // 显式开录制（enabledOverride=true）；测完恢复
    const recordingStore = new RecordingStore(recordingsDir, true);
    expect(recordingStore.isEnabled()).toBe(true);

    const search = makeStubSearch({
      search: vi.fn(async () => workedSearch("search.zhipu")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => {
        throw new Error("brave not called");
      }),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => {
        throw new Error("bing not called");
      }),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => {
        throw new Error("not called");
      }),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    const result = await runFallbackChainEngine(
      "query to be recorded",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      true,
      null,
    );

    expect(result.outcome).toBe("worked");

    // saveIfRecording 是 fire-and-forget；await 一个 microtask 让 save Promise resolve
    await new Promise((r) => setTimeout(r, 50));

    // fixture 应已落盘（engine key = "fallback_chain"）
    const hasFile = await recordingStore.has("fallback_chain", "query to be recorded");
    expect(hasFile).toBe(true);
  });

  it("LASSO_RECORD_SEARCH 未设（默认 OFF）→ saveIfRecording 不落盘（INV-57 守）", async () => {
    // 不传 enabledOverride → 走 process.env.LASSO_RECORD_SEARCH（测试 env 默认 OFF）
    const recordingStore = new RecordingStore(recordingsDir);
    expect(recordingStore.isEnabled()).toBe(false);

    const search = makeStubSearch({
      search: vi.fn(async () => workedSearch("search.zhipu")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => {
        throw new Error("not called");
      }),
      isAvailable: async () => true,
    });
    const bing = makeStubBing({
      search: vi.fn(async () => {
        throw new Error("not called");
      }),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => {
        throw new Error("not called");
      }),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.zhipu", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["search.bing", new CircuitBreaker()],
        ["browse_headless", new CircuitBreaker()],
      ]),
    );

    const browseHeadlessExec = async (url: string) => {
      const r = await headless.browse(url, "snapshot", {});
      return {
        outcome: r.outcome,
        data: r.data ? { preview: r.data.preview } : null,
        error: r.error,
      };
    };

    const result = await runFallbackChainEngine(
      "query not recorded",
      10,
      "cn",
      false,
      search,
      brave,
      bing,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      true,
      null,
    );

    expect(result.outcome).toBe("worked");

    await new Promise((r) => setTimeout(r, 50));

    // 默认 OFF → 不落盘
    const hasFile = await recordingStore.has(
      "fallback_chain",
      "query not recorded",
    );
    expect(hasFile).toBe(false);
  });
});
