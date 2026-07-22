/**
 * platform-detect.spec.ts（parse11 §3.1 + §7.2 Phase A v1.0 跨平台 desktop）
 *
 * 守护 platform-detect 的：
 *  1. detectPlatform() 三平台收敛（darwin→mac / win32→win / linux→linux）
 *  2. unknown 平台（freebsd / aix / sunos / openbsd 等）→ "unknown"
 *  3. rawToPlatform 单测（不依赖 process.* 全局）
 *  4. opts.rawPlatform 注入（测试 mock 路径，不强 mock process.platform）
 *  5. PlatformInfo 形状（platform + raw + kernel + arch）
 *
 * INV-21 衍生 + INV-60 衍生：本 spec 不调任何平台 AX API；
 *                          只测 process.platform 字符串收敛逻辑。
 */
import { describe, it, expect } from "vitest";
import {
  detectPlatform,
  rawToPlatform,
  type Platform,
} from "../../src/desktop/platform-detect.js";

// ============================================================
// 1. rawToPlatform：三平台收敛
// ============================================================
describe("rawToPlatform —— process.platform 原值收敛", () => {
  it("darwin → mac", () => {
    expect(rawToPlatform("darwin")).toBe<Platform>("mac");
  });

  it("win32 → win", () => {
    expect(rawToPlatform("win32")).toBe<Platform>("win");
  });

  it("linux → linux", () => {
    expect(rawToPlatform("linux")).toBe<Platform>("linux");
  });

  it("freebsd → unknown（其他 unix 不在支持列）", () => {
    expect(rawToPlatform("freebsd")).toBe<Platform>("unknown");
  });

  it("aix / sunos / openbsd / netbsd → unknown", () => {
    for (const r of ["aix", "sunos", "openbsd", "netbsd"]) {
      expect(rawToPlatform(r)).toBe<Platform>("unknown");
    }
  });

  it("空串 → unknown（守护边界）", () => {
    expect(rawToPlatform("")).toBe<Platform>("unknown");
  });
});

// ============================================================
// 2. detectPlatform：默认走 process.*（生产路径）
// ============================================================
describe("detectPlatform —— 默认读 process.*", () => {
  it("返 PlatformInfo 形状（platform / raw / kernel / arch 四字段）", () => {
    const info = detectPlatform();
    expect(info).toBeDefined();
    expect(typeof info.platform).toBe("string");
    expect(typeof info.raw).toBe("string");
    expect(typeof info.kernel).toBe("string");
    expect(typeof info.arch).toBe("string");
  });

  it("本机 macOS（darwin）→ platform=mac + raw=darwin", () => {
    // 本机 Darwin 21.6.0 Intel（parse11 §1.3 macOS-only 现实红线）
    const info = detectPlatform();
    expect(info.raw).toBe("darwin");
    expect(info.platform).toBe("mac");
  });

  it("本机 kernel 非空（os.release 返内核版本）", () => {
    const info = detectPlatform();
    expect(info.kernel.length).toBeGreaterThan(0);
  });
});

// ============================================================
// 3. detectPlatform：opts.rawPlatform 注入（测试 mock 路径）
// ============================================================
describe("detectPlatform —— opts 注入", () => {
  it("opts.rawPlatform=win32 → platform=win（不强 mock process.platform）", () => {
    const info = detectPlatform({ rawPlatform: "win32" });
    expect(info.platform).toBe("win");
    expect(info.raw).toBe("win32");
  });

  it("opts.rawPlatform=linux → platform=linux", () => {
    const info = detectPlatform({ rawPlatform: "linux" });
    expect(info.platform).toBe("linux");
    expect(info.raw).toBe("linux");
  });

  it("opts.rawPlatform=darwin → platform=mac（显式注入同默认）", () => {
    const info = detectPlatform({ rawPlatform: "darwin" });
    expect(info.platform).toBe("mac");
  });

  it("opts.rawPlatform=freebsd → platform=unknown", () => {
    const info = detectPlatform({ rawPlatform: "freebsd" });
    expect(info.platform).toBe("unknown");
  });

  it("opts.kernel + opts.arch 注入（诊断字段透传）", () => {
    const info = detectPlatform({
      rawPlatform: "win32",
      kernel: "10.0.22631",
      arch: "x64",
    });
    expect(info.kernel).toBe("10.0.22631");
    expect(info.arch).toBe("x64");
  });

  it("opts.rawPlatform=空串 → platform=unknown（守护边界）", () => {
    const info = detectPlatform({ rawPlatform: "" });
    expect(info.platform).toBe("unknown");
    expect(info.raw).toBe("");
  });
});

// ============================================================
// 4. INV-21 衍生：platform-detect.ts 不引平台 API 字面量
// ============================================================
describe("INV-21 衍生 —— platform-detect.ts 不引平台 API 字面量", () => {
  it("源代码本体不出现 AXUIElement / CGEvent / UIAutomationClient / libatspi / IUIAutomation", async () => {
    // 读源文件，去注释，断言无平台 API 字面量
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const filePath = fileURLToPath(
      new URL("../../src/desktop/platform-detect.ts", import.meta.url),
    );
    const text = readFileSync(filePath, "utf8");
    // strip 注释 + 字符串字面量
    const tokenRegex =
      /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
    const codeOnly = text.replace(tokenRegex, (m) =>
      m.startsWith("/") ? "" : m,
    );
    // INV-21 衍生断言：平台 API 符号禁字面量
    expect(codeOnly).not.toMatch(/\bAXUIElement\w*/);
    expect(codeOnly).not.toMatch(/\bUIAutomationClient\b/);
    expect(codeOnly).not.toMatch(/\bIUIAutomation\b/);
    expect(codeOnly).not.toMatch(/\blibatspi\b/);
    // CGEvent FFI 段（INV-21 v0.4 M0.4b 收紧后）
    expect(codeOnly).not.toMatch(
      /\bCGEvent(?:Source|Flags|Type|TapLocation|SourceStateID|Create|Post|Tap)?\b/,
    );
  });
});
