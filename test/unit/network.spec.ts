/**
 * network tool 单测（parse6 §5.4，v0.5 M0.5c）
 *
 * 守护要点（parse6 §3.4 + §1.5 + §4.4 + §7.1 F2）：
 *  1. SSRF 拒私网（与 browse_headless / fetch_url / screenshot / pdf 同函数）
 *  2. 经 HeadlessChannel.browse(url, "network", opts) —— INV-33 衍生：不绕过 dispatch Map
 *  3. BrowseOptions.network_* 透传（filter / include_bodies / timeout_ms）
 *  4. PerformanceObserver entries JSON 解析 + 3rd-party 标记（v0.5 host 精确匹配）
 *  5. filter 维度 5 case：xhr / fetch / img / 3rd-party / all
 *  6. 资源列表过 applyOutputEnvelope 落 .txt（INV-34 + INV-15 衍生）
 *  7. **Go/No-Go F2**：上游 evaluate_script 不支持 → outcome=didnt +
 *     retrieval_method=upstream_unsupported:network + next_step
 *  8. F2 抓不全启发式：raw entries < 5 → 挂 data.next_step（不阻断 worked）
 *  9. parse 失败（preview 非 JSON）→ outcome=didnt + retrieval_method=entries_parse_failed
 *
 * 测试策略：
 *  - vi.mock("node:dns/promises") 让 ssrfGuard 走真实代码路径
 *  - 注入 mock HeadlessChannel，spy browse()；preview 模拟 PerformanceObserver entries JSON
 *  - doNetworkTool 直接调（不经 server.tool 装配）
 *  - 真实调 applyOutputEnvelope（不 mock；验 extension=.txt）
 *  - filterResources 单元测直调（纯函数；不依赖 ssrfGuard / browse）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NetworkOptions } from "../../src/types.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// ============================================================
// DNS mock
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

import {
  doNetworkTool,
  filterResources,
  isUpstreamNetworkUnsupported,
  shouldFlagIncompleteEntries,
  type ResourceEntry,
} from "../../src/tools/network.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type {
  BrowseOptions,
  BrowseResult,
  InteractResult,
} from "../../src/types.js";
import {
  _resetForTests,
} from "../../src/util/output-envelope.js";

// ============================================================
// helpers
// ============================================================
function setDns(ips: string[], err: string | null = null): void {
  dnsState.ips = ips;
  dnsState.err = err;
}

const PUBLIC_IPS = ["93.184.216.34"];
const PRIVATE_IPS_10 = ["10.0.0.1"];

const EMPTY_CONFIG: SsrfConfig = { allowRanges: [], denyRanges: [] };

const DEFAULT_OPTS: NetworkOptions = {
  filter: "all",
  include_bodies: false,
  timeout_ms: 3_000,
  wait_until: "load",
};

function makeMockHeadless(
  browseMock: ReturnType<typeof vi.fn>,
): { headless: HeadlessChannel; browseMock: ReturnType<typeof vi.fn> } {
  const headless = {
    browse: browseMock,
  } as unknown as HeadlessChannel;
  return { headless, browseMock };
}

/** 构造一个 PerformanceObserver entries JSON 字符串（n 条 mixed 资源） */
function makeEntriesJson(entries: ResourceEntry[]): string {
  return JSON.stringify(entries);
}

beforeEach(async () => {
  setDns(PUBLIC_IPS);
  await _resetForTests();
});

afterEach(async () => {
  await _resetForTests();
});

