/**
 * fetch_url tool 单测（parse6 §5.1，v0.5 M0.5a）
 *
 * 守护要点（parse6 §1.5 + §3.1 + §4.1）：
 *  1. SSRF 拒私网（10.x / 127.x / 169.254.169.254 元数据）—— 与 browse_headless 同函数
 *  2. SSRF 允许 fake-ip（LASSO_SSRF_ALLOW_RANGES=198.18.0.0/15）—— TUN 场景放行
 *  3. content-type 分流：html / json / text / binary
 *  4. redirect:"manual" 拒跟随 3xx（防 SSRF 绕过；返 location 给 caller 二次显式调）
 *  5. 4xx → didnt；5xx → unknown；2xx → worked（tri-state）
 *  6. timeout → unknown；ENOTFOUND → didnt
 *  7. bounded output > 48 KiB 自动落盘 .txt + @oN ref
 *  8. max_bytes 截断（content-length > max_bytes → didnt）
 *  9. INV-32 守护：经 subproc.acquireHttpClient（不裸 fetch / 不 new Agent）
 *
 * 测试策略：
 *  - vi.mock("node:dns/promises") 注入可控 DNS（让 ssrfGuard 走真实代码路径）
 *  - 注入 mock SubprocessManager，spy acquireHttpClient，返 mock { fetch }
 *  - doFetchUrl 直接调（不经 server.tool 装配，单测更聚焦）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FetchUrlOptions } from "../../src/types.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// ============================================================
// DNS mock（与 ssrf-guard.spec.ts 同范式；让真实 ssrfGuard 跑）
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
import { doFetchUrl } from "../../src/tools/fetch-url.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";

// ============================================================
// helpers
// ============================================================
function setDns(ips: string[], err: string | null = null): void {
  dnsState.ips = ips;
  dnsState.err = err;
}

const PUBLIC_IPS = ["93.184.216.34"]; // example.com 公网 IP
const PRIVATE_IPS_10 = ["10.0.0.1"];
const PRIVATE_IPS_127 = ["127.0.0.1"];
const METADATA_IPS = ["169.254.169.254"];
const FAKE_IPS = ["198.18.0.1"]; // fake-ip TUN 段

/** 默认 config（无 allow / 无 deny）—— 私网默认拒。 */
const EMPTY_CONFIG: SsrfConfig = { allowRanges: [], denyRanges: [] };
/** 用户 allowRanges 扩展 fake-ip 段（TUN 场景）。 */
const FAKE_IP_ALLOWED: SsrfConfig = {
  allowRanges: ["198.18.0.0/15"],
  denyRanges: [],
};

const DEFAULT_OPTS: FetchUrlOptions = {
  method: "GET",
  timeout_ms: 30_000,
  max_bytes: 2 * 1024 * 1024,
  no_cache: false,
};

/**
 * 构造一个 mock SubprocessManager，spy acquireHttpClient。
 * - acquireHttpClient(origin) 返 mock { fetch }
 * - fetchMock 是 vi.fn() —— 每个测试 mockResolvedValue / mockRejectedValue
 */
function makeMockSubproc(fetchMock: ReturnType<typeof vi.fn>): {
  subproc: SubprocessManager;
  fetchMock: ReturnType<typeof vi.fn>;
  acquireSpy: ReturnType<typeof vi.fn>;
} {
  const acquireSpy = vi.fn((_origin: string) => ({ fetch: fetchMock }));
  const subproc = {
    acquireHttpClient: acquireSpy,
  } as unknown as SubprocessManager;
  return { subproc, fetchMock, acquireSpy };
}

/**
 * 构造一个 mock Response（Web Fetch API 形状）。
 */
function makeResponse(opts: {
  status?: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  url?: string;
}): Response {
  const status = opts.status ?? 200;
  const body = opts.body ?? "";
  const headers = new Headers(opts.headers);
  const bodyBytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    url: opts.url ?? "https://example.com/",
    arrayBuffer: async () => bodyBytes.buffer.slice(0),
    text: async () =>
      typeof body === "string" ? body : new TextDecoder().decode(body),
  } as Response;
}

