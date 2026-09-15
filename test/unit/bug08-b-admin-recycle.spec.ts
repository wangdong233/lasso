/**
 * bug08-b-admin-recycle.spec.ts（BUG-08 决议 B-1，doc/bugs/08，2026-09-15）
 *
 * admin browser_recycle action 形状：
 *  - 正常路径：{channel:'headless', reason} → deps.browserRecycle 被调 +
 *    ok:true + {restarted, spec, pid} 透传 + audit 字段
 *  - freshProfile 透传（一个正门两个深度，决议 C 组合）
 *  - 未注入 → configured:false（零回归形态，同 chrome_status 惯例）
 *  - 未知/缺失 channel 拒（schema enum 外的值被 zod 拒；enum 内仅 headless——
 *    handler 侧 future-proof 显式拒）
 *  - mutation 纪律：缺 reason → fail
 *
 * admin tool 全 DI 注入（bug04-chrome-status.spec 8/8b 同范式）。
 */
import { describe, it, expect } from "vitest";

async function makeHandler(recycle?: (opts: { freshProfile?: boolean }) => Promise<{ restarted: boolean; spec: string; pid: number | null; freshProfile?: boolean; note?: string }>) {
  const { registerAdminTool } = await import("../../src/tools/admin.js");
  let handler: ((a: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) | undefined;
  registerAdminTool({
    bag: {} as never,
    toolManager: {
      register: (_n: string, def: { handler: (a: unknown) => Promise<unknown> }) => {
        handler = def.handler as never;
      },
    } as never,
    callerTier: {} as never,
    registry: {} as never,
    ...(recycle ? { browserRecycle: recycle } : {}),
  });
  return handler!;
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe("BUG-08 B-1 — admin browser_recycle action 形状", () => {
  it("正常路径：channel+reason → browserRecycle 被调 + ok + 结果透传", async () => {
    let calledWith: { freshProfile?: boolean } | null = null;
    const h = await makeHandler(async (opts) => {
      calledWith = opts;
      return { restarted: true, spec: "headless", pid: 4242 };
    });
    const r = parse(await h({ action: "browser_recycle", channel: "headless", reason: "marathon wedged stack" }));
    expect(r.ok).toBe(true);
    expect(r.action).toBe("browser_recycle");
    expect(r.restarted).toBe(true);
    expect(r.spec).toBe("headless");
    expect(r.pid).toBe(4242);
    expect(r.fresh_profile).toBe(false);
    expect(calledWith).toEqual({ freshProfile: false });
    expect(String(r.note)).toContain("never touched");
  });

  it("freshProfile:true 透传（换脸深度，决议 C 组合）", async () => {
    let calledWith: { freshProfile?: boolean } | null = null;
    const h = await makeHandler(async (opts) => {
      calledWith = opts;
      return { restarted: true, spec: "headless", pid: 4243, freshProfile: true };
    });
    const r = parse(await h({ action: "browser_recycle", channel: "headless", reason: "fingerprint blacklisted", freshProfile: true }));
    expect(r.ok).toBe(true);
    expect(r.fresh_profile).toBe(true);
    expect(r.freshProfile).toBe(true);
    expect(calledWith).toEqual({ freshProfile: true });
  });

  it("未注入 → configured:false（零回归形态）", async () => {
    const h = await makeHandler();
    const r = parse(await h({ action: "browser_recycle", channel: "headless", reason: "x" }));
    expect(r.ok).toBe(true);
    expect(r.configured).toBe(false);
  });

  it("缺 channel / 缺 reason → fail（mutation 纪律）", async () => {
    const h = await makeHandler(async () => ({ restarted: true, spec: "headless", pid: 1 }));
    expect(parse(await h({ action: "browser_recycle", reason: "x" })).ok).toBe(false);
    expect(parse(await h({ action: "browser_recycle", channel: "headless" })).ok).toBe(false);
  });

  it("执行体抛错 → ok:false 结构化错误（不抛给 SDK）", async () => {
    const h = await makeHandler(async () => {
      throw new Error("spawn backoff exhausted");
    });
    const r = parse(await h({ action: "browser_recycle", channel: "headless", reason: "x" }));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("spawn backoff exhausted");
  });
});
