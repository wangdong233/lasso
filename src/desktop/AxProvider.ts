/**
 * AxProvider（parse4 §2.1 + §3.2 + §4.3）
 *
 * DesktopChannel（Phase C 落地）的两个 provider 之一：AXAPI 主路径。
 * 职责：把 DesktopChannel.observe/act 的业务请求翻译成 RustBridge.call，
 * 把 Rust helper 返回的 AxNode 树经 OutlineMapper 标准化为 OutlineNode。
 *
 * 不做的事（深模块边界 / 不缠绕）：
 *  - 不做 fallback（FallbackDecider 在 DesktopChannel 层调度，本类专心 ax 路径）
 *  - 不做熔断（CircuitBreaker 在 DesktopChannel 层挂）
 *  - 不做平台 API 调用（INV-21：全经 RustBridge；v1.0 经 AxBackend 薄壳再经 RustBridge）
 *  - 不做 stateId 缓存（v0.3.5 每次 ax_snapshot 都 re-walk；cache 在 v0.4+）
 *  - 不做平台路由（v1.0 INV-60：经 AxBackendFactory 注入对应 backend；本类不感知平台）
 *
 * v1.0 构造契约（parse11 §3.1 + §7.2 Phase A）：
 *  - v0.3.5：constructor(private readonly rust: RustBridge)
 *  - v1.0  ：constructor(private readonly backend: AxBackend)
 *  - 业务逻辑零改：原 this.rust.call("ax_snapshot", ...) → this.backend.snapshot(...)
 *    返同 RustResponse，outcome / OutlineMapper / served_by / retrieval_method 不变
 *  - retrieval_method 仍标 "ax_snapshot" / "ax_find" / "ax_act"（语义层标识，
 *    指「AX 抽象层的方法」，三平台共享；不是 Rust method 名真值）
 *
 * 错误契约（parse4 §3.1.2 error_kind 表）：
 *  - rust helper 返 ok=false + error_kind="tcc_denied"     → outcome=didnt（明确"否"：缺权限）
 *  - rust helper 返 ok=false + error_kind="app_not_found"   → outcome=didnt（明确"否"：app 没开）
 *  - rust helper 返 ok=false + error_kind="not_implemented" → outcome=unknown（Phase B 占位）
 *  - rust helper 返 ok=false + 其他 error_kind              → outcome=unknown（触发 fallback）
 *  - rust helper 返 ok=true                                 → outcome=worked
 *
 * 借鉴：13 §3.5 AxProvider；pi-computer-use 的 provider 抽象；
 * FallbackDecider 的 InteractResult 信封风格（统一交付）。
 */
import type { AxBackend } from "./AxBackend.js";
import type { RustResponse } from "../subprocess/RustBridge.js";
import { axTreeToOutline, pruneToInteractive } from "./OutlineMapper.js";
import type {
  AxNode,
  DesktopOptions,
  DesktopResult,
  OutlineSnapshot,
  WhereClause,
} from "./desktop-types.js";
import type {
  InteractResult,
  Outcome,
} from "../types.js";

// ============================================================
// 错误契约（parse4 §3.1.2 error_kind → Outcome 映射）
// ============================================================
/**
 * 明确"否"的 error_kind（语义否定，应短路 outcome=didnt 而非触发 fallback）。
 * 其他 error_kind 一律视为 unknown（允许 fallback）。
 */
const DIDNT_ERROR_KINDS = new Set<string>([
  "tcc_denied",
  "tcc_screen_recording_denied",
  "app_not_found",
  "invalid_params",
]);

/**
 * RustResponse → Outcome 映射（错误契约，parse4 §3.1.2）。
 *  - ok=true                    → "worked"
 *  - ok=false + DIDNT_ERROR_KINDS → "didnt"
 *  - ok=false + 其他              → "unknown"
 */
function outcomeOf(resp: RustResponse): Outcome {
  if (resp.ok) return "worked";
  if (resp.error_kind && DIDNT_ERROR_KINDS.has(resp.error_kind)) return "didnt";
  return "unknown";
}

/** stateId 生成（v0.3.5 简化：UUID v4；v0.4+ 可加 LRU + 内容 hash）。 */
function newStateId(): string {
  return cryptoRandom();
}

