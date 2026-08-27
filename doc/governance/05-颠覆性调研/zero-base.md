# zero-base — 零基设计：CC（终端编码 agent）的外部信息获取层（2026）

> 调研员：零基设计师（L-ZB 纪律首次执行）。2026-08-17。
> 方法论纪律（doc/governance/04）：①问题从零基视角出发（用户要什么/约束是什么），**本文 §1-§4 写作时未读任何 Lasso 源码**，仅基于四份姊妹调研（scan-agent-api / scan-edge / scan-mcp-proto / scan-model-native）+ 本轮新增外部证据；②每条关键声称附成本/延迟（L-COST）；③禁把「开源项目都这样做」当最优证据。
> 结构：§1-§3 回答三个本质问题 → §4 从零设计总图 → **§5 才读 Lasso 源码**产出 ZB-N diff 清单 → §6 来源。
> 本轮只调研分析，不改代码。结论级别标注沿用姊妹篇：S=官方页亲取 / C=社区多源交叉 / R=仓库实据 / **E=推理估计（epistemic status: inference，无硬数据锚点，标注推理链）**。

---

## 1. 本质问题①：CC 到底要什么信息

### 1.1 从 agent 循环推导信息需求

CC 的循环是「读上下文 → 计划 → 行动（代码/bash/MCP）→ 观察 → 循环」。外部信息只在**参数记忆 + 本地 repo 上下文不足**时才被需要。把这个「不足」拆开是六类信息（分类学锚点：Exa 为编码 agent 建了专门的 docs/changelogs/issues 摄入管线并称「code search 查询过去一年激增、2025 底跳涨」——S：exa.ai/blog/webcode，2026-03-23）：

| # | 信息类 | 典型问句 | 参数记忆为何不够 | 紧迫度 |
|---|---|---|---|---|
| I1 | **代码/API 用法**（库文档、SDK 签名、示例） | 「babel 插件怎么访问 AST 节点」「React 19 里 useRef 泛型怎么写」 | cutoff 后的新 API、版本行为变化 | **阻塞**（写码中途，预算 <5s） |
| I2 | **错误诊断**（报错串、GitHub issues、SO） | 「TS2352 这个 cast 为什么报错」「这个 panic 在哪修的」 | 长尾错误组合、库版本特定 bug | **阻塞**（跑不通就无法继续） |
| I3 | **新鲜度事实**（版本号/发布/弃用时间线/价格） | 「Veo 3.1 什么时候退役」「这个包最新版本是多少」 | 训练截止 + SERP 索引滞后小时~天级双杀 | 半阻塞（决策依赖，预算 <10s） |
| I4 | **领域/市场研究**（竞品、方案对比、生态盘点） | 「视频生成 API 哪家便宜」「这个范式有哪些竞品」 | 综合性问题，需要多源拼装 | 非阻塞（容忍 10-30s） |
| I5 | **私有数据**（用户自己的历史/笔记/文件/浏览记录） | 「我上周看过的那篇文章在哪」「之前哪个项目碰到过这个」 | 模型根本看不到用户机器 | 非阻塞，但**高频**（人查自己历史的频率高于查冷门网络信息——scan-edge §2） |
| I6 | **需交互/登录的信息**（Jira、后台、订阅墙） | 「看我在 X 平台的待办」 | 无凭证无界面 | 非阻塞（往往是任务本体而非上下文） |

### 1.2 占比（诚实标注：E 级推理估计）

没有公开的「CC 查询类型分布」硬数据（本轮两轮检索未获；Exa 只给趋势不给构成）。以下为推理估计，锚点是：①Exa 专门为 docs/changelogs/issues/SDK 建管线（说明这四类是编码 agent 搜索的主体——S）；②本用户记忆档案里调研文档密度极高（视频 API 调研/供应商盘点/范式扫描全是 I4/I3 产物——R：MEMORY.md）；③I5 的 claude-mem 只覆盖对话记忆（R）。

| 信息类 | 通用编码 agent（E） | 本用户画像（E，研究重型） |
|---|---|---|
| I1 代码/API | 35-45% | 25-30% |
| I2 错误诊断 | 20-25% | 10-15% |
| I3 新鲜度 | 10-15% | 15-20%（用户维护多个弃用时间线） |
| I4 研究 | 10-20% | **30-35%** |
| I5 私有 | 5-10%（增长中） | 5-10% |
| I6 交互 | ~5% | ~5% |

