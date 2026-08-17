# 决策文档 A：搜索层形态——grounding 上下文与质量显式化（D-DECISION，交用户裁决）

> 2026-08-18 · doc/24 颠覆性调研 verdict 产物。裁决官已抽验四份 scan + zero-base + red-team 的关键声称（源码行号亲验 / Brave 官方博客亲读 / 本机 key 状态亲查），本文只写站得住的部分。
> 姊妹决策文档：B（本地私有搜索）、C（交互面升级）。已实施的小项见 verdict.md D-GO 清单。

---

## 0. 一句话问题

Lasso 搜索层 16% 源码 / 18% 不变量 / 最近 100% feature 带宽都投在**第一跳（引擎冗余）**上，而全链路 90% 的延迟与 token 成本在**第二跳（拿内容）**——后者至今零投资。同时「worked」不区分 API 干净结果与爬虫刮出的垃圾。要不要把投资重心从第一跳转向第二跳 + 给 worked 加质量轴，是本决策的核心。

## 1. 已验证的事实基座（裁决官亲验，非转述）

| # | 事实 | 验证方式 |
|---|---|---|
| F1 | tier-0（machine_mcp）与 tier-1（zhipu）调**同一个** `open.bigmodel.cn/api/mcp/web_search_prime`，仅 key 来源不同 | MachineMcpSearchChannel.ts 文件头自述 + providers.ts:27 |
| F2 | 本机 tier-0 用的是 `~/.claude.json` 里 web-search-prime 的 `headers.Authorization`（有 key）；Lasso 侧 `ZHIPU_API_KEY`/`BRAVE_API_KEYS` 均未配置（~/.lasso 不存在，env 无） | 本机亲查 2026-08-18 |
| F3 | Brave 免费档 2026-02 取消，$5/1k + $5/月赠送额度（需站点 attribution） | doc/21 verdict（官方页亲取）+ 本轮 Brave 博客亲读复核 |
| F4 | Brave LLM Context API 存在：同 Search 计划 $5/1k、p90<600ms、`maximum_number_of_tokens` 预算制、smart chunks（查询相关 snippet + JSON-LD/行级表格 + 代码上下文 + 论坛线程 + YouTube 字幕） | brave.com/blog/most-powerful-search-api-for-ai（本轮 webReader 亲读全文，2026-06-25 更新版） |
| F5 | Lasso 的 Brave endpoint 钉死 `/res/v1/web/search`，全 src 无 `llm/context`；抽取层（markdown-extractor）零 query 入参 | providers.ts:96 + grep 亲验 |
| F6 | `SearchResult = {title,url,snippet,source}` 蓝链契约浇筑在 types/cache key/channel 签名三层 | types.ts + SearchCache INV-11 |
| F7 | parseZhipuContent 任何解析失败静默返 `[]` → unknown → 降级到爬虫，形状漂移与真零结果不可区分；本轮调研中本机 web-search-prime 对两个英文查询返回 `"[]"`，**无法定性是真空还是漂移**——正是该缺口的现场演示 | SearchChannel.ts:216-238 + 本轮实测 2026-08-17/18 |
| F8 | `isFallbackWorthy` 靠 error 字符串子串匹配（"403"/"404"...），下游被迫遵守「escalation-safe 命名」自卫纪律 | outcome.ts:104-112 + http-serp.ts:29-33 注释 |
| F9 | worked 无质量轴：brave SERP 刮出 font-face CSS「20/20 全垃圾」、百度「worked+17 条 hao123」两起事故机器闸门全绿、人工才抓到（v1.15 verify 记录） | red-team R4（doc/23/24 档案） |
| F10 | 2026-08-18 已修复：freshness=day 缓存 24h 过期 + replay 新鲜度门（本 verdict D-GO-1） | test 2031 绿 |

## 2. 方案（四个可独立裁决的子项，按依赖序）

### A1. worked 质量轴：`quality: "api" | "scrape" | "stale"`

- **内容**：InteractResult 增加可选 `quality` 字段。api = 厂商 API 干净结果（machine_mcp/zhipu/brave）；scrape = serp_http/browse_headless 正则刮取；stale = recording_replay（D-GO-1 后 replay 仅在 freshness 窗口内出现，无 freshness 查询仍可能回放陈货——stale 标注让 CC 可见可拒）。
- **代价**：约 100-150 行 + 测试。不改任何行为，只加标注（零回归）。
- **收益**：把 F9 类「悄悄变差」变成 CC 可编程拒绝/复核的信号；red-team 论证三的核心处方，最小代价落地。
- **风险**：质量轴判错（把 scrape 标成 api）会误导下游——判定逻辑按 served_by 静态映射即可，无启发式。

### A2. error 分类结构化：`{kind, status?}` 取代子串匹配

- **内容**：NOT_FALLBACK_WORTHY_PATTERNS 子串匹配改为结构化 error code（channel 抛 `{kind:"http_status", status:403}` 形态），isFallbackWorthy 按结构判定；保留旧字符串路径兼容一个版本。
- **代价**：中——触 outcome.ts + 4 个搜索 channel + http-serp 的 error 产生面，约 200-300 行 + 全部相关测试改写。
- **收益**：消灭 escalation-safe naming 自卫纪律（F8）；「URL 里碰巧含 403 字样终止整链」这类框架性脆弱不复存在。
- **风险**：改动面广，须严格分两步（先双轨后删旧）。

