# 裁决：Lasso 搜索方案 vs 2026-08 最佳实践

> 裁决官：搜索方案裁决官（21-搜索方案重审终裁）。日期：2026-08-17。
> 输入：rca-为什么漏.md（全读）+ 免费全景调研 + 开源对标报告（caller 摘录）+ Lasso v1.13.0 白盒抽验 + 独立外部实测（本日 curl 亲取）。
> 白盒抽验范围：src/search/FallbackChain.ts、src/tools/search.ts（schema/装配/fallback_chain 分支）、src/channels/BraveChannel.ts、src/config/providers.ts、src/config/quota-ledger.ts、src/serp/{extract,selectors,SerpHealthMonitor}.ts、src/doctor/doctor.ts（checkBraveKeys）、doc/usage/01-KEY-GUIDE.md（d3d1b24 后）、test/ 相关 spec、check-invariants.mjs 相关 INV。

---

## 0. 裁决官独立取证记录（拒采信无证据项后的存活事实）

对调研文档的关键声称逐条复核，**证实者采信、证伪者弃用**：

| 声称 | 裁决官独立验证 | 结论 |
|---|---|---|
| DDG html 端点 202 挑战（IP 粘滞） | 本日两次实测（间隔 ~30 分钟）：GET/POST 均 202，返回 anomaly/challenge 页（"anomaly"×67、"challenge"×13）；lite 端点同 202 | ✅ 证实。**curl 级已死**；Lasso browse_headless 走真 Chrome 未经实测，但 IP 级 flag 是真实风险 |
| SearXNG 公共实例不可用 | searx.be `format=json` 返回 200 但 body 是「Verifying your browser…」Anubis PoW 挑战页；paulgo.io 429 | ✅ 证实并加固：连「JSON 关闭」都不止，是三重反 API |
| Mojeek 可作候选 | 本日实测：Chrome UA 503 → Firefox UA 仍 503；`fmt=json` 403 "your network appears to be sending automated queries" | ❌ 本网络不可用，弃作通道 |
| search.brave.com SERP HTML 可抓（open-webSearch 范式） | 读 Aas-ee/open-webSearch `src/engines/brave/brave.ts` 源码证实（axios+cheerio 抓 `search.brave.com/search`，SvelteKit SSR `#results .snippet`）；本日两次 curl 实测：200，两次不同 query 各含 ~20 条 `search-snippet-title` | ✅ 证实，且当前网络下可用 |
| Brave 免费档取消/计量计费 | 本日 curl 亲取 brave.com/search/api 官方页：全页无 "2,000/month" 字样；现口径 = 「Free Credits: Up to thousands of free queries per month, depending on plan」+「$5 per 1,000 requests」+「*with $5 in free monthly credits」+ 注册须信用卡 FAQ | ✅ 证实（细节见 §1 注：官方 FAQ 有 "free plans … will not be charged" 措辞，与 KEY-GUIDE「超额自动扣费」并存的口径张力记入 90 天重核清单） |
| Bing API 2025-08-11 退役 | learn.microsoft.com lifecycle 页在世：「Bing Search APIs Retiring on August 11, 2025」 | ✅ 证实 |
| d3d1b24 修正遗漏 | grep 证实：doctor.ts:1106（RCA 已抓）**及 :1112「合并配额 = N×2000/月」**（RCA 未抓）；providers.ts:95 `free_quota_per_month: 2000`、:98 `free_tier_level: "L2"`、:310 BING `free_quota_per_month: 1000`「Azure F0 免费层」；search.ts:389-391 `?? 2000`/`|| 2000` 字面量；types.ts:228-229 / FreeTierRouter.ts:5-10 / quota-ledger.ts:17 注释；run-ab-benchmark.ts 5 处 | ✅ 证实且**比 RCA 清点面更大**——修正 commit 只修了文档层（README×8+KEY-GUIDE），运行时层一处未动。这本身就是 RCA D-6（同步机制修不干净）的当场再实证 |

---

## 1. 总判：架构机制达标，**运行时诚实度未达标** —— 不是 2026-08 最佳实践

**分维度论证**：

