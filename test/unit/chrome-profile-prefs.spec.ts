/**
 * chrome-profile-prefs.spec（R1，2026-10-26 需求单——doc/提案-需求单R1-R4裁定与R1实施 v2 Task 1）
 *
 * 覆盖六路径（提案 Task 1 Step 1）：
 *  1. localePrefValues：规范 tag 推导（验收字符串逐字节锚）/ 大小写规范化（审查 A-6）/
 *     无区域子 tag 形态 / 非法 tag（含 zh_CN 下划线误配形态——审查 C-2 场景）
 *  2. writeProfileLocalePrefs：新建（mkdir Default + 原子写）/ 合并保形 /
 *     覆盖既有 en-US 值（需求方第一真实路径——审查 A-2）/ 不可解析不覆盖 /
 *     写失败不抛（best-effort 契约）
 *
 * 测试形态：tmpdir 真 fs（审查 D-F4：不引 fs 函数注入——全仓无先例，
 * config-file.spec.ts 同款真文件形态；不引第二套注入风格守 R-CI-02）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  localePrefValues,
  writeProfileLocalePrefs,
} from "../../src/launcher/chrome-profile-prefs.js";

let base: string;
beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), "lasso-prefs-"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("localePrefValues", () => {
  it("zh-CN → zh-CN,zh;q=0.9 + zh-CN（与需求验收字符串逐字节一致）", () => {
    expect(localePrefValues("zh-CN")).toEqual({
      acceptLanguages: "zh-CN,zh;q=0.9",
      selectedLanguages: "zh-CN",
    });
  });

  it("大小写规范化：zh-cn → zh-CN（真实 Chrome 永远规范大小写——非规范形态即指纹异型）", () => {
    expect(localePrefValues("zh-cn")).toEqual({
      acceptLanguages: "zh-CN,zh;q=0.9",
      selectedLanguages: "zh-CN",
    });
  });

  it("无区域子 tag：en → en;q=0.9（文档推荐区域限定 tag，此为兜底形态）", () => {
    expect(localePrefValues("en")).toEqual({
      acceptLanguages: "en;q=0.9",
      selectedLanguages: "en",
    });
  });

  it("非法 tag → null（空 / zh_CN 下划线误配 / 路径字符 / 超长 / 悬挂分隔符）", () => {
    for (const bad of ["", "zh_CN", "../etc", "a".repeat(40), "-zh", "zh-"]) {
      expect(localePrefValues(bad)).toBeNull();
    }
  });
});

describe("writeProfileLocalePrefs（tmpdir 真 fs）", () => {
  it("新 profile：建 Default/Preferences 并写入 intl 两键", () => {
    const dir = path.join(base, "fresh");
    const r = writeProfileLocalePrefs(dir, localePrefValues("zh-CN")!);
    expect(r).toEqual({ ok: true });
    const prefs = JSON.parse(
      readFileSync(path.join(dir, "Default", "Preferences"), "utf8"),
    );
    expect(prefs.intl).toEqual({
      accept_languages: "zh-CN,zh;q=0.9",
      selected_languages: "zh-CN",
    });
  });

  it("既有 Preferences：读-改-写保其余键原样", () => {
    const dir = path.join(base, "merge");
    mkdirSync(path.join(dir, "Default"), { recursive: true });
    writeFileSync(
      path.join(dir, "Default", "Preferences"),
      JSON.stringify({ intl: { other_setting: 1 }, browser: { x: 1 } }),
      "utf8",
    );
    const r = writeProfileLocalePrefs(dir, localePrefValues("zh-CN")!);
    expect(r).toEqual({ ok: true });
    const prefs = JSON.parse(
      readFileSync(path.join(dir, "Default", "Preferences"), "utf8"),
    );
    // intl 既有子键保留 + 两键写入
    expect(prefs.intl).toEqual({
      other_setting: 1,
      accept_languages: "zh-CN,zh;q=0.9",
      selected_languages: "zh-CN",
    });
    // 顶层其余键原样
    expect(prefs.browser).toEqual({ x: 1 });
  });

  it("覆盖既有 en-US 值（需求方第一真实路径：存量 profile 已是 en-US）", () => {
    const dir = path.join(base, "overwrite");
    mkdirSync(path.join(dir, "Default"), { recursive: true });
    writeFileSync(
      path.join(dir, "Default", "Preferences"),
      JSON.stringify({
        intl: { accept_languages: "en-US,en;q=0.9", selected_languages: "en-US" },
      }),
      "utf8",
    );
    writeProfileLocalePrefs(dir, localePrefValues("zh-CN")!);
    const prefs = JSON.parse(
      readFileSync(path.join(dir, "Default", "Preferences"), "utf8"),
    );
    expect(prefs.intl.accept_languages).toBe("zh-CN,zh;q=0.9");
    expect(prefs.intl.selected_languages).toBe("zh-CN");
  });

  it("Preferences 非法 JSON → ok:false prefs_unparsable 且不覆盖原文件", () => {
    const dir = path.join(base, "corrupt");
    mkdirSync(path.join(dir, "Default"), { recursive: true });
    const file = path.join(dir, "Default", "Preferences");
    writeFileSync(file, "{not json", "utf8");
    const r = writeProfileLocalePrefs(dir, localePrefValues("zh-CN")!);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("prefs_unparsable") });
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("写失败（父路径是文件，mkdir/write 均 ENOTDIR）→ ok:false 不抛出", () => {
    const blocker = path.join(base, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const r = writeProfileLocalePrefs(
      path.join(blocker, "nested"),
      localePrefValues("zh-CN")!,
    );
    expect(r.ok).toBe(false);
  });
});
