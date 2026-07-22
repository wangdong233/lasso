/**
 * desktop-act-4-tier.spec.ts（parse5 §3.5.4 + §6.2 #9 + INV-29）
 *
 * 端到端验证 DesktopChannel.act 的 4 档 fallback 链：
 *   primary:    "desktop.ax"
 *   fallbacks: ["desktop.appleScript", "desktop.cgEvent", "desktop.screenshotVlm"]
 *   cross_modal: false
 *
 * 关键断言：
 *  - 4 档全在 plan 中且顺序锁定（INV-29）
 *  - 全 desktop.* 命名空间，永不跨 surface 进 browse_*（INV-23 + INV-29）
 *  - cross_modal=false（INV-23 守护）
 *  - ax 失败 → 链经 appleScript / cgEvent（4-tier 语义）→ screenshotVlm
 *  - ax worked → 链停在 ax（length=1）
 *  - appleScript worked（user 显式给了 appleScriptAction）→ 链停在 appleScript（length=2）
 *  - cgEvent worked（user 显式给了 press）→ 链停在 cgEvent（length=3）
 *
 * 与 desktop-action-enum.spec.ts 的差异：
 *  - 本 spec 专测 4-tier plan 形状 + 顺序 + 短路；action-enum 测各 action 的具体行为
 *  - 本 spec 是 INV-29 的可执行断言（parse5 §6.2 #9 + #15）
 */
import { describe, it, expect } from "vitest";
import { DesktopChannel } from "../../src/channels/DesktopChannel.js";
import { AxProvider } from "../../src/desktop/AxProvider.js";
import { MacAxBackend } from "../../src/desktop/AxBackend.js";
import { ScreenshotVlmProvider } from "../../src/desktop/ScreenshotVlmProvider.js";
import { AppleScriptProvider } from "../../src/desktop/AppleScriptProvider.js";
import { CGEventProvider } from "../../src/desktop/CGEventProvider.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import { MockRustBridge } from "../unit/mocks/mock-rust-bridge.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ============================================================
// helpers
// ============================================================
type BreakerMap = Map<string, CircuitBreaker>;

function makeBreakers(): BreakerMap {
  const m: BreakerMap = new Map();
  m.set("desktop.ax", new CircuitBreaker());
  m.set("desktop.appleScript", new CircuitBreaker());
  m.set("desktop.cgEvent", new CircuitBreaker());
  m.set("desktop.screenshotVlm", new CircuitBreaker());
  return m;
}

type ScriptMap = Record<string, (p: unknown) => unknown>;

function assemble(scripts: ScriptMap = {}) {
  const rust = new MockRustBridge(scripts);
  // v1.0（parse11 §3.1 + §7.2 Phase A）：AxProvider 经 AxBackend 注入；
  //   测试 mock 走 macOS path（MacAxBackend），scripts 仍按 "ax_*" method 注册。
  const ax = new AxProvider(
    new MacAxBackend(rust as unknown as never),
  );
  const vlm = new ScreenshotVlmProvider(rust as unknown as never, {
    endpoint: null,
    vlmCaller: null,
  });
  const apple = new AppleScriptProvider(rust as unknown as never);
  const cg = new CGEventProvider(rust as unknown as never);
  const breakers = makeBreakers();
  const decider = new FallbackDecider(breakers);
  const desktop = new DesktopChannel(
    rust as unknown as never,
    ax,
    vlm,
    apple,
    cg,
    decider,
    breakers,
  );
  return { desktop, rust, breakers };
}

function defaultPing() {
  return () => ({ pong: true, version: "0.1.0-test", tcc: {} });
}

// ============================================================
// 1. plan 形状（INV-29）
// ============================================================
describe("DesktopChannel.act — 4-tier plan 形状（INV-29）", () => {
  it("源文件 FallbackPlan 是 4 档，顺序锁定 ax → appleScript → cgEvent → screenshotVlm", () => {
    // INV-29 的源端断言（与 check-invariants.mjs 同语义）
    const filePath = fileURLToPath(
      new URL("../../src/channels/DesktopChannel.ts", import.meta.url),
    );
    const text = readFileSync(filePath, "utf8");
    // 去注释后看代码本体
    const codeOnly = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // 顺序锁定断言：primary + fallbacks 数组完整匹配
    const planMatch = codeOnly.match(
      /primary\s*:\s*["'](desktop\.[^"']+)["'][^}]*fallbacks\s*:\s*\[([\s\S]*?)\]/,
    );
    expect(planMatch).not.toBeNull();
    const fallbackNames = [
      ...(planMatch![2].matchAll(/["']([^"']+)["']/g)),
    ].map((m) => m[1]);
    expect(planMatch![1]).toBe("desktop.ax");
    expect(fallbackNames).toEqual([
      "desktop.appleScript",
      "desktop.cgEvent",
      "desktop.screenshotVlm",
    ]);
  });

  it("cross_modal=false（INV-23 守护）", () => {
    const filePath = fileURLToPath(
      new URL("../../src/channels/DesktopChannel.ts", import.meta.url),
    );
    const text = readFileSync(filePath, "utf8");
    expect(text).toMatch(/cross_modal\s*:\s*false/);
  });
});

