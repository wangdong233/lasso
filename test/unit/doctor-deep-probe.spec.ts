/**
 * doctor deep probe 单测（v1.14，21-搜索方案重审 S-3）。
 *
 * 覆盖：
 *  - #11b brave_deep_probe 四分类（200→pass / 401→fail key 无效 / 403 或 plan 体语义→fail
 *    计划层级异常 / 429→warn 限流）+ 网络错→warn
 *  - 默认关：无 deep 且无 LASSO_DOCTOR_DEEP → brave_deep_probe 不出现 +
 *    **零 fetch 调用**（doctor 零网络副作用承诺——skipNetwork=false 下断言）
 *  - deep + skipNetwork=true → 跳过（skipNetwork 是硬性不触网总开关）
 *  - deep 但 BRAVE_API_KEYS 空 → warn（无事可做）
 *  - env LASSO_DOCTOR_DEEP=1 等价触发
 *  - #11c bing_keys_retired 静态：未配 → pass；配了 → warn 建议删除（不进 blockers）
 *  - doctor-cli buildDoctorCliOptions：--deep flag 解析（单独 / 与 --stealth-check 叠加）
 *
 * 方法：vi.stubGlobal("fetch", ...) mock global.fetch（doctor-v17-integration.spec.ts
 * 同款范式）；skipNetwork=false 时其余网络 check 走 mock 不触真网。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { buildDoctorCliOptions } from "../../src/doctor/doctor-cli.js";

let savedFetch: typeof global.fetch;
let savedDeepEnv: string | undefined;

beforeEach(() => {
  savedFetch = global.fetch;
  savedDeepEnv = process.env.LASSO_DOCTOR_DEEP;
  delete process.env.LASSO_DOCTOR_DEEP;
});

afterEach(() => {
  global.fetch = savedFetch;
  vi.unstubAllGlobals();
  if (savedDeepEnv === undefined) delete process.env.LASSO_DOCTOR_DEEP;
  else process.env.LASSO_DOCTOR_DEEP = savedDeepEnv;
});

function findCheck(
  report: Awaited<ReturnType<typeof runDoctor>>,
  name: string,
) {
  const c = report.checks.find((c) => c.name === name);
  if (!c) throw new Error(`check ${name} not in report`);
  return c;
}

/** 按 URL 路由的 fetch mock：brave probe URL 命中给定 status/body，其余 200 ok。 */
function stubFetchBrave(status: number, body = "") {
  const mock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("api.search.brave.com")) {
      return new Response(body, { status, statusText: "stub" });
    }
    return new Response("ok", { status: 200, statusText: "OK" });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

// ============================================================
// #11b brave_deep_probe 四分类
// ============================================================
describe("runDoctor #11b brave_deep_probe（S-3）", () => {
  it("200 → pass（key + 计划层健康，明示消耗 1 次额度）", async () => {
    const mock = stubFetchBrave(200, '{"web":{"results":[]}}');
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      deep: true,
      braveKeysCsv: "brave-key-1",
    });
    const c = findCheck(r, "brave_deep_probe");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("200");
    expect(c.detail).toContain("1 次额度");
    // 探测请求形状：q=test&count=1 + X-Subscription-Token header
    const braveCall = mock.mock.calls.find((c) =>
      String(c[0]).includes("api.search.brave.com"),
    )!;
    expect(String(braveCall[0])).toContain("q=test&count=1");
    expect(String(braveCall[0])).not.toContain("brave-key-1"); // key 不进 URL
    const init = braveCall[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe(
      "brave-key-1",
    );
  });

  it("401 → fail「key 无效」+ next_step（凭证问题与计划问题可区分）", async () => {
    stubFetchBrave(401);
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      deep: true,
      braveKeysCsv: "brave-key-1",
    });
    const c = findCheck(r, "brave_deep_probe");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("key 无效");
    expect(c.next_step).toBeTruthy();
    expect(r.blockers).toContain("brave_deep_probe");
  });

  it("403 → fail「计划层级异常」+ 指向 KEY-GUIDE 最后核实列", async () => {
    stubFetchBrave(403);
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      deep: true,
      braveKeysCsv: "brave-key-1",
    });
    const c = findCheck(r, "brave_deep_probe");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("计划层级异常");
    expect(c.detail).toContain("2026-02");
    expect(c.detail).toContain("KEY-GUIDE");
  });

  it("非 403 但响应体含 plan/subscription 语义 → fail 计划层级异常（body 语义兜底）", async () => {
    stubFetchBrave(400, '{"error":"Your subscription plan does not include this API"}');
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      deep: true,
      braveKeysCsv: "brave-key-1",
    });
    const c = findCheck(r, "brave_deep_probe");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("计划层级异常");
    expect(c.detail).toContain("plan/subscription");
  });

  it("429 → warn「限流（key 本身有效）」（不阻塞 ready）", async () => {
    stubFetchBrave(429);
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      deep: true,
      braveKeysCsv: "brave-key-1",
    });
    const c = findCheck(r, "brave_deep_probe");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("限流");
    expect(r.blockers).not.toContain("brave_deep_probe");
  });

  it("5xx → warn（服务端异常，计划状态不可判定）", async () => {
    stubFetchBrave(503);
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      deep: true,
      braveKeysCsv: "brave-key-1",
    });
    const c = findCheck(r, "brave_deep_probe");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("不可判定");
  });

  it("网络错（fetch throw）→ warn 不 fail（网络问题 ≠ 计划失效）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        if (String(input).includes("api.search.brave.com")) {
          throw new Error("mock_network_unreachable");
        }
        return new Response("ok", { status: 200, statusText: "OK" });
      }),
    );
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      deep: true,
      braveKeysCsv: "brave-key-1",
    });
    const c = findCheck(r, "brave_deep_probe");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("网络异常");
  });
});

