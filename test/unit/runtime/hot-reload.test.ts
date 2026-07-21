/**
 * hot-reload 单元测（parse7 §3.6 + §5.2 ~8 用例）
 *
 * 覆盖：
 *  - applyHotReload diff：新增（incoming - existing）+ 移除（existing - incoming）
 *  - addProvider / removeProvider 单条特例（admin tool 入口）
 *  - INV-40 衍生：新 provider 必经 registry.add（mock 验证调用）
 *  - INV-36 衍生：bag.register 是 bag 新 entry 的唯一入口
 *  - enabled=false 的 config 静默跳过（与 constructor 同语义）
 *  - 重名 add 抛错 → log warn 不崩
 *  - SIGHUP 安装：configPath=null → 不安装；非 null → process.on SIGHUP
 *  - SIGHUP 触发：读 LASSO_PROVIDERS_FILE → applyHotReload
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installSighupHotReload,
  applyHotReload,
  addProvider,
  removeProvider,
} from "../../../src/runtime/hot-reload.js";
import type { CapabilityBag } from "../../../src/runtime/CapabilityBag.js";
import type { ToolManager } from "../../../src/runtime/ToolManager.js";
import type { ProviderRegistry } from "../../../src/config/provider-registry.js";
import type { ProviderConfig } from "../../../src/types.js";

// ============================================================
// mocks
// ============================================================
/**
 * Mock ProviderRegistry：记录 add/remove 调用；持 byName map 支持重名检测。
 *
 * 与 v0.6 ProviderRegistry 实装 API 对齐：listNames / add / remove。
 */
function makeMockRegistry(
  initial: ProviderConfig[] = [],
): ProviderRegistry & {
  addCalls: ProviderConfig[];
  removeCalls: string[];
} {
  const byName = new Map<string, ProviderConfig>();
  for (const c of initial) byName.set(c.name, c);
  const addCalls: ProviderConfig[] = [];
  const removeCalls: string[] = [];
  const registry = {
    listNames: () => Array.from(byName.keys()),
    add: vi.fn((c: ProviderConfig) => {
      if (byName.has(c.name)) {
        throw new Error(`ProviderRegistry: ${c.name} already registered`);
      }
      if (c.enabled === false) return;
      byName.set(c.name, c);
      addCalls.push(c);
    }),
    remove: vi.fn((name: string) => {
      if (!byName.has(name)) return false;
      byName.delete(name);
      removeCalls.push(name);
      return true;
    }),
  } as unknown as ProviderRegistry & { addCalls: ProviderConfig[]; removeCalls: string[] };
  registry.addCalls = addCalls;
  registry.removeCalls = removeCalls;
  return registry;
}

/**
 * Mock CapabilityBag：记录 register/disable/enable 调用。
 */
function makeMockBag(
  initial: string[] = [],
): CapabilityBag & {
  registerCalls: string[];
  disableCalls: Array<{ name: string; opts?: { callerId?: string; reason?: string } }>;
  enableCalls: string[];
} {
  const names = new Set(initial);
  const registerCalls: string[] = [];
  const disableCalls: Array<{ name: string; opts?: { callerId?: string; reason?: string } }> = [];
  const enableCalls: string[] = [];
  const bag = {
    register: vi.fn((name: string) => {
      if (names.has(name)) return;
      names.add(name);
      registerCalls.push(name);
    }),
    disable: vi.fn(async (name: string, opts?: { callerId?: string; reason?: string }) => {
      if (!names.has(name)) return false;
      disableCalls.push({ name, opts });
      return true;
    }),
    enable: vi.fn(async (name: string) => {
      if (!names.has(name)) return false;
      enableCalls.push(name);
      return true;
    }),
    has: vi.fn((name: string) => names.has(name)),
    unregister: vi.fn((name: string) => names.delete(name)),
  } as unknown as CapabilityBag & {
    registerCalls: string[];
    disableCalls: Array<{ name: string; opts?: { callerId?: string; reason?: string } }>;
    enableCalls: string[];
  };
  bag.registerCalls = registerCalls;
  bag.disableCalls = disableCalls;
  bag.enableCalls = enableCalls;
  return bag;
}

/** Mock ToolManager（hot-reload Phase A 暂不直接调，预留位） */
function makeMockToolManager(): ToolManager {
  return {
    disableChannel: vi.fn(async () => undefined),
    enableChannel: vi.fn(async () => undefined),
    removeChannel: vi.fn(async () => undefined),
  } as unknown as ToolManager;
}

function makeProviderConfig(
  name: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    name,
    type: "api_key",
    endpoint_url: `https://${name}.example.com`,
    keys: [],
    free_quota_per_month: 1000,
    quota_model: "monthly",
    fallback_order: 99,
    enabled: true,
    ...overrides,
  };
}

