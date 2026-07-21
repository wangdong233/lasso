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
   * chrome-devtools-mcp network 资源抓取工具（v0.5 MVP 走 evaluate_script 注入
   * PerformanceObserver 兜底；上游若暴露专门工具则切换。Go/No-Go F2 探测点）。
   */
  network_log: "network_log",
  /**
   * chrome-devtools-mcp console 日志工具（上游若不暴露则 doConsole 走 evaluate 注入兜底）。
   * v0.5 M0.5b 暂不接入 console 工具实装（占位；M0.5c network 时统一上线）。
   */
  console_log: "console_log",
  /** evaluate_script（既有 doEvaluate 在 BrowseChannel.ts；此处仅记录名用于 doConsole/doNetwork 兜底） */
  evaluate_script: "evaluate_script",
});

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
// doNetwork：network action handler（parse6 §3.4.2 实装）
// ============================================================
/**
 * network action handler —— 经 BrowseChannel.actionDispatch Map 追加（INV-33）。
 *
 * 实现路径（parse6 §3.4 + §4.4 + §7.1 F2）：
 *  - v0.5 MVP 走 evaluate_script 注入 PerformanceObserver（JS-level 抓取）
 *  - 上游 chrome-devtools-mcp 若暴露专门 `network_log` 工具（doctor 探测），v0.6+ 切换
 *  - JS-level 抓取的已知限制（F2）：proxy / TUN 透明代理改 timing 时可能抓不全；
 *    network.ts 工具层会在低计数时挂 data.next_step 提示（不阻断 worked outcome）
 *
 * opts（BrowseOptions.network_*）：
 *  - network_filter       : "xhr" | "fetch" | "img" | "3rd-party" | "all"（默认 "all"；过滤在
 *                            network.ts 工具层做，doNetwork 抓全量让工具层决定）
 *  - network_include_bodies : boolean（v0.5 不实装；schema forward-compat）
 *  - network_timeout_ms   : number（默认 3000ms；PerformanceObserver 采集窗口）
 *
 * 注入脚本（与 parse6 §3.4.2 伪码逐行对齐）：
 *  - new PerformanceObserver((list) => { for (e of list.getEntries()) entries.push({
 *      name: e.name, type: e.initiatorType, duration: e.duration,
 *      ttfb: e.responseStart - e.requestStart, bytes: e.transferSize,
 *      workerStart: e.workerStart
 *    }) })
 *  - obs.observe({ type: "resource", buffered: true })  // buffered=true 拉历史 + 后续
 *  - setTimeout(() => { obs.disconnect(); resolve(JSON.stringify(entries)); }, timeout_ms)
 *
 * @returns Partial<BrowseResult>：preview 字段含 entries JSON 字符串
 *          （network.ts 工具层会把它过 applyOutputEnvelope；INV-34 同源）
 */
export async function doNetwork(
  c: McpClient,
  _url: string,
  opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // PerformanceObserver 采集窗口（默认 3000ms；上限 30000ms 防 caller 误传巨大值）
  const timeoutMs = Math.max(100, Math.min(opts.network_timeout_ms ?? 3000, 30_000));

  // 注入表达式（与 parse6 §3.4.2 伪码逐行对齐）
  // 注：JSON.stringify entries 数组在 page 端完成；CDP 透传 text 回来
  const expr = `(function(){
    return new Promise((resolve) => {
      var entries = [];
      if (typeof PerformanceObserver === "undefined") {
        resolve("[]");
        return;
      }
      try {
        var obs = new PerformanceObserver(function(list) {
          list.getEntries().forEach(function(e) {
            entries.push({
              name: e.name,
              type: e.initiatorType,
              duration: e.duration,
              ttfb: e.responseStart - e.requestStart,
              bytes: e.transferSize,
              workerStart: e.workerStart
            });
          });
        });
        obs.observe({ type: "resource", buffered: true });
        setTimeout(function() {
          try { obs.disconnect(); } catch (_) {}
          resolve(JSON.stringify(entries));
        }, ${timeoutMs});
      } catch (e) {
        resolve("[]");
      }
    });
  })()`;

  let r: ContentResult;
  try {
    r = (await c.callTool(CDP_UPSTREAM_TOOL_NAMES.evaluate_script, {
      function: expr,
    })) as ContentResult;
  } catch (e) {
    // evaluate_script 调用失败（chrome-devtools-mcp 上游协议错 / 子进程挂）
    // → 标准化为 upstream_network_error 前缀；上层 network.ts 检测后包成
    // outcome=didnt + retrieval_method=upstream_unsupported:network（守 F2）
    const msg = String(e).slice(0, 200);
    throw new Error(`upstream_network_error:tool_call_failed:${msg}`);
  }

  if (r.isError) {
    const detail = firstText(r) ?? "unknown";
    throw new Error(`upstream_network_error:is_error:${detail}`);
  }

  // entries JSON 作为 preview 返回；network.ts 工具层会做 3rd-party 标记 + 过滤 + envelope
  // 空字符串兜底为 "[]"（让上层 JSON.parse 不炸；空 entries 是合法结果）
  const text = firstText(r) ?? "[]";
  return { preview: text };
}

// ============================================================
// doConsole：console action handler（v0.5 M0.5b 占位，M0.5c 接入）
// ============================================================
/**
 * console action handler —— 经 BrowseChannel.actionDispatch Map 追加（INV-33）。
 *
 * v0.5 M0.5b 立场：占位实装 —— parse6 §2.1 把 console entry 加入 dispatch Map（INV-33
 * 要求三 action 必在 Map），但 M0.5b 阶段不实装真正 console 日志抓取（推 M0.5c network
 * 时统一上线 evaluate_script 注入范式 + 3rd-party 过滤等）。
 *
 * 守 R-CI-02：不在本函数返回特殊形状；与既有 doEvaluate 同档 throw（无 js 时 throw）
 *            → BrowseChannel.browse() 内 classifyBrowseError → outcome=unknown
 *            → 上层（暂无 console.ts 工具）未来 console.ts 工具会包装成 outcome=didnt
 *              + retrieval_method=console_not_implemented_in_v0.5 + next_step。
 *
 * 设计：本占位**永不抛错**（return + preview 而非 throw），让 BrowseChannel.browse()
 *      outcome=worked + retrieval_method=chrome_devtools_mcp_console_placeholder。
 *      这样 INV-33 断言（"console" 必须在 dispatch Map）落地，且不影响任何现有调用路径
 *      （v0.5 没有 console tool 注册；只是 Map entry 预留）。
 */
export async function doConsole(
  _c: McpClient,
  _url: string,
  _opts: BrowseOptions,
): Promise<Partial<BrowseResult>> {
  // v0.5 M0.5b 占位：返 preview 标识 + retrieval_method 暗示未实装
  // M0.5c network 时会改为真正的 evaluate_script 注入 + console entries 解析
  return {
    preview:
      "console action: v0.5 M0.5b placeholder (M0.5c will implement evaluate_script injection)",
  };
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
