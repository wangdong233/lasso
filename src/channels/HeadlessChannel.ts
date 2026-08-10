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
import type { StealthProfileName } from "../browse/stealth-profiles.js";
import { logger } from "../util/logger.js";

export class HeadlessChannel extends BrowseChannel {
  readonly name = "browse_headless";

  private readonly stealth: StealthEngine;
  private readonly profileName: StealthProfileName;

  constructor(
    private readonly subproc: SubprocessManager,
    stealth?: StealthEngine,
    profileName: StealthProfileName = "windows_chrome_120",
  ) {
    super();
    // stealth 可选（向后兼容：未传则内部建一个 default StealthEngine；v1.5 index.ts 装配段
    // 显式传 stealth 实例供测试注入 mock）
    this.stealth = stealth ?? new StealthEngine();
    this.profileName = profileName;
    // v1.5（parse13 §3.3）：加 Chromium flag —— --disable-blink-features=AutomationControlled
    // 移除 navigator.webdriver=true 痕迹（与 JS evasion 路 1 navigator.webdriver→undefined 双保险）。
    //
    // §4.3 spike 结论（L1 证据 = chrome-devtools-mcp@0.3.0 --help + unknown-flag 启动测）：
    //  - chrome-devtools-mcp@0.3.0 只文档化 6 个自有 flag（--headless/--isolated/--channel/...），
    //    无 --chrome-arg 透传机制；yargs strict 未开 → unknown flag 不报错（实测 --disable-blink-features
    //    启动 banner 正常输出，exit=0）。
    //  - unknown flag 是否真到 Chromium 进程 = L3 真机验证项（parse13 §8.4 deferred-Spike），
    //    钉在 parse13-acceptance.md 手测清单（sannysoft navigator.webdriver=false）。
    //  - 降级兜底：即便 flag 未到 Chromium，JS evasion 路 1（navigator.webdriver→undefined）已覆盖
    //    同一检测点；flag 失效不阻断 browse（best-effort 语义）。
    subproc.registerSpec("headless", {
      command: "npx",
      args: [
        "-y",
        `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
        "--headless",
        "--isolated",
        "--disable-blink-features=AutomationControlled",
      ],
      mcpClientName: "lasso-browse-headless",
    });
  }

  protected async getMcpClient(): Promise<McpClient> {
    return this.subproc.ensureRunning("headless");
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
  protected override async beforeNavigate(client: McpClient): Promise<void> {
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
