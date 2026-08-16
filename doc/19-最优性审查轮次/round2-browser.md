# 第 2 轮最优性审查 —— 浏览器自动化与反检测域（复审）

> 调研员：round2-browser。日期：2026-08-17。
> 性质：**复审轮**——① 检验 round1 本域五项调整（T1/T2/T4/T5/T10）是否达最优；② 用新证据复核 watch/NO-GO 项（R1 patchright / R6 Steel #245 / R7 camoufox / StagehandChannel R-ECO-6）；③ 全新热点。不重复 round1 已裁决内容（对标基线见 round1-browser.md）。
> Lasso 基线：v1.11.0（工作树，HEAD 仍 v1.10.0 commit）。本轮实测门禁：`npm test` 1906 tests（1904 pass / 1 timing-flake / 1 skip，flake 为 expect-poll 时序敏感项，round2-arch 已在案，非浏览器域）；`check-invariants` **79/79 全绿**（v1.11 新增 INV-79）。
> 方法：npm registry / Chrome versionhistory API 实拉；chrome-devtools-mcp 1.7.0 tarball 白盒（build/src/browser.js）；zread 白盒（steel-browser）；官方 README/文档直读；**本机 L3 实测三组**（macOS 12 + 系统 Chrome 150.0.7871.182，本地 echo/probe server + 系统 Chrome headless 真跑，见 §2-1 E1-E3）。

---

## 0. 复审结论速览

| 复审问题 | 结论 |
|---|---|
| round1 T1（1.7.0 升级）是否最优 | **达最优**：锁版 = npm latest（2026-08-17 实测仍 1.7.0，无更新）；遥测关闭/契约翻转复核（INV-76）/wsEndpoint 迁移全部落地，且 INV-79 把迁移面固化成守护 |
| round1 T2（launch 级 UA）是否最优 | **主体落地，但引入一个 round1 未预见的新矛盾**：`--user-agent` 改不了 `sec-ch-ua-platform`/`sec-ch-ua` 请求头 → Windows profile UA ↔ 真实 macOS client hints 的 **HTTP 层 OS 级矛盾**（E1 实测）。T2 修好了 sannysoft 级检测点，引入了 CDN coherence 级检测点。→ 候选 1 |
| round1 T4（profile 151）是否最优 | **达最优**：151 = 2026-07-28 shipped（Chrome stable 现线 152/151，versionhistory 实测）；UA↔secChUa↔brands 三方一致断言 + UA-age doctor hint 均落地 |
| round1 T5（原生 network/console）是否最优 | **达最优**（PerformanceObserver 路径删除、F2 关闭、console 实装）；残留两处**陈旧注释**仍描述旧范式（BrowseChannel.ts:19 / :125-131）→ 候选 4 |
| round1 T10（LASSO_PROXY）是否最优 | **达最优**：实现质量高于裁决要求——源码级（去注释 grep）+ 行为级（spec args 断言）双负向测试钉死 logged_in 永不读（proxy-egress.spec.ts:133-171） |
| R1（patchright roadmap v2.0） | **证据降权，维持 roadmap 不动**：2026-07 独立基准（31 真实 CF 目标 × N=3）实测 patchright 仅 **+1 OK vs 原版 Playwright**（25 vs 24），google-search 与原版同挂；`channel=chrome`（真 Chrome 二进制）才是更大杠杆 |
| R6（Steel per-session release） | **维持 watch，现状正确**：#245 仍 open（zread 实证「This issue remains open」），per-session 端点在近期镜像仍失效——Lasso 保持全量 release 是对的 |
| R7（camoufox / browserless NO-GO） | **维持 NO-GO**：camoufox 作者（daijro）2026 官宣**辞去主维护者**（camoufox.com 首页），bench 中游 25 OK；无任何翻案证据 |
| StagehandChannel R-ECO-6（REST 契约虚构风险） | **部分翻案**：官方托管 **Stagehand REST API 已上线**（stagehand-ruby 等 Stainless 系官方 SDK 实证：`sessions.start/navigate/act/extract/observe/execute/end` + SSE），**但形状与 Lasso 契约不同且无 `/verify` 路由**；gem v0「APIs may change at any time」→ 只更新档案不重写（候选 3） |
| 全新热点 | ① **automation-protocol fingerprinting** 轴（2026-07 独立基准：检测「浏览器被怎么驱动」而非「声称是谁」——一切 Playwright 系含补丁 fork 同轴同挂，唯一零封禁的是无 shim 直连 CDP 的 nodriver）② **CloakBrowser**（12 周 13.5k-15k★ 新 fork，但 macOS 构建管线停更 2 个月）③ Stagehand 官方 REST API |

