# parse18 — 隐藏/最小化/后台浏览器启动方案真机实验（macOS 12）

> 实验员报告。环境：**macOS 12.7.6 (21H1320) Intel + Chrome 150.0.7871.182**，本机真跑，非纸面推断。
> 实验窗口期用户前台应用为 VS Code（Code），是焦点抢占检测的天然基线。
> 纪律：全部实验 Chrome 使用 `/tmp/lasso-exp/profile-*` 隔离 profile + 独立端口 9333-9336；用户日常 Chrome（PID 586，占用 9222）与并行审计 agent 的 `/tmp/lasso-audit-*` Chrome（9223）全程未触碰。实验后全部清理（进程 0 残留、端口释放、profile 删除）。
> 检测手段：System Events AppleScript 探针（frontmost 进程 / per-PID `visible` / 窗口数量与几何 / AXMinimized）+ `curl /json/version` CDP 探活 + Node 24 原生 WebSocket 直连 CDP。

---

## TL;DR 结论矩阵

| 方案 | 窗口出现 | 抢焦点 | CDP 可用 | verdict |
|---|---|---|---|---|
| E1 直 spawn（lasso 现状基线） | ✅ 是 | ✅ **抢**（Code→Chrome） | ✅ | 现状： disruptive |
| E2 `open -g -na` | ✅ 是 | ✅ **仍抢** | ✅ | ❌ 无效 |
| E3 `open -gj -na`（带 URL） | ✅ 是 | ✅ **仍抢** | ✅ | ❌ 无效 |
| E4 `open -gj -na`（不带 URL） | ✅ 是（NTP） | ✅ **仍抢** | ✅ | ❌ 无效 |
| E5 `--window-position=32000,32000` | 窗口移出屏（clamp 到 x=24069） | ✅ **仍抢**（菜单栏切 Chrome） | ✅ | ⚠️ 半吊子 |
| E6 `--start-minimized` | ✅ 可见窗口 | ✅ **仍抢** | ✅ | ❌ macOS 上 no-op（win-only 语义） |
| E7 `--no-startup-window` | ❌ 无窗口 | ❌ **不抢**（frontmost 保持 Code） | ✅ | ✅ **启动级静默** |
| E7+ `HTTP PUT /json/new` 开 tab | ✅ 窗口出现 | ✅ 抢（且会 unhide） | — | ❌ 开 tab 路径必须换 |
| E8 spawn 后 osascript 按名 hide | 隐藏 | — | ✅ | ⚠️ **危险**：按名 hide 波及所有同名 Chrome 实例（实测把用户 Chrome 也隐藏了） |
| E8' osascript **按 unix id** hide | 隐藏（保窗口） | ❌ 不抢 | ✅ | ✅ **PID 定向 hide 可行**（需 Accessibility TCC，本机已验证） |
| 隐藏态 + `Target.createTarget {background:true}` | ❌ 无前台窗口 | ❌ **不抢**（两次复测） | ✅ 页面完全可用 | ✅✅ **tab 级静默的钥匙** |
| 隐藏态 + `Target.createTarget {background:false}` | ✅ unhide+窗口 | ✅ 抢 | — | 默认值即激活，勿用 |
| 隐藏态 + navigate/evaluate/Input click/screenshot | — | ❌ **全程不抢** | ✅ 6 命令全过 | ✅ DOM/CDP 级操作零打扰 |

**macOS 获胜组合**：`--no-startup-window`（启动无窗口无焦点）+ 需要开 tab 时走 **WS `Target.createTarget {background:true}`**（绝不走 HTTP `/json/new`）+ 保险丝 **按 unix id 的 osascript hide**（覆盖 CDP 序列中途 unhide 的边角）+ 反节流 flags 三件套。

---

## 1. 候选方案实验明细

