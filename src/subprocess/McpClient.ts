/**
 * MCP Client 封装（parse1 §3.2 + §4.1 / §4.2）
 *
 * 统一封装 @modelcontextprotocol/sdk 的 Client + 两种 transport：
 *  - connectStdio : chrome-devtools-mcp 子进程（由 SDK StdioClientTransport 自带 spawn）
 *  - connectHttp  : 智谱 web_search_prime streamable-http（Authorization Bearer header）
 *
 * 设计要点（不变量 INV-7：SubprocessManager 不解协议帧）：
 *  本类**也不解协议帧**——帧解析全部下沉到 SDK 的 StdioClientTransport /
 *  StreamableHTTPClientTransport。本类只暴露 lifecycle（close）/ 调用（callTool /
 *  listTools）/ 元信息（pid、stderr stream）。
 *
 * parse1 §3.2 原文假设 StdioClientTransport 接 { stdin, stdout, stderr } 流，
 * 但实际 SDK 1.29 的 StdioServerParameters 形状是 { command, args, env, stderr,
 * cwd }——transport 自己 spawn。所以本类按 SDK 真实 API 实现，意图不变（解耦
 * SubprocessManager 与协议帧）。
 *
 * 借鉴：MCP TS SDK 官方 client API（client/index.d.ts、client/stdio.d.ts、
 * client/streamableHttp.d.ts）；media-gen-mcp 没 spawn 外部 MCP，这块是新写。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { IOType } from "node:child_process";
import type { Stream } from "node:stream";

// ============================================================
// 公共类型
// ============================================================
export interface McpClientOptions {
  /** 客户端自报名称，用于 MCP initialize 握手。 */
  name: string; // "lasso-search" / "lasso-browse-headless" / "lasso-browse-logged-in"
  /** 客户端自报版本。 */
  version: string; // "0.1.0"
}

/**
 * stdio 模式的 spawn 参数——直接透传给 StdioClientTransport。
 * `stderr: "pipe"` 让 transport 把子进程 stderr 暴露成 PassThrough stream，
 * doctor / 日志回放可以读最后 N 行做诊断。
 */
export interface StdioSpawnParams {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  stderr?: IOType | Stream | number;
  cwd?: string;
}

// ============================================================
// McpClient
// ============================================================
export class McpClient {
  private client: Client;
  private connected = false;
  /** stdio 模式下持有的 transport 引用，用于 close / pid / stderr。 */
  private stdioTransport: StdioClientTransport | null = null;

  private constructor(opts: McpClientOptions) {
    this.client = new Client(
      { name: opts.name, version: opts.version },
      { capabilities: {} },
    );
  }

  /**
   * stdio 连接：让 SDK StdioClientTransport 自己 spawn 子进程。
   * 调用方（SubprocessManager）只负责传 spawn 规格和事后 lifecycle。
   */
  static async connectStdio(
    opts: McpClientOptions,
    params: StdioSpawnParams,
  ): Promise<McpClient> {
    const c = new McpClient(opts);
    const transport = new StdioClientTransport({
      command: params.command,
      args: params.args,
      env: params.env,
      // 默认 pipe：让 transport.stderr 可读（doctor 诊断 / 启动失败回放）
      stderr: params.stderr ?? "pipe",
      cwd: params.cwd,
    });
    await c.client.connect(transport);
    c.stdioTransport = transport;
    c.connected = true;
    return c;
  }

  /**
   * streamable-http 连接：用于智谱 web_search_prime MCP。
   * Authorization 等 header 由调用方组装后整体传入（不在这里读 env）。
   */
  static async connectHttp(
    opts: McpClientOptions,
    url: string,
    headers: Record<string, string>,
  ): Promise<McpClient> {
    const c = new McpClient(opts);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
    });
    await c.client.connect(transport);
    c.connected = true;
    return c;
  }

  /** 调一个 MCP 工具；返回 SDK 标准返回（含 content / isError / structuredContent）。 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.connected) throw new Error("McpClient not connected");
    return (await this.client.callTool({ name, arguments: args })) as Record<
      string,
      unknown
    >;
  }

  /** 列出远端工具——SubprocessManager.healthProbe 用它做活性探测。 */
  async listTools(): Promise<
    Array<{ name: string; inputSchema: unknown; description?: string }>
  > {
    if (!this.connected) throw new Error("McpClient not connected");
    const r = await this.client.listTools();
    return r.tools.map((t) => ({
      name: t.name,
      inputSchema: t.inputSchema,
      description: t.description,
    }));
  }

  /**
   * stdio 模式下子进程的 PID（transport 内部 spawn 后才有；未启动 / http 模式为 null）。
   * SubprocessManager 用它做 liveness 判定（process.kill(pid, 0) 不抛即 alive）。
   */
  get pid(): number | null {
    return this.stdioTransport?.pid ?? null;
  }

  /**
   * stdio 模式下子进程的 stderr stream（仅当 stderr 传 "pipe" 时非空）。
   * doctor 第 X 项「最近 N 行 stderr」从这里读。
   */
  get stderr(): Stream | null {
    return this.stdioTransport?.stderr ?? null;
  }

  /** 是否已连接。 */
  get isConnected(): boolean {
    return this.connected;
  }

  /** 关闭连接：stdio 模式会触发 transport 关闭子进程。幂等。 */
  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.client.close();
    } catch {
      // 幂等：忽略二次关闭异常
    }
    this.stdioTransport = null;
  }
}
