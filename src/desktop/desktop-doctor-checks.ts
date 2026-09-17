/**
 * desktop-doctor-checks（parse4 §3.4 + 13 §3.4 M0.5a 验收 #5/#6）
 *
 * 8 项 desktop readiness check（doctor.ts #15-#22；v1.11 T11 加 #21；
 * bugs/10 决议 A.3 加 #22）：
 *   15. rust_helper_signed           — codesign -dvvv 验证 Developer ID 签名
 *   16. rust_helper_running          — ping 调用，3s 超时
 *   17. tcc_accessibility            — 调 rust.call("tcc_status") 读 accessibility 字段
 *   18. tcc_screen_recording         — 同上读 screen_recording 字段
 *   19. ax_read_rate                 — snapshot maxDepth=3，节点数 ≥1 → pass（M0.5a 改 ≥20）
 *   20. vlm_endpoint_reachable       — 若 LASSO_VLM_ENDPOINT 配了，HEAD 探测；未配 → warn
 *   21. tcc_event_synthesizing       — bugs/10 A.4 诚实化（四态 + advisory + 分层 detail）
 *   22. cgevent_delivery_selftest    — bugs/10 A.3 投递自检（opt-in env 门住；wiggle+复位）
 *
 * 设计（02 简单性铁律 + 不缠绕）：
 *  - 本模块只产 DoctorCheck[]；不持有状态、不注册 tool、不开第二套 doctor
 *  - runRustDoctorChecks 接收一个 RustBridgeLike 接口（只 call 方法）——
 *    doctor CLI 路径可能没装配 RustBridge（无 DesktopChannel），这时返 8 项 warn
 *    skip；desktop tool 路径装配 DesktopChannel 时传入真 bridge，跑全项。
 *  - 不耦合 RustBridge 具体类（让 doctor.ts 无需 import DesktopChannel）
 *
 * TCC 引导铁律（parse4 §3.4 + 13 §3.4 M0.5a 第 6 条）：
 *  - tcc_accessibility 未授权时 next_step = "open x-apple.systempreferences:..."
 *  - tcc_screen_recording 未授权时 next_step = "open x-apple.systempreferences:..."
 *    （Screen Recording 面板 URL；macOS 13+ 路径稍异，URL scheme 仍兼容）
 *
 * #22 伦理红线（bugs/10 决议 A.3，D-α 探针副作用实证）：
 *  - 自检会真实移动用户光标 7px 后复位——doctor 可被 agent 触发，故必须
 *    env opt-in（LASSO_DOCTOR_INPUT_SELFTEST=1 = 部署者一次性 consent）；
 *    无 env 时零 cgevent_dispatch 调用（INV-102）。
 *
 * 借鉴：parse4 §3.4.1；doctor.ts 既有 check 函数风格（无副作用 + 不抛异常 +
 * 错误降级到 fail/warn）；D3 风险缓解（TCC 摩擦靠 doctor 引导）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { DoctorCheck } from "../doctor/doctor.js";
// BUG-rust-helper-relative-path §4.2：helper 路径单一真源（spawn 规格 / doctor 探测 /
// 错误提示三处共用同一 resolver——doctor「看得到」与 spawn「起得来」不再脱节）
// A1（对抗复审轮 1）：cargo build 修法按布局条件化——npm 安装包不含 rust-helper/
// 源码，仅 env 覆盖可行，不再给不可执行的修法
import {
  LASSO_RUST_HELPER_ENV,
  hasRustHelperSource,
  resolveRustHelperPath,
} from "../subprocess/rust-helper-path.js";

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

/**
 * Helper binary 探测路径（BUG-rust-helper-relative-path §4.2 单一真源）。
 * 与 spawn 规格（index.ts registerRustSpec）共用 resolveRustHelperPath()——
 * env LASSO_RUST_HELPER_PATH 覆盖 > import.meta.url 绝对默认（与宿主 cwd 解耦）。
 * 此前这里是 `./` + `../` 双相对路径列表，与 spawn 单路径脱节，导致 doctor 在部分
 * cwd「看得到」binary 而 spawn 却 ENOENT 的误导性诊断。
 */
