/**
 * Lasso v0.3 high-risk pattern gate（parse3 §3.5，F3.3.14）
 *
 * 架构铁律（08 §0 原则 5 / INV-14）：event delivery alone is never treated as
 * semantic success. 对「携带身份」的 logged_in channel，遇到 high-risk UI pattern
 * 时**放弃自动操作**，升级用户（不做也不继续）。headless channel 不启用本 gate
 * （公开页风险低 + 无身份）。
 *
 * 借鉴源（12 §2.1#6 GitHub Accessibility Agent 内部 pilot）：
 *  - complexity scoring 门槛 + high-risk pattern 黑名单：
 *    drag-drop / toasts / RTE / tree-view / data-grid → 标「不自动操作」
 *  - anti-gaming instructions：pattern 表写死在代码里，**不**从 config / env 读，
 *    防止 LLM 通过 config 绕过自己设定的安全边界（INV-14）。
 *
 * 边界：
 *  - 只对「会引发副作用的 action」检查（navigate/snapshot/screenshot/extract/wait/
 *    evaluate 是只读 / 等待，不检 → 性能 + 不必要）。
 *  - 命中时 outcome=didnt + error="high_risk_pattern:<kind>"；StepEngine 收到后
 *    立即 stop("manual_abort")，不进 fallback chain（parse3 §3.1）。
 *
 * 实现说明：
 *  - 通过 evaluate_script 跑一次 DOM 查询：定位目标元素（data-lasso-uid 属性 +
 *    document.activeElement 兜底）→ 向上找祖先是否命中黑名单 selector。
 *  - 若目标元素无法定位（uid 不是 DOM selector / 页面未就绪）：**不拦**（让 channel
 *    自己报错，避免误拦合法操作 —— parse3 §7.1 R-v03-3 缓解）。
 *  - 任何 evaluate 异常：返回 blocked=false + reason="gate_error:*"（保守放过）。
 */
import type { McpClient } from "../subprocess/McpClient.js";
import type { Step } from "./steps-types.js";
import { logger } from "../util/logger.js";

// ============================================================
// HighRiskAssessment
// ============================================================
/** assessStep 的返回形状。blocked=true 时调用方（StepEngine）必须终止 chain。 */
export interface HighRiskAssessment {
  blocked: boolean;
  /** "high_risk_pattern:rte" / "high_risk_pattern:drag_drop" / "gate_error:*" */
  reason?: string;
  /** 命中 selector 的祖先元素 outerHTML 片段（≤ 200 字符；审计用） */
  evidence?: string;
}

// ============================================================
// HIGH_RISK_PATTERNS —— 模块顶级 const（INV-14 anti-gaming）
// ============================================================
/**
 * 高风险 UI pattern 黑名单（parse3 §3.5）。
 *
 * INV-14（铁律）：此表**必须**是模块顶级 const，**禁止**从 config / env 读取。
 *  - reason：anti-gaming。LLM 若能通过 config 修改此表，就能绕过自己设定的安全
 *    边界（如把 "rte" 从黑名单移除以「方便」完成 RTE 自动操作）。
 *  - 加入 / 移除 pattern 必须改源码 + 走 review（不是 runtime 决策）。
 *
 * 5 类 pattern：
 *  - rte       : 富文本编辑器（contenteditable）—— LLM 误操作风险高（自动填入
 *                垃圾内容 / 触发格式快捷键）
 *  - tree_view : 树视图（role=tree/treegrid）—— 键盘导航复杂（Tab/Arrow 混合）
 *  - data_grid : 数据网格（role=grid）—— 同 tree_view，单元格选择规则各异
 *  - drag_drop : 拖拽元素（draggable=true）—— click 误触发 drag，可能重排 UI
 *  - toast     : 瞬态提示（role=alert）—— 出现即消失，点击无效或误关
 *
 * selector 语法：标准 CSS selector（多组用逗号 OR）。chrome-devtools-mcp 的
 * evaluate_script 在页面上下文跑 document.querySelector，原生支持。
 */
