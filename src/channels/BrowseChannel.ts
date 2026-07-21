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
import { writeState } from "../util/state-store.js";
import { logger } from "../util/logger.js";

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
   * 主入口（parse1 §3.5）。
   * 永不抛异常——所有失败路径走 InteractResult。
   */
  async browse(
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
