//! TCC 授权探测（parse4 §3.1.6）。
//!
//! 两个独立维度：
//!   - **Accessibility** — AXAPI 读/写授权（ax_snapshot/ax_find/ax_act 必需）
//!   - **Screen Recording** — CGWindowList 截屏授权（screenshot 必需）
//!
//! 探测策略：
//!   - Accessibility: `AXIsProcessTrustedWithOptions(NULL)` — 不弹框的版本
//!     （传 NULL options 等价于 macOS 文档里的 "does not prompt the user"）
//!   - Screen Recording: `CGPreflightScreenCaptureAccess()` (macOS 10.15+) —
//!     不弹框的预检；首次实际截屏才会触发系统授权弹窗
//!
//! 非 macOS：所有探测返回 false（CI 在 Linux 上跑 helper 时，doctor 报「platform unsupported」）。

#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct TccSnapshot {
    pub accessibility: bool,
    pub screen_recording: bool,
}

pub fn snapshot() -> TccSnapshot {
    TccSnapshot {
        accessibility: accessibility_granted(),
        screen_recording: screen_recording_granted(),
    }
}

#[cfg(target_os = "macos")]
pub fn accessibility_granted() -> bool {
    // NULL options → 不弹框（macOS 文档：kAXTrustedCheckOptionPrompt 默认 false）
    unsafe { accessibility_sys::AXIsProcessTrustedWithOptions(std::ptr::null_mut()) }
}

#[cfg(target_os = "macos")]
pub fn screen_recording_granted() -> bool {
    // CGPreflightScreenCaptureAccess (macOS 10.15+) — preflight 不弹框；
    // CGRequestScreenCaptureAccess 才弹框，v0.3.5 不主动调（doctor 引导用户去 System Settings）。
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    unsafe { CGPreflightScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_granted() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn screen_recording_granted() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_returns_consistent_pair() {
        let s = snapshot();
        // 非授权或非 macOS 至少返回 false；macOS 已授权返回 true
        let _ = s.accessibility; // 不 assert 具体值（CI 与本地不同）
        let _ = s.screen_recording;
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn non_macos_returns_false() {
        assert!(!accessibility_granted());
        assert!(!screen_recording_granted());
    }
}
