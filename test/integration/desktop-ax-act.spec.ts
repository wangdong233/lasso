/**
 * desktop-ax-act.spec.ts（v1.11 round1 T3 —— ax_act observe→act 闭环）
 *
 * 验证 AxProvider.act × DesktopChannel.act 全链（mock helper 走通 click/type/scroll）：
 *
 * Rust ax_act 契约（rust-helper/src/ax.rs，round1 T3 落地）：
 *  - 入参 { app, max_depth, where, actions }（where 在 = find 命中序编号；
 *    缺席 = snapshot 全节点前序编号——同序重编号解析 @eN）
 *  - 返 { actions_and_results: [{index, ref, ok, error_kind?, error?}] }
 *  - 逐项 error_kind：stale_ref / ax_action_unsupported / ax_verify_failed /
 *    ax_set_failed / ax_perform_failed / ax_unsupported_action / invalid_params
 *
 * TS 端 outcome 映射（AxProvider.act，round1 T3 裁决）：
 *  - 全项 ok / 部分项 ok          → worked（per-item 错误可见）
 *  - 全项失败 + 任一 stale_ref     → **didnt**（UI 已变，需重新 observe；短路链）
 *  - 全项失败 + 无 stale_ref       → unknown（链继续 appleScript→cgEvent→screenshotVlm）
 *  - 顶层 error（tcc_denied 等）    → 错误契约照旧（didnt/unknown）
 */
import { describe, it, expect } from "vitest";
import { DesktopChannel } from "../../src/channels/DesktopChannel.js";
import { AxProvider } from "../../src/desktop/AxProvider.js";
import { MacAxBackend } from "../../src/desktop/AxBackend.js";
import { ScreenshotVlmProvider } from "../../src/desktop/ScreenshotVlmProvider.js";
import { AppleScriptProvider } from "../../src/desktop/AppleScriptProvider.js";
import { CGEventProvider } from "../../src/desktop/CGEventProvider.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { MockRustBridge } from "../unit/mocks/mock-rust-bridge.js";

// ============================================================
// helpers
// ============================================================
function assemble(scripts: Record<string, (params: unknown) => unknown>) {
  const rust = new MockRustBridge(scripts);
  const ax = new AxProvider(new MacAxBackend(rust as unknown as never));
  const vlm = new ScreenshotVlmProvider(rust as unknown as never, {
    endpoint: null,
    vlmCaller: null,
  });
  const apple = new AppleScriptProvider(rust as unknown as never);
  const cg = new CGEventProvider(rust as unknown as never);
  const breakers = new Map<string, CircuitBreaker>([
    ["desktop.ax", new CircuitBreaker()],
    ["desktop.appleScript", new CircuitBreaker()],
    ["desktop.cgEvent", new CircuitBreaker()],
    ["desktop.screenshotVlm", new CircuitBreaker()],
  ]);
  const desktop = new DesktopChannel(
    rust as unknown as never,
    ax,
    vlm,
    apple,
    cg,
    new FallbackDecider(breakers),
    breakers,
  );
  return { desktop, rust };
}

type Item = {
  index?: number;
  ref?: string;
  ok: boolean;
  error_kind?: string;
  error?: string;
  kind?: string;
};

/** ax_act script 工厂：透传捕获 params，返指定逐项结果。 */
function axActScript(items: Item[]) {
  return () => ({ actions_and_results: items });
}

