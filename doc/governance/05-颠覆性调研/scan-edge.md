# 边缘范式扫描：非主流但有颠覆潜力的信息获取范式

> 2026-08-17 ·「24-颠覆性调研」系列 · 边缘范式调研员产出
> 方法论纪律（doc/governance/04）：①零基视角（用户要什么/约束是什么），不从「与 Lasso 对比」出发；②每条发现附成本/延迟数据（L-COST）；③禁把「开源项目都这样做」当最优证据。
> 诚实边界：本机 `gh` token 失效、api.github.com 被网络策略拦截，star 数均来自二手来源（已在各条标注）；Grep MCP 的免费额度细节未能打开 vercel.com 验证（域名被拦），标注为「待核」。搜索工具（web-search-prime）本轮超时一次，部分查询换了措辞重试。

## 0. 零基问题定义（先于一切对标）

单用户 CC 场景下，用户的信息需求按「数据在哪」分五类，这是本轮扫描的真实坐标系：

| # | 需求类 | 典型问句 | 现在的解法 | 解法的真实缺口 |
|---|---|---|---|---|
| A | 公开网络信息 | 「X 是什么/最新动态」 | Lasso search 降级链 | 索引滞后（SERP 索引小时~天级） |
| B | 需交互/登录才可达的信息 | 「看我在 Jira 的待办」 | browse_logged_in / desktop | 无 Agent 循环的标准化原语（元素定位靠运气） |
| C | **用户自己机器上的信息** | 「我上周看过的那篇文章在哪」 | **无**（claude-mem 只记对话） | 整类缺失（见 §2） |
| D | 抗删除/抗封锁的信息 | 「被删的那页说什么」 | Wayback 存档（Lasso 已有） | 已覆盖中心化存档 |
| E | 结构化代码知识 | 「别人怎么实现 X」 | 通用 web 搜索 | 垂直缺口（见 §5） |

**一句话结论**：五个边缘范式里，「搜自己的机器」（C 类）是唯一整类缺失且零竞品存活的方向（macOS 上 Rewind 已死）；RSS 解 freshness（A 类缺口）是成本最小的 GO 项；GUI agent（B 类）是「可借技术」而非「该建的东西」；P2P（D 类）低价值；代码搜索（E 类）该「接入」不该「自建」。

---

## 1. GUI Agent 搜索（browser-use / Skyvern / AgentQL / agent-browser）

### 1.1 成熟度扫描

| 项目 | 数据 | 来源 |
|---|---|---|
| browser-use | ~93K stars / 10.6K forks，GitHub 最火 AI 浏览器自动化 | 稀土掘金 2026 实测文（juejin.cn/post/7639553012621869090） |
| browser-use 架构 | Agent 循环 = DOM 序列化 + 截图 → LLM → CDP 动作；按模型自动配置（Claude Sonnet 截图尺寸、无视觉模型自动关截图、精调模型走 flash 模板）；有独立的 Judge/循环检测模块 | zread.ai/browser-use/browser-use（7-Architecture、9-System Prompts、13-DOM Serialization） |
| Vercel agent-browser | 2026-01 发布，约一个月 25K~27K stars，Apache-2.0，Rust CLI + Node 兜底；**用「snapshot ref」替代 DOM selector** 给 agent 引用元素；空闲 1h 自动关浏览器 | github.com/vercel-labs/agent-browser；cnblogs/itech/p/19824550；CSDN mcp.csdn.net（2.5万星）；reddit r/ClaudeAI「snapshot-based refs instead of DOM selectors」 |
| Skyvern | 视觉优先（Vision LLM 学页面），WebVoyager 85.85%；定价 Free 5,000 credits / Hobby $29/月 30k / Pro $149/月 150k（2026-01-30 从 $0.05/step 改为 credits 制） | Firecrawl 2026 浏览器 agent 横评；skyvern.com/pricing；Skyvern 官方博客 Launch Week Day 5 |
| AgentQL | 查询语言 + 抽取型（非全自主循环），2026 横评里定位为「结构化抽取」一档 | Unbrowse/Firecrawl 2026 横评 |
| rtrvr.ai 自报 | $0.12/task、Web Bench 81.4% | rtrvr.ai 官方博客（**厂商自报数据，慎用**） |

### 1.2 L-COST 成本模型（零基：用户为一次信息获取付出什么）

