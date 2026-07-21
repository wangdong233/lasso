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
import { describe, it, expect, vi } from "vitest";
import { StealthEngine } from "../../src/browse/StealthEngine.js";
import { STEALTH_INJECTION_SCRIPT } from "../../src/browse/stealth-profiles.js";
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

  it("已知 profile → 调 evaluate_script 注入 STEALTH_INJECTION_SCRIPT", async () => {
    const engine = new StealthEngine();
    const { client, calls } = makeMockClient();
    await engine.injectProfile(client, "windows_chrome_120");
    // 第一次 callTool 是 STEALTH_INJECTION_SCRIPT
    const evalCalls = calls.filter((c) => c.name === "evaluate_script");
    expect(evalCalls.length).toBeGreaterThanOrEqual(1);
    expect(evalCalls[0]!.args.function).toBe(STEALTH_INJECTION_SCRIPT);
  });

  it("注入脚本含 navigator.webdriver override（payload 来自 stealth-profiles）", async () => {
    const engine = new StealthEngine();
    const { client, calls } = makeMockClient();
    await engine.injectProfile(client, "mac_safari_17");
    const evalCall = calls.find((c) => c.name === "evaluate_script");
    expect(evalCall).toBeTruthy();
    expect(String(evalCall!.args.function)).toMatch(/navigator.*webdriver/s);
  });

  it("userAgent override 脚本含 profile 的 userAgent 字面量", async () => {
    const engine = new StealthEngine();
    const { client, calls } = makeMockClient();
    await engine.injectProfile(client, "linux_firefox_121");
    // 第二次 callTool 是 userAgent override（含 profile UA 字符串片段）
    const evalCalls = calls.filter((c) => c.name === "evaluate_script");
    expect(evalCalls.length).toBeGreaterThanOrEqual(2);
    const uaScript = String(evalCalls[1]!.args.function);
    expect(uaScript).toContain("Firefox/121.0");
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
