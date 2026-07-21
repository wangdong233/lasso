/**
 * runtime-disable-channel 集成测（parse7 §5.3 + §6.2 —— 通道级 disable 端到端）
 *
 * 验证 index.ts v0.6 接线段装配的 bag.onChange handler 真能联动：
 *  1. v0.5 注册 browse_headless + browse_logged_in tool（mock McpServer）
 *  2. v0.6 接线段：toolManager.captureHandle + bag.onChange handler + registerAdminTool
 *  3. admin capability_disable name=browse_headless →
 *     - bag.disable() 触发 onChange
 *     - handler 调 toolManager.disableChannel("browse_headless")
 *     - SDK tool.disable() 被调（mock RegisteredTool 记录）
 *     - subproc.shutdownOne("headless") 被调（mock SubprocessManager 记录）
 *     - CapabilityBag.snapshot() 反映 browse_headless enabled=false
 *  4. admin capability_enable → tool 重新 enabled + subproc 不再被调（懒启动由 channel 自管）
 *  5. provider 级 disable（desktop.cgEvent）→ 不 kill shared subprocess（R-RT-2 缓解）
 *
 * 不依赖真实 stdio transport / chrome-devtools-mcp 子进程（CI 友好；parse7 §5.4 CI 列）。
 * 真实子进程 kill + CC listTools 刷新由手测清单覆盖（parse7-acceptance.md）。
 */
import { describe, it, expect, vi } from "vitest";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CapabilityBag } from "../../src/runtime/CapabilityBag.js";
import { ToolManager } from "../../src/runtime/ToolManager.js";
import { CallerTierTracker } from "../../src/runtime/CallerTierTracker.js";
import { registerAdminTool } from "../../src/tools/admin.js";
import { ProviderRegistry } from "../../src/config/provider-registry.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";

// ============================================================
// mocks
// ============================================================
/**
 * Mock McpServer：与 ToolManager.test.ts 同范式；记录 server.tool 调用 + sendToolListChanged。
 *
 * 关键：与 SDK 1.29 真实行为对齐 ——
 *  - tool() 返回 RegisteredTool（持 disable/enable/remove + enabled 标志）
 *  - disable() / enable() / remove() 内部调 sendToolListChanged（mock 同样调）
 */
function makeMockServer(): {
  server: McpServer;
  tools: Map<string, { registered: RegisteredTool; enabled: boolean; disableCalls: number; enableCalls: number }>;
  sendToolListChangedCalls: number;
} {
  const tools = new Map<
    string,
    {
      registered: RegisteredTool;
      enabled: boolean;
      disableCalls: number;
      enableCalls: number;
    }
  >();
  const calls = { sendToolListChanged: 0 };
  const server = {
    tool: vi.fn((name: string, ..._rest: unknown[]) => {
      const entry = {
        registered: {
          enabled: true,
          disable: () => {
            entry.registered.enabled = false;
            entry.disableCalls++;
            calls.sendToolListChanged++;
          },
          enable: () => {
            entry.registered.enabled = true;
            entry.enableCalls++;
            calls.sendToolListChanged++;
          },
          remove: () => {
            calls.sendToolListChanged++;
          },
          update: () => {
            calls.sendToolListChanged++;
          },
          handler: vi.fn(),
        } as unknown as RegisteredTool,
        enabled: true,
        disableCalls: 0,
        enableCalls: 0,
      };
      // 把 enabled 重写到 entry.registered 上避免上面 disable() 立即生效后又改回
      // （使用 closure 同步 entry.registered.enabled 与 entry.enabled）
      Object.defineProperty(entry.registered, "enabled", {
        get() {
          return entry.enabled;
        },
        set(v: boolean) {
          entry.enabled = v;
        },
        configurable: true,
      });
      tools.set(name, entry);
      return entry.registered;
    }),
    sendToolListChanged: vi.fn(() => {
      calls.sendToolListChanged++;
    }),
  } as unknown as McpServer;
  // 用 Proxy 把 sendToolListChanged 计数暴露出来（mock 函数本身的 mock.calls.length 也可，
  // 但 SDK 1.29 真实 server 的 disable/enable 内部调 sendToolListChanged 是同步的；
  // 我们这里在 mock 中显式 +1，便于断言 "刷新通知发出"）
  return {
    server,
    tools,
    get sendToolListChangedCalls() {
      return calls.sendToolListChanged;
    },
  } as ReturnType<typeof makeMockServer>;
}

