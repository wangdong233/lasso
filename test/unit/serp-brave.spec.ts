/**
 * serp-brave.spec.ts（v1.14，21-搜索方案重审 S-4 —— 非 CJK 兜底第二引擎 brave_serp）
 *
 * 覆盖（S-4 验收）：
 *  1. URL 构造：serpUrlFor("brave") → search.brave.com/search?q=<enc>&source=web；
 *     freshness 无原生参数不拼（诚实降级，同 baidu 先例 round2 T2-5）
 *  2. 级联：ddg 失败（202 挑战页→unknown / didnt）→ brave 成功 → 返 brave 结果
 *     （retrieval_method=serp_scrape_brave / engine=brave_serp / region=us）
 *  3. 级联判据含「worked 但 0 结果」（ddg 200 空 → 也级联）
 *  4. 两者皆败 → 原样返回 ddg 结果（失败语义与级联前完全一致）
 *  5. ddg 成功 → 不级联（默认行为 byte-identical，单次 browseExec 调用）
 *  6. CJK 路径（百度）不级联（红线：百度不动）
 *  7. SELF_HOST_RE 排除 search.brave.com 自家链
 *  8. SerpHealthMonitor 记 engine="brave"（SerpEngine 类型扩容零改动 INV-45）
 *  9. selectorsFor("brave") → BRAVE_SERP_SELECTORS（open-webSearch 同款锚点占位）
 */
import { describe, it, expect, vi } from "vitest";
import {
  serpScrapeFallback,
  serpUrlFor,
  extractResultsFromSnapshot,
  type BrowseExec,
} from "../../src/serp/extract.js";
import {
  selectorsFor,
  BRAVE_SERP_SELECTORS,
  type SerpEngine,
} from "../../src/serp/selectors.js";
import { SerpHealthMonitor } from "../../src/serp/SerpHealthMonitor.js";
import { SelectorRegistry } from "../../src/serp/SelectorRegistry.js";
import { HitRateStats } from "../../src/serp/HitRateStats.js";
import { ChangeDetection } from "../../src/serp/ChangeDetection.js";
import { RecordingStore } from "../../src/serp/RecordingStore.js";
import type { Outcome } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
type ExecCall = { url: string };
type ExecResult = { outcome: Outcome; preview?: string; error?: string };

/** 按 URL 路由的 browseExec mock：ddg URL → ddgResult；brave URL → braveResult；其余 → other。 */
function makeRoutedExec(
  ddgResult: ExecResult,
  braveResult: ExecResult,
  other: ExecResult = { outcome: "didnt" },
) {
  const calls: ExecCall[] = [];
  const exec: BrowseExec = async (url) => {
    calls.push({ url });
    if (url.includes("duckduckgo.com")) {
      return {
        outcome: ddgResult.outcome,
        data: ddgResult.preview !== undefined ? { preview: ddgResult.preview } : null,
        error: ddgResult.error,
      };
    }
    if (url.includes("search.brave.com")) {
      return {
        outcome: braveResult.outcome,
        data: braveResult.preview !== undefined ? { preview: braveResult.preview } : null,
        error: braveResult.error,
      };
    }
    return {
      outcome: other.outcome,
      data: other.preview !== undefined ? { preview: other.preview } : null,
      error: other.error,
    };
  };
  return { exec, calls };
}

/** 合成 DDG 202 挑战页 a11y 快照（无结果链接）。 */
const DDG_CHALLENGE_PREVIEW = [
  "DuckDuckGo",
  "If this persists, please let us know: anomaly@duckduckgo.com",
  "challenge verifying you are a human",
].join("\n");

/** 合成 search.brave.com SERP a11y 快照（SvelteKit SSR 结果）。 */
function braveSnapshotText(): string {
  return [
    "Brave Search",
    "rust async runtime guide",
    "https://doc.rust-lang.org/async-book/",
    "Async Book — official guide for async Rust",
    "https://tokio.rs/tutorials",
    "Tokio tutorials — async runtime",
    "https://search.brave.com/search?q=rust", // 自家链（应被排除）
  ].join("\n");
}

