# Lasso v0.3.5 DesktopChannel MVP 文件/函数级执行计划（parse4）

> 增量于 v0.3（545 tests + 15 invariants），落地 09 §2.4 + 13 §3 的 DesktopChannel MVP。本文档是开发者的「照着干」手册：每个文件、每个函数、每个签名都钉死，开发者（一人 Rust/Tauri 背景）无需再做架构决策。
>
> 权威源（绝对路径）：
> - 排期：`/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.4
> - 设计：`/Users/wangdong/Documents/Project/cc-control-all/doc/13-全交互抓手重设计.md` §2-§3
> - 现状代码：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/`

---

## 1. v0.3.5 目标与范围

### 1.1 能力目标（一句话）

CC 通过 Lasso 这唯一一个 MCP，操控 macOS 原生应用（Finder/Mail/Safari/Notes/System Settings 等）；AXAPI 语义优先，canvas/Metal 无 AX 元素时 screenshotVlm 兜底。

### 1.2 范围矩阵（做/不做）

| 维度 | v0.3.5 做 | v0.3.5 不做（推迟版本） |
|---|---|---|
| Providers | axProvider + screenshotVlm stub | appleScript（v0.4+）、cgEvent（v0.4+） |
| Tools | 单 `desktop(action, options)` 工具，action ∈ {snapshot, find, act, wait, screenshot, doctor} | 拆 6 工具（13 §2.1 已锁单工具）；`interact_roots`（v0.6+） |
| 平台 | macOS（`MacAxBackend`） | Windows UIA / Linux AT-SPI（v0.9.5+） |
| Helper 语言 | Rust（accessibility/appkit/core-graphics crate） | Swift helper（v1 永不做，F3.10.13） |
| Fallback | ax → screenshotVlm（同走 `FallbackDecider`，2 档；其余 2 档 v0.4+ 补） | 不开第二套 fallback engine（R-CI-02） |
| TCC | Rust helper 签 Developer ID + `desktop_doctor` 引导 | 自动授 TCC、Keychain 凭据读取（边界，F3.10.11） |
| 协议 | Rust helper stdin/stdout JSON-lines | MCP JSON-RPC（Rust helper 不走 SDK） |
| 跨 surface | desktop fallback 仅在 desktop 内（INV-23 红线） | desktop → browse 跨 surface（永远不） |

### 1.3 内部子里程碑（不单独发版，09 §2.4 + 13 §2.2）

- **M0.5a Observe-Only**：`desktop_snapshot` + `desktop_find` + `desktop(action:"doctor")` 3 action 可调；axProvider 跑通；TCC 流程跑通；INV-16..23 全部绿。**Go/No-Go 点**：AX→OutlineNode 覆盖率 ≥80% 或抽象破裂 → 暂停 v0.3.5。
- **M0.5b Act + screenshotVlm**：`desktop_act` + `desktop_wait` + `desktop_screenshot` 3 action 可调；screenshotVlm 接入 media-gen-mcp vlm provider（可选，配 LASSO_VLM_ENDPOINT）；fallback 链 ax→screenshotVlm 跑通；85% 操作成功率验收。

### 1.4 守住的 v0.3 不变量（零回归承诺）

- v0.3 的 545 tests 全绿（desktop 测试加在 `test/unit/desktop-*.spec.ts` + `test/integration/desktop-*.spec.ts`，**不动**现有测试文件）
- 既有 INV-1..15 全部保持绿（INV-8 改写为 INV-23，语义从「禁止 DesktopChannel 类存在」收紧为「fallback 链不跨 surface」）
- 新增 INV-16..23（F3.9.9 (a)-(h) 的可执行断言形式），共 23 条 invariants

---

## 2. 文件结构（lasso/ 下 TS 层 + lasso/rust-helper/ 下 Rust 层）

### 2.1 新增/修改 TS 文件（lasso/src/）

```
src/
├── types.ts                              [修改] 加 OutcomeTri-state 字段不变；新增 NOTHING（v0.3.5 复用现有类型）
├── desktop/                              [NEW 目录]
│   ├── desktop-types.ts                  [NEW] DesktopOptions/UiAction/OutlineNode/OutlineSnapshot/DesktopResult/DesktopHealth
│   ├── AxBackend.ts                      [NEW] interface AxBackend + MacAxBackend 注释（v0.9.5 加 WinUiaBackend/LinuxAtspiBackend）
│   ├── AxProvider.ts                     [NEW] class AxProvider（v0.3.5 唯一 provider，经 RustBridge 调 helper）
│   ├── ScreenshotVlmProvider.ts          [NEW] class ScreenshotVlmProvider（v0.3.5 stub + LASSO_VLM_ENDPOINT 可选）
│   ├── OutlineMapper.ts                  [NEW] AX tree → OutlineNode 标准化映射 + pictureOnly 标记
│   ├── ax-role-map.ts                    [NEW] AXRole → unified role const table（"AXButton" → "button" 等）
│   └── desktop-doctor-checks.ts          [NEW] 6 项 desktop check（被 doctor.ts 调用，不直接注册 tool）
├── channels/
│   ├── DesktopChannel.ts                 [NEW] extends UiChannel，7 契约方法 + providers 数组
│   └── UiChannel.ts                      [不动] 仍为空占位（02 简单性铁律：不为未实装的加抽象方法）
├── subprocess/
│   ├── SubprocessManager.ts              [修改] 加 ensureRustRunning() + RustProc 追踪 + shutdown 收尾；不动 MCP 路径
│   └── RustBridge.ts                     [NEW] JSON-lines 协议适配器（独立于 McpClient；调 child_process.spawn）
├── tools/
│   ├── desktop.ts                        [NEW] registerDesktopTool（action-enum 折叠，单 server.tool 注册）
│   ├── annotations.ts                    [修改] 加 desktopAnnotations（readOnly=false, openWorld=false）
│   └── descriptions.ts                   [修改] 加 DESKTOP_DESCRIPTION（路由 [Prefer desktop over browse_*] 提示）
├── doctor/
│   └── doctor.ts                         [修改] 加 6 项 desktop check（#15-#20）
├── invariants/
│   └── check-invariants.mjs              [修改] 改写 INV-8 → INV-23；新增 INV-16..22（F3.9.9 (a)-(h) 可执行版）
├── config/
│   └── providers.ts                      [修改] 加 DESKTOP_AX + DESKTOP_VLM 两条 ProviderConfig（tags:["desktop"]）
└── index.ts                              [修改] 装配 DesktopChannel + registerDesktopTool + subproc.ensureRustRunning
```

### 2.2 新增 Rust 层（lasso/rust-helper/）

