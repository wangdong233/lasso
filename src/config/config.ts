/**
 * 配置加载（parse1 §2 + parse2 §3.1.4 v0.2 升级 + parse10 §3 v0.9 Phase B + v1.3 Phase A config 文件机制）
 *
 * 真源（优先级低→高）：
 *   1. config 文件 ~/.lasso/config.json（v1.3 新增；扁平 JSON，key 名同 env；user-friendly 默认层）
 *   2. env (BRAVE_API_KEYS / LASSO_CDP_PORT / LASSO_CACHE_DIR /
 *           LASSO_SEARCH_FREE_ONLY / LASSO_SSRF_*；ZHIPU_API_KEY / ZHIPU_ENDPOINT /
 *           BING_API_KEYS 容忍读但已退役不消费——见底部 v1.15 / v1.17 注）
 *           —— 覆盖 config 文件（向后兼容）
 *
 * v1.3 Phase A（本提交）：config 文件机制落地。
 *   - DONE v1.3：读 ~/.lasso/config.json 扁平 JSON（LASSO_CONFIG_PATH 可覆盖路径）；
 *     合并顺序 file(base) → env(覆盖)。既有 -e KEY=VAL 装时 env 用户不破；零配置（无文件）仍可跑。
 *   - 不读 ~/.claude.json（早期 TODO 提及的路径已废弃；改走 ~/.lasso/config.json 独立文件，
 *     避免 CC 全局配置污染 + 用户难发现 lasso 段）。
 *
 * 单一真相：LassoConfig 是整个进程读配置的唯一入口，channel 工具都从这里拿值。
 *
 * v0.2 新增（parse2 §3.1.4，全保留 v0.1 env 与字段）：
 *  - BRAVE_API_KEYS / BRAVE_API_KEY CSV 多 Key 解析 → providers.get("brave").keys
 *  - LASSO_SEARCH_FREE_ONLY（默认 L4=全部允许；设 L2 则禁付费）
 *  - ProviderRegistry 装配（CapabilityBag 自动生成）
 *  - searchCacheDir（~/.cache/lasso/search-cache/，F3.1.4 cache 落盘根）
 *
 * v1.15 Phase A（Bing 死层清除）：
 *  - BING_API_KEYS / BING_API_KEY env / config 文件键**容忍读但不消费**（静默忽略）：
 *    Bing Search APIs 已于 2025-08-11 全量退役（微软 lifecycle 公告，2026-08-17 核实），
 *    bing provider 永不注册进 providers map（存量用户 config 不炸；doctor #11c
 *    bing_keys_retired 检测到非空键 → warn 建议删除）。INV-54 墓碑守卫防回潮。
 *
 * v1.17 A3（doc/25 裁决③：zhipu 直连 API channel 删除，machine_mcp 保留）：
 *  - ZHIPU_API_KEY / ZHIPU_ENDPOINT env / config 文件键**容忍读但不消费**（静默忽略）：
 *    zhipu provider 永不注册进 providers map、不注入任何 provider keys
 *    （存量用户 config 不炸；doctor zhipu_keys_retired 检测到非空键 → warn 建议删除）。
 *    INV-80 墓碑守卫防回潮。智谱搜索能力的现行载体 = search.machine_mcp（机器
 *    ~/.claude.json 已配的 web-search-prime MCP，零配置复用）。
 */
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import type { FreeTierLevel, ProviderConfig } from "../types.js";
import { BUILTIN_PROVIDERS } from "./providers.js";
import { ProviderRegistry } from "./provider-registry.js";
import { logger } from "../util/logger.js";
// C2（v1.18，doc/28 D-2）：延迟窗默认值单一真源在 reaper（消费方语义所有者）
import { AUTO_HIDE_AFTER_LOGIN_DELAY_MS } from "../launcher/chrome-idle-reaper.js";

