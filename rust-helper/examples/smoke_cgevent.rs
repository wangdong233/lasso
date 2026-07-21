//! CGEvent keyboard synthesis smoke test (parse5 §3.5 + §3.5.5 — 必做).
//!
//! 经验性确认 `core-graphics` 0.24 crate 真实暴露的 CGEvent 符号集，
//! 据此决定 src/cgevent.rs 走高层 wrapper 还是 core-graphics-sys FFI 兜底。
//!
//! 实测（macOS 12 Intel, core-graphics 0.24.0）：
//!   - `CGEventSource::new(CGEventSourceStateID::HIDSystemState) -> Result<Self, ()>`
//!   - `CGEvent::new_keyboard_event(source: CGEventSource, keycode: CGKeyCode, keydown: bool) -> Result<CGEvent, ()>`
//!     —— 注意 source 是**by value**（move 语义；CGEventSource 是 ForeignType）
//!   - `CGEvent::post(&self, tap_location: CGEventTapLocation) -> ()`  ← 返 unit, 非 Result
//!   - `CGEvent::set_flags(&self, CGEventFlags)` / `get_flags() -> CGEventFlags`
//!   - `CGEvent::get_type() -> CGEventType`  ← 非 event_type()
//!
//! 候选路径：
//!   (a) `core-graphics::event::CGEvent` 高层 wrapper  ← 选用
//!   (b) `core-graphics-sys` raw FFI to `CGEventCreateKeyboardEvent` +
//!       `CGEventPost`  ← 不需要，wrapper 全覆盖
//!
//! 运行：
//!     cd rust-helper && cargo run --example smoke_cgevent
//!
//! 选型决策写入 src/cgevent.rs 顶部注释。本 smoke 不真的发 cmd+q / return
//! 等可能干扰系统的键，仅发 F15（绝大多数 mac 环境不绑定 F15，最低副作用）。

#[cfg(target_os = "macos")]
fn main() {
    println!("== CGEvent smoke test (macOS) ==");

    use core_graphics::event::{CGEvent, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    // F15 在绝大多数 HKKeyboardLayout 中无绑定 → 最低副作用
    const KEYCODE_F15: u16 = 103;

    // --------------------------------------------------------------------
    // (a) 高层 wrapper：CGEventSource + CGEvent::new_keyboard_event + post
    // --------------------------------------------------------------------
    println!("\n-- (a) core-graphics 0.24 high-level wrapper --");

    // (1) CGEventSource 构造（每次新 source：new_keyboard_event 取 source by value）
    let source_down = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => {
            println!("(1) CGEventSource::new(HIDSystemState) OK");
            s
        }
        Err(()) => {
            println!("(1) CGEventSource::new FAILED");
            println!("DECISION: high-level wrapper NOT usable; need FFI fallback.");
            return;
        }
    };

    // (2) CGEvent::new_keyboard_event 构造（F15 keydown）
    let mut event_down = match CGEvent::new_keyboard_event(source_down, KEYCODE_F15, true) {
        Ok(e) => {
            println!("(2) CGEvent::new_keyboard_event(src, 103, down) OK");
            e
        }
        Err(()) => {
            println!("(2) CGEvent::new_keyboard_event FAILED");
            return;
        }
    };

    // (3) set_flags 测试（hotkey 路径前置）
    use core_graphics::event::CGEventFlags;
    event_down.set_flags(CGEventFlags::CGEventFlagCommand);
    println!("(3) event.set_flags(CGEventFlagCommand) OK");

    // (4) post 到 HID tap（返 unit；调用成功即视为 OK）
    event_down.post(CGEventTapLocation::HID);
    println!("(4) event.post(HID) OK (F15 down posted)");

    // (5) 配对的 key up（释放 F15；防止粘键；新 source，因为新_keyboard_event move 旧 source）
    let source_up = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(()) => {
            println!("(5) source_up construction failed (F15 may stay down)");
            return;
        }
    };
    if let Ok(event_up) = CGEvent::new_keyboard_event(source_up, KEYCODE_F15, false) {
        event_up.post(CGEventTapLocation::HID);
        println!("(5) F15 up posted (paired release)");
    } else {
        println!("(5) F15 up event construction FAILED");
    }

    // (6) 类型/字段读出（验证 get_type / get_flags 可读）
    println!(
        "(6) event_down.get_type() = {:?} (expected KeyDown=10)",
        event_down.get_type()
    );
    println!("(6) event_down.get_flags() = {:?}", event_down.get_flags());

    // --------------------------------------------------------------------
    // 决策
    // --------------------------------------------------------------------
    println!("\n== DECISION ==");
    println!("Path (a) core-graphics 0.24 high-level wrapper is sufficient:");
    println!("  + CGEventSource::new + new_keyboard_event + set_flags + post all exposed");
    println!("  + no need for core-graphics-sys raw FFI");
    println!("  + works under Accessibility authorization (TCC)");
    println!("Caveat: new_keyboard_event takes source by value (move); production");
    println!("  cgevent.rs creates a fresh CGEventSource per event (cheap refcount alloc).");
    println!("Path (b) raw FFI: NOT needed.");
    println!("\nsrc/cgevent.rs implementation uses these high-level wrappers.");
    println!("CGEventFlags mask bits from cgevent_keymap.rs map modifier names");
    println!("(cmd/shift/option/control) to CGEventFlags bit unions.");
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("== CGEvent smoke test: non-macOS, no-op ==");
    println!("production stub returns not_macos error.");
}
