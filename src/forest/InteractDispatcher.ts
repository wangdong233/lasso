/**
 * InteractDispatcher（parse5 §3.1.3）—— forest 调度层核心。
 *
 * 铁律（parse5 §3.1.3，13 §2.4 R-CI-02 衍生，INV-26 守护）：
 *  - 本类只 `import type` BrowseChannel / DesktopChannel 的 **class**，**不 import
 *    它们的 internal 模块**（INV-26 grep 断言：禁 `../browse/StepEngine.js` /
 *    `../desktop/AxProvider.js` / `../browse/ExpectPoll.js` 等）。
 *  - 调度按 rootRef 前缀（@p / @w）路由，**不**按 channel type switch。
 *    （前缀路由保证：未来加 browse_cloud_browserbase 也用 @pN，无需改 dispatcher）
 *  - BrowseChannel / DesktopChannel 互相不感知（forest 是它们之上的薄包装）。
 *
 * 关键设计选择：
 *  - channel 引用经 `Map<string, ...>` 注入（key = channel.name），dispatcher 不
 *    直接耦合 channel 子类（仅 instanceof BrowseChannel 做 action 转译分支）。
 *  - instanceof BrowseChannel 是「接口契约」判定，不算 internal 模块依赖（INV-26
 *    允许；只禁 `../browse/*.js` 等内部路径）。
 *
 * 借鉴（parse5 §3.1.6）：
 *  - 13 §3.3 v0.4+ interact_roots 落地图
 *  - 12 §1.2(F) injaneity dispatchUiAction（双 dispatch path，单 UiAction union）
 *  - 13 §3.1 browse/desktop action 词汇内联差异率 ~86%
 *
 * INV-21 衍生（INV-29）：本文件无平台字面量（AXUIElement / CGEvent / MCP frameId）。
 */
import type { BrowseChannel } from "../channels/BrowseChannel.js";
import type { DesktopChannel } from "../channels/DesktopChannel.js";
import type {
  InteractEnvelope,
  InteractTask,
} from "./forest-types.js";
import type { RootRegistry } from "./RootRegistry.js";

/**
 * dispatcher 持有的 channel 引用类型。
 *
 * 用联合类型而不是抽象基类，是为了：
 *  - 保持 R-CI-02（兄弟不是父子；browse/desktop 是平级 UiChannel 子类）
 *  - 不强制 channel 实装共同接口（v0.4 仅 BrowseChannel + DesktopChannel；
 *    v0.4c 加 BrowserbaseChannel extends BrowseChannel 时天然兼容）
 */
export type ForestChannel = BrowseChannel | DesktopChannel;

// ============================================================
// InteractDispatcher
// ============================================================
export class InteractDispatcher {
  constructor(
    private readonly registry: RootRegistry,
    /**
     * 按 channel.name 索引的 channel 实例表。
     * key 与 RootInfo.source 一致（HeadlessChannel.name = "browse_headless" 等）。
     */
    private readonly channels: Map<string, ForestChannel>,
  ) {}

  /**
   * 调度一个 InteractTask 到对应的 channel。
   *
   * 步骤：
   *  1. 校验 rootRef 存在（registry.lookup） → 否则 stale_root_ref
   *  2. 找 RootInfo.source 对应 channel → 否则 channel_unavailable
   *  3. 按 channel 类型转译 action（browse/desktop action 词汇 ~86% 同构）
   *  4. 调 channel.browse(url, action, opts) 或 channel.observe/act/wait
   *
   * 不变量：
   *  - 永不抛异常（错误走 InteractEnvelope 信封；与 channel 同形交付）
   *  - browse/desktop fallback 链不跨 surface（INV-23 仍守；
   *    dispatcher 不触发 fallback，由各 channel 自己的 decider 处理）
   *
   * @returns InteractEnvelope（与各 channel InteractResult 同形）
   */
  async dispatch(task: InteractTask): Promise<InteractEnvelope> {
    // 1. rootRef 存在性
    const info = this.registry.lookup(task.rootRef);
    if (!info) {
      return {
        outcome: "didnt",
        data: null,
        served_by: "interact_dispatcher",
        fallback_used: false,
        retrieval_method: "stale_root_ref",
        error: `unknown_root:${task.rootRef}`,
      };
    }

    // 2. channel 反查
    const channel = this.channels.get(info.source);
    if (!channel) {
      return {
        outcome: "didnt",
        data: null,
        served_by: "interact_dispatcher",
        fallback_used: false,
        retrieval_method: "channel_unavailable",
        error: `source_not_registered:${info.source}`,
      };
    }

    // 3. 前缀路由（INV-26 核心）：@pN → BrowseChannel，@wN → DesktopChannel
    //    前缀路由 vs channel instanceof：优先用前缀（更松耦合；instanceof 仅做转译分支）
    if (task.rootRef.startsWith("@p")) {
      return this.dispatchToBrowse(channel as BrowseChannel, task, info.subtitle);
    }
    if (task.rootRef.startsWith("@w")) {
      return this.dispatchToDesktop(channel as DesktopChannel, task);
    }

    // 4. 未知前缀（理论上 registry 已挡，但兜底防御）
    return {
      outcome: "didnt",
      data: null,
      served_by: "interact_dispatcher",
      fallback_used: false,
      retrieval_method: "unknown_prefix",
      error: `rootRef_prefix_not_recognized:${task.rootRef}`,
    };
  }

