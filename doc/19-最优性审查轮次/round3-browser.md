# 第 3 轮最优性审查 —— 浏览器自动化与反检测域（复审之复审）

> 调研员：round3-browser。日期：2026-08-17。
> 性质：第 3 轮复审——① 检验 round1（T1/T2/T4/T5/T10）+ round2（T2-1/T2-2）本域全部调整是否达最优（白盒抽验新代码）；② 上两轮 watch/NO-GO 是否有**新证据**翻案（无新证据不翻）；③ 全新热点（round2 至今窗口仅数小时，增量预期极小）。不重复 round1/round2 已裁决内容。
> 基线：v1.12.0 工作树（round2 T2-1..T2-14 已实施未 commit；round2-review03 zero-issues-pass）。本轮门禁实跑：`npm run build` ✓ / `npm test` **1940 passed + 1 skipped（1941，122 files，零失败零 flake）** / `check-invariants` **79/79 全绿**。
> 方法：源码白盒（stealth-profiles.ts / StealthEngine.ts / HeadlessChannel.ts / index.ts / doctor.ts / StagehandChannel.ts / BrowseChannel.ts / 测试）+ chrome-devtools-mcp 1.7.0 tarball 白盒（CLI options 全清单）+ npm registry / Chrome versionhistory / GitHub releases 实拉 + **本机 L3 实测 E1'（本地 echo server + 系统 Chrome 150 headless + v1.12 精确 flag 组合，三组 run）**。

---

## 0. 复审结论速览

| 复审问题 | 结论 |
|---|---|
| round1 五项（T1/T2/T4/T5/T10） | **达最优**（round2 已逐项验收；本轮独立抽验 spec/profile/doctor 三处现状全部在位，无回退） |
| round2 T2-1（mac_chrome 宿主对齐） | **达最优且目标实证达成**：E1' run A（v1.12 精确 flag 组合真跑）——`User-Agent: ...Macintosh...Chrome/151` + `sec-ch-ua-platform: "macOS"` **同 OS 一致**，round2 E1 发现的 OS 级矛盾已消除。装配单源（defaultHeadlessProfileForHost 三消费）、四方一致性断言、darwin/非 darwin 分支测试、手测清单 B 全部在位 |
| round2 T2-1 rider（skew hint） | **达最优**：doctor.ts:1784-1808 实现与裁决一致（hint 非 gate、探测失败静默回退、\|skew\|≥2 建议刷新）；round2-review03 L3 已证 Chrome `--version` 探测真跑可解析 |
| round2 T2-2（档案注释卫生） | **主体落地，但漏了同族一处**：BrowseChannel/StagehandChannel 两处已修；`StealthEngine.ts:59-60` 仍声称「viewport / timezone 由启动 flag 控制（subprocess spec 加 --window-size / --timezone）」——**双失实**（实际 flag 是 `--viewport=` 非 --window-size；spec 无任何 timezone flag，上游 1.7.0 CLI 也没有 timezone 选项，Chrome 本身无 --timezone 开关）。→ 候选 2 |
| 本轮最重要发现 | E1' 实测坐实**下一层 shape 矛盾：locale 层**——v1.12 flag 组合下 HTTP `Accept-Language: zh-CN,zh;q=0.9`（宿主真值，`--user-agent` 管不到），而 JS 层 `navigator.language="en-US"`（profile）+ `navigator.languages=['en-US','en']`（CORE evasion #2 硬编码）。真实浏览器中两者出自同一语言偏好存储**永不相异**——「zh-CN 头 ↔ en-US JS」是自然界不存在的形状（与 E1 的 OS 矛盾同类）。另 JS 内部：mac_safari_17（zh-CN）/linux_firefox_121（en-GB）两 profile 下 `languages[0] !== language` 一行即可识破。→ 候选 1（P1） |
| R1 patchright / R6 Steel #245 / R7 camoufox / W-B1 nodriver / R-ECO-6 | **全部维持，零翻案**：npm 上游同一日内零变化（patchright 1.61.1 / steel-sdk 0.18.0 / camoufox 0.1.19 stale / chrome-devtools-mcp latest 仍 1.7.0）；Steel #245 zread 复核仍 open；无任何新证据 |
| W-B2 CloakBrowser | **维持 watch，证据刷新**：2026-08-11 仍有新 release（chromium-v146.0.7680.177.5，另有 v148-*-pro 线），但公共资产**仍只有 linux-x64 + windows-x64，无 darwin**——触发条件（darwin 管线复活）未满足；-pro 后缀暗示分层商业化，license 疑点未澄清 |
| 全新热点 | **无结构性新增**（round2 至今仅数小时）：商业 antidetect 浏览器 listicle 噪音（GoLogin/Octo/Multilogin 等 SaaS，与 MIT/npm 自托管定位无关）；Chrome stable 仍 152/151 并行，mac_chrome=151 仍是当前时代值 |

