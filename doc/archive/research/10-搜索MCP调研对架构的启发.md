# 搜索 MCP 调研对 08/09 的启发与优化建议（10）

## 1. 调研全貌速览（8 份文件讲了什么 + 核心结论）

8 份文件覆盖了搜索 MCP 候选的全维度评估：

- **README.md / 01-总览与推荐排名**：七大候选画像（One Search MCP 9.0 / mcp-web-search 8.5 / Jina AI 8.0 领先），按"本机友好×1.5 + 免费×1.2"加权；Brave vs Tavily 硬数据对比（669ms·2000次 vs 998ms·1000次）
- **02-候选方案详解**：6 候选深入对比，揭示 DDG TLS 静默空 202 陷阱、Jina 19 工具暴露的能力盲区、One Search 唯一原生中文免费方案
- **03-配置示例与部署指南**：每个候选的 env/transport/Key 实战，区分 stdio vs http 两种 transport、Jina 鉴权分层（匿名 20 RPM vs keyed）
- **04-性能基准与免费额度对比**：AIMultiple 2026-05 基准硬数据（Brave 669ms/14.89、Tavily 998ms/13.67、Perplexity 11s+），明确 Tavily 收购风险
- **05-避坑-被否决的误导结论**：0-3 票否决三条因果延伸（"Brave 全场最优"、"mcp-searxng 免费"、"Brave/Exa 全需付费 Key"），提炼两条通用防坑原则
- **06-局限与开放问题**：免费方案无公开基准、中文召回未实测、SearXNG AGPL、Jina 非商业限制、本机 8GB 内存约束
- **07-调研方法与完整来源清单**：方法论透明（100 query + bootstrap CI + GPT 评判），揭示 isFallbackWorthy 对 HTTP 202 空响应的盲区

**高置信度共识**：
1. Tavily 2026-02 被 Nebius 4 亿美元收购，免费层存续风险必须写入边界
2. DDG 系列 TLS 指纹封锁返回静默空 202，必须装 [browser] extra
3. Jina 10M 免费 token 限非商业；SearXNG AGPL-3.0 传染性
4. Perplexity 11s 延迟排除出交互路径
5. mcp-searxng 是 broker 不是引擎，需自建 SearXNG 实例（类比 paddleocr-mcp --http 是 MCP 非 REST 陷阱）

**存在分歧需裁决**：
1. **v0.2 第二搜索源主力**：README/01/02/04 选 Brave（4 份），03 选 Jina+One Search，05 主张 A/B 实测后定，06 选 mcp-web-search DDG，07 选 Tavily（基于 Brave 最优被否决）
2. **fetch_extract 通道 F 编号**：6 份文件一致认为需要，但提案为 F3.2 / F3.5 / F3.7 / F3.1.12 四种
3. **provider 矩阵规模**：扩为"3 源"还是"3 层能力袋"

---

## 2. 对 08 功能架构的调整建议

### 2.1 F3.1.x search 工具：engine 选型约束收紧（high）
- **调整点**：工具描述加硬性约束——"engine 选择必须基于本仓库 100-query 实测，不得直接引用外部基准（如 AIMultiple）"
- **理由**：05 文件 0-3 票否决"Brave 全场最优推荐"因果延伸；外部基准只能采信数字不能采信"最优"归因
- **涉及**：F3.1.x 工具描述
- **依据**：05 避坑文件、07 方法论文件

### 2.2 F3.1.6 多源扇出：provider 矩阵分层架构（high）
- **调整点**：从"二源扇出"扩为"三层能力袋"
  - 中文主力层：智谱 web-search-prime（保持现状）
  - 英文/质量层：Brave（额度内作质量优先层）
  - 轻量兜底层：Exa 远程 URL 免 Key / DDG（mcp-web-search 三源 fallback）
  - 最终兜底：browse_headless 实搜
- **理由**：04 文件指出 Brave/Tavily/Exa 都不适合做无限量主力，应作"质量层"叠加在无上限源之上；Brave 额度宝贵（2000/月）不应被低价值请求耗光
- **涉及**：F3.1.6 / F3.1.7
- **依据**：04 性能基准、README

