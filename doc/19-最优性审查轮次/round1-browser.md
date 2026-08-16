# 第 1 轮最优性审查 —— 浏览器自动化与反检测域（browse_headless / browse_logged_in / cloud）

> 调研日：2026-08-16。调研员：round1-browser。
> 方法：web 检索（热度/活跃度）+ zread 白盒读对标项目源码 + npm registry 版本时间线 + 逐项回读 lasso 源码锚点。
> 所有「Lasso 现状」结论均有 lasso 源码行号锚点；所有对标结论均有上游源码/官方文档锚点。

---

## 1. 本域最新最热项目清单

| # | 项目 | 热度（2026-08-16 实测） | 一句话机制 | 与 Lasso 对应能力的关系 |
|---|------|------|------|------|
| 1 | **browser-use/browser-use** | 109k★，昨日仍有 commit | Python AI 浏览器 agent 框架 + 云端 stealth 浏览器基础设施（宣称 82% Internal Bench Hard） | 上一层（agent loop）框架；Lasso 是工具层 MCP，不构成合并目标；其「stealth 基础设施即服务」路线与 Lasso 自托管立场相反 |
| 2 | **ChromeDevTools/chrome-devtools-mcp** | 49k★，latest **1.7.0（2026-08-10）**，持续高频发版（npm 共 60 版） | Google 官方 MCP，底层 puppeteer，暴露 DevTools 全量能力 | **Lasso 四条 browse 通道的驱动层**。Lasso 锁 `0.3.0`（2025-09-25 发布，落后约 11 个月 / 57 个版本）——本域最大单点差距 |
| 3 | **vercel-labs/agent-browser** | 41k★，上周仍有 commit（2025 末爆发的新贵） | Rust 原生 CLI 直连 CDP（无 MCP 中间层），a11y 树 snapshot+ref 交互、`--session` 多隔离实例、auth vault + **AES-256-GCM 状态加密**、network route/mock、llms.txt-aware read | 范式对手（CLI vs MCP，token 效率论）；同时**验证了 Lasso 的 CookieStore AES-256-GCM / TabSession / 多 profile 设计是业界同代前沿** |
| 4 | **browserbase/stagehand** | 24k★，上周仍有 commit；v4（2026） | 「browser agent 的 SDK」：act/observe/extract 自愈原语，**v4 自研 CDP engine + 浏览器旁扩展**（降往返延迟），TS/Python/Go，MIT | Lasso 已有 StagehandChannel，但其 REST 契约 `api.stagehand.dev/{verify,extract}` 在上游无源码佐证（Lasso 自记 R-ECO-6 / doctor #39）；上游 v4 仍是 SDK 非 REST，虚构风险坐实中 |
| 5 | **browserless/browserless** | 14k★，上周仍有 commit | Docker 化无头浏览器服务（PW/Puppeteer/CDP REST+WS API），v2 开源持续维护 | 与 SteelChannel 同生态位的自托管云浏览器；Lasso 已覆盖 Steel + Browserbase 双云，再加属面积扩张，不建议 |
| 6 | **daijro/camoufox** | 11k★，最近有 commit；**官方 stealth 页 2026 自认维护断档一年、性能下降、指纹不一致** | Firefox 源码级 fork：Juggler 隔离（Playwright 看到的页面与真实页面分离）、C++ 拦截一切指纹 API、BrowserForge 统计分布指纹 | Lasso creepjs-baseline 曾把「Camoufox 范式」标为 v2.0+ 架构扩张；**其 2026 衰退反向验证了 Lasso 不跟进的决策**。JS 侧有 apify/camoufox-js（~300MB 引擎下载，重） |
| 7 | **steel-dev/steel-browser** | 7.5k★，最近 commit 2026-07（放缓） | 开源浏览器 API：session 管理 + puppeteer/CDP + nginx 9223 CDP 代理 + 内建 stealth 插件与 fingerprint | Lasso SteelChannel 的对标本体。REST 契约验证仍成立（`POST /v1/sessions`、`/v1/sessions/release`）；新增 per-session release / `/v1/scrape` `/v1/screenshot` `/v1/pdf` 快动作 / proxyUrl / blockAds；已知回归 issue #245（release 端点，2025-12）+ 自托管无鉴权（#235） |
| 8 | **berstend/puppeteer-extra** | 7.4k★，**最后一次实质 commit 2023-03（实质弃维）** | JS 注入式 stealth 插件体系（plugin-stealth ~20 路 evasion） | **Lasso 16 路 evasion 的上游来源**（vendored puppeteer-extra-plugin-stealth@2.11.2）。生态共识：该范式被 CF Enterprise/DataDome/Akamai v4/PerimeterX 全面检测；维护断档 3 年 |
| 9 | **ultrafunkamsterdam/nodriver** | 4.7k★，最近 commit 2026-05（放缓） | Python 直连 CDP、去 Playwright/WebDriver 化、最轻（~80-120MB/实例），不做行为伪装 | Python-only，对 Lasso 仅为范式基准：证明「CDP 直连 + 去 automation flag」可过基础检测 |
| 10 | **Kaliiiiiiiiii-Vinyzu/patchright** | 4.1k★，2026-08 活跃；Node 包 `patchright`（另有 Python/.NET） | **补丁版 Playwright driver**：避免 `Runtime.enable` 泄漏（隔离执行上下文）、禁 Console API、启动 flag 净化（加 `--disable-blink-features=AutomationControlled`、去 `--enable-automation`）、InitScript 走网络路由注入；README 宣称过 CreepJS/DataDome/Kasada/CF/Akamai/F5 | **TS 生态唯一活跃的 L2（driver 级）stealth 升级路径**；scrapewise 2026-04 基准：CF Enterprise「passes most targets」。Chromium-only、部分 Playwright 测试不过（作者 issues/30）、教育用途免责声明 |
| 11 | **apify/fingerprint-suite** | 2.6k★，2026-08 活跃 | BrowserForge 统计分布指纹生成器 + 维护中的 JS 注入器 | Lasso v1.5 profile 的 header 集 schema 参照来源（Apify header-generator）；可作为 profile 值更新的数据参考，不必引依赖 |

