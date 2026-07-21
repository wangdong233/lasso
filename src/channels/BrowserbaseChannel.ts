/**
 * BrowserbaseChannel（parse5 §3.2.2，F3.12.1）
 *
 *  - extends BrowseChannel（复用 actionDispatch Map + StepEngine + runExpect）
 *  - 唯一差异：getMcpClient() 走 CDP-over-ws（browserbase session → ws endpoint →
 *    chrome-devtools-mcp --browser-url=$wsUrl，与 LoggedInChannel 复用 9222 范式同构）
 *  - StealthEngine 在 navigate 前注入（override beforeNavigate hook）
 *
 * 不变量继承（parse5 §3.2.2 + §2.3）：
 *  - INV-2：extends BaseChannel 间接经 BrowseChannel → UiChannel → BaseChannel
 *  - INV-6：dispatch 走 Map，继承 actionDispatch（**不重写**，只换 McpClient 来源）
 *  - INV-23：fallback 链不跨 surface（cloud 浏览器 fallback 仅 browse_cloud.*
 *    内部；禁入 desktop —— FallbackDecider + PolicyGate 守护）
 *  - INV-25：cloud 浏览器必经 LASSO_ALLOW_CLOUD_BROWSER=true + API key 双重解锁
 *    （PolicyGate 在 FallbackDecider 前置过滤；未配 → channel 不实例化）
 *
 * 政策 gate（parse5 §3.4）：
 *  - 仅在 LASSO_ALLOW_CLOUD_BROWSER=true 时由 index.ts 实例化（未配则该 channel 不存在）
 *  - ProviderConfig.policy_risk="safe"（browserbase 无收购风险；但仍走付费 manual-switch）
 *  - FallbackDecider 在 plan 含 browse_cloud.* 时前置 PolicyGate.check
 *
 * 懒连接铁律（task spec #5）：
 *  - 构造**永不抛**（即使 apiKey="" 也不抛 —— 允许 channel 注册但运行时短路）
 *  - 首次 browse() 时 preflight 检查 apiKey → 空 → outcome=didnt +
 *    retrieval_method="cloud_no_key"（不触网、不抛）
 *  - 首次 getMcpClient() 时 sessionProvider 解析 wsUrl → registerSpec → ensureRunning
 *
 * 借鉴：12 §2.1 Hyperbrowser（云 Chrome $0.10/h 计费类比）；
 *       08 §3.11 browse_cloud 预留位；13 §2.3 4-tier fallback 同范式（cloud 是链尾）。
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
 * sessionProvider：解析 browserbase session → 返回 wsUrl。
 * 默认实装走 browserbase 公开 REST；测试时注入 mock（parse5 §5.4 mock 策略）。
 */
export interface BrowserbaseSessionProvider {
  (apiKey: string): Promise<{ wsUrl: string; sessionId?: string }>;
}

/**
 * 默认 sessionProvider：POST https://api.browserbase.com/v1/sessions 启新 session。
 * 拿 sessionId → 拼 wsUrl = wss://connect.browserbase.com/?session=<id>。
 *
 * 遵循 browserbase 公开 REST 契约（08 §3.11 / 12 §2.1）：
 *  - Authorization: Bearer $BROWSERBASE_API_KEY
 *  - body: {}（project_id / region 走默认；用户可在 dashboard 预配）
 *  - 返回 { id, ... }（不同版本字段名略漂移；id 优先，sessionId 兜底）
 *
 * 失败：apiKey 错 / 配额耗尽 / 网络错 → 抛错；caller catch → outcome=unknown
 *      （cloud 浏览器网络错应可被 fallback 链接住，不阻断 Lasso 整体可用性）。
 *
 * INV-7 衍生：本函数不解 MCP 协议帧，只走 fetch REST；MCP 帧解析在 McpClient。
 */
export const defaultBrowserbaseSessionProvider: BrowserbaseSessionProvider = async (
  apiKey,
) => {
  const r = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`browserbase_session_failed:${r.status}:${body.slice(0, 200)}`);
  }
  const json = (await r.json()) as { id?: string; sessionId?: string };
  const sid = json.id ?? json.sessionId;
  if (!sid) throw new Error("browserbase_session_no_id");
  return {
    wsUrl: `wss://connect.browserbase.com/?session=${sid}`,
    sessionId: sid,
  };
};

// ============================================================
// BrowserbaseChannel
// ============================================================
export interface BrowserbaseChannelOptions {
  /** stealth profile 名，默认 "windows_chrome_120"（parse5 §3.2.2 sketch） */
  profileName?: StealthProfileName;
  /** sessionProvider，默认 defaultBrowserbaseSessionProvider（测试注入 mock） */
  sessionProvider?: BrowserbaseSessionProvider;
  /** SubprocessManager spec 名，默认 "browserbase" */
  specName?: string;
}

export class BrowserbaseChannel extends BrowseChannel {
  readonly name = "browse_cloud_browserbase";

  private cachedClient: McpClient | null = null;
  private cachedWsUrl: string | null = null;
  private readonly profileName: StealthProfileName;
  private readonly sessionProvider: BrowserbaseSessionProvider;
  private readonly specName: string;

