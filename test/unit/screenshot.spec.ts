/**
 * screenshot tool 单测（parse6 §5.2，v0.5 M0.5b）
 *
 * 守护要点（parse6 §3.2 + §1.5）：
 *  1. SSRF 拒私网（10.x / 127.0.0.2+ / 169.254.169.254 元数据）—— 与 browse_headless 同函数
 *  2. SSRF 允许公网（默认 198.18.x 不在 PRIVATE_RANGES）
 *  3. 经 HeadlessChannel.browse(url, "screenshot", opts) —— INV-33 衍生：不绕过 dispatch Map
 *  4. full_page=true 透传到 BrowseOptions.screenshot.full
 *  5. preview 解析：从 "screenshot saved to /tmp/...png" 抽 path
 *  6. fallback 透传：browse 返 fallback_used=true → screenshotResult.fallback_used=true
 *
 * 测试策略：
 *  - vi.mock("node:dns/promises") 让 ssrfGuard 走真实代码路径
 *  - 注入 mock HeadlessChannel，spy browse()
 *  - doScreenshotTool 直接调（不经 server.tool 装配，单测更聚焦）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ScreenshotOptions } from "../../src/types.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// ============================================================
// DNS mock（与 fetch-url.spec.ts 同范式）
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
import { doScreenshotTool, extractScreenshotPath } from "../../src/tools/screenshot.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type {
  BrowseOptions,
  BrowseResult,
  InteractResult,
} from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
function setDns(ips: string[], err: string | null = null): void {
  dnsState.ips = ips;
  dnsState.err = err;
}

const PUBLIC_IPS = ["93.184.216.34"]; // example.com
const PRIVATE_IPS_10 = ["10.0.0.1"];
const METADATA_IPS = ["169.254.169.254"];

const EMPTY_CONFIG: SsrfConfig = { allowRanges: [], denyRanges: [] };

const DEFAULT_OPTS: ScreenshotOptions = {
  full_page: false,
  format: "png",
  wait_until: "load",
  timeout_ms: 30_000,
};

/**
 * 构造一个 mock HeadlessChannel，spy browse()。
 * - browse(url, action, opts) 返 mock InteractResult<BrowseResult>
 * - browseMock 是 vi.fn() —— 每个测试 mockResolvedValue
 */
function makeMockHeadless(
  browseMock: ReturnType<typeof vi.fn>,
): { headless: HeadlessChannel; browseMock: ReturnType<typeof vi.fn> } {
  const headless = {
    browse: browseMock,
  } as unknown as HeadlessChannel;
  return { headless, browseMock };
}

beforeEach(() => {
  setDns(PUBLIC_IPS);
});

// ============================================================
// SSRF 守门（INV-31 衍生：screenshot 必经 ssrfGuard）
// ============================================================
describe("screenshot — SSRF 守门（与 browse_headless 同函数）", () => {
  it("私网 10.x → outcome=didnt + retrieval_method=ssrf_blocked + browse 不被调", async () => {
    setDns(PRIVATE_IPS_10);
    const browseMock = vi.fn();
    const { headless } = makeMockHeadless(browseMock);
    const r = await doScreenshotTool(
      "https://intranet.example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("ssrf_blocked");
    expect(r.error).toContain("ssrf_blocked:private_ip:10.0.0.1");
    expect(r.served_by).toBe("lasso.ssr_guard");
    expect(browseMock).not.toHaveBeenCalled();
  });

  it("元数据服务 169.254.169.254 拒", async () => {
    setDns(METADATA_IPS);
    const browseMock = vi.fn();
    const { headless } = makeMockHeadless(browseMock);
    const r = await doScreenshotTool(
      "http://169.254.169.254/latest/meta-data/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("ssrf_blocked");
    expect(browseMock).not.toHaveBeenCalled();
  });

  it("公网 IP 通过 → browse 被调", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: {
        url: "https://example.com/",
        action: "screenshot",
        preview: "screenshot saved to /tmp/lasso-screenshot-abc.png",
        state_id: "state-1",
        content_path: "/tmp/state-1.json",
      },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    });
    const { headless } = makeMockHeadless(browseMock);
    const r = await doScreenshotTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(browseMock).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// INV-33 衍生：经 HeadlessChannel.browse(url, "screenshot", opts)
// ============================================================
describe("screenshot — 经 BrowseChannel.browse 入口（INV-33）", () => {
  it("调 headless.browse(url, 'screenshot', opts) —— 不绕过 dispatch Map", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: {
        url: "https://example.com/",
        action: "screenshot",
        preview: "screenshot saved to /tmp/lasso-screenshot-abc.png",
        state_id: "state-1",
      },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    });
    const { headless } = makeMockHeadless(browseMock);
    await doScreenshotTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(browseMock).toHaveBeenCalledWith(
      "https://example.com/",
      "screenshot",
      expect.objectContaining({
        screenshot: { full: false },
        wait_until: "load",
        timeout_ms: 30_000,
      }),
    );
  });

  it("full_page=true → browseOpts.screenshot.full=true", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: {
        url: "https://example.com/",
        action: "screenshot",
        preview: "screenshot saved to /tmp/x.png",
      },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    });
    const { headless } = makeMockHeadless(browseMock);
    await doScreenshotTool(
      "https://example.com/",
      { ...DEFAULT_OPTS, full_page: true },
      headless,
      EMPTY_CONFIG,
    );
    const opts = browseMock.mock.calls[0]![2] as BrowseOptions;
    expect(opts.screenshot?.full).toBe(true);
  });

  it("wait_until + timeout_ms 透传到 browseOpts", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "screenshot", preview: "/tmp/x.png" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    });
    const { headless } = makeMockHeadless(browseMock);
    await doScreenshotTool(
      "https://example.com/",
      { ...DEFAULT_OPTS, wait_until: "networkidle", timeout_ms: 60_000 },
      headless,
      EMPTY_CONFIG,
    );
    const opts = browseMock.mock.calls[0]![2] as BrowseOptions;
    expect(opts.wait_until).toBe("networkidle");
    expect(opts.timeout_ms).toBe(60_000);
  });
});