// ============================================================
// 1. URL 构造
// ============================================================
describe("S-4 — serpUrlFor brave 分支", () => {
  it("构造 search.brave.com/search?q=<enc>&source=web", () => {
    expect(serpUrlFor("brave", "rust async", 10)).toBe(
      "https://search.brave.com/search?q=rust%20async&source=web",
    );
  });

  it("freshness 无原生参数不拼（诚实降级，同 baidu 先例）", () => {
    expect(serpUrlFor("brave", "q", 10, "day")).toBe(
      serpUrlFor("brave", "q", 10),
    );
  });
});

// ============================================================
// 2-5. 非 CJK 级联
// ============================================================
describe("S-4 — serpScrapeFallback 非 CJK 级联", () => {
  it("ddg 202 挑战页（unknown）→ brave 成功 → 返 brave 结果 + 双引擎调用序", async () => {
    const { exec, calls } = makeRoutedExec(
      { outcome: "worked", preview: DDG_CHALLENGE_PREVIEW }, // 202 挑战页：快照无结果链接
      { outcome: "worked", preview: braveSnapshotText() },
    );
    const r = await serpScrapeFallback("rust async runtime", 10, exec);
    // 调用序：先 ddg 后 brave（各一次，单一 bail-out）
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("html.duckduckgo.com/html/?q=");
    expect(calls[1]!.url).toContain("search.brave.com/search?q=");
    // 返回的是 brave 结果
    expect(r.outcome).toBe("worked");
    expect(r.retrieval_method).toBe("serp_scrape_brave");
    expect(r.data!.engine).toBe("brave_serp");
    expect(r.data!.region).toBe("us");
    const urls = r.data!.results.map((x) => x.url);
    expect(urls).toContain("https://doc.rust-lang.org/async-book/");
    expect(urls).toContain("https://tokio.rs/tutorials");
  });

  it("ddg didnt（网络/上游失败）→ brave 成功 → 返 brave 结果", async () => {
    const { exec, calls } = makeRoutedExec(
      { outcome: "didnt", error: "nav_failed" },
      { outcome: "worked", preview: braveSnapshotText() },
    );
    const r = await serpScrapeFallback("chrome devtools mcp", 10, exec);
    expect(calls).toHaveLength(2);
    expect(r.outcome).toBe("worked");
    expect(r.retrieval_method).toBe("serp_scrape_brave");
  });

  it("ddg worked 但 0 结果（200 空结果页）→ 也级联 brave", async () => {
    // 快照有文本但零结果链接 → extractResults count=0 → 级联判据命中
    const { exec, calls } = makeRoutedExec(
      { outcome: "worked", preview: "no results found for this query sorry" },
      { outcome: "worked", preview: braveSnapshotText() },
    );
    const r = await serpScrapeFallback("obscure query xyzzy", 10, exec);
    expect(calls).toHaveLength(2);
    expect(r.retrieval_method).toBe("serp_scrape_brave");
    expect(r.data!.count).toBeGreaterThan(0);
  });

  it("两者皆败 → 原样返回 ddg 结果（失败语义与级联前完全一致）", async () => {
    const { exec, calls } = makeRoutedExec(
      { outcome: "worked", preview: "" }, // 空 preview → unknown
      { outcome: "worked", preview: "" }, // brave 也空
    );
    const r = await serpScrapeFallback("rust async", 10, exec);
    expect(calls).toHaveLength(2); // brave 确实试过
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("serp_scrape_ddg"); // 回落 ddg 语义
    expect(r.error).toBe("serp_scrape_empty_preview");
    expect(r.data).toBeNull();
  });

  it("两者皆败（brave didnt）→ 返 ddg 的 unknown", async () => {
    const { exec } = makeRoutedExec(
      { outcome: "unknown", error: "serp_202_challenge" },
      { outcome: "didnt", error: "nav_failed" },
    );
    const r = await serpScrapeFallback("rust async", 10, exec);
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("serp_scrape_ddg");
    expect(r.error).toBe("serp_202_challenge");
  });

  it("ddg 成功 → 不级联（默认行为 byte-identical，单次调用）", async () => {
    const ddgOk = [
      "DuckDuckGo",
      "rust guide",
      "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust-lang.org%2Fasync-book%2F&rut=abc",
      "https://example.com/direct",
    ].join("\n");
    const { exec, calls } = makeRoutedExec(
      { outcome: "worked", preview: ddgOk },
      { outcome: "worked", preview: braveSnapshotText() },
    );
    const r = await serpScrapeFallback("rust async runtime", 10, exec);
    expect(calls).toHaveLength(1); // brave 未被调
    expect(calls[0]!.url).toContain("html.duckduckgo.com");
    expect(r.retrieval_method).toBe("serp_scrape_ddg");
    expect(r.data!.engine).toBe("ddg_serp");
  });
});

