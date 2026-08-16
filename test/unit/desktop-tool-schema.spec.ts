/**
 * desktop-tool-schema.spec.ts（D8 修复，v1.8 Phase C）
 *
 * 守护点：tools/desktop.ts 的 zod options schema 必须包含
 * appleScriptAction / appleScriptParams 两键 —— 此前缺失导致 MCP 入参被
 * zod strip，AppleScriptProvider 恒走 missing_applescript_action 分支，
 * 档 2（desktop.appleScript）经 MCP 不可达（wave1 T-DESKTOP-20 采证）。
 *
 * 测试策略（mock 跟着真实 MCP SDK 契约走）：
 *  - mock McpServer 捕获 server.tool(name, desc, schemaShape, annotations, handler)
 *  - 用捕获的 ZodRawShape 重建 z.object(...).parse(...)（SDK 同款解析路径）
 *  - 断言 appleScriptAction 解析后**不被 strip**
 *  - handler 端到端：解析后的 args → 真 DesktopChannel 4-tier 链 →
 *    断言到达档 2（rust 收到 applescript_run，action=system_get_uptime，
 *    白名单通过路径）
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { DesktopChannel } from "../../src/channels/DesktopChannel.js";
import { AxProvider } from "../../src/desktop/AxProvider.js";
import { MacAxBackend } from "../../src/desktop/AxBackend.js";
import { ScreenshotVlmProvider } from "../../src/desktop/ScreenshotVlmProvider.js";
import { AppleScriptProvider } from "../../src/desktop/AppleScriptProvider.js";
import { CGEventProvider } from "../../src/desktop/CGEventProvider.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { registerDesktopTool } from "../../src/tools/desktop.js";
import { MockRustBridge } from "./mocks/mock-rust-bridge.js";

// ============================================================
// 装配（与 desktop-action-enum.spec.ts 同范式；rust 是 mock，链是真）
// ============================================================
function assemble(
  scripts: Record<string, (params: unknown) => unknown> = {},
) {
  const rust = new MockRustBridge(scripts);
  const ax = new AxProvider(new MacAxBackend(rust as unknown as never));
  const vlm = new ScreenshotVlmProvider(rust as unknown as never, {
    endpoint: null,
    vlmCaller: null,
  });
  const apple = new AppleScriptProvider(rust as unknown as never);
  const cg = new CGEventProvider(rust as unknown as never);
  const breakers = new Map<string, CircuitBreaker>([
    ["desktop.ax", new CircuitBreaker()],
    ["desktop.appleScript", new CircuitBreaker()],
    ["desktop.cgEvent", new CircuitBreaker()],
    ["desktop.screenshotVlm", new CircuitBreaker()],
  ]);
  const desktop = new DesktopChannel(
    rust as unknown as never,
    ax,
    vlm,
    apple,
    cg,
    new FallbackDecider(breakers),
    breakers,
  );
  return { desktop, rust };
}

/** mock McpServer：捕获 server.tool 的 5 参（name/desc/schema/annotations/handler）。 */
function makeCaptureServer() {
  const captured: {
    name: string;
    schema: Record<string, unknown>;
    handler: (args: never) => Promise<unknown>;
  }[] = [];
  const server = {
    tool: vi.fn(
      (name: string, _desc: string, schema: Record<string, unknown>, _ann: unknown, handler: (args: never) => Promise<unknown>) => {
        captured.push({ name, schema, handler });
        return { enabled: true, disable() {}, enable() {}, remove() {}, update() {} };
      },
    ),
    sendToolListChanged: vi.fn(),
  };
  return { server, captured };
}

