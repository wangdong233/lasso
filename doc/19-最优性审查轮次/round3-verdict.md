# 第 3 轮最优性审查 · 全局裁决书（round3-verdict）

> 裁决官：round3-verdict。日期：2026-08-17。
> 输入：round3-browser.md / round3-search.md / round3-desktop.md / round3-arch.md 四域复审报告 + 裁决官独立白盒抽验（双源核实）+ 门禁亲跑。
> 基线：v1.12.0 工作树（round2 T2-1..14 + review03 修复未 commit；HEAD=0b07536 v1.11.0；npm latest=1.10.0）。
> 裁决官亲跑门禁：`build ✓` / `npm test` 122 files **1940 passed + 1 skipped（1941）零 flake** / `check-invariants` **79/79** —— 与四域报告声称一致。

---

## 0. 裁决

**DECISION: ROUND-TUNE**（调优项 7 条：P1×3 / P2×1 / P3×3；全部 XS-S 代价、零新依赖、不动架构）

四维中三维已达最优（选型/架构/范围），唯**实施**维余 7 处缝隙——且全部是「round1/round2 实施自己引入或漏网」的尾巴（非设计缺陷、非新机制面）。desktop 域明示「三项落地+手测签核后本域 ROUND-CLEAN」、arch 域明示「若本轮实施，下轮预期 ROUND-CLEAN」——**round4 应定位为验收轮**：实施 T3-1..T3-7 + 门禁 + 手测清单 A-E 签核，若零新发现即 ROUND-CLEAN 终止循环。

---

## 1. 四维总评

### 1.1 技术选型 —— 最优，零重开

四域 watch/NO-GO 复核**全部零翻案**，且裁决官抽验无虚报：

- **browser**：cdp-mcp 锁版 1.7.0 = npm latest 维持（锁版策略继续零滞后）；patchright 1.61.1 / steel-sdk 0.18.0 / camoufox 0.1.19 stale 同日零变化；CloakBrowser 证据刷新（08-11 仍发版但 darwin 资产仍缺 + -pro 分层商业化）→ watch 维持并追加条件（正确：活跃度回升不等于可用性回升，触发条件未满足就不翻）。
- **search**：defuddle 0.19.2 = lockfile = latest；7 项 watch/NO-GO 全维持；R8 融合 NO-GO 获 Kindly（120s 默认预算/浏览器池/并发限流）+ firecrawl 纵向深化**双新数据点加固**——「CC 按需编排 vs tool 内隐藏成本」的边界证据更足。
- **desktop**：三大对标（Peekaboo v4.2.0 / agent-desktop v0.8.1 / pi v0.5.0）round2 后**无一发版**；Peekaboo 向 agent 平台（Tachikoma）演化 = 生态位分化非竞争加剧，判定正确。
- **arch**：SDK v1=1.30.0 latest 零补丁、v2=2.0.0 零补丁线、FastMCP 仍 beta；R10 v2 迁移 Q4 时机因 12 个月 deprecation policy 更宽裕。选型面零漂移。

### 1.2 架构 —— 最优，无结构性挑战

- 全新热点全部**正确停在红线外**：Kindly API 解析器（GITHUB_TOKEN 新配置面 + fetch_url 魔法分派破 INV-23 精神——拒收理由成立）、defuddle YouTube transcript（useAsync SSRF 红线钉死）、macos26/Agent（agent 层非抓手层不对标）、locale/IP/timezone 三维动态跟随（反过度设计）。
- 唯一量级残留（steel release 无界 await，T3-4）是**实施缝隙非架构缺陷**——停机链架构本身（sync → best-effort 异步步 → killAllSync → exit 钩子兜底）设计正确，只是一步漏抄了同函数内的 3s race 范式。
- EPIPE（N-1）不孤儿仅优雅度降级、exit 钩子兜底在案——记档不立项正确。

### 1.3 范围 —— 最优且健康收敛

