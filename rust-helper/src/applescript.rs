//! AppleScript execution (parse5 §3.5.2 + §3.5.5 + §4.4 + INV-27).
//!
//! ## 路径选型（smoke 验证后决策）
//!
//!   见 `examples/smoke_applescript.rs` 决策矩阵：本环境（macOS 12 Intel,
//!   rsproxy 镜像）下选 **`/usr/bin/osascript` subprocess**：
//!   - 零依赖：无 osakit crate / FFI 风险
//!   - argv 数组传参（非 shell string），天然无注入
//!   - exit code + stderr 提供 clean error_kind 映射
//!   - ~5-10ms per call 在 4-tier fallback 第 2 档可接受（非热路径）
//!
//! ## 3 层纵深防御 + 子进程 argv 层（共 4 层）
//!
//!   层 1 (TS)：`AppleScriptProvider.act` 校验 action 在白名单 + params key
//!              在 allowedParams（type-safe 入口）
//!   层 2 (Rust, 本文件)：二次校验 action 在白名单 + params key 在 allowedParams
//!   层 3 (compile-time, `applescript_whitelist.rs`)：顶级 const manifest，
//!              编译进 binary；运行时不可改（INV-27 anti-gaming）
//!   层 4 (subprocess argv)：参数经 `validate_param_value` 字符过滤 + argv 数组
//!              传递；`/usr/bin/osascript -e <script>` 不经 shell，杜绝 shell injection
//!
//! ## INV-27 / F3.10.8 红线
//!
//!   - `applescript_run` 不接受 `script` 字段（params schema 锁死 `{action, params}`）
//!   - 不读 env / config / 文件系统构造脚本（脚本仅来自 whitelist manifest）
//!   - 任何对 `do shell script` 的 AppleScript 模板参数经白名单 + 字符过滤
//!
//! ## 协议出口
//!
//!   `applescript::run(id, params) -> Response`
//!     成功：`{ok:true, result:{stdout:"...", exit_code:0, action:"..."}}`
//!     失败 kind：
//!       - `script_not_in_whitelist`：action 不在 whitelist
//!       - `param_not_in_whitelist`：params 含 allowedParams 外的 key
//!       - `param_value_invalid`：值字符过滤失败
//!       - `applescript_exec_failed`：osascript exit != 0
//!       - `applescript_spawn_failed`：fork/exec 失败（极端）
//!       - `applescript_timeout`：超时（AppleEvent -1712 等）
//!       - `not_macos`：非 macOS 平台
//!       - `invalid_params`：params 不是 object / action 缺失

use crate::applescript_whitelist::{lookup, AppleScriptTemplate};
use crate::protocol::Response;

#[cfg(target_os = "macos")]
use std::time::Duration;

/// 子进程超时秒数（AppleEvent 偶发挂死兜底；smoke 中 Finder -1712 即如此）。
const OSA_TIMEOUT_SECS: u64 = 10;

/// 参数值允许的字符集（防 AppleScript / shell 特殊字符注入层 4）。
///
/// 允许：字母 / 数字 / 空格 / `_-./:@?#&+=,()`；其余（含 `;`、反引号、`$()`、
/// 换行符、`\\`）一律拒。这样即使模板拼接出脚本，osascript 也不会被注入
/// shell 命令或额外 AppleScript 语句。
const ALLOWED_PARAM_CHARS: &str =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-./:@?#&+=,()";

// ============================================================================
// Non-macOS fallback
// ============================================================================

#[cfg(not(target_os = "macos"))]
pub fn run(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_macos", "applescript_run requires macOS")
}

// ============================================================================
// macOS 实装
// ============================================================================

