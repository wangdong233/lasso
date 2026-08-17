# 24-颠覆性调研 · scan-model-native：搜索被吸收进模型 API 的曲线走到哪了

> 调研员：model-native 范式 · 2026-08-17
> 方法论纪律（doc/23）：零基视角（用户要什么，不是「与 Lasso 对比」）；每条关键声称带来源；附成本/延迟数据（L-COST）；**禁止**把「开源项目都这样做」当最优证据。
> 结论级别标注：S = 官方页/文档亲取；C = 社区多源交叉；R = 本仓库实据。

---

## 0. 一句话结论

**吸收曲线在 API 层已经完成**：OpenAI 把搜索从 Chat Completions 整体撤出、只留 Responses API 内置 `web_search` 工具（preview 模型 2026-07-23 关停）；Gemini 搜索是请求级 flag（grounding）；Claude 是 server tool；Perplexity 生来 search+answer 一体；国内 GLM/Kimi/Qwen 全部有模型原生联网。**但对 Lasso 的实际威胁被三个结构事实对冲**：①CC 走第三方中转（new-api→GLM）时原生 WebSearch 整体不可用（结构性，见 §6.1）；②原生搜索单价 $10-14/千次且叠加内容 token 计费，是专用搜索 API 的 2-8×（§7）；③原生搜索是单厂商黑盒，无引擎归因/无区域控制/无降级链（§8）。Lasso 搜索层的价值不是归零，而是**从「引擎集合」收缩为「策略层」**：机器厂商 MCP 复用（tier-0 已做）+ 中转场景 + 成本上限 + CN/全球引擎混布 + 归因。

---

## 1. Claude / Anthropic（CC 内置 WebSearch/WebFetch = Lasso 搜索层的直接替代品）

### 机制（S：platform.claude.com 文档 / claude-api skill 亲读）
- API 形态：server-side tool，声明即用。最新 `web_search_20260209`（**动态过滤**：Claude 自己写代码在结果进入上下文前过滤——厂商已在原生层攻击 token 效率问题），支持 `max_uses`/`allowed_domains`/`blocked_domains`/`user_location`。旧模型用 `web_search_20250305`。
- **平台不对称**（S）：Bedrock ❌ 无 web search；Vertex 仅 basic `web_search_20250305`（无动态过滤）；web fetch 不上 Vertex。第一方 API 全量。
- `web_fetch_20260209`：只抓会话中已出现的 URL，**不计费**（metered 字段恒为 0，S）。
- CC 内置工具：Agent SDK 文档明列 built-in `WebSearch`/`WebFetch`（S）。CC 的 WebSearch 走 Anthropic 服务端搜索链路——**不是模型能力，是官方 API 的专用 web_search 工具调用链**（C：linux.do/cc-switch#2570 分析）。

### 定价（S）
- **$10 / 1,000 次搜索**（Managed Agents 预算条款原文 "web searches at $10 per 1,000"）；搜索结果内容同时按模型输入 token 计费。
- CC 订阅内 WebSearch 点用免费（不向用户按次收费）。

### 质量口碑
- 动态过滤（20260209）是 2026-02 新增，官方卖点即 accuracy + token 效率（S）。CC WebSearch 的工具描述至今写着 **"only available in the US"**；GitHub issue #33314 实测报告该地域限制描述**失实/过时**，非美用户实际可用，且该文案导致模型自我降权不用 WebSearch（C：anthropics/claude-code#33314）。

### CC（终端 agent）场景可用性（C：多源交叉）
- **官方订阅/官方 API：可用且免费点用**——这是 Lasso 搜索层最强替代品。
- **第三方中转（ANTHROPIC_BASE_URL 指向 new-api 等网关桥接 GLM）：WebSearch 整体不可用**。中转站不支持 Anthropic 专用 web_search 工具链，报 "web search is not enabled"；CN 社区标准解法即「换 MCP 搜索工具或 curl+grep」（C：知乎专栏 2012819798686454483、linux.do/t/topic/2053873、cc-switch#2570、cc-haha#228）。**本用户日常 CC 即走 new-api→GLM——原生 WebSearch 在其主力环境里根本不存在。**

