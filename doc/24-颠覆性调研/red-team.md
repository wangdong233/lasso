# 24-颠覆性调研 · red-team：论证现行搜索层设计是错的

> 红队调研员 · 2026-08-17。授权依据：doc/23 制度修复 #3「红队翻案权」——**明确豁免「无新证据不得翻案」约束**，唯一任务是论证现行设计是错的。
> 证据基座：四份 scan 文档（model-native / agent-api / mcp-proto / edge）+ 白盒读码（src/tools/search.ts、src/search/ 全部、src/serp/ 全部、src/channels/ 四个搜索通道、src/fallback/ 全部）+ git 考古（42 commits）。
> 纪律：每条论证附**可反驳的具体证据**（源码行号/数据/日期）并**自我标注最脆弱一环**。红队不代表平衡——平衡是主循环的职责。
> 结论级别：R = 本仓库实据（行号可查）；S/C = 沿用四份 scan 的来源标注。

---

## 0. 白盒证据清单（先摆数字，再论证）

| 维度 | 数值 | 出处（R） |
|---|---|---|
| 搜索层直接源码 | **4,623 行**（tools/search.ts 783 + src/search/ 980 + src/serp/ 1,904 + 4 个搜索 channel 956） | `wc -l` 实测 |
| 加搜索专属 config/runtime | ≈ **5,500 行 / 全 src 34,322 行 = 16%** | providers.ts + quota-ledger.ts + provider-registry.ts + CallerTierTracker.ts + rpm-limiter.ts 的搜索专属部分 |
| 搜索专属测试 | **17 文件 / 5,941 行**（import src/search、src/serp、tools/search 者）/ 全测试 38,937 行 = **15%** | grep 实测 |
| 不变量占用 | check-invariants.mjs 79 个 INV 中 **14 个（18%）** 捆在搜索机器上（INV-2/10/11/38/45/46/47/51/54/55/57/58/59/72） | grep 实测 |
| git 带宽 | 42 commits 中 **12 个（29%）** 触碰搜索层；**最近两个 feature release（v1.14、v1.15）100% 是搜索层工作** | `git log -- src/search src/serp src/tools/search.ts ...` |
| 爬虫债管理机器 | SelectorRegistry 118 + ChangeDetection 130 + HitRateStats 82 + SerpHealthMonitor 168 + replay-baseline 286 + RecordingStore 259 = **1,043 行**，唯一职责是管理 SERP 漂移/封锁 | `wc -l` 实测 |
| 降级链全长 | machine_mcp → zhipu → brave → serp_http → browse_headless → recording_replay（6 档） | FallbackChain.ts:60-64 + search.ts:647-663 |

---

## 1. 论证一（最强）：六层链在真实部署里是「一家厂商 + 一组当天还活着的爬虫」——多引擎冗余是名义资产，维持名义资产的边际成本已吞噬项目主要工程带宽

### 1.1 链的前两档是同一个上游

白盒事实（R）：

- `MachineMcpSearchChannel.ts` 文件头自述：「**与 ZhipuSearchChannel 同形（McpClient.connectHttp + callTool web_search_prime）**，区别在 key 来源」——tier-0（machine_mcp）和 tier-1（zhipu）调的是**同一个 open.bigmodel.cn 的 web_search_prime 工具**，仅 key 来源不同（~/.claude.json 探测 vs Lasso config）。
- 后果分两支：
  - 若两把 key 属同一智谱账号（单用户的典型情形）：tier-0 额度耗尽 → tier-1 **必然同样失败**。这不是 fallback，是 retry。
  - 若是两个账号（如 CC 侧 Coding Plan key + lasso 侧按量 key，S：qwen-code 文档证实 Coding Plan 捆绑 web-search-prime 100-4000 次/月）：tier-1 是真实的第二配额池——但**仍是同一厂商**。bigmodel 故障 / web_search_prime 降级 / 该工具被智谱改版（S：Perplexity sonar-reasoning 2025-12-15 说死就死的同款风险，scan-model-native §4）时两档**同时阵亡**，零厂商级冗余。

**链的「多引擎」故事从第 2 档就已经结束**。6 档里真正的厂商多样性 = 1 家 API 厂商 + 爬虫。

### 1.2 第 3-6 档：不是资产，是当天快照

