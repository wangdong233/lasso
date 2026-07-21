/**
 * desktop-types.spec.ts（parse4 §5.2 desktop-options.spec.ts）
 *
 * 守护 desktop-types.ts 的 schema 校验函数：
 *  - isRect / isAxNode / isOutlineNode / isUiAction
 *  - shape 漂移会被这些函数挡住（守护 wire-shape 不变）
 *
 * 也守护 INV-21：desktop-types.ts 不含平台 API 字面量（grep 自检）。
 */
import { describe, it, expect } from "vitest";
import {
  isRect,
  isAxNode,
  isOutlineNode,
  isUiAction,
  type Rect,
  type AxNode,
  type OutlineNode,
  type UiAction,
} from "../../src/desktop/desktop-types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ============================================================
// helpers
// ============================================================
const goodRect: Rect = { x: 0, y: 0, w: 100, h: 100 };

function makeAx(overrides: Partial<AxNode> = {}): AxNode {
  return {
    role: "button",
    raw_role: "AXButton",
    label: "OK",
    rect: goodRect,
    enabled: true,
    focused: false,
    depth: 0,
    children: [],
    ...overrides,
  };
}

function makeOutline(overrides: Partial<OutlineNode> = {}): OutlineNode {
  return {
    role: "button",
    label: "OK",
    ref: "@e0",
    rect: goodRect,
    pictureOnly: false,
    children: [],
    ...overrides,
  };
}

// ============================================================
// isRect
// ============================================================
describe("isRect", () => {
  it("合法 Rect → true", () => {
    expect(isRect({ x: 1, y: 2, w: 3, h: 4 })).toBe(true);
    expect(isRect({ x: 0, y: 0, w: 0, h: 0 })).toBe(true);
    expect(isRect({ x: -1.5, y: 2.5, w: 100, h: 200 })).toBe(true);
  });

  it("缺字段 → false", () => {
    expect(isRect({ x: 1, y: 2, w: 3 })).toBe(false);
    expect(isRect({})).toBe(false);
  });

  it("类型错 → false", () => {
    expect(isRect({ x: "0", y: 0, w: 0, h: 0 })).toBe(false);
    expect(isRect({ x: NaN, y: 0, w: 0, h: 0 })).toBe(true); // NaN 是 number 类型
    expect(isRect(null)).toBe(false);
    expect(isRect(undefined)).toBe(false);
    expect(isRect("rect")).toBe(false);
  });
});

// ============================================================
// isAxNode
// ============================================================
describe("isAxNode", () => {
  it("合法 AxNode（叶子）→ true", () => {
    expect(isAxNode(makeAx())).toBe(true);
  });

  it("合法 AxNode（带 children 递归）→ true", () => {
    const tree = makeAx({
      children: [makeAx({ depth: 1 }), makeAx({ depth: 1, children: [makeAx({ depth: 2 })] })],
    });
    expect(isAxNode(tree)).toBe(true);
  });

  it("缺字段 → false", () => {
    expect(isAxNode({ role: "button" })).toBe(false);
    expect(isAxNode({ ...makeAx(), rect: null })).toBe(false);
  });

  it("类型错（children 不是数组）→ false", () => {
    expect(isAxNode({ ...makeAx(), children: "not-array" })).toBe(false);
  });

  it("子节点不合法 → false（递归校验）", () => {
    const bad = makeAx({
      children: [{ role: "text" /* 缺字段 */ } as unknown as AxNode],
    });
    expect(isAxNode(bad)).toBe(false);
  });
});

// ============================================================
// isOutlineNode
// ============================================================
describe("isOutlineNode", () => {
  it("合法 OutlineNode（叶子）→ true", () => {
    expect(isOutlineNode(makeOutline())).toBe(true);
  });

  it("合法 OutlineNode（带 children 递归）→ true", () => {
    const tree = makeOutline({
      children: [makeOutline({ ref: "@e1" })],
    });
    expect(isOutlineNode(tree)).toBe(true);
  });

  it("缺 pictureOnly → false", () => {
    const o = makeOutline() as unknown as Record<string, unknown>;
    delete o.pictureOnly;
    expect(isOutlineNode(o)).toBe(false);
  });

  it("pictureOnly 非布尔 → false", () => {
    expect(
      isOutlineNode({ ...makeOutline(), pictureOnly: "yes" }),
    ).toBe(false);
  });

  it("子节点不合法 → false（递归校验）", () => {
    const bad = makeOutline({
      children: [{ role: "x" /* 缺字段 */ } as unknown as OutlineNode],
    });
    expect(isOutlineNode(bad)).toBe(false);
  });
});

// ============================================================
// isUiAction
// ============================================================
describe("isUiAction — 判别联合", () => {
  it("click: { kind:'click', ref }", () => {
    expect(isUiAction({ kind: "click", ref: "@e1" })).toBe(true);
    expect(isUiAction({ kind: "click" })).toBe(false);
    expect(isUiAction({ kind: "click", ref: 1 })).toBe(false);
  });

  it("type: { kind:'type', ref, text }", () => {
    const a: UiAction = { kind: "type", ref: "@e2", text: "hello" };
    expect(isUiAction(a)).toBe(true);
    expect(isUiAction({ kind: "type", ref: "@e2" })).toBe(false);
    expect(isUiAction({ kind: "type", ref: "@e2", text: 42 })).toBe(false);
  });

  it("press: { kind:'press', key }", () => {
    expect(isUiAction({ kind: "press", key: "Return" })).toBe(true);
    expect(isUiAction({ kind: "press" })).toBe(false);
  });

  it("scroll: { kind:'scroll', ref, dx, dy }", () => {
    expect(isUiAction({ kind: "scroll", ref: "@e3", dx: 0, dy: 100 })).toBe(true);
    expect(isUiAction({ kind: "scroll", ref: "@e3", dx: 0 })).toBe(false);
    expect(isUiAction({ kind: "scroll", ref: "@e3", dx: "0", dy: 0 })).toBe(false);
  });

  it("hotkey: { kind:'hotkey', keys:string[] }", () => {
    expect(isUiAction({ kind: "hotkey", keys: ["cmd", "c"] })).toBe(true);
    expect(isUiAction({ kind: "hotkey", keys: ["cmd", 1] })).toBe(false);
    expect(isUiAction({ kind: "hotkey", keys: "cmd+c" })).toBe(false);
  });

  it("未知 kind → false", () => {
    expect(isUiAction({ kind: "tap", ref: "@e1" })).toBe(false);
    expect(isUiAction({})).toBe(false);
    expect(isUiAction(null)).toBe(false);
  });
});

// ============================================================
// INV-21 自检：src/desktop/desktop-types.ts 不含平台 API 字面量
// ============================================================
describe("INV-21 — desktop-types.ts 不含平台 API 字面量", () => {
  it("源文件不出现平台调用符号（去掉注释后的代码体）", () => {
    const filePath = fileURLToPath(
      new URL("../../src/desktop/desktop-types.ts", import.meta.url),
    );
    const text = readFileSync(filePath, "utf8");
    // 去掉注释行（// 开头）和块注释（/* */），只扫代码本体
    const codeOnly = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // 平台 API 调用符号禁止出现在 TS 层代码本体
    // （注释里讨论这些符号是允许的——铁律的语义是"代码不调平台 API"）
    expect(codeOnly).not.toMatch(/AXUIElement|CGEvent|AXPress[A-Z]|AXUIElementCreateSystemWide/);
  });
});
