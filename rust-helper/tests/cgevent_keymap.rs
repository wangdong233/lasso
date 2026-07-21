//! CGEvent logical-key → CGKeyCode mapping integration tests (parse5 §5.3).
//!
//! 平台无关：经 lib facade 引用 lasso_rust_helper::cgevent_keymap 公共 API
//! （lookup_keycode / lookup_modifier / parse_key / parse_hotkey），覆盖：
//!
//!   1. 逻辑键名 → code 全覆盖（字母 / 数字 / 控制键 / 方向键 / F 键 / 标点）
//!   2. 未知键 → None
//!   3. 修饰键解析（cmd/shift/opt/ctrl + 别名 command/alt/option/control + 字符 ⌘⇧⌥⌃）
//!   4. hotkey 解析（简单 + 多修饰 + 单主键 + 多主键拒绝）
//!   5. INV-28 锚点：所有公共 API 入参是 &str，无 raw keycode input

use lasso_rust_helper::cgevent_keymap::{
    lookup_keycode, lookup_modifier, parse_hotkey, parse_key, ModifierSet, MOD_CMD, MOD_CTRL,
    MOD_FN, MOD_OPT, MOD_SHIFT,
};

// ============================================================================
// 单键 keycode 全覆盖
// ============================================================================

#[test]
fn all_letters_a_z_have_keycode() {
    for c in 'a'..='z' {
        let name = c.to_string();
        assert!(
            lookup_keycode(&name).is_some(),
            "letter '{}' should have a keycode",
            c
        );
    }
    // 大写形式同样接受
    for c in 'A'..='Z' {
        let name = c.to_string();
        assert!(lookup_keycode(&name).is_some());
    }
}

#[test]
fn all_digits_0_9_have_keycode() {
    for d in '0'..='9' {
        let name = d.to_string();
        assert!(lookup_keycode(&name).is_some());
    }
}

#[test]
fn control_keys_have_keycodes() {
    let expected = [
        ("return", 36),
        ("enter", 36), // alias
        ("tab", 48),
        ("space", 49),
        ("delete", 51),
        ("backspace", 51), // alias
        ("esc", 53),
        ("escape", 53), // alias
        ("capslock", 57),
        ("home", 115),
        ("end", 119),
        ("pageup", 116),
        ("pagedown", 121),
        ("help", 114),
    ];
    for (name, code) in expected {
        assert_eq!(
            lookup_keycode(name),
            Some(code),
            "key '{}' expected keycode {}",
            name,
            code
        );
    }
}

#[test]
fn arrow_keys_have_keycodes() {
    assert_eq!(lookup_keycode("left"), Some(123));
    assert_eq!(lookup_keycode("right"), Some(124));
    assert_eq!(lookup_keycode("down"), Some(125));
    assert_eq!(lookup_keycode("up"), Some(126));
}

#[test]
fn function_keys_f1_to_f12_have_keycodes() {
    for n in 1..=12u8 {
        let name = format!("f{}", n);
        assert!(
            lookup_keycode(&name).is_some(),
            "{} should have a keycode",
            name
        );
    }
}

#[test]
fn function_keys_f13_to_f20_have_keycodes() {
    // 扩展键盘 F 键（HIToolbox 公共码）
    for n in 13..=20u8 {
        let name = format!("f{}", n);
        assert!(
            lookup_keycode(&name).is_some(),
            "{} should have a keycode",
            name
        );
    }
}

#[test]
fn punctuation_keys_have_keycodes_us_layout() {
    for k in ["-", "=", "[", "]", "\\", ";", "'", "`", ",", ".", "/"] {
        assert!(lookup_keycode(k).is_some(), "punct '{}' missing", k);
    }
}

// ============================================================================
// 未知键拒绝
// ============================================================================

#[test]
fn unknown_keys_return_none() {
    assert!(lookup_keycode("").is_none());
    assert!(lookup_keycode("foo").is_none());
    assert!(lookup_keycode("hyper").is_none());
    assert!(lookup_keycode("CMD").is_none(), "cmd is modifier not key");
    assert!(lookup_keycode("cmd").is_none());
    // 注：单字母大小写不敏感；"X" → "x" 有 keycode（7）。非单字母不接受混合大小写。
    assert!(lookup_keycode("return").is_some()); // sanity
}