**本轮域内最重要发现**：E1 实测坐实的 **HTTP 层 OS 矛盾**（候选 1）——T2+T4 组合在 macOS 主力平台上把「HeadlessChrome UA 头」换成了「Windows UA ↔ macOS sec-ch-ua-platform」矛盾，恰好命中 camoufox doctrine 第 1 条与 2026-07 基准的 shape-coherence 检测模式。修复在现架构内零新机制（host-OS 一致的 profile 即可）。

---

## 1. 本域最新最热项目清单（round1 之后的增量）

| # | 项目 | 热度/状态（2026-08-17 实测） | 一句话机制 | 与 Lasso 的关系（相对 round1 的增量） |
|---|------|------|------|------|
| 1 | **ianlpaterson/anti-detect-browser-bench**（基准，非工具） | 2026-05-13 发布、2026-07-12 更新；7 工具 × 31 真实 Cloudflare/反爬目标 × N=3 = 651 判定，源码+原始记录开源 | 提出新检测轴 **automation-protocol fingerprinting**：门禁识别「浏览器怎么被驱动」（CDP 握手序列 Runtime.enable/Target.setAutoAttach 的形状），指纹补丁够不到协议层。nodriver（直连 CDP 无 Playwright shim）唯一 0 blocked（28 OK）；patchright 仅 +1 OK vs vanilla；CloakBrowser 26 OK = 21 行 curl_cffi 平手；rebrowser = vanilla（同分同 block set） | **round1 未覆盖的方法论级新证据**。三重含义：① R1 patchright 增益实证有限；② Lasso 驱动层 chrome-devtools-mcp（puppeteer 底）同属「协议层可识别」控制面——Lasso 诚实定位（不承诺 DataDome/Kasada）再次被验证，v2.0 若突破须换「无 shim 直连 CDP」而非换 patch（记 W-B1）；③ `channel=chrome`（系统真 Chrome）比补丁杠杆大——T1 后 Lasso headless 默认恰是系统 Chrome stable（见 §2-1 事实 F1），方向对齐 |
| 2 | **CloakHQ/CloakBrowser** | 12 周 13.5k★（2026-05-17）→ 近期视频称 ~15k★；Linux/Win 持续发版（Chromium 146），**darwin-arm64 钉 Chromium 145、管线停更 ≥2 个月** | 源码级 C++ 补丁 Chromium fork（49→58 patches，宣称过 CF/DataDode/PerimeterX），drop-in Playwright API；MIT wrapper + 自定义二进制 license | **round1 清单未收录的新 fork**。但独立基准打脸营销：26 OK/2 blocked 与 curl_cffi 平手（「130MB fork 为矩阵不测量的东西付费」）；**macOS 构建死线与 Lasso macOS 主力直接冲突** → 本轮 NO-GO 采用、watch（W-B2：darwin 管线复活 + license 澄清再评） |
| 3 | **browserbase Stagehand API**（+ stagehand-ruby 等官方 SDK 家族） | 官方博客「Introducing the Stagehand API」；stagehand-ruby（Stainless 生成，官方）实证 REST 面：`sessions.start/navigate/act_streaming/extract_streaming/observe_streaming/execute_streaming/end`，SSE 流式，REST 文档挂 docs.stagehand.dev；gem v0 unstable | 托管「智能引擎」：SDK 发单条高层指令 → API 侧翻译成 CDP 动作并在 Browserbase 基础设施执行（替代客户端逐条 CDP） | **R-ECO-6 部分翻案**（round1 时上游无 REST 佐证）：REST API 真实存在，但形状是 **session 生命周期 API**，无 `/verify` 路由；Lasso 的 `api.stagehand.dev/{verify\|extract}` 根路径契约**仍无佐证** → 候选 3（档案更新），不重写（见 §2-2） |
| 4 | **nodriver**（ultrafunkamsterdam） | bench 唯一 0-blocked（28 OK/3 gated）；**AGPL-3.0**；Python-only | 直连系统 Chrome DevTools 端口（裸 WebSocket，无 Playwright/puppeteer shim、无 Runtime.enable 启动序列） | 范式基准升级：从 round1 的「轻量 CDP 直连」升级为「**协议层隐身的唯一实证赢家**」。对 Lasso 是 v2.0 watch（W-B1），不可直接采用（Python + AGPL 与 MIT/npm 分发冲突；且换控制面 = 架构级决策） |
| 5 | **patchright** | npm 1.61.1（2026-06-23；1.60.2/1.61.0/1.61.1 三连发）仍活跃；bench 实测 +1 OK vs vanilla、google-search 同 vanilla 挂；`channel=chrome` 是其有效性的更大成分 | Playwright driver 补丁（Runtime.enable 隔离 + flag 净化 + 二进制去 HeadlessChrome UA） | R1 维持 roadmap v2.0 但**证据降权**：「patch > 原版」的增益在独立基准里只剩 1 目标（stackoverflow）；真正杠杆是系统 Chrome 二进制——T1 后 Lasso headless 已默认系统 Chrome |
| 6 | **camoufox** | 官方 stealth 页自认维护断档一年；**首页官宣作者 step down**（"I've decided to step down from primary maintainer"）；bench 25 OK/3 blocked 中游；Firefox TLS 形状 dev.to 挂、google-search 过 | Firefox C++ 级指纹 fork | R7 NO-GO **维持且加固**：主维护者离场 + 基准无优势。rotating-proxy 基准（techinz）里 Camoufox 100% 过仅说明「轮换 IP 是更大杠杆」，与 Lasso 自托管单 IP 主场景无关 |
| 7 | **rebrowser-playwright** | bench 判决：**= vanilla**（24 OK/2 gated/5 blocked，block set 逐格相同）；最后实质 commit 2024-09 | CDP-leak 补丁 Playwright fork（Chromium 136 落后 12 版） | round1 未单列；本轮记为**负面对照**：同轴（Playwright 系）上打补丁不改变结局——与 W-B1 同一结论的第二实证 |
| 8 | **steel-browser** | #245（per-session release 回归）**仍 open**（zread 实证）；steel-sdk npm 0.18.0 = 2026-03-16（放缓）；repo 活跃度同 round1（放缓） | （同 round1）session 管理 + CDP 代理 + 内建 stealth | R6 watch 维持：上游未修，Lasso 保持 `/v1/sessions/release` 全量端点正确；单 session mutex 下误杀面窄的现状结论不变 |
| 9 | **vercel-labs/agent-browser** | npm 0.34.0（2026-08-10）持续高频 | Rust CLI 直连 CDP + auth vault | round1 结论维持（CLI vs MCP 是产品形态选择）；无结构性翻案 |
| 10 | **ChromeDevTools/chrome-devtools-mcp** | npm latest 仍 **1.7.0**（2026-08-10；2026-08-17 实测无新版） | （驱动层） | **Lasso 锁版 = latest，零滞后**——round1 本域最大单点差距已清偿；round2-arch 另实证其 bundle 内 SDK 1.30.0 与 Lasso 客户端同 era |
| 11 | Chrome stable 版线（事实） | versionhistory API：stable latest **152.0.7977.42**、前一版 151.0.7922.139 | — | T4 的 151 = 2026-07-28 shipped，当前时代值；profile 落后 stable 1 个 major 属正常人群分布（非债） |

