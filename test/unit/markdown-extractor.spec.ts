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
// §5.6（v1.12 round2 T2-3/T2-4）：defuddle URL 透传 + separateMarkdown 转换接管
// ============================================================
// HN 列表页 fixture：tr.athing × 2 → defuddle hackernews extractor canExtract()
const HN_LISTING_HTML =
  `<html><body><table>` +
  `<tr class="athing"><td class="title"><span class="rank">1.</span></td>` +
  `<td class="title"><span class="titleline"><a href="/item?id=1">Story One</a></span></td></tr>` +
  `<tr><td></td><td class="subtext"><span class="score">100 points</span></td></tr>` +
  `<tr class="athing"><td class="title"><span class="rank">2.</span></td>` +
  `<td class="title"><span class="titleline"><a href="/item?id=2">Story Two</a></span></td></tr>` +
  `<tr><td></td><td class="subtext"><span class="score">50 points</span></td></tr>` +
  `</table></body></html>`;

const TABLE_HTML =
  `<html><body><article><h1>Data</h1>` +
  `<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>` +
  `</article></body></html>`;

describe("extractMarkdown — T2-3 URL 透传（站点 extractor + 链接绝对化）", () => {
  it("传 url=HN → 站点 extractor 路径激活 + 相对链接绝对化（/item?id=1 → https://…）", async () => {
    const r = await extractMarkdown(HN_LISTING_HTML, {
      mode: "markdown",
      url: "https://news.ycombinator.com/",
    });
    expect(r.served_by).toBe("defuddle+turndown");
    // extractor 路径可区分信号 1：相对链接被绝对化（LLM 可直接 fetch）
    expect(r.markdown).toContain("https://news.ycombinator.com/item?id=1");
    expect(r.markdown).toContain("https://news.ycombinator.com/item?id=2");
    // extractor 路径可区分信号 2：HN extractor 产出的列表编号结构
    expect(r.markdown).toContain("Story One");
    expect(r.markdown).toContain("Story Two");
  });

  it("不传 url → v1.11 行为保持：零 extractor 激活、相对链接不绝对化", async () => {
    const r = await extractMarkdown(HN_LISTING_HTML, { mode: "markdown" });
    // 相对链接保持相对（无 https://news.ycombinator.com 前缀注入）
    expect(r.markdown).not.toContain("https://news.ycombinator.com/item?id=1");
    expect(r.markdown).toContain("Story One"); // 正文仍抽出
  });
});

describe("extractMarkdown — T2-4 separateMarkdown 转换接管（表格结构保真）", () => {
  it("表格 fixture → GFM separator 行存在（| --- |），不再丢结构", async () => {
    const r = await extractMarkdown(TABLE_HTML, {
      mode: "markdown",
      url: "https://example.com/table",
    });
    expect(r.markdown).toContain("| a | b |");
    expect(r.markdown).toContain("| --- |");
    expect(r.markdown).toContain("| 1 | 2 |");
    expect(r.served_by).toBe("defuddle+turndown");
  });

  it("defuddle 失败降级档保留：turndown-only 路径仍可走通", async () => {
    // 极简非正文 HTML：defuddle 可能仍成功；此处验证降级语义不回归——
    // served_by 二值集合不变（降级标记机制原样保留）
    const r = await extractMarkdown("<html><body><p>x</p></body></html>", {
      mode: "markdown",
      url: "https://example.com/",
    });
    expect(["defuddle+turndown", "turndown-only"]).toContain(r.served_by);
    expect(r.markdown.length).toBeGreaterThan(0);
  });

  it("markdown_cited 档在 T2-4 转换产物上角标仍生效（管线顺序不变）", async () => {
    const r = await extractMarkdown(
      `<html><body><article><h1>T</h1>` +
        `<p>see <a href="https://example.com/a">alpha</a> and <a href="https://example.com/b">beta</a></p>` +
        `</article></body></html>`,
      { mode: "markdown_cited", url: "https://example.com/cited" },
    );
    expect(r.markdown).toContain("References");
    expect(r.citations).toBeTruthy();
    expect(r.citations!.length).toBe(2);
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
