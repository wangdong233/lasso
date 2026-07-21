/**
 * ExpectPoll v0.3 单测（parse3 §5.1 + §3.2 + 09 §2.3 验收 2/3）
 *
 * 覆盖：
 *  - 三态 verified / preexisting / failed
 *  - gone=true 反向语义（present→!satisfied）
 *  - gone=true preexisting（act 前已 absent → preexisting）
 *  - timeout 兜底 failed
 *  - validateCondition：缺 text/selector/url_contains 抛错
 *  - OR 语义（任一字段命中即 holds）
 *  - conditionHolds 纯函数（含字段缺失保守 false）
 *  - isPreexisting 字段齐全性检查（缺字段 → 不判 preexisting）
 *  - buildConditionExpr 正确生成 JS 表达式
 *  - snapshotCondition 错误吞掉（继续 poll → failed）
 *  - preSnapshot=undefined 跳过 preexisting
 *  - pollIntervalMs / timeout_ms / defaultTimeoutMs 优先级
 */
import { describe, it, expect } from "vitest";
import {
  expectPoll,
  validateCondition,
  conditionHolds,
  isPreexisting,
  buildConditionExpr,
  type ConditionSnapshot,
  type ExpectPollOptions,
} from "../../src/browse/ExpectPoll.js";
import type { ExpectCondition } from "../../src/types.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

// ============================================================
// Mock McpClient
// ============================================================
type Verdict = "true" | "false";
type Plan = Verdict[] | ((i: number) => Verdict | Promise<Verdict>);

/**
 * 构造 mock McpClient：
 *  - plan 为数组：按序返回；超出后用最后一个值（或 "false" 兜底）
 *  - plan 为函数：每次按调用序号计算
 * callTool("evaluate_script", { function }) → { content: [{type:"text", text}] }
 */
function makeMockClient(plan: Plan): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let i = 0;
  const client = {
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
      const idx = i++;
      calls.push({ name, args });
      let val: Verdict;
      if (Array.isArray(plan)) {
        val = plan[idx] ?? plan[plan.length - 1] ?? "false";
      } else {
        val = await plan(idx);
      }
      return { content: [{ type: "text", text: val }] };
    },
  };
  return { client: client as unknown as McpClient, calls };
}

/** Mock client that always throws on callTool（模拟页面未就绪 / 通道断开）。 */
function makeThrowingClient(error = "eval_failed"): McpClient {
  const client = {
    async callTool(): Promise<never> {
      throw new Error(error);
    },
  };
  return client as unknown as McpClient;
}

// ============================================================
// 快测 opts：1ms 间隔 + 短 timeout（保持测试 < 100ms）
// ============================================================
const FAST: ExpectPollOptions = { pollIntervalMs: 1, defaultTimeoutMs: 20 };

// ============================================================
// validateCondition
// ============================================================
describe("validateCondition", () => {
  it("缺 text/selector/url_contains → throw", () => {
    expect(() => validateCondition({})).toThrow(
      /at least one of text\/selector\/url_contains/,
    );
  });

  it("仅有 gone + timeout_ms 也算缺字段 → throw", () => {
    expect(() => validateCondition({ gone: true, timeout_ms: 5000 })).toThrow();
  });

  it("有 text → ok", () => {
    expect(() => validateCondition({ text: "hello" })).not.toThrow();
  });

  it("有 selector → ok", () => {
    expect(() => validateCondition({ selector: ".btn" })).not.toThrow();
  });

  it("有 url_contains → ok", () => {
    expect(() => validateCondition({ url_contains: "example.com" })).not.toThrow();
  });

  it("三字段都有 → ok", () => {
    expect(() =>
      validateCondition({ text: "x", selector: ".y", url_contains: "z" }),
    ).not.toThrow();
  });
});

