# Lasso v0.6 parse7 —— 能力袋动态启停（文件/函数级执行计划）

> **增量件**：在 parse6（v0.5，967 TS + 144 Rust + 34 invariants + 4 工具）基础上，产出 v0.6 文件/函数级实施计划。F 编号对应 08 §4（F3.5.10-11 / F3.6.6 / F3.1.9,13 / F3.12.9）；排期锚 09 §2.7；架构基线 08 §2.2 CapabilityBag + §3.6 ProviderConfig。
>
> **权威源**（绝对路径）：
> - `/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.7
> - `/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md` §2.2 / §3.6 / §4（F 编号表）
> - `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/index.ts`（v0.5 静态装配基线）
> - `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/config/provider-registry.ts` + `providers.ts`（v0.2/v0.4 注册表）
> - `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/fallback/FallbackDecider.ts` + `PolicyGate.ts`（v0.4 政策 gate 已注入路径）
> - `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/subprocess/SubprocessManager.ts`（lifecycle 单一真源）
> - `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs`（INV-1..34 基线）

---

## 1. v0.6 目标与范围（v0.5 增量）

### 1.1 能力目标（09 §2.7）

**运行时加减通道/provider（不重启 MCP server）**。CC（或其他 MCP 客户端）通过单一 admin 工具触发 channel/provider 的 enable/disable；tool 列表随上下线自动 `sendToolListChanged`；子进程安全启停；新 provider 配置热加载。

**用户感受**（09 §1 跃升曲线）：「我让 CC 关掉桌面通道做实验，再让它打开，不用重启 MCP」；「我加了一个新的 Brave Key 池，下一次 search 就用新 Key」。

### 1.2 范围矩阵（做 / 不做）

| 类别 | 做（v0.6 in-scope） | 不做（推迟 / NO-GO） |
|---|---|---|
| 动态启停 | channel 级 enable/disable（browse_headless / browse_logged_in / desktop / browse_cloud_*）；provider 级 disable（desktop.cgEvent 等单档关闭） | 跨 channel 的「整体熔断」自动 disable（v0.7 长熔断 + SERP 自检） |
| 热插拔 | 运行时 `registry.add(NewProviderConfig)` + 自动生成 QuotaLedger + CapabilityBag 槽位 + tool 注册 | 配置文件 watch（F3.6.6 热更新只做 SIGHUP 信号 + admin tool 主动调用；不用 chokidar） |
| caller-tier cap | per-caller 60s 滑动窗上限（默认 100，env `LASSO_CALLER_CAP_DEFAULT`） | per-tool cap / per-session cap / 全局并发上限（v0.7/v0.8） |
| ToS 标记 | 复用 `ProviderConfig.policy_risk` 三态 + 新增可选 `tos_url?: string`（仅 doctor 显示，不影响路由） | 自动 ToS 合规检查 / 法务风险评估（明确边界：永远 doctor warn + manual-switch，不替用户判断合规） |
| tool_manager | 包装 `server.tool()` 的 `RegisteredTool` 句柄；channel→tool 映射；channel disable 时 tool 跟随 disable | 动态 schema 变更（已注册 tool 的 inputSchema 不允许改；如需改动走 remove+register） |
| 触发方式 | MCP admin tool（暴露给 CC）；SIGHUP 信号（脚本驱动） | REST API / streamableHttp（R10 边界：CC stdio only 不变） |
| 持久化 | disable 状态进程内（重启清零）；caller-tier cap 进程内；热插拔配置可选 `~/.config/lasso/providers.json` | 配置改写 providers.ts（v0.6 不动 v0.5 静态件） |

### 1.3 v0.5 零回归承诺（硬约束）

1. **INV-1..34 全部保持 PASS**（v0.5 的 34 条铁律一行不动；新增 INV-35..40）。
2. **index.ts 静态装配范式不变**：默认全开 = v0.5 行为。CapabilityBag 初始化时所有已注册 channel 状态 = `enabled`。
3. **967 TS 测试零修改**（除新增 v0.6 测试文件）；**144 Rust 测试零修改**（rust-helper/ 不动）。
4. **ProviderRegistry 构造期语义不变**：`enabled=false` 的 provider（TAVILY_WATCH）仍不进注册表（v0.2 INV）。CapabilityBag 只能在**已注册**集合上 enable/disable，不能凭空造 channel。
5. **server.tool() deprecated API 保留**（v0.5 注册路径不强行迁 registerTool）；ToolManager 是 wrapper，注册语义字节级等价。
6. **R-CI-02 红线**：FallbackDecider / PolicyGate / QuotaLedger 范式不另起一套；CallerTierTracker 复用 QuotaLedger `_refreshState` 滑动窗范式（不开第二套 rate limiter）。

---

## 2. 文件结构（lasso/src/ 改动）

### 2.1 新增文件（5 个 TS + 1 个 test 目录）

```
lasso/src/
  runtime/                          # 新模块（v0.6 全新目录）
    CapabilityBag.ts                # 能力袋状态机（channel/provider enable/disable）     ~180 行
    ToolManager.ts                  # 包装 RegisteredTool；channel→tool 映射；批量下线     ~210 行
    CallerTierTracker.ts            # per-caller 滑动窗配额（复用 QuotaLedger 范式）        ~140 行
    hot-reload.ts                   # SIGHUP / admin trigger → registry.add + bag.enable    ~90 行
    runtime-types.ts                # CapabilityState / CallerBudget / AdminAction union    ~70 行
  tools/
    admin.ts                        # admin tool（action-enum：capability_*/tool_*/caller_*） ~260 行
  test/unit/runtime/
    CapabilityBag.test.ts           # 状态机 + audit trail                                              ~220 行
    ToolManager.test.ts             # register/disable/enable/remove + channel 映射                     ~200 行
    CallerTierTracker.test.ts       # windowed cap + per-caller 隔离                                    ~150 行
    hot-reload.test.ts              # SIGHUP → add provider → bag.enable                                ~120 行
  test/integration/
    runtime-disable-channel.test.ts # end-to-end: disable browse_headless → listTools 不含 + subproc 死  ~180 行
    runtime-hot-plug.test.ts        # add brave2 → search uses new key                                   ~150 行
