# 第 5 轮最优性审查 —— 浏览器自动化与反检测域（收尾轮 closure round）

> 调研员：round5-browser。日期：2026-08-17。
> 性质：第 5 轮复审。round4-verdict 已定位本轮为**收尾轮**：四域代码面除 T4-1 外全部最优，T4-1 落地即达 ROUND-CLEAN。本轮三任务照章执行——① 四轮全部调整（round1 T1/T2/T4/T5/T10 + round2 T2-1/T2-2 + round3 T3-1/T3-5 + round4 T4-1）落地最优性白盒抽验；② watch/NO-GO 新证据复核（无新证据不翻）；③ 全新热点。
> 基线：v1.13.0 工作树（round3 + round4 T4-1 已实施未 commit；HEAD=0b07536 v1.11.0；npm latest=1.10.0 实测确认——发布积压仍在，见 §4 流程项）。
> 本轮门禁亲跑：`npm run build` ✓ / `npm test` **122 files，1960 passed + 1 skipped（1961）零失败**（首跑出现 1 失败系与本轮并行拉取上游证据造成的负载型 expect-poll 时序 flake——round2/round4 已在案的同族偶发；卸载并行负载后复跑全绿，两次复跑一致）/ `check-invariants` **79/79 全绿**。基线与 round4 逐字一致（1961/79）。

---

## 0. 复审结论速览

| 复审问题 | 结论 |
|---|---|
| round4 T4-1（本域唯一待办，5 处注释清尾） | **已实施且达最优**：验收 grep `注入路径健在` 全 src **零命中**；五处新文案（doctor.ts:38-39 / :1906-1908 / types.ts:152 / :479 / :495）与 round4-verdict 裁决文案逐字对齐；裁决明示排除的 network.ts:119 / descriptions.ts:641 两处正确保留（历史来源表述非失实） |
| round1-3 七项（T1/T2/T4/T5/T10/T2-1/T2-2/T3-1/T3-5） | **全部维持最优，零回退**（本轮独立抽验锁版/遥测关/五 flag/mac_chrome 单源三消费/profileLanguages/skew hint/LASSO_PROXY/wsEndpoint/INV-79 全部在位） |
| 本轮独立扫雷（超出 T4-1 已知清单的同类残留搜索） | **零新缺口**：`--browser-url` 四处提及均为 logged_in 通道 http://localhost:9222 现役正确用法（INV-79(c) 只管 Browserbase wss 场景）；`HeadlessChannel.ts:12`「默认 windows_chrome_120，UA 已升 Chrome 130」属 v1.5 版本化 changelog 历史记录（当时事实准确，同文件 :36-47 已记 v1.12 宿主对齐变更）——按 round4 排除判例（network.ts:119 同类「历史来源表述」）正确保留，非失实 |
| watch/NO-GO 新证据 | **全部零翻案**：npm 上游六包同窗零变化（chrome-devtools-mcp 1.7.0 锁版=latest 第四轮维持 / patchright 1.61.1 / camoufox 0.1.19 / steel-sdk 0.18.0 / agent-browser 0.34.0 / stagehand 4.0.1）；Chrome stable 152.0.7977.42/151.0.7922.139 零变化；Steel #245 仍 open；CloakBrowser 公共线仍 146.0.7680.177.5 且资产仍无 darwin。**唯一真新证据**：基准文章 2026-08-15/16 确有更新（modified_time 从 2026-07-12 跳变，round4 之后首次）——本轮全文拉取比对，**七工具总分表与结论逐格未变**（nodriver 28/3/0、cloak=curl 26/3/2、patchright 25/3/3、camofox 25/3/3、vanilla=rebrowser 24/2/5），更新为非实质改动（文案/营销块），不构成任何 watch 项翻案依据 |
| 全新热点 | **零合格项**：唯一新浮现名字 **Donut Browser**（zhom/donutbrowser，AGPL-3.0 应用层 + **专有 Wayfern 引擎** + GUI 多 profile 形态）三重不符（license / 引擎闭源 / 工具层定位）→ NO-GO 记档；其余为 listicle 内容营销噪音（Playwright MCP 配置指南/榜单，检测轴认知未超出已归档框架） |

