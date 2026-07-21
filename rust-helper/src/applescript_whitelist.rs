//! AppleScript whitelist manifest (parse5 §3.5.1 + §4.4 + INV-27).
//!
//! ## 3 层纵深防御（depth-in-defense）
//!
//!   层 1 (TS)：`src/desktop/apple-script-whitelist.ts` 顶级 const + AppleScriptProvider
//!              校验 action 在白名单 + params key 在 allowedParams
//!   层 2 (Rust)：`applescript::run` 二次校验 action + allowedParams（不信任 TS 端）
//!   层 3 (compile-time)：**本文件** 顶级 const，编译进 binary；运行时不可改
//!              （防 LLM 通过 channel 改 env 绕过；类比 INV-14 anti-gaming）
//!
//! ## INV-27 红线
//!
//!   - 本文件是**顶级 const**，从不读 env / config / 文件系统
//!   - 不存在任何 `std::env` 系列调用（var / vars / var_os 均禁；自测源码扫描）
//!   - 加新 action = 加这里一行 + TS 端镜像一行（≤2 处改动守 02 §4）
//!
//! ## 模板渲染
//!
//!   每个模板含占位符 `${param_name}`；运行时由 `applescript::render_template`
//!   做严格 string-replace。**不做 shell escape**：因为层 4（子进程 argv 数组）
//!   保证参数不经 shell interpolation；allowedParams 白名单限制输入维度。
//!   此外，参数值再经 `validate_param_value` 过滤（仅允许字母数字 + 限标点），
//!   即使模板拼接出脚本，osascript 也只看 argv[1]，不存在 command injection。
//!
//! ## 选型：subprocess `/usr/bin/osascript`
//!
//!   见 `examples/smoke_applescript.rs` 决策：
//!   - 零依赖（无 osakit crate / FFI 风险）
//!   - argv 数组传参（非 shell string），天然无注入
//!   - 错误码 + stderr 提供 clean error_kind 映射

use std::collections::HashMap;
use std::sync::OnceLock;

/// AppleScript 模板（对应 parse5 §3.5.1 AppleScriptTemplate）。
///
/// - `script`: 含 `${param}` 占位符的 AppleScript 文本
/// - `allowed_params`: 允许的参数名白名单（防注入层 2；运行时 params 的 key
///   必须是 allowed_params 的子集，否则 applescript::run 拒绝）
#[derive(Debug, Clone)]
pub struct AppleScriptTemplate {
    pub script: &'static str,
    pub allowed_params: &'static [&'static str],
}

/// 静态 manifest：action_name → 模板。
///
/// 覆盖 6 个常见 typed action（parse5 §3.5.1 枚举）。新加 action 加这里一行 +
/// TS 端 apple-script-whitelist.ts 镜像一行。
///
/// 注意：
///   - `do shell script "..."` 内部不做插值（参数不进 shell 路径）
///   - 所有 `${...}` 占位符必须出现在 allowed_params 中（编译期手工保证）
pub const WHITELIST_STATIC: &[(&str, AppleScriptTemplate)] = &[
    // ------------------------------------------------------------------
    // Finder
    // ------------------------------------------------------------------
    (
        "finder_new_folder",
        AppleScriptTemplate {
            script: "tell application \"Finder\" to make new folder at (path to desktop folder)",
            allowed_params: &[],
        },
    ),
    (
        "finder_empty_trash",
        AppleScriptTemplate {
            script: "tell application \"Finder\" to empty trash",
            allowed_params: &[],
        },
    ),
    (
        "finder_count_windows",
        AppleScriptTemplate {
            script: "tell application \"Finder\" to count of windows",
            allowed_params: &[],
        },
    ),
    // ------------------------------------------------------------------
    // Mail
    // ------------------------------------------------------------------
    (
        "mail_new_message",
        AppleScriptTemplate {
            script: "tell application \"Mail\"\nmake new outgoing message with properties {visible:true, subject:${subject}, content:${content}}\nend tell",
            allowed_params: &["subject", "content"],
        },
    ),
    // ------------------------------------------------------------------
    // Safari
    // ------------------------------------------------------------------
    (
        "safari_open_location",
        AppleScriptTemplate {
            script: "tell application \"Safari\" to open location ${url}",
            allowed_params: &["url"],
        },
    ),
    (
        "safari_get_url",
        AppleScriptTemplate {
            script: "tell application \"Safari\" to get URL of front document",
            allowed_params: &[],
        },
    ),
    // ------------------------------------------------------------------
    // Notes
    // ------------------------------------------------------------------
    (
        "notes_new_note",
        AppleScriptTemplate {
            script: "tell application \"Notes\"\nmake new note with properties {name:${name}, body:${body}}\nend tell",
            allowed_params: &["name", "body"],
        },
    ),
    // ------------------------------------------------------------------
    // System Settings / shell（不依赖特定 app 的 AppleEvents）
    // ------------------------------------------------------------------
    (
        "system_get_volume",
        AppleScriptTemplate {
            script: "output volume of (get volume settings)",
            allowed_params: &[],
        },
    ),
    (
        "system_get_uptime",
        AppleScriptTemplate {
            script: "do shell script \"uptime\"",
            allowed_params: &[],
        },
    ),
];