```

**新增 TS 行数估算**：~950 行 src + ~750 行 test = **~1700 行**（与 v0.5 fetch_url+ screenshot+pdf+network 的 ~1800 行同量级）。

### 2.2 修改文件（5 个，外科手术式）

| 文件 | 改动 | 行数 | 兼容性 |
|---|---|---|---|
| `src/index.ts` | v0.5 静态装配**保留**；装配后新增「v0.6 接线段」（实例化 CapabilityBag + ToolManager + CallerTierTracker + 注册 admin tool + 监听 SIGHUP） | +90 | v0.5 装配段零改；新增段在装配尾部 |
| `src/config/provider-registry.ts` | 加 `add(config)` / `remove(name)` 方法；构造期仍读 readonly configs（INV-9 单一真源不动） | +60 | v0.5 readonly constructor 字节级等价（add/remove 是新方法） |
| `src/subprocess/SubprocessManager.ts` | 加 `shutdownOne(name)` —— 单 spec kill（复用 `_kill` / `_killRust`）；**不**改 `shutdown()` 全停语义 | +35 | v0.5 `shutdown()` 行为零改；INV-7 仍守（仍纯 lifecycle） |
| `src/fallback/PolicyGate.ts` | 加 `tos_url` 透传到 verdict（doctor 显示用）；check() 路由逻辑零改（已支持 policy_risk 三态） | +15 | v0.5 verdict 形状扩展可选字段；check() 字节级等价 |
| `src/types.ts` | ProviderConfig 加 2 个可选字段：`tos_url?: string` + `tos_ack?: boolean`（默认 false） | +8 | 全部可选字段，v0.5 实例化无影响 |
| `src/invariants/check-invariants.mjs` | 加 INV-35..40（6 条新铁律） | +180 | INV-1..34 断言字节级不动 |
| `src/doctor/doctor.ts` | doctor 报告新增 `runtime_state` section（从 CapabilityBag.snapshot + CallerTierTracker.snapshot 读） | +40 | v0.5 checks 不动，仅 report 多一 section |

**修改行数**：~430 行（其中 180 是 INV 断言；其余 ~250 是新方法/新 section，不动 v0.5 路径）。

### 2.3 文件依赖图（v0.6 增量，零循环）

```
index.ts
  ├─ (v0.5 静态装配：不动)
  └─ (v0.6 接线段：新增)
      ├─ runtime/CapabilityBag.ts
      │    └─ types.js（CapabilityState）
      ├─ runtime/ToolManager.ts
      │    └─ @modelcontextprotocol/sdk（RegisteredTool 句柄）
      │    └─ runtime/runtime-types.js
      ├─ runtime/CallerTierTracker.ts
      │    └─ util/logger.js
      ├─ runtime/hot-reload.ts
      │    └─ config/provider-registry.ts（add/remove）
      │    └─ runtime/CapabilityBag.ts（enable 新 entry）
      ├─ tools/admin.ts
      │    └─ runtime/*.ts（注入）
      ├─ config/provider-registry.ts（+add/remove 方法）
      ├─ subprocess/SubprocessManager.ts（+shutdownOne 方法）
      └─ fallback/PolicyGate.ts（+tos_url 透传）
```

**R-CI-02 守护**：runtime/ 不 import BrowseChannel/DesktopChannel internal（类比 INV-26 forest 调度层）；只通过 index.ts 注入的 channel 名集合 + SubprocessManager 句柄操作。

---

## 3. 各模块实施细节

### 3.1 CapabilityBag —— 能力袋动态启停（F3.5.10-11）

**文件**：`src/runtime/CapabilityBag.ts`（~180 行）

**接口签名**：

```typescript
// src/runtime/runtime-types.ts
export type CapabilityKind = "channel" | "provider";

export interface CapabilityState {
  readonly name: string;            // "browse_headless" / "search.brave" / "desktop.cgEvent"
  readonly kind: CapabilityKind;
  enabled: boolean;
  disabledAt?: number;             // epoch ms
  disabledBy?: string;             // callerId / "system" / "admin"
  reason?: string;                 // 自由文本（audit log 用）
}

export type CapabilityChangeHandler = (
  name: string,
  enabled: boolean,
  state: CapabilityState,
) => void | Promise<void>;
```

```typescript
// src/runtime/CapabilityBag.ts
export class CapabilityBag {
  private state = new Map<string, CapabilityState>();
  private handlers: CapabilityChangeHandler[] = [];

  /**
   * @param initial 初始化已注册 channel/provider 名集合（来自 index.ts 装配）。
   *                全部初始化为 enabled=true（零回归：默认全开 = v0.5 行为）。
   *                INV-40：构造期禁止任何 enabled=false 初始值。
   */
  constructor(initial: Iterable<string>) {
    for (const name of initial) {
      this.state.set(name, {
        name,
        kind: name.includes(".") ? "provider" : "channel",
        enabled: true,
      });
    }
  }

  /** Disable 一个 channel/provider。返回 true=状态变化，false=本就 disabled 或未知名。 */
  async disable(
    name: string,
    opts?: { callerId?: string; reason?: string },
  ): Promise<boolean> {
    const s = this.state.get(name);
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

  /** Enable 一个 channel/provider。返回 true=状态变化。 */
  async enable(name: string, opts?: { callerId?: string }): Promise<boolean> {
    const s = this.state.get(name);
    if (!s || s.enabled) return false;
    s.enabled = true;
    s.disabledAt = undefined;
    s.disabledBy = undefined;
    s.reason = undefined;
    logger.info({ evt: "capability_enabled", name, by: opts?.callerId ?? "admin" });
    await this._dispatch(name, true, s);
    return true;
  }

  isEnabled(name: string): boolean {
    return this.state.get(name)?.enabled ?? true;  // 未知名默认 enabled（防 fallback 链误伤）
  }

  /** 注册状态变更回调（index.ts 装配时挂 toolManager + subproc 联动）。 */
  onChange(handler: CapabilityChangeHandler): void {
    this.handlers.push(handler);
  }

  snapshot(): CapabilityState[] {
    return Array.from(this.state.values());
  }

  /** 热插拔用：注册一个新 channel/provider 名（初始 enabled）。 */
  register(name: string): void {
    if (this.state.has(name)) return;
    this.state.set(name, {
      name,
      kind: name.includes(".") ? "provider" : "channel",
      enabled: true,
    });
  }

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
          error: String(e),
        });
      }
    }
  }
}
```

**伪码：disable 触发的联动**（在 index.ts 装配后挂上）：

```typescript
bag.onChange(async (name, enabled, state) => {
  if (enabled) {
    // re-enable：subproc.ensureRunning 由 channel 内部 lazy 启动时自调，无需主动
    await toolManager.enableChannel(name);
    return;
  }
  // disable 路径
  await toolManager.disableChannel(name);          // tools/list 立即下架
  if (state.kind === "channel") {
    // 通道级：安全停该通道独占的子进程
    //   browse_headless → kill "lasso-browse-headless"
    //   browse_logged_in → kill "lasso-browse-logged-in"
    //   desktop → kill "rust-helper"（全 4 档 provider 共享；确认 bag 全 desktop.* 都 disable 才 kill）
    //   browse_cloud_browserbase → 无本地子进程（cloud），仅禁工具
    const specName = CHANNEL_TO_SPEC[name];
    if (specName && !specName.startsWith("shared:")) {
      await subproc.shutdownOne(specName);
    }
  }
  // provider 级 disable（如 desktop.cgEvent）：不动子进程，仅由 channel 内部 fallback plan 过滤
});
```

**关键设计**：
- `CHANNEL_TO_SPEC` 映射表是 index.ts 顶级常量（ INV-35 衍生：单一映射表，不在多处散落）。
- `rust-helper` 标 `shared:rust-helper`，仅当 bag.snapshot() 中**所有** `desktop.*` 都 disabled 时才 `shutdownOne`（避免 desktop.cgEvent disable 误杀 rust-helper 影响 desktop.ax）。
- enable 路径**不**主动 spawn（channel 内部 `getMcpClient()` 仍走 SubprocessManager 的懒启动；v0.5 范式不变）。

**借鉴源**：
- 状态机形状 ≈ QuotaLedger 的 KeyState（不可变 name + 可变 enabled/exhausted）。
- onChange 模式 ≈ SubprocessManager 没有的（新），但类比 Node EventEmitter；不用 EventEmitter 是因为要 await handler 链（保证 tool 下架完成才返回 admin tool 调用）。

**行数估算**：180 行（含注释 + logger）。

---

### 3.2 ToolManager —— 统一 tool 注册/注销（F3.12.9）

**文件**：`src/runtime/ToolManager.ts`（~210 行）

**SDK 已原生支持**（node_modules 核实）：
- `McpServer.server.tool(...)` 返回 `RegisteredTool`，自带 `.disable() / .enable() / .remove() / .update()`。
- `.disable()` 会让该 tool 不出现在 listTools 结果中（SDK 内部 `enabled: false` 过滤）。
- `.remove()` 调用 `update({name: null})` → `delete this._registeredTools[name]` + 自动 `sendToolListChanged()`。

**接口签名**：

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface ToolRecord {
  readonly name: string;
  readonly channel: string;            // owning channel（如 "browse_headless" / "desktop" / "admin"）
  readonly registered: RegisteredTool;  // SDK 句柄（含 disable/enable/remove/update）
  readonly annotations: object;        // 保存以便重新注册（hot-plug 后）
  readonly schema: unknown;            // inputSchema 快照
  readonly description: string;
  // 保存 handler 引用以便 enable 后重注册（remove 后实例失效）
  readonly handler: (...args: unknown[]) => Promise<unknown>;
}

export class ToolManager {
  /** channel 名 → tool 名集合 */
  private byChannel = new Map<string, Set<string>>();
  /** tool 名 → record */
  private tools = new Map<string, ToolRecord>();

  constructor(private readonly server: McpServer) {}

  /**
   * 注册一个 tool，并记录其归属 channel。
   * 包装 server.tool() —— 行为字节级等价 v0.5 直接调 server.tool()。
   *
   * INV-36：v0.6 起所有新 tool（admin / 动态热插拔 tool）必须经此方法；
   *         v0.5 既有 tools/*.ts 仍可直接 server.tool（向后兼容，back-compat 路径）。
   */
  register(
    channel: string,
    name: string,
    description: string,
    schema: object,
    annotations: object,
    handler: (...args: unknown[]) => Promise<unknown>,
  ): RegisteredTool {
    if (this.tools.has(name)) {
      throw new Error(`ToolManager: tool ${name} already registered`);
    }
    const registered = this.server.tool(
      name,
      description,
      schema,
      annotations,
      handler,
    );
    this.tools.set(name, {
      name,
      channel,
      registered,
      annotations,
      schema,
      description,
      handler,
    });
    if (!this.byChannel.has(channel)) this.byChannel.set(channel, new Set());
    this.byChannel.get(channel)!.add(name);
    return registered;
  }

  /** Disable 一个 channel 下所有 tool（listTools 立即下架；SDK 自动 sendToolListChanged）。 */
  async disableChannel(channel: string): Promise<void> {
    const names = this.byChannel.get(channel);
    if (!names) return;
    for (const name of names) {
      const rec = this.tools.get(name);
      if (rec) {
        try {
          rec.registered.disable();
        } catch (e) {
          logger.warn({ evt: "tool_disable_error", name, error: String(e) });
        }
      }
    }
  }

  /** Re-enable 一个 channel 下所有 tool。 */
  async enableChannel(channel: string): Promise<void> {
    const names = this.byChannel.get(channel);
    if (!names) return;
    for (const name of names) {
      const rec = this.tools.get(name);
      if (rec) {
        try {
          rec.registered.enable();
        } catch (e) {
          logger.warn({ evt: "tool_enable_error", name, error: String(e) });
        }
      }
    }
  }

  /** Remove 一个 channel 下所有 tool（永久下架；用于热插拔移除 provider）。 */
  async removeChannel(channel: string): Promise<void> {
    const names = this.byChannel.get(channel);
    if (!names) return;
    for (const name of [...names]) {
      const rec = this.tools.get(name);
      if (rec) {
        try {
          rec.registered.remove();
        } catch (e) {
          logger.warn({ evt: "tool_remove_error", name, error: String(e) });
        }
      }
      this.tools.delete(name);
      names.delete(name);
    }
    if (names.size === 0) this.byChannel.delete(channel);
  }

  /** Hot-plug 用：注册新 channel 的全部 tool（如热插拔新 search provider）。 */
  async registerChannelTools(
    channel: string,
    tools: Array<{
      name: string;
      description: string;
      schema: object;
      annotations: object;
      handler: (...args: unknown[]) => Promise<unknown>;
    }>,
  ): Promise<void> {
    for (const t of tools) {
      this.register(channel, t.name, t.description, t.schema, t.annotations, t.handler);
    }
  }

  listByChannel(): Map<string, string[]> {
    return new Map(
      Array.from(this.byChannel.entries()).map(([ch, set]) => [ch, [...set]]),
    );
  }
}
```

