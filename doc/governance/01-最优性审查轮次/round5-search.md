# Round 5 复审：搜索与内容抽取域（search 链路 + MarkdownExtractor）

日期：2026-08-17（round4 同日晚间窗口）｜ 复审员：Round-5「搜索与内容抽取」（第二轮验收后复核轮）｜ Lasso 基线：**v1.13.0 工作树**（HEAD=0b07536 v1.11.0；round2/3/4 全部改动在树未 commit；本域自 round4 验收后零触碰）

复审范围（按任务书）：①第 1/2 轮全部调整是否达最优（本域 = T6 freshness 全链 / T9 DDG 兜底 / T2-3 defuddle URL 透传 / T2-4 separateMarkdown / T2-5 freshness 补全——白盒抽验 + **本轮独立 3 针全新 mutation**，针位与 round4 M1/M2/M3 全部不同）；②上两轮 NO-GO/watch 是否有**新证据**翻案（无新证据不得翻）；③全新热项目。门禁本轮亲跑：`build ✓` / **122 files 1960 passed + 1 skipped（1961）**（与 round4 基线逐字一致，零漂移）/ **79 INV 全绿** ✓。

---

## 0. 结论速览

| 维度 | 结论 |
|---|---|
| ① 两轮调整落地质量 | **全部达最优（复核维持）**。5 项调整白盒锚点与 round4 验收状态逐字一致（本域自 round4 后零代码触碰，git 亲证）；本轮 3 针**全新针位** mutation 全 kill（M-A 2 红 / M-B 3 红 / M-C 5 红）、还原后 74/74 复绿、树 diff 复位至 round2 工作树原状 |
| ② watch/NO-GO 复核 | **零翻案**。9 项全部维持；全部对标数据同日晚间二次实拉，无方向性变化（星数 ±5 级自然涨落）；R8 融合 NO-GO 获第 4 个数据点 |
| ③ 全新热点 | **零合格项**。检索面仍为老面孔 + listicle 噪音（round4 结论复现）；新增 2 个生态样本（g-search-mcp 186★ / Reddit 6-provider 免费 MCP）**均归入既有 watch 族**，无新机制面；2026-08 内容抽取域的社区焦点恰是 defuddle 本身——T2-3/T2-4 路线获第三方媒体面反向验证 |
| **候选调优项** | **0 条**（本域连续第三轮空集；本轮空集经全新针位 mutation + 同日二次数据实拉独立得出，非沿用前轮结论） |
| 数据卫生 | crawl4ai npm 同名包陷阱**复现确认**（`npm view crawl4ai` 仍返回同名无关包 1.1.0；PyPI 0.9.2 不变）——round4 教训有效，后续轮次沿用 PyPI 查询纪律 |

---

## 1. 本域热度与版本动向实拉（2026-08-17 晚间窗口，GitHub API 经代理 + npm/PyPI registry）

| 项目 | 实拉数据（vs round4 同日早间） | 与 Lasso 的关系 |
|---|---|---|
| **kepano/defuddle** | 8,996★（round4：8,995，自然 +1）｜ npm latest **0.19.2 不变**（2026-07-22）｜ pushed 08-03 ｜ **新观察**：master 存在 0.19.2 之后的未发版 commits（07-27「Footnote fixes #351」「Reddit Atom feed fallback #403」「Forward schemaOrgData and options in extractor constructors」） | lockfile 已解析 **0.19.2 = npm latest**（`node_modules/defuddle` 实测 0.19.2）——rider 闭环维持；master 未发版修复（脚注/Reddit Atom 回退/extractor 构造参数透传）**无 npm release 不跟进**，锁版=latest 政策下无动作；YouTube async 路线仍被 `useAsync:false` 红线钉死（`markdown-extractor.ts:116-117` 注释 + `:120` 实参双落在树） |
| **firecrawl** | 168,170★（round4：168,165）｜ pushed 08-16 | 融合范式无结构性变化；R8 NO-GO 第 4 数据点 |
| **microsoft/markitdown** | 174,090★ ｜ pushed 07-29 | 本地文件域不变，INV-68 排除维持 |
| **unclecode/crawl4ai** | **PyPI latest 0.9.2 不变**（70 releases）｜ 78,365★ 与 round4 同值 ｜ pushed 08-15 | npm 同名包陷阱复现（`npm view` 返回无关包）；范式（pluggable generator + Pruning/BM25）零变化，R2 触发条件仍无案例 |
| **Aas-ee/open-webSearch** | 1,714★ ｜ pushed 08-14 | T9 对标锚点（DDG 端点 + selector 三件套）稳定未漂移 |
| sweetcornna/free-search-mcp | **51★ 零增长** ｜ pushed 08-06 | watch 项热度证据不变（连续第三轮零增长） |
| jina-ai/reader | 11,873★ ｜ pushed 05-22 | 无动向，round1 结论维持 |
| Kindly（Shelpuk-AI-Technology-Consulting/kindly-web-search-mcp-server） | 372★ ｜ pushed 07-29（本轮经 search API 复核到位） | watch 维持（触发条件=DOM 抽取系统性截断真实案例，未出现） |
| turndown 7.2.4 | npm 不变 | 转换层零迭代（其角色已收缩为 T2-4 降级保底档） |
| **发布积压（流程级）** | `npm view lasso-mcp` → **latest=1.10.0**；工作树 v1.13.0 | 本域 T6/T9/T2-3/T2-4/T2-5 五项用户可感知改进全部未发布——round4-verdict §4 发布收口欠账维持，随本轮全局收口执行（verdict/用户动作，非本域调优项） |