### 2.3 F3.1.7 limit 跨源分配：额度比例 + 语言启发式（medium）
- **调整点**：从"均分"改为"按 free_quota_per_month 比例 + 中文 query 多分智谱 / 英文 query 多分 Brave"
- **理由**：05 指出 Brave 2000/月 + Exa 1000/月 + 智谱额度不明，按额度比例分避免某源先被打爆
- **涉及**：F3.1.7
- **依据**：05、04

### 2.4 F3.1.9 caller-tier cap：改为 per-provider 独立配置（high，前置到 v0.3）
- **调整点**：从"全局 cap"改为"per-provider 独立 cap"
- **理由**：Jina 20 RPM / Exa 1000/月 / Tavily 1000 credits / Brave 2000/月 差异巨大，全局 cap 会要么浪费要么爆限流
- **涉及**：F3.1.9（版本从 v0.6 前置到 v0.3）
- **依据**：07、06

### 2.5 F3.1.10 free_only：四级分级路由（high）
- **调整点**：明确四级语义
  - L1 完全免费零 Key：One Search local / mcp-web-search / DDG MCP / SearXNG（自建）
  - L2 免费层需 Key：Brave 2000/月 / Tavily 1000 credits / Jina search_web 1000万 token
  - L3 远程 URL 免 Key：Exa ~1000/月 / Jina read_url 20 RPM
  - L4 付费：Perplexity / Serper / Google CSE / Bing
- **理由**：05 文件否决"免费/付费二元错位"——免 Key ≠ 零成本（SearXNG 要自建），需 Key ≠ 付费（Brave/Exa 有免费层）
- **涉及**：F3.1.10
- **依据**：05、01、README

### 2.6 F3.4 fallback 链：多触发器 + 差异化超时（high）
- **调整点**：
  - isFallbackWorthy 触发集扩容：除 5xx/超时/限流外，新增「HTTP 202 空响应」「响应体 <N 字节」「结果数=0 但 HTTP 200」「429 + retry-after 头」「provider 政策性下线」
  - 60s/60min 双熔断按错误类型区分：429 用长熔断（等月配额重置语义）、超时用短熔断、政策性故障走独立 manual-switch gate
  - **差异化超时**：按 provider 配 timeout（快源 Brave 类 5s、慢源 30s、智谱维持现值），替换"一个 60s 单熔断打天下"
  - QualityGate 增加「结果空值/低质量检测」分支
- **理由**：07 揭示 DDG 静默空 202 是隐藏 bug；04 数据 Brave 669ms vs Perplexity 11s+ 跨度 20 倍证明单一熔断不合理；Tavily 收购属政策性故障非技术故障
- **涉及**：F3.4 / F3.4.6（新增）
- **依据**：07、04、README

### 2.7 F3.4 新增：传输层 fallback（medium）
- **调整点**：借鉴 DDG_SEARCH_BACKEND=auto（httpx→curl_cffi 模拟 Chrome 131 TLS），增加"传输层 fallback"层级，放在 provider fallback 之下
- **理由**：02 指出 DDG 默认 httpx 会被 TLS 指纹封→静默空 202，必须装 [browser] extra；传输层 fallback 是 provider 切换前的廉价降级
- **涉及**：F3.4 子项
- **依据**：02、03

### 2.8 F3.6 配置：升级为 provider_type 三态 schema（high，前置到 v0.2）
- **调整点**：
  - provider schema 扩展为三态：`provider_type: "api_key" | "broker" | "self_hosted"`
  - 配置从"API Key 二元"扩为三元组：`endpoint_url + optional_key + optional_local_instance`
  - 新增字段：`free_tier_type`（零Key/需Key/免Key远程）、`free_quota_per_month`、`policy_risk`（acquired/watched/safe）、`licence`（MIT/AGPL/non-commercial）、`commercial_safe`
  - Key 轮换从 round-robin 改为按 provider 配额模型适配（Brave/Tavily 月配额、Jina RPM、智谱 token、Exa 月请求数）
- **理由**：05 揭示 mcp-searxng 是 broker（需 SEARXNG_URL）；04 指出 Jina 匿名/keyed 双 tier 同一 provider 下分级；各家配额模型差异大不可一刀切
- **涉及**：F3.6 / F3.6.1（新增） / F3.6.2（新增）
- **依据**：05、04、03、07