  // ============================================================
  // browse 路径（@pN）
  // ============================================================
  /**
   * dispatch 到 BrowseChannel.browse(url, action, options)。
   *
   * browse action 词汇（BrowseChannel.actionDispatch Map）：
   *  navigate / snapshot / screenshot / extract / click / fill / wait / evaluate
   *
   * interact_observe(rootRef, "snapshot") 与 interact_act(rootRef, "click")
   * 都走本路径（browse 不区分 observe/act 入口；action 字符串已携带）。
   *
   * INV-26 守护：本方法仅调 `channel.browse(...)` 公共方法，不调任何 internal。
   *
   * @param channel  BrowseChannel 实例
   * @param task     任务
   * @param url      RootInfo.subtitle（browse root 的 url；dispatcher 不持有 url map）
   */
  private async dispatchToBrowse(
    channel: BrowseChannel,
    task: InteractTask,
    url: string | undefined,
  ): Promise<InteractEnvelope> {
    const browseUrl = url ?? "about:blank";
    try {
      return await channel.browse(browseUrl, task.action, task.options);
    } catch (e) {
      return {
        outcome: "unknown",
        data: null,
        served_by: "interact_dispatcher",
        fallback_used: false,
        retrieval_method: "dispatch_browse_threw",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ============================================================
  // desktop 路径（@wN）
  // ============================================================
  /**
   * dispatch 到 DesktopChannel.observe / act / wait。
   *
   * desktop action 词汇（与 browse 不同构的部分；13 §3.1）：
   *  - observe(action: "snapshot"|"find", opts)  ← interact_observe 路径
   *  - act(opts: { actions, expect })            ← interact_act 路径
   *  - wait(opts, timeoutMs)                     ← interact_wait 路径
   *
   * interact_observe(rootRef, "snapshot"/"find") → dc.observe
   * interact_act(rootRef, actions=[...]) → dc.act （task.action = "act"）
   * interact_act(rootRef, action="wait") → dc.wait
   *
   * INV-26 守护：本方法仅调 `channel.observe/act/wait` 公共方法，不调任何 internal。
   */
  private async dispatchToDesktop(
    channel: DesktopChannel,
    task: InteractTask,
  ): Promise<InteractEnvelope> {
    try {
      const opts = task.options;
      // observe 路径（只读：snapshot / find）
      if (task.action === "snapshot" || task.action === "find") {
        return await channel.observe(task.action, opts);
      }
      // act 路径
      if (task.action === "act") {
        return await channel.act(opts);
      }
      // wait 路径
      if (task.action === "wait") {
        const timeoutMs =
          typeof opts.timeout_ms === "number" ? opts.timeout_ms : undefined;
        return await channel.wait(opts, timeoutMs);
      }
      // screenshot 是 desktop 自有 action，但 interact 暂不暴露（走 desktop tool）
      // —— 未来若加，走 channel.screenshot
      return {
        outcome: "didnt",
        data: null,
        served_by: "interact_dispatcher",
        fallback_used: false,
        retrieval_method: "unknown_action_for_desktop",
        error: `action_not_in_desktop_union:${task.action}`,
      };
    } catch (e) {
      return {
        outcome: "unknown",
        data: null,
        served_by: "interact_dispatcher",
        fallback_used: false,
        retrieval_method: "dispatch_desktop_threw",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ============================================================
  // 测试 / 诊断用
  // ============================================================
  /** 暴露 registry 引用（interact_roots tool 读 list 时用）。 */
  getRegistry(): RootRegistry {
    return this.registry;
  }

  /** 测试用：列出已注册的 channel source 名。 */
  listChannelSources(): string[] {
    return [...this.channels.keys()];
  }
}
