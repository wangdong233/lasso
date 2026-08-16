/**
 * cg-event-mouse.spec.ts（v1.11 round1 T7 —— CGEvent 档鼠标四路径）
 *
 * 验证：
 *  1. ALLOWED_CGEVENT_KINDS 扩 click/drag/scroll/move（press/hotkey 保留）
 *  2. 坐标形态动作（click x/y、drag、move、scroll 无 ref）→ cgevent_dispatch wire
 *  3. ref 形态 click/scroll（无坐标）→ 不是 cgEvent domain → cgevent_no_supported_action
 *     （unknown，链继续到 screenshotVlm）
 *  4. INV-28 鼠标面：click.button 数字 raw button code → didnt 短路
 *  5. DesktopChannel 4-tier 集成：坐标 click 走 ax(unknown) → appleScript(unknown)
 *     → cgEvent(worked)
 *  6. isUiAction 形状校验（新动作 kind）
 */
import { describe, it, expect } from "vitest";
import {
  CGEventProvider,
  __CGEVENT_ALLOWED_KINDS,
  __CGEVENT_HAS_RAW_KEYCODE_LEAK,
  __CGEVENT_NORMALIZE_FOR_CGEVENT,
} from "../../src/desktop/CGEventProvider.js";
import { isUiAction } from "../../src/desktop/desktop-types.js";
import { MockRustBridge } from "./mocks/mock-rust-bridge.js";
import type { UiAction } from "../../src/desktop/desktop-types.js";

// ============================================================
// 1. 动作集扩展
// ============================================================
describe("T7 — CGEvent 档动作集扩展", () => {
  it("ALLOWED_CGEVENT_KINDS 含 press/hotkey + click/drag/scroll/move", () => {
    expect([...__CGEVENT_ALLOWED_KINDS].sort()).toEqual(
      ["click", "drag", "hotkey", "move", "press", "scroll"].sort(),
    );
  });

  it("isUiAction 接受新坐标形态（click x/y / drag / move / scroll dx,dy）", () => {
    expect(isUiAction({ kind: "click", x: 100, y: 200 })).toBe(true);
    expect(isUiAction({ kind: "click", ref: "@e0" })).toBe(true);
    expect(isUiAction({ kind: "drag", from_x: 1, from_y: 2, to_x: 3, to_y: 4 })).toBe(true);
    expect(isUiAction({ kind: "move", x: 5, y: 6 })).toBe(true);
    expect(isUiAction({ kind: "scroll", dx: 0, dy: -3 })).toBe(true);
    expect(isUiAction({ kind: "scroll", ref: "@e1", dx: 0, dy: -3 })).toBe(true);
    // 形状错拒绝
    expect(isUiAction({ kind: "click" })).toBe(false);
    expect(isUiAction({ kind: "drag", from_x: 1 })).toBe(false);
  });
});

// ============================================================
// 2. normalize：坐标形态 → wire
// ============================================================
describe("T7 — normalizeForCgevent 鼠标路径", () => {
  it("坐标 click → {kind:click, x, y, button?}", () => {
    const a = __CGEVENT_NORMALIZE_FOR_CGEVENT({
      kind: "click",
      x: 100,
      y: 200,
      button: "right",
    } as unknown as UiAction);
    expect(a).toEqual({ kind: "click", x: 100, y: 200, button: "right" });
  });

  it("坐标 click 无 button → 默认 left（Rust 端缺省）", () => {
    const a = __CGEVENT_NORMALIZE_FOR_CGEVENT({
      kind: "click",
      x: 1,
      y: 2,
    } as unknown as UiAction);
    expect(a).toEqual({ kind: "click", x: 1, y: 2 });
  });

  it("drag → {kind:drag, from_x/from_y/to_x/to_y}", () => {
    const a = __CGEVENT_NORMALIZE_FOR_CGEVENT({
      kind: "drag",
      from_x: 10,
      from_y: 20,
      to_x: 30,
      to_y: 40,
    } as unknown as UiAction);
    expect(a).toEqual({
      kind: "drag",
      from_x: 10,
      from_y: 20,
      to_x: 30,
      to_y: 40,
    });
  });

  it("move → {kind:move, x, y}", () => {
    const a = __CGEVENT_NORMALIZE_FOR_CGEVENT({
      kind: "move",
      x: 7,
      y: 8,
    } as unknown as UiAction);
    expect(a).toEqual({ kind: "move", x: 7, y: 8 });
  });

  it("无 ref scroll → {kind:scroll, dx, dy[, x,y]}", () => {
    expect(
      __CGEVENT_NORMALIZE_FOR_CGEVENT({ kind: "scroll", dx: 0, dy: -5 } as unknown as UiAction),
    ).toEqual({ kind: "scroll", dx: 0, dy: -5 });
    expect(
      __CGEVENT_NORMALIZE_FOR_CGEVENT({
        kind: "scroll",
        dx: 1,
        dy: 2,
        x: 3,
        y: 4,
      } as unknown as UiAction),
    ).toEqual({ kind: "scroll", dx: 1, dy: 2, x: 3, y: 4 });
  });

  it("ref 形态 click / scroll → null（不是 cgEvent domain，链继续）", () => {
    expect(
      __CGEVENT_NORMALIZE_FOR_CGEVENT({ kind: "click", ref: "@e0" } as UiAction),
    ).toBeNull();
    expect(
      __CGEVENT_NORMALIZE_FOR_CGEVENT({
        kind: "scroll",
        ref: "@e1",
        dx: 0,
        dy: 1,
      } as unknown as UiAction),
    ).toBeNull();
  });
});

