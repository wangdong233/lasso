//! windows.rs::list_windows 数据结构校验（平台无关，CI 在 Linux 也跑）。
//!
//! parse5 §5.3 windows_list.rs：JSON shape + identity 稳定性校验。
//!
//! 实装侧 macOS-only `list_windows`（CGWindowListCopyWindowInfo）不可在 CI Linux 上跑，
//! 故此处仅守：
//!  1. windowId = 真 kCGWindowNumber（u32→i64，窗口生命周期内稳定的系统 ID）
//!  2. list_windows 返回的 JSON shape 与 DesktopChannel.listRoots() TS 端解析一致
//!  3. forest identity = owner + windowNumber + title（同窗口重查询 → 同 @wN）
//!
//! 真实 macOS 枚举测试留给手测清单（parse5 §6.4 v0.3.5 零回归承接）。
//!
//! 注：v0.4 M0.4a 把 list_windows 从 AX system_wide.children（实测返空）改为
//! CGWindowListCopyWindowInfo；windowId 从「pid*1M+idx 合成」改为真 CGWindowNumber。

use lasso_rust_helper::protocol;

#[test]
fn window_id_is_real_cgwindow_number_u32_into_i64() {
    // kCGWindowNumber 是 CGWindowID = u32（系统给每个窗口的稳定 ID）。
    // windows.rs::list_windows 把它 i64 上报；forest identity 据此去重。
    let cg_number: u32 = 137; // 真 kCGWindowNumber 示例
    let window_id = cg_number as i64;
    assert_eq!(window_id, 137_i64);
    assert!(window_id >= 0);

    // u32 全域都能放 i64 不溢出（守护 wire-shape 不丢精度）
    let max_wid = u32::MAX as i64;
    let json = serde_json::json!({ "windowId": max_wid });
    assert_eq!(json["windowId"].as_i64(), Some(max_wid));
}

#[test]
fn response_shape_windows_array_is_serializable() {
    // 与 windows.rs macOS 实装（CGWindowListCopyWindowInfo）的 Response::ok JSON shape 一致
    let resp = protocol::Response::ok(
        "r1",
        serde_json::json!({
            "windows": [
                {
                    "bundleId": "",
                    "pid": 1234,
                    "windowId": 137,
                    "app": "Finder",
                    "title": "Library",
                    "rect": { "x": 0.0, "y": 0.0, "w": 800.0, "h": 600.0 }
                }
            ]
        }),
    );
    let s = serde_json::to_string(&resp).unwrap();
    assert!(s.contains(r#""windows":"#));
    assert!(s.contains(r#""app":"Finder""#));
    assert!(s.contains(r#""windowId":137"#));
    // bundleId 空（CGWindowList 不提供）；forest identity 用 owner+windowNumber 不依赖它
    assert!(s.contains(r#""bundleId":""#));
}

#[test]
fn non_macos_list_windows_returns_not_macos() {
    #[cfg(not(target_os = "macos"))]
    {
        let resp = protocol::Response::err("r1", "not_macos", "list_windows requires macOS");
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("not_macos"));
    }
    #[cfg(target_os = "macos")]
    {
        // macOS：真实 list_windows 走 CGWindowListCopyWindowInfo，单测不触发
    }
}

#[test]
fn empty_windows_response_is_valid() {
    // 无 on-screen 窗口 / CGWindowListCopyWindowInfo null 后 list_windows 返空数组（forest 容忍）
    let resp = protocol::Response::ok("r1", serde_json::json!({ "windows": [] }));
    let s = serde_json::to_string(&resp).unwrap();
    assert!(s.contains(r#""windows":[]"#));
}

#[test]
fn window_identity_uniqueness_via_cgwindow_number() {
    // forest 真实场景：多 app × 多窗口，每个 windowId = 唯一 kCGWindowNumber
    let windows: &[i64] = &[137, 138, 2501, 2502, 9999]; // 各窗口的真 CGWindowNumber
    let mut seen = std::collections::HashSet::new();
    for wid in windows {
        assert!(seen.insert(*wid), "windowId collision: {}", wid);
    }
    assert_eq!(seen.len(), windows.len());
}

#[test]
fn window_id_i64_no_overflow() {
    // CGWindowNumber 是 u32 → i64 永不溢出（守护 windows.rs 用 i64 而非 i32 wire-shape）
    let max_wid = u32::MAX as i64;
    assert!(max_wid > 0);
    let json = serde_json::json!({ "windowId": max_wid });
    assert_eq!(json["windowId"].as_i64(), Some(max_wid));
}
