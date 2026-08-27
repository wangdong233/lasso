# Lasso v0.4 文件/函数级执行计划（parse5）—— 云浏览器 + multi-root forest 统一 + 反检测

> 增量于 v0.3.5（645 TS tests + 23 invariants + 47 Rust tests），落地 09 §2.5 + 08 §3.10/§3.11/§3.12 的 v0.4 范围。本文档是开发者「照着干」手册：每个文件、函数、签名都钉死，开发者（一人 Rust/Tauri 背景）无需再做架构决策。
>
> 权威源（绝对路径）：
> - 排期：`/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.5
> - 架构：`/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md` §2（forest @pN/@wN）/§3.4（F3.4.6 政策 gate）/§3.10（F3.11 interact_roots）/§3.11（F3.12 browse_cloud）
> - 全交互重设计：`/Users/wangdong/Documents/Project/cc-control-all/doc/13-全交互抓手重设计.md` §3（forest 统一抽象）+ §2.3（4-tier fallback 含 appleScript/cgEvent）
> - 生态借鉴：`/Users/wangdong/Documents/Project/cc-control-all/doc/12-pi-computer-use及生态深度分析.md` §1.2(F)（injaneity storeWindowRef/storeBrowserRootRef）+ §2.1（pi-web-access stealth 类比 + Argus manual-switch）+ §3.1（verify delivery 类比）
> - 现状代码：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/` + `lasso/rust-helper/`

---

## 1. v0.4 目标与范围（v0.3.5 增量）

### 1.1 能力目标（一句话）

CC 通过 Lasso 这唯一一个 MCP，**用一个入口枚举所有可控的"UI 根"**（浏览页 `@pN` + 桌面窗口 `@wN` 统一列表），并对**强反爬站点**用云浏览器 + stealth 通关；macOS 桌面 4-tier fallback 补全 appleScript + cgEvent 两档；所有云/付费通道必经政策风险 gate 显式 opt-in。

### 1.2 范围矩阵（做/不做）

| 维度 | v0.4 做 | v0.4 不做（推迟版本） |
|---|---|---|
| **Forest 入口** | `interact_roots()` 返回 `@pN` + `@wN` 统一列表 + 共享 `nextRootRefIndex`（identity→ref 复用 map） | ResourceScheduler + epoch 串行（v0.5+）；compact diff（v0.6+ 或 NO-GO） |
| **Observe/Act 统一** | `interact_observe(rootRef, ...)` / `interact_act(rootRef, ...)` 按 rootRef 前缀 dispatch 到 BrowseChannel/DesktopChannel（调度层薄包装，不渗入 channel 内部） | 合并 BrowseChannel/DesktopChannel 类（R-CI-02 永不合并，兄弟不是父子） |
| **browse_cloud 通道** | browserbase（CDP-over-ws 直连，反爬站点通关）+ stagehand（AI-friendly verify/extract，仅接 `verify`/`extract` 两个 AI 原语，不接 act） | browserbase 2FA 自动解（60% 失败前车之鉴，明确边界）；stagehand agent loop（越界） |
| **stealth 反检测** | CDP evaluate 注入（user-agent / navigator.webdriver / viewport / timezone 抖动）+ Cloudflare challenge 页 wait-for-human 检测 + 升级 manual-switch | 自建 captcha 求解服务（NO-GO，违反 12 §5.4 反爬军备竞赛边界） |
| **政策风险 gate** | provider `policy_risk=safe/acquired/watched` 三态 + cloud 浏览器通道必经 `LASSO_ALLOW_CLOUD_BROWSER=true` manual-switch + Tavily 接入条件性（credits 监控 + quota 账本） | 自动判断 ToS 合规（永远是 doctor warn + manual-switch，不替用户做法律判断） |
| **desktop 4-tier 补** | appleScript（Electron app 吞 AXSetValue 时降级；typed action enum + 脚本白名单）+ cgEvent（core-graphics crate CGEvent FFI；hotkey/press 路径） | recipe_run / process_run / fs_*（08 §7.1 明确 NO-GO）；Swift helper（F3.10.13 永不做） |
| **跨 surface fallback** | 仍严格禁止（INV-23 守住）；forest 是**调度层**，BrowseChannel/DesktopChannel 内部互不感知 | browse 失败 fallback 到 desktop（永远不，参数蔓延红线） |

### 1.3 v0.4 内部子里程碑（不单独发版，参照 13 §2.2 分段范式）

- **M0.4a Forest 调度层 + 政策 gate（无新通道）**：`interact_roots()` / `interact_observe(rootRef)` / `interact_act(rootRef)` 薄包装 + RootRegistry + 政策 gate + 新 INV-24..26；零回归 v0.3.5。**Go/No-Go 点**：若 forest 调度层强迫 BrowseChannel/DesktopChannel 加 surface 字段 → 暂停，回 13 §3.2 重审抽象（参照 D1/D4 缓解路径）。
- **M0.4b appleScript + cgEvent 档（解 INV-22 占位）**：Rust helper 加 osakit + core-graphics FFI；AppleScriptProvider + CGEventProvider 类 + 脚本白名单；DesktopChannel.act 的 plan 补两档；INV-22 解除，新增 INV-27..29（注入防御）。
- **M0.4c browse_cloud + stealth**：BrowserbaseChannel + StealthEngine + 政策 gate 接线；cloud 浏览器通道仅在 `LASSO_ALLOW_CLOUD_BROWSER=true` 时注册；Cloudflare 类反爬站点通关验收。

### 1.4 守住的 v0.3.5 不变量（零回归承诺）

- v0.3.5 的 **645 TS tests + 47 Rust tests** 全绿（新增测试加在新文件，**不动**现有测试）
- 既有 **INV-1..23** 全部保持绿（INV-22 占位解除 → 改写为「appleScript provider 必须 typed action enum + 白名单」语义；旧占位 ID 不复用但编号不挪）
- 新增 **INV-24..29**（forest ref 命名空间 / 政策 gate / appleScript 注入 / cgEvent 边界 / cloud 浏览器 manual-switch / 调度层不渗 channel 内部），共 **29 条 invariants**
- v0.3.5 parse4-acceptance.md 的 13 条 TCC/codesign 手测 pending 不砍，承接进 v0.4 手测清单

---

## 2. 文件结构（lasso/src/ TS 层 + lasso/rust-helper/ Rust 层）

### 2.1 新增/修改 TS 文件（lasso/src/）

```
src/
├── types.ts                              [修改] 加 RootRef / RootKind / InteractTask 类型（dormant 字段转实装）
├── forest/                               [NEW 目录 — forest 调度层，与 channels/ 平级]
│   ├── RootRegistry.ts                   [NEW] @pN/@wN ref 分配 + identity→ref 复用 map（借鉴 injaneity storeWindowRef）
│   ├── InteractDispatcher.ts             [NEW] 按 rootRef 前缀 dispatch 到 BrowseChannel/DesktopChannel（薄包装）
│   ├── forest-types.ts                   [NEW] RootInfo / InteractTask / RootRef 联合类型（无平台字面量，INV-21 衍生）
│   └── README.md                         [NEW] forest 是调度层不是新 channel（R-CI-02 守护说明）
├── channels/
│   ├── BrowseChannel.ts                  [不动] forest 调度层经 dispatcher 调它，不改内部
│   ├── DesktopChannel.ts                 [修改] act plan 加 appleScript/cgEvent 两档 fallback（INV-22 解除）
│   ├── BrowserbaseChannel.ts             [NEW] extends BrowseChannel，复用 actionDispatch + StepEngine；getMcpClient() 走 CDP-over-ws
│   └── StagehandChannel.ts               [NEW] extends UiChannel，仅 observe(verify/extract) 不 act（AI-friendly 路径）
├── desktop/
│   ├── AppleScriptProvider.ts            [NEW] class AppleScriptProvider（typed action enum + 脚本白名单，INV-22 解除）
│   ├── CGEventProvider.ts                [NEW] class CGEventProvider（hotkey/press 路径；1-5ms 单动作）
│   ├── apple-script-whitelist.ts         [NEW] 顶级 const，预定义脚本表（Finder/Mail/Safari 等 typed action → OSAKit 调用模板）
│   └── desktop-types.ts                  [修改] DesktopOptions 加 appleScriptAction/cgEventKey 白名单字段
├── browse/
│   ├── StealthEngine.ts                  [NEW] user-agent/viewport/timezone/navigator.webdriver 抖动 + Cloudflare 检测
│   ├── stealth-profiles.ts               [NEW] 顶级 const，预定义 stealth 配置表（windows Chrome / mac Safari 等 profile）
│   └── ExpectPoll.ts                     [不动] stealth 复用 expect 检测 Cloudflare challenge 消失
├── fallback/
│   ├── PolicyGate.ts                     [NEW] provider policy_risk + manual-switch 检查（cloud 浏览器必经）
│   └── FallbackDecider.ts                [修改] runWithFallback 前置 PolicyGate.check（unknown + policy_blocked → 终止链）
├── config/
│   ├── providers.ts                      [修改] 加 BROWSERBASE + STAGEHAND + TAVILY（条件性 enabled）4 条 ProviderConfig
│   └── provider-registry.ts              [修改] get() 加 policy_risk 过滤参数（policy_risk=acquired + 无 manual-switch → 返 undefined）
├── tools/
│   ├── interact.ts                       [NEW] registerInteractTools（interact_roots / interact_observe / interact_act 3 工具）
│   ├── browserbase.ts                    [NEW] registerBrowserbaseTool（cloud 浏览器；仅在 LASSO_ALLOW_CLOUD_BROWSER=true 时注册）
│   ├── annotations.ts                    [修改] 加 interactAnnotations + browserbaseAnnotations
│   └── descriptions.ts                   [修改] 加 INTERACT_ROOTS_DESCRIPTION / BROWSERBASE_DESCRIPTION
├── doctor/
│   └── doctor.ts                         [修改] 加 #21-#24 项 check（browserbase key 可达 / stagehand key 可达 / cloud 浏览器 manual-switch 状态 / stealth profile 自检）
├── invariants/
│   └── check-invariants.mjs              [修改] 改写 INV-22（解占位）+ 新增 INV-24..29（6 条 v0.4 invariants）
└── index.ts                              [修改] 装配 RootRegistry + InteractDispatcher + 3 新 channel + 4 新 tool（条件注册 browserbase）
```

### 2.2 新增/修改 Rust 文件（lasso/rust-helper/）

