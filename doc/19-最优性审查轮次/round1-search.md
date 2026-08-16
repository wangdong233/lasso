# Round 1 调研：搜索与内容抽取域（search 链路 + MarkdownExtractor）

日期：2026-08-15 ｜ 调研员：Round-1「搜索与内容抽取」｜ Lasso 基线：v1.10.0（1801 tests + 78 INV）

调研方法：先白盒读 Lasso 本域全部源码（下表「Lasso 锚点」列均经过实读，非推测），再用 zread 白盒读对标项目源码（firecrawl / open-webSearch / crawl4ai），配合 web 搜索确认热度与版本动向。

---

## 1. 本域最新最热项目清单

| 项目 | 热度数据（2026-08） | 一句话机制 | 与 Lasso 对应能力的关系 |
|---|---|---|---|
| **microsoft/markitdown** | ~172.8k★（star-history 全球 #44） | Python：PDF/DOCX/XLSX/PPT 等本地文件→Markdown | 与 MarkdownExtractor 不同域（本地文件 vs 网页 HTML）；Lasso 已有 pdf.ts 走 pdfjs 路线，INV-68 禁 spawn python，不可引入 |
| **firecrawl/firecrawl** | ~150k★（官网自述 150K+） | 「context API」：v2 search/scrape/crawl/map/extract；search 后端串行级联 fireEngine→SearXNG→DDG→空响应（诚实空） | search 多后端级联 + search+scrape 融合的最强对标；自托管免费层=DDG 抓取 |
| **unclecode/crawl4ai** | 50k+★（README 自述） | LLM 友好爬虫：markdown 生成策略 + Pruning/BM25/LLM 三档 ContentFilter | Lasso content-filter-cite.ts 已注明借鉴其 convert_links_to_citations；Pruning/BM25 filter 在 Lasso 注释中「推迟 v1.2」 |
| **aas-ee/open-webSearch** | 数 k★（MCP Market/awesomeclaude 收录；Lasso serp/extract.ts 头注释即借鉴其 selector 级联） | 全免费抓取式多引擎 MCP：baidu/bing/ddg/brave/exa/csdn/github/juejin/linuxdo/startpage/zhihu 共 11 引擎；抓取三段升级（axios→带真实 Chrome cookie 重试→playwright 渲染） | 最贴近 Lasso 定位的免费多源 MCP 对标；其 fetchWebContent 的反爬升级梯是 Lasso fetch_url（设计上不 fallback）没有的形态 |
| **kepano/defuddle** | npm latest **0.19.2**（2026-07-22 发布；Obsidian Web Clipper 作者） | Readability 替代：纯 JS 正文抽取，去 jsdom 重依赖，支持任意 DOM 实现 | Lasso MarkdownExtractor 的核心引擎（现锁 lock 在 0.19.1，^range 兼容 0.19.2） |
| **turndown** | npm latest 7.2.4（2026-04） | HTML→Markdown 转换器（@mixmark-io/domino 轻量 DOM） | Lasso 已用同版本 7.2.4，无动向 |
| **jina-ai/reader** | r.jina.ai / **s.jina.ai** 双入口 | URL→Markdown（r.）+ 搜索并自动抓取 top-5 结果正文（s.） | 「search+read 融合」范式代表；Lasso 走 search/fetch 分离（caller 编排） |
| **ihor-sokoliuk/mcp-searxng** | 中小热度（GitHub MCP Registry featured） | SearXNG 自托管实例的薄 MCP 包装（单后端透传） | SearXNG 生态最热 MCP；本身架构薄（无聚合/fallback），Lasso 若加 SearXNG 通道参考其 API 形状即可 |
| **tavily / exa / brave（商业 API 域）** | aimultiple 2026 agentic search 基准：Brave 97.x ≈ Tavily+1 分 | LLM-native 搜索 API：answer 字段、深度研究、neural 检索 | 商业付费层（Lasso L4）；Lasso 已接 Brave/Bing；基准结论支持 Lasso「Brave 做英文艺主力」现状 |

版本动向要点：defuddle 0.19.2（Lasso ^0.19.1 语义兼容，lockfile 停 0.19.1）；turndown 无变化；firecrawl v2 API 已成默认（search 后端三选一级联）；markitdown 爆发式增长但属本地文件域。

---

## 2. 白盒对标表

