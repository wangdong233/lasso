/**
 * MarkdownExtractor 集成测（parse12 §5 v1.1 Phase B/C）
 *
 * 硬验收（parse12 §6.1 #2 + §1.3 用户硬约束）：
 *  - raw 默认 byte-identical v1.0（extract_mode 未传 / "raw" → 与 v1.0 完全一致）
 *  - markdown 档：browse extract + fetch_url html 真路径（defuddle+turndown）
 *  - markdown_cited 档：⟨N⟩ 角标 + References + citations 字段
 *  - json route 忽略 extract_mode（文档化边界）
 *
 * 测试策略：
 *  - browse 路径：HeadlessChannel + stub McpClient（evaluate_script 返 outerHTML JSON）
 *  - fetch_url 路径：doFetchUrl + mock SubprocessManager（fetch 返 HTML Response）
 *  - 不 spawn 真实 chrome-devtools-mcp；只验 Lasso 的 mode 分流 + 引擎接入
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { FetchUrlOptions, BrowseOptions } from "../../src/types.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// ============================================================
// DNS mock（让真实 ssrfGuard 跑；与 fetch-url.spec.ts 同范式）
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

// 在 mock 之后才 import SUT
import { doFetchUrl } from "../../src/tools/fetch-url.js";

// ============================================================
// fixtures
// ============================================================
const PUBLIC_IPS = ["93.184.216.34"];

const HTML_FIXTURE =
  `<html><head><title>Test Page</title></head><body>` +
  `<nav><a href="/home">Home</a> | <a href="/about">About</a></nav>` +
  `<article><h1>Hello World</h1>` +
  `<p>This is the main content with a <a href="https://example.com">link</a>.</p>` +
  `<p>Second paragraph with <a href="https://other.com">another link</a>.</p>` +
  `</article>` +
  `<aside>Sidebar junk to remove</aside>` +
  `<footer>Copyright 2026 footer junk</footer>` +
  `</body></html>`;

const EMPTY_CONFIG: SsrfConfig = { allowRanges: [], denyRanges: [] };

function setDns(ips: string[], err: string | null = null): void {
  dnsState.ips = ips;
  dnsState.err = err;
}

// ============================================================
// browse helpers
// ============================================================
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * 构造 stub McpClient。
 * - take_snapshot 返 a11y 文本树（v1.0 raw 路径）
 * - evaluate_script 返 outerHTML JSON（v1.1 markdown 路径）
 * - 记录所有 callTool 调用（验 mode 分流走对上游工具）
 */
function makeStubClient(htmlFixture: string): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const stub: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "take_snapshot") {
        return textContent(
          "Test Page\n\nHello World\nThis is the main content.",
        );
      }
      if (name === "evaluate_script") {
        // markdown 路径：doExtract 注入的 outerHTML 表达式 → 返 JSON {html,url,title}
        const json = JSON.stringify({
          html: htmlFixture,
          url: "https://example.com/",
          title: "Test Page",
        });
        return textContent(json);
      }
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () => [
      { name: "take_snapshot", inputSchema: {} },
      { name: "evaluate_script", inputSchema: {} },
    ]),
    close: vi.fn(async () => {}),
    pid: 12345,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client: stub, calls };
}

// ============================================================
// fetch_url helpers（与 fetch-url.spec.ts 同范式）
// ============================================================
function makeResponse(opts: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  const status = opts.status ?? 200;
  const body = opts.body ?? "";
  const headers = new Headers(opts.headers);
  const bodyBytes = new TextEncoder().encode(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    url: "https://example.com/",
    arrayBuffer: async () => bodyBytes.buffer.slice(0),
    text: async () => body,
  } as Response;
}