```
rust-helper/
├── Cargo.toml                            [修改] 加 osakit + core-graphics（完整版，含 CGEvent FFI）crate
├── src/
│   ├── main.rs                           [修改] dispatch 加 "applescript_run" / "cgevent_key" / "cgevent_hotkey" / "list_windows" method
│   ├── protocol.rs                       [修改] Request.method 字符串扩 5 个；error_kind 加 "script_not_in_whitelist" / "cgevent_unknown_key"
│   ├── ax.rs                             [修改] snapshot 可选返回 windowId（forest rootRef 身份用）
│   ├── applescript.rs                    [NEW] osakit crate 调 AppleScript；白名单 manifest 嵌入二进制（INV-27）
│   ├── applescript_whitelist.rs          [NEW] 顶级 const，action_name → 预编译脚本的 manifest（编译期注入，运行时不可改）
│   ├── cgevent.rs                        [NEW] core-graphics CGEvent FFI；press / hotkey 两条路径
│   ├── cgevent_keymap.rs                 [NEW] 逻辑键名（"Return"/"Tab"/"cmd+c"）→ CGKeyCode 映射表
│   └── windows.rs                        [NEW] list_windows —— 枚举当前所有 AX window（forest interact_roots 数据源）
├── build/
│   └── sign.sh                           [不动] v0.3.5 已就绪
└── tests/
    ├── applescript_whitelist.rs          [NEW] 白名单 manifest 单测（typed action 不在白名单 → 拒绝）
    ├── cgevent_keymap.rs                 [NEW] 逻辑键名 → CGKeyCode 全覆盖单测
    └── windows_list.rs                   [NEW] mock AXUIElement 树，list_windows 返结构校验
```

### 2.3 文件依赖图（自顶向下，零回归可见）

```
index.ts
  ├─→ RootRegistry (new) ─── identity→ref map + nextRootRefIndex
  │     ├─→ BrowseChannel.listRoots() → CDP page context 列表 → @pN
  │     └─→ DesktopChannel.listRoots() → list_windows 调 rust → @wN
  ├─→ InteractDispatcher (new)
  │     ├─→ dispatch(rootRef): rootRef.startsWith("@p") → BrowseChannel
  │     │                                    .startsWith("@w") → DesktopChannel
  │     └─→ 校验 rootRef 在 RootRegistry 中存在（否则 didnt + stale_root_ref）
  ├─→ PolicyGate (new) ─── cloud 浏览器 manual-switch + provider policy_risk 过滤
  │     └─→ FallbackDecider 前置（unknown + policy_blocked → 终止链）
  ├─→ BrowserbaseChannel (new) ─── 仅在 LASSO_ALLOW_CLOUD_BROWSER=true 时实例化
  │     └─→ extends BrowseChannel（复用 actionDispatch + StepEngine，只换 getMcpClient）
  ├─→ StagehandChannel (new) ─── AI-friendly verify/extract 子集
  │     └─→ extends UiChannel（不 extends BrowseChannel，因不走 CDP）
  ├─→ AppleScriptProvider (new) + CGEventProvider (new)
  │     └─→ DesktopChannel.act plan 扩 4 档：ax → appleScript → cgEvent → screenshotVlm
  ├─→ StealthEngine (new)
  │     └─→ BrowserbaseChannel.injectStealth(profile) + HeadlessChannel.injectStealth
  └─→ registerInteractTools + registerBrowserbaseTool（条件注册）

invariants/check-invariants.mjs
  ├─→ INV-22 改写：appleScript provider 必须 typed action enum（grep "raw_script" / "eval" 入参字面量）
  ├─→ INV-24 RootRegistry 单一真源（class RootRegistry ≤1）
  ├─→ INV-25 cloud 浏览器通道必经 manual-switch（grep LASSO_ALLOW_CLOUD_BROWSER + ProviderConfig.policy_risk）
  ├─→ INV-26 InteractDispatcher 不 import BrowseChannel/DesktopChannel 的 internal 模块（仅 import class）
  ├─→ INV-27 apple-script-whitelist.ts 顶级 const（不从 config/env 读，anti-gaming，类比 INV-14）
  ├─→ INV-28 CGEventProvider 不暴露 raw keycode 入参（typed logical key name only）
  └─→ INV-29 forest 调度层不出现 AXUIElement/CGEvent/MCP frameId 平台字面量（INV-21 衍生）
```

---

## 3. 各模块实施细节（接口签名 + 伪码 + 借鉴源 + 行数估算）

### 3.1 interact_roots 统一入口（forest 调度层）

#### 3.1.1 forest-types.ts（纯类型，~80 行）

```typescript
/**
 * Forest 调度层共享类型（parse5 §3.1）
 *
 * 铁律（R-CI-02 衍生）：本文件不 import BrowseChannel / DesktopChannel，
 *                       只定义抽象数据。channel 在 InteractDispatcher 装配时注入。
 *
 * INV-19 衍生：RootInfo 不携带 channel 实例引用，只有 channelKind 标签。
 * INV-29：本文件无 AXUIElement / CGEvent / MCP frameId 平台字面量。
 *
 * 借鉴：12 §1.2(F) injaneity state.ts storeWindowRef/storeBrowserRootRef 的
 *       identity→ref 复用 map 模式；13 §3.2 OutlineNode 同形异源。
 */

/** Root 唯一短指针。@pN=browse page，@wN=desktop window。 */
export type RootRef = string; // 形如 "@p0" / "@w3"

/** Root 来源（仅描述，不参与路由；13 §2.4 dataModel 同范式）。 */
export type RootKind = "browser_page" | "window";

/**
 * Root 身份（用于 identity→ref 复用 map；12 §1.2(F)）
 *  - browser_page : sha1(cdpContextId | url)
 *  - window       : sha1(bundleId | pid | windowId)
 */
export interface RootIdentity {
  kind: RootKind;
  /** 稳定身份哈希（同一 url 重开 → 同 @pN；同一 window 重 query → 同 @wN） */
  identity: string;
}

/** 单个 Root 的元信息（interact_roots 返回给 model） */
export interface RootInfo {
  rootRef: RootRef;
  kind: RootKind;
  /** browser_page: url + title；window: app + pid + windowId */
  title: string;
  subtitle?: string;
  /** 来自 ProviderConfig.name（"browse_headless" / "browse_logged_in" / "browse_cloud_browserbase" / "desktop"） */
  source: string;
}

/** InteractTask（按 rootRef dispatch 的最小任务单元） */
export interface InteractTask {
  rootRef: RootRef;
  action: string;           // "snapshot" / "find" / "click" / ...（与各 channel 共享 action 词汇）
  options: Record<string, unknown>;
  expect?: import("../types.js").ExpectCondition;
}

/** interact_observe / interact_act 返回的统一信封（复用 InteractResult） */
export type InteractEnvelope<T = unknown> = import("../types.js").InteractResult<T>;
```

#### 3.1.2 RootRegistry.ts（identity→ref 复用 map，~120 行）

```typescript
/**
 * RootRegistry（parse5 §3.1，借鉴 12 §1.2(F) injaneity state.ts）
 *
 *  - 持有 nextRootRefIndex 单调计数器（@p/@w 前缀**共享**一个计数器，但前缀让 model 能区分）
 *  - identity → rootRef 双向 map：同 identity 二次查询 → 复用 ref（避免重开 tab / 重抓 window 树）
 *  - rootRef → RootInfo 反查 map：model 拿 ref 后 dispatcher 校验存在性
 *
 * 关键设计选择（与 injaneity 的差异）：
 *  - injaneity 用单 @r 前缀（不区分 surface）；Lasso 用 @p/@w 双前缀（model 可路由提示）
 *  - Lasso **共享 nextRootRefIndex**（不分裂成 nextPageRefIndex + nextWindowRefIndex）—— 这是 13 §3.3
 *    的"v0.4+ 才实现 pi 的共享计数器模式"承诺；v0.3.5 双前缀各管各的，v0.4 起统一
 *  - identity 哈希在 channel 内计算（BrowseChannel 计算 cdpContextId|url；DesktopChannel 计算
 *    bundleId|pid|windowId），RootRegistry 只负责 identity 去重——抽象层不渗 channel 内部
 *
 * INV-24：RootRegistry 类单一真源（grep `class RootRegistry` 全项目 ≤1）。
 */
export class RootRegistry {
  private nextRootRefIndex = 0;
  private readonly identityToRef = new Map<string, RootRef>();
  private readonly refToInfo = new Map<RootRef, RootInfo>();

  /**
   * 注册或复用一个 Root。
   *  - identity 已存在 → 返回既有 rootRef（不分配新计数器）
   *  - identity 不存在 → 按 kind 选前缀（@p / @w），分配 nextRootRefIndex++
   *
   * @param ident 身份哈希（channel 自己算好）
   * @param factory 若需新建 ref，调 factory(kind, newRef) → RootInfo
   */
  async getOrCreate(
    ident: RootIdentity,
    factory: (kind: RootKind, newRef: RootRef) => RootInfo,
  ): Promise<RootRef> {
    const existing = this.identityToRef.get(ident.identity);
    if (existing) return existing;

    const prefix = ident.kind === "browser_page" ? "@p" : "@w";
    const newRef: RootRef = `${prefix}${this.nextRootRefIndex++}`;
    const info = factory(ident.kind, newRef);
    this.identityToRef.set(ident.identity, newRef);
    this.refToInfo.set(newRef, info);
    return newRef;
  }

  lookup(ref: RootRef): RootInfo | undefined {
    return this.refToInfo.get(ref);
  }

  /** interact_roots() 数据源：按 kind 过滤 + 排序（page 在前 window 在后，便于 model 阅读）。 */
  list(filter?: { kind?: RootKind }): RootInfo[] {
    const all = [...this.refToInfo.values()];
    if (filter?.kind) return all.filter((r) => r.kind === filter.kind);
    return all.sort((a, b) => {
      // @pN 在前 @wN 在后；同前缀按 N 升序
      const aIdx = parseInt(a.rootRef.slice(2), 10);
      const bIdx = parseInt(b.rootRef.slice(2), 10);
      const aKind = a.rootRef.startsWith("@p") ? 0 : 1;
      const bKind = b.rootRef.startsWith("@p") ? 0 : 1;
      return aKind - bKind || aIdx - bIdx;
    });
  }

  /** LRU 淘汰（容量 256，与 StateStore LRU(128) 量级一致；过期 ref cleanly fail）。 */
  evictStale(maxAge = 30 * 60_000): void { /* 参考 StateStore.evict 范式 */ }
}
```

**行数估算**：forest-types.ts ~80 行 + RootRegistry.ts ~120 行 + InteractDispatcher.ts ~140 行 = **~340 行**。

#### 3.1.3 InteractDispatcher.ts（按前缀 dispatch，~140 行）

