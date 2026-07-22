/**
 * long-circuit-bag-link 集成测（parse8 §3.1 + §5.2 + §6.1 #4 / #5）
 *
 * 验证 INV-42 端到端联动链：
 *   长熔断 open → onOpen 回调 → bag.disable(name, {reason:"long_circuit_open"})
 *   → bag.onChange handler → toolManager.disableChannel(name) → SDK tool.disable()
 *   → (channel 级) subproc.shutdownOne(specName)
 *
 * 与 unit/long-circuit-breaker.spec.ts 的分工（parse8 §5.2）：
 *  - unit：LongCircuitBreaker 自身状态机正确性（window/threshold/reset/half-open）
 *  - 集成（本文件）：状态机 + onOpen 闭包 + CapabilityBag + ToolManager + SubprocessManager
 *    全链路（与 runtime-disable-channel.test.ts 同范式，但触发器从 admin action
 *    capability_disable 换成 recordFailure 累计触发长熔断 open）
 *
 * 不依赖真实 stdio transport / chrome-devtools-mcp 子进程（CI 友好；parse8 §5.2 CI 列）。
 * 真实"月配额耗尽 → 子进程 kill + tool 下架 + admin capability_enable 恢复"由手测覆盖
 * （parse8-acceptance.md）。
 *
 * 守 INV-42：onOpen 闭包内显式调 bag.disable + 标 reason="long_circuit_open"，
 *           不绕过 INV-37 task 联动链（onChange → toolManager.disableChannel + subproc.shutdownOne）。
 */
import { describe, it, expect, vi } from "vitest";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CapabilityBag } from "../../src/runtime/CapabilityBag.js";
import { ToolManager } from "../../src/runtime/ToolManager.js";
import { LongCircuitBreaker } from "../../src/fallback/LongCircuitBreaker.js";