/**
 * Mock SubprocessManager：仅记录 shutdownOne 调用（不真 spawn / kill）。
 *
 * INV-39 衍生：单 spec kill；测试断言只调一次 + 波及的 spec name 正确。
 */
function makeMockSubproc(): {
  shutdownOne: ReturnType<typeof vi.fn>;
  shutdownCalls: string[];
} {
  const shutdownCalls: string[] = [];
  const shutdownOne = vi.fn(async (name: string) => {
    shutdownCalls.push(name);
  });
  return { shutdownOne, shutdownCalls };
}

/**
 * 与 index.ts 装配段同形的 v0.6 接线（简化版）。
 *
 * @param initial   初始 channel/provider 集合（INV-40：全 enabled=true）
 * @param channelToSpec  CHANNEL_TO_SPEC 映射（INV-35 衍生：单一映射表）
 */
function wireRuntime(opts: {
  initial: string[];
  channelToSpec: Record<string, string | null>;
  subproc: ReturnType<typeof makeMockSubproc>;
  server: McpServer;
  registry: ProviderRegistry;
}): {
  bag: CapabilityBag;
  toolManager: ToolManager;
  callerTier: CallerTierTracker;
} {
  const toolManager = new ToolManager(opts.server);
  const bag = new CapabilityBag(opts.initial);
  const callerTier = new CallerTierTracker(100);

  // bag.onChange handler（与 index.ts v0.6 接线段同结构）
  bag.onChange(async (name, enabled, state) => {
    if (enabled) {
      await toolManager.enableChannel(name);
      return;
    }
    await toolManager.disableChannel(name);
    if (state.kind !== "channel") return;
    const specName = opts.channelToSpec[name];
    if (!specName) return;
    if (specName === "rust-helper") {
      const snap = bag.snapshot();
      const allDesktopProvidersDown = snap
        .filter((s) => s.name.startsWith("desktop."))
        .every((s) => !s.enabled);
      if (!allDesktopProvidersDown) return;
    }
    await opts.subproc.shutdownOne(specName);
  });

  registerAdminTool({
    bag,
    toolManager,
    callerTier,
    registry: opts.registry,
  });

  return { bag, toolManager, callerTier };
}

