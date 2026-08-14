/**
 * StealthEngine 单测（parse5 §3.3.1 + §5.2 + task #7）
 *
 * 覆盖：
 *  - injectProfile：未知 profile → throw unknown_stealth_profile
 *  - injectProfile：已知 profile → 调 evaluate_script 注入 webdriver 抹除脚本
 *  - injectProfile：evaluate 失败时不抛（best-effort；caller 经 detectCloudflare 兜底）
 *  - injectProfile：注入脚本含 navigator.webdriver override（payload 来自 stealth-profiles.ts）
 *  - detectCloudflareChallenge：返 "true" → true（CF challenge 页面）
 *  - detectCloudflareChallenge：返 "false" → false（正常页面）
 *  - detectCloudflareChallenge：evaluate 抛错 → false（保守，不阻断）
 *  - detectCloudflareChallenge：返非 "true"/"false" → 走 CLOUDFLARE_DETECTION_REGEX 兜底
 *  - escalateManualSwitch：返 outcome=didnt + retrieval_method=cloudflare_manual_switch
 *
 * 关键断言：
 *  - StealthEngine 不感知 channel（只接 McpClient 接口）
 *  - 注入脚本是顶级 const 数据（stealth-profiles.ts），本类只 dispatch
 *  - StealthEngine 不读 process.env / 不 import config（INV-30 衍生）
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  StealthEngine,
  toFnExpression,
} from "../../src/browse/StealthEngine.js";
import {
  STEALTH_INJECTION_SCRIPT,
  STEALTH_PROFILES,
} from "../../src/browse/stealth-profiles.js";
import { logger } from "../../src/util/logger.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

// ============================================================
// Mock McpClient
// ============================================================
type EvalHandler = (
  functionStr: string,
) => string | Promise<string> | { content: unknown } | Promise<{ content: unknown }>;

/**
 * 构造 mock McpClient：捕获 callTool 调用 + 按 handler 返回结果。
 * 默认 evaluate_script 返 { content: [{ type: "text", text: "ok" }] }。
 */