### 2.9 F3.6 代理统一注入：适用范围明确（low）
- **调整点**：代理统一注入只对 hosted-API 层（Brave/Tavily/Exa/Jina/智谱）生效，本地 browser 类（One Search local / browse_headless）跳过代理
- **理由**：README 指出 One Search local 起本机浏览器进程不走代理；不区分会导致本地浏览器流量被错误代理
- **涉及**：F3.6 子项
- **依据**：README

### 2.10 08 边界：新增 10 条硬约束（详见第 5 节）

---

## 3. 对 09 排期的调整建议

### 3.1 v0.2 第二搜索源选型与顺序（详见第 4 节）
- 首选 Brave，备选 Tavily，强制 in-house A/B 实测后锁定主力
- 排期顺序：**Brave（v0.2 结构化层）→ Exa 远程免 Key（v0.2 末/v0.3 初轻量兜底）→ One Search local（v0.3 中文补位）→ Tavily（v0.3+ watch-list）**
- 依据：README、01、02、04（Brave 共识） + 05、07（A/B 实测必要）

### 3.2 v0.2 验收标准补充（5 条硬指标）
1. **本地延迟实测**：5-10 真实中英文 query A/B（智谱 vs Brave），跑 p50/p95，输出 provider 矩阵打分表（不能照搬 AIMMultiple 付费 API 数字）
2. **配额追踪**：Brave key 余量 <50 时自动降级；多 Key 轮询下配额合并验证（2 个 Key = 4000/月）
3. **HTTP 202 空响应识别**：构造 DDG [browser] 未装场景，验证 fallback 链识别静默空并降级
4. **限速压测**：连续 50 query，验证 fallback 链对 429 / retry-after 的反应
5. **政策风险检查**：Tavily 收购后免费层是否还在、Exa 稳定性是否回升，每个 minor 版本发版前跑清单核对
- 依据：04、05、06、07

### 3.3 排期前置项（从后续版本提前到 v0.2）
- **F3.6 多 Key 等级分层 + provider_type schema**：从 v0.6 前置到 v0.2（否则 Brave 单 Key 2000/月会在 v0.2 当天用爆；多源必然要求 engine+keys 分离配置）
- **F3.4 isFallbackWorthy 扩展**（202 空响应 + 429）：v0.2 必修（不修等于 fallback 链有洞）
- **F3.6.1 per-provider 多 Key 池 + 配额账本**：随 v0.2 Brave 一并落地
- 依据：README、01、04、07

### 3.4 排期后置项（从 v0.2 推迟）
- **Tavily**：延后到 watch-list，v0.3+ 评估（等 Nebius 收购后政策明朗，稳定 6 个月后再考虑）
- **mcp-searxng**：v0.2 明确 NO-GO（broker 需自建 SearXNG 实例，运维成本与轻量定位冲突）
- 依据：README、05、01

### 3.5 v0.3 新增项
- **F3.2 fetch_extract 通道**（Jina read_url 20 RPM）：search 通道稳定之后的下游消费；read_url 对比 browse_headless 的纯文本召回率与延迟
- **F3.3 rerank 跨源重排**（可选，Jina Reranker）：F3.1.6 多源扇出后的质量保证层；受 Jina 非商业条款约束
- **F3.1.9 caller-tier cap 完整实现**（v0.3 而非 v0.6）：因 Jina/Exa/Tavily 都有硬 RPM/credits 限制；v0.2 可用免费层天然额度上限做 MVP（Brave 2000/月直接作为某 tier 天然 cap）
- 依据：02、07、README

### 3.6 v0.6 热更新（F3.6）剩余项
- per-provider config schema 适配器（ProviderConfigAdapter）
- 代理统一注入的 transport 区分（远程 HTTP server 端切换 / 本地 stdio 需重启）
- 依据：03、01

### 3.7 v0.9 Wayback 死链恢复：保持现状不动
- 调研未覆盖（不在范围）
- 但 v0.2 选定 Brave 后，F3.2 fetch_url 与 Wayback 协同价值显著提升（先恢复 URL → 再抽全文）
- 依据：README

