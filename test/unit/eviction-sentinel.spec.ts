/**
 * eviction-sentinel.spec.ts（尾款轮 A.5r2，doc/bugs/09 §8.A，2026-09-16）
 *
 * 驱逐哨兵十单测（决议 A.5r2-4 清单：原六 + r3 新四）：
 *  1. 同 host 路径/hash 不标（S1 + S2 两形态）
 *  2. 异 host 必标（S1 窗 + S2 附本次返回两形态）
 *  3. 消费即清（次调用不再附）
 *  4. actSeq 变化放弃（归因守卫）
 *  5. respawn 丢弃（消费侧 client 不匹配）
 *  6. S3 合取缺一不触发（错误串在而 host 未偏 ⇒ 维持 eval_upstream_error 原形态）
 *     + S3 合取全过 ⇒ typed error + hint + didnt
 *  7. 楔死自愈重试路不标（healed client 首读 about:blank——G-placeholder）
 *  8. respawn 后首调用不标（G-client）
 *  9. same-URL 确证分支不标且 settle 刷新（「agent 跟随自己 click 到达的页」形态）
 * 10. hint 双形态文案断言（基类 suspected+双假设+ask-user；headed 变体无升级指令）
 *
 * 另：链返回附着（消费点 ③）。
 *
 * 全 mock McpClient（bug09-b spec 同范式）——零真浏览器。vi.useFakeTimers
 * 驱动 5s 静默窗。L3 真机（tm.aliyun.com headless 信号复现）是验收面，不在本 spec。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BrowseChannel,
  EVICTION_WINDOW_MS,
} from "../../src/channels/BrowseChannel.js";
import { HeadedChannel } from "../../src/channels/HeadedChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { SpawnSpec } from "../../src/subprocess/SubprocessManager.js";

// ============================================================
// helpers（bug09-b-url-semantics.spec.ts 同范式）
// ============================================================
function fencedEval(value: string) {
  return { content: [{ type: "text", text: "```\n" + value + "\n```" }], isError: false };
}
function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}
function errContent(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

type Handler = (n: number, args: Record<string, unknown>) => unknown;

const TOOLS_170 = [
  "navigate_page",
  "take_snapshot",
  "take_screenshot",
  "evaluate_script",
  "wait_for",
  "click",
  "fill_form",
  "list_pages",
  "select_page",
  "list_network_requests",
  "list_console_messages",
  "pdf",
];

/**
 * 可编程 client：handlers 按 tool 名分发（n = 该 tool 第几次调用）。
 * evaluate_script 未提供时默认返回 fenced "about:blank"。
 */
function makeClient(handlers: Record<string, Handler> = {}) {
  const counts = new Map<string, number>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const h = handlers[name];
      if (h) return h(n, args) as never;
      if (name === "evaluate_script") {
        return fencedEval(JSON.stringify("about:blank")) as never;
      }
      return textContent(`stubbed ${name}`) as never;
    }),
    listTools: vi.fn(async () => TOOLS_170.map((t) => ({ name: t, inputSchema: {} }))),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client, calls };
}

/** 按调用序回放 fenced JSON 值的 evaluate_script handler。 */
function evalSeq(values: unknown[]) {
  return (n: number) =>
    fencedEval(JSON.stringify(values[n - 1] ?? "about:blank"));
}

/** client 可热换的测试通道（respawn 形态用）+ 楔死自愈层 1（同 client 换新空白页）。 */
class MutableClientChannel extends BrowseChannel {
  readonly name = "browse_test_eviction";
  constructor(readonly holder: { c: McpClient }) {
    super();
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.holder.c);
  }
  protected override async healUpstreamWedge(c: McpClient): Promise<McpClient | null> {
    return c;
  }
}

let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-evict-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
});

/** 会话建立器：真实 navigate(X)（走 dispatch → wrapNavigate settle 写点）。 */
async function warmSession(ch: MutableClientChannel, url: string): Promise<void> {
  const r = await ch.browse(url, "navigate", {});
  expect(r.outcome).toBe("worked");
}

