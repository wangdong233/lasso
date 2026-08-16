/**
 * desktop-skeleton.spec.ts（v1.11 round1 T8 —— walk 剪枝 v2）
 *
 * 验收（round1-verdict T8）：
 *  1. skeleton 默认关 → 默认路径 byte-identical（wire 无 skeleton 参数、
 *     OutlineNode 无 childrenCount 字段）
 *  2. skeleton 开 → wire 含 skeleton:true；OutlineMapper 透传 childrenCount
 *  3. isOutlineNode 接受可选 childrenCount（形状校验不破）
 *  4. web wrapper 深度中和在 Rust 端完成（TS 零感知——源码级断言）
 *  5. 防环 visited 集合在 Rust 端（CI 无 GUI 不可合成环 → 源码级断言 + 手测清单）
 */
import { describe, it, expect } from "vitest";
import { AxProvider } from "../../src/desktop/AxProvider.js";
import { axTreeToOutline } from "../../src/desktop/OutlineMapper.js";
import { isOutlineNode } from "../../src/desktop/desktop-types.js";
import type { AxNode, OutlineNode } from "../../src/desktop/desktop-types.js";
import { MockRustBridge } from "./mocks/mock-rust-bridge.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ============================================================
// helpers
// ============================================================
function mockAxTree(withCount = false): AxNode {
  return {
    role: "window",
    raw_role: "AXWindow",
    label: "App",
    rect: { x: 0, y: 0, w: 800, h: 600 },
    enabled: true,
    focused: true,
    depth: 0,
    children: [
      {
        role: "button",
        raw_role: "AXButton",
        label: "OK",
        rect: { x: 1, y: 1, w: 60, h: 30 },
        enabled: true,
        focused: false,
        depth: 1,
        children: [],
        // skeleton 边界节点带 childrenCount（Rust 端填）
        ...(withCount ? { childrenCount: 42 } : {}),
      },
    ],
  };
}

// ============================================================
// 1. skeleton 默认关 → byte-identical
// ============================================================
describe("T8 — skeleton 默认关（byte-identical v1.10）", () => {
  it("AxProvider.snapshot 不传 skeleton → wire 无 skeleton 字段", async () => {
    const rust = new MockRustBridge({
      ax_snapshot: () => mockAxTree(),
    });
    const provider = new AxProvider({
      snapshot: async (app: string | undefined, maxDepth: number, skeleton?: boolean) => {
        rust.calls.push({
          method: "ax_snapshot",
          params: { app, max_depth: maxDepth, ...(skeleton ? { skeleton } : {}) },
        });
        return { id: "t", ok: true, result: mockAxTree() };
      },
      find: async () => ({ id: "t", ok: true, result: {} }),
      act: async () => ({ id: "t", ok: true, result: {} }),
    } as never);
    const r = await provider.snapshot({});
    expect(r.outcome).toBe("worked");
    const call = rust.calls.find((c) => c.method === "ax_snapshot");
    expect(JSON.stringify(call!.params)).not.toContain("skeleton");
    // OutlineNode 无 childrenCount 字段
    const root = r.data!.root as OutlineNode;
    expect(JSON.stringify(root)).not.toContain("childrenCount");
  });
});

// ============================================================
// 2. skeleton 开 → wire + OutlineNode.childrenCount
// ============================================================
describe("T8 — skeleton 开（边界 childrenCount）", () => {
  it("opts.skeleton=true → wire 含 skeleton:true", async () => {
    const rust = new MockRustBridge({
      ax_snapshot: () => mockAxTree(true),
    });
    const { MacAxBackend } = await import("../../src/desktop/AxBackend.js");
    const provider = new AxProvider(
      new MacAxBackend(rust as unknown as never),
    );
    const r = await provider.snapshot({ skeleton: true });
    expect(r.outcome).toBe("worked");
    const call = rust.calls.find((c) => c.method === "ax_snapshot");
    expect((call!.params as Record<string, unknown>).skeleton).toBe(true);
    // OutlineMapper 透传 childrenCount
    const btn = (r.data!.root as OutlineNode).children[0]!;
    expect(btn.childrenCount).toBe(42);
  });

  it("AxNode 无 childrenCount → OutlineNode 也无（无假数据）", () => {
    const { root } = axTreeToOutline(mockAxTree(false));
    expect((root.children[0] as OutlineNode).childrenCount).toBeUndefined();
  });
});

// ============================================================
// 3. isOutlineNode 形状校验兼容
// ============================================================
describe("T8 — isOutlineNode 兼容 childrenCount", () => {
  it("有/无 childrenCount 的 OutlineNode 都过形状校验", () => {
    const withCount = {
      role: "group",
      label: "",
      ref: "@e0",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      pictureOnly: false,
      children: [],
      childrenCount: 7,
    };
    const withoutCount = { ...withCount, childrenCount: undefined };
    expect(isOutlineNode(withCount)).toBe(true);
    expect(isOutlineNode(withoutCount)).toBe(true);
    // 类型错拒绝
    expect(isOutlineNode({ ...withCount, childrenCount: "many" })).toBe(false);
  });
});

// ============================================================
// 4/5. Rust 端机制源码级断言（CI 无 GUI 不可真机验）
// ============================================================
describe("T8 — Rust 端机制（源码级断言；真机归手测清单）", () => {
  function rustSource(): string {
    const filePath = fileURLToPath(
      new URL("../../rust-helper/src/ax.rs", import.meta.url),
    );
    return readFileSync(filePath, "utf8");
  }

  it("walk 带 visited 指针集合（防环）+ cycle 占位节点", () => {
    const src = rustSource();
    expect(src).toMatch(/visited.*contains.*ptr_id/);
    expect(src).toMatch(/AXCycleGuard/);
    // review03 F4：HashSet O(1) 插入（dense app 数万节点下 Vec::contains O(n²) 是延迟地雷）
    expect(src).toMatch(/visited\.insert\(ptr_id\)/);
    expect(src).toMatch(/HashSet<usize>/);
    expect(src).not.toMatch(/visited\.push\(ptr_id\)/);
  });

  it("web wrapper 深度中和：is_web_wrapper + 子代深度不 +1", () => {
    const src = rustSource();
    expect(src).toMatch(/fn is_web_wrapper/);
    expect(src).toMatch(/AXGroup.*AXGenericElement|AXGenericElement.*AXGroup/);
    // child_depth = wrapper 时保持同深度
    expect(src).toMatch(/if wrapper \{ depth \} else \{ depth \+ 1 \}/);
  });

  it("skeleton 边界：children_count 只在 skeleton=true 填（skip_serializing_if 兜底）", () => {
    const src = rustSource();
    expect(src).toMatch(/skip_serializing_if = "Option::is_none"/);
    expect(src).toMatch(/if skeleton/);
    expect(src).toMatch(/children_count = Some/);
  });
});
