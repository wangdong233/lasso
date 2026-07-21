/**
 * CapabilityBag —— 能力袋状态机（parse7 §3.1 / F3.5.10-11）
 *
 * 设计：维护 channel/provider 的运行时启停状态 + 状态变更 handler 链。
 *
 * 铁律（INV-36 task v0.6）：
 *  - 只能在**已注册** name 集合上 enable/disable；未注册名 disable/enable 返 false，
 *    不凭空造 channel（与 ProviderConfig.enabled 构造期字段正交）。
 *  - register 新 name 时若已存在则 no-op（幂等）。
 *
 * 铁律（INV-40 parse7 §5.1，task 版 INV-35）：
 *  - constructor 初始化所有 entry enabled=true（默认全开 = v0.5 行为，零回归承诺）；
 *    禁出现 enabled:false 初始值。
 *
 * 铁律（INV-35 task v0.6）：
 *  - runtime/ 不 import BrowseChannel/DesktopChannel internal；本类只持 string name
 *    集合，不持 channel class 引用（channel 句柄操作下沉到 index.ts 装配的 onChange handler）。
 *
 * 与 PolicyGate / ProviderConfig.enabled 的边界（R-RT-4 parse7 §7.1）：
 *  - ProviderConfig.enabled 是构造期 schema 字段（启始是否进注册表）
 *  - CapabilityBag.enabled 是运行时状态（只能 enable/disable 已注册的）
 *  - 两者正交：constructor skip enabled=false 的（INV 衍生），bag 初始 enabled=true
 *
 * 借鉴源（parse7 §3.1）：
 *  - 状态机形状 ≈ QuotaLedger 的 KeyState（不可变 name + 可变 enabled/exhausted）
 *  - onChange async 链 ≈ Node EventEmitter 但支持 await（保证 tool 下架完成 admin 才返回）
 *
 * 与 SubprocessManager / ToolManager 的联动（parse7 §3.1 末尾伪码）：
 *  - 不在本类实装（守 INV-35：runtime/ 不渗 channel internal）
 *  - index.ts 装配期挂 bag.onChange(handler)，handler 内调 toolManager.disableChannel +
 *    subproc.shutdownOne（channel 名 → spec 名的映射也是 index.ts 顶级 const，不在本类）
 */
import { logger } from "../util/logger.js";
import type {
  CapabilityState,
  CapabilityKind,
  CapabilityChangeHandler,
} from "./runtime-types.js";

export class CapabilityBag {
  private state = new Map<string, CapabilityState>();
  private handlers: CapabilityChangeHandler[] = [];

  /**
   * @param initial 初始化已注册 channel/provider 名集合（来自 index.ts 装配）。
   *                全部初始化为 enabled=true（零回归：默认全开 = v0.5 行为）。
   *
   * INV-40（parse7 §5.1）：constructor 禁止任何 enabled:false 初始值。
   * INV-36（task v0.6）：所有后续 enable/disable 只能作用于此 initial 集合
   *                     或 register 新增的 name，不能凭空造。
   */
  constructor(initial: Iterable<string>) {
    for (const name of initial) {
      this.state.set(name, {
        name,
        kind: inferKind(name),
        enabled: true,
      });
    }
  }

  /**
   * Disable 一个 channel/provider。
   *
   * @returns true=状态变化（enabled→disabled）；false=本就 disabled 或未注册名（INV-36：不造）
   */
  async disable(
    name: string,
    opts?: { callerId?: string; reason?: string },
  ): Promise<boolean> {
    const s = this.state.get(name);
    // INV-36：未注册名直接返 false，不凭空造 CapabilityState
    if (!s || !s.enabled) return false;
    s.enabled = false;
    s.disabledAt = Date.now();
    s.disabledBy = opts?.callerId ?? "admin";
    s.reason = opts?.reason;
    logger.info({
      evt: "capability_disabled",
      name,
      by: s.disabledBy,
      reason: s.reason,
    });
    await this._dispatch(name, false, s);
    return true;
  }

