# CC 统一对外交互抓手 MCP — 开源空白度分析报告

> 基于 6 个角度的调研综合，从「CC 统一对外交互抓手」高度判断用户想法的开源空白度。
> 用户终极定位：一个 MCP 让 CC 高效和外部世界交互。第一波通道 = 无头浏览器(chrome-devtools-mcp --headless --isolated) + 登录态浏览器(--browser-url) + websearch(智谱 web-search-prime)，websearch 失败时降级到无头浏览器去搜索引擎实搜。本质是 media-gen-mcp「所有图像操作归一个 MCP」模式在外部交互领域的复用：「所有外部交互归一个 MCP」，带 fallback 链。

---

## 1. 已有方案地图（按 6 个角度）

### 角度 1：聚合搜索 MCP（多源 web search 聚合 + fallback/能力袋路由）

| 项目 | 相似度 | 关键判断 |
|---|---|---|
| [Khamel83/argus](https://github.com/Khamel83/argus) | **high** | 14 个搜索 provider + tier0/1/3 路由 + budget-aware + RRF 融合 + 12 步抽取 fallback 链（含 Playwright/Obscura/Crawl4AI/Wayback）。**几乎是 media-gen-mcp 0.10/0.11 在搜索领域的镜像**。但浏览器仅用于 extraction 兜底，不做任意导航/点击/截图，没有「保登录态私人浏览器」。 |
| [robbyczgw-cla/web-search-plus-mcp](https://github.com/robbyczgw-cla/web-search-plus-mcp) | **high** | 设计哲学最像 media-gen-mcp：能力袋 + evidence contract（attempts/receipts/provenance）+ doctor 健康检查 + Classic Routing v2 按查询类别选 provider。**仅做 search + extract 两个工具，无浏览器自动化层**。 |
| [guptabhishek/multi-search-mcp](https://github.com/guptabhishek/multi-search-mcp) | medium | 最简洁的「聚合 + fallback」实现，4 provider + priority/random 策略。卖点「跨 provider 攒免费额度」。PoC 级参考。 |
| [tickernelz/mcp-web-search](https://github.com/tickernelz/mcp-web-search) | medium | 免费优先 + SSRF 防护 + Reddit JSON 适配器。`browser engine` 字段注明 reserved for future，**没真做浏览器兜底**。 |
| [Aas-ee/open-webSearch](https://github.com/Aas-ee/open-webSearch) | medium | **唯一把「搜索失败→浏览器兜底」做成正式机制的**（但仅限 Bing 一家），`PLAYWRIGHT_CDP_ENDPOINT` 显式支持复用登录 Chrome。中英文搜索覆盖最全（含百度/CSDN/掘金）。 |

**结论**：搜索聚合本身**已红海、不空白**。但「搜索 + 浏览器自动化（headless + 登录态）」的合流是空白。

### 角度 2：聚合多模式浏览器 + 搜索 + fallback 链的「CC 统一对外交互抓手 MCP」

| 项目 | 相似度 | 关键判断 |
|---|---|---|
| [Khamel83/argus](https://github.com/Khamel83/argus) | **high** | 子能力（搜索+fallback 链）的成熟范本。完全不碰浏览器多模式统一封装。 |
| [SamuraiBuddha/mcp-orchestrator](https://lobehub.com/mcp/samuraibuddha-mcp-orchestrator) | medium | 元模式范本：Claude 只看到 4 个 orchestrator 工具而非 100+。**跨域通用 router，不是浏览器专精，无 fallback 链概念**。 |
| [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | medium | 用户想法 (a)+(b) 通道的底层封装对象。**官方「一个进程选一种模式」**，要切换得手动起多进程（issue #926 明确多 session 要外部管理）。 |
| [browser-use MCP](https://docs.browser-use.com/integrations/mcp-server) | low | 同时有 local/cloud + 持久 profile，**模式之间是 deployment 选项而非「同一工具调用的 fallback 链」**。 |
| [browserbase/mcp-server-browserbase](https://github.com/browserbase/mcp-server-browserbase) | low | 云浏览器模式代表实现，**只做「云」一种模式，无 fallback 链**。 |

**结论**：**这个角度基本空白**。没有任何项目同时做到三件事：多浏览器模式统一封装 + 叠加 websearch + 显式 fallback 链。

### 角度 3：「搜索 + 浏览器组合 MCP」（同一 MCP 同时暴露搜索工具 + 浏览器操作工具）

| 项目 | 相似度 | 关键判断 |
|---|---|---|
| [firecrawl-mcp-server](https://github.com/firecrawl/firecrawl-mcp-server) | medium | 搜索侧最完整（search/scrape/crawl/map/extract/batch）。**无真浏览器自动化、无登录态保活、锁自家云服务**。 |
| [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) | medium | 浏览器侧最贴近（含双模式中的登录态模式）。`search_tabs_content` 是**对「已打开标签页」做向量语义检索，不是 web 搜索**；架构是 Chrome 扩展，非 wrapper。 |
| [Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern) | low | Vision-LLM 自适应、保登录态、2FA。**完全没有 web 搜索工具**，是「用浏览器替代搜索」的极端形态。AGPL-3.0 闭源商用不友好。 |
| [ZenRows MCP](https://docs.zenrows.com/integrations/mcp/mcp-overview) | low | 商业 SaaS API 包装，主打单一 scrape + 反爬。无独立 web search 工具。 |
| [WebMCP 规范概念](https://www.debugbear.com/blog/webmcp) (DebugBear) | low | **概念验证，非项目**。文章提出「hybrid: WebMCP + browser automation as fallback」，但发生在「网站侧」，与用户「agent 侧 MCP」正交。**为用户方向提供理论背书**。 |

**结论**：**明确的真空白**。「组合」层（Firecrawl 占搜索半、mcp-chrome 占浏览器半）**没有人合流**；更没有人以「封装官方 chrome-devtools-mcp 双模式」为架构基座；跨工具 fallback 链是**最核心的差异化**。

### 角度 4：通用 MCP proxy / gateway / aggregator 模式（用户想法的「技术底座」参考）

| 项目 | 相似度 | 关键判断 |
|---|---|---|
| [TBXark/mcp-proxy](https://github.com/TBXark/mcp-proxy) | **high** | Go 单二进制好分发。**透明转发，按前缀暴露后端工具，不理解能力语义、无 fallback**。 |
| [FastMCP Proxy](https://gofastmcp.com/v2/servers/proxy) (PrefectHQ) | **high** | **最成熟的 aggregator 实现**。`as_proxy` + MCPConfig composite + session 隔离 + mirrored component 可被本地副本覆盖（禁用后端工具的唯一官方机制）。**仍假设每个前缀对应独立后端，不做同能力多后端 fallback**。 |
| [kfirtoledo/multi-mcp](https://itnext.io/multi-mcp-exposing-multiple-mcp-servers-as-one-5732ebe3ba20) | **high** | 动态多后端代理，运行时 HTTP API 热插拔增删后端。**「同名命名空间」解决的是不同后端恰好同名，不是同能力多实现择优**。 |
| [adamwattis/mcp-proxy-server](https://github.com/adamwattis/mcp-proxy-server) | **high** | TypeScript 聚合器的事实起点（TBXark/ptbsare/MetaMCP 都源自它）。纯转发。 |
| [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) | medium | 解决「传输层不匹配」（stdio↔SSE/HTTP）。named-server 模式按 `/servers/<name>/` 路径区分，**不合并 tools 列表**。 |
| [ravitemer/mcp-hub](https://github.com/ravitemer/mcp-hub) | medium | 偏 DevOps/管理面，带 Web UI。 |
| [mcp-orchestrator (rupinder2)](https://claudemarketplaces.com/mcp/rupinder2/mcp-orchestrator) | medium | 「上面再盖一层减少工具数量」，**本质还是聚合器变体，无能力编排 + fallback**。 |

**结论**：通用底座**已成熟、可直接借鉴**（尤其 FastMCP Proxy 的 composite + session isolation、kfirtoledo 的运行时增删 API）。但「带应用层 fallback 链的能力型抓手」**是真实空白**。

### 角度 5：浏览器兜底搜索（API fail → browser fallback，fallback 链最后一环）

| 项目 | 相似度 | 关键判断 |
|---|---|---|
| [Aas-ee/open-webSearch](https://github.com/Aas-ee/open-webSearch) | **high** | `SEARCH_MODE=auto` 即「request 失败→Playwright 浏览器兜底」的 fallback 链；CDP 复用登录态的 5 号配置路径正是用户 (b) keep-login 的实现技巧。**不对外暴露通用「无头浏览器工具」**。 |
| [yokingma/one-search-mcp](https://github.com/yokingma/one-search-mcp) | **high** | `SEARCH_PROVIDER=local` 用 puppeteer-core 启本地 Chrome 做 Bing/Google/Baidu/Sogou 真实搜索。**仍只覆盖 search+scrape，没有把「通用无头浏览器」「登录态浏览器」作为一等工具暴露**。 |
| [pranavms13/web-search-mcp](https://github.com/pranavms13/web-search-mcp) | medium | 浏览器即搜索工具，**缺少「API 优先 + 浏览器兜底」的双层结构**，本身就是兜底路径。 |
| [zhiqi-li/browser-mcp-cdp](https://github.com/zhiqi-li/browser-mcp-cdp) | medium | 对应用户 (b) 通道（CDP 驱动已登录 Chrome）。**单独存在，不与 search 聚合**。 |
| [fangsylar-pixel/browser-search](https://github.com/fangsylar-pixel/browser-search) | medium | CDP 真浏览器 + 多引擎，定位是「无 API key 搜索」而非 fallback。 |

**结论**：**「单点齐全、聚合空白」**。微模式「API→浏览器兜底」已验证可行（open-webSearch/one-search-mcp），但「一个 MCP 同时聚合 (a) 无头浏览器 + (b) 登录态浏览器 + (c) websearch（带降级）」**完全没有对应项目**。

### 角度 6：专为 Claude Code/Cursor/agent 做的「统一外部交互聚合 MCP」

| 项目 | 相似度 | 关键判断 |
|---|---|---|
| [Vincentwei1021/agent-toolbox](https://github.com/Vincentwei1021/agent-toolbox) | medium | **方向最接近**：明确把「AI agent 与外部世界交互」多类能力统一进一个 MCP。3 处关键差异：(1) 封装托管付费 REST API 不是本地浏览器原语；(2) 无双浏览器模式；(3) 无 fallback 降级链。**最大威胁项**。 |
| [athapong/aio-mcp](https://github.com/athapong/aio-mcp) | medium | 「All-in-one MCP」命名直接对标，含 Brave + Gemini 双搜索源。**聚焦 SaaS 服务集成（Jira/Confluence/GitLab/Gmail），不是浏览器原语；两搜索源平行可选，无降级链**。 |
| [wonderwhy-er/DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) | low | **「所有 X 归一个 MCP」模式最成功验证**（用户证言「取代 Cursor/Windsurf」）。明确不覆盖 web 搜索/浏览器。**是用户外部交互抓手的「本地控制面双子星」**。 |
| [metatool-ai/metatool-app](https://github.com/metatool-ai/metatool-app) (2.4k stars) | low | 「one MCP to manage them all」。**是聚合 OTHER MCP 服务器（连接编排层），自己不拥有工具**。与用户「一手工具 MCP」本质不同。 |
| [Data-Everything/mcp-server-templates](https://github.com/Data-Everything/mcp-server-templates) (19 stars) | low | slogan「One server. All tools.」**撞名风险**，但实现路径不同（SaaS app 连接平台模板）。威胁低。 |

**结论**：**聚合 MCP 品类不空白（24 个项目、58.8k stars），但用户的三支柱具体组合没有任何项目覆盖**。

---

## 2. 最接近用户想法的 3 个项目

### Top 1：[Khamel83/argus](https://github.com/Khamel83/argus) — 工程范式范本（不是产品形态范本）

**是什么**：多 provider web search broker for AI agents。14 个搜索 provider + tier-based 路由（Tier0 免费→Tier1 月度→Tier3 一次性）+ budget-aware 自动跳过耗尽 provider + RRF 融合 + 12 步 URL 提取 fallback 链 + 4 种集成路径（CLI/HTTP/MCP/Python SDK）。

**为什么最接近**：它是 media-gen-mcp 0.10/0.11「能力袋 + fallback 链 + handler 层 helper」模式在搜索领域的**镜像复刻**。tier routing 对应 media-gen-mcp 的 provider 能力矩阵；12 步 fallback 链对应 media-gen-mcp 0.10.0 的 handler 层 isFallbackWorthy/getFallbackProvider；Obscura（Rust 隐身 headless 浏览器）做抽取兜底，**与用户「搜索失败→浏览器兜底」思路同源**。

**关键差异（3 处）**：
1. Argus 把浏览器（Playwright/Obscura）**仅用于 extraction 兜底**，不做任意页面导航/点击/截图；
2. 没有「保持登录态的私人浏览器」——Obscura 是匿名 stealth 方向相反；
3. 没有用户独有的「websearch API 全挂时降级到驱动真实浏览器去搜索引擎搜」这种**跨模态 search→browser fallback**。

**借鉴价值**：tier routing + 12-step fallback 链 + budget 管理是**可直接抄的工程范式**（连 Rust headless 浏览器 Obscura 的设计思路都对得上）。

### Top 2：[Aas-ee/open-webSearch](https://github.com/Aas-ee/open-webSearch) — 浏览器兜底搜索的最完整实现

**是什么**：多引擎搜索 MCP + CLI + 本地 daemon + skill，8 引擎（Bing/Baidu/DuckDuckGo/Exa/Brave/CSDN/掘金/Startpage），6 工具。

**为什么接近**：唯一同时具备两个用户想要 germ 的项目——
- `SEARCH_MODE=auto`：**「request 失败→Playwright 浏览器兜底」做成正式机制**（但仅限 Bing 一家）；
- `PLAYWRIGHT_CDP_ENDPOINT`：**显式支持复用「已登录的 Chrome 会话」**，与用户 (b) keep-login 方向一致。

**关键差异**：
1. fallback 链**不是全 provider 的**（只 Bing 有）；
2. CDP 复用**仅用于 Bing/CSDN/知乎抓取**，不是一等公民工具；
3. 不对外暴露「通用无头浏览器工具」或「通用登录态浏览器工具」——浏览器是搜索内部的实现细节。

**借鉴价值**：fallback 链最后一环的具体技术参考实现（4 种浏览器接入：headless / 本地 Chrome 二进制 / 远程 ws / CDP 复用已登录会话）。

### Top 3：[hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) — 登录态浏览器工具的最完整实现

**是什么**：基于 Chrome 扩展的 MCP server，直接复用用户日常 Chrome（保登录态/cookies/配置），20+ 工具：导航/截图/网络监控/点击填表/书签历史/脚本注入 + 内置向量库对打开的标签页做语义检索。

**为什么接近**：占用户「浏览器半边」（含双模式中的登录态模式）。

**关键差异**：
1. `search_tabs_content` 是对「已打开标签页」做向量语义检索，**不是 web 搜索**，无任何 websearch 工具；
2. 架构是 **Chrome 扩展+本地 bridge**，而非「封装 chrome-devtools-mcp」的 wrapper（扩展直接用 Chrome 原生 API，绕过 CDP）；
3. **无 headless/isolated 干净环境模式**，强依赖用户日常浏览器；
4. 无跨工具 fallback 概念。

**借鉴价值**：保登录态浏览器的工具集设计（20+ 工具的粒度划分）。

---

## 3. 用户想法的真正空白/差异化（开源缺的到底是什么）

从「控制抓手」高度看，开源生态缺的是**这一层：在通用 MCP aggregator 底座之上，做「能力编排 + 跨模态降级」的应用层**。具体 5 个空白点：

### 空白 1：跨模态 fallback 链（搜索 API → 浏览器实搜）— 最核心差异化

所有现有 fallback 都是**「同工具内重试/降级」**：
- Firecrawl 是 rate-limit 重试 + 指数退避；
- mrkrsl/web-search-mcp 是 HTTP/2→HTTP/1.1 传输降级；
- ZenRows 是 anti-bot 重试；
- Argus 的 Playwright 只兜底 extraction 不兜底 search；
- open-webSearch 的 Playwright 只兜底 Bing 一家。

**没有任何项目做「搜索工具失败→降级到浏览器工具去搜索引擎实搜」这种跨工具、跨模态的兜底**。DebugBear 的 WebMCP 文章在概念层提出 hybrid fallback，但那是「网站声明式工具 vs 浏览器 DOM」轴，不是「搜索 API vs 浏览器搜引擎」轴，且是网站侧规范不是 agent 侧 MCP。

### 空白 2：同一 MCP 多实例 = 多「通道」抽象

用户要**封装 chrome-devtools-mcp 两次**：`--headless --isolated` 一个通道、`--browser-url` 一个通道（保持登录态）。现有 aggregator 模型里「每个后端是不同 server」，跑同一 server 两个实例并按「使用场景」区分通道（而非按 server 名区分）**是空白**。这要求**「能力导向命名」（browse_headless / browse_logged_in）而非「后端导向命名」（chrome_devtools_1 / chrome_devtools_2）**。

### 空白 3：登录态浏览器作为一等公民

chrome-devtools-mcp `--browser-url` 复用本人 Chrome 会话，**用于需登录的搜索/抓取**——这个组合在所有候选里都找不到。open-webSearch 仅在 CDP endpoint 上有个雏形（且仅用于 Bing/CSDN/知乎），Argus 的 Obscura 是匿名 stealth（方向相反），hangwin/mcp-chrome 是扩展非 wrapper。**「登录态浏览器 × 搜索降级链」是用户最独特的差异点**。

### 空白 4：以「封装官方 chrome-devtools-mcp 双模式」为架构基座

用户是要在 chrome-devtools-mcp（Google 官方）**外面再套一层统一抓手**。现有项目都是各自直接实现浏览器控制（Chrome 扩展 / Playwright / CDP），**没有人以「封装官方 chrome-devtools-mcp 双模式」为架构基座**。这意味着用户对 chrome-devtools-mcp 上游升级是零侵入跟随的。

### 空白 5：CC 专属外部交互抓手（非 SaaS 聚合、非企业 gateway、非通用 router）

定位明确为「CC 对外唯一入口」的**个人 control surface**。现有三类项目都不是这个定位：
- **聚合器/MetaMCP**：自己不提供工具，只转发；
- **SaaS 集成中心**（MindsDB/Pipedream/anyquery/Vincentwei1021/agent-toolbox）：锁商业云；
- **企业 gateway**：偏 DevOps。

唯一同形态的是 wonderwhy-er/DesktopCommanderMCP（**本地控制面双子星**：一个管本地 terminal+fs+code，一个管外部 browser+search），但它明确不覆盖外部交互。

### 综合判断

「搜索聚合 MCP」**子角度已红海**（Argus / web-search-plus-mcp / multi-search-mcp / mcp-web-search / open-webSearch 共 5 个成熟项目做了完全相同的事）。但「**CC 统一对外交互抓手 MCP（搜索 + 无头浏览器 + 登录态浏览器 + 跨模态 fallback 链）**」是**真空白**，与 media-gen-mcp 的「所有图像操作归一个 MCP」是**同构机会**——一个已被用户自己验证过的成熟模式，第一次移植到外部交互领域。

---

## 4. 技术底座参考

### 4.1 Aggregator 底座：直接借鉴 FastMCP Proxy

[FastMCP Proxy (PrefectHQ)](https://gofastmcp.com/v2/servers/proxy) 是**最成熟的 aggregator 实现**，作为用户的「技术底座」直接可用：

- **composite proxy**：用 `MCPConfig` 自动 mount 多个后端（chrome-devtools-mcp × 2 + web-search-prime 都 mount 进来）；
- **session 隔离**：天然支持多后端并发；
- **transport 桥接**：stdio ↔ SSE/StreamableHTTP 自动转换；
- **mirrored component 可被本地副本覆盖**：这是**禁用某个后端工具**的唯一官方机制（用来隐藏 chrome-devtools-mcp 的底层工具，只暴露用户精心策划的小工具集）。

**关键限制**：FastMCP Proxy 假设每个前缀对应独立后端，**不会自动把 websearch 的失败路由到浏览器后端**。fallback 链必须用户自己在 tool 实现里写——**就像 media-gen-mcp 的 handler 层 fallback**（`isFallbackWorthy` / `getFallbackProvider` / `activeProvider` 防错位 / 60s 熔断两层）。

### 4.2 运行时热插拔：借鉴 kfirtoledo/multi-mcp

[kfirtoledo/multi-mcp](https://itnext.io/multi-mcp-exposing-multiple-mcp-servers-as-one-5732ebe3ba20) 的「运行时 HTTP API 热插拔增删后端」对用户「**后续加更多搜索源到降级链**」很有参考价值——不需重启 MCP 即可挂载新的搜索 provider。

### 4.3 chrome-devtools-mcp 双模式封装方案

chrome-devtools-mcp 官方是「一个进程选一种模式」（issue #926 明确多 session 要外部管理）。封装方案：

```
┌─────────────────────────────────────────────────────┐
│  unified-interaction-mcp  (用户的 MCP，单进程)        │
│  ─────────────────────────────────────────────────  │
│  tools: search / browse_headless / browse_logged_in │
│  handler 层：fallback 链（仿 media-gen-mcp 0.10.0） │
└────────┬──────────────┬──────────────┬─────────────┘
         │ stdio        │ stdio        │ stdio
   ┌─────▼─────┐  ┌─────▼─────┐  ┌────▼──────────┐
   │ chrome-   │  │ chrome-   │  │ 智谱 web-     │
   │ devtools- │  │ devtools- │  │ search-prime  │
   │ mcp       │  │ mcp       │  │ MCP           │
   │ --headless│  │ --browser │  │               │
   │ --isolated│  │ -url      │  │               │
   └───────────┘  └───────────┘  └───────────────┘
```

每个后端是独立子进程，用户 MCP 通过 stdio 与之通信；对 CC 暴露的是 3 个精心命名的工具（能力导向命名），背后由 handler 层决定路由与降级。

### 4.4 Fallback 链设计（直接复用 media-gen-mcp 范式）

```
search(query)
  │
  ├─ try: 智谱 web-search-prime（activeProvider）
  │     │
  │     ├─ isFallbackWorthy(err)？no → return
  │     │     yes（限流/超时/网络挂/429/5xx）
  │     │
  │     └─ fallback provider 1: chrome-devtools-mcp --headless
  │           ├─ 用无头浏览器访问 baidu.com/google.com
  │           ├─ 抽取 SERP 结果
  │           └─ return（标注 fallbackUsed=true）
  │
  └─ 最终失败 → 抛错给 CC（不让 CC 看到 fallback 内部细节）
```

**复用 media-gen-mcp 0.10.0 的 4 个抽象**：
1. `isFallbackWorthy(err)`：判断错误是否值得降级（限流/超时/网络挂才降级，参数错误不降级）；
2. `getFallbackProvider()`：返回下一个 provider（铁律：poll 不 fallback）；
3. `activeProvider` 防错位：记录当前活跃 provider 避免请求错位；
4. 60s 熔断两层：短熔断（避免连续失败）+ 长熔断（避免长时间降级）。

### 4.5 浏览器兜底搜索的技术参考

- [Aas-ee/open-webSearch](https://github.com/Aas-ee/open-webSearch) 的 `SEARCH_MODE=auto` 提供「request 失败→Playwright 兜底」的完整代码参考；
- [yokingma/one-search-mcp](https://github.com/yokingma/one-search-mcp) 的 `SEARCH_PROVIDER=local` 提供「puppeteer-core 启本地 Chrome 做 Bing/Google/Baidu/Sogou 真实搜索」的 SERP 抽取实现；
- [pranavms13/web-search-mcp](https://github.com/pranavms13/web-search-mcp) 提供 Playwright SERP 抽取的极简实现。

---

## 5. 初步可行性判断（三维度）

### 技术可行性：**高**

- 三条通道的底层封装对象（chrome-devtools-mcp / 智谱 web-search-prime MCP）**都是成熟开源项目**；
- Aggregator 底座（FastMCP Proxy / TBXark / kfirtoledo）**已成熟可直接用**；
- Fallback 链范式**用户自己在 media-gen-mcp 0.10.0 已验证过**（handler 层 isFallbackWorthy/getFallbackProvider/activeProvider/60s 熔断两层），是同构迁移；
- 浏览器兜底搜索的微模式（open-webSearch/one-search-mcp）**已验证可行**。

**技术风险点**：
- chrome-devtools-mcp 双进程管理（启动/重启/僵尸进程清理）需要工程化处理；
- 登录态浏览器的 session 持久化与 cookie 失效检测；
- 浏览器兜底的 SERP 抽取在不同搜索引擎（百度/Google/Bing）上需要分别维护 selector（**这是持续的维护负担，不是一次性成本**）。

### 架构可行性：**高**

- 「所有外部交互归一个 MCP」**与 media-gen-mcp 是同构模式**，已被用户验证可落地（media-gen-mcp 0.11.0 已发布 npm + GitHub）；
- 单 MCP 多通道的「能力导向命名」**符合 CC 工具设计最佳实践**（少而精的工具集 > 大量同质工具）；
- fallback 链的 handler 层实现**不依赖任何上游改动**，完全在用户自己的 MCP 里完成。

**架构风险点**：
- 「同一 MCP 多实例 = 多通道」的命名空间管理（如何让 CC 理解 `browse_headless` 和 `browse_logged_in` 的语义差异，而不是把它们当重复工具）；
- 后续加更多搜索源/抓取源/外部交互能力时，工具数量膨胀的控制（**能力袋分组 + tool_manager 动态启停** 是 athapong/aio-mcp 已验证的解法）。

### 差异化可行性：**高（但窗口期有限）**

- 「跨模态 fallback 链 + 登录态浏览器一等公民 + 封装官方 chrome-devtools-mcp 双模式」**三空白组合没有任何项目覆盖**；
- 最大威胁项 **[Vincentwei1021/agent-toolbox](https://github.com/Vincentwei1021/agent-toolbox) 已变现**（外部交互统一 MCP，但走 SaaS 路线），**athapong/aio-mcp 已验证 all-in-one 模式**——如果他们中任何一个意识到「封装本地浏览器原语 + fallback 链」是下一步，窗口就会关闭；
- DebugBear 的 WebMCP 概念已为「hybrid fallback」提供行业共识背书，说明这个方向**正在成为主流认知**。

### 倾向性意见（不替用户做最终决定）

**值得做，且应优先做**。理由：
1. 是 media-gen-mcp 已验证模式的同构迁移（**最低研发风险**）；
2. 三空白组合的差异化窗口**真实存在但有限**；
3. 与用户已有项目矩阵（media-gen-mcp / luceo / 简历秀秀 / 王栋求职简历）**正交不冲突**，是外部交互领域的自然延伸；
4. CC 用户对外部交互抓手的痛点真实存在（目前 CC 用户需手动配 chrome-devtools-mcp + 智谱 MCP + 自己写降级逻辑）。

**不建议立即做**的前提：如果用户对 CC 生态的长期投入有犹豫，或 media-gen-mcp 还有未完成的优先级（如 #3 图像编辑 API），应先完成手头项目再启动。

---

## 6. 给这个项目的定位建议

### 命名建议（候选 3 个）

1. **`Lasso`**（首选）— 与 media-gen-mcp 形成「media- verb-mcp」双子星品牌矩阵（生成 vs 交互），认知成本最低；
2. **`external-hub-mcp`** — 强调「外部世界交互枢纽」定位，不绑定 media 前缀；
3. **`cc-outreach-mcp`** — 强调「CC 对外抓手」专属定位（但绑定 CC 可能限制其他 agent 适用性）。

### 核心卖点（一句话）

> **「CC 通过这唯一一个 MCP，就能高效和外部世界交互——websearch 优先、无头浏览器兜底、登录态浏览器专攻需登录站点，三层 fallback 链自动降级，永不返回失败。」**

对标 Argus 的「14 provider + 12 步 fallback 链」叙事，用户的叙事是「**3 通道（API+headless+logged-in）× 跨模态 fallback × CC 专属**」。

### 第一波 MVP 工具集（3 个工具，对齐用户的三通道）

| 工具名 | 通道 | 底层 | 何时用 |
|---|---|---|---|
| `search(query, opts?)` | (c) websearch | 智谱 web-search-prime MCP | 默认入口，API 调用快、便宜、结构化 |
| `browse_headless(url, action?, opts?)` | (a) 无头浏览器 | chrome-devtools-mcp `--headless --isolated` | 干净环境抓取、JS 渲染、绕基础反爬 |
| `browse_logged_in(url, action?, opts?)` | (b) 登录态浏览器 | chrome-devtools-mcp `--browser-url` | 需登录的站点（私域/付费墙/2FA） |

### Fallback 链 MVP（最小可用）

```
search(query)
  └─ 智谱 web-search-prime
       ├─ 成功 → return
       └─ isFallbackWorthy(err)（限流/超时/网络挂）
            └─ browse_headless("https://baidu.com/s?wd=" + query)
                 ├─ 抽取 SERP → return（fallbackUsed=true）
                 └─ 失败 → 抛错给 CC
```

**MVP 不做的事**（明确排除）：
- 不做 provider 矩阵（只接智谱一家，避免变成 Argus）；
- 不做 RRF 融合（单 provider 不需要）；
- 不做 corpus 持久化（不在本地建搜索缓存）；
- 不做云浏览器通道（browserbase 留给 v2）；
- 不做多搜索引擎兜底（先只做百度或 Google 一家，控制 selector 维护成本）。

### MVP 之后的演进路径（v0.2 → v0.5）

- **v0.2**：加第二个搜索源（Brave Search 或 Tavily）→ provider 矩阵雏形；
- **v0.3**：`browse_headless` 加多步任务能力（navigate + click + extract 链式）；
- **v0.4**：加第四通道 `browse_cloud`（封装 browserbase/stagehand，云浏览器）；
- **v0.5**：加更多外部交互能力（fetch_url / screenshot / pdf_extract 等，向 agent-toolbox 靠拢但保持本地原语路线）。

### 与 media-gen-mcp 的协同（品牌矩阵）

```
                ┌─────────────────────┐
                │   media-gen-mcp     │   ← 所有图像操作归一个 MCP
                │   (生成 + 识别)     │
                └─────────────────────┘
                          │
                  CC 双子星品牌矩阵
                          │
                ┌─────────────────────┐
                │ Lasso  │   ← 所有外部交互归一个 MCP
                │ (search + browse)   │
                └─────────────────────┘
```

两个 MCP 共享同一套工程范式（handler 层 fallback / 能力袋 / 能力导向命名 / 单 MCP 多通道），用户可用同一套心智模型维护两个项目。

---

## 关键源链接索引

**搜索聚合类**
- https://github.com/Khamel83/argus
- https://github.com/robbyczgw-cla/web-search-plus-mcp
- https://github.com/guptabhishek/multi-search-mcp
- https://github.com/tickernelz/mcp-web-search
- https://github.com/Aas-ee/open-webSearch

**浏览器 + 搜索组合类**
- https://github.com/firecrawl/firecrawl-mcp-server
- https://github.com/hangwin/mcp-chrome
- https://github.com/Skyvern-AI/skyvern
- https://github.com/ChromeDevTools/chrome-devtools-mcp
- https://docs.browser-use.com/integrations/mcp-server
- https://github.com/browserbase/mcp-server-browserbase

**通用 MCP aggregator 底座**
- https://github.com/TBXark/mcp-proxy
- https://gofastmcp.com/v2/servers/proxy
- https://itnext.io/multi-mcp-exposing-multiple-mcp-servers-as-one-5732ebe3ba20
- https://github.com/adamwattis/mcp-proxy-server
- https://github.com/sparfenyuk/mcp-proxy

**浏览器兜底搜索**
- https://github.com/yokingma/one-search-mcp
- https://github.com/pranavms13/web-search-mcp
- https://github.com/zhiqi-li/browser-mcp-cdp
- https://github.com/fangsylar-pixel/browser-search

**统一外部交互聚合 MCP（最大威胁项）**
- https://github.com/Vincentwei1021/agent-toolbox
- https://github.com/athapong/aio-mcp
- https://github.com/wonderwhy-er/DesktopCommanderMCP
- https://github.com/metatool-ai/metatool-app

**概念背书**
- https://www.debugbear.com/blog/webmcp （hybrid fallback 行业共识）
- https://github.com/SamuraiBuddha/mcp-orchestrator （元抓手模式范本）