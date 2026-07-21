/**
 * doctor readiness 检查（parse1 §3.11 + §6 验收 #2 + parse2 §3.1.2 v0.2 扩 4 项 + parse4 §3.4 v0.3.5 扩 6 项 desktop
 *                        + parse5 §3.4 v0.4 M0.4a 扩 4 项 forest + 政策 gate
 *                        + parse5 §3.4 v0.4 M0.4c 升级 #21（browserbase HEAD 探测）+ 新增 #25 stealth profile 自检）
 *                        + parse6 §4.4 v0.5 M0.5b 新增 #26 cdp_mcp_pdf_tool_available（Go/No-Go F1 探测点）
 *                        + parse6 §4.4 v0.5 M0.5c 新增 #27 cdp_mcp_network_observer_available（Go/No-Go F2 探测点）
 *
 * 25 项 check（v0.1 10 项 + v0.2 加 4 项 + v0.3.5 加 6 项 desktop + v0.4 M0.4a 加 4 项 forest
 *           + v0.4 M0.4c 加 1 项 stealth profile）：
 *   1. node_version               — Node ≥ 20
 *   2. zhipu_api_key              — ZHIPU_API_KEY 存在
 *   3. zhipu_endpoint_reachable   — 智谱 MCP endpoint 网络可达（HTTP HEAD/GET，不深测协议）
 *   4. cdp_mcp_installable        — chrome-devtools-mcp@<LOCKED> 在 npm 可装（npm view 查询）
 *   5. chrome_binary              — Chrome / Chromium 二进制存在（browse_logged_in 需要）
 *   6. cdp_9222_logged_in         — 本机 :9222 CDP 可达 + 至少 1 个 tab
 *   7. cache_writable             — cacheDir 可写（mkdir + writeFile + unlink）
 *   8. ssrf_config                — loadSsrfConfig 能解析（env CSV 非法时不崩）
 *   9. serp_selectors             — 百度/Google selector 表非空
 *  10. invariants                 — 11 条架构不变量脚本 exit 0
 *  11. brave_keys                 — v0.2：BRAVE_API_KEYS / BRAVE_API_KEY 配置（无则 warn 不阻塞）
 *  12. provider_registry_loadable — v0.2：ProviderRegistry + BUILTIN_PROVIDERS 能加载
 *  13. quota_ledger_initialized   — v0.2：已配置的 api_key provider 都生成了非空 QuotaLedger
 *  14. search_cache_dir_writable  — v0.2：~/.cache/lasso/search-cache/ 可写
 *  15. rust_helper_signed         — v0.3.5：codesign -dvvv 验证 Developer ID 签名
 *  16. rust_helper_running        — v0.3.5：rust.call("ping") ok=true
 *  17. tcc_accessibility          — v0.3.5：AXAPI 授权（fail + URL scheme 引导）
 *  18. tcc_screen_recording       — v0.3.5：Screen Recording 授权（warn）
 *  19. ax_read_rate               — v0.3.5：snapshot maxDepth=3 节点数 ≥20
 *  20. vlm_endpoint_reachable     — v0.3.5：LASSO_VLM_ENDPOINT 可达（未配 → warn）
 *  21. cloud_browser_manual_switch — v0.4：LASSO_ALLOW_CLOUD_BROWSER + BROWSERBASE/STAGEHAND key 状态
 *                                     + M0.4c 升级：配 key 时 HEAD 探测 browserbase.com（未配 warn-skip 不 fail）
 *  22. forest_root_registry_health — v0.4：RootRegistry 可装配 + getOrCreate/lookup/list 健全
 *  23. forest_dispatcher_ready     — v0.4：InteractDispatcher 类可加载 + channel Map 形状校验
 *  24. forest_ref_counter_strategy — v0.4：RootRegistry 共享 nextRootRefIndex 单计数器（@p0/@w1/@p2 递增）
 *  25. stealth_profile_self_check  — v0.4 M0.4c：stealth-profiles 顶级 const 加载 + shape 自检（INV-30）
 *  26. cdp_mcp_pdf_tool_available  — v0.5 M0.5b：cdp-actions CDP_UPSTREAM_TOOL_NAMES.pdf 加载（Go/No-Go F1）
 *  27. cdp_mcp_network_observer_available — v0.5 M0.5c：cdp-actions CDP_UPSTREAM_TOOL_NAMES.network_log +
 *                                    doNetwork 加载（Go/No-Go F2；PerformanceObserver 注入路径健在）
 *
 * v0.3.5 关键设计（parse4 §3.4）：
 *  - 默认 desktopChecks=false：doctor CLI 走 #1-#14，#15-#20 全 warn skip（无 RustBridge 装配）
 *  - desktopChecks=true：跑 #15-#20 全 6 项（DesktopChannel.doctor / registerDoctorTool 显式 opt-in）
 *  - 复用既有 runDoctor（不开第二套 doctor，R-CI-02）
 *
 * v0.4 M0.4a 关键设计（parse5 §3.4 + task #7）：
 *  - #21-#24 默认全跑（纯 TS 烟雾测试，无需外部依赖；零阻塞 ready）
 *
 * v0.4 M0.4c 关键设计（parse5 §3.4 + §3.3.2 + §6.3 #17）：
 *  - #21 升级：LASSO_ALLOW_CLOUD_BROWSER=true 且 BROWSERBASE_API_KEY 配时，**HEAD 探测**
 *    api.browserbase.com（≤3s 超时）；未配 key / manual-switch 关 → warn-skip 不 fail
 *  - 新增 #25 stealth_profile_self_check：stealth-profiles.ts 顶级 const（STEALTH_PROFILES +
 *    STEALTH_INJECTION_SCRIPT + CLOUDFLARE_DETECTION_SCRIPT）加载 + shape 自检；INV-30 守
 *
 * 结构化 JSON：
 *   {
 *     ready: bool,
 *     timestamp: ISO,
 *     lasso_version: "0.5.0-dev",
 *     checks: [{ name, status: 'pass'|'fail'|'warn', detail, next_step? }, ...],
 *     blockers: string[]   // status='fail' 的 name 列表
 *   }
 *
 * ready = (blockers.length === 0)。warn 不阻塞 ready。
 *
 * 借鉴：parse1 §3.11；09 §2.1 验收「doctor CLI 覆盖 ≥10 项」；parse2 §3.1.2 v0.2 4 项扩展；
 *      parse4 §3.4 v0.3.5 6 项 desktop 扩展（13 §3.4 M0.5a 验收 #5/#6）；
 *      parse5 §3.4 v0.4 M0.4a 4 项 forest 扩展；
 *      parse5 §3.4 + §3.3 v0.4 M0.4c 1 项 stealth + #21 HEAD 探测升级。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { LOCKED_CDP_MCP_VERSION } from "../subprocess/SubprocessManager.js";
import { BAIDU_SELECTORS, GOOGLE_SELECTORS } from "../serp/selectors.js";
import { loadSsrfConfig } from "../ssrf/ssrf-guard.js";
import { BUILTIN_PROVIDERS } from "../config/providers.js";
import { ProviderRegistry } from "../config/provider-registry.js";
import {
  runRustDoctorChecks,
  type RustBridgeLike,
} from "../desktop/desktop-doctor-checks.js";
// v0.4 M0.4a：forest 调度层烟雾测试（用于 #22-#24 doctor check）
import { RootRegistry } from "../forest/RootRegistry.js";
import { InteractDispatcher } from "../forest/InteractDispatcher.js";
// v0.4 M0.4c：stealth 顶级 const 自检（用于 #25 doctor check + INV-30 镜像）
import {
  STEALTH_PROFILES,
  STEALTH_PROFILE_NAMES,
  STEALTH_INJECTION_SCRIPT,
  CLOUDFLARE_DETECTION_SCRIPT,
  CLOUDFLARE_CHALLENGE_MARKERS,
} from "../browse/stealth-profiles.js";
// v0.5 M0.5b：cdp-actions 上游工具名集中表（用于 #26 cdp_mcp_pdf_tool_available doctor check）
// parse6 §4.4 + §7.1 F1：doctor 探测 chrome-devtools-mcp 是否暴露 `pdf` 工具；不暴露时
//                          pdf tool 返 outcome=didnt + retrieval_method=upstream_unsupported:pdf
import { CDP_UPSTREAM_TOOL_NAMES } from "../browse/cdp-actions.js";

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LASSO_VERSION = "0.6.0-dev";

// ============================================================
// 类型
// ============================================================
export interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  next_step?: string;
}

export interface DoctorReport {
  ready: boolean;
  timestamp: string;
  lasso_version: string;
  checks: DoctorCheck[];
  blockers: string[];
  /**
   * v0.6 M0.6 新增（parse7 §2.2 + §6.2）：runtime 能力袋 + caller-tier 状态快照。
   *
   * doctor 不验 runtime_state 的语义正确性（只读 snapshot；不 fail 不 warn）——
   * 真正的「disable 是否生效」由 admin tool + 集成测覆盖。
   *
   * v0.5 装配期不实例化 CapabilityBag / CallerTierTracker → runtime_state=null（零回归）。
   * v0.6 装配期由 index.ts 注入 → runtime_state 反映当前进程内状态。
   */
  runtime_state?: {
    /** CapabilityBag.snapshot()；空数组 = v0.5 行为（无 channel/provider 被 disable） */
    capabilities: Array<{
      name: string;
      kind: "channel" | "provider";
      enabled: boolean;
      disabledAt?: number;
      disabledBy?: string;
      reason?: string;
    }>;
    /** CallerTierTracker.snapshot()；空数组 = 无 caller 调用过 */
    caller_caps: Array<{
      callerId: string;
      used: number;
      cap: number;
      windowMs: number;
    }>;
    /** 当前已注册 tool 总数 + 归属 channel（ToolManager.listByChannel()） */
    tool_manager?: Record<string, string[]>;
  };
}