- **brave 档（tier-2）对本目标用户大概率未实例化**：Brave 免费档 2026-02 取消、$5/1k、需绑卡（S：doc/21 verdict 官方页亲取；scan-model-native §6.1 表）。CN+代理用户绑美卡的比例趋近零。`BraveChannel.isAvailable()` 只查 key 存在——没有 key，这一档在 channelOrder 里形同虚设。
- **serp_http / browse_headless 档**：对本网络的白盒实测状态（extract.ts:12-18 自述，2026-08-17）：DDG html 端点**两次实测 202 挑战**；百度对无 cookie 裸 HTTP **302 → wappass 验证码**（http-serp.ts:313-320）；brave SERP「同日两次 200 各 ~20 条」——**今天活着，无 SLA，一次反爬升级即死**。
- **recording_replay 档**：把**过去录的同 query fixture 标成 worked 返回**（search.ts:740-765）。对 freshness 敏感的查询，这是用诚实的标签（`served_by="recording_replay"`）运输陈旧数据。第六档的存在本身说明：链的设计目标已经从「拿到好答案」退化为「outcome 必须等于 worked」。

### 1.3 冗余价值从未被故障频率证明过

scan-model-native §6.1 ④ 自己承认（引用 doc/23 纪律）：「**多引擎冗余的价值要用真实故障频率证明，不能用架构美感证明**」。仓库里有 SerpHealthMonitor、HitRateStats、benchmark 脚本，但**没有任何一处文档发布过生产环境的分层命中率/触发频率**。「六层链」的全部价值论证至今停留在架构图层面——这正是 doc/23 检讨过的病，只是这次病灶在资产侧而不是缺陷侧。

### 1.4 成本侧：这个名义资产吃掉了什么

16% 源码、15% 测试、18% 不变量、29% 的 commits、**最近 100% 的 feature 带宽**（v1.14 搜索方案重审 + v1.15 Bing 清除与 serp_http，均为 2026-08-17）。而同期：scan-edge 评出**颠覆性=高**的「本地个人数据搜索」（整类缺口、macOS 竞品真空=Rewind 已死/Recall 不上 mac、成本趋零）一行代码未动。搜索层不是在贡献可靠性，是在**挤占唯一有真空红利的方向**。

### 1.5 该论证最脆弱的一环

**我没有生产环境分层触发数据**——如果 doctor/serp_health 快照显示 tier-2+ 每天真实救场且结果可用，论证一的 1.3 节塌掉一半（但 1.1 同厂商事实与 1.2 爬虫时效性事实不依赖该数据）。其次：tier-0/1 的 key 是否同账号未经亲验（一条 `lasso doctor` + 比对 config key 即可裁决，成本 5 分钟）；若确为双账号，tier-1 保留理由从「假冗余」升为「真配额池」（厂商级相关故障仍在）。第三，npm 公开发行意味着存在非本用户的使用者配置（brave key 持有者），单用户视角可能低估服务面——但项目红线自称「单用户场景」，这个矛盾本身应交用户裁决而非默认扩张。

---

## 2. 论证二：搜索层是一组「对抗性运营契约」，项目已可证明地在这类契约上失败过两次且无制度防复发——继续持有等于承诺一种已被证伪的维护能力

### 2.1 已发生的两次失败（不是假设，是履历）

doc/23 事实清单（R，用户亲历）：**Brave 免费档 2026-02 取消、Bing API 2025-08-11 退役，两项搜索供应商运营事实滞后数月才被发现，且都由用户撞墙揭穿，五轮最优性审查 + doc/21 重审全部漏过**。搜索供应商的事实漂移不是尾部风险，是这层的**常态工况**。

### 2.2 这层绑定了几份独立漂移契约（白盒枚举）

| 契约 | 漂移方式 | 当前防御 | 防御的实绩 |
|---|---|---|---|
| 智谱 web_search_prime 响应 JSON 形状 | `parseZhipuContent` **任何解析失败静默返 []**（SearchChannel.ts:216-238）→ unknown → 逐档降级到爬虫 | 无（形状漂移与「真零结果」不可区分） | 未被测试过——智谱改一次字段名，lasso 将带着症状不明的降级跛行数月，与 Brave/Bing 同款潜伏 |
| brave SERP HTML（SvelteKit） | 反爬/改版 | SelectorRegistry+ChangeDetection+SerpHealthMonitor | 2026-08-17 verify 亲证两起漏网：font-face CSS 被当结果「**20/20 全垃圾**」（http-serp.ts:154-160）、百度「**worked+17 条 hao123 垃圾**」（:313-320）——机器全绿、人工才抓到 |
| ddg html 端点 | IP 级 202 挑战（当日实测） | 级联到 brave | 当日有效，结构上无解 |
| 百度无 cookie 行为 | 302→wappass / 首页壳 200 伪成功 | 终态 URL 形状校验（v1.15 verify 补） | 2026-08-17 当天补的——说明发布前机器闸门没拦住 |

四份契约×持续对抗。对比：browse/desktop 绑定的 CDP / AXAPI 是年度级慢漂移契约。**搜索层的维护成本结构与其他通道不同类**，却占用了同一份（而且是最大份）工程带宽。