候选轨迹：round1 16 项 → round2 14 项 → round3 7 项（P1 3 / P2 1 / P3 3）；search 域已率先归零（空集是真实收敛：热度实拉 + 新项目白盒 + 独立 mutation 均执行过后差距清零）。本轮 7 条**无一条扩范围**：locale 一致性是 T2-1 同范式同家族的下一层；C3-1 是 T2-6 自己引入的缝隙；C3-2 是 round2-review03 遗留 #1 预定项；T3-4 是 T2-12 收尾；T3-7 是 T2-14 自记下一步。全部是「实施尾巴清偿」，符合 round2-verdict 预言的收敛轨迹。

### 1.4 实施 —— 主体最优，7 处缝隙（本轮唯一差距维）

两轮 30 项调整中 28 项零残留（四域白盒 + mutation kill + 门禁复证）；本轮 7 条候选全部有白盒证据差距，且**裁决官已对每条做独立双源核实**（见 §2 各项「裁决官核验」栏）——无一条采信报告原文而未经源码验证。

---

## 2. 调优项清单（T3-1..T3-7）

> 五门槛（白盒证据/既有范畴/单轮可完成/收益可验证/不破红线）逐条过审；门槛只紧不松。

### T3-1（P1 · browser）：locale 层间一致性 —— `--accept-lang` chromeArg 透传 + CORE evasion #2 迁入 profile 感知

- **证据**（E1' 本机实测 + 白盒）：v1.12 flag 组合下 HTTP `Accept-Language: zh-CN,zh;q=0.9`（宿主真值，`--user-agent` 不可达）↔ JS 层 en-US（profile.language + CORE #2 硬编码 `["en-US","en"]`）——真实浏览器两值同源同值永不相异，**自然不可能形状**（与 T2-1 所修 OS 矛盾同族）。另 mac_safari_17（zh-CN）/linux_firefox_121（en-GB）下 `languages[0] !== language` 一行可识破。宿主为 zh-CN（本机主力）时全部 profile 中招。
- **修法**：① spec 加 `--chromeArg=--accept-lang=${profile.acceptLanguage}`（E1' run B/C 实测生效：头变 `en-US,en;q=0.9,...` ≈ 真实双语用户形态）；② CORE #2 硬编码 languages 移入 `buildUserAgentOverrideScript` 设 `[profile.language, 主子标签]`，原位置改注释指向（16 路计数同步，机制等价迁移）；③ 测试：四 profile `languages[0]===language` 断言 + spec 含 accept-lang flag 断言；④ 手测清单 B 扩展（echo server 回显 accept-language 主 token 一致）。
- **裁决官核验**：acceptLanguage 字段四 profile 已有（stealth-profiles.ts:128/158/184/206）且全 src **零消费**（死数据确认）；CORE #2 硬编码在案（CORE_STEALTH_SCRIPT #2）；`--chromeArg` 管道与 `--user-agent` 同款（HeadlessChannel.ts:89-90）。与 round1 T2 让 userAgent 字段变活**完全同范式**。
- **代价 S / 风险低**：`--accept-lang` 是 Chromium 标准 switch；残余 sec-ch-ua brands 三处分歧记档维持（结构性无解）。

### T3-2（P1 · desktop）：T2-6 补缝 —— VLM 档截图 region 的坐标偏移补偿

- **证据**（五环闭合）：① act schema 接受 `screenshot_region`（tools/desktop.ts:114）；② `ScreenshotVlmProvider.act` 用 region 裁图（:154）→ VLM 返回**区域相对坐标**；③ `buildVlmPrompt`（:545-555）只发 app/actions/where/expect，**不告知区域原点**；④ `parseVlmActions`（:348）纯解析无平移；⑤ `cgevent.rs` parse_point → `CGEvent::new_mouse_event` 直传**全局显示坐标**。→ 带 region 的 VLM act 落点系统性偏移 `(region.x, region.y)` 且逐项 `ok:true`、总 `outcome:"worked"`——**假 worked 换装回归**（T2-6 消灭的 tri-state 链尾违背，以「执行在错误位置还报成功」形态回来）。
- **修法**：`parseVlmActions` 之后、dispatch 之前对坐标加 region 原点平移（click/move 的 x,y；drag 的 from/to 四值；scroll 的可选 x,y）；无 region 零变化。mock 单测「region(100,200) + vlm click(50,60) → wire 收到 (150,260)」。
- **裁决官核验**：五环逐环读源码确认——schema/裁图调用/prompt 函数体（无 region 参与）/parse 纯函数/cgevent 坐标直传，证据链无断点。
- **代价 XS（~15 行）/ 风险近零**（TS 侧平移不依赖 VLM 数学能力）。

