# 27 · 静默性全面审计 —— 理论矩阵（白盒源码级）

- **日期**：2026-08-19
- **被审**：lasso-mcp v1.17.1（`4fda181` 后工作树；2240 tests + 81 INV 基线，本次零 src/test 改动）
- **方法**：逐通道从 tool 入口读源码到最后一层进程（spawn 路径→每层→可见性 flag）；上游 chrome-devtools-mcp@1.7.0 以 `npm pack` 拉取 tarball 逐文件白盒（`/tmp/cdm-audit/package/build/src/`，与 SubprocessManager.ts:49 版本锁一致）；既有真机实证（E5/E7/E8/V1-V7，见 `doc/history/01-功能测试执行记录/v1x-silent-verify.md`）只引用不重跑。
- **六维打扰面**：①OS 焦点（frontmost 变化）②窗口出现 ③Dock/任务栏图标 ④音频 ⑤系统通知 ⑥资源争抢。
- **结论先行**：**纯查询与 curl 式五条路径（machine_mcp / brave / serp_http / content_blocks 二跳 / fetch_url / fetch_feed / wayback_lookup）白盒证明完全静默（零 spawn、零 UI、零声音、零通知）**；browse_headless 与 launch-chrome hidden 接近纯静默（各有 1 个待真机确认项 / 1 个已知 Dock 残留）；**连用户自开 Chrome 有三个结构性盲区**（pages[0] tab 劫持 / 全 tab 焦点仿真副作用 / 用户 Chrome 不静音）——见 §7 可疑点清单。

---

## 1. 总矩阵（通道 × 六维）

图例：`零` = 白盒证明无该维路径；`□` = 理论无路径但建议真机抽验；`△` = 低概率/条件性；`●` = 确定发生（设计或已知边界）。

| 通道 | ①OS焦点 | ②窗口 | ③Dock/任务栏 | ④音频 | ⑤系统通知 | ⑥资源 |
|---|---|---|---|---|---|---|
| search `machine_mcp` | 零 | 零 | 零 | 零 | 零 | 极低（进程内 undici） |
| search `brave` | 零 | 零 | 零 | 零 | 零 | 极低（进程内 undici Agent，connections:8） |
| search `serp_http` 快探 | 零 | 零 | 零 | 零 | 零 | 低（turndown 转换 ≤2MB HTML，进程内 CPU） |
| search `content_blocks` 二跳 | 零 | 零 | 零 | 零 | 零 | 低（并发 3 × 5s × 256KB） |
| `fetch_url` / `fetch_feed` / `wayback_lookup` | 零 | 零 | 零 | 零 | 零 | 极低（redirect:manual，无升级路径） |
| `browse_headless` | 零（headless 无窗口） | 零 | **□ S-1**（macOS headless=new 是否注册 Dock） | 零（puppeteer 默认 `--mute-audio`，上游源码 third_party/index.js:72539 实证） | 零（stealth 的 Notification spoof 仅页内 JS，stealth-profiles.ts:248,297） | 中（Chromium 树 ~8 进程 / ~300-500MB；5min idle 回收） |
| `launch-chrome hidden` + browse_logged_in | 零（E7/V1/V5：frontmost 不变、6/6 步 focusStolen:false） | 零（`--no-startup-window`） | **● 已知诚实边界**（Dock 多一个 Chrome 图标） | 零（`--mute-audio` 两档恒加，launch-chrome.ts:303） | 零 | 中（实测 511MB/8 进程；server 内 60s idle 回收；**CLI 起的常驻至 chrome-stop**） |
| hidden 离屏 fallback 档 | △ `<1s` 焦点闪现（E5 实证兜底档行为） | △ 出屏窗口 `-32000,-32000` | ● 同上 | 零 | 零 | 同上 |
| `launch-chrome visible` | **●**（V2：frontmost 变 Chrome） | **●**（1 窗口） | ● | 零（visible 档也恒静音） | 零 | 中 |
| **连用户自开 Chrome**（--browser-url/9222） | 操作面零抢焦（见 §5.3 逐操作表） | 零新窗口——但 **● pages[0] tab 内容被导航**（S-7） | 零新增 | **△ 非零**（用户 Chrome 未静音；导航到自动播放媒体页会真出声，S-9） | △ 页内 JS 通知走用户 Chrome 原生通知路径 | 低-中（+1 node 子进程；全 tab 挂 Network/Console collector） |
| `desktop`（对照） | **● 设计上占用**（CGEvent 物理键鼠 + AXFocused） | ● 部分白名单动作激活目标 app | n/a | 无白名单音频原语 | △ TCC 授权弹窗仅首次配置 | 极低（rust-helper 常驻） |
| `search_local`（对照） | 零 | 零 | 零 | 零 | 零 | 极低（mdfind spawnSync ≤5s；SQLite 只读副本） |

