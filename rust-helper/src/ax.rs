//! AXAPI 核心路径（parse4 §3.1.4 + §4.1 决策落地）。
//!
//! ## API 选择（smoke test 验证后的决策）
//!
//! 通过 `examples/smoke_api.rs`（cargo run --example smoke_api）经验性确认 accessibility 0.2 +
//! accessibility-sys 0.2 真实暴露的符号。**parse4 §4.1 明示：若 FFI 批读签名太脆，
//! 允许降级为逐属性 `.attribute()` 读（正确性 > 10x perf）。** 本文件采如下分层：
//!
//! - **typed 属性**（role/title/enabled/focused/children）走 safe wrapper 预定义 accessors：
//!   - `AXUIElementAttributes` trait 提供 `.role()` / `.title()` / `.enabled()` / `.focused()`
//!   - `.attribute(&AXAttribute::children())` 返回 `CFArray<AXUIElement>`（**非 Vec**）
//! - **几何属性**（AXPosition/AXSize）不在 safe trait，必须 raw FFI 路径：
//!   - `AXUIElementCopyAttributeValue(el, "AXPosition", &out) → AXValueRef`
//!   - `AXValueGetValue(value, kAXValueTypeCGPoint=1, &CGPoint)` 取 CGPoint
//!   - 同理 `kAXValueTypeCGSize=2` 取 CGSize
//! - **批读 FFI**（`AXUIElementCopyMultipleAttributeValues`）符号可达但解析 CFArray<CFType>
//!   每值需手动判断 CFTypeID 再 cast — 复杂且容易漏 release；推到 Phase D 优化
//!   （仅 M0.5a 验收第 4 条 ≤30ms 不达标时才加）。
//!
//! ## resolve_root 策略
//!
//! - `app=None` → `AXUIElement::system_wide()`（safe wrapper；smoke test 验证可达）
//! - `app=Some(name)` → 含 `.` 当作 bundle id（"com.apple.finder"）；否则当人名经
//!   `bundle_id_for_app_name` 精选表查 bundle id（"Finder"/"Mail"/"系统设置"），再
//!   `application_with_bundle`。这覆盖 parse4 §6.1 acceptance #1 用人名调 snapshot。
//!   v0.3.5 用精选表而非 NSWorkspace 枚举：`runningApplicationsWithOptions:` 等枚举
//!   选择子在本 AppKit + Rust objc 桥下不可靠（unrecognized selector）；人名→bundle
//!   表是确定性、CI 可单测的，完整 NSWorkspace 枚举留 v0.4。
//! - 任一路径调用前先 `tcc::accessibility_granted()` 预检，false → `error_kind="tcc_denied"`
//!
//! ## 协议出口
//!
//! 所有 method 返回 `protocol::Response`：成功 `Response::ok(id, json!({...}))`，
//! 失败 `Response::err(id, kind, msg)`，kind ∈ {"not_macos","tcc_denied","app_not_found",
//! "ax_unavailable","invalid_params","not_implemented"}.

use crate::ax_role_map::map_ax_role;
use crate::protocol::Response;
use crate::tcc;

use serde::Serialize;

#[derive(Serialize, Debug, Clone)]
pub struct AxRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Default for AxRect {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct AxNode {
    pub role: String,        // unified role（已映射；map_ax_role 输出）
    pub raw_role: String,    // 原 AXRole 字符串（debug；不进 OutlineNode 接口）
    pub label: String,       // AXTitle（无则空串）
    pub rect: AxRect,
    pub enabled: bool,
    pub focused: bool,
    pub depth: usize,
    pub children: Vec<AxNode>,
    /// v0.4 forest rootRef 身份用（parse5 §2.2）：仅 root（depth=0）填，
    /// 形如 `pid * 1_000_000 + window_index`（与 windows.rs::list_windows 合成规则一致）。
    /// 子节点不填；`skip_serializing_if` 让 wire shape 在 None 时与 v0.3.5 字节一致。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<i64>,
}

// ============================================================================
// Non-macOS fallback：所有 method 返回 not_macos
// ============================================================================

#[cfg(not(target_os = "macos"))]
pub fn snapshot(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "ax_snapshot requires macOS")
}

#[cfg(not(target_os = "macos"))]
pub fn find(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "ax_find requires macOS")
}

#[cfg(not(target_os = "macos"))]
pub fn act(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "ax_act requires macOS")
}