补充横评依据：scrapewise.ai《Best Playwright Stealth 2026》（2026-04 实测基准：playwright-extra 全线被 CF Enterprise/DataDome/Akamai/PerimeterX 拦；Patchright 过多数 CF；Camoufox 0% headless 检出但 42.49s 均值绕挑战 + 200MB+/实例）；camoufox.com/stealth 官方 2026 文（daijro）：①「网络请求 UA ≠ navigator UA 即标记」②「一切注入 JS 皆可检出（getOwnPropertyDescriptor / toString 不返 [native code] / worker 上下文不一致）」③「CDP 不做任何隐藏（navigator.webdriver / debugger 栈 / ChromeDriver 注入变量）」——三条均直击 JS 注入范式的结构性上限。

---

## 2. 白盒对标表

判定口径：Lasso优 = Lasso 实现超出所有对标项；持平 = 同代等价；落后 = 对标存在 Lasso 可感知的能力/健康度差距。

| 维度 | Lasso 现状（源码锚点） | 对标项目（源码/文档锚点） | 判定 |
|------|------|------|------|
| 驱动层版本 | `src/subprocess/SubprocessManager.ts:38` `LOCKED_CDP_MCP_VERSION="0.3.0"`（npm 发布 2025-09-25） | chrome-devtools-mcp latest **1.7.0**（2026-08-10）；0.3.0 之后新增：`--chromeArg` 透传、`--proxy-server`（0.6.0）、`--wsEndpoint/--wsHeaders`（0.9.0）、`--viewport`、`--autoConnect` Chrome 144+（0.26.0）、`--allowedUrlPattern/--blockedUrlPattern`（1.2.0）、memory/screencast/extensions/WebMCP 工具族、TOON 结构化输出 | **落后（本域最大差距，11 个月/57 版）** |
| HTTP 头侧 UA 一致性 | `HeadlessChannel.ts:56-64` 启动参数仅 `--headless --isolated --disable-blink-features=AutomationControlled`（后者为 0.3.0 未文档化 flag，代码自注「是否真到 Chromium = L3 未验证」）；UA 仅靠 `StealthEngine.ts:246-268` JS `defineProperty(navigator.userAgent)`（**改不了 HTTP 头**） | headless Chrome 默认发 `HeadlessChrome/…` UA（多方证实）；camoufox 官方：「网络请求 UA 与 navigator UA 不一致即标记」；patchright 直接**在二进制层移除 HeadlessChrome UA** | **落后（网络层头号检测点，且修复成本极低）** |
| stealth 注入时机 | `BrowseChannel.ts:148-169` wrapNavigate：navigate 完成后 `afterNavigate` 注入（W1-DEF-1c 自注：上游 0.3.0 不暴露 `Page.addScriptToEvaluateOnNewDocument`）——**页面反爬脚本先于 stealth 补丁运行** | patchright：InitScript 经网络路由注入 HTML 响应（document_start 前生效）；puppeteer 原生 `evaluateOnNewDocument`；chrome-devtools-mcp 至 1.7.0 仍未暴露 new-document 注入工具 | **落后（evaluate_script 范式结构性限制，Lasso 已自知）** |
| stealth 有效性质级 | 16 路 evasion vendored 自 puppeteer-extra-plugin-stealth@2.11.2（`stealth-profiles.ts:256-270`，12 个 `stealth-evasions/*.ts`）；`doctor/fixtures/creepjs-baseline.json` `_honest_positioning` 明确「过 sannysoft/基础检测，不承诺 CreepJS/DataDome/Kasada」 | 生态分层（scrapewise 2026）：JS 注入（puppeteer-extra，弃维）< driver 补丁（patchright，活跃）< C++ fork（camoufox，衰退）。puppeteer-extra 最后实质 commit 2023-03 | **落后（结构性），但定位诚实、与业界共识一致；基准文证实 JS 路线天花板即 Lasso 自述** |
| CDP Runtime.enable 泄漏 | 无处理（继承 puppeteer/chrome-devtools-mcp 行为） | patchright README 列为「最大的 Patch」：隔离执行上下文避免 `Runtime.enable`；nodriver 同理去 Runtime.enable | **落后（被诚实定位覆盖；根治须换驱动层）** |
| 指纹 profile 数据 | `stealth-profiles.ts:106-170`：3 条顶级 const profile；windows_chrome UA=**Chrome/130**（2024-10 时代；2026-01 Chrome 144 已 stable）、secChUa brands 同为 130；INV-30 anti-gaming 不从 env 读 | fingerprint-suite/BrowserForge 统计分布持续更新；Steel session 内建 fingerprint 生成；patchright 跟随 Chromium 版本演进 | **落后（数据时效：UA 落后 ~14 个大版本是弱信号；设计原则 INV-30 不冲突）** |
| 会话/标签生命周期 | `logged-in/TabRegistry.ts`（LRU ≤10，INV-50）+ `TabSession.ts`（首附着快照+diff 恢复）+ `SubprocessManager` idle watchdog（5min）+ `touchKeepalive`（HeadlessChannel.ts:77-79）+ `launcher/chrome-idle-reaper.ts` + `chrome-ledger.ts` 台账 | chrome-devtools-mcp 1.7：`--experimentalPageIdRouting`（并发 agent 按 pageId 路由）+ CLI daemon `--sessionId`；agent-browser：`--session` 隔离实例 + `session list` + `--restore` 状态持久化策略 | **持平（Lasso 的 tab 快照恢复 + 台账 + idle reaper 组合超出所有对标单项）** |
| 登录态/凭证保险库 | `logged-in/CookieStore.ts`（AES-256-GCM、mode 0600、INV-48/49/53）+ `keychain.ts` + `ProfileRegistry.ts`；INV-52：自动路径永不触碰 cookie export/import | agent-browser：auth vault（OAuth/2FA/cookie 登录流文档化）+ `AGENT_BROWSER_ENCRYPTION_KEY` AES-256-GCM 状态加密 | **持平（同代设计；Lasso 的 admin opt-in 边界（INV-52）更严格）** |
| 复用真实 Chrome（logged_in） | `launcher/launch-chrome.ts`（探测+spawn 9222+台账）+ `chrome-hide.ts`（PID 定向 AppleScript 隐藏，红线：永不按进程名）+ hidden 档 `--no-startup-window` + `LoggedInChannel.precreateBackgroundTabIfHidden`（`Target.createTarget {background:true}` 裸 CDP 预建 tab） | chrome-devtools-mcp 0.26.0+ `--autoConnect`（Chrome 144+ 从 user-data-dir 自动连，需 chrome://inspect 用户授权）——官方化了「复用真实 Chrome」路径 | **Lasso 优（零打扰三件套 + 台账收尾是超集；autoConnect 可作为未来免启动入口，但需交互授权，非无人值守）** |
| 代理/IP 轮换 | 全 src 无 proxy 支持（grep 证实；SteelChannel body={} 未传 proxyUrl） | chrome-devtools-mcp 0.6.0+ `--proxy-server`；Steel session `proxyUrl`（含 SOCKS）；camoufox doctrine：IP 轮换与指纹一致性是对偶要件 | **落后（headless/cloud 通道无出口 IP 故事；对国内代理/TUN 环境用户也是实用痛点）** |
| 云通道契约 | `SteelChannel.ts:91-111` `POST /v1/sessions`（无 auth、body={}）+ `:327-345` `POST /v1/sessions/release` + 单例 session mutex（Promise 队列锁）；`deriveCdpEndpoint` 9223 nginx 推导 | steel-browser `api/src/modules/sessions/sessions.routes.ts`：两契约均存在（release-all 变体）；另确认 per-session `/v1/sessions/:sessionId/release`、`/v1/scrape|/screenshot|/pdf` 快动作、isSelenium；issue #245：per-session release 在 2025-12 后镜像回归 | **持平（契约正确）；依赖健康度落后（Steel 活跃放缓 + 无自托管鉴权 + #245）** |
| Browserbase 连接方式 | `BrowserbaseChannel.ts:160-169` `--browser-url=${wsUrl}`（wss://connect.browserbase.com/?sid） | 上游 0.9.0 才显式加 `--wsEndpoint`+`--wsHeaders`（--browser-url 对 wss+自定义头语义在 0.3.0 未保障） | **落后（升级后应改走 wsEndpoint 语义）** |
| Stagehand 集成 | `StagehandChannel.ts:1-13` REST 契约 `api.stagehand.dev/{verify,extract}` 自记 R-ECO-6「上游无源码佐证」+ doctor #39 HEAD 探测 | 上游 stagehand v4：SDK 形态（`@browserbasehq/stagehand` act/observe/extract/verify）、CDP engine、浏览器旁扩展；无 REST 服务 | **落后（契约虚构风险 Lasso 已在案；上游演化未给它翻案）** |
| 网络可观测性 | `BrowseChannel.ts:125-132` doNetwork=evaluate_script 注 PerformanceObserver（自注 F2 已知限制）、doConsole 为占位 | 上游 0.3.0 即有 `list_network_requests`（分页，changelog 0.3.0 Features）；1.7.0 有 `get_network_request`、`--redactNetworkHeaders`、`--allowedUrlPattern` 网络管控；agent-browser 有 network route/mock/requests 全套 | **落后（白捡能力未用；route/mock 属上游没有的能力差）** |
| 资源占用模型 | 每通道一个 chrome-devtools-mcp Node 子进程（headless / logged_in:<profile> / steel / browserbase 至多 4 个 Node + 各自 Chrome）+ idle reaper 收尾 | agent-browser：单 Rust daemon 多 session（CLI 每 call 一次进程，daemon 常驻）；nodriver ~80-120MB/实例；Steel：一容器多 session | **持平偏落后（MCP 中间层是既定架构的固定成本；idle reaper 已缓解；换驱动= v2 决策）** |
| 隐私/遥测 | 无遥测（Lasso 自身零上报） | chrome-devtools-mcp 1.x **默认向 Google 采集使用统计**（成功率的调用、延迟、环境；`--no-usage-statistics` 或 env 关闭） | **升级时必须显式关闭，否则倒退** |