### E1 基线：直 spawn（lasso launch-chrome 现状）

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 --user-data-dir=/tmp/lasso-exp/profile-e1 about:blank &
```

- 窗口：出现（pos≈224,47 size 1200x769）
- 焦点：**Code → Google Chrome**（frontmost 被夺）
- CDP：`/json/version` 正常，Protocol 1.3
- 资源：主进程 RSS ≈ 147-149 MB，全实例 9 进程，冷启动 %CPU ≈ 15
- verdict：即用户抱怨的现状——可见 + 抢焦点。

### E2 `open -g -na "Google Chrome" --args ...`

- `open -g`（"不带到前台"）**无效**：Chrome 在创建首窗口时自行调用 activate，front仍变成 Google Chrome，窗口可见。
- CDP 正常，RSS 149 MB。
- verdict：❌。`-g` 只约束 LaunchServices 的激活语义，管不住 App 自己的 `activateIgnoringOtherApps`。

### E3 `open -gj -na ... --args ... about:blank`（-j 隐藏启动）

- 假设"URL 参数触发 LaunchServices 激活"——被证伪：窗口可见、焦点照抢。
- verdict：❌。

### E4 `open -gj -na ...`（不带 URL 参数）

- 干净变量复测：Chrome 无 URL 启动仍开 NTP 窗口并激活。
- CDP `/json/list` 可见 `chrome://newtab/` 及扩展 background_page/service_worker。
- verdict：❌。Chrome 150 在 macOS 上首窗口必自激活，`open` 的 -g/-j 对它无约束力。

### E5 `--window-position=32000,32000`（直 spawn）

- macOS 将位置 clamp 到 x=24069（超出 2560 宽主屏），窗口实际不可见；
- 但 **frontmost 仍变为 Google Chrome**——窗口看不见 ≠ 不打扰：菜单栏切到 Chrome、键盘输入落入 Chrome。
- verdict：⚠️ 只解决"看得见"，不解决"抢焦点"。可与其它手段叠加，单独不合格。

### E6 `--start-minimized`

- macOS 上 **no-op**：`win1-min=false`（AXMinimized=false）、窗口可见、焦点照抢。该 flag 是 Windows 语义（对应 SW_MINIMIZE），macOS Chromium 未实现。
- verdict：❌（macOS）。Windows 侧可编译可用（见 §5 适配）。

### E7 `--no-startup-window` ★ 本轮最大发现

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 --user-data-dir=... --no-first-run \
  --no-default-browser-check --no-startup-window &
```

- 启动后：**窗口数 0，frontmost 保持 Code（不抢焦点）**。
- CDP 完全可用：`/json/version` OK；`/json/list` 只有扩展 background_page/service_worker，无 page。
- 用户视角：Dock 里多一个 Chrome 图标（无窗口、无前台切换）。
- 随后用 `HTTP PUT /json/new?about:blank` 开 tab → **窗口出现 + 焦点被夺**（frontmost→Chrome）。
- 随后改用 WS `Target.createTarget {background:true}` → 见 §3。
- verdict：✅ 启动级静默的唯一 flag 级手段；但 tab 创建路径必须换（§3）。

### E8 osascript hide

**(a) 按进程名 hide —— 危险，已实测事故**：

```
osascript -e 'tell application "System Events" to set visible of process "Google Chrome" to false'
```

- System Events 按名解析只命中**一个**进程——实测命中的是**用户的日常 Chrome（PID 586）**，把它从 visible=true 隐藏了（实验 Chrome 反而没隐）。已立即恢复。
- 教训（直接进实现红线）：多 Chrome 实例同名，**hide 必须按 unix id 定向**。

**(b) 按 unix id 定向 hide —— 可行**：

```applescript
tell application "System Events"
  repeat with p in (application processes whose name is "Google Chrome")
    if unix id of p is <PID> then set visible of p to false
  end repeat
