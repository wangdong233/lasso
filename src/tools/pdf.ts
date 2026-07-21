/**
 * pdf tool 注册（parse6 §3.3 v0.5 M0.5b 新增）
 *
 * URL → navigate + chrome-devtools-mcp `pdf` 工具（CDP Page.printToPDF）。
 *
 * 设计要点（parse6 §3.3 + §4.4）：
 *  - 经 BrowseChannel 入口（headless.browse(url, "pdf", opts)）—— 守 INV-33
 *  - chrome-devtools-mcp `pdf` 工具返 base64 PDF 字符串 → 过 applyOutputEnvelope(text, hint, ".pdf")
 *  - 大 PDF（>48KiB；典型 PDF 50-500 KiB 必超限）自动落盘 /tmp/lasso-output/@oN.pdf，mode 0o600
 *  - 落盘 .pdf 内容是 base64 文本（不是二进制）；CC 用 read_text({ref:@oN}) 续读 base64 自行解码
 *  - **Go/No-Go F1（parse6 §4.4 + §7.1）**：若 chrome-devtools-mcp@LOCKED 不暴露 `pdf` 工具，
 *    doPdf 会 throw `upstream_pdf_error:*`；本工具层捕获 → outcome=didnt +
 *    retrieval_method="upstream_unsupported:pdf" + next_step（不崩；明确降级路径）
 *
 * 边界（parse6 §1.2）：
 *  - 不加水印 / 不加密 / 不填表单（永远 NO-GO）
 *  - 不分页合并多 URL（v0.6+ 若有需求再评估）
 *
 * 守简单性（02 §5.5 R-CI-02 + §6.3 review 三问）：
 *  - 复用既有 ssrfGuard / applyOutputEnvelope / BrowseChannel.browse 范式
 *  - 不开第二套 PDF 处理范式；doctor 探测 cdp_mcp_pdf_tool_available 复用 runDoctor 框架
 *
 * 借鉴：browse.ts registerBrowseTools（ssrfBlocked / InteractResult 包装）；
 *      fetch-url.ts doFetchUrl（payloadContent + outcome 分类）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";
import type {
  BrowseOptions,
  InteractResult,
  PdfOptions,
  PdfResult,
} from "../types.js";
import type { HeadlessChannel } from "../channels/HeadlessChannel.js";
import { ssrfGuard, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { applyOutputEnvelope } from "../util/output-envelope.js";
import { PDF_DESCRIPTION } from "./descriptions.js";
import { pdfAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";

// ============================================================
// Schema（parse6 §3.3.4）
// ============================================================
export const pdfSchema = {
  url: z.string().url(),
  options: z
    .object({
      format: z.enum(["A4", "Letter", "Legal", "Tabloid"]).default("A4"),
      landscape: z.boolean().default(false),
      print_background: z.boolean().default(true),
      margin_top: z.number().min(0).max(5).optional(),
      margin_bottom: z.number().min(0).max(5).optional(),
      margin_left: z.number().min(0).max(5).optional(),
      margin_right: z.number().min(0).max(5).optional(),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .default("load"),
      timeout_ms: z.number().int().positive().default(30_000),
    })
    .default({}),
};

// ============================================================
// 包装 helper（与 fetch-url.ts / screenshot.ts 同范式）
// ============================================================
function payloadContent<T>(result: InteractResult<T>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}

// ============================================================
// Go/No-Go F1：上游 pdf 工具错误识别（parse6 §4.4 + §7.1 F1）
// ============================================================
/**
 * 把 doPdf / BrowseChannel.browse() 抛出的错误信息分类，识别「上游不支持 pdf 工具」场景。
 *
 * chrome-devtools-mcp 不暴露 `pdf` 工具时的错误形式（parse6 §4.4 + §7.1 F1）：
 *  - doPdf cdp-actions.ts 内已标准化为 `upstream_pdf_error:*` 前缀（cdp-actions.ts doPdf）
 *  - McpClient.callTool 上游返 "Unknown tool: pdf" / "tool pdf not found" 等 NotFound 类错误
 *
 * 命中 → 上层 pdf.ts 返 outcome=didnt + retrieval_method=upstream_unsupported:pdf + next_step
 * 未命中 → 错误透传（classifyBrowseError 已分类 outcome=unknown 等；本函数不重复分类）
 */