---

## 2. 纯查询通道白盒（search 全链）

### 2.1 machine_mcp（默认主路径）
链路：`tools/search.ts` → `MachineMcpSearchChannel.search()`（MachineMcpSearchChannel.ts:134）→ `McpClient.connectHttp()`（McpClient.ts:93）→ MCP SDK `StreamableHTTPClientTransport` → Node 内置 fetch/undici HTTPS POST `open.bigmodel.cn`。
- **零 spawn**：本通道不注册任何 SpawnSpec；McpClient 仅在 stdio 模式持子进程（本通道 http 模式 `stdioTransport=null`，McpClient.ts:143）。
- **零 UI/声音/通知**：全链进程内；logger 走 stderr（util/logger.ts:4），由 Claude Code 捕获进 MCP 日志，不达用户终端。
- key 探测读 `~/.claude.json` 只读（INV-72），零触网零 UI。

### 2.2 brave
`BraveChannel._doRequest()`（BraveChannel.ts:228）→ 注入的 `httpClient.fetch` = `SubprocessManager.acquireHttpClient()`（SubprocessManager.ts:318）→ 进程内 `undici.Agent`（keepAlive 30s / connections 8）+ global fetch。零 spawn、零 UI。429 熔断纯内存台账。

### 2.3 serp_http 快探
`rawSerpSearch()`（http-serp.ts:410）→ `httpEngineOnce()` → 注入 pooled fetchImpl（index.ts:750-756 装配，同样 acquireHttpClient 包装）。
- **redirect 处理**：`redirect:"follow"`（http-serp.ts:251）——undici **进程内**跟随重定向，无任何浏览器参与；软挡检测读 `response.url` 终态比对（:322-339）。
- **本模块内无浏览器升级路径**；升级发生在链级（FallbackDecider）——见 S-6。
- HTML→文本 turndown 转换为进程内 CPU（2MB 上限 :309），无 UI。

### 2.4 content_blocks 二跳（v1.17）
`ContentSecondHop.fetchContentBlocks()`（ContentSecondHop.ts:468）→ 自实现并发池（concurrency 3）→ `fetchOneContentBlock()`：
- SSRF 守门 = `node:dns/promises.lookup`（ssrf-guard.ts:23）——**纯 Node DNS 解析，非进程**；
- fetch = 注入 pooled fetchImpl（index.ts:767-770，同款 acquireHttpClient 包装），`redirect:"manual"`（3xx 不跟随，如实 fetch_failed）；
- **enrichment 不是 fallback**（文件头红线）：第二跳**永不**升级浏览器——重站/JS 渲染页如实 `fetch_failed` 留给 CC 自己 browse。并发 3、单条 5s、总预算 15s、单条 256KB 硬顶。
- 结论：同为 undici，零 spawn 零 UI。

---

## 3. curl 式通道白盒（fetch_url / fetch_feed / wayback_lookup）

