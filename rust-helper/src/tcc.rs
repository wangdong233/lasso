//! TCC 授权探测（parse4 §3.1.6；v1.11 round1 T11 加第三维）。
//!
//! 三个独立维度：
//!   - **Accessibility** — AXAPI 读/写授权（ax_snapshot/ax_find/ax_act 必需）
//!   - **Screen Recording** — CGWindowList 截屏授权（screenshot 必需）
//!   - **Event Synthesizing**（v1.11 T11）— macOS 15+ 合成键盘/指针输入的
//!     新 TCC 维度（Peekaboo 官方文档 peekaboo.sh/permissions.html 实证）。
//!     探测：`IOHIDCheckAccess(kIOHIDRequestTypePostEvent)`（IOKit/hidsystem；
//!     PostEvent 维度即 System Settings 的「Event Synthesizing」开关）。
//!     < macOS 15 该维度不存在 → 返 "not_required"（不误导）。
//!
//! 探测策略：
//!   - Accessibility: `AXIsProcessTrustedWithOptions(NULL)` — 不弹框的版本
//!     （传 NULL options 等价于 macOS 文档里的 "does not prompt the user"）
//!   - Screen Recording: `CGPreflightScreenCaptureAccess()` (macOS 10.15+) —
//!     不弹框的预检；首次实际截屏才会触发系统授权弹窗
//!   - Event Synthesizing: 版本门（kern.osproductversion major ≥ 15）+
//!     `IOHIDCheckAccess(kIOHIDRequestTypePostEvent=2)`（ Granted=0 → "granted"；
//!     Denied/Undefined → "denied"）
//!
//! 非 macOS：所有探测返回 false / "not_required"（CI 在 Linux 上跑 helper 时，
//! doctor 报「platform unsupported」）。

#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct TccSnapshot {
    pub accessibility: bool,
    pub screen_recording: bool,
    /// v1.11（round1 T11）："granted" | "denied" | "not_required"（macOS < 15）。
    /// 三态字符串而非 bool——"not_required" 与 "granted" 语义不同（前者无需配置）。
    pub event_synthesizing: String,
}

pub fn snapshot() -> TccSnapshot {
    TccSnapshot {
        accessibility: accessibility_granted(),
        screen_recording: screen_recording_granted(),
        event_synthesizing: event_synthesizing_status().to_string(),
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

// ============================================================
// v1.11（round1 T11）：Event Synthesizing 第三维（macOS 15+）
// ============================================================
/// IOHIDRequestType（IOKit/hidsystem/IOHIDLib.h，ABI 稳定枚举值）
///   kIOHIDRequestTypeListenEvent = 1 / PostEvent = 2 / TakeScreenShot = 3
#[cfg(target_os = "macos")]
const K_IOHID_REQUEST_TYPE_POST_EVENT: u32 = 2;

/// IOHIDAccessType：Granted = 0 / Denied = 1 / Undefined = 2
#[cfg(target_os = "macos")]
const K_IOHID_ACCESS_TYPE_GRANTED: u32 = 0;

/// macOS 产品版本 major（sysctl kern.osproductversion，如 "12.7.4" → 12）。
/// 读失败返 0（保守：0 < 15 → not_required，不误报 denied）。
#[cfg(target_os = "macos")]
fn macos_product_major() -> u32 {
    extern "C" {
        fn sysctlbyname(
            name: *const std::os::raw::c_char,
            oldp: *mut std::ffi::c_void,
            oldlenp: *mut usize,
            newp: *const std::ffi::c_void,
            newlen: usize,
        ) -> std::os::raw::c_int;
    }
    let name = b"kern.osproductversion\0";
    let mut buf = [0u8; 32];
    let mut len: usize = buf.len();
    let ok = unsafe {
        sysctlbyname(
            name.as_ptr() as *const std::os::raw::c_char,
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            &mut len,
            std::ptr::null(),
            0,
        )
    };
    if ok != 0 {
        return 0;
    }
    let s = String::from_utf8_lossy(&buf[..len.saturating_sub(1).min(buf.len())]);
    s.split('.')
        .next()
        .and_then(|m| m.parse::<u32>().ok())
        .unwrap_or(0)
}

/// Event Synthesizing 状态三态探测（v1.11 T11）。
///
/// - macOS < 15 → "not_required"（该 TCC 维度不存在；Accessibility 即够）
/// - macOS ≥ 15 → IOHIDCheckAccess(PostEvent)：Granted → "granted"；
///   Denied / Undefined → "denied"（档3 CGEvent 合成会被静默拦截——诚实报因）
///
/// 本机 macOS 12 无法验证 15+ 路径（按 uia/atspi 诚实 pending 先例：
/// cfg/版本门保证编译与 <15 路径正确；15+ 真机验证归手测清单 D1）。
#[cfg(target_os = "macos")]
pub fn event_synthesizing_status() -> &'static str {
    if macos_product_major() < 15 {
        return "not_required";
    }
    // 运行时符号解析（dlopen/dlsym）：IOHIDCheckAccess 是 macOS 15+ 符号，
    // 硬链接会在旧 SDK/旧系统（本机 macOS 12）link 失败。符号缺失 → not_required
    // （保守：不误报 denied；15+ 真机归手测清单 D1 验证）。
    extern "C" {
        fn dlopen(filename: *const std::os::raw::c_char, flag: std::os::raw::c_int) -> *mut std::ffi::c_void;
        fn dlsym(handle: *mut std::ffi::c_void, symbol: *const std::os::raw::c_char) -> *mut std::ffi::c_void;
    }
    const RTLD_LAZY: std::os::raw::c_int = 0x1;
    let iokit_path = b"/System/Library/Frameworks/IOKit.framework/IOKit\0";
    let iokit = unsafe { dlopen(iokit_path.as_ptr() as *const _, RTLD_LAZY) };
    if iokit.is_null() {
        return "not_required";
    }
    let sym_name = b"IOHIDCheckAccess\0";
    let sym = unsafe { dlsym(iokit, sym_name.as_ptr() as *const _) };
    if sym.is_null() {
        return "not_required";
    }
    let check: unsafe extern "C" fn(request_type: u32) -> u32 = unsafe { std::mem::transmute(sym) };
    let access = unsafe { check(K_IOHID_REQUEST_TYPE_POST_EVENT) };
    if access == K_IOHID_ACCESS_TYPE_GRANTED {
        "granted"
    } else {
        "denied"
    }
}

#[cfg(not(target_os = "macos"))]
pub fn event_synthesizing_status() -> &'static str {
    "not_required"
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
    fn snapshot_returns_consistent_triple() {
        let s = snapshot();
        // 非授权或非 macOS 至少返回 false；macOS 已授权返回 true
        let _ = s.accessibility; // 不 assert 具体值（CI 与本地不同）
        let _ = s.screen_recording;
        // v1.11 T11：第三维是三态字符串（granted/denied/not_required）
        assert!(matches!(
            s.event_synthesizing.as_str(),
            "granted" | "denied" | "not_required"
        ));
    }

    /// 版本门单测：本机（macOS 12）必须返 not_required（15+ 路径归手测）。
    #[test]
    #[cfg(target_os = "macos")]
    fn event_synthesizing_below_macos15_is_not_required() {
        let major = macos_product_major();
        let status = event_synthesizing_status();
        if major < 15 {
            assert_eq!(status, "not_required");
        }
        // major >= 15（CI 不会走到；真机 15+ 手测清单 D1）
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn non_macos_returns_false() {
        assert!(!accessibility_granted());
        assert!(!screen_recording_granted());
        assert_eq!(event_synthesizing_status(), "not_required");
    }
}
