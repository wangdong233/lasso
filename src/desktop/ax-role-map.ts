/**
 * AXRole → unified role 映射表（parse4 §4.3）
 *
 * 与 rust-helper/src/ax_role_map.rs **field-by-field 镜像**。
 * 同一个 AXRole 字符串在两端必须映射到相同的 unified role。
 *
 * 维护规则（铁律）：
 *  1. Rust 端增改 → TS 端同步增改（反之亦然）
 *  2. 覆盖率验证：M0.5a 采 10 个 native app 各 3 window 验证 ≥80%
 *     （13 §3.4 M0.5a 第 3 条）
 *  3. fallback：未在表内的 AXRole 一律 → "unknown"
 *
 * INV-21 注：本表 key 是 AXRole 字符串值（数据值，从 AXAPI 流入），
 * 不是平台 API 名（如 AXUIElement / AXPress）。这些 AX* 字符串是苹果
 * 已公开的 role 标识符（数据契约），不是 API 调用符号。为可读性 + 与
 * Rust 端 1:1 对账可读，本表保留 "AX" 前缀；它们是 wire 上的数据字典。
 * 真正隔离在 Rust 的是 AXUIElement* / CGEvent* / AXPress 等 API 调用符号。
 *
 * 借鉴：13 §4.3；WAI-ARIA role 标准（DOM-like 命名）；08 附录 A。
 */

// ============================================================
// 映射表（与 ax_role_map.rs match 项 1:1）
// ============================================================
export const AX_ROLE_MAP: Record<string, string> = {
  // Buttons / actions
  AXButton: "button",
  AXPopUpButton: "select",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXMenuButton: "menubutton",
  // Text
  AXTextField: "textfield",
  AXTextArea: "textarea",
  AXStaticText: "text",
  // Menus
  AXMenu: "menu",
  AXMenuItem: "menuitem",
  AXMenuBar: "menubar",
  AXMenuBarItem: "menubaritem",
  // Windows / sheets
  AXWindow: "window",
  AXSheet: "dialog", // modal sheet
  AXPopover: "popover",
  // Lists / trees / tables
  AXRow: "row",
  AXOutline: "tree",
  AXList: "list",
  AXTable: "table",
  // Layout / groups
  AXScrollArea: "scrollarea",
  AXTabGroup: "tablist",
  AXToolbar: "toolbar",
  AXGroup: "group",
  AXLayoutArea: "group", // Xcode storyboard canvas
  // Media
  AXImage: "img",
  AXLink: "link",
  // Generic / unknown
  AXUnknown: "unknown",
  // Generic 应用级角色兜底（非 DOM 角色；保留原值便于 doctor 报告）
  AXApplication: "application",
  AXSystemWide: "systemwide",
};

/**
 * AXRole 字符串 → unified role。未在表内的 AXRole 一律 → "unknown"。
 *
 * 与 Rust 端 `map_ax_role(ax: &str) -> &'static str` 同语义。
 */
export function mapAxRole(ax: string): string {
  return AX_ROLE_MAP[ax] ?? "unknown";
}