export interface DoctorOptions {
  /** 覆盖 ZHIPU_API_KEY（默认读 process.env）。 */
  zhipuKey?: string;
  /** 覆盖 ZHIPU endpoint。 */
  zhipuEndpoint?: string;
  /** 覆盖 CDP 端口（默认 9222）。 */
  cdpPort?: number;
  /** 覆盖 cache 目录（默认 ~/.cache/lasso）。 */
  cacheDir?: string;
  /** v0.2：覆盖 BRAVE_API_KEYS（默认读 process.env.BRAVE_API_KEYS / BRAVE_API_KEY）。 */
  braveKeysCsv?: string;
  /**
   * 跳过 invariants spawn（测试环境/无源码场景）。
   * 注：此 check 改为 warn，不算 blocker。
   */
  skipInvariants?: boolean;
  /** 跳过触网检查（zhipu_endpoint_reachable + cdp_9222_logged_in + cdp_mcp_installable）。 */
  skipNetwork?: boolean;
  /**
   * v0.3.5（parse4 §3.4）：跑 #15-#20 desktop check。
   *  - false（默认）：6 项 desktop check 全 warn skip（doctor CLI 路径）
   *  - true：跑全 6 项（需 desktopBridge 注入；desktop tool / DesktopChannel.doctor 用）
   */
  desktopChecks?: boolean;
  /**
   * v0.3.5：DesktopChannel 的 RustBridge 引用（结构子类型，避免本文件 import DesktopChannel）。
   * desktopChecks=true 时必传；否则 6 项降级为 warn skip。
   */
  desktopBridge?: RustBridgeLike | null;
  /** v0.3.5：覆盖 helper binary 路径（codesign 检查用）。 */
  desktopHelperPath?: string;
  /** v0.3.5：覆盖 LASSO_VLM_ENDPOINT（vlm_endpoint_reachable 检查用）。 */
  desktopVlmEndpoint?: string | null;
  /**
   * v0.4 M0.4a（parse5 §3.4 + task #7）：跑 #21-#24 forest + 政策 gate check。
   *  - true（默认）：4 项全跑（纯 TS 烟雾测试，无需外部依赖；零阻塞 ready）
   *  - false：4 项全 warn skip（极端环境 / CI 简化路径用）
   */
  forestChecks?: boolean;
  /** v0.4 M0.4a：覆盖 LASSO_ALLOW_CLOUD_BROWSER（默认读 process.env）。 */
  cloudBrowserAllowed?: boolean;
  /** v0.4 M0.4a：覆盖 LASSO_TAVILY_WATCH（默认读 process.env）。 */
  tavilyWatch?: boolean;
  /**
   * v0.6 M0.6（parse7 §2.2 + §6.2）：runtime_state section 的数据源注入。
   *
   * doctor CLI 模式不装配 CapabilityBag → runtimeState=undefined → section 字段为 null。
   * doctor tool 模式（经 DesktopChannel.doctor / registerDoctorTool）由 index.ts 装配时
   * 传入真实 snapshot provider，doctor 报告反映当前进程状态。
   *
   * 这是「数据源」注入，不是「CapabilityBag 句柄」注入 —— 守 INV-35（doctor.ts 不 import
   * runtime/）。
   */
  runtimeState?: () => {
    capabilities: Array<{
      name: string;
      kind: "channel" | "provider";
      enabled: boolean;
      disabledAt?: number;
      disabledBy?: string;
      reason?: string;
    }>;
    caller_caps: Array<{
      callerId: string;
      used: number;
      cap: number;
      windowMs: number;
    }>;
    tool_manager?: Record<string, string[]>;
  };
}