**占比的用途不是精确数字，是排序结论**：I1+I2（阻塞类）在任何画像下都是最高优先——它们决定「延迟预算最严 + 可缓存性最高 + 垂直源（docs/issues）命中率最高」三个设计约束；I4 在本用户画像下与 I1 等权——融合检索（单跳出内容）的价值因此上升。

### 1.3 两条机理级结论（决定整个设计的形态）

**M1：groundedness > synthesis——信息层的职责是「把答案弄进上下文」，不是「替 CC 回答」。**
Exa WebCode 的核心实验发现：把同一批结果喂给综合模型，**correctness 各家都聚在 ~86%**（反映的是综合模型，不是搜索商）；差异全部体现在 **groundedness**（结果集里是否真的含有答案）——且 Claude web_fetch 对 12% 的 URL 返回空内容时，综合模型仍能靠参数记忆答对，correctness-only 指标完全掩盖了检索失败（S：exa.ai/blog/webcode）。设计含义：①「搜索即回答」类 API（Perplexity Sonar 形态）在 CC 场景是重复建设——CC 自己就是综合模型，且外包综合会注入另一个模型的错误；②该层的产品指标应是 groundedness-per-token（每 token 换来多少「上下文里真的有答案」），不是答案质量。

**M2：抽取质量方差是隐形杀手，与引擎选择同级重要。**
同页抽取长度差 **1x-13x**，超长部分全是侧栏/导航/chrome；Claude web_fetch_20260209 的 signal（有效内容占比）只有 **55.1**，Exa 94.5、Parallel 77.6；code recall 82.4 vs 96.7（S：同上）。设计含义：抽取/裁剪层（U3）不是引擎层的附属品，是独立的质量战场——一个 94 分引擎配 55 分抽取，不如 77 分引擎配 94 分抽取。CC 自己的 WebFetch 也是这么打的：HTML→markdown 后截 100KB，再过一道 Haiku 小模型只回「与问题相关的答案」（S：mikhail.io/2025/10/claude-code-web-tools，2025-10-06 逆向）。

**M3（补充）：CC 客户端已有 15 分钟 URL 缓存，但搜索结果不缓存。**
mikhail.io 逆向确认 WebFetch 每 URL 15-min TTL 缓存（S）。这意味着：fetch 层的重复成本 CC 已消化；**搜索层的重复查询成本没人消化**——同一个库文档查询、同一个报错串，跨会话重复发生（I1/I2 可缓存性最高的直接推论）。这是 §4 X1（结果缓存）的零基依据。

---

## 2. 本质问题②：约束（按决定性排序）

| # | 约束 | 事实与来源 | 设计含义 |
|---|---|---|---|
| C1 | **CC 走中转（new-api→GLM），原生 WebSearch/WebFetch 结构性不存在** | Anthropic 专用 server tool 链中转站不支持，报 "web search is not enabled"；CN 社区标准解法=换 MCP 搜索（C：知乎/linux.do/cc-switch#2570/cc-haha#228 四源交叉，scan-model-native §1） | **信息层不是冗余，是唯一搜索路径**。这是第一结构事实，决定整层必须存在 |
| C2 | 单用户 | 本机事实 | 本地 SQLite 缓存无失效战争、配额账本按人算、stdio 足够（无多租户/无横向扩展） |
| C3 | CN 网络部分隔离 | 域名级拦截（vercel.com 本轮被拦——scan-edge 诚实边界）、ClashX 7890+TUN fake-ip（R：network-proxy-environment 记忆） | 双索引路由（CN 引擎答中文、全球引擎答英文）是 table stakes；每条路径须有「免费本地」兜底；新供应商须先过可达性实测 |
| C4 | 成本敏感 | 原生搜索 $10-14/千次+内容 token 放大 vs 专用 $1-5/千次 vs 免费兜底 ¥0（scan-model-native §6.1 表） | 计费形态本身是路由参数；免费层（zhipu 赠送/Brave $5 月赠/Gemini 5k/月）优先耗尽再落付费 |
| C5 | 模型 API 自带搜索在进化 | 吸收曲线在 API 层完成：OpenAI 2026-07-23 关停 Chat Completions 搜索 preview、只剩 Responses 内置；Gemini 3 grounding SimpleQA 72.1% SOTA、5k 次/月免费（S：scan-model-native §2-§3） | **骑乘而非对抗**：厂商自发 MCP（智谱 web-search-prime）应做 tier-0；自建引擎集合的价值收缩为策略层（认证拓扑/成本治理/引擎归因/降级） |
| C6 | 硬件：2015 Intel MBP / macOS 12 | Darwin 21.6.0（本机事实） | 本地 embedding 入库 50k 条数十分钟起（E：Intel CPU 推理）；headless 浏览器冷启动 ~11s 是重资源；截屏式记忆（Recall 形态）直接否决 |
| C7 | 简单架构红线 | 项目红线（黑板零 LLM/分布式/反过度设计） | 无守护进程、无 Postgres、SQLite 是唯一允许的状态；每加一个常驻组件都要论证 |
| C8 | **token 经济是第一类成本** | 全页 markdown 10-50k token，比查询相关裁剪后浪费 5-10×（scan-agent-api §0-U3）；CC WebFetch 靠 Haiku 预滤+100KB 截断打同一场仗（S：mikhail.io） | 信息层的**输出大小**与延迟/金钱同权——L-COST 表必须有 token 列；裁剪（X2）是必建件不是优化件 |