**本轮域内判定**：round1+round2 的七项浏览器域调整全部达最优（含 T2-1 目标的实测达成）；残余空间集中在**下一层 coherence（locale）**与一处注释债——共 2 条候选（P1×1 / P3×1），全部零新依赖、既有机制内（chromeArg 透传 + profile 字段 + override script）。

---

## 1. 任务①：round1+round2 调整落地最优性（白盒抽验）

| # | 项 | 本轮独立抽验锚点 | 判定 |
|---|---|---|---|
| 1 | T1 驱动层锁版 1.7.0 | `SubprocessManager.ts` LOCKED 1.7.0；npm registry 2026-08-17 实拉 latest 仍 1.7.0（modified 2026-08-10，无新版）；spec 含 `--no-usage-statistics`（HeadlessChannel.ts:88）；INV-79d 全绿 | **达最优**（锁版=latest 零滞后维持） |
| 2 | T2 launch 级 UA | HeadlessChannel.ts:90 `--chromeArg=--user-agent=<profile UA>` 在位；E1' run A 实测 UA 头= profile 值（Macintosh/151） | **达最优** |
| 3 | T2-1 mac_chrome | stealth-profiles.ts:135-164 四方 OS 一致（UA Macintosh ↔ secChUaPlatform "macOS" ↔ platform "MacIntel" ↔ brands 151，ghost 151%4=3→Not_A Brand）；`defaultHeadlessProfileForHost()`（HeadlessChannel.ts:41-43）单源三消费（index.ts:433 装配 / doctor-cli.ts:45 / doctor.ts:759+1712）；测试 stealth-profiles.spec.ts:350-395（存在性/四方一致/无 HeadlessChrome token/darwin 分支）+ cdp-mcp-170-migration.spec.ts:151-181（spec 含 UA/viewport flag，darwin/非 darwin 双断言）；手测清单 B 就位 | **达最优**；**目标实测达成**（run A：UA↔platform 同 macOS，OS 矛盾消除） |
| 4 | T2-1 rider skew hint | doctor.ts:1773-1808（探测路径表含 8 候选、execFileSync timeout 3s、\|skew\|≥2 文案、失败静默空串）；#25 detail 拼接（:1712-1716） | **达最优**（实现与裁决逐条对齐） |
| 5 | T2-2 档案注释 | StagehandChannel.ts:7-17 R-ECO-6 段已更新（REST 已上线/sessions.* 形状/无 verify/v0 unstable）；BrowseChannel.ts:19 区域 + dispatch Map 注释已改原生直调表述 | **主体落地**；漏 StealthEngine.ts:59-60（候选 2） |
| 6 | T4 profile 151 | Chrome versionhistory 实拉：stable latest 152.0.7977.42 / 前版 151.0.7922.139（与 round2 相同）→ 151 仍当前时代值；skew hint 观测 profile 151 vs 本机 150 = +1（<2 不警告） | **达最优**（维持） |
| 7 | T5 原生 network/console | BrowseChannel dispatch Map `["network", doNetwork]` / `["console", doConsole]`；注释本轮已与实现对齐（T2-2） | **达最优**（维持） |
| 8 | T10 LASSO_PROXY | spec `--proxy-server=` 条件展开（HeadlessChannel.ts:93）+ logged_in 双负向测试（round2 验收，proxy-egress.spec.ts） | **达最优**（维持） |

