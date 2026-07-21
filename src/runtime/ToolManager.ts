/**
 * ToolManager —— 统一 tool 注册/注销（parse7 §3.2 / F3.12.9）
 *
 * 包装 SDK 1.29 的 RegisteredTool 句柄，维护 channel→tool 反向映射。
 *
 * SDK 已原生支持（node_modules/@modelcontextprotocol/sdk/server/mcp.d.ts 核实）：
 *  - server.tool(name, ...) 返回 RegisteredTool 实例（含 .disable()/.enable()/.update()/.remove()/.enabled）
 *  - RegisteredTool.disable() 内部调 update({enabled:false}) → 触发 sendToolListChanged()
 *      （mcp.js line 644-646：if enabled !== undefined → set + sendToolListChanged）
 *  - RegisteredTool.enable() 同理 → 触发 sendToolListChanged()
 *  - RegisteredTool.remove() 调 update({name:null}) → delete this._registeredTools[name] + sendToolListChanged()
 *  - server.sendToolListChanged():void 公开方法（同步，不返 Promise）
 *
 * 铁律（INV-37 task v0.6）：
 *  - channel disable 必经 ToolManager.disableChannel（tool.disable() + SDK 自动 sendToolListChanged）；
 *    runtime/ 内禁直接 server.tool 操作绕过 ToolManager。
 *  - v0.5 既有 13 工具仍可直接 server.tool(...) 注册（向后兼容，INV-37 只约束 runtime/ 新件）。
 *
 * 铁律（INV-35 task v0.6）：
 *  - 本类不 import BrowseChannel/DesktopChannel internal；只持 RegisteredTool 句柄 + channel 字符串。
 *
 * 设计（parse7 §3.2）：
 *  - 不强行迁移 v0.5 既有 13 工具（向后兼容）
 *  - register() 包装 server.tool() —— 行为字节级等价 v0.5 直调
 *  - captureHandle() 非破坏性捕获 v0.5 已注册句柄（M0.6a 末期评估接入，Phase A 暂不接）
 *
 * 借鉴源（parse7 §3.2）：
 *  - byChannel Map ≈ BrowseChannel.actionDispatch 的反向映射（INV-6 dispatch 注册表模式）
 *  - kfirtoledo/multi-mcp hot-plug 思路：tool registration 是 runtime 可变集合（与
 *    MCP SDK 2025-03-26 协议 notifications/tools/list_changed 配套设计）
 */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../util/logger.js";
import type { ToolRecord } from "./runtime-types.js";

/**
 * 注册新 tool 时的入参形状（registerChannelTools 数组元素同形）。
 *
 * 与 server.tool() 5 参数重载对齐：(name, description, schema, annotations, handler)
 *
 * INV-5 衍生：annotations 字段必须含 readOnlyHint / openWorldHint / destructiveHint /
 *             idempotentHint 之一（与 tools/annotations.ts 的 v0.5 既有 8 工具同契约）；
 *             v0.6 admin 工具默认 destructiveHint=true（与 browse_logged_in / desktop 同级风险）。
 *             ToolManager.register 透传 annotations，不重新构造；caller 责任保 hint 完整。
 */
export interface ToolRegistration {
  name: string;
  description: string;
  schema: object;
  /**
   * MCP ToolAnnotations；必须含 readOnlyHint / openWorldHint / destructiveHint /
   * idempotentHint 之一（INV-5 守护；类比 tools/annotations.ts 的 v0.5 8 工具）。
   */
  annotations: object;
  handler: (...args: unknown[]) => Promise<unknown>;
}

export class ToolManager {
  /** tool 名 → record 映射 */
  private tools = new Map<string, ToolRecord>();
  /** channel 名 → tool 名集合（disableChannel/enableChannel/removeChannel 用） */
  private byChannel = new Map<string, Set<string>>();

  constructor(private readonly server: McpServer) {}

  /**
   * 注册一个 tool，记录其归属 channel。
   *
   * 包装 server.tool() —— 行为字节级等价 v0.5 直接调 server.tool()。
   * SDK 注册时自动触发 sendToolListChanged()（mcp.js line 651）。
   *
   * INV-37（task v0.6）：runtime/ 新 tool（admin / 动态热插拔）必须经此方法；
   *                     v0.5 既有 tools/*.ts 仍可直接 server.tool（向后兼容路径）。
   *
   * @throws Error 若同名 tool 已注册
   */
  register(
    channel: string,
    reg: ToolRegistration,
  ): RegisteredTool {
    if (this.tools.has(reg.name)) {
      throw new Error(`ToolManager: tool ${reg.name} already registered`);
    }
    // SDK server.tool() 重载期望 paramsSchema: ZodRawShapeCompat（Record<string, AnySchema>）+
    // annotations: ToolAnnotations + cb: ToolCallback<Args>。本 wrapper 接受任意 object 形状
    // schema（与 v0.5 既有 tools/*.ts 字节级等价 —— 它们也直接传 {} 或 z.object 字面量），
    // 在 SDK 边界做单点 cast（as never 是 TS 双向 escape hatch，运行时无开销）。
    const registered = this.server.tool(
      reg.name,
      reg.description,
      reg.schema as never,
      reg.annotations as never,
      reg.handler as never,
    );
    this.tools.set(reg.name, {
      name: reg.name,
      channel,
      registered,
      annotations: reg.annotations,
      schema: reg.schema,
      description: reg.description,
      handler: reg.handler,
    });
    let set = this.byChannel.get(channel);
    if (!set) {
      set = new Set();
      this.byChannel.set(channel, set);
    }
    set.add(reg.name);
    logger.info({
      evt: "tool_registered",
      name: reg.name,
      channel,
    });
    return registered;
  }

