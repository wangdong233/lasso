/**
 * download-bootstrap.spec.ts（doc/bugs/12 D10——检测/引导）
 *
 * 不做真网络（bootstrapYtDlp 的 GitHub 拉取留给 lazy 首用时——本 spec 只锁
 * 检测序/版本探测/手动提示/占位 SHA 语义）。aria2 真机存在则断言版本面，
 * 缺失则 skip（describeOrSkip 先例）。
 */
import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  it("裸命令沿 PATH 解析（node 必在）", async () => {
    expect(resolveExecutable("node")).not.toBeNull();
  });
  it("绝对路径直验", async () => {
    expect(resolveExecutable(process.execPath)).toBe(process.execPath);
  });
  it("缺失命令 → null", async () => {
    expect(resolveExecutable("definitely-not-a-real-bin-xyz", { PATH: "/nonexistent" })).toBeNull();
  });
});

describe("detectAria2", () => {
  it("本机 brew aria2 命中 PATH + 版本号（缺失 skip）", async () => {
    const r = await detectAria2();
    if (!r.path) return; // skip-if-missing
    expect(r.source).toBe("path");
    expect(existsSync(r.path)).toBe(true);
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("PATH 无且 bin 无 → null（隔离 env）", async () => {
    const tmpHome = { PATH: "/nonexistent", LASSO_BIN_DIR: "/nonexistent-bin" };
    expect((await detectAria2(tmpHome)).path).toBeNull();
  });
});

describe("detectYtDlp / 引导提示面", () => {
  it("全缺 → null", async () => {
    expect((await detectYtDlp({ LASSO_YTDLP_PATH: "", LASSO_BIN_DIR: "/nonexistent-bin", PATH: "/nonexistent" })).path).toBeNull();
  });
  it("manualYtDlpHint 含 curl 命令 + bin 目录（agent 一条命令自救）", async () => {
    const hint = manualYtDlpHint({ LASSO_BIN_DIR: "/tmp/lasso-bin", PATH: "" });
    expect(hint).toContain("curl -L");
    expect(hint).toContain("/tmp/lasso-bin/yt-dlp_macos");
    expect(hint).toContain("chmod 755");
  });
  it("SHA pin 占位在位（主循环收尾替换锚——防静默丢失）", async () => {
    // pin 落定（2026-09-20）：SHA 与 tag 成对锁死——升级须双改（防单改漂移）
    expect(YT_DLP_MACOS_SHA256_PIN).toBe(
      "0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202",
    );
    expect(YT_DLP_MACOS_PINNED_TAG).toBe("2026.08.19");
  });
  it("bootstrapAria2 = 结构化手动提示（v1 不自动拉）", async () => {
    const r = bootstrapAria2();
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/brew install aria2|conda/i);
  });
});

// ============================================================
// probeVersion 每进程记忆化（2026-10-26 doctor-v10 预存超时根因修复）
// 根因链：慢启动二进制（如 quarantine/zipapp 病变的 yt-dlp_macos）探针 timeout
// 5s 打满 × 每次调用重付 → runDoctor 无网络路径 ~5.2s → spec 17 次全量 doctor
// 逐个付 5s → 4 用例越 vitest 默认 5s。记忆化 = 同一 bin 每进程只探一次。
// ============================================================
describe("probeVersion 记忆化", () => {
  it("同一 bin 路径重复 detect 只 spawn 一次（计数脚本实证），失败结果同样缓存", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lasso-probe-memo-"));
    try {
      const bin = path.join(dir, "fake-versioned-bin");
      const counter = path.join(dir, "counter");
      // 计数脚本：每次被 exec 计数 +1（shell 内自目录写文件）
      await fsp.writeFile(
        bin,
        ["#!/bin/sh", `n=$(cat ${counter} 2>/dev/null || echo 0)`, `echo $((n+1)) > ${counter}`, 'echo "fake 9.9.9"', ""].join("\n"),
        { mode: 0o755 },
      );
      const env = { LASSO_YTDLP_PATH: bin, PATH: "/nonexistent" };
      // 并发形态（审查 B2-🔵5）：Promise 缓存的存在理由 = 并发首探共享同一
      // in-flight promise（cache stampede 去重）——顺序形态测不出该语义
      const [r1, r2] = await Promise.all([detectYtDlp(env), detectYtDlp(env)]);
      expect(r1.version).toBe("9.9.9");
      expect(r2.version).toBe("9.9.9");
      expect(r2.path).toBe(bin);
      // 记忆化断言：两次 detect 只真正 spawn 了一次
      expect((await fsp.readFile(counter, "utf8")).trim()).toBe("1");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