---

## 3. 本质问题③：每类信息的最优获取路径

### I1 代码/API 用法（阻塞，预算 <5s）

| 优先 | 路径 | 延迟 | $/1k | 输出 token | 依据 |
|---|---|---|---|---|---|
| 1 | 机器厂商 MCP（智谱 web-search-prime） | ~1-2s（E） | 0-按 token（套餐内含 100-4000 次/月） | 视实现 | 骑乘厂商（C5）；R：machine_mcp 层即此 |
| 2 | **融合检索**（搜索+内容+按查询裁剪单跳返回，Brave LLM Context 形态） | p90 <600ms | $5 | 预算制（默认 8192 上限，可调 1024-32768） | M1/M2 的直接解——docs 类查询单跳拿到 query-relevant chunks，含代码块保留（code recall 是 Brave 内置能力面） |
| 3 | 垂直：代码用法走 grep.app/Grep MCP（官方 MCP 免费存在） | ~200-500ms（E） | 0 | 小 | 「别人怎么写」返回真实用法而非博客（scan-edge §5）；**推荐加装而非自建** |
| 4 | 直达 docs 站 + 本地 BM25 裁剪 | fetch 300ms-2s；headless 兜底 11s | 0 | 裁剪后 1-3k | 官方文档站往往可直取；裁剪内化（M2） |

**故障路径**：机器 MCP 无 key/挂 → 融合检索 → 关键词 SERP + 直达抽取 → headless → 诚实失败（返回结构化 didnt）。

### I2 错误诊断（阻塞）

- 最优路径：**GitHub issues 垂直检索**（真修复常在 issue 里）+ SO（经 SERP site: 过滤）。报错串是高熵查询——精确匹配优于语义泛化（E：报错串含符号/路径/版本号，embedding 泛化反而丢信息；反向佐证：Exa 的技术文档查询质量最高也是因为「精确」——scan-agent-api §2）。
- GitHub 公共仓库的 issues/releases API 免费无鉴权（S：GitHub REST 文档常识，速率 60 req/h 无 token）——`gh` CLI 用户已有凭证，更高。
- **可缓存性最高**：同一报错跨会话复发，30 天 TTL 缓存命中率应为本层最高（E）。
- L-COST：SERP 路径同 I1；gh/REST 路径 ~500ms-1s、$0、输出可裁剪。

### I3 新鲜度事实（半阻塞）

- **机理**：SERP 索引滞后小时~天级，唯一确定性 freshness 解是**推模型（RSS/Atom）——发布即推送，零索引滞后**（scan-edge §4.1）。
- 最优路径排序：①已知源 → `fetch_feed`（200-500ms，$0，无状态）；②版本事实 → GitHub Releases API（免费、结构化、含日期）；③未知源 → 先 browse 找页头 `<link rel=alternate>` 发现 feed 再拉；④兜底 freshness 过滤的 SERP。
- 本用户实证：记忆档案里多条「XX 死期」时间线（Sora 09-24/Nova Reel 09-30/Veo 3.1 2026-11-17——R：video-api-market-research）全靠人工拉官方页维持；feed 原语把这类劳动自动化一半。
- 常驻聚合（Miniflux/RSSHub）违反 C7，NO。

### I4 领域/市场研究（非阻塞，10-30s 容忍）

- 最优路径：**融合检索为主**（Brave LLM Context $5/1k / 中文 zhipu），深度调研用 deep 型搜索（Exa deep 4-12s $12/1k——只在「浅检索已证明不足」后升级，成本 2.4×）。
- 多跳综合留给 CC 本体（M1）。
- Gemini 3 grounding 5k/月免费是「单次铺量检索」的候选第二机器源（C3 可达性未实测——挂账）。

### I5 私有数据（非阻塞但高频）

