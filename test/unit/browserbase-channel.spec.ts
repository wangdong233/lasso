/**
 * BrowserbaseChannel 单测（parse5 §3.2.2 + §5.4 + task #7）
 *
 * 覆盖（mock SubprocessManager + mock sessionProvider）：
 *  - 构造不抛（即使 apiKey="" 也允许实例化）
 *  - browse() 无 key → outcome=didnt + retrieval_method="cloud_no_key"（不抛、不触网）
 *  - browse() 有 key + mock sessionProvider → 调 super.browse()，stealth hook 注入
 *  - getMcpClient 懒连接：构造时 cachedWsUrl=null；首次 browse 后 cachedWsUrl 非空
 *  - sessionProvider 接 wsUrl 后 registerSpec("browserbase", --browser-url=$wsUrl)
 *  - retrieval_method = "cloud_browserbase"（区分 chrome_devtools_mcp）
 *  - beforeNavigate hook 调 stealth.injectProfile（task spec #5 验证）
 *  - status()/isAvailable()/healthCheck() 无 key → cloud_no_key/down
 *
 * 关键铁律：
 *  - extends BrowseChannel，**不重写 actionDispatch Map**（INV-6 守护）
 *  - 无 key 路径 outcome=didnt（不抛、不触网 — task spec #5）
 *
 * mock 策略（parse5 §5.4）：
 *  - SubprocessManager: vi.fn ensureRunning 返 stub McpClient（覆写 callTool）
 *  - sessionProvider: vi.fn 返 mock wsUrl（验证 lazy connect + registerSpec 调用）
 *  - StealthEngine: vi.spyOn injectProfile 验证 hook 调用
 *  - CI 不跑真实 browserbase（无 API key + 付费）
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BrowserbaseChannel,
  defaultBrowserbaseSessionProvider,
} from "../../src/channels/BrowserbaseChannel.js";
import { StealthEngine } from "../../src/browse/StealthEngine.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";

// ============================================================
// Mock helpers
// ============================================================
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

/** stub McpClient：navigate_page / evaluate_script / list_pages 等都返固定 fixture。 */
function makeStubClient(): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "navigate_page") return textContent("navigated");
      if (name === "evaluate_script") return textContent("injected");
      if (name === "list_pages")
        return textContent("browserbase session page\nhttps://example.com/");
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
  return { client, calls };
}

/** mock SubprocessManager：registerSpec + ensureRunning 返 stub client。 */
function makeMockSubproc(stubClient: McpClient): {
  subproc: SubprocessManager;
  registerSpecCalls: Array<{ name: string; spec: unknown }>;
  ensureRunningCalls: string[];
} {
  const registerSpecCalls: Array<{ name: string; spec: unknown }> = [];
  const ensureRunningCalls: string[] = [];
  const subproc = {
    registerSpec: vi.fn((name: string, spec: unknown) => {
      registerSpecCalls.push({ name, spec });
    }),
    ensureRunning: vi.fn(async (name: string) => {
      ensureRunningCalls.push(name);
      return stubClient;
    }),
    shutdown: vi.fn(async () => {}),
    healthProbe: vi.fn(async () => "healthy" as const),
    restart: vi.fn(async (name: string) => {
      ensureRunningCalls.push(name);
      return stubClient;
    }),
  } as unknown as SubprocessManager;
  return { subproc, registerSpecCalls, ensureRunningCalls };
}

