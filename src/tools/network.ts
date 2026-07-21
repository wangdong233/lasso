/**
 * network tool 注册（parse6 §3.4 v0.5 M0.5c 新增）
 *
 * URL → navigate + 注入 PerformanceObserver 抓资源列表（经 HeadlessChannel.browse 入口）。
 *
 * 设计要点（parse6 §3.4 + §4.4 + §7.1 F2）：
 *  - 经 BrowseChannel 入口（headless.browse(url, "network", opts)）—— 守 INV-33
 *  - 实现路径：evaluate_script 注入 PerformanceObserver（JS-level 抓取，parse6 §3.4.2 伪码）
 *  - 3rd-party 过滤：URL host ≠ page host → third_party=true（v0.5 host 精确匹配；
 *    eTLD+1 推 v0.6；简化版用 URL.hostname 精确比较）
 *  - filter 维度：xhr / fetch / img / 3rd-party / all（5 case 单维度 switch；parse6 §3.4.3）
 *  - 资源列表过 applyOutputEnvelope（典型页面 50-500 资源 × 200 字节/条 = 10-100 KiB，
 *    常超 48KiB → 自动落盘 .txt + @oN ref；INV-34 + INV-15 衍生）
 *  - pageRef v0.5 不支持（仅 URL 入参；pageRef 推 v0.6 forest 合并后）
 *  - SSRF 与 browse_headless 同函数同 config（守 INV-31 衍生：独立工具也必经 ssrfGuard）
 *
 * 边界（parse6 §1.2）：
 *  - 不抓 CDP Network-level 请求（v0.7 F3.7.x 完整 perf trace；F2 文档化为已知限制）
 *  - 不抓 WebSocket frame（v1.0+）
 *  - 不抓 response body（include_bodies 接受但不实装；推 v0.6）
 *  - 不 mock / 不 intercept / 不 replay（永远 NO-GO）
 *  - 不导出 HAR 文件（v0.7 F3.7.x）
 *
 * 守简单性（02 §5.5 R-CI-02 + §6.3 review 三问）：
 *  - 复用既有 ssrfGuard / applyOutputEnvelope / BrowseChannel.browse 范式
 *  - 不引入第二套抓资源范式；doctor 探测 cdp_mcp_network_tool_available 复用 runDoctor 框架
 *
 * 借鉴：browse.ts registerBrowseTools（ssrfBlocked / InteractResult 包装范式）；
 *      pdf.ts doPdfTool（payloadContent + outcome 分类 + next_step 降级提示）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  BrowseOptions,
  InteractResult,
  NetworkOptions,
  NetworkResult,
} from "../types.js";
import type { HeadlessChannel } from "../channels/HeadlessChannel.js";
import { ssrfGuard, type SsrfConfig } from "../ssrf/ssrf-guard.js";
import { applyOutputEnvelope } from "../util/output-envelope.js";
import { NETWORK_DESCRIPTION } from "./descriptions.js";
import { networkAnnotations } from "./annotations.js";
import { logger } from "../util/logger.js";

// ============================================================
// Schema（parse6 §3.4.3）
// ============================================================
export const networkSchema = {
  url: z.string().url(),
  options: z
    .object({
      filter: z
        .enum(["xhr", "fetch", "img", "3rd-party", "all"])
        .default("all"),
      // v0.5 接受但 doNetwork 现不映射（守 parse6 §3.4.3 文档化「v0.5 不实装 bodies」）
      // 为 v0.6+ 预留，避免 schema 漂移；CC 据 description 知道此字段未生效
      include_bodies: z.boolean().default(false),
      // PerformanceObserver 采集窗口（默认 3000ms；上限 30000ms 防 caller 误传巨大值）
      timeout_ms: z.number().int().positive().max(30_000).default(3_000),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .default("load"),
    })
    .default({}),
};

// ============================================================
// 包装 helper（与 browse.ts / pdf.ts / screenshot.ts 同范式）
// ============================================================
function payloadContent<T>(result: InteractResult<T>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}

// ============================================================
// Go/No-Go F2：上游 evaluate_script 错误识别（parse6 §4.4 + §7.1 F2）
// ============================================================
/**
 * 把 doNetwork / BrowseChannel.browse() 抛出的错误信息分类，识别「上游不支持」场景。
 *
 * chrome-devtools-mcp evaluate_script 调用失败的错误形式（parse6 §4.4 + §7.1 F2）：
 *  - doNetwork cdp-actions.ts 内已标准化为 `upstream_network_error:*` 前缀
 *  - McpClient.callTool 上游返 "Unknown tool: evaluate_script" 等 NotFound 类错误
 *
 * 命中 → 上层 network.ts 返 outcome=didnt + retrieval_method=upstream_unsupported:network + next_step
 * 未命中 → 错误透传（classifyBrowseError 已分类 outcome=unknown 等；本函数不重复分类）
 */
