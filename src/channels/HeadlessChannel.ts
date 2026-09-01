/**
 * HeadlessChannel（parse1 §3.6 + §4.2；v1.5 parse13 §3.4 P0 核心修复 stealth 接入）
 *
 * spawn `chrome-devtools-mcp@<LOCKED_CDP_MCP_VERSION> --headless --isolated`。
 * 干净、隔离的 headless Chromium —— 无登录态、无 cookie 持久化。
 *
 * 适合：公开页面 / JS 重的 SPA / SERP fallback / 截图。
 *
 * 构造时往 SubprocessManager 注册 "headless" 规格，之后 getMcpClient() 懒启动。
 *
 * v1.5（parse13 §3.4 P0 核心修复）：
 *  - 构造接 StealthEngine + profileName（默认 windows_chrome_120，UA 值已升 Chrome 130）
 *  - override beforeNavigate 调 StealthEngine.injectProfile —— 修复 v1.4「HeadlessChannel
 *    零 stealth override、browse_headless 零反检测注入」P0 业务缺口（parse13 §1.2 白盒）。
 *    仿 BrowserbaseChannel.ts:211-221 范式（beforeNavigate hook 由 BrowseChannel.wrapNavigate
 *    保障调用时机）。
 *
 * 借鉴：08 §3.3；chrome-devtools-mcp 官方 headless 启动方式（实测）；
 *       BrowserbaseChannel beforeNavigate 范式（parse5 §3.3.1）。
 */
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";
import { StealthEngine } from "../browse/StealthEngine.js";
import { STEALTH_PROFILES, defaultHeadlessProfileForHost, type StealthProfileName } from "../browse/stealth-profiles.js";
import { logger } from "../util/logger.js";

/**
 * v1.12（round2 T2-1）：宿主平台对齐默认 profile 的选择函数在
 * browse/stealth-profiles.ts::defaultHeadlessProfileForHost（StealthProfileName
 * 定义处；review-r1 迁出本文件——doctor 不再 value-import channels）。
 */

export class HeadlessChannel extends BrowseChannel {
  readonly name = "browse_headless";

  private readonly stealth: StealthEngine;
  private readonly profileName: StealthProfileName;

