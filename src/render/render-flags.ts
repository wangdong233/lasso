/**
 * render-flags.ts（v1.19 渲染档设计决议 裁决二 —— 确定性旗标冻结快照单一真源）
 *
 * 路线 (b) 冻结快照手拼 CLI，零新 npm dep（INV-64 修订 (a)：render/*.ts 只 import
 * node:* 内置 + 相对路径；渲染档旗标面是**冻结快照非运行时依赖**）。
 *
 * ## provenance（来源，可审计）
 *  - 消费方真源：media-gen-mcp `src/browser-pool.ts` DETERMINISTIC_FLAGS @ da7ffd3
 *    （8 条逐字同序；本仓实施轮已实读核验）
 *  - puppeteer 注入面冻结项：§一.4 导出脚本（/tmp 一次性临时脚本，勿入库）在
 *    media-gen-mcp node_modules（puppeteer-core 25.3.0，channel:"chrome"，
 *    headless:true）上真机导出的 spawnargs 全集，减去 per-instance 项
 *    （`--remote-debugging-*` / `--user-data-dir` / 起始 URL）后的稳定集。
 *    导出日期：2026-09-02（darwin 真机）。
 *  - 实测勘误（对设计 §2.3 的精确化）：`--disable-dev-shm-usage` 在 25.3.0 的
 *    ChromeLauncher.js:168 **无平台守卫**（darwin 上同样注入）——冻结集无需按
 *    平台分支，快照更简单。
 *  - 验收轮勘误（2026-09-02，对抗复审轮实锤复检）：初版快照漏录
 *    `--disable-ipc-flooding-protection`（ChromeLauncher.js:171 **无条件默认项**，
 *    初版导出转录遗漏）。补录依据 = 对 §一.4 导出脚本（media-gen-mcp node_modules
 *    puppeteer-core 25.3.0，/tmp 一次性脚本）的静态源核对 + 真机 spawn 后
 *    `ps -o command=` 全量 diff 双确认。仓内机械化钉子 = 本 fixture tripwire
 *    （逐字同序）——仓内**无**自动重导出对照（消费方仓依赖不进本仓 CI）；
 *    升级 puppeteer major 时必须人工重跑 §一.4 导出并更新本文件 + fixture。
 *  - 漂移终裁 = 消费方 golden（MEDIA_GEN_RENDER_MODE=attach npm test，含
 *    render-video-determinism byte-identical）；lasso 侧 CI 不跑消费方 golden，
 *    交付与升级时触发（对接说明 §一.3）。有意变更流程 = 重导出 + 更新
 *    test/fixtures/render-flags-snapshot.txt + 消费方 golden 验证。
 *
 * ## 确定性边界诚实声明（设计 §2.4）
 * 传输层差异（消费方 legacy 自管走 puppeteer 管道 vs 渲染档 TCP 9224 多消费方
 * attach）不影响渲染产物——像素与页面时钟不经过传输层；`/json/version` 是
 * wsEndpoint 权威来源。
 *
 * INV-64 修订合规：本文件只 import node:* 内置。
 */
import process from "node:process";

// ============================================================
// 冻结旗标快照（顺序敏感——与消费方导出全集逐字同序；tripwire 见
// test/unit/render-flags.spec.ts vs test/fixtures/render-flags-snapshot.txt）
// ============================================================
/**
 * 渲染档确定性命令行全集（puppeteer 默认面 + 消费方 8 条确定性旗标的合并冻结）。
 * 顺序 = §一.4 导出脚本输出顺序（puppeteer 默认 flag 段在前、custom args 段在后），
 * 减去 per-instance 项（user-data-dir / remote-debugging-port / about:blank——
 * 由 render-launcher 按实例拼接）。
 */
export const RENDER_DETERMINISTIC_FLAGS: readonly string[] = [
  // ---- puppeteer-core 25.3.0 默认注入面（headless: true 时）----
  "--allow-pre-commit-input",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-crash-reporter",
  "--disable-default-apps",
  "--disable-dev-shm-usage", // 25.3.0 无平台守卫（darwin 实测注入；provenance 见文件头）
  "--disable-hang-monitor",
  "--disable-infobars",
  "--disable-ipc-flooding-protection", // 2026-09-02 验收轮重导出补漏：ChromeLauncher.js:171 无条件默认项，初版快照漏录（见文件头 provenance 验收勘误）
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-search-engine-choice-screen",
  "--disable-sync",
  "--enable-automation",
  "--export-tagged-pdf",
  "--force-color-profile=srgb",
  "--generate-pdf-document-outline",
  "--metrics-recording-only",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,WebUIReloadButton,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes",
  "--enable-features=PdfOopif",
  "--headless=new",
  "--hide-scrollbars",
  "--mute-audio",
  "--disable-extensions",
  // ---- 消费方 DETERMINISTIC_FLAGS（browser-pool.ts @ da7ffd3，逐字同序）----
  "--no-sandbox",
  "--disable-gpu", // Mac 上确定性关键（消费方注释）
  "--font-render-hinting=full",
  "--force-color-profile=srgb", // 与 puppeteer 默认面重合（Chrome 幂等；保持导出全集原样）
  "--run-all-compositor-stages-before-draw",
  "--disable-background-timer-throttling", // 同上重合
  "--disable-backgrounding-occluded-windows", // 同上重合
  "--disable-renderer-backgrounding", // 同上重合
];