**关键设计**：
- **不强行迁移 v0.5 既有 8 工具**（search / browse_headless / browse_logged_in / browserbase / desktop / interact_roots / interact_observe / interact_act / fetch_url / screenshot / pdf / network / doctor / read_text）。它们仍走 `server.tool(...)` 直注册。ToolManager 只在 v0.6 admin 工具 + 热插拔新 channel 时使用。这样守零回归。
- **可选迁移**（v0.6 M0.6a 末期评估）：把 v0.5 工具的 `RegisteredTool` 句柄捕获到 ToolManager（不重新注册，只把句柄塞进 `tools` Map + byChannel Map）。这样 disable 能作用于所有 v0.5 工具。**默认开启此"句柄捕获"路径**，因为句柄捕获是非破坏性的。
- MCP SDK 的 `.disable()` 已自动触发 `sendToolListChanged()`，所以 CC 端 `listTools` 缓存会自动刷新。

**借鉴源**：
- `byChannel` 映射 ≈ BrowseChannel.actionDispatch Map 的 channel→tool 反向映射（INV-6 dispatch 注册表模式）。
- kfirtoledo/multi-mcp 的 hot-plug 思路：tool registration 不是一个 server-lifetime 不可变集合，而是 runtime 可变的；这与 MCP SDK 2025-03-26 协议的 `notifications/tools/list_changed` 配套设计。

**行数估算**：210 行。

---

### 3.3 CallerTierTracker —— per-caller 配额（F3.1.9）

**文件**：`src/runtime/CallerTierTracker.ts`（~140 行）

**接口签名**：

