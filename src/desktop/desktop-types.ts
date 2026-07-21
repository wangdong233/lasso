/**
 * Desktop channel 共享类型（parse4 §2.1 + §3.2.1 + §4.3）
 *
 * 本文件是 DesktopChannel（Phase C 落地）+ AxProvider / ScreenshotVlmProvider
 * （Phase B 本阶段落地）共享的类型单一真源。纯类型 + Zod schema 校验，
 * 无运行时平台依赖。
 *
 * INV-21（F3.9.9 f）：本文件严禁出现平台 API 字面量
 * （如 AXUIElement / CGEvent / AXPress / AXUIElementCreateSystemWide）。
 * 平台字面量全部隔离在 rust-helper/src/*.rs。TS 层只谈抽象：
 *   - OutlineNode（标准化 UI 节点，DOM-like role）
 *   - UiAction（点击 / 输入 / 按键 / 滚动 / 热键的抽象描述）
 *   - 经 RustBridge.call(method, params) 调 Rust helper
 *
 * 借鉴：12 F.1 injaneity actions.ts 的 outcome-first 风格；pi-computer-use
 * 的 tri-state / expect 后置；08 §3.1.3 分层；13 §2.4 R-CI-02（兄弟不是父子）。
 */

// ============================================================
// Rect（几何矩形；与 Rust 端 AxRect 镜像，parse4 §3.1.4）
// ============================================================
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ============================================================
// AxNode（Rust helper ax_snapshot 返回的原始树节点，镜像 ax.rs AxNode）
// ============================================================
/**
 * Rust helper walk() 产出的树节点，经 JSON-lines 协议原样透传到 TS 层。
 * 镜像 rust-helper/src/ax.rs::AxNode（field-by-field 同名同类型）。
 *
 *  - role     : 已映射的 unified role（"button"/"img"/...，由 Rust 端 map_ax_role 输出）
 *  - raw_role : 原 AXRole 字符串（debug/诊断用，**不进 OutlineNode 接口**）
 *  - label    : 节点标题（AXTitle；无则空串）
 *  - rect     : 屏幕坐标 + 尺寸（左上角原点）
 *  - enabled / focused : 状态位
 *  - depth    : 0-based 深度（root=0）
 *  - children : 子节点数组（max_depth 截断处为空数组）
 *
 * INV-21 注：role 字段值是已映射的 DOM-like unified role（如 "button"），
 * 不是平台字面量（"AXButton" 等）。raw_role 字段是诊断数据通道，
 * 值由 Rust 端写入，TS 层不主动构造也不基于它做控制流决策。
 */
export interface AxNode {
  role: string;
  raw_role: string;
  label: string;
  rect: Rect;
  enabled: boolean;
  focused: boolean;
  depth: number;
  children: AxNode[];
}

// ============================================================
// OutlineNode（标准化 UI 节点，OutlineMapper.axTreeToOutline 输出）
// ============================================================
/**
 * AxNode 经 OutlineMapper 标准化后的 DOM-like 节点。
 *
 * 设计要点：
 *  - ref        : 短指针（"@e0" / "@e1" ...），由 OutlineMapper 单调分配；
 *                 CC 用 ref 在 find/act 里回指节点，不必重传整树。
 *  - pictureOnly: 三启发式判定（parse4 §4.4）：
 *                   (1) role=img 且 rect > 100x100 且无 children
 *                   (2) role=unknown 且 rect > 100x100
 *                   (3) role=group 且 label 空且 rect > 100x100 且无 children
 *                 pictureOnly=true 的节点 click/type 不能 target；
 *                 唯一可用动作是 screenshotVlm 兜底。
 *
 * INV-19（F3.9.9 d）：OutlineNode 不携带 surface 字段（不分 browse/desktop），
 *                     同形异源，统一形状。
 * INV-21（F3.9.9 f）：OutlineNode 字段名 + 类型不含平台 API 字面量。
 */
export interface OutlineNode {
  role: string;
  label: string;
  ref: string;
  rect: Rect;
  pictureOnly: boolean;
  children: OutlineNode[];
}

// ============================================================
// OutlineSnapshot（snapshot action 返回的完整快照）
// ============================================================
/**
 * stateId 用于后续 find/act/wait 回指（StateStore LRU 缓存的 key）。
 * root 是 OutlineNode 树根（已映射 + 已分配 ref）。
 * createdAt 用于 LRU 淘汰 + doctor 报告。
 */
export interface OutlineSnapshot {
  stateId: string;
  root: OutlineNode;
  createdAt: number;
}

// ============================================================
// UiAction（act action 的 actions[] 元素联合类型）
// ============================================================
/**
 * 5 种动作的判别联合（kind 标签）：
 *  - click   : 点击 ref 指向的节点
 *  - type    : 在 ref 指向的输入框中输入 text
 *  - press   : 按单个键（"Return" / "Tab" / "Escape" ...）
 *  - scroll  : 在 ref 节点上滚动 dx/dy
 *  - hotkey  : 组合键（如 ["cmd", "c"]）
 *
 * INV-21 注：press / hotkey 的 key 名是逻辑键名（DOM/keyboard 抽象），
 * 实际平台键码合成在 Rust helper 完成，TS 层不经手平台事件 API。
 */
export type UiAction =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; ref: string; dx: number; dy: number }
  | { kind: "hotkey"; keys: string[] };

// ============================================================
// WhereClause（find action 的查询条件）
// ============================================================
export interface WhereClause {
  text?: string;
  role?: string;
  ref?: string;
}

