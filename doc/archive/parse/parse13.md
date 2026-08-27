# parse13：Lasso v1.5 Stealth P0 修复执行计划

## 1. v1.5 目标与范围（白盒现状）

### 1.1 业务目标
修复 Lasso `browse_headless` 零反检测的业务短板，让「全交互抓手 MCP」名副其实——CC 用 `browse_headless` 访问真实站点能通过基础 bot 检测（sannysoft / 公开页 / 一般 SERP），而非被挡在门外。

### 1.2 白盒现状（4 个 P0 gap，引源码行号）

| gap | 源码证据 | 影响 |
|---|---|---|
| **HeadlessChannel 零 stealth override** | `HeadlessChannel.ts` 全文 38 行，grep `stealth\|StealthEngine\|STEALTH_INJECTION` 返回 exit=1（零命中）；`BrowseChannel.ts:127-129` beforeNavigate 默认 no-op；注释（`BrowseChannel.ts:96-97`）明写「HeadlessChannel / LoggedInChannel 不 override 即行为零变化」 | browse_headless 默认零反检测注入 |
| **StealthEngine 只 4 路 JS（vs 业界 16 路）** | `stealth-profiles.ts:112-145` STEALTH_INJECTION_SCRIPT 只覆盖：①navigator.webdriver→undefined ②navigator.languages→['en-US','en'] ③window.chrome={runtime:{}} ④navigator.permissions.query(Notification)。Canvas/WebGL/plugins/hardwareConcurrency/media.codecs/iframe.contentWindow 全裸奔 | 指纹覆盖严重不全 |
| **UA 固定 Chrome 120（现已是 13x+）** | `stealth-profiles.ts:55-80` STEALTH_PROFILES 硬编码 3 条：windows_chrome_120 / mac_safari_17 / linux_firefox_121 | UA 不更新被指纹库标可疑 |
| **HTTP header 一致性完全空白** | `StealthEngine.ts` 全文无 header 处理；`stealth-profiles.ts` 的 StealthProfile 接口（L34-40）无 sec-ch-ua / sec-fetch-* / Accept-* 字段；只改 navigator.userAgent 字符串，sec-ch-ua client hints 与 UA 不一致 | **sec-ch-ua vs UA 不一致是头号检测点**（doc/16 §1.3 P2） |

### 1.3 范围（修这 4 个 P0）
- StealthEngine：4 路 JS → 16 路（从 puppeteer-extra-plugin-stealth 源码 port）
- stealth-profiles：UA Chrome 120→130+ + 加 header 集（从 Apify header-generator 借鉴 schema）
- SubprocessManager chrome 启动 args：加 patchright flag
- HeadlessChannel：override beforeNavigate 接 StealthEngine（P0 核心修复）

### 1.4 零回归承诺
v1.4 基线（doc/16 §1.1 实测）：1511 TS passed + 179 Rust `#[test]` + 72 INV 全绿。v1.5 不破坏一行 Rust（stealth 全在 TS 层），72 INV 仍全绿（INV-30 守住——profile 仍是顶级 const）。

---

## 2. 文件结构（lasso/src/ 改动清单）

| 文件 | 改动类型 | 改动量 | 说明 |
|---|---|---|---|
| `src/browse/stealth-profiles.ts` | 增强（INV-30 顶级 const） | ~+300 行 | StealthProfile 接口加 header 集；STEALTH_PROFILES UA 升 Chrome 130+；STEALTH_INJECTION_SCRIPT 从 4 路→16 路（vendored from puppeteer-extra-plugin-stealth@2.11.2, MIT） |
| `src/browse/StealthEngine.ts` | 增强 | ~+50 行 | injectProfile 加 header 注入路径（若 chrome-devtools-mcp 暴露 setExtraHTTPHeaders）+ UA client hints 注入 |
| `src/channels/HeadlessChannel.ts` | **P0 核心修复** | ~+20 行 | override beforeNavigate 调 StealthEngine.injectProfile（仿 BrowserbaseChannel.ts:211-221 范式）+ spec args 补 viewport/timezone/UA flag |
| `src/subprocess/SubprocessManager.ts` | 不改 | 0 行 | flag 在 channel registerSpec 里加（HeadlessChannel 构造），SubprocessManager 纯 lifecycle 不动（INV-7 守） |
| `src/browse/stealth-evasions/` | **新建目录** | ~6 文件 | vendor 自 puppeteer-extra-plugin-stealth 的 navigator.plugins（含 data.json）/ chrome.runtime / webgl.vendor / media.codecs / iframe.contentWindow / window.outerdimensions 等复杂 evasion 的 JS payload（顶级 const 数据，INV-30） |
| `test/unit/stealth-engine.spec.ts` | 增强 | ~+200 行 | 16 路 evasion 覆盖率断言 + header 一致性单测 |
| `test/unit/stealth-profiles.spec.ts` | 增强 | ~+100 行 | UA+sec-ch-ua 一致性断言 + Chrome 130+ 版本断言 |

