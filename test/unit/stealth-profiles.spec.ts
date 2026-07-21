/**
 * stealth-profiles 单测（parse5 §3.3.2 + §5.2 + task #7）
 *
 * 覆盖：
 *  - STEALTH_PROFILES 顶级 const 形状（3 profiles：windows_chrome_120 / mac_safari_17 / linux_firefox_121）
 *  - 每个 profile 含 userAgent / viewport / timezone / language / platform 5 字段
 *  - userAgent 是非空字符串 + 含合理 Mozilla 前缀
 *  - viewport 是合理分辨率（width 1024-3840，height 720-2160）
 *  - STEALTH_PROFILE_NAMES 与 STEALTH_PROFILES keys 一致
 *  - STEALTH_INJECTION_SCRIPT 是顶级 const 字符串 + 含 navigator.webdriver 抹除
 *  - CLOUDFLARE_DETECTION_SCRIPT 返 "true"/"false" 形状 + 含 marker
 *  - CLOUDFLARE_CHALLENGE_MARKERS 含 "Just a moment"
 *  - CLOUDFLARE_DETECTION_REGEX 匹配 markers
 *
 * INV-30 关键断言（v0.4 M0.4c）：
 *  - 本文件代码本体禁出现 process.env（anti-gaming 红线）
 *  - 本文件不 import config / provider-registry（顶级 const 数据无运行时配置依赖）
 *  - STEALTH_PROFILES 是 export const（不是 function / class）
 */
import { describe, it, expect } from "vitest";
import {
  STEALTH_PROFILES,
  STEALTH_PROFILE_NAMES,
  STEALTH_INJECTION_SCRIPT,
  CLOUDFLARE_DETECTION_SCRIPT,
  CLOUDFLARE_CHALLENGE_MARKERS,
  CLOUDFLARE_DETECTION_REGEX,
  type StealthProfile,
  type StealthProfileName,
} from "../../src/browse/stealth-profiles.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================
// 加载源码（INV-30 anti-gaming grep：禁 process.env / 禁 config import）
// ============================================================
const SRC = fs.readFileSync(
  path.resolve("src/browse/stealth-profiles.ts"),
  "utf8",
);

// ============================================================
// STEALTH_PROFILES 形状
// ============================================================
describe("STEALTH_PROFILES — 顶级 const 形状（parse5 §3.3.2）", () => {
  it("含至少 3 个 profile（windows_chrome_120 / mac_safari_17 / linux_firefox_121）", () => {
    expect(STEALTH_PROFILES.windows_chrome_120).toBeDefined();
    expect(STEALTH_PROFILES.mac_safari_17).toBeDefined();
    expect(STEALTH_PROFILES.linux_firefox_121).toBeDefined();
    expect(Object.keys(STEALTH_PROFILES).length).toBeGreaterThanOrEqual(3);
  });

  it("每个 profile 含 userAgent / viewport / timezone / language / platform 5 字段", () => {
    for (const [name, profile] of Object.entries(STEALTH_PROFILES)) {
      expect(profile.userAgent).toBeTruthy();
      expect(profile.viewport).toBeDefined();
      expect(profile.viewport.width).toBeGreaterThan(0);
      expect(profile.viewport.height).toBeGreaterThan(0);
      expect(profile.timezone).toBeTruthy();
      expect(profile.language).toBeTruthy();
      expect(profile.platform).toBeTruthy();
      // 形状校验：5 字段类型正确
      const _: StealthProfile = profile;
      expect(typeof _.userAgent).toBe("string");
      expect(typeof _.timezone).toBe("string");
      expect(typeof _.language).toBe("string");
      expect(typeof _.platform).toBe("string");
    }
  });

  it("userAgent 含 Mozilla 前缀（合理浏览器 UA）", () => {
    for (const profile of Object.values(STEALTH_PROFILES)) {
      expect(profile.userAgent.startsWith("Mozilla/5.0")).toBe(true);
    }
  });

  it("viewport 合理分辨率（width 1024-3840，height 720-2160）", () => {
    for (const profile of Object.values(STEALTH_PROFILES)) {
      expect(profile.viewport.width).toBeGreaterThanOrEqual(1024);
      expect(profile.viewport.width).toBeLessThanOrEqual(3840);
      expect(profile.viewport.height).toBeGreaterThanOrEqual(720);
      expect(profile.viewport.height).toBeLessThanOrEqual(2160);
    }
  });

  it("platform 是已知值（Win32 / MacIntel / Linux x86_64）", () => {
    const known = new Set(["Win32", "MacIntel", "Linux x86_64"]);
    for (const profile of Object.values(STEALTH_PROFILES)) {
      expect(known.has(profile.platform)).toBe(true);
    }
  });

  it("windows_chrome_120 含 Chrome 字样（profile 名与 UA 一致）", () => {
    expect(STEALTH_PROFILES.windows_chrome_120.userAgent).toContain("Chrome");
    expect(STEALTH_PROFILES.windows_chrome_120.platform).toBe("Win32");
  });

  it("mac_safari_17 含 Safari 字样（profile 名与 UA 一致）", () => {
    expect(STEALTH_PROFILES.mac_safari_17.userAgent).toContain("Safari");
    expect(STEALTH_PROFILES.mac_safari_17.platform).toBe("MacIntel");
  });

  it("linux_firefox_121 含 Firefox 字样（profile 名与 UA 一致）", () => {
    expect(STEALTH_PROFILES.linux_firefox_121.userAgent).toContain("Firefox");
    expect(STEALTH_PROFILES.linux_firefox_121.platform).toBe("Linux x86_64");
  });
});

