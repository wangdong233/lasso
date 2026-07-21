/**
 * HeadlessChannel（parse1 §3.6 + §4.2）
 *
 * spawn `chrome-devtools-mcp@<LOCKED_CDP_MCP_VERSION> --headless --isolated`。
 * 干净、隔离的 headless Chromium —— 无登录态、无 cookie 持久化。
 *
 * 适合：公开页面 / JS 重的 SPA / SERP fallback / 截图。
 *
 * 构造时往 SubprocessManager 注册 "headless" 规格，之后 getMcpClient() 懒启动。
 *
 * 借鉴：08 §3.3；chrome-devtools-mcp 官方 headless 启动方式（实测）。
 */
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";

export class HeadlessChannel extends BrowseChannel {
  readonly name = "browse_headless";

  constructor(private readonly subproc: SubprocessManager) {
    super();
    subproc.registerSpec("headless", {
      command: "npx",
      args: [
        "-y",
        `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
        "--headless",
        "--isolated",
      ],
      mcpClientName: "lasso-browse-headless",
    });
  }

  protected async getMcpClient(): Promise<McpClient> {
    return this.subproc.ensureRunning("headless");
  }
}