### 3.8 v0.2 暂缓项
- Serper / Google CSE / Parallel Search Pro / Firecrawl / Bing（Azure Key）：全部付费 Key，v0.3+ 再评估
- 依据：06

---

## 4. v0.2 第二搜索源的明确推荐

**裁决**：首选 **Brave Search MCP**，备选 **Tavily**（条件性接入），强制 in-house A/B 实测后锁定。

### 4.1 对比表

| 维度 | Brave（首选） | Tavily（备选） | Exa | One Search local | mcp-web-search DDG |
|---|---|---|---|---|---|
| 延迟 | 669ms（最快） | 998ms | 不稳定 | 起浏览器进程 | 默认 httpx 静默空 |
| 月免费额度 | 2000 次 | 1000 credits | ~1000 req | 无限（隐式限速） | 无限（隐式限速） |
| Agent Score | 14.89（最高） | 13.67 | N/A | N/A | N/A |
| 中文支持 | 弱 | 弱 | 弱 | 百度/搜狗 强 | 弱 |
| 结构化 JSON | 是 | 是 | 是 | 半结构化 | 是 |
| 收购/政策风险 | 无 | Nebius 2026-02 收购 | 高频 429 | 无 | 无 |
| 商用许可 | 安全 | 待观察 | 安全 | MIT | MIT |
| 是否需 Key | 需免费 Key | 需 Key | 远程免 Key | 无 Key | 无 Key |
| 原生 fallback | 无 | 无 | 无 | 无 | 三源自动 fallback |

### 4.2 推荐理由（可交叉验证的事实）
- **配额最大**：Brave 2000/月 = Tavily 2 倍
- **延迟最低**：669ms = Tavily 1.5 倍快
- **无收购风险**：所有权稳定；Tavily 已被 Nebius 4 亿美元收购（2026-02），免费层存续无保障
- **结构化 JSON API**：纯 API 不依赖浏览器进程，对 8GB 无 Docker 环境友好

### 4.3 重要警示
- **不引用"Brave 最优"作为架构理由**：05 文件 0-3 票否决了"Brave 全场最优推荐"的因果延伸，外部基准（AIMultiple）只覆盖 8 API × 100 query × 单一评判模型（GPT），支撑不起"最优"归因。08/09 引用 Brave 时**只能引用「延迟 669ms + Agent Score 14.89 + 2000/月」三项数字**，不能写"Brave 最优"
- **v0.2 落地前必须跑自家 in-house 100-query A/B 基准**：用 04 文件第四节方法论（冷启动 vs 热查询、中文 vs 英文、单条 vs 并发各跑一组），不能直接套用调研的付费 API 数字
- **Exa 不该进候选**：远程 URL 免 Key 但高频触发 429，直接违反 F3.4 的 isFallbackWorthy，会拖垮整条 fallback 链
- **One Search local 不作"第二 API 源"**：与 browse_headless 同族（都是浏览器型），选它等于多挂一个浏览器进程，不解决"智谱是唯一结构化 API 源"的债；第二 API 源必须是 hosted 结构化 API（Brave/Tavily/Exa 这类），不能是浏览器型

### 4.4 备选 Tavily 的接入条件
- 配 credits 监控告警（1000/月硬限）
- 配 policy_risk 字段（acquired）
- 接入仅作冗余而非主力；主力锁定 Brave 后 Tavily 可作 quality_gate 触发的第二选择
- 等 Nebius 收购后政策明朗 + 稳定 6 个月后再考虑纳入

### 4.5 分歧记录（诚实陈述）
- **06 文件**主张 mcp-web-search（DDG）作主力（基于"原生三源 fallback + MIT + 免费无 Key"）
- **07 文件**主张 Tavily（基于"Brave 最优被否决，Tavily 数据齐全"）
- **03 文件**主张 Jina+One Search 组合
- **本文档裁决 Brave**，理由：Brave 在数据维度（延迟/额度/质量）全部领先且无收购风险；05/07 的否决针对的是"最优归因"而非"数据本身"；mcp-web-search 的 DDG 静默空 202 是隐藏 bug 不适合做主力，更适合做兜底层

