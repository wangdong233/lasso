# 24-颠覆性调研 · Agent-native 搜索/内容 API 扫描

> 2026-08-17。调研员：agent-api scan。方法论纪律（doc/23 首次执行）：零基视角出发 / 每条声称附成本与延迟（L-COST）/ 禁止「开源项目都这样做」当最优证据。
> 核心问题：**为 agent 设计的新一代 API 提供了什么关键词搜索给不了的东西？**
> 数据时点：2026-08-17 实拉官方页 + 第三方基准；每节标注来源。本文只调研，不改代码。

---

## 0. 零基视角：用户在搜索链路上到底买什么

从零设计「CC 里的搜索」时，用户要的不是「10 条蓝链」，是**一个可用的答案上下文**。拆开是四个诉求，关键词搜索天然只满足第一个：

| # | 用户诉求 | 关键词 SERP API 给的 | 差距 |
|---|---|---|---|
| U1 | 找到相关源 | URL+标题+摘要 | 基本满足（质量有差异） |
| U2 | 拿到源的内容 | 无——需要 agent 自己再 fetch+抽取 | **整个第二跳全部由调用方付费**（延迟+token+失败率） |
| U3 | 内容只要「跟问题相关的那部分」 | 无——整页 markdown 灌进上下文 | token 浪费 5-10×，长页把有效信息稀释 |
| U4 | 内容是结构化的（表/价格/日期/schema） | 无——表格被 markdown 化后线性化 | 下游还要一次 LLM 调用再整形 |

新一代 agent-native API 的全部差异化，就是把这四个诉求中的 U2-U4 搬进 API 内部。**这不是渐进改良，是把「搜索 API」的输出单位从「链接列表」换成「grounding 上下文对象」。** Brave 官方表述即此：「Standard Web Search is centered on URLs… the LLM Context API optimizes for machine use」（来源：brave.com/blog/most-powerful-search-api-for-ai/，2026-02-12 发布、2026-06-25 更新）。

反面证据（防幸存者偏差）：AIMultiple 用 100 条真实 AI/LLM 查询、GPT-5.2 当裁判、bootstrap 置信区间的基准显示，**纯「结果质量」维度上 Brave/Firecrawl/Exa/Parallel Pro 四家统计不可区分**（Agent Score 14.89/14.58/14.39/14.21，CI 大面积重叠），唯一统计显著的是 Brave 领先 Tavily 约 1 分。即：**新 API 的胜负手不在「搜得更准」，在延迟、单跳出内容、token 经济**（来源：aimultiple.com/agentic-search，数据 2025-12 快照，2026-05-25 发表）。

---

## 1. Brave LLM Context API（2026-02-06 上线）

### 机制
`GET/POST https://api.search.brave.com/res/v1/llm/context`，鉴权同现有 web/search（`X-Subscription-Token`）。三步（官方博客）：
1. 在自有独立索引上跑标准搜索选页（count 1-50，默认 20）；
2. **实时**下钻每页内容，把 HTML 转成 smart chunks——不止 markdown：查询优化 snippet、结构化抽取（JSON-LD schema、itemprop、**行级粒度表格**）、代码上下文、论坛帖子线程（Reddit 类）、YouTube 字幕；
3. 用内部训练的相关性系统对 chunks 排序，按用户 token 预算编译成紧凑输出。

响应：`grounding.generic[] = {url, title, snippets[]}` + `sources{url: {title, hostname, age[4 种格式]}}`。**snippets 可含 JSON 序列化的结构化数据（表/schema/代码块）**。参数层：`maximum_number_of_tokens`（1024-32768，默认 8192）/ per-URL token 与 snippet 上限 / `context_threshold_mode`（strict/balanced/lenient/disabled）/ `freshness`（pd/pw/pm/py/日期段）/ Goggles 域名重排 / 本地 POI+map。（来源：api-dashboard.search.brave.com/documentation/services/llm-context，changelog 2026-02-06 上线、2026-07-31 加 safesearch+source metadata）

### L-COST
| 项 | 数值 | 来源 |
|---|---|---|
| 延迟 | 在普通搜索之上 **p90 +<130ms**，总 **p90 <600ms** | Brave 官方博客 2026-02-12 |
| 每千次 | **$5/1k**（Search 计划内 Web/LLM Context/Images/News/Videos 同价） | 同上 |
| 免费额度 | 每月 **$5 免费额度≈1000 次**（需在项目页 attribution） | 同上 |
| 速率限制 | 每 key 1 req/s 滑动窗口（官方 best practices：30s 超时、退避重试） | 官方文档 |
| 规模佐证 | 内部 22M answers/天；Ask Brave(Qwen3+此API) 2026-06 复评 Elo 1169 超 Grok/ChatGPT/Perplexity | 官方博客（自评，采信度打 7 折） |

