/**
 * stealth-profiles（parse5 §3.3.2 + §3.3.1，INV-30 顶级 const；v1.5 增强 parse13 §3.1 + §3.2）
 *
 * 预定义 stealth 配置表 + 注入脚本 payload（CDP evaluate 在页面上下文执行）。
 *
 * 铁律（parse5 §3.3 + INV-30，类比 INV-14 / INV-27 anti-gaming）：
 *  - 本文件**只放顶级 const 数据**：STEALTH_PROFILES / STEALTH_INJECTION_SCRIPT /
 *    CLOUDFLARE_DETECTION_SCRIPT / CLOUDFLARE_CHALLENGE_MARKERS。
 *  - **不从 config / env / ProviderRegistry 读**（防 LLM 通过 channel 改 env 绕过）。
 *  - 加新 profile = 加 STEALTH_PROFILES 一行（≤2 处改动守 02 §4）。
 *
 * v1.5 改动（parse13 §3.1 + §3.2）：
 *  - StealthProfile 接口加 header 集（secChUa / secFetch-* / Accept-*）；UA 升 Chrome 130 /
 *    Safari 17.5 / Firefox 130（profile key 保持 v1.4 原名作稳定标识符，parse13 §2 零回归
 *    路径要求 BrowserbaseChannel 一行不动）。
 *  - STEALTH_INJECTION_SCRIPT 从 4 路→16 路（core 3 路 + 12 路 vendored from
 *    puppeteer-extra-plugin-stealth@2.11.2 MIT evasion）。
 *
 * 借鉴（parse5 §3.3 标注）：
 *  - open-webSearch stealth 脚本（CDP Network.setUserAgentOverride +
 *    Page.addScriptToEvaluateOnNewDocument 注入 webdriver=false）
 *  - Argus manual-switch 政策 gate（stealth 失败 → 升 manual-switch，不自动绕）
 *  - puppeteer-extra-plugin-stealth 的 navigator.webdriver 抹除范式 + 16 路 evasion 全集
 *
 * 注：JS 字符串是 stealth payload（在浏览器页面上下文执行，不是 TS 平台调用）。
 *     INV-21 不适用（INV-21 守 TS 代码本体不直调 AXUIElement/CGEvent，浏览器侧
 *     navigator API 不是 macOS 平台字面量）。
 */

import { CHROME_APP_SCRIPT } from "./stealth-evasions/chrome-app.js";
import { CHROME_CSI_SCRIPT } from "./stealth-evasions/chrome-csi.js";
import { CHROME_LOADTIMES_SCRIPT } from "./stealth-evasions/chrome-loadtimes.js";
import { CHROME_RUNTIME_SCRIPT } from "./stealth-evasions/chrome-runtime.js";
import { NAVIGATOR_PLUGINS_SCRIPT } from "./stealth-evasions/navigator-plugins.js";
import { NAVIGATOR_VENDOR_SCRIPT } from "./stealth-evasions/navigator-vendor.js";
import { HARDWARE_CONCURRENCY_SCRIPT } from "./stealth-evasions/hardware-concurrency.js";
import { MEDIA_CODECS_SCRIPT } from "./stealth-evasions/media-codecs.js";
import { WEBGL_VENDOR_SCRIPT } from "./stealth-evasions/webgl-vendor.js";
import { IFRAME_CONTENTWINDOW_SCRIPT } from "./stealth-evasions/iframe-contentwindow.js";
import { OUTER_DIMENSIONS_SCRIPT } from "./stealth-evasions/outer-dimensions.js";
import { UA_CLIENT_HINTS_SCRIPT } from "./stealth-evasions/ua-client-hints.js";

