/**
 * DesktopChannel（parse4 §3.2 + 09 §2.4 + 13 §2.4 DesktopChannel MVP）
 *
 * 与 BrowseChannel 平级的 UiChannel 子类（兄弟不是父子，13 §2.4 R-CI-02）：
 * 控 macOS 原生应用（Finder/Mail/Safari/Notes/...）；AXAPI 语义优先，
 * canvas/Metal 无 AX 元素时 screenshotVlm 兜底。
 *
 * 装配（parse4 §3.2.1）：
 *  - 构造 5 参：rust + axProvider + vlmProvider + decider + breakers
 *  - readonly name = "desktop"
 *
 * 7 契约方法（parse4 §3.2.1）：
 *  - BaseChannel 3 契约：isAvailable / status / healthCheck（均经 rust.call("ping")）
 *  - UiChannel 4 契约：capabilities / observe(snapshot|find) / act / wait
 *  - 2 自有方法：screenshot / doctor（同经 providers / runDoctor）
 *
 * 关键铁律：
 *  - INV-16（F3.9.9 a）：本类用 `extends UiChannel` 守护兄弟分层。
 *  - INV-18（F3.9.9 c）：act 必须经 FallbackDecider.runWithFallback（不开第二套）。
 *  - INV-21（F3.9.9 f）：本类不出现 AXUIElement/CGEvent/AXPress/AXUIElementCreateSystemWide
 *                       等平台字面量；所有平台调用经 RustBridge.call。
 *  - INV-23（F3.9.9 h）：fallback plan 永远只列 desktop.* channels，绝不列 browse_*。
 *  - INV-29（v0.4 M0.4b）：act 的 4 档 plan 全 desktop.*，顺序
 *                          ax → appleScript → cgEvent → screenshotVlm。
 *
 * 主路径策略（parse4 §3.2.3 + §3.3 + parse5 §3.5.4 v0.4 M0.4b）：
 *  - observe(snapshot|find)：直接 axProvider，**不走 fallback**（observe 是只读，
 *    ax 失败 = 整个 desktop 不可用，没意义再降级 screenshotVlm；parse4 §3.2.1）
 *  - act：经 FallbackDecider；plan = { primary:"desktop.ax",
 *                                      fallbacks:["desktop.appleScript",
 *                                                 "desktop.cgEvent",
 *                                                 "desktop.screenshotVlm"],
 *                                      cross_modal:false }
 *    （parse5 §3.5.4：v0.4 M0.4b 把 2 档补成 4 档；ax → appleScript → cgEvent
 *     → screenshotVlm 顺序对应 13 §2.3 4-tier fallback 设计）
 *  - wait：复用 axProvider.observe("snapshot") + poll（与 BrowseChannel.runExpect 同范式）
 *  - screenshot：直接 vlmProvider.captureScreenshot（不调 VLM；M0.5b 才接 VLM）
 *  - doctor：复用 runDoctor({desktopChecks:true})（不开第二套）
 *
 * 借鉴：parse4 §3.2 全文；parse5 §3.5.4 4-tier plan；BrowseChannel 的
 * InteractResult 信封风格；pi-computer-use tri-state；13 §3.5 AxProvider /
 * ScreenshotVlmProvider / AppleScriptProvider / CGEventProvider 抽象。
 */
import { UiChannel } from "./UiChannel.js";
import type { AxProvider } from "../desktop/AxProvider.js";
import type { ScreenshotVlmProvider } from "../desktop/ScreenshotVlmProvider.js";
import type { AppleScriptProvider } from "../desktop/AppleScriptProvider.js";
import type { CGEventProvider } from "../desktop/CGEventProvider.js";
import type { FallbackDecider, FallbackPlan } from "../fallback/FallbackDecider.js";
import type { CircuitBreaker } from "../fallback/CircuitBreaker.js";
import type {
  DesktopOptions,
  OutlineSnapshot,
  DesktopResult,
} from "../desktop/desktop-types.js";
import type { InteractResult, ChannelStatus, Health } from "../types.js";
import type { RustBridge } from "../subprocess/RustBridge.js";
import { runDoctor, type DoctorOptions } from "../doctor/doctor.js";
import { logger } from "../util/logger.js";