```typescript
/**
 * InteractDispatcher（parse5 §3.1）—— forest 调度层核心。
 *
 * 铁律（13 §2.4 R-CI-02 衍生）：
 *  - 本类只 import BrowseChannel / DesktopChannel 的 class，**不 import 它们的 internal 模块**
 *    （grep 断言 INV-26：禁 import "../browse/StepEngine.js" / "../desktop/AxProvider.js"）
 *  - 调度按 rootRef 前缀（@p / @w），**不**按 channel type switch
 *  - BrowseChannel/DesktopChannel 互相不感知（forest 是它们之上的薄包装，不渗入它们内部）
 *
 * 借鉴：13 §3.3 v0.4+ interact_roots 落地图；12 §1.2(F) injaneity dispatchUiAction。
 */
import type { BrowseChannel } from "../channels/BrowseChannel.js";
import type { DesktopChannel } from "../channels/DesktopChannel.js";
import type { InteractTask, InteractEnvelope, RootRef } from "./forest-types.js";
import type { RootRegistry } from "./RootRegistry.js";

export class InteractDispatcher {
  constructor(
    private readonly registry: RootRegistry,
    /** 按 source（ProviderConfig.name）索引 channel 实例 */
    private readonly channels: Map<string, BrowseChannel | DesktopChannel>,
  ) {}

  /**
   * 调度一个 InteractTask 到对应的 channel。
   * 1. 校验 rootRef 存在（否则 stale_root_ref）
   * 2. 找 RootInfo.source 对应 channel（否则 channel_unavailable）
   * 3. 按 channel 类型转译 action（browse/desktop action 词汇同构 86%，13 §3.1）
   * 4. 调 channel.browse(url, action, opts) 或 channel.observe/act
   */
  async dispatch(task: InteractTask): Promise<InteractEnvelope> {
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
    // 按 channel 类型转译（instanceof BrowseChannel 不算 internal 模块依赖，只算 class 接口）
    if (channel instanceof BrowseChannel) {
      // browse 系：调 channel.browse(url, action, options)
      // url 从 RootInfo.subtitle 取（browse 的 subtitle = url）
      return (channel as BrowseChannel).browse(
        info.subtitle ?? "about:blank",
        task.action,
        task.options,
      );
    }
    // desktop 系：调 channel.observe / act / wait
    const dc = channel as DesktopChannel;
    if (task.action === "snapshot" || task.action === "find") {
      return dc.observe(task.action, task.options);
    }
    if (task.action === "act") {
      return dc.act(task.options);
    }
    if (task.action === "wait") {
      return dc.wait(task.options);
    }
    return {
      outcome: "didnt",
      data: null,
      served_by: "interact_dispatcher",
      fallback_used: false,
      retrieval_method: "unknown_action",
      error: `action_not_in_union:${task.action}`,
    };
  }
}
```

#### 3.1.4 listRoots 装配（index.ts 加，~50 行）

```typescript
// index.ts 装配片段（parse5 §3.1.4）：
// 1. BrowseChannel 暴露 listRoots()：调 chrome-devtools-mcp 的 list_pages → 每页一个 RootInfo
// 2. DesktopChannel 暴露 listRoots()：调 rust.call("list_windows") → 每窗口一个 RootInfo
// 3. registry.getOrCreate 批量注册（identity 去重）

async function refreshRoots(registry: RootRegistry, channels: Map<string, unknown>): Promise<void> {
  for (const [source, ch] of channels) {
    if (ch instanceof BrowseChannel) {
      const pages = await ch.listRoots(); // [{contextId, url, title}, ...]
      for (const p of pages) {
        await registry.getOrCreate(
          { kind: "browser_page", identity: sha1(`${p.contextId}|${p.url}`) },
          (_kind, newRef) => ({
            rootRef: newRef, kind: "browser_page",
            title: p.title || p.url, subtitle: p.url, source,
          }),
        );
      }
    } else if (ch instanceof DesktopChannel) {
      const windows = await ch.listRoots(); // [{bundleId, pid, windowId, app, title}, ...]
      for (const w of windows) {
        await registry.getOrCreate(
          { kind: "window", identity: sha1(`${w.bundleId}|${w.pid}|${w.windowId}`) },
          (_kind, newRef) => ({
            rootRef: newRef, kind: "window",
            title: `${w.app}: ${w.title || "(no title)"}`, subtitle: undefined, source,
          }),
        );
      }
    }
  }
}
```

#### 3.1.5 interact.ts（3 个工具注册，~110 行）

```typescript
// tools/interact.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InteractDispatcher } from "../forest/InteractDispatcher.js";
import type { RootRegistry } from "../forest/RootRegistry.js";

export function registerInteractTools(
  server: McpServer,
  registry: RootRegistry,
  dispatcher: InteractDispatcher,
): void {
  server.tool(
    "interact_roots",
    INTERACT_ROOTS_DESCRIPTION,
    { kind: z.enum(["browser_page", "window"]).optional() },
    interactAnnotations,
    async (args) => {
      const roots = registry.list(args.kind ? { kind: args.kind } : undefined);
      return { content: [{ type: "text" as const, text: JSON.stringify({ roots, count: roots.length }, null, 2) }] };
    },
  );

  server.tool(
    "interact_observe",
    INTERACT_OBSERVE_DESCRIPTION,
    {
      root_ref: z.string().regex(/^@[pw]\d+$/),
      action: z.enum(["snapshot", "find"]),
      options: z.record(z.unknown()).default({}),
    },
    interactAnnotations,
    async (args) => {
      const r = await dispatcher.dispatch({
        rootRef: args.root_ref, action: args.action, options: args.options,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    "interact_act",
    INTERACT_ACT_DESCRIPTION,
    {
      root_ref: z.string().regex(/^@[pw]\d+$/),
      actions: z.array(z.union([
        z.object({ kind: z.literal("click"), ref: z.string() }),
        z.object({ kind: z.literal("type"), ref: z.string(), text: z.string() }),
        z.object({ kind: z.literal("press"), key: z.string() }),
        z.object({ kind: z.literal("scroll"), ref: z.string(), dx: z.number(), dy: z.number() }),
        z.object({ kind: z.literal("hotkey"), keys: z.array(z.string()) }),
      ])),
      expect: z.object({
        text: z.string().optional(),
        url_contains: z.string().optional(),
        gone: z.boolean().optional(),
        timeout_ms: z.number().int().positive().default(5000),
      }).optional(),
    },
    interactAnnotations,
    async (args) => {
      const r = await dispatcher.dispatch({
        rootRef: args.root_ref, action: "act",
        options: { actions: args.actions, expect: args.expect },
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
  );
}
```

#### 3.1.6 借鉴源小结（forest 调度层）

| 设计点 | 借鉴源 | 差异 |
|---|---|---|
| identity→ref 复用 map | 12 §1.2(F) injaneity `state.ts` `windowRefByIdentity` + `browserRootByContext` | Lasso 加 @p/@w 双前缀让 model 区分 surface（injaneity 单 @r） |
| 共享 nextRootRefIndex 计数器 | 12 §1.2(F) injaneity `@r{nextRootRefIndex++}` | Lasso v0.3.5 dormant，v0.4 实装（13 §3.3 承诺） |
| dispatchUiAction 双 dispatch path 单 UiAction union | 12 §1.2(F) injaneity + 13 §3.1 内联差异率 86% | Lasso dispatcher 不 import channel 内部模块（INV-26，比 injaneity 更严） |
| rootRef 形状 `@pN` / `@wN` | 13 §3.2 v0.4 目标态 | 13 §3.2 已锁前缀；v0.4 实装 |

### 3.2 browse_cloud 通道（browserbase + stagehand）

#### 3.2.1 选型与边界（先决）

| 维度 | browserbase（F3.12.1） | stagehand（F3.12.2） |
|---|---|---|
| 形态 | CDP-over-ws 直连云 Chrome（chrome-devtools-mcp 原生支持） | AI-friendly REST API（`verify(prompt)` / `extract(prompt, schema)`） |
| 复用 BrowseChannel？ | **是**（extends BrowseChannel；只换 getMcpClient 走 ws URL） | **否**（extends UiChannel；走自有 API，action 词汇与 browse 不同构） |
| 付费 | 是（按浏览器秒计费，~$0.10/h，参考 12 §2.1 Hyperbrowser 类比） | 是（按 token 计费 + LLM 调用费） |
| 政策 gate | 必经 `LASSO_ALLOW_CLOUD_BROWSER=true` + `BROWSERBASE_API_KEY` | 同上 + `STAGEHAND_API_KEY` |
| 不做 | 2FA 自动解（60% 失败前车之鉴，明确边界，08 §7.3） | agent loop（越界，13 §3.4 不做 Skyvern 风格 workflow engine） |
| Lasso 接入动作 | navigate / snapshot / click / fill（反爬站点主路径） | verify(prompt) / extract(prompt, schema) 两个 AI 原语（仅 observe） |

**结论**：browserbase 复用 BrowseChannel（最小侵入），stagehand 新 Channel 子类（R-CI-02 仍守，经同一 FallbackDecider 但不 extends BrowseChannel）。

#### 3.2.2 BrowserbaseChannel.ts（~100 行）

```typescript
/**
 * BrowserbaseChannel（parse5 §3.2，F3.12.1）
 *
 *  - extends BrowseChannel（复用 actionDispatch Map + StepEngine + runExpect）
 *  - 唯一差异：getMcpClient() 返回连 browserbase ws URL 的 McpClient
 *    （chrome-devtools-mcp --browser-url=wss://cdp.browserbase.com/...）
 *  - StealthEngine 在 navigate 前注入（参考 HeadlessChannel 的 doNavigate 包装）
 *
 * 不变量继承：
 *  - INV-2（extends BaseChannel 间接经 BrowseChannel）
 *  - INV-6（dispatch 走 Map，继承 actionDispatch）
 *  - INV-23（fallback 链不跨 surface，本通道 fallback 仅 browse_cloud.browserbase → browse_cloud.stagehand，禁入 desktop）
 *
 * 政策 gate：
 *  - 仅在 LASSO_ALLOW_CLOUD_BROWSER=true 时由 index.ts 实例化（未配则该 channel 不存在）
 *  - ProviderConfig.policy_risk="safe"（browserbase 无收购风险；但仍走付费 manual-switch）
 *  - FallbackDecider 在 plan 含 browse_cloud.* 时前置 PolicyGate.check
 *
 * 借鉴：12 §2.1 Hyperbrowser（云 Chrome $0.10/h 计费类比）；
 *       08 §3.11 browse_cloud 预留位；13 §2.3 4-tier fallback 同范式（cloud 是 fallback 链尾）。
 */
import { BrowseChannel } from "./BrowseChannel.js";
import type { McpClient } from "../subprocess/McpClient.js";
import type { SubprocessManager } from "../subprocess/SubprocessManager.js";
import { StealthEngine } from "../browse/StealthEngine.js";

export class BrowserbaseChannel extends BrowseChannel {
  readonly name = "browse_cloud_browserbase";

  constructor(
    private readonly subproc: SubprocessManager,
    private readonly wsUrl: string,        // wss://cdp.browserbase.com/...
    private readonly apiKey: string,       // BROWSERBASE_API_KEY
    private readonly stealth: StealthEngine,
  ) {
    super();
  }

  /**
   * 复用 BrowseChannel 路径：仅替换 McpClient 来源。
   * chrome-devtools-mcp --browser-url=$wsUrl 即可连 browserbase；subprocess 规格在 index.ts 装配。
   */
  protected async getMcpClient(): Promise<McpClient> {
    return this.subproc.acquireBrowserbaseClient(this.wsUrl, this.apiKey);
  }

  /**
   * 重写 doNavigate 包装：navigate 前 stealth.injectProfile(client)。
   * 注意：不重写整个 browse()，只 hook doNavigate（INV-6 dispatch Map 不动）。
   */
  protected async beforeNavigate(client: McpClient): Promise<void> {
    await this.stealth.injectProfile(client, "windows_chrome_120");
  }
}
```