---

## 2. OpenAI：Responses API 内置搜索 / Deep Research

### 机制（S：developers.openai.com）
- 搜索现为 **Responses API 内置 `web_search` 工具**：`tools:[{type:"web_search"}]`，模型自主多轮搜索+浏览+引用。
- **吸收完成的标志性事件（S）**：Chat Completions 上的 `gpt-4o-search-preview`/`gpt-4o-mini-search-preview` 已弃用，**2026-07-23 关停**；Assistants API 2026-08-26 sunset。搜索在 OpenAI 侧已无「非 Responses」路径。
- Deep Research：Responses API 异步任务（webhook 回调），返回整份研究报告。

### 定价（S + C）
- 内置 web_search：**$10 / 1,000 次调用**（现行 flat；历史上 reasoning $10 vs 非 reasoning $25 两档已并轨）+ **每次搜索注入约 8k 输入 token 按模型输入价计费**——社区高频吐槽「57 次调用 119 次搜索、账单远超预期」（C：openai community/1236954）。旧 search-preview 曾为 $30-50/千次。
- Deep Research：o3-deep-research $10/$40 每 1M token，**单任务实际成本可到 ~$30**（Artificial Analysis 估）；o4-mini-deep-research $2/$8，约 5×便宜（C）。

### 质量口碑
- 搜索质量本身口碑好；计费透明度是主要骂点（隐式多搜 + 内容 token 双重计费，C）。

### CC 场景可用性
- 与 CC 无直接集成（OpenAI 无对应 CC 形态的免费点用）；作为 CC 子代理的外部搜索源需走 API 计费，单次调研 $0.5-30 量级——**不适合高频终端 agent 循环**。

---

## 3. Gemini grounding / Deep Research

### 机制与定价（S：ai.google.dev/gemini-api/docs/pricing 亲取摘要）
- grounding = 请求级开关（`tools:[{google_search:{}}]`），搜索由 Google 索引执行，结果带回引用。
- **Gemini 3**：每月 **5,000 次免费**搜索，之后 **$14 / 1,000 查询**；注意计费单位是 query——单请求可触发多次计费查询。
- Gemini 2.5：1,500 次/天免费（共享额度），付费 **$35 / 1,000 请求**。→ Gemini 3 把 grounding 单价砍了 60%，且给了所有 API 用户 5k/月免费——**这是全市场唯一的「原生搜索免费额度」**。
- Deep Research Max：官方称可经单次 API 调用获得（C：MindStudio 转述）。

### 质量口碑（C）
- Gemini 3 Pro SimpleQA Verified **72.1% SOTA**（前代 54.5%，Google Blog），FACTS 基准 68.8% 居首（DeepMind）。**参数化事实性已是第一**——但 BrowseComp/WebVoyager 等浏览代理基准仍分散（GPT-5.6/Kimi K3/Claude Opus 5 轮替，Gemini 3 未统摄，C：BenchLM 2026 汇总）。第三方搜索 API 榜单里 Linkup 自称 92% 相关性超各家内置搜索（R 级：厂商自评）。
- 解读：**「原生搜索质量不如专用搜索」的旧假设在顶端已失效**；残余质量差异在 CN 内容覆盖与引擎可控性。

### CC 场景可用性
- 无 CC 集成；作为外部源走 Gemini API。5k/月免费额度是唯一值得 CC 工具链利用的原生搜索免费资源。

---

## 4. Perplexity Sonar API（search+answer 一体）

### 机制与定价（S/C：docs.perplexity.ai）
- 单次调用返回带内联引用的**合成答案**而非链接列表——「搜索即回答」范式的完整形态。
- Sonar：~$1/$1 每 1M token + **~$5/1,000 搜索请求**；Sonar Pro：$3/$15 + $5-14/1k（OpenRouter 列 $18/1k）。请求费与 token 费并行。
- **模型高 churn（S：官方 changelog）**：sonar-reasoning 2025-12-15 已移除；**base Sonar 支持至 2026-09-27**（一个多月后）。API 层活跃但模型名寿命短——作为依赖需持续迁移。