#[test]
fn lookup_keycode_is_case_insensitive() {
    // 单字母 / 控制键 / 功能键：大小写不敏感（内部 lowercase）
    assert_eq!(lookup_keycode("A"), lookup_keycode("a"));
    assert_eq!(lookup_keycode("RETURN"), lookup_keycode("return"));
    assert_eq!(lookup_keycode("F5"), lookup_keycode("f5"));
}

#[test]
fn empty_string_returns_none() {
    assert!(lookup_keycode("").is_none());
    assert!(lookup_modifier("").is_none());
    assert!(parse_key("").is_none());
    assert!(parse_hotkey("").is_none());
}

// ============================================================================
// 修饰键解析
// ============================================================================

#[test]
fn modifier_canonical_names() {
    assert_eq!(lookup_modifier("cmd"), Some(MOD_CMD));
    assert_eq!(lookup_modifier("shift"), Some(MOD_SHIFT));
    assert_eq!(lookup_modifier("opt"), Some(MOD_OPT));
    assert_eq!(lookup_modifier("ctrl"), Some(MOD_CTRL));
    assert_eq!(lookup_modifier("fn"), Some(MOD_FN));
}

#[test]
fn modifier_aliases_canonicalized() {
    assert_eq!(lookup_modifier("command"), Some(MOD_CMD));
    assert_eq!(lookup_modifier("option"), Some(MOD_OPT));
    assert_eq!(lookup_modifier("alt"), Some(MOD_OPT)); // Win 习惯
    assert_eq!(lookup_modifier("control"), Some(MOD_CTRL));
}

#[test]
fn modifier_unicode_glyphs() {
    // macOS 用户习惯用 ⌘⇧⌥⌃；alias 之
    assert_eq!(lookup_modifier("⌘"), Some(MOD_CMD));
    assert_eq!(lookup_modifier("⇧"), Some(MOD_SHIFT));
    assert_eq!(lookup_modifier("⌥"), Some(MOD_OPT));
    assert_eq!(lookup_modifier("⌃"), Some(MOD_CTRL));
}

#[test]
fn modifier_case_insensitive() {
    assert_eq!(lookup_modifier("CMD"), Some(MOD_CMD));
    assert_eq!(lookup_modifier("Shift"), Some(MOD_SHIFT));
    assert_eq!(lookup_modifier("OPT"), Some(MOD_OPT));
}

#[test]
fn modifier_set_bit_ops() {
    let s = ModifierSet::empty();
    assert!(!s.contains(MOD_CMD));
    let s = s.add(MOD_CMD).add(MOD_SHIFT);
    assert!(s.contains(MOD_CMD));
    assert!(s.contains(MOD_SHIFT));
    assert!(!s.contains(MOD_OPT));
    assert!(s.has_any());

    let empty = ModifierSet::empty();
    assert!(!empty.has_any());
}

// ============================================================================
// parse_hotkey 解析
// ============================================================================

#[test]
fn parse_hotkey_single_modifier_plus_key() {
    let m = parse_hotkey("cmd+c").unwrap();
    assert_eq!(m.keycode, 8); // 'c'
    assert!(m.modifiers.contains(MOD_CMD));
    assert!(!m.modifiers.contains(MOD_SHIFT));

    let m = parse_hotkey("shift+a").unwrap();
    assert_eq!(m.keycode, 0);
    assert!(m.modifiers.contains(MOD_SHIFT));
}

#[test]
fn parse_hotkey_multiple_modifiers() {
    let m = parse_hotkey("ctrl+opt+cmd+shift+f5").unwrap();
    assert_eq!(m.keycode, 96); // F5
    assert!(m.modifiers.contains(MOD_CMD));
    assert!(m.modifiers.contains(MOD_SHIFT));
    assert!(m.modifiers.contains(MOD_OPT));
    assert!(m.modifiers.contains(MOD_CTRL));
}

#[test]
fn parse_hotkey_single_key_no_modifier() {
    let m = parse_hotkey("Return").unwrap();
    assert_eq!(m.keycode, 36);
    assert!(!m.modifiers.has_any());
}

