#!/usr/bin/env node
/**
 * Lasso MCP server 入口（parse1 §3.15 + §7.2 Phase D 接线完成）
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
 * 架构不变量（INV-1..8）由 src/invariants/check-invariants.mjs 守；
 * ToolAnnotations 完整（INV-5）由 tools/*.ts 注册时携带。
 *
 * 权威：../doc/08-media-interact-功能架构.md
 * 实施：../doc/parse/parse1.md
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
import { FallbackDecider } from "./fallback/FallbackDecider.js";
import { CircuitBreaker } from "./fallback/CircuitBreaker.js";
import { loadSsrfConfig } from "./ssrf/ssrf-guard.js";
import { runDoctor } from "./doctor/doctor.js";
import { registerSearchTool } from "./tools/search.js";
import { registerBrowseTools } from "./tools/browse.js";
import { registerDoctorTool } from "./tools/doctor-tool.js";
import { registerDesktopTool } from "./tools/desktop.js";
import { registerInteractTools } from "./tools/interact.js";
import { SearchCache } from "./search/SearchCache.js";
import { RootRegistry } from "./forest/RootRegistry.js";
import { InteractDispatcher } from "./forest/InteractDispatcher.js";
import type { BraveChannel as BraveChannelType } from "./channels/BraveChannel.js";
import type { BrowseExec } from "./serp/extract.js";

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
    version: "0.3.5-dev",
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
  // 桌面通道 4 件套：
  //   1. subproc.registerRustSpec("rust-helper", {...})  ← spawn 规格
  //   2. new RustBridge(subproc, "rust-helper")          ← JSON-lines 协议适配
  //   3. new AxProvider(rust) + new ScreenshotVlmProvider(rust) ← 两档 provider
  //   4. new DesktopChannel(rust, ax, vlm, decider, breakers) ← channel
  //
  // INV-7：RustBridge 持协议帧解析；SubprocessManager 仍纯 lifecycle（既有 MCP 路径不动）。
  // INV-23：breakers 加 desktop.ax + desktop.screenshotVlm 两档；永不挂 browse_*。
  const rustHelperPath =
    process.env.LASSO_RUST_HELPER_PATH ?? DEFAULT_RUST_HELPER_PATH;
  subproc.registerRustSpec("rust-helper", {
    command: rustHelperPath,
    args: [],
  });
  const rustBridge = new RustBridge(subproc, "rust-helper");
  const axProvider = new AxProvider(rustBridge);
  const vlmProvider = new ScreenshotVlmProvider(rustBridge, {});

  // ----- 装配 FallbackDecider（每 channel 一个 60s 短熔断器）-----
  // v0.2 加 search.brave + fanout 虚拟 channel 的 breaker（parse2 §3.3.4）
  // v0.3.5 加 desktop.ax + desktop.screenshotVlm 两档 breaker（parse4 §3.2.1）
  const breakers = new Map<string, CircuitBreaker>([
    ["search.zhipu", new CircuitBreaker()],
    ["search.brave", new CircuitBreaker()],
    ["fanout", new CircuitBreaker()],
    ["browse_headless", new CircuitBreaker()],
    ["browse_logged_in", new CircuitBreaker()],
    ["desktop.ax", new CircuitBreaker()],
    ["desktop.screenshotVlm", new CircuitBreaker()],
  ]);
  const decider = new FallbackDecider(breakers);

  const desktop = new DesktopChannel(
    rustBridge,
    axProvider,
    vlmProvider,
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
    version: "0.3.5-dev",
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
  registerDoctorTool(server, {
    zhipuKey: config.zhipuApiKey,
    zhipuEndpoint: config.zhipuEndpoint,
    cdpPort: config.cdpPort,
    cacheDir: config.cacheDir,
    // v0.3.5：doctor tool 也走 desktopChecks（desktop bridge 注入；parse4 §3.4.2）
    desktopChecks: true,
    desktopBridge: rustBridge,
    desktopHelperPath: rustHelperPath,
  });

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