const DEFAULT_HELPER_PATH = () => resolveRustHelperPath().path;

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
 * 跑 8 项 desktop check（doctor.ts 在 desktopChecks=true 时调）。
 *
 * @param rust       RustBridgeLike 实例；null 时 8 项全 skip warn（不阻塞 ready）
 * @param opts       可选覆盖：helperPath（codesign 检查路径）、vlmEndpoint
 * @returns DoctorCheck[]（8 项，顺序固定 #15-#22；#22 默认 opt-in skip）
 */
export async function runRustDoctorChecks(
  rust: RustBridgeLike | null,
  opts: {
    helperPath?: string;
    vlmEndpoint?: string | null;
  } = {},
): Promise<DoctorCheck[]> {
  // 无 bridge = doctor CLI 路径未装配 DesktopChannel → 8 项全 warn skip
  if (!rust) {
    return SKIP_DESKTOP;
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
    // 21. tcc_event_synthesizing（v1.11 round1 T11；bugs/10 A.4 诚实化）
    await checkTccEventSynthesizing(rust),
    // 22. cgevent_delivery_selftest（bugs/10 A.3；opt-in env 门住——默认 skip）
    await checkCgeventDeliverySelftest(rust),
  ];
}

// ============================================================
// 各项 check 实装（#15-#22）
// ============================================================

/**
 * 15. rust_helper_signed（parse4 §3.1.7 + 验收 #7）。
 *
 * 用 codesign -dvvv 验证 helper binary 签了 Developer ID Application:。
 *  - 找不到 binary → warn（M0.5a 阶段允许尚未构建；doctor 提示 `cargo build --release`）
 *  - 找到但未签 / ad-hoc 签 → **warn**（2026-08-31 用户裁决：ad-hoc 是官方免费合法方案，
 *    功能完全正常——唯一代价是 rebuild 后 TCC 重授权；FAIL 语义把正常配置判成
 *    ready:false 属噪音。Developer ID 长期方案保留在 next_step）
 *  - 找到且签了 Developer ID → pass，detail 报 Authority
 *
 * INV-21：本 check 只跑 shell `codesign`，不调 AXAPI/CG 平台符号。
 */
