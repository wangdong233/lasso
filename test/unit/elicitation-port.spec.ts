/**
 * SdkElicitationPort 单测（v1.17 Phase E，parse24 §6.1 C1）
 *
 * 裁决红线（缺一不可）：
 *  ① clientCapabilities 未声明 elicitation（undefined / {} / 有 elicitation 无
 *     form 子键 三态）→ "unavailable" 且 **连请求都不发**（elicitInput spy 计数 0）
 *  ② elicitInput 任何 throw（SDK 能力守卫 / RequestTimeout / 传输错误）
 *     → "unavailable"（端口永不 throw）
 *  ③ accept + decision=continue → "accept"；skip/abort/缺失 → "decline"；
 *     action=decline/cancel → "decline"
 *  ④ 端口无跨调用状态：连续两次确认 → 两次 elicitInput（accept 不记忆）
 *
 * SDK API 形态依据 parse24 §1（node_modules@1.30.0 亲读）：
 *  McpServer.server.elicitInput(params, options) / getClientCapabilities()。
 */
import { describe, it, expect, vi } from "vitest";
import {
  SdkElicitationPort,
  buildHighRiskElicitMessage,
  HIGH_RISK_ELICIT_TIMEOUT_MS,
  HIGH_RISK_ELICIT_EVIDENCE_MAX,
  HIGH_RISK_DECISION_ENUM,
} from "../../src/interact/ElicitationPort.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";

// ============================================================
// fake McpServer（只实装 SdkElicitationPort 消费的两个成员）
// ============================================================
type Caps = Record<string, unknown> | undefined;

function makeFakeServer(caps: Caps, elicitImpl?: (params: unknown, opts?: unknown) => Promise<ElicitResult>): {
  server: McpServer;
  elicitInput: ReturnType<typeof vi.fn>;
} {
  const elicitInput = vi.fn(elicitImpl ?? (async () => ({ action: "accept", content: { decision: "continue" } }) as ElicitResult));
  const server = {
    getClientCapabilities: () => caps,
    elicitInput,
  };
  return { server: { server } as unknown as McpServer, elicitInput };
}

const FORM_CAPS = { elicitation: { form: {} } };