---

## 5. 必须写进 08 边界的避坑

### 5.1 政策/收购风险
1. **Tavily 被 Nebius 4 亿美元收购（2026-02）**：免费层 1000 credits/月存续无保障，不得做唯一/主力源；接入需配 credits 监控告警 + policy_risk 字段
   - 依据：04、06、README

### 5.2 商业许可雷区
2. **Jina 10M 免费 token 限非商业用途**：若 Lasso 商用，Jina search_web 兜底必须切付费计划；read_url 20 RPM 匿名访问不在此限
3. **SearXNG 本体 AGPL-3.0**（MCP 代码 MIT）：不得 vendor 进闭源产品，只能调远端实例；若开源则注意传染性
   - 依据：06、README、02

### 5.3 隐藏 bug / 静默失败
4. **DDG TLS 指纹封锁返回静默空 HTTP 202**：默认 httpx 客户端会被 html.duckduckgo.com 封，必须装 [browser] extra（curl_cffi 模拟 Chrome 131 TLS）；F3.4 isFallbackWorthy 必须检测「HTTP 200 但结果数=0」
5. **mcp-searxng 是 broker 不是引擎**：SEARXNG_URL 是唯一必需变量，必须指向已存在的 SearXNG 实例（类比 paddleocr-mcp --http 是 MCP 协议非 REST 的陷阱）；未自建/借用实例前不纳入 provider 矩阵
   - 依据：02、03、05、07

### 5.4 性能/资源约束
6. **Perplexity 类 11s+ 延迟源永不进入交互式 search 通道候选**：会拖垮 F3.4 的 60s 短熔断预算
7. **One Search local 模式会起浏览器进程**：8GB / 94% 内存机器加剧 503，DDG 直连更轻；503 时自动切 duckduckgo 模式（阈值勿调高）
8. **SearXNG 需 Docker**：本机 8GB 无 Docker 场景落地成本高
   - 依据：06、02、README

### 5.5 配置陷阱
9. **Jina s.jina.ai 拒绝匿名访问**：Jina search_web / Exa / Tavily / Serper / Google CSE / Bing 一律强制配 Key，无 Key 不进入 provider 矩阵
10. **Exa 高频触发 429**：~1000 req/月免费额度，做不了主力，只能做低频兜底
    - 依据：06、03、04

### 5.6 两条通用防坑原则（写进 08 边界章节顶部）
- **(a) "最优推荐"需多源交叉验证**：单一基准（哪怕方法论透明）只能支撑延迟/分数，支撑不了"最优"
- **(b) "免费"要追问前置条件**（四问）：是否要自建？是否要 Key？Key 是否免费？额度多少？四问全答才算看清
- 依据：05

---

## 6. 新增 F 编号清单

### 6.1 必须新增（共识度高，6 份文件一致）

**F3.2 fetch_extract 通道（独立于 search）**
- **能力**：给定 URL → 结构化全文/截图/PDF 抽取（轻量级，参数化 charset/range/section）
- **为什么**：调研揭示 Jina read_url / DDG fetch_content（8000 字符）/ mcp-searxng web_url_read（5MiB + 分页）三个独立源都覆盖 search→fetch 能力，是搜索的高频下一步；08 现状把 fetch 隐含在 browse_headless 里太重且无段落级控制
- **优先级**：v0.3
- **依据**：README（F3.5）/ 01（F3.2.x）/ 02（F3.2）/ 03（F3.7）/ 04（F3.5）/ 07（F3.1.12）—— 6 份一致提案，F 编号统一为 F3.2

### 6.2 建议新增（多份文件提案）

**F3.6.1 per-provider 多 Key 池 + 配额账本**
- **能力**：每个 provider 独立 Key 池 + 各自配额追踪（quota state + 适配器：Brave 月度 / Jina 滑窗 RPM / 智谱 token / Exa 月请求数）
- **为什么**：调研 04 明确指出 Brave 2000/月 + Tavily 1000 credits/月超限后"需付费或多 Key 轮询"——这是免费层扩容唯一路径；F3.6 现状只说"多 key 轮换"未细化
- **优先级**：v0.2（随 Brave 一并落地）
- **依据**：README（F3.6.1）/ 01（F3.6.x）/ 04（F3.6.x）

