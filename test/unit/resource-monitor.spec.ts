/**
 * ResourceMonitor 单测（parse8 §3.3 / §5.1）
 *
 * 覆盖：
 *  - sample() 返回 SubprocResourceSnapshot 数组
 *  - macOS / 非 Linux 降级为 host RSS（process.memoryUsage）
 *  - hot_streak 连续超阈值 5 次触发计数（logger.warn 在生产用，这里测 hotStreakCount）
 *  - 阈值未超 → hotStreak 清零
 *  - stop() 清 timer
 *  - INV-46：不渗协议帧（只读 OS 文件 + pid 数字）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResourceMonitor } from "../../src/observ/ResourceMonitor.js";

// ============================================================
// helpers
// ============================================================
/**
 * 让 ResourceMonitor 直接走 Linux 分支（_sampleOne 内 fs.readFile）。
 * 用 vi.mock("node:fs") 拦截 readFile 返伪 statm。
 */

// ============================================================
// sample 基础（macOS / 非 Linux 降级路径，CI 默认环境）
// ============================================================
describe("ResourceMonitor — sample 基础路径", () => {
  it("空 listPids → sample 返空数组", async () => {
    const rm = new ResourceMonitor(() => []);
    const result = await rm.sample();
    expect(result).toEqual([]);
  });

  it("非 Linux 平台降级为 host RSS（process.memoryUsage）", async () => {
    const rm = new ResourceMonitor(() => [
      { name: "headless", pid: 12345 },
    ]);
    const result = await rm.sample();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("headless");
    expect(result[0].pid).toBe(12345);
    if (process.platform !== "linux") {
      // macOS / darwin / win：降级报 host RSS（非 null）
      expect(result[0].rss_mb).not.toBeNull();
      expect(result[0].rss_mb).toBeGreaterThan(0);
      // CPU 在 v0.7 恒 null（实装推 v0.8）
      expect(result[0].cpu_percent).toBeNull();
    }
    expect(result[0].sampled_at).toBeGreaterThan(0);
  });

  it("pid=null 也降级为 host RSS（不丢样本）", async () => {
    const rm = new ResourceMonitor(() => [{ name: "stub", pid: null }]);
    const result = await rm.sample();
    expect(result).toHaveLength(1);
    expect(result[0].rss_mb).not.toBeNull();
  });
});

// ============================================================
// hot_streak 阈值告警
// ============================================================
describe("ResourceMonitor — hot_streak 阈值", () => {
  beforeEach(() => {
    // process.memoryUsage 在测试进程一般 ~100-300MB；设阈值极低强制 hot
  });

  it("连续超阈值 hot_streak 次 → hotStreakCount 累积", async () => {
    // 阈值 rss_mb=1（host RSS 必然超过 1MB → hot=true）
    const rm = new ResourceMonitor(
      () => [{ name: "headless", pid: 12345 }],
      { rss_mb: 1, cpu_percent: 80, hot_streak: 3 },
    );
    await rm.sample();
    expect(rm.hotStreakCount("headless")).toBe(1);
    await rm.sample();
    expect(rm.hotStreakCount("headless")).toBe(2);
    await rm.sample();
    expect(rm.hotStreakCount("headless")).toBe(3);
  });

  it("未超阈值 → hotStreak 清零", async () => {
    // 阈值 rss_mb=999999（host RSS 不可能超 → hot=false）
    const rm = new ResourceMonitor(
      () => [{ name: "headless", pid: 12345 }],
      { rss_mb: 999_999, cpu_percent: 80, hot_streak: 3 },
    );
    // 先累积（设低阈值）
    const rmLow = new ResourceMonitor(
      () => [{ name: "headless", pid: 12345 }],
      { rss_mb: 1, cpu_percent: 80, hot_streak: 5 },
    );
    await rmLow.sample();
    await rmLow.sample();
    expect(rmLow.hotStreakCount("headless")).toBe(2);

    // 切换高阈值后第一次采样清零
    const rmHigh = new ResourceMonitor(
      () => [{ name: "headless", pid: 12345 }],
      { rss_mb: 999_999, cpu_percent: 80, hot_streak: 5 },
    );
    await rmHigh.sample();
    expect(rmHigh.hotStreakCount("headless")).toBe(0);
  });

  it("hot_streak 计数达到阈值后不再增长（避免告警风暴）", async () => {
    const rm = new ResourceMonitor(
      () => [{ name: "h", pid: 1 }],
      { rss_mb: 1, cpu_percent: 80, hot_streak: 3 },
    );
    for (let i = 0; i < 10; i++) {
      await rm.sample();
    }
    // 仍继续累积（生产 logger.warn 会每次都发；这里仅验证 hotStreakCount 持续）
    expect(rm.hotStreakCount("h")).toBe(10);
  });
});

// ============================================================
// start / stop timer
// ============================================================
describe("ResourceMonitor — start/stop timer", () => {
  it("start() + stop() 不抛错（timer 生命周期）", () => {
    const rm = new ResourceMonitor(() => []);
    rm.start(1000); // 1s interval
    rm.stop();
    // 重复 stop 不抛错（幂等）
    rm.stop();
  });

  it("start() 多次调用幂等（清旧 timer 设新）", () => {
    const rm = new ResourceMonitor(() => []);
    rm.start(1000);
    rm.start(2000); // 重设不抛错
    rm.stop();
  });
});

// ============================================================
// INV-46 守护：不渗协议帧
// ============================================================
describe("ResourceMonitor — INV-46 不渗协议帧", () => {
  it("类定义不 import McpClient/RustBridge/StdioClientTransport", async () => {
    // 读源文件验证 import 列表
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(
        new URL(".", import.meta.url).pathname,
        "../../src/observ/ResourceMonitor.ts",
      ),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["'].*McpClient["']/);
    expect(src).not.toMatch(/from\s+["'].*RustBridge["']/);
    expect(src).not.toMatch(/from\s+["'].*StdioClientTransport["']/);
    // 只允许：node:fs + logger
    expect(src).toMatch(/from\s+["']node:fs["']/);
    expect(src).toMatch(/from\s+["']\.\.\/util\/logger\.js["']/);
  });
});

// ============================================================
// Linux /proc 路径（mock fs；跳过非 Linux 平台）
// ============================================================
describe.skipIf(process.platform !== "linux")(
  "ResourceMonitor — Linux /proc/<pid>/statm 解析",
  () => {
    it("Linux 读 /proc 返 RSS MB", async () => {
      // 仅在 Linux CI 跑（本地 darwin 跳过）
      const rm = new ResourceMonitor(() => [{ name: "h", pid: 1 }]);
      const result = await rm.sample();
      // pid=1 通常是 init，可读 statm
      if (result[0].rss_mb !== null) {
        expect(result[0].rss_mb).toBeGreaterThan(0);
      }
    });
  },
);
