# Round 2 复审：搜索与内容抽取域（search 链路 + MarkdownExtractor）

日期：2026-08-17 ｜ 调研员：Round-2「搜索与内容抽取」｜ Lasso 基线：**v1.11.0**（工作树，package.json 已 bump；round1 T1/T2/T6/T9 已落地，INV 78→79）

复审范围（按任务书）：①上轮调整是否达最优（T6 freshness / T9 DDG）；②上轮 watch/NO-GO 是否有翻案证据；③全新热点。避免重复 round1 已裁决内容。

方法：白盒读 Lasso v1.11 本域全部改动源码；zread 白盒读 defuddle master + open-webSearch master；**本地 node 实测** Lasso 已安装的 defuddle 0.19.1 隐藏能力（probe 脚本实跑，证据见 §2-3）；GitHub API / npm registry 拉热度数据（2026-08-17）。

---

## 1. 本域最新最热项目清单

| 项目 | 热度数据（2026-08-17 实拉） | 一句话机制 | 与 Lasso 的关系 |
|---|---|---|---|
| **kepano/defuddle** | 8,991★ ｜ npm 周下载 **797,332**（kepano 自述 3 月前 329k/周 → 翻倍激增中）｜ pushed 2026-08-03 ｜ latest 0.19.2（2026-07-22） | 正文抽取 + **内置高质量 markdown 管线**（GFM 表格 / MathML→LaTeX / 脚注 / callout / 代码语言 / srcset 最优图 / YouTube·X embed）+ **~30 个站点专用 extractor**（github/reddit/hn/wikipedia/substack/medium/nytimes/discourse/mastodon/threads/bluesky/linkedin/chatgpt/claude/youtube…）按 hostname 注册匹配 | Lasso 已装 0.19.1 但 **URL 传 `""` 且 options 传 `{}` → 两大能力全部闲置**（本轮最重要发现，见 §2-3/候选 1、2） |
| **firecrawl** | 168,122★ ｜ pushed 2026-08-16 | v2 `/x402` 新一代 search endpoint（#2218）+ 自定义相关度模型（API 形状不变）；search+scrape 融合深化；Keyless 免费层 | 融合路线继续加码，反证 Lasso INV-58 边界判断（本地 MCP token 经济性）无需翻案；SERP 兜底仍 DDG 共识 |
| **microsoft/markitdown** | 174,072★ ｜ pushed 2026-07-29 | 本地文件（PDF/DOCX/…）→Markdown | 仍是本地文件域，INV-68 排除不变，**无翻案** |
| **unclecode/crawl4ai** | 78,361★ ｜ pushed 2026-08-15（当日活跃） | v0.9.2（2026-07-15）：Docker/dispatcher 稳定化补丁；markdown 范式未变（pluggable DefaultMarkdownGenerator + Pruning/BM25 filter 同款） | 上轮对标结论全部维持；R2（Pruning port）触发条件仍未见证据 |
| **Aas-ee/open-webSearch** | 1,714★ ｜ pushed 2026-08-14 | 演化为 MCP+CLI+本地 daemon 三 runtime + `skills/`（SKILL.md agent 技能包）；DDG 引擎 = `html.duckduckgo.com/html/` POST + `div.result`/`a.result__a`/`.result__snippet` selector 三件套 | **反向验证 T9**：Lasso 的 DDG 端点与 selector 与社区标杆逐字一致（见 §2-2） |
| **sweetcornna/free-search-mcp** | 51★ ｜ pushed 2026-08-06（新项目） | local-first 零 Key 搜索 MCP：DDG/Mojeek/Startpage 三引擎 + Playwright 兜底 | 方向印证 Lasso 免费 SERP 路线；其多免费引擎仅 51★，不足以上升为 Lasso 多引擎兜底依据（watch） |
| **You.com MCP** | 商业公告（2026） | 免 key 起步的远程搜索 MCP（you-search 等三 tool） | 零 Key 远程源生态出现 → Lasso L3「空抽屉」出现可填对象，但 machine_mcp 已覆盖零配置场景（watch） |
| **Perplexity Agentic Search SDK** | research.perplexity.ai（2026） | 「搜索即代码生成」：搜索栈拆可组合原语 | 商业 SDK 路线动向，与本地 MCP 无直接对标关系（记录） |
| **Brave Search API 2026** | 官方博客（exponential growth、Snowflake 集成） | 新增 Place Search / Answers / LLM Context 端点；核心 `freshness=pd/pw/pm/py` 参数不变 | T6 透传的参数面保持兼容，无回归风险；新端点属付费层扩张，Lasso 不动 |
| **Mintlify llms.txt 生态** | llmstxt.org v2 ｜ Mintlify/GitBook/Fern 默认生成 | 每页 URL 追加 `.md` 直取 markdown + content negotiation + `/skill.md`；官方基准「markdown 直取是 agents 最高效路径」 | 文档站服务侧标准成形；CC 自己会拼 `.md`，Lasso 自动化违反简单架构（仅 description 提示级动作，见候选 3 附注） |
| tavily-mcp 0.2.22 / exa-mcp-server 3.4.0 / firecrawl-mcp 3.24.0 | npm 实拉 | 商业 API 官方 MCP 小步迭代 | 无范式变化 |
| jina-ai/reader | 11,873★ ｜ pushed 2026-05-22 | r./s.jina.ai 双入口不变 | 上轮结论维持 |

