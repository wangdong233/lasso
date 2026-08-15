/**
 * stealth-headless-integration 集成测（parse13 §3.4 P0 核心修复 + §6 验收 + §8.4 值级 trace）
 *
 * 端到端接通验证（03 §1.4 + §2.2）：
 *  - HeadlessChannel.browse(url, "navigate") → wrapNavigate → beforeNavigate
 *    → StealthEngine.injectProfile(client, profile) → evaluate_script × 2（UA override +
 *    STEALTH_INJECTION_SCRIPT 16 路）→ navigate_page
 *  - HeadlessChannel.browse(url, "snapshot") → beforeNavigate 不调（仅 navigate hook）
 *
 * producer 契约同步（03 §2.2 项 4）：
 *  - StealthEngine 注入的 STEALTH_INJECTION_SCRIPT === stealth-profiles.ts 导出的顶级 const
 *  - spec args 含 --disable-blink-features=AutomationControlled（parse13 §3.3 flag 契约）
 *
 * 16 路 evasion 覆盖（parse13 §3.1 + §6.1 白盒验收）：
 *  - 注入的 script 含 12 路 vendored evasion 的 marker + CORE 3 路 marker + UA override
 *
 * 关键铁律：
 *  - mock McpClient（CI 不 spawn 真实 chrome-devtools-mcp；真机验证留 parse13-acceptance.md）
 *  - mock SubprocessManager（registerSpec + ensureRunning 返 stub client）
 *  - StealthEngine 用真实实例（非 mock）—— 验真实 injectProfile 的 evaluate 调用序列
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import { StealthEngine, toFnExpression } from "../../src/browse/StealthEngine.js";
import {
  STEALTH_INJECTION_SCRIPT,
  STEALTH_PROFILES,
  type StealthProfileName,
} from "../../src/browse/stealth-profiles.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import { mockEvalResponse, mockScreenshotResponse } from "../helpers/upstream-mock.js";

// ============================================================
// Mock helpers
// ============================================================
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * stub McpClient：记录所有 callTool 调用（含 name + args）。
 * navigate_page / evaluate_script / list_pages 返固定 fixture。
 */
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
        return textContent("headless isolated page\nhttps://example.com/");
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () => [
      { name: "navigate_page", inputSchema: {} },
      { name: "evaluate_script", inputSchema: {} },
    ]),
    close: vi.fn(async () => {}),
    pid: 88888,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client, calls };
}