| 路径 | 延迟 | 金钱 | 备注 |
|---|---|---|---|
| Lasso serp_http 快探 | ~1s | $0（免费层/自托管） | doc/governance/04 已确认的成本序基准 |
| Lasso browse_headless | ~11s 冷启动 + 整棵 Chromium 资源 | $0 | 同上 |
| GUI agent 单任务 | 15s–3min（5–20 步 × 每步 1 次 LLM 调用） | $0.05–0.5/task（按 Sonnet 级每 call $0.01–0.05 × 5–20 步估算；Skyvern 曾明码 $0.05/step） | **比 API 慢 1–2 个数量级、贵无穷倍** |
| Skyvern 云 | — | Free 档仅 5k credits/月 | 走云 = 数据出本地，违反 Lasso 隐私默认 |

### 1.3 与 Lasso 的关系：不是竞品，是「因子分解差异」

GUI agent 框架把 **Agent 循环做进库/云**（browser-use 库内循环、Skyvern 云循环）；Lasso 把**交互原语做进 MCP、循环留给 CC 本体**。两者是同一问题空间的两种因子分解，不构成替代关系——CC 装 browser-use 反而多了一层「库内套 agent」的冗余（CC 已是 agent）。

**真正可借鉴的三个点**：
1. **snapshot-ref 元素引用**（agent-browser 的核心创新）：Lasso browse 目前产出 markdown（人读友好、agent 不可点）。给抽取结果附「元素引用句柄」（如 `[ref:12]` + 可执行 click(ref:12)），CC 就能在一次 browse 后继续交互，而不是重抓整页。这是把 browse 从「只读快照」升级为「可交互句柄」的最小改动方向。
2. **DOM 序列化格式**（browser-use 的 indexed-element 序列化）：Lasso 的 markdown 抽取剥掉了可交互性，browser-use 的序列化证明「给 LLM 的页面表示」和「给人读的正文」应该是两种产物。
3. **循环检测/Judge**：desktop 坐标点击重复失败时需要同款「卡死检测」逻辑。

### 1.4 颠覆性评分：**中**

理由：对「搜索」这个具体动作颠覆性低（成本/延迟比 API 差 1–2 个数量级，只配当最后兜底——Lasso 降级链末端已是 browse/replay，位置正确）；但对「可达性」颠覆性高——anti-bot/登录态/app 化页面越来越多，**视觉 agent 是唯一还在扩张的可达性边界**，而它utable 的技术（snapshot ref、DOM 序列化、视觉 grounding）恰好是 Lasso browse/desktop 两条通道的补强方向。不建 agent 框架，**借它的页面表示法**。

---

## 2. 本地个人数据搜索（浏览器历史/笔记/文件/剪贴板 + embedding）

### 2.1 关键事实（这类产品的生死簿）

| 事实 | 来源 |
|---|---|
| **Rewind（macOS 旗舰「人生搜索引擎」）被 Meta 收购后于 2025-12-19 全面停服**，屏幕/音频录制全禁用 | rewind.ai/what-happened-to-rewind；IT之家 0/902/875.htm |
| Microsoft Recall 仅 Windows 11 Copilot+ PC；本地加密语义索引 + 每几秒截屏；因隐私争议多次推迟/调整 | Microsoft Learn（Recall 概述）；Tuta/Proton/AdGuard 批评文 |
| **macOS 上「搜自己看过什么」的成品真空**：Rewind 死、Recall 不上 mac、Limitless 转可穿戴后被收购 | 同上 rewind.ai 时间线 |
| Karakeep（原 Hoarder）0.24.0 起内置 MCP server，自托管书签 + AI 打标（支持本地 Ollama） | github.com/karakeep-app/karakeep；r/selfhosted 发布帖 |
| 底层组件全部成熟：Chrome 历史库=SQLite（History）、Apple Notes=SQLite（NoteStore.sqlite）、文件=mdfind/Spotlight、向量=sqlite-vec（纯 C 无依赖，vec0 虚表） | mac-forums/Apple 支持；github.com/asg017/sqlite-vec |
| 本机现状：claude-mem 插件只覆盖**对话记忆**，不覆盖浏览/笔记/文件历史 | 本机环境事实（MEMORY.md） |

### 2.2 L-COST（零基 + 本机真实约束）

**本机硬约束（常被调研忽略）**：用户主力机是 2015 Intel MBP（Darwin 21.6.0/macOS 12）。这直接否决一批「理所当然」的方案：