// ============================================================
// ExpectCondition（act/wait 的后置条件 tri-state，parse4 §3.3）
// ============================================================
export interface DesktopExpect {
  text?: string;
  role?: string;
  ref?: string;
  gone?: boolean;
  timeout_ms?: number;
}

// ============================================================
// DesktopOptions（desktop tool options 形状）
// ============================================================
/**
 * desktop tool 单工具 action-enum 折叠后的 options（parse4 §3.3.1 zod schema 镜像）。
 * 各 action 仅消费自己关心的字段，其余忽略。
 *
 * v0.4 M0.4b 加（parse5 §3.5.2 + §3.5.3）：
 *  - appleScriptAction  : typed action enum 字符串（AppleScriptProvider 入口）
 *  - appleScriptParams  : Record<string, unknown>（appleScript 模板参数）
 *  - cgEventKey         : 占位字段（cgevent 档实际从 actions[] 读 press/hotkey）；
 *                         保留为白名单字段供 zod schema 校验 + INV-28 grep 锚点
 *                         （值类型强制 string；raw keycode 数字入参由 CGEventProvider
 *                          层 1 + Rust 端 cgevent_keymap 双向拒绝）
 *
 * INV-22（v0.4 解除）：appleScriptAction 必须经 apple-script-whitelist.ts 校验，
 *                     禁 raw 脚本串（详见 AppleScriptProvider.ts）。
 * INV-28：cgevent 路径只接受逻辑键名（"Return" / "cmd+c"）；raw keycode 数字禁入。
 */
export interface DesktopOptions {
  app?: string;
  state_id?: string;
  max_depth?: number;
  actions?: UiAction[];
  expect?: DesktopExpect;
  where?: WhereClause;
  screenshot_region?: Rect;
  timeout_ms?: number;
  picture_only?: boolean;
  // ------------------------------------------------------------------
  // v0.4 M0.4b：appleScript / cgEvent 档字段（parse5 §3.5）
  // ------------------------------------------------------------------
  /**
   * AppleScript typed action 名（必须在 APPLE_SCRIPT_WHITELIST 中）。
   * INV-22（v0.4 解除）：缺此字段 AppleScriptProvider 返 didnt + applescript_no_action。
   */
  appleScriptAction?: string;
  /**
   * AppleScript 模板参数（key 必须是 action 对应 allowedParams 的子集）。
   * 由 AppleScriptProvider 层 1 校验；Rust 端再独立校验（纵深防御）。
   */
  appleScriptParams?: Record<string, unknown>;
  /**
   * CGEvent 档逻辑键名（INV-28 锚点字段）。
   * 实际生产路径走 actions[] 里的 press/hotkey；此字段保留为 zod 校验锚点 +
   * doctor 自检锚点。**类型强制 string**：raw keycode 数字入参由层 1 拒绝。
   */
  cgEventKey?: string;
}

// ============================================================
// DesktopResult（act/wait/screenshot action 返回的数据形状）
// ============================================================
export interface ActionResult {
  ref: string;
  ok: boolean;
  error?: string;
}

export interface DesktopResult {
  actions_and_results: ActionResult[];
  expect_verified?: boolean;
  screenshot_base64?: string;
  screenshot_format?: "png";
  fallback_used?: boolean;
}

// ============================================================
// DesktopHealth（doctor 第 #15-#20 项检查结果摘要）
// ============================================================
export interface DesktopHealth {
  helperSigned: boolean;
  helperRunning: boolean;
  tccAccessibility: boolean;
  tccScreenRecording: boolean;
  axReadRateOk: boolean;
  vlmEndpointReachable: boolean;
}

// ============================================================
// schema 校验：用于单测 + doctor 自检（parse4 §5.2 desktop-options.spec.ts）
// ============================================================
/**
 * 轻量形状校验（非 zod；保持零依赖 + 完全可预测）。
 * 仅做结构性检查（字段存在 + 类型对），不做业务约束（业务约束在 zod schema）。
 * 单测用来守护 wire-shape 不漂移。
 */
export function isRect(v: unknown): v is Rect {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.w === "number" &&
    typeof r.h === "number"
  );
}

export function isAxNode(v: unknown): v is AxNode {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.role === "string" &&
    typeof n.raw_role === "string" &&
    typeof n.label === "string" &&
    isRect(n.rect) &&
    typeof n.enabled === "boolean" &&
    typeof n.focused === "boolean" &&
    typeof n.depth === "number" &&
    Array.isArray(n.children) &&
    (n.children as unknown[]).every(isAxNode)
  );
}

export function isOutlineNode(v: unknown): v is OutlineNode {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.role === "string" &&
    typeof n.label === "string" &&
    typeof n.ref === "string" &&
    isRect(n.rect) &&
    typeof n.pictureOnly === "boolean" &&
    Array.isArray(n.children) &&
    (n.children as unknown[]).every(isOutlineNode)
  );
}

export function isUiAction(v: unknown): v is UiAction {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  switch (a.kind) {
    case "click":
      return typeof a.ref === "string";
    case "type":
      return typeof a.ref === "string" && typeof a.text === "string";
    case "press":
      return typeof a.key === "string";
    case "scroll":
      return (
        typeof a.ref === "string" &&
        typeof a.dx === "number" &&
        typeof a.dy === "number"
      );
    case "hotkey":
      return (
        Array.isArray(a.keys) &&
        (a.keys as unknown[]).every((k) => typeof k === "string")
      );
    default:
      return false;
  }
}
