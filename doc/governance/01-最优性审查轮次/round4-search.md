# Round 4 复审：搜索与内容抽取域（search 链路 + MarkdownExtractor）

日期：2026-08-17 ｜ 复审员：Round-4「搜索与内容抽取」（验收轮）｜ Lasso 基线：**v1.13.0 工作树**（round2 T2-1..14 + round3 T3-1..7 全部在树；HEAD=0b07536 v1.11.0 未 commit）

复审范围（按任务书）：①第 1/2 轮全部调整是否达最优（本域 = T6 freshness 全链 / T9 DDG 兜底 / T2-3 defuddle URL 透传 / T2-4 separateMarkdown / T2-5 freshness 补全——白盒抽验新代码 + **本轮独立 3 针 mutation**）；②上两轮 NO-GO/watch 是否有**新证据**翻案（无新证据不得翻）；③全新热项目。门禁本轮亲跑：`build ✓` / **122 files 1960 passed + 1 skipped（1961）**（round3 基线 1940 → T3 实施加 20 测，域外）/ **79 INV 全绿** ✓。

---

## 0. 结论速览

| 维度 | 结论 |
|---|---|
| ① 两轮调整落地质量 | **全部达最优（验收通过）**。5 项调整白盒锚点逐一复核与 round3 抽验状态逐字一致（T3 实施零触碰本域行为面）；本轮新做 3 针独立 mutation 全 kill、还原后 diff-clean + 40/40 复绿 |
| ② watch/NO-GO 复核 | **零翻案**。7 项全部维持；本轮实拉全部对标数据（同日数小时窗口）无方向性变化，无任何新证据 |
| ③ 全新热点 | **零新增合格项**。本轮实拉 + recency 过滤扫描未出现 round3 清单之外的新机制面；MCP v2 spec（2026-07-28）属 arch 域非本域 |
| **候选调优项** | **0 条**（空集——本域连续第二轮空集，round3「健康收敛」判断经验收轮独立复核成立） |
| 数据卫生警示 | crawl4ai **npm 同名包陷阱**（见 §1 注），后续轮次拉版本必须走 PyPI |
| 非阻断观察 | round3 两条 XS 记档维持（§4，仍低于五门槛） |

---

## 1. 本域热度与版本动向实拉（2026-08-17 06:00 窗口，GitHub API 经代理 + npm/PyPI registry）

| 项目 | 实拉数据（vs round3 同日早间） | 与 Lasso 的关系 |
|---|---|---|
| **kepano/defuddle** | npm latest **0.19.2**（2026-07-22，无新版）；周下载 **797,332**；8,995★（round3：8,992）；pushed 08-03 | lockfile 已解析 **0.19.2 = latest**（本轮 `node_modules/defuddle` 实测 0.19.2）——rider 闭环确认；YouTube async 路线仍被 `useAsync:false` 红线钉死（`markdown-extractor.ts:116-117` 注释在案） |
| **firecrawl** | 168,165★（round3：168,153）｜ pushed 08-16 | 融合范式继续纵向深化，无结构性变化；R8 NO-GO 维持 |
| **unclecode/crawl4ai** | **PyPI latest 0.9.2（2026-07-15）不变**；78,365★ ｜ pushed 08-15 | ⚠️ **数据陷阱**：`npm view crawl4ai` 返回 1.1.0——那是 npm 上**同名无关包**（Python 原项目只发 PyPI，master CHANGELOG 止于 0.9.0）。本轮曾据此短暂怀疑「大版本线」，PyPI 核实后排除。**结论：crawl4ai 范式（pluggable generator + Pruning/BM25）零变化，R2 触发条件仍无案例** |
| **Aas-ee/open-webSearch** | 1,714★ ｜ pushed 08-14 | T9 对标锚点（DDG 端点 + selector 三件套）稳定未漂移 |
| **sweetcornna/free-search-mcp** | **51★ 零增长** ｜ pushed 08-06 | watch 项热度证据不变 |
| **jina-ai/reader** | 11,873★ ｜ pushed 05-22 | 无动向，round1 结论维持 |
| **microsoft/markitdown** | 174,080★（round3 同值）｜ pushed 07-29 | 本地文件域不变，INV-68 排除维持 |
| turndown 7.2.4 / firecrawl-mcp 3.24.0 / tavily-mcp 0.2.22 | npm 实拉，全部与 round3 同值 | 商业/转换层零迭代 |
| Kindly（372★，round3 拉取） | 同日窗口无再拉必要（GitHub API 瞬时限流）；07-29 后无 push 记录在案 | watch 维持（触发条件=DOM 抽取系统性截断真实案例，未出现） |
| 新项目扫描 | recency=oneWeek 过滤检索 + MCP 生态清单（Skyvern/Nimble/Fast.io 等 2026 盘点）逐一过目 | 清单内仍是 firecrawl/crawl4ai/brave/exa/tavily 老面孔 + 商业云服务（Scrapeless 等）——**无 round3 未见过的新开源机制面**；MCP v2 spec（2026-07-28「stateless, cacheable, routable」）属 SDK/arch 域，归 round4-arch 复核 |

