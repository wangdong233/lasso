/**
 * ElicitationPort（v1.17 Phase E，parse24 §6.1 C1 裁决⑤）
 *
 * HighRiskGate 的 elicitation 端口：命中高风险 pattern 时向 CC 用户弹
 * 结构化确认（回合内 continue/skip/abort 三选一），替代「中断重来」。
 *
 * SDK 1.30.0 实测 API（parse24 §1 decision-C 锚点核验，node_modules 亲读）：
 *  - 入口：McpServer.server（low-level Server）→ elicitInput(params, options?)
 *  - params（form 档）：{ mode:"form", message, requestedSchema }。
 *    requestedSchema 是受限类型集（string/enum/boolean/number/array-of-enum），
 *    确认表单的 decision 字段用 { type:"string", enum:[...], enumNames:[...] }。
 *  - 返回：{ action:"accept"|"decline"|"cancel", content?: Record<string,...> }
 *  - SDK 内部能力守卫（server/index.js:351）：`!_clientCapabilities?.elicitation?.form`
 *    → 同步 throw（不触网）。本端口把该守卫**前置**（getClientCapabilities 预检），
 *    能力未声明时连请求都不发（裁决红线：测试钉死）。
 *
 * 安全模型（parse24 §6.1 + 冲突 #7）：
 *  - 端口返回三值：accept（本次放行）/ decline（维持现行 blocked）/ unavailable
 *    （能力未声明或任何异常——fail-closed，落回现行 didnt 路径 byte-identical）。
 *  - accept 无记忆：每次命中独立确认（INV-14 anti-gaming 的 elicitation 延伸，
 *    端口不持有任何跨调用状态；pattern 表仍代码级 const，不从 config/env 读）。
 *  - 本模块永不 throw（任何异常捕获为 unavailable）——StepEngine 对 assessStep
 *    异常的兜底是 blocked=false 放行，端口若 throw 会意外放行高风险操作。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../util/logger.js";

// ============================================================
// 类型
// ============================================================
/** confirmHighRisk 的三值决议（parse24 §6.1 定案）。 */
export type ElicitDecision = "accept" | "decline" | "unavailable";

/**
 * 窄接口（parse24 §6.1）：HighRiskGate 只依赖此形状，不依赖 SDK 类型——
 * 测试注入 mock port 无需构造真 McpServer。
 */
export interface ElicitationPort {
  confirmHighRisk(kind: string, evidence: string): Promise<ElicitDecision>;
}

// ============================================================
// 顶级 const
// ============================================================
/** 单次确认的 wall-clock 上限（人读 evidence + 三选一，120s 充裕；SDK 超时抛 McpError）。 */
export const HIGH_RISK_ELICIT_TIMEOUT_MS = 120_000;

/** evidence 进 message 的截断上限（与 HighRiskAssessment.evidence 契约一致，审计用）。 */
export const HIGH_RISK_ELICIT_EVIDENCE_MAX = 200;

/**
 * decision 表单选项（受限 schema 的 string+enum+enumNames 形态）。
 * - continue : 放行本步（→ accept）
 * - skip     : 跳过本步（→ decline；现行 gate 语义无「跳过单步继续链」，与 abort 同落 blocked）
 * - abort    : 终止（→ decline）
 * 顶级 const（INV-14 同精神）：选项集写死在代码，不从 config/env 读。
 */
export const HIGH_RISK_DECISION_ENUM = Object.freeze([
  "continue",
  "skip",
  "abort",
] as const);

/** 确认 message 组装（纯函数，可单测）：kind + evidence ≤200 字符。 */
export function buildHighRiskElicitMessage(
  kind: string,
  evidence: string,
): string {
  const ev = (evidence ?? "").slice(0, HIGH_RISK_ELICIT_EVIDENCE_MAX).trim();
  return ev
    ? `Lasso high-risk pattern hit: ${kind}. Evidence: ${ev}. Choose how to proceed with this step.`
    : `Lasso high-risk pattern hit: ${kind}. Choose how to proceed with this step.`;
}

// ============================================================
// SdkElicitationPort —— 唯一生产实现（持 McpServer）
// ============================================================
/**
 * 流程（parse24 §6.1 ①-④，逐字实装）：
 *  ① 预检 server.getClientCapabilities()?.elicitation?.form 未声明 → "unavailable"
 *     （不发起请求——能力守卫前置，连 elicitInput 都不调）
 *  ② elicitInput(params, { timeout:120s, maxTotalTimeout:120s })——form 档
 *  ③ 任何 throw（SDK 能力守卫同步 throw / McpError RequestTimeout / 传输错误）
 *     → "unavailable"
 *  ④ action:"accept" → content.decision === "continue" → "accept"；
 *     skip/abort/缺失 → "decline"；action:"decline"/"cancel" → "decline"
 */
export class SdkElicitationPort implements ElicitationPort {
  constructor(private readonly mcpServer: McpServer) {}

  async confirmHighRisk(
    kind: string,
    evidence: string,
  ): Promise<ElicitDecision> {
    try {
      // ① 能力预检（前置 SDK 守卫；未声明连请求都不发）
      const caps = this.mcpServer.server.getClientCapabilities();
      if (!caps?.elicitation?.form) {
        logger.info({
          evt: "high_risk_elicit_unavailable",
          reason: "elicitation_form_not_declared",
        });
        return "unavailable";
      }

      // ② form 档 elicitInput（decision 单字段确认表单）
      const result = await this.mcpServer.server.elicitInput(
        {
          mode: "form",
          message: buildHighRiskElicitMessage(kind, evidence),
          requestedSchema: {
            type: "object" as const,
            properties: {
              decision: {
                type: "string" as const,
                title: "decision",
                description:
                  "continue = run this step; skip/abort = keep it blocked (current behavior)",
                enum: [...HIGH_RISK_DECISION_ENUM],
                enumNames: ["继续执行", "跳过本步", "终止"],
              },
            },
            required: ["decision"],
          },
        },
        {
          timeout: HIGH_RISK_ELICIT_TIMEOUT_MS,
          maxTotalTimeout: HIGH_RISK_ELICIT_TIMEOUT_MS,
        },
      );

      // ④ 结果映射
      if (result.action === "accept") {
        const d = result.content?.decision;
        if (d === "continue") {
          logger.info({ evt: "high_risk_elicit_accepted", kind });
          return "accept";
        }
        // skip / abort / decision 缺失（SDK 已按 requestedSchema 校验非空，
        // 这里防御性兜底）→ 维持现行 blocked 路径
        logger.info({
          evt: "high_risk_elicit_declined",
          kind,
          via: `accept:${String(d)}`,
        });
        return "decline";
      }
      // decline / cancel → 维持现行 blocked 路径
      logger.info({
        evt: "high_risk_elicit_declined",
        kind,
        via: result.action,
      });
      return "decline";
    } catch (e) {
      // ③ fail-closed：任何异常 → unavailable（HighRiskGate 落现行 blocked 路径）
      logger.warn({
        evt: "high_risk_elicit_error",
        kind,
        error: String(e),
      });
      return "unavailable";
    }
  }
}