### 质量口碑
- 引用质量与综合能力是标杆；但近期第三方对比中相关性不再独占鳌头（Linkup 自评 92% 居首，R 级）。

### CC 场景可用性
- OpenAI 兼容端点，可挂进网关；但产出是「答案」不是结构化结果，终端 agent 里等于把综合判断外包——与 CC 自身推理链重复。

---

## 5. 国内：模型原生搜索（GLM / Kimi / Qwen）

### 智谱 GLM（R+S）
- **web-search-prime MCP**：`open.bigmodel.cn/api/mcp/web_search_prime/mcp`（本仓库 KEY-GUIDE/benchmark 实据）——智谱把自家搜索**以 MCP 形态直接发给 agent 生态**，CC 用户普遍已直配它（Lasso 的 machine_mcp 层就是复用该配置）。
- glm-4-assistant 提供**代理式浏览器搜索**：模型自发 `web_browser` 的 msearch（多 query 生成）→ mclick（多页点选）→ 合成（S：docs.bigmodel.cn 文档亲读，返回流含完整工具调用轨迹）。
- 计费：按 token + 新用户赠送额度（KEY-GUIDE 2026-08-17 控制台亲历核实）；确切每千次单价本次未获官方数字，**S-缺口：需控制台亲历补**（国产联网搜索 API 市场区间 ¥4.8-30/千次，见下）。
- **套餐捆绑（S：Qwen Code 官方文档转述）**：GLM Coding Plan 直接含 web-search-prime 额度（Lite 100 / Pro 1,000 / Max 4,000 次/月）——**模型厂商已在把搜索当订阅附赠品**，与 CC 订阅含 WebSearch 同一范式。注意红线（R：KEY-GUIDE）：Coding Plan key 绑定工具白名单，不能挪用。

### Kimi / Moonshot（S+C）
- API 内置 `$web_search`（formula_uri `moonshot/web-search:latest`）：模型只生成搜索参数，搜索由 Moonshot 执行并综合（S：platform.kimi.com 文档）。
- 联网搜索费 **~¥0.03/次 ≈ ¥30/千次**（C：UniFuncs 价格解析，非官方页直取）——处于市场高位，量级≈$4/1k。

### Qwen / 阿里百炼（S+C）
- `enable_search` 请求级开关，模型内置；与百炼 MCP 广场的联网搜索 MCP 是两个独立产品（S：help.aliyun.com/zh/model-studio/web-search）。
- 历史单价 ~¥0.01/次 ≈ ¥10/千次，无免费额度（C，需重核）。

### 解读
国内三家全部完成「搜索进模型 API」：形态上比美国侧更激进——智谱直接发 MCP、按 token 计费、套餐送量。**CN 原生搜索的吸收曲线也已完成，且它就是 Lasso 链条的 tier-0（machine_mcp）**。

---

## 6. 颠覆性裁决：Lasso 多引擎链的价值收缩到什么？

### 6.1 不会被吸收掉的结构性护城河（按强度排序）

**① CC-on-relay 场景（最强，且在扩大）**。原生 WebSearch 的可用性绑定**第一方 Anthropic 认证**；所有 OpenAI 兼容中转（new-api 类）无法服务 Anthropic 专用 server tool。CN 大量 CC 用户走网关桥接国产模型——这个人群里「CC 原生搜索」不存在，MCP 搜索是唯一正解（C：四源交叉）。只要 CC + 国产模型网关的组合存在一天，Lasso 的搜索层就有一天结构性需求。本用户自己就是该场景。

**② 成本上限与计费形态控制（中强）**。L-COST 对比（每千次搜索的现金成本，不含内容 token）：

