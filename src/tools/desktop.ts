/**
 * desktop tool 注册（parse4 §3.3 + 13 §2.1 + 13 §3.3）
 *
 * 单 server.tool("desktop", ...) + action-enum 折叠 6 action（13 审查 #1 必改）：
 *   snapshot | find | act | wait | screenshot | doctor
 *
 * 不拆 6 个 server.tool 的理由（13 §2.1 + parse4 §1.4）：
 *  - 减少 CC tool-selection 摩擦（一个工具 = 一次路由决策）
 *  - 共用 options schema（act/screenshot 都用 screenshot_region 等）
 *  - 与 browse 的 action 分发同范式（dispatch by string）
 *
 * 不变量守护：
 *  - INV-5：本文件 import desktopAnnotations 携带 readOnlyHint/openWorldHint
 *  - INV-17：单 tool 注册（"desktop" 恰好注册一次，禁注册 desktop_snapshot 等拆分工具）
 *  - INV-21：本文件不出现平台 API 字面量（只调 channel.observe/act/wait/...）
 *
 * 借鉴：parse4 §3.3.1；mcp-chrome chrome_computer action-enum 折叠；
 * tools/search.ts 的 registerXxxTool 签名风格。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DesktopChannel } from "../channels/DesktopChannel.js";
import type { FallbackDecider } from "../fallback/FallbackDecider.js";
import { DESKTOP_DESCRIPTION } from "./descriptions.js";
import { desktopAnnotations } from "./annotations.js";

// ============================================================
// Schema（parse4 §3.3.1 完整 zod schema）
// ============================================================
/**
 * 单 tool action-enum schema。options 是宽松对象（各 action 仅消费自己关心的字段）。
 *
 * 设计：actions 数组用 discriminated union（kind 标签），与 UiAction 类型镜像；
 * expect 与 BrowseChannel 的 ExpectCondition 同形（tri-state 后置条件）。
 */
const desktopSchema = {
  action: z
    .enum(["snapshot", "find", "act", "wait", "screenshot", "doctor"])
    .default("snapshot"),
  options: z
    .object({
      app: z.string().optional(),
      state_id: z.string().optional(),
      max_depth: z.number().int().positive().max(20).default(8),
      actions: z
        .array(
          z.union([
            z.object({ kind: z.literal("click"), ref: z.string() }),
            z.object({
              kind: z.literal("type"),
              ref: z.string(),
              text: z.string(),
            }),
            z.object({ kind: z.literal("press"), key: z.string() }),
            z.object({
              kind: z.literal("scroll"),
              ref: z.string(),
              dx: z.number(),
              dy: z.number(),
            }),
            z.object({ kind: z.literal("hotkey"), keys: z.array(z.string()) }),
          ]),
        )
        .optional(),
      expect: z
        .object({
          text: z.string().optional(),
          role: z.string().optional(),
          ref: z.string().optional(),
          gone: z.boolean().optional(),
          timeout_ms: z.number().int().positive().default(5000),
        })
        .optional(),
      where: z
        .object({
          text: z.string().optional(),
          role: z.string().optional(),
          ref: z.string().optional(),
        })
        .optional(),
      screenshot_region: z
        .object({
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
        })
        .optional(),
      timeout_ms: z.number().int().positive().default(30000),
      picture_only: z.boolean().optional(),
    })
    .default({}),
};

// ============================================================
// registerDesktopTool
// ============================================================
/**
 * @param server   MCP server
 * @param desktop  DesktopChannel（已注入 rust + axProvider + vlmProvider + decider）
 * @param _decider 注入但 observe/find 路径不 fallback（仅 act 走 decider，且在 channel 内）
 *
 * INV-17：本函数只调一次 server.tool("desktop", ...)（注册恰好一次）。
 */
export function registerDesktopTool(
  server: McpServer,
  desktop: DesktopChannel,
  // decider 仅作显式依赖标记 —— 真正使用在 DesktopChannel.act 内部
  _decider?: FallbackDecider,
): void {
  server.tool(
    "desktop",
    DESKTOP_DESCRIPTION,
    desktopSchema,
    desktopAnnotations,
    async (args) => {
      const action = args.action as
        | "snapshot"
        | "find"
        | "act"
        | "wait"
        | "screenshot"
        | "doctor";
      const options = (args.options ?? {}) as Record<string, unknown>;

      let result: unknown;
      switch (action) {
        case "snapshot":
          result = await desktop.observe("snapshot", options);
          break;
        case "find":
          result = await desktop.observe("find", options);
          break;
        case "act":
          result = await desktop.act(options);
          break;
        case "wait":
          result = await desktop.wait(options, numericOrUndefined(options.timeout_ms));
          break;
        case "screenshot":
          result = await desktop.screenshot(options);
          break;
        case "doctor":
          result = await desktop.doctor();
          break;
        default: {
          // 类型穷尽性守护（zod enum 已过滤，但 TS narrowing 兜底）
          const _exhaustive: never = action;
          result = {
            outcome: "didnt" as const,
            data: null,
            served_by: "desktop",
            fallback_used: false,
            retrieval_method: "unknown_action",
            error: `unknown_action:${String(_exhaustive)}`,
          };
        }
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}

/** 安全 number | undefined 提取（zod 已校验，运行时兜底防 unknown）。 */
function numericOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
