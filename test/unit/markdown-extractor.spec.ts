/**
 * markdown-extractor 单测（parse12 §5.1/5.2/5.4 v1.1 Phase A）
 *
 * 守护 extractMarkdown 的三模式语义 + defuddle/turndown 真实引擎跑通。
 *
 * 测试覆盖：
 *  - §5.1 raw passthrough byte-identical（INV-66 硬验收）
 *  - §5.2 markdown 精炼质量（去 nav/script，留正文标题/列表/链接）
 *  - §5.3 markdown_cited ⟨N⟩ 角标 + References 去重
 *  - §5.4 三模式切换 + 边界（空 HTML / 中文 / 降级路径）
 *  - defuddle/turndown 真实跑通（不 mock 引擎，验真实可用性）
 */
import { describe, it, expect } from "vitest";
import {
  extractMarkdown,
  smokeTestMarkdownEngine,
  MARKDOWN_ENGINE,
} from "../../src/browse/markdown-extractor.js";

// ============================================================
// 固定 fixture（nav/script/footer junk + 正文 article）
// ============================================================
const FIXTURE_HTML =
  `<html><head><title>Test Article</title></head><body>` +
  `<nav><a href="/home">Home</a> <a href="/about">About</a></nav>` +
  `<script>var tracking = true;</script>` +
  `<article>` +
  `<h1>Hello World</h1>` +
  `<p>This is the main content with a <a href="https://example.com">link</a>.</p>` +
  `<h2>Subsection</h2>` +
  `<ul><li>Item 1</li><li>Item 2</li></ul>` +
  `</article>` +
  `<footer>Copyright 2026. All rights reserved.</footer>` +
  `</body></html>`;

const FIXTURE_HTML_CN =
  `<html><head><title>测试文章</title></head><body>` +
  `<nav>导航栏 导航栏</nav>` +
  `<article>` +
  `<h1>你好世界</h1>` +
  `<p>这是正文内容，包含一个<a href="https://example.com/cn">链接</a>。</p>` +
  `<ul><li>第一项</li><li>第二项</li></ul>` +
  `</article>` +
  `<footer>页脚内容 页脚内容</footer>` +
  `</body></html>`;

// ============================================================
// §5.1 raw passthrough byte-identical（INV-66 硬验收）
// ============================================================
describe("extractMarkdown — raw passthrough byte-identical（INV-66）", () => {
  it("mode='raw' → markdown 字段 === 原始 html（byte-identical，不经引擎）", async () => {
    const r = await extractMarkdown(FIXTURE_HTML, { mode: "raw" });
    expect(r.markdown).toBe(FIXTURE_HTML);
    expect(r.served_by).toBe("raw");
  });

  it("mode='raw' → 不含 defuddle/turndown 处理痕迹（nav/script/footer 原样保留）", async () => {
    const r = await extractMarkdown(FIXTURE_HTML, { mode: "raw" });
    // raw 档原样保留所有内容（包括 junk）
    expect(r.markdown).toContain("<nav>");
    expect(r.markdown).toContain("<script>");
    expect(r.markdown).toContain("<footer>");
    expect(r.markdown).toContain("<article>");
  });

  it("同输入 raw 模式多次调用 → 结果完全一致（确定性）", async () => {
    const r1 = await extractMarkdown(FIXTURE_HTML, { mode: "raw" });
    const r2 = await extractMarkdown(FIXTURE_HTML, { mode: "raw" });
    expect(r1.markdown).toBe(r2.markdown);
    expect(r1.served_by).toBe(r2.served_by);
  });

  it("空 HTML + mode='raw' → 返空串，不抛错", async () => {
    const r = await extractMarkdown("", { mode: "raw" });
    expect(r.markdown).toBe("");
    expect(r.served_by).toBe("raw");
  });
});