export function isUpstreamNetworkUnsupported(
  error: string | undefined,
): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  // cdp-actions.ts doNetwork 已标准化的前缀（无论 callTool reject 还是 isError）
  if (error.includes("upstream_network_error:")) return true;
  // 上游 chrome-devtools-mcp 直接抛的 NotFound 类错误（兼容无 cdp-actions 包装的直传路径）
  if (
    lower.includes("unknown tool") &&
    (lower.includes("evaluate_script") || lower.includes("network"))
  ) {
    return true;
  }
  if (
    lower.includes("tool") &&
    lower.includes("evaluate_script") &&
    lower.includes("not found")
  ) {
    return true;
  }
  return false;
}

// ============================================================
// PerformanceObserver 条目类型（parse6 §3.4.2 注入脚本返的 entries shape）
// ============================================================
export interface ResourceEntry {
  name: string;
  type: string;
  duration: number;
  ttfb: number;
  bytes: number;
  workerStart?: number;
  /** network.ts 工具层标 third_party（host ≠ page host；v0.5 host 精确匹配） */
  third_party?: boolean;
}

// ============================================================
// 3rd-party 标记 + 过滤（parse6 §3.4.3 filterResources）
// ============================================================
/**
 * 给 entries 标 third_party 字段，按 filter 维度过滤。
 *
 * v0.5 简化版（parse6 §3.4.3）：host 精确匹配（eTLD+1 推 v0.6）。
 *  - third_party = (entry host !== pageHost) && (entry host !== "")
 *  - filter 维度 5 case 单维度 switch（parse6 §3.4.3）
 *
 * PerformanceObserver initiatorType 取值（W3C Resource Timing）：
 *  - xmlhttprequest (XHR) / fetch / img / css / script / link / iframe / object / embed / video / audio / etc.
 *  - 我们 normalize "xmlhttprequest" → "xhr"（filter 维度）；其他原样保留
 */
export function filterResources(
  entries: ResourceEntry[],
  filter: "xhr" | "fetch" | "img" | "3rd-party" | "all",
  pageHost: string,
): ResourceEntry[] {
  // 先标 third_party
  const tagged = entries.map((e) => {
    let host = "";
    try {
      host = new URL(e.name).hostname;
    } catch {
      // invalid url → 留空 host；third_party 标 false（避免误判）
    }
    return { ...e, third_party: host !== "" && host !== pageHost };
  });
  switch (filter) {
    case "xhr":
      // W3C initiatorType=xmlhttprequest；filter 维度 'xhr'
      return tagged.filter((e) => e.type === "xmlhttprequest");
    case "fetch":
      return tagged.filter((e) => e.type === "fetch");
    case "img":
      // initiatorType=img 或 cssimage（旧 webkit）；filter 维度 'img'
      return tagged.filter((e) => e.type === "img" || e.type === "cssimage");
    case "3rd-party":
      return tagged.filter((e) => e.third_party === true);
    case "all":
    default:
      return tagged;
  }
}

// ============================================================
// Go/No-Go F2：PerformanceObserver 抓不全检测（parse6 §7.1 F2）
// ============================================================
/**
 * 检测 PerformanceObserver 是否在当前环境抓不全。
 *
 * 触发条件（parse6 §7.1 F2）：
 *  - network tool 测试资源数 < 页面真实资源数 × 0.5（典型页面 ≥10 资源；<5 视为抓不全）
 *
 * v0.5 启发式：raw entries 数 < 5（且不是 outcome=worked 空页面的合法场景）→ 挂 next_step
 * 这个阈值是保守的（避免误报合法空页面）；caller 据 next_step 自决是否升级。
 */
export function shouldFlagIncompleteEntries(
  rawEntryCount: number,
): boolean {
  // 典型复杂页面 ≥10 资源；PerformanceObserver 抓 < 5 时高度怀疑 fake-ip TUN 透明代理改 timing
  // 注：纯 JSON / 单页 SPA 可能合法 < 5 资源（不阻断 outcome=worked，只挂 hint）
  return rawEntryCount < 5;
}

