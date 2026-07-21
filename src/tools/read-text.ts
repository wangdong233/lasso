/**
 * read_text tool 注册（parse3 §3.4，F3.2.20 续页）
 *
 * 当 browse_headless / browse_logged_in / StepEngine 的 chain result 超 48KiB
 * 或 2000 行时，applyOutputEnvelope() 把整段落盘到 /tmp/lasso-output/@oN.txt
 * （mode 0o600），返回 16KiB preview + continue_hint：
 *   "read_text({ref:\"@o3\", offset:16384})"
 *
 * CC 按此 hint 调 read_text 续页。ref 是模块内 in-memory Map 中的 key，
 * 进程重启即失效（@oN 不跨进程）。
 *
 * Annotations：readOnly + 非 openWorld（不触外网，仅读本地 spill 文件）。
 *
 * INV-5：携带 ToolAnnotations。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readOutputPage } from "../util/output-envelope.js";

// ============================================================
// 描述
// ============================================================
export const READ_TEXT_DESCRIPTION = [
  "Paginate through large output spilled by browse_headless / browse_logged_in",
  "when the result exceeded the 48 KiB / 2000 line envelope.",
  "",
  "Use the `continue_hint` returned by the prior browse call. It looks like:",
  '  read_text({ref:"@o3", offset:16384})',
  "",
  "Each call returns up to `limit` bytes (default 16 KiB). Keep incrementing",
  "`offset` by the prior `limit` until `eof` is true.",
  "",
  "Notes:",
  "  - ref is in-memory; it expires when the Lasso process restarts.",
  "  - Files are written mode 0o600 (private to your user).",
  "",
  "Args:",
  '  ref    (str, required, matches /^@o\\d+$/)  — e.g. "@o3"',
  "  offset (int, default 0)                      — byte offset",
  "  limit  (int, default 16384, max 65536)       — page size in bytes",
  "",
  "Returns: { text, eof, total_bytes } as JSON text.",
].join("\n");

// ============================================================
// Annotations
// ============================================================
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const readTextAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

// ============================================================
// Schema
// ============================================================
const readTextSchema = {
  ref: z
    .string()
    .regex(/^@o\d+$/, "ref must match @oN (e.g. @o3)"),
  offset: z.number().int().min(0).default(0),
  limit: z
    .number()
    .int()
    .positive()
    .max(64 * 1024)
    .default(16 * 1024),
};

// ============================================================
// 注册器
// ============================================================
export function registerReadTextTool(server: McpServer): void {
  server.tool(
    "read_text",
    READ_TEXT_DESCRIPTION,
    readTextSchema,
    readTextAnnotations,
    async (args) => {
      try {
        const page = readOutputPage(args.ref, args.offset, args.limit);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(page, null, 2) },
          ],
        };
      } catch (e) {
        // unknown ref / I/O error → JSON payload with error field（CC 友好）
        const payload = {
          text: "",
          eof: true,
          total_bytes: 0,
          error: String(e),
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      }
    },
  );
}
