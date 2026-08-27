# verdict — 24-颠覆性调研终局裁决（2026-08-18）

> 裁决官程序：①通读六份输入（四 scan + zero-base + red-team）；②对载荷最重的声称逐条抽验——白盒读源码 / 官方页亲拉 / 本机状态亲查，**拒采信无证据项**；③分级 D-GO / D-DECISION / D-WATCH / D-NOGO；④必答四问。
> 抽验记录（非转述，全部亲验）：SearchCache.ts TTL 常量与 freshness 入 key 不入 TTL；BraveChannel endpoint 钉死 `/res/v1/web/search`、全 src 无 `llm/context`；markdown-extractor 零 `query` 入参；elicitation / rss / fetch_feed 全 src grep 零命中；outcome.ts:104-112 子串匹配表；SearchChannel.ts:216-238 parseZhipuContent 静默返 `[]`；MachineMcpSearchChannel 文件头自述与 zhipu 同上游；search.ts:740-765 replay 以 worked 返陈旧 fixture 且**不写缓存**（replay 不污染 cache——red-team R7 的最坏版本不成立，但单次陈货风险成立，本轮已修）；Brave LLM Context API 官方博客 webReader 全文亲读（$5/1k 同计划、p90<600ms、token 预算制、smart chunks——2026-06-25 更新版）；本机 `~/.claude.json` 有 web-search-prime 的 headers.Authorization（tier-0 活），Lasso 侧 ZHIPU_API_KEY / BRAVE_API_KEYS 均未配置（Brave 档对本机未实例化）；本轮两次调本机 web-search-prime 查 Brave 相关英文查询返回 `"[]"`，无法区分真空 vs 形状漂移——red-team R3 可观测性缺口的现场演示。
> 结论级别：V = 裁决官本轮亲验；S/C/R/E 沿用六份输入的原标注。

---

## 0. 首行摘要

**DECISION: {D-GO 3 项（已实施+门禁全绿）/ D-DECISION 3 份决策文档 / D-WATCH 8 项 / D-NOGO 9 项}**

---

## 1. D-GO（小而明确，本轮已实施）

| # | 项 | 内容 | 验收 |
|---|---|---|---|
| D-GO-1 | **ZB-3 缓存新鲜度耦合 + replay 新鲜度门** | `effectiveTtlMs`：freshness=day 的缓存 TTL 从 7 天收紧到 24h（week/month/year 与不传 freshness 保持 byte-identical）；全源熔断时 recording_replay 按 freshness 窗口拒过期 fixture（replay 键不含 freshness，此前 day 查询可回放数月前录像标 worked） | 5 个新单测（day 2 天前过期 / day 12h 内命中 / week 6 天命中 / month 6 天命中 / 不传零回归）+ 2 个新集成测（day+3 天前 fixture 拒回放 / day+2h 内正常回放），全绿 |
| D-GO-2 | **ZB-4 fetch_feed 原语** | 新工具：RSS / Atom / JSON Feed → 结构化条目（title/url/published/summary≤500 字符）。零依赖手写解析器（截断容忍：只认完整块 + 全内容 feed 头字段抢救）；content-type 路由表追加 `application/(rss\|atom\|feed)+xml → text`（此前落 binary base64）；经 ssrfGuard + doFetchUrl（INV-56 家族）；独立 tool 不进 search 链（wayback 同范式） | 17 个新单测全绿 + **真机双源验证**：GitHub claude-code releases.atom → worked，2025ms，5 条版本条目全对；ruanyifeng 全内容 atom（73KB/3 条）→ 头字段抢救出最新一期，758ms，truncated_input=true 诚实标注 |
| D-GO-3 | **ZB-9 文档级生态建议** | README 新增 fetch_feed 用户段 + 「生态搭配：建议另装 Grep by Vercel 官方 MCP（免费，100 万+ 仓库真实用法）——Lasso 不内置，各干各的活」；版本 1.15.0 → 1.16.0（INV-63 三处 + 测试 pin 同步） | README 用户向内容 + 版本断言测试更新后全绿 |

