# Lasso 架构

> 本文是 Lasso v1.0 的架构概览（user-first；深度架构基线见 [`doc/08`](./../doc/08-media-interact-功能架构.md)；实施排期与决策记录见 [`doc/09`](./../doc/09-media-interact-实施排期.md)）。

## 1. 项目定位

Lasso 是 Claude Code 的**全交互**对外抓手 MCP（浏览器 + 桌面）。与 [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp)（图像抓手）双子星：

- media-gen-mcp：「所有图像操作归一个 MCP」（生成 + 识别）
- **Lasso**：「所有外部交互归一个 MCP」（浏览器 + 桌面）

四通道：`search` / `browse_headless` / `browse_logged_in` / `desktop`。所有通道共享同一套 fallback 范式 / 状态模型 / 工具风格（R-CI-02 红线：禁第二套做法）。

## 2. 整体分层

```
┌────────────────────────────────────────────────────────────────┐
│  Claude Code                                                    │
└──────────────────────────────┬─────────────────────────────────┘
                               │ stdio MCP (JSON-RPC)
                               ▼
┌────────────────────────────────────────────────────────────────┐
│  Lasso（单进程 Node.js）                                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Tool Layer（src/tools/）                                 │  │
│  │   search / browse_headless / browse_logged_in             │  │
│  │   desktop / admin / doctor                                │  │
│  │   每工具 Zod inputSchema + ToolAnnotations 完整           │  │
│  └────────────────────────┬─────────────────────────────────┘  │
│                           │ typed call                          │
│  ┌────────────────────────▼─────────────────────────────────┐  │
│  │  Channel Layer（src/channels/ + src/browse/ + src/desktop/│  │
│  │   + src/search/ + src/logged-in/）                        │  │
│  │   BaseChannel ← UiChannel ← BrowseChannel / DesktopChannel│  │
│  │                  ← SearchChannel / LoggedInChannel         │  │
│  └────────────────────────┬─────────────────────────────────┘  │
│                           │ FallbackDecider + tri-state         │
│  ┌────────────────────────▼─────────────────────────────────┐  │
│  │  Fallback Engine（src/fallback/）                         │  │
│  │   worked / didnt / unknown → unknown 触发下一档           │  │
│  └────────────────────────┬─────────────────────────────────┘  │
│                           │                                     │
│  ┌────────────────────────▼─────────────────────────────────┐  │
│  │  Subprocess Layer（src/subprocess/）                      │  │
│  │   SubprocessManager + RustBridge                          │  │
│  │   chrome-devtools-mcp ×2（headless / logged_in）          │  │
│  │   lasso-rust-helper（AXAPI/UIA/AT-SPI + screenshot + TCC) │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬─────────────────────────────────┘
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
 chrome-devtools-mcp    智谱/Brave/Bing/Wayback     lasso-rust-helper
 (--headless            (search multi-engine        (macOS AXAPI
  / --browser-url       via HTTP)                   Windows UIA
  :9222)                                            Linux AT-SPI
                                                    + screenshot + TCC)
```

## 3. 核心抽象

### 3.1 BaseChannel / UiChannel 分层

```
BaseChannel                         （src/channels/BaseChannel.ts）
  ├── SearchChannel                 （只通用层；不进 UI）
  └── UiChannel                     （src/channels/UiChannel.ts）
       ├── BrowseChannel            （browse_headless + browse_logged_in 复用）
       ├── HeadlessChannel
       ├── LoggedInChannel
       └── DesktopChannel           （desktop 4 档 fallback：ax → appleScript → cgEvent → screenshotVlm）
```

UI 通道共享 UiChannel 的状态写盘 / LRU / output envelope 机制；Search 只走通用层（无 UI 状态概念）。**INV-2 守：所有 XxxChannel 必须 extends BaseChannel**（不绕过）。

### 3.2 CapabilityBag（运行时动态启停）

`src/runtime/CapabilityBag.ts`（v0.6+）：通道运行时可 enable/disable，无需重启进程。`admin` tool 提供 `channel_health` / `reset` action。**INV-37 守：admin tool 必经 toolManager.register（不直调 server.tool）**。

### 3.3 FallbackPlan + tri-state outcome

```
outcome = worked | didnt | unknown
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │  unknown → 触发下一档 │
                       │  worked  → 链止，返成功│
                       │  didnt  → 链止，返失败│
                       │   （如 404 / 2FA）    │
                       └──────────────────────┘
```

