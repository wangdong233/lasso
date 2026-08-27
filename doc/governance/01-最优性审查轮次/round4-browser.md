# 第 4 轮最优性审查 —— 浏览器自动化与反检测域（验收轮）

> 调研员：round4-browser。日期：2026-08-17。
> 性质：第 4 轮复审（round3-verdict 定位本轮为**验收轮**）——① 检验 round1（T1/T2/T4/T5/T10）+ round2（T2-1/T2-2）+ round3（T3-1/T3-5）本域全部调整是否达最优（白盒抽验 v1.13 工作树新代码）；② 三轮 watch/NO-GO 是否有**新证据**翻案（无新证据不翻）；③ 全新热点。不重复已裁决内容。
> 基线：v1.13.0 工作树（round3 T3-1..T3-7 已实施未 commit；HEAD=0b07536 v1.11.0）。本轮门禁亲跑：`npm run build` ✓ / `npm test` 122 files **1960 passed + 1 skipped（1961）零失败零 flake** / `check-invariants` **79/79 全绿**（基线较 round3 的 1941 净增 20，全部来自 round3 T 项新增测试）。
> 方法：源码白盒（HeadlessChannel / stealth-profiles / StealthEngine / doctor / BrowserbaseChannel / types / network / 集成与单元测试）+ npm registry / Chrome versionhistory / Steel zread / CloakBrowser releases 网页实拉（注：本网络下 api.github.com 被 TUN 劫持全 404，改走 github.com 网页 + expanded_assets 直拉）+ 基准文章 meta 实拉（article:modified_time）+ **本机 L3 实测 E1''（v1.13 精确 flag 组合真跑 echo server）**。

---

## 0. 复审结论速览

| 复审问题 | 结论 |
|---|---|
| round1 五项（T1/T2/T4/T5/T10） | **达最优**（round3 已验收；本轮抽验 spec/profile/doctor 现状无回退：锁版 flag/遥测关/UA+viewport+accept-lang flag 全在位） |
| round2 T2-1（mac_chrome 宿主对齐）+ rider（skew hint） | **达最优**：defaultHeadlessProfileForHost 单源三消费、四方一致断言、doctor.ts:1786-1826 skew hint（\|skew\|≥2 提示 + 探测失败静默回退）全部在位；E1'' 复证 `sec-ch-ua-platform:"macOS"` ↔ UA Macintosh 同 OS |
| round2 T2-2 + round3 T3-5（档案注释卫生） | **主体落地，同族仍有 5 处漏网**（doctor.ts:38/:1906、types.ts:152/:479/:495——声称已删除的 PerformanceObserver 路径「健在」/仍在用旧 F2 语义描述现役字段）→ 候选 1（P3，与本族 T2-2/T3-5 完全同性质） |
| round3 T3-1（locale 层间一致性） | **达最优且目标实测达成**：spec flag（HeadlessChannel.ts:96）/ profileLanguages 派生（StealthEngine.ts:254-257）/ buildUserAgentOverrideScript 注入（:296-299）/ CORE #2 注释指路（机制等价迁移，16 路计数不变）/ doctor #25 逐 profile 校验（doctor.ts:1678-1693）/ 集成测试四 profile 逐个断言 / 手测清单 B 扩展——全链在位。**E1'' 实测**：v1.13 组合下 `Accept-Language: en-US,en;q=0.9,en;q=0.9;q=0.8`（profile 主 token 主导，zh-CN 宿主泄漏消除，与 round3 E1' run B 预测逐字符吻合） |
| round3 T3-5（StealthEngine 注释归真） | **达最优**（:60-65 真实表述 --viewport= + timezone 无 flag + 档案字段无行为消费） |
| 实施者选择记录（非缺口） | ① INV-79(d) 未纳入 accept-lang——round3 标注「实施者定」；集成测试 stealth-headless-integration.spec.ts:322-340 提供等价机械守护（四 profile 逐个构造 + 精确 flag 断言），守护等价，不立项；② Browserbase/Steel spec 无 UA/accept-lang flag——round1 T2 已明裁「云端自带指纹不动」（round1-browser.md:68），非新缺口 |
| watch/NO-GO 新证据 | **全部零翻案**：patchright 1.61.1 / steel-sdk 0.18.0 / camoufox 0.1.19 / chrome-devtools-mcp 1.7.0 / Chrome stable 152.0.7977.42-151.0.7922.139 同日零变化；Steel #245 zread 复核仍 open；基准文章 modified_time=2026-07-12 零更新。**CloakBrowser 证据刷新**（pro 线升至 Chromium 150 领先 public 4 个 major、darwin 资产仍缺）→ watch 维持且商业化疑点加深 |
| 全新热点 | **无结构性新增**（检索面为商业 listicle 噪音；工具层/基准层零变化） |

