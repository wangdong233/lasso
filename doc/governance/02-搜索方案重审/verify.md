# verify.md — ROUND-TUNE（S-1..S-5）真机验证报告

> 验证员：搜索方案真机验证员。日期：2026-08-17。
> 对象：lasso-mcp v1.14.0 工作树（35 文件未提交改动 + 2 新 spec + doc/governance/02 + 架构想法/03）。
> 方法：全部结论以真机实跑为准（MCP stdio 端到端 / doctor CLI 实跑 / curl 亲取 / 真 Chrome 亲历 / git stash 基线对照）；mock 测试结果不作为运行时证据（03 §0.3）。

---

## 0. 门禁终跑（先给结论）

| 门禁 | 结果 | 明细 |
|---|---|---|
| `npm run build` | ✅ PASS | tsc 零错误，dist 产物生成 |
| `npm test` | ✅ PASS | **124 files / 1993 passed + 1 skipped**（基线 1961 → 净增 32，无减少） |
| `npm run check-invariants` | ✅ PASS | **All 79 invariants passed**（基线 79，零减少） |
| cargo | N/A | 本轮 diff 零 `.rs` 文件（`git diff --name-only` 核实），Rust helper 无涉 |

版本三处对齐（INV-63）：package.json = index.ts = doctor.ts = **1.14.0** ✅（doctor-cli spec 实测断言通过）。

---

## 1. 验证表（对照裁决书 §2 验收标准逐项）

### S-1 运行时事实清偿

| # | 验收标准（verdict §2 S-1） | 真机证据 | 判定 |
|---|---|---|---|
| 1 | `grep -rn "2000" src/` 配额语境零命中 | 实跑：仅剩 output-envelope MAX_LINES=2000 / 2s timeout / latency>2000 阈值 / `slice(0,2000)` 读体 / 注释中「消灭硬编码 2000」引述——配额语境 **0 命中** | ✅ |
| 2 | `grep 免费` 零 Brave 免费层断言 | 实跑：Brave+免费 的全部命中均为新事实陈述（「2026-02 起无免费档」类）；`F0` 在 src/ **0 命中** | ✅ |
| 3 | providers.ts BRAVE 1000/L4、BING 0/L4 | 代码核实 + 「S-1 运营事实锁」spec（provider-registry.spec.ts:231-249）：BRAVE=1000/L4、BING=0/L4、3 Key 池 totalRemaining=3000 | ✅ |
| 4 | 配 key 跑 `lasso doctor` 输出 N×1000 | 实跑 `BRAVE_API_KEYS=dummy1,dummy2,dummy3 node dist/index.js doctor`：`brave_keys: pass "3 Key 已配置（合并配额 ≈ 3000/月，付费计划 $5 赠送额度口径）"`（3 Key 避开 2×1000=2000 歧义；读数来自 providers.ts 单一真源） | ✅ |
| 5 | :1106 next_step 不再指引用户撞付费墙 | 实跑（无 key）：`「（可选）export BRAVE_API_KEYS=… —— Brave 2026-02 起已无免费档，付费计划含 $5/月赠送额度（≈1000 次，需绑卡）；零 key 免费路径用智谱 + 实搜兜底即可，详见 doc/usage/01-KEY-GUIDE.md」` | ✅ |
| 6 | BudgetTracker hint 缺省 0、行为 byte-identical | 源码核实 `?? 0/\|\| 0` + `allocateLimit`（MultiSourceFanout.ts:288-291）：`quotaPerMonth<=0 → quotaWeight=1`，与旧字面量路径（ratio=1.0）等权——缺省分配 byte-identical 声明**源码证实** | ✅ |
| 7 | 显式 free_only=L1/L2 不再放行 Brave | **MCP stdio 实跑**（BRAVE_API_KEYS=假 key + 无 zhipu + machine MCP 屏蔽）：per-call `free_only:"L2"` → actions 仅 `[search.zhipu(unknown), browse_headless]`，**Brave 零尝试**（对照 L4 跑：`search.brave → didnt brave_status_422` 真实触网） | ✅（per-call 参数） |
| 8 | （隐含）全局 env `LASSO_SEARCH_FREE_ONLY=L2` 同样生效 | **实跑失效**：env 设 L2 + Brave 配 key → 链仍真实调用 Brave（`brave_status_422`）。根因：`config.searchFreeOnly`（config.ts:387 解析）**全仓库零消费者**（grep src/+test/ 仅 config.ts 自身）；search.ts:213 只读 `args.free_only ?? "L4"`。v0.2 落地至今的死配置 | ❌ → **F-1（P1）** |