---

## 2. 任务①：第 1/2 轮全部调整是否达最优（白盒抽验 + 全新针位独立 mutation）

### 2-1. 白盒锚点复核（本轮逐行实读，v1.13.0 当前树）

| 项 | 锚点（本轮实读确认） | 判定 |
|---|---|---|
| **T6 freshness 主链** | schema `tools/search.ts:104`（enum 4 值 optional 无 default，注释含 Bing year 诚实降级）；`SearchChannel.ts:152-153` `search_recency_filter`（ZHIPU_RECENCY_MAP）；`BingChannel.ts:58-60`「year 档 Bing 无对应粒度 → 不传（诚实降级）」；`SearchCache.ts` _key 尾拼 `\|${freshness}`（不传 = byte-identical，INV-11 面） | **与 round4 验收状态逐字一致** |
| **T6/T2-5 全路径透传** | `search.ts` grep freshness 命中 10 处调用点（418/426/436/461/469/474/627/636/644/654/661）+ cache get/set 三处（219/356/496）——**枚举零漏，零静默丢参残余** | **一致** |
| **T2-5 machine_mcp** | `MachineMcpSearchChannel.ts:38` `import { ZHIPU_RECENCY_MAP }`（单一事实源）+ `:143` 透传 | **一致** |
| **T9 DDG 兜底** | `serp/extract.ts:55` CJK_RE；`:63` serpEngineForQuery 分流；`:88-97` ddg URL；`unwrapDdgRedirect`（uddg 解包 + http(s) 门控）；F5 region 诚实（`engine: baidu_serp/ddg_serp` + `region: cn/us` 按 query 语言） | **一致** |
| **T2-5 DDG df=** | `extract.ts` DDG_FRESHNESS_DF（d/w/m/y）+ ddg 分支拼 `&df=`、baidu 不拼（诚实降级注释成文） | **一致** |
| **T2-3 URL 透传** | `markdown-extractor.ts:118` `Defuddle(html, opts.url ?? "", {...})`；调用点 `fetch-url.ts`（`url: rawUrl`）/ `BrowseChannel.ts`（`url: parsed.url`）——两处 T2-3 注释在树 | **一致** |
| **T2-4 separateMarkdown** | `:119` `separateMarkdown: true` + `:120` `useAsync: false`（`:116-117` SSRF/超时预算红线注释）；`:124` `contentMarkdown \|\| null` 缺失降级；`:143-144` 全页保底；`:147-152` 接管路径；`:158` turndown 抛错路径；`:96-98` raw 档 passthrough（INV-66 面不经 defuddle） | **一致** |

**域零触碰亲证**：`git diff` 显示 `SearchCache.ts` / `SearchChannel.ts` 与 HEAD（0b07536，含 round1 T6）零差异；`serp/extract.ts`（+29 行）/ `markdown-extractor.ts`（+47 行）差异恰为 round2 T9 接线/T2-3/T2-4 工作树内容——本域自 round4 验收后**零代码改动**。

### 2-2. 本轮独立 3 针 mutation（针位与 round4 M1/M2/M3 全部不同——补前轮未覆盖的针）

