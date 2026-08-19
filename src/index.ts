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
 *  - 3 channels：MachineMcpSearchChannel（条件装配，智谱 MCP 复用）/ HeadlessChannel / LoggedInChannel
 *    （v1.17 A3：zhipu 直连 SearchChannel 已删——INV-80 墓碑守卫）
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
import { loadConfig, mergedEnv } from "./config/config.js";
import { getConfigFilePath, writeConfigTemplate } from "./config/config.js";
import { logger } from "./util/logger.js";
// v1.8 Phase E（D6）：fanout RPM 限频 per-process 单例
import { RpmLimiter } from "./util/rpm-limiter.js";
import { newRunId } from "./util/run-id.js";
import { setStateStoreContext } from "./util/state-store.js";
import { SubprocessManager } from "./subprocess/SubprocessManager.js";
import { RustBridge } from "./subprocess/RustBridge.js";
import { BraveChannel } from "./channels/BraveChannel.js";
// v1.15 Phase A（Bing 死层清除）：BingChannel 第三源已删（Bing Search APIs
// 2025-08-11 全量退役；INV-54 墓碑守卫禁回潮，见 providers.ts 墓碑说明）。
// v1.17 A3（doc/25 裁决③）：zhipu 直连 SearchChannel 已删（INV-80 墓碑守卫；
// 智谱能力由 MachineMcpSearchChannel 机器 MCP 复用承载）。
// v1.4 Phase A（parse-v1.4 §Phase A）：MachineMcpSearchChannel 机器 MCP 复用
// 守 INV-72：本通道仅在 detectMachineSearchMcp() 命中时实例化；否则不注册保零回归
import { MachineMcpSearchChannel } from "./channels/MachineMcpSearchChannel.js";
// v1.4 Phase A：detectMachineSearchMcp（只读 ~/.claude.json，永不 log key 值）
import { detectMachineSearchMcp } from "./search/MachineMcpDetector.js";
import {
  HeadlessChannel,
  defaultHeadlessProfileForHost,
} from "./channels/HeadlessChannel.js";
import { LoggedInChannel } from "./channels/LoggedInChannel.js";
import { DesktopChannel } from "./channels/DesktopChannel.js";
import { AxProvider } from "./desktop/AxProvider.js";
import { AxBackendFactory } from "./desktop/AxBackendFactory.js";
import {
  ScreenshotVlmProvider,
  createMcpVlmCaller,
  LASSO_VLM_ENDPOINT_ENV,
} from "./desktop/ScreenshotVlmProvider.js";
import { AppleScriptProvider } from "./desktop/AppleScriptProvider.js";
import { CGEventProvider } from "./desktop/CGEventProvider.js";
// v0.4 M0.4c：cloud 浏览器通道（条件装配，默认 OFF）
import { BrowserbaseChannel } from "./channels/BrowserbaseChannel.js";
import { StagehandChannel } from "./channels/StagehandChannel.js";
import { SteelChannel } from "./channels/SteelChannel.js";
import { StealthEngine } from "./browse/StealthEngine.js";
import { PolicyGate } from "./fallback/PolicyGate.js";
import { FallbackDecider } from "./fallback/FallbackDecider.js";
import { CircuitBreaker } from "./fallback/CircuitBreaker.js";
import { loadSsrfConfig } from "./ssrf/ssrf-guard.js";
import { runDoctor } from "./doctor/doctor.js";
// v1.8 Phase D（D11）：doctor CLI --stealth-check flag 解析 + provider 装配
// （守 grep 边界：stealthCheckClientProvider 构造留在 src/doctor/ 下）
import { buildDoctorCliOptions } from "./doctor/doctor-cli.js";
import { registerSearchTool } from "./tools/search.js";
import { registerBrowseTools } from "./tools/browse.js";
// v1.17 Phase E（parse24 §6.1 C1）：HighRiskGate elicitation 端口（SDK 1.30.0 elicitInput）
import { SdkElicitationPort } from "./interact/ElicitationPort.js";
import { registerBrowserbaseTool } from "./tools/browserbase.js";
import { registerSteelTool } from "./tools/steel.js";
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
// INV-33 守：network 走新加 dispatch entry（cdp-actions.ts doNetwork；v1.11 起 1.7.0 原生 list_network_requests 直调——round2 T2-2 注释修正）
// INV-34 守：network 显式 applyOutputEnvelope(jsonString, hint, ".txt")；资源列表过 envelope
import { registerNetworkTool } from "./tools/network.js";
// v0.9 Phase B（parse10 §3.3 + §6 M3）：wayback_lookup 独立 tool（死链救援，不自动探测）
// INV-56 守：必经 ssrfGuard + doFetchUrl（与 fetch_url 同函数同 config）
// INV-58 守：本 tool 是独立 tool，不在 search 主路径里自动调
import { registerWaybackTool } from "./tools/wayback.js";
// doc/24 颠覆性调研 verdict D-GO-2（2026-08-18）：fetch_feed 无状态 RSS/Atom 原语
// （freshness 推模型——发布即推送，零索引滞后）。INV-56 家族守：必经 ssrfGuard +
// doFetchUrl；独立 tool 不进 search 降级链（与 wayback_lookup 同范式）
import { registerFetchFeedTool } from "./tools/fetch-feed.js";
// v1.8 Phase D（D1）：read_text 续页工具注册（read-text.ts v0.3 已写好但从未装配——
// browse/StepEngine 超 48KiB spill 后 continue_hint 指向的工具经 MCP 不可达，
// wave1 T-TOOLS-13/T-TOOLS-08 采证 6 处 description 指向 + continue_hint 落空）
import { registerReadTextTool } from "./tools/read-text.js";
// doc/25 裁决④（B1 第四通道，2026-08-18）：search_local 本地私有数据搜索
// （Chrome History 多 profile 只读 + mdfind；Notes deferred v2）——纯本地工具
// 直连范式（照 read_text/doctor-tool 先例，不建 BaseChannel；INV-81 隐私红线）
import { registerSearchLocalTool } from "./search-local/register-search-local-tool.js";
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
// v0.7 M0.7 接线（parse8 §3 + §7.2）—— observability 增量（长熔断 + 指标 + 资源 + SERP）
// 守 INV-41：长熔断复用 BreakerState（同 src/fallback/，不开第二引擎）
// 守 INV-42：长熔断 onOpen 经 bag.disable（不绕过 INV-37 task 联动链）
// 守 INV-43：observ/ 进程内无远程遥测（禁 prometheus）
// 守 INV-46：observ 暴露走 admin action-enum（不开新 observability tool）
import { LongCircuitBreaker } from "./fallback/LongCircuitBreaker.js";
import { MetricsCollector } from "./observ/MetricsCollector.js";
import { ResourceMonitor } from "./observ/ResourceMonitor.js";
import { SelectorRegistry } from "./serp/SelectorRegistry.js";
import { HitRateStats } from "./serp/HitRateStats.js";
import { ChangeDetection } from "./serp/ChangeDetection.js";
import { RecordingStore } from "./serp/RecordingStore.js";
import { SerpHealthMonitor } from "./serp/SerpHealthMonitor.js";
// v1.15 Phase B（parse22）：serp_http 裸 HTTP 快探层（browse_headless 之前 ~1s 探针）
import { rawSerpSearch, SERP_HTTP_ALLOWED_HOSTS } from "./serp/http-serp.js";
import type { HttpSerpExec } from "./serp/http-serp.js";
// v1.17 Phase C（A2′ 自研第二跳）：content_blocks 正文富化依赖
import type { ContentSecondHopDeps } from "./search/ContentSecondHop.js";
// v0.8 M0.8 接线（parse9 §3 + §2.2 + §7.2 Phase B）—— logged_in 持久化层
// 守 INV-48：cookie 落盘 AES-256-GCM（CookieStore 实装）
// 守 INV-49：加密包文件 mode 0o600 + 目录 mode 0o700
// 守 INV-50：tab LRU ≤10 hard cap（TabRegistry）
// 守 INV-51：master key 从 OS keychain 取（keychain.js）；doctor 永不清读 cookie
// 守 INV-52：cookie export/import 必经 admin action opt-in（自动 browse 路径不调）
// 守 INV-53：IV 每次加密唯一（CookieStore export 内 randomBytes(12)）
import { ProfileRegistry } from "./logged-in/ProfileRegistry.js";
import { CookieStore } from "./logged-in/CookieStore.js";
// v1.0 Phase C/D（parse11 §3.2 + §3.3 + §7.2）：launcher + replay-baseline 子命令
// INV-64 守：launcher/*.ts 不引新 npm dep（仅 node:* 内置）；index.ts 仅 import 子命令入口
import { runLaunchChromeCli } from "./launcher/launch-chrome.js";
import {
  runChromeStopCli,
  stopLaunchedChromes,
  stopLaunchedChromesSync,
} from "./launcher/chrome-stop.js";
// v1.10（parse18 §2.6 机制一）：台账 Chrome idle reaper（15s 周期；kill 100% 经 chrome-stop）
import { startChromeIdleReaper, type ChromeIdleReaper } from "./launcher/chrome-idle-reaper.js";
import { runReplayBaselineCli } from "./serp/replay-baseline.js";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fsPromises } from "node:fs";
import { fileURLToPath } from "node:url";
const fsStat = fsPromises.stat;
const fsReadFile = fsPromises.readFile;

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
 * v0.7 M0.7（parse8 §1.1 + §6 验收）：observability 增量 —— 长熔断 + MetricsCollector
 *   + ResourceMonitor + SerpHealthMonitor + admin 3 只读 action → 0.7.0-dev
 * v0.8（parse9 §1.1 + §6 验收）：logged_in 持久化层 —— cookie AES-256-GCM 落盘 +
 *   多 profile + tab LRU + admin 3 action（profile_list / profile_switch / cookie_restore）→ 0.8.0-dev
 * v0.9（parse10 §1.1 + §6 验收）：search ≈永不失败兜底层 —— FallbackChain plan 构造器
 *   + wayback_lookup 独立 tool + RecordingStore replay 最后兜底 +
 *   engine="fallback_chain" 显式 opt-in（INV-54..59；engine="auto" 默认 byte-identical v0.8）
 *   → 0.9.0-dev（v0.9 的 BingChannel 第三源已于 v1.15 Phase A 死层清除）
 * v1.0（parse11 §1.1 + §6 验收）：稳定发布 —— desktop 跨平台 AxBackend 契约（mac/Win UIA/Linux AT-SPI
 *   三平台同构 OutlineNode）+ 录制回放回归（replay-baseline）+ 跨平台 launcher（launch-chrome）+
 *   doctor #31/#32 + 文档完整化（README/ARCHITECTURE/TROUBLESHOOTING/SELECTOR-MAINTENANCE）+
 *   INV-60..65（v0.9 INV-1..59 零回归）→ 1.0.0（去 -dev）
 * v1.5（parse13 §1.1 + §6 验收）：stealth 16 路 vendored evasion + header 一致性（secChUa/secFetch*）
 *   + HeadlessChannel 接入 StealthEngine（修 v1.4 零 stealth 注入 P0）→ 1.5.0
 * v1.6（parse14 §1.1 + §6 验收）：SteelChannel 自托管 cloud 通道（"自托管 Browserbase"，
 *   零 per-session 费 + cookie 不出本地）+ STEEL provider + steel tool + doctor #37 +
 *   INV-74（v1.5 INV-1..73 零回归）→ 1.6.0
 * v1.7（parse15 §1.1 + §6 验收）：doctor #38 stealth_creepjs_regression 回归门禁（opt-in；
 *   **回归门禁语义非质量分数**——Lasso JS defineProperty 范式结构性上限）+
 *   doctor #39 stagehand_rest_contract_probe（HEAD 探测裁决 R-ECO-6）+
 *   creepjs-probe.ts + creepjs-baseline.json fixture + StagehandChannel.ts 头注释 R-ECO-6 标记 +
 *   INV-75（v1.6 INV-1..74 零回归）→ 1.7.0
 * v1.8（wave1 修复清单 §4）：W1-DEF-1..10（上游 0.3.0 契约适配 / screenshot 真落盘 /
 *   Storage.getCookies / navigate 校验 / 孤儿清理 / launch-chrome 探活 / screenshot_region
 *   配对 / rust crash 归因 / caller-tier 接线）+ D1-D2/D6-D8/D11 + F-CLI-01 + D3 vlmCaller +
 *   INV-76（v1.7 INV-1..75 零回归）→ 1.8.0
 * 与 package.json version + doctor.ts LASSO_VERSION 三处对齐（grep 验；INV-63 守）。
 */