// ============================================================
// 1. click/type/scroll 全链 worked（round1 T3 验收：mock helper 走通）
// ============================================================
describe("T3 — ax_act 全链 click/type/scroll（worked 路径）", () => {
  it("click @e0 全项 ok → outcome=worked + params 透传 where（同序重编号契约）", async () => {
    const { desktop, rust } = assemble({
      ax_act: axActScript([{ index: 0, ref: "@e0", ok: true, kind: "click" }]),
    });
    const r = await desktop.act({
      app: "Finder",
      where: { role: "button" },
      actions: [{ kind: "click", ref: "@e0" }],
    });
    expect(r.outcome).toBe("worked");
    expect(r.fallback_used).toBe(false);
    // Rust 收到 app/max_depth/where/actions 全量（同序重编号必需）
    const call = rust.calls.find((c) => c.method === "ax_act");
    expect(call).toBeTruthy();
    expect(call!.params).toEqual({
      app: "Finder",
      max_depth: 8,
      where: { role: "button" },
      actions: [{ kind: "click", ref: "@e0" }],
    });
    // audit 链只有 ax 一档（worked 短路）
    expect(r.actions_and_results?.length).toBe(1);
    expect(r.actions_and_results?.[0].channel).toBe("desktop.ax");
  });

  it("type @e1 ok → worked（AXSetValue 写后读回由 Rust 端负责）", async () => {
    const { desktop } = assemble({
      ax_act: axActScript([{ index: 0, ref: "@e1", ok: true, kind: "type" }]),
    });
    const r = await desktop.act({
      actions: [{ kind: "type", ref: "@e1", text: "hello" }],
    });
    expect(r.outcome).toBe("worked");
  });

  it("scroll @e2 ok → worked（AXScrollToVisible）", async () => {
    const { desktop } = assemble({
      ax_act: axActScript([
        { index: 0, ref: "@e2", ok: true, kind: "scroll" },
      ]),
    });
    const r = await desktop.act({
      actions: [{ kind: "scroll", ref: "@e2", dx: 0, dy: -120 }],
    });
    expect(r.outcome).toBe("worked");
  });

  it("批量 [click, type, scroll] 全 ok → worked 一档短路", async () => {
    const { desktop } = assemble({
      ax_act: axActScript([
        { index: 0, ref: "@e0", ok: true, kind: "click" },
        { index: 1, ref: "@e1", ok: true, kind: "type" },
        { index: 2, ref: "@e2", ok: true, kind: "scroll" },
      ]),
    });
    const r = await desktop.act({
      actions: [
        { kind: "click", ref: "@e0" },
        { kind: "type", ref: "@e1", text: "x" },
        { kind: "scroll", ref: "@e2", dx: 0, dy: 10 },
      ],
    });
    expect(r.outcome).toBe("worked");
    expect(r.actions_and_results?.length).toBe(1); // 只 ax 一档
  });
});

// ============================================================
// 2. stale_ref → didnt（round1 T3 裁决映射：UI 已变短路链）
// ============================================================
describe("T3 — stale_ref → outcome=didnt（短路 fallback 链）", () => {
  it("全项失败 + stale_ref → didnt + error 引导重新 observe", async () => {
    const { desktop, rust } = assemble({
      ax_act: axActScript([
        {
          index: 0,
          ref: "@e0",
          ok: false,
          error_kind: "stale_ref",
          error: "ref \"@e0\" out of range (0 numbered nodes)",
        },
      ]),
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e0" }],
    });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toMatch(/stale_ref/);
    // 下游档未被调用（stale 短路——基于旧 ref 再试无意义）
    expect(
      rust.calls.filter((c) => c.method === "applescript_run"),
    ).toHaveLength(0);
    expect(
      rust.calls.filter((c) => c.method === "cgevent_dispatch"),
    ).toHaveLength(0);
  });

  it("部分 ok + 部分 stale → worked（部分成功语义；per-item 错误可见）", async () => {
    const { desktop } = assemble({
      ax_act: axActScript([
        { index: 0, ref: "@e0", ok: true, kind: "click" },
        {
          index: 1,
          ref: "@e1",
          ok: false,
          error_kind: "stale_ref",
          error: "label changed",
        },
      ]),
    });
    const r = await desktop.act({
      actions: [
        { kind: "click", ref: "@e0" },
        { kind: "click", ref: "@e1" },
      ],
    });
    expect(r.outcome).toBe("worked"); // 部分成功
  });
});

// ============================================================
// 3. 全项失败无 stale → unknown（链继续到 cgEvent 档）
// ============================================================
describe("T3 — 全项失败（非 stale）→ unknown 链继续", () => {
  it("press 动作（档3 domain）ax 报 ax_unsupported_action → 链走到 cgEvent", async () => {
    const { desktop } = assemble({
      ax_act: axActScript([
        {
          index: 0,
          ref: "",
          ok: false,
          error_kind: "ax_unsupported_action",
          error: "kind \"press\" not supported by ax tier",
        },
      ]),
      cgevent_dispatch: () => ({
        results: [{ index: 0, ok: true }],
      }),
    });
    const r = await desktop.act({
      actions: [{ kind: "press", key: "Return" }],
    });
    expect(r.outcome).toBe("worked");
    expect(r.fallback_used).toBe(true);
    // ax(unknown) → appleScript(unknown) → cgEvent(worked)
    expect(r.actions_and_results?.length).toBe(3);
    expect(r.actions_and_results?.[2].channel).toBe("desktop.cgEvent");
  });

  it("ax_action_unsupported（如 AXPress 不在 AXActions）全项 → unknown 链继续", async () => {
    const { desktop } = assemble({
      ax_act: axActScript([
        {
          index: 0,
          ref: "@e0",
          ok: false,
          error_kind: "ax_action_unsupported",
          error: "AXPress not in AXActions",
        },
      ]),
      // 全下游都接不住 → 链走完 4 档
      screenshot: () => ({ base64: "", format: "png", width: 1, height: 1 }),
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e0" }],
    });
    expect(r.outcome).not.toBe("worked");
    expect(r.actions_and_results?.[0].channel).toBe("desktop.ax");
  });
});

