/**
 * creepjs-probe（parse15 §3.1，v1.7 Phase A）
 *
 *  - probeCreepjs(client, opts) → CreepjsLiesReport
 *  - 给定一个已连 chrome-devtools-mcp 的 McpClient（StealthEngine 已注入），
 *    驱动一次 creepjs 回归探测，返回结构化 lies 报告。
 *
 * 诚实定位（parse15 §1.2 + §8.1）：
 *  - 本探测是**回归门禁**（冻结 v1.7 lies 基线防退化），**不是 stealth 质量分数**。
 *  - Lasso v1.5 的 16 路 JS defineProperty evasion 正好命中 creepjs 的 prototype lie
 *    检测点（Navigator.webdriver / languages / plugins / vendor / hardwareConcurrency /
 *    WebGLRenderingContext.getParameter / Permissions.query）—— 这是 JS defineProperty
 *    范式的结构性上限，不是 bug。
 *  - doctor #38 stealth_creepjs_regression 据本 probe 返回值与 baseline fixture 比对，
 *    lies 数不得恶化（tolerance.totalLiesDelta=0），不是达标线。
 *
 * 关键设计（parse15 §3.1）：
 *  1. CREEPJS_LIES_EXTRACT_SCRIPT 是顶级 const（INV-30 衍生：脚本数据走顶级 const，
 *     不从 process.env / config 读——防 LLM 改探测脚本伪造分数）
 *  2. 三段式 producer 契约（parse15 §3.1 + §6.2 §1.2 项1）：
 *     a. navigate_page → creepjs 页面加载（producer 契约：chrome-devtools-mcp 返 content blocks）
 *     b. wait_for "FP ID:" → creepjs 计算完成（creep.ts 末段 patch('creep-fingerprint') 在
 *        fingerprint 完成后才渲染 "FP ID:"——这是关键 producer 契约验证点）
 *     c. evaluate_script → 读 window.Fingerprint 程序化字段（不截图、不靠 trust score）
 *  3. 错误路径每条显式（parse15 §3.1 步骤 5；03 §1.2 项7）：
 *     - navigate 失败（网络错 / timeout）→ reachable:false
 *     - wait_for timeout → reachable:true, fingerprintComputed:false
 *     - evaluate 返非 JSON / fingerprintComputed:false → 同上
 *     - evaluate 抛错 → catch 返 fingerprintComputed:false, error
 *  4. 不入运行时四通道（INV-75 grep 守：仅 doctor/ 调用，不出现在 src/channels/ 或 src/browse/）
 *
 * 上游证据（parse15 §1.2 + §4.1 真读 abrahamjuliot/creepjs）：
 *  - creep.ts 末段：`window.Fingerprint = JSON.parse(JSON.stringify(fp))`
 *                  `window.Creep = JSON.parse(JSON.stringify(creep))`
 *    ——程序化访问入口（不必截图人工看）
 *  - lies/index.ts getLies() 返 `{ data: Record<string, string[]>, totalLies: number }`
 *    ——每个被检出篡改的 API 是一个 key，value 是 lie 类型数组；totalLies 是总数
 *  - per-module `lied` bool（fp.navigator.lied / fp.screen.lied / fp.canvasWebgl.lied ...）
 *    ——量化信号
 *
 * 借鉴（同构范围）：
 *  - StealthEngine.ts detectCloudflareChallenge 的 evaluate_script + firstText 范式
 *  - doctor.ts checkCdpMcpPdfToolAvailable 的 callTool 范式
 */
import type { McpClient } from "../subprocess/McpClient.js";
import { logger } from "../util/logger.js";
import { parseEvalResult } from "../browse/upstream-response.js";

// ============================================================
// 类型
// ============================================================
/**
 * creepjs 探测结构化报告。
 *
 * 字段集 ↔ creepjs-baseline.json baseline 字段 ↔ doctor #38 比对逻辑（parse15 §6.2 §1.7.7
 * 跨边界同步对：三处字段集显式枚举配对；改字段须三处同步）。
 */
export interface CreepjsLiesReport {
  /** creepjs 页面是否加载成功（navigate 失败 → false） */
  reachable: boolean;
  /** window.Fingerprint 是否非空（计算完成；wait_for / evaluate 失败 → false） */
  fingerprintComputed: boolean;
  /** getLies().totalLies；回归门禁的核心量化信号 */
  totalLies: number;
  /** 被检出 lie 的模块名（keys of fingerprint.*.lied=true） */
  liedModules: string[];
  /** fingerprint.navigator?.lied（最关键，Lasso defineProperty 主战场） */
  navigatorLied: boolean;
  /** fingerprint.screen?.lied */
  screenLied: boolean;
  /** fingerprint.canvasWebgl?.lied */
  canvasWebglLied: boolean;
  /** fingerprint.canvas2d?.lied */
  canvas2dLied: boolean;
  /** fingerprint.permissions?.lied */
  permissionsLied: boolean;
  /** fingerprint.webglVersion?.lied / WebGLRenderingContext.getParameter lie */
  webglGetParameterLied: boolean;
  /** 页面 footer / hash 标识（判 creepjs 上游升级；空串=未取到） */
  creepjsVersion: string;
  /** 探测总耗时（ms） */
  elapsedMs: number;
  /** JSON.stringify(window.Fingerprint.lies).slice(0,500)（诊断用；失败时含 error） */
  rawSample: string;
}

