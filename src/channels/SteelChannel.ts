/**
 * SteelChannel（parse14 §3.1 —— v1.6 Steel 自托管 cloud 通道）
 *
 *  - extends BrowseChannel（复用 actionDispatch Map + StepEngine + runExpect，R-CI-02 守）
 *  - 唯一差异：getMcpClient() 走 Steel CDP nginx proxy（http://host:9223 → Chrome 内部 9222）
 *  - StealthEngine 在 navigate 前注入（override beforeNavigate hook；Steel 自带 fingerprint 可叠加）
 *
 * 与 BrowserbaseChannel 的 3 个关键差异（parse14 §3.1 差异表，全部源码证据）：
 *
 *   | 维度          | BrowserbaseChannel                    | SteelChannel（本类）                     |
 *   |---------------|---------------------------------------|------------------------------------------|
 *   | 连接端点      | wss://connect.browserbase.com/?sid    | http://$host:9223（Chrome CDP nginx proxy）|
 *   | Session 模型  | 多 session（并发安全）                | 单例 activeSession（需 mutex 防并发 reset）|
 *   | 释放语义      | DELETE /v1/sessions/:id               | POST /v1/sessions/release                |
 *   | 认证          | Authorization: Bearer $KEY            | 无 auth（自托管本地 HTTP）               |
 *   | cookie 位置   | 出本地（云端 Chrome）                 | 不出本地（本地 Docker）                  |
 *
 * 不变量继承：
 *  - INV-2：extends BaseChannel 间接经 BrowseChannel → UiChannel → BaseChannel
 *  - INV-6：dispatch 走 Map，继承 actionDispatch（**不重写**，只换 McpClient 来源）
 *  - INV-23：fallback 链不跨 surface（cloud 浏览器 fallback 仅 browse_cloud.* 内部）
 *  - INV-25：cloud 浏览器必经 LASSO_ALLOW_CLOUD_BROWSER=true + STEEL_ENDPOINT 双重解锁
 *  - INV-74（v1.6 新增）：SteelChannel extends BrowseChannel（平级兄弟子类，禁嵌套/禁自造 fallback）
 *
 * 单例 session mutex 设计（parse14 §3.1 差异表 + R-V16-1）：
 *  - Steel SessionService 只有 activeSession: Session（单个字段；session.service.ts L73）
 *  - 并发 startSession 会先 resetSessionInfo 清掉前一个 session → 需 Promise 队列锁
 *  - 这是 SteelChannel 相对 BrowserbaseChannel 的**唯一新增复杂度**
 *    （Browserbase 多 session 天然并发安全）
 *
 * 懒连接铁律（与 BrowserbaseChannel 同范式，task spec #5）：
 *  - 构造**永不抛**（即使 steelEndpoint="" 也不抛 —— 允许 channel 注册但运行时短路）
 *  - 首次 browse() 时 preflight 检查 endpoint → 空 → outcome=didnt +
 *    retrieval_method="steel_no_endpoint"（不触网、不抛）
 *  - 首次 getMcpClient() 时 sessionProvider POST /v1/sessions → registerSpec → ensureRunning
 *
 * CDP 端点澄清（parse14 §4.2 R-V16-2）：
 *  - Steel SessionDetails.websocketUrl（ws://host:3000/）是 Steel server 自身 ws（UI live viewer），
 *    **不是** Chrome CDP 连接点。
 *  - Chrome CDP 经 nginx 9223→9222 暴露；chrome-devtools-mcp `--browser-url=http://host:9223`
 *    与 LoggedInChannel `--browser-url=http://localhost:9222` 范式 1:1 同构。
 */
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";
import { StealthEngine } from "../browse/StealthEngine.js";
import type { StealthProfileName } from "../browse/stealth-profiles.js";
import type {
  BrowseOptions,
  BrowseResult,
  ChannelStatus,
  Health,
  InteractResult,
} from "../types.js";
import { logger } from "../util/logger.js";

// ============================================================
// sessionProvider 类型 + 默认实装
// ============================================================
/**
 * sessionProvider：POST Steel /v1/sessions → 激活 session（单例模型）。
 *
 * Steel REST 契约（parse14 §3.2，全部基于源码 sessions.routes.ts L67-89 +
 * sessions.schema.ts SessionDetails L82-110）：
 *  - POST /v1/sessions body={} 或可选配置（proxyUrl / blockAds / dimensions / fingerprint / ...）
 *  - 无 Authorization header（自托管默认无 auth；session.controller.ts 不读 auth）
 *  - 返回 SessionDetails{ id, status, websocketUrl, ... }
 *
 * **producer 契约**（03 §1.2 项 1）—— Steel SessionDetails 字段集（sessions.schema.ts L82-110）：
 *  - id: string（session UUID；Lasso 读 json.id ?? json.sessionId）
 *  - status: string（"live" | ...；Lasso 读 json.status ?? "live" 默认值）
 *  - websocketUrl: string（**不用** —— 是 Steel server ws 非 Chrome CDP；parse14 §4.2）
 *
 * 失败：endpoint 不可达 / Steel 未启动 → 抛错；caller catch → outcome=unknown
 */
