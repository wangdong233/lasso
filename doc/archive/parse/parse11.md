# Lasso v1.0 功能分析师 parse11 —— 文件/函数级执行计划（稳定发布）

> 上游：[09 §2.11 v1.0](09-media-interact-实施排期.md) + [08 F3.10.9 跨平台 desktop platform 抽象 / F3.8.14 录制回放 / §5.4 测试策略 / §7.5 v1.0 稳定发布门槛](08-media-interact-功能架构.md) + [02 §5 R-CI-02 横切关注点变体 / §6.1 R-FF-01 分层方向 / §6.3 review 三问](../../架构想法/02_简单检查清单.md)。
> v0.9 基线：**59 invariants + 1271 TS + 144 Rust tests**（零回归承诺；新 INV 编号 ≥60）。
> 简单性守门：AxBackend 三平台同构 OutlineNode 契约（平台差异隔离在 backend 内部 → 新 INV-60/61）；录制回放回归复用 v0.9 RecordingStore（INV-57..59 衍生 → 新 INV-62/63）；release polish 复用既有 doctor 范式不开第二套 section（INV-47 衍生）。
> **macOS-only 现实红线**：本开发机 Darwin 21.6.0 Intel。Windows UIA + Linux AT-SPI **无法本机运行时验证**。v1.0 跨平台 desktop 的 Win/Linux backend 交付边界：① AxBackend 接口契约层落地（三平台同构，CI 可静态 + 形状测）② Rust 端 `cfg-gate` 实装（Windows target 编译 UIA / Linux target 编译 AT-SPI，本机 `cargo build --target x86_64-apple-darwin` 只编译 macOS 路径，跨平台 crate 经 target-specific dependencies 隔离）③ 纯数据/契约部分 CI 可测（OutlineNode 三平台同构单测），真实 UIA/AT-SPI 执行留 Windows/Linux 手测清单（parse11-acceptance.md）。**不伪造「已验证 Windows」**。

---

## 1. v1.0 目标与范围（v0.9 增量）

### 1.1 能力跃升（09 §2.11 原文）
**v0.9（已交付）**：多引擎兜底（search ≈永不失败；Bing + FallbackChain + wayback + RecordingStore 回放兜底）。
**v1.0（本 parse）**：从「macOS-only alpha」升到「生产可用稳定版」——desktop 跨平台契约落地（Win/Linux backend 编译可证、真机手测留清单）、search/browse 回归测试基线化（selector 改版自动检测从"建议"变"CI 守门"）、README/ARCHITECTURE 文档完整化（用户能自助安装/配置/排障）、version 1.0.0 去 `-dev`（npm 线首版稳定标签）。

### 1.2 范围矩阵（做 / 不做）

| 维度 | 做（v1.0） | 不做（推迟 / NO-GO） |
|---|---|---|
| **跨平台 desktop backend**（F3.10.9） | AxBackend 接口最终化；WinUiaBackend（windows-rs UI::UIAutomation 绑定）+ LinuxAtspiBackend（atspi crate via zbus） cfg-gate 实装；OutlineNode 三平台同构契约；AxBackendFactory 注册表 | **真实 Win/Linux 运行时验证**（NO-GO 本机，留手测清单）；Win/Linux 的 appleScript/cgEvent 档（NO-GO，那两档是 macOS 专属，Win/Linux fallback 链止于 screenshotVlm）；Linux Wayland vs X11 区分（推迟 v1.1+） |
| **录制回放回归**（F3.8.14） | RecordingStore 录制的 search/browse SERP 结果做回归基线；selector 改版检测从 v0.7 SerpHealthMonitor 的"实时告警"扩到"CI 跑历史 fixture 比对"；replay-baseline runner（npm script） | 录制 browse_logged_in 的真 cookie 场景（NO-GO，08 §5.1 cookie=身份不外传）；自动推送新 fixture 上游（推迟） |
| **用户手册** | README 扩完整使用文档（安装/配置/工具列表/隐私/故障排查 5 节）；ARCHITECTURE.md 新建（架构分层图 + data flow + 设计原则 + 边界）；doc/TROUBLESHOOTING.md（FAQ + 常见 error_kind 释义）；doc/SELECTOR-MAINTENANCE.md（selector 债维护手册） | 把 07/08/09/10/11/12/13 全翻成英文（NO-GO，用户手册中英双语精简版即可，深度调研文档保中文原貌）；API reference 自动生成（推迟 v1.1+，需 typedoc） |
| **跨平台 launcher**（09 §2.11） | Windows `.bat` / PowerShell + macOS/Linux bash 双 launcher；`lasso launch-chrome` 跨平台路径探测（macOS `/Applications/Google Chrome.app` / Linux `/usr/bin/google-chrome` / Windows `Program Files\Google\Chrome\`） | 自动安装 Chrome（NO-GO，守 opt-in 手动装）；Linux 包管理器分发（推迟 v1.1+） |
| **release polish** | version `1.0.0` 去 `-dev`；LASSO_VERSION 常量同步；doctor 加 #31 platform_backend / #32 recording_baseline_count；npm provenance（溯源元数据）；CI 矩阵扩 Ubuntu Linux（Rust helper 非 macOS 路径编译可证） | 单二进制打包（08 §5.3 推迟 v1.1+ 评估）；code signing Windows/Linux（推迟，macOS Developer ID 已守 v0.3.5） |
| **全量测试** | macOS 全量 1271 → ≈1400 TS（+~130 新测试，Win/Linux 契约层 + 录制回放回归 + launcher）；Rust 144 → ≈175（Win/Linux platform 模块 cfg-gate 单测）；故障注入扩 SERP 改版场景 | 性能 benchmark CI 化（推迟，需单独 bench CI job）；覆盖率阈值强制（推迟，先采集基线） |

### 1.3 macOS-only 现实约束（**诚实红线，不伪造**）

| 维度 | 本机可证 | 本机不可证（留手测） |
|---|---|---|
| **AxBackend 接口层**（src/desktop/AxBackend.ts） | ✅ TypeScript 编译；契约层单测（mock RustResponse 三平台同构）；INV-60/61 静态 grep | — |
| **WinUiaBackend Rust 实装**（rust-helper/src/uia.rs） | ✅ `cargo check --target x86_64-pc-windows-msvc`（交叉编译，crate 依赖经 target-specific dependencies 装入；CI Linux runner 跑 `cargo build --target` 验编译） | ❌ 真实 Windows UIA 树读取、AXPRESS 等效 Invoke；留 parse11-acceptance.md 手测清单 #W1-#W5 |
| **LinuxAtspiBackend Rust 实装**（rust-helper/src/atspi.rs） | ✅ `cargo check --target x86_64-unknown-linux-gnu`（同上）；CI Linux runner 直接 `cargo build --target x86_64-unknown-linux-gnu`（Linux 上能真编 + 单测跑 `#[cfg(target_os = "linux")]` 路径，但 CI 是 headless 无桌面 → 不能验真实 AT-SPI registry） | ❌ 真实 Linux GNOME/MATE 桌面 AT-SPI registry 读；留 parse11-acceptance.md 手测清单 #L1-#L5 |
| **cfg-gate 不破坏 macOS build** | ✅ macOS 本机 `cargo build && cargo test` 全过（144 → ≈160 Rust 测试零回归 + 新增非 macOS 路径编译验）；TS 端 `npm test && npm run check-invariants` 全过 | — |
| **OutlineNode 三平台同构** | ✅ 契约层单测（同 input RustResponse → 同 OutlineNode，三平台共享 OutlineMapper）；role-map 三平台合并表单测 | ❌ 真实 Win/Linux app 的 AX tree 形状与 macOS 是否语义对齐（如 Windows Button role 与 macOS AXButton role 是否都映射到 outline.role="button"）；留手测清单 #W6/#L6 |
| **录制回放回归** | ✅ v0.9 RecordingStore 录制的 fixture（如已落盘的 SERP 快照）做 baseline；replay-baseline runner 在 CI 跑 replay → 比对；selector 改版自动检测（注入 fixture，看 selector 命中率是否跌） | — |
| **launcher 跨平台** | ✅ macOS bash 路径本机测；Windows `.bat` + Linux bash 路径用 CI matrix 测（GitHub Actions windows-latest + ubuntu-latest runner） | ❌ 真用户 Windows/Linux 环境的 Chrome 路径 corner case（如 winget 装到非默认路径）；留手测清单 #W7/#L7 |

**承诺格式**：每个手测项在 parse11-acceptance.md 必带「pending-需要真 Windows/Linux 环境」标签，CI 不能 pass 这些项，只能 skip + 在 release notes 明确「Win/Linux backend 编译可证、真机执行待社区反馈」。