// ============================================================
// StealthProfile 类型
// ============================================================
/**
 * 单条 stealth profile（parse5 §3.3.2 StealthProfile 接口；v1.5 加 header 集 parse13 §3.2）。
 *  - userAgent : navigator.userAgent override（也作 chrome-devtools-mcp --user-agent flag）
 *  - viewport  : window outer size（chrome-devtools-mcp --window-size flag）
 *  - timezone  : Intl.DateTimeFormat().resolvedOptions().timeZone override
 *  - language  : navigator.language / Accept-Language header
 *  - platform  : navigator.platform（Win32 / MacIntel / Linux x86_64）
 *
 * v1.5 新增 header 集（parse13 §3.2 方案 A 手工升级；从 Apify header-generator
 * README result example 借鉴 schema；顶级 const 固定值，INV-30 anti-gaming）：
 *  - secChUa / secChUaMobile / secChUaPlatform : sec-ch-ua client hints（HTTP header 名小写）
 *      注：HTTP 网络层 sec-ch-ua 注入依赖 chrome-devtools-mcp 暴露 setExtraHTTPHeaders
 *      （parse13 §4.5 spike）；v1.5 MVP 暂只走 JS 侧 navigator.userAgentData（ua-client-hints.ts）
 *  - accept / acceptEncoding / acceptLanguage  : Accept-* header
 *  - secFetchSite / secFetchMode / secFetchUser / secFetchDest : Sec-Fetch-* header（navigate 首请求）
 *  - upgradeInsecureRequests : Upgrade-Insecure-Requests header
 *
 * Safari/Firefox profile 不发 sec-ch-ua（浏览器原生不支持）→ secChUa="" 表「不发此 header」。
 */
export interface StealthProfile {
  userAgent: string;
  viewport: { width: number; height: number };
  timezone: string;
  language: string;
  platform: string;
  // v1.5 header 集（parse13 §3.2 方案 A）
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  accept: string;
  acceptEncoding: string;
  acceptLanguage: string;
  secFetchSite: string;
  secFetchMode: string;
  secFetchUser: string;
  secFetchDest: string;
  upgradeInsecureRequests: string;
}

// ============================================================
// STEALTH_PROFILES 顶级 const（parse5 §3.3.2）
// ============================================================
/**
 * 预定义 stealth 配置表（INV-30：不从 config/env 读）。
 *
 * 选择这 3 条覆盖最常见反爬指纹组合：
 *  - windows_chrome_120 : 最大用户群（Chrome on Windows），低怀疑度
 *  - mac_safari_17      : macOS Safari（与开发机环境一致，便于 dev/test）
 *  - linux_firefox_121  : Linux Firefox（少数站点要求 non-Chrome UA 才放行）
 *
 * v1.5（parse13 §3.2）：profile **key 保持 v1.4 原名作稳定标识符**（parse13 §2 零回归
 * 路径要求 BrowserbaseChannel.ts:123 / browserbase.ts:73 / doctor.ts:1439 不动），
 * 但 UA **值**升 Chrome 130 / Safari 17.5 / Firefox 130（profile key ≠ UA 版本号，
 * key 是稳定引用句柄）。加新 profile = 加这里一行（≤2 处改动守 02 §4 简单性）。
 *
 * header 集（parse13 §3.2 方案 A）：windows_chrome 发 sec-ch-ua（Chrome 130 brands）；
 * mac_safari / linux_firefox secChUa="" 表浏览器原生不发 client hints（Safari 17 / Firefox
 * 130 均不支持 sec-ch-ua）。UA 版本 ↔ secChUa 版本 ↔ userAgentData.brands 版本三方一致
 * （windows_chrome profile：均 130）—— parse13 §8.2 producer 契约核心。
 */
export const STEALTH_PROFILES = {
  windows_chrome_120: {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    timezone: "America/New_York",
    language: "en-US",
    platform: "Win32",
    // v1.5 header 集（Chrome 130 sec-ch-ua，brands 与 UA 版本一致）
    secChUa: '"Google Chrome";v="130", "Not?A_Brand";v="99", "Chromium";v="130"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"',
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    acceptEncoding: "gzip, deflate, br, zstd",
    acceptLanguage: "en-US,en;q=0.9",
    secFetchSite: "none",
    secFetchMode: "navigate",
    secFetchUser: "?1",
    secFetchDest: "document",
    upgradeInsecureRequests: "1",
  },
  mac_safari_17: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    viewport: { width: 1680, height: 1050 },
    timezone: "Asia/Shanghai",
    language: "zh-CN",
    platform: "MacIntel",
    // Safari 17.5 原生不发 sec-ch-ua client hints → 空串表「不发此 header」
    secChUa: "",
    secChUaMobile: "",
    secChUaPlatform: "",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "zh-CN,zh;q=0.9",
    secFetchSite: "none",
    secFetchMode: "navigate",
    secFetchUser: "?1",
    secFetchDest: "document",
    upgradeInsecureRequests: "1",
  },
  linux_firefox_121: {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
    viewport: { width: 1920, height: 1080 },
    timezone: "Europe/London",
    language: "en-GB",
    platform: "Linux x86_64",
    // Firefox 130 原生不发 sec-ch-ua client hints → 空串表「不发此 header」
    secChUa: "",
    secChUaMobile: "",
    secChUaPlatform: "",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    acceptEncoding: "gzip, deflate, br",
    acceptLanguage: "en-GB,en;q=0.9",
    secFetchSite: "none",
    secFetchMode: "navigate",
    secFetchUser: "?1",
    secFetchDest: "document",
    upgradeInsecureRequests: "1",
  },
} as const satisfies Record<string, StealthProfile>;

