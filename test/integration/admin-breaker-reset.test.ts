/**
 * admin-breaker-reset.spec.ts（D7 修复，v1.8 Phase D）
 *
 * 守护点：admin action 枚举缺 breaker_reset（wave1 T-FALL-03：enum 无此值，
 * zod 即拒）—— 熔断 open 后除等 resetMs 自然老化外无手工唤醒手段。
 *
 * 修复：admin action-enum 加 breaker_reset（mutation 必传 name + reason），
 * 对同名 channel 的短熔断（CircuitBreaker.reset，本版补齐）与长熔断
 * （LongCircuitBreaker.reset，v0.7 已有）同时复位到 closed。
 *
 * 测试策略（observ-admin-action.test.ts 同范式）：ToolManager + 真 CapabilityBag
 * + registerAdminTool 装配链，经 admin handler 调用：
 *  1. open 状态 reset 后 closed（短 + 长）
 *  2. 未知 channel 名 → ok=false 结构化错误
 *  3. 缺 reason → fail（mutation 强制思考）
 *  4. schema（zod enum）接受 breaker_reset
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CapabilityBag } from "../../src/runtime/CapabilityBag.js";
import { ToolManager } from "../../src/runtime/ToolManager.js";
import { CallerTierTracker } from "../../src/runtime/CallerTierTracker.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { LongCircuitBreaker } from "../../src/fallback/LongCircuitBreaker.js";
import { registerAdminTool, adminSchema } from "../../src/tools/admin.js";
import { ProviderRegistry } from "../../src/config/provider-registry.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";

function makeMockServer() {
  const server = {
    tool: vi.fn((_name: string) => {
      return {
        enabled: true,
        disable: () => {},
        enable: () => {},
        remove: () => {},
        update: () => {},
        handler: vi.fn(),
      } as unknown as RegisteredTool;
    }),
    sendToolListChanged: vi.fn(() => {}),
  } as unknown as McpServer;
  return server;
}

async function callAdmin(
  tm: ToolManager,
  args: Record<string, unknown>,
): Promise<{
  ok: boolean;
  action: string;
  [k: string]: unknown;
}> {
  const adminRec = (tm as unknown as {
    tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
  }).tools.get("admin")!;
  const result = (await adminRec.handler(args)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    action: string;
    [k: string]: unknown;
  };
}

/** 组装 open 状态的短 + 长熔断（同名 channel）。 */
async function makeOpenBreakers() {
  const short = new CircuitBreaker(); // threshold=3
  short.recordFailure();
  short.recordFailure();
  short.recordFailure();
  // threshold=1：一次失败即 open（避免默认 10 次循环）
  const long = new LongCircuitBreaker(1, 3_600_000, 3_600_000, undefined, "test");
  await long.recordFailure();
  const breakers = new Map<string, CircuitBreaker>([["browse_headless", short]]);
  const longBreakers = new Map<string, LongCircuitBreaker>([["browse_headless", long]]);
  if (short.state !== "open" || long.state !== "open") {
    throw new Error("test setup failed: breakers not open");
  }
  return { short, long, breakers, longBreakers };
}

describe("admin breaker_reset — D7 熔断手工唤醒", () => {
  it("open 状态（短+长）reset 后 closed", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);
    const { short, long, breakers, longBreakers } = await makeOpenBreakers();

    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      breakers,
      longBreakers,
    });

    const r = await callAdmin(tm, {
      action: "breaker_reset",
      name: "browse_headless",
      reason: "upstream recovered; manual wake-up after incident",
    });
    expect(r.ok).toBe(true);
    expect(r.reset_short).toBe(true);
    expect(r.reset_long).toBe(true);
    expect(r.before).toEqual({ short: "open", long: "open" });
    // D7 核心断言：reset 后两个 breaker 均 closed
    expect(short.state).toBe("closed");
    expect(long.state).toBe("closed");
    expect(short.failureCountReadOnly).toBe(0);
    expect(long.windowFailureCount).toBe(0);
  });

  it("只配了短熔断的 channel 也能 reset（reset_long=false 不误报）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["search.zhipu"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);
    const { short, breakers } = await makeOpenBreakers();
    // 只注入短熔断 map（长熔断 map 缺省）

    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      breakers,
    });

    const r = await callAdmin(tm, {
      action: "breaker_reset",
      name: "browse_headless",
      reason: "short only",
    });
    expect(r.ok).toBe(true);
    expect(r.reset_short).toBe(true);
    expect(r.reset_long).toBe(false);
    expect(short.state).toBe("closed");
  });

  it("未知 channel 名 → ok=false 结构化错误（不凭空造 breaker）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);
    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      breakers: new Map(),
      longBreakers: new Map(),
    });

    const r = await callAdmin(tm, {
      action: "breaker_reset",
      name: "nonexistent_channel",
      reason: "typo probe",
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown breaker channel");
  });

  it("缺 reason → fail（mutation 强制思考，R-RT-8）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);
    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      breakers: new Map(),
      longBreakers: new Map(),
    });

    const r = await callAdmin(tm, {
      action: "breaker_reset",
      name: "browse_headless",
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("reason");
  });

  it("zod action enum 接受 breaker_reset（schema 层不再即拒）", () => {
    const parsed = z.object(adminSchema).parse({
      action: "breaker_reset",
      name: "browse_headless",
      reason: "schema level",
    }) as { action: string };
    expect(parsed.action).toBe("breaker_reset");
  });
});
