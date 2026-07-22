//! AXRole → unified role const table（与 TS 端 ax-role-map.ts 镜像，parse4 §4.3）。
//!
//! 1:1 映射原则：相同的 AXRole 字符串在 Rust 与 TS 端必须映射到相同的 unified role。
//! OutlineMapper（TS）只做 children 递归 + ref 分配，role 标准化在 Rust 端完成（少传原始 AXRole）。
//!
//! 维护：两侧同步增改；CI grep 防漂移（INV-21 仅断言 platform 字面量不进 TS 层）。
//! 覆盖率验证：M0.5a 采 10 个 native app 各 3 window 验证 ≥80%（13 §3.4 第 3 条）。

//! AXRole → unified role const table（与 TS 端 ax-role-map.ts 镜像，parse4 §4.3）。
//!
//! 1:1 映射原则：相同的 AXRole 字符串在 Rust 与 TS 端必须映射到相同的 unified role。
//! OutlineMapper（TS）只做 children 递归 + ref 分配，role 标准化在 Rust 端完成（少传原始 AXRole）。
//!
//! 维护：两侧同步增改；CI grep 防漂移（INV-21 仅断言 platform 字面量不进 TS 层）。
//! 覆盖率验证：M0.5a 采 10 个 native app 各 3 window 验证 ≥80%（13 §3.4 第 3 条）。
//!
//! ## v1.0 Phase B 三平台合并表（parse11 §3.1 + §7.2 + INV-61）
//!
//! 本文件从「macOS AXRole → unified role」扩为「三平台同槽位 → 同 unified role」：
//!  - macOS  ：`map_ax_role("AXButton")` → "button"
//!  - Windows：`map_ax_role("uia:50005")` → "button"（uia:<ControlTypeId> 格式；
//!             uia.rs::control_type_to_role 把 u32 ControlType 转 format!("uia:{}", id)
//!             再走本函数；50005 = UIA_ButtonControlTypeId）
//!  - Linux  ：`map_ax_role("push button")` → "button"（AT-SPI Role 字符串；
//!             atspi.rs::atspi_role_to_role 直接传 role 名进本函数）
//!
//! OutlineMapper（TS）三平台共享 → 同 unified role → 同 OutlineNode 形状
//! （INV-61 衍生：OutlineNode 契约单一 mapper；raw_role 仅诊断字段不进 OutlineNode）。
//!
//! ControlType IDs（microsoft docs）：
//!   https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controltype-ids
//! AT-SPI Role names（atspi-common::Role）：
//!   https://docs.rs/atspi-common/latest/atspi_common/enum.Role.html