**关键设计选择**：BrowserbaseChannel 不重写 `browse()`，只 hook `beforeNavigate`（注入 stealth）。**StealthEngine 是横切关注点**，BrowseChannel 提供 hook 点（v0.4 加 `protected beforeNavigate(): Promise<void>`），子类按需 override。HeadlessChannel 也可 override 注入基础 stealth（v0.4 同步落地 stealth 反检测）。

#### 3.2.3 StagehandChannel.ts（~80 行）

```typescript
/**
 * StagehandChannel（parse5 §3.2，F3.12.2）
 *
 *  - extends UiChannel（**不 extends BrowseChannel**，因不走 CDP）
 *  - 仅 expose observe(verify|extract)，**不 act**（agent loop 越界）
 *  - 走 stagehand REST API：POST /verify { prompt } → bool；POST /extract { prompt, schema } → JSON
 *
 * 用途：CC 在 browse_logged_in 走完多步后，调 stagehand.verify(prompt) 做语义验证（比
 *       chrome-devtools-mcp evaluate_script 写 JS 更自然），或 stagehand.extract(prompt, schema)
 *       抽结构化数据。
 *
 * 借鉴：12 §2.1.4 Stagehand `verify(prompt) → bool` + `extract(prompt, zod_schema) → VerificationResult`；
 *       12 §3.5.12 「verify(prompt) 作为 CC 友好 API 形状」（v0.3 评估项 → v0.4 实装）。
 *
 * INV-2：extends UiChannel 守护。
 * INV-23：stagehand 不在 desktop fallback plan，反向亦然。
 */
import { UiChannel } from "./UiChannel.js";

export class StagehandChannel extends UiChannel {
  readonly name = "browse_cloud_stagehand";

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {
    super();
  }

  async isAvailable(): Promise<boolean> { /* HEAD endpoint，3s 超时 */ }
  async status() { /* 同范式 */ }
  async healthCheck() { /* 同范式 */ }
  capabilities() {
    return { canObserve: true, canAct: false, observeLatencyMs: 5000, dataModel: "ai" as const };
  }

  /** observe 仅支持 verify / extract 两个 AI 原语；action 词汇与 browse 不同构（故不 extends BrowseChannel）。 */
  async observe(
    action: "verify" | "extract",
    opts: { prompt: string; schema?: Record<string, unknown> },
  ): Promise<InteractEnvelope<{ verified?: boolean; data?: unknown }>> {
    // POST endpoint/{action} with { prompt, schema? }
    // 200 + { verified: true } → outcome="worked"
    // 200 + { verified: false } → outcome="didnt"（明确"否"，不 fallback）
    // 5xx / 网络 → outcome="unknown"
  }
}
```

**行数估算**：BrowserbaseChannel ~100 行 + StagehandChannel ~80 行 + StealthEngine ~150 行 + stealth-profiles ~60 行 = **~390 行**。

### 3.3 stealth 反检测（CDP evaluate 注入 + user-agent 抖动）

#### 3.3.1 StealthEngine.ts（~150 行）

```typescript
/**
 * StealthEngine（parse5 §3.3，F3.2.12 反检测）
 *
 *  - injectProfile(client, profileName)：navigate 前注入 user-agent / viewport / timezone / navigator.webdriver
 *  - detectCloudflareChallenge(client)：识别 Cloudflare "Just a moment..." 页面
 *  - escalateManualSwitch：stealth 失败时升 manual-switch（不让 model 自动尝试绕过，借鉴 Argus）
 *
 * 借鉴：open-webSearch 的 stealth 脚本范式（CDP Network.setUserAgentOverride +
 *       Page.addScriptToEvaluateOnNewDocument 注入 webdriver=false 等）；
 *       Argus 的 manual-switch 政策 gate（stealth 失败不自动升级 captcha 求解）。
 *
 * 关键铁律：
 *  - stealth 注入只走 CDP methods（Network / Page domain），**不**走 chrome-devtools-mcp
 *    的 evaluate_script（避免 script 字符串污染 audit log）
 *  - stealth profile 是顶级 const（stealth-profiles.ts），**不从 config/env 读**（anti-gaming，类比 INV-14）
 *  - StealthEngine 不感知 channel（注入只接 McpClient 接口），任何 BrowseChannel 子类可用
 *
 * INV-30（v0.4 加）：stealth-profiles.ts 顶级 const，不从 config/env 读
 *                    （grep `process.env.STEALTH` 命中即🔴，类比 INV-14 anti-gaming）。
 */
import type { McpClient } from "../subprocess/McpClient.js";
import { STEALTH_PROFILES, type StealthProfileName } from "./stealth-profiles.js";

export class StealthEngine {
  /**
   * 在 navigate 前注入 stealth profile（CDP methods 直调）。
   * @param client McpClient（chrome-devtools-mcp 的 connection）
   * @param profileName STEALTH_PROFILES 顶级 const 的 key（"windows_chrome_120" / "mac_safari_17" 等）
   */
  async injectProfile(client: McpClient, profileName: StealthProfileName): Promise<void> {
    const profile = STEALTH_PROFILES[profileName];
    if (!profile) throw new Error(`unknown_stealth_profile:${profileName}`);

    // 1. user-agent override（CDP Network.setUserAgentOverride）
    await client.callTool("evaluate_script", {
      function: `(async () => {
        // 实际生产走 CDP Network domain；此处用 evaluate 占位（chrome-devtools-mcp 暂未暴露
        // setUserAgentOverride 工具；fallback：起 browserbase 时 browserbase 已替你做了 stealth）
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      })()`,
    });
    // 注：browserbase 自带 stealth，本地 HeadlessChannel 注入此 profile 即可。
    // viewport / timezone 由 chrome-devtools-mcp 启动参数控制（subprocess spec 加 flag）。
  }

  /**
   * 检测 Cloudflare challenge 页面（"Just a moment..." + cf-challenge cookie）。
   * @returns true=正在 challenge（caller 升 manual-switch）；false=正常页面
   */
  async detectCloudflareChallenge(client: McpClient): Promise<boolean> {
    const r = await client.callTool("evaluate_script", {
      function: `(function(){
        var t = (document.title || "") + " " + (document.body && document.body.innerText || "");
        return t.indexOf("Just a moment") !== -1 || t.indexOf("Checking your browser") !== -1;
      })()`,
    });
    return /true/.test(JSON.stringify(r));
  }
}
```

#### 3.3.2 stealth-profiles.ts（顶级 const，~60 行）

```typescript
/**
 * stealth-profiles（parse5 §3.3.2，INV-30 顶级 const）
 *
 * 预定义 stealth 配置表（不从 config/env 读，anti-gaming）。
 * 加新 profile = 加这里一行（≤2 处改动守 02 §4）。
 */
export interface StealthProfile {
  userAgent: string;
  viewport: { width: number; height: number };
  timezone: string;
  language: string;
  platform: string;
}

export const STEALTH_PROFILES = {
  windows_chrome_120: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    timezone: "America/New_York",
    language: "en-US",
    platform: "Win32",
  },
  mac_safari_17: {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    viewport: { width: 1680, height: 1050 },
    timezone: "Asia/Shanghai",
    language: "zh-CN",
    platform: "MacIntel",
  },
} as const;

export type StealthProfileName = keyof typeof STEALTH_PROFILES;
```

### 3.4 政策风险 gate（ToS watch-list + manual-switch + provider policy_risk）

#### 3.4.1 PolicyGate.ts（~100 行）

```typescript
/**
 * PolicyGate（parse5 §3.4，F3.4.6 政策风险 gate）
 *
 *  - cloud 浏览器通道（browse_cloud.*）必经 LASSO_ALLOW_CLOUD_BROWSER=true manual-switch
 *  - provider policy_risk="watched"（如 Tavily 收购观察期）→ doctor warn + 不阻塞（manual-switch 已开）
 *  - provider policy_risk="acquired"（如 Tavily 收购完成）→ **禁用**，doctor fail
 *  - 借鉴 Argus manual-switch：政策风险不替用户判断，由用户显式 opt-in
 *
 * 接入点：FallbackDecider.runWithFallback 前置 PolicyGate.check；
 *         check 返 false 时 plan 中所有 cloud/acquired provider 被剔除，
 *         若剔除后 plan 为空 → 直接 outcome=didnt + retrieval_method="policy_blocked"。
 *
 * INV-25：cloud 浏览器通道必经 manual-switch（grep LASSO_ALLOW_CLOUD_BROWSER
 *         + ProviderConfig.policy_risk 三态字段）。
 */
import type { ProviderConfig } from "../types.js";

export interface PolicyGateVerdict {
  allowed: boolean;
  reason?: string;
  /** 被剔除的 provider 名（audit log 用） */
  filtered?: string[];
}

export class PolicyGate {
  constructor(
    /** env 直读（仅 doctor / 装配期，runtime 不读，防 LLM 通过 channel 改 env 绕过） */
    private readonly env: { allowCloudBrowser?: boolean; tavilyWatch?: boolean },
    /** ProviderRegistry 引用（用 get() 查 policy_risk） */
    private readonly registry: { get: (name: string) => { config: ProviderConfig } | undefined },
  ) {}

  /**
   * 检查 fallback plan 中所有 channel 是否政策合规。
   * @returns allowed=true 可继续；allowed=false 终止链 + 返回过滤掉的 channel
   */
  check(plan: { primary: string; fallbacks: string[] }): PolicyGateVerdict {
    const all = [plan.primary, ...plan.fallbacks];
    const filtered: string[] = [];

    for (const ch of all) {
      // 规则 1：cloud 浏览器必经 manual-switch
      if (ch.startsWith("browse_cloud_") && !this.env.allowCloudBrowser) {
        filtered.push(ch);
        continue;
      }
      // 规则 2：provider policy_risk="acquired" → 禁用
      // 通过 channel 名反查 provider（"browse_cloud_browserbase" → "browserbase"）
      const providerName = ch.replace(/^browse_cloud_/, "").replace(/^search\./, "");
      const prov = this.registry.get(providerName);
      if (prov?.config.policy_risk === "acquired") {
        filtered.push(ch);
        continue;
      }
      // 规则 3：policy_risk="watched" + 未配 watch flag → warn skip（doctor 显式）
      if (prov?.config.policy_risk === "watched" && !this.env.tavilyWatch) {
        filtered.push(ch);
        continue;
      }
    }

    if (filtered.length === 0) return { allowed: true };
    if (filtered.length === all.length) {
      return {
        allowed: false,
        reason: "all_channels_policy_blocked",
        filtered,
      };
    }
    // 部分过滤（plan 仍有可用 channel）：返回 allowed=true + filtered 清单（caller 据此裁 plan）
    return { allowed: true, filtered };
  }
}
```