```
rust-helper/
├── Cargo.toml                            [NEW] accessibility/appkit/core-graphics/serde/serde_json crate
├── src/
│   ├── main.rs                           [NEW] stdin/stdout JSON-lines 事件循环 + dispatch by method
│   ├── protocol.rs                       [NEW] Request/Response serde 类型（id/method/params/ok/result/error_kind）
│   ├── ax.rs                             [NEW] AXAPI walk + AXUIElementCopyMultipleAttributeValues 批读 6 属性
│   ├── screenshot.rs                     [NEW] CGWindowListCreateImage 抓指定 window/region PNG
│   ├── tcc.rs                            [NEW] AXIsProcessTrustedWithOptions + CGPreflightScreenCaptureAccess 探测
│   └── ax_role_map.rs                    [NEW] AXRole 标准化表（与 TS 端 ax-role-map.ts 镜像）
├── build/
│   └── sign.sh                           [NEW] cargo build --release + codesign Developer ID 脚本
├── Cargo.lock                            [生成] 锁 crate 版本（CI 不跑 desktop，本地稳定）
└── README.md                             [NEW] 构建/签名/TCC 授权说明（开发者必读）
```

### 2.3 文件依赖图（自顶向下）

```
index.ts
  ├─→ SubprocessManager (扩 ensureRustRunning)
  │     └─→ RustBridge.spawn (新)  ──→ rust-helper binary
  ├─→ DesktopChannel (new)
  │     ├─→ AxProvider (new)
  │     │     ├─→ RustBridge.call("ax_snapshot")
  │     │     └─→ OutlineMapper.axTreeToOutline (new)
  │     ├─→ ScreenshotVlmProvider (new, stub-or-vlm)
  │     │     ├─→ RustBridge.call("screenshot")
  │     │     └─→ (可选) McpClient.connectHttp(LASSO_VLM_ENDPOINT) 调 media-gen-mcp
  │     ├─→ FallbackDecider (复用 v0.3 不动)
  │     │     └─→ FallbackPlan { primary:"desktop.ax", fallbacks:["desktop.screenshotVlm"], cross_modal:false }
  │     └─→ UiChannel/BaseChannel (复用，extends)
  ├─→ registerDesktopTool(server, desktop, decider)
  │     └─→ server.tool("desktop", DESKTOP_DESCRIPTION, desktopSchema, desktopAnnotations)
  └─→ runDoctor (扩 6 项 desktop check)
```

---

## 3. 各模块实施细节

### 3.1 Rust helper（lasso/rust-helper/）

#### 3.1.1 Cargo.toml

```toml
[package]
name = "lasso-rust-helper"
version = "0.1.0"
edition = "2021"

[dependencies]
accessibility = "0.2"        # AXAPI 绑定（andrewhickman/accessibility-rs）
appkit = "0.6"               # NSApplication / NSWorkspace（查 frontmost app）
core-graphics = "0.24"       # CGWindowListCreateImage（screenshotVlm）
core-foundation = "0.10"     # CFString/CFArray 底层
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }

[profile.release]
opt-level = 3
lto = "thin"
```

> v0.3.5 **不引入** `osakit`（appleScript v0.4+ 才用）、`libc`（除非 CGEvent 需要，v0.4+）。crate 版本由 Cargo.lock 锁，README 注明「`cargo update` 需 review」。

#### 3.1.2 src/protocol.rs（JSON-lines 协议类型）

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct Request {
    pub id: String,             // UUID，原样回写
    pub method: String,         // "ping"|"ax_snapshot"|"ax_find"|"ax_act"|"screenshot"|"tcc_status"
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Serialize)]
pub struct Response {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,  // "tcc_denied"|"ax_unavailable"|"app_not_found"|...
}

impl Response {
    pub fn ok(id: &str, result: serde_json::Value) -> Self { /* ... */ }
    pub fn err(id: &str, kind: &str, msg: &str) -> Self { /* ... */ }
}
```

**协议铁律**：
- 一行一个 JSON 对象，`\n` 分隔；**不写 Content-Length 框架**（INV-7 衍生）
- 请求必有 `id`（UUID）；响应 `id` 必须匹配某条 in-flight 请求
- 仅 stdout 写 Response，仅 stdin 读 Request；stderr 走诊断日志（doctor 可读）
- 不主动写日志到 stderr（避免协议混淆）；用 `eprintln!` 仅诊断

#### 3.1.3 src/main.rs（事件循环）

```rust
use std::io::{self, BufRead, Write};
mod protocol;
mod ax;
mod screenshot;
mod tcc;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line { Ok(l) => l, Err(_) => continue };
        let req: protocol::Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let _ = writeln!(out, "{}", serde_json::to_string(
                    &protocol::Response::err("", "parse_error", &e.to_string())
                ).unwrap());
                continue;
            }
        };
        let resp = dispatch(&req);
        let _ = writeln!(out, "{}", serde_json::to_string(&resp).unwrap());
        let _ = out.flush();
    }
}

fn dispatch(req: &protocol::Request) -> protocol::Response {
    match req.method.as_str() {
        "ping"               => protocol::Response::ok(&req.id, serde_json::json!({
            "pong": true, "version": env!("CARGO_PKG_VERSION"),
            "tcc": tcc::snapshot(),
        })),
        "tcc_status"         => protocol::Response::ok(&req.id, serde_json::to_value(tcc::snapshot()).unwrap()),
        "ax_snapshot"        => ax::snapshot(&req.id, &req.params),
        "ax_find"            => ax::find(&req.id, &req.params),
        "ax_act"             => ax::act(&req.id, &req.params),
        "screenshot"         => screenshot::capture(&req.id, &req.params),
        _                    => protocol::Response::err(&req.id, "unknown_method", &req.method),
    }
}
```

#### 3.1.4 src/ax.rs（AXAPI 核心性能路径）

```rust
use accessibility::{AXUIElement, AXUIElementAttribute};
use accessibility_sys::{AXUIElementCopyMultipleAttributeValues, kAXChildrenAttributeName, /* ... */};
use core_foundation::{CFString, CFArray, CFBoolean};

const BATCH_ATTRS: &[&str] = &[
    "AXRole", "AXTitle", "AXPosition", "AXSize", "AXEnabled", "AXFocused",
];  // 批读 6 属性（desktop-pilot 20ms 快照的来源，F3.10.5）

pub fn snapshot(id: &str, params: &serde_json::Value) -> protocol::Response {
    let app_name = params.get("app").and_then(|v| v.as_str());
    let max_depth = params.get("max_depth").and_then(|v| v.as_u64()).unwrap_or(8) as usize;

    let root = match resolve_root(app_name) {
        Ok(el) => el,
        Err(kind) => return protocol::Response::err(id, &kind, "resolve_root failed"),
    };
    let tree = walk(&root, 0, max_depth);
    protocol::Response::ok(id, serde_json::to_value(&tree).unwrap())
}

