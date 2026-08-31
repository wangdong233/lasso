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
import { BudgetTracker, DEFAULT_CHAIN_BUDGET_MS, clampChainBudgetMs } from "../fallback/BudgetTracker.js";
import { applyOutputEnvelope } from "../util/output-envelope.js";
import {
  parseEvalResult,
  imageBlock,
  firstText,
} from "../browse/upstream-response.js";
// v0.5 M0.5b/M0.5c（parse6 §2.1 + §3.3.3 + §3.4.2）：doPdf + doConsole + doNetwork
//   追加进 actionDispatch Map
// INV-33 守：pdf + console + network 三 action 必经 dispatch Map，禁第二套 dispatch
import {
  doPdf,
  doConsole,
  doNetwork,
  ACTION_TO_UPSTREAM_TOOL,
} from "../browse/cdp-actions.js";
// v1.17 Phase F（parse24 §6.2 C2）：include_refs opt-in——refs 注入/附录/click-by-ref
//   纯函数 helper（expr 构造 + 附录格式化；无 SDK 依赖，单测友好）
import {
  buildExtractRefsExpr,
  buildRefClickExpr,
  buildRefFillExpr,
  buildRefLocateExpr,
  formatRefsAppendix,
  REF_APPENDIX_HEADING,
  REF_PATTERN,
  type ExtractRef,
} from "../browse/extract-refs.js";

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

/**
 * P6（v1.18.1）：上游 0 page target 时页级调用的错误签名
 * （chrome-devtools-mcp McpContext.getSelectedMcpPage 的 Error 文本原样）。
 */
