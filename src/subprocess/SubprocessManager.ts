/**
 * SubprocessManager（parse1 §3.5 + §4.2，纯 lifecycle）
 *
 * 铁律（不变量 INV-7）：**纯 lifecycle**——不做协议帧解析、不读 JSON-RPC、
 * 不组装消息。帧解析下沉到 SDK 的 StdioClientTransport（通过 McpClient.connectStdio
 * 间接持有）。本类只管：spawn 规格 / 懒启动 / 健康探测 / 退避重启 / 僵尸回收 / 全停。
 *
 * 架构选择：SDK 1.29 的 StdioClientTransport 自带 spawn（接收 {command, args, env}），
 * 所以本类不直接调 node:child_process.spawn。spawn 的具体动作委托给 McpClient，
 * 本类只追踪 spawn 后的元数据（pid / spawnedAt / lastUsedAt / restartCount）。
 *
 * 公开 API（parse1 §3.5 原样）：
 *  - registerSpec(name, spec)   : 注册一个 spawn 规格（HeadlessChannel / LoggedInChannel 构造时调）
 *  - ensureRunning(name)        : 懒启动或复用，返回 McpClient
 *  - healthProbe(name)          : healthy / degraded / down（3s 超时 listTools 探测）
 *  - restart(name)              : 强 kill + 重 spawn
 *  - startZombieReaper()        : 60s 周期清闲置 >1h 的进程
 *  - cleanupZombies(threshold)  : 手动触发一次清理
 *  - shutdown()                 : 全停 + 清 timer
 *
 * 借鉴：08 §3.5 + 附录 A SubprocessManager；chrome-devtools-mcp 官方启动方式
 * （npx -y chrome-devtools-mcp@<ver> --headless --isolated / --browser-url :9222）。
 */
import { McpClient, type StdioSpawnParams } from "./McpClient.js";
import { Agent } from "undici";
import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../util/logger.js";

// ============================================================
// 版本锁（parse1 §3.5 + §7.1 风险 L1）
// ============================================================
/**
 * chrome-devtools-mcp 版本锁。
 * 上游工具名 / schema 漂移会直接断 BrowseChannel.actionDispatch Map。
 * 通过 package-lock + 此常量双锁；契约测试在 Phase F 拿 listTools() 快照守。
 */
export const LOCKED_CDP_MCP_VERSION = "0.3.0";

// ============================================================
// 内部追踪结构
// ============================================================
export interface SpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * McpClient 在 initialize 握手时自报的 name（"lasso-browse-headless" /
   * "lasso-browse-logged-in"），仅用于日志 / doctor，与 transport 无关。
   */
  mcpClientName: string;
  /** stdio stderr 透传策略，默认 "pipe" 让 doctor 能读。 */
  stderr?: StdioSpawnParams["stderr"];
  /** spawn cwd，默认继承。 */
  cwd?: string;
}

interface ManagedProc {
  client: McpClient;
  spawnedAt: number;
  lastUsedAt: number;
  restartCount: number;
  /** 远端关闭（transport onclose）或本地 kill 后置 true，下次 ensureRunning 必重 spawn。 */
  closed: boolean;
}

// ============================================================
// Rust helper 子进程规格（parse4 §3.5.2）
// ============================================================
/**
 * Rust helper 的 spawn 规格（不同于 MCP 的 SpawnSpec）：
 *  - 不走 SDK transport，直接 child_process.spawn
 *  - 协议帧解析在 RustBridge（INV-7）
 *  - 仅供 RustBridge.ensureStarted → ensureRustRunning 使用
 */
export interface RustSpawnSpec {
  /** 已 codesign 的 binary 路径（如 "./rust-helper/target/release/lasso-rust-helper"）。 */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** spawn cwd，默认继承。 */
  cwd?: string;
}

/**
 * Rust helper 子进程追踪结构（与 ManagedProc 平行，但持 ChildProcess 而非 McpClient）。
 */
interface RustProc {
  proc: ChildProcess;
  spawnedAt: number;
  lastUsedAt: number;
  restartCount: number;
  /** proc.on("exit") 触发或本地 kill 后置 true，下次 ensureRustRunning 必重 spawn。 */
  closed: boolean;
}