| 方案 | 延迟 | 金钱/资源 | 在本机的真实表现 |
|---|---|---|---|
| 关键词/FTS（SQLite FTS over 浏览历史 + mdfind 文件 + Notes SQLite） | <10ms | $0，零后台进程 | **完全可行**，今天就能答「我看过含 X 的页面」 |
| 本地 embedding（Ollama nomic-embed + sqlite-vec） | 查询 <50ms；**入库极慢** | 模型 500MB+；50k 条历史在 Intel CPU 上约数十分钟起 | 半可行——一次性入库痛苦，增量尚可 |
| 云 embedding（智谱 embedding-3，约 ¥0.5/M tokens 量级） | 快 | 便宜 | **隐私代价**：浏览历史全文出境，与 Lasso「数据不出本地」默认相悖 |
| Recall 式全量截屏+OCR | — | 每天数 GB + 持续 CPU | 否决：违反简单架构红线，且 mac 无官方 API |

### 2.3 零基判断

用户问句「我上周看过一篇讲 X 的文章在哪」——今天 CC 无法回答，这不是优化问题是**整类缺口**（上表 C 类）。而 2025-12 之后 macOS 上没有存活产品占这个位置（Rewind 之死证明了需求真实——Meta 花钱买它——也证明了「全量录屏」形态不被接受；成品真空）。**正确形态不是 Recall（录一切）而是「结构化本地源 + FTS 为主 + embedding 为辅」**：Chrome 历史 / Apple Notes / mdfind / 剪贴板，全是现成 SQLite/系统索引，无后台守护、零成本、纯本地——完全符合 Lasso 三条红线（本地/单用户/简单架构）。

### 2.4 与 Lasso 愿景契合度：**高（但身份有张力）**

Lasso 自我定义是「**对外**交互抓手」；搜自己的机器是「**对内**」。两种落法：
- **并入 Lasso**：作为第四通道 `search_local`（与 search/browse/desktop 平级）——符合「所有外部交互归一个 MCP」的收纳哲学的镜像版「搜自己的机器也归一个 MCP」；
- **独立新 MCP**：保持 Lasso 边界纯净，另起 memory-sibling。

这是**范围裁决问题，交用户**，不是技术问题。技术侧无障碍。

### 2.5 颠覆性评分：**高**

理由：①整类缺失（不是 Lasso 现有链上任何一层的优化）；②竞品真空（macOS 存活产品=0）；③成本趋零（纯本地 FTS）；④对单用户日常价值密度可能高于任何一条对外搜索链（人查自己历史的频率高于查冷门网络信息）；⑤完全符合三条红线。唯一减分：不颠覆 Lasso 现有架构——它是**加法**，不是替代。

---

## 3. P2P / 去中心化（IPFS / Arweave 永久存储检索）

### 3.1 成熟度扫描

| 事实 | 来源 |
|---|---|
| IPFS 不保证持久（pin 才活），网关「比 CDN 稍慢」，内容寻址≠内容发现 | BlockEden 对比文（blockeden.xyz）；Permadao/Medium 生命周期对比 |
| **去中心化存储的全文检索基本未解决**：ipfs/archives 官方 issue #8「归档是一回事，能搜索是另一回事」；ipfs-search.com 是独立爬虫式引擎（能力有限）；Arweave 检索只有 tx 元数据 GraphQL，无内容级搜索 | github.com/ipfs/archives/issues/8；ipfs-search.readthedocs.io |
| Arweave 一次付费永久存储；2026 生态重心在 AO/计算而非检索 | arweave.org 官网 |
| Lasso 已有 Wayback 存档兜底（「链接打不开找存档」README 功能表） | lasso README |
| 用户网络环境：TUN 代理 + fake-ip，实时协议路由敏感；去中心化网关在此环境可靠性存疑 | 项目记忆 network-proxy-environment（内部事实） |

### 3.2 L-COST

| 路径 | 延迟 | 可靠性 |
|---|---|---|
| Wayback（Lasso 已有） | ~1–3s | 高（中心化但稳定） |
| arweave.net 网关 | ~0.5–3s | 中（国内网络不稳，无实测数据——标注为定性判断） |
| IPFS 公共网关 | 秒级~超时 | 低（pin 依赖 + 网关限流） |

### 3.3 零基判断与颠覆性评分：**低**

用户要的是「拿到那条信息」，不是「那条信息的存储协议」。去中心化唯一的差异化价值是**抗审查/抗删除**，但：①该需求在 Lasso 已被 Wayback 覆盖大半；②检索层（真正的瓶颈）生态未解决——「存了但搜不到」等于对信息获取范式零贡献；③国内网络下的网关可靠性劣化。**不在本轮任何 GO 考虑内**；观察项仅一个：若未来出现高质量 permaweb 全文搜索引擎再重评。

---

## 4. RSS / 播客 / 时事 firehose 的 Agent 化（freshness 的真实解法）