// ============================================================
// wait tri-state（与 BrowseChannel.runExpect 同形状）
// ============================================================
/**
 * wait action 的诚实 tri-state 报告（13 §3.4 M0.5b 第 10 条）：
 *  - "worked"     : wait 期间条件达成
 *  - "preexisting": act 之前条件就已成立（无需 wait；诚实报告）
 *  - "didnt"      : 超时未达成（明确"否"，不 fallback）
 *  - "unknown"    : 内部错误（如 helper crash；可被上游 fallback）
 */
export type WaitVerdict = "worked" | "preexisting" | "didnt" | "unknown";

// ============================================================
// DesktopChannel
// ============================================================
/**
 * v0.3.5 DesktopChannel MVP（parse4 §3.2）+ v0.4 M0.4b 4-tier fallback（parse5 §3.5.4）。
 *
 * INV-16：class DesktopChannel extends UiChannel —— 本行守护兄弟分层。
 * INV-21：本类不调平台 API；所有平台调用经 rust.call → rust-helper binary。
 * INV-29：act 的 4 档 plan 全 desktop.*（顺序 ax → appleScript → cgEvent → screenshotVlm）。
 */
export class DesktopChannel extends UiChannel {
  readonly name = "desktop";

  constructor(
    private readonly rust: RustBridge,
    private readonly axProvider: AxProvider,
    private readonly vlmProvider: ScreenshotVlmProvider,
    /**
     * v0.4 M0.4b 加（parse5 §3.5.4）：4-tier 第 2 档 appleScript。
     * 仅 typed action enum 入口；INV-22（v0.4 解除）+ INV-27 守护。
     */
    private readonly appleScriptProvider: AppleScriptProvider,
    /**
     * v0.4 M0.4b 加（parse5 §3.5.4）：4-tier 第 3 档 cgEvent。
     * 仅逻辑键名（INV-28）；press / hotkey 路径专用。
     */
    private readonly cgEventProvider: CGEventProvider,
    private readonly decider: FallbackDecider,
    /**
     * CircuitBreaker 表（与 FallbackDecider 共享同一份）。
     * 显式注入是为了让 doctor / 测试能从 channel 反向查询 breaker 状态。
     */
    breakers: Map<string, CircuitBreaker>,
  ) {
    super();
    this.breakers = breakers;
  }
  /**
   * CircuitBreaker 表引用（与 FallbackDecider 共享；doctor / 测试反查用）。
   * 本字段不参与 act 控制流（breaker 查表在 FallbackDecider 内）。
   */
  readonly breakers: Map<string, CircuitBreaker>;

