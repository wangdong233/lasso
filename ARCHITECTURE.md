# Lasso 架构

> 本文是 Lasso **v1.17.2** 的架构概览（user-first；深度架构基线见 [`doc/08`](./doc/08-media-interact-功能架构.md)（冻结于 2026-07-21，头部有现状对齐横幅）；实施排期与决策记录见 [`doc/09`](./doc/09-media-interact-实施排期.md)；doc/ 目录导读见 [`doc/README.md`](./doc/README.md)）。

## 1. 项目定位

Lasso 是 Claude Code 的**全交互**对外抓手 MCP（浏览器 + 桌面 + 本地私有数据）。与 [media-gen-mcp](https://github.com/wangdong233/media-gen-mcp)（图像抓手）双子星：

- media-gen-mcp：「所有图像操作归一个 MCP」（生成 + 识别）
- **Lasso**：「所有外部交互归一个 MCP」（浏览器 + 桌面 + 搜自己的机器）

**工具面（17 个 MCP 工具，`tools/list` 实跑核）**：`search / browse_headless / browse_logged_in / desktop / fetch_url / screenshot / pdf / network / read_text / search_local / wayback_lookup / fetch_feed / doctor / interact_roots / interact_observe / interact_act / admin`（另有 `browserbase` / `steel` 两个云通道工具按环境条件解锁，不在默认清单；对应 channel 名 `browse_cloud_browserbase` / `browse_cloud_steel`）。

四条交互通道：`search` / `browse_headless` / `browse_logged_in` / `desktop`，加 **`search_local` 本地私有搜索**（doc/24 裁决 B1「第四通道」：Chrome 历史 / Spotlight 文件，纯本地只读）与条件解锁的 `browse_cloud_steel` 云通道。所有通道共享同一套 fallback 范式 / 状态模型 / 工具风格（R-CI-02 红线：禁第二套做法）；`search_local` 是唯一例外——纯本地只读查询无网络面、无 fallback 语义，走「工具直连」范式（照 `read_text` / `doctor-tool` 先例，不建 Channel 子类，防空壳对称 R-ABS-01）。

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
│  │  Tool Layer（src/tools/，17 工具）                         │  │
│  │   search / browse_headless / browse_logged_in / desktop   │  │
│  │   search_local / fetch_url / fetch_feed / wayback_lookup  │  │
│  │   screenshot / pdf / network / read_text / interact_*     │  │
│  │   doctor / admin — 每工具 Zod schema + ToolAnnotations    │  │
│  └────────────────────────┬─────────────────────────────────┘  │
│                           │ typed call                          │
│  ┌────────────────────────▼─────────────────────────────────┐  │
│  │  Channel Layer（src/channels/ + src/browse/ + src/desktop/│  │
│  │   + src/search/ + src/search-local/ + src/logged-in/）    │  │
│  │   BaseChannel ← MachineMcpSearchChannel / BraveChannel    │  │
│  │   BaseChannel ← UiChannel                                 │  │
│  │        ← BrowseChannel（abstract）                        │  │
│  │            ← HeadlessChannel / LoggedInChannel            │  │
│  │            / SteelChannel / BrowserbaseChannel            │  │
│  │        ← StagehandChannel / DesktopChannel                │  │
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
│  │   lasso-rust-helper（AXAPI/UIA/AT-SPI + cgEvent          │  │
│  │     + screenshot + TCC）                                  │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬─────────────────────────────────┘
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
 chrome-devtools-mcp      search 多源链（HTTP）：      lasso-rust-helper
 @1.7.0（--headless /     machine_mcp → brave →       （macOS AXAPI +
 --browser-url / Steel    serp_http 快探 →            cgEvent；Windows UIA；
 CDP / --wsEndpoint）     browse_headless 实搜        Linux AT-SPI）
                          → recording replay
                          （+ search_local 纯本地源）
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
  ├── MachineMcpSearchChannel       （机器 MCP 复用；只通用层，不进 UI）
  ├── BraveChannel                  （Brave API 源；只通用层，不进 UI）
  └── UiChannel                     （src/channels/UiChannel.ts）
       ├── BrowseChannel            （abstract；browse_headless + browse_logged_in + cloud 复用）
       │    ├── HeadlessChannel
       │    ├── LoggedInChannel
       │    ├── SteelChannel        （v1.6 自托管云浏览器；extends BrowseChannel 平级兄弟）
       │    └── BrowserbaseChannel  （v1.11 --wsEndpoint 契约）
       ├── StagehandChannel         （程序化实验通道，无 MCP 工具入口）
       └── DesktopChannel           （desktop 4 档 fallback：ax → appleScript → cgEvent → screenshotVlm）
```

UI 通道共享 UiChannel 的状态写盘 / LRU / output envelope 机制；Search 只走通用层（无 UI 状态概念，`MachineMcpSearchChannel` / `BraveChannel` 直接 extends BaseChannel；v1.17 A3 后 `channels/SearchChannel.ts`〔zhipu 直连〕已删，INV-80 墓碑）。`search_local` 不进 Channel 层（见 §1）。**INV-2 守：所有 XxxChannel 必须 extends BaseChannel**（不绕过）。

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

页面 DOM / 桌面 OutlineNode 不灌 CC 上下文，而是写本地磁盘（`~/.cache/lasso/<run_id>/<channel>-<stateId>.json`，`src/util/state-store.ts`），返回 `state_id`。CC 后续 `act` / `find` 经 `state_id` 引用 → **4× token 效率**。LRU(128) 自动淘汰旧状态。desktop 侧另有 `skeleton:true` 树剪枝（v1.11：被 max_depth 剪掉的子树折叠为边界节点 + childrenCount）与顶层 `truncated:true` 诚实信号（v1.12：仅真剪掉子树时出现）。

### 3.5 stealth 体系（v1.5 → v1.13 演进）

`src/browse/StealthEngine.ts` + `src/browse/stealth-profiles.ts`：

- **v1.5**：16 路 evasions（12 路 vendored from puppeteer-extra-plugin-stealth@2.11.2，MIT 头保留）+ profile 附 header 集（secChUa / secFetch* / accept*；UA↔secChUa↔userAgentData.brands 三方一致，INV-73 守）
- **v1.11**：launch 级 stealth——经 `--chromeArg` 下发 `--user-agent` / `--viewport`，网络层 HTTP 头与 JS 层 `navigator.*` 同源同值；值域刷新到 2026-07 stable 时代（Chrome 151 / Safari 27 冻结 token / Firefox 153，profile key 名不动）
- **v1.12**：`mac_chrome` profile + `defaultHeadlessProfileForHost()`——darwin 默认指纹与宿主系统对齐（消除「UA 说 Windows、低熵 client hints 招供 macOS」）
- **v1.13**：`--accept-lang` 透传 + `navigator.languages` 档案感知——HTTP 头与 JS 层语言同源同值（消除「头 zh-CN ↔ 页面 en-US」自矛盾指纹）
- **回归门禁**：doctor #38 `stealth_creepjs_regression`（opt-in `--stealth-check`，creepjs lies 基线零容忍退化，INV-75 守）+ self-check 的宿主 Chrome 版本 skew hint（|skew|≥2 建议刷新）与 UA 年龄提示

### 3.6 生命周期与稳定性（v1.9 → v1.13）

- **无头浏览器**：空闲 5 分钟自动回收（`LASSO_HEADLESS_IDLE_MS`，v1.9；touchKeepalive 防误杀）
- **launch-chrome**：台账（`launched-chromes.json`）+ `lasso chrome-stop`（只杀 cmdline 验证归属的 pid，防 pid 复用误杀，v1.9）；hidden 档默认 + 最后使用后 ~60s 自动关（`LASSO_LAUNCH_MODE` / `LASSO_LAUNCH_IDLE_MS`，v1.10）；`admin tab_restore` 恢复用户原 tab（红线：不关用户原有 tab；v1.17.1 修复恒 no-op 缺陷，双 targetId 守卫）
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

1. **能力导向命名**：search / browse_* / desktop / search_local（不按后端命名）
2. **页面/界面状态写磁盘**：4× token 效率
3. **减少推理调用**：多步链式（如 search → click → extract）一次工具调用完成
4. **fallback 对 CC 透明**：CC 只看到 `worked / didnt`，不感知降级细节
5. **诚实三态交付**：`worked / didnt / unknown`（unknown 是 fallback 触发器）；假成功零容忍（expect 稳定性采样 / VLM 链尾诚实化 / find 拒纯 ref / content_blocks 失败标注 / ref 失效诚实报错同族）
6. **零侵入跟随上游**：chrome-devtools-mcp 升级时 Lasso 不改业务（契约锁版本，当前 1.7.0）
7. **第二套做法红线**（R-CI-02）：横切关注点变体只允许一套（fallback 范式 / state 模型 / dispatch Map / provider registry 等）
8. **不变量脚本化**（CI 守门）：**81 条 INV** 静态 grep + 形状测，防 refactor 回退；另有 `inv-selftest` 20 样本「注入违规 → 必红」复证（见 §10）
9. **平台差异隔离在 backend 内部**：AxBackend 三平台同构 OutlineNode 契约；TS 层零平台字面量
10. **质量轴静态映射**（v1.17 A1）：`quality`（api/scrape/stale）按 `served_by` 静态映射，零启发式——宁缺毋假（查不到就不标）

## 6. 边界（08 §7）

Lasso 明确**不做**以下事情：

- **不解 2FA**：站点要求 2FA 时返 `NEEDS_MANUAL_2FA`（red line；不让 CC 尝试绕过）
- **不做「全坐标 grounding」方案**：desktop 以语义 AX tree 为主路径（tier-1）；坐标形态 `{x,y}`（取 snapshot rect 中心）只是 tier-3 cgEvent 的**兜底**，服务 canvas / Electron 自绘 UI 与 VLM 链尾（v1.11 T7）——不采用「截图 + 坐标识别」为主路径的脆弱方案
- **不做 RRF 融合 / corpus 持久化**：search 是 hit + 独立 wayback_lookup 工具，不是 RAG
- **search 主路径不调 Wayback**（INV-58）：死链恢复是独立工具 `wayback_lookup`，由 CC 显式调用
- **不导出 cookie**：`browse_logged_in` 的 cookie 留本机 Chrome（除用户显式 opt-in `admin` action 且经 AES-256-GCM 加密）
- **search_local 隐私红线**（INV-81，v1.17）：只读（源库禁写，唯一写面 mkdtemp 临时目录）/ 无全文导出字段（只返 title/url/时间/标题片段）/ limit 硬顶 50（无 dump 面板）/ 模块零网络 / 日志只记 query_len——浏览历史是高敏数据，工具暴露面即风险面
- **托管型云浏览器默认关**：cloud 通道必经 `LASSO_ALLOW_CLOUD_BROWSER=true` manual-switch + 端点/key 双重解锁（INV-25/74 守）。其中 **Steel 是自托管**（Apache-2.0 开源、本地 Docker、零 per-session 费、cookie 不出本地，v1.6）——与托管型（browserbase / stagehand，付费）区分；stagehand 是程序化实验通道（无 MCP 工具入口，doctor #39 探测 REST 契约）
- **macOS 先行**：Win/Linux backend 编译可证（cfg-gate + `cargo check --target`），真机执行待社区反馈（不伪造）

### 6.1 简单架构清单对齐（doc/17 §6 终判）

对照「简单架构清单」38 条（架构思想录 02/03 体系）逐行判定，ft-round1 全量测试轮终判（2026-08-18，R1 独立裁决官）：**✅27 / ⚠️11（全部有处置：修 1 + watch 6 + 接受理由 4）/ ❌0 / ⏸1**。三条 🔴 硬不变量全过：R-FF-01（import 图 467 边实跑零非法边）/ R-FF-02（值级 0 环）/ R-DEP-03（别名清除后 AST 扫 0 命中）。阈值均为起点值未校准。逐条格内裁决见 `doc/17-功能测试清单.md` §6。

## 7. 搜索域终态（v1.14 → v1.17.1）

v1.13 后搜索域经历四次结构性修订（doc/21 重审 → doc/22 死层清除 → doc/24 颠覆性调研 → doc/25 五项裁决），终态如下。

### 7.1 终态链与扇出（v1.17 A3 后）

```
engine=auto（默认）→ 多源扇出（machine_mcp + brave 两 API 源）
单源耗尽 / 零 API 源 → 串行 fallback 链：
  machine_mcp → brave → serp_http（快探）→ browse_headless（实搜）→ recording replay
```

- **machine_mcp**（v1.4）：零配置复用本机 `~/.claude.json` 已配的 search MCP（只读不写、永不 log Authorization，INV-72）——v1.17 A3 后是智谱能力的**唯一载体**（直连档已删）
- **brave**：结构化 API 源。运营事实（doc/21 实核）：Brave 免费档 2026-02 取消，现口径 $5/月赠送额度（≈1000 次/月量级）；Bing API 已于 2025-08-11 退役——**BingChannel 已代码级删除**（v1.15 Phase A，INV-54 墓碑，存量配置静默忽略）
- **serp_http**（v1.15）：brave 之前的 ~1s 裸 HTTP 快探（见 §7.2）
- **browse_headless 实搜兜底**：query 语言分流（CJK→百度，非 CJK→DDG 纯 HTML 端点，零 Key；v1.14 起 DDG 被挡时级联 Brave SERP HTML）
- **recording replay**：全源熔断时的最后兜底（过去录过的同 query fixture；v1.16 起加新鲜度门，见 §7.7）
- **zhipu 直连档已删**（v1.17 A3，INV-80 墓碑）：SearchChannel 类不存在、engine enum 无 "zhipu"、config 不消费 ZHIPU_API_KEY、doctor 报 `zhipu_keys_retired`
- **wayback 不在链内**（INV-58）：死链恢复是独立工具，CC 显式调用

**quality 轴**（v1.17 A1）：每条 search 结果带 `quality: "api" | "scrape" | "stale"`——`search.machine_mcp` / `search.brave` → api；`serp_http:*` / `browse_*` → scrape；`recording_replay` → stale；其他不标（静态映射零启发式，`src/search/QualityTag.ts` 单一真源）。

### 7.2 serp_http 快探层（v1.15 Phase B）

`src/serp/http-serp.ts`：browse_headless 之前的裸 HTTP SERP 探针（注入时 fallbacks 从 `[browse_headless]` 变 `[serp_http, browse_headless]`）。复用 browse_headless 的**同一 selector 集**（`selectors.ts` 三引擎：BAIDU / DDG / BRAVE_SERP）+ bot 探测，不起浏览器。真机对照（doc/22）：serp_http 1.9s / 20 条 vs 浏览器 5.3s / 0 条。真机坑有维护记录（brave 字体 CSS 垃圾结果、百度软挡终态 URL 校验），见 `doc/SELECTOR-MAINTENANCE.md`。

### 7.3 content_blocks 第二跳（v1.17 A2′ 自研）

`src/search/ContentSecondHop.ts`：search 第一跳（蓝链）之后的 **opt-in** 正文富化（`content_blocks: 1..5`）。拿 top N 结果并发裸 HTTP 抓正文（defuddle 抽取 + 查询相关裁剪），零付费依赖、**不起浏览器**（重站/JS 渲染页如实 `fetch_failed`，留给 CC 自己 browse——不自动升级）。红线：

- **enrichment 不是 fallback**：第二跳任何失败不改变主结果 outcome / served_by / quality / fallback_used；失败条目保留蓝链字段 + `content_status`（ok / fetch_failed / not_html / extract_failed 四态）如实标注
- **护栏**：单条 timeout 5s / 256KB 两段式截断（content-length 预检 + 流式读硬顶）/ 每条裁剪预算 ~6k 字符 / 并发 3 / 整体 wall-clock 软上限 15s
- **SSRF 必过 ssrfGuard**（与 fetch_url 同函数同 config）+ `redirect:"manual"`（3xx 不跟随，防重定向绕过）；连接池单一真源（不 new Agent）
- **cache 零污染**：content_blocks 不入 cache key——蓝链照常缓存 7 天，正文每次实抓

### 7.4 search_local 第四通道（v1.17 B1）

`src/search-local/`（doc/24 裁决 B1 + doc/25 裁决④）：**本地私有搜索**——「我上周看过的那篇文章在哪」「我机器上哪些文件提到 X」。三源分阶段：

- `history`（默认）：Chrome History 多 profile 只读 SQLite 查询（`chrome-history.ts`；`profile` 参数可选）
- `files`：`mdfind` / Spotlight（`mdfind.ts`）
- `notes`：本版明确推迟——enum 保值但返 `didnt` + `reason:"notes_deferred_v2"`（诚实不装不知道；ZBODY zlib+protobuf 全文解析是独立工程，v2 再议）

隐私红线 = INV-81（见 §6）；四处联动防「写好没装配」（注册器 + index.ts 注册 + V5_TOOL_TO_CHANNEL + descriptions）。

### 7.5 fetch_feed（v1.16 D-GO-2）

`src/tools/fetch-feed.ts`：拉一个 feed URL → 结构化条目列表（RSS 2.0 / Atom / JSON Feed 1.1，零依赖正则解析——只认完整 `<item>`/`<entry>` 块，截断尾部天然丢弃不产半条假条目）。设计立场：**无状态纯原语 + 独立 tool 不进 search 降级链**（与 wayback_lookup 同范式）——RSS 是推模型零索引滞后，「最新动态」类查询 CC 显式直调；必经 ssrfGuard + doFetchUrl（不自造第二套 fetch）；bounded output 48KiB / 16KiB preview + `truncated_input` 标记。

### 7.6 freshness 与缓存语义

- **TTL × freshness 耦合**（v1.16 ZB-3）：有效 TTL = min(7 天, freshness 窗口)——`freshness=day` 的缓存最多存 24h，第 2 天起必须重搜；freshness 全档入 cache key（不同时效不互相污染，v1.11 起）
- **replay 新鲜度门**（v1.16）：replay 键只有 (engine, query) 不含 freshness——门规则 = fixture 年龄 > freshness 窗口 → `replay_miss`（返原结果，诚实 didnt/unknown；`freshness=day` 不再命中陈年录制）

### 7.7 doctor 与运营事实探测

`doctor --deep`（v1.14，显式 opt-in，默认零网络副作用）：#11b `brave_deep_probe` 对 Brave API 发一次最小真实请求，四分类——**200** key+计划均健康 / **401** key 无效 / **403**（或响应体含 plan 语义）计划层级失效 / **429** 限流（key 本身有效）——把「用户注册撞付费墙才发现」变成「doctor --deep 一跑就知道」。搜索供应商的运营事实漂移由 KEY-GUIDE 90 天重核制度对账（doc/21 建制）。

## 8. 交互升级：elicitation 与 refs（v1.17 C1/C2）

### 8.1 elicitation 高风险回合内确认（C1）

`src/interact/ElicitationPort.ts`：HighRiskGate 命中高风险 pattern 时，向 CC 用户弹结构化确认（continue/skip/abort 三选一），替代「直接 blocked 中断」。安全模型（doc/25 裁决⑤）：

- 三值决议：`accept`（本次放行）/ `decline`（维持 blocked）/ `unavailable`（能力未声明或任何异常——**fail-closed**，落回现行 didnt 路径 byte-identical）
- **能力预检前置**：客户端未声明 `elicitation.form` 能力 → 连请求都不发，100% 降级 didnt（测试钉死；升级客户端即得）；单次确认 wall-clock 上限 120s
- **accept 无记忆**：每次命中独立确认（INV-14 anti-gaming 延伸）；pattern 表仍代码级 const，不从 config/env 读
- 本模块永不 throw（StepEngine 对 assessStep 异常的兜底是放行——端口 throw 会意外放行高风险操作）

### 8.2 include_refs 交互句柄（C2）

`src/browse/extract-refs.ts`：browse extract 的 `include_refs` opt-in 三件套——① extract 顺带给交互元素注入 `data-lasso-uid="r1"..`（cap 50）；② markdown 末尾追加 `## Interactive refs` 附录表（正文零内嵌标记）；③ `click`/`fill` 接 ref 句柄（`^r\d+$`）。**ref 失效诚实语义**：页面变了 querySelector miss → `ref_stale_re_snapshot` → didnt（不猜不自动重试，重新 extract 即得新句柄）。raw 档运行时忽略该参数 + `ignored_include_refs:true` 标注。

## 9. 安全面（持续加固记录）

- **SSRF**（INV-31，fetch_url / wayback / fetch_feed / serp_http / content_blocks 同函数同 config）：默认拒私网 IP；fake-ip（198.18.0.0/15）内置放行；`redirect:"manual"` 防 302→169.254 绕过。**v1.17.1 加固**：IPv6 字面量 URL 剥括号后再 DNS lookup——此前 `[::1]` 带括号串在 TUN fake-ip 环境被当域名解析成 fake-ip，IPv6 loopback/ULA/IPv4-mapped 全部绕过（ft-round1 🔴FT-DEF-3，`src/ssrf/ssrf-guard.ts`）
- **HighRiskGate**：同 v1.17.1 修复裸 `JSON.parse` 解析围栏响应（异常 → gate_error 保守放行，C1 红线端到端失效）——改经 upstream-response 适配器 + INV-76(m) 防复发（ft-round1 🔴FT-DEF-1′）
- **静默性（v1.17.2，doc/27-静默性全面审计）**：六维打扰面（①OS 焦点 ②窗口 ③Dock/cmd-tab ④音频 ⑤通知 ⑥资源）逐通道白盒 + 真机审计后修复两个缺陷、固化全部边界——
  - **S-7 修复（tab 内容劫持）**：上游 1.7.0 连接即 `selectPage(pages[0])`，v1.17.1 及之前 lasso 的 navigate 会改写用户第一个 tab（两轮真机复现）。现 `LoggedInChannel.ensureOwnPageSelected`（非台账 Chrome 路径）：`CdpClient.createBackgroundTarget`（`Target.createTarget {background:true}`，E7 实证零抢焦）自建后台 tab → 上游 `list_pages` 前后 **id-diff 唯一归因**（上游 id 是进程内单调计数器；不取最大 id，防与用户同刻开 tab 竞态误归因）→ `select_page {pageId}` **不带 bringToFront**（上游激活严格 opt-in，省略 = 纯上下文指针切换，真机实测零 OS 焦点/零 tab 激活）。自建 tab 晚于 TabSession 快照 → 会话收尾 restore 关它（用户 tab 栏零残留）。任何失败（解析/归因/CDP/select 拒绝）warn 降级维持旧行为，永不阻断 browse。
  - **S-10 修复（close_page 契约 + 所有权）**：旧 `close_page {url}` 在 1.7.0 wire 级必被 zod 拒（-32602，实测）；且旧 reconcile 把全部列出 URL 入册（用户 tab 也是候选）。现 `TabRegistry` 按 `{pageId}` 关 + **登记制所有权**（`noteOwnPage` 只由 ensureOwnPageSelected 成功路径登记；用户 tab 无登记路径，close 淘汰在集合定义层面不可能落在用户 tab 上——红线机械化范式）。
  - **诚实边界固化**（不可修，见 KEY-GUIDE/README 矩阵）：desktop 物理键鼠设计占用；launch-chrome hidden 的 Dock 图标（有头 Chrome 注册 Foreground ASN，LSUIElement 不可控；headless 无此问题——真机实证无 Foreground ASN）；visible 档语义即「看着干」；用户 Chrome 不静音（零注入铁律）+ 操作 tab 的 hasFocus 仿真（不抢 OS 焦点）。
  - **守卫**：INV-78(d) 精化——`bringToFront` token 级零命中（作用域内任何 select_page 都不可能带激活开关）+ `"new_page"` 禁令新增 + S-7 实装锚（select_page 调用形 + 护栏日志事件 grep）。
- 其余安全 INV 面（cloud 双重解锁 / appleScript 白名单 / stealth profiles / 连接池）见 §11 分类表

## 10. 测试策略

| 层 | 工具 | 覆盖 | 规模（v1.17.2 终态） |
|---|---|---|---|
| 架构不变量 | `check-invariants.mjs`（自写） | INV-1..81 静态 grep + 形状测 | **81 条** |
| INV 自测 | `inv-selftest.mjs`（`npm run inv-selftest`） | 抽样 INV 做「注入违规 → 必红」复证 | **20 样本**（外部契约类全覆盖；未验证 pin 显性化报告） |
| TS 单测 | vitest | channel / fallback / forest / doctor / launcher / outline-contract / replay-baseline / stealth / lifecycle / cdp-actions / search-local / content-second-hop / elicitation / extract-refs / quality / http-serp / fetch-feed 等 | **2253 测试**（135 文件；doc/17 ft-round1 门禁两轮独立复跑在档 + doc/27 静默性审计补测） |
| Rust 单测 | cargo test | ax / applescript / cgevent(+keymap) / screenshot / tcc / windows / protocol / role-map | **207 测试**（cargo test 实跑；rust-helper 自 v1.13 起零改） |
| 跨平台编译 | cargo check --target | Windows (x86_64-pc-windows-msvc) + Linux (x86_64-unknown-linux-gnu) | CI Linux runner |
| 录制回放回归 | npm run replay-baseline | fixtures/serp-baseline/ × 三引擎 × 多 query | 12+ fixtures |
| 故障注入 | vitest | fallback 链 / 限流 / 政策 gate / SERP 改版 | ~20 场景 |
| 全量功能测试 | doc/17 清单 + ft 执行记录 | 四面板（search / browse / infra / perf）~170 用例真机 | ft-round1 **ALL-CLEAN**（2026-08-18） |
| 契约锁 | chrome-devtools-mcp@**1.7.0** version pin（`LOCKED_CDP_MCP_VERSION` 单一真源） | 上游小版本升级不破 Lasso；迁移要点见 §2.1 | SubprocessManager.ts |

## 11. 不变量（81 条）分类

| 范畴 | INV 编号 | 守的是什么 |
|---|---|---|
| 单一真源（grep 守 class / type 只在一处定义） | INV-3 / 9 / 24 / 60 | ProviderConfig / ProviderRegistry / RootRegistry / AxBackendFactory |
| 禁第二套（横切关注点变体只允许一套） | INV-4 / 6 / 23 / 33 | FallbackDecider / dispatch Map / 跨 surface fallback / pdf dispatch |
| 平台隔离（src/**/*.ts 无平台字面量） | INV-21 / 60 / 61 | TS 层无 AXUIElement/CGEvent/UIAutomationClient |
| 隐私红线 | INV-15 / 43 / 48..53 / 57 / 62 / **81** | output envelope 0o600 / 零遥测 / cookie AES-256-GCM / 录制 opt-in / 禁录 logged_in / **search_local 只读+无全文导出+limit≤50+零网络** |
| 安全红线 | INV-14 / 25 / 27 / 30 / 31 / 32 | HIGH_RISK_PATTERNS / cloud 双重解锁 / appleScript 白名单 / stealth profiles / SSRF / 连接池 |
| 诚实交付 | INV-13 / 19 | expect failed 必须 didnt + 终止 / OutlineNode 同形异源 |
| v1.0 release polish | INV-63 / 64 / 65 | version 三处一致 / launcher 不引新 npm dep / README+ARCHITECTURE 必引用 08+09 |
| v1.1 LLM 友好抽取 | INV-66..69 | raw 默认 byte-identical / extractor 内部件封装 / markdown 引擎禁第三运行期 / 引用角标零 crawl4ai 依赖 |
| v1.2-v1.4 配置与复用 | INV-70 / 71 / 72 | interactiveOnly opt-in 剪枝 byte-identical / config 文件机制（扁平 JSON + env 覆盖）/ 机器 MCP 复用安全（只读不写、永不 log Authorization） |
| v1.5-v1.7 反检测与云通道 | INV-73 / 74 / 75 | stealth 16 路一致性 + Headless 接线 / Steel 通道零回归（单独导出 + 双重解锁 + mutex）/ creepjs 门禁纯 doctor 侧零回归 |
| v1.8 wave 修复守护 | INV-76 | 上游契约适配与接线回归（v1.17.1 扩 (m)：HighRiskGate 解析必经 upstream-response） |
| v1.9-v1.10 浏览器生命周期 | INV-77 / 78 | 台账 + chrome-stop 归属验证 / tab 快照恢复三守卫 / hidden 档 flag 集不漂移 / idle reaper 零第二 kill 原语 |
| v1.11 1.7.0 迁移守护 | INV-79 | 版本锁 1.7.0 / 遥测关 / --wsEndpoint / launch 级 stealth / 零哑 flag 形态 |
| v1.14-v1.17 运营事实与死层清除 | INV-54 / 80 | 死层墓碑：Bing（BingChannel 全链删、配置静默忽略）/ zhipu 直连（无 SearchChannel 类 / engine enum 无 "zhipu" / config 键容忍不消费 / doctor 报 retired） |

完整 INV 列表 + 释义见 `src/invariants/check-invariants.mjs` 顶部注释。

## 12. 数据流（典型场景）

### 12.1 search（v1.17 A3 后终态链）

```
CC → search("rust async 最新动态", freshness="week", content_blocks=3)
   → engine=auto → fanout（machine_mcp + brave 两 API 源，配额/可用性裁决）
   → 零 API 源或扇出失败 → 串行链：
        machine_mcp → brave → serp_http（~1s 裸 HTTP 快探）
        → browse_headless（真 Chrome 实搜：CJK→百度，非 CJK→DDG→Brave SERP 级联）
        → recording replay（新鲜度门：fixture 年龄 > freshness 窗口 → replay_miss）
   → quality 打标（machine_mcp/brave→api；serp_http/browse→scrape；replay→stale）
   → 蓝链入缓存（TTL = min(7d, freshness 窗口)）→ 第二跳富化 top 3 正文
     （并发 3 / 单条 5s / 256KB / 裁剪 ~6k；失败条目 content_status 如实标注，
       主结果零改动）
   → 返 { outcome, entries, served_by, quality, ... }
```

### 12.2 browse_logged_in（2FA 场景）

```
CC → browse_logged_in("https://app.example.com", action="snapshot")
   → LoggedInChannel.run() → chrome-devtools-mcp@1.7.0 (:9222 CDP)
      → getMcpClient 装配链（v1.17.2 全序）：
         ensureRunning → onChromeUse(reaper touch)
         → precreateBackgroundTabIfHidden（仅台账 hidden + 零 page）
         → TabSession.takeSnapshotIfAbsent（用户 tab 基线，先于建塔）
         → _detect2FA（attach 时读选中页）
         → ensureOwnPageSelected（仅非台账 Chrome：建后台塔 → id-diff →
           select_page{pageId} 无 bringToFront；失败 warn 降级）→ noteOwnPage
         → TabRegistry.reconcile（只触达已登记 own 页；close_page{pageId}）
      → 站点返 302 to /login/2fa
   → outcome="didnt" + error="NEEDS_MANUAL_2FA"
   → 链止（不 fallback；2FA 是红线）
   → CC 提示用户本机 Chrome 完成 2FA
```

### 12.3 desktop（macOS 四档：语义优先、坐标兜底）

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

### 12.4 launch-chrome（跨平台子命令）

```
$ lasso launch-chrome
   → runLaunchChromeCli() → detectChromePath()
      → macOS: /Applications/Google Chrome.app/...
      → Linux: /usr/bin/google-chrome
      → Windows: C:\Program Files\Google\Chrome\...
   → spawn chrome --remote-debugging-port=9222 ...（hidden 档 + 反节流三件套 + 静音）
   → 探活 CDP /json/version → 台账登记 → server 运行期最后使用后 ~60s 自动关
```

## 13. 关键路径文件索引

| 模块 | 主文件 | 备注 |
|---|---|---|
| Tool 注册 / 生命周期 | src/index.ts（stdin-EOF 收尾 / reaper / Steel 3s 上界 / V5_TOOL_TO_CHANNEL 18 键 = 16 默认工具 + browserbase/steel；admin 是虚拟 channel 经 toolManager 直注册，不入表） | ~1470 |
| Tool handler | src/tools/{search,browse,desktop,admin,doctor,network,fetch-url,fetch-feed,wayback,screenshot,pdf,read-text,interact}.ts + descriptions.ts（描述单一真源） | — |
| Channel 层 | src/channels/{BaseChannel,UiChannel}.ts | — |
| BrowseChannel 族 | src/browse/BrowseChannel.ts；HeadlessChannel（launch 级 stealth + 宿主对齐 profile）；SteelChannel（session mutex + proxyUrl） | — |
| stealth | src/browse/{StealthEngine,stealth-profiles}.ts（16 路 + 4 profile + 值域 2026-07） | — |
| markdown 抽取 | src/browse/markdown-extractor.ts（defuddle 双激活 + turndown 降级保底）；extract-refs.ts（include_refs 三件套，v1.17） | — |
| 搜索域 | src/search/{FallbackChain,SearchCache,MultiSourceFanout,FreeTierRouter,AttributedSearch,QualityTag,ContentSecondHop,MachineMcpDetector}.ts；src/channels/{MachineMcpSearchChannel,BraveChannel}.ts（BingChannel / SearchChannel〔zhipu 直连〕均已删，INV-54/80 墓碑） | QualityTag/ContentSecondHop = v1.17 |
| serp_http 快探 | src/serp/http-serp.ts（v1.15，brave 前 ~1s；复用 selectors.ts 三引擎） | — |
| SERP | src/serp/{selectors,extract,SerpHealthMonitor,RecordingStore,replay-baseline}.ts（百度 / DDG / Brave SERP 三引擎 + 语言分流 + 改版检测 + 回放） | — |
| search_local | src/search-local/{register-search-local-tool,chrome-history,mdfind}.ts（v1.17 B1，INV-81） | — |
| 交互升级 | src/interact/ElicitationPort.ts（C1）；src/browse/{HighRiskGate,extract-refs}.ts | — |
| desktop 四档 | src/desktop/{AxProvider,AxBackend,AxBackendFactory,OutlineMapper,CGEventProvider,ScreenshotVlmProvider}.ts | AxProvider ~330 |
| FallbackDecider | src/fallback/FallbackDecider.ts | ~350 |
| Launcher | src/launcher/{launch-chrome,chrome-paths,chrome-stop,chrome-idle-reaper,chrome-ledger,chrome-hide}.ts（INV-64 不引新 npm dep） | 共 ~1540 |
| Doctor | src/doctor/doctor.ts（40 项 check 量级，以实跑为准；#21 event-synthesis / #36 machine_mcp / #37 steel / #38 creepjs / #39 stagehand / #11b brave_deep_probe（--deep）/ zhipu_keys_retired） | ~3100 |
| Invariants | src/invariants/check-invariants.mjs（81 条 INV） | ~4450 |
| INV 自测 | scripts/inv-selftest.mjs（20 样本红转复证） | ~330 |
| Subprocess | src/subprocess/SubprocessManager.ts（`LOCKED_CDP_MCP_VERSION = "1.7.0"`） | ~730 |
| Rust helper | rust-helper/src/{ax,uia,atspi,applescript,cgevent,cgevent_keymap,screenshot,tcc,windows,protocol,main,ax_role_map,app_bundle_map}.rs | ~5000；自 v1.13 零改 |

## 14. 版本与发布

- **当前版本**：`1.17.2`（doc/27 静默性全面审计落地：S-7 自建后台 tab + S-10 close_page 契约与所有权修复、INV-78(d) 精化；2026-08-19）
- **version 真源**：`package.json` + `src/index.ts:LASSO_SERVER_VERSION` + `src/doctor/doctor.ts:LASSO_VERSION`（INV-63 守：三处必字面量一致）
- **doctor readiness**：全量 check pass → `ready: true`（检查项随版本增长，以实跑输出为准）
- **跨平台 backend**：macOS 本机全证；Win/Linux 编译可证 + 契约可证，真机执行待社区反馈
- **门禁四链**：`npm run build` / `npm test`（2253）/ `npm run check-invariants`（81）/ `npm run inv-selftest`（20）+ `cargo test`（207）

## 15. 质量与决策主线（doc/19 → doc/25 → doc/17）

2026-08-15 起的三段质量主线，决策记录全部在档（索引见 [`doc/README.md`](./doc/README.md)「决策时间线」）：

1. **五轮最优性审查**（doc/19，v1.10 → v1.13）：四域白盒复审 → 裁决 → 实施 → 独立审查循环，候选 16 → 14 → 7 → 1 → 0 单调收敛（round5 终裁 ROUND-CLEAN）；四维结论选型 / 架构 / 范围 / 实施全最优。
2. **搜索重审与死层清偿**（doc/21 → doc/22，v1.14 / v1.15）：运营事实对账（Brave 免费档 2026-02 取消、Bing API 2025-08-11 退役）暴露「机制达标、运行时诚实度未达标」→ free_only 路由接线 + DDG→Brave SERP 级联 + `doctor --deep` + KEY-GUIDE 90 天重核制度（v1.14）；Bing 死层代码级清除（INV-54）+ serp_http 快探层（v1.15）。
3. **方法论检讨与颠覆性调研**（doc/23 / 23a → doc/24，v1.16）：零基视角制度化（「搜索优化失效」根因 = 只在既有方案内比较）；颠覆性扫描按 D-GO / D-DECISION / D-WATCH / D-NOGO 分级裁决 → 落地 D-GO 三项：freshness TTL 耦合 / fetch_feed / README 生态段（v1.16）。
4. **五项用户裁决**（doc/25，v1.17）：A1 quality 轴 / A3 删 zhipu 直连（INV-80）/ A2′ content_blocks 第二跳 / B1 search_local（INV-81）/ C1 elicitation + C2 include_refs。
5. **全量功能测试轮**（doc/17，v1.17.1）：四面板 ~170 用例真机执行，抓出并修复 6 缺陷（🔴IPv6 字面量 SSRF 绕过 / 🔴HighRiskGate 裸 JSON.parse / doWait 假成功 / tab_restore no-op / doctor file 键 / SIGHUP），R1 独立裁决 **ALL-CLEAN**；§6 简单架构 38 条终判见 §6.1。

方法学沉淀（供复用）：裁决官不采信文档（关键声称白盒双源亲验）；证据阶梯 L0-L3；mutation 即验收；「先拿事实再加参数」；收敛协议前置；零基视角才可见方案级盲区；决策分级（GO/DECISION/WATCH/NOGO）交用户裁决而非默认全做。

## 16. 相关文档

- [README.md](./README.md) — 用户手册（安装 / 配置 / 工具列表 / 隐私 / 故障排查）
- [doc/README.md](./doc/README.md) — doc/ 目录导读（用户向 / 维护手册 / 决策档案三分法 + 决策时间线 + 新鲜度表）
- [doc/08 功能架构](./doc/08-media-interact-功能架构.md) — 权威架构基线（F 编号；冻结于 2026-07-21，头部含 v1.17.1 现状对齐横幅 + F 编号 ↔ 现实映射）
- [doc/09 实施排期](./doc/09-media-interact-实施排期.md) — v0.1 → v1.17.1 能力跃升全路径与决策记录
- [doc/19 最优性审查轮次](./doc/19-最优性审查轮次/00-总结.md) — 五轮审查全记录（v1.10 → v1.13 质量主线）
- [doc/17 功能测试清单](./doc/17-功能测试清单.md) — 全量功能测试（ft-round1 ALL-CLEAN + §6 简单架构终判）
- [doc/TROUBLESHOOTING.md](./doc/TROUBLESHOOTING.md) — FAQ + error_kind 释义
- [doc/SELECTOR-MAINTENANCE.md](./doc/SELECTOR-MAINTENANCE.md) — selector 债维护手册
- [doc/26 文档查缺补漏](./doc/26-文档查缺补漏/gap-matrix.md) — 文档盘点矩阵（新鲜度档位 + F 编号映射真源）

---

本文档是 Lasso v1.17.1 架构概览（user-first；2026-08-18 同步，事实基准 = HEAD `1432bd4` 源码实核 + `tools/list` / `cargo test` / `check-invariants` 实跑）。深度架构基线（含 F 编号 / 不变量推导链 / 测试策略）见 [`doc/08`](./doc/08-media-interact-功能架构.md)；v0.1 → v1.17.1 实施排期（含每 phase 决策记录）见 [`doc/09`](./doc/09-media-interact-实施排期.md)。
