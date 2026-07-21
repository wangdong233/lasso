//! CGEvent keyboard synthesis (parse5 §3.5.3 + §3.5.5 + INV-28).
//!
//! ## 路径选型（smoke 验证后决策）
//!
//!   见 `examples/smoke_cgevent.rs`：core-graphics 0.24 高层 wrapper 完全够用：
//!   - `CGEventSource::new(CGEventSourceStateID::HIDSystemState) -> Result<Self, ()>`
//!   - `CGEvent::new_keyboard_event(source: CGEventSource, keycode, keydown) -> Result<CGEvent, ()>`
//!     （source by value；move；生产每次事件新 source）
//!   - `CGEvent::post(&self, tap: CGEventTapLocation) -> ()`  （返 unit）
//!   - `CGEvent::set_flags(&self, CGEventFlags)` / `get_flags()` / `get_type()`
//!   - **不需要** core-graphics-sys raw FFI
//!
//! ## INV-28 红线
//!
//!   - `key` / `hotkey` 入参只接 &str 逻辑键名（"Return" / "cmd+c"）
//!   - 不接受 number 类型 keycode（params schema 在 protocol 层松，但本函数
//!     强制 as_str() + keymap 查表；数字入参走 cgevent_unknown_key 拒绝）
//!   - 所有原始 keycode 字面量只许在 cgevent_keymap.rs 出现
//!
//! ## 协议出口
//!
//!   `cgevent::key(id, params) -> Response`
//!     params: { "key": "Return" }
//!     成功：{ok:true, result:{key:"Return", posted:true}}
//!     失败：cgevent_unknown_key / cgevent_source_failed / cgevent_construct_failed
//!           / not_macos
//!
//!   `cgevent::hotkey(id, params) -> Response`
//!     params: { "keys": "cmd+c" }
//!     成功：{ok:true, result:{keys:"cmd+c", posted:true}}
//!     失败：cgevent_unknown_key / ... (同 key)
//!
//!   `cgevent::dispatch(id, params) -> Response`
//!     params: { "actions": [{kind:"press",key:"Return"},{kind:"hotkey",keys:"cmd+c"}] }
//!     批处理入口；逐项执行，每项独立成败（结果数组）。

use crate::cgevent_keymap::{parse_hotkey, parse_key, KeyMapping};
use crate::protocol::Response;

// ============================================================================
// Non-macOS fallback
// ============================================================================

#[cfg(not(target_os = "macos"))]
pub fn key(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "cgevent_key requires macOS")
}

#[cfg(not(target_os = "macos"))]
pub fn hotkey(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "cgevent_hotkey requires macOS")
}

#[cfg(not(target_os = "macos"))]
pub fn dispatch(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "cgevent_dispatch requires macOS")
}

// ============================================================================
// macOS 实装
// ============================================================================

#[cfg(target_os = "macos")]
pub fn key(id: &str, params: &serde_json::Value) -> Response {
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let key_name = match params.get("key").and_then(|v| v.as_str()) {
        Some(k) => k,
        None => {
            return Response::err(
                id,
                "invalid_params",
                "cgevent_key requires {key: string}; numeric keycodes not accepted (INV-28)",
            );
        }
    };
    let mapping = match parse_key(key_name) {
        Some(m) => m,
        None => {
            return Response::err(
                id,
                "cgevent_unknown_key",
                format!("unknown logical key: {:?}", key_name),
            );
        }
    };

    let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(()) => {
            return Response::err(
                id,
                "cgevent_source_failed",
                "CGEventSource::new(HIDSystemState) returned NULL",
            );
        }
    };
    if let Err(()) = post_key_event(source, &mapping) {
        return Response::err(
            id,
            "cgevent_construct_failed",
            format!("CGEvent::new_keyboard_event failed for {:?}", key_name),
        );
    }
    Response::ok(
        id,
        serde_json::json!({ "key": key_name, "posted": true }),
    )
}

