/**
 * BraveChannel 单元测（parse2 §5.1 / 验收 #2 + #3 + #4）。
 *
 * 用 vi.fn() mock fetch，覆盖：
 *  - 200 + 非空 web.results → worked + 解析正确（title/url/snippet/source）
 *  - 200 + 空 results → unknown（10 §D.1 关键信号）
 *  - 202 + 空 body → unknown（验收 #3 DDG-like）
 *  - 429 + Retry-After header → unknown + markExhausted 调用 + 切下一个 Key
 *  - 429 无 Retry-After → fallback 60s
 *  - 5xx → unknown（transient）
 *  - 4xx（403）→ didnt
 *  - timeout / network error → unknown（catch 兜底）
 *  - count > 20 截断（query param 不会传 >20）
 *  - Key 池：单 Key 用完 / 多 Key 轮换
 *  - X-Subscription-Token header 正确
 *  - 全 Key exhausted → search() 返 unknown + 错误标识
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BraveChannel,
  parseBraveResults,
  type BraveHttpClient,
} from "../../src/channels/BraveChannel.js";
import { QuotaLedger } from "../../src/config/quota-ledger.js";

// ============================================================
// fixture：Brave 响应形状（parse2 §4.1）
// ============================================================
function braveResponse(
  results: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    web: { results },
    query: { original: "test" },
  };
}

const NONEMPTY = braveResponse([
  {
    title: "Rust programming",
    url: "https://www.rust-lang.org/",
    description: "A language empowering everyone to build reliable software.",
    profile: { name: "rust-lang.org" },
  },
  {
    title: "Async Rust",
    url: "https://tokio.rs/",
    description: "Tokio async runtime",
    // 无 profile（验证 source undefined）
  },
]);

const EMPTY_RESULTS = braveResponse([]);

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

function makeClient(fetchImpl: ReturnType<typeof vi.fn>): BraveHttpClient {
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
// BraveChannel.search — happy path
// ============================================================
describe("BraveChannel.search — 200 非空 → worked", () => {
  it("非空 web.results → outcome=worked + 解析正确", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("brave", ["k1"], 2000, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("rust", { limit: 10, region: "US", no_cache: false });
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("search.brave");
    expect(r.retrieval_method).toBe("brave_api");
    expect(r.data).not.toBeNull();
    expect(r.data!.results).toHaveLength(2);
    expect(r.data!.results[0]).toEqual({
      title: "Rust programming",
      url: "https://www.rust-lang.org/",
      snippet: "A language empowering everyone to build reliable software.",
      source: "rust-lang.org",
    });
    expect(r.data!.results[1].source).toBeUndefined();
    expect(r.data!.engine).toBe("brave");
    expect(r.data!.region).toBe("US");
    expect(r.data!.count).toBe(2);
  });

  it("成功后扣减 ledger 余量（验收 #2）", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("brave", ["k1"], 2000, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("rust", { limit: 5, region: "US", no_cache: false });
    expect(ledger.totalRemaining()).toBe(1999);
  });

  it("X-Subscription-Token header 正确（query 选中的 Key）", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("brave", ["my-secret-key"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("x", { limit: 5, region: "US", no_cache: false });
    const callArgs = fetchMock.mock.calls[0];
    const init = callArgs[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("my-secret-key");
    expect(headers.Accept).toBe("application/json");
  });

  it("count 截断 20（Brave max，query param count ≤ 20）", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("brave", ["k1"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("x", { limit: 50, region: "US", no_cache: false });
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("count")).toBe("20"); // 50 → 截断 20
  });

  it("query / region 正确写入 URL params", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("brave", ["k1"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("hello world", { limit: 5, region: "CN", no_cache: false });
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("q")).toBe("hello world");
    expect(url.searchParams.get("country")).toBe("CN");
  });
});

// ============================================================
// BraveChannel.search — 错误 / outcome 分类
// ============================================================
describe("BraveChannel.search — outcome 分类（10 §D.1 + 验收 #3）", () => {
  it("200 空 results → outcome=unknown（10 §D.1 关键信号）", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: EMPTY_RESULTS }));
    const ledger = new QuotaLedger("brave", ["k1"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("nothing", {
      limit: 5,
      region: "US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.data).toBeNull();
    // 200-but-empty 不扣减配额（recordSuccess 只在 worked 调）
    expect(ledger.totalRemaining()).toBe(100);
  });

  it("202 + 空 body → outcome=unknown（验收 #3，DDG-like）", async () => {
    fetchMock.mockResolvedValue(makeResponse({ status: 202, body: null }));
    const ledger = new QuotaLedger("brave", ["k1"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("accepted-empty", {
      limit: 5,
      region: "US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
  });

  it("500 → outcome=unknown（transient）", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ status: 500, body: { error: "server" } }),
    );
    const ledger = new QuotaLedger("brave", ["k1"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("5xx-test", {
      limit: 5,
      region: "US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
  });

  it("403 → outcome=didnt（definitive negative）", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ status: 403, body: { error: "forbidden" } }),
    );
    const ledger = new QuotaLedger("brave", ["k1"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("403-test", {
      limit: 5,
      region: "US",
      no_cache: false,
    });
    expect(r.outcome).toBe("didnt");
  });

  it("fetch reject（network/timeout）→ outcome=unknown + error", async () => {
    fetchMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const ledger = new QuotaLedger("brave", ["k1"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("net-err", {
      limit: 5,
      region: "US",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("ETIMEDOUT");
  });
});

// ============================================================
// BraveChannel.search — 429 / Key 池轮换
// ============================================================
describe("BraveChannel.search — 429 + Key 池（验收 #2 + #4）", () => {
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
    const ledger = new QuotaLedger("brave", ["k1", "k2"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    // 第 1 次：k1（贪心选余量最多，初始都 100，选 k1）→ 429
    const r1 = await ch.search("q", { limit: 5, region: "US", no_cache: false });
    expect(r1.outcome).toBe("unknown");
    // k1 应被 markExhausted，pickKey 现在返 k2
    expect(ledger.pickKey()).toBe("k2");
    // 第 2 次：用 k2 → 200 成功
    const r2 = await ch.search("q", { limit: 5, region: "US", no_cache: false });
    expect(r2.outcome).toBe("worked");
    const init2 = fetchMock.mock.calls[1][1] as RequestInit;
    expect((init2.headers as Record<string, string>)["X-Subscription-Token"]).toBe("k2");
  });

  it("429 无 Retry-After → fallback 60s 短期禁用", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 429, body: null }));
    const ledger = new QuotaLedger("brave", ["only-key"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("q", { limit: 5, region: "US", no_cache: false });
    expect(r.outcome).toBe("unknown");
    // 单 Key + 429 → 该 Key 短期 block → hasAvailableKey=false
    expect(ledger.hasAvailableKey()).toBe(false);
    // snapshot.resetAt 应 ≥ now+59s（60s fallback，留 1s 缓冲）
    const snap = ledger.snapshot()[0];
    expect(snap.resetAt).toBeGreaterThan(Date.now() + 59_000);
  });

  it("全 Key exhausted（429 都中）→ search() 返 unknown + 错误标识", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY })); // 不会触到（isAvailable 先返 false）
    const ledger = new QuotaLedger("brave", ["k1", "k2"], 100, "monthly");
    // 把两个 Key 都短期 block
    ledger.markExhausted("k1", Date.now() + 60_000);
    ledger.markExhausted("k2", Date.now() + 60_000);
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const r = await ch.search("q", { limit: 5, region: "US", no_cache: false });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("brave_keys_exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Key 池贪心轮换：pickKey 选余量最多的", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("brave", ["a", "b"], 100, "monthly");
    // a 已用 50（剩 50），b 全 100
    ledger.recordSuccess("a", 50);
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    await ch.search("q", { limit: 5, region: "US", no_cache: false });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    // 应选 b（余量更多）
    expect((init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("b");
  });
});

// ============================================================
// BraveChannel.isAvailable / status / healthCheck
// ============================================================
describe("BraveChannel.isAvailable / status / healthCheck", () => {
  it("endpoint 非 https → isAvailable=false", async () => {
    const ledger = new QuotaLedger("brave", ["k"], 100, "monthly");
    const ch = new BraveChannel("http://insecure/", ledger, makeClient(fetchMock));
    expect(await ch.isAvailable()).toBe(false);
  });

  it("ledger 无 Key → isAvailable=false", async () => {
    const ledger = new QuotaLedger("brave", [], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    expect(await ch.isAvailable()).toBe(false);
  });

  it("status() 探活 200 → available=true + latency_ms", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("brave", ["k"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const s = await ch.status();
    expect(s.available).toBe(true);
    expect(s.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("status() 全 Key exhausted → available=false", async () => {
    const ledger = new QuotaLedger("brave", ["k"], 100, "monthly");
    ledger.markExhausted("k", Date.now() + 60_000);
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    const s = await ch.status();
    expect(s.available).toBe(false);
  });

  it("healthCheck() 200 响应 → healthy", async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: NONEMPTY }));
    const ledger = new QuotaLedger("brave", ["k"], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    expect(await ch.healthCheck()).toBe("healthy");
  });

  it("healthCheck() 无 Key → down", async () => {
    const ledger = new QuotaLedger("brave", [], 100, "monthly");
    const ch = new BraveChannel(
      "https://api.search.brave.com/res/v1/web/search",
      ledger,
      makeClient(fetchMock),
    );
    expect(await ch.healthCheck()).toBe("down");
  });
});

// ============================================================
// parseBraveResults — 单独测（覆盖 V2 风险：形状兼容性）
// ============================================================
describe("parseBraveResults — 形状兼容（V2 风险）", () => {
  it("标准形状：web.results[].{title,url,description,profile.name}", () => {
    const r = parseBraveResults(NONEMPTY);
    expect(r).toHaveLength(2);
    expect(r[0].title).toBe("Rust programming");
    expect(r[0].source).toBe("rust-lang.org");
  });

  it("description 缺失 → 退化到 snippet", () => {
    const r = parseBraveResults({
      web: { results: [{ title: "T", url: "https://x.test", snippet: "from snippet" }] },
    });
    expect(r[0].snippet).toBe("from snippet");
  });

  it("url 缺失的条目被过滤（不健康的 result）", () => {
    const r = parseBraveResults({
      web: {
        results: [
          { title: "ok", url: "https://ok.test" },
          { title: "no-url" }, // 无 url，过滤掉
        ],
      },
    });
    expect(r).toHaveLength(1);
    expect(r[0].url).toBe("https://ok.test");
  });

  it("web 字段缺失 → 返空数组", () => {
    expect(parseBraveResults({})).toEqual([]);
    expect(parseBraveResults(null)).toEqual([]);
    expect(parseBraveResults({ web: {} })).toEqual([]);
    expect(parseBraveResults({ web: { results: "not-array" } })).toEqual([]);
  });
});
