/**
 * SubprocessManager（parse1 §3.5 + §4.2，纯 lifecycle）
 *
 * 铁律（不变量 INV-7）：**纯 lifecycle**——不做协议帧解析、不读 JSON-RPC、
 * 不组装消息。帧解析下沉到 SDK 的 StdioClientTransport（通过 McpClient.connectStdio
 * 间接持有）。本类只管：spawn 规格 / 懒启动 / 健康探测 / 退避重启 / 僵尸回收 / 全停。
 *
 * 架构选择：SDK（v1.11 T16 起 ^1.30.0）的 StdioClientTransport 自带 spawn（接收 {command, args, env}），
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
import { killTreeSync } from "../util/kill-tree.js";
// BUG-rust-helper-relative-path §4.3：缺 binary 的 fail-fast 错误文案单一真源
// A1（对抗复审轮 1）：spawn 可行性门 + 不可 spawn 自诊断也走同一真源
import {
  rustHelperMissingHint,
  rustHelperNotSpawnableHint,
  rustSpawnGate,
} from "./rust-helper-path.js";

// ============================================================
// 版本锁（parse1 §3.5 + §7.1 风险 L1）
// ============================================================
/**
 * chrome-devtools-mcp 版本锁。
 * 上游工具名 / schema 漂移会直接断 BrowseChannel.actionDispatch Map。
 * 通过 package-lock + 此常量双锁；契约测试在 Phase F 拿 listTools() 快照守。
 *
 * v1.11（round1 T1）：0.3.0 → 1.7.0。迁移面契约复核（tarball build 逐文件白盒）：
 *  - evaluate_script `function: string` 保持 ✓（click/fill_form uid 契约保持 ✓）
 *  - take_screenshot format/fullPage 保持 ✓（新有 filePath，但 Lasso 维持自落盘+stat 校验）
 *  - **wait_for.text 从 string 变 `array(string).min(1)`**（McpPage.waitForTextOnPage
 *    对 text.flatMap）→ BrowseChannel.doWait / creepjs-probe 改传数组（INV-76 (b) 同步翻转）
 *  - 1.7.0 默认采集使用统计 → 全部 spec 追加 --no-usage-statistics（隐私不倒退）
 *  - 新增 --chromeArg/--proxyServer/--wsEndpoint/--wsHeaders/--viewport/--allowedUrlPattern
 *    （T2 UA/viewport、T5 原生 network/console、T10 proxy 解锁）
 *  - pdf 工具仍不存在（0.3.0 亦无）→ doPdf 既有 tri-state 降级路径不变
 *  - BrowserbaseChannel 改用 --wsEndpoint（wss+自定义头才有语义保障；与 --browserUrl 互斥）
 */