/// AXRole 字符串 → unified role（DOM-like）。
///
/// 返回 `unknown` 表示该 AXRole 暂未在映射表内；调用方据此可标 pictureOnly 候选
/// （AXUnknown + size>100x100 + 无 children → canvas/Metal）。
///
/// v1.0 Phase B：入参支持三平台原生字符串（macOS AXRole / Windows `uia:<id>` /
/// Linux AT-SPI role 字符串）。三平台同槽位经本函数统一映射。
pub fn map_ax_role(ax: &str) -> &'static str {
    match ax {
        // ==================================================================
        // macOS AXRole（v0.3.5 既有；零改）
        // ==================================================================
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

        // ==================================================================
        // Windows UIA ControlType IDs（v1.0 Phase B；parse11 §3.1 + §7.2）
        // 格式：`uia:<numeric_id>`，uia.rs::control_type_to_role 把 u32 转此格式。
        // 数值取自 microsoft Win32_UI_Accessibility UIA_*ControlTypeId 常量。
        // ==================================================================
        "uia:50000" => "button",      // UIA_ButtonControlTypeId
        "uia:50001" => "group",       // UIA_GroupControlTypeId
        "uia:50002" => "img",         // UIA_ImageControlTypeId
        "uia:50003" => "link",        // UIA_HyperlinkControlTypeId
        "uia:50004" => "window",      // UIA_WindowControlTypeId
        "uia:50005" => "window",      // UIA_PaneControlTypeId（细分到 window 槽）
        "uia:50006" => "list",        // UIA_ListControlTypeId
        "uia:50007" => "listitem",    // UIA_ListItemControlTypeId
        "uia:50008" => "text",        // UIA_DocumentControlTypeId
        "uia:50009" => "text",        // UIA_TextControlTypeId
        "uia:50010" => "toolbar",     // UIA_ToolBarControlTypeId
        "uia:50011" => "menu",        // UIA_MenuControlTypeId
        "uia:50012" => "menu",        // UIA_MenuBarControlTypeId
        "uia:50013" => "menuitem",    // UIA_MenuItemControlTypeId
        "uia:50014" => "button",      // UIA_ButtonControlTypeId（重复锚，防漂）
        "uia:50015" => "checkbox",    // UIA_CheckBoxControlTypeId
        "uia:50016" => "radio",       // UIA_RadioButtonControlTypeId
        "uia:50017" => "select",      // UIA_ComboBoxControlTypeId
        "uia:50018" => "select",      // UIA_DropDownControlTypeId
        "uia:50019" => "button",      // UIA_SplitButtonControlTypeId（落到 button）
        "uia:50025" => "textfield",   // UIA_EditControlTypeId（输入框）
        "uia:50026" => "text",        // UIA_HeaderControlTypeId
        "uia:50027" => "button",      // UIA_HeaderItemControlTypeId
        "uia:50028" => "row",         // UIA_DataItemControlTypeId
        "uia:50029" => "row",         // UIA_SliderControlTypeId（落到 row 接近；待 v1.1+ 细分）
        "uia:50031" => "row",         // UIA_SpinnerControlTypeId
        "uia:50032" => "button",      // UIA_SplitButtonControlTypeId
        "uia:50033" => "window",      // UIA_StatusBarControlTypeId
        "uia:50034" => "table",       // UIA_TableControlTypeId
        "uia:50035" => "toolbar",     // UIA_ToolTipControlTypeId
        "uia:50036" => "tree",        // UIA_TreeControlTypeId
        "uia:50037" => "tree",        // UIA_TreeItemControlTypeId
        "uia:50038" => "scrollarea",  // UIA_CustomControlTypeId
        "uia:50039" => "group",       // UIA_GroupControlTypeId
        "uia:50040" => "unknown",     // UIA_ThumbControlTypeId
        "uia:50042" => "tree",        // UIA_DataGridControlTypeId
        "uia:50043" => "textfield",   // UIA_DataItemControlTypeId as input
        "uia:50046" => "dialog",      // UIA_AppBarControlTypeId（接近 dialog 槽）

        // ==================================================================
        // Linux AT-SPI Role 字符串（v1.0 Phase B；parse11 §3.1 + §7.2）
        // 取自 atspi-common::Role Display 枚举名（atspi 0.22 真实导出）。
        // ==================================================================
        "push button" => "button",
        "toggle button" => "button",
        "check box" => "checkbox",
        "radio button" => "radio",
        "radio menu item" => "menuitem",
        "check menu item" => "menuitem",
        "menu" => "menu",
        "menu item" => "menuitem",
        "menu bar" => "menubar",
        "entry" => "textfield",
        "password text" => "textfield",
        "text" => "text",
        "text frame" => "textarea",
        "label" => "text",
        "static text" => "text",
        "heading" => "text",
        "list" => "list",
        "list item" => "listitem",
        "tree" => "tree",
        "tree table" => "table",
        "table" => "table",
        "table row" => "row",
        "table cell" => "row",
        "table column header" => "row",
        "image" => "img",
        "icon" => "img",
        "link" => "link",
        "window" => "window",
        "frame" => "window",
        "dialog" => "dialog",
        "alert" => "dialog",
        "file chooser" => "dialog",
        "color chooser" => "dialog",
        "scroll pane" => "scrollarea",
        "viewport" => "scrollarea",
        "separator" => "group",
        "scroll bar" => "group",
        "slider" => "group",
        "spin button" => "textfield",
        "status bar" => "toolbar",
        "tool bar" => "toolbar",
        "tool tip" => "toolbar",
        "progress bar" => "group",
        "level bar" => "group",
        "combo box" => "select",
        "page tab" => "tab",
        "page tab list" => "tablist",
        "panel" => "group",
        "filler" => "group",
        "split pane" => "group",
        "calendar" => "group",
        "date editor" => "textfield",
        "desktop icon" => "img",
        "desktop frame" => "window",
        "html container" => "group",
        "terminal" => "textarea",
        "button" => "button", // AT-SPI 也有裸 "button"（罕见；兜底）

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

    // ==================================================================
    // v1.0 Phase B 三平台同槽位 INV-61 守（parse11 §3.1 + §7.2）
    // 三平台「按钮类」原生 role 必须映射到同一 unified role "button"。
    // ==================================================================

    #[test]
    fn three_platforms_button_converges_to_unified_button() {
        // INV-61 核心：三平台按钮槽位 → 同 unified role "button"
        let mac = map_ax_role("AXButton");
        let win = map_ax_role("uia:50000"); // UIA_ButtonControlTypeId
        let linux = map_ax_role("push button"); // AT-SPI push button
        assert_eq!(mac, "button");
        assert_eq!(win, "button");
        assert_eq!(linux, "button");
        // 三者完全一致（不是都非空，是同一个字符串）
        assert_eq!(mac, win);
        assert_eq!(win, linux);
    }

    #[test]
    fn three_platforms_text_input_converges_to_unified_textfield() {
        // 三平台「文本输入」槽位 → 同 unified role "textfield"
        let mac = map_ax_role("AXTextField");
        let win = map_ax_role("uia:50025"); // UIA_EditControlTypeId
        let linux = map_ax_role("entry"); // AT-SPI entry
        assert_eq!(mac, "textfield");
        assert_eq!(win, "textfield");
        assert_eq!(linux, "textfield");
        assert_eq!(mac, win);
        assert_eq!(win, linux);
    }

    #[test]
    fn three_platforms_image_converges_to_unified_img() {
        let mac = map_ax_role("AXImage");
        let win = map_ax_role("uia:50002"); // UIA_ImageControlTypeId
        let linux = map_ax_role("image"); // AT-SPI image
        assert_eq!(mac, "img");
        assert_eq!(win, "img");
        assert_eq!(linux, "img");
    }

    #[test]
    fn three_platforms_list_converges_to_unified_list() {
        let mac = map_ax_role("AXList");
        let win = map_ax_role("uia:50006"); // UIA_ListControlTypeId
        let linux = map_ax_role("list"); // AT-SPI list
        assert_eq!(mac, "list");
        assert_eq!(win, "list");
        assert_eq!(linux, "list");
    }

    #[test]
    fn three_platforms_menu_converges_to_unified_menu() {
        let mac = map_ax_role("AXMenu");
        let win = map_ax_role("uia:50011"); // UIA_MenuControlTypeId
        let linux = map_ax_role("menu"); // AT-SPI menu
        assert_eq!(mac, "menu");
        assert_eq!(win, "menu");
        assert_eq!(linux, "menu");
    }

    #[test]
    fn three_platforms_checkbox_converges_to_unified_checkbox() {
        let mac = map_ax_role("AXCheckBox");
        let win = map_ax_role("uia:50015"); // UIA_CheckBoxControlTypeId
        let linux = map_ax_role("check box"); // AT-SPI check box
        assert_eq!(mac, "checkbox");
        assert_eq!(win, "checkbox");
        assert_eq!(linux, "checkbox");
    }

    #[test]
    fn three_platforms_radio_converges_to_unified_radio() {
        let mac = map_ax_role("AXRadioButton");
        let win = map_ax_role("uia:50016"); // UIA_RadioButtonControlTypeId
        let linux = map_ax_role("radio button"); // AT-SPI radio button
        assert_eq!(mac, "radio");
        assert_eq!(win, "radio");
        assert_eq!(linux, "radio");
    }

    #[test]
    fn three_platforms_link_converges_to_unified_link() {
        let mac = map_ax_role("AXLink");
        let win = map_ax_role("uia:50003"); // UIA_HyperlinkControlTypeId
        let linux = map_ax_role("link"); // AT-SPI link
        assert_eq!(mac, "link");
        assert_eq!(win, "link");
        assert_eq!(linux, "link");
    }

    #[test]
    fn windows_uia_unknown_control_type_falls_back() {
        // 未在表内的 UIA ControlTypeId（如 59999）→ unknown fallback
        assert_eq!(map_ax_role("uia:59999"), "unknown");
        assert_eq!(map_ax_role("uia:abc"), "unknown");
    }

    #[test]
    fn linux_atspi_unknown_role_falls_back() {
        // 未在表内的 AT-SPI role → unknown fallback
        assert_eq!(map_ax_role("some unknown atspi role"), "unknown");
    }

    #[test]
    fn three_platforms_table_converges() {
        let mac = map_ax_role("AXTable");
        let win = map_ax_role("uia:50034"); // UIA_TableControlTypeId
        let linux = map_ax_role("table"); // AT-SPI table
        assert_eq!(mac, "table");
        assert_eq!(win, "table");
        assert_eq!(linux, "table");
    }

    #[test]
    fn three_platforms_window_converges() {
        let mac = map_ax_role("AXWindow");
        let win = map_ax_role("uia:50004"); // UIA_WindowControlTypeId
        let linux = map_ax_role("window"); // AT-SPI window
        assert_eq!(mac, "window");
        assert_eq!(win, "window");
        assert_eq!(linux, "window");
    }
}