### S-2 KEY-GUIDE 时效标注制度

| # | 验收标准 | 真机证据 | 判定 |
|---|---|---|---|
| 1 | 总表加「最后核实」列、全表补日期 | 实查：快速对照表加列；5 个涉数额 key 行（ZHIPU/BRAVE/BING/BROWSERBASE/STAGEHAND）全部 `2026-08-17`，3 个无数额行（env 开关/passphrase）为 `—` 合理 | ✅（实质） |
| 2 | 智谱/Brave/Bing 三节头部核实戳（含方式） | 三节均有 `📅 本节数额事实最后核实：2026-08-17（方式：…）`，方式与裁决书 §2 一致（Bing 节明确标 L-OP 级证据） | ✅ |
| 3 | 维护规则含 90 天 + lifecycle + 三触发 | 实查：`90 天` ×2、`lifecycle` ×3、三触发条件（>90 天决策引用 / doctor --deep 计划级异常 / 上游公告）+ surveillance 锚点补丁 + 首期重核清单（Brave FAQ 口径张力预登记） | ✅ |
| 4 | `grep -c "最后核实" ≥ 总表行数+3` | 字面公式**未达**：grep 行命中=6（1 表头 + 3 节戳 + 2 规则段），日期行只含日期不含该词。按公式字面 6 < 8+3 | ⚠️ 公式语义缺陷，实质交付完整（见上 3 行） |
| 5 | （连带）doc 层无残留死事实 | **漏网**：`doc/testing/01-功能测试清单.md:440-441` 仍写 Brave「Free 2000 次/月/key」、Bing「F0 免费层 1000 次/月 — Azure 门户」 | ❌ → **F-5（P3）** |

### S-3 doctor 计划级失效探测

| # | 验收标准 | 真机证据 | 判定 |
|---|---|---|---|
| 1 | 默认关、零网络副作用 | 实跑默认 doctor：35 checks，**brave_deep_probe 不出现**；spec 断言零 fetch 调用 | ✅ |
| 2 | --deep / LASSO_DOCTOR_DEEP=1 等价 | 两种触发实跑均出现 #11b；无 key → warn「无事可做」人话文案 | ✅ |
| 3 | 四分类人话（200/401/403+plan/429） | **真 API 契约偏离**：假 key 实跑 → `fail "Brave API 422（响应体含 plan/subscription 语义）：计划层级异常…"`。curl 亲取原始响应：`HTTP 422 {"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"The provided subscription token is invalid.","meta":{"component":"authentication"}}`——Brave 对无效 token 回 **422**（非 401），且文案自带 "subscription" 字样命中 `/plan\|subscription/i`，导致**凭证错误被误分类为「计划层级异常」**，next_step 指引去查订阅计划（错误建议）；「消耗 1 次额度」对被拒请求亦不实（未鉴权不计量） | ❌ → **F-2（P2）** |
| 4 | Bing 静态退役提示 | 实跑：未配 → `pass`（常态）；配 `BING_API_KEYS=deadbeef` → `warn「1 个 BING_API_KEYS 已配置，但 Bing Search APIs 已于 2025-08-11 全量退役…建议删除」`，**不进 blockers**（blockers 仍仅 zhipu_api_key/cdp_9222 环境项） | ✅ |
| 5 | checks[] 形态、不开新顶级 key、INV 不破 | check-invariants 79/79（含 doctor 报告 shape 约束）；R-8 红线（不自动禁用/不改写 KEY-GUIDE）代码核实未触 | ✅ |
| 6 | mock fetch 单测覆盖四分类 + 默认关 | doctor-deep-probe.spec 30 测试全绿（但 mock 按 401 假设写死 → 正是 F-2 未被测试捕获的原因，03 §1.2-1 教科书案例） | ✅（测试在）/ ⚠️（mock-现实分歧） |

### S-4 brave_serp 非 CJK 第二引擎

