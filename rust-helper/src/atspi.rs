//! Linux AT-SPI backend（v1.0 Phase B；parse11 §3.1 + §7.2）。
//!
//! 平台：cfg(target_os = "linux")；非 Linux 平台本文件的 platform mod 不参与编译，
//! 只剩 `not_linux` 兜底桩（main.rs dispatch 在 macOS build 永远走不到 atspi::snapshot，
//! 但链接层需符号存在 → 兜底桩返 `not_linux`）。
//!
//! ## 实装策略（parse11 §3.1 + §4.1 决策 + §1.3 诚实红线）
//!
//! 经 odilia-app `atspi` crate（pure Rust via zbus D-Bus，default features 含
//! async-std runtime）。Phase B 交付边界是 **编译可证 + 形状契约一致**：
//!  - API surface 真实：`AccessibilityConnection::open()` / `AccessibleProxy<'_>` /
//!    atspi Role 枚举等真实 D-Bus 调用经 cfg-gate 编译进 Linux target
//!    （cargo check --target x86_64-unknown-linux-gnu 通过即证 crate 闭包正确）
//!  - 三平台同构契约：本 backend 输出与 macOS ax.rs **同形 AxNode JSON**
//!    （role / raw_role / label / rect / enabled / focused / depth / children /
//!    window_id），role 经 `crate::ax_role_map` 三平台合并表统一映射
//!  - 真实 AT-SPI registry 读 + Action 等效 Invoke 留手测清单
//!    （parse11-acceptance.md #L1-#L7，CI 不能代劳，标 pending 不伪造）
//!
//! ## macOS-only 现实红线（parse11 §1.3）
//!
//! 本机 Darwin 21.6.0 Intel **无法运行时验证** Linux AT-SPI 路径。CI Linux runner
//! 虽可 `cargo build --target x86_64-unknown-linux-gnu`（编译可证），但 headless
//! 无桌面 → AT-SPI registry 不可达 → 真实读取仍留手测清单。本文件的 cfg-gate 结构
//! 保证：(a) macOS build 完全不拉 atspi crate；(b) Linux target 真编入；
//! (c) 非 Linux target 调用 atspi_* 返 `not_linux`。

use crate::protocol::Response;

// `map_ax_role` 仅在 cfg(target_os = "linux") platform mod 内引用；
// macOS build 下整个 platform mod 不参与编译 → 顶层 use 经 cfg-gate 守。
#[cfg(target_os = "linux")]
use crate::ax_role_map::map_ax_role;

// ============================================================================
// 非 Linux fallback：所有 method 返回 not_linux
// 与 ax.rs::not_macos / uia.rs::not_windows 同形（三平台 cfg-gate 范式一致）。
// ============================================================================

#[cfg(not(target_os = "linux"))]
pub fn snapshot(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_linux", "atspi_snapshot requires Linux")
}

#[cfg(not(target_os = "linux"))]
pub fn find(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_linux", "atspi_find requires Linux")
}

#[cfg(not(target_os = "linux"))]
pub fn act(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_linux", "atspi_act requires Linux")
}