| # | 维度 | Lasso 现状源码锚点 | 对标项目源码锚点 | 判定 |
|---|---|---|---|---|
| 1 | 多引擎聚合范式 | `src/search/MultiSourceFanout.ts`：Promise.allSettled + partial_failures 诚实记录；`allocateLimit` 按 quotaRemaining 比例 × CJK/EN 语言启发式分配 limit；RpmLimiter 滑动窗（worked 才记账） | open-webSearch `src/core/search/searchService.ts`：`distributeLimit` 纯均分 + `Promise.all` flat().slice()；无配额/限频/熔断。firecrawl `apps/api/src/search/v2/index.ts`：串行级联 fireEngine→SearXNG→DDG，非并发 | **Lasso 优**（配额感知分配 + 全链审计链是独有；对标项目无 language-aware 分配） |
| 2 | fallback 编排架构 | `src/search/FallbackChain.ts`（plan 构造器 + INV-55 单一引擎）→ `src/fallback/FallbackDecider.ts`（INV-4）+ CircuitBreaker + PolicyGate + BudgetTracker | firecrawl v2/index.ts：try/catch 内联级联，失败返 `{}`（空响应）；open-webSearch：per-engine catch 后静默丢 | **Lasso 优**（单一 fallback 引擎 + tri-state 诚实性领先；firecrawl 空响应掩盖失败源） |
| 3 | 免费源（零 Key）覆盖 | `src/serp/extract.ts::serpScrapeFallback`：硬编码 `baidu.com/s` 单引擎 + 正则抽 URL；`selectors.ts` 定义了 baidu+google 两套 selector 但 `selectorsFor` 无生产调用方（仅测试），google 路径未接线 | firecrawl `search/v2/ddgsearch.ts`（DDG 抓取为自托管最后兜底）；open-webSearch 11 引擎含 duckduckgo/startpage | **Lasso 落后**（非中文 query 的免费兜底只有百度，英文覆盖弱；DDG 是社区共识级零 Key 兜底） |
| 4 | 免费层分级路由 | `src/search/FreeTierRouter.ts`：L1（DDG/SearXNG 零 Key）/L2（Brave/智谱）/L3（Exa/Jina 免 Key 远程）/L4（付费）四级已实现，但注释自认「v0.2 暂无 L1 provider，返回空」「L3 暂无」——L1/L3 是**设计了但空着的抽屉**；machine_mcp 填了 L1 一格 | open-webSearch 全引擎即 L1；firecrawl keyless 模式（2026 新推 Firecrawl Keyless 博客） | **落后半档**（路由机制优但空转；L1 实际只有 machine_mcp 一个成员） |
| 5 | 时效/新鲜度参数 | `src/tools/search.ts::searchSchema` 无任何 freshness/time_range 字段；BraveChannel/BingChannel/SearchChannel grep `freshness\|tbs\|time_range` 零命中 | firecrawl `search/execute.ts` 透传 `tbs`；Brave API 原生 `freshness` 参数；智谱 web_search_prime MCP 原生 `search_recency_filter` 参数（本轮调研员自己的同款 MCP 即有此参数） | **Lasso 落后**（「查最新」场景 Lasso 无法表达，只能靠 query 里手写日期词；三个已接引擎的上游能力被白白丢弃） |
| 6 | 域名过滤 | 无（search 结果由 CC 自行过滤） | firecrawl `lib/search-query-builder.ts`：includeDomains/excludeDomains 编译进上游 query + `getCategoryFromUrl` 分类 | **持平**（firecrawl 是云 API 语义需要；Lasso 是本地 MCP，CC 自己过滤零成本，不加反而符合简单架构） |
| 7 | search+抓正文融合 | 设计上分离：search 只回 URL/snippet，抓正文走 fetch_url / browse_headless 独立 tool（INV-58 同族边界观）；wayback 也是独立 tool | firecrawl `search/execute.ts::scrapeSearchResults`（search 请求内嵌 scrapeOptions 批量抓正文 merge）；s.jina.ai 搜索自动抓 top-5 正文 | **持平（设计取舍）**：融合省 agent 轮次但强制付全部带宽；Lasso 让 CC 按需抓 = token 经济性更优，且与 INV 家族一致。不建议跟进 |
| 8 | 结果缓存 | `src/search/SearchCache.ts`：7 天 TTL + sha1(engine+region+limit) 分片落盘 + LRU 1000 懒 GC，零外部依赖 | firecrawl 用 Redis + crawler-cache；open-webSearch 无缓存 | **Lasso 优**（本地 MCP 场景零依赖方案更合适；注意：若加 freshness 参数必须进 cache key，INV-11 需同步扩展） |
| 9 | markdown 引擎选型 | `src/browse/markdown-extractor.ts`：defuddle（正文抽取）+ turndown（转换）+ 降级链 defuddle→turndown-only→抛错；raw 档 byte-identical 守护（INV-66/68）；MARKDOWN_ENGINE 常量供 doctor 消费 | open-webSearch `fetchWebContent.ts`：cheerio 容器启发式（preferredContainers 白名单）为默认 + 可选 @mozilla/readability+jsdom（懒加载、缺包报错）；crawl4ai 自研 html2text | **Lasso 持平偏优**：defuddle 是 2025-2026 社区共识的现代化选型（Obsidian Web Clipper 同引擎），优于 cheerio 启发式；版本 0.19.1→0.19.2 仅 lockfile 滞后 |
| 10 | 查询感知内容过滤 | 无。`content-filter-cite.ts` 头注释明确「PruningContentFilter ~200 行 port / BM25ContentFilter ~100 行 port 推迟 v1.2」 | crawl4ai `content_filter_strategy.py`：PruningContentFilter（text_density 0.4+link_density 0.2+tag_weight 0.2+class_id 0.1+len 0.1 复合评分，动态阈值，preserve 白名单）、BM25ContentFilter（BM25Okapi+标签权重）、LLMContentFilter（分块+缓存） | **Lasso 落后（有条件）**：仅当 defuddle 对非常规版式（docs 站/表格密集页）抽不满时才有感；默认路径不受影响 |
| 11 | 引用角标（citation） | `src/browse/content-filter-cite.ts`：Crawl4AI convert_links_to_citations 的纯 TS 重实现（INV-69 只借鉴算法不引依赖），⟨N⟩ + References 段，fetch_url 与 browse 两处可用 | firecrawl/crawl4ai MCP 输出均无等价物；仅 Perplexity 类产品有 inline citation | **Lasso 优**（差异化卖点：markdown_cited 档在开源 MCP 里独一档） |
| 12 | 反爬升级梯（内容抓取侧） | `src/tools/fetch-url.ts`：故意零 fallback（INV-23 禁 fetch↔browse 互 fallback），反爬站点文档化走 browse_headless/steel/browserbase | open-webSearch `fetchWebContent.ts`：axios →（401/403/429 或 bot-challenge 启发式）带真实 Chrome cookie 重试 →（SPA 判定：抽取只剩 metadata 且 <200 字）playwright 整页渲染，三段一 tool 内 | **持平（设计取舍）**：open-webSearch 省 CC 轮次但 tool 内隐藏成本不可控（一次调用可能起浏览器）；Lasso 显式边界符合 tri-state 哲学与 R-INT-01。不建议跟进 |
| 13 | Key 池/配额治理 | `src/config/quota-ledger.ts`（pickKey 贪心 + markExhausted + Retry-After 熔断，INV-10/54）+ CallerTierTracker per-caller 窗 + BudgetTracker | open-webSearch 有 budget enforcement 字样但薄；firecrawl 是计费 credits（商业模型） | **Lasso 优**（个人多 Key 池场景独有） |
| 14 | 死链救援 | `src/tools/wayback.ts`：wayback_lookup 独立 tool + SSRF 同守（INV-56/58） | 对标项目均无内建 | **Lasso 优** |