三工具同一底座 `doFetchUrl()`（fetch-url.ts:92）：
- SSRF → `acquireHttpClient(origin)` → undici Agent fetch；
- **`redirect:"manual"`**（fetch-url.ts:150）：3xx 一律不跟随，把 `location` 返给 caller 显式二次调用（防 SSRF 绕过）——**结构上不存在"重定向→浏览器升级"路径**；
- **INV-23 禁 fetch↔browse 互 fallback**（文件头铁律）：fetch_url 是 caller-tier 工具，不挂 FallbackDecider 链，失败就是失败；
- fetch_feed（fetch-feed.ts:343）与 wayback_lookup（wayback.ts:144）都是 doFetchUrl 的纯解析包装，无独立网络面。
- 唯一子进程面：无。最大 body 16MiB（fetch_url）/2MiB（feed）/256KB（wayback）进程内缓冲。

**五条纯网络路径（§2+§3）合计确认：全 src 无 spawn、无 osascript、无 Notification API、无 afplay/say、无窗口原语。**（grep 交叉验证：`display notification|afplay|say |osascript.*beep` 全 src 零命中；osascript 仅 chrome-hide.ts 静默 fuse 与 desktop 白名单两处受控使用。）

---

## 4. browse_headless 白盒（spawn 链逐层）

### 4.1 进程链
```
Claude Code ─stdio─ lasso server（MCP，stderr 全部进程内 logger）
  └─ SubprocessManager.ensureRunning("headless")（SubprocessManager.ts:164）
      └─ SDK StdioClientTransport.spawn: npx -y chrome-devtools-mcp@1.7.0
         --headless --isolated --no-usage-statistics
         --chromeArg=--disable-blink-features=AutomationControlled
         --chromeArg=--user-agent=<profile UA>
         --chromeArg=--accept-lang=<lang>  --viewport=WxH  [--proxy-server]
         stderr:"pipe"（HeadlessChannel.ts:81-102 / SubprocessManager.ts:509-518）
          ├─ npx shim（node；冷启动首跑下载包到 ~/.npm/_npx——网络+磁盘，无 UI）
          └─ chrome-devtools-mcp（node server）
              └─ puppeteer.launch({ headless:true, pipe:true, channel:'chrome',
                   userDataDir:undefined(--isolated→临时目录) })（上游 browser.js:169-185）
                  └─ 用户已装真 Chrome 二进制，flags:
                     --headless=new --hide-scrollbars --mute-audio（puppeteer 默认，third_party/index.js:72539）
                     --hide-crash-restore-bubble --screen-info={3840x2160}（上游 browser.js:144,149）
                     + lasso 注入 chromeArgs
```

### 4.2 逐维判定
- **①焦点/②窗口**：headless=new 无窗口无 UI 线程参与（`--screen-info` 虚拟屏）；lasso 侧零激活原语。
- **③Dock/cmd-tab**：`--headless=new` 走完整 Chrome 二进制，macOS 上是否向 LaunchServices 注册 NSApplication（→Dock 图标/cmd-tab 条目）**取决于 Chromium 运行时行为，白盒不可证**——S-1 待真机。既有 V6 实验（真机跑通 headless browse）未记录 Dock 现象，KEY-GUIDE 也只对 launch-chrome 声明 Dock 残留，可作弱旁证。
- **④音频**：puppeteer headless 默认追加 `--mute-audio`（上游打包源码 third_party/index.js:72539 逐字实证）——静音不依赖 lasso 显式 flag（lasso headless spec 无 --mute-audio；若上游升级改默认，见 S-2）。
- **⑤通知**：无 OS 通知路径；stealth 的 `Notification.permission` spoof（stealth-profiles.ts:248,297）是**页内 JS 返回值伪装**，不会创建系统通知。
- **⑥资源**：Chromium 树常驻（参照 hidden 有头实测 8 进程/511MB；headless 略低）；`LASSO_HEADLESS_IDLE_MS=300000`（5min）默认回收（index.ts:401-402，zombie reaper 60s tick）；退出三重兜底（_kill 树杀 / lifecyclePids / killAllSync exit 钩子）。
- **stderr 去向**：npx 与 chrome-devtools-mcp 的 stderr 全部 `pipe` 进 lasso（SpawnSpec.stderr 默认 "pipe"）→ lasso logger → **CC 的 MCP 日志文件**，全程不达用户终端。Chromium 自身 stdout/stderr 由 puppeteer 持有（仅 --logFile 时落盘，lasso 未配）。
- **stealth 注入**：afterNavigate → `StealthEngine.injectProfile` = 纯 `evaluate_script` 页内 JS（StealthEngine.ts:42-49,131），无 alert/prompt/弹窗原语；Cloudflare 检测是只读 evaluate。**无声无窗。**
- **页面创建**：上游 launch 自建初始 about:blank（headless 不可见）；lasso 调用面从不触发上游 `new_page`（默认前台开 tab 的工具，见 §5.3）。

