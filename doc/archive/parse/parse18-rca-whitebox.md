# parse18 白盒审计：launched Chrome「用完即关 + 隐藏不打扰 + 纯静默」RCA

版本：lasso-mcp v1.9.0（1768 TS tests + 77 INV 基线全绿；本次纯审计未改代码，门禁复跑通过）
日期：2026-08-15。审计机：macOS 12（Darwin 21.6.0，Intel）+ Chrome 150.0.7871.182 + Node 24.12.0。
上游源码：chrome-devtools-mcp@0.3.0（npm tarball 实抽，/tmp/cdm030/package/build/src/，即 lasso `LOCKED_CDP_MCP_VERSION` 锁定版）+ 其依赖 puppeteer-core@24.22.3（同 tarball 实抽）+ 上游 master（zread 读，仅作前沿对照）。

---

## 0. 结论速览（先答用户三问）

| 问题 | 结论 | 关键证据 |
|---|---|---|
| ① 新开浏览器用完即关 | **现状：永不自动关**。台账 Chrome 只在「显式 chrome-stop CLI / lasso server 进程停机（SIGTERM/SIGINT/exit）」三个出口被收尾；idle watchdog 只管 SubprocessManager 的 MCP spec，**完全不看磁盘台账** | §1.3；锚点 SubprocessManager.ts:212-238 vs chrome-ledger 消费者 grep 全集 |
| ② 默认隐藏/最小化 | **现状：spawn 即抢焦点**（macOS 实测 Finder 前台→spawn→Chrome 变 frontmost）。`open -g`/`-gj` 均无效（Chrome 自激活）。**唯一实测零打扰方案：`--silent-launch`**（无窗口、零焦点抢占、CDP 全功能可用）；Windows 用 `--start-minimized` + `SW_MINIMIZE` | §1.2 实验 V1/V2/V3/V4 |
| ③ 纯静默可行吗 | **browse 通道基本可纯静默**：navigate/click/fill/snapshot/screenshot/evaluate 全走 CDP 协议注入，不要求 OS 焦点、不抬窗（实测）。三个例外：**新开 tab（默认）会抢焦点、`select_page`/`Page.bringToFront`/`Target.activateTarget` 会抢焦点、后台 tab 有 timer 节流**（launched Chrome 缺 anti-throttle flags，实测 200ms interval 被节流到 1s）。`Target.createTarget {background:true}` 可零打扰开 tab，代价是页面 `visibilityState=hidden`（反爬可见 + 节流） | §3 实验 V5/V6/V7/V8 |
| ④ desktop 通道 | cgEvent 档 = `CGEventPost` 系统级真实键鼠，**必然占用用户的物理输入焦点，不可静默**——这是通道语义本身，不是实现缺陷 | §5 |

---

## 1. launch-chrome 全链路

### 1.1 spawn 参数与窗口可见性

`src/launcher/launch-chrome.ts:245-250` 构造的完整参数表：

```
--remote-debugging-port=<port>   （默认 9222）
--no-first-run
--no-default-browser-check
--user-data-dir=<隔离 profile>    （默认 ~/.cache/lasso/chrome-profile-default，:126-128）
[...extraArgs]                    （仅 CLI --incognito / --extra-args 用户手传）
```

**无任何隐藏/最小化/离屏参数**（无 `--silent-launch` / `--start-minimized` / `--window-position` / headless）。spawn 选项 `detached: true, stdio: "ignore"`（:265-268）+ `child.unref()`（:284）——父进程不持有 lifecycle，Chrome 以普通 GUI 应用形态出现在 Dock/前台。

**焦点抢占时机白盒（哪一步抢）**：

| 时机 | 是否抢 OS 焦点 | 证据 |
|---|---|---|
| **spawn 瞬间（窗口创建）** | **是**。Chrome 首窗创建时自行调用 AppKit 激活（非 LaunchServices 行为，故 `open -g`/`-gj` 也拦不住） | 实验 V1/V2（§1.2） |
| navigate_page（CDP `Page.navigate`） | 否 | 实验 V5-D（§3.1） |
| take_snapshot / evaluate_script | 否（纯 CDP `DOM.performSearch`/`Runtime.evaluate`） | 上游源码（§3.1） |
| click / fill_form | 否（CDP `Input.dispatchMouseEvent`/`Input.insertText`） | 上游源码 + 实验 V6 |
| take_screenshot | 否（CDP `Page.captureScreenshot`，后台 tab 亦可） | 实验 V6-F4 |
| **新开 tab（`Target.createTarget` 默认 / HTTP `PUT /json/new`）** | **是**（连无窗口的 silent Chrome 也会激活进程） | 实验 V5-A/V5-B、V8-I/J |
| **`select_page`（→ `Page.bringToFront`）/ `Target.activateTarget`** | **是** | 实验 V5-B/V5-C、V8-J |

