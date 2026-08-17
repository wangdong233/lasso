# Lasso 架构

> 本文是 Lasso v1.13 的架构概览（user-first；深度架构基线见 [`doc/08`](./../doc/08-media-interact-功能架构.md)；实施排期与决策记录见 [`doc/09`](./../doc/09-media-interact-实施排期.md)；五轮最优性审查全记录见 [`doc/19`](./doc/19-最优性审查轮次/00-总结.md)）。

## 1. 项目定位

Lasso 是 Claude Code 的**全交互**对外抓手 MCP（浏览器 + 桌面）。与 [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp)（图像抓手）双子星：

- media-gen-mcp：「所有图像操作归一个 MCP」（生成 + 识别）
- **Lasso**：「所有外部交互归一个 MCP」（浏览器 + 桌面）

四通道：`search` / `browse_headless` / `browse_logged_in` / `desktop`（+ 条件解锁的 `browse_cloud_steel` 云通道）。所有通道共享同一套 fallback 范式 / 状态模型 / 工具风格（R-CI-02 红线：禁第二套做法）。

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
│  │   desktop / admin / doctor / fetch_url / network / ...    │  │
│  │   每工具 Zod inputSchema + ToolAnnotations 完整           │  │
│  └────────────────────────┬─────────────────────────────────┘  │
│                           │ typed call                          │
│  ┌────────────────────────▼─────────────────────────────────┐  │
│  │  Channel Layer（src/channels/ + src/browse/ + src/desktop/│  │
│  │   + src/search/ + src/logged-in/）                        │  │
│  │   BaseChannel ← UiChannel ← BrowseChannel                 │  │
│  │        ← HeadlessChannel / LoggedInChannel / SteelChannel │  │
│  │        ← SearchChannel / DesktopChannel                   │  │
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
│  │   chrome-devtools-mcp@1.7.0（headless / logged_in /       │  │
│  │     Steel / browserbase 各自 registerSpec）               │  │
│  │   lasso-rust-helper（AXAPI/UIA/AT-SPI + cgEvent           │  │
│  │     + screenshot + TCC）                                  │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬─────────────────────────────────┘
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
 chrome-devtools-mcp      智谱/Brave/Bing/SERP      lasso-rust-helper
 @1.7.0（--headless /     兜底（search 多引擎        （macOS AXAPI +
 --browser-url / Steel    经 HTTP；machine_mcp      cgEvent；Windows UIA；
 CDP / --wsEndpoint）     复用打头）                 Linux AT-SPI）
```

### 2.1 浏览器驱动契约锁：chrome-devtools-mcp 1.7.0（v1.11 迁移）

`src/subprocess/SubprocessManager.ts` 的 `LOCKED_CDP_MCP_VERSION = "1.7.0"` 是唯一真源，启动时经 `npx -y chrome-devtools-mcp@1.7.0` 自动拉取。v1.11 从 0.3.0 → 1.7.0 的一次性迁移（11 个月 / 57 个上游版本）要点：

- `--chromeArg` 透传机制解锁：launch 级 `--user-agent` / `--viewport` / `--accept-lang` 直达 Chromium（stealth 与反节流都靠它）
- 全部 spec 显式 `--no-usage-statistics`（1.7.0 默认采集使用统计，Lasso 关掉——隐私不倒退，INV-79(b) 守）
- Browserbase 改 `--wsEndpoint`（与 `--browser-url` 互斥，wss 语义保障，INV-79(c) 守）
- **network 原生化**：`network` 工具从 JS 层 PerformanceObserver 注入改为原生 `list_network_requests`（CDP Network 域）——fake-ip / TUN 代理网络「抓不全」的限制关闭；per-request `method/status/reqid`
- **console 实装**：`list_console_messages`（原生工具，v1.11 前是占位）

迁移守护 = INV-79（版本锁 / 遥测关 / wsEndpoint / launch 级 stealth / 零哑 flag 回潮五面）。

## 3. 核心抽象

### 3.1 BaseChannel / UiChannel 分层

```
BaseChannel                         （src/channels/BaseChannel.ts）
  ├── SearchChannel                 （只通用层；不进 UI）
  └── UiChannel                     （src/channels/UiChannel.ts）
       ├── BrowseChannel            （browse_headless + browse_logged_in + cloud 复用）
       ├── HeadlessChannel
       ├── LoggedInChannel
       ├── SteelChannel             （v1.6 自托管云浏览器；extends BrowseChannel 平级兄弟）
       └── DesktopChannel           （desktop 4 档 fallback：ax → appleScript → cgEvent → screenshotVlm）
