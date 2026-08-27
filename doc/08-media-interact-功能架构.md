# Lasso 全周期功能架构（08）

> **Lasso**（npm `lasso-mcp`）= CC 的**全交互**对外抓手 MCP（浏览器 + 桌面）。与 media-gen-mcp（图像抓手）双子星。
> 本文档是权威架构基线（2026-07-21 重写为干净最终版，合并所有调研/审查修正，清除增量附录累积与矛盾）。上游：[07 可行性](archive/research/07-CC统一交互抓手MCP-可行性分析.md)/[10 搜索](archive/research/10-搜索MCP调研对架构的启发.md)/[11 简单审查](archive/research/11-简单架构审查报告.md)/[12 pi-computer-use](archive/research/12-pi-computer-use及生态深度分析.md)/[13 全交互重设计](archive/research/13-全交互抓手重设计.md)。下游：[09 排期](09-media-interact-实施排期.md)。
> **仓迁注（2026-08-27）**：上游调研 07/10/11/12/13 已随外层仓 `cc-control-all/doc/` 退役迁入本目录 `archive/research/` 同名文件（00-18 全系列同迁；真源 = 本仓）。

## ⚠️ 现状对齐横幅（v1.17.1 · 2026-08-18）

**本基线冻结于 2026-07-21（v0.x 时代），正文保留不回改**——F 编号是 [09 排期](09-media-interact-实施排期.md)的引用锚，重写即毁锚。**v1.14+ 现状的权威入口 = `lasso/ARCHITECTURE.md`（v1.17.1）**；F 编号 ↔ 现实逐条映射见 `lasso/doc/26-文档查缺补漏/gap-matrix.md` §4（活 / 退役 / 从未 / 无号四态）。照读正文会错的四条最高危失实：

| # | 本文正文表述 | v1.17.1 现实 |
|---|---|---|
| 1 | 四通道「search（智谱 web-search-prime）」/ `engine="zhipu"` / F3.5「智谱 http 子进程」 | 智谱直连已删（INV-80 墓碑）；现实链 = machine_mcp → brave → serp_http → browse_headless → replay；智谱能力唯一载体 = machine_mcp 复用 |
| 2 | F3.8「百度 / **Google** selector」 | Google selector 从未实现；现实三引擎 = 百度 / DuckDuckGo / Brave SERP（selectors.ts） |
| 3 | §7.5「chrome-devtools-mcp **1.6.x** 契约」 | 版本锁 **1.7.0**（v1.11 迁移，INV-79） |
| 4 | F3.12 future 行（browse_cloud / stagehand / fetch_url / screenshot / pdf / network / wayback） | **7 项全部已交付**（v0.4–v1.11）；另有 F 体系外新能力：interact_roots/observe/act、search_local、fetch_feed、quality 轴、content_blocks、elicitation、include_refs（映射表「无号」行） |

---以下为 2026-07-21 冻结的历史基线正文（语义按当日快照读）---

---

## 0. 项目定位与设计原则

**定位**：CC 通过这唯一一个 MCP，高效和**浏览器 + 桌面**交互。「所有外部交互归一个 MCP」。

**四通道**：`search`（智谱 web-search-prime）/ `browse_headless`（chrome-devtools-mcp --headless --isolated）/ `browse_logged_in`（--browser-url :9222 复用本机 Chrome）/ `desktop`（macOS AXAPI，Rust helper）。