/// 运行时只读 HashMap 视图（OnceLock 构造一次，永久复用）。
///
/// 对外只暴露查询 API；不存在写入 API（INV-27 anti-gaming 守护）。
pub fn whitelist() -> &'static HashMap<&'static str, AppleScriptTemplate> {
    static MAP: OnceLock<HashMap<&'static str, AppleScriptTemplate>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut m = HashMap::with_capacity(WHITELIST_STATIC.len());
        for (name, tpl) in WHITELIST_STATIC {
            m.insert(*name, tpl.clone());
        }
        m
    })
}

/// 查询 action 是否在白名单 + 返模板引用。
///
/// 注：`whitelist()` 返 `&'static HashMap` 但 borrow 类型是 `&'_`；
/// 因为 underlying storage 是 OnceLock 持有 `&'static str` key +
/// clone 的 `AppleScriptTemplate`，无法直接返 `&'static AppleScriptTemplate`。
/// caller (`applescript::run`) 在函数作用域内用，无需 'static lifetime。
pub fn lookup(action: &str) -> Option<AppleScriptTemplate> {
    whitelist().get(action).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_static_has_expected_actions() {
        let names: Vec<&str> = WHITELIST_STATIC.iter().map(|(n, _)| *n).collect();
        assert!(names.contains(&"finder_new_folder"), "missing finder_new_folder");
        assert!(names.contains(&"mail_new_message"), "missing mail_new_message");
        assert!(names.contains(&"safari_open_location"), "missing safari_open_location");
        assert!(names.contains(&"notes_new_note"), "missing notes_new_note");
        assert!(names.contains(&"system_get_uptime"), "missing system_get_uptime");
    }

    #[test]
    fn whitelist_lookup_returns_template_for_known_action() {
        let tpl = lookup("finder_count_windows").expect("known action");
        assert!(tpl.script.contains("count of windows"));
        assert!(tpl.allowed_params.is_empty());
    }

    #[test]
    fn whitelist_lookup_returns_none_for_unknown_action() {
        assert!(lookup("do_shell_script_rm_rf").is_none());
        assert!(lookup("").is_none());
    }

    #[test]
    fn whitelist_immutable_top_level_const_no_env_var_read() {
        // INV-27 守护：源码扫描确保本文件不出现真实 env::var 调用（带括号 / 路径）。
        // 拼接 pattern 避免本测试自身字符串污染扫描（self-reference）。
        // 锚点：若未来引入真实 env 读，应同时改本测试 + INV-27。
        let src = include_str!("applescript_whitelist.rs");
        let env_var_call: String = ["std", "env", "var"].join("::") + "(";
        let env_vars_call: String = ["std", "env", "vars"].join("::") + "(";
        let env_var_os_call: String = ["std", "env", "var_os"].join("::") + "(";
        assert!(
            !src.contains(&env_var_call),
            "INV-27 violated: real env read call found"
        );
        assert!(
            !src.contains(&env_vars_call),
            "INV-27 violated: real env::vars call found"
        );
        assert!(
            !src.contains(&env_var_os_call),
            "INV-27 violated: real env::var_os call found"
        );
        // 顶级 const manifest 必须存在（INV-27 anchor）
        assert!(
            src.contains("WHITELIST_STATIC"),
            "INV-27 anchor: WHITELIST_STATIC top-level const must exist"
        );
    }

    #[test]
    fn whitelist_all_templates_have_consistent_placeholder_and_allowed_params() {
        // 编译期手工保证的"占位符 ⊆ allowed_params"在测试期再验一次。
        for (name, tpl) in WHITELIST_STATIC {
            let mut placeholders = Vec::new();
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
                    "action '{}' has placeholder '{}={{{}}}' not in allowed_params",
                    name,
                    '$',
                    ph
                );
            }
        }
    }

    #[test]
    fn whitelist_action_names_are_lowercase_snake_case() {
        // 防 typo：action 名加错成 "Finder_New_Folder" 之类（TS 端 zod enum 也守）。
        for (name, _) in WHITELIST_STATIC {
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "action name '{}' not lowercase_snake_case",
                name
            );
        }
    }
}
