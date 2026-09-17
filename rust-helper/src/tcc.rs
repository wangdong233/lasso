//! TCC 授权探测（parse4 §3.1.6；v1.11 round1 T11 加第三维；
//! bugs/10 决议 A.4 探测诚实化）。
//!
//! 三个独立维度：
//!   - **Accessibility** — AXAPI 读/写授权（ax_snapshot/ax_find/ax_act 必需）
//!   - **Screen Recording** — CGWindowList 截屏授权（screenshot 必需）
//!   - **Event Synthesizing**（v1.11 T11）— 合成键盘/指针输入的 TCC 维度
//!     （Peekaboo 官方文档 peekaboo.sh/permissions.html 实证）。
//!     探测：`IOHIDCheckAccess(kIOHIDRequestTypePostEvent)`（IOKit/hidsystem；
//!     PostEvent 维度即 System Settings 的「Event Synthesizing」开关）。
//!
//! ## bugs/10（2026-09-17）A.4 探测诚实化：删版本硬门 + Undefined 第三态
//!
//! 旧实现：macOS < 15 硬门直接返 "not_required"（该维度「不存在」）。
//! 实测定谳（bugs/10 §0 断言 5）：macOS 12.7.6 上 dlsym 可解析
//! IOHIDCheckAccess，且 **Undefined 状态下投递实证可用**（无授权终端进程
//! Post mouse move → 真实光标精确落点）——旧「报什么查什么」义务不成立：
//! OS 有话可说（per-process 归因，同机不同进程可报不同值；本仓两数据点
//! 入档：helper 链 granted / 终端进程 undefined）。
//!
//! 故本批起：
//!   - `iohid_post_event_status()`：凡 dlsym 解析到即探测（无版本门），
//!     原始值域 granted/denied/undefined/unavailable（不折叠第三态）
//!   - `event_synthesizing_status()`：同值域，unavailable → "not_required"
//!     （维度缺失的老词汇，供 snapshot/doctor 兼容面）
//!   - **门语义（cgevent::dispatch 预检）行为字节级不变**：
//!     `event_synthesis_gated()` —— macOS <15 永不门控（断言 5：Undefined
//!     下投递实证可用，这是本批最重要的「不变」）；macOS ≥15 非 granted
//!     （denied|undefined）门控（维持已发布行为：旧映射 Undefined→denied）
//!
//! ## 诚实声明（伦理红线锚）
//!
//! 探测只报 OS 所说，不推断、不规避。本仓不存在任何「让未授权合成通过」
//! 的路径变更——本批只让探测面更诚实（Undefined 第三态 + per-process
//! 差异数据入档），门控语义零放松、零收紧。
//!
//! 探测策略：
//!   - Accessibility: `AXIsProcessTrustedWithOptions(NULL)` — 不弹框的版本
//!     （传 NULL options 等价于 macOS 文档里的 "does not prompt the user"）
//!   - Screen Recording: `CGPreflightScreenCaptureAccess()` (macOS 10.15+) —
//!     不弹框的预检；首次实际截屏才会触发系统授权弹窗
//!   - Event Synthesizing: dlsym 运行时解析 `IOHIDCheckAccess`（硬链接会在
//!     旧 SDK link 失败）；符号缺失 → unavailable / not_required
//!
//! 非 macOS：所有探测返回 false / "unavailable" / "not_required"（CI 在
//! Linux 上跑 helper 时，doctor 报「platform unsupported」）。

#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct TccSnapshot {
    pub accessibility: bool,
    pub screen_recording: bool,
    /// v1.11（round1 T11）："granted" | "denied" | "not_required"（macOS < 15）。
    /// bugs/10 A.4 起值域扩为 +"undefined"（真实第三态，不折叠）。
    /// 三态+字符串而非 bool——"not_required" 与 "granted" 语义不同（前者无需配置）。
    pub event_synthesizing: String,
    /// bugs/10 A.4：IOHID PostEvent **advisory 原始探测**（granted/denied/
    /// undefined/unavailable）。与 event_synthesizing 的差别仅在符号缺失时的
    /// 词汇（unavailable vs not_required）——保留两词是为了 doctor 诚实分层：
    /// 「维度不存在」与「探测失败」不是同一句话。additive，旧 TS 忽略。
    pub iohid_post_event: String,
    /// bugs/10 A.4：macOS 产品版本 major（sysctl kern.osproductversion；
    /// 非 macOS / 读失败 = 0）。doctor #21 用它判定 undefined 的门控语义分层。
    pub macos_major: u32,
}

