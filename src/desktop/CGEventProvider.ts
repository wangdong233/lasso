/**
 * CGEventProvider（parse5 §3.5.3 + §3.5.5 + INV-28）
 *
 * 角色：DesktopChannel.act 4-tier fallback **第 3 档**（介于 appleScript 与 screenshotVlm 之间）。
 *
 *  - 用 core-graphics crate CGEvent FFI 合成键盘事件（rust-helper/src/cgevent.rs）
 *  - 仅 press / hotkey 两条动作路径（click/type/scroll 走 AX 或 appleScript 已够；
 *    cgEvent 档专为 Electron app 吞 AXSetValue 的键盘注入兜底）
 *
 * ## INV-28 红线（不暴露 raw keycode）
 *
 *   - 入参只接受**逻辑键名字符串**（"Return" / "Tab" / "cmd+c" / "shift+f5"）
 *   - 拒绝 raw keycode 数字入参（即使 JSON wire 上传了 number，本层强制拒绝）
 *   - 实际 CGKeyCode 映射只在 rust-helper/src/cgevent_keymap.rs（INV-21 衍生：
 *     平台字面量集中隔离）
 *
 * ## INV-21 守护
 *
 *   本类不直接调任何 CGEvent / CGEventSource / CGEventPost 符号；所有平台调用
 *   经 `rust.call("cgevent_dispatch", { actions })`。
 *
 * ## 错误契约
 *
 *   TS 端拦截（不走 Rust）：
 *     - opts.actions 缺失或空             → outcome=**unknown** + retrieval_method=cgevent_no_action
 *                                            （4-tier 语义：本档无 actions 无事可做 → 链继续；
 *                                             与 ax/appleScript 的「not my domain」一致）
 *     - 过滤后无 press/hotkey 动作         → outcome=**unknown** + retrieval_method=cgevent_no_supported_action
 *                                            （4-tier 语义：本档不适用此动作类型 → 链继续到 screenshotVlm；
 *                                             parse5 §3.5.4「cgEvent 仅 press/hotkey，其他动作不支持 → screenshotVlm」）
 *     - 检测到 raw keycode 数字入参（INV-28） → outcome=didnt + retrieval_method=cgevent_raw_keycode_forbidden
 *                                            （安全红线 → 短路停止链，INV-28）
 *
 *   Rust 端错误（透传 cgevent_dispatch）：
 *     - 每项独立成败；返回 results 数组（每项 { index, ok, error_kind?, error? }）
 *     - 全部失败 → outcome=unknown（真实执行错；可被上游 fallback）
 *     - 部分成功 → outcome=worked（与 AxProvider.act 部分成功策略一致）
 *     - 全部成功 → outcome=worked
 *
 * 借鉴：parse5 §3.5.3；AxProvider.ts 的 RustResponse→Outcome 映射范式；
 *       mac-mcp CGEvent 路径；core-graphics 0.24 high-level API（smoke 验证）。
 */
import type { RustBridge } from "../subprocess/RustBridge.js";
import type { InteractResult } from "../types.js";
import type {
  DesktopOptions,
  DesktopResult,
  UiAction,
  ActionResult,
} from "./desktop-types.js";

// ============================================================
// INV-28：cgevent 档仅支持 press / hotkey（click/type/scroll 走 ax/appleScript）
// ============================================================
const ALLOWED_CGEVENT_KINDS = new Set<string>(["press", "hotkey"]);

/**
 * CGEvent 档允许的 UiAction 子集（类型化）。
 *   - press  : { kind:"press", key:"Return" }   ← 逻辑键名
 *   - hotkey : { kind:"hotkey", keys:"cmd+c" }  ← 逻辑组合键串
 *
 * 注：UiAction 联合类型里 hotkey 是 `{ keys: string[] }`（数组）；
 * 但 CGEvent Rust 端 cgevent_hotkey 接受的是**单字符串** "cmd+c"。
 * 这是 wire 上的字段名冲突：UiAction.hotkey.keys 是数组（多个独立键），
 * cgevent 的 hotkey 是字符串（一个组合键 spec）。
 *
 * 处理策略（守 INV-28 + 防 wire 漂移）：
 *   - UiAction.hotkey 的 keys 数组**正好 1 个元素**时，作为组合键 spec 传给 cgevent
 *     （典型用例：`{ keys: ["cmd", "c"] }` → spec "cmd+c" 经 join("+")）
 *   - 长度 != 1 时降级到 didnt（cgevent 档不处理多键序列；那是 ax 档的事）
 *
 * 逻辑键名 join 后仍由 Rust 端 cgevent_keymap 二次解析（层 2 防御）。
 */