// ============================================================
// CREEPJS_LIES_EXTRACT_SCRIPT（顶级 const，INV-30 衍生）
// ============================================================
/**
 * 读 window.Fingerprint 的 lies 字段的 evaluate_script 脚本。
 *
 * 设计约束：
 *  1. **顶级 const**（INV-30 衍生）：不从 process.env / config 读，防 LLM 改探测脚本
 *     伪造分数。任何字段调整须改本 const + 同步 CreepjsLiesReport 接口 + baseline.json。
 *  2. **try/catch 全包**：页面 CSP / 扩展拦 / window.Fingerprint 未就绪 → 返结构化
 *     `{fingerprintComputed:false, error}` 不抛。
 *  3. **JSON.stringify 返回**：chrome-devtools-mcp evaluate_script 经 JSON 序列化传递；
 *     caller 端 JSON.parse（firstText 范式，同 StealthEngine.ts:223）。
 *  4. **字段集 ↔ CreepjsLiesReport 一一对应**（parse15 §6.2 §1.7.7 跨边界同步对）：
 *     fingerprintComputed / totalLies / liedModules / navigatorLied / screenLied /
 *     canvas2dLied / canvasWebglLied / creepjsVersion（permissionsLied + webglGetParameterLied
 *     在 caller 端从 liedModules 推导，避免 evaluate 脚本过长）。
 */
export const CREEPJS_LIES_EXTRACT_SCRIPT = `() => {
  try {
    var fp = window.Fingerprint;
    if (!fp) return JSON.stringify({fingerprintComputed:false});
    var nav = fp.navigator || {}, scr = fp.screen || {}, c2d = fp.canvas2d || {},
        cgl = fp.canvasWebgl || {}, perm = fp.permissions || {}, lies = fp.lies || {};
    return JSON.stringify({
      fingerprintComputed: true,
      totalLies: (lies && typeof lies.totalLies === 'number') ? lies.totalLies : 0,
      liedModules: Object.keys(fp).filter(function(k){ return fp[k] && (fp[k].lied === true); }),
      navigatorLied: !!nav.lied,
      screenLied: !!scr.lied,
      canvas2dLied: !!c2d.lied,
      canvasWebglLied: !!cgl.lied,
      permissionsLied: !!perm.lied,
      creepjsVersion: ((document.querySelector('.fingerprint-header .time')||{}).textContent) || ''
    });
  } catch(e) {
    return JSON.stringify({fingerprintComputed:false, error:String(e).slice(0,200)});
  }
}`;

// ============================================================
// 默认配置（顶级 const）
// ============================================================
const DEFAULT_CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/";
const DEFAULT_WAIT_TEXT = "FP ID:";
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

// ============================================================
// probeCreepjs
// ============================================================
/**
 * 驱动一次 creepjs 回归探测（parse15 §3.1）。
 *
 * 流程：
 *  1. navigate creepjs 页面（默认 abrahamjuliot.github.io/creepjs/）
 *  2. wait_for "FP ID:" → 等 fingerprint 计算完成（producer 契约验证点）
 *  3. evaluate CREEPJS_LIES_EXTRACT_SCRIPT → 读 window.Fingerprint 字段
 *  4. 解析返回 → CreepjsLiesReport
 *
 * 错误路径（每条显式，graceful 不抛）：
 *  - navigate 失败 → reachable:false + 其余 false/0
 *  - wait_for timeout → reachable:true, fingerprintComputed:false
 *  - evaluate 返非 JSON / fingerprintComputed:false → reachable:true, fingerprintComputed:false
 *
 * @param client 已连 chrome-devtools-mcp 的 McpClient（StealthEngine 已注入）
 * @param opts.url creepjs 页面 URL（默认 abrahamjuliot.github.io/creepjs/）
 * @param opts.timeoutMs 总超时（默认 30s）；内部 wait_for 用 min(timeoutMs/2, 15s)
 */