### 4.1 零基：freshness 需求的机制分析

SERP 索引滞后小时~天级，LLM 问答引擎更差（训练截止 + 索引滞后双杀）。Lasso v1.11 的 `freshness=week` 过滤只是**过滤**已索引内容，不解决「源头的实时性」。机制上唯一确定性的 freshness 解法是**推模型**：RSS/Atom——发布即推送，零索引滞后。

### 4.2 成熟度扫描

| 事实 | 来源 |
|---|---|
| RSSHub：MIT 开源「万物皆可 RSS」，适配数百站点上千路由，含微信公众号等 CN 特有源；生态巨大 | github.com/DIYgod/RSSHub 及 issue #16152（公众号路由讨论） |
| wewe-rss v2.x：基于微信读书的公众号订阅，比 RSSHub 公众号路由更稳定，支持历史文章+定时更新 | github.com/cooderl/wewe-rss |
| Miniflux：Go 单二进制 + PostgreSQL，极简自托管 RSS 阅读器，2026 年口碑文称「最好的 RSS 阅读器」 | rye.dev/blog/rss-miniflux-2026；ssdnodes 自托管对比 |
| **RSS×MCP 已有先例**：miniflux-mcp（管理 feeds/entries/categories）；Karakeep MCP | github.com/tan-yong-sheng/miniflux-mcp |
| Podcast Index API：**免费开源**，~4M+ feeds，RSS 元数据级检索 | podcastindex-org 官方 API 文档；Podchaser 2026 播客 API 横评 |
| Listen Notes API：免费档 + Pro/Enterprise 付费；转写走 Listen411（1 小时音频 60 秒转完，$4.60/小时） | listennotes.com/api/pricing；Listen Notes help #35 |

### 4.3 L-COST

| 方案 | 延迟 | 成本 | 架构代价 |
|---|---|---|---|
| **`fetch_feed`（按需拉取+解析单个 RSS/Atom URL）** | 200–500ms（单 HTTP + XML 解析） | $0 | **零**（无状态纯函数，无守护进程） |
| 自托管 Miniflux 常驻轮询 | 查询 <10ms | $0 + ~50–100MB RAM（复用现有 Docker） | 引入常驻服务 + PostgreSQL——**简单架构红线的边缘** |
| 自托管 RSSHub（公众号等 CN 源） | 按需 | $0 + Docker | 同上，且路由维护是别人的项目负担 |
| 播客转写（本地 Whisper） | ≥1x 实时长（Intel CPU 更糟） | 高 CPU | 否决级 |
| 播客转写（Listen411 云） | 1h→60s | $4.60/h | 付费+数据出境 |

### 4.4 与 Lasso 契合度与颠覆性评分：**中-高（仅限最小形态）**

拆开评：
- **`fetch_feed` 原语（GO 级）**：给 CC 一个「拉任意 feed URL → 结构化条目列表」的无状态工具。它把 freshness 问题从「等索引」变成「直接问源」。~百行代码、零依赖守护、零成本、不碰任何红线。对「今天/最新」类查询，配合 CC 自己挑源（官方博客的 feed 常在页头 `<link rel=alternate>` 里——browse 已能发现），是**当前降级链里不存在的一层**。这是本轮调研最小而明确的 GO 项。
- **常驻 RSS 聚合（自托管 Miniflux/RSSHub）**：NO——引入常驻服务与运维面，违反简单架构红线；且用户真需要时可自行部署，Lasso 的 `fetch_feed` 天然兼容它（Miniflux 产出仍是 feed URL）。
- **播客管线**：NO——转写成本（CPU 或 $4.6/h）远超单用户 coding 场景的播客查询频率；Podcast Index 元数据检索可日后作为 `fetch_feed` 的姊妹原语（免费、无状态），优先级低。

freshness 路由（「最新」类查询自动偏好 feed 源）是 fetch_feed 之上的编排层，属 CC 的判断力范围，不必做进 Lasso。

---

## 5. 代码搜索专用（Grep by Vercel / Sourcegraph）

### 5.1 成熟度扫描

| 事实 | 来源 |
|---|---|
| grep.app 被 **Vercel 收购**（2024-11 官宣），现名「Grep by Vercel」，索引 **1M+ GitHub 仓库**，支持 regex/文件/路径搜索 | grep.app 首页；rauchg LinkedIn 官宣（vercel.fyi/grep）；HN 42203245 |
| **官方 Grep MCP server 已存在**：AI agent 经 MCP 检索百万仓库代码索引 | Vercel 官方博客《Grep a million GitHub repositories via MCP》（域名被拦未开原文，**细节待核**） |
| 社区已有 Claude Code Skill 封装（grep.app 检索进 CC） | mcpmarket.com GitHub Code Search (Grep.app) Claude Code Skill |
| Sourcegraph 公开代码搜索免费，2M+ 开源仓库 | sourcegraph.com/search |
| GitHub 自身代码搜索带操作符（语言/repo 过滤）已可用一年+ | HN 42203245 讨论串 |