铁律：**event delivery ≠ semantic success**（INV-13）。例如 `desktop act` 调用 AXPress 不报错（event delivered），但目标按钮没有真的被点（disabled / obscured）→ 必须 `expect` 验证后置条件，failed 时 `outcome=didnt` 终止链。

### 3.4 StateStore LRU(128)

页面 DOM / 桌面 OutlineNode 不灌 CC 上下文，而是写本地磁盘（`~/.cache/lasso/state/`），返回 `state_id`。CC 后续 `act` / `find` 经 `state_id` 引用 → **4× token 效率**。LRU(128) 自动淘汰旧状态。

## 4. desktop 跨平台（v1.0 落地）

```
AxBackend interface（三平台同构 OutlineNode 契约）
   ├── MacAxBackend       → rust.call("ax_snapshot")    → rust-helper/src/ax.rs      [cfg(macos)]
   ├── WinUiaBackend      → rust.call("uia_snapshot")   → rust-helper/src/uia.rs     [cfg(windows)]
   └── LinuxAtspiBackend  → rust.call("atspi_snapshot") → rust-helper/src/atspi.rs   [cfg(linux)]
                                  │
                                  ▼
                         AxBackendFactory.create()  ← platform-detect.ts (process.platform)
                                  │
                                  ▼
                         AxProvider（业务逻辑；三平台共享）
                                  │
                                  ▼
                         OutlineMapper（三平台共享；纯数据变换；INV-61 守）
                                  │
                                  ▼
                         OutlineNode（同形异源；INV-19 守：类型无 surface 字段）
```

**关键设计决策**（守简单性 02 §5 R-CI-02 + §6.1 R-FF-01）：