  constructor(
    private readonly subproc: SubprocessManager,
    stealth?: StealthEngine,
    // v1.12（round2 T2-1）：缺省从硬编码 windows_chrome_120 改宿主对齐默认
    profileName: StealthProfileName = defaultHeadlessProfileForHost(),
    /**
     * v1.11（round1 T10）：出口代理（config.proxy；空 = 不代理）。
     * 经 1.7.0 `--proxy-server=` 传给 Chromium。**仅 headless 生效**——
     * LoggedInChannel 永不读 LASSO_PROXY（用户真实 Chrome 出口原样，铁律）。
     */
    proxyUrl?: string,
  ) {
    super();
    // stealth 可选（向后兼容：未传则内部建一个 default StealthEngine；v1.5 index.ts 装配段
    // 显式传 stealth 实例供测试注入 mock）
    this.stealth = stealth ?? new StealthEngine();
    this.profileName = profileName;
    // v1.5（parse13 §3.3）：加 Chromium flag —— --disable-blink-features=AutomationControlled
    // 移除 navigator.webdriver=true 痕迹（与 JS evasion 路 1 navigator.webdriver→undefined 双保险）。
    //
    // v1.11（round1 T1）：chrome-devtools-mcp 0.3.0 → 1.7.0。
    //  - 1.7.0 有 --chromeArg 透传机制 → --disable-blink-features=AutomationControlled
    //    经 `--chromeArg=<flag>` 真正到达 Chromium（0.3.0 unknown-flag 哑弹时代结束；
    //    parse13 §8.4 L3 未验证项就此关闭）。
    //  - 1.7.0 默认采集使用统计（README L45）→ --no-usage-statistics 必加（隐私不倒退）。
    //  - v1.11（round1 T2）：launch 级 UA/viewport —— `--chromeArg=--user-agent=<profile UA>`
    //    消除网络层 HeadlessChrome UA 头（JS defineProperty 改不了 HTTP 头；UA 头↔navigator
    //    不一致即标记）。profile 构造期已选定（上方 profileName），无生命周期冲突。
    //    JS 侧 16 路 evasion 保留为双保险。
    const profile = STEALTH_PROFILES[this.profileName];
    subproc.registerSpec("headless", {
      command: "npx",
      args: [
        // PERF-1（2026-09-02 性能轮）：--prefer-offline 前插——npx 每次冷启动对
        // registry 做 packument 新鲜度校验（条件请求），代理拥塞时 3-17s；prefer-offline
        // 有缓存即跳过网络（首装一次付税后缓存自持）。锚定测试 cdp-mcp-170-migration
        // spec「含 --prefer-offline」。npx/npm exec 同体，flag 直通。
        "--prefer-offline",
        "-y",
        `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
        "--headless",
        "--isolated",
        "--no-usage-statistics",
        "--chromeArg=--disable-blink-features=AutomationControlled",
        `--chromeArg=--user-agent=${profile.userAgent}`,
        // T3-1（round3 v1.13）：HTTP Accept-Language 头与 JS 层对齐。--user-agent
        // 改不了 Accept-Language 头（宿主真值 zh-CN 泄漏 ↔ JS 层 profile language
        // = 同请求内自矛盾的自然不可能形状）；--accept-lang 是 Chromium 标准
        // switch，值取 profile.acceptLanguage（与 navigator.languages 同源）。
        // E1' run B/C 实测：头变 "en-US,en;q=0.9,..." ≈ 真实双语用户形态。
        `--chromeArg=--accept-lang=${profile.acceptLanguage}`,
        `--viewport=${profile.viewport.width}x${profile.viewport.height}`,
        // v1.11（round1 T10）：出口代理（LASSO_PROXY 用户显式配置；空不加 flag）
        ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
      ],
      mcpClientName: "lasso-browse-headless",
    });
  }

  protected async getMcpClient(): Promise<McpClient> {
    return this.subproc.ensureRunning("headless");
  }

  /**
   * v1.9（parse17 §2.2 (d) 机制一）：action/step dispatch 后刷新 lastUsedAt，
   * 防 idle watchdog（默认 5min）误杀 in-flight 长 browse。默认 no-op 见基类。
   */
  protected override touchKeepalive(): void {
    this.subproc.touch("headless");
  }

  /**
   * override beforeNavigate hook（parse13 §3.4 P0 核心修复）：navigate 前注入 stealth。
   * 调用时机由 BrowseChannel.wrapNavigate 保障（actionDispatch Map navigate 入口已包一层）。
   *
   * v1.4 现状（parse13 §1.2 gap 1）：HeadlessChannel 不 override beforeNavigate →
   *   browse_headless 零 stealth 注入 → CC 访真实站被基础 bot 检测挡（「全交互抓手」名不副实）。
   *
   * 失败容忍：stealth.injectProfile 失败时仅记 log（不阻断 browse）；caller 经
   * StealthEngine.detectCloudflareChallenge 探知页面状态后再决定是否 escalateManualSwitch。
   * （仿 BrowserbaseChannel.ts:211-221 同范式，parse5 §3.3.1 铁律 4 best-effort 语义）
   */
  // W1-DEF-1c（v1.8）：从 beforeNavigate 迁到 afterNavigate——导航前注入会随
  // 文档重置全部丢失（wave2 smoke 实证 navigator.webdriver 仍 true），改为
  // navigate 完成后注入当前文档（stealth 语义 = 覆盖本次导航目标页）。
  protected override async afterNavigate(client: McpClient): Promise<void> {
    try {
      await this.stealth.injectProfile(client, this.profileName);
    } catch (e) {
      logger.warn({
        evt: "headless_stealth_inject_failed",
        profile: this.profileName,
        error: String(e),
      });
    }
  }
}