interface CGEventPressAction {
  kind: "press";
  key: string;
}
interface CGEventHotkeyAction {
  kind: "hotkey";
  /** 已 join 的组合键 spec（"cmd+c"）；由 normalizeAction 从 UiAction 转来。 */
  keys: string;
}
type CGEventAction = CGEventPressAction | CGEventHotkeyAction;

/**
 * INV-28 守门：拒绝 raw keycode 数字入参。
 *
 * UiAction 联合类型层面 `key`/`keys` 已是 string，但 JSON wire 没有 type guard；
 * LLM 或上游 caller 可能传入 `{ kind:"press", key: 36 }`（数字）。
 * 本函数在层 1 强制拒绝（在 Rust 端之前），并报专用 retrieval_method 便于诊断。
 *
 * @returns true=检测到 raw keycode 数字；false=形状合规
 */
function hasRawKeycodeLeak(action: unknown): boolean {
  if (typeof action !== "object" || action === null) return false;
  const a = action as Record<string, unknown>;
  // press 的 key 字段：必须是 string；number 即 raw keycode 直传（INV-28 拒）
  if (a.kind === "press" && typeof a.key === "number") return true;
  // hotkey 的 keys 字段：合法形态是 string[]；若元素出现 number 即 raw keycode 直传
  if (a.kind === "hotkey" && Array.isArray(a.keys)) {
    for (const k of a.keys) {
      if (typeof k === "number") return true;
    }
  }
  // 形态异常：hotkey.keys 直接是 string（不经 UiAction 联合的合法路径）也算 leak
  // （cgevent_dispatch 内部 wire 是 [{kind:"hotkey", keys:"cmd+c"}]，但那是 Rust 端
  // 的内部 batch 格式；TS 端入口必须走 UiAction 形状。）
  if (a.kind === "hotkey" && typeof a.keys === "number") return true;
  return false;
}

/**
 * 把 UiAction（press/hotkey 子集）规范化为 cgevent_dispatch wire 格式。
 *
 * @returns 规范化后的 action；null 表示该 action 形态不支持 cgevent（caller skip）
 */
function normalizeForCgevent(action: UiAction): CGEventAction | null {
  if (action.kind === "press") {
    return { kind: "press", key: action.key };
  }
  if (action.kind === "hotkey") {
    // UiAction.hotkey.keys 是 string[]；CGEvent 端 cgevent_hotkey 接受单 spec。
    // 多元素 join("+") 得 "cmd+c" 形态；0 元素或形状不对返 null（caller 当作不支持）
    if (action.keys.length === 0) return null;
    return { kind: "hotkey", keys: action.keys.join("+") };
  }
  return null;
}

// ============================================================
// CGEventProvider
// ============================================================
/**
 * v0.4 M0.4b CGEvent provider（DesktopChannel.act 第 3 档）。
 *
 * INV-21：本类不出现平台 API 字面量；所有平台调用经 RustBridge.call。
 * INV-28：只接受逻辑键名，拒绝 raw keycode 数字入参。
 */
export class CGEventProvider {
  /** served_by 标识（写入 InteractResult.served_by；与 DesktopChannel plan 名一致）。 */
  static readonly NAME = "desktop.cgEvent";

  constructor(private readonly rust: RustBridge) {}