---

## 3. 候选调优项

> 宁缺毋滥：3 条。每条都先过了「反过度设计」（架构想法/01 R-INT）这一关。已评估并**否决**的：SearXNG 自托管通道（用户需自建实例，运维成本违背「单人+AI 维护可持续」，且 machine_mcp 已示范零配置优先路线更契合）；search+scrape 融合（违背 INV-58 族边界 + token 经济性劣）；fetch 内置浏览器升级梯（违背 INV-23）。

### 候选 1：search 增加 freshness 参数并透传三引擎（推荐，低成本高收益）

- **对标证据**：firecrawl `search/execute.ts` 透传 `tbs`；Brave Search API 原生 `freshness`（pd/pw/pm/py）；Bing v7 原生 `freshness`；智谱 web_search_prime MCP 原生 `search_recency_filter`（Lasso `SearchChannel.ts:131-135` 的 callTool 参数现只传 search_query/search_intent/count 三项，上游能力闲置）。本轮调研任务本身就是「查最新最热」型需求——Lasso 现状无法表达「只要近一周」。
- **具体改法**：`searchSchema` 加 `freshness: z.enum(["day","week","month","year"]).optional()`；BraveChannel 映射到 `freshness=pd/pw/pm/py` query 参数；BingChannel 映射到 `freshness=Day/Week/Month`；SearchChannel callTool 加 `search_recency_filter`；**SearchCache._key 必须同步纳入 freshness**（INV-11 语义扩展：「防同 query 不同参数误命中」原本就含此意图，属不变量修订而非违反）。
- **预期收益**：时效性查询（调研/新闻/版本动向）结果质量直接提升；三行 schema + 三处 channel 各一参数 + cache key 一处。
- **实施代价**：小（~1 天含测试；改 INV-11 表述 + 补 cache-key 单测）。
- **风险**：低。optional 无 default，不传 = byte-identical 现行为（与 extract_mode 同款守护手法）。

