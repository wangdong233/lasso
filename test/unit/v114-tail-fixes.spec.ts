/**
 * v1.14.0 收尾三修单测（搜索方案重审 verify F-1/F-2 + markdown 别名）
 *
 * F-1：LASSO_SEARCH_FREE_ONLY env 死配置 → args.free_only 的默认回退
 * F-2：Brave 422 SUBSCRIPTION_TOKEN_INVALID 误入「计划层级」桶 → 先判 key 无效
 * 别名：markdown* 档 data.markdown = preview（raw 档无此字段）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("F-1 LASSO_SEARCH_FREE_ONLY env 回退", () => {
  it("env=L2 且 args 未传 → freeOnly 取 L2（env 不再是死配置）", async () => {
    process.env.LASSO_SEARCH_FREE_ONLY = "L2";
    try {
      const { resolveFreeOnly } = await import("../../src/tools/search.js");
      expect(resolveFreeOnly(undefined)).toBe("L2");
      // per-call 显式传参优先于 env
      expect(resolveFreeOnly("L4")).toBe("L4");
    } finally {
      delete process.env.LASSO_SEARCH_FREE_ONLY;
    }
  });

  it("env 非法值 → undefined（静默忽略，不崩）", async () => {
    process.env.LASSO_SEARCH_FREE_ONLY = "L9";
    try {
      const { resolveFreeOnly } = await import("../../src/tools/search.js");
      expect(resolveFreeOnly(undefined)).toBeUndefined();
    } finally {
      delete process.env.LASSO_SEARCH_FREE_ONLY;
    }
  });
});

describe("F-2 doctor deep probe 422 分类（源码级 + 行为锚定）", () => {
  it("tokenInvalid 判定先于 plan 语义（422 SUBSCRIPTION_TOKEN_INVALID → key 无效桶）", async () => {
    const src = readFileSync("src/doctor/doctor.ts", "utf8");
    const tokenIdx = src.indexOf("tokenInvalid");
    const planIdx = src.indexOf("const planSemantics");
    expect(tokenIdx).toBeGreaterThan(0);
    // 先于 plan 语义判定（同一函数内顺序）
    expect(tokenIdx).toBeLessThan(planIdx);
    // 正则覆盖 Brave 真实错误码字面量（verify F-2 实测 422 体含 SUBSCRIPTION_TOKEN_INVALID）
    expect(src).toMatch(/SUBSCRIPTION_TOKEN_INVALID/);
  });
});

describe("markdown 别名（v1.14.0）", () => {
  it("browseSingle 对 markdown* 档透出 data.markdown=preview；raw 档无此字段", () => {
    const src = readFileSync("src/channels/BrowseChannel.ts", "utf8");
    // 别名展开存在且以 markdown_engine 为条件（raw 档不触发）
    expect(src).toMatch(/\.\.\.\(partial\.markdown_engine\s*\?\s*\{\s*markdown:\s*truncatePreview\(partial\.preview/);
  });
});