```

UI 通道共享 UiChannel 的状态写盘 / LRU / output envelope 机制；Search 只走通用层（无 UI 状态概念）。**INV-2 守：所有 XxxChannel 必须 extends BaseChannel**（不绕过）。

### 3.2 CapabilityBag（运行时动态启停）

`src/runtime/CapabilityBag.ts`（v0.6+）：通道运行时可 enable/disable，无需重启进程。`admin` tool 提供 `channel_health` / `reset` action；v1.12 起动态注册工具的时延/错误入 metrics 观测窗（`toolManager.setMetrics` 接线）。**INV-37 守：admin tool 必经 toolManager.register（不直调 server.tool）**。

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

铁律：**event delivery ≠ semantic success**（INV-13）。例如 `desktop act` 调用 AXPress 不报错（event delivered），但目标按钮没有真的被点（disabled / obscured）→ 必须 `expect` 验证后置条件，failed 时 `outcome=didnt` 终止链。v1.11 起 expect 真接线（schema 早承诺、v1.0 零消费）；v1.12 起 **wait / expect 需连续 2 次命中才算**（稳定性采样——加载闪现元素不再假成功）。

### 3.4 StateStore LRU(128)

页面 DOM / 桌面 OutlineNode 不灌 CC 上下文，而是写本地磁盘（`~/.cache/lasso/state/`），返回 `state_id`。CC 后续 `act` / `find` 经 `state_id` 引用 → **4× token 效率**。LRU(128) 自动淘汰旧状态。desktop 侧另有 `skeleton:true` 树剪枝（v1.11：被 max_depth 剪掉的子树折叠为边界节点 + childrenCount）与顶层 `truncated:true` 诚实信号（v1.12：仅真剪掉子树时出现）。

### 3.5 stealth 体系（v1.5 → v1.13 演进）

`src/browse/StealthEngine.ts` + `src/browse/stealth-profiles.ts`：

- **v1.5**：16 路 evasions（12 路 vendored from puppeteer-extra-plugin-stealth@2.11.2，MIT 头保留）+ profile 附 header 集（secChUa / secFetch* / accept*；UA↔secChUa↔userAgentData.brands 三方一致，INV-73 守）
- **v1.11**：launch 级 stealth——经 `--chromeArg` 下发 `--user-agent` / `--viewport`，网络层 HTTP 头与 JS 层 `navigator.*` 同源同值；值域刷新到 2026-07 stable 时代（Chrome 151 / Safari 27 冻结 token / Firefox 153，profile key 名不动）
- **v1.12**：`mac_chrome` profile + `defaultHeadlessProfileForHost()`——darwin 默认指纹与宿主系统对齐（消除「UA 说 Windows、低熵 client hints 招供 macOS」）
- **v1.13**：`--accept-lang` 透传 + `navigator.languages` 档案感知——HTTP 头与 JS 层语言同源同值（消除「头 zh-CN ↔ 页面 en-US」自矛盾指纹）
- **回归门禁**：doctor #38 `stealth_creepjs_regression`（opt-in `--stealth-check`，creepjs lies 基线零容忍退化，INV-75 守）+ self-check 的宿主 Chrome 版本 skew hint（|skew|≥2 建议刷新）与 UA 年龄提示

### 3.6 生命周期与稳定性（v1.9 → v1.13）

- **无头浏览器**：空闲 5 分钟自动回收（`LASSO_HEADLESS_IDLE_MS`，v1.9；touchKeepalive 防误杀）
- **launch-chrome**：台账（`launched-chromes.json`）+ `lasso chrome-stop`（只杀 cmdline 验证归属的 pid，防 pid 复用误杀，v1.9）；hidden 档默认 + 最后使用后 ~60s 自动关（`LASSO_LAUNCH_MODE` / `LASSO_LAUNCH_IDLE_MS`，v1.10）；`admin tab_restore` 恢复用户原 tab（红线：不关用户原有 tab）
- **stdin-EOF 收尾**（v1.12）：CC 异常退出 → 父进程死 → stdin EOF → 复用幂等 shutdown；受管子进程不再孤儿到 zombie reaper 1h 阈值（上游 SDK #2002 的进程侧缓解）
- **停机链全路径有界**（v1.13）：Steel 会话释放双层 3s 上界（停机链 race 3s + fetch `AbortSignal.timeout(3s)`）——自托管 Steel 停摆/endpoint 悬挂（实测可挂 ~301s）不再拖死退出
- **`LASSO_PROXY` 出口代理**（v1.11）：headless 经 `--proxy-server`、Steel 经 session `proxyUrl`；**`browse_logged_in` 永不读取**（用户真实 Chrome 出口原样，铁律）；doctor `proxy_config` 回显

## 4. desktop：四档新实现（v1.11 → v1.13，从「能看」到「能点」）

```
AxBackend interface（三平台同构 OutlineNode 契约）
   ├── MacAxBackend       → rust.call("ax_*")          → rust-helper/src/ax.rs      [cfg(macos)]
   ├── WinUiaBackend      → rust.call("uia_*")         → rust-helper/src/uia.rs     [cfg(windows)]
   └── LinuxAtspiBackend  → rust.call("atspi_*")       → rust-helper/src/atspi.rs   [cfg(linux)]
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

