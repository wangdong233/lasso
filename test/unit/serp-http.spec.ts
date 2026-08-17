/**
 * serp-http.spec.ts（v1.15 Phase B，parse22 §5.1 —— serp_http 裸 HTTP SERP 快探层）
 *
 * 覆盖（parse22 验收）：
 *  1. ddg 成功：200 + 含结果链接的 HTML → worked / served_by "serp_http:ddg" /
 *     data.engine "serp_http_ddg" / 请求头浏览器级（Chrome UA + Accept-Language）
 *  2. 级联：ddg 202 挑战 → brave 200 → served_by "serp_http:brave"
 *     （与 v1.14 S-4 browse 层级联同判据：非 worked 或 0 结果都落入）
 *  3. 超时（AbortError）→ unknown serp_http_timeout（且 escalation-safe）
 *  4. 403 → unknown serp_http_engine_blocked（**不得**含 "403" 字样——否则
 *     isFallbackWorthy 判 false，链终止在快探层，browse_headless 永不被调）
 *  5. CJK query → baidu 单发（S-4 红线：百度路径不动；zh Accept-Language；零级联）
 *  6. 200 但抽取 0 条 → unknown serp_http_empty（tri-state：空 ≠ 无结果，升浏览器复核）
 *  7. ddg 与 brave 双双失败 → 原样返 ddg 结果（级联前失败语义一致）
 *  8. SSRF 拒（私网解析）→ unknown serp_http_ssrf_blocked + fetch 不被调
 *  9. Cloudflare marker（"Just a moment"）→ unknown serp_http_bot_detected（复用 marker 集）
 * 10. 白名单：三引擎 serpUrlFor 输出 host ⊆ SERP_HTTP_ALLOWED_HOSTS
 * 11. escalation-safe 表驱动：全部 error 字符串 isFallbackWorthy("unknown", e) === true
 * 12. markdown 管线：[title](url) 摊平后标题干净抽取（无 [ ( 残骸）+ DDG uddg 解包复用
 * 13. SerpHealthMonitor.onResult 复用（hit/miss 计数走原链路）
 *
 * 测试策略：mock fetchImpl + mock node:dns/promises（与 fetch-url.spec.ts 同范式，
 * 让真实 ssrfGuard 跑但零网络）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// ============================================================
// DNS mock（与 fetch-url.spec.ts / ssrf-guard.spec.ts 同范式）
// ============================================================
const { dnsState } = vi.hoisted(() => ({
  dnsState: {
    ips: [] as string[],
    err: null as string | null,
  },
}));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (_host: string, _opts?: unknown) => {
    if (dnsState.err) throw new Error(dnsState.err);
    return dnsState.ips.map((address) => ({ address }));
  }),
}));

// 在 mock 之后才 import SUT（vi.mock 被 hoist）
import {
  rawSerpSearch,
  flattenMarkdownLinks,
  stripNonContentBlocks,
  dropMarkdownImages,
  SERP_HTTP_ALLOWED_HOSTS,
  type HttpSerpOptions,
} from "../../src/serp/http-serp.js";
import { serpUrlFor } from "../../src/serp/extract.js";
import { isFallbackWorthy } from "../../src/fallback/outcome.js";
import type { SerpEngine } from "../../src/serp/selectors.js";
import { SerpHealthMonitor } from "../../src/serp/SerpHealthMonitor.js";
import { SelectorRegistry } from "../../src/serp/SelectorRegistry.js";
import { HitRateStats } from "../../src/serp/HitRateStats.js";
import { ChangeDetection } from "../../src/serp/ChangeDetection.js";
import { RecordingStore } from "../../src/serp/RecordingStore.js";

// ============================================================
// helpers
// ============================================================
function setDns(ips: string[], err: string | null = null): void {
  dnsState.ips = ips;
  dnsState.err = err;
}

const PUBLIC_IPS = ["93.184.216.34"];
const PRIVATE_IPS_10 = ["10.0.0.1"];

/** 默认 config（无 allow / 无 deny）—— 私网默认拒。 */
const EMPTY_CONFIG: SsrfConfig = { allowRanges: [], denyRanges: [] };

type FetchCall = { url: string; headers: Record<string, string> };
type MockResponse = { status: number; body: string };

