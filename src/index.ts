#!/usr/bin/env node
/**
 * Lasso — CC 的全交互对外抓手 MCP（浏览器 + 桌面）
 *
 * 四通道（08 架构）：
 *   - search           智谱 web-search-prime
 *   - browse_headless  chrome-devtools-mcp --headless --isolated
 *   - browse_logged_in chrome-devtools-mcp --browser-url :9222
 *   - desktop          macOS AXAPI（Rust helper，v0.3.5+）
 *
 * 权威架构：../doc/08-media-interact-功能架构.md
 * 排期：    ../doc/09-media-interact-实施排期.md
 *
 * 当前：v0.1 MVP 骨架（四工具占位 + tri-state outcome 类型 + fallback 链接口）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ============================================================
// tri-state outcome（08 §2.3，F3.4.11）
// ============================================================
/** 动作结果三态。`unknown` 是 fallback 引擎的真正触发器。 */
type Outcome = "worked" | "didnt" | "unknown";

/**
 * 架构铁律（08 §0 原则 5）：
 *   event delivery alone is never treated as semantic success.
 * 即：act 后必须验证交付（expect 后置条件，F3.2.18），区分 worked/didnt/unknown，
 *     不能只报「事件已派发」就当成功。
 */

interface InteractResult {
  outcome: Outcome;
  data: unknown;
  served_by: string; // 实际服务的 channel
  fallback_used: boolean;
  retrieval_method: string;
  actions_and_results?: unknown[]; // Skyvern 审计链（F3.2.11，v0.3）
  error: string | null;
}

// ============================================================
// BaseChannel 分层（08 §2.1，13 审查 #2）
// ============================================================
// BaseChannel（通用层）→ UiChannel（observe/act/wait）→ Browse/DesktopChannel
// SearchChannel 只实现 BaseChannel（不穿 UI 鞋）
// v0.1 占位：接口定义，实现见 v0.1 §2.1

// ============================================================
// 四通道工具定义（08 §3 + 附录 B 工具描述模板）
// ============================================================
const TOOLS = [
  {
    name: "search",
    description:
      "Default structured web search via Zhipu web-search-prime. Fast, cheap, clean JSON. " +
      "AUTOMATIC FALLBACK: on rate limit/timeout/5xx/empty, transparently falls back to " +
      "browse_headless real-search. outcome/fallback_used tells you which path served you. " +
      "Use for: keyword searches on public content. " +
      "Prefer browse_logged_in for: sites showing different content to logged-in users. " +
      "Prefer browse_headless for: scraping a specific known URL. " +
      "Prefer desktop for: native macOS apps (not browser pages).",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "search query" },
        limit: { type: "number", default: 10 },
        engine: { type: "string", default: "zhipu" },
        region: { type: "string", default: "cn" },
        no_cache: { type: "boolean", default: false },
      },
      required: ["query"],
    },
  },
  {
    name: "browse_headless",
    description:
      "Clean, isolated headless Chromium. No login state. " +
      "Page state written to ~/.cache/lasso/<run_id>/, only short pointer returned (saves tokens). " +
      "Use for: public pages / JS-heavy SPAs / SERP fallback / screenshots. " +
      "Prefer browse_logged_in for: sites requiring auth. " +
      "SECURITY: URL is SSRF-checked (allowRanges). evaluate_script is documented risk.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string" },
        action: { type: "string", default: "snapshot" },
      },
      required: ["url"],
    },
  },
  {
    name: "browse_logged_in",
    description:
      "Reuses your already-logged-in local Chrome via CDP port 9222. " +
      "REQUIREMENTS: Chrome running with --remote-debugging-port=9222 (use `lasso launch-chrome`); " +
      "you must have completed login (including 2FA) first. " +
      "DOES NOT: auto-login / solve 2FA (returns NEEDS_MANUAL_2FA) / export cookies. " +
      "Use for: authenticated sites (GitHub private, Jira, internal tools).",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string" },
        action: { type: "string", default: "snapshot" },
      },
      required: ["url"],
    },
  },
  {
    name: "desktop",
    description:
      "Controls native macOS apps via Accessibility (AXAPI) — no screenshots by default. " +
      "Use for: native apps without API/CLI (Finder/Mail/Safari/System Settings). " +
      "Fallback chain: AX tree → AppleScript → CGEvent → screenshot+VLM. " +
      "DOES NOT: solve TCC permissions (run `lasso doctor`), control non-macOS (v1.0+). " +
      "(v0.3.5+ — not in v0.1 MVP)",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", default: "snapshot" },
      },
    },
  },
  // admin 工具（v0.1）
  {
    name: "doctor",
    description:
      "Returns structured JSON readiness report (search key / headless Chrome / :9222 logged-in / " +
      "SERP selector / desktop TCC if v0.3.5+). Each item: {ok, reason} + blockers[] + next_step.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

// ============================================================
// MCP server
// ============================================================
const server = new Server(
  { name: "lasso", version: "0.1.0-dev" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  // TODO v0.1 MVP：实现四通道 + tri-state outcome + fallback 链
  //   - search：调智谱 web-search-prime MCP（F3.1）
  //   - browse_headless/logged_in：spawn chrome-devtools-mcp 子进程（F3.2/F3.3）
  //   - fallback 链：isFallbackWorthy + get_fallback_channel（F3.4）
  //   - tri-state outcome：unknown → 触发 fallback（F3.4.11）
  //   - SSRF allowRanges（F3.9.5）
  // 详见 ../doc/08-media-interact-功能架构.md §3 + ../doc/09 §2.1
  return {
    content: [
      {
        type: "text",
        text: `Lasso v0.1.0-dev — tool "${name}" not yet implemented. ` +
          `See doc/08 §3 + doc/09 §2.1 for v0.1 MVP scope.`,
      },
    ],
    isError: false,
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Lasso MCP server running (stdio) — v0.1.0-dev");
}

main().catch((err) => {
  console.error("Lasso fatal:", err);
  process.exit(1);
});