export async function probeCreepjs(
  client: McpClient,
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<CreepjsLiesReport> {
  const url = opts.url ?? DEFAULT_CREEPJS_URL;
  const totalTimeout = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const waitTimeout = Math.min(Math.floor(totalTimeout / 2), DEFAULT_WAIT_TIMEOUT_MS);
  const start = Date.now();

  const empty: CreepjsLiesReport = {
    reachable: false,
    fingerprintComputed: false,
    totalLies: 0,
    liedModules: [],
    navigatorLied: false,
    screenLied: false,
    canvasWebglLied: false,
    canvas2dLied: false,
    permissionsLied: false,
    webglGetParameterLied: false,
    creepjsVersion: "",
    elapsedMs: 0,
    rawSample: "",
  };

  // ---- 1. navigate ----
  try {
    await client.callTool("navigate_page", { type: "url", url });
  } catch (e) {
    logger.warn({
      evt: "creepjs_probe_navigate_failed",
      url,
      error: String(e),
    });
    return {
      ...empty,
      reachable: false,
      elapsedMs: Date.now() - start,
      rawSample: `navigate_failed:${String(e).slice(0, 200)}`,
    };
  }

  // ---- 2. wait_for "FP ID:" ----
  // producer 契约（parse15 §3.1 步骤 2 + §6.2 §1.2 项1）：creep.ts 末段 patch('creep-fingerprint')
  // 在 fingerprint 完成后才渲染 "FP ID:"，wait_for 命中即 window.Fingerprint 已 populate。
  try {
    await client.callTool("wait_for", {
      // v1.11（round1 T1）：chrome-devtools-mcp 1.7.0 wait_for.text 契约是
      // array(string).min(1)（0.3.0 要 string，W1-DEF-2 随版本迁移翻转）。
      text: [DEFAULT_WAIT_TEXT],
      timeout: waitTimeout,
    });
  } catch (e) {
    logger.warn({
      evt: "creepjs_probe_wait_fp_id_timeout",
      url,
      timeoutMs: waitTimeout,
      error: String(e),
    });
    return {
      ...empty,
      reachable: true,
      fingerprintComputed: false,
      elapsedMs: Date.now() - start,
      rawSample: `wait_fp_id_timeout:${String(e).slice(0, 200)}`,
    };
  }

  // ---- 3. evaluate CREEPJS_LIES_EXTRACT_SCRIPT ----
  let rawText: string;
  try {
    const r = (await client.callTool("evaluate_script", {
      function: CREEPJS_LIES_EXTRACT_SCRIPT,
    })) as ContentResult;
    // W1-DEF-1b（v1.8）：经 parseEvalResult 解围栏（脚本 return JSON.stringify(payload) 双层编码）
    rawText =
      (() => {
        const v = parseEvalResult(r);
        if (v == null) return firstText(r) ?? "";
        return typeof v === "string" ? v : JSON.stringify(v);
      })() ?? "";
  } catch (e) {
    logger.warn({
      evt: "creepjs_probe_evaluate_failed",
      url,
      error: String(e),
    });
    return {
      ...empty,
      reachable: true,
      fingerprintComputed: false,
      elapsedMs: Date.now() - start,
      rawSample: `evaluate_failed:${String(e).slice(0, 200)}`,
    };
  }

  // ---- 4. 解析返回 ----
  let parsed: Partial<CreepjsExtractPayload> & { error?: string };
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    logger.warn({
      evt: "creepjs_probe_parse_failed",
      url,
      raw: rawText.slice(0, 200),
      error: String(e),
    });
    return {
      ...empty,
      reachable: true,
      fingerprintComputed: false,
      elapsedMs: Date.now() - start,
      rawSample: `parse_failed:${rawText.slice(0, 200)}`,
    };
  }

  // fingerprintComputed=false（window.Fingerprint 未就绪 / 脚本 catch）
  if (!parsed.fingerprintComputed) {
    return {
      ...empty,
      reachable: true,
      fingerprintComputed: false,
      elapsedMs: Date.now() - start,
      rawSample: `fingerprint_not_computed:${parsed.error ?? ""}`.slice(0, 500),
    };
  }

  // 成功路径：从 liedModules 推导 permissionsLied / webglGetParameterLied
  // （evaluate 脚本里也直接读 fp.permissions.lied，这里两个数据源都接受；前者更可靠）
  const liedModules = Array.isArray(parsed.liedModules)
    ? parsed.liedModules.filter((x) => typeof x === "string")
    : [];
  return {
    reachable: true,
    fingerprintComputed: true,
    totalLies:
      typeof parsed.totalLies === "number" ? parsed.totalLies : 0,
    liedModules,
    navigatorLied: !!parsed.navigatorLied,
    screenLied: !!parsed.screenLied,
    canvasWebglLied: !!parsed.canvasWebglLied,
    canvas2dLied: !!parsed.canvas2dLied,
    permissionsLied:
      !!parsed.permissionsLied || liedModules.includes("permissions"),
    webglGetParameterLied: liedModules.some((m) =>
      /webgl|getParameter/i.test(m),
    ),
    creepjsVersion:
      typeof parsed.creepjsVersion === "string" ? parsed.creepjsVersion : "",
    elapsedMs: Date.now() - start,
    rawSample: rawText.slice(0, 500),
  };
}

// ============================================================
// 内部 helper（同构 StealthEngine.ts:220-229）
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

// evaluate_script 返回 payload 形状（与 CREEPJS_LIES_EXTRACT_SCRIPT 字段集一一对应）
interface CreepjsExtractPayload {
  fingerprintComputed: boolean;
  totalLies: number;
  liedModules: string[];
  navigatorLied: boolean;
  screenLied: boolean;
  canvas2dLied: boolean;
  canvasWebglLied: boolean;
  permissionsLied: boolean;
  creepjsVersion: string;
}