#### 3.4.2 FallbackDecider 前置 PolicyGate（~30 行改动）

```typescript
// FallbackDecider.ts runWithFallback 开头加：
async runWithFallback<T>(plan: FallbackPlan, executor: ChannelExecutor<T>, budget?): Promise<InteractResult<T>> {
  // v0.4 前置：policy gate
  if (this.policyGate) {
    const verdict = this.policyGate.check(plan);
    if (!verdict.allowed) {
      return {
        outcome: "didnt", data: null,
        served_by: plan.primary, fallback_used: false,
        retrieval_method: "policy_blocked",
        error: verdict.reason ?? "policy_gate_blocked",
        actions_and_results: [],
      };
    }
    // 裁 plan：移除 filtered 中的 channel
    if (verdict.filtered && verdict.filtered.length > 0) {
      plan = {
        ...plan,
        fallbacks: plan.fallbacks.filter((f) => !verdict.filtered!.includes(f)),
      };
    }
  }
  // ... 既有 runWithFallback 实装不动 ...
}
```

**关键设计**：PolicyGate 是**可选注入**（构造 FallbackDecider 时第 2 参 `policyGate?`），未注入时 runWithFallback 完全等价 v0.3.5 行为（**349 v0.3 测试 + 645 v0.3.5 测试零改动**，零回归承诺）。

#### 3.4.3 ProviderConfig 新增 4 条（providers.ts，~70 行）

```typescript
/**
 * browserbase —— 云 Chrome 反爬通道（F3.12.1，v0.4）。
 * policy_risk="safe"（无收购风险），但 commercial_safe=false（付费 + credits 账本）。
 */
const BROWSERBASE: ProviderConfig = {
  name: "browserbase", // channel 名 browse_cloud_browserbase
  type: "api_key",
  endpoint_url: "wss://cdp.browserbase.com", // ws URL（非 http）
  keys: [],
  free_quota_per_month: 0, // 100 free minutes trial
  quota_model: "request",
  fallback_order: 10, // cloud 是 fallback 链尾
  free_tier_level: "L4", // 付费
  policy_risk: "safe",
  licence: "commercial", // browserbase ToS 商用需联系销售
  commercial_safe: false,
  tags: ["browse_cloud"],
  enabled: false, // 默认禁用；需 LASSO_ALLOW_CLOUD_BROWSER=true + BROWSERBASE_API_KEY 双重解锁
};

/**
 * stagehand —— AI-friendly verify/extract（F3.12.2，v0.4）。
 * 同 browserbase 付费路径，仅 observe 不 act（act 越界）。
 */
const STAGEHAND: ProviderConfig = {
  name: "stagehand", // channel 名 browse_cloud_stagehand
  type: "api_key",
  endpoint_url: "https://api.stagehand.dev",
  keys: [],
  free_quota_per_month: 0,
  quota_model: "token",
  fallback_order: 11,
  free_tier_level: "L4",
  policy_risk: "safe",
  licence: "commercial",
  commercial_safe: false,
  tags: ["browse_cloud"],
  enabled: false, // 同上双重解锁
};

/**
 * Tavily —— watch-list 条件性（parse2 §3.1.2 TAVILY_WATCH 升级 v0.4 policy gate）。
 * policy_risk="watched"（v0.4 新增第三态）：收购观察期，doctor warn + 不阻塞（若 LASSO_TAVILY_WATCH=true）。
 */
const TAVILY: ProviderConfig = {
  name: "tavily",
  type: "api_key",
  endpoint_url: "https://api.tavily.com/search",
  keys: [],
  free_quota_per_month: 1000,
  quota_model: "monthly",
  fallback_order: 4,
  free_tier_level: "L2",
  policy_risk: "watched", // v0.2 acquired → v0.4 watched（收购完成观察期）
  licence: "mit",
  commercial_safe: false,
  tags: ["search"],
  enabled: false, // LASSO_TAVILY_WATCH=true 解锁
};

// BUILTIN_PROVIDERS 加 4 项（ZHIPU / BRAVE / TAVILY / BROWSE_HEADLESS / BROWSE_LOGGED_IN
//                                       / DESKTOP_AX / DESKTOP_VLM / BROWSERBASE / STAGEHAND）
```

**行数估算**：PolicyGate ~100 行 + FallbackDecider 改动 ~30 行 + providers.ts 加 ~70 行 + doctor 加 ~50 行 = **~250 行**。

### 3.5 desktop appleScript/cgEvent 档（Rust helper 扩 osakit + CGEvent FFI；INV-22 解除）

#### 3.5.1 apple-script-whitelist.ts（顶级 const，~80 行）

```typescript
/**
 * AppleScript 脚本白名单（parse5 §3.5.1，INV-27 顶级 const）
 *
 *  - typed action enum → 预编译 OSAKit 调用模板
 *  - **绝不接 raw 脚本串**（pilot_script 反面教材，F3.10.8）
 *  - 加新 action = 加这里一行 + Rust 端 applescript_whitelist.rs 镜像一行（≤2 处改动守 02 §4）
 *
 * 借鉴：mac-mcp OSAKit 路径（不 spawn osascript 子进程，避免启动开销）；
 *       F3.10.8 typed action enum 安全红线。
 *
 * INV-27：本文件顶级 const，不从 config/env 读（anti-gaming，类比 INV-14）。
 *         grep `process.env.APPLE_SCRIPT` 命中即🔴。
 */
export type AppleScriptActionName =
  | "finder_new_folder"
  | "finder_empty_trash"
  | "mail_new_message"
  | "safari_open_bookmark"
  | "notes_new_note"
  | "system_settings_toggle_wifi";

export interface AppleScriptTemplate {
  /** OSAKit 调用的 AppleScript 模板（带 ${param} 占位符） */
  script: string;
  /** 允许的参数名（白名单防注入） */
  allowedParams: readonly string[];
}

export const APPLE_SCRIPT_WHITELIST: Record<AppleScriptActionName, AppleScriptTemplate> = {
  finder_new_folder: {
    script: `tell application "Finder" to make new folder at (path to desktop folder)`,
    allowedParams: [] as const,
  },
  finder_empty_trash: {
    script: `tell application "Finder" to empty trash`,
    allowedParams: [] as const,
  },
  mail_new_message: {
    script: `tell application "Mail" to make new outgoing message with properties {visible:true, subject:${"$subject"}, content:${"$content"}}`,
    allowedParams: ["subject", "content"] as const,
  },
  safari_open_bookmark: {
    script: `tell application "Safari" to open location ${"$url"}`,
    allowedParams: ["url"] as const,
  },
  notes_new_note: {
    script: `tell application "Notes" to make new note with properties {name:${"$name"}, body:${"$body"}}`,
    allowedParams: ["name", "body"] as const,
  },
  system_settings_toggle_wifi: {
    script: `do shell script "networksetup -setairportpower en0 ${"$state"}"`,
    allowedParams: ["state"] as const, // state 只允许 "on" / "off"，rust 端二次校验
  },
} as const;
```

#### 3.5.2 AppleScriptProvider.ts（~100 行）

```typescript
/**
 * AppleScriptProvider（parse5 §3.5.2，4-tier fallback 第 2 档）
 *
 *  - 仅 typed action enum 入口（INV-22 解除 + INV-27 白名单）
 *  - 经 rust.call("applescript_run", { action, params }) 调 Rust helper osakit crate
 *  - Rust 端再次校验 action 在白名单 + params key 全在 allowedParams（双校验，纵深防御）
 *
 * 适用场景（13 §2.3 档1）：
 *  - scriptable app（Finder/Mail/Safari）AX 表达不全时降级
 *  - 比 AXSetValue 更高层的语义（"新邮件"按钮在 AX 里只是个 button，AppleScript 直接 create message）
 *
 * 借鉴：F3.10.8 typed action enum；mac-mcp OSAKit 路径（osakit crate）。
 */
import type { RustBridge } from "../subprocess/RustBridge.js";
import type { InteractResult } from "../types.js";
import { APPLE_SCRIPT_WHITELIST, type AppleScriptActionName } from "./apple-script-whitelist.js";
import type { DesktopResult, DesktopOptions } from "./desktop-types.js";

export class AppleScriptProvider {
  readonly NAME = "desktop.appleScript";

  constructor(private readonly rust: RustBridge) {}

  async act(opts: DesktopOptions): Promise<InteractResult<DesktopResult>> {
    // INV-27：action 必须在白名单（本类单点校验 + Rust 端再校验）
    const action = opts.appleScriptAction as AppleScriptActionName | undefined;
    if (!action) {
      return {
        outcome: "didnt", data: null, served_by: this.NAME,
        fallback_used: false, retrieval_method: "applescript_no_action",
        error: "missing_applescript_action",
      };
    }
    const template = APPLE_SCRIPT_WHITELIST[action];
    if (!template) {
      return {
        outcome: "didnt", data: null, served_by: this.NAME,
        fallback_used: false, retrieval_method: "applescript_unknown_action",
        error: `action_not_in_whitelist:${action}`,
      };
    }
    // 校验 params（防注入：仅允许 allowedParams 中的 key）
    const params = opts.appleScriptParams ?? {};
    for (const k of Object.keys(params)) {
      if (!template.allowedParams.includes(k)) {
        return {
          outcome: "didnt", data: null, served_by: this.NAME,
          fallback_used: false, retrieval_method: "applescript_param_not_allowed",
          error: `param_not_in_whitelist:${k}`,
        };
      }
    }

    // 经 Rust helper osakit crate 调 AppleScript
    const r = await this.rust.call("applescript_run", { action, params }, 10_000);
    if (!r.ok) {
      return {
        outcome: r.error_kind === "tcc_denied" ? "didnt" : "unknown",
        data: null, served_by: this.NAME,
        fallback_used: false, retrieval_method: "applescript_failed",
        error: r.error ?? "applescript_error",
      };
    }
    return {
      outcome: "worked",
      data: { actions_and_results: [{ ref: action, ok: true }], fallback_used: false },
      served_by: this.NAME, fallback_used: false,
      retrieval_method: "applescript_osakit",
    };
  }
}
```