**① 引擎组合与降级链（机制面）：达标且局部领先。** machine_mcp（零配置复用 CC 已配 key，INV-72）→ zhipu → brave → bing（无 key 自动跳过）→ browse_headless 跨模态 SERP 兜底（DDG 英文/百度中文，v1.11 T9 语言分流）+ engine=auto 多源扇出。对标四项目：tavily-mcp 单 provider 无降级；exa-mcp 单 provider；open-webSearch 有 fan-out 无跨引擎串行 fallback、无配额账本；Lasso 的「fanout + 单一 FallbackDecider（INV-4/55）+ QuotaLedger + 诚实 outcome 三分类（429→unknown+熔断 / 4xx→didnt / 200 空→unknown）」在机制完备性上**超过全部对标**。此层无债。

**② 免费路径韧性（能力面）：不达标。** 零 key 免费路径 = machine_mcp（单一智谱系）+ SERP 实搜兜底。英文兜底单引擎（DDG html）且该端点在本网络已 202-死（curl 级实证）；百度仅覆盖 CJK。即：英文零 key 搜索的实际可用性押在「真 Chrome 能过 DDG IP flag」这一未验证假设上，结构化层押在智谱单源。open-webSearch 靠「全引擎 HTML 抓取 + 每引擎两级降级」对此免疫（对标报告实证其 Brave 引擎即 HTML 抓取，两场 API 地震对它零影响）。**这是与最佳实践的明确差距，且本日有活体证据。**

**③ 事实感知（本次事故主诉）：不达标，且修正只完成一半。** d3d1b24 修了文档 9 文件，但运行时仍在assert死事实：QuotaLedger 按 2000/月免费记账（ledger 会放行到 2000 才熔断，而现实 $5 赠送额度 ≈1000 次——**账本高估一倍**）；doctor 输出「获取免费 2000/月」+「合并配额 = N×2000/月」（用户按此配置会再次撞墙，**用户批评的场景原样存活**）；`free_tier_level: "L2"` 使显式 `free_only="L1"/"L2"` 路由仍把「需绑卡、计量扣费」的 Brave 当免费层放行（诚实性错路由）；BING 配额注释仍写「Azure F0 免费层」。RCA 的七层结构分析成立，其中 D-6（同步修不干净）在本轮取证中**再次当场复演**（RCA 自己也漏了 :1112 和 providers.ts）。

**④ 文档诚实度：文档层达标、制度层不达标。** KEY-GUIDE/README 现文与官方页亲取事实一致（$5/月赠送额度 ≈1000 次、绑卡、attribution、Bing 已退役+官方公告链接）。但无「最后核实」日期戳、无重核触发条件、surveillance 锚点仍全技术 Registry（无 pricing/lifecycle 锚）——同一失实没有任何制度性防线阻止它第三次发生。注：官方页 FAQ 现挂「For free plans, the card … will not be charged」，与 KEY-GUIDE「超额自动绑卡扣费」存在口径张力（openclaw #16629 与 Implicator 报道支持后者）；按 L-OP 纪律（marketing 页 = L0，有效期 ≤90 天）此项应进首期重核清单，而非本轮改判。

**结论**：机制面是第一梯队；但 ③（运行时仍在对用户撒谎，恰是本次事故主诉的残留）单独即否决 ROUND-CLEAN，②④ 提供第二、第三票。裁决 **ROUND-TUNE**，调优 5 项，新增通道严格 1 个（S-4），全部单轮可完成。

---

## 2. 调优项清单

> 门禁：每项完成后 `cd /Users/wangdong/Documents/Project/cc-control-all/lasso && npm run build && npm test && npm run check-invariants`（基线 1961+79 不减）。S-5 为仓库外文档，不进门禁。

### S-1 运行时事实清偿：Brave/Bing 配额、层级、文案、字面量全量对齐 2026-08-17 事实

