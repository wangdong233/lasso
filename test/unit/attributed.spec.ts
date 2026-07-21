/**
 * AttributedSearch 单元测（parse2 §5.1 / §3.3.2）。
 *
 * 覆盖：
 *  - withAttribution: 每条结果带 served_by + original_rank
 *  - 单源 served_by 透传（"search.zhipu"）
 *  - fanout 合并 served_by（"search.zhipu,search.brave"）
 *  - 原结果不被修改（pure function）
 *  - 空结果 → 空数组
 *  - source 字段透传
 */
import { describe, it, expect } from "vitest";
import { withAttribution } from "../../src/search/AttributedSearch.js";
import type { SearchResult } from "../../src/types.js";

function makeResult(
  results: Array<{ title: string; url: string; snippet?: string; source?: string }>,
): SearchResult {
  return {
    query: "test",
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet ?? "",
      ...(r.source !== undefined ? { source: r.source } : {}),
    })),
    count: results.length,
    engine: "multi",
    region: "auto",
  };
}

describe("withAttribution — 基础行为", () => {
  it("每条结果获得 served_by + original_rank", () => {
    const r = makeResult([
      { title: "T1", url: "https://1.test" },
      { title: "T2", url: "https://2.test" },
      { title: "T3", url: "https://3.test" },
    ]);
    const attributed = withAttribution(r, "search.zhipu");
    expect(attributed).toHaveLength(3);
    expect(attributed[0].served_by).toBe("search.zhipu");
    expect(attributed[0].original_rank).toBe(1);
    expect(attributed[1].original_rank).toBe(2);
    expect(attributed[2].original_rank).toBe(3);
  });

  it("单源 served_by 透传", () => {
    const r = makeResult([{ title: "T", url: "https://x.test" }]);
    const attributed = withAttribution(r, "search.brave");
    expect(attributed[0].served_by).toBe("search.brave");
  });

  it("fanout 合并 served_by：每条都带 'search.zhipu,search.brave'", () => {
    const r = makeResult([
      { title: "T1", url: "https://1.test" },
      { title: "T2", url: "https://2.test" },
    ]);
    const attributed = withAttribution(r, "search.zhipu,search.brave");
    expect(attributed.every((a) => a.served_by === "search.zhipu,search.brave")).toBe(true);
  });

  it("browse_headless fallback served_by 透传", () => {
    const r = makeResult([{ title: "T", url: "https://x.test" }]);
    const attributed = withAttribution(r, "browse_headless");
    expect(attributed[0].served_by).toBe("browse_headless");
  });

  it("source 字段透传（不丢失）", () => {
    const r = makeResult([
      { title: "T", url: "https://x.test", source: "example.com" },
    ]);
    const attributed = withAttribution(r, "search.zhipu");
    expect(attributed[0].source).toBe("example.com");
  });

  it("source 缺失 → 不出现在 attributed 结果", () => {
    const r = makeResult([{ title: "T", url: "https://x.test" }]);
    const attributed = withAttribution(r, "search.zhipu");
    expect(attributed[0].source).toBeUndefined();
  });

  it("空 results → 返空数组", () => {
    const r = makeResult([]);
    const attributed = withAttribution(r, "search.zhipu");
    expect(attributed).toEqual([]);
  });

  it("纯函数：不修改原 SearchResult.results", () => {
    const r = makeResult([{ title: "T", url: "https://x.test" }]);
    const originalSnapshot = JSON.parse(JSON.stringify(r));
    withAttribution(r, "search.zhipu");
    expect(r).toEqual(originalSnapshot);
  });

  it("保留 title / url / snippet", () => {
    const r = makeResult([
      { title: "Rust", url: "https://rust.test", snippet: "systems language" },
    ]);
    const attributed = withAttribution(r, "search.brave");
    expect(attributed[0].title).toBe("Rust");
    expect(attributed[0].url).toBe("https://rust.test");
    expect(attributed[0].snippet).toBe("systems language");
  });
});
