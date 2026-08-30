/**
 * browserbase tool 注册（parse5 §3.2 + §6.3 #16，v0.4 M0.4c 新增）
 *
 * 单一 cloud 浏览器工具，schema 与 browse_headless / browse_logged_in 同构（同 action 集）。
 * 唯一差异：路由到 BrowserbaseChannel（extends BrowseChannel，复用 actionDispatch Map）。
 *
 * 装配铁律（parse5 §3.4 + INV-25）：
 *  - 本 register 仅在 index.ts **双重解锁**（LASSO_ALLOW_CLOUD_BROWSER=true + API key）
 *    通过后才被调用；未解锁时 server.listTools() 完全不含 browserbase（默认 OFF 零回归）
 *  - FallbackDecider 前置 PolicyGate.check 已在 index.ts 注入；本 tool 的 plan 仅含
 *    browse_cloud_browserbase（terminal channel，cloud 浏览器不做下一跳 fallback ——
 *    parse5 §3.2.1 「cloud 是 fallback 链尾」语义）
 *
 * 边界（parse5 §3.2.1 不做项）：
 *  - 不解 2FA / CAPTCHA（cloudflare_manual_switch 升级信号由 StealthEngine 给）
 *  - 不与 browse_logged_in 共享登录态（cloud Chrome 是独立 session）
 *  - 不在 forest 调度层注册（model 显式调 browserbase tool，不经 interact_*）
 *
 * 借鉴：
 *  - browse.ts registerBrowseTools（schema / ssrfGuard / InteractResult 包装范式）
 *  - parse5 §3.2.2 BrowserbaseChannel（lazy connect + stealth inject hook）
 *  - Argus manual-switch pattern（policy_risk 显式标注）
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowseOptions, BrowseResult, InteractResult } from "../types.js";
import type { BrowserbaseChannel } from "../channels/BrowserbaseChannel.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import { ssrfGuard, ssrfDenial, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { BROWSERBASE_DESCRIPTION } from "./descriptions.js";
import { browserbaseAnnotations } from "./annotations.js";

// ============================================================
// Schema（与 browse.ts browseSchema 同构 —— 同 action 集）
// ============================================================
const browserbaseSchema = {
  url: z.string().url(),
  action: z.string().default("snapshot"),
  options: z
    .object({
      selectors: z.record(z.string()).optional(),
      js: z.string().optional(),
      // review-r2：wait_until / screenshot.element / timeout_ms / stealth_profile
      // 已删——四者全链路零消费（doNavigate 只读 no_cache；doScreenshot 只读
      // screenshot.full；stealth 注入走 BrowserbaseChannel constructor profileName，
      // 本字段从未被读取）。与 browse.ts schema 同步诚实化。
      screenshot: z
        .object({
          full: z.boolean().optional(),
        })
        .optional(),
      no_cache: z.boolean().optional(),
      // 与 browse.ts 同构：expect 字段供 LLM 提前写好（channel 内 wait action 消费）
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
// 工具（与 browse.ts 同范式）
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

// ============================================================
// 注册器
// ============================================================
/**
 * @param server      MCP server
 * @param browserbase BrowserbaseChannel（cloud Chrome，extends BrowseChannel）
 * @param decider     单一 fallback 引擎（已注入 PolicyGate；cloud_blocked 走 policy_blocked）
 * @param ssrfConfig  SSRF allowRanges / denyRanges（同 browse_headless / browse_logged_in）
 *
 * INV-1（browse 唯一入口）：本 tool 不算「browse 入口」（grep INV-1 只匹配 browse_headless /
 *   browse_logged_in）；cloud 浏览器是平行工具，不复用 browse 名空间。
 * INV-23（fallback 链不跨 surface）：本 tool 的 plan 仅含 browse_cloud_browserbase（terminal）；
 *   cloud 失败由 PolicyGate / retrieval_method=cloudflare_manual_switch 显式升级，不跨 surface。
 */
export function registerBrowserbaseTool(
  server: McpServer,
  browserbase: BrowserbaseChannel,
  decider: FallbackDecider,
  ssrfConfig: SsrfConfig,
): void {
  server.tool(
    "browserbase",
    BROWSERBASE_DESCRIPTION,
    browserbaseSchema,
    browserbaseAnnotations,
    async (args) => {
      const url: string = args.url;
      const action: string = args.action;
      const options: BrowseOptions = args.options ?? {};

      // SSRF 守门：与 browse_headless / browse_logged_in 同（cloud Chrome 也禁私网）
      const ssrfResult = await ssrfGuard(url, ssrfConfig);
      if (!ssrfResult.allowed) {
        return ssrfBlocked(ssrfResult.reason);
      }

      // 单 channel terminal plan：cloud 浏览器是 fallback 链尾（parse5 §3.2.1），
      // 不再 fallback 到 browse_headless / browse_logged_in（跨 surface 红线 INV-23）。
      // cloud 通道失败信号（cloudflare_manual_switch / cloud_no_key）由 model 显式处理。
      const plan = {
        primary: "browse_cloud_browserbase",
        fallbacks: [],
        cross_modal: false,
      };

      const result = await decider.runWithFallback(plan, async (name) => {
        if (name === "browse_cloud_browserbase") {
          return browserbase.browse(url, action, options);
        }
        throw new Error(`unknown_channel:${name}`);
      });

      return browseResultContent(result);
    },
  );
}
