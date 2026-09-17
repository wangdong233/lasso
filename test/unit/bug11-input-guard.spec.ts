/**
 * bug11-input-guard.spec.ts（doc/bugs/11 决议 C，2026-09-17）
 *
 * input_guard_suspected 诚实信号回归：
 *  - 三探针纯函数（buildGuardProbeExpr 在 stub DOM 上真实 eval）：
 *    G1 value_setter_non_native（own property / 原型链非 native 访问器）
 *    G2 fill_readback_mismatch（延时读回 ≠ 所设值）
 *    G3 react_tracker_divergence（_valueTracker 分叉）
 *    全负 → 无信号
 *  - toSignal 聚合（checks 固定序 G1→G2→G3、target=命中 ref 连缀、null 档）
 *  - 通道级：doFill ref 路命中 → data.input_guard_suspected + hint + outcome
 *    照旧 worked（advisory——不伪造失败）；读后即清（per-call partial）；
 *    全负 → 无字段无 hint
 *  - 零自动改道断言（§C.3 红线）：信号在场时 lasso 不多发任何 click/type_text/
 *    navigate（hint 是指令不是行动）
 *  - hint 单引号约束（INV-98(e) 同款红线：call-shape 片段禁双引号）
 *  - D-η/开放项 2 的 guard 单测钉：[::1] 字面量 → private_ip:::1 拒（默认配置
 *    防倒退）；127.0.0.1 → DEFAULT_ALLOW_RANGES 放行（fixture 正门）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildGuardProbeExpr,
  buildRefFocusExpr,
  toSignal,
  GUARD_CHECK_G1,
  GUARD_CHECK_G2,
  GUARD_CHECK_G3,
  GUARD_READBACK_DELAY_MS,
} from "../../src/browse/input-guard.js";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import { mockEvalResponse } from "../helpers/upstream-mock.js";
import { ssrfGuard } from "../../src/ssrf/ssrf-guard.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";
import type { BrowseOptions, BrowseResult, InteractResult } from "../../src/types.js";

// ============================================================
// stub DOM（vi.stubGlobal——browse-upstream-contract 同范式）
// ============================================================
interface FakeEl {
  tagName: string;
  textContent?: string;
  isContentEditable?: boolean;
  _valueTracker?: { getValue: () => string };
  focus?: () => void;
  [k: string]: unknown;
}

/**
 * 仿真实 <input> 的属性拓扑：'value' 是**原型链访问器**（实例无 own property——
 * 普通 object literal 的 value 是 own 数据属性，会让 G1 的 hasOwnProperty 恒真，
 * 产生假命中）。nativeLike setter 的 String() 含 [native code]（真 DOM 的
 * HTMLInputElement.prototype.value setter 即此形态）。
 */
function fakeInput(opts: {
  value?: string;
  nativeSetter?: boolean;
  trackerGetValue?: () => string;
} = {}): FakeEl {
  let v = opts.value ?? "";
  const proto: Record<string, unknown> = { tagName: "INPUT" };
  const setter = function (x: string) {
    v = x;
  };
  if (opts.nativeSetter !== false) {
    setter.toString = () => "function set() { [native code] }";
  }
  Object.defineProperty(proto, "value", {
    get: () => v,
    set: setter,
    configurable: true,
  });
  const el: FakeEl = Object.create(proto);
  if (opts.trackerGetValue) {
    el._valueTracker = { getValue: opts.trackerGetValue };
  }
  return el;
}

function stubDom(elements: Record<string, FakeEl>): { activeElement: unknown } {
  const doc = {
    querySelector: (sel: string) => {
      const m = /\[data-lasso-uid="([^"]+)"\]/.exec(sel);
      return m ? (elements[m[1]] ?? null) : null;
    },
    activeElement: null as unknown,
  };
  for (const el of Object.values(elements)) {
    el.focus = () => {
      doc.activeElement = el;
    };
  }
  vi.stubGlobal("document", doc);
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  return doc as { activeElement: unknown };
}

/** 真实 eval 探针 expr（上游契约：函数表达式 eval + await 调用；返回 JSON 字符串
 *  经 parseEvalResult 解——此处对齐解一层）。 */
async function evalExpr<T>(fn: string): Promise<T> {
  const f = eval(`(${fn})`) as () => Promise<string> | string;
  const raw = await f();
  return JSON.parse(raw) as T;
}

// ============================================================
// 通道级 mock
// ============================================================
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