### 1.4 量化目标（验收锚点）
- v1.0 收尾 TS 行数 ≈ **1271 + ~1100**（≈ 2370；AxBackend ~250 + 录制回归 ~280 + launcher ~180 + doctor 扩 ~80 + 文档 ~310）
- Rust 行数 ≈ **144 tests + ~500 行**（uia.rs ~220 + atspi.rs ~200 + cfg-gate ~80；新增 ~30 单测）
- INV 总数 **59 → 65**（加 INV-60..65，全部为 v1.0 新加，不重写 v0.9 INV-54..59）
- CI 闸门：`npm run check-invariants` 报 **65 条全绿**；`npm test` 通过率 100%（v0.9 测试集零回归）；`cargo test` 全过；新增 `cargo check --target x86_64-pc-windows-msvc` + `cargo check --target x86_64-unknown-linux-gnu` 在 CI Linux runner 验跨平台编译
- doctor 30 → 32 项（加 #31 platform_backend_active / #32 recording_baseline_count）
- npm 发布 `lasso-mcp@1.0.0`（非 `-dev`）；README badge Status 从 WIP → stable-v1.0

---

## 2. 文件结构（lasso/src/ + rust-helper/ 改动；零回归 v0.9 的 1271 TS + 144 Rust + 59 invariants）

### 2.1 新增文件（lasso/src/，7 个；总 ≈ 760 行 TS）

```
src/
├── desktop/
│   ├── AxBackendFactory.ts            ★ 新（~110 行）三平台 backend 工厂 + 注册表（INV-60）
│   ├── outline-contract.spec.ts       ★ 新（~140 行）三平台 OutlineNode 同构契约单测（CI 跑）
│   └── platform-detect.ts             ★ 新（~70 行）macOS/Windows/Linux 检测（process.platform + os.version）
├── serp/
│   └── replay-baseline.ts             ★ 新（~180 行）录制回放回归 runner（CI + npm script）
├── launcher/
│   ├── launch-chrome.ts               ★ 新（~120 行）跨平台 Chrome 路径探测 + 启动
│   └── chrome-paths.ts                ★ 新（~80 行）三平台候选路径表 + XDG / Program Files 探测
├── ARCHITECTURE.md                    ★ 新（顶层，~310 行 markdown）架构分层 + data flow + 设计原则
└── (invariants 扩既有 check-invariants.mjs，无新文件)
```

### 2.2 新增文件（lasso/rust-helper/src/，2 个；总 ≈ 420 行 Rust）

```
rust-helper/src/
├── uia.rs                              ★ 新（~220 行）Windows UIA backend（cfg(target_os = "windows")；windows-rs 绑定）
└── atspi.rs                            ★ 新（~200 行）Linux AT-SPI backend（cfg(target_os = "linux")；atspi crate via zbus）
```

### 2.3 修改文件（lasso/src/ + rust-helper/，增量改动，v0.9 行为零差异）

| 文件 | 改动要点 | 行数增量 |
|---|---|---|
| `src/desktop/AxBackend.ts` | **AxBackendKind / AxBackendFactory 从占位类型 → 真实实装**：扩 `WinUiaBackend` / `LinuxAtspiBackend` interface 实现（TS 端是薄壳，真实平台逻辑在 rust-helper/uia.rs + atspi.rs）；INV-21 守：本文件仍不出现 UIAutomationClient / libatspi 字面量 | +~80 |
| `src/desktop/AxProvider.ts` | 构造接 `AxBackendFactory`（替换 v0.3.5 直接持 RustBridge）；按 `platform-detect.ts` 结果路由到对应 backend；AxProvider 业务逻辑零改（仍调 `backend.snapshot/find/act`） | +~40 |
| `src/subprocess/RustBridge.ts` | 扩 `specName` 概念：macOS spec=`lasso-rust-helper`（既有）；Windows spec 同名 binary（.exe）；Linux spec 同名；helper binary 三平台统一名 `lasso-rust-helper`（cross-compile target 决定后缀）；零运行时分支（只是注释 + INV-60 衍生） | +~15 |
| `src/doctor/doctor.ts` | 加 #31 platform_backend_active（当前 backend 是 mac/win_uia/linux_atspi 之一 + 是否经 factory 注册）+ #32 recording_baseline_count（RecordingStore 录制数 ≥0 + 警告阈值可选） | +~80 |
| `src/index.ts` | 装配段：实例化 AxBackendFactory + 注入 AxProvider；实例化 RecordingStore（v0.9 已存在但未全局装配，v1.0 接入 doctor #32）；launcher `lasso launch-chrome` 子命令注册 | +~50 |
| `src/cli.ts`（若存在；否则 index.ts 内 CLI dispatch） | 加 `lasso launch-chrome [--profile <name>]` 子命令入口；`lasso replay-baseline` 子命令（CI + 用户本地跑回归） | +~60 |
| `package.json` | `version: "0.9.0-dev"` → `"1.0.0"`；scripts 加 `replay-baseline` / `check-cross-compile`（cargo check 双 target）；`engines.node >=20` 不变；dependencies 不增（守 R-CI-02） | +~10 |
| `src/invariants/check-invariants.mjs` | 加 INV-60..65 共 6 条新 INV（不改 v0.9 INV-1..59） | +~160 |
| `rust-helper/Cargo.toml` | target-specific dependencies：`[target.'cfg(target_os = "windows")'.dependencies] windows = { version = "0.x", features = [...] }` / `[target.'cfg(target_os = "linux")'.dependencies] atspi = "0.x"` —— macOS build 不拉这两个 crate（守零回归） | +~20 |
| `rust-helper/src/main.rs` | dispatch! 加 `ax_snapshot`/`ax_find`/`ax_act` 在 Windows/Linux 路径下的 method 路由（`#[cfg(target_os = "windows")]` 调 uia::snapshot；`#[cfg(target_os = "linux")]` 调 atspi::snapshot）；macOS 路径零改 | +~30 |
| `README.md` | 扩完整使用文档（安装/配置/工具列表/隐私/故障排查 5 节；Status badge WIP → stable-v1.0） | +~280（覆盖重写，但保 user-first 语调） |

**总增量**：新增 ~760 行 TS + 420 行 Rust + 310 行 markdown + 修改 ~725 行 TS + 50 行 Rust + 280 行 markdown ≈ **~1540 行 TS/md + ~470 行 Rust + 160 行 INV 脚本**（落 §1.4 估算窗口内）。

### 2.4 Rust crate 依赖改动（target-specific，零影响 macOS build）

```toml
# rust-helper/Cargo.toml —— v1.0 新增 target-specific dependencies

# 既有 macOS dependencies 不动（accessibility / accessibility-sys / core-graphics 等）
# 用 target-specific 段隔离 Windows / Linux 专属 crate：

[target.'cfg(target_os = "windows")'.dependencies]
# 官方 microsoft/windows-rs（UI::UIAutomation 绑定；auto-generated from Win32 metadata）
# 选官方 windows crate 而非社区 uiautomation crate：microsoft 长期维护 + 完整覆盖
windows = { version = "0.59", features = [
  "Win32_Foundation",
  "Win32_UI_Accessibility",
  "Win32_UI_WindowsAndMessaging",
  "Win32_System_Com",
] }

[target.'cfg(target_os = "linux")'.dependencies]
# atspi crate：odilia-app/atspi（pure Rust via zbus D-Bus）
# 选 atspi 而非 at-spi2: atspi 是纯 Rust 无 C 依赖，CI Linux headless 可编
atspi = "0.22"
# zbus 是 atspi 的传递依赖，但显式声明稳定版本
zbus = "5"
```

**macOS build 影响**：`cargo build` 在 macOS target 下完全不解析这两段（cargo 的 target-specific 语义）→ macOS 依赖闭包不变 → v0.9 Rust 测试零回归可证。

---

## 3. 各模块实施细节（接口签名 + 伪码 + 借鉴源 + 行数估算）

### 3.1 跨平台 AxBackend（interface 最终化 + WinUiaBackend/LinuxAtspiBackend cfg-gate 实装；OutlineNode 契约三平台一致）

**借鉴源**：
- `src/desktop/AxBackend.ts` 行 46-59 既有 `AxBackend` interface（snapshot/find/act）—— **本接口零改，只是落地更多实现**
- `rust-helper/src/ax.rs` 行 78-91 `#[cfg(not(target_os = "macos"))]` fallback（返 `not_macos`）—— **复用 cfg-gate 范式 → INV-60**
- `rust-helper/src/tcc.rs` 行 28-52 cfg-gate 三段式（macOS 实装 + 非 macOS fallback）—— **三平台 backend 同结构**
- `rust-helper/src/app_bundle_map.rs`（精选人名→bundle 表，CI 可单测）—— **Win/Linux 复用：选 executable_name → window_class 精选表**

