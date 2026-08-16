/**
 * serp-ddg.spec.ts（v1.11 round1 T9 —— SERP 非 CJK 兜底 DDG + google 死 selector 清理）
 *
 * 验收（round1-verdict T9）：
 *  1. CJK/非 CJK 分流：CJK → baidu URL；非 CJK → html.duckduckgo.com URL
 *  2. ddg 抽取 fixture：DDG 跳转壳（/l/?uddg=）解包 + 自家链接排除 + engine=ddg_serp
 *  3. SerpHealthMonitor 记 ddg hit/miss（engine 名扩 "ddg"）
 *  4. google 死 selector 清理：GOOGLE_SELECTORS 零导出、selectorsFor("google") 不可达
 *  5. 不动 INV-23：serpScrapeFallback 全程走注入的 browseExec（browse_headless）
 */
import { describe, it, expect, vi } from "vitest";
import {
  serpScrapeFallback,
  serpEngineForQuery,
  serpUrlFor,
  extractResultsFromSnapshot,
  unwrapDdgRedirect,
  type BrowseExec,
} from "../../src/serp/extract.js";
import { selectorsFor, DDG_SELECTORS, type SerpEngine } from "../../src/serp/selectors.js";
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
function makeExec(result: { outcome: Outcome; preview?: string; error?: string }) {
  const calls: ExecCall[] = [];
  const exec: BrowseExec = async (url) => {
    calls.push({ url });
    return {
      outcome: result.outcome,
      data: result.preview !== undefined ? { preview: result.preview } : null,
      error: result.error,
    };
  };
  return { exec, calls };
}

/** 合成 DDG html 端点 a11y 快照文本（结果链接是 /l/?uddg= 跳转壳）。 */
function ddgSnapshotText(): string {
  return [
    "DuckDuckGo",
    "rust async runtime guide",
    "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust-lang.org%2Fasync-book%2F&rut=abc123",
    "Async Book — official guide",
    "https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftokio.rs%2Ftutorials&rut=def456",
    "Tokio tutorials",
    "https://example.com/direct-link",
  ].join("\n");
}

// ============================================================
// 1. CJK / 非 CJK 分流
// ============================================================
describe("T9 — serpEngineForQuery CJK/非CJK 分流", () => {
  it("CJK query → baidu", () => {
    expect(serpEngineForQuery("智谱 GLM 最新版本")).toBe("baidu");
    expect(serpEngineForQuery("日本語 検索")).toBe("baidu"); // 日文假名
    expect(serpEngineForQuery("한국어")).toBe("baidu"); // 韩文
  });

  it("非 CJK query → ddg", () => {
    expect(serpEngineForQuery("rust async runtime")).toBe("ddg");
    expect(serpEngineForQuery("chrome-devtools-mcp latest release")).toBe("ddg");
    expect(serpEngineForQuery("")).toBe("ddg"); // 空 query 非_CJK → ddg
  });

  it("serpUrlFor：baidu 带 rn=limit；ddg 是 html 端点", () => {
    expect(serpUrlFor("baidu", "测试", 10)).toBe(
      "https://www.baidu.com/s?wd=%E6%B5%8B%E8%AF%95&rn=10",
    );
    expect(serpUrlFor("ddg", "rust async", 10)).toBe(
      "https://html.duckduckgo.com/html/?q=rust%20async",
    );
  });

  it("serpScrapeFallback：非 CJK query → browseExec 收到 ddg URL + retrieval_method=serp_scrape_ddg", async () => {
    const { exec, calls } = makeExec({ outcome: "worked", preview: ddgSnapshotText() });
    const r = await serpScrapeFallback("rust async runtime", 10, exec);
    expect(calls[0]!.url).toContain("html.duckduckgo.com/html/?q=");
    expect(r.outcome).toBe("worked");
    expect(r.retrieval_method).toBe("serp_scrape_ddg");
    // 跳转壳解包后的真实 URL
    const urls = (r.data!.results as Array<{ url: string }>).map((x) => x.url);
    expect(urls).toContain("https://doc.rust-lang.org/async-book/");
    expect(urls).toContain("https://tokio.rs/tutorials");
  });

  it("serpScrapeFallback：CJK query → browseExec 收到 baidu URL + retrieval_method=serp_scrape_baidu", async () => {
    const { exec, calls } = makeExec({
      outcome: "worked",
      preview: "结果 https://example.com/cn-doc 页面",
    });
    const r = await serpScrapeFallback("异步运行时", 10, exec);
    expect(calls[0]!.url).toContain("www.baidu.com/s?wd=");
    expect(r.retrieval_method).toBe("serp_scrape_baidu");
    expect(r.data!.engine).toBe("baidu_serp");
  });
});