**设计原则**（贯穿全文，含 11/13 审查沉淀）：
1. **能力导向命名**：工具按能力命名（search/browse_*/desktop），不按后端。借鉴 mcp-chrome description 内嵌 `[Prefer X over Y]` 路由提示。
2. **页面/界面状态写磁盘**：browse/desktop 返回短指针（HTML/PNG/AX-outline 写 `~/.cache/lasso/<run_id>/`），不灌上下文（Playwright CLI 27k vs MCP 114k / 10 步铁律）。
3. **减少推理调用**：browse/desktop 支持 `steps` 多步链式 + `expect` 后置条件，把「CC 串联 5 次」变「1 次搞定」（呼应 75-94% 延迟来自 LLM 规划）。
4. **fallback 对 CC 透明**：CC 只见 4 个能力工具，内部降级用 `outcome/fallback_used/retrieval_method` 字段透传。
5. **诚实三态交付**（12 F.1，借鉴 injaneity `outcomeAfterCheck`）：动作结果区分 **worked/didnt/unknown**，`unknown` 是 fallback 引擎真正触发器。**铁律：event delivery alone is never treated as semantic success。**
6. **零侵入跟随上游**：封装官方 chrome-devtools-mcp（不 fork），上游升级零成本跟随。
7. **第二套做法红线（R-CI-02，13 审查最高优先级）**：四通道共享同一套 fallback 范式（isFallbackWorthy/getFallbackProvider/activeProvider/60s+60min 熔断）/状态模型（InteractTask/stateId/expect/StateStore LRU）/工具描述风格/熔断策略。任一独立即违例。
8. **不变量脚本化**（12 F.4，借鉴 injaneity `check-invariants.mjs`）：架构不变量编码为 CI 脚本，漂移即 fail（同 media-gen-mcp 0.11.0 抓 mock 掩盖🔴思路）。

**非目标**：不做 provider 数量竞赛 / 不做 RRF 融合 / 不做 corpus 持久化 / 不自动登录解 2FA / 不做坐标 grounding（desktop 走 AXAPI 语义，不走截图坐标）。

---

## 1. 整体架构分层

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Code（CC）                                                 │
└───────────────────────────┬──────────────────────────────────────┘
                            │ stdio MCP（~/.claude.json 注入）
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Lasso（单进程）                                                   │
│  Tool Layer    search()  browse_headless()  browse_logged_in()    │
│                desktop()  + admin(channel_health/reset/test)     │
│  Handler Layer 单一 fallback 引擎（不开第二套）                    │
│                run_with_fallback + tri-state outcome 路由         │
│                + activeProvider 防错位 + 60s/60min 双层熔断       │
│                + actions_and_results 审计链                       │
│  Channel Layer BaseChannel 分层:                                  │
│    ├─ SearchChannel（只通用层，调 SERP API）                       │
│    ├─ BrowseChannel（UiChannel 子类）─ HeadlessChannel            │
│    │                                  └ LoggedInChannel           │
│    └─ DesktopChannel（UiChannel 子类，4 providers）                │
│  Subprocess Manager（单一 lifecycle，不含协议帧解析）              │
│    ├─ chrome-devtools-mcp 子进程 ×2（headless + browser-url）      │
│    └─ Rust desktop helper 子进程（stdin/stdout JSON-lines）        │
└───────────────────────────┬──────────────────────────────────────┘
       ┌───────────────────┼──────────────────┬──────────────┐
       ▼                   ▼                  ▼              ▼
 chrome-devtools-mcp   chrome-devtools-mcp  智谱 web-      Rust helper
 --headless --isolated --browser-url :9222   search-prime   (AXAPI+
 (干净无头)            (复用登录态)         (结构化搜索)    AppleScript+
                                                          CGEvent+VLM)
```

**multi-root forest（v0.4+ 目标态）**：browse surface（CDP page，@pN）+ desktop surface（AX window，@wN）统一到 `interact_roots()` 入口。v0.1-v0.3 只埋 `InteractTask{rootRef}` 字段（双空间不共享计数器），抽象同构先于工具统一。

---

## 2. 核心抽象

### 2.1 BaseChannel 分层（13 审查 #2 必改——避免 SearchChannel 穿 UI 鞋）
```python
class BaseChannel(ABC):          # 通用层：所有通道实现
    name: str
    async def is_available(self) -> bool: ...
    async def status(self) -> ChannelStatus: ...
    async def health_check(self) -> Health: ...

class UiChannel(BaseChannel):    # UI 层：Browse/Desktop 实现（Search 不进）
    async def observe(self, task: InteractTask) -> OutlineSnapshot: ...  # AX/DOM → 统一 OutlineNode 树
    async def act(self, task: InteractTask) -> ActResult: ...            # 按 FallbackPlan 试 providers
    async def wait(self, task: InteractTask) -> TriState: ...
    def capabilities(self) -> CapabilityBag: ...