**关键决策（简单性 R-CI-02 + 02 §6.1 R-FF-01 分层方向）**：
- **不重写 AxBackend interface**。v0.3.5 已定义 snapshot/find/act 三方法 + 共享 RustResponse 出口；v1.0 只是加 backend 实现，不破 v0.3.5 契约（守 INV-21 平台字面量不进 TS 层）。
- **不在 TS 层做平台分支**。AxProvider 不 `if (platform === 'win32')`；而是 `AxBackendFactory.create()` 经 `platform-detect.ts` 路由到对应 backend class，每个 backend 内部调对应 rust method（`uia_snapshot` / `atspi_snapshot` / 既有 `ax_snapshot`）。AxProvider 业务逻辑（含 OutlineMapper 映射）三平台共享。
- **不渗 OutlineMapper 到 backend 内**。OutlineMapper 是业务层（rust-helper 返原始 AxNode → OutlineMapper 映射到统一 OutlineNode），三平台共享同一个 mapper（守 INV-21 衍生 INV-61：OutlineNode 契约单一 mapper）。Rust 端三平台都返同形 AxNode JSON（role/raw_role/label/rect/enabled/focused/depth/children/window_id），OutlineMapper 不感知平台。
- **不引 electron / tauri 的跨平台 AX 抽象**。它们抽象太厚（带 IPC / window management），Lasso 只需"读 AX 树 + act 节点"，薄壳足够（守 R-ABS-01 错误抽象警惕）。
- **Windows UIA 用官方 `windows` crate（windows-rs）而非社区 `uiautomation` crate**。微软长期维护 + auto-generated from Win32 metadata + 完整覆盖 UIA COM 接口；社区 crate API 更符合人体工学但维护风险高（02 §5 R-CI-02：横切关注点变体只允许一套，选官方降低长期维护负担）。
- **Linux AT-SPI 用 `atspi` crate（odilia-app）**。pure Rust via zbus D-Bus，无 C 依赖，CI Linux headless 可编（`cargo check --target x86_64-unknown-linux-gnu` 不需装 libatspi）；备选 `at-spi2` crate 是 C 绑定，CI 复杂度高，不选。

**接口签名（src/desktop/AxBackend.ts 改造）**：

```ts
// ============================================================
// AxBackend 接口（v0.3.5 已定义；v1.0 零改）
// ============================================================
export interface AxBackend {
  snapshot(app: string | undefined, maxDepth: number): Promise<RustResponse>;
  find(app: string | undefined, maxDepth: number, where: WhereClause): Promise<RustResponse>;
  act(actions: DesktopOptions["actions"]): Promise<RustResponse>;
}

// ============================================================
// AxBackendKind（v1.0 从占位 → 真实枚举）
// ============================================================
export type AxBackendKind = "mac" | "win_uia" | "linux_atspi";

// ============================================================
// MacAxBackend（v1.0 真实 class，v0.3.5 是注释占位）
// ============================================================
/**
 * macOS AXAPI backend（经 RustBridge.call("ax_snapshot")）。
 *
 * INV-21 衍生 INV-60：本类体内禁出现 AXUIElement / CGEvent 等平台字面量；
 *                     所有平台调用经 RustBridge。
 */
export class MacAxBackend implements AxBackend {
  constructor(private readonly rust: RustBridge) {}
  async snapshot(app: string | undefined, maxDepth: number): Promise<RustResponse> {
    return this.rust.call("ax_snapshot", { app, max_depth: maxDepth });
  }
  async find(app: string | undefined, maxDepth: number, where: WhereClause): Promise<RustResponse> {
    return this.rust.call("ax_find", { app, max_depth: maxDepth, where });
  }
  async act(actions: DesktopOptions["actions"]): Promise<RustResponse> {
    return this.rust.call("ax_act", { actions });
  }
}

// ============================================================
// WinUiaBackend（v1.0 新；Windows UI Automation 经 windows-rs）
// ============================================================
/**
 * Windows UIA backend（经 RustBridge.call("uia_snapshot")）。
 *
 * method 名前缀 uia_* 与 macOS ax_* 区分（Rust 端 dispatch 据方法名路由）。
 * INV-21 衍生：本类不出现 UIAutomationClient / IUIAutomation 字面量；
 *             真实 UIA COM 调用全在 rust-helper/src/uia.rs。
 */
export class WinUiaBackend implements AxBackend {
  constructor(private readonly rust: RustBridge) {}
  async snapshot(app: string | undefined, maxDepth: number): Promise<RustResponse> {
    return this.rust.call("uia_snapshot", { app, max_depth: maxDepth });
  }
  async find(app: string | undefined, maxDepth: number, where: WhereClause): Promise<RustResponse> {
    return this.rust.call("uia_find", { app, max_depth: maxDepth, where });
  }
  async act(actions: DesktopOptions["actions"]): Promise<RustResponse> {
    return this.rust.call("uia_act", { actions });
  }
}

// ============================================================
// LinuxAtspiBackend（v1.0 新；AT-SPI2 经 atspi crate）
// ============================================================
/**
 * Linux AT-SPI backend（经 RustBridge.call("atspi_snapshot")）。
 *
 * INV-21 衍生：本类不出现 Atspi / Accessible 字面量；
 *             真实 AT-SPI D-Bus 调用全在 rust-helper/src/atspi.rs。
 */
export class LinuxAtspiBackend implements AxBackend {
  constructor(private readonly rust: RustBridge) {}
  async snapshot(app: string | undefined, maxDepth: number): Promise<RustResponse> {
    return this.rust.call("atspi_snapshot", { app, max_depth: maxDepth });
  }
  async find(app: string | undefined, maxDepth: number, where: WhereClause): Promise<RustResponse> {
    return this.rust.call("atspi_find", { app, max_depth: maxDepth, where });
  }
  async act(actions: DesktopOptions["actions"]): Promise<RustResponse> {
    return this.rust.call("atspi_act", { actions });
  }
}
```

**接口签名（src/desktop/AxBackendFactory.ts 新建）**：

```ts
import process from "node:process";
import type { AxBackend, AxBackendKind } from "./AxBackend.js";
import { MacAxBackend, WinUiaBackend, LinuxAtspiBackend } from "./AxBackend.js";
import type { RustBridge } from "../subprocess/RustBridge.js";

/**
 * AxBackend 工厂（v1.0 F3.10.9 落地）。
 *
 * INV-60 衍生：本类是三平台 backend 注册的单一真源（grep AxBackendKind 字面量
 *             只在本文件 + AxBackend.ts）。
 *
 * 路由策略：
 *  - process.platform === "darwin"  → MacAxBackend
 *  - process.platform === "win32"   → WinUiaBackend
 *  - process.platform === "linux"   → LinuxAtspiBackend
 *  - 其他                            → 抛 unsupported_platform（不静默降级）
 *
 * INV-21 衍生 INV-60：本工厂不直接 import 平台 crate（那都在 Rust 端）；
 *                     本工厂只是 TS 端路由器。
 */
export class AxBackendFactory {
  static create(rust: RustBridge): AxBackend {
    const kind = this.detectKind();
    switch (kind) {
      case "mac":         return new MacAxBackend(rust);
      case "win_uia":     return new WinUiaBackend(rust);
      case "linux_atspi": return new LinuxAtspiBackend(rust);
    }
  }

  static detectKind(): AxBackendKind {
    switch (process.platform) {
      case "darwin": return "mac";
      case "win32":  return "win_uia";
      case "linux":  return "linux_atspi";
      default:       throw new Error(`unsupported_platform:${process.platform}`);
    }
  }
}
```

**Rust 端 cfg-gate 实装范式（rust-helper/src/uia.rs 新建，Windows 部分）**：

```rust
//! Windows UIA backend（v1.0 F3.10.9 跨平台 desktop）。
//!
//! 平台：cfg(target_os = "windows")；其他平台本文件不参与编译（main.rs 加 cfg-gate）。
//!
//! 实装策略（守 INV-21 + R-CI-02）：
//!  - 经官方 microsoft/windows-rs crate（Win32_UI_Accessibility feature）
//!  - CoCreateInstance(IUIAutomation) → root element → TreeWalker 深度遍历
//!  - 输出与 macOS ax.rs 同形 AxNode JSON（role 通过 ax_role_map.rs 三平台合并表统一）
//!  - 真实 UIA COM 调用 + AXPRESS 等效 Invoke 留手测清单（CI 只验编译 + 形状）

#[cfg(target_os = "windows")]
use crate::ax_role_map::map_ax_role;  // 三平台共享 role-map（INV-61）
#[cfg(target_os = "windows")]
use crate::protocol::Response;

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use windows::Win32::UI::Accessibility::*;
    use windows::Win32::System::Com::*;
    use windows::core::*;

    /// uia_snapshot 入口（与 ax.rs::snapshot 同形 AxNode 输出）。
    pub fn snapshot(id: &str, params: &serde_json::Value) -> Response {
        // 1. CoInitializeEx（多线程 apartment）
        // 2. CoCreateInstance(IUIAutomation) →iuia
        // 3. GetRootElement / GetFocusedElement / FindByProcessId(app) → root
        // 4. TreeWalker 深度遍历（Depth 限制 maxDepth）
        // 5. 每节点读 Name / ControlType / IsEnabled / HasKeyboardFocus / BoundingRectangle
        // 6. 映射 ControlType (UIA_ButtonTypeId) → unified role 经 map_ax_role
        // 7. 序列化 AxNode JSON（与 macOS 同形）
        // — 完整实装代码留 Phase A 实施期，本注释是 shape 锚点 —
        Response::err(id, "not_implemented", "uia_snapshot Phase A TBD")
    }

    pub fn find(id: &str, _params: &serde_json::Value) -> Response {
        Response::err(id, "not_implemented", "uia_find Phase A TBD")
    }

    pub fn act(id: &str, _params: &serde_json::Value) -> Response {
        Response::err(id, "not_implemented", "uia_act Phase A TBD")
    }
}

#[cfg(target_os = "windows")]
pub use platform::{act, find, snapshot};

#[cfg(not(target_os = "windows"))]
pub fn snapshot(id: &str, _params: &serde_json::Value) -> Response {
    Response::err(id, "not_windows", "uia_snapshot requires Windows")
}
// ... find / act 同形 cfg(not(target_os = "windows")) fallback
```