1. **不重写 AxBackend interface**。v0.3.5 已定义 `snapshot / find / act` 三方法；v1.0 只加 backend 实现，不破契约。
2. **不在 TS 层做平台分支**。`AxProvider` 不 `if (platform === 'win32')`；而是 `AxBackendFactory.create()` 经 `platform-detect.ts` 路由。**INV-21 守：src/**/*.ts 无平台字面量**（AXUIElement / CGEvent / libatspi 都隔离在 rust-helper/*.rs）。
3. **不渗 OutlineMapper 到 backend 内**。OutlineMapper 三平台共享同一个（INV-61 守：mapper 是纯数据变换，不感知 backend 实现选择）；Rust 端三平台都返同形 AxNode JSON。
4. **不引 electron / tauri 跨平台 AX 抽象**。它们抽象太厚（带 IPC / window management），Lasso 只需"读 AX 树 + act 节点"，薄壳足够（02 §5 R-ABS-01 错误抽象警惕）。
5. **Windows UIA 用官方 `windows` crate（microsoft/windows-rs）**。微软长期维护 + auto-generated from Win32 metadata + 完整覆盖（社区 uiautomation crate 维护风险高，不选）。
6. **Linux AT-SPI 用 `atspi` crate（odilia-app）**。pure Rust via zbus D-Bus，无 C 依赖，CI Linux headless 可编。

## 5. 设计原则（08 §0）

1. **能力导向命名**：search / browse_* / desktop（不按后端命名）
2. **页面/界面状态写磁盘**：4× token 效率
3. **减少推理调用**：多步链式（如 search → click → extract）一次工具调用完成
4. **fallback 对 CC 透明**：CC 只看到 `worked / didnt`，不感知降级细节
5. **诚实三态交付**：`worked / didnt / unknown`（unknown 是 fallback 触发器）
6. **零侵入跟随上游**：chrome-devtools-mcp 升级时 Lasso 不改业务（契约锁版本）
7. **第二套做法红线**（R-CI-02）：横切关注点变体只允许一套（fallback 范式 / state 模型 / dispatch Map / provider registry 等）
8. **不变量脚本化**（CI 守门）：65 条 INV 静态 grep + 形状测，防 refactor 回退
9. **平台差异隔离在 backend 内部**：AxBackend 三平台同构 OutlineNode 契约；TS 层零平台字面量

## 6. 边界（08 §7）

Lasso 明确**不做**以下事情：

- **不解 2FA**：站点要求 2FA 时返 `NEEDS_MANUAL_2FA`（red line；不让 CC 尝试绕过）
- **不做坐标 grounding**：desktop 走语义 AX tree，不 click (x, y) 坐标（坐标方案脆弱）
- **不做 RRF 融合 / corpus 持久化**：search 是 hit + wayback 兜底，不是 RAG
- **不导出 cookie**：`browse_logged_in` 的 cookie 留本机 Chrome（除用户显式 opt-in `admin` action 且经 AES-256-GCM 加密）
- **不引云浏览器**：cloud 浏览器通道（Browserbase / Stagehand）必经 `LASSO_ALLOW_CLOUD_BROWSER=true` manual-switch + API key 双重解锁（INV-25 守）
- **macOS-only 开发**：Win/Linux backend 编译可证（cfg-gate + `cargo check --target`），真机执行待社区反馈（不伪造）

## 7. 测试策略

| 层 | 工具 | 覆盖 | 规模 |
|---|---|---|---|
| 架构不变量 | `check-invariants.mjs`（自写） | INV-1..65 静态 grep + 形状测 | 65 条 |
| TS 单测 | vitest | channel / fallback / forest / doctor / launcher / outline-contract / replay-baseline | ≈1400 测试 |
| Rust 单测 | cargo test | macOS 路径（ax / applescript / cgevent / screenshot / tcc / windows） | ≈180 测试 |
| 跨平台编译 | cargo check --target | Windows (x86_64-pc-windows-msvc) + Linux (x86_64-unknown-linux-gnu) | CI Linux runner |
| 录制回放回归 | npm run replay-baseline | fixtures/serp-baseline/ × 三引擎 × 多 query | 12+ fixtures |
| 故障注入 | vitest | fallback 链 / 限流 / 政策 gate / SERP 改版 | ~20 场景 |
| 契约锁 | chrome-devtools-mcp version pin | 上游小版本升级不破 Lasso | package.json |

## 8. 不变量（65 条）分类

| 范畴 | INV 编号 | 守的是什么 |
|---|---|---|
| 单一真源（grep 守 class / type 只在一处定义） | INV-3 / 9 / 24 / 60 | ProviderConfig / ProviderRegistry / RootRegistry / AxBackendFactory |
| 禁第二套（横切关注点变体只允许一套） | INV-4 / 6 / 23 / 33 | FallbackDecider / dispatch Map / 跨 surface fallback / pdf dispatch |
| 平台隔离（src/**/*.ts 无平台字面量） | INV-21 / 60 / 61 | TS 层无 AXUIElement/CGEvent/UIAutomationClient |
| 隐私红线 | INV-15 / 43 / 48..53 / 57 / 62 | output envelope 0o600 / 零遥测 / cookie AES-256-GCM / 录制 opt-in / 禁录 logged_in |
| 安全红线 | INV-14 / 25 / 27 / 30 / 31 / 32 | HIGH_RISK_PATTERNS / cloud 双重解锁 / appleScript 白名单 / stealth profiles / SSRF / 连接池 |
| 诚实交付 | INV-13 / 19 | expect failed 必须 didnt + 终止 / OutlineNode 同形异源 |
| v1.0 release polish | INV-63 / 64 / 65 | version 三处一致 / launcher 不引新 npm dep / README+ARCHITECTURE 必引用 08+09 |

完整 INV 列表 + 释义见 `src/invariants/check-invariants.mjs` 顶部注释。

## 9. 数据流（典型场景）

### 9.1 search（多引擎 fallback）

```
CC → search("rust async", engine="auto")
   → SearchChannel.run()
      → FallbackChain: 智谱 → Brave → Bing → Wayback → RecordingStore replay
      → 任一 worked 即止；全 didnt + 有录制 → recording_replay_miss 兜底
   → 返 { outcome: "worked", entries: [...], engine: "zhipu" }
```

### 9.2 browse_logged_in（2FA 场景）

```
CC → browse_logged_in("https://app.example.com", action="snapshot")
   → LoggedInChannel.run() → chrome-devtools-mcp (:9222 CDP)
      → 站点返 302 to /login/2fa
   → outcome="didnt" + error="NEEDS_MANUAL_2FA"
   → 链止（不 fallback；2FA 是红线）
   → CC 提示用户本机 Chrome 完成 2FA
```

### 9.3 desktop（macOS ax → screenshotVlm 兜底）