```
SearchChannel 只实现 BaseChannel（调 SERP API 返回结构化结果，无 UI 元素）。BrowseChannel（headless/logged_in）+ DesktopChannel 实现 UiChannel。

### 2.2 CapabilityBag（能力袋，v0.6 动态启停）
配置驱动的通道/provider 集合。`ListTools` 据实生成 schema，CC 只见已启用通道。

### 2.3 FallbackPlan + tri-state outcome
```python
@dataclass
class FallbackPlan:
    primary: str; fallbacks: list[str]; cross_modal: bool = False

@dataclass
class InteractResult:             # tri-state（12 F.2，替二元 bool）
    outcome: Literal["worked","didnt","unknown"]  # unknown → 自动触发 fallback
    data: Any; served_by: str; fallback_used: bool
    retrieval_method: str; actions_and_results: list | None  # Skyvern 审计链
    error: str | None
```

### 2.4 StateStore（12 F，借鉴 injaneity `runtime.ts`）
`StateStore<OutlineSnapshot>`：LRU(128) + `stateId`（UUID 短指针）+ `AsyncLocalStorage` 请求级 hydrate。每次 observe 产生不可变快照；refs（@eN）只属一个 stateId，过期 cleanly fail。磁盘保留用于跨进程重启。

### 2.5 ExpectCondition（12 F.7，v0.3）
```python
@dataclass
class ExpectCondition:
    text: str | None = None; selector: str | None = None
    url_contains: str | None = None; gone: bool = False; timeout_ms: int = 5000
# act 后 100ms poll 等平台变更，三态：verified→worked / failed→didnt / preexisting 保留
```

### 2.6 CircuitBreaker（双层）
60s 短熔断（连续失败）+ Argus 60min 长熔断（月配额耗尽类）。按错误类型区分：429→长熔断 / 超时→短熔断 / 政策性故障→manual-switch gate（F3.4.6）。

---

## 3. 功能模块详解

### 3.1 search 工具（F3.1.x）
封装智谱 web-search-prime；失败降级到 browse_headless 实搜。**engine 选择必须基于本仓库 100-query 实测，不引用外部基准**（10 D.1，05 否决"Brave 最优"因果延伸）。
```python
async def search(query, limit=10, engine="zhipu", region="cn", no_cache=False) -> SearchResult
```
- `isFallbackWorthy` 触发集（10 D.1 扩容）：限流429/超时/网络挂/5xx/**HTTP 202 空响应**/**结果数=0 但 200**/**429+retry-after**/**provider 政策性下线**。差异化超时（快源 5s / 慢源 30s）。
- **free_only 四级分级**（10 D.1）：L1 完全免费零Key（DDG/SearXNG 自建）/ L2 需Key免费（Brave 2000/月、Tavily 1000、Jina）/ L3 远程免Key（Exa、Jina read_url）/ L4 付费。

### 3.2 browse 工具（F3.2.x，headless + logged_in 共享 BaseBrowseChannel）
**参数对象化 + action-enum 折叠**（11 F1 必改，借鉴 mcp-chrome chrome_computer）：
```python
async def browse_headless(url, action="snapshot", options: BrowseOptions | None = None) -> BrowseResult
async def browse_logged_in(url, action="snapshot", options: BrowseOptions | None = None) -> BrowseResult
# action = navigate/snapshot/screenshot/extract/click/fill/wait/...
# BrowseOptions = {selectors, js, steps, expect:ExpectCondition, wait_until, screenshot:ScreenshotSpec, timeout_ms, no_cache}
```
两通道共享 BaseBrowseChannel（行为逻辑全上提），只差 channel 配置（subprocess flag）+ cookie 策略（logged_in 有 cookie_fresh_check/tab 复用/2FA 检测）。页面状态写磁盘（F3.2.10，StateStore LRU + stateId）+ bounded output 48KiB + @oN 续页（F3.2.20）。`steps` 多步链式（v0.3）返回 actions_and_results 审计链（F3.2.11，Skyvern）。

### 3.3 desktop 工具（F3.10.x，NEW）
```python
async def desktop(action="snapshot", options: DesktopOptions | None = None) -> DesktopResult
# action = snapshot/find/act/wait/screenshot/doctor（action-enum 折叠，13 审查 #1 必改，不铺开 6 工具）
```
- **AXAPI 接入**：**Rust helper**（`accessibility`/`appkit`/`core-graphics`/`osakit` crate，契合 Rust/Tauri 背景，v1 不写 Swift）+ stdin/stdout JSON-lines + 复用 Subprocess Manager（不开第二套进程管理）。perf 必做：`AXUIElementCopyMultipleAttributeValues` 批读 6 属性（desktop-pilot 20ms 快照）。
- **两段式 fallback 四档**（同走一套 FallbackPlan，R-CI-02）：ax（primary，AX tree）/ appleScript（scriptable app）/ cgEvent（Electron 降级）/ **screenshotVlm**（canvas/Metal，复用 media-gen-mcp vlm 双子星）。
- **TCC**：Rust helper 签名 Developer ID（解 TCC 持久化，借鉴 mac-mcp）。
- **安全**：AppleScript 仅 typed action enum（拒 raw 脚本串，借鉴 mac-mcp 反 run_shell）。
- `pictureOnly` 标记：有视觉证据但无 AX element 的节点（canvas/自绘），语义动作不能 target。

### 3.4 fallback 引擎（F3.4.x）
跨模态降级（search→browse_headless 实搜 / desktop ax→appleScript→cgEvent→screenshotVlm）。复用 media-gen-mcp 0.10.0 范式（isFallbackWorthy/getFallbackProvider/activeProvider）+ Argus 60min 长熔断 + QualityGate + F3.4.6 政策风险 gate（Tavily 收购类，manual-switch）。统一 FallbackDecider 入口（11 F4，三套降级作为内部策略）。

### 3.5 子进程管理（F3.5.x）
SubprocessManager 纯 lifecycle（spawn/health/restart/cleanup），**不含协议帧解析**（13 审查 #5 不变量）。协议差异（MCP JSON-RPC vs Rust JSON-lines）下沉到各 Channel 的 ProtocolAdapter。

### 3.6 配置（F3.6.x，统一 ProviderConfig 注册表，11 F3 必改）
```python
@dataclass
class ProviderConfig:  # 加 provider = config 加一项（开闭）
    name: str; type: Literal["api_key","broker","self_hosted"]  # F3.6.2 三态
    endpoint_url: str | None; keys: list[str] = []  # F3.6.1 多 Key 池
    free_quota_per_month: int = 0; quota_model: Literal["monthly","rpm","token","request"]="monthly"
    policy_risk: Literal["safe","acquired","watched"]="safe"; licence: Literal["mit","agpl","non_commercial"]="mit"
    commercial_safe: bool = True; fallback_order: int = 0
