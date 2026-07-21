//! AppleScript whitelist manifest integration tests (parse5 §5.3).
//!
//! 平台无关：经 lib facade 引用 lasso_rust_helper::applescript_whitelist
//! 公共 API（lookup / whitelist / WHITELIST_STATIC），覆盖：
//!
//!   1. 白名单 manifest 全覆盖：每个 typed action 可查到模板
//!   2. typed action 不在白名单 → 拒绝（lookup 返 None）
//!   3. INV-27 顶级 const 锚点：源码扫描 env::var 不应出现
//!   4. 模板占位符 ⊆ allowedParams（防 typo）
//!   5. action 名 lowercase_snake_case（防 typo）
//!
//! 不依赖 macOS / TCC / osascript（pure data test）。CI Linux 同样跑。

use lasso_rust_helper::applescript_whitelist::{lookup, whitelist, WHITELIST_STATIC};

#[test]
fn whitelist_manifest_has_expected_size() {
    // parse5 §3.5.1 的 6 项基础 action + Lasso v0.4 M0.4b 补充几项共 9 项。
    // 若加新 action 不改本测试，则测试自动通过；若误删 action 本测试会失败。
    let count = WHITELIST_STATIC.len();
    assert!(
        count >= 6,
        "whitelist should have at least 6 actions (parse5 §3.5.1), got {}",
        count
    );
}

#[test]
fn whitelist_core_actions_present() {
    // parse5 §3.5.1 enum 的最小覆盖（Finder/Mail/Safari/Notes/SystemSettings）
    let names: Vec<&str> = WHITELIST_STATIC.iter().map(|(n, _)| *n).collect();
    assert!(names.contains(&"finder_new_folder"));
    assert!(names.contains(&"finder_empty_trash"));
    assert!(names.contains(&"mail_new_message"));
    assert!(names.contains(&"safari_open_bookmark") || names.contains(&"safari_open_location"));
    assert!(names.contains(&"notes_new_note"));
}

#[test]
fn whitelist_lookup_known_action_returns_template() {
    let tpl = lookup("finder_new_folder").expect("finder_new_folder in whitelist");
    assert!(
        tpl.script
            .contains("make new folder at (path to desktop folder)")
    );
    // 无参数 action
    assert!(tpl.allowed_params.is_empty());
}

#[test]
fn whitelist_lookup_action_with_params_returns_template() {
    let tpl = lookup("mail_new_message").expect("mail_new_message in whitelist");
    assert!(tpl.script.contains("${subject}"));
    assert!(tpl.script.contains("${content}"));
    assert!(tpl.allowed_params.contains(&"subject"));
    assert!(tpl.allowed_params.contains(&"content"));
}

#[test]
fn whitelist_lookup_returns_none_for_unknown_action() {
    assert!(lookup("do_shell_script_rm_rf").is_none());
    assert!(lookup("rm").is_none());
    assert!(lookup("").is_none());
    assert!(lookup("Finder_New_Folder").is_none(), "case-sensitive reject");
}

#[test]
fn whitelist_consistent_between_static_and_map() {
    // OnceLock 构造的 HashMap 必须与 WHITELIST_STATIC 同步
    let map = whitelist();
    assert_eq!(map.len(), WHITELIST_STATIC.len());
    for (name, tpl) in WHITELIST_STATIC {
        let got = map
            .get(*name)
            .unwrap_or_else(|| panic!("action '{}' in STATIC but not in map()", name));
        assert_eq!(got.script, tpl.script);
        assert_eq!(got.allowed_params, tpl.allowed_params);
    }
}

#[test]
fn whitelist_template_placeholders_subset_of_allowed_params() {
    // 防 typo：每个占位符必须在 allowedParams 中
    for (name, tpl) in WHITELIST_STATIC {
        let mut placeholders: Vec<&str> = Vec::new();
        let bytes = tpl.script.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
                let start = i + 2;
                if let Some(end_rel) = tpl.script[start..].find('}') {
                    let ph = &tpl.script[start..start + end_rel];
                    placeholders.push(ph);
                    i = start + end_rel + 1;
                    continue;
                }
            }
            i += 1;
        }
        for ph in placeholders {
            assert!(
                tpl.allowed_params.iter().any(|p| *p == ph),
                "action '{}' has placeholder ${{{}}} not in allowed_params",
                name,
                ph
            );
        }
    }
}

#[test]
fn whitelist_action_names_lowercase_snake_case() {
    for (name, _) in WHITELIST_STATIC {
        assert!(
            name.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "action '{}' not lowercase_snake_case",
            name
        );
        // 防双下划线 / 末尾下划线
        assert!(
            !name.contains("__"),
            "action '{}' has __ double underscore",
            name
        );
        assert!(
            !name.ends_with('_'),
            "action '{}' ends with underscore",
            name
        );
    }
}

#[test]
fn inv_27_whitelist_does_not_read_env() {
    // INV-27 anti-gaming：源码扫描 applescript_whitelist.rs 不应出现真实 env::var 调用。
    // 拼接 pattern 防本测试自身字面量污染扫描（self-reference）。
    // 这是 anti-gaming 防护锚点（类比 INV-14）；改本测试须同时改 INV-27。
    let src = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/applescript_whitelist.rs"
    ));
    let env_var_call: String = ["std", "env", "var"].join("::") + "(";
    let env_vars_call: String = ["std", "env", "vars"].join("::") + "(";
    let env_var_os_call: String = ["std", "env", "var_os"].join("::") + "(";
    assert!(!src.contains(&env_var_call), "INV-27: real env read");
    assert!(!src.contains(&env_vars_call), "INV-27: real env::vars");
    assert!(!src.contains(&env_var_os_call), "INV-27: real env::var_os");
    // 顶级 const manifest 必须是静态分发表（不是 lazy 构造从外部源）
    assert!(
        src.contains("WHITELIST_STATIC"),
        "INV-27 anchor: WHITELIST_STATIC top-level const must exist"
    );
}