---

## 3. 候选调优项（宁缺毋滥，共 6 条采纳级 + 1 条缓做级）

### A.（P0）升级 chrome-devtools-mcp 0.3.0 → 1.7.0，锁定新版本并适配
- **对标证据**：`SubprocessManager.ts:38` 锁 0.3.0（npm 2025-09-25）vs latest 1.7.0（2026-08-10）；上游新增 `--chromeArg`/`--proxy-server`(0.6.0)/`--wsEndpoint --wsHeaders`(0.9.0)/`--viewport`/`--allowedUrlPattern`(1.2.0)/`--no-usage-statistics`；evaluate_script 的 `filePath` 路径穿越问题（issue #2201）在演进线中获得处理。工具名（evaluate_script/new_page/navigate_page/take_snapshot/list_pages/close_page）跨版本稳定，迁移面可控。
- **具体改法**：①升 `LOCKED_CDP_MCP_VERSION`；②所有 spec 追加 `--no-usage-statistics`（守 Lasso 零遥测定位）；③回归跑 1801 测试 + parse13-acceptance sannysoft 手测清单；④BrowserbaseChannel 改 `--wsEndpoint` 语义。
- **预期收益**：解锁 B/D/G 三项；上游 11 个月 bug 修复红利；`--experimentalPageIdRouting` 为未来并发 agent 会话留门。
- **实施代价**：中（一次性迁移 + 契约回归；`toFnExpression` 等上游契约点需复核）。
- **风险**：跨 57 版 breaking change；须保留旧版本一行回滚能力（锁版本 const 本就是单点，回滚=改一行）。