```
加 provider = config 加一项，CapabilityBag 自动生成 Channel + 配额账本 + fallback 链。代理统一注入仅 hosted-API 层生效（本地 browser/desktop helper 跳过）。

### 3.7 可观测（F3.7.x）
结构化日志 + fallback_used/retrieval_method/served_by 透传 + SERP 命中率（v0.7）+ channel_health admin 工具 + channel://status resource（v0.7）。

### 3.8 SERP 抽取（F3.8.x，债不是资产）
browse_headless 兜底搜索的 SERP 结构化抽取。主走结构化 API（智谱/Brave），SERP 只作最后兜底。selector 级联（7 fallback，open-webSearch）+ URL 清洗 + 改版检测（v0.7）+ 录制回放（v1.0）+ bot challenge 四维探测。

### 3.9 错误模型 + 架构不变量（F3.9.x）
统一错误码 + UnifiedError + fallback 耗尽才抛 + NEEDS_MANUAL_2FA。**SSRF allowRanges**（F3.9.5，v0.1，借鉴 pi-web-access）：默认拒私有/保留 IP + CIDR allowlist 解锁 fake-ip 代理（`198.18.0.0/15`，**直接命中用户 Surge/Clash/Mihomo TUN 环境**）。**架构不变量测试**（F3.9.8，v0.1）：CI 强制断言 ①browse 是唯一 browse 入口 ②BaseChannel 不被绕过 ③ProviderConfig 单一真源 ④不复用第二套 fallback 范式 ⑤MCP ToolAnnotations 完整 ⑥dispatchUiAction 走注册表 Map（非 if-else）⑦SubprocessManager 不含协议帧 ⑧fallback 链不跨 surface。

### 3.10 multi-root forest（F3.11.x，v0.4+）
v0.1-v0.3 抽象同构（@pN/@wN 双空间）；v0.4+ `interact_roots()` 统一入口，共享 nextRootRefIndex（借鉴 injaneity `storeWindowRef/storeBrowserRootRef`）。**推翻 12 "永不进"判断**——v0.4+ 进（目标随业务移动，非熵退化）。

### 3.11 后续通道预留（F3.12.x）
browse_cloud（browserbase，v0.4）/ stagehand（v0.4）/ fetch_url（v0.5）/ pdf_extract（v0.5）/ wayback（v0.9）等。

---

## 4. 子功能事项总表（全周期，最终版）

> F 编号唯一标识。优先级：**M**=v0.1 / **数字**=v0.x / **1.0**=v1.0。**3.5**=v0.3.5（DesktopChannel MVP）。

| 编号 | 子功能 | 模块 | 优先级 | 依赖 |
|---|---|---|---|---|
| F3.1.1-7 | 基础搜索/engine/region/cache/fallback 触发/多源扇出/limit 分配 | search | M-2 | — |
| F3.1.8 | attributed 查询 | search | 2 | F3.1.4 |
| F3.1.9 | caller-tier cap | search | 6 | F3.1.6 |
| F3.1.10 | free_only 四级分级 | search | 2 | — |
| F3.1.11 | Wayback 死链恢复 | search | 9 | F3.12 |
| F3.1.12 | provider RPM/credits 滑动窗口限频 | search | 3 | — |
| F3.1.13 | provider ToS 边界标记 | search | 6 | — |
| F3.2.1-9 | navigate/snapshot/screenshot/extract/evaluate/wait/pdf/network/状态写磁盘 | browse | M-5 | F3.5 |
| F3.2.10 | StateStore LRU + stateId（替纯磁盘） | browse | 3 | — |
| F3.2.11 | steps 多步链式 + actions_and_results 审计链 | browse | 3 | F3.2.1-7 |
| F3.2.12-17 | stealth/session 隔离/复用/fetch_url/console/perf trace | browse | 3-5 | — |
| F3.2.18 | expect 后置条件 + 三态 | browse | 3 | F3.4.11 |
| F3.2.19 | StateStore + stateId + epoch 字段（epoch 暂不启用） | browse | 3 | F3.2.10 |
| F3.2.20 | bounded output 48KiB + @oN 续页 | browse | 3 | — |
| F3.2.21 | 架构不变量编码为 CI 脚本 | browse | **M** | — |
| F3.3.1-8 | 复用9222/cookie失效/tab复用/新开/2FA检测/snapshot/extract/screenshot | logged_in | M | F3.5 |
| F3.3.9-12 | cookie export/多profile/session持久化/tab LRU | logged_in | 8 | F3.3.2 |
| F3.3.13 | MCP ToolAnnotations | logged_in | **M** | — |
| F3.3.14 | high-risk pattern gate（drag-drop/RTE/data-grid 不自动操作） | logged_in | 3 | — |
| F3.4.1-7 | isFallbackWorthy/get_fallback/activeProvider/短熔断/跨模态/QualityGate | fallback | M | — |
| F3.4.5 | 长熔断 60min | fallback | 7 | F3.4.4 |
| F3.4.6 | provider 政策风险 gate（manual-switch） | fallback | 6 | — |
| F3.4.8-10 | budget/部分失败聚合/熔断 reset | fallback | 2-7 | — |
| F3.4.11 | **tri-state outcome（worked/didnt/unknown）** | fallback | **M** | — |
| F3.5.1-6 | 子进程启动(headless/browser-url)/健康/退避/僵尸/智谱http | subproc | M | — |
| F3.5.7-9 | 连接池/session隔离/优雅关闭 | subproc | 2-3 | — |
| F3.5.10-11 | 能力袋动态启停/热插拔 | subproc | 6 | F3.6 |
| F3.5.12-13 | 资源监控/并发上限 | subproc | 7-8 | — |
| F3.6.1-3 | 配置加载/claude.json注入/环境变量 | config | M | — |
| F3.6.4-6 | 多Key轮换/代理注入/热更新 | config | 2-6 | — |
| F3.6.7 | **doctor CLI**（v0.7→**M**，借鉴 agent-sh） | config | **M** | F3.5.3 |
| F3.6.8-12 | launch-chrome/key检测/schema/默认值/多profile | config | M-8 | — |
| **F3.6.13** | provider_type 三态 schema + 多Key池（统一 ProviderConfig） | config | **2** | F3.6.1 |
| F3.7.1-4 | 日志/fallback_used/retrieval_method/served_by | observ | M | — |
| F3.7.5-12 | SERP命中率/熔断状态/admin/resource/指标/告警/资源监控 | observ | 7 | — |
| F3.8.1-8 | 百度/Google selector/级联/URL清洗/兜底/去重/失败降级 | serp | M | F3.2 |
| F3.8.9-14 | 改版检测/命中率/bot探测/Wayback/集中管理/录制回放 | serp | 7-1.0 | — |
| F3.9.1-4 | 错误码/UnifiedError/耗尽才抛/NEEDS_MANUAL_2FA | error | M | — |
| F3.9.5 | **SSRF allowRanges**（CIDR allowlist 解 fake-ip） | error | **M** | — |
| F3.9.6-7 | 超时/partial_failures | error | M-2 | — |
| F3.9.8 | **架构不变量测试**（CI 脚本，8 条断言） | error | **M** | — |
| **F3.10.1-8** | **DesktopChannel**：desktop(action,options)/Rust helper/AXAPI批读/appleScript/cgEvent/screenshotVlm/TCC签名/doctor | **desktop** | **3.5** | F3.4.11/F3.2.18 |
| **F3.10.9** | desktop platform 抽象（AxBackend，Win/Linux v1.0+） | desktop | 1.0 | F3.10 |
| **F3.11.1-4** | **multi-root forest**（v0.4+）：interact_roots/@pN+@wN/统一OutlineNode/nextRootRefIndex | forest | **4** | F3.10 |
| F3.12.1-7 | browse_cloud/stagehand/fetch_url/screenshot/pdf/network/wayback | future | 4-9 | — |

---

## 5. 非功能性架构

### 5.1 安全
- **SSRF allowRanges**（F3.9.5）：默认拒私有/保留 IP + CIDR allowlist（fake-ip 环境加 `198.18.0.0/15`）+ 子资源 DNS 重绑定防护（导航 fresh DNS、子资源 60s TTL + 1024 LRU）
- **重定向/@ 安全**：URL host 解析防 `evil.com@trusted.com` 伪装
- **JS 注入风险**：`evaluate_script` 接受任意 JS，文档标注，不接受 untrusted 输入
- **cookie 隐私**：browse_logged_in 不导出用户 cookie（cookie=身份）
- **desktop 安全**：AppleScript 仅 typed action enum（拒 raw 脚本）+ audit JSONL（10MB 轮转，零遥测）+ TCC 签名 Developer ID

### 5.2 性能
- 页面/界面状态写磁盘（4× token 效率）+ StateStore LRU(128) 内存主路径
- steps 多步链式（v0.3）减推理调用
- search 结果 cache 7 天 TTL（v0.2）
- AXAPI 批读 6 属性（desktop 快照 ≤50ms）
- 本机 Chrome tab ≤10（LRU，v0.8）

### 5.3 打包分发
- npm 包 `lasso-mcp`（参考 media-gen-mcp）+ push 走 HTTPS（代理 fake-ip 拦 SSH）
- 单二进制 v1.0 评估
- Playwright/Chrome/Rust helper 不打进包（opt-in 手动装）
- `install_to_claude_json()` 一键注入

### 5.4 测试策略
- **架构不变量测试**（F3.9.8，v0.1，借鉴 injaneity `check-invariants.mjs`）：8 条 CI 断言
- fallback 链故障注入
- SERP selector 录制回放（v1.0）
- chrome-devtools-mcp 契约测试（锁版本）
- desktop AX 契约测试（Rust helper 单测 + 黑盒交互验收）
- doctor CLI 覆盖 90% 故障

---

## 6. 与 media-gen-mcp 的范式复用映射

| 范式 | media-gen-mcp | Lasso |
|---|---|---|
| handler 层 fallback | isFallbackWorthy/getFallbackProvider/activeProvider/60s | 直接复用 + Argus 60min + tri-state outcome |
| 能力袋 | 12 生成 + 4 识别 | search/browse_headless/browse_logged_in/desktop 四能力 |
| 能力导向命名 | generate_image/extract_text | search/browse_*/desktop |
| 单 MCP 多通道 | 12 provider fallback 链 | 4 通道跨模态 fallback 链 |
| 不变量测试 | 0.11.0 抓 mock 掩盖🔴 | F3.9.8 架构不变量 CI 脚本 |
| 双子星 | 图像抓手 | 全交互抓手（浏览器+桌面） |

---

## 7. 边界与已知限制

### 7.1 MVP 明确不做
provider 数量竞赛 / RRF 融合 / corpus 持久化 / 多引擎兜底（v0.9）/ 云浏览器（v0.4）/ 自动登录解 2FA。

### 7.2 长期维护负担（债）
- **SERP selector 是债**（主走结构化 API，selector 集中管理 + 改版检测 + 录制回放）
- **反检测军备竞赛**（stealth 脚本定期更新；browse_logged_in 用真实 Chrome 天然反检测）
- **chrome-devtools-mcp 上游契约**（29 工具可能变，契约测试守）
- **AXAPI 平台差异**（macOS 优先，Win/Linux v1.0+，AXAPI 关键字不进 BaseChannel）

### 7.3 登录态/2FA 不可解（明确边界）
- Lasso **不解 2FA**（Browserbase 60% 失败前车之鉴），依赖用户已在本机 Chrome 登录
- v0.8+ 登录态持久化（cookie export）缓解，但不解 2FA

### 7.4 推迟或 NO-GO（12/13 判断保留）
- **compact diff**（stabilizeRefs+changesBetween）：v0.6+ 或 NO-GO（SERP 非 patch，受益窄；如做借 Stagehand `diffCombinedTrees`）
- **ResourceScheduler + epoch 串行**：v0.5+ 视并发（F3.2.19 epoch 字段保留但不启用 stale-reject）
- **@rN+@eN 双层 ref / graftScopedOutline / foldToBudget**：过度设计不进
- **坐标 grounding / 纯截图 desktop**：Lasso 走语义（AXAPI），不走坐标

### 7.5 v1.0 稳定发布门槛
四通道 + fallback 链全量测试（含故障注入）/ SERP 3 引擎命中率 ≥90% / chrome-devtools-mcp 1.6.x 契约 + Rust helper AX 契约 / 跨平台 launcher / doctor CLI 90% / 文档（用户/集成/故障/selector 维护）。

---

## 附录 A：关键接口签名汇总（最终版）

```python
# === Tool Layer (暴露给 CC，4 能力工具 + admin) ===
@mcp.tool()
async def search(query: str, limit: int = 10, engine: str = "zhipu",
                 region: str = "cn", no_cache: bool = False) -> SearchResult: ...