### 它给了关键词搜索给不了什么
**单次调用同时完成「搜+抽+按查询裁剪」**。对照 Lasso 现状：BraveChannel 拿 10 条 URL → agent 挑 1-3 条 → browse_headless 冷启动抓取+markdown 抽取（11s 级）→ 全文进上下文。LLM Context 用 600ms、8192-token 预算的查询相关 chunks 替代这整条二跳。且 snippets 内嵌行级表格/JSON-LD，U4 部分免费附带。

### 与 Lasso 组合点
- **同 key 同鉴权同 `/res/v1/` 前缀**：`src/config/providers.ts` 里 BRAVE 的 `endpoint_url` 换成/加一个 `llm/context` 变体即可，QuotaLedger 的 N×1000/月额度口径不变（现口径按 $5 赠送=1000 次，与新计划完全吻合）。
- 定位：**增强现有 brave 层**（不是新通道）——给 BraveChannel 加一个「context 模式」，或作为 browse 抽取的前置替代。zhipu 主中文、brave 英文/质量的分工不变。
- 风险：中文覆盖未知（Brave 索引以英文见长）；8192 token 默认输出比 10 条蓝链大得多，**费用不变但下游推理 token 变大**（官方文档自己提醒）。

---

## 2. Exa（神经/语义搜索）

### 机制
自建索引+embedding，**按含义检索**而非关键词匹配。搜索类型分层：`instant`（宣称 sub-150/200ms）/ `fast`（p50 <425ms）/ `auto`（默认，自动路由）/ `deep-lite` / `deep`（多查询扩展+并行搜索，4-12s）/ `deep-reasoning`（12-50s）。内容策略：默认返回 markdown，`highlights` 只取查询相关摘录（官方称 token 降 10×），`maxCharacters` 截断，`maxAgeHours` 控制缓存 vs livecrawl（0=永远现爬 / -1=只用缓存 / 24=超龄才爬）。**`outputSchema` 可在任何搜索类型上返回 typed JSON**，deep 类还带 `output.grounding`（字段级引用+置信度）；`systemPrompt` 控制综合行为；SSE 流式（OpenAI 兼容 chunk 格式）。（来源：exa.ai/docs/reference/search-best-practices、exa.ai/docs/changelog，2026-08 实拉）

### L-COST
| 项 | 数值 | 来源 |
|---|---|---|
| Search（含 10 条内容+highlights） | **$7/1k**，超 10 条每条 +$1/1k | exa.ai/pricing + changelog「定价简化」条目 |
| Contents 单独 | $1/1k 页；AI 摘要 $1/1k | 同上 |
| Deep / Deep-reasoning / Answer | $12 / $15 / $5 每 1k | 同上 |
| Agent | ACU $0.10/单元 + 搜索工具调用 $0.005/次；固定 effort 模式 $0.012（minimal）→ $1.00（x-high）/次 | 同上 |
| 免费额度 | **每月 $10 credit**（≈1400 次 search）+ 5 QPS + 3 agent 并发；MCP 未鉴权试用 3 QPS/150 次/天 | exa.ai/pricing、changelog |
| 延迟（第三方实测） | 均值 **~1.2s**；`instant` 宣称 sub-200ms 但 Parallel 2026-07 五套件实测 **335-361ms p50** | aimultiple 基准 / parallel.ai/compare/exa |
| 质量 | Agent Score 14.39（第 3，与 Brave 统计不可分）；技术文档类查询质量单项最高 | aimultiple |

### 它给了什么关键词给不了的
**U1 的补集**：描述性/概念性查询（「讲 X 概念的教程式页面」「和这家公司相似的竞品」）在关键词引擎上无解，在 embedding 索引上是原生能力。附带 maxAgeHours 这种**检索期新鲜度控制**（关键词 API 只有 freshness 过滤，没有「缓存不够新就自动现爬」语义）。