pub fn snapshot() -> TccSnapshot {
    TccSnapshot {
        accessibility: accessibility_granted(),
        screen_recording: screen_recording_granted(),
        event_synthesizing: event_synthesizing_status().to_string(),
        iohid_post_event: iohid_post_event_status().to_string(),
        macos_major: macos_product_major(),
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
// v1.11（round1 T11）：Event Synthesizing 维度（bugs/10 A.4 诚实化改写）
// ============================================================
/// IOHIDRequestType（IOKit/hidsystem/IOHIDLib.h，ABI 稳定枚举值）
///   kIOHIDRequestTypeListenEvent = 1 / PostEvent = 2 / TakeScreenShot = 3
#[cfg(target_os = "macos")]
const K_IOHID_REQUEST_TYPE_POST_EVENT: u32 = 2;

/// IOHIDAccessType：Granted = 0 / Denied = 1 / Undefined = 2
#[cfg(target_os = "macos")]
const K_IOHID_ACCESS_TYPE_GRANTED: u32 = 0;
#[cfg(target_os = "macos")]
const K_IOHID_ACCESS_TYPE_DENIED: u32 = 1;
#[cfg(target_os = "macos")]
const K_IOHID_ACCESS_TYPE_UNDEFINED: u32 = 2;

/// macOS 产品版本 major（sysctl kern.osproductversion，如 "12.7.4" → 12）。
/// 读失败返 0（保守：门控判 <15 → 永不门控，不误杀）。
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

#[cfg(not(target_os = "macos"))]
fn macos_product_major() -> u32 {
    0
}

/// IOHID PostEvent 原始探测（bugs/10 A.4：**无版本门**，凡 dlsym 解析到即探）。
///
/// 返回 "granted" | "denied" | "undefined" | "unavailable"：
///   - granted / denied / undefined = IOHIDCheckAccess 的三态原样上报
///     （Undefined 是真实第三态——本机终端进程实测值，且该状态下投递实证可用）
///   - unavailable = dlopen/dlsym 解析不到符号（维度探测失败）
///
/// 注意 per-process 归因：同机不同进程可报不同值（TCC 按进程归因）。
#[cfg(target_os = "macos")]
fn iohid_post_event_status() -> &'static str {
    // 运行时符号解析（dlopen/dlsym）：IOHIDCheckAccess 在 macOS 12.7.6 实测
    // 可解析（bugs/10 §0 断言 5）；硬链接会在旧 SDK/旧系统 link 失败。
    extern "C" {
        fn dlopen(filename: *const std::os::raw::c_char, flag: std::os::raw::c_int) -> *mut std::ffi::c_void;
        fn dlsym(handle: *mut std::ffi::c_void, symbol: *const std::os::raw::c_char) -> *mut std::ffi::c_void;
    }
    const RTLD_LAZY: std::os::raw::c_int = 0x1;
    let iokit_path = b"/System/Library/Frameworks/IOKit.framework/IOKit\0";
    let iokit = unsafe { dlopen(iokit_path.as_ptr() as *const _, RTLD_LAZY) };
    if iokit.is_null() {
        return "unavailable";
    }
    let sym_name = b"IOHIDCheckAccess\0";
    let sym = unsafe { dlsym(iokit, sym_name.as_ptr() as *const _) };
    if sym.is_null() {
        return "unavailable";
    }
    let check: unsafe extern "C" fn(request_type: u32) -> u32 = unsafe { std::mem::transmute(sym) };
    let access = unsafe { check(K_IOHID_REQUEST_TYPE_POST_EVENT) };
    match access {
        K_IOHID_ACCESS_TYPE_GRANTED => "granted",
        K_IOHID_ACCESS_TYPE_DENIED => "denied",
        // Undefined（2）与其他未知值：按 Undefined 上报（真实第三态，不折叠）
        _ => "undefined",
    }
}

#[cfg(not(target_os = "macos"))]
fn iohid_post_event_status() -> &'static str {
    "unavailable"
}

