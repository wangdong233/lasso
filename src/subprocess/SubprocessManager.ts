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
// SubprocessManager
// ============================================================
export class SubprocessManager {
  private procs = new Map<string, ManagedProc>();
  private specs = new Map<string, SpawnSpec>();
  private zombieTimer: NodeJS.Timeout | null = null;

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

  /** 全停——shutdown 钩子（SIGTERM / SIGINT）调。 */
  async shutdown(): Promise<void> {
    if (this.zombieTimer) {
      clearInterval(this.zombieTimer);
      this.zombieTimer = null;
    }
    await Promise.all([...this.procs.keys()].map((n) => this._kill(n)));
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
}
