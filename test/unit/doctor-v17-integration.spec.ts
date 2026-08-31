/**
 * doctor v1.7 集成测（parse15 §5.2 —— v1.7 Phase B 补）
 *
 * parse15 §5.2 要求的集成测用例（parse15 §5.1 creepjs-probe 单测已在 creepjs-probe.spec.ts）：
 *  - runDoctor 默认（stealthCheck 不传）→ #38 warn-skip
 *  - runDoctor stealthCheck=true 无 provider → #38 warn
 *  - runDoctor stealthCheck=true + provider mock → #38 实跑（baseline 比对）
 *  - runDoctor 含 #39（默认跑，不需 flag）
 *  - 全 check 数 = v1.6 的 37 + 2 = 39
 *
 * 额外覆盖（03 §2.1 项4 mutation testing on diff —— totalLies 比对 `>` mutant）：
 *  - baseline pending freeze → warn（不 fail）
 *  - totalLies 退化（> baseline）→ fail（killer: `>`→`>=` mutant 被 "持平 pass" 用例杀死）
 *  - totalLies 持平 → pass
 *  - totalLies 改善（< baseline）→ pass
 *  - fingerprintComputed=false → warn（非 Lasso 回归）
 *  - skipNetwork=true → warn-skip
 *
 * #39 stagehand_rest_contract_probe 覆盖（mock global.fetch）：
 *  - skipNetwork=true → warn-skip
 *  - 404 → warn + detail 含 R-ECO-6
 *  - 2xx → pass
 *  - 网络错 → warn
 *
 * 测试策略（03 §2.1 项8 doubles 政策：FAKES over MOCKS）：
 *  - #38 的 McpClient 用 fake 实现（callTool 按 name 路由），不用 mock 库交互验证
 *  - #39 用 vi.stubGlobal("fetch", ...) fake fetch 响应
 *  - skipNetwork=false 时 mock global.fetch 返 200 防其他 check 超时（不动被测逻辑）
 *
 * 关键铁律：
 *  - 被测对象是 checkStealthCreepjsRegression / checkStagehandRestContract 的判定逻辑，
 *    不是 probeCreepjs（后者已在 creepjs-probe.spec.ts 覆盖）
 *  - baseline 用临时文件（stealthCheckBaselinePath 注入），不碰真实 fixture
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runDoctor,
  LASSO_VERSION,
  type DoctorReport,
} from "../../src/doctor/doctor.js";
import {
  CREEPJS_LIES_EXTRACT_SCRIPT,
  type CreepjsLiesReport,
} from "../../src/doctor/creepjs-probe.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

// ============================================================
// helpers
// ============================================================

/** 从 report 中找指定 check（找不到 → throw） */
function findCheck(report: DoctorReport, name: string) {
  const c = report.checks.find((c) => c.name === name);
  if (!c) throw new Error(`check ${name} not in report (has: ${report.checks.map((c) => c.name).join(", ")})`);
  return c;
}

/**
 * 构造 fake McpClient（parse15 §3.3 #38 check 实跑路径用）。
 *
 * callTool 路由：
 *  - evaluate_script: 若 function 是 CREEPJS_LIES_EXTRACT_SCRIPT → 返 liesData；否则返 ok（injectProfile 调用）
 *  - navigate_page / wait_for: 返 ok
 *  - 其他: 返 ok
 */
