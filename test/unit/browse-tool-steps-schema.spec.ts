/**
 * browse-tool-steps-schema.spec.ts（D2 修复，v1.8 Phase D）
 *
 * 守护点：browse_headless / browse_logged_in 的 zod options schema 必须含 steps 键
 * —— BrowseChannel v0.3 起已实装 steps 分流（options.steps 非空 → StepEngine.runChain，
 * U-03 多步链），但 tools/browse.ts schema 缺此键 → MCP 入参被 zod strip →
 * 多步链经 MCP 永远不可达（调用被静默降级为单 action snapshot）。
 *
 * 测试策略（与 desktop-tool-schema.spec.ts D8 同范式）：
 *  - mock McpServer 捕获 server.tool(...) 的 ZodRawShape → z.object(...).parse
 *    （SDK 同款解析路径）断言 steps 不被 strip
 *  - handler 端到端：解析后的 args → 真 FallbackDecider + stub HeadlessChannel
 *    → 断言 channel.browse 收到的 options.steps 与入参逐字段一致（StepEngine 输入形状）
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";
import { registerBrowseTools } from "../../src/tools/browse.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import type { BrowseResult, InteractResult } from "../../src/types.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";

// SSRF 用 stub——绕过 DNS lookup 让任何 URL 都通过（fallback.spec.ts 同范式）
const ALWAYS_OK_SSRF: SsrfConfig = { allowRanges: [], denyRanges: [] };
vi.mock("../../src/ssrf/ssrf-guard.js", () => ({
  ssrfGuard: vi.fn(async () => ({
    allowed: true,
    reason: "stub_ok",
    resolvedIps: ["127.0.0.1"],
  })),
  loadSsrfConfig: vi.fn(() => ALWAYS_OK_SSRF),
}));

/** mock McpServer：捕获 server.tool 的 name/schema/handler。 */
function makeCaptureServer() {
  const captured: {
    name: string;
    schema: Record<string, unknown>;
    handler: (args: never) => Promise<unknown>;
  }[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _desc: string,
        schema: Record<string, unknown>,
        _ann: unknown,
        handler: (args: never) => Promise<unknown>,
      ) => {
        captured.push({ name, schema, handler });
        return { enabled: true, disable() {}, enable() {}, remove() {}, update() {} };
      },
    ),
    sendToolListChanged: vi.fn(),
  };
  return { server, captured };
}

const STEPS_INPUT = [
  {
    action: "navigate",
    selectors: { url: "https://example.com" },
  },
  {
    action: "click",
    selectors: { uid: "login-btn" },
    expect: { text: "Signed in", timeout_ms: 5000 },
    timeout_ms: 8000,
    label: "click login",
  },
  {
    action: "evaluate",
    js: "() => document.title",
  },
];

function makeStubChannels() {
  const browseCalls: Array<{
    url: string;
    action: string;
    opts: Record<string, unknown>;
  }> = [];
  const okResult = (): InteractResult<BrowseResult> => ({
    outcome: "worked",
    data: {
      url: "https://example.com",
      action: "steps",
      preview: "stub",
    },
    served_by: "browse_headless",
    fallback_used: false,
    retrieval_method: "stub",
  });
  const headless = {
    name: "browse_headless",
    browse: vi.fn(async (url: string, action: string, opts: Record<string, unknown>) => {
      browseCalls.push({ url, action, opts });
      return okResult();
    }),
  };
  const logged_in = {
    name: "browse_logged_in",
    browse: vi.fn(async () => okResult()),
  };
  return { headless, logged_in, browseCalls };
}

