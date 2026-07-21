/**
 * interact tools 注册（parse5 §3.1.5 —— forest 调度层 3 个对外工具）
 *
 * 三个工具构成 forest 调度层的对外 API（parse5 §3.1 + §3.1.5）：
 *  - interact_roots()   : 聚合 BrowseChannel.listRoots() + DesktopChannel.listRoots()
 *                         → RootRegistry 注册 → 返 RootRef 列表（@pN + @wN 混排）
 *  - interact_observe() : 按 rootRef 前缀 dispatch → 对应 channel 的 observe 路径
 *  - interact_act()     : 按 rootRef 前缀 dispatch → 对应 channel 的 act 路径
 *
 * 设计原则：
 *  - 统一入口（interact_roots）替代让 model 记忆「browse_headless / browse_logged_in /
 *    desktop」三个独立 channel；model 拿 rootRef 即可路由
 *  - 不替代单 channel 工具（13 §3.1 + descriptions 路由提示）：
 *      · 已知 URL 想 snapshot → 直接 browse_headless 更快（省一次 interact_roots roundtrip）
 *      · 已知 app 名 → 直接 desktop(action:snapshot) 更快
 *      · 跨多 root 不确定用哪个 → interact_roots 列出 → interact_observe/act 走
 *
 * 不变量：
 *  - INV-5：annotations 携带（interactAnnotations = 与 desktop 同档，可副作用）
 *  - INV-26：本文件只 import InteractDispatcher + RootRegistry（forest 调度层），
 *             不直接 import BrowseChannel/DesktopChannel 的 internal 模块
 *  - INV-29：本文件无平台字面量
 *
 * 借鉴：parse5 §3.1.5；12 §1.2(F) injaneity dispatchUiAction 双 dispatch path；
 *       mcp-chrome action-enum 折叠思想（descriptions 里写明 rootRef 路由）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InteractDispatcher } from "../forest/InteractDispatcher.js";
import type { RootRegistry } from "../forest/RootRegistry.js";
import type { BrowseChannel } from "../channels/BrowseChannel.js";
import type { DesktopChannel } from "../channels/DesktopChannel.js";
import type { RootInfo } from "../forest/forest-types.js";
import { logger } from "../util/logger.js";
import {
  INTERACT_ROOTS_DESCRIPTION,
  INTERACT_OBSERVE_DESCRIPTION,
  INTERACT_ACT_DESCRIPTION,
} from "./descriptions.js";
import { interactAnnotations } from "./annotations.js";

// ============================================================
// Schema（parse5 §3.1.5）
// ============================================================
const interactRootsSchema = {
  kind: z.enum(["browser_page", "window"]).optional(),
};

const interactObserveSchema = {
  root_ref: z
    .string()
    .regex(
      /^@[pw]\d+$/,
      "root_ref must be @pN (browse page) or @wN (desktop window)",
    ),
  action: z.enum(["snapshot", "find"]),
  options: z.record(z.unknown()).default({}),
};

const interactActSchema = {
  root_ref: z
    .string()
    .regex(
      /^@[pw]\d+$/,
      "root_ref must be @pN (browse page) or @wN (desktop window)",
    ),
  action: z
    .enum(["navigate", "snapshot", "screenshot", "extract", "click", "fill", "wait", "evaluate", "act"])
    .default("act"),
  options: z.record(z.unknown()).default({}),
};

// ============================================================
// helpers
// ============================================================
/**
 * identity 哈希（djb2 32-bit → hex；不引 node:crypto 重负载）。
 * forest 用作 identity→ref 复用 map 的 key；不要求密码学强度。
 */
function identityHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 聚合 browse + desktop 两 channel 的 listRoots → 注册到 RootRegistry。
 *
 * 调用时机：interact_roots tool handler（每次调用都刷新；identity 复用保证
 * 同 url/window 不重分配 ref）。
 *
 * INV-26：本函数只调 channel.listRoots()（公共方法），不调任何 internal。
 */
