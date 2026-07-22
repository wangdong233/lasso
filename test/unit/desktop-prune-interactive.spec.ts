/**
 * OutlineMapper.pruneToInteractive 单测（v1.2 doc/14 §4.2d Lightpanda-inspired）。
 *
 * 守 INV-70：interactiveOnly opt-in 后处理，默认不过滤 byte-identical v1.1。
 */
import { describe, it, expect } from "vitest";
import {
  axTreeToOutline,
  pruneToInteractive,
  isInteractiveRole,
} from "../../src/desktop/OutlineMapper.js";
import type { AxNode, OutlineNode } from "../../src/desktop/desktop-types.js";

/** 构造 AxNode fixture：app > window > [toolbar(button,button), text("hi"), group(text("deep"))] */
function fixtureTree(): AxNode {
  return {
    role: "application",
    raw_role: "AXApplication",
    label: "App",
    rect: { x: 0, y: 0, w: 1000, h: 800 },
    enabled: true,
    focused: false,
    depth: 0,
    children: [
      {
        role: "window",
        raw_role: "AXWindow",
        label: "Win",
        rect: { x: 0, y: 0, w: 1000, h: 800 },
        enabled: true,
        focused: true,
        depth: 1,
        children: [
          {
            role: "toolbar",
            raw_role: "AXToolbar",
            label: "",
            rect: { x: 0, y: 0, w: 1000, h: 40 },
            enabled: true,
            focused: false,
            depth: 2,
            children: [
              {
                role: "button",
                raw_role: "AXButton",
                label: "Save",
                rect: { x: 10, y: 5, w: 60, h: 30 },
                enabled: true,
                focused: false,
                depth: 3,
                children: [],
              },
              {
                role: "button",
                raw_role: "AXButton",
                label: "Cancel",
                rect: { x: 80, y: 5, w: 60, h: 30 },
                enabled: true,
                focused: false,
                depth: 3,
                children: [],
              },
            ],
          },
          {
            role: "text",
            raw_role: "AXStaticText",
            label: "just some static text",
            rect: { x: 10, y: 50, w: 200, h: 20 },
            enabled: true,
            focused: false,
            depth: 2,
            children: [],
          },
          {
            role: "group",
            raw_role: "AXGroup",
            label: "",
            rect: { x: 10, y: 80, w: 200, h: 100 },
            enabled: true,
            focused: false,
            depth: 2,
            children: [
              {
                role: "text",
                raw_role: "AXStaticText",
                label: "deep non-interactive leaf",
                rect: { x: 10, y: 80, w: 100, h: 20 },
                enabled: true,
                focused: false,
                depth: 3,
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** 收集树中所有 role（用于断言剪枝后剩什么）。 */
function collectRoles(n: OutlineNode, out: string[] = []): string[] {
  out.push(n.role);
  for (const c of n.children) collectRoles(c, out);
  return out;
}

describe("pruneToInteractive (v1.2 doc/14 §4.2d)", () => {
  it("isInteractiveRole：button/link/textfield 等为 true；text/group/window 为 false", () => {
    expect(isInteractiveRole("button")).toBe(true);
    expect(isInteractiveRole("link")).toBe(true);
    expect(isInteractiveRole("textfield")).toBe(true);
    expect(isInteractiveRole("checkbox")).toBe(true);
    expect(isInteractiveRole("select")).toBe(true);
    expect(isInteractiveRole("menuitem")).toBe(true);
    expect(isInteractiveRole("text")).toBe(false);
    expect(isInteractiveRole("group")).toBe(false);
    expect(isInteractiveRole("window")).toBe(false);
    expect(isInteractiveRole("toolbar")).toBe(false);
    expect(isInteractiveRole("unknown")).toBe(false);
  });

  it("剪掉纯文本/无交互后代的 group；保留 button + 其祖先（toolbar/window/app）", () => {
    const { root } = axTreeToOutline(fixtureTree());
    // 未剪枝前含 text + 无交互 group
    expect(collectRoles(root)).toContain("text");
    expect(collectRoles(root)).toContain("group");

    const pruned = pruneToInteractive(root);
    const roles = collectRoles(pruned);
    // 可交互元素保留
    expect(roles.filter((r) => r === "button").length).toBe(2);
    // 祖先保留（root app + window + toolbar 容纳 button）
    expect(roles).toContain("application");
    expect(roles).toContain("window");
    expect(roles).toContain("toolbar");
    // 纯 text 叶子被剪
    expect(roles.filter((r) => r === "text").length).toBe(0);
    // 无交互后代的 group 被剪（它只包了一个 text 叶子，整支无交互）
    expect(roles.filter((r) => r === "group").length).toBe(0);
  });

  it("root 永远保留（即使整棵树无交互元素）", () => {
    const noInteractive: AxNode = {
      role: "application",
      raw_role: "AXApplication",
      label: "App",
      rect: { x: 0, y: 0, w: 10, h: 10 },
      enabled: true,
      focused: false,
      depth: 0,
      children: [
        {
          role: "text",
          raw_role: "AXStaticText",
          label: "no buttons here",
          rect: { x: 0, y: 0, w: 10, h: 10 },
          enabled: true,
          focused: false,
          depth: 1,
          children: [],
        },
      ],
    };
    const { root } = axTreeToOutline(noInteractive);
    const pruned = pruneToInteractive(root);
    // root 保留
    expect(pruned.role).toBe("application");
    // text 子被剪（无交互）
    expect(pruned.children.length).toBe(0);
  });

  it("不改原树（纯函数；原 root 的 children 仍含被剪节点）", () => {
    const { root } = axTreeToOutline(fixtureTree());
    const originalTextCount = collectRoles(root).filter((r) => r === "text").length;
    const pruned = pruneToInteractive(root);
    // 剪后无 text
    expect(collectRoles(pruned).filter((r) => r === "text").length).toBe(0);
    // 原树不变（仍有 text）
    expect(collectRoles(root).filter((r) => r === "text").length).toBe(originalTextCount);
    expect(originalTextCount).toBeGreaterThan(0);
  });

  it("保留含交互后代的 group（剪掉 sibling 纯文本，留 group+其内 button）", () => {
    const tree: AxNode = {
      role: "application",
      raw_role: "AXApplication",
      label: "App",
      rect: { x: 0, y: 0, w: 100, h: 100 },
      enabled: true,
      focused: false,
      depth: 0,
      children: [
        {
          role: "group",
          raw_role: "AXGroup",
          label: "form",
          rect: { x: 0, y: 0, w: 100, h: 50 },
          enabled: true,
          focused: false,
          depth: 1,
          children: [
            {
              role: "textfield",
              raw_role: "AXTextField",
              label: "email",
              rect: { x: 0, y: 0, w: 80, h: 20 },
              enabled: true,
              focused: false,
              depth: 2,
              children: [],
            },
          ],
        },
        {
          role: "text",
          raw_role: "AXStaticText",
          label: "static blurb",
          rect: { x: 0, y: 60, w: 80, h: 20 },
          enabled: true,
          focused: false,
          depth: 1,
          children: [],
        },
      ],
    };
    const { root } = axTreeToOutline(tree);
    const pruned = pruneToInteractive(root);
    const roles = collectRoles(pruned);
    // group 保留（含 textfield 后代）
    expect(roles).toContain("group");
    expect(roles).toContain("textfield");
    // sibling 纯文本剪
    expect(roles.filter((r) => r === "text").length).toBe(0);
  });
});