function makeResponse(status: number, body: string): Response {
  return { status, text: async () => body } as unknown as Response;
}

/** 按引擎 host 路由的 fetchImpl mock：ddg / brave / baidu 三路 + 全量调用记录。 */
function makeRoutedFetch(
  ddg: MockResponse,
  brave: MockResponse,
  baidu: MockResponse = makeResponse(200, "<html><body>none</body></html>"),
) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, headers });
    if (u.includes("html.duckduckgo.com")) return makeResponse(ddg.status, ddg.body);
    if (u.includes("search.brave.com")) return makeResponse(brave.status, brave.body);
    if (u.includes("www.baidu.com")) return makeResponse(baidu.status, baidu.body);
    return makeResponse(404, "");
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 合成 DDG html 端点 SERP HTML（结果链接为 uddg 跳转壳——验解包复用）。 */
function ddgHtml(): string {
  return (
    "<html><head><title>q site:example - DuckDuckGo</title></head><body>" +
    '<div class="results">' +
    '<div class="result results_links"><h2 class="result__title">' +
    '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Frust-guide&amp;rut=abc123">Rust Async Guide</a></h2>' +
    '<a class="result__snippet" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Frust-guide&amp;rut=abc123">tokio runtime deep dive snippet</a>' +
    "</div>" +
    '<div class="result results_links"><h2 class="result__title">' +
    '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fother.org%2Fasync-basics&amp;rut=def456">Async Basics Explained</a></h2>' +
    "</div>" +
    "</div></body></html>"
  );
}

/** 合成 Brave SERP HTML（SvelteKit SSR；直链）。 */
function braveHtml(): string {
  return (
    "<html><head><title>q - Brave Search</title></head><body>" +
    '<div id="results">' +
    '<div class="snippet"><div class="result-content">' +
    '<a href="https://brave-example.com/rust-tutorial">Brave Rust Tutorial</a></div>' +
    '<div class="generic-snippet">a tutorial snippet text</div></div>' +
    '<div class="snippet"><div class="result-content">' +
    '<a href="https://brave-other.net/async-io">Async IO Notes</a></div></div>' +
    "</div></body></html>"
  );
}

/** 合成百度 SERP HTML。 */
function baiduHtml(): string {
  return (
    "<html><body>" +
    '<div class="result c-container"><h3><a href="https://cn-example.com/async">异步编程指南</a></h3>' +
    '<div class="c-abstract">异步编程摘要文本</div></div>' +
    "</body></html>"
  );
}

function baseOpts(over: Partial<HttpSerpOptions> = {}): HttpSerpOptions {
  return {
    ssrfConfig: EMPTY_CONFIG,
    timeoutMs: 2_000,
    ...over,
  };
}

beforeEach(() => {
  setDns(PUBLIC_IPS);
});

// ============================================================
// 1. ddg 成功
// ============================================================
describe("Phase B — ddg 快探成功", () => {
  it("200 + 结果 HTML → worked / served_by serp_http:ddg / engine 字段诚实 / 浏览器级头", async () => {
    const { fetchImpl, calls } = makeRoutedFetch(
      { status: 200, body: ddgHtml() },
      { status: 200, body: braveHtml() },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));

    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("serp_http:ddg");
    expect(r.retrieval_method).toBe("serp_http_ddg");
    expect(r.data?.engine).toBe("serp_http_ddg");
    expect(r.data?.region).toBe("us");
    expect((r.data?.count ?? 0)).toBeGreaterThanOrEqual(1);
    // uddg 解包复用：结果 URL 是真实目标而非 duckduckgo.com 跳转壳
    expect(r.data?.results.every((x) => !x.url.includes("duckduckgo.com"))).toBe(true);
    expect(r.data?.results.some((x) => x.url === "https://example.com/rust-guide")).toBe(true);

    // 浏览器级请求头（复用 STEALTH_PROFILES 值）
    expect(calls.length).toBe(1); // ddg 成功 → 不级联
    const h = calls[0]!.headers;
    expect(h["user-agent"]).toMatch(/Mozilla\/5\.0/);
    expect(h["user-agent"]).toMatch(/Chrome\//);
    expect(h["accept-language"]).toMatch(/^en-US/);
    expect(h["sec-fetch-dest"]).toBe("document");
    // URL 复用 serpUrlFor（q= 编码 + source=web 不在 ddg 分支）
    expect(calls[0]!.url).toContain("https://html.duckduckgo.com/html/?q=rust%20async%20runtime");
  });

  it("freshness=day → ddg URL 拼 df=d（复用 serpUrlFor 既有逻辑）", async () => {
    const { fetchImpl, calls } = makeRoutedFetch(
      { status: 200, body: ddgHtml() },
      { status: 200, body: braveHtml() },
    );
    await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl, freshness: "day" }));
    expect(calls[0]!.url).toContain("&df=d");
  });
});