### 1.2 macOS 实测（本机，2026-08-15）

- **V1 基线**：Finder 置前台 → `node dist/index.js launch-chrome --port 9223 --profile /tmp/...` → frontmost 变 **Google Chrome**（焦点被抢，窗口可见弹出）。
- **V2 `open -g` / `open -gj`**：Finder 置前台 → `open -gna "Google Chrome" --args --remote-debugging-port=9224 ...` → frontmost 仍变 **Google Chrome**，`visible of process = true`。**LaunchServices 的 -g/-gj 挡不住 Chrome 自激活**。
- **V3 `--silent-launch`**：Finder 置前台 → 直接 spawn 二进制加 `--silent-launch` → **frontmost 保持 Finder**；`System Events` 数 Chrome 窗口 = **0**；CDP 端口正常（/json/version 通）。**唯一实测零打扰的 headed 形态**。
- **V4 silent Chrome 上建 tab**：`Target.createTarget {url, background:true}` → frontmost 保持 Finder、窗口数保持 0、target 正常创建、`Page.navigate` 成功、`Page.captureScreenshot` 成功（无窗口也有合成输出，54636 字节；配 `Emulation.setDeviceMetricsOverride` 亦 23396 字节）。
- **V4b**：同 silent Chrome 上**不带** background 建 tab（`Target.createTarget` 默认）或 `Target.activateTarget` → frontmost 变 Google Chrome（**即使窗口数仍为 0**，Chrome 仍激活自身）。

注：`--silent-launch` 是 Chromium 未文档化开关（`chrome_switches.cc` 的 kSilentLaunch，Chrome 后台/通知进程用），有跨版本漂移风险；落地时须配 fallback（离屏 `--window-position=-32000,-32000` + spawn 后即时 AppleScript `set visible of process "Google Chrome" to false`，接受 <1s 闪现）。

### 1.3 台账 / chrome-stop 现状：三个出口，全是「进程生命周期或手动」

台账写入：`launch-chrome.ts:296-304`（ok=true 时 `recordLaunch` 落 `~/.cache/lasso/launched-chromes.json`）与 `:324-332`（cdp_not_ready 也登记，launch 时刻**不代 kill**——注释明言这是承诺的精确化）。

台账消费（grep 全集，无第四处）：
1. 显式 CLI：`index.ts:1302` → `runChromeStopCli` → `chrome-stop.ts:122-182`（SIGTERM 2s 优雅 → killTreeSync 树杀；`:139-141` 探活、`:144-153` cmdline `--user-data-dir` 归属验证防 pid 复用误杀）。
2. server 优雅停机：`index.ts:1173-1181`（SIGTERM/SIGINT → `stopLaunchedChromes({all:true})`，3s 上界）。
3. exit 钩子：`index.ts:1210-1216` → `stopLaunchedChromesSync`（同步树杀）。

### 1.4 与 idle watchdog 的覆盖关系（实证：launched Chrome 永不自动关）

- idle watchdog 链路：`index.ts:363-373`（`startIdleWatchdog`：`config.headlessIdleMs > 0` 才 `subproc.startZombieReaper(60_000, config.headlessIdleMs)`）→ `SubprocessManager.ts:194-209`（60s 周期 timer）→ `:212-238` `cleanupZombies` **只遍历 `this.procs`**（即 `lasso-browse-headless` / `logged_in:<profile>` 两个 MCP spec——chrome-devtools-mcp 的 **node 进程**，`:509-515` spawn 时登记）。
- launch-chrome 起的 Chrome 是 `detached + unref` 的独立进程，**不在 `procs` 里，与 watchdog 零交集**。watchdog 杀 logged_in spec 时杀的是 shim→node(chrome-devtools-mcp) 树；该 spec 走 `puppeteer.connect`（上游 `browser.js:27-39`，master 版 `closeBrowser` 对 connected 模式显式 `disconnect()` 保用户 Chrome 存活），**连带的 Chrome 不在树里、不受影响**。
- 推论（实证级，代码路径全覆盖）：**server 存活期间，launched Chrome 没有任何时间驱动的关闭路径——用户不手跑 chrome-stop、server 不退出，它就永远活着**。这正是需求①要修的缺口：修法是给台账 Chrome 加独立 reaper（读 ledger + browse 调用 touch 时间戳），且新键（如 `LASSO_LAUNCHED_CHROME_IDLE_MS`）走 §2 的 config 链路，成本近零。

