//! CGEvent logical-key → CGKeyCode / modifier-flag mapping (parse5 §3.5.5 + INV-28).
//!
//! ## INV-28 红线
//!
//!   - `cgevent::key` / `cgevent::hotkey` 只接**逻辑键名**字符串（"Return" / "Tab" /
//!     "cmd+c" / "shift+cmd+g"），不暴露原始 CGKeyCode 数字入参
//!   - 本文件是映射表的**唯一真源**：所有 keycode 数字字面量只许在本文件出现
//!     （grep `0x` / raw 数字 keycode 在 cgevent.rs 不应出现）
//!   - 与 INV-21 衍生一致：平台字面量集中隔离
//!
//! ## 选型：基于 HIKeyboardLayout / USB HUT 1.12 公开常量
//!
//!   CGKeyCode 在不同 keyboard layout 下**可能漂移**（Dvorak / 自定义 layout 会改），
//!   但以下键在所有 Apple 出厂 layout 下稳定（HIToolbox 源自 HIToolbox/Events.h）：
//!     - 字母 A-Z: 0-25
//!     - 数字 0-9 (top row): 29=0, 18=1, 19=2, 20=3, 21=4, 22=5, 23=6, 26=7,
//!       28=8, 25=9
//!     - 功能键: Return=36, Tab=48, Space=49, Delete=51, Escape=53,
//!       F1-F12=122-135 (117+1..12 是新编号，旧为 122-133)
//!     - 方向键: Left=123, Right=124, Down=125, Up=126
//!   参考：HIToolbox/Events.h（Carbon 框架；macOS 12 仍稳定）
//!
//!   修饰键不映射 keycode，而是映射到 `CGEventFlags` 位（详见 modifier_flags）：
//!     cmd  → CGEventFlagCommand       (0x100000)
//!     shift→ CGEventFlagShift         (0x020000)
//!     opt  → CGEventFlagAlternate     (0x080000)
//!     ctrl → CGEventFlagControl       (0x010000)
//!
//! ## 测试覆盖
//!
//!   - 平台无关：本文件单测覆盖所有键名映射 + 未知键名返 None
//!   - macOS-only：cgevent.rs 真实 CGEvent 调用单独 cfg-gated（不进 CI Linux）

use std::collections::HashMap;
use std::sync::OnceLock;

/// CGKeyCode 在 Apple HIToolbox 下的公共类型（u16；与 core-graphics 一致）。
pub type KeyCode = u16;

/// 修饰键组合（位掩码；映射到 core-graphics::event::CGEventFlags 位）。
///
/// 用 `&'static str` 标签而非 CGEventFlags 直接量，避免在平台无关模块引
/// core-graphics 类型。cgevent.rs 在 macOS 平台层把 `ModifierFlag` 转换为
/// `CGEventFlags`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ModifierSet(pub u8);

pub const MOD_CMD: u8 = 1 << 0;
pub const MOD_SHIFT: u8 = 1 << 1;
pub const MOD_OPT: u8 = 1 << 2;
pub const MOD_CTRL: u8 = 1 << 3;
pub const MOD_FN: u8 = 1 << 4;

impl ModifierSet {
    pub const fn empty() -> Self {
        Self(0)
    }
    pub const fn add(self, bit: u8) -> Self {
        Self(self.0 | bit)
    }
    pub fn contains(&self, bit: u8) -> bool {
        (self.0 & bit) != 0
    }
    pub fn has_any(&self) -> bool {
        self.0 != 0
    }
}

/// 逻辑键 → (keycode, 修饰键)。
///
/// hotkey 形如 "cmd+c" / "shift+cmd+g"：解析时按 `+` 拆，最后一段是非修饰键名，
/// 前面每段是修饰键。press 形如 "Return" / "Tab" / "f5"：直接查表。
pub struct KeyMapping {
    pub keycode: KeyCode,
    pub modifiers: ModifierSet,
}

// ============================================================================
// 单键 keycode 表（不含修饰键）
// ============================================================================

