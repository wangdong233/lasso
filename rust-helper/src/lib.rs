//! Lasso Rust helper library facade（parse4 §3.1）。
//!
//! 主要使用场景：binary 入口（main.rs）。
//! 但 integration tests 在 `tests/` 目录下需要以 crate 形式引用 protocol / ax_role_map，
//! 故本 lib.rs 重导出那些平台无关模块；macOS-only 模块不暴露（CI Linux 不跑）。
//!
//! v0.4 M0.4b（parse5 §2.2 + §5.3）：新增 `applescript_whitelist` + `cgevent_keymap`
//! 重导出。两者都是纯数据 + 平台无关 lookup；macOS-only 执行（subprocess / CGEvent）
//! 在 applescript.rs / cgevent.rs 内 cfg-gated，不暴露给 integration tests。

pub mod app_bundle_map;
pub mod applescript_whitelist;
pub mod ax_role_map;
pub mod cgevent_keymap;
pub mod protocol;