- 最优路径：**纯本地 SQLite FTS**——Chrome History（SQLite）/Apple Notes（SQLite）/mdfind（系统索引）/剪贴板，<10ms、$0、零守护（scan-edge §2.2 表；组件全成熟）。
- embedding 是辅助不是主体：Intel CPU 入库痛苦（C6）；FTS 先行、embedding 观察后再说。
- 隐私红线：浏览历史全文不出本地（云 embedding 否决）。
- 这是**整类缺失**：macOS 成品真空（Rewind 2025-12-19 死、Recall 不上 mac——S：scan-edge §2.1）。

### I6 需交互/登录（非阻塞）

- 最优路径：logged_in 浏览（cookie 态）+ desktop AXAPI（原生 app）；**GUI agent 视觉循环只作最后兜底**（15s-3min、$0.05-0.5/task，比 API 慢 1-2 个数量级——scan-edge §1.2）。
- 两个必建件：①**元素句柄（snapshot-ref 形态）**——browse 产出从「只读 markdown」升级为「markdown + 可点引用」，CC 能接着交互而不是重抓整页（agent-browser/Playwright MCP 双先例）；②**回合内人工确认（elicitation 形态）**——高风险操作从「中断重来」升级为「弹窗确认后续跑」（CC v2.1.76+ 支持，S：scan-mcp-proto ②）。

---

## 4. 从零设计总图

### 4.0 设计原则（编号引用后续用）

- **D1 groundedness>synthesis**（M1）：不外包综合；指标=每 token 的 groundedness。
- **D2 类型优先路由**：先分信息类（I1-I6）与语言（CN/EN），引擎降级发生在类型路径**内部**——不是所有查询挤同一条引擎链。
- **D3 溯源强制**：每条返回带 URL + served_by 归因（groundedness 的可审计形态）。
- **D4 缓存一等公民**（M3 + 单用户 C2）：按信息类型分 TTL 的本地结果缓存。
- **D5 输出 token 预算**（C8）：返回前裁剪；全页 markdown 是违约形态。
- **D6 免费本地兜底强制**（C3）：每条路径终点是 $0 本地选项或结构化诚实失败。
- **D7 骑乘厂商原生**（C5）：机器 MCP 是 tier-0，不自建引擎集合的幻象。
- **D8 stdio + SQLite + 零守护**（C2/C7）。

### 4.1 分层架构（七个面 + 五个跨切面）

```
┌─ P0 路由面：查询 → {I1..I6} × {CN|EN} × {阻塞|容忍} × {缓存命中?}
├─ P1 机器原生面：智谱 web-search-prime MCP（tier-0）；Gemini grounding 5k/月（候选第二源）
├─ P2 融合检索面：Brave LLM Context（EN/质量）｜智谱（CN）——「搜+抽+裁剪」单跳
├─ P3 直达源面：本地 fetch → r.jina.ai（无 key 20 RPM）→ browse_headless（11s）→ Wayback
├─ P4 垂直面：grep MCP（推荐）/ GitHub Releases+issues / fetch_feed（RSS/Atom 无状态原语）
├─ P5 本地私面：SQLite FTS × {Chrome History, Apple Notes, mdfind, 剪贴板}
├─ P6 交互面：browse_logged_in + desktop AXAPI + 元素句柄 + 回合内确认
├─ X1 结果缓存（SQLite，分型 TTL）      X2 查询相关裁剪（BM25/link-density，内建）
├─ X3 溯源归因（served_by + URL）       X4 配额账本（免费层先耗尽 + 成本上限）
└─ X5 降级与熔断（每路径终点=免费本地或诚实 didnt）
```

### 4.2 主 L-COST 表（单次「拿到可用上下文」全成本；token 列=典型输出）