---

## 5. 有头通道三子路径

### 5a. launch-chrome hidden（lasso 自起）
spawn 链：`launchChrome()`（launch-chrome.ts:216）→ `node:child_process.spawn(Chrome, args, { detached:true, stdio:'ignore' })`（:329-332）。
- **flag 全集**（:293-313，exact-string 去重）：`--remote-debugging-port=N` `--no-first-run` `--no-default-browser-check` `--user-data-dir=~/.cache/lasso/chrome-profile-default` + 反节流三件套（`--disable-backgrounding-occluded-windows` `--disable-background-timer-throttling` `--disable-renderer-backgrounding`）+ `--mute-audio`（**两档恒加**）+ hidden 档 `--no-startup-window`（win 追加 `--start-minimized`）。
- **隐藏保险丝**：spawn 成功即同步执行 `hideChromeByPid`（:363-371，F1 修复后零延迟）= spawnSync osascript System Events **按 unix id 定向** set visible=false（chrome-hide.ts:59-75；E8 红线：永不按进程名 hide）。osascript 本身无窗口。
- **真机实证**（v1x-silent-verify）：V1 零窗口/frontmost 不变/0 targets；V5 六步 CDP 操作（`Target.createTarget{background:true}`→navigate→click→fill→evaluate→closeTarget）6/6 `focusStolen:false` 窗口恒 0。
- **browse 接线**：LoggedInChannel.getMcpClient → `precreateBackgroundTabIfHidden()`（LoggedInChannel.ts:222-252）——台账判定 hidden 且零 page target 时，经裸 WS `Target.createTarget {background:true}`（CdpClient.ts:183-199，E7 两次复测零抢焦的唯一钥匙）预建后台 tab，使上游 MCP 绑定它而非自建前台页。
- **残留**：Dock 图标（已知诚实边界）；server 进程内 60s idle 回收后消失；**CLI 单独起的没有 reaper**（KEY-GUIDE 已声明）。
- fallback 离屏档（`--no-startup-window` 启动即退时）：`--window-position=-32000,-32000` 有 `<1s` 焦点闪现（E5）。

### 5b. visible 档
用户显式 `--mode visible`。V2 实证：1 窗口 + frontmost 变 Chrome。**非静默是预期**（仍恒静音）。模块默认保守 visible（launch-chrome.ts:289），生产入口 config 层默认 hidden（KEY-GUIDE）。

### 5c. 连用户自开 Chrome（--browser-url / 9222 直连）——最可疑盲区，逐操作
连接面：LoggedInChannel spec `npx chrome-devtools-mcp@1.7.0 --browser-url=http://localhost:9222`（LoggedInChannel.ts:154-164）→ 上游 `puppeteer.connect`（browser.js:104）——**不起 Chrome 进程**，附着用户正在用的浏览器。

**上游侧关键机制（tarball 白盒）**：
1. 页面绑定：`McpContext.updatePages` 把**全部** page 包成 McpPage，无选中页时 `selectPage(pages[0])`（McpContext.js:385-393）——**绑定的是用户第一个 tab，不激活、不新开**；
2. 每个 McpPage.init() 对**所有**用户 tab 执行 `emulateFocusedPage(true)` = CDP `Emulation.setFocusEmulationEnabled(true)`（McpPage.js:169-175，注释明言"support multi-agent workflows"）——虚拟焦点仿真；
3. `dispose()` 不还原焦点仿真（McpPage.js:374-384），依赖 session detach 的 CDP 自动回滚。

**逐操作焦点影响表（lasso 调用面 × 上游实现）**：

