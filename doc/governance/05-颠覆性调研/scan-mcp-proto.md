# scan-mcp-proto — MCP 协议层新能力 × Lasso 适用性调研

> 调研员：MCP 协议创新方向 | 日期：2026-08-17
> 方法论：doc/governance/04 检讨产物首次执行——①零基视角（用户要什么/约束是什么）；②每条附 L-COST；③不以「开源都这样做」为最优证据（幸存者偏差禁令）。
> 结论速览：**7 项中 1 项 GO 候选（elicitation）、1 项「防错误投资」负结论（sampling）、2 项等待、3 项不适用/已具备**。另捕获 2 个任务书未列但更重要的发现：CC Channels 推送契约 + 2026-07-28 stateless 迁移窗口。

---

## 0. 背景基线（调研时点事实）

- **Lasso 现状**：`@modelcontextprotocol/sdk ^1.30.0`（v1 家族），`StdioServerTransport`（src/index.ts:1193）。VLM 档 = `LASSO_VLM_ENDPOINT` → HTTP MCP 调 media-gen-mcp vlm 工具（ScreenshotVlmProvider.ts）。
- **协议时点**：最新 spec = **2026-07-28**（第 5 版，stateless core，2026-07-28 发布）；TypeScript SDK v2 stable 与 spec 同日发布（2026-07-27/28，zread typescript-sdk/5-latest-updates）。SDK 官方明示「**not a forced migration deadline**」，v2 的 `createMcpHandler` 同一 endpoint 双时代兼容（2026-07-28 + 2025-11-25 legacy）。
- **CC 版本时点**：CHANGELOG 最新 2.1.216（已全量解析 5163 行）。

---

## ① sampling（server 借 client 的 LLM）——判定：**不适用（协议已弃用 + CC 从未支持）**

**这是本次调研最重要的负结论：防止一次注定失败的投入。**

### 协议状态
- 2026-07-28 spec changelog「Deprecated」第 1 条（SEP-2577）：**Deprecate the Roots, Sampling, and Logging features**。官方建议迁移路径原文："integrate directly with LLM provider APIs instead of Sampling"。
- 弃用非删除：官方 lifecycle 政策 = **最少 12 个月弃用窗口**（SEP-2596），期间功能仍可用，但「new implementations should not add support for them」。
- 弃用前 sampling 曾被重新设计过一版：2026-07-28 的 sampling 页仍存在，改为 MRTR（Multi Round-Trip Requests，SEP-2322）模式——server 不再直接发 server→client 请求，而是在工具结果里返回 `InputRequiredResult.inputRequests`，client 重试原请求时带 `inputResponses`；并新增 tool-enabled sampling（`sampling.tools` capability）。**即：连官方都把它改造成了「嵌入工具结果的回合内追问」，并随即整体判弃用。**

### CC 支持实证（三源三角验证，全否定）
1. **官方 CHANGELOG.md 全文 0 次 "sampling"**（v0.2.x → 2.1.216，5163 行逐行解析）。
2. **CC 官方 MCP 文档页（code.claude.com/docs/en/mcp）0 次 "sampling"**（elicitation 8 次）。
3. 官方 clients.mdx 特性矩阵：Claude Code Sampling = ❌（该矩阵本身偏旧，但方向一致）。
4. 社区佐证：claude-code issue #1785（2025-06-08，"Support for MCP Sampling to leverage Claude Max subscriptions"）为用户请求而非官方承诺；r/mcp 讨论仍以「wish Claude Code has this also sampling」为遗憾（2025-11 前后）。

### 对 Lasso 的适用性判定：不适用
- 「VLM 档零配置借 CC 模型」在**客户端不存在**、在**协议层被判死刑**的双否定下，投入即沉没。
- L-COST：实现成本 ≈ 0（不做）；机会成本规避 = 全部（避免一条 SDK+协议+客户端三头都不支持的路）。Lasso 现行 `LASSO_VLM_ENDPOINT` 显式配置方案恰是官方建议的「integrate directly with LLM provider APIs」方向——**现状即正确，非债**。
- 附带洞察：真想要「零配置 VLM」，协议外的现实路径是 CC 侧 prompt（用户让 Claude 自己看图）或本地 VLM（media-gen-mcp），二者 Lasso 已覆盖其一。

---

