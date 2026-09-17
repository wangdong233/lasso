/**
 * cgevent-delivery-selftest.spec.ts（bugs/10 决议 A.3 —— doctor #22）
 *
 * 验收：
 *  1. 伦理门：无 env 时 warn skip 且**零 cgevent_dispatch 调用**
 *     （INV-102 行为面——agent 经 desktop(action:"doctor") 也不得触发光标位移）
 *  2. env=1 happy path：读 → wiggle(+7 bounds 内) → 落点判读 → 复位 move →
 *     复读确认 → pass（detail 注明 moved your cursor 7px and restored）
 *  3. 分层定位：读失败 = helper 层 fail / wiggle 未落地 = 投递层 fail（复位仍在场）
 *  4. 光标不在主屏 → 诚实 skip（不硬移）
 *  5. wiggleTarget 纯函数：bounds 内 / 越界取反 / 屏外 null
 */
import { describe, it, expect, afterEach } from "vitest";
import { runRustDoctorChecks, wiggleTarget } from "../../src/desktop/desktop-doctor-checks.js";
import { MockRustBridge } from "./mocks/mock-rust-bridge.js";

// env 泄漏防护：每条用例后清掉 opt-in（防串测）
afterEach(() => {
  delete process.env.LASSO_DOCTOR_INPUT_SELFTEST;
});

function find22(checks: Awaited<ReturnType<typeof runRustDoctorChecks>>) {
  return checks.find((c) => c.name === "cgevent_delivery_selftest");
}

// ============================================================
// 1. 伦理门（默认 skip + 零 dispatch）
// ============================================================
describe("bugs/10 A.3 — #22 伦理门", () => {
  it("无 env → warn skip + next_step 教开启法", async () => {
    delete process.env.LASSO_DOCTOR_INPUT_SELFTEST;
    const rust = new MockRustBridge({});
    const c = find22(await runRustDoctorChecks(rust as never));
    expect(c!.status).toBe("warn");
    expect(c!.detail).toContain("opt-in");
    expect(c!.next_step).toContain("LASSO_DOCTOR_INPUT_SELFTEST=1");
  });

  it("无 env → 零 cgevent_dispatch 调用（INV-102：agent 不可触发光标位移）", async () => {
    delete process.env.LASSO_DOCTOR_INPUT_SELFTEST;
    const rust = new MockRustBridge({
      cgevent_cursor_state: () => ({ x: 100, y: 200, display: { w: 1440, h: 900 } }),
      cgevent_dispatch: () => ({ results: [{ index: 0, ok: true, landed: true }] }),
    });
    await runRustDoctorChecks(rust as never);
    expect(
      rust.calls.filter((c) => c.method === "cgevent_dispatch"),
    ).toHaveLength(0);
    // 连读都不发生（门在一切副作用之前）
    expect(
      rust.calls.filter((c) => c.method === "cgevent_cursor_state"),
    ).toHaveLength(0);
  });

  it("env=0（显式关）→ 同 skip", async () => {
    process.env.LASSO_DOCTOR_INPUT_SELFTEST = "0";
    const rust = new MockRustBridge({});
    const c = find22(await runRustDoctorChecks(rust as never));
    expect(c!.status).toBe("warn");
  });
});

// ============================================================
// 2. env=1 happy path（wiggle + 复位）
// ============================================================
describe("bugs/10 A.3 — #22 happy path（env=1）", () => {
  it("读 → wiggle(+7) → landed → 复位回原坐标 → 复读确认 → pass", async () => {
    process.env.LASSO_DOCTOR_INPUT_SELFTEST = "1";
    let cursor = { x: 100, y: 200 };
    const rust = new MockRustBridge({
      cgevent_cursor_state: () => ({
        ...cursor,
        seconds_since_mouse_moved: 1.0,
        display: { w: 1440, h: 900 },
      }),
      cgevent_dispatch: (params) => {
        const a = (params as { actions: Array<{ kind: string; x: number; y: number }> })
          .actions[0];
        cursor = { x: a.x, y: a.y }; // 模拟真实投递：光标真动了
        return {
          results: [{ index: 0, ok: true, kind: a.kind, cursor_after: { x: a.x, y: a.y }, landed: true }],
          physical_input: { attribution: "synthetic", seconds_since_mouse_moved: 0.01 },
        };
      },
    });
    const c = find22(await runRustDoctorChecks(rust as never));
    expect(c!.status).toBe("pass");
    expect(c!.detail).toContain("moved your cursor 7px and restored");

    // wire 断言：wiggle move 到 (107,200)，复位 move 回 (100,200)
    const dispatches = rust.calls.filter((c) => c.method === "cgevent_dispatch");
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0].params).toEqual({
      actions: [{ kind: "move", x: 107, y: 200 }],
    });
    expect(dispatches[1].params).toEqual({
      actions: [{ kind: "move", x: 100, y: 200 }],
    });
  });
});

