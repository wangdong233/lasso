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
 *   pdf      (v0.5)     ──→  pdf  (CDP Page.printToPDF；cdp-actions.ts doPdf)
 *   console  (v0.5)     ──→  1.7.0 原生 list_console_messages 直调（cdp-actions.ts doConsole）
 *   network  (v0.5)     ──→  1.7.0 原生 list_network_requests 直调（cdp-actions.ts doNetwork）
 * （v1.12 round2 T2-2 注释修正：v0.5 时代的 evaluate_script 注入 PerformanceObserver
 *  路径已在 v1.11 1.7.0 迁移时原生化——src 无 PerformanceObserver 实现残留）
 * 上游工具名漂移只影响这张 Map（单点改）—— 风险 L1（parse1 §7.1）的缓解。
 * v0.5（parse6 §4.4）：pdf / network_log / console_log 上游工具名集中硬编码在 cdp-actions.ts
 *                      CDP_UPSTREAM_TOOL_NAMES 顶级 const；doctor CLI 探测。
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
import { writeFile, stat } from "node:fs/promises";
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
import {
  parseEvalResult,
  imageBlock,
  firstText as upstreamFirstText,
} from "../browse/upstream-response.js";
// v0.5 M0.5b/M0.5c（parse6 §2.1 + §3.3.3 + §3.4.2）：doPdf + doConsole + doNetwork
//   追加进 actionDispatch Map
// INV-33 守：pdf + console + network 三 action 必经 dispatch Map，禁第二套 dispatch
import { doPdf, doConsole, doNetwork } from "../browse/cdp-actions.js";

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

  /**
   * v1.9（parse17 §2.2 (d) 机制一）：action/step dispatch 后的保活 touch。
   *
   * 默认 no-op（cloud 通道无本地子进程）；HeadlessChannel / LoggedInChannel
   * override 成 subproc.touch(specName)——长 browse（多步导航 + ExpectPoll 轮询）
   * 进行中持续刷新 lastUsedAt，防 idle watchdog（默认 5min）误杀 in-flight 浏览器。
   */
  protected touchKeepalive(): void {
    // 默认 no-op
  }

  // ============================================================
  // INV-6: dispatch 走 Map
  // ============================================================
  /**
   * Lasso action → handler 的注册表。
   * 这是 INV-6 的核心：所有新 action 加这里一行，不写 if-else 链。
   *
   * v0.4 注（parse5 §4.3）：navigate 入口包一层 beforeNavigate hook，子类
   * （BrowserbaseChannel）按需注入 stealth。wrapNavigate 是私有 helper，
   * 默认 beforeNavigate 是 no-op —— HeadlessChannel / LoggedInChannel 不
   * override 即行为零变化（v0.3.5 测试不破）。
   */
  protected readonly actionDispatch = new Map<string, ActionHandler>([
    ["navigate", this.wrapNavigate(doNavigate)],
    ["snapshot", doSnapshot],
    ["screenshot", doScreenshot],
    ["extract", doExtract],
    ["click", doClick],
    ["fill", doFill],
    ["wait", doWait],
    ["evaluate", doEvaluate],
    // v0.5 M0.5b/M0.5c（parse6 §2.1 + §3.3.3 + §3.4.2）：追加 pdf + console + network entry
    // INV-33 守：pdf/console/network 三 action 必经 dispatch Map，禁第二套 dispatch。
    // screenshot 复用既有 v0.1 entry（不动）；pdf 由 doPdf 实装（chrome-devtools-mcp `pdf`）；
    // v1.11 起 network 由 1.7.0 原生 list_network_requests 直调（doNetwork）、console 由
    // 原生 list_console_messages 直调（doConsole）——v0.5「M0.5b 占位/PerformanceObserver
    // 注入」描述已过时（v1.12 round2 T2-2 注释修正；probe 语义与 observe-only 边界不变）。
    ["pdf", doPdf],
    ["console", doConsole],
    ["network", doNetwork],
  ]);

  /**
   * v0.4 hook（parse5 §4.3）：navigate 前 dispatch 反检测注入。
   *
   * 默认 no-op。HeadlessChannel / BrowserbaseChannel override 注入 stealth；
   * LoggedInChannel 默认不 override（复用本机 Chrome 已天然反检测，08 §7.2）。
   *
   * 设计：hook 是 protected method，子类多态生效；doNavigate 自身（自由函数）
   * 不感知 stealth —— stealth 是横切关注点，StealthEngine 接 McpClient 即可。
   */
  protected async beforeNavigate(_client: McpClient): Promise<void> {
    // default: no-op（v0.3.5 HeadlessChannel / LoggedInChannel 行为零变化）
  }

  /**
   * W1-DEF-1c（v1.8）：navigate **后** hook —— stealth 注入的正确时机。
   * 页面 JS 上下文随导航重置，导航前注入在新文档全部丢失（wave2 smoke 实证
   * navigator.webdriver 仍 true）；上游 0.3.0 不暴露
   * Page.addScriptToEvaluateOnNewDocument，只能在每次 navigate 完成后补注入
   * （覆盖当前文档直到下一次导航）。default no-op。
   */
  protected async afterNavigate(_client: McpClient): Promise<void> {}

  /**
   * wrapNavigate：把 navigate handler 包一层 beforeNavigate hook。
   * 私有 helper —— INV-6 dispatch Map 不动（仍是 8 条 entry，只 navigate 包一层）。
   */
  private wrapNavigate(handler: ActionHandler): ActionHandler {
    return async (c, url, opts) => {
      await this.beforeNavigate(c);
      const r = await handler(c, url, opts);
      // W1-DEF-1c：导航后注入（beforeNavigate 注入会随文档重置全部丢失）
      await this.afterNavigate(c);
      return r;
    };
  }

  /**
   * retrieval_method 标签（v0.4 抽出，原本硬编码 "chrome_devtools_mcp"）。
   * 子类（BrowserbaseChannel）override 标 "cloud_browserbase"；
   * HeadlessChannel / LoggedInChannel 默认 → "chrome_devtools_mcp"（v0.3.5 零变化）。
   */
  protected retrievalMethod(): string {
    return "chrome_devtools_mcp";
  }

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
        // W1-DEF-2b（v1.8）：action="navigate" + steps 时**先导航再跑链**
        // （此前 steps 分支丢弃 action，链跑在 about:blank 上——expectPoll 在
        // 空白页 30s 全 false，wave2 smoke 实证）。链内首 step 为 navigate 的
        // 旧范式（U-03-1）不受影响（StepEngine 自行处理）。
        if (action === "navigate" && url) {
          const nav = this.actionDispatch.get("navigate");
          if (nav) {
            try {
              const c = await this.getMcpClient();
              await nav(c, url, options);
            } catch (e) {
              // 导航失败（404 / DNS / 落盘类 didnt）→ 整链诚实终止
              const outcome = classifyBrowseError(String(e), action);
              return {
                outcome,
                data: null,
                served_by: this.name,
                fallback_used: false,
                retrieval_method: this.retrievalMethod(),
                error: String(e).slice(0, 200),
              };
            }
          }
        }
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
        retrieval_method: this.retrievalMethod(),
        error: `unknown_action:${action}`,
      };
    }

    try {
      const c = await this.getMcpClient();
      this.touchKeepalive(); // v1.9：action dispatch 后保活（防 idle watchdog 误杀）
      // W2-DEF-N1（v1.8.1）：URL 驱动的采集类 action 先导航到目标页——
      // 此前 doNetwork/doScreenshot/doPdf 直接在当前页（首会话 = about:blank）执行，
      // network 恒 0 entries（wave2 实证）。navigate 失败（404/DNS/...）由下方
      // catch 统一 classify；wrapNavigate 的 afterNavigate 顺带注入 stealth。
      if (NAV_FIRST_ACTIONS.has(action)) {
        const nav = this.actionDispatch.get("navigate");
        if (nav) await nav(c, url, options);
      }
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
          // v1.1（parse12 §3.3.1）：markdown 档元数据透传（仅 extract_mode=markdown* 时 partial 含这些字段）
          ...(partial.byline ? { byline: partial.byline } : {}),
          ...(partial.citations ? { citations: partial.citations } : {}),
          ...(partial.markdown_engine
            ? { markdown_engine: partial.markdown_engine }
            : {}),
        },
        served_by: this.name,
        fallback_used: false,
        retrieval_method: this.retrievalMethod(),
      };
    } catch (e) {
      const msg = String(e);
      logger.warn({ evt: "browse_action_error", channel: this.name, action, error: msg });
      return {
        outcome: classifyBrowseError(msg, action),
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: this.retrievalMethod(),
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
    this.touchKeepalive(); // v1.9：step dispatch 后保活（StepEngine 每 step 调）

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
      // wait step：expect 就是等待目标（等到了 postcondition 自然成立）——
      // 不剥则链内 wait 永远报 "opts.expect.text required"（wave2 smoke 实证）。
      // 其余 action 仍剥 expect（防 doWait 误把 postcondition 当 wait 目标）。
      ...(step.action === "wait" && step.expect
        ? { expect: step.expect }
        : {}),
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
    this.touchKeepalive(); // v1.9：expect 轮询前保活（ExpectPoll 可能持续数十秒）
    return expectPoll(c, cond, pre, opts);
  }

  /**
   * act 前抓一次「轻量」快照（仅 url + body_text）。
   * - 走 evaluate_script 单次调用（避免 take_snapshot 全量开销）
   * - body_text 截 16 KiB（够 conditionHolds 判 text/url_contains）
   * - 失败时返回不含字段的 snapshot（caller 会跳过 preexisting 判定）
   */
  private async quickSnapshot(c: McpClient): Promise<ConditionSnapshot> {
    // W1-DEF-1（v1.8）：chrome-devtools-mcp@0.3.0 evaluate_script 契约要求
    // **函数表达式**（上游自行调用），不再传 IIFE 语句串。
    const expr = `() => {
      try {
        var body = (document.body && document.body.innerText) || "";
        if (body.length > 16384) body = body.slice(0, 16384);
        return JSON.stringify({ url: window.location.href, body_text: body });
      } catch (e) {
        return JSON.stringify({ url: "", body_text: "" });
      }
    }`;
    try {
      const r = (await c.callTool("evaluate_script", {
        function: expr,
      })) as EvaluateResult;
      // W1-DEF-1b（v1.8）：上游 evaluate_script 返回 markdown 围栏包裹（见
      // browse/upstream-response.ts 实测契约），parseEvalResult 负责围栏提取 + 双层解码。
      const parsed = (parseEvalResult(r) as {
        url?: string;
        body_text?: string;
      } | undefined) ?? { url: "", body_text: "" };
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

  // ============================================================
  // v0.4 forest 调度层：listRoots（parse5 §3.1.4）
  // ============================================================
  /**
   * 枚举当前 CDP pages → forest 调度层用的 RootInfo 数据源。
   *
   * 设计要点（INV-26 衍生）：
   *  - 本方法是 BrowseChannel 对外**公共**方法，forest 调度层（index.ts）
   *    装配期调它收集 roots；不暴露 channel internal。
   *  - chrome-devtools-mcp 暴露的 `list_pages` 工具返回当前所有 page target。
   *  - HeadlessChannel 默认 1 个 about:blank；LoggedInChannel 返用户真实 tabs。
   *
   * 失败容忍（interact_roots 是辅助入口，永不抛异常影响主路径）：
   *  - 任何异常（subprocess 未起 / list_pages 失败） → 返空数组 + 调用方降级
   *
   * @returns 形如 `[{ contextId, url, title }]` 的轻量描述（不深抓 DOM）
   */
  async listRoots(): Promise<
    Array<{ contextId: string; url: string; title?: string }>
  > {
    try {
      const c = await this.getMcpClient();
      const r = (await c.callTool("list_pages", {})) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (r.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      return parseListPages(text);
    } catch {
      // 子进程未起 / list_pages 不可用 → 空数组（interact_roots 仍可工作，
      // 只是少 browse root；desktop root 不受影响）
      return [];
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
// list_pages 解析（chrome-devtools-mcp 兼容；宽松解析 wire-shape 漂移）
// ============================================================
/**
 * 把 list_pages 的文本输出解析成 `[{contextId, url, title?}]`。
 *
 * chrome-devtools-mcp 各版本输出格式略漂移（markdown 表格 / JSON / plain list）。
 * 本函数走宽松解析：
 *  - 抓 URL 子串（http(s)://...）作为 page url
 *  - contextId 取 url 的 sha1 后 8 位（不要求 list_pages 暴露 contextId；
 *    parse5 §4.1 V1 风险点已接受：identity 退化为 url 哈希；同 url 不同 tab 误复用）
 *  - title 取 URL 前一行（若 markdown 表格风格）；否则 = url
 *
 * 返空数组 = list_pages 没返任何 URL（可能 helper 未连通）。
 */
function parseListPages(
  text: string,
): Array<{ contextId: string; url: string; title?: string }> {
  if (!text) return [];
  const lines = text.split("\n");
  const out: Array<{ contextId: string; url: string; title?: string }> = [];
  // sha1 短哈希（够用；不引 crypto 重负载；inline djb2）
  const djb2 = (s: string): string => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/https?:\/\/\S+/);
    if (!m) continue;
    const url = m[0].replace(/[),.;]+$/, "");
    // title 候选：上一行的最后一个 cell（markdown 表格风格）
    const prev = i > 0 ? lines[i - 1] : "";
    const titleCell = prev.split("|").map((s) => s.trim()).filter(Boolean);
    const title = titleCell.length > 0 ? titleCell[titleCell.length - 1] : undefined;
    out.push({
      contextId: djb2(url),
      url,
      title: title && !title.match(/^https?:\/\//) ? title : undefined,
    });
  }
  return out;
}

// ============================================================
// Action handlers
// ============================================================
// 注意：chrome-devtools-mcp 工具返回 SDK 标准 { content: [{type:'text', text:'...'}], isError }。

/**
 * Chrome 导航错误签名（W1-DEF-5，v1.8）：navigate_page 返回文本或错误页 snapshot
 * 命中任一签名即判 dns_or_nav_error（outcome=didnt）。覆盖 DNS 失败 / 连接失败 /
 * 超时（Chrome 错误页文案 + net::ERR_* 代码）。
 */
const NAV_ERROR_SIGNATURES =
  /err_name_not_resolved|dns_probe|nxdomain|enotfound|err_connection_refused|err_connection_reset|err_connection_closed|err_address_unreachable|err_internet_disconnected|err_empty_response|err_timed_out|err_aborted|this site can'?t be reached|can'?t reach this page|webpage not available|took too long to respond/i;

/** 404 页特征（W1-DEF-5）：title 以 404 开头，或 "404" 与 "not found" 邻近出现。 */
const HTTP_404_SIGNATURE =
  /\b404\b[\s:.\-–—]{0,40}not\s*found|not\s*found[\s:.\-–—]{0,40}\b404\b|http\s*404/i;

async function doNavigate(
  c: McpClient,
  url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  let r: NavigateResult;
  try {
    r = (await c.callTool("navigate_page", {
      type: "url",
      url,
      ignoreCache: opts.no_cache ?? false,
    })) as NavigateResult;
  } catch (e) {
    const msg = String(e);
    // W1-DEF-5：上游 navigate 直接抛导航错（DNS / 连接失败）→ 显式 dns_or_nav_error
    if (NAV_ERROR_SIGNATURES.test(msg)) {
      throw new Error(`dns_or_nav_error:${msg.slice(0, 200)}`);
    }
    throw e;
  }

  if (r.isError) {
    const detail = firstText(r) ?? "navigate_is_error";
    if (NAV_ERROR_SIGNATURES.test(detail)) {
      throw new Error(`dns_or_nav_error:${detail.slice(0, 200)}`);
    }
    throw new Error(`nav_error:${detail.slice(0, 200)}`);
  }

  const finalUrl = extractFinalUrl(r) ?? url;

  // W1-DEF-5（v1.8）：navigate 成功 ≠ 页面正常——上游对 404 页 / Chrome DNS 错误页
  // 同样返成功（wave1 T-BROWSE-27 / U-08-3 实锤「假 worked」）。再取一次快照按
  // title/内容特征校验真实加载结果；校验通道自身失败不阻断（正常页仍 worked）。
  await verifyNavigatedPage(c, firstText(r) ?? "");

  return { final_url: finalUrl, preview: "navigated" };
}

/**
 * W1-DEF-5：navigate 后校验真实加载结果。
 *  - navigate 返回文本 / snapshot 内容命中 NAV_ERROR_SIGNATURES → throw dns_or_nav_error
 *  - snapshot title/content 命中 404 特征 → throw http_404
 *  - take_snapshot 失败（通道断/页面未就绪）→ 放行（校验 best-effort，不因校验工具
 *    失败把正常导航误判 didnt）
 */
async function verifyNavigatedPage(
  c: McpClient,
  navText: string,
): Promise<void> {
  if (NAV_ERROR_SIGNATURES.test(navText)) {
    throw new Error(`dns_or_nav_error:${navText.slice(0, 200)}`);
  }
  let snapText = "";
  try {
    const r = (await c.callTool("take_snapshot", {})) as SnapshotResult;
    snapText = (firstText(r) ?? "").slice(0, 2000);
  } catch {
    return;
  }
  if (NAV_ERROR_SIGNATURES.test(snapText)) {
    throw new Error(`dns_or_nav_error:${snapText.slice(0, 200)}`);
  }
  // HTTP 状态码权威检测（wave2 smoke 实证：httpbin /status/404 空 body 无内容特征，
  // 内容签名检测不可达）。PerformanceNavigationTiming.responseStatus（Chrome 109+）。
  try {
    const sr = (await c.callTool("evaluate_script", {
      function: `() => {
        try {
          var e = performance.getEntriesByType("navigation")[0];
          return e && typeof e.responseStatus === "number" ? e.responseStatus : 0;
        } catch (err) { return 0; }
      }`,
    })) as ContentResult;
    const status = Number(parseEvalResult(sr) ?? 0);
    if (status >= 400) {
      throw new Error(`http_${status}:${status >= 500 ? "server_error" : "client_error"}`);
    }
  } catch (e) {
    if (e instanceof Error && /^http_\d+/.test(e.message)) throw e;
    // evaluate 失败（页面 CSP / 未就绪）→ 跳过状态码检测，走内容签名兜底
  }
  const title = snapText.split("\n", 1)[0]?.trim() ?? "";
  if (/^404\b/.test(title) || HTTP_404_SIGNATURE.test(snapText)) {
    throw new Error(`http_404:${(title || snapText.slice(0, 120))}`);
  }
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
  // W1-DEF-3（v1.8）：chrome-devtools-mcp@0.3.0 take_screenshot 无 filePath 参数
  // （被 zod strip），返回 base64 —— Lasso 自行落盘 + fs 校验后才把 path 放进返回，
  // 禁伪造路径。写失败 throw screenshot_write_failed（classifyBrowseError → didnt）。
  const r = (await c.callTool("take_screenshot", {
    format: "png",
    fullPage: opts.screenshot?.full ?? false,
  })) as ContentResult;

  if (r.isError) {
    throw new Error(
      `screenshot_write_failed:upstream_is_error:${firstText(r) ?? "unknown"}`,
    );
  }

  // W1-DEF-1b（v1.8）：base64 在 type:"image" content block 的 data 字段
  // （实测契约见 browse/upstream-response.ts），不在 text block。
  const img = imageBlock(r);
  if (!img) {
    throw new Error("screenshot_write_failed:no_image_block_from_upstream");
  }
  const buf = Buffer.from(img.data, "base64");

  // PNG magic 校验（上游返回错误占位串时 base64 解出非 PNG——47 字节垃圾文件的教训）
  if (buf.length < 100 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error("screenshot_write_failed:not_a_valid_png");
  }

  const filePath = `/tmp/lasso-screenshot-${randomUUID()}.png`;
  try {
    await writeFile(filePath, buf);
    // 落盘后校验：文件存在且大小与解码后一致才返路径（禁伪造）
    const st = await stat(filePath);
    if (!st.isFile() || st.size !== buf.length) {
      throw new Error(`empty_or_missing_file:${filePath}`);
    }
  } catch (e) {
    throw new Error(`screenshot_write_failed:${String(e).slice(0, 200)}`);
  }

  return { preview: `screenshot saved to ${filePath}` };
}

async function doExtract(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // ---------- v1.1 mode 分流（parse12 §3.3.1；INV-66 raw byte-identical v1.0） ----------
  // 铁律：extract_mode 未传 / "raw" → 完全走 v1.0 take_snapshot 路径（零改）。
  //       INV-66 守：raw 档不调 extractMarkdown / 不静态 import markdown-extractor。
  const mode = opts.extract_mode;
  if (mode === undefined || mode === "raw") {
    // v1.0 路径 byte-identical：take_snapshot → a11y 文本树
    const r = (await c.callTool("take_snapshot", {})) as SnapshotResult;
    const { title, text } = extractSnapshot(r);
    return { title, preview: text };
  }

  // ---------- markdown / markdown_cited 档（v1.1 新增） ----------
  // 取渲染后 HTML（evaluate_script 注入 document.documentElement.outerHTML）。
  // raw 档不走此路径 → INV-66 raw 零回归；markdown 档 dynamic import lazy-load 引擎。
  // W1-DEF-1（v1.8）：函数表达式（上游 0.3.0 契约），不再传 IIFE 语句串。
  const expr = `() => {
    try {
      return JSON.stringify({
        html: document.documentElement.outerHTML,
        url: window.location.href,
        title: document.title || ""
      });
    } catch(e) { return JSON.stringify({ html: "", url: "", title: "" }); }
  }`;
  const evalResult = (await c.callTool("evaluate_script", {
    function: expr,
  })) as EvaluateResult;
  // W1-DEF-1b（v1.8）：同 quickSnapshot——经 parseEvalResult 解围栏 + 双层解码。
  const parsed = (parseEvalResult(evalResult) as {
    html: string;
    url: string;
    title: string;
  } | undefined) ?? { html: "", url: "", title: "" };

  if (!parsed.html) {
    // 取 HTML 失败 → 抛错走 outcome=unknown（BrowseChannel.browse catch → classifyBrowseError）
    throw new Error("[markdown-extractor] evaluate_script returned empty html");
  }

  // dynamic import（守 INV-66：raw 档不加载 defuddle/turndown；markdown 档才 lazy-load）
  const { extractMarkdown } = await import("../browse/markdown-extractor.js");
  const mdResult = await extractMarkdown(parsed.html, {
    mode,
    // T2-3（round2）：URL 透传激活 defuddle 站点 extractor + 相对链接绝对化
    url: parsed.url,
    headingStyle: "atx",
    bulletMarker: "-",
    enableCitations: mode === "markdown_cited",
  });

  return {
    title: mdResult.title ?? parsed.title ?? undefined,
    preview: mdResult.markdown,
    // markdown 专属元数据（v1.1 扩展；raw 档不填，v1.0 调用方不读）
    ...(mdResult.byline ? { byline: mdResult.byline } : {}),
    ...(mdResult.citations ? { citations: mdResult.citations } : {}),
    ...(mdResult.served_by ? { markdown_engine: mdResult.served_by } : {}),
  };
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
  // v1.11（round1 T1）：chrome-devtools-mcp 1.7.0 wait_for.text 契约是
  // array(string).min(1)（McpPage.waitForTextOnPage 对 text.flatMap）——单条 string
  // 会被 zod 拒。0.3.0 时代相反（要 string）——W1-DEF-2 随版本迁移翻转，INV-76 (b) 同步。
  await c.callTool("wait_for", { text: [text] });
  return { preview: `waited for "${text}"` };
}

async function doEvaluate(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  if (!opts.js) throw new Error("evaluate: opts.js required");
  // W1-DEF-1b（v1.8）：MCP 侧 js 是语句体（`return ...` / 裸表达式两种都支持）——
  // 包进函数体交上游调用；直接透传 `return ...` 会被当函数表达式语法错
  // （wave2 smoke 实证 "Unexpected token 'return'"）。
  const r = (await c.callTool("evaluate_script", {
    function: `() => {\n${opts.js}\n}`,
  })) as EvaluateResult;
  // 经 parseEvalResult 解围栏取脚本返回值；拿不到就退回原文展示
  const v = parseEvalResult(r);
  const preview =
    v == null
      ? extractEvalPreview(r)
      : typeof v === "string"
        ? v
        : JSON.stringify(v).slice(0, PREVIEW_MAX_CHARS);
  return { preview: truncatePreview(preview) };
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

// W1-DEF-1b（v1.8）：firstText 统一来自 upstream-response 适配器（单一权威解析入口）
function firstText(r: ContentResult | undefined): string | undefined {
  return upstreamFirstText(r);
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
// W2-DEF-N1（v1.8.1）：这些 URL 驱动的采集 action 要求目标页已加载——
// browseSingle 先 navigate 再 dispatch（工具注释自 v0.5 起就承诺「URL → navigate + X」，
// v1.8.1 补上真实导航）。snapshot/extract/wait/click 等保持原语义（作用于当前页）。
const NAV_FIRST_ACTIONS = new Set(["network", "screenshot", "pdf"]);

function classifyBrowseError(msg: string, _action: string): Outcome {
  const m = msg.toLowerCase();
  if (m.includes("needs_manual_2fa")) return "didnt";
  if (m.includes("404") || m.includes("not_found")) return "didnt";
  if (m.includes("403") || m.includes("forbidden")) return "didnt";
  if (m.includes("enotfound") || m.includes("nxdomain")) return "didnt";
  // v1.8（W1-DEF-3 / W1-DEF-5）：screenshot 落盘失败与导航失败（404 / DNS / 连接错）
  // 都是明确「目标不可得」信号 → didnt（不 fallback、不假装 worked）
  if (m.includes("screenshot_write_failed")) return "didnt";
  if (m.includes("dns_or_nav_error")) return "didnt";
  if (m.includes("http_404")) return "didnt";
  return "unknown";
}