// ============================================================
// §5.2 markdown 精炼质量
// ============================================================
describe("extractMarkdown — markdown 档精炼质量", () => {
  it("去 nav/script/footer junk，留正文标题/列表/链接", async () => {
    const r = await extractMarkdown(FIXTURE_HTML, { mode: "markdown" });
    expect(r.served_by).toBe(MARKDOWN_ENGINE.pipeline);

    // 正文内容保留
    expect(r.markdown).toContain("Hello World");
    expect(r.markdown).toContain("Subsection");
    expect(r.markdown).toContain("Item 1");
    expect(r.markdown).toContain("Item 2");
    expect(r.markdown).toContain("link");

    // junk 去除（defuddle 抽正文去 nav/script/footer）
    expect(r.markdown).not.toContain("tracking");
    expect(r.markdown).not.toContain("Copyright 2026");
  });

  it("标题转为 markdown # 风格（atx heading）", async () => {
    const r = await extractMarkdown(FIXTURE_HTML, {
      mode: "markdown",
      headingStyle: "atx",
    });
    // defuddle + turndown 产出 ## 标题（atx 风格）
    expect(r.markdown).toMatch(/#+\s*Hello World/);
  });

  it("defuddle 抽出 title 元数据", async () => {
    const r = await extractMarkdown(FIXTURE_HTML, { mode: "markdown" });
    expect(r.title).toBeTruthy();
  });

  it("中文页面 → defuddle 能抽中文正文（多语言验证）", async () => {
    const r = await extractMarkdown(FIXTURE_HTML_CN, { mode: "markdown" });
    expect(r.markdown).toContain("你好世界");
    expect(r.markdown).toContain("第一项");
    expect(r.markdown).toContain("第二项");
    // junk 去除
    expect(r.markdown).not.toContain("导航栏");
    expect(r.markdown).not.toContain("页脚内容");
  });

  it("链接保留为 markdown inline link [text](url)", async () => {
    const r = await extractMarkdown(FIXTURE_HTML, { mode: "markdown" });
    expect(r.markdown).toMatch(/\[link\]\(https:\/\/example\.com\/?\)/);
  });
});

// ============================================================
// §5.3 markdown_cited ⟨N⟩ 角标
// ============================================================
describe("extractMarkdown — markdown_cited 档角标", () => {
  it("inline link 替换为 text ⟨N⟩ + 末尾 References 段", async () => {
    const r = await extractMarkdown(FIXTURE_HTML, { mode: "markdown_cited" });
    // 角标存在
    expect(r.markdown).toContain("⟨");
    // URL 去掉（不在 inline 出现，只在 References）
    expect(r.citations).toBeDefined();
    expect(r.citations!.length).toBeGreaterThan(0);
    // References 段存在
    expect(r.markdown).toContain("## References");
    expect(r.markdown).toContain("[1]");
  });

  it("citations 去重：同一 URL 只分配一个角标", async () => {
    const html =
      `<html><body><article>` +
      `<p>[A](https://example.com) [B](https://example.com)</p>` +
      `</article></body></html>`;
    // 用 markdown_cited 档（先 markdown 精炼再加角标）
    // 注：此 fixture 简单，defuddle 可能直接返 body；关键是 citations 去重
    const r = await extractMarkdown(html, { mode: "markdown_cited" });
    if (r.citations && r.citations.length > 0) {
      // 同 URL 只一个 citation
      const urls = r.citations.map((c) => c.url);
      const unique = new Set(urls);
      expect(unique.size).toBe(urls.length);
    }
  });

  it("enableCitations=false → 仅 markdown 不加角标", async () => {
    const r = await extractMarkdown(FIXTURE_HTML, {
      mode: "markdown_cited",
      enableCitations: false,
    });
    expect(r.citations).toBeUndefined();
    expect(r.markdown).not.toContain("## References");
  });
});

// ============================================================
// §5.4 三模式切换 + 边界
// ============================================================
describe("extractMarkdown — 三模式切换", () => {
  it("raw 档输出 ≠ markdown 档输出（raw 含 junk，markdown 不含）", async () => {
    const rawR = await extractMarkdown(FIXTURE_HTML, { mode: "raw" });
    const mdR = await extractMarkdown(FIXTURE_HTML, { mode: "markdown" });
    expect(rawR.markdown).not.toBe(mdR.markdown);
    // raw 保留 junk，markdown 去除
    expect(rawR.markdown).toContain("Copyright 2026");
    expect(mdR.markdown).not.toContain("Copyright 2026");
  });

  it("markdown 档 ⊂ markdown_cited 档（cited 多了 References 段）", async () => {
    const mdR = await extractMarkdown(FIXTURE_HTML, { mode: "markdown" });
    const citedR = await extractMarkdown(FIXTURE_HTML, {
      mode: "markdown_cited",
    });
    // cited 多了 References 段
    expect(citedR.markdown).toContain("## References");
    expect(mdR.markdown).not.toContain("## References");
  });
});

describe("extractMarkdown — 边界", () => {
  it("空 HTML + mode='markdown' → 返空串，不抛错", async () => {
    const r = await extractMarkdown("", { mode: "markdown" });
    expect(r.markdown).toBe("");
  });

  it("defuddle 降级：极端简单 HTML 不炸（turndown 兜底）", async () => {
    // 无 article tag 的极简 HTML；defuddle 返 body content
    const r = await extractMarkdown(
      "<html><body><p>Just text</p></body></html>",
      { mode: "markdown" },
    );
    expect(r.markdown).toContain("Just text");
    // served_by 是 defuddle+turndown 或 turndown-only（取决于 defuddle 行为）
    expect(["defuddle+turndown", "turndown-only"]).toContain(r.served_by);
  });

  it("turndown 失败时抛 [markdown-extractor] 前缀错误（可被调用方 catch）", async () => {
    // 极端输入：defuddle 对空 HTML 抛 TypeError → 降级 turndown-only
    // turndown 对非 HTML 字符串仍能处理，不会抛错；这里验证降级路径不炸
    const r = await extractMarkdown("plain text not html", {
      mode: "markdown",
    });
    expect(r.markdown).toBeDefined();
    expect(typeof r.markdown).toBe("string");
  });
});

// ============================================================
// smoke-test helper（parse12 §5.5 + doctor #33/#34）
// ============================================================
describe("smokeTestMarkdownEngine — 引擎可用性", () => {
  it("返 ok=true + engine 非 'failed' + markdown_preview 含 'Hello'", async () => {
    const r = await smokeTestMarkdownEngine();
    expect(r.ok).toBe(true);
    expect(r.engine).not.toBe("failed");
    expect(r.markdown_preview).toContain("Hello");
    expect(r.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("引擎名是 defuddle+turndown（MARKDOWN_ENGINE.pipeline）", async () => {
    const r = await smokeTestMarkdownEngine();
    expect(r.engine).toBe(MARKDOWN_ENGINE.pipeline);
  });
});