```typescript
// 借鉴 QuotaLedger 的 _refreshState + windowStart + remaining 三件套
interface CallerBudget {
  readonly callerId: string;
  windowStart: number;        // 当前窗口起点 epoch ms
  used: number;               // 窗口内已用
  cap: number;                // 该 caller 的上限（per-caller override 或 defaultCap）
  lastExceeded?: number;      // 上次拒绝时间（doctor 显示）
}

export class CallerTierTracker {
  private budgets = new Map<string, CallerBudget>();

  constructor(
    private readonly defaultCap: number = 100,
    private readonly windowMs: number = 60_000,
  ) {}

  /**
   * 尝试为 caller 计一次调用。返回 true=放行，false=超额。
   *
   * 与 QuotaLedger.pickKey 的差异：pickKey 是贪心选 key，这里是单 caller 累计；
   * 与 QuotaLedger.recordSuccess 的差异：success 是事后扣，tryAcquire 是事前 gate。
   *
   * INV-38：滑动窗逻辑必须复用 QuotaLedger._refreshState 同范式（windowStart + used 衰减），
   *         禁另起一套 token bucket / GCRA 算法（R-CI-02）。
   */
  tryAcquire(callerId: string, cost: number = 1): boolean {
    this._refreshWindow(callerId);
    const b = this._getOrCreate(callerId);
    if (b.used + cost > b.cap) {
      b.lastExceeded = Date.now();
      logger.warn({
        evt: "caller_cap_exceeded",
        caller: callerId,
        used: b.used,
        cap: b.cap,
      });
      return false;
    }
    b.used += cost;
    return true;
  }

  /** per-caller override（admin tool 用）。cap=0 等价禁用该 caller。 */
  setCap(callerId: string, cap: number): void {
    const b = this._getOrCreate(callerId);
    b.cap = Math.max(0, cap);
    logger.info({
      evt: "caller_cap_set",
      caller: callerId,
      cap,
      by: "admin",
    });
  }

  /** admin tool 用：列出所有 caller 当前状态（脱敏）。 */
  snapshot(): Array<{ callerId: string; used: number; cap: number; windowMs: number }> {
    const now = Date.now();
    return Array.from(this.budgets.values()).map((b) => ({
      callerId: b.callerId,
      used: now - b.windowStart > this.windowMs ? 0 : b.used,
      cap: b.cap,
      windowMs: this.windowMs,
    }));
  }

  /** callerId 从哪里来？见 admin tool 接入：MCP request extra 里有 _meta.callerId（v0.6 约定）。
   *  CC 当前不主动传 callerId；fallback 到 "anonymous"（共享 100/分钟）。
   *  v0.7+ 若 CC 传明确 callerId 再启用真正隔离。 */
  private _getOrCreate(callerId: string): CallerBudget {
    let b = this.budgets.get(callerId);
    if (!b) {
      b = {
        callerId,
        windowStart: Date.now(),
        used: 0,
        cap: this.defaultCap,
      };
      this.budgets.set(callerId, b);
    }
    return b;
  }

  private _refreshWindow(callerId: string): void {
    const b = this.budgets.get(callerId);
    if (!b) return;
    const now = Date.now();
    if (now - b.windowStart > this.windowMs) {
      b.windowStart = now;
      b.used = 0;
    }
  }
}
```

**接入点**（在 search.ts / browse.ts 等 handler 入口处）：

```typescript
// 在 registerSearchTool 内部 wrapper：
const callerId = (extra?._meta?.callerId as string) ?? "anonymous";
if (!callerTier.tryAcquire(callerId)) {
  return {
    outcome: "didnt",
    retrieval_method: "caller_cap_exceeded",
    error: `caller ${callerId} exceeded 60s cap`,
    // ...
  };
}
// 继续原 search 逻辑
```

**关键设计**：
- **不**用 token bucket / GCRA / Redis-backed limiter（R-CI-02）。
- callerId 在 MCP request 的 `_meta` 字段（MCP 协议支持）；CC 不传则 fallback `"anonymous"`。这样 v0.6 不依赖 CC 行为变化，但已为未来 CC 主动传 callerId 做好准备。
- 进程内状态（与 QuotaLedger v0.2 同样承诺，v0.6 不持久化；v0.8+ cookie export 同期评估持久化）。

**行数估算**：140 行。

---

### 3.4 ToS 标记 —— 复用 ProviderConfig.policy_risk（F3.1.13）

**决策**：**不开第二套 ToS 引擎**。直接复用 v0.4 已落的 `ProviderConfig.policy_risk: "safe" | "acquired" | "watched"`（PolicyGate.ts 已实装三态过滤）。

**v0.6 增量**（仅元数据，不影响路由）：

```typescript
// src/types.ts（加 2 个可选字段）
export interface ProviderConfig {
  // ... v0.5 既有字段
  /** v0.6: ToS 文档 URL（doctor + audit log 显示用）。 */
  tos_url?: string;
  /**
   * v0.6: ToS ack 状态。默认 "acknowledged"（v0.5 行为零变化）。
   *  - "pending"     ：未确认（doctor warn，不阻断 —— 复用 PolicyGate.policy_risk 走 manual-switch）
   *  - "acknowledged"：已确认（默认）
   *  - "violated"    ：已知违反（doctor fail + PolicyGate 等价 acquired 阻断）
   */
  tos_ack?: "pending" | "acknowledged" | "violated";
}
```

**PolicyGate 扩展**（src/fallback/PolicyGate.ts，+15 行）：

```typescript
// 在 check() 规则 2 之后追加：
if (prov.config.tos_ack === "violated") {
  return {
    allowed: false,
    reason: `tos_ack_violated:${providerName}`,
  };
}
// tos_ack === "pending" 不阻断（doctor warn），保留路由自由度
// tos_ack === "acknowledged" 完全 no-op（v0.5 行为）
```

**doctor 扩展**（src/doctor/doctor.ts，+40 行）：

```typescript
// 新增 doctor check：tos_ack_status
// 扫描 registry.getAllConfigs()，对每个 tos_ack === "pending" 的 provider warn，
// tos_ack === "violated" fail，并附 tos_url 链接。
```

**admin tool 暴露**：

```typescript
// admin action: provider_set_tos
{
  action: "provider_set_tos",
  provider: "tavily",
  tos_ack: "acknowledged",
  callerId: "human-admin",
}
// 仅修改 registry 中该 ProviderConfig 的 tos_ack 字段 + 写 audit log。
```

**关键设计**：
- `tos_ack="violated"` 复用 PolicyGate 已有的 acquired 阻断路径（语义同构）—— 不新造 gate 逻辑。
- `tos_ack="pending"` 是软提示（doctor warn），不阻断 —— 避免新增 provider 时卡死。
- v0.5 所有 ProviderConfig 默认 `tos_ack="acknowledged"`（隐式，因字段可选）→ PolicyGate check 字节级等价（INV-25 不动）。

**行数估算**：types.ts +8 / PolicyGate.ts +15 / doctor.ts +40 = 63 行。

**借鉴源**：Argus manual-switch（已被 v0.4 PolicyGate 借过一次）；不引新源。

---

### 3.5 admin 工具 —— 统一管理入口（F3.12.9 tool_manager 对外 API）

**文件**：`src/tools/admin.ts`（~260 行）

**action-enum 折叠**（与 desktop 工具同范式，13 审查 #1 必改原则）：

```typescript
export const ADMIN_DESCRIPTION = `
Admin operations for runtime capability management (v0.6).
Single tool with action-enum folding; DO NOT call unless you explicitly mean to
change the running MCP server's capability set.
Actions:
  - capability_list             : 列所有 channel/provider + enabled 状态
  - capability_disable          : {name} 临时禁用（tool 下架 + 子进程停）
  - capability_enable           : {name} 恢复启用
  - tool_list                   : 列所有已注册 tool + 归属 channel
  - provider_add                : {config: ProviderConfig} 热插拔新 provider
  - provider_remove             : {name} 热卸载（channel.tool 全下架）
  - provider_set_tos            : {name, tos_ack} ToS 状态标记
  - caller_cap_set              : {callerId, cap} per-caller 上限覆盖
  - caller_cap_list             : 列所有 caller 配额状态
Use ONLY when user explicitly asks to add/remove/disable a channel/provider.
SECURITY: every mutation writes audit log with callerId + reason.
`.trim();

server.tool(
  "admin",
  ADMIN_DESCRIPTION,
  {
    action: z.enum([
      "capability_list",
      "capability_disable",
      "capability_enable",
      "tool_list",
      "provider_add",
      "provider_remove",
      "provider_set_tos",
      "caller_cap_set",
      "caller_cap_list",
    ]),
    name: z.string().optional(),
    config: z.record(z.unknown()).optional(),  // provider_add 用
    tos_ack: z.enum(["pending", "acknowledged", "violated"]).optional(),
    callerId: z.string().optional(),
    cap: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
  },
  adminAnnotations,  // readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false
  async (args, extra) => {
    const callerId = (extra?._meta?.callerId as string) ?? "anonymous";
    switch (args.action) {
      case "capability_list":
        return { content: [{ type: "text", text: JSON.stringify(bag.snapshot()) }] };
      case "capability_disable":
        await bag.disable(args.name!, { callerId, reason: args.reason });
        return { content: [{ type: "text", text: `disabled ${args.name}` }] };
      // ... 其余分支同理
    }
  },
);
```