// ============================================================
// D8：appleScriptAction / appleScriptParams 补进 schema
// ============================================================
describe("desktop tool schema — D8 appleScript 档两键可达", () => {
  it("schema 解析（zod，SDK 同款路径）不 strip appleScriptAction / appleScriptParams", () => {
    const { server, captured } = makeCaptureServer();
    const { desktop } = assemble({ ping: () => ({ pong: true }) });
    registerDesktopTool(server as never, desktop);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.name).toBe("desktop");
    // 用捕获的 ZodRawShape 重建 schema 解析（MCP SDK 对 tool 入参同款 zod parse）
    const parsed = z.object(captured[0]!.schema as never).parse({
      action: "act",
      options: {
        appleScriptAction: "system_get_uptime",
        appleScriptParams: {},
      },
    }) as { action: string; options: Record<string, unknown> };
    // D8 核心：两键不被 strip（修复前 unknown key 被静默丢弃）
    expect(parsed.options.appleScriptAction).toBe("system_get_uptime");
    expect(parsed.options.appleScriptParams).toEqual({});
  });

  it("handler 端到端：appleScriptAction=system_get_uptime → 到达档 2（applescript_run，白名单通过路径）", async () => {
    // ax 抛错（unknown）强制链进档 2；appleScript 白名单通过 → worked
    const { rust, desktop } = assemble({
      ping: () => ({ pong: true, version: "0.1.0-test", tcc: {} }),
      ax_act: () => {
        throw new Error("ax_forced_fail");
      },
      applescript_run: () => ({
        action: "system_get_uptime",
        stdout: "10 days",
        stderr: "",
        exit_code: 0,
      }),
    });
    const { server, captured } = makeCaptureServer();
    registerDesktopTool(server as never, desktop);

    const parsed = z.object(captured[0]!.schema as never).parse({
      action: "act",
      options: {
        appleScriptAction: "system_get_uptime",
        appleScriptParams: {},
      },
    }) as never;
    const res = (await captured[0]!.handler(parsed)) as {
      content: Array<{ type: string; text: string }>;
    };
    const result = JSON.parse(res.content[0]!.text) as {
      outcome: string;
      actions_and_results: Array<{ channel: string }>;
    };
    // 到达档 2 且 worked（ax unknown → appleScript worked，链停）
    expect(result.outcome).toBe("worked");
    const channels = result.actions_and_results.map((a) => a.channel);
    expect(channels).toContain("desktop.appleScript");
    expect(channels[channels.length - 1]).toBe("desktop.appleScript");
    // 白名单通过路径：rust 真收到 applescript_run + action
    const run = rust.calls.find((c) => c.method === "applescript_run");
    expect(run).toBeTruthy();
    expect(run?.params).toMatchObject({ action: "system_get_uptime" });
    expect(rust.calls.filter((c) => c.method === "screenshot")).toHaveLength(0);
  });

  it("appleScriptParams 值保持对象形状（z.record 而非 strip 成 unknown）", () => {
    const { server, captured } = makeCaptureServer();
    const { desktop } = assemble({ ping: () => ({ pong: true }) });
    registerDesktopTool(server as never, desktop);
    const parsed = z.object(captured[0]!.schema as never).parse({
      action: "act",
      options: {
        appleScriptAction: "finder_new_folder",
        appleScriptParams: { name: "hello" },
      },
    }) as { options: Record<string, unknown> };
    expect(parsed.options.appleScriptParams).toEqual({ name: "hello" });
  });
});

// ============================================================
// T3-3（round3 v1.13）：where.ref 静默忽略根治（zod 删字段 + Rust 兜底）
// 旧缺陷：zod 收 where.ref 却无人消费 → 纯 ref 查询全节点命中 + ok:true。
// ============================================================
describe("T3-3 — where.ref 删字段（find 需要 text 或 role）", () => {
  it("zod strip：where.ref 不再是 schema 字段（多传被剥，parsed where 为空对象）", () => {
    const { server, captured } = makeCaptureServer();
    const { desktop } = assemble({ ping: () => ({ pong: true }) });
    registerDesktopTool(server as never, desktop);

    const parsed = z.object(captured[0]!.schema as never).parse({
      action: "find",
      options: { where: { ref: "@e5" } },
    }) as { options: { where: Record<string, unknown> } };
    // zod 默认 strip 未知键：ref 被剥 → 空 where（Rust 兜底 invalid_params 的前置路径）
    expect(parsed.options.where).toEqual({});
  });

  it("wire 形状：空 where 原样到达 ax_find（Rust 兜底接管，TS 层不吞不改）", async () => {
    const { rust, desktop } = assemble({
      ax_find: () => ({ matches: [], count: 0 }),
    });
    await desktop.observe("find", { where: {} });
    const call = rust.calls.find((c) => c.method === "ax_find");
    expect(call).toBeTruthy();
    expect(call!.params).toEqual({ app: undefined, max_depth: 8, where: {} });
  });

  it("schema 源码：where object 只声明 text/role（ref 已删；expect.ref 不受影响）", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../../src/tools/desktop.ts", import.meta.url)),
      "utf8",
    );
    const whereBlock = src.match(/where:\s*z\s*\.\s*object\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(whereBlock).toContain("text");
    expect(whereBlock).toContain("role");
    expect(whereBlock).not.toMatch(/\bref:\s*z\./);
    // expect 的 ref 保留（round3 拒绝清单：expect.ref 现状已闭环）
    const expectBlock = src.match(/expect:\s*z\s*\.\s*object\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(expectBlock).toMatch(/\bref:\s*z\./);
  });
});