export const HIGH_RISK_PATTERNS: ReadonlyArray<{
  kind: string;
  selector: string;
}> = Object.freeze([
  { kind: "rte", selector: '[role="textbox"][contenteditable="true"], [contenteditable=""]' },
  { kind: "tree_view", selector: '[role="tree"], [role="treegrid"]' },
  { kind: "data_grid", selector: '[role="grid"]' },
  { kind: "drag_drop", selector: '[draggable="true"]' },
  { kind: "toast", selector: '[role="alert"]' },
]);

/**
 * 只读 / 等待 action 白名单：不触发副作用 → 不检 gate（parse3 §3.5）。
 * 与 BrowseChannel.actionDispatch 的 key 集合一致（v0.3 F3.2.11）。
 */
export const READONLY_ACTIONS: ReadonlySet<string> = new Set([
  "navigate",
  "snapshot",
  "screenshot",
  "extract",
  "wait",
  "evaluate",
]);

// ============================================================
// HighRiskGate
// ============================================================
/**
 * 仅 logged_in channel 注入（parse3 §3.1 StepEngine 构造时传）。
 *
 * 用法：
 *   const gate = new HighRiskGate(() => channel.getMcpClient());
 *   const v = await gate.assessStep(step);
 *   if (v.blocked) return stop("manual_abort", ...);
 */
export class HighRiskGate {
  /**
   * @param clientSupplier 懒获取 McpClient（每次 assessStep 调一次，避免构造时绑定）
   */
  constructor(
    private readonly clientSupplier: () => Promise<McpClient>,
  ) {}

  /**
   * 评估单步是否命中 high-risk pattern。
   *
   * 流程（parse3 §3.5）：
   *  1. 只读 / 等待 action → 直接 blocked=false（白名单）
   *  2. 无 DOM 目标（click 必须有 selectors.click；fill 必须有非空 selectors 任一键）
   *     → blocked=false（让 channel 自己报错）
   *  3. 跑 evaluate_script：定位目标元素 + 查祖先是否命中 HIGH_RISK_PATTERNS
   *  4. 任何异常 → blocked=false + reason="gate_error:*"（保守放过）
   *
   * 目标选择策略（与 BrowseChannel 的 doClick / doFill 实际签名对齐）：
   *  - click : selectors.click 是 a11y uid
   *  - fill  : selectors 是 { uid: value, ... } 多字段 flat map；取首个 key 当目标
   *  - 其他副作用 action：暂无 DOM 目标概念 → 直接放过（让 channel 报错）
   *
   * @returns blocked=true 时，reason 形如 "high_risk_pattern:rte"，evidence 为祖先 outerHTML 片段
   */
  async assessStep(step: Step): Promise<HighRiskAssessment> {
    // 1. 只读 / 等待 action 白名单
    if (READONLY_ACTIONS.has(step.action)) {
      return { blocked: false };
    }

    // 2. 提取 DOM 目标（uid）
    let target: string | undefined;
    if (step.action === "click") {
      target = step.selectors?.click;
    } else if (step.action === "fill") {
      // fill 的 selectors 是 flat { uid: value, ... }；取首个 key（任意一个都需过 gate）
      const keys = step.selectors ? Object.keys(step.selectors) : [];
      if (keys.length > 0) target = keys[0];
    } else {
      // 其他副作用 action（v0.3 仅 click / fill 有 DOM 目标）→ 不拦
      return { blocked: false };
    }
    if (!target) {
      return { blocked: false };
    }

    // 3. 跑 evaluate_script 查祖先
    let client: McpClient;
    try {
      client = await this.clientSupplier();
    } catch (e) {
      // 拿不到 client（子进程未起 / 通道断开）→ 不拦（让 BrowseChannel 自己报错）
      logger.warn({
        evt: "high_risk_gate_client_unavailable",
        action: step.action,
        error: String(e),
      });
      return { blocked: false, reason: `gate_error:no_client:${String(e)}` };
    }

    const expr = buildAssessExpr(target);
    try {
      const r = (await client.callTool("evaluate_script", {
        function: expr,
      })) as ContentResult;
      const text = firstText(r);
      if (!text) {
        return { blocked: false, reason: "gate_error:empty_eval" };
      }
      const verdict = JSON.parse(text) as {
        ok?: boolean;
        kind?: string;
        html?: string;
        reason?: string;
      };
      if (verdict.kind) {
        return {
          blocked: true,
          reason: `high_risk_pattern:${verdict.kind}`,
          evidence: verdict.html,
        };
      }
      return { blocked: false };
    } catch (e) {
      // evaluate 异常（页面未就绪 / 通道断开 / script timeout）→ 保守放过
      logger.warn({
        evt: "high_risk_gate_eval_failed",
        action: step.action,
        error: String(e),
      });
      return { blocked: false, reason: `gate_error:eval:${String(e)}` };
    }
  }
}