**零回归路径**：LoggedInChannel.ts / BrowserbaseChannel.ts / BrowseChannel.ts / DesktopChannel.ts / 全部 search channel / Rust helper 一行不动。

---

## 3. 各模块实施细节

### 3.1 StealthEngine 增强（4 路→16 路 JS evasions）

#### 现状（stealth-profiles.ts:112-145，4 路）
1. navigator.webdriver → undefined
2. navigator.languages → ['en-US', 'en']
3. window.chrome → { runtime: {} }（极简版）
4. navigator.permissions.query → Notification 不被拒

#### 目标 16 路（port 自 puppeteer-extra-plugin-stealth，每路引源文件证据）

| # | evasion | puppeteer-extra 源文件 | Lasso 现状 | port 要点 |
|---|---|---|---|---|
| 1 | navigator.webdriver | `evasions/navigator.webdriver/index.js` | ✅ 已有 | 保留，升级为 Object.defineProperty proxy（防 getOwnPropertyDescriptor 露馅） |
| 2 | navigator.languages | `evasions/navigator.languages/index.js` | ✅ 已有 | 保留 |
| 3 | navigator.permissions | `evasions/navigator.permissions/index.js` | ✅ 已有 | 保留 |
| 4 | chrome.runtime | `evasions/chrome.runtime/index.js`（+staticData.json） | ⚠️ 极简版 | **增强**：port 完整 chrome.runtime（sendMessage/connect mock + error 类型 + extensionId 校验 + staticData） |
| 5 | chrome.app | `evasions/chrome.app/index.js` | ❌ 缺 | port STATIC_DATA（isInstalled/InstallState/RunningState）+ getDetails/getIsInstalled/runningState mock |
| 6 | chrome.csi | `evasions/chrome.csi/index.js` | ❌ 缺 | port performance.timing 映射（onloadT/startE/pageT/tran:15） |
| 7 | chrome.loadTimes | `evasions/chrome.loadTimes/index.js` | ❌ 缺 | port protocolInfo + timingInfo（基于 PerformanceTiming API） |
| 8 | navigator.plugins | `evasions/navigator.plugins/index.js`（+data.json+plugins.js+mimeTypes.js+magicArray.js+functionMocks.js） | ❌ 缺 | **最复杂**：port 全套（5 子文件 + data.json 静态数据）；headless 默认空 plugins 是关键破绽 |
| 9 | navigator.vendor | `evasions/navigator.vendor/index.js` | ❌ 缺 | port（默认 "Google Inc."，Chrome profile 用；Firefox profile 跳过） |
| 10 | navigator.hardwareConcurrency | `evasions/navigator.hardwareConcurrency/index.js` | ❌ 缺 | port（默认 4，可配） |
| 11 | media.codecs | `evasions/media.codecs/index.js` | ❌ 缺 | port canPlayType proxy（H.264 avc1.42E01E → "probably"；audio/aac → "probably"） |
| 12 | webgl.vendor | `evasions/webgl.vendor/index.js` | ❌ 缺 | port getParameter proxy（UNMASKED_VENDOR_WEBGL=37445 → "Intel Inc."；UNMASKED_RENDERER_WEBGL=37446 → "Intel Iris OpenGL Engine"） |
| 13 | iframe.contentWindow | `evasions/iframe.contentWindow/index.js` | ❌ 缺 | port document.createElement proxy + srcdoc 拦截 + contentWindow proxy（修 HEADCHR_IFRAME 检测） |
| 14 | window.outerdimensions | `evasions/window.outerdimensions/index.js` | ❌ 缺 | port（outerWidth=innerWidth；outerHeight=innerHeight+85） |
| 15 | user-agent-override | `evasions/user-agent-override/index.js` | ⚠️ 部分（只改 navigator.userAgent） | **增强**：port UA client hints 逻辑（_getBrands 按 Chrome 版本 seed %6 排序 + _getPlatform + userAgentMetadata）—— 但 Lasso 走 evaluate_script 不走 CDP Network.setUserAgentOverride（chrome-devtools-mcp 0.3.0 不暴露此工具），需 reimplement 为 JS 注入 |
| 16 | defaultArgs + sourceurl | `evasions/defaultArgs/index.js` + `evasions/sourceurl/index.js` | ❌ 缺 | **部分适用**：defaultArgs 移除 --disable-extensions 等 flag（→ §3.3 SubprocessManager flag）；sourceurl 剥离 sourceURL（chrome-devtools-mcp 内部 CDP 调用不暴露，**此路 N/A**——Lasso 不直接管 CDP Runtime.evaluate） |

