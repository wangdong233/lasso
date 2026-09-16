/**
 * browse_headed 工具入口 SSRF 端到端（对抗复审 r3 F1/F3，2026-09-16）
 *
 * 背景：headed-channel.spec.ts 的工具段整体 vi.mock 了 ssrf-guard
 * （ALWAYS_OK_SSRF）——通道/生命周期被钉，但【安全接线零钉死】：变异验证
 * （M-I）实证「整段删除 headed.ts 的 SSRF 门 → 全套 3087 测仍绿」。这打破
 * 了工具族既有不变量：browse_headless / browse_logged_in（file-guard.spec §5
 * 真 guard 端到端）与 network / fetch_url / screenshot / pdf / fetch_feed
 * （served_by:"lasso.ssr_guard" 断言）每入口都有真守卫钉。本文件补齐 parity：
 * 真 ssrfGuard / checkFileUrl / fileGuardHint，不 mock。
 *
 * 钉三面：
 *  1. 私网 IP（http 字面量，无 DNS）→ didnt + ssrf_blocked:private_ip:* +
 *     channel.browse 零调用（安全三层第 1 层：私网 URL 绝不让 MCP 子进程看到）；
 *  2. file:// 默认拒 → protocol_not_allowed:file: + opt-in hint
 *     （r3 F3：与 browse_headless 入口字节一致——BUG-05 B3 同款 additive hint）；
 *  3. allowlist 放行的 127.0.0.1 → 门放行到达 channel（接线不误伤 +
 *     window_opened:true 回显仍走 headedResultContent 装配）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHeadedTool } from "../../src/tools/headed.js";
import type { HeadedChannel } from "../../src/channels/HeadedChannel.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import type { InteractResult, BrowseResult } from "../../src/types.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";

// —— 真 SsrfConfig（无任何 mock；与 file-guard.spec §5 同范式）——
const DEFAULT_CFG: SsrfConfig = { allowRanges: [], denyRanges: [] };
const ALLOW_LOOPBACK: SsrfConfig = { allowRanges: ["127.0.0.1/32"], denyRanges: [] };

// —— file:// 用例的真实临时文件（checkFileUrl 诚实前置：不存在会先报
//    file_url_not_found 而非 allowlist 拒——用真文件钉住正确分支）——
let allowDir: string;
beforeAll(() => {
  allowDir = mkdtempSync(path.join(tmpdir(), "headed-ssrf-entry-"));
  writeFileSync(path.join(allowDir, "page.html"), "<html><body>ok</body></html>");
});
afterAll(() => {
  rmSync(allowDir, { recursive: true, force: true });
});

function makeCaptureServer() {
  const captured: Array<{
    name: string;
    handler: (args: never, extra: unknown) => Promise<unknown>;
  }> = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _desc: string,
        _schema: unknown,
        _ann: unknown,
        handler: (args: never, extra: unknown) => Promise<unknown>,
      ) => {
        captured.push({ name, handler });
        return { enabled: true, disable() {}, enable() {}, remove() {}, update() {} };
      },
    ),
    sendToolListChanged: vi.fn(),
  } as unknown as McpServer;
  return { server, captured };
}

function makeStubHeaded() {
  const browseMock = vi.fn(async () => ({
    outcome: "worked" as const,
    data: { preview: "stub-channel-reached" } as unknown as BrowseResult,
    served_by: "browse_headed",
    fallback_used: false,
    retrieval_method: "chrome_devtools_mcp_headed",
  }));
  const headed = { browse: browseMock } as unknown as HeadedChannel;
  return { headed, browseMock };
}

async function callTool(cfg: SsrfConfig, args: Record<string, unknown>) {
  const { server, captured } = makeCaptureServer();
  const { headed, browseMock } = makeStubHeaded();
  registerHeadedTool(server, headed, new FallbackDecider(new Map()), cfg);
  expect(captured).toHaveLength(1);
  expect(captured[0].name).toBe("browse_headed");
  const res = (await captured[0].handler(args as never, undefined)) as {
    content: Array<{ text: string }>;
  };
  const payload = JSON.parse(res.content[0]!.text) as InteractResult<never> & {
    hint?: string;
  };
  return { payload, browseMock };
}

describe("对抗复审 r3 — browse_headed 工具入口 SSRF 端到端（真守卫不 mock）", () => {
  it("私网 IP http 字面量 → didnt + ssrf_blocked:private_ip:* + channel 零调用（M-I 变异钉）", async () => {
    const { payload, browseMock } = await callTool(DEFAULT_CFG, {
      url: "http://192.168.1.1/",
      action: "snapshot",
    });
    expect(payload.outcome).toBe("didnt");
    expect(payload.served_by).toBe("lasso.ssr_guard");
    expect(payload.retrieval_method).toBe("ssrf_blocked");
    expect(payload.error).toBe("ssrf_blocked:private_ip:192.168.1.1");
    expect(browseMock).not.toHaveBeenCalled();
  });

  it("file:// 默认（空白名单）→ protocol_not_allowed:file: + opt-in hint（F3 parity：与 browse_headless 入口一致）", async () => {
    const { payload, browseMock } = await callTool(DEFAULT_CFG, {
      url: `file://${path.join(allowDir, "page.html")}`,
      action: "snapshot",
    });
    expect(payload.outcome).toBe("didnt");
    expect(payload.served_by).toBe("lasso.ssr_guard");
    expect(payload.error).toBe("ssrf_blocked:protocol_not_allowed:file:");
    expect(payload.hint).toContain("LASSO_ALLOW_FILE_FROM");
    expect(browseMock).not.toHaveBeenCalled();
  });

  it("allowlist 放行 127.0.0.1/32 → 门放行到达 channel（接线不误伤）+ window_opened:true 回显", async () => {
    const { payload, browseMock } = await callTool(ALLOW_LOOPBACK, {
      url: "http://127.0.0.1:9222/json/version",
      action: "snapshot",
    });
    expect(browseMock).toHaveBeenCalledTimes(1);
    expect(payload.outcome).toBe("worked");
    expect(payload.data).toMatchObject({ window_opened: true });
  });
});