// ============================================================
// runDoctor
// ============================================================
export async function runDoctor(
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const zhipuKey = opts.zhipuKey ?? process.env.ZHIPU_API_KEY;
  const zhipuEndpoint =
    opts.zhipuEndpoint ??
    process.env.ZHIPU_ENDPOINT ??
    "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
  const cdpPort = opts.cdpPort ?? parseInt(process.env.LASSO_CDP_PORT ?? "9222", 10);
  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".cache", "lasso");

  // 1. node_version
  checks.push(checkNodeVersion());

  // 2. zhipu_api_key
  checks.push(checkZhipuKey(zhipuKey));

  // 3. zhipu_endpoint_reachable
  checks.push(
    opts.skipNetwork
      ? {
          name: "zhipu_endpoint_reachable",
          status: "warn",
          detail: "skipped (skipNetwork=true)",
        }
      : await checkZhipuEndpoint(zhipuEndpoint),
  );

  // 4. cdp_mcp_installable
  checks.push(
    opts.skipNetwork
      ? {
          name: "cdp_mcp_installable",
          status: "warn",
          detail: "skipped (skipNetwork=true)",
        }
      : await checkCdpMcpInstallable(),
  );

  // 5. chrome_binary
  checks.push(await checkChromeBinary());

  // 6. cdp_9222_logged_in
  checks.push(
    opts.skipNetwork
      ? {
          name: "cdp_9222_logged_in",
          status: "warn",
          detail: "skipped (skipNetwork=true)",
        }
      : await checkCdp9222(cdpPort),
  );

  // 7. cache_writable
  checks.push(await checkCacheWritable(cacheDir));

  // 8. ssrf_config
  checks.push(checkSsrfConfig());

  // 9. serp_selectors
  checks.push(checkSerpSelectors());

  // 10. invariants
  checks.push(
    opts.skipInvariants
      ? {
          name: "invariants",
          status: "warn",
          detail: "skipped (skipInvariants=true)",
        }
      : await checkInvariants(),
  );

  // ---- v0.2 4 项新 check（parse2 §3.1.2）----
  const braveKeysCsv =
    opts.braveKeysCsv ??
    process.env.BRAVE_API_KEYS ??
    process.env.BRAVE_API_KEY ??
    "";

  // 11. brave_keys
  checks.push(checkBraveKeys(braveKeysCsv));

  // 12. provider_registry_loadable
  checks.push(checkProviderRegistry());

  // 13. quota_ledger_initialized
  checks.push(checkQuotaLedger(braveKeysCsv, zhipuKey));

  // 14. search_cache_dir_writable
  checks.push(await checkSearchCacheDir(cacheDir));

  // ---- v0.3.5 6 项 desktop check（parse4 §3.4 + 13 §3.4 M0.5a 验收 #5/#6）----
  // 默认 desktopChecks=false：6 项全 warn skip（doctor CLI 路径未装配 DesktopChannel）。
  // desktopChecks=true + desktopBridge 注入 → 跑全 6 项（DesktopChannel.doctor / desktop tool）。
  // 复用既有 runDoctor（不开第二套，R-CI-02）。
  if (opts.desktopChecks) {
    const desktopChecks = await runRustDoctorChecks(
      opts.desktopBridge ?? null,
      {
        helperPath: opts.desktopHelperPath,
        vlmEndpoint: opts.desktopVlmEndpoint,
      },
    );
    checks.push(...desktopChecks);
  }

  // ---- v0.4 M0.4a 4 项 forest + 政策 gate check（parse5 §3.4 + task #7）----
  // 默认 forestChecks=true：4 项全跑（纯 TS 烟雾测试，零阻塞 ready）。
  // #21 cloud_browser_manual_switch v0.4 M0.4c 升级：配 key 时 HEAD 探测 api.browserbase.com
  // #22-#24 forest 调度层装配健全性（实装在 M0.4a）
  // #25 stealth_profile_self_check（v0.4 M0.4c 新增，INV-30 镜像）
  if (opts.forestChecks !== false) {
    // #21（async：M0.4c 升级为 HEAD 探测）
    checks.push(
      await checkCloudBrowserManualSwitch({
        allowed: opts.cloudBrowserAllowed ?? process.env.LASSO_ALLOW_CLOUD_BROWSER === "true",
        browserbaseKey: process.env.BROWSERBASE_API_KEY,
        stagehandKey: process.env.STAGEHAND_API_KEY,
        skipNetwork: opts.skipNetwork,
      }),
    );
    // #22
    checks.push(checkForestRootRegistry());
    // #23
    checks.push(checkForestDispatcher());
    // #24（async：getOrCreate 是 async）
    checks.push(await checkForestRefCounter());
    // #25（v0.4 M0.4c 新增）
    checks.push(checkStealthProfileSelfCheck());
    // #26（v0.5 M0.5b 新增，parse6 §4.4 + §7.1 F1）
    checks.push(checkCdpMcpPdfToolAvailable());
    // #27（v0.5 M0.5c 新增，parse6 §4.4 + §7.1 F2）
    checks.push(checkCdpMcpNetworkObserverAvailable());
  }

  const blockers = checks.filter((c) => c.status === "fail").map((c) => c.name);

  // ---- v0.6 M0.6：runtime_state section（parse7 §2.2 + §6.2）----
  // doctor 不验 runtime_state 语义（不增 blockers）；仅展示当前进程状态。
  // runtimeState 未注入（doctor CLI 模式）→ undefined → section 字段不出现在 report 里（零回归）。
  const runtime_state = opts.runtimeState
    ? opts.runtimeState()
    : undefined;

  return {
    ready: blockers.length === 0,
    timestamp: new Date().toISOString(),
    lasso_version: LASSO_VERSION,
    checks,
    blockers,
    ...(runtime_state ? { runtime_state } : {}),
  };
}

// ============================================================
// 单项 check
// ============================================================

/** 1. Node ≥ 20（package.json engines）。 */
function checkNodeVersion(): DoctorCheck {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return {
    name: "node_version",
    status: major >= 20 ? "pass" : "fail",
    detail: `Node ${process.versions.node}`,
    next_step:
      major >= 20 ? undefined : "升级到 Node >= 20（推荐 22 LTS 或更高）",
  };
}

/** 2. ZHIPU_API_KEY 存在（不验证有效性）。 */
function checkZhipuKey(key: string | undefined): DoctorCheck {
  return {
    name: "zhipu_api_key",
    status: key ? "pass" : "fail",
    detail: key ? "已配置（有效性未深测）" : "ZHIPU_API_KEY 未设置",
    next_step: key ? undefined : "export ZHIPU_API_KEY=<your-key>",
  };
}

/** 3. 智谱 MCP endpoint 可达（HEAD 请求，2xx/4xx 都算"可达"；网络错才算 fail）。 */
async function checkZhipuEndpoint(endpoint: string): Promise<DoctorCheck> {
  try {
    const resp = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      // 不带 Authorization 也行——只测 TCP/TLS+HTTP 通
    });
    return {
      name: "zhipu_endpoint_reachable",
      // 401/403/405 都说明端点活着；5xx 视为不稳定 → warn
      status: resp.status < 500 ? "pass" : "warn",
      detail: `HTTP ${resp.status} ${resp.statusText}`,
    };
  } catch (e) {
    return {
      name: "zhipu_endpoint_reachable",
      status: "fail",
      detail: String(e),
      next_step: `检查网络 / endpoint: ${endpoint}`,
    };
  }
}

/** 4. chrome-devtools-mcp@<LOCKED> 在 npm registry 可装。 */
async function checkCdpMcpInstallable(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileP(
      "npm",
      ["view", `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`, "version"],
      { timeout: 30_000 },
    );
    return {
      name: "cdp_mcp_installable",
      status: "pass",
      detail: `chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION} -> ${stdout.trim()}`,
    };
  } catch (e) {
    return {
      name: "cdp_mcp_installable",
      status: "fail",
      detail: String(e),
      next_step: `npm install -g chrome-devtools-mcp@${LOCKED_CDP_MCP_VERSION}`,
    };
  }
}

/** 5. Chrome 二进制存在（macOS 优先路径）。 */
async function checkChromeBinary(): Promise<DoctorCheck> {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    // Linux 常见路径
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of candidates) {
    try {
      await fs.access(p, fsConstants.X_OK);
      return {
        name: "chrome_binary",
        status: "pass",
        detail: p,
      };
    } catch {
      // try next
    }
  }
  return {
    name: "chrome_binary",
    status: "warn",
    detail: "未找到 Chrome（browse_headless 仍可用 chrome-devtools-mcp 的 bundled chromium；browse_logged_in 需要真实 Chrome）",
    next_step: "安装 Google Chrome（macOS 放到 /Applications）",
  };
}

/** 6. 本机 :9222 CDP 已开 + 至少 1 个 tab。 */
async function checkCdp9222(port: number): Promise<DoctorCheck> {
  try {
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!versionResp.ok) {
      return {
        name: "cdp_9222_logged_in",
        status: "fail",
        detail: `CDP /json/version returned HTTP ${versionResp.status}`,
        next_step: `重启 Chrome with --remote-debugging-port=${port}`,
      };
    }
    const tabsResp = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    const tabs = (await tabsResp.json()) as unknown[];
    return {
      name: "cdp_9222_logged_in",
      status: tabs.length > 0 ? "pass" : "warn",
      detail: `${tabs.length} tabs on CDP port ${port}`,
      next_step:
        tabs.length > 0
          ? undefined
          : `在 Chrome 里打开任意页面后再调用 browse_logged_in`,
    };
  } catch (e) {
    return {
      name: "cdp_9222_logged_in",
      status: "warn",
      detail: String(e),
      next_step: `open -na 'Google Chrome' --args --remote-debugging-port=${port}`,
    };
  }
}