---

## 2. config 链路

### 2.1 模板现状：LASSO_HEADLESS_IDLE_MS **已在**

`src/config/config.ts:179-198` `CONFIG_TEMPLATE` 末项即 `LASSO_HEADLESS_IDLE_MS: 300000`（:197）。默认值常量 `DEFAULT_HEADLESS_IDLE_MS = 300_000`（:76，注释明示 5min、0=禁用、可配 3600000 回退常驻）；解析 `parseHeadlessIdleMs`（:83-88，负数/NaN/未设回退默认，0=禁用且无上限 clamp）。

### 2.2 文件→env 合并对新键的适配成本（实证：近零，但非零）

- `loadConfigFileEnv`（config.ts:127-171）是**key 无关**的：扁平 JSON 逐 key 规范化为字符串（number→String、boolean→"true"/"false"，:161-167），`_` 前缀跳过（:160）。**任何新键无需改此函数**。
- 合并点 `loadConfig`（:244）`{ ...fileEnv, ...envSource }`——env 覆盖文件，同样 key 无关。
- 唯一成本在出口：`loadConfig` 显式挑键构造 `LassoConfig`（:307 `parseHeadlessIdleMs(env.LASSO_HEADLESS_IDLE_MS)` → :319 `headlessIdleMs` 字段）+ `index.ts:363-373` 消费。**新增一个可配键的全成本 = 模板加 1 行 + parse 函数 1 个 + 接口字段 1 个 + 消费点接线**，无结构性改动。既有 `LASSO_HEADLESS_IDLE_MS` 就是这个模式的全套样例（含 INV-77 (c)「idle 阈值 configurable 默认 5min」不变量守护，本次 check-invariants 实跑 PASS）。
- 用户侧：`lasso-mcp config init` 生成的 `~/.lasso/config.json` 已含该键；**已存在的旧文件不会被模板覆盖**（`writeConfigTemplate` config.ts:215-219 存在即不覆盖）——旧用户需手补新键，文档须提示。

---

## 3. browse 操作焦点影响白盒（chrome-devtools-mcp@0.3.0 上游源码）

lasso 侧调用面（`src/channels/BrowseChannel.ts`）：`navigate_page`(:686)、`take_snapshot`(:734/:772/:835)、`take_screenshot`(:785)、`click`(:895)、`fill_form`(:908)、`wait_for`(:921)、`evaluate_script`(:533/:745/:853/:934)、`list_pages`(:579)；`pdf`/network/console 走 `browse/cdp-actions.ts:48-61` 的集中常量表。**lasso 从不调 `select_page`**（grep 无命中）——这是当前唯一会 `bringToFront` 的上游工具，绕开它是纯静默的关键之一。

### 3.1 上游工具 → CDP 命令映射（0.3.0 tarball 实读）

| 上游工具 | 实现（锚点） | 底层 CDP | 需要 OS 焦点？ | 抬窗？ |
|---|---|---|---|---|
| `navigate_page` | `tools/pages.js:86-93` → `page.goto` | `Page.navigate` | 否 | 否（实验 V5-D） |
| `new_page` | `pages.js:75-87` → `context.newPage()`（`McpContext.js:81-84`，**无 bringToFront**）+ `goto` | `Target.createTarget` + `Page.navigate` | 否 | **是**（Chrome 端激活新 tab 即抬窗，实验 V5-A/V8-I——即使 MCP 层不调 bringToFront） |
| `select_page` | `pages.js:33-41` → `page.bringToFront()` | `Page.bringToFront` | — | **是**（实验 V5-C） |
| `click` | `tools/input.js:23-35` → `handle.asLocator().click()` | puppeteer `ElementHandle.click`（`puppeteer-core .../api/ElementHandle.js:715-719`：`scrollIntoViewIfNeeded` + `page.mouse.click`）→ **CDP `Input.dispatchMouseEvent`**（协议级合成 trusted 事件） | **否**（实验 V6：窗口在后、OS frontmost 是 Finder，事件照常入页，且把页内 `document.hasFocus()` 翻成 true） | 否 |
| `fill` / `fill_form` | `input.js:64-78` → `locator.fill` | `Runtime.evaluate` 设值 + 派发 input/change + `Input.insertText` | 否 | 否 |
| `hover`/`drag` | `input.js:41-58/:80-...` → `mouse.move` / `Input.dispatchMouseEvent` 序列 | 同上 | 否 | 否 |
| `take_snapshot` | `snapshot.js`（`McpContext` 全页 DOM 快照） | `DOM.*`/`Runtime.evaluate` | 否 | 否 |
| `evaluate_script` | `script.js` | `Runtime.evaluate` | 否 | 否 |
| `take_screenshot` | `screenshot.js` → `page.screenshot` | `Page.captureScreenshot` | 否（**后台 tab 亦可**，实验 V6-F4：hidden tab 出图 54460 字节） | 否 |
| `pdf` | `Page.printToPDF` | 否 | 否 |  |

