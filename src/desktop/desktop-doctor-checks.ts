/**
 * desktop-doctor-checks（parse4 §3.4 + 13 §3.4 M0.5a 验收 #5/#6）
 *
 * 6 项 desktop readiness check（doctor.ts #15-#20）：
 *   15. rust_helper_signed           — codesign -dvvv 验证 Developer ID 签名
 *   16. rust_helper_running          — ping 调用，3s 超时
 *   17. tcc_accessibility            — 调 rust.call("tcc_status") 读 accessibility 字段
 *   18. tcc_screen_recording         — 同上读 screen_recording 字段
 *   19. ax_read_rate                 — snapshot maxDepth=3，节点数 ≥1 → pass（M0.5a 改 ≥20）
 *   20. vlm_endpoint_reachable       — 若 LASSO_VLM_ENDPOINT 配了，HEAD 探测；未配 → warn
 *
 * 设计（02 简单性铁律 + 不缠绕）：
 *  - 本模块只产 DoctorCheck[]；不持有状态、不注册 tool、不开第二套 doctor
 *  - runRustDoctorChecks 接收一个 RustBridgeLike 接口（只 call 方法）——
 *    doctor CLI 路径可能没装配 RustBridge（无 DesktopChannel），这时返 6 项 warn
 *    skip；desktop tool 路径装配 DesktopChannel 时传入真 bridge，跑 6 项。
 *  - 不耦合 RustBridge 具体类（让 doctor.ts 无需 import DesktopChannel）
 *
 * TCC 引导铁律（parse4 §3.4 + 13 §3.4 M0.5a 第 6 条）：
 *  - tcc_accessibility 未授权时 next_step = "open x-apple.systempreferences:..."
 *  - tcc_screen_recording 未授权时 next_step = "open x-apple.systempreferences:..."
 *    （Screen Recording 面板 URL；macOS 13+ 路径稍异，URL scheme 仍兼容）
 *
 * 借鉴：parse4 §3.4.1；doctor.ts 既有 check 函数风格（无副作用 + 不抛异常 +
 * 错误降级到 fail/warn）；D3 风险缓解（TCC 摩擦靠 doctor 引导）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DoctorCheck } from "../doctor/doctor.js";

const execFileP = promisify(execFile);

// ============================================================
// RustBridgeLike（解耦接口）
// ============================================================
/**
 * 本模块依赖的最小 RustBridge 形状（结构子类型，避免 doctor → DesktopChannel 依赖）。
 *
 * doctor.ts 默认装配路径无 DesktopChannel，故 RustBridgeLike = null；
 * desktop tool / DesktopChannel.doctor 路径会注入真实 RustBridge（满足此形状）。
 */