- **改法**：
  1. `src/config/providers.ts` BRAVE：`free_quota_per_month: 2000 → 1000`（注释改为「2026-02 起免费档取消、计量计费：$5/月赠送额度 ÷ $5/千次 ≈1000 次/月；官网+控制台 2026-08-17 核实」）；`free_tier_level: "L2" → "L4"`（注释：L2 保留给无条件免费层；Brave 需绑卡+attribution+计量扣费，显式 free_only=L1/L2 不得再放行）。默认路径零变化（search.ts 默认 `freeOnly ?? "L4"` = 全允许，已核实）。
  2. `src/config/providers.ts` BING：`free_quota_per_month: 1000 → 0`，注释改「API 已于 2025-08-11 全量退役（微软 lifecycle 公告）；占位保留见 S-2/R-5」。
  3. `src/doctor/doctor.ts` checkBraveKeys：:1106 next_step 删「免费 2000/月」改为「付费计划含 $5/月赠送额度（≈1000 次），需绑卡——免费路径用智谱+实搜兜底即可，详见 doc/usage/01-KEY-GUIDE.md」；:1112 改为从 provider 配置读数（`N × free_quota_per_month`），消灭硬编码 2000。
  4. `src/tools/search.ts:389-391`：BudgetTracker 配额 hint 的 `?? 2000` / `|| 2000` 字面量改为从 registry config 取、缺省 0（zhipu 侧 `?? 1000` 同为无据字面量，一并清）。
  5. 注释与 benchmark 清偿：`src/types.ts:228-229`、`src/search/FreeTierRouter.ts:5-10`、`src/config/quota-ledger.ts:17`（"N×2000/月"）、`src/benchmark/run-ab-benchmark.ts`（brave_free_quota_per_month 2000→1000 及文案行）。
  6. 连带测试更新（brave 层级 L2→L4 语义）：`test/unit/free-tier-router.spec.ts:36,114`、`test/integration/provider-registry.spec.ts:180`、`test/integration/attributed-search.spec.ts:535` 及相关描述文案。
- **收益**：本次事故主诉在运行时层的根除——quota 账本不再高估一倍、doctor 不再指引用户去撞付费墙、free_only 路由不再把计费 API 当免费层。这是 d3d1b24 的补全（该 commit 只修了文档）。
- **验收**：`grep -rn "2000" src/` 中配额语境零命中（output-envelope 的 2000 行上限等无关常量除外）；`grep -rn "免费" src/` 零 Brave 免费层断言；配 key 跑 `lasso doctor` 输出 N×1000；门禁全绿（基线不减，测试数允许净增）。

### S-2 KEY-GUIDE 时效标注制度（RCA 建议 b 全量落地）

- **改法**：`doc/usage/01-KEY-GUIDE.md`：① 总表加「最后核实」列，全表补 `2026-08-17`；② 智谱/Brave/Bing 各节头部加「> 本节数额事实最后核实：2026-08-17（方式：官网 pricing 页亲取 / 控制台注册亲历 / 微软 lifecycle 公告）」；③ 文件头部「维护规则」段写入三条重核触发条件：距最后核实 >90 天且将被引用作决策（发版/README 同步/审查轮引用）；doctor deep probe 探测计划级异常（S-3）；上游 lifecycle/pricing 公告（Brave blog changelog、Microsoft lifecycle 进静默 surveillance 锚点清单——修补 RCA D-5）。④ 首期重核清单预登记一条：Brave 官网 FAQ「free plans … will not be charged」与「计量扣费」的口径张力，下次重核走控制台亲历确认。
- **收益**：制度层防线——每条 key 声明自带保质期与重核触发，失实不再能靠「活着」无限存活 26 天。
- **验收**：`grep -c "最后核实" doc/usage/01-KEY-GUIDE.md` ≥ 总表行数+3；维护规则段含「90 天」与「lifecycle」字样；门禁不受影响（纯文档）。

### S-3 doctor 计划级失效探测：Brave active probe（显式 opt-in）+ Bing 静态退役提示

- **改法**：`src/doctor/doctor.ts` + `src/doctor/doctor-cli.ts`：
  1. 新增 `--deep`（或 `LASSO_DOCTOR_DEEP=1`）显式开关，**默认关**——doctor 现有「零网络副作用」承诺不破；开启时 checkBraveKeys 发一次最小真实请求（`GET /res/v1/web/search?q=test&count=1`，消耗 1 次额度，输出中明示）。四分类人话（借 exa-mcp `handleRateLimitError` 的 actionable-error 范式）：200→pass；401→fail「key 无效」；403/响应体含 plan/subscription 语义→fail「计划层级异常——Brave 2026-02 起无免费档，核查 KEY-GUIDE『最后核实』列 + pricing 页」；429→warn「限流（key 本身有效）」。
  2. Bing 静态检查（零触网）：`BING_API_KEYS` 非空 → warn「Bing Search APIs 已于 2025-08-11 全量退役（微软 lifecycle 公告），该配置永远不可用，建议删除；主链已自动跳过，无功能影响」。
  3. 红线：以既有 checks[] 条目形态呈现（参照 tavily_policy_watch 先例），不开新顶级报告 key（守 check-invariants.mjs:1637 的 doctor 报告 shape 约束）；不自动禁用 channel、不自动改写 KEY-GUIDE（决策留给用户，R-8）。
