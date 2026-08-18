/**
 * HighRiskGate × elicitation 集成测（v1.17 Phase E，parse24 §6.1 C1）
 *
 * 裁决红线测试钉死（parse24 §6.1 安全测试 1-4；#5 真机手测清单另档
 * doc/25/c1-真机手测.md）：
 *  1. clientCapabilities 未声明 elicitation（undefined / {} / 有 elicitation 无
 *     form 子键）→ assessStep 与现行（未注入 port）**deep-equal 完全一致**
 *  2. 能力未声明时 elicitInput 零调用（连请求都不发）
 *  3. elicitInput throw → blocked=true 不放行（现行 blocked 路径）
 *  4. accept 无记忆：连续两步命中 → 每步独立确认（port 调用两次，无缓存）
 *
 * 另覆盖：
 *  - accept → blocked=false + reason="high_risk_elicited:<kind>"
 *  - port 违约 throw → fail-closed blocked=true（不落 StepEngine 异常放行兜底）
 *  - LoggedInChannel 注入链：setElicitationPort 传递到 gate；缺省 null 零回归
 */
import { describe, it, expect, vi } from "vitest";
import { HighRiskGate } from "../../src/browse/HighRiskGate.js";
import { SdkElicitationPort } from "../../src/interact/ElicitationPort.js";
import type { ElicitationPort } from "../../src/interact/ElicitationPort.js";
import { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Step } from "../../src/browse/steps-types.js";

// ============================================================
// helpers
// ============================================================
/** mock McpClient：evaluate_script 恒返 pattern 命中 verdict。 */
function makeHitClient(kind: string, html: string): McpClient {
  return {
    async callTool() {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, kind, html }) }],
      };
    },
  } as unknown as McpClient;
}

/** fake McpServer（SdkElicitationPort 消费面：getClientCapabilities + elicitInput）。 */
function makeFakeServer(caps: Record<string, unknown> | undefined, elicitImpl?: () => Promise<unknown>): {
  server: McpServer;
  elicitInput: ReturnType<typeof vi.fn>;
} {
  const elicitInput = vi.fn(elicitImpl ?? (async () => ({ action: "accept", content: { decision: "continue" } })));
  return {
    server: { server: { getClientCapabilities: () => caps, elicitInput } } as unknown as McpServer,
    elicitInput,
  };
}

const RTE_HTML = '<div role="textbox" contenteditable="true"></div>';

function clickStep(): Step {
  return { action: "click", selectors: { click: "uid1" } };
}

/** mock port（自由控制决议 + 计数）。 */
function makePort(decision: "accept" | "decline" | "unavailable" | Error): {
  port: ElicitationPort;
  calls: Array<{ kind: string; evidence: string }>;
} {
  const calls: Array<{ kind: string; evidence: string }> = [];
  const port = {
    async confirmHighRisk(kind: string, evidence: string) {
      calls.push({ kind, evidence });
      if (decision instanceof Error) throw decision;
      return decision;
    },
  };
  return { port, calls };
}

// ============================================================
// 红线 1+2：能力未声明 → 与现行 deep-equal + elicitInput 零调用
// ============================================================
describe("C1 红线 — clientCapabilities 未声明 → 100% 现行 didnt 路径", () => {
  const undeclaredCases: Array<[string, Record<string, unknown> | undefined]> = [
    ["undefined（客户端未上报 capabilities）", undefined],
    ["{}（无 elicitation 键）", {}],
    ["有 elicitation 无 form 子键", { elicitation: {} }],
    ["elicitation.url 有但 form 无", { elicitation: { url: {} } }],
  ];

  for (const [label, caps] of undeclaredCases) {
    it(`能力=${label} → assessStep 与现行 deep-equal + elicitInput 零调用`, async () => {
      const client = makeHitClient("rte", RTE_HTML);
      // 现行行为基准：未注入 port 的 gate
      const legacyGate = new HighRiskGate(async () => client);
      const legacy = await legacyGate.assessStep(clickStep());

      // 注入真 SdkElicitationPort（fake server，能力未声明）
      const { server, elicitInput } = makeFakeServer(caps);
      const gated = new HighRiskGate(
        async () => client,
        new SdkElicitationPort(server),
      );
      const v = await gated.assessStep(clickStep());

      // byte-identical：全对象 deep-equal（blocked/reason/evidence 逐字段）
      expect(v).toEqual(legacy);
      expect(v).toEqual({
        blocked: true,
        reason: "high_risk_pattern:rte",
        evidence: RTE_HTML,
      });
      // 红线 2：连请求都不发
      expect(elicitInput).toHaveBeenCalledTimes(0);
    });
  }
});