#### 实施方式
**不引入 puppeteer-extra 运行时依赖**（它是 Puppeteer plugin 架构，与 Lasso McpClient 不兼容）。用 extract-stealth-evasions 思路：把每路 evasion 的 `evaluateOnNewDocument(utils => {...})` 回调体提取为独立 JS 字符串，合并进 STEALTH_INJECTION_SCRIPT 顶级 const。

复杂 evasion（navigator.plugins 需 5 子文件 + data.json）拆到 `src/browse/stealth-evasions/` 子目录，每个一个 `.ts` 文件 export 顶级 const 字符串。

```typescript
// stealth-profiles.ts 增强后结构（伪码）
import { CHROME_APP_SCRIPT } from "./stealth-evasions/chrome-app.js";
import { CHROME_RUNTIME_SCRIPT } from "./stealth-evasions/chrome-runtime.js";
// ... 12 路 import

export const STEALTH_INJECTION_SCRIPT = [
  CORE_4_ROAD_SCRIPT,           // 现有 4 路（保留）
  CHROME_APP_SCRIPT,            // 新增路 5
  CHROME_CSI_SCRIPT,            // 新增路 6
  CHROME_LOADTIMES_SCRIPT,      // 新增路 7
  CHROME_RUNTIME_FULL_SCRIPT,   // 新增路 8（增强现有 chrome.runtime）
  NAVIGATOR_PLUGINS_SCRIPT,     // 新增路 9
  NAVIGATOR_VENDOR_SCRIPT,      // 新增路 10
  HARDWARE_CONCURRENCY_SCRIPT,  // 新增路 11
  MEDIA_CODECS_SCRIPT,          // 新增路 12
  WEBGL_VENDOR_SCRIPT,          // 新增路 13
  IFRAME_CONTENTWINDOW_SCRIPT,  // 新增路 14
  OUTER_DIMENSIONS_SCRIPT,      // 新增路 15
  UA_CLIENT_HINTS_SCRIPT,       // 新增路 16
].join("\n");
```

**license 守**：每个 vendored 文件头部加 `// Vendored from puppeteer-extra-plugin-stealth@2.11.2 (MIT), Copyright (c) berstend`。

### 3.2 stealth-profiles 增强（UA Chrome 120→130+ + header 集）

#### 现状（stealth-profiles.ts:34-80）
- StealthProfile 接口只有 5 字段：userAgent / viewport / timezone / language / platform
- 3 硬编码 profile：Chrome 120 / Safari 17 / Firefox 121

#### 目标
**方案 A（推荐，v1.5 MVP）**：手工升级 UA 版本 + 手工补 header 字段
```typescript
export interface StealthProfile {
  userAgent: string;
  viewport: { width: number; height: number };
  timezone: string;
  language: string;
  platform: string;
  // v1.5 新增 header 集（从 header-generator README result example 借鉴 schema）
  secChUa: string;              // `"Google Chrome";v="130", "Chromium";v="130", "Not?A_Brand";v="99"`
  secChUaMobile: string;        // "?0"
  secChUaPlatform: string;      // `"Windows"`
  accept: string;               // "text/html,application/xhtml+xml,..."
  acceptEncoding: string;       // "gzip, deflate, br"
  acceptLanguage: string;       // "en-US,en;q=0.9"
  secFetchSite: string;         // "same-site"（doc/16 §4 header-generator 注：navigate 首请求填 same-site）
  secFetchMode: string;         // "navigate"
  secFetchUser: string;         // "?1"
  secFetchDest: string;         // "document"
  upgradeInsecureRequests: string; // "1"
}
```
STEALTH_PROFILES 升到 Chrome 130 / Safari 17.5 / Firefox 130。

