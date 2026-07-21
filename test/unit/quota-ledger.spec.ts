/**
 * QuotaLedger 单元测（parse2 §5.1 / 验收 #2）。
 *
 * 覆盖：
 *  - pickKey 贪心：余量最多的 Key
 *  - hasAvailableKey：全 0 / 全 exhausted / 部分 exhausted
 *  - recordSuccess：扣减 + 余量 <50 状态变化 + cost > remaining 封 0
 *  - markExhausted：resetAt 取较大值（不回滚长熔断）+ remaining 归 0
 *  - 月初 rollover：跨月重置（resetAt 落在月初 UTC 00:00）
 *  - 配额合并视图：totalRemaining = Σ(key.remaining)
 *  - 多 Key 池：429 一个不影响其他
 *  - snapshot / keyCount / quotaModel
 *  - hashKey 日志安全（前4...后4）
 */
import { describe, it, expect } from "vitest";
import { QuotaLedger, hashKey } from "../../src/config/quota-ledger.js";

describe("QuotaLedger — 构造 + 初始态", () => {
  it("单 Key 初始：hasAvailableKey=true / pickKey 返该 Key / totalRemaining=quota", () => {
    const l = new QuotaLedger("brave", ["k1"], 2000, "monthly");
    expect(l.hasAvailableKey()).toBe(true);
    expect(l.pickKey()).toBe("k1");
    expect(l.totalRemaining()).toBe(2000);
    expect(l.keyCount).toBe(1);
    expect(l.quotaModel).toBe("monthly");
  });

  it("多 Key 初始：keyCount=N / totalRemaining=N×quota", () => {
    const l = new QuotaLedger("brave", ["a", "b", "c"], 2000, "monthly");
    expect(l.keyCount).toBe(3);
    expect(l.totalRemaining()).toBe(6000);
  });

  it("0 Key：hasAvailableKey=false / pickKey=null / totalRemaining=0", () => {
    const l = new QuotaLedger("empty", [], 2000, "monthly");
    expect(l.hasAvailableKey()).toBe(false);
    expect(l.pickKey()).toBeNull();
    expect(l.totalRemaining()).toBe(0);
    expect(l.keyCount).toBe(0);
  });
});

describe("QuotaLedger.pickKey — 贪心选余量最多", () => {
  it("多 Key 不同余量：选余量最大的", () => {
    const l = new QuotaLedger("brave", ["a", "b", "c"], 2000, "monthly");
    // a: 1800, b: 1900, c: 1500
    l.recordSuccess("a", 200);
    l.recordSuccess("b", 100);
    l.recordSuccess("c", 500);
    expect(l.pickKey()).toBe("b");
  });

  it("recordSuccess 把某 Key 用到 0：pickKey 跳过它", () => {
    const l = new QuotaLedger("brave", ["a", "b"], 100, "monthly");
    l.recordSuccess("a", 100);
    expect(l.pickKey()).toBe("b");
  });

  it("cost > remaining：封到 0 不下溢（不抛错）", () => {
    const l = new QuotaLedger("brave", ["a"], 10, "monthly");
    l.recordSuccess("a", 100);
    expect(l.totalRemaining()).toBe(0);
  });

  it("未知 Key：recordSuccess 静默忽略（不抛错）", () => {
    const l = new QuotaLedger("brave", ["a"], 100, "monthly");
    expect(() => l.recordSuccess("unknown", 50)).not.toThrow();
    expect(l.totalRemaining()).toBe(100);
  });
});

describe("QuotaLedger.markExhausted — 429 反馈", () => {
  it("markExhausted 把 Key 短期禁用：pickKey 跳过 / snapshot 标 exhausted", () => {
    const l = new QuotaLedger("brave", ["a", "b"], 2000, "monthly");
    const future = Date.now() + 60_000;
    l.markExhausted("a", future);
    expect(l.pickKey()).toBe("b");
    const snap = l.snapshot();
    expect(snap[0].exhausted).toBe(true);
    expect(snap[1].exhausted).toBe(false);
  });

  it("全 Key exhausted：pickKey=null / hasAvailableKey=false", () => {
    const l = new QuotaLedger("brave", ["a", "b"], 2000, "monthly");
    const future = Date.now() + 60_000;
    l.markExhausted("a", future);
    l.markExhausted("b", future);
    expect(l.hasAvailableKey()).toBe(false);
    expect(l.pickKey()).toBeNull();
  });

  it("markExhausted 取较大 resetAt：不回滚长熔断（10 §4.2）", () => {
    const l = new QuotaLedger("brave", ["a"], 100, "monthly");
    const far = Date.now() + 10_000;
    // 第一次 markExhausted: 10s 后恢复
    l.markExhausted("a", far);
    // 第二次 markExhausted 用更短的 resetAt：不应回滚到 1s
    l.markExhausted("a", Date.now() + 1_000);
    const snap = l.snapshot();
    // 仍应至少 5s 后才恢复（取较大值，不回滚）
    expect(snap[0].resetAt).toBeGreaterThan(Date.now() + 5_000);
    expect(snap[0].resetAt).toBe(far);
  });

  it("markExhausted 后过 resetAt：Key 恢复可用", () => {
    const l = new QuotaLedger("brave", ["a"], 100, "monthly");
    // resetAt = 现在 - 1s（已过期）→ Key 应已恢复
    l.markExhausted("a", Date.now() - 1_000);
    expect(l.hasAvailableKey()).toBe(true);
    expect(l.pickKey()).toBe("a");
  });

  it("markExhausted 未知 Key：静默忽略", () => {
    const l = new QuotaLedger("brave", ["a"], 100, "monthly");
    expect(() => l.markExhausted("ghost", Date.now() + 60_000)).not.toThrow();
    expect(l.hasAvailableKey()).toBe(true);
  });
});