| 引擎 | 成本/千次 | 免费额度 | 计费形态 |
|---|---|---|---|
| Claude 原生 web_search | $10 | CC 订阅内点用免费 | 按次 + 内容 token |
| OpenAI Responses web_search | $10 | 无 | 按次 + ~8k token/次（隐式放大） |
| Gemini 3 grounding | $14（2.5 代 $35） | **5k 次/月** | 按 query（一请求多 query） |
| Perplexity Sonar/Pro | $5-14(+token) | 无 | 按请求 + token |
| Brave（Lasso 链内） | $5 | 2026-02 起无免费档，$5/月赠送≈1k 次、需绑卡（R：doc/21 verdict 官方页亲取） | 按次 |
| Kimi 原生 | ~¥30（≈$4） | 无 | 按次 |
| Qwen enable_search | ~¥10（≈$1.4） | 无 | 按次 |
| 智谱 web-search-prime | 按 token + 赠送额度（单价待核） | 新用户额度 | 按 token |
| Lasso serp_http / browse_headless | **¥0** | 无限 | 无 key 免费兜底（R） |

原生搜索集中在 $10-14/千次 + 内容 token 放大；专用/国产引擎 $1-5/千次 + 免费兜底。**高频 agentic 循环（单会话几十次搜索）下差距是 3-10×**。但注意诚实的反面：CC 订阅用户原生搜索点用免费——成本护城河只对 API 计费/无订阅用户成立。

**③ CN/全球引擎混布与内容覆盖（中强）**。US 原生搜索对 CN web 索引差（本仓库 doc/21 verify 实测：零 key 英文路径 DDG/brave 双验证码；反向同样成立）；原生搜索不可指定引擎/区域/归因。Lasso 返回结构化结果 + `served_by` 归因（R：types.ts），策略可编排。

**④ 多源冗余与降级链（中）**。原生搜索是单厂商黑盒：厂商限流/故障时无处可退。Lasso 六层链（machine_mcp→zhipu→brave→serp_http→browse_headless→replay）+ 熔断器是架构性的可用性资产。但注意方法论纪律：**「多引擎冗余」的价值要用真实故障频率证明，不能用架构美感证明**——doc/23 已教训过。

**⑤ 零配置零 key 路径（中）**。serp_http（~1s）/browse_headless 免费无 key——没有任何原生搜索提供无认证免费路径（除 Gemini 5k/月）。

### 6.2 正在被吸收掉的部分（诚实清单）

- **「取 10 条蓝链接」层**：模型原生搜索+fetch+推理已完整覆盖该职能，且动态过滤（Claude 20260209）连 token 效率都开始在原生层解决。
- **「搜索+抽取+摘要」管线**：Perplexity 范式（一次调用出带引用答案）已是一行参数。凡 Lasso 内部若有「为模型预处理搜索结果」的逻辑，其价值都在转移给模型本身。
- **质量差异叙事**：Gemini 3 SimpleQA 72.1% SOTA 之后，「专用搜索 API 质量更好」在英文顶端不成立。残余差异只在 CN 覆盖与可控性——这两点恰好是 Lasso 的 ②③。
- **智谱自发 MCP 的挤压**：厂商直接把搜索 MCP 发进 CC 生态（machine_mcp 层），Lasso 自有 zhipu channel 的独立价值被压薄为「没配 machine MCP 时的补位」。

### 6.3 价值收缩的终局形态

Lasso 搜索层不应再被视为「六个引擎的集合」，而应明确为**「搜索策略层（policy over search）」**，四个不可吸收的职责：
1. **认证拓扑适配**：CC-on-relay 场景下替代不可用的原生工具（结构性）。
2. **成本/配额治理**：QuotaLedger + free_only 路由 + 千次价差 3-10× 的路由决策（含「何时该建议用户直接用 Gemini 5k 免费额度」这类策略）。
3. **引擎选择与归因**：CN/全球混布、served_by 透明度、结构化结果（原生黑盒给不了）。
4. **可用性兜底**：降级链 + 熔断（单厂商原生搜索给不了）。

而引擎本身——尤其 zhipu/brave 两个 key 型通道——是**可替换的商品**。这与「简单架构红线」不冲突：策略层恰恰是薄封装，不是引擎堆叠。

---

