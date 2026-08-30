/**
 * browse tools 注册（parse1 §3.12 + §4.3 SSRF + §4.4 fallback）
 *
 * 注册两个 tool：browse_headless / browse_logged_in。
 *
 *  - browse_headless:
 *      SSRF guard → fallback 链 [browse_headless → browse_logged_in]（cross_modal=false）
 *      headless JS 渲染不全 /被封 /超时 → 自动升真实 Chrome
 *
 *  - browse_logged_in:
 *      SSRF guard → 终端通道（无下一跳；2FA 检测命中时 outcome=didnt
 *      + NEEDS_MANUAL_2FA，由 isFallbackWorthy 判定为"不 fallback"）
 *
 * 注意：SSRF 检查只在 tool 入口做（不进 channel）—— 因为 channel 内部的
 * navigate_page 是 chrome-devtools-mcp 调用，URL 透传到 Chrome 的导航；
 * SSRF 在 Lasso 这一层拦截，绝不让 chrome-devtools-mcp 看到私网 URL。
 *
 * 借鉴：parse1 §3.12 registerBrowseTools；附录 B BROWSE_*_DESCRIPTION；
 * mcp-chrome 浏览器层 SSRF 实践。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowseOptions, BrowseResult, InteractResult } from "../types.js";
import type { HeadlessChannel } from "../channels/HeadlessChannel.js";
import type { LoggedInChannel } from "../channels/LoggedInChannel.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import type { CallerTierTracker } from "../runtime/CallerTierTracker.js";
import {
  callerIdFromMeta,
  callerCapExceededResult,
} from "../runtime/CallerTierTracker.js";
import { ssrfGuard, ssrfDenial, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import {
  BROWSE_HEADLESS_DESCRIPTION,
  BROWSE_LOGGED_IN_DESCRIPTION,
} from "./descriptions.js";
import {
  browseHeadlessAnnotations,
  browseLoggedInAnnotations,
} from "./annotations.js";

// ============================================================
// Schema
// ============================================================
const browseSchema = {
  url: z.string().url(),
  action: z.string().default("snapshot"),
  options: z
    .object({
      selectors: z.record(z.string()).optional(),
      js: z.string().optional(),
      // review-r2：wait_until / screenshot.element / timeout_ms 已从 schema 删除——
      // 三者自 v0.1 起「schema 接受 → channel 零消费」（doNavigate 只读 no_cache、
      // doScreenshot 只读 screenshot.full；grep waitUntil 全 src=0），调用方传
      // wait_until=networkidle 期望等待语义会静默无效（review-r1 F3 同类死角）。
      // 未来接入时须连同 doNavigate 的 navigate_page 映射一起实装后再回 schema。
      screenshot: z
        .object({
          full: z.boolean().optional(),
        })
        .optional(),
      no_cache: z.boolean().optional(),
      // v1.18.2（doc/governance/10 F3+Y1）：steps chain 时间预算（ms），默认 120s，钳制上限 600s
      // （慢站/长 SPA/多步表单等合法长链显式放宽；预算耗尽终止语义=unknown 可重试）。
      budget_ms: z.number().int().positive().max(600_000).optional(),
      // v1.8 Phase D（D2）：steps 多步链入参。BrowseChannel v0.3 起已实装 steps 分流
      // （browse() 入口 options.steps 非空 → StepEngine.runChain），但 MCP schema 缺此键
      // → zod strip → U-03 多步链经 MCP 不可达。形状对照 src/browse/steps-types.ts Step。
      steps: z
        .array(
          z.object({
            action: z.string(),
            selectors: z.record(z.string()).optional(),
            js: z.string().optional(),
            expect: z
              .object({
                text: z.string().optional(),
                selector: z.string().optional(),
                url_contains: z.string().optional(),
                gone: z.boolean().optional(),
                timeout_ms: z.number().int().positive().optional(),
              })
              .optional(),
            timeout_ms: z.number().int().positive().optional(),
            label: z.string().optional(),
          }),
        )
        .optional(),
      // v1.1（parse12 §1.3 + §3.3.1）：extract action 的 markdown 抽取模式。
      // .optional() 无 default（防 zod 自动注入致 raw byte-identical 断言失真）。
      // 仅 action="extract" 读此字段；snapshot/navigate/screenshot 等忽略。
      extract_mode: z.enum(["raw", "markdown", "markdown_cited"]).optional(),
      // v1.17 Phase F（parse24 §6.2 C2）：extract 的交互句柄 opt-in（缺省关 =
      // byte-identical，INV-66 手法）。markdown* 档注入 data-lasso-uid ref +
      // 附录；raw 档运行时忽略 + ignored_include_refs:true 标注（冲突 #8）。
      include_refs: z.boolean().optional(),
      // action=wait 消费（doWait 读 expect.text，必需；BrowseChannel doWait）；
      // 其余 action 忽略。steps 内的 expect 是 step 自有字段（StepEngine 三态消费）。
      expect: z
        .object({
          text: z.string().optional(),
          selector: z.string().optional(),
          url_contains: z.string().optional(),
          gone: z.boolean().optional(),
          timeout_ms: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .default({}),
};

// ============================================================
// 工具
// ============================================================
function ssrfBlocked(reason: string) {
  // v1.18.2（doc/governance/10 F1）：reason 二分——策略确定性拒 → didnt（不可重试）；
  // DNS 环境瞬态（dns_failed/dns_empty，TUN 断网/DNS 抖动）→ unknown（可重试）。
  const d = ssrfDenial(reason);
  const payload: InteractResult<never> = {
    outcome: d.outcome,
    data: null,
    served_by: "lasso.ssr_guard",
    fallback_used: false,
    retrieval_method: d.retrieval_method,
    error: d.error,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function browseResultContent(result: InteractResult<BrowseResult>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}

/**
 * v1.8 Phase E（W1-DEF-10）：caller-tier 事前 gate。
 * 未注入 callerTier → 放行（零回归）；超额 → tri-state didnt +
 * retrieval_method="caller_cap_exceeded"（与 search.ts 同范式，parse7 §3.3）。
 * 返回 null 表示放行（调用方继续主路径）。
 */