// ============================================================
// buildAssessExpr：构造 evaluate_script 表达式
// ============================================================
/**
 * 构造 JS 表达式：返回 JSON 字符串 { ok, kind?, html?, reason? }。
 *
 * 步骤：
 *  1. 优先按 data-lasso-uid 属性找元素（Lasso 未来在 snapshot 注入）
 *  2. fallback 到 document.activeElement（最近聚焦元素）
 *  3. 都找不到 → { ok: false, reason: "element_not_found" }（不拦）
 *  4. 找到 → 向上 (el.closest) 查 HIGH_RISK_PATTERNS 任一命中
 *     - 命中：{ ok: true, kind, html }
 *     - 未命中：{ ok: true }（blocked=false）
 *
 * CSS.escape 防目标字符串里有特殊字符；outerHTML 截 200 字符避免超大日志。
 *
 * 导出供测试 / 单独 evaluate 场景复用。
 */
export function buildAssessExpr(target: string): string {
  // 把 (kind, selector) 配对预序列化进表达式，避免运行时跨数组下标取值 + injection。
  const pairs = HIGH_RISK_PATTERNS.map((p) => ({
    kind: p.kind,
    selector: p.selector,
  }));
  return `(function(){
    try {
      var target = ${JSON.stringify(target)};
      var pairs = ${JSON.stringify(pairs)};
      var el = null;
      try {
        var uidSel = '[data-lasso-uid="' + CSS.escape(target) + '"]';
        el = document.querySelector(uidSel);
      } catch (e) { /* CSS.escape unavailable or bad uid → fall through */ }
      if (!el) {
        el = document.activeElement;
      }
      if (!el) {
        return JSON.stringify({ ok: false, reason: "element_not_found" });
      }
      for (var i = 0; i < pairs.length; i++) {
        var sel = pairs[i].selector;
        var risky = null;
        try { risky = el.closest(sel); } catch (e) { continue; }
        if (risky) {
          var html = risky.outerHTML || "";
          if (html.length > 200) html = html.slice(0, 200);
          return JSON.stringify({
            ok: true,
            kind: pairs[i].kind,
            html: html
          });
        }
      }
      return JSON.stringify({ ok: true });
    } catch (e) {
      return JSON.stringify({ ok: false, reason: "eval_error:" + String(e) });
    }
  })()`;
}

// ============================================================
// 内部 helper：SDK 返回结构解析（与 BrowseChannel 内部解析同构；保持本模块独立）
// ============================================================
type TextBlock = { type: "text"; text?: string };
type ContentResult = { content?: TextBlock[]; isError?: boolean };

function firstText(r: ContentResult | undefined): string | undefined {
  if (!r?.content) return undefined;
  for (const b of r.content) {
    if (b.type === "text" && b.text) return b.text;
  }
  return undefined;
}