**Rust 端 main.rs dispatch 改造（cfg-gate 三平台路由）**：

```rust
fn dispatch(req: &protocol::Request) -> protocol::Response {
    match req.method.as_str() {
        // 既有 macOS 路径（不动）
        "ping" | "tcc_status" => /* ... */,
        "ax_snapshot" => ax::snapshot(&req.id, &req.params),      // macOS only
        "ax_find"     => ax::find(&req.id, &req.params),
        "ax_act"      => ax::act(&req.id, &req.params),
        // v1.0 新增：Windows UIA 路径
        "uia_snapshot" => uia::snapshot(&req.id, &req.params),    // cfg-gated
        "uia_find"     => uia::find(&req.id, &req.params),
        "uia_act"      => uia::act(&req.id, &req.params),
        // v1.0 新增：Linux AT-SPI 路径
        "atspi_snapshot" => atspi::snapshot(&req.id, &req.params),
        "atspi_find"     => atspi::find(&req.id, &req.params),
        "atspi_act"      => atspi::act(&req.id, &req.params),
        // 既有共享 method（三平台共用）
        "screenshot"   => screenshot::capture(&req.id, &req.params),
        "list_windows" => windows::list_windows(&req.id, &req.params),
        // ... 既有 applescript / cgevent method（macOS only，不动）
        other => /* unknown_method */,
    }
}
```

**OutlineNode 三平台同构契约（INV-61 核心）**：
- `rust-helper/src/ax_role_map.rs`（v0.3.5 已存在，macOS AXRole → unified role）→ v1.0 扩为三平台合并表：macOS `AXButton` / Windows `UIA_ButtonTypeId` (`50005`) / Linux `push button` (AT-SPI role) → 统一 `outline.role="button"`
- `src/desktop/OutlineMapper.ts`（v0.3.5 已存在）零改：仍读 `AxNode.role`（已映射）→ `OutlineNode`；三平台 Rust 端都输出同形 AxNode
- 契约单测 `src/desktop/outline-contract.spec.ts`：mock 三平台 AxNode JSON（保存在 test/fixtures/）→ OutlineMapper → 断言 OutlineNode 形状 byte-identical

### 3.2 录制回放回归（RecordingStore 基线 + 回归测试 runner + selector 改版检测）

**借鉴源**：
- `src/serp/RecordingStore.ts` 行 60-259（v0.9 已实装 save/load/replay/list）—— **复用全部 API**
- `src/serp/change-detection.ts`（v0.7 SerpHealthMonitor，运行时命中率告警）—— **复用 shape 比对范式**
- `src/serp/selectors.ts`（v0.1 selector 表）—— **基线数据源**

**关键决策（简单性 R-CI-02）**：
- **不重写 RecordingStore**。v0.9 已实装完整；v1.0 只是加一个**回归测试 runner**（`replay-baseline.ts`）消费 RecordingStore 的 fixture，作为 CI step 跑。
- **不自动生成新基线**。基线录制仍走 v0.9 INV-57 路径（`LASSO_RECORD_SEARCH=true` 显式 opt-in）；CI 不录制，只 replay 既有 fixture。
- **不扩 RecordingStore 到 browse_logged_in**。logged_in 的 SERP 抽取可能含 cookie/session 信息（URL 参数），录制落盘违 INV-51（cookie=身份）。replay-baseline 只覆盖 search + browse_headless 的 SERP 抽取。
- **selector 改版检测的 CI 化**：v0.7 SerpHealthMonitor 是**运行时**告警（命中率 <50% 触发）；v1.0 加 **CI 时**检测——replay 历史录制 → 用当前 selectors.ts 抽 → 比对录制时的结果数。若命中率 <80% → CI warning（不 fail，selector 是债不是 bug）。

**接口签名（src/serp/replay-baseline.ts 新建）**：

```ts
import { RecordingStore } from "./RecordingStore.js";
import { BAIDU_SELECTORS, GOOGLE_SELECTORS, extractSerp } from "./selectors.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * 录制回放回归 runner（v1.0 F3.8.14 CI 化）。
 *
 * 用法：
 *   npm run replay-baseline                    # 跑默认 fixtures/serp-baseline/
 *   npm run replay-baseline -- --strict        # 命中率 <80% 时 exit 1
 *   npm run replay-baseline -- --refresh       # 重新录制（需 LASSO_RECORD_SEARCH=true）
 *
 * 数据源：
 *   fixtures/serp-baseline/<engine>/<query-hash>.html  —— 录制时落盘的原始 SERP HTML
 *   fixtures/serp-baseline/<engine>/<query-hash>.json  —— 录制时的 expected 抽取结果
 *
 * 测试矩阵：
 *   - 百度 / Google / Bing 三 engine
 *   - 中文 query + 英文 query
 *   - 至少 10 条 fixture（首次实装时手动录制 + 签入仓库）
 *
 * 与 v0.7 SerpHealthMonitor 关系：
 *   - v0.7 是**运行时**命中率告警（生产环境真实 query 流）
 *   - v1.0 replay-baseline 是 **CI 时**回归（历史 query 固定基线）
 *   - 两者互补：CI 抓改版早信号（push 时就知道 selector 命中率跌了），
 *             运行时抓新 query 改版（CI 没见过的 query pattern）
 */
export interface BaselineResult {
  engine: string;
  query: string;
  expected_count: number;       // 录制时抽取的结果数
  actual_count: number;         // 当前 selectors.ts 抽的结果数
  hit_rate: number;             // actual / expected（0.0-1.0）
  status: "pass" | "warn" | "fail";
  first_diff?: string;          // 第一个 diff 的字段（debug 用）
}

export async function runReplayBaseline(opts: {
  fixturesDir: string;
  strict?: boolean;
}): Promise<{
  total: number;
  pass: number;
  warn: number;
  fail: number;
  results: BaselineResult[];
}> {
  const store = new RecordingStore(opts.fixturesDir, true /* enabledOverride */);
  const results: BaselineResult[] = [];

  // 扫 fixtures 目录
  // 对每条 fixture：
  //   1. load HTML（RecordingStore.load）
  //   2. 用当前 selectors.ts 抽（extractSerp）
  //   3. 比对录制时的 expected count（load .json sidecar）
  //   4. hit_rate = actual / expected
  //   5. status: hit_rate >= 0.8 → pass; >= 0.5 → warn; < 0.5 → fail
  // ... 完整实装留 Phase B 实施期 ...

  return { total: results.length, pass: 0, warn: 0, fail: 0, results };
}

// CLI 入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const strict = process.argv.includes("--strict");
  const fixturesDir = path.join(process.cwd(), "fixtures", "serp-baseline");
  runReplayBaseline({ fixturesDir, strict }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (strict && r.fail > 0) process.exit(1);
  });
}
```

**首次基线录制流程（开发者一次性，签入仓库）**：
1. 设 `LASSO_RECORD_SEARCH=true`
2. 跑 `npm run record-baseline -- --query "rust async" --engine baidu` 等（10 条 query × 3 engine = 30 fixture）
3. 关 `LASSO_RECORD_SEARCH`，commit `fixtures/serp-baseline/`
4. 后续 selector 改版时 CI 自动检测命中率跌

### 3.3 用户手册（README 完整化 + ARCHITECTURE.md + 工具清单 + 隐私 + 故障排查）

**借鉴源**：
- `media-gen-mcp/README.md`（v0.11.0 已发布，user-first 写法）—— **复用风格**
- `doc/08-media-interact-功能架构.md`（架构基线）—— **ARCHITECTURE.md 的上游**
- `doc/04-CC集成操作手册.md`（CC 集成步骤）—— **README 安装节上游**

**README v1.0 结构（覆盖重写，保 user-first 语调）**：

```markdown
# Lasso

> CC 的**全交互**对外抓手 MCP（浏览器 + 桌面）。牛仔套索，"套住任何界面"。

[![License: MIT](...)](LICENSE)
[![Status: stable](.../stable-v1.0-green)]()
[![npm version](.../lasso-mcp/v1.0.0)](...)

## 这是什么（30 秒读完）

Lasso 让 Claude Code 通过这唯一一个 MCP，高效和**浏览器 + 桌面**交互...
（保 v0.1 既有开头，扩 "v1.0 稳定版" + 三平台 desktop 支持）

## 四通道（能力导向）

| 工具 | 通道 | 后端 | 平台 |
|---|---|---|---|
| `search` | search | 智谱 / Brave / Bing / Wayback 多引擎 fallback | 跨平台 |
| `browse_headless` | browse | chrome-devtools-mcp --headless | 跨平台 |
| `browse_logged_in` | browse | chrome-devtools-mcp --browser-url :9222 | 跨平台 |
| `desktop` | desktop | macOS AXAPI / Windows UIA / Linux AT-SPI | 三平台 |

## 安装

### 1. 装 Lasso
```bash
# Claude Code 配置
claude mcp add lasso --scope user -- npx -y lasso-mcp@1.0.0