@mcp.tool()
async def browse_headless(url: str, action: str = "snapshot",
                          options: BrowseOptions | None = None) -> BrowseResult: ...

@mcp.tool()
async def browse_logged_in(url: str, action: str = "snapshot",
                           options: BrowseOptions | None = None) -> BrowseResult: ...

@mcp.tool()
async def desktop(action: str = "snapshot",
                  options: DesktopOptions | None = None) -> DesktopResult: ...

@mcp.tool()
async def channel_health() -> dict: ...      # admin (v0.7)
@mcp.tool()
async def doctor() -> dict: ...              # readiness JSON (v0.1, F3.6.7)

# === Options (对象化，11 F1 + 12 F.7) ===
@dataclass
class ExpectCondition:
    text: str | None = None; selector: str | None = None
    url_contains: str | None = None; gone: bool = False; timeout_ms: int = 5000

@dataclass
class ScreenshotSpec:
    full: bool = False; element: str | None = None

@dataclass
class BrowseOptions:
    selectors: dict | None = None; js: str | None = None
    steps: list[Step] | None = None
    expect: ExpectCondition | None = None       # F3.2.18
    wait_until: str = "networkidle"; screenshot: ScreenshotSpec | None = None
    timeout_ms: int = 30000; no_cache: bool = False