### B.（P0，依赖 A）headless 通道网络层 UA 修复：launch 级 `--user-agent`
- **对标证据**：`HeadlessChannel.ts:56-64` 未传 UA flag；`stealth-profiles.ts:213-215` 注释声称「UA/viewport/timezone 由启动 flag 控制」**但 spec 实际没传**（注释与实现脱节）；camoufox 官方 doctrine 第一条即 UA 头↔navigator 不一致即标记；headless 默认 UA 含 HeadlessChrome。
- **具体改法**：升级后经 `--chromeArg=--user-agent=<profile.userAgent>`（+可选 `--viewport=<w>x<h>`）在进程启动时定型；JS 侧 16 路保留为双保险。
- **预期收益**：消除网络层头号检测点；sannysoft UA 行转绿；`--disable-blink-features=AutomationControlled` 同时经 `--chromeArg` 真正到达 Chromium（消除「unknown flag 哑弹」）。
- **实施代价**：小（spec 数组加两项）。
- **风险**：profile 与子进程生命周期绑定——现状 profile 本就是构造期选定（HeadlessChannel.ts:38 默认 windows_chrome_120），无冲突；跨通道（Steel/Browserbase 云端自带指纹）不动。

### C.（P1）profile 数据时效更新：Chrome 130 → 当前 stable 时代值（含 secChUa brands 三方一致）
- **对标证据**：`stealth-profiles.ts:107-127` UA/brands=Chrome 130（2024-10）；Chrome 144 于 2026-01 进 stable（developer.chrome.com 144 release notes）；scrapewise：「为 Chrome 109-112 时代检测模式写的补丁」是生态通病——**UA 版本过旧本身即启发式弱信号**。
- **具体改法**：只改 `STEALTH_PROFILES` 顶级 const 的值域（UA、secChUa、brands 版本号三方一致），key 不动（parse13 §2 稳定标识符承诺）；顺手把 UA 版本↔brands↔userAgentData 一致性写进现有 profile 遍历测试断言。
- **预期收益**：低成本降低指纹年龄信号；无架构改动。
- **实施代价**：小（数据 + 测试快照）。
- **风险**：无（INV-30 顶级 const 性质不变）；建议同时建立「每 N 月刷新 UA 值」的 doctor 检查项而非自动化生成（守 anti-gaming）。

