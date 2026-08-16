# 第 4 轮最优性审查 · 裁决书（round4-verdict）

> 裁决官：round4-verdict。日期：2026-08-17。
> 对象：四域复审报告（round4-browser / round4-search / round4-desktop / round4-arch）+ 抽验。
> 裁决官独立门禁（06:08 窗口亲跑）：`npm run build` ✓ / `npm test` **122 files，1960 passed + 1 skipped（1961），零失败零 flake** / `check-invariants` **79/79** ✓——与 browser/search/arch 三域报告逐字一致（desktop 域报告的 1 处 timing-flaky 为已知 expect-poll 同族偶发，本次裁决官复跑未复现，不影响基线）。
> 裁决官独立白盒抽验（双源核实，不采信文档）：T3-1 locale 链三锚点（HeadlessChannel `--chromeArg=--accept-lang=` flag + 注释含 E1' 依据 / StealthEngine `profileLanguages` 恰 2 元素 + `buildUserAgentOverrideScript` defineProperty languages / doctor #25 逐 profile 直验 producer）✓；T3-4 双层上界（SteelChannel.ts:107/:360 两处 `AbortSignal.timeout(3_000)` + release 失败 catch 后**无条件**清 cachedSessionId/cachedClient——「死会话不复用」属实）✓；T3-2 接缝（parse→offsetVlmActionsByRegion→dispatch）✓；**候选 1 全部 5 处注释失实逐一亲读证实**（见 §2）。外部事实亲测：`npm view` lasso-mcp latest=**1.10.0** / chrome-devtools-mcp=**1.7.0**（锁版=latest）/ patchright=**1.61.1**——发布积压与上游零漂移声称属实。git 亲测：HEAD=0b07536（v1.11.0），工作树 59 文件未 commit，package.json=1.13.0。

---

## 1. 四维总评

### 维度一：技术选型 —— 最优（四轮收敛，零漂移）

四域全部对标数据同日实拉、零翻案：chrome-devtools-mcp 1.7.0 锁版=latest（第三轮维持零滞后）；patchright 1.61.1（roadmap v2 证据降权维持）；steel-sdk 0.18.0；camoufox 0.1.19 NO-GO 维持（「2026 最强」榜单营销 vs 主维护者离场 + bench 中游白盒实证——白盒证据优先原则执行正确）；defuddle 0.19.2=lockfile=latest（周下载 797k，T2-3/T2-4 选型持续验证）；TS SDK ^1.30.0=v1 latest（registry 冻结，v2 Q4 时机宽裕）；FastMCP 4 仍 beta。search 域本轮 3 针独立 mutation 全 kill 是选型验收的最强证据形态（测试钉行为非摆设）。crawl4ai「npm 同名包陷阱」被识别并排除（PyPI 0.9.2 不变）——数据卫生判断正确。

### 维度二：架构 —— 最优（三轮 37 项全部达最优，多项超规格）

- **T3-4 停机链**：双层上界（round3 标「可选」的加固也做了）+ 失败仍清缓存 + 行为级定时测试——超规格。
- **T3-1 locale 一致性**：全链六环节无断点 + **E1'' 本机实测**（`Accept-Language: en-US,en;q=0.9,en;q=0.9;q=0.8`，zh-CN 宿主泄漏消除，与 round3 E1' run B 预测逐字符吻合）——目标机制级实证达成。
- **T3-2 region 坐标补偿**：三处超裁决书最低线（审计标签用平移后全局坐标/scroll 守卫与 parse 不变量一致/负坐标不钳位）；前提链五环闭合。
- **T3-3 where.ref**：三层无洞（zod 剥 → Rust 兜底 → TS 前置），本轮补验 verifyExpect 与 act/find 分立无回归。
- **T3-7 INV 纪律**：14/14 红转、外部契约类全覆盖、65 条未验证 pin 显性化——「按需补样」的诚实中间解定型，符合单人可持续。
- 停机链全路径 ≤~7s、doctor 膨胀斜率 +25/轮显著放缓且本轮增量为证据等级升级（L0→L1）——架构健康度在改善通道上。

### 维度三：范围 —— 最优（宁缺毋滥纪律四轮如一）

四域 watch/NO-GO 全部零翻案且复核方式得当（无新证据不翻）；全新热点零合格项（生态连续第三轮处于 spec 后消化期；检索面为 listicle 噪音）；mac-cua（23★）记为 C-2 生态新样本而不立项——其「Electron set_value 被拒」自认限制反向验证了 Lasso T2-7 兜底链的必要性，处置精准。desktop 域四轮首次候选空集、search 域连续第二轮空集——收敛轨迹真实（本轮空集均经独立复核：新 mutation + 新拉数据，非沿用前轮结论）。