| # | mutation（perl 就地注入） | kill 结果 | 还原 |
|---|---|---|---|
| M-A | `SearchCache._key` 哈希输入去掉 freshness 尾拼（杀 T6 缓存键维度；round4 未覆盖） | `test/unit/search-freshness.spec.ts` **2 红**：「同 query 不同 freshness → 不同 key」「档间互不误命中（day ≠ week ≠ month ≠ year）」。注：`search-cache.spec.ts` 单跑 26/26 绿（kill 断言不在该文件）——跨文件定位 kill 属正常，守卫存在性以红测为准 | ✓ 复位至 HEAD 原文（逐字） |
| M-B | `SearchChannel` zhipu callTool 删除 `search_recency_filter` 展开（杀 T6 主引擎透传；round4 未覆盖） | 同文件 **3 红**：映射 oneDay/oneWeek/oneMonth/oneYear / day → args 含 search_recency_filter='oneDay' / **不传 → args 无该字段（byte-identical）**——含负向守护断言，防「永远传」的过传回归 | ✓ `git restore` 复位（diff 零） |
| M-C | `serpEngineForQuery` 强制恒返 "baidu"（杀 T9 语言分流；round4 未覆盖） | `test/unit/serp-ddg.spec.ts` **5 红**：非 CJK → ddg / browseExec 收到 ddg URL + retrieval_method=serp_scrape_ddg / SerpHealth ddg hit / miss 计数 / df= 透传——分流、引擎名、健康监控、df 四个行为面被同一针全钉 | ✓ 复位（grep 逐字确认） |

还原后受影响 4 文件复跑 **74/74 绿**（serp-ddg 16 + search-freshness 8 + search-cache 26 + markdown-extractor 24）；树 diff 与 mutation 前逐字一致。全量门禁（mutation 前跑）**1960+1skip / 79 INV / build ✓**。

**结论（任务①）**：本域第 1/2 轮 5 项调整**复核维持最优**——白盒零漂移（域零触碰 git 亲证）、3 针全新针位 mutation 全 kill（守卫覆盖缓存键/主引擎透传/语言分流三个 round4 未针面，与前轮合计 6 针互补）、负向 byte-identical 断言同样被钉（M-B 第 3 红）。

---

## 3. 任务②：watch/NO-GO 复核（无新证据不翻案）

| 项 | 上轮处置 | 本轮新证据核查（同日晚间二次实拉） | 结论 |
|---|---|---|---|
| R2 PruningContentFilter port | watch（触发：≥3 个 defuddle 失败/超 envelope 真实站点案例） | crawl4ai PyPI 0.9.2 不变、范式不变；无新案例；T2-4 已消解其目标版式大半 | **维持 watch** |
| Mojeek/Startpage/第二免费兜底引擎族 | watch（free-search-mcp 51★ 不足为据 + 待 ddg miss 率数据） | 51★ **连续第三轮零增长**；本机无 SerpHealth 运行时数据积累；新增样本 g-search-mcp 归入本族（§4），不改变触发条件 | **维持 watch** |
| You.com 等零 Key 远程源填 L3 | watch | 无新证据；machine_mcp 仍覆盖零配置场景 | **维持 watch** |
| Kindly API 内容解析器 | watch（触发=DOM 抽取系统性截断案例） | 372★ / pushed 07-29 零动向；defuddle GitHubExtractor 经 T2-3 激活状态健康 | **维持 watch** |
| llms.txt / `.md` 自动探测 | NO（提示级已落地） | descriptions.ts TIP 在树；无自动化新证据 | **维持 NO** |
| schema-based 结构化抽取 tool | NO | 无新证据；CC 即 schema 执行器逻辑不变 | **维持 NO** |
| markitdown | 排除（INV-68 本地文件域 + 禁 spawn python） | 174,090★ 域不变 | **维持排除** |
| R8：SearXNG 自托管 / search+scrape 融合 / fetch 升级梯 | NO-GO（三轮数据点加固） | firecrawl 08-16 融合纵向深化（第 4 数据点，方向无变化） | **维持 NO-GO** |
| defuddle YouTube transcript | 红线禁用（useAsync SSRF/超时预算） | 0.19.2 无新版；红线注释 + `useAsync:false` 双落在树（本轮实读） | **维持禁用** |

**零翻案**——同日早晚两次独立实拉无方向性变化（星数 ±5 级自然涨落），「无新证据不得翻」纪律维持。

---

## 4. 任务③：全新热点扫描（本轮新做两类检索：英文 MCP 生态 + 内容抽取库，均 recency=oneMonth）