const LASSO_SERVER_VERSION = "1.17.2";

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
  /** v1.6（parse14 §3.3）：Steel 自托管 endpoint（http://localhost:3000）；非 API key 型解锁 */
  steelEndpoint: string;
  /** 已配置 API key 的 cloud provider 名集合（PolicyGate 双重解锁用） */
  cloudBrowserKeys: Set<string>;
  /** manual-switch 是否开（audit log 用） */
  manualSwitchOn: boolean;
} {
  const manualSwitchOn = process.env.LASSO_ALLOW_CLOUD_BROWSER === "true";
  const browserbaseKey = process.env.BROWSERBASE_API_KEY ?? "";
  const stagehandKey = process.env.STAGEHAND_API_KEY ?? "";
  // v1.6（parse14 §3.3）：Steel 解锁条件 = endpoint（非 key）；自托管无 auth
  const steelEndpoint = process.env.STEEL_ENDPOINT ?? "";
  const cloudBrowserKeys = new Set<string>();
  if (browserbaseKey) cloudBrowserKeys.add("browserbase");
  if (stagehandKey) cloudBrowserKeys.add("stagehand");
  if (steelEndpoint) cloudBrowserKeys.add("steel");
  // 双重解锁：manual-switch + 至少一个 cloud provider（key 或 endpoint）
  const enabled = manualSwitchOn && cloudBrowserKeys.size > 0;
  return {
    enabled,
    browserbaseKey,
    stagehandKey,
    steelEndpoint,
    cloudBrowserKeys,
    manualSwitchOn,
  };
}

