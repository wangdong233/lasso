# Round 3 复审：搜索与内容抽取域（search 链路 + MarkdownExtractor）

日期：2026-08-17 ｜ 调研员：Round-3「搜索与内容抽取」｜ Lasso 基线：**v1.12.0 工作树**（round2 T2-1..T2-14 已实施并经 round2-review03 zero-issues-pass）

复审范围（按任务书）：①第 1/2 轮全部调整是否达最优（本域 = round1 T6 freshness / T9 DDG 兜底 + round2 T2-3 defuddle URL 透传 / T2-4 separateMarkdown / T2-5 freshness 补全——白盒抽验新代码 + 独立 mutation）；②上两轮 watch/NO-GO 是否有**新证据**翻案；③全新热点。门禁本轮亲跑：build ✓ / **1940 passed + 1 skipped**（基线 1906 → round2 +35）+ **79 INV 全绿** ✓。

---

## 0. 结论速览

| 维度 | 结论 |
|---|---|
| ① 两轮调整落地质量 | **全部达最优**。本域 5 项（T6/T9/T2-3/T2-4/T2-5）逐行白盒 + 独立 mutation kill + 门禁亲跑全过 |
| ② watch/NO-GO 复核 | **零翻案**。7 项 watch/NO-GO 全部维持；其中 2 项获**新证据加固**（firecrawl + Kindly 双数据点反证融合边界） |
| ③ 全新热点 | defuddle YouTube transcript / Kindly（372★ 新项目）/ web2md 生态——**均不构成本域调优项**（各有明确红线或门槛不满足理由） |
| **候选调优项** | **0 条**（空集是本轮正确结论——本域两轮清偿后已收敛） |
| 非阻断观察 | 2 条 XS 级记档（§4，均低于调优项门槛，不立项） |

---

## 1. 本域热度与版本动向实拉（2026-08-17，GitHub API 经代理 + npm registry）

| 项目 | 实拉数据 | 与 Lasso 的关系 |
|---|---|---|
| **kepano/defuddle** | 8,992★ ｜ npm latest **0.19.2**（2026-07-22，无新版）｜ pushed 08-03 ｜ 新动向：**YouTube transcript 支持**（kepano 官宣，走 async extractor 第三方 fetch）+ 官网/托管服务上线 + 被 obsidian-skills 打包为 agent skill | Lasso lockfile 已 0.19.2 = latest（rider 落地确认）；YouTube 走 useAsync 路线被 Lasso 钉死禁用（SSRF 红线，`markdown-extractor.ts:116-117` 注释在案）——**无动作** |
| **firecrawl** | 168,153★ ｜ pushed 08-16 ｜ changelog 08-13：v1.15「Life Sciences」垂直域扩张 | 融合范式（search+scrape 一体）继续纵向深化、无结构性变化；继续反证 INV-58 边界（§3-R8） |
| **microsoft/markitdown** | 174,080★ ｜ pushed 07-29 | 本地文件域不变，INV-68 排除维持 |
| **unclecode/crawl4ai** | 78,364★ ｜ pushed 08-15 | 0.9.x 稳定性补丁线；markdown 范式（pluggable generator + Pruning/BM25）无变化；R2 触发条件仍无案例 |
| **Aas-ee/open-webSearch** | 1,714★ ｜ pushed 08-14（持续活跃） | T9 对标锚点（DDG 端点 + selector 三件套）未被上游改动；DDG 基础不变 |
| **Shelpuk…/kindly-web-search-mcp-server** | **372★**（新项目）｜ pushed 07-29 ｜ Reddit r/LocalLLaMA 2026-08 热帖 | **本轮唯一值得展开的新对标**，见 §2-3 |
| sweetcornna/free-search-mcp | 51★（零增长）｜ pushed 08-06 | 上轮 watch 项，热度证据不变 |
| jina-ai/reader | 11,873★ ｜ pushed 05-22 | 无动向，round1 结论维持 |
| DDG SERP 基础设施 | 2026-08 文档共识：`html.duckduckgo.com` 仍可用但 202/403 软限频持续 | 与 round1 风险评估一致（兜底定位 + SerpHealthMonitor 可观测是正确形态） |

---

## 2. 任务①：两轮调整是否达最优（白盒抽验 + 独立验证）

### 2-1. round2 三项逐行抽验（本域主战场）