// ============================================================
// 红线 3：elicitInput throw → blocked=true 不放行
// ============================================================
describe("C1 红线 — elicitInput 异常 → blocked 不放行", () => {
  const throwCases: Array<[string, Error]> = [
    ["RequestTimeout（McpError）", new Error("McpError: Request timed out (120000ms)")],
    ["传输错误", new Error("Not connected")],
    ["SDK 能力守卫同步 throw", new Error("Client does not support form elicitation.")],
  ];
  for (const [label, err] of throwCases) {
    it(`elicitInput 抛 ${label} → blocked=true + 现行 reason`, async () => {
      const client = makeHitClient("rte", RTE_HTML);
      const { server } = makeFakeServer({ elicitation: { form: {} } }, async () => {
        throw err;
      });
      const gate = new HighRiskGate(async () => client, new SdkElicitationPort(server));
      const v = await gate.assessStep(clickStep());
      expect(v.blocked).toBe(true);
      expect(v.reason).toBe("high_risk_pattern:rte");
      expect(v.evidence).toBe(RTE_HTML);
    });
  }
});

// ============================================================
// 决议映射（mock port 直控）
// ============================================================
describe("HighRiskGate × port 决议映射", () => {
  it('port=accept → blocked=false + reason="high_risk_elicited:rte"（审计可见）', async () => {
    const client = makeHitClient("rte", RTE_HTML);
    const { port, calls } = makePort("accept");
    const gate = new HighRiskGate(async () => client, port);
    const v = await gate.assessStep(clickStep());
    expect(v).toEqual({ blocked: false, reason: "high_risk_elicited:rte" });
    // port 收到 kind + evidence（供人读）
    expect(calls).toEqual([{ kind: "rte", evidence: RTE_HTML }]);
  });

  it("port=decline（用户拒绝）→ 现行 blocked 路径 deep-equal", async () => {
    const client = makeHitClient("drag_drop", '<div draggable="true">');
    const legacyGate = new HighRiskGate(async () => client);
    const legacy = await legacyGate.assessStep(clickStep());
    const { port } = makePort("decline");
    const gate = new HighRiskGate(async () => client, port);
    const v = await gate.assessStep(clickStep());
    expect(v).toEqual(legacy);
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("high_risk_pattern:drag_drop");
  });

  it("port=unavailable → 现行 blocked 路径 deep-equal", async () => {
    const client = makeHitClient("toast", '<div role="alert">');
    const { port } = makePort("unavailable");
    const gate = new HighRiskGate(async () => client, port);
    const v = await gate.assessStep(clickStep());
    expect(v).toEqual({
      blocked: true,
      reason: "high_risk_pattern:toast",
      evidence: '<div role="alert">',
    });
  });

  it("port 违约 throw → fail-closed：blocked=true（不落 StepEngine 异常放行兜底）", async () => {
    const client = makeHitClient("rte", RTE_HTML);
    const { port } = makePort(new Error("port contract violation"));
    const gate = new HighRiskGate(async () => client, port);
    // 关键：assessStep 自身不得 throw（StepEngine 对 gate 异常的兜底是 blocked=false）
    const v = await gate.assessStep(clickStep());
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("high_risk_pattern:rte");
  });

  it("未命中 pattern → port 不被调用（port 只在命中后介入）", async () => {
    const client: McpClient = {
      async callTool() {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
    } as unknown as McpClient;
    const { port, calls } = makePort("accept");
    const gate = new HighRiskGate(async () => client, port);
    const v = await gate.assessStep(clickStep());
    expect(v.blocked).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ============================================================
// 红线 4：accept 无记忆（连续命中独立确认）
// ============================================================
describe("C1 红线 — accept 无记忆（INV-14 anti-gaming 延伸）", () => {
  it("连续两步命中 pattern → port 每步各确认一次（无缓存状态）", async () => {
    const client = makeHitClient("rte", RTE_HTML);
    const { port, calls } = makePort("accept");
    const gate = new HighRiskGate(async () => client, port);
    const v1 = await gate.assessStep(clickStep());
    const v2 = await gate.assessStep({ action: "fill", selectors: { f1: "v" } });
    expect(v1.blocked).toBe(false);
    expect(v2.blocked).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("第一步 accept、第二步用户改主意 decline → 第二步 blocked（无跨步授权）", async () => {
    const client = makeHitClient("rte", RTE_HTML);
    let n = 0;
    const calls: string[] = [];
    const port: ElicitationPort = {
      async confirmHighRisk(kind: string) {
        calls.push(kind);
        n += 1;
        return n === 1 ? "accept" : "decline";
      },
    };
    const gate = new HighRiskGate(async () => client, port);
    const v1 = await gate.assessStep(clickStep());
    const v2 = await gate.assessStep(clickStep());
    expect(v1.blocked).toBe(false);
    expect(v2.blocked).toBe(true);
    expect(v2.reason).toBe("high_risk_pattern:rte");
    expect(calls).toHaveLength(2);
  });
});

// ============================================================
// LoggedInChannel 注入链
// ============================================================
describe("LoggedInChannel — setElicitationPort 注入链", () => {
  function makeChannel(): LoggedInChannel {
    const profiles = {
      getCurrent: () => ({ name: "default" }),
      currentName: () => "default",
      list: () => [],
      add: async () => {},
      switch: async () => {},
    } as never;
    return new LoggedInChannel({} as never, 9222, profiles, () => ({}) as never);
  }

  it("缺省（未 set）→ gate 无 port = 现行行为零回归", () => {
    const ch = makeChannel();
    const gate = (ch as unknown as { createHighRiskGate(): { elicitationPort: ElicitationPort | null } }).createHighRiskGate();
    expect(gate).not.toBeNull();
    expect(gate.elicitationPort).toBeNull();
  });

  it("setElicitationPort(port) → createHighRiskGate 产出携带 port 的 gate", () => {
    const ch = makeChannel();
    const { port } = makePort("decline");
    ch.setElicitationPort(port);
    const gate = (ch as unknown as { createHighRiskGate(): { elicitationPort: ElicitationPort | null } }).createHighRiskGate();
    expect(gate.elicitationPort).toBe(port);
  });

  it("setElicitationPort(null) → 回到现行（显式关闭）", () => {
    const ch = makeChannel();
    const { port } = makePort("accept");
    ch.setElicitationPort(port);
    ch.setElicitationPort(null);
    const gate = (ch as unknown as { createHighRiskGate(): { elicitationPort: ElicitationPort | null } }).createHighRiskGate();
    expect(gate.elicitationPort).toBeNull();
  });
});

// ============================================================
// StepEngine 端到端：port accept → 链继续（manual_abort 不触发）
// ============================================================
describe("StepEngine 端到端 — elicitation accept 后链继续", () => {
  it("port=accept → 高风险 click 步执行（非 manual_abort）；decline → manual_abort", async () => {
    const { StepEngine } = await import("../../src/browse/StepEngine.js");
    const { BudgetTracker } = await import("../../src/fallback/BudgetTracker.js");
    const evidence = RTE_HTML;

    // channel stub：executeStep 成功；getMcpClient 返回 pattern 命中 client
    const hitClient = makeHitClient("rte", evidence);
    const channel = {
      name: "browse_logged_in",
      getMcpClient: async () => hitClient,
      executeStep: async () => ({ outcome: "worked", preview: "ok" }),
      runExpect: async () => "verified",
    };

    // accept 路径：链 worked、无 stopped_at
    const { port: acceptPort } = makePort("accept");
    const gateAccept = new HighRiskGate(async () => hitClient, acceptPort);
    const r1 = await new StepEngine(
      channel as never,
      new BudgetTracker(120_000),
      gateAccept,
    ).runChain("https://example.com/", [clickStep()]);
    expect(r1.outcome).toBe("worked");
    expect(r1.data?.stopped_at).toBeUndefined();

    // decline 路径：现行 manual_abort byte-identical
    const { port: declinePort } = makePort("decline");
    const gateDecline = new HighRiskGate(async () => hitClient, declinePort);
    const r2 = await new StepEngine(
      channel as never,
      new BudgetTracker(120_000),
      gateDecline,
    ).runChain("https://example.com/", [clickStep()]);
    expect(r2.outcome).toBe("didnt");
    expect(r2.data?.stopped_at?.reason).toBe("manual_abort");
    expect(r2.error).toBe("high_risk_pattern:rte");
  });
});