| 路径 | 延迟 | $/1k | 输出 token | 免费额度 | 故障路径（必列） |
|---|---|---|---|---|---|
| X1 缓存命中 | **<10ms** | **0** | 已裁剪 | 无限 | miss 即透明落正常链 |
| P1 智谱 MCP | ~1-2s（E） | token 制 | ~1-2k | 套餐 100-4000 次/月 | → P2 |
| P2 Brave LLM Context | p90 <600ms | $5 | 预算制 8192 | $5 月赠≈1k（需绑卡） | 限流/无 key → P3 |
| P2 智谱（CN） | ~1s（E） | token 制 | ~1-2k | 赠送额度 | → P3 |
| P4 fetch_feed | 200-500ms | 0 | 条目列表 ~0.5-1k | 无限 | feed 死 → SERP freshness |
| P4 GitHub Releases/issues | 0.5-1s | 0 | 结构化小 | 60 req/h 无 token | → SERP |
| P4 grep MCP | 200-500ms（E） | 0 | 小 | 免费 | → P2 代码类查询 |
| P3 本地 fetch | 0.3-2s | 0 | 裁剪后 1-3k | 无限 | 反爬拦截 → r.jina.ai |
| P3 r.jina.ai | 7.9s 均值（官方保守值） | 0（无 key 20 RPM） | 全文（需 X2 裁剪） | 20 RPM 无注册 | 被拦（不绕反爬）→ headless |
| P3 browse_headless | **~11s 冷启动** | 0 | 裁剪后 1-3k | 无限 | → Wayback 存档 |
| P3 Wayback | 1-3s | 0 | 同上 | 无限 | → 诚实 didnt |
| P5 本地 FTS | **<10ms** | 0 | 小 | 无限 | 0 命中 → 判定「网上才有」转 P2 |
| P6 交互（原语级） | 秒级/步 | 0 | 小 | 无限 | 高风险 pattern → 回合内确认 → 诚实 didnt |
| P6 GUI agent 循环（兜底） | 15s-3min | $50-500（$0.05-0.5/task） | 大 | — | 仅作最后兜底 |
| （对照）Claude 原生 web_search | — | $10 + 内容 token | — | 订阅点用免费 | **本用户 relay 场景不存在（C1）** |
| （对照）Gemini 3 grounding | — | $14 | — | **5k 次/月** | CN 可达性未实测（挂账） |
| （对照）Exa deep | 4-12s | $12 | 大 | $10/月赠 | 仅浅检索不足后升级 |

### 4.3 路由面伪码（设计核心，一段说清）

```
route(q):
  if cache.hit(q, ttl_by_type): return cached            # D4
  t = classify(q)  # {code|error|fresh|research|private|interactive} × {cn|en}
  switch t.type:
    private:   return local_fts(q) or fallback P2          # I5
    error:     github_issues(q) → serp(site:so) → P2      # I2 精确匹配优先
    fresh:     feed_or_release_api(known_source(q)) → P4 serp(freshness) # I3 推模型优先
    code:      P1 → P2(context 模式) → P3 直达 docs       # I1
    research:  P2(cn|en) → [可选] deep 检索                # I4
    interactive: P6（带句柄与确认）                         # I6
  all paths: trim_to_query(q) → attach provenance → ledger.charge() → cache.put(q, ttl[t])
  any failure: 降级到下一跳；尽头 = 诚实 didnt（结构化，非静默）
```

关键差异点（相对「一条引擎链打天下」）：**error 走垂直、fresh 走推模型、private 根本不出网**——这三类在纯引擎降级链里都被迫用通用 SERP 解，慢且贵且错源。

### 4.4 明确不做清单（零基也有边界）

| 不做 | 理由 |
|---|---|
| 常驻 RSS 聚合（Miniflux/RSSHub 自托管） | C7 守护进程红线；fetch_feed 天然兼容外部聚合产物 |
| 「搜索即回答」API 主路径（Sonar 形态） | M1；与 CC 推理链重复且注入外部模型错误 |
| 自建代码搜索引擎/索引 | D7；官方 Grep MCP 免费存在，自建=负价值 |
| 本地 embedding 全量入库 | C6 Intel CPU；FTS 先行，embedding 留观察 |
| 截屏式全量记忆（Recall 形态） | C6+C7；资源否决 |
| 自建 GUI agent 框架 | CC 已是 agent，库内套 agent 是冗余（scan-edge §1.3）；只借 snapshot-ref 表示法 |
| P2P/去中心化检索 | 检索层生态未解决，对「拿到信息」零贡献（scan-edge §3） |
| 模型 sampling 借 LLM | 协议已弃用+CC 从未支持，双负（scan-mcp-proto ①） |

---

## 5. diff 清单（此时才读 Lasso 源码）

> 已读：`src/tools/search.ts`（784 行全文）、`src/channels/SearchChannel.ts`（ZhipuSearchChannel）、`src/channels/BraveChannel.ts`、`src/search/SearchCache.ts`、`src/browse/markdown-extractor.ts`、`src/browse/HighRiskGate.ts`（头 60 行）、`src/serp/extract.ts`（头 60 行）、`src/serp/http-serp.ts`（头 20 行）、`src/serp/SelectorRegistry.ts`、`src/tools/fetch-url.ts`（头 80 行）+ 全 src grep（jina/feed/rss/elicitation/grep.app/local-history/uid）。
> 差距性质三分类：**本质缺失**（零基要、现状无、取舍论据不成立）/ **合理取舍**（零基要、现状无、但有明确红线或成本论据）/ **现状超出**（Lasso 有、零基没想到——诚实双向对账）。