// ============================================================
// 2. 级联（S-4 同判据）
// ============================================================
describe("Phase B — ddg 失败 → brave 一次级联", () => {
  it("ddg 202 挑战 → brave 200 有结果 → 返 brave（served_by serp_http:brave）", async () => {
    const { fetchImpl, calls } = makeRoutedFetch(
      { status: 202, body: "anomaly challenge page" },
      { status: 200, body: braveHtml() },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));

    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("serp_http:brave");
    expect(r.retrieval_method).toBe("serp_http_brave");
    expect(r.data?.engine).toBe("serp_http_brave");
    expect(r.data?.results.some((x) => x.url === "https://brave-example.com/rust-tutorial")).toBe(true);
    expect(calls.length).toBe(2); // ddg + brave 各一次（单一 bail-out）
    expect(calls[1]!.url).toContain("https://search.brave.com/search?q=");
  });

  it("ddg 200 空（0 结果）→ 也级联 brave（判据含 worked-but-empty）", async () => {
    const { fetchImpl, calls } = makeRoutedFetch(
      { status: 200, body: "<html><body><p>no links here</p></body></html>" },
      { status: 200, body: braveHtml() },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("serp_http:brave");
    expect(calls.length).toBe(2);
  });

  it("brave 也失败 → 原样返 ddg 结果（失败语义与级联前一致）", async () => {
    const { fetchImpl } = makeRoutedFetch(
      { status: 202, body: "challenge" },
      { status: 403, body: "denied" },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.served_by).toBe("serp_http:ddg");
    expect(r.error).toBe("serp_http_challenge");
  });
});

// ============================================================
// 3-4. 超时 / 非 200 分诊（escalation-safe 命名）
// ============================================================
describe("Phase B — 失败路径 unknown + escalation-safe error", () => {
  it("超时（AbortError）→ unknown serp_http_timeout", async () => {
    const fetchImpl = (async () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      throw e;
    }) as typeof fetch;
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("serp_http_timeout");
  });

  it("网络错（ECONNREFUSED 风格）→ unknown serp_http_fetch_failed", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("serp_http_fetch_failed");
  });

  it("403 → unknown serp_http_engine_blocked（error 不含 '403'——防链终止）", async () => {
    const { fetchImpl } = makeRoutedFetch(
      { status: 403, body: "denied" },
      { status: 403, body: "denied" },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("serp_http_engine_blocked");
    expect(r.error).not.toContain("403");
    expect(r.error).not.toContain("forbidden");
  });

  it("429 → unknown serp_http_rate_limited；5xx → serp_http_upstream_error", async () => {
    const a = makeRoutedFetch({ status: 429, body: "" }, { status: 429, body: "" });
    const ra = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl: a.fetchImpl }));
    expect(ra.error).toBe("serp_http_rate_limited");

    const b = makeRoutedFetch({ status: 503, body: "" }, { status: 503, body: "" });
    const rb = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl: b.fetchImpl }));
    expect(rb.error).toBe("serp_http_upstream_error");
  });

  it("200 空 body → unknown serp_http_empty", async () => {
    const { fetchImpl } = makeRoutedFetch({ status: 200, body: "" }, { status: 200, body: "" });
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("serp_http_empty");
  });
});