// ============================================================
// preview 解析：path 抽取（parse6 §3.2.3 extractScreenshotPath）
// ============================================================
describe("screenshot — path 解析（extractScreenshotPath）", () => {
  it("从 'screenshot saved to /tmp/lasso-screenshot-<uuid>.png' 抽出 path", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: {
        url: "https://example.com/",
        action: "screenshot",
        preview: "screenshot saved to /tmp/lasso-screenshot-abc-123.png",
        state_id: "state-1",
      },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    });
    const { headless } = makeMockHeadless(browseMock);
    const r = await doScreenshotTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.data!.path).toBe("/tmp/lasso-screenshot-abc-123.png");
    expect(r.data!.preview).toBe(
      "screenshot saved to /tmp/lasso-screenshot-abc-123.png",
    );
    expect(r.data!.state_id).toBe("state-1");
    expect(r.data!.url).toBe("https://example.com/");
  });

  it("extractScreenshotPath 兼容 .jpg / .jpeg 扩展名（v0.6+ format 扩展预留）", () => {
    expect(
      extractScreenshotPath("saved to /tmp/lasso-screenshot-x.jpg"),
    ).toBe("/tmp/lasso-screenshot-x.jpg");
    expect(
      extractScreenshotPath("saved to /tmp/lasso-screenshot-y.jpeg"),
    ).toBe("/tmp/lasso-screenshot-y.jpeg");
  });

  it("extractScreenshotPath 对空 / 无路径字符串返 undefined", () => {
    expect(extractScreenshotPath(undefined)).toBeUndefined();
    expect(extractScreenshotPath("")).toBeUndefined();
    expect(extractScreenshotPath("no path here")).toBeUndefined();
  });

  it("browse 返 preview 无路径 → data.path=undefined（不抛错）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: {
        url: "https://example.com/",
        action: "screenshot",
        preview: "weird preview without path",
      },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    });
    const { headless } = makeMockHeadless(browseMock);
    const r = await doScreenshotTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.path).toBeUndefined();
  });
});

// ============================================================
// fallback 透传 + outcome 透传
// ============================================================
describe("screenshot — fallback / outcome 透传", () => {
  it("browse 返 fallback_used=true → screenshotResult.fallback_used=true（语义保留）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: {
        url: "https://example.com/",
        action: "screenshot",
        preview: "screenshot saved to /tmp/x.png",
      },
      served_by: "browse_logged_in", // fallback 到 logged_in
      fallback_used: true,
      retrieval_method: "chrome_devtools_mcp",
    });
    const { headless } = makeMockHeadless(browseMock);
    const r = await doScreenshotTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.fallback_used).toBe(true);
    expect(r.served_by).toBe("browse_logged_in");
  });

  it("browse outcome=unknown → screenshot outcome=unknown + error 透传", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "timeout",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doScreenshotTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("unknown");
    expect(r.data).toBeNull();
    expect(r.error).toBe("timeout");
  });

  it("browse outcome=didnt → screenshot outcome=didnt（如 NEEDS_MANUAL_2FA）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "didnt",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "NEEDS_MANUAL_2FA",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doScreenshotTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("NEEDS_MANUAL_2FA");
  });
});
