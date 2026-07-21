/**
 * HighRiskGate v0.3 单测（parse3 §5.1 + §3.5 + 09 §2.3 验收 7）
 *
 * 覆盖：
 *  - HIGH_RISK_PATTERNS 顶级 const（INV-14 anti-gaming）
 *  - READONLY_ACTIONS 白名单（navigate/snapshot/screenshot/extract/wait/evaluate）
 *  - assessStep：5 类 pattern 各拦一次（rte/tree_view/data_grid/drag_drop/toast）
 *  - assessStep：只读 action 不拦
 *  - assessStep：无 selectors.click/fill 不拦（让 channel 自己报错）
 *  - assessStep：element_not_found 不拦（保守放过）
 *  - assessStep：client 不可用不拦（reason=gate_error:no_client）
 *  - assessStep：evaluate 异常不拦（reason=gate_error:eval）
 *  - buildAssessExpr：构造合法 JS 表达式 + JSON.stringify embedding
 *  - reason 字段格式 "high_risk_pattern:<kind>"
 *  - evidence 字段（祖先 outerHTML 片段 ≤ 200 字符）
 *
 * 与 StepEngine 的集成在 step-engine.spec.ts 已覆盖（mock gate）。
 */
import { describe, it, expect } from "vitest";
import {
  HighRiskGate,
  HIGH_RISK_PATTERNS,
  READONLY_ACTIONS,
  buildAssessExpr,
  type HighRiskAssessment,
} from "../../src/browse/HighRiskGate.js";
import type { Step } from "../../src/browse/steps-types.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

// ============================================================
// Mock McpClient
// ============================================================
/**
 * 构造 mock McpClient：callTool("evaluate_script", { function }) 返回固定 verdict。
 *
 * verdict 是 assessStep 解析后期待的 JSON 字符串：
 *  - { ok: true, kind, html }       → blocked=true
 *  - { ok: true }                   → blocked=false
 *  - { ok: false, reason: "..." }   → blocked=false
 */
function makeMockClient(replyText: string): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
      calls.push({ name, args });
      return { content: [{ type: "text", text: replyText }] };
    },
  };
  return { client: client as unknown as McpClient, calls };
}

/** Mock client that rejects（模拟子进程未起 / 通道断开）。 */
function makeThrowingClient(error = "not_connected"): McpClient {
  const client = {
    async callTool(): Promise<never> {
      throw new Error(error);
    },
  };
  return client as unknown as McpClient;
}

function step(action: string, extra: Partial<Step> = {}): Step {
  return { action, ...extra };
}

// ============================================================
// HIGH_RISK_PATTERNS 常量
// ============================================================
describe("HIGH_RISK_PATTERNS — 顶级常量（INV-14）", () => {
  it("5 类 pattern 全在：rte/tree_view/data_grid/drag_drop/toast", () => {
    const kinds = HIGH_RISK_PATTERNS.map((p) => p.kind).sort();
    expect(kinds).toEqual(
      ["data_grid", "drag_drop", "rte", "toast", "tree_view"].sort(),
    );
  });

  it("每条 pattern 都有非空 selector + kind", () => {
    for (const p of HIGH_RISK_PATTERNS) {
      expect(p.kind).toBeTruthy();
      expect(p.selector.length).toBeGreaterThan(0);
    }
  });

  it("rte pattern 含 contenteditable（RTE 标志）", () => {
    const rte = HIGH_RISK_PATTERNS.find((p) => p.kind === "rte")!;
    expect(rte.selector).toContain("contenteditable");
  });

  it("drag_drop pattern 含 draggable", () => {
    const dd = HIGH_RISK_PATTERNS.find((p) => p.kind === "drag_drop")!;
    expect(dd.selector).toContain("draggable");
  });

  it("toast pattern 含 role=alert", () => {
    const toast = HIGH_RISK_PATTERNS.find((p) => p.kind === "toast")!;
    expect(toast.selector).toContain('role="alert"');
  });

  it("数组被 Object.freeze（运行时不可变，强化 INV-14）", () => {
    expect(Object.isFrozen(HIGH_RISK_PATTERNS)).toBe(true);
  });
});