export interface LassoConfig {
  runId: string;
  providers: Map<string, ProviderConfig>;
  // v1.17 A3：zhipuApiKey / zhipuEndpoint 字段已删（zhipu 直连 channel 死层清除；
  // ZHIPU_API_KEY / ZHIPU_ENDPOINT 键容忍读但不消费，doctor zhipu_keys_retired 提示）
  cdpPort: number;
  /**
   * v1.11（round1 T10）：浏览器出口代理（env LASSO_PROXY；默认 "" 不代理）。
   * 生效面：browse_headless spec `--proxy-server=` + Steel session `proxyUrl`。
   * **browse_logged_in 永不读取**（用户真实 Chrome 出口必须原样——铁律，有负向测试钉死）。
   * 用户显式配置（非 LLM 可控），不触碰 INV-30 stealth anti-gaming 面。
   */
  proxy: string;
  cacheDir: string;
  // --- v0.2 新增 ---
  /** ProviderRegistry 实例（v0.2 Phase A 落地，后续 channel/search 从这里查） */
  registry: ProviderRegistry;
  /** search cache 落盘根（~/.cache/lasso/search-cache/） */
  searchCacheDir: string;
  /** free_only 全局默认（env LASSO_SEARCH_FREE_ONLY，默认 L4=全部允许） */
  searchFreeOnly: FreeTierLevel;
  /**
   * v1.9（parse17 §2.2 (a) 机制一）：MCP 浏览器子进程空闲回收阈值（ms）。
   * env LASSO_HEADLESS_IDLE_MS（默认 300_000 = 5min；0 = 禁用 idle watchdog）。
   * 到期由 zombie reaper（60s 周期）树杀整棵 shim→node→Chromium 树。
   */
  headlessIdleMs: number;
  /**
   * v1.10（parse18 §2.4 机制一）：launch-chrome 起的台账 Chrome「用完即关」
   * idle 阈值（ms）。env LASSO_LAUNCH_IDLE_MS（默认 60_000；0 = 禁用 reaper）。
   * 到期由 chrome-idle-reaper（15s 周期）经 chrome-stop 验证归属后回收。
   * **与 headlessIdleMs 分工勿混**：LAUNCH=台账 detached Chrome；
   * HEADLESS=MCP spec 子进程树（白盒 §6.1）。
   */
  launchIdleMs: number;
  /**
   * v1.10（parse18 §3 机制二）：launch-chrome 启动档。
   * env LASSO_LAUNCH_MODE（默认 "hidden" = 0 窗口零打扰；"visible" = v1.9 可见行为）。
   */
  launchMode: "hidden" | "visible";
  /**
   * C2（v1.18，doc/28-静默守则审计 D-2）：台账 visible 档 Chrome「登录完成 →
   * 自动 hide 转后台静默」（chrome-idle-reaper 四重护栏：见墙→墙消失→延迟窗→
   * agent 无近期活动；失败降级不 hide）。env LASSO_AUTO_HIDE_AFTER_LOGIN
   * （默认 false，**opt-in**——假阳性会把用户正在看的窗口收走，交用户裁决）。
   */
  autoHideAfterLogin: boolean;
  /** C2：登录墙消失后的等待窗 ms（env LASSO_AUTO_HIDE_AFTER_LOGIN_DELAY_MS；默认 10_000）。 */
  autoHideAfterLoginDelayMs: number;
}

export interface LoadConfigOptions {
  runId: string;
  env?: NodeJS.ProcessEnv;
}

function defaultCacheDir(): string {
  return path.join(os.homedir(), ".cache", "lasso");
}

/**
 * v1.9（parse17 §2.2 (a)）：LASSO_HEADLESS_IDLE_MS 默认 5min。
 * parse17 §1.2 折中：高频连续 browse 复用浏览器（懒复用设计），5min 无人用即回收
 * （52 进程积留的对症）。要回退 v1.8.1 常驻行为配 3600000。
 */
export const DEFAULT_HEADLESS_IDLE_MS = 300_000;

