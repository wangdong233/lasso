/**
 * observ-admin-action 集成测（parse8 §3.5 + §5.1 #5 + §6.1 #7）
 *
 * 验证 v0.7 admin 3 个只读 observability action 返结构化 JSON：
 *  - metrics_snapshot : per-channel 成功率 / p50 / p95 / alerts
 *  - breaker_status   : 短+长 breaker 状态聚合
 *  - serp_health      : SERP engines 命中率 / 改版告警
 *
 * 与 unit/admin-observ.test.ts 的分工（parse8 §5.1）：
 *  - 本文件（集成）：经 registerAdminTool 装配 + toolManager + 真 CapabilityBag 调用链
 *    （验证 admin handler 与 deps 注入形状对齐）
 *  - unit：admin handler 内部逻辑（mock deps）
 *
 * 守 INV-46（parse8 §5.3）：observ 暴露走 admin action-enum —— 验证 3 个新 action
 *      均在 admin tool（grep 不出新 tool 注册）；零回归：未注入 deps 时返 configured:false。
 */
import { describe, it, expect, vi } from "vitest";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CapabilityBag } from "../../src/runtime/CapabilityBag.js";
import { ToolManager } from "../../src/runtime/ToolManager.js";
import { CallerTierTracker } from "../../src/runtime/CallerTierTracker.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { LongCircuitBreaker } from "../../src/fallback/LongCircuitBreaker.js";
import { MetricsCollector } from "../../src/observ/MetricsCollector.js";
import { SelectorRegistry } from "../../src/serp/SelectorRegistry.js";
import { HitRateStats } from "../../src/serp/HitRateStats.js";
import { ChangeDetection } from "../../src/serp/ChangeDetection.js";
import { RecordingStore } from "../../src/serp/RecordingStore.js";
import { SerpHealthMonitor } from "../../src/serp/SerpHealthMonitor.js";
import { registerAdminTool } from "../../src/tools/admin.js";
import { ProviderRegistry } from "../../src/config/provider-registry.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================
// mocks
// ============================================================
function makeMockServer(): McpServer {
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

// ============================================================
// 测试用例
// ============================================================
describe("admin observability action（parse8 §3.5）", () => {
  it("metrics_snapshot 返 configured:true + channels 数组 + alerts 数组（结构化 JSON）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    // 注入 metrics 并预填样本
    const metrics = new MetricsCollector();
    metrics.record("browse_headless", "worked", 100);
    metrics.record("browse_headless", "worked", 200);
    metrics.record("browse_headless", "error", 500); // 1 失败

    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      metrics,
    });

    const payload = await callAdmin(tm, { action: "metrics_snapshot" });

    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("metrics_snapshot");
    expect(payload.configured).toBe(true);
    expect(Array.isArray(payload.channels)).toBe(true);
    expect(payload.channels).toHaveLength(1);
    const ch = (payload.channels as Array<Record<string, unknown>>)[0]!;
    expect(ch.channel).toBe("browse_headless");
    expect(ch.total).toBe(3);
    expect(ch.success_count).toBe(2);
    expect(ch.failure_count).toBe(1);
    expect(ch.success_rate).toBeCloseTo(2 / 3, 5);
    expect(typeof ch.latency_ms_p50).toBe("number");
    expect(typeof ch.latency_ms_p95).toBe("number");
    expect(ch.last_error).toBe("error");

    // alerts 数组（样本 < 10，scanForAlerts 不告警）
    expect(Array.isArray(payload.alerts)).toBe(true);
    expect(payload.alerts).toHaveLength(0);
  });

  it("breaker_status 返短+长 breaker 聚合数组（结构化 JSON）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless", "desktop.cgEvent"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    // 短熔断 Map：预置 1 个 open 状态
    const breakers = new Map<string, CircuitBreaker>([
      ["browse_headless", new CircuitBreaker()],
    ]);
    breakers.get("browse_headless")!.recordFailure();
    breakers.get("browse_headless")!.recordFailure();
    breakers.get("browse_headless")!.recordFailure(); // 第 3 次 → open

    // 长熔断 Map：预置 1 个 closed + 累计 window failure
    const longBreakers = new Map<string, LongCircuitBreaker>();
    const longB = new LongCircuitBreaker(
      10,
      3_600_000,
      3_600_000,
      undefined,
      "desktop.cgEvent",
    );
    await longB.recordFailure();
    await longB.recordFailure();
    longBreakers.set("desktop.cgEvent", longB);

    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      breakers,
      longBreakers,
    });

    const payload = await callAdmin(tm, { action: "breaker_status" });

    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("breaker_status");
    expect(payload.configured).toBe(true);
    expect(Array.isArray(payload.breakers)).toBe(true);
    expect(payload.breakers).toHaveLength(2);

    const shorts = (payload.breakers as Array<Record<string, unknown>>).filter(
      (b) => b.kind === "short",
    );
    const longs = (payload.breakers as Array<Record<string, unknown>>).filter(
      (b) => b.kind === "long",
    );
    expect(shorts).toHaveLength(1);
    expect(longs).toHaveLength(1);

    expect(shorts[0]!.channel).toBe("browse_headless");
    expect(shorts[0]!.state).toBe("open");
    expect(shorts[0]!.failure_count).toBe(3);

    expect(longs[0]!.channel).toBe("desktop.cgEvent");
    expect(longs[0]!.state).toBe("closed"); // 仅 2 次 < threshold 10
    expect(longs[0]!.window_failure_count).toBe(2);
  });

  it("serp_health 返 engines + recent_alerts + recordings_count（结构化 JSON）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    // 真装配 4 件 SERP 骨架（与 index.ts v0.7-4 同范式）
    const serpCacheDir = path.join(os.tmpdir(), "lasso-test-serp-" + Date.now());
    const serpRegistry = new SelectorRegistry();
    const serpHitRate = new HitRateStats();
    const serpChange = new ChangeDetection(path.join(serpCacheDir, "baseline"));
    const serpRecordings = new RecordingStore(path.join(serpCacheDir, "recordings"));
    const serpHealth = new SerpHealthMonitor(
      serpRegistry,
      serpHitRate,
      serpChange,
      serpRecordings,
    );
    // 预填若干 hit/miss 样本
    serpHealth.onResult("baidu", "v1", "test query", "<dom/>", true);
    serpHealth.onResult("baidu", "v1", "test query 2", "<dom/>", false);

    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      serpHealth,
    });

    const payload = await callAdmin(tm, { action: "serp_health" });

    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("serp_health");
    expect(payload.configured).toBe(true);
    expect(Array.isArray(payload.engines)).toBe(true);
    expect(payload.engines.length).toBeGreaterThan(0);
    const baidu = (
      payload.engines as Array<Record<string, unknown>>
    ).find((e) => e.engine === "baidu");
    expect(baidu).toBeDefined();
    expect(baidu!.hit).toBe(1);
    expect(baidu!.miss).toBe(1);
    expect(typeof baidu!.hit_rate).toBe("number");
    expect(typeof baidu!.redesign_suspected).toBe("boolean");
    expect(Array.isArray(payload.recent_alerts)).toBe(true);
    expect(typeof payload.recordings_count).toBe("number");
  });

  it("未注入 observ deps 时 3 action 返 configured:false（零回归）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    // 不注入 metrics / breakers / longBreakers / serpHealth（v0.6 行为）
    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
    });

    const m = await callAdmin(tm, { action: "metrics_snapshot" });
    expect(m.ok).toBe(true);
    expect(m.configured).toBe(false);
    expect(Array.isArray(m.channels)).toBe(true);
    expect(m.channels).toHaveLength(0);

    const b = await callAdmin(tm, { action: "breaker_status" });
    expect(b.ok).toBe(true);
    expect(b.configured).toBe(false);
    expect(Array.isArray(b.breakers)).toBe(true);
    expect(b.breakers).toHaveLength(0);

    const s = await callAdmin(tm, { action: "serp_health" });
    expect(s.ok).toBe(true);
    expect(s.configured).toBe(false);
  });

  it("3 observ action 均不要求 reason（强制思考纪律只覆盖 mutation）", async () => {
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
    });

    // 3 observ action 不传 reason 也应 ok（与 capability_disable 等 mutation 不同）
    const m = await callAdmin(tm, { action: "metrics_snapshot" });
    expect(m.ok).toBe(true);
    expect(m.error).toBeUndefined();

    const b = await callAdmin(tm, { action: "breaker_status" });
    expect(b.ok).toBe(true);
    expect(b.error).toBeUndefined();

    const s = await callAdmin(tm, { action: "serp_health" });
    expect(s.ok).toBe(true);
    expect(s.error).toBeUndefined();
  });
});