## 7. 对 Lasso 的行动含义（本轮只调研，不实施）

1. **G-1（低成本 GO 候选）**：machine_mcp（智谱自发 MCP）维持 tier-0 不变——本调研证实这是正确方向：厂商 native MCP 是吸收曲线的正确骑乘姿势。
2. **G-2（观察项）**：Gemini API 5k 次/月免费 grounding 是全市场唯一原生免费额度；若未来加「第 2 机器厂商 MCP」候选，Google 的 free tier 值得单独评估（涉及 CN 网络可达性，需实测）。
3. **风险登记（不行动，仅记录）**：
   - 若智谱 Coding Plan 捆绑搜索量持续加码（100→4000/月），免费用户会被吸走到厂商直配——Lasso 的差异化必须落在策略层四职责，不落在「也提供一个搜索」。
   - 若 CC 上游把 WebSearch 改为客户端执行（本地 fetch 而非 server tool），中转场景护城河 ① 会被侵蚀——监控 CC changelog 即可，概率低（计费模式不允许）。
   - Perplexity base Sonar 2026-09-27 EOL：若 Lasso 文档/对比中提及 Sonar 需同步（当前未提及，无动作）。
4. **S-缺口（下轮补证）**：智谱 web-search-pro 每千次确切单价（控制台亲历）；Qwen enable_search 现行单价；Kimi ¥0.03/次 的官方页直证。均属 L-OP（定价类，90 天时效纪律）。

---

## 附：来源索引

| # | 声称 | 来源 |
|---|---|---|
| S1 | Claude web_search $10/1k、web_fetch 不计费、Bedrock/Vertex 不对称、20260209 动态过滤 | platform.claude.com 文档 + claude-api skill 官方参考（2026-06 缓存） |
| S2 | OpenAI Responses web_search $10/1k + 内容 token；search-preview 2026-07-23 关停；Assistants 2026-08-26 | developers.openai.com/api/docs/pricing + /guides/tools-web-search + /deprecations |
| S3 | Gemini 3 grounding $14/1k、5k/月免费；2.5 代 $35/1k、1500/天 | ai.google.dev/gemini-api/docs/pricing（搜索快照亲取） |
| S4 | Sonar 定价 + sonar-reasoning 2025-12-15 弃用 + base Sonar 2026-09-27 EOL | docs.perplexity.ai/docs/getting-started/pricing + /resources/changelog |
| S5 | Gemini 3 Pro SimpleQA 72.1% / FACTS 68.8% | blog.google + deepmind.google（转引，C 级置信） |
| S6 | 智谱 web_browser msearch/mclick 代理式搜索 | docs.bigmodel.cn/cn/guide/tools/web-search（webReader 亲读） |
| S7 | GLM Coding Plan 含 web-search-prime 100/1000/4000 次/月 | qwenlm.github.io/qwen-code-docs（官方文档转述） |
| S8 | Kimi $web_search（moonshot/web-search:latest）+ ~¥0.03/次 | platform.kimi.com/docs + UniFuncs（价格 C 级） |
| S9 | Qwen enable_search 内置、与 MCP 搜索独立、~¥0.01/次 | help.aliyun.com/zh/model-studio/web-search（价格 C 级） |
| C1 | CC WebSearch 走 Anthropic server tool 链、中转站不可用、社区以 MCP 搜索替代 | 知乎 2012819798686454483、linux.do/t/topic/2053873、cc-switch#2570、cc-haha#228（四源交叉） |
| C2 | CC WebSearch "US only" 描述失实但导致模型降权 | anthropics/claude-code#33314 |
| C3 | OpenAI 搜索账单超预期（隐式多搜 + 内容 token） | community.openai.com/t/1236954 |
| C4 | Deep Research 单任务成本 ~$30（o3） | Artificial Analysis 估（C 级） |
| R1 | Lasso 链条/成本/Brave 2026-02 免费档取消 $5/千次 | 本仓库 doc/21-搜索方案重审/verdict + KEY-GUIDE（2026-08-17 核实）+ src/benchmark/run-ab-benchmark.ts |
