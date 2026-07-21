/**
 * AppleScriptProvider（parse5 §3.5.2 + §4.4 注入防御层 1 + INV-22 解除）
 *
 * 角色：DesktopChannel.act 4-tier fallback **第 2 档**（介于 ax 与 cgEvent 之间）。
 *
 *  - 仅 typed action enum 入口（parse5 §3.5.1 + INV-22 解除语义）
 *  - 经 RustBridge.call("applescript_run", { action, params }) 调 Rust helper
 *    osascript 子进程（rust-helper/src/applescript.rs）
 *  - Rust 端再次独立校验 action 在白名单 + params key 在 allowedParams
 *    （层 2 纵深防御，不信任 TS 端）
 *
 * ## 注入防御 3 层（parse5 §4.4）
 *
 *   层 1（本文件）：action 必须在 APPLE_SCRIPT_WHITELIST；params key 必须
 *                  是 allowedParams 子集；**不接受 `script` 字段**（F3.10.8）
 *   层 2（Rust applescript.rs）：再次校验 action + params key + 字符过滤
 *   层 3（编译期 applescript_whitelist.rs）：脚本字面量顶级 const 嵌入 binary
 *
 * ## INV-21 守护
 *
 *   本类不直接调任何 osascript / OSAKit / AppleEvent 符号；所有平台调用经
 *   `rust.call("applescript_run", ...)`。grep `osascript`/`OSAKit` 在本文件
 *   代码本体（去注释）应为 0。
 *
 * ## 错误契约
 *
 *   TS 端拦截（不走 Rust）：
 *     - opts.appleScriptAction 缺失 → outcome=**unknown** + retrieval_method=applescript_no_action
 *                                    （4-tier 语义：本档不适用此请求 → 链继续到 cgEvent；
 *                                     parse5 §3.5.4 「appleScript 不支持该动作 → cgEvent」）
 *     - action 不在白名单          → outcome=didnt + retrieval_method=script_not_in_whitelist
 *                                    （与 Rust error_kind 同名，便于上层一致处理；
 *                                     注入尝试 → 短路停止链，F3.10.8 红线）
 *     - params key 不在 allowedParams → outcome=didnt + retrieval_method=param_not_in_whitelist
 *                                    （注入尝试 → 短路停止链）
 *
 *   Rust 端错误（透传）：
 *     - error_kind=tcc_denied     → outcome=didnt（明确缺权限，不 fallback）
 *     - error_kind=not_macos      → outcome=didnt（明确不支持，不 fallback）
 *     - error_kind=script_not_in_whitelist / param_not_in_whitelist / param_value_invalid
 *                                 → outcome=didnt（层 1 已挡；若漂移到层 2 仍是明确"否"）
 *     - error_kind=applescript_exec_failed / applescript_spawn_failed / applescript_timeout
 *                                 → outcome=unknown（真实执行错；可被上游 fallback）
 *     - 其他                       → outcome=unknown
 *
 * 借鉴：parse5 §3.5.2；AxProvider.ts 的 RustResponse→Outcome 映射范式；
 *       mac-mcp OSAKit 安全路径。
 */
import type { RustBridge, RustResponse } from "../subprocess/RustBridge.js";
import type { InteractResult, Outcome } from "../types.js";
import type { DesktopOptions, DesktopResult } from "./desktop-types.js";
import {
  APPLE_SCRIPT_WHITELIST,
  isKnownAction,
  findDisallowedParamKey,
} from "./apple-script-whitelist.js";

// ============================================================
// 错误契约 helper
// ============================================================
/**
 * 明确"否"的 error_kind（层 1/2 拒绝或缺权限；应短路 outcome=didnt 不触发 fallback）。
 * 其他 error_kind（applescript_exec_failed 等）视为 unknown，允许 fallback 走下一档。
 */
const DIDNT_ERROR_KINDS = new Set<string>([
  "tcc_denied",
  "not_macos",
  "invalid_params",
  "script_not_in_whitelist",
  "param_not_in_whitelist",
  "param_value_invalid",
]);

function outcomeOf(resp: RustResponse): Outcome {
  if (resp.ok) return "worked";
  if (resp.error_kind && DIDNT_ERROR_KINDS.has(resp.error_kind)) return "didnt";
  return "unknown";
}

// ============================================================
// AppleScriptProvider
// ============================================================
/**
 * v0.4 M0.4b AppleScript provider（DesktopChannel.act 第 2 档）。
 *
 * INV-21：本类不出现平台 API 字面量；所有平台调用经 RustBridge.call。
 * INV-22（v0.4 解除）：本类用 typed action enum + 白名单，禁 raw 脚本串。
 * INV-27：白名单是 apple-script-whitelist.ts 顶级 const，不从 env 读。
 */
export class AppleScriptProvider {
  /** served_by 标识（写入 InteractResult.served_by；与 DesktopChannel plan 名一致）。 */
  static readonly NAME = "desktop.appleScript";

  constructor(private readonly rust: RustBridge) {}

