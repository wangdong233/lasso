/**
 * StealthEngine（parse5 §3.3，F3.2.12 反检测）
 *
 *  - injectProfile(client, profileName)：navigate 前注入 user-agent / viewport /
 *    timezone / navigator.webdriver 反检测属性
 *  - detectCloudflareChallenge(client)：识别 Cloudflare "Just a moment..." 页面
 *  - escalateManualSwitch：stealth 失败时升 manual-switch（不让 model 自动绕过）
 *
 * 借鉴（parse5 §3.3）：
 *  - open-webSearch 的 stealth 脚本范式（CDP Network.setUserAgentOverride +
 *    Page.addScriptToEvaluateOnNewDocument 注入 webdriver=false 等）
 *  - Argus 的 manual-switch 政策 gate（stealth 失败不自动升级 captcha 求解）
 *  - puppeteer-extra-plugin-stealth 的多维度 navigator 抹除
 *
 * 关键铁律（parse5 §3.3.1）：
 *  1. stealth 注入只走 CDP methods（Network / Page domain）或 chrome-devtools-mcp
 *     的 evaluate_script —— 不污染 audit log（stealth 自带脚本，不经业务路径）
 *  2. stealth profile 是顶级 const（stealth-profiles.ts，INV-30），**不从 config/env 读**
 *     （anti-gaming，类比 INV-14 / INV-27）
 *  3. StealthEngine 不感知 channel —— 注入只接 McpClient 接口，任何 BrowseChannel
 *     子类（HeadlessChannel / BrowserbaseChannel）都可复用
 *  4. stealth 失败时**不自动 captcha 求解** —— escalateManualSwitch 升 manual-switch
 *     （Argus 范式，F3.4.6 政策红线）
 */
import type { McpClient } from "../subprocess/McpClient.js";
import { logger } from "../util/logger.js";
import {
  STEALTH_PROFILES,
  STEALTH_INJECTION_SCRIPT,
  CLOUDFLARE_DETECTION_SCRIPT,
  CLOUDFLARE_DETECTION_REGEX,
  type StealthProfileName,
  type StealthProfile,
} from "./stealth-profiles.js";

// ============================================================
// StealthEngine
// ============================================================
export class StealthEngine {
  /**
   * 在 navigate 前注入 stealth profile（CDP methods 直调 + evaluate_script）。
   *
   * 流程（parse5 §3.3.1）：
   *  1. profile 校验（未知 profile 名 → throw；caller catch 走 didnt）
   *  2. evaluate_script(STEALTH_INJECTION_SCRIPT) → navigator.webdriver / languages /
   *     window.chrome / permissions 抹除
   *  3. evaluate_script(userAgentOverride) → navigator.userAgent 改写（CDP
   *     Network.setUserAgentOverride 在 chrome-devtools-mcp 暂未暴露独立工具，
   *     evaluate 是 fallback；browserbase 自带 stealth 时本步幂等）
   *
   * 注：viewport / timezone 由 chrome-devtools-mcp 启动 flag 控制
   *    （subprocess spec 加 --window-size / --timezone）；StealthEngine 不在这里设。
   *
   * @param client McpClient（chrome-devtools-mcp connection）
   * @param profileName STEALTH_PROFILES 顶级 const 的 key
   * @throws unknown_stealth_profile:<name> 当 profileName 未识别
   */
  async injectProfile(
    client: McpClient,
    profileName: StealthProfileName,
  ): Promise<void> {
    const profile = STEALTH_PROFILES[profileName];
    if (!profile) {
      throw new Error(`unknown_stealth_profile:${profileName}`);
    }

    // 1. 注入 navigator.webdriver / languages / window.chrome / permissions 抹除脚本
    //    STEALTH_INJECTION_SCRIPT 是顶级 const，**所有 profile 共用**（webdriver=false
    //    等是通用反检测，与具体 UA 无关）
    await this.evaluate(client, STEALTH_INJECTION_SCRIPT, "inject_stealth_core");

    // 2. userAgent override（profile-specific；chrome-devtools-mcp 暂未暴露独立
    //    setUserAgentOverride 工具，evaluate 是 fallback）
    await this.evaluate(
      client,
      buildUserAgentOverrideScript(profile),
      "inject_stealth_useragent",
    );

    logger.info({
      evt: "stealth_injected",
      profile: profileName,
      ua: profile.userAgent.slice(0, 40) + "...",
    });
  }

