/**
 * Forest 调度层共享类型（parse5 §3.1.1）
 *
 * forest 是「在 BrowseChannel / DesktopChannel **之上**的薄调度层」
 * （13 §2.4 R-CI-02：兄弟不是父子；parse5 §3.1）。
 *
 * 铁律（INV-26 衍生，R-CI-02 守护）：
 *  - 本文件**不 import** 任何 channel 模块（BrowseChannel / DesktopChannel /
 *    HeadlessChannel / LoggedInChannel / AxProvider / ScreenshotVlmProvider / ...）。
 *    Forest 只定义抽象数据结构；channel 实例在 InteractDispatcher 构造期注入。
 *  - RootInfo 不携带 channel 实例引用（INV-19 同范式：dataModel 不带 surface 字段）。
 *
 * INV-29（parse5 §2.3，INV-21 衍生）：本文件无 AXUIElement / CGEvent / MCP frameId
 *                                 平台字面量。所有平台调用经 rust-helper。
 *
 * 借鉴（parse5 §3.1.6 借鉴源表）：
 *  - 12 §1.2(F) injaneity state.ts storeWindowRef/storeBrowserRootRef 的
 *    identity→ref 复用 map 模式
 *  - 13 §3.2 OutlineNode 同形异源（同一形状，不渗 surface）
 *  - 13 §3.3 v0.4+ 「共享 nextRootRefIndex 单计数器」承诺
 */
import type { ExpectCondition, InteractResult } from "../types.js";

// ============================================================
// RootRef —— model 用来回指 root 的短指针
// ============================================================
/**
 * Root 唯一短指针。
 *  - `@pN` 表示 browse page（CDP page context）
 *  - `@wN` 表示 desktop window（macOS AX window）
 *
 * 字面形状：`/^@[pw]\d+$/`
 *
 * 单计数器（parse5 §3.1.2）：N 在 @p / @w 前缀之间**共享**单一 `nextRootRefIndex`
 * 计数器（即可能出现 `@p0 / @w1 / @p2 / @w3` 这样的交替递增序列）。
 * 双前缀只是让 model 在输出中能直接区分 surface（13 §3.3）；不分裂成
 * nextPageRefIndex + nextWindowRefIndex 是 injaneity 模式的核心简化。
 */
export type RootRef = string;

/** Root 来源种类（仅描述 + 路由用，不参与 channel 内部决策）。 */
export type RootKind = "browser_page" | "window";

/**
 * Root 身份哈希输入（用于 identity→ref 复用 map，parse5 §3.1.2）。
 *
 * 稳定身份规则：
 *  - browser_page : sha1(`{cdpContextId}|{url}`)（同 url 重开 → 同 @pN）
 *  - window       : sha1(`{bundleId}|{pid}|{windowId}`)（同 window 重查询 → 同 @wN）
 *
 * identity 由 **channel 自己算好**（BrowseChannel 算 cdpContextId|url；
 * DesktopChannel 算 bundleId|pid|windowId）——抽象层不渗 channel 内部。
 */
export interface RootIdentity {
  kind: RootKind;
  /** 稳定身份哈希（同 url 重开 → 同 @pN；同 window 重查询 → 同 @wN）。 */
  identity: string;
}

/**
 * 单个 Root 的元信息（interact_roots 返回给 model 的元素）。
 *
 * INV-19 衍生：不携带 channel 实例引用；`source` 字段是 channel 标签，
 * InteractDispatcher 据此反查 channel（不暴露 channel 对象给 model）。
 *
 * 命名约定（与 ProviderConfig.name / channel.name 对齐）：
 *  - browser_page.source : "browse_headless" / "browse_logged_in"（v0.4 加 "browse_cloud_browserbase"）
 *  - window.source       : "desktop"
 */
export interface RootInfo {
  rootRef: RootRef;
  kind: RootKind;
  /** browser_page: page title 或 url；window: "{app}: {window title}" */
  title: string;
  /** browser_page: url（dispatcher 据此 navigate）；window: undefined */
  subtitle?: string;
  /**
   * channel 来源标签（InteractDispatcher.channels Map 的 key）。
   * 与 channel.name 一致；用于 dispatcher 反查 channel 实例。
   */
  source: string;
}

/**
 * InteractTask —— interact_observe / interact_act 的最小任务单元。
 *
 * 按 rootRef 前缀 dispatch 到对应 channel：
 *  - @pN → BrowseChannel.browse(url, action, options) 或 BrowseChannel.runExpect
 *  - @wN → DesktopChannel.observe / act / wait
 *
 * action 词汇与各 channel 共享（snapshot / find / act / wait / ...）；
 * 内联差异率 ~86%（13 §3.1）—— 罕见不同构 action 由 dispatcher 转译。
 */
export interface InteractTask {
  rootRef: RootRef;
  /** "snapshot" / "find" / "act" / "wait" / "navigate" / ... */
  action: string;
  /** channel 特定选项（透传，dispatcher 不解释）。 */
  options: Record<string, unknown>;
  /** 可选后置条件（act/wait 路径用；与 BrowseChannel.runExpect 同形状）。 */
  expect?: ExpectCondition;
}

/**
 * interact_observe / interact_act 返回的统一信封。
 * 复用 InteractResult<T>，保持与各 channel 同形交付（parse4 §3.1.2）。
 */
export type InteractEnvelope<T = unknown> = InteractResult<T>;

// ============================================================
// 形状校验（用于单测 + doctor 自检；非 zod，零依赖）
// ============================================================
/** RootRef 形状校验：`@pN` 或 `@wN`。 */
export function isRootRef(v: unknown): v is RootRef {
  if (typeof v !== "string") return false;
  return /^@[pw]\d+$/.test(v);
}

/** RootKind 形状校验。 */
export function isRootKind(v: unknown): v is RootKind {
  return v === "browser_page" || v === "window";
}

/** RootInfo 形状校验（守护 wire-shape 不漂移）。 */
export function isRootInfo(v: unknown): v is RootInfo {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isRootRef(r.rootRef) &&
    isRootKind(r.kind) &&
    typeof r.title === "string" &&
    typeof r.source === "string" &&
    (r.subtitle === undefined || typeof r.subtitle === "string")
  );
}