### A3. 第二跳升级包：Brave LLM Context 模式（ZB-1）+ 查询相关裁剪（ZB-2）

- **前置条件（不满足则不启动）**：①用户取得 Brave key（绑卡 + $5/月赠送额度，F2/F3——本机当前没有）；②真机验证两点：中文查询质量（Brave 索引英文见长）、8192-token 输出对 CC 上下文的实际占用（scan-agent-api R1 风险段）。
- **内容**：①BraveChannel 加 llm/context 变体（同 key 同鉴权，endpoint 换 `/res/v1/llm/context`），返回 grounding chunks（含表格/JSON-LD/代码块）；②抽取层内化 BM25/link-density 查询相关裁剪（Crawl4AI fit_markdown 模式，官方文档自己引用过 Crawl4AI），browse/fetch 路径加可选 `trim_to_query` 参数。
- **代价**：中-大。ZB-1 集中在 BraveChannel 内约 200 行；ZB-2 约 300-400 行（算法选型 + extract_mode 接口扩展 + 裁剪质量测试）。红队 3.1 提醒：蓝链契约（F6）下 context 结果要么新增字段要么连锁重构——**建议新增 `grounding` 可选字段而非改 snippet 语义**，保持旧消费者零回归。
- **收益**：英文「搜+拿内容」从两跳（API 命中后仍要 11s headless）压到一跳 <1s；全页 10-50k token 浪费（C8）裁到预算内。这是 zero-base 排序第 1/2 的本质缺失。
- **风险**：①中文质量未知（前置②验证）；②裁剪过度丢答案——Exa 数据显示抽取质量方差是隐形杀手，坏裁剪不如不裁，故 trim 必须 opt-in 参数而非默认；③ Brave 计划形态再变（L-OP 90 天纪律已覆盖）。

### A4. 链收缩：tier-1（zhipu channel）去留 + 债管理机器瘦身

- **前置动作（5 分钟，裁决前必做）**：比对 `~/.claude.json` 的 web-search-prime Authorization 与智谱控制台——若与 Lasso 侧将配的 ZHIPU_API_KEY 属同一账号，tier-1 是 retry 不是 fallback，应删；若双账号（Coding Plan key + 按量 key），tier-1 是真实第二配额池，保留。
- **内容（若用户选收缩）**：brave 档改 opt-in 显式 engine（默认不参与链）、recording_replay 限 freshness 窗口内（D-GO-1 已做一半）、SelectorRegistry/ChangeDetection/HitRateStats/replay-baseline 随爬虫面收缩评估瘦身（red-team 估净删 1000-1500 行）。
- **代价**：删代码也有代价——需逐条核对 14 个搜索 INV 与测试。
- **收益**：维护带宽释放（red-team 论证一：四份对抗性运营契约是这层的常态工况，Brave/Bing 两次滞后数月才被用户撞墙发现）；省下的带宽投 A3/决策 B。
- **风险**：npm 公开有 brave key 持有者（非本用户）依赖链深度——收缩会改变他们的默认行为；无生产分层触发数据支撑删除幅度（red-team 自己承认的最弱环）。**建议最小版：只做 tier-1 裁决 + 把收缩与分层命中率数据挂钩（先加观测，再谈删除）**。

## 3. 分阶段路径（若裁决 GO）

| 阶段 | 内容 | 门禁 |
|---|---|---|
| P0（5 分钟） | tier-0/1 同账号比对 + `lasso doctor` 分层触发计数器确认 | 观测，无代码 |
| P1 | A1 质量轴（零回归加标注） | 全测试绿 + 新增质量轴断言 |
| P2 | A2 结构化 error（双轨） | 全测试绿 + 旧字符串路径删除前后各一轮 |
| P3 | A3 前置验证（Brave key + 中文质量 + token 占用实测）→ 通过则实施 ZB-1→ZB-2 | 真机 benchmark + 裁剪质量对比测试 |
| P4 | A4 按 P0 数据与用户偏好裁剪 | INV 重编号 + 删除行数清单 |

## 4. 不做清单（本决策内明确拒绝）

- 搜索即回答 API 主路径（Sonar 形态）——CC 自己是综合模型，外包综合注入外部错误（zero-base M1）。
- Tavily 接入——同价位被 Brave 统计显著压制，无独占能力（scan-agent-api R2）；providers.ts 的 TAVILY_WATCH 占位保持 enabled=false 不动。
- Exa 语义通道（本轮）——唯一价值是「按含义找」长尾，为长尾加供应商违反简单架构红线；重开条件：关键词引擎在真实查询上证明失效的案例积累（D-WATCH）。
- Gemini 3 grounding 第二机器源——5k/月免费真实存在但 CN 可达性未实测（D-WATCH，验证方法：curl generativelanguage.googleapis.com 经代理）。

## 5. 交用户的核心问题（三选一或组合）

1. **只做诚实化**（A1+A2）：链不动，先把质量与错误语义做实——最小风险路径。
2. **诚实化 + 第二跳升级**（A1+A2+A3）：需要你先配 Brave key 并接受 $5/月级别的潜在支出（赠送额度内 ≈1000 次/月免费）。
3. **诚实化 + 收缩**（A1+A2+A4）：接受链变薄（brave opt-in、爬虫债机器瘦身），换维护带宽投 fetch_feed 之后的下一批原语（决策 B/C）。