end tell
```

- 实验进程 visible=false（窗口保留在 Dock/隐藏态），用户 Chrome 不受影响，frontmost 保持。
- TCC：本机 Accessibility 已授权（vis.sh 全程可用）。无授权时 System Events 报 -1743，需降级路径（§5）。
- 边角：隐藏态下后续 `/json/new` 或 `background:false` 建tab会 **unhide + 抢焦点**（实测两次）；`background:true` 建tab后 app `visible` 也可能翻回 true（但无窗口激活、不夺 frontmost）——所以 hide 是"保险丝"而非"一次性设置"，长会话需在关键节点复验/复隐。

### E-对比：headless（现状另一档）

- 已由 lasso 现网使用（本机并存一个 puppeteer headless 实例，`--headless=new`，System Events `visible=false windows=0`）。
- 静默性满分，但无 GUI tab 语义（用户需求 ②③ 要"有窗口但不打扰"，headless 是"没有窗口"）。
- 注意：puppeteer 默认 flags 里同样带 `--disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding`——见 §2，这不是巧合。

---

## 2. 后台不节流 flags 量化（隐藏态对比实验）

方法：`--no-startup-window` + 按PID hide 起两组实例；WS `createTarget{background:true}` 开 about:blank；注入 JS 基准：20×100ms setInterval 漂移 / 2e8 次 sqrt 长任务 / rAF 计数 5 秒；5s 后取结果。每组重复 2 次。

| 指标 | 隐藏 + 无反节流 flags（t1, 9334） | 隐藏 + 三件套 flags（t2, 9335） |
|---|---|---|
| 20×100ms 定时器 | run1: 2801ms（+40%）；run2: **5s 内跑不完**（≥1s/tick 钳制） | run1: 2701ms（+35%）；run2: 2803ms（+40%） |
| rAF 帧数（5s） | run1: 300（60fps，尚未被判定遮挡）；run2: **1（完全停止）** | 300 / 301（稳定 60fps） |
| 2e8 sqrt 长任务 | 907 / 923 ms | 888 / 949 ms |
| visibilityState | visible（注意：**不反映遮挡**） | visible |

结论：

1. **节流真实且不稳定**：无 flags 时遮挡判定有延迟（首跑 rAF 300、次跑 rAF 1）——一旦 Chromium 遮挡/后台启发式生效，**rAF 完全停止、定时器钳到 ≥1s/tick**。做轮询/动画/长驻页面任务的 agent 后台 tab 必然被咬。
2. **三件套 flags 消除最坏情况**：`--disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding` 使 rAF 恒 60fps、定时器只有 ~35-40% 的合并开销（本机同时跑实验的固有噪声，两组同量级）。Playwright `chromiumSwitches` 的 "Background suppression" 类默认正是同一组（zread 佐证）。
3. **纯计算不被节流**（~900ms 恒定）——被节流的是调度（timer/rAF），不是 CPU。
4. 长时程警告（文档佐证，未做 5min+ 实验）：Chrome 88+ 对 hidden>5min（M109+ 缩至 10s）的 chained timer 施行 **intensive throttling = 1次唤醒/分钟**。lasso 的"用完即关（idle 即杀）"恰好把生命周期压到该阈值之前，是天然解。

---

## 3. 已有浏览器/新 tab 静默操作（焦点矩阵）

隐藏态 Chrome（--no-startup-window 实例）上逐操作探焦点（frontmost 探针在每步后立即采样）：

| 操作 | 结果 |
|---|---|
| `HTTP PUT /json/new?url` | 窗口出现 + **unhide + 抢焦点** ❌ |
| WS `Target.createTarget {background:false}`（默认） | unhide + 窗口出现 + **抢焦点** ❌ |
| WS `Target.createTarget {background:true}` | **无窗口激活、frontmost 不变**（两次复测）✅ |
| `Page.navigate` → `Runtime.evaluate` → `Input.dispatchMouseEvent`(press+release) → `Page.captureScreenshot`(255KB b64) → `Emulation.setDeviceMetricsOverride` | **6/6 全过，frontmost 全程不是 Chrome** ✅ |
| 合成点击有效性 | example.com 上 (80,180) 的 synthetic click 真实触发了 "More information…" 链接 → 窗口标题变为 IANA 页面。**CDP Input 事件不需要窗口焦点**（与 chromium#40871660 的社区共识一致：dispatch 合成事件走 renderer 管线，不经过 NSWindow key 状态） |

**回答用户问题 ③**：新浏览器开在首屏、用户切屏后使用——项目操作**不阻断用户**的前置条件是两条：
1. tab 创建走 `Target.createTarget{background:true}`（chrome-devtools-mcp 需确认其 newPage 路径是否传 background；其 `new_page`/`select_page(bringToFront:false)` 行为要单独审计）；
2. 绝不调用 `Page.bringToFront`（Puppeteer 的 `page.screenshot()` 老版本内部会 bringToFront——chrome-devtools-mcp issue #1254 报告的"每条 CDP 命令都抢焦点"极可能就是这类隐式 bringToFront/激活路径，我的实验证明裸 CDP evaluate/dispatch/captureScreenshot 本身不抢）。

**能否纯静默**：能。证据链 = E7（启动零打扰）+ bg:true 建tab（零打扰）+ 6 命令探针（零打扰）+ PID 定向 hide 保险丝。残留的用户可感知信号：Dock 多一个运行图标、活动监视器进程、网络/CPU 波动——OS 级不可消除（除 headless 外，headless 连 Dock 图标都没有）。

**"用已有浏览器新开 tab 不影响用户"**：同样成立——只要 (a) 用 `Target.createTarget{background:true}`（对已开浏览器 9222 同样适用，`background` 是 target 级参数）；(b) 不 bringToFront。风险差异：已有浏览器是用户资产，tab 若被用户手动点到会看到 agent 页面；且 chrome-devtools-mcp 的 select_page 等工具若隐式激活会破坏承诺——所以 lasso 的 browse_logged_in 档（复用用户 Chrome）应审计并 patched 掉所有激活路径，或默认对已有浏览器只做只读+bg:true。

---

## 4. 开源佐证

- **chrome-devtools-mcp issue #1254**（2026-03，macOS Sonoma，--autoConnect）：*"Chrome steals window focus on every CDP command"*，报告 take_screenshot/list_pages/select_page 都抢焦点；尝试过 bringToFront:false、独立 Space、PostToolUse osascript 回焦（闪烁更糟）均失败；根因指向 Chromium 级激活（关联 chromium#223828 chromedriver 抢焦点 10+ 年、#40770130、#40182355）；社区提议的修复正是 **给 Target.createTarget 加 background:true**、加 --no-activate 服务端 flag。→ 与我的实测互证：抢焦点来自特定激活类命令，不是 CDP 通信本身。
- **Playwright**（zread）：`chromiumSwitches.ts` 的 "Background suppression" 组 = `--disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows`，把 stock Chromium 变成确定性自动化目标——即 §2 三件套的产业标准版本。Playwright 默认 headless（`--headless` 是显式 opt-in 的反义：headed by default in CLI, headless in library），不提供"隐藏 headed"一档，社区做法即 window-position + OS 级 hide。
- **Chromium 官方 AppleScript 支持**（chromium.org/developers/design-docs/applescript）：Chrome 窗口暴露 `bounds`/`miniaturized`/`visible` 可脚本属性——`tell application "Google Chrome" to set miniaturized of window 1 to true` 是免 TCC 的替代路径（app 自身 AppleScript 不需要 Accessibility 权限；但需注意它同样按 app 寻址，多实例需 `tell application id`+实例区分，实测复杂度高于 System Events 按 PID）。
- **Chromium 节流文档**：developer.chrome.com/blog/timer-throttling-in-chrome-88（intensive throttling 条件链：hidden>5min + 静默30s + chained≥5 → 1 wakeup/min）；blink-dev "Quick intensive throttling"（M109 起 hidden 阈值 10s）；chromium#40871660（occluded window 冻结语义、CDP 不冻结于 backgrounded-but-not-occluded）。
- **社区共识**（SO/MacScripter/HN）：macOS 无系统级防抢焦点；headless / off-screen window-position / osascript hide 三招是事实标准组合。HN 2025 "Ask HN: Why does macOS still lack focus stealing prevention" 确认平台现状。

---

## 5. 对 lasso 的落地建议（含 Windows 适配）

### macOS 推荐链（按优先级）

1. **launch-chrome.ts 增加 `--no-startup-window`**（静默档默认）+ 三件套反节流 flags + `--mute-audio`。首 tab 由 lasso 自己经 WS `Target.createTarget{background:true}` 创建——**当前经 chrome-devtools-mcp 的开页路径需审计其 newPage 是否 background:true，不是则由 lasso 预建好 tab 再交给 chrome-devtools-mcp attach**。
2. **保险丝**：spawn 后 1-2s 及每次会话恢复时执行按 unix id 的 osascript hide（System Events）；TCC 无授权时报错降级（不 fail，记录 doctor 项）。
3. **idle 用完即关**：为 launched Chrome 建 per-instance watchdog（复用 SubprocessManager idle 思路），idle 阈值从 `~/.lasso/config.json` 读（如 `chromeIdleMs`，默认 5min，可配 0=禁用）——满足需求 ①"用完即关不等 5 分钟"（把默认调小或由调用方显式传短 idle）同时保留用户配置权。
4. 禁用清单：`open -g`/`-gj`（无效）、`--start-minimized`（macOS no-op）、按进程名 hide（事故级）。

### Windows 适配（代码审查级，不可真机）

- `--start-minimized` 在 Windows 是真语义（最小化启动），静默档可直接用；
- `--no-startup-window` 同为跨平台 Chromium flag（Windows 亦可，需 CI 冒烟验证）；
- hide 等价物：PowerShell `(New-Object -ComObject Shell.Application).MinimizeAll()` 不行（波及全局）；正确做法 `SW_MINIMIZE` via user32 ShowWindow(hwnd, 6) 或 `(Get-Process -Id $pid).MainWindowHandle` + ShowWindow——按窗口句柄即天然 PID 定向，无 TCC 概念。
- `Target.createTarget{background:true}` 与 flags 均跨平台一致。

### 需要后续审计的 lasso 点

- chrome-devtools-mcp 的 `new_page` / `select_page` / `take_screenshot` 内部是否隐式 bringToFront（对照 issue #1254）；
- config.ts writeConfigTemplate 是否已写 `LASSO_HEADLESS_IDLE_MS` / 新增 `chromeIdleMs` + `chromeHidden` 开关；
- chrome-stop 台账挂 per-instance idle watchdog 的接线点。

---

## 6. 实验资产

探针与基准脚本：`/tmp/lasso-exp/{vis.sh, probe1.sh, bench.mjs, ws-test2.mjs, matrix2.mjs, cmdprobe.mjs}`（本轮会话后 /tmp 即失效，关键片段已内联上文）。实验 Chrome 全部清理：进程 0 残留、9333-9336 端口全部释放、隔离 profile 已删除；用户日常 Chrome（9222）与并行审计 Chrome（9223）未受影响（中途一次按名 hide 误伤用户 Chrome，已当场恢复并写入红线）。

## 引用

- [chrome-devtools-mcp #1254 — macOS: Chrome steals window focus on every CDP command](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1254)
- [Heavy throttling of chained JS timers beginning in Chrome 88](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
- [chromium#40128284 — Throttle JS timers to 1 wake up per minute in background](https://issues.chromium.org/40128284)
- [chromium#40871660 — CDP frozen in minimized/occluded windows](https://issues.chromium.org/issues/40871660)
- [Quick intensive timer throttling (blink-dev)](https://groups.google.com/a/chromium.org/g/blink-dev/c/5SZB2CFFGqE)
- [Chromium AppleScript design docs](https://www.chromium.org/developers/design-docs/applescript/)
- [Playwright — Chromium Server Implementation (chromiumSwitches)](https://zread.ai/microsoft/playwright/12-chromium-server-implementation)
- [Ask HN: Why does macOS still lack focus stealing prevention](https://news.ycombinator.com/item?id=46547927)
