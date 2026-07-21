/**
 * BrowseChannel（parse1 §3.5 + §4.2，抽象共享层）
 *
 * BrowseHeadless / BrowseLoggedIn 共用的抽象基类。继承 UiChannel（UI 层）。
 *
 * 核心铁律（不变量 INV-6）：dispatch 走 Map 注册表，不走 if-else 链。
 *  Lasso action space  ──→  chrome-devtools-mcp tool
 *  ────────────────────────────────────────────────────
 *   navigate            ──→  navigate_page
 *   snapshot            ──→  take_snapshot
 *   screenshot          ──→  take_screenshot
 *   extract             ──→  take_snapshot + 文本抽取
 *   click               ──→  click
 *   fill                ──→  fill_form
 *   wait                ──→  wait_for
 *   evaluate            ──→  evaluate_script
 * 上游工具名漂移只影响这张 Map（单点改）—— 风险 L1（parse1 §7.1）的缓解。
 *
 * 流程（parse1 §3.5）：
 *  1. handler = actionDispatch.get(action) → 找不到 → outcome=didnt
 *  2. c = await getMcpClient()  （子类决定走 headless 还是 logged_in）
 *  3. partial = await handler(c, url, options)
 *  4. state_id = randomUUID() + 写盘（state-store.ts）→ content_path
 *  5. 返回 InteractResult<BrowseResult>：preview ≤1k tokens
 *
 * 借鉴：08 §3.2 + 附录 A；chrome-devtools-mcp 工具名（§4.2 表）；
 * mcp-chrome chrome_computer action-enum 折叠思想。
 */
import { randomUUID } from "node:crypto";
import { UiChannel } from "./UiChannel.js";
import type {
  BrowseOptions,
  BrowseResult,
  ChannelStatus,
  Health,
  InteractResult,
  Outcome,
} from "../types.js";
import type { McpClient } from "../subprocess/McpClient.js";
import { writeState, withOperation } from "../util/state-store.js";
import { logger } from "../util/logger.js";
import type { ExpectCondition } from "../types.js";
import type { Step, StepPartial, ChainResult } from "../browse/steps-types.js";
import {
  expectPoll,
  type ConditionSnapshot,
  type ExpectPollOptions,
} from "../browse/ExpectPoll.js";
import { StepEngine, type HighRiskGateLike } from "../browse/StepEngine.js";
import { BudgetTracker } from "../fallback/BudgetTracker.js";
import { applyOutputEnvelope } from "../util/output-envelope.js";

// ============================================================
// 类型
// ============================================================
/**
 * Action handler 签名：取一个 McpClient + URL + 选项，返回 BrowseResult 的部分字段。
 * 不写盘、不返 InteractResult——那是 browse() 的职责。
 */
export type ActionHandler = (
  client: McpClient,
  url: string,
  opts: BrowseOptions,
) => Promise<Partial<BrowseResult>>;

/** preview 字段软上限（≈1k tokens；粗算 4 chars/token）。 */
const PREVIEW_MAX_CHARS = 4000;

// ============================================================
// BrowseChannel 抽象
// ============================================================
export abstract class BrowseChannel extends UiChannel {
  abstract readonly name: string; // "browse_headless" / "browse_logged_in"

  /** 子类提供 McpClient（headless 子进程 / logged_in 子进程 各自拿）。 */
  protected abstract getMcpClient(): Promise<McpClient>;

  // ============================================================
  // INV-6: dispatch 走 Map
  // ============================================================
  /**
   * Lasso action → handler 的注册表。
   * 这是 INV-6 的核心：所有新 action 加这里一行，不写 if-else 链。
   */
  protected readonly actionDispatch = new Map<string, ActionHandler>([
    ["navigate", doNavigate],
    ["snapshot", doSnapshot],
    ["screenshot", doScreenshot],
    ["extract", doExtract],
    ["click", doClick],
    ["fill", doFill],
    ["wait", doWait],
    ["evaluate", doEvaluate],
  ]);

