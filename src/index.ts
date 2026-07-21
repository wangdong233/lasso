#!/usr/bin/env node
/**
 * Lasso MCP server 入口（parse1 §3.15 + §7.2 Phase D 接线完成 + parse5 §3.2 M0.4c cloud 浏览器条件装配）
 *
 * 启动模式：
 *  1. `lasso-mcp doctor` —— 运行 runDoctor + 打印 JSON + exit (ready ? 0 : 1)
 *  2. `lasso-mcp`        —— MCP stdio server（CC 默认模式）
 *
 * Phase D 接线：
 *  - SubprocessManager（spawn chrome-devtools-mcp，zombie reaper）
 *  - 3 channels：SearchChannel（智谱 streamable-http）/ HeadlessChannel / LoggedInChannel
 *  - FallbackDecider + 3 CircuitBreaker（per-channel 60s 短熔断）
 *  - SSRF allowRanges（loadSsrfConfig）
 *  - 4 tools：search / browse_headless / browse_logged_in / doctor
 *  - SIGTERM/SIGINT → subproc.shutdown()
 *
 * v0.3.5（parse4）：+ DesktopChannel（4-tier ax/appleScript/cgEvent/screenshotVlm）
 * v0.4 M0.4a（parse5 §3.1）：+ forest 调度层（interact_roots/observe/act 3 工具）+ PolicyGate 占位
 * v0.4 M0.4b（parse5 §3.5）：+ appleScript/cgEvent 2 档 provider（4-tier 解 INV-22）
 * v0.4 M0.4c（parse5 §3.2 + §3.4，本提交）：
 *  - **条件装配** cloud 浏览器（BrowserbaseChannel + StagehandChannel）
 *  - 仅当 `LASSO_ALLOW_CLOUD_BROWSER=true` AND (BROWSERBASE_API_KEY 或 STAGEHAND_API_KEY) 存在时实例化
 *  - 注册 browserbase tool + PolicyGate 注入 FallbackDecider
 *  - **默认 OFF**（无 env 时 cloud 通道完全不注册，行为等价 M0.4b；零回归承诺）
 *
 * 架构不变量（INV-1..30）由 src/invariants/check-invariants.mjs 守；
 * ToolAnnotations 完整（INV-5）由 tools/*.ts 注册时携带。
 *
 * 权威：../doc/08-media-interact-功能架构.md
 * 实施：../doc/parse/parse1.md (v0.1) + parse2.md (v0.2) + parse3.md (v0.3) +
 *       parse4.md (v0.3.5) + parse5.md (v0.4)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/config.js";
import { logger } from "./util/logger.js";
import { newRunId } from "./util/run-id.js";
import { setStateStoreContext } from "./util/state-store.js";
import { SubprocessManager } from "./subprocess/SubprocessManager.js";
import { RustBridge } from "./subprocess/RustBridge.js";
import { SearchChannel } from "./channels/SearchChannel.js";
import { BraveChannel } from "./channels/BraveChannel.js";
import { HeadlessChannel } from "./channels/HeadlessChannel.js";
import { LoggedInChannel } from "./channels/LoggedInChannel.js";
import { DesktopChannel } from "./channels/DesktopChannel.js";
import { AxProvider } from "./desktop/AxProvider.js";
import { ScreenshotVlmProvider } from "./desktop/ScreenshotVlmProvider.js";
import { AppleScriptProvider } from "./desktop/AppleScriptProvider.js";
import { CGEventProvider } from "./desktop/CGEventProvider.js";
// v0.4 M0.4c：cloud 浏览器通道（条件装配，默认 OFF）
import { BrowserbaseChannel } from "./channels/BrowserbaseChannel.js";
import { StagehandChannel } from "./channels/StagehandChannel.js";
import { StealthEngine } from "./browse/StealthEngine.js";
import { PolicyGate } from "./fallback/PolicyGate.js";
import { FallbackDecider } from "./fallback/FallbackDecider.js";
import { CircuitBreaker } from "./fallback/CircuitBreaker.js";
import { loadSsrfConfig } from "./ssrf/ssrf-guard.js";
import { runDoctor } from "./doctor/doctor.js";
import { registerSearchTool } from "./tools/search.js";
import { registerBrowseTools } from "./tools/browse.js";
import { registerBrowserbaseTool } from "./tools/browserbase.js";
import { registerDoctorTool } from "./tools/doctor-tool.js";
import { registerDesktopTool } from "./tools/desktop.js";
import { registerInteractTools } from "./tools/interact.js";
// v0.5 M0.5a：fetch_url 独立工具（parse6 §3.1，TS-only 增量，零回归）
import { registerFetchUrlTool } from "./tools/fetch-url.js";
// v0.5 M0.5b：screenshot + pdf 独立工具（parse6 §3.2 + §3.3，TS-only 增量，零回归）
// INV-33 守：screenshot 走既有 v0.1 dispatch entry；pdf/console 新增 entry（cdp-actions.ts doPdf/doConsole）
// INV-34 守：screenshot 经 BrowseChannel.browse() 隐式 writeState；pdf 显式 applyOutputEnvelope(text, hint, ".pdf")
import { registerScreenshotTool } from "./tools/screenshot.js";
import { registerPdfTool } from "./tools/pdf.js";
// v0.5 M0.5c：network 独立工具（parse6 §3.4，TS-only 增量，零回归）
// INV-33 守：network 走新加 dispatch entry（cdp-actions.ts doNetwork = evaluate_script 注入 PerformanceObserver）
// INV-34 守：network 显式 applyOutputEnvelope(jsonString, hint, ".txt")；资源列表过 envelope
import { registerNetworkTool } from "./tools/network.js";
import { SearchCache } from "./search/SearchCache.js";
import { RootRegistry } from "./forest/RootRegistry.js";
import { InteractDispatcher } from "./forest/InteractDispatcher.js";
import type { BraveChannel as BraveChannelType } from "./channels/BraveChannel.js";
import type { BrowseExec } from "./serp/extract.js";
// v0.6 M0.6 接线（parse7 §3 + §6）—— runtime 能力袋 + admin tool
// 守 INV-35：runtime/ 调度层不 import BrowseChannel/DesktopChannel internal（类比 INV-26）
// 守 INV-37：admin tool 必经 toolManager.register（不直调 server.tool）—— registerAdminTool 内自含
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CapabilityBag } from "./runtime/CapabilityBag.js";
import { ToolManager } from "./runtime/ToolManager.js";
import { CallerTierTracker, readCallerCapFromEnv } from "./runtime/CallerTierTracker.js";
import { installSighupHotReload } from "./runtime/hot-reload.js";
import { registerAdminTool } from "./tools/admin.js";

// ============================================================
// v0.3.5 常量（parse4 §3.5 装配）
// ============================================================
/**
 * Rust helper binary 默认路径（parse4 §3.1.7 + desktop-doctor-checks.ts 默认）。
 * 优先取 env LASSO_RUST_HELPER_PATH；fallback 到 codesign 输出标准路径。
 */
