/**
 * hot-reload —— 运行时热更新（parse7 §3.6 / F3.6.6）
 *
 * 两条触发路径：
 *  (a) SIGHUP 信号 —— 运维脚本 `kill -HUP $(pgrep lasso-mcp)` 触发重读 LASSO_PROVIDERS_FILE
 *  (b) admin tool 主动调用 —— applyHotReload 函数本身对外可调（admin provider_add 复用其 diff 逻辑）
 *
 * 铁律（INV-40 task v0.6）：
 *  - 新 provider 必经 registry.add（不直接写 BUILTIN_PROVIDERS；BUILTIN_PROVIDERS 是 v0.5
 *    静态件，运行时不可变）；移除 provider 必经 registry.remove。
 *
 * 铁律（INV-35 task v0.6）：
 *  - 本模块不 import BrowseChannel/DesktopChannel internal；只持 registry + bag 句柄。
 *
 * 设计选择（parse7 §3.6）：
 *  - 不用 chokidar / fs.watch（不稳定 + 跨平台问题）—— 只支持 SIGHUP + admin 主动触发
 *  - 不自动持久化：热插拔状态进程内，重启清零（与 v0.5 QuotaLedger 一致）
 *  - 默认 LASSO_PROVIDERS_FILE 未设 → 完全跳过 SIGHUP 安装（零回归）
 *
 * 借鉴源（parse7 §3.6）：
 *  - kfirtoledo/multi-mcp hot-plug 思路
 *  - SIGHUP 范式 ≈ nginx / syslog-ng 等运维工具标准做法
 */
import { readFileSync } from "node:fs";
import { logger } from "../util/logger.js";
import type { ProviderRegistry } from "../config/provider-registry.js";
import type { ProviderConfig } from "../types.js";
import type { CapabilityBag } from "./CapabilityBag.js";
import type { ToolManager } from "./ToolManager.js";
import type { HotReloadConfig } from "./runtime-types.js";

/**
 * 安装 SIGHUP 信号驱动的热更新。
 *
 * @param registry       ProviderRegistry 句柄（add/remove 入口）
 * @param bag            CapabilityBag 句柄（register/disable 入口）
 * @param toolManager    ToolManager 句柄（v0.6 Phase A 暂保留，未来 provider_add
 *                       admin action 注册新 tool 时使用）
 * @param configPath     LASSO_PROVIDERS_FILE 路径；null 则不安装 SIGHUP
 *
 * INV-40：SIGHUP 触发后必经 registry.add（不直接 mutate BUILTIN_PROVIDERS）。
 *
 * 安装幂等：多次调用 installSighupHotReload 会多次 process.on('SIGHUP')（Node
 * EventEmitter 允许同事件多 listener），调用方应只装一次。
 */
export function installSighupHotReload(
  registry: ProviderRegistry,
  bag: CapabilityBag,
  toolManager: ToolManager,
  configPath: string | null,
): void {
  if (!configPath) {
    logger.info({ evt: "hot_reload_skipped", reason: "no_providers_file" });
    return;
  }
  process.on("SIGHUP", async () => {
    logger.info({
      evt: "hot_reload_triggered",
      src: "SIGHUP",
      path: configPath,
    });
    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as HotReloadConfig;
      await applyHotReload(parsed.providers, registry, bag, toolManager);
    } catch (e) {
      // parse 错 / 文件不存在 → log error 不崩（R-RT-6 parse7 §7.1）
      logger.error({
        evt: "hot_reload_error",
        src: "SIGHUP",
        path: configPath,
        error: String(e),
      });
    }
  });
  logger.info({
    evt: "hot_reload_installed",
    path: configPath,
  });
}

/**
 * 应用 provider 配置 diff：移除 existing - incoming，新增 incoming - existing。
 *
 * 这是 admin provider_add / provider_remove 单条操作的批量版本（parse7 §3.6）。
 * admin 工具的 provider_add 实际就是 applyHotReload([newConfig], ...) 的单条特例。
 *
 * INV-40：新增 provider 必经 registry.add + bag.register（不直接 mutate BUILTIN_PROVIDERS）。
 * INV-36：bag.register 是新 name 进入 bag 的唯一入口（bag 本身不凭空造）。
 *
 * toolManager 参数为 Phase A 预留：v0.6 后续阶段若需为新 provider 注册新 channel tool，
 * 由 index.ts 装配的 bag.onChange handler 联动（不在本模块直接调）。
 *
 * @param newConfigs  解析后的 ProviderConfig 数组（whole file 内容）
 * @returns diff 报告（admin 调用方可用于 audit log / 显示）
 */