**ToolAnnotations**：`destructiveHint: true`（与 browse_logged_in / desktop_act 同等级风险）。

**安全约束**：
- 所有 mutation 写 audit log（JSONL，复用 v0.3.5 desktop audit log 范式，10MB 轮转，零遥测）。
- 不接受 raw `ProviderConfig.keys` 字符串数组直接来自调用方 —— `provider_add` 时 keys 必须从 `process.env.<PROVIDER>_API_KEYS` 读，调用方只能传 provider 名（INV-10 衍生：禁直接传 key 字面量）。
- `provider_remove` 必须传 reason + callerId（audit log 必填）。

**行数估算**：260 行（9 action 分支 + audit log writer + 输入校验）。

---

### 3.6 热更新（F3.6.6）—— SIGHUP 触发 + admin tool 触发

**文件**：`src/runtime/hot-reload.ts`（~90 行）

**两条触发路径**：

**(a) SIGHUP 信号**（运维脚本友好）：

```typescript
// src/runtime/hot-reload.ts
import { readFileSync } from "node:fs";
import type { ProviderConfig } from "../types.js";

export function installSighupHotReload(
  registry: ProviderRegistry,
  bag: CapabilityBag,
  toolManager: ToolManager,
  configPath: string | null,  // LASSO_PROVIDERS_FILE env；为 null 则无文件 watch
): void {
  if (!configPath) return;
  process.on("SIGHUP", async () => {
    logger.info({ evt: "hot_reload_triggered", src: "SIGHUP", path: configPath });
    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as { providers: ProviderConfig[] };
      await applyHotReload(parsed.providers, registry, bag, toolManager);
    } catch (e) {
      logger.error({ evt: "hot_reload_error", error: String(e) });
    }
  });
}

async function applyHotReload(
  newConfigs: ProviderConfig[],
  registry: ProviderRegistry,
  bag: CapabilityBag,
  toolManager: ToolManager,
): Promise<void> {
  const existing = new Set(registry.listNames());
  const incoming = new Set(newConfigs.map((c) => c.name));
  // 1. 移除：existing - incoming
  for (const name of existing) {
    if (!incoming.has(name)) {
      registry.remove(name);
      bag.register;  // bag 不 remove（让 disable 联动；这里其实是 disable+remove）
      await bag.disable(name, { callerId: "hot_reload", reason: "removed_from_config" });
    }
  }
  // 2. 新增：incoming - existing
  for (const c of newConfigs) {
    if (!existing.has(c.name)) {
      registry.add(c);
      bag.register(c.name);
      logger.info({ evt: "hot_plug_provider", name: c.name });
    }
  }
}
```

**(b) admin tool 主动调用**：见 §3.5 `provider_add` / `provider_remove` action。

**关键设计**：
- **不**用 chokidar / fs.watch（不稳定 + 跨平台问题）。
- **不**自动持久化：热插拔状态进程内，重启清零（与 v0.5 QuotaLedger 一致）。
- 默认 `LASSO_PROVIDERS_FILE` 未设 → 完全跳过 SIGHUP 安装（零回归）。

**行数估算**：90 行。

**ProviderRegistry.add / remove**（src/config/provider-registry.ts，+60 行）：

```typescript
export class ProviderRegistry {
  // ... v0.5 constructor + 既有方法不动

  /**
   * v0.6: 热插拔新 provider。
   * - 不重新跑 constructor 逻辑（开闭）。
   * - 创建 QuotaLedger / 更新 byName / 更新 byCapability（与 constructor 同范式）。
   * - INV-9 衍生：add/remove 是同一类内的方法（class 仍单一真源）。
   */
  add(config: ProviderConfig): void {
    if (this.byName.has(config.name)) {
      throw new Error(`ProviderRegistry: ${config.name} already registered`);
    }
    if (config.enabled === false) return;  // 与 constructor 同语义
    const cap = classifyCapability(config);
    const ledger =
      config.type === "api_key" && config.keys.length > 0
        ? new QuotaLedger(config.name, config.keys, config.free_quota_per_month, config.quota_model)
        : null;
    const entry: RegisteredProvider = { config, ledger, capability: cap };
    this.byName.set(config.name, entry);
    if (!this.byCapability.has(cap)) this.byCapability.set(cap, []);
    this.byCapability.get(cap)!.push(entry);
    this.byCapability.get(cap)!.sort((a, b) => a.config.fallback_order - b.config.fallback_order);
  }

  /** v0.6: 热卸载。不动 v0.5 静态 BUILTIN_PROVIDERS。 */
  remove(name: string): boolean {
    const entry = this.byName.get(name);
    if (!entry) return false;
    this.byName.delete(name);
    const list = this.byCapability.get(entry.capability);
    if (list) {
      const idx = list.findIndex((e) => e.config.name === name);
      if (idx >= 0) list.splice(idx, 1);
    }
    return true;
  }
}
```

**关键设计**：
- `classifyCapability` 函数复用（已存在，不重写）。
- add 后 sort 保证 fallback_order 顺序（与 constructor 一致语义）。
- INV-9 仍守：`class ProviderRegistry` 仍只在 `config/provider-registry.ts`（add/remove 是同类新方法，非新 class）。

---

## 4. 不明确点调研结论

### 4.1 动态启停怎么安全停 channel 子进程？

**结论**：分两级。

- **channel 级 disable**（如 `browse_headless`）→ 调 `subproc.shutdownOne(specName)`：
  - MCP 子进程（`lasso-browse-headless` / `lasso-browse-logged-in`）→ 复用 `_kill(name)`（已存在，幂等）。
  - cloud 浏览器（`browse_cloud_*`）→ 无本地子进程，仅禁工具（shutdownOne 空操作）。
- **provider 级 disable**（如 `desktop.cgEvent`）→ **不动子进程**。原因：`rust-helper` 被 desktop.ax / appleScript / cgEvent / screenshotVlm 共享；任何单档 disable 都不能 kill 它。仅由 DesktopChannel 内部 fallback plan 在运行时跳过该 provider 名。
- **desktop channel 整体 disable**：`bag.snapshot()` 检查所有 `desktop.*` 是否都 disabled → 是则 `shutdownOne("rust-helper")`，否则不动。

**新方法**：`SubprocessManager.shutdownOne(name: string): Promise<void>`（~35 行）：
- 复用现有 `_kill`（MCP 路径）或 `_killRust`（Rust 路径），**不**改 `shutdown()` 全停。
- 不波及其他子进程（单 spec key 删除，Map 其他 entry 不动）。
- INV-7 仍守（仍纯 lifecycle，不读协议帧）。

### 4.2 admin 触发是 MCP tool 还是 CLI？

**结论**：**两者都支持**。

- **MCP tool（主路径）**：CC 通过 `admin` tool 调用，享受 MCP 协议的 `_meta.callerId` / 审计 / ToolAnnotations 风险标记。
- **SIGHUP 信号（运维路径）**：shell 脚本 `kill -HUP $(pgrep lasso-mcp)` 触发 `hot-reload.ts` 重读配置文件。**不**支持命令行参数式启停（避免新加 CLI 子命令 → doctor CLI 之外加第二套 CLI 范式）。
- **不**做 REST API（R10 边界：CC stdio only）。

