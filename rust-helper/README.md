# lasso-rust-helper

Lasso DesktopChannel 的 Rust helper 二进制：通过 **JSON-lines over stdio** 协议向 TS 层暴露 macOS AXAPI + CGWindowList 截屏 + TCC 探测能力。

> parse4 §3.1（v0.3.5 DesktopChannel MVP Phase A 产物）。本目录是 **macOS-only** 的；CI 在 Linux 跳过 desktop 集成测，只跑平台无关单测（`protocol.rs` + `ax_role_map.rs`）。

---

## 目录布局

```
rust-helper/
├── Cargo.toml                  依赖锁定（accessibility 0.2 + accessibility-sys 0.2 + core-graphics 0.24 + …）
├── examples/
│   └── smoke_api.rs            AXAPI 真实 API 经验性探测（cargo run --example smoke_api）
├── src/
│   ├── lib.rs                  平台无关模块重导出（protocol / ax_role_map）
│   ├── main.rs                 binary 入口；stdin/stdout JSON-lines 事件循环 + dispatch
│   ├── protocol.rs             Request/Response 类型（id 关联，无 Content-Length framing）
│   ├── ax.rs                   AXAPI walk + snapshot/find/act（macOS-only）
│   ├── ax_role_map.rs          AXRole → unified role const 表（与 TS 端 ax-role-map.ts 镜像）
│   ├── tcc.rs                  AXIsProcessTrustedWithOptions + CGPreflightScreenCaptureAccess 探测
│   └── screenshot.rs           CGWindowListCreateImage + ImageIO PNG encode → base64
├── tests/
│   ├── protocol.rs             Request/Response serde round-trip（平台无关，CI 跑）
│   └── ax_role_map.rs          AXRole 映射全覆盖（平台无关，CI 跑）
└── build/
    └── sign.sh                 cargo build --release + codesign Developer ID 脚本
```

---

## 构建

### 不签名（开发用，TCC 会重弹）
```bash
cd rust-helper
cargo build --release
# binary 在 target/release/lasso-rust-helper
```

### 签名（TCC 持久化必需）
```bash
export LASSO_DEV_ID='Developer ID Application: Your Name (TEAMID)'
./build/sign.sh
```

---

## TCC 持久化原理（开发者必读）

macOS 的 TCC.db（系统隐私授权数据库）用 **binary signature 的 cdhash** 做应用身份标识，而不是路径或文件名。

| 状态 | 行为 |
|---|---|
| 未签 binary | 每次 `cargo build` 后 cdhash 变化 → TCC.db 里的授权记录对新 cdhash 失效 → **每次重弹 Accessibility 授权框** |
| Developer ID 签名 binary | cdhash 在同一 Developer ID 下稳定 → TCC 授权**持久化**（仍需首次手动授权一次） |
| Hardened Runtime（`--options runtime`） | Apple notarization 的前置条件；本 helper 已带（无害） |
| Notarization（macOS 10.15+ 推荐） | 上传 Apple 服务器扫描通过后 Gatekeeper 不弹「未识别开发者」警告。**v0.3.5 不强制做**（sign.sh 注释里有命令模板） |

### 为什么必须 $99/年 Apple Developer 账号

ad-hoc 签名（`codesign -s -`）也可以让 cdhash 稳定，但 macOS 只对 **Developer ID Application** 签名的 binary 在 TCC 重启后持久保留授权（系统对 ad-hoc 签名的 TCC 行为不一致，且跨用户/跨机器会失效）。Apple Developer Program 年费 $99 是 macOS 桌面控制的不可避免成本。**没有这个账号 → Lasso desktop 通道在每次 helper rebuild 后都会要求用户重新授权 Accessibility**，开发体验极差。

---

## 首次授权流程

1. `./build/sign.sh`（用 Developer ID 签名）
2. 双击运行 `lasso-rust-helper` 一次（让 macOS 注册 binary 身份）
3. System Settings → Privacy & Security → **Accessibility** → 添加 `lasso-rust-helper`
4. （仅 screenshot 需要）System Settings → Privacy & Security → **Screen Recording** → 添加 `lasso-rust-helper`
5. 跑 `desktop(action:"doctor")` 验证 6 项 check 全 pass

---

## 协议（JSON-lines over stdio）

