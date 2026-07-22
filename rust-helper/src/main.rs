//! Lasso Rust helper binary（parse4 §3.1.3）。
//!
//! 通信协议：JSON-lines over stdio（每行一个 JSON 对象，\n 分隔，**无 Content-Length**）。
//! 协议类型在 `protocol.rs`；AXAPI/walk 在 `ax.rs`；screenshot 在 `screenshot.rs`；TCC 在 `tcc.rs`。
//!
//! stdout 仅写 Response；stdin 仅读 Request；stderr 走 eprintln! 诊断（doctor 可读，不进协议）。
//! 任一行解析失败：发 protocol_err（id=""+error_kind="parse_error"）继续读下一行，不退出。

use std::io::{self, BufRead, Write};

mod app_bundle_map;
mod applescript;
mod applescript_whitelist;
mod ax;
mod ax_role_map;
mod cgevent;
mod cgevent_keymap;
mod protocol;
mod screenshot;
mod tcc;
// v1.0 Phase B（parse11 §3.1 + §7.2）：Windows UIA + Linux AT-SPI backend
// 经 cfg-gate 实装。macOS build 下两文件的 platform mod 不参与编译，只剩
// `not_windows` / `not_linux` 兜底桩（dispatch 不会路由到，但符号需存在）。
mod atspi;
mod uia;
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
        // v1.0 Phase B（parse11 §3.1 + §7.2）：跨平台 desktop backend method 路由。
        // 三平台 dispatch 同形：method 名 → 平台模块入口；平台差异在 backend 内部隔离。
        //   - macOS build    ：uia_* 返 not_windows / atspi_* 返 not_linux（兜底桩）
        //   - Windows target ：uia_* 路由到 uia.rs::platform（windows-rs 真实实装）
        //   - Linux target   ：atspi_* 路由到 atspi.rs::platform（atspi crate 真实实装）
        // INV-21 守：本文件只做字符串路由，不直接 import 平台 crate 符号
        // （UIAutomationClient / libatspi 隔离在 uia.rs / atspi.rs cfg-gate 内）。
        "uia_snapshot" => uia::snapshot(&req.id, &req.params),
        "uia_find" => uia::find(&req.id, &req.params),
        "uia_act" => uia::act(&req.id, &req.params),
        "atspi_snapshot" => atspi::snapshot(&req.id, &req.params),
        "atspi_find" => atspi::find(&req.id, &req.params),
        "atspi_act" => atspi::act(&req.id, &req.params),
        "screenshot" => screenshot::capture(&req.id, &req.params),
        "list_windows" => windows::list_windows(&req.id, &req.params),
        // v0.4 M0.4b（parse5 §3.5）：desktop 4-tier fallback 第 2/3 档
        "applescript_run" => applescript::run(&req.id, &req.params),
        "cgevent_key" => cgevent::key(&req.id, &req.params),
        "cgevent_hotkey" => cgevent::hotkey(&req.id, &req.params),
        "cgevent_dispatch" => cgevent::dispatch(&req.id, &req.params),
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

    // v1.0 Phase B（parse11 §3.1）：uia_* / atspi_* dispatch 路由
    // macOS build 走 cfg(not(target_os = ...)) fallback 桩 → not_windows / not_linux。
    // Windows / Linux target 的真实实装路径在 uia.rs / atspi.rs 平台测里覆盖。

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn dispatch_uia_methods_return_not_windows_on_non_windows() {
        for method in ["uia_snapshot", "uia_find", "uia_act"] {
            let req = protocol::Request {
                id: "ru".into(),
                method: method.into(),
                params: serde_json::Value::Null,
            };
            let resp = dispatch(&req);
            assert!(!resp.ok, "{method} should be err on non-Windows");
            assert_eq!(resp.error_kind.as_deref(), Some("not_windows"));
        }
    }

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn dispatch_atspi_methods_return_not_linux_on_non_linux() {
        for method in ["atspi_snapshot", "atspi_find", "atspi_act"] {
            let req = protocol::Request {
                id: "rl".into(),
                method: method.into(),
                params: serde_json::Value::Null,
            };
            let resp = dispatch(&req);
            assert!(!resp.ok, "{method} should be err on non-Linux");
            assert_eq!(resp.error_kind.as_deref(), Some("not_linux"));
        }
    }

    #[test]
    fn dispatch_cross_platform_methods_routed_not_unknown() {
        // 守：uia_* / atspi_* 必须在 dispatch 表里有路由（不落到 unknown_method）。
        // 即使在 macOS（fallback 桩），error_kind 也必须是 not_windows / not_linux，
        // 不是 unknown_method —— 证明 method 名注册正确。
        for method in [
            "uia_snapshot",
            "uia_find",
            "uia_act",
            "atspi_snapshot",
            "atspi_find",
            "atspi_act",
        ] {
            let req = protocol::Request {
                id: "rv".into(),
                method: method.into(),
                params: serde_json::Value::Null,
            };
            let resp = dispatch(&req);
            assert_ne!(
                resp.error_kind.as_deref(),
                Some("unknown_method"),
                "{method} must be routed (got unknown_method)"
            );
        }
    }
}