## ② elicitation（server 结构化问用户）——判定：**可用（GO 候选，小而明确）**

### 协议状态
- 2025-06-18 spec 引入；2025-11-25 增 URL mode（SEP-1036）；2026-07-28 改造为 MRTR 模式（`InputRequiredResult` 内嵌 elicitation 请求 + 客户端重试带回 `inputResponses`；同时删除了 `notifications/elicitation/complete`）。协议成熟、活跃演进中。
- Schema 子集有限（string/number/boolean/enum 为主，FastMCP 文档明确「MCP spec only supports a limited subset of JSON Schema types」）——表单保持简单是约束也是护栏。

### CC 支持实证（硬证据）
- **v2.1.76**（2026-03-14，官方 CHANGELOG）："Added MCP elicitation support — MCP servers can now request structured input mid-task via an interactive dialog (form fields or browser URL)" + `Elicitation`/`ElicitationResult` hooks（可编程自动应答）。
- **v2.1.117**：修复 print/SDK 模式下 `elicitation/create` 自动取消的 bug（非交互模式的兼容性也已被照顾）。
- CC 文档（en/mcp）："No configuration is required on your side: elicitation dialogs appear automatically"。Remote Control 场景 v2.1.214+ 也可应答；「call waiting on an open elicitation dialog isn't backgrounded」——语义是阻塞等人，符合直觉。
- TS SDK v1 已支持 server 侧发送（`server.request({method:"elicitation/create"})` + capability guard；v2 有 `inputRequired.elicitForm()/elicitUrl()` 封装）。

### 对 Lasso 的适用性判定：可用——旗舰场景是 **HighRiskGate**
- 现状（src/browse/HighRiskGate.ts 头注释）：logged_in 通道命中高风险 pattern（drag-drop/toasts/RTE/tree-view/data-grid）时「**放弃自动操作，升级用户（不做也不继续）**」→ outcome=didnt + error="high_risk_pattern:<kind>"，StepEngine 立即 stop。用户必须重新发起整轮请求。
- elicitation 化改造：命中时向用户弹结构化确认（「命中 RTE 高风险 pattern，片段：<outerHTML ≤200 字符>。确认继续/跳过本步/终止」），用户确认后**同一轮**继续。安全模型不变（人在环、pattern 表仍写死代码 INV-14 不从 config 读），只是把「中断升级」升级成「回合内升级」。
- 次级候选：desktop 权限缺失（tcc_event_synthesis_denied 等 didnt 类）、cloud browser API key 缺失、doctor 发现配置问题时的一次性修复确认。均为「现在返 didnt 让用户另开终端」的同构场景。
- **必须保留降级路径**：clientCapabilities.elicitation 未声明（旧 CC/其他客户端/SDK 非交互模式）→ 维持现行 didnt 行为。elicitation 是增强不是依赖（对齐 lasso「诚实 didnt」红线）。
- L-COST：实现 ≈ 单一 gate 点改造 + capability 探测 + 降级分支，估 100-200 行含测试；运行时零额外基建（同一 JSON-RPC 连接）；延迟代价 = 一次人应答（本来就要人到终端重新发起，净体验为正）。版本门槛 CC ≥ 2.1.76（2026-03 起，现存用户面基本覆盖；2.1.117+ 更稳）。

---

## ③ MCP Tasks（长任务进度）——判定：**等待**

### 协议状态
- 2025-11-25 spec 实验性引入 → **2026-07-28 升格为正式 extension**（`io.modelcontextprotocol/tasks`，SEP-2663）：弃阻塞式 `tasks/result`，改为 `tasks/get` 轮询 + `tasks/update` 客户端→server 输入；server 可无请求地主动返回 task handle。官方 roadmap（Agents WG）承认生产暴露缺口（重试语义、过期策略待定义）。
- 面向 stateless 部署设计（任何实例可从共享 task store 报告/推进任务）。

### CC 支持实证
- CC CHANGELOG 全文 **0 次 MCP Tasks**；CC 文档 0 次。2026-07-28 生态声明（claude.com 博客）只说「Support is rolling out across Claude products soon」+ Figma/Intuit 等在 connectors 侧试用——无 CC CLI 证据。