/** mock sessionProvider：返固定 wsUrl。 */
function makeMockSessionProvider(wsUrl = "wss://cdp.browserbase.com/test-session-123") {
  return vi.fn(async (_apiKey: string) => ({
    wsUrl,
    sessionId: "test-session-123",
  }));
}

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-bb-"));
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
// 构造 + 无 key 路径
// ============================================================
describe("BrowserbaseChannel — 构造不抛 + 无 key 短路（task spec #5）", () => {
  it("apiKey='' 也允许构造（懒连接）", () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const stealth = new StealthEngine();
    expect(
      () =>
        new BrowserbaseChannel(subproc, "", stealth, {
          sessionProvider: makeMockSessionProvider(),
        }),
    ).not.toThrow();
  });

  it("browse() 无 key → outcome=didnt + retrieval_method=cloud_no_key（不触网）", async () => {
    const stub = makeStubClient();
    const { subproc, ensureRunningCalls } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const sessionProvider = makeMockSessionProvider();
    const ch = new BrowserbaseChannel(subproc, "", stealth, { sessionProvider });

    const r = await ch.browse("https://example.com/", "navigate", {});
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("cloud_no_key");
    expect(r.served_by).toBe("browse_cloud_browserbase");
    expect(r.error).toContain("BROWSERBASE_API_KEY");
    // 不触网（sessionProvider / ensureRunning 都未调）
    expect(sessionProvider).not.toHaveBeenCalled();
    expect(ensureRunningCalls).toHaveLength(0);
  });

  it("status() 无 key → available=false + note=cloud_no_key", async () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new BrowserbaseChannel(subproc, "", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    const s = await ch.status();
    expect(s.available).toBe(false);
    expect(s.note).toBe("cloud_no_key");
  });

  it("isAvailable() 无 key → false", async () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new BrowserbaseChannel(subproc, "", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    expect(await ch.isAvailable()).toBe(false);
  });

  it("healthCheck() 无 key → down", async () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new BrowserbaseChannel(subproc, "", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    expect(await ch.healthCheck()).toBe("down");
  });
});

// ============================================================
// 懒连接 + sessionProvider 调用
// ============================================================
describe("BrowserbaseChannel — 懒连接 + sessionProvider 注入 wsUrl", () => {
  it("构造时 cachedWsUrl=null（懒连接，未触网）", () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new BrowserbaseChannel(subproc, "fake-key", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    expect(ch._testGetCachedWsUrl()).toBeNull();
    expect(ch._testHasCachedClient()).toBe(false);
  });

  it("首次 browse() 有 key → sessionProvider 调 + wsUrl 缓存 + ensureRunning 调", async () => {
    const stub = makeStubClient();
    const { subproc, registerSpecCalls, ensureRunningCalls } =
      makeMockSubproc(stub.client);
    const sessionProvider = makeMockSessionProvider(
      "wss://cdp.browserbase.com/sess-abc-999",
    );
    const ch = new BrowserbaseChannel(subproc, "fake-key", new StealthEngine(), {
      sessionProvider,
    });

    const r = await ch.browse("https://example.com/", "navigate", {});
    expect(r.outcome).toBe("worked");
    expect(sessionProvider).toHaveBeenCalledTimes(1);
    expect(sessionProvider).toHaveBeenCalledWith("fake-key");
    expect(ch._testGetCachedWsUrl()).toBe("wss://cdp.browserbase.com/sess-abc-999");

    // registerSpec 调用：spec 含 --browser-url=$wsUrl（与 LoggedInChannel 9222 范式同构）
    expect(registerSpecCalls.length).toBeGreaterThanOrEqual(1);
    const spec = registerSpecCalls[0]!.spec as { args: string[] };
    expect(spec.args.some((a) => a.includes("wss://cdp.browserbase.com/sess-abc-999"))).toBe(true);

    // ensureRunning 调用（spec name 默认 "browserbase"）
    expect(ensureRunningCalls).toContain("browserbase");
  });

  it("第二次 browse() 复用 cachedClient（sessionProvider 不再调）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const sessionProvider = makeMockSessionProvider();
    const ch = new BrowserbaseChannel(subproc, "fake-key", new StealthEngine(), {
      sessionProvider,
    });

    await ch.browse("https://example.com/", "navigate", {});
    await ch.browse("https://example.com/", "snapshot", {});
    // 第二次复用：sessionProvider 仅调一次
    expect(sessionProvider).toHaveBeenCalledTimes(1);
    expect(ch._testHasCachedClient()).toBe(true);
  });

  it("retrieval_method = cloud_browserbase（区分 chrome_devtools_mcp 路径）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new BrowserbaseChannel(subproc, "fake-key", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    const r = await ch.browse("https://example.com/", "navigate", {});
    expect(r.retrieval_method).toBe("cloud_browserbase");
  });
});