export interface RustBridgeLike {
  call(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<{
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    error_kind?: string;
  }>;
}

/** Helper binary 默认查找路径（与 parse4 §3.1.7 sign.sh 输出一致）。 */
const DEFAULT_HELPER_PATHS = [
  "./rust-helper/target/release/lasso-rust-helper",
  "../rust-helper/target/release/lasso-rust-helper",
];

/** System Settings URL schemes（parse4 §3.4 M0.5a 第 6 条）。 */
const TCC_URL_ACCESSIBILITY =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const TCC_URL_SCREEN_RECORDING =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/** ax_read_rate 验收阈值：≥此节点数才算 pass（parse4 §3.4 验收 #1；M0.5a 调到 20）。 */
const AX_READ_RATE_MIN_NODES = 1;

// ============================================================
// 主入口：runRustDoctorChecks
// ============================================================
/**
 * 跑 6 项 desktop check（doctor.ts 在 desktopChecks=true 时调）。
 *
 * @param rust       RustBridgeLike 实例；null 时 6 项全 skip warn（不阻塞 ready）
 * @param opts       可选覆盖：helperPath（codesign 检查路径）、vlmEndpoint
 * @returns DoctorCheck[]（6 项，顺序固定 #15-#20）
 */
export async function runRustDoctorChecks(
  rust: RustBridgeLike | null,
  opts: {
    helperPath?: string;
    vlmEndpoint?: string | null;
  } = {},
): Promise<DoctorCheck[]> {
  // 无 bridge = doctor CLI 路径未装配 DesktopChannel → 6 项全 warn skip
  if (!rust) {
    return SKIP_6;
  }

  const vlmEndpoint =
    opts.vlmEndpoint !== undefined
      ? opts.vlmEndpoint
      : (process.env.LASSO_VLM_ENDPOINT ?? null);

  return [
    // 15. rust_helper_signed
    await checkRustHelperSigned(opts.helperPath),
    // 16. rust_helper_running
    await checkRustHelperRunning(rust),
    // 17. tcc_accessibility
    await checkTccAccessibility(rust),
    // 18. tcc_screen_recording
    await checkTccScreenRecording(rust),
    // 19. ax_read_rate
    await checkAxReadRate(rust),
    // 20. vlm_endpoint_reachable
    await checkVlmEndpoint(vlmEndpoint),
  ];
}

// ============================================================
// 6 项 check 实装
// ============================================================

/**
 * 15. rust_helper_signed（parse4 §3.1.7 + 验收 #7）。
 *
 * 用 codesign -dvvv 验证 helper binary 签了 Developer ID Application:。
 *  - 找不到 binary → warn（M0.5a 阶段允许尚未构建；doctor 提示 `cargo build --release`）
 *  - 找到但未签 / ad-hoc 签 → fail（TCC.db 不持久；验收 #7 红）
 *  - 找到且签了 Developer ID → pass，detail 报 Authority
 *
 * INV-21：本 check 只跑 shell `codesign`，不调 AXAPI/CG 平台符号。
 */
async function checkRustHelperSigned(
  helperPath: string | undefined,
): Promise<DoctorCheck> {
  const path = helperPath ?? DEFAULT_HELPER_PATHS[0];
  let stdout: string;
  try {
    const r = await execFileP("codesign", ["-dvvv", path], {
      timeout: 5_000,
    }).catch((e: unknown) => {
      // binary 不存在或 codesign 失败 → warn（M0.5a 允许未构建）
      const msg = e instanceof Error ? e.message : String(e);
      return { stdout: "", stderr: msg };
    });
    stdout = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  } catch (e) {
    return {
      name: "rust_helper_signed",
      status: "warn",
      detail: `codesign 探测失败：${String(e)}`,
      next_step: `cd rust-helper && cargo build --release && ./build/sign.sh`,
    };
  }

  // codesign -dvvv 输出含 "Authority=Developer ID Application: ..." 表示 Developer ID 签
  if (/Authority=Developer ID Application:/i.test(stdout)) {
    const authority = stdout
      .match(/Authority=(Developer ID Application:[^\n]+)/i)?.[1]
      ?.trim();
    return {
      name: "rust_helper_signed",
      status: "pass",
      detail: authority ?? "Developer ID Application signed",
    };
  }
  // ad-hoc 签名（Authority 缺失 / 只 hashes）
  if (/CodeSignature|Identifier=/i.test(stdout)) {
    return {
      name: "rust_helper_signed",
      status: "fail",
      detail: `binary 已签但非 Developer ID（ad-hoc 或遗留）：${path}`,
      next_step: `LASSO_DEV_ID='Developer ID Application: Your Name (TEAMID)' ./rust-helper/build/sign.sh`,
    };
  }
  // codesign 返回但无任何关键字 = binary 不存在或损坏
  return {
    name: "rust_helper_signed",
    status: "warn",
    detail: `binary 可能未构建：${path}`,
    next_step: `cd rust-helper && cargo build --release`,
  };
}

/**
 * 16. rust_helper_running（parse4 §3.5.3 ping + 验收 #5）。
 * 3s 超时调 rust.call("ping")；ok=true → pass；其他 → fail/warn。
 */
async function checkRustHelperRunning(
  rust: RustBridgeLike,
): Promise<DoctorCheck> {
  try {
    const r = await rust.call("ping", {}, 3_000);
    if (r.ok) {
      const version = (r.result as { version?: string } | undefined)?.version;
      return {
        name: "rust_helper_running",
        status: "pass",
        detail: `ping ok; helper v${version ?? "unknown"}`,
      };
    }
    return {
      name: "rust_helper_running",
      status: "fail",
      detail: r.error ?? r.error_kind ?? "ping returned ok=false",
      next_step: "确认 rust-helper 已签 + spawn 成功；查 lasso 日志 rust_proc_spawned",
    };
  } catch (e) {
    return {
      name: "rust_helper_running",
      status: "fail",
      detail: String(e),
      next_step: "rust-helper 子进程不可达；检查 codesign + binary path",
    };
  }
}

/**
 * 17. tcc_accessibility（parse4 §3.4 + 验收 #6）。
 * 调 rust.call("tcc_status") 读 accessibility 字段。
 *  - true  → pass
 *  - false → fail + next_step open x-apple.systempreferences:...Privacy_Accessibility
 */
async function checkTccAccessibility(
  rust: RustBridgeLike,
): Promise<DoctorCheck> {
  try {
    const r = await rust.call("tcc_status", {}, 3_000);
    if (!r.ok) {
      return {
        name: "tcc_accessibility",
        status: "warn",
        detail: r.error ?? r.error_kind ?? "tcc_status returned ok=false",
      };
    }
    const tcc = (r.result ?? {}) as { accessibility?: boolean };
    if (tcc.accessibility === true) {
      return {
        name: "tcc_accessibility",
        status: "pass",
        detail: "Accessibility 已授权",
      };
    }
    return {
      name: "tcc_accessibility",
      status: "fail",
      detail: "Accessibility 未授权（AXAPI 不可用）",
      next_step: `open '${TCC_URL_ACCESSIBILITY}'  # 加入 lasso-rust-helper`,
    };
  } catch (e) {
    return {
      name: "tcc_accessibility",
      status: "warn",
      detail: String(e),
    };
  }
}

/**
 * 18. tcc_screen_recording（parse4 §3.4 + 验收 #5）。
 * 调 rust.call("tcc_status") 读 screen_recording 字段。
 *  - true  → pass
 *  - false → warn（仅 screenshot 路径需要；snapshot/find/act 不依赖）
 */
async function checkTccScreenRecording(
  rust: RustBridgeLike,
): Promise<DoctorCheck> {
  try {
    const r = await rust.call("tcc_status", {}, 3_000);
    if (!r.ok) {
      return {
        name: "tcc_screen_recording",
        status: "warn",
        detail: r.error ?? r.error_kind ?? "tcc_status returned ok=false",
      };
    }
    const tcc = (r.result ?? {}) as { screen_recording?: boolean };
    if (tcc.screen_recording === true) {
      return {
        name: "tcc_screen_recording",
        status: "pass",
        detail: "Screen Recording 已授权",
      };
    }
    return {
      name: "tcc_screen_recording",
      status: "warn", // warn 而非 fail：snapshot/find/act 不依赖此权限
      detail: "Screen Recording 未授权（仅 desktop(action:'screenshot') 需要）",
      next_step: `open '${TCC_URL_SCREEN_RECORDING}'  # 加入 lasso-rust-helper`,
    };
  } catch (e) {
    return {
      name: "tcc_screen_recording",
      status: "warn",
      detail: String(e),
    };
  }
}

/**
 * 19. ax_read_rate（parse4 §3.4 + 验收 #1）。
 * 在 system-wide root 跑 snapshot maxDepth=3，统计节点数。
 *  - ≥20  → pass（M0.5a 正式阈值；v0.3.5 phase C 默认 ≥1 = helper 能响应即过）
 *  - 1-19 → warn（覆盖率抽测前先观察）
 *  - 0 / 错 → fail
 */
async function checkAxReadRate(rust: RustBridgeLike): Promise<DoctorCheck> {
  try {
    const r = await rust.call(
      "ax_snapshot",
      { app: null, max_depth: 3 },
      5_000,
    );
    if (!r.ok) {
      return {
        name: "ax_read_rate",
        status: "fail",
        detail: r.error ?? r.error_kind ?? "ax_snapshot returned ok=false",
        next_step: "授予 Accessibility 后重试；doctor #17 tcc_accessibility",
      };
    }
    const nodeCount = countAxNodes(r.result);
    if (nodeCount >= 20) {
      return {
        name: "ax_read_rate",
        status: "pass",
        detail: `${nodeCount} AX nodes at maxDepth=3 (≥20 → AX read pipeline ok)`,
      };
    }
    if (nodeCount >= AX_READ_RATE_MIN_NODES) {
      return {
        name: "ax_read_rate",
        status: "warn",
        detail: `仅 ${nodeCount} AX nodes at maxDepth=3（M0.5a 阈值 20）`,
        next_step: "打开任一 native app（Finder/Mail）后再调 doctor",
      };
    }
    return {
      name: "ax_read_rate",
      status: "fail",
      detail: `0 AX nodes at maxDepth=3（root 解析失败）`,
      next_step: "检查 rust-helper ax.rs walk + 系统 AX root 元素工厂调用",
    };
  } catch (e) {
    return {
      name: "ax_read_rate",
      status: "fail",
      detail: String(e),
    };
  }
}

/**
 * 20. vlm_endpoint_reachable（parse4 §3.4 + D10 解耦）。
 * LASSO_VLM_ENDPOINT 未配 → warn（screenshotVlm 不可用，不阻塞 ax 主路径）。
 * 配了 → HEAD 探测；2xx/4xx 都算"可达"；网络错 → warn（不 fail，因 vlm 是可选）。
 */
async function checkVlmEndpoint(
  endpoint: string | null,
): Promise<DoctorCheck> {
  if (!endpoint) {
    return {
      name: "vlm_endpoint_reachable",
      status: "warn",
      detail: "LASSO_VLM_ENDPOINT 未配置（screenshotVlm fallback 不可用）",
      next_step:
        "（可选）export LASSO_VLM_ENDPOINT=https://media-gen.example/mcp 启用 canvas 兜底",
    };
  }
  try {
    const resp = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    return {
      name: "vlm_endpoint_reachable",
      status: resp.status < 500 ? "pass" : "warn",
      detail: `HTTP ${resp.status} ${resp.statusText} @ ${endpoint}`,
    };
  } catch (e) {
    return {
      name: "vlm_endpoint_reachable",
      status: "warn",
      detail: String(e),
      next_step: `检查 VLM endpoint 可达：${endpoint}`,
    };
  }
}

// ============================================================
// 辅助
// ============================================================
/**
 * 递归数 AxNode 树节点数（含 root；用于 ax_read_rate）。
 * 容错：result 不是预期 shape 返 0。
 */
function countAxNodes(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  // AxProvider.snapshot 兼容两种 shape：{ root: AxNode } 或 AxNode
  const root =
    (result as { root?: unknown }).root ?? result;
  let count = 0;
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    count++;
    const children = (n as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const c of children) visit(c);
    }
  };
  visit(root);
  return count;
}