/// 递归 walk，每节点用 AXUIElementCopyMultipleAttributeValues 一次读 6 属性。
/// 不批读（逐属性 AXUIElementCopyAttributeValue）→ 200ms+；批读 → 20ms（perf 关键）。
fn walk(el: &AXUIElement, depth: usize, max_depth: usize) -> AxNode {
    let attrs = batch_copy(el, BATCH_ATTRS);  // 一次系统调用取 6 属性
    let role  = attrs.get_string("AXRole").unwrap_or_default();
    let title = attrs.get_string("AXTitle").unwrap_or_default();
    let (x, y, w, h) = attrs.get_rect("AXPosition", "AXSize");
    let children = if depth < max_depth {
        attrs.get_children("AXChildren")
            .into_iter()
            .map(|c| walk(&c, depth + 1, max_depth))
            .collect()
    } else { vec![] };
    AxNode {
        role, title,
        rect: Rect { x, y, w, h },
        enabled: attrs.get_bool("AXEnabled").unwrap_or(true),
        focused: attrs.get_bool("AXFocused").unwrap_or(false),
        children,
    }
}

/// 调 AXUIElementCopyMultipleAttributeValues：CFArray of CFType 一次性返回。
/// 对应 TS 端 OutlineMapper.axTreeToOutline 把 AxNode 转 OutlineNode。
fn batch_copy(el: &AXUIElement, attrs: &[&str]) -> AttrBundle { /* ... */ }

fn resolve_root(app: Option<&str>) -> Result<AXUIElement, String> {
    // app=None → system-wide AXUIElementCreateSystemWide ()
    // app=Some(name) → AXUIElementCreateApplication(pid)（需 NSWorkspace 找 pid）
    // 未授 Accessibility → Err("tcc_denied")
    if !tcc::accessibility_granted() { return Err("tcc_denied".into()); }
    // ...
}
```

**关键 perf 实现点（必须做）**：
1. `AXUIElementCopyMultipleAttributeValues` 一次 CFArray 调用取 6 属性（不是 6 次单独 Copy）
2. `AXChildren` 递归时也走批读（depth 0 时只 root 一次）
3. `max_depth` 默认 8（与 DesktopOptions 一致），M0.5a 验收 ≥20 节点时 maxDepth=3
4. AX API 错误（`kAXErrorCannotComplete`）→ 返回 `error_kind: "tcc_denied"`；TS 端据此报 desktop_doctor

#### 3.1.5 src/screenshot.rs（screenshotVlm 数据源）

```rust
use core_graphics::display::{CGWindowListCreateImage, CGRect, CGDisplay, kCGWindowListOptionOnScreenOnly, kCGNullWindowID};

pub fn capture(id: &str, params: &serde_json::Value) -> protocol::Response {
    if !tcc::screen_recording_granted() {
        return protocol::Response::err(id, "tcc_screen_recording_denied", "Screen Recording 未授权");
    }
    let rect = parse_rect(params);
    let img = CGWindowListCreateImage(rect, kCGWindowListOptionOnScreenOnly, kCGNullWindowID, 0);
    let png = encode_png(&img);
    protocol::Response::ok(id, serde_json::json!({
        "format": "png",
        "width": img.width(), "height": img.height(),
        "base64": base64::encode(&png),
    }))
}
```

#### 3.1.6 src/tcc.rs（TCC 探测）

```rust
use accessibility_sys::AXIsProcessTrustedWithOptions;
use core_foundation::{CFString, CFDictionary, kCFBooleanTrue};

pub struct TccSnapshot {
    pub accessibility: bool,
    pub screen_recording: bool,
}

pub fn snapshot() -> TccSnapshot {
    TccSnapshot {
        accessibility: accessibility_granted(),
        screen_recording: screen_recording_granted(),
    }
}

pub fn accessibility_granted() -> bool {
    // AXIsProcessTrustedWithOptions(NULL) 不弹框
    unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) }
}

pub fn screen_recording_granted() -> bool {
    // CGPreflightScreenCaptureAccess() (macOS 10.15+)
    unsafe { core_graphics_sys::CGPreflightScreenCaptureAccess() }
}
```

#### 3.1.7 build/sign.sh（Developer ID 签名脚本）

```bash
#!/bin/bash
set -euo pipefail
set -x
cd "$(dirname "$0")/.."
cargo build --release

HELPER="target/release/lasso-rust-helper"
DEV_ID="${LASSO_DEV_ID:?must set LASSO_DEV_ID='Developer ID Application: Your Name (TEAMID)'}"

# 签名 + Hardened Runtime（TCC 持久化必要条件）
codesign --force --options runtime --timestamp --sign "$DEV_ID" "$HELPER"

# 验证
codesign -dvvv "$HELPER" 2>&1 | grep -E "Authority|TeamIdentifier|CodeDirectory"

# 可选 notarization（macOS 10.15+ 推荐）：
# xcrun notarytool submit "$HELPER".zip --apple-id ... --team-id ... --wait
echo "✅ signed: $HELPER"
```

**TCC 持久化原理**（README 必写）：未签名的二进制每次 rebuild 后 binary hash 变 → TCC.db 失效 → 重弹授权框；签名后 binary hash 稳定（同 Developer ID 下）→ TCC 授权持久。

---

### 3.2 DesktopChannel.ts（lasso/src/channels/DesktopChannel.ts）

#### 3.2.1 类骨架

```typescript
import { UiChannel } from "./UiChannel.js";
import type { AxProvider } from "../desktop/AxProvider.js";
import type { ScreenshotVlmProvider } from "../desktop/ScreenshotVlmProvider.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import type { CircuitBreaker } from "../fallback/CircuitBreaker.js";
import type {
  DesktopOptions, DesktopResult, OutlineSnapshot, Outcome, InteractResult,
  ChannelStatus, Health,
} from "../desktop/desktop-types.js";
import type { RustBridge } from "../subprocess/RustBridge.js";
import { logger } from "../util/logger.js";

/**
 * DesktopChannel（v0.3.5 DesktopChannel MVP，09 §2.4 + 13 §2.4）
 *
 * - extends UiChannel（与 BrowseChannel 平级兄弟，13 §2.4 R-CI-02）
 * - 4 providers（v0.3.5 只接 axProvider + screenshotVlm，appleScript/cgEvent v0.4+）
 * - 7 契约方法：isAvailable / status / healthCheck（继承自 BaseChannel）
 *               + observe / act / wait / capabilities（自身实装，非 abstract）
 *
 * INV-16（F3.9.9 a）: DesktopChannel 必须 extends UiChannel，本类用 `extends` 守。
 * INV-21（F3.9.9 f）: 本类不出现 AXUIElement/CGEvent 字符串（platform 字面量隔离在 Rust helper）。
 * INV-23（F3.9.9 h）: fallback plan 永远只列 desktop.* channels，绝不列 browse_*。
 */
export class DesktopChannel extends UiChannel {
  readonly name = "desktop";

  constructor(
    private readonly rust: RustBridge,
    private readonly axProvider: AxProvider,
    private readonly vlmProvider: ScreenshotVlmProvider,
    private readonly decider: FallbackDecider,
    private readonly breakers: Map<string, CircuitBreaker>,
  ) {
    super();
  }