@dataclass
class DesktopOptions:
    app: str | None = None; max_depth: int = 8
    actions: list[UiAction] | None = None       # click/type/press/scroll/hotkey
    expect: ExpectCondition | None = None
    screenshot_region: Rect | None = None; timeout_ms: int = 30000

# === Channel Layer (分层，13 审查 #2) ===
class BaseChannel(ABC):
    async def is_available(self) -> bool: ...
    async def status(self) -> ChannelStatus: ...
    async def health_check(self) -> Health: ...

class UiChannel(BaseChannel):
    async def observe(self, task: InteractTask) -> OutlineSnapshot: ...
    async def act(self, task: InteractTask) -> ActResult: ...
    async def wait(self, task: InteractTask) -> TriState: ...
    def capabilities(self) -> CapabilityBag: ...

# SearchChannel(BaseChannel)  # 只通用层
# BrowseChannel(UiChannel) → HeadlessChannel / LoggedInChannel
# DesktopChannel(UiChannel)  # 4 providers: ax/appleScript/cgEvent/screenshotVlm

# === Handler Layer (单一 fallback 引擎) ===
def isFallbackWorthy(err: Exception) -> bool: ...   # 限流/超时/5xx/202空/政策性
def get_fallback_channel(current: str, task: InteractTask) -> str | None: ...
async def run_with_fallback(task, plan: FallbackPlan, channels, breakers) -> InteractResult: ...