| lasso action | 上游工具 | 上游实现 | 抢焦/弹前台？ |
|---|---|---|---|
| navigate | `navigate_page` | `Page.navigate`（pages.js:125） | 否（不切 tab 不激活窗口）——但**换了 pages[0] 的 URL**（S-7） |
| click | `click` | `locator.click()` = scrollIntoViewIfNeeded + CDP `Input.dispatchMouseEvent`（input.js:148） | 否（trusted 事件注入，无需 OS 焦点） |
| fill | `fill_form` | locator fill（BrowseChannel.ts:1016-1026） | 否 |
| evaluate / extract | `evaluate_script` | `Runtime.evaluate` | 否 |
| screenshot | `take_screenshot` | `Page.captureScreenshot`（fromSurface 系） | 否（后台 tab 可截） |
| snapshot | `take_snapshot` | DOMSnapshot/a11y 读 | 否（2FA 探测同款，只读） |
| wait | `wait_for` | 轮询 | 否 |
| pdf / network / console | `Page.printToPDF` / 原生采集器 | 被动 | 否 |
| tab 管理 | `list_pages` / `close_page` | 枚举/按 pageId 关页 | 否（close_page 契约错配见 S-10） |

**上游仅有的激活原语及 lasso 调用情况**：
- `select_page {bringToFront:true}` → `page.bringToFront()`（pages.js:52-53）：**lasso 零调用**（INV-78d grep 钉死 src 内 select_page/bringToFront//json/new 零命中，check-invariants.mjs:4068-4070）；
- `new_page`（默认 `background:false` = **前台开 tab**，pages.js:89-108 schema 明示"Default is false (foreground)"）：**lasso 零调用**（browse 走 navigate_page）；
- `PUT /json/new` HTTP 开 tab：lasso 零调用（同上 grep）。

因此白盒结论：**连接与操作本身不抢 OS 焦点**；KEY-GUIDE"低打扰非零打扰"的实际残留 = S-7（tab 内容劫持）+ S-9（焦点仿真/音频面）+ 历史 0.3.0 时代经验（当时上游自建页会激活——1.7.0 + lasso 预建后台 tab 后该路径仅 hidden 台账 Chrome 有保险，**连用户可见 Chrome 无预建**，若上游某操作间接建页仍可能激活一次，属待验）。

---

## 6. 对照通道

### 6.1 desktop
- **设计上不可静默**（KEY-GUIDE 原文）：cgevent.rs 合成物理键鼠（CGEventPost）、ax.rs 设 `AXFocused`（:600-603）——占用用户键鼠/改焦点是功能本体；
- AppleScript 白名单（apple-script-whitelist.ts:94-114 / rust-helper 双层校验）：finder_new_folder / mail_new_message / safari_open_location / notes_new_note 等——多数动作会激活目标 app（可见）；**无音频原语、无通知原语**；
- screenshot.rs = CGDisplay 静默截屏（无 UI）；
- TCC 授权弹窗仅首次配置期（doctor 引导），运行期不再弹；
- rust-helper 经 SubprocessManager 纯 lifecycle 管理（stdio pipes，无终端污染）。

### 6.2 search_local
- `mdfind`：spawnSync CLI（mdfind.ts:93-98，5s 超时/1MB buffer）——Spotlight 查询**无任何 UI**（mdfind 是纯命令行工具，不经 Spotlight 面板）；
- `chrome-history`：`copyFileSync` 源库 → 临时副本 → `node:sqlite` readOnly（chrome-history.ts:330）——**不触碰 Chrome 进程**（规避 Chrome 对 History.db 的文件锁），用户无感；
- 零网络（INV-81(d)）。

---

## 7. 可疑点清单（每条：通道 × 维度 × 源码锚点 × 需真机验证什么）

