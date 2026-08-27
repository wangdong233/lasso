# parse24 —— 五项裁决实施计划（白盒确认官定案）

> 2026-08-18 · 依据用户裁决（逐字执行）+ doc/governance/05 三份 decision 文档 + 本轮 v1.16.0 全树白盒核验。
> 基线：v1.16.0（commit ef94685），**2032 tests（vitest list 实测 2031 条扁平计数）+ 79 INV（本轮 `npm run check-invariants` 实跑 All 79 passed）**。门禁：`npm run build && npm test && npm run check-invariants`，基线只增不减。
> rust-helper/ 原则零改（五项均不触，已核）。

---

## 0. 裁决输入（逐字）

| # | 裁决 | 实施项 |
|---|---|---|
| ① | A1 质量轴做 | §4 |
| ② | A2 付费不做，**自研等价**：拿到搜索结果后扫描分析解析出正文块（零付费依赖） | §3（A2′） |
| ③ | A3 **保留 machine_mcp（智谱 MCP 复用），删除 zhipu 直连 API channel** | §2 |
| ④ | B1 本地私有搜索并入 Lasso 做第四通道 | §5 |
| ⑤ | C1 elicitation + C2 抽取 ref 句柄都做 | §6 |

架构红线（全程守）：单 fallback 引擎（INV-4/55）；tri-state 诚实（fetch 失败如实跳过标注，不伪装）；**禁新增 npm 依赖**（Node 24 内建 `node:sqlite` / `node:child_process` 够用；本机 node v24.12.0 实证）；隐私红线（B1 只读、浏览历史只返 title/url/时间/标题片段，**禁全文导出**）；C1 安全路径必须有「clientCapabilities 未声明 elicitation → 100% 走现行 didnt」的测试钉死。

---

## 1. 锚点核验（先核验后定案；v1.16.0 重定位）

decision 文档的源码锚点逐项在当前树重定位。**结论：全部成立，两处漂移（一处目录迁移、一处 API 形态升级），不影响决策有效性，但实施按新锚点写。**

### decision-A（search-layer）

| 声称 | 原锚点 | v1.16.0 实测 | 状态 |
|---|---|---|---|
| F1 tier-0/tier-1 同 endpoint | MachineMcpSearchChannel.ts 文件头 + providers.ts:27 | MachineMcpSearchChannel.ts:3（「与 ZhipuSearchChannel 同形」）+ providers.ts:27 `open.bigmodel.cn/api/mcp/web_search_prime/mcp` | ✅ 原位 |
| F5 Brave endpoint 钉死、无 llm/context | providers.ts:96 | providers.ts:96 `api.search.brave.com/res/v1/web/search` | ✅ 原位 |
| F6 SearchResult 蓝链契约 | types.ts | types.ts:55-63 `{title,url,snippet,source?}`（INV-11 三层浇筑） | ✅ |
| F7 parseZhipuContent 静默返 [] | SearchChannel.ts:216-238 | SearchChannel.ts:216（函数起点行号不变） | ✅ 原位 |
| F8 isFallbackWorthy 子串匹配 | outcome.ts:104-112 | **目录迁移**：src/search/outcome.ts → **src/fallback/outcome.ts:104-119**（NOT_FALLBACK_WORTHY_PATTERNS 104-112 + isFallbackWorthy 114-119，行号基本不变） | ⚠️ 文件路径漂移 |
| F8b escalation-safe 命名 | http-serp.ts:29-33 | http-serp.ts:28-33 | ✅ 漂移 ≤1 行 |
| F9 worked 无质量轴 | — | InteractResult（types.ts:36-50）确无 quality 字段 | ✅ 仍成立 |

### decision-B（local-search）

| 声称 | 实测 | 状态 |
|---|---|---|
| F3 全 src 零命中 chrome history / apple notes / mdfind | 本轮 grep 复验仍零命中 | ✅ |
| Chrome History 路径（多 profile） | 本机实证 `~/Library/Application Support/Google/Chrome/Profile 1/History` 存在（Default 之外至少 1 个 profile） | ✅ 多 profile 是真实工况 |
| NoteStore.sqlite | 本机实证 `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite` 存在 | ✅ |
| node:sqlite 可用 | package.json engines `node>=20`；本机 v24.12.0（node:sqlite 自 22.5 起内建，24.x 稳定） | ✅ 零依赖红线可守 |

### decision-C（interaction-upgrade）

| 声称 | v1.16.0 实测 | 状态 |
|---|---|---|
| F1 HighRiskGate 命中 → didnt + StepEngine stop | StepEngine.ts:146-177（gate.blocked → manual_abort 分支）；grep 全 src 零命中 elicitation | ✅ 原位 |
| F4 click uid 是上游透传 | BrowseChannel.ts:899-912 doClick（uid 透传在 904-906，漂移 ≤3 行）；HighRiskGate.ts:203-204 data-lasso-uid 自注 | ✅ |
| F3 SDK ^1.30.0 支持 server 侧 elicitation | package.json:50 `^1.30.0`，node_modules 实装 **1.30.0** | ⚠️ **API 形态与 decision 文档描述不同**：不是裸 `server.request`，而是高层 `elicitInput()`（详见 §6.1——design 按 SDK 实测 API 定，不按文档猜测） |