const DEFAULT_RUST_HELPER_PATH =
  "./rust-helper/target/release/lasso-rust-helper";

// ============================================================
// v0.4 M0.4c 常量（parse5 §3.2 + §3.4 cloud 浏览器条件装配）
// ============================================================
/**
 * Lasso server 版本（parse5 §1.3 + §6.3；v0.4 M0.4c → 0.4.0-dev）。
 * v0.5 M0.5c（parse6 §1.1 + §6 验收）：4 工具（fetch_url/screenshot/pdf/network）全装配 → 0.5.0-dev
 * v0.6 M0.6（parse7 §1.1 + §6 验收）：runtime CapabilityBag + admin tool + ToolManager
 *   + CallerTierTracker + hot-reload → 0.6.0-dev
 * 与 package.json version + doctor.ts LASSO_VERSION 三处对齐（grep 验）。
 */
const LASSO_SERVER_VERSION = "0.6.0-dev";

/**
 * cloud 浏览器双重解锁判定（parse5 §3.4 + INV-25）。
 *
 * 双重解锁 = `LASSO_ALLOW_CLOUD_BROWSER=true` manual-switch AND 至少一个 API key。
 * 任一不满足 → cloud 通道完全不注册（行为等价 M0.4b，零回归承诺）。
 *
 * @returns 双重解锁状态 + 已配置 key 的 provider 名集合（供 PolicyGate 注入）
 */