四档 fallback（`DesktopChannel` 内）：

1. **tier-1 ax（AXAPI 语义）**：v1.11 真实现（v0.3.5 起的 invoke 占位废除）——click / type / press / scroll / hotkey 经 AXAPI 语义执行 + **写后读回验证**（secure 字段豁免）；逐项结果 `actions_and_results`；全败且含 stale_ref → `didnt`（UI 已变，引导重新 observe）。type 语义 = **整值替换**（AXSetValue，非追加）。
2. **tier-2 appleScript**：白名单脚本档（INV-27 守）。
3. **tier-3 cgEvent（坐标鼠标）**：v1.11 新——`click{x,y,button}` / `drag{from→to}` / `move{x,y}` / `scroll{dx,dy[,x,y]}`；坐标 = snapshot rect 中心；canvas / Electron 自绘 UI 兜底，@wN 透传链同样支持坐标形态。v1.12 拖拽物理质量：按下 200ms + 12 点线性插值轨迹（每点 16ms）+ 100ms 沉淀 + clickState（`rust-helper/src/cgevent.rs`）。macOS 15+ 需 Event Synthesizing TCC 授权（缺失 → `tcc_event_synthesis_denied` 明确报错，doctor #21 专查）。
4. **tier-4 screenshotVlm（VLM 链尾）**：截图推断 → 容错解析为坐标动作 → `cgevent_dispatch` **真执行**（v1.12 闭环）；不可解析 / 执行失败 → 诚实 `unknown`（`vlm_inference_only:*`，推断原文附 data 不浪费）——不再「调用成功即 worked」假成功。v1.13 起 `screenshot_region` 场景 VLM 区域相对坐标平移回全局坐标（修系统性偏移）。

**Electron 输入兜底**（v1.12，档内降级）：AX 不可用（Electron 吞 AXSetValue，Slack / VSCode 典型）时「聚焦 + cmd+a 全选 + 逐字符键盘合成」（ASCII）；`ax_verify_failed` 不兜底（保持失败诚实）。

**find 语义**（v1.12/v1.13）：命中节点附 `actions:[...]`（AX 动作名）；`where` 只认 text / role——纯 ref 查询双端夹击报 `invalid_params`（TS zod 删字段 + Rust 兜底，防绕过 zod 直发 wire；此前静默退化成全树命中 + token 爆炸还装成功）。

**跨平台边界**：macOS 真机验证；Win/Linux 编译可证（cfg-gate + `cargo check --target`）+ 契约可证，真机完整手测待社区反馈（不伪造）。

**关键设计决策**（守简单性 02 §5 R-CI-02 + §6.1 R-FF-01）：

