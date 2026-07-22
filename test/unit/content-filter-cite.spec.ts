/**
 * content-filter-cite 单测（parse12 §5.3 v1.1 Phase A）
 *
 * 守护 applyCitations 的 ⟨N⟩ 引用角标算法（Crawl4AI convert_links_to_citations reimplement）。
 * 测试策略：纯函数无副作用，直接表驱动。
 */
import { describe, it, expect } from "vitest";
import { applyCitations } from "../../src/browse/content-filter-cite.js";

describe("applyCitations — 基本角标", () => {
  it("单个 inline link → 替换为 text ⟨1⟩ + References 段含 [1] url", () => {
    const md = "Hello [world](https://example.com) end.";
    const r = applyCitations(md);
    expect(r.markdown).toContain("world ⟨1⟩");
    expect(r.markdown).not.toContain("(https://example.com)");
    expect(r.markdown).toContain("## References");
    expect(r.markdown).toContain("[1] https://example.com");
    expect(r.citations).toEqual([{ n: 1, url: "https://example.com" }]);
  });

  it("两个不同 URL 的链接 → 分别分配 ⟨1⟩ / ⟨2⟩", () => {
    const md =
      "Visit [Google](https://google.com) and [GitHub](https://github.com).";
    const r = applyCitations(md);
    expect(r.markdown).toContain("Google ⟨1⟩");
    expect(r.markdown).toContain("GitHub ⟨2⟩");
    expect(r.citations).toHaveLength(2);
    expect(r.citations[0]!.url).toBe("https://google.com");
    expect(r.citations[1]!.url).toBe("https://github.com");
    // References 段有 2 条
    expect(r.markdown).toContain("[1] https://google.com");
    expect(r.markdown).toContain("[2] https://github.com");
  });
});

describe("applyCitations — URL 去重", () => {
  it("同一 URL 出现 2 次 → 只分配 1 个角标 ⟨1⟩，References 段只 1 条", () => {
    const md =
      "First [link](https://example.com) and again [link2](https://example.com).";
    const r = applyCitations(md);
    expect(r.markdown).toContain("link ⟨1⟩");
    expect(r.markdown).toContain("link2 ⟨1⟩");
    expect(r.citations).toHaveLength(1);
    expect(r.citations[0]).toEqual({ n: 1, url: "https://example.com" });
  });

  it("3 个 URL 交替出现 → 编号按首次出现序", () => {
    const md =
      "[A](https://a.com) [B](https://b.com) [A2](https://a.com) [C](https://c.com).";
    const r = applyCitations(md);
    expect(r.citations).toEqual([
      { n: 1, url: "https://a.com" },
      { n: 2, url: "https://b.com" },
      { n: 3, url: "https://c.com" },
    ]);
    // A 和 A2 共享 ⟨1⟩（同 URL 去重）
    expect(r.markdown).toContain("A ⟨1⟩");
    expect(r.markdown).toContain("A2 ⟨1⟩");
    expect(r.markdown).toContain("B ⟨2⟩");
    expect(r.markdown).toContain("C ⟨3⟩");
  });
});

describe("applyCitations — 边界", () => {
  it("markdown 无任何链接 → 返回原文不变，citations=[]，不加 References 段", () => {
    const md = "This is plain text with no links at all.";
    const r = applyCitations(md);
    expect(r.markdown).toBe(md);
    expect(r.citations).toEqual([]);
    expect(r.markdown).not.toContain("## References");
  });

  it("空字符串 → 返回空串，citations=[]", () => {
    const r = applyCitations("");
    expect(r.markdown).toBe("");
    expect(r.citations).toEqual([]);
  });

  it("只有文本不含 URL 的方括号 → 不误匹配", () => {
    const md = "This is [not a link] just bracketed text.";
    const r = applyCitations(md);
    expect(r.markdown).toBe(md);
    expect(r.citations).toEqual([]);
  });

  it("http:// 和 https:// URL 都能匹配", () => {
    const md = "[A](http://a.com) [B](https://b.com).";
    const r = applyCitations(md);
    expect(r.citations).toHaveLength(2);
    expect(r.citations[0]!.url).toBe("http://a.com");
    expect(r.citations[1]!.url).toBe("https://b.com");
  });

  it("角标使用 unicode ⟨ ⟩（U+27E8/U+27E9），不与 @oN ref 混淆", () => {
    const md = "[link](https://example.com)";
    const r = applyCitations(md);
    expect(r.markdown).toContain("⟨1⟩");
    // 不含 @oN 风格引用
    expect(r.markdown).not.toContain("@o");
  });
});
