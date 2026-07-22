//! Windows UIA backend（v1.0 Phase B；parse11 §3.1 + §7.2）。
//!
//! 平台：cfg(target_os = "windows")；非 Windows 平台本文件的 platform mod 不参与
//! 编译，只剩 `not_windows` 兜底桩（main.rs dispatch 在 macOS build 永远走不到
//! uia::snapshot，但链接层需符号存在 → 兜底桩返 `not_windows`）。
//!
//! ## 实装策略（parse11 §3.1 + §4.1 决策 + §1.3 诚实红线）
//!
//! 经官方 microsoft/windows-rs crate（Win32_UI_Accessibility feature）。Phase B 的
//! 交付边界是 **编译可证 + 形状契约一致**：
//!  - API surface 真实：`CoInitializeEx` / `CoCreateInstance::<IUIAutomation>` /
//!    `IUIAutomation::GetRootElement` / `IUIAutomationTreeWalker::NormalizeElement`
//!    等真实 COM 调用经 cfg-gate 编译进 Windows target（cargo check --target
//!    x86_64-pc-windows-msvc 通过即证 crate 闭包正确）
//!  - 三平台同构契约：本 backend 输出与 macOS ax.rs **同形 AxNode JSON**
//!    （role / raw_role / label / rect / enabled / focused / depth / children /
//!    window_id），role 经 `crate::ax_role_map` 三平台合并表统一映射
//!  - 真实 UIA TreeWalker 深读 + AXPRESS 等效 Invoke 留手测清单
//!    （parse11-acceptance.md #W1-#W7，CI 不能代劳，标 pending 不伪造）
//!
//! ## macOS-only 现实红线（parse11 §1.3）
//!
//! 本机 Darwin 21.6.0 Intel **无法运行时验证** Windows UIA 路径。本文件的 cfg-gate
//! 结构保证：(a) macOS build 完全不拉 windows-rs crate（Cargo.toml target-specific
//! dep 守）；(b) Windows target 真编入；(c) 非 Windows target 调用 uia_* 返
//! `not_windows`，错误清晰不伪造「Windows 已验证」。

use crate::protocol::Response;

// `map_ax_role` 仅在 cfg(target_os = "windows") platform mod 内引用；
// macOS build 下整个 platform mod 不参与编译 → 顶层 use 经 cfg-gate 守（避免
// 顶层 unused-import 警告；非 Windows fallback 桩不读 role-map）。
#[cfg(target_os = "windows")]
use crate::ax_role_map::map_ax_role;

// ============================================================================
// 非 Windows fallback：所有 method 返回 not_windows
// 与 ax.rs::not_macos / atspi.rs::not_linux 同形（三平台 cfg-gate 范式一致）。
// ============================================================================

#[cfg(not(target_os = "windows"))]
pub fn snapshot(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_windows", "uia_snapshot requires Windows")
}

#[cfg(not(target_os = "windows"))]
pub fn find(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_windows", "uia_find requires Windows")
}

#[cfg(not(target_os = "windows"))]
pub fn act(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_windows", "uia_act requires Windows")
}