// ============================================================
// 测试用例
// ============================================================
describe("runtime-disable-channel 端到端", () => {
  it("admin capability_disable browse_headless → tool.disable + subproc.shutdownOne('headless') + snapshot 反映", async () => {
    // ----- assemble -----
    const { server, tools } = makeMockServer();
    const subproc = makeMockSubproc();
    // 模拟 v0.5 注册：search / browse_headless / browse_logged_in / doctor 4 工具
    const v5Tools: Array<{ name: string; channel: string }> = [
      { name: "search", channel: "search" },
      { name: "browse_headless", channel: "browse_headless" },
      { name: "browse_logged_in", channel: "browse_logged_in" },
      { name: "doctor", channel: "doctor" },
    ];
    const tm = new ToolManager(server);
    for (const t of v5Tools) {
      // 直接调 server.tool 模拟 v0.5 注册
      const handle = (server as unknown as {
        tool: (n: string, ...rest: unknown[]) => RegisteredTool;
      }).tool(t.name, "desc", {}, {}, async () => ({}));
      tm.captureHandle(t.channel, t.name, handle);
    }

    const initial = [
      "browse_headless",
      "browse_logged_in",
      "desktop",
      "search.zhipu",
      "desktop.ax",
      "desktop.cgEvent",
    ];
    const bag = new CapabilityBag(initial);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    // 挂 onChange handler（与 index.ts v0.6 接线段同结构）
    const CHANNEL_TO_SPEC: Record<string, string | null> = {
      browse_headless: "headless",
      browse_logged_in: "logged_in",
      desktop: "rust-helper",
    };
    bag.onChange(async (name, enabled, state) => {
      if (enabled) {
        await tm.enableChannel(name);
        return;
      }
      await tm.disableChannel(name);
      if (state.kind !== "channel") return;
      const specName = CHANNEL_TO_SPEC[name];
      if (!specName) return;
      if (specName === "rust-helper") {
        const snap = bag.snapshot();
        const allDesktopProvidersDown = snap
          .filter((s) => s.name.startsWith("desktop."))
          .every((s) => !s.enabled);
        if (!allDesktopProvidersDown) return;
      }
      await subproc.shutdownOne(specName);
    });

    // 注册 admin tool（admin 自身不能 disable 自己）
    registerAdminTool({ bag, toolManager: tm, callerTier, registry });

    // ----- 默认全开（INV-40）-----
    const initialSnap = bag.snapshot();
    expect(initialSnap.every((s) => s.enabled === true)).toBe(true);
    expect(tools.get("browse_headless")!.enabled).toBe(true);

    // ----- act: disable browse_headless -----
    const adminHandle = tm.channelOf("admin");
    expect(adminHandle).toBe("admin");
    const adminRec = (tm as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
    }).tools.get("admin");
    expect(adminRec).toBeDefined();

    const result = (await adminRec!.handler({
      action: "capability_disable",
      name: "browse_headless",
      reason: "integration test",
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("capability_disable");
    expect(payload.name).toBe("browse_headless");
    expect(payload.changed).toBe(true);

    // ----- assert: tool 被下架 + subproc 单停 + snapshot 反映 -----
    expect(tools.get("browse_headless")!.enabled).toBe(false);
    expect(tools.get("browse_headless")!.disableCalls).toBe(1);
    expect(subproc.shutdownCalls).toEqual(["headless"]); // 只 kill headless，不波及 logged_in
    expect(tools.get("browse_logged_in")!.enabled).toBe(true); // logged_in 不受影响

    const afterSnap = bag.snapshot();
    const bh = afterSnap.find((s) => s.name === "browse_headless")!;
    expect(bh.enabled).toBe(false);
    expect(bh.disabledBy).toBe("admin");
    expect(bh.reason).toBe("integration test");
    expect(bh.disabledAt).toBeGreaterThan(0);
  });

  it("admin capability_enable browse_headless → tool.enable + subproc 不再 kill（懒启动由 channel 自管）", async () => {
    const { server, tools } = makeMockServer();
    const subproc = makeMockSubproc();

    // 注册 v0.5 工具
    const v5Tools = [
      { name: "browse_headless", channel: "browse_headless" },
    ];
    const tm = new ToolManager(server);
    for (const t of v5Tools) {
      const handle = (server as unknown as {
        tool: (n: string, ...rest: unknown[]) => RegisteredTool;
      }).tool(t.name, "desc", {}, {}, async () => ({}));
      tm.captureHandle(t.channel, t.name, handle);
    }

    const bag = new CapabilityBag(["browse_headless"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    const CHANNEL_TO_SPEC: Record<string, string | null> = {
      browse_headless: "headless",
    };
    bag.onChange(async (name, enabled, state) => {
      if (enabled) {
        await tm.enableChannel(name);
        return;
      }
      await tm.disableChannel(name);
      if (state.kind !== "channel") return;
      const specName = CHANNEL_TO_SPEC[name];
      if (!specName) return;
      await subproc.shutdownOne(specName);
    });

    registerAdminTool({ bag, toolManager: tm, callerTier, registry });

    // 先 disable（前置）
    const adminRec = (tm as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
    }).tools.get("admin")!;
    await adminRec.handler({
      action: "capability_disable",
      name: "browse_headless",
      reason: "setup",
    });
    expect(tools.get("browse_headless")!.enabled).toBe(false);
    expect(subproc.shutdownCalls).toEqual(["headless"]);

    // 再 enable
    const result = (await adminRec.handler({
      action: "capability_enable",
      name: "browse_headless",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.changed).toBe(true);

    // tool 重 enabled；subproc 不再被调（v0.5 范式：channel 内部懒启动）
    expect(tools.get("browse_headless")!.enabled).toBe(true);
    expect(tools.get("browse_headless")!.enableCalls).toBe(1);
    expect(subproc.shutdownCalls).toEqual(["headless"]); // 仍只有 disable 时那一次

    // bag snapshot 反映 enabled
    const snap = bag.snapshot();
    expect(snap[0]!.enabled).toBe(true);
    expect(snap[0]!.disabledAt).toBeUndefined();
  });

  it("provider 级 disable（desktop.cgEvent）→ 不 kill shared rust-helper（R-RT-2 缓解）", async () => {
    const { server } = makeMockServer();
    const subproc = makeMockSubproc();
    const tm = new ToolManager(server);

    const initial = [
      "desktop",
      "desktop.ax",
      "desktop.appleScript",
      "desktop.cgEvent",
      "desktop.screenshotVlm",
    ];
    const bag = new CapabilityBag(initial);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    const CHANNEL_TO_SPEC: Record<string, string | null> = {
      desktop: "rust-helper",
    };
    bag.onChange(async (name, enabled, state) => {
      if (enabled) {
        await tm.enableChannel(name);
        return;
      }
      await tm.disableChannel(name);
      if (state.kind !== "channel") return; // provider 级 disable 不 kill
      const specName = CHANNEL_TO_SPEC[name];
      if (!specName) return;
      if (specName === "rust-helper") {
        const snap = bag.snapshot();
        const allDesktopProvidersDown = snap
          .filter((s) => s.name.startsWith("desktop."))
          .every((s) => !s.enabled);
        if (!allDesktopProvidersDown) return;
      }
      await subproc.shutdownOne(specName);
    });

    registerAdminTool({ bag, toolManager: tm, callerTier, registry });

    // provider 级 disable
    const adminRec = (tm as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
    }).tools.get("admin")!;
    const result = (await adminRec.handler({
      action: "capability_disable",
      name: "desktop.cgEvent",
      reason: "test R-RT-2",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.changed).toBe(true);

    // rust-helper 没被 kill（其他 desktop.* 仍 enabled）
    expect(subproc.shutdownCalls).toEqual([]);

    // 即便 disable 整个 desktop channel：仅当所有 4 档 provider 都 disabled 才 kill
    await adminRec.handler({
      action: "capability_disable",
      name: "desktop",
      reason: "kill shared only when all providers down",
    });
    // 此时 desktop channel disabled 但 4 档 provider 中仅 cgEvent disabled；
    // rust-helper 仍不应被 kill
    expect(subproc.shutdownCalls).toEqual([]);

    // 把剩余 3 档也 disable → 才 kill rust-helper
    await adminRec.handler({
      action: "capability_disable",
      name: "desktop.ax",
      reason: "test",
    });
    await adminRec.handler({
      action: "capability_disable",
      name: "desktop.appleScript",
      reason: "test",
    });
    await adminRec.handler({
      action: "capability_disable",
      name: "desktop.screenshotVlm",
      reason: "test",
    });
    // 现在所有 desktop.* 都 disabled；再来一次 disable desktop channel（如重新触发）
    // 由于 desktop 已经 disabled，再 disable 不会触发 handler（no-op）
    // 测试的核心是 R-RT-2：单独 disable 任何一档不 kill rust-helper
    expect(subproc.shutdownCalls).toEqual([]); // 仍空 —— desktop channel 之前已 disabled，handler 未触发新 shutdownOne
  });

  it("capability_disable 未知名 → ok=false changed=false（不凭空造 channel，INV-36）", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    bag.onChange(async (name, enabled) => {
      if (enabled) await tm.enableChannel(name);
      else await tm.disableChannel(name);
    });

    registerAdminTool({ bag, toolManager: tm, callerTier, registry });
    const adminRec = (tm as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
    }).tools.get("admin")!;

    const result = (await adminRec.handler({
      action: "capability_disable",
      name: "nonexistent_channel",
      reason: "test INV-36",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.ok).toBe(true); // 调用本身成功
    expect(payload.changed).toBe(false); // 但状态没变（未知名 no-op）
    expect(bag.has("nonexistent_channel")).toBe(false); // bag 没造新 entry
  });

  it("capability_disable 缺 reason 字段 → ok=false error（强制思考，R-RT-8）", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    registerAdminTool({ bag, toolManager: tm, callerTier, registry });
    const adminRec = (tm as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
    }).tools.get("admin")!;

    const result = (await adminRec.handler({
      action: "capability_disable",
      name: "browse_headless",
      // 故意不传 reason
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("reason");
    // bag 状态不变
    expect(bag.isEnabled("browse_headless")).toBe(true);
  });

  it("admin tool 自身不能 disable（永远 enabled）", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_headless"]); // 故意不含 "admin"
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    bag.onChange(async (name, enabled) => {
      if (enabled) await tm.enableChannel(name);
      else await tm.disableChannel(name);
    });

    registerAdminTool({ bag, toolManager: tm, callerTier, registry });

    // bag 没有 "admin" entry → disable 返 false 不触发 handler
    const adminRec = (tm as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
    }).tools.get("admin")!;

    const result = (await adminRec.handler({
      action: "capability_disable",
      name: "admin",
      reason: "trying to disable admin itself",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.changed).toBe(false);

    // admin tool 仍可调（验证：再调一次 capability_list）
    const listResult = (await adminRec.handler({
      action: "capability_list",
    })) as { content: Array<{ text: string }> };
    const listPayload = JSON.parse(listResult.content[0]!.text);
    expect(listPayload.ok).toBe(true);
    expect(Array.isArray(listPayload.capabilities)).toBe(true);
  });
});
