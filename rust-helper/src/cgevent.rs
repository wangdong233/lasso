//! CGEvent keyboard synthesis (parse5 §3.5.3 + §3.5.5 + INV-28)
//! + mouse synthesis (v1.11 round1 T7：click/drag/scroll/move 四路径)。
//!
//! ## 路径选型（smoke 验证后决策）
//!
//!   见 `examples/smoke_cgevent.rs`：core-graphics 0.24 高层 wrapper 完全够用：
//!   - `CGEventSource::new(CGEventSourceStateID::HIDSystemState) -> Result<Self, ()>`
//!   - `CGEvent::new_keyboard_event(source: CGEventSource, keycode, keydown) -> Result<CGEvent, ()>`
//!     （source by value；move；生产每次事件新 source）
//!   - `CGEvent::new_mouse_event(source, CGEventType, CGPoint, CGMouseButton) -> Result<CGEvent, ()>`
//!     （v1.11 T7 鼠标路径；agent-desktop input/mouse.rs 同链）
//!   - `CGEvent::new_scroll_event(source, units, wheel_count, wheel1, wheel2, wheel3)`
//!     （highsierra feature 解锁；Cargo.toml v1.11 起显式开）
//!   - `CGEvent::post(&self, tap: CGEventTapLocation) -> ()`  （返 unit）
//!   - `CGEvent::set_flags(&self, CGEventFlags)` / `get_flags()` / `get_type()`
//!   - **不需要** core-graphics-sys raw FFI
//!
//! ## INV-28 红线
//!
//!   - `key` / `hotkey` 入参只接 &str 逻辑键名（"Return" / "cmd+c"）
//!   - 鼠标 `button` 入参只接 &str 逻辑按钮名（"left" / "right"；默认 "left"）——
//!     禁 raw button code 数字（raw keycode/button 字面量只在 keymap/枚举转换处）
//!   - 不接受 number 类型 keycode（params schema 在 protocol 层松，但本函数
//!     强制 as_str() + keymap 查表；数字入参走 cgevent_unknown_key 拒绝）
//!   - 所有原始 keycode 字面量只许在 cgevent_keymap.rs 出现
//!
//! ## v1.11 T7 鼠标语义（对标 agent-desktop mouse.rs + nut.js 物理层刚需）
//!
//!   - `click`  {kind:"click", x, y, button?}    LeftMouseDown+Up @（x,y）
//!   - `move`   {kind:"move", x, y}              MouseMoved @（x,y）（悬停语义）
//!   - `drag`   {kind:"drag", from_x, from_y, to_x, to_y}
//!              LeftMouseDown @from → LeftMouseDragged @to → LeftMouseUp @to
//!   - `scroll` {kind:"scroll", dx, dy, x?, y?}  先移到（x,y）再 post 滚轮；
//!              dy>0 = 内容向下滚（wheel1 = -dy，标准滚轮方向约定）
//!   - 坐标来源：TS 端 snapshot rect 中心换算（round1 T7 裁决；cgEvent 档不吃 ref）
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
//!     params: { "actions": [{kind:"press",key:"Return"},{kind:"hotkey",keys:"cmd+c"},
//!                          {kind:"click",x:100,y:200},...] }
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
    // v1.11（round1 T11）：macOS 15+ Event Synthesizing TCC 预检。
    // denied（System Settings → Privacy & Security → Event Synthesizing 未授权）
    // → 合成键盘/指针事件被 WindowServer 静默拦截——诚实报因而非假 posted。
    // < macOS 15 状态是 not_required（不预检，行为与 v1.10 零差异）。
    if crate::tcc::event_synthesizing_status() == "denied" {
        return Response::err(
            id,
            "tcc_event_synthesis_denied",
            "macOS 15+ Event Synthesizing permission denied; grant it in System Settings → Privacy & Security → Event Synthesizing (or Accessibility)",
        );
    }
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

        // ============================================================
        // v1.11（round1 T7）鼠标四路径：click / move / drag / scroll
        // ============================================================
        if matches!(kind, "click" | "move" | "drag" | "scroll") {
            match exec_mouse_action(a) {
                Ok(()) => results.push(serde_json::json!({
                    "index": i, "ok": true, "kind": kind,
                })),
                Err((error_kind, msg)) => results.push(serde_json::json!({
                    "index": i, "ok": false,
                    "error_kind": error_kind,
                    "error": msg,
                })),
            }
            continue;
        }

        // ============================================================
        // 键盘路径（press / hotkey，v0.4 既有）
        // ============================================================
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
                "error": format!(
                    "action kind must be 'press'/'hotkey'/'click'/'move'/'drag'/'scroll', got {:?}",
                    kind
                ),
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
// v1.11 round1 T7：鼠标路径（click / move / drag / scroll）
// ============================================================================