**本轮域内判定**：三轮九项浏览器域调整全部达最优（含 T3-1 目标的机制级实测达成）；唯一残余是 T2-2/T3-5 注释卫生族的 5 处漏网（P3×1，XS 纯文本）。除该项外本域满足 ROUND-CLEAN 条件。

---

## 1. 任务①：三轮调整落地最优性（白盒抽验 v1.13 工作树）

| # | 项 | 本轮独立抽验锚点 | 判定 |
|---|---|---|---|
| 1 | T1 锁版 1.7.0 | SubprocessManager LOCKED 1.7.0；npm registry 2026-08-17 实拉 latest 仍 1.7.0（modified 2026-08-10）；INV-79(a) 绿 | **达最优**（锁版=latest 零滞后第三轮维持） |
| 2 | T2 launch 级 UA/viewport | HeadlessChannel.ts:90/:97 flag 在位；E1'' UA 头= profile 值 | **达最优** |
| 3 | T2-1 mac_chrome | HeadlessChannel.ts:41-43 单源；index/doctor-cli/doctor 三消费；四方一致 + darwin 分支测试在位；**E1'' 复证 OS 一致** | **达最优** |
| 4 | T2-1 rider skew hint | doctor.ts:1786-1826（8 候选探测路径、3s timeout、\|skew\|≥2 文案、失败静默）；#25 detail 拼接 :1737-1741 | **达最优** |
| 5 | T4 profile 151 | versionhistory 实拉 stable 152.0.7977.42 / 151.0.7922.139（与 round2/3 相同）→ 151 仍时代值；本机 Chrome 150 skew +1（<2 不警告，观测面正常工作） | **达最优** |
| 6 | T5 原生 network/console | dispatch Map 原生直调；网络/控制台行为面 round3 已验收无回退——但**注释层残留 5 处旧范式描述**（候选 1） | **行为达最优；注释债残余** |
| 7 | T10 LASSO_PROXY | spec 条件展开 :98-99 + proxy-egress 双负向测试（round2/3 已验收） | **达最优** |
| 8 | T2-2 + T3-5 注释卫生 | StagehandChannel/BrowseChannel/StealthEngine 三处已修；**doctor.ts×2 + types.ts×3 漏网**（§4 候选 1） | **主体落地，尾部 5 处** |
| 9 | T3-1 locale 一致性 | 全链六环节白盒 + E1'' 实测（下表） | **达最优且目标实证达成** |

### T3-1 六环节白盒（全链无断点）

| 环节 | 锚点 | 现状 |
|---|---|---|
| ① spec flag | HeadlessChannel.ts:91-96 `--chromeArg=--accept-lang=${profile.acceptLanguage}` | ✓（注释含 E1' run B/C 依据） |
| ② 派生函数 | StealthEngine.ts:254-257 `profileLanguages`：[language, 主子标签小写]（zh-CN→["zh-CN","zh"]，en-GB→["en-GB","en"]——真实 Chrome 同款形状） | ✓ |
| ③ 注入点 | StealthEngine.ts:296-299 buildUserAgentOverrideScript 内 defineProperty navigator.languages（先于 16 路 SCRIPT 执行，任何页面 JS 读取前就位） | ✓ |
| ④ CORE #2 迁移 | stealth-profiles.ts:284-290 原位置改注释指路（机制等价迁移非删除，headless 空数组破绽仍被 ③ 覆盖；16 路计数注释 :244-247 同步） | ✓ |
| ⑤ doctor 消费 | doctor.ts:1678-1693 逐 profile 校验 UA override 脚本嵌 languages 数组与 language 值（languages[0]===language 的 doctor 侧投影；round3-review03 的 L0→L1 升级已落地） | ✓ |
| ⑥ 测试 + 手测 | 集成 spec :322-374（四 profile 逐个构造断言精确 flag / 端到端断言 UA override 嵌 expectedLangs / acceptLanguage 主 token 与 languages 逐字符一致）+ 手测清单 B 扩展（round2-manual-test-checklist.md:26） | ✓ |

