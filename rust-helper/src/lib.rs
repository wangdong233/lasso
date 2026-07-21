//! Lasso Rust helper library facade（parse4 §3.1）。
//!
//! 主要使用场景：binary 入口（main.rs）。
//! 但 integration tests 在 `tests/` 目录下需要以 crate 形式引用 protocol / ax_role_map，
//! 故本 lib.rs 重导出那些平台无关模块；macOS-only 模块不暴露（CI Linux 不跑）。

pub mod app_bundle_map;
pub mod ax_role_map;
pub mod protocol;
