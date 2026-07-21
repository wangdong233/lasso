/**
 * ScreenshotVlmProvider（parse4 §2.1 + §3.2 + D10 解耦）
 *
 * DesktopChannel（Phase C 落地）的两个 provider 之一：canvas/Metal 兜底路径。
 * 职责：
 *  1. 经 RustBridge.call("screenshot") 取屏幕/区域截图（PNG base64）
 *  2. 若 LASSO_VLM_ENDPOINT 配置 → 把截图转给 media-gen-mcp vlm provider
 *     （HTTP MCP，可选 McpClient.connectHttp），让 VLM 返回语义 outline / 动作
 *  3. 未配 LASSO_VLM_ENDPOINT → outcome="didnt" + error="vlm_unavailable"
 *     （不阻断 ax 主路径；axProvider 是 primary）
 *
 * 边界（D10 screenshotVlm 跨 MCP 耦合）：
 *  - LASSO_VLM_ENDPOINT 可选；未配时返 didnt 不阻断
 *  - HTTP MCP 调用走标准 McpClient.connectHttp（与 search/browse 同一个封装）
 *  - VLM 返回 shape 不在 v0.3.5 锁死（M0.5b 验收 60%+ 准确率后再锁 schema）
 *
 * INV-21：本类不出现平台 API 字面量；screenshot 经 RustBridge.call("screenshot")。
 *
 * 借鉴：13 §3.5；media-gen-mcp vlm provider（HTTP MCP 模式）；D10 风险缓解。
 */
import type { RustBridge, RustResponse } from "../subprocess/RustBridge.js";
import type {
  DesktopOptions,
  DesktopResult,
} from "./desktop-types.js";
import type { InteractResult, Outcome } from "../types.js";

// ============================================================
// 配置
// ============================================================
/** VLM endpoint 环境变量名（parse4 §3.5 + D10）。 */
export const LASSO_VLM_ENDPOINT_ENV = "LASSO_VLM_ENDPOINT";

/** 默认 VLM 工具名（media-gen-mcp vlm provider 的 callTool 名）。 */
const DEFAULT_VLM_TOOL = "vlm";

/** 默认 VLM 调用超时（VLM 模型推理较慢，给 60s）。 */
const DEFAULT_VLM_TIMEOUT_MS = 60_000;

// ============================================================
// ScreenshotVlmProvider
// ============================================================
/**
 * 截图 + VLM 兜底 provider（v0.3.5 DesktopChannel fallback 档）。
 *
 * v0.3.5 实装策略（D10）：
 *  - screenshot 经 RustBridge.call("screenshot")（Rust 端 CG 截屏，已就绪）
 *  - VLM 调用走 McpClient.connectHttp（可选；LASSO_VLM_ENDPOINT 未配则跳过）
 *  - 未配 endpoint 时 outcome=didnt + error="vlm_unavailable"（不抛、不阻断）
 *
 * INV-21：本类不出现平台 API 字面量；截图调用经 RustBridge.call("screenshot")。
 */
export class ScreenshotVlmProvider {
  static readonly NAME = "desktop.screenshotVlm";

  /** 缓存的 VLM endpoint（构造时读一次 env，避免每次调用都读）。 */
  private readonly vlmEndpoint: string | null;
  /** 可选的 HTTP MCP client 工厂（注入便于单测；生产用 McpClient.connectHttp）。 */
  private readonly vlmCaller: VlmCaller | null;

  constructor(
    private readonly rust: RustBridge,
    opts: {
      /**
       * VLM endpoint URL（如 "https://media-gen.example/mcp"）。
       * 默认读 process.env.LASSO_VLM_ENDPOINT；null 表示未配（返 didnt）。
       */
      endpoint?: string | null;
      /**
       * VLM 调用器（注入接口，便于单测 mock）。
       * 生产代码传入 wrapMcpVlmCaller(endpoint)。
       */
      vlmCaller?: VlmCaller | null;
    } = {},
  ) {
    this.vlmEndpoint =
      opts.endpoint !== undefined
        ? opts.endpoint
        : (process.env[LASSO_VLM_ENDPOINT_ENV] ?? null);
    this.vlmCaller = opts.vlmCaller ?? null;
  }

  /**
   * 取 PNG base64 截图（不调 VLM，仅取图）。
   * screenshot action / doctor 可直接用。
   *
   * @param region 可选截区域 { x, y, w, h }；默认全屏
   */
  async captureScreenshot(
    region?: { x: number; y: number; w: number; h: number },
  ): Promise<InteractResult<{ base64: string; format: "png"; width: number; height: number }>> {
    const resp = await this.rust.call("screenshot", region ? { region } : {});
    const outcome = outcomeOf(resp);
    if (outcome !== "worked") {
      return {
        outcome,
        data: null,
        served_by: ScreenshotVlmProvider.NAME,
        fallback_used: false,
        retrieval_method: "screenshot",
        error: resp.error ?? resp.error_kind,
      };
    }
    const r = (resp.result ?? {}) as {
      base64?: string;
      format?: string;
      width?: number;
      height?: number;
    };
    if (typeof r.base64 !== "string") {
      return {
        outcome: "unknown",
        data: null,
        served_by: ScreenshotVlmProvider.NAME,
        fallback_used: false,
        retrieval_method: "screenshot",
        error: "bad_screenshot_shape",
      };
    }
    return {
      outcome: "worked",
      data: {
        base64: r.base64,
        format: "png",
        width: r.width ?? 0,
        height: r.height ?? 0,
      },
      served_by: ScreenshotVlmProvider.NAME,
      fallback_used: false,
      retrieval_method: "screenshot",
    };
  }

