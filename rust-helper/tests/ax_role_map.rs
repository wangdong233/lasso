//! AXRole 映射全覆盖测试（平台无关，CI 在 Linux 也跑）。
//!
//! parse4 §5.1 ax_role_map.rs + §4.3 映射表。
//! 任何映射变更必须同步改 src/ax_role_map.rs + src/desktop/ax-role-map.ts（TS 端）。

use lasso_rust_helper::ax_role_map::map_ax_role;

#[test]
fn buttons() {
    assert_eq!(map_ax_role("AXButton"), "button");
    assert_eq!(map_ax_role("AXPopUpButton"), "select");
    assert_eq!(map_ax_role("AXCheckBox"), "checkbox");
    assert_eq!(map_ax_role("AXRadioButton"), "radio");
    assert_eq!(map_ax_role("AXMenuButton"), "menubutton");
}

#[test]
fn text_inputs() {
    assert_eq!(map_ax_role("AXTextField"), "textfield");
    assert_eq!(map_ax_role("AXTextArea"), "textarea");
    assert_eq!(map_ax_role("AXStaticText"), "text");
}

#[test]
fn menus() {
    assert_eq!(map_ax_role("AXMenu"), "menu");
    assert_eq!(map_ax_role("AXMenuItem"), "menuitem");
    assert_eq!(map_ax_role("AXMenuBar"), "menubar");
    assert_eq!(map_ax_role("AXMenuBarItem"), "menubaritem");
}

#[test]
fn windows_and_dialogs() {
    assert_eq!(map_ax_role("AXWindow"), "window");
    assert_eq!(map_ax_role("AXSheet"), "dialog"); // modal sheet
    assert_eq!(map_ax_role("AXPopover"), "popover");
}

#[test]
fn lists_trees_tables() {
    assert_eq!(map_ax_role("AXRow"), "row");
    assert_eq!(map_ax_role("AXOutline"), "tree");
    assert_eq!(map_ax_role("AXList"), "list");
    assert_eq!(map_ax_role("AXTable"), "table");
}

#[test]
fn layout_groups() {
    assert_eq!(map_ax_role("AXScrollArea"), "scrollarea");
    assert_eq!(map_ax_role("AXTabGroup"), "tablist");
    assert_eq!(map_ax_role("AXToolbar"), "toolbar");
    assert_eq!(map_ax_role("AXGroup"), "group");
    assert_eq!(map_ax_role("AXLayoutArea"), "group"); // Xcode storyboard canvas
}

#[test]
fn media() {
    assert_eq!(map_ax_role("AXImage"), "img");
    assert_eq!(map_ax_role("AXLink"), "link");
}

#[test]
fn unknown_falls_back() {
    assert_eq!(map_ax_role("AXUnknown"), "unknown");
    assert_eq!(map_ax_role("AXSomeFutureRole"), "unknown");
    assert_eq!(map_ax_role(""), "unknown");
}

#[test]
fn application_root_roles_kept_for_doctor() {
    // 不映射到 DOM 角色；doctor / 调试输出保留
    assert_eq!(map_ax_role("AXApplication"), "application");
    assert_eq!(map_ax_role("AXSystemWide"), "systemwide");
}

#[test]
fn consistency_check_returns_static_str() {
    // 映射返回 &'static str — 调用方安全存储无需 clone
    let r: &'static str = map_ax_role("AXButton");
    assert_eq!(r, "button");
}