### D.（P1，依赖 A）doNetwork/doConsole 换上游原生 network/console 工具
- **对标证据**：`BrowseChannel.ts:125-132` 自注「network 由 evaluate_script 注入 PerformanceObserver（F2 已知限制）；console 为占位」；上游 0.3.0 起即有 `list_network_requests`（changelog），1.7.0 另有 `get_network_request`、`list_console_messages`、`--redactNetworkHeaders`。
- **具体改法**：dispatch Map 两条 entry 的 handler 换 callTool 直调（INV-6 不动，仍是 Map entry）；PerformanceObserver 注入路径删除。
- **预期收益**：数据完整度（响应体/头/时序）+ 删自造轮子代码；console action 从占位变实装。
- **实施代价**：小-中。
- **风险**：上游返回形状需按 `upstream-response.ts` 围栏提取范式适配（W1-DEF-1b 经验）。

### E.（P2）SteelChannel release 端点改 per-session 变体 + 文档钉 Steel 镜像 tag
- **对标证据**：`SteelChannel.ts:327-345` 用 `POST /v1/sessions/release`（release **全部** 会话）；上游 routes 另有 `POST /v1/sessions/:sessionId/release`；issue #245（2025-12）：per-session release 端点在近期镜像回归、会话隔离失效。
- **具体改法**：默认调 per-session 端点、失败 fallback 全量 release（现有行为）；README 钉自托管镜像 tag（如 ghcr.io/steel-dev/steel-browser:<date>）并注明 #245。
- **预期收益**：多会话自托管场景不误杀；回归可追踪。
- **实施代价**：小。
- **风险**：#245 未修期间 per-session 端点可能不工作——fallback 即兜底；契约测试需双端点 mock。