  /**
   * 非破坏性捕获 v0.5 既有 server.tool() 注册的句柄（M0.6a 末期评估接入）。
   *
   * 不重新注册（v0.5 已注册过），只把句柄塞进 tools/byChannel Map 让 disable 能作用到。
   *
   * @param channel 归属 channel
   * @param handle 已存在的 RegisteredTool 句柄（v0.5 server.tool() 返回值）
   *
   * INV-37：捕获路径与 register 路径都进 tools Map；disableChannel 两者都生效。
   */
  captureHandle(
    channel: string,
    name: string,
    handle: RegisteredTool,
  ): void {
    if (this.tools.has(name)) {
      // 已注册（可能 register() 刚走过）—— 不覆盖，保留原 record
      return;
    }
    this.tools.set(name, {
      name,
      channel,
      registered: handle,
      annotations: {},
      schema: {},
      description: "",
      handler: async () => undefined,
    });
    let set = this.byChannel.get(channel);
    if (!set) {
      set = new Set();
      this.byChannel.set(channel, set);
    }
    set.add(name);
  }

  /**
   * Disable 一个 channel 下所有 tool（listTools 立即下架）。
   *
   * INV-37（task v0.6）：channel disable 必经此方法。
   * SDK 自动 sendToolListChanged()（每个 tool.disable() 内部 update() 触发）。
   *
   * 未注册 channel → no-op（幂等，不抛错）。
   * 单 tool disable 抛错 → log warn 不阻断（其余 tool 继续 disable）。
   */
  async disableChannel(channel: string): Promise<void> {
    const names = this.byChannel.get(channel);
    if (!names) return;
    for (const name of names) {
      const rec = this.tools.get(name);
      if (!rec) continue;
      try {
        rec.registered.disable();
      } catch (e) {
        logger.warn({
          evt: "tool_disable_error",
          name,
          channel,
          error: String(e),
        });
      }
    }
  }

  /**
   * Re-enable 一个 channel 下所有 tool。
   * SDK 自动 sendToolListChanged()（每个 tool.enable() 内部 update() 触发）。
   */
  async enableChannel(channel: string): Promise<void> {
    const names = this.byChannel.get(channel);
    if (!names) return;
    for (const name of names) {
      const rec = this.tools.get(name);
      if (!rec) continue;
      try {
        rec.registered.enable();
      } catch (e) {
        logger.warn({
          evt: "tool_enable_error",
          name,
          channel,
          error: String(e),
        });
      }
    }
  }

  /**
   * Remove 一个 channel 下所有 tool（永久下架；用于热插拔移除 provider）。
   *
   * SDK 自动 sendToolListChanged()（每个 tool.remove() 内部 update({name:null}) 触发；
   * mcp.js line 622-628：delete this._registeredTools[name]）。
   *
   * remove 后内部 tools/byChannel Map 同步清理，避免悬空引用。
   */
  async removeChannel(channel: string): Promise<void> {
    const names = this.byChannel.get(channel);
    if (!names) return;
    for (const name of [...names]) {
      const rec = this.tools.get(name);
      if (rec) {
        try {
          rec.registered.remove();
        } catch (e) {
          logger.warn({
            evt: "tool_remove_error",
            name,
            channel,
            error: String(e),
          });
        }
      }
      this.tools.delete(name);
      names.delete(name);
    }
    if (names.size === 0) this.byChannel.delete(channel);
  }

  /**
   * Hot-plug 用：批量注册新 channel 的全部 tool（如热插拔新 search provider）。
   *
   * 任一注册失败 → 抛错（事务性回滚由调用方处理；本方法不半完成）。
   */
  async registerChannelTools(
    channel: string,
    regs: ToolRegistration[],
  ): Promise<void> {
    for (const r of regs) {
      this.register(channel, r);
    }
  }

  /**
   * 单 tool disable（admin 工具 tool_disable action 用；当前 Phase A 暂不暴露）。
   * 不经 channel 路径，直接按 tool 名操作。
   */
  async disableTool(name: string): Promise<boolean> {
    const rec = this.tools.get(name);
    if (!rec) return false;
    try {
      rec.registered.disable();
      return true;
    } catch (e) {
      logger.warn({
        evt: "tool_disable_error",
        name,
        error: String(e),
      });
      return false;
    }
  }

  /** 单 tool enable（admin 工具 tool_enable action 用；当前 Phase A 暂不暴露）。 */
  async enableTool(name: string): Promise<boolean> {
    const rec = this.tools.get(name);
    if (!rec) return false;
    try {
      rec.registered.enable();
      return true;
    } catch (e) {
      logger.warn({
        evt: "tool_enable_error",
        name,
        error: String(e),
      });
      return false;
    }
  }

  /** 是否已注册某 tool（admin tool_list / 测试用）。 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 取某 tool 归属 channel（未注册返 undefined）。 */
  channelOf(name: string): string | undefined {
    return this.tools.get(name)?.channel;
  }

  /**
   * 列所有 channel + 其下 tool 名集合（admin tool_list 用）。
   * 返回新 Map + 新数组（防外部 mutate）。
   */
  listByChannel(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [ch, set] of this.byChannel) {
      out.set(ch, [...set]);
    }
    return out;
  }

  /**
   * 当前 ToolManager 管理的 tool 总数（admin tool_list / doctor 用）。
   */
  size(): number {
    return this.tools.size;
  }
}
