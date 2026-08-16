/**
 * screenshot-vlm-t26.spec.ts（v1.12 round2 T2-6：档4 推断→真执行闭环）
 *
 * 守护点（旧缺陷）：VLM 调用成功即 outcome="worked" + actions_and_results 仅
 * [{ref:"@vlm", ok:true}]——M0.5b 已被 T3 废除，注释承诺的「Rust 端执行」永久
 * 落空，tiers 1-3 全败的 canvas/Metal 场景最终拿到假 worked（tri-state 铁律
 * 在自家链尾的违背）。
 *
 * 三分支（裁决书验收标准）：
 *  1. 可解析（VLM 返回坐标动作）→ rust cgevent_dispatch 真执行 + actions_and_results
 *     填真逐项结果（≥1 ok → worked）
 *  2. 不可解析 → outcome=unknown + error=vlm_inference_only + 推断原文附 data
 *  3. 执行失败（rust 报错 / 全项失败）→ outcome=unknown + vlm_inference_only
 */
import { describe, it, expect } from "vitest";
import { ScreenshotVlmProvider } from "../../src/desktop/ScreenshotVlmProvider.js";
import { MockRustBridge } from "./mocks/mock-rust-bridge.js";

const SHOT = { base64: "aGk=", format: "png", width: 800, height: 600 };

function makeRust(cgevent?: (p: unknown) => unknown) {
  const rust = new MockRustBridge({
    screenshot: () => SHOT,
  });
  if (cgevent) rust.setScript("cgevent_dispatch", cgevent);
  return rust;
}

function makeProvider(
  rust: MockRustBridge,
  vlmResult: unknown,
): ScreenshotVlmProvider {
  return new ScreenshotVlmProvider(rust as unknown as never, {
    endpoint: "http://vlm.example/mcp",
    vlmCaller: async () => vlmResult,
  });
}

describe("T2-6 — 档4 screenshotVlm 闭环", () => {
  it("分支 1：VLM 返回坐标动作 → cgevent_dispatch 真执行 + 真逐项结果 + worked", async () => {
    const rust = makeRust((p) => {
      const n = (p as { actions: unknown[] }).actions.length;
      return {
        results: Array.from({ length: n }, (_, i) => ({ index: i, ok: true, kind: "click" })),
      };
    });
    const p = makeProvider(rust, {
      actions: [
        { kind: "click", x: 100, y: 200 },
        { kind: "move", x: 10, y: 20 },
      ],
    });

    const r = await p.act({ actions: [] } as never);

    // 真执行：cgevent_dispatch 被调，wire 是解析后的坐标动作
    const dispatch = rust.calls.find((c) => c.method === "cgevent_dispatch");
    expect(dispatch).toBeTruthy();
    expect(dispatch!.params).toEqual({
      actions: [
        { kind: "click", x: 100, y: 200 },
        { kind: "move", x: 10, y: 20 },
      ],
    });

    expect(r.outcome).toBe("worked");
    expect(r.data!.actions_and_results).toHaveLength(2);
    expect(r.data!.actions_and_results[0]).toEqual({
      ref: "vlm_click@(100,200)",
      ok: true,
    });
    expect(r.data!.actions_and_results[1].ok).toBe(true);
    // 截图仍附（调用方可见性）
    expect(r.data!.screenshot_base64).toBe(SHOT.base64);
  });

  it("分支 2：VLM 返回不可解析（无坐标动作）→ unknown + vlm_inference_only + 推断原文附 data", async () => {
    const rust = makeRust();
    const p = makeProvider(rust, {
      description: "I see a canvas but cannot determine coordinates",
    });

    const r = await p.act({ actions: [] } as never);

    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("vlm_inference_only");
    // 不猜执行：cgevent_dispatch 从未被调
    expect(rust.calls.find((c) => c.method === "cgevent_dispatch")).toBeUndefined();
    // 推断原文仍附（截图 token 已花不浪费）
    const vlmEntry = r.data!.actions_and_results[0];
    expect(vlmEntry.ref).toBe("@vlm");
    expect(vlmEntry.ok).toBe(false);
    expect(vlmEntry.error).toContain("cannot determine coordinates");
  });

  it("分支 3a：cgevent_dispatch rust 报错 → unknown + vlm_inference_only:execution_failed", async () => {
    const rust = new MockRustBridge({ screenshot: () => SHOT });
    // 不注册 cgevent_dispatch script → MockRustBridge 返 ok:false unknown_method
    const p = makeProvider(rust, { actions: [{ kind: "click", x: 1, y: 2 }] });

    const r = await p.act({ actions: [] } as never);

    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("vlm_inference_only:execution_failed");
  });

  it("分支 3b：全项执行失败（ok:false）→ unknown + all_actions_failed + 逐项 error", async () => {
    const rust = makeRust((p) => {
      const n = (p as { actions: unknown[] }).actions.length;
      return {
        results: Array.from({ length: n }, (_, i) => ({
          index: i,
          ok: false,
          error_kind: "cgevent_construct_failed",
          error: "CGEvent::new_mouse_event returned NULL",
        })),
      };
    });
    const p = makeProvider(rust, { actions: [{ kind: "click", x: 5, y: 6 }] });

    const r = await p.act({ actions: [] } as never);

    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("vlm_inference_only:all_actions_failed");
    const failed = r.data!.actions_and_results.find((a) => a.ref === "vlm_click@(5,6)");
    expect(failed).toBeTruthy();
    expect(failed!.ok).toBe(false);
    // errMsg 优先于 errKind（CGEventProvider 同语义）
    expect(failed!.error).toContain("CGEvent::new_mouse_event returned NULL");
  });

  it("部分成功 → worked（≥1 ok 即 worked，CGEventProvider 同语义）+ 失败项如实标记", async () => {
    const rust = makeRust(() => ({
      results: [
        { index: 0, ok: true, kind: "click" },
        { index: 1, ok: false, error_kind: "invalid_params", error: "bad coord" },
      ],
    }));
    const p = makeProvider(rust, {
      actions: [
        { kind: "click", x: 1, y: 2 },
        { kind: "drag", from: { x: 0, y: 0 }, to: { x: 9, y: 9 } },
      ],
    });

    const r = await p.act({ actions: [] } as never);

    expect(r.outcome).toBe("worked");
    expect(r.data!.actions_and_results[0].ok).toBe(true);
    expect(r.data!.actions_and_results[1].ok).toBe(false);
    // drag 嵌套 from/to 形态被宽化解析为平铺 wire
    const dispatch = rust.calls.find((c) => c.method === "cgevent_dispatch")!;
    expect(dispatch.params).toEqual({
      actions: [
        { kind: "click", x: 1, y: 2 },
        { kind: "drag", from_x: 0, from_y: 0, to_x: 9, to_y: 9 },
      ],
    });
  });
});

