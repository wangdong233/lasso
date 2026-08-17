/**
 * search-freshness.spec.ts（v1.11 round1 T6 —— search 时效性过滤透传各引擎）
 *
 * 验收（round1-verdict T6）：
 *  1. cache-key 单测：同 query 不同 freshness → 不同 key；不传 freshness → 与基线
 *     byte-identical（可选参数零回归）
 *  2. 各 channel 透传各有单测：
 *     - 智谱：search_recency_filter=oneDay/oneWeek/oneMonth/oneYear；不传不出现
 *     - Brave：freshness=pd/pw/pm/py query 参数；不传不出现
 *     - （v1.15 Phase A：Bing 源 freshness=Day/Week/Month 契约测已随死层清除删除——
 *       Bing Search APIs 2025-08-11 全量退役，INV-54 墓碑守卫。）
 */
import { describe, it, expect } from "vitest";
import { SearchCache } from "../../src/search/SearchCache.js";
import {
  BRAVE_FRESHNESS_MAP,
} from "../../src/channels/BraveChannel.js";

// ============================================================
// 1. cache key：freshness 入 key（INV-11 修订）
// ============================================================
describe("T6 — SearchCache key 纳入 freshness", () => {
  const cache = new SearchCache("/tmp/lasso-t6-test-cache");

  it("同 query 不同 freshness → 不同 key", () => {
    const base = cache.computeKey("chrome-devtools-mcp", "auto", "cn", 10);
    const day = cache.computeKey("chrome-devtools-mcp", "auto", "cn", 10, "day");
    const year = cache.computeKey("chrome-devtools-mcp", "auto", "cn", 10, "year");
    expect(day).not.toBe(base);
    expect(year).not.toBe(base);
    expect(day).not.toBe(year);
  });

  it("不传 freshness → key 与基线 byte-identical（v1.10 行为零回归）", () => {
    // 与 v1.10 的 key 公式（canon|engine|region|limit）逐字节一致：
    // computeKey(q,e,r,l) === computeKey(q,e,r,l, undefined)
    const a = cache.computeKey("query", "auto", "cn", 10);
    const b = cache.computeKey("query", "auto", "cn", 10, undefined);
    expect(a).toBe(b);
  });

  it("freshness 档间互不误命中（语义验证：day ≠ week ≠ month ≠ year）", () => {
    const keys = (["day", "week", "month", "year"] as const).map((f) =>
      cache.computeKey("q", "zhipu", "cn", 5, f),
    );
    expect(new Set(keys).size).toBe(4);
  });
});

// ============================================================
// 2. 各引擎透传映射（纯映射表断言 + 契约形状）
// ============================================================
describe("T6 — 各引擎 freshness 映射", () => {
  it("Brave：day/week/month/year → pd/pw/pm/py（Brave Web Search API 契约）", () => {
    expect(BRAVE_FRESHNESS_MAP.day).toBe("pd");
    expect(BRAVE_FRESHNESS_MAP.week).toBe("pw");
    expect(BRAVE_FRESHNESS_MAP.month).toBe("pm");
    expect(BRAVE_FRESHNESS_MAP.year).toBe("py");
  });

  it("智谱：search_recency_filter 映射 oneDay/oneWeek/oneMonth/oneYear", async () => {
    const { ZHIPU_RECENCY_MAP } = await import(
      "../../src/channels/SearchChannel.js"
    );
    expect(ZHIPU_RECENCY_MAP).toEqual({
      day: "oneDay",
      week: "oneWeek",
      month: "oneMonth",
      year: "oneYear",
    });
  });
});

// ============================================================
// 3. zhipu callTool 实际透传（集成 mock）
// ============================================================
describe("T6 — 智谱 channel search_recency_filter 透传", () => {
  it("freshness=day → callTool('web_search_prime') args 含 search_recency_filter='oneDay'", async () => {
    const { ZhipuSearchChannel } = await import(
      "../../src/channels/SearchChannel.js"
    );
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      callTool: async (_name: string, args: Record<string, unknown>) => {
        calls.push(args);
        return {
          content: [
            { type: "text", text: "result" },
          ],
        };
      },
      listTools: async () => [],
      close: async () => {},
    };
    const ch = new (
      ZhipuSearchChannel as unknown as new (
        ep: string,
        key: string | undefined,
      ) => { search: typeof ZhipuSearchChannel.prototype.search; _getClient: () => Promise<unknown> }
    )("https://example.invalid/mcp", "test-key");
    // 注入 fake client（绕过真实 MCP 连接）
    (ch as unknown as { client: unknown }).client = fakeClient;
    await ch.search("query", {
      limit: 5,
      engine: "zhipu",
      region: "cn",
      no_cache: true,
      freshness: "day",
    });
    expect(calls[0]!.search_recency_filter).toBe("oneDay");
  });

  it("不传 freshness → callTool args 无 search_recency_filter 字段（byte-identical）", async () => {
    const { ZhipuSearchChannel } = await import(
      "../../src/channels/SearchChannel.js"
    );
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      callTool: async (_name: string, args: Record<string, unknown>) => {
        calls.push(args);
        return { content: [{ type: "text", text: "result" }] };
      },
      listTools: async () => [],
      close: async () => {},
    };
    const ch = new (ZhipuSearchChannel as unknown as new (
      ep: string,
      key: string | undefined,
    ) => { search: typeof ZhipuSearchChannel.prototype.search })(
      "https://example.invalid/mcp",
      "test-key",
    );
    (ch as unknown as { client: unknown }).client = fakeClient;
    await ch.search("query", {
      limit: 5,
      engine: "zhipu",
      region: "cn",
      no_cache: true,
    });
    expect("search_recency_filter" in calls[0]!).toBe(false);
  });
});