---

## 2. 白盒对标表

### 2-1. 上轮调整落地复核（任务①）

| # | 维度 | Lasso v1.11 现状源码锚点（实读） | 上游/对标锚点 | 判定 |
|---|---|---|---|---|
| 1 | T6 freshness 主链 | `tools/search.ts:104` schema（enum 4 值 optional 无 default）；`SearchChannel.ts:62-67,151-154` ZHIPU_RECENCY_MAP（day/week/month/year 全档）；`BraveChannel.ts:243` pd/pw/pm/py；`BingChannel.ts:242-244` Day/Week/Month（**year 诚实不传**）；`SearchCache.ts:163-180` key 纳入 freshness（不传 = 基线 byte-identical）；INV-11 已修订（check-invariants.mjs:68,329）且 review03 mutation 抽查「cache key 去 freshness → search-freshness 2 测红」 | Brave/智谱/Bing 原生参数面 | **主链已达最优**（含 mutation 实证） |
| 2 | T6 完整性缺口 | **machine_mcp 未透传**：`MachineMcpSearchChannel.ts:49-54` MachineMcpSearchOpts 无 freshness 字段；而 fallback_chain 是显式「高可靠」engine 且 `FallbackChain.ts:59` DEFAULT_FALLBACK_ORDER **machine_mcp 首位**——用户传 freshness 时首位引擎静默忽略（`tools/search.ts:618-621` 只传 limit/engine/region/no_cache）。另 `serp/extract.ts:67-77` serpUrlFor 未拼 DDG `df=`（兜底路径 freshness 也丢） | 智谱上游 `search_recency_filter`（machine_mcp 调同一 web_search_prime，Lasso 自己的 SearchChannel 已证参数名）；DDG html 端点原生 `df=d/w/m/y`（Apify/BrightData 文档实证） | **落后半档**（两处小缺口，候选 3） |
| 3 | T9 DDG 兜底 | `serp/extract.ts:55-77` CJK/非 CJK 分流（CJK_RE 与 MultiSourceFanout 同款正则双处一致）+ `html.duckduckgo.com/html/` GET + `unwrapDdgRedirect`（uddg 解包）+ F5 region 诚实（ddg_serp/us vs baidu_serp/cn）；`selectors.ts` google 死配置已删、DDG_SELECTORS 已接线 `SelectorRegistry`（`index.ts:700` 实例化）+ doctor 消费（`doctor.ts:980-984`） | open-webSearch `engines/duckduckgo/searchDuckDuckGo.ts`：同端点（POST 形式）+ 同 selector 三件套 `div.result`/`a.result__a`/`.result__snippet`；firecrawl DDG 兜底同共识 | **Lasso 持平偏优**（引擎选择与社区共识逐字一致；region 诚实 + 健康监控接线为 Lasso 独有；命中判据仍正则抽 URL 属既定 v0.7 计划，非新债） |

**结论（任务①）**：T6/T9 均按裁决落地且质量高（含 mutation 红测、诚实降级、死配置清理），**主链已达最优**；残余是两处小路径的 freshness 完整性缺口（候选 3，XS 级）。