export async function checkRustHelperSigned(
  helperPath: string | undefined,
  execProbe: (
    cmd: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }> = (cmd, args) =>
    execFileP(cmd, args, { timeout: 5_000 }) as Promise<{
      stdout: string;
      stderr: string;
    }>,
): Promise<DoctorCheck> {
  const probePath = helperPath ?? DEFAULT_HELPER_PATH();
  let stdout: string;
  try {
    const r = await execProbe("codesign", ["-dvvv", probePath]).catch(
      (e: unknown) => {
        // binary 不存在或 codesign 失败 → warn（M0.5a 允许未构建）
        const msg = e instanceof Error ? e.message : String(e);
        return { stdout: "", stderr: msg };
      },
    );
    stdout = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  } catch (e) {
    return {
      name: "rust_helper_signed",
      status: "warn",
      detail: `codesign 探测失败：${String(e)}`,
      // A1：npm 布局（源码不在包内）→ cargo/sign.sh 修法不可行，仅 env 覆盖
      next_step: hasRustHelperSource()
        ? `cd rust-helper && cargo build --release && ./build/sign.sh`
        : `env ${LASSO_RUST_HELPER_ENV} 指向源码 checkout 内构建+签名的 helper（npm 包不含 rust-helper 源码）`,
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
      status: "warn",
      detail: `ad-hoc 签名（免费方案，功能正常；rebuild 后需重新系统授权 TCC）：${probePath}`,
      // 2026-08-31 用户裁决：FAIL→warn——ad-hoc 合法可用，不该拉低 ready
      next_step: `想免去每次 rebuild 重授权：LASSO_DEV_ID='Developer ID Application: Your Name (TEAMID)' ./rust-helper/build/sign.sh`,
    };
  }
  // codesign 返回但无任何关键字。BUG-rust-helper-relative-path §4.2：
  // 诚实区分「binary 不存在」与「存在但 codesign 无签名输出」——此前一律
  // "可能未构建" 在 binary 实存时误导排查方向；detail 附实际探测的绝对路径。
  if (!existsSync(probePath)) {
    return {
      name: "rust_helper_signed",
      status: "warn",
      detail: `binary 不存在：${probePath}（探测路径与 spawn 同源：resolveRustHelperPath()）`,
      // A1：npm 布局（源码不在包内）→ cargo build 不可行，仅 env 覆盖
      next_step: hasRustHelperSource()
        ? `cd rust-helper && cargo build --release（或 env ${LASSO_RUST_HELPER_ENV}=<绝对路径> 覆盖）`
        : `仅可用 env ${LASSO_RUST_HELPER_ENV}=<已构建 helper 的绝对路径> 覆盖（npm 包不含 rust-helper 源码，无法 cargo build）`,
    };
  }
  return {
    name: "rust_helper_signed",
    status: "warn",
    detail: `binary 存在但无签名输出：${probePath}`,
    // A1：npm 布局（源码不在包内）→ sign.sh 不在包内，构建+签名须回源码 checkout
    next_step: hasRustHelperSource()
      ? `cd rust-helper && cargo build --release && ./build/sign.sh（ad-hoc 兜底签名也行）`
      : `env ${LASSO_RUST_HELPER_ENV} 指向源码 checkout 内构建+签名的 helper（npm 包不含 rust-helper 源码）`,
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
 * 21. tcc_event_synthesizing（v1.11 round1 T11；bugs/10 A.4 诚实化改写）。
 * 调 rust.call("tcc_status") 读 event_synthesizing（四态）+ iohid_post_event
 * （advisory 原始值）+ macos_major。
 *  - "granted"      → pass
 *  - "denied"       → warn（档3 cgEvent 键盘/鼠标合成被 WindowServer 静默拦截——
 *                     仅 act press/hotkey/鼠标路径需要；observe 不依赖）
 *  - "undefined"    → macOS ≥15 → warn（门控语义：非 granted 即门，旧行为）；
 *                     macOS <15 → pass（advisory——Accessibility 是操作性授权，
 *                     Undefined 下投递实证可用，bugs/10 §0 断言 5）
 *  - "not_required"/缺失 → pass（维度缺失 / 旧 helper wire 前向兼容）
 */
async function checkTccEventSynthesizing(
  rust: RustBridgeLike,
): Promise<DoctorCheck> {
  try {
    const r = await rust.call("tcc_status", {}, 3_000);
    if (!r.ok) {
      return {
        name: "tcc_event_synthesizing",
        status: "warn",
        detail: r.error ?? r.error_kind ?? "tcc_status returned ok=false",
      };
    }
    const tcc = (r.result ?? {}) as {
      event_synthesizing?: string;
      iohid_post_event?: string;
      macos_major?: number;
    };
    const es = tcc.event_synthesizing;
    const major =
      typeof tcc.macos_major === "number" ? tcc.macos_major : 0;
    const advisory = `macOS ≥15: Event Synthesizing is a hard gate; <15: Accessibility is the operative grant, IOHID PostEvent probe is advisory — per-process attribution, same machine may report differently per process (repo data points on file: helper chain granted / terminal process undefined)`;
    if (es === "granted") {
      return {
        name: "tcc_event_synthesizing",
        status: "pass",
        detail: `Event Synthesizing 已授权（iohid_post_event=${tcc.iohid_post_event ?? "n/a"}, macos=${major}）`,
      };
    }
    if (es === "denied") {
      return {
        name: "tcc_event_synthesizing",
        status: "warn", // warn 而非 fail：仅档3 act 键盘/鼠标路径依赖；observe 不依赖
        detail:
          "Event Synthesizing 未授权（cgEvent 键盘/鼠标合成会被静默拦截）",
        next_step:
          "System Settings → Privacy & Security → Event Synthesizing → 加入 lasso-rust-helper（15+ 新维度；Peekaboo permissions 文档同款）",
      };
    }
    if (es === "undefined") {
      if (major >= 15) {
        return {
          name: "tcc_event_synthesizing",
          status: "warn",
          detail: `Event Synthesizing: undefined（macOS ≥15 门控语义按未授权处理——cgEvent 合成会被拦截）`,
          next_step:
            "System Settings → Privacy & Security → Event Synthesizing → 加入 lasso-rust-helper",
        };
      }
      // <15：advisory 层——Accessibility 是操作性授权；Undefined 下投递实证可用
      return {
        name: "tcc_event_synthesizing",
        status: "pass",
        detail: `Event Synthesizing: undefined（macOS ${major}；${advisory}）`,
      };
    }
    // not_required（维度缺失）或字段缺失（旧 helper wire）→ pass
    return {
      name: "tcc_event_synthesizing",
      status: "pass",
      detail: `Event Synthesizing: ${es ?? "not_required"}（macos=${major}；${advisory}）`,
    };
  } catch (e) {
    return {
      name: "tcc_event_synthesizing",
      status: "warn",
      detail: String(e),
    };
  }
}

// ============================================================
// 22. cgevent_delivery_selftest（bugs/10 决议 A.3；opt-in env 门住）
// ============================================================
/**
 * wiggle 位移（pt）。house 常量，不做参数化（决议 A.3）。
 * 7px：足以被光标读回无歧义判读，又不构成对用户屏幕的实质扰动。
 */
const SELFTEST_WIGGLE_PT = 7;

/**
 * wiggle 目标计算（纯函数，单测锚）：
 *  - 光标 + (7,0)；主屏 bounds 内夹取；+7 越界 → 取 -(7,0)
 *  - 光标不在主屏内（多屏/负坐标）→ null = 诚实 skip "cursor off main display"
 */
export function wiggleTarget(
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number } | null {
  const onMain = x >= 0 && x < w && y >= 0 && y < h;
  if (!onMain) return null;
  let tx = x + SELFTEST_WIGGLE_PT;
  if (tx >= w) tx = x - SELFTEST_WIGGLE_PT; // 越界取反（决议 A.3）
  const maxX = Math.max(0, w - 1);
  const maxY = Math.max(0, h - 1);
  return {
    x: Math.min(Math.max(tx, 0), maxX),
    y: Math.min(Math.max(y, 0), maxY),
  };
}

/**
 * 22. cgevent_delivery_selftest（bugs/10 决议 A.3——报告建议 #2 的固化，opt-in）。
 *
 * **默认 skip（warn）**：本检查会真实移动用户光标 7px 后复位。doctor 可被
 * agent 经 desktop(action:"doctor") 触发——未经部署者明示的光标位移违反
 * 伦理红线（真实干预须可预期，D-α 探针副作用实证）。env
 * `LASSO_DOCTOR_INPUT_SELFTEST=1` = 部署者一次性 consent。
 *
 * 执行体（全部复用 A.1 读原语 + 既有 move——零新窗零截图零新依赖）：
 *   读 cgevent_cursor_state → wiggle 目标（bounds 夹取）→ dispatch move →
 *   读回 landed → 复位 move 回原坐标 → 复读确认。
 * 通过 = pass（detail 注明 moved your cursor 7px and restored）；
 * 失败 = fail + 定位到层（读失败=helper 层 / 落点失败=投递层）。
 */
async function checkCgeventDeliverySelftest(
  rust: RustBridgeLike,
): Promise<DoctorCheck> {
  const name = "cgevent_delivery_selftest";
  // 伦理门：env opt-in（必须先于任何 rust.call("cgevent_dispatch") —— INV-102）
  if (process.env.LASSO_DOCTOR_INPUT_SELFTEST !== "1") {
    return {
      name,
      status: "warn",
      detail:
        "opt-in skip（默认关：本检查会真实移动你的光标 7px 后复位——deployer consent 红线）",
      next_step:
        "export LASSO_DOCTOR_INPUT_SELFTEST=1 后再跑 doctor 可验证 cgEvent 鼠标投递链（wiggle+复位自检）",
    };
  }
  // 1. 读基线（读失败 = helper 层定位）
  let orig: { x: number; y: number };
  let display: { w: number; h: number };
  try {
    const r = await rust.call("cgevent_cursor_state", {}, 3_000);
    if (!r.ok) {
      return {
        name,
        status: "fail",
        detail: `helper 层：cgevent_cursor_state 读失败（${r.error ?? r.error_kind ?? "ok=false"}）——重建/重签 rust-helper 或查 helper 版本`,
      };
    }
    const v = (r.result ?? {}) as {
      x?: number;
      y?: number;
      display?: { w?: number; h?: number };
    };
    if (
      typeof v.x !== "number" ||
      typeof v.y !== "number" ||
      typeof v.display?.w !== "number" ||
      typeof v.display?.h !== "number"
    ) {
      return {
        name,
        status: "fail",
        detail: "helper 层：cgevent_cursor_state 返回形状异常（x/y/display 缺失）",
      };
    }
    orig = { x: v.x, y: v.y };
    display = { w: v.display.w, h: v.display.h };
  } catch (e) {
    return {
      name,
      status: "fail",
      detail: `helper 层：${String(e)}`,
    };
  }
  // 2. wiggle 目标（光标不在主屏 → 诚实 skip，不硬移）
  const target = wiggleTarget(orig.x, orig.y, display.w, display.h);
  if (!target) {
    return {
      name,
      status: "warn",
      detail: `skip：光标不在主屏内（${orig.x.toFixed(1)},${orig.y.toFixed(1)} vs ${display.w}x${display.h}）——把光标移回主屏后重试`,
    };
  }
  // 3. wiggle move + 落点判读（失败 = 投递层定位）
  const wiggle = await rust.call(
    "cgevent_dispatch",
    { actions: [{ kind: "move", x: target.x, y: target.y }] },
    5_000,
  );
  const wiggleOk =
    wiggle.ok &&
    landedOfFirstAction(wiggle.result) === true;
  // 4. 复位 move（无论 wiggle 成败都复位——把光标放回去是义务不是奖励）
  await rust.call(
    "cgevent_dispatch",
    { actions: [{ kind: "move", x: orig.x, y: orig.y }] },
    5_000,
  );
  if (!wiggleOk) {
    return {
      name,
      status: "fail",
      detail: `投递层：wiggle move(${target.x.toFixed(1)},${target.y.toFixed(1)}) 未落地（landed!=true；已复位原位）——合成鼠标事件未到达 WindowServer；对照 physical_input 排查并发物理输入`,
      next_step:
        "确认 Accessibility 已授权（doctor #17）；若正在物理操作鼠标请静止后重试；持续失败=环境层问题（远程会话/输入监控拦截），如实上报",
    };
  }
  // 5. 复读确认复位（读回不在原位 = 如实报 displaced）
  let restored = false;
  try {
    const after = await rust.call("cgevent_cursor_state", {}, 3_000);
    const v = (after.result ?? {}) as { x?: number; y?: number };
    restored =
      after.ok &&
      typeof v.x === "number" &&
      typeof v.y === "number" &&
      Math.abs(v.x - orig.x) < 0.5 &&
      Math.abs(v.y - orig.y) < 0.5;
  } catch {
    restored = false;
  }
  if (!restored) {
    return {
      name,
      status: "fail",
      detail: `wiggle 投递 OK 但复位确认失败（光标未读回原位 ${orig.x.toFixed(1)},${orig.y.toFixed(1)}——可能被并发物理输入接管；如实报，光标现为最后复位 move 目标）`,
    };
  }
  return {
    name,
    status: "pass",
    detail: `mouse-event delivery OK — moved your cursor ${SELFTEST_WIGGLE_PT}px and restored (${orig.x.toFixed(1)},${orig.y.toFixed(1)})`,
  };
}

/** cgevent_dispatch 结果首动作的 landed 判读（坏形状 → false，不伪造）。 */
function landedOfFirstAction(result: unknown): boolean {
  const results = (result as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results) || results.length === 0) return false;
  const first = results[0] as Record<string, unknown> | null;
  return !!first && first.ok === true && first.landed === true;
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
 * doctor CLI 路径未装配 DesktopChannel 时的 8 项 skip warn。
 * 不阻塞 ready（warn 不进 blockers）；提示用户用 `desktop(action:"doctor")` 跑完整检查。
 */
const SKIP_DESKTOP: DoctorCheck[] = [
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
  {
    name: "tcc_event_synthesizing",
    status: "warn",
    detail: "desktopChecks=false（doctor CLI 默认装配无 DesktopChannel）",
  },
  {
    name: "cgevent_delivery_selftest",
    status: "warn",
    detail: "desktopChecks=false（doctor CLI 默认装配无 DesktopChannel）",
    next_step: "调 desktop(action:'doctor') 取完整 8 项 desktop check",
  },
];