  /** BaseChannel 抽象方法实装：触网活性 + 延迟（基于 listTools 探测）。 */
  async isAvailable(): Promise<boolean> {
    try {
      await this.getMcpClient();
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<ChannelStatus> {
    try {
      const t0 = Date.now();
      const c = await this.getMcpClient();
      await c.listTools();
      return { available: true, latency_ms: Date.now() - t0 };
    } catch (e) {
      return { available: false, note: String(e) };
    }
  }

  async healthCheck(): Promise<Health> {
    const s = await this.status();
    if (!s.available) return "down";
    if (s.latency_ms !== undefined && s.latency_ms > 5000) return "degraded";
    return "healthy";
  }

  /**
   * 主入口（parse1 §3.5；v0.3 入口分流 parse3 §3.1）。
   *
   * 入口分流：
   *  - options.steps 非空 → 转发到 StepEngine.runChain（v0.3 新路径）
   *  - 否则               → v0.2 单 action 路径（不动）
   *
   * INV-12：两条路径都经 withOperation() ALS 包裹（请求级隔离 + StateStore.epoch 派生）。
   * 永不抛异常——所有失败路径走 InteractResult。
   */
  async browse(
    url: string,
    action: string,
    options: BrowseOptions,
  ): Promise<InteractResult<BrowseResult>> {
    // --------------------------------------------------------------
    // v0.3 入口分流：options.steps 非空 → StepEngine.runChain
    // --------------------------------------------------------------
    if (Array.isArray(options.steps) && options.steps.length > 0) {
      // resourceKey：channel 全名 + url（粗粒度隔离；StepEngine 内每个 step 独立 stateId）
      const resourceId = `${this.name}:${url}`;
      // epoch = 0（v0.3 不接 ResourceScheduler；parse3 §4.3 推迟到 v0.5+）
      return withOperation(resourceId, 0, async () => {
        const chain = await this.runChain(url, options.steps as Step[]);
        return this.wrapChainResult(chain);
      });
    }

    // --------------------------------------------------------------
    // v0.2 单 action 路径（保留；INV-12 包裹）
    // --------------------------------------------------------------
    const resourceId = `${this.name}:${url}`;
    return withOperation(resourceId, 0, async () =>
      this.browseSingle(url, action, options),
    );
  }

  /**
   * v0.2 单 action 路径（原 browse() 实装，零行为变更；仅迁出便于 browse() 入口分流）。
   */
  private async browseSingle(
    url: string,
    action: string,
    options: BrowseOptions,
  ): Promise<InteractResult<BrowseResult>> {
    const handler = this.actionDispatch.get(action);
    if (!handler) {
      return {
        outcome: "didnt",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
        error: `unknown_action:${action}`,
      };
    }

    try {
      const c = await this.getMcpClient();
      const partial = await handler(c, url, options);

      // 写盘 + 短指针（v0.1 简化版；v0.3 升 StateStore LRU + stateId 反查）
      const stateId = randomUUID();
      const contentPath = await writeState(this.name, stateId, {
        url,
        action,
        ...partial,
      });

      return {
        outcome: "worked",
        data: {
          url,
          action,
          state_id: stateId,
          content_path: contentPath,
          preview: truncatePreview(partial.preview ?? ""),
          title: partial.title,
          final_url: partial.final_url ?? url,
        },
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
      };
    } catch (e) {
      const msg = String(e);
      logger.warn({ evt: "browse_action_error", channel: this.name, action, error: msg });
      return {
        outcome: classifyBrowseError(msg, action),
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "chrome_devtools_mcp",
        error: msg,
      };
    }
  }

  // ============================================================
  // v0.3: runChain + wrapChainResult（parse3 §3.1 + §3.4，Phase C 落地）
  // ============================================================
  /**
   * 构造 StepEngine + 跑 chain。子类（LoggedInChannel）可重写 createHighRiskGate()
   * 注入 gate（Phase D）；默认返回 null（headless 不启用）。
   *
   * 注意：chain 级 budget（120s）实例化在此处（每 chain 一个新 BudgetTracker），
   * 由本方法拥有；外层 FallbackDecider 的 BudgetTracker 是另一回事（per-fallback-plan）。
   */
  async runChain(url: string, steps: Step[]): Promise<InteractResult<ChainResult>> {
    const budget = new BudgetTracker();
    const gate = this.createHighRiskGate();
    const engine = new StepEngine(this, budget, gate);
    return engine.runChain(url, steps);
  }

  /**
   * 工厂方法：子类重写返回 HighRiskGate 实例（Phase D）。
   * 默认 null = 不启用（HeadlessChannel 用默认；LoggedInChannel Phase D 重写）。
   */
  protected createHighRiskGate(): HighRiskGateLike | null {
    return null;
  }

  /**
   * 把 ChainResult 包装成 BrowseResult 形状，再走 boundedOutput envelope。
   * - chain 成功 → data 含完整 actions_and_results（可能触发 48KiB 落盘）
   * - chain 失败 → data.stopped_at 暴露终止边界；CC 据此判断是否换路径
   */
  private wrapChainResult(
    chain: InteractResult<ChainResult>,
  ): InteractResult<BrowseResult> {
    if (!chain.data) {
      // chain 异常路径（不应发生，但兜底）：保留 outcome + error
      return {
        outcome: chain.outcome,
        data: null,
        served_by: chain.served_by,
        fallback_used: chain.fallback_used,
        retrieval_method: chain.retrieval_method,
        error: chain.error,
        partial_failures: chain.partial_failures,
      };
    }

    // 把 ChainResult 序列化为 JSON，过 applyOutputEnvelope
    // （48KiB 上限：大 chain 会落盘 + 返回 preview + @oN ref）
    const json = JSON.stringify(chain.data);
    const envelope = applyOutputEnvelope(json, "chain result too large: narrow selectors or split into smaller steps");

    // actions_and_results 的最后一个 result 提供 state_id（兼容 v0.2 BrowseResult.state_id）
    const lastResult = chain.data.actions_and_results.at(-1)?.results[0];
    const finalStateId = lastResult?.state_id;

    return {
      outcome: chain.outcome,
      data: {
        url: chain.data.final_url ?? "",
        action: "chain",
        state_id: finalStateId,
        content_path: undefined,
        // preview 始终走 v0.2 的 4000-char 上限契约；完整 chain 数据走 data.chain / data.bounded_output
        preview: truncatePreview(envelope.preview),
        final_url: chain.data.final_url,
        // chain 专属字段（v0.3 扩展；v0.2 调用方不读）
        ...(chain.data.stopped_at ? { stopped_at: chain.data.stopped_at } : {}),
        ...(envelope.truncated ? { bounded_output: envelope } : {}),
        // 小 chain 直接把 actions_and_results 放 data.chain；大 chain 走 bounded_output.read_text
        ...(!envelope.truncated ? { chain: chain.data } : {}),
      },
      served_by: chain.served_by,
      fallback_used: chain.fallback_used,
      retrieval_method: chain.retrieval_method,
      error: chain.error,
      partial_failures: chain.partial_failures,
    };
  }

  // ============================================================
  // v0.3: executeStep + runExpect（parse3 §3.1 + §3.2，Phase B 落地）
  // ============================================================
  //
  // 设计：这两个方法 expose 给 Phase C 的 StepEngine 调用。
  // browse() 入口的分流（steps vs 单 action）暂不接入（Phase C 才打开）。
  // 本阶段它们是新增公开方法，不破坏 v0.2 单 action 路径。
  //
  // executeStep 的契约（parse3 §3.1）：
  //  1. step.expect 存在时 → act 前先 quickSnapshot（runExpect 判 preexisting 用）
  //  2. 委托 actionDispatch 拿到 handler，跑 act（expect 字段剥掉防止 doWait 误用）
  //  3. 持久化状态（persistState，与 browse() 共用）
  //  4. 返回 StepPartial（含 preSnapshot）—— StepEngine 拼 actions_and_results
  //
  // runExpect 的契约（parse3 §3.2）：
  //  - 薄包装：直接委托 ExpectPoll.expectPoll
  //  - 调用方负责把 expect failed 强制 outcome=didnt + 终止 chain（INV-13）
  //
  /**
   * 执行单步（v0.3 StepEngine 调用；不破坏 v0.2 browse()）。
   * step.expect 存在时先抓 preSnapshot，act 后由 runExpect 用它判 preexisting。
   */
  async executeStep(url: string, step: Step): Promise<StepPartial> {
    const handler = this.actionDispatch.get(step.action);
    if (!handler) {
      throw new Error(`unknown_action:${step.action}`);
    }
    const c = await this.getMcpClient();

    // 1. act 前 quickSnapshot（仅 step.expect 存在时）
    //    失败时（页面未就绪 / evaluate 不可用）→ undefined，跳过 preexisting 判定
    const preSnapshot: ConditionSnapshot | undefined = step.expect
      ? await this.quickSnapshot(c)
      : undefined;

    // 2. 委托 handler —— 显式剥 expect，避免 doWait 误把 postcondition 当 wait 目标
    const opts: BrowseOptions = {
      selectors: step.selectors,
      js: step.js,
      timeout_ms: step.timeout_ms,
    };

    try {
      const partial = await handler(c, url, opts);
      // 3. 持久化状态（与 browse() 共用 persistState 路径）
      const stored = await this.persistState(url, step.action, partial);
      return {
        outcome: "worked",
        preview: partial.preview,
        state_id: stored.state_id,
        content_path: stored.content_path,
        preSnapshot,
      };
    } catch (e) {
      const msg = String(e);
      logger.warn({
        evt: "execute_step_error",
        channel: this.name,
        action: step.action,
        error: msg,
      });
      return {
        outcome: classifyBrowseError(msg, step.action),
        error: msg,
        preSnapshot,
      };
    }
  }

  /**
   * 委托 ExpectPoll：100ms poll + 三态。
   * 调用方（StepEngine）负责 INV-13：failed → outcome=didnt + 终止 chain。
   */
  async runExpect(
    cond: ExpectCondition,
    pre?: ConditionSnapshot,
    opts?: ExpectPollOptions,
  ): Promise<"verified" | "preexisting" | "failed"> {
    const c = await this.getMcpClient();
    return expectPoll(c, cond, pre, opts);
  }

  /**
   * act 前抓一次「轻量」快照（仅 url + body_text）。
   * - 走 evaluate_script 单次调用（避免 take_snapshot 全量开销）
   * - body_text 截 16 KiB（够 conditionHolds 判 text/url_contains）
   * - 失败时返回不含字段的 snapshot（caller 会跳过 preexisting 判定）
   */
  private async quickSnapshot(c: McpClient): Promise<ConditionSnapshot> {
    const expr = `(function(){
      try {
        var body = (document.body && document.body.innerText) || "";
        if (body.length > 16384) body = body.slice(0, 16384);
        return JSON.stringify({ url: window.location.href, body_text: body });
      } catch (e) {
        return JSON.stringify({ url: "", body_text: "" });
      }
    })()`;
    try {
      const r = (await c.callTool("evaluate_script", {
        function: expr,
      })) as EvaluateResult;
      const parsed = JSON.parse(extractEvalPreview(r) || "{}") as {
        url?: string;
        body_text?: string;
      };
      return {
        url: parsed.url ?? "",
        body_text: parsed.body_text ?? "",
        captured_at: Date.now(),
      };
    } catch (e) {
      logger.warn({
        evt: "quick_snapshot_failed",
        channel: this.name,
        error: String(e),
      });
      return { captured_at: Date.now() };
    }
  }

  /**
   * 持久化 step 状态（与 v0.2 browse() 共用 writeState 路径）。
   * 返回 state_id + content_path。executeStep 和未来 Phase C 的 BrowseChannel
   * 改造后 browse() 也会改走此 helper（消除重复）。
   */
  private async persistState(
    url: string,
    action: string,
    partial: Partial<BrowseResult>,
  ): Promise<{ state_id: string; content_path: string }> {
    const stateId = randomUUID();
    const contentPath = await writeState(this.name, stateId, {
      url,
      action,
      ...partial,
    });
    return { state_id: stateId, content_path: contentPath };
  }
}

// ============================================================
// Action handlers
// ============================================================
// 注意：chrome-devtools-mcp 工具返回 SDK 标准 { content: [{type:'text', text:'...'}], isError }。

async function doNavigate(
  c: McpClient,
  url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  const r = (await c.callTool("navigate_page", {
    type: "url",
    url,
    ignoreCache: opts.no_cache ?? false,
  })) as NavigateResult;
  return { final_url: extractFinalUrl(r), preview: "navigated" };
}

async function doSnapshot(
  c: McpClient,
  _url: string,
  _opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  const r = (await c.callTool("take_snapshot", {})) as SnapshotResult;
  const { title, text } = extractSnapshot(r);
  return { title, preview: text };
}

async function doScreenshot(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // chrome-devtools-mcp 接受 filePath 落盘；由它自己生成，我们只回路径占位。
  const filePath = `/tmp/lasso-screenshot-${randomUUID()}.png`;
  await c.callTool("take_screenshot", {
    format: "png",
    filePath,
    fullPage: opts.screenshot?.full ?? false,
  });
  return { preview: `screenshot saved to ${filePath}` };
}

async function doExtract(
  c: McpClient,
  _url: string,
  _opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // extract 复用 take_snapshot，再剥 snapshot 文本作为整页抽取。
  const r = (await c.callTool("take_snapshot", {})) as SnapshotResult;
  const { title, text } = extractSnapshot(r);
  return { title, preview: text };
}

async function doClick(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // 选项驱动：opts.selectors.click 是 a11y uid
  const uid = opts.selectors?.click;
  if (!uid) throw new Error("click: opts.selectors.click (uid) required");
  await c.callTool("click", { uid });
  return { preview: `clicked ${uid}` };
}

async function doFill(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // opts.selectors 是 { uid: value } 多字段表（fill_form 一次填多个）
  const elements = opts.selectors;
  if (!elements) throw new Error("fill: opts.selectors required");
  const fillElems = Object.entries(elements).map(([uid, value]) => ({ uid, value }));
  await c.callTool("fill_form", { elements: fillElems });
  return { preview: `filled ${fillElems.length} fields` };
}

async function doWait(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  const text = opts.expect?.text;
  if (!text) throw new Error("wait: opts.expect.text required");
  await c.callTool("wait_for", { text: [text] });
  return { preview: `waited for "${text}"` };
}

async function doEvaluate(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  if (!opts.js) throw new Error("evaluate: opts.js required");
  const r = (await c.callTool("evaluate_script", {
    function: opts.js,
  })) as EvaluateResult;
  return { preview: extractEvalPreview(r) };
}

// ============================================================
// SDK 返回结构解析
// ============================================================
type TextBlock = { type: "text"; text?: string };
type ContentResult = { content?: TextBlock[]; isError?: boolean };

type NavigateResult = ContentResult;
type SnapshotResult = ContentResult;
type EvaluateResult = ContentResult;

/** navigate_page 返回里偶尔带 final_url；找不到就用 undefined（上游 fallback url）。 */
function extractFinalUrl(r: NavigateResult): string | undefined {
  const txt = firstText(r);
  if (!txt) return undefined;
  // chrome-devtools-mcp 现状返回结构不稳定，宽松解析：找 URL 子串
  const m = txt.match(/https?:\/\/\S+/);
  return m ? m[0] : undefined;
}

/** take_snapshot 返回的 a11y 文本树：抽 title（首行）+ 整文本预览。 */
function extractSnapshot(r: SnapshotResult): { title?: string; text: string } {
  const txt = firstText(r) ?? "";
  if (!txt) return { text: "" };
  // 首行往往是 page title（chrome-devtools-mcp snapshot 风格）
  const firstLine = txt.split("\n", 1)[0]?.trim();
  return { title: firstLine || undefined, text: txt };
}

function extractEvalPreview(r: EvaluateResult): string {
  return firstText(r) ?? "(no eval output)";
}

function firstText(r: ContentResult | undefined): string | undefined {
  if (!r?.content) return undefined;
  for (const b of r.content) {
    if (b.type === "text" && b.text) return b.text;
  }
  return undefined;
}

// ============================================================
// 工具
// ============================================================
/**
 * preview 软上限（parse1 §3.5）：超过 PREVIEW_MAX_CHARS 截断 + 省略号标记。
 * 注意：只是 token 经济学的粗保护；真正的 token 计数留给上游 CC 自身的 context 管理。
 */
function truncatePreview(s: string): string {
  if (s.length <= PREVIEW_MAX_CHARS) return s;
  return s.slice(0, PREVIEW_MAX_CHARS) + "\n…[truncated by lasso]";
}

/**
 * browse 错误 → outcome（10 §D.1）。
 *  - NEEDS_MANUAL_2FA → didnt（明确「需人」信号，不 fallback）
 *  - 404 / 403 / NXDOMAIN / ENOTFOUND → didnt
 *  - timeout / 429 / 5xx / 网络错 → unknown
 * action 名拼错不在这里出现（browse() 提前 didnt 返回）。
 */
function classifyBrowseError(msg: string, _action: string): Outcome {
  const m = msg.toLowerCase();
  if (m.includes("needs_manual_2fa")) return "didnt";
  if (m.includes("404") || m.includes("not_found")) return "didnt";
  if (m.includes("403") || m.includes("forbidden")) return "didnt";
  if (m.includes("enotfound") || m.includes("nxdomain")) return "didnt";
  return "unknown";
}