| # | 通道 × 维度 | 源码锚点 | 白盒判断 | 需真机验证 |
|---|---|---|---|---|
| **S-1** | browse_headless × ③Dock/cmd-tab | HeadlessChannel.ts:81-102（spec 无窗口类 flag）；上游 browser.js:169（headless:true→`--headless=new`） | headless 无窗口，但 macOS 上完整 Chrome 二进制是否注册 NSApplication 白盒不可证 | 起 browse_headless 后 10s：`lsappinfo list | grep -i chrome`、Dock 目视、cmd-tab 目目视；对照 chrome-devtools-mcp 进程树存活期间 |
| **S-2** | browse_headless × ④音频 | 上游 third_party/index.js:72539（puppeteer headless 默认 `--mute-audio`）；lasso spec 未显式加 | 当前版本实证已静音；静音**依赖上游默认**，非 lasso 契约 | （低成本抽验）headless 打开自动播放视频页，确认真无声；升级 puppeteer/chrome-devtools-mcp 时回归此项 |
| **S-3** | browse_headless × ⑤通知 | stealth-profiles.ts:248,297（Notification.permission 页内 spoof） | 页内 JS 无 OS 通知路径，理论零 | 抽验通知中心无 lasso 相关条目（可选） |
| **S-4** | browse_headless × ⑥资源 | index.ts:401-402（5min idle）；SubprocessManager zombie reaper | Chromium 树常驻最长 5min；与 Docker/CC 并存时内存压力（用户曾实测浏览器卡顿，参见 vscode-copy-latency 记忆） | headless 工作期间 `memory_pressure` 前后对照 + 活动监视器进程数/RSS |
| **S-5** | browse_headless × 条件性 spawn | SubprocessManager.ts:509-529（npx spawn，stderr pipe） | stderr 三层管道止于 CC MCP 日志，不达用户终端；冷启动 npx 首跑有 npm 下载（网络+磁盘 ~/.npm/_npx） | 清空 npx 缓存后首次调用计时/观察无终端输出（可选） |
| **S-6** | search 全链 × 条件性升级为浏览器 | FallbackChain.ts:34,60；serp/extract.ts serpScrapeFallback；FallbackDecider | **一次"纯查询" search 在 API 层全挂时会隐式 spawn browse_headless**（链末端兜底）——不是 UI 打扰但违背用户对"search=纯网络"的直觉，资源维度有感 | 断网 Brave/机器 MCP 后跑 search，观察 Chromium 进程树出现 |
| **S-7** | 连用户 Chrome × ②tab 内容劫持 | 上游 McpContext.js:385-393（`selectPage(pages[0])`）；LoggedInChannel.getMcpClient（仅 hidden 台账 Chrome 预建后台 tab，用户可见 Chrome 无预建） | **browse_logged_in 连用户 Chrome 的 navigate 会把用户第一个 tab 导航走**（不抢焦点但内容被换）；TabSession.restore 只关新增 tab，**不恢复被导航 tab 的原 URL** | 用户 Chrome 开 3 个 tab → browse_logged_in 导航 → 确认哪个 tab 被换页、会话结束后是否残留 |
| **S-8** | 连用户 Chrome × ①焦点逐操作 | §5.3 表；INV-78d（check-invariants.mjs:4068-4070） | lasso 调用面零 bringToFront/select_page/new_page//json/new；理论全部操作不抢焦——KEY-GUIDE"个别操作可能抢一次焦点"或已过时（0.3.0 时代）或指 S-7 类次生效应 | 串行逐操作（navigate/click/fill/evaluate/screenshot/wait/pdf）前后采 frontmost（osascript System Events frontmost），2s 间隔，前台 app 名前后对照 |
| **S-9** | 连用户 Chrome × ④音频+焦点仿真副作用 | 上游 McpPage.js:169-175（全 tab `emulateFocusedPage(true)`）、:374-384（dispose 不还原）；lasso 对用户 Chrome 不加 --mute-audio（设计：不动用户浏览器） | (a) 后台 tab 误判"已聚焦"可能诱发自动播放逻辑；(b) 用户 Chrome 未静音——navigate 到自动播放媒体页**会真出声**；(c) 断开后焦点仿真是否随 session detach 自动回滚未证 | 连接前后各 tab console `document.hasFocus()` 对照；断开（chrome-devtools-mcp 退出）后再对照；导航一个自动播放视频页听声音 |
| **S-10** | 连用户 Chrome × tab 管理契约错配 | TabRegistry.ts:110（调 `close_page {url}`）vs 上游 pages.js:58-64（schema 是 `pageId:number`） | reconcile 的 >10 tab 淘汰对 1.7.0 **必然静默失败**（参数不匹配→异常→catch）→ 用户 tab 实际不会被误关（良性）；但契约错配本身是缺陷，且若上游未来接受 url 形态，淘汰将**关掉用户自己的 tab**（registry 不区分 lasso tab 与用户 tab） | 12-tab Chrome 连接后 tab 数不变 + 无可见关闭；（修复向）改用 list_pages 的 pageIdx/pageId 再调 close_page |
| **S-11** | launch-chrome hidden × 离屏 fallback 焦点闪现 | launch-chrome.ts:163,415-425（`--window-position=-32000,-32000`）；chrome-hide.ts:59-75（fuse 需 Accessibility TCC） | 主路径零窗口已证（V1）；fallback 档 `<1s` 闪现（E5）；TCC 缺失时 fuse 降级 | 仅 TCC 未授权机器上复测 fallback 路径的可见性（低优先级） |
| **S-12** | launch-chrome（CLI 起）× ⑥资源+Dock 残留 | launch-chrome.ts:518（CLI 短命进程无 reaper，KEY-GUIDE §B 诚实边界） | CLI 起的 hidden Chrome 常驻至 chrome-stop——Dock 图标与 ~500MB 底噪长期存在 | 无需验证（文档化边界）；可选：CLI 输出加 hint |
| **S-13** | desktop × 全维 | rust-helper/src/cgevent.rs、ax.rs:600-603、apple-script-whitelist.ts:94-114 | 物理键鼠/AXFocused/白名单 app 激活=设计上不可静默；TCC 弹窗仅首次 | 无需验证（设计契约，如实记录） |
| **S-14** | search_local × 全维 | mdfind.ts:93-98（spawnSync）；chrome-history.ts:330（copyFileSync+readOnly） | 零 UI 零网络零 Chrome 进程触碰——理论完全静默 | 一次调用观察 Chrome 无反应 + mdfind 无 Spotlight 面板出现（低成本抽验） |
| **S-15** | 五条纯网络路径 × redirect 升级 | fetch-url.ts:150（manual）；ContentSecondHop.ts:360-387（manual+永不升级）；http-serp.ts:251（follow=undici 内部） | **结构上不存在重定向→浏览器升级路径**（INV-23 + enrichment≠fallback 双红线） | 无需验证（白盒穷尽） |