#[cfg(target_os = "macos")]
pub fn run(id: &str, params: &serde_json::Value) -> Response {
    use std::process::Command;

    // ------------------------------------------------------------------
    // 层 2（Rust 端）：解析 + 校验
    // ------------------------------------------------------------------
    let action = match params.get("action").and_then(|v| v.as_str()) {
        Some(a) => a,
        None => return Response::err(id, "invalid_params", "missing action"),
    };
    let template = match lookup(action) {
        Some(t) => t,
        None => {
            return Response::err(
                id,
                "script_not_in_whitelist",
                format!("action '{}' not in whitelist manifest", action),
            );
        }
    };

    let params_obj = match params.get("params") {
        Some(serde_json::Value::Object(_)) => params.get("params").cloned().unwrap(),
        Some(serde_json::Value::Null) | None => serde_json::json!({}),
        Some(other) => {
            return Response::err(
                id,
                "invalid_params",
                format!("params must be object, got {}", type_name(other)),
            );
        }
    };

    // 层 2 校验：params key 必须全在 allowedParams
    if let Some(obj) = params_obj.as_object() {
        for k in obj.keys() {
            if !template.allowed_params.iter().any(|p| p == k) {
                return Response::err(
                    id,
                    "param_not_in_whitelist",
                    format!("param '{}' not allowed for action '{}'", k, action),
                );
            }
        }
    }

    // 层 4 前置：参数值字符过滤
    let rendered = match render_template(&template, &params_obj, id, action) {
        Ok(s) => s,
        Err(resp) => return resp,
    };

    // ------------------------------------------------------------------
    // 子进程执行（argv 数组，不经 shell）
    // ------------------------------------------------------------------
    let mut cmd = Command::new("/usr/bin/osascript");
    cmd.arg("-e").arg(&rendered);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Response::err(
                id,
                "applescript_spawn_failed",
                format!("spawn /usr/bin/osascript: {}", e),
            );
        }
    };

    // 等待子进程结束，带超时兜底（AppleEvent hang → kill）
    let wait_result = child.wait_timeout(Duration::from_secs(OSA_TIMEOUT_SECS));
    let exit_status = match wait_result {
        Ok(Some(status)) => status,
        Ok(None) => {
            // 超时：kill 子进程并返 timeout error_kind
            let _ = child.kill();
            let _ = child.wait();
            return Response::err(
                id,
                "applescript_timeout",
                format!("osascript exceeded {}s (AppleEvent hang?)", OSA_TIMEOUT_SECS),
            );
        }
        Err(e) => {
            let _ = child.kill();
            return Response::err(
                id,
                "applescript_exec_failed",
                format!("wait osascript: {}", e),
            );
        }
    };

    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => {
            return Response::err(
                id,
                "applescript_exec_failed",
                format!("read osascript output: {}", e),
            );
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !exit_status.success() {
        return Response::err(
            id,
            "applescript_exec_failed",
            format!(
                "osascript exit {}: stderr={:?} stdout={:?}",
                exit_status.code().unwrap_or(-1),
                stderr,
                stdout
            ),
        );
    }

    Response::ok(
        id,
        serde_json::json!({
            "action": action,
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_status.code().unwrap_or(0),
        }),
    )
}

// ============================================================================
// 共用 helper（平台无关）
// ============================================================================

/// 渲染模板：将 `${param}` 替换为 params 中的字符串值（带字符过滤）。
///
/// 渲染失败时返 `Response::err` 经 caller 透出（`param_value_invalid`）。
#[cfg(target_os = "macos")]
fn render_template(
    template: &AppleScriptTemplate,
    params: &serde_json::Value,
    id: &str,
    action: &str,
) -> Result<String, Response> {
    let mut out = template.script.to_string();
    for key in template.allowed_params {
        let val_json = params.get(*key);
        let val_str = match val_json {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::Bool(b)) => b.to_string(),
            None => String::new(),
            Some(other) => {
                return Err(Response::err(
                    id,
                    "param_value_invalid",
                    format!(
                        "param '{}' for action '{}' must be scalar, got {}",
                        key,
                        action,
                        type_name(other)
                    ),
                ));
            }
        };
        if let Err(bad_char) = validate_param_value(&val_str) {
            return Err(Response::err(
                id,
                "param_value_invalid",
                format!(
                    "param '{}' for action '{}' contains disallowed char {:?}; allowed: {:?}",
                    key, action, bad_char, ALLOWED_PARAM_CHARS
                ),
            ));
        }
        // AppleScript 字符串字面值：参数两侧加双引号（除非是数字）
        let is_numeric = val_json.and_then(|v| v.as_i64()).is_some();
        let replacement = if is_numeric || val_str.is_empty() {
            val_str.clone()
        } else {
            format!("\"{}\"", val_str)
        };
        out = out.replace(&format!("${{{}}}", key), &replacement);
    }
    Ok(out)
}

/// 参数值字符白名单过滤（防 AppleScript/shell 元字符注入）。
///
/// 返 `Ok(())` 全部允许；返 `Err(char)` 第一个不通过字符。
fn validate_param_value(value: &str) -> Result<(), char> {
    for c in value.chars() {
        if !ALLOWED_PARAM_CHARS.contains(c) {
            return Err(c);
        }
    }
    Ok(())
}