// ============================================================
// 核心：doNetworkTool（独立可测，parse6 §3.4.3 实装）
// ============================================================
/**
 * network 的纯函数实装 —— 单元测直接调，不经 MCP server.tool 装配。
 *
 * 流程（parse6 §3.4.3 伪码逐条对齐）：
 *  1. SSRF 守门（与 browse_headless 同函数同 config）
 *  2. 透传 BrowseOptions 形状（network_* 字段；BrowseChannel → doNetwork 读）
 *  3. 经 BrowseChannel 入口（headless.browse(url, "network", opts)）
 *  4. **Go/No-Go F2**：若 result.error 含 `upstream_network_error` /
 *     `Unknown tool: evaluate_script` → outcome=didnt + retrieval_method=upstream_unsupported:network
 *  5. result.data.preview 是 entries JSON 字符串 → JSON.parse → filterResources →
 *     applyOutputEnvelope（资源列表 JSON 过 envelope 落 .txt；INV-34）
 *  6. third_party_count + resource_count 计算
 *  7. F2 抓不全启发式（< 5 entries）→ 挂 data.next_step（不阻断 outcome=worked）
 *  8. 返 InteractResult<NetworkResult>
 */
export async function doNetworkTool(
  rawUrl: string,
  opts: NetworkOptions,
  headless: HeadlessChannel,
  ssrfConfig: SsrfConfig,
): Promise<InteractResult<NetworkResult>> {
  // ---------- 1. SSRF 守门（与 browse_headless 同函数同 config） ----------
  const ssrfResult = await ssrfGuard(rawUrl, ssrfConfig);
  if (!ssrfResult.allowed) {
    return {
      outcome: "didnt",
      data: null,
      served_by: "lasso.ssr_guard",
      fallback_used: false,
      retrieval_method: "ssrf_blocked",
      error: `ssrf_blocked:${ssrfResult.reason}`,
    };
  }

  // ---------- 2. 透传 BrowseOptions 形状（network_* 字段；doNetwork 读） ----------
  const browseOpts: BrowseOptions = {
    network_filter: opts.filter,
    network_include_bodies: opts.include_bodies,
    network_timeout_ms: opts.timeout_ms,
    wait_until: opts.wait_until,
  };

  // ---------- 3. 经 BrowseChannel 入口（隐式享受 browse fallback 链；不绕过 INV-6） ----------
  const result = await headless.browse(rawUrl, "network", browseOpts);

  // ---------- 4. Go/No-Go F2：上游不支持 evaluate_script → didnt + upstream_unsupported ----------
  if (isUpstreamNetworkUnsupported(result.error)) {
    logger.warn({
      evt: "network_upstream_unsupported",
      url: rawUrl,
      error: result.error,
    });
    return {
      outcome: "didnt",
      data: {
        url: rawUrl,
        page_host: safeHostname(rawUrl),
        resource_count: 0,
        third_party_count: 0,
        next_step:
          "chrome-devtools-mcp@LOCKED 不支持 evaluate_script 注入；等待上游暴露 network_log 工具（v0.6+），或改用 browse_headless snapshot 观察 DOM 加载状态",
      },
      served_by: result.served_by,
      fallback_used: false,
      retrieval_method: "upstream_unsupported:network",
      error: result.error,
    };
  }

  // ---------- 5. preview 是 entries JSON → parse + filter + envelope ----------
  const pageHost = safeHostname(rawUrl);
  let envelope: ReturnType<typeof applyOutputEnvelope> | undefined;
  let resourceCount = 0;
  let thirdPartyCount = 0;
  let rawEntryCount = 0;
  let parseFailed = false;
  let nextStep: string | undefined;

  if (result.outcome === "worked" && result.data?.preview) {
    let raw: ResourceEntry[] = [];
    try {
      raw = JSON.parse(result.data.preview) as ResourceEntry[];
      if (!Array.isArray(raw)) {
        raw = [];
        parseFailed = true;
      }
    } catch {
      raw = [];
      parseFailed = true;
    }
    rawEntryCount = raw.length;

    // 过滤（parse6 §3.4.3 filterResources）
    const filtered = filterResources(raw, opts.filter, pageHost);
    resourceCount = filtered.length;
    thirdPartyCount = filtered.filter((e) => e.third_party === true).length;

    // F2：抓不全启发式（典型复杂页 ≥10 资源；raw < 5 时高度怀疑 fake-ip TUN 透明代理改 timing）
    if (shouldFlagIncompleteEntries(rawEntryCount)) {
      nextStep =
        "PerformanceObserver entries count < 5：可能页面真实简单（合法），或 fake-ip TUN / proxy 改 timing 导致抓不全；retry options.timeout_ms=10000，或等待 v0.7 F3.7.x 完整 CDP Network-level perf trace";
    }

    try {
      envelope = applyOutputEnvelope(
        JSON.stringify(filtered, null, 2),
        "network log too large: narrow by filter (xhr/fetch/img) or 3rd-party-only",
        ".txt", // 资源列表 JSON → 落 .txt（INV-34 + INV-15 衍生）
      );
    } catch (e) {
      // envelope 单条 16 MiB 上限保护：超限（资源列表 JSON > 16 MiB ≈ 80k 资源条；极端场景）
      return {
        outcome: "didnt",
        data: {
          url: rawUrl,
          page_host: pageHost,
          resource_count: resourceCount,
          third_party_count: thirdPartyCount,
        },
        served_by: result.served_by,
        fallback_used: false,
        retrieval_method: "envelope_cap_exceeded",
        error: `network_envelope_failed:${String(e).slice(0, 200)}`,
      };
    }
  }

  // parseFailed 时降级 outcome（不崩；data 仍带 page_host）
  if (parseFailed && result.outcome === "worked") {
    return {
      outcome: "didnt",
      data: {
        url: rawUrl,
        page_host: pageHost,
        resource_count: 0,
        third_party_count: 0,
        next_step:
          "PerformanceObserver entries JSON 解析失败；可能上游 evaluate_script 返非预期格式；retry，或等待 v0.7 F3.7.x 完整 CDP Network-level perf trace",
      },
      served_by: result.served_by,
      fallback_used: false,
      retrieval_method: "entries_parse_failed",
      error: result.error,
    };
  }

  // ---------- 8. 返 InteractResult<NetworkResult> ----------
  const networkResult: InteractResult<NetworkResult> = {
    outcome: result.outcome,
    data: result.data
      ? {
          url: rawUrl,
          page_host: pageHost,
          resource_count: resourceCount,
          third_party_count: thirdPartyCount,
          ...(envelope ? { envelope } : {}),
          ...(result.data.state_id ? { state_id: result.data.state_id } : {}),
          ...(nextStep ? { next_step: nextStep } : {}),
        }
      : null,
    served_by: result.served_by,
    fallback_used: result.fallback_used,
    retrieval_method:
      result.outcome === "worked"
        ? "performance_observer"
        : (result.retrieval_method ?? "network_failed"),
    ...(result.error ? { error: result.error } : {}),
  };
  return networkResult;
}