# 或全局安装
npm install -g lasso-mcp@1.0.0
```

### 2. 配置（按需）
- 搜索：`export ZHIPU_API_KEY=...`（必）+ `export BRAVE_API_KEYS=...`（可选多源）
- browse_logged_in：`lasso launch-chrome`（启动带 9222 端口的 Chrome）
- desktop macOS：`lasso doctor` 引导 TCC 授权（Accessibility / Screen Recording）
- desktop Windows：首次运行时系统会弹 UIA 授权（与 macOS TCC 等效）
- desktop Linux：确保 AT-SPI2 已装（大多数 GNOME/MATE 桌面默认有）

### 3. 自检
```bash
lasso doctor
```

## 工具列表（4 能力工具 + admin + doctor）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `search(query, limit, engine, region)` | 关键词搜索（多引擎 fallback） | `engine="auto"` 默认 |
| `browse_headless(url, action, options)` | 无头浏览（snapshot/click/fill/...） | `action` enum |
| `browse_logged_in(url, action, options)` | 复用登录态浏览（2FA 不解） | 需 :9222 CDP |
| `desktop(action, options)` | 控原生 app（snapshot/find/act/...） | `action` enum |
| `admin(action, ...)` | 运行时管理（channel_health/reset/profile/...） | `action` enum |
| `doctor()` | readiness JSON | — |

## 隐私

- **cookie=身份**：browse_logged_in 不导出用户 cookie（除用户显式 opt-in admin action 且经 AES-256-GCM 加密）
- **SSRF 防护**：所有外网请求经 allowRanges 守门（默认拒私有 IP；fake-ip 环境配 `198.18.0.0/15`）
- **desktop audit**：所有 desktop act 落 JSONL audit log（本地，10MB 轮转，零遥测）
- **无远程 telemetry**：所有指标进程内（INV-43 守）

## 故障排查（常见 error_kind）

| error_kind | 释义 | next_step |
|---|---|---|
| `tcc_denied` | macOS Accessibility 未授权 | System Settings → Privacy → Accessibility |
| `not_macos` / `not_windows` / `not_linux` | helper binary 平台不匹配 | 重新装对应平台 binary |
| `NEEDS_MANUAL_2FA` | 站点要 2FA（Lasso 不解 2FA） | 本机 Chrome 手动登 |
| `recording_replay_miss` | 全源熔断 + 无录制基线 | 配 LASSO_RECORD_SEARCH=true 录制 |
| `upstream_unsupported:pdf` | chrome-devtools-mcp 不支持 pdf | 用 browse_headless screenshot |

完整故障排查见 [`doc/TROUBLESHOOTING.md`](./doc/TROUBLESHOOTING.md)。

## 架构

见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)（架构分层 + data flow + 设计原则 + 边界）。

## 相关文档
（保 v0.1 既有链接）

## License
MIT © wangdong233
```

**ARCHITECTURE.md 结构（v1.0 新建，~310 行 markdown）**：

```markdown
# Lasso 架构

> 本文是 Lasso v1.0 的架构概览（user-first；深度架构基线见 doc/08）。

## 1. 项目定位

CC 的全交互对外抓手 MCP（浏览器 + 桌面）。与 media-gen-mcp（图像抓手）双子星。

## 2. 整体分层（架构图）

```
┌────────────────────────────────────────────────────────────┐
│  Claude Code                                                │
└──────────────────────────┬─────────────────────────────────┘
                           │ stdio MCP
                           ▼
┌────────────────────────────────────────────────────────────┐
│  Lasso（单进程）                                            │
│  Tool Layer:   search / browse_headless / browse_logged_in │
│                / desktop / admin / doctor                  │
│  Handler:      单一 fallback 引擎 + tri-state outcome       │
│  Channel:      BaseChannel ← UiChannel ← Browse/Desktop    │
│  Subprocess:   chrome-devtools-mcp ×2 + Rust helper        │
└──────────────────────────┬─────────────────────────────────┘
       ┌───────────────────┼──────────────────────┐
       ▼                   ▼                      ▼
 chrome-devtools-mcp   智谱/Brave/Bing API    Rust helper
 (--headless /         (search multi-engine)  (AXAPI/UIA/AT-SPI
 --browser-url :9222)                        + screenshot + TCC)
```

## 3. 核心抽象

- **BaseChannel / UiChannel 分层**：Search 只通用层；Browse/Desktop 进 UI 层
- **CapabilityBag**：运行时动态启停通道（v0.6+）
- **FallbackPlan + tri-state outcome**：worked / didnt / unknown（unknown 是 fallback 触发器）
- **StateStore LRU(128)**：页面/界面状态写磁盘，token 效率 4×

## 4. desktop 跨平台（v1.0）

```
AxBackend interface（三平台同构 OutlineNode 契约）
   ├── MacAxBackend       → rust.call("ax_snapshot")    → ax.rs      [cfg(macos)]
   ├── WinUiaBackend      → rust.call("uia_snapshot")   → uia.rs     [cfg(windows)]
   └── LinuxAtspiBackend  → rust.call("atspi_snapshot") → atspi.rs   [cfg(linux)]
```

平台差异隔离在 backend 内部；OutlineMapper 三平台共享（INV-61）。

## 5. 设计原则（08 §0）

1. 能力导向命名
2. 页面/界面状态写磁盘
3. 减少推理调用（多步链式）
4. fallback 对 CC 透明
5. 诚实三态交付
6. 零侵入跟随上游
7. 第二套做法红线（R-CI-02）
8. 不变量脚本化（CI 守门）

## 6. 边界（08 §7）

- 不解 2FA
- 不做坐标 grounding（desktop 走语义 AX）
- 不做 RRF 融合 / corpus 持久化
- macOS-only 开发（Win/Linux 编译可证，真机执行待社区反馈）

## 7. 测试策略

- 架构不变量测试 65 条（CI 强制断言）
- 录制回放回归（F3.8.14，selector 改版自动检测）
- 故障注入（fallback 链 / 限流 / 政策 gate）
- chrome-devtools-mcp 契约锁版本
- desktop AX 契约（OutlineMapper 三平台同构）
```

### 3.4 release polish（version 1.0.0 去 -dev + doctor 稳定性 + 全量测试覆盖率核查）

**借鉴源**：
- `src/doctor/doctor.ts` 行 105 `LASSO_VERSION = "0.9.0-dev"` —— **唯一版本真源**
- `media-gen-mcp/package.json` v0.11.0 发布范式（npm + GitHub release）—— **复用 release flow**

**关键决策**：
- **version 真源单一化**。grep `0.9.0-dev` 只能在 `src/doctor/doctor.ts` 与 `package.json` 两处出现；改这两处 → 全项目 version 同步（INV-63 静态守）。
- **不增 release script**。npm 发布走既有 `npm publish`（media-gen-mcp 已验）；GitHub release 走 `gh release create v1.0.0`（既有 gh CLI）。
- **doctor 加 2 项不增 section**。#31 platform_backend_active + #32 recording_baseline_count 走既有 `runDoctor` checks 数组（INV-47 衍生：不开第二套 doctor section）。
- **覆盖率核查不强推阈值**。v1.0 采集覆盖率基线（c8 或 vitest --coverage），写入 doc/COVERAGE-BASELINE.md；不强制 CI fail-on-coverage-drop（避免 v0.x 测试债变 v1.0 阻塞）。阈值强制推迟 v1.1。

**doctor 改造（src/doctor/doctor.ts）**：

```ts
// 新增 check #31（v1.0）：
//   31. platform_backend_active —— 当前 AxBackendKind 经 AxBackendFactory 可装配
//      macOS → "mac"；Windows → "win_uia"；Linux → "linux_atspi"
//      失败 → fail（平台不支持；unsupported_platform 异常）
function checkPlatformBackendActive(): DoctorCheck {
  try {
    const kind = AxBackendFactory.detectKind();
    return {
      name: "platform_backend_active",
      status: "pass",
      detail: `platform=${process.platform}; backend=${kind}`,
    };
  } catch (e) {
    return {
      name: "platform_backend_active",
      status: "fail",
      detail: String(e),
      next_step: `当前 platform ${process.platform} 不支持；Lasso v1.0 支持 darwin/win32/linux`,
    };
  }
}

// 新增 check #32（v1.0）：
//   32. recording_baseline_count —— RecordingStore 录制数（CI fixtures 目录）
//      fixtures/serp-baseline/ 录制数 ≥10 → pass
//      0 → warn（无基线，replay-baseline 会 skip）
function checkRecordingBaselineCount(
  fixturesDir: string,
): DoctorCheck {
  // 扫 fixtures/serp-baseline/ 数 .html 文件
  // ≥10 → pass；0 → warn；中间 → pass（带 detail）
  // ... 完整实装留 Phase D ...
}
```

**package.json 改造**：

```json
{
  "name": "lasso-mcp",
  "version": "1.0.0",                    // ← 从 "0.9.0-dev"
  // ...
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "check-invariants": "node src/invariants/check-invariants.mjs",
    "replay-baseline": "node dist/serp/replay-baseline.js",      // ★ 新（v1.0）
    "check-cross-compile": "bash scripts/check-cross-compile.sh"  // ★ 新（v1.0，cargo check 双 target）
  }
  // dependencies 不增（守 R-CI-02）
}
```

---

## 4. 不明确点调研结论

### 4.1 Win/Linux Rust crate 选型 → 决策：windows-rs（官方）+ atspi（pure Rust）