| 项 | 源码锚点（本轮实读） | 抽验方法与结果 | 判定 |
|---|---|---|---|
| **T2-3 defuddle URL 透传** | `markdown-extractor.ts:118` `Defuddle(html, opts.url ?? "", {...})`；两调用点 `fetch-url.ts:279`（rawUrl）/ `BrowseChannel.ts:876`（evaluate_script 返回的 parsed.url——543 行 quickSnapshot 同款对象） | **独立 mutation**：`opts.url ?? ""` → `""` 后 T2-3 测试红（「站点 extractor 激活 + 相对链接绝对化」断言失败），还原后 24/24 绿——测试真钉行为，非摆设。`useAsync:false` 钉死 + 注释写明 SSRF/超时预算理由（红线成文） | **最优** |
| **T2-4 separateMarkdown 接管** | `markdown-extractor.ts:119,124,147-152`：`contentMarkdown` 直接接管，`|| null` 缺失降级 turndown（:143 `articleHtml ?? html` 全页保底），turndown 抛错路径保留（:158）；raw 档早返不经 defuddle（:96-98，INV-66 面） | 表格 fixture 断言 `\| --- \|` GFM separator；降级语义测试（served_by 二值集合）；markdown_cited 角标在 T2-4 产物上仍生效（管线顺序 :162-168 不变）；Obsidian 方言接受 + README 注明（裁决书要求） | **最优** |
| **T2-5 freshness 补全** | ① `MachineMcpSearchChannel.ts:54,141-144`：opts.freshness + callTool `search_recency_filter`（**import ZHIPU_RECENCY_MAP 单一事实源**，非复制映射表）；② `serp/extract.ts:70-97`：DDG_FRESHNESS_DF d/w/m/y + baidu 不拼（诚实降级注释成文）；③ riders：SerpHealthMonitor 注释 ddg（:66）、descriptions.ts:506-507 llms.txt TIP、lockfile 0.19.2 | **全路径 5/5 透传逐一核验**：fanout zhipu（search.ts:418）/ fanout brave（:426）/ 单源 zhipu/brave（:461/:469）/ fallback_chain machine_mcp（:627）/ zhipu（:636）/ brave（:644）/ bing（:654）/ 两条 serp 路径（:436/:474/:661）。三组单测含「不传 byte-identical」（df= 不拼 / search_recency_filter 键缺席） | **最优**（freshness 从主链 3 引擎到全部 5 路径语义一致，round2 候选 3 的承诺全部兑现） |

### 2-2. round1 两项主链复核（抽样确认未被 round2 改动破坏）

- **T6 freshness 主链**：schema（search.ts:104，enum 4 值 optional 无 default）+ SearchCache key 含 freshness + INV-11 修订——round2-review03 mutation 已实证，本轮读取现状一致。
- **T9 DDG 兜底**：CJK/非 CJK 分流（extract.ts:55-64）+ uddg 解包（:183-192）+ F5 region 诚实（:231-234）——现状一致；上游 open-webSearch（08-14 活跃开发）未改动端点与 selector，对标锚点未漂移。

### 2-3. 本轮唯一新对标展开：Kindly（为什么它不构成调优项）

Kindly 的差异化 = **站点官方 API 内容解析器**（StackExchange API / GitHub Issues+Discussions 经 GITHUB_TOKEN / arXiv / Wikipedia API）返回完整对话（问题+答案+评论+reactions）+ nodriver Chromium 通用兜底 + search+content 单调用融合。逐门检验：

1. **「GitHub issue 全对话」无决定性差距**：本轮白盒实读已装 defuddle 0.19.2 `dist/extractors/github.js`——GitHubExtractor **原生处理 `/issues/\d+` 与 `/pull/\d+`**（canExtract 按 issue/PR 两套 DOM 标记门控，extract 走 extractComments/getIssueContent/getPRContent），且该能力**经 T2-3 已在 Lasso 激活**。Kindly 的 API 路线（绕反爬、结构化）与 defuddle DOM 路线（零 token 配置、零新依赖）在本场景收益相当。
2. **加 API 解析器破两条红线**：需 GITHUB_TOKEN 新配置面（单人+AI 维护面扩大）+ fetch_url 内按 URL 形状魔法分派新数据路径（违背 fetch 零 fallback 设计 / INV-23 精神，同 llms.txt 自动探测否决理由）。
3. **其融合形态反证 Lasso 边界**：Kindly 默认工具预算 **120s**、浏览器池预热 + 并发 3 限流 + Windows 冷启动超时频发（README troubleshooting 自述）——正是 round1 #12 否决的「tool 内隐藏成本不可控」实证样本。**NO-GO 项（R8 融合）获第二个独立数据点加固**。
4. 处置：**watch**——若未来出现「GitHub issue/长对话页 DOM 抽取在高频站点系统性截断」的真实案例（与 R2 Pruning 触发条件同型），再评估 API 侧通道（届时也应作为独立 tool 而非 fetch_url 内分派）。

