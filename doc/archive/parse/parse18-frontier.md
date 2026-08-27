# parse18-frontier — 静默浏览器自动化前沿调研（2024-2026）

> 调研员产出 · 2026-08-15。纯调研，未改 lasso 代码，门禁不适用（基线不动）。
> 服务三个用户需求：①新开浏览器"用完即关"（idle 可配 `~/.lasso/config.json`）；②新开浏览器默认隐藏/最小化（macOS 重点 + Windows 适配）；③"首屏新浏览器 + 用户切屏后操作"是否阻断用户、能否纯静默（含"已有浏览器新开 tab 默默操作"）。
> 方法：web 检索（web-search-prime）+ chrome-devtools-mcp CHANGELOG/issue 白盒（zread/webReader）。所有关键结论带来源。

---

## 1. chrome-devtools-mcp 上游动向（GoogleChromeLabs → ChromeDevTools org）

版本线已到 **v1.2.0（2026-06-08）**，发布节奏极快（2025-09 公开预览以来月更多次）。与"静默/窗口/viewport"相关的白盒变更（CHANGELOG 全量 grep）：

| 版本 | 变更 | 对 Lasso 的意义 |
|---|---|---|
| 0.6.1 | change default screen size in headless (#299) | headless 有默认 viewport，不传参也可截图 |
| 0.6.0 | support initial viewport in the CLI (#229) | 可控首屏尺寸 |
| 0.11.0/0.12.0 | `--user-data-dir`（含 `--auto-connect` 组合、channel 映射 resolveDefaultUserDataDir） | 隔离 profile 复用登录态的官方姿势 |
| 0.13.0 | resize_page 支持 maximized/fullscreen window state (#748) | 窗口状态可编程操作 |
| **0.14.0** | **new_page 增加 `background` 参数 (#837)**；device viewport + UA emulation (#798) | **上游官方支持"后台开 tab 不抢焦点"**——需求③"在新 tab 默默操作"的现成能力（MCP 工具参数 `background: true`，CLI 旗标 `--background`） |
| 0.16.0/0.19.0 | channel 文档修正 / simplify focus state management (#1063) | 上游在整理焦点语义 |
| 0.9.0/0.8.1 | bundle puppeteer-core / puppeteer 24.24.1 | 依赖 Puppeteer 24+，继承其 headless='shell' 能力（见 §2） |

**headless 是否默认化：没有。** 官方 chrome-devtools-mcp 默认仍是 **headed（可见窗口）**，`--headless` 是显式 opt-in 旗标；README 明确两种模式，社区文章（Addy Osmani / note.com 复盘）均以"headed 便于人眼跟踪、headless 便于服务器"描述。值得注意的是社区 fork **browser-devtools-mcp（npm）把 `--headless` 默认设为 true**——说明"MCP 默认静默"是真实需求方向，但 Google 官方尚未跟进。

**关键 open issue（需求③的直接证据）**：[#1254 "macOS: Chrome steals window focus on every CDP command"](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1254)（2026-03-27，v0.20.3，--autoConnect 模式）：
- 症状：macOS 上**几乎每个 MCP 工具调用（含只读的 take_screenshot / list_pages / select_page 且未设 bringToFront）都会让 Chrome 抢走键盘焦点**，用户在 IDE/终端工作时被持续打断。
- 报告者试过的 workaround **全部失败**：`bringToFront: false` 只对单个 select_page 有效；移到独立 Space 无效（Chrome 作为 app 仍被 activate）；PostToolUse hook 用 osascript 把焦点拉回来会肉眼可见地闪烁；另开窗口/Space 同样无效。
- 归因：Chromium 层——CDP WebSocket 通信触发 macOS `NSApplication activate`；关联 10 年+ 未修的 Chromium bug（chromium#223828 chromedriver 抢焦点、#40770130 随机抢焦点、#40182355 macOS 启动抢焦点）。
- 提议的解法（issue 内）：服务端 `--no-activate`/`--background` 旗标、只读操作走 headless CDP 会话、避免非交互工具触发 activate、`Target.createTarget` 传 background/focus:false。
- **结论：只要"复用用户可见的已登录 Chrome"，macOS 焦点被抢是 Chromium 平台级现状，纯静默不可达**；静默的正确层级是"隔离 profile 的 headless 实例"或"独立 profile 的 hidden window 实例"（见 §3/§5）。

上游其他相关动向：`--auto-connect`/DevToolsActivePort 发现、launched vs connected 的 close 语义（launched→browser.close() 杀进程；connected→disconnect 留浏览器活着）、Windows 并发 CDP 截图崩溃（v1.2.0 才限并发绕过，#2137）——对 Lasso 的 Windows 适配是风险提示。Qwen-code #8737 还记录 Chrome "Allow remote debugging?" 同意对话框会反复弹出，复用用户浏览器路径上还有交互成本。

## 2. Chrome headless 语义与 chrome-headless-shell

（官方：developer.chrome.com/docs/automation-and-testing/headless + /headless-chrome-shell + removing-headless-old-from-chrome）

- **旧 headless 已死**：Chrome 132（2025-01）起 `--headless=old` 从 Chrome 主二进制移除。现行两种：
  1. **新 headless（`--headless` / `--headless=new`）**：与完整 Chrome 同一代码渲染内核，GUI 代码仍在二进制里只是不显示。指纹≈headed Chrome（ userAgent 不再带 HeadlessChrome，Chrome 129+ 起旧 UA token 也移除）。
  2. **chrome-headless-shell 独立二进制**：老 headless 的延续，无 GUI/无完整浏览器 UI 开销，专为核心 CDP 驱动场景（加载页面、抽 DOM、截图）。Puppeteer 24+ 用 `headless: 'shell'` 选项直达；Chrome-for-Testing 分发。**适用性判断：适合 Lasso 的"默认抓取"档——但它不是完整 Chrome（无扩展 UI、部分扩展 API/登录态 UI 依赖场景弱），不适合"需登录态 GUI"档**。
- GUI 语义差：新 headless 在 OS 层**根本没有窗口**，所以不存在抢焦点/抢 Space/占 Dock 问题——这是"纯静默"唯一无损的实现层级；headed + 隐藏/最小化窗口只是"视觉上不打扰"，OS 窗口仍存在、部分平台事件仍会 activate app（§1 #1254）。
- macOS 12 Intel 本机注意：headless 实例省的是 compositor/窗口开销，CPU/内存大头（renderer per tab）不变；多实例并行时仍要限并发。

## 3. 业界"不打扰用户"范式

### Puppeteer/Playwright 官方立场
- **Playwright 官方（issue #16009）**："New pages will steal focus in the headed mode. It looks like you should use headless mode instead." —— 官方答案就是**别用 headed 做后台**；headed 下新 tab 抢焦点是已知行为，不打算修。
- **Playwright #4822**（阻止启动时置前）：社区可靠 workaround 是 macOS `open -g -a …`（-g = background）启动；官方无第一方支持。
- **Puppeteer #852**（launch non-headless Chrome minimized）：长期 open，无跨平台 flag；Chrome 的 `--start-minimized` 在 Windows 11 的 Chrome 上**不生效**（Edge 生效，Reddit r/Windows11 实测；SO/Google 支持帖同样结论：`START /MIN`、快捷方式"最小化运行"均被 Chrome 忽略或不可靠）。
- 结论：**两大框架都把"headed 但后台"视为不支持的灰区**，官方正路 = headless；上游 chrome-devtools-mcp 的 `new_page(background:true)` 是 tab 层的唯一官方"不抢焦点"原语。

### OS 级 hide window API 生态
- **macOS**：
  - 启动时：`open -g -a "Google Chrome" --args --remote-debugging-port=… --user-data-dir=…`（-g 不激活；Ask Different 实测还有 `-j` 直接 hidden，比 -g 更彻底）。这是 Lasso launch-chrome 最低成本改造点——把 spawn 换成/前置 `open -g`。
  - 启动后：osascript System Events `set visible of process "Google Chrome" to false`（等价 Cmd+H 隐藏整个 app，不最小化到 Dock 右侧、不触发"窗口飞入"动画）；或 `set miniaturized of window 1 to true`（真最小化）。AXAPI 权限：System Events 控制 需要"辅助功能"授权（Lasso desktop 通道已有 rust-helper/AXAPI 基建可复用）。
  - 局限（对应 #1254）：隐藏≠不抢焦点；CDP 调用仍可能 activate app（隐藏态下表现为焦点丢失/菜单栏切换，GUI 闪烁消失但键盘焦点仍被偷）。彻底免疫只有 headless。
- **Windows（代码审查级，无法真机验证）**：
  - `CreateProcess` 时 `STARTUPINFO.wShowWindow = SW_SHOWMINNOACTIVE`（最小化且不激活）——对忽略 show-window-hint 的 Chrome 可能仍不生效（同 `START /MIN` 被忽略的根因）。
  - 兜底两段式：启动后枚举窗口（by PID + class `Chrome_WidgetWin_1`），`ShowWindowAsync(hwnd, SW_SHOWMINNOACTIVE)` + `SetWindowPos(hwnd, HWND_BOTTOM, …, SWP_NOACTIVATE)`；需要重试/轮询直到窗口创建完成。这是 Windows 上"隐藏自动化窗口"的标准做法（Selenium Grid 社区同款）。
  - Windows 还可考虑 `--window-position=-32000,-32000`（移出屏幕）hack：廉价但任务栏图标仍在、Alt-Tab 仍可见，仅缓解不静默。
- **Selenium Grid/浏览器农场**：服务器上 Xvfb（Linux 虚拟显示）或干脆 headless；Windows 节点跑 headed 时靠"专用会话/专用 VM"物理隔离用户——即**业界从不试图在同一用户会话里让 headed 浏览器完全隐形**，要么换显示层级（headless/Xvfb），要么换用户会话。

### "首屏新浏览器 + 用户切屏后操作"是否阻断（需求③正面回答）
- 只读操作（截图/快照/DOM 读取）：**在 headless 或独立 Space 的隔离实例上不阻断用户**；在"复用用户可见 Chrome"上，macOS 会持续抢焦点（#1254），实质阻断打字。
- 输入类操作（CDP 派生键鼠事件）：走 CDP `Input.dispatch*`，**不发系统级键鼠**，不影响用户物理键盘；但目标页面在后台 tab 时渲染可能被节流（requestAnimationFrame/setTimeout 节流、后台 tab 定时器 clamp 到 1Hz）——**后台 tab 默默操作可行，但时序敏感页面要预期变慢**；可用 CDP `Emulation.setFocusEmulationEnabled(true)`（Puppeteer 自动手势同款）在无焦点页面维持"焦点仿真"，绕过 visibility/focus 相关门控。
- 桌面级真实键鼠（Lasso desktop 通道 cgEvent 档）：**必然抢占用户物理输入**（CGEventPost 是系统级），该档无法静默，只能在用户明确让出机器时执行——这是架构上就该保留的档位区分。

## 4. 反爬视角：静默 vs 反检测 trade-off

- 2025-2026 共识：**新 headless 指纹已≈headed**（UA 无 HeadlessChrome token、Chromium 持续消差），但仍有 worker 线程/WebGL/字体等深层信号差异（ipasis 2025：主流 stealth 只补主线程 window 对象，worker 里的 WebGL/指纹照样暴露）。
- 大规模实测（arXiv 2606.14525，"Detecting Bot Detection"）：**Chromium headless 配置的 soft-block 率 ~15%，其他（headful 等）配置 ~7%**，约一倍差距；82% 的拦截可归因于 bot 检测栈。ScrapingAnt 2025 年度文的结论同向：高价值目标站建议 headful（真窗口或 headful 农场）+ 住宅 IP；一般抓取 headless+stealth 足够。
- **对 Lasso 的含义**：三档需求恰好对齐——默认抓取走 headless（+既有 stealth 投入）成本最低；反爬敏感站升级到"headed 但隐藏窗口"（窗口存在=OS 层指纹是真实 headed，Chrome 内部认为自己是有窗口的完整浏览器，比 headless 更难检测；代价是 §3 的焦点管理复杂度）；最敏感才需要用户可见登录。即：**"隐藏的 headed 窗口"是反检测优于 headless、静默性劣于 headless 的中间档**，这正是需求②"隐藏或最小化"的技术价值所在。

## 5. 对 Lasso 的建议矩阵

| 场景 | 静默方案 | 代价/风险 |
|---|---|---|
| **默认抓取**（无需登录、无反爬高压） | 新 launch 一律 `--headless`（新 headless，完整 Chrome 二进制；Puppeteer/chrome-devtools-mcp `--headless`），配独立 user-data-dir；idle 用完即关（idle 阈值进 `~/.lasso/config.json`，如 `chrome.idleCloseMs`，沿用 LASSO_HEADLESS_IDLE_MS 语义并落到模板） | 指纹略弱于 headed（~15% vs 7% soft-block）；依赖 stealth 既有投入 |
| **默认抓取（性能敏感/批量）** | 同上但换 `chrome-headless-shell`（`headless:'shell'`） | 无 GUI 开销最小，但非完整 Chrome，扩展/登录 UI 弱，仅核心 CDP 场景 |
| **需登录态 GUI**（要看到/复用登录、反爬高压） | 隔离 profile + headed：macOS 用 `open -g -a` 启动（不激活）+ 启动后 osascript `set visible … to false` 隐藏；Windows 两段式 ShowWindowAsync(SW_SHOWMINNOACTIVE)+HWND_BOTTOM（可编译性验证 + 文档交付）；仍监听 CDP 空闲即关 | 窗口存在：macOS CDP 仍可能偷焦点（#1254，隐藏后表现为键盘焦点被偷）；Windows 适配不可真机验证；Dock/任务栏图标可见（可接受：用户能找到它在跑） |
| **复用用户已开浏览器（browse_logged_in 档）** | 只用 `new_page(background:true)` 开后台 tab + `Emulation.setFocusEmulationEnabled` 维持页面活性；select_page 一律 `bringToFront:false` | 后台 tab 渲染节流（时序敏感页面变慢）；macOS 上 app 级 activate 无法根治（Chromium 10 年 bug），只能文档化"此档会闪焦点"；Chrome "允许远程调试" 同意框交互成本 |
| **桌面级真实键鼠**（desktop cgEvent 档） | 无法静默，保持显式执行 + 用户在场语义 | 架构保留为独立档，不与浏览器静默混淆 |

配置面落地建议（对应需求①②）：`~/.lasso/config.json` 增加 `chrome` 段：`idleCloseMs`（用完即关，默认如 60s，远小于 5min；5min 作为用户可选保留值）+ `launchMode: "headless" | "hidden" | "visible"`（默认 headless 或 hidden）。idle watchdog 现只覆盖 SubprocessManager 的 headless spec，需把 launched Chrome（含 headed/hidden 档）纳入同一台账，`chrome-stop` 路径复用。

## 6. 要点摘要（TL;DR）

1. 上游 chrome-devtools-mcp 未把 headless 默认化（默认 headed），但 v0.14.0 起提供 `new_page(background:true)`——"已有浏览器后台开 tab 默默操作"有官方原语；macOS "每个 CDP 调用抢焦点"是 Chromium 平台级 open bug（#1254），复用可见 Chrome 做不到纯静默。
2. Chrome 132+ 只有新 headless（≈完整 Chrome、指纹接近 headed）和 chrome-headless-shell（无 GUI 开销、能力子集）；"纯静默"的唯一无损层级是 headless——无窗口即无焦点问题。
3. Playwright/Puppeteer 官方立场一致：headed 后台不支持，去 headless；`--start-minimized` 对 Windows Chrome 无效，须 ShowWindowAsync(SW_SHOWMINNOACTIVE)+HWND_BOTTOM 两段式；macOS 用 `open -g`（或 -j）+ osascript 隐藏。
4. 反爬：headless soft-block ~15% vs 其他 ~7%（arXiv 2026 实测）——"隐藏的 headed 窗口"是指纹优于 headless 的中间档，恰好由需求②的 hidden 模式承接。
5. Lasso 建议：默认抓取=新 headless+用完即关（config 可配 idleCloseMs）；登录态档=hidden headed（open -g / SW_SHOWMINNOACTIVE）；复用浏览器档=background tab+focus emulation；桌面 cgEvent 档=显式非静默。

主要来源：ChromeDevTools/chrome-devtools-mcp CHANGELOG 与 issue #1254、#837、#748；developer.chrome.com headless/headless-shell/removing-headless-old；Playwright #16009/#4822；Puppeteer #852；arXiv 2606.14525；ScrapingAnt/ipasis 2025 反检测分析；browser-devtools-mcp（npm，headless 默认=true 的 fork）。