### T3-3（P1 · desktop）：find 的 `where.ref` 静默忽略根治（round2-review03 遗留 #1）

- **证据**：① zod `where` 接受 `ref`（tools/desktop.ts where object 含 text/role/ref 三字段）；② `ax_find` 只读 `where.text`/`where.role`（ax.rs:178 起）；③ 纯 ref 查询 → 两谓词 None → 无过滤全节点命中 + `ok:true`——语义错位（调用方以为按 ref 定位，实得全树 dump）+ token 爆炸；④ review03 R03-1 只修了描述文案，行为层未动。
- **修法（双端夹击）**：① zod 的 where 删 `ref` 字段；② Rust `ax_find` 兜底：`where` 存在但 text/role 均空 → `invalid_params`（"find requires text or role; ref is act/expect domain"）——防其它客户端绕过 zod 直发 wire。
- **裁决官核验**：zod where.ref 与 ax_find 仅读 text/role 均读源码确认；谓词全 None 即无过滤由 Rust 匹配逻辑直接可推。
- **代价 XS / 风险低**：纯收紧，不传 ref 的调用 byte-identical。消灭 tri-state「静默丢参」家族最后的行为层成员（T2-5 修透传、R03-1 修文案、本项清行为）。

### T3-4（P2 · arch）：shutdown 链 steel release 加 3s 上界（T2-12 收尾）

- **证据**：① `index.ts` shutdown 内 `await steelChannel.releaseSession()` 是停机链**唯一无上界 await**——兄弟步 stopLaunchedChromes / restoreTabs 均 `Promise.race` 3s 封顶（同函数范式现成）；② `SteelChannel.releaseSession` 裸 fetch 零超时零 AbortSignal；③ 本机实证（Node 24.12 同运行时）：fetch 对 accept-but-silent 端点挂起 **300,978ms**；④ stdin_eof = 父进程死亡 + 环境异常同源场景（自托管 docker 停摆/TUN 劫持类 endpoint 悬挂概率上扬）→ killAllSync/exit 被阻 ≤5min；⑤ stdin-eof 测试注释「各收尾步 3s 上界」与事实不符（测试过仅因无 Steel 会话时 releaseSession 是 no-op——测试盲区即残留证据）。
- **修法**：steel 段照抄兄弟步 `Promise.race` 3s；测试注释改真；加一用例（mock steel 悬挂 promise，断言 shutdown 3s+ε 内到达 exit）。可选加固：SteelChannel 两处 fetch 传 `AbortSignal.timeout(3_000)`。
- **裁决官核验**：shutdown 函数体逐行读——steel 裸 await、兄弟步双 race 3s、releaseSession 自吞错（race 输者随 exit 消亡无句柄残留）全部确认；测试注释 :65 原文确认。
- **代价 XS / 风险近零**：收益 = stdin_eof 全场景确定性 ≤~7s（当前 Steel+悬挂子场景 ≤5min，60 倍）。

### T3-5（P3 · browser）：StealthEngine.ts:59-60 陈旧注释修正（T2-2 漏网同族）

