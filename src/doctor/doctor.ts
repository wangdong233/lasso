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
 *  31. platform_backend_active          — v1.0 Phase D：AxBackendFactory.detectKind() 返 mac/win_uia/linux_atspi
 *                                    之一 + 工厂可装配（parse11 §3.4 + INV-60）
 *  32. recording_baseline_count         — v1.0 Phase C：fixtures/serp-baseline/ 录制数（≥10 pass；
 *                                    0 warn；中间 pass with detail；parse11 §3.2 + INV-62）
 *  33. markdown_extractor_engine        — v1.1 Phase B：defuddle/turndown require.resolve（warn-only）
 *  34. markdown_smoke                    — v1.1 Phase B：smokeTestMarkdownEngine 端到端（warn-only）
 *  35. config_file                       — v1.3 Phase A：~/.lasso/config.json 路径 + key 数（advisory）
 *  36. machine_search_mcp                — v1.4 Phase B：~/.claude.json web-search-prime MCP 探测
 *                                    （detected=pass host=xx；missing=warn 不阻塞；INV-72 永不 log key）
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
import { promises as fs, constants as fsConstants, readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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
// v1.0 Phase C/D（parse11 §3.2 + §3.4 + §7.2）：跨平台 AxBackendFactory + 录制回放基线
// 守 INV-60：AxBackendFactory 单一真源（不在 doctor 内 new 任一 backend class）
// 守 INV-62：录制基线 fixture 只读 fs，永不读 logged_in cookie 场景
import { AxBackendFactory } from "../desktop/AxBackendFactory.js";
// v1.3 Phase A：config 文件机制（#35 config_file doctor check）
// 守 INV-71：doctor.ts 经 config.js 顶级函数读 ~/.lasso/config.json 元数据（不解析业务语义）
import { getConfigFilePath, loadConfigFileEnv } from "../config/config.js";
// v1.4 Phase B（parse-v1.4 §Phase B）：#36 machine_search_mcp doctor check
// 守 INV-72：doctor 经 detectMachineSearchMcp() 只读探测 ~/.claude.json；永不 log Authorization 值；
//            detail 只报 hostname（open.bigmodel.cn），不报完整 url（path 可含 token 片段）。
import {
  detectMachineSearchMcp,
  getClaudeJsonPath,
} from "../search/MachineMcpDetector.js";

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LASSO_VERSION = "1.4.0";

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
    /**
     * v0.7 新增（parse8 §3.5 / INV-47）：observability 子节。
     *
     * 全部经 provider 注入（同 runtime_state 范式：不开第二套 doctor section）；
     * 未注入 → undefined → section 字段不出现在 report 里（零回归）。
     */
    metrics?: Array<{
      channel: string;
      total: number;
      success_count: number;
      failure_count: number;
      success_rate: number;
      latency_ms_p50: number;
      latency_ms_p95: number;
      last_error?: string;
      last_error_at?: number;
    }>;
    breakers?: Array<{
      channel: string;
      kind: "short" | "long";
      state: "closed" | "open" | "half-open";
      failure_count?: number;
      window_failure_count?: number;
      opened_at: number;
    }>;
    serp_health?: {
      engines: Array<{
        engine: string;
        hit_rate: number;
        hit: number;
        miss: number;
        last_known_good: string;
        redesign_suspected: boolean;
      }>;
      recent_alerts: Array<{ key: string; rate: number; at: number }>;
      recordings_count: number;
    };
    /**
     * v0.8 新增（parse9 §3.4 / INV-51 红线）：profiles 子节。
     *
     * 守 INV-51：本字段**仅**返加密包元数据（exists / bytes / mtimeMs / sha256），
     *            **永不**返 cookie 字段（name/value/domain/session 等）；
     *            doctor 不解密 / 不打印 cookie 内容。
     *
     * 未注入（doctor CLI 模式）→ 子节不出现在 runtime_state（零回归）。
     */
    profiles?: Array<{
      name: string;
      isCurrent: boolean;
      userDataDir: string;
      userDataDirExists: boolean;
      /** 八进制字符串（"0o700"）；探测失败 → null。 */
      userDataDirMode: string | null;
      /** 加密包元数据（stat only；INV-51 红线：不解密）。null = provider 未注入。 */
      encryptedPackage: {
        exists: boolean;
        bytes?: number;
        mtimeMs?: number;
        sha256?: string;
      } | null;
    }>;
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
    /**
     * v0.7 新增（parse8 §3.5）：observ 子节 provider。
     * 未注入 → 子节不出现在 runtime_state（零回归）。
     */
    metrics?: Array<{
      channel: string;
      total: number;
      success_count: number;
      failure_count: number;
      success_rate: number;
      latency_ms_p50: number;
      latency_ms_p95: number;
      last_error?: string;
      last_error_at?: number;
    }>;
    breakers?: Array<{
      channel: string;
      kind: "short" | "long";
      state: "closed" | "open" | "half-open";
      failure_count?: number;
      window_failure_count?: number;
      opened_at: number;
    }>;
    serp_health?: {
      engines: Array<{
        engine: string;
        hit_rate: number;
        hit: number;
        miss: number;
        last_known_good: string;
        redesign_suspected: boolean;
      }>;
      recent_alerts: Array<{ key: string; rate: number; at: number }>;
      recordings_count: number;
    };
    /**
     * v0.8 新增（parse9 §3.4 / INV-51）：profiles 子节 provider。
     * 未注入（doctor CLI 模式）→ 子节不出现在 runtime_state（零回归）。
     */
    profiles?: Array<{
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
    }>;
  };
  /**
   * v0.8 新增（parse9 §3.4 + INV-51 红线）：profile + 加密包健康检查数据源。
   *
   * 守 INV-35（task v0.6 衍生）：doctor.ts 不 import logged-in/ 内部；
   *                        index.ts 装配段注入「数据快照函数」，doctor 仅消费。
   * 守 INV-51（parse9 §1.3 红线）：provider 返的对象**只含加密包 stat 元数据**
   *                        （exists / bytes / mtimeMs / sha256），**不含** cookie 字段；
   *                        doctor 路径永不接触 master key / 明文 cookie。
   *
   * 未注入（doctor CLI 模式）→ #28-#30 warn skip + runtime_state.profiles 不出现（零回归）。
   */
  profilesChecksProvider?: () => Promise<Array<{
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
  }>>;
  /**
   * v1.0 Phase C 新增（parse11 §3.2 + §3.4 + INV-62）：录制基线 fixture 目录覆盖。
   *
   * 默认 <cwd>/fixtures/serp-baseline（与 replay-baseline.ts 默认对齐）。
   * doctor #32 recording_baseline_count 扫此目录数 *.html 文件。
   *
   * 守 INV-62：本字段**只读 fs** 扫 .html 文件名 + count，**永不读 .html 内容**
   *            （避免误读 fixture 中的脱敏 query）； INV-62 grep 守 doctor.ts
   *            无 logged_in / cookie / session 字面量。
   */
  recordingBaselineDir?: string;
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

  // ---- v0.8 M0.8：profiles + 加密包健康检查（parse9 §3.4 + INV-51 红线）----
  // 默认 profilesChecksProvider 未注入（doctor CLI 模式）→ #28-#30 warn skip（零回归）。
  // 注入（doctor tool 经 index.ts v0.8 装配）→ #28-#30 跑全 3 项；永不解密 / 永不清读 cookie。
  let profilesData: Array<{
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
  if (opts.profilesChecksProvider) {
    try {
      profilesData = await opts.profilesChecksProvider();
    } catch (e) {
      // provider 抛错 → 3 项降级为 warn（不阻塞 ready）
      checks.push(
        {
          name: "profile_registry_loadable",
          status: "warn",
          detail: `profilesChecksProvider threw: ${String(e)}`,
        },
        {
          name: "profile_user_data_dir_exists",
          status: "warn",
          detail: "skipped (profilesChecksProvider threw)",
        },
        {
          name: "cookie_store_stat_only",
          status: "warn",
          detail: "skipped (profilesChecksProvider threw)",
        },
      );
    }
  }
  if (opts.profilesChecksProvider && profilesData.length >= 0) {
    // 仅当 provider 成功时跑这 3 项（provider 抛错时上面已 warn，此处 profilesData 仍 [] ）
    // #28 profile_registry_loadable：至少 1 个 profile（或 provider 注入即视为 loadable）
    checks.push(checkProfileRegistryLoadable(profilesData));
    // #29 profile_user_data_dir_exists：current profile 的 userDataDir 存在
    checks.push(checkProfileUserDataDirExists(profilesData));
    // #30 cookie_store_stat_only：只 stat 加密包，**永不清读 cookie**（INV-51 红线）
    checks.push(checkEncryptedPackageStatOnly(profilesData));
  } else if (!opts.profilesChecksProvider) {
    // 未注入 → 3 项 warn skip（v0.7 兼容）
    checks.push(
      {
        name: "profile_registry_loadable",
        status: "warn",
        detail: "skipped (profilesChecksProvider not injected)",
      },
      {
        name: "profile_user_data_dir_exists",
        status: "warn",
        detail: "skipped (profilesChecksProvider not injected)",
      },
      {
        name: "cookie_store_stat_only",
        status: "warn",
        detail: "skipped (profilesChecksProvider not injected)",
      },
    );
  }

  // ---- v1.0 Phase C/D（parse11 §3.2 + §3.4 + §7.2）----
  // #31 platform_backend_active：AxBackendFactory.detectKind() 返 mac/win_uia/linux_atspi 之一
  //                              + 工厂可装配（INV-60 单一真源落地）
  // #32 recording_baseline_count：fixtures/serp-baseline/ 录制数（≥10 pass；0 warn；中间 pass with detail）
  //                              守 INV-62：仅 count .html 文件，不读内容
  // 复用既有 runDoctor（不开第二套 section；INV-47 范式）
  // 默认跑（无 skipNetwork 等开关；纯 TS 烟雾测试 + fs 扫，零阻塞 ready）
  checks.push(checkPlatformBackendActive());
  checks.push(
    await checkRecordingBaselineCount(opts.recordingBaselineDir),
  );

  // ---- v1.1 Phase B（parse12 §2.2 + §6）----
  // #33 markdown_extractor_engine：defuddle/turndown 版本 + loadable（静态 require.resolve，不加载引擎）
  // #34 markdown_smoke：跑 smokeTestMarkdownEngine 验引擎端到端可用（dynamic import，仅此 check 加载引擎）
  // 两项均 warn-only（markdown 是 opt-in；未装/失败不阻塞 ready —— raw 默认路径 byte-identical v1.0）
  checks.push(checkMarkdownExtractorEngine());
  checks.push(await checkMarkdownSmoke(cacheDir));

  // ---- v1.3 Phase A：config 文件机制（parse-v1.3 §Phase A）----
  // #35 config_file：报 config 文件路径 + 是否存在 + 从中加载的 key 数
  // 永不 fail（config 是 advisory；零配置启动可用；仅 search 需 key）
  // 引导：没配 key？跑 `lasso config init` 创建配置文件
  checks.push(await checkConfigFile());

  // ---- v1.4 Phase B（parse-v1.4 §Phase B 机器 MCP 复用）----
  // #36 machine_search_mcp：探测 ~/.claude.json 是否配过 web-search-prime MCP
  //   - detected → pass：报 hostname（open.bigmodel.cn），不报完整 url + 永不报 Authorization
  //   - missing  → warn（零配置兼容；不阻塞 ready）：降级到 search.zhipu（Lasso 自己 key）
  // 守 INV-72：detectMachineSearchMcp() 已 read-only + 永不抛；本 check 不再触网、不再读 key。
  checks.push(checkMachineSearchMcp());

  const blockers = checks.filter((c) => c.status === "fail").map((c) => c.name);

  // ---- v0.6 M0.6：runtime_state section（parse7 §2.2 + §6.2）----
  // doctor 不验 runtime_state 语义（不增 blockers）；仅展示当前进程状态。
  // runtimeState 未注入（doctor CLI 模式）→ undefined → section 字段不出现在 report 里（零回归）。
  // v0.8（parse9 §3.4 / INV-51）：runtime_state.profiles 子节由 profilesChecksProvider 提供；
  //                                 **仅**含加密包 stat 元数据，**永不**含 cookie 字段。
  //
  // 守 v0.6 范式：runtime_state 整个 section 只在 opts.runtimeState 注入时出现；
  //              profilesData 即使非空也仅在 runtimeState 同时注入时合并到 runtime_state
  //              （doctor CLI 模式 runtimeState 不注入 → runtime_state 整段不出现，零回归）。
  //              #28-#30 checks 仍独立运行（不依赖 runtime_state 是否渲染）。
  const baseRuntimeState = opts.runtimeState ? opts.runtimeState() : undefined;
  const runtime_state = baseRuntimeState
    ? profilesData.length > 0
      ? { ...baseRuntimeState, profiles: profilesData }
      : baseRuntimeState
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

// ============================================================
// v0.8 M0.8：#28-#30 profile + 加密包健康检查（parse9 §3.4 + INV-51 红线）
// ============================================================
/**
 * 数据形状（与 DoctorOptions.profilesChecksProvider 返类型一致）。
 *
 * 守 INV-51（parse9 §1.3 红线）：本类型**只含加密包 stat 元数据**（exists / bytes /
 *                                 mtimeMs / sha256），**永不**含 cookie 字段；
 *                                 doctor 路径永不接触 master key / 明文 cookie。
 */
interface ProfileCheckData {
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
}

/**
 * 28. profile_registry_loadable —— ProfileRegistry.load() 不抛 + 至少 1 个 profile。
 *
 * 守 INV-51：仅消费 provider 注入的元数据；不调 ProfileRegistry.load / 不读 cookie。
 */
function checkProfileRegistryLoadable(profiles: ProfileCheckData[]): DoctorCheck {
  if (profiles.length === 0) {
    return {
      name: "profile_registry_loadable",
      status: "fail",
      detail: "profilesChecksProvider 返回空数组（profile 注册表无 entry）",
      next_step: "调 admin({action:'profile_list'}) 排查；index.ts 装配段应自动建 default profile",
    };
  }
  const hasCurrent = profiles.some((p) => p.isCurrent);
  return {
    name: "profile_registry_loadable",
    status: hasCurrent ? "pass" : "warn",
    detail: `${profiles.length} profile(s): [${profiles.map((p) => p.name).join(", ")}]；current=${profiles.find((p) => p.isCurrent)?.name ?? "(none)"}`,
    next_step: hasCurrent
      ? undefined
      : "profile_registry 当前指针缺失；调 admin({action:'profile_switch', profile:'default'})",
  };
}

/**
 * 29. profile_user_data_dir_exists —— 当前 profile 的 userDataDir 存在。
 *
 * 守 INV-51：仅消费 provider 注入的 userDataDirExists / userDataDirMode；
 *            doctor 不直接 stat user-data-dir（避免误读 Chrome 内部文件）。
 */
function checkProfileUserDataDirExists(profiles: ProfileCheckData[]): DoctorCheck {
  const current = profiles.find((p) => p.isCurrent);
  if (!current) {
    return {
      name: "profile_user_data_dir_exists",
      status: "warn",
      detail: "no current profile (provider returned no isCurrent=true entry)",
    };
  }
  if (!current.userDataDirExists) {
    return {
      name: "profile_user_data_dir_exists",
      status: "fail",
      detail: `current profile "${current.name}" userDataDir 不存在: ${current.userDataDir}`,
      next_step: "调 admin({action:'profile_switch', profile:'<name>'}) 触发 ProfileRegistry.add 重建",
    };
  }
  return {
    name: "profile_user_data_dir_exists",
    status: "pass",
    detail: `profile "${current.name}" userDataDir 存在 (mode=${current.userDataDirMode ?? "unknown"})`,
  };
}

/**
 * 30. cookie_store_stat_only —— 当前 profile 加密包 stat 状态。
 *
 * 守 INV-51 红线（parse9 §1.3 + §3.4）：
 *  - 本 check **永不**调 CookieStore.import / getKeychainKey（master key 接触）
 *  - 仅消费 provider 注入的 stat 元数据（exists / bytes / mtimeMs / sha256）
 *  - **永不**打印 cookie 字段（name / value / domain / session 等）
 *
 * 设计：
 *  - 加密包不存在 → pass（首次启动 / 未 export 过；非缺陷）
 *  - 加密包存在但 sha256 缺失 → warn（provider 返不完整）
 *  - 加密包存在 + sha256 完整 → pass（detail 报 sha256 前 16 字符 + bytes + mtime）
 */
function checkEncryptedPackageStatOnly(
  profiles: ProfileCheckData[],
): DoctorCheck {
  const current = profiles.find((p) => p.isCurrent);
  if (!current) {
    return {
      name: "cookie_store_stat_only",
      status: "warn",
      detail: "no current profile (stat skipped)",
    };
  }
  const pkg = current.encryptedPackage;
  if (!pkg || !pkg.exists) {
    return {
      name: "cookie_store_stat_only",
      status: "pass",
      detail: `current profile "${current.name}" 暂无加密包（未 export 过；调 admin({action:'cookie_restore', op:'export'}) 生成）`,
    };
  }
  if (!pkg.sha256) {
    return {
      name: "cookie_store_stat_only",
      status: "warn",
      detail: `current profile "${current.name}" 加密包存在但 provider 未返 sha256（bytes=${pkg.bytes ?? "?"}, mtime=${pkg.mtimeMs ?? "?"}）`,
    };
  }
  // 守 INV-51：detail 只展示加密包**密文** sha256（不可逆）+ 字节数 + mtime；
  //            **永不**展示 cookie 字段（明文 cookie 经 AES-GCM 加密后不可见）
  const shaPrefix = pkg.sha256.slice(0, 16);
  return {
    name: "cookie_store_stat_only",
    status: "pass",
    detail: `current profile "${current.name}" 加密包存在：bytes=${pkg.bytes}, sha256(prefix)=${shaPrefix}..., mtime=${new Date(pkg.mtimeMs ?? 0).toISOString()}`,
    next_step:
      "doctor 永不解密加密包（INV-51 红线）；要恢复登录态调 admin({action:'cookie_restore', op:'import'})",
  };
}

// ============================================================
// v1.0 Phase C/D 新增（parse11 §3.2 + §3.4 + §7.2 —— #31 platform_backend_active + #32 recording_baseline_count）
// ============================================================

/**
 * 31. platform_backend_active（v1.0 §3.4，F3.10.9 跨平台 desktop；INV-60 单一真源）。
 *
 * 烟雾测试 AxBackendFactory.detectKind() 在当前平台返 mac/win_uia/linux_atspi 之一；
 * 不调 factory.create()（避免启 RustBridge；doctor CLI 不该 spawn 子进程）。
 *
 * 设计（守 INV-60 + parse11 §1.3 macOS-only 红线）：
 *  - macOS 本机 → 返 "mac"（pass；可证）
 *  - Windows / Linux → 返 "win_uia" / "linux_atspi"（pass；编译可证 + 真机手测 pending）
 *  - 其他 / 抛错 → fail（unsupported_platform；架构问题）
 *
 * INV-60 守：本 check 只调 detectKind()（type-only），不 new 任一 backend class。
 * INV-21 守：本 check 不出现平台 API 字面量（平台路由在 AxBackendFactory 内）。
 */
function checkPlatformBackendActive(): DoctorCheck {
  try {
    const kind = AxBackendFactory.detectKind();
    const raw = process.platform;
    // 三平台 kind 之一才算 pass（detectKind 已抛 unsupported_platform 兜底；这里只 sanity check）
    const validKinds = ["mac", "win_uia", "linux_atspi"];
    if (!validKinds.includes(kind)) {
      return {
        name: "platform_backend_active",
        status: "fail",
        detail: `detectKind() 返非法值 "${kind}"（期望 mac/win_uia/linux_atspi 之一）`,
        next_step: "检查 src/desktop/AxBackendFactory.ts + platform-detect.ts 路由逻辑",
      };
    }
    return {
      name: "platform_backend_active",
      status: "pass",
      detail: `platform=${raw}; backend=${kind}; AxBackendFactory 单一真源已落地（INV-60）`,
      next_step:
        raw === "darwin"
          ? undefined
          : `本机 ${raw} 路径编译可证；真机 UIA/AT-SPI 执行留 parse11-acceptance.md 手测清单（pending）`,
    };
  } catch (e) {
    return {
      name: "platform_backend_active",
      status: "fail",
      detail: String(e),
      next_step: `当前 platform ${process.platform} 不支持；Lasso v1.0 支持 darwin/win32/linux`,
    };
  }
}

/**
 * 32. recording_baseline_count（v1.0 §3.2，F3.8.14 录制回放回归；INV-62 红线）。
 *
 * 扫 fixtures/serp-baseline/ 目录数 *.html 文件（不读内容，仅 count）。
 *
 * 设计（parse11 §3.4 + 守 INV-62）：
 *  - ≥10 → pass（基线充足，replay-baseline runner 有足够样本）
 *  - 0   → warn（无基线，replay-baseline 会 skip；不阻塞 ready）
 *  - 1-9 → pass with detail（首次基线未完；不 fail）
 *
 * INV-62 守：本 check 只 readdir + 数 .html 扩展名，**永不读 .html 内容**
 *            （避免误读 fixture 中的脱敏 query；INV-62 grep 红线：doctor.ts 无
 *             logged_in / cookie / session 字面量；fixture 内容由 replay-baseline.ts 读）。
 *
 * 默认 fixturesDir = <cwd>/fixtures/serp-baseline（与 replay-baseline.ts 默认对齐）。
 * caller 可注入 recordingBaselineDir 覆盖（doctor tool 模式由 index.ts 装配）。
 */
async function checkRecordingBaselineCount(
  fixturesDirOverride?: string,
): Promise<DoctorCheck> {
  const fixturesDir =
    fixturesDirOverride ??
    path.join(process.cwd(), "fixtures", "serp-baseline");

  let totalHtml = 0;
  const perEngine: Record<string, number> = {};
  try {
    const engineDirs = await fs.readdir(fixturesDir, { withFileTypes: true });
    for (const engineDir of engineDirs) {
      if (!engineDir.isDirectory()) continue;
      let files: string[];
      try {
        files = await fs.readdir(path.join(fixturesDir, engineDir.name));
      } catch {
        continue;
      }
      const htmlCount = files.filter((f) => f.endsWith(".html")).length;
      if (htmlCount > 0) {
        perEngine[engineDir.name] = htmlCount;
        totalHtml += htmlCount;
      }
    }
  } catch {
    // fixturesDir 不存在 / 不可读 → 0 条基线（warn，不 fail）
    return {
      name: "recording_baseline_count",
      status: "warn",
      detail: `fixtures 目录不存在或不可读: ${fixturesDir}（replay-baseline runner 将 skip）`,
      next_step:
        "调 LASSO_RECORD_SEARCH=true 录制首批 fixture；签入仓库后此项升 pass（parse11 §3.2）",
    };
  }

  // 分级（parse11 §3.4）
  if (totalHtml === 0) {
    return {
      name: "recording_baseline_count",
      status: "warn",
      detail: `0 条 fixture（${fixturesDir}；replay-baseline runner 将 skip）`,
      next_step:
        "调 LASSO_RECORD_SEARCH=true 录制首批 fixture；签入仓库后此项升 pass",
    };
  }

  // perEngine detail（如 "baidu=2 google=2 bing=2"）
  const engineBreakdown = Object.entries(perEngine)
    .map(([e, n]) => `${e}=${n}`)
    .join(" ");

  if (totalHtml >= 10) {
    return {
      name: "recording_baseline_count",
      status: "pass",
      detail: `${totalHtml} 条 fixture（${engineBreakdown}；replay-baseline runner 有充足样本）`,
    };
  }
  // 1-9 条 → pass with detail（首次基线未完；不 fail；守 parse11 §3.4 "中间 → pass"）
  return {
    name: "recording_baseline_count",
    status: "pass",
    detail: `${totalHtml} 条 fixture（${engineBreakdown}；建议补到 ≥10 条覆盖更多 selector 改版场景）`,
    next_step: `当前 ${totalHtml}/10 条；可调 LASSO_RECORD_SEARCH=true 加录（INV-62：禁录 logged_in cookie 场景）`,
  };
}

// ============================================================
// v1.1 Phase B 新增（parse12 §2.2 + §6.1 #10 + §6.2 M5 —— #33 markdown_extractor_engine）
// ============================================================
/**
 * 33. markdown_extractor_engine（v1.1 §2.2 + §6.1 #10）。
 *
 * 静态探测 defuddle + turndown 两个 npm 包是否已装 + 版本（不加载引擎代码）。
 *
 * 设计（守 INV-68 衍生：doctor 不引第三运行时；用 require.resolve 探测包存在性
 *              + 读 package.json 版本，不实际 import defuddle/turndown 引擎本体）：
 *  - 用 createRequire(import.meta.url).require("<pkg>/package.json") 读版本
 *    （只读 package.json，不触发引擎模块加载 → doctor 不因 #33 慢）
 *  - 两包都 loadable + 版本非空 → pass
 *  - 任一缺失 → warn（markdown 是 opt-in；raw 默认路径 byte-identical v1.0，不阻塞 ready）
 *
 * INV-68 镜像：markdown-extractor.ts 只 import defuddle/turndown（JS 包，无 spawn/python）。
 *              doctor 本 check 进一步只读 package.json，连 JS 引擎本体都不加载。
 */
function checkMarkdownExtractorEngine(): DoctorCheck {
  const require = createRequire(import.meta.url);

  /**
   * Robust 版本解析：require.resolve("<pkg>") 取主入口路径，walk-up 找最近的
   * package.json（name 匹配）读 version。
   * 不用 require("<pkg>/package.json") —— defuddle 有 exports 字段限制 subpath。
   */
  const resolvePkgVersion = (pkgName: string): string | undefined => {
    try {
      const entry = require.resolve(pkgName);
      let dir = path.dirname(entry);
      for (let i = 0; i < 20 && dir !== path.dirname(dir); i++) {
        const pj = path.join(dir, "package.json");
        try {
          const pkg = JSON.parse(readFileSync(pj, "utf8")) as {
            name?: string;
            version?: string;
          };
          if (pkg.name === pkgName && pkg.version) return pkg.version;
        } catch {
          // try parent dir
        }
        dir = path.dirname(dir);
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const defuddleVer = resolvePkgVersion("defuddle");
  const turndownVer = resolvePkgVersion("turndown");

  if (!defuddleVer || !turndownVer) {
    const missing: string[] = [];
    if (!defuddleVer) missing.push("defuddle");
    if (!turndownVer) missing.push("turndown");
    return {
      name: "markdown_extractor_engine",
      status: "warn",
      detail: `markdown 引擎未装：${missing.join(" + ")}（extract_mode=markdown 不可用；raw 默认路径不受影响）`,
      next_step: `npm install（package.json 已声明 defuddle ^0.19.1 + turndown ^7.2.4）`,
    };
  }

  return {
    name: "markdown_extractor_engine",
    status: "pass",
    detail: `defuddle@${defuddleVer} + turndown@${turndownVer}（MIT；extract_mode=markdown/markdown_cited 可用）`,
  };
}

/**
 * 34. markdown_smoke（v1.1 §2.2 + §6.1 + §5.5）。
 *
 * 跑 smokeTestMarkdownEngine() 验 defuddle+turndown 引擎端到端可用（固定 fixture HTML
 * 跑一次 extractMarkdown，验输出非空 + 含预期正文）。
 *
 * 设计（守 INV-68：dynamic import 只在此 check 加载引擎；doctor.ts 无静态 import
 *              markdown-extractor.ts → MCP server 启动不加载 defuddle/turndown）：
 *  - dynamic import("../browse/markdown-extractor.js") 只在此处触发引擎加载
 *  - smoke ok=true + markdown_preview 含 "Hello" → pass
 *  - smoke ok=false → warn（引擎装了但跑不通；raw 默认路径不受影响，不阻塞 ready）
 *  - 同时把 smoke 结果（ok + engine + elapsed_ms + timestamp）写入 cacheDir/markdown-smoke.json
 *    （后续 doctor 调可见上次 smoke 时间戳；parse12 §2.2 #34 「最后一次 smoke 时间戳」）
 */
async function checkMarkdownSmoke(cacheDir: string): Promise<DoctorCheck> {
  try {
    // dynamic import（守 INV-66 精神：doctor 静态不 import markdown-extractor；
    // 仅此 check 运行时才 lazy-load defuddle/turndown）
    const { smokeTestMarkdownEngine } = await import(
      "../browse/markdown-extractor.js"
    );
    const smoke = await smokeTestMarkdownEngine();

    // 写 smoke 时间戳到 cache（parse12 §2.2 #34 「最后一次 smoke 时间戳」）
    const smokeRecord = {
      ok: smoke.ok,
      engine: smoke.engine,
      elapsed_ms: smoke.elapsed_ms,
      timestamp: new Date().toISOString(),
    };
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        path.join(cacheDir, "markdown-smoke.json"),
        JSON.stringify(smokeRecord, null, 2),
      );
    } catch {
      // 写 cache 失败不阻塞 check（只报诊断）
    }

    if (smoke.ok) {
      return {
        name: "markdown_smoke",
        status: "pass",
        detail: `smoke ok（engine=${smoke.engine}, ${smoke.elapsed_ms}ms）；preview="${smoke.markdown_preview.slice(0, 60)}..."`,
      };
    }
    return {
      name: "markdown_smoke",
      status: "warn",
      detail: `smoke 失败（engine=${smoke.engine}）；markdown opt-in 可能不可用，raw 默认路径不受影响`,
      next_step: "检查 defuddle/turndown 安装完整性；npm rebuild 或 npm install",
    };
  } catch (e) {
    return {
      name: "markdown_smoke",
      status: "warn",
      detail: String(e),
      next_step: "markdown 引擎加载失败（#33 查包是否装）；raw 路径不受影响",
    };
  }
}

// ============================================================
// v1.3 Phase A 新增（parse-v1.3 §Phase A —— #35 config_file）
// ============================================================
/**
 * 35. config_file（v1.3 Phase A：config 文件机制；INV-71 镜像）。
 *
 * 报 ~/.lasso/config.json（或 LASSO_CONFIG_PATH 覆盖）的：
 *  - 绝对路径
 *  - 是否存在（stat）
 *  - 从中加载的 key 数（loadConfigFileEnv 解析扁平 JSON 后的非空元数据键数）
 *
 * 永不 fail：config 是 advisory；零配置启动可用（browse/fetch/desktop 不需 key；仅 search 需）。
 *  - 文件不存在 → warn（引导跑 `lasso config init`）
 *  - 文件存在 + 0 key → pass（用户可能只填空模板）
 *  - 文件存在 + ≥1 key → pass with detail（detail 报 key 数；env 覆盖 file 的语义由 loadConfig 守）
 *
 * 守 INV-51 红线不接触：config 文件不含 cookie/session 明文（那是 logged_in 加密包）；
 *                      本 check 只读 ~/.lasso/config.json 扁平 JSON，与 cookie store 完全隔离。
 * 守 INV-35 衍生：doctor.ts 经 config.js 顶级函数读元数据；不 import config/provider-registry 业务层。
 */
async function checkConfigFile(): Promise<DoctorCheck> {
  try {
    const filePath = getConfigFilePath();
    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      return {
        name: "config_file",
        status: "warn",
        detail: `config 文件不存在：${filePath}（零配置启动可用；browse/fetch/desktop 不需 key，仅 search 需）`,
        next_step:
          "（可选）跑 `lasso-mcp config init` 创建配置文件模板，填入你的 key（env 仍可覆盖文件）",
      };
    }
    const fileEnv = loadConfigFileEnv();
    const keyCount = Object.keys(fileEnv).length;
    return {
      name: "config_file",
      status: "pass",
      detail: `${filePath} 存在；加载 ${keyCount} 个 key（env 覆盖 file；详见 doc/KEY-GUIDE.md）`,
    };
  } catch (e) {
    return {
      name: "config_file",
      status: "warn",
      detail: String(e),
    };
  }
}

/**
 * 36. machine_search_mcp（v1.4 Phase B 机器 MCP 复用）。
 *
 * 探测 ~/.claude.json 是否配过 web-search-prime MCP（type=http + url 含
 * web_search_prime/bigmodel.cn + headers.Authorization）：
 *  - 命中 → pass：detail 报 hostname（如 open.bigmodel.cn），不报完整 url（path 可含
 *                token 片段，保守只给 host）+ 永不报 Authorization 值（INV-72）
 *  - 未命中 → warn（零配置兼容；不阻塞 ready）：用户没配机器 MCP，Lasso 自动降级到
 *            search.zhipu（需单独配 ZHIPU_API_KEY 或 ~/.lasso/config.json）
 *
 * **安全（INV-72 衍生）**：
 *  - 本函数不直接读 ~/.claude.json；调 detectMachineSearchMcp()（read-only + try/catch）
 *  - detail 字段永不包含 authorization / Authorization 字符串；永不包含完整 url；
 *    只用 URL.TryParse 提取 hostname（如 open.bigmodel.cn）
 *  - 函数体内不触网、不 log（doctor 是被动诊断；探测已由 detector 完成在内存里）
 */
function checkMachineSearchMcp(): DoctorCheck {
  const claudeJsonPath = getClaudeJsonPath();
  try {
    const detected = detectMachineSearchMcp();
    if (!detected) {
      return {
        name: "machine_search_mcp",
        status: "warn",
        // 不报 path（可能含用户名）+ 不报 url（不存在）+ 不报 key（不存在）
        detail:
          "~/.claude.json 未发现 web-search-prime MCP（type=http + url 含 web_search_prime/bigmodel.cn + Authorization）",
        next_step:
          "（可选，零配置兼容）机器装过 web-search-prime MCP 即自动复用其 key；否则需配 ZHIPU_API_KEY（doc/KEY-GUIDE.md）",
      };
    }
    // 提取 hostname —— 用 URL 构造器（detector 已校验 url 是 string；构造失败 → 退化为 "(invalid url)" 兜底）
    let host = "(invalid url)";
    try {
      const u = new URL(detected.url);
      host = u.hostname;
    } catch {
      // url 不合法（理论上 detector 已 https:// 校验过；此分支防御性兜底）
      host = "(invalid url)";
    }
    // **INV-72 红线**：detail 只含 hostname + "Authorization 已配置" 布尔指示；
    //                  永不出现 detected.authorization / detected.url 的原始值。
    return {
      name: "machine_search_mcp",
      status: "pass",
      detail: `已检测到机器 web-search-prime MCP（host=${host}；Authorization 已配置；将作 fallback_chain 首选 search.machine_mcp）`,
    };
  } catch (e) {
    // 防御性兜底（detectMachineSearchMcp 自身永不抛；本 catch 仅守 doctor 永不崩）
    return {
      name: "machine_search_mcp",
      status: "warn",
      detail: `探测 ${claudeJsonPath} 时异常：${String(e)}`,
    };
  }
}
