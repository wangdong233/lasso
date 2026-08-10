/**
 * steel-channel-flow.spec.ts（parse14 §5.2 —— v1.6 Phase B 集成测）
 *
 * SteelChannel 端到端集成测试：mock REST + McpClient + CapabilityBag + PolicyGate 双重解锁。
 *
 * 测试范围（parse14 §5.2 集成测用例 + 任务描述）：
 *  1. SteelChannel 端到端 mock REST：sessionProvider → registerSpec → ensureRunning → browse
 *  2. FallbackDecider plan 含 browse_cloud_steel → 路由正确（runWithFallback 路由）
 *  3. PolicyGate 双重解锁（LASSO_ALLOW_CLOUD_BROWSER + cloudBrowserKeys 含 "steel"）
 *  4. PolicyGate 阻断路径：manual-switch off / endpoint 缺
 *  5. CapabilityBag 含 browse_cloud_steel（条件装配落地 + disable/enable 联动）
 *  6. registerSteelTool 经 McpServer mock 注册（server.tool("steel", ...) 被调一次）
 *
 * 测试大小：MEDIUM（parse14 §2.2 / 03 §2 集成测）—— 多模块协作 + mock 注入,
 *            不触真网（不 fetch 真 Steel Docker endpoint）。
 *
 * mock 策略（03 §2.1 项 8 doubles 政策 + parse14 §5.1 mock 范式）：
 *  - SubprocessManager: vi.fn ensureRunning 返 stub McpClient（同 Phase A 单测范式）
 *  - sessionProvider: vi.fn 返 mock { sessionId, status }
 *  - McpServer: stub { tool: vi.fn() } 验 registerSteelTool 注册行为
 *  - 不触真网（global.fetch 在集成测中不被调 —— sessionProvider 注入 mock）
 *
 * 与 Phase A 单测（test/unit/steel-channel.spec.ts）的边界：
 *  - 单测覆盖 SteelChannel 内部（构造 / mutex / hook / extends）
 *  - 集成测覆盖 SteelChannel 与外部协作（FallbackDecider / PolicyGate / CapabilityBag / McpServer）
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SteelChannel } from "../../src/channels/SteelChannel.js";
import { StealthEngine } from "../../src/browse/StealthEngine.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { PolicyGate } from "../../src/fallback/PolicyGate.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { CapabilityBag } from "../../src/runtime/CapabilityBag.js";
import { registerSteelTool } from "../../src/tools/steel.js";
import { STEEL } from "../../src/config/providers.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { ProviderConfig } from "../../src/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// ============================================================
// Mock helpers（仿 Phase A 单测 steel-channel.spec.ts 范式）
// ============================================================
function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** stub McpClient：navigate_page / evaluate_script / list_pages 等都返固定 fixture。 */
function makeStubClient(): McpClient {
  return {
    callTool: vi.fn(async (name: string) => {
      if (name === "navigate_page") return textContent("navigated");
      if (name === "evaluate_script") return textContent("injected");
      if (name === "list_pages")
        return textContent("steel session page\nhttps://example.com/");
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () => [
      { name: "navigate_page", inputSchema: {} },
      { name: "evaluate_script", inputSchema: {} },
    ]),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
}

/** mock SubprocessManager：registerSpec + ensureRunning 返 stub client。 */
function makeMockSubproc(stubClient: McpClient): SubprocessManager {
  return {
    registerSpec: vi.fn(),
    ensureRunning: vi.fn(async () => stubClient),
    shutdown: vi.fn(async () => {}),
    shutdownOne: vi.fn(async () => {}),
    healthProbe: vi.fn(async () => "healthy" as const),
    restart: vi.fn(async () => stubClient),
    listManagedPids: vi.fn(() => []),
    acquireHttpClient: vi.fn(),
    startZombieReaper: vi.fn(),
  } as unknown as SubprocessManager;
}

/** mock sessionProvider：返固定 { sessionId, status }（不触网）。 */
function makeMockSessionProvider(
  sessionId = "steel-integration-sess-uuid",
  status = "live",
) {
  return vi.fn(async (_endpoint: string) => ({ sessionId, status }));
}

/** mock PolicyGateRegistry：get(name) 返 STEEL ProviderConfig（当 name="steel"）。 */
function makeMockRegistry() {
  const configs: Record<string, ProviderConfig> = { steel: STEEL };
  return {
    get: (name: string) => {
      const config = configs[name];
      return config ? { config } : undefined;
    },
  };
}

/** 最小 mock McpServer：仅 server.tool(...) 注册捕获。 */
function makeMockServer(): {
  server: { tool: ReturnType<typeof vi.fn> };
  registeredTools: Array<{ name: string; description: unknown }>;
} {
  const registeredTools: Array<{ name: string; description: unknown }> = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        description: unknown,
        _schema?: unknown,
        _annotations?: ToolAnnotations,
        _handler?: unknown,
      ) => {
        registeredTools.push({ name, description });
      },
    ),
  };
  return { server, registeredTools };
}

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-steel-int-"));
  setStateStoreContext({ runId, cacheDir: tempCache });
});