**调研**（既有知识，WebSearch 配额耗尽无法实测，标"基于既有知识 2023-2024"）：

| 平台 | 候选 crate | 优点 | 缺点 | v1.0 选 |
|---|---|---|---|---|
| Windows UIA | **`windows`（microsoft/windows-rs）** | 官方微软维护；auto-generated from Win32 metadata；完整 UIA COM 覆盖 | 低层（要自己包 IUIAutomation COM 调用）；学习曲线陡 | **选** |
| Windows UIA | `uiautomation`（社区） | 高层 ergonomic API；人体工学好 | 维护团队小；更新间歇；可能与官方 metadata 漂移 | 不选 |
| Windows UIA | `winsafe` / `winsapi` | 低层 Win32 | UIA 需自己写 COM 绑定，工作量大 | 不选 |
| Linux AT-SPI | **`atspi`（odilia-app）** | pure Rust via zbus D-Bus；无 C 依赖；CI Linux headless 可编 | AT-SPI 协议覆盖度依赖 odilia 项目；某些 AT-SPI2 新接口可能未暴露 | **选** |
| Linux AT-SPI | `at-spi2`（C 绑定） | 完整 AT-SPI2 协议覆盖 | C 依赖（libatspi）；CI 需装系统包；跨编译复杂 | 不选 |
| Linux AT-SPI | `zbus` 直裸调 | 最薄；完全控制 | 需自己实现 AT-SPI D-Bus 接口；工作量大 | 不选 |

**结论**：Windows 用 `windows` 官方 crate（Win32_UI_Accessibility feature），Linux 用 `atspi` crate（zbus 传递依赖）。两者都是 target-specific dependencies，macOS build 完全不拉这两个 crate（cargo target 段语义保证）。

**风险声明**：基于既有知识（2023-2024 时期的项目状态），实装前需 `cargo search windows` / `cargo search atspi` 复核最新版本号 + 维护状态；若 atspi 项目已 archive，备选 `zbus` 直裸调（实现成本高但可控）。

### 4.2 cfg-gate 不影响 macOS build → 决策：target-specific dependencies + `#[cfg(target_os = ...)]` 双层守门

**调研**：Rust 有两种平台隔离机制：
1. **target-specific dependencies**（Cargo.toml `[target.'cfg(target_os = "windows")'.dependencies]`）：crate 只在对应 target 编译时拉入依赖闭包；macOS build 完全不解析 Windows crate。
2. **`#[cfg(target_os = "...")]` attribute**（Rust 源码层）：模块/函数级条件编译；非 target 平台下代码不参与编译。

**结论**：v1.0 用**双层 cfg-gate**：
- Cargo.toml target-specific dependencies：Windows crate 只在 Windows target 拉，Linux crate 只在 Linux target 拉，macOS build 闭包不变（v0.9 Rust 测试零回归可证）
- 源码层 `#[cfg(target_os = "windows")] mod platform { ... }`：Windows UIA 实装代码在 macOS build 时完全不编译（不参与类型检查 / 不参与单测）

**验证策略**：
- macOS 本机 `cargo build && cargo test` → 期望 144 → ~160 Rust 测试全过（新增的非 macOS 路径单测用 `#[cfg(not(target_os = "macos"))]` skip 在 macOS 不跑）
- CI Linux runner 跑 `cargo check --target x86_64-pc-windows-msvc`（验 Windows 编译）+ `cargo build --target x86_64-unknown-linux-gnu`（验 Linux 编译，且 Linux target 下 atspi 模块的 `#[cfg(test)]` 单测可跑）
- CI Windows runner（若 GitHub Actions 配额允许）跑 `cargo test --target x86_64-pc-windows-msvc`（验 Windows UIA 路径单测）

### 4.3 录制回放基线存哪 → 决策：签入 `fixtures/serp-baseline/`（仓库内）

**调研**：v0.9 RecordingStore 默认存 `~/.cache/lasso/recordings/`（用户本地，跨进程）。但 CI 需要**确定性基线**（不能依赖开发者本地录制）。

**结论**：v1.0 区分两种录制源：
- **CI 基线**（签入仓库）：`fixtures/serp-baseline/<engine>/<query-hash>.html` + `.json`（expected sidecar）。首次实装时开发者手动录制 10 条 query × 3 engine = 30 fixture，commit 进仓库。CI replay-baseline runner 消费这些 fixture。
- **运行时录制**（用户本地）：`~/.cache/lasso/recordings/`（v0.9 既有路径不变）。这是 v0.9 F3.8.14 兜底链尾用的，CI 不碰。

**守 INV-51 红线**：CI 基线**只录 search + browse_headless SERP**，不录 browse_logged_in（可能含 cookie/session URL 参数）。`replay-baseline.ts` 加 grep 守：录制源禁来自 logged_in 通道。

### 4.4 AxBackend interface 是否要加新方法 → 决策：不加，保 snapshot/find/act 三方法

**调研**：v0.3.5 AxBackend 定义了三方法（snapshot/find/act），v1.0 跨平台是否需加 `list_windows`（forest interact_roots 用）/ `screenshot`？

**结论**：**不加**。理由：
- `list_windows` 是 forest 调度层数据源（v0.4 已实装 macOS CGWindowList），Win/Linux 走枚举桌面窗口的 API（Win32 EnumWindows / AT-SPI root children），与 AxBackend 概念不同——它们是「枚举所有 app 的所有窗口」，而 AxBackend 是「单个 app 的 AX 树深读」。混进 interface 违反概念完整性（02 §5）。
- `screenshot` 是平台无关的（CGWindowList / Win32 BitBlt / X11 XGetImage），已在 `rust-helper/src/screenshot.rs` 跨平台实装（v0.3.5 走 core-graphics，v1.0 不动；Win/Linux 截图推 v1.1+）。
- AxBackend 专注 AX tree 读 + act；其他能力（list_windows / screenshot / tcc）是并列 method，不进 AxBackend interface（守 R-CI-02）。

---

## 5. 测试计划

### 5.1 CI 单测（vitest，纯 mock；macOS 全量）

| 测试文件 | 覆盖 | 断言 |
|---|---|---|
| `test/unit/ax-backend-factory.spec.ts` ★ 新 | 三平台 backend 路由 | mock process.platform 三值 → factory 返对应 backend class；unsupported 抛错 |
| `test/unit/ax-backend-contract.spec.ts` ★ 新 | 三 backend 同构 interface | 三 backend 都有 snapshot/find/act 方法；都返 Promise<RustResponse>；都调对应 rust method（`ax_*` / `uia_*` / `atspi_*`） |
| `test/unit/outline-contract.spec.ts` ★ 新 | OutlineNode 三平台同构 | mock 三平台 AxNode JSON fixture → OutlineMapper → 断言 OutlineNode byte-identical |
| `test/unit/replay-baseline.spec.ts` ★ 新 | 录制回放回归 runner | mock fixtures 目录 → runner 跑 → 断言命中率 / status 分级；strict 模式 fail 时 exit 1 |
| `test/unit/launch-chrome.spec.ts` ★ 新 | 跨平台 Chrome 路径探测 | mock 三平台候选路径 → 探测返正确路径；未找到返 null（不抛错） |
| `test/unit/invariants-v10.spec.ts` ★ 新 | INV-60..65 静态校验 | AxBackendFactory 是 AxBackendKind 单一真源；version 真源只在 doctor.ts + package.json；RecordingStore 禁录 logged_in |
| `test/unit/platform-detect.spec.ts` ★ 新 | platform 探测 | mock process.platform 三值 → detectKind 返对应 |

**CI 总数预期**：v0.9 1271 → v1.0 ≈ **1271 + ~130 ≈ 1400**。

### 5.2 CI Rust 单测（cargo test；macOS + Linux 双矩阵）

| 测试文件 | 覆盖 | 平台 |
|---|---|---|
| `rust-helper/src/uia.rs #[cfg(test)]` ★ 新 | UIA 路径 cfg-gate 单测 | Windows only（macOS skip） |
| `rust-helper/src/atspi.rs #[cfg(test)]` ★ 新 | AT-SPI 路径 cfg-gate 单测 | Linux only（macOS skip） |
| `rust-helper/src/ax_role_map.rs #[cfg(test)]`（扩） | 三平台 role 合并表单测 | 跨平台（既有 v0.3.5 macOS 测试零改，加 Win/Linux role 测试 case） |

**CI Rust 总数预期**：v0.9 144 → v1.0 ≈ **144 + ~30 ≈ 174**（新增 Win/Linux 平台路径 cfg-gate 单测，macOS 本机可见 ~5 个 `#[cfg(not(target_os = "macos"))]` skip）。

### 5.3 CI 跨平台编译验证（Linux runner）

```yaml
# .github/workflows/ci.yml 扩 matrix（既有 Node 20/22 矩阵 + 新增跨编译）
jobs:
  cross-compile-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: x86_64-pc-windows-msvc,x86_64-unknown-linux-gnu
      - run: cd lasso/rust-helper && cargo check --target x86_64-pc-windows-msvc
      - run: cd lasso/rust-helper && cargo check --target x86_64-unknown-linux-gnu
      - run: cd lasso/rust-helper && cargo build --target x86_64-unknown-linux-gnu
      - run: cd lasso/rust-helper && cargo test  --target x86_64-unknown-linux-gnu
```