1. **不重写 AxBackend interface**。`snapshot / find / act` 三方法契约自 v0.3.5 稳定至今；升级只加实现细节（skeleton / 坐标动作 / 读回验证），不破契约。
2. **不在 TS 层做平台分支**。`AxProvider` 不 `if (platform === 'win32')`；`AxBackendFactory.create()` 经 `platform-detect.ts` 路由。**INV-21 守：src/**/*.ts 无平台字面量**（AXUIElement / CGEvent / libatspi 都隔离在 rust-helper/*.rs）。
3. **不渗 OutlineMapper 到 backend 内**。OutlineMapper 三平台共享同一个（INV-61 守）；Rust 端三平台都返同形 AxNode JSON。
4. **不引 electron / tauri 跨平台 AX 抽象**。它们抽象太厚（带 IPC / window management），Lasso 只需「读 AX 树 + act 节点」，薄壳足够（02 §5 R-ABS-01 错误抽象警惕）。
5. **Windows UIA 用官方 `windows` crate（microsoft/windows-rs）**；**Linux AT-SPI 用 `atspi` crate（odilia-app）**（pure Rust via zbus D-Bus，无 C 依赖，CI Linux headless 可编）。

## 5. 设计原则（08 §0）

1. **能力导向命名**：search / browse_* / desktop（不按后端命名）
2. **页面/界面状态写磁盘**：4× token 效率
3. **减少推理调用**：多步链式（如 search → click → extract）一次工具调用完成
4. **fallback 对 CC 透明**：CC 只看到 `worked / didnt`，不感知降级细节
5. **诚实三态交付**：`worked / didnt / unknown`（unknown 是 fallback 触发器）；假成功零容忍（expect 稳定性采样 / VLM 链尾诚实化 / find 拒纯 ref 同族）
6. **零侵入跟随上游**：chrome-devtools-mcp 升级时 Lasso 不改业务（契约锁版本，当前 1.7.0）
7. **第二套做法红线**（R-CI-02）：横切关注点变体只允许一套（fallback 范式 / state 模型 / dispatch Map / provider registry 等）
8. **不变量脚本化**（CI 守门）：**79 条 INV** 静态 grep + 形状测，防 refactor 回退；另有 `inv-selftest`（见 §7）
9. **平台差异隔离在 backend 内部**：AxBackend 三平台同构 OutlineNode 契约；TS 层零平台字面量

## 6. 边界（08 §7）

Lasso 明确**不做**以下事情：

- **不解 2FA**：站点要求 2FA 时返 `NEEDS_MANUAL_2FA`（red line；不让 CC 尝试绕过）
- **不做「全坐标 grounding」方案**：desktop 以语义 AX tree 为主路径（tier-1）；坐标形态 `{x,y}`（取 snapshot rect 中心）只是 tier-3 cgEvent 的**兜底**，服务 canvas / Electron 自绘 UI 与 VLM 链尾（v1.11 T7）——不采用「截图 + 坐标识别」为主路径的脆弱方案
- **不做 RRF 融合 / corpus 持久化**：search 是 hit + wayback 兜底，不是 RAG
- **不导出 cookie**：`browse_logged_in` 的 cookie 留本机 Chrome（除用户显式 opt-in `admin` action 且经 AES-256-GCM 加密）
- **托管型云浏览器默认关**：cloud 通道必经 `LASSO_ALLOW_CLOUD_BROWSER=true` manual-switch + 端点/key 双重解锁（INV-25/74 守）。其中 **Steel 是自托管**（Apache-2.0 开源、本地 Docker、零 per-session 费、cookie 不出本地，v1.6）——与托管型（browserbase / stagehand，付费）区分；stagehand 是程序化实验通道（无 MCP 工具入口，doctor #39 探测 REST 契约）
- **macOS 先行**：Win/Linux backend 编译可证（cfg-gate + `cargo check --target`），真机执行待社区反馈（不伪造）

## 7. 测试策略

| 层 | 工具 | 覆盖 | 规模（v1.13 终态） |
|---|---|---|---|
| 架构不变量 | `check-invariants.mjs`（自写） | INV-1..79 静态 grep + 形状测 | **79 条** |
| INV 自测 | `inv-selftest.mjs`（`npm run inv-selftest`） | 抽样 INV 做「注入违规 → 必红」复证（外部契约类全覆盖：INV-68/71/76/79 等） | **14 样本**（v1.13 由 10 扩；未验证的其余 pin 显性化报告——按需补样） |
| TS 单测 | vitest | channel / fallback / forest / doctor / launcher / outline-contract / replay-baseline / stealth / lifecycle / cdp-actions | **1961 测试**（122 文件，1960 passed + 1 skipped） |
| Rust 单测 | cargo test | ax / applescript / cgevent(+keymap) / screenshot / tcc / windows / protocol / role-map | **207 测试** |
| 跨平台编译 | cargo check --target | Windows (x86_64-pc-windows-msvc) + Linux (x86_64-unknown-linux-gnu) | CI Linux runner |
| 录制回放回归 | npm run replay-baseline | fixtures/serp-baseline/ × 三引擎 × 多 query | 12+ fixtures |
| 故障注入 | vitest | fallback 链 / 限流 / 政策 gate / SERP 改版 | ~20 场景 |
| 契约锁 | chrome-devtools-mcp@**1.7.0** version pin（`LOCKED_CDP_MCP_VERSION` 单一真源） | 上游小版本升级不破 Lasso；迁移要点见 §2.1 | SubprocessManager.ts |

## 8. 不变量（79 条）分类

| 范畴 | INV 编号 | 守的是什么 |
|---|---|---|
| 单一真源（grep 守 class / type 只在一处定义） | INV-3 / 9 / 24 / 60 | ProviderConfig / ProviderRegistry / RootRegistry / AxBackendFactory |
| 禁第二套（横切关注点变体只允许一套） | INV-4 / 6 / 23 / 33 | FallbackDecider / dispatch Map / 跨 surface fallback / pdf dispatch |
| 平台隔离（src/**/*.ts 无平台字面量） | INV-21 / 60 / 61 | TS 层无 AXUIElement/CGEvent/UIAutomationClient |
| 隐私红线 | INV-15 / 43 / 48..53 / 57 / 62 | output envelope 0o600 / 零遥测 / cookie AES-256-GCM / 录制 opt-in / 禁录 logged_in |
| 安全红线 | INV-14 / 25 / 27 / 30 / 31 / 32 | HIGH_RISK_PATTERNS / cloud 双重解锁 / appleScript 白名单 / stealth profiles / SSRF / 连接池 |
| 诚实交付 | INV-13 / 19 | expect failed 必须 didnt + 终止 / OutlineNode 同形异源 |
| v1.0 release polish | INV-63 / 64 / 65 | version 三处一致 / launcher 不引新 npm dep / README+ARCHITECTURE 必引用 08+09 |
| v1.1 LLM 友好抽取 | INV-66..69 | raw 默认 byte-identical / extractor 内部件封装 / markdown 引擎禁第三运行期 / 引用角标零 crawl4ai 依赖 |
| v1.2-v1.4 配置与复用 | INV-70 / 71 / 72 | interactiveOnly opt-in 剪枝 byte-identical / config 文件机制（扁平 JSON + env 覆盖）/ 机器 MCP 复用安全（只读不写、永不 log Authorization） |
| v1.5-v1.7 反检测与云通道 | INV-73 / 74 / 75 | stealth 16 路一致性 + Headless 接线 / Steel 通道零回归（单独导出 + 双重解锁 + mutex）/ creepjs 门禁纯 doctor 侧零回归 |
| v1.8 wave 修复守护 | INV-76 | 上游 0.3.0 契约适配与接线回归（截图落盘 / launch 探活 / read_text 续页等） |
| v1.9 浏览器生命周期 | INV-77 | 台账 + chrome-stop 归属验证 / tab 快照恢复三守卫 / 树杀原语单一真源 |
| v1.10 静默启动与回收 | INV-78 | hidden 档 flag 集不漂移 / idle reaper 零第二 kill 原语 / 激活路径禁令 |
| v1.11 1.7.0 迁移守护 | INV-79 | 版本锁 1.7.0 / 遥测关 / --wsEndpoint / launch 级 stealth / 零哑 flag 形态 |