export function isUpstreamPdfUnsupported(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  // cdp-actions.ts doPdf 已标准化的前缀（无论 callTool reject 还是 isError）
  if (error.includes("upstream_pdf_error:")) return true;
  // 上游 chrome-devtools-mcp 直接抛的 NotFound 类错误（兼容无 cdp-actions 包装的直传路径）
  if (lower.includes("unknown tool") && lower.includes("pdf")) return true;
  if (lower.includes("tool") && lower.includes("pdf") && lower.includes("not found")) {
    return true;
  }
  return false;
}

// ============================================================
// 核心：doPdfTool（独立可测，parse6 §3.3.4 实装）
// ============================================================
/**
 * pdf 的纯函数实装 —— 单元测直接调，不经 MCP server.tool 装配。
 *
 * 流程（parse6 §3.3.4 伪码逐条对齐）：
 *  1. SSRF 守门（与 browse_headless 同函数同 config）
 *  2. 透传 BrowseOptions 形状（pdf_* 字段；BrowseChannel → doPdf 读）
 *  3. 经 BrowseChannel 入口（headless.browse(url, "pdf", opts)）
 *  4. result.data.preview 是 base64 PDF → 过 applyOutputEnvelope(text, hint, ".pdf")
 *  5. **Go/No-Go F1**：若 result.error 含 `upstream_pdf_error` / `Unknown tool: pdf` →
 *     outcome=didnt + retrieval_method=upstream_unsupported:pdf + next_step
 *  6. 返 InteractResult<PdfResult>
 */
