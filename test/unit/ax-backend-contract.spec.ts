/**
 * ax-backend-contract.spec.ts（parse11 §3.1 + §7.2 Phase A v1.0 跨平台 desktop）
 *
 * 守护 AxBackend 三平台**同构契约**（parse11 §3.1 INV-61 锚点；Phase B 完整落地）：
 *  1. 三 backend snapshot/find/act 都返 Promise<RustResponse>（interface 同形）
 *  2. 三 backend 同 input RustResponse（mock 走 scripts 表）→ 同 OutlineNode（OutlineMapper 三平台共享）
 *  3. 三 backend 调对应 method 名（ax_* / uia_* / atspi_*）+ 同形 params
 *  4. 三 backend 同 error_kind → 同 outcome（错误契约三平台一致）
 *
 * INV-61 衍生（parse11 §3.1）：OutlineMapper 是三平台共享单一 mapper。
 *   本 spec 是 INV-61 的可执行锚点 —— Phase B Rust 端 cfg-gate 实装后，三平台
 *   AxNode JSON 同形 → OutlineMapper byte-identical 输出。
 *
 * macOS-only 现实红线（parse11 §1.3）：本 spec 是 CI 静态 + 形状测；
 *                          真实 Win/Linux AX tree 形状与 macOS 是否语义对齐
 *                          （如 Win Button role 与 macOS AXButton 是否都映射到
 *                          outline.role="button"）留手测清单 #W6/#L6。
 *
 * 测试策略：MockRustBridge 注入同 shape RustResponse（不同 method 名）→
 *          三 AxProvider(new XxxBackend(mock)) → 断言 InteractResult byte-identical。
 */
import { describe, it, expect, vi } from "vitest";
import { AxProvider } from "../../src/desktop/AxProvider.js";
import {
  MacAxBackend,
  WinUiaBackend,
  LinuxAtspiBackend,
  type AxBackend,
} from "../../src/desktop/AxBackend.js";
import { MockRustBridge } from "./mocks/mock-rust-bridge.js";
import type { AxNode } from "../../src/desktop/desktop-types.js";
import type { RustResponse } from "../../src/subprocess/RustBridge.js";

// ============================================================
// helpers
// ============================================================
/** 造一个最小 AxNode 树（root + 2 children）。 */
function mockAxTree(): AxNode {
  return {
    role: "window",
    raw_role: "AXWindow", // macOS 诊断字段；Win/Linux 真机可以是 "Window" 等
    label: "TestApp",
    rect: { x: 0, y: 0, w: 800, h: 600 },
    enabled: true,
    focused: true,
    depth: 0,
    children: [
      {
        role: "button",
        raw_role: "AXButton",
        label: "OK",
        rect: { x: 10, y: 10, w: 80, h: 30 },
        enabled: true,
        focused: false,
        depth: 1,
        children: [],
      },
      {
        role: "textfield",
        raw_role: "AXTextField",
        label: "Search",
        rect: { x: 100, y: 10, w: 200, h: 30 },
        enabled: true,
        focused: false,
        depth: 1,
        children: [],
      },
    ],
  };
}

/** 造一个 ok=true RustResponse（result.root = AxNode 树）。 */
function okSnapshotResponse(): RustResponse {
  return {
    id: "test",
    ok: true,
    result: { root: mockAxTree() },
  };
}

/** 造一个 ok=false RustResponse（指定 error_kind）。 */
function errResponse(errorKind: string): RustResponse {
  return {
    id: "test",
    ok: false,
    error: `<kind:${errorKind}>`,
    error_kind: errorKind,
  };
}

/**
 * 直构 AxBackend mock（不走 MockRustBridge）—— 返调用方指定的 RustResponse。
 *
 * 用于错误契约测试：MockRustBridge 的 script 抛错时 error_kind 永远是
 * "script_error"（mock 实现细节），无法注入 tcc_denied 等具体 error_kind。
 * 直构 AxBackend mock 绕开这一层，让 AxProvider 直接吃到指定 error_kind。
 *
 * 三平台 mock 实例按 methodPrefix 区分（仅用于 calls 记录断言）；
 * 返的 RustResponse 三平台完全相同（错误契约三平台一致是 INV-61 的契约层断言）。
 */