**本轮域内判定**：**ROUND-CLEAN（浏览器域）**。四轮十项调整全部落地且最优；唯一待办 T4-1 已实施并通过机械化验收；独立扫雷零新缺口；上游零漂移。**候选调优项：空集**（空是合法优秀结论；剩余两项均为流程级非代码项，见 §4）。

---

## 1. 任务①：四轮调整落地最优性（白盒抽验）

### 1-1. T4-1 验收（本轮核心待办）

| 验收步 | 裁决要求 | 本轮实测 | 结果 |
|---|---|---|---|
| grep 机械化 | `grep -rn "注入路径健在" src/` 零命中 | exit=1（零命中） | ✓ |
| ① doctor.ts:38-39 | 「v1.11 起走原生 list_network_requests 直调；旧 PerformanceObserver 注入路径已随 T5 删除」 | 逐字在位 | ✓ |
| ② doctor.ts:1906-1908 | 「v0.5 曾走 evaluate_script 注入…v1.11（round1 T5）已切换…切换完成，非待办」 | 逐字在位；与 :1965 运行时 detail（「注入路径已删，F2 TUN 抓不全限制关闭」）文件内自洽——round4 抓出的 :38↔:1964 自相矛盾就此关闭 | ✓ |
| ③ types.ts:152 | 「v0.5 注入时代的采集窗口；v1.11 原生直调后无行为消费（cdp-actions.ts），字段保留仅为 zod 契约稳定」 | 逐字在位，与 cdp-actions.ts:172-173 自记一致 | ✓ |
| ④⑤ types.ts:479/:495 | 「抓取量偏低启发式提示（<5 entries 多半页面真实简单；v1.11 原生采集无 TUN timing 干扰面）」 | 两处逐字在位，与 producer network.ts:300 现值同语义 | ✓ |
| 排除项不碰 | network.ts:119（类型形状历史来源）/ descriptions.ts:641（"switched from" 历史对照） | 两处原样保留 | ✓ |
| 门禁 | 基线 1961/79 不减 | build ✓ / 1960+1skip 零失败 / 79/79 | ✓ |

**判定：达最优**。T4-1 是注释卫生族（T2-2→T3-5→T4-1 三轮）的清尾，至此全 src 无「声称已删机制健在」类注释-实现失实。

### 1-2. 历轮锚点抽验（防回退）

| 项 | 锚点实测 | 判定 |
|---|---|---|
| T1 锁版 | `SubprocessManager.ts:49` LOCKED=1.7.0；npm latest 实拉 1.7.0（2026-08-10）零漂移 | 最优维持 |
| T1 遥测关/迁移 | spec `--no-usage-statistics`（HeadlessChannel.ts:87）；Browserbase `--wsEndpoint=`（BrowserbaseChannel.ts:169）；INV-79(a)(b)(c) 绿 | 最优维持 |
| T2+T2-1+T3-1 launch 级五 flag | `--chromeArg=--disable-blink-features=AutomationControlled`（:88）/ `--chromeArg=--user-agent=`（:90）/ `--chromeArg=--accept-lang=`（:96，注释含 E1' 依据）/ `--viewport=`（:97）/ `--proxy-server=` 条件展开（:98-99） | 最优维持 |
| T2-1 mac_chrome | `defaultHeadlessProfileForHost()`（HeadlessChannel.ts:41-43）单源三消费（index.ts:433 / doctor-cli / doctor.ts:147+1738）；profile 四方一致（UA Macintosh ↔ platform "MacIntel" ↔ secChUaPlatform "macOS" ↔ brands 151，ghost 151%4=3） | 最优维持 |
| T2-1 rider skew hint | doctor.ts:1787-1826（探测/|skew|≥2 文案/失败静默）；#25 detail 拼接 :1738-1742 | 最优维持 |
| T4 profile 151 | Chrome stable 实拉 152.0.7977.42/151.0.7922.139（与 round2/3/4 相同）→ 151 仍当前时代值 | 最优维持 |
| T5 原生 network/console | dispatch Map 原生直调（round4 验收）；本轮注释层已由 T4-1 清尾 | 最优维持 |
| T10 LASSO_PROXY | HeadlessChannel spec 条件 flag + SteelChannel proxyUrl（:79-82）；logged_in 双负向测试（proxy-egress.spec，round2/4 验收） | 最优维持 |