| # | 验收标准 | 真机证据 | 判定 |
|---|---|---|---|
| 1 | 单测：级联/皆败/CJK 不级联/URL/SELF_HOST_RE | serp-brave.spec 全绿（30 项中属 S-4 的全部通过） | ✅ |
| 2 | URL 构造 | 实跑 `serpUrlFor("brave","rust axum",8)` = `https://search.brave.com/search?q=rust%20axum&source=web`；`freshness=week` **不拼 df**（诚实降级） | ✅ |
| 3 | 级联真实发生（机制面） | 零 key 英文 query 实跑（LASSO_RECORD_SEARCH=1）：cache 落盘**两次** browse_headless 记录，URL 分别为 `html.duckduckgo.com/html/?q=…` 与 `search.brave.com/search?q=…&source=web`——**ddg→brave 级联按判据真实触发** | ✅ |
| 4 | CJK 不级联红线 | 中文 query 实跑：**仅 1 次** browse 记录（`baidu.com/s?wd=…&rn=5`），`retrieval_method=serp_scrape_baidu`，engine=baidu_serp | ✅ |
| 5 | 抽取器对真实 brave SERP 内容兼容 | 以当日 curl 亲取的真实 SERP HTML（21-22 条 snippet）合成 a11y 快照文本喂**真抽取器**：抽出 **20 条**真实结果（home-assistant.io / reddit / community 等） | ✅（半真机：见 F-4 模态限制） |
| 6 | （收益主张）英文零 key 路径双免疫 | **本网络当日实测不成立（浏览器模态）**：真 Chrome（含全新 isolated context）打开 brave SERP → **PoW 滑块验证码**（「正在验证您不是机器人」/help/pow-captcha）；同 query curl 仍 200+22 条。DDG html/lite curl=202（×47 anomaly）；真 Chrome → 图片验证码（"Unfortunately, bots use DuckDuckGo too"）。Lasso 生产模态=真 Chrome（browse_headless），恰是被挑战的模态；curl 可抓 ≠ browse 可抓 | ⚠️ → **F-4（P2-环境）**（注：当日多次程序化探测可能抬高了 IP 风险分，无法完全排除；但 fresh context 首击即验证码支持「模态级挑战」判断） |
| 7 | SELF_HOST_RE 排除自家链 | 实测两处缺口：裸域 `https://search.brave.com`（无尾斜杠） escapes 正则；页脚 promo 链（`brave.com/*`、`account.brave.com`、`talk.brave.com`）不在排除表 → 若引擎在浏览器模态可用，~11 条页脚链会混入结果 | ⚠️ → **F-6（P3，潜伏）** |

### S-5 审查方法修补（仓库外）

| # | 验收标准 | 证据 | 判定 |
|---|---|---|---|
| 1 | 03 清单含 L-OP / 运营契约 / 90 天 | 实查 `/Users/wangdong/Documents/Project/架构想法/03_审查测试清单.md`（注意：实际路径在 Project/ 下，非 Documents/ 直下）：§0.3 L-OP 行（L44）+ §1.2 项 9（L75）+ 注记（L77），关键词全命中 | ✅ |
| 2 | 不进 lasso 门禁 | 未进（纯外部文档） | ✅ |

---

## 2. 零 key 全链路演练（空 config + 全 key 拔除）

环境：`LASSO_CONFIG_PATH=空 JSON`、`LASSO_MACHINE_CLAUDE_JSON_PATH=不存在文件`、无 ZHIPU/BRAVE/BING env、独立 cache dir、MCP stdio 真跑。

| 场景 | 链路实迹（actions_and_results） | 最终信封 | 评 |
|---|---|---|---|
| 英文（machine MCP 屏蔽） | `search.zhipu → unknown "ZHIPU_API_KEY missing"` → `browse_headless → worked` | `outcome=worked, count=0, engine=ddg_serp, retrieval=serp_scrape_ddg` | 链路诚实（每跳如实上报）；结果为空因 F-3/F-4 |
| 中文（同上） | zhipu unknown → browse_headless（**仅 baidu 一次**，不级联） | `serp_scrape_baidu / baidu_serp, count=0` | 红线保持 ✅ |
| 英文（machine MCP 保留=用户真实态） | `search.machine_mcp → unknown（1598ms，200 但解析 0 条）` → zhipu unknown → browse_headless | 同上 count=0 | machine MCP 检测✅调用✅但解析 0 条（对照实验：同一 MCP 经 CC 客户端直调返回 10 条结果）→ **F-8（观察项，pre-existing 协议缝）** |
| Brave 假 key（L4） | zhipu unknown → `search.brave → didnt "brave_status_422"`（真实触网） | `outcome=didnt` | 4xx→didnt 不升级跨模态，符合三态语义 |
| Bing 假 key | zhipu unknown → `search.bing → unknown "bing_keys_exhausted"`（latency 0ms=账本预拦截**零触网**）→ browse_headless | `serp_scrape_ddg, count=0` | **Bing 处置后降级链符合设计**：quota=0 → 账本即刻耗尽 → 跳过，诚实报 bing_keys_exhausted |

