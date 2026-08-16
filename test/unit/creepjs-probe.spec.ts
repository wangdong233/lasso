/**
 * creepjs-probe 单测（parse15 §5.1 —— v1.7 Phase A）
 *
 * 覆盖（mock McpClient callTool → navigate/wait/evaluate）：
 *  - probeCreepjs navigate 失败 → reachable=false + rawSample 含 navigate_failed
 *  - probeCreepjs wait_for timeout → reachable=true, fingerprintComputed=false
 *  - probeCreepjs evaluate 返完整 lies → 各字段正确解析
 *  - probeCreepjs evaluate 返 fingerprintComputed=false（window.Fingerprint 未就绪）
 *  - probeCreepjs evaluate 返非 JSON → 不崩 + fingerprintComputed=false
 *  - probeCreepjs evaluate 抛错 → fingerprintComputed=false + rawSample 含 evaluate_failed
 *  - probeCreepjs 成功路径推导 permissionsLied / webglGetParameterLied 从 liedModules
 *  - probeCreepjs 调用顺序：navigate_page → wait_for → evaluate_script（producer 契约）
 *
 * 关键铁律（parse15 §3.1）：
 *  - 三段式 producer 契约：navigate → wait_for "FP ID:" → evaluate（顺序不可乱）
 *  - CREEPJS_LIES_EXTRACT_SCRIPT 是顶级 const（INV-30 衍生：测试验证脚本 ID 不变）
 *  - 错误路径 graceful 不抛（每条显式返结构化 report）
 *  - 字段集 ↔ baseline.json ↔ checkStealthCreepjsRegression 三处同步（§1.7.7 跨边界同步对）
 *
 * mock 策略（同 stealth-engine.spec.ts 范式）：
 *  - vi.fn callTool 按 name dispatch：navigate_page / wait_for / evaluate_script
 *  - 不触真网（SMALL 约束；03 §2 测试大小）
 */
import { describe, it, expect, vi } from "vitest";
import {
  probeCreepjs,
  CREEPJS_LIES_EXTRACT_SCRIPT,
  type CreepjsLiesReport,
} from "../../src/doctor/creepjs-probe.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

// ============================================================
// Mock helpers
// ============================================================
type NavigateHandler = () => void;
type WaitHandler = () => void;
type EvalHandler = (
  functionStr: string,
) => string | { content: Array<{ type: string; text: string }> };

interface MockClientOpts {
  /** navigate_page 抛错（模拟网络不可达） */
  navigateThrows?: boolean;
  /** wait_for 抛错（模拟 timeout，FP ID 未出现） */
  waitThrows?: boolean;
  /** evaluate_script 自定义返回（默认返 fingerprintComputed:false 空对象） */
  evalHandler?: EvalHandler;
  /** evaluate_script 抛错 */
  evalThrows?: boolean;
}

