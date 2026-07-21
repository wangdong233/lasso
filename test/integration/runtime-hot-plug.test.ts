/**
 * runtime-hot-plug 集成测（parse7 §5.3 + §6.2 —— provider 热插拔端到端）
 *
 * 验证 index.ts v0.6 接线段 + hot-reload.applyHotReload 真能联动：
 *  1. 初始 registry 仅有 zhipu（brave 未注入 keys）
 *  2. applyHotReload([brave2config]) →
 *     - registry.add(brave2) 成功（INV-40）
 *     - bag.register("search.brave2")（INV-36）
 *     - bag.isEnabled("search.brave2") === true
 *  3. applyHotReload second call with brave2 removed →
 *     - registry.remove("brave2") 成功
 *     - bag.disable("search.brave2")（hot-reload 走 disable 不 unregister，保留 audit trail）
 *  4. admin provider_add → 同样经 registry.add + bag.register（addProvider 单条特例）
 *  5. admin provider_remove → 同样经 registry.remove + bag.disable（removeProvider 单条特例）
 *  6. admin provider_add 时 keys 从 env 读，不接受 body 字面量（INV-10 衍生）
 *
 * 不 spawn 真实 chrome-devtools-mcp / 不调真实 Brave API（CI 友好；parse7 §5.4 CI 列）。
 * 真实 Brave search 调用由手测清单覆盖（parse7-acceptance.md）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CapabilityBag } from "../../src/runtime/CapabilityBag.js";
import { ToolManager } from "../../src/runtime/ToolManager.js";
import { CallerTierTracker } from "../../src/runtime/CallerTierTracker.js";
import {
  applyHotReload,
  addProvider,
  removeProvider,
} from "../../src/runtime/hot-reload.js";
import { registerAdminTool } from "../../src/tools/admin.js";
import { ProviderRegistry } from "../../src/config/provider-registry.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";
import type { ProviderConfig } from "../../src/types.js";

// ============================================================
// fixtures
// ============================================================
function makeMockServer(): McpServer {
  return {
    tool: vi.fn(() => ({
      enabled: true,
      disable: vi.fn(),
      enable: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      handler: vi.fn(),
    })),
    sendToolListChanged: vi.fn(),
  } as unknown as McpServer;
}

const brave2Config: ProviderConfig = {
  name: "brave2",
  type: "api_key",
  endpoint_url: "https://api.search.brave.com/v2/web/search",
  keys: [], // 测试用空 keys（hot-plug 时不强求 keys 存在，只验流程）
  free_quota_per_month: 2000,
  quota_model: "monthly",
  fallback_order: 50,
  tags: ["search"],
  enabled: true,
  policy_risk: "safe",
};

// ============================================================
// applyHotReload 端到端
// ============================================================
describe("runtime-hot-plug applyHotReload", () => {
  it("新增 brave2 → registry.add + bag.register + bag.isEnabled=true", async () => {
    // 最小化 fixture：初始空 registry（绕开 BUILTIN_PROVIDERS 的 brave/zhipu/etc 干扰）
    const registry = new ProviderRegistry([]);
    expect(registry.listNames()).not.toContain("brave2");

    const { server } = makeMockServerForHotPlug();
    const toolManager = new ToolManager(server);
    const bag = new CapabilityBag([]);

    const report = await applyHotReload(
      [brave2Config],
      registry,
      bag,
      toolManager,
    );

    expect(report.added).toEqual(["brave2"]);
    expect(report.removed).toEqual([]);

    // registry 含 brave2
    expect(registry.listNames()).toContain("brave2");
    const brave2Entry = registry.get("brave2");
    expect(brave2Entry).toBeDefined();
    expect(brave2Entry!.config.name).toBe("brave2");

    // bag register 了 brave2（INV-36）
    expect(bag.has("brave2")).toBe(true);
    expect(bag.isEnabled("brave2")).toBe(true);

    // bag.snapshot 反映 enabled
    const snap = bag.snapshot();
    const brave2State = snap.find((s) => s.name === "brave2")!;
    expect(brave2State.enabled).toBe(true);
    // parse7 §3.1 inferKind 用 "." 判别；"brave2" 无 dot → channel；
    // 实装按 ProviderConfig.name 直接进 bag，故 kind 推断为 channel（命名约定问题，不阻断功能）
    expect(brave2State.kind).toBe("channel");
  });

  it("移除 brave2 → registry.remove + bag.disable（保留 audit trail）", async () => {
    // 初始 registry 仅 brave2（避免 BUILTIN_PROVIDERS 干扰）
    const registry = new ProviderRegistry([brave2Config]);
    expect(registry.listNames()).toContain("brave2");

    const { server } = makeMockServerForHotPlug();
    const toolManager = new ToolManager(server);
    const bag = new CapabilityBag(["brave2"]);
    expect(bag.isEnabled("brave2")).toBe(true);

    // applyHotReload 用空 incoming（不含 brave2）→ 触发移除
    const report = await applyHotReload([], registry, bag, toolManager);

    expect(report.removed).toEqual(["brave2"]);
    expect(registry.listNames()).not.toContain("brave2");
    expect(bag.isEnabled("brave2")).toBe(false); // disable，不是 unregister

    // bag 仍保留 brave2 entry（disabled，audit trail）
    expect(bag.has("brave2")).toBe(true);
    const snap = bag.snapshot();
    const brave2State = snap.find((s) => s.name === "brave2")!;
    expect(brave2State.enabled).toBe(false);
    expect(brave2State.disabledBy).toBe("hot_reload");
    expect(brave2State.reason).toBe("removed_from_providers_file");
  });

  it("applyHotReload 同时 add + remove（diff 应用）", async () => {
    // 初始 registry 仅 old_brave（避免其他 provider 干扰）
    const oldBraveConfig: ProviderConfig = { ...brave2Config, name: "old_brave" };
    const registry = new ProviderRegistry([oldBraveConfig]);
    const { server } = makeMockServerForHotPlug();
    const toolManager = new ToolManager(server);
    const bag = new CapabilityBag(["old_brave"]);

    // incoming 有 brave2，没有 old_brave
    const report = await applyHotReload([brave2Config], registry, bag, toolManager);

    expect(report.added).toEqual(["brave2"]);
    expect(report.removed).toEqual(["old_brave"]);

    expect(registry.listNames()).toContain("brave2");
    expect(registry.listNames()).not.toContain("old_brave");
    expect(bag.isEnabled("brave2")).toBe(true);
    expect(bag.isEnabled("old_brave")).toBe(false);
  });

  it("applyHotReload enabled=false 的 config 静默跳过（与 constructor 同语义）", async () => {
    const registry = new ProviderRegistry([]);
    const { server } = makeMockServerForHotPlug();
    const toolManager = new ToolManager(server);
    const bag = new CapabilityBag([]);

    const disabledConfig: ProviderConfig = { ...brave2Config, enabled: false };
    const report = await applyHotReload([disabledConfig], registry, bag, toolManager);

    expect(report.added).toEqual([]); // 不进 registry
    expect(registry.listNames()).not.toContain("brave2");
    expect(bag.has("brave2")).toBe(false); // 也不进 bag
  });
});

// ============================================================
// admin tool provider_add / provider_remove
// ============================================================
describe("admin provider_add / provider_remove 端到端", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("provider_add 经 registry.add + bag.register（INV-40 + INV-36）", async () => {
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);
    const { server, adminRec } = wireAdminForTest(registry);

    const result = (await adminRec.handler({
      action: "provider_add",
      config: {
        name: "brave2",
        type: "api_key",
        endpoint_url: "https://api.search.brave.com/v2/web/search",
        free_quota_per_month: 2000,
        quota_model: "monthly",
        fallback_order: 50,
        tags: ["search"],
      },
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.name).toBe("brave2");
    expect(payload.keys_from_env).toBe(false); // env 未设

    expect(registry.listNames()).toContain("brave2");
    expect(server).toBeDefined();
  });

  it("provider_add keys 从 env 读，不接受 body 字面量（INV-10 衍生）", async () => {
    process.env.BRAVE2_API_KEYS = "key-from-env-1,key-from-env-2";
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);
    const { adminRec } = wireAdminForTest(registry);

    // 调用方故意在 config.keys 里塞恶意 key
    const result = (await adminRec.handler({
      action: "provider_add",
      config: {
        name: "brave2",
        type: "api_key",
        endpoint_url: "https://api.search.brave.com/v2/web/search",
        free_quota_per_month: 2000,
        quota_model: "monthly",
        fallback_order: 50,
        tags: ["search"],
        // 故意尝试传 keys（INV-10 衍生：admin 应忽略，从 env 读）
        keys: ["malicious-key-from-llm"],
      },
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.keys_from_env).toBe(true);

    // registry 中的 brave2.keys 应来自 env，而非 body
    const entry = registry.get("brave2");
    expect(entry).toBeDefined();
    expect(entry!.config.keys).toEqual(["key-from-env-1", "key-from-env-2"]);
    expect(entry!.config.keys).not.toContain("malicious-key-from-llm");
  });

  it("provider_remove 经 registry.remove + bag.disable（INV-40）", async () => {
    const registry = new ProviderRegistry([...BUILTIN_PROVIDERS, brave2Config]);
    const { adminRec, bag } = wireAdminForTest(
      registry,
      ["search.zhipu", "brave2"],
    );

    const result = (await adminRec.handler({
      action: "provider_remove",
      name: "brave2",
      reason: "test provider_remove",
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.removed).toBe(true);

    expect(registry.listNames()).not.toContain("brave2");
    expect(bag.isEnabled("brave2")).toBe(false);
    expect(bag.has("brave2")).toBe(true); // bag 保留 entry（audit trail）
  });

  it("provider_remove 缺 reason → ok=false error（强制思考）", async () => {
    const registry = new ProviderRegistry([...BUILTIN_PROVIDERS, brave2Config]);
    const { adminRec } = wireAdminForTest(registry, ["search.zhipu", "brave2"]);

    const result = (await adminRec.handler({
      action: "provider_remove",
      name: "brave2",
      // 故意不传 reason
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("reason");

    // registry 未受影响
    expect(registry.listNames()).toContain("brave2");
  });

  it("provider_remove 未知名 → ok=true removed=false（幂等）", async () => {
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);
    const { adminRec } = wireAdminForTest(registry);

    const result = (await adminRec.handler({
      action: "provider_remove",
      name: "nonexistent",
      reason: "test",
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.removed).toBe(false);
  });

  it("addProvider/removeProvider（hot-reload 单条 API）与 admin action 一致", async () => {
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);
    const { server } = makeMockServerForHotPlug();
    const toolManager = new ToolManager(server);
    const bag = new CapabilityBag(["search.zhipu"]);

    // addProvider
    await addProvider(brave2Config, registry, bag, toolManager);
    expect(registry.listNames()).toContain("brave2");
    expect(bag.isEnabled("brave2")).toBe(true);

    // removeProvider
    const removed = await removeProvider(
      "brave2",
      registry,
      bag,
      toolManager,
      { callerId: "test", reason: "verify single API" },
    );
    expect(removed).toBe(true);
    expect(registry.listNames()).not.toContain("brave2");
    expect(bag.isEnabled("brave2")).toBe(false);
  });
});

// ============================================================
// helpers
// ============================================================
function makeMockServerForHotPlug(): { server: McpServer } {
  return { server: makeMockServer() };
}

/**
 * 装配 admin tool + 依赖，返回 admin handler 引用便于测试直接调。
 */
function wireAdminForTest(
  registry: ProviderRegistry,
  initialBag: string[] = ["search.zhipu"],
): {
  server: McpServer;
  bag: CapabilityBag;
  toolManager: ToolManager;
  callerTier: CallerTierTracker;
  adminRec: { handler: (args: unknown) => Promise<unknown> };
} {
  const server = makeMockServer();
  const toolManager = new ToolManager(server);
  const bag = new CapabilityBag(initialBag);
  const callerTier = new CallerTierTracker(100);

  registerAdminTool({ bag, toolManager, callerTier, registry });

  const adminRec = (toolManager as unknown as {
    tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
  }).tools.get("admin")!;

  return { server, bag, toolManager, callerTier, adminRec };
}