/**
 * doctor CLI 路径未装配 DesktopChannel 时的 6 项 skip warn。
 * 不阻塞 ready（warn 不进 blockers）；提示用户用 `desktop(action:"doctor")` 跑完整检查。
 */
const SKIP_6: DoctorCheck[] = [
  {
    name: "rust_helper_signed",
    status: "warn",
    detail: "desktopChecks=false（doctor CLI 默认装配无 DesktopChannel）",
    next_step: "调 desktop(action:'doctor') 取完整 6 项 desktop check",
  },
  {
    name: "rust_helper_running",
    status: "warn",
    detail: "desktopChecks=false（doctor CLI 默认装配无 DesktopChannel）",
  },
  {
    name: "tcc_accessibility",
    status: "warn",
    detail: "desktopChecks=false（doctor CLI 默认装配无 DesktopChannel）",
  },
  {
    name: "tcc_screen_recording",
    status: "warn",
    detail: "desktopChecks=false（doctor CLI 默认装配无 DesktopChannel）",
  },
  {
    name: "ax_read_rate",
    status: "warn",
    detail: "desktopChecks=false（doctor CLI 默认装配无 DesktopChannel）",
  },
  {
    name: "vlm_endpoint_reachable",
    status: "warn",
    detail: "desktopChecks=false（doctor CLI 默认装配无 DesktopChannel）",
  },
];
