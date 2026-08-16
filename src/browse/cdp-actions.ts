/**
 * cdp-actions（parse6 §4.4 v0.5 新增，screenshot/pdf/network 共享的 ActionHandler 实装）
 *
 * 设计目的：
 *  - 把 chrome-devtools-mcp 上游工具名（pdf / take_screenshot / navigate_page / ...）
 *    **集中硬编码**在本文件的 CDP_UPSTREAM_TOOL_NAMES 顶级 const（parse6 §4.4 决策）。
 *  - 上游工具名漂移时（pdf → generate_pdf / print_to_pdf 等），只改这一处；
 *    BrowseChannel.ts 的 actionDispatch Map 与 cdp-actions.ts 实装不动。
 *  - 与既有 doNavigate / doSnapshot / doScreenshot（在 BrowseChannel.ts 内）同档自由函数。
 *
 * INV-33 守（parse6 §1.5）：doPdf / doNetwork / doConsole 必须以 entry 形式追加进
 *                          BrowseChannel.actionDispatch Map（BrowseChannel.ts 做这件事，
 *                          本文件只提供 handler 实现）。
 *
 * INV-6 衍生：本文件不新造第二个 dispatch Map；上游工具名集中常量化是 INV-6 单点修改风格的延伸。
 *
 * 守简单性（02 §5.5 R-CI-02 + §6.3 review 三问）：
 *  - 暴露 what（pdf/network/console action → upstream 工具调用）不暴露 how（不在本文件抽象第二层 Map）
 *  - doPdf / doNetwork / doConsole 与既有 doNavigate 同档（接 McpClient + url + opts，返 Partial<BrowseResult>）
 *  - 上游工具缺失（Go/No-Go F1 / F2）→ 不抛异常，throw 带 `upstream_unsupported:` 前缀的错误，
 *    BrowseChannel.browse() 内 classifyBrowseError 不识别此前缀 → outcome=unknown（默认），
 *    但上层 pdf.ts / network.ts 会把 upstream_pdf_error / tool_not_found 类错误重新包成
 *    outcome=didnt + retrieval_method="upstream_unsupported:<action>" + next_step
 *    （守 parse6 §4.4 Go/No-Go F1/F2）
 *
 * 借鉴：BrowseChannel.ts 第 570-606 行 doNavigate / doSnapshot / doScreenshot 同档风格。
 */
import type { McpClient } from "../subprocess/McpClient.js";
import type { BrowseOptions, BrowseResult } from "../types.js";

// ============================================================
// 顶级 const：chrome-devtools-mcp 上游工具名集中表（parse6 §4.4 决策）
// ============================================================
/**
 * INV-6 衍生：所有 chrome-devtools-mcp 上游工具名集中此表。
 *
 * 上游版本漂移时只改这一处（parse6 §4.4）。
 * doctor CLI 探测 cdp_mcp_pdf_tool_available / cdp_mcp_network_tool_available 会读
 * CDP_UPSTREAM_TOOL_NAMES.pdf / .network_log 验证可用性。
 *
 * 注：navigate / take_snapshot / take_screenshot 等既有工具名仍在 BrowseChannel.ts 内
 *     硬编码（doNavigate / doSnapshot / doScreenshot）；v0.5 不强行收编（守「最小变更」）。
 *     本表只覆盖 v0.5 新接入的 pdf / network_log / console_log（doctor 探测用）。
 */
