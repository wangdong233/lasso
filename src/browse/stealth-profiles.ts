/**
 * stealth-profiles（parse5 §3.3.2 + §3.3.1，INV-30 顶级 const）
 *
 * 预定义 stealth 配置表 + 注入脚本 payload（CDP evaluate 在页面上下文执行）。
 *
 * 铁律（parse5 §3.3 + INV-30，类比 INV-14 / INV-27 anti-gaming）：
 *  - 本文件**只放顶级 const 数据**：STEALTH_PROFILES / STEALTH_INJECTION_SCRIPT /
 *    CLOUDFLARE_DETECTION_SCRIPT / CLOUDFLARE_CHALLENGE_MARKERS。
 *  - **不从 config / env / ProviderRegistry 读**（防 LLM 通过 channel 改 env 绕过）。
 *  - 加新 profile = 加 STEALTH_PROFILES 一行（≤2 处改动守 02 §4）。
 *
 * 借鉴（parse5 §3.3 标注）：
 *  - open-webSearch stealth 脚本（CDP Network.setUserAgentOverride +
 *    Page.addScriptToEvaluateOnNewDocument 注入 webdriver=false）
 *  - Argus manual-switch 政策 gate（stealth 失败 → 升 manual-switch，不自动绕）
 *  - puppeteer-extra-plugin-stealth 的 navigator.webdriver 抹除范式
 *
 * 注：JS 字符串是 stealth payload（在浏览器页面上下文执行，不是 TS 平台调用）。
 *     INV-21 不适用（INV-21 守 TS 代码本体不直调 AXUIElement/CGEvent，浏览器侧
 *     navigator API 不是 macOS 平台字面量）。
 */

// ============================================================
// StealthProfile 类型
// ============================================================
/**
 * 单条 stealth profile（parse5 §3.3.2 StealthProfile 接口）。
 *  - userAgent : navigator.userAgent override（也作 chrome-devtools-mcp --user-agent flag）
 *  - viewport  : window outer size（chrome-devtools-mcp --window-size flag）
 *  - timezone  : Intl.DateTimeFormat().resolvedOptions().timeZone override
 *  - language  : navigator.language / Accept-Language header
 *  - platform  : navigator.platform（Win32 / MacIntel / Linux x86_64）
 */
export interface StealthProfile {
  userAgent: string;
  viewport: { width: number; height: number };
  timezone: string;
  language: string;
  platform: string;
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
 * 加新 profile = 加这里一行（≤2 处改动守 02 §4 简单性）。
 */
export const STEALTH_PROFILES = {
  windows_chrome_120: {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    timezone: "America/New_York",
    language: "en-US",
    platform: "Win32",
  },
  mac_safari_17: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    viewport: { width: 1680, height: 1050 },
    timezone: "Asia/Shanghai",
    language: "zh-CN",
    platform: "MacIntel",
  },
  linux_firefox_121: {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
    viewport: { width: 1920, height: 1080 },
    timezone: "Europe/London",
    language: "en-GB",
    platform: "Linux x86_64",
  },
} as const satisfies Record<string, StealthProfile>;

/** profile 名（keyof STEALTH_PROFILES）；StealthEngine.injectProfile 接受此类型。 */
export type StealthProfileName = keyof typeof STEALTH_PROFILES;

/** profile 名清单（白盒供 test 遍历 + doctor 自检）。 */
export const STEALTH_PROFILE_NAMES = Object.keys(
  STEALTH_PROFILES,
) as StealthProfileName[];

// ============================================================
// STEALTH_INJECTION_SCRIPT 顶级 const（parse5 §3.3.1 注入脚本）
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
 * 关键注入点（覆盖 bot.sannysoft.com 等常见反爬检测）：
 *  1. navigator.webdriver → undefined（最关键，puppeteer 默认 true 是头号破绽）
 *  2. navigator.languages → ['en-US', 'en']（headless Chrome 默认空数组是破绽）
 *  3. window.chrome → { runtime: {} }（Chrome impersonation；headless 默认 undefined）
 *  4. navigator.permissions.query → Notification 不被拒（headless 默认 denied 是破绽）
 *
 * userAgent / viewport / timezone 由 chrome-devtools-mcp 启动 flag 控制
 * （subprocess spec 加 --user-agent / --window-size / --timezone）；本脚本只补
 * JS 侧 navigator 属性。
 */
export const STEALTH_INJECTION_SCRIPT = `(function(){
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
    // 3. window.chrome（Chrome impersonation；Firefox profile 下无此 API 不影响）
    if (typeof window.chrome === "undefined") {
      window.chrome = { runtime: {} };
    }
  } catch (e) {}
  try {
    // 4. navigator.permissions.query(Notification) 不返 denied（headless 默认 denied）
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