# === Subprocess Manager (纯 lifecycle，不含协议帧) ===
class SubprocessManager:
    async def ensure_running(self, name: str) -> subprocess.Popen: ...
    async def health_probe(self, name: str) -> Health: ...
    async def _spawn_with_backoff(self, name: str) -> subprocess.Popen: ...
    async def cleanup_zombies(self): ...

# === Config (统一 ProviderConfig 注册表，11 F3) ===
@dataclass
class ProviderConfig:
    name: str; type: Literal["api_key","broker","self_hosted"]
    endpoint_url: str | None; keys: list[str]
    free_quota_per_month: int; quota_model: str
    policy_risk: str; licence: str; commercial_safe: bool; fallback_order: int
```

---

## 附录 B：CC 工具描述模板（路由提示内嵌）

```python
SEARCH_DESCRIPTION = """
Default structured web search via Zhipu web-search-prime. Fast, cheap, clean JSON.
AUTOMATIC FALLBACK: on rate limit/timeout/5xx/empty, transparently falls back to
browse_headless real-search. outcome/fallback_used tells you which path served you.
Use for: most keyword searches on public content.
Prefer browse_logged_in for: sites showing different content to logged-in users.
Prefer browse_headless for: scraping a specific known URL.
Prefer desktop for: native macOS apps (not browser pages).
"""