**收尾门禁（全绿，2026-08-18）**：`npm run build` ✓；`npm test` 126 文件 / **2031 passed** + 1 skipped（基线 2007，净增 24 测）；`check-invariants` **79/79** ✓。
实施清单：`src/search/SearchCache.ts`、`src/tools/search.ts`（replay 门）、`src/tools/fetch-feed.ts`（新）、`src/tools/descriptions.ts`、`src/tools/annotations.ts`、`src/browse/content-type-router.ts`、`src/index.ts`（装配+channel map）、`README.md`、`package.json`/`src/index.ts`/`src/doctor/doctor.ts`（版本三处）、`test/unit/search-cache.spec.ts`、`test/unit/fetch-feed.spec.ts`（新）、`test/integration/search-fallback-chain.test.ts`。

**实施纪律说明**：任务书「默认不改代码，小而明确才实施」。三项均满足判据——D-GO-1 是纯正确性修复（~15 行核心 + 测试）；D-GO-2 是纯增量新工具不触任何既有路径；D-GO-3 是文档 + 版本号。ZB-1（Brave LLM Context）虽被 zero-base 排第 1，但**本机无 Brave key（亲验）且中文质量/8192-token 占用两点前置验证未做，收益本轮不可验证**——降级为 D-DECISION（决策文档 A 的 A3，含前置条件），这是裁决官对「小而明确」的从严执行，不是否决其价值。

---

## 2. D-DECISION（大方向，三份决策文档交用户裁决）

| # | 决策 | 文档 | 核心问题 |
|---|---|---|---|
| D-DECISION-A | 搜索层形态：grounding 上下文 + 质量显式化 + 链收缩 | decision-search-layer.md | 投资从第一跳（引擎冗余，已 16% 源码）转向第二跳（拿内容，至今 0 投资）？worked 加 `quality: api\|scrape\|stale` 轴？error 子串匹配改结构化？tier-1 同账号 5 分钟裁决前置 |
| D-DECISION-B | 本地私有数据搜索（ZB-5） | decision-local-search.md | 整类缺失 + macOS 竞品真空（Rewind 死/Recall 不上 mac）+ FTS<10ms/$0——但并入 Lasso（第四通道）还是独立 MCP（边界纯净）是价值排序，只有用户能排；含「先观察两周再建」的 B3 选项 |
| D-DECISION-C | 交互面升级：elicitation + 交互句柄（ZB-6/ZB-7） | decision-interaction-upgrade.md | HighRiskGate 从「中断重来」升级「回合内确认」（CC v2.1.76+ 已支持，须 capability 降级零 bug）；抽取产物带 ref 句柄使「读→点」不断链（Playwright #1 范式外部效度）。安全关键路径，值得独立实施轮 |

---

## 3. D-WATCH（条件触发，不立项）

| # | 项 | 触发条件 |
|---|---|---|
| W1 | Gemini 3 grounding 第二机器源（5k/月免费） | CN 可达性实测过 + 出现厂商多样性需求（智谱单点故障真实发生一次） |
| W2 | r.jina.ai 免费抽取兜底（ZB-8） | 真机观察到 headless 11s 冷启动成为高频痛点 + CN 可达性验证；做成独立 tool 不触 INV-23 |
| W3 | MCP SDK v2 迁移（2026-07-28 stateless 时代） | SDK v1 弃用倒计时公告，或需要 ttlMs 缓存/新传输特性；挂账清单已存 scan-mcp-proto §8.2 |
| W4 | CC Channels 推送（desktop 值守） | research preview 转 GA（allowlist 解除） |
| W5 | MCP Tasks 长任务协议 | CC changelog 出现支持条目 + Lasso 出现真 >1min 工具化长任务 |
| W6 | Exa 语义通道重评 | 关键词引擎在真实查询上失效的案例积累（描述性/概念性查询「搜不到」的实证） |
| W7 | 分层命中率观测 | decision-A 的 P0：无论是否收缩，先给降级链各档加触发计数（这是 red-team 论证一最弱环的根治——让「多引擎冗余价值」可用数据证明或证伪） |
| W8 | 智谱/Qwen/Kimi 搜索单价补证（S-缺口） | 下一轮 L-OP 90 天时效核查顺带 |