const NO_PAGE_SELECTED_RE = /\bNo page selected\b/;

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
        const chain = await this.runChain(
          url,
          options.steps as Step[],
          // v1.18.2（doc/governance/10 F3+Y1）：budget_ms 显式放宽（钳制 600s；缺省 DEFAULT 120s）
          clampChainBudgetMs(options.budget_ms),
        );
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
  /**
   * W2-DEF-N1 的执行体（P6 v1.18.1 抽出以便自愈重试原样复跑）：
   * NAV_FIRST 采集类 action 先导航，再跑 handler。
   *
   * review-r3 F3：导航的 final_url 透传进 handler 结果（`partial.final_url ??
   * navFinalUrl`）——此前 nav-first 路径丢弃 nav 返回，browseSingle 兜底
   * `partial.final_url ?? url` 回显请求 url（重定向后即伪造）。
   *
   * review-r3 F3（blank-gated nav-first）：snapshot/extract 只在**会话页仍空白**
   * （本 client 生命周期从未导航 → 恒 about:blank）时先导航——兑现工具契约
   * 「url (required) 定向采集」（descriptions：extract — full-page text
   * extraction）。已导航会话保持「作用于当前页」语义（T-BROWSE-33 记录的设计）：
   * navigate → click → extract 的点击后观察态不被回灌导航破坏；interact_observe/
   * act(@pN) 经 InteractDispatcher 也走本路径，同享此保证。
   */
  private async dispatchAction(
    c: McpClient,
    action: string,
    url: string,
    options: BrowseOptions,
    handler: ActionHandler,
  ): Promise<Partial<BrowseResult>> {
    if (
      NAV_FIRST_ACTIONS.has(action) ||
      this.needsFreshPageNav(c, action, url)
    ) {
      const nav = this.actionDispatch.get("navigate");
      let navFinalUrl: string | undefined;
      if (nav) navFinalUrl = (await nav(c, url, options)).final_url;
      this.navSeenClients.add(c);
      const partial = await handler(c, url, options);
      return { ...partial, final_url: partial.final_url ?? navFinalUrl };
    }
    const partial = await handler(c, url, options);
    // navigate 自身成功后才标记会话已导航（失败不标——下次 snapshot/extract 仍门控导航）
    if (action === "navigate") this.navSeenClients.add(c);
    return partial;
  }

  /**
   * review-r3 F3：FRESH_PAGE_NAV_ACTIONS 命中 + 本 client 会话从未导航（当前页
   * = 上游新开空白页，L3 实证：此时单发 extract/snapshot 返 about:blank 空内容
   * + outcome=worked）+ url 非占位 about:blank（forest 调度器缺 subtitle 时的
   * 兜底值，无可导航目标）→ 返 true 需先导航。
   */
  private needsFreshPageNav(
    c: McpClient,
    action: string,
    url: string,
  ): boolean {
    return (
      FRESH_PAGE_NAV_ACTIONS.has(action) &&
      url !== "about:blank" &&
      !this.navSeenClients.has(c)
    );
  }

  /**
   * review-r3 F3：已导航会话集（WeakSet——上游 respawn 换 McpClient 实例自动
   * 重置为「空白」，fresh-page 门控重新生效）。单一写者（dispatchAction），
   * 不构成共享 mutable state 耦合面。
   */
  private readonly navSeenClients = new WeakSet<McpClient>();

  /**
   * P6（v1.18.1，得到实战问题集 P6）："No page selected" 零页面自愈钩子。
   * 默认 false（HeadlessChannel 上游自管浏览器无 0-page 形态，行为零变化）；
   * LoggedInChannel override：CDP 预建 background tab + 上游 select_page，
   * 成功返 true → browseSingle 原样重试一次该 action。
   */
  protected async recoverNoPageSelected(_c: McpClient): Promise<boolean> {
    return false;
  }

  /**
   * P10（v1.18.1）：上游工具缺失探测（带 per-client 缓存——同一上游子进程
   * 生命周期内工具集不变；listTools 抛错 → false 放行，让真实调用浮出错误）。
   */
  private async isUpstreamToolMissing(
    c: McpClient,
    toolName: string,
  ): Promise<boolean> {
    let known = this.upstreamToolsByClient.get(c);
    if (known === undefined) {
      try {
        const tools = await c.listTools();
        known = new Set(tools.map((t) => t.name));
      } catch {
        known = null; // 探测失败：永久放行该 client（不猜）
      }
      this.upstreamToolsByClient.set(c, known);
    }
    if (known === null) return false;
    return !known.has(toolName);
  }

  /** P10：per-client 上游工具名缓存（null = 探测失败档，放行）。 */
  private readonly upstreamToolsByClient = new WeakMap<
    McpClient,
    Set<string> | null
  >();

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
      // P10（v1.18.1，得到实战问题集 P10）：上游工具缺失前置门（导航**之前**）。
      // 锁定的 chrome-devtools-mcp@1.7.0 实测不暴露 `pdf` 工具——此前单 action pdf
      // 先 NAV_FIRST 白导航一次（logged_in 场景还会把当前页换掉）才在 callTool 处
      // 失败，outcome=unknown 假可重试。此门把 cdp-actions.ts 头注释承诺的
      // 「upstream_unsupported:<action> 诚实 didnt」语义落地到 browse 路径。
      // listTools 每 client 只探一次（结果缓存）；探测自身失败 → 放行（不猜）。
      const upstreamTool = ACTION_TO_UPSTREAM_TOOL[action];
      if (upstreamTool && (await this.isUpstreamToolMissing(c, upstreamTool))) {
        return {
          outcome: "didnt",
          data: null,
          served_by: this.name,
          fallback_used: false,
          retrieval_method: `upstream_unsupported:${action}`,
          error: `upstream_unsupported:${action}:tool_${upstreamTool}_not_in_listTools`,
        };
      }
      // W2-DEF-N1（v1.8.1）：URL 驱动的采集类 action 先导航到目标页——
      // 此前 doNetwork/doScreenshot/doPdf 直接在当前页（首会话 = about:blank）执行，
      // network 恒 0 entries（wave2 实证）。navigate 失败（404/DNS/...）由下方
      // catch 统一 classify；wrapNavigate 的 afterNavigate 顺带注入 stealth。
      let partial: Partial<BrowseResult>;
      try {
        partial = await this.dispatchAction(c, action, url, options, handler);
      } catch (e) {
        // P6（v1.18.1，得到实战问题集 P6）：上游 chrome-devtools-mcp 在 0 page
        // target 状态（--no-startup-window 起的 Chrome；台账被上一代 server 停机
        // 清空的遗留 Chrome——precreate 判定门跳过 + ensureOwnPageSelected 零页
        // silent bail）下所有页级调用抛 "No page selected"（getSelectedMcpPage）。
        // 自愈钩子（LoggedInChannel：CDP 预建 background tab + select_page）成功 →
        // 原样重试一次；失败/不支持 → 原错误路径（classify 落 unknown）。
        if (
          NO_PAGE_SELECTED_RE.test(String(e)) &&
          (await this.recoverNoPageSelected(c))
        ) {
          partial = await this.dispatchAction(c, action, url, options, handler);
        } else {
          throw e;
        }
      }

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
          preview: truncatePreviewKeepingRefs(partial.preview ?? ""),
          title: partial.title,
          final_url: partial.final_url ?? url,
          // v1.1（parse12 §3.3.1）：markdown 档元数据透传（仅 extract_mode=markdown* 时 partial 含这些字段）
          ...(partial.byline ? { byline: partial.byline } : {}),
          ...(partial.citations ? { citations: partial.citations } : {}),
          ...(partial.markdown_engine
            ? { markdown_engine: partial.markdown_engine }
            : {}),
          // v1.14.0：markdown 档正文别名字段——文档语义一直是 data.markdown，但实现只给
          // preview（搜索方案重审 verify 时两拨人先后读错字段误判「markdown 空」）。
          // 纯增量：raw 档无此字段（byte-identical 不变），markdown* 档=preview 同值。
          // v1.17（verify ⑤）：markdown/preview 均改 refs 附录感知截断（正文截断、
          // 附录钉尾——否则长页 include_refs 的附录被 4000 上限切掉，ref 不可达）。
          ...(partial.markdown_engine
            ? { markdown: truncatePreviewKeepingRefs(partial.preview ?? "") }
            : {}),
          // v1.17 Phase F（parse24 §6.2 C2 + 冲突 #8）：raw 档 + include_refs=true 的
          // 诚实标注（运行时忽略，schema 不拒——宽松进严格出）。缺省关时不填。
          ...(partial.ignored_include_refs ? { ignored_include_refs: true } : {}),
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
  async runChain(
    url: string,
    steps: Step[],
    /** v1.18.2（doc/governance/10 F3+Y1）：可选预算覆盖（已钳制；缺省 DEFAULT_CHAIN_BUDGET_MS）。 */
    budgetMs: number = DEFAULT_CHAIN_BUDGET_MS,
  ): Promise<InteractResult<ChainResult>> {
    // v1.18.2（doc/governance/10 F3+Y1）：默认 120s 维持，但调用方可经 options.budget_ms 放宽
    // （钳 600s——见 BudgetTracker.clampChainBudgetMs）；预算耗尽终止语义=unknown。
    const budget = new BudgetTracker(budgetMs);
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
    // v1.18.2（doc/governance/10 F4）：envelope 失败（单条 >16MiB 数据异常；store 耗尽已被
    // LRU 淘汰根治）→ 降级 preview-only，不 throw——旧实现裸抛会崩整个 tool 且
    // 被外层 decider 记成 unknown 喂双熔断（级联放大器）。
    const json = JSON.stringify(chain.data);
    let envelope: ReturnType<typeof applyOutputEnvelope>;
    try {
      envelope = applyOutputEnvelope(
        json,
        "chain result too large: narrow selectors or split into smaller steps",
      );
    } catch (e) {
      envelope = {
        preview: json.slice(0, 16 * 1024),
        truncated: true,
        total_bytes: Buffer.byteLength(json, "utf8"),
        refine_hint: `chain result exceeded single spill cap; no @oref available (envelope degrade): narrow selectors or split into smaller steps [${String(e).slice(0, 80)}]`,
      };
    }

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
      // P2 处置轮：删死写 timeout_ms: step.timeout_ms——BrowseOptions.timeout_ms
      // 已删（doNavigate 从不读，r2 审查实证），step.timeout_ms 的等待语义
      // 由 step.expect.timeout_ms（ExpectPoll 消费）承载。
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
  // review-r3 F3：final_url = a11y 树里的真实页面 URL（miss → browseSingle 兜底）
  return { title, preview: text, final_url: extractRootWebAreaUrl(text) };
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
  // v1.17 Phase F（parse24 §6.2 C2 + 冲突 #8）：include_refs 是 opt-in（缺省关 =
  // byte-identical，INV-66 手法）。raw 档 + include_refs=true → 运行时忽略 +
  // 诚实标注 ignored_include_refs:true（宽松进严格出，schema 不拒——raw 档走
  // take_snapshot a11y 树，无 HTML 可注入 uid；refs 是 markdown 档专属能力）。
  const includeRefs = opts.include_refs === true;
  const mode = opts.extract_mode;
  if (mode === undefined || mode === "raw") {
    // v1.0 路径 byte-identical：take_snapshot → a11y 文本树
    const r = (await c.callTool("take_snapshot", {})) as SnapshotResult;
    const { title, text } = extractSnapshot(r);
    // review-r3 F3：final_url 诚实化（同 doSnapshot——a11y 树真实页面 URL）
    const fu = extractRootWebAreaUrl(text);
    return includeRefs
      ? { title, preview: text, ignored_include_refs: true, final_url: fu }
      : { title, preview: text, final_url: fu };
  }

  // ---------- markdown / markdown_cited 档（v1.1 新增） ----------
  // 取渲染后 HTML（evaluate_script 注入 document.documentElement.outerHTML）。
  // raw 档不走此路径 → INV-66 raw 零回归；markdown 档 dynamic import lazy-load 引擎。
  // W1-DEF-1（v1.8）：函数表达式（上游 0.3.0 契约），不再传 IIFE 语句串。
  //
  // v1.17 Phase F（C2）：include_refs=true 时 expr 顺带注入 data-lasso-uid="r1"..
  // 并返回 refs（与 HighRiskGate.buildAssessExpr 的 uid 查找同属性名闭环）；
  // 缺省 expr 逐字节不变（byte-identical 基线）。
  const expr = includeRefs
    ? buildExtractRefsExpr()
    : `() => {
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
    refs?: ExtractRef[];
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

  // v1.17 Phase F（C2）：refs 附录追加在 markdown 末尾（正文零内嵌标记——
  // data-lasso-uid 是 HTML 属性，turndown 转换后不可见；既有黄金断言主文不受扰）。
  // refs 缺失（非 include_refs 档）/ 空数组（页面无交互元素）→ 无附录。
  let preview = mdResult.markdown;
  if (includeRefs && parsed.refs && parsed.refs.length > 0) {
    preview = `${preview}\n\n${formatRefsAppendix(parsed.refs)}`;
  }

  return {
    title: mdResult.title ?? parsed.title ?? undefined,
    preview,
    // review-r3 F3：markdown 档 evaluate 已抓 window.location.href——透传为
    // final_url（真实页面 URL，不回显未被消费的请求 url）
    final_url: parsed.url || undefined,
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
  // v1.17 Phase F（parse24 §6.2 C2）：Lasso 自产 ref（^r\d+$，extract include_refs
  // 注入的 data-lasso-uid）→ evaluate_script 定位后 JS click。与 trusted CDP click
  // 的差异如实文档化（个别框架不响应 JS click → CC 回退快照 uid 路径，两路径并存）。
  if (REF_PATTERN.test(uid)) {
    return clickByRef(c, uid);
  }
  await c.callTool("click", { uid });
  return { preview: `clicked ${uid}` };
}

/**
 * C2 click-by-ref：querySelector miss → throw ref_stale_re_snapshot
 * （classifyBrowseError → didnt；不猜不自动重试——页面变了就重新 extract）。
 */
async function clickByRef(
  c: McpClient,
  ref: string,
): Promise<Partial<BrowseResult>> {
  const r = (await c.callTool("evaluate_script", {
    function: buildRefClickExpr(ref),
  })) as EvaluateResult;
  const v = parseEvalResult(r) as { ok?: boolean; reason?: string; tag?: string } | undefined;
  if (v?.ok) {
    return { preview: `clicked ${ref} (${v.tag ?? "?"} via lasso ref)` };
  }
  if (v?.reason === "ref_stale") {
    throw new Error(
      `ref_stale_re_snapshot: ref "${ref}" not found in DOM (page changed since extract? re-run extract with include_refs)`,
    );
  }
  // eval_error / 解析失败（页面未就绪 / CSP / 通道断）→ unknown 档（classifyBrowseError）
  throw new Error(`ref_click_failed:${v?.reason ?? "unparsable_eval"}:${ref}`);
}

async function doFill(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // opts.selectors 是 { uid: value } 多字段表（fill_form 一次填多个）
  const elements = opts.selectors;
  if (!elements) throw new Error("fill: opts.selectors required");
  const entries = Object.entries(elements);
  // v1.17 Phase F（C2）：键匹配 ^r\d+$ 的是 Lasso ref → JS 填充路径；其余键照旧
  // 走 fill_form（uid 透传）。纯 uid 表 = 现行路径 byte-identical（单次 fill_form）。
  const refEntries = entries.filter(([k]) => REF_PATTERN.test(k));
  const uidEntries = entries.filter(([k]) => !REF_PATTERN.test(k));

  if (refEntries.length > 0) {
    // 副作用前预检：任一 ref miss → 不填任何字段直接抛 ref_stale（无部分填充）
    const loc = (await c.callTool("evaluate_script", {
      function: buildRefLocateExpr(refEntries.map(([k]) => k)),
    })) as EvaluateResult;
    const locV = parseEvalResult(loc) as { ok?: boolean; missing?: string[] } | undefined;
    if (!locV?.ok) {
      throw new Error(
        `ref_stale_re_snapshot: refs [${(locV?.missing ?? refEntries.map(([k]) => k)).join(", ")}] not found in DOM (page changed since extract? re-run extract with include_refs)`,
      );
    }
    // ref 填充（native value setter + input/change dispatch）
    const fillR = (await c.callTool("evaluate_script", {
      function: buildRefFillExpr(refEntries.map(([k, v]) => ({ ref: k, value: v }))),
    })) as EvaluateResult;
    const fillV = parseEvalResult(fillR) as { ok?: boolean; filled?: string[]; errors?: string[] } | undefined;
    if (!fillV?.ok) {
      const errs = fillV?.errors ?? [];
      if (errs.some((e) => e.includes("ref_stale"))) {
        throw new Error(`ref_stale_re_snapshot: ${errs.join("; ")}`);
      }
      throw new Error(`ref_fill_failed:${errs.join(";") || "unparsable_eval"}`);
    }
    // 混合表：非 ref 键照旧 fill_form（ref 已填，剩余 uid 一次填完）
    if (uidEntries.length > 0) {
      await c.callTool("fill_form", {
        elements: uidEntries.map(([uid, value]) => ({ uid, value })),
      });
    }
    return {
      preview: `filled ${entries.length} fields (${refEntries.length} via lasso ref)`,
    };
  }

  const fillElems = entries.map(([uid, value]) => ({ uid, value }));
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
  //
  // W-DEF-R11-1（v1.17.1 ft-round1 R11 真机修，probe2 W1/W2 实证）：
  //  ① expect.timeout_ms 透传 wait_for.timeout（上游 ms 整数；此前被静默忽略，
  //    恒烧上游默认 30s）；
  //  ② 上游超时以 isError 响应返回（McpClient.callTool 对 is_error 不 throw——
  //    与 doPdf 的 isError 检查同范式）——此前不检 → 文本从未出现仍报 worked
  //    （假成功）。isError → throw wait_timeout → classifyBrowseError 落 unknown
  //    （可 fallback：页面慢是可重试语义，非「明确不可得」）。
  const r = (await c.callTool("wait_for", {
    text: [text],
    ...(opts.expect?.timeout_ms ? { timeout: opts.expect.timeout_ms } : {}),
  })) as { isError?: boolean };
  if (r.isError) {
    throw new Error(`wait_timeout:${JSON.stringify(text).slice(0, 80)}`);
  }
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
  // P5（v1.18.1，得到实战问题集 P5）：上游错误假成功治理——与 doWait
  // （W-DEF-R11-1 v1.17.1 同病同修）同范式：McpClient.callTool 对 is_error 不
  // throw，此前不检 → 协议超时（"Network.enable timed out"）/ 无页面
  // （"No page selected"）/ 脚本异常堆栈全部被当 preview 返回，outcome 恒 worked。
  // isError → throw eval_upstream_error → classifyBrowseError 落 unknown（可重试）。
  if (r.isError) {
    throw new Error(`eval_upstream_error:${(extractEvalPreview(r)).slice(0, 120)}`);
  }
  // 经 parseEvalResult 解围栏取脚本返回值；拿不到就退回原文展示
  const v = parseEvalResult(r);
  const preview =
    v == null
      ? extractEvalPreview(r)
      : typeof v === "string"
        ? v
        : JSON.stringify(v).slice(0, PREVIEW_MAX_CHARS);
  // P5 兜底：isError 标志缺失但响应文本即错误本体（上游 1.7.0 performEvaluation
  // 把 evaluateHandle 异常序列化进 content 的形态；签名窄匹配防误伤正常返回值）。
  // 仅在 v==null（未解析出脚本值 = 响应非 ```json 围栏形态）时检查。
  if (v == null && UPSTREAM_EVAL_ERROR_SIGNATURES.some((re) => re.test(preview))) {
    throw new Error(`eval_upstream_error:${preview.slice(0, 120)}`);
  }
  return { preview: truncatePreview(preview) };
}

