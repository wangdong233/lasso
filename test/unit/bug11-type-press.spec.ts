/**
 * bug11-type-press.spec.ts（doc/bugs/11 决议 B，2026-09-17）
 *
 * type/press 两 action 的编排回归（mocked upstream——browse-upstream-contract
 * 同范式）：
 *  - doType uid 路：每字段 click {uid}（可信点击获得焦点——上游 type_text 文档化
 *    前置）→ type_text {text} 的顺序与参数
 *  - doType ref 路：locate 预检（原子性）→ focus expr 回执 → type_text；
 *    focus 失败 → type_focus_failed → didnt；ref miss → ref_stale_re_snapshot
 *  - doPress：press_key {key} 直通；key 缺失 → 错误
 *  - 上游 isError → upstream_type_error / upstream_press_error（假成功治理）
 *  - HighRiskGate D-ζ 回归钉：type step 命中 RTE 黑名单 → blocked；press step
 *    无 DOM 目标 → 不拦（与 evaluate 同档，零 evaluate 调用）
 *  - CONSUMED_OPTIONS：type 传 key → ignored_options；press 传 selectors → 同
 *  - steps 链内 type/press step（steps[].key 透传）
 *  - P10 前置门：上游缺 type_text → upstream_unsupported:type（导航前 didnt）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { HighRiskGate } from "../../src/browse/HighRiskGate.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import { mockEvalResponse } from "../helpers/upstream-mock.js";
import type { BrowseOptions, BrowseResult, InteractResult } from "../../src/types.js";
import type { Step } from "../../src/browse/steps-types.js";

// ============================================================
// mock upstream（UPSTREAM_170_TOOLS 已含 type_text/press_key——D-γ）
// ============================================================
function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

/** focus expr 应答形状（input-guard.ts buildRefFocusExpr 契约）。 */
interface FocusStub {
  focused?: boolean;
  reason?: string;
}

