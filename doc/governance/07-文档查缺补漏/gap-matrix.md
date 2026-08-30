# 26-文档查缺补漏 · gap-matrix（文档盘点矩阵）

> 盘点官：文档盘点官（doc/governance/07 首轮）。日期：2026-08-18。
> 盘点基线：`lasso-mcp v1.17.1`（HEAD=`1432bd4`）。**事实基准全部对照源码实核，非凭记忆**：
> - 17 工具（`tools/list` 实跑）：`search / browse_headless / browse_logged_in / desktop / fetch_url / screenshot / pdf / network / read_text / search_local / wayback_lookup / fetch_feed / doctor / interact_roots / interact_observe / interact_act / admin`（`browserbase` / `steel` 两个云通道工具条件解锁，不在默认清单；channel 名 `browse_cloud_browserbase` / `browse_cloud_steel`）。
> - 搜索链（`src/tools/search.ts` runFallbackChainEngine + `src/search/FallbackChain.ts` 实读）：`machine_mcp → brave → serp_http（v1.15 注入时）→ browse_headless → recording replay`。zhipu 直连已删（INV-80 墓碑）、Bing 已删（INV-54 墓碑）。
> - 门禁终态（doc/history/01-功能测试执行记录/ft-00-总结.md 在档）：build 0 错 / **2240 tests（134 files，2227→2240）** / **81 INV** / inv-selftest **20/20** / Rust 以 `cargo test` 实跑为准（doc/governance/01 记 v1.13 为 207；本轮静态计数 src 107 + tests/ 64 = 171，**更新文档时必须实跑确认，禁抄旧数**）。
> - doctor 检查项：`checks.push` 静态计数 40 处（含条件项）——写文档沿用 KEY-GUIDE 先例「**以实跑输出为准，不背数字**」。
> - 铁律：`chrome-devtools-mcp@1.7.0` 版本锁（`LOCKED_CDP_MCP_VERSION` 实核仍为 1.7.0）；INV-65 要求 README/ARCHITECTURE 必引用 08+09（本文档为纯新增文件，不触 INV-65）。
>
> 前身：doc/20-文档同步审计（v1.8→v1.13 审计快照；2026-08-27 结构重整时删除，本目录即其 v1.14 后继，方法沿用：真源 = 源码 + git log，不采信文档自述；原文见 git 历史 2ca2c0b）。

---

## 1. 逐文档盘点总矩阵

新鲜度档位：**A 新鲜**（≤1 版滞后，可不动）/ **B 过期**（滞后但表述不含错）/ **C 失实**（含与现实相反的表述，照行会错）/ **D 缺失**（应有而无）。

| # | 文档（绝对路径省略前缀 `/Users/wangdong/Documents/Project/claude技能/lasso/`；**2026-08-27 仓迁 re-base**：原 `cc-control-all/` 前缀已随外层仓退役失效，其 doc/ 资产已抢救入本仓 `doc/archive/research/` 与 `doc/archive/parse/`，下表 cc-control-all 行按迁移后位置改写） | 行数 | 写到哪个版本 | 新鲜度 | 核心问题（缺什么 / 错什么） | 优先级 |
|---|---|---|---|---|---|---|
| 1 | `lasso/ARCHITECTURE.md` | 337 | v1.13（仅 2 处 d3d1b24/v1.15 局部回补） | **C** | §9.1 链含已删的「智谱」直连 + 违 INV-58 的「→ Wayback」步；缺 serp_http；§11 版本 1.13.0；§7/§8 数字停 1961/79/207/14；§10 文件索引缺 6+ 新模块；缺 v1.14-1.17 全部架构事实 | **P0** |
| 2 | `lasso/doc/architecture/01-功能架构.md` | 442 | **2026-07-21 v0.x 时代基线** | **C** | 四通道定义含「search（智谱 web-search-prime）」、`engine="zhipu"` 默认、分层图「智谱 web-search-prime」盒、F3.5「智谱 http 子进程」——全部失实（INV-80）；F3.12 future 行里 7 项早已交付；F3.8「Google selector」从未实现 | **P0**（处置=加现状横幅，不重写） |
| 3 | `lasso/doc/architecture/02-实施排期.md` | 312 | v1.13（尾注 2026-08-17 增补） | **B+D** | 阶段表缺 **v1.14/v1.15/v1.16/v1.17.0/v1.17.1 五行**；§3 跃升曲线、§4 里程碑同停 v1.13；§2.2「Brave 2000/月」已失实（2026-02 免费档取消）但属历史决策记录需后注不改写 | **P0** |
| 4 | `lasso/doc/usage/01-KEY-GUIDE.md` | 369 | v1.17（时效标注 2026-08-17/18） | **A** | 无实质缺漏（serp_http/zhipu 退役/search_local/content_blocks/--deep/90 天重核制度全在） | P3 保持 |
| 5 | `lasso/doc/usage/02-TROUBLESHOOTING.md` | 332 | v1.13 | **B**（局部 C） | 零覆盖 v1.14-1.17：无 `--deep` 四分类（200/401/403/429）、serp_http、`quality=stale`、`content_status` 失败标注、search_local `notes_deferred_v2`（Apple Notes 诚实 didnt）、elicitation 降级（能力未声明→didnt）、include_refs 句柄失效、IPv6 字面量 SSRF（v1.17.1 剥括号）；§1 示例 `1.13.0`；§7「doc/architecture/02 — v0.1 → v1.0 路径」描述过期且链到外层仓 | **P1** |
| 6 | `lasso/doc/usage/03-SELECTOR-MAINTENANCE.md` | 259 | v1.13 + 1 处 v1.15 回补 | **B** | §1「主路径走结构化 API（智谱 / Brave）」——智谱直连已删（machine_mcp 为载体）；**selector 新消费面 `src/serp/http-serp.ts`（v1.15 裸 HTTP 快探复用同一 selector 集 + bot 探测）全文档未提**；§2.1 示例只写 BAIDU（现实三引擎 BAIDU/DDG/BRAVE_SERP，`selectors.ts` 实核）；§6「加新引擎（如 DuckDuckGo）」示例已过时（DDG v1.11 已在） | **P1** |
| 7 | `lasso/README.md` | 445 | v1.17（changelog 至 v1.17 五项全） | **A** | 无实质缺漏 | P3 保持 |
| 8 | `doc/archive/research/00-总览与落地推荐.md`（原 cc-control-all/doc/00） | 148 | 2026-07-20 调研快照 | **B+D** | 「文档导航」**只索引 00-06，07-18 全部缺号**；无落地状态行——决策树仍推荐「AXAPI 自建 MCP【通识未验证】」而该项目**已产品化为 lasso-mcp v1.18.4（npm）**。**仓迁处置（2026-08-27）**：随外层仓退役抢救入 archive/research/，改判定为**历史快照（B，勿再改）**——P1-4「补导航/落地状态」随仓退役撤销 | 历史快照（原 **P1**） |
| 9 | `doc/archive/research/01..06`（6 份调研，原 cc-control-all/doc/01..06） | — | 2026-07-20 快照 | **B** | 头部无「历史快照」状态标注。**仓迁处置**：同入 archive/research/，P2-2 撤销（快照冻结，不回改） | 历史快照（原 P2） |
| 10 | `doc/archive/research/07,10,11,12,13,14,15,16,18`（原 cc-control-all/doc/ 同名） | — | 各自带日期（07-22~08-15） | **A**（快照性质） | 自洽；其中 18 基线写明 v1.9.0（声明式，无需改）。**仓迁处置**：抢救入 archive/research/；src 注释引用 ×14（doc/archive/research/14 §4.2d / doc/archive/research/16 §5 等）已 re-base 校验成立 | 不动 |
| 11 | `lasso/doc/testing/01,19,20,21,22,23,23a,24,25` | — | v1.7→v1.17.1 | **A** | 当代执行/决策记录，**新鲜，勿动语义** | 不动 |
| 12 | `lasso/doc/README.md`（索引） | — | — | **D** | 17 份编号文档 + 3 份手册无导读（见 §3-②） | **P1**（新建） |
| 13 | 08 F 编号 ↔ 现实映射表 | — | — | **D** | v0.x F 编号大量退役/从未实现/无编号新增，无对照表（本文档 §4 直接产出） | **P0**（已随本文档交付） |