#[test]
fn parse_hotkey_handles_internal_external_whitespace() {
    let m = parse_hotkey(" cmd + c ").unwrap();
    assert_eq!(m.keycode, 8);
    assert!(m.modifiers.contains(MOD_CMD));
}

#[test]
fn parse_hotkey_unicode_modifier_in_combo() {
    let m = parse_hotkey("⌘+⇧+g").unwrap();
    assert_eq!(m.keycode, 5);
    assert!(m.modifiers.contains(MOD_CMD));
    assert!(m.modifiers.contains(MOD_SHIFT));
}

// ============================================================================
// parse_hotkey 拒绝路径
// ============================================================================

#[test]
fn parse_hotkey_rejects_two_main_keys() {
    assert!(parse_hotkey("a+b").is_none());
    assert!(parse_hotkey("cmd+a+b").is_none());
}

#[test]
fn parse_hotkey_rejects_unknown_modifier() {
    assert!(parse_hotkey("hyper+c").is_none());
    assert!(parse_hotkey("win+c").is_none());
}

#[test]
fn parse_hotkey_rejects_unknown_main_key() {
    assert!(parse_hotkey("cmd+foo").is_none());
}

#[test]
fn parse_hotkey_rejects_only_modifiers() {
    assert!(parse_hotkey("cmd").is_none());
    assert!(parse_hotkey("cmd+shift").is_none());
    assert!(parse_hotkey("ctrl+opt+cmd").is_none());
}

#[test]
fn parse_hotkey_rejects_malformed_spec() {
    assert!(parse_hotkey("+").is_none());
    assert!(parse_hotkey("cmd+").is_none());
    assert!(parse_hotkey("+c").is_none());
    assert!(parse_hotkey("cmd++c").is_none(), "double + rejected");
    assert!(parse_hotkey("  ").is_none());
}

// ============================================================================
// parse_key（press 路径，无修饰）
// ============================================================================

#[test]
fn parse_key_accepts_simple_key() {
    assert!(parse_key("Return").is_some());
    assert!(parse_key("a").is_some());
    assert!(parse_key("f5").is_some());
}

#[test]
fn parse_key_rejects_modifier_combinations() {
    // press method 走 parse_key；带修饰应走 hotkey method
    assert!(parse_key("cmd+c").is_none());
    assert!(parse_key("shift+a").is_none());
}

#[test]
fn parse_key_rejects_unknown() {
    assert!(parse_key("foo").is_none());
}

// ============================================================================
// INV-28 锚点
// ============================================================================

#[test]
fn inv_28_public_api_takes_str_not_keycode() {
    // INV-28：所有公共 lookup/parse 函数入参是 &str 逻辑键名，
    // 不接受 raw keycode 数字。本测试是源码锚点（如未来误改签名会编译失败）。
    let src = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/cgevent_keymap.rs"
    ));
    assert!(src.contains("pub fn lookup_keycode(name: &str)"));
    assert!(src.contains("pub fn lookup_modifier(name: &str)"));
    assert!(src.contains("pub fn parse_hotkey(spec: &str)"));
    assert!(src.contains("pub fn parse_key(spec: &str)"));
    // 防止误加 raw keycode 入参版（如 lookup_by_code(code: u16)）
    assert!(
        !src.contains("pub fn lookup_by_code"),
        "INV-28 violated: raw keycode input API should not exist"
    );
}

#[test]
fn inv_28_keycode_constant_table_is_in_keymap_file() {
    // INV-28 衍生：原始 keycode 字面量只许在 cgevent_keymap.rs；
    // cgevent.rs 不应有 `0x` 或裸数字 keycode（应全经 lookup_*）。
    let keymap_src = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/cgevent_keymap.rs"
    ));
    let cgevent_src = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/cgevent.rs"));

    // keymap 必须含 KEYCODES_STATIC 数据表
    assert!(keymap_src.contains("KEYCODES_STATIC"));
    // cgevent.rs 不应直接出现 `keycode = 36` 之类（但函数签名允许 u16）；
    // 只验没有 KEYCODES_STATIC / KEYCODES 同名表在 cgevent.rs：
    assert!(
        !cgevent_src.contains("KEYCODES_STATIC"),
        "INV-28: KEYCODES table must only live in cgevent_keymap.rs"
    );
}