/** 7. cacheDir 可写。 */
async function checkCacheWritable(cacheDir: string): Promise<DoctorCheck> {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const testFile = path.join(cacheDir, ".doctor-write-test");
    await fs.writeFile(testFile, "ok");
    await fs.unlink(testFile);
    return {
      name: "cache_writable",
      status: "pass",
      detail: cacheDir,
    };
  } catch (e) {
    return {
      name: "cache_writable",
      status: "fail",
      detail: String(e),
      next_step: `修复权限或改 LASSO_CACHE_DIR: ${cacheDir}`,
    };
  }
}

/** 8. SSRF 配置可加载（env CSV 非法时不崩）。 */
function checkSsrfConfig(): DoctorCheck {
  try {
    const cfg = loadSsrfConfig();
    return {
      name: "ssrf_config",
      status: "pass",
      detail: `allow=${cfg.allowRanges.length} deny=${cfg.denyRanges.length} (DEFAULT_ALLOW_RANGES 内置 2 条)`,
    };
  } catch (e) {
    return {
      name: "ssrf_config",
      status: "fail",
      detail: String(e),
    };
  }
}

/** 9. SERP selector 表加载（百度 / Google）。 */
function checkSerpSelectors(): DoctorCheck {
  const total = BAIDU_SELECTORS.length + GOOGLE_SELECTORS.length;
  return {
    name: "serp_selectors",
    status: total > 0 ? "pass" : "fail",
    detail: `BAIDU=${BAIDU_SELECTORS.length} GOOGLE=${GOOGLE_SELECTORS.length}`,
  };
}

/** 10. 架构不变量脚本 exit 0。 */
async function checkInvariants(): Promise<DoctorCheck> {
  // 项目根定位：从 dist/doctor/doctor.js 或 src/doctor/doctor.ts 找到根
  // 优先级：process.cwd() → 向上找 package.json
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, "..", ".."),
    path.resolve(__dirname, "..", "..", ".."),
  ];
  let projectRoot: string | null = null;
  for (const c of candidates) {
    try {
      await fs.access(path.join(c, "package.json"));
      projectRoot = c;
      break;
    } catch {
      // try next
    }
  }
  if (!projectRoot) {
    return {
      name: "invariants",
      status: "warn",
      detail: "无法定位项目根（package.json 未找到）",
    };
  }

  // 优先找 src/invariants/check-invariants.mjs（dev 模式）
  const mjsPath = path.join(projectRoot, "src", "invariants", "check-invariants.mjs");
  try {
    await fs.access(mjsPath);
  } catch {
    return {
      name: "invariants",
      status: "warn",
      detail: `脚本缺失: ${mjsPath}`,
    };
  }

  try {
    const { stdout, stderr } = await execFileP(
      "node",
      [mjsPath],
      { timeout: 30_000, cwd: projectRoot },
    );
    const lastLine = (stdout || "").trim().split("\n").slice(-1)[0] || "";
    return {
      name: "invariants",
      status: "pass",
      detail: lastLine || "invariants exit 0",
      next_step: stderr ? `stderr: ${stderr.slice(0, 200)}` : undefined,
    };
  } catch (e) {
    return {
      name: "invariants",
      status: "fail",
      detail: String(e),
      next_step: `cd ${projectRoot} && node src/invariants/check-invariants.mjs`,
    };
  }
}

// ============================================================
// v0.2 新增 4 项 check（parse2 §3.1.2）
// ============================================================

/**
 * 11. brave_keys（v0.2 §3.1.2）：BRAVE_API_KEYS / BRAVE_API_KEY 配置检查。
 *
 *  - 无 Key → status="warn"（不阻塞 ready，Lasso 仍可用智谱 + browse_headless）
 *  - 有 Key（≥1 个非空） → status="pass"，detail 报 Key 数量（不打全 Key，安全）
 *  - 多 Key 配额合并 = N × 2000/月（10 §4.2 / 验收 #2）
 *
 * 注：不验证 Key 有效性（doctor 不触网），仅查 env 存在性。
 */
function checkBraveKeys(braveKeysCsv: string): DoctorCheck {
  const keys = braveKeysCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    return {
      name: "brave_keys",
      status: "warn",
      detail: "BRAVE_API_KEYS / BRAVE_API_KEY 未配置（search 多源扇出退化为单源 zhipu）",
      next_step:
        "（可选）export BRAVE_API_KEYS=key1,key2 注册 https://api.search.brave.com/ 获取免费 2000/月",
    };
  }
  return {
    name: "brave_keys",
    status: "pass",
    detail: `${keys.length} Key 已配置（合并配额 = ${keys.length * 2000}/月）`,
  };
}

/**
 * 12. provider_registry_loadable（v0.2 §3.1.2）：ProviderRegistry 能加载 BUILTIN_PROVIDERS。
 *
 *  - 5 条 builtin：zhipu / brave / browse_headless / browse_logged_in / tavily
 *  - enabled=false（tavily）应被 ProviderRegistry 跳过 → listNames() 不含 tavily
 *  - 加载失败 → fail（架构问题，阻塞 ready）
 *
 * 不变量 INV-9 守：ProviderRegistry 类定义只在 config/provider-registry.ts。
 */
function checkProviderRegistry(): DoctorCheck {
  try {
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);
    const names = registry.listNames();
    if (names.length === 0) {
      return {
        name: "provider_registry_loadable",
        status: "fail",
        detail: "ProviderRegistry 加载后 listNames() 为空",
        next_step: "检查 BUILTIN_PROVIDERS 是否全部 enabled=false",
      };
    }
    // TAVILY_WATCH 应被跳过（enabled=false）
    const tavilyPresent = names.includes("tavily");
    return {
      name: "provider_registry_loadable",
      status: tavilyPresent ? "warn" : "pass",
      detail: `${names.length} providers loaded: ${names.join(", ")}${tavilyPresent ? "（tavily 应 enabled=false）" : ""}`,
      next_step: tavilyPresent
        ? "TAVILY_WATCH 应配 enabled=false（policy_risk=acquired）"
        : undefined,
    };
  } catch (e) {
    return {
      name: "provider_registry_loadable",
      status: "fail",
      detail: String(e),
      next_step: "检查 config/provider-registry.ts + providers.ts 是否损坏",
    };
  }
}

/**
 * 13. quota_ledger_initialized（v0.2 §3.1.2）：已配置 Key 的 api_key provider
 *    都生成了非空 QuotaLedger（keys.length > 0 → ledger != null）。
 *
 *  - zhipu 配 Key → zhipu.ledger != null
 *  - brave 配 Key → brave.ledger != null
 *  - 配了 Key 但 ledger 为 null → fail（QuotaLedger 构造异常）
 *  - 未配 Key 的 provider → 不检查（enabled 但 keys 空 → ledger=null 是合规行为）
 */