// ============================================================================
// Windows 实装
// ============================================================================

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    // 真实 windows-rs API surface（cargo check --target x86_64-pc-windows-msvc
    // 验证 crate 闭包正确解析；smoke test 已确认 API shape 见 parse11 §7.2）。
    use windows::core::*;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker, UIA_CONTROLTYPE_ID,
        CUIAutomation,
    };

    /// UIA ControlType ID → unified role 字符串（经 ax_role_map 三平台合并表）。
    ///
    /// 与 macOS `map_ax_role("AXButton") → "button"` / Linux `map_ax_role("push button")
    /// → "button"` 同槽位 → 同 unified role（INV-61 OutlineMapper 三平台共享）。
    ///
    /// ControlType ID 数值来自 microsoft docs（Win32_UI_Accessibility）：
    ///   https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controltype-ids
    fn control_type_to_role(ct: UIA_CONTROLTYPE_ID) -> String {
        // smoke 验证 windows-rs 0.59 的 UIA_CONTROLTYPE_ID 是 `pub struct(pub i32)`
        // newtype（不是 u32；经 .0 取内层 i32）。将数值转 canonical 字符串后走
        // ax_role_map 三平台合并表（parse11 §3.1 INV-61）。
        map_ax_role(&format!("uia:{}", ct.0)).to_string()
    }

    /// 初始化 COM apartment + 创建 IUIAutomation 实例。
    ///
    /// 真实 Windows runtime 入口点（smoke test 已验 CoInitializeEx + CoCreateInstance
    /// 在 windows-rs 0.59 编译可达）。Phase B 不在 macOS 跑 → CI 仅证编译。
    ///
    /// 返回 IUIAutomation 强类型引用；调用方 drop 即释放。
    #[allow(dead_code)] // Phase B 留入口；snapshot/find/act 真实调用接在 #W1 手测后
    fn create_uia() -> windows::core::Result<IUIAutomation> {
        unsafe {
            // CoInitializeEx 必须每个线程调一次；多线程 apartment 与 docs 推荐一致。
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            // CoCreateInstance 拿 CUIAutomation 的 IUIAutomation 接口。
            CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        }
    }

    /// 释放 COM apartment（对称 CoInitializeEx）。
    #[allow(dead_code)]
    fn shutdown_uia() {
        unsafe { CoUninitialize() }
    }

    /// `uia_snapshot` 入口（与 ax.rs::snapshot 同形 AxNode 输出）。
    ///
    /// Phase B 交付边界（parse11 §1.3 诚实红线）：
    ///  - 编译可证（cargo check --target x86_64-pc-windows-msvc 通过）
    ///  - API surface 真实（IUIAutomation / IUIAutomationElement / IUIAutomationTreeWalker
    ///    符号经 windows-rs 0.59 真实导出）
    ///  - 运行时真读 UIA 树留手测清单 #W1（pending；需真 Windows 桌面环境）
    ///
    /// 完整 TreeWalker 深读 + 节点字段抽取（Name / ControlType / IsEnabled /
    /// HasKeyboardFocus / BoundingRectangle）在真机验通后接入手测清单通过的下一版。
    pub fn snapshot(id: &str, _params: &serde_json::Value) -> Response {
        // 真实入口探测：若 IUIAutomation 实例都无法创建，返 ax_unavailable（不伪造 ok）。
        // 创建成功 → 仍返 not_implemented（TreeWalker 深读留手测 #W1 验证后落地）。
        let _uia_probe = match create_uia() {
            Ok(uia) => uia,
            Err(e) => {
                return Response::err(
                    id,
                    "ax_unavailable",
                    format!("uia_snapshot: CoCreateInstance(IUIAutomation) failed: {e}"),
                );
            }
        };
        Response::err(
            id,
            "not_implemented",
            "uia_snapshot: TreeWalker deep-read pending hand-test #W1 (parse11 §1.3)",
        )
    }

    /// `uia_find`（与 ax.rs::find 同形输出）。
    pub fn find(id: &str, _params: &serde_json::Value) -> Response {
        Response::err(
            id,
            "not_implemented",
            "uia_find: pending hand-test #W2 (parse11 §1.3)",
        )
    }

    /// `uia_act`（与 ax.rs::act 同形输出）。
    pub fn act(id: &str, _params: &serde_json::Value) -> Response {
        Response::err(
            id,
            "not_implemented",
            "uia_act: pending hand-test #W3 (parse11 §1.3)",
        )
    }

    // ----- compile-time API surface anchors -----
    // 这些引用在 Windows target 编译时强制 windows-rs 0.59 导出对应符号；
    // 不在 macOS 编译（cfg-gate 守）。smoke test 已验，这里再锚定一次防 crate 漂移。
    #[allow(dead_code)]
    const _ANCHOR_BUTTON_CT: UIA_CONTROLTYPE_ID = windows::Win32::UI::Accessibility::UIA_ButtonControlTypeId;
    #[allow(dead_code)]
    const _ANCHOR_EDIT_CT: UIA_CONTROLTYPE_ID = windows::Win32::UI::Accessibility::UIA_EditControlTypeId;
    #[allow(dead_code)]
    const _ANCHOR_TEXT_CT: UIA_CONTROLTYPE_ID = windows::Win32::UI::Accessibility::UIA_TextControlTypeId;
    #[allow(dead_code)]
    const _ANCHOR_IID: GUID = IUIAutomation::IID;

    // Type references：锁住 IUIAutomationElement / IUIAutomationTreeWalker 符号位置
    // （windows-rs 0.59 smoke 验证这些 trait/类型在 Win32_UI_Accessibility 命名空间）。
    #[allow(dead_code)]
    fn _type_anchors(_e: Option<IUIAutomationElement>, _w: Option<IUIAutomationTreeWalker>) {}

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn control_type_to_role_uses_unified_map() {
            // INV-61 contract：Windows control type 经 ax_role_map 与 macOS同槽位 → 同 unified role。
            // 具体映射值在 ax_role_map.rs 三平台合并表里断言；本测试只验函数不 panic + 返非空。
            let r = control_type_to_role(windows::Win32::UI::Accessibility::UIA_ButtonControlTypeId);
            assert!(!r.is_empty());
        }

        #[test]
        fn snapshot_returns_not_implemented_with_uia_probe() {
            // Windows runtime 路径在 CI Linux runner（无桌面）也走不到真 UIA；
            // 但本测试至少证明 snapshot 函数可达 + 返 not_implemented（不 panic）。
            // 真实 TreeWalker 深读留手测 #W1。
            let resp = snapshot("test1", &serde_json::Value::Null);
            assert!(!resp.ok);
            // 在 CI 无桌面环境，CoCreateInstance 可能失败 → ax_unavailable；
            // 在真 Windows 桌面 → not_implemented。两者都接受（CI 不能伪造 ok）。
            let kind = resp.error_kind.as_deref().unwrap_or("");
            assert!(
                kind == "not_implemented" || kind == "ax_unavailable",
                "expected not_implemented or ax_unavailable, got {kind}"
            );
        }
    }
}

#[cfg(target_os = "windows")]
pub use platform::{act, find, snapshot};

// ============================================================================
// 跨平台单测（macOS 本机跑）：cfg(not(target_os = "windows")) fallback 桩
// ============================================================================

#[cfg(all(test, not(target_os = "windows")))]
mod fallback_tests {
    use super::*;

    #[test]
    fn snapshot_fallback_returns_not_windows() {
        let resp = snapshot("fb1", &serde_json::Value::Null);
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("not_windows"));
    }

    #[test]
    fn find_fallback_returns_not_windows() {
        let resp = find("fb2", &serde_json::Value::Null);
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("not_windows"));
    }

    #[test]
    fn act_fallback_returns_not_windows() {
        let resp = act("fb3", &serde_json::Value::Null);
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("not_windows"));
    }

    #[test]
    fn fallback_error_messages_are_distinct_per_method() {
        // 三个 method 的 error 信息分别带 method 名 → 调用方能分辨是 snapshot/find/act 触发。
        let s = snapshot("fb4", &serde_json::Value::Null).error.unwrap_or_default();
        let f = find("fb5", &serde_json::Value::Null).error.unwrap_or_default();
        let a = act("fb6", &serde_json::Value::Null).error.unwrap_or_default();
        assert!(s.contains("snapshot"));
        assert!(f.contains("find"));
        assert!(a.contains("act"));
    }
}
