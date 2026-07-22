/**
 * AxBackend 接口 + 三平台实装（parse4 §2.1 + §3.2 + D5 平台隔离；
 *                                  parse11 §3.1 v1.0 三平台 backend 真实落地）
 *
 * 抽象层：把 AXAPI（macOS）/ UIA（Windows）/ AT-SPI（Linux）三套不同平台 API
 * 收敛到同一组方法签名（snapshot / find / act）。AxProvider（业务层）只依赖
 * 本接口，不关心背后是哪个平台实现。
 *
 * v0.3.5 实装范围：
 *  - MacAxBackend（注释占位；AxProvider 直接持 RustBridge）
 *
 * v1.0 实装范围（parse11 §3.1 + §7.2 Phase A）：
 *  - MacAxBackend       —— macOS AXAPI（经 rust.call("ax_*")    → rust-helper ax.rs）
 *  - WinUiaBackend      —— Windows UIA （经 rust.call("uia_*")  → rust-helper uia.rs Phase B）
 *  - LinuxAtspiBackend  —— Linux AT-SPI（经 rust.call("atspi_*")→ rust-helper atspi.rs Phase B）
 *
 * 三个 class 都是**薄壳**：method 体只调 RustBridge.call(...)，不做平台 API 分支；
 * 真实平台调用全在 rust-helper/src/{ax,uia,atspi}.rs（INV-21 守）。
 *
 * INV-21（F3.9.9 f）：本文件只定义抽象接口 + 薄壳 class，**不出现平台 API 字面量**
 * （AXUIElement / CGEvent / UIAutomationClient / libatspi / IUIAutomation 等都不进）。
 * 实现细节（具体的 platform API 调用）在 rust-helper/src/*.rs 完成。
 *
 * INV-60（parse11 §3.1 + §7.2 Phase A，v1.0 新增）：三平台 backend class 的
 * 注册单一真源是 AxBackendFactory.ts；AxProvider 不直接 new 任一 backend。
 *
 * 借鉴：08 §3.1.3 分层；13 §2.4 R-CI-02；Desktop-pilot 4 层 Router
 * 抽象（本接口对应其中 platform 层）。
 */
import type {
  DesktopOptions,
  WhereClause,
} from "./desktop-types.js";
import type { RustBridge, RustResponse } from "../subprocess/RustBridge.js";

// ============================================================
// AxBackend 接口（v0.3.5 已定义；v1.0 零改）
// ============================================================
/**
 * 三平台共用的 AX 抽象。
 *
 * 方法语义：
 *  - snapshot : 取 app（None = system-wide）的 AX 树，maxDepth 截断
 *  - find     : 基于 where 子句在 AX 树里查节点（v0.3.5 每次 re-walk）
 *  - act      : 在指定 ref 节点上执行动作序列（v0.3.5 Phase B 占位）
 *
 * 返回 RustResponse（Rust helper 的原始响应；上游 AxProvider 自己判定
 * ok/error_kind + OutlineMapper 映射）。本接口不抛异常 —— 错误经
 * RustResponse.ok=false + error_kind 透传（铁律：event delivery ≠ semantic success）。
 *
 * INV-21：方法签名只引用抽象类型（AxNode / WhereClause / DesktopOptions），
 * 不引用任何平台句柄类型。
 *
 * 三平台同构契约（parse11 §3.1 INV-61，Phase B 落地）：三平台 backend 都返
 * 同形 RustResponse（result.root 是 AxNode 树，role 已由 Rust 端 ax_role_map
 * 统一映射）；OutlineMapper 三平台共享（ INV-61 衍生：OutlineNode 契约单一 mapper）。
 */
export interface AxBackend {
  snapshot(
    app: string | undefined,
    maxDepth: number,
  ): Promise<RustResponse>;

  find(
    app: string | undefined,
    maxDepth: number,
    where: WhereClause,
  ): Promise<RustResponse>;

  act(actions: DesktopOptions["actions"]): Promise<RustResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type { RustResponse } from "../subprocess/RustBridge.js";

// ============================================================
// AxBackendKind（v1.0 从占位 → 真实枚举）
// ============================================================
/**
 * 三平台 backend 注册键（v1.0 真实路由用）。
 *
 * INV-60 衍生：本 type 是 AxBackendKind 字面量的**单一真源**
 * （grep `type AxBackendKind` 只在本文件定义；AxBackendFactory.ts import 之）。
 *
 *  - "mac"         → MacAxBackend
 *  - "win_uia"     → WinUiaBackend
 *  - "linux_atspi" → LinuxAtspiBackend
 */
export type AxBackendKind =
  | "mac"
  | "win_uia"
  | "linux_atspi";

// ============================================================
// MacAxBackend（v1.0 真实 class；v0.3.5 是注释占位）
// ============================================================
/**
 * macOS AXAPI backend（经 RustBridge.call("ax_snapshot"|"ax_find"|"ax_act")）。
 *
 * 平台 API 隔离策略（INV-21 + D5 + INV-60）：
 *  - 本类不直接调任何 AXUIElement / CGEvent / AXPress 符号
 *  - 所有平台调用经 RustBridge.call("ax_*") → rust-helper/src/ax.rs
 *  - 平台字面量（AXUIElement / CGEvent / AXPress 等）只存在于 rust-helper/src/*.rs
 *
 * method 名前缀 ax_* 是 macOS 专属（与 Win uia_* / Linux atspi_* 区分；
 * Rust 端 main.rs dispatch 据方法名路由到对应平台模块）。
 */
export class MacAxBackend implements AxBackend {
  constructor(private readonly rust: RustBridge) {}