export async function applyHotReload(
  newConfigs: ProviderConfig[],
  registry: ProviderRegistry,
  bag: CapabilityBag,
  _toolManager: ToolManager,
): Promise<HotReloadReport> {
  // 只处理 enabled !== false 的（与 ProviderRegistry constructor 同语义）
  const incoming = newConfigs.filter((c) => c.enabled !== false);
  const existing = new Set(registry.listNames());
  const incomingNames = new Set(incoming.map((c) => c.name));

  const added: string[] = [];
  const removed: string[] = [];

  // 1. 移除：existing - incoming（registry 里有但新配置没有）
  for (const name of existing) {
    if (!incomingNames.has(name)) {
      // INV-40：经 registry.remove（不直接 mutate BUILTIN_PROVIDERS）
      const wasRemoved = registry.remove(name);
      if (wasRemoved) {
        // bag 联动：disable 触发 index.ts onChange handler 调 toolManager.disableChannel
        // 不直接 unregister —— 保留状态机留 audit 痕迹
        await bag.disable(name, {
          callerId: "hot_reload",
          reason: "removed_from_providers_file",
        });
        removed.push(name);
        logger.info({ evt: "hot_unplug_provider", name });
      }
    }
  }

  // 2. 新增：incoming - existing
  for (const c of incoming) {
    if (!existing.has(c.name)) {
      // INV-40：经 registry.add（不直接 mutate BUILTIN_PROVIDERS）
      try {
        registry.add(c);
        // INV-36：bag.register 是 bag 新 entry 的唯一入口
        bag.register(c.name);
        added.push(c.name);
        logger.info({ evt: "hot_plug_provider", name: c.name });
      } catch (e) {
        // registry.add 抛错（如 name 已存在但 listNames 没追上）→ log warn 不中断
        logger.warn({
          evt: "hot_plug_provider_error",
          name: c.name,
          error: String(e),
        });
      }
    }
  }

  logger.info({
    evt: "hot_reload_applied",
    added: added.length,
    removed: removed.length,
  });

  return { added, removed };
}

/**
 * 单 provider 热插拔（admin provider_add action 的实现入口，parse7 §3.5）。
 *
 * 这是 applyHotReload 的单条特例：仅 add 一个 provider。
 *
 * INV-40：必经 registry.add（不直接 mutate BUILTIN_PROVIDERS）。
 *
 * @throws Error 若 provider name 已存在（registry.add 抛出）
 */
export async function addProvider(
  config: ProviderConfig,
  registry: ProviderRegistry,
  bag: CapabilityBag,
  _toolManager: ToolManager,
): Promise<void> {
  // INV-40 衍生：调用方传 config 但 enabled=false → no-op（与 ProviderRegistry constructor 同语义）
  if (config.enabled === false) {
    logger.info({
      evt: "hot_plug_skipped",
      name: config.name,
      reason: "enabled_false",
    });
    return;
  }
  // INV-40：经 registry.add（registry.add 内部校验重名 + 创建 QuotaLedger）
  registry.add(config);
  // INV-36：bag.register 是 bag 新 entry 的唯一入口
  bag.register(config.name);
  logger.info({
    evt: "hot_plug_provider",
    name: config.name,
    src: "admin",
  });
}

/**
 * 单 provider 热卸载（admin provider_remove action 的实现入口，parse7 §3.5）。
 *
 * @returns true=已移除；false=provider name 不存在
 */
export async function removeProvider(
  name: string,
  registry: ProviderRegistry,
  bag: CapabilityBag,
  _toolManager: ToolManager,
  opts?: { callerId?: string; reason?: string },
): Promise<boolean> {
  // INV-40：经 registry.remove
  const wasRemoved = registry.remove(name);
  if (!wasRemoved) return false;
  await bag.disable(name, {
    callerId: opts?.callerId ?? "admin",
    reason: opts?.reason ?? "provider_removed",
  });
  logger.info({
    evt: "hot_unplug_provider",
    name,
    src: "admin",
  });
  return true;
}

/**
 * 热更新 diff 报告（applyHotReload 返回值；admin tool 显示用）。
 */
export interface HotReloadReport {
  added: string[];
  removed: string[];
}