// ============================================================
// SubprocessManager
// ============================================================
export class SubprocessManager {
  private procs = new Map<string, ManagedProc>();
  private specs = new Map<string, SpawnSpec>();
  /**
   * v0.3.5 新增（parse4 §3.5.2）：Rust helper 子进程追踪。
   * 与 MCP 的 procs/specs 平行，互不污染（INV-7：MCP 路径一行不动）。
   */
  private rustProcs = new Map<string, RustProc>();
  private rustSpecs = new Map<string, RustSpawnSpec>();
  private zombieTimer: NodeJS.Timeout | null = null;
  /**
   * v0.2 连接池（parse2 §3.6.2 / F3.5.7）。
   * key = host origin（如 "https://api.search.brave.com" /
   * "https://open.bigmodel.cn"）；每 host 一个独立 undici Agent。
   * 智谱 + Brave 同 host 的多次请求复用 TCP/TLS 连接 → 并发 p95 改善。
   */
  private httpAgents = new Map<string, Agent>();

  /**
   * 注册一个子进程规格。channel 构造时调一次（parse1 §3.6 HeadlessChannel /
   * LoggedInChannel）。重复注册（同名）覆盖——用于测试 reset。
   */
  registerSpec(name: string, spec: SpawnSpec): void {
    this.specs.set(name, spec);
  }

  /** 测试 / 显式重置用：移除一个规格 + kill 它的进程。 */
  forgetSpec(name: string): Promise<void> {
    return this._kill(name).then(() => {
      this.specs.delete(name);
    });
  }

  /**
   * 懒启动 / 复用（parse1 §3.5）。
   *  - 已存在且 pid alive 且未标记 closed → 更新 lastUsedAt，返回旧 client
   *  - 否则 → _spawnWithBackoff 走指数退避重启
   */
  async ensureRunning(name: string): Promise<McpClient> {
    const existing = this.procs.get(name);
    if (existing && !existing.closed && this._isAlive(existing.client)) {
      existing.lastUsedAt = Date.now();
      return existing.client;
    }
    return this._spawnWithBackoff(name);
  }