### 5.1 先立基线：零基设计里 Lasso **已有**的部分（防夸大差距）

| 零基件 | Lasso 现状（源码实证） | 对齐度 |
|---|---|---|
| X1 结果缓存 | `SearchCache`：7 天 TTL、LRU 1000、key=query\|engine\|region\|limit\|freshness（INV-11）、分片落盘 | **有**（差分型 TTL，见 ZB-3） |
| X3 溯源归因 | `attributed=true` → served_by 标签每条结果；全链 retrieval_method 审计 | 完整 |
| X4 配额账本 | QuotaLedger 多 Key 池 + free_only L1-L4 + RPM 滑动窗 + CallerTierTracker + 配额感知扇出 allocateLimit | **超出零基草描** |
| P1 机器原生 tier-0 | MachineMcpSearchChannel（智谱 web_search_prime MCP 复用，INV-72 注入式） | 有（单供应商；Gemini 第二源=观察项） |
| P3 直达源 | fetch_url（SSRF 守卫+48KiB envelope+3 类 extract_mode）→ browse_headless（11s）→ wayback_lookup（独立 tool） | 有（差 r.jina.ai 中间层，见 ZB-9） |
| I3 时效过滤 | `freshness=day/week/month/year` 透传智谱/Brave/ddg（v1.11 T6）+ 入 cache key | 过滤有（推模型无，见 ZB-4） |
| 语言路由 | CJK→百度 / 非CJK→DDG→Brave SERP 级联（extract.ts）；zhipu/brave 扇出带 region CN/US | 有 |
| D6 免费兜底 | machine_mcp→zhipu→brave→serp_http(~1s 快探)→browse_headless→recording_replay 全链 + tri-state 诚实 didnt | 有且成熟 |
| P6 交互原语 | click/fill 接受 uid（透传底层 chrome-devtools-mcp 自身 ref 系统）；HighRiskGate 高风险熔断 | 半有（见 ZB-7） |

### 5.2 ZB-N 差距清单（按 价值×可实施性 排序）

**ZB-1（本质缺失，最高优先）：融合检索层（P2）整体不存在——两跳是唯一路径。**
源码实证：ZhipuSearchChannel 与 BraveChannel 均只返回 `{title,url,snippet,source}`（两文件 parse 函数），BraveChannel endpoint 钉死 `/res/v1/web/search`，无 `/res/v1/llm/context` 变体；grep 全 src 无 "llm/context"。零基 §1.3-M1/M2 与 scan-agent-api §0-U2-U4 同判：**搜索→挑选→抓取的三跳成本（英文路径 API 命中后仍要 11s 级 browse 才有内容）是当前架构最大的结构性浪费**。同 key 同鉴权改造集中 BraveChannel 内部（R1 级小 GO：$5/1k、p90<600ms、8192 token 预算制）。
注意：8192 默认输出比 10 蓝链大——**必须与 ZB-2（裁剪）配套**才不违反 D5。

**ZB-2（本质缺失）：查询相关裁剪（X2）不存在——抽取是查询无关的。**
源码实证：`extract_mode=raw/markdown/markdown_cited` 三档均无 query 入参（markdown-extractor.ts 全文 + browse.ts grep "query" 零命中）；defuddle 抽正文去样板，但不按查询裁剪；48KiB output envelope 是钝刀安全帽不是 token 预算。零基 §2-C8：全页 10-50k token 比裁剪后浪费 5-10×。修法内化（BM25/link-density，Crawl4AI fit_markdown 模式，markdown-extractor.ts 头注释自己引了 Crawl4AI 但只引了转换没引裁剪）。这是 ZB-1 的配套件，也是独立成立的（现存 browse/fetch 路径立刻受益）。

**ZB-3（本质缺失·小）：cache TTL 与 freshness 未耦合——「day 新鲜」可被缓存成「7 天陈货」。**
源码实证：SearchCache.ts:34 `TTL_MS = 7天` 常量；`get()` 只看 mtime 与 TTL_MS，freshness 仅入 key 不入 TTL（SearchCache.ts:66）。后果：freshness=day 的查询在第 6 天命中缓存时，返回的是 6 天前筛的「过去一天」结果且无任何陈旧标记。零基 D4 要求分型 TTL；最小修=TTL 取 `min(7d, freshness 窗口)`（day→24h、week→7d 恰好重合、month→30d 封顶 7d 不变）。约 10 行。