### 1-3. 本轮独立扫雷（T4-1 已知清单之外）

- **`--browser-url` 全 src 五处**：四处（descriptions.ts:166 / annotations.ts:248 / browse.ts:166 / config/providers.ts:61）+ LoggedInChannel.ts:150 实装——全部描述 logged_in 通道连本地 DevTools HTTP 端点（`http://localhost:<cdpPort>`）的**现役正确用法**；INV-79(c) 的 wsEndpoint 互斥守护只针对 Browserbase wss+自定义头场景（round1 T1 裁决范围）。非残留。
- **`HeadlessChannel.ts:12`**（「默认 windows_chrome_120，UA 值已升 Chrome 130」）：位于 `v1.5（parse13 §3.4 P0 核心修复）:` **版本化 changelog 块**内——v1.5 当时两事实均准确；v1.12 变更由同文件 :36-47 独立块正确记录。属「历史来源表述」非「活声称失实」，与 round4 裁决排除的 network.ts:119 同判例，正确保留。
- **云通道 profile 默认表述**（BrowserbaseChannel.ts:99 / SteelChannel.ts:149 / browserbase.ts:66「默认 windows_chrome_120」）：描述各自构造器默认值，准确；云通道不加 UA flag 属 round1 T2 已裁「云端指纹提供商侧负责」+ round4 拒绝清单 #2，无新证据不翻。
- **结论**：T2-2/T3-5/T4-1 注释卫生族在浏览器域全域闭环，无第四轮同族漏网。

---

## 2. 任务②：watch/NO-GO 新证据复核

| 项 | 前轮处置 | 本轮新证据（2026-08-17 实拉） | 结论 |
|---|---|---|---|
| R1 patchright | roadmap v2.0，证据降权 | npm 1.61.1（2026-06-23）零变化 | **维持** |
| R6 Steel per-session release | watch（#245 修复前保持全量 release） | zread 复核 issue #245 仍 open（「This issue remains open」）；steel-sdk npm 0.18.0（2026-03-16）零变化 | **维持 watch，现状正确** |
| R7 camoufox | NO-GO（主维护者离场） | npm 0.1.19（2025-09-20）stale 如故 | **维持 NO-GO** |
| W-B1 无 shim CDP（nodriver 范式） | watch（v2.0 议题） | **基准文章 8 月更新全文核对**（见下）：nodriver 28 OK/0 blocked 结论未变、AGPL/Python 属性未变、无新数据集 | **维持 watch** |
| W-B2 CloakBrowser | watch（darwin 管线复活 + license/-pro 澄清再评） | releases 网页实拉：公共线顶仍 chromium-v146.0.7680.177.5（pro 线 v148/v150 系存在，公共-pro 版本差维持）；expanded_assets 实拉 146 公共资产**仍仅 linux-x64 + windows-x64，无 darwin** | **维持 watch**（触发条件未满足；基准文章更新后的 CloakBrowser 段落仍记载 darwin 钉 145「dead for two months」且 cloak=curl_cffi 平分结论未变） |
| R-ECO-6 Stagehand REST | 档案已更新，v1.8 决策点 | @browserbasehq/stagehand npm 4.0.1（2026-08-14）零变化；无 REST 形状变化证据 | **维持** |
| sec-ch-ua header 注入 | 不做（等上游） | chrome-devtools-mcp npm latest 仍 1.7.0（CLI 无 header 工具面） | **维持不做** |
| Chrome stable / profile 151 | 时代值维持 | versionhistory API：152.0.7977.42 / 151.0.7922.139 零变化 | **维持** |
| agent-browser / browserless 第五通道 | round1 结论维持 | npm 0.34.0（2026-08-10）零变化 | **维持** |