beforeEach(() => {
  setDns(PUBLIC_IPS);
});

// ============================================================
// SSRF 守门（INV-31）
// ============================================================
describe("fetch_url — SSRF 守门（INV-31；与 browse_headless 同函数）", () => {
  it("私网 10.x → outcome=didnt + retrieval_method=ssrf_blocked + fetch 不被调", async () => {
    setDns(PRIVATE_IPS_10);
    const { subproc, fetchMock } = makeMockSubproc(vi.fn());
    const r = await doFetchUrl(
      "https://intranet.example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("ssrf_blocked");
    expect(r.error).toContain("ssrf_blocked:private_ip:10.0.0.1");
    expect(r.served_by).toBe("lasso.ssr_guard");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loopback 127.0.0.1 默认拒（仅 127.0.0.1/32 在 default allow）", async () => {
    // 127.0.0.1 在 DEFAULT_ALLOW_RANGES → 放行
    setDns(["127.0.0.1"]);
    const { subproc, fetchMock } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({ status: 200, body: "ok", headers: { "content-type": "text/plain" } }),
      ),
    );
    const r = await doFetchUrl(
      "https://localhost/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("127.0.0.2 拒（不在 /32 allow；私网 127.0.0.0/8 段）", async () => {
    setDns(["127.0.0.2"]);
    const { subproc, fetchMock } = makeMockSubproc(vi.fn());
    const r = await doFetchUrl(
      "https://localhost/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("ssrf_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("元数据服务 169.254.169.254 拒（防云元数据泄露）", async () => {
    setDns(METADATA_IPS);
    const { subproc, fetchMock } = makeMockSubproc(vi.fn());
    const r = await doFetchUrl(
      "http://169.254.169.254/latest/meta-data/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("ssrf_blocked");
    // ssrfGuard 的 reason 形如 `private_ip:<ip>`（169.254/16 在 PRIVATE_RANGES）
    expect(r.error).toContain("ssrf_blocked:private_ip:169.254.169.254");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("公网 IP（fake-ip 198.18.x 不在 PRIVATE_RANGES）默认放行", async () => {
    setDns(FAKE_IPS);
    // 注：198.18.0.0/15 不在 PRIVATE_RANGES（见 defaults.ts），所以 ssrfGuard 默认放行。
    // 用户 env LASSO_SSRF_ALLOW_RANGES 是冗余的防御深度（已在 §ssrf/defaults.ts 注释明确）。
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: "ok", headers: { "content-type": "text/plain" } }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://tun-proxy.example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fake-ip 198.18.x 经 LASSO_SSRF_ALLOW_RANGES 放行（TUN 场景）", async () => {
    setDns(FAKE_IPS);
    const { subproc, fetchMock } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({ status: 200, body: "ok", headers: { "content-type": "text/plain" } }),
      ),
    );
    const r = await doFetchUrl(
      "https://tun-proxy.example.com/",
      DEFAULT_OPTS,
      subproc,
      FAKE_IP_ALLOWED,
    );
    expect(r.outcome).toBe("worked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// INV-32：经 SubprocessManager.acquireHttpClient
// ============================================================
describe("fetch_url — INV-32 经连接池（禁 new Agent / 禁裸 fetch）", () => {
  it("acquireHttpClient 被调且参数是 origin（scheme + host，不含 path）", async () => {
    const { subproc, acquireSpy } = makeMockSubproc(
      vi.fn().mockResolvedValue(
        makeResponse({ status: 200, body: "ok", headers: { "content-type": "text/plain" } }),
      ),
    );
    await doFetchUrl(
      "https://api.example.com/v1/foo?bar=baz",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(acquireSpy).toHaveBeenCalledWith("https://api.example.com");
  });

  it("经 httpClient.fetch 调用（不裸 global.fetch）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: "ok", headers: { "content-type": "text/plain" } }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 首参 = url；二参 init 含 method / headers / signal / redirect
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.com/");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).redirect).toBe("manual");
  });

  it("no_cache=true → Cache-Control: no-cache 注入", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: "ok", headers: { "content-type": "text/plain" } }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    await doFetchUrl(
      "https://example.com/",
      { ...DEFAULT_OPTS, no_cache: true },
      subproc,
      EMPTY_CONFIG,
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Cache-Control"]).toBe("no-cache");
  });

  it("自定义 headers 透传 + 默认 UA（lasso-mcp/0.5）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: "ok", headers: { "content-type": "text/plain" } }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    await doFetchUrl(
      "https://example.com/",
      { ...DEFAULT_OPTS, headers: { "X-Custom": "foo" } },
      subproc,
      EMPTY_CONFIG,
    );
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("lasso-mcp/0.5 (fetch_url)");
    expect(headers["X-Custom"]).toBe("foo");
  });
});

// ============================================================
// content-type 分流（parse6 §3.5）
// ============================================================
describe("fetch_url — content-type 分流", () => {
  it("text/html → body_kind=html + 原样文本", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: "<html><body>hi</body></html>",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.body_kind).toBe("html");
    expect(r.data!.envelope!.preview).toContain("<html>");
    expect(r.data!.content_type).toContain("text/html");
  });

  it("application/json → body_kind=json + 原样 JSON 文本", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: JSON.stringify({ hello: "world" }),
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://api.example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.data!.body_kind).toBe("json");
    expect(r.data!.envelope!.preview).toContain('"hello":"world"');
  });

  it("text/plain → body_kind=text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: "hello world",
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.data!.body_kind).toBe("text");
  });

  it("image/png → body_kind=binary:png + base64 编码", async () => {
    // 8 bytes of fake "PNG" data
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: pngBytes,
        headers: { "content-type": "image/png" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/img.png",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.data!.body_kind).toBe("binary:png");
    // base64 编码后：前几个字符是 iVBORw0K...
    expect(r.data!.envelope!.preview.startsWith("iVBORw0K")).toBe(true);
    expect(r.data!.body_bytes).toBe(8);
  });

  it("application/pdf → body_kind=binary:pdf", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: pdfBytes,
        headers: { "content-type": "application/pdf" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/doc.pdf",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.data!.body_kind).toBe("binary:pdf");
  });

  it("无 content-type → 默认 octet-stream → binary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: "data",
        // 故意不设 content-type
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.data!.body_kind).toBe("binary:octet-stream");
  });
});

