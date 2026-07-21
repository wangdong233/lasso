//! AXRole → unified role const table（与 TS 端 ax-role-map.ts 镜像，parse4 §4.3）。
//!
//! 1:1 映射原则：相同的 AXRole 字符串在 Rust 与 TS 端必须映射到相同的 unified role。
//! OutlineMapper（TS）只做 children 递归 + ref 分配，role 标准化在 Rust 端完成（少传原始 AXRole）。
//!
//! 维护：两侧同步增改；CI grep 防漂移（INV-21 仅断言 platform 字面量不进 TS 层）。
//! 覆盖率验证：M0.5a 采 10 个 native app 各 3 window 验证 ≥80%（13 §3.4 第 3 条）。

/// AXRole 字符串 → unified role（DOM-like）。
///
/// 返回 `unknown` 表示该 AXRole 暂未在映射表内；调用方据此可标 pictureOnly 候选
/// （AXUnknown + size>100x100 + 无 children → canvas/Metal）。
pub fn map_ax_role(ax: &str) -> &'static str {
    match ax {
        // Buttons / actions
        "AXButton" => "button",
        "AXPopUpButton" => "select",
        "AXCheckBox" => "checkbox",
        "AXRadioButton" => "radio",
        "AXMenuButton" => "menubutton",
        // Text
        "AXTextField" => "textfield",
        "AXTextArea" => "textarea",
        "AXStaticText" => "text",
        // Menus
        "AXMenu" => "menu",
        "AXMenuItem" => "menuitem",
        "AXMenuBar" => "menubar",
        "AXMenuBarItem" => "menubaritem",
        // Windows / sheets
        "AXWindow" => "window",
        "AXSheet" => "dialog", // modal sheet
        "AXPopover" => "popover",
        // Lists / trees / tables
        "AXRow" => "row",
        "AXOutline" => "tree",
        "AXList" => "list",
        "AXTable" => "table",
        // Layout / groups
        "AXScrollArea" => "scrollarea",
        "AXTabGroup" => "tablist",
        "AXToolbar" => "toolbar",
        "AXGroup" => "group",
        "AXLayoutArea" => "group", // Xcode storyboard canvas
        // Media
        "AXImage" => "img",
        "AXLink" => "link",
        // Generic / unknown
        "AXUnknown" => "unknown",
        // Generic 应用级角色兜底（非 DOM 角色；保留原值便于 doctor 报告）
        "AXApplication" => "application",
        "AXSystemWide" => "systemwide",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_roles() {
        assert_eq!(map_ax_role("AXButton"), "button");
        assert_eq!(map_ax_role("AXTextField"), "textfield");
        assert_eq!(map_ax_role("AXTextArea"), "textarea");
        assert_eq!(map_ax_role("AXCheckBox"), "checkbox");
        assert_eq!(map_ax_role("AXRadioButton"), "radio");
        assert_eq!(map_ax_role("AXPopUpButton"), "select");
        assert_eq!(map_ax_role("AXMenu"), "menu");
        assert_eq!(map_ax_role("AXMenuItem"), "menuitem");
        assert_eq!(map_ax_role("AXMenuBar"), "menubar");
        assert_eq!(map_ax_role("AXMenuBarItem"), "menubaritem");
        assert_eq!(map_ax_role("AXWindow"), "window");
        assert_eq!(map_ax_role("AXSheet"), "dialog");
        assert_eq!(map_ax_role("AXPopover"), "popover");
        assert_eq!(map_ax_role("AXImage"), "img");
        assert_eq!(map_ax_role("AXStaticText"), "text");
        assert_eq!(map_ax_role("AXLink"), "link");
        assert_eq!(map_ax_role("AXRow"), "row");
        assert_eq!(map_ax_role("AXOutline"), "tree");
        assert_eq!(map_ax_role("AXScrollArea"), "scrollarea");
        assert_eq!(map_ax_role("AXTabGroup"), "tablist");
        assert_eq!(map_ax_role("AXToolbar"), "toolbar");
        assert_eq!(map_ax_role("AXGroup"), "group");
        assert_eq!(map_ax_role("AXLayoutArea"), "group");
        assert_eq!(map_ax_role("AXUnknown"), "unknown");
    }

    #[test]
    fn unknown_ax_role_falls_back() {
        assert_eq!(map_ax_role("AXSomeNewRole"), "unknown");
        assert_eq!(map_ax_role(""), "unknown");
    }

    #[test]
    fn application_and_systemwide_kept_for_doctor() {
        assert_eq!(map_ax_role("AXApplication"), "application");
        assert_eq!(map_ax_role("AXSystemWide"), "systemwide");
    }
}