// ============================================================
// filterResources 纯函数测（不依赖 ssrfGuard / browse / envelope）
// ============================================================
describe("network — filterResources 纯函数", () => {
  const pageHost = "example.com";
  const mixed: ResourceEntry[] = [
    // 同 host XHR
    { name: "https://example.com/api/xhr", type: "xmlhttprequest", duration: 10, ttfb: 5, bytes: 100 },
    // 跨 host XHR（3rd-party）
    { name: "https://api.thirdparty.com/v1/track", type: "xmlhttprequest", duration: 20, ttfb: 15, bytes: 50 },
    // 同 host fetch
    { name: "https://example.com/api/fetch", type: "fetch", duration: 12, ttfb: 6, bytes: 200 },
    // 跨 host fetch（3rd-party）
    { name: "https://cdn.thirdparty.com/lib.js", type: "fetch", duration: 25, ttfb: 18, bytes: 50000 },
    // 同 host img
    { name: "https://example.com/static/a.png", type: "img", duration: 30, ttfb: 10, bytes: 8000 },
    // 跨 host img（3rd-party）
    { name: "https://img.thirdparty.com/banner.gif", type: "img", duration: 40, ttfb: 22, bytes: 30000 },
    // 同 host css
    { name: "https://example.com/styles.css", type: "css", duration: 15, ttfb: 8, bytes: 5000 },
    // cssimage（旧 webkit；filter 维度 'img' 兼容）
    { name: "https://example.com/sprite.css", type: "cssimage", duration: 16, ttfb: 9, bytes: 4000 },
    // invalid URL（host 留空；third_party=false 避免误判）
    { name: "not-a-url", type: "other", duration: 1, ttfb: 0, bytes: 0 },
  ];

  it("filter='all' → 返回全部 + 全部带 third_party 标记", () => {
    const r = filterResources(mixed, "all", pageHost);
    expect(r.length).toBe(mixed.length);
    // 跨 host 的标 true；同 host 的 false；invalid URL 的 false
    expect(r[0]?.third_party).toBe(false); // example.com XHR
    expect(r[1]?.third_party).toBe(true);  // api.thirdparty.com
    expect(r[8]?.third_party).toBe(false); // invalid URL
  });

  it("filter='xhr' → 只返 initiatorType=xmlhttprequest", () => {
    const r = filterResources(mixed, "xhr", pageHost);
    expect(r.length).toBe(2);
    expect(r.every((e) => e.type === "xmlhttprequest")).toBe(true);
  });

  it("filter='fetch' → 只返 initiatorType=fetch", () => {
    const r = filterResources(mixed, "fetch", pageHost);
    expect(r.length).toBe(2);
    expect(r.every((e) => e.type === "fetch")).toBe(true);
  });

  it("filter='img' → 返 img + cssimage（旧 webkit 兼容）", () => {
    const r = filterResources(mixed, "img", pageHost);
    expect(r.length).toBe(3); // example.com/a.png + thirdparty banner + cssimage
    expect(r.every((e) => e.type === "img" || e.type === "cssimage")).toBe(true);
  });

  it("filter='3rd-party' → 只返 third_party=true", () => {
    const r = filterResources(mixed, "3rd-party", pageHost);
    expect(r.length).toBe(3); // api.thirdparty.com + cdn.thirdparty.com + img.thirdparty.com
    expect(r.every((e) => e.third_party === true)).toBe(true);
  });
});

// ============================================================
// shouldFlagIncompleteEntries 启发式
// ============================================================
describe("network — shouldFlagIncompleteEntries F2 启发式", () => {
  it("count < 5 → true（疑似 fake-ip TUN 抓不全）", () => {
    expect(shouldFlagIncompleteEntries(0)).toBe(true);
    expect(shouldFlagIncompleteEntries(4)).toBe(true);
  });
  it("count >= 5 → false（正常页面）", () => {
    expect(shouldFlagIncompleteEntries(5)).toBe(false);
    expect(shouldFlagIncompleteEntries(100)).toBe(false);
  });
});

// ============================================================
// isUpstreamNetworkUnsupported 错误识别
// ============================================================
describe("network — isUpstreamNetworkUnsupported", () => {
  it("upstream_network_error 前缀 → true", () => {
    expect(isUpstreamNetworkUnsupported("upstream_network_error:tool_call_failed:timeout")).toBe(true);
  });
  it("Unknown tool: evaluate_script → true", () => {
    expect(isUpstreamNetworkUnsupported("Error: Unknown tool: evaluate_script")).toBe(true);
  });
  it("evaluate_script not found → true", () => {
    expect(isUpstreamNetworkUnsupported("tool evaluate_script not found in registry")).toBe(true);
  });
  it("无 关 错误 → false", () => {
    expect(isUpstreamNetworkUnsupported("navigation timeout")).toBe(false);
    expect(isUpstreamNetworkUnsupported(undefined)).toBe(false);
  });
});

