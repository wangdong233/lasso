/**
 * outline-mapper.spec.ts（parse4 §5.2 + §4.3 + §4.4）
 *
 * 守护 axTreeToOutline 的：
 *  1. AX→OutlineNode 形状映射（role / label / rect 透传）
 *  2. @eN ref 分配（DFS 前序，0-based，单调递增）
 *  3. pictureOnly 三启发式（parse4 §4.4）：
 *       (1) role=img 且 rect>100x100 且无 children → true
 *       (2) role=unknown 且 rect>100x100 且无 children → true
 *       (3) role=group 且 label="" 且 rect>100x100 且无 children → true
 *  4. refCounter 返回值 = 分配总数
 *  5. 不读 raw_role（INV-21 守护）
 */
import { describe, it, expect } from "vitest";
import {
  axTreeToOutline,
  isPictureOnly,
} from "../../src/desktop/OutlineMapper.js";
import type { AxNode } from "../../src/desktop/desktop-types.js";

// ============================================================
// helpers
// ============================================================
function makeNode(
  overrides: Partial<AxNode> & { children?: AxNode[] } = {},
): AxNode {
  return {
    role: "button",
    raw_role: "AXButton",
    label: "",
    rect: { x: 0, y: 0, w: 10, h: 10 },
    enabled: true,
    focused: false,
    depth: 0,
    children: [],
    ...overrides,
  };
}

// ============================================================
// 1. 形状 + 透传
// ============================================================
describe("axTreeToOutline — 形状映射", () => {
  it("root 单节点：role / label / rect 透传 + ref=@e0", () => {
    const root = makeNode({
      role: "button",
      label: "OK",
      rect: { x: 10, y: 20, w: 80, h: 30 },
    });
    const { root: outline, refCounter } = axTreeToOutline(root);
    expect(outline.role).toBe("button");
    expect(outline.label).toBe("OK");
    expect(outline.rect).toEqual({ x: 10, y: 20, w: 80, h: 30 });
    expect(outline.ref).toBe("@e0");
    expect(outline.pictureOnly).toBe(false);
    expect(outline.children).toEqual([]);
    expect(refCounter).toBe(1);
  });

  it("children 递归（深度优先前序）", () => {
    const root = makeNode({
      children: [
        makeNode({ role: "text", label: "child-1" }),
        makeNode({
          role: "group",
          children: [
            makeNode({ role: "text", label: "grandchild-1" }),
            makeNode({ role: "text", label: "grandchild-2" }),
          ],
        }),
      ],
    });
    const { root: outline, refCounter } = axTreeToOutline(root);
    expect(outline.ref).toBe("@e0");
    expect(outline.children[0].ref).toBe("@e1");
    expect(outline.children[1].ref).toBe("@e2");
    expect(outline.children[1].children[0].ref).toBe("@e3");
    expect(outline.children[1].children[1].ref).toBe("@e4");
    expect(refCounter).toBe(5);
  });
});

// ============================================================
// 2. ref 分配
// ============================================================
describe("axTreeToOutline — ref 分配", () => {
  it("DFS 前序单调递增（0-based）", () => {
    const root = makeNode({
      children: [
        makeNode(),
        makeNode({
          children: [makeNode(), makeNode()],
        }),
        makeNode(),
      ],
    });
    const refs: string[] = [];
    const collect = (n: { ref: string; children: typeof n[] }) => {
      refs.push(n.ref);
      n.children.forEach(collect);
    };
    const { root: outline } = axTreeToOutline(root);
    collect(outline as unknown as { ref: string; children: unknown[] } as never);
    // DFS 前序：root, child-0, child-1, grandchild-0, grandchild-1, child-2
    expect(refs).toEqual(["@e0", "@e1", "@e2", "@e3", "@e4", "@e5"]);
  });

  it("空树（root 无 children）只分 1 个 ref", () => {
    const { refCounter } = axTreeToOutline(makeNode());
    expect(refCounter).toBe(1);
  });
});

// ============================================================
// 3. pictureOnly 三启发式（parse4 §4.4）
// ============================================================
describe("isPictureOnly — 启发式 (1): role=img", () => {
  it("img + 大尺寸 + 无 children → true", () => {
    const n = makeNode({
      role: "img",
      rect: { x: 0, y: 0, w: 200, h: 150 },
    });
    expect(isPictureOnly(n, 0)).toBe(true);
  });

  it("img + 大尺寸 + 有 children → false（不退化）", () => {
    const n = makeNode({
      role: "img",
      rect: { x: 0, y: 0, w: 200, h: 150 },
    });
    expect(isPictureOnly(n, 1)).toBe(false);
  });

  it("img + 小尺寸（<=100）→ false", () => {
    const n = makeNode({
      role: "img",
      rect: { x: 0, y: 0, w: 100, h: 100 },
    });
    expect(isPictureOnly(n, 0)).toBe(false);
  });

  it("img + 仅一边 >100 → false（需同时 w>100 且 h>100）", () => {
    const n = makeNode({
      role: "img",
      rect: { x: 0, y: 0, w: 200, h: 50 },
    });
    expect(isPictureOnly(n, 0)).toBe(false);
  });
});

