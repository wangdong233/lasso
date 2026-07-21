//! JSON-lines protocol types for the Lasso Rust helper (parse4 §3.1.2).
//!
//! Wire format (INV-7 衍生铁律):
//!   - 一行一个 JSON 对象，`\n` 分隔
//!   - **无 Content-Length framing**（与 MCP JSON-RPC 区分；SubprocessManager 不能混淆两种协议）
//!   - Request 与 Response 都以 `id` 关联（UUID）
//!   - stdout 仅写 Response，stdin 仅读 Request
//!   - stderr 仅供诊断（eprintln!），不参与协议
//!
//! 错误种类（error_kind）：
//!   - `parse_error`              协议解析失败
//!   - `unknown_method`           未识别的 method
//!   - `not_macos`                非 macOS 平台调用 ax_*/screenshot
//!   - `tcc_denied`               Accessibility 未授权
//!   - `tcc_screen_recording_denied` Screen Recording 未授权
//!   - `app_not_found`            指定 app 未运行
//!   - `ax_unavailable`           AX 调用失败（generic）
//!   - `invalid_params`           参数校验失败
//!   - `not_implemented`          方法/动作占位
//!
//! v0.4 M0.4b 新增（parse5 §3.5.5）：
//!   - `script_not_in_whitelist`  applescript_run: action 不在白名单 manifest
//!                                （INV-27 纵深防御层 2）
//!   - `param_not_in_whitelist`   applescript_run: params key 不在 allowedParams
//!   - `param_value_invalid`      applescript_run: 参数值含非法字符（层 4 过滤）
//!   - `applescript_exec_failed`  applescript_run: osascript exit != 0
//!   - `applescript_spawn_failed` applescript_run: fork/exec 失败
//!   - `applescript_timeout`      applescript_run: 超时（AppleEvent -1712 等）
//!   - `cgevent_unknown_key`      cgevent_key/hotkey: 逻辑键名未在 keymap
//!                                （INV-28 强制 keymap）
//!   - `cgevent_source_failed`    cgevent_*: CGEventSource 构造失败
//!   - `cgevent_construct_failed` cgevent_*: CGEvent::new_keyboard_event 失败

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Request {
    /// UUID，由调用方生成，Response 原样回写以关联 in-flight 调用。
    pub id: String,
    /// "ping"|"tcc_status"|"ax_snapshot"|"ax_find"|"ax_act"|"screenshot"
    /// |"list_windows"|"applescript_run"|"cgevent_key"|"cgevent_hotkey"
    /// |"cgevent_dispatch"  （v0.4 M0.4b 加后 4 个）
    pub method: String,
    /// 方法特定参数；未知字段忽略。`serde_json::Value::Null` 表示无参数。
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Response {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 机器可读的错误种类（见上）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
}

impl Response {
    /// 成功响应：`{id, ok:true, result}`.
    pub fn ok(id: &str, result: serde_json::Value) -> Self {
        Self {
            id: id.to_string(),
            ok: true,
            result: Some(result),
            error: None,
            error_kind: None,
        }
    }

    /// 失败响应：`{id, ok:false, error, error_kind}`.
    pub fn err(id: &str, kind: &str, msg: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            ok: false,
            result: None,
            error: Some(msg.into()),
            error_kind: Some(kind.to_string()),
        }
    }

    /// 协议级错误（id 不可读时）—— id 留空，调用方按 in-flight table 找不到即丢弃。
    pub fn protocol_err(kind: &str, msg: impl Into<String>) -> Self {
        Self {
            id: String::new(),
            ok: false,
            result: None,
            error: Some(msg.into()),
            error_kind: Some(kind.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip_minimal() {
        let json = r#"{"id":"r1","method":"ping"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert_eq!(req.id, "r1");
        assert_eq!(req.method, "ping");
        assert!(req.params.is_null());
    }

    #[test]
    fn request_round_trip_with_params() {
        let json = r#"{"id":"r2","method":"ax_snapshot","params":{"app":"Finder","max_depth":3}}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert_eq!(req.id, "r2");
        assert_eq!(req.method, "ax_snapshot");
        assert_eq!(req.params["app"], "Finder");
        assert_eq!(req.params["max_depth"], 3);
    }

    #[test]
    fn response_ok_omits_error_fields() {
        let resp = Response::ok("r1", serde_json::json!({"pong": true}));
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains(r#""ok":true"#));
        assert!(s.contains(r#""result":{"pong":true}"#));
        assert!(!s.contains("error"));
    }

    #[test]
    fn response_err_includes_kind() {
        let resp = Response::err("r1", "tcc_denied", "not granted");
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains(r#""ok":false"#));
        assert!(s.contains(r#""error":"not granted""#));
        assert!(s.contains(r#""error_kind":"tcc_denied""#));
        assert!(!s.contains("result"));
    }
}