// ============================================================
// 5. CJK → baidu（S-4 红线：不级联）
// ============================================================
describe("Phase B — CJK query 走百度", () => {
  it("baidu 单发：URL wd= + rn=、zh Accept-Language、零级联、region=cn", async () => {
    const { fetchImpl, calls } = makeRoutedFetch(
      { status: 200, body: ddgHtml() }, // 不应被触达
      { status: 200, body: braveHtml() }, // 不应被触达
      { status: 200, body: baiduHtml() },
    );
    const r = await rawSerpSearch("异步编程 指南", baseOpts({ fetchImpl, limit: 7 }));

    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("serp_http:baidu");
    expect(r.retrieval_method).toBe("serp_http_baidu");
    expect(r.data?.region).toBe("cn");
    expect(r.data?.results.some((x) => x.url === "https://cn-example.com/async")).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("https://www.baidu.com/s?wd=");
    expect(calls[0]!.url).toContain("&rn=7");
    expect(calls[0]!.headers["accept-language"]).toMatch(/^zh-CN/);
  });
});

// ============================================================
// 6-9. 空抽取 / SSRF / bot marker / 白名单
// ============================================================
describe("Phase B — 空抽取 / SSRF / bot marker", () => {
  it("200 + 无可抽链接 → unknown serp_http_empty（tri-state：升浏览器复核）", async () => {
    const { fetchImpl } = makeRoutedFetch(
      { status: 200, body: "<html><body><p>plain text no links</p></body></html>" },
      { status: 200, body: "<html><body><p>plain text no links</p></body></html>" },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("serp_http_empty");
  });

  it("SSRF 拒（私网解析）→ unknown serp_http_ssrf_blocked + fetch 不被调", async () => {
    setDns(PRIVATE_IPS_10);
    const { fetchImpl, calls } = makeRoutedFetch(
      { status: 200, body: ddgHtml() },
      { status: 200, body: braveHtml() },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("serp_http_ssrf_blocked");
    expect(calls.length).toBe(0);
  });

  it("Cloudflare marker（复用 CLOUDFLARE_DETECTION_REGEX）→ unknown serp_http_bot_detected", async () => {
    const challenge =
      "<html><head><title>Just a moment...</title></head><body>Checking your browser" +
      " before accessing. Ray ID: abc123</body></html>";
    const { fetchImpl } = makeRoutedFetch(
      { status: 200, body: challenge },
      { status: 200, body: challenge },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("serp_http_bot_detected");
  });
});

describe("Phase B — 引擎域名白名单", () => {
  it("三引擎 serpUrlFor 输出 host ⊆ SERP_HTTP_ALLOWED_HOSTS", () => {
    const engines: SerpEngine[] = ["baidu", "ddg", "brave"];
    for (const e of engines) {
      const url = serpUrlFor(e, "q", 10);
      expect(SERP_HTTP_ALLOWED_HOSTS).toContain(new URL(url).host);
    }
    expect(SERP_HTTP_ALLOWED_HOSTS).toEqual(
      expect.arrayContaining(["www.baidu.com", "html.duckduckgo.com", "search.brave.com"]),
    );
  });
});

// ============================================================
// 11. escalation-safe 表驱动（parse22 §1.4 关键正确性点）
// ============================================================
describe("Phase B — error 字符串全部 fallback-worthy（防链终止在快探层）", () => {
  const ALL_ERRORS = [
    "serp_http_timeout",
    "serp_http_fetch_failed",
    "serp_http_challenge",
    "serp_http_rate_limited",
    "serp_http_upstream_error",
    "serp_http_engine_blocked",
    "serp_http_empty",
    "serp_http_bot_detected",
    "serp_http_ssrf_blocked",
    "serp_http_host_not_allowed",
    "serp_http_extract_failed",
    "serp_http_redirect_blocked",
  ];
  it.each(ALL_ERRORS)("isFallbackWorthy('unknown', '%s') === true", (e) => {
    expect(isFallbackWorthy("unknown", e)).toBe(true);
  });
  it("全部 error 均不含 NOT_FALLBACK_WORTHY 子串", () => {
    const banned = ["404", "not_found", "403", "forbidden", "nxdomain", "enotfound", "needs_manual_2fa"];
    for (const e of ALL_ERRORS) {
      const lower = e.toLowerCase();
      for (const b of banned) {
        expect(lower.includes(b)).toBe(false);
      }
    }
  });
});

// ============================================================
// 12. markdown 管线：摊平 + 标题干净
// ============================================================
describe("Phase B — flattenMarkdownLinks / 标题抽取", () => {
  it("[title](url) → 'title url'（确定性归一化，非 selector）", () => {
    expect(flattenMarkdownLinks("[Rust Guide](https://example.com/a) tail")).toBe(
      "Rust Guide https://example.com/a tail",
    );
    expect(flattenMarkdownLinks("no links here")).toBe("no links here");
    expect(flattenMarkdownLinks("[a](https://x.com/1)\n\n[b](https://y.org/2)")).toBe(
      "a https://x.com/1\n\nb https://y.org/2",
    );
  });

  it("HTML → markdown → 摊平 → 复用抽取：标题无 '['/'(' 残骸", async () => {
    const { fetchImpl } = makeRoutedFetch(
      { status: 200, body: ddgHtml() },
      { status: 200, body: braveHtml() },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    const guide = r.data?.results.find((x) => x.url === "https://example.com/rust-guide");
    expect(guide).toBeDefined();
    expect(guide!.title).not.toContain("[");
    expect(guide!.title).toContain("Rust Async Guide");
  });
});

// ============================================================
// 12b. verify 真机回归（2026-08-17）：噪声块剥除 —— style/script/font-face/图片
// ============================================================
// 真机证据：search.brave.com 实抓 246KB HTML，内联 <style> 含十余条
// @font-face{src:url(https://cdn…woff2)}——修复前 20 条「结果」全是字体 CSS
// 垃圾、0 条真实结果（伪造成功）。本组测试用真机形态 fixture 钉死不回潮。
describe("Phase B verify — 噪声块剥除（style/script/图片语法）", () => {
  /** 真机形态 brave HTML：内联 style（@font-face 字体 URL）+ script + 图片 + 真实结果。 */
  function braveNoisyHtml(): string {
    return (
      "<html><head>" +
      "<style>@font-face{font-family:Inter Variable;font-style:normal;font-display:swap;" +
      'src:url(https://cdn.search.brave.com/serp/v3/_app/immutable/assets/inter-latin-wght-normal.ABC123.woff2) format("woff2")}</style>\n' +
      "<style>.theme{color:red}</style>" +
      "<script>window.__data={json:true};</script>" +
      "<noscript>enable javascript</noscript>" +
      "</head><body>" +
      '<img src="https://imgs.search.brave.com/THUMB123/rs:fit:32:32:1:0/g:ce/aHR6" alt="favicon"/>' +
      '<div id="results"><div class="snippet"><div class="result-content">' +
      '<a href="https://tokio.rs/tokio/tutorial">Tutorial | Tokio - An asynchronous Rust runtime</a></div>' +
      '<div class="generic-snippet">Welcome to the tokio tutorial</div></div>' +
      '<div class="snippet"><div class="result-content">' +
      '<a href="https://medium.com/@x/practical-guide-99e818c11965">Practical Guide to Async Rust and Tokio</a></div></div>' +
      "</div></body></html>"
    );
  }

  it("stripNonContentBlocks：<style>/<script>/<noscript> 整块删除（含字体 URL）", () => {
    const out = stripNonContentBlocks(braveNoisyHtml());
    expect(out).not.toContain("Inter Variable");
    expect(out).not.toContain("woff2");
    expect(out).not.toContain("__data");
    expect(out).not.toContain("enable javascript");
    expect(out).toContain("tokio.rs/tokio/tutorial");
  });

  it("dropMarkdownImages：![alt](url) 整体删除", () => {
    expect(dropMarkdownImages("x ![fav](https://imgs.example/t.png) y")).toBe(
      "x   y",
    );
    expect(dropMarkdownImages("no images [link](https://a.com/1)")).toBe(
      "no images [link](https://a.com/1)",
    );
  });

  it("真机形态 brave HTML：字体 URL / 缩略图 URL 不进结果，真实结果干净", async () => {
    const { fetchImpl } = makeRoutedFetch(
      { status: 202, body: "anomaly challenge" }, // ddg 挑战 → 级联 brave
      { status: 200, body: braveNoisyHtml() },
    );
    const r = await rawSerpSearch("rust tokio tutorial", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("serp_http:brave");
    const urls = (r.data?.results ?? []).map((x) => x.url);
    // 字体 / 缩略图 / style 内 URL 一概不得收割
    expect(urls.some((u) => u.includes("cdn.search.brave.com"))).toBe(false);
    expect(urls.some((u) => u.includes("imgs.search.brave.com"))).toBe(false);
    // 真实结果在
    const tut = r.data?.results.find((x) => x.url === "https://tokio.rs/tokio/tutorial");
    expect(tut).toBeDefined();
    expect(tut!.title).toContain("Tokio");
    expect(tut!.title).not.toContain("[");
    expect(tut!.title).not.toContain("!(");
  });
});

// ============================================================
// 12c. verify 真机回归（2026-08-17）：软挡检测 —— 重定向偏离 SERP 路径
// ============================================================
// 真机证据：百度对无 cookie 裸 HTTP 302 → wappass.baidu.com 图形验证码 /
// 或退回首页壳（200 + 导航链接被抽成 17 条垃圾、伪造 worked）。
// 修法：终态 URL host/path 与请求 SERP URL 不一致 → unknown 升浏览器。
function makeResponseWithUrl(status: number, body: string, url: string): Response {
  return { status, text: async () => body, url } as unknown as Response;
}

describe("Phase B verify — 软挡检测（redirect 偏离 SERP 路径）", () => {
  it("baidu 302 → wappass 验证码域（host 变）→ unknown serp_http_redirect_blocked", async () => {
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) =>
      makeResponseWithUrl(
        200,
        baiduHtml(), // 验证码页即使带可抽链接也不得伪造成功
        "https://wappass.baidu.com/static/captcha/tuxing_v2.html?backurl=x",
      )) as typeof fetch;
    const r = await rawSerpSearch("异步编程指南", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("serp_http_redirect_blocked");
    expect(isFallbackWorthy("unknown", r.error!)).toBe(true);
  });

  it("baidu 退回首页壳（host 同、path /≠/s）→ unknown serp_http_redirect_blocked", async () => {
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) =>
      makeResponseWithUrl(200, baiduHtml(), "https://www.baidu.com/")) as typeof fetch;
    const r = await rawSerpSearch("异步编程指南", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("serp_http_redirect_blocked");
  });

  it("同 host 同 path 的合法重定向（http→https 等）→ 不误拦，正常抽取", async () => {
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) =>
      makeResponseWithUrl(200, ddgHtml(), "https://html.duckduckgo.com/html/?q=rust+async")) as typeof fetch;
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("serp_http:ddg");
  });

  it("mock Response 无 url 字段（缺省 global fetch 形状）→ 跳过该项检查不炸", async () => {
    const { fetchImpl } = makeRoutedFetch(
      { status: 200, body: ddgHtml() },
      { status: 200, body: braveHtml() },
    );
    const r = await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl }));
    expect(r.outcome).toBe("worked");
  });
});

