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
  /**
   * §8.B 开放项 5（doc/bugs/09 尾款轮，R2-1 行为面）：handler partial 携带的
   * final_url 透传（navigate step 的 doNavigate 返回真实落点 URL）。StepEngine
   * 以此构成链级 final_url 的**种子**（最后携带者胜出）——链尾真值读
   * （BrowseChannel.applyChainUrlTruth）覆盖种子；种子等于链请求串时视同缺席
   * （等值守卫——doNavigate `extractFinalUrl(r) ?? url` 的请求串回退无法与
   * 真值区分，诚实 prefers 缺席）。非 navigate step 的 handler 通常不产
   * final_url（undefined——不参与种子链）。
   */
  final_url?: string;
}

/**
 * §8.B（doc/bugs/09 尾款轮）：browse() steps 分支先导导航（action:"navigate" +
 * steps）的结果透传形状——现状（W1-DEF-2b）该 partial 被直接丢弃，链级回显
 * 因此拿不到先导导航的落点与 same-document 双标注。
 */
export interface ChainEntryNav {
  final_url?: string;
  /** BUG-08 D-1 双标注（I-2 单 action 组合形态的同款透传） */
  same_document_navigated?: boolean;
  same_document_reloaded?: boolean;
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
  /**
   * C2（doc/bugs/09 决议 C2，2026-09-16）：worked 行的瞬态诊断信息迁入地。
   * 消费方契约：**outcome=worked ⇒ error 必空**（worked+error 并存是喵虎报告
   * P2-A 现象二的状态机自相矛盾——expect verified 升级 worked 时 handler 的
   * 瞬态 error 仍挂在行上，消费方不知道该信哪个）。瞬态信息不丢弃，降级为
   * warnings 数组保留。非 worked 行不受影响（error 语义不变）。
   */
  warnings?: string[];
  duration_ms?: number;
  /** expect 后置条件检查结果（F3.2.18；"error"= v1.18.2 doc/governance/10 Y3：检查器自身抛错——基础设施异常，非后置条件为假） */
  expect_check?: "verified" | "preexisting" | "failed" | "skipped" | "error";
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
  /**
   * doc/bugs/11 决议 B.2：press step 的键/组合键（"Enter" / "Control+A"——
   * 顶层 options.key 同一键，executeStep 原样透传 doPress）。
   */
  key?: string;
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
  /**
   * §8.B 真值化（doc/bugs/09 尾款轮）：链级 final_url **不再回显请求串**
   * （R2-1：StepEngine 曾恒写 `final_url: url`——残留页形态谎称目标页）。
   * 值来源优先级：① 链尾真值读（BrowseChannel.applyChainUrlTruth——地面真值）
   * → ② 种子（最后携带 final_url 的 step partial / entryNav.final_url，经
   * 等值守卫）→ 省略（undefined——诚实 prefers 缺席）。
   */
  final_url?: string;
  /**
   * §8.B 链级导航回显：entryNav 在场（先导导航执行）∨ 任一 worked navigate
   * step ⇒ true；纯残留页/同页链 ⇒ false。wrapChainResult 传播至
   * data.did_navigate（单 action did_navigate 契约的链形态对齐——消灭
   * 「steps chains carry no did_navigate」的描述限定）。
   */
  did_navigate?: boolean;
  stopped_at?: StoppedAt;
  budget_used_ms?: number;
  /** 若整体结果超 48KiB（F3.2.20），data 替换为 { bounded_output, preview_only } */
  bounded_output?: BoundedOutput;
}