### E1'' 实测（本轮验收证据，2026-08-17，macOS 12 / Darwin 21.6.0 / 系统 Chrome 150.0.7871.182 / 本地 echo server）

v1.13 精确 flag 组合（--headless=new + --disable-blink-features=AutomationControlled + --user-agent=mac_chrome UA + **--accept-lang=en-US,en;q=0.9** + --screen-info）真跑捕获：

| 头 | 值 | 判定 |
|---|---|---|
| User-Agent | `...Macintosh; Intel Mac OS X 10_15_7...Chrome/151.0.0.0` | profile 值 ✓（T2/T2-1） |
| **Accept-Language** | **`en-US,en;q=0.9,en;q=0.9;q=0.8`** | **profile 主 token 主导 + 宿主尾巴（≈真实双语用户形态）——zh-CN 宿主泄漏消除，T3-1 目标达成，与 round3 E1' run B 预测逐字符吻合** |
| sec-ch-ua-platform | `"macOS"` | 与 UA 同 OS ✓（T2-1 维持） |
| sec-ch-ua | 宿主真值 150（brands/ghost/顺序 vs profile 151） | 残余记档维持（header 不可注入，结构性无解——round2/3 两轮记档结论不变） |

---

## 2. 任务②：watch/NO-GO 新证据复核（零翻案）

| 项 | 前轮处置 | 本轮新证据（2026-08-17 实拉） | 结论 |
|---|---|---|---|
| R1 patchright | roadmap v2.0，证据降权 | npm 1.61.1（2026-06-23）零变化 | **维持** |
| R6 Steel per-session release | watch（#245 修复前保持全量 release） | zread 复核：「This issue remains open」（2025-12-23 报告）；steel-sdk npm 0.18.0（2026-03-16）零变化 | **维持 watch，现状正确** |
| R7 camoufox | NO-GO（主维护者离场） | npm 0.1.19（2025-09-20）stale 如故 | **维持 NO-GO** |
| W-B1 无 shim CDP（nodriver 范式） | watch（v2.0 议题） | 基准文章 meta 实拉 `article:modified_time=2026-07-12`——round2 归档后零更新；nodriver 结论（28 OK/0 blocked，AGPL，Python）无新数据 | **维持 watch** |
| W-B2 CloakBrowser | watch（darwin 管线复活 + license/-pro 边界澄清再评） | **证据刷新**：releases 网页实拉——公共线顶仍 chromium-v146.0.7680.177.5，**pro 线已发至 chromium-v150.0.7871.114.6-pro（.4/.3 + v148 系共 6 个 pro tag，领先公共线 4 个 Chromium major）**；expanded_assets 实拉 146 公共资产仍仅 linux-x64 + windows-x64，**无 darwin** | **维持 watch**：活跃度回升但 darwin 断更如故（触发条件未满足）；-pro 分层商业化加深（最新 Chromium 只在付费线）→ watch 条件维持并记「公共线与 pro 线版本差扩大」事实 |
| R-ECO-6 Stagehand REST | 档案已更新（T2-2），v1.8 决策点 | npm @browserbasehq/stagehand=4.0.1（2026-08-14，SDK 活跃）——SDK 活跃不改变「REST 形状 sessions.* 无 verify、v0 unstable」的既有档案事实 | **维持**（无形状变化证据，不翻） |
| sec-ch-ua header 注入 | 不做（等上游） | chrome-devtools-mcp latest 仍 1.7.0（CLI 无 header 工具面），缺口维持 | **维持不做** |
| Chrome stable / profile 151 | 时代值维持 | 152.0.7977.42 / 151.0.7922.139 并行零变化 | **维持** |
| agent-browser / browserless 第五通道 | round1 结论维持 | npm 0.34.0（2026-08-10）零变化 | **维持** |