#[cfg(target_os = "macos")]
pub fn hotkey(id: &str, params: &serde_json::Value) -> Response {
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let spec = match params.get("keys").and_then(|v| v.as_str()) {
        Some(k) => k,
        None => {
            return Response::err(
                id,
                "invalid_params",
                "cgevent_hotkey requires {keys: string}",
            );
        }
    };
    let mapping = match parse_hotkey(spec) {
        Some(m) => m,
        None => {
            return Response::err(
                id,
                "cgevent_unknown_key",
                format!("unknown hotkey spec: {:?}", spec),
            );
        }
    };

    let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(()) => {
            return Response::err(
                id,
                "cgevent_source_failed",
                "CGEventSource::new(HIDSystemState) returned NULL",
            );
        }
    };
    if let Err(()) = post_key_event(source, &mapping) {
        return Response::err(
            id,
            "cgevent_construct_failed",
            format!("CGEvent::new_keyboard_event failed for {:?}", spec),
        );
    }
    Response::ok(id, serde_json::json!({ "keys": spec, "posted": true }))
}

#[cfg(target_os = "macos")]
pub fn dispatch(id: &str, params: &serde_json::Value) -> Response {
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let actions = match params.get("actions").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => {
            return Response::err(
                id,
                "invalid_params",
                "cgevent_dispatch requires {actions: array}",
            );
        }
    };
    let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(()) => {
            return Response::err(
                id,
                "cgevent_source_failed",
                "CGEventSource::new(HIDSystemState) returned NULL",
            );
        }
    };

    let mut results: Vec<serde_json::Value> = Vec::with_capacity(actions.len());
    for (i, a) in actions.iter().enumerate() {
        let kind = a.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let mapping = if kind == "press" {
            let key_name = a.get("key").and_then(|v| v.as_str());
            match key_name.and_then(parse_key) {
                Some(m) => m,
                None => {
                    results.push(serde_json::json!({
                        "index": i, "ok": false,
                        "error_kind": "cgevent_unknown_key",
                        "error": format!("unknown key: {:?}", key_name),
                    }));
                    continue;
                }
            }
        } else if kind == "hotkey" {
            let spec = a.get("keys").and_then(|v| v.as_str());
            match spec.and_then(parse_hotkey) {
                Some(m) => m,
                None => {
                    results.push(serde_json::json!({
                        "index": i, "ok": false,
                        "error_kind": "cgevent_unknown_key",
                        "error": format!("unknown hotkey: {:?}", spec),
                    }));
                    continue;
                }
            }
        } else {
            results.push(serde_json::json!({
                "index": i, "ok": false,
                "error_kind": "invalid_params",
                "error": format!("action kind must be 'press' or 'hotkey', got {:?}", kind),
            }));
            continue;
        };

        // 注意：CGEventSource 是 ForeignType（refcount），每次 new_keyboard_event
        // 接 by value（move）。生产路径每次都新 source（cheap alloc）。
        let source_for_event = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
            Ok(s) => s,
            Err(()) => {
                results.push(serde_json::json!({
                    "index": i, "ok": false,
                    "error_kind": "cgevent_source_failed",
                    "error": "CGEventSource for action",
                }));
                continue;
            }
        };
        match post_key_event(source_for_event, &mapping) {
            Ok(()) => results.push(serde_json::json!({
                "index": i, "ok": true,
                "kind": kind,
            })),
            Err(()) => results.push(serde_json::json!({
                "index": i, "ok": false,
                "error_kind": "cgevent_construct_failed",
                "error": "CGEvent::new_keyboard_event returned NULL",
            })),
        }
    }
    // 引 source 防 unused warning（已用作 initial availability probe）
    let _ = source;
    Response::ok(id, serde_json::json!({ "results": results }))
}

// ============================================================================
// 共用：post 一个 keydown + keyup pair（hotkey 也走此路径，只是带 flags）
// ============================================================================