**清单结论**：round1 → round2 的真实增量集中在三件事——**「automation-protocol fingerprinting」检测轴成形**（改变 v2.0 stealth 突破口的判断：是控制面而非补丁）、**CloakBrowser 爆红但 macOS 断更**（对 Lasso 仅 watch）、**Stagehand 官方 REST 上线但形状不匹配**（R-ECO-6 从「虚构风险」变「形状过时」）。工具层格局（chrome-devtools-mcp / Steel / browserless / browser-use / stagehand）无结构性变化。

---

## 2. 白盒对标表

### 2-1. 任务①：round1 五项调整落地复核（含新实测）

| # | 维度 | Lasso v1.11 现状（源码/L3 锚点） | 上游/实证锚点 | 判定 |
|---|---|---|---|---|
| 1 | T1 驱动层版本与迁移 | `SubprocessManager.ts:49` `LOCKED_CDP_MCP_VERSION="1.7.0"`；四 spec 全含 `--no-usage-statistics`（HeadlessChannel.ts:71）；Browserbase `--wsEndpoint`（BrowserbaseChannel.ts:161-169）；**INV-76 随迁移修订**（wait_for text 从 0.3.0 单 string 翻转为 1.7.0 非空 string 数组，check-invariants.mjs:3643-3660）+ **新增 INV-79** 固化（a）锁版（b）全 spec 遥测关（c）wsEndpoint 互斥（d）headless chromeArg UA/viewport（e）禁裸 `--disable-blink-features` 哑 flag 形态回潮 | npm registry 2026-08-17：latest 仍 1.7.0（无新版）；1.7.0 tarball 白盒（本轮下载复核） | **达最优**（锁版即 latest；迁移守护 INV 化，超出裁决要求） |
| 2 | T1 附带验证：AutomationControlled 真到 Chromium（round1 遗留 L3 未验证项） | headless spec `--chromeArg=--disable-blink-features=AutomationControlled`（HeadlessChannel.ts:72） | **本轮 E3 实测关闭该悬案**：系统 Chrome headless + `--enable-automation`（puppeteer 默认 arg）→ `navigator.webdriver=true`；**加 `--disable-blink-features=AutomationControlled` → `webdriver=false`（document 起点即假，无需等 JS 注入）**。Lasso 组合从页面第一行脚本前就压掉 webdriver | **达最优**（flag 真实生效，实证归档） |
| 3 | T1 上游红利（Lasso 白得） | —（chrome-devtools-mcp 1.7.0 headless 行为） | **E2 实测**：裸 headless Chrome `screen=800x600 avail=800x600`（经典 headless tell）；1.7.0 headless 自动加 `--screen-info={3840x2160}`（build/src/browser.js:149-151）→ `screen=3840x2160`，800x600 tell 消失（outer=0x0 仍由 Lasso evasion 14 补） | **上游红利确认**（T1 升级附赠，非 Lasso 改动） |
| 4 | T2 launch 级 UA/viewport | `HeadlessChannel.ts:73-74` `--chromeArg=--user-agent=<profile UA>` + `--viewport=<w>x<h>`；stealth-profiles.ts:218-224 注释已与实现对齐（round1 脱节点修复） | **E1 实测（本轮核心发现）**：本地 echo server 捕获系统 Chrome 150 headless + UA override 的真实请求头——`User-Agent: ...Windows NT 10.0...Chrome/151...`（flag 生效）**但** `sec-ch-ua-platform: "macOS"`、`sec-ch-ua: "...Chromium";v="150","Google Chrome";v="150"`（**client hints 不受 `--user-agent` 影响，发真实宿主值**）。→ HTTP 层「Windows UA ↔ macOS hints」OS 级矛盾 + 151↔150 版本 skew | **主体落地但引入新矛盾**（T2 前：两 token 都诚实是 Mac 只漏 HeadlessChrome；T2 后：OS 矛盾）。修复 = 候选 1 |
| 5 | T2 遗留结构限制（header 侧注入无机制） | `StealthEngine.ts:53-57` 自记：chrome-devtools-mcp 不暴露 setExtraHTTPHeaders（spike 未解），profile header 字段（secChUa/secFetch*/accept*）是**死数据**「供后续暴露时直用」 | 1.7.0 工具面复核：仍无 header 注入工具；E1 证明该缺口后果从「header 集 schema 未消费」升级为「HTTP 层 OS 矛盾无解于注入」——唯一现架构修法是 profile 与宿主 OS 一致 | **结构性持平**（上游无新机制；候选 1 绕开而非解决） |
| 6 | T4 profile 值时效 | `stealth-profiles.ts:111-120` UA/secChUa/brands 三方一致 Chrome 151（ghost brand 按 major%4）；`doctor.ts:1696-1740` UA-age hint（锚 151=2026-07-28 shipped，>12 月建议刷新；hint 非 gate 守 INV-30） | Chrome stable 152/151 并行（versionhistory API 实测）；151 属当前时代值 | **达最优**（1-major 落后 stable = 正常人群；age hint 落地） |
| 7 | T5 原生 network/console | `cdp-actions.ts:50-67` `CDP_UPSTREAM_TOOL_NAMES` 直映射（network_log→`list_network_requests` / network_get→`get_network_request` / console_log→`list_console_messages`）；`:158-215` doNetwork 直调 + 逐行解析（F2 关闭：不再受 TUN fake-ip timing 影响）；PerformanceObserver 路径删除 | 1.7.0 tarball 工具面（round1 已白盒）+ 本轮 grep：src 内 PerformanceObserver 仅剩 BrowseChannel.ts:19/:125-131 **注释**（实现零残留） | **实现达最优；两处陈旧注释残留**（候选 4） |
| 8 | T10 LASSO_PROXY | `config.ts:280,377-378`（env→trim）；HeadlessChannel `--proxy-server=`（:76）；Steel session body `proxyUrl`（SteelChannel.ts:97-104,633）；doctor `proxy_config` 回显（doctor.ts:520-521）；**负向测试双保险**：`proxy-egress.spec.ts:133-171` 源码级（去注释后 grep LoggedInChannel 无 LASSO_PROXY/proxy-server）+ 行为级（设 env 后 logged_in spec 仍无 proxy flag） | 裁决书 T10 验收清单逐项对齐 | **达最优**（超出验收要求：源码级+行为级双钉） |