// ============================================================
// redirect:"manual"（parse6 §4.1）—— 守 SSRF 不被重定向绕过
// ============================================================
describe("fetch_url — redirect:manual 不跟随（防 SSRF 绕过）", () => {
  it("302 → outcome=didnt + retrieval_method=redirect_not_followed + data.location", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 302,
        headers: {
          location: "https://other.example.com/new",
          "content-type": "text/html",
        },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/old",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("redirect_not_followed");
    expect(r.data!.location).toBe("https://other.example.com/new");
    expect(r.data!.status).toBe(302);
    expect(r.data!.body_kind).toBe("redirect");
    // 只调一次 fetch（不跟随）
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("301 + 无 Location → didnt + no_location 错误", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 301,
        headers: { "content-type": "text/html" },
        // 无 location header
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("redirect_not_followed");
    expect(r.error).toContain("no_location");
  });

  it("307 Temporary Redirect 也按 didnt 处理", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 307,
        headers: { location: "https://other.example.com/" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.data!.status).toBe(307);
  });
});

// ============================================================
// tri-state outcome（parse6 §3.1.3）
// ============================================================
describe("fetch_url — tri-state outcome", () => {
  it("200 → worked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: "ok",
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.error).toBeUndefined();
  });

  it("404 → didnt（明确否定）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 404,
        body: "Not Found",
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/missing",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("http_404");
  });

  it("403 → didnt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 403,
        body: "Forbidden",
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("http_403");
  });

  it("500 → unknown（transient）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 500,
        body: "Internal Server Error",
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("http_500");
  });

  it("503 → unknown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 503,
        body: "Service Unavailable",
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("unknown");
  });
});