每行一个 JSON 对象，`\n` 分隔。**没有 Content-Length framing**（与 MCP JSON-RPC 隔离，让 SubprocessManager 同时管两种协议时不混淆 — INV-7）。

**Request** (TS → Rust):
```json
{"id":"uuid-abc","method":"ax_snapshot","params":{"app":"Finder","max_depth":3}}
```

**Response** (Rust → TS):
```json
{"id":"uuid-abc","ok":true,"result":{"role":"application","label":"Finder",...}}
```

失败：
```json
{"id":"uuid-abc","ok":false,"error":"resolve_root failed","error_kind":"tcc_denied"}
```

支持的 method（Phase A M0.5a 范围）：
- `ping` — 健康检查 + 版本 + TCC 快照
- `tcc_status` — 单独取 `{accessibility, screen_recording}`
- `ax_snapshot` — 递归 walk AX tree（max_depth 默认 8）
- `ax_find` — 在 snapshot 内按 text/role 过滤
- `ax_act` — **Phase A 占位**，Phase B（M0.5b）落地 AXPress/AXSetValue
- `screenshot` — CGWindowListCreateImage + PNG base64

错误种类（`error_kind`）：
- `parse_error` — JSON 解析失败
- `unknown_method` — 未识别 method
- `not_macos` — 非 macOS 调用 ax_*/screenshot
- `tcc_denied` — Accessibility 未授权
- `tcc_screen_recording_denied` — Screen Recording 未授权
- `app_not_found` — `app` 指定的 bundle id 未运行
- `ax_unavailable` — AX 调用 generic 失败
- `not_implemented` — Phase A 占位动作（如 `ax_act`）

stderr 走 `eprintln!` 诊断（不进协议；doctor 可读最近 N 行）。

---

## accessibility 0.2 API 决策（parse4 §4.1 实证）

通过 `examples/smoke_api.rs` 经验性验证：

| 路径 | API |
|---|---|
| TCC 探测 | `accessibility_sys::AXIsProcessTrustedWithOptions(NULL)`（FFI；NULL options 不弹框） |
| system-wide root | `AXUIElement::system_wide()`（safe wrapper，无需手动 retain/release） |
| 按 bundle id 找 app | `AXUIElement::application_with_bundle("com.apple.finder")`（safe wrapper 内部走 NSWorkspace + objc，无需自写 NSWorkspace 代码） |
| typed 属性（role/title/enabled/focused/children） | safe `.attribute::<T>(&AXAttribute::T())` via `AXUIElementAttributes` trait |
| children attribute | 返回 `CFArray<AXUIElement>`（**非 Vec**；首编译错误证明） |
| AXPosition/AXSize | 不在 safe trait；FFI `AXUIElementCopyAttributeValue` 取 AXValueRef + `AXValueGetValue(value, kAXValueTypeCGPoint=1, &CGPoint)` 解 CGPoint（CGSize=2） |
| 批读 AXUIElementCopyMultipleAttributeValues | FFI 符号可达但解析 CFArray<CFType> 复杂（每值手动 CFTypeID 判断） → **Phase A 降级为逐属性读**（parse4 §4.1 明示允许；正确性 > 10x perf） |

Phase D 若 M0.5a 验收第 4 条（≤30ms）不达标，再加批读优化。

---

## CI 策略

**CI 在 Linux 上不跑 desktop 集成测**（无 macOS framework + 无 codesign + 无 TCC）。

跑的：
- `cargo build` Linux 编译（验证非 macOS 分支的 cfg-not-macos 路径不挂）
- `cargo test --test protocol --test ax_role_map` 平台无关单测

不跑的：
- `ax.rs` / `tcc.rs` / `screenshot.rs` 的 macOS-only 代码（`#[cfg(target_os="macos")]`）
- 任何需要真实 TCC 授权的端到端测试（本地手动跑 + M0.5a 验收手测）

---

## 维护注意

- `cargo update` 需 review（parse4 §3.1.1）：accessibility / core-graphics / cocoa 任一 major bump 都要重跑 smoke_api + M0.5a 7 项验收
- `src/ax_role_map.rs` 与 `lasso/src/desktop/ax-role-map.ts` **必须同步修改**（双向镜像表）；CI grep 防漂移
- 协议字段（method/error_kind 集合）变化需同步 RustBridge.ts（TS 端）+ INV-7（不混淆 MCP JSON-RPC）
