/**
 * ToolManager 单元测（parse7 §3.2 + §5.2 ~12 用例）
 *
 * 覆盖：
 *  - register：包装 server.tool() 字节等价 + 记录 channel 归属 + 重名抛错
 *  - disableChannel：调 tool.disable()（SDK 自动 sendToolListChanged）+ 未注册 channel no-op
 *  - enableChannel：调 tool.enable()
 *  - removeChannel：调 tool.remove() + 清理内部 Map
 *  - captureHandle：非破坏性捕获 v0.5 句柄（M0.6a 末期评估）
 *  - listByChannel / channelOf / has / size 查询
 *  - registerChannelTools 批量注册
 *  - INV-37 衍生：disableChannel 是 channel→tool 映射的唯一禁用入口
 */
import { describe, it, expect, vi } from "vitest";
import { ToolManager, type ToolRegistration } from "../../../src/runtime/ToolManager.js";
import type { RegisteredTool, McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ============================================================
// mocks
// ============================================================
/**
 * 构造 mock McpServer：tool() 返回 mock RegisteredTool（持 disable/enable/remove 调用记录）。
 *
 * 与 SDK 1.29 真实行为对齐：
 *  - tool() 返回 RegisteredTool 对象（含 .disable()/.enable()/.remove()/.update()）
 *  - .disable() 内部 → update({enabled:false}) → 自动 sendToolListChanged（SDK 内部）
 *  - 这里 mock 用 vi.fn() 记录调用，验证 ToolManager 是否正确路由
 */
function makeMockServer(): {
  server: McpServer;
  registeredTools: Map<string, { registered: RegisteredTool; calls: Record<string, number> }>;
  toolCallCount: number;
} {
  const registeredTools = new Map<
    string,
    { registered: RegisteredTool; calls: Record<string, number> }
  >();
  let toolCallCount = 0;
  const server = {
    tool: vi.fn((name: string, ..._rest: unknown[]) => {
      toolCallCount++;
      const calls: Record<string, number> = {
        disable: 0,
        enable: 0,
        remove: 0,
        update: 0,
      };
      const registered: RegisteredTool = {
        enabled: true,
        disable: () => {
          calls.disable++;
          registered.enabled = false;
        },
        enable: () => {
          calls.enable++;
          registered.enabled = true;
        },
        remove: () => {
          calls.remove++;
        },
        update: () => {
          calls.update++;
        },
        handler: vi.fn(),
      };
      registeredTools.set(name, { registered, calls });
      return registered;
    }),
    sendToolListChanged: vi.fn(() => {}),
  } as unknown as McpServer;
  return { server, registeredTools, toolCallCount: 0 /* via closure */ };
}

function makeReg(name: string): ToolRegistration {
  return {
    name,
    description: `test tool ${name}`,
    schema: {},
    annotations: { readOnlyHint: true },
    handler: async () => ({ content: [] }),
  };
}

describe("ToolManager.register — 包装 server.tool()", () => {
  it("register 调 server.tool() 一次 + 返回 RegisteredTool 句柄", () => {
    const { server, registeredTools } = makeMockServer();
    const tm = new ToolManager(server);
    const reg = makeReg("tool_a");
    const handle = tm.register("browse_headless", reg);
    expect(server.tool).toHaveBeenCalledTimes(1);
    expect(registeredTools.get("tool_a")).toBeDefined();
    expect(handle).toBe(registeredTools.get("tool_a")!.registered);
  });

  it("register 记录 channel 归属（channelOf 查询）", () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("snapshot"));
    tm.register("browse_headless", makeReg("evaluate"));
    tm.register("desktop", makeReg("act"));
    expect(tm.channelOf("snapshot")).toBe("browse_headless");
    expect(tm.channelOf("evaluate")).toBe("browse_headless");
    expect(tm.channelOf("act")).toBe("desktop");
  });

  it("register 同名 tool 抛错（INV-36 task：重名是真冲突）", () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("tool_x"));
    expect(() => tm.register("desktop", makeReg("tool_x"))).toThrow(
      /already registered/,
    );
  });

  it("register 后 has(name)=true / size 增", () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    expect(tm.has("x")).toBe(false);
    expect(tm.size()).toBe(0);
    tm.register("browse_headless", makeReg("x"));
    expect(tm.has("x")).toBe(true);
    expect(tm.size()).toBe(1);
  });
});