### 5.2 L-COST 与零基判断

用户问句（CC 高频）：「babel 插件怎么访问 AST 节点」「有没有库处理 X」——通用 web 搜索返回博客/教程（陈旧+SEO 噪声），代码垂直搜索返回**真实用法本身**，延迟同量级（grep.app 免费且快，~200–500ms 量级）。

**关键零基结论：这个能力不该 Lasso 建，该 Lasso「认」**。理由：
1. 官方 MCP 已存在且免费——用户一行命令加装，Lasso 自建 = 复制别人的索引门面，纯维护负担（幸存者偏差检查：不是「开源都自建搜索」所以 Lasso 也该建，恰恰相反）；
2. Lasso 若把 grep.app 私有 JSON 端点包进 search 链，会绑定无 SLA 的非官方接口——重演 doc/governance/03 类型的运营风险；
3. 唯一合理触点：`lasso doctor` 检测到未装代码搜索类 MCP 时给一行建议（「常写代码 → 建议加装 vercel grep MCP」），或 README「生态搭配」段落。这是**文档级**动作。

### 5.3 颠覆性评分：**中（对用户价值）/ 低（对 Lasso 该做什么）**

对 CC 的日常查询结构，代码垂直检索的价值真实且高频（coding 是 CC 第一场景）；但 Lasso 的正确动作是互操作推荐而非建设。规模小、明确、无风险——但严格说它甚至不改变 Lasso 任何代码，只改文档。

---

## 6. 汇总裁决表

| 范式 | 成熟度 | 与 Lasso 愿景契合 | 颠覆性 | 建议动作 |
|---|---|---|---|---|
| ① GUI agent 搜索 | 高（browser-use 93K★、agent-browser 27K★/月） | 中（原语层互补，框架层冗余） | **中** | 借技术不建框架：browse 产出加 snapshot-ref 式元素句柄（决策项，非本轮实施） |
| ② 本地个人数据搜索 | 组件成熟/产品真空（Rewind 死、Recall 不上 mac） | 高（红线全合）但有对内/对外身份张力 | **高** | **产出决策文档交用户**：`search_local` 通道（FTS 优先）并入 Lasso 还是独立 MCP |
| ③ P2P/去中心化 | 低（检索层未解决） | 低 | **低** | 不做；观察 permaweb 全文搜索引擎出现再评 |
| ④ RSS firehose | 高（生态+MCP 先例齐全） | 高（无状态原语形态） | **中-高** | **小 GO 项：`fetch_feed`**（按需 RSS/Atom 解析，零守护零成本）；常驻聚合与播客 NO |
| ⑤ 代码搜索专用 | 高（官方 MCP 免费存在） | 低（不该自建） | 中（用户价值）/ 低（建设） | 文档级：doctor/README 建议加装 Grep MCP |

### 与 doc/governance/04 方法论的对账

- 零基视角生效例证：② 的「整类缺口」在「与对标项目比」框架下永远隐形——对标对象（mcp 手抓取类项目）没有一家做本地历史检索，因为没有「开源都这样做」的背书，五轮审查都不会指向它。
- 成本模型生效例证：④ 中「常驻 Miniflux vs 无状态 fetch_feed」的取舍、② 中「Intel CPU embedding 入库数十分钟 vs FTS<10ms」的取舍，都是只有成本表并排放才刺眼的决策。
- 幸存者偏差豁免生效例证：⑤ 反向使用——「开源搜索工具都自建代码搜索」不成立，官方 MCP 存在使自建成为负价值。

### 诚实的未验证项

1. Grep MCP 的速率限制/免费额度细节（vercel.com 被网络策略拦截，未读原文）；
2. Arweave/IPFS 网关在国内代理环境的实测延迟（无一手数据，仅有定性判断）；
3. browser-use/agent-browser star 数为二手来源，日期截面不完全一致（93K 为 2026 年中文章口径，agent-browser 25–27K 为 2026-01~02 口径）；
4. ② 的本机可行性判断基于 Darwin 21.6.0 = Intel Mac 的推断，未实测 Ollama 在该机的 embedding 吞吐。