// ============================================================
// SSRF 守门（INV-31 衍生：network 必经 ssrfGuard）
// ============================================================
describe("network — SSRF 守门", () => {
  it("私网 10.x → outcome=didnt + retrieval_method=ssrf_blocked + browse 不被调", async () => {
    setDns(PRIVATE_IPS_10);
    const browseMock = vi.fn();
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://intranet.example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("ssrf_blocked");
    expect(r.served_by).toBe("lasso.ssr_guard");
    expect(browseMock).not.toHaveBeenCalled();
  });

  it("公网 IP 通过 → browse 被调", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: {
        url: "https://example.com/",
        action: "network",
        preview: "[]",
      },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
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
// INV-33 衍生：经 HeadlessChannel.browse(url, "network", opts)
// ============================================================
describe("network — 经 BrowseChannel.browse 入口（INV-33）", () => {
  it("调 headless.browse(url, 'network', opts) —— 不绕过 dispatch Map", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "network", preview: "[]" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    await doNetworkTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(browseMock).toHaveBeenCalledWith(
      "https://example.com/",
      "network",
      expect.objectContaining({
        network_filter: "all",
        network_include_bodies: false,
        network_timeout_ms: 3_000,
        wait_until: "load",
      }),
    );
  });

  it("filter / timeout_ms / include_bodies 透传到 BrowseOptions.network_*", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "network", preview: "[]" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    await doNetworkTool(
      "https://example.com/",
      { ...DEFAULT_OPTS, filter: "xhr", timeout_ms: 10_000, include_bodies: true },
      headless,
      EMPTY_CONFIG,
    );
    const opts = browseMock.mock.calls[0]![2] as BrowseOptions;
    expect(opts.network_filter).toBe("xhr");
    expect(opts.network_timeout_ms).toBe(10_000);
    expect(opts.network_include_bodies).toBe(true);
  });
});

// ============================================================
// 资源列表过 envelope（INV-34 + INV-15 衍生）
// ============================================================
describe("network — 资源列表过 applyOutputEnvelope", () => {
  it("empty entries → outcome=worked + resource_count=0 + F2 next_step（count < 5）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "network", preview: "[]" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data?.resource_count).toBe(0);
    expect(r.data?.third_party_count).toBe(0);
    expect(r.data?.page_host).toBe("example.com");
    // F2 启发式：raw < 5 → next_step
    expect(r.data?.next_step).toMatch(/PerformanceObserver entries count < 5/);
  });

  it("丰富 entries（同 host + 跨 host）→ resource_count + third_party_count 正确", async () => {
    const entries: ResourceEntry[] = [
      { name: "https://example.com/a.js", type: "script", duration: 10, ttfb: 5, bytes: 1000 },
      { name: "https://cdn.thirdparty.com/b.js", type: "script", duration: 20, ttfb: 15, bytes: 2000 },
      { name: "https://api.thirdparty.com/xhr", type: "xmlhttprequest", duration: 30, ttfb: 20, bytes: 500 },
      { name: "https://example.com/xhr", type: "xmlhttprequest", duration: 5, ttfb: 3, bytes: 200 },
      { name: "https://analytics.com/track", type: "fetch", duration: 25, ttfb: 18, bytes: 100 },
    ];
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "network", preview: makeEntriesJson(entries) },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://example.com/",
      { ...DEFAULT_OPTS, filter: "all" },
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data?.resource_count).toBe(5);
    expect(r.data?.third_party_count).toBe(3); // cdn.thirdparty.com + api.thirdparty.com + analytics.com
    // 5 entries 不触发 F2 next_step
    expect(r.data?.next_step).toBeUndefined();
    // envelope 必填
    expect(r.data?.envelope).toBeDefined();
    expect(r.data?.envelope?.preview).toBeDefined();
  });

  it("filter='3rd-party' → resource_count 等于 third_party_count", async () => {
    const entries: ResourceEntry[] = [
      { name: "https://example.com/a.js", type: "script", duration: 10, ttfb: 5, bytes: 1000 },
      { name: "https://cdn.thirdparty.com/b.js", type: "script", duration: 20, ttfb: 15, bytes: 2000 },
      { name: "https://api.thirdparty.com/xhr", type: "xmlhttprequest", duration: 30, ttfb: 20, bytes: 500 },
      { name: "https://example.com/xhr", type: "xmlhttprequest", duration: 5, ttfb: 3, bytes: 200 },
      { name: "https://analytics.com/track", type: "fetch", duration: 25, ttfb: 18, bytes: 100 },
    ];
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "network", preview: makeEntriesJson(entries) },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://example.com/",
      { ...DEFAULT_OPTS, filter: "3rd-party" },
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data?.resource_count).toBe(3); // 跨 host 3 条
    expect(r.data?.third_party_count).toBe(3); // 同数（filter=3rd-party 时两者一致）
  });

  it("page_host 从 args.url 解析（含 path 不影响 host）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/a/b/c", action: "network", preview: "[]" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://example.com/a/b/c",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.data?.page_host).toBe("example.com");
  });
});

// ============================================================
// Go/No-Go F2：上游不支持 evaluate_script
// ============================================================
describe("network — Go/No-Go F2（upstream_unsupported:network）", () => {
  it("result.error 含 upstream_network_error → outcome=didnt + next_step", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "upstream_network_error:tool_call_failed:Unknown tool: evaluate_script",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("upstream_unsupported:network");
    expect(r.data?.next_step).toBeDefined();
    expect(r.data?.resource_count).toBe(0);
  });

  it("result.error 含 'Unknown tool: evaluate_script' → outcome=didnt + upstream_unsupported", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "Error: Unknown tool: evaluate_script",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("upstream_unsupported:network");
  });
});

// ============================================================
// JSON 解析失败 → outcome=didnt + retrieval_method=entries_parse_failed
// ============================================================
describe("network — entries JSON 解析失败降级", () => {
  it("preview 非 JSON → outcome=didnt + retrieval_method=entries_parse_failed", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "network", preview: "not-json-{" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("entries_parse_failed");
    expect(r.data?.page_host).toBe("example.com");
  });

  it("preview 是 JSON 但非 array → parse 失败降级", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "network", preview: '{"foo":"bar"}' },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("entries_parse_failed");
  });
});

// ============================================================
// browse 自身失败（非 upstream unsupported）→ 错误透传
// ============================================================
describe("network — browse 失败透传", () => {
  it("browse outcome=unknown（超时）→ network outcome=unknown + retrieval_method 透传", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "navigation timeout after 30000ms",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doNetworkTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("unknown");
    expect(r.data).toBeNull();
    expect(r.error).toMatch(/navigation timeout/);
  });
});