/**
 * helper：URL → hostname（无效 URL 返空字符串；不抛错）。
 *
 * 用于 3rd-party 判定（filterResources 的 pageHost 基线）。
 * network tool 的 url 已在 SSRF 守门时验证可达，理论必合法；此 helper 是兜底。
 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// ============================================================
// 注册器（parse6 §3.4.3）
// ============================================================
/**
 * @param server      MCP server
 * @param headless    HeadlessChannel（chrome-devtools-mcp --headless --isolated）
 * @param ssrfConfig  SSRF allowRanges / denyRanges（从 env 加载，与 browse_headless 共用）
 */
export function registerNetworkTool(
  server: McpServer,
  headless: HeadlessChannel,
  ssrfConfig: SsrfConfig,
): void {
  server.tool(
    "network",
    NETWORK_DESCRIPTION,
    networkSchema,
    networkAnnotations,
    async (args) => {
      const url: string = args.url;
      // zod .default({}) 已注入所有默认值
      const opts: NetworkOptions = {
        filter: args.options.filter,
        include_bodies: args.options.include_bodies,
        timeout_ms: args.options.timeout_ms,
        wait_until: args.options.wait_until,
      };

      const result = await doNetworkTool(url, opts, headless, ssrfConfig);
      // SSRF 拒绝 / Go/No-Go F2 / browse 失败 / 成功 都包成 InteractResult，序列化即可
      return payloadContent(result);
    },
  );
}