// ============================================================
// doctor CLI 模式
// ============================================================
async function runDoctorCli(argv: string[]): Promise<void> {
  // v1.3 Phase B：doctor CLI 也走 loadConfig（file→env 合并），与 MCP doctor tool 一致。
  // 守用户硬约束②：配置文件改的 key 在 CLI doctor 也要反映（env 仍优先——loadConfig
  // 合并顺序 file→env；既有 -e KEY=VAL / shell env 用户零回归）。
  // v1.17 A3：zhipuKey / zhipuEndpoint 参数已删（zhipu 直连死层清除；doctor 改报
  // zhipu_keys_retired 静态退役提示）。
  const config = loadConfig({ runId: "doctor-cli" });
  // ft-round1（FT-DEF-1）：doctor 感知 config 文件键——brave/bing/zhipu/proxy 经
  // mergedEnv（file→env 合并单一真源，config.ts）取值传入；此前 doctor 直读
  // process.env，file 配置的 BRAVE_API_KEYS 对 doctor 不可见而运行时却真实装配。
  const doctorEnv = mergedEnv(process.env);
  // v1.8 Phase D（D11）：`lasso doctor --stealth-check` —— README 承诺落地。
  // flag 解析 + provider 装配独立在 doctor-cli.ts（可单测；probeCreepjs 仍只在
  // doctor/ 内调用——INV-75 的实际 grep 边界，provider 构造点=index.ts+doctor-cli.ts
  // 两处白名单）。
  const stealth = buildDoctorCliOptions(argv);
  const report = await runDoctor({
    cdpPort: config.cdpPort,
    // v1.17 A3：zhipu_keys_retired 静态退役提示需看到 config 文件里的**残留**键
    // （file→env 合并语义：env 优先；容忍读不消费——INV-80 墓碑容许此读取）。
    // ft-round1（FT-DEF-1）：zhipuKey 改经 mergedEnv；并补 brave/bing/proxy/endpoint
    // 同路接入（此前仅 zhipu 一家显式接线，brave/bing 漏接）。
    zhipuKey: doctorEnv.ZHIPU_API_KEY,
    zhipuEndpoint: doctorEnv.ZHIPU_ENDPOINT,
    braveKeysCsv: doctorEnv.BRAVE_API_KEYS ?? doctorEnv.BRAVE_API_KEY ?? "",
    bingKeysCsv: doctorEnv.BING_API_KEYS ?? doctorEnv.BING_API_KEY ?? "",
    proxy: doctorEnv.LASSO_PROXY,
    ...stealth.doctorOpts,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  // stealth-check 专用 headless 子进程清理（W1-DEF-6 教训：不留孤儿）
  if (stealth.shutdown) {
    try {
      await stealth.shutdown();
    } catch {
      // best-effort：进程即将 exit，失败仅吞
    }
  }
  process.exit(report.ready ? 0 : 1);
}

// ============================================================
// v1.3 Phase A：config 子命令（config init / config path）
// ============================================================
/**
 * `lasso config init`：写 ~/.lasso/config.json 模板（扁平 JSON，所有已知 key 空值占位）。
 * `lasso config path`：打印 config 文件绝对路径 + 是否存在。
 *
 * 设计（守用户硬约束：安装命令无配置；要新增配置时在配置文件配）：
 *  - init 模板含 _comment 说明段（JSON 无注释，用 _comment 字段作内嵌文档）
 *  - init 不覆盖既有文件（created=false 时打印路径 + 提示手改）
 *  - 复用 doctor CLI 的 argv dispatch 范式（process.argv[2] === "config"）
 */
async function runConfigCli(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "init") {
    try {
      const { path: p, created } = await writeConfigTemplate();
      if (created) {
        process.stdout.write(
          `Created config template at:\n  ${p}\n\n` +
            `Edit it to fill in your keys (see doc/KEY-GUIDE.md).\n` +
            `Env variables still override this file (backward compatible).\n`,
        );
      } else {
        process.stdout.write(
          `Config file already exists (not overwritten):\n  ${p}\n\n` +
            `Edit it directly to change your keys.\n`,
        );
      }
      process.exit(0);
    } catch (e) {
      process.stderr.write(`config init failed: ${String(e)}\n`);
      process.exit(1);
    }
    return;
  }
  if (sub === "path") {
    const p = getConfigFilePath();
    let exists = false;
    try {
      await fsStat(p);
      exists = true;
    } catch {
      exists = false;
    }
    process.stdout.write(
      `${p} (${exists ? "exists" : "not found"})\n` +
        (exists
          ? ""
          : "\nRun `lasso-mcp config init` to create a template.\n"),
    );
    process.exit(0);
    return;
  }
  process.stderr.write(
    "usage: lasso-mcp config <init|path>\n" +
      "  init  Create ~/.lasso/config.json template (flat JSON; keys match env names)\n" +
      "  path  Print config file path + existence\n",
  );
  process.exit(1);
}

// ============================================================
// MCP server 模式
// ============================================================
async function runMcpServer(): Promise<void> {
  const runId = newRunId();
  const config = loadConfig({ runId });
  // ft-round1（FT-DEF-1）：doctor tool 感知 config 文件键的合并 env（与 CLI 同源）。
  const doctorServerEnv = mergedEnv(process.env);

  // 让 state-store 知道 run_id + cache_dir（channel 写盘时用）
  setStateStoreContext({ runId, cacheDir: config.cacheDir });

  logger.info({
    evt: "lasso_start",
    run_id: runId,
    version: LASSO_SERVER_VERSION,
    // v1.17 A3：zhipu_key_present 已删（zhipu 直连死层清除；智谱能力=机器 MCP 复用）
    brave_key_present: !!process.env.BRAVE_API_KEYS || !!process.env.BRAVE_API_KEY,
    cdp_port: config.cdpPort,
  });

  // ----- 装配 SubprocessManager + 3 channels -----
  const subproc = new SubprocessManager();
  // v1.9（parse17 §2.2 (c) 机制一）：idle 阈值从写死 1h 改为 config.headlessIdleMs
  // （env LASSO_HEADLESS_IDLE_MS，默认 5min）。0 = 禁用 idle watchdog（reaper 完全
  // 不启动，含旧 1h 兜底也没了——opt-out 即自负残留，文档明示）。
  // 注意：reaper 启动放在 logged_in 装配 + setReapHook 之后（parse17 §7.2-31：
  // hook 先于调度器挂好，首个 60s 周期即可用）。
  const startIdleWatchdog = () => {
    if (config.headlessIdleMs > 0) {
      subproc.startZombieReaper(60_000, config.headlessIdleMs);
    } else {
      logger.info({
        evt: "idle_watchdog_disabled",
        idle_ms: 0,
        note: "LASSO_HEADLESS_IDLE_MS=0 — headless browser stays resident until server exit",
      });
    }
  };

  // ----- v0.8 装配：ProfileRegistry + CookieStore 工厂（parse9 §2.2 + §3）-----
  // ProfileRegistry 启动加载（首次建 default profile；mode 0o700）
  const profileRegistry = new ProfileRegistry(config.cacheDir);
  await profileRegistry.load();
  // CookieStore 工厂（按 profile 名新建；CookieStore 自动落 ~/.cache/lasso/cookies/<name>.cookies）
  const cookieStoreFactory = (profileName: string): CookieStore =>
    new CookieStore(config.cacheDir, profileName);

  // v1.17 A3（doc/25 裁决③）：zhipu 直连 SearchChannel 装配段已删（INV-80 墓碑守卫；
  // 智谱能力现行载体 = machine_mcp 机器 MCP 复用，见下方装配段）。

  // ----- v1.4 Phase A：机器 MCP 复用（parse-v1.4 §Phase A）-----
  // **零配置优先**：detectMachineSearchMcp() 读 ~/.claude.json mcpServers，找 type=http +
  // url 含 web_search_prime/bigmodel.cn + headers.Authorization 的 entry。
  //   - 命中 → 实例化 MachineMcpSearchChannel + 注册到 breakers（条件装配，类比 cloud 浏览器双重解锁）
  //   - 未命中 → machineMcpSearch=undefined（不注册；FallbackChain 跳过 search.machine_mcp，
  //     行为 byte-identical v1.3；INV-72 守零回归承诺）
  // **安全（INV-72）**：detector 返 { url, authorization } 仅传入 channel 构造器；本装配段
  //                    **永不** log authorization 值，只 log detected=true/false 布尔。
  const machineMcpDetection = detectMachineSearchMcp();
  let machineMcpSearch: MachineMcpSearchChannel | undefined;
  if (machineMcpDetection) {
    machineMcpSearch = new MachineMcpSearchChannel(
      machineMcpDetection.url,
      machineMcpDetection.authorization,
    );
    logger.info({
      evt: "machine_search_mcp_detected",
      // INV-72 安全：只 log detected=true，不 log url/auth（url 可能含用户 token 路径片段；
      //            保险起见同样不报）。channel.name 是公开常量，可 log。
      detected: true,
      channel: machineMcpSearch.name,
    });
  } else {
    logger.info({
      evt: "machine_search_mcp_detected",
      detected: false,
      note: "no web_search_prime MCP in ~/.claude.json; fallback chain skips search.machine_mcp",
    });
  }

  // v1.5（parse13 §3.4 P0 核心修复）：HeadlessChannel 接 StealthEngine —— 修 v1.4
  // 「browse_headless 零 stealth 注入」P0 业务缺口。stealth 实例在 headless 装配前建。
  const headlessStealth = new StealthEngine();
  // v1.11（round1 T10）：LASSO_PROXY 出口代理（仅 headless 生效；logged_in 永不读）
  // v1.12（round2 T2-1）：默认 profile 宿主对齐（darwin→mac_chrome，消除 UA↔
  // client hints 的 OS 级 shape 矛盾；见 HeadlessChannel.defaultHeadlessProfileForHost）
  const headless = new HeadlessChannel(
    subproc,
    headlessStealth,
    defaultHeadlessProfileForHost(),
    config.proxy || undefined,
  );
  // v1.10（parse18 §2.6 机制一）：台账 Chrome idle reaper——「用完即关」调度器。
  // 与 zombie reaper 分工：zombie 管 procs（MCP 树，HEADLESS_IDLE_MS）；本 reaper
  // 管 ledger（detached Chrome，LAUNCH_IDLE_MS 默认 60s）；致死原语 100% 复用
  // chrome-stop（探活→ps 归属验证→SIGTERM→树杀→删账；零新 kill 路径）。
  // 0 = 禁用（chrome_idle_reaper_disabled；台账 Chrome 常驻到 chrome-stop / 停机）。
  let chromeReaper: ChromeIdleReaper | null = null;
  if (config.launchIdleMs > 0) {
    chromeReaper = startChromeIdleReaper({
      defaultIdleMs: config.launchIdleMs,
      touchPorts: new Set([config.cdpPort]),
      logFn: (p) => logger.info(p),
    });
  } else {
    logger.info({
      evt: "chrome_idle_reaper_disabled",
      idle_ms: 0,
      note: "LASSO_LAUNCH_IDLE_MS=0 — launched Chrome stays resident until chrome-stop / server exit",
    });
  }

  // v0.8（parse9 §3.2）：LoggedInChannel 注入 ProfileRegistry + CookieStore 工厂
  // v1.10（parse18 §2.6）：onChromeUse 回调——每次 browse 经 getMcpClient 打点
  // reaper touch(cdpPort)（活动源与 browse 频度天然同步；闭包 over chromeReaper）。
  const logged_in = new LoggedInChannel(
    subproc,
    config.cdpPort,
    profileRegistry,
    cookieStoreFactory,
    undefined,
    () => chromeReaper?.touch(config.cdpPort),
  );
  // v1.9（parse17 §4.4 机制三）：idle 回收 logged_in spec 前 hook —— 机制一回收
  // logged_in 的 mcp 子进程前先恢复用户 tab 列表（「浏览器用完收尾」完整语义）。
  // hook 内 SubprocessManager 侧已有 3s race 上界；restore 自身永不 throw。
  subproc.setReapHook(async (name) => {
    if (name.startsWith("logged_in:")) {
      logger.info({ evt: "reap_hook_tab_restore", name });
      await logged_in.restoreTabs();
    }
  });
  // v1.9：reaper 在 setReapHook 之后启动（§7.2-31 装配顺序）
  startIdleWatchdog();

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

  // v1.15 Phase A（Bing 死层清除）：v0.9 的 BingChannel 装配段已删（Bing Search APIs
  // 2025-08-11 全量退役，微软 lifecycle 公告，2026-08-17 核实）。providers 表不再注册
  // bing（config.ts 静默忽略 BING_API_KEYS；doctor #11c bing_keys_retired 提示删除）；
  // v1.17 A3：zhipu 直连档亦删（ZHIPU_API_KEYS 同款容忍忽略 + doctor zhipu_keys_retired）；
  // fallback_chain 链变为 machine_mcp → brave → serp_http → browse_headless。

  // ----- v0.9 Phase B 装配 search-recordings RecordingStore（parse10 §3.4 + INV-57）-----
  // engine="fallback_chain" 全源熔断时 replay 最后兜底（命中返 worked + served_by="recording_replay"）。
  // **零回归**：仅 engine="fallback_chain" 路径使用；engine="auto" 默认路径不读，
  //            byte-identical v0.8。LASSO_RECORD_SEARCH 默认 OFF（INV-57）—— 录制需显式 opt-in，
  //            但 replay 与录制开关独立（过去录过的 fixture 即便本次 OFF 仍可回放）。
  const searchRecordings = new RecordingStore(
    path.join(config.cacheDir, "search-recordings"),
  );

  // ----- v0.3.5 装配 DesktopChannel（parse4 §3.5 + §2.3 文件依赖图）-----
  // 桌面通道 4 件套（v0.4 M0.4b 扩 4-tier）：
  //   1. subproc.registerRustSpec("rust-helper", {...})  ← spawn 规格
  //   2. new RustBridge(subproc, "rust-helper")          ← JSON-lines 协议适配
  //   3. 4 档 provider（parse5 §3.5.4）：
  //        new AxProvider(AxBackendFactory.create(rust))  ← 第 1 档 ax
  //          v1.0（parse11 §3.1 + §7.2 Phase A）：backend 经 factory 路由
  //          三平台同形：mac→MacAxBackend / win→WinUiaBackend / linux→LinuxAtspiBackend
  //        new AppleScriptProvider(rust)     ← 第 2 档 appleScript（v0.4 M0.4b）
  //        new CGEventProvider(rust)         ← 第 3 档 cgEvent（v0.4 M0.4b）
  //        new ScreenshotVlmProvider(rust)   ← 第 4 档 screenshotVlm
  //   4. new DesktopChannel(rust, ax, vlm, appleScript, cgEvent, decider, breakers)
  //
  // INV-7：RustBridge 持协议帧解析；SubprocessManager 仍纯 lifecycle（既有 MCP 路径不动）。
  // INV-23/29：breakers 加 4 档 desktop.*；永不挂 browse_*。
  // INV-60（v1.0）：AxBackendFactory 是 backend 路由单一真源；AxProvider 不直构 backend。
  const rustHelperPath =
    process.env.LASSO_RUST_HELPER_PATH ?? DEFAULT_RUST_HELPER_PATH;
  subproc.registerRustSpec("rust-helper", {
    command: rustHelperPath,
    args: [],
  });
  const rustBridge = new RustBridge(subproc, "rust-helper");
  // v1.0：AxProvider 经 AxBackendFactory 路由到当前平台 backend（parse11 §3.1）。
  // macOS 本机 → MacAxBackend；Win/Linux 编译可证 + 真机执行留手测清单（parse11 §1.3）。
  const axBackend = AxBackendFactory.create(rustBridge);
  const axProvider = new AxProvider(axBackend);
  const appleScriptProvider = new AppleScriptProvider(rustBridge);
  const cgEventProvider = new CGEventProvider(rustBridge);
  // v1.8 Phase E（D3）：vlmCaller 接线——LASSO_VLM_ENDPOINT 已配时注入生产 MCP 调用器
  // （connectHttp → callTool("vlm") → close）；未配则不注入，保持 act() 返
  // didnt + error="vlm_unavailable" 的诚实语义（v1.7 前缺口：endpoint 配了但 caller
  // 恒 null → screenshotVlm 档恒 unavailable）。
  const vlmProvider = new ScreenshotVlmProvider(rustBridge, {
    ...(process.env[LASSO_VLM_ENDPOINT_ENV]
      ? { vlmCaller: createMcpVlmCaller() }
      : {}),
  });

  // ----- 装配 FallbackDecider（每 channel 一个 60s 短熔断器）-----
  // v0.2 加 search.brave + fanout 虚拟 channel 的 breaker（parse2 §3.3.4）
  // v0.3.5 加 desktop.ax + desktop.screenshotVlm 两档 breaker（parse4 §3.2.1）
  // v0.4 M0.4b 加 desktop.appleScript + desktop.cgEvent 两档 breaker（parse5 §3.5.4）
  // v0.4 M0.4c 加 browse_cloud.browserbase / browse_cloud.stagehand 两档 breaker（条件；parse5 §3.2）
  const breakers = new Map<string, CircuitBreaker>([
    // v1.17 A3：search.zhipu breaker 已删（zhipu 直连死层清除；INV-80 墓碑守卫）
    ["search.brave", new CircuitBreaker()],
    // v1.15 Phase A：search.bing breaker 已删（Bing 死层清除；INV-54 墓碑守卫）
    // v1.4 Phase A（parse-v1.4 §Phase A）：search.machine_mcp breaker
    // **零回归**：detector 未命中 → machineMcpSearch=undefined → 此 breaker 仍创建但不被任何
    // channel 引用（FallbackChain 跳过 search.machine_mcp；行为等价 v1.3）。
    ["search.machine_mcp", new CircuitBreaker()],
    ["fanout", new CircuitBreaker()],
    // v1.15 Phase B（parse22 §3）：serp_http 裸 HTTP 快探层 60s 短熔断
    // （browse_headless 之前 ~1s 级探针；runtime_state/doctor 经 breakers 表自动可见，
    //   无需新 doctor check——内部层非配置项）
    ["serp_http", new CircuitBreaker()],
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
  let steelChannel: SteelChannel | undefined;
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
    // v1.6（parse14 §3.3）：Steel 自托管 cloud 浏览器条件装配
    // 双重解锁：LASSO_ALLOW_CLOUD_BROWSER=true + STEEL_ENDPOINT 存在
    // Steel 是 Browserbase 的自托管替代（零 per-session 费 + cookie 不出本地）
    if (cloudEnv.steelEndpoint) {
      steelChannel = new SteelChannel(
        subproc,
        cloudEnv.steelEndpoint,
        stealth,
        // v1.11（round1 T10）：LASSO_PROXY → Steel session proxyUrl（云端 Chrome 出口一致）
        { proxyUrl: config.proxy || undefined },
      );
      breakers.set("browse_cloud_steel", new CircuitBreaker());
      logger.info({
        evt: "cloud_browser_channel_wired",
        channel: "browse_cloud_steel",
        endpoint: cloudEnv.steelEndpoint,
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
      has_steel_endpoint: !!cloudEnv.steelEndpoint,
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

  // ----- v0.7 M0.7：SerpHealthMonitor 早期装配（parse8 §3.4）-----
  // 需在 registerSearchTool 之前实例化，作为第 8 参注入。
  // 4 件骨架首次实例化（v0.2 全 0 命中 → v0.7 装配段首次实例化）。
  // 守 INV-45：SerpHealthMonitor 禁自动重写 selector 表（保守人工升级）
  const serpCacheDir = path.join(os.homedir(), ".cache", "lasso", "serp");
  const serpRegistry = new SelectorRegistry();
  const serpHitRate = new HitRateStats();
  const serpChange = new ChangeDetection(path.join(serpCacheDir, "baseline"));
  const serpRecordings = new RecordingStore(path.join(serpCacheDir, "recordings"));
  const serpHealth = new SerpHealthMonitor(
    serpRegistry,
    serpHitRate,
    serpChange,
    serpRecordings,
  );

  // ----- v1.8 Phase E：caller-tier + fanout RPM 接线（W1-DEF-10 + D6）-----
  // CallerTierTracker 原在 v0.6 装配段创建（仅喂 admin/doctor）；wave1 T-RT-06 实锤
  // tryAcquire 全仓零调用点 → cap_set/cap_list 空转。现提前到 tool 注册前创建，
  // 注入 search/browse handler 入口（超额透明 didnt + caller_cap_exceeded）。
  // INV-38：defaultCap 从 readCallerCapFromEnv（构造期一次性读 env；运行时不读）。
  const callerTier = new CallerTierTracker(readCallerCapFromEnv());
  // D6：per-process 共享 RpmLimiter 单例（defaultMax=Infinity → 未配 rpm_max 的源
  // 不限频，行为等价 v1.7；ledger.rpmMax 配了即经 MultiSourceFanout 主动降级）。
  const searchRpmLimiter = new RpmLimiter();

  // ----- MCP server + tool 注册 -----
  const server = new McpServer({
    name: "lasso-mcp",
    version: LASSO_SERVER_VERSION,
  });

  // ----- v1.15 Phase B（parse22 §3）：serp_http 裸 HTTP 快探层装配 -----
  // browse_headless（冷启动 ~11s + Chromium 树）之前的 ~1s 级探针。
  // 白盒依据（doc/21 + v1.14 实测）：裸 curl 打 search.brave.com 返 200+22 条，
  // 真 Chrome 反吃验证码——API 全挂时先裸 HTTP 探一次，探不到再升真浏览器。
  // fetch 经 SubprocessManager.httpAgents 池（per-origin 懒建；单一真源不 new Agent）；
  // SSRF 纵深与 browse/fetch_url 共用同一 ssrfConfig；serpHealth 复用改版检测链。
  const serpHttpExec: HttpSerpExec = (query, o) =>
    rawSerpSearch(query, {
      region: o.region,
      freshness: o.freshness,
      limit: o.limit,
      fetchImpl: ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        subproc.acquireHttpClient(new URL(String(url)).origin).fetch(url, init)) as typeof fetch,
      ssrfConfig,
      serpHealth,
    });
  logger.info({ evt: "serp_http_layer_wired", hosts: SERP_HTTP_ALLOWED_HOSTS.length });

  // ----- v1.17 Phase C（A2′ 自研第二跳）：content_blocks 正文富化装配（parse24 §3）-----
  // fetch 经 SubprocessManager.httpAgents 池（per-origin 懒建；INV-32 单一真源
  // 不 new Agent——与上面 serpHttpExec 同款包装）；SSRF 纵深与 browse/fetch_url/
  // serp_http 共用同一 ssrfConfig（INV-31 同函数同 config）。
  // 未传该参时 content_blocks 参数被诚实忽略（search.ts 注入式手法，零回归）。
  const contentHopDeps: ContentSecondHopDeps = {
    fetchImpl: ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      subproc.acquireHttpClient(new URL(String(url)).origin).fetch(url, init)) as typeof fetch,
    ssrfConfig,
  };
  logger.info({ evt: "content_second_hop_wired", budget_chars: 6000 });

  registerSearchTool(
    server,
    decider,
    browseHeadlessExec,
    brave,
    config.registry,
    searchCache,
    serpHealth,
    // v0.9 Phase B（parse10 §3）：searchRecordings 注入
    // v1.15 Phase A：bing 参数已删（Bing 死层清除）；v1.17 A3：search: SearchChannel
    // 参数已删（zhipu 直连死层清除；fallback_chain 走
    // machine_mcp → brave → serp_http → browse_headless）
    searchRecordings,
    // v1.4 Phase A（parse-v1.4 §Phase A）：machineMcpSearch 机器 MCP 复用注入
    // detector 未命中 → undefined → fallback_chain channelOrder 不含 search.machine_mcp
    // （行为 byte-identical v1.3；INV-72 零回归守）
    machineMcpSearch,
    // v1.8 Phase E（W1-DEF-10）：handler 入口 tryAcquire（超额 → caller_cap_exceeded）
    callerTier,
    // v1.8 Phase E（D6）：fanout rpmOptions 接线（F3.1.12 设计落地）
    searchRpmLimiter,
    // v1.15 Phase B（parse22 §2.1）：serp_http 快探注入（fallbacks 变
    // [serp_http, browse_headless]；未注入则零回归）
    serpHttpExec,
    // v1.17 Phase C（A2′ 第二跳）：content_blocks 正文富化依赖注入
    // （未注入则 content_blocks 参数诚实忽略，零回归 byte-identical）
    contentHopDeps,
  );
  registerBrowseTools(server, headless, logged_in, decider, ssrfConfig, callerTier);

  // ----- v1.17 Phase E（parse24 §6.1 C1）：HighRiskGate elicitation 端口注入 -----
  // logged_in 构造早于 McpServer（装配序），此处 setter 补注入。端口内部预检
  // clientCapabilities.elicitation.form：未声明（CC <2.1.76 等）→ unavailable →
  // 现行 blocked 行为 byte-identical（裁决红线测试钉死）。
  logged_in.setElicitationPort(new SdkElicitationPort(server));
  registerDesktopTool(server, desktop, decider);
  // v0.4 M0.4c：cloud 浏览器工具条件注册（parse5 §3.2 + §6.3 #16）
  // 默认 OFF：未双重解锁时 server.listTools() 不含 browserbase（INV-25 守）
  if (browserbaseChannel) {
    registerBrowserbaseTool(server, browserbaseChannel, decider, ssrfConfig);
  }
  // v1.6（parse14 §3.4）：Steel 自托管 cloud 浏览器工具条件注册
  // 默认 OFF：未双重解锁时 server.listTools() 不含 steel（INV-25/INV-74 守）
  if (steelChannel) {
    registerSteelTool(server, steelChannel, decider, ssrfConfig);
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
  // network 走新加 entry（doNetwork from cdp-actions；v1.11 起 1.7.0 原生 list_network_requests 直调）
  registerNetworkTool(server, headless, ssrfConfig);
  // v1.8 Phase D（D1）：read_text 注册（@oN 续页；readOnly + 非 openWorld，INV-5）
  registerReadTextTool(server);
  // doc/25 裁决④（B1 第四通道）：search_local 本地私有搜索注册
  // （Chrome History + mdfind 两源先行；Notes deferred_v2 诚实 didnt）
  // 纯本地只读、零网络（INV-81(d)）；四处联动第 2 处（INV-81(f)）
  registerSearchLocalTool(server);
  // v0.9 Phase B（parse10 §3.3 + §6 M3 手测）：wayback_lookup 独立 tool
  // 经 SubprocessManager.acquireHttpClient + 共用 ssrfConfig（与 fetch_url 同范式；守 INV-56）
  // 是独立 tool，不在 search 主路径里自动调（守 INV-58：CC 显式 opt-in）
  registerWaybackTool(server, subproc, ssrfConfig);
  // doc/24 verdict D-GO-2（2026-08-18）：fetch_feed 独立 tool（RSS/Atom/JSON Feed 原语）
  // 经 SubprocessManager.acquireHttpClient + 共用 ssrfConfig（与 fetch_url 同范式；守 INV-56 家族）
  registerFetchFeedTool(server, subproc, ssrfConfig);
  // doctor tool opts 提为命名变量（v0.6 M0.6 parse7 §2.2 + §6.2）：v0.6 接线段在装配尾部
  // 经此变量注入 runtimeState provider，让 doctor 报告含 runtime_state section（零回归：
  // runtimeState 是可选字段；未注入时行为完全等价 v0.5）。
  // 显式标 DoctorOptions 类型让 v0.6 接线段可以注入 runtimeState（无 TS narrowing 限制）。
  const doctorOpts: Parameters<typeof registerDoctorTool>[1] = {
    // v1.17 A3：zhipuKey / zhipuEndpoint 已删（zhipu 直连死层清除）
    cdpPort: config.cdpPort,
    cacheDir: config.cacheDir,
    // ft-round1（FT-DEF-1）：MCP doctor tool 同样经 mergedEnv 感知 config 文件键
    // （brave/bing/zhipu/proxy；与 runDoctorCli 同一合源——此前 MCP 模式连 zhipu
    // 都是直读 process.env，file 残留键两模式都漏报）。
    zhipuKey: doctorServerEnv.ZHIPU_API_KEY,
    zhipuEndpoint: doctorServerEnv.ZHIPU_ENDPOINT,
    braveKeysCsv:
      doctorServerEnv.BRAVE_API_KEYS ?? doctorServerEnv.BRAVE_API_KEY ?? "",
    bingKeysCsv:
      doctorServerEnv.BING_API_KEYS ?? doctorServerEnv.BING_API_KEY ?? "",
    proxy: doctorServerEnv.LASSO_PROXY,
    // v0.3.5：doctor tool 也走 desktopChecks（desktop bridge 注入；parse4 §3.4.2）
    desktopChecks: true,
    desktopBridge: rustBridge,
    desktopHelperPath: rustHelperPath,
    // v1.0 Phase C（parse11 §3.2 + §3.4 + INV-62）：doctor #32 recording_baseline_count
    // 扫 fixtures/serp-baseline/（与 replay-baseline.ts 默认对齐）。
    // 守 INV-62：此处只传目录路径；doctor 仅 readdir + count，不读 .html 内容。
    recordingBaselineDir: path.join(process.cwd(), "fixtures", "serp-baseline"),
    // v1.8 Phase D（D11）：MCP doctor tool 也注入 stealthCheckClientProvider（复用装配段
    // HeadlessChannel 已注册的 "headless" spec，懒启动，不额外开销）。stealthCheck 仍
    // 默认 false → #38 warn-skip 行为零回归（doctor tool schema 无参，MCP 侧不实跑探测；
    // 实跑入口是 CLI `lasso doctor --stealth-check`）。
    stealthCheckClientProvider: async () => {
      try {
        return await subproc.ensureRunning("headless");
      } catch {
        return null;
      }
    },
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
    browse_cloud_steel: "steel", // v1.6（parse14 §3.3）：Steel CDP subprocess spec
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
    steel: "browse_cloud_steel", // v1.6（parse14 §3.4）
    desktop: "desktop",
    interact_roots: "forest",
    interact_observe: "forest",
    interact_act: "forest",
    fetch_url: "fetch",
    screenshot: "screenshot",
    pdf: "pdf",
    network: "network",
    // v0.9 Phase B（parse10 §3.3）：wayback_lookup 归到 "wayback" channel（独立 caller-tier）。
    // bag.disable("wayback") 仅停 wayback_lookup tool；不影响 search 主路径（INV-58 守）。
    wayback_lookup: "wayback",
    // doc/24 verdict D-GO-2：fetch_feed 归到独立虚拟 channel（与 read_text 同范式——
    // 无子进程、无 bag entry，仅 ToolManager caller-tier 隔离用）
    fetch_feed: "fetch_feed",
    // v1.8 Phase D（D1）：read_text 归到独立虚拟 channel（与 fetch/screenshot/pdf/network
    // 同范式——无子进程、无 bag entry，仅 ToolManager caller-tier 隔离用）
    read_text: "read_text",
    // doc/25 裁决④（B1 第四通道）：search_local 归到独立虚拟 channel
    // （与 read_text 同范式——纯本地工具，无子进程、无 bag entry，
    // 仅 ToolManager caller-tier 隔离用；四处联动第 3 处，INV-81(f)）
    search_local: "search_local",
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
  // v1.6（parse14 §3.3）：Steel 条件加入 initialCapabilities
  if (cloudEnv.enabled && cloudEnv.steelEndpoint) {
    initialCapabilities.push("browse_cloud_steel");
  }
  // search providers（dot 形式 "search.<name>"）
  // v1.17 A3：search.zhipu 无条件加入段已删（zhipu 直连死层清除；INV-80 墓碑守卫）
  if (brave) {
    initialCapabilities.push("search.brave");
  }
  if (machineMcpSearch) {
    initialCapabilities.push("search.machine_mcp");
  }
  // v1.15 Phase A：search.bing 条件加入段已删（Bing 死层清除；装配层永不出 bing channel）
  // desktop providers（ProviderConfig.name 已是 "desktop.<tier>" 形式）
  initialCapabilities.push(
    "desktop.ax",
    "desktop.appleScript",
    "desktop.cgEvent",
    "desktop.screenshotVlm",
  );
  const bag = new CapabilityBag(initialCapabilities);

  // ---- 3. CallerTierTracker（parse7 §3.3）----
  // v1.8 Phase E（W1-DEF-10）：实例已提前到 tool 注册前创建（search/browse handler
  // 入口接线需要；此处沿用同一句柄喂 admin/doctor，不再重复 new）。

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

  // ============================================================
  // v0.7 M0.7 装配段（parse8 §3 + §7.2 Phase A-D）
  // ============================================================
  // 零回归承诺（parse8 §1.3）：
  //  - 本段加在 v0.6 装配尾部；v0.5 / v0.6 装配一行不动
  //  - 长熔断 onOpen 联动 bag.disable（INV-42：不绕过 INV-37 task 联动链）
  //  - MetricsCollector 经 setter 挂回 decider（late-binding：避免重构 200+ 行装配顺序）
  //  - ResourceMonitor 旁路采样 subproc 受管子进程（INV-46：不渗协议帧）
  //  - SerpHealthMonitor 粘合 v0.2 四件骨架（INV-45：禁自动重写 selector 表）
  // 守 INV-41：长熔断复用 BreakerState（与 CircuitBreaker 并列在 src/fallback/）
  // 守 INV-43：observ/ 进程内无远程遥测（指标经 logger JSON 行日志）
  // 守 INV-44：MetricsCollector per-channel 维度（record 必带 channel 名）
  // 守 INV-46：observ 暴露走 admin action-enum（不开新 observability tool）
  // 守 INV-47：doctor runtime_state 扩 metrics/breakers/serp_health（不开新 section）

  // ---- v0.7-1. MetricsCollector（per-channel 成功率 / p95）----
  const metrics = new MetricsCollector();
  decider.attachMetrics(metrics);
  // v1.12（round2 T2-13）：T14 的 wrapHandler metrics 钩子装配接线——此前
  // setMetrics 全仓生产零调用（仅测试可达），admin/动态注册工具的时延/错误
  // 不入 INV-43 观测窗（decider.attachMetrics 同款 late-binding 一行）。
  toolManager.setMetrics(metrics);

  // ---- v0.7-2. LongCircuitBreaker Map（60min 长熔断 + onOpen 联动 bag.disable）----
  // INV-42：onOpen 闭包内显式调 bag.disable + 标 reason="long_circuit_open"
  // （走 v0.6 既有 onChange → toolManager.disableChannel + subproc.shutdownOne 链）
  const longBreakers = new Map<string, LongCircuitBreaker>();
  for (const name of [
    // v1.17 A3：search.zhipu 长熔断已删（zhipu 直连死层清除；INV-80 墓碑守卫）
    "search.brave",
    // v1.15 Phase A：search.bing 长熔断已删（Bing 死层清除；INV-54 墓碑守卫）
    "browse_headless",
    "browse_logged_in",
    "browse_cloud_browserbase",
    "browse_cloud_stagehand",
    "browse_cloud_steel", // v1.6（parse14 §3.3）：Steel 长熔断
    "desktop.ax",
    "desktop.appleScript",
    "desktop.cgEvent",
    "desktop.screenshotVlm",
  ]) {
    longBreakers.set(
      name,
      new LongCircuitBreaker(
        10, // threshold：1h 内 10 次失败 → open
        3_600_000, // windowMs：1h 滑动窗
        3_600_000, // resetMs：open 持续 60min
        async (n) => {
          logger.warn({ evt: "long_circuit_opened", channel: n });
          // INV-42：长熔断 open 必经 CapabilityBag.disable（不绕过 INV-37 task 链）
          await bag.disable(n, {
            callerId: "system",
            reason: "long_circuit_open",
          });
        },
        name,
      ),
    );
  }
  decider.attachLongBreakers(longBreakers);

  // ---- v0.7-3. ResourceMonitor（旁路采样 subproc 子进程 RSS/CPU）----
  // 60s setInterval + unref → 不阻止 Node 退出（守 v0.6 INV-7 衍生 lifecycle 纯净性）
  // INV-46：listManagedPids 只读 pid 数字，不渗协议帧（不读 stdin/stdout）
  const resourceMonitor = new ResourceMonitor(() => subproc.listManagedPids());
  resourceMonitor.start();

  // ---- v0.7-4. SerpHealthMonitor 已在装配段早期实例化（line 351 一带）----
  // 此处不再重复；serpHealth 句柄已传入 registerSearchTool（parse8 §3.4 onResult hook）

  // ---- 5. admin tool 注册（parse7 §3.5）----
  // INV-37：经 toolManager.register（不直调 server.tool）；channel="admin" 永不被 disable
  // （CapabilityBag.initial 不含 "admin" → bag.disable("admin") 返 false 不触发联动）。
  // v0.7（parse8 §3.5）：注入 4 个 observ 数据源（INV-46：observ 走 admin action-enum）
  // v0.8（parse9 §3 + INV-52）：注入 logged_in 数据源 + cookie export/import 入口
  registerAdminTool({
    bag,
    toolManager,
    callerTier,
    registry: config.registry,
    metrics,
    breakers,
    longBreakers,
    serpHealth,
    // v0.8：profile 句柄（profile_list / profile_switch 用）
    profiles: profileRegistry,
    // v0.8：cookie export/import 入口（INV-52：admin opt-in；从 LoggedInChannel 转发）
    cookieExport: () => logged_in.exportCookies(),
    cookieImport: () => logged_in.importCookies(),
    // v1.9（parse17 §4.4 机制三）：tab_restore 入口（从 LoggedInChannel.restoreTabs 转发；
    // 只关快照后新增的 tab，红线不碰用户原有 tab）
    tabRestore: () => logged_in.restoreTabs(),
  });

  // ---- 5b. doctor tool opts 注入 runtimeState provider（parse7 §2.2 + §6.2）----
  // 经 doctorOpts 变量（v0.5 装配段命名捕获）注入；零回归：runtimeState 可选字段，未注入时
  // runDoctor 跳过 runtime_state section（v0.5 行为）；注入后 doctor 报告新增 section。
  // 守 INV-35：doctor.ts 不 import runtime/；此处仅注入「数据快照函数」，不传 bag/callerTier 句柄。
  // v0.7（parse8 §3.5 / INV-47）：runtimeState provider 返回对象扩 metrics/breakers/serp_health
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
    // v0.7：observ 子字段（INV-47：不开第二套 doctor section）
    metrics: metrics.snapshot(),
    breakers: [
      ...Array.from(breakers.entries()).map(([name, b]) => ({
        channel: name,
        kind: "short" as const,
        state: b.state,
        failure_count: b.failureCountReadOnly,
        opened_at: b.openedAtReadOnly,
      })),
      ...Array.from(longBreakers.entries()).map(([name, b]) => ({
        channel: name,
        kind: "long" as const,
        state: b.state,
        window_failure_count: b.windowFailureCount,
        opened_at: b.openedAtReadOnly,
      })),
    ],
    serp_health: serpHealth.snapshot(),
  });

  // ---- 5c. v0.8（parse9 §3.4 + INV-51）：profilesChecksProvider 注入 ----
  // doctor 用此 provider 拿 profile + 加密包 stat 元数据；provider 内部调 ProfileRegistry.list
  // + CookieStore.stat（**只 stat 不解密**），返纯元数据给 doctor（doctor 不接触 cookie 内容）。
  // 守 INV-35：doctor.ts 不 import logged-in/；index.ts 装配层注入 provider。
  // 守 INV-51：provider 返对象**永不**含 cookie 字段（name/value/domain/session 等）。
  doctorOpts.profilesChecksProvider = async () => {
    const list = profileRegistry.list();
    const currentName = profileRegistry.currentName();
    const out: Array<{
      name: string;
      isCurrent: boolean;
      userDataDir: string;
      userDataDirExists: boolean;
      userDataDirMode: string | null;
      encryptedPackage: {
        exists: boolean;
        bytes?: number;
        mtimeMs?: number;
        sha256?: string;
      } | null;
    }> = [];
    for (const p of list) {
      // user-data-dir 探测：stat + 读 mode（不读 Chrome 内部文件，只 stat 顶层目录）
      let userDataDirExists = false;
      let userDataDirMode: string | null = null;
      try {
        if (p.userDataDir) {
          const stat = await fsStat(p.userDataDir);
          userDataDirExists = stat.isDirectory();
          // mode 转八进制字符串（高 12 bit 是文件类型，低 9 bit 是权限位）
          userDataDirMode = "0o" + (stat.mode & 0o777).toString(8);
        }
      } catch {
        // userDataDir 不存在 / 不可 stat → false + null
      }
      // 加密包 stat：**只**调 stat()，**不**调 import()（INV-51 红线）
      const store = cookieStoreFactory(p.name);
      let encryptedPackage: {
        exists: boolean;
        bytes?: number;
        mtimeMs?: number;
        sha256?: string;
      } | null;
      try {
        encryptedPackage = await store.stat();
      } catch {
        encryptedPackage = null;
      }
      out.push({
        name: p.name,
        isCurrent: p.name === currentName,
        userDataDir: p.userDataDir,
        userDataDirExists,
        userDataDirMode,
        encryptedPackage,
      });
    }
    return out;
  };

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
    // v1.10（parse18 §2.6）：停 chrome-idle-reaper timer（best-effort；幂等；
    // Chrome 收尾由下方既有 stopLaunchedChromes({all:true}) 覆盖）
    chromeReaper?.stop();
    // v0.7：停 ResourceMonitor timer（避免 timer 残留；INV-7 衍生 lifecycle 纯净性）
    resourceMonitor.stop();
    // v1.8 Phase B（D5）：停机路径 best-effort 释放 Steel session
    // （POST /v1/sessions/release；失败仅 warn 不阻断退出——releaseSession 内部已吞错）。
    // T3-4（round3 v1.13）：3s 上界——此前是停机链唯一无上界 await（兄弟步
    // stopLaunchedChromes / restoreTabs 均 race 3s）。自托管 Steel 停摆 /
    // endpoint 悬挂（accept-but-silent 实测挂 ~301s）会把 stdin_eof 全场景
    // 阻塞到分钟级；race 输者随 process.exit 消亡，无句柄残留。SteelChannel
    // 侧 fetch 另传 AbortSignal.timeout(3s) 双保险。
    if (steelChannel) {
      try {
        await Promise.race([
          steelChannel.releaseSession(),
          new Promise<void>((resolve) => setTimeout(() => resolve(), 3_000)),
        ]);
      } catch (e) {
        logger.warn({ evt: "steel_release_on_shutdown_failed", error: String(e) });
      }
    }
    // v1.9（parse17 §3.6 机制二）：停机收尾台账 Chrome（3s 上界；失败 warn 不阻断停机）。
    // 只杀台账在案且 cmdline 验证 --user-data-dir 归属的 pid（chrome-stop 红线）。
    try {
      await Promise.race([
        stopLaunchedChromes({ all: true, logFn: (p) => logger.info(p) }),
        new Promise<void>((resolve) => setTimeout(() => resolve(), 3_000)),
      ]);
    } catch (e) {
      logger.warn({ evt: "chrome_stop_on_shutdown_failed", error: String(e) });
    }
    // v1.9（parse17 §4.4 机制三）：server 结束 = 会话结束，自动恢复用户 tab 列表
    //（3s 上界；CDP 不可达等失败 warn 放弃——restore 永不 throw）。
    try {
      await Promise.race([
        logged_in.restoreTabs(),
        new Promise<void>((resolve) => setTimeout(() => resolve(), 3_000)),
      ]);
    } catch (e) {
      logger.warn({ evt: "tab_restore_on_shutdown_failed", error: String(e) });
    }
    try {
      // W2-DEF-N2（v1.8.1）：**不再 await subproc.shutdown()**——其内部 client.close()
      // 实测会悬挂（残留 server 进程卡在此处永不到达 process.exit，exit 钩子不触发，
      // 整棵 shim→node→Chrome 树泄漏）。SIGTERM 路径直接同步树杀（SIGKILL 递归
      // pgrep -P）+ 立即 exit；优雅 close 留给 exit 钩子外无路径依赖。
      subproc.killAllSync();
    } catch (e) {
      logger.warn({ evt: "shutdown_error", error: String(e) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // T2-12（round2）：stdin EOF → 优雅停机。上游 SDK #2002（v1/v2 同病）：StdioServerTransport
  // 的 start() 只挂 data/error，不监听 close/end——CC 异常退出（崩溃/关窗）后父进程死亡、
  // stdin EOF，但活跃 ChildProcess 句柄保活事件循环，Lasso 不退出 → cdp-mcp/rust-helper 树
  // 孤儿直到 zombie reaper 1h 阈值。MCP stdio 语义共识：客户端关 stdin = 终止服务。
  // 复用幂等 shutdown（shuttingDown 防双触发）：正常 CC 退出先 SIGTERM，后到 stdin EOF
  // 被幂等挡住，零竞态新增。SDK transport 已挂 data 监听（流 flowing 模式），EOF 后
  // end/close 必达。
  process.stdin.on("end", () => void shutdown("stdin_eof"));
  process.stdin.on("close", () => void shutdown("stdin_eof"));
  // v1.8 Phase B（W1-DEF-6）：exit 兜底——SIGTERM/SIGINT 优雅路径走 subproc.shutdown()，
  // 但「stdin 关闭等自然退出 / uncaughtException 后 exit」不触发信号处理器，
  // 受管子进程（chrome-devtools-mcp / rust-helper）会变 ppid=1 孤儿（wave1 T-BROWSE-24）。
  // process.on("exit") 钩子必须同步 → killAllSync 零 await best-effort SIGKILL 残留 pid。
  process.on("exit", () => {
    // v1.9（parse17 §3.6 机制二）：exit 钩子同步收尾台账 Chrome（零 await 纪律，
    // W1-DEF-6 先例——同步版跳过 SIGTERM 优雅步，ps 验证归属后 killTreeSync 直杀）。
    try {
      stopLaunchedChromesSync((p) => logger.info(p));
    } catch {
      // best-effort：exit 钩子绝不能抛
    }
    subproc.killAllSync();
  });
}

// ============================================================
// v1.8 Phase D（F-CLI-01）：CLI 惯例 —— --version / --help / 未知子命令 usage
// ============================================================
const CLI_USAGE = [
  "lasso-mcp — Claude Code 全交互对外抓手 MCP（search / browse / logged_in / desktop）",
  "",
  "Usage:",
  "  lasso-mcp                                    Start MCP stdio server (default mode; used by",
  "                                               `claude mcp add lasso -- npx -y lasso-mcp`)",
  "  lasso-mcp doctor [--stealth-check] [--deep]    Run environment/health checks, print JSON report",
  "  lasso-mcp config <init|path>                 Create / locate ~/.lasso/config.json",
  "  lasso-mcp launch-chrome [--port N] [--profile <dir>]",
  "                                               [--mode hidden|visible] [--idle-ms N]",
  "                                               Launch a debug-enabled Chrome for logged_in channel",
  "                                               (default hidden: zero window, no focus steal;",
  "  lasso-mcp chrome-stop [--port N | --all]     Close lasso-launched Chrome(s) recorded in the",
  "                                               on-disk ledger (pid ownership verified via cmdline)",
  "  lasso-mcp replay-baseline [--strict]         Re-run SERP extraction baseline regression",
  "  lasso-mcp --version | -v                     Print version",
  "  lasso-mcp --help | -h                        Print this usage",
  "",
  "Flags:",
  "  --stealth-check   (doctor) opt in to the creepjs stealth regression gate",
  "                    (opens a headless browser and touches the network)",
  "  --deep            (doctor) opt in to the Brave plan-level active probe",
  "                    (sends ONE minimal real request, consuming 1 unit of quota;",
  "                    env equivalent: LASSO_DOCTOR_DEEP=1)",
].join("\n");

/**
 * F-CLI-01：`--version` / `-v` —— 输出版本号 exit 0。
 *
 * 版本读 package.json（单一真源；dist/index.js → ../package.json 对 repo 与
 * node_modules 安装两种布局都成立）。读失败（打包缺文件等）fallback 到
 * 编译期 LASSO_SERVER_VERSION，仍 exit 0。
 */
async function printVersionAndExit(): Promise<void> {
  let version = LASSO_SERVER_VERSION;
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    version = (
      JSON.parse(await fsReadFile(pkgPath, "utf8")) as { version: string }
    ).version;
  } catch {
    // fallback 到编译期常量（INV-63 三处对齐保证二者一致）
  }
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  // F-CLI-01（v1.8 Phase D）：--version / -v（输出版本号 exit 0）
  // 注：子命令 dispatch 保持 process.argv[2] 直读字面量（INV-71 (c) grep 守护点）。
  if (process.argv[2] === "--version" || process.argv[2] === "-v") {
    await printVersionAndExit();
    return;
  }
  // F-CLI-01：--help / -h / help（usage → stdout，exit 0）
  if (process.argv[2] === "--help" || process.argv[2] === "-h" || process.argv[2] === "help") {
    process.stdout.write(CLI_USAGE + "\n");
    process.exit(0);
    return;
  }
  // CLI: `lasso doctor [--stealth-check] [--deep]`（v1.14 S-3 加 --deep：Brave 计划级探测）
  if (process.argv[2] === "doctor") {
    await runDoctorCli(process.argv.slice(3));
    return;
  }
  // v1.3 Phase A：`lasso config <init|path>`
  // 守用户硬约束：安装命令无配置（claude mcp add lasso -- npx -y lasso-mcp 不带 -e）；
  //              要新增配置时跑 `lasso config init` 创建 ~/.lasso/config.json 改文件配。
  if (process.argv[2] === "config") {
    await runConfigCli(process.argv.slice(3));
    return;
  }
  // v1.0 Phase D（parse11 §3.3 + §7.2）：`lasso launch-chrome [--port N] [--profile <dir>]`
  // 跨平台 Chrome launcher 子命令。runLaunchChromeCli 默认读 process.argv.slice(3)。
  // v1.10（parse18 §2.6）：先 loadConfig 把 config.json 文件层默认（launchMode/
  // launchIdleMs）传给 CLI——~/.lasso/config.json 对 CLI 也生效；argv flag 最高优先。
  if (process.argv[2] === "launch-chrome") {
    const cliCfg = loadConfig({ runId: "launch-chrome-cli" });
    await runLaunchChromeCli(process.argv.slice(3), {
      launchMode: cliCfg.launchMode,
      idleMs: cliCfg.launchIdleMs,
    });
    return;
  }
  // v1.9（parse17 §3.6 机制二）：`lasso chrome-stop [--port N|--all]` —— 按磁盘台账
  // 收尾 launch-chrome 起的 Chrome（cmdline 验证归属后才杀；幂等 exit 0）。
  if (process.argv[2] === "chrome-stop") {
    await runChromeStopCli();
    return;
  }
  // v1.0 Phase C（parse11 §3.2 + §7.2）：`lasso replay-baseline [--strict]`
  // 录制回放回归 runner 子命令（CI 用 + 用户本地跑）。runReplayBaselineCli 默认读 slice(3)。
  if (process.argv[2] === "replay-baseline") {
    await runReplayBaselineCli();
    return;
  }
  // F-CLI-01：白名单外参数不再静默落入 MCP server 模式（此前 stdout 0 字节、
  // 终端挂起等 stdin —— wave1 entry-cli 面板实锤）。usage → stderr，exit 1。
  if (process.argv[2] !== undefined) {
    process.stderr.write(
      `unknown subcommand or flag: ${process.argv[2]}\n\n${CLI_USAGE}\n`,
    );
    process.exit(1);
    return;
  }
  await runMcpServer();
}

main().catch((err) => {
  logger.error({ evt: "lasso_fatal", error: String(err) });
  process.exit(1);
});
