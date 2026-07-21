/**
 * Rust helper JSON-lines 协议适配器（parse4 §3.5.3 + §3.5.4）
 *
 * 铁律（INV-7）：**SubprocessManager 仍纯 lifecycle**——不做协议帧解析、
 * 不读 JSON-RPC、不读 JSON-lines。JSON-lines 的帧解析（line split +
 * id 关联 + timeout）全部在本类内完成。MCP JSON-RPC 路径继续走
 * McpClient（SDK StdioClientTransport）；两条协议路径互不污染。
 *
 * 协议差异（parse4 §3.5.4 表）：
 *  - MCP JSON-RPC（chrome-devtools-mcp）
 *      · 封装层：@modelcontextprotocol/sdk Client + transport
 *      · 帧：Content-Length + JSON body（HTTP-like）
 *      · 握手：initialize → capabilities → initialized
 *      · 双向：server 可发 notification
 *      · 协议帧解析：SDK transport（INV-7 不在 SubprocessManager）
 *  - JSON-lines（rust-helper）
 *      · 封装层：本类 RustBridge（自写 line buffer + id 关联）
 *      · 帧：newline-delimited JSON（无 framing header）
 *      · 握手：无（首条 Request 即处理）
 *      · 双向：单向（仅 client→server Request + server→client Response）
 *      · 协议帧解析：RustBridge（INV-7 同守，不在 SubprocessManager）
 *
 * 设计要点（parse4 §3.5.3）：
 *  - line-delimited JSON（每行一个完整 Response 对象；\n 分隔）
 *  - Promise-based request/response（id UUID 关联）
 *  - 30s 默认超时（ping 调用 3s，可在 call() override）
 *  - crash 检测：proc.on("exit") → 全部 pending reject "rust_helper_crashed"
 *  - 半行累积（line buffer）：不假设 chunk 一定是整行
 *
 * 协议帧镜像 rust-helper/src/protocol.rs：
 *  - Request  : { id, method, params? }
 *  - Response : { id, ok, result?, error?, error_kind? }
 *  - error_kind ∈ {"parse_error","unknown_method","not_macos","tcc_denied",
 *                  "tcc_screen_recording_denied","app_not_found","ax_unavailable",
 *                  "invalid_params","not_implemented"}
 *
 * 借鉴：MCP TS SDK stdio transport 的 line-buffer 模式；13 §3.5 决策。
 */
import { randomUUID } from "node:crypto";
import type { SubprocessManager } from "./SubprocessManager.js";
import type { ChildProcess } from "node:child_process";
import { logger } from "../util/logger.js";

// ============================================================
// 公共类型（与 rust-helper/src/protocol.rs::Response 镜像）
// ============================================================
export interface RustResponse {
  /** UUID，与 Request.id 匹配；协议级错误时可能为空串。 */
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  error_kind?: string;
}

/** 内部 pending 表项。 */
interface PendingReq {
  resolve: (r: RustResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** 默认超时 30s（parse4 §3.5.3）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** ping 等快速调用建议用 3s（parse4 §3.5.3）。 */
export const PING_TIMEOUT_MS = 3_000;

// ============================================================
// RustBridge
// ============================================================
/**
 * Rust helper JSON-lines bridge（独立于 McpClient）。
 *
 * INV-7：JSON-lines 协议帧解析（line split + id 关联 + timeout）在本类
 * 内完成。SubprocessManager 仅负责 lifecycle（spawn / 重启 / kill）。
 */
export class RustBridge {
  private pending = new Map<string, PendingReq>();
  /** 半行累积 buffer（chunk 可能不是整行；parse4 §3.5.3）。 */
  private buffer = "";
  private proc: ChildProcess | null = null;
  /** 是否已绑定 stdout / exit 监听（避免重复绑定）。 */
  private wired = false;

  constructor(
    private readonly subproc: SubprocessManager,
    private readonly specName: string, // "rust-helper"
  ) {}

  /**
   * 懒启动 + 复用。首次调用时拉起子进程并接 line-data / exit 事件。
   * 幂等（proc 已存在则直接 return）。
   */
  async ensureStarted(): Promise<void> {
    if (this.proc) return;
    const proc = await this.subproc.ensureRustRunning(this.specName);
    this.proc = proc;
    if (!this.wired) {
      // stdout 可能是 null（理论），运行时守护一下
      if (proc.stdout) {
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", this.onData);
      }
      proc.on("exit", this.onExit);
      this.wired = true;
    }
  }

  /**
   * 调一个 method，30s 默认超时。
   *
   * @param method   "ping"|"tcc_status"|"ax_snapshot"|"ax_find"|"ax_act"|"screenshot"
   * @param params   方法特定参数（unknown，调用方按 method 自检 shape）
   * @param timeoutMs 默认 30_000；ping 可传 PING_TIMEOUT_MS=3_000
   * @returns RustResponse（含 id / ok / result? / error? / error_kind?）
   *
   * 错误种类（reject 而非 resolve）：
   *  - rust_call_timeout:<method>   超时
   *  - rust_helper_crashed          子进程退出（exit 事件触发）
   *  - rust_helper_write_failed     stdin write 抛错（管道断裂）
   */
  async call(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<RustResponse> {
    await this.ensureStarted();
    const id = randomUUID();
    const reqLine = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<RustResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rust_call_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const stdin = this.proc?.stdin;
        if (!stdin) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error("rust_helper_no_stdin"));
          return;
        }
        stdin.write(reqLine);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new Error(
            `rust_helper_write_failed:${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
    });
  }

  /**
   * stdout data 事件回调：累积 buffer，按 \n 切分整行 dispatch。
   * 半行残留在 buffer 等下次 data 事件。
   */
  private onData = (chunk: string): void => {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.dispatch(line);
    }
  };

  /**
   * 解析一行 Response 并关联到 pending Request。
   * 协议级错误（非 JSON / 无 id 字段）静默丢弃，不 reject（parse4 §3.5.3：
   * "协议错，忽略（不自爆）"）—— 避免半个坏帧拖垮所有 pending。
   */
  private dispatch(line: string): void {
    if (line.length === 0) return;
    let resp: RustResponse;
    try {
      resp = JSON.parse(line) as RustResponse;
    } catch {
      logger.warn({
        evt: "rust_bridge_parse_error",
        spec: this.specName,
        line_preview: line.slice(0, 120),
      });
      return;
    }
    if (typeof resp.id !== "string") return;
    const p = this.pending.get(resp.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(resp.id);
    p.resolve(resp);
  }

  /**
   * 子进程 exit 回调：所有 pending 全部 reject（crash 检测，parse4 §3.5.3）。
   * 清空 pending 表，标 proc=null（下次 ensureStarted 会重 spawn）。
   */
  private onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    logger.warn({
      evt: "rust_helper_exit",
      spec: this.specName,
      code,
      signal,
      pending: this.pending.size,
    });
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("rust_helper_crashed"));
    }
    this.pending.clear();
    this.proc = null;
    this.buffer = "";
    this.wired = false;
  };

  /** 测试 / 显式重启用：取当前 pending 数量（不变量自检 / 单测断言用）。 */
  pendingCount(): number {
    return this.pending.size;
  }
}