#[cfg(target_os = "macos")]
fn post_key_event(
    source: core_graphics::event_source::CGEventSource,
    mapping: &KeyMapping,
) -> Result<(), ()> {
    use core_graphics::event::{CGEvent, CGEventTapLocation};
    use core_graphics::event::CGEventFlags;

    let flags = modifiers_to_flags(mapping.modifiers);

    // keydown
    let down = CGEvent::new_keyboard_event(source, mapping.keycode, true)?;
    if flags != CGEventFlags::empty() {
        down.set_flags(flags);
    }
    down.post(CGEventTapLocation::HID);

    // keyup（需新 source：new_keyboard_event move source）
    let source_up = core_graphics::event_source::CGEventSource::new(
        core_graphics::event_source::CGEventSourceStateID::HIDSystemState,
    )
    .map_err(|_| ())?;
    let up = CGEvent::new_keyboard_event(source_up, mapping.keycode, false)?;
    if flags != CGEventFlags::empty() {
        up.set_flags(flags);
    }
    up.post(CGEventTapLocation::HID);

    Ok(())
}

#[cfg(target_os = "macos")]
fn modifiers_to_flags(mods: crate::cgevent_keymap::ModifierSet) -> core_graphics::event::CGEventFlags {
    use crate::cgevent_keymap::{MOD_CMD, MOD_CTRL, MOD_FN, MOD_OPT, MOD_SHIFT};
    use core_graphics::event::CGEventFlags;
    let mut f = CGEventFlags::empty();
    if mods.contains(MOD_CMD) {
        f.insert(CGEventFlags::CGEventFlagCommand);
    }
    if mods.contains(MOD_SHIFT) {
        f.insert(CGEventFlags::CGEventFlagShift);
    }
    if mods.contains(MOD_OPT) {
        f.insert(CGEventFlags::CGEventFlagAlternate);
    }
    if mods.contains(MOD_CTRL) {
        f.insert(CGEventFlags::CGEventFlagControl);
    }
    if mods.contains(MOD_FN) {
        f.insert(CGEventFlags::CGEventFlagSecondaryFn);
    }
    f
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn non_macos_returns_not_macos() {
        let r = key("t", &serde_json::json!({"key": "Return"}));
        assert!(!r.ok);
        assert_eq!(r.error_kind.as_deref(), Some("not_macos"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn key_returns_invalid_params_when_key_missing() {
        let r = key("t", &serde_json::json!({}));
        assert!(!r.ok);
        assert_eq!(r.error_kind.as_deref(), Some("invalid_params"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn key_returns_cgevent_unknown_key_for_garbage() {
        let r = key("t", &serde_json::json!({"key": "foobar"}));
        assert!(!r.ok);
        assert_eq!(r.error_kind.as_deref(), Some("cgevent_unknown_key"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn key_rejects_numeric_keycode_inv28() {
        // INV-28：数字 keycode 入参必须被拒绝（强制走 keymap）
        let r = key("t", &serde_json::json!({"key": 36}));
        assert!(!r.ok);
        assert_eq!(
            r.error_kind.as_deref(),
            Some("invalid_params"),
            "numeric keycode rejected at schema layer (INV-28)"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hotkey_returns_invalid_params_when_keys_missing() {
        let r = hotkey("t", &serde_json::json!({}));
        assert!(!r.ok);
        assert_eq!(r.error_kind.as_deref(), Some("invalid_params"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hotkey_returns_cgevent_unknown_key_for_garbage() {
        let r = hotkey("t", &serde_json::json!({"keys": "cmd+nothing"}));
        assert!(!r.ok);
        assert_eq!(r.error_kind.as_deref(), Some("cgevent_unknown_key"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dispatch_invalid_when_actions_not_array() {
        let r = dispatch("t", &serde_json::json!({"actions": "not-array"}));
        assert!(!r.ok);
        assert_eq!(r.error_kind.as_deref(), Some("invalid_params"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dispatch_invalid_when_action_kind_unknown() {
        let r = dispatch(
            "t",
            &serde_json::json!({
                "actions": [{"kind": "type", "text": "hi"}]
            }),
        );
        assert!(r.ok); // dispatch 本身不因单项失败而 fail
        let result = r.result.unwrap();
        let results = result["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["ok"], false);
        assert_eq!(results[0]["error_kind"], "invalid_params");
    }
}
