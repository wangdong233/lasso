//! list_windows（parse5 §2.2 + §3.5.5）—— forest interact_roots 数据源。
//!
//! 经 **CGWindowListCopyWindowInfo**（core-graphics）枚举当前所有 on-screen 正常窗口
//! （layer==0），返一个 JSON 数组。forest 调度层据此生成 `@wN` root。
//!
//! 设计要点：
//!  - 用 CGWindowList 而非 AX system_wide.children：后者在本 AppKit 下实测返空（0 apps），
//!    CGWindowListCopyWindowInfo 是 macOS 枚举窗口的规范 API，不依赖 NSWorkspace/AX children
//!  - **仅 layer==0 正常窗口**（排除 menu bar / dock / 悬浮层）
//!  - windowId = 真 `kCGWindowNumber`（CGWindowID，u32→i64）：窗口生命周期内稳定的系统 ID
//!    （比位置索引稳：z-order 变化不 churn forest @wN ref）；forest identity = owner+windowNumber+title
//!  - bundleId CGWindowList 不提供 → 返空串（forest identity 不依赖它）
//!  - owner/pid/windowNumber/bounds **不需 Screen Recording**；仅 kCGWindowName 未授 Screen
//!    Recording 时被 macOS redact（title 返空），不阻断 list_windows
//!
//! 与 ax.rs 的差异：
//!  - ax.rs::snapshot 深度遍历某一 app 的整棵 AX tree（observe，需 Accessibility）
//!  - windows.rs::list_windows 浅枚举所有 on-screen 窗口（listRoots 用，CGWindowList）
//!  - 两者互不依赖；ax.rs 不调 windows.rs，反之亦然
//!
//! INV-21 衍生（platform literal isolation）：所有 CG*/CF* 调用都在本文件 + ax.rs +
//! screenshot.rs + tcc.rs；TS 层永不直接调平台符号。

use crate::protocol::Response;
use crate::tcc;

// ============================================================================
// Non-macOS fallback：返 not_macos（CI 在 Linux 跑 helper 时 list_windows 不报错，仅返空）
// ============================================================================

#[cfg(not(target_os = "macos"))]
pub fn list_windows(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "list_windows requires macOS")
}

// ============================================================================
// macOS 实装
// ============================================================================

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use core_foundation::{
        base::{CFType, TCFType},
        number::CFNumber,
        string::CFString,
    };
    use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex};
    use core_foundation_sys::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
    use core_graphics::window::{
        copy_window_info, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGNullWindowID, kCGWindowNumber,
        kCGWindowOwnerName, kCGWindowOwnerPID,
    };
    use std::ffi::c_void;

    /// 枚举窗口上限（守护：CGWindowListCopyWindowInfo 偶发返数百 entry）。
    const MAX_WINDOWS: usize = 256;

    /// `list_windows` 入口：经 **CGWindowListCopyWindowInfo** 枚举当前所有 on-screen
    /// 窗口（forest interact_roots 数据源）。
    ///
    /// 用 core_foundation_sys 原始 C API（CFArrayGetValueAtIndex + CFDictionaryGetValue）
    /// 读 CFArray<CFDictionary>，避开 high-level CFDictionary 包装的 ConcreteCFType bound
    /// 与 ItemRef/`*const __CFDictionary` 类型不一致问题。
    ///
    /// **windowId = 真 kCGWindowNumber**（CGWindowID，u32→i64）。窗口生命周期内稳定的
    /// 系统 ID，forest rootRef identity 据此去重（比位置索引稳：z-order 变化不 churn ref）。
    ///
    /// **为何 CGWindowList 而非 AX system_wide.children**：后者在本 AppKit 下实测返空
    /// （0 apps）；CGWindowListCopyWindowInfo 是 macOS 枚举窗口的规范 API，不依赖
    /// NSWorkspace/AX children。owner/pid/windowNumber **不需 Screen Recording**；仅
    /// kCGWindowName 未授 Screen Recording 时被 macOS redact（title 返空）。bundleId
    /// CGWindowList 不提供 → 返空串。rect 暂 null（嵌套 dict 留 v0.4.x raw API 补）。
    pub fn list_windows(id: &str, _params: &serde_json::Value) -> Response {
        let opt = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
        let arr = match copy_window_info(opt, kCGNullWindowID) {
            Some(a) => a,
            None => return Response::ok(id, serde_json::json!({ "windows": [] })),
        };

        let arr_ref = arr.as_concrete_TypeRef();
        let count = unsafe { CFArrayGetCount(arr_ref) };

        // 读 extern statics（需 unsafe）；转 *const c_void 供 CFDictionaryGetValue 用
        let (k_owner, k_name, k_num, k_layer, k_pid) = unsafe {
            (
                kCGWindowOwnerName as *const c_void,
                kCGWindowName as *const c_void,
                kCGWindowNumber as *const c_void,
                kCGWindowLayer as *const c_void,
                kCGWindowOwnerPID as *const c_void,
            )
        };

        let mut windows: Vec<serde_json::Value> = Vec::new();
        let cap = (count as usize).min(MAX_WINDOWS);
        for i in 0..cap {
            let dict_ref: CFDictionaryRef =
                unsafe { CFArrayGetValueAtIndex(arr_ref, i as isize) as CFDictionaryRef };
            if (dict_ref as *const c_void).is_null() {
                continue;
            }

            // 仅取 layer==0 的正常窗口（排除 menu bar / dock / 悬浮层）
            let layer = cf_i32(dict_ref, k_layer).unwrap_or(-1);
            if layer != 0 {
                continue;
            }

            let app_name = cf_string(dict_ref, k_owner);
            if app_name.is_empty() {
                continue;
            }
            let title = cf_string(dict_ref, k_name);
            let pid = cf_i64(dict_ref, k_pid).unwrap_or(0);
            let window_id = cf_i64(dict_ref, k_num).unwrap_or(0);

            windows.push(serde_json::json!({
                "bundleId": "",
                "pid": pid,
                "windowId": window_id,
                "app": app_name,
                "title": title,
                "rect": serde_json::Value::Null,
            }));
        }

        Response::ok(id, serde_json::json!({ "windows": windows }))
    }

    /// 读 CFDictionary 的字符串值；空/null/类型不符返空串。
    fn cf_string(dict: CFDictionaryRef, key: *const c_void) -> String {
        unsafe {
            let v = CFDictionaryGetValue(dict, key);
            if v.is_null() {
                return String::new();
            }
            let cf = CFType::wrap_under_get_rule(v);
            cf.downcast::<CFString>().map(|s| s.to_string()).unwrap_or_default()
        }
    }

    /// 读 CFDictionary 的 i64 数值（kCGWindowNumber / kCGWindowOwnerPID）。
    fn cf_i64(dict: CFDictionaryRef, key: *const c_void) -> Option<i64> {
        unsafe {
            let v = CFDictionaryGetValue(dict, key);
            if v.is_null() {
                return None;
            }
            let cf = CFType::wrap_under_get_rule(v);
            cf.downcast::<CFNumber>().and_then(|n| n.to_i64())
        }
    }

    /// 读 CFDictionary 的 i32 数值（kCGWindowLayer）。
    fn cf_i32(dict: CFDictionaryRef, key: *const c_void) -> Option<i32> {
        unsafe {
            let v = CFDictionaryGetValue(dict, key);
            if v.is_null() {
                return None;
            }
            let cf = CFType::wrap_under_get_rule(v);
            cf.downcast::<CFNumber>().and_then(|n| n.to_i32())
        }
    }
}

#[cfg(target_os = "macos")]
pub use platform::list_windows;