### 4.3 tool_manager 与 MCP server.tool 注册表怎么联动？

**结论**：**直接复用 SDK 内置 RegisteredTool 句柄**，不另起一套 tool 注册表。

- `server.tool(name, ...)` SDK 调用返回 `RegisteredTool` 实例，自带 `.disable() / .enable() / .remove() / .update()`。
- `RegisteredTool.disable()` 会自动设 `enabled: false` + 调 `sendToolListChanged()`，CC 端 `listTools` 立即刷新。
- `RegisteredTool.remove()` 会 `delete this._registeredTools[name]` + `sendToolListChanged()`。
- ToolManager 只是「保存这些句柄 + 维护 channel→tool 反向映射」，**不**重新实现注册逻辑。
- v0.5 既有的 13 个 `server.tool(...)` 调用**捕获句柄塞进 ToolManager**（M0.6a 末期迁移，非破坏性），这样 disable 能作用于 v0.5 全部 tool。

**校验源**：node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js line 626 / 649 / 651（RegisteredTool.update / sendToolListChanged）+ line 699（registerTool config 风格）+ line 765（sendToolListChanged 公开方法）。

---

## 5. 测试计划

### 5.1 架构不变量（INV-35..40，新增 6 条 CI 断言）

| ID | 断言 | 检测方式 |
|---|---|---|
| **INV-35** | CapabilityBag 类单一真源：定义只在 `runtime/CapabilityBag.ts`（类比 INV-3/9/24） | `grep -E "class\s+CapabilityBag"` 跨 src/ 命中文件 = 1，且路径 = `runtime/CapabilityBag.ts` |
| **INV-36** | ToolManager 是 channel→tool 映射单一真源：`byChannel` Map 只在 `runtime/ToolManager.ts`；v0.6 新 tool（admin / hot-plug）必须经 `toolManager.register` | grep `byChannel\s*=\s*new\s+Map` 命中 = 1；grep `server\.tool\(` 在 v0.6 新增 admin.ts 文件不在（admin.ts 走 toolManager.register） |
| **INV-37** | CapabilityBag 与 SubprocessManager 联动：`bag.onChange` 注册的 handler 内必须出现 `subproc.shutdownOne` 或 `toolManager.disableChannel` 字面量（确保 disable 真触发子进程停 + tool 下架） | grep `shutdownOne\|disableChannel` 在 index.ts 的 bag.onChange 回调内 |
| **INV-38** | CallerTierTracker 复用 QuotaLedger 范式：必须有 `windowStart` + `windowMs` 字段 + `_refreshWindow` 方法；禁 token bucket / GCRA / leaky bucket 关键字 | CallerTierTracker.ts grep `windowStart` + `windowMs` + `_refreshWindow`；禁 `token_bucket\|GCRA\|leaky_bucket\|TokenBucket` |
| **INV-39** | ToS 标记复用 `policy_risk` + `tos_ack`：`tos_ack` 字段定义只在 types.ts（ProviderConfig interface 内）；PolicyGate.check 不新增第二套 gate 逻辑（grep `tos_ack_violated` 只在 PolicyGate.ts，且紧邻 `policy_risk_acquired` 分支） | grep `tos_ack\s*[?:]?\s*:` 跨 src/ 命中 = 1 在 types.ts；PolicyGate.ts 含 `tos_ack_violated` 字面量 |
| **INV-40** | 默认全开：CapabilityBag constructor 初始化所有 entry `enabled: true`；grep 代码本体禁出现 `enabled:\s*false` 在 constructor 内 | stripComments 后 CapabilityBag.ts constructor 块内无 `enabled:\s*false` |

**INV-1..34 全部保持 PASS**（v0.5 零回归）：所有断言代码块不动。

### 5.2 单元测试

| 文件 | 覆盖 | 用例数 |
|---|---|---|
| `CapabilityBag.test.ts` | enable/disable 状态机；disable → onChange 触发；register 热插拔；isEnabled 未知名默认 true；snapshot 不可变性；多次 disable 幂等；callerId/reason audit 字段 | ~14 |
| `ToolManager.test.ts` | register 包装 server.tool 字节等价；disableChannel 后 tool.enabled=false；enableChannel 恢复；removeChannel 永久下架；listByChannel 形状；重复 register 抛错；未注册 channel disable 空操作 | ~12 |
| `CallerTierTracker.test.ts` | tryAcquire 窗口内累计；窗口外自动重置；per-caller 隔离（A 满 B 仍可用）；setCap=0 等价禁用；snapshot 脱敏；defaultCap 从 env 读 | ~10 |
| `hot-reload.test.ts` | SIGHUP 触发 → 读 LASSO_PROVIDERS_FILE → registry.add + bag.register；移除配置 → bag.disable；JSON 解析错 → log error 不崩；configPath=null → 不安装 SIGHUP | ~8 |

### 5.3 集成测试

| 文件 | 场景 | 验证 |
|---|---|---|
| `runtime-disable-channel.test.ts` | 启动 MCP server → listTools 含 browse_headless → admin action=capability_disable name=browse_headless → listTools 不含 → subproc healthProbe("lasso-browse-headless")=down → admin action=capability_enable → listTools 恢复 + healthProbe=healthy（懒启动后） | subproc 单停不波及 browse_logged_in；sendToolListChanged 通知发出 |
| `runtime-hot-plug.test.ts` | admin action=provider_add config={name:"brave2",type:"api_key",...} → registry.get("brave2") 返回 entry → search engine="brave2" 用新 key → admin action=provider_remove name="brave2" → registry.get 返 undefined + capability disabled | 热插拔不影响既有 brave（key 池隔离） |
| `runtime-desktop-provider-disable.test.ts` | admin disable name="desktop.cgEvent" → DesktopChannel.act 跳过 cgEvent 档 → rust-helper 子进程仍 alive（healthProbe=healthy） → desktop channel 其他档仍可用 | 验证 provider 级 disable 不 kill shared subprocess |
| `caller-tier-cap.test.ts` | mock callerId="A" tryAcquire 100 次 → 第 101 次返 false；callerId="B" 同时仍可调；setCap("A", 0) → 立即 false | 跨 caller 隔离 |

### 5.4 CI vs 手测

| 类别 | CI（必跑） | 手测（macOS + codesign + 真实环境） |
|---|---|---|
| 单元 + 不变量 | INV-35..40 + 单元 44 用例 | — |
| 集成 | disable/browse_cloud + hot-plug brave2 + caller cap + desktop provider disable | — |
| doctor runtime_state section | mock bag + callerTier snapshot | 真实运行 MCP server，admin disable 1 channel 后跑 `lasso doctor` 看是否反映 |
| sendToolListChanged CC 端可见性 | — | 用真实 CC（或 mock MCP client）连上，disable 后看 CC 工具列表是否刷新 |
| SIGHUP | 进程内模拟信号 | 真实 `kill -HUP` 触发 |
| 子进程 kill 真实性 | mock _kill 调用 | 真实 chrome-devtools-mcp 子进程 + ps 验证 |

---

## 6. 验收标准（引用 09 §2.7 + 细化）

### 6.1 09 §2.7 原始验收

> **v0.6 能力主题**：运行时加减通道。
> **验收标志**：热插拔 + caller-tier cap + ToS 标记。