// ============================================================================
// Linux 实装
// ============================================================================

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    // 真实 atspi crate API surface（cargo check --target x86_64-unknown-linux-gnu
    // 验证 crate 闭包正确解析；smoke test 已确认 API shape 见 parse11 §7.2）。
    // 经 atspi::zbus re-export 引用 zbus（避免与 atspi 内部 zbus 版本冲突；
    // atspi 0.22 传递依赖 zbus 4.x，本工程不显式引 zbus 5）。
    use atspi::proxy::accessible::AccessibleProxy;
    use atspi::zbus::Connection;
    use atspi::AccessibilityConnection;

    /// AT-SPI Role 字符串 → unified role（经 ax_role_map 三平台合并表）。
    ///
    /// 与 macOS `map_ax_role("AXButton") → "button"` / Windows `map_ax_role("uia:50005")
    /// → "button"` 同槽位 → 同 unified role（INV-61 OutlineMapper 三平台共享）。
    ///
    /// 入参 `role_str` 取自 `AccessibleProxy::role()` 返回的 AT-SPI role 名
    /// （如 "push button" / "entry" / "text frame"；命名见 atspi-common::Role）。
    #[allow(dead_code)] // Phase B 留入口；snapshot/find/act 真实调用接在 #L1 手测后
    fn atspi_role_to_role(role_str: &str) -> String {
        map_ax_role(role_str).to_string()
    }

    /// 建立 AT-SPI D-Bus registry 连接。
    ///
    /// 真实 Linux runtime 入口点（smoke test 已验 AccessibilityConnection 在
    /// atspi 0.22 编译可达）。Phase B 不在 macOS/Linux-headless 跑 → CI 仅证编译。
    ///
    /// 实装注：atspi 0.22 真实 API 是 `AccessibilityConnection::new()`（不是 open），
    /// 返 `zbus::Result<Self>`，async（async-std runtime）。本函数设计为 async
    /// 避免引入额外 runtime block_on；snapshot 调用方在真机 runtime 时自行 await。
    #[allow(dead_code)]
    async fn open_registry() -> atspi::zbus::Result<AccessibilityConnection> {
        AccessibilityConnection::new().await
    }

    /// `atspi_snapshot` 入口（与 ax.rs::snapshot 同形 AxNode 输出）。
    ///
    /// Phase B 交付边界（parse11 §1.3 诚实红线）：
    ///  - 编译可证（cargo check --target x86_64-unknown-linux-gnu 通过）
    ///  - API surface 真实（AccessibilityConnection / AccessibleProxy / Connection
    ///    符号经 atspi 0.22 + zbus 5 真实导出）
    ///  - 运行时真读 AT-SPI registry 留手测清单 #L1（pending；需真 Linux 桌面）
    pub fn snapshot(id: &str, _params: &serde_json::Value) -> Response {
        Response::err(
            id,
            "not_implemented",
            "atspi_snapshot: registry deep-read pending hand-test #L1 (parse11 §1.3)",
        )
    }

    /// `atspi_find`（与 ax.rs::find 同形输出）。
    pub fn find(id: &str, _params: &serde_json::Value) -> Response {
        Response::err(
            id,
            "not_implemented",
            "atspi_find: pending hand-test #L2 (parse11 §1.3)",
        )
    }

    /// `atspi_act`（与 ax.rs::act 同形输出）。
    pub fn act(id: &str, _params: &serde_json::Value) -> Response {
        Response::err(
            id,
            "not_implemented",
            "atspi_act: pending hand-test #L3 (parse11 §1.3)",
        )
    }

    // ----- compile-time API surface anchors -----
    // 锁住 atspi 0.22 + zbus 5 符号位置（防 crate 漂移）。
    #[allow(dead_code)]
    fn _type_anchors(
        _proxy: Option<AccessibleProxy<'static>>,
        _conn: Option<AccessibilityConnection>,
        _zbus: Option<Connection>,
    ) {
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn atspi_role_to_role_uses_unified_map() {
            // INV-61 contract：AT-SPI role 经 ax_role_map 与 macOS/Windows 同槽位。
            // 具体映射值在 ax_role_map.rs 三平台合并表里断言。
            let r = atspi_role_to_role("push button");
            assert!(!r.is_empty());
        }

        #[test]
        fn snapshot_returns_not_implemented() {
            // Linux runtime 路径在 CI headless 也走不到真 registry；
            // 本测试证明 snapshot 函数可达 + 返 not_implemented（不 panic）。
            let resp = snapshot("test1", &serde_json::Value::Null);
            assert!(!resp.ok);
            assert_eq!(resp.error_kind.as_deref(), Some("not_implemented"));
        }
    }
}

#[cfg(target_os = "linux")]
pub use platform::{act, find, snapshot};

// ============================================================================
// 跨平台单测（macOS 本机跑）：cfg(not(target_os = "linux")) fallback 桩
// ============================================================================

#[cfg(all(test, not(target_os = "linux")))]
mod fallback_tests {
    use super::*;

    #[test]
    fn snapshot_fallback_returns_not_linux() {
        let resp = snapshot("fb1", &serde_json::Value::Null);
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("not_linux"));
    }

    #[test]
    fn find_fallback_returns_not_linux() {
        let resp = find("fb2", &serde_json::Value::Null);
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("not_linux"));
    }

    #[test]
    fn act_fallback_returns_not_linux() {
        let resp = act("fb3", &serde_json::Value::Null);
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("not_linux"));
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