**免费路径可用性结论（本机当日）**：零 key 英文实际产出=0 条（machine MCP 解析缝 + DDG/brave 浏览器模态双验证码 + F-3 快照空）。免费路径的**降级链与上报诚实**达标；**可用性**未达标——与裁决书 §1 ② 的担忧一致，且 S-4 在本网络未能兑现「双免疫」收益（F-4）。

---

## 3. 新发现清单（按严重度）

| # | 级 | 发现 | 证据 | 建议处置 |
|---|---|---|---|---|
| F-1 | **P1** | `LASSO_SEARCH_FREE_ONLY` 是死配置：config.ts:387 解析、全仓库零消费者；search.ts:213 只认 per-call `args.free_only ?? "L4"`。KEY-GUIDE（本轮更新）env 表明确承诺「设 L2 只用免费源（Brave 计量计费属 L4，会被排除…）」——**文档承诺运行时不兑现**。配了真实 Brave key + 设 L2 的用户会把请求打进**计量计费** API（真金白银） | env L2 实跑 brave 仍被调用（brave_status_422）；grep searchFreeOnly 消费者=0；v0.2（52e86b2）落地即死 | 接线 `config.searchFreeOnly` 为 args.free_only 缺省（一行 + 测试），或撤文档承诺；**建议发布前修** |
| F-2 | **P2** | doctor --deep 四分类与 Brave 真实 API 契约不符：无效 token 实返 **422 SUBSCRIPTION_TOKEN_INVALID**（authentication component），非假设的 401；`/plan\|subscription/i` 正则把「subscription token is invalid」吸进「计划层级异常」桶 → key 抄错的用户被指引去查订阅计划/绑卡（错误 next_step）；对被拒请求宣称「消耗 1 次额度」不实 | 假 key 实跑 + curl 原始响应（本文件 §1 S-3 行 3） | 分类加 `code=SUBSCRIPTION_TOKEN_INVALID / meta.component=authentication → key 无效`分支；4xx 拒绝时不称消耗额度 |
| F-3 | **P1-环境（pre-existing）** | 本机 browse_headless 快照恒为 `RootWebArea url="about:blank"`（62 字节）——**任何 URL**（含 example.com）皆空。v1.13 committed 基线（git stash 对照实测）同样复现 → **非本轮引入**。它使 serp 兜底在本机整体失效，并挡住 S-4 的完整 E2E 验证 | example.com 实跑 + stash 基线实跑，两者 preview 逐字节相同 | 立独立修复单（疑 snapshot 抢跑 navigation / chrome-devtools-mcp 1.7.0 上下文错位） |
| F-4 | **P2-环境** | brave SERP 与 DDG 在**真 Chrome 模态**（含 fresh isolated context）当日均出验证码（PoW 滑块 / 选鸭子图）；curl 模态 brave 200+21-22 条。S-4 的白盒前提（curl 200）**不可迁移至生产模态**，「双免疫」在本网络不成立 | chrome-devtools 真 Chrome 两次开页快照 + curl 对照 | KEY-GUIDE/verdict 口径补充「brave SERP 浏览器模态可能遇 PoW」；S-4 保留（无害且有 curl 侧证据），收益预期降级 |
| F-5 | P3 | doc/testing/01-功能测试清单.md:440-441 残留死事实（Brave「Free 2000 次/月/key」、Bing「F0 免费层…Azure 门户」）——两轮文档清偿（d3d1b24 + 本轮 S-1）均漏 | grep 实据 | 顺手清偿 |
| F-6 | P3 | SELF_HOST_RE brave 排除缺口：裸域无尾斜杠 escapes；`brave.com`/`*.brave.com` 页脚 promo 链不在排除表（潜伏：引擎浏览器模态恢复后会混入 ~11 条噪音） | 真实 SERP 内容喂真抽取器实测 | 补 `(search\.brave\.com)(/|$)` + `*.brave.com` |
| F-7 | P3 | serp 信封语义：挑战页/空快照（preview 非空但 count=0）最终上报 `outcome=worked`——与项目自身「200 空→unknown」标准相悖（级联判据内部正确消费 count，但外层信封可 worked+0） | 零 key 演练最终信封 | count=0 时 outcome 降为 unknown（小改，注意缓存写入条件联动） |
| F-8 | 观察项 | machine_mcp 通道经 Lasso raw-HTTP 调用返回 200 但解析 0 条（unknown）；同一 MCP 经 CC 客户端直调正常返回 10 条。pre-existing（INV-72 机制本轮未触），疑响应形状/协议细节 | 双对照实验（§2 表行 3） | 记 watch，配 ZHIPU key 时无影响 |

