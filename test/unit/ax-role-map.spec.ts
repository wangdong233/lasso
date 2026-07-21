/**
 * ax-role-map.spec.ts（parse4 §5.2）
 *
 * 守护 TS 端 AX_ROLE_MAP 与 Rust 端 ax_role_map.rs 1:1 镜像。
 * 任何在 Rust 端增改的映射项必须在 TS 端同步；反之亦然。
 *
 * 覆盖：
 *  - 全部已映射 AXRole → 对应 unified role（与 Rust 端 tests/maps_known_roles 同 case）
 *  - 未映射 AXRole → "unknown" fallback
 *  - 空串 → "unknown"
 *  - AXApplication / AXSystemWide → application / systemwide（doctor 用）
 */
import { describe, it, expect } from "vitest";
import {
  AX_ROLE_MAP,
  mapAxRole,
} from "../../src/desktop/ax-role-map.js";

describe("ax-role-map — known roles（与 Rust ax_role_map.rs::tests 同步）", () => {
  // 与 rust-helper/src/ax_role_map.rs::tests::maps_known_roles 字段对齐
  const cases: Array<[string, string]> = [
    // Buttons / actions
    ["AXButton", "button"],
    ["AXPopUpButton", "select"],
    ["AXCheckBox", "checkbox"],
    ["AXRadioButton", "radio"],
    ["AXMenuButton", "menubutton"],
    // Text
    ["AXTextField", "textfield"],
    ["AXTextArea", "textarea"],
    ["AXStaticText", "text"],
    // Menus
    ["AXMenu", "menu"],
    ["AXMenuItem", "menuitem"],
    ["AXMenuBar", "menubar"],
    ["AXMenuBarItem", "menubaritem"],
    // Windows / sheets
    ["AXWindow", "window"],
    ["AXSheet", "dialog"],
    ["AXPopover", "popover"],
    // Lists / trees / tables
    ["AXRow", "row"],
    ["AXOutline", "tree"],
    ["AXList", "list"],
    ["AXTable", "table"],
    // Layout / groups
    ["AXScrollArea", "scrollarea"],
    ["AXTabGroup", "tablist"],
    ["AXToolbar", "toolbar"],
    ["AXGroup", "group"],
    ["AXLayoutArea", "group"],
    // Media
    ["AXImage", "img"],
    ["AXLink", "link"],
    // Generic / unknown
    ["AXUnknown", "unknown"],
    // Generic 应用级
    ["AXApplication", "application"],
    ["AXSystemWide", "systemwide"],
  ];

  for (const [ax, unified] of cases) {
    it(`mapAxRole("${ax}") === "${unified}"`, () => {
      expect(mapAxRole(ax)).toBe(unified);
      // 同步：表也必须有这一项
      expect(AX_ROLE_MAP[ax]).toBe(unified);
    });
  }
});

describe("ax-role-map — fallback", () => {
  it("未映射的 AXRole → 'unknown'", () => {
    expect(mapAxRole("AXSomeNewRole")).toBe("unknown");
  });

  it("空串 → 'unknown'", () => {
    expect(mapAxRole("")).toBe("unknown");
  });

  it("undefined-ish 输入不崩（守运行时 shape）", () => {
    // 强转 any 模拟 wire 漂移；mapAxRole 仍返回 unknown
    expect(mapAxRole(undefined as unknown as string)).toBe("unknown");
    expect(mapAxRole(null as unknown as string)).toBe("unknown");
  });
});

describe("ax-role-map — INV-21 自检", () => {
  it("AX_ROLE_MAP 不含平台 API 调用符号（AXUIElement/CGEvent/AXPress）", () => {
    // keys 中不应出现平台 API 调用符号（AX* 角色字符串是允许的数据值）
    const keys = Object.keys(AX_ROLE_MAP).join("|");
    expect(keys).not.toMatch(/AXUIElement|CGEvent|AXPress|AXUIElementCreate/);
  });

  it("unified values 不含平台前缀（应是 DOM-like）", () => {
    for (const v of Object.values(AX_ROLE_MAP)) {
      expect(v.startsWith("AX")).toBe(false);
      expect(v.startsWith("CG")).toBe(false);
    }
  });
});
