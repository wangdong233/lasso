/**
 * AxBackend 接口（parse4 §2.1 + §3.2 + D5 平台隔离）
 *
 * 抽象层：把 AXAPI（macOS）/ UIA（Windows）/ AT-SPI（Linux）三套不同平台 API
 * 收敛到同一组方法签名（snapshot / find / act）。AxProvider（业务层）只依赖
 * 本接口，不关心背后是哪个平台实现。
 *
 * v0.3.5 实装范围：
 *  - MacAxBackend（唯一实现；经 RustBridge 调 rust-helper binary）
 *
 * v0.9.5+ 实装范围（注释占位，D5 平台隔离，parse4 §1.2）：
 *  - WinUiaBackend（Windows UI Automation，UIAutomationClient.dll）
 *  - LinuxAtspiBackend（Linux AT-SPI2，libatspi）
 *
 * INV-21（F3.9.9 f）：本文件只定义抽象接口，不出现平台 API 字面量
 * （AXUIElement / CGEvent / UIAutomationClient / libatspi 等都不进）。
 * 实现细节（具体的 platform API 调用）在 rust-helper/src/*.rs 完成。
 *
 * 借鉴：08 §3.1.3 分层；13 §2.4 R-CI-02；Desktop-pilot 4 层 Router
 * 抽象（本接口对应其中 platform 层）。
 */
import type {
  DesktopOptions,
  WhereClause,
} from "./desktop-types.js";
import type { RustResponse } from "../subprocess/RustBridge.js";

// ============================================================
// AxBackend 接口
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

// ============================================================
// MacAxBackend（v0.3.5 唯一实现）
// ============================================================
/**
 * macOS AXAPI 实现的 AxBackend（v0.3.5 唯一）。
 *
 * 平台 API 隔离策略（INV-21 + D5）：
 *  - 本类不直接调任何 AXAPI / CGEvent 符号
 *  - 所有平台调用经 RustBridge.call("ax_snapshot" / "ax_find" / "ax_act")
 *  - 平台字面量（AXUIElement / CGEvent / AXPress 等）只存在于
 *    rust-helper/src/*.rs
 *
 * 实装时机：Phase B 本文件仅占位（仅类型 + 注释），AxProvider 直接持有
 * RustBridge 即可。Phase D（如有多 backend 需求）再让 AxProvider 走此接口。
 *
 * 当前实现：无（v0.3.5 单 backend，AxProvider 直接用 RustBridge）
 *   —— 文件存在是为了提前锁定接口形状，让 Phase D 加 Win/Linux 时不破坏
 *     现有依赖方（Open-closed）。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type { RustResponse } from "../subprocess/RustBridge.js";

/**
 * 占位类型：v0.9.5+ WinUiaBackend / LinuxAtspiBackend 实装时的注册键。
 * 当前 v0.3.5 仅 MacAxBackend 一档；多 backend 注册在 Phase D 落地。
 */
export type AxBackendKind =
  | "mac" // MacAxBackend（v0.3.5 唯一）
  // Phase D 占位（未实装；parse4 §1.2 + D5）：
  | "win_uia" // WinUiaBackend（Windows UI Automation；v0.9.5+）
  | "linux_atspi"; // LinuxAtspiBackend（AT-SPI2；v0.9.5+）

/**
 * AxBackend 工厂占位（v0.3.5 不用；Phase D 多平台时启用）。
 *
 * v0.3.5：AxProvider 构造时直接 new RustBridge(subproc, specName)，
 * 不走此工厂。保留此类型让 Phase D 增 backend 时调用方形状不变。
 */
export type AxBackendFactory = (kind: AxBackendKind) => AxBackend;