**SDK 1.30.0 elicitation 实测形态（node_modules 亲读，C1 设计的唯一真源）：**

- 入口：`McpServer.server`（low-level `Server`，mcp.d.ts:18 `readonly server: Server`）→ **`server.elicitInput(params, options?): Promise<ElicitResult>`**（server/index.d.ts:158）
- params（form 档）：`{ mode?: "form", message: string, requestedSchema: { type:"object", properties: Record<string, 受限schema>, required?: string[] } }`。**requestedSchema 是受限类型集**（string/enum/boolean/number/integer/date/uri/email/date-time/array-of-enum），不再是任意 JSON Schema——这是 2026 elicitation 新形态，确认表单的 `decision` 字段用 `{type:"string", enum:[...], enumNames:[...]}` 表达。
- 返回：`ElicitResult = { action: "accept" | "decline" | "cancel", content?: Record<string, string|number|boolean|string[]> }`（types.d.ts:5381-5400）
- **能力守卫（server/index.js:351 实现亲读）**：`if (!this._clientCapabilities?.elicitation?.form) throw new Error('Client does not support form elicitation.')`——守卫的是**子能力 `elicitation.form`**（不只是 `elicitation` 键存在性）；同步 throw，不触网。能力预检可走 `server.server.getClientCapabilities()`（server/index.d.ts:121）。
- accept 内容校验：SDK 对 `action==="accept"` 且带 requestedSchema 的 content 自动 JSON-Schema 校验（index.js:356-369）。
- 超时：`RequestOptions.timeout`（默认 DEFAULT_REQUEST_TIMEOUT_MSEC=60s）+ `maxTotalTimeout`；超时抛 `McpError(RequestTimeout)`。

---

## 2. A3 影响面全清单（zhipu 直连 API channel 删除；照 v1.15 Bing 清除 INV-54 墓碑范式）

### 2.1 删除对象

| 对象 | 位置 | 处置 |
|---|---|---|
| `ZhipuSearchChannel` 类 | src/channels/SearchChannel.ts:72-262 | **整文件删除**（类是主导出；BingChannel.ts 同款先例） |
| `SearchChannel` 别名导出 | SearchChannel.ts:263/265 | 随文件删除（search.ts:46 type import 同步删） |
| `ZHIPU_RECENCY_MAP` | SearchChannel.ts:62-70 | **迁移不删**：MachineMcpSearchChannel.ts:38 import 它做 freshness 透传（machine_mcp 保留的硬依赖）→ 迁入 MachineMcpSearchChannel.ts 本文件（单一消费者，就近持有） |
| `SearchOpts` 接口 | SearchChannel.ts:44 | 若 machine_mcp 独立定义了自己的 opts 形则随文件删；否则同 ZHIPU_RECENCY_MAP 迁移 |
| `ZHIPU` ProviderConfig | providers.ts:24-43 | 删 + BUILTIN_PROVIDERS（providers.ts:121 数组）去 zhipu 项 |
| `ZHIPU_API_KEY` / `ZHIPU_ENDPOINT` 配置面 | config.ts:41-42/257/264/330-334/353-354/387-388 | **容忍读不消费**（照 BING_API_KEYS 先例，providers.ts:300-304 注释自述该模式）；doctor 新增静态退役提示 |

### 2.2 逐文件影响面（src，20 文件）

| 文件 | 处数 | 内容 |
|---|---|---|
| src/channels/SearchChannel.ts | 整文件 | 删（§2.1） |
| src/index.ts | 13 | `new SearchChannel(...)`（396-399）、runDoctor zhipu 参数（271-272）、`zhipu_key_present` 启动日志（364）、breakers map `["search.zhipu", ...]`（565）、longBreakers 列表（1026）、`initialCapabilities.push("search.zhipu")`（940）、链叙事注释（262/509/750） |
| src/tools/search.ts | 42 | engine enum `"zhipu"`（95）、fanout sources（411-428）、`canFanout`（328-334）、单源 target 三元（481-485）、executor `search.zhipu` 分支 ×2（493-500/681-688）、`zhipuAllowedByFreeTier`（292-294）、`buildFanoutRpmOptions` zhipuRpm（577-578）、registerSearchTool 第 2 参 `search: SearchChannel`（144）——签名变更 |
| src/config/providers.ts | 11 | §2.1 + 注释（8/100/139/314-322） |
| src/config/config.ts | 15 | §2.1；`zhipuApiKey/zhipuEndpoint` 字段删除，env 键保留默认值 |
| src/doctor/doctor.ts | 35 | **#2 `zhipu_api_key` 检查删**（865-873）、**#3 `zhipu_endpoint_reachable` 检查删**（876-893；注意 doctor.ts:1521 有对 #3 的语义引用注释）、`checkQuotaLedger` zhipuKey 参数（600/1355-1360）、opts（269-272）、1149「退化为单源 zhipu」文案、2637/2657 machine_mcp 降级提示文案改写；**新增 `zhipu_keys_retired` 静态退役提示**（照 #11c `bing_keys_retired` 先例：doctor.ts:588/1276-1290 的零触网范式） |
| src/search/FallbackChain.ts | 5 | `DEFAULT_FALLBACK_ORDER` 去 `"search.zhipu"`（69-73）+ 头注释链叙事（33-35） |
| src/search/MultiSourceFanout.ts | 3 | CJK langBoost `s.name.includes("zhipu")`（293）→ 见 §2.4 |
| src/search/MachineMcpDetector.ts | 3 | 头注释「降级到 search.zhipu」改写（6/13） |
| src/channels/MachineMcpSearchChannel.ts | 14 | ZHIPU_RECENCY_MAP 迁入 + 头注释「fallback 链自动降级到 search.zhipu」等失准叙事改写（15-16 行） |
| src/search/AttributedSearch.ts | 3 | 注释字面量示例改 `"search.machine_mcp"` |
| src/tools/descriptions.ts | 7 | SEARCH_DESCRIPTION：21（默认引擎描述）/42（enum 帮助）/46/53/57/67（'zhipu' 档描述删）/207（doctor 项清单） |
| src/types.ts | 5 | 注释（31/33/64/272 served_by 与 retrieval_method 示例） |
| src/serp/RecordingStore.ts / http-serp.ts / BaseChannel.ts | 3 | 注释级（http-serp.ts:10 链叙事「machine_mcp → zhipu → brave → …」） |
| src/fallback/PartialFailures.ts / BudgetTracker.ts | 3 | 注释级（扇出示例「zhipu worked / brave 429」→「machine_mcp worked / brave 429」） |
| src/observ/MetricsCollector.ts | 1 | 注释级（per-channel 维度示例） |
| src/config/provider-registry.ts | 1 | 注释级 |
| src/benchmark/run-ab-benchmark.ts | 19 | `ProviderName` 联合类型（99）、makeRealChannel zhipu 分支（181-189）、zhipuExec（366-368）、循环 ×3（231/254/283）——A/B 基准 zhipu 档删除，保 brave 单侧（或改 machine_mcp 基准，见 §2.5 测试段） |