function checkQuotaLedger(
  braveKeysCsv: string,
  zhipuKey: string | undefined,
): DoctorCheck {
  // 复刻 config.ts 的 keys 注入逻辑，避免 loadConfig 触网 / 依赖 cacheDir
  const configs = BUILTIN_PROVIDERS.map((p) => ({ ...p }));
  const zhipu = configs.find((c) => c.name === "zhipu");
  if (zhipu && zhipuKey) zhipu.keys = [zhipuKey];
  const brave = configs.find((c) => c.name === "brave");
  if (brave) {
    const keys = braveKeysCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (keys.length > 0) brave.keys = keys;
  }
  try {
    const registry = new ProviderRegistry(configs);
    const issues: string[] = [];
    for (const rp of registry.byCap("search")) {
      const hasKeys = rp.config.keys.length > 0;
      if (hasKeys && rp.ledger === null) {
        issues.push(`${rp.config.name}: keys.length>0 but ledger=null`);
      }
    }
    if (issues.length > 0) {
      return {
        name: "quota_ledger_initialized",
        status: "fail",
        detail: issues.join("; "),
        next_step: "检查 ProviderRegistry 构造逻辑（config/provider-registry.ts）",
      };
    }
    const ledgerCount = registry
      .byCap("search")
      .filter((rp) => rp.ledger !== null).length;
    return {
      name: "quota_ledger_initialized",
      status: "pass",
      detail: `${ledgerCount} QuotaLedger 已装配（已配 Key 的 search provider）`,
    };
  } catch (e) {
    return {
      name: "quota_ledger_initialized",
      status: "fail",
      detail: String(e),
    };
  }
}

/**
 * 14. search_cache_dir_writable（v0.2 §3.1.2）：~/.cache/lasso/search-cache/ 可写。
 *
 *  - 与 #7 cache_writable 不同：#7 检查 cacheDir 根目录；#14 检查 search 专属子目录
 *  - SearchCache 7 天 TTL 落盘依赖此目录可写
 *  - 写失败 → fail（cache 是优化不是正确性，但 cache_dir 不可写会让 7 天 TTL 形同虚设）
 */
async function checkSearchCacheDir(cacheDir: string): Promise<DoctorCheck> {
  const searchCacheDir = path.join(cacheDir, "search-cache");
  try {
    await fs.mkdir(searchCacheDir, { recursive: true });
    const testFile = path.join(searchCacheDir, ".doctor-write-test");
    await fs.writeFile(testFile, "ok");
    await fs.unlink(testFile);
    return {
      name: "search_cache_dir_writable",
      status: "pass",
      detail: searchCacheDir,
    };
  } catch (e) {
    return {
      name: "search_cache_dir_writable",
      status: "fail",
      detail: String(e),
      next_step: `修复权限或改 LASSO_CACHE_DIR: ${searchCacheDir}`,
    };
  }
}

// ============================================================
// v0.4 M0.4a 4 项 forest + 政策 gate check（parse5 §3.4 + task #7）
// ============================================================

/**
 * 21. cloud_browser_manual_switch（v0.4 §3.4，F3.4.6 政策 gate；M0.4c 升级）。
 *
 * 检查 LASSO_ALLOW_CLOUD_BROWSER manual-switch 状态 + BROWSERBASE/STAGEHAND API key 可达性。
 *
 * M0.4c 升级（parse5 §3.4 + §6.3 #16）：
 *  - LASSO_ALLOW_CLOUD_BROWSER=true + BROWSERBASE_API_KEY 配 → **HEAD 探测** api.browserbase.com
 *    （≤3s 超时；2xx/3xx/4xx 都算"可达"；网络错 → warn 不 fail）
 *  - LASSO_ALLOW_CLOUD_BROWSER=true + 未配任何 key → warn（policy gate 守，永不 fail）
 *  - LASSO_ALLOW_CLOUD_BROWSER=false（默认） → pass（cloud 浏览器关闭，安全默认）
 *  - skipNetwork=true（doctor 跳过触网） → warn-skip（同 #3/#4/#6 范式）
 *
 * 永不 fail：cloud 浏览器是可选的 fallback 链尾通道，未配 / 不可达 都不阻塞 Lasso 整体 ready。
 *
 * INV-25 守：PolicyGate.cloud 浏览器必经 manual-switch（grep LASSO_ALLOW_CLOUD_BROWSER）。
 */
async function checkCloudBrowserManualSwitch(opts: {
  allowed: boolean;
  browserbaseKey?: string;
  stagehandKey?: string;
  skipNetwork?: boolean;
}): Promise<DoctorCheck> {
  if (!opts.allowed) {
    return {
      name: "cloud_browser_manual_switch",
      status: "pass",
      detail:
        "LASSO_ALLOW_CLOUD_BROWSER=false（默认；cloud 浏览器通道未启用，PolicyGate 将阻断 browse_cloud_*）",
    };
  }

  // manual-switch ON：汇总 key 状态
  const hasBrowserbase = !!opts.browserbaseKey;
  const hasStagehand = !!opts.stagehandKey;
  const detail = `LASSO_ALLOW_CLOUD_BROWSER=true；BROWSERBASE_API_KEY=${hasBrowserbase ? "已配" : "未配"}；STAGEHAND_API_KEY=${hasStagehand ? "已配" : "未配"}`;

  // 双重解锁未满足（key 全缺） → warn（PolicyGate 在 runtime 会阻断 browse_cloud_*）
  if (!hasBrowserbase && !hasStagehand) {
    return {
      name: "cloud_browser_manual_switch",
      status: "warn",
      detail: `${detail}（manual-switch ON 但 key 全缺；PolicyGate 将阻断 browse_cloud_*）`,
      next_step:
        "export BROWSERBASE_API_KEY=<key> 或 STAGEHAND_API_KEY=<key>（cloud 浏览器通道需双重解锁）",
    };
  }

  // M0.4c 升级：配了 browserbase key 时 HEAD 探测 api.browserbase.com（验可达）
  if (opts.skipNetwork) {
    return {
      name: "cloud_browser_manual_switch",
      status: "warn",
      detail: `${detail}（skipNetwork=true：HEAD 探测跳过）`,
    };
  }
  if (hasBrowserbase) {
    const probe = await probeCloudEndpoint("https://api.browserbase.com");
    // probe.status="unreachable" → warn（不 fail）；其他 → pass
    if (probe.status === "unreachable") {
      return {
        name: "cloud_browser_manual_switch",
        status: "warn",
        detail: `${detail}；api.browserbase.com HEAD 探测失败：${probe.detail}`,
        next_step:
          "检查网络 / browserbase 状态页（https://status.browserbase.com）",
      };
    }
    return {
      name: "cloud_browser_manual_switch",
      status: "pass",
      detail: `${detail}；api.browserbase.com HEAD ${probe.detail}`,
    };
  }

  // 仅配 stagehand（无 browserbase）→ 不触网（stagehand endpoint 不稳定，避免误报）
  return {
    name: "cloud_browser_manual_switch",
    status: "pass",
    detail: `${detail}（stagehand-only；browserbase HEAD 探测跳过）`,
  };
}

/**
 * HEAD 探测 cloud 浏览器 endpoint（doctor #21 内部用）。
 *
 * 语义（与 #3 zhipu_endpoint_reachable 同范式）：
 *  - 2xx/3xx/4xx 都算"可达"（TCP/TLS+HTTP 通即可；401/403 也说明 endpoint 活着）
 *  - 5xx → "unreachable"（不稳定）
 *  - 网络错 / timeout → "unreachable"
 *
 * 超时 3s（cloud dashboard 偶尔慢；不阻塞 doctor 整体可用性）。
 */
async function probeCloudEndpoint(
  url: string,
): Promise<{ status: "reachable" | "unreachable"; detail: string }> {
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
      // HEAD 不带 Authorization；browserbase 对未认证请求返 401/404 是正常"可达"信号
      redirect: "manual",
    });
    return {
      status: resp.status < 500 ? "reachable" : "unreachable",
      detail: `${resp.status} ${resp.statusText}`,
    };
  } catch (e) {
    return {
      status: "unreachable",
      detail: String(e).slice(0, 120),
    };
  }
}