// ============================================================
// 13. SerpHealthMonitor 复用（改版检测链路原样接入）
// ============================================================
describe("Phase B — SerpHealthMonitor.onResult 复用", () => {
  function makeMonitor(): SerpHealthMonitor {
    const tmpDir = `/tmp/lasso-pb-serp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new SerpHealthMonitor(
      new SelectorRegistry(),
      new HitRateStats(),
      new ChangeDetection(tmpDir),
      new RecordingStore(tmpDir),
    );
  }

  it("ddg 成功 → onResult('ddg', hit=true)；被挡级联 → ddg miss + brave hit", async () => {
    const m = makeMonitor();
    const spy = vi.spyOn(m, "onResult");

    const ok = makeRoutedFetch({ status: 200, body: ddgHtml() }, { status: 200, body: braveHtml() });
    await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl: ok.fetchImpl, serpHealth: m }));
    const ddgHit = spy.mock.calls.find((c) => c[0] === "ddg");
    expect(ddgHit).toBeDefined();
    expect(ddgHit![4]).toBe(true);

    spy.mockClear();
    const cascade = makeRoutedFetch({ status: 202, body: "challenge" }, { status: 200, body: braveHtml() });
    await rawSerpSearch("rust async runtime", baseOpts({ fetchImpl: cascade.fetchImpl, serpHealth: m }));
    const ddgMiss = spy.mock.calls.find((c) => c[0] === "ddg");
    expect(ddgMiss).toBeDefined();
    expect(ddgMiss![4]).toBe(false);
    const braveHit = spy.mock.calls.find((c) => c[0] === "brave");
    expect(braveHit).toBeDefined();
    expect(braveHit![4]).toBe(true);
  });
});