**事实 F1（重要，多处引用）**：1.7.0 `launch()` 白盒（build/src/browser.js:133-190）——无 `--channel`/`--executablePath` 时 `puppeteer.launch({channel:'chrome'})` = **系统已装 Chrome stable**（非下载 Chromium）。推论：Lasso headless 通道跑的是真 Chrome 二进制（真 TLS/真版本），sec-ch-ua 头随宿主 Chrome 自动更新而变——这既是对齐 benchmark「channel=chrome 是最大杠杆」的红利，也是候选 1 矛盾的根源（hints 永远说宿主真话）。

### 2-2. 任务②：watch/NO-GO 新证据复核

| # | round1 处置 | 本轮新证据 | 复核结论 |
|---|---|---|---|
| R1 patchright（roadmap v2.0） | roadmap v2.0（等 L1 路线真实不够用再议） | ianlpaterson bench：patchright **25 OK vs vanilla 24**（+1），google-search/canadianinsider 与 vanilla 同挂；作者自述「`channel=chrome` 比补丁更重要——矩阵证明 flag 是更大杠杆」；Node 包仍活跃（1.61.1，2026-06-23） | **维持 roadmap v2.0，证据降权**。理由：①独立基准显示 patch 增益边际化；②其有效性主要成分（真 Chrome 二进制）Lasso 经 T1+F1 已拥有；③其范式属 Playwright 系 = automation-protocol 轴同挂（W-B1）。触发条件不变（L1 实测不够用），但预期收益下修 |
| R6 Steel per-session release + 钉 tag（watch） | watch（等 #245 修复或下次触及） | zread 实证 #245 **仍 open**（2025-12 报告，「This issue remains open」）；steel-sdk npm 0.18.0=2026-03-16 无后续 | **维持 watch，现状正确**：per-session 端点在近期镜像仍失效，切过去 = 主路径恒失败。Lasso 全量 release + 单 session mutex 的现状结论被上游状态背书 |
| R7 camoufox / browserless / agent-browser CLI 范式（NO-GO） | NO-GO ×3 | camoufox 首页官宣主维护者 step down；bench 中游无优势；browserless/agent-browser 无结构性变化 | **全部维持 NO-GO**。camoufox 加固（维护者离场） |
| StagehandChannel R-ECO-6（契约无源码佐证，v1.7 不删不重写） | 在案风险 + doctor #39 HEAD 探测裁决 | **部分翻案**：官方 Stagehand REST API 上线（stagehand-ruby Stainless SDK 实证）——真实面 = `sessions.start/navigate/act/extract/observe/execute/end`（SSE 流式，需要 STAGEHAND_API_URL/BROWSERBASE_API_KEY/MODEL_API_KEY）；**无 `/verify` 路由**；gem v0「APIs may change at any time」；REST 面是「自带浏览器 session」语义，非 Lasso 设想的「对已开页面做语义验证」 | **不重写、不删除，更新档案**（候选 3）：①真实 API 与 Lasso 契约形状不同且不稳定，重写 = 追一个 v0 移动靶 + observe-only 边界下 `verify` 原语在真实面不存在（重写即功能缩水）；②R-ECO-6 的表述应从「上游无 REST」更新为「REST 已上线但形状不匹配（sessions.* 生命周期，无 verify）」；③doctor #39 探测语义不变。v1.8 决策点（round1 遗留）有了新事实底座 |