// ============================================================
// ① 能力守卫（裁决红线：未声明 → 连请求都不发）
// ============================================================
describe("SdkElicitationPort — capability 守卫（裁决红线）", () => {
  it("clientCapabilities === undefined → unavailable 且 elicitInput 零调用", async () => {
    const { server, elicitInput } = makeFakeServer(undefined);
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe("unavailable");
    expect(elicitInput).toHaveBeenCalledTimes(0);
  });

  it("clientCapabilities === {} → unavailable 且 elicitInput 零调用", async () => {
    const { server, elicitInput } = makeFakeServer({});
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe("unavailable");
    expect(elicitInput).toHaveBeenCalledTimes(0);
  });

  it("有 elicitation 键但无 form 子键 → unavailable 且 elicitInput 零调用", async () => {
    const { server, elicitInput } = makeFakeServer({ elicitation: {} });
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe("unavailable");
    expect(elicitInput).toHaveBeenCalledTimes(0);
  });

  it("elicitation.url 声明但 form 未声明 → 仍 unavailable（守卫的是 form 子能力）", async () => {
    const { server, elicitInput } = makeFakeServer({ elicitation: { url: {} } });
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe("unavailable");
    expect(elicitInput).toHaveBeenCalledTimes(0);
  });

  it("elicitation.form 声明 → 发请求（一次 elicitInput）", async () => {
    const { server, elicitInput } = makeFakeServer(FORM_CAPS);
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe("accept");
    expect(elicitInput).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// ② 请求形态（form 档 params + timeout 选项）
// ============================================================
describe("SdkElicitationPort — elicitInput 请求形态", () => {
  it("params 是 form 档：message 含 kind+evidence；decision 是受限 enum schema", async () => {
    const { server, elicitInput } = makeFakeServer(FORM_CAPS);
    const port = new SdkElicitationPort(server);
    await port.confirmHighRisk("drag_drop", '<div draggable="true">x</div>');
    const [params, options] = elicitInput.mock.calls[0] as [
      {
        mode?: string;
        message: string;
        requestedSchema: {
          type: string;
          properties: Record<string, { type: string; enum: string[]; enumNames: string[] }>;
          required: string[];
        };
      },
      { timeout: number; maxTotalTimeout: number },
    ];
    expect(params.mode).toBe("form");
    expect(params.message).toContain("drag_drop");
    expect(params.message).toContain('draggable="true"');
    expect(params.requestedSchema.type).toBe("object");
    const d = params.requestedSchema.properties.decision;
    expect(d.type).toBe("string");
    expect(d.enum).toEqual([...HIGH_RISK_DECISION_ENUM]);
    expect(d.enumNames).toEqual(["继续执行", "跳过本步", "终止"]);
    expect(params.requestedSchema.required).toEqual(["decision"]);
    expect(options.timeout).toBe(HIGH_RISK_ELICIT_TIMEOUT_MS);
    expect(options.maxTotalTimeout).toBe(HIGH_RISK_ELICIT_TIMEOUT_MS);
  });

  it("evidence 超 200 字符 → message 内截断到 200", async () => {
    const { server, elicitInput } = makeFakeServer(FORM_CAPS);
    const port = new SdkElicitationPort(server);
    const long = "x".repeat(500);
    await port.confirmHighRisk("rte", long);
    const [params] = elicitInput.mock.calls[0] as [{ message: string }, unknown];
    // message 含截断后的 evidence（≤200 个 x），不含第 201 个起的连续段
    expect(params.message).toContain("x".repeat(HIGH_RISK_ELICIT_EVIDENCE_MAX));
    expect(params.message).not.toContain("x".repeat(HIGH_RISK_ELICIT_EVIDENCE_MAX + 1));
  });

  it("evidence 为空串 → message 仍含 kind（不崩）", async () => {
    const { server, elicitInput } = makeFakeServer(FORM_CAPS);
    const port = new SdkElicitationPort(server);
    await port.confirmHighRisk("toast", "");
    const [params] = elicitInput.mock.calls[0] as [{ message: string }, unknown];
    expect(params.message).toContain("toast");
  });
});

// ============================================================
// ③ 结果映射
// ============================================================
describe("SdkElicitationPort — ElicitResult 映射", () => {
  const cases: Array<[string, ElicitResult, "accept" | "decline"]> = [
    ["accept + continue → accept", { action: "accept", content: { decision: "continue" } }, "accept"],
    ["accept + skip → decline", { action: "accept", content: { decision: "skip" } }, "decline"],
    ["accept + abort → decline", { action: "accept", content: { decision: "abort" } }, "decline"],
    ["accept + decision 缺失（防御） → decline", { action: "accept" }, "decline"],
    ["decline → decline", { action: "decline" }, "decline"],
    ["cancel → decline", { action: "cancel" }, "decline"],
  ];
  for (const [name, result, expected] of cases) {
    it(name, async () => {
      const { server } = makeFakeServer(FORM_CAPS, async () => result);
      const port = new SdkElicitationPort(server);
      await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe(expected);
    });
  }
});

// ============================================================
// ②′ 异常路径（端口永不 throw）
// ============================================================
describe("SdkElicitationPort — 异常 fail-closed（永不 throw）", () => {
  it("elicitInput 抛 RequestTimeout 类错误 → unavailable", async () => {
    const { server } = makeFakeServer(FORM_CAPS, async () => {
      throw new Error("McpError: Request timed out");
    });
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe("unavailable");
  });

  it("elicitInput 抛传输错误 → unavailable", async () => {
    const { server } = makeFakeServer(FORM_CAPS, async () => {
      throw new Error("Not connected");
    });
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe("unavailable");
  });

  it("elicitInput 抛 SDK 能力守卫同步 throw（caps 与守卫竞争态）→ unavailable", async () => {
    // 预检通过但 SDK 内部守卫仍 throw（如客户端中途断连降级能力）
    const { server } = makeFakeServer(FORM_CAPS, async () => {
      throw new Error("Client does not support form elicitation.");
    });
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe("unavailable");
  });

  it("getClientCapabilities 自身 throw → unavailable（不上抛）", async () => {
    const elicitInput = vi.fn(async () => ({ action: "accept", content: { decision: "continue" } }) as ElicitResult);
    const server = {
      server: {
        getClientCapabilities: () => {
          throw new Error("caps boom");
        },
        elicitInput,
      },
    } as unknown as McpServer;
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<div>")).resolves.toBe("unavailable");
    expect(elicitInput).toHaveBeenCalledTimes(0);
  });
});

// ============================================================
// ④ 无状态（accept 不记忆）
// ============================================================
describe("SdkElicitationPort — 无跨调用状态", () => {
  it("连续两次 confirmHighRisk（均 accept）→ elicitInput 各调一次（无缓存）", async () => {
    const { server, elicitInput } = makeFakeServer(FORM_CAPS);
    const port = new SdkElicitationPort(server);
    await expect(port.confirmHighRisk("rte", "<a>")).resolves.toBe("accept");
    await expect(port.confirmHighRisk("rte", "<b>")).resolves.toBe("accept");
    expect(elicitInput).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// buildHighRiskElicitMessage 纯函数
// ============================================================
describe("buildHighRiskElicitMessage — 纯函数", () => {
  it("kind + evidence 组装", () => {
    const m = buildHighRiskElicitMessage("tree_view", '<ul role="tree">');
    expect(m).toContain("tree_view");
    expect(m).toContain('role="tree"');
  });

  it("截断上限 = HIGH_RISK_ELICIT_EVIDENCE_MAX（200）", () => {
    const m = buildHighRiskElicitMessage("rte", "y".repeat(999));
    expect(m).toContain("y".repeat(200));
    expect(m).not.toContain("y".repeat(201));
  });
});