  /**
   * act 主路径：typed action → 白名单校验 → rust.call("applescript_run")。
   *
   * 入口形状：
   *   opts.appleScriptAction : typed action enum 字符串（必填）
   *   opts.appleScriptParams : Record<string, unknown>（可选；默认 {}）
   *
   * 4-tier 语义（parse5 §3.5.4）：
   *   - 「无 action」是「本档不适用」而非「语义否定」→ outcome=unknown，链继续到 cgEvent
   *   - 「action 不在白名单 / param 不在 allowed」是注入尝试 → outcome=didnt，短路停止链
   *
   * @returns InteractResult<DesktopResult>
   *   - worked : data.actions_and_results 含 1 条 {ref: action, ok: true}
   *   - didnt  : 注入尝试（action/param 不在白名单）/ Rust 端明确"否"错误
   *   - unknown: 本档不适用（无 action）/ Rust 端真实执行错（可被上游 fallback 到下一档）
   */
  async act(
    opts: DesktopOptions,
  ): Promise<InteractResult<DesktopResult>> {
    // ------------------------------------------------------------------
    // 层 1a：typed action 必须显式传入
    // ------------------------------------------------------------------
    // 4-tier 语义（parse5 §3.5.4）：「无 action」=「本档不适用」而非「语义否定」。
    // 返 unknown 让 FallbackDecider 继续到下一档（cgEvent）； breaker.recordFailure
    // 会在连续 3 次后 open，自动跳过本档（用户不用 appleScript 时零成本）。
    const action = opts.appleScriptAction;
    if (!action) {
      return {
        outcome: "unknown",
        data: null,
        served_by: AppleScriptProvider.NAME,
        fallback_used: false,
        retrieval_method: "applescript_no_action",
        error: "missing_applescript_action",
      };
    }

    // ------------------------------------------------------------------
    // 层 1b：action 必须在白名单（typed action enum + 字面量守门）
    // ------------------------------------------------------------------
    if (!isKnownAction(action)) {
      return {
        outcome: "didnt",
        data: null,
        served_by: AppleScriptProvider.NAME,
        fallback_used: false,
        retrieval_method: "script_not_in_whitelist",
        error: `action_not_in_whitelist:${action}`,
      };
    }

    // ------------------------------------------------------------------
    // 层 1c：params key 必须是 allowedParams 的子集（防注入）
    // ------------------------------------------------------------------
    // 不信任 opts.appleScriptParams 形状；强制按 Record 处理。
    const rawParams = opts.appleScriptParams;
    const paramsObj: Record<string, unknown> =
      rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
        ? rawParams as Record<string, unknown>
        : {};
    const badKey = findDisallowedParamKey(action, paramsObj);
    if (badKey !== null) {
      return {
        outcome: "didnt",
        data: null,
        served_by: AppleScriptProvider.NAME,
        fallback_used: false,
        retrieval_method: "param_not_in_whitelist",
        error: `param_not_in_whitelist:${badKey}`,
      };
    }

    // ------------------------------------------------------------------
    // 经 Rust helper 调 osascript（层 2/3 在 Rust 端独立校验）
    // ------------------------------------------------------------------
    const resp = await this.rust.call(
      "applescript_run",
      { action, params: paramsObj },
      12_000, // 略大于 Rust 端 OSA_TIMEOUT_SECS=10s，让 Rust 自己先报 applescript_timeout
    );

    const outcome = outcomeOf(resp);
    if (outcome !== "worked") {
      return {
        outcome,
        data: null,
        served_by: AppleScriptProvider.NAME,
        fallback_used: false,
        retrieval_method: resp.error_kind ?? "applescript_failed",
        error: resp.error ?? resp.error_kind ?? "applescript_error",
      };
    }

    // ------------------------------------------------------------------
    // 成功：组装 DesktopResult（actions_and_results 单条记录）
    // ------------------------------------------------------------------
    // rust 端返 { action, stdout, stderr, exit_code }；TS 端只关心执行成功事实。
    // stdout 内容可由 CC 经 observe(snapshot) 再读，不在此处传递（避免 channel 内联数据）。
    return {
      outcome: "worked",
      data: {
        actions_and_results: [{ ref: action, ok: true }],
        fallback_used: false,
      },
      served_by: AppleScriptProvider.NAME,
      fallback_used: false,
      retrieval_method: "applescript_osakit",
    };
  }
}

// ============================================================
// 内部导出（单测断言用）
// ============================================================
/**
 * 单测锚点：暴露 DIDNT_ERROR_KINDS 副本供 apple-script-provider.spec.ts 断言映射不变。
 * 不算公共 API（仅单测 import），生产代码不应使用。
 */
export const __APPLESCRIPT_DIDNT_ERROR_KINDS: ReadonlySet<string> =
  DIDNT_ERROR_KINDS;

/**
 * 单测锚点：暴露 outcomeOf 给 apple-script-provider.spec.ts。
 */
export const __APPLESCRIPT_OUTCOME_OF = outcomeOf;

/**
 * 单测锚点：暴露 APPLE_SCRIPT_WHITELIST 引用（间接经 apple-script-whitelist.ts）。
 * 防止未来重构时误删对白名单常量的引用导致 INV-27 grep 误判。
 */
export const __WHITELIST_REF = APPLE_SCRIPT_WHITELIST;
