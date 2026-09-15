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
  // PERF-5（2026-09-02 perf/acc 轮 2）：MCP 握手预算真子进程测（真 spawn node
  // + 超时等待 + 树杀轮询，>5s 窗口）
  "test/unit/mcp-client-handshake.spec.ts",
  // doctor 冷启动 / 多 section 探测 + expect 轮询窗口（任务点名）
  "test/unit/doctor-v17-integration.spec.ts",
  "test/unit/expect-poll.spec.ts",
  // round2 W-3 顺手移桶：doctor proxy_config 用例全量并发下 5169ms 超 5s 默认
  // testTimeout、单文件 1648ms 通过（round2-arch 两次全量 + 两次单跑实测）
  "test/unit/proxy-egress.spec.ts",
  // v1.19（渲染档设计决议 §8.1b）：render-guardian 进程级集成（真 spawn dist
  // index.js + >1s 存活观察窗 + 自退等待——r2 否定反查的唯一真闸门）
  "test/integration/render-guardian-process.spec.ts",
  // BUG-08 F（2026-09-15 vitest 孤儿进程治理）：真实 spawn 嵌套 vitest + 杀主 +
  // 树追杀验证（真机复刻用户事故形态，>5s 窗口）
  "test/unit/vitest-orphan-governance.spec.ts",
];

/**
 * 🔴 BUG-08 F（2026-09-15）：pool 显式钉死 "threads"（两 project 同钉）——
 * vitest 孤儿进程治理的结构层。
 *
 * 白盒实证（vitest 2.1.9 dist/config.js:99 `pool: "forks"`——CLI help 的
 * "default: threads" 是误导文案，resolver 实际缺省 forks）：
 *  - forks 池：worker = 独立子进程。主进程被 SIGKILL（agent 中断/门禁被杀）时，
 *    **忙 worker 存活自旋**——用户机器实锤孤儿群把负载打到 188（单 worker 87% CPU）。
 *    真机复刻：SIGKILL(vitest main) 后正在跑 120s sleep 的 worker 原样存活。
 *  - threads 池：worker = 主进程内 worker_thread（probe 实测 worker pid == main
 *    pid）。主进程死 = 线程随之死——孤儿 worker 类**结构性消灭**。运行期唯一子
 *    进程是瞬时 esbuild service（stdin 连主进程，主死自退——两池同型，非孤儿源）。
 * 隔离语义：threads + isolate:true（缺省）= 每测试文件新 worker 线程；
 * worker 线程 process.env 是独立副本（Node 缺省非 SHARE_ENV）——逐文件 env
 * 隔离与 forks 等价。兼容性全量验证 = gate 全绿（BUG-08 F 实施批实测）。
 * 守卫锚：test/unit/vitest-orphan-governance.spec.ts 钉本常量（回退 forks 即红）。
 */
const ORPHAN_GUARD_POOL = "threads" as const;

export default defineWorkspace([
  {
    test: {
      name: "default",
      pool: ORPHAN_GUARD_POOL,
      include: ["test/**/*.spec.ts", "test/**/*.test.ts"],
      exclude: ["node_modules/**", "dist/**", ...SLOW_SPECS],
    },
  },
  {
    test: {
      name: "timing-sensitive",
      pool: ORPHAN_GUARD_POOL,
      include: SLOW_SPECS,
      // 🔴 30s（2026-09-09 二次上调 15→30）：gate 串行 build 后 + 全量并发形态下
      // doctor-deep-probe 的 runDoctor{deep:true} 全 check 链可超 15s（实锤 1 failed
      // 假红，mock fetch 零真出网——纯等待预算不足）。池成员全为真 spawn/重探测型，
      // 30s 不掩盖死挂（死挂语义远超 30s）；CI 余量充足（当前 1-2min/门）。
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  },
]);