### 维度四：实施 —— 最优，残留唯一一处已知尾部（本轮调优项 T4-1）

37 项三轮调整全部落地且白盒验收；唯一残余为 T2-2/T3-5 注释卫生族的 **5 处漏网**（doctor.ts×2 + types.ts×3）。裁决官逐处亲读证实（要点：**doctor.ts:38 声称 PerformanceObserver 注入路径「健在」，而同文件 :1964 同一检查项 #27 的运行时 detail 明言「注入路径已删」——文件内自相矛盾**；types.ts:152/:479/:495 以已删机制描述现役 public API 字段，而 producer 侧 network.ts:300/cdp-actions.ts:172-173 已是正确新文案——producer 已改、类型注释未跟）。域内对 network.ts:119/descriptions.ts:641 两处「不立项」的排除判断经复核正确（历史来源表述非失实）。

**发布收口状态（流程级，非调优项）**：HEAD=0b07536（v1.11.0）/ npm latest=1.10.0 / 工作树 v1.13.0 含三轮 ≈40 项用户可感知修复（孤儿进程/假 worked/表格保真/where.ref/locale 一致性/region 坐标补偿等）未发布——四域一致指向这是当前最大欠账。属 verdict/用户动作，随本轮调优项完成后一并执行（见 §4 裁决附则）。

---

## 2. 调优项清单（1 条：T4-1）

### T4-1（P3）：PerformanceObserver 注释卫生族清尾——doctor.ts×2 + types.ts×3（T2-2/T3-5 同族漏网）

- **五准入核验**（裁决官亲验，非采信域报告）：
  1. **白盒证据** ✓——五处全部亲读证实：① `src/doctor/doctor.ts:38`（#27 清单头「PerformanceObserver 注入路径健在」——失实，v1.11 T5 已删；与 :1964 运行时 detail 自相矛盾）；② `src/doctor/doctor.ts:1903-1907`（#27 docblock「v0.5 MVP 走 evaluate_script 注入…v0.6+ 切换」——切换已于 v1.11 发生，同 docblock 下方已是 1.7.0 白盒事实，新旧行混居）；③ `src/types.ts:152`（`network_timeout_ms`「PerformanceObserver 采集窗口」——双重失实：机制已删 + 字段实为 API 兼容保留无行为消费，cdp-actions.ts:172-173 已自记）；④ `src/types.ts:479` ⑤ `src/types.ts:495`（`next_step` 两处以旧 F2「TUN 抓不全」语义描述——producer network.ts:300 已改「v1.11 起走原生 list_network_requests，无 PerformanceObserver TUN 干扰面」，类型注释未跟）。
  2. **既有范畴** ✓——与 T2-2（round2）/T3-5（round3）完全同族（注释-实现-上游三方对齐），两轮前例均已立项实施，本项是族的清尾非新开范畴；其中 types.ts 三处属 public API 文档面（npm 消费者 IDE hover 即见），v1.13.0 发布前修正使其不随版本固化。
  3. **单轮可完成** ✓——XS：纯文本 5 处，零行为改动。
  4. **收益可验证** ✓——验收机械化：`grep -rn "注入路径健在" src/` 零命中；五处新文案与 producer（network.ts:300/cdp-actions.ts:172-173/doctor.ts:1964）现值一致；门禁基线 1961/79 不减。收益实体：doctor #27 是排障入口（失实清单头直接误导排障者）；types.ts 是 API 契约文档（误导消费者与后续 AI 维护会话——单人+AI 维护模式下注释是每次会话的载荷上下文）。
  5. **不破红线** ✓——纯注释、零行为、零依赖、零新增机制（删混乱非加机器）。
- **具体改法**（域报告方案采纳，文案与 producer 现值对齐）：
  ① doctor.ts:38 →「doNetwork 加载（v1.11 起走原生 list_network_requests 直调；旧 PerformanceObserver 注入路径已随 T5 删除）」；② doctor.ts:1903-1907 →「v0.5 曾走 evaluate_script 注入 PerformanceObserver，v1.11（round1 T5）已切换 1.7.0 原生 network 工具——切换完成，非待办」；③ types.ts:152 →「v0.5 注入时代的采集窗口；v1.11 原生直调后无行为消费（cdp-actions.ts），字段保留仅为 zod 契约稳定」；④⑤ types.ts:479/:495 →「抓取量偏低启发式提示（<5 entries 多半页面真实简单；v1.11 原生采集无 TUN timing 干扰面）」。
- **范围排除（不碰）**：network.ts:119（类型形状历史来源表述）、descriptions.ts:641（正确的「switched from」历史对照）——两处保留。
- **风险**：无（零行为改动，INV/测试基线即验收）。

---

## 3. 拒绝清单（维持不立项——本轮裁决官复核确认）