### E1' 实测（本轮核心证据，2026-08-17，macOS 12 / Darwin 21.6.0 / 系统 Chrome 150.0.7871.182 / 本地 echo server）

| run | flag 组合 | 捕获请求头 |
|---|---|---|
| A | **v1.12 精确组合**（--headless=new + AutomationControlled + --user-agent=mac_chrome UA） | `User-Agent: ...Macintosh; Intel Mac OS X 10_15_7...Chrome/151.0.0.0`；**`Accept-Language: zh-CN,zh;q=0.9`**；`sec-ch-ua: "Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"`；`sec-ch-ua-platform: "macOS"` |
| B | A + `--accept-lang=en-US,en;q=0.9` | `Accept-Language: en-US,en;q=0.9,en;q=0.9;q=0.8`（注入前缀生效 + 宿主尾巴追加）；其余同 A |
| C | A + `--accept-lang=en-US,en;q=0.8,zh-CN;q=0.6` | `Accept-Language: en-US,en;q=0.9,en;q=0.8;q=0.8,zh-CN;q=0.6;q=0.7,zh;q=0.6`（多语言形态，接近真实双语用户 header） |

**E1' 三重结论**：
1. **T2-1 目标达成**（run A：UA 平台 token ↔ sec-ch-ua-platform 同为 macOS——round2 E1 的 OS 矛盾消除，本机实测关闭该悬案的手测清单 B 核心断言）。
2. **新矛盾坐实**：`--user-agent` 管不到 `Accept-Language`（同属「launch flag 改不了的低熵宿主真值」家族，与 sec-ch-ua 同性质）——本机 zh-CN 头 ↔ JS en-US（profile.language + CORE #2 硬编码）。真实浏览器中 Accept-Language 头与 navigator.languages 同源同值（同一 PrefService），不可能相异 → 这是**自然不可能形状**，与 E1（Windows UA ↔ macOS hints）同检测类别（camoufox doctrine 第 1 条 / shape coherence 交叉验证）。且 JS 内部还有第二层不可能形状：mac_safari_17（language=zh-CN）/linux_firefox_121（language=en-GB）下 `navigator.languages[0]`（硬编码 'en-US'）≠ `navigator.language`（profile 值）——真浏览器保证 `languages[0] === language`，creepjs 级一行检测。
3. **修法可行**（run B/C）：`--accept-lang` chromeArg 透传生效（主 token 对齐；宿主尾巴追加后形态≈真实双语用户，远优于头内自矛盾）。

**残余（记档不扩面）**：run A 的 `sec-ch-ua: ...v="150"...Not;A=Brand";v="8"`（宿主真值）vs JS userAgentData.brands（151 / "Not_A Brand";v="99" / 顺序不同）——header 侧不可注入（1.7.0 无 setExtraHTTPHeaders 工具，StealthEngine.ts:53-57 spike 状态维持），JS↔HTTP brands 三处分歧（版本/ghost 名/顺序）结构性无解，唯一根治是 profile 版本跟随宿主 major（与 const profile 哲学冲突，skew hint 已给观测面）——维持 round2 记档结论，不立项。

---

## 2. 任务②：watch/NO-GO 新证据复核（零翻案）