上游版本事实汇总（同日复查）：chrome-devtools-mcp=1.7.0（锁版=latest）、patchright=1.61.1、steel-sdk=0.18.0、camoufox=0.1.19、agent-browser=0.34.0、stagehand SDK=4.0.1、Chrome stable=152.0.7977.42/151.0.7922.139、本机 Chrome=150.0.7871.182。

---

## 3. 任务③：全新热点

无结构性新增。检索面（2026-08 一周窗）为商业 antidetect 浏览器 listicle 噪音（Nextbrowser/Scrapfly/Unbrowse/HumanBrowser 等内容营销，检测轴认知未超出 round2 已归档的 automation-protocol fingerprinting + shape coherence 框架）；唯一方法论级来源（ianlpaterson 基准）零更新。工具层（chrome-devtools-mcp / Steel / browserless / browser-use / stagehand / agent-browser）同日零变化。「Camoufox 是 2026 最强开源 antidetect」类榜单说法与 round2 实证（主维护者离场 + bench 中游 25 OK）矛盾——按「白盒证据 > 榜单营销」原则不翻 R7。

---

## 4. 候选调优项（宁缺毋滥，1 条：P3×1）

### 候选 1（P3）：PerformanceObserver 注释卫生族清尾——doctor.ts×2 + types.ts×3（T2-2/T3-5 同族漏网）

- **对标证据**（grep 可机械化复验的注释-实现失实，五处全部声称 v1.11 T5 已删除的范式仍健在或仍以旧语义描述现役字段）：
  1. `src/doctor/doctor.ts:38` —— 检查项清单头 #27：「doNetwork 加载（Go/No-Go F2；**PerformanceObserver 注入路径健在**）」——**「健在」失实**：T5（v1.11）已删除该路径，实现走 1.7.0 原生 list_network_requests（cdp-actions.ts 直调）。
  2. `src/doctor/doctor.ts:1903-1907` —— #27 docblock：「v0.5 MVP 走 evaluate_script 注入 PerformanceObserver；**上游若有专门 network_log 工具，v0.6+ 切换**」——切换已于 v1.11 发生；同一 docblock 下方「静态层/动态层」两行却已是 1.7.0 白盒事实——**同 docblock 内新旧行混居**，自相矛盾。
  3. `src/types.ts:152` —— `network_timeout_ms`：「**PerformanceObserver 采集窗口**（默认 3000ms；超时后断开 observer 读 entries）」——双重失实：机制（PerformanceObserver 已删）+ 语义（cdp-actions.ts:173 已自记「不再适用（原生工具即时返回）」，该字段现为 API 兼容保留、无行为消费）。
  4. `src/types.ts:479` + `:495` —— `next_step`：「Go/No-Go F2 提示（**PerformanceObserver 在 fake-ip TUN 下可能抓不全时填**）」×2 处——实际语义已被 network.ts:300（T5 更新版文案「v1.11 起走原生 list_network_requests，无 PerformanceObserver TUN 干扰面」）重定义为「页面真实简单 vs 采集异常提示」；producer 已改、类型注释未跟。
  - 顺带核对（**不立项、不在本项范围**）：network.ts:119「parse6 §3.4.2 注入脚本返的 entries shape」描述的是类型形状的历史来源，非「路径健在」类失实；descriptions.ts:641「switched from」是正确的历史对照表述——两处保留。
- **具体改法**：五处注释改为真实表述——①「doNetwork 加载（v1.11 起走原生 list_network_requests 直调；旧 PerformanceObserver 注入路径已随 T5 删除）」；②「v0.5 曾走 evaluate_script 注入 PerformanceObserver，v1.11 已切换 1.7.0 原生 network 工具（切换完成，非待办）」；③「network_timeout_ms：v0.5 注入时代的采集窗口；v1.11 原生直调后无行为消费（cdp-actions.ts:173），字段保留仅为 API 兼容」；④⑤「next_step：抓取量偏低启发式提示（<5 entries 多半页面真实简单；v1.11 原生采集下不再有 TUN timing 干扰面）」。
- **预期收益**：注释-实现-上游三方对齐在 T2-2/T3-5 两轮清理后的最后 5 处补齐；防未来读者按「注入路径健在」误判 network 通道有第二实现路径可回退（doctor #27 是排障入口，失实注释的直接受害者是排障者自己）。
- **实施代价**：XS（纯文本 5 处，零行为改动）。
- **风险**：无。
- **验收**：grep 全 src 无「注入路径健在」表述；`npm run build && npm test && npm run check-invariants` 基线 1961/79 不减（零行为改动）。

