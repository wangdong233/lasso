/**
 * doctor-v10-phase-cd.spec.ts（parse11 §3.4 + §7.2 Phase C/D v1.0 doctor #31/#32）
 *
 * 守护 v1.0 Phase C/D 新增的 doctor check：
 *  #31 platform_backend_active —— AxBackendFactory.detectKind() 返 mac/win_uia/linux_atspi 之一
 *                          + INV-60 单一真源落地（doctor 不 new backend）
 *  #32 recording_baseline_count —— fixtures/serp-baseline/ 录制数（≥10 pass；0 warn；
 *                          中间 pass with detail；INV-62 grep 守 doctor 不读 .html 内容）
 *
 * macOS-only 现实红线（parse11 §1.3）：本机 macOS-only，
 * #31 本机报 platform=darwin, backend=mac（pass）；Windows/Linux 路径由 CI matrix 验。
 *
 * 测试策略（守 R-CI-02）：
 *  - 默认 runDoctor 调用：验 #31 / #32 都出现在 checks 数组 + status 合理
 *  - recordingBaselineDir 注入：用 tmpdir 控制 fixture 数（0 / 5 / 15）验 warn/pass 分级
 *  - 不验其他 30 项 check（已在既有 doctor.spec.ts 覆盖）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { runDoctor, LASSO_VERSION } from "../../src/doctor/doctor.js";

// ============================================================
// helpers
// ============================================================
async function makeFixturesDir(
  htmlCounts: Record<string, number>,
): Promise<string> {
  const base = path.join(
    tmpdir(),
    `lasso-doctor-v10-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  for (const [engine, n] of Object.entries(htmlCounts)) {
    const dir = path.join(base, engine);
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      await fs.writeFile(
        path.join(dir, `fixture-${i}.html`),
        `<html>mock ${engine} ${i}</html>`,
      );
    }
  }
  return base;
}

// ============================================================
// #31 platform_backend_active
// ============================================================
describe("doctor #31 platform_backend_active", () => {
  it("check 出现在 runDoctor 报告里", async () => {
    const report = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
    });
    const check = report.checks.find(
      (c) => c.name === "platform_backend_active",
    );
    expect(check).toBeDefined();
  });

  it("macOS 本机：status=pass + detail 含 platform=darwin + backend=mac", async () => {
    const report = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
    });
    const check = report.checks.find(
      (c) => c.name === "platform_backend_active",
    );
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("platform=darwin");
    expect(check?.detail).toContain("backend=mac");
    expect(check?.detail).toContain("INV-60");
  });

  it("INV-60 衍生：check status='pass' 不阻塞 ready（doctor 永不因 platform_backend_active fail）", async () => {
    const report = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
    });
    const check = report.checks.find(
      (c) => c.name === "platform_backend_active",
    );
    // macOS 必 pass；其他平台即便 fail 也是 architecture 问题（应阻塞 ready），
    // 但 macOS 本机测不到 fail 路径（detectKind 不抛 unsupported_platform）
    expect(check?.status).not.toBe("fail");
  });
});

// ============================================================
// #32 recording_baseline_count
// ============================================================
describe("doctor #32 recording_baseline_count", () => {
  it("check 出现在 runDoctor 报告里", async () => {
    const report = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
    });
    const check = report.checks.find(
      (c) => c.name === "recording_baseline_count",
    );
    expect(check).toBeDefined();
  });

  it("0 条 fixture（目录不存在）→ status=warn + detail 含 0", async () => {
    const report = await runDoctor({
      skipNetwork: true,
      skipInvariants: true,
      recordingBaselineDir: "/tmp/lasso-doctor-v10-nonexistent-xyz",
    });
    const check = report.checks.find(
      (c) => c.name === "recording_baseline_count",
    );
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("0");
  });

  it("0 条 fixture（空目录）→ status=warn", async () => {
    const emptyDir = await makeFixturesDir({});
    try {
      const report = await runDoctor({
        skipNetwork: true,
        skipInvariants: true,
        recordingBaselineDir: emptyDir,
      });
      const check = report.checks.find(
        (c) => c.name === "recording_baseline_count",
      );
      expect(check?.status).toBe("warn");
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("1-9 条 fixture → status=pass with detail（首次基线未完；不 fail）", async () => {
    const dir = await makeFixturesDir({ baidu: 3, google: 2, bing: 1 });
    try {
      const report = await runDoctor({
        skipNetwork: true,
        skipInvariants: true,
        recordingBaselineDir: dir,
      });
      const check = report.checks.find(
        (c) => c.name === "recording_baseline_count",
      );
      expect(check?.status).toBe("pass");
      expect(check?.detail).toContain("6"); // total = 3+2+1 = 6
      expect(check?.detail).toContain("baidu=3");
      expect(check?.detail).toContain("google=2");
      expect(check?.detail).toContain("bing=1");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("≥10 条 fixture → status=pass（基线充足）", async () => {
    const dir = await makeFixturesDir({
      baidu: 5,
      google: 5,
      bing: 5,
    });
    try {
      const report = await runDoctor({
        skipNetwork: true,
        skipInvariants: true,
        recordingBaselineDir: dir,
      });
      const check = report.checks.find(
        (c) => c.name === "recording_baseline_count",
      );
      expect(check?.status).toBe("pass");
      expect(check?.detail).toContain("15");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("INV-62 衍生：detail 不读 .html 内容（不出现 fixture 内文本 'mock baidu 0'）", async () => {
    const dir = await makeFixturesDir({ baidu: 2 });
    try {
      const report = await runDoctor({
        skipNetwork: true,
        skipInvariants: true,
        recordingBaselineDir: dir,
      });
      const check = report.checks.find(
        (c) => c.name === "recording_baseline_count",
      );
      // detail 只报数字 + engine breakdown；不应含 fixture 内容
      expect(check?.detail).not.toContain("mock");
      expect(check?.detail).not.toContain("baidu 0"); // fixture 内 mock 文本
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// INV-63 镜像：LASSO_VERSION 常量与 package.json 一致
// ============================================================
describe("doctor INV-63 镜像：LASSO_VERSION 常量", () => {
  it("LASSO_VERSION 已 export（INV-63 grep 守：定义只在 doctor.ts）", () => {
    expect(typeof LASSO_VERSION).toBe("string");
    expect(LASSO_VERSION.length).toBeGreaterThan(0);
  });

  it("LASSO_VERSION 当前值为 1.0.0（v1.0 Phase E 去 -dev）", () => {
    // 守 INV-63：package.json + index.ts LASSO_SERVER_VERSION + doctor.ts LASSO_VERSION 三处一致。
    // 本 spec 只验 doctor.ts 这处；INV-63 grep 守全 3 处对齐。
    expect(LASSO_VERSION).toBe("1.0.0");
  });
});