| 新样本 | 数据 | 分类与理由 |
|---|---|---|
| **g-search-mcp**（Augment Code registry 收录） | 186★ | Google SERP **经 Playwright** 抓取、支持并行多关键词、返回结构化 JSON。**归入「第二免费兜底引擎族」watch，不构成翻案**：① Lasso 在 T9 已**有意删除**未接线的 google selector（死配置卫生，round1 候选 2 裁决记录在案）——重新引入 google 路径需先有 ddg miss 率证据（触发条件未满足，无运行时数据）；② Google SERP 反爬强度（consent 墙/bot 检测）显著高于 DDG，fragility 与「最后兜底」定位错配；③ 186★ 量级不足以推翻 51★ 时的证据裁决门槛。价值：为 watch 族记录了第三个候选引擎样本（ddg 现役 / Mojeek / Startpage / google） |
| Reddit r/opencode「I Built a Free Web Search MCP」 | 社区帖热度 | 6 引擎（DDG/Bing/Brave/Tavily/Exa/Firecrawl）免费聚合——**open-webSearch 同族**（多引擎抓取式聚合 + 混合免费/付费），无新机制面；其「免费+付费混合」结构 Lasso FreeTierRouter L1-L4 已更细粒度覆盖 |
| defuddle-mcp（NickyHeC，glama 收录） | 目录收录 | defuddle/Readability 薄 MCP 包装——无新机制；Lasso 原生内嵌 defuddle 全能力（T2-3/T2-4）是更强形态 |
| **2026-08 内容抽取域媒体面** | web2md.org HN 讨论 / dev.to 浏览器工具系列 / 多篇 8 月评测 | **本轮唯一方向性发现（利好确认，非差距）**：8 月社区内容抽取焦点恰是 defuddle 本身（「Defuddle: The Next Generation of Web Content Extraction」「the new kid… more forgiving than Readability」）——Lasso 两轮前押注并深度激活（URL 透传 + separateMarkdown）的引擎正是当前社区共识主角，选型经第三方媒体面**反向验证**。无动作 |

**结论（任务③）**：零新增合格调优项。检索面连续第二轮为老面孔 + listicle 噪音；两个新样本均归入既有 watch 族；唯一方向性信号（defuddle 媒体面走热）是选型正确的确认而非差距。

---

## 5. 非阻断观察（记档维持——均低于五门槛）

1. **TurndownService 无条件构造**（`markdown-extractor.ts:137`）：round3 记档、round4 维持，本轮实读仍在——T2-4 后 defuddle 成功路径不消费该实例仍每次构造（亚毫秒级）；无对标锚点、收益不可测级。**不立项**（M 系 mutation 实验证明降级路径测试仍走通，保底语义健康）。
2. **SERP 兜底 20 条上限与 limit 无关**（`extract.ts` extractResultsFromSnapshot 内 `results.length >= 20`）：round3/4 记档维持，无新对标锚点。**不立项**。
3. **defuddle master 未发版 commits**（07-27 footnote #351 / Reddit Atom fallback #403 / schemaOrgData 透传，见 §1）：非动作项——锁版=latest 政策下等 npm release 即可；**记档为下轮复查锚点**（若下轮 0.19.3+ 发版，按 T2-3/T2-4 既有管线做一次 fixture 回归即可，无需新调研）。

---

## 6. 复审结论

1. **本域复核通过、维持最优**：5 项调整白盒锚点与 round4 验收状态逐字一致（域自 round4 后零触碰，git 亲证）；本轮 3 针**全新针位** mutation（缓存键 freshness / zhipu 透传 / DDG 分流）全 kill 且含负向 byte-identical 断言钉住，与前轮 6 针（round2 review03 + round3 + round4 M1-M3）形成互补全覆盖；门禁亲跑 **1960+1skip / 79 INV / build ✓** 与 round4 基线零漂移。
2. **零翻案**：9 项 watch/NO-GO/红线全部维持；同日早晚两次独立实拉无方向性变化；R8 融合 NO-GO 累计 4 数据点。
3. **新热点零合格项**：两个新样本归入既有 watch 族（不达证据门槛）；defuddle 媒体面走热反向验证 T2-3/T2-4 选型。
4. **候选调优项：0 条**——本域连续第三轮空集（round1 3 条 → round2 3 条 → round3 0 → round4 0（验收）→ **round5 0（复核维持）**），且本轮空集经全新针位 mutation + 二次数据实拉独立得出。本域已处于稳定收敛终态，符合 round3-verdict「实施尾巴清偿后无新量级发现 → 循环自然终止」的健康轨迹。
5. **流程级提醒（非本域调优项）**：npm latest=1.10.0 vs 工作树 v1.13.0，本域五项用户可感知改进积压未发布——维持 round4-verdict §4 发布收口裁决，随全局 ROUND-CLEAN 一并执行。

> 候选轨迹对照：round1 3 → round2 3 → round3 0 → round4 0（验收）→ **round5 0（复核维持）**。收敛非调研不充分——本轮白盒 + 全新 3 针 mutation + 两类 recency 检索 + 三源数据二次实拉均已执行。