// ============================================================
// expectPoll — 三态
// ============================================================
describe("expectPoll — 三态", () => {
  it("verified：首次 poll 即满足 → 返回 verified", async () => {
    const { client } = makeMockClient(["true"]);
    const verdict = await expectPoll(
      client,
      { selector: ".btn" },
      undefined,
      FAST,
    );
    expect(verdict).toBe("verified");
  });

  it("verified：前 2 次 false，第 3 次 true → verified（不放弃）", async () => {
    const { client } = makeMockClient(["false", "false", "true"]);
    const verdict = await expectPoll(
      client,
      { text: "submitted" },
      undefined,
      FAST,
    );
    expect(verdict).toBe("verified");
  });

  it("failed：timeout 内一直 false → failed", async () => {
    const { client } = makeMockClient((_) => "false");
    const verdict = await expectPoll(
      client,
      { selector: ".never" },
      undefined,
      FAST,
    );
    expect(verdict).toBe("failed");
  });

  it("preexisting：preSnapshot 显示条件已满足 → 直接 preexisting（不 poll）", async () => {
    const { client, calls } = makeMockClient(["true"]);
    const preSnap: ConditionSnapshot = {
      url: "https://example.com/dashboard",
      body_text: "Welcome back",
    };
    const verdict = await expectPoll(
      client,
      { url_contains: "dashboard" },
      preSnap,
      FAST,
    );
    expect(verdict).toBe("preexisting");
    // 不应调用 client.callTool（短路）
    expect(calls).toHaveLength(0);
  });

  it("preSnapshot=undefined → 跳过 preexisting 判定，直接 poll", async () => {
    const { client, calls } = makeMockClient(["true"]);
    const verdict = await expectPoll(
      client,
      { text: "x" },
      undefined,
      FAST,
    );
    expect(verdict).toBe("verified");
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// expectPoll — gone=true 反向语义
// ============================================================
describe("expectPoll — gone=true 反向语义", () => {
  it("gone=true：元素仍 present（holds=true）→ !satisfied → 继续 poll", async () => {
    const { client } = makeMockClient((_) => "true"); // 一直 present
    const verdict = await expectPoll(
      client,
      { selector: ".popup", gone: true },
      undefined,
      FAST,
    );
    expect(verdict).toBe("failed");
  });

  it("gone=true：首次 present，第二次 absent → verified", async () => {
    const { client } = makeMockClient(["true", "false"]);
    const verdict = await expectPoll(
      client,
      { selector: ".popup", gone: true },
      undefined,
      FAST,
    );
    expect(verdict).toBe("verified");
  });

  it("gone=true + preexisting：act 前已 absent → preexisting", async () => {
    const { client, calls } = makeMockClient(["true"]);
    const preSnap: ConditionSnapshot = {
      selector_hits: { ".popup": false }, // act 前已 absent
    };
    const verdict = await expectPoll(
      client,
      { selector: ".popup", gone: true },
      preSnap,
      FAST,
    );
    expect(verdict).toBe("preexisting");
    expect(calls).toHaveLength(0);
  });

  it("gone=true + 非 preexisting：act 前 present → 不算 preexisting", async () => {
    const { client, calls } = makeMockClient(["false"]);
    const preSnap: ConditionSnapshot = {
      selector_hits: { ".popup": true }, // act 前 present
    };
    const verdict = await expectPoll(
      client,
      { selector: ".popup", gone: true },
      preSnap,
      FAST,
    );
    // 不应短路为 preexisting；poll 后第一次 holds=false → !false=verified
    expect(verdict).toBe("verified");
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("gone=false（默认）：preSnapshot present → preexisting（不反向）", async () => {
    const { client, calls } = makeMockClient(["false"]);
    const preSnap: ConditionSnapshot = {
      body_text: "Login successful",
    };
    const verdict = await expectPoll(
      client,
      { text: "Login successful" },
      preSnap,
      FAST,
    );
    expect(verdict).toBe("preexisting");
    expect(calls).toHaveLength(0);
  });
});

// ============================================================
// expectPoll — timeout / interval 配置
// ============================================================
describe("expectPoll — 配置优先级", () => {
  it("cond.timeout_ms 覆盖 opts.defaultTimeoutMs", async () => {
    // cond.timeout_ms=5 比默认 20 短 → 失败更快
    const { client } = makeMockClient((_) => "false");
    const t0 = Date.now();
    await expectPoll(
      client,
      { text: "x", timeout_ms: 5 },
      undefined,
      { pollIntervalMs: 1, defaultTimeoutMs: 100 },
    );
    const elapsed = Date.now() - t0;
    // timeout_ms=5 + 1ms poll → 总耗时 < 50ms（远小于 100ms 默认）
    expect(elapsed).toBeLessThan(80);
  });

  it("opts.defaultTimeoutMs 在 cond.timeout_ms 缺省时启用", async () => {
    const { client } = makeMockClient((_) => "false");
    const t0 = Date.now();
    await expectPoll(
      client,
      { text: "x" },
      undefined,
      { pollIntervalMs: 1, defaultTimeoutMs: 10 },
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(80);
  });

  it("pollIntervalMs=0 → 仍正常工作（busy poll）", async () => {
    const { client } = makeMockClient(["true"]);
    const verdict = await expectPoll(
      client,
      { text: "x" },
      undefined,
      { pollIntervalMs: 0, defaultTimeoutMs: 50 },
    );
    expect(verdict).toBe("verified");
  });

  it("poll 真的按指定间隔 sleep（通过 calls 数量验证）", async () => {
    // timeout=20ms，interval=5ms → 最多 4 次 poll
    const { client, calls } = makeMockClient((_) => "false");
    await expectPoll(
      client,
      { text: "x" },
      undefined,
      { pollIntervalMs: 5, defaultTimeoutMs: 20 },
    );
    // 至少 1 次，至多 ~5 次（20ms/5ms=4，留 1 容差）
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});

// ============================================================
// expectPoll — 错误容忍
// ============================================================
describe("expectPoll — snapshotCondition 错误", () => {
  it("client.callTool 抛错 → 视为本次 holds=false，继续 poll → failed", async () => {
    const client = makeThrowingClient("page not ready");
    const verdict = await expectPoll(
      client,
      { text: "x" },
      undefined,
      { pollIntervalMs: 1, defaultTimeoutMs: 10 },
    );
    expect(verdict).toBe("failed");
  });
});

// ============================================================
// conditionHolds — 纯函数
// ============================================================
describe("conditionHolds — 纯函数", () => {
  it("text 匹配 body_text → true", () => {
    const snap: ConditionSnapshot = { body_text: "hello world" };
    expect(conditionHolds(snap, { text: "hello" })).toBe(true);
  });

  it("text 不匹配 → false", () => {
    const snap: ConditionSnapshot = { body_text: "goodbye" };
    expect(conditionHolds(snap, { text: "hello" })).toBe(false);
  });

  it("url_contains 匹配 → true", () => {
    const snap: ConditionSnapshot = { url: "https://app.example.com/dashboard" };
    expect(conditionHolds(snap, { url_contains: "dashboard" })).toBe(true);
  });

  it("selector_hits 命中 → true", () => {
    const snap: ConditionSnapshot = {
      selector_hits: { ".btn": true, ".popup": false },
    };
    expect(conditionHolds(snap, { selector: ".btn" })).toBe(true);
    expect(conditionHolds(snap, { selector: ".popup" })).toBe(false);
  });

  it("OR：多字段任一命中 → true", () => {
    const snap: ConditionSnapshot = {
      url: "https://no-match.com/",
      body_text: "Welcome",
      selector_hits: { ".btn": true },
    };
    expect(
      conditionHolds(snap, {
        text: "not-there",
        url_contains: "not-here",
        selector: ".btn",
      }),
    ).toBe(true);
  });

  it("字段缺失：snap 无 body_text，cond.text → false（保守）", () => {
    const snap: ConditionSnapshot = { url: "https://x.com/" };
    expect(conditionHolds(snap, { text: "x" })).toBe(false);
  });

  it("字段缺失：snap 无 url，cond.url_contains → false", () => {
    const snap: ConditionSnapshot = { body_text: "x" };
    expect(conditionHolds(snap, { url_contains: "x.com" })).toBe(false);
  });

  it("字段缺失：snap 无 selector_hits，cond.selector → false", () => {
    const snap: ConditionSnapshot = { url: "https://x.com/" };
    expect(conditionHolds(snap, { selector: ".btn" })).toBe(false);
  });
});

// ============================================================
// isPreexisting — 字段齐全性 + gone 语义
// ============================================================
describe("isPreexisting", () => {
  it("非 gone：present → preexisting", () => {
    const pre: ConditionSnapshot = { body_text: "submitted" };
    expect(isPreexisting(pre, { text: "submitted" })).toBe(true);
  });

  it("非 gone：absent → 非 preexisting", () => {
    const pre: ConditionSnapshot = { body_text: "other" };
    expect(isPreexisting(pre, { text: "submitted" })).toBe(false);
  });

  it("gone=true：present → 非 preexisting（还没消失）", () => {
    const pre: ConditionSnapshot = { selector_hits: { ".popup": true } };
    expect(isPreexisting(pre, { selector: ".popup", gone: true })).toBe(false);
  });

  it("gone=true：absent → preexisting（已消失）", () => {
    const pre: ConditionSnapshot = { selector_hits: { ".popup": false } };
    expect(isPreexisting(pre, { selector: ".popup", gone: true })).toBe(true);
  });

  it("字段缺失：snap 无 body_text → 不判 preexisting（保守 false）", () => {
    const pre: ConditionSnapshot = { url: "https://x.com/" };
    // cond.text 但 snap.body_text === undefined → 不能判 preexisting
    expect(isPreexisting(pre, { text: "anything" })).toBe(false);
  });

  it("字段缺失：cond 用 selector 但 snap 无 selector_hits → false", () => {
    const pre: ConditionSnapshot = { url: "https://x.com/" };
    expect(isPreexisting(pre, { selector: ".btn", gone: true })).toBe(false);
  });
});

// ============================================================
// buildConditionExpr — JS 表达式生成
// ============================================================
describe("buildConditionExpr", () => {
  it("仅 url_contains → 单子句", () => {
    const expr = buildConditionExpr({ url_contains: "example.com" });
    expect(expr).toContain("window.location.href.indexOf");
    expect(expr).toContain('"example.com"');
    expect(expr).toMatch(/^\(function\(\)\{/);
    expect(expr).toMatch(/\.toString\(\);?\s*\}\)\(\)$/);
  });

  it("仅 selector → 单子句 + querySelector", () => {
    const expr = buildConditionExpr({ selector: ".btn" });
    expect(expr).toContain("document.querySelector");
    expect(expr).toContain('".btn"');
  });

  it("仅 text → 单子句 + innerText", () => {
    const expr = buildConditionExpr({ text: "Login" });
    expect(expr).toContain("document.body");
    expect(expr).toContain("innerText");
    expect(expr).toContain('"Login"');
  });

  it("多字段 → 用 || 连接（OR）", () => {
    const expr = buildConditionExpr({
      text: "Login",
      selector: ".btn",
      url_contains: "app",
    });
    expect(expr).toContain("||");
    // 三个子句都出现
    expect(expr).toContain("window.location.href");
    expect(expr).toContain("document.querySelector");
    expect(expr).toContain("innerText");
  });

  it("JS 注入防御：text 含特殊字符（引号 / 反斜杠）按 JSON.stringify 转义", () => {
    const expr = buildConditionExpr({ text: 'evil"); alert("xss' });
    // JSON.stringify 会转义双引号，不会让表达式断开
    expect(expr).not.toContain('alert("xss")');
    expect(expr).toContain('\\"');
  });

  it("生成的表达式在浏览器侧返回 'true'/'false' 字符串（形态断言）", () => {
    const expr = buildConditionExpr({ text: "x" });
    // 形态：IIFE 包裹 + return (...).toString()
    expect(expr).toMatch(/\(function\(\)\{\s*return\s*\([\s\S]+\)\.toString\(\);?\s*\}\)\(\)/);
  });
});

// ============================================================
// expectPoll — 整合：OR 字段 preexisting + verified 组合
// ============================================================
describe("expectPoll — 整合", () => {
  it("OR 字段：preSnapshot 仅 1 字段命中 → preexisting", async () => {
    const { client, calls } = makeMockClient(["false"]);
    const preSnap: ConditionSnapshot = {
      url: "https://other.com/", // url_contains 不命中
      body_text: "Welcome", // text 命中
    };
    const verdict = await expectPoll(
      client,
      { text: "Welcome", url_contains: "dashboard" },
      preSnap,
      FAST,
    );
    expect(verdict).toBe("preexisting");
    expect(calls).toHaveLength(0);
  });

  it("OR 字段：preSnapshot 两个字段都不命中 → 非 preexisting，继续 poll", async () => {
    const { client, calls } = makeMockClient(["true"]);
    const preSnap: ConditionSnapshot = {
      url: "https://other.com/",
      body_text: "Goodbye",
    };
    const verdict = await expectPoll(
      client,
      { text: "Welcome", url_contains: "dashboard" },
      preSnap,
      FAST,
    );
    expect(verdict).toBe("verified");
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