### 本轮唯一真新证据：基准文章 2026-08-15/16 更新的完整核对

round4 记录该文 modified_time=2026-07-12；本轮 curl 直拉原始 HTML 实测 `article:modified_time=2026-08-15T08:27:54-08:00` 且 `Last-Modified: Sun, 16 Aug 2026 22:27:33 GMT`——**round4 之后首次实质时间戳跳变**，触发「新证据必查」义务（注意：web-reader 工具命中 7 月旧缓存导致初判矛盾，已用 curl 原始 HTML + 表格单元格级解析仲裁）。

**核对方法**：curl 拉取 196KB 原始 HTML → Python 逐 `<td>` 解析七工具总分表 → 与 round2/round4 归档值逐格比对 → 章节标题与关键结论串计数核对。

**核对结果（更新后现状）**：

| Browser | OK | Gated | Blocked | Engine | vs round2/4 归档 |
|---|---|---|---|---|---|
| nodriver | 28 | 3 | 0 | Google Chrome 148（system） | **逐格一致** |
| cloak | 26 | 3 | 2 | Chromium 145.0.7632.109 | **逐格一致** |
| curl_baseline | 26 | 3 | 2 | curl_cffi 0.15.0 | **逐格一致** |
| patchright | 25 | 3 | 3 | Chrome 148（channel=chrome） | **逐格一致** |
| camofox | 25 | 3 | 3 | Firefox 135.0.1-beta.24 | **逐格一致** |
| vanilla | 24 | 2 | 5 | Chromium 147.0.7727.15 | **逐格一致** |
| rebrowser | 24 | 2 | 5 | Chromium 136（rebrowser bundle） | **逐格一致** |

章节结构（automation-protocol fingerprinting / shape coherence / channel=chrome 大于补丁 / nodriver AGPL 注意事项）全部原样；工具集无新增；无 2026-08 新数据集标记。**判定：本次更新为非实质改动**（文案/营销邮件块/WordPress 缓存重建类），对 W-B1/R1/W-B2 的既有结论零影响——新证据已查、不构成翻案，按「无（实质）新证据不得翻」全部维持。

---

## 3. 任务③：全新热点

零合格项。增量面：

1. **Donut Browser**（zhom/donutbrowser，2026 榜单新浮现的「最活跃开源 antidetect」声称）——白盒核实：**AGPL-3.0 应用层 + 专有闭源 Wayfern Chromium 引擎 + GUI 多 profile（Multilogin 开源替代）形态**。三重不符 Lasso：① AGPL+闭源引擎与 MIT/npm 分发红线冲突；② GUI 多账号矩阵定位与工具层 MCP（forest 统一入口）正交（round1 起对 GoLogin/Octo/Multilogin 家族的不收录理由直接覆盖）；③ 无 CDP/API 驱动面可接（automation 支持为产品内功能非库接口）。→ **NO-GO 记档**（与 camoufox/browserless 同格，不设 watch——license+形态双死，无触发条件可翻）。
2. 其余检索面为内容营销噪音：Playwright MCP × Claude Code 配置指南、MCP 榜单 roundup（商业 SaaS 导流）——检测轴认知未超出 round2 已归档的 automation-protocol fingerprinting + shape coherence 框架；工具层（chrome-devtools-mcp / Steel / browserless / browser-use / stagehand / agent-browser）同窗零变化。
3. 生态连续第四轮处于「spec 后消化期」，与 round3/round4 判断一致。

---

## 4. 候选调优项

**空集。**