| 项 | round2 处置 | 本轮新证据（2026-08-17 实拉） | 结论 |
|---|---|---|---|
| R1 patchright | roadmap v2.0 维持，证据降权 | npm 实拉：1.61.1（2026-06-23），零变化 | **维持**（无新证据） |
| R6 Steel per-session release | watch（#245 修复前保持全量 release） | zread 复核：「This issue remains open」（2025-12-23 报告）；steel-sdk npm 0.18.0（2026-03-16）零变化 | **维持 watch，现状正确** |
| R7 camoufox | NO-GO（主维护者离场） | npm 0.1.19（2025-09-20）stale 如故 | **维持 NO-GO** |
| W-B1 无 shim CDP（nodriver 范式） | watch（v2.0 议题） | 无新基准/新证据 | **维持 watch** |
| W-B2 CloakBrowser | watch（darwin 管线复活再评） | **证据刷新**：releases 页实拉——最新公共 tag chromium-v146.0.7680.177.5（**2026-08-11**，活跃）+ v148.0.7778.215.x-**pro** 线；expanded_assets 实拉：146.0.7680.177.5 资产**仅 cloakbrowser-linux-x64.tar.gz + cloakbrowser-windows-x64.zip，无 darwin**（148-pro 资产列表空，疑 gating） | **维持 watch**：项目活跃度回升但 darwin 断更如故（触发条件未满足）；-pro 线暗示功能分层商业化，license 疑点加深——watch 条件追加「-pro 分层与 MIT wrapper 边界澄清」 |
| R-ECO-6 Stagehand REST | 档案已更新（T2-2），v1.8 决策点 | 同日窗口，无变化 | **维持**（档案已是最新事实） |
| sec-ch-ua header 注入 | 不做（等上游） | 1.7.0 CLI options 白盒全清单（chrome-devtools-mcp-cli-options.js 实拉 32 项）：**无 header/timezone/accept-lang 专属选项**，仅 chromeArg 透传——header 注入缺口维持；但 chromeArg 存在使 `--accept-lang` 可达（候选 1 的机制基础） | **维持不做**（候选 1 用 flag 绕开而非注入） |

上游版本事实（同日复查）：chrome-devtools-mcp latest=1.7.0（锁版=latest 维持）；Chrome stable=152.0.7977.42 / 151.0.7922.139；本机系统 Chrome=150.0.7871.182（skew +1 正常带）。

---

## 3. 任务③：全新热点（数小时窗口）

无结构性新增。检索面（2026-08 一周窗）：商业 antidetect 浏览器榜单噪音为主（GoLogin/Octo/Multilogin/Nstbrowser 等——闭源 SaaS 多账号矩阵，与 Lasso「MIT/npm/自托管/单 IP 主场景」定位正交，round1 起即不收录的理由不变）；Browserless 2026 反检测指南为厂商内容营销，检测轴认知未超出 round2 已归档的 automation-protocol fingerprinting + shape coherence 框架。工具层（chrome-devtools-mcp / Steel / browserless / browser-use / stagehand / agent-browser）同日零变化。

---

## 4. 候选调优项（宁缺毋滥，2 条：P1×1 / P3×1）

### 候选 1（P1）：locale 层间一致性——`--accept-lang` chromeArg 透传 + CORE evasion #2 从 profile 派生

- **对标证据**（E1' L3 实测 + 源码白盒，2026-08-17）：
  1. **HTTP↔JS 矛盾**：run A——v1.12 精确 flag 组合下 `Accept-Language: zh-CN,zh;q=0.9`（宿主真值；`--user-agent` 与 JS defineProperty 均不可达此头），而 JS 层声称 en-US（`buildUserAgentOverrideScript` 设 `navigator.language=profile.language`（StealthEngine.ts:262-265）+ CORE evasion #2 硬编码 `navigator.languages=["en-US","en"]`（stealth-profiles.ts:274-277））。真实浏览器两值同源同值永不相异 → 自然不可能形状，与 round2 T2-1（P1）所修的 OS 矛盾**同类别同机制家族**（launch flag 改不了的低熵宿主真值）。宿主为 en-US 的机器不受影响，宿主为 zh-CN（本机主力）时全部 profile 中招。
  2. **JS 内部矛盾（与宿主无关）**：mac_safari_17（language="zh-CN"）/ linux_firefox_121（language="en-GB"）两 profile 下 `navigator.languages[0]="en-US"` ≠ `navigator.language`——真浏览器保证 `languages[0] === language`，一行 JS 即识破。
  3. **修法实证**：run B/C——`--accept-lang=en-US,en;q=0.9` 生效（头变 `en-US,en;q=0.9,en;q=0.9;q=0.8`，注入前缀主导 + 宿主尾巴，形态≈真实双语用户；远优于现状的头内自矛盾）。机制 = 既有 chromeArg 透传（与 --user-agent 同管道，INV-79d 同类守护面）。