**F3.6.2 provider_type 三态 schema（api_key | broker | self_hosted）**
- **能力**：配置层 provider 类型抽象 + endpoint_url/optional_key/optional_local_instance 三元组
- **为什么**：05 揭示 mcp-searxng 是 broker、Brave/Exa 是 api_key 型、未来 SearXNG 自建是 self_hosted 型；不抽象类型会导致配置/降级/配额逻辑分支爆炸
- **优先级**：v0.2 首个 PR
- **依据**：05（F3.6.x）/ 07

**F3.4.6 provider 政策风险 gate（收购/条款变更自动降级）**
- **能力**：manual-switch + health-check 组合，policy_risk 字段标注；定期心跳检测 provider API 可达性 + 免费层额度公告变更
- **为什么**：Tavily 被 Nebius 收购属"政策性故障"非技术故障，60s/60min 熔断都不适用；F3.4 现有触发器只识别技术信号
- **优先级**：v0.6+（v0.2 起码在配置层预留 policy_risk 字段）
- **依据**：README（F3.4.6）/ 04（F3.4.x）

**F3.3 rerank（跨源去重 + 重排序，合并提案）**
- **能力**：多源扇出后按 URL 规范化去重 + 相关性/权威性/新鲜度重排序（可选 rerank，按 caller-tier 或 quality_gate 触发）
- **为什么**：F3.1.6 多源扇出只是把多源结果合在一起，无质量保证层；Jina Reranker 是调研里独有的质量增强能力
- **优先级**：v0.3（跟在 F3.1.6 多源扇出之后）
- **依据**：01（F3.1.12）/ 02（F3.3）/ 07（F3.1.13）—— 三份提案合并为 F3.3

**F3.1.12 provider RPM/credits 滑动窗口限频**
- **能力**：per-provider 滑动窗口（Jina 20 RPM / Exa 1000/月 / Tavily 1000 credits），命中阈值时主动降级而非等 429
- **为什么**：F3.1.9 是 caller-tier cap（调用方维度），管不到 provider 侧硬限；需要在 search 工具层加 provider 维度限频
- **优先级**：v0.3（与 F3.1.9 同期落地）
- **依据**：06（F3.1.12）/ 04

### 6.3 可选新增（低优先级）

**F3.7 搜索通道健康检查 + 本地性能基准工具**
- **能力**：定期跑 100 条中英文 query 基准，输出每 provider p50/p95 延迟 + Agent Score + 配额消耗
- **为什么**：免费方案无公开基准，AIMultiple 是单一来源且两条因果结论已被否决；provider 矩阵和 fallback 优先级不能拍脑袋
- **优先级**：v0.3（provider 矩阵上线的前置门）
- **依据**：06（F3.7）/ 05（F3.x）

**F3.1.13 provider ToS/许可证边界标记**
- **能力**：每个 provider 配置带 `commercial_safe` / `licence` / `acquisition_watch` 三字段，provider 矩阵初始化时校验，商用模式自动禁用不合规源
- **为什么**：Jina 限非商业 / SearXNG AGPL / Tavily 收购风险需要结构化标记而非散落在边界文档
- **优先级**：v0.6（与 F3.6 热更新同期）
- **依据**：01（F3.1.13）

---

## 7. 是否需要立即更新 08/09 文档

**Verdict**：**是，需要立即更新 08/09**。调研揭示了 08 的能力盲区（fetch_extract 通道缺失）、fallback 链的隐藏 bug（HTTP 202 空响应绕过 isFallbackWorthy）、配置模块的抽象不足（provider_type 三态缺失），以及 v0.2 第二搜索源选型的明确收敛。但更新是**局部修改**而非重写。

### 7.1 08 文档需要改的 5 处