### 2-3. 任务③：新轴对标（automation-protocol fingerprinting × Lasso）

| 维度 | Lasso 现状 | 基准证据（ianlpaterson 2026-07） | 判定 |
|---|---|---|---|
| 控制面形状（浏览器怎么被驱动） | 四 browse 通道全部经 chrome-devtools-mcp（puppeteer 底，pipe 连接）——属「Playwright/puppeteer 系控制面」 | canadianinsider/medium/glassdoor 三厂商门禁只放行无 shim 直连 CDP 的 nodriver；**一切 Playwright 系（vanilla/patchright/rebrowser）与 130MB C++ fork 同轴同挂**；指纹补丁（JS 或源码级）够不到协议层 | **结构性落后但被诚实定位覆盖**（creepjs-baseline `_honest_positioning` 自述不承诺 DataDode/Kasada——与基准结论一致）；v2.0 突破口 = 无 shim CDP 控制面（W-B1），不是 patchright（R1 降权的第二理由） |
| shape coherence（层间一致性） | E1：HTTP 层 UA(Win/151) ↔ sec-ch-ua-platform(macOS)/sec-ch-ua(150) 矛盾；JS 层经 16 路注入后自洽(Win32/151/Windows brands) | 基准「shape coherence」章节：门禁跨层交叉验证（IP↔TLS↔HTTP/2↔headers↔JS），「proxy 只改 IP 层，之上全漏真身」；手动 Firefox 过、Selenium 驱动同 Firefox 挂 = 检测「可识别的自动化」本身 | **落后一档（可修）**——候选 1 把 profile 对齐宿主 OS 后，HTTP 层平台矛盾消除，残余仅版本 skew（随宿主更新渐增，候选 2 给观测信号） |
| 真 Chrome 二进制红利 | F1：headless 默认系统 Chrome stable（真 TLS/真 sec-ch-ua 值） | 「`channel=chrome` 比 patches 是更大杠杆」（patchright 章节实测结论）；CloakBrowser 的 Chromium 145 fork 无 headroom | **Lasso 优**（T1 迁移后自动获得；macOS 主力机上 sec-ch-ua=真 Chrome 150 值） |
| 资源占用 | 每通道一 Node 子进程 + 系统 Chrome（F1 后不再额外下载 Chromium） | bench Peak RSS：nodriver 轻量系 vs Patchright 13.3GB 峰值（bench 全链） | **持平**（idle reaper + 台账已有；F1 免下载 Chromium 是 T1 附带减重） |