  // ============================================================
  // BaseChannel 3 契约
  // ============================================================
  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.rust.call("ping", {});
      return r.ok === true;
    } catch { return false; }
  }

  async status(): Promise<ChannelStatus> {
    const t0 = Date.now();
    try {
      const r = await this.rust.call("ping", {});
      if (!r.ok) return { available: false, note: r.error ?? "rust_helper_error" };
      return {
        available: true,
        latency_ms: Date.now() - t0,
        note: JSON.stringify(r.result?.tcc ?? {}),
      };
    } catch (e) {
      return { available: false, note: String(e) };
    }
  }

  async healthCheck(): Promise<Health> {
    const s = await this.status();
    if (!s.available) return "down";
    if (s.latency_ms !== undefined && s.latency_ms > 2000) return "degraded";
    return "healthy";
  }

  // ============================================================
  // UiChannel 4 契约（v0.3.5 实装；非 abstract，因 UiChannel 仍是空占位）
  // ============================================================
  capabilities() {
    return {
      canObserve: true, canAct: true, observeLatencyMs: 30, needsForeground: false,
      dataModel: "ax" as const,  // 仅描述，不参与路由（13 §2.4）
    };
  }

  /** action=snapshot/find 主路径：直接 axProvider，不走 fallback decider。 */
  async observe(
    action: "snapshot" | "find",
    opts: DesktopOptions,
  ): Promise<InteractResult<OutlineSnapshot>> { /* ... */ }

  /** action=act 主路径：经 FallbackDecider.runWithFallback，plan = {primary:"desktop.ax", fallbacks:["desktop.screenshotVlm"], cross_modal:false}。 */
  async act(
    opts: DesktopOptions,
  ): Promise<InteractResult<DesktopResult>> { /* ... */ }

  /** action=wait：复用 axProvider observe + poll（与 BrowseChannel.runExpect 同范式）。 */
  async wait(
    opts: DesktopOptions,
    timeoutMs: number,
  ): Promise<"worked" | "didnt" | "unknown"> { /* ... */ }
}
```

#### 3.2.2 关键约束（02 简单性清单刻度自检）

| 刻度 | 守护 | 证据 |
|---|---|---|
| 交织度（Hickey） | 🟢 | DesktopChannel 无 AXUIElement/CGEvent 字符串（INV-21 grep 断言）；OutlineNode 无 `surface` 字段（INV-19） |
| 模块深度（Ousterhout） | 🟢 | 7 契约方法 + 4 自有方法（observe/act/wait/dispatch），构造参数 5 个（rust + ax + vlm + decider + breakers），AXAPI 细节下沉 Rust helper（depth 厚） |
| 变更放大率（Ousterhout） | 🟡 | 加新 desktop action = tool def + dispatch Map + 1 provider 方法（3 处，守 02 §4 阈值 ≤3） |
| 概念完整性（Brooks） | 🟢 | 同 FallbackDecider / 同 Outcome / 同 InteractResult 信封 / 同 ToolAnnotations 4 象限 |

#### 3.2.3 providers fallback 链（M0.5b 落地）

```typescript
// 同走 FallbackDecider（INV-18，F3.9.9 c）；不开第二套 fallback engine。
async act(opts: DesktopOptions): Promise<InteractResult<DesktopResult>> {
  const plan: FallbackPlan = {
    primary: "desktop.ax",
    fallbacks: ["desktop.screenshotVlm"],   // v0.4+ 加 "desktop.appleScript", "desktop.cgEvent"
    cross_modal: false,                      // INV-23: desktop fallback 永不跨 surface
  };
  return this.decider.runWithFallback(plan, async (name) => {
    if (name === "desktop.ax")          return this.axProvider.act(opts);
    if (name === "desktop.screenshotVlm") return this.vlmProvider.act(opts);
    throw new Error(`unknown_provider:${name}`);
  });
}
```

---

### 3.3 desktop tool 注册（lasso/src/tools/desktop.ts）

#### 3.3.1 单工具 action-enum 折叠（13 §3.3 / F3.10.x）

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DesktopChannel } from "../channels/DesktopChannel.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import { DESKTOP_DESCRIPTION } from "./descriptions.js";
import { desktopAnnotations } from "./annotations.js";

const desktopSchema = {
  action: z
    .enum(["snapshot", "find", "act", "wait", "screenshot", "doctor"])
    .default("snapshot"),
  options: z
    .object({
      app: z.string().optional(),                  // 目标 app（None = system-wide）
      state_id: z.string().optional(),             // find/act/wait 用
      max_depth: z.number().int().positive().max(20).default(8),
      actions: z.array(z.union([
        z.object({ kind: z.literal("click"),  ref: z.string() }),
        z.object({ kind: z.literal("type"),   ref: z.string(), text: z.string() }),
        z.object({ kind: z.literal("press"),  key: z.string() }),
        z.object({ kind: z.literal("scroll"), ref: z.string(), dx: z.number(), dy: z.number() }),
        z.object({ kind: z.literal("hotkey"), keys: z.array(z.string()) }),
      ])).optional(),
      expect: z.object({
        text: z.string().optional(),
        role: z.string().optional(),
        ref: z.string().optional(),
        gone: z.boolean().optional(),
        timeout_ms: z.number().int().positive().default(5000),
      }).optional(),
      where: z.object({                          // find 专用
        text: z.string().optional(),
        role: z.string().optional(),
        ref: z.string().optional(),
      }).optional(),
      screenshot_region: z.object({
        x: z.number(), y: z.number(), w: z.number(), h: z.number(),
      }).optional(),
      timeout_ms: z.number().int().positive().default(30000),
      picture_only: z.boolean().optional(),      // canvas/Metal 标记
    })
    .default({}),
};

export function registerDesktopTool(
  server: McpServer,
  desktop: DesktopChannel,
  decider: FallbackDecider,                // 注入但 observe/find 路径不 fallback
): void {
  server.tool(
    "desktop",
    DESKTOP_DESCRIPTION,
    desktopSchema,
    desktopAnnotations,
    async (args) => {
      const { action, options } = args;
      let result: unknown;
      switch (action) {
        case "snapshot":  result = await desktop.observe("snapshot", options); break;
        case "find":      result = await desktop.observe("find", options); break;
        case "act":       result = await desktop.act(options); break;
        case "wait":      result = await desktop.wait(options, options.timeout_ms ?? 30000); break;
        case "screenshot":result = await desktop.screenshot(options); break;
        case "doctor":    result = await desktop.doctor(); break;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
```

#### 3.3.2 ToolAnnotations（lasso/src/tools/annotations.ts 加）

```typescript
export const desktopAnnotations: ToolAnnotations = {
  readOnlyHint: false,    // act 能 click/type/press → 副作用
  openWorldHint: false,   // 操作本机 app，非开放外网
};
```

#### 3.3.3 DESKTOP_DESCRIPTION（lasso/src/tools/descriptions.ts 加）