### 对 Lasso 的适用性判定：等待
- 零基视角问「用户有什么长任务痛点」：lasso 工具的 P99 都在秒级（search 降级链、browse 步进、desktop 动作、VLM 兜底 60s 超时封顶）。唯一分钟级候选是云浏览器排队，且现行 MCP progress notification（`notifications/progress`，请求内仍保留）已够表达。
- 协议要求 server 维护 task store（stateless 化的外置状态）——对单用户本地 server 是纯增复杂度，违反简单架构红线。
- L-COST：现在实现 = 高成本零收益（客户端不认）；观望成本 = 0。触发器：CC changelog 出现 Tasks 支持条目 + lasso 出现真正 >1min 的工具化长任务。

---

## ④ resources + subscriptions（订阅式推送 vs 工具拉取）——判定：**订阅不适用；真正的推送答案是 CC Channels（等待 GA，可先原型）**

### 协议状态
- 2025-06-18 时代：`resources/subscribe`/`unsubscribe` + `notifications/resources/updated`（SSE GET 通道）。
- **2026-07-28 重写**：删除 `resources/subscribe`/`unsubscribe` 与 HTTP GET 端点，改为 **`subscriptions/listen`**——单一长连 POST-response 流，客户端按类型 opt-in（`toolsListChanged`/`promptsListChanged`/`resourcesListChanged`/`resourceSubscriptions`），server 以 `subscriptionId` 标记。旧订阅 API 在新 spec 里**不存在**（typescript-sdk zread：「`resources/subscribe`… Deleted — absent from registry」）。
- Roadmap「On the Horizon」承认事件驱动仍是未完成项（webhook 回调标准化在未来）。

### CC 支持实证
- resources：v1.0.27「MCP resources can now be @-mentioned」+ v2.1.116 延迟 `resources/templates/list` 到首次 @ 提及 + v2.1.147 分页修复——CC 支持 resources 的 list/read/@-mention（旧特性矩阵 ❌ 已过时）。
- **resource 订阅：0 证据**（changelog/文档均无 `resources/subscribe` 字样）。CC 支持的动态性只有 `list_changed`（v2.1.0 加入，2025-10 前后）。
- **但 CC 有自己的推送契约（任务书未列，本调研捕获）**：**Channels**（code.claude.com/docs/en/channels-reference）——MCP server 声明 `capabilities.experimental['claude/channel']`，即可发 `notifications/claude/channel` 把事件**推进会话上下文**（包裹在 `<channel>` 标签）；事件按序排队、忙时下轮聚合交付；双向通道可暴露 reply 工具；`claude/channel/permission` 还能把**权限批准远程中继**（`permission_request` 通知 + `yes/no <id>` 裁决，v2.1.211+ 做了注入字符消毒）。状态：**research preview**，自定义通道需 Anthropic allowlist 或 `--dangerously-load-development-channels`。

### 对 Lasso 的适用性判定
- 协议级 resource 订阅：**不适用**——CC 不支持、2026-07-28 又整个换了一套 API、且 lasso 没有被 @-mention 的资源场景（工具即全部接口，符合抓取型定位）。
- CC Channels：**等待 + 可原型**。这是「desktop 值守（文件/剪贴板/窗口变化）、browse 页面变更监控」类「CC 反应式」场景的唯一现役推送通路。但 research preview + allowlist 门控 = npm 分发的用户默认跑不起来（需危险 flag），**不宜进主干**。
- L-COST：原型 ≈ 声明 experimental capability + 一条 notification（Channels 文档给了单文件 Bun 示例，量级 <100 行）；主干化成本 = 等 GA（allowlist 解除）。轮询替代（现状）：CC 定时重调 lasso 工具，每轮一次全工具调用上下文成本——若用户真有值守需求，Channels 省的是这个。

---

## ⑤ tool annotations / outputSchema 结构化输出——判定：**annotations 已完备（INV-5 达标）；outputSchema 可用但低增益**

### 协议状态
- annotations：2025-03-26 引入（title + readOnly/destructive/idempotent/openWorld 四 hint，全为 untrusted hint）。官方博客（2026-03-16 "Tool Annotations as Risk Vocabulary"）：默认悲观（无注解 = 可能破坏性 + 开放世界）；「readOnlyHint:true → 跳过确认框」是**当前最常见的客户端用法**；5 个新 SEP 在路上（trust/sensitivity/secret/unsafeOutput/trusted，GitHub+OpenAI 共同推动）。
- outputSchema/structuredContent：2025-06-18 引入；**2026-07-28 放宽到完整 JSON Schema 2020-12**（SEP-2106，任意关键字 + `$ref` 解析要求）。注意坑：TS SDK v2 默认校验器**拒绝 draft-07 schema**（typescript-sdk#2532，「most likely thing to bite us」）。