  /**
   * 检测 Cloudflare challenge 页面（parse5 §3.3.1 detectCloudflareChallenge）。
   *
   * 流程：
   *  1. evaluate_script(CLOUDFLARE_DETECTION_SCRIPT) → 返 "true"/"false"
   *  2. evaluate 失败或非 "true"/"false" 返回 → 降级用 CLOUDFLARE_DETECTION_REGEX
   *     直接 grep 原文本（兜底，防 evaluate 返回结构漂移）
   *
   * @returns true=正在 challenge（caller 升 manual-switch）；false=正常页面
   */
  async detectCloudflareChallenge(client: McpClient): Promise<boolean> {
    let raw: string;
    try {
      const r = (await client.callTool("evaluate_script", {
        function: CLOUDFLARE_DETECTION_SCRIPT,
      })) as ContentResult;
      raw = firstText(r) ?? "";
    } catch (e) {
      // evaluate 抛错（页面未就绪 / CDP 断）→ 保守判 false（继续 retry）
      logger.warn({
        evt: "cloudflare_detect_evaluate_failed",
        error: String(e),
      });
      return false;
    }
    // 主路径：evaluate 返 "true"/"false" 字符串
    if (raw.trim() === "true") return true;
    if (raw.trim() === "false") return false;
    // 兜底：返回非契约字符串 → 跑正则
    return CLOUDFLARE_DETECTION_REGEX.test(raw);
  }

  /**
   * Stealth 失败 → 升 manual-switch（parse5 §3.3.1 escalateManualSwitch）。
   *
   * 设计：不返回 InteractResult（StealthEngine 不感知 channel），只返一个
   * 标准 outcome 信号给 caller（BrowseChannel.beforeNavigate / BrowserbaseChannel）。
   * caller 据此把 browse() 的 InteractResult 改写成：
   *   outcome="didnt" + retrieval_method="cloudflare_manual_switch"
   *   + error="cloudflare_challenge_detected_stealth_escalated"
   *
   * Argus 范式（parse5 §3.3 铁律 4）：绝不自动 captcha 求解；model 看到信号后
   * 应**显式问用户**或换 channel（如已 logged_in → 用本机真实 Chrome 反检测）。
   */
  escalateManualSwitch(reason: "cloudflare_detected" | "stealth_inject_failed"): {
    outcome: "didnt";
    retrieval_method: string;
    error: string;
  } {
    const error =
      reason === "cloudflare_detected"
        ? "cloudflare_challenge_detected_stealth_escalated"
        : "stealth_inject_failed_manual_switch";
    logger.warn({
      evt: "stealth_escalate_manual_switch",
      reason,
      error,
    });
    return {
      outcome: "didnt",
      retrieval_method: "cloudflare_manual_switch",
      error,
    };
  }

  // ============================================================
  // 内部 helper
  // ============================================================
  /**
   * evaluate_script 包装：失败时不抛（stealth 是 best-effort，注入失败不阻断 browse）。
   * 调用方（injectProfile）希望 stealth 失败可恢复时用此 helper。
   */
  private async evaluate(
    client: McpClient,
    script: string,
    evt: string,
  ): Promise<void> {
    try {
      await client.callTool("evaluate_script", { function: script });
    } catch (e) {
      // stealth 注入失败 → 仅 warn（不阻断 browse）；caller 经 detectCloudflareChallenge
      // 探知页面状态后再决定是否 escalateManualSwitch
      logger.warn({
        evt: `stealth_${evt}_failed`,
        error: String(e),
      });
    }
  }
}

// ============================================================
// buildUserAgentOverrideScript（profile-specific payload builder）
// ============================================================
/**
 * 构造 navigator.userAgent / platform / language override 注入脚本。
 *
 * 设计：脚本是纯字符串拼装（无副作用），profile 字段经 JSON.stringify
 * 转义防注入（profile 是顶级 const 数据，本就是 trusted，但仍走 JSON.stringify
 * 守编码正确性 —— 守 02 §4 简单性：用对的语言做对的事）。
 */
function buildUserAgentOverrideScript(profile: StealthProfile): string {
  return `(function(){
  try {
    Object.defineProperty(navigator, "userAgent", {
      get: function() { return ${JSON.stringify(profile.userAgent)}; },
      configurable: true,
    });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, "platform", {
      get: function() { return ${JSON.stringify(profile.platform)}; },
      configurable: true,
    });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, "language", {
      get: function() { return ${JSON.stringify(profile.language)}; },
      configurable: true,
    });
  } catch (e) {}
})();`;
}

// ============================================================
// SDK 返回结构解析（与 BrowseChannel / ExpectPoll 内部解析同构）
// ============================================================
type TextBlock = { type: "text"; text?: string };
type ContentResult = { content?: TextBlock[]; isError?: boolean };

function firstText(r: ContentResult | undefined): string | undefined {
  if (!r?.content) return undefined;
  for (const b of r.content) {
    if (b.type === "text" && b.text) return b.text;
  }
  return undefined;
}