/** profile 名（keyof STEALTH_PROFILES）；StealthEngine.injectProfile 接受此类型。 */
export type StealthProfileName = keyof typeof STEALTH_PROFILES;

/** profile 名清单（白盒供 test 遍历 + doctor 自检）。 */
export const STEALTH_PROFILE_NAMES = Object.keys(
  STEALTH_PROFILES,
) as StealthProfileName[];

// ============================================================
// STEALTH_INJECTION_SCRIPT 顶级 const（parse5 §3.3.1 + v1.5 parse13 §3.1 16 路）
// ============================================================
/**
 * 反检测注入脚本（在页面上下文 via CDP evaluate 执行）。
 *
 * 不变量（parse5 §3.3.1 铁律）：
 *  - **只走 CDP methods**（Network / Page domain）或 evaluate_script；
 *    不污染 chrome-devtools-mcp 的 audit log（stealth 是横切关注点，自带脚本）。
 *  - 脚本是**纯 JS 字符串数据**（无 TS 类型依赖 / 无 env 读取）；任何
 *    BrowseChannel 子类（HeadlessChannel / BrowserbaseChannel）都可复用。
 *
 * v1.5 16 路覆盖（parse13 §3.1 表逐条；port from puppeteer-extra-plugin-stealth@2.11.2 MIT）：
 *  CORE 3 路（v1.4 保留；chrome.runtime 基础版移除由增强版文件替代）：
 *   1. navigator.webdriver → undefined（最关键，puppeteer 默认 true 是头号破绽）
 *   2. navigator.languages → ['en-US', 'en']（headless Chrome 默认空数组是破绽）
 *   3. navigator.permissions.query → Notification 不被拒（headless 默认 denied）
 *  vendored 12 路（parse13 §3.1 新增；每路一个 stealth-evasions/*.ts 文件，MIT 头）：
 *   4.  chrome.runtime（增强版，sendMessage/connect mock + 枚举 + 事件桩；替代极简 window.chrome）
 *   5.  chrome.app（STATIC_DATA + getDetails/getIsInstalled/runningState）
 *   6.  chrome.csi（performance.timing 映射）
 *   7.  chrome.loadTimes（protocolInfo + timingInfo）
 *   8.  navigator.plugins（5 个 fake Plugin + MimeType + data；headless 默认空是头号破绽）
 *   9.  navigator.vendor → "Google Inc."
 *  10.  navigator.hardwareConcurrency → 4
 *  11.  media.codecs（canPlayType proxy；H.264 → "probably"）
 *  12.  webgl.vendor（getParameter proxy；37445→"Intel Inc." / 37446→"Intel Iris OpenGL Engine"）
 *  13.  iframe.contentWindow（createElement proxy；修 HEADCHR_IFRAME 检测）
 *  14.  window.outerdimensions（outerWidth=innerWidth / outerHeight=innerHeight+85）
 *  15.  UA client hints（navigator.userAgentData；brands 版本与 UA 一致；Safari/Firefox 跳过）
 *  16.  user-agent-override（navigator.userAgent / platform / language 改写；profile-specific，
 *       由 StealthEngine.buildUserAgentOverrideScript 单独注入，本 SCRIPT 不含 — 走第 2 次 evaluate）
 *
 * userAgent / viewport / timezone 由 chrome-devtools-mcp 启动 flag 控制
 * （subprocess spec 加 --user-agent / --window-size / --timezone）；本脚本只补
 * JS 侧 navigator 属性。
 *
 * license：vendored evasion 文件头均带 `// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT)`。
 */
