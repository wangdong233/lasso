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
 *  - VLM 返回 shape 不锁死；T2-6（round2）：推断经宽化解析为坐标动作后由
 *    rust cgevent_dispatch 真执行（M0.5b 已废除，不再有「Rust 端后续执行」假设）；
 *    不可解析/执行失败 → 诚实 unknown（vlm_inference_only），推断原文附 data；
 *    T3-2（round3）：带 screenshot_region 时 VLM 返区域相对坐标，dispatch 前
 *    经 offsetVlmActionsByRegion 平移回全局坐标（假 worked 换装回归封堵）；
 *    T3-6（round3）：cgevent_dispatch 报 tcc_event_synthesis_denied → didnt
 *    （与 CGEventProvider 同判：权限缺失不是暂时性故障）
 *
 * INV-21：本类不出现平台 API 字面量；screenshot 经 RustBridge.call("screenshot")。
 *
 * 借鉴：13 §3.5；media-gen-mcp vlm provider（HTTP MCP 模式）；D10 风险缓解。
 */
import type { RustBridge, RustResponse } from "../subprocess/RustBridge.js";
import { McpClient } from "../subprocess/McpClient.js";
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
    // W1-DEF-8 修复：wire 键名对齐 Rust 端 screenshot.rs parse_region 读的
    // `screenshot_region`（此前发 `{region}` 键被 Rust 忽略 → 裁剪永不生效）。
    const resp = await this.rust.call(
      "screenshot",
      region ? { screenshot_region: region } : {},
    );
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

      // ==========================================================
      // T2-6（round2）：VLM 推断 → 真执行闭环。
      // 旧注释「具体动作执行由 Rust 端 M0.5b 落地」——M0.5b 已废除（T3），
      // 承诺永久落空；VLM 调用成功即 worked = tri-state 铁律在链尾的违背
      // （tiers 1-3 全败的 canvas/Metal 场景最终拿到假 worked）。
      // 现形态（对齐 UI-TARS-desktop 推断→物理执行）：
      //  a) 容错解析推断为坐标动作（click/move/drag/scroll；不锁 VLM shape）
      //  b) 可解析 → rust.call("cgevent_dispatch") 真执行（T7 路径复用），
      //     actions_and_results 填真逐项结果
      //  c) 解析失败 / 执行失败 → outcome=unknown + error="vlm_inference_only:…"
      //     （推断原文仍附 data——截图 token 已花不浪费）
      // ==========================================================
      const actions = offsetVlmActionsByRegion(
        parseVlmActions(vlmResult),
        opts.screenshot_region,
      );
      const inferenceRaw = summarizeVlmResult(vlmResult);

      if (actions.length === 0) {
        // c) 不可解析为坐标动作 → 不猜执行（Peekaboo "refusing ambiguous
        // evidence before dispatch"）；诚实 unknown
        return {
          outcome: "unknown",
          data: {
            actions_and_results: [
              {
                ref: "@vlm",
                ok: false,
                error: `vlm_inference_only:no_coordinate_action:${inferenceRaw}`,
              },
            ],
            screenshot_base64: shot.data.base64,
            screenshot_format: "png" as const,
            fallback_used: true,
          },
          served_by: ScreenshotVlmProvider.NAME,
          fallback_used: true,
          retrieval_method: "vlm",
          error: "vlm_inference_only:no_coordinate_action",
        };
      }

      // b) 真执行：cgevent_dispatch（T7 wire；每项独立成败；5s 上界同 CGEventProvider）
      const resp = await this.rust.call(
        "cgevent_dispatch",
        { actions },
        5_000,
      );

      if (!resp.ok) {
        // T3-6（round3 v1.13）：同 producer（cgevent_dispatch）双消费者映射对齐——
        // CGEventProvider 把 tcc_event_synthesis_denied 映射 didnt（权限缺失不是
        // 暂时性故障，重试/降级也点不动）；本档此前一律 unknown 是分类学缺口。
        if (resp.error_kind === "tcc_event_synthesis_denied") {
          return {
            outcome: "didnt",
            data: null,
            served_by: ScreenshotVlmProvider.NAME,
            fallback_used: true,
            retrieval_method: "tcc_event_synthesis_denied",
            error:
              "tcc_event_synthesis_denied: macOS 15+ 需在 System Settings → Privacy & Security → Event Synthesizing 授权 helper（或 Accessibility）",
          };
        }
        return {
          outcome: "unknown",
          data: {
            actions_and_results: [
              {
                ref: "@vlm",
                ok: false,
                error: `vlm_inference_only:execution_failed:${resp.error ?? resp.error_kind ?? "rust_error"}`,
              },
            ],
            screenshot_base64: shot.data.base64,
            screenshot_format: "png" as const,
            fallback_used: true,
          },
          served_by: ScreenshotVlmProvider.NAME,
          fallback_used: true,
          retrieval_method: "vlm",
          error: `vlm_inference_only:execution_failed:${resp.error_kind ?? "rust_error"}`,
        };
      }

      // 结果映射（CGEventProvider 同款）：results[index] ↔ actions[index]
      const result = (resp.result ?? {}) as { results?: unknown };
      const resultsArr = Array.isArray(result.results) ? result.results : [];
      const actionsAndResults: {
        ref: string;
        ok: boolean;
        error?: string;
      }[] = [];
      let successCount = 0;
      for (let i = 0; i < actions.length; i++) {
        const r = resultsArr[i] as Record<string, unknown> | undefined;
        const ok = !!r && typeof r === "object" && r.ok === true;
        const errKind =
          r && typeof r.error_kind === "string" ? r.error_kind : undefined;
        const errMsg =
          r && typeof r.error === "string" ? r.error : undefined;
        actionsAndResults.push({
          ref: vlmActionRefLabel(actions[i]),
          ok,
          error: ok ? undefined : errMsg ?? errKind ?? "cgevent_action_failed",
        });
        if (ok) successCount++;
      }

      if (successCount === 0) {
        // c) 全部项执行失败 → 诚实 unknown（推断原文附 @vlm 条目）
        actionsAndResults.unshift({
          ref: "@vlm",
          ok: false,
          error: `vlm_inference_only:all_actions_failed:${inferenceRaw}`,
        });
        return {
          outcome: "unknown",
          data: {
            actions_and_results: actionsAndResults,
            screenshot_base64: shot.data.base64,
            screenshot_format: "png" as const,
            fallback_used: true,
          },
          served_by: ScreenshotVlmProvider.NAME,
          fallback_used: true,
          retrieval_method: "vlm",
          error: "vlm_inference_only:all_actions_failed",
        };
      }

      // a) 至少 1 项真执行成功 → worked（actions_and_results 是真逐项结果）
      return {
        outcome: "worked",
        data: {
          actions_and_results: actionsAndResults,
          screenshot_base64: shot.data.base64,
          screenshot_format: "png" as const,
          fallback_used: true,
        },
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
// T2-6：VLM 推断 → cgevent_dispatch 坐标动作（宽化提取，不锁 VLM shape）
// ============================================================
/**
 * 把 VLM 返回（shape 未锁：media-gen-mcp vlm / 任意 vision 模型）容错解析为
 * cgevent_dispatch wire 动作。接受形态：
 *  - 顶层数组 / {actions:[]} / {action:[]} / 单对象
 *  - click : {kind:"click", x, y[, button:"left"|"right"|"center"]}
 *  - move  : {kind:"move", x, y}
 *  - drag  : {kind:"drag", from:{x,y}|from_x/from_y, to:{x,y}|to_x/to_y}
 *  - scroll: {kind:"scroll", dx, dy[, x, y]}
 *
 * 边界（tri-state 精神）：
 *  - 只收坐标鼠标四类——键盘注入不接受 VLM 推断（按键语义必须 caller 显式
 *    指定，INV-28 逻辑名纪律精神）
 *  - 坐标必须是有限数（NaN/Infinity 拒）；形状不合规项静默丢弃
 *
 * @returns 合规动作数组（空数组 = 不可解析 → 调用方走诚实 unknown）
 */
export function parseVlmActions(vlmResult: unknown): Array<Record<string, unknown>> {
  const candidates = extractVlmActionCandidates(vlmResult);
  const out: Array<Record<string, unknown>> = [];
  for (const c of candidates) {
    const parsed = parseOneVlmAction(c);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * T3-2（round3 v1.13）：VLM 档截图 region 的坐标偏移补偿（纯函数）。
 *
 * 五环证据链：act 接受 screenshot_region → captureScreenshot 裁图给 VLM →
 * VLM 返回**区域相对坐标** → cgevent.rs parse_point 直传**全局显示坐标**——
 * 不补偿则落点系统性偏移 (region.x, region.y) 且逐项 ok:true 总 outcome
 * "worked"（T2-6 消灭的假 worked 以「执行在错误位置还报成功」形态回归）。
 *
 * 修法：parse 之后、dispatch 之前在 TS 侧平移（不依赖 VLM 数学能力——prompt
 * 不告知区域原点，模型自然返区域相对坐标，由本函数换算回全局）：
 *  - click/move : x,y += (region.x, region.y)
 *  - drag       : from_x/from_y/to_x/to_y 四值 += 原点
 *  - scroll     : 可选 x,y 在场才平移（缺省 = 当前光标，与本档 CGEvent 同语义）；dx/dy 不动
 *  - 无 region  ：原数组原样返回（零变化）
 */
export function offsetVlmActionsByRegion(
  actions: Array<Record<string, unknown>>,
  region?: { x: number; y: number; w: number; h: number },
): Array<Record<string, unknown>> {
  if (!region) return actions;
  const ox = region.x;
  const oy = region.y;
  return actions.map((a) => {
    if (a.kind === "click" || a.kind === "move") {
      return { ...a, x: (a.x as number) + ox, y: (a.y as number) + oy };
    }
    if (a.kind === "drag") {
      return {
        ...a,
        from_x: (a.from_x as number) + ox,
        from_y: (a.from_y as number) + oy,
        to_x: (a.to_x as number) + ox,
        to_y: (a.to_y as number) + oy,
      };
    }
    if (
      a.kind === "scroll" &&
      typeof a.x === "number" &&
      typeof a.y === "number"
    ) {
      return { ...a, x: a.x + ox, y: a.y + oy };
    }
    return a;
  });
}

function extractVlmActionCandidates(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (Array.isArray(rec.actions)) return rec.actions;
    if (Array.isArray(rec.action)) return rec.action;
    return [rec];
  }
  return [];
}

function parseOneVlmAction(c: unknown): Record<string, unknown> | null {
  if (!c || typeof c !== "object") return null;
  const a = c as Record<string, unknown>;
  const kind =
    typeof a.kind === "string"
      ? a.kind
      : typeof a.action === "string"
        ? a.action
        : "";
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const pt = (o: unknown): { x: number; y: number } | null => {
    if (!o || typeof o !== "object") return null;
    const r = o as Record<string, unknown>;
    const x = num(r.x);
    const y = num(r.y);
    return x !== null && y !== null ? { x, y } : null;
  };

  if (kind === "click" || kind === "move") {
    const x = num(a.x);
    const y = num(a.y);
    if (x === null || y === null) return null;
    const out: Record<string, unknown> = { kind, x, y };
    if (
      kind === "click" &&
      (a.button === "left" || a.button === "right" || a.button === "center")
    ) {
      out.button = a.button; // 逻辑名透传（INV-28：raw button code 不经此路径产生）
    }
    return out;
  }
  if (kind === "drag") {
    // from/to 双形态：嵌套 {from:{x,y}} 或平铺 {from_x,from_y}
    const fromNest = pt(a.from);
    const toNest = pt(a.to);
    const fromX = fromNest?.x ?? num(a.from_x);
    const fromY = fromNest?.y ?? num(a.from_y);
    const toX = toNest?.x ?? num(a.to_x);
    const toY = toNest?.y ?? num(a.to_y);
    if (
      fromX === null || fromY === null ||
      toX === null || toY === null
    ) {
      return null;
    }
    return { kind: "drag", from_x: fromX, from_y: fromY, to_x: toX, to_y: toY };
  }
  if (kind === "scroll") {
    const dx = num(a.dx);
    const dy = num(a.dy);
    if (dx === null && dy === null) return null;
    const out: Record<string, unknown> = { kind: "scroll", dx: dx ?? 0, dy: dy ?? 0 };
    const x = num(a.x);
    const y = num(a.y);
    if (x !== null && y !== null) {
      out.x = x;
      out.y = y;
    }
    return out;
  }
  return null;
}

/** VLM 原始返回截断摘要（debug 附注；不泄全量——500 上界同旧 @vlm 条目）。 */
function summarizeVlmResult(vlmResult: unknown): string {
  try {
    const s =
      vlmResult && typeof vlmResult === "object"
        ? JSON.stringify(vlmResult)
        : String(vlmResult);
    return s.slice(0, 500);
  } catch {
    return "[unserializable]";
  }
}

/** vlm 动作 → audit ref 标签（真执行结果条目用；CGEventProvider.specRefLabel 同范式）。 */
function vlmActionRefLabel(a: Record<string, unknown>): string {
  if (a.kind === "click") {
    return `vlm_click@(${a.x},${a.y})`;
  }
  if (a.kind === "move") {
    return `vlm_move@(${a.x},${a.y})`;
  }
  if (a.kind === "drag") {
    return `vlm_drag(${a.from_x},${a.from_y})->(${a.to_x},${a.to_y})`;
  }
  if (a.kind === "scroll") {
    return `vlm_scroll(${a.dx},${a.dy})`;
  }
  return "vlm_action";
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

// ============================================================
// 生产 vlmCaller（v1.8 Phase E / D3 接线）
// ============================================================
/**
 * 构造生产 VLM 调用器：每次调用 connectHttp(endpoint) → callTool("vlm", ...) → close。
 *
 * v1.8 Phase E（D3）前：ScreenshotVlmProvider 构造时 opts.vlmCaller 恒缺省 null
 * → 即便配了 LASSO_VLM_ENDPOINT，act() 也恒走 `vlm_unavailable`（接线缺口）。
 * 现由 index.ts 装配：LASSO_VLM_ENDPOINT 已配 → 注入本工厂产物；未配 → 不注入
 * （保持 unavailable 诚实语义，不伪造可用性）。
 *
 * 设计（D10 解耦不变）：
 *  - 每次调用独立 connect/close（VLM 调用频率低，不值得常驻连接 + 断线重连状态机）
 *  - timeoutMs 经 Promise.race 兜底（McpClient.callTool 无 signal 参数）
 *  - VLM 返回 shape 不在本层锁（v0.3.5 既定；M0.5b 验收后再锁 schema）
 */
export function createMcpVlmCaller(): VlmCaller {
  return async (req) => {
    const client = await McpClient.connectHttp(
      { name: "lasso-vlm", version: "0.1.0" },
      req.endpoint,
      {},
    );
    try {
      return await withTimeout(
        client.callTool(DEFAULT_VLM_TOOL, {
          image: `data:image/png;base64,${req.base64}`,
          prompt: req.prompt,
          width: req.width,
          height: req.height,
        }),
        req.timeoutMs,
        "vlm_timeout",
      );
    } finally {
      await client.close();
    }
  };
}

/** Promise.race 超时兜底（timer unref：不阻止进程退出；测试进程不等残留 timer）。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}:${ms}ms`)), ms);
    // Node 的 setTimeout 返回 Timeout（有 unref）；非 Node 环境（理论不达）防御跳过
    if (typeof t === "object" && t !== null && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

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
  // v1.18.2（doc/29 Y4）：tcc_denied / tcc_screen_recording_denied → unknown
  // （屏幕录制权限是本档（VLM 截屏）缺失，非跨档语义否定——与 ax/appleScript 档
  // 的 TCC 是不同权限；didnt 会短路降级链 + recordSuccess 假健康）。
  if (
    resp.error_kind === "app_not_found" ||
    resp.error_kind === "invalid_params"
  ) {
    return "didnt";
  }
  return "unknown";
}

/** 默认 VLM 工具名（导出便于单测断言）。 */
export { DEFAULT_VLM_TOOL };