### 2-2. 本域白盒对标（含新发现）

| # | 维度 | Lasso 现状源码锚点（实读） | 对标项目源码锚点（zread 实读/本地实测） | 判定 |
|---|---|---|---|---|
| 4 | **已装依赖能力利用度（markdown）** | `browse/markdown-extractor.ts:102` `Defuddle(html, "", {})` 裸调——无 URL、无 options；:116-120 自建裸 `TurndownService`（仅 headingStyle/bulletMarker/fenced 三配置，**零自定义规则**） | defuddle `src/node.ts`（toMarkdown 调用）+ `src/markdown.ts` createMarkdownContent（**~700 行 turndown 规则**：GFM 表格含 colspan/rowspan/布局表检测、MathML→LaTeX（mathml-to-latex 已在 Lasso node_modules）、脚注 fnref/fn、callout `> [!NOTE]`、代码语言检测、srcset 最优图、YouTube/X embed、task list、arXiv enumerate）；选项 `markdown`/`separateMarkdown`（installed 0.19.1 dist/types.d.ts 实证）。**本地实测**：同 fixture `separateMarkdown:true` → `"\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|"`（GFM 表格），Lasso 现管线对表格无 rule（结构全丢） | **Lasso 落后（本轮量级差）**——安装的依赖已带表格/数学保真，Lasso 只用了它的正文抽取半截 |
| 5 | **站点专用 extractor** | 同上 url="" ——`extractor-registry.js` findExtractor 首行 `new URL(url).hostname`，空串必抛→try/catch→**零 extractor 激活**（机制白盒证实）。两调用点 URL 均在作用域却未传：`tools/fetch-url.ts:276`（url 变量可用）、`channels/BrowseChannel.ts:870`（parsed.url 从 evaluate_script 返回却丢弃） | defuddle `extractors/`（installed 0.19.1 实证 28 文件）：github（DOM 标记门控）/reddit/hackernews/wikipedia/substack/medium/nytimes/discourse/mastodon/threads/bluesky/linkedin/youtube（async InnerTube）/chatgpt/claude/gemini/grok/bilibili 等。**实测**：传入 URL 后相对链接 `item?id=1` → `https://news.ycombinator.com/item?id=1`（绝对化，markdown 相对链接对 CC 近乎无用）；github extractor 需真实 DOM 标记（合成 fixture 不触发——报告如实标注） | **Lasso 落后（可低成本翻正）**——一参数之差，~30 个恰是 CC 调研高频站的专用 extractor 全部休眠 |
| 6 | 多引擎聚合 / fallback / 配额 / 缓存 / 引用角标 / wayback | MultiSourceFanout（配额感知分配）/ FallbackChain INV-55 / quota ledger INV-10/54 / SearchCache（零依赖 7 天 TTL）/ content-filter-cite / wayback | firecrawl 串行级联空响应掩盖失败源；open-webSearch 均分无配额；x402 新端点未改该结构 | **Lasso 优（维持）**——round1 结论零翻案 |
| 7 | search+scrape 融合 | 不融合（INV-58/23） | firecrawl x402 + relevance model 继续深化融合 | **维持 NO-GO（R8）**——云端按 token 计费逻辑与本地 MCP 相反，融合深化反证边界正确 |
| 8 | 结构化输出（schema-based 抽取） | 无（CC 经 browse evaluate_script 自行结构化） | crawl4ai JsonCssExtractionStrategy / firecrawl extract | **持平（设计取舍维持）**——CC 即 schema 执行器，加 schema 抽取 tool = 过度设计，不建议跟进 |
| 9 | 免费兜底引擎数 | ddg 单兜底（+baidu CJK） | free-search-mcp：DDG/Mojeek/Startpage 三引擎 | **持平**——Lasso 兜底在 fallback 链语义下单引擎够用；对标仅 51★ 不足以构成证据（watch） |
| 10 | 文档站 LLM 友好路由 | 无 | Mintlify `.md` 后缀 / llms.txt / skill.md 惯例成形 | **落后半档但不宜自动化**——CC 自己会拼 `.md`；Lasso 自动试 `url.md` 属越权魔法（fetch_url 设计上无 fallback）。可做提示级动作（候选 3 附注） |