- **收益**：把「用户注册撞墙才发现」变成「doctor --deep 一跑就知道」——RCA D-9/D-10 的最小可行探测器；401（凭证错）与 403（商业层失效）首次可区分。
- **验收**：mock fetch 单测覆盖四分类 + 默认关（无 --deep 时零 fetch 调用断言）+ Bing 静态 warn；门禁全绿。

### S-4 【本轮唯一新增通道】SERP 兜底非 CJK 第二引擎 `brave_serp`（ddg 失败/0 结果时一次级联）

- **改法**：`src/serp/selectors.ts` + `src/serp/extract.ts`：
  1. `SerpEngine` 扩为 `"baidu" | "ddg" | "brave"`，补 `BRAVE_SERP_SELECTORS`（result_container `.snippet` / title `.search-snippet-title` / link `.result-content > a` / snippet `.generic-snippet`——与 open-webSearch 同款锚点，为 selector 模式预留；当前抽取走 a11y 正则天然兼容）。
  2. `serpUrlFor` 加 brave 分支：`https://search.brave.com/search?q=<enc>&source=web`；freshness 无原生参数不拼（诚实降级，同 baidu 先例 round2 T2-5）。
  3. `serpScrapeFallback` 非 CJK 级联：先 ddg（默认行为 byte-identical）；当 ddg `outcome !== "worked" || data.count === 0`（202 挑战页/改版/空结果都落入此判据，兼收调研文档建议的「挑战页视为失败」）→ 用 brave URL 再调一次 browseExec；brave 有结果 → 返回 brave 结果（`retrieval_method: "serp_scrape_brave"`、`engine: "brave_serp"`、region "us"、serpHealth 记 engine "brave"）；brave 也无 → 原样返回 ddg 结果（失败语义与今日完全一致）。CJK 路径（百度）不动。
  4. `SELF_HOST_RE` 加 brave（排除 search.brave.com 自家链）。
- **白盒证据**：DDG html/lite 本日两次实测持续 202（IP 级挑战）；search.brave.com SERP 两次不同 query 实测 200 + 各 ~20 条结果；open-webSearch 生产级先例（源码亲读证实）；Lasso 抽取器是 URL 正则 over a11y 文本，对 SvelteKit DOM 改版比 CSS selector 更鲁棒。
- **红线守护**：级联在 serpScrapeFallback 内部、单一 bail-out 重试一次，非新 FallbackDecider（INV-4 单一 fallback 引擎不受触；INV-55 的禁自造循环断言域在 FallbackChain.ts，已核实不涉 serp）；SerpHealthMonitor 零改动（INV-45 不触）；仅在兜底层生效（主路径智谱/Brave API 不变），量级为最后保险而非常规通道（「SERP 是债不是资产」立场不变）。
- **收益**：英文零 key 路径从「DDG 单引擎（本网络已 curl 级死）」变为「DDG + Brave 双独立引擎」，对 IP flag / 单端点改版双免疫——这是本轮唯一有活体证据支持「增益明确」的新通道。
- **验收**：单测（mock browseExec：ddg 失败→brave 成功返 brave 结果；两者皆败→返 ddg 原结果；CJK 不级联）+ URL 构造与 SELF_HOST_RE 排除断言；可选手测 browse_headless 实跑一次英文 query；门禁全绿。

### S-5 审查方法修补：03 清单加 L-OP 运营证据级（RCA 建议 a，仓库外文档）

- **改法**：`/Users/wangdong/Documents/Project/架构想法/03_审查测试清单.md` 两处联动插入（措辞按 RCA §3a 已成稿）：① §0.3 证据阶梯表末加 `L-OP` 行（运营事实：官方 pricing/lifecycle **公告页**（带日期+URL）或 API 控制台亲历；marketing/产品页仍算 L0；定价类有效期 ≤90 天）；② §1.2 数据逻辑加项 9「外部服务运营契约」（producer 的商业存在性与字段形状同属契约，明示/暗示的存续/层级/额度/定价声明必须可溯源至 L-OP 并标核实日期，不可溯源或溯源 marketing 页 → 按失实阻断）。不新开独立节（审查预算约束，RCA 已论证）。
- **收益**：方法层防线——下一轮审查对运营事实类问题有合法证据形态与立项通道，封 RCA 七层结构中的 1.2/1.5/1.8 三层。
- **验收**：文档含「L-OP」「运营契约」「90 天」关键词；该文件在 lasso 仓库外，不进门禁（单独提交到架构思想录）。