  async snapshot(
    app: string | undefined,
    maxDepth: number,
  ): Promise<RustResponse> {
    return this.rust.call("ax_snapshot", { app, max_depth: maxDepth });
  }

  async find(
    app: string | undefined,
    maxDepth: number,
    where: WhereClause,
  ): Promise<RustResponse> {
    return this.rust.call("ax_find", {
      app,
      max_depth: maxDepth,
      where,
    });
  }

  async act(actions: DesktopOptions["actions"]): Promise<RustResponse> {
    return this.rust.call("ax_act", { actions });
  }
}

// ============================================================
// WinUiaBackend（v1.0 新；Windows UI Automation 经 windows-rs）
// ============================================================
/**
 * Windows UIA backend（经 RustBridge.call("uia_snapshot"|"uia_find"|"uia_act")）。
 *
 * INV-21 衍生 + INV-60 衍生：本类不出现 UIAutomationClient / IUIAutomation
 * 字面量；真实 UIA COM 调用全在 rust-helper/src/uia.rs（Phase B cfg-gate 实装）。
 *
 * method 名前缀 uia_* 与 macOS ax_* / Linux atspi_* 区分（Rust 端 main.rs
 * dispatch 据方法名路由：cfg(target_os = "windows") 调 uia::snapshot）。
 *
 * macOS-only 现实红线（parse11 §1.3）：本 class 在 TS 端永远可实例化（编译时无
 * 平台 guard），但运行时若 Rust 端不在 Windows target，rust.call("uia_*") 会返
 * ok=false + error_kind="not_windows"（rust-helper/src/main.rs Phase B 加）。
 * 本机 macOS 测不到真实 UIA → CI 仅证编译 + 契约；真机执行留手测清单。
 */
export class WinUiaBackend implements AxBackend {
  constructor(private readonly rust: RustBridge) {}

  async snapshot(
    app: string | undefined,
    maxDepth: number,
  ): Promise<RustResponse> {
    return this.rust.call("uia_snapshot", { app, max_depth: maxDepth });
  }

  async find(
    app: string | undefined,
    maxDepth: number,
    where: WhereClause,
  ): Promise<RustResponse> {
    return this.rust.call("uia_find", {
      app,
      max_depth: maxDepth,
      where,
    });
  }

  async act(actions: DesktopOptions["actions"]): Promise<RustResponse> {
    return this.rust.call("uia_act", { actions });
  }
}

// ============================================================
// LinuxAtspiBackend（v1.0 新；Linux AT-SPI2 经 atspi crate）
// ============================================================
/**
 * Linux AT-SPI backend（经 RustBridge.call("atspi_snapshot"|"atspi_find"|"atspi_act")）。
 *
 * INV-21 衍生 + INV-60 衍生：本类不出现 Atspi / Accessible / libatspi 字面量；
 * 真实 AT-SPI D-Bus 调用全在 rust-helper/src/atspi.rs（Phase B cfg-gate 实装）。
 *
 * method 名前缀 atspi_* 与 macOS ax_* / Win uia_* 区分（Rust 端 main.rs
 * dispatch 据方法名路由：cfg(target_os = "linux") 调 atspi::snapshot）。
 *
 * macOS-only 现实红线（parse11 §1.3）：本 class 在 TS 端永远可实例化，但运行时
 * 若 Rust 端不在 Linux target，rust.call("atspi_*") 会返 ok=false +
 * error_kind="not_linux"（rust-helper/src/main.rs Phase B 加）。
 */
export class LinuxAtspiBackend implements AxBackend {
  constructor(private readonly rust: RustBridge) {}

  async snapshot(
    app: string | undefined,
    maxDepth: number,
  ): Promise<RustResponse> {
    return this.rust.call("atspi_snapshot", { app, max_depth: maxDepth });
  }

  async find(
    app: string | undefined,
    maxDepth: number,
    where: WhereClause,
  ): Promise<RustResponse> {
    return this.rust.call("atspi_find", {
      app,
      max_depth: maxDepth,
      where,
    });
  }

  async act(actions: DesktopOptions["actions"]): Promise<RustResponse> {
    return this.rust.call("atspi_act", { actions });
  }
}

// ============================================================
// AxBackendFactory 类型别名（v0.3.5 占位）已迁出
// ============================================================
// v1.0：工厂真实 class 在 src/desktop/AxBackendFactory.ts（parse11 §3.1 + INV-60
// 单一真源）。本文件只导出三 backend class + AxBackend interface + AxBackendKind type。
