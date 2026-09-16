/**
 * fallback-cross-channel.spec.ts（W2 C3，doc/bugs/09 决议 C3，2026-09-16）
 *
 * 守护 browse_headless→browse_logged_in 跨通道 fallback 边默认移除 + 逃生门：
 *  1. 默认（未传/false）：url 在场 plan.fallbacks = []（terminal——登录态通道
 *     须用户显式选择，INV-23 精神扩展；v1.26.0 行为此处为 ["browse_logged_in"]）
 *  2. 逃生门（true，装配层传 config.crossChannelFallback ←
 *     LASSO_FALLBACK_CROSS_CHANNEL=1）：fallbacks = ["browse_logged_in"]（一键
 *     恢复旧行为——§6 breaking 缓解「一键恢复开关」红线）
 *  3. url 缺省（current-page）：两态都钉通道 fallbacks = []（BUG-07 A⁺ 不变）
 *  4. config 解析：默认 false；1/true/yes/on 开
 *
 * mock 策略（browse-tool-steps-schema.spec.ts 同范式）：capture server +
 * ssrf stub（不触网）+ stub channels + 真 FallbackDecider（runWithFallback
 * spy——断言的是 plan 而非执行）。
 */
import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";
import { registerBrowseTools } from "../../src/tools/browse.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import {
  parseCrossChannelFallback,
  loadConfig,
} from "../../src/config/config.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";
import type { BrowseResult, InteractResult } from "../../src/types.js";

const ALWAYS_OK_SSRF: SsrfConfig = { allowRanges: [], denyRanges: [] };
vi.mock("../../src/ssrf/ssrf-guard.js", () => ({
  ssrfGuard: vi.fn(async () => ({
    allowed: true,
    reason: "stub_ok",
    resolvedIps: ["93.184.216.34"],
  })),
  loadSsrfConfig: vi.fn(() => ALWAYS_OK_SSRF),
}));

function makeCaptureServer() {
  const captured: {
    name: string;
    handler: (args: never, extra: unknown) => Promise<unknown>;
  }[] = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _desc: string,
        _schema: Record<string, unknown>,
        _ann: unknown,
        handler: (args: never, extra: unknown) => Promise<unknown>,
      ) => {
        captured.push({ name, handler });
        return { enabled: true, disable() {}, enable() {}, remove() {}, update() {} };
      },
    ),
  };
  return { server: server as unknown as McpServer, captured };
}

const WORKED: InteractResult<BrowseResult> = {
  outcome: "worked",
  data: null,
  served_by: "browse_headless",
  fallback_used: false,
  retrieval_method: "test",
};

function makeStubChannels() {
  const headless = { name: "browse_headless", browse: vi.fn(async () => WORKED) };
  const logged_in = { name: "browse_logged_in", browse: vi.fn(async () => WORKED) };
  return {
    headless: headless as unknown as HeadlessChannel,
    logged_in: logged_in as unknown as LoggedInChannel,
    headlessMock: headless.browse,
    loggedInMock: logged_in.browse,
  };
}

/** 注册 + 捕获 plan（runWithFallback spy：直接回传执行器首通道结果）。 */
async function capturePlan(crossChannelFallback: boolean, url: string | undefined) {
  const { server, captured } = makeCaptureServer();
  const chans = makeStubChannels();
  const decider = new FallbackDecider(new Map());
  const spy = vi
    .spyOn(decider, "runWithFallback")
    .mockImplementation(async (plan, exec) => exec(plan.primary));
  registerBrowseTools(
    server,
    chans.headless,
    chans.logged_in,
    decider,
    ALWAYS_OK_SSRF,
    null,
    crossChannelFallback,
  );
  const headlessHandler = captured.find((c) => c.name === "browse_headless")!.handler;
  await headlessHandler(
    { url, action: "snapshot", options: {} } as never,
    { _meta: {} },
  );
  const plan = spy.mock.calls[0][0] as { primary: string; fallbacks: string[] };
  return { plan, captured };
}

describe("C3 — browse_headless 跨通道 fallback 边默认移除 + 逃生门", () => {
  it("默认：url 在场 plan.fallbacks = []（terminal；v1.26.0 为 [browse_logged_in]）", async () => {
    const { plan } = await capturePlan(false, "https://example.com/");
    expect(plan.primary).toBe("browse_headless");
    expect(plan.fallbacks).toEqual([]);
  });

  it("逃生门开（true）：fallbacks = [browse_logged_in]（一键恢复 v1.26.0 行为）", async () => {
    const { plan } = await capturePlan(true, "https://example.com/");
    expect(plan.fallbacks).toEqual(["browse_logged_in"]);
  });

  it("url 缺省（current-page）：两态都钉通道（BUG-07 A⁺ 不变）", async () => {
    const off = await capturePlan(false, undefined);
    expect(off.plan.fallbacks).toEqual([]);
    const on = await capturePlan(true, undefined);
    expect(on.plan.fallbacks).toEqual([]);
  });

  it("两工具仍各注册恰好一次（INV-1 面）：browse_headless + browse_logged_in", async () => {
    const { captured } = await capturePlan(false, undefined);
    expect(captured.filter((c) => c.name === "browse_headless")).toHaveLength(1);
    expect(captured.filter((c) => c.name === "browse_logged_in")).toHaveLength(1);
  });
});

describe("C3 — config 解析", () => {
  it("parseCrossChannelFallback：默认 false；1/true/yes/on 开；其余关", () => {
    expect(parseCrossChannelFallback(undefined)).toBe(false);
    expect(parseCrossChannelFallback("")).toBe(false);
    expect(parseCrossChannelFallback("1")).toBe(true);
    expect(parseCrossChannelFallback("true")).toBe(true);
    expect(parseCrossChannelFallback("YES")).toBe(true);
    expect(parseCrossChannelFallback("on")).toBe(true);
    expect(parseCrossChannelFallback("0")).toBe(false);
    expect(parseCrossChannelFallback("false")).toBe(false);
  });

  it("loadConfig：默认 false；LASSO_FALLBACK_CROSS_CHANNEL=1 → true", () => {
    expect(loadConfig({ runId: "t", env: {} }).crossChannelFallback).toBe(false);
    expect(
      loadConfig({ runId: "t", env: { LASSO_FALLBACK_CROSS_CHANNEL: "1" } })
        .crossChannelFallback,
    ).toBe(true);
    expect(
      loadConfig({ runId: "t", env: { LASSO_FALLBACK_CROSS_CHANNEL: "nope" } })
        .crossChannelFallback,
    ).toBe(false);
  });
});