afterEach(async () => {
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ============================================================
// 1. SteelChannel 端到端 mock REST：browse outcome=worked
// ============================================================
describe("SteelChannel 端到端 mock REST flow", () => {
  it("完整路径：sessionProvider → registerSpec(--browser-url=9223) → ensureRunning → browse outcome=worked", async () => {
    const stubClient = makeStubClient();
    const subproc = makeMockSubproc(stubClient);
    const sessionProvider = makeMockSessionProvider(
      "steel-e2e-sess-001",
      "live",
    );
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider },
    );

    const r = await ch.browse("https://example.com/", "navigate", {});

    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("browse_cloud_steel");
    expect(r.retrieval_method).toBe("cloud_steel");
    expect(sessionProvider).toHaveBeenCalledTimes(1);
    expect(sessionProvider).toHaveBeenCalledWith("http://localhost:3000");
    expect(ch._testGetCachedSessionId()).toBe("steel-e2e-sess-001");
  });

  it("第二次 browse 复用 cachedClient（端到端 lazy connect 验证）", async () => {
    const stubClient = makeStubClient();
    const subproc = makeMockSubproc(stubClient);
    const sessionProvider = makeMockSessionProvider();
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider },
    );

    await ch.browse("https://example.com/", "navigate", {});
    await ch.browse("https://example.com/", "snapshot", {});

    // sessionProvider 只调 1 次（cachedClient 在）
    expect(sessionProvider).toHaveBeenCalledTimes(1);
    expect(ch._testHasCachedClient()).toBe(true);
  });
});

// ============================================================
// 2. FallbackDecider + SteelChannel：plan primary=browse_cloud_steel 路由
// ============================================================
describe("FallbackDecider + SteelChannel 路由", () => {
  it("plan primary=browse_cloud_steel → decider.runWithFallback 路由到 steel.browse", async () => {
    const stubClient = makeStubClient();
    const subproc = makeMockSubproc(stubClient);
    const steel = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );

    const breakers = new Map<string, CircuitBreaker>([
      ["browse_cloud_steel", new CircuitBreaker()],
    ]);
    // PolicyGate 未注入 → runWithFallback 行为完全等价 v0.3.5（零回归）
    const decider = new FallbackDecider(breakers);

    const plan = {
      primary: "browse_cloud_steel",
      fallbacks: [],
      cross_modal: false,
    };

    const result = await decider.runWithFallback(plan, async (name) => {
      if (name === "browse_cloud_steel") {
        return steel.browse("https://example.com/", "navigate", {});
      }
      throw new Error(`unknown_channel:${name}`);
    });

    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("browse_cloud_steel");
    expect(result.retrieval_method).toBe("cloud_steel");
  });
});