### 6.2 细化验收（CI / 手测分类）

**CI（必跑，绿）**：
- [ ] **INV-1..40 全部 PASS**（v0.5 的 34 条 + v0.6 新增 6 条）
- [ ] **TS 测试总数**：967（v0.5）+ ~44（v0.6 单元）+ ~6（v0.6 集成）= ~1017，全绿
- [ ] **启停 1 通道 ≤2s**（CI: mock subprocess kill，measure wall time from admin call to sendToolListChanged emitted）
- [ ] **disable channel 后 tools/list 不含其 tool**（CI: spawn real MCP server, send listTools before/after disable）
- [ ] **热插拔新 provider 后下次调用可用**（CI: registry.add({name:"brave2"...}), bag.enable, search engine="brave2" 不返 unknown）
- [ ] **caller A 超额时 caller B 仍 served**（CI: tracker.tryAcquire 跨 caller 隔离断言）
- [ ] **PolicyGate tos_ack="violated" 阻断路径与 acquired 同效**（CI: check() 单元）
- [ ] **provider 级 disable 不 kill shared subprocess**（CI: disable desktop.cgEvent → rust-helper healthProbe 仍 healthy）
- [ ] **index.ts 静态装配段字节级零变化**（CI: git diff 不动 v0.5 静态段，只允许尾部新增 v0.6 接线段）
- [ ] ** CapabilityBag 默认全开**（CI: 初始化后 bag.snapshot() 全部 enabled=true）

**手测（macOS + 真实环境，文档化）**：
- [ ] **CC（Claude Code）连接 Lasso MCP server，disable browse_headless 后 CC 工具列表自动刷新**（验证 sendToolListChanged 在 stdio transport 真的被客户端消费）
- [ ] **真实 chrome-devtools-mcp 子进程**：admin disable browse_headless → `ps aux | grep chrome-devtools-mcp` 看子进程是否退出；admin enable → 下次调用时懒启动
- [ ] **真实 rust-helper**：admin disable desktop 全 4 档 → ps 看 rust-helper 退出；disable 单档（如 cgEvent）→ rust-helper 仍 alive
- [ ] **SIGHUP 热更新**：写 `~/.config/lasso/providers.json`（含新 brave2 entry）→ `kill -HUP $(pgrep lasso-mcp)` → admin capability_list 见 brave2 enabled
- [ ] **doctor runtime_state section**：admin disable 1 channel + 1 caller setCap=0 → `lasso doctor` 输出含 `runtime_state: { disabled: [...], caller_caps: [...] }`
- [ ] **audit log**：admin disable 触发后 `~/Library/logs/lasso/audit.log` 新增一行 JSONL（含 callerId / reason / timestamp / capability_name）

### 6.3 退出标准（v0.6 tag 候选条件）

1. CI 全绿（INV-40 条 + ~1017 测试）。
2. 手测 6 条全过（CC 真实刷新 + 真实子进程 + SIGHUP + doctor + audit log）。
3. 性能：disable 操作 wall time p95 ≤ 500ms（CI mock），真实环境（含子进程 SIGTERM）p95 ≤ 2s。
4. 文档：README 加 "Runtime capability management" 章节；doctor help 加 runtime_state 说明。

---

## 7. 风险 + 实施顺序

### 7.1 风险 Register（v0.6 专属，叠加 09 §6 R1..R12 + 13 D1..D10）

| ID | 风险 | 影响 | 概率 | 缓解 | 触发预警 |
|---|---|---|---|---|---|
| **R-RT-1** | **disable channel 时子进程未清理干净（zombie）** | 中（资源泄漏） | 中 | SubprocessManager.shutdownOne 复用既有 `_kill` 幂等 + zombie reaper 兜底；集成测断言 ps 不见 zombie | ps 命中残留子进程 |
| **R-RT-2** | **desktop shared subprocess 误杀**（disable desktop.cgEvent 却 kill 了 rust-helper） | 高（desktop 整体不可用） | 中 | CapabilityBag 联动 handler 显式检查 `bag.snapshot().filter(desktop.*).every(disabled)` 才 kill；INV-37 衍生断言；集成测覆盖此场景 | desktop.ax 调用突然 fail |
| **R-RT-3** | **sendToolListChanged CC 客户端不刷新**（CC stdio transport 是否真消费 notification） | 中（disable 后 CC 仍列该 tool，调用报 unknown） | 中 | M0.6b 早期手测验证；fallback 方案：admin 返回里含 "please re-list tools" 提示 | CC 调用 disabled tool 报错 |
| **R-RT-4** | **CapabilityBag 与 ProviderConfig.enabled 语义混淆**（静态 enabled=false vs 运行时 disable） | 低（设计已隔离） | 低 | 文档化：ProviderConfig.enabled 是构造期 schema 字段（启始是否注册），CapabilityBag 是运行时状态（只能 enable/disable 已注册的）；INV-40 断言 | 代码 review |
| **R-RT-5** | **caller-tier cap 误伤 CC 主流程**（CC 不传 callerId 全部算 "anonymous"，共享 100/分钟可能不够） | 中（search 莫名 didnt） | 中 | defaultCap=100 实测后校准；env `LASSO_CALLER_CAP_DEFAULT` 可调；callerId="anonymous" 超额时 retrieval_method="caller_cap_exceeded" 透明（CC 可见） | search 大量 didnt |
| **R-RT-6** | **热插拔配置 JSON 格式错**（用户手写 providers.json 不规范） | 低（admin tool 输入校验） | 中 | applyHotReload try/catch + log error 不崩；admin provider_add 用 zod schema 校验 | hot_reload_error log 频发 |
| **R-RT-7** | **disable 后 in-flight 请求未结算**（disable 时正有 search 在跑，结果丢失） | 中（CC 见 dont + 无 error） | 中 | disable 不取消 in-flight（让它们完成或超时）；admin 返回 `{pending: <count>, disabled_at: <ts>}` 提示 | CC 调用 hang |
| **R-RT-8** | **admin tool 被 LLM 误调**（CC 看到 destructiveHint 仍调） | 高（误关通道） | 低 | ToolAnnotations `destructiveHint: true` + 描述明确 "ONLY when user explicitly asks"；audit log 留痕可追溯；admin capability_disable 必须传 reason 字段（强制思考） | audit log 频繁 |
| **R-RT-9** | **caller-tier 与 v0.2 QuotaLedger / v0.3 RpmLimiter 语义重叠**（三套 limiter） | 中（R-CI-02 第二套做法红线） | 中 | INV-38 强制 CallerTierTracker 复用 QuotaLedger 范式；明确：QuotaLedger 是 per-key 月配额，RpmLimiter 是 per-provider 滑动窗，CallerTierTracker 是 per-caller 滑动窗 —— 三者作用域正交，文档化 | 简单性审查 R-CI-02 命中 |
| **R-RT-10** | **channel disable 后 fallback 链含该 channel**（FallbackDecider 仍 try） | 中（每次 fallback 浪费一次 try） | 中 | FallbackDecider 已有 breaker.allow() 路径；disable 时同步标 breaker.open（force open）；或在 channel executor 入口处 `if (!bag.isEnabled(name)) return {outcome:"didnt", retrieval_method:"capability_disabled"}` | fallback_exhausted 频发 |

### 7.2 实施顺序（分 3 个子里程碑）

**M0.6a — 骨架 + 静态守门（1 周内）**

目标：ToolManager 落地，admin tool 暴露 capability_list / tool_list（只读）+ 句柄捕获 v0.5 既有 13 工具。