describe("T2-6 — parseVlmActions 宽化解析（不锁 VLM shape）", () => {
  it("顶层数组 / {actions:[]} / 单对象 三形态全接受", async () => {
    const { parseVlmActions } = await import(
      "../../src/desktop/ScreenshotVlmProvider.js"
    );
    expect(parseVlmActions([{ kind: "click", x: 1, y: 2 }])).toHaveLength(1);
    expect(parseVlmActions({ actions: [{ kind: "scroll", dx: 0, dy: -3 }] })).toHaveLength(1);
    expect(parseVlmActions({ kind: "move", x: 3, y: 4 })).toHaveLength(1);
  });

  it("键盘 kind（press/hotkey）与非法坐标（NaN/字符串）静默丢弃 → 空数组", async () => {
    const { parseVlmActions } = await import(
      "../../src/desktop/ScreenshotVlmProvider.js"
    );
    expect(parseVlmActions({ actions: [{ kind: "press", key: "Return" }] })).toHaveLength(0);
    expect(
      parseVlmActions({ actions: [{ kind: "click", x: Number.NaN, y: 2 }] }),
    ).toHaveLength(0);
    expect(
      parseVlmActions({ actions: [{ kind: "click", x: "100", y: 2 }] }),
    ).toHaveLength(0);
  });
});