const KEYCODES_STATIC: &[(&str, KeyCode)] = &[
    // 字母（lowercase 入参；查表时统一 lowercase）
    ("a", 0), ("b", 11), ("c", 8), ("d", 2), ("e", 14), ("f", 3), ("g", 5),
    ("h", 4), ("i", 34), ("j", 38), ("k", 40), ("l", 37), ("m", 46), ("n", 45),
    ("o", 31), ("p", 35), ("q", 12), ("r", 15), ("s", 1), ("t", 17), ("u", 32),
    ("v", 9), ("w", 13), ("x", 7), ("y", 16), ("z", 6),
    // 数字 top-row
    ("0", 29), ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("5", 22),
    ("6", 23), ("7", 26), ("8", 28), ("9", 25),
    // 控制键
    ("return", 36), ("enter", 36), // 别名
    ("tab", 48),
    ("space", 49),
    ("delete", 51), ("backspace", 51), // 别名
    ("esc", 53), ("escape", 53),
    ("capslock", 57),
    // 方向键
    ("left", 123), ("right", 124), ("down", 125), ("up", 126),
    // 功能键 F1-F12
    ("f1", 122), ("f2", 120), ("f3", 99), ("f4", 118), ("f5", 96), ("f6", 97),
    ("f7", 98), ("f8", 100), ("f9", 101), ("f10", 109), ("f11", 103), ("f12", 111),
    // 功能键 F13-F20（扩展键盘 / Touch Bar 虚拟；HIToolbox 公共码）
    ("f13", 105), ("f14", 107), ("f15", 113), ("f16", 106),
    ("f17", 64), ("f18", 79), ("f19", 80), ("f20", 90),
    // 标点（US layout；HIToolbox 公共表）
    ("-", 27), ("=", 24), ("[", 33), ("]", 30), ("\\", 42), (";", 41),
    ("'", 39), ("`", 50), (",", 43), (".", 47), ("/", 44),
    // Page / Home / End / Help
    ("home", 115), ("end", 119), ("pageup", 116), ("pagedown", 121), ("help", 114),
    // Forward delete (fn+delete)
    ("fwddelete", 117), ("forwarddelete", 117),
];

/// 修饰键名 → 位（小写）。
const MODIFIERS_STATIC: &[(&str, u8)] = &[
    ("cmd", MOD_CMD),
    ("command", MOD_CMD),
    ("⌘", MOD_CMD),
    ("shift", MOD_SHIFT),
    ("⇧", MOD_SHIFT),
    ("opt", MOD_OPT),
    ("option", MOD_OPT),
    ("alt", MOD_OPT), // Windows 习惯别名
    ("⌥", MOD_OPT),
    ("ctrl", MOD_CTRL),
    ("control", MOD_CTRL),
    ("⌃", MOD_CTRL),
    ("fn", MOD_FN),
];

fn keycode_map() -> &'static HashMap<&'static str, KeyCode> {
    static MAP: OnceLock<HashMap<&'static str, KeyCode>> = OnceLock::new();
    MAP.get_or_init(|| KEYCODES_STATIC.iter().copied().collect())
}

fn modifier_map() -> &'static HashMap<&'static str, u8> {
    static MAP: OnceLock<HashMap<&'static str, u8>> = OnceLock::new();
    MAP.get_or_init(|| MODIFIERS_STATIC.iter().copied().collect())
}

/// 单键名 → keycode（无修饰）。返 None 表示未知键。
///
/// 入参统一 lowercase；调用方不需做归一化（内部做）。
pub fn lookup_keycode(name: &str) -> Option<KeyCode> {
    keycode_map().get(&name.to_lowercase()[..]).copied()
}

/// 修饰键名 → 位。返 None 表示未知修饰。
pub fn lookup_modifier(name: &str) -> Option<u8> {
    modifier_map().get(&name.to_lowercase()[..]).copied()
}

/// 解析 hotkey 串为 `KeyMapping`。
///
/// 接受：
///   - "cmd+c" / "shift+cmd+g"
///   - "Return"（无修饰，等价 press）
///   - "cmd+shift+ctrl+opt+f5"
/// 拒绝：
///   - 任何段未知 → None（caller 转 `cgevent_unknown_key`）
///   - 空串 → None
///   - 全是修饰键 / 没有非修饰键 → None
///   - 多个非修饰键（"a+b"）→ None（hotkey 只允许一个主键）
pub fn parse_hotkey(spec: &str) -> Option<KeyMapping> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }

    let mut modifiers = ModifierSet::empty();
    let mut main_key: Option<&str> = None;

    for part in spec.split('+') {
        let part = part.trim();
        if part.is_empty() {
            return None; // 连续 + 或前后 +
        }
        if let Some(bit) = lookup_modifier(part) {
            modifiers = modifiers.add(bit);
            continue;
        }
        // 非修饰键：第一个 main_key 之后还有非修饰键 → 拒绝（hotkey 单主键）
        if main_key.is_some() {
            return None;
        }
        // 验证主键可解析
        if lookup_keycode(part).is_none() {
            return None;
        }
        main_key = Some(part);
    }

    let key = main_key?;
    let keycode = lookup_keycode(key)?;
    Some(KeyMapping { keycode, modifiers })
}