// ============================================================
// mocks（与 runtime-disable-channel.test.ts 同范式 —— 复用不打折扣）
// ============================================================
function makeMockServer(): {
  server: McpServer;
  tools: Map<
    string,
    {
      registered: RegisteredTool;
      enabled: boolean;
      disableCalls: number;
      enableCalls: number;
    }
  >;
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
  const server = {
    tool: vi.fn((name: string) => {
      const entry = {
        registered: {
          enabled: true,
          disable: () => {
            entry.enabled = false;
            entry.disableCalls++;
          },
          enable: () => {
            entry.enabled = true;
            entry.enableCalls++;
          },
          remove: () => {},
          update: () => {},
          handler: vi.fn(),
        } as unknown as RegisteredTool,
        enabled: true,
        disableCalls: 0,
        enableCalls: 0,
      };
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
    sendToolListChanged: vi.fn(() => {}),
  } as unknown as McpServer;
  return { server, tools };
}

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

// ============================================================
// 装配 helpers
// ============================================================
/**
 * 与 index.ts v0.7 装配段同结构（简化版）：
 *  - bag + toolManager + subproc mock
 *  - bag.onChange handler 联动 toolManager.disableChannel + subproc.shutdownOne
 *  - 单 channel 的 LongCircuitBreaker（onOpen 闭包内调 bag.disable）
 *
 * @param threshold  长熔断阈值（默认小值 3 便于测试；生产 10）
 * @param windowMs   滑动窗（默认 3_600_000）
 * @param resetMs    open 持续（默认 3_600_000）
 */
function wireLongCircuit(opts: {
  channel: string;
  specName: string | null;
  subproc: ReturnType<typeof makeMockSubproc>;
  threshold?: number;
  windowMs?: number;
  resetMs?: number;
}): {
  bag: CapabilityBag;
  toolManager: ToolManager;
  breaker: LongCircuitBreaker;
  server: McpServer;
  tools: Map<
    string,
    {
      registered: RegisteredTool;
      enabled: boolean;
      disableCalls: number;
      enableCalls: number;
    }
  >;
} {
  const { server, tools } = makeMockServer();
  // 注册一个 channel-owned tool（模拟 v0.5 注册路径）
  const tm = new ToolManager(server);
  const handle = (server as unknown as {
    tool: (n: string, ...rest: unknown[]) => RegisteredTool;
  }).tool(opts.channel, "desc", {}, {}, async () => ({}));
  tm.captureHandle(opts.channel, opts.channel, handle);

  const bag = new CapabilityBag([opts.channel]);

  // 与 index.ts v0.6 onChange handler 同结构
  const CHANNEL_TO_SPEC: Record<string, string | null> = {
    [opts.channel]: opts.specName,
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
    await opts.subproc.shutdownOne(specName);
  });

  // 与 index.ts v0.7-2 onOpen 闭包同结构（INV-42：显式 reason="long_circuit_open"）
  const breaker = new LongCircuitBreaker(
    opts.threshold ?? 3,
    opts.windowMs ?? 3_600_000,
    opts.resetMs ?? 3_600_000,
    async (n) => {
      await bag.disable(n, {
        callerId: "system",
        reason: "long_circuit_open",
      });
    },
    opts.channel,
  );

  return { bag, toolManager: tm, breaker, server, tools };
}

// ============================================================
// 测试用例
// ============================================================
describe("long-circuit → bag.disable 端到端（INV-42）", () => {
  it("threshold 次失败 → 长 breaker open → bag.disable → tool 下架 + subproc kill", async () => {
    const subproc = makeMockSubproc();
    const { bag, breaker, tools } = wireLongCircuit({
      channel: "browse_headless",
      specName: "headless",
      subproc,
      threshold: 3,
    });

    // ----- 前：全 enabled -----
    expect(bag.isEnabled("browse_headless")).toBe(true);
    expect(tools.get("browse_headless")!.enabled).toBe(true);
    expect(breaker.state).toBe("closed");

    // ----- 累计 threshold 次失败（滑动窗内）-----
    await breaker.recordFailure();
    await breaker.recordFailure();
    expect(breaker.state).toBe("closed"); // 2 < 3，仍 closed
    expect(bag.isEnabled("browse_headless")).toBe(true); // 未联动

    await breaker.recordFailure(); // 第 3 次 → 触发 open + onOpen → bag.disable
    expect(breaker.state).toBe("open");

    // ----- 断言 INV-42 链路：bag → toolManager → SDK tool + subproc -----
    const snap = bag.snapshot();
    const bh = snap.find((s) => s.name === "browse_headless")!;
    expect(bh.enabled).toBe(false);
    expect(bh.disabledBy).toBe("system");
    expect(bh.reason).toBe("long_circuit_open"); // INV-42 红线：reason 字段
    expect(bh.disabledAt).toBeGreaterThan(0);

    expect(tools.get("browse_headless")!.enabled).toBe(false);
    expect(tools.get("browse_headless")!.disableCalls).toBe(1);
    expect(subproc.shutdownCalls).toEqual(["headless"]); // channel 级 kill
  });

  it("provider 级 disable 不 kill shared subprocess（R-RT-2 缓解在长熔断场景仍守）", async () => {
    const subproc = makeMockSubproc();
    // provider 形式名（含 dot），bag 视为 kind="provider"，onChange 跳过 subproc kill
    const { bag, breaker, tools } = wireLongCircuit({
      channel: "desktop.cgEvent",
      specName: null, // provider 级；onChange 不映射 spec
      subproc,
      threshold: 2,
    });

    await breaker.recordFailure();
    await breaker.recordFailure(); // 触发 open → onOpen → bag.disable
    expect(breaker.state).toBe("open");

    // provider 级 disable：tool 下架但 subproc 不 kill（shared rust-helper 缓解）
    expect(bag.isEnabled("desktop.cgEvent")).toBe(false);
    expect(tools.get("desktop.cgEvent")!.enabled).toBe(false);
    expect(subproc.shutdownCalls).toEqual([]); // 关键：provider 级不 kill shared
  });

  it("长熔断 open 后 allow() 返 false（持续 60min 跳过；区别短熔断 60s）", async () => {
    const subproc = makeMockSubproc();
    const { breaker, bag } = wireLongCircuit({
      channel: "browse_headless",
      specName: "headless",
      subproc,
      threshold: 3,
      resetMs: 3_600_000, // 60min
    });

    // 触发 open
    await breaker.recordFailure();
    await breaker.recordFailure();
    await breaker.recordFailure();
    expect(breaker.state).toBe("open");

    // open 后 allow() 立即返 false（60min 内）
    expect(breaker.allow()).toBe(false);

    // 短时间后（远未到 60min）仍 false
    breaker._forceElapsedForTests(30_000); // 30s
    expect(breaker.allow()).toBe(false);

    // bag 仍 disabled（保守：不自动 enable）
    expect(bag.isEnabled("browse_headless")).toBe(false);
  });

  it("60min 后 half-open probe 成功 → breaker closed；但 bag 仍 disabled（保守设计）", async () => {
    const subproc = makeMockSubproc();
    const { breaker, bag, tools } = wireLongCircuit({
      channel: "browse_headless",
      specName: "headless",
      subproc,
      threshold: 3,
      resetMs: 3_600_000,
    });

    // 触发 open
    await breaker.recordFailure();
    await breaker.recordFailure();
    await breaker.recordFailure();
    expect(breaker.state).toBe("open");
    expect(bag.isEnabled("browse_headless")).toBe(false);

    // 60min 后 allow() 转 half-open + 放 probe
    breaker._forceElapsedForTests(3_600_001);
    expect(breaker.allow()).toBe(true);
    expect(breaker.state).toBe("half-open");

    // probe 成功 → closed
    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");

    // 关键不变量：bag 仍 disabled —— 长熔断不自动 enable，需 admin 显式 capability_enable
    expect(bag.isEnabled("browse_headless")).toBe(false);
    expect(tools.get("browse_headless")!.enabled).toBe(false);
  });

  it("onOpen 闭包抛错 → 不污染 breaker 状态（breaker 仍 open；保守吞错）", async () => {
    // 自定义 onOpen 抛错的 breaker
    const failingBreaker = new LongCircuitBreaker(
      2,
      3_600_000,
      3_600_000,
      async () => {
        throw new Error("simulated bag.disable failure");
      },
      "test.channel",
    );

    await failingBreaker.recordFailure();
    await failingBreaker.recordFailure(); // 触发 open + onOpen 抛错

    // breaker 状态正确（open），不受 onOpen 抛错影响
    expect(failingBreaker.state).toBe("open");
    expect(failingBreaker.openedAtReadOnly).toBeGreaterThan(0);
  });

  it("window 外的失败被剔除：threshold-1 次失败 + window 外 1 次 → 仍 closed", async () => {
    const subproc = makeMockSubproc();
    const { breaker, bag } = wireLongCircuit({
      channel: "browse_headless",
      specName: "headless",
      subproc,
      threshold: 3,
      windowMs: 1000, // 1s 窗口便于测试
    });

    // 2 次失败（threshold-1）
    await breaker.recordFailure();
    await breaker.recordFailure();
    expect(breaker.state).toBe("closed");

    // 快进超过 window
    breaker._forceElapsedForTests(1500); // 1.5s 后 window 外

    // 再加 1 次失败 —— 窗口外 2 次应被剔除 + 当前 1 次 < threshold(3)
    await breaker.recordFailure();
    expect(breaker.state).toBe("closed");
    expect(bag.isEnabled("browse_headless")).toBe(true); // 未触发联动
  });

  it("双 breaker 串联：短熔断先 open 时仍走短路径；长熔断 open 时走 bag.disable", async () => {
    // 本 case 覆盖 FallbackDecider 双 breaker 串联逻辑的预期行为契约
    // （FallbackDecider 集成测试在 fallback-decider.spec.ts 已覆盖；此处仅断言
    //   LongCircuitBreaker 独立 + onOpen 链路不污染短熔断。）
    const subproc = makeMockSubproc();
    const { breaker: longB, bag } = wireLongCircuit({
      channel: "browse_headless",
      specName: "headless",
      subproc,
      threshold: 5,
    });

    // 长熔断 closed 时 allow() 与短熔断独立
    expect(longB.allow()).toBe(true);

    // 触发长熔断（5 次失败）
    for (let i = 0; i < 5; i++) {
      await longB.recordFailure();
    }
    expect(longB.state).toBe("open");
    expect(bag.isEnabled("browse_headless")).toBe(false); // 联动

    // 此时长熔断 allow=false；外层 FallbackDecider 据此跳过该 channel
    expect(longB.allow()).toBe(false);
  });
});