/**
 * 解析 LASSO_HEADLESS_IDLE_MS：parseInt；负数 / NaN / 未设 → 回退默认；
 * 0 → 禁用（index.ts 不启动 zombie reaper——文档明示 opt-out 即自负残留）。
 * 不设上限 clamp（用户要配更长随他，parse17 §2.2 (a)）。
 */
function parseHeadlessIdleMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HEADLESS_IDLE_MS;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return DEFAULT_HEADLESS_IDLE_MS;
  return n;
}

/**
 * v1.10（parse18 §2.2 裁决）：LASSO_LAUNCH_IDLE_MS 默认 60s（用户需求①「用完即关，
 * 不等 5 分钟」）。四条依据：调用间隔统计（会话内秒级）；重开成本不对称（30s 会频繁
 * 触发 11s 重冷启）；比 5min 短是显式要求；15s 周期 → 关窗最坏延迟 ≤75s。
 * 配 300000 即回退「5min 才关」语义（5min 保留给用户，parse18 §2.4）。
 */
export const DEFAULT_LAUNCH_IDLE_MS = 60_000;

/**
 * 解析 LASSO_LAUNCH_IDLE_MS：parseInt；负数 / NaN / 未设 → 回退默认；
 * 0 → 禁用（index.ts 不启动 chrome-idle-reaper——台账 Chrome 常驻到 chrome-stop）。
 * 不设上限 clamp（用户配 300000 回退 5min 语义 / 1000 逼近瞬时，文档给两极端配法）。
 */
function parseLaunchIdleMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LAUNCH_IDLE_MS;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return DEFAULT_LAUNCH_IDLE_MS;
  return n;
}

/**
 * v1.11（round1 T12）：LASSO_CDP_PORT 解析（NaN/越界守卫）。
 * parseInt 后 NaN / ≤0 / >65535 → 回退默认 9222 + logger.warn config_invalid_value
 * （消灭静默 NaN 下渗 CDP 连接层；与 parseHeadlessIdleMs/parseLaunchIdleMs 同范式——
 * config 数值解析归一单范式，R-CI-02 精神）。
 */
export const DEFAULT_CDP_PORT = 9222;

export function parseCdpPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CDP_PORT;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0 || n > 65_535) {
    logger.warn({
      evt: "config_invalid_value",
      key: "LASSO_CDP_PORT",
      value: raw,
      fallback: DEFAULT_CDP_PORT,
    });
    return DEFAULT_CDP_PORT;
  }
  return n;
}

/** v1.10（parse18 §3.1）：launch 档默认 hidden（保守默认 = 用户要的不打扰）。 */
export const DEFAULT_LAUNCH_MODE: "hidden" | "visible" = "hidden";

/**
 * 解析 LASSO_LAUNCH_MODE：仅接受 "hidden" | "visible"；非法 / 未设 → "hidden"
 * （保守默认；E7 实验唯一启动级零打扰 flag 链）。不设第三档 headless（parse18 §1.2
 * 范围红线：headless 抓取由 browse_headless 通道承担）。
 */
function parseLaunchMode(raw: string | undefined): "hidden" | "visible" {
  if (raw === "visible") return "visible";
  if (raw === "hidden") return "hidden";
  return DEFAULT_LAUNCH_MODE;
}

/**
 * C2（v1.18）：LASSO_AUTO_HIDE_AFTER_LOGIN 解析——仅显式真值开启（1/true/yes/on），
 * 其余一律 false。默认 off 是裁决本体（audit C2：「必须 opt-in + 默认关」）。
 */
function parseAutoHideAfterLogin(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** C2：LASSO_AUTO_HIDE_AFTER_LOGIN_DELAY_MS 解析（负数/NaN/未设 → 默认 10s）。 */
function parseAutoHideDelayMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return AUTO_HIDE_AFTER_LOGIN_DELAY_MS;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return AUTO_HIDE_AFTER_LOGIN_DELAY_MS;
  return n;
}