### CC 支持实证
- v1.0.44：「MCP: tool annotations and tool titles now display in /mcp view」（曾有展示错位 bug #16295，已修）。
- outputSchema：CC 作为 server 侧有两条修复记录（v2.0.33 / v2.1.101 `claude mcp serve` 与严格校验客户端的兼容）——说明生态在认真消费 outputSchema；作为 client 消费 structuredContent 属标准行为。
- **CC Tool Search（新发现，任务书未列）**：CC 文档「Tool search is enabled by default. MCP tools are deferred…Claude uses a search tool to discover relevant ones」。会话启动只装工具名+server instructions，按需检索。含义：**多工具的上下文成本已被 CC 客户端机制消化**，`forest` 统一入口的「省上下文」论据权重下降（统一调度的论据仍在）；同时**工具名/描述质量=可检索性**变成更重要杠杆。

### 对 Lasso 的适用性判定
- annotations：**已具备**——src/tools/annotations.ts 有完整四象限注册表（INV-5：每个注册必带 readOnly/openWorld），且按能力上限标注（browse readOnly=false 的理由链清晰）。无行动项；可选微调是把 desktop doctor 类的 `destructiveHint:false`（additive）补标。
- outputSchema/structuredContent：**可用、低优先**。lasso 工具已返回结构化 JSON（InteractResult 形状稳定），改造成本 = 每工具一份 2020-12 schema + SDK 校验，收益 = 客户端/下游可校验 + 免文本解析。属于「顺手做不亏、专门做不值」。若做，**必须用 2020-12 全合规 schema**（SDK v2 会拒 draft-07）。
- L-COST：annotations 0（已完成）；outputSchema 全工具 ≈ 数百行 schema + 测试，收益定性不定量 → 归入「有机会时」。

---

## ⑥ streamable HTTP vs stdio（单用户场景）——判定：**不适用（保持 stdio）**

### 协议状态
- stdio 与 streamable HTTP 双轨；HTTP+SSE 旧传输正式 Deprecated（SEP-2596）。2026-07-28 让 HTTP 侧质变（无会话、`Mcp-Method` 头路由、`ttlMs` 缓存、serverless/边缘可部署）——但这些收益**全部面向多实例横向扩展的服务端部署**。

### CC 支持实证
- v1.0.27 起 streamable HTTP 全支持（`type:"http"`/`streamable-http`，配置别名兼容官方文档）；HTTP server 断线自动重连（CC 文档 Automatic reconnection）；错误提示还显示 CC 认 `sse`/`ws` 类型。
- CC 文档定位：**stdio = 本地工具推荐**（"ideal for tools that need direct system access"，且注入 `CLAUDE_PROJECT_DIR`）；HTTP = 远程服务推荐。

### 对 Lasso 的适用性判定：不适用
- 零基视角：单用户、本机、需要 AXAPI/CGEvent/Rust bridge 直接系统访问——CC 官方推荐路径就是 stdio。HTTP 化的收益（多客户端共享一个 lasso 实例、Rust bridge 常驻跨会话）在「用户=1 个 CC」下是伪需求；代价却是端口管理、鉴权面、进程守护三座新增复杂度，直踩简单架构红线。
- 已有的 HTTP 用法（`McpClient.connectHttp` 调 media-gen-mcp、云浏览器 endpoint）是**客户端**行为，与 server 侧传输选型无关。
- L-COST：改造 ≈ 传输层 + 生命周期管理重写（大）；收益 ≈ 0（单用户）；**不做**。
- 唯一翻转条件：未来 lasso 需要被统枢 ONE / 多个本地客户端同时挂载时，加 `--http` 可选模式（SDK 一个 transport 类的增量）。

---

## ⑦ 社区最热 MCP server 的范式级创新——判定：**无 lasso 错过的范式；#1 Playwright 反向验证了 lasso 的结构化抽取路线**

