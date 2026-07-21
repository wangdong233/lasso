/**
 * pdf tool 单测（parse6 §5.3，v0.5 M0.5b）
 *
 * 守护要点（parse6 §3.3 + §1.5 + §4.4 Go/No-Go F1）：
 *  1. SSRF 拒私网（与 browse_headless 同函数）
 *  2. 经 HeadlessChannel.browse(url, "pdf", opts) —— INV-33 衍生：不绕过 dispatch Map
 *  3. BrowseOptions.pdf_* 透传（format / landscape / print_background / margins）
 *  4. base64 PDF 过 applyOutputEnvelope 落 .pdf（INV-34 + INV-15 衍生）
 *  5. 大 PDF > 48 KiB → envelope.truncated=true + spill_path 形如 /tmp/lasso-output/@oN.pdf
 *  6. spill 文件 mode 0o600（owner rw only；INV-15 + INV-34 衍生）
 *  7. **Go/No-Go F1**：上游不支持 pdf 工具 → outcome=didnt + retrieval_method=upstream_unsupported:pdf + next_step
 *
 * 测试策略：
 *  - vi.mock("node:dns/promises") 让 ssrfGuard 走真实代码路径
 *  - 注入 mock HeadlessChannel，spy browse()；preview 模拟 base64 PDF 字符串
 *  - doPdfTool 直接调（不经 server.tool 装配）
 *  - 真实调 applyOutputEnvelope（不 mock；验 mode 0o600 / extension=.pdf）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { PdfOptions } from "../../src/types.js";
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

import { doPdfTool, isUpstreamPdfUnsupported } from "../../src/tools/pdf.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type {
  BrowseOptions,
  BrowseResult,
  InteractResult,
} from "../../src/types.js";
import {
  _resetForTests,
  MAX_BYTES,
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

const DEFAULT_OPTS: PdfOptions = {
  format: "A4",
  landscape: false,
  print_background: true,
  wait_until: "load",
  timeout_ms: 30_000,
};

function makeMockHeadless(
  browseMock: ReturnType<typeof vi.fn>,
): { headless: HeadlessChannel; browseMock: ReturnType<typeof vi.fn> } {
  const headless = {
    browse: browseMock,
  } as unknown as HeadlessChannel;
  return { headless, browseMock };
}

/** 构造一个 base64 PDF 字符串（n KiB；通过 base64 编码 ASCII 'x'*n*1024） */
function makeBase64Pdf(kib: number): string {
  const buf = Buffer.alloc(kib * 1024, 0x78); // 'x'
  return buf.toString("base64");
}

beforeEach(async () => {
  setDns(PUBLIC_IPS);
  await _resetForTests();
});

afterEach(async () => {
  await _resetForTests();
});

// ============================================================
// SSRF 守门（INV-31 衍生：pdf 必经 ssrfGuard）
// ============================================================
describe("pdf — SSRF 守门", () => {
  it("私网 10.x → outcome=didnt + retrieval_method=ssrf_blocked + browse 不被调", async () => {
    setDns(PRIVATE_IPS_10);
    const browseMock = vi.fn();
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
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
        action: "pdf",
        preview: makeBase64Pdf(1), // 1 KiB base64（< 48 KiB 不触发 spill）
      },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
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
// INV-33 衍生：经 HeadlessChannel.browse(url, "pdf", opts)
// ============================================================
describe("pdf — 经 BrowseChannel.browse 入口（INV-33）", () => {
  it("调 headless.browse(url, 'pdf', opts) —— 不绕过 dispatch Map", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: "abc" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(browseMock).toHaveBeenCalledWith(
      "https://example.com/",
      "pdf",
      expect.objectContaining({
        pdf_format: "A4",
        pdf_landscape: false,
        pdf_print_background: true,
      }),
    );
  });

  it("format / landscape / print_background 透传到 BrowseOptions.pdf_*", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: "abc" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    await doPdfTool(
      "https://example.com/",
      { ...DEFAULT_OPTS, format: "Letter", landscape: true, print_background: false },
      headless,
      EMPTY_CONFIG,
    );
    const opts = browseMock.mock.calls[0]![2] as BrowseOptions;
    expect(opts.pdf_format).toBe("Letter");
    expect(opts.pdf_landscape).toBe(true);
    expect(opts.pdf_print_background).toBe(false);
  });

  it("margins 透传（top/bottom/left/right）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: "abc" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    await doPdfTool(
      "https://example.com/",
      {
        ...DEFAULT_OPTS,
        margin_top: 0.5,
        margin_bottom: 0.5,
        margin_left: 0.25,
        margin_right: 0.25,
      },
      headless,
      EMPTY_CONFIG,
    );
    const opts = browseMock.mock.calls[0]![2] as BrowseOptions;
    expect(opts.pdf_margin_top).toBe(0.5);
    expect(opts.pdf_margin_bottom).toBe(0.5);
    expect(opts.pdf_margin_left).toBe(0.25);
    expect(opts.pdf_margin_right).toBe(0.25);
  });

  it("未传 margins → BrowseOptions 不含 pdf_margin_*（让 doPdf 用默认）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: "abc" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    const opts = browseMock.mock.calls[0]![2] as BrowseOptions;
    expect(opts.pdf_margin_top).toBeUndefined();
    expect(opts.pdf_margin_bottom).toBeUndefined();
  });
});

