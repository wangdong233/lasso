/**
 * fetch_feed 单元测（doc/governance/05 颠覆性调研 verdict D-GO-2，2026-08-18）。
 *
 * 覆盖：
 *  - parseFeedBody 纯解析：RSS 2.0 / Atom / JSON Feed / CDATA / 实体 / limit
 *  - 截断容忍：body 在条目中间被切断 → 只出完整条目，不出半条
 *  - 非 feed body → not_a_feed 抛错（caller 转 didnt）
 *  - doFetchFeed：SSRF 拒 / fetch 非 worked 透传 / binary 拒 / worked 装配
 *
 * 策略：doFetchUrl 用 stub（隔离网络）；parseFeedBody 直接调（纯函数）。
 */
import { describe, it, expect, vi } from "vitest";

// review-r1：连接池自 SubprocessManager 迁 util/http-pool——stub 改为模块 mock
vi.mock("../../src/util/http-pool.js", () => ({
  acquireHttpClient: vi.fn(),
}));

import { parseFeedBody, doFetchFeed } from "../../src/tools/fetch-feed.js";
import { acquireHttpClient } from "../../src/util/http-pool.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";
import type { InteractResult, FetchUrlResult } from "../../src/types.js";

// ============================================================
// fixtures
// ============================================================
const RSS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Example Releases</title>
  <link>https://example.com/blog</link>
  <lastBuildDate>Mon, 17 Aug 2026 10:00:00 GMT</lastBuildDate>
  <item>
    <title>v2.1 released</title>
    <link>https://example.com/blog/v2.1</link>
    <pubDate>Mon, 17 Aug 2026 09:00:00 GMT</pubDate>
    <description><![CDATA[Fixes <b>critical</b> bug &amp; improves perf]]></description>
  </item>
  <item>
    <title>v2.0 released</title>
    <link>https://example.com/blog/v2.0</link>
    <pubDate>Fri, 14 Aug 2026 09:00:00 GMT</pubDate>
    <description>Major rewrite</description>
  </item>
  <item>
    <title>v1.9 released</title>
    <link>https://example.com/blog/v1.9</link>
    <pubDate>Mon, 10 Aug 2026 09:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

const ATOM_BODY = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <link rel="alternate" href="https://example.com/"/>
  <updated>2026-08-17T10:00:00Z</updated>
  <entry>
    <title>First post</title>
    <link rel="alternate" href="https://example.com/posts/1"/>
    <published>2026-08-17T09:00:00Z</published>
    <summary>Summary of first &amp; foremost</summary>
  </entry>
  <entry>
    <title>Second post</title>
    <link href="https://example.com/posts/2"/>
    <updated>2026-08-16T09:00:00Z</updated>
    <content type="html">&lt;p&gt;Some &lt;b&gt;bold&lt;/b&gt; content&lt;/p&gt;</content>
  </entry>