/// 逻辑按钮名 → CGMouseButton（INV-28 风格：禁 raw button code 数字入参）。
#[cfg(target_os = "macos")]
fn parse_mouse_button(name: Option<&str>) -> Result<core_graphics::event::CGMouseButton, String> {
    use core_graphics::event::CGMouseButton;
    match name.unwrap_or("left") {
        "left" => Ok(CGMouseButton::Left),
        "right" => Ok(CGMouseButton::Right),
        "center" => Ok(CGMouseButton::Center),
        other => Err(format!(
            "unknown logical button {:?} (allowed: left/right/center; raw button codes forbidden INV-28)",
            other
        )),
    }
}

/// JSON 数字对 → CGPoint（缺字段/非法 → Err）。
#[cfg(target_os = "macos")]
fn parse_point(obj: &serde_json::Value, xk: &str, yk: &str) -> Result<core_graphics_types::geometry::CGPoint, String> {
    let x = obj.get(xk).and_then(|v| v.as_f64()).ok_or(format!("missing/invalid {xk}"))?;
    let y = obj.get(yk).and_then(|v| v.as_f64()).ok_or(format!("missing/invalid {yk}"))?;
    Ok(core_graphics_types::geometry::CGPoint { x, y })
}

// ============================================================
// v1.12 round2 T2-8：鼠标事件物理质量（drag 插值 + clickState）
// ============================================================

/// kCGMouseEventClickState（CGEventField 1；core-graphics 0.24 无命名常量，本地钉死）。
/// agent-desktop input/mouse.rs 同款：down/up 事件都设 clickState=1。
const KCG_MOUSE_EVENT_CLICK_STATE: core_graphics::event::CGEventField = 1;

/// drag 插值参数（agent-desktop 实测参数照抄，不做参数化）：
/// 按住 200ms + 步进 16ms + 沉淀 100ms。
const DRAG_HOLD_MS: u64 = 200;
const DRAG_STEP_MS: u64 = 16;
const DRAG_SETTLE_MS: u64 = 100;

/// drag 插值点数：max(4, HOLD/STEP)（agent-desktop 公式；200/16=12）。
/// 纯函数（单测锚点）；真实节奏由 exec_mouse_action 施加。
fn drag_interpolation_step_count() -> usize {
    std::cmp::max(4, (DRAG_HOLD_MS / DRAG_STEP_MS) as usize)
}

/// from→to 线性插值路径点（含终点、不含起点；每点一个 LeftMouseDragged 事件）。
/// 纯函数（单测锚点）——序列形状可断言，物理 post 归真机手测。
fn drag_interpolation_points(
    from: core_graphics_types::geometry::CGPoint,
    to: core_graphics_types::geometry::CGPoint,
) -> Vec<core_graphics_types::geometry::CGPoint> {
    let n = drag_interpolation_step_count();
    (1..=n)
        .map(|i| {
            let t = i as f64 / n as f64;
            core_graphics_types::geometry::CGPoint {
                x: from.x + (to.x - from.x) * t,
                y: from.y + (to.y - from.y) * t,
            }
        })
        .collect()
}