### 与 Lasso 组合点
- 候选定位：**新语义通道**（fallback 链最末、browse 之前），或森林入口的 `intent=semantic` 显式路由——但这是「加供应商」级决策，违反简单架构红线的话就不做。
- 与 zhipu/brave 的关系是**正交**不是替换：中文关键词主力不因它变化；它服务「关键词搜不到」的长尾。
- 免费层 $10/月（≈1400 次）对一个单用户 CC 工具足够撑日常语义查询。
- 风险：$7/1k 高于 Brave $5/1k；对「事实型」查询（基准里的 Factual/Real-time 类）没有统计优势——它只在「按含义找」这个现有链路完全空白的能力上有独占价值。

---

## 3. Tavily 现状

### 机制与 L-COST
Credit 计价（来源：docs.tavily.com/documentation/api-credits，2026-08 实拉）：
- Search：basic **1 credit**/次，advanced（更深内容处理）**2 credits**/次；
- Extract：每 5 个成功 URL 1 credit（advanced 2）；失败不计费；
- Map：每 10 页 1 credit（带自然语言 `instructions` 2 credits——**用 LLM 按指令筛 URL**，是 agentic 爬取的轻形态）；Crawl = map+extract 之和；
- 免费层 **1000 credits/月**；PAYG $0.008/credit（≈$8/1k basic）；月计划 $0.0075-0.005/credit；
- `auto_parameters` 按查询意图自动配参；topic=news / time_range / include_answer。（来源：docs.tavily.com search 端点文档）

| 项 | 数值 |
|---|---|
| 延迟 | 均值 **998ms**（aimultiple，8 家中第 3 快） |
| 质量 | Agent Score 13.67（第 5；**Brave 对其优势是全场唯一统计显著差距，约 1 分**） |
| 折算 | $8/1k basic search（PAYG），月计划最低 $5/1k |

### 评估（防幸存者偏差的重点案例）
Tavily 是 LangChain/LlamaIndex 生态的默认搜索工具，「agent 搜索=Tavily」是社区惯例。但按本次零基+成本纪律：**同价位 Brave 质量统计显著更高、p90 延迟更低（Exa 官方对比自称 p90 快 27%，且 aimultiple 均值 669ms vs 998ms）、免费层等量（1000 次 vs $5≈1000 次）**。「开源 agent 都接 Tavily」在这里恰恰是 doc/23 点名的幸存者偏差——生态先发不是质量证据。**结论：Lasso 无引入理由**（现有 zhipu+brave 已覆盖其能力面，其独有 Map-with-instructions 被 §5 更强形态覆盖）。

---

## 4. Jina Reader（r.jina.ai）

### 机制
URL 前缀代理：`https://r.jina.ai/<url>` 返回该页 LLM 友好文本。浏览器渲染抽取、原生 PDF、图片 VLM caption（`x-with-generated-alt`）。`s.jina.ai/?q=` 是搜索+结果内容二合一（返回 top5 结果及内容）。结构化抽取：`x-json-schema`（传 JSON Schema）或 `x-instruction`（自然语言指令），配 ReaderLM-v2（1.5B HTML→Markdown/JSON 专用模型，512K 上下文 29 语言，`x-respond-with: readerlm-v2`，**3× token 成本**）。（来源：jina.ai/reader/，2026-08 实拉）

### L-COST（官方速率表原值）
| 端点 | 无 key | 免费 key | 平均延迟 | 计费 |
|---|---|---|---|---|
| r.jina.ai | **20 RPM，零注册** | 500 RPM（每 key 送 1000 万 token） | **7.9s**（官方表；FAQ 另称一般 <2s——两数都来自官方，取保守值） | 输出 token 计费，失败不计 |
| s.jina.ai | 不开放 | 100 RPM | **2.5s** | 每次固定 10000 token 起 |

其它硬边界（官方 FAQ）：**不绕反爬**（被拦即返回被拦）、**不支持登录态**、5 分钟缓存、IP 级限 10000 req/60s。**许可证警示：ReaderLM-v2 模型 CC-BY-NC 4.0（禁商用）**——经 API 用是付费服务没问题，但**自托管该模型进 Lasso 发行包与 MIT 冲突**。新计价模型 2025-05-06 生效。

### 与 Lasso 组合点
- **零配置抽取兜底层**：无 key 20 RPM 免费、无本地浏览器冷启动。对照 Lasso 故障路径（API 全挂→11s 冷启动 headless），`r.jina.ai` 可插在「本地 fetch 失败」与「browse_headless」之间——7.9s 均值未必优于 11s 冷启动多少，但**零资源、零配置、并发不占本机**。这是本次扫描里唯一「免费且零注册」的服务端抽取面。
- 中国网络可达性未验证（用户经代理上网）；隐私面：内容过第三方（与 Brave/Exa 同级，但无 key 时按 IP 追踪）。
- 结构化抽取（x-json-schema）可作 browse 通道的「JSON 输出」可选形态，但 3× token 成本+7.9s 延迟下性价比一般。