**结构性风险（矩阵外发现，2026-08-27 已消除）**：`lasso/doc/architecture/01` 与 `cc-control-all/doc/architecture/01`、`lasso/doc/architecture/02` 与 `cc-control-all/doc/architecture/02` 曾为 **byte-identical 双拷贝**（`diff -q` 实核）。**随外层仓退役，双拷贝纪律废止——真源唯一 = 本仓 `lasso/doc/`**（08/09 迁移当日 diff -q 复核一致后外层副本随仓消亡）。

---

## 2. 重点文档详单（写到哪个版本 / 缺什么 / 错什么）

### 2.1 `lasso/ARCHITECTURE.md` —— 停 v1.13，含 3 处「错误」级失实

**错（照读会错，非仅过期）**：
1. §9.1 搜索链画成 `machine_mcp → 智谱 → Brave → SERP 实搜 → Wayback → RecordingStore replay`：①「智谱」直连档 v1.17 A3 已删（INV-80 墓碑）；② 缺 `serp_http`（v1.15 Phase B，brave 前 ~1s 快探）；③「→ Wayback」步**违反 INV-58**（search 主路径不调 wayback_lookup，wayback 是独立 tool；源码注释明写）。正确链：`machine_mcp → brave → serp_http → browse_headless → replay`。
2. §11「当前版本：1.13.0」+ 头部「Lasso v1.13」——落后 5 个版本号（现实 1.17.1）。
3. §2 分层图底部盒子「智谱/Brave/SERP 兜底（search 多引擎经 HTTP；machine_mcp 复用打头）」——智谱直连已删，需改为现链。

**过期（数字/清单停 v1.13）**：
- §7 测试表：1961 TS / 207 Rust / 79 INV / selftest 14 → 现实 2240（134 files）/ Rust 实跑确认 / 81 / 20。
- §8「不变量（79 条）」整表缺 INV-80（zhipu 死层墓碑）/ INV-81（search_local 隐私红线）两行及「v1.14-v1.17 运营事实与死层清除」类目。
- §10 关键路径索引缺：`src/search-local/`（Chrome History + mdfind）、`src/interact/`、`src/serp/http-serp.ts`（serp_http 快探）、`src/search/ContentSecondHop.ts`（content_blocks 第二跳）、`src/search/{FreeTierRouter,AttributedSearch,QualityTag}.ts`；doctor「39 项 check」、check-invariants「~4200 行」等行数停旧。
- §12 五轮最优性审查收尾于 v1.13——缺 v1.14-1.17 主线：doc/governance/02 搜索重审（Brave 免费档取消/Bing 退役的运营事实清偿）→ doc/governance/04 方法论检讨（零基视角制度）→ doc/governance/05 颠覆性调研（D-GO/D-DECISION/D-WATCH/D-NOGO 分级）→ doc/governance/06 五项用户裁决 → doc/testing/01 ft-round1 全量测试 ALL-CLEAN。
- §13 链接描述「doc/architecture/02 — v0.1 → v1.13 能力跃升路径」。

**缺（v1.14-1.17 架构事实整段缺席）**：quality 三态轴（api/scrape/stale，served_by 静态映射）；content_blocks opt-in 第二跳（1-5 条/并发 3/单条 5s/256KB/查询相关裁剪 ~6k）；search_local 第四通道（Chrome History 复制只读 + mdfind；INV-81 隐私红线四联）；elicitation 降级红线（C1：客户端能力未声明 → 100% 降级 didnt，39 测钉死）；include_refs 交互句柄（[rN] 附录 + 失效诚实报错）；fetch_feed（v1.16）；freshness=day 缓存 TTL 24h + replay 新鲜度门；doctor `--deep`；SSRF IPv6 字面量剥括号（v1.17.1 FT-DEF-3，ssrf-guard.ts:86）；§6 边界未提 search_local 隐私边界（无全文导出/limit≤50/零网络）。

### 2.2 `lasso/doc/architecture/01` —— 停 2026-07-21 v0.x 基线，**建议加现状横幅而非重写**

08 是「权威架构基线」的历史重写版（自称「干净最终版」），但 v0.x 的 F 编号体系与现实已大面积脱钩。逐条失实（全部源码实核）：