// ============================================================
// READONLY_ACTIONS 白名单
// ============================================================
describe("READONLY_ACTIONS — 只读 action 白名单", () => {
  it("含 navigate/snapshot/screenshot/extract/wait/evaluate", () => {
    expect(READONLY_ACTIONS.has("navigate")).toBe(true);
    expect(READONLY_ACTIONS.has("snapshot")).toBe(true);
    expect(READONLY_ACTIONS.has("screenshot")).toBe(true);
    expect(READONLY_ACTIONS.has("extract")).toBe(true);
    expect(READONLY_ACTIONS.has("wait")).toBe(true);
    expect(READONLY_ACTIONS.has("evaluate")).toBe(true);
  });

  it("不含 click/fill（副作用 action 必须过 gate）", () => {
    expect(READONLY_ACTIONS.has("click")).toBe(false);
    expect(READONLY_ACTIONS.has("fill")).toBe(false);
  });
});

// ============================================================
// assessStep — 副作用 action + pattern 命中
// ============================================================
describe("HighRiskGate.assessStep — pattern 命中拦截", () => {
  it("rte 命中 → blocked=true + reason=high_risk_pattern:rte + evidence", async () => {
    const { client, calls } = makeMockClient(
      JSON.stringify({
        ok: true,
        kind: "rte",
        html: '<div role="textbox" contenteditable="true"></div>',
      }),
    );
    const gate = new HighRiskGate(async () => client);
    const v = await gate.assessStep(
      step("click", { selectors: { click: "uid1" } }),
    );
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("high_risk_pattern:rte");
    expect(v.evidence).toContain("contenteditable");
    // 调了 evaluate_script 1 次
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("evaluate_script");
  });

  it("drag_drop 命中 → blocked=true + reason=high_risk_pattern:drag_drop", async () => {
    const { client } = makeMockClient(
      JSON.stringify({ ok: true, kind: "drag_drop", html: '<div draggable="true">' }),
    );
    const gate = new HighRiskGate(async () => client);
    const v = await gate.assessStep(
      step("click", { selectors: { click: "uid1" } }),
    );
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("high_risk_pattern:drag_drop");
  });

  it("data_grid 命中 → blocked=true", async () => {
    const { client } = makeMockClient(
      JSON.stringify({ ok: true, kind: "data_grid", html: '<table role="grid">' }),
    );
    const gate = new HighRiskGate(async () => client);
    const v = await gate.assessStep(
      step("fill", { selectors: { field1: "v1" } }),
    );
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("high_risk_pattern:data_grid");
  });

  it("tree_view 命中 → blocked=true", async () => {
    const { client } = makeMockClient(
      JSON.stringify({ ok: true, kind: "tree_view", html: '<ul role="tree">' }),
    );
    const gate = new HighRiskGate(async () => client);
    const v = await gate.assessStep(
      step("click", { selectors: { click: "uid1" } }),
    );
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("high_risk_pattern:tree_view");
  });

  it("toast 命中 → blocked=true", async () => {
    const { client } = makeMockClient(
      JSON.stringify({ ok: true, kind: "toast", html: '<div role="alert">' }),
    );
    const gate = new HighRiskGate(async () => client);
    const v = await gate.assessStep(
      step("click", { selectors: { click: "uid1" } }),
    );
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("high_risk_pattern:toast");
  });

  it("未命中 pattern（ok:true 无 kind）→ blocked=false", async () => {
    const { client } = makeMockClient(JSON.stringify({ ok: true }));
    const gate = new HighRiskGate(async () => client);
    const v = await gate.assessStep(
      step("click", { selectors: { click: "uid1" } }),
    );
    expect(v.blocked).toBe(false);
    expect(v.reason).toBeUndefined();
  });
});

