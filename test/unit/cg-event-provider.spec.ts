/**
 * cg-event-provider.spec.ts（parse5 §3.5.3 + INV-28）
 *
 * 守护 CGEventProvider 的：
 *  - 4-tier 语义：仅 press/hotkey 走本档；click/type/scroll 不支持 → unknown（链继续）
 *  - INV-28：禁 raw keycode 数字入参（press.key=number / hotkey.keys 元素=number 都拒）
 *  - rust.call("cgevent_dispatch") 调用契约（INV-21 衍生：TS 不直接碰 FFI）
 *  - rust 错误透传：每项独立成败；全失败 → unknown；部分成功 → worked
 *
 * Mock 策略：用 MockRustBridge 脚本化 cgevent_dispatch；不拉真 Rust helper。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CGEventProvider } from "../../src/desktop/CGEventProvider.js";
import { MockRustBridge } from "../unit/mocks/mock-rust-bridge.js";
import type { DesktopOptions, UiAction } from "../../src/desktop/desktop-types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ============================================================
// helpers
// ============================================================
function makeProvider(scripts: Record<string, (p: unknown) => unknown> = {}) {
  const rust = new MockRustBridge(scripts);
  const provider = new CGEventProvider(rust as unknown as never);
  return { provider, rust };
}

/** cgevent_dispatch 成功响应：每项 ok=true。 */
function cgeventOkResults() {
  return () => ({
    results: [{ index: 0, ok: true }],
  });
}

// ============================================================
// 1. 入口校验
// ============================================================
describe("CGEventProvider — 入口校验", () => {
  it("无 actions → outcome=unknown + retrieval_method=cgevent_no_action（4-tier 链继续）", async () => {
    const { provider } = makeProvider({ ping: () => ({ pong: true }) });
    const r = await provider.act({} as DesktopOptions);
    // 4-tier 语义：无 actions = 本档无事可做 → unknown（让链继续）
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("cgevent_no_action");
    expect(r.error).toBe("no_actions_specified");
    expect(r.served_by).toBe("desktop.cgEvent");
  });

  it("空 actions 数组 → outcome=unknown + cgevent_no_action", async () => {
    const { provider } = makeProvider({ ping: () => ({ pong: true }) });
    const r = await provider.act({ actions: [] });
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("cgevent_no_action");
  });

  it("actions 仅含 click/type/scroll（无 press/hotkey）→ outcome=unknown + cgevent_no_supported_action（4-tier 链继续）", async () => {
    const { provider } = makeProvider({ ping: () => ({ pong: true }) });
    const r = await provider.act({
      actions: [{ kind: "click", ref: "@e1" }],
    });
    // 4-tier 语义：本档不适用 → unknown，让链继续到 screenshotVlm
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("cgevent_no_supported_action");
    expect(r.error).toBe("only_press_or_hotkey_supported");
    expect(r.served_by).toBe("desktop.cgEvent");
  });

  it("actions 仅含 scroll → 同样 unknown（scroll 不属 cgevent）", async () => {
    const { provider } = makeProvider();
    const r = await provider.act({
      actions: [{ kind: "scroll", ref: "@e1", dx: 0, dy: 100 }],
    });
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("cgevent_no_supported_action");
  });
});

