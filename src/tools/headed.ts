/**
 * headed tool 注册（W2，doc/bugs/09 决议 A.4⑥r1 + A.2r1，2026-09-16）
 *
 * browse_headed：L2 有头强力档的 MCP 入口。
 *
 *  - 默认注册（对齐 browse_headless/browse_logged_in 命名族，R-CI-01；本机
 *    工具族先例 browse_logged_in 同默认注册——无 INV-25 式部署级解锁门，
 *    N3 复核定向驳回：介入面用每次调用的 consent 契约治理更小且不弱化）。
 *  - **S2 介入型**：调用即弹真实窗口。consent 契约 = description 首行
 *    "opens a real on-screen window — call only after explicit user consent"
 *    + 驱逐 hint 的 ask-the-user 指令（决议 A.2r1）——description 与 hint
 *    双钉。
 *  - SSRF guard / caller-tier gate 与 browse_headless 同范式（BrowseChannel
 *    继承链，三层安全零削弱）。
 *  - 终端通道：plan 仅含 browse_headed（fallbacks=[]—— INV-23 不跨通道，
 *    有头档是用户显式选择语义，禁自动回退到任何其它通道）。
 *  - 归属锚（决议 A.4⑤r1）：成功返回体 data.window_opened:true 如实回显
 *    （窗口可见性对调用方可判读）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrowseOptions, BrowseResult, InteractResult } from "../types.js";
import type { HeadedChannel } from "../channels/HeadedChannel.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import type { CallerTierTracker } from "../runtime/CallerTierTracker.js";
import {
  callerIdFromMeta,
  callerCapExceededResult,
} from "../runtime/CallerTierTracker.js";
import { ssrfGuard, ssrfDenial, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { isFileProtocol, checkFileUrl } from "../ssrf/file-guard.js";
import { browseSchema } from "./browse.js";
import { BROWSE_HEADED_DESCRIPTION } from "./descriptions.js";
import { browseHeadedAnnotations } from "./annotations.js";

function ssrfBlocked(reason: string) {
  // v1.18.2（doc/governance/10 F1）同款：策略拒 = didnt（browse.ts 单一范式复刻）
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

/** 成功态回显 window_opened:true（决议 A.4⑤r1 归属锚②——如实回显窗口已开）。 */
function headedResultContent(result: InteractResult<BrowseResult>) {
  const enriched: InteractResult<BrowseResult> = {
    ...result,
    data: result.data
      ? ({ ...result.data, window_opened: true } as BrowseResult)
      : result.data,
  };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(enriched, null, 2) },
    ],
  };
}

export function registerHeadedTool(
  server: McpServer,
  headed: HeadedChannel,
  decider: FallbackDecider,
  ssrfConfig: SsrfConfig,
  callerTier?: CallerTierTracker | null,
): void {
  server.tool(
    "browse_headed",
    BROWSE_HEADED_DESCRIPTION,
    browseSchema,
    browseHeadedAnnotations,
    async (args, extra) => {
      const url: string | undefined = args.url;
      const action: string = args.action;
      const options: BrowseOptions = args.options ?? {};

      // caller-tier 事前 gate（browse_headless 同范式，parse7 §3.3）
      if (callerTier) {
        const callerId = callerIdFromMeta(extra?._meta);
        if (!callerTier.tryAcquire(callerId)) {
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
      }

      // SSRF 守门（file: 路由 + ssrfGuard；url 缺省 = current-page 零导航面，
      // BUG-07 A⁺ 同款跳过语义——browse.ts 单一范式复刻）
      if (url !== undefined) {
        const result = isFileProtocol(url)
          ? checkFileUrl(url, ssrfConfig.fileAllowFrom ?? [])
          : await ssrfGuard(url, ssrfConfig);
        if (!result.allowed) {
          return ssrfBlocked(result.reason);
        }
      }

      // 终端通道（INV-23）：有头档是用户显式选择——永不自动 fallback。
      // 经 decider 走熔断/审计链（actions_and_results 一行），fallbacks 恒空。
      const plan = {
        primary: "browse_headed",
        fallbacks: [] as string[],
        cross_modal: false,
      };

      const result = await decider.runWithFallback(plan, async (name) => {
        if (name === "browse_headed") {
          return headed.browse(url, action, options);
        }
        throw new Error(`unknown_channel:${name}`);
      });

      return headedResultContent(result);
    },
  );
}
