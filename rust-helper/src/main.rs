//! Lasso Rust helper binary（parse4 §3.1.3）。
//!
//! 通信协议：JSON-lines over stdio（每行一个 JSON 对象，\n 分隔，**无 Content-Length**）。
//! 协议类型在 `protocol.rs`；AXAPI/walk 在 `ax.rs`；screenshot 在 `screenshot.rs`；TCC 在 `tcc.rs`。
//!
//! stdout 仅写 Response；stdin 仅读 Request；stderr 走 eprintln! 诊断（doctor 可读，不进协议）。
//! 任一行解析失败：发 protocol_err（id=""+error_kind="parse_error"）继续读下一行，不退出。

use std::io::{self, BufRead, Write};

mod app_bundle_map;
mod ax;
mod ax_role_map;
mod protocol;
mod screenshot;
mod tcc;
mod windows;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[lasso-helper] stdin read err: {e}");
                continue;
            }
        };
        // 空行：容错跳过（部分 shell 可能多发一个换行）
        if line.trim().is_empty() {
            continue;
        }

        let req: protocol::Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = protocol::Response::protocol_err(
                    "parse_error",
                    format!("invalid JSON: {e}"),
                );
                let _ = writeln!(out, "{}", serde_json::to_string(&resp).unwrap_or_default());
                let _ = out.flush();
                continue;
            }
        };

        let resp = dispatch(&req);
        let s = serde_json::to_string(&resp).unwrap_or_else(|e| {
            serde_json::to_string(&protocol::Response::protocol_err(
                "serialize_error",
                format!("encode response: {e}"),
            ))
            .unwrap_or_default()
        });
        let _ = writeln!(out, "{s}");
        let _ = out.flush();
    }
}

fn dispatch(req: &protocol::Request) -> protocol::Response {
    match req.method.as_str() {
        "ping" => protocol::Response::ok(
            &req.id,
            serde_json::json!({
                "pong": true,
                "version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "tcc": tcc::snapshot(),
            }),
        ),
        "tcc_status" => match serde_json::to_value(tcc::snapshot()) {
            Ok(v) => protocol::Response::ok(&req.id, v),
            Err(e) => protocol::Response::err(&req.id, "ax_unavailable", format!("encode tcc: {e}")),
        },
        "ax_snapshot" => ax::snapshot(&req.id, &req.params),
        "ax_find" => ax::find(&req.id, &req.params),
        "ax_act" => ax::act(&req.id, &req.params),
        "screenshot" => screenshot::capture(&req.id, &req.params),
        "list_windows" => windows::list_windows(&req.id, &req.params),
        other => protocol::Response::err(
            &req.id,
            "unknown_method",
            format!("method '{other}' not recognized"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_unknown_method_returns_err() {
        let req = protocol::Request {
            id: "r1".into(),
            method: "frobnicate".into(),
            params: serde_json::Value::Null,
        };
        let resp = dispatch(&req);
        assert!(!resp.ok);
        assert_eq!(resp.error_kind.as_deref(), Some("unknown_method"));
    }

    #[test]
    fn dispatch_ping_returns_ok_with_version() {
        let req = protocol::Request {
            id: "r2".into(),
            method: "ping".into(),
            params: serde_json::Value::Null,
        };
        let resp = dispatch(&req);
        assert!(resp.ok);
        let result = resp.result.expect("ping result");
        assert_eq!(result["pong"], true);
        assert_eq!(result["version"], env!("CARGO_PKG_VERSION"));
        assert!(result["tcc"].is_object());
    }

    #[test]
    fn dispatch_tcc_status_ok() {
        let req = protocol::Request {
            id: "r3".into(),
            method: "tcc_status".into(),
            params: serde_json::Value::Null,
        };
        let resp = dispatch(&req);
        assert!(resp.ok);
        assert!(resp.result.unwrap()["accessibility"].is_boolean());
    }
}
