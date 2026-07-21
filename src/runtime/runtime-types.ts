/**
 * runtime-types.ts —— v0.6 runtime 能力袋共享类型（parse7 §3.1）
 *
 * 纯类型模块，无运行时依赖。
 *
 * 设计：runtime/ 是 v0.6 新模块，独立于 v0.5 静态装配层。本文件集中
 * capability bag / tool manager / caller-tier tracker / hot-reload 共用的
 * 类型定义，类比 types.ts 是 ProviderConfig 等共享类型的单一真源。
 *
 * 守 INV-35（task v0.6 Phase A 版本）：runtime/ 不 import BrowseChannel /
 * DesktopChannel internal —— 本文件只定义数据形状，不持有 channel class
 * 引用，避免把 channel 内部细节渗到 runtime 层。
 *
 * 关键类型：
 *  - CapabilityState   : 能力袋单条状态（不可变 name + 可变 enabled + audit 字段）
 *  - CapabilityKind     : "channel" | "provider"（"." 命名空间判别）
 *  - CallerBudget       : per-caller 滑动窗配额（复用 QuotaLedger._refreshState 范式）
 *  - CapabilityChangeHandler : bag.onChange 回调签名（async 链式）
 *  - AdminAction        : admin tool action-enum union（v0.6 Phase A 类型占位；
 *                          admin.ts 实装在 M0.6a 末期，此类型先冻结）
 *  - ToolRecord         : ToolManager 内部 record 形状（保存 RegisteredTool 句柄）
 *
 * 借鉴源（parse7 §3.1）：
 *  - 状态机形状 ≈ QuotaLedger 的 KeyState（不可变 name + 可变 enabled/exhausted）
 *  - onChange 模式 ≈ Node EventEmitter，但用 await handler 链（保证 tool 下架
 *    完成 admin tool 才返回；EventEmitter 不支持 await）
 */
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

// ============================================================
// CapabilityState（parse7 §3.1）
// ============================================================
/**
 * 能力袋单条状态。
 *
 *  - name        : channel 或 provider 名（"browse_headless" / "search.brave" / "desktop.cgEvent"）
 *  - kind        : 由命名约定推断（含 "." 视为 provider 级；否则 channel 级）
 *  - enabled     : 运行时状态（构造期必为 true；零回归承诺）
 *  - disabledAt  : 最近一次 disable 的 epoch ms（audit log 用）
 *  - disabledBy  : 谁禁用的（callerId / "system" / "admin" / "hot_reload"）
 *  - reason      : 自由文本理由（audit log 用，强制 admin tool 传值）
 *
 * INV-36（task v0.6）：CapabilityBag 只能在已 register 的 name 上 enable/disable；
 *                     未注册名返 false 不凭空造 channel。
 * INV-40（parse7 §5.1）：constructor 初始化所有 entry enabled=true（禁 enabled:false 初始值）。
 */
export type CapabilityKind = "channel" | "provider";

export interface CapabilityState {
  readonly name: string;
  readonly kind: CapabilityKind;
  enabled: boolean;
  disabledAt?: number;
  disabledBy?: string;
  reason?: string;
}

// ============================================================
// CapabilityChangeHandler（parse7 §3.1）
// ============================================================
/**
 * CapabilityBag 状态变更回调签名。
 *
 * index.ts 装配时挂上：disable 联动 ToolManager.disableChannel + SubprocessManager.shutdownOne；
 * enable 联动 ToolManager.enableChannel（不主动 spawn —— channel 内部懒启动）。
 *
 * 返回 Promise 以支持 await handler 链（保证 disable 完成后 admin tool 才返回）。
 */
export type CapabilityChangeHandler = (
  name: string,
  enabled: boolean,
  state: CapabilityState,
) => void | Promise<void>;

// ============================================================
// CallerBudget（parse7 §3.3）—— per-caller 滑动窗配额
// ============================================================
/**
 * 单 caller 的 60s 滑动窗预算。
 *
 *  - callerId      : MCP request _meta.callerId；CC 不传则 fallback "anonymous"
 *  - windowStart   : 当前窗口起点 epoch ms（窗口过期后由 _refreshWindow 重置）
 *  - used          : 窗口内已用调用数
 *  - cap           : 该 caller 上限（per-caller override 或 defaultCap）
 *  - lastExceeded  : 上次拒绝时间（doctor 显示用）
 *
 * INV-38（task v0.6）：滑动窗逻辑必须复用 QuotaLedger._refreshState 同范式
 *                     （windowStart + used 衰减），禁 token bucket / GCRA / leaky bucket。
 *                     defaultCap 必须是模块顶级 const，可被 LASSO_CALLER_CAP_DEFAULT 覆盖。
 */
export interface CallerBudget {
  readonly callerId: string;
  windowStart: number;
  used: number;
  cap: number;
  lastExceeded?: number;
}

// ============================================================
// CallerSnapshot（doctor + admin 工具显示用，脱敏）
// ============================================================
/**
 * admin caller_cap_list / doctor 显示用的脱敏 snapshot（不暴露内部 windowStart）。
 */
export interface CallerSnapshot {
  callerId: string;
  used: number;
  cap: number;
  windowMs: number;
}

// ============================================================
// ToolRecord（parse7 §3.2 ToolManager 内部）
// ============================================================
/**
 * ToolManager 内部 record：保存 RegisteredTool 句柄 + channel 归属 + 重新注册
 * 所需的元数据（hot-plug 移除后重新注册用）。
 *
 * INV-37（task v0.6）：channel disable 必经 ToolManager.disableChannel；
 *                     禁 runtime/ 内直接 server.tool 操作绕过 ToolManager。
 */
export interface ToolRecord {
  readonly name: string;
  /** owning channel（"browse_headless" / "desktop" / "admin" 等） */
  readonly channel: string;
  /** SDK 句柄（含 disable/enable/remove/update） */
  readonly registered: RegisteredTool;
  readonly annotations: object;
  readonly schema: unknown;
  readonly description: string;
  readonly handler: (...args: unknown[]) => Promise<unknown>;
}

// ============================================================
// HotReloadConfig（parse7 §3.6）
// ============================================================
/**
 * 热更新输入：从 LASSO_PROVIDERS_FILE 读出的 JSON 形状。
 *
 * 与 BUILTIN_PROVIDERS 平行：providers 数组就是 ProviderConfig[]。
 */
export interface HotReloadConfig {
  providers: import("../types.js").ProviderConfig[];
}

// ============================================================
// AdminAction（parse7 §3.5 admin tool action-enum；v0.6 Phase A 类型占位）
// ============================================================
/**
 * admin 工具 action union（parse7 §3.5 折叠 enum）。
 *
 * v0.6 Phase A：仅类型定义；admin.ts 实装在 M0.6a 末期（admin capability_list/tool_list）
 * 与 M0.6b/M0.6c 剩余 actions。type 先冻结便于 CallerTierTracker.setCap 等接受 admin 入参。
 *
 * 折叠原则（13 §3.1 #1 必改）：单 admin tool + action enum，禁注册 admin_capability_disable
 * 等拆分 tool（与 INV-17 desktop action-enum 同范式）。
 */
export type AdminAction =
  | "capability_list"
  | "capability_disable"
  | "capability_enable"
  | "tool_list"
  | "provider_add"
  | "provider_remove"
  | "provider_set_tos"
  | "caller_cap_set"
  | "caller_cap_list";