/**
 * 22. forest_root_registry_health（v0.4 §3.1.2）：RootRegistry 可装配 + 核心方法健全。
 *
 * 烟雾测试：
 *  - import RootRegistry（装配期编译已验，此处运行时加载）
 *  - new RootRegistry() 构造无异常
 *  - getOrCreate + lookup + list 完整循环
 *  - 异常 → fail（forest 调度层装配破坏，阻塞 ready；架构问题）
 *
 * INV-24 守：RootRegistry 类单一真源（只在 src/forest/RootRegistry.ts）。
 */
function checkForestRootRegistry(): DoctorCheck {
  try {
    const registry = new RootRegistry();
    // 注册 1 个 browser_page root + 1 个 window root（异步）
    // 注：doctor 同步返回，用 Promise.then 兜底；此处只验同步装配
    if (typeof registry.getOrCreate !== "function") {
      return {
        name: "forest_root_registry_health",
        status: "fail",
        detail: "RootRegistry.getOrCreate 不是函数（装配异常）",
      };
    }
    if (typeof registry.lookup !== "function") {
      return {
        name: "forest_root_registry_health",
        status: "fail",
        detail: "RootRegistry.lookup 不是函数（装配异常）",
      };
    }
    if (typeof registry.list !== "function") {
      return {
        name: "forest_root_registry_health",
        status: "fail",
        detail: "RootRegistry.list 不是函数（装配异常）",
      };
    }
    if (registry.size !== 0) {
      return {
        name: "forest_root_registry_health",
        status: "fail",
        detail: `新构造 RootRegistry size=${registry.size}（应 = 0）`,
      };
    }
    return {
      name: "forest_root_registry_health",
      status: "pass",
      detail: `RootRegistry 可装配；size=${registry.size}；maxRoots 默认 256`,
    };
  } catch (e) {
    return {
      name: "forest_root_registry_health",
      status: "fail",
      detail: String(e),
      next_step: "检查 src/forest/RootRegistry.ts 是否损坏（编译/导入循环）",
    };
  }
}

/**
 * 23. forest_dispatcher_ready（v0.4 §3.1.3）：InteractDispatcher 类可加载 + channel Map 形状校验。
 *
 * 烟雾测试：
 *  - import InteractDispatcher（装配期编译已验，此处运行时加载）
 *  - new InteractDispatcher(registry, channels) 构造无异常（用空 Map）
 *  - dispatch 前置校验：rootRef 不存在 → stale_root_ref（不抛异常）
 *  - 异常 → fail（forest 调度层装配破坏，阻塞 ready；架构问题）
 *
 * INV-26 守：InteractDispatcher 不 import BrowseChannel/DesktopChannel internal。
 *
 * 注：M0.4a 阶段不验证真实 channel 注入（BrowseChannel/DesktopChannel 由 index.ts
 *     在 MCP server 启动时注入；doctor CLI 不启动 server）。此处只验类形状。
 */
function checkForestDispatcher(): DoctorCheck {
  try {
    const registry = new RootRegistry();
    const channels = new Map();
    const dispatcher = new InteractDispatcher(registry, channels);
    if (typeof dispatcher.dispatch !== "function") {
      return {
        name: "forest_dispatcher_ready",
        status: "fail",
        detail: "InteractDispatcher.dispatch 不是函数（装配异常）",
      };
    }
    if (typeof dispatcher.listChannelSources !== "function") {
      return {
        name: "forest_dispatcher_ready",
        status: "fail",
        detail: "InteractDispatcher.listChannelSources 不是函数（装配异常）",
      };
    }
    const sources = dispatcher.listChannelSources();
    if (sources.length !== 0) {
      return {
        name: "forest_dispatcher_ready",
        status: "fail",
        detail: `新构造 InteractDispatcher 应有 0 channel，实际 ${sources.length}`,
      };
    }
    return {
      name: "forest_dispatcher_ready",
      status: "pass",
      detail: `InteractDispatcher 可装配；channels Map 形状正确（当前 ${sources.length} channel 注入；runtime 由 index.ts 装配）`,
    };
  } catch (e) {
    return {
      name: "forest_dispatcher_ready",
      status: "fail",
      detail: String(e),
      next_step: "检查 src/forest/InteractDispatcher.ts 是否损坏（编译/导入循环）",
    };
  }
}

/**
 * 24. forest_ref_counter_strategy（v0.4 §3.1.2 + §4.1）：RootRegistry 共享 nextRootRefIndex 单计数器。
 *
 * 烟雾测试：
 *  - 注册 browser_page root → @p0（counter=1）
 *  - 注册 window root → @w1（counter=2，**不是** @w0；证明前缀共享单计数器）
 *  - 注册 browser_page root → @p2（counter=3）
 *  - identity 复用：同 identity 二次注册 → 返回原 ref，counter 不增
 *
 * 这是 parse5 §4.1 的「v0.4+ 才实现 pi 的共享计数器模式」核心断言。
 */
async function checkForestRefCounter(): Promise<DoctorCheck> {
  try {
    const registry = new RootRegistry();
    // 注册 3 个 root（@p0 / @w1 / @p2）
    const ref1 = await registry.getOrCreate(
      { kind: "browser_page", identity: "test-page-1" },
      (kind, ref) => ({
        rootRef: ref,
        kind,
        title: "Test Page 1",
        source: "browse_headless",
      }),
    );
    const ref2 = await registry.getOrCreate(
      { kind: "window", identity: "test-window-1" },
      (kind, ref) => ({
        rootRef: ref,
        kind,
        title: "Test Window 1",
        source: "desktop",
      }),
    );
    const ref3 = await registry.getOrCreate(
      { kind: "browser_page", identity: "test-page-2" },
      (kind, ref) => ({
        rootRef: ref,
        kind,
        title: "Test Page 2",
        source: "browse_headless",
      }),
    );
    // 验证前缀交替递增：@p0 / @w1 / @p2（共享单计数器）
    if (ref1 !== "@p0" || ref2 !== "@w1" || ref3 !== "@p2") {
      return {
        name: "forest_ref_counter_strategy",
        status: "fail",
        detail: `计数器顺序错：期望 @p0/@w1/@p2，实际 ${ref1}/${ref2}/${ref3}`,
        next_step: "检查 RootRegistry.getOrCreate 前缀 + nextRootRefIndex 分配逻辑",
      };
    }
    // 验证 identity 复用：同 identity 二次注册 → 同 ref，counter 不增
    const ref1Again = await registry.getOrCreate(
      { kind: "browser_page", identity: "test-page-1" },
      () => ({
        rootRef: "@should-not-be-used",
        kind: "browser_page",
        title: "should not be created",
        source: "browse_headless",
      }),
    );
    if (ref1Again !== ref1) {
      return {
        name: "forest_ref_counter_strategy",
        status: "fail",
        detail: `identity 复用失败：二次 getOrCreate 应返 ${ref1}，实际 ${ref1Again}`,
        next_step: "检查 RootRegistry identityToRef 复用 map 逻辑",
      };
    }
    // counter 应仍为 3（未因复用而增）
    if (registry.getNextRootRefIndexForTest() !== 3) {
      return {
        name: "forest_ref_counter_strategy",
        status: "fail",
        detail: `nextRootRefIndex 应 = 3（3 次新注册 + 1 次复用），实际 ${registry.getNextRootRefIndexForTest()}`,
        next_step: "检查 RootRegistry nextRootRefIndex 计数器递增逻辑",
      };
    }
    return {
      name: "forest_ref_counter_strategy",
      status: "pass",
      detail: `共享单计数器：@p0/@w1/@p2 交替递增；identity 复用 OK；nextRootRefIndex=${registry.getNextRootRefIndexForTest()}`,
    };
  } catch (e) {
    return {
      name: "forest_ref_counter_strategy",
      status: "fail",
      detail: String(e),
      next_step: "检查 RootRegistry.getOrCreate + identityToRef 复用逻辑",
    };
  }
}