// ============================================================
// assessStep — 白名单 / 无 target 放过
// ============================================================
describe("HighRiskGate.assessStep — 白名单 + 边界", () => {
  it("navigate（只读）→ 不调 evaluate_script，直接 blocked=false", async () => {
    const { client, calls } = makeMockClient(JSON.stringify({ ok: true }));
    const gate = new HighRiskGate(async () => client);
    const v = await gate.assessStep(step("navigate"));
    expect(v.blocked).toBe(false);
    expect(calls).toHaveLength(0); // 白名单短路
  });

  it("snapshot / extract / wait / evaluate / screenshot 都不调 evaluate_script", async () => {
    const { client, calls } = makeMockClient(JSON.stringify({ ok: true }));
    const gate = new HighRiskGate(async () => client);
    for (const a of ["snapshot", "extract", "wait", "evaluate", "screenshot"]) {
      const v = await gate.assessStep(step(a));
      expect(v.blocked).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("副作用 action 无 selectors.click/fill → 不拦（让 channel 报错）", async () => {
    const { client, calls } = makeMockClient(JSON.stringify({ ok: true }));
    const gate = new HighRiskGate(async () => client);
    const v = await gate.assessStep(step("click")); // 无 selectors
    expect(v.blocked).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("element_not_found（页面无目标元素）→ 不拦（保守）", async () => {
    const { client } = makeMockClient(
      JSON.stringify({ ok: false, reason: "element_not_found" }),
    );
    const gate = new HighRiskGate(async () => client);
    const v = await gate.assessStep(
      step("click", { selectors: { click: "uid1" } }),
    );
    expect(v.blocked).toBe(false);
  });

  it("client 抛错（子进程未起 / 通道断开）→ 不拦 + reason=gate_error:no_client", async () => {
    const gate = new HighRiskGate(async () => {
      throw new Error("not_connected");
    });
    const v = await gate.assessStep(
      step("click", { selectors: { click: "uid1" } }),
    );
    expect(v.blocked).toBe(false);
    expect(v.reason).toMatch(/gate_error:no_client/);
  });

  it("evaluate_script 抛错 → 不拦 + reason=gate_error:eval", async () => {
    const gate = new HighRiskGate(async () => makeThrowingClient("eval boom"));
    const v = await gate.assessStep(
      step("click", { selectors: { click: "uid1" } }),
    );
    expect(v.blocked).toBe(false);
    expect(v.reason).toMatch(/gate_error:eval/);
  });

  it("evaluate 返回空 text → 不拦 + reason=gate_error:empty_eval", async () => {
    const client = {
      async callTool(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        return { content: [] };
      },
    };
    const gate = new HighRiskGate(async () => client as unknown as McpClient);
    const v = await gate.assessStep(
      step("click", { selectors: { click: "uid1" } }),
    );
    expect(v.blocked).toBe(false);
    expect(v.reason).toMatch(/gate_error:empty_eval/);
  });
});

// ============================================================
// buildAssessExpr — 表达式构造
// ============================================================
describe("buildAssessExpr — JS 表达式构造", () => {
  it("含 data-lasso-uid selector + CSS.escape", () => {
    const expr = buildAssessExpr("uid1");
    expect(expr).toContain("data-lasso-uid");
    expect(expr).toContain("CSS.escape");
  });

  it("含 document.activeElement fallback", () => {
    const expr = buildAssessExpr("uid1");
    expect(expr).toContain("document.activeElement");
  });

  it("含 5 类 pattern 的 (kind, selector) 对", () => {
    const expr = buildAssessExpr("uid1");
    // 序列化后的 pairs 数组含每条 pattern 的 kind + selector 子串
    for (const p of HIGH_RISK_PATTERNS) {
      expect(expr).toContain(p.kind);
      expect(expr).toContain(p.selector.replace(/[\\"]/g, (m) => `\\${m}`));
    }
  });

  it("target 字符串以 JSON 序列化嵌入（防注入）", () => {
    const evil = '"]"; document.body.innerHTML = "pwned"; //';
    const expr = buildAssessExpr(evil);
    // 嵌入的应是 JSON 字面量，不会逃逸出字符串上下文
    expect(expr).toContain(JSON.stringify(evil));
  });

  it("返回表达式是 IIFE（以 (function(){ 开头，以 })() 结尾）", () => {
    const expr = buildAssessExpr("x");
    expect(expr.trim().startsWith("(function(){")).toBe(true);
    expect(expr.trim().endsWith("})()")).toBe(true);
  });
});

// ============================================================
// HighRiskAssessment 类型形状（类型级）
// ============================================================
describe("HighRiskAssessment — 类型形状", () => {
  it("blocked=false 时 reason 可缺省", () => {
    const v: HighRiskAssessment = { blocked: false };
    expect(v.blocked).toBe(false);
    expect(v.reason).toBeUndefined();
    expect(v.evidence).toBeUndefined();
  });

  it("blocked=true 时 reason 必填", () => {
    const v: HighRiskAssessment = {
      blocked: true,
      reason: "high_risk_pattern:rte",
      evidence: "<div>",
    };
    expect(v.blocked).toBe(true);
    expect(v.reason).toBeDefined();
  });
});
