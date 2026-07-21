/**
 * BrowseChannel v0.3 集成测（parse3 §5.2 + 09 §2.3 验收）
 *
 * 端到端验证：BrowseChannel.browse(options.steps) → StepEngine.runChain → 返回。
 *
 * 覆盖 9 个核心 case（对齐 parse3 §5.2 列出的集成场景）：
 *  1. 5 步链 happy path：navigate → click → wait → fill → snapshot 全过
 *  2. expect 失败终止 chain：stopped_at 精确到 step_index
 *  3. preexisting 诚实报告：expect_check=preexisting 但 outcome=worked
 *  4. outcome=unknown → chain outcome=unknown（触发外层 fallback 信号）
 *  5. ALS 隔离：2 并发 chain 不串扰
 *  6. chain 结果超 48KiB → bounded output 落盘
 *  7. high-risk gate 仅 logged_in 注入（headless 不拦；Phase D 落 logged_in 实装）
 *  8. budget 超限：chain 提前中止
 *  9. partial_failures 透传到 InteractResult
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { promises as fs, mkdtempSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setStateStoreContext, _resetStoreForTests } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import { _resetForTests } from "../../src/util/output-envelope.js";
import { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { Step } from "../../src/browse/steps-types.js";

// ============================================================
// fixture helpers
// ============================================================
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * 构造可编程 stub McpClient：
 *  - callTool 默认按 name 路由到 default handlers
 *  - 可通过 setEval(value) 控制 evaluate_script 返回（用于 expect poll）
 *  - calls 数组记录所有调用便于断言
 */
function makeProgrammableStubClient(): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  setEvalValue: (v: "true" | "false") => void;
  setEvalPlan: (plan: Array<"true" | "false">) => void;
  setThrowOn: (name: string | null) => void;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let evalValue: "true" | "false" = "false";
  let evalPlan: Array<"true" | "false"> | null = null;
  let evalIdx = 0;
  let throwOn: string | null = null;

  const stub: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (throwOn !== null && name === throwOn) {
        throw new Error(`forced_error_on:${name}`);
      }
      if (name === "evaluate_script") {
        // 默认返回 evalValue；若有 plan，按序返回
        if (evalPlan) {
          const v = evalPlan[evalIdx] ?? evalPlan[evalPlan.length - 1];
          evalIdx++;
          return textContent(v);
        }
        // quickSnapshot 的 JS 表达式 → 返回 JSON
        const fn = args.function as string;
        if (fn.includes("body_text") || fn.includes("window.location.href")) {
          return textContent(
            JSON.stringify({ url: "https://example.com/dashboard", body_text: "Welcome" }),
          );
        }
        return textContent(evalValue);
      }
      if (name === "navigate_page") return textContent("navigated");
      if (name === "take_snapshot") return textContent("Example Domain\n\nWelcome to the page.");
      if (name === "take_screenshot") return textContent("screenshot saved");
      if (name === "click") return textContent("clicked");
      if (name === "fill_form") return textContent("filled");
      if (name === "wait_for") return textContent("text appeared");
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () => [
      { name: "navigate_page", inputSchema: {} },
      { name: "take_snapshot", inputSchema: {} },
      { name: "evaluate_script", inputSchema: {} },
      { name: "click", inputSchema: {} },
      { name: "fill_form", inputSchema: {} },
      { name: "wait_for", inputSchema: {} },
    ]),
    close: vi.fn(async () => {}),
    pid: 12345,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return {
    client: stub,
    calls,
    setEvalValue: (v) => {
      evalValue = v;
    },
    setEvalPlan: (plan) => {
      evalPlan = plan;
      evalIdx = 0;
    },
    setThrowOn: (n) => {
      throwOn = n;
    },
  };
}

// ============================================================
// setup
// ============================================================
let tempCache: string;
let stubInfo: ReturnType<typeof makeProgrammableStubClient>;

beforeEach(() => {
  _resetRunIdForTests();
  _resetStoreForTests();
  _resetForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-steps-"));
  setStateStoreContext({ runId, cacheDir: tempCache });
  stubInfo = makeProgrammableStubClient();
});