// ============================================================
// 2. ddg 抽取 fixture
// ============================================================
describe("T9 — ddg 快照抽取", () => {
  it("unwrapDdgRedirect 解 uddg 参数还原真实 URL", () => {
    expect(
      unwrapDdgRedirect(
        "https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftokio.rs%2Ftutorials&rut=xyz",
      ),
    ).toBe("https://tokio.rs/tutorials");
    // 非 DDG 链接原样
    expect(unwrapDdgRedirect("https://example.com/plain")).toBe(
      "https://example.com/plain",
    );
    // uddg 值非法（非 URL）→ 原样返回
    expect(unwrapDdgRedirect("https://duckduckgo.com/l/?uddg=not-a-url")).toBe(
      "https://duckduckgo.com/l/?uddg=not-a-url",
    );
  });

  it("extractResultsFromSnapshot：DDG 快照 → 解包链接 + duckduckgo 自家链接排除 + engine=ddg_serp", () => {
    const r = extractResultsFromSnapshot(ddgSnapshotText(), "rust async runtime");
    expect(r.engine).toBe("ddg_serp");
    expect(r.count).toBe(3); // 2 解包 + 1 direct
    const urls = r.results.map((x) => x.url);
    // duckduckgo.com 自家跳转壳不进结果（解包后是真实目标）
    expect(urls.some((u) => u.includes("duckduckgo.com"))).toBe(false);
    expect(urls).toContain("https://example.com/direct-link");
  });

  it("标题抽取：URL 前一行是标题（a11y 树 h3 文本语义）", () => {
    const r = extractResultsFromSnapshot(ddgSnapshotText(), "rust async runtime");
    // 第一条结果（async-book）的前一行是 "rust async runtime guide" 标题
    expect(
      r.results.some((x) => x.title.includes("rust async runtime guide")),
    ).toBe(true);
  });
});

// ============================================================
// 3. SerpHealthMonitor 记 ddg
// ============================================================
describe("T9 — SerpHealthMonitor ddg 计数", () => {
  function makeMonitor(): SerpHealthMonitor {
    const tmpDir = `/tmp/lasso-t9-serp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new SerpHealthMonitor(
      new SelectorRegistry(),
      new HitRateStats(),
      new ChangeDetection(tmpDir),
      new RecordingStore(tmpDir),
    );
  }

  it("serpScrapeFallback worked → serpHealth.onResult('ddg', hit)", async () => {
    const m = makeMonitor();
    const spy = vi.spyOn(m, "onResult");
    const { exec } = makeExec({ outcome: "worked", preview: ddgSnapshotText() });
    await serpScrapeFallback("rust async", 10, exec, m);
    expect(spy).toHaveBeenCalledWith(
      "ddg",
      "v1",
      "rust async",
      ddgSnapshotText(),
      true,
    );
  });

  it("serpScrapeFallback 空 preview → onResult('ddg', miss)", async () => {
    const m = makeMonitor();
    const spy = vi.spyOn(m, "onResult");
    const { exec } = makeExec({ outcome: "worked", preview: "" });
    await serpScrapeFallback("rust async", 10, exec, m);
    expect(spy).toHaveBeenCalledWith("ddg", "v1", "rust async", "", false);
  });
});

// ============================================================
// 4. google 死 selector 清理（零残留）
// ============================================================
describe("T9 — google 死 selector 清理", () => {
  it("selectors.ts 无 GOOGLE_SELECTORS 导出（死配置消灭）", async () => {
    const selectors = await import("../../src/serp/selectors.js");
    expect((selectors as Record<string, unknown>).GOOGLE_SELECTORS).toBeUndefined();
  });

  it("SerpEngine = 'baidu' | 'ddg'；selectorsFor('ddg') → DDG_SELECTORS", () => {
    const engines: SerpEngine[] = ["baidu", "ddg"];
    expect(selectorsFor("ddg")).toBe(DDG_SELECTORS);
    expect(selectorsFor("baidu")).not.toBe(DDG_SELECTORS);
    void engines;
  });
});