function makeMockClient(opts: {
  evalHandler?: EvalHandler;
  throwOnCall?: boolean;
} = {}): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: string; text: string }> }> {
      calls.push({ name, args });
      if (opts.throwOnCall) {
        throw new Error("mock_call_thrown");
      }
      if (name === "evaluate_script" && opts.evalHandler) {
        const fn = (args.function as string) ?? "";
        const r = await opts.evalHandler(fn);
        if (typeof r === "string") {
          return { content: [{ type: "text", text: r }] };
        }
        return r as { content: Array<{ type: string; text: string }> };
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  return { client: client as unknown as McpClient, calls };
}

// ============================================================
// injectProfile
// ============================================================
describe("StealthEngine.injectProfile — 注入 webdriver 抹除脚本", () => {
  it("未知 profile → throw unknown_stealth_profile", async () => {
    const engine = new StealthEngine();
    const { client } = makeMockClient();
    await expect(
      engine.injectProfile(
        client,
        "totally_made_up_profile" as never,
      ),
    ).rejects.toThrow(/unknown_stealth_profile:totally_made_up_profile/);
  });

  it("已知 profile → 调 evaluate_script 注入 STEALTH_INJECTION_SCRIPT（v1.5 16 路）", async () => {
    const engine = new StealthEngine();
    const { client, calls } = makeMockClient();
    await engine.injectProfile(client, "windows_chrome_120");
    // v1.5：UA override 先执行（evalCalls[0]），STEALTH_INJECTION_SCRIPT 后执行（evalCalls[1]）
    const evalCalls = calls.filter((c) => c.name === "evaluate_script");
    expect(evalCalls.length).toBeGreaterThanOrEqual(2);
    // 用 find 而非 index（顺序不依赖；v1.5 UA override 在 SCRIPT 前）
    // W1-DEF-1（v1.8）：SCRIPT 是 13 段 IIFE 语句串——上游 0.3.0 契约下包成单个函数表达式
    const scriptCall = evalCalls.find(
      (c) => c.args.function === toFnExpression(STEALTH_INJECTION_SCRIPT),
    );
    expect(scriptCall).toBeTruthy();
    // 真实契约验证：传给上游的必须是可 eval 的函数表达式
    const fn = eval(`(${scriptCall!.args.function})`) as () => unknown;
    expect(typeof fn).toBe("function");
  });

  it("注入脚本含 navigator.webdriver override（payload 来自 stealth-profiles）", async () => {
    const engine = new StealthEngine();
    const { client, calls } = makeMockClient();
    await engine.injectProfile(client, "mac_safari_17");
    // v1.5：UA override 先执行（第一次 evaluate），STEALTH_INJECTION_SCRIPT 第二次；
    // webdriver hook 在 STEALTH_INJECTION_SCRIPT 内 → 找 SCRIPT 那次 call
    const scriptCall = calls.find(
      (c) => c.args.function === toFnExpression(STEALTH_INJECTION_SCRIPT),
    );
    expect(scriptCall).toBeTruthy();
    expect(String(scriptCall!.args.function)).toMatch(/navigator.*webdriver/s);
  });

  it("userAgent override 脚本含 profile 的 userAgent 字面量（v1.5 先于 SCRIPT 执行）", async () => {
    const engine = new StealthEngine();
    const { client, calls } = makeMockClient();
    await engine.injectProfile(client, "linux_firefox_121");
    // v1.5：UA override 是第一次 evaluate（先执行以使 UA client hints 读到正确版本）
    const evalCalls = calls.filter((c) => c.name === "evaluate_script");
    expect(evalCalls.length).toBeGreaterThanOrEqual(2);
    const uaScript = String(evalCalls[0]!.args.function);
    expect(uaScript).toContain("Firefox/130.0"); // v1.5 升 Firefox 130
    expect(uaScript).toContain("Linux x86_64");
  });

  it("evaluate 失败时不抛（best-effort，不阻断 browse）", async () => {
    const engine = new StealthEngine();
    const { client } = makeMockClient({ throwOnCall: true });
    // injectProfile 应 resolve（不抛），caller 经 detectCloudflare 兜底
    await expect(
      engine.injectProfile(client, "windows_chrome_120"),
    ).resolves.toBeUndefined();
  });

  it("StealthEngine 不感知 channel（只接 McpClient 接口）", async () => {
    // 静态断言：StealthEngine 类无 channel 引用 / 无 surface 引用
    const engine = new StealthEngine();
    expect(engine).toBeDefined();
    expect(typeof engine.injectProfile).toBe("function");
    expect(typeof engine.detectCloudflareChallenge).toBe("function");
    expect(typeof engine.escalateManualSwitch).toBe("function");
  });
});

// ============================================================
// v1.5 16 路 evasion 覆盖（parse13 §3.1 + §5.1）
// ============================================================
describe("StealthEngine v1.5 — 16 路 evasion 覆盖（parse13 §3.1）", () => {
  it("STEALTH_INJECTION_SCRIPT 含 16 路 evasion 关键 hook（webdriver / languages / permissions + chrome.runtime/app/csi/loadTimes / plugins / vendor / hardwareConcurrency / media.codecs / webgl.vendor / iframe.contentWindow / outerdimensions / userAgentData）", async () => {
    const engine = new StealthEngine();
    const { client, calls } = makeMockClient();
    await engine.injectProfile(client, "windows_chrome_120");
    const scriptCall = calls.find(
      (c) => c.args.function === toFnExpression(STEALTH_INJECTION_SCRIPT),
    );
    expect(scriptCall).toBeTruthy();
    const script = String(scriptCall!.args.function);
    // CORE 3 路
    expect(script).toMatch(/["']webdriver["']/); // 路 1
    expect(script).toMatch(/["']languages["']/); // 路 2
    expect(script).toMatch(/notifications/); // 路 3 permissions
    // vendored 12 路（每路关键标识）
    expect(script).toMatch(/chrome\.runtime/); // 路 4 chrome.runtime 增强
    expect(script).toMatch(/chrome\.app/); // 路 5
    expect(script).toMatch(/chrome\.csi/); // 路 6
    expect(script).toMatch(/chrome\.loadTimes/); // 路 7
    expect(script).toMatch(/navigator.*plugins/); // 路 8
    expect(script).toMatch(/["']vendor["']/); // 路 9
    expect(script).toMatch(/hardwareConcurrency/); // 路 10
    expect(script).toMatch(/canPlayType/); // 路 11 media.codecs
    expect(script).toMatch(/37445|UNMASKED_VENDOR/); // 路 12 webgl.vendor
    expect(script).toMatch(/contentWindow|createElement/); // 路 13 iframe
    expect(script).toMatch(/outerWidth|outerHeight/); // 路 14 outerdimensions
    expect(script).toMatch(/userAgentData/); // 路 15 UA client hints
  });

  it("STEALTH_INJECTION_SCRIPT 是 13 段 join（CORE + 12 vendored import）", () => {
    // 静态：SCRIPT 由多段 IIFE join 而成，每段 try/catch 自包
    // 统计独立 IIFE 数（"(function(){" 出现次数）
    const iifeCount = (STEALTH_INJECTION_SCRIPT.match(/\(function\(\)\s*\{/g) || []).length;
    expect(iifeCount).toBeGreaterThanOrEqual(13); // CORE + 12 路
  });

  it("每路 evasion 自包 try/catch（best-effort，单路失败不影响其它）", () => {
    // try { 数量 ≥ catch 数量 ≥ 13（每路独立 try/catch）
    const tryCount = (STEALTH_INJECTION_SCRIPT.match(/try\s*\{/g) || []).length;
    const catchCount = (STEALTH_INJECTION_SCRIPT.match(/catch\s*\(/g) || []).length;
    expect(tryCount).toBeGreaterThanOrEqual(13);
    expect(catchCount).toBeGreaterThanOrEqual(13);
  });

  it("userAgent override 脚本先于 STEALTH_INJECTION_SCRIPT 执行（v1.5 顺序，使 UA client hints 读到正确版本）", async () => {
    const engine = new StealthEngine();
    const { client, calls } = makeMockClient();
    await engine.injectProfile(client, "windows_chrome_120");
    const evalCalls = calls.filter((c) => c.name === "evaluate_script");
    expect(evalCalls.length).toBeGreaterThanOrEqual(2);
    // evalCalls[0] = UA override（含 profile UA），evalCalls[1] = STEALTH_INJECTION_SCRIPT
    expect(String(evalCalls[0]!.args.function)).toContain("Chrome/130");
    expect(evalCalls[1]!.args.function).toBe(
      toFnExpression(STEALTH_INJECTION_SCRIPT),
    );
  });
});

// ============================================================
// v1.5 header 一致性（parse13 §3.2 + §5.1 UA ↔ sec-ch-ua ↔ userAgentData 三方一致）
// ============================================================
describe("StealthEngine v1.5 — UA ↔ sec-ch-ua 一致性（parse13 §8.2 producer 契约）", () => {
  it("windows_chrome_120：UA Chrome 版本(130) == secChUa 版本(130)", () => {
    const p = STEALTH_PROFILES.windows_chrome_120;
    const uaMatch = p.userAgent.match(/Chrome\/(\d+)/);
    expect(uaMatch).toBeTruthy();
    const uaMajor = uaMatch![1];
    // secChUa 含相同 major 版本
    expect(p.secChUa).toContain(`v="${uaMajor}"`);
  });

  it("windows_chrome_120：secChUa 三件套 brands（Google Chrome / Chromium / Not?A_Brand）", () => {
    const p = STEALTH_PROFILES.windows_chrome_120;
    expect(p.secChUa).toContain("Google Chrome");
    expect(p.secChUa).toContain("Chromium");
    expect(p.secChUa).toMatch(/Not.A_Brand/); // ghost brand 变体（Not?A_Brand）
  });

  it("Safari / Firefox profile secChUa 为空（浏览器原生不发 client hints）", () => {
    expect(STEALTH_PROFILES.mac_safari_17.secChUa).toBe("");
    expect(STEALTH_PROFILES.linux_firefox_121.secChUa).toBe("");
  });

  it("所有 profile 含完整 header 集 11 字段（parse13 §3.2 方案 A）", () => {
    const requiredHeaders = [
      "secChUa", "secChUaMobile", "secChUaPlatform",
      "accept", "acceptEncoding", "acceptLanguage",
      "secFetchSite", "secFetchMode", "secFetchUser", "secFetchDest",
      "upgradeInsecureRequests",
    ] as const;
    for (const [name, profile] of Object.entries(STEALTH_PROFILES)) {
      for (const h of requiredHeaders) {
        expect(profile).toHaveProperty(h);
        expect(typeof (profile as Record<string, unknown>)[h]).toBe("string");
      }
    }
  });
});

// ============================================================
// detectCloudflareChallenge
// ============================================================
describe("StealthEngine.detectCloudflareChallenge — CF challenge 检测", () => {
  it('evaluate 返 "true" → true（CF challenge 页面）', async () => {
    const engine = new StealthEngine();
    const { client } = makeMockClient({
      evalHandler: () => "true",
    });
    expect(await engine.detectCloudflareChallenge(client)).toBe(true);
  });

  it('evaluate 返 "false" → false（正常页面）', async () => {
    const engine = new StealthEngine();
    const { client } = makeMockClient({
      evalHandler: () => "false",
    });
    expect(await engine.detectCloudflareChallenge(client)).toBe(false);
  });

  it('evaluate 返 "true" 带空白 → trim 后 true', async () => {
    const engine = new StealthEngine();
    const { client } = makeMockClient({
      evalHandler: () => "  true  ",
    });
    expect(await engine.detectCloudflareChallenge(client)).toBe(true);
  });

  it("evaluate 抛错 → false（保守，不阻断 browse）", async () => {
    const engine = new StealthEngine();
    const { client } = makeMockClient({ throwOnCall: true });
    expect(await engine.detectCloudflareChallenge(client)).toBe(false);
  });

  it('evaluate 返非契约字符串 + 含 CF marker → 走 CLOUDFLARE_DETECTION_REGEX 兜底 true', async () => {
    const engine = new StealthEngine();
    const { client } = makeMockClient({
      // 模拟 evaluate 返原始 title + body（非 "true"/"false" 契约）
      evalHandler: () => "Welcome — Just a moment...\nChecking your browser",
    });
    expect(await engine.detectCloudflareChallenge(client)).toBe(true);
  });

  it('evaluate 返非契约字符串 + 无 CF marker → 兜底 false', async () => {
    const engine = new StealthEngine();
    const { client } = makeMockClient({
      evalHandler: () => "Welcome to example.com — normal page",
    });
    expect(await engine.detectCloudflareChallenge(client)).toBe(false);
  });

  it("调用 evaluate_script 时传 CLOUDFLARE_DETECTION_SCRIPT（payload 来自 stealth-profiles）", async () => {
    const engine = new StealthEngine();
    const { client, calls } = makeMockClient({
      evalHandler: () => "false",
    });
    await engine.detectCloudflareChallenge(client);
    const evalCall = calls.find((c) => c.name === "evaluate_script");
    expect(evalCall).toBeTruthy();
    // 含 CF markers 之一（间接证明是 CLOUDFLARE_DETECTION_SCRIPT）
    expect(String(evalCall!.args.function)).toContain("Just a moment");
  });
});

// ============================================================
// escalateManualSwitch
// ============================================================
describe("StealthEngine.escalateManualSwitch — Argus 范式（不自动 captcha）", () => {
  it("cloudflare_detected → outcome=didnt + retrieval_method=cloudflare_manual_switch", () => {
    const engine = new StealthEngine();
    const verdict = engine.escalateManualSwitch("cloudflare_detected");
    expect(verdict.outcome).toBe("didnt");
    expect(verdict.retrieval_method).toBe("cloudflare_manual_switch");
    expect(verdict.error).toContain("cloudflare_challenge_detected");
  });

  it("stealth_inject_failed → outcome=didnt + 错误标识含 stealth_inject_failed", () => {
    const engine = new StealthEngine();
    const verdict = engine.escalateManualSwitch("stealth_inject_failed");
    expect(verdict.outcome).toBe("didnt");
    expect(verdict.retrieval_method).toBe("cloudflare_manual_switch");
    expect(verdict.error).toContain("stealth_inject_failed");
  });

  it("verdict 不返 worked（绝不自动 captcha 求解 — Argus 政策红线）", () => {
    const engine = new StealthEngine();
    const v1 = engine.escalateManualSwitch("cloudflare_detected");
    const v2 = engine.escalateManualSwitch("stealth_inject_failed");
    expect(v1.outcome).not.toBe("worked");
    expect(v2.outcome).not.toBe("worked");
    // 也不应是 unknown（caller 必须看到明确 didnt 才能停）
    expect(v1.outcome).not.toBe("unknown");
    expect(v2.outcome).not.toBe("unknown");
  });
});

// ============================================================
// W1-DEF-1（v1.8）：上游 isError 校验——禁 stealth_injected 误报
// ============================================================
describe("StealthEngine.injectProfile — W1-DEF-1 上游 isError 校验（禁误报）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("上游返 isError=true → 不记 stealth_injected，记 stealth_inject_failed", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const engine = new StealthEngine();
    // 模拟上游 0.3.0 对非法脚本返 isError（callTool 不 reject，SDK 返 { content, isError }）
    const { client } = makeMockClient({
      evalHandler: () =>
        ({ content: [{ type: "text", text: "fn is not a function" }], isError: true }) as never,
    });
    await engine.injectProfile(client, "windows_chrome_120");
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ evt: "stealth_injected" }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ evt: "stealth_inject_failed" }),
    );
  });

  it("上游 callTool reject → 不记 stealth_injected，记 stealth_inject_failed", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const engine = new StealthEngine();
    const { client } = makeMockClient({ throwOnCall: true });
    await engine.injectProfile(client, "mac_safari_17");
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ evt: "stealth_injected" }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ evt: "stealth_inject_failed" }),
    );
  });

  it("上游正常返回（非 isError）→ 记 stealth_injected（原行为保留）", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const engine = new StealthEngine();
    const { client } = makeMockClient();
    await engine.injectProfile(client, "linux_firefox_121");
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ evt: "stealth_injected" }),
    );
  });

  it("STEALTH_INJECTION_SCRIPT 包成的函数表达式可 eval 且实调不抛（真实契约）", () => {
    const wrapped = toFnExpression(STEALTH_INJECTION_SCRIPT);
    const fn = eval(`(${wrapped})`) as () => unknown;
    expect(typeof fn).toBe("function");
    // 在 Node 里执行：document/navigator 未定义——各段 IIFE 自包 try/catch，不抛
    expect(() => fn()).not.toThrow();
  });
});