describe("browse tool schema — D2 steps 多步链经 MCP 可达", () => {
  it("schema 解析（zod，SDK 同款路径）不 strip options.steps", () => {
    const { server, captured } = makeCaptureServer();
    const { headless, logged_in } = makeStubChannels();
    registerBrowseTools(
      server as unknown as McpServer,
      headless as unknown as HeadlessChannel,
      logged_in as unknown as LoggedInChannel,
      new FallbackDecider(
        new Map<string, CircuitBreaker>([
          ["browse_headless", new CircuitBreaker()],
          ["browse_logged_in", new CircuitBreaker()],
        ]),
      ),
      ALWAYS_OK_SSRF,
    );
    expect(captured.map((c) => c.name)).toEqual(
      expect.arrayContaining(["browse_headless", "browse_logged_in"]),
    );
    for (const cap of captured) {
      const parsed = z.object(cap.schema as never).parse({
        url: "https://example.com",
        action: "steps",
        options: { steps: STEPS_INPUT },
      }) as { options: { steps?: unknown } };
      // D2 核心：steps 不被 strip（修复前 unknown key 被静默丢弃 → 恒单 action）
      expect(parsed.options.steps).toBeDefined();
      expect(parsed.options.steps).toHaveLength(3);
    }
  });

  it("handler 端到端：带 steps 的请求 → HeadlessChannel.browse 收到完整 steps（StepEngine 输入）", async () => {
    const { server, captured } = makeCaptureServer();
    const { headless, logged_in, browseCalls } = makeStubChannels();
    registerBrowseTools(
      server as unknown as McpServer,
      headless as unknown as HeadlessChannel,
      logged_in as unknown as LoggedInChannel,
      new FallbackDecider(
        new Map<string, CircuitBreaker>([
          ["browse_headless", new CircuitBreaker()],
          ["browse_logged_in", new CircuitBreaker()],
        ]),
      ),
      ALWAYS_OK_SSRF,
    );
    const headlessCap = captured.find((c) => c.name === "browse_headless")!;
    const parsed = z.object(headlessCap.schema as never).parse({
      url: "https://example.com",
      action: "steps",
      options: { steps: STEPS_INPUT },
    }) as never;
    const res = (await headlessCap.handler(parsed)) as {
      content: Array<{ type: string; text: string }>;
    };
    const result = JSON.parse(res.content[0]!.text) as { outcome: string };
    expect(result.outcome).toBe("worked");
    expect(browseCalls).toHaveLength(1);
    // StepEngine 输入形状逐字段断言（selectors/js/expect/timeout_ms/label 全保留）
    expect(browseCalls[0]!.opts.steps).toEqual(STEPS_INPUT);
    expect(headless.browse).toHaveBeenCalledWith(
      "https://example.com",
      "steps",
      expect.objectContaining({ steps: STEPS_INPUT }),
    );
  });
});

// ============================================================
// v1.17 Phase F（parse24 §6.2 C2）：include_refs 经 MCP 可达（D2 同范式守护）
// ============================================================
describe("browse tool schema — include_refs 不被 zod strip（C2 MCP 可达性）", () => {
  it("schema 解析保留 options.include_refs（true/false 均通过）", () => {
    const { server, captured } = makeCaptureServer();
    const { headless, logged_in } = makeStubChannels();
    registerBrowseTools(
      server as unknown as McpServer,
      headless as unknown as HeadlessChannel,
      logged_in as unknown as LoggedInChannel,
      new FallbackDecider(
        new Map<string, CircuitBreaker>([
          ["browse_headless", new CircuitBreaker()],
          ["browse_logged_in", new CircuitBreaker()],
        ]),
      ),
      ALWAYS_OK_SSRF,
    );
    for (const cap of captured) {
      const parsed = z.object(cap.schema as never).parse({
        url: "https://example.com",
        action: "extract",
        options: { extract_mode: "markdown", include_refs: true },
      }) as { options: { include_refs?: boolean } };
      expect(parsed.options.include_refs).toBe(true);
    }
  });

  it("handler 端到端：include_refs=true → channel.browse 收到该字段", async () => {
    const { server, captured } = makeCaptureServer();
    const { headless, logged_in, browseCalls } = makeStubChannels();
    registerBrowseTools(
      server as unknown as McpServer,
      headless as unknown as HeadlessChannel,
      logged_in as unknown as LoggedInChannel,
      new FallbackDecider(
        new Map<string, CircuitBreaker>([
          ["browse_headless", new CircuitBreaker()],
          ["browse_logged_in", new CircuitBreaker()],
        ]),
      ),
      ALWAYS_OK_SSRF,
    );
    const headlessCap = captured.find((c) => c.name === "browse_headless")!;
    const parsed = z.object(headlessCap.schema as never).parse({
      url: "https://example.com",
      action: "extract",
      options: { extract_mode: "markdown", include_refs: true },
    }) as never;
    await headlessCap.handler(parsed);
    expect(browseCalls[0]!.opts.include_refs).toBe(true);
  });

  it("缺省（不传 include_refs）→ channel.browse 收到 undefined（byte-identical 基线）", async () => {
    const { server, captured } = makeCaptureServer();
    const { headless, logged_in, browseCalls } = makeStubChannels();
    registerBrowseTools(
      server as unknown as McpServer,
      headless as unknown as HeadlessChannel,
      logged_in as unknown as LoggedInChannel,
      new FallbackDecider(
        new Map<string, CircuitBreaker>([
          ["browse_headless", new CircuitBreaker()],
          ["browse_logged_in", new CircuitBreaker()],
        ]),
      ),
      ALWAYS_OK_SSRF,
    );
    const headlessCap = captured.find((c) => c.name === "browse_headless")!;
    const parsed = z.object(headlessCap.schema as never).parse({
      url: "https://example.com",
      action: "extract",
      options: { extract_mode: "markdown" },
    }) as never;
    await headlessCap.handler(parsed);
    expect(browseCalls[0]!.opts.include_refs).toBeUndefined();
  });
});