// ============================================================
// 2. 链路：ax worked → 短路（length=1）
// ============================================================
describe("DesktopChannel.act — 链路 short-circuit", () => {
  it("ax worked → outcome=worked + 链 length=1（停在 ax，不调下游）", async () => {
    const { desktop, rust } = assemble({
      ping: defaultPing(),
      ax_act: () => ({
        actions_and_results: [{ ref: "@e1", ok: true }],
      }),
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e1" }],
    });
    expect(r.outcome).toBe("worked");
    expect(r.fallback_used).toBe(false);
    expect(r.actions_and_results?.length).toBe(1);
    expect(r.actions_and_results?.[0].channel).toBe("desktop.ax");
    // 下游 appleScript/cgEvent/screenshotVlm 全部未调用
    expect(
      rust.calls.filter((c) => c.method === "applescript_run"),
    ).toHaveLength(0);
    expect(
      rust.calls.filter((c) => c.method === "cgevent_dispatch"),
    ).toHaveLength(0);
    expect(
      rust.calls.filter((c) => c.method === "screenshot"),
    ).toHaveLength(0);
  });

  it("user 显式给 appleScriptAction + appleScript worked → 链停在 appleScript（length=2）", async () => {
    const { desktop, rust } = assemble({
      ping: defaultPing(),
      // ax 返 unknown（强制 fallback）
      ax_act: () => {
        throw new Error("ax_not_trusted");
      },
      // appleScript 成功
      applescript_run: () => ({
        action: "finder_new_folder",
        stdout: "",
        stderr: "",
        exit_code: 0,
      }),
    });
    const r = await desktop.act({
      appleScriptAction: "finder_new_folder",
      appleScriptParams: {},
    });
    expect(r.outcome).toBe("worked");
    expect(r.fallback_used).toBe(true);
    expect(r.actions_and_results?.length).toBe(2);
    expect(r.actions_and_results?.[0].channel).toBe("desktop.ax");
    expect(r.actions_and_results?.[1].channel).toBe("desktop.appleScript");
    // 链停了；不进 cgEvent / screenshotVlm
    expect(
      rust.calls.filter((c) => c.method === "cgevent_dispatch"),
    ).toHaveLength(0);
    expect(
      rust.calls.filter((c) => c.method === "screenshot"),
    ).toHaveLength(0);
  });

  it("user 给 press 动作 + cgEvent worked → 链停在 cgEvent（length=3）", async () => {
    const { desktop, rust } = assemble({
      ping: defaultPing(),
      // ax 返 unknown（强制 fallback）
      ax_act: () => {
        throw new Error("ax_fail");
      },
      // cgEvent 成功
      cgevent_dispatch: () => ({
        results: [{ index: 0, ok: true }],
      }),
    });
    const r = await desktop.act({
      actions: [{ kind: "press", key: "Return" }],
    });
    expect(r.outcome).toBe("worked");
    expect(r.fallback_used).toBe(true);
    // ax(unknown) → appleScript(unknown,no action) → cgEvent(worked)
    expect(r.actions_and_results?.length).toBe(3);
    expect(r.actions_and_results?.[0].channel).toBe("desktop.ax");
    expect(r.actions_and_results?.[1].channel).toBe("desktop.appleScript");
    expect(r.actions_and_results?.[2].channel).toBe("desktop.cgEvent");
    expect(
      rust.calls.filter((c) => c.method === "screenshot"),
    ).toHaveLength(0); // 链停了，不进 screenshotVlm
  });
});