---

## 3. 候选调优项（宁缺毋滥，4 条：P1×1 / P3×3）

### 候选 1（P1）：headless 默认 profile 对齐宿主 OS——新增 `mac_chrome`，darwin 装配默认切换
- **对标证据**：E1 实测（2026-08-17，macOS 12 + Chrome 150 + 1.7.0 同款 flag 组合 + 本地 echo server）：`--user-agent` 生效后 HTTP 层为 `User-Agent: ...Windows NT 10.0...Chrome/151...` + `sec-ch-ua-platform: "macOS"` + `sec-ch-ua: Chromium 150`——**UA 声称 Windows、client hints 招供 macOS** 的 HTTP 层 OS 矛盾。命中 camoufox doctrine 第 1 条（round1 附：UA↔hints 不一致即标记）与 2026-07 基准 shape-coherence 检测模式。`StealthEngine.ts:53-57` 自记 header 侧注入无上游机制 → 现架构内唯一修法 = profile 平台与宿主一致。T2 修复 sannysoft 级（HeadlessChrome token）同时引入本矛盾，属于「修浅层破深层」的净损益反转点。主力平台 macOS 上 sec-ch-ua-platform 永远说 "macOS"（F1：系统 Chrome 发真值）。
- **具体改法**：① `STEALTH_PROFILES` 新增 `mac_chrome`（UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ... Chrome/151.0.0.0 Safari/537.36` + `platform:"MacIntel"` + secChUa brands 151 三方一致 + `secChUaPlatform:'"macOS"'`——顶级 const，INV-30 性质不变，`STEALTH_PROFILE_NAMES` 同步）；② `index.ts:424-430` 装配处按 `process.platform === "darwin" ? "mac_chrome" : "windows_chrome_120"` 选默认（构造期确定性选择，非 env/config 可配，不触 INV-30 anti-gaming 面）；③ profile 遍历测试加 mac_chrome 一致性断言；④ 手测清单归档：echo server 回显「UA 平台 token ↔ sec-ch-ua-platform 同为 macOS」（沿 round1-smoke-headless.mjs 范式）。
- **预期收益**：消除 macOS 主力平台上 HTTP 层 OS 级矛盾（shape coherence 对齐）；Windows 宿主上 windows_chrome_120 本就自洽（本候选不动）；JS 层无需改动（evasion 15/16 从 UA 推断平台，自动跟随）。
- **实施代价**：S-M（一条新 profile + 装配分支 + 测试 + 手测清单）。
- **风险**：默认 profile 变更——依赖 windows_chrome_120 默认的既有测试需同步（grep 范围明确）；**残余版本 skew 不解**（profile 151 vs 宿主 Chrome major，见候选 2 观测）；Linux 宿主仍用 windows profile（矛盾仍在，Win/Linux 是「适配」非主力，记档不扩面）；ghost brand 版本取值按新 major 复核。
- **验收**：mac_chrome 一致性断言绿；装配测试断言 darwin→mac_chrome / 非 darwin→windows_chrome_120；手测清单归档（echo server 双头一致性）；`npm run build && npm test && npm run check-invariants` 基线 1906/79 不减。

### 候选 2（P3，可并入候选 1 同 PR）：UA-age hint 扩「与已装 Chrome major 的实际 skew」维度
- **对标证据**：E1：sec-ch-ua 版本跟随宿主 Chrome（本机 150），profile 钉 151 → HTTP 层版本 skew 随宿主自动更新逐月扩大（+1 major/月）。现有 `estimateUaAgeMonths`（doctor.ts:1717-1740）只按日历时间估算，测不出「宿主 Chrome 被策略钉旧/更新领先」造成的真实 skew。`launcher/launch-chrome.ts` 已有系统 Chrome 探测路径（版本可零成本获得）。
- **具体改法**：doctor `stealth_profile_self_check` 的 detail 在「探测到已装 Chrome major」时附 `skew = profile major − installed major` 提示（|skew|≥2 建议刷新；hint 非 gate，与既有 age hint 同守卫，INV-30 不动）。
- **预期收益**：profile 刷新时机从「日历启发式」变「真机信号」；候选 1 落地后的残余风险（版本 skew）获得可观测面。
- **实施代价**：XS。
- **风险**：无（只读提示，探测失败时静默回退现有 age hint）。

### 候选 3（P3）：R-ECO-6 档案更新——StagehandChannel 注释与 doctor #39 文案对齐新事实
- **对标证据**：stagehand-ruby（官方、Stainless 生成）实证托管 REST API 已上线：`sessions.start/navigate/act_streaming/extract_streaming/observe_streaming/execute_streaming/end` + SSE、`STAGEHAND_API_URL` env、REST 文档 docs.stagehand.dev；**无 `/verify` 路由**；gem v0「APIs may change at any time」。Lasso `StagehandChannel.ts:8-13` 与 doctor #39 的表述仍停留在「上游是 SDK 非 REST 客户端」——事实已漂移。
- **具体改法**：`StagehandChannel.ts` 头注释 R-ECO-6 段更新为「上游托管 REST API 已上线（sessions.* 生命周期形状 + SSE，无 verify 路由，v0 unstable）；本通道 /verify|/extract 契约仍无佐证」；doctor #39 detail 文案同步；doc/16 R-ECO-6 条目补记本轮证据。**代码行为零改动**（probe 语义与 observe-only 边界不变）。
- **预期收益**：档案诚实性（tri-state 精神在文档层）；为 v1.8「重写对齐真实契约 or 删除通道」决策留准确底账（真实面无 verify → 重写即功能缩水，此事实先入档）。
- **实施代价**：XS。
- **风险**：无。

### 候选 4（P3）：BrowseChannel 两处陈旧注释清理（T5 残留）
- **对标证据**：`BrowseChannel.ts:19`（文件头注释「network ──→ evaluate_script 注入 PerformanceObserver」）与 `:125-131`（dispatch Map 注释「network 由 doNetwork 实装（evaluate_script 注入 PerformanceObserver；F2 已知限制）；console 是 v0.5 M0.5b 占位」）——均描述 v1.10 旧范式；实现（cdp-actions.ts v1.11 原生化直调）已变，grep 证实全 src 无 PerformanceObserver 实现残留，纯注释债。round1 T2 曾修过 stealth-profiles.ts:213 同款「注释与实现脱节」，此处是 T5 的对应残留面。
- **具体改法**：两处注释改为「network/console → 1.7.0 原生 list_network_requests / list_console_messages 直调（cdp-actions.ts）」。
- **预期收益**：消灭注释-实现脱节（零成本卫生）；防未来读者按旧注释误判 F2 状态。
- **实施代价**：XS。
- **风险**：无。

### 本轮明确「不做」的处置（记 watch / NO-GO）

| 处置 | 项 | 理由 |
|---|---|---|
| **W-B1 watch（v2.0 议题）** | 无 shim 直连 CDP 控制面（nodriver 范式）作为 stealth 突破口 | 2026-07 基准唯一实证有效的轴；但 = 架构级换驱动层（弃 chrome-devtools-mcp 的全部工具面），与 38 条 R-INT/现 MVP 价值取向冲突。触发条件：L1+候选 1 落地后实测仍被目标站点高频拦截，且用户场景刚需。届时 Rust 侧直连 CDP 与 desktop 的 Rust 基建或有复用想象，但本轮不展开（反过度设计） |
| **W-B2 watch** | CloakBrowser | 热度真实（12 周 13.5k+★）但：独立基准无 headroom（= curl_cffi）、**darwin-arm64 管线停更 ≥2 个月（钉 Chromium 145）**、二进制自定义 license。触发条件：darwin 管线复活 + license 明确 + 基准复测有真实增益 |
| **NO-GO 维持** | camoufox / browserless 第五通道 / agent-browser CLI 范式 / patchright 现轮实施 | 见 §2-2；patchright 维持 roadmap v2.0 但预期收益下修（+1 OK vs vanilla；真 Chrome 杠杆 Lasso 已有） |
| **不做** | StagehandChannel 重写对齐真实 REST | v0 unstable 移动靶 + verify 原语在真实面不存在（重写即缩水）+ session 生命周期语义与「验证我已开的页面」用例不匹配。v1.8 决策点由候选 3 的准确档案支撑 |
| **不做** | sec-ch-ua header 侧注入（Network.setExtraHTTPHeaders 路径） | 上游 1.7.0 仍不暴露该工具；等待上游（StealthEngine.ts:53-57 的 spike 状态维持）；候选 1 用 profile 对齐绕开，零新机制 |

---

## 附：本轮 L3 实测记录（2026-08-17，macOS 12 / Darwin 21.6.0 / 系统 Chrome 150.0.7871.182）

- **E1（UA↔client hints）**：本地 HTTP echo server + `chrome --headless=new --user-agent=<Windows/151 UA> --dump-dom`。请求头实测：`User-Agent: ...Windows NT 10.0...Chrome/151.0.0.0...`；`sec-ch-ua: "Not;A=Brand";v="8","Chromium";v="150","Google Chrome";v="150"`；`sec-ch-ua-mobile: ?0`；`sec-ch-ua-platform: "macOS"`。结论：`--user-agent` 不影响低熵 client hints（发宿主真值）。
- **E2（screen 指纹）**：probe 页读 `screen/avail/outer/inner/dpr`。裸 headless：`screen=800x600 avail=800x600 outer=0x0 dpr=1`；加 `--screen-info={3840x2160}`（1.7.0 headless 默认）：`screen=3840x2160 avail=3840x2160 dpr=1`（800x600 tell 消失；dpr=1 的 4K 在真 Mac 上偏弱信号——Retina 通常 dpr=2，记观察不立项）。
- **E3（webdriver 压制）**：`--enable-automation` → `navigator.webdriver=true`；`--enable-automation --disable-blink-features=AutomationControlled` → `false`。round1「L3 未验证项」就此关闭：Lasso spec 组合在 document 起点压掉 webdriver，无需依赖 afterNavigate JS 注入。
- 门禁：`npm test` 1906（1904 pass / 1 expect-poll timing-flake（负载相关，与 round2-arch 在案一致）/ 1 skip）；`npm run check-invariants` 79/79 PASS。
- 版本事实：chrome-devtools-mcp npm latest=1.7.0（无新版）；Chrome stable latest=152.0.7977.42、前一版 151.0.7922.139（versionhistory API）；patchright npm=1.61.1（2026-06-23）；agent-browser npm=0.34.0（2026-08-10）；steel-sdk npm=0.18.0（2026-03-16）；本机系统 Chrome=150.0.7871.182。