  /**
   * Enable 一个 channel/provider。
   *
   * @returns true=状态变化（disabled→enabled）；false=本就 enabled 或未注册名（INV-36：不造）
   */
  async enable(name: string, opts?: { callerId?: string }): Promise<boolean> {
    const s = this.state.get(name);
    // INV-36：未注册名直接返 false，不凭空造 CapabilityState
    if (!s || s.enabled) return false;
    s.enabled = true;
    s.disabledAt = undefined;
    s.disabledBy = undefined;
    s.reason = undefined;
    logger.info({
      evt: "capability_enabled",
      name,
      by: opts?.callerId ?? "admin",
    });
    await this._dispatch(name, true, s);
    return true;
  }

  /**
   * 查询某 name 当前是否 enabled。
   *
   * 未注册名默认返 true（防 fallback 链误伤 —— parse7 §3.1）：
   *  - bag 不是白名单，是运行时状态机；未知名 = 未被 runtime 触及，假定 v0.5 默认 enabled
   *  - bag.isEnabled 在 channel executor 入口处 gate，未注册名不应进 fallback plan，但若进也不该被无故 block
   */
  isEnabled(name: string): boolean {
    return this.state.get(name)?.enabled ?? true;
  }

  /**
   * 注册状态变更 handler（index.ts 装配时挂 toolManager + subproc 联动）。
   * 返回 unsubscribe 函数（测试用 + 装配期可回滚）。
   */
  onChange(handler: CapabilityChangeHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  /**
   * 当前状态快照（admin capability_list / doctor 用）。
   * 返回新数组（防外部 mutate 内部 state）。
   */
  snapshot(): CapabilityState[] {
    return Array.from(this.state.values()).map((s) => ({ ...s }));
  }

  /**
   * 热插拔用：注册一个新 channel/provider 名（初始 enabled=true）。
   *
   * INV-36（task v0.6）：register 是新 name 进入 bag 的唯一入口；
   *                     已存在则 no-op（幂等，不抛错）。
   * INV-40：新 register 的 entry 也必 enabled=true。
   */
  register(name: string): void {
    if (this.state.has(name)) return; // 幂等
    this.state.set(name, {
      name,
      kind: inferKind(name),
      enabled: true,
    });
    logger.info({ evt: "capability_registered", name });
  }

  /**
   * 热卸载用：从 bag 移除一个 name（hot-reload 移除 provider 时调）。
   * 不触发 onChange handler（与 disable 语义不同 —— disable 是临时下线，remove 是永久卸载）。
   *
   * @returns true=已移除；false=本就不存在
   */
  unregister(name: string): boolean {
    const existed = this.state.delete(name);
    if (existed) {
      logger.info({ evt: "capability_unregistered", name });
    }
    return existed;
  }

  /** 是否已 register（INV-36 衍生：测试 + doctor 用）。 */
  has(name: string): boolean {
    return this.state.has(name);
  }

  /** 当前已注册 name 集合（hot-reload diff 计算用）。 */
  registeredNames(): string[] {
    return Array.from(this.state.keys());
  }

  // ============================================================
  // 私有
  // ============================================================
  /**
   * 派发状态变更到所有 handler（顺序 await；任一抛错不阻断后续）。
   *
   * 设计：handler 错误隔离（一个 handler 挂了不影响其他 handler）；
   *       error 仅 log warn 不 rethrow（disable 语义成功，仅 audit 留痕）。
   */
  private async _dispatch(
    name: string,
    enabled: boolean,
    state: CapabilityState,
  ): Promise<void> {
    for (const h of this.handlers) {
      try {
        await h(name, enabled, state);
      } catch (e) {
        logger.warn({
          evt: "capability_handler_error",
          name,
          enabled,
          error: String(e),
        });
      }
    }
  }
}

// ============================================================
// 工具（私有于本模块）
// ============================================================
/**
 * 从命名约定推断 kind：含 "." 视为 provider 级（"search.brave" / "desktop.cgEvent"）；
 * 否则 channel 级（"browse_headless" / "desktop"）。
 *
 * 注意：desktop channel 整体是 "desktop"（无点），desktop.* 是 provider 级。
 * 这与 ProviderConfig.name 命名一致（DESKTOP_AX.name="desktop.ax"）。
 */
function inferKind(name: string): CapabilityKind {
  return name.includes(".") ? "provider" : "channel";
}