function makeChannelClient(fx: {
  guards?: Array<{ ref: string; checks: string[] }>;
} = {}): { client: McpClient; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "navigate_page") return textContent("navigated to https://example.com/");
      if (name === "take_snapshot") return textContent("Example Domain");
      if (name === "fill_form") return textContent("filled");
      if (name === "evaluate_script") {
        const fn = String(args.function ?? "");
        if (fn.includes("var missing = []")) {
          return mockEvalResponse({ ok: true, missing: [] });
        }
        if (fn.includes("filled.push")) {
          return mockEvalResponse({ ok: true, filled: ["r1"], errors: [] });
        }
        if (fn.includes("guards.push")) {
          return mockEvalResponse({ ok: true, guards: fx.guards ?? [] });
        }
        return mockEvalResponse(null);
      }
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () =>
      [
        "navigate_page", "take_snapshot", "take_screenshot", "evaluate_script",
        "wait_for", "click", "fill_form", "type_text", "press_key",
      ].map((name) => ({ name, inputSchema: {} })),
    ),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client, calls };
}

class TestBrowseChannel extends BrowseChannel {
  readonly name = "browse_test";
  constructor(private readonly c: McpClient) {
    super();
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.c);
  }
}

let tempCache: string;
beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-bug11-ig-"));
  setStateStoreContext({ runId, cacheDir: tempCache });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ============================================================