1. **F3.1.x 工具描述**：加硬性约束"engine 选择必须基于本仓库 100-query 实测，不得直接引用外部基准"
2. **F3.1.10 free_only**：升级为四级分级路由（L1/L2/L3/L4）
3. **F3.4 fallback 链**：isFallbackWorthy 触发集扩容（202 空响应 + 429 + retry-after + 结果数=0 + 政策性故障）；差异化超时；新增 F3.4.6 政策风险 gate
4. **F3.6 配置**：新增 F3.6.1（per-provider 多 Key 池）+ F3.6.2（provider_type 三态 schema）；代理统一注入明确"hosted-API 层生效 / 本地 browser 类跳过"
5. **边界章节**：新增第 5 节列出的 10 条硬约束 + 2 条通用防坑原则

### 7.2 08 文档需要新增的 F 编号
- F3.2 fetch_extract 通道（v0.3）
- F3.3 rerank（v0.3，合并原 F3.1.12 + F3.1.13 + F3.3 提案）
- F3.4.6 provider 政策风险 gate（v0.6+）
- F3.6.1 per-provider 多 Key 池（v0.2 前置）
- F3.6.2 provider_type 三态 schema（v0.2 首个 PR 前置）
- F3.1.12 provider RPM/credits 滑动窗口限频（v0.3）
- F3.7 健康检查 + 本地基准工具（v0.3 可选）
- F3.1.13 provider ToS 边界标记（v0.6 可选）

### 7.3 09 文档需要改的 6 处

1. **v0.2 第二搜索源选型**：从"Brave 或 Tavily 二选一"收敛为"**首选 Brave，备选 Tavily，强制 in-house A/B 实测后锁定**"（理由见第 4 节）
2. **v0.2 排期顺序**：Brave（v0.2 结构化层）→ Exa 远程免 Key（v0.2 末/v0.3 初轻量兜底）→ One Search local（v0.3 中文补位）→ Tavily（v0.3+ watch-list）
3. **v0.2 验收标准**：新增 5 条硬指标（本地延迟实测 / 配额追踪 / HTTP 202 识别 / 限速压测 / 政策风险检查）
4. **前置项**：F3.6.1 多 Key 池 + F3.6.2 provider_type schema + F3.4 isFallbackWorthy 扩展，全部从 v0.6 前置到 v0.2
5. **后置项**：Tavily 延后到 watch-list；mcp-searxng v0.2 NO-GO；Serper/Google CSE/Parallel Pro/Firecrawl/Bing v0.3+ 评估
6. **v0.3 新增项**：F3.2 fetch_extract、F3.3 rerank、F3.1.9 完整实现（从 v0.6 前置到 v0.3）、F3.1.12 RPM 滑动窗口限频

### 7.4 调研印证了现状的部分（无需调整）
- **F3.1.11 Wayback 死链恢复（v0.9）**：调研未覆盖，保持现状
- **不解 2FA 边界**：调研未触及
- **SERP selector 是债（主走结构化 API）**：调研强烈印证——所有推荐方案（Brave/Tavily/Exa）都是结构化 JSON API，浏览器型（One Search local/browse_headless）明确降级为兜底
- **智谱 web-search-prime 作中文主力**：调研印证，唯一明确支持中文的免费方案是 One Search local（百度/搜狗），但需浏览器进程不适合做 API 主力

---

**相关源文件路径**（用于追溯每条建议的依据）：
- `/Users/wangdong/Documents/Project/cc-control-all/doc/搜索mcp工具/README.md`
- `/Users/wangdong/Documents/Project/cc-control-all/doc/搜索mcp工具/01-总览与推荐排名.md`
- `/Users/wangdong/Documents/Project/cc-control-all/doc/搜索mcp工具/02-候选方案详解.md`
- `/Users/wangdong/Documents/Project/cc-control-all/doc/搜索mcp工具/03-配置示例与部署指南.md`
- `/Users/wangdong/Documents/Project/cc-control-all/doc/搜索mcp工具/04-性能基准与免费额度对比.md`
- `/Users/wangdong/Documents/Project/cc-control-all/doc/搜索mcp工具/05-避坑-被否决的误导结论.md`
- `/Users/wangdong/Documents/Project/cc-control-all/doc/搜索mcp工具/06-局限与开放问题.md`
- `/Users/wangdong/Documents/Project/cc-control-all/doc/搜索mcp工具/07-调研方法与完整来源清单.md`