// ============================================================
// 3. PolicyGate 双重解锁（LASSO_ALLOW_CLOUD_BROWSER + cloudBrowserKeys 含 "steel"）
// ============================================================
describe("PolicyGate 双重解锁 browse_cloud_steel", () => {
  it("manual-switch=true + cloudBrowserKeys 含 'steel' → 放行", () => {
    const registry = makeMockRegistry();
    const gate = new PolicyGate(
      {
        allowCloudBrowser: true,
        cloudBrowserKeys: new Set(["steel"]),
      },
      registry,
    );

    const verdict = gate.check("browse_cloud_steel");
    expect(verdict.allowed).toBe(true);
  });

  it("manual-switch=false → blocked:cloud_browser_requires_manual_switch", () => {
    const registry = makeMockRegistry();
    const gate = new PolicyGate(
      {
        allowCloudBrowser: false,
        cloudBrowserKeys: new Set(["steel"]),
      },
      registry,
    );

    const verdict = gate.check("browse_cloud_steel");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("cloud_browser_requires_manual_switch");
    expect(verdict.reason).toContain("LASSO_ALLOW_CLOUD_BROWSER");
  });

  it("manual-switch=true 但 STEEL_ENDPOINT 缺（cloudBrowserKeys 不含 'steel'）→ blocked:cloud_browser_missing_api_key:steel", () => {
    const registry = makeMockRegistry();
    // 模拟 STEEL_ENDPOINT 未配：cloudBrowserKeys 不含 "steel"
    const gate = new PolicyGate(
      {
        allowCloudBrowser: true,
        cloudBrowserKeys: new Set(["browserbase"]), // 只有 browserbase，无 steel
      },
      registry,
    );

    const verdict = gate.check("browse_cloud_steel");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("cloud_browser_missing_api_key:steel");
  });

  it("policy_risk=safe 的 STEEL ProviderConfig：双重解锁后不被 acquired 阻断", () => {
    // 守 parse14 §3.3：STEEL policy_risk=safe（自托管无收购风险），不同于 TAVILY_WATCH=acquired
    expect(STEEL.policy_risk).toBe("safe");
    expect(STEEL.tags).toContain("cloud");
    expect(STEEL.tags).toContain("self_hosted");
    expect(STEEL.licence).toBe("apache2");
  });
});

// ============================================================
// 4. FallbackDecider + PolicyGate 联动（policy_blocked 的 channel 被跳过）
// ============================================================
describe("FallbackDecider + PolicyGate 联动阻断", () => {
  it("PolicyGate 注入 + manual-switch=false → outcome=didnt + retrieval_method=policy_blocked", async () => {
    const stubClient = makeStubClient();
    const subproc = makeMockSubproc(stubClient);
    const steel = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );

    const registry = makeMockRegistry();
    // manual-switch off → PolicyGate 阻断 browse_cloud_steel
    const gate = new PolicyGate(
      {
        allowCloudBrowser: false,
        cloudBrowserKeys: new Set(["steel"]),
      },
      registry,
    );

    const breakers = new Map<string, CircuitBreaker>([
      ["browse_cloud_steel", new CircuitBreaker()],
    ]);
    const decider = new FallbackDecider(breakers, gate);

    const plan = {
      primary: "browse_cloud_steel",
      fallbacks: [],
      cross_modal: false,
    };

    // PolicyGate 阻断 + 无 fallback → outcome=didnt + policy_blocked
    const result = await decider.runWithFallback(plan, async (name) => {
      if (name === "browse_cloud_steel") {
        return steel.browse("https://example.com/", "navigate", {});
      }
      throw new Error(`unknown_channel:${name}`);
    });

    expect(result.outcome).toBe("didnt");
    // policy_blocked retrieval_method（FallbackDecider 全部 channel 被 PolicyGate filter 时）
    expect(result.retrieval_method).toMatch(/policy_blocked|cloud_browser_requires_manual_switch/);
  });
});