// ============================================================
// 3. 分层定位
// ============================================================
describe("bugs/10 A.3 — #22 分层定位", () => {
  it("读失败（helper 层）→ fail + 定位 helper 层", async () => {
    process.env.LASSO_DOCTOR_INPUT_SELFTEST = "1";
    const rust = new MockRustBridge({
      cgevent_cursor_state: () => {
        throw new Error("not_macos");
      },
    });
    const c = find22(await runRustDoctorChecks(rust as never));
    expect(c!.status).toBe("fail");
    expect(c!.detail).toContain("helper 层");
    // 读失败时零 dispatch（没有基线就不该动光标）
    expect(rust.calls.filter((x) => x.method === "cgevent_dispatch")).toHaveLength(0);
  });

  it("wiggle 未落地（投递层）→ fail + 复位 move 仍在场（义务不是奖励）", async () => {
    process.env.LASSO_DOCTOR_INPUT_SELFTEST = "1";
    let cursor = { x: 100, y: 200 };
    const rust = new MockRustBridge({
      cgevent_cursor_state: () => ({
        ...cursor,
        display: { w: 1440, h: 900 },
      }),
      cgevent_dispatch: (params) => {
        const a = (params as { actions: Array<{ kind: string; x: number; y: number }> })
          .actions[0];
        // 模拟投递断裂：光标纹丝不动（报告 P0 形态——landed:false）
        return {
          results: [
            { index: 0, ok: false, error_kind: "cgevent_no_landing", cursor_after: { x: cursor.x, y: cursor.y } },
          ],
        };
      },
    });
    const c = find22(await runRustDoctorChecks(rust as never));
    expect(c!.status).toBe("fail");
    expect(c!.detail).toContain("投递层");
    // 复位 move 仍发生（即使 wiggle 失败）
    const dispatches = rust.calls.filter((x) => x.method === "cgevent_dispatch");
    expect(dispatches).toHaveLength(2);
    expect((dispatches[1].params as { actions: Array<{ x: number; y: number }> }).actions[0]).toEqual({ kind: "move", x: 100, y: 200 });
  });

  it("wiggle OK 但复位复读不匹配 → fail（如实报 displaced）", async () => {
    process.env.LASSO_DOCTOR_INPUT_SELFTEST = "1";
    let readCount = 0;
    const rust = new MockRustBridge({
      cgevent_cursor_state: () => {
        readCount++;
        // 第 2 次读（复位确认）谎报光标在别处——模拟并发物理输入接管
        if (readCount >= 2) return { x: 999, y: 999, display: { w: 1440, h: 900 } };
        return { x: 100, y: 200, display: { w: 1440, h: 900 } };
      },
      cgevent_dispatch: () => ({
        results: [{ index: 0, ok: true, landed: true }],
      }),
    });
    const c = find22(await runRustDoctorChecks(rust as never));
    expect(c!.status).toBe("fail");
    expect(c!.detail).toContain("复位确认失败");
  });
});

// ============================================================
// 4. 光标不在主屏
// ============================================================
describe("bugs/10 A.3 — #22 屏外诚实 skip", () => {
  it("光标在主屏外（如负坐标/第二屏）→ warn skip，零 dispatch", async () => {
    process.env.LASSO_DOCTOR_INPUT_SELFTEST = "1";
    const rust = new MockRustBridge({
      cgevent_cursor_state: () => ({
        x: -1200,
        y: 300,
        display: { w: 1440, h: 900 },
      }),
      cgevent_dispatch: () => ({ results: [{ index: 0, ok: true, landed: true }] }),
    });
    const c = find22(await runRustDoctorChecks(rust as never));
    expect(c!.status).toBe("warn");
    expect(c!.detail).toContain("不在主屏");
    expect(rust.calls.filter((x) => x.method === "cgevent_dispatch")).toHaveLength(0);
  });
});

// ============================================================
// 5. wiggleTarget 纯函数（决议 A.3 三分支）
// ============================================================
describe("bugs/10 A.3 — wiggleTarget 纯函数", () => {
  it("bounds 内 → +7", () => {
    expect(wiggleTarget(100, 200, 1440, 900)).toEqual({ x: 107, y: 200 });
  });

  it("右缘越界 → 取 -(7,0)", () => {
    expect(wiggleTarget(1439, 200, 1440, 900)).toEqual({ x: 1432, y: 200 });
    expect(wiggleTarget(1438, 200, 1440, 900)).toEqual({ x: 1431, y: 200 });
  });

  it("屏外（负坐标 / 超界）→ null（诚实 skip 信号）", () => {
    expect(wiggleTarget(-1200, 300, 1440, 900)).toBeNull();
    expect(wiggleTarget(2000, 300, 1440, 900)).toBeNull();
    expect(wiggleTarget(100, -50, 1440, 900)).toBeNull();
    expect(wiggleTarget(100, 999, 1440, 900)).toBeNull();
  });

  it("夹取边界：结果恒在 [0, w-1]×[0, h-1] 内", () => {
    for (const [x, y] of [[0, 0], [7, 0], [1435, 899], [1439, 899], [720, 450]] as const) {
      const t = wiggleTarget(x, y, 1440, 900);
      expect(t).not.toBeNull();
      expect(t!.x).toBeGreaterThanOrEqual(0);
      expect(t!.x).toBeLessThan(1440);
      expect(t!.y).toBeGreaterThanOrEqual(0);
      expect(t!.y).toBeLessThan(900);
    }
  });
});