function readCloudBrowserEnv(): {
  enabled: boolean;
  browserbaseKey: string;
  stagehandKey: string;
  /** 已配置 API key 的 cloud provider 名集合（PolicyGate 双重解锁用） */
  cloudBrowserKeys: Set<string>;
  /** manual-switch 是否开（audit log 用） */
  manualSwitchOn: boolean;
} {
  const manualSwitchOn = process.env.LASSO_ALLOW_CLOUD_BROWSER === "true";
  const browserbaseKey = process.env.BROWSERBASE_API_KEY ?? "";
  const stagehandKey = process.env.STAGEHAND_API_KEY ?? "";
  const cloudBrowserKeys = new Set<string>();
  if (browserbaseKey) cloudBrowserKeys.add("browserbase");
  if (stagehandKey) cloudBrowserKeys.add("stagehand");
  // 双重解锁：manual-switch + 至少一个 API key
  const enabled = manualSwitchOn && cloudBrowserKeys.size > 0;
  return {
    enabled,
    browserbaseKey,
    stagehandKey,
    cloudBrowserKeys,
    manualSwitchOn,
  };
}

// ============================================================
// doctor CLI 模式
// ============================================================
async function runDoctorCli(): Promise<void> {
  const report = await runDoctor({
    zhipuKey: process.env.ZHIPU_API_KEY,
    zhipuEndpoint: process.env.ZHIPU_ENDPOINT,
    cdpPort: parseInt(process.env.LASSO_CDP_PORT ?? "9222", 10),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.ready ? 0 : 1);
}

// ============================================================
// MCP server 模式
// ============================================================
async function runMcpServer(): Promise<void> {
  const runId = newRunId();
  const config = loadConfig({ runId });

  // 让 state-store 知道 run_id + cache_dir（channel 写盘时用）
  setStateStoreContext({ runId, cacheDir: config.cacheDir });

  logger.info({
    evt: "lasso_start",
    run_id: runId,
    version: LASSO_SERVER_VERSION,
    zhipu_key_present: !!config.zhipuApiKey,
    brave_key_present: !!process.env.BRAVE_API_KEYS || !!process.env.BRAVE_API_KEY,
    cdp_port: config.cdpPort,
  });

  // ----- 装配 SubprocessManager + 3 channels -----
  const subproc = new SubprocessManager();
  subproc.startZombieReaper();

  const search = new SearchChannel(
    config.zhipuEndpoint,
    config.zhipuApiKey,
  );
  const headless = new HeadlessChannel(subproc);
  const logged_in = new LoggedInChannel(subproc, config.cdpPort);

  // ----- v0.2 装配 BraveChannel（若 BRAVE_API_KEYS 配置）+ SearchCache -----
  // parse2 §3.3.4 / §3.4：brave 从 registry 取 QuotaLedger（INV-10：禁直读 env），
  //                       cache 走 config.searchCacheDir。
  let brave: BraveChannelType | undefined;
  const braveProvider = config.registry.get("brave");
  if (braveProvider && braveProvider.config.endpoint_url && braveProvider.ledger) {
    brave = new BraveChannel(
      braveProvider.config.endpoint_url,
      braveProvider.ledger,
      subproc.acquireHttpClient("https://api.search.brave.com"),
    );
    logger.info({
      evt: "brave_channel_wired",
      keys: braveProvider.ledger.keyCount,
    });
  } else {
    logger.info({ evt: "brave_channel_skipped", reason: "no_keys_or_endpoint" });
  }
  const searchCache = new SearchCache(config.searchCacheDir);

  // ----- v0.3.5 装配 DesktopChannel（parse4 §3.5 + §2.3 文件依赖图）-----
  // 桌面通道 4 件套（v0.4 M0.4b 扩 4-tier）：
  //   1. subproc.registerRustSpec("rust-helper", {...})  ← spawn 规格
  //   2. new RustBridge(subproc, "rust-helper")          ← JSON-lines 协议适配
  //   3. 4 档 provider（parse5 §3.5.4）：
  //        new AxProvider(rust)              ← 第 1 档 ax
  //        new AppleScriptProvider(rust)     ← 第 2 档 appleScript（v0.4 M0.4b）
  //        new CGEventProvider(rust)         ← 第 3 档 cgEvent（v0.4 M0.4b）
  //        new ScreenshotVlmProvider(rust)   ← 第 4 档 screenshotVlm
  //   4. new DesktopChannel(rust, ax, vlm, appleScript, cgEvent, decider, breakers)
  //
  // INV-7：RustBridge 持协议帧解析；SubprocessManager 仍纯 lifecycle（既有 MCP 路径不动）。
  // INV-23/29：breakers 加 4 档 desktop.*；永不挂 browse_*。
  const rustHelperPath =
    process.env.LASSO_RUST_HELPER_PATH ?? DEFAULT_RUST_HELPER_PATH;
  subproc.registerRustSpec("rust-helper", {
    command: rustHelperPath,
    args: [],
  });
  const rustBridge = new RustBridge(subproc, "rust-helper");
  const axProvider = new AxProvider(rustBridge);
  const appleScriptProvider = new AppleScriptProvider(rustBridge);
  const cgEventProvider = new CGEventProvider(rustBridge);
  const vlmProvider = new ScreenshotVlmProvider(rustBridge, {});

  // ----- 装配 FallbackDecider（每 channel 一个 60s 短熔断器）-----
  // v0.2 加 search.brave + fanout 虚拟 channel 的 breaker（parse2 §3.3.4）
  // v0.3.5 加 desktop.ax + desktop.screenshotVlm 两档 breaker（parse4 §3.2.1）
  // v0.4 M0.4b 加 desktop.appleScript + desktop.cgEvent 两档 breaker（parse5 §3.5.4）
  // v0.4 M0.4c 加 browse_cloud.browserbase / browse_cloud.stagehand 两档 breaker（条件；parse5 §3.2）
  const breakers = new Map<string, CircuitBreaker>([
    ["search.zhipu", new CircuitBreaker()],
    ["search.brave", new CircuitBreaker()],
    ["fanout", new CircuitBreaker()],
    ["browse_headless", new CircuitBreaker()],
    ["browse_logged_in", new CircuitBreaker()],
    ["desktop.ax", new CircuitBreaker()],
    ["desktop.appleScript", new CircuitBreaker()],
    ["desktop.cgEvent", new CircuitBreaker()],
    ["desktop.screenshotVlm", new CircuitBreaker()],
  ]);

  // ----- v0.4 M0.4c cloud 浏览器条件装配（parse5 §3.2 + §3.4）-----
  // 双重解锁：LASSO_ALLOW_CLOUD_BROWSER=true AND (BROWSERBASE 或 STAGEHAND key)。
  // 默认 OFF：无 env 时 cloud 通道完全不注册，FallbackDecider 不注入 PolicyGate，
  //          行为完全等价 M0.4b（零回归承诺，parse5 §1.4 + §3.4.2）。
  const cloudEnv = readCloudBrowserEnv();
  let browserbaseChannel: BrowserbaseChannel | undefined;
  if (cloudEnv.enabled) {
    const stealth = new StealthEngine();
    if (cloudEnv.browserbaseKey) {
      browserbaseChannel = new BrowserbaseChannel(
        subproc,
        cloudEnv.browserbaseKey,
        stealth,
      );
      breakers.set("browse_cloud_browserbase", new CircuitBreaker());
      logger.info({
        evt: "cloud_browser_channel_wired",
        channel: "browse_cloud_browserbase",
        profile: "windows_chrome_120",
      });
    }
    if (cloudEnv.stagehandKey) {
      // StagehandChannel 实例化（仅装配 breaker + PolicyGate cloudBrowserKeys 集成；
      // observe-only 通道暂不挂单独 tool —— v0.5+ 若暴露 verify/extract tool 再分配局部变量）。
      new StagehandChannel(cloudEnv.stagehandKey);
      breakers.set("browse_cloud_stagehand", new CircuitBreaker());
      logger.info({
        evt: "cloud_browser_channel_wired",
        channel: "browse_cloud_stagehand",
        note: "observe-only; no standalone tool registered in v0.4",
      });
    }
  } else {
    // 默认 OFF 路径：明确日志（便于运维排查为何 cloud 通道未注册）
    logger.info({
      evt: "cloud_browser_channels_skipped",
      reason: cloudEnv.manualSwitchOn
        ? "manual_switch_on_but_no_api_key"
        : "manual_switch_off_default",
      manual_switch: cloudEnv.manualSwitchOn,
      has_browserbase_key: !!cloudEnv.browserbaseKey,
      has_stagehand_key: !!cloudEnv.stagehandKey,
    });
  }

  // ----- PolicyGate 注入（仅 cloud 通道启用时；parse5 §3.4.2）-----
  // 未注入 → runWithFallback 完全等价 v0.3.5（零回归承诺，FallbackDecider 默认 policyGate=null）
  // 注入   → cloud 通道必经 LASSO_ALLOW_CLOUD_BROWSER + API key 双重解锁 + policy_risk 三态过滤
  const policyGate = cloudEnv.enabled
    ? new PolicyGate(
        {
          allowCloudBrowser: true,
          cloudBrowserKeys: cloudEnv.cloudBrowserKeys,
        },
        config.registry,
      )
    : null;
  const decider = new FallbackDecider(breakers, policyGate);

  const desktop = new DesktopChannel(
    rustBridge,
    axProvider,
    vlmProvider,
    appleScriptProvider,
    cgEventProvider,
    decider,
    breakers,
  );

  // ----- 装配 SSRF -----
  const ssrfConfig = loadSsrfConfig();

  // ----- 跨模态 fallback 用的 browse 执行器（serpScrapeFallback 用）-----
  // 把 HeadlessChannel.browse 的 InteractResult<BrowseResult> 降形为
  // serp/extract.ts BrowseExec 期望的 { outcome, data: {preview?}, error? }。
  const browseHeadlessExec: BrowseExec = async (url) => {
    const r = await headless.browse(url, "snapshot", {});
    return {
      outcome: r.outcome,
      data: r.data ? { preview: r.data.preview } : null,
      error: r.error,
    };
  };

  // ----- MCP server + tool 注册 -----
  const server = new McpServer({
    name: "lasso-mcp",
    version: LASSO_SERVER_VERSION,
  });

  registerSearchTool(
    server,
    search,
    decider,
    browseHeadlessExec,
    brave,
    config.registry,
    searchCache,
  );
  registerBrowseTools(server, headless, logged_in, decider, ssrfConfig);
  registerDesktopTool(server, desktop, decider);
  // v0.4 M0.4c：cloud 浏览器工具条件注册（parse5 §3.2 + §6.3 #16）
  // 默认 OFF：未双重解锁时 server.listTools() 不含 browserbase（INV-25 守）
  if (browserbaseChannel) {
    registerBrowserbaseTool(server, browserbaseChannel, decider, ssrfConfig);
  }
  // v0.5 M0.5a：fetch_url 独立 HTTP 工具（parse6 §3.1）
  // 与 browse_headless 同 SSRF guard；不经浏览器、不挂 fallback 链（INV-23 衍生：caller-tier）
  registerFetchUrlTool(server, subproc, ssrfConfig);
  // v0.5 M0.5b：screenshot + pdf 独立工具（parse6 §3.2 + §3.3）
  // 经 HeadlessChannel.browse 入口（隐式享受 headless→logged_in fallback；守 INV-33）
  // screenshot 走既有 v0.1 dispatch entry（doScreenshot）；pdf 走新加 entry（doPdf from cdp-actions）
  registerScreenshotTool(server, headless, ssrfConfig);
  registerPdfTool(server, headless, ssrfConfig);
  // v0.5 M0.5c：network 独立工具（parse6 §3.4）
  // 经 HeadlessChannel.browse 入口（隐式享受 headless→logged_in fallback；守 INV-33）
  // network 走新加 entry（doNetwork from cdp-actions = evaluate_script 注入 PerformanceObserver）
  registerNetworkTool(server, headless, ssrfConfig);
  // doctor tool opts 提为命名变量（v0.6 M0.6 parse7 §2.2 + §6.2）：v0.6 接线段在装配尾部
  // 经此变量注入 runtimeState provider，让 doctor 报告含 runtime_state section（零回归：
  // runtimeState 是可选字段；未注入时行为完全等价 v0.5）。
  // 显式标 DoctorOptions 类型让 v0.6 接线段可以注入 runtimeState（无 TS narrowing 限制）。
  const doctorOpts: Parameters<typeof registerDoctorTool>[1] = {
    zhipuKey: config.zhipuApiKey,
    zhipuEndpoint: config.zhipuEndpoint,
    cdpPort: config.cdpPort,
    cacheDir: config.cacheDir,
    // v0.3.5：doctor tool 也走 desktopChecks（desktop bridge 注入；parse4 §3.4.2）
    desktopChecks: true,
    desktopBridge: rustBridge,
    desktopHelperPath: rustHelperPath,
  };
  registerDoctorTool(server, doctorOpts);

  // ----- v0.4 forest 调度层装配（parse5 §3.1.4）-----
  // forest 是 BrowseChannel + DesktopChannel **之上**的薄调度层（R-CI-02 守护）。
  // INV-24：RootRegistry 单一真源（只此一处实例化）。
  // INV-26：InteractDispatcher 持 channel class 引用（map<name, instance>），不 import internal。
  const rootRegistry = new RootRegistry();
  // 显式标注 ForestChannel 联合（HeadlessChannel + LoggedInChannel 都是 BrowseChannel 子类）
  type ForestChannel = typeof headless | typeof logged_in | typeof desktop;
  const forestChannels = new Map<string, ForestChannel>([
    [headless.name, headless as ForestChannel],
    [logged_in.name, logged_in as ForestChannel],
    [desktop.name, desktop as ForestChannel],
  ]);
  const interactDispatcher = new InteractDispatcher(rootRegistry, forestChannels);
  registerInteractTools(
    server,
    rootRegistry,
    interactDispatcher,
    [
      { source: headless.name, channel: headless },
      { source: logged_in.name, channel: logged_in },
    ],
    { source: desktop.name, channel: desktop },
  );

  // ============================================================
  // v0.6 M0.6 接线段（parse7 §3 + §6 —— runtime 能力袋 + admin tool）
  // ============================================================
  // 零回归承诺（parse7 §1.3）：
  //  - 本段加在 v0.5 装配尾部，v0.5 静态装配段一行不动
  //  - CapabilityBag 初始化所有 v0.5 channel + provider 为 enabled=true（默认全开 = v0.5 行为）
  //  - ToolManager 捕获 v0.5 RegisteredTool 句柄（非破坏性；不重注册）
  //  - bag.onChange handler 是 disable/enable 的唯一联动入口（INV-37 task v0.6）
  //  - admin tool 经 toolManager.register（INV-37 精神一致；admin 自己永不被 disable）
  // 守 INV-35：runtime/ 不 import BrowseChannel/DesktopChannel internal；
  //            channel→spec 映射是本顶级 const，不在 runtime/ 内。
  // 守 INV-37：runtime/ 禁直调 server.tool；本段在 index.ts（不在 runtime/），可访问 server。
  //
  // CHANNEL_TO_SPEC（parse7 §3.1 末尾示例）：channel 名 → subprocess spec 名。
  // null = 无本地子进程（cloud_stagehand observe-only / search.* / desktop.* provider 级）。
  // INV-35 衍生：单一映射表，不在多处散落。
  const CHANNEL_TO_SPEC: Record<string, string | null> = {
    browse_headless: "headless",
    browse_logged_in: "logged_in",
    browse_cloud_browserbase: "browserbase",
    browse_cloud_stagehand: null,
    desktop: "rust-helper", // SHARED by 4 desktop.* providers；bag handler 守 R-RT-2
  };

  // ---- 1. ToolManager + 捕获 v0.5 RegisteredTool 句柄（parse7 §3.2 captureHandle）----
  const toolManager = new ToolManager(server);
  // SDK 内部 _registeredTools 是 Record<name, RegisteredTool>；非破坏性读取（cast 是已知 escape hatch）。
  // v0.5 装配段调 register*Tool 时已注册全部 12 工具；此处仅捕获句柄让 disable 能作用到。
  // V5_TOOL_TO_CHANNEL 是 v0.5 tool → owning channel 的单一映射表（INV-35 衍生）。
  const V5_TOOL_TO_CHANNEL: Record<string, string> = {
    search: "search",
    browse_headless: "browse_headless",
    browse_logged_in: "browse_logged_in",
    browserbase: "browse_cloud_browserbase",
    desktop: "desktop",
    interact_roots: "forest",
    interact_observe: "forest",
    interact_act: "forest",
    fetch_url: "fetch",
    screenshot: "screenshot",
    pdf: "pdf",
    network: "network",
    doctor: "doctor",
  };
  const sdkRegisteredTools = (server as unknown as {
    _registeredTools: Record<string, RegisteredTool>;
  })._registeredTools;
  let capturedCount = 0;
  for (const [tname, handle] of Object.entries(sdkRegisteredTools)) {
    const channel = V5_TOOL_TO_CHANNEL[tname];
    if (channel) {
      toolManager.captureHandle(channel, tname, handle);
      capturedCount++;
    }
  }

  // ---- 2. CapabilityBag 初始化（parse7 §3.1 —— 默认全开）----
  // 列举 v0.5 已注册的所有 channel + provider 名（parse7 §3.1 命名约定：
  //   channel 无 dot；provider 有 dot 用 <cap>.<name> 形式如 "search.brave" / "desktop.ax"）。
  // INV-40：constructor 全部 enabled=true（零回归 = v0.5 默认全开行为）。
  const initialCapabilities: string[] = [
    // channels（无 dot）
    "browse_headless",
    "browse_logged_in",
    "desktop",
  ];
  if (cloudEnv.enabled && cloudEnv.browserbaseKey) {
    initialCapabilities.push("browse_cloud_browserbase");
  }
  if (cloudEnv.enabled && cloudEnv.stagehandKey) {
    initialCapabilities.push("browse_cloud_stagehand");
  }
  // search providers（dot 形式 "search.<name>"）
  initialCapabilities.push("search.zhipu");
  if (brave) {
    initialCapabilities.push("search.brave");
  }
  // desktop providers（ProviderConfig.name 已是 "desktop.<tier>" 形式）
  initialCapabilities.push(
    "desktop.ax",
    "desktop.appleScript",
    "desktop.cgEvent",
    "desktop.screenshotVlm",
  );
  const bag = new CapabilityBag(initialCapabilities);

  // ---- 3. CallerTierTracker（parse7 §3.3）----
  // INV-38：defaultCap 从 readCallerCapFromEnv（构造期一次性读 env；运行时不读）。
  const callerTier = new CallerTierTracker(readCallerCapFromEnv());

  // ---- 4. bag.onChange handler（parse7 §3.1 末尾示例 + R-RT-2 缓解）----
  // INV-37 task v0.6：channel disable 必经 ToolManager.disableChannel + SubprocessManager.shutdownOne。
  // 此 handler 是 disable/enable 联动的唯一挂载点；bag 状态变更后顺序 await。
  bag.onChange(async (name, enabled, state) => {
    if (enabled) {
      // enable 路径：仅 re-enable tools；不主动 spawn（channel 内部懒启动复用 v0.5 范式）
      await toolManager.enableChannel(name);
      return;
    }
    // disable 路径
    await toolManager.disableChannel(name);
    if (state.kind !== "channel") {
      // provider 级 disable（如 desktop.cgEvent）：不动子进程（shared；R-RT-2）
      // 由 channel 内部 fallback plan 在运行时跳过该 provider 名（v0.6 不深修 channel 内部）
      return;
    }
    const specName = CHANNEL_TO_SPEC[name];
    if (!specName) {
      // 无本地子进程（cloud_stagehand observe-only / search.* / 等）—— 仅禁工具即可
      return;
    }
    // R-RT-2 守护（parse7 §7.1）：rust-helper 被 desktop channel + 4 档 provider 共享；
    // 仅当所有 desktop.* 都 disabled 时才 kill rust-helper，避免单档 disable 误杀整 desktop。
    if (specName === "rust-helper") {
      const snap = bag.snapshot();
      const allDesktopProvidersDown = snap
        .filter((s) => s.name.startsWith("desktop."))
        .every((s) => !s.enabled);
      if (!allDesktopProvidersDown) {
        logger.info({
          evt: "desktop_shared_subprocess_preserved",
          reason: "not_all_desktop_providers_disabled",
          triggered_by: name,
        });
        return;
      }
    }
    await subproc.shutdownOne(specName);
  });

  // ---- 5. admin tool 注册（parse7 §3.5）----
  // INV-37：经 toolManager.register（不直调 server.tool）；channel="admin" 永不被 disable
  // （CapabilityBag.initial 不含 "admin" → bag.disable("admin") 返 false 不触发联动）。
  registerAdminTool({
    bag,
    toolManager,
    callerTier,
    registry: config.registry,
  });

  // ---- 5b. doctor tool opts 注入 runtimeState provider（parse7 §2.2 + §6.2）----
  // 经 doctorOpts 变量（v0.5 装配段命名捕获）注入；零回归：runtimeState 可选字段，未注入时
  // runDoctor 跳过 runtime_state section（v0.5 行为）；注入后 doctor 报告新增 section。
  // 守 INV-35：doctor.ts 不 import runtime/；此处仅注入「数据快照函数」，不传 bag/callerTier 句柄。
  doctorOpts.runtimeState = () => ({
    capabilities: bag.snapshot().map((s) => ({
      name: s.name,
      kind: s.kind,
      enabled: s.enabled,
      disabledAt: s.disabledAt,
      disabledBy: s.disabledBy,
      reason: s.reason,
    })),
    caller_caps: callerTier.snapshot(),
    tool_manager: Object.fromEntries(toolManager.listByChannel()),
  });

  // ---- 6. SIGHUP 热更新（parse7 §3.6）----
  // 默认 LASSO_PROVIDERS_FILE 未设 → installSighupHotReload 内部 no-op（零回归）。
  // 仅当运维显式 export LASSO_PROVIDERS_FILE 才安装 SIGHUP listener。
  const providersFile = process.env.LASSO_PROVIDERS_FILE ?? null;
  installSighupHotReload(config.registry, bag, toolManager, providersFile);

  logger.info({
    evt: "v0.6_runtime_wired",
    bag_size: bag.snapshot().length,
    tool_manager_size: toolManager.size(),
    captured_v5_handles: capturedCount,
    providers_file: providersFile,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ evt: "lasso_ready", run_id: runId });

  // ----- 优雅停机：SIGTERM/SIGINT 都先 shutdown 子进程再 exit -----
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return; // 防双信号竞态
    shuttingDown = true;
    logger.info({ evt: "lasso_shutdown", sig, run_id: runId });
    try {
      await subproc.shutdown();
    } catch (e) {
      logger.warn({ evt: "shutdown_error", error: String(e) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  // CLI: `lasso doctor`
  if (process.argv[2] === "doctor") {
    await runDoctorCli();
    return;
  }
  await runMcpServer();
}

main().catch((err) => {
  logger.error({ evt: "lasso_fatal", error: String(err) });
  process.exit(1);
});