---

## 5. Agentic crawling：Crawl4AI / Firecrawl

### 共同范式
传统爬取=全量抓回再过滤；agentic crawling=**用相关性信号在遍历中剪枝**（哪页值得跟、哪段值得留）。「LLM 过滤内容」在这里有两个不同层次，都属 U3：
- **零 LLM 层（查询相关裁剪）**：Crawl4AI `BM25ContentFilter`（按查询词对页面段落打分留核心）与 `PruningContentFilter`（link-density 启发式去噪）→ `fit_markdown`。（来源：docs.crawl4ai.com/core/fit-markdown/）
- **LLM 层（语义抽取）**：Crawl4AI `LLMExtractionStrategy` 经 LiteLLM 接任意模型（含本地 Ollama），Pydantic schema 约束输出，自动分块+overlap，`show_usage()` 显式 token 成本；官方自己警告「LLM 抽取比 schema-based 慢且贵，结构稳定时优先 JsonCssExtractionStrategy」。（来源：docs.crawl4ai.com/extraction/llm-strategies/，2026-08 实拉）

### Firecrawl L-COST（来源：firecrawl.dev/pricing + docs.firecrawl.dev/features/search，2026-08 实拉）
| 项 | 数值 |
|---|---|
| 免费层 | 1000 credits/月，2 并发 |
| Search | **2 credits/10 结果**（≈$0.03/查询 @Hobby 档），默认带查询相关 **highlights**，`scrapeOptions` 一次调用连内容 |
| Scrape/Crawl/Map | 1 credit/页；JSON mode +4/页；enhanced proxy +4/页 |
| 类目 | github / research(学术站) / pdf / developer(Dveloper Index：issues+PR+README) |
| Agent（Preview） | 每天 5 次免费，动态计价 |
| 延迟/质量 | 1335ms 均值；Agent Score 14.58（**第 2，与 Brave 统计不可分**，「深内容任务最强」） |

### 评估
- Firecrawl 的 `/search`+`scrapeOptions` 与 Brave LLM Context 是同**形态**竞争（单跳出内容），但走 scraping 路线：覆盖面更广（任意站、GitHub/学术/开发者专用索引），代价是延迟 2×（1335 vs 669ms）+ 无自有通用索引。
- Crawl4AI 是**自托管库**非 API——对 Lasso 的意义不是接入而是**模式参考**：BM25 查询裁剪可以在 Lasso 现有 browse/markdown 抽取层内零成本复刻（U3 不需要新供应商）。这符合简单架构红线：能力内化优于通道扩张。

---

## 6. 结构化输出（typed schema 而非链接列表）实践盘点

| 厂商 | 形态 | 边界/成本 | 来源 |
|---|---|---|---|
| Exa | `outputSchema` 于任意搜索类型；deep 类附 `output.grounding`（字段级引用+置信度） | schema 嵌套 ≤2、属性 ≤10；官方忠告：别把 citations 塞进 schema（冗余且比内置 grounding 更不可靠） | exa.ai/docs search-best-practices |
| Jina | `x-json-schema` / `x-instruction` + ReaderLM-v2 | 3× token；CC-BY-NC 模型 | jina.ai/reader |
| Firecrawl | /scrape JSON mode（用户 schema） | +4 credits/页 | docs.firecrawl.dev |
| Crawl4AI | JsonCssExtractionStrategy（零 LLM，schema 可 `generate_schema()` 从页面反推）vs LLMExtractionStrategy | 官方建议：结构稳定先用 CSS 版 | docs.crawl4ai.com |
| Brave LLM Context | 非用户 schema——snippets 内嵌 JSON-LD/行级表格（站点侧结构化数据） | 免费附带，无定制 | 官方文档 |
| Tavily | 无 schema 参数（advanced search 含内容整形） | — | docs.tavily.com |

**实践共识**：typed 输出的价值=**砍掉一整轮 agent 后处理调用**（拿 JSON 直接进工具链，不用再花一次 LLM 调用从 markdown 整形）。共性教训：能确定结构时永远先 CSS/确定性抽取，LLM 抽取是语义兜底；字段级 grounding 比「让模型自己标引用」可靠。

---