- **具体改法**：
  ① HeadlessChannel spec 加一行 `--chromeArg=--accept-lang=${profile.acceptLanguage}`（**四条 profile 的 acceptLanguage 字段已有**——现状死数据（无 header 注入机制从未消费），本候选使其单源变活，与 round1 T2 让 userAgent 字段变活同范式）；
  ② CORE evasion #2 的硬编码 languages 移入 `buildUserAgentOverrideScript`（profile 感知处）设 `navigator.languages = [profile.language, <主子标签>]`（如 zh-CN → ["zh-CN","zh"]、en-US → ["en-US","en"]），CORE #2 位置改注释指向迁移处（16 路计数注释同步——机制等价迁移非删除，headless 空数组破绽仍被覆盖）；
  ③ 测试：profile 遍历断言 `languages[0] === language`（四 profile）+ spec 断言含 accept-lang flag + 不受影响路径（无 profile 的调用面）回归；INV-79(d) 守护清单可顺势纳入 accept-lang flag（实施者定）；
  ④ 手测清单 B 扩展：echo server 回显增加 `accept-language` 键，断言头主 token 与 profile.acceptLanguage 主 token 一致。
- **预期收益**：消灭主力平台（zh-CN 宿主）上最后一处 HTTP↔JS 自然不可能形状（locale 维度）；修掉两条非 en-US profile 的 JS 内部不可能形状；profile header 集死数据从「三处未消费」减为「两处」（acceptLanguage 变活，accept/secFetch* 维持待上游——与 stealth-profiles.ts:104 注释的「供后续暴露时直用」语义一致推进）。
- **实施代价**：S（一行 flag + 一段脚本迁移 + 测试 + 手测清单扩展；cdp-mcp-170-migration.spec 的 spec 形状断言同步）。
- **风险**：低。`--accept-lang` 是 Chromium 标准 switch（仅影响 Accept-Language 派生，不改 UI 语言）；注入后 Chrome 追加宿主尾巴属预期行为（run B/C 实测无副作用，dump-dom 正常）；`languages` 覆盖时机与现状相同（afterNavigate 注入序列内），无新增竞态。**残余记档**：sec-ch-ua brands 三处分歧（版本/ghost 名/顺序）结构性无解（§1 E1' 残余段），维持 round2 记档；IP↔locale 三维对齐（代理场景 en-US locale↔海外 IP 自洽、直连场景 en-US locale↔zh IP 属真实双语人群分布）不做动态跟随（反过度设计）。
- **验收**：四 profile `languages[0]===language` 断言绿；spec 含 accept-lang flag 断言绿；手测清单 B 扩展项归档（echo server 头回显主 token 一致）；`npm run build && npm test && npm run check-invariants` 基线 1941/79 不减。

### 候选 2（P3）：StealthEngine.ts:59-60 陈旧注释修正 + profile.timezone 死数据说明（T2-2 漏网同族）

- **对标证据**：StealthEngine.ts:59-60 声称「viewport / timezone 由 chrome-devtools-mcp 启动 flag 控制（subprocess spec 加 --window-size / --timezone）」——三重失实：① 实际 flag 是 `--viewport=`（HeadlessChannel.ts:91），spec 全文无 --window-size；② spec 无任何 timezone flag；③ 上游 1.7.0 CLI options 白盒全清单（32 项）无 timezone 选项，Chrome 亦无 --timezone 开关（旁证：steel-browser 自己的 changelog 修过「invalid --timezone Chrome flag」）。stealth-profiles.ts:256-258 已正确表述「timezone 无启动 flag」——两处注释自相矛盾。grep 实证 `profile.timezone` 是死数据（仅 doctor.ts:1603 的字段存在性检查消费，无行为消费；JS Intl 时区未伪造=跟随宿主真值，恰与宿主 IP 自洽，**行为正确但档案未说明**）。
- **具体改法**：注释改为真实表述：「viewport 经 `--viewport=` flag；timezone 无启动 flag——profile.timezone 为档案字段无行为消费，JS Intl 时区跟随宿主（诚实且与宿主 IP 自洽）」；stealth-profiles.ts timezone 字段处补一行同义说明。
- **预期收益**：注释-实现-上游三方对齐（T2-2 的验收标准在漏网处补齐）；防未来读者按错误注释给 spec 加不存在的 --timezone flag（steel 同款弯路）。
- **实施代价**：XS（纯文本）。
- **风险**：无。
- **验收**：注释与 spec/上游一致；基线不变（零行为改动）。