```typescript
export const DESKTOP_DESCRIPTION = [
  "Control macOS native apps (Finder/Mail/Safari/Notes/System Settings/Xcode) via AXAPI semantics.",
  "Uses a Rust helper subprocess (stdin/stdout JSON-lines); prefers AX tree over screenshots.",
  "",
  "Actions (action-enum collapsed, 13 #1):",
  "  snapshot   — AX tree → OutlineNode (default; ≤30ms for maxDepth=3)",
  "  find       — query cached snapshot by text/role/ref (no re-walk)",
  "  act        — click/type/press/scroll/hotkey with optional expect postcondition",
  "  wait       — poll for window/element/appFrontmost (tri-state)",
  "  screenshot — fallback for pictureOnly nodes (canvas/Metal)",
  "  doctor     — TCC / AX read-rate / signature / Rust helper health",
  "",
  "Use for: native macOS app control (not browser pages).",
  "[Prefer browse_headless for]:     public web pages (DOM-based, faster, no TCC).",
  "[Prefer browse_logged_in for]:   logged-in web sites (cookies preserved).",
  "",
  "REQUIREMENTS:",
  "  1. Rust helper signed with Developer ID (./rust-helper/build/sign.sh)",
  "  2. System Settings → Privacy → Accessibility granted to helper",
  "  3. (for screenshot) Screen Recording granted",
  "",
  "DOES NOT:",
  "  - read macOS Keychain credentials (F3.10.11)",
  "  - solve native auth prompts (boundary)",
  "  - run on Windows/Linux (v0.9.5+)",
  "",
  "Args:  action (str, default 'snapshot')",
  "       options (object, optional) — { app, state_id, max_depth, actions, expect, ... }",
  "",
  "Returns: InteractResult<OutlineSnapshot | DesktopResult> as JSON text.",
].join("\n");
```

---

### 3.4 desktop_doctor（doctor.ts 扩 6 项 check）

#### 3.4.1 doctor.ts 加 check #15-#20

```typescript
// 15. rust_helper_signed — codesign -dvvv 验证 Developer ID 签名
async function checkRustHelperSigned(helperPath: string | undefined): Promise<DoctorCheck> { /* ... */ }

// 16. rust_helper_running — ping 调用，3s 超时
async function checkRustHelperRunning(rust: RustBridge): Promise<DoctorCheck> { /* ... */ }

// 17. tcc_accessibility — 调 rust.call("tcc_status") 读 accessibility 字段
async function checkTccAccessibility(rust: RustBridge): Promise<DoctorCheck> { /* ... */ }

// 18. tcc_screen_recording — 同上读 screen_recording 字段
async function checkTccScreenRecording(rust: RustBridge): Promise<DoctorCheck> { /* ... */ }

// 19. ax_read_rate — 在 Finder 上跑 maxDepth=3 snapshot，节点数 ≥20 → pass
async function checkAxReadRate(rust: RustBridge): Promise<DoctorCheck> { /* ... */ }

// 20. vlm_endpoint_reachable — 若 LASSO_VLM_ENDPOINT 配了，HEAD 探测
async function checkVlmEndpoint(endpoint: string | undefined): Promise<DoctorCheck> { /* ... */ }
```

> 每项 check 返回 `{ name, status: 'pass'|'fail'|'warn', detail, next_step? }`。TCC 未授权时 `next_step: "open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"`（13 §3.4 M0.5a 验收第 6 条）。

#### 3.4.2 desktop(action:"doctor") 通路

`desktop` 工具的 `action:"doctor"` 分支调 `runDoctor({ ...opts, desktopChecks: true })`，返回完整 20 项 readiness JSON。复用现有 `runDoctor` 不开第二套（R-CI-02）。

---

### 3.5 SubprocessManager 接入 Rust helper（lasso/src/subprocess/）

#### 3.5.1 关键约束：SubprocessManager 仍纯 lifecycle（INV-7）

13 §3.5 + 08 §3.5 铁律：**SubprocessManager 不解协议帧**。MCP JSON-RPC（chrome-devtools-mcp）和 JSON-lines（Rust helper）的协议差异下沉到各自的 Adapter：McpClient（既有）/ RustBridge（新）。

#### 3.5.2 扩 SubprocessManager（最小侵入）

```typescript
// SubprocessManager.ts 加：

export interface RustSpawnSpec {
  command: string;            // "lasso-rust-helper"（已 codesign 的 binary path）
  args?: string[];
  env?: Record<string, string>;
}

interface RustProc {
  proc: import("child_process").ChildProcess;
  spawnedAt: number;
  lastUsedAt: number;
  restartCount: number;
  closed: boolean;
}

export class SubprocessManager {
  // ... 既有 MCP 路径不动 ...
  private rustProcs = new Map<string, RustProc>();
  private rustSpecs = new Map<string, RustSpawnSpec>();

  registerRustSpec(name: string, spec: RustSpawnSpec): void {
    this.rustSpecs.set(name, spec);
  }

  /** 与 ensureRunning 同范式：懒启动 + 复用 + backoff 重启。 */
  async ensureRustRunning(name: string): Promise<import("child_process").ChildProcess> {
    const existing = this.rustProcs.get(name);
    if (existing && !existing.closed && existing.proc.pid !== undefined) {
      existing.lastUsedAt = Date.now();
      return existing.proc;
    }
    return this._spawnRustWithBackoff(name);
  }

  private async _spawnRustWithBackoff(name: string): Promise<ChildProcess> {
    // 复用 _spawnWithBackoff 同样的指数退避（1s/2s/4s/8s/16s，max 5 次）
    // 但用 child_process.spawn（不需 SDK transport）
  }

  // shutdown() 也要 join rustProcs 全 kill
}
```

#### 3.5.3 RustBridge.ts（JSON-lines 协议适配器，独立于 McpClient）

```typescript
import { randomUUID } from "node:crypto";
import type { SubprocessManager } from "./SubprocessManager.js";

interface PendingReq {
  resolve: (r: RustResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RustResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  error_kind?: string;
}

/**
 * Rust helper JSON-lines bridge（独立于 McpClient）。
 *
 * INV-7：SubprocessManager 仍纯 lifecycle；JSON-lines 协议帧解析（line split +
 * id 关联 + timeout）在本类内完成。
 *
 * 设计要点：
 *  - line-delimited JSON（每行一个完整 Response 对象；\n 分隔）
 *  - Promise-based request/response（id UUID 关联）
 *  - 30s 默认超时（ping 调用 3s，可在 call() override）
 *  - crash 检测：proc.on("exit") → 全部 pending reject
 */
export class RustBridge {
  private pending = new Map<string, PendingReq>();
  private buffer = "";                  // 半行累积（line buffer）
  private proc: import("child_process").ChildProcess | null = null;

  constructor(
    private readonly subproc: SubprocessManager,
    private readonly specName: string,   // "rust-helper"
  ) {}

  /** 懒启动 + 复用。首次调用时拉起子进程并接 line-data 事件。 */
  async ensureStarted(): Promise<void> {
    if (this.proc) return;
    this.proc = await this.subproc.ensureRustRunning(this.specName);
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", this.onData);
    this.proc.on("exit", this.onExit);
  }

  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<RustResponse> {
    await this.ensureStarted();
    const id = randomUUID();
    const req = JSON.stringify({ id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rust_call_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(req);
    });
  }

  private onData = (chunk: string) => {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.dispatch(line);
    }
  };

  private dispatch(line: string) {
    let resp: RustResponse;
    try { resp = JSON.parse(line); }
    catch { return; /* 协议错，忽略（不自爆） */ }
    const p = this.pending.get(resp.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(resp.id);
    p.resolve(resp);
  }

  private onExit = () => {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("rust_helper_crashed"));
    }
    this.pending.clear();
    this.proc = null;
  };
}
```