## 7. 总 L-COST 对照表（单次「搜索并拿到可用内容」全成本）

| 方案 | 延迟（均值/p90） | $/1k | 免费月额 | 跳数 | 输出 |
|---|---|---|---|---|---|
| Lasso 现链（serp_http→API→browse_headless 抽取） | 探测 ~1s；API 命中即返；**兜底 11s 冷启动+Chromium** | 0-$5 | — | 2 | 链接→自抽 markdown |
| **Brave LLM Context** | **669ms 均值（web search）；context 版 p90 <600ms** | **$5** | **$5≈1000 次** | **1** | 查询相关 chunks（含表格/JSON-LD） |
| Exa search+contents | ~1.2s；instant 实测 335ms p50 | $7 | $10≈1400 次 | 1 | markdown/highlights/schema |
| Tavily advanced | 998ms | ~$16（2 credits×$8） | 1000 credits | 1 | 内容+可选答案 |
| Firecrawl search+scrape | 1335ms | ~$19（2+10×1 credits @Hobby $16/5k） | 1000 credits | 1 | 全文+highlights |
| Jina s.jina.ai（搜索形态） | 2.5s | token 计（1 万 token/次起） | 免费 key 100 RPM+1000 万 token | 1 | top5+内容 |
| Jina r.jina.ai（抽取形态） | **7.9s 均值（官方）** | 0（无 key 20 RPM） | 20 RPM 无注册 | — | markdown/JSON |

（ Brave 669ms 为 aimultiple 测其 web search 端点；LLM Context 官方 p90<600ms 为自报。）

---

## 8. 裁决建议（交主循环决策，本轮未动代码）

**R1（小而明确的 GO 候选）**：BraveChannel 增加 LLM Context 模式。
理由：同 key/同鉴权/同 `/res/v1/` 前缀/同 QuotaLedger 口径，改动集中在一个 channel 内；把英文「搜+抽」从两跳 11s 级压到一跳 <1s；$5/1k 与现有支出模型零冲突。属「增强现有层」，不新增供应商，不破简单架构红线。实施前需真机验证两点：中文查询质量、8192-token 输出对 CC 上下文的实际占用。

**R2（NO-GO）**：接入 Tavily。生态默认不构成证据；同价位被 Brave 统计显著压制，无独占能力。

**R3（决策文档级，非本轮）**：Exa 语义通道。唯一价值=「按含义找」这一现有链路完全空白的能力（+findSimilar 类场景）。若做，定位为森林入口显式 intent 路由而非 fallback 层；$10/月免费层足够单用户验证。是否值得为长尾能力加一个供应商，是红线上限问题，交用户裁决。

**R4（内化优于接入）**：BM25/查询相关裁剪（Crawl4AI 模式）可在 Lasso 抽取层内自实现，U3 能力零成本获得——优先于任何新 API 接入。

**R5（观察名单）**：Jina r.jina.ai 无 key 20 RPM 免费抽取兜底（插在 fetch 失败与 headless 之间）；中国网络可达性未验证，且 7.9s 官方均值对 11s 冷启动优势有限，暂不动。

## 9. 来源清单

- Brave LLM Context 官方文档：https://api-dashboard.search.brave.com/documentation/services/llm-context （changelog：2026-02-06 上线 / 2026-07-31 参数更新）
- Brave 发布博客：https://brave.com/blog/most-powerful-search-api-for-ai/ （2026-02-12，2026-06-25 更新；定价/延迟/评测全量）
- Exa 定价：https://exa.ai/pricing ；最佳实践：https://exa.ai/docs/reference/search-best-practices ；changelog：https://exa.ai/docs/changelog （均 2026-08-17 实拉）
- Tavily credits：https://docs.tavily.com/documentation/api-credits （2026-08-17 实拉）
- Jina Reader 速率/FAQ：https://jina.ai/reader/ （2026-08-17 实拉）
- Firecrawl 定价：https://www.firecrawl.dev/pricing ；Search 文档：https://docs.firecrawl.dev/features/search （2026-08-17 实拉）
- Crawl4AI LLM 策略：https://docs.crawl4ai.com/extraction/llm-strategies/ ；fit-markdown：https://docs.crawl4ai.com/core/fit-markdown/
- AIMultiple 8-API 基准：https://aimultiple.com/agentic-search （2025-12 数据，2026-05-25 发表；含统计方法与局限声明）
- Parallel 对 Exa instant 的实测：https://parallel.ai/compare/exa （2026-07）
