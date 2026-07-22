/**
 * BingChannel 单元测（parse10 §3.1 + §5.1 v0.9 Phase A）。
 *
 * 守护要点（parse10 §3.1 + INV-54 + §1 决策 6）：
 *  1. REST 范式与 BraveChannel 同构（Ocp-Apim-Subscription-Key header + webPages.value 解析）
 *  2. key=[] 时构造不抛，isAvailable=false（Azure F0 不强依赖；零回归）
 *  3. 429 感知 markExhausted + 全 Key exhausted → unknown
 *  4. outcome 分类（200 非空=worked / 200 空=unknown / 4xx=didnt / 5xx=unknown / net=unknown）
 *  5. INV-54：必经 QuotaLedger.pickKey + markExhausted（禁直读 process.env.BING_API_KEYS）
 *  6. count 截断 50（Bing max）
 *  7. webPages.value 形状解析（name / url / snippet + 从 url 推 host 作 source）
 *
 * 测试策略：与 brave-channel.spec.ts 同范式（vi.fn() mock fetch + QuotaLedger 注入）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BingChannel,
  parseBingResults,
  type BingHttpClient,
} from "../../src/channels/BingChannel.js";
import { QuotaLedger } from "../../src/config/quota-ledger.js";

// ============================================================
// fixture：Bing Web Search API v7 响应形状（parse10 §3.1）
// ============================================================
function bingResponse(
  value: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    _type: "SearchResponse",
    webPages: {
      webSearchUrl: "https://www.bing.com/search",
      totalEstimatedMatches: value.length,
      value,
    },
  };
}

const NONEMPTY = bingResponse([
  {
    id: "https://api.bing.microsoft.com/api/v7/#WebPages.0",
    name: "Rust programming language",
    url: "https://www.rust-lang.org/",
    isFamilyFriendly: true,
    displayUrl: "https://www.rust-lang.org",
    snippet: "A language empowering everyone to build reliable software.",
    dateLastCrawled: "2024-01-01T00:00:00Z",
    language: "en",
  },
  {
    id: "https://api.bing.microsoft.com/api/v7/#WebPages.1",
    name: "Tokio Async Runtime",
    url: "https://tokio.rs/",
    snippet: "Tokio async runtime for Rust.",
    // 无 displayUrl / 无 dateLastCrawled（验证兼容性）
  },
]);

const EMPTY_VALUE = bingResponse([]);

// ============================================================
// mock fetch 工厂
// ============================================================
function makeResponse(opts: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  const status = opts.status ?? 200;
  const body = opts.body === undefined ? null : opts.body;
  const headers = new Headers(opts.headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

function makeClient(fetchImpl: ReturnType<typeof vi.fn>): BingHttpClient {
  return { fetch: fetchImpl as unknown as typeof fetch };
}

// ============================================================
// setup
// ============================================================
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
});

// ============================================================
// BingChannel.search — happy path
// ============================================================
describe("BingChannel.search — 200 非空 → worked", () => {
  it("非空 webPages.value → outcome=worked + 解析正确（INV-54 经 ledger）", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("bing", ["k1"], 1000, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("rust", {
      limit: 10,
      market: "en-US",
      no_cache: false,
    });
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("search.bing");
    expect(r.retrieval_method).toBe("bing_api");
    expect(r.data).not.toBeNull();
    expect(r.data!.results).toHaveLength(2);
    expect(r.data!.results[0]).toEqual({
      title: "Rust programming language",
      url: "https://www.rust-lang.org/",
      snippet: "A language empowering everyone to build reliable software.",
      source: "www.rust-lang.org", // 从 url 推 host（Bing 无 profile.name）
    });
    expect(r.data!.results[1].source).toBe("tokio.rs");
    expect(r.data!.engine).toBe("bing");
    expect(r.data!.region).toBe("en-US");
    expect(r.data!.count).toBe(2);
  });

  it("成功后扣减 ledger 余量", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("bing", ["k1"], 1000, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("rust", { limit: 5, market: "en-US", no_cache: false });
    expect(ledger.totalRemaining()).toBe(999);
  });

  it("Ocp-Apim-Subscription-Key header 正确（query 选中的 Key）", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("bing", ["my-azure-key"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("x", { limit: 5, market: "en-US", no_cache: false });
    const callArgs = fetchMock.mock.calls[0];
    const init = callArgs[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // 关键 INV-54 范式：Bing v7 用 Ocp-Apim-Subscription-Key header，不是 Bearer
    expect(headers["Ocp-Apim-Subscription-Key"]).toBe("my-azure-key");
    expect(headers.Accept).toBe("application/json");
  });

  it("count 截断 50（Bing max，query param count ≤ 50）", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("bing", ["k1"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("x", { limit: 100, market: "en-US", no_cache: false });
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("count")).toBe("50"); // 100 → 截断 50
  });

  it("query / mkt / safeSearch 写入 URL params", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("bing", ["k1"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("hello world", {
      limit: 5,
      market: "zh-CN",
      no_cache: false,
    });
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("q")).toBe("hello world");
    expect(url.searchParams.get("mkt")).toBe("zh-CN");
    expect(url.searchParams.get("safeSearch")).toBe("Moderate");
  });
});

// ============================================================
// BingChannel.search — outcome 分类（10 §D.1 + parse10 §3.1）
// ============================================================
describe("BingChannel.search — outcome 分类", () => {
  it("200 空 value → outcome=unknown（10 §D.1 关键信号）", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: EMPTY_VALUE }));
    const ledger = new QuotaLedger("bing", ["k1"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("nothing", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.data).toBeNull();
    // 200-but-empty 不扣配额（recordSuccess 只在 worked 调）
    expect(ledger.totalRemaining()).toBe(100);
  });

  it("202 + 空 body → outcome=unknown", async () => {
    fetchMock.mockResolvedValue(makeResponse({ status: 202, body: null }));
    const ledger = new QuotaLedger("bing", ["k1"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("accepted-empty", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
  });

  it("500 → outcome=unknown（transient）", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ status: 500, body: { error: "server" } }),
    );
    const ledger = new QuotaLedger("bing", ["k1"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("5xx-test", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
  });

  it("404 → outcome=didnt（definitive negative）", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ status: 404, body: { error: "not found" } }),
    );
    const ledger = new QuotaLedger("bing", ["k1"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("404-test", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r.outcome).toBe("didnt");
  });

  it("fetch reject（network/timeout）→ outcome=unknown + error", async () => {
    fetchMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const ledger = new QuotaLedger("bing", ["k1"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("net-err", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("ETIMEDOUT");
  });
});

// ============================================================
// BingChannel.search — 429 / Key 池轮换（INV-54）
// ============================================================
describe("BingChannel.search — 429 + Key 池（INV-54）", () => {
  it("429 + Retry-After:5 → markExhausted 调用 + 下次切 Key", async () => {
    fetchMock
      // 第 1 次：429 with Retry-After:5
      .mockResolvedValueOnce(
        makeResponse({
          status: 429,
          body: null,
          headers: { "retry-after": "5" },
        }),
      )
      // 第 2 次：另一 Key 200 成功
      .mockResolvedValueOnce(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("bing", ["k1", "k2"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    // 第 1 次：k1 → 429
    const r1 = await ch.search("q", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r1.outcome).toBe("unknown");
    // k1 应被 markExhausted，pickKey 现在返 k2
    expect(ledger.pickKey()).toBe("k2");
    // 第 2 次：用 k2 → 200 成功
    const r2 = await ch.search("q", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r2.outcome).toBe("worked");
    const init2 = fetchMock.mock.calls[1][1] as RequestInit;
    expect((init2.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe(
      "k2",
    );
  });

  it("429 无 Retry-After → fallback 60s 短期禁用", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 429, body: null }));
    const ledger = new QuotaLedger("bing", ["only-key"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("q", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    // 单 Key + 429 → 该 Key 短期 block → hasAvailableKey=false
    expect(ledger.hasAvailableKey()).toBe(false);
    // snapshot.resetAt 应 ≥ now+59s（60s fallback，留 1s 缓冲）
    const snap = ledger.snapshot()[0];
    expect(snap.resetAt).toBeGreaterThan(Date.now() + 59_000);
  });

  it("全 Key exhausted（429 都中）→ search() 返 unknown + 错误标识", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY })); // 不会触到（isAvailable 先返 false）
    const ledger = new QuotaLedger("bing", ["k1", "k2"], 100, "monthly");
    // 把两个 Key 都短期 block
    ledger.markExhausted("k1", Date.now() + 60_000);
    ledger.markExhausted("k2", Date.now() + 60_000);
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("q", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("bing_keys_exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Key 池贪心轮换：pickKey 选余量最多的", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("bing", ["a", "b"], 100, "monthly");
    // a 已用 50（剩 50），b 全 100
    ledger.recordSuccess("a", 50);
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("q", { limit: 5, market: "en-US", no_cache: false });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    // 应选 b（余量更多）
    expect((init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe(
      "b",
    );
  });
});

// ============================================================
// BingChannel — key=[] 容忍（parse10 §1 决策 6 + §3.1 INV-54）
// ============================================================
describe("BingChannel — key=[] 容忍（parse10 §1 决策 6）", () => {
  it("key=[] 时构造不抛（QuotaLedger 容忍空 keys 数组）", () => {
    expect(() => {
      const ledger = new QuotaLedger("bing", [], 1000, "monthly");
      return new BingChannel(
        "https://api.bing.microsoft.com/v7.0/search",
        ledger,
        makeClient(fetchMock),
      );
    }).not.toThrow();
  });

  it("key=[] → isAvailable=false（Azure F0 不强依赖；零回归）", async () => {
    const ledger = new QuotaLedger("bing", [], 1000, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    expect(await ch.isAvailable()).toBe(false);
  });

  it("key=[] → search() 返 unknown + bing_keys_exhausted + fetch 不被调", async () => {
    const ledger = new QuotaLedger("bing", [], 1000, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("q", {
      limit: 5,
      market: "en-US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("bing_keys_exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// BingChannel.isAvailable / status / healthCheck
// ============================================================
describe("BingChannel.isAvailable / status / healthCheck", () => {
  it("endpoint 非 https → isAvailable=false", async () => {
    const ledger = new QuotaLedger("bing", ["k"], 100, "monthly");
    const ch = new BingChannel("http://insecure/", ledger, makeClient(fetchMock));
    expect(await ch.isAvailable()).toBe(false);
  });

  it("status() 探活 200 → available=true + latency_ms", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("bing", ["k"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const s = await ch.status();
    expect(s.available).toBe(true);
    expect(s.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("status() 全 Key exhausted → available=false", async () => {
    const ledger = new QuotaLedger("bing", ["k"], 100, "monthly");
    ledger.markExhausted("k", Date.now() + 60_000);
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    const s = await ch.status();
    expect(s.available).toBe(false);
  });

  it("healthCheck() 200 响应 → healthy", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("bing", ["k"], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    expect(await ch.healthCheck()).toBe("healthy");
  });

  it("healthCheck() 无 Key → down", async () => {
    const ledger = new QuotaLedger("bing", [], 100, "monthly");
    const ch = new BingChannel(
      "https://api.bing.microsoft.com/v7.0/search",
      ledger,
      makeClient(fetchMock),
    );
    expect(await ch.healthCheck()).toBe("down");
  });
});

// ============================================================
// parseBingResults — 单独测（覆盖 V2 风险：形状兼容性）
// ============================================================
describe("parseBingResults — 形状兼容（V2 风险）", () => {
  it("标准形状：webPages.value[].{name,url,snippet}", () => {
    const r = parseBingResults(NONEMPTY);
    expect(r).toHaveLength(2);
    expect(r[0].title).toBe("Rust programming language"); // name → title
    expect(r[0].source).toBe("www.rust-lang.org"); // url host → source
  });

  it("name 缺失 → 退化到 title（兼容兜底）", () => {
    const r = parseBingResults({
      webPages: {
        value: [{ title: "From Title", url: "https://x.test" }],
      },
    });
    expect(r[0].title).toBe("From Title");
  });

  it("snippet 缺失 → 退化到 description", () => {
    const r = parseBingResults({
      webPages: {
        value: [{ name: "T", url: "https://x.test", description: "from desc" }],
      },
    });
    expect(r[0].snippet).toBe("from desc");
  });

  it("url 缺失的条目被过滤（不健康的 result）", () => {
    const r = parseBingResults({
      webPages: {
        value: [
          { name: "ok", url: "https://ok.test" },
          { name: "no-url" }, // 无 url，过滤掉
        ],
      },
    });
    expect(r).toHaveLength(1);
    expect(r[0].url).toBe("https://ok.test");
  });

  it("webPages 字段缺失 → 返空数组", () => {
    expect(parseBingResults({})).toEqual([]);
    expect(parseBingResults(null)).toEqual([]);
    expect(parseBingResults({ webPages: {} })).toEqual([]);
    expect(parseBingResults({ webPages: { value: "not-array" } })).toEqual([]);
  });

  it("url 非 legal（解析失败）→ source undefined 但条目仍返（不抛错）", () => {
    const r = parseBingResults({
      webPages: {
        value: [{ name: "bad", url: "not-a-url", snippet: "s" }],
      },
    });
    // url="not-a-url" 不被 filter 掉（truthy 字符串）但 host 解析失败 → source undefined
    expect(r).toHaveLength(1);
    expect(r[0].source).toBeUndefined();
  });
});