### 本轮明确「不做」的处置（记档）

| 处置 | 项 | 理由 |
|---|---|---|
| 记档（不立项） | sec-ch-ua header/brands 三处分歧（版本 skew + ghost 名 + 顺序） | header 不可注入（上游无机制）；JS 侧已与 UA 一致（JS 内部自洽）；唯一根治=profile 版本动态跟随宿主 major，与 const profile（INV-30 哲学）冲突且增益未证——skew hint 已给观测面（round2 记档结论维持） |
| 记档（不立项） | dpr=1 + screen-info 3840x2160 在真 Mac 的弱信号 | round2 E2 已记观察；无新证据不提升（本机 mac_chrome 默认下该组合仍偏弱信号，evasion 无 dpr 路；立项需真实检测权重证据） |
| watch 维持（条件追加） | W-B2 CloakBrowser | 2026-08-11 仍发版（活跃回升）但 darwin 资产仍缺；-pro 线暗示分层商业化 + license 疑点加深。触发条件：darwin 管线复活 + license/-pro 边界澄清 + 独立基准复测有真实增益 |
| watch/NO-GO 维持 | W-B1 nodriver 范式 / R1 patchright / R6 Steel #245 / R7 camoufox / R-ECO-6 / sec-ch-ua header 注入 | §2 零新证据，按「无新证据不得翻」全部维持 |
| 不做 | locale/IP/timezone 三维动态跟随（按宿主或代理自动选 locale） | 三维权衡引入新机制面（探测宿主 locale/GeoIP），违简单架构；候选 1 只消灭「同请求内自矛盾」（无论 IP 在哪都成立的硬矛盾），IP↔locale 弱矛盾交给真实双语人群分布解释 |

---

## 附：本轮实测与门禁记录（2026-08-17）

- **E1'**（本地 echo server + 系统 Chrome 150 headless 真跑，三组 run）：见 §1 表。核心数据——run A `Accept-Language: zh-CN,zh;q=0.9` / `sec-ch-ua-platform: "macOS"` / UA=Macintosh/151；run B `--accept-lang=en-US,en;q=0.9` → `en-US,en;q=0.9,en;q=0.9;q=0.8`；run C 多语言形态如文。
- **上游实拉**：chrome-devtools-mcp npm latest=1.7.0（modified 2026-08-10）；1.7.0 tarball CLI options 全清单 32 项（无 timezone/accept-lang 专属项，chromeArg 透传在列）；Chrome stable=152.0.7977.42 / 151.0.7922.139；patchright=1.61.1（2026-06-23）；steel-sdk=0.18.0（2026-03-16）；camoufox=0.1.19（2025-09-20）；CloakBrowser 最新公共 release=chromium-v146.0.7680.177.5（2026-08-11，资产仅 linux/win）+ v148-*-pro 线（资产空）。
- **门禁**：`npm run build` ✓；`npm test` 122 files / **1940 passed + 1 skipped（1941）**零失败；`npm run check-invariants` **79/79**。
- 白盒抽验文件：src/browse/stealth-profiles.ts（91-221/264-291）、src/browse/StealthEngine.ts（53-79/237-270）、src/channels/HeadlessChannel.ts（41-96）、src/index.ts（428-433）、src/doctor/doctor.ts（1710-1808）、src/doctor/doctor-cli.ts（44-45）、src/channels/StagehandChannel.ts（1-17）、src/channels/BrowseChannel.ts（14-24/120-135）、test/unit/stealth-profiles.spec.ts（348-395）、test/unit/cdp-mcp-170-migration.spec.ts（151-181）、chrome-devtools-mcp@1.7.0 build/src/bin/chrome-devtools-mcp-cli-options.js。