#### 3.5.4 协议差异表（MCP JSON-RPC vs JSON-lines）

| 维度 | MCP JSON-RPC（chrome-devtools-mcp） | JSON-lines（Rust helper） |
|---|---|---|
| 封装层 | `@modelcontextprotocol/sdk` Client + transport | 自写 RustBridge（line buffer + id 关联） |
| 帧 | Content-Length + JSON body（HTTP-like） | newline-delimited JSON（无 framing header） |
| 握手 | initialize → capabilities → initialized | 无握手，首条 Request 即处理 |
| 双向 | 双向（server 可发 notification） | 单向（仅 client→server Request + server→client Response） |
| lifecycle 拥有 | SubprocessManager.ensureRunning | SubprocessManager.ensureRustRunning |
| 协议帧解析 | SDK transport（INV-7 不在 SubprocessManager） | RustBridge（INV-7 同守，不在 SubprocessManager） |

---

## 4. 不明确点调研结论

### 4.1 Rust AXAPI 怎么调？

**结论**：用 `andrewhickman/accessibility-rs` crate（`accessibility = "0.2"`），不直接 link `ApplicationServices.framework`。

- 6 属性批读关键 API：`AXUIElementCopyMultipleAttributeValues(element, attrNames: CFArray, options, &result: CFArrayRef)` — 一次调用取所有属性，比逐个 `AXUIElementCopyAttributeValue` 快 10x（desktop-pilot 20ms vs 200ms 的来源）
- `AXUIElementCreateSystemWide()` / `AXUIElementCreateApplication(pid)` — root 元素工厂
- 通过 `appkit` crate 的 `NSWorkspace::runningApplications()` 找 app → pid
- TCC 探测用 `AXIsProcessTrustedWithOptions(NULL)`（不弹框版本）；Screen Recording 用 `CGPreflightScreenCaptureAccess()`（macOS 10.15+）
- 局限：`accessibility-rs` 的 children attribute 返回 `Vec<AXUIElement>`，需要自己写递归 walk；`AXMenuItem`/`AXMenuBar` 等特殊 role 走 1:1 映射表（ax-role-map.rs）

**未确认风险**（M0.5a 验证）：
- `AXUIElementCopyMultipleAttributeValues` 在 `accessibility-rs` 上是否暴露 high-level wrapper？若没有，需通过 `accessibility-sys` 直接 FFI。**实施前先写 1 个 smoke test 跑通这一条调用**。
- AXRole 标准化覆盖：M0.5a 采 10 个 native app 各 3 window 验证覆盖率 ≥80%（13 §3.4 M0.5a 第 3 条），不达标 → 加 `axRole?: string` 内部字段（仅 debug，不进 OutlineNode 接口）。

### 4.2 JSON-lines 协议怎么设计？

**结论**：newline-delimited JSON，Request `{id, method, params}` / Response `{id, ok, result?, error?, error_kind?}`。详见 §3.1.2。

**关键设计选择**：
- **无 Content-Length framing**（INV-7 衍生：与 MCP JSON-RPC 区分；SubprocessManager 不能混淆两种协议）
- **id = UUID**（不用自增 int，便于 RustBridge crash 后重启无状态冲突）
- **无 notification 反向通路**（Rust helper 不主动推消息；TS 端 polling）
- **stderr 仅供诊断**（doctor 可读最后 N 行；不参与协议）

### 4.3 AX tree → OutlineNode 怎么映射？

**结论**：用 ax-role-map.ts（TS 端）+ ax_role_map.rs（Rust 端）镜像表，1:1 标准化。映射发生在 Rust 端（性能：少传原始 AXRole 字符串），TS 端 OutlineMapper 只做 children 递归 + ref 分配。

```typescript
// lasso/src/desktop/ax-role-map.ts
export const AX_ROLE_MAP: Record<string, string> = {
  AXButton: "button",
  AXTextField: "textfield",
  AXTextArea: "textarea",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXPopUpButton: "select",
  AXMenu: "menu",
  AXMenuItem: "menuitem",
  AXMenuBar: "menubar",
  AXMenuBarItem: "menubaritem",
  AXWindow: "window",
  AXSheet: "dialog",           // modal sheet
  AXPopover: "popover",
  AXImage: "img",               // 若 size>100x100 且无 AXChildren → pictureOnly
  AXStaticText: "text",
  AXLink: "link",
  AXRow: "row",
  AXOutline: "tree",
  AXScrollArea: "scrollarea",
  AXTabGroup: "tablist",
  AXToolbar: "toolbar",
  AXGroup: "group",
  AXLayoutArea: "group",        // Xcode storyboard canvas
  AXUnknown: "unknown",         // canvas/Metal 候选
  // fallback
};

export function mapAxRole(ax: string): string {
  return AX_ROLE_MAP[ax] ?? "unknown";
}
```

**OutlineMapper.axTreeToOutline**：
```typescript
export function axTreeToOutline(
  root: AxNode,
  stateId: string,
): { refCounter: number; nodes: OutlineNode[] } {
  let refCounter = 0;
  const nodes: OutlineNode[] = [];
  const visit = (n: AxNode, depth: number): OutlineNode => {
    const ref = `@e${refCounter++}`;
    const role = mapAxRole(n.role);
    // pictureOnly 判定：AXImage size>100x100 无 children / AXUnknown size>100x100
    const pictureOnly = (role === "img" || role === "unknown")
      && n.rect.w > 100 && n.rect.h > 100
      && n.children.length === 0;
    const node: OutlineNode = {
      role, label: n.title, ref,
      rect: n.rect, pictureOnly,
      children: n.children.map(c => visit(c, depth + 1)),
    };
    nodes.push(node);
    return node;
  };
  visit(root, 0);
  return { refCounter, nodes };
}
```

### 4.4 pictureOnly 怎么标？

**结论**：3 启发式组合（M0.5a 验证 ≥80% 准确率）：
1. AXRole = "AXImage" 且 size > 100×100 且无 AXChildren → `pictureOnly: true`
2. AXRole = "AXUnknown"（canvas/Metal 候选） 且 size > 100×100 → `pictureOnly: true`
3. AXRole = "AXLayoutArea"（Xcode storyboard 等）且 label 为空 → `pictureOnly: true`