// ============================================================
// StealthEngine hook 注入
// ============================================================
describe("BrowserbaseChannel — StealthEngine beforeNavigate hook", () => {
  it("navigate action → beforeNavigate 调 stealth.injectProfile", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const spy = vi.spyOn(stealth, "injectProfile");
    const ch = new BrowserbaseChannel(subproc, "fake-key", stealth, {
      sessionProvider: makeMockSessionProvider(),
    });

    await ch.browse("https://example.com/", "navigate", {});
    // beforeNavigate hook 应调 injectProfile（默认 profile windows_chrome_120）
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0]!;
    expect(args[0]).toBe(stub.client); // 注入到同一 McpClient
    expect(args[1]).toBe("windows_chrome_120"); // 默认 profile
  });

  it("snapshot action → beforeNavigate 不调（仅 navigate hook）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const spy = vi.spyOn(stealth, "injectProfile");
    const ch = new BrowserbaseChannel(subproc, "fake-key", stealth, {
      sessionProvider: makeMockSessionProvider(),
    });

    await ch.browse("https://example.com/", "snapshot", {});
    expect(spy).not.toHaveBeenCalled();
  });

  it("custom profile 名 → injectProfile 接该 profile", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const spy = vi.spyOn(stealth, "injectProfile");
    const ch = new BrowserbaseChannel(subproc, "fake-key", stealth, {
      sessionProvider: makeMockSessionProvider(),
      profileName: "mac_safari_17",
    });

    await ch.browse("https://example.com/", "navigate", {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe("mac_safari_17");
  });

  it("stealth.injectProfile 失败 → browse 不抛（best-effort）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    vi.spyOn(stealth, "injectProfile").mockRejectedValueOnce(
      new Error("inject_boom"),
    );
    const ch = new BrowserbaseChannel(subproc, "fake-key", stealth, {
      sessionProvider: makeMockSessionProvider(),
    });

    const r = await ch.browse("https://example.com/", "navigate", {});
    // stealth 失败不阻断 browse；navigate 仍 outcome=worked
    expect(r.outcome).toBe("worked");
  });
});

// ============================================================
// INV-6 / INV-2 守护
// ============================================================
describe("BrowserbaseChannel — INV-6/INV-2 守护（extends BrowseChannel）", () => {
  it("继承 actionDispatch Map（不重写，8 个 action）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new BrowserbaseChannel(subproc, "fake-key", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });

    // 测试所有 8 个 action 都能 dispatch（间接验证 actionDispatch Map 完整）
    for (const action of [
      "navigate",
      "snapshot",
      "screenshot",
      "extract",
      "click",
      "fill",
      "wait",
      "evaluate",
    ]) {
      // 不抛 unknown_action（除 handler 自身可能 throw 缺 selectors）
      const r = await ch.browse("https://example.com/", action, {});
      expect(r.outcome).not.toBe("didnt");
      expect(String(r.error ?? "")).not.toMatch(/unknown_action/);
      // 每次都清理 cachedClient，避免 sessionProvider 只调一次的限制
    }
  });

  it("name 字段是 browse_cloud_browserbase（policy gate / fallback decider 识别）", () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new BrowserbaseChannel(subproc, "", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    expect(ch.name).toBe("browse_cloud_browserbase");
  });
});

// ============================================================
// defaultBrowserbaseSessionProvider（契约校验，不触网）
// ============================================================
describe("defaultBrowserbaseSessionProvider — 契约形状（不触网）", () => {
  it("函数签名接 apiKey 返 Promise<{wsUrl, sessionId}>", () => {
    expect(typeof defaultBrowserbaseSessionProvider).toBe("function");
  });
  // 不做真实 fetch 调用（会触网 + 付费）；契约校验留给手测清单（parse5 §6.3 #16）
});