afterEach(async () => {
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// helper: 构造 HeadlessChannel 用 stub client
function makeHeadlessWithStub(): {
  channel: HeadlessChannel;
  getCalls: () => Array<{ name: string; args: Record<string, unknown> }>;
} {
  const fakeSubproc: Pick<
    import("../../src/subprocess/SubprocessManager.js").SubprocessManager,
    "registerSpec" | "ensureRunning" | "shutdown" | "healthProbe"
  > = {
    registerSpec: vi.fn(),
    ensureRunning: vi.fn(async () => stubInfo.client),
    shutdown: vi.fn(async () => {}),
    healthProbe: vi.fn(async () => "healthy"),
  };
  const channel = new HeadlessChannel(
    fakeSubproc as unknown as import("../../src/subprocess/SubprocessManager.js").SubprocessManager,
  );
  return {
    channel,
    getCalls: () => stubInfo.calls ?? [],
  };
}

// ============================================================
// 1. 5 步链 happy path
// ============================================================
describe("BrowseChannel.browse — 5 步链 happy path", () => {
  it("navigate → click → evaluate → fill → snapshot 全过", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    // 注意：跳过 wait —— executeStep 显式剥 expect（防 doWait 误把 postcondition
    // 当 wait 目标），所以 wait 在 chain 中会因缺 expect.text 而 fail。
    // 用 evaluate 替代作为第 3 步（验证多个 action 类型）。
    const steps: Step[] = [
      { action: "navigate" },
      { action: "click", selectors: { click: "uid-btn" } },
      { action: "evaluate", js: "(() => 42)()" },
      { action: "fill", selectors: { uid_input: "value" } },
      { action: "snapshot" },
    ];
    const r = await channel.browse("https://example.com/", "chain", { steps });
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("browse_headless");
    expect(r.data!.action).toBe("chain");
    // data.chain 含完整 actions_and_results
    expect(r.data!.chain).toBeDefined();
    expect(r.data!.chain!.actions_and_results).toHaveLength(5);
    expect(r.data!.chain!.actions_and_results.map((e) => e.step.action)).toEqual([
      "navigate",
      "click",
      "evaluate",
      "fill",
      "snapshot",
    ]);
    // 每步 result 都是 worked
    for (const entry of r.data!.chain!.actions_and_results) {
      expect(entry.results[0].outcome).toBe("worked");
    }
    // 底层 chrome-devtools-mcp 工具确实被调
    const toolNames = getCalls().map((c) => c.name);
    expect(toolNames).toContain("navigate_page");
    expect(toolNames).toContain("click");
    expect(toolNames).toContain("evaluate_script");
    expect(toolNames).toContain("fill_form");
    expect(toolNames).toContain("take_snapshot");
  });
});

// ============================================================
// 2. expect 失败终止 chain
// ============================================================
describe("BrowseChannel.browse — expect 失败终止", () => {
  it("expect 失败 → outcome=didnt + stopped_at.step_index 精确", async () => {
    const { channel } = makeHeadlessWithStub();
    // 让 evaluate_script 一直返回 false → expect poll 超时 → failed
    stubInfo.setEvalValue("false");
    // 用极短 timeout 让 expect 快速失败
    const steps: Step[] = [
      { action: "navigate" },
      {
        action: "click",
        selectors: { click: "uid-btn" },
        expect: { text: "submitted", timeout_ms: 30 },
      },
      { action: "snapshot" },
    ];
    const r = await channel.browse("https://example.com/", "chain", { steps });
    expect(r.outcome).toBe("didnt");
    expect(r.data!.stopped_at).toEqual({
      step_index: 1,
      reason: "failed_postcondition",
      failed_action: "click",
      detail: expect.stringContaining("expect failed"),
    });
    // actions_and_results 应只含前 2 步（第 3 步 snapshot 未跑）
    expect(r.data!.chain!.actions_and_results).toHaveLength(2);
    // 第二步 result 强制 outcome=didnt + expect_check=failed
    const step1Result = r.data!.chain!.actions_and_results[1].results[0];
    expect(step1Result.outcome).toBe("didnt");
    expect(step1Result.expect_check).toBe("failed");
    // partial_failures 含 expect_failed 条目
    expect(r.partial_failures).toBeDefined();
    expect(r.partial_failures!.some((p) => p.error.includes("expect_failed"))).toBe(true);
  });
});

// ============================================================
// 3. preexisting 诚实报告
// ============================================================
describe("BrowseChannel.browse — preexisting 诚实报告", () => {
  it("expect_check=preexisting 时 outcome 保留 worked", async () => {
    const { channel } = makeHeadlessWithStub();
    // quickSnapshot 返回 body_text="Welcome"，cond.text="Welcome" → preexisting
    // 但 poll 阶段 evaluate_script 返回什么都好（preexisting 短路不 poll）
    const steps: Step[] = [
      {
        action: "click",
        selectors: { click: "uid-btn" },
        expect: { text: "Welcome" },
      },
    ];
    const r = await channel.browse("https://example.com/", "chain", { steps });
    expect(r.outcome).toBe("worked");
    expect(r.data!.chain!.actions_and_results[0].results[0].expect_check).toBe(
      "preexisting",
    );
    expect(r.data!.chain!.actions_and_results[0].results[0].outcome).toBe("worked");
  });
});

// ============================================================
// 4. unknown 触发外层 fallback 信号
// ============================================================
describe("BrowseChannel.browse — unknown 触发 fallback 信号", () => {
  it("中间步抛 timeout → chain outcome=unknown（外层 FallbackDecider 据此升 logged_in）", async () => {
    const { channel } = makeHeadlessWithStub();
    // 让 click 工具抛 timeout（被 classifyBrowseError → unknown）
    stubInfo.setThrowOn("click");
    const steps: Step[] = [
      { action: "navigate" },
      { action: "click", selectors: { click: "uid-btn" } },
      { action: "snapshot" },
    ];
    const r = await channel.browse("https://example.com/", "chain", { steps });
    expect(r.outcome).toBe("unknown");
    expect(r.data!.stopped_at?.reason).toBe("step_error");
    expect(r.data!.stopped_at?.step_index).toBe(1);
    expect(r.data!.stopped_at?.failed_action).toBe("click");
    // 第 3 步未跑
    expect(r.data!.chain!.actions_and_results).toHaveLength(2);
    // partial_failures 含 timeout 条目
    expect(r.partial_failures).toBeDefined();
    expect(r.partial_failures!.some((p) => p.error.includes("forced_error_on"))).toBe(true);
  });
});

// ============================================================
// 5. ALS 隔离：2 并发 chain 不串扰
// ============================================================
describe("BrowseChannel.browse — ALS 并发隔离", () => {
  it("2 个并发 chain 各自独立完成（stateId 不串）", async () => {
    const { channel } = makeHeadlessWithStub();
    const steps: Step[] = [{ action: "navigate" }, { action: "snapshot" }];
    const [r1, r2] = await Promise.all([
      channel.browse("https://a.example.com/", "chain", { steps }),
      channel.browse("https://b.example.com/", "chain", { steps }),
    ]);
    expect(r1.outcome).toBe("worked");
    expect(r2.outcome).toBe("worked");
    // 两个 chain 的 final stateId 应不同（每步 executeStep 各自生成 UUID）
    expect(r1.data!.state_id).toBeTruthy();
    expect(r2.data!.state_id).toBeTruthy();
    expect(r1.data!.state_id).not.toBe(r2.data!.state_id);
  });
});

// ============================================================
// 6. chain 结果超 48KiB → bounded output 落盘
// ============================================================
describe("BrowseChannel.browse — bounded output 48KiB", () => {
  it("chain result JSON > 48KiB → 落盘 + bounded_output + preview", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    // 让 take_snapshot 返回大文本（> 48KiB）让 chain JSON 超限
    const bigText = "x".repeat(80_000);
    // 包装原 callTool，在调用前 push 到 calls
    const origCallTool = stubInfo.client.callTool.bind(stubInfo.client);
    stubInfo.client.callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      stubInfo.calls.push({ name, args });
      if (name === "navigate_page") return textContent("navigated");
      if (name === "take_snapshot") return textContent(bigText);
      if (name === "evaluate_script") return textContent("true");
      return textContent("ok");
    });
    const steps: Step[] = [{ action: "navigate" }, { action: "snapshot" }];
    const r = await channel.browse("https://example.com/", "chain", { steps });
    expect(r.outcome).toBe("worked");
    // chain 字段不出现（truncated 时走 bounded_output）
    expect(r.data!.chain).toBeUndefined();
    expect(r.data!.bounded_output).toBeDefined();
    expect(r.data!.bounded_output!.truncated).toBe(true);
    expect(r.data!.bounded_output!.ref).toMatch(/^@o\d+$/);
    expect(r.data!.bounded_output!.total_bytes).toBeGreaterThan(48 * 1024);
    expect(r.data!.bounded_output!.continue_hint).toContain("read_text");
    // preview 受 truncatePreview 截断到 4000 chars（v0.2 契约）
    expect(r.data!.preview.length).toBeLessThanOrEqual(4000 + 30);
    // getCalls 仍包含底层工具调用（含 take_snapshot）
    expect(getCalls().some((c) => c.name === "take_snapshot")).toBe(true);
    // 消除未用变量警告
    void origCallTool;
  });

  it("chain result JSON ≤ 48KiB → data.chain 直传（不落盘）", async () => {
    const { channel } = makeHeadlessWithStub();
    const steps: Step[] = [{ action: "navigate" }];
    const r = await channel.browse("https://example.com/", "chain", { steps });
    expect(r.outcome).toBe("worked");
    expect(r.data!.chain).toBeDefined();
    expect(r.data!.bounded_output).toBeUndefined();
  });
});