export async function doPdfTool(
  rawUrl: string,
  opts: PdfOptions,
  headless: HeadlessChannel,
  ssrfConfig: SsrfConfig,
): Promise<InteractResult<PdfResult>> {
  // ---------- 1. SSRF 守门（与 browse_headless 同函数同 config） ----------
  const ssrfResult = await ssrfGuard(rawUrl, ssrfConfig);
  if (!ssrfResult.allowed) {
    return {
      outcome: "didnt",
      data: null,
      served_by: "lasso.ssr_guard",
      fallback_used: false,
      retrieval_method: "ssrf_blocked",
      error: `ssrf_blocked:${ssrfResult.reason}`,
    };
  }

  // ---------- 2. 透传 BrowseOptions 形状（pdf_* 字段；doPdf 读） ----------
  const browseOpts: BrowseOptions = {
    pdf_format: opts.format,
    pdf_landscape: opts.landscape,
    pdf_print_background: opts.print_background,
    ...(opts.margin_top !== undefined ? { pdf_margin_top: opts.margin_top } : {}),
    ...(opts.margin_bottom !== undefined
      ? { pdf_margin_bottom: opts.margin_bottom }
      : {}),
    ...(opts.margin_left !== undefined
      ? { pdf_margin_left: opts.margin_left }
      : {}),
    ...(opts.margin_right !== undefined
      ? { pdf_margin_right: opts.margin_right }
      : {}),
    wait_until: opts.wait_until,
    timeout_ms: opts.timeout_ms,
  };

  // ---------- 3. 经 BrowseChannel 入口（隐式享受 browse fallback 链；不绕过 INV-6） ----------
  const result = await headless.browse(rawUrl, "pdf", browseOpts);

  // ---------- 5. Go/No-Go F1：上游不支持 pdf 工具 → didnt + upstream_unsupported ----------
  // 上游错误形式：cdp-actions.ts doPdf 标准化的 `upstream_pdf_error:*` 前缀，
  // 或 chrome-devtools-mcp 直接抛的 "Unknown tool: pdf"（无 cdp-actions 包装的兜底）
  if (isUpstreamPdfUnsupported(result.error)) {
    logger.warn({
      evt: "pdf_upstream_unsupported",
      url: rawUrl,
      error: result.error,
    });
    return {
      outcome: "didnt",
      data: {
        url: rawUrl,
        next_step:
          "chrome-devtools-mcp@LOCKED 不暴露 `pdf` 工具；改用 browse_headless screenshot + 自己 OCR，或本地 Chrome `--headless --print-to-pdf=url` 直接生成 PDF",
      },
      served_by: result.served_by,
      fallback_used: false,
      retrieval_method: "upstream_unsupported:pdf",
      error: result.error,
    };
  }

  // ---------- 4. result.data.preview 是 base64 PDF → 过 envelope 落 .pdf（INV-34 + INV-15） ----------
  let envelope: ReturnType<typeof applyOutputEnvelope> | undefined;
  if (result.outcome === "worked" && result.data?.preview) {
    try {
      envelope = applyOutputEnvelope(
        result.data.preview,
        "pdf too large: narrow by selecting specific pages or reduce content",
        ".pdf", // v0.5 新增 extension 参数；落盘 @oN.pdf（mode 0o600）
      );
    } catch (e) {
      // envelope 单条 16 MiB 上限保护：超限（base64 PDF > 16 MiB ≈ 原 PDF 12 MiB）
      // → outcome=didnt + error；不崩
      return {
        outcome: "didnt",
        data: { url: rawUrl },
        served_by: result.served_by,
        fallback_used: false,
        retrieval_method: "envelope_cap_exceeded",
        error: `pdf_envelope_failed:${String(e).slice(0, 200)}`,
      };
    }
  }

  // ---------- 6. 返 InteractResult<PdfResult> ----------
  const pdfResult: InteractResult<PdfResult> = {
    outcome: result.outcome,
    data: result.data
      ? {
          url: rawUrl,
          ...(envelope ? { envelope } : {}),
          ...(result.data.state_id ? { state_id: result.data.state_id } : {}),
          ...(envelope?.ref
            ? {
                spill_path: path.join(
                  os.tmpdir(),
                  "lasso-output",
                  `${envelope.ref}.pdf`,
                ),
              }
            : {}),
        }
      : null,
    served_by: result.served_by,
    fallback_used: result.fallback_used,
    retrieval_method:
      result.outcome === "worked"
        ? "chrome_devtools_mcp_pdf"
        : (result.retrieval_method ?? "pdf_failed"),
    ...(result.error ? { error: result.error } : {}),
  };
  return pdfResult;
}

// ============================================================
// 注册器（parse6 §3.3.4）
// ============================================================
/**
 * @param server      MCP server
 * @param headless    HeadlessChannel（chrome-devtools-mcp --headless --isolated）
 * @param ssrfConfig  SSRF allowRanges / denyRanges（从 env 加载，与 browse_headless 共用）
 */
export function registerPdfTool(
  server: McpServer,
  headless: HeadlessChannel,
  ssrfConfig: SsrfConfig,
): void {
  server.tool(
    "pdf",
    PDF_DESCRIPTION,
    pdfSchema,
    pdfAnnotations,
    async (args) => {
      const url: string = args.url;
      // zod .default({}) 已注入所有默认值；margins undefined 时透传 undefined
      const opts: PdfOptions = {
        format: args.options.format,
        landscape: args.options.landscape,
        print_background: args.options.print_background,
        ...(args.options.margin_top !== undefined
          ? { margin_top: args.options.margin_top }
          : {}),
        ...(args.options.margin_bottom !== undefined
          ? { margin_bottom: args.options.margin_bottom }
          : {}),
        ...(args.options.margin_left !== undefined
          ? { margin_left: args.options.margin_left }
          : {}),
        ...(args.options.margin_right !== undefined
          ? { margin_right: args.options.margin_right }
          : {}),
        wait_until: args.options.wait_until,
        timeout_ms: args.options.timeout_ms,
      };

      const result = await doPdfTool(url, opts, headless, ssrfConfig);
      // SSRF 拒绝 / Go/No-Go F1 / browse 失败 / 成功 都包成 InteractResult，序列化即可
      return payloadContent(result);
    },
  );
}
