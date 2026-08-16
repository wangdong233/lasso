/**
 * SteelChannel 单测（parse14 §5.1 —— v1.6 Phase A）
 *
 * 覆盖（mock SubprocessManager + mock sessionProvider + mock stealth）：
 *  - 构造不抛（即使 steelEndpoint="" 也允许实例化）
 *  - browse() 无 endpoint → outcome=didnt + retrieval_method="steel_no_endpoint"（不抛、不触网）
 *  - getMcpClient 懒连接：构造时 cachedSessionId=null；首次 browse 后非空
 *  - sessionProvider 接 endpoint 后 registerSpec("steel", --browser-url=http://host:9223)
 *  - CDP endpoint 推导：STEEL_ENDPOINT=http://localhost:3000 → cdpEndpoint=http://localhost:9223
 *  - retrieval_method = "cloud_steel"（区分 cloud_browserbase / chrome_devtools_mcp）
 *  - beforeNavigate hook 调 stealth.injectProfile（task spec #5 验证）
 *  - **单例 session mutex**：并发 2 个 browse() → sessionProvider 只调 1 次（不互相 reset）
 *  - releaseSession() POST /v1/sessions/release → cachedClient/sessionId 清空
 *  - status()/isAvailable()/healthCheck() 无 endpoint → steel_no_endpoint/down
 *
 * 关键铁律：
 *  - extends BrowseChannel，**不重写 actionDispatch Map**（INV-6 守护）
 *  - 无 endpoint 路径 outcome=didnt（不抛、不触网 — task spec #5）
 *  - 单例 session mutex（Steel 只允许 1 activeSession；parse14 §3.1 R-V16-1）
 *
 * mock 策略（parse14 §5.1 + 03 §2.1 项 8 doubles 政策）：
 *  - SubprocessManager: vi.fn ensureRunning 返 stub McpClient（覆写 callTool）
 *  - sessionProvider: vi.fn 返 mock { sessionId, status }（验证 lazy connect + registerSpec 调用）
 *  - StealthEngine: vi.spyOn injectProfile 验证 hook 调用
 *  - **不触真网**（不 fetch 真 Steel endpoint）—— SMALL 约束（03 §2 测试大小）
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SteelChannel,
  defaultSteelSessionProvider,
  deriveCdpEndpoint,
} from "../../src/channels/SteelChannel.js";
import { StealthEngine } from "../../src/browse/StealthEngine.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import { mockEvalResponse, mockScreenshotResponse } from "../helpers/upstream-mock.js";

// ============================================================
// Mock helpers（仿 browserbase-channel.spec.ts 范式）
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
      // W1-DEF-1b 真实契约：evaluate_script 返 ```json 围栏、take_screenshot 返 image block
      if (name === "evaluate_script") return mockEvalResponse("injected");
      if (name === "take_screenshot") return mockScreenshotResponse();
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

/**
 * mock sessionProvider：返固定 { sessionId, status }。
 * 注意：Steel sessionProvider 接 endpoint 字符串（非 apiKey），与 Browserbase 不同。
 */
function makeMockSessionProvider(
  sessionId = "steel-test-session-uuid",
  status = "live",
) {
  return vi.fn(async (_endpoint: string) => ({ sessionId, status }));
}

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-steel-"));
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
// 构造 + 无 endpoint 路径
// ============================================================
describe("SteelChannel — 构造不抛 + 无 endpoint 短路（task spec #5）", () => {
  it("steelEndpoint='' 也允许构造（懒连接）", () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const stealth = new StealthEngine();
    expect(
      () =>
        new SteelChannel(subproc, "", stealth, {
          sessionProvider: makeMockSessionProvider(),
        }),
    ).not.toThrow();
  });

  it("browse() 无 endpoint → outcome=didnt + retrieval_method=steel_no_endpoint（不触网）", async () => {
    const stub = makeStubClient();
    const { subproc, ensureRunningCalls } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const sessionProvider = makeMockSessionProvider();
    const ch = new SteelChannel(subproc, "", stealth, { sessionProvider });

    const r = await ch.browse("https://example.com/", "navigate", {});
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("steel_no_endpoint");
    expect(r.served_by).toBe("browse_cloud_steel");
    expect(r.error).toContain("STEEL_ENDPOINT");
    // 不触网（sessionProvider / ensureRunning 都未调）
    expect(sessionProvider).not.toHaveBeenCalled();
    expect(ensureRunningCalls).toHaveLength(0);
  });

  it("status() 无 endpoint → available=false + note=steel_no_endpoint", async () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new SteelChannel(subproc, "", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    const s = await ch.status();
    expect(s.available).toBe(false);
    expect(s.note).toBe("steel_no_endpoint");
  });

  it("isAvailable() 无 endpoint → false", async () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new SteelChannel(subproc, "", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    expect(await ch.isAvailable()).toBe(false);
  });

  it("healthCheck() 无 endpoint → down", async () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new SteelChannel(subproc, "", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    expect(await ch.healthCheck()).toBe("down");
  });
});