---

## 2. 任务①：第 1/2 轮全部调整是否达最优（白盒抽验 + 独立 mutation）

### 2-1. 白盒锚点复核（本轮逐行实读，行号为当前 v1.13.0 树）

| 项 | 锚点（本轮实读确认） | 判定 |
|---|---|---|
| **T6 freshness 主链** | schema `tools/search.ts:104`（enum 4 值 optional 无 default）；`SearchChannel.ts:62` ZHIPU_RECENCY_MAP + `:152-153` `search_recency_filter`；`BraveChannel.ts:231` pd/pw/pm/py；`BingChannel.ts:240` Day/Week/Month（year 诚实不传）；`SearchCache.ts:14-15` key 纳 freshness（不传 = byte-identical） | **与 round3 抽验状态逐字一致** |
| **T6/T2-5 全路径透传（10 处调用点全枚举）** | fanout zhipu/brave `search.ts:418/:426`；fanout 内 serp `:436`；单源 zhipu/brave `:461/:469`；单源 serp `:474`；fallback_chain machine_mcp/zhipu/brave/bing `:627/:636/:644/:654`；chain 尾 serp `:661`——**10/10 全透传，零静默丢参残余** | **一致** |
| **T2-5 machine_mcp** | `MachineMcpSearchChannel.ts:38` `import { ZHIPU_RECENCY_MAP }`（单一事实源，非复制映射）+ `:142-144` 透传 | **一致** |
| **T9 DDG 兜底** | `extract.ts:55` CJK_RE（与 MultiSourceFanout 同款正则）；`:62-64` serpEngineForQuery 分流；`:88-97` ddg URL 构造；`:113` retrievalMethod（serp_scrape_ddg/baidu）；`:183-192` unwrapDdgRedirect；`:233-234` F5 region 诚实（ddg_serp/us vs baidu_serp/cn） | **一致** |
| **T2-5 DDG df=** | `extract.ts:70-75` DDG_FRESHNESS_DF（d/w/m/y）；`:90-93` ddg 分支拼 `&df=`、baidu 不拼（诚实降级注释成文） | **一致** |
| **T2-3 URL 透传** | `markdown-extractor.ts:118` `Defuddle(html, opts.url ?? "", {...})`；调用点 `fetch-url.ts:276-279`（`url: rawUrl`）/ `BrowseChannel.ts:873-876`（`url: parsed.url`） | **一致** |
| **T2-4 separateMarkdown** | `:119` `separateMarkdown: true` + `:120` `useAsync: false`（红线注释 `:116-117`）；`:124` contentMarkdown 接管 + `|| null` 缺失降级；`:143-144` 全页保底；`:147-152` 接管路径；`:158` turndown 抛错路径保留；`:96-98` raw 档 passthrough（INV-66 面不经 defuddle） | **一致** |

**T3 实施零触碰**：round3 T3-1..7 全部在 browser/desktop/arch 域；本轮复核证明本域 5 项调整的源码状态与 round3 验收时**逐字一致**（无 T3 改动引入的漂移）——测试数 1940→1960 的 +20 全部来自域外。

### 2-2. 本轮独立 3 针 mutation（验收轮的「测试真钉」复证）

| # | mutation（perl 就地注入） | kill 结果 | 还原 |
|---|---|---|---|
| M1 | `opts.url ?? ""` → `""`（杀 T2-3 URL 透传） | `test/unit/markdown-extractor.spec.ts` **1 红**：「传 url=HN → 站点 extractor 激活 + 相对链接绝对化」断言失败 | ✓ diff-clean |
| M2 | `separateMarkdown: true` → `false`（杀 T2-4 转换接管） | 同文件 **1 红**：「表格 fixture → GFM separator（\| --- \|）存在」断言失败 | ✓ diff-clean |
| M3 | `(df ? \`&df=${df}\` : "")` → `("")`（杀 T2-5 DDG df） | `test/unit/serp-ddg.spec.ts` **2 红**：df 映射 + browseExec 收到带 df= 的 URL | ✓ diff-clean |

还原后受影响 2 文件复跑 **40/40 绿**；全量门禁（mutation 前跑）**1960+1skip / 79 INV / build ✓**。