  constructor(
    private readonly subproc: SubprocessManager,
    private readonly apiKey: string,
    private readonly stealth: StealthEngine,
    opts: BrowserbaseChannelOptions = {},
  ) {
    super();
    this.profileName = opts.profileName ?? "windows_chrome_120";
    this.sessionProvider =
      opts.sessionProvider ?? defaultBrowserbaseSessionProvider;
    this.specName = opts.specName ?? "browserbase";
  }

  /**
   * 复用 BrowseChannel 路径：仅替换 McpClient 来源（parse5 §3.2.2）。
   *
   * 流程：
   *  1. cachedClient 在 → 复用（同 HeadlessChannel/LoggedInChannel 懒启动范式）
   *  2. apiKey 缺 → 抛 cloud_no_key（caller browse() 已 prefilter，本路径不应到；
   *     防御性抛错给 status()/isAvailable() 等不经过 browse() 的路径用）
   *  3. sessionProvider(apiKey) → wsUrl
   *  4. registerSpec("browserbase", chrome-devtools-mcp --browser-url=$wsUrl)
   *  5. subproc.ensureRunning("browserbase") → McpClient
   *
   * wsUrl 动态（每 session 不同），故 spec 不能在 constructor 静态注册（与
   * HeadlessChannel/LoggedInChannel 不同）；lazily 在首次 getMcpClient 注册。
   *
   * @throws cloud_no_key:BROWSERBASE_API_KEY missing 当 apiKey 为空
   * @throws browserbase_session_failed:<status>:<body> 当 session REST 失败
   */
  protected async getMcpClient(): Promise<McpClient> {
    if (this.cachedClient) return this.cachedClient;
    if (!this.apiKey) {
      throw new Error("cloud_no_key:BROWSERBASE_API_KEY missing");
    }

    const { wsUrl, sessionId } = await this.sessionProvider(this.apiKey);
    this.cachedWsUrl = wsUrl;
    logger.info({
      evt: "browserbase_session_acquired",
      session_id: sessionId,
      ws_url_prefix: wsUrl.slice(0, 60),
    });

    // registerSpec 覆写（同 name 覆写——Map.set 语义，与 SubprocessManager 范式一致）
    this.subproc.registerSpec(this.specName, {
      command: "npx",
      args: [
        "-y",
        `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
        `--browser-url=${wsUrl}`,
      ],
      mcpClientName: "lasso-browse-browserbase",
    });
    this.cachedClient = await this.subproc.ensureRunning(this.specName);
    return this.cachedClient;
  }

  /**
   * browse() override：preflight apiKey 检查 → 缺 key 直接 outcome=didnt +
   * retrieval_method="cloud_no_key"（不触网、不抛）。
   *
   * 设计：构造永不抛（task spec #5）；首次 browse() 才发现 key 缺。
   * caller（FallbackDecider）据 retrieval_method="cloud_no_key" 路由到下一个
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
    if (!this.apiKey) {
      return {
        outcome: "didnt",
        data: null,
        served_by: this.name,
        fallback_used: false,
        retrieval_method: "cloud_no_key",
        error:
          "BROWSERBASE_API_KEY missing; cloud browser disabled (set LASSO_ALLOW_CLOUD_BROWSER=true + key to enable)",
      };
    }
    return super.browse(url, action, options);
  }

  /**
   * override beforeNavigate hook（parse5 §3.3.1 + §4.3）：navigate 前注入 stealth。
   * 调用时机由 BrowseChannel.wrapNavigate 保障（actionDispatch Map navigate 入口已包一层）。
   *
   * 失败容忍：stealth.injectProfile 失败时仅记 log（不阻断 browse）；caller 经
   * StealthEngine.detectCloudflareChallenge 探知页面状态后再决定是否 escalateManualSwitch。
   */
  protected override async beforeNavigate(client: McpClient): Promise<void> {
    try {
      await this.stealth.injectProfile(client, this.profileName);
    } catch (e) {
      logger.warn({
        evt: "browserbase_stealth_inject_failed",
        profile: this.profileName,
        error: String(e),
      });
    }
  }

  /**
   * retrieval_method 标签（v0.4 抽出）：cloud_browserbase 区分 chrome_devtools_mcp 路径。
   * 调用方（FallbackDecider / tool 层）据 retrieval_method 路由审计 / 计费。
   */
  protected override retrievalMethod(): string {
    return "cloud_browserbase";
  }

  // ============================================================
  // 状态/健康检查（cloud 浏览器专用：无 key 直接 down）
  // ============================================================
  override async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      await this.getMcpClient();
      return true;
    } catch {
      return false;
    }
  }

  override async status(): Promise<ChannelStatus> {
    if (!this.apiKey) {
      return { available: false, note: "cloud_no_key" };
    }
    return super.status();
  }

  override async healthCheck(): Promise<Health> {
    if (!this.apiKey) return "down";
    return super.healthCheck();
  }

  // ============================================================
  // test-only helpers（暴露内部状态供单测断言；非生产路径）
  // ============================================================
  /** @internal test-only：当前 cached wsUrl（验证 lazy connect + sessionProvider 调用） */
  _testGetCachedWsUrl(): string | null {
    return this.cachedWsUrl;
  }

  /** @internal test-only：当前 cached McpClient 引用（验证复用） */
  _testHasCachedClient(): boolean {
    return this.cachedClient !== null;
  }
}