### Top 20 盘点（数据源：mcpmanager.ai 2026-03 Ahrefs 全球搜索量榜 + totalum/nimbalyst 交叉）
Playwright(82k)>Figma(74k)>GitHub(69k)>Jira(40k)>Context7(32k)>Supabase(26k)>Notion(23k)>Serena(19k)>Slack(17.7k)>Browser(16.1k)>AWS/Azure/SequentialThinking/Zapier/Linear/Docker/GitLab/Obsidian/Postgres/Puppeteer。42/50 是工程向。逐个过范式级新东西：

1. **Playwright MCP（#1）——snapshot/ref 范式**：默认 `browser_snapshot` 返回可访问性树的**结构化文本**（每节点带 `ref=eN`），`browser_click` 等用 ref 定位；官方文档明确「all without any screenshots or vision models」；截图+坐标（vision mode `browser_mouse_click_xy`）是 `--caps=vision` **opt-in 的补充**，用于 canvas/WebGL 等无 a11y 节点场景（zread microsoft/playwright-mcp/9、/14）。
   **→ 对 lasso 的意义：生态第一的浏览器 agent 服务器把「结构化 DOM/语义抽取」定为主范式、把「截图+VLM」降为兜底——与 lasso browse 通道（markdown-extractor/DOM uid）+ desktop 通道（axProvider primary、ScreenshotVlm 仅 fallback 且未配 endpoint 即 didnt）的架构选择完全同向。这是架构层外部肯定，不是新动作项。**
2. **Context7（#5）——两步解析范式**：`resolve-library-id`（名称→ID）+ `query-docs`（ID→文档），强制两步管道、幂等独立可调（zread upstash/context7/8、/16）。与 lasso search 的多引擎降级链同属「把不确定解析前置成显式工具步骤」——lasso 已有等价物，无缺口。
3. **Serena（#8）——LSP 符号层**：语言服务器符号级检索代替 grep 粗粒度。启示有限：lasso 的对象是网页/桌面，ax outline 就是它的「符号层」。
4. **Zapier（#14）——动态工具面**：按会话按需暴露数千 action。CC 的 tool search（⑤）已把这类需求客户端化，且违反 lasso 的稳定工具面原则。不适用。
5. 其余（GitHub/Figma/Jira/Notion/Slack/Supabase…）：企业 API 包装，无协议层范式创新。**幸存者偏差检查**：高搜索量 ≈ 大公司生态绑定，不等于交互范式先进——本轮未发现 lasso 未覆盖的范式级新东西。

### L-COST
调研成本已付；行动项 = 0。价值 = 对 lasso 现有路线的**外部效度证明**（snapshot>vision 的优先级排序有了生态第一服务器的实证）。

---

## 8. 任务书之外的两个捕获（比部分任务书项更重要）

### 8.1 CC Channels = CC 事实上的「server→会话推送」标准（见④）
对 lasso 是唯一现役推送通路；research preview + allowlist，等待 GA。**若做颠覆性原型，这是唯一值得的协议层实验位**（desktop 值守 → `<channel>` 事件 → CC 主动反应）。

### 8.2 2026-07-28 迁移窗口（不紧急但需挂账）
- SDK v1（lasso 现用 ^1.30.0）在 legacy era（≤2025-11-25）继续工作；CC 自身也仍在双轨。官方明示无强制期限。
- 挂账清单（升级 SDK v2 时）：①`initialize` 握手删除、`server/discover` 探测；②新头部 `Mcp-Method`/`Mcp-Name`；③`ttlMs`/`cacheScope` 进 `tools/list`（对 CC 端 prompt cache 命中有益：官方 changelog 明确「deterministic order → improve LLM prompt cache hit rates」）；④JSON Schema 严格 2020-12；⑤Roots/Sampling/Logging 弃用不新增依赖（lasso 现状 0 依赖，安全）。
- L-COST：现在迁 = 中高成本零用户可见收益；挂账成本 ≈ 本文档。

---

## 9. 总判定表