function makeFakeClient(liesData: {
  fingerprintComputed: boolean;
  totalLies?: number;
  liedModules?: string[];
  navigatorLied?: boolean;
  screenLied?: boolean;
  canvasWebglLied?: boolean;
  canvas2dLied?: boolean;
  permissionsLied?: boolean;
  creepjsVersion?: string;
}): McpClient {
  const client = {
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: string; text: string }> }> {
      if (name === "evaluate_script") {
        // 区分 injectProfile 的 evaluate vs probeCreepjs 的 evaluate
        if (args.function === CREEPJS_LIES_EXTRACT_SCRIPT) {
          return {
            content: [{ type: "text", text: JSON.stringify(liesData) }],
          };
        }
        // injectProfile 的 UA override / STEALTH_INJECTION_SCRIPT → 返 ok
        return { content: [{ type: "text", text: "ok" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  return client as unknown as McpClient;
}

/**
 * 构造一个已 freeze 的 baseline JSON（写入临时文件用）。
 * frozenAt 非 null + totalLies 非 null → #38 走实际比对逻辑。
 */
function frozenBaseline(opts: {
  totalLies: number;
  navigatorLied?: boolean;
  liedModules?: string[];
}): string {
  return JSON.stringify({
    _doc: "test frozen baseline",
    frozenAt: "2026-08-10T00:00:00.000Z",
    lassoVersion: "1.12.0",
    creepjsPageSha: "test-sha",
    profile: "windows_chrome_120",
    baseline: {
      totalLies: opts.totalLies,
      navigatorLied: opts.navigatorLied ?? true,
      screenLied: false,
      canvasWebglLied: false,
      liedModules: opts.liedModules ?? ["navigator"],
    },
    tolerance: { totalLiesDelta: 0 },
    rationale: "test",
  });
}

/** 未 freeze 的 baseline（frozenAt=null, totalLies=null）—— 同真实 fixture 形态 */
const PENDING_BASELINE = JSON.stringify({
  _doc: "test pending baseline",
  frozenAt: null,
  lassoVersion: "1.12.0",
  creepjsPageSha: null,
  profile: "windows_chrome_120",
  baseline: {
    totalLies: null,
    navigatorLied: null,
    screenLied: null,
    canvasWebglLied: null,
    liedModules: [],
  },
  tolerance: { totalLiesDelta: 0 },
  rationale: "test pending",
});

// ============================================================
// test setup
// ============================================================
let tempDir: string;
let savedFetch: typeof global.fetch;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-v17-"));
  // 保存原始 fetch（部分用例需 stubGlobal mock #39 和其他网络 check）
  savedFetch = global.fetch;
});

afterEach(async () => {
  // 还原 fetch（防 leak 到其他用例）
  global.fetch = savedFetch;
  vi.unstubAllGlobals();
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/**
 * Stub fetch → 返固定 Response（skipNetwork=false 时防其他 check 触真网）。
 * 默认返 200 空体（让 steel_endpoint 等 check 不超时）。
 */
function stubFetchOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response("ok", { status: 200, statusText: "OK" }),
    ),
  );
}

/** Stub fetch 返指定 status */
function stubFetchStatus(status: number, statusText: string = "") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status, statusText })),
  );
}

/** Stub fetch 抛错（模拟网络不可达） */
function stubFetchThrow() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("mock_network_unreachable");
    }),
  );
}

// ============================================================
// #38 stealth_creepjs_regression —— runDoctor 编排层
// ============================================================
describe("runDoctor #38 stealth_creepjs_regression —— 默认 + skip 路径", () => {
  it("默认（stealthCheck 不传）→ warn-skip（零回归：不开浏览器）", async () => {
    const r = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/stealthCheck=false/);
  });

  it("stealthCheck=true 但无 clientProvider → warn", async () => {
    const r = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
      stealthCheck: true,
      // stealthCheckClientProvider 不传
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/clientProvider/i);
  });

  it("stealthCheck=true + provider + skipNetwork=true → warn-skip（probe 需触网）", async () => {
    const r = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
      stealthCheck: true,
      stealthCheckClientProvider: async () => null,
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/skipNetwork/);
  });
});