### 2.3 「escalation-safe error naming」——框架在和自己的用户打架

白盒发现的结构性病症（R）：fallback 控制流依赖**错误字符串子串匹配**——`outcome.ts:104-112` 的 NOT_FALLBACK_WORTHY_PATTERNS = `["404","not_found","403","forbidden","nxdomain","enotfound","needs_manual_2fa"]`。于是 http-serp.ts:29-33 被迫发明一整套「error 不许内嵌原始状态码/DNS 原文」的命名纪律，**因为任何 error 文本里碰巧含 "403" 子串（如某个 URL、某个字节数）就会终止整条链**。一个需要下游模块绕开自身语义才能正确工作的框架，是控制流通道设计错误的直接证据：六档异构链把语义分类塞进了有损的字符串信道。

### 2.4 该论证最脆弱的一环

L-OP（运营契约维度 + 90 天时效纪律）是 v1.14 已落地的制度修复，且 doctor #36 / doctor 的 serp_health 快照是现成监测面——蓝队可主张「复发条件已变」。我的再回应：L-OP 覆盖**定价类事实**，不覆盖响应形状漂移与反爬姿态变化（parseZhipuContent 的静默 [] 至今原样）；且 2.2 表中「机器全绿、人工才抓到」的两起事故都发生在 L-OP 落地**之后**的 v1.15 verify。制度修了，机制没修。

---

## 3. 论证三：输出契约把价值钉死在 2023 年的 U1（蓝链），且「worked 即成功」没有质量轴——链越深答案越差，架构把这幅降级诚实地标成 worked（availability theater）

### 3.1 类型层的化石

`types.ts` 的 SearchResult = `{title, url, snippet, source?}[]`。scan-agent-api 的零基分析（U1-U4）已论证 2026 年的价值单位是**grounding 上下文对象**（查询相关内容块），而 Brave LLM Context（p90<600ms、单跳、$5/1k 同 key）、Exa highlights（token 降 10×）都是现成形态。四份 scan 的 R1 GO（BraveChannel 加 context 模式）实际上已承认主契约过时——但作为「补一个模式」提出。红队加压：**这不是模式问题，是地基问题**——InteractResult<SearchResult>、cache key（engine+region+limit+freshness）、channel 签名全部按蓝链浇筑，context 模式要么造假塞进 snippet 字段，要么连锁重构。修 R1 的真实成本被「加个模式」的措辞低估了。

### 3.2 tri-state 没有质量轴，「永不失败」靠降级到垃圾达成

tri-state（worked/didnt/unknown）诚实区分了可用性，但 **worked 不区分「智谱 API 十条干净结果」和「正则从 brave SERP 快照里刮的 ±80 字符上下文 + 前一行当标题」**（extract.ts:263-317——URL 正则 + 前一非空行取标题，作者自注「v0.1 简化版」）。白盒事故记录（2.2 表）证明垃圾态真实发生且被标 worked。用户视角：问题没有失败，只是**悄悄变差了**——比失败更难察觉，恰是 doc/23「体验侧信号没有入口」的病根在资产侧的镜像。

### 3.3 「正确 2026 形态」的具体主张

证据支持的形态是**「厂商原生（tier-0）+ 一层探针 + 质量显式降级标注」**，不是六档无差别链：machine_mcp 复用（厂商 MCP 是吸收曲线的正确骑乘姿势，scan-model-native G-1）→ 一层 keyless 探针（serp_http，~1s）→ 结果按**质量等级**显式标注（`quality: api|scrape|stale`），scrape/stale 档建议 CC 自行复核而非当作等价答案。删：brave 档（目标用户不实例化）、recording_replay（陈旧当 worked 违反诚实红线的精神）、以及随之瘦身的 1,043 行债管理机器。多跳二跳（fetch_feed，scan-edge GO；LLM context 模式，scan-agent-api R1）优先于任何引擎增补。

### 3.4 该论证最脆弱的一环

**CC 本身就是 agent 循环**：蓝队可主张「返回蓝链让 CC 自己选源+fetch 是 token 上更优的控制点，8192-token grounding 上下文直接灌进 CC 反而更贵」（scan-agent-api 自己在 Brave 风险段写了这点），且 Perplexity 式合成答案与 CC 推理链重复（scan-model-native §4 同判）。这个反驳对 3.1 的「该返回内容」成立——但注意它**加强而非削弱** 3.2/3.3：若蓝链+CC-fetch 已是最优形态，那搜索层的存量价值就更薄（论证一），维持六档的复杂性支出更无理由。两分支都指向收缩，红队接受任一分支。

---

## 4. 不立案声明（红队纪律）