`pictureOnly` 节点的语义动作（click/type）不能 target；`desktop_act` 遇 pictureOnly ref → outcome="didnt" + error="picture_only_node"；`desktop_screenshot` 是唯一可用动作。

### 4.5 TCC 签名怎么做？

**结论**：cargo build + codesign Developer ID + Hardened Runtime。详见 §3.1.7 build/sign.sh。

**关键事实**（README 必写）：
- TCC.db 用 binary signature（codesign 留下的 cdhash）做应用身份；未签 binary 的 cdhash 每次 rebuild 变 → 每次重弹
- Developer ID Application 签名后 cdhash 稳定 → TCC 授权持久（但仍需首次手动授权）
- Hardened Runtime（`--options runtime`）是 notarization 的前置；v0.3.5 不强制 notarize，但 `--options runtime` 加上无害
- 用户需自行申请 Apple Developer 账号（$99/年）— 这是 macOS 桌面控制的不可避免成本
- **CI 不跑 desktop 集成测试**（无 codesign + TCC）— 只跑 Rust 单测 + TS mock 测试

---

## 5. 测试计划

### 5.1 Rust helper 单测（lasso/rust-helper/tests/）

```
tests/
├── protocol.rs         # Request/Response serde round-trip
├── ax_role_map.rs      # AXRole → unified role 映射表全覆盖
├── tcc.rs              # mock AXIsProcessTrustedWithOptions（returns true/false）
└── ax_walk.rs          # mock AXUIElement 树（递归 + 批读 6 属性）
```

- 协议层测试：`cargo test` 在 Linux 也能跑（不依赖 macOS framework）
- AXAPI 层测试：仅 macOS 本地跑（`#[cfg(target_os = "macos")]`）；CI 跳过

### 5.2 TS 集成测（lasso/test/unit/ + test/integration/）

```
test/unit/
├── outline-mapper.spec.ts        # AX tree → OutlineNode 映射（含 pictureOnly）
├── ax-role-map.spec.ts           # AX role 映射表全覆盖
├── rust-bridge.spec.ts           # mock stdin/stdout JSON-lines 协议解析
├── desktop-channel.spec.ts       # mock AxProvider + VlmProvider，验证 fallback
└── desktop-options.spec.ts       # DesktopOptions schema validation

test/integration/
└── desktop-action-enum.spec.ts   # 全 action 路径（snapshot/find/act/wait/screenshot/doctor）
                                  # 用 mock RustBridge，不依赖真实 macOS
```

### 5.3 mock AX 策略

```typescript
// lasso/test/unit/mocks/mock-rust-bridge.ts
export class MockRustBridge {
  constructor(private readonly scripts: Record<string, (params: unknown) => unknown>) {}
  async call(method: string, params: unknown): Promise<RustResponse> {
    const fn = this.scripts[method];
    if (!fn) return { id: "test", ok: false, error: `unscripted:${method}` };
    return { id: "test", ok: true, result: fn(params) };
  }
}

// 测试用例：Finder snapshot
new MockRustBridge({
  ping: () => ({ pong: true, version: "0.1.0", tcc: { accessibility: true, screen_recording: false } }),
  ax_snapshot: (p) => mockFinderTree(p.max_depth ?? 8),  // 返回 AX tree fixture
  tcc_status: () => ({ accessibility: true, screen_recording: false }),
});
```

### 5.4 不破坏 v0.3 的 545 tests

- 现有 `test/unit/*.spec.ts` 和 `test/integration/*.spec.ts` 全部保持绿
- 新增 desktop 测试加在新文件，不动既有文件
- INV-8 改写为 INV-23 后，既有 INV-1..7, 9..15 全部保持语义；INV-8 旧 ID 不复用
- `npm test` 同时跑 vitest + check-invariants.mjs（既有 npm script 不动）

---

## 6. 验收标准（引用 09 §2.4 的 7 条 + 13 §3.4 细化）

### 6.1 M0.5a Observe-Only（7 条）

| # | 验收项 | 来源 | 怎么验 |
|---|---|---|---|
| 1 | `desktop(action:"snapshot", options:{app:"Finder"})` 返回 stateId + outline 树（maxDepth=3 时节点数 ≥20） | 13 §3.4 M0.5a | 手测 Finder + Mail + Notes |
| 2 | `desktop(action:"find", options:{state_id, where:{text:"新建文件夹"}})` 在 Finder 快照中正确返回 @eN 或 [] | 13 §3.4 M0.5a | 手测 + 单测 |
| 3 | AX→OutlineNode 映射覆盖率 ≥80%（采样 10 个常见 native app） | 13 §3.4 M0.5a | `node scripts/ax-coverage.mjs` 抽样脚本 |
| 4 | `desktop(action:"snapshot")` 中位延迟 ≤30ms（maxDepth=3） | 13 §3.4 M0.5a | bench 脚本 50 次 sample 取 p50 |
| 5 | `desktop(action:"doctor")` 检查 ≥6 项（AX 授权 / Screen Recording / Rust helper / Developer ID / AX 可读率 / media-gen-mcp vlm 可达性），返回结构化 JSON + blockers + next_step | 13 §3.4 M0.5a + 09 §2.4 | 手测 |
| 6 | TCC 首次未授权引导：返回 `{readiness:"blocked", blockers:["tcc:accessibility"], next_step:"open x-apple.systempreferences:..."}` | 13 §3.4 M0.5a | 手测 revoke TCC 后调 doctor |
| 7 | Rust helper Developer ID 签名后 rebuild 不再重弹 TCC 授权弹窗 | 13 §3.4 M0.5a + 09 §2.4 | rebuild + re-run doctor |

**架构不变量**：INV-16(a)、INV-18(c)、INV-19(d)、INV-20(e)、INV-21(f) 全部通过（5/8）。

### 6.2 M0.5b Act + screenshotVlm Fallback（6 条）

| # | 验收项 | 来源 |
|---|---|---|
| 8 | `desktop(action:"act", options:{state_id, actions:[{kind:"click", ref:"@e3"}], expect:{...}})` 在 Mail 点击"新邮件"按钮 → outcome="worked" + actions_and_results 链 | 13 §3.4 M0.5b + 09 §2.4 |
| 9 | canvas/Metal app AX 完全无 element 时降级 screenshotVlm（若 LASSO_VLM_ENDPOINT 配）→ outcome="worked", fallback_used:"screenshotVlm"，节点标 pictureOnly:true | 13 §3.4 M0.5b |
| 10 | `desktop(action:"wait", options:{condition:{appFrontmost:"Mail"}, timeout_ms:3000})` 在 Mail 已前台时返 "preexisting"（tri-state 诚实报告） | 13 §3.4 M0.5b |
| 11 | 典型原生 app 操作成功率 ≥85%（采样 5 类各 10 次：Finder 新建文件夹 / Mail 发邮件 / Safari 打开书签 / 系统设置切换 WiFi / Notes 新建便签） | 13 §3.4 M0.5b + 09 §2.4 |
| 12 | 60s 短熔断：模拟 axProvider 连续失败 5 次，60s 内不再尝试 ax 档（复用 v0.3 CircuitBreaker） | 13 §3.4 M0.5b + 09 §2.4 |
| 13 | Argus 60min 长熔断：模拟 desktop 通道 1h 内 10 次失败，60min 内整个 desktop 通道熔断（**不 fallback 到 browse**，INV-23） | 13 §3.4 M0.5b + 09 §2.4 |