// ============================================================
// bounded output：base64 PDF 过 envelope 落 .pdf（INV-34 + INV-15 衍生）
// ============================================================
describe("pdf — base64 PDF 过 applyOutputEnvelope 落 .pdf", () => {
  it("小 PDF（< 48 KiB）→ envelope.truncated=false + preview 原样", async () => {
    const smallPdf = makeBase64Pdf(10); // 10 KiB < 48 KiB
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: smallPdf },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.envelope!.truncated).toBe(false);
    expect(r.data!.envelope!.preview).toBe(smallPdf);
    expect(r.data!.envelope!.ref).toBeUndefined();
    expect(r.data!.spill_path).toBeUndefined();
  });

  it("大 PDF（> 48 KiB）→ envelope.truncated=true + ref 形如 @oN + spill_path", async () => {
    const bigPdf = makeBase64Pdf(60); // 60 KiB > 48 KiB → spill
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: bigPdf },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.envelope!.truncated).toBe(true);
    expect(r.data!.envelope!.ref).toMatch(/^@o\d+$/);
    // spill_path = <os.tmpdir()>/lasso-output/@oN.pdf（守 R-CI-02：与 output-envelope.ts 同源）
    const expectedSpillPrefix = path.join(os.tmpdir(), "lasso-output") + "/";
    expect(r.data!.spill_path).toMatch(
      new RegExp(`^${expectedSpillPrefix.replace(/\//g, "\\/")}@o\\d+\\.pdf$`),
    );
    expect(r.data!.envelope!.continue_hint).toContain("read_text");
  });

  it("spill 文件扩展名是 .pdf（不是 .txt）", async () => {
    const bigPdf = makeBase64Pdf(60);
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: bigPdf },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.data!.spill_path).toMatch(/\.pdf$/);
    // 反向断言：不是 .txt
    expect(r.data!.spill_path).not.toMatch(/\.txt$/);
  });

  it("spill 文件 mode 0o600（INV-15 + INV-34 衍生）", async () => {
    const bigPdf = makeBase64Pdf(60);
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: bigPdf },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.data!.spill_path).toBeDefined();
    const st = await stat(r.data!.spill_path!);
    const permBits = st.mode & 0o777;
    expect(permBits).toBe(0o600);
  });

  it("retrieval_method=chrome_devtools_mcp_pdf（成功路径）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: "abc" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.retrieval_method).toBe("chrome_devtools_mcp_pdf");
  });
});

// ============================================================
// Go/No-Go F1：上游不支持 pdf 工具（parse6 §4.4 + §7.1）
// ============================================================
describe("pdf — Go/No-Go F1 上游不支持 pdf 工具", () => {
  it("browse 抛 upstream_pdf_error（cdp-actions 标准化前缀）→ outcome=didnt + upstream_unsupported:pdf", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "upstream_pdf_error:tool_call_failed:Error: Unknown tool: pdf",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("upstream_unsupported:pdf");
    expect(r.data!.next_step).toBeDefined();
    expect(r.data!.next_step).toContain("chrome-devtools-mcp");
  });

  it("browse 抛 'Unknown tool: pdf'（无 cdp-actions 包装）→ outcome=didnt + upstream_unsupported:pdf", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "Unknown tool: pdf",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("upstream_unsupported:pdf");
    expect(r.data!.next_step).toBeDefined();
  });

  it("isUpstreamPdfUnsupported 识别各类上游不支持错误", () => {
    expect(isUpstreamPdfUnsupported("upstream_pdf_error:empty_response")).toBe(true);
    expect(isUpstreamPdfUnsupported("upstream_pdf_error:is_error:foo")).toBe(true);
    expect(isUpstreamPdfUnsupported("Unknown tool: pdf")).toBe(true);
    expect(isUpstreamPdfUnsupported("Tool pdf not found in registry")).toBe(true);
    expect(isUpstreamPdfUnsupported("tool PDF not found")).toBe(true);
    // 反向：非上游不支持的错误不命中
    expect(isUpstreamPdfUnsupported("timeout")).toBe(false);
    expect(isUpstreamPdfUnsupported("NEEDS_MANUAL_2FA")).toBe(false);
    expect(isUpstreamPdfUnsupported(undefined)).toBe(false);
  });

  it("其他错误（timeout / network）→ 不命中 upstream_unsupported，透传 outcome=unknown", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "navigate timeout",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).not.toBe("upstream_unsupported:pdf");
    expect(r.error).toBe("navigate timeout");
  });

  it("next_step 提示包含本地 Chrome fallback 路径", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "unknown",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "upstream_pdf_error:tool_call_failed",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.data!.next_step).toContain("--print-to-pdf");
  });
});

// ============================================================
// 边界（parse6 §6.5）
// ============================================================
describe("pdf — 边界", () => {
  it("browse outcome=didnt（非上游不支持）→ pdf 透传 didnt（如 404）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "didnt",
      data: null,
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
      error: "navigation_404",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/missing",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).not.toBe("upstream_unsupported:pdf");
    expect(r.error).toBe("navigation_404");
  });

  it("browse outcome=worked 但 preview 空 → envelope=undefined（不抛错）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: "" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.envelope).toBeUndefined();
  });

  it("fallback 透传（browse_logged_in 接管）", async () => {
    const browseMock = vi.fn().mockResolvedValue({
      outcome: "worked",
      data: { url: "https://example.com/", action: "pdf", preview: "abc" },
      served_by: "browse_logged_in",
      fallback_used: true,
      retrieval_method: "chrome_devtools_mcp",
    } satisfies InteractResult<BrowseResult>);
    const { headless } = makeMockHeadless(browseMock);
    const r = await doPdfTool(
      "https://example.com/",
      DEFAULT_OPTS,
      headless,
      EMPTY_CONFIG,
    );
    expect(r.fallback_used).toBe(true);
    expect(r.served_by).toBe("browse_logged_in");
  });
});