---

## 3. 候选调优项（3 条）

> 宁缺毋滥。每条均有本地实测或逐行白盒证据；全部零新依赖（defuddle 已在 lockfile）。

### 候选 1（P1）：defuddle URL 透传——激活 ~30 个站点专用 extractor + 相对链接绝对化

- **对标证据**：`markdown-extractor.ts:102` 传 `""`；`extractor-registry.js` findExtractor 首行 `new URL(url).hostname`（空串必抛 → 零 extractor，机制白盒证实）；实测传入 URL 后相对链接绝对化生效；`fetch-url.ts:276` / `BrowseChannel.ts:870` 两个调用点真实 URL 都已在作用域（后者 evaluate_script 明明返回了 parsed.url 却丢弃）。
- **具体改法**：`MarkdownExtractOptions` 加 `url?: string`；两调用点各传一行；`Defuddle(html, opts.url ?? "", {})`。不传 = 现行为（与 freshness 同款 optional 无 default byte-identical 守护手法）。
- **预期收益**：github issue/PR、reddit 帖、HN 讨论、wikipedia、substack/medium/nytimes 文章、discourse/mastodon/threads/bluesky、chatgpt/claude.ai 对话页等**恰是 CC 调研最高频的站点族**的正文抽取质量直取上游最优实现；markdown 内相对链接 → 绝对链接（对 CC 可直接 fetch）。
- **实施代价**：XS-S（参数三处 + 真实站点 fixture 测试各一，~半天）。
- **风险评估**：低。全部 sync extractor 纯 DOM 操作零网络；**明确不启用 `useAsync`**（youtube InnerTube 等第三方 fetch 会绕过 Lasso httpClient/SSRF 面与超时预算——在 markdown-extractor.ts 注释钉死排除理由）。

### 候选 2（P1，可与候选 1 同 PR）：defuddle `separateMarkdown` 接管转换档——表格/数学结构保真

- **对标证据**：本地实测 installed 0.19.1 `separateMarkdown:true` 产出 GFM 表格（`| a | b |` + separator 行）；Lasso 现管线裸 TurndownService 对 `<table>` 无 rule（turndown 未覆盖元素仅连缀子文本，**表格结构全丢**）；defuddle `markdown.ts` 另有 colspan/rowspan/布局表检测、MathML→LaTeX（mathml-to-latex 已随 defuddle 装入 node_modules）、脚注、callout、代码语言检测、srcset 最优图——**全部是 Lasso markdown 档（文档站/表格密集页）的质量短板**，且正是 round1 R2 触发条件关注的版式。
- **具体改法**：`extractMarkdown` defuddle 成功路径改传 `{ url, separateMarkdown: true }` → markdown 取 `result.contentMarkdown`；defuddle 失败降级档（turndown-only）原样保留保底；`served_by` 字面 "defuddle+turndown" 不变（defuddle 内部即 turndown，语义仍准确）；`MARKDOWN_ENGINE` 常量不动。
- **预期收益**：markdown 档对表格/数学密集页（文档站、arXiv、wiki）的 LLM 可用性数量级提升；删掉自造转换层与上游的重复（保留降级路径）。
- **实施代价**：S（fixture 基线对齐 + Obsidian 风格语法决策 ~1 天）。
- **风险评估**：中低。markdown 档输出形状变化（INV-66 只钉 raw 档字节，markdown 档无字节承诺）；defuddle 输出含 Obsidian 方言语法（`==高亮==`、`![](youtube链接)` embed、`[^N]` 脚注）——对 LLM 阅读无害，接受并在 README 注明。**此项同时部分回应 R2**：先拿「转换保真」这个更基础的杠杆，Pruning token 裁剪维持 watch 不变。

### 候选 3（P2，XS）：freshness 补全 machine_mcp + DDG SERP `df=`