// 三探针纯函数（stub DOM 真实 eval）
// ============================================================
describe("bug11-C — 三探针 expr（stub DOM 真实 eval）", () => {
  it("G1：实例 own property 'value'（accessor 劫持安装态）→ value_setter_non_native", async () => {
    const el: FakeEl = fakeInput({ value: "kept" });
    // 劫持：在实例上再定义 own accessor（站点安装态——决议 C.1 G1 判据）
    let backing = "kept";
    Object.defineProperty(el, "value", {
      get: () => backing,
      set: (x: string) => {
        backing = x;
      },
      configurable: true,
    });
    stubDom({ r1: el });
    const v = await evalExpr<{ ok: boolean; guards: Array<{ ref: string; checks: string[] }> }>(
      buildGuardProbeExpr([{ ref: "r1", value: "kept" }]),
    );
    expect(v.ok).toBe(true);
    expect(v.guards).toHaveLength(1);
    expect(v.guards![0]).toEqual({ ref: "r1", checks: [GUARD_CHECK_G1] });
  });

  it("G1：原型链非 [native code] value 访问器 → value_setter_non_native（native setter 干净 input 不命中）", async () => {
    const hijacked = fakeInput({ value: "x", nativeSetter: false }); // 原型 setter 无 [native code]
    const clean = fakeInput({ value: "same" }); // [native code] setter
    stubDom({ r1: hijacked, r2: clean });
    const v = await evalExpr<{ guards: Array<{ ref: string; checks: string[] }> }>(
      buildGuardProbeExpr([
        { ref: "r1", value: "whatever" },
        { ref: "r2", value: "same" },
      ]),
    );
    expect(v.guards).toHaveLength(1);
    expect(v.guards![0].ref).toBe("r1");
    expect(v.guards![0].checks).toContain(GUARD_CHECK_G1);
  });

  it(`G2：延时 ${GUARD_READBACK_DELAY_MS}ms 后值被清（异步重置族）→ fill_readback_mismatch`, async () => {
    const el = fakeInput({ value: "" }); // 填充后已被异步重置清空
    stubDom({ r1: el });
    const t0 = Date.now();
    const v = await evalExpr<{ guards: Array<{ ref: string; checks: string[] }> }>(
      buildGuardProbeExpr([{ ref: "r1", value: "was-set" }]),
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(GUARD_READBACK_DELAY_MS - 30);
    expect(v.guards).toHaveLength(1);
    expect(v.guards![0].checks).toEqual([GUARD_CHECK_G2]);
  });

  it("G3：React _valueTracker 分叉（tracker≠DOM value）→ react_tracker_divergence", async () => {
    const el = fakeInput({
      value: "script-set", // DOM 已被脚本写入
      trackerGetValue: () => "", // 受控 state 仍空（tm.aliyun.com 本体机理）
    });
    stubDom({ r1: el });
    const v = await evalExpr<{ guards: Array<{ ref: string; checks: string[] }> }>(
      buildGuardProbeExpr([{ ref: "r1", value: "script-set" }]),
    );
    expect(v.guards![0].checks).toEqual([GUARD_CHECK_G3]);
  });

  it("全负（干净受控一致的 input）→ guards 空 → 无信号", async () => {
    const el = fakeInput({ value: "ok", trackerGetValue: () => "ok" }); // tracker 已收敛
    stubDom({ r1: el });
    const v = await evalExpr<{ guards: unknown[] }>(
      buildGuardProbeExpr([{ ref: "r1", value: "ok" }]),
    );
    expect(v.guards).toHaveLength(0);
    expect(toSignal(v as { ok?: boolean; guards?: [] })).toBeNull();
  });

  it("contenteditable：textContent 读回不符 → G2（无 value 侧探针）", async () => {
    const el: FakeEl = { tagName: "DIV", textContent: "", isContentEditable: true };
    stubDom({ r1: el });
    const v = await evalExpr<{ guards: Array<{ ref: string; checks: string[] }> }>(
      buildGuardProbeExpr([{ ref: "r1", value: "typed" }]),
    );
    expect(v.guards![0].checks).toEqual([GUARD_CHECK_G2]);
  });

  it("ref 不在 DOM（locate miss）→ continue 不产信号（探测失败≠保护层证据）", async () => {
    stubDom({});
    const v = await evalExpr<{ guards: unknown[] }>(
      buildGuardProbeExpr([{ ref: "rX", value: "x" }]),
    );
    expect(v.guards).toHaveLength(0);
  });
});

// ============================================================
// buildRefFocusExpr（doType ref 路前置）
// ============================================================
describe("bug11-C — focus expr 回执", () => {
  it("定位 + focus + activeElement 回执", async () => {
    const el = fakeInput({ value: "" });
    const doc = stubDom({ r1: el });
    const v = await evalExpr<{ ok: boolean; focused: boolean; tag: string }>(
      buildRefFocusExpr("r1"),
    );
    expect(v.ok).toBe(true);
    expect(v.focused).toBe(true);
    expect(doc.activeElement).toBe(el);
    expect(v.tag).toBe("input");
  });

  it("miss → { ok:false, reason:'ref_stale' }（不猜）", async () => {
    stubDom({});
    const v = await evalExpr<{ ok: boolean; reason: string }>(buildRefFocusExpr("rX"));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("ref_stale");
  });
});

// ============================================================
// toSignal 聚合
// ============================================================
describe("bug11-C — toSignal 聚合（固定序 + target 连缀 + null 档）", () => {
  it("多字段命中 → checks 固定序 G1→G2→G3 去重并集；target=命中 ref 逗号连缀", () => {
    const s = toSignal({
      ok: true,
      guards: [
        { ref: "r2", checks: [GUARD_CHECK_G3] },
        { ref: "r1", checks: [GUARD_CHECK_G2, GUARD_CHECK_G1] },
      ],
    }, () => 1234);
    expect(s).toEqual({
      checks: [GUARD_CHECK_G1, GUARD_CHECK_G2, GUARD_CHECK_G3],
      target: "r2,r1", // guards 序（首个命中的 ref 在前）
      at_ms: 1234,
    });
  });

  it("ok:false / guards 空 / 非数组 → null（探测失败不是保护层证据）", () => {
    expect(toSignal(undefined)).toBeNull();
    expect(toSignal({ ok: false, guards: [{ ref: "r1", checks: [GUARD_CHECK_G1] }] })).toBeNull();
    expect(toSignal({ ok: true, guards: [] })).toBeNull();
  });
});

// ============================================================
// 通道级（doFill ref 路 → browseSingle 信号面）
// ============================================================
describe("bug11-C — doFill ref 路信号（advisory：outcome 照旧 worked）", () => {
  it("G3 命中 → data.input_guard_suspected + hint + worked（不伪造失败）", async () => {
    const { client } = makeChannelClient({
      guards: [{ ref: "r1", checks: [GUARD_CHECK_G3] }],
    });
    const ch = new TestBrowseChannel(client);
    const r: InteractResult<BrowseResult> = await ch.browse("https://example.com/", "fill", {
      selectors: { r1: "喵虎" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked"); // advisory——值此刻在 DOM，风险在 blur 后
    expect(r.data!.input_guard_suspected).toEqual({
      checks: [GUARD_CHECK_G3],
      target: "r1",
      at_ms: expect.any(Number),
    });
    expect(r.hint).toBeTruthy();
    expect(r.hint).toContain("suspected site input guard");
    expect(r.hint).toContain("not confirmed");
    expect(r.hint).toContain("trusted input pipeline");
    expect(r.hint).toContain("ask the user to type physically");
  });

  it("读后即清：下一次调用不再携带信号（per-call partial 天然一次性）", async () => {
    const { client } = makeChannelClient({
      guards: [{ ref: "r1", checks: [GUARD_CHECK_G1] }],
    });
    const ch = new TestBrowseChannel(client);
    const r1 = await ch.browse("https://example.com/", "fill", { selectors: { r1: "x" } } as BrowseOptions);
    expect(r1.data!.input_guard_suspected).toBeTruthy();
    const r2 = await ch.browse("https://example.com/", "fill", { selectors: { r1: "x" } } as BrowseOptions);
    expect(r2.data!.input_guard_suspected).toBeTruthy(); // mock 仍回 guards——但：
    // 探针 mock 改全负后，同一通道实例不再残留上一轮信号
    (client.callTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "evaluate_script" && String(args.function ?? "").includes("guards.push")) {
          return mockEvalResponse({ ok: true, guards: [] });
        }
        if (name === "fill_form") return textContent("filled");
        return mockEvalResponse({ ok: true, missing: [] });
      },
    );
    const r3 = await ch.browse("https://example.com/", "fill", { selectors: { r1: "x" } } as BrowseOptions);
    expect(r3.outcome).toBe("worked");
    expect(r3.data!.input_guard_suspected).toBeUndefined();
    expect(r3.hint).toBeUndefined();
  });

  it("全负 → 无字段无 hint（byte-identical 缺省——uid 路与负探针同形）", async () => {
    const { client } = makeChannelClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "fill", { selectors: { r1: "x" } } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.input_guard_suspected).toBeUndefined();
    expect(r.hint).toBeUndefined();
  });

  it("uid 路（纯 fill_form）零探针调用（值守区=第 2 层；uid 在第 1 层可信管道）", async () => {
    const { client, calls } = makeChannelClient();
    const ch = new TestBrowseChannel(client);
    await ch.browse("https://example.com/", "fill", { selectors: { "1_23": "x" } } as BrowseOptions);
    expect(calls.filter((c) => c.name === "evaluate_script")).toHaveLength(0);
  });

  it("🔴 零自动改道（§C.3 红线）：信号在场时 lasso 不多发任何 click/type_text/navigate/retry", async () => {
    const { client, calls } = makeChannelClient({
      guards: [{ ref: "r1", checks: [GUARD_CHECK_G2] }],
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "fill", { selectors: { r1: "x" } } as BrowseOptions);
    expect(r.data!.input_guard_suspected).toBeTruthy();
    // 交互面穷举 = locate + fill + guard probe（3 evaluate）；任何 click/type_text/
    // navigate_page = 自动改道violation
    const names = calls.map((c) => c.name).filter((n) => n !== "listTools");
    expect(names.every((n) => n === "evaluate_script")).toBe(true);
    expect(calls.filter((c) => c.name === "evaluate_script")).toHaveLength(3);
    expect(calls.find((c) => c.name === "navigate_page")).toBeUndefined();
    expect(calls.find((c) => c.name === "type_text")).toBeUndefined();
    expect(calls.find((c) => c.name === "click")).toBeUndefined();
  });

  it("探针 evaluate 抛错 → 无信号（best-effort：探测失败不是保护层证据）+ fill 本身照常 worked", async () => {
    const { client } = makeChannelClient();
    (client.callTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        const fn = String(args.function ?? "");
        if (name === "evaluate_script" && fn.includes("guards.push")) {
          throw new Error("probe channel down");
        }
        if (name === "evaluate_script") return mockEvalResponse({ ok: true, missing: [] });
        if (name === "fill_form") return textContent("filled");
        if (name === "navigate_page") return textContent("navigated");
        return textContent("stubbed");
      },
    );
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "fill", { selectors: { r1: "x" } } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.input_guard_suspected).toBeUndefined();
  });
});