// ============================================================
// 端口 / profile 前缀常量（R-INT-08 外部命名空间带查证记录）
// ============================================================
/**
 * 渲染档 CDP 端口默认（设计决议 3.2）。选值查证：9222 = lasso launch-chrome 默认档；
 * 9223 = media-gen Flow provider CDP 惯例；**9224 = 空闲**。
 * env `LASSO_RENDER_PORT` 覆盖（测试隔离 + 并行验收隔离用，配方见 doc/渲染档-并行验收隔离配方.md；单值覆盖不构成端口协商——冲突仍
 * exit 3，协商留 R7）。
 */
export const RENDER_CDP_PORT_DEFAULT = 9224;

/** 渲染档 CDP 端口（env LASSO_RENDER_PORT 覆盖；非法/越界值降级默认并保持诚实）。 */
export function renderCdpPort(): number {
  const raw = process.env.LASSO_RENDER_PORT;
  if (raw === undefined || raw.trim() === "") return RENDER_CDP_PORT_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return RENDER_CDP_PORT_DEFAULT;
  return n;
}

/**
 * 渲染档临时 profile 目录名前缀（设计决议 3.4）。R-INT-08 查证：`~/.cache/lasso/`
 * 内无同名占用带。rmSync 归属守卫（chrome-stop.ts cleanupRenderProfile 的
 * RENDER_PROFILE_BASENAME_PREFIX）镜像本常量——render-flags.spec tripwire 断言一致。
 */
export const RENDER_PROFILE_PREFIX = "render-chrome-profile-";

// ============================================================
// 渲染档 idle 默认（设计决议 3.10 / 3.11 —— 三套 idle 勿互抄）
// ============================================================
/**
 * 渲染档 idle 回收默认 10min。与日常档 CLI 默认（--idle-ms 0 不回收）刻意不同：
 * 渲染档是无人值守的确定性资源，**默认必须能自动退场**（media-gen P0 的根治点）。
 * owner 对照：日常档 `LASSO_LAUNCH_IDLE_MS` / 渲染档 `LASSO_RENDER_IDLE_MS` /
 * 消费方 legacy 自管池 `MEDIA_GEN_BROWSER_IDLE_MS`（attach 下不生效）——勿互抄。
 */
export const RENDER_IDLE_DEFAULT_MS = 600_000;

/**
 * 渲染档 idle 默认（env `LASSO_RENDER_IDLE_MS` 覆盖）。
 * ≤0 = 显式 opt-out（该档不自动回收；文档化语义，**不 clamp 到默认**——与
 * 日常档 idleMs≤0=禁用回收的既有语义对齐）。非法/非数值降级默认。
 */
export function renderIdleDefaultMs(): number {
  const raw = process.env.LASSO_RENDER_IDLE_MS;
  if (raw === undefined || raw.trim() === "") return RENDER_IDLE_DEFAULT_MS;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n)) return RENDER_IDLE_DEFAULT_MS;
  return n;
}

// ============================================================
// 指纹判定（设计决议 3.9 孤儿检测）
// ============================================================
/** 孤儿/渲染档进程指纹对（成对命中才认定；单旗标可能撞他家用法）。 */
export const RENDER_FINGERPRINT_FLAG_A = "--run-all-compositor-stages-before-draw";
export const RENDER_FINGERPRINT_FLAG_B = "--font-render-hinting=full";

/**
 * 命令行是否含渲染档指纹对（两旗标同时命中）。
 * doctor 孤儿检测的粗筛（成对 + profile 前缀 + 台账缺位三重证据的第一重）；
 * 需求 §五.0 的 `pgrep -f run-all-compositor-stages-before-draw` 精确定位同源。
 */
export function renderFingerprintMatch(cmdline: string): boolean {
  return cmdline.includes(RENDER_FINGERPRINT_FLAG_A) && cmdline.includes(RENDER_FINGERPRINT_FLAG_B);
}