**方案 B（v1.6+ 评估）**：npm i header-generator（Apache 2.0），启动期 `new HeaderGenerator(PRESETS.MODERN_WINDOWS_CHROME).getHeaders()` 算一次。
- HeaderGenerator API（读 `packages/header-generator/src/header-generator.ts` 确认）：构造接 `HeaderGeneratorOptions{browsers, operatingSystems, devices, locales, httpVersion}`；`.getHeaders(options, requestDependentHeaders)` 返回 `Record<string,string>` 完整 header 集（含 UA + sec-ch-ua + sec-fetch-* + accept-* + upgrade-insecure-requests，且按浏览器类型排序）。
- **v1.5 MVP 不走此路**（见 §4 不明确点 2：header 怎么注入未解）。

#### 关键约束
header 字段是**顶级 const 数据**（INV-30 守——不从 config/env 读，防 LLM 通过 channel 改 env 绕过 stealth）。

### 3.3 SubprocessManager chrome 启动 args（patchright flag 借鉴）

#### patchright flag（读 patchright README "Command Flags Leaks" 段 + patchright_nodejs_patch.js 确认）
| flag | patchright 操作 | Lasso 操作 |
|---|---|---|
| `--disable-blink-features=AutomationControlled` | 添加 | **添加**（HeadlessChannel spec args） |
| `--enable-automation` | 移除 | **确认 chrome-devtools-mcp 是否默认加**（见 §4 不明确点 3） |
| `--disable-popup-blocking` | 移除 | v1.5 不动（影响 popup 交互语义） |
| `--disable-component-update` | 移除 | v1.5 不动 |
| `--disable-default-apps` | 移除 | v1.5 不动 |
| `--disable-extensions` | 移除 | v1.5 不动（headless --isolated 本就无扩展） |

#### Lasso 改动点（HeadlessChannel.ts:24-32）
**现状**：
```typescript
subproc.registerSpec("headless", {
  command: "npx",
  args: ["-y", `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`, "--headless", "--isolated"],
  mcpClientName: "lasso-browse-headless",
});
```
**v1.5 增强**（加 Chromium flag + 激活 profile 死字段 viewport/timezone/UA）：
```typescript
subproc.registerSpec("headless", {
  command: "npx",
  args: [
    "-y", `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
    "--headless", "--isolated",
    // v1.5 patchright flag 借鉴（Apache-2.0 思路）
    "--disable-blink-features=AutomationControlled",
    // profile 死字段激活（doc/16 §1.3 P1 "viewport/timezone 未真注入"）
    "--user-agent=" + DEFAULT_PROFILE.userAgent,   // ⚠ 见 §4 不明确点 3
    "--window-size=1920,1080",
  ],
  mcpClientName: "lasso-browse-headless",
});
```

**SubprocessManager.ts 不改**——flag 在 channel registerSpec 里加，SubprocessManager 纯 lifecycle 不动（INV-7 守）。defaultArgs evasion（puppeteer-extra 的 `--disable-extensions` 等移除）在这里体现。

### 3.4 HeadlessChannel 接入 StealthEngine（P0 核心修复）

#### 现状
HeadlessChannel.ts 全文 38 行，不 import StealthEngine，不 override beforeNavigate。BrowseChannel.ts:127-129 beforeNavigate 默认 no-op。→ browse_headless 零 stealth 注入。

#### 修复（仿 BrowserbaseChannel.ts:211-221 范式）
```typescript
// HeadlessChannel.ts v1.5
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";
import { StealthEngine } from "../browse/StealthEngine.js";
import type { StealthProfileName } from "../browse/stealth-profiles.js";
import { logger } from "../util/logger.js";

export class HeadlessChannel extends BrowseChannel {
  readonly name = "browse_headless";

  constructor(
    private readonly subproc: SubprocessManager,
    private readonly stealth: StealthEngine,
    private readonly profileName: StealthProfileName = "windows_chrome_130",
  ) {
    super();
    subproc.registerSpec("headless", { /* §3.3 增强后 args */ });
  }

  protected async getMcpClient(): Promise<McpClient> {
    return this.subproc.ensureRunning("headless");
  }