---

## 4. D-NOGO（明确拒绝，防 FOMO）

| # | 项 | 拒绝理由 |
|---|---|---|
| N1 | MCP sampling（server 借 client LLM） | 协议 2026-07-28 弃用（SEP-2577）+ CC 5163 行 changelog 零支持，双负；现行 LASSO_VLM_ENDPOINT 恰是官方建议路径——现状即正确（scan-mcp-proto ①，S 级三角验证） |
| N2 | Tavily 接入 | 同价位被 Brave 统计显著压制（aimultiple 唯一显著差距）、无独占能力；生态默认不构成证据（幸存者偏差禁令的正向应用）。providers.ts 的 TAVILY_WATCH 占位保持 enabled=false 不动 |
| N3 | 搜索即回答主路径（Perplexity Sonar 形态） | CC 自己是综合模型；外包综合注入外部模型错误（zero-base M1，Exa WebCode correctness ~86% 聚集证明差异在 groundedness 不在综合） |
| N4 | 自建代码搜索/索引 | Grep by Vercel 官方 MCP 免费存在（100 万+ 仓库），自建=负价值；已按「认不建」落 README 建议（D-GO-3） |
| N5 | 常驻 RSS 聚合（Miniflux/RSSHub 进 Lasso） | 守护进程红线 C7；fetch_feed 已覆盖无状态形态，且天然兼容外部聚合产物（feed URL 不变） |
| N6 | 截屏式全量记忆（Recall 形态） | 2015 Intel MBP 资源否决 + 简单架构红线（C6+C7） |
| N7 | 自建 GUI agent 框架（browser-use 形态） | CC 已是 agent，库内套 agent 是因子分解错误（scan-edge §1.3）；只借 snapshot-ref 表示法（decision-C 的 C2） |
| N8 | P2P/去中心化检索（IPFS/Arweave） | 检索层生态未解决（「存了搜不到」），对信息获取零贡献；Wayback 已覆盖抗删除主场景 |
| N9 | streamable HTTP server 传输 | 单用户本机场景 stdio 是 CC 官方推荐；HTTP 化收益（多客户端共享）为伪需求，代价是端口/鉴权/守护三座复杂度。翻转条件唯一：统枢 ONE 类多客户端挂载需求真实出现 |

---

## 5. 必答四问

### 问一：模型原生搜索进化下，Lasso 搜索层的护城河还剩什么（诚实）

按强度排序，四条，每条附侵蚀条件（诚实包括承认护城河会塌的部分）：

1. **CC-on-relay 结构性替代（最强）**：原生 WebSearch 绑定第一方 Anthropic 认证，所有 OpenAI 兼容中转（new-api→GLM 类）无法服务 Anthropic 专用 server tool（四源交叉，C 级）。本用户主力环境即此——**这条护城河对本用户不是理论，是日常**。侵蚀条件：CC 把 WebSearch 改客户端执行（计费模型不允许，概率低）或用户回归官方订阅（对个人而言随时可能——这是必须诚实承认的单一脆弱点）。
2. **成本与计费形态控制（中强）**：原生 $10-14/千次 + 内容 token 放大（OpenAI ~8k token/次注入）vs 专用 $1-5 vs serp_http/browse ¥0。且智谱按 token + Coding Plan 附赠 100-4000 次/月，CC 订阅内原生「免费」的对照在此场景不存在（relay 用户已在按 GLM 计费）。
3. **CN/全球引擎混布 + 归因（中）**：US 原生搜索对 CN web 覆盖差（doc/governance/02 实测双向验证码）；served_by/结构化结果/引擎选择是黑盒原生给不了的。残余价值诚实说：这是「策略层」价值，不是「质量」价值——Gemini 3 SimpleQA 72.1% SOTA 后「专用搜索质量更好」在英文顶端已不成立（S 级）。
4. **零 key 免费兜底（中）**：serp_http ~1s / browse_headless ¥0 无认证——全市场除 Gemini 5k/月外无第二家。但本轮白盒+实测加一个诚实减分：爬虫档是**当天快照**（DDG 202 挑战 / 百度 wappass / brave SERP 无 SLA），且 worked 无质量轴时它以「悄悄变差」形态参与（decision-A 的 A1 即修此）。