// node:crypto.randomUUID 在 Node 20+ 可用；为可测性 wrap 一层。
function cryptoRandom(): string {
  // 直接调 globalThis.crypto.randomUUID（Node 20+ webcrypto 全局）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // 极端兜底（理论上 Node 20+ 不会走到）：拼 16 hex
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================
// AxProvider
// ============================================================
/**
 * AXAPI 主路径 provider（v0.3.5 DesktopChannel 主 provider）。
 *
 * INV-21：本类不出现平台 API 字面量；所有平台调用经 backend.snapshot/find/act
 *         → backend 内部调 RustBridge.call("ax_*"|"uia_*"|"atspi_*")。
 *
 * INV-60（v1.0）：本类不直接 new 任一 backend class；构造时由 index.ts 经
 *                AxBackendFactory.create(rust) 注入对应平台 backend。
 */
export class AxProvider {
  /** served_by 标识（写入 InteractResult.served_by）。 */
  static readonly NAME = "desktop.ax";

  /**
   * v1.0 构造契约（parse11 §3.1）：接 AxBackend（由 AxBackendFactory 路由）。
   *
   *  - 生产路径：new AxProvider(AxBackendFactory.create(rust))
   *  - 测试路径：new AxProvider(new MacAxBackend(mockRust)) 或直接 mock AxBackend
   *
   * INV-60 衍生：本构造器不接 RustBridge 直接类型 —— 强制走 factory 路由。
   */
  constructor(private readonly backend: AxBackend) {}

  /**
   * snapshot action：调 backend.snapshot → OutlineMapper 映射 → OutlineSnapshot。
   *
   * @returns InteractResult<OutlineSnapshot>：
   *   - worked  : data = { stateId, root, createdAt }
   *   - didnt   : data=null, error=error_kind（tcc_denied / app_not_found / ...）
   *   - unknown : data=null, error=error_kind（触发 DesktopChannel fallback 链）
   */
  async snapshot(
    opts: DesktopOptions,
  ): Promise<InteractResult<OutlineSnapshot>> {
    const maxDepth = opts.max_depth ?? 8;
    const resp = await this.backend.snapshot(opts.app, maxDepth);
    const outcome = outcomeOf(resp);
    if (outcome !== "worked") {
      return {
        outcome,
        data: null,
        served_by: AxProvider.NAME,
        fallback_used: false,
        retrieval_method: "ax_snapshot",
        error: resp.error ?? resp.error_kind,
      };
    }
    // 校验 result shape 是 AxNode（守护 wire 漂移）
    const root = (resp.result as { root?: AxNode } | undefined)?.root ??
      (resp.result as AxNode | undefined);
    if (!root || typeof root !== "object" || !Array.isArray(root.children)) {
      return {
        outcome: "unknown",
        data: null,
        served_by: AxProvider.NAME,
        fallback_used: false,
        retrieval_method: "ax_snapshot",
        error: "bad_ax_tree_shape",
      };
    }
    const { root: outlineRoot } = axTreeToOutline(root);
    // v1.2（doc/14 §4.2d）：interactiveOnly opt-in 后处理剪枝（INV-70：默认不过滤 byte-identical v1.1）
    const finalRoot = opts.interactive_only ? pruneToInteractive(outlineRoot) : outlineRoot;
    const snapshot: OutlineSnapshot = {
      stateId: newStateId(),
      root: finalRoot,
      createdAt: Date.now(),
    };
    return {
      outcome: "worked",
      data: snapshot,
      served_by: AxProvider.NAME,
      fallback_used: false,
      retrieval_method: "ax_snapshot",
    };
  }

  /**
   * find action：调 ax_find（v0.3.5 每次 re-walk）。
   *
   * @returns InteractResult<{matches, count}>：
   *   - worked : matches 数组（@eN ref + role + label + rect）
   *   - didnt  : 0 matches 不算 didnt（worked + count=0；find=0 是合法答案）
   *   - 错误契约同 snapshot
   */
  async find(
    opts: DesktopOptions,
  ): Promise<InteractResult<{ matches: unknown[]; count: number }>> {
    if (!opts.where) {
      return {
        outcome: "didnt",
        data: null,
        served_by: AxProvider.NAME,
        fallback_used: false,
        retrieval_method: "ax_find",
        error: "missing_where_clause",
      };
    }
    const maxDepth = opts.max_depth ?? 8;
    const resp = await this.backend.find(
      opts.app,
      maxDepth,
      opts.where as WhereClause,
    );
    const outcome = outcomeOf(resp);
    if (outcome !== "worked") {
      return {
        outcome,
        data: null,
        served_by: AxProvider.NAME,
        fallback_used: false,
        retrieval_method: "ax_find",
        error: resp.error ?? resp.error_kind,
      };
    }
    const result = (resp.result ?? {}) as { matches?: unknown[]; count?: number };
    const matches = Array.isArray(result.matches) ? result.matches : [];
    return {
      outcome: "worked",
      data: { matches, count: matches.length },
      served_by: AxProvider.NAME,
      fallback_used: false,
      retrieval_method: "ax_find",
    };
  }

  /**
   * act action：调 ax_act（Phase B Rust 端占位，返 not_implemented；M0.5b 落地）。
   *
   * v0.3.5 Phase B：ax_act 在 Rust helper 返 not_implemented → 本方法返
   * outcome=unknown + error="not_implemented"（让 DesktopChannel fallback 链
   * 走到 screenshotVlm 档；M0.5b 后 ax_act 真实装则 outcome=worked）。
   *
   * v0.4 M0.4b 语义调整（4-tier 衍生）：
   *  - 「无 actions」从 didnt 改为 unknown（让链继续到 appleScript / cgEvent /
   *    screenshotVlm）。原 v0.3.5 didnt 语义在 2-tier 下成立（ax 失败 = 整个
   *    desktop 不可用），但 4-tier 下 appleScript/cgEvent 各有独立 domain，
   *    ax 「无 actions」= 「ax 无事可做」应让链尝试其他档。
   *  - 不破坏既有 v0.3.5 测试：现有 spec 不测 ax no-actions 的 didnt 短路。
   */
  async act(
    opts: DesktopOptions,
  ): Promise<InteractResult<DesktopResult>> {
    if (!opts.actions || opts.actions.length === 0) {
      // 4-tier：ax 无 actions → unknown（让链继续到 appleScript/cgEvent/screenshotVlm）
      return {
        outcome: "unknown",
        data: null,
        served_by: AxProvider.NAME,
        fallback_used: false,
        retrieval_method: "ax_act",
        error: "no_actions_specified",
      };
    }
    const resp = await this.backend.act(opts.actions);
    const outcome = outcomeOf(resp);
    if (outcome !== "worked") {
      return {
        outcome,
        data: null,
        served_by: AxProvider.NAME,
        fallback_used: false,
        retrieval_method: "ax_act",
        error: resp.error ?? resp.error_kind,
      };
    }
    const result = (resp.result ?? {}) as DesktopResult;
    return {
      outcome: "worked",
      data: result,
      served_by: AxProvider.NAME,
      fallback_used: false,
      retrieval_method: "ax_act",
    };
  }
}