// ============================================================
// 6. CJK 路径不动
// ============================================================
describe("S-4 — CJK 路径红线（百度不级联）", () => {
  it("CJK query：百度失败 → 不级联 brave（单次 baidu 调用，失败语义不变）", async () => {
    const { exec, calls } = makeRoutedExec(
      { outcome: "didnt" },
      { outcome: "worked", preview: braveSnapshotText() },
      { outcome: "unknown", error: "serp_scrape_failed" }, // baidu 路由（other）
    );
    const r = await serpScrapeFallback("异步运行时", 10, exec);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("www.baidu.com/s?wd=");
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("serp_scrape_baidu");
  });
});

// ============================================================
// 7. SELF_HOST_RE
// ============================================================
describe("S-4 — SELF_HOST_RE 排除 brave 自家链", () => {
  it("search.brave.com 自家链不进 brave 级联结果", async () => {
    const { exec } = makeRoutedExec(
      { outcome: "worked", preview: DDG_CHALLENGE_PREVIEW },
      { outcome: "worked", preview: braveSnapshotText() },
    );
    const r = await serpScrapeFallback("rust async runtime", 10, exec);
    const urls = r.data!.results.map((x) => x.url);
    expect(urls.some((u) => u.includes("search.brave.com"))).toBe(false);
    expect(urls.some((u) => u.includes("brave.com"))).toBe(false);
  });
});

// ============================================================
// 8. SerpHealthMonitor 记 brave
// ============================================================
describe("S-4 — SerpHealthMonitor brave 计数", () => {
  function makeMonitor(): SerpHealthMonitor {
    const tmpDir = `/tmp/lasso-s4-serp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new SerpHealthMonitor(
      new SelectorRegistry(),
      new HitRateStats(),
      new ChangeDetection(tmpDir),
      new RecordingStore(tmpDir),
    );
  }

  it("级联 brave 成功 → onResult('brave', hit)；ddg 也记 miss", async () => {
    const m = makeMonitor();
    const spy = vi.spyOn(m, "onResult");
    const { exec } = makeRoutedExec(
      { outcome: "worked", preview: DDG_CHALLENGE_PREVIEW }, // ddg: 无结果链接 → count 0 → miss
      { outcome: "worked", preview: braveSnapshotText() },
    );
    await serpScrapeFallback("rust async runtime", 10, exec, m);
    const braveCall = spy.mock.calls.find((c) => c[0] === "brave");
    expect(braveCall).toBeDefined();
    expect(braveCall![4]).toBe(true); // hit
    const ddgCall = spy.mock.calls.find((c) => c[0] === "ddg");
    expect(ddgCall).toBeDefined();
    expect(ddgCall![4]).toBe(false); // miss（挑战页视为失败，兼收调研建议）
  });
});

// ============================================================
// 9. selectors 占位
// ============================================================
describe("S-4 — BRAVE_SERP_SELECTORS（open-webSearch 同款锚点占位）", () => {
  it("selectorsFor('brave') → BRAVE_SERP_SELECTORS（.snippet 容器 + SvelteKit 锚点）", () => {
    expect(selectorsFor("brave")).toBe(BRAVE_SERP_SELECTORS);
    expect(BRAVE_SERP_SELECTORS[0]!.result_container).toBe(".snippet");
    expect(BRAVE_SERP_SELECTORS[0]!.title).toBe(".search-snippet-title");
    expect(BRAVE_SERP_SELECTORS[0]!.link).toBe(".result-content > a");
    expect(BRAVE_SERP_SELECTORS[0]!.snippet).toBe(".generic-snippet");
    const engines: SerpEngine[] = ["baidu", "ddg", "brave"];
    expect(engines).toHaveLength(3);
  });

  it("brave 快照走 a11y 正则抽取（URL 保留为可读字符串，天然兼容 SvelteKit DOM）", () => {
    const r = extractResultsFromSnapshot(braveSnapshotText(), "rust async runtime");
    expect(r.count).toBeGreaterThanOrEqual(2);
    expect(r.results.every((x) => /^https?:\/\//.test(x.url))).toBe(true);
  });
});