### 本轮明确「不做」的处置（记档）

| 处置 | 项 | 理由 |
|---|---|---|
| 不立项 | INV-79(d) 纳入 accept-lang flag | round3 明示「实施者定」；集成测试（stealth-headless-integration.spec.ts:322-340）已提供等价机械守护（四 profile 逐个构造 + 精确 flag 断言），INV 扩面属重复守护，违宁缺毋滥 |
| 不立项 | Browserbase/Steel 通道加 UA/accept-lang flag | round1 T2 已明裁「跨通道（Steel/Browserbase 云端自带指纹）不动」（round1-browser.md:68）；云浏览器指纹由提供商侧负责，Lasso JS 层注入已按既有裁决运行——无新证据不翻 |
| 记档（维持） | sec-ch-ua brands 三处分歧 / dpr=1 弱信号 / locale-IP-timezone 三维跟随 | round2/3 记档结论维持，零新证据 |
| watch 维持 | W-B1 nodriver 范式 / W-B2 CloakBrowser / R1 patchright / R6 Steel #245 / R7 camoufox / R-ECO-6 / sec-ch-ua header 注入 | §2 零翻案证据（CloakBrowser 仅证据刷新，触发条件未满足） |
| 不做 | 手测清单 B 之外的 CC 全链签核 | 属 round3 附则二发布前动作（A-G 七项 pending），非代码缺口；本轮 E1'' 已在机制层等价验收 B 的核心断言（flag 组合与头值逐字符一致） |

---

## 附：本轮实测与门禁记录（2026-08-17）

- **E1''**（本地 echo server + 系统 Chrome 150 headless + v1.13 精确 flag 组合真跑）：见 §1 表。核心数据——`Accept-Language: en-US,en;q=0.9,en;q=0.9;q=0.8`（T3-1 目标达成）；`sec-ch-ua-platform: "macOS"`（T2-1 维持）；UA=Macintosh/151（T2）。
- **上游实拉**：chrome-devtools-mcp npm=1.7.0（2026-08-10）；Chrome stable=152.0.7977.42/151.0.7922.139；patchright=1.61.1（2026-06-23）；steel-sdk=0.18.0（2026-03-16）；camoufox=0.1.19（2025-09-20）；agent-browser=0.34.0（2026-08-10）；@browserbasehq/stagehand=4.0.1（2026-08-14）；CloakBrowser releases 网页：公共线顶=chromium-v146.0.7680.177.5（资产仅 linux-x64/win-x64）、pro 线顶=chromium-v150.0.7871.114.6-pro；Steel #245 zread 复核仍 open；基准文章 article:modified_time=2026-07-12。
- **网络注记**：本轮 api.github.com 在本机 TUN 环境下全端点 404（含 /rate_limit），GitHub 证据改走 github.com 网页 + expanded_assets 直拉——与 memory「网络代理环境与 TUN 诊断」一致，非 CloakBrowser 仓库消失。
- **门禁**：`npm run build` ✓；`npm test` 122 files / **1960 passed + 1 skipped（1961）零失败零 flake**；`npm run check-invariants` **79/79**。
- **白盒抽验文件**：src/channels/HeadlessChannel.ts（41-103）、src/browse/stealth-profiles.ts（53-64/125-212/240-303）、src/browse/StealthEngine.ts（40-116/240-299）、src/doctor/doctor.ts（34-42/1735-1741/1786-1826/1900-1915）、src/types.ts（145-158/474-498）、src/tools/network.ts（9/119/180-238/300）、src/channels/BrowserbaseChannel.ts（160-226）、src/browse/cdp-actions.ts（173）、test/integration/stealth-headless-integration.spec.ts（315-410）、src/invariants/check-invariants.mjs（INV-79 体）、doc/governance/01-最优性审查轮次/round2-manual-test-checklist.md（A-G）。