/**
 * P5：上游 evaluate 错误文本签名（实测三种形态，问题集 P5 白盒证据）——
 * ① 协议超时 "Network.enable timed out. Increase the 'protocolTimeout' …"
 * ② 脚本异常序列化 "Error: xxx\npptr:evaluateHandle; …"
 * ③ 零页面 "No page selected"（McpContext.js:250 整串恰为此）
 * 窄匹配（锚定/整串），正常脚本返回值（如查无元素取到的页面文案）不误伤。
 */
const UPSTREAM_EVAL_ERROR_SIGNATURES: RegExp[] = [
  /timed out\. Increase the 'protocolTimeout'/,
  /^Error:[\s\S]*\bpptr:/,
  /^No page selected$/,
];

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

/**
 * review-r3 F3：从 a11y 文本树解析真实页面 URL。chrome-devtools-mcp snapshot
 * 的 RootWebArea 行带 url="..."（L3 真机实证两种形态：带 title
 * `RootWebArea "Example Domain" url="https://..."` 与裸 `RootWebArea url="..."`；
 * about:blank 场景可检出——r3 空内容缺陷的取证信号）。
 * 宽松匹配 + miss 返 undefined（格式漂移时退回 browseSingle 的 `?? url` 兜底，
 * 不新增失败模式）。用途：snapshot/raw extract 的 final_url 诚实化——不再回显
 * 未被消费的请求 url 伪装成已导航。
 */