// ============================================================
// hint 源锚约束（INV-98(e) 同款红线：片段禁双引号）
// ============================================================
describe("bug11-C — hint 单引号约束（INV-98(e) 同款）", () => {
  const CHANNEL_SRC = readFileSync(
    fileURLToPath(new URL("../../src/channels/BrowseChannel.ts", import.meta.url)),
    "utf8",
  );

  it("inputGuardHint 源码形如 return \"...\"（单行、无嵌入双引号）——evictionHint 同款源锚形态", () => {
    const m = CHANNEL_SRC.match(/protected inputGuardHint\(\): string \{\s*return "([^"]+)"/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toContain('"');
  });

  it("hint 内 call-shape 片段用单引号形参（browse_headless({url:'...', ...}）", () => {
    const m = CHANNEL_SRC.match(/protected inputGuardHint\(\): string \{\s*return "([^"]+)"/);
    expect(m![1]).toContain("browse_headless({url:'...', action:'type', selectors:{'<uid>':'<text>'}})");
  });
});

// ============================================================
// D-η / 开放项 2 的 guard 单测钉（fixture 正门 + ::1 防倒退）
// ============================================================
describe("bug11-Dη — 本地 fixture 的 SSRF 正门/侧门（单测钉）", () => {
  const cfg: SsrfConfig = { allowRanges: [], denyRanges: [], fileAllowFrom: [] };

  it("http://127.0.0.1:<port> → allowed（DEFAULT_ALLOW_RANGES 127.0.0.1/32 写死逃生口）", async () => {
    const r = await ssrfGuard("http://127.0.0.1:8901/guard.html", cfg);
    expect(r.allowed).toBe(true);
  });

  it("http://[::1]:<port> → 拒 + private_ip:::1（::1/128 在 PRIVATE_RANGES 默认拒——防倒退钉）", async () => {
    const r = await ssrfGuard("http://[::1]:8901/guard.html", cfg);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("private_ip:::1");
  });
});
