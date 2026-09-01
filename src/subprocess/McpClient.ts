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
 * 但实际 SDK（1.29+，v1.11 T16 升 1.30）的 StdioServerParameters 形状是 { command, args, env, stderr,
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
import { killTreeSync } from "../util/kill-tree.js";

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
// PERF-5（2026-09-02 perf/acc 轮 2）：握手预算
// ============================================================
/** 健康冷启动实测 ~2.8-5.6s（PERF-1 后），首装极值 17.2s（perf 轮真机）——20s 默认。 */
export const DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS = 20_000;

/** env 覆盖（测试隔离 / 慢环境显式放宽）；非法值回默认。 */
export function defaultHandshakeTimeoutMs(): number {
  const raw = Number(process.env.LASSO_MCP_HANDSHAKE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS;
}

/**
 * 给 Promise 加截止时间。超时抛 makeError(timeoutMs)；原 Promise 的晚到
 * reject 被 catch 吞掉（不产生 unhandledRejection）。resolve 晚到同理无害。
 */
function deadline<T>(
  p: Promise<T>,
  ms: number,
  makeError: (ms: number) => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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
   *
   * PERF-5（2026-09-02 perf/acc 轮 2，冷启动挂起归因与修）：
   *  - 归因：SDK 的 initialize 请求默认 60s 超时（protocol.js
   *    DEFAULT_REQUEST_TIMEOUT_MSEC），此前 connect 无显式预算——spawn 卡死
   *    （代理黑洞下 npx 首装/registry 解析悬置）时每次尝试挂 60s，叠加
   *    _spawnWithBackoff 5 次 × 2/4/8/16s 退避 = 最坏 ~330s 挂起；且失败路径
   *    只走 SDK close（对 npx shim 直子进程 stdin/SIGTERM/SIGKILL，G5 实证不
   *    转发下层 node/Chromium 树）→ 每次超时尝试泄漏挂死的 npx 进程树。
   *  - 修法：显式握手预算 handshakeTimeoutMs（默认 20s = 健康冷启动 ~2.8-5.6s
   *    的 3.5×+，覆盖实测首装极值 17.2s；env LASSO_MCP_HANDSHAKE_TIMEOUT_MS
   *    覆盖）；超时/失败即 SDK close + killTreeSync 树杀本次尝试的 pid 后抛错
   *    （由 SubprocessManager 退避重试）。最坏挂起 5×20s+30s ≈ 130s，零泄漏。
   */
  static async connectStdio(
    opts: McpClientOptions,
    params: StdioSpawnParams,
    handshakeTimeoutMs = defaultHandshakeTimeoutMs(),
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
    try {
      await deadline(c.client.connect(transport), handshakeTimeoutMs, (ms) =>
        new Error(
          `mcp_handshake_timeout: ${params.command} ${(params.args ?? []).join(" ")} 未在 ${ms}ms 内完成 initialize（spawn 卡死或网络悬置；env LASSO_MCP_HANDSHAKE_TIMEOUT_MS 可调）`,
        ),
      );
    } catch (e) {
      // 失败清理：SDK close（stdin/SIGTERM/SIGKILL 直子进程）+ 树杀本 pid
      //（npx shim 下层 node/Chromium 不收 SDK 信号——G5 同款缺口，见
      // SubprocessManager._kill 注释）。close 的 2s×2 等待不阻塞失败路径
      //（树杀是确定性致死原语，close 是 fire-and-forget 收尾）。
      const pid = transport.pid;
      void c.client.close().catch(() => {});
      if (pid !== null && pid !== undefined) {
        try {
          killTreeSync(pid, "mcp-connect-failed");
        } catch {
          // 树杀 best-effort（pid 已死等）——不掩盖原始错误
        }
      }
      throw e;
    }
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
