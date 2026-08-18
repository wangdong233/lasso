/**
 * search_local 工具注册（B1 第四通道，parse24 §5.1/§5.4 / doc/25 裁决④）
 *
 * **形态定案（parse24 §5.1）**：工具直连、不建 BaseChannel 子类——本地只读查询
 * 无网络面、无 fallback 语义（tri-state 退化为 worked/didnt，unknown 仅意外异常），
 * 照 read_text / doctor-tool 纯本地工具先例；不入 RootRegistry/capability bag
 * （INV-36 只对注册 channel 生效；R-ABS-01 防空壳对称）。
 *
 * **三源分阶段（parse24 §5.2-§5.4）**：
 *  - history（默认）：Chrome History 多 profile 只读 SQLite（chrome-history.ts）
 *  - files：mdfind / Spotlight（mdfind.ts；顺带过渡覆盖 Apple Notes 标题搜索）
 *  - notes：**本版明确推迟**——enum 保值但返 didnt + reason:"notes_deferred_v2"
 *    （比从 enum 删除更诚实：CC 能看见源存在但未开放，不会误以为 Lasso 不知道
 *    笔记的存在；ZBODY zlib+protobuf 全文解析是 500+ 行独立工程，v2 再议）。
 *
 * **隐私红线（INV-81）**：只读、无全文导出（title/url/时间/标题片段）、
 * limit 硬顶 50（无 dump 面板）、模块零网络、日志只记 query_len。
 *
 * 四处联动（INV-81(f)，防 read_text D1「写好没装配」bug 类）：
 *   本注册器 + index.ts 注册调用 + index.ts V5_TOOL_TO_CHANNEL + descriptions.ts。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InteractResult } from "../types.js";
import { SEARCH_LOCAL_DESCRIPTION } from "../tools/descriptions.js";
import { searchLocalAnnotations } from "../tools/annotations.js";
import { logger } from "../util/logger.js";
import {
  searchChromeHistory,
  type ChromeHistoryData,
  type ChromeHistoryDeps,
} from "./chrome-history.js";
import { searchMdfind, type MdfindData, type MdfindDeps } from "./mdfind.js";

// ============================================================
// Schema（parse24 §5.1 定案；limit 硬顶 50 = INV-81(c)）
// ============================================================
export const searchLocalSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  source: z.enum(["history", "files", "notes"]).default("history"),
  /** Chrome profile 名（"Default"/"Profile 1"…；缺省扫全部） */
  profile: z.string().optional(),
};

export type SearchLocalArgs = {
  query: string;
  limit: number;
  source: "history" | "files" | "notes";
  profile?: string;
};

/** 依赖注入面（测试零真机依赖；生产走 index.ts 默认注入） */
export interface SearchLocalDeps {
  history?: ChromeHistoryDeps;
  files?: MdfindDeps;
}

// ============================================================
// 返回形状（history | files 判别联合）
// ============================================================
export type SearchLocalData = ChromeHistoryData | MdfindData;

// ============================================================
// 核心：doSearchLocal（独立可测，不经 MCP 装配）
// ============================================================
export async function doSearchLocal(
  args: SearchLocalArgs,
  deps: SearchLocalDeps = {},
): Promise<InteractResult<SearchLocalData>> {
  // 隐私红线（INV-81(e)）：日志只记 query_len，永不记查询原文
  logger.info({
    evt: "search_local_query",
    source: args.source,
    query_len: args.query.length,
    limit: args.limit,
  });

  if (args.source === "notes") {
    // parse24 §5.4：Notes 源本版推迟（三条非懒惰理由见文件头）；诚实 didnt
    return {
      outcome: "didnt",
      data: null,
      served_by: "search_local",
      fallback_used: false,
      retrieval_method: "notes_deferred_v2",
      error: "notes_deferred_v2",
    };
  }

  try {
    if (args.source === "files") {
      return searchMdfind({ query: args.query, limit: args.limit }, deps.files);
    }

    // history（默认源）
    return await searchChromeHistory(
      { query: args.query, limit: args.limit, profile: args.profile },
      deps.history,
    );
  } catch (e) {
    // tri-state：unknown 仅意外异常（parse24 §5.1）
    logger.warn({
      evt: "search_local_unexpected",
      source: args.source,
      err_name: String(e instanceof Error ? e.constructor.name : e),
    });
    return {
      outcome: "unknown",
      data: null,
      served_by: "search_local",
      fallback_used: false,
      retrieval_method: args.source === "files" ? "spotlight_mdfind" : "chrome_history_sqlite",
      error: `unexpected:${String(e instanceof Error ? e.message : e).slice(0, 200)}`,
    };
  }
}

// ============================================================
// 注册器
// ============================================================
export function registerSearchLocalTool(
  server: McpServer,
  deps: SearchLocalDeps = {},
): void {
  server.tool(
    "search_local",
    SEARCH_LOCAL_DESCRIPTION,
    searchLocalSchema,
    searchLocalAnnotations,
    async (args) => {
      const result = await doSearchLocal(args as SearchLocalArgs, deps);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