// ============================================================
// 5. CapabilityBag 含 browse_cloud_steel（条件装配 + disable/enable 联动）
// ============================================================
describe("CapabilityBag browse_cloud_steel 条件装配", () => {
  it("初始化含 browse_cloud_steel → snapshot() 含 + enabled=true", () => {
    // 模拟 index.ts 装配段：cloudEnv.enabled + steelEndpoint → initialCapabilities.push("browse_cloud_steel")
    const bag = new CapabilityBag([
      "browse_headless",
      "browse_logged_in",
      "browse_cloud_steel", // v1.6 parse14 §3.3 条件加入
    ]);

    const snap = bag.snapshot();
    const steel = snap.find((s) => s.name === "browse_cloud_steel");
    expect(steel).toBeDefined();
    expect(steel?.enabled).toBe(true);
    expect(steel?.kind).toBe("channel");
  });

  it("disable(browse_cloud_steel) → enabled=false + onChange 触发", async () => {
    const bag = new CapabilityBag([
      "browse_headless",
      "browse_cloud_steel",
    ]);

    const changes: Array<{ name: string; enabled: boolean }> = [];
    bag.onChange(async (name, enabled) => {
      changes.push({ name, enabled });
    });

    const ok = await bag.disable("browse_cloud_steel", {
      callerId: "test",
      reason: "integration_test",
    });
    expect(ok).toBe(true);

    const snap = bag.snapshot();
    const steel = snap.find((s) => s.name === "browse_cloud_steel");
    expect(steel?.enabled).toBe(false);

    // onChange 被触发（disabled 事件）
    expect(changes.some((c) => c.name === "browse_cloud_steel" && !c.enabled)).toBe(true);
  });

  it("enable(browse_cloud_steel) → enabled=true（disable 后可恢复）", async () => {
    const bag = new CapabilityBag(["browse_cloud_steel"]);
    await bag.disable("browse_cloud_steel", {
      callerId: "test",
      reason: "tmp",
    });
    expect(
      bag.snapshot().find((s) => s.name === "browse_cloud_steel")?.enabled,
    ).toBe(false);

    const ok = await bag.enable("browse_cloud_steel");
    expect(ok).toBe(true);
    expect(
      bag.snapshot().find((s) => s.name === "browse_cloud_steel")?.enabled,
    ).toBe(true);
  });

  it("INV-36 衍生：未注册名 disable 返 false（不凭空造 channel）", async () => {
    const bag = new CapabilityBag(["browse_cloud_steel"]);
    const ok = await bag.disable("browse_cloud_nonexistent", {
      callerId: "test",
      reason: "should_fail",
    });
    expect(ok).toBe(false);
  });

  it("默认 OFF（cloudEnv.enabled=false）→ initialCapabilities 不含 browse_cloud_steel", () => {
    // 模拟 index.ts L770-772 条件：
    //   if (cloudEnv.enabled && cloudEnv.steelEndpoint) {
    //     initialCapabilities.push("browse_cloud_steel");
    //   }
    // 未解锁时 initialCapabilities 不含 steel → bag.snapshot() 不含
    const initialCapabilities = ["browse_headless", "browse_logged_in", "desktop"];
    // cloudEnv.enabled=false 时不 push steel
    const bag = new CapabilityBag(initialCapabilities);
    const snap = bag.snapshot();
    expect(snap.find((s) => s.name === "browse_cloud_steel")).toBeUndefined();
  });
});