// ============================================================
// 2. INV-28 守门：raw keycode 数字入参拒绝
// ============================================================
describe("CGEventProvider — INV-28 raw keycode 守门", () => {
  it("press.key 是 number（raw keycode）→ outcome=didnt + cgevent_raw_keycode_forbidden", async () => {
    const { provider, rust } = makeProvider({ cgevent_dispatch: cgeventOkResults() });
    // INV-28：禁直传 raw keycode 数字（如 36=Return）；只接受逻辑键名
    const r = await provider.act({
      actions: [{ kind: "press", key: 36 } as unknown as UiAction],
    });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("cgevent_raw_keycode_forbidden");
    expect(r.error).toMatch(/raw_keycode_forbidden/);
    expect(r.error).toMatch(/INV-28/);
    // 守门在层 1，不传 Rust
    expect(
      rust.calls.filter((c) => c.method === "cgevent_dispatch"),
    ).toHaveLength(0);
  });

  it("hotkey.keys 数组含 number 元素 → outcome=didnt + raw_keycode_forbidden", async () => {
    const { provider, rust } = makeProvider({ cgevent_dispatch: cgeventOkResults() });
    const r = await provider.act({
      actions: [
        { kind: "hotkey", keys: ["cmd", 8] } as unknown as UiAction,
      ],
    });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("cgevent_raw_keycode_forbidden");
    expect(
      rust.calls.filter((c) => c.method === "cgevent_dispatch"),
    ).toHaveLength(0);
  });

  it("混合 actions 中只要有一项 raw keycode → 整批拒（INV-28 全有或全无）", async () => {
    const { provider, rust } = makeProvider({ cgevent_dispatch: cgeventOkResults() });
    const r = await provider.act({
      actions: [
        { kind: "press", key: "Return" },
        { kind: "press", key: 36 } as unknown as UiAction, // raw keycode
      ],
    });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("cgevent_raw_keycode_forbidden");
    expect(
      rust.calls.filter((c) => c.method === "cgevent_dispatch"),
    ).toHaveLength(0);
  });
});

// ============================================================
// 3. press / hotkey happy path（逻辑键名 → rust 调用）
// ============================================================
describe("CGEventProvider — press/hotkey happy path", () => {
  it("单 press 逻辑键名 → outcome=worked + rust 调用 cgevent_dispatch", async () => {
    const { provider, rust } = makeProvider({
      cgevent_dispatch: () => ({
        results: [{ index: 0, ok: true }],
      }),
    });
    const r = await provider.act({
      actions: [{ kind: "press", key: "Return" }],
    });
    expect(r.outcome).toBe("worked");
    expect(r.retrieval_method).toBe("cgevent_ffi");
    expect(r.data?.actions_and_results).toHaveLength(1);
    expect(r.data?.actions_and_results?.[0]).toEqual({
      ref: "Return",
      ok: true,
    });
    // rust 调用契约：method + actions 数组
    expect(rust.calls).toHaveLength(1);
    expect(rust.calls[0].method).toBe("cgevent_dispatch");
    const sentActions = (
      rust.calls[0].params as { actions: unknown[] }
    ).actions;
    expect(sentActions).toHaveLength(1);
    expect(sentActions[0]).toEqual({ kind: "press", key: "Return" });
  });

  it("单 hotkey（多键元素）→ join(+) 成 spec 字符串", async () => {
    const { provider, rust } = makeProvider({
      cgevent_dispatch: () => ({
        results: [{ index: 0, ok: true }],
      }),
    });
    const r = await provider.act({
      actions: [{ kind: "hotkey", keys: ["cmd", "c"] }],
    });
    expect(r.outcome).toBe("worked");
    expect(r.data?.actions_and_results?.[0]).toEqual({
      ref: "cmd+c",
      ok: true,
    });
    // wire：hotkey spec 是 join("+") 后的单字符串
    const sentActions = (
      rust.calls[0].params as { actions: Array<{ kind: string; keys: string }> }
    ).actions;
    expect(sentActions[0]).toEqual({ kind: "hotkey", keys: "cmd+c" });
  });

  it("多 press 顺序 → actions_and_results 顺序保留", async () => {
    const { provider } = makeProvider({
      cgevent_dispatch: () => ({
        results: [
          { index: 0, ok: true },
          { index: 1, ok: true },
          { index: 2, ok: true },
        ],
      }),
    });
    const r = await provider.act({
      actions: [
        { kind: "press", key: "Tab" },
        { kind: "press", key: "Return" },
        { kind: "press", key: "Escape" },
      ],
    });
    expect(r.outcome).toBe("worked");
    expect(r.data?.actions_and_results?.map((a) => a.ref)).toEqual([
      "Tab",
      "Return",
      "Escape",
    ]);
  });
});