// ============================================================
// #38 stealth_creepjs_regression —— baseline 比对逻辑（核心回归门禁语义）
// ============================================================
//
// mutation testing（03 §2.1 项4）：
//  totalLies 比对代码 `report.totalLies > baselineTotalLies + tolerance`（doctor.ts）
//  注入 `>`→`>=` mutant → "持平 pass" 用例（totalLies === baseline）会变 fail → killer 命中
//
// timeout 45s（doc/governance/10 审查官补）：runDoctor 是 spawn-heavy 用例，全量并发收集时
// 偶发超默认 15s（隔离 3/3 绿 1.4s 级——CPU 争抢非代码回归）；放组级预算保终跑确定性。
describe("runDoctor #38 —— baseline 比对逻辑（parse15 §5.2 + §6.2 §2.1 项4 mutation）", { timeout: 45_000 }, () => {
  it("baseline pending freeze（frozenAt=null）→ warn-skip（不 fail）", async () => {
    const baselinePath = path.join(tempDir, "pending-baseline.json");
    await fs.writeFile(baselinePath, PENDING_BASELINE);

    const fakeClient = makeFakeClient({
      fingerprintComputed: true,
      totalLies: 15,
      navigatorLied: true,
      liedModules: ["navigator"],
    });

    stubFetchOk(); // 防 #39 + 其他 check 触网
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
      stealthCheck: true,
      stealthCheckClientProvider: async () => fakeClient,
      stealthCheckBaselinePath: baselinePath,
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/未 freeze|pending/i);
    // detail 含实跑数值（首次 freeze 用）
    expect(c.detail).toMatch(/totalLies=15/);
  });

  it("totalLies 退化（report > baseline）→ **fail**（核心回归门禁语义）", async () => {
    const baselinePath = path.join(tempDir, "frozen-baseline.json");
    await fs.writeFile(baselinePath, frozenBaseline({ totalLies: 10 }));

    const fakeClient = makeFakeClient({
      fingerprintComputed: true,
      totalLies: 12, // 12 > 10 + 0 → 退化
      navigatorLied: true,
      liedModules: ["navigator"],
    });

    stubFetchOk();
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
      stealthCheck: true,
      stealthCheckClientProvider: async () => fakeClient,
      stealthCheckBaselinePath: baselinePath,
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/退化|regression/i);
    expect(c.detail).toMatch(/totalLies=12.*baseline 10/);
  });

  it("totalLies 持平（report === baseline）→ **pass**（mutation killer：`>`→`>=` mutant 会让此用例 fail）", async () => {
    const baselinePath = path.join(tempDir, "frozen-baseline.json");
    await fs.writeFile(baselinePath, frozenBaseline({ totalLies: 10 }));

    const fakeClient = makeFakeClient({
      fingerprintComputed: true,
      totalLies: 10, // 10 === 10 → 持平
      navigatorLied: true,
      liedModules: ["navigator"],
    });

    stubFetchOk();
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
      stealthCheck: true,
      stealthCheckClientProvider: async () => fakeClient,
      stealthCheckBaselinePath: baselinePath,
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("pass");
    expect(c.detail).toMatch(/持平|改善/);
  });

  it("totalLies 改善（report < baseline）→ pass", async () => {
    const baselinePath = path.join(tempDir, "frozen-baseline.json");
    await fs.writeFile(baselinePath, frozenBaseline({ totalLies: 15 }));

    const fakeClient = makeFakeClient({
      fingerprintComputed: true,
      totalLies: 8, // 8 < 15 → 改善
      navigatorLied: true,
      liedModules: ["navigator"],
    });

    stubFetchOk();
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
      stealthCheck: true,
      stealthCheckClientProvider: async () => fakeClient,
      stealthCheckBaselinePath: baselinePath,
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("pass");
  });

  it("fingerprintComputed=false（creepjs 未跑完）→ warn（非 Lasso 回归）", async () => {
    const baselinePath = path.join(tempDir, "frozen-baseline.json");
    await fs.writeFile(baselinePath, frozenBaseline({ totalLies: 10 }));

    const fakeClient = makeFakeClient({
      fingerprintComputed: false, // creepjs 页面未跑完
    });

    stubFetchOk();
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
      stealthCheck: true,
      stealthCheckClientProvider: async () => fakeClient,
      stealthCheckBaselinePath: baselinePath,
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/fingerprintComputed=false/);
  });

  it("clientProvider 返 null（9222 未开）→ warn", async () => {
    stubFetchOk();
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
      stealthCheck: true,
      stealthCheckClientProvider: async () => null, // 9222 未开
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/null|9222/);
  });

  it("baseline 文件不存在 → warn（不崩）", async () => {
    const fakeClient = makeFakeClient({
      fingerprintComputed: true,
      totalLies: 10,
    });

    stubFetchOk();
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
      stealthCheck: true,
      stealthCheckClientProvider: async () => fakeClient,
      stealthCheckBaselinePath: path.join(tempDir, "nonexistent.json"),
    });
    const c = findCheck(r, "stealth_creepjs_regression");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/baseline.*失败|读取失败/);
  });
});