/// Event Synthesizing 状态（snapshot/doctor 面；门控请用 event_synthesis_gated）。
///
/// bugs/10 A.4 起：无版本门诚实探测，值域 "granted" | "denied" | "undefined"
/// | "not_required"（unavailable → not_required：维度缺失的老兼容词汇）。
#[cfg(target_os = "macos")]
pub fn event_synthesizing_status() -> &'static str {
    match iohid_post_event_status() {
        "unavailable" => "not_required",
        s => s,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn event_synthesizing_status() -> &'static str {
    "not_required"
}

// ============================================================
// bugs/10 A.4：dispatch 门控谓词（行为字节级不变——最重要的「不变」）
// ============================================================

/// 门控谓词（纯函数，版本注入可测；cgevent::dispatch 预检唯一入口）：
///   - macOS < 15 → **永不门控**（bugs/10 §0 断言 5：Undefined 下投递实证
///     可用——照搬 15+ 映射会当场杀死可用的生产路径；任何探测值都不门）
///   - macOS ≥ 15 → 非 granted（denied | undefined）门控（维持已发布行为：
///     旧版此处把 Undefined 折叠进 denied）
///
/// 这不是「让未授权合成通过」：<15 路径本来就不门控（旧版硬门 not_required
/// 同样放行）；本函数只是把该事实从「假装维度不存在」改成「如实探测但不门」。
fn event_synthesis_gated_with(major: u32, status: &str) -> bool {
    if major < 15 {
        return false;
    }
    matches!(status, "denied" | "undefined")
}

/// cgevent::dispatch 的 TCC 预检入口（版本 + 实时探测）。
pub fn event_synthesis_gated() -> bool {
    event_synthesis_gated_with(macos_product_major(), event_synthesizing_status())
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
        // v1.11 T11 + bugs/10 A.4：四态字符串（+undefined 真实第三态）
        assert!(matches!(
            s.event_synthesizing.as_str(),
            "granted" | "denied" | "undefined" | "not_required"
        ));
        assert!(matches!(
            s.iohid_post_event.as_str(),
            "granted" | "denied" | "undefined" | "unavailable"
        ));
        assert!(s.macos_major < 100); // major 合理界（0=非 macOS/读失败）
    }

    /// bugs/10 A.4 核心「不变」：门控谓词版本注入矩阵。
    /// <15 任何值不门（断言 5——最重要的不变）；≥15 非 granted 门控（旧行为）。
    #[test]
    fn gate_predicate_version_matrix() {
        // macOS < 15：永不门控（undefined/denied/任何值）
        for status in ["granted", "denied", "undefined", "not_required"] {
            assert_eq!(
                event_synthesis_gated_with(12, status),
                false,
                "<15 must never gate (got {status})"
            );
            assert_eq!(
                event_synthesis_gated_with(14, status),
                false,
                "<15 must never gate (got {status})"
            );
            assert_eq!(event_synthesis_gated_with(0, status), false); // 读失败=保守
        }
        // macOS ≥ 15：维持已发布行为（denied 门 + Undefined 旧映射为 denied 同效）
        assert!(event_synthesis_gated_with(15, "denied"));
        assert!(event_synthesis_gated_with(15, "undefined"));
        assert!(event_synthesis_gated_with(26, "undefined"));
        assert!(!event_synthesis_gated_with(15, "granted"));
        assert!(!event_synthesis_gated_with(26, "granted"));
        // 符号缺失（not_required）→ 不门（与旧版一致）
        assert!(!event_synthesis_gated_with(15, "not_required"));
    }

    /// 本机（macOS 12）实测锚：诚实探测应能解析符号（断言 5 数据点复现位）。
    /// 只验值域合法 + 门控为假——不钉死具体值（per-process 归因，CI/本地可异）。
    #[test]
    #[cfg(target_os = "macos")]
    fn macos12_honest_probe_and_no_gate() {
        let major = macos_product_major();
        let raw = iohid_post_event_status();
        assert!(matches!(
            raw,
            "granted" | "denied" | "undefined" | "unavailable"
        ));
        if major < 15 {
            // 本批最重要的「不变」：<15 实时门控恒 false（含 undefined 实测值）
            assert!(!event_synthesis_gated());
        }
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn non_macos_returns_false() {
        assert!(!accessibility_granted());
        assert!(!screen_recording_granted());
        assert_eq!(event_synthesizing_status(), "not_required");
        assert_eq!(iohid_post_event_status(), "unavailable");
        assert_eq!(macos_product_major(), 0);
        assert!(!event_synthesis_gated());
    }
}