/// 执行一个鼠标 action（click/move/drag/scroll）。返回 Err 时带 error_kind 语义前缀
/// （invalid_params / cgevent_construct_failed）。
#[cfg(target_os = "macos")]
fn exec_mouse_action(a: &serde_json::Value) -> Result<(), (String, String)> {
    use core_graphics::event::{CGEvent, CGEventTapLocation, CGEventType};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let kind = a.get("kind").and_then(|v| v.as_str()).unwrap_or("");

    let new_source = || -> Result<CGEventSource, (String, String)> {
        CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| {
            ("cgevent_source_failed".to_string(), "CGEventSource::new".to_string())
        })
    };

    match kind {
        "click" => {
            let pos = parse_point(a, "x", "y")
                .map_err(|e| ("invalid_params".to_string(), format!("click: {e}")))?;
            // INV-28：button 必须是 string（缺省 "left"）；数字 raw button code 拒绝
            let raw_button = a.get("button");
            if raw_button.is_some() && !raw_button.and_then(|v| v.as_str()).is_some() {
                return Err((
                    "invalid_params".to_string(),
                    "button must be a logical name string (left/right/center); raw button codes forbidden (INV-28)".to_string(),
                ));
            }
            let button = parse_mouse_button(raw_button.and_then(|v| v.as_str()))
                .map_err(|e| ("invalid_params".to_string(), e))?;
            // down/up 事件对（button 决定 Left/Right 事件型）
            let (down_ty, up_ty) = match button {
                core_graphics::event::CGMouseButton::Right => {
                    (CGEventType::RightMouseDown, CGEventType::RightMouseUp)
                }
                _ => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp),
            };
            let s = new_source()?;
            let down = CGEvent::new_mouse_event(s, down_ty, pos, button)
                .map_err(|_| ("cgevent_construct_failed".to_string(), "mouse down".to_string()))?;
            // v1.12（round2 T2-8）：clickState=1（agent-desktop input/mouse.rs 同款——
            // field 1 = kCGMouseEventClickState；挑剔 app 靠它区分单击/拖拽起手）
            down.set_integer_value_field(KCG_MOUSE_EVENT_CLICK_STATE, 1);
            down.post(CGEventTapLocation::HID);
            // v1.12（round2 T2-8）：10ms down→up 间隔（零间隔双事件被部分 app 判定
            // 为异常/忽略；数值照抄 agent-desktop 实测参数，不做参数化）
            std::thread::sleep(std::time::Duration::from_millis(10));
            let s2 = new_source()?;
            let up = CGEvent::new_mouse_event(s2, up_ty, pos, button)
                .map_err(|_| ("cgevent_construct_failed".to_string(), "mouse up".to_string()))?;
            up.set_integer_value_field(KCG_MOUSE_EVENT_CLICK_STATE, 1);
            up.post(CGEventTapLocation::HID);
            Ok(())
        }
        "move" => {
            let pos = parse_point(a, "x", "y")
                .map_err(|e| ("invalid_params".to_string(), format!("move: {e}")))?;
            let s = new_source()?;
            let ev = CGEvent::new_mouse_event(s, CGEventType::MouseMoved, pos, core_graphics::event::CGMouseButton::Left)
                .map_err(|_| ("cgevent_construct_failed".to_string(), "mouse move".to_string()))?;
            ev.post(CGEventTapLocation::HID);
            Ok(())
        }
        "drag" => {
            let from = parse_point(a, "from_x", "from_y")
                .map_err(|e| ("invalid_params".to_string(), format!("drag: {e}")))?;
            let to = parse_point(a, "to_x", "to_y")
                .map_err(|e| ("invalid_params".to_string(), format!("drag: {e}")))?;
            let s = new_source()?;
            let down = CGEvent::new_mouse_event(s, CGEventType::LeftMouseDown, from, core_graphics::event::CGMouseButton::Left)
                .map_err(|_| ("cgevent_construct_failed".to_string(), "drag down".to_string()))?;
            down.post(CGEventTapLocation::HID);
            // ============================================================
            // v1.12（round2 T2-8）：drag 物理质量——200ms 按住 + 逐点插值 + 100ms 沉淀。
            // 旧实现单个 LeftMouseDragged 后立即 up：滑条/拖拽排序/文件拖放类目标
            // 只认移动轨迹，单事件 = 大概率失败。数值照抄 agent-desktop 实测参数：
            //   - 200ms 按住（让目标注册 press）
            //   - 插值点数 = max(4, 200ms/16ms) = 12 点，每点 16ms 步进
            //   - 100ms 沉淀后 up（让目标提交 drop）
            // ============================================================
            std::thread::sleep(std::time::Duration::from_millis(200));
            for pt in drag_interpolation_points(from, to) {
                let si = new_source()?;
                let dragged = CGEvent::new_mouse_event(
                    si,
                    CGEventType::LeftMouseDragged,
                    pt,
                    core_graphics::event::CGMouseButton::Left,
                )
                .map_err(|_| ("cgevent_construct_failed".to_string(), "drag moved".to_string()))?;
                dragged.post(CGEventTapLocation::HID);
                std::thread::sleep(std::time::Duration::from_millis(DRAG_STEP_MS));
            }
            std::thread::sleep(std::time::Duration::from_millis(DRAG_SETTLE_MS));
            let s3 = new_source()?;
            let up = CGEvent::new_mouse_event(s3, CGEventType::LeftMouseUp, to, core_graphics::event::CGMouseButton::Left)
                .map_err(|_| ("cgevent_construct_failed".to_string(), "drag up".to_string()))?;
            up.post(CGEventTapLocation::HID);
            Ok(())
        }
        "scroll" => {
            let dx = a.get("dx").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let dy = a.get("dy").and_then(|v| v.as_f64()).unwrap_or(0.0);
            // 先移到 (x,y)（可选——缺省在当前光标位置滚）
            if a.get("x").is_some() || a.get("y").is_some() {
                let pos = parse_point(a, "x", "y")
                    .map_err(|e| ("invalid_params".to_string(), format!("scroll: {e}")))?;
                let s = new_source()?;
                let ev = CGEvent::new_mouse_event(s, CGEventType::MouseMoved, pos, core_graphics::event::CGMouseButton::Left)
                    .map_err(|_| ("cgevent_construct_failed".to_string(), "scroll move".to_string()))?;
                ev.post(CGEventTapLocation::HID);
            }
            // dy>0 = 内容向下滚（wheel1 = -dy；标准滚轮方向：负值 = 向下/向前）
            // dx 走 wheel2（水平轴）。wheel_count=2 支持 vertical+horizontal。
            let wheel1 = -(dy as i32);
            let wheel2 = -(dx as i32);
            let s = new_source()?;
            let ev = CGEvent::new_scroll_event(
                s,
                core_graphics::event::ScrollEventUnit::LINE,
                2,
                wheel1,
                wheel2,
                0,
            )
            .map_err(|_| ("cgevent_construct_failed".to_string(), "scroll wheel".to_string()))?;
            ev.post(CGEventTapLocation::HID);
            Ok(())
        }
        _ => Err((
            "invalid_params".to_string(),
            format!("unknown mouse kind {:?}", kind),
        )),
    }
}