  /**
   * act fallback entry：被 DesktopChannel.act 经 FallbackDecider 调用。
   *
   * 策略（D10 解耦）：
   *  1. screenshot 取图
   *  2. 若 vlmEndpoint + vlmCaller 都就绪 → 调 VLM 推断动作
   *  3. 否则 outcome=didnt + error="vlm_unavailable"（不阻断 ax 主路径）
   *
   * @returns InteractResult<DesktopResult>
   */
  async act(opts: DesktopOptions): Promise<InteractResult<DesktopResult>> {
    // 1. 取截图
    const shot = await this.captureScreenshot(opts.screenshot_region);
    if (shot.outcome !== "worked" || !shot.data) {
      return {
        outcome: shot.outcome,
        data: null,
        served_by: ScreenshotVlmProvider.NAME,
        fallback_used: false,
        retrieval_method: "screenshot",
        error: shot.error ?? "screenshot_failed",
      };
    }

    // 2. VLM endpoint 未配 → 明确 didnt（不阻断 fallback 链；axProvider 主路径）
    if (!this.vlmEndpoint || !this.vlmCaller) {
      return {
        outcome: "didnt",
        data: null,
        served_by: ScreenshotVlmProvider.NAME,
        fallback_used: false,
        retrieval_method: "vlm_unavailable",
        error: "vlm_unavailable",
      };
    }

    // 3. 调 VLM
    try {
      const vlmResult = await this.vlmCaller({
        endpoint: this.vlmEndpoint,
        base64: shot.data.base64,
        width: shot.data.width,
        height: shot.data.height,
        prompt: buildVlmPrompt(opts),
        timeoutMs: DEFAULT_VLM_TIMEOUT_MS,
      });
      // VLM 调用成功 = worked（具体动作执行由 Rust 端 M0.5b 落地，此处仅返回推断）
      const data: DesktopResult = {
        actions_and_results: [],
        expect_verified: false,
        screenshot_base64: shot.data.base64,
        screenshot_format: "png",
        fallback_used: true,
      };
      // vlmResult 暂存到 actions_and_results 作 debug（v0.3.5 不锁 VLM shape）
      if (vlmResult && typeof vlmResult === "object") {
        data.actions_and_results.push({
          ref: "@vlm",
          ok: true,
          error: JSON.stringify(vlmResult).slice(0, 500),
        });
      }
      return {
        outcome: "worked",
        data,
        served_by: ScreenshotVlmProvider.NAME,
        fallback_used: true,
        retrieval_method: "vlm",
      };
    } catch (e) {
      return {
        outcome: "unknown",
        data: null,
        served_by: ScreenshotVlmProvider.NAME,
        fallback_used: true,
        retrieval_method: "vlm",
        error: `vlm_call_failed:${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

// ============================================================
// VLM 调用抽象（注入接口，便于单测 mock；D10）
// ============================================================
/**
 * VLM 调用器接口（生产代码 wrap McpClient.connectHttp + callTool("vlm", ...)）。
 *
 * 设计：接口而非具体类，让 ScreenshotVlmProvider 不强耦合 MCP SDK；
 * 单测可直接注入 mock；生产代码注入 wrapMcpVlmCaller 即可。
 */
export type VlmCaller = (req: {
  endpoint: string;
  base64: string;
  width: number;
  height: number;
  prompt: string;
  timeoutMs: number;
}) => Promise<unknown>;

/**
 * 把 DesktopOptions 转 VLM prompt（v0.3.5 简化文本拼接）。
 * M0.5b 验收 VLM 准确率后可换更精细 prompt 模板。
 */
function buildVlmPrompt(opts: DesktopOptions): string {
  const parts: string[] = [];
  if (opts.app) parts.push(`app=${opts.app}`);
  if (opts.actions && opts.actions.length > 0) {
    parts.push(`actions=${JSON.stringify(opts.actions)}`);
  }
  if (opts.where) parts.push(`where=${JSON.stringify(opts.where)}`);
  if (opts.expect) parts.push(`expect=${JSON.stringify(opts.expect)}`);
  return parts.length > 0 ? parts.join(" ") : "describe_interactive_elements";
}

// ============================================================
// 内部辅助：错误契约（与 AxProvider 同语义，复刻一份避免循环依赖）
// ============================================================
function outcomeOf(resp: RustResponse): Outcome {
  if (resp.ok) return "worked";
  if (
    resp.error_kind === "tcc_denied" ||
    resp.error_kind === "tcc_screen_recording_denied" ||
    resp.error_kind === "app_not_found" ||
    resp.error_kind === "invalid_params"
  ) {
    return "didnt";
  }
  return "unknown";
}

/** 默认 VLM 工具名（导出便于单测断言）。 */
export { DEFAULT_VLM_TOOL };