**验证目标**：
- Windows target 编译过（uia.rs 真编入，windows crate 依赖闭包正确解析）
- Linux target 编译过（atspi.rs 真编入，atspi crate 依赖闭包正确解析）
- Linux target 单测过（atspi.rs 单测在 Linux 真跑，但仍无桌面 → AT-SPI registry 单测 mock D-Bus）

### 5.4 手测清单（parse11-acceptance.md，CI 无法代劳）

| # | 平台 | 测项 | 触发 | 预期 | 状态 |
|---|---|---|---|---|---|
| #W1 | Windows 10/11 | uia_snapshot Notepad | `desktop({action:"snapshot", app:"Notepad"})` | 返 OutlineNode 树（≥5 节点） | **pending**（需真 Windows） |
| #W2 | Windows | uia_find Notepad Edit | `desktop({action:"find", app:"Notepad", where:{role:"edit"}})` | 返编辑框节点 | **pending** |
| #W3 | Windows | uia_act Button Invoke | `desktop({action:"act", actions:[{ref:"@e0", type:"click"}]})` | Notepad 帮助按钮被点击 | **pending** |
| #W4 | Windows | list_windows 枚举 | `interact_roots()` | 返所有 on-screen 窗口列表 | **pending** |
| #W5 | Windows | TCC 等效（UIA 授权） | 首次 desktop 调用 | 系统弹 UIA 授权框；授权后能读 AX | **pending** |
| #W6 | Windows | OutlineNode 同构 | 同一 app（如 Calculator）Win + macOS 截图对比 | role 字段语义对齐（Win Button ↔ macOS AXButton → outline.role="button"） | **pending** |
| #W7 | Windows | launch-chrome 路径 | `lasso launch-chrome` | 找到 Program Files\Google\Chrome 并启 :9222 | **pending** |
| #L1 | Linux GNOME | atspi_snapshot gedit | `desktop({action:"snapshot", app:"gedit"})` | 返 OutlineNode 树 | **pending**（需真 Linux 桌面） |
| #L2 | Linux | atspi_find gedit entry | `desktop({action:"find", ...})` | 返文本输入框 | **pending** |
| #L3 | Linux | atspi_act push button | `desktop({action:"act", ...})` | 按钮点击生效 | **pending** |
| #L4 | Linux | list_windows 枚举 | `interact_roots()` | 返所有 on-screen 窗口 | **pending** |
| #L5 | Linux | AT-SPI registry 探测 | `lasso doctor` | #31 platform_backend_active=linux_atspi pass | **pending** |
| #L6 | Linux | OutlineNode 同构 | gedit macOS TextEdit 对比 | role 字段语义对齐 | **pending** |
| #L7 | Linux | launch-chrome 路径 | `lasso launch-chrome` | 找到 /usr/bin/google-chrome 并启 :9222 | **pending** |
| #M1 | macOS | 真机回归（基线） | v0.9 全部 macOS 测试集 + doctor | 全过 + 32 checks | 本机可证 |
| #M2 | macOS | 跨平台 backend fallback | `LASSO_FORCE_PLATFORM=win_uia lasso doctor` | AxBackendFactory 仍返 mac（process.platform 不可强制覆盖，但 #31 报当前 backend） | 本机可证 |
| #R1 | 跨平台 | 录制回放基线 | `npm run replay-baseline` | 30 fixtures 全 pass（命中率 ≥80%） | 本机可证（fixtures 签入仓库） |
| #R2 | 跨平台 | selector 改版检测 | 故意改坏 selectors.ts → replay-baseline | 命中率 <50% 触发 fail（strict 模式） | 本机可证 |

---

## 6. 验收标准（引用 09 §2.11 + 细化；标 CI vs 手测；**Win/Linux 手测诚实标 pending**）

> 09 §2.11 原文：「稳定发布门槛：四通道 + fallback 链全量测试 / SERP 3 引擎命中率 ≥90% / chrome-devtools-mcp 1.6.x 契约 + Rust helper AX 契约 / doctor CLI 90% / 跨平台验证」。下面是文件/函数级细化。

### 6.1 跨平台 desktop（F3.10.9）
- [ ] CI：AxBackend interface 编译通过（MacAxBackend / WinUiaBackend / LinuxAtspiBackend 三 class 都 implements AxBackend）
- [ ] CI：AxBackendFactory.detectKind() 三平台路由正确（ax-backend-factory.spec.ts）
- [ ] CI：OutlineNode 三平台同构契约（outline-contract.spec.ts byte-identical）
- [ ] CI：`cargo check --target x86_64-pc-windows-msvc` 通过（Windows UIA 编译可证）
- [ ] CI：`cargo check --target x86_64-unknown-linux-gnu` 通过（Linux AT-SPI 编译可证）
- [ ] CI：macOS `cargo test` 全过（v0.9 144 Rust + 新增 ~5 个 macOS 路径测试零回归）
- [ ] CI：INV-60（AxBackendFactory 单一真源）+ INV-61（OutlineMapper 三平台共享）静态守
- [ ] **手测 #W1-#W7 / #L1-#L7：Win/Linux 真机执行 —— pending（需真 Win/Linux 环境，CI 不能代劳）**
- [ ] release notes 明确标「Win/Linux backend 编译可证、真机执行待社区反馈」

### 6.2 录制回放回归（F3.8.14）
- [ ] CI：`fixtures/serp-baseline/` 至少 30 条 fixture（百度/Google/Bing × 10 query）签入仓库
- [ ] CI：`npm run replay-baseline` 通过（命中率 ≥80%；strict 模式 <50% exit 1）
- [ ] CI：selector 改版检测（故意改坏 selector → CI warning 触发）
- [ ] CI：录制源禁 logged_in（INV-62 grep 守）
- [ ] CI：replay-baseline runner 不依赖网络（纯本地 fixture 回放）

### 6.3 用户手册
- [ ] README 扩完整 5 节（安装/配置/工具列表/隐私/故障排查），保 user-first 语调
- [ ] ARCHITECTURE.md 新建（架构分层 + data flow + 设计原则 + 边界）
- [ ] doc/TROUBLESHOOTING.md（常见 error_kind 释义 + FAQ）
- [ ] doc/SELECTOR-MAINTENANCE.md（selector 债维护手册：如何加新 selector / 改版检测流程）
- [ ] README badge Status WIP → stable-v1.0

### 6.4 release polish（version 1.0.0 去 -dev）
- [ ] CI：`package.json` version = `1.0.0`（非 `-dev`）
- [ ] CI：`src/doctor/doctor.ts` LASSO_VERSION = `1.0.0`（INV-63 静态守：两处一致）
- [ ] CI：grep `0.9.0-dev` 全项目无残留（version 真源单一化）
- [ ] CI：npm publish 干跑（npm publish --dry-run）通过
- [ ] 手测：npm 真发布 `lasso-mcp@1.0.0`（开发者手动；GitHub release tag v1.0.0）

### 6.5 doctor 稳定性（09 §2.11 "doctor CLI 90%"）
- [ ] CI：doctor 32 项 check 全跑（#31 platform_backend_active + #32 recording_baseline_count 新增）
- [ ] CI：doctor #31 在 macOS 返 `platform=darwin; backend=mac`
- [ ] CI：doctor #32 在有 fixtures 时返 pass（≥10）；无 fixtures 返 warn（不阻塞 ready）

### 6.6 全量测试覆盖率核查
- [ ] CI：macOS 全量 `npm test` ≈ 1400 测试通过率 100%（v0.9 1271 零回归 + ~130 新）
- [ ] CI：macOS `npm run check-invariants` 65 条全绿（v0.9 59 + 新 INV-60..65）
- [ ] CI：覆盖率基线采集（vitest --coverage）写入 doc/COVERAGE-BASELINE.md（不强推阈值）
- [ ] CI：故障注入扩 SERP 改版场景（replay-baseline 注入故意改版 fixture）

### 6.7 零回归（守 v0.9 基线）
- [ ] CI：v0.9 1271 TS 测试零回归
- [ ] CI：v0.9 144 Rust 测试零回归（macOS 本机）
- [ ] CI：v0.9 INV-1..59 一行不改
- [ ] CI：BrowseChannel / HeadlessChannel / LoggedInChannel / SearchChannel 业务逻辑零改
- [ ] CI：Rust helper macOS 路径（ax.rs / applescript.rs / cgevent.rs / screenshot.rs / tcc.rs / windows.rs）一行不改

---

## 7. 风险 + 实施顺序