**结论（任务①）**：本域第 1/2 轮全部 5 项调整**验收通过、已达最优**——白盒无残余缺口（10 调用点枚举零漏）、3 针独立 mutation 全 kill（测试钉行为非摆设）、红线成文（useAsync/df/baidu 降级）、单一事实源（ZHIPU_RECENCY_MAP import）。

---

## 3. 任务②：watch/NO-GO 复核（无新证据不翻案）

| 项 | 上轮处置 | 本轮新证据核查（全部实拉） | 结论 |
|---|---|---|---|
| R2 PruningContentFilter port | watch（触发：≥3 个 defuddle 失败/超 envelope 真实站点案例） | crawl4ai PyPI 0.9.2 不变、filter 范式不变；无新案例；T2-4 已消解其目标版式大半 | **维持 watch** |
| Mojeek/Startpage 第二免费兜底 | watch（free-search-mcp 51★ 不足为据 + 待 ddg miss 率数据） | 51★ **零增长**；无 SerpHealth 运行时数据积累 | **维持 watch** |
| You.com 等零 Key 远程源填 L3 | watch | 无新证据；machine_mcp 仍覆盖零配置场景 | **维持 watch** |
| Kindly API 内容解析器 | watch（触发=DOM 抽取系统性截断案例） | 无触发案例；defuddle GitHubExtractor（issues/PR）经 T2-3 已激活且本轮 M1 mutation 证明测试钉住 | **维持 watch** |
| llms.txt / `.md` 自动探测 | NO（提示级已落地） | `descriptions.ts` TIP 在树；无自动化新证据 | **维持 NO** |
| schema-based 结构化抽取 tool | NO | 无新证据；CC 即 schema 执行器逻辑不变 | **维持 NO** |
| markitdown | 排除（INV-68） | 174k★ 域不变 | **维持排除** |
| R8：SearXNG 自托管 / search+scrape 融合 / fetch 升级梯 | NO-GO（双数据点加固） | firecrawl 08-16 继续融合纵向深化（第三数据点，无方向变化） | **维持 NO-GO** |
| defuddle YouTube transcript | 红线禁用（useAsync SSRF） | 0.19.2 无新版；红线注释与 `useAsync:false` 双重在树（本轮实读 + M2 邻域确认） | **维持禁用** |

**零翻案**——同日窗口内全部对标数据无方向性变化，符合「无新证据不得翻」的纪律。

---

## 4. 非阻断观察（记档不立项——均低于五门槛）

1. **TurndownService 无条件构造**（`markdown-extractor.ts:137`）：round3 记档维持——T2-4 后 defuddle 成功路径不消费该实例仍每次构造（亚毫秒级）；无对标锚点、收益不可测级。**不立项**（注：M2 mutation 实验中该降级路径仍被测试覆盖走通，保底语义健康）。
2. **SERP 兜底 20 条上限与 limit 无关**（`extract.ts:224`）：round3 记档维持，无新对标锚点。**不立项**。
3. **（新增记档）npm 同名包数据陷阱**：`npm view crawl4ai` → 1.1.0 是 npm 上同名无关包；Python 项目必须查 PyPI。本轮已实际踩到并排除（§1）。纯流程教训写入本文档，供后续轮次与 doctor 数据源设计参考——**不构成本域调优项**。

---

## 5. 复审结论

1. **本域验收通过**：第 1/2 轮 5 项调整（T6 freshness 全链 / T9 DDG 兜底 / T2-3 URL 透传 / T2-4 separateMarkdown / T2-5 freshness 补全）白盒锚点与 round3 验收状态逐字一致，T3 域外实施零漂移；本轮独立 3 针 mutation 全 kill + 还原复绿 + 门禁亲跑全绿（1960+1skip / 79 INV / build ✓）。
2. **零翻案**：8 项 watch/NO-GO/红线全部维持，全部对标数据同日实拉无方向性变化。
3. **新热点零合格项**：实拉 + recency 扫描未出现 round3 清单外的新开源机制面；唯一「疑似新动向」（crawl4ai 1.x）经 PyPI 核实为 npm 同名包陷阱，排除。
4. **候选调优项：0 条**——本域连续第二轮空集，且本轮空集是**验收轮独立复核**（新做 mutation + 新拉数据）后的空集，非沿用 round3 结论。round3「search 域率先归零 → 汇入 ROUND-CLEAN」的预期在本域成立；若全局其余域同样验收通过，本轮应汇入 ROUND-CLEAN 并按 round3-verdict 附则一执行发布收口（v1.13.0 一次性 commit + npm publish，当前 npm latest=1.10.0 已积压三轮用户可感知改进）。

> 候选轨迹对照：round1 3 条 → round2 3 条 → round3 0 条 → **round4 0 条（验收确认）**。收敛非调研不充分——本轮白盒 + mutation + 三源数据实拉均已执行。