interface MockClient {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

/**
 * 构造 mock McpClient：捕获 callTool 调用 + 按 name 路由返/抛。
 * 默认路径（无 handler）：navigate_page / wait_for 返 ok；evaluate_script 返 {fingerprintComputed:false}。
 */
function makeMockClient(opts: MockClientOpts = {}): MockClient {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: string; text: string }> }> {
      calls.push({ name, args });
      if (name === "navigate_page") {
        if (opts.navigateThrows) {
          throw new Error("mock_navigate_net_err");
        }
        return { content: [{ type: "text", text: "navigated" }] };
      }
      if (name === "wait_for") {
        if (opts.waitThrows) {
          throw new Error("mock_wait_fp_id_timeout");
        }
        return { content: [{ type: "text", text: "found" }] };
      }
      if (name === "evaluate_script") {
        if (opts.evalThrows) {
          throw new Error("mock_evaluate_failed");
        }
        if (opts.evalHandler) {
          const r = opts.evalHandler(args.function as string);
          if (typeof r === "string") {
            return { content: [{ type: "text", text: r }] };
          }
          return r;
        }
        // 默认返 fingerprintComputed:false（window.Fingerprint 未就绪）
        return {
          content: [{ type: "text", text: JSON.stringify({ fingerprintComputed: false }) }],
        };
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  return { client: client as unknown as McpClient, calls };
}

/** 构造完整 lies payload（mock evaluate_script 返） */
function fullLiesPayload(overrides: Partial<{
  totalLies: number;
  liedModules: string[];
  navigatorLied: boolean;
  screenLied: boolean;
  canvasWebglLied: boolean;
  canvas2dLied: boolean;
  permissionsLied: boolean;
  creepjsVersion: string;
}> = {}): string {
  return JSON.stringify({
    fingerprintComputed: true,
    totalLies: overrides.totalLies ?? 12,
    liedModules: overrides.liedModules ?? ["navigator", "screen", "canvasWebgl"],
    navigatorLied: overrides.navigatorLied ?? true,
    screenLied: overrides.screenLied ?? true,
    canvasWebglLied: overrides.canvasWebglLied ?? true,
    canvas2dLied: overrides.canvas2dLied ?? false,
    permissionsLied: overrides.permissionsLied ?? false,
    creepjsVersion: overrides.creepjsVersion ?? "v4 Yours",
  });
}

// ============================================================
// CREEPJS_LIES_EXTRACT_SCRIPT 顶级 const 守护
// ============================================================
describe("CREEPJS_LIES_EXTRACT_SCRIPT —— 顶级 const（INV-30 衍生）", () => {
  it("导出为字符串 + 非空", () => {
    expect(typeof CREEPJS_LIES_EXTRACT_SCRIPT).toBe("string");
    expect(CREEPJS_LIES_EXTRACT_SCRIPT.length).toBeGreaterThan(100);
  });

  it("含 window.Fingerprint 访问（脚本逻辑正确性）", () => {
    expect(CREEPJS_LIES_EXTRACT_SCRIPT).toMatch(/window\.Fingerprint/);
  });

  it("含 JSON.stringify 返回（chrome-devtools-mcp evaluate 契约）", () => {
    expect(CREEPJS_LIES_EXTRACT_SCRIPT).toMatch(/JSON\.stringify/);
  });

  it("含 totalLies 字段（量化信号；§1.7.7 跨边界同步对）", () => {
    expect(CREEPJS_LIES_EXTRACT_SCRIPT).toMatch(/totalLies/);
  });

  it("不从 process.env / config 读（INV-30 衍生：防 LLM 改探测脚本）", () => {
    expect(CREEPJS_LIES_EXTRACT_SCRIPT).not.toMatch(/process\.env/);
    expect(CREEPJS_LIES_EXTRACT_SCRIPT).not.toMatch(/require\(/);
    expect(CREEPJS_LIES_EXTRACT_SCRIPT).not.toMatch(/import\(/);
  });
});

// ============================================================
// probeCreepjs —— 成功路径
// ============================================================
describe("probeCreepjs —— 成功路径（evaluate 返完整 lies）", () => {
  it("各字段正确解析（totalLies / navigatorLied / liedModules）", async () => {
    const { client, calls } = makeMockClient({
      evalHandler: () => fullLiesPayload({
        totalLies: 15,
        liedModules: ["navigator", "screen", "canvasWebgl"],
        navigatorLied: true,
        screenLied: true,
        canvasWebglLied: true,
        permissionsLied: false,
      }),
    });
    const report = await probeCreepjs(client);

    expect(report.reachable).toBe(true);
    expect(report.fingerprintComputed).toBe(true);
    expect(report.totalLies).toBe(15);
    expect(report.navigatorLied).toBe(true);
    expect(report.screenLied).toBe(true);
    expect(report.canvasWebglLied).toBe(true);
    expect(report.canvas2dLied).toBe(false);
    expect(report.liedModules).toEqual(["navigator", "screen", "canvasWebgl"]);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.rawSample.length).toBeGreaterThan(0);
    // 调用顺序：navigate_page → wait_for → evaluate_script（producer 契约）
    expect(calls.map((c) => c.name)).toEqual([
      "navigate_page",
      "wait_for",
      "evaluate_script",
    ]);
  });

  it("wait_for 接 FP ID: 文本（producer 契约验证）", async () => {
    const { client, calls } = makeMockClient({
      evalHandler: () => fullLiesPayload(),
    });
    await probeCreepjs(client);
    const waitCall = calls.find((c) => c.name === "wait_for");
    expect(waitCall).toBeTruthy();
    // v1.11（round1 T1）：上游 1.7.0 契约——wait_for.text 是非空 string 数组
    // （zod.array(zod.string()).min(1)；0.3.0 单条 string 翻转）
    expect(waitCall!.args.text).toEqual(["FP ID:"]);
    expect(Array.isArray(waitCall!.args.text)).toBe(true);
  });

  it("evaluate_script 调 CREEPJS_LIES_EXTRACT_SCRIPT（顶级 const ID 不变）", async () => {
    const { client, calls } = makeMockClient({
      evalHandler: () => fullLiesPayload(),
    });
    await probeCreepjs(client);
    const evalCall = calls.find((c) => c.name === "evaluate_script");
    expect(evalCall).toBeTruthy();
    expect(evalCall!.args.function).toBe(CREEPJS_LIES_EXTRACT_SCRIPT);
  });

  it("navigate_page 用默认 URL（abrahamjuliot.github.io/creepjs/）", async () => {
    const { client, calls } = makeMockClient({
      evalHandler: () => fullLiesPayload(),
    });
    await probeCreepjs(client);
    const navCall = calls.find((c) => c.name === "navigate_page");
    expect(navCall).toBeTruthy();
    expect(navCall!.args.url).toBe("https://abrahamjuliot.github.io/creepjs/");
    expect(navCall!.args.type).toBe("url");
  });

  it("opts.url 覆盖默认 URL", async () => {
    const { client, calls } = makeMockClient({
      evalHandler: () => fullLiesPayload(),
    });
    await probeCreepjs(client, { url: "https://example.com/custom-creepjs/" });
    const navCall = calls.find((c) => c.name === "navigate_page");
    expect(navCall!.args.url).toBe("https://example.com/custom-creepjs/");
  });

  it("liedModules 含 permissions/webgl → 派生 permissionsLied / webglGetParameterLied", async () => {
    // 注意：脚本也直接读 fp.permissions.lied（parse15 §3.1 步骤 4 推导）
    // 本用例验 liedModules 兜底推导路径
    const { client } = makeMockClient({
      evalHandler: () => fullLiesPayload({
        liedModules: ["permissions", "webglVersion", "navigator"],
        permissionsLied: false, // 脚本返 false 但 liedModules 含 permissions → 仍 true（推导）
      }),
    });
    const report = await probeCreepjs(client);
    expect(report.permissionsLied).toBe(true);
    expect(report.webglGetParameterLied).toBe(true);
  });

  it("liedModules 不含 permissions/webgl → permissionsLied=false", async () => {
    const { client } = makeMockClient({
      evalHandler: () => fullLiesPayload({
        liedModules: ["navigator"],
        permissionsLied: false,
      }),
    });
    const report = await probeCreepjs(client);
    expect(report.permissionsLied).toBe(false);
    expect(report.webglGetParameterLied).toBe(false);
  });

  it("totalLies=0 也算成功（极端场景：perfect stealth）", async () => {
    const { client } = makeMockClient({
      evalHandler: () => fullLiesPayload({
        totalLies: 0,
        liedModules: [],
        navigatorLied: false,
      }),
    });
    const report = await probeCreepjs(client);
    expect(report.fingerprintComputed).toBe(true);
    expect(report.totalLies).toBe(0);
    expect(report.liedModules).toEqual([]);
  });
});

// ============================================================
// probeCreepjs —— 错误路径（graceful 不抛；parse15 §3.1 步骤 5）
// ============================================================
describe("probeCreepjs —— 错误路径 graceful 不抛", () => {
  it("navigate 失败 → reachable=false + 其余字段 false/0", async () => {
    const { client } = makeMockClient({ navigateThrows: true });
    const report = await probeCreepjs(client);
    expect(report.reachable).toBe(false);
    expect(report.fingerprintComputed).toBe(false);
    expect(report.totalLies).toBe(0);
    expect(report.liedModules).toEqual([]);
    expect(report.navigatorLied).toBe(false);
    expect(report.rawSample).toMatch(/navigate_failed/);
  });

  it("wait_for timeout → reachable=true, fingerprintComputed=false", async () => {
    const { client } = makeMockClient({ waitThrows: true });
    const report = await probeCreepjs(client);
    expect(report.reachable).toBe(true);
    expect(report.fingerprintComputed).toBe(false);
    expect(report.totalLies).toBe(0);
    expect(report.rawSample).toMatch(/wait_fp_id_timeout/);
  });

  it("evaluate 返 fingerprintComputed=false（window.Fingerprint 未就绪）", async () => {
    const { client } = makeMockClient({
      evalHandler: () => JSON.stringify({ fingerprintComputed: false }),
    });
    const report = await probeCreepjs(client);
    expect(report.reachable).toBe(true);
    expect(report.fingerprintComputed).toBe(false);
    expect(report.totalLies).toBe(0);
  });

  it("evaluate 返 fingerprintComputed=false + error 字段（脚本 catch）", async () => {
    const { client } = makeMockClient({
      evalHandler: () =>
        JSON.stringify({
          fingerprintComputed: false,
          error: "Cannot read property 'navigator' of undefined",
        }),
    });
    const report = await probeCreepjs(client);
    expect(report.fingerprintComputed).toBe(false);
    expect(report.rawSample).toMatch(/fingerprint_not_computed/);
    expect(report.rawSample).toMatch(/Cannot read property/);
  });

  it("evaluate 返非 JSON → 不崩 + fingerprintComputed=false + rawSample 含 parse_failed", async () => {
    const { client } = makeMockClient({
      evalHandler: () => "this is not json {{",
    });
    const report = await probeCreepjs(client);
    expect(report.fingerprintComputed).toBe(false);
    expect(report.rawSample).toMatch(/parse_failed/);
  });

  it("evaluate 抛错 → fingerprintComputed=false + rawSample 含 evaluate_failed", async () => {
    const { client } = makeMockClient({ evalThrows: true });
    const report = await probeCreepjs(client);
    expect(report.fingerprintComputed).toBe(false);
    expect(report.rawSample).toMatch(/evaluate_failed/);
  });

  it("成功路径 reachable=true + rawSample 含 fingerprintComputed:true（JSON 全文 slice）", async () => {
    const { client } = makeMockClient({
      evalHandler: () => fullLiesPayload({ creepjsVersion: "test-v4" }),
    });
    const report = await probeCreepjs(client);
    expect(report.reachable).toBe(true);
    expect(report.fingerprintComputed).toBe(true);
    expect(report.creepjsVersion).toBe("test-v4");
    // rawSample 含原始 JSON
    expect(report.rawSample).toMatch(/fingerprintComputed/);
    expect(report.rawSample).toMatch(/test-v4/);
  });
});

// ============================================================
// probeCreepjs —— 字段集契约（§1.7.7 跨边界同步对）
// ============================================================
describe("probeCreepjs —— CreepjsLiesReport 字段集契约", () => {
  it("report 含 parse15 §3.1 全部 12 个字段", async () => {
    const { client } = makeMockClient({
      evalHandler: () => fullLiesPayload(),
    });
    const report = await probeCreepjs(client);
    const keys = Object.keys(report).sort();
    // 12 字段（parse15 §3.1 CreepjsLiesReport 接口）
    expect(keys).toEqual([
      "canvas2dLied",
      "canvasWebglLied",
      "creepjsVersion",
      "elapsedMs",
      "fingerprintComputed",
      "liedModules",
      "navigatorLied",
      "permissionsLied",
      "rawSample",
      "reachable",
      "screenLied",
      "totalLies",
      "webglGetParameterLied",
    ]);
  });

  it("错误路径也返完整字段集（不缺字段）", async () => {
    const { client } = makeMockClient({ navigateThrows: true });
    const report: CreepjsLiesReport = await probeCreepjs(client);
    expect(report).toHaveProperty("reachable");
    expect(report).toHaveProperty("fingerprintComputed");
    expect(report).toHaveProperty("totalLies");
    expect(report).toHaveProperty("liedModules");
    expect(report).toHaveProperty("navigatorLied");
    expect(report).toHaveProperty("screenLied");
    expect(report).toHaveProperty("canvasWebglLied");
    expect(report).toHaveProperty("canvas2dLied");
    expect(report).toHaveProperty("permissionsLied");
    expect(report).toHaveProperty("webglGetParameterLied");
    expect(report).toHaveProperty("creepjsVersion");
    expect(report).toHaveProperty("elapsedMs");
    expect(report).toHaveProperty("rawSample");
  });
});

// ============================================================
// probeCreepjs —— opts.timeoutMs
// ============================================================
describe("probeCreepjs —— opts.timeoutMs", () => {
  it("opts.timeoutMs 影响内部 wait_for timeout（取 timeoutMs/2，上限 15s）", async () => {
    const { client, calls } = makeMockClient({
      evalHandler: () => fullLiesPayload(),
    });
    await probeCreepjs(client, { timeoutMs: 10_000 });
    const waitCall = calls.find((c) => c.name === "wait_for");
    expect(waitCall!.args.timeout).toBe(5_000); // 10000 / 2
  });

  it("opts.timeoutMs 大时 wait timeout clamp 到 15s（默认上限）", async () => {
    const { client, calls } = makeMockClient({
      evalHandler: () => fullLiesPayload(),
    });
    await probeCreepjs(client, { timeoutMs: 60_000 });
    const waitCall = calls.find((c) => c.name === "wait_for");
    expect(waitCall!.args.timeout).toBe(15_000);
  });

  it("opts.timeoutMs 默认 30s → wait timeout 15s", async () => {
    const { client, calls } = makeMockClient({
      evalHandler: () => fullLiesPayload(),
    });
    await probeCreepjs(client);
    const waitCall = calls.find((c) => c.name === "wait_for");
    expect(waitCall!.args.timeout).toBe(15_000);
  });
});