#### 3.5.3 CGEventProvider.ts（~80 行）

```typescript
/**
 * CGEventProvider（parse5 §3.5.3，4-tier fallback 第 3 档）
 *
 *  - 用 core-graphics crate CGEvent FFI 合成键盘事件
 *  - 仅 press / hotkey 两条路径（click/type 走 AX 或 appleScript 已够）
 *  - **不暴露 raw keycode 入参**（INV-28）：typed logical key name only（"Return" / "cmd+c"）
 *  - Rust 端 cgevent_keymap.rs 把逻辑键名 → CGKeyCode
 *
 * 适用场景（13 §2.3 档2）：
 *  - Electron app（VSCode / Slack）吞 AXSetValue 时降级
 *  - 全局热键（如 cmd+shift+3 截图）需要系统事件级注入
 *
 * 借鉴：13 §2.3 cgEvent 档；mac-mcp CGEvent 路径（core-graphics crate）。
 */
import type { RustBridge } from "../subprocess/RustBridge.js";
import type { InteractResult } from "../types.js";
import type { DesktopResult, UiAction } from "./desktop-types.js";

const ALLOWED_CGEVENT_ACTIONS = new Set(["press", "hotkey"]);

export class CGEventProvider {
  readonly NAME = "desktop.cgEvent";

  constructor(private readonly rust: RustBridge) {}

  async act(opts: DesktopOptions): Promise<InteractResult<DesktopResult>> {
    const actions = (opts.actions ?? []).filter((a: UiAction) =>
      ALLOWED_CGEVENT_ACTIONS.has(a.kind));
    if (actions.length === 0) {
      return {
        outcome: "didnt", data: null, served_by: this.NAME,
        fallback_used: false, retrieval_method: "cgevent_no_supported_action",
        error: "only_press_or_hotkey_supported",
      };
    }
    const r = await this.rust.call("cgevent_dispatch", { actions }, 5_000);
    if (!r.ok) {
      return {
        outcome: "unknown",
        data: null, served_by: this.NAME,
        fallback_used: false, retrieval_method: "cgevent_failed",
        error: r.error ?? "cgevent_error",
      };
    }
    const results = (r.result as { results: Array<{ ref: string; ok: boolean }> }).results;
    return {
      outcome: "worked",
      data: { actions_and_results: results, fallback_used: false },
      served_by: this.NAME, fallback_used: false,
      retrieval_method: "cgevent_ffi",
    };
  }
}
```

#### 3.5.4 DesktopChannel.act plan 扩 4 档（~30 行改动）

```typescript
// DesktopChannel.ts constructor 加 2 providers + plan 扩 4 档：
export class DesktopChannel extends UiChannel {
  constructor(
    private readonly rust: RustBridge,
    private readonly axProvider: AxProvider,
    private readonly vlmProvider: ScreenshotVlmProvider,
    /** v0.4 加：4-tier 第 2/3 档 */
    private readonly appleScriptProvider: AppleScriptProvider,
    private readonly cgEventProvider: CGEventProvider,
    private readonly decider: FallbackDecider,
    breakers: Map<string, CircuitBreaker>,
  ) {
    super();
    this.breakers = breakers;
  }

  async act(opts: DesktopOptions): Promise<InteractResult<DesktopResult>> {
    const plan: FallbackPlan = {
      primary: "desktop.ax",
      fallbacks: [
        "desktop.appleScript", // v0.4 新增
        "desktop.cgEvent",      // v0.4 新增
        "desktop.screenshotVlm",
      ],
      cross_modal: false, // INV-23 仍守
    };
    return this.decider.runWithFallback(plan, async (channelName) => {
      if (channelName === "desktop.ax") return this.axProvider.act(opts);
      if (channelName === "desktop.appleScript") return this.appleScriptProvider.act(opts);
      if (channelName === "desktop.cgEvent") return this.cgEventProvider.act(opts);
      if (channelName === "desktop.screenshotVlm") return this.vlmProvider.act(opts);
      throw new Error(`unknown_provider:${channelName}`);
    });
  }
}
```

#### 3.5.5 Rust helper 扩（applescript.rs + cgevent.rs + windows.rs，~300 行）

```rust
// rust-helper/src/applescript.rs
use osakit::{OSAInstance, OSAScript};
use crate::applescript_whitelist::WHITELIST;

pub fn run(id: &str, params: &serde_json::Value) -> protocol::Response {
    let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let template = match WHITELIST.get(action) {
        Some(t) => t,
        None => return protocol::Response::err(id, "script_not_in_whitelist", action),
    };
    // 二次校验 params key（纵深防御）
    let params_map = params.get("params").cloned().unwrap_or(serde_json::json!({}));
    if let Some(obj) = params_map.as_object() {
        for k in obj.keys() {
            if !template.allowed_params.iter().any(|p| p == k) {
                return protocol::Response::err(id, "param_not_in_whitelist", k);
            }
        }
    }
    // 渲染脚本模板（${param} 替换）
    let script = render_template(&template.script, &params_map);
    // osakit 执行（不 spawn osascript 子进程）
    let mut osa = OSAInstance::default();
    match osa.execute_script(&script) {
        Ok(result) => protocol::Response::ok(id, serde_json::json!({ "result": result })),
        Err(e) => protocol::Response::err(id, "applescript_exec_failed", &e.to_string()),
    }
}

// rust-helper/src/cgevent.rs
use core_graphics::event::{CGEvent, CGEventFlags, CGEventType};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use crate::cgevent_keymap::logical_to_keycode;

pub fn dispatch(id: &str, params: &serde_json::Value) -> protocol::Response {
    let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(_) => return protocol::Response::err(id, "cgevent_source_failed", "CGEventSource"),
    };
    let actions = params.get("actions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut results = Vec::new();
    for a in actions {
        let kind = a.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "press" {
            let key = a.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let keycode = match logical_to_keycode(key) {
                Some(k) => k,
                None => {
                    results.push(serde_json::json!({ "ref": key, "ok": false, "error": "unknown_key" }));
                    continue;
                }
            };
            let down = CGEvent::new_keyboard_event(&source, keycode, true).unwrap();
            let up = CGEvent::new_keyboard_event(&source, keycode, false).unwrap();
            down.post(core_graphics::event::CGEventTapLocation::HID);
            up.post(core_graphics::event::CGEventTapLocation::HID);
            results.push(serde_json::json!({ "ref": key, "ok": true }));
        } else if kind == "hotkey" {
            // 组合键：flags + keycode 序列
            // ... 类似逻辑，flags 用 CGEventFlags
        }
    }
    protocol::Response::ok(id, serde_json::json!({ "results": results }))
}

// rust-helper/src/windows.rs（forest interact_roots 数据源）
use appkit::NSWorkspace;

pub fn list_windows(id: &str, _params: &serde_json::Value) -> protocol::Response {
    let ws = NSWorkspace::sharedWorkspace();
    let apps = ws.runningApplications();
    let mut windows = Vec::new();
    for app in apps {
        let bundle_id = app.bundleIdentifier().unwrap_or_default();
        let pid = app.processIdentifier();
        // AXUIElementCopyAttributeValues(AXWindows) → windowId 列表
        // ... 简化示例
        windows.push(serde_json::json!({
            "bundleId": bundle_id, "pid": pid,
            "windowId": 0, // 实际从 AXWindows 取
            "app": bundle_id, "title": "",
        }));
    }
    protocol::Response::ok(id, serde_json::json!({ "windows": windows }))
}
```

**行数估算（Rust 层）**：applescript.rs ~80 行 + applescript_whitelist.rs ~50 行（镜像 TS） + cgevent.rs ~70 行 + cgevent_keymap.rs ~50 行 + windows.rs ~50 行 + main.rs dispatch 加 5 行 = **~305 行**。

**行数估算（TS 层 §3.5）**：apple-script-whitelist.ts ~80 + AppleScriptProvider ~100 + CGEventProvider ~80 + DesktopChannel 改动 ~30 + desktop-types 加 ~20 = **~310 行**。

---

## 4. 不明确点调研结论

### 4.1 forest ref 命名空间怎么统一？

**结论**：@pN（browse page）+ @wN（desktop window）双前缀，**共享单一 `nextRootRefIndex` 计数器**（13 §3.3 承诺，借鉴 12 §1.2(F) injaneity `@r{nextRootRefIndex++}` 单计数器）。

- **不分裂成 `nextPageRefIndex` + `nextWindowRefIndex`**：双前缀已让 model 区分 surface；计数器单一是 injaneity 模式的核心简化
- **identity→ref 复用 map**：同 url 重开 → 同 `@pN`（避免重开 tab）；同 window 重 query → 同 `@wN`（避免重抓 AX tree）
- **RootRegistry 单一真源**：INV-24 grep `class RootRegistry` 全项目 ≤1（类比 INV-3 ProviderConfig 单一真源）

**与 injaneity 的差异**（已知，记录）：
- injaneity 用单 `@r` 前缀（不区分 surface）；Lasso 加 @p/@w 双前缀让 model 在 `interact_roots()` 输出中能直接判断"这是浏览器页还是桌面窗口"——这对 CC 路由决策至关重要（13 §3.3 设计意图）

**未确认风险**（M0.4a 验证）：
- cdpContextId 在 chrome-devtools-mcp 暴露的工具中是否能拿到？若只能拿 url，identity 退化为 sha1(url)，可能导致同 url 不同 tab 误复用 → 接受（M0.4a Go/No-Go 评估项）

### 4.2 云浏览器：MCP 直连 vs REST？

**结论**：browserbase 走 **CDP-over-ws 直连**（chrome-devtools-mcp 原生支持 `--browser-url=wss://...`）；stagehand 走 **REST API**（其自有 verify/extract 形态）。

- **browserbase 复用 BrowseChannel 的决定性理由**：chrome-devtools-mcp 的 29 工具对 Browserbase ws URL 透明工作（browserbase 兼容 CDP wire protocol）；只需 `extends BrowseChannel` + override `getMcpClient`，**actionDispatch Map + StepEngine + runExpect 全部复用**（最小侵入）
- **stagehand 新 Channel 的决定性理由**：stagehand 的 `verify(prompt)` / `extract(prompt, schema)` API 词汇与 browse action 词汇（navigate/click/fill）**不同构**（内联差异率 < 50% R-ABS-02 阈值）；硬套 extends BrowseChannel 会污染 action 词汇 → 新 `StagehandChannel extends UiChannel`，仅 expose observe(verify|extract)，不 act（agent loop 越界）
- **付费 manual-switch 是前置条件**：`LASSO_ALLOW_CLOUD_BROWSER=true` + `BROWSERBASE_API_KEY` / `STAGEHAND_API_KEY` 双重解锁；未配则 channel 不注册（`if (config.allowCloudBrowser && config.browserbaseKey)` 才 `new BrowserbaseChannel`）