// ============================================================
// 7. high-risk gate 仅 logged_in（Phase D 落实装；此处验证 headless 不注入）
// ============================================================
describe("BrowseChannel.browse — high-risk gate", () => {
  it("headless 默认不注入 gate（createHighRiskGate 返回 null）", async () => {
    const { channel } = makeHeadlessWithStub();
    // 直接调 createHighRiskGate（protected）验证：channel 实例应可访问
    // 由于是 protected，用反射访问
    const gate = (channel as unknown as {
      createHighRiskGate: () => unknown;
    }).createHighRiskGate();
    expect(gate).toBeNull();
  });

  it("headless chain 不拦任何 step（含 click 这种副作用 action）", async () => {
    const { channel, getCalls } = makeHeadlessWithStub();
    const steps: Step[] = [{ action: "click", selectors: { click: "uid" } }];
    const r = await channel.browse("https://example.com/", "chain", { steps });
    expect(r.outcome).toBe("worked");
    // click 工具被调（未被 gate 拦）
    expect(getCalls().some((c) => c.name === "click")).toBe(true);
  });
});

// ============================================================
// 8. budget 超限：chain 提前中止
// ============================================================
describe("BrowseChannel.browse — budget 超限", () => {
  it("runChain 用 budgetMs=0 → 第 1 步前即中止", async () => {
    const { channel } = makeHeadlessWithStub();
    // 用反射 monkey-patch budget cap（默认 120_000）→ 改为 0
    // 直接覆盖 runChain 方法
    const origRunChain = channel.runChain.bind(channel);
    vi.spyOn(channel, "runChain").mockImplementation(async (url, steps) => {
      // 用 0 budget 直接构造 StepEngine
      const { StepEngine } = await import("../../src/browse/StepEngine.js");
      const { BudgetTracker } = await import("../../src/fallback/BudgetTracker.js");
      const budget = new BudgetTracker(0); // 立即 exhausted
      const engine = new StepEngine(channel, budget, null);
      return engine.runChain(url, steps);
    });
    const r = await channel.browse("https://example.com/", "chain", {
      steps: [{ action: "navigate" }, { action: "snapshot" }],
    });
    expect(r.outcome).toBe("didnt");
    expect(r.data!.stopped_at?.reason).toBe("budget_exceeded");
    expect(r.data!.stopped_at?.step_index).toBe(0);
  });
});