- [ ] 新建 `runtime/runtime-types.ts`（70 行）
- [ ] 新建 `runtime/ToolManager.ts`（210 行）
- [ ] 新建 `tools/admin.ts`（先实装 capability_list + tool_list 两个 action，~120 行）
- [ ] index.ts 接线：捕获 v0.5 `server.tool(...)` 返回的 13 个 RegisteredTool 句柄塞进 ToolManager
- [ ] INV-35 / INV-36 上线
- [ ] 单元测 ToolManager（~12 用例）

**验收**：CI 全绿（v0.5 测试 + 新增 ToolManager 测试）；admin capability_list 返回 v0.5 全部 tool；行为字节级等价 v0.5（捕获句柄是非破坏性的）。

**Go/No-Go**：若 SDK RegisteredTool.disable() 在 stdio transport 真触发 sendToolListChanged → 继续 M0.6b；否则评估 fallback（如 admin 返回里加 "listTools changed, please refresh" 提示）。这是 R-RT-3 的实证点。

---

**M0.6b — CapabilityBag + 通道级启停（1.5 周）**

目标：channel 级 enable/disable 联动 toolManager + subproc.shutdownOne。

- [ ] 新建 `runtime/CapabilityBag.ts`（180 行）
- [ ] SubprocessManager 加 `shutdownOne(name)` 方法（35 行）
- [ ] index.ts 顶级常量 `CHANNEL_TO_SPEC` 映射（channel 名 → subprocess spec name；cloud/d shared 标注）
- [ ] bag.onChange handler 联动 toolManager.disableChannel + subproc.shutdownOne（~40 行）
- [ ] admin tool 扩展 capability_disable / capability_enable action（+60 行）
- [ ] DesktopChannel 内部 fallback plan executor 入口加 `bag.isEnabled` gate（~15 行）
- [ ] INV-37 / INV-40 上线
- [ ] 单元测 CapabilityBag（~14 用例）+ 集成测 disable channel（~180 行）

**验收**：CI 全绿；admin disable browse_headless → listTools 不含 + subproc healthProbe=down + fallback 链跳过；admin enable 恢复。

**风险升级触发**：若 desktop shared subprocess 联动出错（误杀 rust-helper）→ R-RT-2 升级，暂停 M0.6c，补集成测覆盖。

---

**M0.6c — 热插拔 + caller-tier cap + ToS 标记（1.5 周）**

目标：热插拔完整链路 + per-caller 配额 + ToS 元数据。

- [ ] ProviderRegistry 加 `add` / `remove` 方法（60 行）
- [ ] 新建 `runtime/CallerTierTracker.ts`（140 行）
- [ ] 新建 `runtime/hot-reload.ts`（90 行）
- [ ] types.ts 加 `tos_url` / `tos_ack` 可选字段（8 行）
- [ ] PolicyGate.check 扩展 `tos_ack="violated"` 阻断（15 行）
- [ ] doctor 加 `runtime_state` section（40 行）+ `tos_ack_status` check（已计）
- [ ] admin tool 扩展 provider_add / provider_remove / provider_set_tos / caller_cap_set / caller_cap_list（+140 行）
- [ ] search.ts / browse.ts handler 入口加 CallerTierTracker.tryAcquire gate（~30 行）
- [ ] INV-38 / INV-39 上线
- [ ] 单元测 CallerTierTracker（~10 用例）+ hot-reload（~8 用例）+ 集成测 hot-plug + caller cap（~330 行）
- [ ] SIGHUP 安装（index.ts 装配尾部，~10 行）

**验收**：CI 全绿（~1017 测试）；手测 6 条全过；09 §2.7 验收标志「热插拔 + caller-tier cap + ToS 标记」三项全达成。

**v0.6 tag 候选**：M0.6c 通过 + 文档更新 + npm 0.6.0-dev → 0.6.0。

### 7.3 与既有排期的关系

- v0.6 与 v0.7（长熔断 + SERP 改版检测）**可并行**（09 §5）。
- v0.6 不依赖 v0.7 任何前置；v0.7 doctor CLI 完整化会消费 v0.6 `runtime_state` section。
- v0.6 不影响 v0.8（登录态持久化）；但 caller-tier cap 的持久化（若做）会延后到 v0.8 cookie export 同期。

### 7.4 简单性自检（02 清单四刻度）

| 刻度 | 评分 | 证据 |
|---|---|---|
| **交织度（Hickey）** | 🟢 守住 | CapabilityBag 无 channel internal 字段；runtime/ 不 import BrowseChannel/DesktopChannel（类比 INV-26 forest）；UiAction union 不动 |
| **模块深度（Ousterhout）** | 🟢 守住 | CapabilityBag 4 个公开方法（enable/disable/isEnabled/onChange，<7 上限）；ToolManager 5 个方法；CallerTierTracker 3 个方法；AXAPI/CDP 细节仍隐藏在 channel 内 |
| **变更放大率（Ousterhout）** | 🟢 守住 | 加新 channel：index.ts 装配段 + CapabilityBag 初始列表 + CHANNEL_TO_SPEC 映射 = 3 处（≤5 阈值）；加新 admin action：admin.ts switch + runtime-types = 2 处 |
| **概念完整性（Brooks）** | 🟢 守住 | 同一 fallback 范式（FallbackDecider 不动）；同一 policy gate（PolicyGate 复用）；同一配额范式（CallerTierTracker 复用 QuotaLedger `_refreshState`）；同一 audit log 范式（desktop 已有）；同一 ToolAnnotations 风格（admin destructiveHint=true） |

**R-CI-02 红线**：CallerTierTracker 复用 QuotaLedger 范式（INV-38）；ToS 复用 PolicyGate（INV-39）；不新造第二套 fallback / 第二套 policy / 第二套 rate limiter。

---

## 总结：v0.6 守住简单性的三个关键决策

1. **CapabilityBag 与 ProviderConfig.enabled 正交**：enabled 是构造期 schema 字段（启始是否注册），bag 是运行时状态（只能 enable/disable 已注册的）—— 不混两套语义。
2. **ToolManager 不重写 SDK 注册逻辑**：RegisteredTool.disable/enable/remove 是 SDK 2025-03-26 协议自带能力，ToolManager 只保存句柄 + 维护反向映射 —— 零侵入跟随上游。
3. **caller-tier cap / ToS / 热插拔全部复用既有范式**：QuotaLedger 滑动窗 / PolicyGate 三态 / SubprocessManager lifecycle —— 不开第二套做法（R-CI-02）。

风险诚实标注：R-RT-2（desktop shared subprocess 误杀）是最大执行风险，M0.6b 集成测必须覆盖；R-RT-3（sendToolListChanged CC 端刷新）是 M0.6a Go/No-Go 关键点，早期手测验证。两者都有明确缓解路径（联动检查 + admin 返回提示）。

---

**相关文档路径**（绝对）：
- 主排期：`/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.7
- 主架构：`/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md` §2.2 / §3.6 / §4
- 重设计：`/Users/wangdong/Documents/Project/cc-control-all/doc/13-全交互抓手重设计.md`
- v0.5 装配基线：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/index.ts`
- 不变量脚本：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs`
- 简单性清单：`/Users/wangdong/Documents/Project/架构想法/02_简单检查清单.md`
- 待新建（parse7 落盘建议）：`/Users/wangdong/Documents/Project/cc-control-all/doc/parse/parse7-v0.6-动态启停.md`