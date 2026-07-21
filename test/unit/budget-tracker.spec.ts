/**
 * BudgetTracker v0.3 单测（parse3 §5.1 + §3.7）
 *
 * 覆盖：
 *  - 默认 budgetMs=120_000
 *  - spend/exhausted/remaining 边界（spend 0/negative 防御）
 *  - exhausted 在 elapsed≥budgetMs 时为 true（含等于边界）
 *  - remaining 不为负
 *  - recordPartial 累加 + getPartials 只读副本
 *  - recordPartial 时间戳由 now() 注入（确定性测试）
 *  - flushInto：无 partials → 原样返回（同引用）
 *  - flushInto：有 partials → 与既有 partial_failures 合并不覆盖
 *  - flushInto：多次调幂等（重复添加相同 partials）
 *  - partialCount()
 *  - used() / cap() 报表字段
 */
import { describe, it, expect } from "vitest";
import {
  BudgetTracker,
  DEFAULT_CHAIN_BUDGET_MS,
} from "../../src/fallback/BudgetTracker.js";
import type { InteractResult } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
function makeResult<T = unknown>(
  overrides: Partial<InteractResult<T>> = {},
): InteractResult<T> {
  return {
    outcome: "worked",
    data: null,
    served_by: "test",
    fallback_used: false,
    retrieval_method: "test",
    ...overrides,
  };
}