// ============================================================================
// 共用：post 一个 keydown + keyup pair（hotkey 也走此路径，只是带 flags）
// T2-7（round2）：pub(crate) —— ax.rs do_type 档内兜底（AXFocus + 合成键盘）
// 复用本路径，不经 wire 层（同进程直调）。
// ============================================================================

#[cfg(target_os = "macos")]
pub(crate) fn post_key_event(
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

    // ============================================================
    // v1.11 round1 T7：鼠标四路径（click/move/drag/scroll）
    // ============================================================

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_mouse_button_logical_names_inv28() {
        use core_graphics::event::CGMouseButton;
        assert!(matches!(parse_mouse_button(None), Ok(CGMouseButton::Left)));
        assert!(matches!(parse_mouse_button(Some("left")), Ok(CGMouseButton::Left)));
        assert!(matches!(parse_mouse_button(Some("right")), Ok(CGMouseButton::Right)));
        assert!(matches!(parse_mouse_button(Some("center")), Ok(CGMouseButton::Center)));
        // raw button code / 未知名拒绝（INV-28：禁 raw code）
        assert!(parse_mouse_button(Some("0")).is_err());
        assert!(parse_mouse_button(Some("1")).is_err());
        assert!(parse_mouse_button(Some("middle")).is_err());
    }

    // ============================================================
    // v1.12 round2 T2-8：鼠标事件物理质量（drag 插值 + clickState）
    // 纯函数断言；物理 post 节奏归真机手测清单（C1 扩展：拖动滑条/拖拽排序）
    // ============================================================

    #[cfg(target_os = "macos")]
    #[test]
    fn t28_click_state_field_is_one() {
        // agent-desktop input/mouse.rs 同款：kCGMouseEventClickState = field 1
        assert_eq!(KCG_MOUSE_EVENT_CLICK_STATE, 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn t28_drag_timing_params_match_agent_desktop() {
        // 数值照抄 agent-desktop 实测参数（不做参数化）：200ms 按住 + 16ms 步进 + 100ms 沉淀
        assert_eq!(DRAG_HOLD_MS, 200);
        assert_eq!(DRAG_STEP_MS, 16);
        assert_eq!(DRAG_SETTLE_MS, 100);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn t28_drag_interpolation_at_least_four_points() {
        assert!(drag_interpolation_step_count() >= 4);
        // agent-desktop 公式：max(4, HOLD/STEP) = max(4, 12) = 12
        assert_eq!(drag_interpolation_step_count(), 12);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn t28_drag_interpolation_path_shape() {
        use core_graphics_types::geometry::CGPoint;
        let from = CGPoint { x: 0.0, y: 0.0 };
        let to = CGPoint { x: 120.0, y: 60.0 };
        let pts = drag_interpolation_points(from, to);
        // 不含起点（down 事件已在起点）；含终点（up 前最后 dragged 抵达 to）
        assert_eq!(pts.len(), 12);
        let first = pts[0];
        assert!(first.x > 0.0 && first.x < 120.0);
        let last = pts[pts.len() - 1];
        assert!((last.x - 120.0).abs() < 1e-9);
        assert!((last.y - 60.0).abs() < 1e-9);
        // 单调递增（滑条类目标只认单向移动轨迹）
        for w in pts.windows(2) {
            assert!(w[1].x > w[0].x);
            assert!(w[1].y > w[0].y);
        }
        // from == to 的退化 drag：所有点重合（不 NaN 不发散）
        let same = drag_interpolation_points(from, from);
        assert!(same.iter().all(|p| p.x == 0.0 && p.y == 0.0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_point_extracts_coordinates() {
        let p = parse_point(
            &serde_json::json!({"x": 100.5, "y": 200.25}),
            "x",
            "y",
        )
        .unwrap();
        assert_eq!(p.x, 100.5);
        assert_eq!(p.y, 200.25);
        // 缺字段 → Err
        assert!(parse_point(&serde_json::json!({"x": 1.0}), "x", "y").is_err());
        assert!(parse_point(&serde_json::json!({}), "from_x", "from_y").is_err());
        // 非数字 → Err
        assert!(parse_point(&serde_json::json!({"x": "abc", "y": 1.0}), "x", "y").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dispatch_click_missing_coords_is_invalid_params_item() {
        // click 无 x/y → 逐项 invalid_params（形状校验层，CI 可验；真机 post 归手测）
        let r = dispatch(
            "t",
            &serde_json::json!({
                "actions": [{"kind": "click"}]
            }),
        );
        assert!(r.ok);
        let results = r.result.unwrap()["results"].as_array().unwrap().clone();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["ok"], false);
        assert_eq!(results[0]["error_kind"], "invalid_params");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dispatch_click_valid_coords_passes_shape_validation() {
        // 合法坐标 → 通过形状校验。CI 无 GUI 时 CGEvent 构造/HID post 可能失败
        // （ok=false 合法），但**不**应是 invalid_params（真机行为归手测清单 C1）。
        let r = dispatch(
            "t",
            &serde_json::json!({
                "actions": [{"kind": "click", "x": 100.0, "y": 200.0}]
            }),
        );
        assert!(r.ok);
        let results = r.result.unwrap()["results"].as_array().unwrap().clone();
        if results[0]["ok"] == false {
            assert_ne!(results[0]["error_kind"], "invalid_params");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dispatch_click_bad_button_rejected_inv28() {
        let r = dispatch(
            "t",
            &serde_json::json!({
                "actions": [{"kind": "click", "x": 1.0, "y": 2.0, "button": 0}]
            }),
        );
        assert!(r.ok);
        let results = r.result.unwrap()["results"].as_array().unwrap().clone();
        assert_eq!(results[0]["ok"], false);
        assert_eq!(results[0]["error_kind"], "invalid_params");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dispatch_scroll_accepts_missing_position() {
        // scroll 无 x/y 合法（在当前光标位置滚）——只有 dx/dy 缺省 0 也可（空滚）
        let r = dispatch(
            "t",
            &serde_json::json!({
                "actions": [{"kind": "scroll", "dy": -3.0}]
            }),
        );
        assert!(r.ok);
        let results = r.result.unwrap()["results"].as_array().unwrap().clone();
        if results[0]["ok"] == false {
            // CI 无 GUI：source 失败合法；但不是形状错
            assert_ne!(results[0]["error_kind"], "invalid_params");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dispatch_drag_missing_to_coords_is_invalid_params() {
        let r = dispatch(
            "t",
            &serde_json::json!({
                "actions": [{"kind": "drag", "from_x": 1.0, "from_y": 2.0}]
            }),
        );
        assert!(r.ok);
        let results = r.result.unwrap()["results"].as_array().unwrap().clone();
        assert_eq!(results[0]["ok"], false);
        assert_eq!(results[0]["error_kind"], "invalid_params");
    }

    /// INV-28 风格静态检查：cgevent.rs 源码无 raw button code 数字字面量
    /// （0/1/2 直传 button 字段被 parse_mouse_button 的字符串匹配拒绝）。
    /// needle 运行时拼接防自引用（本测试源码本身不含完整字面量）。
    #[test]
    fn cgevent_source_has_no_raw_button_code_literals() {
        let src = include_str!("cgevent.rs");
        // button 字段只经 parse_mouse_button 字符串匹配（"left"/"right"/"center"）
        assert!(src.contains("fn parse_mouse_button"));
        // 禁 button 数字直映射形态（如 button == 0 / button == 1 -> CGMouseButton）
        let needle0 = format!("button {}{}", "=", " 0");
        let needle1 = format!("button {}{}", "=", " 1");
        assert!(!src.contains(&needle0), "raw button code literal found: {needle0}");
        assert!(!src.contains(&needle1), "raw button code literal found: {needle1}");
    }
}