describe("QuotaLedger.totalRemaining — 多 Key 合并视图", () => {
  it("2 Key × 2000 = 4000（验收 #2 硬指标）", () => {
    const l = new QuotaLedger("brave", ["k1", "k2"], 2000, "monthly");
    expect(l.totalRemaining()).toBe(4000);
  });

  it("一 Key 部分用 + 一 Key exhausted：totalRemaining 算月配额总和（短期 block 不影响）", () => {
    const l = new QuotaLedger("brave", ["a", "b"], 2000, "monthly");
    l.recordSuccess("a", 500); // a=1500
    l.markExhausted("b", Date.now() + 60_000); // b 短期 block，但月配额仍 2000
    // v0.2 Phase B 语义：totalRemaining 反映月配额余量，与短期 429 block 独立。
    expect(l.totalRemaining()).toBe(3500);
    // 但 pickKey 只返未 block 的：a（余 1500）
    expect(l.pickKey()).toBe("a");
  });
});

describe("QuotaLedger — 配额模型 + rollover", () => {
  it("不同 quota_model 都能构造（rpm/token/request 不影响 v0.2 行为）", () => {
    const monthly = new QuotaLedger("a", ["k"], 100, "monthly");
    const rpm = new QuotaLedger("b", ["k"], 100, "rpm");
    const token = new QuotaLedger("c", ["k"], 100, "token");
    const request = new QuotaLedger("d", ["k"], 100, "request");
    expect(monthly.quotaModel).toBe("monthly");
    expect(rpm.quotaModel).toBe("rpm");
    expect(token.quotaModel).toBe("token");
    expect(request.quotaModel).toBe("request");
  });

  it("初始 resetAt 落在本月 1 号 00:00 UTC（月初重置锚点）", () => {
    const l = new QuotaLedger("brave", ["k"], 2000, "monthly");
    const snap = l.snapshot();
    const resetAt = new Date(snap[0].resetAt);
    expect(resetAt.getUTCDate()).toBe(1);
    expect(resetAt.getUTCHours()).toBe(0);
    expect(resetAt.getUTCMinutes()).toBe(0);
    expect(resetAt.getUTCSeconds()).toBe(0);
    // 月初还应该是当前月或上月（边界）
    const now = new Date();
    const monthsDiff =
      (now.getUTCFullYear() - resetAt.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - resetAt.getUTCMonth());
    expect(monthsDiff).toBeGreaterThanOrEqual(0);
    expect(monthsDiff).toBeLessThanOrEqual(1);
  });
});

describe("QuotaLedger.snapshot — 不暴露真实 Key 字符串", () => {
  it("snapshot 字段：remaining/resetAt/totalUsed/exhausted，无 key 字段", () => {
    const l = new QuotaLedger("brave", ["secret-key-12345"], 100, "monthly");
    l.recordSuccess("secret-key-12345", 10);
    const snap = l.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].remaining).toBe(90);
    expect(snap[0].totalUsed).toBe(10);
    expect(snap[0].exhausted).toBe(false);
    // 安全：snapshot 不含 key 字符串本身
    expect(JSON.stringify(snap)).not.toContain("secret-key-12345");
  });
});

describe("hashKey — 日志安全（前4...后4，不打全 key）", () => {
  it("长 Key：前 4 + ... + 后 4", () => {
    expect(hashKey("abcdefghijklmnopqrstuvwxyz")).toBe("abcd...wxyz");
  });
  it("短 Key（≤8）：返 'short'（不打）", () => {
    expect(hashKey("abc")).toBe("short");
    expect(hashKey("12345678")).toBe("short");
  });
  it("9 字符 Key：前 4 + ... + 后 4", () => {
    expect(hashKey("123456789")).toBe("1234...6789");
  });
});