// ============================================================
// 默认值 / 构造
// ============================================================
describe("BudgetTracker — 构造与默认值", () => {
  it("默认 budgetMs = 120_000（DEFAULT_CHAIN_BUDGET_MS）", () => {
    const b = new BudgetTracker();
    expect(b.cap()).toBe(DEFAULT_CHAIN_BUDGET_MS);
    expect(b.cap()).toBe(120_000);
  });

  it("显式 budgetMs 生效", () => {
    const b = new BudgetTracker(5000);
    expect(b.cap()).toBe(5000);
  });

  it("初始 used=0 / remaining=budgetMs", () => {
    const b = new BudgetTracker(1000);
    expect(b.used()).toBe(0);
    expect(b.remaining()).toBe(1000);
    expect(b.exhausted()).toBe(false);
    expect(b.partialCount()).toBe(0);
  });

  it("默认 now=Date.now（不注入时仍工作）", () => {
    const b = new BudgetTracker();
    const before = Date.now();
    b.recordPartial({ channel: "x", error: "boom" });
    const after = Date.now();
    const ps = b.getPartials();
    expect(ps[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(ps[0].timestamp).toBeLessThanOrEqual(after);
  });
});

// ============================================================
// spend / exhausted / remaining
// ============================================================
describe("BudgetTracker — 时间预算边界", () => {
  it("spend 正数累加", () => {
    const b = new BudgetTracker(1000);
    b.spend(200);
    b.spend(300);
    expect(b.used()).toBe(500);
    expect(b.remaining()).toBe(500);
    expect(b.exhausted()).toBe(false);
  });

  it("spend(0) 忽略（防御）", () => {
    const b = new BudgetTracker(1000);
    b.spend(0);
    expect(b.used()).toBe(0);
  });

  it("spend(负数) 忽略（防御，不应发生）", () => {
    const b = new BudgetTracker(1000);
    b.spend(-100);
    expect(b.used()).toBe(0);
  });

  it("spend 到 cap → exhausted=true（边界：等于也算超）", () => {
    const b = new BudgetTracker(1000);
    b.spend(1000);
    expect(b.exhausted()).toBe(true);
    expect(b.remaining()).toBe(0);
  });

  it("spend 超 cap → exhausted=true + remaining=0（不为负）", () => {
    const b = new BudgetTracker(1000);
    b.spend(1500);
    expect(b.exhausted()).toBe(true);
    expect(b.remaining()).toBe(0); // Math.max(0, ...)
    expect(b.used()).toBe(1500); // 真实花费保留
  });
});

// ============================================================
// recordPartial / getPartials / partialCount
// ============================================================
describe("BudgetTracker — partial_failures 聚合", () => {
  it("recordPartial 单条 → getPartials 返回 1 条", () => {
    const b = new BudgetTracker();
    b.recordPartial({ channel: "browse_headless", error: "timeout" });
    expect(b.partialCount()).toBe(1);
    const ps = b.getPartials();
    expect(ps[0].channel).toBe("browse_headless");
    expect(ps[0].error).toBe("timeout");
    expect(typeof ps[0].timestamp).toBe("number");
  });

  it("recordPartial 多条按序累加", () => {
    const b = new BudgetTracker();
    b.recordPartial({ channel: "a", error: "e1" });
    b.recordPartial({ channel: "b", error: "e2" });
    b.recordPartial({ channel: "c", error: "e3" });
    expect(b.partialCount()).toBe(3);
    expect(b.getPartials().map((p) => p.channel)).toEqual(["a", "b", "c"]);
  });

  it("now 注入：timestamp 来自注入源（确定性）", () => {
    let t = 1000;
    const b = new BudgetTracker(60_000, () => (t += 100));
    b.recordPartial({ channel: "x", error: "e1" });
    b.recordPartial({ channel: "y", error: "e2" });
    const ps = b.getPartials();
    expect(ps[0].timestamp).toBe(1100);
    expect(ps[1].timestamp).toBe(1200);
  });

  it("getPartials 返回新数组：外部 push 不影响内部 partialCount", () => {
    const b = new BudgetTracker();
    b.recordPartial({ channel: "x", error: "e1" });
    const ps = b.getPartials();
    ps.push({ channel: "tampered", error: "x", timestamp: 0 });
    // 内部不应被影响（push 新元素不进 internal）
    expect(b.partialCount()).toBe(1);
    expect(b.getPartials()).toHaveLength(1);
    expect(b.getPartials()[0].channel).toBe("x");
  });
});

// ============================================================
// flushInto
// ============================================================
describe("BudgetTracker — flushInto 透传", () => {
  it("无 partials → 原样返回（同引用）", () => {
    const b = new BudgetTracker();
    const r = makeResult();
    const flushed = b.flushInto(r);
    expect(flushed).toBe(r); // 同引用
    expect(flushed.partial_failures).toBeUndefined();
  });

  it("有 partials → flushInto 返回新对象（不修改原 result）", () => {
    const b = new BudgetTracker(60_000, () => 12345);
    b.recordPartial({ channel: "browse_headless", error: "timeout" });
    const r = makeResult();
    const flushed = b.flushInto(r);
    expect(flushed).not.toBe(r);
    expect(flushed.partial_failures).toEqual([
      { channel: "browse_headless", error: "timeout", timestamp: 12345 },
    ]);
    // 原 r 不变
    expect(r.partial_failures).toBeUndefined();
  });

  it("合并既有 partial_failures（不覆盖）", () => {
    const b = new BudgetTracker(60_000, () => 999);
    b.recordPartial({ channel: "new", error: "new_err" });
    const r = makeResult({
      partial_failures: [
        { channel: "existing", error: "old_err", timestamp: 1 },
      ],
    });
    const flushed = b.flushInto(r);
    expect(flushed.partial_failures).toEqual([
      { channel: "existing", error: "old_err", timestamp: 1 },
      { channel: "new", error: "new_err", timestamp: 999 },
    ]);
  });

  it("多次调 flushInto 幂等（重复添加相同 partials）", () => {
    const b = new BudgetTracker(60_000, () => 100);
    b.recordPartial({ channel: "x", error: "e1" });
    const r1 = b.flushInto(makeResult());
    const r2 = b.flushInto(makeResult());
    // 两次结果相同（每次都把累积 partials 拼到空 result 上）
    expect(r1.partial_failures).toEqual([
      { channel: "x", error: "e1", timestamp: 100 },
    ]);
    expect(r2.partial_failures).toEqual([
      { channel: "x", error: "e1", timestamp: 100 },
    ]);
  });

  it("泛型 <T> 兼容：data 字段保留原 result 类型", () => {
    interface MyData {
      foo: string;
    }
    const b = new BudgetTracker();
    b.recordPartial({ channel: "x", error: "e1" });
    const r: InteractResult<MyData> = {
      outcome: "worked",
      data: { foo: "bar" },
      served_by: "test",
      fallback_used: false,
      retrieval_method: "test",
    };
    const flushed = b.flushInto(r);
    expect(flushed.data).toEqual({ foo: "bar" });
    expect(flushed.partial_failures).toHaveLength(1);
  });
});

// ============================================================
// 综合场景
// ============================================================
describe("BudgetTracker — chain 生命周期综合", () => {
  it("模拟 3 步 chain：每步 spend + 1 步失败 → flush 透传 1 partial", () => {
    const b = new BudgetTracker(10_000, () => 5_000);
    b.spend(1500); // step 1 OK
    b.spend(2000); // step 2 OK
    b.recordPartial({ channel: "browse_headless", error: "timeout" });
    b.spend(1000); // step 3 fail
    expect(b.used()).toBe(4500);
    expect(b.remaining()).toBe(5500);
    expect(b.exhausted()).toBe(false);
    expect(b.partialCount()).toBe(1);

    const result = b.flushInto(
      makeResult({
        outcome: "didnt",
        error: "step_error",
      }),
    );
    expect(result.outcome).toBe("didnt");
    expect(result.partial_failures).toEqual([
      { channel: "browse_headless", error: "timeout", timestamp: 5000 },
    ]);
  });

  it("模拟超预算：spend > cap → exhausted=true（chain 应中止）", () => {
    const b = new BudgetTracker(100);
    b.spend(50);
    expect(b.exhausted()).toBe(false);
    b.spend(60); // total=110 > 100
    expect(b.exhausted()).toBe(true);
    expect(b.remaining()).toBe(0);
  });
});