function makeDirectBackend(
  resp: RustResponse,
  methodPrefix: "ax" | "uia" | "atspi" = "ax",
): AxBackend & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const backend: AxBackend & { calls: typeof calls } = {
    calls,
    snapshot: vi.fn(async (app: string | undefined, maxDepth: number) => {
      calls.push({ method: `${methodPrefix}_snapshot`, params: { app, max_depth: maxDepth } });
      return resp;
    }),
    find: vi.fn(async (
      app: string | undefined,
      maxDepth: number,
      where: unknown,
    ) => {
      calls.push({
        method: `${methodPrefix}_find`,
        params: { app, max_depth: maxDepth, where },
      });
      return resp;
    }),
    act: vi.fn(async (actions: unknown) => {
      calls.push({ method: `${methodPrefix}_act`, params: { actions } });
      return resp;
    }),
  };
  return backend;
}

/**
 * 造一个 mock RustBridge，所有 method 都返同一个 response。
 * 三 platform backend 各自调对应 method（ax_* / uia_* / atspi_*），
 * mock 不区分 method，只看响应数据。
 */
function makeRustWithResponse(resp: RustResponse): MockRustBridge {
  return new MockRustBridge({
    ax_snapshot: () => resp.result,
    ax_find: () => resp.result,
    ax_act: () => resp.result,
    uia_snapshot: () => resp.result,
    uia_find: () => resp.result,
    uia_act: () => resp.result,
    atspi_snapshot: () => resp.result,
    atspi_find: () => resp.result,
    atspi_act: () => resp.result,
  });
}

/** 三 platform backend 实例（同一 mock rust）。 */
function makeThreeBackends(rust: MockRustBridge) {
  return {
    mac: new MacAxBackend(rust as unknown as never),
    win: new WinUiaBackend(rust as unknown as never),
    linux: new LinuxAtspiBackend(rust as unknown as never),
  };
}

// ============================================================
// 1. 三 backend snapshot 同 input → 同 OutlineNode（INV-61 核心）
// ============================================================
describe("三 backend 同构契约 —— snapshot 同 input → 同 OutlineNode", () => {
  it("三 backend snapshot 返同 outcome=worked", async () => {
    const rust = makeRustWithResponse(okSnapshotResponse());
    const backends = makeThreeBackends(rust);
    const opts = { app: "X", max_depth: 8 };
    const results = await Promise.all([
      new AxProvider(backends.mac).snapshot(opts),
      new AxProvider(backends.win).snapshot(opts),
      new AxProvider(backends.linux).snapshot(opts),
    ]);
    // 三 platform 都 worked（INV-61 三平台同构）
    expect(results.every((r) => r.outcome === "worked")).toBe(true);
  });

  it("三 backend snapshot OutlineNode byte-identical（root.role / label / children[].role）", async () => {
    const rust = makeRustWithResponse(okSnapshotResponse());
    const backends = makeThreeBackends(rust);
    const opts = { app: "X", max_depth: 8 };
    const [mac, win, linux] = await Promise.all([
      new AxProvider(backends.mac).snapshot(opts),
      new AxProvider(backends.win).snapshot(opts),
      new AxProvider(backends.linux).snapshot(opts),
    ]);
    // data 是 OutlineSnapshot；对比 root 树（去 stateId / createdAt 这些每次变化的字段）
    const stripTransient = (
      r: { data: { root: unknown; stateId: string; createdAt: number } | null },
    ) => {
      if (!r.data) return null;
      const { root, ..._transient } = r.data;
      void _transient;
      return root;
    };
    const macRoot = stripTransient(mac);
    const winRoot = stripTransient(win);
    const linuxRoot = stripTransient(linux);
    // INV-61 核心：OutlineMapper 三平台共享 → byte-identical OutlineNode
    expect(winRoot).toEqual(macRoot);
    expect(linuxRoot).toEqual(macRoot);
  });

  it("OutlineMapper 把 root.role=window 映射为 outline.role=window（三平台一致）", async () => {
    const rust = makeRustWithResponse(okSnapshotResponse());
    const backends = makeThreeBackends(rust);
    const opts = { app: "X", max_depth: 8 };
    const mac = await new AxProvider(backends.mac).snapshot(opts);
    const win = await new AxProvider(backends.win).snapshot(opts);
    const linux = await new AxProvider(backends.linux).snapshot(opts);
    // root 节点 role 三平台都映射为 "window"
    expect((mac.data as { root: { role: string } }).root.role).toBe("window");
    expect((win.data as { root: { role: string } }).root.role).toBe("window");
    expect((linux.data as { root: { role: string } }).root.role).toBe("window");
  });
});