// ============================================================
// 错误分类（parse6 §3.1.3 outcomeFromFetchError）
// ============================================================
describe("fetch_url — 错误分类", () => {
  it("ENOTFOUND → didnt（host 不存在）", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND nope.test"));
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://nope.test/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("ENOTFOUND");
  });

  it("ECONNREFUSED → didnt（明确拒绝连接）", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 93.184.216.34:443"));
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
  });

  it("AbortError（timeout）→ unknown", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("unknown");
  });

  it("网络挂（ECONNRESET）→ unknown", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("read ECONNRESET"));
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("unknown");
  });
});

// ============================================================
// max_bytes 截断（parse6 §3.1.3 第 4 步）
// ============================================================
describe("fetch_url — max_bytes 截断", () => {
  it("content-length > max_bytes → didnt + max_bytes_exceeded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: "x",
        headers: {
          "content-length": "1000000",
          "content-type": "text/plain",
        },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/big",
      { ...DEFAULT_OPTS, max_bytes: 100_000 },
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("max_bytes_exceeded");
    expect(r.error).toContain("content_length_exceeds_max");
    expect(r.error).toContain("1000000>100000");
  });

  it("body 实际字节 > max_bytes（content-length 缺失）→ didnt", async () => {
    // 无 content-length header；body 实际 200 字节
    const bigBody = "x".repeat(200);
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: bigBody,
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      { ...DEFAULT_OPTS, max_bytes: 100 },
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("max_bytes_exceeded");
    expect(r.error).toContain("body_exceeds_max");
  });
});

// ============================================================
// bounded output（parse6 §3.1.3 第 6 步；INV-15 衍生 INV-34 同源）
// ============================================================
describe("fetch_url — bounded output > 48 KiB 自动落盘", () => {
  it("body > 48 KiB → envelope.truncated=true + ref 形如 @oN", async () => {
    // 49 KiB text
    const bigBody = "a".repeat(49 * 1024);
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: bigBody,
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.envelope!.truncated).toBe(true);
    expect(r.data!.envelope!.ref).toMatch(/^@o\d+$/);
    expect(r.data!.envelope!.total_bytes).toBe(49 * 1024);
    expect(r.data!.envelope!.continue_hint).toContain("read_text");
  });

  it("body ≤ 48 KiB → envelope.truncated=false + preview 原样", async () => {
    const body = "a".repeat(1000);
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body,
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.data!.envelope!.truncated).toBe(false);
    expect(r.data!.envelope!.preview).toBe(body);
    expect(r.data!.envelope!.ref).toBeUndefined();
  });
});

// ============================================================
// 边界（parse6 §6.5 边界审计）
// ============================================================
describe("fetch_url — 边界（不 fallback browse_headless）", () => {
  it("fetch 失败永远不 fallback —— outcome 透传，fallback_used=false", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.fallback_used).toBe(false);
    expect(r.outcome).toBe("unknown");
  });

  it("HEAD method 透传到 fetch init", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: "",
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    await doFetchUrl(
      "https://example.com/",
      { ...DEFAULT_OPTS, method: "HEAD" },
      subproc,
      EMPTY_CONFIG,
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("HEAD");
  });

  it("返回 served_by='fetch_url' + retrieval_method='undici_keepalive'", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: "ok",
        headers: { "content-type": "text/plain" },
      }),
    );
    const { subproc } = makeMockSubproc(fetchMock);
    const r = await doFetchUrl(
      "https://example.com/",
      DEFAULT_OPTS,
      subproc,
      EMPTY_CONFIG,
    );
    expect(r.served_by).toBe("fetch_url");
    expect(r.retrieval_method).toBe("undici_keepalive");
  });
});