// ============================================================
// 4. 部分成功 / 全失败
// ============================================================
describe("CGEventProvider — 部分成功 / 全失败语义", () => {
  it("部分项失败（≥1 ok）→ outcome=worked（与 AxProvider 部分成功策略一致）", async () => {
    const { provider } = makeProvider({
      cgevent_dispatch: () => ({
        results: [
          { index: 0, ok: true },
          { index: 1, ok: false, error_kind: "cgevent_unknown_key", error: "unknown key XYZ" },
        ],
      }),
    });
    const r = await provider.act({
      actions: [
        { kind: "press", key: "Return" },
        { kind: "press", key: "UnknownKey" },
      ],
    });
    expect(r.outcome).toBe("worked"); // 至少 1 ok
    expect(r.data?.actions_and_results).toHaveLength(2);
    expect(r.data?.actions_and_results?.[0].ok).toBe(true);
    expect(r.data?.actions_and_results?.[1].ok).toBe(false);
    expect(r.data?.actions_and_results?.[1].error).toMatch(/unknown_key|unknown key/);
  });

  it("全部项失败 → outcome=unknown（真实执行错，可被上游 fallback）", async () => {
    const { provider } = makeProvider({
      cgevent_dispatch: () => ({
        results: [
          { index: 0, ok: false, error_kind: "cgevent_unknown_key", error: "x" },
          { index: 1, ok: false, error_kind: "cgevent_unknown_key", error: "y" },
        ],
      }),
    });
    const r = await provider.act({
      actions: [
        { kind: "press", key: "Foo" },
        { kind: "press", key: "Bar" },
      ],
    });
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("cgevent_all_actions_failed");
  });

  it("rust.call ok=false（通讯错）→ outcome=unknown + retrieval_method=error_kind", async () => {
    const { provider, rust } = makeProvider();
    // 不注册 cgevent_dispatch → MockRustBridge 返 unscripted → ok=false + error_kind=unknown_method
    const r = await provider.act({
      actions: [{ kind: "press", key: "Return" }],
    });
    expect(r.outcome).toBe("unknown");
    // retrieval_method 直接透传 error_kind（默认 cgevent_failed 仅在 error_kind 缺席时用）
    expect(r.retrieval_method).toBe("unknown_method");
    expect(r.error).toMatch(/unscripted/);
    expect(rust.calls).toHaveLength(1); // 仍然尝试调用了
  });
});

// ============================================================
// 5. INV-28 自检：源文件无 raw keycode 字面量
// ============================================================
describe("INV-28 — CGEventProvider.ts 源文件 raw keycode 自检", () => {
  const filePath = fileURLToPath(
    new URL("../../src/desktop/CGEventProvider.ts", import.meta.url),
  );
  const text = readFileSync(filePath, "utf8");
  const codeOnly = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("代码本体无 `key:<数字>` / `keycode:<数字>` 字面量", () => {
    expect(codeOnly).not.toMatch(/\bkey\s*:\s*\d+\b/);
    expect(codeOnly).not.toMatch(/\bkeycode\s*:\s*\d+\b/);
  });

  it("代码本体无 CGEvent FFI 直调符号（INV-21 衍生）", () => {
    // CGEvent / CGEventSource / CGEventFlags 都是 core-graphics crate FFI；
    // 这些应只在 rust-helper/src/cgevent.rs，TS 端 0 容忍
    expect(codeOnly).not.toMatch(/\bCGEvent\b/);
    expect(codeOnly).not.toMatch(/\bCGEventSource\b/);
    expect(codeOnly).not.toMatch(/\bCGEventFlags\b/);
  });

  it("代码本体含 raw_keycode_forbidden 守门逻辑（INV-28 实装锚点）", () => {
    // 反向断言：守门逻辑必须存在（grep 守门标识）
    expect(codeOnly).toMatch(/raw_keycode_forbidden/);
  });
});