### F.（P2）proxy 出口支持：headless 通道 `--proxy-server` 透传 + Steel session body 传 `proxyUrl`
- **对标证据**：上游 0.6.0 起 `--proxy-server`；Steel session schema 原生 `proxyUrl`（含 SOCKS）；Lasso 全 src 无 proxy 面（grep 证实）；camoufox doctrine：IP 与指纹一致性是对偶要件；用户实际网络环境（ClashX/TUN）下出口一致性也是 browse 可靠性问题。
- **具体改法**：新增 `LASSO_PROXY` env（config 默认层，PolicyGate 可见），非空时 headless spec 追加 `--proxy-server=<v>`、SteelChannel 的 `defaultSteelSessionProvider` body 加 `proxyUrl`；logged_in 通道**不适用**（用户真实 Chrome 出口必须原样）。
- **预期收益**：反封锁基本面 + 代理环境用户的通道可用性（TUN 直连/代理出口可选）。
- **实施代价**：小。
- **风险**：env 属用户显式配置、不触碰 INV-30 stealth anti-gaming 面（stealth profile 仍顶级 const）；需 doctor 加一项「proxy 配置回显」防误配。

### G.（缓做，v2.0 候选——本轮不建议实施）patchright-nodejs 备选 stealth 通道
- **对标证据**：patchright（Node 包，2026-08 活跃）README：Runtime.enable 规避 + flag 净化 + 二进制级去 HeadlessChrome UA，宣称过 CreepJS/DataDome/Kasada/CF；scrapewise 2026：Node 栈推荐位、「CF Enterprise passes most targets」；camoufox（另一 L2 路线）官方自认维护断档一年+性能下降——**patchright 是 TS 生态唯一活跃的 driver 级 stealth**。
- **具体改法（若未来做）**：新增默认关闭的可选通道（如 `browse_stealth`），以 `patchright`（Playwright drop-in）子进程驱动；接入既有 tri-state/PolicyGate/fallback 语义。
- **预期收益**：stealth 从 L1（JS 注入）升 L2（driver 补丁），突破 `creepjs-baseline.json` 自述的「JS defineProperty 范式结构性上限」。
- **实施代价**：大（Playwright 级依赖 + 新通道 + 全套测试）；与「简单架构 38 条」存在张力。
- **风险**：patchright 部分 Playwright 测试不过（作者 issues/30）、Chromium-only、console 被禁用（与 D 项冲突需取舍）、上游「教育用途」免责声明。
- **判定**：与 Lasso 现行诚实定位（不承诺 CreepJS/DataDome）相容并行；宁缺毋滥，本轮只记录不实施。

### 本轮明确「不做」的对齐决策（记录理由）
- **不加 browserless 第五通道**：Steel+Browserbase 已覆盖自托管+托管双云，面积扩张违 R-INT 简单架构。
- **不跟进 Camoufox**：上游自身维护断档+性能下降+42s 绕挑战成本，Lasso v1.7 冻结基线时的判断在 2026-08 被上游自我证实。
- **不换 agent-browser 的 CLI 范式**：Lasso 的产品形态是 MCP（forest 统一入口），agent-browser 的 CLI+skill 省 token 路线是 CC 侧配置选择而非 Lasso 内部结构问题；其 auth vault/状态加密设计反向验证 Lasso 同代。

---

## 附：关键事实速查
- chrome-devtools-mcp 版本线（npm registry 实测）：0.3.0=2025-09-25 → 0.5.0=2025-09-29 → 0.9.0=2025-10-22（wsEndpoint+headers）→ 0.12.0=2025-12-10 → 0.20.0=2026-03-11 → 0.26.0=2026-05-12（autoConnect）→ 1.2.0=2026-06-08（allowedUrlPattern）→ **1.7.0=2026-08-10（latest）**。
- puppeteer-extra 最后实质 commit：2023-03（shields.io last-commit 实测）；Lasso vendored 的 @2.11.2 evasion 即该时代产物。
- Steel 契约实测点：`POST /v1/sessions`（body 可含 proxyUrl/blockAds/dimensions/isSelenium）、`POST /v1/sessions/release`（全量）、`POST /v1/sessions/:id/release`（单会话，2025-12 后镜像有回归 #245）、`/v1/scrape|/screenshot|/pdf` 快动作、nginx 9223→9222 CDP 代理。
- stagehand v4：SDK（非 REST）、自研 CDP engine、浏览器旁扩展、TS/Python/Go、MIT（©2026 Browserbase）。