  /**
   * 健康探测（parse1 §3.5）。
   *  - 没有 proc / pid dead → "down"
   *  - 走一次 listTools()，3s 内返 → "healthy"
   *  - 超时 / 抛错 → "degraded"（子进程可能卡死，下次 ensureRunning 会触发重 spawn）
   */
  async healthProbe(name: string): Promise<"healthy" | "degraded" | "down"> {
    const m = this.procs.get(name);
    if (!m || m.closed || !this._isAlive(m.client)) return "down";
    try {
      await Promise.race([
        m.client.listTools(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 3000),
        ),
      ]);
      return "healthy";
    } catch {
      return "degraded";
    }
  }

  /** 强 kill 后重 spawn。用于显式 reset（如 CDP 端口换了 / Chrome 重启了）。 */
  async restart(name: string): Promise<McpClient> {
    await this._kill(name);
    return this._spawnWithBackoff(name);
  }

  /**
   * 60s 周期清闲置 child（parse1 §3.5 防僵尸累积）。
   * 同一时间只允许一个 timer（重复调用覆盖旧 timer）。
   */
  startZombieReaper(
    intervalMs = 60_000,
    idleThresholdMs = 3_600_000,
  ): void {
    if (this.zombieTimer) clearInterval(this.zombieTimer);
    this.zombieTimer = setInterval(
      () => {
        this.cleanupZombies(idleThresholdMs).catch((e) =>
          logger.error({ evt: "zombie_reaper_error", error: String(e) }),
        );
      },
      intervalMs,
    );
    // Node timer 不阻止进程退出——MCP stdio 模式下我们靠 SIGTERM/SIGINT 显式 shutdown。
    this.zombieTimer.unref?.();
  }

  /** 手动触发一次僵尸清理；阈值默认 1h。 */
  async cleanupZombies(idleThresholdMs = 3_600_000): Promise<void> {
    const now = Date.now();
    for (const [name, m] of this.procs) {
      if (now - m.lastUsedAt > idleThresholdMs) {
        logger.info({
          evt: "zombie_reaped",
          name,
          idle_ms: now - m.lastUsedAt,
        });
        await this._kill(name);
      }
    }
  }

  // ============================================================
  // Rust helper lifecycle（v0.3.5 新增，parse4 §3.5.2）
  // ============================================================
  /**
   * 注册一个 Rust helper spawn 规格。RustBridge 构造后调一次。
   * 重复注册（同名）覆盖——用于测试 reset。
   */
  registerRustSpec(name: string, spec: RustSpawnSpec): void {
    this.rustSpecs.set(name, spec);
  }

  /** 测试 / 显式重置用：移除一个 Rust 规格 + kill 它的进程。 */
  async forgetRustSpec(name: string): Promise<void> {
    await this._killRust(name);
    this.rustSpecs.delete(name);
  }

  /**
   * 懒启动 / 复用 Rust helper 子进程（parse4 §3.5.2）。
   *  - 已存在且 pid alive 且未标记 closed → 更新 lastUsedAt，返回旧 proc
   *  - 否则 → _spawnRustWithBackoff 走指数退避重启
   *
   * 与 ensureRunning 同范式（退避序列、尝试次数、alive 判定都一致），
   * 但用 child_process.spawn（不需 SDK transport），且不解协议帧（INV-7）。
   */
  async ensureRustRunning(name: string): Promise<ChildProcess> {
    const existing = this.rustProcs.get(name);
    if (existing && !existing.closed && this._isRustAlive(existing.proc)) {
      existing.lastUsedAt = Date.now();
      return existing.proc;
    }
    return this._spawnRustWithBackoff(name);
  }

  /**
   * 连接池：取一个 host 专属的 keep-alive HTTP client（parse2 §3.6.2 / F3.5.7）。
   *
   * 同一 origin 多次调用返同一个 Agent，TCP/TLS 连接在 keepAliveTimeout=30s 内复用。
   * 智谱 + Brave 同 host 并发请求 p95 改善（V5 风险缓解）；不破坏 v0.1 fetch 行为
   * （V7 风险：dispatcher 注入是 undici 标准路径，headers/redirect/SSRF 守卫都透传）。
   *
   * 设计：返回 `{ fetch }` 而非裸 Agent，便于 BraveChannel 注入测试 mock 同构。
   *
   * @param origin host origin，如 "https://api.search.brave.com"。
   *                含 scheme + host（可选 :port），不含 path/query。
   */
  acquireHttpClient(origin: string): { fetch: typeof fetch } {
    if (!this.httpAgents.has(origin)) {
      this.httpAgents.set(
        origin,
        new Agent({
          keepAliveTimeout: 30_000,
          keepAliveMaxTimeout: 60_000,
          connections: 8,
        }),
      );
      logger.info({ evt: "http_pool_created", origin });
    }
    const agent = this.httpAgents.get(origin)!;
    // 注：cast 仅为平息 undici-types 与 @types/node Dispatcher 在 FormData
    // 子类型上的形状差异（V7 风险点）。运行时 undici Agent 直接被 global fetch
    // 接收（Node 内置 undici），无 runtime 开销。
    const dispatcher = agent as unknown as Parameters<typeof fetch>[1] extends
      | { dispatcher?: infer D }
      | undefined
      ? D
      : never;
    return {
      fetch: ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetch(url, { ...init, dispatcher })) as typeof fetch,
    };
  }

  /** 全停——shutdown 钩子（SIGTERM / SIGINT）调。 */
  async shutdown(): Promise<void> {
    if (this.zombieTimer) {
      clearInterval(this.zombieTimer);
      this.zombieTimer = null;
    }
    await Promise.all([...this.procs.keys()].map((n) => this._kill(n)));
    // v0.3.5：也 join 所有 Rust helper 子进程（parse4 §3.5.2）。
    await Promise.all(
      [...this.rustProcs.keys()].map((n) => this._killRust(n)),
    );
    // v0.2：关闭所有 keep-alive Agent（避免进程 hang）
    await Promise.all(
      [...this.httpAgents.values()].map((a) =>
        a.close().catch((e: unknown) =>
          logger.warn({ evt: "http_pool_close_error", error: String(e) }),
        ),
      ),
    );
    this.httpAgents.clear();
  }

  // ============================================================
  // v0.6 新增（parse7 §3.1 / §4.1 —— runtime CapabilityBag 联动用）
  // ============================================================
  /**
   * v0.6: 单 spec kill —— CapabilityBag.disable("channel") 联动调（INV-39 task 版本）。
   *
   * 设计：
   *  - 复用既有 `_kill`（MCP 路径）/ `_killRust`（Rust 路径），**不**改 `shutdown()` 全停语义
   *  - 优先尝试 MCP 路径（procs / specs 命中）；不命中再试 Rust 路径；都不命中 = no-op（幂等）
   *  - 不调 `this.shutdown()`（INV-39：shutdownOne 是单 spec kill，禁调 shutdown 全集）
   *  - INV-7 仍守：纯 lifecycle，不读协议帧
   *
   * 关键差异 vs shutdown()（parse7 §4.1）：
   *  - shutdown() 是 SIGTERM 钩子全停；shutdownOne 是 runtime 单点停（channel disable 用）
   *  - shutdown() 清 zombieTimer + httpAgents；shutdownOne 不动这些（其他 channel 仍需）
   *  - shutdownOne 不调 shutdown()（防误清其他 channel 的资源）
   *
   * @param name  spec 名（MCP: "lasso-browse-headless" / "lasso-browse-logged-in"；
   *                       Rust: "rust-helper"）
   *
   * INV-39 task 版本：channel disable 必经 SubprocessManager.shutdownOne（不调 shutdown 全集）。
   */
  async shutdownOne(name: string): Promise<void> {
    // 1. 优先 MCP 路径（procs 或 specs 命中即调 _kill）
    if (this.procs.has(name) || this.specs.has(name)) {
      await this._kill(name);
      logger.info({ evt: "subproc_shutdown_one", name, kind: "mcp" });
      return;
    }
    // 2. 再试 Rust 路径
    if (this.rustProcs.has(name) || this.rustSpecs.has(name)) {
      await this._killRust(name);
      logger.info({ evt: "subproc_shutdown_one", name, kind: "rust" });
      return;
    }
    // 3. 都不命中：no-op（cloud 通道无本地子进程，或 channel 已自然退出）
    logger.info({
      evt: "subproc_shutdown_one_noop",
      name,
      reason: "spec_not_found",
    });
  }

  // ============================================================
  // 私有
  // ============================================================
  /**
   * 指数退避 spawn（parse1 §3.5 _spawnWithBackoff）。
   * 退避：1s / 2s / 4s / 8s / 16s（max 30s）；最多 5 次，超过抛错。
   */
  private async _spawnWithBackoff(name: string): Promise<McpClient> {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown subprocess spec: ${name}`);

    let attempt = 0;
    while (true) {
      try {
        // 合并 process.env + spec.env，过滤 process.env 里潜在的 undefined 项
        // （NodeJS.ProcessEnv 是 Record<string|string|undefined>，SDK 要 Record<string,string>）。
        const mergedEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) mergedEnv[k] = v;
        }
        if (spec.env) Object.assign(mergedEnv, spec.env);

        const client = await McpClient.connectStdio(
          { name: spec.mcpClientName, version: "0.1.0" },
          {
            command: spec.command,
            args: spec.args,
            env: mergedEnv,
            stderr: spec.stderr ?? "pipe",
            cwd: spec.cwd,
          },
        );
        const now = Date.now();
        this.procs.set(name, {
          client,
          spawnedAt: now,
          lastUsedAt: now,
          restartCount: attempt,
          closed: false,
        });
        logger.info({
          evt: "subproc_spawned",
          name,
          pid: client.pid,
          attempt,
        });
        return client;
      } catch (e) {
        attempt++;
        if (attempt >= 5) {
          logger.error({
            evt: "subproc_spawn_failed",
            name,
            attempt,
            error: String(e),
          });
          throw e;
        }
        const backoff = Math.min(30_000, 1000 * 2 ** attempt); // 2s/4s/8s/16s，max 30s
        logger.warn({
          evt: "subproc_spawn_retry",
          name,
          attempt,
          backoff_ms: backoff,
          error: String(e),
        });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  /**
   * kill 一个 proc：关 client（SDK transport 会 SIGTERM 子进程）+ 标 closed。
   * 幂等。
   */
  private async _kill(name: string): Promise<void> {
    const m = this.procs.get(name);
    if (!m) return;
    m.closed = true;
    try {
      await m.client.close();
    } catch (e) {
      logger.warn({
        evt: "subproc_close_error",
        name,
        error: String(e),
      });
    }
    this.procs.delete(name);
  }

  /** 判定 stdio client 背后的子进程是否还活着。 */
  private _isAlive(client: McpClient): boolean {
    const pid = client.pid;
    if (pid === null) return false;
    try {
      // signal 0 = 存活性探测，不实际发信号
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // Rust helper 私有（v0.3.5 新增，parse4 §3.5.2）
  // ============================================================
  /**
   * Rust helper 指数退避 spawn（与 _spawnWithBackoff 同范式）。
   * 退避：1s / 2s / 4s / 8s / 16s（max 30s）；最多 5 次，超过抛错。
   *
   * 关键差异（vs MCP 路径）：
   *  - 用 child_process.spawn（不需 SDK transport）
   *  - stdio: ['pipe', 'pipe', 'pipe']（stdin/stdout 走协议，stderr 走诊断）
   *  - 不做 initialize 握手（JSON-lines 无握手）
   */
  private async _spawnRustWithBackoff(name: string): Promise<ChildProcess> {
    const spec = this.rustSpecs.get(name);
    if (!spec) throw new Error(`Unknown rust subprocess spec: ${name}`);

    let attempt = 0;
    while (true) {
      try {
        const mergedEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) mergedEnv[k] = v;
        }
        if (spec.env) Object.assign(mergedEnv, spec.env);

        const proc = spawn(spec.command, spec.args ?? [], {
          stdio: ["pipe", "pipe", "pipe"],
          env: mergedEnv,
          cwd: spec.cwd,
        });
        const now = Date.now();
        this.rustProcs.set(name, {
          proc,
          spawnedAt: now,
          lastUsedAt: now,
          restartCount: attempt,
          closed: false,
        });
        // proc exit → 标 closed，下次 ensureRustRunning 重 spawn
        proc.on("exit", (code, signal) => {
          const m = this.rustProcs.get(name);
          if (m) m.closed = true;
          logger.warn({
            evt: "rust_proc_exit",
            name,
            pid: proc.pid,
            code,
            signal: String(signal),
          });
        });
        proc.on("error", (e) => {
          logger.error({
            evt: "rust_proc_error",
            name,
            pid: proc.pid,
            error: String(e),
          });
        });
        logger.info({
          evt: "rust_proc_spawned",
          name,
          pid: proc.pid,
          attempt,
        });
        return proc;
      } catch (e) {
        attempt++;
        if (attempt >= 5) {
          logger.error({
            evt: "rust_proc_spawn_failed",
            name,
            attempt,
            error: String(e),
          });
          throw e;
        }
        const backoff = Math.min(30_000, 1000 * 2 ** attempt);
        logger.warn({
          evt: "rust_proc_spawn_retry",
          name,
          attempt,
          backoff_ms: backoff,
          error: String(e),
        });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  /** kill 一个 Rust proc：SIGTERM + 标 closed。幂等。 */
  private async _killRust(name: string): Promise<void> {
    const m = this.rustProcs.get(name);
    if (!m) return;
    m.closed = true;
    try {
      if (m.proc.pid !== undefined && this._isRustAlive(m.proc)) {
        m.proc.kill("SIGTERM");
      }
    } catch (e) {
      logger.warn({
        evt: "rust_proc_kill_error",
        name,
        error: String(e),
      });
    }
    this.rustProcs.delete(name);
  }

  /** 判定 Rust helper 子进程是否还活着（与 _isAlive 同语义，但持 ChildProcess）。 */
  private _isRustAlive(proc: ChildProcess): boolean {
    const pid = proc.pid;
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