---

## 8. 结论

1. **完全静默（白盒穷尽，零待验项）**：search 三个 API 源 + content_blocks 二跳 + fetch_url/fetch_feed/wayback_lookup——纯 undici 进程内网络，无 spawn、无窗口、无声音、无通知；redirect 无浏览器升级路径。唯一提示：S-6（search 链末端可能隐式起 headless 浏览器）。
2. **接近纯静默**：browse_headless（唯一待验 S-1 Dock；音频已由上游 `--mute-audio` 实证）；launch-chrome hidden（已知 Dock 残留 + CLI 无 reaper；焦点/窗口/音频已真机实证零）。
3. **低打扰非零（三个结构性盲区）**：连用户自开 Chrome——操作面不抢焦（上游激活原语 lasso 全零调用，INV-78d 守卫），但 S-7 tab 劫持、S-9 全 tab 焦点仿真+不静音、S-10 tab 管理契约错配是白盒新发现，KEY-GUIDE 现行"个别操作可能抢一次焦点"的表述应升级为这三条更准确的边界。
4. **设计上不可静默（如实记录）**：desktop 通道物理键鼠；visible 档为用户显式选择。

**给真机验证轮的优先序**：S-8（逐操作焦点采样，覆盖 KEY-GUIDE 边界复核）> S-7（tab 劫持）> S-9（音频/焦点仿真）> S-1（headless Dock）> S-10（tab 数不变）> 其余可选。纪律：前台 app 名前后对照、串行+2s 间隔、结束清理（chrome-stop / 台账清空 / pgrep 复核）。