// ============================================================
// 4. 顶层错误契约照旧（tcc_denied → didnt）
// ============================================================
describe("T3 — 顶层 error_kind 契约照旧", () => {
  it("tcc_denied → outcome=didnt（链短路；错误契约不变）", async () => {
    const rust = new MockRustBridge({
      ax_act: () => {
        throw new Error("__kind__tcc_denied");
      },
    });
    // 直测 AxProvider（MockRustBridge throw → error_kind=script_error；
    // 用直构 backend 测 didnt 映射更准）
    const backend = {
      snapshot: async () => ({ id: "t", ok: false, error: "x", error_kind: "tcc_denied" }),
      find: async () => ({ id: "t", ok: false, error: "x", error_kind: "tcc_denied" }),
      act: async () => ({ id: "t", ok: false, error: "x", error_kind: "tcc_denied" }),
    };
    const provider = new AxProvider(backend as never);
    const r = await provider.act({
      actions: [{ kind: "click", ref: "@e0" }],
    });
    expect(r.outcome).toBe("didnt");
    void rust;
  });
});

// ============================================================
// 5. T15（v1.11 round1）：expect 后置条件接线（原死字段）
// ============================================================
describe("T15 — act expect 后置条件（事件送达 ≠ 语义成功）", () => {
  it("act worked + expect 达成 → expect_verified=true（outcome 保持 worked）", async () => {
    let findCount = 0;
    const { desktop } = assemble({
      ax_act: axActScript([{ index: 0, ref: "@e0", ok: true, kind: "click" }]),
      ax_find: () => {
        findCount++;
        return { matches: [{ ref: "@e0", role: "button", label: "Done" }], count: 1 };
      },
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e0" }],
      expect: { text: "Done", timeout_ms: 1000 },
    });
    expect(r.outcome).toBe("worked");
    expect(r.data?.expect_verified).toBe(true);
    expect(findCount).toBeGreaterThan(0);
  });

  it("act worked + expect 超时未达成 → outcome=didnt + expect_failed", async () => {
    const { desktop } = assemble({
      ax_act: axActScript([{ index: 0, ref: "@e0", ok: true, kind: "click" }]),
      ax_find: () => ({ matches: [], count: 0 }), // 后置条件永不出现
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e0" }],
      expect: { text: "Success", timeout_ms: 300 },
    });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toMatch(/^expect_failed:/);
    expect(r.data?.expect_verified).toBe(false);
  });

  it("T2-10：第一次命中后消失 → 不成立（瞬时命中 ≠ 稳定状态；连续 2 次才算）", async () => {
    let findCount = 0;
    const { desktop } = assemble({
      ax_act: axActScript([{ index: 0, ref: "@e0", ok: true, kind: "click" }]),
      ax_find: () => {
        findCount++;
        return findCount === 1
          ? { matches: [{ ref: "@e0", label: "Flash" }], count: 1 } // 仅第 1 次
          : { matches: [], count: 0 }; // 之后消失
      },
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e0" }],
      expect: { text: "Flash", timeout_ms: 500 },
    });
    // 旧实现首命中即真（假 expect_verified）；稳定性采样后诚实 didnt
    expect(r.outcome).toBe("didnt");
    expect(r.error).toMatch(/^expect_failed:expected_condition_not_met/);
    expect(findCount).toBeGreaterThanOrEqual(2);
  });

  it("expect.gone=true → 目标消失才 verified（仍存在则 didnt）", async () => {
    const { desktop } = assemble({
      ax_act: axActScript([{ index: 0, ref: "@e0", ok: true, kind: "click" }]),
      ax_find: () => ({ matches: [], count: 0 }), // 点击后对话框消失
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e0" }],
      expect: { text: "Dialog", gone: true, timeout_ms: 300 },
    });
    expect(r.outcome).toBe("worked");
    expect(r.data?.expect_verified).toBe(true);
  });

  it("expect 只有 ref/gone 无 text/role → expect_failed:expect_needs_text_or_role（诚实报因）", async () => {
    const { desktop } = assemble({
      ax_act: axActScript([{ index: 0, ref: "@e0", ok: true, kind: "click" }]),
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e0" }],
      expect: { gone: true, timeout_ms: 200 },
    });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("expect_failed:expect_needs_text_or_role");
  });

  it("act 非 worked（unknown 全链失败）→ 不验后置（expect 字段零影响）", async () => {
    const { desktop } = assemble({
      ax_act: () => {
        throw new Error("ax_down");
      },
      screenshot: () => ({ base64: "", format: "png", width: 1, height: 1 }),
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e0" }],
      expect: { text: "Anything", timeout_ms: 200 },
    });
    expect(r.outcome).not.toBe("worked");
    expect(r.data?.expect_verified).toBeUndefined();
  });
});