**结论**：lasso browse 全部操作（除潜在 new_page）都是协议注入，不要求窗口拥有 OS 焦点、不把窗口带到前台。**「用户切屏后使用」不阻断、不打扰——已实测**（V5-D、V6）。风险只在：新开 tab 默认档、以及任何未来引入 `select_page` 的调用。

### 3.2 纯静默路线（对需求③的直接回答）

可行组合（macOS 实测支撑）：
1. **launch-chrome 加 `--silent-launch`**（V3/V4）：无窗口、零焦点抢占、CDP/navigate/screenshot 全通。
2. **开 tab 一律 `Target.createTarget {background:true}`**（V5-E/V8-G）：不抢焦点；headless spec 路径（puppeteer.launch）天然无此问题。
3. **永不调 `select_page` / `activate`**（现状已满足，需加 INV 守）。
4. **launch-chrome args 补 anti-throttle 三 flag**（见 §4）。

**代价（如实写明）**：
- background tab `document.visibilityState = "hidden"`、初始 `hasFocus=false`（V6-F1 实测）——**反爬可见**（CreepJS 类指纹可读；lasso StealthEngine 注入在页面 JS 域，改不了浏览器上报的 visibility）。对登录态站点做「默默操作」时，部分站点对 hidden 页降级（懒加载不触发、部分轮询暂停）。
- CDP 点击后 `hasFocus` 翻 true（V6-F2）——比 OS 抢焦点轻得多，但页面可感知焦点跃迁。
- 无窗口 target 的 `captureScreenshot` 依赖合成器离屏输出（实测可用），个别页面/WebGL 场景需 `Emulation.setDeviceMetricsOverride` 兜底（V4-H2 实测有效）。

---

## 4. 后台 tab 节流风险

### 4.1 上游启动参数：launch 路径有、connect 路径无

- chrome-devtools-mcp@0.3.0 `build/src/browser.js:57-80`：`launch()` 的 args 只有 `--hide-crash-restore-bubble`（+ custom-devtools-frontend），**自身不带任何 anti-throttling flag**；但它走 `puppeteer.launch`，而 **puppeteer-core@24.22.3 的 defaultArgs 恒带三件套**：`--disable-background-timer-throttling`（`ChromeLauncher.js:150`）、`--disable-backgrounding-occluded-windows`（:151）、`--disable-renderer-backgrounding`（:163）——**headless spec（`--headless --isolated` → launch 路径）自动获得**。
- **connect 路径（logged_in spec `--browser-url`，`browser.js:27-39` `puppeteer.connect`）零 flag 注入能力**——连到的 Chrome 是谁起的就听谁的。lasso `launch-chrome.ts:245-250` **没带这三 flag**，故 logged_in 复用的 Chrome 的后台 tab 处于默认节流策略。
- headless vs headed 差异：headless 无窗口/无 occlusion 概念 + puppeteer flags 双保险，基本无节流；headed 靠 flags，缺了就被 Chromium 默认策略接管。
- 上游 master 前沿：`launch()` 新增 `chromeArgs`/`ignoreDefaultChromeArgs` 透传（master `src/browser.ts` McpLaunchOptions），方向一致——但 connect 路径依旧无注入点，**flag 必须由 lasso launch-chrome 自己加**。

### 4.2 节流实测（launched Chrome，缺 flag 现状）