function makeClient(fx: {
  focus?: Record<string, FocusStub>;
  typeIsError?: boolean;
  pressIsError?: boolean;
  toolNames?: string[];
} = {}): { client: McpClient; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "navigate_page") return textContent("navigated to https://example.com/");
      if (name === "take_snapshot") return textContent("Example Domain\n\nMore information...");
      if (name === "type_text") {
        if (fx.typeIsError) return textContent("no focused element to type into", true);
        return textContent("typed");
      }
      if (name === "press_key") {
        if (fx.pressIsError) return textContent("unknown key", true);
        return textContent("pressed");
      }
      if (name === "evaluate_script") {
        const fn = String(args.function ?? "");
        // locate 预检 expr（extract-refs buildRefLocateExpr）：全在场
        if (fn.includes("var missing = []")) {
          return mockEvalResponse({ ok: true, missing: [] });
        }
        // focus expr（input-guard buildRefFocusExpr）：按 ref 路由应答
        if (fn.includes("el.focus()")) {
          const m = fn.match(/var ref = ("[^"]+")/);
          const ref = m ? JSON.parse(m[1]) : "";
          const stub = fx.focus?.[ref] ?? { focused: true };
          if (stub.reason) return mockEvalResponse({ ok: false, reason: stub.reason });
          return mockEvalResponse({ ok: true, focused: stub.focused ?? true, tag: "input" });
        }
        // 三探针 expr（input-guard buildGuardProbeExpr）：默认全负（无信号）
        if (fn.includes("guards.push")) {
          return mockEvalResponse({ ok: true, guards: [] });
        }
        return mockEvalResponse(null);
      }
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () =>
      (fx.toolNames ?? [
        "navigate_page", "take_snapshot", "take_screenshot", "evaluate_script",
        "wait_for", "click", "fill_form", "list_pages", "select_page",
        "list_network_requests", "list_console_messages", "type_text", "press_key",
      ]).map((name) => ({ name, inputSchema: {} })),
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
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-bug11-tp-"));
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
// doType uid 路
// ============================================================
describe("bug11-B — type uid 路（click 获得焦点 → type_text 逐字）", () => {
  it("单字段：click {uid} 先于 type_text {text}（顺序 + 参数；无 evaluate 探针——uid 路第 1 层不探）", async () => {
    const { client, calls } = makeClient();
    const ch = new TestBrowseChannel(client);
    const r: InteractResult<BrowseResult> = await ch.browse(
      "https://example.com/",
      "type",
      { selectors: { "1_23": "喵虎" } } as BrowseOptions,
    );
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("typed 1 fields (0 via lasso ref)");
    const clickIdx = calls.findIndex((c) => c.name === "click");
    const typeIdx = calls.findIndex((c) => c.name === "type_text");
    expect(clickIdx).toBeGreaterThanOrEqual(0);
    expect(typeIdx).toBeGreaterThan(clickIdx);
    expect(calls[clickIdx!].args).toEqual({ uid: "1_23" });
    expect(calls[typeIdx!].args).toEqual({ text: "喵虎" });
    // uid 路零探针（信号值守区 = ref 路）
    expect(calls.filter((c) => c.name === "evaluate_script")).toHaveLength(0);
    expect(r.data!.input_guard_suspected).toBeUndefined();
  });

  it("多字段 uid 表：逐字段 click→type_text 序列（键序保持）", async () => {
    const { client, calls } = makeClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "type", {
      selectors: { a_uid: "one", b_uid: "two" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("typed 2 fields (0 via lasso ref)");
    const seq = calls.filter((c) => c.name === "click" || c.name === "type_text").map((c) => c.name);
    expect(seq).toEqual(["click", "type_text", "click", "type_text"]);
    const texts = calls.filter((c) => c.name === "type_text").map((c) => c.args.text);
    expect(texts).toEqual(["one", "two"]);
  });

  it("selectors 缺失 → 错误携带明确指引（classify 落 unknown——click/fill 缺参同款档位，house 一致）", async () => {
    const { client } = makeClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "type", {} as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(String(r.error)).toContain("type: opts.selectors required");
  });

  it("type_text 返回 isError → 不再假 worked（upstream_type_error）", async () => {
    const { client } = makeClient({ typeIsError: true });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "type", {
      selectors: { "1_23": "x" },
    } as BrowseOptions);
    expect(r.outcome).not.toBe("worked");
    expect(String(r.error)).toContain("upstream_type_error");
    expect(String(r.error)).toContain("no focused element");
  });
});

// ============================================================
// doType ref 路
// ============================================================
describe("bug11-B — type ref 路（locate 预检 → focus 回执 → type_text）", () => {
  it("单 ref：evaluate locate → evaluate focus → type_text（顺序）；focus 回执 focused:true", async () => {
    const { client, calls } = makeClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "type", {
      selectors: { r1: "hello" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("typed 1 fields (1 via lasso ref)");
    const evals = calls.filter((c) => c.name === "evaluate_script");
    expect(evals).toHaveLength(3); // locate + focus + guard probe（决议 C 值守区）
    const typeIdx = calls.findIndex((c) => c.name === "type_text");
    const focusIdx = calls.findIndex((c) => c.name === "evaluate_script" && String(c.args.function).includes("el.focus()"));
    expect(focusIdx).toBeGreaterThan(-1);
    expect(typeIdx).toBeGreaterThan(focusIdx);
    expect(calls[typeIdx!].args).toEqual({ text: "hello" });
  });

  it("locate 预检 miss → ref_stale_re_snapshot → didnt（零部分键入：无 focus/type 调用）", async () => {
    const { client, calls } = makeClient();
    // locate 应答改 miss
    (client.callTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "evaluate_script" && String(args.function ?? "").includes("var missing = []")) {
          return mockEvalResponse({ ok: false, missing: ["r9"] });
        }
        if (name === "navigate_page") return textContent("navigated");
        return textContent("stubbed");
      },
    );
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "type", {
      selectors: { r9: "x" },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(String(r.error)).toContain("ref_stale_re_snapshot");
    expect(calls.find((c) => c.name === "type_text")).toBeUndefined();
    expect(calls.find((c) => c.name === "evaluate_script" && String(c.args.function).includes("el.focus()"))).toBeUndefined();
  });

  it("focus 回执 focused:false → type_focus_failed → didnt（不猜——键入会落到别的元素）", async () => {
    const { client, calls } = makeClient({ focus: { r1: { focused: false } } });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "type", {
      selectors: { r1: "x" },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(String(r.error)).toContain("type_focus_failed:r1");
    expect(calls.find((c) => c.name === "type_text")).toBeUndefined();
  });

  it("focus expr 报 ref_stale → ref_stale_re_snapshot（定位窗口内页面变化）", async () => {
    const { client } = makeClient({ focus: { r1: { reason: "ref_stale" } } });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "type", {
      selectors: { r1: "x" },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(String(r.error)).toContain("ref_stale_re_snapshot");
  });
});

// ============================================================
// doPress
// ============================================================
describe("bug11-B — press action（press_key 直通）", () => {
  it("press 'Control+A' → press_key {key:'Control+A'} → worked", async () => {
    const { client, calls } = makeClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "press", {
      key: "Control+A",
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("pressed Control+A");
    const pressCall = calls.find((c) => c.name === "press_key");
    expect(pressCall).toBeTruthy();
    expect(pressCall!.args).toEqual({ key: "Control+A" });
  });

  it("key 缺失 → 错误携带示例形态（classify 落 unknown——缺参档位 house 一致）", async () => {
    const { client } = makeClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "press", {} as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(String(r.error)).toContain("press: opts.key required");
    expect(String(r.error)).toContain("'Enter'");
  });

  it("press_key 返回 isError → upstream_press_error（不假 worked）", async () => {
    const { client } = makeClient({ pressIsError: true });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "press", {
      key: "Enter",
    } as BrowseOptions);
    expect(r.outcome).not.toBe("worked");
    expect(String(r.error)).toContain("upstream_press_error");
  });
});

// ============================================================
// HighRiskGate D-ζ（回归钉）
// ============================================================
describe("bug11-Dζ — HighRiskGate type 分支（防换 action 名绕 gate）", () => {
  const rteVerdict = () => mockEvalResponse({ ok: true, kind: "rte", html: '<div role="textbox" contenteditable="true">' });

  it("type step 命中 RTE 黑名单 → blocked（与 fill 同拦——selectors 首键作目标）", async () => {
    const { client, calls } = makeClient();
    (client.callTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "evaluate_script") return rteVerdict();
        return textContent("stubbed");
      },
    );
    const gate = new HighRiskGate(() => Promise.resolve(client));
    const step: Step = { action: "type", selectors: { r5: "long text into an RTE" } };
    const v = await gate.assessStep(step);
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("high_risk_pattern:rte");
  });

  it("fill step 同目标同样 blocked（同分支同语义——D-ζ 口径裂缝封死）", async () => {
    const { client } = makeClient();
    (client.callTool as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      if (name === "evaluate_script") return rteVerdict();
      return textContent("stubbed");
    });
    const gate = new HighRiskGate(() => Promise.resolve(client));
    const v = await gate.assessStep({ action: "fill", selectors: { r5: "x" } } as Step);
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("high_risk_pattern:rte");
  });

  it("press step 无 DOM 目标 → 不拦且零 evaluate 调用（与 evaluate 同档——已知接受面）", async () => {
    const { client, calls } = makeClient();
    const gate = new HighRiskGate(() => Promise.resolve(client));
    const v = await gate.assessStep({ action: "press", key: "Enter" } as Step);
    expect(v.blocked).toBe(false);
    expect(calls.filter((c) => c.name === "evaluate_script")).toHaveLength(0);
  });

  it("type step 无 selectors → 不拦（让 channel 自己报错）", async () => {
    const { client } = makeClient();
    const gate = new HighRiskGate(() => Promise.resolve(client));
    const v = await gate.assessStep({ action: "type" } as Step);
    expect(v.blocked).toBe(false);
  });
});

// ============================================================
// CONSUMED_OPTIONS（ignored_options 诚实标注）
// ============================================================
describe("bug11-B — CONSUMED_OPTIONS 消费键", () => {
  it("type 传 key → ignored_options:['key']（type 只消费 selectors）", async () => {
    const { client } = makeClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "type", {
      selectors: { "1_23": "x" },
      key: "Enter",
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_options).toEqual(["key"]);
  });

  it("press 传 selectors → ignored_options:['selectors']（press 只消费 key）", async () => {
    const { client } = makeClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "press", {
      key: "Enter",
      selectors: { "1_23": "x" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_options).toEqual(["selectors"]);
  });
});

// ============================================================
// steps 链（steps[].key 透传）
// ============================================================
describe("bug11-B — steps 链内 type/press step", () => {
  it("chain: [type uid, press Enter] → click+type_text+press_key 各就位（press 的 key 来自 step.key）", async () => {
    const { client, calls } = makeClient();
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "navigate", {
      steps: [
        { action: "type", selectors: { "1_23": "喵虎" } },
        { action: "press", key: "Enter" },
      ],
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    const pressCall = calls.find((c) => c.name === "press_key");
    expect(pressCall).toBeTruthy();
    expect(pressCall!.args).toEqual({ key: "Enter" });
    const typeCall = calls.find((c) => c.name === "type_text");
    expect(typeCall).toBeTruthy();
    expect(typeCall!.args).toEqual({ text: "喵虎" });
  });
});

// ============================================================
// P10 前置门（D-β：入表即自动覆盖）
// ============================================================
describe("bug11-Dβ — P10 前置门自动覆盖 type/press", () => {
  it("上游缺 type_text（假想旧上游）→ 导航前 didnt + upstream_unsupported:type", async () => {
    const { client, calls } = makeClient({
      toolNames: ["navigate_page", "take_snapshot", "evaluate_script", "click", "fill_form"],
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "type", {
      selectors: { "1_23": "x" },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("upstream_unsupported:type");
    expect(String(r.error)).toContain("upstream_unsupported:type");
    expect(calls.find((c) => c.name === "navigate_page")).toBeUndefined();
    expect(calls.find((c) => c.name === "type_text")).toBeUndefined();
  });

  it("上游缺 press_key → 同款 didnt + upstream_unsupported:press", async () => {
    const { client } = makeClient({
      toolNames: ["navigate_page", "take_snapshot", "evaluate_script"],
    });
    const ch = new TestBrowseChannel(client);
    const r = await ch.browse("https://example.com/", "press", {
      key: "Enter",
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("upstream_unsupported:press");
  });
});