describe("isPictureOnly — 启发式 (2): role=unknown（canvas/Metal 候选）", () => {
  it("unknown + 大尺寸 + 无 children → true", () => {
    const n = makeNode({
      role: "unknown",
      rect: { x: 0, y: 0, w: 500, h: 500 },
    });
    expect(isPictureOnly(n, 0)).toBe(true);
  });

  it("unknown + 小尺寸 → false", () => {
    const n = makeNode({
      role: "unknown",
      rect: { x: 0, y: 0, w: 50, h: 50 },
    });
    expect(isPictureOnly(n, 0)).toBe(false);
  });
});

describe("isPictureOnly — 启发式 (3): role=group + label 空大空白", () => {
  it("group + label='' + 大尺寸 + 无 children → true（storyboard canvas 近似）", () => {
    const n = makeNode({
      role: "group",
      label: "",
      rect: { x: 0, y: 0, w: 800, h: 600 },
    });
    expect(isPictureOnly(n, 0)).toBe(true);
  });

  it("group + label 非空 → false（有名字的 group 不是 canvas 候选）", () => {
    const n = makeNode({
      role: "group",
      label: "Toolbar Group",
      rect: { x: 0, y: 0, w: 800, h: 600 },
    });
    expect(isPictureOnly(n, 0)).toBe(false);
  });

  it("group + label 空 + 小尺寸 → false", () => {
    const n = makeNode({
      role: "group",
      label: "",
      rect: { x: 0, y: 0, w: 50, h: 50 },
    });
    expect(isPictureOnly(n, 0)).toBe(false);
  });
});

describe("isPictureOnly — 其他 role 不标", () => {
  it("button 大尺寸 + 无 children → false", () => {
    const n = makeNode({
      role: "button",
      rect: { x: 0, y: 0, w: 500, h: 500 },
    });
    expect(isPictureOnly(n, 0)).toBe(false);
  });

  it("window 大尺寸 + 无 children → false（window 不是 canvas 候选）", () => {
    const n = makeNode({
      role: "window",
      rect: { x: 0, y: 0, w: 1920, h: 1080 },
    });
    expect(isPictureOnly(n, 0)).toBe(false);
  });
});

// ============================================================
// 4. axTreeToOutline 集成 pictureOnly
// ============================================================
describe("axTreeToOutline — pictureOnly 集成", () => {
  it("AXImage + 大尺寸映射为 pictureOnly=true 的 OutlineNode", () => {
    // Rust 端把 AXImage → "img"，TS OutlineMapper 据 "img" 判定
    const root = makeNode({
      role: "img",
      raw_role: "AXImage",
      rect: { x: 0, y: 0, w: 300, h: 200 },
    });
    const { root: outline } = axTreeToOutline(root);
    expect(outline.role).toBe("img");
    expect(outline.pictureOnly).toBe(true);
  });

  it("嵌套树：pictureOnly 在叶子生效，父节点（有 children）不标", () => {
    const root = makeNode({
      role: "group",
      label: "",
      rect: { x: 0, y: 0, w: 1000, h: 800 },
      children: [
        makeNode({
          role: "img",
          rect: { x: 0, y: 0, w: 200, h: 200 },
        }),
      ],
    });
    const { root: outline } = axTreeToOutline(root);
    // 父 group 有 children → 不标 pictureOnly
    expect(outline.pictureOnly).toBe(false);
    // 子 img 大尺寸 + 无 children → 标 pictureOnly
    expect(outline.children[0].pictureOnly).toBe(true);
  });
});

// ============================================================
// 5. INV-21 守护：OutlineMapper 不读 raw_role
// ============================================================
describe("axTreeToOutline — INV-21 守护", () => {
  it("OutlineNode 不含 raw_role 字段", () => {
    const root = makeNode({ raw_role: "AXButton" });
    const { root: outline } = axTreeToOutline(root);
    // OutlineNode 不应有 raw_role 键
    expect(outline).not.toHaveProperty("raw_role");
    expect(Object.keys(outline).sort()).toEqual(
      ["children", "label", "pictureOnly", "rect", "ref", "role"].sort(),
    );
  });
});