function makeMockSubproc(fetchMock: ReturnType<typeof vi.fn>): {
  subproc: SubprocessManager;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const subproc = {
    acquireHttpClient: vi.fn((_origin: string) => ({ fetch: fetchMock })),
  } as unknown as SubprocessManager;
  return { subproc, fetchMock };
}

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  setDns(PUBLIC_IPS);
  _resetRunIdForTests();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-md-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(async () => {
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function makeHeadlessWithStub(htmlFixture: string): {
  channel: HeadlessChannel;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const { client, calls } = makeStubClient(htmlFixture);
  const fakeSubproc = {
    registerSpec: vi.fn(),
    ensureRunning: vi.fn(async () => client),
    shutdown: vi.fn(async () => {}),
    healthProbe: vi.fn(async () => "healthy"),
  } as unknown as SubprocessManager;
  const channel = new HeadlessChannel(fakeSubproc);
  return { channel, calls };
}

// ============================================================
// §5.1 raw 默认 byte-identical v1.0（硬验收 parse12 §6.1 #2）
// ============================================================
describe("browse extract — raw 默认 byte-identical v1.0（INV-66 硬验收）", () => {
  it("extract_mode 未传 → 走 take_snapshot（a11y 文本树）；不调 evaluate_script", async () => {
    const { channel, calls } = makeHeadlessWithStub(HTML_FIXTURE);
    const r = await channel.browse("https://example.com/", "extract", {});
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toContain("Hello World");
    // raw 档必走 take_snapshot（不走 evaluate_script outerHTML）
    const toolNames = calls.map((c) => c.name);
    expect(toolNames).toContain("take_snapshot");
    expect(toolNames).not.toContain("evaluate_script");
    // raw 档不填 markdown 元数据
    expect(r.data!.markdown_engine).toBeUndefined();
  });

  it('extract_mode 显式 "raw" → 与未传 byte-identical（undefined ≡ "raw"）', async () => {
    const { channel: ch1, calls: calls1 } = makeHeadlessWithStub(HTML_FIXTURE);
    const r1 = await channel_browse(ch1, {});
    const { channel: ch2, calls: calls2 } = makeHeadlessWithStub(HTML_FIXTURE);
    const r2 = await channel_browse(ch2, { extract_mode: "raw" });

    // 输出 byte-identical
    expect(r1.data!.preview).toBe(r2.data!.preview);
    expect(r1.data!.title).toBe(r2.data!.title);
    // 工具调用一致（都走 take_snapshot）
    expect(calls1.map((c) => c.name)).toEqual(calls2.map((c) => c.name));
    expect(calls2.map((c) => c.name)).toContain("take_snapshot");
    expect(calls2.map((c) => c.name)).not.toContain("evaluate_script");
  });
});

// helper 避免命名冲突
async function channel_browse(
  ch: HeadlessChannel,
  opts: BrowseOptions,
) {
  return ch.browse("https://example.com/", "extract", opts);
}

// ============================================================
// §5.2 browse extract markdown 真路径
// ============================================================
describe("browse extract — markdown 档（defuddle+turndown 精炼）", () => {
  it('extract_mode="markdown" → 走 evaluate_script 取 outerHTML → markdown 输出', async () => {
    const { channel, calls } = makeHeadlessWithStub(HTML_FIXTURE);
    const r = await channel.browse("https://example.com/", "extract", {
      extract_mode: "markdown",
    });
    expect(r.outcome).toBe("worked");
    // markdown 档必走 evaluate_script（不走 take_snapshot）
    const toolNames = calls.map((c) => c.name);
    expect(toolNames).toContain("evaluate_script");
    // preview 含正文标题（markdown 形式 # Hello World）
    expect(r.data!.preview).toContain("Hello World");
    // markdown 元数据填充
    expect(r.data!.markdown_engine).toBeTruthy();
    expect(r.data!.markdown_engine).toContain("defuddle+turndown");
  });

  it("markdown 档不含 nav/footer junk（defuddle 去样板）", async () => {
    const { channel } = makeHeadlessWithStub(HTML_FIXTURE);
    const r = await channel.browse("https://example.com/", "extract", {
      extract_mode: "markdown",
    });
    expect(r.outcome).toBe("worked");
    // defuddle 应去 footer junk（内容摘要里不含 Copyright footer）
    expect(r.data!.preview).not.toContain("Copyright 2026 footer junk");
  });
});

// ============================================================
// §5.3 markdown_cited 引用角标
// ============================================================
describe("browse extract — markdown_cited 档（⟨N⟩ 角标 + References）", () => {
  it('extract_mode="markdown_cited" → citations 非空 + ⟨N⟩ 角标', async () => {
    const { channel } = makeHeadlessWithStub(HTML_FIXTURE);
    const r = await channel.browse("https://example.com/", "extract", {
      extract_mode: "markdown_cited",
    });
    expect(r.outcome).toBe("worked");
    // markdown_cited 档必走 evaluate_script
    // citations 字段应非空（HTML_FIXTURE 有 2 个不同 URL 的链接）
    expect(r.data!.citations).toBeTruthy();
    expect(r.data!.citations!.length).toBeGreaterThanOrEqual(1);
    // 角标编号 1-based
    expect(r.data!.citations![0].n).toBe(1);
    // URL 去重
    const urls = r.data!.citations!.map((c) => c.url);
    const uniqueUrls = new Set(urls);
    expect(uniqueUrls.size).toBe(urls.length);
  });
});

// ============================================================
// §5.1 fetch_url raw byte-identical v1.0（硬验收）
// ============================================================
describe("fetch_url — raw 默认 byte-identical v1.0（INV-66 硬验收）", () => {
  it("extract_mode 未传 → bodyKind=html（原始 HTML，v1.0 行为）", async () => {
    const html = "<html><body><p>raw content</p></body></html>";
    const { subproc } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({
          body: html,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const r = await doFetchUrl(
      "https://example.com/",
      { method: "GET", timeout_ms: 30_000, max_bytes: 2_000_000, no_cache: false },
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.body_kind).toBe("html");
    // bodyText 保留原始 HTML（不过 markdown 引擎）
    expect(r.data!.envelope!.preview).toContain("<html>");
    expect(r.data!.citations).toBeUndefined();
  });

  it('extract_mode 显式 "raw" → 与未传 byte-identical（undefined ≡ "raw"）', async () => {
    const html = "<html><body><p>same</p></body></html>";
    const mk = () =>
      makeMockSubproc(
        vi.fn().mockResolvedValue(
          makeResponse({
            body: html,
            headers: { "content-type": "text/html" },
          }),
        ),
      );
    const r1 = await doFetchUrl(
      "https://example.com/",
      { method: "GET", timeout_ms: 30_000, max_bytes: 2_000_000, no_cache: false },
      mk().subproc,
      EMPTY_CONFIG,
    );
    const r2 = await doFetchUrl(
      "https://example.com/",
      {
        method: "GET",
        timeout_ms: 30_000,
        max_bytes: 2_000_000,
        no_cache: false,
        extract_mode: "raw",
      },
      mk().subproc,
      EMPTY_CONFIG,
    );
    // byte-identical
    expect(r1.data!.body_kind).toBe(r2.data!.body_kind);
    expect(r1.data!.envelope!.preview).toBe(r2.data!.envelope!.preview);
  });
});

// ============================================================
// §5.2 fetch_url html markdown 路径
// ============================================================
describe("fetch_url — markdown 档（html route → MarkdownExtractor）", () => {
  it('extract_mode="markdown" + text/html → bodyKind 含 markdown: 前缀', async () => {
    const { subproc } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({
          body: HTML_FIXTURE,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );
    const r = await doFetchUrl(
      "https://example.com/",
      {
        method: "GET",
        timeout_ms: 30_000,
        max_bytes: 2_000_000,
        no_cache: false,
        extract_mode: "markdown",
      },
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.body_kind).toContain("markdown:");
    // markdown 内容含正文标题
    expect(r.data!.envelope!.preview).toContain("Hello World");
  });
});

// ============================================================
// §5.2 fetch_url 非 html route 忽略 extract_mode（文档化边界）
// ============================================================
describe("fetch_url — 非 html route 忽略 extract_mode（文档化）", () => {
  it("application/json + extract_mode=markdown → bodyKind=json（mode 被忽略）", async () => {
    const json = JSON.stringify({ key: "value", n: 42 });
    const { subproc } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({
          body: json,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const r = await doFetchUrl(
      "https://example.com/api",
      {
        method: "GET",
        timeout_ms: 30_000,
        max_bytes: 2_000_000,
        no_cache: false,
        extract_mode: "markdown",
      },
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.body_kind).toBe("json");
    // JSON 原样保留（不过 markdown 引擎）
    expect(r.data!.envelope!.preview).toContain('"key"');
  });

  it("text/plain + extract_mode=markdown_cited → bodyKind=text（mode 被忽略）", async () => {
    const { subproc } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({
          body: "plain text content",
          headers: { "content-type": "text/plain" },
        }),
      ),
    );
    const r = await doFetchUrl(
      "https://example.com/",
      {
        method: "GET",
        timeout_ms: 30_000,
        max_bytes: 2_000_000,
        no_cache: false,
        extract_mode: "markdown_cited",
      },
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.body_kind).toBe("text");
  });
});

// ============================================================
// §5.3 fetch_url html markdown_cited 路径
// ============================================================
describe("fetch_url — markdown_cited 档（html route → ⟨N⟩ 角标 + citations）", () => {
  it('extract_mode="markdown_cited" + text/html → citations 非空 + References', async () => {
    const { subproc } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({
          body: HTML_FIXTURE,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const r = await doFetchUrl(
      "https://example.com/",
      {
        method: "GET",
        timeout_ms: 30_000,
        max_bytes: 2_000_000,
        no_cache: false,
        extract_mode: "markdown_cited",
      },
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.body_kind).toContain("markdown:");
    // citations 字段非空（HTML_FIXTURE 有 https://example.com + https://other.com 两链接）
    expect(r.data!.citations).toBeTruthy();
    expect(r.data!.citations!.length).toBeGreaterThanOrEqual(1);
    expect(r.data!.citations![0].n).toBe(1);
  });
});

// ============================================================
// §5.5 冒烟测：CC 真实调用链（完整用户旅程）
// ============================================================
describe("冒烟测 — CC 真实调用链（parse12 §5）", () => {
  it("browse(url, extract_mode=markdown) 返干净 markdown；fetch_url(url, extract_mode=raw) 返原始 HTML", async () => {
    // 1. browse markdown → 干净 markdown
    const { channel } = makeHeadlessWithStub(HTML_FIXTURE);
    const browseResult = await channel.browse("https://example.com/", "extract", {
      extract_mode: "markdown",
    });
    expect(browseResult.outcome).toBe("worked");
    expect(browseResult.data!.markdown_engine).toContain("defuddle+turndown");
    expect(browseResult.data!.preview).toContain("Hello World");

    // 2. fetch_url raw → 原始 HTML（保留元素）
    const { subproc } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({
          body: HTML_FIXTURE,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const fetchRaw = await doFetchUrl(
      "https://example.com/",
      {
        method: "GET",
        timeout_ms: 30_000,
        max_bytes: 2_000_000,
        no_cache: false,
        extract_mode: "raw",
      },
      subproc,
      EMPTY_CONFIG,
    );
    expect(fetchRaw.outcome).toBe("worked");
    expect(fetchRaw.data!.body_kind).toBe("html");
    expect(fetchRaw.data!.envelope!.preview).toContain("<html>");

    // 3. fetch_url 不传 mode → v1.0 行为（byte-identical raw）
    const { subproc: subproc2 } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({
          body: HTML_FIXTURE,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const fetchDefault = await doFetchUrl(
      "https://example.com/",
      { method: "GET", timeout_ms: 30_000, max_bytes: 2_000_000, no_cache: false },
      subproc2,
      EMPTY_CONFIG,
    );
    expect(fetchDefault.outcome).toBe("worked");
    expect(fetchDefault.data!.body_kind).toBe("html");
    expect(fetchDefault.data!.envelope!.preview).toBe(
      fetchRaw.data!.envelope!.preview,
    );
  });
});