- **证据**：该注释声称「viewport / timezone 由启动 flag 控制（spec 加 --window-size / --timezone）」——三重失实：① 实际 flag 是 `--viewport=`（HeadlessChannel.ts:91），spec 无 --window-size；② spec 无任何 timezone flag；③ 上游 1.7.0 CLI 32 项无 timezone 选项，Chrome 亦无此开关。stealth-profiles.ts 头注释已正确表述「timezone 无启动 flag」——两处自相矛盾。
- **裁决官核验**：两处注释原文与 spec flag 清单逐项比对，失实与矛盾均确认；`profile.timezone` 零行为消费（死数据）确认。
- **修法**：注释改为真实表述（viewport 经 `--viewport=`；timezone 无 flag、档案字段无行为消费、JS Intl 跟随宿主=诚实且与宿主 IP 自洽）；stealth-profiles.ts timezone 字段处补一行同义说明。**代价 XS 纯文本 / 风险无**。防未来读者按错误注释给 spec 加不存在的 flag。

### T3-6（P3 · desktop）：VLM 档 `tcc_event_synthesis_denied` → didnt 对齐（round2-review03 N-2 收尾）

- **证据**：同 producer（`cgevent_dispatch`）双消费者映射不一致——CGEventProvider 把该 error_kind 映射 **didnt**（+引导文案，注释成文「权限缺失不是暂时性故障」）；ScreenshotVlmProvider 对 `resp.ok=false` 一律 **unknown**（无 tcc 特判）。
- **裁决官核验**：两处分支源码确认（didnt 特判 vs 一律 unknown）。
- **修法**：ScreenshotVlmProvider dispatch 失败分支特判该 error_kind → didnt + 同款引导。**代价 XS / 风险近零**。收益纯一致性（tri-state 分类学完整：权限=明确否）。

### T3-7（P3 · arch）：INV-76/68/71 补违规样本（T2-14 记档步骤执行，覆盖 11/79 → 14/79）

- **证据**：`inv-selftest.mjs` 覆盖率报告实测自报「后续补样本优先外部契约类 INV-76/68/71——round2 T2-14 记档」——自记的下一步即本项。三条均静态可证伪（INV-76 上游契约守护、INV-68 禁 spawn/exec/python、INV-71 config 文件机制）。
- **裁决官核验**：覆盖率报告代码（:231-243）与三条 INV 的 checker 定义在案确认。
- **修法**：VIOLATION_SAMPLES 追加三条（沿用既有注入形态）。**代价 XS / 风险近零**：外部契约类 INV 获一次 mutation 实证，覆盖率只增不减从口号变数据。

---

## 3. 拒绝清单（本轮明确不收，记档维持）

| 项 | 拒收理由 |
|---|---|
| sec-ch-ua header/brands 三处分歧 | header 不可注入（上游 1.7.0 无机制）；唯一根治=profile 动态跟随宿主 major，与 const profile 哲学冲突；skew hint 已给观测面——round2 记档维持 |
| locale/IP/timezone 三维动态跟随 | 新机制面（宿主探测/GeoIP）违简单架构；T3-1 只消灭「同请求内自矛盾」硬矛盾，弱矛盾交真实双语人群分布解释 |
| dpr=1 + 3840x2160 弱信号 | 无真实检测权重证据，不立项（round2 观察维持） |
| Kindly API 内容解析器 | 双红线：GITHUB_TOKEN 新配置面 + fetch_url URL 魔法分派破 INV-23 精神；defuddle GitHubExtractor 原生处理 issues/PR 且经 T2-3 已激活，无决定性差距。watch（触发=DOM 抽取系统性截断真实案例） |
| defuddle YouTube transcript | 走 async extractor 第三方 fetch，被 `useAsync:false` SSRF 红线钉死——正确停留 |
| R8 search+scrape 融合 / SearXNG / fetch 升级梯 | NO-GO **加固**（Kindly 120s 预算 + firecrawl 纵向深化双数据点反证） |
| Peekaboo human-typing 拟人节奏 | 无场景（本地授权自动化无需「看起来像人」）；wpm/jitter 参数面违简单架构。watch 记档 |
| N-1 EPIPE 优雅度降级 | 上游 SDK 层面；不孤儿（exit 钩子 killAllSync 兜底）；v2 迁移时随 W-1 核对 |
| TurndownService 无条件构造 / SERP 兜底 20 条上限 | 无对标锚点、收益不可测级——宁缺毋滥不立项 |
| VLM 多动作延时参数化 / find actions 再瘦身 / expect 支持 ref / Tachikoma 式 runtime | 无实测失败证据 / raw 名已够 LLM 读 / expect.ref 现状已闭环 / 愿景红线（抓手层非 agent 层） |
| R5 outputSchema / R9 doctor 拆分（+64/轮斜率稳定）/ FastMCP / UTCP / R11 Windows / W-B1 / W-B2 / R10 v2 迁移 / W-2 Tasks | 无新证据或触发条件未满足，全部维持原判（R10 因 12 个月 deprecation policy 时机更宽裕；W-2 CC 支持仍 open FR） |