async function refreshRoots(
  registry: RootRegistry,
  browseChannels: Array<{ source: string; channel: BrowseChannel }>,
  desktopChannel: { source: string; channel: DesktopChannel } | undefined,
): Promise<void> {
  // 1. browse pages
  for (const { source, channel } of browseChannels) {
    try {
      const pages = await channel.listRoots();
      for (const p of pages) {
        await registry.getOrCreate(
          {
            kind: "browser_page",
            identity: identityHash(`${p.contextId}|${p.url}`),
          },
          (_kind, newRef) => ({
            rootRef: newRef,
            kind: "browser_page",
            title: p.title || p.url,
            subtitle: p.url,
            source,
          }),
        );
      }
    } catch (e) {
      // 单 channel 列 roots 失败不阻断其他 channel
      logger.warn({
        evt: "interact_roots_browse_failed",
        source,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // 2. desktop windows
  if (desktopChannel) {
    try {
      const windows = await desktopChannel.channel.listRoots();
      for (const w of windows) {
        await registry.getOrCreate(
          {
            kind: "window",
            identity: identityHash(`${w.bundleId}|${w.pid}|${w.windowId}`),
          },
          (_kind, newRef) => ({
            rootRef: newRef,
            kind: "window",
            title: `${w.app}: ${w.title || "(no title)"}`,
            subtitle: undefined,
            source: desktopChannel.source,
          }),
        );
      }
    } catch (e) {
      logger.warn({
        evt: "interact_roots_desktop_failed",
        source: desktopChannel.source,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

function envelopeToContent(envelope: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
    ],
  };
}

// ============================================================
// registerInteractTools
// ============================================================
/**
 * @param server       MCP server
 * @param registry     forest RootRegistry（INV-24 单一真源）
 * @param dispatcher   InteractDispatcher（已注入 channels Map）
 * @param browseChannels  参与森林的 browse channel 列表（HeadlessChannel + LoggedInChannel）
 * @param desktopChannel  参与森林的 desktop channel（可选；未注入 = forest 仅 browse）
 *
 * INV-26：本函数签名只接 channel 类引用（不接 internal 模块）。
 */
export function registerInteractTools(
  server: McpServer,
  registry: RootRegistry,
  dispatcher: InteractDispatcher,
  browseChannels: Array<{ source: string; channel: BrowseChannel }>,
  desktopChannel?: { source: string; channel: DesktopChannel },
): void {
  // ============================================================
  // interact_roots
  // ============================================================
  server.tool(
    "interact_roots",
    INTERACT_ROOTS_DESCRIPTION,
    interactRootsSchema,
    interactAnnotations,
    async (args) => {
      // 1. 刷新（聚合两 channel listRoots → registry 注册；identity 复用）
      await refreshRoots(registry, browseChannels, desktopChannel);
      // 2. 按过滤返列表
      const filter = args.kind ? { kind: args.kind } : undefined;
      const roots: RootInfo[] = registry.list(filter);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { roots, count: roots.length },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ============================================================
  // interact_observe
  // ============================================================
  server.tool(
    "interact_observe",
    INTERACT_OBSERVE_DESCRIPTION,
    interactObserveSchema,
    interactAnnotations,
    async (args) => {
      const envelope = await dispatcher.dispatch({
        rootRef: args.root_ref,
        action: args.action,
        options: args.options,
      });
      return envelopeToContent(envelope);
    },
  );

  // ============================================================
  // interact_act
  // ============================================================
  server.tool(
    "interact_act",
    INTERACT_ACT_DESCRIPTION,
    interactActSchema,
    interactAnnotations,
    async (args) => {
      const envelope = await dispatcher.dispatch({
        rootRef: args.root_ref,
        action: args.action,
        options: args.options,
      });
      return envelopeToContent(envelope);
    },
  );
}