// ============================================================
// 2. 三 backend find 同 input → 同 matches shape
// ============================================================
describe("三 backend 同构契约 —— find 同 input → 同 matches shape", () => {
  it("三 backend find 返同 outcome=worked + 同 count", async () => {
    const rust = new MockRustBridge({
      ax_find: () => ({
        matches: [
          { ref: "@e0", role: "button", label: "OK" },
          { ref: "@e1", role: "button", label: "Cancel" },
        ],
      }),
      uia_find: () => ({
        matches: [
          { ref: "@e0", role: "button", label: "OK" },
          { ref: "@e1", role: "button", label: "Cancel" },
        ],
      }),
      atspi_find: () => ({
        matches: [
          { ref: "@e0", role: "button", label: "OK" },
          { ref: "@e1", role: "button", label: "Cancel" },
        ],
      }),
    });
    const backends = makeThreeBackends(rust);
    const opts = {
      app: "X",
      max_depth: 8,
      where: { role: "button" },
    };
    const [mac, win, linux] = await Promise.all([
      new AxProvider(backends.mac).find(opts),
      new AxProvider(backends.win).find(opts),
      new AxProvider(backends.linux).find(opts),
    ]);
    expect(mac.outcome).toBe("worked");
    expect(win.outcome).toBe("worked");
    expect(linux.outcome).toBe("worked");
    expect(mac.data?.count).toBe(2);
    expect(win.data?.count).toBe(2);
    expect(linux.data?.count).toBe(2);
  });
});

// ============================================================
// 3. 三 backend 同 error_kind → 同 outcome（错误契约三平台一致）
// ============================================================
describe("三 backend 同构契约 —— 错误契约三平台一致", () => {
  // 注：MockRustBridge 的 script 抛错时 error_kind 永远是 "script_error"（mock 细节），
  //   无法注入 tcc_denied 等具体 error_kind。本节用直构 AxBackend mock 绕开。
  //   错误契约（outcomeOf + DIDNT_ERROR_KINDS）三平台共享是 INV-61 的契约层断言。
  it("三 backend tcc_denied（macOS）/ equivalent → outcome=didnt", async () => {
    const opts = { app: "X", max_depth: 8 };
    const [mac, win, linux] = await Promise.all([
      new AxProvider(makeDirectBackend(errResponse("tcc_denied"), "ax")).snapshot(opts),
      new AxProvider(makeDirectBackend(errResponse("tcc_denied"), "uia")).snapshot(opts),
      new AxProvider(makeDirectBackend(errResponse("tcc_denied"), "atspi")).snapshot(opts),
    ]);
    // 三 platform 错误契约一致（DIDNT_ERROR_KINDS 三平台共享）
    expect(mac.outcome).toBe("didnt");
    expect(win.outcome).toBe("didnt");
    expect(linux.outcome).toBe("didnt");
  });

  it("三 backend app_not_found → outcome=didnt", async () => {
    const opts = { app: "X", max_depth: 8 };
    const [mac, win, linux] = await Promise.all([
      new AxProvider(makeDirectBackend(errResponse("app_not_found"), "ax")).snapshot(opts),
      new AxProvider(makeDirectBackend(errResponse("app_not_found"), "uia")).snapshot(opts),
      new AxProvider(makeDirectBackend(errResponse("app_not_found"), "atspi")).snapshot(opts),
    ]);
    expect(mac.outcome).toBe("didnt");
    expect(win.outcome).toBe("didnt");
    expect(linux.outcome).toBe("didnt");
  });

  it("三 backend not_implemented → outcome=unknown（Phase B 占位）", async () => {
    const opts = { app: "X", max_depth: 8 };
    const [mac, win, linux] = await Promise.all([
      new AxProvider(makeDirectBackend(errResponse("not_implemented"), "ax")).snapshot(opts),
      new AxProvider(makeDirectBackend(errResponse("not_implemented"), "uia")).snapshot(opts),
      new AxProvider(makeDirectBackend(errResponse("not_implemented"), "atspi")).snapshot(opts),
    ]);
    expect(mac.outcome).toBe("unknown");
    expect(win.outcome).toBe("unknown");
    expect(linux.outcome).toBe("unknown");
  });

  it("三 backend 未知 error_kind → outcome=unknown（触发 fallback）", async () => {
    const opts = { app: "X", max_depth: 8 };
    const [mac, win, linux] = await Promise.all([
      new AxProvider(makeDirectBackend(errResponse("not_windows"), "ax")).snapshot(opts),
      new AxProvider(makeDirectBackend(errResponse("not_windows"), "uia")).snapshot(opts),
      new AxProvider(makeDirectBackend(errResponse("not_windows"), "atspi")).snapshot(opts),
    ]);
    // not_windows 不在 DIDNT_ERROR_KINDS → unknown（三平台一致）
    expect(mac.outcome).toBe("unknown");
    expect(win.outcome).toBe("unknown");
    expect(linux.outcome).toBe("unknown");
  });
});