**ZB-4（本质缺失·小）：freshness 推模型原语（P4 fetch_feed）不存在。**
源码实证：grep 全 src "rss/atom/fetch_feed" 零命中（仅 ResourceMonitor 的内存 RSS 误命中）。I3 类查询（本用户画像 15-20%）只有「过滤已索引」一解，无「直接问源」一解。scan-edge §4.4 已裁：无状态纯函数、~百行、零守护、$0、200-500ms。最小 GO 形态明确。

**ZB-5（本质缺失·范围裁决）：本地私有数据搜索（P5）整类不存在。**
源码实证：grep "chrome history/apple notes/mdfind/spotlight" 零命中。I5 类（零基 §1.2 估 5-10% 且增长中）完全无路径。差距性质是「本质缺失」，**但落法是范围裁决不是工程问题**：并入 Lasso（第四通道）vs 独立 MCP（边界纯净）——scan-edge §2.4 已交用户。零基视角补充：单用户日常价值密度可能高于任何对外搜索链优化（查自己历史的频率 > 查冷门网络信息），且 FTS<10ms/$0/零守护全合红线。

**ZB-6（本质缺失·小）：高风险交互无「回合内确认」——elicitation 零接线。**
源码实证：grep 全 src "elicitation" 零命中；HighRiskGate.ts 头注释明示现行语义「放弃自动操作，升级用户（不做也不继续）」→ didnt + StepEngine stop，用户须重发整轮。scan-mcp-proto ② 已裁：CC v2.1.76+ 支持、capability 未声明时降级回现行 didnt、≈100-200 行、安全模型不变（INV-14 pattern 表仍写死）。

**ZB-7（部分缺失·决策项）：抽取产物不带交互句柄——「读」与「点」断链。**
源码实证：HighRiskGate.ts:204 自注「data-lasso-uid（Lasso **未来**在 snapshot 注入）」——自产 uid 表示法是**规划未实施**；现行 click/fill 的 uid 是底层 chrome-devtools-mcp 自己的 ref 透传（BrowseChannel.ts:903-906）。含义：CC 拿到 Lasso 的 markdown 抽取后无法就地续交互，要么自己再跑一次底层 snapshot、要么重抓。零基 P6 要求「markdown + 可点引用」一体（snapshot-ref 形态；Playwright MCP #1 与 agent-browser 双先例——scan-edge §1.3/scan-mcp-proto ⑦）。差距=半供给：透传有、自产无。属决策项（改抽取输出形状=接口变更）。

**ZB-8（合理取舍，登记不实施）：r.jina.ai 免费抽取兜底层缺失。**
源码实证：grep "jina" 仅命中 types.ts 许可证注释与 FreeTierRouter 文档注释（列在 L2/L3 分级里但无实现）。取舍论据成立：①fetch_url 铁律 INV-23 禁 fetch↔browse 互 fallback（单 fallback 引擎红线）；②7.9s 官方均值对 11s 冷启动优势有限；③CN 可达性未实测。零基补充唯一翻转条件：若做成**独立 tool**（非互 fallback，caller 显式选）则不触 INV-23——但当前收益不足以立项，挂观察名单（同 scan-agent-api R5）。

**ZB-9（合理取舍+文档级欠账）：垂直检索（I1 代码/I2 错误的专用路径）缺失。**
源码实证：无 GitHub issues/Releases 原语；doctor grep「建议/recommend/加装」零命中（无 grep MCP 生态建议）。取舍论据：CC 自带 Bash+gh/curl 可直达 GitHub，能力不缺——Lasso 不建是边界正确（D7 同精神，scan-edge §5.3「该认不该建」）。**残余欠账是文档级**：doctor/README 无「常写代码→建议加装 Grep MCP」一行（零基 §3-I1 路径 3 的最小落点）。另注：报错串这类高熵查询当前挤通用 SERP 链，`site:github.com` 类语法靠 caller 自己拼——能力可达但无缓存/归因加持（弱缺）。

**ZB-10（现状反超登记）：Lasso 有、零基草描没想到的件。**
诚实对账（方法论要求双向）：①RecordingStore 录制回放兜底（全源熔断后 served_by="recording_replay"）——零基 §4 只设计了「诚实 didnt」终点，回放是更软的终点；②SerpHealthMonitor+SelectorRegistry 版本化 selector（SERP 是债的工程化还债）；③stealth-evasions 反检测面；④tri-state outcome（worked/didnt/unknown）语义纪律——零基只写了「诚实失败」，未区分「确定性否」与「暂时不明」；⑤CallerTierTracker per-caller 配额（多 agent 治理超出单用户零基需求）。这些不改变 ZB-1..9 的差距判定，但说明差距集中在**信息形态层**（内容/裁剪/新鲜度/私有），不在**可靠性治理层**（Lasso 的强项）。