### 2.3 枚举与链联动（决策定案）

1. **engine enum 定案：`["auto", "brave", "fallback_chain"]`（删 `"zhipu"` 值）**。
   - 替代方案（保 `"zhipu"` 作 machine_mcp 别名）**否决**：machine_mcp 的身份是「借机器 ~/.claude.json 的 key」（INV-72 的 key 拥有域划分），把它叫 "zhipu" 会抹掉「Lasso 自己的 key vs 机器 key」这条安全边界叙事；且直连档已死，留别名是对死层的语义寄生。
   - 破坏性：显式传 `engine:"zhipu"` 的旧调用将收 zod 校验错误（错误信息自动列出合法值）——诚实破坏，README/CHANGELOG 写明。CC 动态读 tool schema，无静默错路由风险。
2. **fallback 链叙事**：`machine_mcp → brave → serp_http → browse_headless → recording_replay`（六处注释 + KEY-GUIDE/README 同步）。
3. **fanout 单源退化定案（唯一行为级改动，非纯删除）**：
   - 现状：`canFanout = engine==="auto" && braveAvailable && zhipuAvailable && …`（search.ts:328-334）——zhipu 删除后该式恒 false，auto 默认路径塌缩。
   - 定案：auto 路径源集合动态构造 `[search.machine_mcp（machineMcp 已注入时）, search.brave（available 且 free_tier 允许时）]`：
     - 两源齐 → fanout（MultiSourceFanout 本就泛化于 N 源；machine_mcp 无 ledger，`quotaRemaining=0/quotaPerMonth=0` → allocateLimit 退化为 1 的兜底权重，行为可测）；
     - 单源 → 单源 primary 该源（现有 else 分支范式）；
     - **零 API 源**（machine_mcp 未探测到 + brave 未配 key）→ primary=`"serp_http"`（注入时）否则 `"browse_headless"`（免费兜底链，KEY-GUIDE 既有承诺「一家不配也有搜索」保持）。
   - registerSearchTool 第 2 参从 `search: SearchChannel` 改为可空 `machineMcp`/`brave` 已在参数表——签名收敛为「可选源注入」风格（与 v1.4/v1.15 注入式手法一致）。
4. **free_only 分级表联动**：
   - 现状：`filterByFreeTier(byCap("search"))` 只看 registry 内 api_key providers（zhipu=L2、brave=L4；machine_mcp enabled=false 不进 BUILTIN_PROVIDERS、不参与过滤——INV-72(e)）。
   - 删除后：free_only=L1/L2/L3 时 brave 被滤除 → 现行「free_only excluded all search providers」空结果分支（search.ts:299-326）命中率上升。
   - 定案：machine_mcp 的 L1 身份（providers.ts:332-345 `free_tier_level:"L1"`）在 auto 路径显式兑现——**free_only 过滤后 API 源全空且 machineMcp 已注入 → 降级 machine_mcp 单源**（L1 ≤ 任何档位；与 fallback_chain 路径现行注释 search.ts:172-174 的既有语义对齐）；无 machine_mcp 才诚实返 `free_only_filtered` 空结果。KEY-GUIDE `LASSO_SEARCH_FREE_ONLY` 表（KEY-GUIDE.md:304「智谱属 L2 保留」行）重写。