describe("ToolManager.disableChannel — INV-37 channel disable 必经此方法", () => {
  it("disableChannel 调每个 tool 的 .disable()", async () => {
    const { server, registeredTools } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("a"));
    tm.register("browse_headless", makeReg("b"));
    tm.register("desktop", makeReg("c"));
    await tm.disableChannel("browse_headless");
    expect(registeredTools.get("a")!.calls.disable).toBe(1);
    expect(registeredTools.get("b")!.calls.disable).toBe(1);
    // 其他 channel 的 tool 不受影响
    expect(registeredTools.get("c")!.calls.disable).toBe(0);
  });

  it("disableChannel 后 tool.enabled=false", async () => {
    const { server, registeredTools } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("a"));
    await tm.disableChannel("browse_headless");
    expect(registeredTools.get("a")!.registered.enabled).toBe(false);
  });

  it("disableChannel 未注册 channel → no-op（不抛错）", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    await expect(tm.disableChannel("nonexistent")).resolves.toBeUndefined();
  });

  it("disableChannel 单 tool disable 抛错 → log warn 不阻断其余 tool", async () => {
    const { server, registeredTools } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("good"));
    // 注入一个抛错的 tool（直接 mutate registered.disable）
    const failing = registeredTools.get("good")!.registered;
    failing.disable = () => {
      throw new Error("synthetic disable error");
    };
    tm.register("browse_headless", makeReg("second"));
    // 不抛错
    await expect(tm.disableChannel("browse_headless")).resolves.toBeUndefined();
    // second 的 disable 仍被调
    expect(registeredTools.get("second")!.calls.disable).toBe(1);
  });
});

describe("ToolManager.enableChannel", () => {
  it("enableChannel 调每个 tool 的 .enable()", async () => {
    const { server, registeredTools } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("a"));
    await tm.disableChannel("browse_headless");
    await tm.enableChannel("browse_headless");
    expect(registeredTools.get("a")!.calls.enable).toBe(1);
    expect(registeredTools.get("a")!.registered.enabled).toBe(true);
  });

  it("enableChannel 未注册 channel → no-op", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    await expect(tm.enableChannel("nonexistent")).resolves.toBeUndefined();
  });
});

describe("ToolManager.removeChannel — 永久下架", () => {
  it("removeChannel 调 tool.remove() + 清理内部 Map", async () => {
    const { server, registeredTools } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("a"));
    tm.register("browse_headless", makeReg("b"));
    await tm.removeChannel("browse_headless");
    expect(registeredTools.get("a")!.calls.remove).toBe(1);
    expect(registeredTools.get("b")!.calls.remove).toBe(1);
    // 内部 Map 清理
    expect(tm.has("a")).toBe(false);
    expect(tm.has("b")).toBe(false);
    expect(tm.size()).toBe(0);
    // listByChannel 不再有该 channel
    expect(tm.listByChannel().has("browse_headless")).toBe(false);
  });

  it("removeChannel 未注册 channel → no-op", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    await expect(tm.removeChannel("nonexistent")).resolves.toBeUndefined();
  });

  it("removeChannel 后其他 channel 仍可正常使用", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("a"));
    tm.register("desktop", makeReg("b"));
    await tm.removeChannel("browse_headless");
    expect(tm.has("a")).toBe(false);
    expect(tm.has("b")).toBe(true);
    expect(tm.channelOf("b")).toBe("desktop");
  });
});