**结论（任务①）**：本域两轮全部调整（T6/T9/T2-3/T2-4/T2-5）**已达最优**——白盒无残余缺口、测试真钉（mutation kill）、红线成文（useAsync/df/baidu 诚实降级）、复用正确（ZHIPU_RECENCY_MAP import）。

---

## 3. 任务②：watch/NO-GO 复核（无新证据不翻案）

| 项 | 上轮处置 | 本轮新证据核查 | 结论 |
|---|---|---|---|
| R2 PruningContentFilter port | watch（触发：≥3 个 defuddle 抽取失败/超 envelope 真实站点案例） | 无新案例；且 T2-4 已拿下更基础的转换保真杠杆（表格/数学/LaTeX），其目标版式（文档站/表格密集页）正是 Pruning 针对的场景——短板已部分消除 | **维持 watch** |
| Mojeek/Startpage 第二免费兜底（free-search-mcp 路线） | watch（51★ 不足为据；待 SerpHealthMonitor 积累 ddg miss 率） | free-search-mcp 仍 51★ 零增长（08-17 实拉）；**本机无 SerpHealth 运行时数据积累**（无持久化目录）——触发条件未满足且无证据方向性变化 | **维持 watch** |
| You.com 等零 Key 远程源填 L3 | watch | 无新证据；machine_mcp 仍覆盖零配置场景 | **维持 watch** |
| llms.txt / `.md` 自动探测 | NO（提示级） | 提示已落地（descriptions.ts:506-507 TIP）；无新证据支持自动化 | **维持 NO** |
| schema-based 结构化抽取 tool | NO | 无新证据；CC 即 schema 执行器（evaluate_script）逻辑不变 | **维持 NO** |
| markitdown | 排除（INV-68 本地文件域 + 禁 spawn python） | 174k★ 但域不变 | **维持排除** |
| R8：SearXNG 自托管 / search+scrape 融合 / fetch 升级梯 | NO-GO | **新证据加固**：firecrawl 融合继续纵向深化（08-13 垂直域）+ Kindly 融合的成本面实证（120s 预算/浏览器池/并发限流）——云端与自托管融合派双双展示隐藏成本，Lasso「CC 按需编排」边界的反例证据反而更足 | **维持 NO-GO（加固）** |

---

## 4. 非阻断观察（记档不立项——均低于五门槛，典型为无对标锚点的微观项）

1. **TurndownService 无条件构造**（`markdown-extractor.ts:137`）：T2-4 后 defuddle 成功路径不再消费该实例，但仍每次调用构造（含规则集注册，亚毫秒级）。移入 else 分支是一行卫生，但无对标锚点、收益不可测级——按「宁缺毋滥」不立项，随手触碰该文件时顺带即可。
2. **SERP 兜底 20 条上限与 limit 无关**（`extract.ts:224` `results.length >= 20`）：limit=5 时兜底路径仍可能回 20 条 url+snippet（~1-2KB）。v0.1 既有行为、兜底路径低频、无上游对标锚点——不立项，记档。

---

## 5. 复审结论

1. **本域收敛**：两轮共 5 项调整（T6 freshness 全链 / T9 DDG 兜底 / T2-3 URL 透传 / T2-4 separateMarkdown / T2-5 freshness 补全）全部落地且达最优；白盒无残余缺口；独立 mutation kill 证实测试钉住行为；门禁亲跑全绿（1940+1skip / 79 INV / build ✓）。
2. **零翻案**：7 项 watch/NO-GO 全部维持，其中 R8 融合 NO-GO 获 Kindly 成本面新数据点**加固**。
3. **新热点全部正确停在红线外**：defuddle YouTube（useAsync 禁用红线）、Kindly API 解析器（配置面 + fetch 魔法分派红线）、web2md 生态（印证 defuddle 选型，无新机制）。
4. **候选调优项：0 条。** 本域符合「实施尾巴清偿后无新量级发现 → 循环自然终止」的健康收敛轨迹（round2-verdict §4 预期在本域成立）。若全局其余域同样收敛，本轮应汇入 ROUND-CLEAN。

> 与 round1（3 条候选）/ round2（3 条候选）对照：候选数 3 → 3 → 0，且本轮 0 非因调研不充分（热度实拉 + 新项目白盒 + 独立 mutation 均执行）——是差距真实清零后的空集。