完整 INV 列表 + 释义见 `src/invariants/check-invariants.mjs` 顶部注释。

## 9. 数据流（典型场景）

### 9.1 search（多引擎 fallback，v1.4/v1.11 后）

```
CC → search("rust async 最新动态", freshness="week")
   → SearchChannel.run()
      → FallbackChain: machine_mcp（本机已配智谱 MCP 自动复用，最高优先）
        → 智谱 → Brave → Bing
        → SERP 实搜兜底（query 语言分流：CJK→百度，非 CJK→DuckDuckGo 纯 HTML 端点，零 Key；
          DDG 跳转壳 uddg= 自动解包）
        → Wayback → RecordingStore replay
      → freshness（day/week/month/year）全链透传且入 cache key（不同时效不互相污染）
   → 返 { outcome: "worked", entries: [...], engine: "..." }
```

### 9.2 browse_logged_in（2FA 场景）

```
CC → browse_logged_in("https://app.example.com", action="snapshot")
   → LoggedInChannel.run() → chrome-devtools-mcp@1.7.0 (:9222 CDP)
      → 站点返 302 to /login/2fa
   → outcome="didnt" + error="NEEDS_MANUAL_2FA"
   → 链止（不 fallback；2FA 是红线）
   → CC 提示用户本机 Chrome 完成 2FA
```