5. **MultiSourceFanout CJK langBoost**：`includes("zhipu")` → `includes("machine_mcp") || includes("zhipu")`（machine_mcp 后端就是智谱 web_search_prime，CJK 优势等价继承；保 "zhipu" 字面量是容忍——不，**墓碑 INV 要求全树无 "search.zhipu" 字面量**，而此处是源名 `"search.machine_mcp"` 的 `includes` 匹配，直接改为 `includes("machine_mcp")` 即可，零容忍项）。
6. **MetricsCollector/CircuitBreaker**：`search.zhipu` breaker（index.ts:565）与 longBreaker（1026）项删除；MetricsCollector 维度是动态 per-channel 名，无静态改动。

### 2.4 「machine_mcp 探测不到的机器失去 API 搜索层」——如实披露（裁决注意点）

删除后，未装 web-search-prime MCP 的机器：API 搜索层 = 仅 brave key 持有者的 Brave（L4 计量计费）；无 key 机器只剩 `serp_http` 裸 HTTP 快探 + `browse_headless` 实搜兜底（免费，v1.14 重审已证可用）。落地三处，不淡化：

1. **doctor #36 `machine_search_mcp`**：未命中（warn）文案从「需配 ZHIPU_API_KEY」改为「本机无 API 搜索主力源：仅剩 Brave（需 key）/裸 HTTP 快探/无头实搜兜底；要 API 档请配置 web-search-prime MCP（推荐）或 BRAVE_API_KEYS」。
2. **README（9 语言同构）+ KEY-GUIDE**：主搜索配置叙事重写——从「填 ZHIPU_API_KEY」改为「机器已配 web-search-prime MCP 即零配置；否则可配 Brave 或直接用免费兜底」；`ZHIPU_API_KEY` 键标注 tolerated-but-ignored（照 `BING_API_KEYS` 的 README.md:126 先例「配置键保留但会被静默忽略」+ doctor 提示删除）。
3. **SEARCH_DESCRIPTION**（descriptions.ts:21）：默认引擎描述改为 machine_mcp（智谱 MCP 复用）。

### 2.5 INV 与测试

- **既有 INV 零硬断言**（本轮 grep 全 check-invariants.mjs：zhipu/Zhipu 字样只出现在 INV-72 desc 与注释 3067-3151，是「与 ZhipuSearchChannel 同范式」描述性文字，非存在性断言）→ A3 合法改动 = INV-72 **文字修订**（「与 ZhipuSearchChannel 同范式」→「McpClient.connectHttp + callTool web_search_prime 范式」；断言本体（a)-(f) 零改）。
- **新增 INV-80 `zhipu-direct-channel-removed`（墓碑范式照 INV-54，check-invariants.mjs:1877-1946 完整先例）**：
  (a) channels/SearchChannel.ts 不存在；(b) src/ 全树无 ZhipuSearchChannel import、无 `"search.zhipu"` channel 字面量（stripComments 后 grep，容忍 INV 自身与墓碑注释行——照 INV-54 必要条件 3 的实现细节）；(c) FallbackChain DEFAULT_FALLBACK_ORDER 不含 search.zhipu；(d) providers.ts 禁 `const ZHIPU: ProviderConfig`；(e) config.ts 不消费 ZHIPU_API_KEY（容忍默认键存在，照 BING_API_KEYS 模式断言「无 `providers.set("zhipu"` + 无 keys 注入」）；(f) doctor 存在 `zhipu_keys_retired` 检查名；(g) searchSchema engine enum 无 `"zhipu"` 值。
- **测试合法删除清单（29 个含 zhipu 的测试文件，433 处出现，须逐文件列明）**：重灾区 search-fallback-chain.test.ts(45)/multi-source-fanout.spec.ts(43)/attributed-search.spec.ts(40)/doctor.spec.ts(28)/provider-registry.spec.ts(27)/search-channel.spec.ts/search-fanout-rpm.spec.ts/free-tier-router.spec.ts/config-file.spec.ts/benchmark.spec.ts/其余注释级。**改写优先于删除**：fanout/doctor/registry 断言把 zhipu 换成 machine_mcp 同型断言（净测数不降），仅真死路径（ZHIPU_API_KEY 注入、checkZhipuKey/Endpoint、engine="zhipu" 单源）删除并在交付说明列明。
- **新增测试**：auto 三态（双源 fanout / 单 brave / 零 API 源走兜底链）、free_only=L2 + machine_mcp 注入 → machine_mcp 单源（新语义）、free_only=L2 无 machine_mcp → free_only_filtered 诚实空结果、engine="zhipu" zod 拒绝、CJK langBoost 命中 machine_mcp 源。

---

## 3. A2′ 自研第二跳设计定案（零付费依赖、不起浏览器）

### 3.1 方案对比与定案

| 方案 | 评估 | 裁决 |
|---|---|---|
| **甲：search 加可选参数 `content_blocks: N(1-5，缺省关)`** | 与第一跳同回合完成「搜+拿内容」；CC 一次调用拿到裁剪后正文；opt-in 缺省 = byte-identical 基线（照 freshness/extract_mode 的 optional-无-default 守护手法，search.ts:102-108 先例） | **定案** |
| 乙：独立工具 search_content(query) | 必须重新执行第一跳才能定位 URL——重复搜索成本；若只收 url 列表则退化为 fetch_url 批处理包装，无独立存在价值（CC 已可串 search→fetch_url，A2′ 的增量恰在「同跳并发+查询相关裁剪」） | 否决 |