**已经不剩的（诚实清单）**：①「多引擎」故事——tier-0/1 同上游同工具（文件头自述，V 级），Brave 档本机未实例化（V 级），厂商级多样性=1 家 API + 爬虫；②「取 10 条蓝链」的独立价值——模型原生+fetch+推理已覆盖，Claude 动态过滤连 token 效率都在原生层解决；③质量差异叙事（见上）。**终局定位**：搜索策略层（认证拓扑/配额治理/归因/降级）而非引擎集合——这与「简单架构红线」不冲突（薄封装），但意味着未来投入应走 decision-A 的诚实化+第二跳方向，而非再加引擎。

### 问二：零基 diff 里有几个本质缺失

zero-base 列 ZB-1..ZB-7 七项缺失，裁决后**维持 5 项本质缺失 + 2 项降为部分缺失**：

| 判定 | 项 | 说明 |
|---|---|---|
| 本质缺失①（本轮已修一半） | ZB-3 TTL×freshness + replay 陈货 | 正确性缺陷非能力缺失，但「本质」当之无愧——freshness 语义此前是假的（day 查询可拿 7 天陈货 / 陈年录像） |
| 本质缺失② | ZB-4 fetch_feed（本轮已修） | I3 推模型原语整层不存在 |
| 本质缺失③ | ZB-1+ZB-2 融合检索与查询裁剪（合为一项） | 第二跳（拿内容）零投资：两跳 11s 级 + 全页 10-50k token 浪费 5-10×。red-team 3.1 说得对——这不是「加个模式」是契约级重构，故合为一项交 decision-A |
| 本质缺失④ | ZB-5 本地私有搜索 | 整类缺失 + 竞品真空（scan-edge 颠覆性评「高」是六份输入里唯一的「高」）；价值密度可能高于任何对外搜索优化，但属范围裁决（decision-B） |
| 本质缺失⑤ | 质量轴 + 结构化错误（red-team 论证二/三的机制层） | zero-base 未单列但裁决官认定：parseZhipuContent 静默 []（形状漂移不可辨）+ worked 无质量轴 + 子串匹配控制流，三者合起来是「诚实性」的本质缺口——Lasso 的 tri-state 红线在最深处没有兑现 |
| 降为部分缺失 | ZB-6 elicitation、ZB-7 句柄 | 能力以更弱形态存在（中断式升级 vs 回合内；底层 ref 透传 vs 自产句柄）——是体验断层不是能力真空（decision-C） |
| 维持合理取舍 | ZB-8 jina、ZB-9 垂直检索 | 取舍论据成立；ZB-9 文档欠账本轮已清（D-GO-3） |

**关键修正**：最大本质缺失按用户价值排序是 **ZB-5（本地）而非 ZB-1（搜索）**——red-team 论证一的带宽指控在此成立：最近 100% feature 带宽投向的搜索层，其待办（ZB-1）需要 Brave key 前置；而真空红利的 ZB-5 一行未动。这是资源分配的元发现，交 decision-A/B 一并裁决。

### 问三：红队哪个论证站得住