// ============================================================
// STEALTH_PROFILE_NAMES
// ============================================================
describe("STEALTH_PROFILE_NAMES — 与 STEALTH_PROFILES keys 一致", () => {
  it("返回值是 STEALTH_PROFILES 的 keys 数组", () => {
    const expected = Object.keys(STEALTH_PROFILES) as StealthProfileName[];
    expect(STEALTH_PROFILE_NAMES.sort()).toEqual(expected.sort());
  });

  it("类型 StealthProfileName 接受已知 profile 名", () => {
    const n: StealthProfileName = "windows_chrome_120";
    expect(STEALTH_PROFILES[n]).toBeDefined();
    expect(n).toBeTruthy();
  });
});

// ============================================================
// STEALTH_INJECTION_SCRIPT
// ============================================================
describe("STEALTH_INJECTION_SCRIPT — navigator.webdriver 抹除（parse5 §3.3.1）", () => {
  it("是字符串（非空 + IIFE 形状）", () => {
    expect(typeof STEALTH_INJECTION_SCRIPT).toBe("string");
    expect(STEALTH_INJECTION_SCRIPT.length).toBeGreaterThan(50);
    expect(STEALTH_INJECTION_SCRIPT.startsWith("(function()")).toBe(true);
    expect(STEALTH_INJECTION_SCRIPT.trim().endsWith(")();")).toBe(true);
  });

  it("含 navigator.webdriver override（最关键反检测点）", () => {
    expect(STEALTH_INJECTION_SCRIPT).toContain("navigator");
    expect(STEALTH_INJECTION_SCRIPT).toContain("webdriver");
    // 形如 Object.defineProperty(navigator, "webdriver", ...)
    expect(STEALTH_INJECTION_SCRIPT).toMatch(
      /Object\.defineProperty\s*\(\s*navigator\s*,\s*["']webdriver["']/,
    );
  });

  it("含 navigator.languages 注入（headless 默认空数组是破绽）", () => {
    expect(STEALTH_INJECTION_SCRIPT).toContain('"languages"');
  });

  it("含 window.chrome（Chrome impersonation）", () => {
    expect(STEALTH_INJECTION_SCRIPT).toContain("window.chrome");
  });
});

// ============================================================
// CLOUDFLARE_DETECTION
// ============================================================
describe("CLOUDFLARE_DETECTION — marker 检测（parse5 §3.3.1）", () => {
  it("CLOUDFLARE_CHALLENGE_MARKERS 含 'Just a moment'（CF 经典 challenge）", () => {
    expect(CLOUDFLARE_CHALLENGE_MARKERS.includes("Just a moment")).toBe(true);
    expect(CLOUDFLARE_CHALLENGE_MARKERS.length).toBeGreaterThanOrEqual(3);
  });

  it("CLOUDFLARE_DETECTION_SCRIPT 是字符串 + 含 markers JSON 字面量", () => {
    expect(typeof CLOUDFLARE_DETECTION_SCRIPT).toBe("string");
    // markers 数组经 JSON.stringify 嵌入脚本
    for (const marker of CLOUDFLARE_CHALLENGE_MARKERS) {
      expect(CLOUDFLARE_DETECTION_SCRIPT).toContain(marker);
    }
  });

  it("CLOUDFLARE_DETECTION_SCRIPT 返 'true' 或 'false'（兼容 ExpectPoll 契约）", () => {
    // 静态校验：脚本含 return "true" / return "false"
    expect(CLOUDFLARE_DETECTION_SCRIPT).toContain('return "true"');
    expect(CLOUDFLARE_DETECTION_SCRIPT).toContain('return "false"');
  });

  it("CLOUDFLARE_DETECTION_REGEX 匹配所有 markers（兜底正则）", () => {
    for (const marker of CLOUDFLARE_CHALLENGE_MARKERS) {
      expect(CLOUDFLARE_DETECTION_REGEX.test(marker)).toBe(true);
    }
  });

  it("CLOUDFLARE_DETECTION_REGEX 匹配含 marker 的合成文本", () => {
    expect(CLOUDFLARE_DETECTION_REGEX.test("Please wait — Just a moment...")).toBe(true);
    expect(CLOUDFLARE_DETECTION_REGEX.test("Checking your browser before access")).toBe(true);
  });

  it("CLOUDFLARE_DETECTION_REGEX 不匹配无关文本", () => {
    expect(CLOUDFLARE_DETECTION_REGEX.test("Welcome to example.com")).toBe(false);
    expect(CLOUDFLARE_DETECTION_REGEX.test("Hello world")).toBe(false);
  });
});

// ============================================================
// INV-30 anti-gaming 断言
// ============================================================
describe("INV-30 anti-gaming — stealth-profiles.ts 顶级 const 红线", () => {
  it("代码本体禁出现 process.env（防 LLM 通过 channel 改 env 绕过）", () => {
    // 简单粗暴 grep：整文件禁出现 process.env（含注释，因为 anti-gaming 红线 0 容忍）
    expect(SRC).not.toMatch(/process\.env/);
  });

  it("不 import config / provider-registry / env-reader（顶级 const 无运行时配置依赖）", () => {
    expect(SRC).not.toMatch(/from\s+["'][^"']*(config\/|provider-registry|env-reader|env-config)/);
  });

  it("STEALTH_PROFILES 是 export const（不是 function / class）", () => {
    expect(SRC).toMatch(/export\s+const\s+STEALTH_PROFILES\b/);
  });

  it("STEALTH_INJECTION_SCRIPT 是 export const（顶级 const payload）", () => {
    expect(SRC).toMatch(/export\s+const\s+STEALTH_INJECTION_SCRIPT\b/);
  });

  it("CLOUDFLARE_DETECTION_SCRIPT 是 export const", () => {
    expect(SRC).toMatch(/export\s+const\s+CLOUDFLARE_DETECTION_SCRIPT\b/);
  });
});