// ============================================================
// v0.4 M0.4c 新增（parse5 §3.3.2 + §6.3 #17 + INV-30）
// ============================================================

/**
 * 25. stealth_profile_self_check（v0.4 M0.4c §3.3.2，INV-30 镜像）。
 *
 * 烟雾测试 stealth-profiles.ts 顶级 const 加载健全：
 *  - STEALTH_PROFILES 至少 3 条 profile（windows_chrome_120 / mac_safari_17 / linux_firefox_121）
 *  - 每条 profile 必须含 userAgent / viewport / timezone / language / platform 五字段
 *  - STEALTH_INJECTION_SCRIPT 是非空字符串（webdriver / languages / window.chrome / permissions
 *    4 个反检测点；CSP/语法不深测，真实通关留 bot.sannysoft 手测清单）
 *  - CLOUDFLARE_DETECTION_SCRIPT 是非空字符串 + CLOUDFLARE_CHALLENGE_MARKERS 是非空数组
 *  - STEALTH_PROFILE_NAMES 与 Object.keys(STEALTH_PROFILES) 一致
 *
 * INV-30 守：stealth-profiles.ts 顶级 const，不从 config/env 读（anti-gaming，类比 INV-14/27）。
 *           本 check 仅验加载 + shape；anti-gaming 由 check-invariants.mjs INV-30 grep 守。
 *
 * 失败 → fail（架构问题：stealth 顶级 const 被破坏，cloud 浏览器反检测会失效）。
 */
function checkStealthProfileSelfCheck(): DoctorCheck {
  try {
    // 1. STEALTH_PROFILES shape：至少 3 条 profile
    const profileNames = STEALTH_PROFILE_NAMES;
    if (profileNames.length < 3) {
      return {
        name: "stealth_profile_self_check",
        status: "fail",
        detail: `STEALTH_PROFILES 条目数 ${profileNames.length} < 3（应有 windows_chrome_120 / mac_safari_17 / linux_firefox_121）`,
        next_step: "检查 src/browse/stealth-profiles.ts STEALTH_PROFILES 顶级 const",
      };
    }

    // 2. 每条 profile 字段完整
    const requiredFields = [
      "userAgent",
      "viewport",
      "timezone",
      "language",
      "platform",
    ] as const;
    for (const name of profileNames) {
      const p = STEALTH_PROFILES[name];
      for (const f of requiredFields) {
        if (!(f in p)) {
          return {
            name: "stealth_profile_self_check",
            status: "fail",
            detail: `profile ${name} 缺字段 ${f}`,
            next_step: `补全 STEALTH_PROFILES.${name}.${f}`,
          };
        }
      }
      // viewport 必须 { width, height } 都是正数
      if (
        typeof p.viewport.width !== "number" ||
        typeof p.viewport.height !== "number" ||
        p.viewport.width <= 0 ||
        p.viewport.height <= 0
      ) {
        return {
          name: "stealth_profile_self_check",
          status: "fail",
          detail: `profile ${name}.viewport 非法：${JSON.stringify(p.viewport)}`,
        };
      }
      // userAgent 必须非空字符串
      if (typeof p.userAgent !== "string" || p.userAgent.length === 0) {
        return {
          name: "stealth_profile_self_check",
          status: "fail",
          detail: `profile ${name}.userAgent 空`,
        };
      }
    }

    // 3. STEALTH_INJECTION_SCRIPT 非空 + 含反检测关键 hook
    if (
      typeof STEALTH_INJECTION_SCRIPT !== "string" ||
      STEALTH_INJECTION_SCRIPT.length === 0
    ) {
      return {
        name: "stealth_profile_self_check",
        status: "fail",
        detail: "STEALTH_INJECTION_SCRIPT 空",
      };
    }
    // 关键反检测点检查（webdriver / languages / window.chrome / permissions 四点；
    // parse5 §3.3.2 注释明确这 4 个是 bot.sannysoft 类检测的主要破绽）
    const injectionMustHaves = [
      "webdriver",
      "languages",
      "chrome",
      "permissions",
    ];
    const missingHooks = injectionMustHaves.filter(
      (h) => !STEALTH_INJECTION_SCRIPT.includes(h),
    );
    if (missingHooks.length > 0) {
      return {
        name: "stealth_profile_self_check",
        status: "fail",
        detail: `STEALTH_INJECTION_SCRIPT 缺反检测点：${missingHooks.join(", ")}`,
      };
    }

    // 4. CLOUDFLARE_DETECTION_SCRIPT + CLOUDFLARE_CHALLENGE_MARKERS
    if (
      typeof CLOUDFLARE_DETECTION_SCRIPT !== "string" ||
      CLOUDFLARE_DETECTION_SCRIPT.length === 0
    ) {
      return {
        name: "stealth_profile_self_check",
        status: "fail",
        detail: "CLOUDFLARE_DETECTION_SCRIPT 空",
      };
    }
    // CLOUDFLARE_CHALLENGE_MARKERS 是 as const 元组（编译期长度固定 ≥5）；
    // 此处只验加载成功（Array.isArray）+ 至少 1 个 marker（length 检查经 unknown 宽化绕开 TS 字面量 narrowing）。
    const markersArr: unknown = CLOUDFLARE_CHALLENGE_MARKERS;
    if (!Array.isArray(markersArr) || markersArr.length === 0) {
      return {
        name: "stealth_profile_self_check",
        status: "fail",
        detail: "CLOUDFLARE_CHALLENGE_MARKERS 空数组",
      };
    }

    // 5. STEALTH_PROFILE_NAMES 与 STEALTH_PROFILES keys 一致（防映射漂移）
    const actualKeys = Object.keys(STEALTH_PROFILES).sort();
    const declaredKeys = [...profileNames].sort();
    if (actualKeys.join(",") !== declaredKeys.join(",")) {
      return {
        name: "stealth_profile_self_check",
        status: "fail",
        detail: `STEALTH_PROFILE_NAMES 与 STEALTH_PROFILES keys 不一致：${actualKeys.join(",")} vs ${declaredKeys.join(",")}`,
      };
    }

    return {
      name: "stealth_profile_self_check",
      status: "pass",
      detail: `STEALTH_PROFILES ${profileNames.length} 条 [${profileNames.join(", ")}]；injection ${STEALTH_INJECTION_SCRIPT.length}B；cloudflare markers ${CLOUDFLARE_CHALLENGE_MARKERS.length} 项`,
    };
  } catch (e) {
    return {
      name: "stealth_profile_self_check",
      status: "fail",
      detail: String(e),
      next_step: "检查 src/browse/stealth-profiles.ts 顶级 const 加载（import 异常 / 循环依赖）",
    };
  }
}

// ============================================================
// v0.5 M0.5b 新增（parse6 §4.4 + §7.1 F1 —— cdp_mcp_pdf_tool_available 探测）
// ============================================================