三条逐一裁决（裁决官已逐条抽验证据）：

| 论证 | 裁决 | 依据 |
|---|---|---|
| **论证二（对抗性运营契约 + 无制度防复发）：完全站得住** | 事实层全亲验为真：子串匹配表（outcome.ts:104-112）、escalation-safe 自卫纪律（http-serp.ts:29-33 注释）、parseZhipuContent 静默 []（SearchChannel.ts:216-238）。履历层（Brave 2026-02 免费档取消 / Bing 2025-08-11 退役，滞后数月用户撞墙揭穿）是 doc/governance/04 用户亲历档案。**机制批评成立**：一个需要下游绕开自身语义才能正确工作的框架（error 里碰巧含 "403" 子串即断链）是控制流设计错误的直接证据。L-OP 修了定价类事实，没修形状漂移与反爬姿态——「制度修了，机制没修」的再回应也成立 | V+S+R 级 |
| **论证一（六层链名义资产 + 带宽吞噬）：事实站得住，处方待数据** | 1.1 同上游（文件头自述，V 级）与 1.2 爬虫当天快照（白盒+本轮 "[]" 实测）为真。1.3 自己承认最弱环——无生产分层触发数据，**删 brave/replay 的处方超出了证据**（链的价值是保险，保险不能用未发生理赔证伪；但 red-team 要求「发布命中率数据否则别拿架构美感论证」的诉求本身正当——已落为 W7 观测项）。1.4 带宽数据（16%/18%/100%）量级亲验属实。**裁决：事实采纳，删除处方交 decision-A 的 A4 且前置 P0 观测** | V+R 级，处方降级 |
| **论证三（蓝链化石 + availability theater）：事实站得住，方向二选一** | 3.1 契约浇筑（V 级）与 F4（Brave LLM Context 亲读）为真；3.2 垃圾标 worked 两起事故是 v1.15 verify 档案（R 级）。但红队自己的「最脆弱一环」必须认真对待：**CC 本身是 agent 循环——蓝链+CC 自选源+fetch 可能就是 token 上更优的形态**（此时 8192-token grounding 灌入反而更贵）。红队对此的反驳（「若蓝链已最优则存量价值更薄」）逻辑成立但两分支都通向收缩的推演不必然——第三分支存在：蓝链形态正确 + 链深作保险 + 质量轴修诚实，正是 decision-A 的最小路径 A1+A2。**裁决：3.2 全采纳（A1 已列入 decision-A 首位）；3.1 的方向选择交用户（A3 需 Brave key 前置验证）** | V+S+R 级，处方二选一 |

**不立案声明复核**：红队自己的三个不立案（deep research 循环 / sampling 重建 / 整层删除）裁决官全部维持——sampling 尤其是本次调研最有价值的**负**结论（N1，防了一次三头不支持的投资）。

### 问四：L-COST 视角当前链还有倒挂吗

**有，四处，其中两处本轮已修**：

| # | 倒挂 | 状态 |
|---|---|---|
| 倒挂①（最大） | **第二跳倒挂**：全链延迟/成本的大头在「拿内容」（API 命中后英文路径仍要 11s 冷启动 headless 才有正文），而 16% 源码投在第一跳引擎冗余（厂商多样性实际=1）。L-COST 对照：Brave LLM Context p90<600ms/单跳/8192-token 预算制 vs 现状两跳（搜索 ~1-2s + 内容 11s） | 未修（decision-A A3，前置 Brave key） |
| 倒挂② | **token 倒挂**：全页 markdown 10-50k token vs 查询相关裁剪 1-3k，浪费 5-10×；extract_mode 三档均无 query 入参（V 级） | 未修（decision-A A3 配套件 ZB-2） |
| 倒挂③ | **freshness 倒挂**：freshness=day 的查询——缓存层可拿 6 天前的「过去一天」（已修：24h TTL）；链尾 replay 可拿数月前录像标 worked（已修：窗口门）；且至今无推模型原语（已修：fetch_feed——2025ms/条目级/零索引滞后，对照 SERP 索引滞后小时~天级） | **本轮已修**（D-GO-1/2） |
| 倒挂④ | **维护成本倒挂**（元层）：四份对抗性运营契约（智谱响应形状/brave SERP HTML/ddg 端点/百度行为）占最大工程带宽，而 zero-base 评出的最高价值缺口（本地搜索）零投入——投入产出方向相反 | 未修（decision-A P0 观测 + decision-B 裁决，本 verdict 的分级清单即再分配方案） |

