# forest/ —— Lasso v0.4 调度层（forest 调度层不是新 channel）

> parse5 §3.1 + 13 §2.4 R-CI-02 + 12 §1.2(F) injaneity 借鉴
>
> 守护铁律：**forest 是 BrowseChannel / DesktopChannel **之上**的薄包装调度层，
> 不是新 channel**（R-CI-02：兄弟不是父子；通道平级，永不互嵌）。

## 文件

```
forest/
├── forest-types.ts       纯类型：RootRef (@pN|@wN) / RootKind / RootIdentity /
│                                   RootInfo / InteractTask / InteractEnvelope
├── RootRegistry.ts       身份→短指针 map（identity→ref）+ nextRootRefIndex 单计数器
├── InteractDispatcher.ts 按 rootRef 前缀 dispatch 到 BrowseChannel / DesktopChannel
└── README.md             （本文件）
```

## R-CI-02 守护说明

**13 §2.4 R-CI-02**：「兄弟不是父子」。`BrowseChannel` 和 `DesktopChannel` 都是
`UiChannel` 的子类（兄弟），互不感知对方的内部。forest 是**它们之上的调度层**，
经「channel 名 → channel 实例」Map 路由，**绝不 import 它们的 internal 模块**。

INV-26 grep 断言（`check-invariants.mjs`）：本目录下任何 .ts 文件都不得
`import` 自：
- `../browse/*.js`（StepEngine / ExpectPoll / HighRiskGate / steps-types / ...）
- `../desktop/*.js`（AxProvider / ScreenshotVlmProvider / OutlineMapper /
                    desktop-types / ax-role-map / ...）
- `../subprocess/McpClient.js`、`RustBridge.js`（subprocess 协议帧解析）
- `../fallback/*.js`（FallbackDecider / CircuitBreaker / ...）

允许的 channel-引用形式只有两种（INV-26 白名单）：
1. `import type { BrowseChannel } from "../channels/BrowseChannel.js"` —— class
   接口契约（用于 `Map<string, BrowseChannel | DesktopChannel>` 类型标注）
2. `import type { DesktopChannel } from "../channels/DesktopChannel.js"` —— 同上

调用方式仅限：
- `channel.browse(url, action, options)` —— BrowseChannel 公共入口
- `channel.observe(action, opts)` / `channel.act(opts)` / `channel.wait(opts, ms)` ——
  DesktopChannel 公共入口
- `channel.listRoots()` —— v0.4 新增的 forest-friendly 公共方法

## 设计选择（parse5 §3.1 + §4.1 调研结论）

| 设计点 | 选择 | 借鉴 |
|---|---|---|
| ref 命名空间 | @pN（browse）+ @wN（desktop）双前缀 | 13 §3.2 |
| 计数器 | 共享单 `nextRootRefIndex`（@p/@w 交替递增） | 12 §1.2(F) injaneity |
| identity→ref map | sha1(channel算的稳定身份) → RootRef | 12 §1.2(F) storeWindowRef |
| 路由依据 | rootRef 前缀（@p / @w），不 channel type switch | 13 §3.3 |
| identity 算法 | channel 内部算（BrowseChannel: cdpContextId|url；DesktopChannel: bundleId|pid|windowId） | parse5 §3.1.2 |

## v0.4 M0.4a 边界（本 phase 做 / 不做）

**做**：
- forest-types.ts + RootRegistry.ts + InteractDispatcher.ts（~340 行）
- BrowseChannel / DesktopChannel 加公共 `listRoots()` 方法
- interact_roots / interact_observe / interact_act 3 工具
- INV-24（RootRegistry 单一真源）/ INV-26（forest 不渗 channel internal）
  / INV-29（forest 无平台字面量）3 条新 invariants

**不做**（推迟 M0.4b / M0.4c）：
- ResourceScheduler + epoch 串行（v0.5+）
- compact diff（v0.6+ 或 NO-GO）
- cloud 浏览器 channel（M0.4c）
- appleScript / cgEvent provider（M0.4b）
- 政策 gate（M0.4c；forest 调度层本身不需政策 gate）

## 测试

- `test/unit/forest-root-registry.spec.ts` —— nextRootRefIndex 单计数器 +
  identity 复用
- `test/unit/forest-dispatcher.spec.ts` —— @pN→browse / @wN→desktop 路由 +
  未知前缀拒绝
- `test/unit/forest-list-roots.spec.ts` —— mock 双 channel listRoots 聚合

INV-24 / INV-26 / INV-29 由 `npm run check-invariants` 守护（grep 断言）。