- **角度②「Lasso 该做 deep research 循环」：不立案。** CC 本体就是 research loop；在 MCP server 里再造 agent 循环 = scan-edge §1.3 判给 browser-use 的同款「库内套 agent」因子分解错误。
- **角度④「MCP sampling 重建 VLM/抽取」：不立案。** scan-mcp-proto 已三角证伪（2026-07-28 spec SEP-2577 弃用 + CC changelog 5163 行 0 次 + 特性矩阵 ❌）。无新证据重开庭即违反我自己的认识论。
- **角度③「整个删除搜索层，CC 自带 WebSearch」：部分立案、修正后并入论证一。** 完整删除在 CC-on-relay 场景不成立（原生 WebSearch 结构性不可用，四源交叉，scan-model-native §1）——但该论据护住的只是「至少一个搜索工具存在」，护不住六档链。删到什么厚度是决策文档的事。

---

## 5. 若红队胜出：目标形态草案（决策文档级，交用户裁决）

| 动作 | 内容 | 量级 |
|---|---|---|
| 裁决前置（5 分钟） | doctor #36 + 比对 machine key 与 ZHIPU_API_KEY 是否同账号 → 决定 tier-1 去留 | 观测 |
| 删 | brave 档默认参与（改 opt-in 显式 engine）、recording_replay 的 search 用途、SelectorRegistry/ChangeDetection/HitRateStats/replay-baseline 中随爬虫面收缩而死的部分 | 净删约 1,000-1,500 行 + 对应测试 |
| 改 | worked 增加 `quality: api\|scrape` 显式轴（scrape 档 CC 可见可拒）；error 分类从子串匹配改为结构化 error code（`{kind, status?}`），消灭 escalation-safe naming 这种自卫纪律 | 中 |
| 建（优先级反转） | fetch_feed（scan-edge GO）＞ Brave LLM Context 模式（scan-agent-api R1）＞ local search 通道决策（scan-edge §2） | 增量小而明确 |
| 保 | FallbackDecider/tri-state/attribution/machine_mcp tier-0（这些是被四份 scan 外部效度证明的部分） | 0 |

---

## 6. 来源与证据索引

| # | 声称 | 来源 |
|---|---|---|
| R1 | tier-0/1 同上游 web_search_prime、仅 key 来源不同 | src/channels/MachineMcpSearchChannel.ts 文件头 + SearchChannel.ts:197-205（R） |
| R2 | isFallbackWorthy 子串匹配 + escalation-safe 自卫 | src/fallback/outcome.ts:104-120 + src/serp/http-serp.ts:29-33（R） |
| R3 | parseZhipuContent 静默吞解析失败 | src/channels/SearchChannel.ts:216-238（R） |
| R4 | 爬虫档垃圾事故（20/20 font-face、17 条 hao123、wappass、DDG 202） | src/serp/http-serp.ts:150-160,313-320 + src/serp/extract.ts:12-18（R，2026-08-17 verify 亲证） |
| R5 | 抽取器 = URL 正则 + 前一非空行取标题（自注「v0.1 简化版」） | src/serp/extract.ts:236-317（R） |
| R6 | allocateLimit 无据字面量 1000/2000 直到 v1.14 才修 | src/tools/search.ts:407-408 注释（R） |
| R7 | recording_replay 以 worked 返陈旧 fixture | src/tools/search.ts:740-765（R） |
| R8 | 规模数据（4,623 行/16%、5,941 测试行/15%、14/79 INV、12/42 commits、v1.14+v1.15=100% 搜索） | 本轮 wc/grep/git 实测（R） |
| R9 | Brave 免费档 2026-02 取消/$5/1k/绑卡；Bing 2025-08-11 退役；五轮审查+doc/21 全漏、用户揭穿 | doc/23 事实清单 + scan-model-native §6.1（S/R） |
| R10 | 原生搜索 $10-14/1k vs 专用 $1-5/1k；Gemini 3 SimpleQA 72.1%；Sonar 模型高 churn；Coding Plan 捆 100-4000 次/月 | scan-model-native §1-5 及其来源索引（S/C） |
| R11 | U1-U4 框架、Brave LLM Context p90<600ms 单跳、Exa highlights 10×、AIMultiple 四家统计不可分 | scan-agent-api §0/§1/§2 及来源索引（S/C） |
| R12 | 本地搜索整类缺口（Rewind 死/Recall 不上 mac）颠覆性=高；fetch_feed GO | scan-edge §2/§4（S/C） |
| R13 | sampling 弃用 + CC 0 支持；Playwright #1 结构化抽取范式 | scan-mcp-proto ①/⑦ 及来源索引（S） |

*红队备忘：本文所有「最脆弱一环」均为诚实的可反驳点——请主循环优先打那里，而不是打论证里已经被证据钉死的部位。*