export const CDP_UPSTREAM_TOOL_NAMES = Object.freeze({
  /** chrome-devtools-mcp `pdf` 工具（CDP Page.printToPDF；Go/No-Go F1 探测点） */
  pdf: "pdf",
  /**
   * chrome-devtools-mcp network 抓取工具。
   * v1.11（round1 T5）：0.3.0 时代走 evaluate_script 注 PerformanceObserver（F2 已知
   * 限制：proxy/TUN 改 timing 抓不全）；1.7.0 暴露原生 list_network_requests /
   * get_network_request（CDP Network 域）→ 直调原生工具，注入路径删除。
   */
  network_log: "list_network_requests",
  /** 单请求详情（响应体/头/时序；1.7.0 原生） */
  network_get: "get_network_request",
  /**
   * chrome-devtools-mcp console 抓取工具（1.7.0 原生 list_console_messages）。
   * v1.11（round1 T5）：从 v0.5 M0.5b 占位变实装。
   */
  console_log: "list_console_messages",
  /** evaluate_script（既有 doEvaluate 在 BrowseChannel.ts；此处仅记录名用于历史探测） */
  evaluate_script: "evaluate_script",
});

/**
 * Lasso network_filter → 上游 resourceTypes 映射（1.7.0 list_network_requests
 * FILTERABLE_RESOURCE_TYPES：document/stylesheet/image/media/font/script/xhr/fetch/...）。
 * "all" / "3rd-party" 不过滤（3rd-party 判定在 network.ts 工具层，host 精确匹配）。
 */
const FILTER_TO_RESOURCE_TYPES: Record<string, string[] | undefined> = {
  xhr: ["xhr"],
  fetch: ["fetch"],
  img: ["image"],
  "3rd-party": undefined,
  all: undefined,
};

// ============================================================
// SDK 返回结构类型（与 BrowseChannel.ts 同构，本文件局部复用）
// ============================================================
type TextBlock = { type: "text"; text?: string };
type ContentResult = { content?: TextBlock[]; isError?: boolean };

// ============================================================
// doPdf：pdf action handler（parse6 §3.3.3 实装）
// ============================================================
/**
 * pdf action handler —— 经 BrowseChannel.actionDispatch Map 追加（INV-33）。
 *
 * 上游契约（parse6 §4.4 + §7.1 F1）：
 *  - chrome-devtools-mcp@LOCKED_CDP_MCP_VERSION 暴露 `pdf` 工具（doctor CLI 探测）
 *  - 调用 args：format / landscape / printBackground / marginTop/Bottom/Left/Right
 *  - 返回：{ content: [{ type: "text", text: <base64 PDF 字符串> }] }（CDP Page.printToPDF）
 *  - 上游缺失：throw Error("upstream_pdf_error:tool_not_found:<detail>") —— 上层 pdf.ts
 *    会把它包成 outcome=didnt + retrieval_method="upstream_unsupported:pdf"
 *    + next_step（守 Go/No-Go F1）
 *
 * opts（BrowseOptions.pdf_*）：
 *  - pdf_format        : "A4" | "Letter" | "Legal" | "Tabloid"（默认 "A4"）
 *  - pdf_landscape     : boolean（默认 false）
 *  - pdf_print_background : boolean（默认 true）
 *  - pdf_margin_top/bottom/left/right : number（inches；默认 0.4）
 *
 * @returns Partial<BrowseResult>：preview 字段含 base64 PDF 字符串
 *          （pdf.ts 工具层会把它过 applyOutputEnvelope 落 .pdf；INV-34 同源）
 */