**现金成本序本身无倒挂**（免费/套餐层先于付费层，serp_http/browse ¥0 兜底殿后）——倒挂全部在**时间、token、新鲜度、带宽**四个非现金维度，这与「单用户 + 免费额度充足」的约束一致，也指明了优化方向不是换引擎而是修第二跳与诚实性。

---

## 6. 方法论对账（doc/governance/04 纪律执行情况）

- **零基视角**：生效。最大产出是问二的排序修正（本地 > 搜索第二跳 > 引擎层）——该排序在「与对标项目比」框架下不可见。
- **L-COST 附件**：生效（问四四倒挂全部带数字；fetch_feed 真机延迟亲测入表）。
- **幸存者偏差禁令**：正向应用两次（N2 Tavily、N4 自建代码搜索）；反向应用一次（Playwright #1 的 snapshot 范式作为外部效度佐证而非「大家都这样」的证据——scan-mcp-proto ⑦ 的原始论证方式被保留）。
- **证据纪律**：本轮拒采信项——zero-base §1.2 占比表（E 级，仅作排序不作数字）；scan-edge 的 star 数（二手，不影响任何裁决）；「Brave 免费额度需绑卡」沿用 doc/governance/02 S 级但标注未复核绑卡环节。裁决官新增亲验 12 项（见文件头抽验记录）。

## 7. 来源与验证索引（本 verdict 新增部分）

| # | 声称 | 来源 | 级别 |
|---|---|---|---|
| V1 | SearchCache TTL 常量 / freshness 不入 TTL / INV-11 key 构成 | src/search/SearchCache.ts 亲读 | V |
| V2 | Brave endpoint 钉死 web/search、无 llm/context；extractor 零 query；elicitation/feed 零命中 | 全 src grep 亲验 | V |
| V3 | outcome 子串匹配表 / parseZhipuContent 静默 [] / escalation-safe 注释 / MachineMcp 同上游自述 / replay 返 worked 且不写缓存 | outcome.ts:104-112 / SearchChannel.ts:216-238 / http-serp.ts:29-33 / MachineMcpSearchChannel.ts 头 / search.ts:740-765 亲读 | V |
| V4 | Brave LLM Context 存在及全部参数（$5/1k 同计划、p90<600ms、maximum_number_of_tokens、smart chunks 五类、$5/月赠送需 attribution） | brave.com/blog/most-powerful-search-api-for-ai webReader 全文亲读（2026-06-25 更新版） | S（亲读） |
| V5 | 本机 tier-0 活（web-search-prime 有 Authorization）/ Lasso 侧 zhipu+brave key 均未配 | ~/.claude.json 探测 + ~/.lasso/env 亲查（不回显 key 值） | V |
| V6 | 本机 web-search-prime 对两个英文 Brave 查询返 "[]"，真空/漂移不可辨 | 本轮两次实测（2026-08-17/18） | V（单例，已如实标注不可定性） |
| V7 | fetch_feed 真机表现（GitHub atom 2025ms 全对 / ruanyifeng 73KB 全内容 feed 抢救路径 758ms） | 本轮实施后 node 直调亲测 | V |
| V8 | 门禁终态：test 2031 passed + 1 skipped（126 文件）/ INV 79/79 / build ✓ | 本轮收尾亲跑 | V |