const CORE_STEALTH_SCRIPT = `(function(){
  try {
    // 1. navigator.webdriver → undefined（最关键反检测点）
    Object.defineProperty(navigator, "webdriver", {
      get: function() { return undefined; },
      configurable: true,
    });
  } catch (e) {}
  try {
    // 2. navigator.languages → 非空（headless 默认 [] 是破绽）
    Object.defineProperty(navigator, "languages", {
      get: function() { return ["en-US", "en"]; },
      configurable: true,
    });
  } catch (e) {}
  try {
    // 3. navigator.permissions.query(Notification) 不返 denied（headless 默认 denied）
    var origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = function(params) {
        if (params && params.name === "notifications") {
          return Promise.resolve({ state: Notification.permission });
        }
        return origQuery.call(navigator.permissions, params);
      };
    }
  } catch (e) {}
})();`;

/**
 * 16 路反检测注入脚本（CORE 3 路 + 12 路 vendored evasion；join 成单字符串）。
 *
 * 设计：每路是独立 IIFE（自包 try/catch），单路失败不影响其它路（best-effort 语义，
 * parse13 §8.3）。StealthEngine.injectProfile 在 navigate 前一次性 evaluate 本 const。
 * chrome.runtime 增强版（CHROME_RUNTIME_SCRIPT）替代 v1.4 极简 window.chrome={runtime:{}}
 * —— 故 CORE 只保留 3 路（webdriver / languages / permissions）。
 */
export const STEALTH_INJECTION_SCRIPT = [
  CORE_STEALTH_SCRIPT,
  CHROME_RUNTIME_SCRIPT,
  CHROME_APP_SCRIPT,
  CHROME_CSI_SCRIPT,
  CHROME_LOADTIMES_SCRIPT,
  NAVIGATOR_PLUGINS_SCRIPT,
  NAVIGATOR_VENDOR_SCRIPT,
  HARDWARE_CONCURRENCY_SCRIPT,
  MEDIA_CODECS_SCRIPT,
  WEBGL_VENDOR_SCRIPT,
  IFRAME_CONTENTWINDOW_SCRIPT,
  OUTER_DIMENSIONS_SCRIPT,
  UA_CLIENT_HINTS_SCRIPT,
].join("\n");

// ============================================================
// CLOUDFLARE_DETECTION_SCRIPT 顶级 const（parse5 §3.3.1 detectCloudflareChallenge）
// ============================================================
/**
 * Cloudflare challenge 页面检测脚本（在页面上下文 via CDP evaluate 执行）。
 *
 * 返回值：字符串 "true" / "false"（兼容 ExpectPoll.snapshotCondition 的
 * `text === "true"` 契约 —— StealthEngine.detectCloudflareChallenge 复用此范式）。
 *
 * 检测信号（CLOUDFLARE_CHALLENGE_MARKERS 衍生）：
 *  - document.title 或 body.innerText 含 "Just a moment"（CF 经典 challenge 页）
 *  - 含 "Checking your browser"（CF 旧版 IE challenge）
 *  - 含 "cf-chl-bypass"（CF managed challenge DOM 标识）
 *  - 含 " Ray ID:"（CF 错误页footer）
 *
 * 设计：检测脚本本身**不挑战** challenge（不替 model 决策绕过）；
 *      caller（StealthEngine.detectCloudflareChallenge）拿到 true 后
 *      升 manual-switch（Argus 范式，parse5 §3.3.1 escalateManualSwitch）。
 */
export const CLOUDFLARE_CHALLENGE_MARKERS = [
  "Just a moment",
  "Checking your browser",
  "cf-chl-bypass",
  "Ray ID:",
  "Attention Required! | Cloudflare",
] as const;

/**
 * 检测脚本：返回 "true" 若任 marker 出现在 title 或 body.innerText。
 * 字符串拼装（避免对每个 marker 单独 evaluate；一次 CDP call 完成检测）。
 */
export const CLOUDFLARE_DETECTION_SCRIPT = `(function(){
  try {
    var markers = ${JSON.stringify(CLOUDFLARE_CHALLENGE_MARKERS)};
    var t = (document.title || "") + "\\n" + ((document.body && document.body.innerText) || "");
    for (var i = 0; i < markers.length; i++) {
      if (t.indexOf(markers[i]) !== -1) return "true";
    }
    return "false";
  } catch (e) {
    return "false";
  }
})();`;

/**
 * Cloudflare challenge 检测正则（兜底；当 evaluate_script 失败或返回非
 * "true"/"false" 时，对原始文本跑此正则）。StealthEngine.detectCloudflareChallenge
 * 在 evaluate 路径不可用时降级走此正则。
 */
export const CLOUDFLARE_DETECTION_REGEX = new RegExp(
  CLOUDFLARE_CHALLENGE_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);
