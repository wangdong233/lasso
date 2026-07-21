/**
 * Lasso v0.3 多步链式类型（parse3 §3.1）
 *
 * 类型定义，无运行时依赖。
 *
 *  - Step           : 多步链一个 step（F3.2.11）
 *  - ActionResult   : Skyvern-style 审计链一行（12 §3.5.10）
 *  - StoppedAt      : 链式终止边界（09 §2.3 验收 2：stoppedAt 精确边界）
 *  - ChainResult    : chain 总返回（InteractResult.data 字段）
 *  - BoundedOutput  : 见 ../util/output-envelope.ts（超 48KiB 落盘 ref）
 *
 * 借鉴源（12 证据）：
 *  - Skyvern `actions_and_results: list[tuple[Action, list[ActionResult]]]`
 *  - Skyvern `ActionFailure.should_terminate_remaining_chain` 默认 True
 *  - injaneity `actions.ts outcomeAfterCheck` tri-state（worked/didnt/preexisting）
 *
 * 架构铁律（08 §0 原则 5）：event delivery alone is never treated as semantic success.
 * expect failed 必须 outcome=didnt + 终止（INV-13）。
 */
import type { Outcome, ExpectCondition } from "../types.js";
import type { BoundedOutput } from "../util/output-envelope.js";
import type { ConditionSnapshot } from "./ExpectPoll.js";

// ============================================================
// StepPartial — executeStep 单步返回（parse3 §3.1）
// ============================================================
/**
 * BrowseChannel.executeStep() 的返回形状。
 *  - outcome     : worked / didnt / unknown（act handler 抛错时由 classifyBrowseError 判）
 *  - preview     : ≤1k tokens 预览
 *  - state_id    : StateStore 写入后的短指针
 *  - content_path: 磁盘 spill 绝对路径
 *  - error       : handler 抛错时的错误文本
 *  - preSnapshot : act 前快照（仅 step.expect 存在时抓）→ runExpect 用它判 preexisting
 *
 * 设计：executeStep **不直接**写盘，而是委托 persistState（v0.2 browse() 与 v0.3
 * 引擎共用）。本类型不含 actions_and_results 形状（那是 StepEngine 拼）。
 */
export interface StepPartial {
  outcome: Outcome;
  preview?: string;
  state_id?: string;
  content_path?: string;
  error?: string;
  /** act 前的快照（仅 step.expect 存在时抓）；runExpect 用它判 preexisting */
  preSnapshot?: ConditionSnapshot;
}

// ============================================================
// ActionResult — 审计链一行
// ============================================================
/**
 * Skyvern-style 审计链一行（12 §3.5.10）。
 * 每个 step 的每次尝试（含 fallback 重试）产生一条。
 */
export interface ActionResult {
  /** navigate/click/fill/wait/extract/snapshot/evaluate（Lasso action 空间） */
  action: string;
  /** tri-state + preexisting（preexisting 仅 expect 路径产生） */
  outcome: Outcome | "preexisting";
  preview?: string;
  /** 指向 StateStore 内记录（v0.3 LRU(128)） */
  state_id?: string;
  content_path?: string;
  error?: string;
  duration_ms?: number;
  /** expect 后置条件检查结果（F3.2.18） */
  expect_check?: "verified" | "preexisting" | "failed" | "skipped";
}

// ============================================================
// Step — 多步链一个 step
// ============================================================
/**
 * 多步链一个 step（F3.2.11）。
 * 顺序：引擎按数组顺序线性执行（不并行，借鉴 GitHub Accessibility Agent 的发现：
 * 「linear ordered phases > parallel sub-agents for accuracy」）。
 */
export interface Step {
  action: string;
  /** { click: uid, fill: { uid: value, ... } } — 单 step 的 selector 入参 */
  selectors?: Record<string, string>;
  /** evaluate action 用 */
  js?: string;
  /** 每步可附 postcondition（12 §1.1B outcomeAfterCheck） */
  expect?: ExpectCondition;
  /** per-step timeout（默认 30000） */
  timeout_ms?: number;
  /** CC 友好的步骤名（审计用） */
  label?: string;
}

// ============================================================
// StoppedAt — 链式终止边界
// ============================================================
/**
 * 链式终止边界（09 §2.3 验收 2）。
 * 精确到 step_index + reason；CC 据此判断是否换路径或求助用户。
 */
export interface StoppedAt {
  step_index: number;
  reason:
    | "failed_postcondition"
    | "step_error"
    | "budget_exceeded"
    | "manual_abort";
  failed_action?: string;
  detail?: string;
}

// ============================================================
// ChainResult — chain 总返回
// ============================================================
/**
 * chain 总返回（InteractResult<ChainResult>.data 字段）。
 *
 * actions_and_results 形状（12 §3.5.10）：
 *   [{ step, results: ActionResult[] }, ...]
 * 一个 step 可能有多条 results（fallback 重试或 expect 多次轮询——v0.3 暂只 1 条）。
 */
export interface ChainResult {
  actions_and_results: Array<{ step: Step; results: ActionResult[] }>;
  final_state_id?: string;
  final_url?: string;
  stopped_at?: StoppedAt;
  budget_used_ms?: number;
  /** 若整体结果超 48KiB（F3.2.20），data 替换为 { bounded_output, preview_only } */
  bounded_output?: BoundedOutput;
}