// ============================================================
// 4. 三 backend method 名路由（params shape 同构）
// ============================================================
describe("三 backend method 名路由 + params shape 同构", () => {
  it("三 backend snapshot params 都含 app + max_depth（同形）", async () => {
    const rust = makeRustWithResponse(okSnapshotResponse());
    const backends = makeThreeBackends(rust);
    await Promise.all([
      backends.mac.snapshot("X", 5),
      backends.win.snapshot("X", 5),
      backends.linux.snapshot("X", 5),
    ]);
    // 三 method 名不同（ax_* / uia_* / atspi_*），但 params shape 一致
    expect(rust.calls[0]).toEqual({
      method: "ax_snapshot",
      params: { app: "X", max_depth: 5 },
    });
    expect(rust.calls[1]).toEqual({
      method: "uia_snapshot",
      params: { app: "X", max_depth: 5 },
    });
    expect(rust.calls[2]).toEqual({
      method: "atspi_snapshot",
      params: { app: "X", max_depth: 5 },
    });
  });

  it("三 backend find params 都含 app + max_depth + where（同形）", async () => {
    const rust = makeRustWithResponse(okSnapshotResponse());
    const backends = makeThreeBackends(rust);
    const where = { role: "button" };
    await Promise.all([
      backends.mac.find("X", 5, where),
      backends.win.find("X", 5, where),
      backends.linux.find("X", 5, where),
    ]);
    expect(rust.calls[0].params).toEqual({
      app: "X",
      max_depth: 5,
      where,
    });
    expect(rust.calls[1].params).toEqual({
      app: "X",
      max_depth: 5,
      where,
    });
    expect(rust.calls[2].params).toEqual({
      app: "X",
      max_depth: 5,
      where,
    });
  });

  it("三 backend act params 都只含 actions（interface 同形）", async () => {
    const rust = makeRustWithResponse(okSnapshotResponse());
    const backends = makeThreeBackends(rust);
    const actions = [{ type: "click", ref: "@e0" }] as never;
    await Promise.all([
      backends.mac.act(actions),
      backends.win.act(actions),
      backends.linux.act(actions),
    ]);
    // AxBackend.act interface 只接 actions（不接 app；parse11 §3.1 AxBackendKind spec）
    expect(rust.calls[0].params).toEqual({ actions });
    expect(rust.calls[1].params).toEqual({ actions });
    expect(rust.calls[2].params).toEqual({ actions });
  });
});

// ============================================================
// 5. INV-21 衍生：三 backend 源代码无平台 API 字面量
// ============================================================
describe("INV-21 衍生 —— AxBackend.ts 三 class 源代码无平台 API 字面量", () => {
  it("AxBackend.ts 去注释后无 UIAutomationClient / IUIAutomation / libatspi / Atspi / Accessible", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const filePath = fileURLToPath(
      new URL("../../src/desktop/AxBackend.ts", import.meta.url),
    );
    const text = readFileSync(filePath, "utf8");
    const tokenRegex =
      /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
    const codeOnly = text.replace(tokenRegex, (m) =>
      m.startsWith("/") ? "" : m,
    );
    // INV-21 衍生（parse11 §3.1）：WinUiaBackend / LinuxAtspiBackend 内不出现
    // 真实平台 API 字面量；只调 rust.call("uia_*"|"atspi_*") 薄壳。
    expect(codeOnly).not.toMatch(/\bUIAutomationClient\b/);
    expect(codeOnly).not.toMatch(/\bIUIAutomation\w*\b/);
    expect(codeOnly).not.toMatch(/\blibatspi\b/);
    expect(codeOnly).not.toMatch(/\bAtspiAccessible\b/);
    // INV-21 v0.4 M0.4b 收紧后的 macOS FFI 段
    expect(codeOnly).not.toMatch(
      /\bCGEvent(?:Source|Flags|Type|TapLocation|SourceStateID|Create|Post|Tap)?\b/,
    );
    expect(codeOnly).not.toMatch(/\bAXUIElement\w*/);
  });
});