### 9.3 desktop（macOS 四档：语义优先、坐标兜底）

```
CC → desktop(action="act", actions=[{ref:"@e7", type:"click"}])
   → DesktopChannel.act()
      → tier-1 ax：AXPress 语义执行 + 写后读回验证
         → worked → 链止，返成功（expect 后置条件连续 2 次命中才确认）
         → stale_ref 全败 → didnt（UI 已变，引导重新 observe）
      → tier-2 appleScript（白名单脚本）
      → tier-3 cgEvent：坐标动作 {x,y}（snapshot rect 中心）/ drag 12 点插值轨迹
      → tier-4 screenshotVlm：截图推断 → 解析为坐标动作 → cgevent_dispatch 真执行
         → 不可解析/执行失败 → unknown（vlm_inference_only:*，触发降级或人接管）
   → 返 { outcome, provider: "desktop.ax"|"desktop.appleScript"|"desktop.cgEvent"|"desktop.vlm" }
```

### 9.4 launch-chrome（跨平台子命令）

```
$ lasso launch-chrome
   → runLaunchChromeCli() → detectChromePath()
      → macOS: /Applications/Google Chrome.app/...
      → Linux: /usr/bin/google-chrome
      → Windows: C:\Program Files\Google\Chrome\...
   → spawn chrome --remote-debugging-port=9222 ...（hidden 档 + 反节流三件套 + 静音）
   → 探活 CDP /json/version → 台账登记 → server 运行期最后使用后 ~60s 自动关
```

## 10. 关键路径文件索引

| 模块 | 主文件 | 行数（v1.13 量级） |
|---|---|---|
| Tool 注册 / 生命周期 | src/index.ts（stdin-EOF 收尾 / reaper / Steel 3s 上界） | ~1400 |
| Tool handler | src/tools/{search,browse,desktop,admin,doctor,network,fetch-url}.ts | — |
| Channel 层 | src/channels/{BaseChannel,UiChannel}.ts | — |
| BrowseChannel 族 | src/browse/BrowseChannel.ts；HeadlessChannel（launch 级 stealth + 宿主对齐 profile）；SteelChannel（session mutex + proxyUrl） | — |
| stealth | src/browse/{StealthEngine,stealth-profiles}.ts（16 路 + 4 profile + 值域 2026-07） | — |
| markdown 抽取 | src/browse/markdown-extractor.ts（defuddle 双激活 + turndown 降级保底） | — |
| desktop 四档 | src/desktop/{AxProvider,AxBackend,AxBackendFactory,OutlineMapper,CGEventProvider,ScreenshotVlmProvider}.ts | AxProvider ~330 |
| FallbackDecider | src/fallback/FallbackDecider.ts | ~280 |
| 搜索 | src/search/{SearchCache,MultiSourceFanout}.ts；src/channels/{ZhipuChannel,BraveChannel,BingChannel}.ts；src/serp/extract.ts（DDG→Brave 级联/百度兜底，v1.14 S-4） | — |
| Launcher | src/launcher/{launch-chrome,chrome-paths}.ts（INV-64 不引新 npm dep） | ~200 |
| Doctor | src/doctor/doctor.ts（39 项 check；#21 event-synthesis / #36 machine_mcp / #37 steel / #38 creepjs / #39 stagehand / proxy_config） | ~2900 |
| Invariants | src/invariants/check-invariants.mjs（79 条 INV） | ~4200 |
| INV 自测 | scripts/inv-selftest.mjs（14 样本红转复证） | ~280 |
| Subprocess | src/subprocess/SubprocessManager.ts（`LOCKED_CDP_MCP_VERSION = "1.7.0"`） | ~730 |
| Rust helper | rust-helper/src/{ax,uia,atspi,applescript,cgevent,cgevent_keymap,screenshot,tcc,windows,protocol,main,ax_role_map,app_bundle_map}.rs | ~5000 |