  // P0 核心修复：override beforeNavigate 调 StealthEngine（仿 BrowserbaseChannel.ts:211-221）
  protected override async beforeNavigate(client: McpClient): Promise<void> {
    try {
      await this.stealth.injectProfile(client, this.profileName);
    } catch (e) {
      logger.warn({ evt: "headless_stealth_inject_failed", profile: this.profileName, error: String(e) });
    }
  }
}
```

**零回归保证**：LoggedInChannel 不 override beforeNavigate（BrowseChannel.ts:121-122 注释：「LoggedInChannel 默认不 override——复用本机 Chrome 已天然反检测」），v1.5 仍如此。只有 HeadlessChannel 新增 override。

**index.ts 装配段**改 1 行：`new HeadlessChannel(subproc)` → `new HeadlessChannel(subproc, stealth, "windows_chrome_130")`。

---

## 4. 不明确点调研结论

### 4.1 16 路每路具体 JS 脚本（已解）
全部读完 puppeteer-extra-plugin-stealth/evasions/ 下 17 个子目录的 index.js 源码（见 §3.1 表）。每路的核心 JS payload 是 `evaluateOnNewDocument(utils => {...})` 的回调体，可提取为独立 JS 字符串 port 进 Lasso。

**复杂度分级**：
- 简单（~10 行 JS）：navigator.vendor / hardwareConcurrency / window.outerdimensions / navigator.webdriver（现有）
- 中等（~30-50 行）：chrome.app / chrome.csi / media.codecs / webgl.vendor / user-agent-override（UA hints 逻辑）
- 复杂（~100+ 行 + 静态数据）：chrome.runtime（+staticData.json）/ chrome.loadTimes / navigator.plugins（5 子文件 + data.json）/ iframe.contentWindow（proxy 链）

### 4.2 header-generator 怎么集成是 JS 包还是 reimplement（已解）
**结论**：header-generator 是**纯 TS npm 包**（读 `packages/header-generator/package.json` + src 确认），`npm i header-generator` 即用。构造 `new HeaderGenerator(options)`，调 `.getHeaders()` 返回 `Record<string,string>`。

**但 v1.5 MVP 走方案 A（手工补 header 字段）不走方案 B（npm 依赖 header-generator）**，原因：
1. header-generator 依赖 `data_files/` 目录（headers-order.json + browser-helper-file.json + input-network-definition.zip + header-network-definition.zip，~数 MB），增加 Lasso 包体积
2. header-generator 内部用贝叶斯网络随机生成（每次调 getHeaders 结果不同），与 Lasso「顶级 const 固定 profile」（INV-30 anti-gaming）哲学有张力
3. 更关键的架构障碍见 4.3

### 4.3 patchright flag 怎么过 chrome-devtools-mcp 传参（部分解，需 spike）
**patchright 的核心价值在 Lasso 架构下无法直接移植**：patchright 是 Playwright 的 patch（Runtime.enable leak / Console.enable leak / isolated ExecutionContext / Init Script via Routes），这些 patch 的是 Playwright **内部 CDP 调用方式**。Lasso 用 chrome-devtools-mcp@0.3.0（自己管理 CDP 连接），Lasso 只通过 MCP tool 调用（evaluate_script / navigate_page 等），**够不到 chrome-devtools-mcp 内部的 CDP 调用层**。

**可移植部分**：只有 Chromium **启动 flag**（`--disable-blink-features=AutomationControlled` 等）——这些是 Chromium 进程参数，只要 chrome-devtools-mcp 透传给底层 Chromium 即可。

**必须 spike 的不明确点**：chrome-devtools-mcp@0.3.0 是否接受任意 Chromium flag 透传？HeadlessChannel 现有 args 是 `["chrome-devtools-mcp@0.3.0", "--headless", "--isolated"]`——`--headless` 和 `--isolated` 是 chrome-devtools-mcp 自己的 flag。若直接加 `--disable-blink-features=AutomationControlled`，chrome-devtools-mcp 可能不认识（它是 chrome-devtools-mcp 的 argv，不是 Chromium 的 argv）。

**Spike 动作**（实施前必须做）：
1. 查 chrome-devtools-mcp@0.3.0 文档/源码，确认是否有 `--chrome-arg=...` 或 `--extra-arg=...` 透传机制
2. 若无透传机制：`--disable-blink-features=AutomationControlled` 无法通过 chrome-devtools-mcp 注入 → 此路降级为只走 JS evasion（navigator.webdriver override 的效果等价，但不如 flag 级彻底）
3. 若有透传机制：flag 照常加

**同理 `--user-agent=` flag 也需此 spike**——chrome-devtools-mcp 是否有 `--user-agent` 透传。

### 4.4 HeadlessChannel 接 stealth 是否破坏 chrome-devtools-mcp --isolated 契约（已解，不破坏）
**不破坏**。StealthEngine.injectProfile 只调 `client.callTool("evaluate_script", {function: script})`（StealthEngine.ts:165）——这是 chrome-devtools-mcp 的标准 MCP tool 调用，与 `--isolated`（隔离的浏览器实例，无持久 state）正交。BrowserbaseChannel 已验证此范式（BrowserbaseChannel.ts:211-221 beforeNavigate 调 stealth.injectProfile，cloud 通道也用 --browser-url 连 chrome-devtools-mcp，同样隔离）。

### 4.5 HTTP header 怎么注入（未完全解，架构障碍）
**关键约束**：HTTP request header（sec-ch-ua / sec-fetch-* / accept-*）**不能通过 evaluate_script 注入**——JS 只能改 navigator 属性，不能改浏览器网络层的 HTTP header。要设置 HTTP header 需要：
1. CDP `Network.setExtraHTTPHeaders`——**chrome-devtools-mcp@0.3.0 是否暴露此工具？需 spike**
2. Chromium 启动 flag——只 `--user-agent` 可设 UA，sec-ch-ua 不可由 flag 设
3. header-generator 的 value pre-compute + 走 chrome-devtools-mcp 的某个 header 设置工具（若存在）

**v1.5 MVP 策略**：
- header 集**先定义在 StealthProfile 顶级 const**（守 INV-30），但**运行时注入路径暂走 evaluate_script 改 navigator.userAgentData**（sec-ch-ua 的 JS 侧等价——`navigator.userAgentData.brands` 是 sec-ch-ua 的 JS API 投影）
- HTTP 网络层的 sec-ch-ua header 注入**列为 §4 spike 依赖项**——若 chrome-devtools-mcp 不暴露 setExtraHTTPHeaders，v1.5 只能做到 JS 侧 userAgentData 一致（HTTP header 侧仍裸奔，但比现状好——至少 JS 检测过）

**user-agent-override evasion 的 UA client hints 逻辑**（§3.1 路 15）正是补这个：port `_getBrands()` 逻辑，注入 `navigator.userAgentData = { brands, fullVersion, platform, ... }`，使 JS 侧 userAgentData 与 UA 字符串一致。

---

## 5. 测试计划（参照架构想法/03 §2 五阶段）

### 5.1 单元测试（03 §2.1，SMALL）
- **16 路 evasion 覆盖率断言**：每路 evasion 的 JS payload 在 headless Chrome evaluate 后，断言对应 navigator/window 属性值正确（webdriver=undefined / plugins.length>0 / hardwareConcurrency=4 / webgl vendor="Intel Inc." / media.codecs canPlayType("video/mp4;codecs=avc1.42E01E")="probably" / ...）
- **UA + sec-ch-ua 一致性断言**：navigator.userAgent 的 Chrome 版本 == navigator.userAgentData.brands 的版本 == secChUa 字段的版本
- **UA 版本断言**：STEALTH_PROFILES 所有 profile 的 UA Chrome >= 130 / Firefox >= 130 / Safari >= 17
- **INV-30 守护断言**：STEALTH_PROFILES 是 `as const satisfies Record<string, StealthProfile>`（编译期不可变）
- **mutation testing**（03 §2.1 项 4）：在 stealth-profiles.ts 上注入 mutants（改 UA 版本 / 删一路 evasion），准出门槛 ≥80%

### 5.2 集成测试（03 §2.1，MEDIUM）
- **HeadlessChannel beforeNavigate 接通**：mock McpClient，验证 navigate action 前调了 stealth.injectProfile（BrowseChannel.wrapNavigate 路径）
- **chrome-devtools-mcp flag 透传契约**（依赖 §4.3 spike）：若 spike 确认透传，断言 spec args 含 `--disable-blink-features=AutomationControlled`
- **producer 契约同步测试**（03 §2.2 项 4）：钉 STEALTH_PROFILES 的 header 字段集合 fixture，断言 StealthEngine.injectProfile 读取的每个字段都在

### 5.3 集成冒烟测试（03 §2.3，LARGE）
- **sannysoft 基准**：browse_headless 访问 `bot.sannysoft.com`，take_snapshot 解析检测表格，断言关键检测点全绿（webdriver / chrome / plugins / languages / webgl / permissions）
- **creepjs 基准**（v1.7 正式集成，v1.5 手测）：browse_headless 访问 `abrahamjuliot.github.io/creepjs`，人工检查 lies 数量比 v1.4 减少
- **真实站点冒烟**（至少 3 个公开页）：Wikipedia / GitHub / HackerNews —— 断言不被基础 bot 检测挡（outcome=worked 非 didnt）

### 5.4 性能测试（03 §2.4）
- 16 路 evasion 注入的 latency 基准（evaluate_script 耗时）—— 应 <100ms（一次性注入，navigate 前一次）
- StealthProfile 初始化（若走 header-generator）的冷启动开销

### 5.5 不新增 Rust 测试
stealth 全在 TS 层，179 Rust `#[test]` 零影响。