### 3.2 参数与流程

```ts
// searchSchema 增（缺省 undefined = 关 = 现行行为零改）
content_blocks: z.number().int().min(1).max(5).optional(),
```

流程（三条路径统一出口处接线：fanout 结果 / 单源结果 / fallback_chain+replay 结果）：

1. search 主路径返 `worked` 后（cache 命中与新查**均适用**），取合并后 results 的 top N；
2. 并发抓取（并发度 3；小信号量自实现——Promise 池 + 计数器，禁新 npm 依赖）；
3. 单条护栏（全部复用既有机器，零新范式）：
   - **SSRF 必过 `ssrfGuard`**（INV-31 同 config——注意第二跳 URL 来自搜索结果=外部输入，SSRF 风险高于固定引擎域名，比 http-serp 更必须）；
   - **连接池必经 `subproc.acquireHttpClient(origin)`**（INV-32；SubprocessManager.ts:318 每 origin keep-alive Agent，禁 new Agent）；
   - timeout 5s（AbortController，照 fetch-url.ts:139 同款）；
   - max_bytes 256KB（content-length 预检 + body 截断双闸，照 fetch-url.ts:190-248 同款两段式）；
   - content-type 非 HTML → 该条如实 `not_html` 跳过；
4. HTML → `MarkdownExtractor`（mode:"markdown"，defuddle 抽正文；INV-67 内部子组件定位不变）→ 查询相关裁剪（§3.3）；
5. 输出：每条 result 增可选字段 `{ content?: string, truncated?: boolean, content_status?: "ok"|"fetch_failed"|"not_html"|"extract_failed" }`——**抓失败的条目不吞不伪装**：保留原蓝链字段 + content_status 如实标注，CC 可自行 browse 兜底（裁决②原文「留给 CC 自己 browse」）。tri-state 诚实红线：第二跳任何失败**不改变**主结果 outcome/served_by（enrichment 不是 fallback，无循环——INV-4/55 注释自证范式照 http-serp.ts 头注释）。
6. 总预算护栏：每条裁剪预算 ~6k 字符；第二跳整体 wall-clock 软上限 15s（并发 3 × 5s 最坏两轮），超时未完成的条目如实 `fetch_failed(timeout)` 返回，不阻塞已完成条目。

### 3.3 查询相关裁剪算法（零依赖，机械化可测）

- **query 分词** = 空白切分（拉丁）+ **CJK bigram**（连续 CJK 段两两成对，UTF-16 码位级，零分词库）+ 去重。
- **段落分** = Σ(词项命中次数，每词项 cap 3 防关键词页霸榜) / sqrt(段落字符数)（长度归一）。
- **保留策略**：正文前 200 字符无条件保留（新闻导语定律，防纯重叠打分裁掉导语）；其余按分数降序贪心收录直至 ~6k 字符预算；收录段落数 < 全部段落 → `truncated:true`。
- 实现位置：新文件 `src/search/ContentSecondHop.ts`（纯函数 `scoreAndTrim(markdown, query, budgetChars)` + 编排 `fetchContentBlocks(results, N, deps)`；deps 注入 fetchImpl/时间源照 http-serp 范式，可单测）。

### 3.4 定案细则

- **cache 交互**：INV-11 cache key 不动（content_blocks 不入 key）。语义：蓝链结果缓存 7 天不变；第二跳每次实抓（内容新鲜度诚实 + 零 cache 污染）。文档化「内容不缓存，蓝链缓存」。
- **fetched_via 字段**：裁决原文有 `fetched_via:"raw_http"`——**定案不加该字段**（本版第二跳恒 raw_http 不起浏览器，写死在 tool description；避免与 A1 quality 轴形成两套近似标注轴的混淆，见 §7 冲突 2）。语义保留于本档。
- **重站（Cloudflare/JS 渲染）**：裸 HTTP 抓不到 → 如实 `fetch_failed`，**不启浏览器**（裁决②明文）。
- **测试**：裁剪黄金用例（CJK bigram/拉丁词项/导语保留/长度归一/cap3）；mock fetchImpl 四态（200 HTML/403/timeout/非 HTML）；并发 3 断言；256KB 截断；tri-state（部分失败条目标注、主 outcome 不变）；content_blocks 缺省 = 输出 byte-identical 基线。

---

## 4. A1 质量轴（零回归加标注）

- `InteractResult` 增可选 `quality?: "api" | "scrape" | "stale"`（types.ts:36-50）。
- **静态映射零启发式**（decision-A A1 风险条原文「判定逻辑按 served_by 静态映射即可」）：`served_by ∈ {search.machine_mcp, search.brave}`（含 fanout 聚合串）→ `"api"`；`{serp_http, browse_headless, browse_logged_in, browse_cloud_*}` → `"scrape"`；`recording_replay` → `"stale"`。单一真源新文件 `src/search/QualityTag.ts`（导出 `qualityForServedBy(servedBy)`），search.ts 三条路径出口（fanout/单源/fallback_chain+replay）统一打标。
- **与 A3 的执行序约束**：映射表从第一版起就**不含** `search.zhipu`（A3 先行，见 §8）。
- 测试：三路径 × served_by 断言 + quality 缺省不影响既有 JSON 快照（新字段 optional，既有黄金断言若做全对象 deep-equal 须逐个加字段或改 subset 断言——改动点列明）。

