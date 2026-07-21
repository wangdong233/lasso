//! Request/Response serde round-trip 测试（平台无关，CI 在 Linux 也跑）。
//!
//! parse4 §5.1 protocol.rs。

use lasso_rust_helper::protocol::{Request, Response};

// 注意：本 crate 是 binary-only（[[bin]]），主模块为 main.rs。
// 为了让 integration test 能引用 protocol 模块，src/lib.rs 暴露 protocol 重导出。
// 见 src/lib.rs（与本测试同时新增）。

#[test]
fn request_minimal_no_params() {
    let json = r#"{"id":"r1","method":"ping"}"#;
    let req: Request = serde_json::from_str(json).unwrap();
    assert_eq!(req.id, "r1");
    assert_eq!(req.method, "ping");
    assert!(req.params.is_null());
}

#[test]
fn request_with_object_params() {
    let json = r#"{"id":"r2","method":"ax_snapshot","params":{"app":"Finder","max_depth":3}}"#;
    let req: Request = serde_json::from_str(json).unwrap();
    assert_eq!(req.id, "r2");
    assert_eq!(req.method, "ax_snapshot");
    assert_eq!(req.params["app"], "Finder");
    assert_eq!(req.params["max_depth"], 3);
}

#[test]
fn request_unknown_fields_ignored() {
    // 协议向前兼容：未来版本加字段不应破坏旧 helper
    let json = r#"{"id":"r3","method":"ping","params":{},"extra":"ignored"}"#;
    let req: Request = serde_json::from_str(json).unwrap();
    assert_eq!(req.id, "r3");
}

#[test]
fn response_ok_omits_optional_fields() {
    let resp = Response::ok("r1", serde_json::json!({"pong": true}));
    let s = serde_json::to_string(&resp).unwrap();
    assert!(s.contains(r#""ok":true"#));
    assert!(s.contains(r#""result":{"pong":true}"#));
    assert!(!s.contains(r#""error""#));
    assert!(!s.contains(r#""error_kind""#));
}

#[test]
fn response_err_omits_result() {
    let resp = Response::err("r1", "tcc_denied", "Accessibility 未授权");
    let s = serde_json::to_string(&resp).unwrap();
    assert!(s.contains(r#""ok":false"#));
    assert!(s.contains(r#""error_kind":"tcc_denied""#));
    assert!(!s.contains(r#""result""#));
}

#[test]
fn response_round_trip_preserves_id() {
    let original = Response::ok("uuid-abc-123", serde_json::json!([1, 2, 3]));
    let s = serde_json::to_string(&original).unwrap();
    let parsed: Response = serde_json::from_str(&s).unwrap();
    assert_eq!(parsed.id, "uuid-abc-123");
    assert!(parsed.ok);
    assert_eq!(parsed.result, Some(serde_json::json!([1, 2, 3])));
}

#[test]
fn response_protocol_err_has_empty_id() {
    let resp = Response::protocol_err("parse_error", "bad json");
    assert_eq!(resp.id, "");
    assert!(!resp.ok);
    assert_eq!(resp.error_kind.as_deref(), Some("parse_error"));
}

#[test]
fn request_missing_method_errors() {
    let json = r#"{"id":"r4"}"#;
    let result: Result<Request, _> = serde_json::from_str(json);
    assert!(result.is_err());
}

#[test]
fn request_missing_id_errors() {
    let json = r#"{"method":"ping"}"#;
    let result: Result<Request, _> = serde_json::from_str(json);
    assert!(result.is_err());
}