### 候选 2：SERP 免费兜底补 DuckDuckGo（非中文 query 路由）

- **对标证据**：firecrawl `search/v2/ddgsearch.ts` 把 DDG 抓取作为自托管最后兜底；open-webSearch 引擎列表含 duckduckgo；Lasso 自己的 `FreeTierRouter.ts:5` 注释「L1：只允许完全免费零 Key（DDG/SearXNG 自建）」——L1 设计之初就点名 DDG，至今未实现。现状 `serp/extract.ts` 硬编码百度：中文 query 合理（fake-ip/国内网络更稳，注释自述），但英文 query 落到百度 = 免费层英文兜底缺位。
- **具体改法**：`serpScrapeFallback` 按 query 是否 CJK（复用 `MultiSourceFanout.ts:285` 同款正则）选引擎：CJK→baidu.com/s（现状），非 CJK→duckduckgo.com/html/?q=（纯 HTML 端点，browse_headless 渲染后同款快照正则抽取）；SerpHealthMonitor engine 名扩 "ddg"。**不动 INV-23**（仍全程走 browse_headless，不开 HTTP 直抓新路）。
- **预期收益**：零 Key 英文兜底从「百度凑合」变「社区共识引擎」；serp selector 体系（SelectorRegistry/SerpHealthMonitor/ChangeDetection）已有的多引擎骨架第一次真正用上第二引擎。
- **实施代价**：小-中（~1-2 天：extract.ts 分流 + DDG 快照正则或 selector 一套 + 健康监控单测）。
- **风险**：中低。DDG 对自动化访问限频较狠（open-webSearch/SearXNG-Public 都注明 unreliable/rate-limited）；但该路径本来就是「全付费源失败后的最后兜底」，SerpHealthMonitor 的 hit/miss 告警链现成可观测。另可顺手处理 `selectors.ts` 里未接线的 google selector（要么接线要么删，消灭死配置——符合 R-INT 卫生）。

### 候选 3：PruningContentFilter 纯 TS port（条件触发，暂缓执行）

- **对标证据**：crawl4ai `content_filter_strategy.py::PruningContentFilter`（复合评分：text_density×0.4 + link_density×0.2 + tag_weight×0.2 + class_id_weight×0.1 + text_length×0.1，动态阈值 + preserve_classes/tags 白名单）；Lasso `content-filter-cite.ts:19-20` 自己标注的 v1.2 债。
- **具体改法**（若触发）：`MarkdownExtractOptions` 加 `filter?: { pruning?: { threshold?: number } }`，defuddle 失败或输出超长（如 >32KiB）时对 turndown-only 全页输出跑 pruning 再转换；纯 TS port ~200 行，不引依赖（守 INV-69 同款红线）。
- **预期收益**：限 defuddle 抽不好的版式（文档站、表格密集页、坏语义 HTML）下的 token 裁剪；turndown-only 降级档（全页转换）的输出体积可显著下降。
- **实施代价**：中（~200 行 + fixture 单测，~2-3 天）。
- **风险**：中。调参敏感（crawl4ai 默认 0.48 阈值是英文语料经验值，中文文本密度分布不同）；若无真实 case 驱动就是过度设计。
- **裁决建议**：**维持推迟**，但把触发条件写死：当 doctor/实测出现 ≥3 个「defuddle 抽取失败或 markdown 档超 envelope 上限高频落盘」的真实站点案例时再启动。这符合「宁缺毋滥」与 38 条 R-INT 的克制原则。

---

## 结论速览

- Lasso 在 **fallback 架构诚实性**（tri-state + 单一引擎 + 审计链）、**配额/Key 池治理**、**本地零依赖缓存**、**引用角标差异化**、**wayback 死链救援**五维领先全部对标项目。
- 真实差距集中在两处：**freshness 时效参数缺失**（上游三引擎能力闲置，候选 1）与**英文零 Key 兜底缺位**（百度独木桥，候选 2）；二者皆小改动、不破任何 INV（候选 1 需修订 INV-11 表述）。
- 引擎选型（defuddle+turndown）处于 2026 社区最优路线，无升级必要；markitdown 火热但属本地文件域且被 INV-68 排除，无需动作。