describe("applyHotReload — diff 计算 + INV-40 经 registry.add", () => {
  it("新增：incoming - existing → registry.add + bag.register", async () => {
    const registry = makeMockRegistry([makeProviderConfig("brave")]);
    const bag = makeMockBag(["brave"]);
    const tm = makeMockToolManager();
    const newConfigs = [
      makeProviderConfig("brave"),
      makeProviderConfig("brave2"), // 新增
    ];
    const report = await applyHotReload(newConfigs, registry, bag, tm);
    expect(report.added).toEqual(["brave2"]);
    expect(report.removed).toEqual([]);
    // INV-40：经 registry.add（不直接 mutate BUILTIN_PROVIDERS）
    expect(registry.add).toHaveBeenCalledWith(makeProviderConfig("brave2"));
    // INV-36：bag.register 是新 entry 的唯一入口
    expect(bag.register).toHaveBeenCalledWith("brave2");
  });

  it("移除：existing - incoming → registry.remove + bag.disable", async () => {
    const registry = makeMockRegistry([
      makeProviderConfig("brave"),
      makeProviderConfig("brave2"),
    ]);
    const bag = makeMockBag(["brave", "brave2"]);
    const tm = makeMockToolManager();
    // 新配置只有 brave（移除 brave2）
    const report = await applyHotReload(
      [makeProviderConfig("brave")],
      registry,
      bag,
      tm,
    );
    expect(report.removed).toEqual(["brave2"]);
    expect(report.added).toEqual([]);
    // INV-40：经 registry.remove
    expect(registry.remove).toHaveBeenCalledWith("brave2");
    // bag.disable 触发（保留 audit 痕迹）
    expect(bag.disableCalls.find((c) => c.name === "brave2")).toBeDefined();
    expect(bag.disableCalls.find((c) => c.name === "brave2")?.opts?.callerId).toBe("hot_reload");
  });

  it("无变化：existing === incoming → add/remove 都为空", async () => {
    const registry = makeMockRegistry([makeProviderConfig("brave")]);
    const bag = makeMockBag(["brave"]);
    const tm = makeMockToolManager();
    const report = await applyHotReload(
      [makeProviderConfig("brave")],
      registry,
      bag,
      tm,
    );
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(registry.add).not.toHaveBeenCalled();
    expect(registry.remove).not.toHaveBeenCalled();
  });

  it("enabled=false 的 config 静默跳过（与 constructor 同语义）", async () => {
    const registry = makeMockRegistry([]);
    const bag = makeMockBag([]);
    const tm = makeMockToolManager();
    const disabled = makeProviderConfig("tavily_watch", { enabled: false });
    const report = await applyHotReload([disabled], registry, bag, tm);
    expect(report.added).toEqual([]);
    expect(registry.add).not.toHaveBeenCalled();
  });

  it("registry.add 抛错（如重名竞态）→ log warn 不中断其余", async () => {
    const existing = makeProviderConfig("existing");
    const registry = makeMockRegistry([existing]);
    // 让 add 总抛错
    (registry.add as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("synthetic add error");
    });
    const bag = makeMockBag(["existing"]);
    const tm = makeMockToolManager();
    // 不抛错（错误隔离）
    const report = await applyHotReload(
      [existing, makeProviderConfig("new")],
      registry,
      bag,
      tm,
    );
    expect(report.added).toEqual([]); // new 因 add 抛错未入
  });
});

describe("addProvider — admin provider_add action 入口", () => {
  it("addProvider 新 config → registry.add + bag.register（INV-40）", async () => {
    const registry = makeMockRegistry([]);
    const bag = makeMockBag([]);
    const tm = makeMockToolManager();
    const cfg = makeProviderConfig("brave2");
    await addProvider(cfg, registry, bag, tm);
    expect(registry.add).toHaveBeenCalledWith(cfg);
    expect(bag.register).toHaveBeenCalledWith("brave2");
  });

  it("addProvider enabled=false → no-op（与 constructor 同语义）", async () => {
    const registry = makeMockRegistry([]);
    const bag = makeMockBag([]);
    const tm = makeMockToolManager();
    await addProvider(
      makeProviderConfig("tavily", { enabled: false }),
      registry,
      bag,
      tm,
    );
    expect(registry.add).not.toHaveBeenCalled();
    expect(bag.register).not.toHaveBeenCalled();
  });

  it("addProvider 重名 → 抛错（registry.add 抛错透传）", async () => {
    const existing = makeProviderConfig("dup");
    const registry = makeMockRegistry([existing]);
    const bag = makeMockBag(["dup"]);
    const tm = makeMockToolManager();
    await expect(
      addProvider(existing, registry, bag, tm),
    ).rejects.toThrow(/already registered/);
  });
});

