/**
 * ax-backend-factory.spec.ts（parse11 §3.1 + §7.2 Phase A v1.0 跨平台 desktop）
 *
 * 守护 AxBackendFactory 的：
 *  1. detectKind() 三平台路由（darwin→mac / win32→win_uia / linux→linux_atspi）
 *  2. detectKind() 不支持平台抛 unsupported_platform:<raw>
 *  3. createFromKind() 三 kind 路由到对应 class（MacAxBackend / WinUiaBackend / LinuxAtspiBackend）
 *  4. create() 便捷入口（detectKind → createFromKind 一气呵成）
 *  5. INV-60 衍生：AxBackendFactory 是 backend 注册单一真源（grep 三 class `new` 只在 factory）
 *
 * macOS-only 现实红线（parse11 §1.3）：本 spec 用 opts.rawPlatform mock 三平台；
 *                          不 spawn 真 Rust helper；不验真实 UIA/AT-SPI 执行
 *                          （留 parse11-acceptance.md #W1-#W7 / #L1-#L7 手测清单）。
 *
 * 测试策略（mock RustBridge 范式，与 rust-bridge.spec.ts 同）：
 *  - MockRustBridge 走 scripts 表分发；三 backend 都调对应 method
 *  - 三平台同 input RustResponse（ok=true + result.root AxNode 树）→ 同 OutlineNode
 *  - 三平台真实平台 API（uia_xxx / atspi_xxx）在 macOS 本机测不到，spec 只验证 method 路由
 */
import { describe, it, expect } from "vitest";
import { AxBackendFactory } from "../../src/desktop/AxBackendFactory.js";
import {
  MacAxBackend,
  WinUiaBackend,
  LinuxAtspiBackend,
  type AxBackendKind,
} from "../../src/desktop/AxBackend.js";
import { MockRustBridge } from "./mocks/mock-rust-bridge.js";

// ============================================================
// helpers
// ============================================================
/** 造一个 mock RustBridge（默认 noop scripts）。 */
function makeRust(): MockRustBridge {
  return new MockRustBridge({});
}

// ============================================================
// 1. detectKind：三平台路由
// ============================================================
describe("AxBackendFactory.detectKind —— 三平台路由", () => {
  it("darwin → mac", () => {
    expect(AxBackendFactory.detectKind({ rawPlatform: "darwin" }))
      .toBe<AxBackendKind>("mac");
  });

  it("win32 → win_uia", () => {
    expect(AxBackendFactory.detectKind({ rawPlatform: "win32" }))
      .toBe<AxBackendKind>("win_uia");
  });

  it("linux → linux_atspi", () => {
    expect(AxBackendFactory.detectKind({ rawPlatform: "linux" }))
      .toBe<AxBackendKind>("linux_atspi");
  });

  it("本机默认（macOS）→ mac（生产路径无 opts）", () => {
    // 本机 Darwin 21.6.0 Intel（parse11 §1.3）
    expect(AxBackendFactory.detectKind()).toBe<AxBackendKind>("mac");
  });
});