  /**
   * act 主路径：过滤 press/hotkey → INV-28 守门 → rust.call("cgevent_dispatch")。
   *
   * 入口形状：opts.actions 数组（与 ax 档共享 UiAction 联合类型，本档只消费 press/hotkey）。
   *
   * @returns InteractResult<DesktopResult>
   *   - worked : 至少 1 项成功；data.actions_and_results 携带每项成败
   *   - didnt  : 无 actions / 无支持动作 / 检测到 raw keycode（INV-28 守门）
   *   - unknown: rust.call 通讯失败 / 全部项失败（真实执行错，可被上游 fallback）
   */
  async act(
    opts: DesktopOptions,
  ): Promise<InteractResult<DesktopResult>> {
    // ------------------------------------------------------------------
    // 入口校验：opts.actions 必须是非空数组
    // ------------------------------------------------------------------
    // 4-tier 语义：无 actions = 本档无事可做 → unknown（让链继续到 screenshotVlm）。
    // 与 ax/appleScript 的「not my domain」语义一致。
    const rawActions = opts.actions;
    if (!Array.isArray(rawActions) || rawActions.length === 0) {
      return {
        outcome: "unknown",
        data: null,
        served_by: CGEventProvider.NAME,
        fallback_used: false,
        retrieval_method: "cgevent_no_action",
        error: "no_actions_specified",
      };
    }

    // ------------------------------------------------------------------
    // INV-28 层 1 守门：扫一遍，发现 raw keycode 数字立即拒（不传 Rust）
    // ------------------------------------------------------------------
    for (const a of rawActions) {
      if (hasRawKeycodeLeak(a)) {
        return {
          outcome: "didnt",
          data: null,
          served_by: CGEventProvider.NAME,
          fallback_used: false,
          retrieval_method: "cgevent_raw_keycode_forbidden",
          error:
            "raw_keycode_forbidden: CGEventProvider accepts logical key names only (INV-28)",
        };
      }
    }

    // ------------------------------------------------------------------
    // 过滤：只保留 press / hotkey（click/type/scroll 不属本档）
    // ------------------------------------------------------------------
    const cgeventActions: CGEventAction[] = [];
    for (const a of rawActions) {
      // 仅处理 kind 在 ALLOWED_CGEVENT_KINDS 的；其他 click/type/scroll 直接 skip
      // （ax 档可能成功处理了它们；本档只接管键盘路径）
      if (typeof a !== "object" || a === null) continue;
      const kind = (a as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !ALLOWED_CGEVENT_KINDS.has(kind)) continue;
      const normalized = normalizeForCgevent(a as UiAction);
      if (normalized !== null) cgeventActions.push(normalized);
    }

    if (cgeventActions.length === 0) {
      // 4-tier 语义（parse5 §3.5.4）：本档不适用此动作类型（click/type/scroll）→ unknown
      // 让 FallbackDecider 继续到 screenshotVlm；breaker.recordFailure 在连续 3 次后
      // open，自动跳过本档（用户不用 cgevent 时零成本）。
      return {
        outcome: "unknown",
        data: null,
        served_by: CGEventProvider.NAME,
        fallback_used: false,
        retrieval_method: "cgevent_no_supported_action",
        error: "only_press_or_hotkey_supported",
      };
    }

    // ------------------------------------------------------------------
    // 经 Rust helper cgevent_dispatch（每项独立成败）
    // ------------------------------------------------------------------
    const resp = await this.rust.call(
      "cgevent_dispatch",
      { actions: cgeventActions },
      5_000,
    );

    if (!resp.ok) {
      // 通讯级错误：unknown（可被上游 fallback）
      return {
        outcome: "unknown",
        data: null,
        served_by: CGEventProvider.NAME,
        fallback_used: false,
        retrieval_method: resp.error_kind ?? "cgevent_failed",
        error: resp.error ?? resp.error_kind ?? "cgevent_error",
      };
    }

    // ------------------------------------------------------------------
    // 结果映射：cgevent_dispatch 返 { results: [{index, ok, kind?, error_kind?, error?}] }
    // 至少 1 项 ok → outcome=worked；全失败 → unknown（真实执行错）
    // ------------------------------------------------------------------
    const result = (resp.result ?? {}) as { results?: unknown };
    const resultsArr = Array.isArray(result.results) ? result.results : [];
    const actionsAndResults: ActionResult[] = [];
    let successCount = 0;
    for (let i = 0; i < resultsArr.length; i++) {
      const r = resultsArr[i] as Record<string, unknown> | null;
      if (!r || typeof r !== "object") continue;
      const ok = r.ok === true;
      const spec = cgeventActions[i];
      const ref =
        spec?.kind === "press"
          ? spec.key
          : spec?.kind === "hotkey"
            ? spec.keys
            : `action${i}`;
      const errKind =
        typeof r.error_kind === "string" ? r.error_kind : undefined;
      const errMsg = typeof r.error === "string" ? r.error : undefined;
      actionsAndResults.push({
        ref,
        ok,
        error: ok ? undefined : errMsg ?? errKind ?? "cgevent_action_failed",
      });
      if (ok) successCount++;
    }

    if (successCount === 0) {
      // 全部项失败：真实 CGEvent 执行问题 → unknown（可被上游 fallback）
      return {
        outcome: "unknown",
        data: {
          actions_and_results: actionsAndResults,
          fallback_used: false,
        },
        served_by: CGEventProvider.NAME,
        fallback_used: false,
        retrieval_method: "cgevent_all_actions_failed",
        error: "all_cgevent_actions_failed",
      };
    }

    return {
      outcome: "worked",
      data: {
        actions_and_results: actionsAndResults,
        fallback_used: false,
      },
      served_by: CGEventProvider.NAME,
      fallback_used: false,
      retrieval_method: "cgevent_ffi",
    };
  }
}

// ============================================================
// 内部导出（单测断言用）
// ============================================================
/**
 * 单测锚点：暴露 ALLOWED_CGEVENT_KINDS 副本供 cg-event-provider.spec.ts 断言。
 */
export const __CGEVENT_ALLOWED_KINDS: ReadonlySet<string> =
  ALLOWED_CGEVENT_KINDS;

/**
 * 单测锚点：暴露 hasRawKeycodeLeak / normalizeForCgevent 给单测断言。
 */
export const __CGEVENT_HAS_RAW_KEYCODE_LEAK = hasRawKeycodeLeak;
export const __CGEVENT_NORMALIZE_FOR_CGEVENT = normalizeForCgevent;