  // ============================================================
  // BaseChannel 3 契约（parse4 §3.2.1）
  // ============================================================
  /** ping rust helper；ok=true 即视为可用。永不抛异常。 */
  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.rust.call("ping", {}, 3_000);
      return r.ok === true;
    } catch {
      return false;
    }
  }

  /** 触网探测：ping + 延迟 + tcc 摘要。错误走 { available:false, note }。 */
  async status(): Promise<ChannelStatus> {
    const t0 = Date.now();
    try {
      const r = await this.rust.call("ping", {}, 3_000);
      if (!r.ok) {
        return { available: false, note: r.error ?? "rust_helper_error" };
      }
      const tcc = (r.result as { tcc?: unknown } | undefined)?.tcc;
      return {
        available: true,
        latency_ms: Date.now() - t0,
        note: tcc !== undefined ? JSON.stringify(tcc) : undefined,
      };
    } catch (e) {
      return { available: false, note: String(e) };
    }
  }

  /** 聚合健康：>2s 视为 degraded（parse4 §3.2.1）。 */
  async healthCheck(): Promise<Health> {
    const s = await this.status();
    if (!s.available) return "down";
    if (s.latency_ms !== undefined && s.latency_ms > 2_000) return "degraded";
    return "healthy";
  }

  // ============================================================
  // UiChannel 4 契约（parse4 §3.2.1）
  // ============================================================
  /**
   * 能力自报（13 §2.4 仅描述用，不参与路由）。
   *  - canObserve / canAct: 都支持
   *  - observeLatencyMs    : ≤30ms 目标（M0.5a 验收 #4）
   *  - needsForeground     : false（AXAPI 不要求 app 前台；screenshotVlm 才需要）
   *  - dataModel           : "ax"（与 browse 的 "dom" 区分；仅描述）
   */
  capabilities() {
    return {
      canObserve: true,
      canAct: true,
      observeLatencyMs: 30,
      needsForeground: false,
      dataModel: "ax" as const,
    };
  }

  /**
   * observe 主路径：snapshot / find 都直接走 axProvider（**不经 fallback**）。
   *
   * 原因（parse4 §3.2.1）：observe 是只读；ax 失败意味着 desktop 整体不可用，
   * 没有降到 screenshotVlm 的语义意义（screenshotVlm 是为 act 而生的兜底）。
   * 故 ax 的 outcome 即本方法的 outcome（unknown 由调用方/上层判断）。
   */
  async observe(
    action: "snapshot" | "find",
    opts: DesktopOptions,
  ): Promise<InteractResult<OutlineSnapshot | { matches: unknown[]; count: number }>> {
    if (action === "snapshot") {
      const r = await this.axProvider.snapshot(opts);
      // 注入 breaker 状态（snapshot 是 read，failure 不熔断；success 也不清零
      // —— 熔断只针对 act 路径，parse4 §3.2.1）
      return r;
    }
    // action === "find"
    return this.axProvider.find(opts);
  }

  /**
   * act 主路径：经 FallbackDecider.runWithFallback（INV-18）。
   *
   * v0.4 M0.4b plan = {
   *   primary:    "desktop.ax",
   *   fallbacks: ["desktop.appleScript", "desktop.cgEvent", "desktop.screenshotVlm"],
   *   cross_modal: false,
   * }
   * （INV-23：fallback 链全 desktop.*，绝不 cross-surface 进 browse_*）
   * （INV-29：4 档全 desktop.*，顺序 ax → appleScript → cgEvent → screenshotVlm）
   *
   * executor 把 channel 名映射到 provider.act：
   *  - "desktop.ax"           → axProvider.act(opts)
   *  - "desktop.appleScript"  → appleScriptProvider.act(opts)（v0.4 M0.4b 加）
   *  - "desktop.cgEvent"      → cgEventProvider.act(opts)（v0.4 M0.4b 加）
   *  - "desktop.screenshotVlm"→ vlmProvider.act(opts)
   *
   * 顺序语义（parse5 §3.5.4 + 13 §2.3 4-tier）：
   *  - ax 失败（Electron app 吞 AXSetValue / canvas 无 AX 元素）→ appleScript
   *  - appleScript 不支持该动作 / 不在白名单 → cgEvent
   *  - cgEvent 仅 press/hotkey，其他动作不支持 → screenshotVlm
   *
   * 不自造 fallback 循环（INV-18）：所有 worked/didnt/unknown 升降级判定在
   * FallbackDecider 内完成，本方法只负责 plan + executor 映射。
   */
  async act(opts: DesktopOptions): Promise<InteractResult<DesktopResult>> {
    const plan: FallbackPlan = {
      primary: "desktop.ax",
      // v0.4 M0.4b（parse5 §3.5.4）：2 档补成 4 档。
      // 顺序：ax → appleScript → cgEvent → screenshotVlm
      fallbacks: [
        "desktop.appleScript",
        "desktop.cgEvent",
        "desktop.screenshotVlm",
      ],
      cross_modal: false, // INV-23 + INV-29: desktop fallback 永不跨 surface
    };
    return this.decider.runWithFallback(plan, async (channelName) => {
      if (channelName === "desktop.ax") {
        return this.axProvider.act(opts);
      }
      if (channelName === "desktop.appleScript") {
        return this.appleScriptProvider.act(opts);
      }
      if (channelName === "desktop.cgEvent") {
        return this.cgEventProvider.act(opts);
      }
      if (channelName === "desktop.screenshotVlm") {
        return this.vlmProvider.act(opts);
      }
      throw new Error(`unknown_provider:${channelName}`);
    });
  }

  /**
   * wait 主路径：poll snapshot + where 子句匹配（与 BrowseChannel.runExpect 同范式）。
   *
   * tri-state（parse4 §3.4 M0.5b 第 10 条）：
   *  - 首次 snapshot 就匹配 → "preexisting"（诚实报告，13 §3.4）
   *  - 轮询期间匹配         → "worked"
   *  - 超时未匹配           → "didnt"（明确"否"，不 fallback）
   *  - snapshot 抛错        → "unknown"（可被上游 fallback）
   *
   * @param opts      DesktopOptions（至少含 where；可选 timeout_ms）
   * @param timeoutMs 总超时（默认从 opts.timeout_ms ?? 30_000）
   */
  async wait(
    opts: DesktopOptions,
    timeoutMs?: number,
  ): Promise<InteractResult<{ verdict: WaitVerdict }>> {
    const where = opts.where;
    if (!where) {
      return {
        outcome: "didnt",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "ax_wait",
        error: "missing_where_clause",
      };
    }
    const deadline = Date.now() + (timeoutMs ?? opts.timeout_ms ?? 30_000);
    const pollIntervalMs = 100; // 与 ExpectPoll 默认一致

    let lastError: string | undefined;
    let firstIteration = true;

    while (Date.now() < deadline) {
      try {
        const r = await this.axProvider.find(opts);
        if (r.outcome === "worked" && r.data && r.data.count > 0) {
          // 匹配成功
          return {
            outcome: "worked",
            data: { verdict: firstIteration ? "preexisting" : "worked" },
            served_by: AxProviderNameRef,
            fallback_used: false,
            retrieval_method: "ax_wait",
          };
        }
        if (r.outcome === "didnt") {
          // ax 自己返 didnt（如 tcc_denied）—— 上报 didnt，不再 poll
          return {
            outcome: "didnt",
            data: null,
            served_by: r.served_by,
            fallback_used: false,
            retrieval_method: "ax_wait",
            error: r.error,
          };
        }
        // outcome === "unknown" —— 继续 poll（可能 helper 暂时性故障）
        lastError = r.error;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        logger.warn({
          evt: "desktop_wait_iter_error",
          channel: this.name,
          error: lastError,
        });
      }
      firstIteration = false;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // 超时未匹配：明确"否"
    return {
      outcome: "didnt",
      data: { verdict: "didnt" },
      served_by: AxProviderNameRef,
      fallback_used: false,
      retrieval_method: "ax_wait_timeout",
      error: lastError ? `timeout:${lastError}` : "timeout",
    };
  }

  // ============================================================
  // 2 自有方法（screenshot / doctor；parse4 §3.3.1 tool 折叠到此）
  // ============================================================
  /**
   * screenshot 主路径：直接 vlmProvider.captureScreenshot（不调 VLM）。
   *
   * 用于：
   *  - canvas/Metal pictureOnly 节点的兜底
   *  - LLM 显式要求"看一眼屏幕"
   *
   * 返回 InteractResult<{ base64, format, width, height }>；tool 层包成
   * DesktopResult 形状（actions_and_results 留空，screenshot_base64 写入）。
   */
  async screenshot(opts: DesktopOptions): Promise<InteractResult<DesktopResult>> {
    const shot = await this.vlmProvider.captureScreenshot(opts.screenshot_region);
    if (shot.outcome !== "worked" || !shot.data) {
      return {
        outcome: shot.outcome,
        data: null,
        served_by: shot.served_by,
        fallback_used: false,
        retrieval_method: shot.retrieval_method,
        error: shot.error ?? "screenshot_failed",
      };
    }
    return {
      outcome: "worked",
      data: {
        actions_and_results: [],
        screenshot_base64: shot.data.base64,
        screenshot_format: "png",
        fallback_used: false,
      },
      served_by: shot.served_by,
      fallback_used: false,
      retrieval_method: "screenshot",
    };
  }

  /**
   * doctor 主路径：复用 runDoctor({ desktopChecks: true })（parse4 §3.4.2）。
   *
   * 不开第二套 doctor —— runDoctor 加 6 项 desktop check（#15-#20）后既适用
   * CLI `lasso doctor` 也适用 `desktop(action:"doctor")` tool 调用。
   *
   * 关键：注入本 channel 持有的 rust 实例作为 desktopBridge，让 6 项 desktop
   * check 能调 ping/tcc_status/ax_snapshot。doctor.ts 默认装配路径无 bridge
   * → 6 项 warn skip；本路径必注入。
   *
   * @param opts 可选 DoctorOptions 覆盖（cacheDir / cdpPort 等不影响 desktop 路径）
   */
  async doctor(opts?: DoctorOptions): Promise<unknown> {
    return runDoctor({
      ...opts,
      desktopChecks: true,
      desktopBridge: this.rust,
    });
  }

  // ============================================================
  // v0.4 forest 调度层：listRoots（parse5 §3.1.4 + §2.2 windows.rs）
  // ============================================================
  /**
   * 枚举当前所有 AX application 的主窗口 → forest 调度层 RootInfo 数据源。
   *
   * 设计要点（INV-21 + INV-26 衍生）：
   *  - 本方法是 DesktopChannel 对外**公共**方法，forest 调度层（index.ts）
   *    装配期调它收集 roots；不暴露 channel internal。
   *  - 所有 AXAPI 调用经 `rust.call("list_windows")` —— TS 端无平台字面量（INV-21）。
   *  - 失败容忍：rust helper 未起 / tcc_denied / 任何异常 → 返空数组
   *    （interact_roots 是辅助入口；desktop root 缺失不破坏 browse root）
   *
   * @returns 形如 `[{ bundleId, pid, windowId, app, title, rect }]` 的轻量描述
   *          （不深抓 AX tree；CC 选 rootRef 后 dispatcher 再走 observe/act）
   */
  async listRoots(): Promise<
    Array<{
      bundleId: string;
      pid: number;
      windowId: number;
      app: string;
      title: string;
    }>
  > {
    try {
      const r = await this.rust.call("list_windows", {}, 5_000);
      if (!r.ok) {
        // not_macos / tcc_denied / 等 → 返空（forest 仍可工作，只是少 desktop root）
        return [];
      }
      const result = (r.result ?? {}) as { windows?: unknown };
      const arr = Array.isArray(result.windows) ? result.windows : [];
      const out: Array<{
        bundleId: string;
        pid: number;
        windowId: number;
        app: string;
        title: string;
      }> = [];
      for (const w of arr) {
        if (typeof w !== "object" || w === null) continue;
        const o = w as Record<string, unknown>;
        const bundleId = typeof o.bundleId === "string" ? o.bundleId : "";
        const pid = typeof o.pid === "number" ? o.pid : 0;
        const windowId = typeof o.windowId === "number" ? o.windowId : 0;
        const app = typeof o.app === "string" ? o.app : bundleId;
        const title = typeof o.title === "string" ? o.title : "";
        // 必要字段校验：windowId=0（pid=0 + index=0）是合法值；跳过条件 = 全空
        if (!bundleId && !pid && !windowId) continue;
        out.push({ bundleId, pid, windowId, app, title });
      }
      return out;
    } catch {
      // 子进程未起 / 协议错 → 返空（doctor 单独查 tcc 状态给用户更细诊断）
      return [];
    }
  }
}

// ============================================================
// 内部常量
// ============================================================
/**
 * wait 路径的 served_by 标识（用 axProvider.NAME 保持与 observe 一致的命名）。
 * 取 AxProvider.NAME 而非硬编码 "desktop.ax" 是为了 provider 改名时自动跟随。
 */
const AxProviderNameRef = "desktop.ax";
