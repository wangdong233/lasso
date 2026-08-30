/**
 * util/http-pool 单测（review-r1：连接池自 SubprocessManager 迁出后的行为锁定）
 *
 * 锁定三点（均为迁移前既有行为，防迁移回归）：
 *  1. 返回形状：{ fetch } 可调用（INV-32 消费契约——fetch_url 经 httpClient.fetch）
 *  2. 同 origin 复用同一 Agent：重复 acquire 不新建池（http_pool_created 只打一次）
 *  3. closeAllHttpAgents 后清池：再 acquire 会新建（生命周期闭环；幂等）
 *
 * 策略：logger spy 数 http_pool_created 次数（Agent 复用不可从返回值观察——
 * 返回的 { fetch } 包装器每次都是新闭包，这是设计（BraveChannel 注入 mock 同构））。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/util/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { acquireHttpClient, closeAllHttpAgents } from "../../src/util/http-pool.js";
import { logger } from "../../src/util/logger.js";

describe("util/http-pool — 连接池单一真源（review-r1 迁移）", () => {
  it("返回 { fetch } 可调用（INV-32 消费契约）", () => {
    const c = acquireHttpClient("https://pool-shape.example.com");
    expect(typeof c.fetch).toBe("function");
  });

  it("同 origin 重复 acquire 复用同一 Agent（http_pool_created 只打一次）", () => {
    const origin = "https://reuse.example.com";
    acquireHttpClient(origin);
    acquireHttpClient(origin);
    acquireHttpClient(origin);
    const created = vi
      .mocked(logger.info)
      .mock.calls.filter(([e]) => e?.evt === "http_pool_created");
    const forOrigin = created.filter(([e]) => e?.origin === origin);
    expect(forOrigin.length).toBe(1);
  });

  it("不同 origin 各建独立 Agent", () => {
    acquireHttpClient("https://a.example.com");
    acquireHttpClient("https://b.example.com");
    const created = vi
      .mocked(logger.info)
      .mock.calls.filter(([e]) => e?.evt === "http_pool_created");
    const origins = new Set(
      created.map(([e]) => e?.origin as string).filter(Boolean),
    );
    expect(origins.has("https://a.example.com")).toBe(true);
    expect(origins.has("https://b.example.com")).toBe(true);
  });

  it("closeAllHttpAgents 清池后再 acquire 新建（生命周期闭环 + 幂等）", async () => {
    const origin = "https://recycle.example.com";
    acquireHttpClient(origin);
    await closeAllHttpAgents();
    await closeAllHttpAgents(); // 幂等：空池再清不抛
    acquireHttpClient(origin);
    const created = vi
      .mocked(logger.info)
      .mock.calls.filter(
        ([e]) => e?.evt === "http_pool_created" && e?.origin === origin,
      );
    expect(created.length).toBe(2);
  });
});