---

## 4. 裁决与附则

**DECISION: ROUND-TUNE。** 七条全部过五门槛且经裁决官独立双源核实，无一条可拒；三条 P1 皆为真实缺陷级（假 worked 回归 / 静默丢参假成功 / 反检测自然不可能形状），不实施不能宣告 CLEAN。

**附则一（发布收口，非代码）**：T3-1..T3-7 实施完成且门禁绿后，**一次性 commit（含 round2 工作树全部改动）并 npm publish**——当前 npm latest=1.10.0，两轮 30 项用户可感知修复（孤儿进程/假 worked/表格保真/defuddle 激活）被压两版未达 `npx lasso-mcp` 用户。建议版本 v1.13.0（含 T2-6 缺陷修复，语义上是新版本；README 段随实施更新）。

**附则二（手测签核）**：round2-review03 遗留 #2 手测清单 A-E（stdin-EOF kill CC / OS 指纹 / Electron type / drag 滑条 / find actions+truncated）+ 本轮新增（echo server Accept-Language 主 token 一致）随 T3 实施在同一真机窗口签核——这是三轮质量证据链的最后一环。

**附则三（round4 定位）**：验收轮。预期输入 = T3-1..7 落地 + 门禁基线不减 + 手测签核；预期判定 = ROUND-CLEAN（四域中 search 已空集收敛，browser/desktop/arch 的候选全部是本轮可清偿的缝隙级残留，无新量级发现）。若 round4 复审再冒出新的 P1 级白盒证据差距，则说明收敛判断有误，循环继续——但按本轮证据，概率低。

---

### 裁决官抽验记录（双源核实清单）

| 声称 | 核验点 | 结果 |
|---|---|---|
| acceptLanguage 四 profile 已有且死数据 | stealth-profiles.ts:77/128/158/184/206 + 全 src grep | ✓ 仅定义零消费 |
| CORE #2 硬编码 languages | CORE_STEALTH_SCRIPT #2 | ✓ `["en-US","en"]` |
| --chromeArg 管道现成 | HeadlessChannel.ts:89-90 | ✓ 与 --user-agent 同款 |
| StealthEngine.ts:59-60 注释双失实 | 注释原文 vs spec flag 清单 | ✓ --viewport= 非 --window-size；无 timezone flag |
| C3-1 五环 | desktop.ts:114 / VlmProvider:154 / buildVlmPrompt:545-555 / parseVlmActions:348 / cgevent.rs parse_point→new_mouse_event | ✓ 无断点 |
| C3-2 zod ref vs ax_find | desktop.ts where object / ax.rs:178 起 | ✓ 接受 vs 只读 text/role |
| C3-3 双消费者不一致 | CGEventProvider tcc→didnt 特判 / VlmProvider 一律 unknown | ✓ |
| steel 无界 await + 兄弟 3s race | index.ts shutdown 函数体 / SteelChannel.ts:345-366 / 测试注释:65 | ✓ |
| inv-selftest 自报下一步 | inv-selftest.mjs:231-243 | ✓ |
| 门禁基线 | 亲跑 build/test/check-invariants | ✓ 1941 / 79 零 flake |
| 发布积压 | git log + status + npm view | ✓ HEAD=0b07536 v1.11.0 / latest=1.10.0 |