- **五准入核验**（对本域全部潜在面的终判）：① 白盒证据差距——T4-1 清尾后独立扫雷零新缺口（§1-3）；② 既有能力范畴——无超出既有机制的新需求；③ 单轮可完成——无待办代码项；④ 收益可验证——无可验证收益的新项；⑤ 不破红线——无候选即无风险。空集是四轮收敛后的真实终态，非审查不充分（本轮新增独立扫雷 + 基准文章全文核对两道额外工序）。
- **剩余两项均为流程级非代码项**（round4-verdict 附则已定归属，不占调优项名额）：
  1. **发布收口**：HEAD=0b07536（v1.11.0）/ npm latest=1.10.0 / 工作树 v1.13.0 含四轮 ≈40 项用户可感知修复未发布——本轮实测 npm registry 确认积压仍在。归 verdict/用户动作（一次性 commit v1.13.0 + npm publish）。
  2. **手测清单 A-G 用户真机签核**（round2-manual-test-checklist.md；含 T3-1 的 CC 全链 Accept-Language 签核——round4 E1'' 已在机制层等价预验）。归用户动作。

---

## 附：本轮实测与门禁记录（2026-08-17）

- **T4-1 验收**：`grep -rn "注入路径健在" src/` 零命中（exit=1）；五处新文案亲读比对裁决逐字对齐；排除两处正确保留。
- **门禁**：`npm run build` ✓；`npm test` 122 files / **1960 passed + 1 skipped（1961）**——首跑 1 failed 系与本轮并行 npm view/curl 上游取证造成的负载型 expect-poll 时序 flake（round2/round4 在案同族），卸载并行负载后两次复跑均 122 files 全绿零失败；`check-invariants` **79/79**（INV-77/78/79 亲见 PASS）。
- **上游实拉**：chrome-devtools-mcp=1.7.0（2026-08-10，锁版=latest 第四轮维持）；patchright=1.61.1（2026-06-23）；camoufox=0.1.19（2025-09-20）；steel-sdk=0.18.0（2026-03-16）；agent-browser=0.34.0（2026-08-10）；@browserbasehq/stagehand=4.0.1（2026-08-14）；lasso-mcp npm latest=1.10.0（发布积压确认）；Chrome stable（versionhistory API）=152.0.7977.42/151.0.7922.139；Steel #245 zread 复核仍 open；CloakBrowser 公共线 146.0.7680.177.5 资产仅 linux-x64/win-x64。
- **基准文章核对**：curl 原始 HTML 196KB（Last-Modified 2026-08-16 22:27:33 GMT；article:modified_time 2026-08-15T08:27:54-08:00）→ 七工具总分表逐 `<td>` 解析与 round2/4 归档逐格一致；web-reader 命中 7 月缓存导致的初判矛盾已由原始 HTML 仲裁（工具方法论注记：缓存敏感证据须以 curl 原始 HTML 为准）。
- **白盒抽验文件**：src/doctor/doctor.ts（30-45/1735-1742/1787-1826/1900-1920/1965）、src/types.ts（145-158/472-500）、src/channels/HeadlessChannel.ts（1-50/80-105）、src/browse/stealth-profiles.ts（97-165）、src/browse/StealthEngine.ts（64）、src/channels/LoggedInChannel.ts（4/150）、src/channels/BrowserbaseChannel.ts（99/161-169）、src/channels/SteelChannel.ts（66-82/149）、src/subprocess/SubprocessManager.ts（49）、src/invariants/check-invariants.mjs（4064）、src/tools/{descriptions,annotations,browse}.ts、src/config/providers.ts、grep PerformanceObserver 全 src 15 命中逐条分类（全部为正确新表述/正确历史表述/正确排除保留）。
- **来源**：[ianlpaterson 基准文章](https://ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi/)（curl 原始 HTML）、[zhom/donutbrowser](https://github.com/zhom/donutbrowser)、[donutbrowser.com open-source 页](https://donutbrowser.com/open-source-antidetect-browser/)（Wayfern 专有引擎声明）、[CloakBrowser releases](https://github.com/CloakHQ/CloakBrowser/releases)、npm registry / Chrome versionhistory API / zread（steel-dev/steel-browser）。