export const LOCKED_CDP_MCP_VERSION = "1.7.0";

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
   * W2-DEF-N2（v1.8.1）：历史 spawn 过的全部 MCP 子进程 pid（含已优雅关闭的）。
   * 永不删除——exit 钩子 killAllSync 以此为真源做树杀，修复「优雅 _kill 清 map
   * 后 exit 钩子遍历空 map、SIGKILL 永不发出」的接线缺口（wave2 实证净残留 2 进程/次）。
   */
  private lifecyclePids = new Set<number>();
  /**
   * v0.3.5 新增（parse4 §3.5.2）：Rust helper 子进程追踪。
   * 与 MCP 的 procs/specs 平行，互不污染（INV-7：MCP 路径一行不动）。
   */
  private rustProcs = new Map<string, RustProc>();
  private rustSpecs = new Map<string, RustSpawnSpec>();
  private zombieTimer: NodeJS.Timeout | null = null;
  /**
   * v1.9（parse17 §2.2 (b)）：回收前回调 hook（机制三接线用；默认 null 零行为变化）。
   *
   * cleanupZombies 在 _kill 前 await 它（3s 上界，超时 warn 放行不阻断 reaper）——
   * index.ts 装配段用它实现「idle 回收 logged_in spec 前先恢复用户 tab 列表」。
   * INV-7 合规性：hook 是 lifecycle 编排点，本类不关心回调内容、不读协议帧
   * （与 ResourceMonitor 注入 listManagedPids 同范式，v0.7 先例）。
   */
  private reapHook: ((name: string) => Promise<void>) | null = null;
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
        // v1.9（parse17 §2.2 (b)）：回收前 reap hook（有界 3s，不阻塞 reaper；
        // hook 抛错/超时只 warn——恢复动作是 best-effort，不能拖死回收本身）
        if (this.reapHook) {
          try {
            await Promise.race([
              this.reapHook(name),
              new Promise<void>((resolve) =>
                setTimeout(() => resolve(), 3_000),
              ),
            ]);
          } catch (e) {
            logger.warn({ evt: "reap_hook_error", name, error: String(e) });
          }
        }
        await this._kill(name);
      }
    }
  }

  /**
   * v1.9（parse17 §2.2 (b)）：刷新一个受管 MCP 子进程的 lastUsedAt（长调用保活）。
   *
   * 背景：lastUsedAt 只在 ensureRunning 复用时刷新——带 steps 的长 browse
   * （多步导航 + ExpectPoll 轮询）可能超过 idle 阈值，若不 touch，watchdog 会在
   * 调用进行中杀掉浏览器。BrowseChannel 在每个 action/step dispatch 后调本方法，
   * 「in-flight 窗口」内 lastUsedAt 持续新鲜。未知 spec / 已 closed → no-op。
   */
  touch(name: string): void {
    const m = this.procs.get(name);
    if (m && !m.closed) m.lastUsedAt = Date.now();
  }

  /**
   * v1.9（parse17 §2.2 (b)）：设置/清除回收前回调（机制三接线用）。
   * 传 null 恢复零行为（默认态）。
   */
  setReapHook(hook: ((name: string) => Promise<void>) | null): void {
    this.reapHook = hook;
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

  /**
   * BUG-rust-helper-relative-path §4.2/§4.3：取 rust spec 的 command 绝对路径。
   * RustBridge onError（ENOENT 自诊断）用——错误信息与 spawn 实际路径同源，
   * 不在 bridge 侧二次猜路径。
   */
  getRustSpecCommand(name: string): string | undefined {
    return this.rustSpecs.get(name)?.command;
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

  /**
   * W1-DEF-6（v1.8 Phase B）：同步兜底 kill 全部受管子进程。
   *
   * 背景：SIGTERM/SIGINT 路径已走 shutdown()（SDK transport 优雅 SIGTERM），
   * 但「stdin 关闭等自然退出 / uncaughtException 后 exit」不触发信号处理器，
   * 受管子进程（chrome-devtools-mcp / rust-helper）变 ppid=1 孤儿（wave1 T-BROWSE-24
   * 受控实验 +1 实证）。process.on("exit") 钩子必须同步，故本方法零 await。
   *
   * 语义：
   *  - 对所有未 closed 的受管 pid 逐个 best-effort SIGKILL（try/catch 单个失败不拖垮其余）
   *  - 标 closed + 清 map（幂等；重复调用零副作用）
   *  - 不关 httpAgents / 不清 zombieTimer（exit 路径进程即将终止，无意义）
   *  - INV-7 仍守：纯 lifecycle，不读协议帧
   */
  killAllSync(): void {
    // W2-DEF-N2（v1.8.1）：以 lifecyclePids（永不清）为真源——优雅 _kill 清过 map
    // 的进程也能在此被树杀。procs/rustProcs 里仍未 closed 的照旧收集。
    const pids: Array<{ name: string; pid: number }> = [];
    for (const [name, m] of this.procs) {
      if (m.closed) continue;
      m.closed = true;
      const pid = m.client.pid;
      if (pid !== null) pids.push({ name, pid });
    }
    for (const [name, m] of this.rustProcs) {
      if (m.closed) continue;
      m.closed = true;
      if (m.proc.pid !== undefined) pids.push({ name, pid: m.proc.pid });
    }
    for (const pid of this.lifecyclePids) pids.push({ name: "lifecycle", pid });
    const seen = new Set<number>();
    for (const { name, pid } of pids) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      this._killTreeSync(name, pid);
    }
  }

  /**
   * W2-DEF-N2（v1.8.1）：对 pid 及其全部后代递归 SIGKILL（best-effort）。
   * 单 pid SIGKILL 杀不死 npx shim 下层的 node/Chrome（ppid=1 孤儿的来源）——
   * macOS 无 /proc，用 pgrep -P 逐层枚举子进程。INV-7 语义不变：纯 lifecycle。
   *
   * v1.9（parse17 §3.5）：实现原样搬到 util/kill-tree.ts（单一真源，chrome-stop
   * 共享同一原语，杜绝第二份 pgrep 递归漂移）；本方法保留为薄委托——既有调用点
   * （killAllSync / _kill）与 INV-76 (n) 的 grep 不变。
   */
  private _killTreeSync(name: string, pid: number): void {
    killTreeSync(pid, name);
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
  // v0.7 新增（parse8 §3.3 / §7.2 Phase C —— ResourceMonitor 旁路采样用）
  // ============================================================
  /**
   * v0.7: 只读 pid 枚举器（ResourceMonitor 注入用）。
   *
   * 设计：
   *  - 返回当前已 spawn 的所有受管子进程（MCP + Rust），name + pid 形式
   *  - 已退出（closed=true）/ 未启动的 spec 不列（pid=null 对应 spec 不返）
   *  - INV-7 仍守：纯 lifecycle 读取，不读协议帧；INV-46 衍生：调用方只读 pid 数字
   *
   * @returns 数组 [{name, pid}]；pid 可能为 null（已 spawn 但 transport 未暴露 pid 时）
   */
  listManagedPids(): Array<{ name: string; pid: number | null }> {
    const out: Array<{ name: string; pid: number | null }> = [];
    for (const [name, m] of this.procs) {
      if (m.closed) continue; // 已退出，不列
      out.push({ name, pid: m.client.pid });
    }
    for (const [name, m] of this.rustProcs) {
      if (m.closed) continue;
      out.push({ name, pid: m.proc.pid ?? null });
    }
    return out;
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
        // W2-DEF-N2（v1.8.1）：lifecycle 登记永不清——优雅 _kill 清 map 后
        // exit 钩子仍能按 pid 树杀残留（npx shim 下层 node/Chrome 孤儿）。
        if (client.pid !== null) this.lifecyclePids.add(client.pid);
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
   * kill 一个 proc：关 client（SDK transport 会 SIGTERM 子进程）+ 树杀残存 + 标 closed。
   * 幂等。
   *
   * G5 修复（v1.9 parse17 §2.2 (b)）：SDK close 只对 npm exec shim 发 SIGTERM、
   * 不转发到下层 node/Chromium——只 close 不树杀 = 「回收即孤儿化」（ppid=1），
   * 要等 server exit 才被 lifecyclePids 兜底。补 `_killTreeSync` 后，`_kill` 的
   * 全部调用方（cleanupZombies / forgetSpec / shutdownOne / restart）一次全修。
   */
  private async _kill(name: string): Promise<void> {
    const m = this.procs.get(name);
    if (!m) return;
    m.closed = true;
    const pid = m.client.pid;
    try {
      await m.client.close();
    } catch (e) {
      logger.warn({
        evt: "subproc_close_error",
        name,
        error: String(e),
      });
    }
    // G5：close 失败/不致死都不阻断树杀（SIGKILL 是唯一可靠致死原语）
    if (pid !== null) this._killTreeSync(name, pid);
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
   *
   * BUG-rust-helper-relative-path §4.3（fail-fast 语义区分）：
   *  - 「环境缺文件 / 不可 spawn」（binary 不存在 / 目录 / 丢 exec 位）是**确定性**
   *    失败——重试 5 次必同样失败还白烧 ~30s backoff。spawn 前先过 rustSpawnGate
   *    探测（存在 + isFile + X_OK 三态一次判齐），不可用即抛带自诊断文案（解析
   *    路径 + 对应修法 + env 覆盖提示）的错误，**不进 backoff**。
   *  - 「瞬态崩溃」（如 spawn 竞态）才值得退避重试。
   *
   * A1（对抗复审轮 1）：旧 existsSync 门只判存在不判可 spawn——目录 / 丢 exec
   * 位的文件漏过此门，spawn EACCES 打到 RustBridge.onError 兜底分支，归因裸
   * `rust_helper_crashed:EACCES`（无路径/无修法）。改用 rustSpawnGate 后此态
   * 同样 spawn 前 fail-fast + 自诊断（门语义单一真源在 rust-helper-path.ts）。
   */
  private async _spawnRustWithBackoff(name: string): Promise<ChildProcess> {
    const spec = this.rustSpecs.get(name);
    if (!spec) throw new Error(`Unknown rust subprocess spec: ${name}`);

    // 确定性不可 spawn → fail fast（不烧 5×backoff；归因前缀与 W1-DEF-9 契约一致，
    // 既有的 /rust_helper_crashed:subproc_spawn_failed/ 断言零回归）
    const gate = rustSpawnGate(spec.command);
    if (gate !== "ok") {
      const hint =
        gate === "missing"
          ? rustHelperMissingHint(spec.command)
          : rustHelperNotSpawnableHint(
              spec.command,
              gate === "not_file" ? "路径是目录" : "存在但缺执行权限",
            );
      const err = new Error(
        `rust_helper_crashed:subproc_spawn_failed — ${hint}`,
      );
      logger.error({
        evt: "rust_proc_spawn_failed",
        name,
        attempt: 0,
        fail_fast: true,
        gate,
        command: spec.command,
        cwd: process.cwd(),
        error: String(err),
      });
      throw err;
    }

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
          // W1-DEF-9：spawn error（ENOENT 等）不只打日志——标 closed，
          // 让 ensureRustRunning 下次重 spawn，且 RustBridge 的 error 监听
          // 会把全部 pending reject（不再烧满超时）。
          const m = this.rustProcs.get(name);
          if (m) m.closed = true;
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
        // ENOENT = 确定性缺文件（BUG §4.3）：不进 backoff，直接抛自诊断错误
        const isENOENT =
          (e as NodeJS.ErrnoException | null)?.code === "ENOENT" ||
          /ENOENT/i.test(e instanceof Error ? e.message : String(e));
        if (attempt >= 5 || isENOENT) {
          const err = isENOENT
            ? new Error(
                `rust_helper_crashed:subproc_spawn_failed — ${rustHelperMissingHint(spec.command)}`,
              )
            : e;
          logger.error({
            evt: "rust_proc_spawn_failed",
            name,
            attempt,
            fail_fast: isENOENT,
            command: spec.command,
            cwd: process.cwd(),
            error: String(err),
          });
          throw err;
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
