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
import { evalTextValue } from "./upstream-response.js";
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
   * v1.5 流程（parse13 §3.1 + §4.5）：
   *  1. profile 校验（未知 profile 名 → throw；caller catch 走 didnt）
   *  2. evaluate_script(buildUserAgentOverrideScript) → navigator.userAgent / platform /
   *     language 改写（**先执行**，使后续 UA client hints 能读到正确 Chrome 版本）
   *  3. evaluate_script(STEALTH_INJECTION_SCRIPT 16 路) → webdriver / languages / permissions /
   *     chrome.runtime/app/csi/loadTimes / plugins / vendor / hardwareConcurrency / media.codecs /
   *     webgl.vendor / iframe.contentWindow / outerdimensions / userAgentData（brands 版本与
   *     UA 一致；Safari/Firefox profile 跳过）
   *
   * HTTP header 侧 sec-ch-ua / sec-fetch-* 注入（parse13 §4.5）：依赖 chrome-devtools-mcp
   * 暴露 setExtraHTTPHeaders（spike 未解），v1.5 MVP 暂只走 JS 侧 navigator.userAgentData
   * （ua-client-hints.ts 是 sec-ch-ua 的 JS API 投影）。profile 的 header 字段
   * （secChUa / secFetch* / accept*）已定义在 StealthProfile 顶级 const（INV-30），供后续
   * chrome-devtools-mcp 暴露 header 注入工具时直用。
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

    // 1. userAgent override（profile-specific；**先执行**，使 STEALTH_INJECTION_SCRIPT 内的
    //    UA client hints 能读到正确的 navigator.userAgent 解析 Chrome 版本）
    const uaOk = await this.evaluate(
      client,
      buildUserAgentOverrideScript(profile),
      "inject_stealth_useragent",
    );

    // 2. 注入 16 路 evasion（STEALTH_INJECTION_SCRIPT 顶级 const，所有 profile 共用核心
    //    15 路；UA client hints 路 15 读 navigator.userAgent 已被上一步 override）。
    //    W1-DEF-1（v1.8）：SCRIPT 是 13 段 IIFE 语句串 join——包成上游 0.3.0 要求的
    //    单个函数表达式（上游调用时各段 IIFE 依次执行）。
    const coreOk = await this.evaluate(
      client,
      toFnExpression(STEALTH_INJECTION_SCRIPT),
      "inject_stealth_core",
    );

    // W1-DEF-1（v1.8）：必须上游返回非 isError 才记 stealth_injected——失败只记
    // stealth_inject_failed（禁误报；wave1 T-BROWSE-20 实锤注入静默失效 + 日志报成功）。
    if (!uaOk || !coreOk) {
      logger.warn({
        evt: "stealth_inject_failed",
        profile: profileName,
        ua_override_ok: uaOk,
        core_injection_ok: coreOk,
      });
      return;
    }

    logger.info({
      evt: "stealth_injected",
      profile: profileName,
      ua: profile.userAgent.slice(0, 40) + "...",
      roads: 16,
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
      // W1-DEF-1b（v1.8）：围栏提取（upstream-response.ts 实测契约），无围栏时
      // 保留原文走既有正则兜底路径（防上游形状再漂移）。
      raw = evalTextValue(r) ?? firstText(r) ?? "";
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
   *
   * W1-DEF-1（v1.8）：校验上游返回 isError——SDK 标准 { content, isError } 形态下
   * callTool 不 reject 也会失败（上游脚本错误 / 契约拒绝），必须显式检查。
   *
   * @returns true=注入成功（上游非 isError）；false=失败（throw 或 isError）
   */
  private async evaluate(
    client: McpClient,
    script: string,
    evt: string,
  ): Promise<boolean> {
    try {
      const r = (await client.callTool("evaluate_script", {
        function: script,
      })) as ContentResult;
      if (r?.isError) {
        // stealth 注入失败 → 仅 warn（不阻断 browse）；caller 经 detectCloudflareChallenge
        // 探知页面状态后再决定是否 escalateManualSwitch
        logger.warn({
          evt: `stealth_${evt}_failed`,
          error: firstText(r) ?? "upstream_is_error",
        });
        return false;
      }
      return true;
    } catch (e) {
      // stealth 注入失败 → 仅 warn（不阻断 browse）；caller 经 detectCloudflareChallenge
      // 探知页面状态后再决定是否 escalateManualSwitch
      logger.warn({
        evt: `stealth_${evt}_failed`,
        error: String(e),
      });
      return false;
    }
  }
}

// ============================================================
// toFnExpression（W1-DEF-1 helper）
// ============================================================
/**
 * 把「语句串脚本」（如 STEALTH_INJECTION_SCRIPT 的 13 段 IIFE join）包成
 * chrome-devtools-mcp@0.3.0 evaluate_script 要求的单个函数表达式。
 * 上游调用该函数时各语句依次执行。输入必须已是函数表达式的场景不要走此包装
 * （会产生 `() => { () => ... }` 的非法语句）。
 */
export function toFnExpression(script: string): string {
  return `() => {\n${script}\n}`;
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
  // W1-DEF-1（v1.8）：函数表达式（上游 0.3.0 契约），不再传 IIFE 语句串。
  return `() => {
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
}`;
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