---

## 4. 03 审查（六维度）

依据 `/Users/wangdong/Documents/Project/架构想法/03_审查测试清单.md` §1（含本轮 S-5 新增的 §0.3 L-OP 与 §1.2 项 9——首次以新规则审本轮自身）：

| 维度 | 判定 | 要点 |
|---|---|---|
| 1.1 代码规范 | ✅ 通过 | 注释全部 WHY+日期+URL（L-OP 就位）；命名与既有 checks[] 范式一致；无 style-only 混入 |
| 1.2 数据逻辑 | ⚠️ 有条件通过 | **项 9（运营契约，本轮主诉）**：providers/doctor/KEY-GUIDE 全部声明可溯源至 L-OP+核实日期 ✅（对照 12 个月 Bing 失察，机制性根治生效）。但：F-2 = 状态码假设无 producer 证据（mock 自证，真 API 反例）——项 1「producer 契约验证」违例；F-1 = 文档声明无运行时证据；F-5 = doc/testing/01 不可溯源声明残留 |
| 1.3 业务逻辑 | ✅ 通过 | doctor 检查 append-only、无新守护线程/自启组合（1.3-1a 不触发）；三态/outcome 语义未漂移 |
| 1.4 端到端接通 | ⚠️ 有条件通过 | 值级 trace 已做（§2 演练表逐跳值+error 串）；缺口：serp 终点被 F-3 挡、machine_mcp 接缝 F-8 未解——两处均为 pre-existing，非本轮 diff 引入 |
| 1.5 性能/生产就绪 | ✅ 通过 | deep probe：disable switch（默认关）✅ rollback（flag 无状态）✅ metrics（checks[] + latency 日志）✅ 8s 超时 ✅；无主线程同步重活；额度消耗披露（除 F-2 的 4xx 误报） |
| 1.6 简单架构 | ✅ 通过 | 未开第二 fallback 引擎（级联在 serpScrapeFallback 内单次 bail-out，INV-4/55 未触，79 INV 实证）；scrapeEngineOnce 抽取复用两引擎（正向 DRY）；硬编码 2000 收敛到 providers.ts 单一真源（变更放大率下降） |
| 1.7 冗余与废弃 | ⚠️ 有条件通过 | F-5（stale doc 残留）+ F-1（死配置 knob，v0.2 落地即无消费者——「未调用的代码是关于系统行为的谎言」现行案例）；主清偿面（src 层）干净 |

**03 总结论**：**通过（附条件）**。ROUND-TUNE 五项全部真实落地且门禁全绿；本轮在 1.2-项 9（其自身设立的 L-OP 规则）上首次实现「运营事实可溯源」的机制闭环。条件（发布前建议清偿）：**F-1**（free_only env 死配置——涉付费源误扣费，文档已承诺）、**F-2**（deep probe 422 误分类——本轮新功能的真契约分歧）；F-3/F-4 立环境修复单不阻塞本轮；F-5..F-7 顺手项。

---

## 5. 总判定

**VERIFIED WITH FINDINGS**：S-1..S-5 实施属实、验收标准 21/23 项实机通过（2 项打条件：S-2 公式字面未达但实质完整、S-1 env 全局档死配置）；门禁 build + 1993 tests + 79 INV 全绿零基线回退；新发现 8 项（P1×1 + P2×2 + P1-环境×1 + P3×3 + 观察×1），其中 F-1/F-2 建议随本轮或紧随发布修复，F-3 需独立修复单（它同时是本机 serp 兜底与 S-4 完整 E2E 的公共阻塞点）。