/** mock SubprocessManager：registerSpec 记录 spec（验 flag）+ ensureRunning 返 stub client。 */
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
    touch: vi.fn(), // v1.9 touchKeepalive 保活接线
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

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-stealth-headless-"));
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
// P0 核心修复：HeadlessChannel.browse(navigate) → beforeNavigate → stealth.injectProfile
// ============================================================
describe("HeadlessChannel — P0 stealth 接入（parse13 §3.4 值级 trace）", () => {
  it("navigate action → beforeNavigate 调 stealth.injectProfile（修复 v1.4 零 stealth）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const spy = vi.spyOn(stealth, "injectProfile");
    const ch = new HeadlessChannel(subproc, stealth, "windows_chrome_120");

    await ch.browse("https://example.com/", "navigate", {});

    // beforeNavigate hook 应调 injectProfile 一次（默认 profile windows_chrome_120）
    expect(spy).toHaveBeenCalledTimes(1);
    const [clientArg, profileArg] = spy.mock.calls[0]!;
    expect(clientArg).toBe(stub.client); // 注入到同一 McpClient
    expect(profileArg).toBe("windows_chrome_120");
  });

  it("injectProfile 的 evaluate 发生在 navigate_page 之后（W1-DEF-1c 值级 trace 顺序）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new HeadlessChannel(subproc, new StealthEngine(), "windows_chrome_120");

    await ch.browse("https://example.com/", "navigate", {});

    // W1-DEF-1c（v1.8）：注入时机 = navigate 之后——页面 JS 上下文随导航重置，
    // 导航前注入在新文档全部丢失（wave2 smoke 实证 navigator.webdriver 仍 true）。
    // callTool 调用序列：navigate_page → evaluate_script(UA) → evaluate_script(16路)
    const evalCalls = stub.calls.filter((c) => c.name === "evaluate_script");
    const navCalls = stub.calls.filter((c) => c.name === "navigate_page");
    // 至少 2 次 evaluate（UA override + 16 路 SCRIPT）+ 1 次 navigate
    expect(evalCalls.length).toBeGreaterThanOrEqual(2);
    expect(navCalls.length).toBe(1);

    // 值级 trace：evaluate 全部在 navigate 之后（索引序）
    const firstEvalIdx = stub.calls.indexOf(evalCalls[0]!);
    const navIdx = stub.calls.indexOf(navCalls[0]!);
    expect(firstEvalIdx).toBeGreaterThan(navIdx);
    // 第二次 evaluate（16 路 SCRIPT）也在 navigate 之后
    const secondEvalIdx = stub.calls.indexOf(evalCalls[1]!);
    expect(secondEvalIdx).toBeGreaterThan(navIdx);
  });

  it("snapshot action → beforeNavigate 不调（仅 navigate 入口包 wrapNavigate）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const spy = vi.spyOn(stealth, "injectProfile");
    const ch = new HeadlessChannel(subproc, stealth, "windows_chrome_120");

    await ch.browse("https://example.com/", "snapshot", {});

    expect(spy).not.toHaveBeenCalled();
  });

  it("stealth.injectProfile 失败 → browse 不抛（best-effort；parse13 §8.3）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    vi.spyOn(stealth, "injectProfile").mockRejectedValueOnce(
      new Error("inject_boom"),
    );
    const ch = new HeadlessChannel(subproc, stealth, "windows_chrome_120");

    const r = await ch.browse("https://example.com/", "navigate", {});
    // stealth 失败不阻断 browse；navigate 仍 outcome=worked（best-effort 语义）
    expect(r.outcome).toBe("worked");
  });

  it("custom profile 名 → injectProfile 接该 profile（mac_safari_17）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const stealth = new StealthEngine();
    const spy = vi.spyOn(stealth, "injectProfile");
    const ch = new HeadlessChannel(subproc, stealth, "mac_safari_17");

    await ch.browse("https://example.com/", "navigate", {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe("mac_safari_17");
  });

  it("未传 stealth → 内部建 default StealthEngine（向后兼容）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    // 只传 subproc —— 验向后兼容（构造不抛）
    const ch = new HeadlessChannel(subproc);

    const r = await ch.browse("https://example.com/", "navigate", {});
    // default StealthEngine 注入路径仍触发 evaluate_script（UA + 16 路）
    const evalCalls = stub.calls.filter((c) => c.name === "evaluate_script");
    expect(evalCalls.length).toBeGreaterThanOrEqual(2);
    expect(r.outcome).toBe("worked");
  });
});

// ============================================================
// producer 契约同步（03 §2.2 项 4）：注入的 script === 顶级 const
// ============================================================
describe("HeadlessChannel — producer 契约同步（STEALTH_INJECTION_SCRIPT 一致性）", () => {
  it("injectProfile 第二次 evaluate 的 script === STEALTH_INJECTION_SCRIPT 包成的函数表达式（W1-DEF-1）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new HeadlessChannel(subproc, new StealthEngine(), "windows_chrome_120");

    await ch.browse("https://example.com/", "navigate", {});

    const evalCalls = stub.calls.filter((c) => c.name === "evaluate_script");
    // 第二次 evaluate 是 16 路 SCRIPT 包成的函数表达式（0.3.0 契约，第一次是 UA override）
    const scriptCall = evalCalls.find(
      (c) => c.args.function === toFnExpression(STEALTH_INJECTION_SCRIPT),
    );
    expect(scriptCall).toBeTruthy(); // producer 契约：SCRIPT 一字不差传到 evaluate
    // 真实契约验证：上游 eval 该参数必得函数
    expect(
      typeof eval(`(${scriptCall!.args.function})`),
    ).toBe("function");
  });

  it("UA override script 含 profile 的 userAgent 值（profile-specific 注入）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const profileName: StealthProfileName = "windows_chrome_120";
    const ch = new HeadlessChannel(subproc, new StealthEngine(), profileName);

    await ch.browse("https://example.com/", "navigate", {});

    const evalCalls = stub.calls.filter((c) => c.name === "evaluate_script");
    // W1-DEF-1b（v1.8）：verifyNavigatedPage 的 responseStatus 检测也是 evaluate_script
    // 且先于注入——按内容查找 UA override 调用（顺序无关断言）
    const ua = STEALTH_PROFILES[profileName].userAgent;
    const uaCall = evalCalls.find((c) => (c.args?.function ?? "").includes(ua));
    expect(uaCall).toBeDefined();
  });
});