// ============================================================
// 2. detectKind：不支持平台抛错
// ============================================================
describe("AxBackendFactory.detectKind —— 不支持平台抛 unsupported_platform", () => {
  it("freebsd → 抛 unsupported_platform:freebsd", () => {
    expect(() =>
      AxBackendFactory.detectKind({ rawPlatform: "freebsd" }),
    ).toThrow(/unsupported_platform:freebsd/);
  });

  it("aix → 抛 unsupported_platform:aix", () => {
    expect(() =>
      AxBackendFactory.detectKind({ rawPlatform: "aix" }),
    ).toThrow(/unsupported_platform:aix/);
  });

  it("空串 → 抛 unsupported_platform:（守护边界）", () => {
    expect(() =>
      AxBackendFactory.detectKind({ rawPlatform: "" }),
    ).toThrow(/unsupported_platform:/);
  });

  it("抛错 error_kind 与 UNSUPPORTED_PLATFORM_ERROR_KIND 常量一致", async () => {
    const { UNSUPPORTED_PLATFORM_ERROR_KIND } = await import(
      "../../src/desktop/AxBackendFactory.js"
    );
    expect(UNSUPPORTED_PLATFORM_ERROR_KIND).toBe("unsupported_platform");
    try {
      AxBackendFactory.detectKind({ rawPlatform: "freebsd" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(String(e)).toContain(UNSUPPORTED_PLATFORM_ERROR_KIND);
    }
  });
});

// ============================================================
// 3. createFromKind：三 kind → 对应 class
// ============================================================
describe("AxBackendFactory.createFromKind —— 三 kind 路由到对应 class", () => {
  it("mac → MacAxBackend 实例", () => {
    const rust = makeRust();
    const backend = AxBackendFactory.createFromKind("mac", rust);
    expect(backend).toBeInstanceOf(MacAxBackend);
  });

  it("win_uia → WinUiaBackend 实例", () => {
    const rust = makeRust();
    const backend = AxBackendFactory.createFromKind("win_uia", rust);
    expect(backend).toBeInstanceOf(WinUiaBackend);
  });

  it("linux_atspi → LinuxAtspiBackend 实例", () => {
    const rust = makeRust();
    const backend = AxBackendFactory.createFromKind("linux_atspi", rust);
    expect(backend).toBeInstanceOf(LinuxAtspiBackend);
  });

  it("三 backend 都 implements AxBackend interface（snapshot/find/act 三方法）", () => {
    const rust = makeRust();
    for (const kind of ["mac", "win_uia", "linux_atspi"] as const) {
      const backend = AxBackendFactory.createFromKind(kind, rust);
      expect(typeof backend.snapshot).toBe("function");
      expect(typeof backend.find).toBe("function");
      expect(typeof backend.act).toBe("function");
    }
  });
});

// ============================================================
// 4. create：便捷入口（生产路径）
// ============================================================
describe("AxBackendFactory.create —— 便捷入口", () => {
  it("本机默认（macOS）→ MacAxBackend（生产路径）", () => {
    const rust = makeRust();
    const backend = AxBackendFactory.create(rust);
    expect(backend).toBeInstanceOf(MacAxBackend);
  });

  it("opts.rawPlatform=win32 → WinUiaBackend（测试 mock 平台）", () => {
    const rust = makeRust();
    const backend = AxBackendFactory.create(rust, { rawPlatform: "win32" });
    expect(backend).toBeInstanceOf(WinUiaBackend);
  });

  it("opts.rawPlatform=linux → LinuxAtspiBackend", () => {
    const rust = makeRust();
    const backend = AxBackendFactory.create(rust, { rawPlatform: "linux" });
    expect(backend).toBeInstanceOf(LinuxAtspiBackend);
  });

  it("opts.rawPlatform=freebsd → 抛 unsupported_platform", () => {
    const rust = makeRust();
    expect(() =>
      AxBackendFactory.create(rust, { rawPlatform: "freebsd" }),
    ).toThrow(/unsupported_platform:freebsd/);
  });
});

// ============================================================
// 5. 三 backend 调对应 rust method（method 名路由）
// ============================================================
describe("AxBackendFactory 三 backend 调对应 rust method 名", () => {
  it("MacAxBackend → rust.call('ax_snapshot' / 'ax_find' / 'ax_act')", async () => {
    const rust = makeRust();
    const backend = AxBackendFactory.createFromKind("mac", rust);
    await backend.snapshot("Finder", 8);
    await backend.find("Finder", 8, { role: "button" });
    await backend.act([{ type: "click", ref: "@e0" }] as never);
    expect(rust.calls.map((c) => c.method)).toEqual([
      "ax_snapshot",
      "ax_find",
      "ax_act",
    ]);
  });

  it("WinUiaBackend → rust.call('uia_snapshot' / 'uia_find' / 'uia_act')", async () => {
    const rust = makeRust();
    const backend = AxBackendFactory.createFromKind("win_uia", rust);
    await backend.snapshot("notepad", 8);
    await backend.find("notepad", 8, { role: "button" });
    await backend.act([{ type: "click", ref: "@e0" }] as never);
    expect(rust.calls.map((c) => c.method)).toEqual([
      "uia_snapshot",
      "uia_find",
      "uia_act",
    ]);
  });

  it("LinuxAtspiBackend → rust.call('atspi_snapshot' / 'atspi_find' / 'atspi_act')", async () => {
    const rust = makeRust();
    const backend = AxBackendFactory.createFromKind("linux_atspi", rust);
    await backend.snapshot("gedit", 8);
    await backend.find("gedit", 8, { role: "button" });
    await backend.act([{ type: "click", ref: "@e0" }] as never);
    expect(rust.calls.map((c) => c.method)).toEqual([
      "atspi_snapshot",
      "atspi_find",
      "atspi_act",
    ]);
  });

  it("三 backend snapshot 入参 shape 一致（app + max_depth）", async () => {
    const rustMac = makeRust();
    const rustWin = makeRust();
    const rustLinux = makeRust();
    await AxBackendFactory.createFromKind("mac", rustMac)
      .snapshot("X", 5);
    await AxBackendFactory.createFromKind("win_uia", rustWin)
      .snapshot("X", 5);
    await AxBackendFactory.createFromKind("linux_atspi", rustLinux)
      .snapshot("X", 5);
    // 三平台 params 同形（INV-61 衍生：AxBackend interface 三平台同构契约）
    expect(rustMac.calls[0].params).toEqual({ app: "X", max_depth: 5 });
    expect(rustWin.calls[0].params).toEqual({ app: "X", max_depth: 5 });
    expect(rustLinux.calls[0].params).toEqual({ app: "X", max_depth: 5 });
  });
});

// ============================================================
// 6. INV-60 单一真源：grep `new MacAxBackend|WinUiaBackend|LinuxAtspiBackend`
// ============================================================
describe("INV-60 —— AxBackendFactory 是 backend 注册单一真源", () => {
  it("src/ 下 `new MacAxBackend|WinUiaBackend|LinuxAtspiBackend` 只在 AxBackendFactory.ts", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcRoot = fileURLToPath(
      new URL("../../src/", import.meta.url),
    );
    const tsFiles = readdirSync(srcRoot, { recursive: true })
      .map((p) => join(srcRoot, String(p)))
      .filter((p) => p.endsWith(".ts"));
    const newRe =
          /\bnew\s+(?:MacAxBackend|WinUiaBackend|LinuxAtspiBackend)\b/;
    const offenders: string[] = [];
    for (const f of tsFiles) {
      // 去注释
      const text = readFileSync(f, "utf8");
      const tokenRegex =
        /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
      const codeOnly = text.replace(tokenRegex, (m) =>
        m.startsWith("/") ? "" : m,
      );
      if (newRe.test(codeOnly)) {
        offenders.push(relative(srcRoot, f));
      }
    }
    // INV-60 红线：src/ 下只能在 AxBackendFactory.ts 直构 backend
    expect(offenders).toEqual(["desktop/AxBackendFactory.ts"]);
  });

  it("AxProvider.ts 不直接 new 任一 backend class（INV-60 衍生）", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const filePath = fileURLToPath(
      new URL("../../src/desktop/AxProvider.ts", import.meta.url),
    );
    const text = readFileSync(filePath, "utf8");
    // strip 注释 + 字符串字面量（与上面 (c) check 同语义；JSDoc 内的
    // `new MacAxBackend(mockRust)` 示例不算违规 —— INV-60 守的是代码本体）
    const tokenRegex =
      /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
    const codeOnly = text.replace(tokenRegex, (m) =>
      m.startsWith("/") ? "" : m,
    );
    expect(codeOnly).not.toMatch(
      /\bnew\s+(?:MacAxBackend|WinUiaBackend|LinuxAtspiBackend)\b/,
    );
  });
});
