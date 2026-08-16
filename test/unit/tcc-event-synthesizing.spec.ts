/**
 * tcc-event-synthesizing.spec.ts（v1.11 round1 T11 —— TCC 第三维）
 *
 * 验收（round1-verdict T11）：
 *  1. cfg-gate 编译通过（15+ 路径 dlsym 运行时解析 + <15 not_required 路径）——
 *     rust 单测已覆盖（tcc::tests）；本 spec 验 TS 侧
 *  2. doctor 检查项渲染（granted/not_required/denied 三态）
 *  3. 错误映射单测：cgevent 返 tcc_event_synthesis_denied → CGEventProvider
 *     outcome=didnt + 引导文案
 */
import { describe, it, expect } from "vitest";
import { runRustDoctorChecks } from "../../src/desktop/desktop-doctor-checks.js";
import { CGEventProvider } from "../../src/desktop/CGEventProvider.js";
import { MockRustBridge } from "./mocks/mock-rust-bridge.js";

// ============================================================
// helpers
// ============================================================
function rustWithTcc(tcc: Record<string, unknown>): MockRustBridge {
  return new MockRustBridge({
    tcc_status: () => tcc,
  });
}

// ============================================================
// 1. doctor #21 三态渲染
// ============================================================
describe("T11 — doctor #21 tcc_event_synthesizing 三态", () => {
  it("granted → pass", async () => {
    const checks = await runRustDoctorChecks(
      rustWithTcc({
        accessibility: true,
        screen_recording: true,
        event_synthesizing: "granted",
      }) as never,
    );
    const c = checks.find((x) => x.name === "tcc_event_synthesizing");
    expect(c).toBeTruthy();
    expect(c!.status).toBe("pass");
    expect(c!.detail).toContain("已授权");
  });

  it("not_required（macOS < 15）→ pass（无需配置）", async () => {
    const checks = await runRustDoctorChecks(
      rustWithTcc({ event_synthesizing: "not_required" }) as never,
    );
    const c = checks.find((x) => x.name === "tcc_event_synthesizing");
    expect(c!.status).toBe("pass");
    expect(c!.detail).toContain("not_required");
  });

  it("denied → warn + 引导文案（System Settings 路径）", async () => {
    const checks = await runRustDoctorChecks(
      rustWithTcc({ event_synthesizing: "denied" }) as never,
    );
    const c = checks.find((x) => x.name === "tcc_event_synthesizing");
    expect(c!.status).toBe("warn"); // warn 非 fail：仅档3 act 键盘/鼠标路径依赖
    expect(c!.next_step).toContain("Event Synthesizing");
  });

  it("字段缺失（旧 helper wire）→ pass（前向兼容）", async () => {
    const checks = await runRustDoctorChecks(
      rustWithTcc({}) as never,
    );
    const c = checks.find((x) => x.name === "tcc_event_synthesizing");
    expect(c!.status).toBe("pass");
  });

  it("7 项 desktop check 顺序固定（#15-#21）", async () => {
    const checks = await runRustDoctorChecks(
      rustWithTcc({}) as never,
    );
    expect(checks.map((c) => c.name)).toEqual([
      "rust_helper_signed",
      "rust_helper_running",
      "tcc_accessibility",
      "tcc_screen_recording",
      "ax_read_rate",
      "vlm_endpoint_reachable",
      "tcc_event_synthesizing",
    ]);
  });
});

// ============================================================
// 2. CGEventProvider 错误映射
// ============================================================
describe("T11 — tcc_event_synthesis_denied → outcome=didnt", () => {
  it("rust 返该 error_kind → didnt + 引导文案（不 unknown 不 fallback）", async () => {
    const rust = new MockRustBridge({
      cgevent_dispatch: () => {
        throw new Error("__kind__tcc_event_synthesis_denied");
      },
    });
    // MockRustBridge throw → error_kind=script_error；用直构 resp 测真实映射：
    // 经 mock 桥无法注入自定义 error_kind，直接构造 rust-like 对象
    const fakeRust = {
      call: async () => ({
        id: "t",
        ok: false,
        error: "macOS 15+ Event Synthesizing permission denied",
        error_kind: "tcc_event_synthesis_denied",
      }),
    };
    void rust;
    const provider = new CGEventProvider(fakeRust as never);
    const r = await provider.act({
      actions: [{ kind: "press", key: "Return" }],
    });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("tcc_event_synthesis_denied");
    expect(r.error).toContain("System Settings");
    expect(r.error).toContain("Event Synthesizing");
  });

  it("其他 error_kind 仍 unknown（链继续——行为不回归）", async () => {
    const fakeRust = {
      call: async () => ({
        id: "t",
        ok: false,
        error: "boom",
        error_kind: "cgevent_source_failed",
      }),
    };
    const provider = new CGEventProvider(fakeRust as never);
    const r = await provider.act({
      actions: [{ kind: "press", key: "Return" }],
    });
    expect(r.outcome).toBe("unknown");
  });
});