---

## 6. 验收标准

### 6.1 白盒验收（doc/16 §7.2 + 03 §1）
| 标准 | 验证方式 |
|---|---|
| HeadlessChannel override beforeNavigate 调 StealthEngine | grep HeadlessChannel.ts 含 `stealth.injectProfile` + 集成测试断言 |
| 16 路 evasions 全注入 | STEALTH_INJECTION_SCRIPT 含 16 段（单测遍历断言每路 evaluate 后属性正确） |
| UA Chrome 130+ | STEALTH_PROFILES 单测断言版本 |
| UA + sec-ch-ua 一致 | 单测断言 UA 版本 == userAgentData.brands 版本 == secChUa 版本 |
| `--disable-blink-features=AutomationControlled` 生效（若 §4.3 spike 通过） | spec args 含此 flag + 真机 sannysoft navigator.webdriver=false |
| 72 INV 全绿 | `node src/invariants/check-invariants.mjs` |
| 1511 TS + 179 Rust 零回归 | `npx vitest run` + `cargo test` |

### 6.2 黑盒验收（doc/16 §7.2）
- browse_headless 访问 bot.sannysoft.com 通过基础检测
- doctor --stealth-check 返回 header 一致性 + 16 路注入覆盖率（v1.5 手测，v1.7 自动化）