### 4.3 stealth 注入点？

**结论**：**BrowseChannel 加 `protected beforeNavigate(client): Promise<void>` hook**，子类 override 注入 stealth；StealthEngine 横切关注点，不感知 channel。

- **不在 doNavigate 函数内注入**：doNavigate 是 actionDispatch Map 的 handler（INV-6 守护），改它会动 browse 所有 action 的调用栈
- **不重写整个 browse()**：BrowseChannel.browse() 入口分流（v0.3 StepEngine vs v0.2 单 action）已经够复杂；hook 点放在更小的粒度
- **hook 是 v0.4 新增的 protected 方法**（默认空实现），HeadlessChannel / BrowserbaseChannel override；**LoggedInChannel 默认不 override**（复用本机 Chrome 已天然反检测，08 §7.2 反检测军备竞赛缓解）

**Cloudflare 检测路径**：
- `StealthEngine.detectCloudflareChallenge(client)` 在 navigate 后 200ms 调用（evaluate_script 读 title）
- 检测到 challenge → outcome=unknown + error="cloudflare_challenge_detected" + 触发 fallback（若有 browserbase）或 manual-switch 提示

### 4.4 appleScript 注入防御？

**结论**：**纵深防御 3 层**（INV-22 解除 + 新 INV-27 守护）。

| 层 | 检查点 | 实现 |
|---|---|---|
| 1 | TS 端 AppleScriptProvider | action 必须在 APPLE_SCRIPT_WHITELIST；params key 必须在 template.allowedParams |
| 2 | Rust 端 applescript.rs | 二次校验 action 在白名单 + params key 在 allowedParams（不信任 TS 端，纵深防御） |
| 3 | 编译期 applescript_whitelist.rs | 白名单是顶级 const，编译进二进制；**运行时不可改**（防 LLM 通过 channel 改 env 绕过，类比 INV-14 anti-gaming） |

- **绝不接 raw 脚本串**：F3.10.8 typed action enum 红线；rust helper `applescript_run` method 的 params schema 在 protocol.rs 锁死为 `{ action: string, params: object }`，**不接受 `script` 字段**
- **INV-27 grep 断言**：`process.env.APPLE_SCRIPT` 在 src/**/*.ts 代码本体不出现（anti-gaming）

**关键 trade-off（诚实标注）**：
- 白名单限制了灵活性（用户不能让 CC "对任意 app 跑任意 AppleScript"）
- 这是**故意的**：08 §5.1 安全红线 + mac-mcp 反 `run_shell` 教训；用户若需新 action，加白名单一行 + Rust 镜像一行（≤2 处改动守 02 §4）

---

## 5. 测试计划

### 5.1 forest 调度层单测（test/unit/forest-*.spec.ts）

```
test/unit/
├── forest-root-registry.spec.ts          # @pN/@wN 分配 + identity 复用 + nextRootRefIndex 单调
├── forest-interact-dispatcher.spec.ts    # 按 rootRef 前缀 dispatch + stale_root_ref 处理
├── forest-identity-hash.spec.ts          # browse cdpContextId|url / desktop bundleId|pid|windowId 身份哈希
└── forest-list-roots.spec.ts             # interact_roots() 输出排序（@p 在前 @w 在后）
```

**关键断言**（INV-24..26）：
- RootRegistry 类全项目 ≤1 实例（grep 断言）
- InteractDispatcher 不 import BrowseChannel/DesktopChannel 的 internal 模块（grep 断言）
- 同 identity 二次 getOrCreate → 返回同 ref（不分配新计数器）

### 5.2 stealth + 政策 gate 单测（test/unit/）

```
test/unit/
├── stealth-engine.spec.ts                # injectProfile 注入 webdriver=false + user-agent override
├── stealth-profiles.spec.ts              # STEALTH_PROFILES 顶级 const（不从 env 读）
├── policy-gate.spec.ts                   # cloud manual-switch / policy_risk=acquired 禁用 / watched warn
└── fallback-policy-gate.spec.ts          # FallbackDecider 前置 PolicyGate（policy_blocked 路径）
```

**关键断言**（INV-25/30）：
- PolicyGate.env.allowCloudBrowser=false + plan 含 `browse_cloud_*` → 全过滤 → outcome="didnt" + retrieval_method="policy_blocked"
- PolicyGate 不读 process.env（构造期注入；runtime LLM 无法通过 channel 改 env 绕过）

### 5.3 appleScript/cgEvent 单测（test/unit/desktop-*.spec.ts + rust-helper/tests/）

```
test/unit/
├── apple-script-provider.spec.ts         # action 不在白名单 → didnt；params key 不在 allowed → didnt
├── apple-script-whitelist.spec.ts        # 白名单全覆盖 + INV-27 顶级 const
├── cg-event-provider.spec.ts             # 仅 press/hotkey 支持（click/type 不支持 → didnt）
└── desktop-4-tier-fallback.spec.ts       # ax→appleScript→cgEvent→screenshotVlm 完整链

rust-helper/tests/
├── applescript_whitelist.rs              # 白名单 manifest 编译期注入（INV-27 镜像）
├── cgevent_keymap.rs                     # 逻辑键名 → CGKeyCode 全覆盖
└── windows_list.rs                       # mock AXUIElement 树，list_windows 返结构校验
```

**关键断言**（INV-22 改写 + INV-27..29）：
- AppleScriptProvider 不接受 raw script 字符串（zod schema 拒绝）
- CGEventProvider 不暴露 raw keycode（zod schema 拒绝 number，仅 string 逻辑键名）
- 白名单是顶级 const（grep `process.env.APPLE_SCRIPT` / `process.env.CGEVENT_KEYCODE` 命中即🔴）

### 5.4 云浏览器 mock 测试（test/integration/）

```
test/integration/
├── browserbase-channel.spec.ts           # mock McpClient（ws URL），验证 navigate/snapshot/click
├── stagehand-channel.spec.ts             # mock fetch（verify/extract REST API）
└── cloud-policy-gate-e2e.spec.ts         # LASSO_ALLOW_CLOUD_BROWSER=false → browserbase 不注册（server.listTools 不含）
```

**mock 策略**（参照 parse4 §5.3 MockRustBridge 范式）：
- BrowserbaseChannel mock：`MockMcpClient` 覆写 callTool，返回 fixture snapshot
- StagehandChannel mock：`global.fetch` 覆写，返回 fixture verified/extracted JSON
- **CI 不跑真实 browserbase/stagehand**（无 API key + 付费）；手测清单见 §6.4

### 5.5 不破坏 v0.3.5 的 645 tests（强制）

- 现有 `test/unit/*.spec.ts` + `test/integration/*.spec.ts` 全部保持绿（**不动**既有文件）
- 新增 v0.4 测试加在新文件（forest-/stealth-/policy-/apple-script-/cg-event-/browserbase-/stagehand-* 前缀）
- INV-22 改写（占位 → typed action enum）后，原 INV-22 grep 断言改语义但编号不挪；既有 INV-1..21, 23 全部保持
- `npm test` 同时跑 vitest + check-invariants.mjs；CI exit 0 = 全绿

---

## 6. 验收标准（引用 09 §2.5 的 4 条 + 细化）

### 6.1 M0.4a Forest 调度层 + 政策 gate（CI 可验，~8 条）

| # | 验收项 | 来源 | CI vs 手测 |
|---|---|---|---|
| 1 | `interact_roots()` 返回 browse CDP page + desktop AX window 统一列表，model 选 rootRef 后 dispatch | 09 §2.5 验收 1 | CI: forest-list-roots.spec.ts mock 双 channel；手测：真机 + Chrome + Finder |
| 2 | RootRegistry 共享 nextRootRefIndex（@p0/@w1/@p2/@w3 ... 单计数器） | 13 §3.3 | CI: forest-root-registry.spec.ts |
| 3 | identity 复用：同 url 二次 listRoots → 同 @pN；同 window 二次 → 同 @wN | 12 §1.2(F) | CI: forest-identity-hash.spec.ts |
| 4 | InteractDispatcher 不 import BrowseChannel/DesktopChannel 的 internal 模块（仅 class） | INV-26（NEW） | CI: check-invariants.mjs grep |
| 5 | PolicyGate：cloud 浏览器通道必经 `LASSO_ALLOW_CLOUD_BROWSER=true` | 09 §2.5 验收 4 + F3.4.6 | CI: policy-gate.spec.ts |
| 6 | PolicyGate：provider policy_risk="acquired" → 禁用；"watched" → warn skip | F3.4.6 | CI: policy-gate.spec.ts |
| 7 | FallbackDecider 前置 PolicyGate：policy_blocked 路径返 outcome=didnt + retrieval_method="policy_blocked" | parse5 §3.4.2 | CI: fallback-policy-gate.spec.ts |
| 8 | INV-24/25/26 全部绿（forest 调度层 invariants） | parse5 §2.3 | CI: check-invariants.mjs |

### 6.2 M0.4b appleScript + cgEvent 档（CI + 手测，~7 条）

| # | 验收项 | 来源 | CI vs 手测 |
|---|---|---|---|
| 9 | desktop 4-tier fallback 链完整：ax → appleScript → cgEvent → screenshotVlm | 13 §2.3 + 09 §2.4 | CI: desktop-4-tier-fallback.spec.ts mock |
| 10 | AppleScriptProvider 仅 typed action enum 入口（白名单 6 项：finder/mail/safari/notes/system_settings） | F3.10.8 + INV-22 解除 | CI: apple-script-provider.spec.ts |
| 11 | appleScript raw 脚本串注入测试：尝试传 `{script: "do shell script ..."}` → 拒绝 | INV-27 | CI: apple-script-injection.spec.ts |
| 12 | CGEventProvider 仅 press/hotkey 支持，不暴露 raw keycode | INV-28 | CI: cg-event-provider.spec.ts |
| 13 | Electron app（VSCode）AXSetValue 失败时降级 cgEvent（press Return 等单键）→ outcome="worked" | 09 §2.4 D6 + 13 §2.3 档2 | 手测：真机 VSCode + system events |
| 14 | scriptable app（Finder）AX 表达不全时降级 appleScript（typed action: finder_new_folder）→ outcome="worked" | 13 §3.4 M0.5b 第 4 条 | 手测：真机 Finder |
| 15 | INV-22 改写（解除占位）+ INV-27/28/29 全部绿 | parse5 §2.3 | CI: check-invariants.mjs |

