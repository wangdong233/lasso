/**
 * StepEngine v0.3（parse3 §3.1，F3.2.11 + F3.2.18）
 *
 * 多步链式主循环（Skyvern actions_and_results 形状）。
 *
 * 设计铁律（08 §0 原则 5 / INV-13）：event delivery alone is never treated as
 * semantic success. expect failed → outcome=didnt + 终止 chain（不允许"事件投递
 * 了就装成功"）。
 *
 * 借鉴源（12 证据）：
 *  - Skyvern actions_and_results: list[tuple[Action, list[ActionResult]]]
 *    每个 step 关联其全部尝试结果（fallback 重试 / expect 多次轮询——v0.3 暂 1 条）。
 *  - Skyvern ActionFailure.should_terminate_remaining_chain 默认 True：
 *    任一非 worked 步终止后续，避免「错上加错」（如登录失败后继续点 protected 页）。
 *  - GitHub Accessibility Agent 发现：「linear ordered phases > parallel sub-agents
 *    for accuracy」—— 本引擎严格线性，不并行。
 *  - injaneity actions.ts outcomeAfterCheck：verified→worked / failed→didnt /
 *    preexisting→保留原 outcome。
 *
 * 终止边界（parse3 §4.6 状态机）：
 *  ┌────────────────────────────┬─────────┬─────────┬──────────────────────────────┐
 *  │ 场景                        │ step    │ chain   │ stopped_at.reason             │
 *  ├────────────────────────────┼─────────┼─────────┼──────────────────────────────┤
 *  │ 正常 + expect verified      │ worked  │ worked  │ (无停止，继续下一步)           │
 *  │ 正常 + expect preexisting   │ worked  │ worked  │ (保留 outcome；诚实标注)       │
 *  │ expect failed               │ didnt   │ didnt   │ failed_postcondition          │
 *  │ step 抛 timeout/429         │ unknown │ unknown │ step_error                    │
 *  │ step 抛 404/403/2FA         │ didnt   │ didnt   │ step_error                    │
 *  │ budget 超限                 │ (未跑)   │ didnt   │ budget_exceeded              │
 *  │ high-risk gate block        │ (未跑)   │ didnt   │ manual_abort                  │
 *  └────────────────────────────┴─────────┴─────────┴──────────────────────────────┘
 *
 * unknown 的特殊性：chain outcome=unknown 是**唯一**触发外层 FallbackDecider
 * 升降级的信号（12 §1.1B）；本引擎不直接调 FallbackDecider，只标 outcome=unknown
 * 让上层判定。
 */
import type { InteractResult } from "../types.js";
import type { BudgetTracker } from "../fallback/BudgetTracker.js";
import type {
  Step,
  ActionResult,
  StoppedAt,
  ChainResult,
} from "./steps-types.js";
import type { BrowseChannel } from "../channels/BrowseChannel.js";

// ============================================================
// HighRiskGate 占位类型（Phase D 落地）
// ============================================================
/**
 * Phase C 仅声明接口；Phase D 实装 HighRiskGate 时替换为真实 import。
 *
 * assessStep(step)：
 *  - blocked=false → 引擎继续跑 step
 *  - blocked=true  → 引擎立即 stop("manual_abort", reason)
 *
 * headless channel 传 null（不启用 gate）；logged_in channel 注入实装。
 */
export interface HighRiskGateLike {
  assessStep(step: Step): Promise<{ blocked: boolean; reason?: string; evidence?: string }>;
}

// ============================================================
// onProgress 回调
// ============================================================
/**
 * 每步完成后调一次，便于上层（tool 层）流式渲染进度。
 *  - partial.actions_and_results 截止到当前完成的步
 *  - 不含 future 步信息（保护 token 经济）
 *
 * 注意：CC 工具层暂不实装流式（v0.3 收紧 scope）；本参数保留接口，未来扩展。
 */
export type ProgressCallback = (partial: ChainResult) => void;

// ============================================================
// StepEngine
// ============================================================
/**
 * StepEngine：每个 chain 实例化一个 BudgetTracker（外部传入便于测试）。
 *
 * 用法：
 *   const engine = new StepEngine(channel, new BudgetTracker(120_000), null);
 *   const r = await engine.runChain(url, steps);
 *   if (r.outcome === "unknown") {
 *     // 外层 FallbackDecider 接管
 *   }
 */