BROWSE_HEADLESS_DESCRIPTION = """
Clean, isolated headless Chromium. No login state.
Page state written to ~/.cache/lasso/<run_id>/, only short pointer returned (saves tokens).
Use for: public pages / JS-heavy SPAs / SERP fallback / screenshots.
Prefer browse_logged_in for: sites requiring auth.
Prefer search for: simple keyword search (faster/cheaper).
SECURITY: URL is SSRF-checked (allowRanges). evaluate_script is documented risk.
"""

BROWSE_LOGGED_IN_DESCRIPTION = """
Reuses your already-logged-in local Chrome via CDP port 9222.
REQUIREMENTS: Chrome running with --remote-debugging-port=9222 (use `lasso launch-chrome`);
you must have completed login (including 2FA) in this Chrome first.
DOES NOT: auto-login / solve 2FA (returns NEEDS_MANUAL_2FA) / export cookies.
Use for: authenticated sites (GitHub private, Jira, internal tools).
Prefer browse_headless for: public pages (cheaper).
"""

DESKTOP_DESCRIPTION = """
Controls native macOS apps via Accessibility (AXAPI) — no screenshots by default.
Use for: native apps without API/CLI (Finder/Mail/Safari/System Settings), where
browser tools can't reach.
Fallback chain (automatic): AX tree → AppleScript → CGEvent → screenshot+VLM (canvas/Metal).
DOES NOT: solve TCC permissions (run `lasso doctor`), control non-macOS (v1.0+).
Prefer browse_* for: web pages. Prefer search for: keyword search.
"""
```

---

## 文档结束

**本文档是 Lasso 权威架构基线**（2026-07-21 重写，合并 07/10/11/12/13 所有修正，清除增量附录累积与矛盾）。覆盖 MVP → v1.0 全周期（~120 项 F 编号，含 desktop F3.10 + forest F3.11）。下游：[09 排期](09-media-interact-实施排期.md)。