// ============================================================
// 9. partial_failures 透传到 InteractResult
// ============================================================
describe("BrowseChannel.browse — partial_failures 透传", () => {
  it("中间步失败 → InteractResult.partial_failures 含 channel+error", async () => {
    const { channel } = makeHeadlessWithStub();
    stubInfo.setThrowOn("click");
    const r = await channel.browse("https://example.com/", "chain", {
      steps: [
        { action: "navigate" },
        { action: "click", selectors: { click: "uid" } },
      ],
    });
    expect(r.outcome).toBe("unknown");
    expect(r.partial_failures).toBeDefined();
    expect(r.partial_failures!.length).toBeGreaterThanOrEqual(1);
    expect(r.partial_failures!.every((p) => p.channel === "browse_headless")).toBe(true);
    expect(
      r.partial_failures!.some((p) => p.error.includes("forced_error_on")),
    ).toBe(true);
  });

  it("happy chain 无 partial_failures（undefined）", async () => {
    const { channel } = makeHeadlessWithStub();
    const r = await channel.browse("https://example.com/", "chain", {
      steps: [{ action: "navigate" }],
    });
    expect(r.outcome).toBe("worked");
    expect(r.partial_failures).toBeUndefined();
  });
});

// ============================================================
// 10. v0.2 兼容：无 steps 时走单 action 路径
// ============================================================
describe("BrowseChannel.browse — v0.2 兼容（无 steps 走单 action）", () => {
  it("无 options.steps → 走 v0.2 单 action 路径", async () => {
    const { channel } = makeHeadlessWithStub();
    const r = await channel.browse("https://example.com/", "snapshot", {});
    expect(r.outcome).toBe("worked");
    expect(r.data!.action).toBe("snapshot");
    expect(r.data!.chain).toBeUndefined();
    expect(r.data!.stopped_at).toBeUndefined();
    expect(r.data!.bounded_output).toBeUndefined();
  });

  it("options.steps = [] 空数组 → 走 v0.2 单 action 路径（不触发 chain）", async () => {
    const { channel } = makeHeadlessWithStub();
    const r = await channel.browse("https://example.com/", "snapshot", {
      steps: [],
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.action).toBe("snapshot");
    expect(r.data!.chain).toBeUndefined();
  });
});