---

## 7. 风险 + 实施顺序

### 7.1 风险登记
| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-V15-1 | chrome-devtools-mcp@0.3.0 不透传 Chromium flag（§4.3） | 中 | 中 | spike 先行；不透传则降级只走 JS evasion（效果略弱但可用） |
| R-V15-2 | chrome-devtools-mcp@0.3.0 不暴露 setExtraHTTPHeaders（§4.5） | 高 | 中 | v1.5 只做 JS 侧 userAgentData 一致；HTTP header 侧 sec-ch-ua 列已知短板 |
| R-V15-3 | puppeteer-extra-plugin-stealth 停更（2023.3），evasion 过时 | 中 | 低 | vendor 后标版本 + 定期跟版；creepjs 回归门禁（v1.7）持续监控 |
| R-V15-4 | navigator.plugins port 复杂（5 子文件 + data.json ~数百行） | 已知 | 低 | 拆到 stealth-evasions/ 子目录独立文件，不影响核心路径 |
| R-V15-5 | Camoufox 论证 JS stealth 结构性上限（worker/toString 露馅） | 已知 | 中 | doc/16 §4 已承认；v1.5 定位是过基础检测非企业级反爬；强反爬走 browse_logged_in |
| R-V15-6 | header-generator npm 依赖增包体积 | 低 | 低 | v1.5 MVP 走方案 A（手工 header），不走方案 B |

### 7.2 实施顺序（依赖关系驱动）
```
Step 0 (spike, 0.5d)：验证 chrome-devtools-mcp@0.3.0 flag 透传 + setExtraHTTPHeaders 暴露情况
  ↓ （决定 §3.3 flag 路径 + §4.5 header 注入路径）
Step 1 (1d)：stealth-profiles.ts StealthProfile 接口加 header 字段 + UA 升 Chrome 130+
  ↓
Step 2 (2d)：stealth-evasions/ 子目录 port 12 路（简单→复杂顺序）
  ↓
Step 3 (0.5d)：STEALTH_INJECTION_SCRIPT 合并 16 路 + StealthEngine.injectProfile 调用路径不变
  ↓
Step 4 (0.5d)：HeadlessChannel override beforeNavigate（§3.4 P0 核心修复）+ spec args 加 flag
  ↓
Step 5 (1d)：单测 + 集成测试 + sannysoft 冒烟
  ↓
Step 6 (0.5d)：72 INV 检查 + 全回归（1511 TS + 179 Rust）
```
**总工作量**：~5-6 天（含 spike + 测试），不含 creepjs 门禁（v1.7）。

---

## 8. 03 审查预设（本 parse 预判后续审查会查什么）

### 8.1 §1.1 代码规范
- ✅ vendored evasion 文件头 license 注释完整（每文件 `// Vendored from puppeteer-extra-plugin-stealth@2.11.2, MIT`）
- ✅ 新术语（secChUa / userAgentData）在命名表有一致对应