| # | 能力 | 协议状态 | CC 实证 | 判定 | L-COST / 行动 |
|---|---|---|---|---|---|
| ① | sampling | **2026-07-28 已弃用**（SEP-2577，≥12 月窗口） | 从未支持（changelog 0 次） | **不适用** | 0；现状 LASSO_VLM_ENDPOINT 即官方建议路径 |
| ② | elicitation | 成熟（2025-06-18→MRTR 演进） | **v2.1.76 支持** + hooks | **可用（GO 候选）** | ≈100-200 行：HighRiskGate 回合内确认 + capability 降级 |
| ③ | Tasks | 2026-07-28 正式 extension | 无支持证据 | **等待** | 0；触发器=CC 支持条目+真实长任务 |
| ④ | resource 订阅 | 2026-07-28 换 `subscriptions/listen` | 0 证据（仅 list_changed） | **不适用**；CC Channels 才是推送答案 | 原型 <100 行（可）；主干化等 GA |
| ⑤ | annotations / outputSchema | 稳定 / 2020-12 强化 | v1.0.44 展示；tool search 默认开 | **annotations 已完备**；outputSchema 低增益 | 0 / 顺手时做（须 2020-12） |
| ⑥ | streamable HTTP | 双轨并存 | v1.0.27 全支持 | **不适用（保持 stdio）** | 0；翻转条件=多客户端共享需求 |
| ⑦ | top server 范式 | — | — | **无遗漏**；Playwright #1 反证 lasso 结构化抽取路线 | 0；外部效度证明 |

**verdict 汇总**：唯一 GO 候选 = ②elicitation（HighRiskGate 场景，小而明确、带降级、不破红线）；①是防止错误投资的负结论；④的 CC Channels 与 8.2 的迁移窗口建议进决策文档由用户裁决，不在本轮实施。

---

## 10. 来源清单（关键声称 → 出处）

| 声称 | 来源 |
|---|---|
| sampling/Roots/Logging 弃用 + 迁移建议原文 | modelcontextprotocol.io/specification/2026-07-28/changelog（Deprecated §1，SEP-2577） |
| MRTR 取代 server-initiated 请求 | 同上 Major §7（SEP-2322） |
| subscriptions/listen 取代 resources/subscribe | 同上 Major §4（SEP-2575） |
| Tasks extension 化（tasks/get 轮询） | 同上 Major §6（SEP-2663）；roadmap（Agents WG 缺口） |
| stateless core / Mcp-Method / ttlMs / 12 月弃用窗口 | 同上 Major §1-2、Minor §4-5、Governance §1；developersdigest.tech/blog/mcp-2026-07-28-breaking-changes（2026-07-01） |
| 400M 月下载 / 950 connectors / Apps/Tunnels | claude.com/blog/bringing-mcp-2026-07-28-to-claude（2026-07-28） |
| CC elicitation v2.1.76 + hooks；v2.1.117 print 模式修复；0 次 sampling | anthropics/claude-code CHANGELOG.md（zread 全文，至 2.1.216） |
| CC elicitation 零配置/表单+URL 模式/Remote Control 2.1.214 | code.claude.com/docs/en/mcp |
| CC Channels 契约（capability/notification/permission relay/allowlist/flag） | code.claude.com/docs/en/channels-reference |
| CC tool search 默认开启、延迟装载 | code.claude.com/docs/en/mcp（Tool search 节） |
| CC list_changed v2.1.0、resources @-mention v1.0.27、streamable HTTP v1.0.27、annotations 展示 v1.0.44 | anthropics/claude-code CHANGELOG.md |
| clients 特性矩阵（CC sampling ❌） | github.com/modelcontextprotocol/docs clients.mdx（zread） |
| sampling 曾请求支持（用户诉求非承诺） | github.com/anthropics/claude-code issue #1785（2025-06-08） |
| annotations 能/不能、默认悲观、readOnly 用法 | blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations（官方，2026-03-16） |
| SDK v2 stable 同日发布、双时代 handler、draft-07 拒收坑、非强制迁移 | zread modelcontextprotocol/typescript-sdk（5-latest-updates / 11-wire-codec / 6-issues） |
| Playwright #1 + snapshot/ref vs vision opt-in | zread microsoft/playwright-mcp（9/13/14 节）；mcpmanager.ai 榜单（2026-03，Ahrefs） |
| Context7 两步范式 | zread upstash/context7（8/16 节） |
| FastMCP elicitation schema 子集限制 | gofastmcp.com/servers/elicitation |

*（所有 URL 于 2026-08-17 经 web-reader/zread 实读；CHANGELOG 为 5163 行全量解析非抽样。）*