**架构不变量**：INV-16..23 全部 8 条通过（含 (b)(g)(h)）。

### 6.3 v0.3 零回归（强制）

- v0.3 的 545 tests 100% 绿
- INV-1..7, 9..15 全部保持绿（INV-8 改写为 INV-23）
- `npm test` + `npm run check-invariants` 两个命令都 exit 0

---

## 7. 风险 + 实施顺序

### 7.1 v0.3.5 风险 Register（13 §5.1 D1-D10 落地形态）

| ID | 风险 | v0.3.5 缓解 |
|---|---|---|
| D1 | AXRole 难映射到 DOM role | M0.5a 覆盖率抽测 <80% → 加 axRole? debug 字段（不进接口） |
| D2 | Rust helper 工时 | M0.5a 先 observe-only，smoke test 验证 `AXUIElementCopyMultipleAttributeValues` 通过再加 act |
| D3 | TCC 摩擦 | Developer ID 签名 + README 视频 + doctor 引导 |
| D4 | 双数据模型（DOM/AX）复杂度 | OutlineNode 统一形状 + INV-19/20/21 grep 断言 |
| D5 | macOS-only | `AxBackend` interface 隔离（v0.9.5 加 WinUiaBackend） |
| D6 | 4-tier fallback 实现负担 | v0.3.5 只做 axProvider + screenshotVlm stub（2/4 档）；appleScript/cgEvent v0.4+ |
| D7 | 变更放大率 ≥5 | 加新通道是稀有事件，固有成本接受；加新 action ≤3 处守 |
| D8 | AppleScript 注入 | v0.3.5 不接 appleScript → 风险不触发；INV-22 占位等 v0.4+ |
| D9 | Rust helper crash | 复用 SubprocessManager 指数退避重启 + RustBridge crash 检测（全部 pending reject） |
| D10 | screenshotVlm 跨 MCP 耦合 | LASSO_VLM_ENDPOINT 可选；未配时 fallback 返 didnt + error="vlm_unavailable"，不阻断 ax 路径 |

### 7.2 Go/No-Go 决策点（13 §5.2）

任一触发必须在 M0.5b 开始前评审：
1. M0.5a AX→OutlineNode 覆盖率 <80% → 暂停，回 08/13 重审抽象
2. INV-16..23 任意一项红 → CI 失败 → 不允许进 M0.5b
3. TCC 流程用户反馈"不可用" → 优先 doctor + 文档
4. Rust helper 工时超单人 8h/周 × 3 周 → 拆 M0.5b 到 v0.4 之后
5. 跨 surface fallback 出现 → 立即停止（INV-23 红线）

### 7.3 推荐实施顺序（M0.5a → M0.5b）

```
M0.5a Observe-Only（建议 5-7 天单人）:
  Day 1-2: Cargo.toml + main.rs + protocol.rs + ping/tcc_status method（验证 stdin/stdout 闭环）
  Day 2-3: ax.rs smoke test（AXUIElementCopyMultipleAttributeValues 单调 Finder root）
  Day 3-4: walk 递归 + ax_role_map.rs + OutlineMapper.axTreeToOutline
  Day 4-5: SubprocessManager.ensureRustRunning + RustBridge + DesktopChannel.observe
  Day 5-6: registerDesktopTool + desktop(action:"snapshot"/"find"/"doctor") + doctor 加 6 项
  Day 6-7: INV-16..23 加 + 5 项 M0.5a 验收手测 + AX 覆盖率脚本

  ★ M0.5a Go/No-Go 评审 ★

M0.5b Act + screenshotVlm（建议 4-5 天单人）:
  Day 8-9: ax_act (AXPress/AXSetValue) + desktop(action:"act") + expect postcondition
  Day 10:  desktop(action:"wait") + tri-state poll
  Day 11:  screenshot.rs + screenshotVlmProvider（LASSO_VLM_ENDPOINT 可选）+ fallback 链 ax→vlm
  Day 12:  M0.5b 6 项验收 + 5 应用 × 10 次成功率采样
```

### 7.4 关键决策回顾（5 条）

1. **单工具 action-enum 折叠**（13 §3.3 / F3.10.x）：6 action 一工具，不铺开 6 个 server.tool 注册（13 审查 #1 必改）
2. **DesktopChannel extends UiChannel 而非 BrowseChannel**（13 §2.4 R-CI-02）：兄弟不是父子，避免 BaseChannel 被 AXAPI 污染（INV-21）
3. **Rust helper JSON-lines 而非 MCP JSON-RPC**（13 §2.2）：与 chrome-devtools-mcp 协议隔离；Rust 不引 MCP SDK，更轻；SubprocessManager 同时管两种 lifecycle（INV-7 不破）
4. **v0.3.5 只 axProvider + screenshotVlm**（09 §2.4 实现要点）：appleScript/cgEvent 推迟 v0.4+；screenshotVlm stub 可用（vlm endpoint 未配时返 didnt 不阻断）
5. **TCC 用 Developer ID 签名而非 ad-hoc 签名**（13 §3.4 / F3.10.7）：跨 rebuild 持久化；用户须有 Apple Developer 账号（$99/年），是 macOS 桌面控制的不可避免成本

---

## 总结

v0.3.5 在 v0.3 的 BaseChannel / FallbackDecider / StateStore / expect / doctor / 不变量测试地基上加 **1 个 channel + 1 个 Rust helper + 1 个 tool**，零回归承诺（545 tests + 15 invariants 不动，INV-8 改写 + 新增 INV-16..23）。Rust helper 契合用户 Rust/Tauri 背景，单文件单进程单协议（JSON-lines），CI 不跑（无 codesign + TCC）。M0.5a observe-only 先验证 OutlineNode 抽象同构（D1/D4 最大风险点），通过后 M0.5b 加 act + screenshotVlm（D6 分阶段降负担）。任一 Go/No-Go 触发有明确回退路径（暂停 v0.3.5，回 08/13 重审）。

**关键路径代码文件**（开发者照着写）：
- Rust 层：`/Users/wangdong/Documents/Project/cc-control-all/lasso/rust-helper/src/main.rs` + `ax.rs` + `protocol.rs` + `screenshot.rs` + `tcc.rs`
- TS 层：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/channels/DesktopChannel.ts` + `desktop/AxProvider.ts` + `desktop/OutlineMapper.ts` + `subprocess/RustBridge.ts` + `tools/desktop.ts`
- 协议：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/desktop/desktop-types.ts`（OutlineNode/UiAction/DesktopOptions/DesktopResult）+ `rust-helper/src/protocol.rs`（镜像）