## 11. 版本与发布

- **当前版本**：`1.13.0`（v1.13 最优性审查第 3-5 轮收敛；2026-08-17 发布 npm latest）
- **version 真源**：`package.json` + `src/index.ts:LASSO_SERVER_VERSION` + `src/doctor/doctor.ts:LASSO_VERSION`（INV-63 守：三处必字面量一致）
- **doctor readiness**：39 项 check 全 pass → `ready: true`（检查项随版本增长，以实跑为准）
- **跨平台 backend**：macOS 本机全证；Win/Linux 编译可证 + 契约可证，真机执行待社区反馈
- **门禁四链**：`npm run build` / `npm test`（1961）/ `npm run check-invariants`（79）/ `npm run inv-selftest`（14）+ `cargo test`（207）

## 12. 五轮最优性审查（doc/19，v1.10 → v1.13 的质量主线）

2026-08-15 → 08-17 对全仓做了五轮「四域（arch / browser / desktop / search）白盒复审 → 裁决 → 实施 → 独立审查」循环，候选调优项轨迹 **16 → 14 → 7 → 1 → 0 单调收敛**（round5 终裁 ROUND-CLEAN）。四维结论：**技术选型 / 架构 / 范围 / 实施全部最优**（五轮零翻案零漂移）。

- **落地量**：38 项调优（round1 16 + round2 14 + round3 7 + round4 1）+ 2 rider + W-3 分桶 + 2 处审查修复，全部经独立审查验收（round1 ROUND-PASS 修 2🔴+4 次要；round2/3/4 zero-issues-pass）
- **版本轨迹**：v1.10.0（1801 TS / 78 INV）→ v1.11.0（1906 / 79 / 193 Rust，commit `0b07536`）→ v1.12.0（1941 / 79 / 202，工作树）→ v1.13.0（**1961 / 79 / 207 / selftest 14**，commit `a9eb106`，npm latest）
- **量级修复代表**：chrome-devtools-mcp 0.3.0→1.7.0 迁移、desktop 从「能看」到「能点」（ax_act 真实现 + 坐标鼠标 + VLM 真执行）、stealth launch 级一致性、network 原生化、stdin-EOF 收尾、Steel 3s 上界、假成功族清零（VLM 链尾 / wait 采样 / find 拒纯 ref / VLM region 偏移）
- **方法学沉淀**（供复用）：裁决官不采信文档（关键声称白盒双源亲验，五轮零虚报）；证据阶梯 L0-L3（注释不得承载运行时结论）；mutation 即验收（删守卫 → 旧实现仍绿 = 缺陷坐实）；「先拿事实再加参数」（上游实证失败 ≠ 本侧实测失败）；收敛协议前置（round4 写死终止条件防「为找事而立项」）

全记录：[`doc/19-最优性审查轮次/`](./doc/19-最优性审查轮次/00-总结.md)（30 份在档：四域调研 / 裁决 / 实施 / 审查 / 手测清单 / 冒烟脚本）。

## 13. 相关文档

- [README.md](./README.md) — 用户手册（安装 / 配置 / 工具列表 / 隐私 / 故障排查）
- [doc/08 功能架构](./../doc/08-media-interact-功能架构.md) — 权威架构基线（F 编号、能力矩阵）
- [doc/09 实施排期](./../doc/09-media-interact-实施排期.md) — v0.1 → v1.13 能力跃升路径与决策记录
- [doc/19 最优性审查轮次](./doc/19-最优性审查轮次/00-总结.md) — 五轮审查全记录（v1.10 → v1.13 质量主线）
- [doc/13 全交互重设计](./../doc/13-全交互抓手重设计.md) — 桌面演进设计
- [doc/TROUBLESHOOTING.md](./doc/TROUBLESHOOTING.md) — FAQ + error_kind 释义
- [doc/SELECTOR-MAINTENANCE.md](./doc/SELECTOR-MAINTENANCE.md) — selector 债维护手册

---

本文档是 Lasso v1.13 架构概览（user-first；2026-08-17 同步）。深度架构基线（含 F 编号 / 不变量推导链 / 测试策略）见 [`doc/08`](./../doc/08-media-interact-功能架构.md)；v0.1 → v1.13 实施排期（含每 phase 决策记录）见 [`doc/09`](./../doc/09-media-interact-实施排期.md)。