function extractRootWebAreaUrl(snapshotText: string): string | undefined {
  const m = snapshotText.match(/RootWebArea(?:\s+"[^"]*")?\s+url="([^"]*)"/);
  return m ? m[1] : undefined;
}

function extractEvalPreview(r: EvaluateResult): string {
  return firstText(r) ?? "(no eval output)";
}

// W1-DEF-1b（v1.8）：firstText 直接 import 自 upstream-response 适配器
// （单一权威解析入口；r1 收敛：删除本地委托包装，全仓唯一定义）

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
 * v1.17（doc/governance/06 verify ⑤，真机实证）：refs 附录感知截断——长页正文超
 * PREVIEW_MAX_CHARS 时朴素 truncatePreview 会把**缀在末尾**的
 * "## Interactive refs" 附录整段切掉（books.toscrape 实测：正文 5529 字符 +
 * 附录 → data.markdown 只剩前 4000，附录不可见 → C2 ref 句柄经 MCP 响应
 * 不可达，失去存在意义）。本函数：正文照常截断，附录**钉在截断结果之后**
 * （附录自带 cap 50 refs，长度有界）。无附录（缺省关 / raw 档）行为与
 * truncatePreview 完全一致（byte-identical）。
 */
export function truncatePreviewKeepingRefs(s: string): string {
  const idx = s.indexOf(REF_APPENDIX_HEADING);
  if (idx < 0) return truncatePreview(s);
  const body = truncatePreview(s.slice(0, idx).replace(/\n+$/, ""));
  const appendix = s.slice(idx);
  return `${body}\n\n${appendix}`;
}

/**
 * browse 错误 → outcome（10 §D.1）。
 *  - NEEDS_MANUAL_2FA → didnt（明确「需人」信号，不 fallback）
 *  - 404 / 403 / NXDOMAIN / ENOTFOUND → didnt
 *  - timeout / 429 / 5xx / 网络错 → unknown
 * action 名拼错不在这里出现（browse() 提前 didnt 返回）。
 */
// W2-DEF-N1（v1.8.1）：这些 URL 驱动的采集 action **无条件**先导航——
// browseSingle 先 navigate 再 dispatch（工具注释自 v0.5 起就承诺「URL → navigate + X」，
// v1.8.1 补上真实导航）。wait/click 等保持原语义（作用于当前页）。
const NAV_FIRST_ACTIONS = new Set(["network", "screenshot", "pdf"]);

// review-r3 F3：URL 驱动但**会话语义敏感**的采集 action——只在会话页仍空白时
// 先导航（needsFreshPageNav 门控），已导航会话作用于当前页。理由：
//  - snapshot/extract 是工具默认 action + descriptions 承诺 URL 定向——空白会话
//    单发返 about:blank 空内容 + worked + final_url 回显请求 url（L3 真机 ×6 实证，
//    生产实例同病），是必修缺陷；
//  - 但它们同时是「观察当前页」的合法用法（navigate → click → extract 看
//    点击后状态；interact_observe/act(@pN) 经 InteractDispatcher 走同一
//    dispatchAction）——无条件 nav-first 会把 root 注册 URL 回灌导航、破坏
//    观察态（r3 原提案的反证，故收敛为空白门控）。
const FRESH_PAGE_NAV_ACTIONS = new Set(["snapshot", "extract"]);

function classifyBrowseError(msg: string, _action: string): Outcome {
  const m = msg.toLowerCase();
  if (m.includes("needs_manual_2fa")) return "didnt";
  if (m.includes("404") || m.includes("not_found")) return "didnt";
  if (m.includes("403") || m.includes("forbidden")) return "didnt";
  // v1.18.2（doc/governance/10 Y2）：DNS 错（enotfound/nxdomain）与导航网络错（dns_or_nav_error
  // 家族：ERR_NAME_NOT_RESOLVED / 连接拒/重置/超时 / 断网）→ unknown。代理/TUN 环境
  // 这些是高频瞬态（fake-ip 拦截、断网恢复期），不是页面语义否定；headless 失败
  // 后 fallback 到 logged_in（真实 Chrome 走系统栈/DoH，解析路径不同）可能成功。
  if (m.includes("enotfound") || m.includes("nxdomain")) return "unknown";
  // v1.8（W1-DEF-3 / W1-DEF-5）：screenshot 落盘失败是明确「本地交付不可得」→ didnt
  if (m.includes("screenshot_write_failed")) return "didnt";
  if (m.includes("dns_or_nav_error")) return "unknown";
  if (m.includes("http_404")) return "didnt";
  // v1.17 Phase F（parse24 §6.2 C2）：ref 失效是明确「句柄不可用」信号 → didnt
  // （不 fallback、不猜——CC 重新 extract with include_refs 取新 refs）
  if (m.includes("ref_stale")) return "didnt";
  // P10（v1.18.1，得到实战问题集 P10）：上游工具缺失是确定性「明确不可得」
  // （锁定的 chrome-devtools-mcp@1.7.0 无 pdf 工具，-32602 "Tool pdf not found"；
  // 重试/fallback 都无济于事）→ didnt。此前落 unknown 假可重试——steps 链里
  // pdf step 死后整链 unknown（extract-batch1.mjs 实测 chain_failed:unknown:*）。
  if (m.includes("upstream_unsupported:")) return "didnt";
  if (/tool \S+ not found/.test(m) || m.includes("unknown tool")) return "didnt";
  return "unknown";
}