// ============================================================
// T3-2（round3 v1.13）：screenshot_region 坐标偏移补偿
// 五环缺陷：region 裁图 → VLM 返区域相对坐标 → cgevent 直传全局坐标
// → 落点系统性偏移 (region.x, region.y) 且逐项 ok:true（假 worked 换装回归）。
// ============================================================
describe("T3-2 — VLM region 坐标偏移补偿（dispatch 前平移回全局）", () => {
  const REGION = { x: 100, y: 200, w: 640, h: 480 };

  it("region(100,200) + vlm click(50,60) → wire 收到 (150,260)", async () => {
    const rust = makeRust((p) => {
      const n = (p as { actions: unknown[] }).actions.length;
      return {
        results: Array.from({ length: n }, (_, i) => ({ index: i, ok: true, kind: "click" })),
      };
    });
    const p = makeProvider(rust, { actions: [{ kind: "click", x: 50, y: 60 }] });

    const r = await p.act({ screenshot_region: REGION } as never);

    const dispatch = rust.calls.find((c) => c.method === "cgevent_dispatch")!;
    expect(dispatch.params).toEqual({
      actions: [{ kind: "click", x: 150, y: 260 }],
    });
    // audit ref 标签用平移后全局坐标（真执行位置）
    expect(r.data!.actions_and_results[0]).toEqual({ ref: "vlm_click@(150,260)", ok: true });
    expect(r.outcome).toBe("worked");
  });

  it("drag 四值全部平移；scroll 可选 x,y 平移、dx/dy 不动", async () => {
    const rust = makeRust((p) => {
      const n = (p as { actions: unknown[] }).actions.length;
      return {
        results: Array.from({ length: n }, (_, i) => ({ index: i, ok: true })),
      };
    });
    const p = makeProvider(rust, {
      actions: [
        { kind: "drag", from_x: 0, from_y: 10, to_x: 20, to_y: 30 },
        { kind: "scroll", dx: 0, dy: -3, x: 5, y: 5 },
      ],
    });

    await p.act({ screenshot_region: REGION } as never);

    const dispatch = rust.calls.find((c) => c.method === "cgevent_dispatch")!;
    expect(dispatch.params).toEqual({
      actions: [
        { kind: "drag", from_x: 100, from_y: 210, to_x: 120, to_y: 230 },
        { kind: "scroll", dx: 0, dy: -3, x: 105, y: 205 },
      ],
    });
  });

  it("无 region → wire 原样（零变化；既有行为 byte-identical）", async () => {
    const rust = makeRust((p) => {
      const n = (p as { actions: unknown[] }).actions.length;
      return {
        results: Array.from({ length: n }, (_, i) => ({ index: i, ok: true })),
      };
    });
    const p = makeProvider(rust, { actions: [{ kind: "click", x: 1, y: 2 }] });

    await p.act({} as never);

    const dispatch = rust.calls.find((c) => c.method === "cgevent_dispatch")!;
    expect(dispatch.params).toEqual({ actions: [{ kind: "click", x: 1, y: 2 }] });
  });

  it("offsetVlmActionsByRegion 纯函数：scroll 缺省位置（无 x,y）不动", async () => {
    const { offsetVlmActionsByRegion } = await import(
      "../../src/desktop/ScreenshotVlmProvider.js"
    );
    const scroll = [{ kind: "scroll", dx: 1, dy: 2 }];
    expect(offsetVlmActionsByRegion(scroll, REGION)).toEqual([
      { kind: "scroll", dx: 1, dy: 2 },
    ]);
    // click button 透传字段平移后保留
    expect(
      offsetVlmActionsByRegion([{ kind: "click", x: 0, y: 0, button: "right" }], {
        x: 10,
        y: 10,
        w: 1,
        h: 1,
      }),
    ).toEqual([{ kind: "click", x: 10, y: 10, button: "right" }]);
  });
});

// ============================================================
// T3-6（round3 v1.13）：tcc_event_synthesis_denied → didnt（双消费者对齐）
// 同 producer（cgevent_dispatch）：CGEventProvider 映射 didnt，本档此前一律
// unknown 是分类学缺口（权限缺失不是暂时性故障）。
// ============================================================
describe("T3-6 — VLM 档 tcc_event_synthesis_denied → outcome=didnt", () => {
  function makeProviderWithDispatchError(rust: unknown, vlmResult: unknown) {
    return new ScreenshotVlmProvider(rust as never, {
      endpoint: "http://vlm.example/mcp",
      vlmCaller: async () => vlmResult,
    });
  }

  it("cgevent_dispatch 返该 error_kind → didnt + 引导文案（不 unknown 不 fallback）", async () => {
    const fakeRust = {
      call: async (method: string) => {
        if (method === "screenshot") return { id: "t", ok: true, result: SHOT };
        return {
          id: "t",
          ok: false,
          error: "macOS 15+ Event Synthesizing permission denied",
          error_kind: "tcc_event_synthesis_denied",
        };
      },
    };
    const p = makeProviderWithDispatchError(fakeRust, {
      actions: [{ kind: "click", x: 1, y: 2 }],
    });

    const r = await p.act({} as never);

    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("tcc_event_synthesis_denied");
    expect(r.error).toContain("System Settings");
    expect(r.error).toContain("Event Synthesizing");
  });

  it("其他 error_kind 仍 unknown（vlm_inference_only:execution_failed——行为不回归）", async () => {
    const fakeRust = {
      call: async (method: string) => {
        if (method === "screenshot") return { id: "t", ok: true, result: SHOT };
        return { id: "t", ok: false, error: "boom", error_kind: "cgevent_source_failed" };
      },
    };
    const p = makeProviderWithDispatchError(fakeRust, {
      actions: [{ kind: "click", x: 1, y: 2 }],
    });

    const r = await p.act({} as never);

    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("vlm_inference_only:execution_failed");
  });
});