### 8.2 §1.2 数据逻辑（producer 契约）
- 🔴 **stealth profile 字段一致性**：StealthProfile 的 userAgent 版本必须与 secChUa 版本与 userAgentData.brands 版本**三方一致**——这是本 feature 的核心契约。审查会查：profile 顶级 const 里这 3 处版本号是否对齐（值级 trace）。**预设通过策略**：单测断言三方版本一致 + 加 ESLint 自定义规则或 codegen 保障。
- 🟡 **chrome-devtools-mcp evaluate_script 返回值契约**：StealthEngine.detectCloudflareChallenge 依赖 evaluate 返 "true"/"false" 字符串（StealthEngine.ts:113-116）——这是已验证的 v1.4 契约，v1.5 不改此路径。

### 8.3 §1.3 业务逻辑
- 🟡 stealth 失败不阻断 browse（StealthEngine.ts:159-174 evaluate helper 只 warn 不抛）——v1.5 保持此 best-effort 语义，16 路 evasion 每路独立 try/catch

### 8.4 §1.4 端到端接通
- 🔴 **值级 trace**：HeadlessChannel.browse(url, "navigate") → wrapNavigate → beforeNavigate → stealth.injectProfile(client, profile) → evaluate_script(STEALTH_INJECTION_SCRIPT 16 段) → navigate_page。审查会查：beforeNavigate 真的被 wrapNavigate 调到了（BrowseChannel.ts:135-140 已验证路径）+ 16 段 script 真的被 evaluate 了。
- 🔴 **chrome-devtools-mcp flag 透传 producer 契约**（§4.3 spike 依赖）：若 spike 确认透传机制存在，审查会查 L1 证据（chrome-devtools-mcp 源码/文档）证明 `--disable-blink-features=AutomationControlled` 真的传到了 Chromium 进程。**这是典型的宿主平台契约**（03 §1.2 项 8）——deferred-Spike = 未验证 = ship 前必须补 L3 真机证据。

### 8.5 §1.5 性能 + 生产就绪
- 🟡 16 路 evasion evaluate 的 latency 基准（应 <100ms，一次性注入）
- 🔴 **生产就绪闸门**：feature flag / disable switch（HeadlessChannel 的 stealth 可通过 profileName 或构造参数关闭）；rollback path（revert HeadlessChannel 到不 override beforeNavigate 即回到 v1.4 行为）

### 8.6 §1.6 简单架构
- ✅ **R-CI-02 不破坏**：全部是既有 StealthEngine / stealth-profiles / HeadlessChannel 的内部增强，不新增 channel、不新增 fallback 范式、不新增 extraction runtime
- ✅ **INV-30 守住**：profile 仍是顶级 const（`as const satisfies`），header-generator 不从 config/env 读
- ✅ **INV-7 守住**：SubprocessManager 纯 lifecycle 不动，flag 在 channel registerSpec 里加
- 🟡 **stealth-evasions/ 子目录不过工程化**：每路 evasion 一个文件是因为 puppeteer-extra 原本就是如此拆分（navigator.plugins 需 5 子文件），非为假想未来——是 vendored 既有复杂度

### 8.7 §1.7 冗余与废弃
- 🔴 **死字段激活**：doc/16 §1.3 P1「viewport/timezone 在 profile 里定义但未真注入」——v1.5 spec args 补 `--window-size` 激活 viewport 死字段（timezone 需 chrome-devtools-mcp 支持 `--timezone` flag，列 §4 spike 依赖）
- 🔴 **vendored 代码标版本**：stealth-evasions/ 每文件头标 `@2.11.2` 版本，防 stale

### 8.8 §2 测试五阶段
- §2.1 单测：16 路 evasion 每路 mutation testing ≥80%
- §2.2 集成：HeadlessChannel beforeNavigate 接通 + producer 契约同步
- §2.3 冒烟：sannysoft 基准 + 至少 3 真实站点
- §2.4 性能：evasion 注入 latency 基准

---

**关键文件路径汇总**（均绝对路径）：
- 改动：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/browse/StealthEngine.ts` / `stealth-profiles.ts`
- 改动：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/channels/HeadlessChannel.ts`
- 新建：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/browse/stealth-evasions/`（12 路 vendored JS payload）
- 参考（不改）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/channels/BrowserbaseChannel.ts`（beforeNavigate 范式 line 211-221）/ `BrowseChannel.ts`（wrapNavigate line 135-140）/ `SubprocessManager.ts`（INV-7 纯 lifecycle）
- 测试（增强）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/test/unit/stealth-engine.spec.ts` / `stealth-profiles.spec.ts`
- 借鉴源证据：`berstend/puppeteer-extra` 17 个 evasion 子目录源码 + `apify/fingerprint-suite` packages/header-generator/src/ + `Kaliiiiiiiiii-Vinyzu/patchright` README "Command Flags Leaks"