// ============================================================
// 默认关（零网络副作用承诺）
// ============================================================
describe("runDoctor #11b 默认关（S-3 红线：doctor 零网络副作用）", () => {
  it("无 deep / 无 env → brave_deep_probe 不出现 + 零 Brave fetch 调用", async () => {
    const mock = stubFetchBrave(200);
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      braveKeysCsv: "brave-key-1",
    });
    expect(r.checks.map((c) => c.name)).not.toContain("brave_deep_probe");
    const braveCalls = mock.mock.calls.filter((c) =>
      String(c[0]).includes("api.search.brave.com"),
    );
    expect(braveCalls).toHaveLength(0);
  });

  it("deep=true 但 skipNetwork=true → 跳过（skipNetwork 是硬性不触网总开关）", async () => {
    const mock = stubFetchBrave(200);
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: true,
      skipInvariants: true,
      deep: true,
      braveKeysCsv: "brave-key-1",
    });
    expect(r.checks.map((c) => c.name)).not.toContain("brave_deep_probe");
    expect(mock).not.toHaveBeenCalled();
  });

  it("deep=true 但 BRAVE_API_KEYS 空 → warn（无事可做，不 fail）", async () => {
    stubFetchBrave(200);
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      deep: true,
      braveKeysCsv: "",
    });
    const c = findCheck(r, "brave_deep_probe");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("未配置");
  });

  it("env LASSO_DOCTOR_DEEP=1 等价触发（无 --deep flag 场景 / MCP doctor tool）", async () => {
    process.env.LASSO_DOCTOR_DEEP = "1";
    stubFetchBrave(200);
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: false,
      skipInvariants: true,
      braveKeysCsv: "brave-key-1",
    });
    expect(r.checks.map((c) => c.name)).toContain("brave_deep_probe");
  });
});

// ============================================================
// #11c bing_keys_retired 静态退役提示（零触网）
// ============================================================
describe("runDoctor #11c bing_keys_retired（S-3 静态）", () => {
  it("BING_API_KEYS 未配置 → pass（常态）", async () => {
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: true,
      skipInvariants: true,
      bingKeysCsv: "",
    });
    const c = findCheck(r, "bing_keys_retired");
    expect(c.status).toBe("pass");
  });

  it("BING_API_KEYS 配置 → warn 建议删除 + 不进 blockers（主链已自动跳过）", async () => {
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: true,
      skipInvariants: true,
      bingKeysCsv: "dead-key-1,dead-key-2",
    });
    const c = findCheck(r, "bing_keys_retired");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("2025-08-11");
    expect(c.detail).toContain("2");
    expect(c.next_step).toContain("删除");
    expect(r.blockers).not.toContain("bing_keys_retired");
  });

  it("零触网：bing 检查不依赖 deep 也不 fetch（skipNetwork=true 下仍运行）", async () => {
    const r = await runDoctor({
      zhipuKey: "fake-key",
      skipNetwork: true,
      skipInvariants: true,
    });
    // 默认报告就含 bing_keys_retired（pass），且 brave_deep_probe 不出现
    expect(r.checks.map((c) => c.name)).toContain("bing_keys_retired");
    expect(r.checks.map((c) => c.name)).not.toContain("brave_deep_probe");
  });
});

// ============================================================
// doctor-cli --deep flag 解析
// ============================================================
describe("buildDoctorCliOptions —— --deep flag（S-3）", () => {
  it("无 flag → doctorOpts 无 deep（零回归）", () => {
    const r = buildDoctorCliOptions([]);
    expect(r.deep).toBe(false);
    expect(r.doctorOpts.deep).toBeUndefined();
    expect(r.stealthCheck).toBe(false);
    expect(r.shutdown).toBeNull();
  });

  it("--deep → doctorOpts.deep=true（不 spawn headless，shutdown=null）", () => {
    const r = buildDoctorCliOptions(["--deep"]);
    expect(r.deep).toBe(true);
    expect(r.doctorOpts.deep).toBe(true);
    expect(r.stealthCheck).toBe(false);
    expect(r.shutdown).toBeNull();
  });

  it("--deep 与 --stealth-check 可叠加（两者独立）", () => {
    const headless = () => ({
      ensureRunning: async () => {
        throw new Error("not spawned in unit test");
      },
      shutdown: async () => {},
    });
    const r = buildDoctorCliOptions(["--stealth-check", "--deep"], { headless });
    expect(r.deep).toBe(true);
    expect(r.stealthCheck).toBe(true);
    expect(r.doctorOpts.deep).toBe(true);
    expect(r.doctorOpts.stealthCheck).toBe(true);
    expect(r.shutdown).not.toBeNull();
  });
});