| 位置 | 08 表述 | 现实 |
|---|---|---|
| §0 四通道 | `search（智谱 web-search-prime）` | 智谱直连 v1.17 删除（INV-80）；search = machine_mcp→brave→serp_http→browse_headless→replay 多源链 |
| §1 分层图 | 底部「智谱 web-search-prime（结构化搜索）」盒 | 同上；且缺 machine_mcp/serp_http/search_local |
| §3.1 / 附录 A | `search(query, engine="zhipu", ...)` | engine enum 无 "zhipu"（INV-80）；现 schema 含 freshness/content_blocks/no_cache，默认 engine=auto 扇出 |
| §3.5 / F3.5.1-6 | 子进程「智谱 http」 | 从无智谱子进程；search 走 HTTP API channel |
| §3.8 / F3.8.1-8 | 「百度/**Google** selector」 | Google selector 从未实现；现实三引擎 = 百度 / DDG / Brave SERP（selectors.ts） |
| §7.5 | 「chrome-devtools-mcp **1.6.x** 契约」 | 版本锁 1.7.0（v1.11 起，INV-79） |
| §4 F3.12.x | future：browse_cloud/stagehand/fetch_url/screenshot/pdf/network/wayback | **7 项全部已交付**（v0.4-v1.11）+ Steel（v1.6）+ fetch_feed（v1.16）无 F 编号 |
| 附录 B | SEARCH_DESCRIPTION「via Zhipu web-search-prime」 | descriptions.ts 是单一真源，现文案 machine_mcp 打头 |

**缺**（v0.x 之后出生、08 无处安放）：interact 工具族（F3.11 只规划到「调度层」，现 interact_roots/observe/act 是 3 个真实 MCP 工具）、lifecycle 家族（idle reaper / chrome-stop 台账 / tab_restore / hidden 档）、stealth 16 路、elicitation、quality 轴、content_blocks、search_local、SSRF IPv6。

**处置**（见 §5-P0）：不重写 v0.x 基线正文（它是 F 编号的定义域，重写=毁掉 09 的引用锚）；在头部加「**现状横幅**」：声明基线冻结于 2026-07-21，v1.14+ 现状以 `lasso/ARCHITECTURE.md`（v1.17）+ 本文 §4 映射表为准，逐条失效点链到映射表。

### 2.3 `lasso/doc/architecture/02` —— 停 v1.13，缺 v1.14-v1.17.1 五行

阶段总览表末行是 v1.13（2026-08-17）。缺行素材全部在档（git log + doc/governance/02-25，已核实）：

| 待补版本 | commit | 能力主题（建议行文） | 素材源 |
|---|---|---|---|
| **v1.14** ✅ | `48e0c94` | 搜索方案全面重审：运营事实清偿（Brave 1000/月真价、Bing 归零）+ free_only 路由接线 + DDG→Brave SERP 级联 + `doctor --deep` 计划级探测 + KEY-GUIDE 90 天时效标注制度；F-1/F-2/F-3 三修 | doc/governance/02 verdict |
| **v1.15** ✅ | `e7baac6` | Bing 死层代码级清除（INV-54 墓碑，存量配置静默忽略）+ serp_http 裸 HTTP 快探层（brave 前 ~1s；真机 1.9s/20 条 vs 浏览器 5.3s/0 条）；2008 tests + 79 INV + selftest 15 | doc/governance/03 |
| **v1.16** ✅ | `ef94685` | 颠覆性调研落地（D-GO 三项）：freshness=day 缓存 TTL 24h + replay 新鲜度门 / **fetch_feed** RSS·Atom·JSON Feed 工具 / README 生态搭配段；doctor-deep timing flake 根治（5s→15s）；2032 tests + 79 INV | doc/governance/05 |
| **v1.17** ✅ | `8112a5e` | 五项用户裁决：A1 quality 轴（api/scrape/stale）/ A3 删 zhipu 直连（INV-80）/ A2′ content_blocks 第二跳 / B1 **search_local** 第四通道（INV-81 隐私红线）/ C1 elicitation 回合内确认 + C2 include_refs 句柄；2032→2227 tests、79→81 INV、selftest 20 | doc/governance/06 |
| **v1.17.1** ✅ | `1432bd4` | doc/testing/01 全量测试轮（~170 用例四面板）修复 6 缺陷：🔴IPv6 字面量 SSRF 绕过（剥括号）/🔴HighRiskGate 裸 JSON.parse（改经 upstream-response）/ doWait 假成功 / tab_restore no-op / doctor file 键 / SIGHUP；**2240 tests + 81 INV + selftest 20/20，ft-round1 ALL-CLEAN** | doc/history/01-功能测试执行记录/ft-00-总结 |

连带缺口：§3 能力跃升曲线图、§4 关键里程碑各缺 4 行；尾注「2026-08-17 增补 v1.8-v1.13 六行」需追加一句；§2.2 的「Brave …2000/月」是当时的决策输入，**保留原文 + 加 ⚠️ 后注**（「2026-02 免费档取消，现价见 KEY-GUIDE A-2」）；§6 风险表建议增补 R13「搜索供应商运营事实漂移（Brave 免费档取消/Bing 退役两例成真）→ 缓解 = KEY-GUIDE 90 天重核制度（doc/governance/02）」——这正是 doc/governance/04 检讨的结论。

### 2.4 `KEY-GUIDE.md` / `README.md` —— 新鲜，锚定不动

两份用户向文档均同步到 v1.17（zhipu 退役 / serp_http / search_local / content_blocks / elicitation / include_refs / --deep / quality 轴全覆盖；README changelog L233 齐全）。唯一纪律：**保持「以实跑为准」措辞**，不回填硬数字。本次无需改动。

### 2.5 `TROUBLESHOOTING.md` —— 停 v1.13，v1.14-1.17 用户可见故障面零覆盖

补节建议（按用户提问频率排序）：① `doctor --deep` 四分类释义（200/401/403/429 各自下一步）；② `quality: "stale"` 是什么（replay 兜底命中陈年录制，非故障，配 freshness 重查）；③ content_blocks 条目 `content_status` 失败标注（网络/超时如实标注，蓝链仍可用）；④ search_local 返 `notes_deferred_v2`（Apple Notes 未实现，诚实 didnt 不是漏做）；⑤ 老客户端 elicitation 不可用 → 高风险动作直接 didnt（设计，非 bug；升级客户端 ≥2.1.76）；⑥ include_refs 句柄「页面变了诚实失效」的重取方法（重新 extract）；⑦ `ssrf_blocked` 补一句 IPv6 字面量行为（v1.17.1 剥括号修复，`[::1]` 类地址现被正确拒绝）；⑧ freshness=day 结果 24h 过期的缓存语义。另修：§1 示例版本号；§7 对 doc/architecture/02 的描述（「v0.1 → v1.0 路径」→「v0.1 → v1.17 能力跃升全路径」）。

### 2.6 `SELECTOR-MAINTENANCE.md` —— 半新（v1.15 有一处回补），缺 selector 新消费面

三处改：① §1 主路径表述改「machine_mcp（智谱能力唯一载体）→ Brave → serp_http → browse_headless」；② **新增一节「两个消费面」**：同一 selector 集既被 browse_headless（真 Chrome 抓 HTML）也被 `src/serp/http-serp.ts`（裸 HTTP ~1s 快探，v1.15；含 brave 字体 CSS 垃圾结果 / 百度软挡终态 URL 校验两个真机坑的维护记录，源 = doc/governance/03 parse22）；③ §2.1/§6 示例从单一 BAIDU 扩为三引擎真表（BAIDU/DDG/BRAVE_SERP），§6 例子换掉已存在的 DuckDuckGo。

### 2.7 外层 `cc-control-all/doc/00-总览` 与 01-18 系列头部

- **00-总览**（P1）：「文档导航」补 07-18 全部条目（07 可行性 → 16 开源白盒审查 → 18 资源调研，一句话定位照各档头）；头部加「落地状态（2026-08-18）」块：本调研结论已产品化为 `lasso-mcp` v1.17.1（npm；17 工具/81 INV/2240 tests），实现文档入口 = `lasso/ARCHITECTURE.md`；决策树中「AXAPI 自建 MCP【通识未验证】」补注「已落地」。调研正文语义**不动**（快照纪律）。
- **01-06**（P2）：各档头部加一行统一状态标注（「历史调研快照 2026-07-20；当前实现见 lasso 仓；文中版本号与数字勿作当前事实引用」）。
- **07/10-16/18**：自带日期与基线声明（如 18 明写 v1.9.0 基线），快照性质成立，不动。
- **08/09 外层拷贝**：见 §5-P2 单真源化。

---

## 3. 缺失文档类型判定（四问四答）

### ① 是否需要「架构决策记录（ADR）」汇总文档？

**判定：需要索引，不需要合并。**
- doc/governance/01（五轮最优性审查，30 份）、21（搜索重审）、22（Bing 清除）、23/23a（方法论检讨）、24（颠覆性调研 D-GO/D-DECISION 分级）、25（五项裁决）共 **6 份决策记录散落**，且决策语义有先后演进链（19 的「裁决官不采信文档」→ 23 的「零基视角才可见方案级盲区」→ 24 的分级裁决 → 25 的用户裁决），新读者无入口。
- **反对合并**：决策记录是不可变审计史（doc/governance/01-00 明言「勘误上版」而非改写），合并即毁链。
- **落地**：在 §3-② 的 `doc/README.md` 里加「决策时间线」小节——每份记录一行（版本 / 日期 / 裁决性质 / 状态：已实施·墓碑·watch），充当轻量 ADR 索引；同时 `ARCHITECTURE.md` §12 扩写为「质量与决策主线（doc/governance/01→23→24→25）」承接正文侧索引。不另建独立 ADR 目录（6 份体量不值一个新层级，反 R-ABS-01 过度抽象）。

### ② doc/ 内是否缺一个 README 索引？

**判定：缺，建。** 现状：`lasso/doc/` 下 08/09/17/19/20/21/22/23/23a/24/25 + 26 共 12 个编号单元 + KEY-GUIDE/TROUBLESHOOTING/SELECTOR-MAINTENANCE 三手册 + 2 张打赏图，无一字导读；ARCHITECTURE §13 只链了其中 5 份。**建议新建 `lasso/doc/README.md`**，三分法：
1. **用户向**（链 README/KEY-GUIDE/TROUBLESHOOTING——用户不该读 doc/ 深层）；
2. **维护手册**（SELECTOR-MAINTENANCE / 17-功能测试清单 / 20 与 26 两份审计）；
3. **决策与审计档案**（08 冻结基线→09 全周期排期→19→21→22→23→24→25 时间线，即 ①的 ADR 索引落位）。
附「新鲜度表」：每文档一行「写到哪个版本 / 最后同步日期」——把本次矩阵 §1 的表降维成活文档，下次盘点直接在此表续行。

### ③ v1.14-v1.17 排期缺行？

**判定：缺，且是 5 行不是 4 行。** v1.14/v1.15/v1.16/v1.17.0 四个功能版 + v1.17.1 测试收敛 patch（含 2 个🔴级安全修复，有排期价值）。行文素材已备好（§2.3 表），连带补 §3 曲线、§4 里程碑、尾注、R13 风险行。注意双拷贝同步（外层 doc/architecture/02 同步改）。

### ④ 08 的 F 编号 ↔ 现实映射表？

**判定：缺，且是本次盘点的最大单点债务。** v0.x F 编号体系已三向脱钩（退役 / 从未实现 / 新能力无编号），08 读者无法自行判断哪条 F 还活着。**映射表直接随本文档交付（§4）**，08 头部横幅与 doc/README 索引链过来即可，不另立文件。

---

## 4. F 编号 ↔ 现实映射表（08 §4 总表 → v1.18.4 现实）

> 状态四值：**活**（实现且生效）/ **退役**（曾实现已删，墓碑 INV 守）/ **从未**（规划未做）/ **无号**（实现于 F 体系之外）。逐行经源码/INV/grep 实核。**2026-08-27 续盘 v1.18 行**（§8）。

| F 编号 / 08 表述 | 08 原文 | 现实状态 | 证据锚点 |
|---|---|---|---|
| F3.1.1-7 基础搜索（engine=**zhipu**） | 智谱 web-search-prime 单源 | **改形**：engine 默认 auto 扇出（machine_mcp+brave）；engine enum 无 zhipu | src/tools/search.ts；INV-80 |
| F3.1.4 fallback 触发集 | 智谱→降级 | **活**（跨模态降级至 browse_headless 保留） | runFallbackChainEngine |
| F3.1.8 attributed 查询 | v0.x | **活**（AttributedSearch.ts） | src/search/ |
| F3.1.10 free_only 四级 | L1-L4 | **活且接线**（v1.14 F-1 修死配置；machine_mcp=L1 永保留） | FreeTierRouter.ts |
| F3.1.11 Wayback 死链恢复（search 内） | search 集成 | **改形**：独立工具 `wayback_lookup`；search 主路径不调（INV-58） | src/tools/wayback.ts |
| F3.1.12 RPM 滑动窗口 | v0.x | **活**（quota-ledger） | src/config/quota-ledger.ts |
| （无号）serp_http 快探层 | — | **无号**：v1.15，brave 前 ~1s 裸 HTTP | src/serp/http-serp.ts |
| （无号）quality 质量轴 | — | **无号**：v1.17 A1，api/scrape/stale | src/search/QualityTag.ts |
| （无号）content_blocks 第二跳 | — | **无号**：v1.17 A2′，top N 正文富化 | src/search/ContentSecondHop.ts |
| （无号）search_local 本地私有搜索 | — | **无号**：v1.17 B1 第四通道（Chrome History+mdfind），INV-81 | src/search-local/ |
| （无号）fetch_feed | — | **无号**：v1.16 ZB-4 | src/tools/fetch-feed.ts |
| F3.2.1-9,18-21 browse 基础/expect/bounded | v0.3 | **活**（v1.11-v1.13 深化：expect 连续 2 采样/find 拒纯 ref） | cdp-actions.ts |
| F3.2.12 stealth | v0.4 | **活且超规划**：16 路 + 4 profile + launch 级 + 宿主对齐（v1.5-v1.13） | StealthEngine.ts |
| F3.2.15-17 console/perf trace | v0.x | **改形**：v1.11 起原生 list_console_messages / list_network_requests（CDP 域，非 JS 注入） | INV-79 |
| （无号）markdown 三模式 | — | **无号**：v1.1 defuddle+turndown；v1.12 双激活 | INV-66..69 |
| （无号）include_refs 交互句柄 | — | **无号**：v1.17 C2 | browse extract |
| （无号）elicitation 高风险确认 | — | **无号**：v1.17 C1（能力未声明 100% 降级 didnt） | HighRiskGate |
| F3.3.x logged_in 全族 | v0.x | **活**；v1.8 起独立 user-data-dir；v1.9-v1.10 lifecycle 三机制 | launcher/ |
| F3.4.x fallback 引擎 | v0.x | **活**（单一引擎铁律 INV-4/55 全程未破） | FallbackDecider.ts |
| F3.5.1-6 子进程（含「智谱 http」） | 智谱子进程 | **部分退役**：智谱子进程从不存在；现 chrome-devtools-mcp@1.7.0 多 spec | SubprocessManager.ts |
| F3.5.10-11 能力袋 | v0.6 | **活**（ToolManager+metrics） | src/runtime/ |
| F3.6.7 doctor CLI | v0.7→M | **活且超规划**：40+ 项 + `--deep`（v1.14）+ `--stealth-check`（v1.7） | doctor.ts |
| F3.8.1-8 SERP（百度/**Google**） | Google selector | **部分从未**：Google selector 未实现；现实百度/DDG/Brave 三引擎 + 语言分流（v1.11 T9） | selectors.ts |
| F3.8.9-14 改版检测/命中率/回放 | v0.7-v1.0 | **活**（SerpHealthMonitor + replay 新鲜度门 v1.16） | serp/ |
| F3.9.5 SSRF allowRanges | v0.1 | **活且加固**：fake-ip 内置放行 + IPv6 剥括号（v1.17.1） | ssrf-guard.ts:86 |
| F3.9.8 架构不变量（8 条断言） | v0.1 | **活且 ×10**：81 INV + selftest 20 样本 | check-invariants.mjs |
| F3.10.x desktop 四档 | v0.3.5 | **活且超规划**：v1.11-v1.13 从「能看」到「能点」（ax_act 真实现/坐标鼠标/VLM 真执行/Electron 兜底） | src/desktop/ |
| F3.11.x forest | v0.4 调度层 | **活且工具化**：interact_roots/observe/act 3 个真实 MCP 工具（17 工具之三） | src/tools/interact.ts |
| F3.12.x future（browse_cloud/stagehand/fetch_url/screenshot/pdf/network/wayback） | v0.4-v0.9 | **全部已交付**；Steel 自托管（v1.6）与 fetch_feed（v1.16）无号 | tools/{screenshot,pdf,network,fetch-url,wayback}.ts |
| （无号）静默性/守则体系 | — | **无号**：v1.17.2 全通道静默（doc/governance/08）+ v1.18.0 静默守则入宪（INV-82，doc/governance/09）+ v1.18.3 hide 粘滞看门狗（P27） | launcher/desired-hide-watchdog.ts |
| （无号）rust-helper 路径根治与四态门 | — | **无号**：v1.18.4，任 cwd 可用 + rustSpawnGate 四态 + ad-hoc 签名链 + CI（BUG-rust-helper §7-9） | src/subprocess/rust-helper-path.ts |
| （无号）错配机制守卫二分 | — | **无号**：v1.18.2（doc/governance/10）——SSRF/熔断/envelope 失败 reason 二分 + steps 链 120s 预算（超限=unknown） | src/ssrf/ssrf-guard.ts |

---

## 5. 更新计划（按优先级）

> 纪律（沿用原 doc/20 文档同步审计铁律，该快照已删、铁律在此延续）：① 每份文档改完跑 `npm run check-invariants`（本文档已跑，81/81 绿，见 §6）；② 用户向文档不回填硬数字（「以实跑为准」措辞）；③ 快照类文档只加标注不改语义；④ 08/09 每次改动**双拷贝同步**。

### P0（失实纠错 + 补洞，先做）

| 动作 | 对象 | 怎么改 | 验收 |
|---|---|---|---|
| P0-1 | ARCHITECTURE.md | §9.1 链改为 `machine_mcp → brave → serp_http → browse_headless → replay`（删智谱、删 Wayback 步）；§2 盒子同步；头部与 §11 版本改 v1.17.1；§8 表补 INV-80/81 行 + 81 总数；§7 数字改「2240 / 81 / 20 样本 / Rust 以实跑为准」 | grep 全文无「→ 智谱 →」链残留；check-invariants 绿 |
| P0-2 | doc/architecture/02（**双拷贝**） | 阶段表补 §2.3 五行；§3 曲线补 4 行；§4 里程碑补 2 条；尾注追加；§2.2 加 ⚠️ 后注；§6 加 R13 | 表末行 = v1.17.1；两份 09 `diff -q` 一致 |
| P0-3 | doc/architecture/01（**双拷贝**） | 头部加「现状横幅」：基线冻结 2026-07-21；v1.14+ 现状见 lasso/ARCHITECTURE.md + doc/governance/07 §4 映射表；列出 4 条最高危失实（zhipu 直连/Google selector/1.6.x/future 已交付） | 横幅 ≤15 行，正文零改动 |
| P0-4 | （已交付）本文档 §4 映射表 + §2.3 五行素材 | — | 即本文件 |

### P1（过期补齐 + 索引建设）

| 动作 | 对象 | 怎么改 |
|---|---|---|
| P1-1 | TROUBLESHOOTING.md | 补 §2.5 所列 8 个 v1.14-1.17 故障面小节；§1 版本示例；§7 doc/architecture/02 描述与链接修 |
| P1-2 | SELECTOR-MAINTENANCE.md | §2.6 三处改（主路径表述 / http-serp 新消费面一节 / 三引擎示例） |
| P1-3 | 新建 `lasso/doc/README.md` | §3-② 三分法导读 + 决策时间线（ADR 索引）+ 新鲜度表 |
| P1-4 | 外层 doc/00-总览 | 导航补 07-18；头部加落地状态块（lasso-mcp v1.17.1） |
| P1-5 | ARCHITECTURE.md 二批 | §10 文件索引补 6+ 新模块；§12 扩「决策主线」；§13 描述；补 quality/content_blocks/search_local/elicitation/include_refs/fetch_feed/IPv6 七个事实小节（每节 ≤10 行，链 doc/governance/06） |

### P2（结构治理）

| 动作 | 对象 | 怎么改 |
|---|---|---|
| P2-1 | 08/09 单真源化 | ~~决策：`lasso/doc/` 为真源，外层改指针文件~~ **已随仓迁终局解决（2026-08-27）**：外层 cc-control-all 退役，真源唯一 = 本仓 doc/architecture/01、09 |
| P2-2 | 外层 01-06 | 头部统一加「历史调研快照」状态标注 |

### P3（保持）

KEY-GUIDE.md、README.md、doc/testing/01 与 doc/governance/01-06（原 17-25）——新鲜；每次发版按既有流程（原 doc/20 同步审计范式）做增量审计即可。

---

## 6. 本文档自检

- 事实来源：全部为 2026-08-18 对 HEAD=`1432bd4` 工作树的源码/grep/实跑（tools/list 17 工具亲自起服求取），无凭记忆条目。
- 未改动任何 src/test 代码与既有文档；唯一产物 = 本文件。
- 门禁：`npm run check-invariants` 复跑 **81/81 全绿**（见下）。
- 后续处置：P0-1..P0-3 执行时，逐项在本表勾销并回填 commit 号。

---

## 7. 审查段（文档审查员复核 · 2026-08-18）

> 复核对象 = 本轮 P0-1..P0-3 + P1-3/P1-4/P1-5 产物（`git status`：改 `ARCHITECTURE.md` / `doc/architecture/01` / `doc/architecture/02`，新 `doc/README.md` / `doc/governance/07`；外层仓 `doc/00-总览` 同步）。方法：逐条技术声称对照 HEAD=`1432bd4` 源码 grep / 实跑，禁凭记忆。

### 7.1 事实核对结果（45 条全对源，关键 24 条列示）

| # | 文档声称 | 核对方式 | 结果 |
|---|---|---|---|
| 1 | 版本 1.17.1 三处一致 | package.json:3 / index.ts:224 `LASSO_SERVER_VERSION` / doctor.ts:160 `LASSO_VERSION` | ✅ 三处均 "1.17.1"（INV-63） |
| 2 | 17 默认工具清单 | 逐个 `server.tool(` 注册名枚举（tools/*.ts + search-local） | ✅ 17 个默认 + 条件解锁 2 个 |
| 3 | 终态链 machine_mcp → brave → serp_http → browse_headless → replay | search.ts `runFallbackChainEngine` channelOrder 构造顺序 + 函数注释原文 | ✅（`DEFAULT_FALLBACK_ORDER` 本体仅 `[machine_mcp, brave]` 两 API 源，serp_http/browse_headless 由注入追加——文档「扇出+串行链」表述与代码注释一致） |
| 4 | quality 静态映射（machine_mcp/brave→api；serp_http:\*/browse_\*→scrape；recording_replay→stale；其他不标） | QualityTag.ts `QUALITY_BY_SERVED_BY` + `SCRAPE_SERVED_BY_PREFIXES` | ✅ 逐键一致 |
| 5 | content_blocks 1..5 / 并发 3 / 5s / 256KB / 裁剪 ~6k / 15s 软上限 / content_status 四态 / 不入 cache key | search.ts:134 `z.number().int().min(1).max(5)` + ContentSecondHop.ts:104-108 DEFAULTS + ContentBlockStatus 类型 | ✅ 全部逐字面量一致 |
| 6 | search_local 三源 + notes_deferred_v2 + limit≤50 | register-search-local-tool.ts:12/40（`.max(50)`）/ :86 `notes_deferred_v2`；chrome-history.ts / mdfind.ts 存在 | ✅（INV-81） |
| 7 | fetch_feed 48KiB / 16KiB preview / truncated_input | fetch-feed.ts:21-23/95-96 | ✅ |
| 8 | elicitation 三值 + elicitation.form 预检 + 120s + 永不 throw | ElicitationPort.ts:32/46/80-103 | ✅（C1） |
| 9 | include_refs r1..r50 + `^r\d+$` + 附录 + ref_stale_re_snapshot + raw 档 ignored_include_refs | extract-refs.ts:33/36/123 + browse.ts:92 | ✅（C2） |
| 10 | SSRF IPv6 剥括号（v1.17.1） | ssrf-guard.ts:80-85 注释（FT-DEF-3） | ✅ |
| 11 | HighRiskGate 改经 upstream-response（v1.17.1） | HighRiskGate.ts:43-47 `parseEvalResult` import | ✅（FT-DEF-1′） |
| 12 | chrome-devtools-mcp 版本锁 1.7.0 | SubprocessManager.ts:49 `LOCKED_CDP_MCP_VERSION = "1.7.0"` | ✅ |
| 13 | 81 INV | `npm run check-invariants` 实跑 | ✅ 81/81 全绿 |
| 14 | inv-selftest 20 样本 | VIOLATION_SAMPLES 计数 = 20（末 3 条 INV-81） | ✅ |
| 15 | 2240 tests / 134 files | `npx vitest run` 实跑：**134 files，2239 passed + 1 skipped = 2240**，64.6s | ✅（审查员亲跑） |
| 16 | 207 Rust tests | `cargo test` 实跑：42+101+9+10+30+9+6 = **207 passed / 0 failed** | ✅（审查员亲跑；本文件头部「静态计数 171、禁抄旧数」之诫已闭环——实跑即为 207，doc/governance/01 数字仍有效） |
| 17 | doctor「40 项 check 量级」 | doctor.ts `checks.push` 静态计数 = 40（含条件项）；#11b/#21/#36/#37/#38/#39/zhipu_keys_retired 全在 | ✅ |
| 18 | TTL = min(7 天, freshness 窗口) + freshness 入 cache key | SearchCache.ts:39-53（ZB-3）+ :14（v1.11 T6） | ✅ |
| 19 | replay 新鲜度门（day 24h/week 7d/month 30d；year/未传不过门） | search.ts ZB-3b 段落逐分支 | ✅ |
| 20 | LASSO_HEADLESS_IDLE_MS 默认 5min / LASSO_LAUNCH_IDLE_MS 默认 60s / launched-chromes.json | index.ts:396/467 + chrome-ledger.ts:57 | ✅ |
| 21 | UA 值域 Chrome/151 + Firefox/153 + Safari 冻结 token 605.1.15 | stealth-profiles.ts:122/200/174-176 | ✅ |
| 22 | doc/architecture/01 横幅四条对照冻结正文 | 正文 :25（智谱四通道）/ :237（F3.8 Google selector）/ §7.5（1.6.x）/ :246（F3.12.1-7 恰为 7 项） | ✅ 四条全部与冻结正文实存文本吻合 |
| 23 | doc/architecture/02 新五行 commit 号 | git log：48e0c94/e7baac6/ef94685/8112a5e/1432bd4 与行内 commit 一一对应；2032 = 2031 passed + 1 skip、2227 = 2226+1 skip（doc/governance/05 verdict / doc/governance/06 verify 口径一致） | ✅ |
| 24 | Brave 免费档 2026-02 取消 / $5≈1000 次 / Bing 2025-08-11 退役 | doc/governance/02 verdict（官网+控制台 2026-08-17 核实在档） | ✅ |

