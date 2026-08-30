/**
 * screenshot tool 注册（parse6 §3.2 v0.5 M0.5b 新增）
 *
 * URL → navigate + take_screenshot 全链路（经 HeadlessChannel.browse 入口）。
 *
 * 设计要点（parse6 §3.2 + §4.2）：
 *  - 经 BrowseChannel 入口（隐式享受 browse fallback 链；不绕过 INV-6 dispatch Map）
 *  - screenshot action 已在 v0.1 实装（BrowseChannel.actionDispatch.get("screenshot") = doScreenshot，
 *    第 593-606 行），v0.5 不动；独立工具只是重新暴露 + 细化 opts schema
 *  - PNG 落盘：复用 doScreenshot 现有逻辑（写 /tmp/lasso-screenshot-<uuid>.png）
 *  - PNG 文件路径直接返回（不经 applyOutputEnvelope；INV-34 衍生：screenshot 经 writeState
 *    已落盘，BrowseChannel.browse() 内部 writeState 满足 INV-34 同源）
 *  - pageRef v0.5 不支持（仅 URL 入参；pageRef 推 v0.6 forest 合并后）
 *  - SSRF 与 browse_headless 同函数同 config（守 INV-31 衍生：独立工具也必经 ssrfGuard）
 *
 * 守简单性（02 §5.5 R-CI-02）：
 *  - 不引入第二套 SSRF 范式（直接 import ssrfGuard）
 *  - 不引入第二套 InteractResult 范式（复用 v0.1 形状）
 *  - 不绕过 BrowseChannel.browse() 入口（守 INV-6 衍生 + INV-33 兄弟）
 *
 * 借鉴：browse.ts registerBrowseTools（ssrfBlocked / InteractResult 包装范式）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  BrowseOptions,
  InteractResult,
  ScreenshotOptions,
  ScreenshotResult,
} from "../types.js";
import type { HeadlessChannel } from "../channels/HeadlessChannel.js";
import { ssrfGuard, ssrfDenial, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { SCREENSHOT_DESCRIPTION } from "./descriptions.js";
import { screenshotAnnotations } from "./annotations.js";

// ============================================================
// Schema（parse6 §3.2.2）
// ============================================================
export const screenshotSchema = {
  url: z.string().url(),
  options: z
    .object({
      // 整页截图（透传 doScreenshot 的 opts.screenshot.full）
      full_page: z.boolean().default(false),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .default("load"),
      timeout_ms: z.number().int().positive().default(30_000),
    })
    .default({}),
};

// ============================================================
// 包装 helper（与 browse.ts / fetch-url.ts 同范式）
// ============================================================
function payloadContent<T>(result: InteractResult<T>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}

// ============================================================
// 核心：doScreenshotTool（独立可测，parse6 §3.2.3 实装）
// ============================================================
/**
 * screenshot 的纯函数实装 —— 单元测直接调，不经 MCP server.tool 装配。
 *
 * 流程（parse6 §3.2.3 伪码逐条对齐）：
 *  1. SSRF 守门（与 browse_headless 同函数同 config）
 *  2. 透传 BrowseOptions 形状（与 browse.ts schema 对齐）
 *  3. 经 BrowseChannel 入口（隐式享受 browse fallback 链；不绕过 INV-6 dispatch Map）
 *  4. preview 解析：从 "screenshot saved to /tmp/...png" 抽出 path
 *  5. 返 InteractResult<ScreenshotResult>
 */