// ============================================================
// 16 路 evasion 覆盖（parse13 §3.1 + §6.1 白盒验收）
// ============================================================
describe("HeadlessChannel — 16 路 evasion 覆盖（注入 script 含每路 marker）", () => {
  // 每路的 marker（grep 式断言；marker 选各路最具特征、不易误命中的字面量）
  // CORE 3 路 + vendored 12 路 + UA override = 16 路（UA override 走第 2 次 evaluate）
  const expectedMarkers: Array<[string, RegExp]> = [
    ["路1 navigator.webdriver", /navigator["\s,]*"webdriver"|defineProperty\(navigator,\s*"webdriver"/],
    ["路2 navigator.languages", /"en-US",\s*"en"/],
    ["路3 navigator.permissions", /permissions\.query|Notification\.permission/],
    ["路4 chrome.runtime", /chrome\.runtime|chrome\[["']runtime["']\]|sendMessage/],
    ["路5 chrome.app", /chrome\.app|isInstalled|InstallState/],
    ["路6 chrome.csi", /chrome\.csi|onloadT|startE/],
    ["路7 chrome.loadTimes", /chrome\.loadTimes|loadTimes|requestTime/],
    ["路8 navigator.plugins", /navigator\.plugins|PluginArray|Chrome PDF/],
    ["路9 navigator.vendor", /navigator\.vendor|Google Inc/],
    ["路10 hardwareConcurrency", /hardwareConcurrency/],
    ["路11 media.codecs", /canPlayType|avc1|probably/],
    ["路12 webgl.vendor", /UNMASKED_VENDOR_WEBGL|37445|getParameter|Intel/],
    ["路13 iframe.contentWindow", /contentWindow|createElement/],
    ["路14 outerdimensions", /outerWidth|outerHeight|outerdimensions/],
    ["路15 userAgentData", /userAgentData|brands/],
  ];

  it("注入的 STEALTH_INJECTION_SCRIPT 含 15 路 marker（CORE 3 + vendored 12）", () => {
    // 直接对顶级 const 断言（injectProfile 注入的就是这个 const）
    for (const [label, marker] of expectedMarkers) {
      expect(STEALTH_INJECTION_SCRIPT, `marker 缺失: ${label}`).toMatch(marker);
    }
  });

  it("HeadlessChannel.browse(navigate) 注入的 script 含 15 路 marker（端到端）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new HeadlessChannel(subproc, new StealthEngine(), "windows_chrome_120");

    await ch.browse("https://example.com/", "navigate", {});

    // 合并两次 evaluate 的 script（UA override + 16 路）做 marker 断言
    const evalCalls = stub.calls.filter((c) => c.name === "evaluate_script");
    const allScripts = evalCalls.map((c) => String(c.args.function)).join("\n");
    for (const [label, marker] of expectedMarkers) {
      expect(allScripts, `端到端 marker 缺失: ${label}`).toMatch(marker);
    }
    // 路 16 UA override —— navigator.userAgent 被改写（含 Chrome/130）
    expect(allScripts).toMatch(/Chrome\/130/);
  });
});

// ============================================================
// header 一致性（parse13 §3.2 + §8.2 producer 契约核心）
// ============================================================
describe("HeadlessChannel — header 一致性（UA ↔ secChUa ↔ userAgentData 三方对齐）", () => {
  it("windows_chrome_120 profile: UA Chrome major == secChUa brands major", () => {
    const p = STEALTH_PROFILES.windows_chrome_120;
    const uaMajor = p.userAgent.match(/Chrome\/(\d+)\./)![1];
    expect(p.secChUa).toContain(`v="${uaMajor}"`);
    // secChUa 含 Chrome + Chromium 两个 brand（Chrome profile 特征）
    expect(p.secChUa).toContain("Google Chrome");
    expect(p.secChUa).toContain("Chromium");
  });

  it("mac_safari / linux_firefox profile: secChUa 空串（浏览器原生不发 client hints）", () => {
    // Safari 17 / Firefox 130 均不支持 sec-ch-ua → 空串表「不发此 header」
    expect(STEALTH_PROFILES.mac_safari_17.secChUa).toBe("");
    expect(STEALTH_PROFILES.linux_firefox_121.secChUa).toBe("");
  });

  it("windows_chrome_120 含完整 sec-fetch-* + accept-* header 集（parse13 §3.2）", () => {
    const p = STEALTH_PROFILES.windows_chrome_120;
    // sec-fetch 四件套
    expect(p.secFetchMode).toBe("navigate");
    expect(p.secFetchDest).toBe("document");
    expect(p.secFetchUser).toBe("?1");
    // accept 三件套
    expect(p.accept).toMatch(/text\/html/);
    expect(p.acceptEncoding).toMatch(/gzip/);
    expect(p.acceptLanguage).toMatch(/en-US/);
  });

  it("所有 profile 的 UA 版本 ≥ 要求基线（Chrome 130 / Firefox 130 / Safari 17）", () => {
    expect(STEALTH_PROFILES.windows_chrome_120.userAgent).toMatch(/Chrome\/130\./);
    expect(STEALTH_PROFILES.linux_firefox_121.userAgent).toMatch(/Firefox\/130\./);
    expect(STEALTH_PROFILES.mac_safari_17.userAgent).toMatch(/Version\/17\./);
  });
});

// ============================================================
// spec args flag 契约（parse13 §3.3 --disable-blink-features）
// ============================================================
describe("HeadlessChannel — spec args flag 契约（parse13 §3.3）", () => {
  it("构造时 registerSpec headless 含 --disable-blink-features=AutomationControlled", () => {
    const stub = makeStubClient();
    const { subproc, registerSpecCalls } = makeMockSubproc(stub.client);
    new HeadlessChannel(subproc, new StealthEngine(), "windows_chrome_120");

    const headlessSpec = registerSpecCalls.find((c) => c.name === "headless");
    expect(headlessSpec).toBeTruthy();
    const args = (headlessSpec!.spec as { args: string[] }).args;
    // patchright flag 借鉴（parse13 §3.3）
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    // 既有 flag 保留（零回归）
    expect(args).toContain("--headless");
    expect(args).toContain("--isolated");
    expect(args.some((a) => a.startsWith("chrome-devtools-mcp@"))).toBe(true);
  });

  it("spec args 不含 v1.4 未有的 --user-agent/--window-size flag（parse13 §4.3 spike 未解项不盲加）", () => {
    // parse13 §3.3 列了 --user-agent/--window-size，但 §4.3 spike 确认 chrome-devtools-mcp@0.3.0
    // 无透传机制；v1.5 只加已 spike 验证安全的 --disable-blink-features（unknown flag 不报错），
    // --user-agent/--window-size 留 deferred-Spike（acceptance 手测）。
    const stub = makeStubClient();
    const { subproc, registerSpecCalls } = makeMockSubproc(stub.client);
    new HeadlessChannel(subproc, new StealthEngine(), "windows_chrome_120");

    const args = (registerSpecCalls[0]!.spec as { args: string[] }).args;
    expect(args.some((a) => a.startsWith("--user-agent"))).toBe(false);
    expect(args.some((a) => a.startsWith("--window-size"))).toBe(false);
  });
});

// ============================================================
// INV-6 / INV-2 守护（extends BrowseChannel，actionDispatch 不重写）
// ============================================================
describe("HeadlessChannel — INV-6/INV-2 守护（extends BrowseChannel）", () => {
  it("继承 actionDispatch Map（不重写；8 个 action 都能 dispatch）", async () => {
    const stub = makeStubClient();
    const { subproc } = makeMockSubproc(stub.client);
    const ch = new HeadlessChannel(subproc, new StealthEngine(), "windows_chrome_120");

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
      const r = await ch.browse("https://example.com/", action, {});
      expect(r.outcome).not.toBe("didnt");
      expect(String(r.error ?? "")).not.toMatch(/unknown_action/);
    }
  });

  it("name 字段是 browse_headless（policy gate / fallback decider 识别）", () => {
    const { subproc } = makeMockSubproc({} as McpClient);
    const ch = new HeadlessChannel(subproc, new StealthEngine(), "windows_chrome_120");
    expect(ch.name).toBe("browse_headless");
  });
});