// ============================================================
// v1.3 Phase A：config 文件机制（~/.lasso/config.json 扁平 JSON）
// ============================================================
/**
 * 默认 config 文件路径：~/.lasso/config.json。
 * 可用 env LASSO_CONFIG_PATH 覆盖（绝对路径，便于测试 + 多实例隔离）。
 *
 * 设计（守简单性 架构想法/01/02）：
 *  - 扁平 JSON，key 名与 env 同名（ZHIPU_API_KEY / BRAVE_API_KEYS / ...）；
 *    用户已在 KEY-GUIDE 认识这些 key 名，扁平 JSON 最低摩擦。
 *  - 不搞嵌套 schema（缠绕）。
 *  - 独立于 ~/.claude.json（避免 CC 全局配置污染；用户易发现 lasso 专属目录）。
 */
export function getConfigFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LASSO_CONFIG_PATH;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".lasso", "config.json");
}

/**
 * 读 config 文件（~/.lasso/config.json）扁平 JSON → Record<string,string>。
 *
 * 行为（守零配置启动 + 不崩）：
 *  - 文件不存在 / 不可读 → 返空对象（不报错；零配置无文件仍可跑）
 *  - JSON 解析错 → 返空对象 + logger.warn（不崩）
 *  - 顶层非对象（null/array/primitive） → 返空对象 + logger.warn
 *  - 值规范化（env 全字符串）：
 *      - string → 原样保留（含 CSV 如 BRAVE_API_KEYS）
 *      - boolean → "true" / "false"
 *      - number → String(n)（如 LASSO_CDP_PORT: 9222 → "9222"）
 *      - 其他类型（null/array/object）跳过
 *  - 下划线前缀字段（_comment 等）跳过（init 模板用 _comment 作 JSON 内文档）
 *
 * 返回的形状与 process.env 一致（全字符串值），可直接参与 env 合并。
 */
export function loadConfigFileEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const filePath = getConfigFilePath(env);
  let body: string;
  try {
    body = readFileSync(filePath, "utf8");
  } catch {
    // 文件不存在 / 不可读 → 零配置（正常情况，不 warn）
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    logger.warn({
      evt: "config_file_parse_error",
      path: filePath,
      error: String(e),
    });
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.warn({
      evt: "config_file_invalid_shape",
      path: filePath,
      detail: "top-level value is not an object",
    });
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // 跳过 _comment 等 metadata 字段（init 模板用）
    if (k.startsWith("_")) continue;
    if (typeof v === "string") {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v ? "true" : "false";
    } else if (typeof v === "number") {
      out[k] = String(v);
    }
    // null / array / object 跳过（不支持嵌套；扁平 JSON 红线）
  }
  return out;
}

/**
 * config init 模板（v1.3 Phase A）：所有已知 key 空值占位 + _comment 说明段。
 *
 * JSON 无注释，故用 _comment 字段作内嵌文档（用户首次打开可见说明）。
 * 用户填需要的 key 即可；未填的 key 留空字符串 → 等价 env 未设（channel 自报 unavailable）。
 */