// ============================================================================
// macOS 实装
// ============================================================================

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use accessibility::{AXAttribute, AXUIElement};
    use accessibility_sys::{
        AXUIElementCopyAttributeValue, AXValueGetValue, AXValueRef, AXValueType,
    };
    use core_foundation::{
        array::CFArray, base::{CFType, TCFType}, boolean::CFBoolean, string::CFString,
    };
    use core_graphics_types::geometry::{CGPoint, CGSize};

    /// AXValue 类型常量（accessibility_sys::value_constants 里的 u32 值）。
    /// 直接硬编码避免再引 type alias（这些是 ABI 稳定的苹果 API 常量）。
    const AX_VALUE_TYPE_CG_POINT: AXValueType = 1; // kAXValueTypeCGPoint
    const AX_VALUE_TYPE_CG_SIZE: AXValueType = 2;  // kAXValueTypeCGSize

    /// `ax_snapshot` 入口。
    pub fn snapshot(id: &str, params: &serde_json::Value) -> Response {
        let app = params.get("app").and_then(|v| v.as_str());
        let max_depth = params
            .get("max_depth")
            .and_then(|v| v.as_u64())
            .unwrap_or(8) as usize;

        let root = match resolve_root(app) {
            Ok(r) => r,
            Err(kind) => return Response::err(id, &kind, format!("resolve_root({:?}) failed", app)),
        };
        let tree = walk(&root, 0, max_depth);
        match serde_json::to_value(&tree) {
            Ok(v) => Response::ok(id, v),
            Err(e) => Response::err(id, "ax_unavailable", format!("serialize: {e}")),
        }
    }

    /// `ax_find`：基于 snapshot 后的纯字符串/role 查询（parse4 §3.3 find 专用）。
    /// v0.3.5 简化：每次 find 都重 walk（state_id 仅做协议占位，未真缓存）；
    /// TS 端 OutlineMapper 可后续做 snapshot cache（v0.4+ 优化）。
    pub fn find(id: &str, params: &serde_json::Value) -> Response {
        let app = params.get("app").and_then(|v| v.as_str());
        let max_depth = params
            .get("max_depth")
            .and_then(|v| v.as_u64())
            .unwrap_or(8) as usize;
        let want_text = params
            .get("where")
            .and_then(|w| w.get("text"))
            .and_then(|v| v.as_str());
        let want_role = params
            .get("where")
            .and_then(|w| w.get("role"))
            .and_then(|v| v.as_str());

        let root = match resolve_root(app) {
            Ok(r) => r,
            Err(kind) => return Response::err(id, &kind, format!("resolve_root({:?}) failed", app)),
        };
        let tree = walk(&root, 0, max_depth);

        // 递归过滤
        let mut hits: Vec<serde_json::Value> = Vec::new();
        let mut ref_counter: usize = 0;
        collect_matches(&tree, want_text, want_role, &mut hits, &mut ref_counter);

        Response::ok(
            id,
            serde_json::json!({
                "matches": hits,
                "count": hits.len(),
            }),
        )
    }

    /// `ax_act`：v0.3.5 Phase A 仅占位（act 的 AXPress/AXSetValue 在 Phase B M0.5b 落地）。
    pub fn act(id: &str, _params: &serde_json::Value) -> Response {
        Response::err(
            id,
            "not_implemented",
            "ax_act lands in Phase B (M0.5b); Phase A is observe-only",
        )
    }

    fn collect_matches(
        node: &AxNode,
        want_text: Option<&str>,
        want_role: Option<&str>,
        out: &mut Vec<serde_json::Value>,
        ref_counter: &mut usize,
    ) {
        let text_match = want_text.map_or(true, |t| {
            !node.label.is_empty() && node.label.to_lowercase().contains(&t.to_lowercase())
        });
        let role_match = want_role.map_or(true, |r| node.role == r);
        if text_match && role_match {
            let ref_id = format!("@e{}", *ref_counter);
            *ref_counter += 1;
            out.push(serde_json::json!({
                "ref": ref_id,
                "role": node.role,
                "label": node.label,
                "rect": node.rect,
            }));
        }
        for child in &node.children {
            collect_matches(child, want_text, want_role, out, ref_counter);
        }
    }

    /// 递归 walk，逐节点读 role/title/position/size/enabled/focused/children。
    fn walk(el: &AXUIElement, depth: usize, max_depth: usize) -> AxNode {
        let raw_role = el.attribute(&AXAttribute::role())
            .map(|s: CFString| s.to_string())
            .unwrap_or_default();
        let title = el.attribute(&AXAttribute::title())
            .map(|s: CFString| s.to_string())
            .unwrap_or_default();
        let enabled = el
            .attribute(&AXAttribute::enabled())
            .map(|b: CFBoolean| b == CFBoolean::true_value())
            .unwrap_or(true);
        let focused = el
            .attribute(&AXAttribute::focused())
            .map(|b: CFBoolean| b == CFBoolean::true_value())
            .unwrap_or(false);
        let rect = read_rect(el);

        let children = if depth < max_depth {
            match el.attribute::<CFArray<AXUIElement>>(&AXAttribute::children()) {
                Ok(arr) => arr
                    .iter()
                    .map(|c| walk(&*c, depth + 1, max_depth))
                    .collect(),
                Err(_) => Vec::new(),
            }
        } else {
            Vec::new()
        };

        AxNode {
            role: map_ax_role(&raw_role).to_string(),
            raw_role,
            label: title,
            rect,
            enabled,
            focused,
            depth,
            children,
            window_id: None,
        }
    }

    /// 读 AXPosition + AXSize 合成 AxRect；任一失败返回 default。
    ///
    /// 直接走 FFI（不在 safe wrapper 预定义 trait 里）；release 由 CFRelease 守。
    fn read_rect(el: &AXUIElement) -> AxRect {
        let pos = read_point(el, "AXPosition");
        let size = read_size(el, "AXSize");
        match (pos, size) {
            (Some(p), Some(s)) => AxRect { x: p.x, y: p.y, w: s.width, h: s.height },
            _ => AxRect::default(),
        }
    }

    fn read_point(el: &AXUIElement, attr: &str) -> Option<CGPoint> {
        let cf_str = CFString::new(attr);
        let mut raw: core_foundation_sys::base::CFTypeRef = std::ptr::null();
        let out: CFType = unsafe {
            let err = AXUIElementCopyAttributeValue(
                el.as_concrete_TypeRef(),
                cf_str.as_concrete_TypeRef(),
                &mut raw,
            );
            if err != 0 || raw.is_null() {
                return None;
            }
            // raw 现在是 AXValueRef（实质 CFTypeRef 子类）；用 CFType 包住自动 release
            CFType::wrap_under_create_rule(raw)
        };
        let value_ref = out.as_CFTypeRef() as AXValueRef;
        let mut point = CGPoint { x: 0.0, y: 0.0 };
        let ok = unsafe {
            AXValueGetValue(value_ref, AX_VALUE_TYPE_CG_POINT, &mut point as *mut _ as *mut std::ffi::c_void)
        };
        drop(out); // CFType drop 释放 AXValueRef
        if ok { Some(point) } else { None }
    }

    fn read_size(el: &AXUIElement, attr: &str) -> Option<CGSize> {
        let cf_str = CFString::new(attr);
        let mut raw: core_foundation_sys::base::CFTypeRef = std::ptr::null();
        let out: CFType = unsafe {
            let err = AXUIElementCopyAttributeValue(
                el.as_concrete_TypeRef(),
                cf_str.as_concrete_TypeRef(),
                &mut raw,
            );
            if err != 0 || raw.is_null() {
                return None;
            }
            CFType::wrap_under_create_rule(raw)
        };
        let value_ref = out.as_CFTypeRef() as AXValueRef;
        let mut size = CGSize { width: 0.0, height: 0.0 };
        let ok = unsafe {
            AXValueGetValue(value_ref, AX_VALUE_TYPE_CG_SIZE, &mut size as *mut _ as *mut std::ffi::c_void)
        };
        drop(out);
        if ok { Some(size) } else { None }
    }

    /// 解析 root：app=None → system_wide；Some → application_with_bundle。
    fn resolve_root(app: Option<&str>) -> Result<AXUIElement, String> {
        if !tcc::accessibility_granted() {
            return Err("tcc_denied".into());
        }
        match app {
            None => Ok(AXUIElement::system_wide()),
            // Accept BOTH bundle ids ("com.apple.finder") AND human names ("Finder").
            // parse4 §6.1 acceptance #1 + DESKTOP_DESCRIPTION use human names. The safe
            // `application_with_bundle` only resolves bundle ids, so a name without a dot
            // is mapped through `bundle_id_for_app_name` (curated table) first.
            Some(name) => {
                let bundle = if name.contains('.') {
                    name.to_string()
                } else {
                    match crate::app_bundle_map::bundle_id_for_app_name(name) {
                        Some(b) => b.to_string(),
                        None => return Err("app_not_found".to_string()),
                    }
                };
                AXUIElement::application_with_bundle(&bundle).map_err(|e| {
                    if matches!(e, accessibility::Error::NotFound) {
                        "app_not_found".to_string()
                    } else {
                        "ax_unavailable".to_string()
                    }
                })
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use platform::{act, find, snapshot};
