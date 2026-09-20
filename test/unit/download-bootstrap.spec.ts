/**
 * download-bootstrap.spec.ts（doc/bugs/12 D10——检测/引导）
 *
 * 不做真网络（bootstrapYtDlp 的 GitHub 拉取留给 lazy 首用时——本 spec 只锁
 * 检测序/版本探测/手动提示/占位 SHA 语义）。aria2 真机存在则断言版本面，
 * 缺失则 skip（describeOrSkip 先例）。
 */
import { describe, it, expect } from "vitest";
import {
  detectAria2,
  detectYtDlp,
  bootstrapAria2,
  manualYtDlpHint,
  YT_DLP_MACOS_SHA256_PIN,
  YT_DLP_MACOS_PINNED_TAG,
} from "../../src/download/engines/bootstrap.js";
import { resolveExecutable } from "../../src/download/engines/spawn.js";
import { existsSync } from "node:fs";

describe("resolveExecutable", () => {
  it("裸命令沿 PATH 解析（node 必在）", () => {
    expect(resolveExecutable("node")).not.toBeNull();
  });
  it("绝对路径直验", () => {
    expect(resolveExecutable(process.execPath)).toBe(process.execPath);
  });
  it("缺失命令 → null", () => {
    expect(resolveExecutable("definitely-not-a-real-bin-xyz", { PATH: "/nonexistent" })).toBeNull();
  });
});

describe("detectAria2", () => {
  it("本机 brew aria2 命中 PATH + 版本号（缺失 skip）", () => {
    const r = detectAria2();
    if (!r.path) return; // skip-if-missing
    expect(r.source).toBe("path");
    expect(existsSync(r.path)).toBe(true);
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("PATH 无且 bin 无 → null（隔离 env）", () => {
    const tmpHome = { PATH: "/nonexistent", LASSO_BIN_DIR: "/nonexistent-bin" };
    expect(detectAria2(tmpHome).path).toBeNull();
  });
});

describe("detectYtDlp / 引导提示面", () => {
  it("全缺 → null", () => {
    expect(detectYtDlp({ LASSO_YTDLP_PATH: "", LASSO_BIN_DIR: "/nonexistent-bin", PATH: "/nonexistent" }).path).toBeNull();
  });
  it("manualYtDlpHint 含 curl 命令 + bin 目录（agent 一条命令自救）", () => {
    const hint = manualYtDlpHint({ LASSO_BIN_DIR: "/tmp/lasso-bin", PATH: "" });
    expect(hint).toContain("curl -L");
    expect(hint).toContain("/tmp/lasso-bin/yt-dlp_macos");
    expect(hint).toContain("chmod 755");
  });
  it("SHA pin 占位在位（主循环收尾替换锚——防静默丢失）", () => {
    // pin 落定（2026-09-20）：SHA 与 tag 成对锁死——升级须双改（防单改漂移）
    expect(YT_DLP_MACOS_SHA256_PIN).toBe(
      "0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202",
    );
    expect(YT_DLP_MACOS_PINNED_TAG).toBe("2026.08.19");
  });
  it("bootstrapAria2 = 结构化手动提示（v1 不自动拉）", () => {
    const r = bootstrapAria2();
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/brew install aria2|conda/i);
  });
});