- **对标证据**：`MachineMcpSearchChannel.ts:49-54` opts 无 freshness，而它是 fallback_chain（显式高可靠 engine）的**首位**引擎——传 freshness 被静默忽略；machine_mcp 与 SearchChannel 调同一 web_search_prime 上游（参数名 search_recency_filter 已被 `SearchChannel.ts:151-154` 证明）；DDG html 端点原生 `df=d/w/m/y`（Apify/BrightData/Scrapingdog 三方文档一致），`extract.ts:67-77` 未拼。
- **具体改法**：① MachineMcpSearchOpts 加 freshness + callTool 透传（复用 ZHIPU_RECENCY_MAP，含 fallback_chain 调用点 `search.ts:618` 传参）；② `serpScrapeFallback`/`serpUrlFor` 加可选 freshness，ddg 分支拼 `&df=`（baidu 无对应参数不拼，诚实降级）；③ 顺手卫生：`SerpHealthMonitor.ts:66` stale 注释 `"baidu" | "google"` → ddg；defuddle lock 0.19.1→0.19.2 rider（^range 已含，纯 lockfile 刷新）。
- **预期收益**：freshness 从「主链 3 引擎」到「全部 5 路径」语义一致；消灭「高可靠 engine 静默丢参数」这一 tri-state 同构小违背。
- **实施代价**：XS（~2 小时含单测：machine_mcp 透传断言 + df 拼接断言 + 不传 byte-identical 断言）。
- **风险评估**：低。machine_mcp 未探测到时零影响；df 不传 = 现行为。
- **附注（零代码，随手）**：`fetch_url` tool description 加一句「文档站常在 URL 后加 `.md` 或站点根 `/llms.txt` 直取 markdown（Mintlify/GitBook/Fern 惯例）」——提示级，不自动探测（守 fetch 无 fallback 设计）。

### 考虑过、不推荐（宁缺毋滥）

- **Mojeek/Startpage 第二免费兜底引擎**（free-search-mcp 路线）：watch——对标仅 51★；待 SerpHealthMonitor 积累 ddg miss 率数据后再议。
- **You.com 等零 Key 远程源填 L3**：watch——machine_mcp 已覆盖「零配置」场景，L3 填充无用户需求驱动。
- **llms.txt/`.md` 自动探测**：NO——CC 自己会拼；fetch_url 自动试别的 URL 属越权魔法（违 INV-23 精神）。
- **schema-based 结构化抽取 tool**（crawl4ai JsonCss 式）：NO——CC 即 schema 执行器（evaluate_script），加层 = 过度设计。
- **PruningContentFilter port（round1 R2）**：维持 watch，触发条件（≥3 个 defuddle 抽取失败/超 envelope 真实站点案例）未满足；且候选 2 已拿下更基础的转换保真杠杆。

---

## 4. round1 watch/NO-GO 复核结论（任务②）

| 项 | round1 处置 | 本轮证据 | 结论 |
|---|---|---|---|
| R2 PruningContentFilter | watch（触发条件：≥3 真实案例） | 无新案例证据；候选 2 提供更基础杠杆 | **维持 watch** |
| R8 SearXNG 自托管 / search+scrape 融合 / fetch 升级梯 | NO-GO | firecrawl x402 融合深化（云端计费逻辑）；无翻案证据 | **维持 NO-GO** |
| markitdown 引入 | 排除（INV-68 本地文件域+禁 spawn python） | 174k★ 但域不变 | **维持排除** |
| T6/T9 落地 | round1 P1/P2 | 已落地且 mutation 红测（review03）；主链最优，余 2 小缺口（候选 3） | **达最优（含尾差收敛项）** |

## 5. 结论速览

- 上轮两项调整（T6/T9）**主链已达最优**且经 mutation 实证；残余 freshness 两处小路径缺口（候选 3）。
- 本轮唯一量级差发现：**Lasso 对已安装 defuddle 0.19.1 的利用度只有一半**——站点 extractor 体系（~30 站）与高质量 markdown 规则集（GFM 表格/LaTeX 数学/脚注）因 `url=""` + `options={}` 全部休眠，且经本地实测证明installed 版本即可用（候选 1+2，同 PR 可做，合计 ~1.5 天）。
- 多引擎聚合/fallback 诚实性/配额/缓存/引用角标/wayback 六维 Lasso 领先结论零翻案；firecrawl x402 融合深化反证 INV-58 边界判断正确。
- 候选调优项：**3 条**（P1×2：defuddle URL 透传 / separateMarkdown 接管转换；P2×1：freshness 补全）。