---

## 5. B1 `search_local` 定案（第四通道；三源分阶段）

### 5.1 形态定案

- **工具直连、不建 BaseChannel 子类**：本地只读查询无网络面、无 fallback 语义（tri-state 退化为 worked/didnt——查不到/不可用就是 didnt，unknown 仅用于意外异常），照 read-text/doctor-tool 纯本地工具先例；避免为通道对称而造空壳（R-ABS-01）。不入 RootRegistry/capability bag（INV-36 只对注册 channel 生效）；走工具注册 + toolAnnotations（INV-5）。
- schema：
```ts
{
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),   // 硬顶 50，无 dump 面板
  source: z.enum(["history", "files", "notes"]).default("history"),
  profile: z.string().optional(),                       // Chrome profile 名（"Default"/"Profile 1"…；缺省扫全部）
}
```

### 5.2 源 1：Chrome History（P1 第一批）

- 路径发现：`~/Library/Application Support/Google/Chrome/*/History`（Default + Profile 1..N 多 profile；本机实证 Profile 1 存在）；非 darwin 或无 Chrome → 诚实 didnt + reason。
- **WAL 锁规避（decision-B 技术要点 4）**：`copyFile` 每库到 `os.tmpdir()/lasso-search-local-<uuid>/` 再 `node:sqlite` `DatabaseSync` 只读打开；查完 `rm -rf` temp 目录（finally）。禁直开原库（Chrome 运行时 WAL 锁）。
- SQL（参数化，LIKE 转义 `\`）：
```sql
SELECT url, title, last_visit_time FROM urls
WHERE (title LIKE ? ESCAPE '\' OR url LIKE ? ESCAPE '\')
ORDER BY last_visit_time DESC LIMIT ?
```
（LIKE 大小写不敏感仅对 ASCII；CJK 无大小写恰免于此问题——文档化。）
- 时间换算：Chrome `last_visit_time` = 1601 纪元微秒 → `(t/1e6 - 11644473600) * 1000` ms → ISO。
- 输出（隐私红线落地）：`{title, url, visited_at, snippet?}`——snippet 取 title 匹配片段 ≤200 字符；**无 content 字段、不 join visits 明细表**（v1 只查 urls 表）。
- 多 profile：并行查各库（每库 ≤limit）合并按 visited_at 排序再截 limit。

### 5.3 源 2：mdfind（P1 同批；files）

- `spawnSync("mdfind", [query], { timeout: 5_000, maxBuffer: 1MB })`（INV-64 同款 node:child_process only；chrome-hide.ts:69 osascript spawnSync 先例）。
- 输出行 = 文件路径 → 截 limit → 每条附 `stat` 的 mtime（**只读元数据，不读文件内容**）。
- 非 darwin → didnt + `reason:"mdfind_darwin_only"`（诚实，不伪装空结果）。
- 过渡红利：Spotlight 索引 Apple Notes 标题（com.apple.notes）——files 源天然覆盖部分笔记标题搜索，文档化（§5.4 的过渡缓解）。

### 5.4 源 3：Apple Notes（**本版明确推迟**，理由写死）

- **理由（三条，非懒惰）**：① ZBODY 列是 zlib 压缩 protobuf 非明文，全文解析是 500+ 行独立工程（decision-B 已预警「解析有坑」）；② Group Containers 沙盒在 macOS 12 受 TCC 全盘访问拦截与否**未经实测**，是环境依赖风险；③ v1 只查「标题+日期」的收益存疑（用户查笔记通常找内容而非标题），且 §5.3 已过渡覆盖标题搜索。
- 形态：enum 保 `"notes"` 值但返 `didnt + reason:"notes_deferred_v2"`——**比从 enum 删除更诚实**（CC 能看见源存在但未开放，不会误以为 Lasso 不知道笔记的存在）。
- 实施位置：新目录 `src/search-local/`（`chrome-history.ts` / `mdfind.ts` / `register-search-local-tool.ts`）。

### 5.5 隐私红线（INV 级钉死）

**新增 INV-81 `search-local-readonly-privacy`**：
(a) search-local 模块对 Chrome/Notes 源路径禁写 API（writeFileSync/appendFileSync/rename/unlink 对源路径；temp 目录写/删白名单化）；(b) 输出 schema 无全文 content 字段（grep 守 content: 字面量于该模块）；(c) limit ≤50 硬顶（zod max 断言）；(d) 模块零网络调用（不 import ssrf-guard / 不 acquireHttpClient / 无 fetch( 字面量——纯本地是架构属性，grep 可守）；(e) 日志只记 `query_len` 不记查询原文与结果集。

---

## 6. C1 elicitation / C2 include_refs 定案

### 6.1 C1：HighRiskGate elicitation 化（SDK 1.30.0 实测 API）

- **封装**：新文件 `src/interact/ElicitationPort.ts`——窄接口：
```ts
interface ElicitationPort {
  confirmHighRisk(kind: string, evidence: string): Promise<"accept" | "decline" | "unavailable">;
}
```
内部实现（持 `McpServer`）：① 预检 `server.server.getClientCapabilities()?.elicitation?.form` 未声明 → `"unavailable"`（**不发起请求**，能力守卫前置）；② `server.server.elicitInput(params, { timeout: 120_000 })`——form 档 params：`message`（kind + evidence ≤200 字符）、`requestedSchema.properties.decision = { type:"string", enum:["continue","skip","abort"], enumNames:["继续执行","跳过本步","终止"] }`；③ 任何 throw（含 SDK 能力守卫同步 throw / McpError RequestTimeout / 传输错误）→ `"unavailable"`；④ `action:"accept"` → 校验 `content.decision` 存在后映射（continue→accept 继续；skip/abort→decline）；`decline`/`cancel` → `"decline"`。
- **接线**：`LoggedInChannel.createHighRiskGate()`（LoggedInChannel.ts:320-322）——HighRiskGate 构造器加第二可选参 `elicitationPort?: ElicitationPort | null`（未传/null = 现行行为）；assessStep 命中 pattern 后：port 存在 → confirmHighRisk；`accept` → `{blocked:false, reason:"high_risk_elicited:<kind>"}`（审计链可见曾拦过并经人确认）；`decline`/`unavailable` → **现行 blocked=true 路径 byte-identical**（StepEngine.ts:146-177 零改）。port 下传链：registerBrowseTool 持 server → channel 构造注入（注入式手法，照 machineMcp/serpHttp 先例，未注入=零回归）。
- **范围纪律**：只做 HighRiskGate 主场景。decision-C 的次级候选（desktop 权限缺失/云 key 缺失/doctor 修复确认）**不进本轮**——主场景真机验证后再扩。
- **安全测试钉死（裁决红线，缺一不可）**：
  1. `clientCapabilities` 未声明 elicitation（undefined / `{}` / 有 elicitation 无 form 子键三态）→ assessStep 返回与现行**完全一致**（blocked=true + reason=`high_risk_pattern:<kind>`，deep-equal 断言）——byte-identical；
  2. port spy 断言调用计数 = 0（能力未声明时**连请求都不发**）；
  3. elicitInput throw（timeout/传输/守卫）→ blocked=true 不放行；
  4. accept 无「记忆」：连续两步命中 pattern → 每步独立确认（INV-14 anti-gaming 的 elicitation 延伸——确认不缓存，pattern 表仍代码级 const）；
  5. 真机手测清单（CC ≥2.1.76，三个 pattern 场景 RTE/drag_drop/toast）存档 `doc/governance/06-五项裁决实施/c1-真机手测.md`——实施轮交付物。

### 6.2 C2：抽取 ref 句柄（include_refs opt-in）

- **定案路线（关键简化）**：refs 从 doExtract 既有 evaluate_script **顺带**产出（改 expr 返回 `{html, url, title, refs}`），注入 `data-lasso-uid="r1"..` 属性——与 HighRiskGate.buildAssessExpr 第 1 步的 data-lasso-uid 查找预留（HighRiskGate.ts:203-204 自注「Lasso 未来在 snapshot 注入」）**恰好对齐**，同属性名闭环。
- 替代方案（解析上游 take_snapshot 的 uid 透传）**否决，理由白盒**：① markdown 档本就不跑 take_snapshot（doExtract 只 evaluate outerHTML，BrowseChannel.ts:833-895）——走上游 uid 需额外一跳 snapshot，恰是 C2 要消灭的成本；② 上游 uid 文本树契约无本机实测样例（browse-upstream-contract.spec 无 uid fixture）——不可依未验契约设计。
- **输出形态**：markdown 末尾追加 `## Interactive refs` 附录表（`[r1] button "提交"` / `[r3] a "文档" → https://…`），**正文零内嵌标记**——既有 markdown 黄金断言主文结构不受扰。refs 只收交互元素（a/button/input/select/textarea/[role=button] 等），cap 50 个/页。
- **click/fill 接 ref**：selectors.click 匹配 `^r\d+$` → doClick 走 evaluate_script `document.querySelector('[data-lasso-uid="r1"]')` 定位后 `.click()`（fill 同理设 value + dispatch input/change）；JS click 与 trusted CDP click 的差异如实文档化（个别框架不响应 → CC 回退快照 uid 路径，两条路径并存）。**ref 失效诚实语义**：querySelector miss → throw `ref_stale` → classifyBrowseError → `didnt + error:"ref_stale_re_snapshot"`——不猜不自动重试。
- **参数**：browse extract options 加 `include_refs: z.boolean().optional()`（缺省关 = byte-identical，INV-66 手法）。raw 档 + include_refs=true → 运行时忽略 + 返回标注 `ignored_include_refs:true`（宽松进严格出，schema 不拒）。
- **测试**：缺省关 byte-identical；refs 附录格式；ref→click 往返（mock McpClient evaluate 往返）；ref_stale → didnt；cap 50。

---

## 7. 冲突清单（定案）

| # | 冲突 | 定案 |
|---|---|---|
| 1 | A1 质量轴映射 × A3 枚举删除：QualityTag 若含 `"search.zhipu"` 字面量会被 INV-80(b) 墓碑 grep 打死 | **执行序 A3 → A1**：映射表第一版就只含 machine_mcp/brave/scrape/stale 档 |
| 2 | A2′ 输出标注 × A1 质量轴：`fetched_via:"raw_http"`（裁决原文）与 `quality` 语义相邻易混 | A2′ 只出 `content_status` 四态；fetched_via 本版不落字段（恒 raw_http 写进 description），语义留存本档 §3.4 |
| 3 | A3 × INV-72：desc/注释多处「与 ZhipuSearchChannel 同范式」「降级到 search.zhipu」失准 | A3 同 PR 改 INV-72 **文字**（断言 (a)-(f) 零改）；属合法墓碑注释修订，交付说明列明 |
| 4 | A3 × 链叙事六处：注释 + KEY-GUIDE + README 的「machine_mcp → zhipu → brave → …」全线失准 | 统一改「machine_mcp → brave → serp_http → browse_headless → recording_replay」；A3 PR 内一次清 |
| 5 | A3 × fanout：canFanout 恒 false 是**行为级**改动（非纯删除），影响 auto 默认路径 | §2.3-3 定案动态源集合 + 三态专项测试（双源/单源/零源）；这是 A3 唯一需新语义测试的点，单独列验收 |
| 6 | B1 × INV 体系：search_local 不建 channel 是否违反通道架构 | 不违反：照 read-text/doctor-tool 纯本地工具先例（INV-36 边界外）；INV-81 补隐私断言（§5.5） |
| 7 | C1 × INV-14：elicitation 可能成为绕过 pattern 表的通道 | accept 仅当次命中有效、无缓存状态；测试 #4 钉死（§6.1）；pattern 表 const 不动 |
| 8 | C2 × INV-66（raw byte-identical）：include_refs 与 raw 档组合 | raw 档运行时忽略 + `ignored_include_refs:true` 标注（schema 不拒；宽松进严格出） |
| 9 | A2′ × INV-11（cache key）：content_blocks 是否入 key | 不入（§3.4）：蓝链缓存语义不变，第二跳每次实抓；INV-11 零改 |
| 10 | 测试基线 2032 只增不减 × A3 大删除（29 文件 433 处） | 改写优先于删除（zhipu→machine_mcp 同型断言）；真死路径删除逐文件列明（合法删除清单），新增测试应使净测数为正 |

---

## 8. 实施顺序（定案）

**A3 → A1 → A2′ → B1 → C1 → C2**，六 Phase 各自独立过全门禁（build + test + check-invariants 基线只增不减）、单 Phase 单提交可回滚。

| Phase | 内容 | 理由 |
|---|---|---|
| **A** | A3 zhipu 直连删除（§2 全清单 + INV-72 文字修 + 新 INV-80 + README/KEY-GUIDE/doctor 联动 + 测试改写/删除清单） | 最大删除面先行：后续所有标注（A1）、文档叙事、benchmark 写在**新链形状**上，避免二次改写；冲突 1/3/4/5 一次性收敛 |
| **B** | A1 质量轴（QualityTag + 三路径打标 + 断言） | 纯增量零行为；必须后于 A（冲突 1） |
| **C** | A2′ content_blocks（ContentSecondHop + search.ts 接线 + 四态标注 + 裁剪测试） | opt-in 参数；输出轴（A1 quality + content_status）此时已稳定（冲突 2 已定） |
| **D** | B1 search_local（history + mdfind 源 + notes deferred + INV-81） | 独立新工具，与 A/B/C 零耦合——人力允许可与 B/C 并行 |
| **E** | C1 elicitation（ElicitationPort + gate 接线 + 五条安全测试 + 真机手测清单） | 独立；安全关键，含真机验证环节 |
| **F** | C2 include_refs（doExtract refs 附录 + ref 点击/失效语义） | 最小项收尾；依赖 C1 已建立的「工具层持 server」注入链（若 E 先完成则 F 的注入更顺） |

**每 Phase 验收**：`npm run build && npm test`（净测数 ≥ 基线）`&& npm run check-invariants`（INV 数 ≥ 79）+ 本档对应 § 的专项断言清单。
**最终验收**：README（9 语言）+ KEY-GUIDE 重写段人工复核；doctor 实跑输出核对（#2/#3 消失、`zhipu_keys_retired` 提示出现、#36 未命中新文案）；C1 真机手测存档；rust-helper/ `git diff` 为空。

---

## 9. 白盒确认官核验方法附录（可复查）

- 锚点重定位：grep/sed 亲读全部引用行（本文档所有 `file:line` 均为本轮 v1.16.0 实测输出，非转述 decision 文档）。
- SDK elicitation：node_modules/@modelcontextprotocol/sdk@1.30.0 的 dist/esm/server/index.d.ts:152-167 / index.js:340-370 / types.d.ts:4966-5400 / mcp.d.ts:18 / shared/protocol.d.ts:61-90 亲读。
- INV 基线：`npm run check-invariants` 实跑 All 79 passed（本轮输出）。
- 测试基线：`npx vitest list` 扁平计数 2031（与任务书 2032 差 1 为扁平化口径，以 `npm test` 汇总数为准）。
- 本机环境：node v24.12.0；Chrome `Profile 1/History` 存在；NoteStore.sqlite 存在；rust-helper/ 存在且本轮零改。