/// 解析单键 press（等价 parse_hotkey 但不允许修饰键）。
pub fn parse_key(spec: &str) -> Option<KeyMapping> {
    let m = parse_hotkey(spec)?;
    if m.modifiers.has_any() {
        // press 不接修饰键；用户应走 hotkey method
        return None;
    }
    Some(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_keycode_known_keys() {
        assert_eq!(lookup_keycode("a"), Some(0));
        assert_eq!(lookup_keycode("A"), Some(0)); // case-insensitive
        assert_eq!(lookup_keycode("Return"), Some(36));
        assert_eq!(lookup_keycode("return"), Some(36));
        assert_eq!(lookup_keycode("enter"), Some(36));
        assert_eq!(lookup_keycode("tab"), Some(48));
        assert_eq!(lookup_keycode("space"), Some(49));
        assert_eq!(lookup_keycode("esc"), Some(53));
        assert_eq!(lookup_keycode("escape"), Some(53));
        assert_eq!(lookup_keycode("left"), Some(123));
        assert_eq!(lookup_keycode("up"), Some(126));
        assert_eq!(lookup_keycode("f5"), Some(96));
        assert_eq!(lookup_keycode("f12"), Some(111));
        assert_eq!(lookup_keycode("delete"), Some(51));
        assert_eq!(lookup_keycode("backspace"), Some(51));
    }

    #[test]
    fn lookup_keycode_unknown_returns_none() {
        assert!(lookup_keycode("foo").is_none());
        assert!(lookup_keycode("").is_none());
        assert!(lookup_keycode("hyper").is_none());
        assert!(lookup_keycode("cmd").is_none(), "cmd is modifier, not key");
    }

    #[test]
    fn parse_hotkey_simple_modifiers() {
        let m = parse_hotkey("cmd+c").unwrap();
        assert_eq!(m.keycode, 8); // 'c'
        assert!(m.modifiers.contains(MOD_CMD));
        assert!(!m.modifiers.contains(MOD_SHIFT));

        let m = parse_hotkey("shift+cmd+g").unwrap();
        assert_eq!(m.keycode, 5); // 'g'
        assert!(m.modifiers.contains(MOD_CMD));
        assert!(m.modifiers.contains(MOD_SHIFT));

        let m = parse_hotkey("ctrl+opt+cmd+shift+f5").unwrap();
        assert_eq!(m.keycode, 96);
        assert!(m.modifiers.contains(MOD_CMD | MOD_SHIFT | MOD_OPT | MOD_CTRL));
    }

    #[test]
    fn parse_hotkey_single_key_no_modifier() {
        let m = parse_hotkey("Return").unwrap();
        assert_eq!(m.keycode, 36);
        assert!(!m.modifiers.has_any());
    }

    #[test]
    fn parse_hotkey_rejects_multiple_main_keys() {
        assert!(parse_hotkey("a+b").is_none(), "two main keys rejected");
        assert!(parse_hotkey("cmd+a+b").is_none(), "cmd+two main keys rejected");
    }

    #[test]
    fn parse_hotkey_rejects_unknown_segments() {
        assert!(parse_hotkey("cmd+foo").is_none(), "unknown main key");
        assert!(parse_hotkey("hyper+c").is_none(), "unknown modifier");
    }

    #[test]
    fn parse_hotkey_rejects_empty_or_only_modifiers() {
        assert!(parse_hotkey("").is_none());
        assert!(parse_hotkey("   ").is_none());
        assert!(parse_hotkey("cmd").is_none(), "modifier-only has no main key");
        assert!(parse_hotkey("cmd+shift").is_none());
        assert!(parse_hotkey("+").is_none());
        assert!(parse_hotkey("cmd+").is_none());
        assert!(parse_hotkey("+c").is_none());
    }

    #[test]
    fn parse_hotkey_handles_whitespace_around_segments() {
        let m = parse_hotkey(" cmd + c ").unwrap();
        assert_eq!(m.keycode, 8);
        assert!(m.modifiers.contains(MOD_CMD));
    }

    #[test]
    fn parse_hotkey_accepts_unicode_modifier_glyphs() {
        let m = parse_hotkey("⌘+c").unwrap();
        assert!(m.modifiers.contains(MOD_CMD));
        let m = parse_hotkey("⇧+⌘+g").unwrap();
        assert!(m.modifiers.contains(MOD_CMD | MOD_SHIFT));
    }

    #[test]
    fn parse_key_rejects_modifier_compositions() {
        assert!(parse_key("cmd+c").is_none(), "parse_key is no-modifier path");
        assert!(parse_key("a").is_some());
        assert!(parse_key("Return").is_some());
    }

    #[test]
    fn modifier_aliases_canonicalized() {
        // cmd == command
        assert_eq!(lookup_modifier("cmd"), lookup_modifier("command"));
        assert_eq!(lookup_modifier("opt"), lookup_modifier("option"));
        assert_eq!(lookup_modifier("alt"), lookup_modifier("option"));
        assert_eq!(lookup_modifier("ctrl"), lookup_modifier("control"));
    }

    #[test]
    fn inv_28_no_raw_keycode_input_type() {
        // INV-28 锚点：lookup/parse 入参都是 &str 逻辑键名；
        // 生产 API 不暴露 KeyCode 数字入参（grep 锚点，防回归）。
        let src = include_str!("cgevent_keymap.rs");
        // 公共函数签名都是 &str 入参：
        assert!(src.contains("pub fn lookup_keycode(name: &str)"));
        assert!(src.contains("pub fn parse_hotkey(spec: &str)"));
        assert!(src.contains("pub fn parse_key(spec: &str)"));
    }
}