export interface SteelSessionProvider {
  /**
   * v1.11（round1 T10）：第 2 参 proxyUrl（可选；LASSO_PROXY 用户显式配置）。
   * 注入 mock 可忽略第 2 参（向后兼容——未配代理时与 v1.10 调用形状一致）。
   */
  (endpoint: string, proxyUrl?: string): Promise<{ sessionId: string; status: string }>;
}

/**
 * 默认 sessionProvider：POST http://$endpoint/v1/sessions 激活 session。
 *
 * 与 Browserbase 的 defaultBrowserbaseSessionProvider 的关键差异：
 *  - 不需 Authorization header（Steel 自托管无 auth）
 *  - body={} 让 Steel 用默认配置（用户可在 Steel dashboard 预配 fingerprint/proxy）
 *  - 返回 { sessionId, status }（不返 wsUrl —— CDP 连接点由 nginx 9223 暴露，不由 session 决定）
 *
 * INV-7 衍生：本函数不解 MCP 协议帧，只走 fetch REST；MCP 帧解析在 McpClient。
 */
export const defaultSteelSessionProvider: SteelSessionProvider = async (
  endpoint,
  proxyUrl,
) => {
  // v1.11（round1 T10）：Steel session schema 原生 proxyUrl（本文件 L66 注释早列了；
  //   LASSO_PROXY 配置时带上——出口一致性）
  const r = await fetch(`${endpoint}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proxyUrl ? { proxyUrl } : {}),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`steel_session_failed:${r.status}:${body.slice(0, 200)}`);
  }
  const json = (await r.json()) as {
    id?: string;
    sessionId?: string;
    status?: string;
  };
  const sid = json.id ?? json.sessionId;
  if (!sid) throw new Error("steel_session_no_id");
  return { sessionId: sid, status: json.status ?? "live" };
};

/**
 * 从 Steel API endpoint（http://localhost:3000）推导 Chrome CDP nginx proxy 端点（http://localhost:9223）。
 *
 * Steel nginx.conf：9223 listen → proxy_pass http://127.0.0.1:9222（Chrome CDP_REDIRECT_PORT）。
 * chrome-devtools-mcp `--browser-url=http://host:9223` 连此端口。
 *
 * 可用 STEEL_CDP_ENDPOINT env 覆盖（parse14 §4.3）：
 *   export STEEL_CDP_ENDPOINT=http://my-steel-host:9223
 */
export function deriveCdpEndpoint(steelEndpoint: string): string {
  const explicit = process.env.STEEL_CDP_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const u = new URL(steelEndpoint);
    u.port = "9223";
    return u.toString().replace(/\/+$/, "");
  } catch {
    // malformed endpoint; let downstream fail with clear error
    return steelEndpoint;
  }
}

// ============================================================
// SteelChannel
// ============================================================
export interface SteelChannelOptions {
  /** stealth profile 名，默认 "windows_chrome_120"（parse14 §3.1 sketch） */
  profileName?: StealthProfileName;
  /** sessionProvider，默认 defaultSteelSessionProvider（测试注入 mock） */
  sessionProvider?: SteelSessionProvider;
  /** SubprocessManager spec 名，默认 "steel" */
  specName?: string;
  /**
   * v1.11（round1 T10）：出口代理（config.proxy；空 = 不代理）。
   * 经 Steel session body `proxyUrl` 传给云端 Chrome（session schema 原生字段）。
   */
  proxyUrl?: string;
}

export class SteelChannel extends BrowseChannel {
  readonly name = "browse_cloud_steel";

  private cachedClient: McpClient | null = null;
  private cachedSessionId: string | null = null;
  /**
   * 单例 session mutex（parse14 §3.1 R-V16-1）。
   *
   * Steel SessionService 只有 1 个 activeSession；并发 POST /v1/sessions 会互相 reset
   * （session.service.ts startSession 先 resetSessionInfo 再启动，第二次调用清掉第一次）。
   * Promise 队列锁确保同一时刻只有一个 sessionProvider 调用在飞。
   */
  private sessionLock: Promise<void> = Promise.resolve();
  private readonly profileName: StealthProfileName;
  private readonly sessionProvider: SteelSessionProvider;
  private readonly specName: string;
  private readonly cdpEndpoint: string;
  /** v1.11（round1 T10）：出口代理（LASSO_PROXY；空 = 不代理） */
  private readonly proxyUrl: string;

  constructor(
    private readonly subproc: SubprocessManager,
    private readonly steelEndpoint: string,
    private readonly stealth: StealthEngine,
    opts: SteelChannelOptions = {},
  ) {
    super();
    this.profileName = opts.profileName ?? "windows_chrome_120";
    this.sessionProvider = opts.sessionProvider ?? defaultSteelSessionProvider;
    this.specName = opts.specName ?? "steel";
    this.proxyUrl = opts.proxyUrl ?? "";
    // CDP endpoint = Steel API host + :9223（nginx proxy port → Chrome 内部 9222）
    this.cdpEndpoint = deriveCdpEndpoint(steelEndpoint);
  }

  /**
   * 单例 session mutex：获取锁，返回 release 函数。
   *
   * Promise 链式锁范式：
   *  - 每次 acquire 把 this.sessionLock 换成自己的 release promise
   *  - caller await 前一个 sessionLock（等前任释放）
   *  - release() resolve 自己的 release promise → 后任的 await 完成
   */
  private acquireSessionLock(): Promise<() => void> {
    let releaseFn!: () => void;
    const myReleasePromise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    const prevMutex = this.sessionLock;
    this.sessionLock = myReleasePromise;
    return prevMutex.then(() => releaseFn);
  }

  /**
   * 复用 BrowseChannel 路径：仅替换 McpClient 来源（parse14 §3.1）。
   *
   * 流程：
   *  1. cachedClient 在 → 复用（同 BrowserbaseChannel/HeadlessChannel 懒启动范式）
   *  2. endpoint 缺 → 抛 cloud_no_key（caller browse() 已 prefilter，本路径不应到；
   *     防御性抛错给 status()/isAvailable() 等不经过 browse() 的路径用）
   *  3. acquireSessionLock（Steel 单例 session 防并发 reset）
   *  4. double-check cachedClient（并发 caller 可能已在锁内建好）
   *  5. sessionProvider(endpoint) → sessionId（仅首次；cachedSessionId 在 → 跳过）
   *  6. registerSpec("steel", chrome-devtools-mcp --browser-url=$cdpEndpoint)
   *  7. subproc.ensureRunning("steel") → McpClient
   *
   * @throws cloud_no_key:STEEL_ENDPOINT missing 当 endpoint 为空
   * @throws steel_session_failed:<status>:<body> 当 session REST 失败
   */
  protected async getMcpClient(): Promise<McpClient> {
    if (this.cachedClient) return this.cachedClient;
    if (!this.steelEndpoint) {
      throw new Error("cloud_no_key:STEEL_ENDPOINT missing");
    }

    // 单例 session mutex：Steel 只允许 1 个 activeSession，并发 POST 会互相 reset
    const release = this.acquireSessionLock();
    const releaseFn = await release;
    try {
      // double-check：并发 caller 可能在锁内已建好 client
      if (this.cachedClient) return this.cachedClient;

      // 1. 激活 Steel session（仅首次；单例模型 → cachedSessionId 在则跳过）
      if (!this.cachedSessionId) {
        const { sessionId, status } = await this.sessionProvider(
          this.steelEndpoint,
          this.proxyUrl || undefined,
        );
        this.cachedSessionId = sessionId;
        logger.info({
          evt: "steel_session_acquired",
          session_id: sessionId,
          status,
        });
      }

      // 2. registerSpec：chrome-devtools-mcp --browser-url=http://host:9223（CDP nginx proxy）
      //    注意：用 cdpEndpoint（9223），非 steelEndpoint（3000）
      //    与 LoggedInChannel --browser-url=http://localhost:9222 范式 1:1 同构
      this.subproc.registerSpec(this.specName, {
        command: "npx",
        args: [
          "-y",
          `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
          `--browser-url=${this.cdpEndpoint}`,
          // v1.11（round1 T1）：1.7.0 默认采集使用统计 → 显式关闭（隐私不倒退）。
          "--no-usage-statistics",
        ],
        mcpClientName: "lasso-browse-steel",
      });

      // 3. ensureRunning → McpClient
      this.cachedClient = await this.subproc.ensureRunning(this.specName);
      return this.cachedClient;
    } finally {
      releaseFn();
    }
  }

  /**
   * browse() override：preflight endpoint 检查 → 缺 endpoint 直接 outcome=didnt +
   * retrieval_method="steel_no_endpoint"（不触网、不抛）。
   *
   * 设计：构造永不抛（与 BrowserbaseChannel 同范式）；首次 browse() 才发现 endpoint 缺。
   * caller（FallbackDecider）据 retrieval_method="steel_no_endpoint" 路由到下一个
   * fallback channel 或显式降级到 manual-switch。
   *
   * INV-25 衍生：PolicyGate 已在 FallbackDecider 前置过滤（cloud 通道需双重解锁），
   * 此处是双重保险（channel 单独被调时也短路）。
   */
  override async browse(
    url: string,
    action: string,
    options: BrowseOptions,
  ): Promise<InteractResult<BrowseResult>> {
    if (!this.steelEndpoint) {
      return {
        outcome: "didnt",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "steel_no_endpoint",
        error:
          "STEEL_ENDPOINT missing; cloud browser disabled (set LASSO_ALLOW_CLOUD_BROWSER=true + STEEL_ENDPOINT to enable)",
      };
    }
    return super.browse(url, action, options);
  }

  /**
   * override beforeNavigate hook（parse14 §3.1 + parse5 §4.3）：navigate 前注入 stealth。
   * 调用时机由 BrowseChannel.wrapNavigate 保障（actionDispatch Map navigate 入口已包一层）。
   *
   * Steel 自带 fingerprint-generator（session.service.ts L9），比 Browserbase 更强；
   * Lasso StealthEngine 作为可选叠加（parse14 §7.1 R-V16-6 默认 MVP 叠加注入）。
   *
   * 失败容忍：stealth.injectProfile 失败时仅记 log（不阻断 browse）。
   */
  protected override async beforeNavigate(client: McpClient): Promise<void> {
    try {
      await this.stealth.injectProfile(client, this.profileName);
    } catch (e) {
      logger.warn({
        evt: "steel_stealth_inject_failed",
        profile: this.profileName,
        error: String(e),
      });
    }
  }

  /**
   * retrieval_method 标签：cloud_steel 区分 cloud_browserbase / chrome_devtools_mcp 路径。
   * 调用方（FallbackDecider / tool 层）据 retrieval_method 路由审计 / 计费。
   */
  protected override retrievalMethod(): string {
    return "cloud_steel";
  }

  /**
   * 释放 Steel session（进程退出或 channel disable 时调）。
   *
   * Steel REST 契约（parse14 §3.2）：POST /v1/sessions/release → ReleaseSession
   * （sessions.routes.ts L113-130 + sessions.schema.ts L114）。
   *
   * 失败容忍：release 失败仅 warn（不影响 channel 退出）。
   */
  async releaseSession(): Promise<void> {
    if (this.cachedSessionId && this.steelEndpoint) {
      try {
        await fetch(`${this.steelEndpoint}/v1/sessions/release`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        logger.info({
          evt: "steel_session_released",
          session_id: this.cachedSessionId,
        });
      } catch (e) {
        logger.warn({ evt: "steel_release_failed", error: String(e) });
      }
      this.cachedSessionId = null;
      this.cachedClient = null;
    }
  }

  // ============================================================
  // 状态/健康检查（cloud 浏览器专用：无 endpoint 直接 down）
  // ============================================================
  override async isAvailable(): Promise<boolean> {
    if (!this.steelEndpoint) return false;
    try {
      await this.getMcpClient();
      return true;
    } catch {
      return false;
    }
  }

  override async status(): Promise<ChannelStatus> {
    if (!this.steelEndpoint) {
      return { available: false, note: "steel_no_endpoint" };
    }
    return super.status();
  }

  override async healthCheck(): Promise<Health> {
    if (!this.steelEndpoint) return "down";
    return super.healthCheck();
  }

  // ============================================================
  // test-only helpers（暴露内部状态供单测断言；非生产路径）
  // ============================================================
  /** @internal test-only：当前 cached sessionId（验证 lazy connect + sessionProvider 调用） */
  _testGetCachedSessionId(): string | null {
    return this.cachedSessionId;
  }

  /** @internal test-only：当前 cached McpClient 引用（验证复用） */
  _testHasCachedClient(): boolean {
    return this.cachedClient !== null;
  }

  /** @internal test-only：推导的 CDP endpoint（验证 9223 端口推导） */
  _testGetCdpEndpoint(): string {
    return this.cdpEndpoint;
  }
}
