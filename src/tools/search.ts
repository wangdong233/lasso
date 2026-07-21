/**
 * search tool 注册（parse1 §3.12 + §4.4）
 *
 * 单一 fallback 链：search.zhipu → browse_headless（cross_modal=true）。
 *  - primary 走 SearchChannel.search（智谱 web_search_prime streamable-http）
 *  - fallback 走 serpScrapeFallback（注入的 browseExec 实搜百度 + 抽链接）
 *
 * 跨模态链只在 plan 层声明，executor 把 channel 名翻译成具体 channel 调用。
 * FallbackDecider 不知道 channel 是谁——它只按 outcome 推进。
 *
 * 注意：index.ts 在装配时构造 `browseExec` —— 通常 `HeadlessChannel.browse`
 * 的 thin wrapper（url → {outcome, data:{preview}}）。这样 tools/search 不硬依赖
 * channels/，避免循环依赖（见 serp/extract.ts BrowseExec 注释）。
 *
 * 借鉴：parse1 §3.12 registerSearchTool 骨架；附录 B SEARCH_DESCRIPTION。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InteractResult, SearchResult } from "../types.js";
import type { SearchChannel } from "../channels/SearchChannel.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import type { BrowseExec } from "../serp/extract.js";
import { serpScrapeFallback } from "../serp/extract.js";
import { SEARCH_DESCRIPTION } from "./descriptions.js";
import { searchAnnotations } from "./annotations.js";

// ============================================================
// Schema
// ============================================================
export const searchSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  engine: z.string().default("zhipu"),
  region: z.string().default("cn"),
  no_cache: z.boolean().default(false),
};

// ============================================================
// 注册器
// ============================================================
/**
 * @param server           MCP server
 * @param search           SearchChannel（智谱）
 * @param decider          单一 fallback 引擎
 * @param browseHeadlessExec  跨模态降级用的 browse 执行器（通常 wrap HeadlessChannel.browse）
 */
export function registerSearchTool(
  server: McpServer,
  search: SearchChannel,
  decider: FallbackDecider,
  browseHeadlessExec: BrowseExec,
): void {
  server.tool(
    "search",
    SEARCH_DESCRIPTION,
    searchSchema,
    searchAnnotations,
    async (args) => {
      const query: string = args.query;
      const limit: number = args.limit;
      const engine: string = args.engine;
      const region: string = args.region;
      const noCache: boolean = args.no_cache;

      const plan = {
        primary: "search.zhipu",
        fallbacks: ["browse_headless"],
        cross_modal: true,
      };

      const result: InteractResult<SearchResult> = await decider.runWithFallback(
        plan,
        async (channelName) => {
          if (channelName === "search.zhipu") {
            return search.search(query, {
              limit,
              engine,
              region,
              no_cache: noCache,
            });
          }
          if (channelName === "browse_headless") {
            // 跨模态降级：实搜百度 + 从 a11y 快照抽链接
            return serpScrapeFallback(query, limit, browseHeadlessExec);
          }
          throw new Error(`unknown_channel:${channelName}`);
        },
      );

      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