| # | 项 | 拒绝理由（复核准入门槛） |
|---|---|---|
| 1 | INV-79(d) 纳入 accept-lang flag | 集成测试（stealth-headless-integration.spec.ts 四 profile 精确 flag 断言）已提供等价机械守护；INV 扩面=重复守护，违宁缺毋滥 |
| 2 | Browserbase/Steel 加 UA/accept-lang flag | round1 T2 已裁「云端指纹提供商侧负责」；无新证据不翻 |
| 3 | sec-ch-ua header 注入 / brands 三处分歧 | 结构性无解（header 不可注入），等上游；round2/3 记档维持 |
| 4 | mac-cua 式 CGEventPostToPid 简版 | C-2 触发条件（真实多任务干扰痛点）未出现；新样本自认深水区限制（复杂快捷键失败/Electron 拒绝），双向证据入档不立项 |
| 5 | VLM 多动作间延时参数化 / expect 支持 ref 后置 / T3-6 didnt 分支附截图 | 无实测失败证据（违「先拿事实再加参数」）/ 现状语义闭环 / intentional 镜像——round3 已拒维持 |
| 6 | network.ts:119 + descriptions.ts:641 注释 | 历史来源表述正确，非「路径健在」类失实——保留（本裁决官亲读确认域判断正确） |
| 7 | 全量 79 INV 样本 / doctor 预防性拆分 / outputSchema 提前铺 | 过度设计红线（单人可持续）；14 样本+显性化报告/R9 自然触碰时拆/零需求——维持 |
| 8 | Camoufox 翻案 / crawl4ai 大版本线 / R8 融合 | 榜单营销<白盒实证 / npm 同名包陷阱（PyPI 0.9.2 不变）/ 第三数据点无方向变化——全部维持 |
| 9 | 手测清单 A-G / 发布收口列为调优项 | 非代码项：前者归用户真机签核（三轮质量链最后一环），后者归流程动作（附则一）——不占调优项名额 |

---

## 4. 裁决

**DECISION: ROUND-TUNE（唯一调优项 T4-1；四域代码面除此外全部最优）**

**裁决理由**：四维复审结论——技术选型/架构/范围三维四轮收敛达最优且零翻案；实施维 37 项全部达最优，唯余 T2-2/T3-5 注释卫生族 5 处漏网。T4-1 通过五准入（证据经裁决官逐处亲读证实，含 doctor.ts:38↔:1964 文件内自相矛盾与 types.ts public API 文档失实），且与终止诉求不冲突——**v1.13.0 尚未 commit/publish，发布前以 XS 代价清掉即不随版本固化**。为「空清单而空清单」放过已证实的失实注释，与四轮审查体系自身的诚实原则相悖。

**终止条件明确（下轮即闭轮）**：round5 定位为**收尾轮（closure round）**，范围收敛为——① 实施 T4-1（grep 可验收）+ 门禁复跑（基线 1961/79 不减）；② **执行 round3 附则一发布收口：一次性 commit v1.13.0 + npm publish**（三轮 ≈40 项用户可感知修复已积压两版，npm latest=1.10.0，每延迟一轮孤儿进程/假 worked 等修复多压一版——四域一致催办，为本裁决附带的最优先动作）；③ 附则二手测清单 A-G 用户真机签核（含 T3-1 的 CC 全链 Accept-Language 签核，E1'' 已在机制层等价预验）。**T4-1 验收 = grep 零命中 + 门禁绿，无需重启四域 surveillance**（四域空集/零翻案已由本轮独立复核成立；除非 registry/上游 issue 面出现版本级变动）。T4-1 落地且发布完成即达终态 ROUND-CLEAN，循环终止。

---

### 附：裁决证据链（本轮亲跑/亲读清单）

- 门禁：build ✓ / npm test 122 files 1960+1skip 零 flake / check-invariants 79/79（2026-08-17 06:08）。
- 白盒：doctor.ts（30-45/1678-1693/1895-1915/1964）、types.ts（145-158/472-500）、network.ts（295-305）、cdp-actions.ts（168-178）、HeadlessChannel.ts（88-103）、StealthEngine.ts（250-300）、SteelChannel.ts（107/348-375）、index.ts（1212-1229）、ScreenshotVlmProvider.ts（19/203-210/394）、grep PerformanceObserver 全 src 13 命中逐条分类。
- 外部：npm view lasso-mcp=1.10.0 / chrome-devtools-mcp=1.7.0 / patchright=1.61.1（亲测）；git HEAD=0b07536 + 59 dirty files + package.json 1.13.0（亲测）。
- 报告：round4-browser/search/desktop/arch 全文精读；可疑声称抽验全部属实（含 desktop 报告的 timing-flaky 与其余三域零 flake 表述差异——同族偶发，非矛盾）。