```
CC → desktop(action="act", actions=[{ref:"@e7", type:"click"}])
   → DesktopChannel.act()
      → FallbackPlan: ax → appleScript → cgEvent → screenshotVlm
      → ax.invoke(@e7) → expect 视觉验证
         → worked → 链止，返成功
         → unknown（按钮未响应）→ 下一档 appleScript
         → ...
         → screenshotVlm 兜底（最后一次）
   → 返 { outcome: "worked"|"didnt", provider: "desktop.ax"|"desktop.cgEvent"|"desktop.vlm" }
```

### 9.4 launch-chrome（跨平台子命令）

```
$ lasso launch-chrome
   → runLaunchChromeCli() → detectChromePath()
      → macOS: /Applications/Google Chrome.app/...
      → Linux: /usr/bin/google-chrome
      → Windows: C:\Program Files\Google\Chrome\...
   → spawn chrome --remote-debugging-port=9222 ...
   → 输出 "Chrome ready at http://127.0.0.1:9222"
```

## 10. 关键路径文件索引

| 模块 | 主文件 | 行数 |
|---|---|---|
| Tool 注册 | src/index.ts | ~1000 |
| Tool handler | src/tools/{search,browse,desktop,admin,doctor}.ts | — |
| Channel 层 | src/channels/{BaseChannel,UiChannel}.ts | — |
| BrowseChannel | src/browse/BrowseChannel.ts | — |
| DesktopChannel | src/desktop/AxProvider.ts | ~250 |
| AxBackend 契约 | src/desktop/AxBackend.ts（含三平台 backend class） | ~250 |
| AxBackendFactory | src/desktop/AxBackendFactory.ts（INV-60 单一真源） | ~110 |
| OutlineMapper | src/desktop/OutlineMapper.ts（三平台共享，INV-61） | ~120 |
| FallbackDecider | src/fallback/FallbackDecider.ts | ~280 |
| Forest 调度 | src/forest/RootRegistry.ts（INV-24） | — |
| RecordingStore | src/serp/RecordingStore.ts（v0.9；v1.0 不改） | ~260 |
| replay-baseline | src/serp/replay-baseline.ts（v1.0 录制回放回归） | ~280 |
| Launcher | src/launcher/{launch-chrome,chrome-paths}.ts（INV-64 不引新 npm dep） | ~200 |
| Doctor | src/doctor/doctor.ts（v1.0 32 项 check） | ~1800 |
| Invariants | src/invariants/check-invariants.mjs（65 条 INV） | ~2700 |
| Rust helper | rust-helper/src/{ax,uia,atspi,applescript,cgevent,screenshot,tcc,windows,main,ax_role_map}.rs | ~3500 |

## 11. 版本与发布

- **当前版本**：`1.0.0`（v1.0 稳定发布；2026-07-22）
- **version 真源**：`package.json` + `src/index.ts:LASSO_SERVER_VERSION` + `src/doctor/doctor.ts:LASSO_VERSION`（INV-63 守：三处必字面量一致）
- **doctor readiness**：32 项 check 全 pass → `ready: true`
- **跨平台 backend**：macOS 本机全证；Win/Linux 编译可证 + 契约可证，真机执行待社区反馈（parse11-acceptance.md 手测清单）

## 12. 相关文档

- [README.md](./README.md) — 用户手册（安装 / 配置 / 工具列表 / 隐私 / 故障排查）
- [doc/08 功能架构](./../doc/08-media-interact-功能架构.md) — 权威架构基线（F 编号、能力矩阵）
- [doc/09 实施排期](./../doc/09-media-interact-实施排期.md) — v0.1 → v1.0 能力跃升路径与决策记录
- [doc/13 全交互重设计](./../doc/13-全交互抓手重设计.md) — 桌面演进设计
- [doc/TROUBLESHOOTING.md](./doc/TROUBLESHOOTING.md) — FAQ + error_kind 释义
- [doc/SELECTOR-MAINTENANCE.md](./doc/SELECTOR-MAINTENANCE.md) — selector 债维护手册

---

本文档是 Lasso v1.0 架构概览（user-first；2026-07-22）。深度架构基线（含 F 编号 / 不变量推导链 / 测试策略）见 [`doc/08`](./../doc/08-media-interact-功能架构.md)；v0.1 → v1.0 实施排期（含每 phase 决策记录）见 [`doc/09`](./../doc/09-media-interact-实施排期.md)。