describe("removeProvider — admin provider_remove action 入口", () => {
  it("removeProvider 已存在 → registry.remove + bag.disable", async () => {
    const registry = makeMockRegistry([makeProviderConfig("brave")]);
    const bag = makeMockBag(["brave"]);
    const tm = makeMockToolManager();
    const ok = await removeProvider("brave", registry, bag, tm, {
      callerId: "admin",
      reason: "test",
    });
    expect(ok).toBe(true);
    expect(registry.remove).toHaveBeenCalledWith("brave");
    expect(bag.disableCalls[0]).toMatchObject({
      name: "brave",
      opts: { callerId: "admin", reason: "test" },
    });
  });

  it("removeProvider 不存在 → 返 false（不调 bag.disable）", async () => {
    const registry = makeMockRegistry([]);
    const bag = makeMockBag([]);
    const tm = makeMockToolManager();
    const ok = await removeProvider("nonexistent", registry, bag, tm);
    expect(ok).toBe(false);
    expect(bag.disableCalls).toHaveLength(0);
  });

  it("removeProvider 不传 opts → 默认 callerId='admin' + reason='provider_removed'", async () => {
    const registry = makeMockRegistry([makeProviderConfig("brave")]);
    const bag = makeMockBag(["brave"]);
    const tm = makeMockToolManager();
    await removeProvider("brave", registry, bag, tm);
    expect(bag.disableCalls[0].opts).toEqual({
      callerId: "admin",
      reason: "provider_removed",
    });
  });
});

describe("installSighupHotReload — 信号驱动", () => {
  beforeEach(() => {
    // 清除所有 SIGHUP listeners 防跨用例污染
    process.removeAllListeners("SIGHUP");
  });
  afterEach(() => {
    process.removeAllListeners("SIGHUP");
  });

  it("configPath=null → 不安装 SIGHUP listener", () => {
    const registry = makeMockRegistry([]);
    const bag = makeMockBag([]);
    const tm = makeMockToolManager();
    const before = process.listenerCount("SIGHUP");
    installSighupHotReload(registry, bag, tm, null);
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  it("configPath 非 null → 安装 SIGHUP listener", () => {
    const registry = makeMockRegistry([]);
    const bag = makeMockBag([]);
    const tm = makeMockToolManager();
    const before = process.listenerCount("SIGHUP");
    installSighupHotReload(registry, bag, tm, "/tmp/test-providers.json");
    expect(process.listenerCount("SIGHUP")).toBe(before + 1);
  });

  it("SIGHUP 触发：读 LASSO_PROVIDERS_FILE → applyHotReload", () => {
    return new Promise<void>((resolve, reject) => {
      // 写一个临时 providers.json
      const tmpFile = `/tmp/lasso-hot-reload-test-${Date.now()}.json`;
      const fs = require("node:fs");
      fs.writeFileSync(
        tmpFile,
        JSON.stringify({
          providers: [
            makeProviderConfig("brave2"),
          ],
        }),
      );

      const registry = makeMockRegistry([makeProviderConfig("brave")]);
      const bag = makeMockBag(["brave"]);
      const tm = makeMockToolManager();
      installSighupHotReload(registry, bag, tm, tmpFile);

      // 触发 SIGHUP（process.emit 是同步派发到所有 listener）
      process.emit("SIGHUP", "SIGHUP");

      // 异步 listener 完成后检查
      setTimeout(() => {
        try {
          expect(registry.add).toHaveBeenCalledWith(
            expect.objectContaining({ name: "brave2" }),
          );
          expect(bag.register).toHaveBeenCalledWith("brave2");
          fs.unlinkSync(tmpFile);
          resolve();
        } catch (e) {
          fs.unlinkSync(tmpFile);
          reject(e);
        }
      }, 50);
    });
  });

  it("SIGHUP 触发但文件不存在 → log error 不崩", () => {
    return new Promise<void>((resolve, reject) => {
      const registry = makeMockRegistry([]);
      const bag = makeMockBag([]);
      const tm = makeMockToolManager();
      installSighupHotReload(
        registry,
        bag,
        tm,
        "/tmp/lasso-definitely-does-not-exist.json",
      );

      // 不应抛错（错误隔离）
      try {
        process.emit("SIGHUP", "SIGHUP");
      } catch (e) {
        reject(e);
        return;
      }
      setTimeout(() => {
        // registry.add 没被调（文件不存在）
        expect(registry.add).not.toHaveBeenCalled();
        resolve();
      }, 50);
    });
  });
});