function hintOf(ch: MutableClientChannel): string {
  return (ch as unknown as { evictionHint(): string }).evictionHint();
}

// ============================================================
// 1. 同 host 路径/hash 不标（host 级判等——S1 与 S2 两形态）
// ============================================================
describe("驱逐哨兵 — host 级判等（同 host 不标）", () => {
  it("S1：settled a.com，窗到点观测同 host 异路径+hash ⇒ 不标（路径/hash 跳转非驱逐）", async () => {
    vi.useFakeTimers();
    const { client } = makeClient({
      // ev#1 warm pre-read / #2 verify status / #3 S1 sample / #4 后续 evaluate
      evaluate_script: evalSeq(["about:blank", 0, "https://a.com/other/path#q=1", 42]),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/");
    await vi.advanceTimersByTimeAsync(EVICTION_WINDOW_MS);
    const r = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("42");
    expect(r.data!.eviction_suspected).toBeUndefined();
    expect(r.hint).toBeUndefined();
  });

  it("S2：门读观测同 host 异路径（url 亦异 ⇒ 走先导导航分支）⇒ host 相等不标", async () => {
    const { client, calls } = makeClient({
      // ev#1 warm pre-read / #2 verify status / #3 S2 门读 / #4 nav pre-read / #5 verify status / #6 执行体
      evaluate_script: evalSeq(["about:blank", 0, "https://a.com/old", "https://a.com/old", 0, 42]),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/");
    const r = await ch.browse("https://a.com/x", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(r.data!.did_navigate).toBe(true); // url ≠ 当前页 → 确实导航了
    expect(calls.filter((c) => c.name === "navigate_page")).toHaveLength(2); // warm + 先导
    expect(r.data!.eviction_suspected).toBeUndefined();
  });
});

// ============================================================
// 2/3. 异 host 必标 + 消费即清
// ============================================================
describe("驱逐哨兵 — 异 host 必标（三硬守卫全过后）", () => {
  it("S1：settled a.com，窗到点观测 b.com ⇒ 标记；下一调用返回体附 eviction_suspected + hint（consent 指令）", async () => {
    vi.useFakeTimers();
    const { client } = makeClient({
      evaluate_script: evalSeq(["about:blank", 0, "https://b.com/landing", 42, 7]),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/");
    await vi.advanceTimersByTimeAsync(EVICTION_WINDOW_MS);
    const r = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(r.data!.eviction_suspected).toEqual({
      from: "https://a.com/",
      to: "https://b.com/landing",
      at_ms: expect.any(Number),
    });
    expect(r.hint).toContain("ASK THE USER FIRST");
    expect(r.hint).toContain("browse_headed");
    expect(r.hint).toContain("suspected eviction OR unattributed cross-host move");
    expect(r.data!.did_navigate).toBe(false);
  });

  it("消费即清：同一信号只附一次（下一返回不再带）", async () => {
    vi.useFakeTimers();
    const { client } = makeClient({
      evaluate_script: evalSeq(["about:blank", 0, "https://b.com/landing", 42, 7]),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/");
    await vi.advanceTimersByTimeAsync(EVICTION_WINDOW_MS);
    const r1 = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(r1.data!.eviction_suspected).toBeDefined();
    const r2 = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(r2.outcome).toBe("worked");
    expect(r2.data!.preview).toBe("7");
    expect(r2.data!.eviction_suspected).toBeUndefined();
    expect(r2.hint).toBeUndefined();
  });

  it("S2 附本次返回：门读观测 b.com 漂移 ⇒ mark 即刻附着在本调用返回体（不等下一调用）", async () => {
    const { client } = makeClient({
      // ev#1/#2 warm；#3 门读（漂移观测）；#4 nav pre-read；#5 verify status；#6 执行体
      evaluate_script: evalSeq(["about:blank", 0, "https://b.com/landing", "https://b.com/landing", 0, 42]),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/");
    const r = await ch.browse("https://a.com/x", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(r.data!.did_navigate).toBe(true);
    expect(r.data!.eviction_suspected).toEqual({
      from: "https://a.com/",
      to: "https://b.com/landing",
      at_ms: expect.any(Number),
    });
    expect(r.hint).toBeTruthy();
  });
});

// ============================================================
// 4. actSeq 变化放弃（归因守卫——读后复检）
// ============================================================
describe("驱逐哨兵 — 归因守卫（actSeq）", () => {
  it("窗起点后新 browse 调用入场（bump actSeq）⇒ 窗到点读后复检不等 ⇒ 静默放弃", async () => {
    vi.useFakeTimers();
    const { client } = makeClient({
      evaluate_script: evalSeq(["about:blank", 0, 1, "https://b.com/", 2]),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/"); // 窗 armed（seq=1）
    // 新调用入场（current-page evaluate 不触门不重起窗，但入口 bump actSeq → 2）
    const mid = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(mid.data!.preview).toBe("1");
    await vi.advanceTimersByTimeAsync(EVICTION_WINDOW_MS); // 读到 b.com 漂移，但 seq 已变
    const r = await ch.browse(undefined, "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(r.data!.eviction_suspected).toBeUndefined();
  });
});

// ============================================================
// 5/8. respawn（换 client）两形态：消费侧丢弃 + 检测侧 G-client
// ============================================================
describe("驱逐哨兵 — respawn 边（client 身份）", () => {
  it("消费侧：S1 标记在旧 client 上，respawn 后下一调用（新 client）⇒ 丢弃不附（陈旧驱逐不污染新会话）", async () => {
    vi.useFakeTimers();
    const clientA = makeClient({
      evaluate_script: evalSeq(["about:blank", 0, "https://b.com/"]),
    }).client;
    const clientB = makeClient({
      // B 的调用序：#1 门读 / #2 nav pre-read / #3 verify status / #4 执行体
      evaluate_script: evalSeq(["https://b.com/landing", "https://b.com/landing", 0, 42]),
    }).client;
    const holder = { c: clientA };
    const ch = new MutableClientChannel(holder);
    await warmSession(ch, "https://a.com/"); // settle {a.com, A}
    await vi.advanceTimersByTimeAsync(EVICTION_WINDOW_MS); // S1 在 A 上读到 b.com ⇒ mark{client A}
    holder.c = clientB; // respawn：新 McpClient 实例
    const r = await ch.browse("https://a.com/x", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(r.data!.eviction_suspected).toBeUndefined(); // client 不匹配 ⇒ 丢弃
    expect(r.hint).toBeUndefined();
  });

  it("检测侧（G-client）：旧 settle 在 A 上，respawn 后首调用（B）门读观测异 host ⇒ 不标（旧基线对新会话无意义）", async () => {
    const clientA = makeClient().client;
    const clientB = makeClient({
      // #1 门读（观测 b.com ≠ settle host a.com——无 G-client 即假信号）/ #2 nav pre / #3 status / #4 执行
      evaluate_script: evalSeq(["https://b.com/landing", "https://b.com/landing", 0, 42]),
    }).client;
    const holder = { c: clientA };
    const ch = new MutableClientChannel(holder);
    await warmSession(ch, "https://a.com/"); // settle {a.com, clientA}
    holder.c = clientB;
    const r = await ch.browse("https://a.com/x", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked");
    expect(r.data!.eviction_suspected).toBeUndefined(); // G-client 先于判等
  });
});

// ============================================================
// 6. S3 错误串合取
// ============================================================
describe("驱逐哨兵 — S3 错误串合取（Execution context was destroyed ∧ host 偏离）", () => {
  const evIsError = (n: number) => {
    // #1 warm pre / #2 status / #3 门读（same-URL ⇒ 零导航）/ #4 执行体（isError！）
    if (n === 4) {
      return errContent("Execution context was destroyed: the page navigated");
    }
    return evalSeq(["about:blank", 0, "https://a.com/x"])(n);
  };

  it("合取缺一（host 未偏）：错误维持 eval_upstream_error 原形态，不重写、无 hint", async () => {
    const { client } = makeClient({
      evaluate_script: (n) =>
        // #5 = S3 确认读：同 host 异路径 ⇒ 合取缺一
        n === 5 ? fencedEval(JSON.stringify("https://a.com/y")) : evIsError(n),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/");
    const r = await ch.browse("https://a.com/x", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("eval_upstream_error:");
    expect(r.error).toContain("Execution context was destroyed");
    expect(r.error).not.toContain("page_redirect_eviction_suspected");
    expect(r.hint).toBeUndefined();
  });

  it("合取全过（host 偏离）：typed error 重写 + hint（consent 指令）+ outcome=didnt（F5 自持规则）", async () => {
    const { client } = makeClient({
      evaluate_script: (n) =>
        n === 5 ? fencedEval(JSON.stringify("https://b.com/after")) : evIsError(n),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/");
    const r = await ch.browse("https://a.com/x", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("didnt"); // 确定性站点条件：不盲重试不进 fallback churn
    expect(r.error).toMatch(/^page_redirect_eviction_suspected:/);
    expect(r.error).toContain("eval_upstream_error"); // 原文（含前缀形态）截断保留
    expect(r.hint).toContain("ASK THE USER FIRST");
  });
});

// ============================================================
// 7. 楔死自愈重试路不标（G-placeholder——healed client 首读 about:blank）
// ============================================================
describe("驱逐哨兵 — G-placeholder（占位页非驱逐证据）", () => {
  it("楔死自愈（层 1 同 client 换新空白页）重试的门读 about:blank ⇒ 不标（无 G-placeholder 即假信号形态）", async () => {
    const { client, calls } = makeClient({
      navigate_page: (n) => {
        // 首次 navigate_page 抛楔死签名；heal 后重试成功
        if (n === 1) throw new Error("The selected page has been closed. Call list_pages to see open pages.");
        return textContent("stubbed navigate_page");
      },
      evaluate_script: evalSeq([
        "about:blank", // #1 warm pre-read
        0, // #2 warm verify status
        "https://a.com/old", // #3 第一次尝试门读（同 host 旧路径——host 相等本来就不标）
        "https://a.com/old", // #4 第一次尝试 nav pre-read（随后 navigate_page 抛楔死）
        "about:blank", // #5 heal 重试门读 ←—— G-placeholder 在此消灭假信号
        "about:blank", // #6 重试 nav pre-read
        0, // #7 重试 verify status
        42, // #8 执行体
      ]),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/"); // settle {a.com}
    const r = await ch.browse("https://a.com/x", "evaluate", { js: "() => 1" });
    expect(r.outcome).toBe("worked"); // heal + 重试成功
    expect(calls.filter((c) => c.name === "navigate_page")).toHaveLength(3); // warm + 楔死 + 重试
    // 核心：about:blank 观测未被当成「host 漂移」——若 G-placeholder 缺席，
    // settle(a.com) vs about:blank(空 host) 的比较即产出假驱逐并附本返回。
    expect(r.data!.eviction_suspected).toBeUndefined();
    expect(r.hint).toBeUndefined();
  });
});

// ============================================================
// 9. same-URL 确证分支不标且 settle 刷新
// ============================================================
describe("驱逐哨兵 — same-URL 吸收（agent 跟随自己 click 到达的页）", () => {
  it("观测 == 调用 url（异 host 于旧 settle）⇒ 不标；settle 刷新为观测页（后续 from 以刷新值为准）", async () => {
    const { client } = makeClient({
      evaluate_script: evalSeq([
        "about:blank", // #1 warm pre-read
        0, // #2 warm verify status
        "https://b.com/landing", // #3 门读 == 调用 url（agent click 后跟随）⇒ (iii) 吸收 + settle 刷新
        42, // #4 执行体（零导航分支）
        "https://c.com/evil", // #5 第二调用门读：真漂移（≠ 新 settle host b.com）⇒ (iv) 标记
        "https://c.com/evil", // #6 nav pre-read
        0, // #7 verify status
        7, // #8 执行体
      ]),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/start"); // settle {a.com, "https://a.com/start"}
    const follow = await ch.browse("https://b.com/landing", "evaluate", { js: "() => 1" });
    expect(follow.outcome).toBe("worked");
    expect(follow.data!.did_navigate).toBe(false); // same-URL 零导航
    expect(follow.data!.eviction_suspected).toBeUndefined(); // 吸收：调用方自己知道页面在哪
    // settle 已刷新：后续真漂移的 from = b.com/landing（非陈旧的 a.com/start）
    const drift = await ch.browse("https://b.com/other", "evaluate", { js: "() => 1" });
    expect(drift.data!.eviction_suspected).toEqual({
      from: "https://b.com/landing",
      to: "https://c.com/evil",
      at_ms: expect.any(Number),
    });
  });
});

// ============================================================
// 10. hint 双形态文案断言（r3：基类 consent 钉 / headed 观察形态）
// ============================================================
describe("驱逐哨兵 — hint 双形态（evictionHint override 点）", () => {
  it("基类默认（headless 域）：suspected 措辞 + 双假设（not confirmed）+ ASK THE USER FIRST + browse_headed 指针", async () => {
    const { client } = makeClient();
    const ch = new MutableClientChannel({ c: client });
    const h = hintOf(ch);
    expect(h).toContain("suspected eviction OR unattributed cross-host move");
    expect(h).toContain("not confirmed");
    expect(h).toContain("ASK THE USER FIRST");
    expect(h).toContain("browse_headed");
    expect(h).toContain("L1 atomic read");
  });

  it("HeadedChannel override：纯观察形态——无升级指令（headed 之上无档）、无 consent 指令、指引查证据字段", () => {
    const subproc = {
      registerSpec: vi.fn((_name: string, _spec: SpawnSpec) => {}),
      ensureRunning: vi.fn(async () => ({} as unknown as McpClient)),
      touch: vi.fn(),
      forgetSpec: vi.fn(async () => {}),
      markUserTaken: vi.fn(() => true),
      isUserTaken: vi.fn(() => false),
    } as unknown as SubprocessManager;
    const base = mkdtempSync(path.join(os.tmpdir(), "evict-headed-"));
    try {
      const ch = new HeadedChannel(subproc, { profileBase: base });
      const h = (ch as unknown as { evictionHint(): string }).evictionHint();
      expect(h).toContain("no tier above headed");
      expect(h).toContain("data.eviction_suspected.from/to");
      expect(h).not.toContain("browse_headed"); // 无升级指令
      expect(h).not.toContain("ASK THE USER FIRST"); // 无 consent 指令（观察形态）
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ============================================================
// 附：链返回附着（消费点 ③）+ S1 窗（「或链返回」形态）
// ============================================================
describe("驱逐哨兵 — 链返回附着（消费点 ③）", () => {
  it("S1 标记后跑 steps 链 ⇒ wrapped 链返回体附 eviction_suspected + hint", async () => {
    vi.useFakeTimers();
    const { client } = makeClient({
      evaluate_script: evalSeq(["about:blank", 0, "https://b.com/landing", 42]),
    });
    const ch = new MutableClientChannel({ c: client });
    await warmSession(ch, "https://a.com/");
    await vi.advanceTimersByTimeAsync(EVICTION_WINDOW_MS);
    const r = await ch.browse("https://a.com/", "evaluate", {
      steps: [{ action: "evaluate", js: "() => 1" } as { action: string; js: string }],
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.action).toBe("chain");
    expect(r.data!.eviction_suspected).toEqual({
      from: "https://a.com/",
      to: "https://b.com/landing",
      at_ms: expect.any(Number),
    });
    expect(r.hint).toContain("ASK THE USER FIRST");
  });
});