export const CONFIG_TEMPLATE: Record<string, unknown> = {
  _comment:
    "Lasso config file. Flat JSON: keys match env variable names (see doc/KEY-GUIDE.md). Fill only the keys you need. Booleans use true/false; CSV keys like BRAVE_API_KEYS are comma-separated strings. Env variables override this file (backward compatible).",
  // v1.17 A3：ZHIPU_API_KEY / ZHIPU_ENDPOINT 已退役（tolerated-but-ignored；
  // 静默忽略 + doctor zhipu_keys_retired 提示删除；照 BING_API_KEYS 先例保留键位）
  ZHIPU_API_KEY: "",
  BRAVE_API_KEYS: "",
  BING_API_KEYS: "",
  LASSO_ALLOW_CLOUD_BROWSER: false,
  BROWSERBASE_API_KEY: "",
  STAGEHAND_API_KEY: "",
  LASSO_COOKIE_PASSPHRASE: "",
  ZHIPU_ENDPOINT: "",
  LASSO_CDP_PORT: 9222,
  LASSO_CACHE_DIR: "",
  LASSO_SEARCH_FREE_ONLY: "L4",
  LASSO_VLM_ENDPOINT: "",
  LASSO_RECORD_SEARCH: false,
  LASSO_CALLER_CAP_DEFAULT: 100,
  LASSO_PROVIDERS_FILE: "",
  LASSO_HEADLESS_IDLE_MS: 300000,
  // v1.10（parse18 §2.4 + §3）：台账 Chrome 用完即关 + 隐藏启动档
  LASSO_LAUNCH_MODE: "hidden",
  LASSO_LAUNCH_IDLE_MS: 60000,
  // C2（v1.18，doc/28 D-2）：登录完成自动转后台静默（opt-in；默认 false）
  LASSO_AUTO_HIDE_AFTER_LOGIN: false,
  LASSO_AUTO_HIDE_AFTER_LOGIN_DELAY_MS: 10000,
  // v1.11（round1 T10）：浏览器出口代理（browse_headless + Steel 生效；
  // browse_logged_in 永不读取——用户真实 Chrome 出口原样）
  LASSO_PROXY: "",
};

/**
 * 写 config init 模板到 getConfigFilePath(env)。
 *
 * 行为：
 *  - 文件已存在 → 不覆盖（created=false；打印提示让用户手改）
 *  - 文件不存在 → mkdir -p ~/.lasso + 写模板（created=true）
 *  - mkdir/writeFile 失败 → 抛错（CLI 顶层 catch 转 exit 1）
 *
 * 返回 { path, created } 让 CLI 打印友好消息。
 */
export async function writeConfigTemplate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; created: boolean }> {
  const { promises: fsP } = await import("node:fs");
  const filePath = getConfigFilePath(env);
  // 已存在则不覆盖（保用户手改内容）
  try {
    await fsP.access(filePath);
    return { path: filePath, created: false };
  } catch {
    // 不存在，继续创建
  }
  await fsP.mkdir(path.dirname(filePath), { recursive: true });
  await fsP.writeFile(
    filePath,
    JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n",
    "utf8",
  );
  return { path: filePath, created: true };
}

/**
 * file→env 合并单一真源（ft-round1 FT-DEF-1 修复）：config 文件（base）→ env（覆盖）。
 *
 * 消费方：loadConfig（运行时装配）+ doctor 两模式调用点（index.ts runDoctorCli /
 * doctorOpts——此前 doctor 直读 process.env 致 file 配置的 BRAVE/BING/ZHIPU/PROXY
 * 键对 doctor 不可见，而运行时 BraveChannel 却按合并后 env 装配——医生与运行时
 * 各说各话）。守 R-CI-02：合并不在第二处重写，全部经本函数。
 */
export function mergedEnv(
  envSource: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...loadConfigFileEnv(envSource), ...envSource };
}

/**
 * 读 env、合并 BUILTIN_PROVIDERS、注入 env-derived keys。
 * 不抛错——缺 key 时 channel 自报 unavailable（doctor 也会标 fail）。
 *
 * v1.3 Phase A 合并顺序：config 文件（base）→ env（覆盖）。
 *   - env 优先（向后兼容：既有 -e KEY=VAL 装时 env 用户不破；shell env 也仍生效）
 *   - config 文件兜底默认（user-friendly：安装零配置 + 改文件即配 key）
 *   - opts.env（测试注入）替换 process.env（保持 v1.2 测试契约：opts.env 提供时 process.env 不参与）
 */