### 7.1 风险 Register（v1.0 新增）

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-v10-1 | windows-rs crate API 漂移（微软更新频繁） | 中 | 中 | 锁版本（Cargo.lock）；契约测试守门；doctor 探测 windows crate 版本 |
| R-v10-2 | atspi crate 项目 archive / 维护停 | 中 | 高 | 备选 zbus 直裸调（实现成本 ~2 工日增量）；实装前 `cargo search atspi` 复核 |
| R-v10-3 | OutlineNode 三平台语义对齐失守（Win Button ≠ macOS AXButton） | 中 | 中 | 三平台 role-map 合并表 CI 单测；手测 #W6/#L6 真机验证 |
| R-v10-4 | macOS 本机无法验 Win/Linux 真机执行 | **必然** | 中 | **诚实标 pending**；release notes 明确；CI 仅证编译 + 契约；社区反馈循环 |
| R-v10-5 | 录制 fixture 含 PII（搜索 query 含敏感信息） | 低 | 中 | fixtures 录制时用脱敏 query（如 "rust async" 而非用户真 query）；INV-62 守 |
| R-v10-6 | README 重写破坏 user-first 语调 | 低 | 低 | 保 v0.1 既有开头；review 时对照 v0.1 README 语调；不删既有"这是什么"节 |
| R-v10-7 | npm publish 1.0.0 后发现 blocker bug | 低 | 高 | npm publish 前 tag v1.0.0-rc.1（release candidate）；社区跑 1 周再升 v1.0.0 |
| R-v10-8 | CI Linux runner 拉不到 windows crate（cross-compile 闭包大） | 中 | 低 | 用 `actions/cache` 缓存 cargo registry；或降级为只验 `cargo check`（不跑 build） |

### 7.2 实施顺序（5 phase，每 phase 可独立交付 + 验证 + tag 回退）

**Phase A（W1）—— AxBackend interface 最终化 + factory + 单测**
- 改 `src/desktop/AxBackend.ts`：MacAxBackend / WinUiaBackend / LinuxAtspiBackend 三 class 真实实装（薄壳，调 rust.call）
- 新 `src/desktop/AxBackendFactory.ts`（~110 行）+ `platform-detect.ts`（~70 行）
- 改 `src/desktop/AxProvider.ts`：构造接 AxBackendFactory 替换直接持 RustBridge
- 单测：ax-backend-factory / ax-backend-contract / platform-detect
- INV-60（AxBackendFactory 单一真源）落地
- 验收：TS 单测全绿；macOS 真机 AxProvider 路由到 MacAxBackend；零业务回归

**Phase B（W2）—— Rust 端 WinUiaBackend / LinuxAtspiBackend cfg-gate 实装**
- 改 `rust-helper/Cargo.toml`：加 target-specific dependencies（windows / atspi）
- 新 `rust-helper/src/uia.rs`（~220 行；Windows UIA 经 windows-rs）
- 新 `rust-helper/src/atspi.rs`（~200 行；Linux AT-SPI 经 atspi crate）
- 改 `rust-helper/src/main.rs`：dispatch 加 `uia_*` / `atspi_*` method 路由
- 改 `rust-helper/src/ax_role_map.rs`：扩为三平台合并表（macOS AXRole + Windows ControlType + Linux AT-SPI role → unified）
- 单测：uia.rs / atspi.rs `#[cfg(test)]` + ax_role_map.rs 扩三平台 case
- CI 加 cross-compile-check job（Linux runner，cargo check 双 target）
- INV-61（OutlineMapper 三平台共享）落地
- 验收：macOS `cargo test` 零回归；Linux runner 跨编译过；Windows target 编译过

**Phase C（W3）—— 录制回放回归 runner + fixtures + selector 改版检测**
- 新 `src/serp/replay-baseline.ts`（~180 行）
- 新 `fixtures/serp-baseline/`：首次录制 30 条 fixture（百度/Google/Bing × 10 query）
- 改 `package.json`：加 `replay-baseline` script
- 单测：replay-baseline.spec.ts
- 集成测：故意改坏 selectors.ts → replay-baseline strict 触发 fail
- INV-62（录制源禁 logged_in）落地
- 验收：CI 跑 replay-baseline 全过；selector 改版检测可证

**Phase D（W4）—— launcher 跨平台 + doctor 扩 + 装配**
- 新 `src/launcher/launch-chrome.ts` + `chrome-paths.ts`（~200 行）
- 改 `src/doctor/doctor.ts`：加 #31 platform_backend_active + #32 recording_baseline_count
- 改 `src/index.ts`：装配 AxBackendFactory + RecordingStore + launcher 子命令
- 改 `src/cli.ts`（或 index.ts dispatch）：`lasso launch-chrome` + `lasso replay-baseline` 子命令
- 单测：launch-chrome.spec.ts + doctor 扩的 #31/#32
- CI 加 Ubuntu Linux + Windows matrix（如 GitHub Actions 配额允许；否则只 Linux）
- INV-63（version 真源单一化）+ INV-64（launcher 不引入新 npm dep）落地
- 验收：macOS launch-chrome 真测过；doctor 32 项全过

**Phase E（W5）—— release polish + 文档 + 发 1.0.0**
- 改 `package.json` + `src/doctor/doctor.ts`：version `0.9.0-dev` → `1.0.0`
- README 覆盖重写（5 节；保 user-first）
- 新 `ARCHITECTURE.md` + `doc/TROUBLESHOOTING.md` + `doc/SELECTOR-MAINTENANCE.md`
- 新 `doc/COVERAGE-BASELINE.md`：采集覆盖率基线
- INV-65（README/ARCHITECTURE 必引用 08/09）落地
- 手测清单 parse11-acceptance.md 7 条 macOS 项 + 标 Win/Linux pending
- 全量 CI 闸门：65 invariants + ~1400 TS + ~174 Rust（macOS）+ 跨编译 + replay-baseline
- npm publish `lasso-mcp@1.0.0-rc.1`（release candidate）
- 社区跑 1 周（若社区反馈 Win/Linux 真机有问题 → patch v1.0.1；否则升 v1.0.0）
- 验收：npm 线 `lasso-mcp@1.0.0` 可装；GitHub release v1.0.0 含 release notes

### 7.3 回退点
- Phase A 失败 → 不影响 v0.9（AxBackendFactory 新文件不引入；AxProvider 零改）
- Phase B 失败 → 留 Phase A（AxBackend interface 落地；Win/Linux 推 v1.1）
- Phase C 失败 → 留 Phase A+B（录制回放推 v1.1；selector 改版检测保 v0.7 运行时告警）
- Phase D 失败 → 留 Phase A+B+C（launcher 推 v1.1；用户手册用现有 README）
- Phase E 失败 → 留 Phase A+B+C+D（不发 1.0.0；保 v0.9.1-dev；文档可独立发）

每个 phase 独立打 tag，失败可回退。

---

## 文档结束

**本文档是 Lasso v1.0 文件/函数级执行计划**（parse11，2026-07-22 产出）。F 编号严格对应 [08 §4](08-media-interact-功能架构.md)（F3.10.9 / F3.8.14）；阶段定位对应 [09 §2.11](09-media-interact-实施排期.md)。简单性守 02 §5 R-CI-02（横切关注点变体只允许一套）+ §6.1 R-FF-01（分层方向，平台字面量不进 TS 层）+ §6.3 review 三问（新增抽象暴露 what 不是 how）。**macOS-only 现实红线**：本机 Darwin 21.6.0 Intel，Win/Linux backend 编译可证（cfg-gate + 跨编译 CI）+ 契约可证（OutlineNode 三平台同构单测），真实执行留 parse11-acceptance.md 手测清单（标 pending，不伪造）。零回归承诺 v0.9 基线（59 INV + 1271 TS + 144 Rust）。下游：parse11-acceptance.md（手测清单，待生成）+ 实施 commit 序列 + npm `lasso-mcp@1.0.0` 发布。

---

**附：关键文件路径（全部绝对路径）**
- 排期：`/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.11
- 架构：`/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md` §3.3 / §5.4 / §7.5 / F3.10.9 / F3.8.14
- 简单性：`/Users/wangdong/Documents/Project/架构想法/02_简单检查清单.md` §5 R-CI-02 / §6.1 R-FF-01 / §6.3 review 三问
- 当前 AxBackend 接口：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/desktop/AxBackend.ts`（99 行，v0.3.5 占位 + v1.0 真实实装三 class）
- 当前 AxProvider：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/desktop/AxProvider.ts`（253 行，v0.3.5 直接持 RustBridge；v1.0 改为经 AxBackendFactory）
- Rust 端 ax.rs：`/Users/wangdong/Documents/Project/cc-control-all/lasso/rust-helper/src/ax.rs`（341 行，macOS AXAPI 实装；v1.0 模板范式源）
- Rust 端 main.rs dispatch：`/Users/wangdong/Documents/Project/cc-control-all/lasso/rust-helper/src/main.rs`（142 行，v1.0 加 uia_* / atspi_* method 路由）
- Rust 端 Cargo.toml：`/Users/wangdong/Documents/Project/cc-control-all/lasso/rust-helper/Cargo.toml`（v1.0 加 target-specific dependencies）
- RecordingStore（v0.9 已实装）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/serp/RecordingStore.ts`（259 行，save/load/replay/list；v1.0 不改，加 replay-baseline runner）
- 不变量脚本：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs`（2180 行，v0.9 INV-59 截止，v1.0 加 INV-60..65）
- doctor：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/doctor/doctor.ts`（1774 行，v0.9 收尾 #30；v1.0 加 #31 platform_backend_active + #32 recording_baseline_count）
- package.json：`/Users/wangdong/Documents/Project/cc-control-all/lasso/package.json`（v1.0 version `0.9.0-dev` → `1.0.0` + replay-baseline / check-cross-compile script）