export async function doPdf(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  const args = {
    format: opts.pdf_format ?? "A4",
    landscape: opts.pdf_landscape ?? false,
    printBackground: opts.pdf_print_background ?? true,
    marginTop: opts.pdf_margin_top ?? 0.4,
    marginBottom: opts.pdf_margin_bottom ?? 0.4,
    marginLeft: opts.pdf_margin_left ?? 0.4,
    marginRight: opts.pdf_margin_right ?? 0.4,
  };

  // chrome-devtools-mcp `pdf` 工具返 base64 PDF string（CDP Page.printToPDF）
  // Go/No-Go F1：上游若不暴露 pdf 工具，callTool 会 reject（"Unknown tool: pdf"）
  // 或返 isError=true —— 本函数捕获 isError 显式抛 upstream_pdf_error；
  // reject 抛出的原生错误透传到 BrowseChannel.browse() 的 catch（→ outcome=unknown），
  // 上层 pdf.ts 检测错误信息含 "pdf" + ("Unknown tool" | "not found") 时改包为
  // outcome=didnt + retrieval_method=upstream_unsupported:pdf（守 parse6 §4.4）
  let r: ContentResult;
  try {
    r = (await c.callTool(CDP_UPSTREAM_TOOL_NAMES.pdf, args)) as ContentResult;
  } catch (e) {
    // 把上游缺失错误标准化（上游工具名漂移 / pdf 未暴露都会落到这里）
    const msg = String(e).slice(0, 200);
    throw new Error(`upstream_pdf_error:tool_call_failed:${msg}`);
  }

  if (r.isError) {
    const detail = firstText(r) ?? "unknown";
    throw new Error(`upstream_pdf_error:is_error:${detail}`);
  }

  const base64 = firstText(r) ?? "";
  if (!base64) {
    throw new Error("upstream_pdf_error:empty_response");
  }

  // base64 PDF 作为 preview 返回；pdf.ts 工具层会把它过 applyOutputEnvelope 落 .pdf
  return { preview: base64 };
}

// ============================================================
// doNetwork：network action handler（v1.11 round1 T5 原生化实装）
// ============================================================
/**
 * network action handler —— 经 BrowseChannel.actionDispatch Map 追加（INV-33）。
 *
 * v1.11（round1 T5）：0.3.0 时代的 evaluate_script 注入 PerformanceObserver 路径
 * **删除**，改调 1.7.0 原生 `list_network_requests`（CDP Network 域采集）：
 *  - 数据完整度：method/status 全量（不再受 fake-ip TUN 改 timing 抓不全影响——F2 关闭）
 *  - browse 流程 NAV_FIRST_ACTIONS 先导航 → 上游采「最近一次导航以来」的请求，
 *    与 navigate-first 流程 1:1 契合
 *
 * 上游响应（1.7.0 McpResponse 文本渲染，NetworkFormatter concise 格式）：
 *  - `## Network requests` 头 + 分页信息行 + 每请求一行
 *    `reqid=<N> <METHOD> <url> [<status>]`（可能带 ` [selected ...]` 后缀）
 *  - 按行正则抽取（upstream-response.ts 围栏提取同范式）。
 *
 * opts（BrowseOptions.network_*）：
 *  - network_filter : "xhr"|"fetch"|"img"|"3rd-party"|"all" → 映射上游 resourceTypes
 *                     （xhr→xhr / fetch→fetch / img→image；3rd-party/all 全量，
 *                      3rd-party 判定在 network.ts 工具层）
 *  - network_timeout_ms / network_include_bodies：不再适用（原生工具即时返回）；
 *    字段保留（zod 契约稳定），值被忽略
 *
 * @returns Partial<BrowseResult>：preview = entries JSON 字符串（network.ts 工具层
 *          filterResources + applyOutputEnvelope；INV-34 同源）
 */
export async function doNetwork(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // filter → 上游 resourceTypes（undefined = 全量）
  const filter = opts.network_filter ?? "all";
  const resourceTypes = FILTER_TO_RESOURCE_TYPES[filter];

  let r: ContentResult;
  try {
    r = (await c.callTool(CDP_UPSTREAM_TOOL_NAMES.network_log, {
      ...(resourceTypes ? { resourceTypes } : {}),
    })) as ContentResult;
  } catch (e) {
    // 上游工具缺失/协议错 → 标准化 upstream_network_error 前缀（network.ts Go/No-Go F2 识别）
    const msg = String(e).slice(0, 200);
    throw new Error(`upstream_network_error:tool_call_failed:${msg}`);
  }

  if (r.isError) {
    const detail = firstText(r) ?? "unknown";
    throw new Error(`upstream_network_error:is_error:${detail}`);
  }

  // 逐行抽 reqid=<N> <METHOD> <url> [<status>]
  // entry.type 回填 filter 的 canonical initiatorType（工具层 filterResources 直通；
  // 上游 resourceTypes 已过滤，回填保证 e.type 断言不被清空）
  const canonicalType =
    filter === "xhr" ? "xmlhttprequest" : filter === "img" ? "img" : filter;
  const text = firstText(r) ?? "";
  const entries = parseNetworkRequestLines(text).map((e) => ({
    ...e,
    ...(filter === "all" || filter === "3rd-party" ? {} : { type: canonicalType }),
  }));

  return { preview: JSON.stringify(entries) };
}