### 6.3 M0.4c browse_cloud + stealth（CI + 手测，~5 条）

| # | 验收项 | 来源 | CI vs 手测 |
|---|---|---|---|
| 16 | browserbase 云浏览器通道可用（反爬站点通关） | 09 §2.5 验收 2 | 手测：真实 browserbase key + Cloudflare 站点 |
| 17 | stealth 反检测：navigator.webdriver=false + user-agent 抖动（bot.sannysoft 过检） | 09 §2.5 验收 3 + F3.2.12 | 手测：bot.sannysoft.com |
| 18 | stealth 失败时不自动尝试 captcha 求解，升 manual-switch（Argus 范式） | parse5 §3.3.1 escalateManualSwitch | CI: stealth-engine.spec.ts + 手测 |
| 19 | stagehand verify(prompt)/extract(prompt, schema) 两个 AI 原语可用 | F3.12.2 | 手测：真实 stagehand key |
| 20 | INV-29/30 全部绿（stealth + cloud 浏览器 invariants） | parse5 §2.3 | CI: check-invariants.mjs |

### 6.4 v0.3.5 零回归（强制）

- v0.3.5 的 **645 TS tests + 47 Rust tests** 100% 绿
- 既有 INV-1..23 全部保持绿（INV-22 改写语义但编号不挪）
- `npm test` + `npm run check-invariants` + `cd rust-helper && cargo test` 三个命令都 exit 0
- parse4-acceptance.md 的 13 条 TCC/codesign 手测 pending 全部承接（v0.4 不砍）

---

## 7. 风险 + 实施顺序

### 7.1 v0.4 风险 Register（09 §6 R6-R8 + 13 §5.1 D6 + parse5 新增 V1-V4）

| ID | 风险 | 影响 | 概率 | 缓解 | 触发预警 |
|---|---|---|---|---|---|
| R6（09） | Electron app 吞 AXSetValue | 中 | 中 | cgEvent 降级（v0.4 解占位） | M0.4b #13 手测失败 |
| R7（09） | Tavily 收购后免费层停 | 低 | 中 | watch-list + policy_risk="watched" + 不做主力（PolicyGate） | doctor warn |
| R8（09） | 反检测军备竞赛 | 中 | 中 | stealth 定期更新 + browse_logged_in 用真实 Chrome 天然反检测 | bot.sannysoft 失检 |
| D6（13） | 4-tier fallback 实现负担（appleScript/cgEvent） | 中 | 中 | M0.4b 分阶段；white list 6 项够 80% 场景 | M0.4b 工时超单人 8h/周 × 3 周 |
| **V1**（NEW） | forest ref 命名空间破裂（cdpContextId 不可得） | 中 | 低 | identity 退化为 sha1(url)（同 url 不同 tab 误复用 → 接受）；M0.4a Go/No-Go | M0.4a #3 复用测试失败 |
| **V2**（NEW） | browserbase 上游契约变（CDP ws 协议） | 中 | 低 | 锁版本 + 契约测试；cloud 是 fallback 链尾非主力 | browserbase-channel.spec.ts mock 失效 |
| **V3**（NEW） | stealth 注入触怒 Cloudflare（IP 封禁） | 中 | 中 | manual-switch 显式 opt-in + 反爬军备竞赛边界明确；stealth 失败升 manual-switch 不自动绕 | 用户报告 IP 临时封禁 |
| **V4**（NEW） | appleScript 白名单覆盖不足（用户需要新 action） | 低 | 中 | 加白名单一行 ≤2 处改动；文档引导用户 PR | 用户反馈 ≥3 个缺失 action |

### 7.2 Go/No-Go 决策点（parse5 新增）

任一触发必须在下一 phase 开始前评审：
1. **M0.4a Go/No-Go 失败**：forest 调度层强迫 BrowseChannel/DesktopChannel 加 surface 字段 → 暂停 v0.4，回 13 §3.2 重审抽象（参照 D1/D4 缓解路径）
2. **INV-22 改写后 INV-1..21/23 任一红**：CI 失败 → 不允许进 M0.4b
3. **appleScript 注入测试失败**（白名单被绕过）→ 立即停止，安全红线（F3.10.8）
4. **跨 surface fallback 出现**（browse_cloud 失败 fallback 到 desktop）→ 立即停止（INV-23 红线）
5. **browserbase 手测连续 3 次 2FA 失败** → 确认边界（08 §7.3 不解 2FA），降级 cloud 浏览器为「无登录态反爬」专用

### 7.3 推荐实施顺序（M0.4a → M0.4b → M0.4c，建议 15-18 天单人）

```
M0.4a Forest 调度层 + 政策 gate（建议 5-6 天单人）:
  Day 1-2: forest-types.ts + RootRegistry.ts（identity→ref map + nextRootRefIndex）
  Day 2-3: InteractDispatcher.ts + BrowseChannel.listRoots() / DesktopChannel.listRoots()
  Day 3-4: PolicyGate.ts + FallbackDecider 前置接入（可选注入，零回归）
  Day 4-5: registerInteractTools（3 工具）+ doctor 加 #21-#24
  Day 5-6: INV-22 改写 + INV-24/25/26 加 + 8 项 M0.4a 验收

  ★ M0.4a Go/No-Go 评审 ★

M0.4b appleScript + cgEvent（建议 5-6 天单人）:
  Day 7  : Cargo.toml 加 osakit + core-graphics + applescript_whitelist.rs + cgevent_keymap.rs
  Day 8  : applescript.rs（OSAKit 调用 + 白名单二次校验）+ rust 端单测
  Day 9  : apple-script-whitelist.ts + AppleScriptProvider.ts（TS 端校验）
  Day 10 : cgevent.rs（CGEvent FFI）+ CGEventProvider.ts
  Day 11 : DesktopChannel 扩 4 档 plan + INV-27/28/29 加
  Day 12 : M0.4b 7 项验收 + 注入测试（白名单绕过尝试）

  ★ M0.4b Go/No-Go 评审 ★

M0.4c browse_cloud + stealth（建议 5-6 天单人）:
  Day 13 : BrowserbaseChannel.ts（extends BrowseChannel，hook beforeNavigate）
  Day 14 : StagehandChannel.ts + StealthEngine.ts + stealth-profiles.ts
  Day 15 : index.ts 条件装配（LASSO_ALLOW_CLOUD_BROWSER=true）+ registerBrowserbaseTool
  Day 16 : doctor 加 cloud 浏览器 + stealth 自检 + INV-29/30
  Day 17 : bot.sannysoft 手测 + Cloudflare 站点通关测试
  Day 18 : M0.4c 5 项验收 + 真实 browserbase/stagehand key 手测
```

### 7.4 关键决策回顾（6 条）

1. **forest 是调度层不是新 channel**（parse5 §3.1 + INV-26）：RootRegistry + InteractDispatcher 是 BrowseChannel/DesktopChannel **之上**的薄包装，**不渗入它们内部**；R-CI-02 守住（兄弟不是父子）
2. **@pN + @wN 双前缀共享 nextRootRefIndex**（parse5 §3.1.2）：13 §3.3 v0.4+ 承诺；借鉴 12 §1.2(F) injaneity 单计数器模式，加双前缀让 model 区分 surface
3. **browserbase extends BrowseChannel，stagehand 新 Channel**（parse5 §3.2.1）：前者 CDP-over-ws 与 chrome-devtools-mcp 原生兼容，复用 actionDispatch；后者 REST API 词汇不同构（verify/extract ≠ navigate/click）
4. **政策 gate 是 FallbackDecider 前置可选注入**（parse5 §3.4.2）：PolicyGate 第 2 参可选；未注入完全等价 v0.3.5（零回归承诺）
5. **appleScript/cgEvent 纵深防御 3 层**（parse5 §4.4 + INV-27）：TS 端白名单 + Rust 端二次校验 + 编译期 manifest；typed action enum + 不接 raw 脚本串（F3.10.8）
6. **cloud 浏览器付费必经 manual-switch**（parse5 §3.4 + INV-25）：`LASSO_ALLOW_CLOUD_BROWSER=true` + `BROWSERBASE_API_KEY` 双重解锁；PolicyGate 在 FallbackDecider 前置过滤；未配则 channel 不注册（server.listTools 不含）

---

## 总结

v0.4 在 v0.3.5 的 BaseChannel / FallbackDecider / StateStore / expect / doctor / 不变量测试 / Rust helper 地基上加 **forest 调度层（3 工具）+ 2 新 channel + 2 desktop providers + stealth 引擎 + 政策 gate**，零回归承诺（645 tests + 23 invariants 不破坏，INV-22 改写 + 新增 INV-24..30 共 30 条）。Forest 是调度层不是新 channel（R-CI-02 守住）；appleScript/cgEvent 纵深防御 3 层（F3.10.8 守住）；cloud 浏览器付费必经 manual-switch（F3.4.6 守住）。M0.4a forest 调度层先行验证抽象（V1 最大风险点），通过后 M0.4b 加 appleScript/cgEvent（D6 分阶段降负担），M0.4c 加 cloud 浏览器 + stealth（R8 反爬军备竞赛缓解）。任一 Go/No-Go 触发有明确回退路径（暂停 v0.4，回 08/13 重审抽象）。

**关键路径代码文件**（开发者照着写）：
- forest 层：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/forest/RootRegistry.ts` + `InteractDispatcher.ts` + `forest-types.ts`
- desktop 扩展：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/desktop/AppleScriptProvider.ts` + `CGEventProvider.ts` + `apple-script-whitelist.ts`
- cloud 浏览器：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/channels/BrowserbaseChannel.ts` + `StagehandChannel.ts`
- stealth：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/browse/StealthEngine.ts` + `stealth-profiles.ts`
- 政策 gate：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/fallback/PolicyGate.ts`
- Rust helper 扩：`/Users/wangdong/Documents/Project/cc-control-all/lasso/rust-helper/src/applescript.rs` + `cgevent.rs` + `windows.rs` + `applescript_whitelist.rs` + `cgevent_keymap.rs`
- invariants：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs`（INV-22 改写 + INV-24..30 新增）

**v0.4 之后（v0.5+ 推迟）**：
- ResourceScheduler + epoch 串行（12 §3.4 + 13 §3.4.6 推迟）
- compact diff（如 v0.6+ SPA 分页真需要，先评估 Stagehand `diffCombinedTrees` 而非 pi 全套）
- browserbase 2FA 自动解（永远不做，08 §7.3 边界）
- agent loop（永远不下沉到 MCP，12 §5.2 越界）