function callerTierGate(
  callerTier: CallerTierTracker | null | undefined,
  meta: unknown,
): ReturnType<typeof browseResultContent> | null {
  if (!callerTier) return null;
  const callerId = callerIdFromMeta(meta);
  if (callerTier.tryAcquire(callerId)) return null;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          callerCapExceededResult(
            callerId,
            callerTier.currentUsage(callerId),
            callerTier.currentCap(callerId),
          ),
          null,
          2,
        ),
      },
    ],
  };
}

// ============================================================
// 注册器
// ============================================================
/**
 * @param server    MCP server
 * @param headless  HeadlessChannel（chrome-devtools-mcp --headless --isolated）
 * @param logged_in LoggedInChannel（chrome-devtools-mcp --browser-url :9222）
 * @param decider   单一 fallback 引擎
 * @param ssrfConfig  SSRF allowRanges / denyRanges（从 env 加载）
 */
export function registerBrowseTools(
  server: McpServer,
  headless: HeadlessChannel,
  logged_in: LoggedInChannel,
  decider: FallbackDecider,
  ssrfConfig: SsrfConfig,
  /**
   * v1.8 Phase E（W1-DEF-10）：CallerTierTracker per-caller 滑动窗配额。
   * 未注入 / null / undefined → 无事前 gate（零回归，byte-identical v1.7）。
   * 注入          → 两个 handler 入口 tryAcquire（callerId 取 request
   *                 _meta.callerId，CC 不传则 "anonymous"）；超额 → tri-state
   *                 didnt + retrieval_method="caller_cap_exceeded" 透明返回。
   */
  callerTier?: CallerTierTracker | null,
): void {
  // ----- browse_headless -----
  server.tool(
    "browse_headless",
    BROWSE_HEADLESS_DESCRIPTION,
    browseSchema,
    browseHeadlessAnnotations,
    async (args, extra) => {
      const url: string = args.url;
      const action: string = args.action;
      const options: BrowseOptions = args.options ?? {};

      // caller-tier 事前 gate 在 SSRF guard 之前（parse7 §3.3「handler 入口」）
      const denied = callerTierGate(callerTier, extra?._meta);
      if (denied) return denied;

      const ssrfResult = await ssrfGuard(url, ssrfConfig);
      if (!ssrfResult.allowed) {
        return ssrfBlocked(ssrfResult.reason);
      }

      const plan = {
        primary: "browse_headless",
        fallbacks: ["browse_logged_in"],
        cross_modal: false,
      };

      const result = await decider.runWithFallback(plan, async (name) => {
        if (name === "browse_headless") {
          return headless.browse(url, action, options);
        }
        if (name === "browse_logged_in") {
          return logged_in.browse(url, action, options);
        }
        throw new Error(`unknown_channel:${name}`);
      });

      return browseResultContent(result);
    },
  );

  // ----- browse_logged_in -----
  server.tool(
    "browse_logged_in",
    BROWSE_LOGGED_IN_DESCRIPTION,
    browseSchema,
    browseLoggedInAnnotations,
    async (args, extra) => {
      const url: string = args.url;
      const action: string = args.action;
      const options: BrowseOptions = args.options ?? {};

      // caller-tier 事前 gate 在 SSRF guard 之前（与 browse_headless 同范式）
      const denied = callerTierGate(callerTier, extra?._meta);
      if (denied) return denied;

      const ssrfResult = await ssrfGuard(url, ssrfConfig);
      if (!ssrfResult.allowed) {
        return ssrfBlocked(ssrfResult.reason);
      }

      // 终端通道：v0.1 不再 fallback（no next hop）。2FA 命中走 outcome=didnt
      // + NEEDS_MANUAL_2FA，调用方据此决定是否中止。
      const result = await logged_in.browse(url, action, options);
      return browseResultContent(result);
    },
  );
}