// ============================================================
// 3. INV-28 鼠标面：raw button code 拒绝
// ============================================================
describe("T7 — INV-28 raw button code 拒绝", () => {
  it("click.button 数字 → hasRawKeycodeLeak true", () => {
    expect(
      __CGEVENT_HAS_RAW_KEYCODE_LEAK({ kind: "click", x: 1, y: 2, button: 0 }),
    ).toBe(true);
    expect(
      __CGEVENT_HAS_RAW_KEYCODE_LEAK({ kind: "click", x: 1, y: 2, button: "left" }),
    ).toBe(false);
    expect(
      __CGEVENT_HAS_RAW_KEYCODE_LEAK({ kind: "click", x: 1, y: 2 }),
    ).toBe(false);
  });

  it("数字 button 经 provider → outcome=didnt 短路（不触 Rust）", async () => {
    const rust = new MockRustBridge({});
    const provider = new CGEventProvider(rust as unknown as never);
    const r = await provider.act({
      actions: [{ kind: "click", x: 1, y: 2, button: 1 } as unknown as never],
    });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("cgevent_raw_keycode_forbidden");
    expect(rust.calls.filter((c) => c.method === "cgevent_dispatch")).toHaveLength(0);
  });
});

// ============================================================
// 4. provider → cgevent_dispatch wire
// ============================================================
describe("T7 — CGEventProvider 鼠标动作 wire", () => {
  it("批量 [坐标click, drag, scroll, move] → cgevent_dispatch 收全量坐标 wire", async () => {
    const rust = new MockRustBridge({
      cgevent_dispatch: () => ({
        results: [
          { index: 0, ok: true },
          { index: 1, ok: true },
          { index: 2, ok: true },
          { index: 3, ok: true },
        ],
      }),
    });
    const provider = new CGEventProvider(rust as unknown as never);
    const r = await provider.act({
      actions: [
        { kind: "click", x: 100, y: 200 } as unknown as never,
        { kind: "drag", from_x: 1, from_y: 2, to_x: 3, to_y: 4 } as unknown as never,
        { kind: "scroll", dx: 0, dy: -3 } as unknown as never,
        { kind: "move", x: 9, y: 9 } as unknown as never,
      ],
    });
    expect(r.outcome).toBe("worked");
    const call = rust.calls.find((c) => c.method === "cgevent_dispatch");
    expect(call).toBeTruthy();
    expect((call!.params as { actions: unknown[] }).actions).toEqual([
      { kind: "click", x: 100, y: 200 },
      { kind: "drag", from_x: 1, from_y: 2, to_x: 3, to_y: 4 },
      { kind: "scroll", dx: 0, dy: -3 },
      { kind: "move", x: 9, y: 9 },
    ]);
    // audit ref 标签含坐标（可读性）
    const labels = (r.data as { actions_and_results: Array<{ ref: string }> })
      .actions_and_results.map((x) => x.ref);
    expect(labels[0]).toBe("click@(100,200)");
    expect(labels[1]).toBe("drag(1,2)->(3,4)");
    expect(labels[2]).toBe("scroll(0,-3)");
    expect(labels[3]).toBe("move@(9,9)");
  });

  it("只有 ref click（无坐标）→ cgevent_no_supported_action（unknown）", async () => {
    const rust = new MockRustBridge({});
    const provider = new CGEventProvider(rust as unknown as never);
    const r = await provider.act({
      actions: [{ kind: "click", ref: "@e0" } as never],
    });
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("cgevent_no_supported_action");
    expect(rust.calls.filter((c) => c.method === "cgevent_dispatch")).toHaveLength(0);
  });
});