// ============================================================
// #39 stagehand_rest_contract_probe —— HEAD 探测逻辑（mock fetch）
// ============================================================
describe("runDoctor #39 stagehand_rest_contract_probe —— HEAD 探测（mock fetch）", () => {
  it("skipNetwork=true → warn-skip", async () => {
    const r = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
    });
    const c = findCheck(r, "stagehand_rest_contract_probe");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/skipNetwork/);
  });

  it("fetch 返 404 → warn + detail 含 R-ECO-6（契约虚构确认）", async () => {
    stubFetchStatus(404, "Not Found");
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
    });
    const c = findCheck(r, "stagehand_rest_contract_probe");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/404/);
    expect(c.detail).toMatch(/R-ECO-6/);
  });

  it("fetch 返 2xx → pass（契约存在；R-ECO-6 反驳）", async () => {
    stubFetchStatus(200, "OK");
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
    });
    const c = findCheck(r, "stagehand_rest_contract_probe");
    expect(c.status).toBe("pass");
    expect(c.detail).toMatch(/200/);
  });

  it("fetch 抛网络错 → warn（按 R-ECO-6 不存在处理）", async () => {
    stubFetchThrow();
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
    });
    const c = findCheck(r, "stagehand_rest_contract_probe");
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/探测失败|R-ECO-6/);
  });

  it("#39 永不 fail（404 / 网络错都 warn 不是 fail）", async () => {
    // 这是 parse15 §3.4 "永不 fail" 范式验证
    stubFetchStatus(404);
    const r = await runDoctor({
      skipNetwork: false,
      skipInvariants: true,
    });
    const c = findCheck(r, "stagehand_rest_contract_probe");
    expect(c.status).not.toBe("fail");
  });
});

// ============================================================
// runDoctor —— check 数 + version 对齐（parse15 §5.2）
// ============================================================
describe("runDoctor —— v1.7 结构对齐（parse15 §5.2）", () => {
  it("checks 含 stealth_creepjs_regression + stagehand_rest_contract_probe（#38/#39 存在）", async () => {
    const r = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
    });
    const names = r.checks.map((c) => c.name);
    expect(names).toContain("stealth_creepjs_regression");
    expect(names).toContain("stagehand_rest_contract_probe");
  });

  it("lasso_version === 1.18.3（INV-63 三处对齐验证：doctor.ts 侧）", async () => {
    const r = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
    });
    expect(r.lasso_version).toBe("1.18.7");
    expect(LASSO_VERSION).toBe("1.18.7");
  });

  it("skipNetwork=true 时 #38 和 #39 均 warn-skip（零回归：不触网）", async () => {
    const r = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
      stealthCheck: true,
      stealthCheckClientProvider: async () => null,
    });
    const c38 = findCheck(r, "stealth_creepjs_regression");
    const c39 = findCheck(r, "stagehand_rest_contract_probe");
    expect(c38.status).toBe("warn");
    expect(c39.status).toBe("warn");
  });
});