// ============================================================
// CDP endpoint 推导（parse14 §3.1 + §4.2 R-V16-2）
// ============================================================
describe("SteelChannel — CDP endpoint 推导（9223 nginx proxy 非 3000 API）", () => {
  it("deriveCdpEndpoint: http://localhost:3000 → http://localhost:9223", () => {
    delete process.env.STEEL_CDP_ENDPOINT;
    expect(deriveCdpEndpoint("http://localhost:3000")).toBe(
      "http://localhost:9223",
    );
  });

  it("deriveCdpEndpoint: http://my-host:3000 → http://my-host:9223", () => {
    delete process.env.STEEL_CDP_ENDPOINT;
    expect(deriveCdpEndpoint("http://my-host:3000")).toBe(
      "http://my-host:9223",
    );
  });

  it("deriveCdpEndpoint: STEEL_CDP_ENDPOINT env 覆盖优先", () => {
    process.env.STEEL_CDP_ENDPOINT = "http://override-host:9223";
    expect(deriveCdpEndpoint("http://localhost:3000")).toBe(
      "http://override-host:9223",
    );
    delete process.env.STEEL_CDP_ENDPOINT;
  });

  it("构造后 _testGetCdpEndpoint 返推导的 9223 endpoint", () => {
    delete process.env.STEEL_CDP_ENDPOINT;
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );
    expect(ch._testGetCdpEndpoint()).toBe("http://localhost:9223");
  });
});

// ============================================================
// 懒连接 + sessionProvider 调用
// ============================================================
describe("SteelChannel — 懒连接 + sessionProvider 注入 session", () => {
  it("构造时 cachedSessionId=null（懒连接，未触网）", () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );
    expect(ch._testGetCachedSessionId()).toBeNull();
    expect(ch._testHasCachedClient()).toBe(false);
  });

  it("首次 browse() 有 endpoint → sessionProvider 调 + sessionId 缓存 + ensureRunning 调", async () => {
    const stub = makeStubClient();
    const { subproc, registerSpecCalls, ensureRunningCalls } =
      makeMockSubproc(stub.client);
    const sessionProvider = makeMockSessionProvider(
      "steel-sess-abc-999",
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
    expect(sessionProvider).toHaveBeenCalledTimes(1);
    expect(sessionProvider).toHaveBeenCalledWith("http://localhost:3000", undefined); // v1.11 T10：第 2 参 proxyUrl（未配 = undefined）
    expect(ch._testGetCachedSessionId()).toBe("steel-sess-abc-999");

    // registerSpec 调用：spec 含 --browser-url=http://localhost:9223（CDP nginx proxy，非 API 3000）
    expect(registerSpecCalls.length).toBeGreaterThanOrEqual(1);
    const spec = registerSpecCalls[0]!.spec as { args: string[] };
    expect(
      spec.args.some((a) => a.includes("http://localhost:9223")),
    ).toBe(true);
    // 确保 spec 不含 3000 端口（CDP 连接点不是 API 端口）
    expect(spec.args.some((a) => a.includes(":3000"))).toBe(false);

    // ensureRunning 调用（spec name 默认 "steel"）
    expect(ensureRunningCalls).toContain("steel");
  });

  it("第二次 browse() 复用 cachedClient（sessionProvider 不再调）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const sessionProvider = makeMockSessionProvider();
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider },
    );

    await ch.browse("https://example.com/", "navigate", {});
    await ch.browse("https://example.com/", "snapshot", {});
    // 第二次复用：sessionProvider 仅调一次（cachedClient 在）
    expect(sessionProvider).toHaveBeenCalledTimes(1);
    expect(ch._testHasCachedClient()).toBe(true);
  });

  it("retrieval_method = cloud_steel（区分 cloud_browserbase 路径）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );
    const r = await ch.browse("https://example.com/", "navigate", {});
    expect(r.retrieval_method).toBe("cloud_steel");
  });
});