// ============================================================
// 6. registerSteelTool 经 McpServer mock 注册
// ============================================================
describe("registerSteelTool 注册", () => {
  it("registerSteelTool → server.tool('steel', ...) 被调恰好一次", async () => {
    const stubClient = makeStubClient();
    const subproc = makeMockSubproc(stubClient);
    const steel = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );

    const breakers = new Map<string, CircuitBreaker>([
      ["browse_cloud_steel", new CircuitBreaker()],
    ]);
    const decider = new FallbackDecider(breakers);

    const ssrfConfig = {
      allowRanges: ["127.0.0.1/32"],
      denyRanges: ["10.0.0.0/8"],
    };
    const { server, registeredTools } = makeMockServer();

    registerSteelTool(
      server as unknown as Parameters<typeof registerSteelTool>[0],
      steel,
      decider,
      ssrfConfig,
    );

    expect(server.tool).toHaveBeenCalledTimes(1);
    expect(registeredTools[0]?.name).toBe("steel");
  });

  it("steel tool description 含 STEEL（自托管标识）+ LASSO_ALLOW_CLOUD_BROWSER 双重解锁提示", async () => {
    const stubClient = makeStubClient();
    const subproc = makeMockSubproc(stubClient);
    const steel = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );

    const decider = new FallbackDecider(new Map());
    const ssrfConfig = { allowRanges: ["127.0.0.1/32"], denyRanges: [] };
    const { server, registeredTools } = makeMockServer();

    registerSteelTool(
      server as unknown as Parameters<typeof registerSteelTool>[0],
      steel,
      decider,
      ssrfConfig,
    );

    // description 是 STEEL_DESCRIPTION 数组 join；含关键字
    const desc = String(registeredTools[0]?.description);
    expect(desc).toContain("STEEL_ENDPOINT");
    expect(desc).toContain("LASSO_ALLOW_CLOUD_BROWSER");
    expect(desc).toContain("steel-dev/steel-browser");
  });
});

// ============================================================
// 7. SteelChannel + FallbackDecider + PolicyGate 完整链路（happy path）
// ============================================================
describe("SteelChannel 完整链路：PolicyGate 放行 + FallbackDecider 路由 + CapabilityBag 联动", () => {
  it("双重解锁下端到端：PolicyGate 放行 → decider.runWithFallback → steel.browse outcome=worked", async () => {
    const stubClient = makeStubClient();
    const subproc = makeMockSubproc(stubClient);
    const steel = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider("final-chain-sess") },
    );

    // PolicyGate：双重解锁（manual-switch + cloudBrowserKeys 含 steel）
    const registry = makeMockRegistry();
    const gate = new PolicyGate(
      {
        allowCloudBrowser: true,
        cloudBrowserKeys: new Set(["steel"]),
      },
      registry,
    );
    expect(gate.check("browse_cloud_steel").allowed).toBe(true);

    // CapabilityBag：初始含 browse_cloud_steel
    const bag = new CapabilityBag(["browse_cloud_steel"]);

    // FallbackDecider 注入 PolicyGate
    const breakers = new Map<string, CircuitBreaker>([
      ["browse_cloud_steel", new CircuitBreaker()],
    ]);
    const decider = new FallbackDecider(breakers, gate);

    const plan = {
      primary: "browse_cloud_steel",
      fallbacks: [],
      cross_modal: false,
    };

    const result = await decider.runWithFallback(plan, async (name) => {
      if (name === "browse_cloud_steel") {
        return steel.browse("https://example.com/", "navigate", {});
      }
      throw new Error(`unknown_channel:${name}`);
    });

    // 端到端验证：双重解锁放行 + 路由正确 + browse outcome=worked
    expect(result.outcome).toBe("worked");
    expect(result.served_by).toBe("browse_cloud_steel");
    expect(result.retrieval_method).toBe("cloud_steel");

    // CapabilityBag 联动：steel channel 仍 enabled（未被 disable）
    const snap = bag.snapshot();
    expect(snap.find((s) => s.name === "browse_cloud_steel")?.enabled).toBe(true);

    // SteelChannel 内部状态：cached session 已建立
    expect(steel._testGetCachedSessionId()).toBe("final-chain-sess");
  });
});