export function loadConfig(opts: LoadConfigOptions): LassoConfig {
  const envSource = opts.env ?? process.env;
  const env = mergedEnv(envSource);

  const providers = new Map<string, ProviderConfig>();
  for (const p of BUILTIN_PROVIDERS) providers.set(p.name, { ...p });

  // v1.17 A3（zhipu 直连删除）：ZHIPU_API_KEY / ZHIPU_ENDPOINT 键容忍但**不消费**——
  // 不注册 zhipu provider、不注入任何 provider keys（照 v1.15 BING_API_KEYS 先例；
  // doctor zhipu_keys_retired 提示退役；INV-80 墓碑守卫禁 providers.set("zhipu")）。

  // v0.2 新增：Brave 多 Key CSV（parse2 §3.1.4 / §4.2）
  // BRAVE_API_KEYS="key1,key2,key3" 优先；兼容单值 BRAVE_API_KEY。
  const braveKeysCsv = env.BRAVE_API_KEYS ?? env.BRAVE_API_KEY ?? "";
  const braveKeys = braveKeysCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (braveKeys.length > 0) {
    const brave = providers.get("brave");
    if (brave) brave.keys = braveKeys;
  }

  // v1.15 Phase A（Bing 死层清除）：BING_API_KEYS / BING_API_KEY 键容忍但**不注册**
  // bing provider（Bing Search APIs 2025-08-11 全量退役；静默忽略存量配置，
  // doctor #11c bing_keys_retired 提示删除；INV-54 墓碑守卫禁 providers.set("bing")）。

  // v1.11（round1 T12）：NaN/越界守卫统一数值解析范式（与 parseHeadlessIdleMs 同款；
  //   修复 L340 裸 parseInt：用户配 "abc" → NaN 静默下渗 CDP 连接层，报错更晚更怪）
  const cdpPort = parseCdpPort(env.LASSO_CDP_PORT);

  // v1.11（round1 T10）：LASSO_PROXY 出口代理（trim；空/未设 = 不代理）
  const proxy = (env.LASSO_PROXY ?? "").trim();

  const cacheDir = env.LASSO_CACHE_DIR ?? defaultCacheDir();

  // v0.2 新增：ProviderRegistry 装配（parse2 §3.1.3）
  // 用 [...providers.values()] 而非 BUILTIN_PROVIDERS，确保上面 env 注入的 keys 生效。
  const registry = new ProviderRegistry([...providers.values()]);

  // v0.2 新增：free_only 全局默认（L4=全部允许，L2=禁付费）
  const rawFreeOnly = (env.LASSO_SEARCH_FREE_ONLY ?? "L4") as FreeTierLevel;
  const searchFreeOnly: FreeTierLevel = ["L1", "L2", "L3", "L4"].includes(
    rawFreeOnly,
  )
    ? rawFreeOnly
    : "L4";

  // v1.9（parse17 机制一）：headless idle 回收阈值（0 = 禁用）
  const headlessIdleMs = parseHeadlessIdleMs(env.LASSO_HEADLESS_IDLE_MS);
  // v1.10（parse18 机制一/二）：台账 Chrome 用完即关阈值 + 启动档（0 = 禁用 reaper）
  const launchIdleMs = parseLaunchIdleMs(env.LASSO_LAUNCH_IDLE_MS);
  const launchMode = parseLaunchMode(env.LASSO_LAUNCH_MODE);
  // C2（v1.18，doc/28 D-2）：登录完成自动转后台（opt-in 默认 off）+ 延迟窗
  const autoHideAfterLogin = parseAutoHideAfterLogin(env.LASSO_AUTO_HIDE_AFTER_LOGIN);
  const autoHideAfterLoginDelayMs = parseAutoHideDelayMs(
    env.LASSO_AUTO_HIDE_AFTER_LOGIN_DELAY_MS,
  );

  return {
    runId: opts.runId,
    providers,
    registry,
    cdpPort,
    proxy,
    cacheDir,
    searchCacheDir: path.join(cacheDir, "search-cache"),
    searchFreeOnly,
    headlessIdleMs,
    launchIdleMs,
    launchMode,
    autoHideAfterLogin,
    autoHideAfterLoginDelayMs,
  };
}