### 5.3 diff 汇总表

| # | 差距 | 性质 | 体量 | 优先 |
|---|---|---|---|---|
| ZB-1 | 融合检索（Brave LLM Context 模式） | 本质缺失 | 小（单 channel 内） | **1**（与 ZB-2 配套） |
| ZB-2 | 查询相关裁剪（BM25 分型裁剪） | 本质缺失 | 中（抽取层内化） | **2** |
| ZB-3 | cache TTL×freshness 耦合 | 本质缺失（正确性） | 极小（~10 行） | **3** |
| ZB-4 | fetch_feed 推模型原语 | 本质缺失 | 小（~百行新 tool） | **4** |
| ZB-5 | 本地私有搜索（FTS） | 本质缺失→范围裁决 | 大（决策文档先行） | 5（交用户） |
| ZB-6 | HighRiskGate elicitation 化 | 本质缺失 | 小（100-200 行） | 6 |
| ZB-7 | 抽取产物交互句柄 | 部分缺失→决策项 | 中（输出形状变更） | 7（交用户） |
| ZB-8 | r.jina.ai 兜底 | 合理取舍 | — | 观察名单 |
| ZB-9 | 垂直检索原语+doctor 生态建议 | 合理取舍+文档欠账 | 极小（文档） | 顺手做 |
| ZB-10 | （反向）可靠性治理件超零基 | 现状反超 | — | 无动作 |

## 6. 来源清单

| # | 声称 | 来源 | 级别 |
|---|---|---|---|
| Z1 | code search 激增；docs/changelogs/issues 专门管线；correctness 聚 ~86% 而 groundedness 分化；Claude web_fetch 12% 空返回/signal 55.1/长度 1x-13x | exa.ai/blog/webcode（2026-03-23，本轮 webReader 亲读） | S |
| Z2 | CC WebFetch：URL+prompt 必填、15-min TTL 缓存、100KB 截断、Haiku 3.5 二级过滤、125 字符引用帽、域名单 claude.ai/api/web/domain_info；WebSearch 只取 title+url 丢弃 page_age；Bedrock/Vertex 隐藏 WebSearch | mikhail.io/2025/10/claude-code-web-tools（2025-10-06 运行时逆向，本轮亲读） | S（逆向） |
| Z3 | relay 场景原生 WebSearch 不存在（四源交叉） | scan-model-native C1（知乎/linux.do/cc-switch#2570/cc-haha#228） | C |
| Z4 | Brave LLM Context $5/1k、p90<600ms、8192 预算制、$5 月赠需绑卡 | scan-agent-api §1（官方博客+文档亲取） | S |
| Z5 | Exa/Brave/Tavily/Firecrawl/Jina 全成本表；抽取即战场（U2-U4） | scan-agent-api §7 | S/C 混（表内标注） |
| Z6 | 本地个人搜索：组件成熟/成品真空/FTS<10ms vs embedding 入库数十分钟 | scan-edge §2（Rewind 官方时间线+组件事实） | S |
| Z7 | fetch_feed 200-500ms 零守护；RSS=唯一确定性 freshness 推模型 | scan-edge §4 | S/C 混 |
| Z8 | GUI agent 15s-3min、$0.05-0.5/task；snapshot-ref 是可借核心 | scan-edge §1 | C |
| Z9 | elicitation CC v2.1.76 支持；sampling 协议弃用+CC 0 支持 | scan-mcp-proto ①②（CHANGELOG 5163 行全量解析） | S |
| Z10 | 原生搜索吸收曲线完成（OpenAI 2026-07-23 关停/ Gemini 3 $14+5k 免费/SimpleQA 72.1%） | scan-model-native §2-§3（官方页亲取） | S |
| Z11 | CC 查询类型占比 | 无硬数据；本文 §1.2 推理（锚 Z1+用户档案） | **E** |
| Z12 | §5 差距判定全部源码实证（通道返回形状/endpoint 钉死/TTL 常量/无 query 入参/elicitation·feed·jina·本地搜索 grep 零命中/uid 透传与「未来注入」自注） | 本轮亲读：src/tools/search.ts、src/channels/{SearchChannel,BraveChannel,BrowseChannel}.ts、src/search/SearchCache.ts、src/browse/{markdown-extractor,HighRiskGate}.ts、src/serp/{extract,http-serp,SelectorRegistry}.ts、src/tools/fetch-url.ts + 全 src grep | R |
