/**
 * Vitest workspace 配置（v1.8 Phase E / F-T1 flaky timeout 治理）
 *
 * 背景：wave1 前后多次全量跑测中，时序敏感 spec（真实 spawn 子进程 / doctor 冷启动 /
 * expect 轮询窗口）在机器高负载（Docker VM / CC 会话并发）下偶发超 vitest 默认
 * 5s testTimeout → flaky 红。参考 media-gen-mcp 同款修复（MP4 probe 5s→15s）：
 * 给这类文件单独提 testTimeout，其余文件保持默认 5s（不掩盖真正的死挂）。
 *
 * 注意：两个 project 的 include/exclude 严格互斥——同一文件匹配两个 project 会被
 * 跑两遍（计数翻倍），SLOW_SPECS 必须同时在 default project 的 exclude 里。
 */
import { defineWorkspace } from "vitest/config";

/** 时序敏感 / 真实 spawn 子进程的 spec（testTimeout 15s + hookTimeout 15s）。 */
const SLOW_SPECS = [
  // 真实 spawn 子进程（node dist / rust-helper / Chrome 探测）
  "test/integration/cli-conventions.spec.ts",
  "test/unit/doctor-deep-probe.spec.ts",
  "test/integration/doctor-cli-config-file.spec.ts",
  "test/integration/stdin-eof-shutdown.spec.ts",
  "test/unit/launch-chrome.spec.ts",
  "test/unit/rust-bridge.spec.ts",
  "test/unit/subprocess-lifecycle.spec.ts",
  // doctor 冷启动 / 多 section 探测 + expect 轮询窗口（任务点名）
  "test/unit/doctor-v17-integration.spec.ts",
  "test/unit/expect-poll.spec.ts",
  // round2 W-3 顺手移桶：doctor proxy_config 用例全量并发下 5169ms 超 5s 默认
  // testTimeout、单文件 1648ms 通过（round2-arch 两次全量 + 两次单跑实测）
  "test/unit/proxy-egress.spec.ts",
];

export default defineWorkspace([
  {
    test: {
      name: "default",
      include: ["test/**/*.spec.ts", "test/**/*.test.ts"],
      exclude: ["node_modules/**", "dist/**", ...SLOW_SPECS],
    },
  },
  {
    test: {
      name: "timing-sensitive",
      include: SLOW_SPECS,
      testTimeout: 15_000,
      hookTimeout: 15_000,
    },
  },
]);