describe("ToolManager.captureHandle — 非破坏性捕获 v0.5 句柄", () => {
  it("captureHandle 已存在 handle → 加入 tools Map + byChannel Map", () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    const fakeHandle: RegisteredTool = {
      enabled: true,
      enable: vi.fn(),
      disable: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      handler: vi.fn(),
    };
    tm.captureHandle("browse_headless", "v0_5_tool", fakeHandle);
    expect(tm.has("v0_5_tool")).toBe(true);
    expect(tm.channelOf("v0_5_tool")).toBe("browse_headless");
  });

  it("captureHandle 不调 server.tool（非破坏性，v0.5 已注册过）", () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    const fakeHandle: RegisteredTool = {
      enabled: true,
      enable: vi.fn(),
      disable: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      handler: vi.fn(),
    };
    tm.captureHandle("browse_headless", "x", fakeHandle);
    expect(server.tool).not.toHaveBeenCalled();
  });

  it("captureHandle 后 disableChannel 仍作用到 handle", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    const disable = vi.fn();
    const fakeHandle: RegisteredTool = {
      enabled: true,
      enable: vi.fn(),
      disable,
      remove: vi.fn(),
      update: vi.fn(),
      handler: vi.fn(),
    };
    tm.captureHandle("browse_headless", "captured", fakeHandle);
    await tm.disableChannel("browse_headless");
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("captureHandle 已注册 name → no-op（不覆盖原 record）", () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("dup"));
    const before = tm.size();
    tm.captureHandle("browse_headless", "dup", {
      enabled: true,
      enable: vi.fn(),
      disable: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
      handler: vi.fn(),
    });
    expect(tm.size()).toBe(before);
  });
});

describe("ToolManager.registerChannelTools — 批量", () => {
  it("registerChannelTools 批量注册多个 tool 到同 channel", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    await tm.registerChannelTools("browse_headless", [
      makeReg("a"),
      makeReg("b"),
      makeReg("c"),
    ]);
    expect(tm.size()).toBe(3);
    expect(tm.channelOf("a")).toBe("browse_headless");
    expect(tm.channelOf("b")).toBe("browse_headless");
    expect(tm.channelOf("c")).toBe("browse_headless");
  });

  it("registerChannelTools 中途重名 → 抛错（事务性）", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("dup"));
    await expect(
      tm.registerChannelTools("browse_headless", [
        makeReg("ok"),
        makeReg("dup"), // 重名
      ]),
    ).rejects.toThrow(/already registered/);
    // "ok" 已注册（事务性回滚不在本方法；调用方负责）
    expect(tm.has("ok")).toBe(true);
  });
});

describe("ToolManager.listByChannel — channel → tool 名集合", () => {
  it("listByChannel 返回 channel → tool 名数组", () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("a"));
    tm.register("browse_headless", makeReg("b"));
    tm.register("desktop", makeReg("c"));
    const map = tm.listByChannel();
    expect(map.size).toBe(2);
    expect(map.get("browse_headless")?.sort()).toEqual(["a", "b"]);
    expect(map.get("desktop")).toEqual(["c"]);
  });

  it("listByChannel 返回新 Map + 新数组（防外部 mutate）", () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("a"));
    const m1 = tm.listByChannel();
    const m2 = tm.listByChannel();
    expect(m1).not.toBe(m2);
    m1.get("browse_headless")!.push("external");
    expect(m2.get("browse_headless")).toEqual(["a"]);
  });
});

describe("ToolManager.disableTool / enableTool — 单 tool 操作", () => {
  it("disableTool 已注册 → 返 true + 调 .disable()", async () => {
    const { server, registeredTools } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("a"));
    const ok = await tm.disableTool("a");
    expect(ok).toBe(true);
    expect(registeredTools.get("a")!.calls.disable).toBe(1);
  });

  it("disableTool 未注册 → 返 false", async () => {
    const { server } = makeMockServer();
    const tm = new ToolManager(server);
    const ok = await tm.disableTool("nonexistent");
    expect(ok).toBe(false);
  });

  it("enableTool 已注册 → 返 true + 调 .enable()", async () => {
    const { server, registeredTools } = makeMockServer();
    const tm = new ToolManager(server);
    tm.register("browse_headless", makeReg("a"));
    await tm.disableTool("a");
    const ok = await tm.enableTool("a");
    expect(ok).toBe(true);
    expect(registeredTools.get("a")!.calls.enable).toBe(1);
  });
});