export async function doScreenshotTool(
  rawUrl: string,
  opts: ScreenshotOptions,
  headless: HeadlessChannel,
  ssrfConfig: SsrfConfig,
): Promise<InteractResult<ScreenshotResult>> {
  // ---------- 1. SSRF 守门（与 browse_headless 同函数同 config） ----------
  const ssrfResult = await ssrfGuard(rawUrl, ssrfConfig);
if (!ssrfResult.allowed) {
    // v1.18.2（doc/governance/10 F1）：reason 二分——策略确定性拒 → didnt（不可重试）；
    // DNS 环境瞬态（dns_failed/dns_empty，TUN 断网/DNS 抖动）→ unknown（可重试）。
    const d = ssrfDenial(ssrfResult.reason);
    return {
      outcome: d.outcome,
      data: null,
      served_by: "lasso.ssr_guard",
      fallback_used: false,
      retrieval_method: d.retrieval_method,
      error: d.error,
    };
  }

  // ---------- 2. 透传 BrowseOptions 形状（与 browse.ts schema 对齐） ----------
  // review-r1：viewport / region / format / quality 四参数已从 schema 移除——
  // v0.5 起「接受但不映射」的 deferred 依据（上游 0.3.0 只接 fullPage+format）已随
  // v1.11 锁 1.7.0 失效且从未复审，调用方传 region 会静默得到整页 PNG（接口面死角）。
  // 接口面诚实化：只声明真正落地的三参数。format/viewport 若未来接入，须连同
  // doScreenshot 的 PNG magic 校验 / 扩展名 / extractScreenshotPath 一起实装后再回 schema。
  const browseOpts: BrowseOptions = {
    screenshot: { full: opts.full_page },
    wait_until: opts.wait_until,
    timeout_ms: opts.timeout_ms,
  };

  // ---------- 3. 经 BrowseChannel 入口（隐式享受 browse fallback 链；不绕过 INV-6） ----------
  const result = await headless.browse(rawUrl, "screenshot", browseOpts);

  // ---------- 4. preview 解析：从 "screenshot saved to /tmp/...png" 抽 path ----------
  // doScreenshot 写盘后 preview = "screenshot saved to /tmp/lasso-screenshot-<uuid>.png"
  // 把 preview 提升为 data.path 字段（FetchResult 风格，便于 CC 直接读路径）
  const screenshotResult: InteractResult<ScreenshotResult> = {
    outcome: result.outcome,
    data: result.data
      ? {
          url: rawUrl,
          path: extractScreenshotPath(result.data.preview),
          preview: result.data.preview,
          ...(result.data.state_id
            ? { state_id: result.data.state_id }
            : {}),
        }
      : null,
    served_by: result.served_by,
    fallback_used: result.fallback_used,
    retrieval_method: result.retrieval_method,
    ...(result.error ? { error: result.error } : {}),
  };
  return screenshotResult;
}

/**
 * helper：从 "screenshot saved to /tmp/...png" 抽 /tmp/...png（parse6 §3.2.3）。
 *
 * 兼容 png / jpg / jpeg 扩展名（v0.5 doScreenshot 固定 png，但为 v0.6+ format 扩展预留）。
 * 找不到 → undefined（CC 据 preview 字段自己解析）。
 */
export function extractScreenshotPath(
  preview: string | undefined,
): string | undefined {
  if (!preview) return undefined;
  const m = preview.match(/\/[^\s]+\.(?:png|jpg|jpeg)/i);
  return m ? m[0] : undefined;
}

// ============================================================
// 注册器（parse6 §3.2.2）
// ============================================================
/**
 * @param server      MCP server
 * @param headless    HeadlessChannel（chrome-devtools-mcp --headless --isolated）
 * @param ssrfConfig  SSRF allowRanges / denyRanges（从 env 加载，与 browse_headless 共用）
 */
export function registerScreenshotTool(
  server: McpServer,
  headless: HeadlessChannel,
  ssrfConfig: SsrfConfig,
): void {
  server.tool(
    "screenshot",
    SCREENSHOT_DESCRIPTION,
    screenshotSchema,
    screenshotAnnotations,
    async (args) => {
      const url: string = args.url;
      // zod .default({}) 已注入所有默认值
      const opts: ScreenshotOptions = {
        full_page: args.options.full_page,
        wait_until: args.options.wait_until,
        timeout_ms: args.options.timeout_ms,
      };

      const result = await doScreenshotTool(url, opts, headless, ssrfConfig);
      // SSRF 拒绝 / browse 失败 / 成功 都包成 InteractResult，序列化即可
      return payloadContent(result);
    },
  );
}