export class StepEngine {
  constructor(
    private readonly channel: BrowseChannel,
    private readonly budget: BudgetTracker,
    /** 仅 logged_in 注入；headless 传 null（parse3 §3.5） */
    private readonly highRiskGate: HighRiskGateLike | null = null,
  ) {}

  // ============================================================
  // 主入口
  // ============================================================
  /**
   * 线性执行 steps（不并行）。
   *
   * 每步流程（parse3 §3.1）：
   *  1. budget.exhausted() → stop("budget_exceeded")
   *  2. highRiskGate.assessStep() (若注入) → block 时 stop("manual_abort")
   *  3. channel.executeStep() → StepPartial（含 preSnapshot 给 expect 用）
   *  4. step.expect 存在时 → channel.runExpect(cond, preSnapshot) 三态
   *       - failed    → 强制 outcome=didnt + stop("failed_postcondition") [INV-13]
   *       - verified  → outcome=worked（覆盖原 outcome，已验证交付）
   *       - preexisting → 保留原 outcome（诚实标注，不掠美）
   *  5. outcome=unknown → stop("step_error")（外层 FallbackDecider 接管）
   *  6. outcome=didnt   → stop("step_error")（明确否，不进 fallback chain）
   *
   * @returns InteractResult<ChainResult>
   *   - outcome: worked / didnt / unknown
   *   - data.actions_and_results: Skyvern 审计链
   *   - data.stopped_at: 终止边界（worked 时不填）
   *   - data.budget_used_ms: 整 chain 实际耗时
   */
  async runChain(
    url: string,
    steps: Step[],
    onProgress?: ProgressCallback,
  ): Promise<InteractResult<ChainResult>> {
    const actions_and_results: ChainResult["actions_and_results"] = [];
    const tChainStart = Date.now();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // ----------------------------------------------------------
      // 1. budget 预检（F3.4.8）
      // ----------------------------------------------------------
      if (this.budget.exhausted()) {
        return this.budget.flushInto(
          this.stop("budget_exceeded", i, actions_and_results, step, {
            detail: `budget_exceeded: used=${this.budget.used()}ms cap=${this.budget.cap()}ms`,
          }),
        );
      }

      // ----------------------------------------------------------
      // 2. high-risk gate（F3.3.14，仅 logged_in 注入）
      // ----------------------------------------------------------
      if (this.highRiskGate) {
        let gate: { blocked: boolean; reason?: string; evidence?: string };
        try {
          gate = await this.highRiskGate.assessStep(step);
        } catch (e) {
          // gate 自身异常 → 不阻塞 chain（保守：让 channel 自己报错）
          gate = { blocked: false, reason: `gate_error:${String(e)}` };
        }
        if (gate.blocked) {
          // 不自动操作 → 升级用户（不做也不继续）
          const partial: ActionResult = {
            action: step.action,
            outcome: "didnt",
            error: gate.reason ?? "high_risk_blocked",
          };
          actions_and_results.push({ step, results: [partial] });
          // 触发 partial_failures 累加（与 step_error 同处理）
          this.budget.recordPartial({
            channel: this.channel.name,
            error: gate.reason ?? "high_risk_blocked",
          });
          return this.budget.flushInto(
            this.stop("manual_abort", i, actions_and_results, step, {
              detail: gate.reason,
              error: gate.reason,
            }),
          );
        }
      }

      // ----------------------------------------------------------
      // 3. 执行 step（BrowseChannel.executeStep）
      // ----------------------------------------------------------
      const tStepStart = Date.now();
      let partial;
      try {
        partial = await this.channel.executeStep(url, step);
      } catch (e) {
        // executeStep 自身已 try/catch，但兜底防御性处理
        const msg = String(e);
        partial = {
          outcome: "unknown" as const,
          error: msg,
          preSnapshot: undefined,
        };
      }
      const duration_ms = Date.now() - tStepStart;
      this.budget.spend(duration_ms);

      const result: ActionResult = {
        action: step.action,
        outcome: partial.outcome,
        preview: partial.preview,
        state_id: partial.state_id,
        content_path: partial.content_path,
        error: partial.error,
        duration_ms,
      };

      // ----------------------------------------------------------
      // 4. expect postcondition（F3.2.18）
      // ----------------------------------------------------------
      if (step.expect) {
        let verdict: "verified" | "preexisting" | "failed";
        try {
          verdict = await this.channel.runExpect(
            step.expect,
            partial.preSnapshot,
          );
        } catch (e) {
          // runExpect 抛错（极端：cond 缺字段 / client 断开）
          // 保守判 failed（INV-13：宁可不假装成功）
          verdict = "failed";
          result.error = (result.error ?? "") + ` expect_error:${String(e)}`.trim();
        }
        result.expect_check = verdict;

        if (verdict === "failed") {
          // INV-13 铁律：failed → 强制 outcome=didnt + 终止 chain
          result.outcome = "didnt";
          actions_and_results.push({ step, results: [result] });
          this.budget.recordPartial({
            channel: this.channel.name,
            error: `expect_failed:${JSON.stringify(step.expect)}`,
          });
          return this.budget.flushInto(
            this.stop("failed_postcondition", i, actions_and_results, step, {
              detail: `expect failed: ${JSON.stringify(step.expect)}`,
              error: `expect failed: ${JSON.stringify(step.expect)}`,
            }),
          );
        }
        if (verdict === "verified") {
          // 已验证交付 → outcome=worked（即便 handler 原本报 unknown 也升级）
          result.outcome = "worked";
        }
        // preexisting → 保留原 outcome（不掠美：channel 没造成它但成立）
      }

      // ----------------------------------------------------------
      // 5. 推入审计链 + 进度回调
      // ----------------------------------------------------------
      actions_and_results.push({ step, results: [result] });
      onProgress?.({
        actions_and_results: [...actions_and_results],
        budget_used_ms: Date.now() - tChainStart,
      });

      // 非 worked outcome → 累加 partial_failures（诚实记录每步问题）
      if (result.outcome !== "worked") {
        this.budget.recordPartial({
          channel: this.channel.name,
          error: result.error ?? result.outcome,
        });
      }

      // ----------------------------------------------------------
      // 6. 终止判定（parse3 §4.6 状态机）
      // ----------------------------------------------------------
      if (result.outcome === "unknown") {
        // chain outcome=unknown → 触发外层 FallbackDecider 升降级
        // Skyvern should_terminate_remaining_chain 默认 True
        return this.budget.flushInto(
          this.stop("step_error", i, actions_and_results, step, {
            chainOutcome: "unknown",
            detail: `outcome=unknown: ${result.error ?? "(no error)"}`,
            error: result.error,
          }),
        );
      }
      if (result.outcome === "didnt") {
        // 明确否（404/403/2FA/handler 主动报错）→ 终止不进 fallback chain
        return this.budget.flushInto(
          this.stop("step_error", i, actions_and_results, step, {
            chainOutcome: "didnt",
            detail: `outcome=didnt: ${result.error ?? "(no error)"}`,
            error: result.error,
          }),
        );
      }
      // outcome === "worked" → 继续下一步
    }

