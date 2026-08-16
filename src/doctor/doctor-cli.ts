/**
 * doctor CLI 参数解析 + stealth-check provider 装配（v1.8 Phase D，D11 修复）
 *
 * 背景（wave1 T-CLI-05 + D11）：README 承诺 `lasso doctor --stealth-check` 会实跑
 * creepjs 回归门禁，但 v1.7 main() 完全忽略该 flag —— #38 两模式恒 warn-skip。
 *
 * 为什么独立成本模块（不在 index.ts 内联）：
 *  1. index.ts 顶层就跑 main()，测试进程无法 import 它；独立模块让 flag 解析 +
 *     provider 装配可单测（mock headless 句柄注入，不真 spawn chrome-devtools-mcp）。
 *  2. doctor.ts:435 注释承诺「stealthCheckClientProvider 仅出现在 doctor/」（grep 守），
 *     provider 的构造留在 src/doctor/ 下满足该边界。
 *
 * 守 INV-75：本模块不 import probeCreepjs（探测只在 doctor.ts checkStealthCreepjsRegression
 * 内发生）；只负责提供「已连 chrome-devtools-mcp --headless --isolated 的 McpClient」。
 */
import type { DoctorOptions } from "./doctor.js";
import type { McpClient } from "../subprocess/McpClient.js";
import { SubprocessManager } from "../subprocess/SubprocessManager.js";
import {
  HeadlessChannel,
  defaultHeadlessProfileForHost,
} from "../channels/HeadlessChannel.js";
import { StealthEngine } from "../browse/StealthEngine.js";
import { logger } from "../util/logger.js";

// ============================================================
// headless client 句柄（DI 便于单测）
// ============================================================
/**
 * headless McpClient 句柄：ensureRunning 懒启动（与 HeadlessChannel.getMcpClient
 * 同款契约 —— subproc.ensureRunning("headless")）；shutdown 清理子进程。
 */
export interface HeadlessClientHandle {
  ensureRunning(): Promise<McpClient>;
  shutdown(): Promise<void>;
}

/** 默认实现：真 SubprocessManager + HeadlessChannel（构造器注册 "headless" spec）。 */
function createDefaultHeadlessHandle(): HeadlessClientHandle {
  const subproc = new SubprocessManager();
  // HeadlessChannel 构造器副作用：registerSpec("headless", {npx chrome-devtools-mcp
  // --headless --isolated --disable-blink-features=AutomationControlled})——与运行时
  // browse_headless 通道同一 spawn 形状（v1.5 parse13 §4.3）。
  // v1.12（round2 T2-1）：探测宿主默认 profile（darwin→mac_chrome）——与运行时装配同一选择
  new HeadlessChannel(subproc, new StealthEngine(), defaultHeadlessProfileForHost());
  return {
    ensureRunning: () => subproc.ensureRunning("headless"),
    shutdown: () => subproc.shutdown(),
  };
}

// ============================================================
// buildDoctorCliOptions
// ============================================================
export interface BuildDoctorCliOptionsDeps {
  /** 单测注入 mock 句柄（不真 spawn）；缺省真建 SubprocessManager + HeadlessChannel。 */
  headless?: () => HeadlessClientHandle;
}

export interface DoctorCliOptionsResult {
  /** 合并进 runDoctor 的 opts 片段（stealthCheck / stealthCheckClientProvider）。 */
  doctorOpts: Pick<DoctorOptions, "stealthCheck" | "stealthCheckClientProvider">;
  /** flag 是否出现（供 CLI 层日志 / 测试断言）。 */
  stealthCheck: boolean;
  /** doctor 跑完后清理 stealth-check 专用子进程；未启用时为 null。 */
  shutdown: (() => Promise<void>) | null;
}

/**
 * 解析 doctor 子命令参数（argv = process.argv.slice(3)）。
 *
 *  - 无 --stealth-check → { doctorOpts: {}, stealthCheck: false, shutdown: null }
 *    （零回归：runDoctor 默认 #38 warn-skip，不开浏览器）
 *  - 有 --stealth-check → stealthCheck=true + provider（懒启动 headless
 *    chrome-devtools-mcp；ensureRunning 抛错 → 返 null → #38 warn 不 fail）
 */
export function buildDoctorCliOptions(
  argv: string[],
  deps: BuildDoctorCliOptionsDeps = {},
): DoctorCliOptionsResult {
  const stealthCheck = argv.includes("--stealth-check");
  if (!stealthCheck) {
    return { doctorOpts: {}, stealthCheck: false, shutdown: null };
  }
  const handle = deps.headless
    ? deps.headless()
    : createDefaultHeadlessHandle();
  return {
    doctorOpts: {
      stealthCheck: true,
      // provider 契约（doctor.ts #38）：返 null → warn；抛错 → warn；返 client → 实跑。
      // 这里把 spawn 失败吞成 null（懒启动失败是环境问题，非 Lasso 回归 → warn 语义）。
      stealthCheckClientProvider: async () => {
        try {
          return await handle.ensureRunning();
        } catch (e) {
          logger.warn({
            evt: "stealth_check_headless_spawn_failed",
            error: String(e),
          });
          return null;
        }
      },
    },
    stealthCheck: true,
    shutdown: () => handle.shutdown(),
  };
}