// ============================================================
// 单例 session mutex（parse14 §3.1 R-V16-1 + §5.1 核心用例）
// ============================================================
describe("SteelChannel — 单例 session mutex（并发安全）", () => {
  it("并发 2 个 browse() → sessionProvider 只调 1 次（不互相 reset）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const sessionProvider = makeMockSessionProvider("concurrent-sess-001");
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider },
    );

    // 并发发起 2 个 browse（不 await 第一个再发第二个）
    const [r1, r2] = await Promise.all([
      ch.browse("https://example.com/", "navigate", {}),
      ch.browse("https://example.com/", "snapshot", {}),
    ]);

    // 两个都成功
    expect(r1.outcome).not.toBe("didnt");
    expect(r2.outcome).not.toBe("didnt");

    // 核心断言：sessionProvider 只调 1 次（mutex 保护单例 session 不互相 reset）
    expect(sessionProvider).toHaveBeenCalledTimes(1);
    expect(ch._testGetCachedSessionId()).toBe("concurrent-sess-001");
  });

  it("并发 3 个 browse() → sessionProvider 仍只调 1 次", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const sessionProvider = makeMockSessionProvider("triple-sess");
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider },
    );

    await Promise.all([
      ch.browse("https://a.example.com/", "navigate", {}),
      ch.browse("https://b.example.com/", "navigate", {}),
      ch.browse("https://c.example.com/", "navigate", {}),
    ]);

    expect(sessionProvider).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// StealthEngine hook 注入
// ============================================================
describe("SteelChannel — StealthEngine beforeNavigate hook", () => {
  it("navigate action → beforeNavigate 调 stealth.injectProfile", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const spy = vi.spyOn(stealth, "injectProfile");
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      stealth,
      { sessionProvider: makeMockSessionProvider() },
    );

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
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      stealth,
      { sessionProvider: makeMockSessionProvider() },
    );

    await ch.browse("https://example.com/", "snapshot", {});
    expect(spy).not.toHaveBeenCalled();
  });

  it("custom profile 名 → injectProfile 接该 profile", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const spy = vi.spyOn(stealth, "injectProfile");
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      stealth,
      {
        sessionProvider: makeMockSessionProvider(),
        profileName: "mac_safari_17",
      },
    );

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
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      stealth,
      { sessionProvider: makeMockSessionProvider() },
    );

    const r = await ch.browse("https://example.com/", "navigate", {});
    // stealth 失败不阻断 browse；navigate 仍 outcome=worked
    expect(r.outcome).toBe("worked");
  });
});

// ============================================================
// INV-6 / INV-2 守护（extends BrowseChannel）
// ============================================================
describe("SteelChannel — INV-6/INV-2/INV-74 守护（extends BrowseChannel）", () => {
  it("继承 actionDispatch Map（不重写，8 个 action）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );

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
    }
  });

  it("name 字段是 browse_cloud_steel（policy gate / fallback decider 识别）", () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new SteelChannel(subproc, "", new StealthEngine(), {
      sessionProvider: makeMockSessionProvider(),
    });
    expect(ch.name).toBe("browse_cloud_steel");
  });
});

// ============================================================
// releaseSession（parse14 §3.1 释放语义）
// ============================================================
describe("SteelChannel — releaseSession（POST /v1/sessions/release）", () => {
  it("releaseSession：有 cached session → 清空 cachedClient + cachedSessionId", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );

    // 先 browse 建立 session
    await ch.browse("https://example.com/", "navigate", {});
    expect(ch._testHasCachedClient()).toBe(true);
    expect(ch._testGetCachedSessionId()).not.toBeNull();

    // mock fetch for release（global.fetch 已被 vitest mock 拦截？用 vi.spyOn）
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"success":true}', { status: 200 }),
    );

    await ch.releaseSession();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(callUrl).toContain("/v1/sessions/release");
    expect(fetchSpy.mock.calls[0]![1]?.method).toBe("POST");

    // 清空
    expect(ch._testHasCachedClient()).toBe(false);
    expect(ch._testGetCachedSessionId()).toBeNull();

    fetchSpy.mockRestore();
  });

  it("releaseSession：无 cached session → no-op（不调 fetch）", async () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await ch.releaseSession();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("releaseSession：fetch 失败 → 仅 warn 不抛（best-effort）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new SteelChannel(
      subproc,
      "http://localhost:3000",
      new StealthEngine(),
      { sessionProvider: makeMockSessionProvider() },
    );

    await ch.browse("https://example.com/", "navigate", {});
    expect(ch._testHasCachedClient()).toBe(true);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network_down"));

    // 不抛（best-effort release）
    await expect(ch.releaseSession()).resolves.not.toThrow();

    // 仍清空 cached state（release 语义：即使网络失败也标记为已释放）
    expect(ch._testGetCachedSessionId()).toBeNull();

    fetchSpy.mockRestore();
  });
});

// ============================================================
// defaultSteelSessionProvider（契约校验，不触网）
// ============================================================
describe("defaultSteelSessionProvider — 契约形状（不触网）", () => {
  it("函数签名接 endpoint 返 Promise<{sessionId, status}>", () => {
    expect(typeof defaultSteelSessionProvider).toBe("function");
  });
  // 不做真实 fetch 调用（会触网 + 需 Steel Docker）；契约校验留给手测清单（parse14 §5.3 smoke）
});