    // ----------------------------------------------------------
    // 全部 step 完成 → chain outcome=worked
    // ----------------------------------------------------------
    const lastResult = actions_and_results.at(-1)?.results[0];
    const chainResult: ChainResult = {
      actions_and_results,
      final_state_id: lastResult?.state_id,
      final_url: url,
      budget_used_ms: Date.now() - tChainStart,
    };
    return this.budget.flushInto({
      outcome: "worked",
      data: chainResult,
      served_by: this.channel.name,
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp.chain",
    });
  }

  // ============================================================
  // stop：构造终止返回（统一形状）
  // ============================================================
  /**
   * @param reason    stopped_at.reason
   * @param idx       step_index（当前 step 索引）
   * @param aar       当前 actions_and_results（已含当前 step 的 result）
   * @param step      当前 step（用于 failed_action 字段）
   * @param opts      chainOutcome（默认 didnt）+ detail + error
   */
  private stop(
    reason: StoppedAt["reason"],
    idx: number,
    aar: ChainResult["actions_and_results"],
    step: Step,
    opts: {
      chainOutcome?: "worked" | "didnt" | "unknown";
      detail?: string;
      error?: string;
    } = {},
  ): InteractResult<ChainResult> {
    const chainOutcome = opts.chainOutcome ?? "didnt";
    const stopped_at: StoppedAt = {
      step_index: idx,
      reason,
      failed_action: step.action,
    };
    if (opts.detail) stopped_at.detail = opts.detail;
    return {
      outcome: chainOutcome,
      data: {
        actions_and_results: aar,
        stopped_at,
        budget_used_ms: this.budget.used(),
      },
      served_by: this.channel.name,
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp.chain",
      error: opts.error,
    };
  }
}