// ============================================================
// 3. 全链路（4 档都试）+ INV-23/29 守护
// ============================================================
describe("DesktopChannel.act — 全链路 4 档 + INV-23/29", () => {
  it("ax/cgEvent 失败 + 无 appleScriptAction + VLM 未配 → 4 档全 audit", async () => {
    const { desktop } = assemble({
      ping: defaultPing(),
      ax_act: () => {
        throw new Error("ax_fail");
      },
      // screenshotVlm 拿到 screenshot 但 VLM 未配 → didnt
      screenshot: () => ({
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
        format: "png",
        width: 1,
        height: 1,
      }),
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e1" }],
    });
    // 最终 outcome=didnt（screenshotVlm 返 didnt 短路）
    expect(r.outcome).toBe("didnt");
    expect(r.fallback_used).toBe(true);
    // 4 档全在 audit 链
    expect(r.actions_and_results?.length).toBe(4);
    const channels = r.actions_and_results?.map((a) => a.channel) ?? [];
    expect(channels).toEqual([
      "desktop.ax",
      "desktop.appleScript",
      "desktop.cgEvent",
      "desktop.screenshotVlm",
    ]);
    // INV-23/29：链全 desktop.*
    expect(channels.every((c) => c.startsWith("desktop."))).toBe(true);
    // INV-23/29：永不出现 browse_*
    expect(channels.some((c) => c.startsWith("browse_"))).toBe(false);
  });

  it("链路中无 cross_modal=true（INV-23 守护）", async () => {
    // 间接守护：interact result 字段中无 cross_modal 泄漏为 true
    const { desktop } = assemble({
      ping: defaultPing(),
      ax_act: () => {
        throw new Error("fail");
      },
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e1" }],
    });
    // r.fallback_used 可以是 true（链内 fallback），但 r 字段无 cross_modal
    // cross_modal 字段在 FallbackPlan 内部，不进 InteractResult（INV-23 守护）
    expect(r).not.toHaveProperty("cross_modal");
    expect(r).not.toHaveProperty("crossSurface");
  });
});

// ============================================================
// 4. INV-28 在链路中的体现：raw keycode 让 cgEvent 返 didnt 短路
// ============================================================
describe("DesktopChannel.act — INV-28 raw keycode 在链路中短路", () => {
  it("user 传 raw keycode press → 链 ax 后 cgEvent 拒（didnt 短路，链停）", async () => {
    const { desktop, rust } = assemble({
      ping: defaultPing(),
      ax_act: () => {
        throw new Error("fail");
      },
    });
    const r = await desktop.act({
      actions: [{ kind: "press", key: 36 } as never],
    });
    // ax(unknown) → appleScript(unknown,no action) → cgEvent(didnt, raw keycode 拒) → 短路停
    expect(r.outcome).toBe("didnt");
    expect(r.fallback_used).toBe(true);
    expect(r.actions_and_results?.length).toBe(3);
    expect(r.actions_and_results?.[2].channel).toBe("desktop.cgEvent");
    expect(r.actions_and_results?.[2].outcome).toBe("didnt");
    expect(r.actions_and_results?.[2].error).toMatch(/raw_keycode_forbidden/);
    // screenshotVlm 没被调用（INV-28 短路了）
    expect(
      rust.calls.filter((c) => c.method === "screenshot"),
    ).toHaveLength(0);
  });
});

// ============================================================
// 5. INV-22 在链路中的体现：appleScript 注入尝试 → didnt 短路
// ============================================================
describe("DesktopChannel.act — INV-22/27 appleScript 注入在链路中短路", () => {
  it("user 传不在白名单的 appleScriptAction → 链 ax 后 appleScript 拒（didnt 短路）", async () => {
    const { desktop, rust } = assemble({
      ping: defaultPing(),
      ax_act: () => {
        throw new Error("fail");
      },
    });
    const r = await desktop.act({
      appleScriptAction: "evil_injection_do_shell_script",
      appleScriptParams: {},
    });
    // ax(unknown) → appleScript(didnt, action not in whitelist) → 短路停
    expect(r.outcome).toBe("didnt");
    expect(r.actions_and_results?.length).toBe(2);
    expect(r.actions_and_results?.[1].channel).toBe("desktop.appleScript");
    expect(r.actions_and_results?.[1].outcome).toBe("didnt");
    // cgEvent / screenshotVlm 没被调用（注入拒了，链停）
    expect(
      rust.calls.filter((c) => c.method === "cgevent_dispatch"),
    ).toHaveLength(0);
    expect(
      rust.calls.filter((c) => c.method === "screenshot"),
    ).toHaveLength(0);
  });

  it("user 传 disallowed param → appleScript 拒（didnt 短路）", async () => {
    const { desktop } = assemble({
      ping: defaultPing(),
      ax_act: () => {
        throw new Error("fail");
      },
    });
    const r = await desktop.act({
      appleScriptAction: "finder_new_folder", // allowedParams=[]
      appleScriptParams: { evil: "x" }, // 但传了 evil key → 拒
    });
    expect(r.outcome).toBe("didnt");
    expect(r.actions_and_results?.[1].channel).toBe("desktop.appleScript");
    expect(r.actions_and_results?.[1].outcome).toBe("didnt");
  });
});