</feed>`;

const JSON_FEED_BODY = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "Example JSON Feed",
  home_page_url: "https://example.com/",
  items: [
    {
      title: "J1",
      url: "https://example.com/j1",
      date_published: "2026-08-17T09:00:00Z",
      content_text: "plain text content",
    },
    {
      title: "J2",
      url: "https://example.com/j2",
      date_published: "2026-08-16T09:00:00Z",
      summary: "j2 summary",
    },
  ],
});

// ============================================================
// parseFeedBody 纯函数
// ============================================================
describe("parseFeedBody — RSS 2.0", () => {
  it("解析 channel 元数据 + item 条目（CDATA / 实体解码）", () => {
    const r = parseFeedBody(RSS_BODY, 10);
    expect(r.format).toBe("rss");
    expect(r.title).toBe("Example Releases");
    expect(r.site_url).toBe("https://example.com/blog");
    expect(r.updated).toBe("Mon, 17 Aug 2026 10:00:00 GMT");
    expect(r.count).toBe(3);
    expect(r.entries[0]).toEqual({
      title: "v2.1 released",
      url: "https://example.com/blog/v2.1",
      published: "Mon, 17 Aug 2026 09:00:00 GMT",
      // CDATA 剥壳 + 内联 HTML 去标签 + &amp; 解码
      summary: "Fixes critical bug & improves perf",
    });
    // 无 description 的 item：summary undefined（不伪造）
    expect(r.entries[2]!.summary).toBeUndefined();
  });

  it("limit 截断：只要前 2 条", () => {
    const r = parseFeedBody(RSS_BODY, 2);
    expect(r.count).toBe(2);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[1]!.title).toBe("v2.0 released");
  });
});

describe("parseFeedBody — Atom", () => {
  it("解析 entry（rel=alternate 优先 / 无 rel 兜底 / content 去标签）", () => {
    const r = parseFeedBody(ATOM_BODY, 10);
    expect(r.format).toBe("atom");
    expect(r.title).toBe("Example Atom");
    expect(r.site_url).toBe("https://example.com/");
    expect(r.count).toBe(2);
    expect(r.entries[0]!.url).toBe("https://example.com/posts/1");
    expect(r.entries[0]!.published).toBe("2026-08-17T09:00:00Z");
    expect(r.entries[0]!.summary).toBe("Summary of first & foremost");
    // 第二条：无 rel 的 link 兜底 + updated 当 published + content 去 HTML 标签
    expect(r.entries[1]!.url).toBe("https://example.com/posts/2");
    expect(r.entries[1]!.published).toBe("2026-08-16T09:00:00Z");
    expect(r.entries[1]!.summary).toBe("Some bold content");
  });
});

describe("parseFeedBody — JSON Feed", () => {
  it("解析 items（url / date_published / content_text）", () => {
    const r = parseFeedBody(JSON_FEED_BODY, 10);
    expect(r.format).toBe("json");
    expect(r.title).toBe("Example JSON Feed");
    expect(r.site_url).toBe("https://example.com/");
    expect(r.count).toBe(2);
    expect(r.entries[0]).toEqual({
      title: "J1",
      url: "https://example.com/j1",
      published: "2026-08-17T09:00:00Z",
      summary: "plain text content",
    });
    expect(r.entries[1]!.summary).toBe("j2 summary");
  });
});

describe("parseFeedBody — 截断容忍（ZB-4 核心设计）", () => {
  it("body 在第二条 item 中间被切断 → 只出完整条目，不出半条", () => {
    const cutAt = RSS_BODY.indexOf("<pubDate>Fri");
    const truncated = RSS_BODY.slice(0, cutAt); // 切在第二条 item 的 pubDate 前
    const r = parseFeedBody(truncated, 10);
    expect(r.format).toBe("rss");
    expect(r.count).toBe(1); // 只有第一条完整 item
    expect(r.entries[0]!.title).toBe("v2.1 released");
  });

  it("截断到第一条 item 之前 → channel 骨架仍可辨（count 0；doFetchFeed 按 truncated_input 区分错误码）", () => {
    const truncated = RSS_BODY.slice(0, RSS_BODY.indexOf("<item"));
    const r = parseFeedBody(truncated, 10);
    expect(r.format).toBe("rss");
    expect(r.count).toBe(0);
    expect(r.title).toBe("Example Releases"); // 头部元数据仍在
  });

  it("有 feed 骨架但 0 条 item（真空 feed）→ count 0（doFetchFeed 转 didnt feed_has_no_entries）", () => {
    const empty = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Empty</title><link>https://e.com</link></channel></rss>`;
    const r = parseFeedBody(empty, 10);
    expect(r.format).toBe("rss");
    expect(r.count).toBe(0);
    expect(r.entries).toHaveLength(0);
  });

  it("全内容 feed 截断（单条 >16KiB，0 完整块）→ 头字段抢救出 title/url/published", () => {
    // 模拟 ruanyifeng 型全内容 atom：第一条 entry 含 30KiB content，preview 在其中截断
    const bigContent = "x".repeat(30 * 1024);
    const fullContentAtom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Full Content Feed</title>
  <link rel="alternate" href="https://example.com/"/>
  <updated>2026-08-17T10:00:00Z</updated>
  <entry>
    <title>Long article</title>
    <link rel="alternate" href="https://example.com/posts/long"/>
    <published>2026-08-17T09:00:00Z</published>
    <content type="html">${bigContent}</content>
  </entry>
</feed>`;
    const truncated16k = fullContentAtom.slice(0, 16 * 1024);
    const r = parseFeedBody(truncated16k, 10);
    expect(r.format).toBe("atom");
    expect(r.count).toBe(1); // 抢救出的头字段条目
    expect(r.entries[0]).toEqual({
      title: "Long article",
      url: "https://example.com/posts/long",
      published: "2026-08-17T09:00:00Z",
      summary: undefined, // content 在截断侧，不猜
    });
  });
});

describe("parseFeedBody — 非 feed", () => {
  it("HTML 页面 → 抛 not_a_feed", () => {
    expect(() => parseFeedBody("<html><body>hello</body></html>", 10)).toThrow(
      "not_a_feed",
    );
  });
  it("散文本 → 抛 not_a_feed", () => {
    expect(() => parseFeedBody("just some plain text", 10)).toThrow("not_a_feed");
  });
});

// ============================================================
// doFetchFeed（stub doFetchUrl 不可行——它是模块内直调；改 stub http-pool）
// 实操：stub util/http-pool.acquireHttpClient 返回可控 fetch（review-r1 迁移后形态）。
// ============================================================
function makeSubprocWithBody(
  body: string,
  init: {
    status?: number;
    contentType?: string;
    headers?: Record<string, string>;
  } = {},
): void {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? "application/rss+xml; charset=utf-8";
  vi.mocked(acquireHttpClient).mockReturnValue({
    fetch: vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      headers: new Map(
        Object.entries({
          "content-type": contentType,
          ...(init.headers ?? {}),
        }),
      ),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    })) as unknown as typeof fetch,
  });
}

const SSRF_ALLOW: SsrfConfig = {
  allowRanges: [],
  denyRanges: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"],
};

function envelopeFor(text: string): { preview: string; truncated: boolean } {
  return { preview: text, truncated: false };
}

describe("doFetchFeed — 端到端（stub HTTP）", () => {
  it("application/rss+xml → worked + rss 解析（路由表 ZB-4 配套条目生效）", async () => {
    makeSubprocWithBody(RSS_BODY);
    const r = await doFetchFeed(
      "https://example.com/feed.xml",
      10,
      SSRF_ALLOW,
    );
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("fetch_feed");
    expect(r.data!.format).toBe("rss");
    expect(r.data!.count).toBe(3);
    expect(r.data!.truncated_input).toBe(false);
  });

  it("text/xml → worked（既有 text 路由）", async () => {
    makeSubprocWithBody(ATOM_BODY, { contentType: "text/xml" });
    const r = await doFetchFeed(
      "https://example.com/feed",
      2,
      SSRF_ALLOW,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.format).toBe("atom");
    expect(r.data!.count).toBe(2); // limit=2 生效
  });

  it("application/feed+json → worked + json 解析", async () => {
    makeSubprocWithBody(JSON_FEED_BODY, {
      contentType: "application/feed+json",
    });
    const r = await doFetchFeed(
      "https://example.com/feed.json",
      10,
      SSRF_ALLOW,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.format).toBe("json");
  });

  it("非 feed 的 HTML body → didnt not_a_feed（诚实不伪造）", async () => {
    makeSubprocWithBody("<html><body>not a feed</body></html>", {
      contentType: "text/html",
    });
    const r = await doFetchFeed(
      "https://example.com/page",
      10,
      SSRF_ALLOW,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("not_a_feed");
  });

  it("私网 URL → didnt ssrf_blocked（INV-56 家族）", async () => {
    makeSubprocWithBody(RSS_BODY);
    const r = await doFetchFeed(
      "http://192.168.1.1/feed.xml",
      10,
      SSRF_ALLOW,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.served_by).toBe("lasso.ssr_guard");
    expect(r.error).toMatch(/^ssrf_blocked:/);
  });

  it("image/png 等 binary content-type → didnt unsupported_content_type", async () => {
    makeSubprocWithBody(RSS_BODY, { contentType: "image/png" });
    const r = await doFetchFeed(
      "https://example.com/pic.png",
      10,
      SSRF_ALLOW,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toMatch(/^unsupported_content_type:/);
  });

  it("HTTP 500 → 透传 unknown（fetch 层语义不吞）", async () => {
    makeSubprocWithBody("server error", {
      status: 500,
      contentType: "text/plain",
    });
    const r = await doFetchFeed(
      "https://example.com/feed.xml",
      10,
      SSRF_ALLOW,
    );
    expect(r.outcome).not.toBe("worked");
    expect(r.served_by).toBe("fetch_feed");
  });
});