/// JSON 类型名（错误信息友好显示用）。
fn type_name(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

// ============================================================================
// wait_timeout trait shim：std::process::Child 不直接提供 wait_timeout
// ============================================================================

#[cfg(target_os = "macos")]
trait ChildWaitTimeoutExt {
    fn wait_timeout(&mut self, dur: Duration) -> std::io::Result<Option<std::process::ExitStatus>>;
}

#[cfg(target_os = "macos")]
impl ChildWaitTimeoutExt for std::process::Child {
    fn wait_timeout(&mut self, dur: Duration) -> std::io::Result<Option<std::process::ExitStatus>> {
        // 用 poll：每 50ms try_wait 一次，直到完成或超时
        let start = std::time::Instant::now();
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(Some(status));
            }
            if start.elapsed() >= dur {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_param_value_allows_basic_chars() {
        assert!(validate_param_value("hello world").is_ok());
        assert!(validate_param_value("user@example.com").is_ok());
        assert!(validate_param_value("https://example.com/path?x=1&y=2").is_ok());
        assert!(validate_param_value("123").is_ok());
        assert!(validate_param_value("").is_ok());
    }

    #[test]
    fn validate_param_value_rejects_shell_metachars() {
        assert!(validate_param_value("hello;rm -rf /").is_err(), "; rejected");
        assert!(validate_param_value("$(whoami)").is_err(), "$() rejected");
        assert!(validate_param_value("`whoami`").is_err(), "backtick rejected");
        assert!(validate_param_value("a\nb").is_err(), "newline rejected");
        assert!(validate_param_value("a\\b").is_err(), "backslash rejected");
        assert!(validate_param_value("a\"b").is_err(), "double-quote rejected");
        assert!(validate_param_value("a'b").is_err(), "single-quote rejected");
    }

    #[test]
    fn validate_param_value_rejects_applescript_injection() {
        // 防多层 AppleScript 注入：真正危险的字符是引号 / 换行（让 AppleScript 看到
        // 字符串字面值外的语法）。`-` 是 URL/名字常用字符，故意允许；模板渲染层
        // 把参数值包在 "..." 中，即使 -- 在字符串内也不会成为注释。
        assert!(validate_param_value("a\n-- evil").is_err(), "newline rejected");
        assert!(validate_param_value("a\"-- evil").is_err(), "double-quote rejected");
        assert!(validate_param_value("a'-- evil").is_err(), "single-quote rejected");
        // 注释符号本身（不带换行 / 引号）允许：模板把它包在字符串字面值里
        assert!(validate_param_value("-- just text").is_ok());
    }

    #[test]
    fn type_name_covers_all_variants() {
        assert_eq!(type_name(&serde_json::Value::Null), "null");
        assert_eq!(type_name(&serde_json::json!(true)), "bool");
        assert_eq!(type_name(&serde_json::json!(42)), "number");
        assert_eq!(type_name(&serde_json::json!("hi")), "string");
        assert_eq!(type_name(&serde_json::json!([1])), "array");
        assert_eq!(type_name(&serde_json::json!({})), "object");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn render_template_replaces_placeholders() {
        let template = AppleScriptTemplate {
            script: "do shell script \"echo ${name}\"",
            allowed_params: &["name"],
        };
        let params = serde_json::json!({"name": "world"});
        let rendered = render_template(&template, &params, "t1", "test_action").unwrap();
        assert!(rendered.contains("\"world\""), "got: {}", rendered);
        assert!(!rendered.contains("${name}"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn render_template_rejects_disallowed_chars() {
        let template = AppleScriptTemplate {
            script: "${x}",
            allowed_params: &["x"],
        };
        let params = serde_json::json!({"x": "$(whoami)"});
        let r = render_template(&template, &params, "t2", "test_action");
        assert!(r.is_err());
        let resp = r.unwrap_err();
        assert_eq!(resp.error_kind.as_deref(), Some("param_value_invalid"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn run_returns_invalid_params_when_action_missing() {
        let resp = run("t3", &serde_json::json!({"params": {}}));
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("invalid_params"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn run_returns_script_not_in_whitelist_for_unknown_action() {
        let resp = run("t4", &serde_json::json!({"action": "rm_rf_everything"}));
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("script_not_in_whitelist"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn run_returns_param_not_in_whitelist_for_extra_key() {
        // finder_count_windows.allowed_params = []
        let resp = run(
            "t5",
            &serde_json::json!({"action": "finder_count_windows", "params": {"evil": "x"}}),
        );
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("param_not_in_whitelist"));
    }
}