---

## 3. 拒绝清单

| # | 候选 | 拒绝理由 |
|---|---|---|
| R-1 | SearXNG 公共实例作为零 key API 通道 | 裁决官独立实测加固 NO-GO：searx.be `format=json` 返回的是 Anubis「Verifying your browser…」挑战页（200 但 body 是 PoW），paulgo.io 429；叠加调研的 12 实例证据（9×429 limiter、JSON 普遍关闭）。三重反 API（limiter/JSON 关闭/PoW 挑战）使任何轮询池方案都不可靠。NO-GO 理由应按调研结论改写为「公共实例三重反 API」，而非旧口径「需自建」 |
| R-2 | Mojeek 引擎 | 本网络实测 503（Chrome/Firefox 双 UA）+ `fmt=json` 403 "automated queries"；对代理出口 IP 不友好，收益不可验证 |
| R-3 | DDG lite / Instant Answer JSON 升级 | lite 同 202 挑战（本日实测）；api.duckduckgo.com Instant Answer 非 web search API（`Results:[]` 空壳），升无可升 |
| R-4 | 本地 SearXNG Docker 通道（STEEL 范式 env endpoint） | 零默认路径增益（用户须自建容器才有收益），本轮收益不可验证；新增 provider+channel+配置面破简单性。零 key 结构化搜索的正规自建路径属实，记 watch，不进默认链 |
| R-5 | 整体删除 BingChannel + BING provider | 删除成本（INV-54 grep、6 针 mutation-kill 测试、freshness 透传 10 处验证资产）＞收益；S-1+S-3 的「declared-dead 占位 + doctor 退役提示」已达成诚实目标，且与 TAVILY_WATCH（enabled=false 占位 + doctor watch）既有范式一致 |
| R-6 | machine MCP detector 泛化（识别 ~/.claude.json 里任意 brave-mcp/tavily-mcp 并复用其 key） | 新机制面 + 读任意第三方 Authorization 的安全面扩大，无增益证据；现 detector 只认智谱 web-search-prime 是有意的窄契约 |
| R-7 | SERP 抽取改 CSS selector 级联为主路径 | 反向投资：a11y-URL 正则对 DOM 改版更鲁棒（Brave SvelteKit 页即例证），selector 集是 v0.7 遗产备胎；S-4 仅补 selector 占位不为切换 |
| R-8 | doctor 发现计划失效后自动禁用 channel / 自动改写 KEY-GUIDE | 第二套持久化 state，违 R-INT 简单性；doctor 职责是可见性不是决策（RCA 同判，宁缺毋滥） |
| R-9 | 给 Brave SERP 抓取建正式 provider/配额面 | S-4 已限定其为兜底层一次性 bail-out；升格为正式通道会与「Brave API 付费」商业现实对撞（ToS 风险）且需 selector 维护承诺——贪多必拒 |
| R-10 | 立即改判 KEY-GUIDE「超额自动扣费」为「免费计划不扣卡」 | 官网 FAQ 措辞（marketing 页 = L0）与控制台亲历+openclaw #16629+Implicator 报道冲突，按 L-OP 纪律应走 90 天内控制台重核（已预登记进 S-2 首期重核清单），本轮不动证据尚足的现文 |

---

## 4. 裁决

DECISION: ROUND-TUNE

一句话理由：机制面（扇出+单一降级引擎+配额账本+诚实 outcome）已是第一梯队，但本次事故的根因——运营事实失实——只修了文档层：运行时配额/层级/doctor 文案仍在向用户断言已死的免费档（S-1 必修），英文零 key 兜底押在已 202-死的单端点上（S-4 唯一新增通道），且无任何制度/探测防线阻止第三次发生（S-2/S-3/S-5）。五项全部单轮可完成、白盒可验收、不破 INV 与简单架构红线。