（另有 21 条次要核对同样通过：stealth-evasions 12 文件、DDG→Brave 级联 v1.14、MultiSourceFanout/FreeTierRouter/AttributedSearch/MachineMcpDetector 文件存在、hidden 档反节流 flag 集、StateStore LRU(128)、AxProvider 331 行、SubprocessManager 726 行、rust 合计 4998 行、§6.1 终判 27/11/0/1 与 doc/testing/01 §6 一致、doctor 3059 行、README 引用 doc/architecture/01+02、engine enum 无 zhipu、BING_API_KEYS 键容忍、§7.2 真机数字与 doc/governance/03 一致、00-总览落地状态块数字四源一致等。）

### 7.2 审查发现并已当场修正的失实（10 处，全在 ARCHITECTURE.md + 本文件头部）

1. **§3.1 / §2 类层级图错误级失实**：原图把 HeadlessChannel / LoggedInChannel / SteelChannel 画成 UiChannel 直接子类，且列出不存在的 `SearchChannel`。实核（`grep "class.*extends" src/channels/*.ts`）：Headless/LoggedIn/Steel/**Browserbase** 均 `extends BrowseChannel`；`MachineMcpSearchChannel` / `BraveChannel` 直接 `extends BaseChannel`；Stagehand/Desktop `extends UiChannel`。已按真层级重画两图（BrowserbaseChannel 此前整图缺席，一并补入）。
2. **§13「src/channels/{SearchChannel,BraveChannel}.ts」**：`channels/SearchChannel.ts` 不存在（INV-80(a) 明言；zhipu 直连删除时随之而去）。已改 `MachineMcpSearchChannel`。
3. **§1 云工具名**：`browse_cloud_steel` 是 channel 名，MCP 工具名实为 `steel`（server.tool("steel", ...)）。已改「`browserbase` / `steel`（channel 名 browse_cloud_\*）」；本文件头部同句同修。
4. **§13「V5_TOOL_TO_CHANNEL 17+2 工具映射」**：实数 18 键 = 16 默认工具 + browserbase + steel；`admin` 不在表内（虚拟 channel，经 toolManager 直注册，index.ts:917）。已改。
5. **§3.4 状态盘路径**：实为 `~/.cache/lasso/<run_id>/<channel>-<stateId>.json`（state-store.ts:4/41），非 `~/.cache/lasso/state/`。已改。
6. **§11 不变量分类表缺 INV-54**：末行「死层清除」只列 INV-80。已补 INV-54（Bing 墓碑）。
7. **§13 FallbackDecider「~280」**：实 347 行。已改 ~350。
8. **§13 Launcher 行**：只列 2 文件、标 ~200 行——实 6 文件（漏 chrome-stop / chrome-idle-reaper / chrome-ledger / chrome-hide）、合计 1543 行。已改。
9. **§13 check-invariants「~4600」**：实 4449 行。已改 ~4450。
10. **§13 index.ts「~1500」**：实 1474 行。已改 ~1470（顺带随 #4 重写该行备注）。

### 7.3 跨文档一致性（4+1 文档）

- **版本 1.17.1**：ARCHITECTURE.md（12 处）/ doc/architecture/01 横幅 / doc/architecture/02 尾行+里程碑 / doc/README / 外层 00-总览——全部 1.17.1，无残留 1.13/1.16 ✅
- **17 工具**：ARCHITECTURE §1 / doc/README / 00-总览 / 本文件 §0——同一份 17 名单 ✅
- **81 INV / 2240 / 207 / 20**：四份数字口径一致（2240 = 2239 passed + 1 skip 已实跑钉死）✅
- **链序**：ARCHITECTURE §2 图 + §7.1 + §12.1 三处与 doc/architecture/01 横幅 #1、本文件 §0 完全同序（machine_mcp → brave → serp_http → browse_headless → replay）；doc/architecture/02 不整链复述但 v1.15/v1.17 行的分链描述无矛盾 ✅
- **原 doc/17-25（今 doc/testing/01 + doc/governance/01-07）**：语义零改动（2026-08-27 结构重整仅改路径与编号）✅

### 7.4 门禁与红线终验

- `npm run check-invariants` 审查前后两跑均 **81/81 全绿**；**INV-65 未破**（README 与 ARCHITECTURE 的 doc/architecture/01+doc/architecture/02 引用俱在，四子条件全 PASS）。
- `git status` 终态 = 改 3（ARCHITECTURE.md / doc/architecture/01 / doc/architecture/02）+ 新 2（doc/governance/07 / doc/README.md），**零 src/test 改动**（`git diff --stat` 仅上述 3 文件；审查修正也只落文档）。
- `npx vitest run`（2240）/ `cargo test`（207）审查员亲跑复证，与文档数字一致。

**审查结论：PASS（附 10 处已闭环修正）**。更新报告所列 §7/§8/§9 新增章节、§9.1 链纠正、doc/architecture/01 横幅、doc/architecture/02 五行经 45 条逐项对源核验全部属实；发现的 10 处次级失实（层级图 ×2、SearchChannel 幽灵文件 ×2、云工具名、V5 键数、状态路径、INV-54 缺行、3 处行数漂移）已当场修正并复跑门禁。文档链现状：外层 00-总览（落地状态）→ lasso/ARCHITECTURE.md（v1.17.1 现状权威）→ doc/architecture/01（冻结基线+横幅）+ doc/architecture/02（全周期）→ doc/governance/07 §4（F 映射真源），四层互链闭环，无悬挂引用。

---

## 8. 续盘 v1.17.2 → v1.18.4（2026-08-27，仓迁后首盘）

> 本节是 §1 矩阵的续行（增补不推翻；§1 原行不动）。基线：`lasso-mcp v1.18.4`（HEAD=`e4c73aa`，npm latest）。新事实基准：**17 工具 / 82 INV / 2417 passed + 1 skipped（143 files）/ selftest 23 / GitHub CI（.github/workflows/ci.yml = ubuntu × Node 20/22 门禁三件套，不含 Rust cargo 面——跨平台编译仍为本地手测）**。

| # | 文档 | 写到哪个版本 | 新鲜度 | 处置（本轮已做 / 遗留） |
|---|---|---|---|---|
| 14 | `doc/governance/08-静默性全面审计/`（5 件 + verify-data 真机证据） | v1.17.2 | **A** | 原位不动（TROUBLESHOOTING §8 引用成立） |
| 15 | `doc/governance/09-静默守则审计/`（6 件） | v1.18.0/1 | **A** | 原位不动（INV-82 出处；check-invariants L112 引用成立） |
| 16 | `doc/governance/10-错配机制审计/`（3 件） | v1.18.2 | **A** | 原位不动（src 注释引用 ×54 最密；ARCHITECTURE L25） |
| 17 | `doc/bugs/01-rust-helper-relative-path.md` | v1.18.4（已根治） | **A** | 本轮纳入 git 跟踪（原 untracked）；§9 勘误制度示范 |
| 18 | `doc/bugs/02-chrome-idle-reaper-second-consumer.md` | v1.18.3（缓解在档，**根治未做**） | **A**（活档） | 本轮纳入 git 跟踪；R-INT-07 活案例，修复建议 §6 四级待裁决 |
| 19 | `doc/archive/parse/`（36 件，原 cc-control-all/doc/parse/） | v0.1-v1.10 执行史 | **快照** | 本轮抢救迁入；src/index.ts、doc/architecture/02 引用已 re-base；TROUBLESHOOTING Q5 链已修 |
| 20 | `doc/archive/research/`（16 件 + 搜索mcp工具/，原 cc-control-all/doc/00-18） | 2026-07-20~08-17 调研 | **快照** | 本轮抢救迁入；src 注释 archive/research/00、14、16 引用已 re-base 校验成立 |
| 21 | `doc/得到课程全量抓取/`（68 件，自洽模板目录） | v1.17.3/v1.18.1 实战母本 | **A** | **后续（2026-08-27）已迁出 git 跟踪至 `.private/`（平台合规风险，不入库不发布；本仓不再有此目录）** |
| 22 | `doc/architecture/02` 阶段表 | **本轮补齐 v1.17.2-v1.18.4 六行** | **A** | 已做（2026-08-27） |
| 23 | `doc/testing/01` | **本轮补 v1.18 增补记录节**（门禁 2417+82、CI、四态门、看门狗、reaper 盲区、二分覆盖声明） | **A** | 已做；T-SILENCE-01..09 之外的新用例组（gate 四态/watchdog/reaper 缓解）待 round2 补 |
| 24 | `doc/usage/02-TROUBLESHOOTING.md` | **本轮补 §2.16 + §9（v1.18.x 故障面）**；§1 版本 1.18.4；Q5/§2.4/§7 断链修 | **A** | 已做 |
| 25 | `doc/README.md` | **本轮重写为按项目逻辑导读** | **A** | 已做（双拷贝纪律节废止） |
| 26 | `../ARCHITECTURE.md` | 头部 v1.17.2（正文散见 v1.18.x 增补） | **C** | **遗留 P0**：头部版本停 v1.17.2、§9 测试规模行停 2253、INV 计数混写 81/82（§11 题头 82 vs 正文 81）、CI 未入——下次架构文档专项 |
| 27 | `doc/usage/01-KEY-GUIDE.md` | v1.18.4（轻核对；时效标注 2026-08-17/18） | **A**（90 天时效期内；下次重核 ≈2026-11，含 Brave 免费计划扣卡口径） | 本轮加轻核对注；无新 key/供应商面（v1.18.x 新增 env 开关 `LASSO_AUTO_HIDE_AFTER_LOGIN*` 已于 §B 在档） |
| 28 | **doc/ 全目录结构深度重整**（v1.18.5，2026-08-27） | 逻辑分组 usage/architecture/testing/governance/history/bugs/assets + 组内重编号；旧 08/09/17-29 全量映射；删除 20（过期自指快照）与 23a（并入 governance/04 附录A） | **A** | 已做：git mv 保历史；全仓引用重写 693 处/138 文件（src/test/scripts/.github/README×8/ARCHITECTURE/doc 互链，含 doc/16、doc/14 归档简写升级为 archive 路径）；INV-65 锚点改为 doc/architecture/01+02（id 同步改 INV-65-docs-reference-architecture-deepdocs）；support 图迁 assets/ 并同步 8 README；17-执行记录/与 27 verify-data 内部为冻结证据不回改；门禁三件套复跑全绿 |