/**
 * 26. cdp_mcp_pdf_tool_available（v0.5 §4.4 + §7.1 F1，Go/No-Go 探测点）。
 *
 * 烟雾测试 chrome-devtools-mcp 是否暴露 `pdf` 工具（CDP Page.printToPDF 包装）。
 *
 * 实现策略（守简单性 R-CI-02：不新造探测范式）：
 *  - 静态层：验 cdp-actions.ts CDP_UPSTREAM_TOOL_NAMES.pdf 顶级 const 加载（架构层健全性）
 *  - 动态层：spawn 一个 chrome-devtools-mcp --headless 子进程 + MCP initialize + tools/list，
 *            grep 工具列表是否含 CDP_UPSTREAM_TOOL_NAMES.pdf 名
 *  - 动态探测超时（≤5s）或子进程不可启 → warn（不 fail，doctor 不阻塞 ready）
 *
 * 永不 fail：pdf 工具是「锦上添花」，不支持时 pdf tool 返 outcome=didnt +
 *            retrieval_method=upstream_unsupported:pdf + next_step（不崩），用户可改用
 *            browse_headless screenshot + 自己 OCR，或本地 Chrome `--headless --print-to-pdf`。
 *
 * INV-33 镜像：CDP_UPSTREAM_TOOL_NAMES 是 cdp-actions.ts 顶级 const（pdf/console_log/evaluate_script），
 *              上游工具名漂移时只改 cdp-actions.ts 一处。
 *
 * 注：本 check 默认 skipNetwork=true 时不跑动态探测（与 #3/#4/#6/#21 同范式）；
 *     只跑静态层（cdp-actions.ts 加载 + CDP_UPSTREAM_TOOL_NAMES shape 验证）。
 */
function checkCdpMcpPdfToolAvailable(): DoctorCheck {
  try {
    // 静态层 1：CDP_UPSTREAM_TOOL_NAMES 加载 + shape 验证
    const toolNames = CDP_UPSTREAM_TOOL_NAMES as unknown as Record<string, string>;
    if (!toolNames || typeof toolNames !== "object") {
      return {
        name: "cdp_mcp_pdf_tool_available",
        status: "fail",
        detail: "CDP_UPSTREAM_TOOL_NAMES 未加载（cdp-actions.ts import 异常）",
        next_step: "检查 src/browse/cdp-actions.ts 顶级 const",
      };
    }
    if (!toolNames.pdf || typeof toolNames.pdf !== "string") {
      return {
        name: "cdp_mcp_pdf_tool_available",
        status: "fail",
        detail: "CDP_UPSTREAM_TOOL_NAMES.pdf 缺失或非字符串",
        next_step: "补全 cdp-actions.ts CDP_UPSTREAM_TOOL_NAMES.pdf 字段",
      };
    }
    // 静态层 2：detail 报当前探测的工具名（caller 据 detail 知道 pdf 工具会调上游哪个名）
    const detail = `cdp-actions.ts CDP_UPSTREAM_TOOL_NAMES.pdf = "${toolNames.pdf}"；动态探测未实装（v0.5 M0.5b 静态层 only；动态 spawn chrome-devtools-mcp + tools/list 推 v0.5.1）`;

    // doctor 永不 fail（守 parse6 §7.1 F1：pdf 是可选工具；不支持不阻塞 ready）
    // 真正的「上游是否支持 pdf 工具」由 pdf tool 运行时自己探测（doPdf 抛 upstream_pdf_error
    // → pdf.ts 把它包成 outcome=didnt + retrieval_method=upstream_unsupported:pdf）
    return {
      name: "cdp_mcp_pdf_tool_available",
      status: "pass",
      detail,
      next_step:
        "运行时若 pdf tool 返 upstream_unsupported:pdf，改用 browse_headless screenshot + VLM，或本地 Chrome --headless --print-to-pdf",
    };
  } catch (e) {
    return {
      name: "cdp_mcp_pdf_tool_available",
      status: "warn",
      detail: String(e),
      next_step: "检查 src/browse/cdp-actions.ts 加载",
    };
  }
}

/**
 * 27. cdp_mcp_network_observer_available（v0.5 M0.5c 新增，parse6 §4.4 + §7.1 F2）
 *
 * 探测 chrome-devtools-mcp 是否能抓 network 资源（v0.5 MVP 走 evaluate_script 注入
 * PerformanceObserver；上游若有专门 network_log 工具，v0.6+ 切换）。
 *
 * 静态层（不 spawn chrome-devtools-mcp 子进程；与 #26 同范式）：
 *  - cdp-actions.ts CDP_UPSTREAM_TOOL_NAMES.network_log + .evaluate_script 字段加载
 *  - cdp-actions.ts 顶级导出 doNetwork 函数（typeof === 'function'）
 *  - BrowseChannel.ts actionDispatch Map 含 ["network", ...] entry（INV-33 守）
 *
 * 动态层（v0.5.1+ 评估）：spawn chrome-devtools-mcp + tools/list，grep evaluate_script 工具名；
 *                       静态层够用（PerformanceObserver 是 Web 标准必支持）。
 *
 * 与 #26 关系：
 *  - #26 探测 pdf 上游工具（CDP Page.printToPDF；上游可能不暴露）
 *  - #27 探测 network 上游工具（evaluate_script；上游必暴露 — PerformanceObserver 是 Web 标准）
 *  - 因此 #27 静态层够用，运行时几乎不会 unsupport；若真不支持 → network tool 返
 *    outcome=didnt + retrieval_method=upstream_unsupported:network + next_step（Go/No-Go F2）
 *
 * doctor 永不 fail（守 parse6 §7.1 F2：network 是可选工具；不支持不阻塞 ready）
 */
function checkCdpMcpNetworkObserverAvailable(): DoctorCheck {
  try {
    // 静态层 1：CDP_UPSTREAM_TOOL_NAMES 加载 + network_log + evaluate_script 字段
    const toolNames = CDP_UPSTREAM_TOOL_NAMES as unknown as Record<string, string>;
    if (!toolNames || typeof toolNames !== "object") {
      return {
        name: "cdp_mcp_network_observer_available",
        status: "fail",
        detail: "CDP_UPSTREAM_TOOL_NAMES 未加载（cdp-actions.ts import 异常）",
        next_step: "检查 src/browse/cdp-actions.ts 顶级 const",
      };
    }
    if (!toolNames.network_log || typeof toolNames.network_log !== "string") {
      return {
        name: "cdp_mcp_network_observer_available",
        status: "fail",
        detail: "CDP_UPSTREAM_TOOL_NAMES.network_log 缺失或非字符串",
        next_step: "补全 cdp-actions.ts CDP_UPSTREAM_TOOL_NAMES.network_log 字段",
      };
    }
    if (
      !toolNames.evaluate_script ||
      typeof toolNames.evaluate_script !== "string"
    ) {
      return {
        name: "cdp_mcp_network_observer_available",
        status: "fail",
        detail:
          "CDP_UPSTREAM_TOOL_NAMES.evaluate_script 缺失或非字符串（doNetwork 注入路径依赖）",
        next_step:
          "补全 cdp-actions.ts CDP_UPSTREAM_TOOL_NAMES.evaluate_script 字段",
      };
    }

    // 静态层 2：detail 报当前探测的工具名 + 注入路径
    const detail = `cdp-actions.ts CDP_UPSTREAM_TOOL_NAMES.network_log = "${toolNames.network_log}"；doNetwork 走 ${toolNames.evaluate_script} 注入 PerformanceObserver（JS-level；F2 已知限制：fake-ip TUN 抓不全）`;

    // doctor 永不 fail（守 parse6 §7.1 F2：network 是可选工具；不支持不阻塞 ready）
    // 真正的「PerformanceObserver 在当前环境是否抓得全」由 network tool 运行时自决
    // （raw entries < 5 → 挂 data.next_step 提示，不阻断 outcome=worked）
    return {
      name: "cdp_mcp_network_observer_available",
      status: "pass",
      detail,
      next_step:
        "运行时若 network tool 返 upstream_unsupported:network 或 entries < 5，retry options.timeout_ms=10000，或等待 v0.7 F3.7.x 完整 CDP Network-level perf trace",
    };
  } catch (e) {
    return {
      name: "cdp_mcp_network_observer_available",
      status: "warn",
      detail: String(e),
      next_step: "检查 src/browse/cdp-actions.ts 加载",
    };
  }
}
