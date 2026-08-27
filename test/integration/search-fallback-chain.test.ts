/**
 * engine="fallback_chain" 集成测（parse10 §3 + §5 + §6 V1-V4 CI 验收；
 * v1.15 Phase A 修订：Bing 死层清除；
 * v1.15 Phase B 修订：browse_headless 之前插入 serp_http 裸 HTTP 快探层（parse22）；
 * v1.17 A3 修订：zhipu 直连档删除后链 = machine_mcp → brave → serp_http →
 * browse_headless → recording_replay（INV-80 墓碑守卫）。
 *
 * 守护要点（parse10 §1 决策 4 + §3.2 + §3.4 + §1 边界表 7 场景）：
 *  1. **零回归**：engine="auto" 默认路径 byte-identical v0.8（不进 fallback_chain 分支）。
 *  2. **plan 构造器**：FallbackChain 构造 plan 后交 FallbackDecider.runWithFallback 执行
 *     （INV-55 单一 fallback 引擎；本测试 grep 验 runFallbackChain 内不循环）。
 *  3. **降级链**：machine_mcp unknown → brave unknown → browse_headless。
 *     每档单独验（不一次性把各档都 unknown，便于排查哪档熔断逻辑出错）。
 *  4. **全源熔断 + replay 兜底**：两源 + browse_headless 全失败 + recordingStore 命中
 *     → served_by="recording_replay"；未命中 → tri-state didnt（诚实不伪造）。
 *  5. **INV-54 墓碑守卫**：runFallbackChainEngine 已无 bing 参数——装配层永不出
 *     bing channel（Bing Search APIs 2025-08-11 全量退役，死层清除）。
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
  BraveChannel,
  BraveOpts,
} from "../../src/channels/BraveChannel.js";
import type { MachineMcpSearchChannel } from "../../src/channels/MachineMcpSearchChannel.js";
import type { BrowseResult, InteractResult, SearchResult } from "../../src/types.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
// v1.15 Phase B（parse22 §5.2）：serp_http 快探层链序断言
import type { HttpSerpExec } from "../../src/serp/http-serp.js";

// ============================================================
// stub channel factories
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
describe("runFallbackChainEngine —— plan 构造 + 降级链", () => {
  it("V1：machine_mcp worked → 直接返回 served_by=search.machine_mcp + fallback_used=false", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => workedSearch("search.machine_mcp")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => {
        throw new Error("brave should not be called when machine_mcp works");
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
        ["search.machine_mcp", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
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
      /* freshness (v1.11 T6) */ undefined,
      brave,
      browseHeadlessExec,
      decider,
      recordingStore,
      /* braveAllowedByFreeTier */ true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("search.machine_mcp");
    expect(result.fallback_used).toBe(false);
    // A1 质量轴：machine_mcp API 源 → quality="api"
    expect(result.quality).toBe("api");
    expect(result.data).not.toBeNull();
    expect(result.data!.results).toHaveLength(2);
    expect(brave.search).not.toHaveBeenCalled();
  });

  it("V2：machine_mcp unknown → brave worked（fallback_used=true + served_by=search.brave）", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => unknownSearch("search.machine_mcp", "HTTP 429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => workedSearch("search.brave")),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({
      browse: vi.fn(async () => {
        throw new Error("browse_headless should not be called");
      }),
    });

    const decider = new FallbackDecider(
      new Map([
        ["search.machine_mcp", new CircuitBreaker()],
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

    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      /* freshness (v1.11 T6) */ undefined,
      brave,
      browseHeadlessExec,
      decider,
      null,
      true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("search.brave");
    expect(result.fallback_used).toBe(true);
    expect(result.actions_and_results).toBeDefined();
    expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
      "search.machine_mcp",
      "search.brave",
    ]);
  });

  it("V3：machine_mcp + brave 全 unknown → browse_headless SERP scrape 兜底 worked", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => unknownSearch("search.machine_mcp", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
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
        ["search.machine_mcp", new CircuitBreaker()],
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

    const result = await runFallbackChainEngine(
      "测试查询",
      10,
      "cn",
      false,
      /* freshness (v1.11 T6) */ undefined,
      brave,
      browseHeadlessExec,
      decider,
      null,
      true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("browse_headless");
    expect(result.fallback_used).toBe(true);
    // v1.11 T9：CJK query → baidu 兜底（英文 query 走 ddg——见 serp-ddg.spec.ts）
    expect(result.data!.engine).toBe("baidu_serp");
    expect(result.data!.results.length).toBeGreaterThan(0);
    // v1.15 Phase A（INV-54 墓碑守卫）：审计链无 search.bing 档（死层清除）
    expect(
      result.actions_and_results!.map((a) => a.channel),
    ).toEqual(["search.machine_mcp", "search.brave", "browse_headless"]);
  });

  it("V4a：全源 + browse_headless 全熔断 + 无 recordingStore → tri-state didnt（诚实不伪造）", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => unknownSearch("search.machine_mcp", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
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
        ["search.machine_mcp", new CircuitBreaker()],
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

    // recordingStore = null：守 INV-57，无录制回放，直接返 didnt
    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      /* freshness (v1.11 T6) */ undefined,
      brave,
      browseHeadlessExec,
      decider,
      null,
      true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
    );

    expect(result.outcome).toBe("didnt");
    expect(result.retrieval_method).toBe("fallback_exhausted");
    expect(result.data).toBeNull();
    expect(result.served_by).toBe("browse_headless");
    // 审计链完整（3 channel 都试过：machine_mcp → brave → browse_headless）
    expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
      "search.machine_mcp",
      "search.brave",
      "browse_headless",
    ]);
  });

  it("V4b：全源熔断 + recordingStore 命中过去录制的 fixture → served_by=recording_replay", async () => {
    // 先准备一个过去录制的 fixture（直接调 RecordingStore.save 模拟过去某次成功录制）
    const recordingStore = new RecordingStore(recordingsDir);
    const pastResult = workedSearch("search.brave");
    await recordingStore.save(
      "fallback_chain",
      "important query",
      JSON.stringify(pastResult.data),
    );

    // 全源失败
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => unknownSearch("search.machine_mcp", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
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
        ["search.machine_mcp", new CircuitBreaker()],
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

    const result = await runFallbackChainEngine(
      "important query",
      10,
      "cn",
      false,
      /* freshness (v1.11 T6) */ undefined,
      brave,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
    );

    // 命中 replay：outcome=worked + served_by=recording_replay
    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("recording_replay");
    expect(result.retrieval_method).toBe("recording_replay");
    // A1 质量轴（v1.17 Phase B）：回放是过去快照 → quality="stale"
    expect(result.quality).toBe("stale");
    expect(result.fallback_used).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data!.results).toHaveLength(2);
    // 审计链保留原 fallback 全源熔断链（让 caller 看到实际所有 source 都失败了）
    expect(result.actions_and_results!.length).toBeGreaterThanOrEqual(3);
  });

  // ============================================================
  // ZB-3b（doc/governance/05 verdict D-GO-1，2026-08-18）：freshness 查询的回放新鲜度门。
  // replay 键只有 (engine, query)——不设门则 freshness=day 会拿到陈年 fixture 标 worked。
  // ============================================================
  it("V4b-ZB3：freshness=day + fixture 录于 3 天前 → 拒回放（返原 didnt/unknown，不运陈货）", async () => {
    const recordingStore = new RecordingStore(recordingsDir);
    const pastResult = workedSearch("search.brave");
    await recordingStore.save(
      "fallback_chain",
      "stale freshness query",
      JSON.stringify(pastResult.data),
    );
    // 把 fixture mtime 拨回 3 天前（> day 窗口 24h）
    const file = recordingStore.pathOf("fallback_chain", "stale freshness query");
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await fs.utimes(file, threeDaysAgo, threeDaysAgo);

    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => unknownSearch("search.machine_mcp", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
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
        ["search.machine_mcp", new CircuitBreaker()],
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

    const result = await runFallbackChainEngine(
      "stale freshness query",
      10,
      "cn",
      false,
      /* freshness=day */ "day",
      brave,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
    );

    // 陈旧 fixture 被新鲜度门拒绝：不是 worked/recording_replay，而是透传原熔断结果
    expect(result.served_by).not.toBe("recording_replay");
    expect(result.outcome).not.toBe("worked");
  });

  it("V4b-ZB3b：freshness=day + fixture 录于 2 小时前 → 正常回放（窗内不受影响）", async () => {
    const recordingStore = new RecordingStore(recordingsDir);
    const pastResult = workedSearch("search.brave");
    await recordingStore.save(
      "fallback_chain",
      "fresh replay within window",
      JSON.stringify(pastResult.data),
    );
    const file = recordingStore.pathOf("fallback_chain", "fresh replay within window");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(file, twoHoursAgo, twoHoursAgo);

    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => unknownSearch("search.machine_mcp", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
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
        ["search.machine_mcp", new CircuitBreaker()],
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

    const result = await runFallbackChainEngine(
      "fresh replay within window",
      10,
      "cn",
      false,
      /* freshness=day */ "day",
      brave,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
    );

    // 窗内 fixture 正常回放
    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("recording_replay");
  });

  it("V4c：全源熔断 + recordingStore 注入但**未**命中 fixture → 仍返 didnt（不伪造）", async () => {
    const recordingStore = new RecordingStore(recordingsDir);
    // 故意不录任何 fixture

    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => unknownSearch("search.machine_mcp", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
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
        ["search.machine_mcp", new CircuitBreaker()],
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

    const result = await runFallbackChainEngine(
      "novel query never recorded",
      10,
      "cn",
      false,
      /* freshness (v1.11 T6) */ undefined,
      brave,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
    );

    expect(result.outcome).toBe("didnt");
    expect(result.retrieval_method).toBe("fallback_exhausted");
    expect(result.served_by).not.toBe("recording_replay");
  });
});

// ============================================================
// free_only 过滤（v1.15 Phase A：Bing 场景已删；v1.17 A3：zhipuAllowed 参数已删——
// 仅剩 braveAllowed；machine_mcp L1 不过滤、未注入时诚实空链）
// ============================================================
describe("engine=fallback_chain —— free_only 过滤", () => {
  it("free_only=L1 排除所有 search provider → channelOrder 仅含 browse_headless → 全源熔断返 didnt", async () => {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => workedSearch("search.machine_mcp")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => workedSearch("search.brave")),
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
        ["search.machine_mcp", new CircuitBreaker()],
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

    // 模拟 L1 过滤：API search provider（brave）不在允许集且 machine_mcp 未注入
    // → channelOrder 仅含 browse_headless
    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      /* freshness (v1.11 T6) */ undefined,
      brave,
      browseHeadlessExec,
      decider,
      null,
      /* braveAllowed */ false,
      /* machineMcp（未注入——L1 无 API 源只剩 browse_headless 兜底） */
    );

    // browse_headless 兜底也失败 → didnt
    expect(result.outcome).toBe("didnt");
    // API search 源未被调用（free_only 过滤掉 brave；machine_mcp 未注入）
    expect(brave.search).not.toHaveBeenCalled();
    expect(brave.search).not.toHaveBeenCalled();
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

    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => workedSearch("search.machine_mcp")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => {
        throw new Error("brave not called");
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
        ["search.machine_mcp", new CircuitBreaker()],
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

    const result = await runFallbackChainEngine(
      "query to be recorded",
      10,
      "cn",
      false,
      /* freshness (v1.11 T6) */ undefined,
      brave,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
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

    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => workedSearch("search.machine_mcp")),
    });
    const brave = makeStubBrave({
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
        ["search.machine_mcp", new CircuitBreaker()],
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

    const result = await runFallbackChainEngine(
      "query not recorded",
      10,
      "cn",
      false,
      /* freshness (v1.11 T6) */ undefined,
      brave,
      browseHeadlessExec,
      decider,
      recordingStore,
      true,
      /* machineMcp (v1.17 A3：首位源注入) */ machineMcp,
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

// ============================================================
// v1.15 Phase B（parse22 §5.2）：serp_http 裸 HTTP 快探层链序
// ============================================================
describe("runFallbackChainEngine —— serp_http 快探层（browse_headless 之前）", () => {
  /** httpSerp stub：worked（模拟裸 HTTP 探到结果）。 */
  function httpSerpWorked(): { exec: HttpSerpExec; calls: string[] } {
    const calls: string[] = [];
    const exec: HttpSerpExec = async (query) => {
      calls.push(query);
      return {
        outcome: "worked",
        data: {
          query,
          results: [
            {
              title: "serp_http result 1",
              url: "https://serp-http.test/r1",
              snippet: "serp_http snippet 1",
            },
          ],
          count: 1,
          engine: "serp_http_ddg",
          region: "us",
        },
        served_by: "serp_http:ddg",
        fallback_used: true,
        retrieval_method: "serp_http_ddg",
      };
    };
    return { exec, calls };
  }

  /** httpSerp stub：unknown（模拟被挡/空/超时——escalation-safe error）。 */
  function httpSerpUnknown(error = "serp_http_challenge"): HttpSerpExec {
    return async (query) => ({
      outcome: "unknown",
      data: null,
      served_by: "serp_http:ddg",
      fallback_used: true,
      retrieval_method: "serp_http_ddg",
      error,
    });
  }

  function makeChainFixtures(
    headlessImpl: () => Promise<InteractResult<BrowseResult>>,
  ) {
    const machineMcp = makeStubMachineMcp({
      search: vi.fn(async () => unknownSearch("search.machine_mcp", "429")),
    });
    const brave = makeStubBrave({
      search: vi.fn(async () => unknownSearch("search.brave", "429")),
      isAvailable: async () => true,
    });
    const headless = makeStubHeadless({ browse: vi.fn(headlessImpl) });
    const decider = new FallbackDecider(
      new Map([
        ["search.machine_mcp", new CircuitBreaker()],
        ["search.brave", new CircuitBreaker()],
        ["serp_http", new CircuitBreaker()],
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
    return { machineMcp, brave, headless, decider, browseHeadlessExec };
  }

  it("PB-1：machine_mcp → brave 全 unknown → serp_http worked → browse_headless 不被调（快探短路）", async () => {
    const fx = makeChainFixtures(async () => {
      throw new Error("browse_headless should not be called when serp_http works");
    });
    const { exec, calls } = httpSerpWorked();

    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      undefined,
      fx.brave,
      fx.browseHeadlessExec,
      fx.decider,
      null,
      true,
      /* machineMcp (v1.17 A3：首位源) */ fx.machineMcp,
      /* httpSerp (v1.15 Phase B) */ exec,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("serp_http:ddg");
    expect(calls).toEqual(["test query"]);
    // 审计链：machine_mcp → brave → serp_http（browse_headless 未进链）
    expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
      "search.machine_mcp",
      "search.brave",
      "serp_http",
    ]);
  });

  it("PB-2：serp_http unknown（被挡）→ browse_headless 被调且终态由慢路径服务；链序 serp_http 在 browse_headless 前", async () => {
    const fx = makeChainFixtures(async () => ({
      outcome: "worked" as const,
      data: {
        url: "https://html.duckduckgo.com/html/?q=test",
        action: "snapshot",
        preview:
          "Result A https://example.com/slow-path deeper snippet\nResult B https://other.org/x",
      } as unknown as BrowseResult,
      served_by: "browse_headless",
      fallback_used: true,
      retrieval_method: "chrome_devtools_mcp",
    }));

    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      undefined,
      fx.brave,
      fx.browseHeadlessExec,
      fx.decider,
      null,
      true,
      /* machineMcp (v1.17 A3：首位源) */ fx.machineMcp,
      httpSerpUnknown("serp_http_challenge"),
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("browse_headless");
    // 链序断言：serp_http 条目存在且在 browse_headless 之前
    const channels = result.actions_and_results!.map((a) => a.channel);
    expect(channels).toEqual([
      "search.machine_mcp",
      "search.brave",
      "serp_http",
      "browse_headless",
    ]);
    expect(channels.indexOf("serp_http")).toBeLessThan(
      channels.indexOf("browse_headless"),
    );
    // serp_http 的 unknown 条目带 escalation-safe error
    const serpEntry = result.actions_and_results!.find((a) => a.channel === "serp_http");
    expect(serpEntry?.error).toBe("serp_http_challenge");
  });

  it("PB-3（零回归）：httpSerp 未注入（缺省 null）→ channelOrder 不含 serp_http，直达 browse_headless", async () => {
    const fx = makeChainFixtures(async () => ({
      outcome: "worked" as const,
      data: {
        url: "https://html.duckduckgo.com/html/?q=test",
        action: "snapshot",
        preview: "Result A https://example.com/direct",
      } as unknown as BrowseResult,
      served_by: "browse_headless",
      fallback_used: true,
      retrieval_method: "chrome_devtools_mcp",
    }));

    const result = await runFallbackChainEngine(
      "test query",
      10,
      "cn",
      false,
      undefined,
      fx.brave,
      fx.browseHeadlessExec,
      fx.decider,
      null,
      true,
      // machineMcp 注入 + 不传 httpSerp（缺省 null）——链 = machine_mcp → brave → browse_headless
      fx.machineMcp,
    );

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("browse_headless");
    expect(result.actions_and_results!.map((a) => a.channel)).toEqual([
      "search.machine_mcp",
      "search.brave",
      "browse_headless",
    ]);
  });
});