**V7**（9223 headed Chrome，`Target.createTarget {background:true}` 建 hidden tab）：200ms `setInterval` 计 5 秒——后台 tab **5 ticks**（预期 ~25，即被节流到 ~1s 档）vs 激活后同页 **26 ticks**、`visibilityState` hidden→visible。**节流由 visibility 驱动**，`--disable-background-timer-throttling` 正是针对 hidden 页 timer 的开关——launched Chrome 补此三 flag 后该风险消除（同 flag 即 puppeteer launch 路径的既有行为，无新发明）。

对 lasso 的具体影响面：`ExpectPoll.ts`（wait_for 轮询走 CDP `Runtime.evaluate`，**不受页内 timer 节流**——evaluate 由 DevTools 会话直接调度）；受影响的是**页面自身**的 JS 驱动逻辑（懒加载、前端轮询、SPA 路由动画），会让 hidden tab 上的操作「页面侧慢半拍」。结论：flag 该补，但不是 P0 阻塞。

---

## 5. desktop 通道 cgEvent 档与「静默」的边界

`src/desktop/CGEventProvider.ts`（parse5 §3.5.3 + §3.5.5 + INV-28）：
- 实现经 rust-helper 的 core-graphics CGEvent FFI（`rust-helper/src/cgevent.rs`，`CGEventCreate` + `CGEventPost`），**注入的是系统 HID 事件队列的真实键鼠事件**——事件落点 = 当前 OS 焦点窗口，与用户物理输入同队列、不可区分。
- 档位语义（`CGEventProvider.ts:58-63` 注释 + normalizeForCgevent :117-）：**仅 `press` / `hotkey`** 两动作，其余动作不支持→链继续到 screenshotVlm。
- **边界（如实写明）**：cgEvent 是 OS 级真实键鼠，执行瞬间必然占用用户的键盘/鼠标焦点——**这一档在设计上就不可能静默**。任何「后台静默操作」的需求都只能由 browse 通道（§3 CDP 协议注入）满足；desktop 四档中可静默的只有纯读档（AXAPI 读取 / screencast 截屏），AppleScript 档（`AppleScriptProvider.ts`，activate 应用类指令）与 AX 写档（`AXSetValue`）同样会改前台应用/焦点，不可静默。产品语义上应把 cgEvent/AX 写/AppleScript activate 归为「显式授权的模拟人手操作」，与「静默浏览」分为两类的用户预期管理。

---

## 6. 修复方向摘要（供后续 parse 落地，本次未实施）

1. **①用完即关**：新增台账 Chrome idle reaper（复用 chrome-stop 的归属验证原语 + browse 调用 touch）；新键 `LASSO_LAUNCHED_CHROME_IDLE_MS`（默认如 5min，0=禁用）走 config.ts 既有模式（§2.2，成本 4 处小改）；与既有 `LASSO_HEADLESS_IDLE_MS`（MCP spec 用）**分开两个键**，语义不同勿混。
2. **②隐藏 spawn**：macOS 默认加 `--silent-launch`（实测 V3/V4 零打扰）+ 降级链（离屏 window-position → AppleScript hide）；Windows 加 `--start-minimized` + PowerShell `Start-Process -WindowStyle Minimized`（无可真机，走代码审查 + CI shape 验证，同 launch-chrome.ts:25-27 既有 #W7 pending 范式）；同时补 anti-throttle 三 flag（§4.1）。
3. **③纯静默守卫**：INV 化「lasso 永不调 select_page / activate / 前台 createTarget」；新开 tab 统一 `background:true`；文档写明 hidden-tab visibility 的反爬代价。
4. 旧用户 config.json 不覆盖（config.ts:215-219）→ KEY-GUIDE/README 需列新键。

## 7. 本次验证记录

- 门禁：`npm run build` ✓（tsc 零错）；`npm test` ✓ 107 files / 1768 passed + 1 skipped；`npm run check-invariants` ✓ All 77 passed（INV-77 (c)(d)(e) 直接覆盖本审计域）。
- 实验环境清理：9223 经 `chrome-stop --all` killed；9224/9225 kill；三个 /tmp profile 已删；残留 `remote-debugging-port=922[345]` 进程数 = 0。
- 上游源码：npm tarball 实抽（chrome-devtools-mcp@0.3.0 + puppeteer-core@24.22.3），非 GitHub 快照——与 lasso `LOCKED_CDP_MCP_VERSION`（SubprocessManager.ts:38）严格同版。