/** 1.7.0 list_network_requests 文本行 → 结构化条目（围栏提取范式）。 */
export function parseNetworkRequestLines(text: string): Array<{
  name: string;
  type: string;
  reqid: number;
  method: string;
  status: string;
}> {
  const out: Array<{
    name: string;
    type: string;
    reqid: number;
    method: string;
    status: string;
  }> = [];
  for (const line of text.split("\n")) {
    // reqid=123 GET https://example.com/ [200]（status 可能非数字：pending / failed）
    const m = line.match(/^reqid=(-?\d+)\s+(\S+)\s+(\S+)\s+\[([^\]]*)\]/);
    if (!m) continue;
    out.push({
      name: m[3],
      type: "",
      reqid: parseInt(m[1], 10),
      method: m[2],
      status: m[4],
    });
  }
  return out;
}

// ============================================================
// doConsole：console action handler（v1.11 round1 T5 实装，原 v0.5 占位废除）
// ============================================================
/**
 * console action handler —— 经 BrowseChannel.actionDispatch Map 追加（INV-33）。
 *
 * v1.11（round1 T5）：从占位（"v0.5 M0.5b placeholder"）变实装——调 1.7.0 原生
 * `list_console_messages`。
 *
 * 上游响应（ConsoleFormatter concise 格式）：
 *  - `## Console messages` 头 + 每消息一行
 *    `msgid=<N> [<type>] <text> (<N> args)`（可能带 ` [N times]` 后缀）
 *
 * @returns Partial<BrowseResult>：preview = messages JSON 字符串
 */
export async function doConsole(
  c: McpClient,
  _url: string,
  _opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  let r: ContentResult;
  try {
    r = (await c.callTool(CDP_UPSTREAM_TOOL_NAMES.console_log, {})) as ContentResult;
  } catch (e) {
    const msg = String(e).slice(0, 200);
    throw new Error(`upstream_console_error:tool_call_failed:${msg}`);
  }

  if (r.isError) {
    const detail = firstText(r) ?? "unknown";
    throw new Error(`upstream_console_error:is_error:${detail}`);
  }

  const messages = parseConsoleMessageLines(firstText(r) ?? "");
  return { preview: JSON.stringify(messages) };
}

/** 1.7.0 list_console_messages 文本行 → 结构化消息。 */
export function parseConsoleMessageLines(text: string): Array<{
  id: number;
  type: string;
  text: string;
  argsCount: number;
  count?: number;
}> {
  const out: Array<{
    id: number;
    type: string;
    text: string;
    argsCount: number;
    count?: number;
  }> = [];
  for (const line of text.split("\n")) {
    // msgid=1 [log] hello world (2 args) [3 times]
    const m = line.match(
      /^msgid=(-?\d+)\s+\[([^\]]+)\]\s+(.*)\s+\((\d+)\s+args?\)(?:\s+\[(\d+) times\])?$/,
    );
    if (!m) continue;
    out.push({
      id: parseInt(m[1], 10),
      type: m[2],
      text: m[3],
      argsCount: parseInt(m[4], 10),
      ...(m[5] ? { count: parseInt(m[5], 10) } : {}),
    });
  }
  return out;
}

// ============================================================
// helper：firstText（与 BrowseChannel.ts 同构）
// ============================================================
function firstText(r: ContentResult | undefined): string | undefined {
  if (!r?.content) return undefined;
  for (const b of r.content) {
    if (b.type === "text" && b.text) return b.text;
  }
  return undefined;
}
