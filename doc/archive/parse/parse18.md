# parse18 — launched Chrome「用完即关 + 隐藏不打扰 + 纯静默 browse」v1.10 设计

> **作者**：Lasso v1.10 设计师
> **日期**：2026-08-15
> **性质**：v1.10.0 实施设计（机制修复 + 新配置面，非 spike）。基于三份调研：
> `parse18-rca-whitebox.md`（白盒审计：launch-chrome 全链路 / config 链路 / 上游 CDP 命令焦点映射，实验 V1-V8）、`parse18-oss-experiments.md`（macOS 12 真机 14 轮实验，E1-E8 矩阵 + 节流量化）、`parse18-frontier.md`（chrome-devtools-mcp 上游动向 + #1254 + headless 语义 + 反爬 trade-off）。
> **基线**：lasso-mcp v1.9.0（1768 TS tests + 77 INV 全绿；rust-helper 179 Rust tests 不动）。
> **用户需求映射**：
> ① 新开浏览器**用完即关**（不等 5min；5min idle 配置保留给用户且必须在 `~/.lasso/config.json` 可配）→ **机制一**（台账 Chrome idle reaper，新键 `LASSO_LAUNCH_IDLE_MS` 默认 **60s**）；
> ② 新开浏览器默认**隐藏/最小化**（macOS 重点 + Windows 适配）→ **机制二**（`LASSO_LAUNCH_MODE=hidden` 默认，macOS `--no-startup-window` 实验裁决获胜链 + Windows flag 适配）；
> ③ 调研回答（首屏新浏览器 + 用户切屏后操作是否阻断；能否纯静默；已有浏览器新 tab 默默操作）→ **机制三**（background tab 预建 + 激活类命令 INV 禁令）+ §5 诚实边界；
> ④ 深入白盒调研 → 三份调研文档本身（本设计只引用结论，不重复论证）。
> **立场红线**：只杀台账在案且 cmdline 验证归属的 pid（复用 chrome-stop 原语，零新 kill 路径）；**绝不按进程名 hide**（E8 实测事故级）；desktop cgEvent 档不假装能静默；v1.9.0 零回归（INV-1..77 全保 + 基线测试不减）。

---

## 0. TL;DR（5 句裁决）

1. **机制一（用完即关）**：新文件 `src/launcher/chrome-idle-reaper.ts`——15s 周期读磁盘台账，`now - max(launchedAt, touch) > idleMs` 即调**既有** `stopLaunchedChromes({port})`（归属验证/树杀/删账全部复用 chrome-stop.ts，零新 kill 原语）。新键 `LASSO_LAUNCH_IDLE_MS` **默认 60_000**（裁决理由 §2.2），0=禁用；活动源 = LoggedInChannel 每次 browse 经注入回调 `touch(port)`。**只活在 server 进程**——CLI 单独 launch-chrome 无 reaper，chrome-stop 仍是显式出口（诚实边界 §5.1）。
2. **机制二（隐藏启动）**：`launch-chrome.ts` args 构造按 `LASSO_LAUNCH_MODE`（默认 **hidden**）分档：hidden = `--no-startup-window`（E7 实验唯一启动级零打扰 flag）+ 反节流三件套 + `--mute-audio`（Windows 追加 `--start-minimized`）；fallback 链 = 运行时探测 `chrome_exited` → 离屏 `--window-position=-32000,-32000` 重试 → 按 **unix id** 定向 osascript hide 保险丝（TCC 无授权降级不 fail）。visible = v1.9 现状原样。
3. **机制三（纯静默 tab）**：`CdpClient` 新增 `createBackgroundTarget(url)`（WS `Target.createTarget {background:true}`——E7 矩阵实证 tab 级零打扰唯一钥匙）；LoggedInChannel 附着时若 `/json/list` 零 page target 则预建一个，**绕开 chrome-devtools-mcp 0.3.0 new_page 的默认激活路径**（上游 background 参数是 v0.14.0 才有，锁定版没有——必须 lasso 自己建）。INV-78d 禁 `select_page`/`bringToFront`/`PUT /json/new` 三条激活路径。
4. **诚实边界（§5）**：desktop cgEvent = OS 级真实键鼠**设计上不可静默**；用户自己起的 Chrome（未带 lasso flags）无法注入反节流/防激活参数（connect 路径零注入能力，白盒 §4.1）；后台 tab `visibilityState=hidden` 反爬可见；headless 的 5min 默认**不改**（11s 冷启动 + 无窗口不打扰，改了纯亏）。
5. **配套**：INV-78（6 组断言）+ ~30 条新测试 + config 模板补 2 键 + KEY-GUIDE/README 文档 + 版本 **1.10.0**（新配置面 + 默认行为变化，非 patch）。每阶段真实跑 `npm run build && npm test && npm run check-invariants`（1768→~1798 tests，77→78 INV）。

---

## 1. 需求缺口矩阵与范围红线

### 1.1 白盒缺口 → 本设计落点

| 缺口（白盒审计锚点） | 严重度 | 落点 | 状态 |
|---|---|---|---|
| 台账 Chrome 永不自动关（idle watchdog 只遍历 `this.procs`，SubprocessManager.ts:212-238 与磁盘台账零交集） | 核心 | 机制一（chrome-idle-reaper） | 修复 |
| spawn 即抢焦点（launch-chrome.ts:245-250 无任何隐藏档；V1 实测 Finder→Chrome） | 核心 | 机制二（launchMode 分档） | 修复 |
| launched Chrome 缺反节流三 flag（V7 实测 200ms interval 被钳到 1s 档） | 高 | 机制二（args 恒带三件套，两档都加） | 修复 |
| tab 创建默认档激活（`Target.createTarget` 默认 / `PUT /json/new` 均抢焦点，V5-A/V8-I） | 高 | 机制三（background:true 预建 + INV-78d 禁令） | 修复 |
| `select_page`→`bringToFront` 激活路径（lasso 现状零调用，但无守护） | 中 | INV-78d（grep 禁令机械化） | 加守 |
| config 模板无 `LASSO_LAUNCH_MODE`/`LASSO_LAUNCH_IDLE_MS`（模板已有 `LASSO_HEADLESS_IDLE_MS: 300000`，config.ts:197） | 中 | §2.4/§3.4 config 补键 | 修复 |
| 复用用户可见 Chrome 时 macOS CDP 抢焦点（上游 #1254，Chromium 10 年 bug） | 平台级 | §5.2 诚实边界（不可修，文档化） | 边界 |
| desktop cgEvent 占用物理输入（CGEventProvider.ts，INV-28） | 语义级 | §5.1 诚实边界（档位语义，非缺陷） | 边界 |

### 1.2 不做的事（范围红线）

- **不改 chrome-devtools-mcp 上游**（`LOCKED_CDP_MCP_VERSION="0.3.0"` 锁定；上游 v0.14.0 的 `new_page background` 参数不在锁定版里——所以 background tab 由 lasso 自己经 CdpClient 建，不是升级上游）。
- **不给 launch-chrome 加「任务会话绑定」语义**（裁决 §2.2：idle 阈值足够；会话绑定需要显式 begin/end 协议，调用方（CC）没有稳定的「任务结束」信号，硬做必产生泄漏或误杀）。
- **不做 headless 第三档**：`LASSO_LAUNCH_MODE` 只有 `hidden|visible` 两档。headless 抓取已由 browse_headless 通道（puppeteer launch 路径，天然反节流 flag + 无窗口）承担；launch-chrome 的存在理由是「headed 登录态」（frontier §5 建议矩阵的 hidden headed 档）。headless 化 launch-chrome = 与 browse_headless 重复造档。
- **不做 CLI 独立 watchdog 进程**（launch-chrome CLI spawn 后 `process.exit()`，补一个 detached 看护进程是第二套生命周期调度，违反「不开第二套」惯例；CLI 场景 chrome-stop 显式收尾足够）。
- **不动 rust-helper / desktop 通道**（cgEvent 档语义保留为「显式授权的模拟人手操作」，frontier §3 同结论）。
- **不覆盖用户旧 config.json**（writeConfigTemplate 存在即不写，config.ts:215-219）——新键靠 KEY-GUIDE/README 提示手补，这是既有 v1.3 范式的延续。

---

## 2. 机制一：台账 Chrome idle 用完即关

### 2.1 设计原理：第二消费者，不是第二套调度

白盒 §1.4 实证：launched Chrome（detached + unref）与 SubprocessManager 的 `procs` map 零交集，zombie reaper 结构性看不见它。两条路可选：

- (a) 把台账 Chrome 塞进 `procs` —— 错误：procs 的语义是「MCP 子进程（shim→node 树），SDK client 可 close」；台账 Chrome 是 detached 独立进程，没有 McpClient，硬塞要把 chrome-stop 的 ps 归属验证逻辑搬进 `_kill`，污染单一语义。
- (b) **新 reaper 消费既有原语**（本设计）：`chrome-idle-reaper.ts` 只做三件事——读台账（`readLedgerSync`）、判 idle、调 `stopLaunchedChromes({port})`。kill 路径 100% 复用 chrome-stop.ts（探活→ps 归属验证→SIGTERM 2s→树杀→删账），**零新 kill 原语、零第二份 pgrep 递归**。

与 zombie reaper 的关系是「两个数据域、两个调度器、一个致死原语族」：zombie reaper 管 `procs`（MCP 树），chrome reaper 管 ledger（detached Chrome）；两者都最终走 `util/kill-tree.ts` / chrome-stop 的验证杀。INV-78c 守这个分工。

### 2.2 默认值裁决：`LASSO_LAUNCH_IDLE_MS = 60_000`

「用完即关」语义的候选谱：30s / 60s / 90-120s / 会话绑定。裁决 **60s**，依据：

1. **调用间隔统计现实**：browse 会话内相邻 action 间隔为秒级（导航→快照→点击链）；跨任务间隔为分钟级。60s 恰好卡在「会话内绝不误杀（最长单 action 的 ExpectPoll 轮询秒-分钟级 + touchKeepalive 每 dispatch 刷新）」与「任务结束 ~1min 内关窗」之间。
2. **重开成本不对称**：台账 Chrome 被杀后，下一次 browse_logged_in 要付 Chrome 冷启动（本机实测 ~1.5-2s）+ logged_in spec respawn（`closed` 由 transport onclose 自动置位，SubprocessManager.ts:63 注释承诺，下次 ensureRunning 重 spawn，npx 树 ~11s）。60s idle 把这个代价限制在「真有空档」时才付；30s 会在用户阅读结果、间隔 40s 的轻交互场景频繁触发 11s 重冷启。
3. **比 5min 短是用户显式要求**（「用完即关，不等 5 分钟」）；5min 作为用户可配值保留（配 300000 即回退）。
4. **reaper 周期 15s**（不是 zombie 的 60s）：关窗最坏延迟 = 60s idle + 15s 周期 = 75s，满足「用完即关」体感；读一个小 JSON 文件的 15s 定时器开销可忽略，`unref()` 不阻退出。

`LASSO_HEADLESS_IDLE_MS`（MCP spec 用）**默认保持 300_000 不动**：headless 无窗口、对用户零打扰，唯一成本是进程积留（5min 已兜住）；改短只会放大 11s 冷启动代价，无收益（frontier §5 同判断）。两个键语义不同勿混（白盒 §6.1）。

### 2.3 新文件 `src/launcher/chrome-idle-reaper.ts`

```
INV-64 合规：只 import node:* + 同目录 chrome-ledger.js / chrome-stop.js（豁免同util/kill-tree）。

export interface ChromeIdleReaperOptions {
  intervalMs?: number;              // 默认 15_000
  defaultIdleMs: number;            // config.launchIdleMs（>0 才启动）
  touchPorts?: Set<number>;         // 装配时已知的活动端口（= config.cdpPort）
  readLedgerFn?: () => LaunchedChromeRecord[];   // 测试注入（默认 readLedgerSync）
  nowFn?: () => number;                          // 测试注入（默认 Date.now）
  stopFn?: (opts: { port: number }) => Promise<unknown>;  // 测试注入（默认 stopLaunchedChromes）
  logFn?: LedgerLogFn;                           // index.ts 用 logger 包
}
export interface ChromeIdleReaper {
  touch(port: number): void;         // LoggedInChannel 注入回调打点
  stop(): void;                      // 清 interval（测试/server 停机 best-effort）
}
export function startChromeIdleReaper(opts): ChromeIdleReaper | null;
```

每 tick 逻辑（单条记录）：

```
1. rec.idleMs ?? defaultIdleMs ≤ 0 → 跳过（0=禁用；per-record 覆盖见 §2.5）
2. lastUse = max(rec.launchedAt, touchMap.get(rec.port) ?? 0)
3. now - lastUse > idleMs → await stopFn({port: rec.port})
   （stopLaunchedChromes 内部：探活 → ps --user-data-dir 归属验证 → SIGTERM → 树杀 → 删账）
4. 单条 stop 抛错 → logFn warn 继续（reaper 不因一条记录死）
```

**不预杀 logged_in MCP spec**：杀 Chrome → CDP transport onclose → `closed=true`（SubprocessManager.ts:63 既有承诺）→ 下次 ensureRunning 自然重 spawn。spec 残留的 node 进程由既有 zombie reaper 按 `LASSO_HEADLESS_IDLE_MS` 收——两 reaper 各管各域，无交叉 kill（acceptance A4 实测验证这条自愈链）。

### 2.4 config 链路改动（`src/config/config.ts`）

白盒 §2.2 实证 `loadConfigFileEnv`/合并点 key 无关，成本 = 4 处小改：

1. `CONFIG_TEMPLATE` 增两行（config.ts:197 后）：
   ```jsonc
   LASSO_LAUNCH_MODE: "hidden",
   LASSO_LAUNCH_IDLE_MS: 60000,
   ```
2. 常量 + 解析函数（仿 `parseHeadlessIdleMs` :83-88）：
   - `DEFAULT_LAUNCH_IDLE_MS = 60_000`；`parseLaunchIdleMs`：负数/NaN/未设→默认，0=禁用，无上限 clamp（用户配 300000 回退 5min 语义）。
   - `DEFAULT_LAUNCH_MODE: "hidden"`；`parseLaunchMode`：仅接受 `"hidden"|"visible"`，非法/未设→`"hidden"`（保守默认 = 用户要的不打扰）。
3. `LassoConfig` 增字段 `launchMode: "hidden" | "visible"`、`launchIdleMs: number`（:59 headlessIdleMs 旁，注释注明两键分工）。
4. `loadConfig` 出口接线（:307/:319 旁各一行）。

**5min 保留语义**：`LASSO_LAUNCH_IDLE_MS=300000` 即恢复「5min 才关」；`LASSO_HEADLESS_IDLE_MS` 独立不受影响——需求①「5min idle 配置保留给用户」由这两个键的独立性满足。

### 2.5 台账 schema 扩展（`chrome-ledger.ts`）

`LaunchedChromeRecord` 增两个**可选**字段（前向兼容，readLedgerSync 的 typeof 检查补两行）：

```ts
launchMode?: "hidden" | "visible";   // 冗余记录 spawn 档（诊断/audit 用）
idleMs?: number;                     // per-launch idle 覆盖（CLI --idle-ms 传入；undefined=用全局默认）
```

per-record 覆盖的用途：某次 launch 明确是「长会话抓取」时调用方可传 `--idle-ms 3600000` 单独放行，不污染全局默认。

### 2.6 接线（`src/index.ts` + `LoggedInChannel.ts`）

- **index.ts**（startIdleWatchdog 旁，:363-373 一带）：`config.launchIdleMs > 0` 时 `startChromeIdleReaper({ defaultIdleMs: config.launchIdleMs, logFn: (p) => logger.info(p) })`；=0 记 `chrome_idle_reaper_disabled` info（对齐 idle_watchdog_disabled 惯例）。
- **LoggedInChannel**：构造 opts 增 `onChromeUse?: () => void`（index.ts 注入 `() => reaper?.touch(config.cdpPort)`）；`getMcpClient()` 在 ensureRunning 成功路径调用（与 takeSnapshotIfAbsent 同层）。browse 每次进 channel 都过 getMcpClient——活动源与 browse 频度天然同步。
- **server 停机**：既有 `stopLaunchedChromes({all:true})`（index.ts:1176）已覆盖，reaper 只需 `stop()` 清 timer（shutdown 段一行，best-effort）。
- **CLI 路由**：`lasso launch-chrome` 增 `--mode <hidden|visible>`、`--idle-ms <N>` flag（parseLaunchChromeArgs 增两分支；默认值由 index.ts CLI 入口先 loadConfig 解析再传入 opts——config.json 文件层因此对 CLI 也生效，且 launcher 目录不 import config 模块保 INV-64）。

---

## 3. 机制二：隐藏窗口启动（launchMode 分档）

### 3.1 方案裁决（依据 E1-E8 实验矩阵 + V1-V4 白盒）

| 候选 | macOS 实测 | 裁决 |
|---|---|---|
| `open -g` / `open -gj` | 窗口出现 + 照抢焦点（E2/E3/E4） | **禁用**（INV 不需要——代码里根本不引入 `open`） |
| `--start-minimized` | macOS no-op（E6） | macOS **禁用**；Windows 保留（真语义） |
| `--window-position=32000,32000` | 窗口出屏但菜单栏/键盘焦点照抢（E5） | 仅作 fallback 链第二档 |
| **`--no-startup-window`** | 0 窗口 + frontmost 不变 + CDP 全通（E7） | **macOS/Linux primary** |
| `--silent-launch` | 同样 0 窗口零打扰（白盒 V3/V4） | 备用记录在案（同为未文档化开关，不双发） |
| osascript 按名 hide | **误伤用户日常 Chrome（E8 事故）** | **红线：永不按进程名 hide**（INV-78e） |
| osascript 按 unix id hide | PID 定向可行，需 Accessibility TCC（E8'） | **保险丝**（非一次性：激活类操作会 unhide，长会话关键节点复验） |

### 3.2 `launch-chrome.ts` args 构造改动（:244-253 一带）

```ts
// LaunchChromeOptions 增：launchMode?: "hidden" | "visible"; platform 注入已有。
const mode = opts.launchMode ?? "visible";   // 模块默认保守 visible；hidden 由 CLI/config 层传
const args = [
  `--remote-debugging-port=${port}`,
  `--no-first-run`,
  `--no-default-browser-check`,
  `--user-data-dir=${profileDir}`,
];
// 反节流三件套 + 静音：两档恒加（对齐 puppeteer-core defaultArgs 产业标准，
// ChromeLauncher.js:150/151/163；visible 档无窗口之争但后台 tab 同样受益）
args.push(
  "--disable-backgrounding-occluded-windows",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--mute-audio",           // agent 浏览器永不发声（visible 档也静音，文档明示）
);
if (mode === "hidden") {
  // 平台分档（platform 注入已有，测试可 mock win）
  args.push(platform === "win" ? "--start-minimized" : "--no-startup-window");
  if (platform === "win") args.push("--no-startup-window"); // win 同加：--start-minimized 对部分 Chrome 版本被忽略（Puppeteer#852）
}
// 用户 extraArgs 追加后**去重**（exact-string dedupe：用户显式传同 flag 不双发）
```

**fallback 链（运行时可探测，写进 launchChrome 主流程）**：hidden 档 spawn 后若 `exited && mode==="hidden"`（未来 Chrome 移除未文档化开关的形态 = 启动即退）→ 自动以 `--window-position=-32000,-32000` 替换 `--no-startup-window` 重试一次（E5：窗口出屏，接受 <1s 焦点闪现）→ 再失败按现状返 `chrome_exited`。**保险丝**：重试成功或 primary 成功后 1-2s，按 unix id 定向 osascript hide（新文件 §3.3）；TCC 无授权（System Events -1743）→ log warn 降级不 fail（doctor 可查项，P2）。

### 3.3 新文件 `src/launcher/chrome-hide.ts`（macOS 保险丝，~50 行）

```
INV-64 合规：node:child_process（osascript spawnSync）。
export function hideChromeByPid(pid: number, opts?: { execFn? }): { ok: boolean; reason?: string };
// AppleScript（E8' 实证片段，PID 定向是红线）：
//   tell application "System Events"
//     repeat with p in (application processes whose name is "Google Chrome")
//       if unix id of p is <PID> then set visible of p to false
//     end repeat
//   end tell
// 非 mac 平台 / 无 pid → no-op；osascript 非零退（含 -1743 无 TCC）→ { ok:false, reason } 不抛。
```

Windows 等价物（`--start-minimized` 失效时的两段式 `ShowWindowAsync(SW_SHOWMINNOACTIVE)+SetWindowPos(HWND_BOTTOM)`）**本版不实现**——不可真机验证（环境约束），落在 doc/TROUBLESHOOTING.md 文档级（frontier §3 的标准做法全文收录 + PowerShell 片段），沿用 launch-chrome.ts:25-27 #W7 pending 范式，CI 只验 shape（args 含 `--start-minimized`）。

### 3.4 行为变化（诚实声明）

| 维度 | v1.9.0 | v1.10.0 默认（hidden + 60s） |
|---|---|---|
| spawn 瞬间 | 窗口弹出 + 抢 OS 焦点（V1） | 0 窗口 + frontmost 不变（E7）；Dock 多一个无窗 Chrome 图标（OS 级不可消除） |
| 关闭时机 | 永不自动关（白盒 §1.4） | 最后使用后 ≤75s（60s idle + 15s 周期） |
| 后台 tab 节流 | 200ms→1s 档（V7） | rAF 60fps / 定时器仅 ~35-40% 合并开销（E-量化） |
| audible | 可能出声 | 恒静音 |
| visible 档 | — | `--mode visible` 显式回退（v1.9 行为 + 三件套/mute 附带） |
| 旧 config.json | — | 不覆盖（既有范式），未手补键的用户拿新默认 hidden/60s（默认层生效，无需手补——手补只为改值） |

---

## 4. 机制三：纯静默 tab 操作

### 4.1 白盒结论直接回答用户问题③

- **「新浏览器开在首屏、用户切屏后使用，操作是否阻断用户」**：**不阻断**——前提是 tab 创建走 background 路径。lasso browse 全部操作（navigate/click/fill/snapshot/screenshot/evaluate，BrowseChannel 调用面白盒 §3.1 全表）都是 CDP 协议注入，不需要 OS 焦点、不抬窗（V5-D/V6 及 E7 焦点矩阵 6/6 命令实测零打扰，含合成点击真实触发链接跳转）。
- **「能否纯静默」**：对 **lasso 自己 launch 的 Chrome**——能（hidden 启动 + background tab + 永不 activate；残留可感知信号只剩 Dock 图标/进程/网络波动，OS 级不可消除）。对 **复用用户可见 Chrome**——**不能完全静默**（§5.2）。
- **「已有浏览器新开 tab 默默操作」**：技术上可行（`Target.createTarget {background:true}` 是 target 级参数，对用户 9222 Chrome 同样适用，E7 矩阵两次复测零抢焦），但叠加 #1254 的平台级抢焦点风险——见 §5.2 分层结论。

### 4.2 `CdpClient.createBackgroundTarget`（`src/logged-in/CdpClient.ts`）

```ts
// v1.10（parse18 §4.2 机制三）：WS Target.createTarget {background:true} ——
// tab 级静默唯一钥匙（E7 实证：background:false/默认 与 PUT /json/new 都会 unhide+抢焦点）。
// 锁定的 chrome-devtools-mcp@0.3.0 无此参数（上游 v0.14.0 才有），必须 lasso 自建。
async createBackgroundTarget(url: string): Promise<string | null> {
  // browser 级 WS 既有 connect/pending 基建上 send("Target.createTarget", { url, background: true })
  // 返回 targetId；失败 → null + warn（调用方降级：不建 tab，让 MCP 走自己的路径并如实承担激活）
}
```

### 4.3 LoggedInChannel 预建首 tab（hidden 模式的必要补丁）

`--no-startup-window` 起的 Chrome **没有任何 page target**（E7：/json/list 只有扩展 background_page/service_worker）——chrome-devtools-mcp connect 后无页可操作，其自建页路径（context.newPage → Target.createTarget 默认档）**会激活 Chrome**（V4b/V8-I）。

接线（LoggedInChannel.getMcpClient，takeSnapshotIfAbsent 之前）：

```
pages = GET /json/list filter type==="page"     // 复用 TabSession 既有探针
if (pages.length === 0 && 本 channel 绑定的 chrome 是 hidden 档台账 Chrome) {
  targetId = await cdp.createBackgroundTarget("about:blank");
  if (targetId) log { evt: "chrome_bg_tab_precreated", port, targetId };
}
```

**P0 真机验证项（V-18-1）**：chrome-devtools-mcp 0.3.0 connect 到「只有一个 background tab」的 Chrome 时，McpContext 是否把既有 page target 纳入其页集合（navigate_page 可直接作用于它）。单测无法回答（上游行为）；acceptance A2 实测。若不纳入 → fallback 方案：预建后以 `Target.activateTarget` 一次性激活该 tab（接受一次焦点抢占，仅 hidden 档、仅首建时，文档明示）——此为 last resort，不进默认路径。

### 4.4 激活路径禁令（现状机械化）

白盒实证 lasso 源码零命中 `select_page`/`bringToFront`/`/json/new`（本主循环 grep 复核）。INV-78d 把「现状」升级为「守护」——未来任何调用引入激活路径直接挂 check-invariants。

### 4.5 用户 Chrome（browse_logged_in 连 9222）的 flag 边界

connect 路径（`--browser-url`）零 flag 注入能力（白盒 §4.1：puppeteer.connect 不带 args；谁的 Chrome 听谁的）。落地为**文档建议**而非代码：

- doc/TROUBLESHOOTING.md 增节「让复用 Chrome 获得反节流能力」：用户自起 Chrome 时自行附加三件套 flag 的完整命令行；lasso 不改写用户进程环境（也不该）。
- lasso 能做的：`Emulation.setFocusEmulationEnabled` 属 page 级 session，lasso CdpClient 是 browser 级——**本版不做**（需 attach 目标 session，复杂度/收益比差），列为 v1.11 候选。
- 后台 tab 节流对 lasso 自身轮询无影响（ExpectPoll 走 CDP Runtime.evaluate，DevTools 会话直接调度，白盒 §4.2）；受影响的是页面自身 JS（懒加载/前端轮询）——如实写进 KEY-GUIDE。

---

## 5. 诚实边界（文档级交付，代码不假装解决）

1. **CLI 单独 launch-chrome 无 idle reaper**：`lasso-mcp launch-chrome` 是短命 CLI（spawn 后 exit），reaper 只活在 server 进程。单独 CLI 起的 Chrome 关闭出口仍是 `chrome-stop` / 手动。文档明示；不为此造 detached 看护进程（§1.2）。
2. **复用用户可见 Chrome ≠ 纯静默**：上游 #1254（macOS，--autoConnect 复用可见 Chrome）实证几乎每条 CDP 命令都可能抢键盘焦点，bringToFront:false/独立 Space/回焦 hook 全败，根因 Chromium 10 年级 bug（#223828 族）。lasso 锁定版 0.3.0 的实际调用面（白盒实测）多数命令不抢，但**无法承诺**——browse_logged_in 连用户 Chrome 的文档定位写为「低打扰，非零打扰」；纯静默的唯一无损层级是 headless（frontier §2）或本设计的 hidden 档。
3. **desktop cgEvent 档不可静默**：CGEventPost 是系统 HID 队列真实键鼠，必然占用物理焦点（白盒 §5，INV-28 语义）。AppleScript activate / AX 写档同理。产品语义二分：browse=静默浏览，desktop=显式授权的模拟人手操作——README 用户预期管理如此表述。
4. **用户已有 Chrome 未开 debug 口时无法接入**：既有限制（非本设计域），文档重申。
5. **后台节流不可完全消除的场景**：用户自起 Chrome 无三件套 flag（§4.5）；hidden tab 的 intensive throttling（hidden>10s 后 chained timer 1 次/分钟，M109+）——lasso 的 60s 用完即关把生命周期压在该机制的主要伤害区（>5min 累积）之前，是天然缓解而非根治（E-量化 §2 结论 4）。
6. **hidden tab 指纹代价**：`visibilityState=hidden` 反爬可见（StealthEngine 页面 JS 域改不了浏览器上报值）；headless soft-block ~15% vs headed ~7%（arXiv 2606.14525）——hidden headed 恰是「指纹优于 headless + 静默劣于 headless」的中间档（frontier §4），这个 trade-off 是特性不是缺陷，文档如实呈现两档选择依据。
7. **`--no-startup-window` 是未文档化开关**：有跨版本漂移风险——fallback 链（§3.2）是运行时探测式降级，不依赖上游承诺。
8. **Windows 适配不可真机验证**：代码审查 + CI shape（args 断言）+ 文档级（TROUBLESHOOTING 两段式 ShowWindow 方案），#W7 pending 范式延续。

---

## 6. INV-78 预设（`src/invariants/check-invariants.mjs`）

**INV-78 浏览器静默启动与 idle 回收安全**——三机制机械化守护，6 组断言（既有 INV-1..77 原样保留；沿用 byPath + stripComments + regex 圈定模式）：

| # | 断言（grep 可机械化） | 守什么 |
|---|---|---|
| a | launch-chrome.ts 源含字面量 `--no-startup-window`、`--start-minimized`、三件套 flag（`--disable-backgrounding-occluded-windows` / `--disable-background-timer-throttling` / `--disable-renderer-backgrounding`）、`--mute-audio`，且这些出现在 `launchMode === "hidden"` / 恒加分支的控制流内（regex 圈定 args 构造函数体）；visible 分支不含 `--no-startup-window` | 机制二：hidden 档 flag 集不漂移 |
| b | config.ts 的 CONFIG_TEMPLATE 含 `LASSO_LAUNCH_MODE`（值 `"hidden"`）与 `LASSO_LAUNCH_IDLE_MS`（值 60000）；存在 `parseLaunchMode`/`parseLaunchIdleMs` 且非法值回退默认（函数体 regex 含 `"hidden"` 与 `60_000` 字面量）；index.ts 同时命中 `launchIdleMs` 与 `startChromeIdleReaper` 接线 | 机制一/二：配置面 + 默认值不回退 |
| c | chrome-idle-reaper.ts 存在且 import `stopLaunchedChromes`（或 chrome-stop.js）与 `readLedgerSync`（或 chrome-ledger.js）；其函数体**不含** `killTreeSync`/`process.kill` 直接调用（杀必须经 chrome-stop 验证路径）；index.ts `launchIdleMs > 0` 门控存在 | 机制一：零第二 kill 原语 + 0=禁用 |
| d | `src/channels/BrowseChannel.ts`、`src/browse/cdp-actions.ts`、`src/logged-in/*.ts`（TabSession/CdpClient/LoggedInChannel）不含 `select_page` 工具调用（容忍注释中出现 `select_page` 字样则收紧为 `"select_page"` 带引号工具名形态）、不含 `bringToFront`、不含 `/json/new`（HTTP 开 tab 路径）；CdpClient.ts 含 `Target.createTarget` 且同函数体含 `background: true` | 机制三：激活路径禁令 + background 建塔 |
| e | chrome-hide.ts 存在；函数体含 `unix id`（PID 定向）且**不含**按名形态 `set visible of process "Google Chrome" to false`（无 PID 限定的裸按名 hide——E8 事故红线）；调用点对非 mac 平台 no-op | 机制二保险丝：永不按名 hide |
| f | chrome-ledger.ts 的 LaunchedChromeRecord 含 `launchMode` 与 `idleMs` 可选字段声明；readLedgerSync 圈定体内含两字段的 typeof 守卫解析 | 台账 schema 前向兼容 |

计数变化：77 → **78**（输出 `78/78 passed`）。

---

## 7. 测试计划

### 7.1 新增单测（~24）

**`test/unit/chrome-idle-reaper.spec.ts`**（机制一，9 例；注入 nowFn/readLedgerFn/stopFn + fake timers）：
1. 60s idle + 15s 周期：launchedAt 75s 前 → stopFn 以 `{port}` 被调；
2. launchedAt 30s 前 → 不调；
3. `touch(port)` 后重算（touch 重置 lastUse → 不杀）；
4. `rec.idleMs` per-record 覆盖全局默认（3600000 → 不杀）；
5. `idleMs=0`（record 级）→ 跳过；`defaultIdleMs=0` → startChromeIdleReaper 返 null（不启 timer）；
6. stopFn reject → warn 继续处理下一条（reaper 不死）；
7. `stop()` 清 interval（timer unref 后再 stop 无错，幂等）；
8. 两条记录只杀超时那条（port 精确性）；
9. 源码 grep 断言：chrome-idle-reaper.ts 无 `killTreeSync`/`process.kill` 直接调用（INV-78c 的测试面镜像）。

**`test/unit/launch-chrome.spec.ts` 增补**（机制二，8 例；既有 mock spawnFn 惯例）：
10. hidden + mac：args 含 `--no-startup-window` + 三件套 + `--mute-audio`；
11. visible：args **不含** `--no-startup-window`（回退 v1.9 形态）但含三件套；
12. hidden + win：args 含 `--start-minimized` 且含 `--no-startup-window`；
13. extraArgs 与默认 flag 重复 → 去重（同 flag 不双发）；
14. fallback 链：hidden spawn 后 exited=true → 第二次 spawnFn 调用 args 含 `--window-position=-32000,-32000`；
15. fallback 也 exited → 返 `chrome_exited`（不第三次重试）；
16. recordLaunch 落账含 `launchMode`/`idleMs`（透传 opts）；
17. `parseLaunchChromeArgs`：`--mode hidden`/`--idle-ms 5000` 解析进 opts。

**`test/unit/chrome-hide.spec.ts`**（机制二保险丝，3 例；mock execFn）：
18. AppleScript 片段含目标 pid 数字且含 `unix id`；
19. osascript 非零退 → `{ok:false}` 不抛；
20. platform=win / pid undefined → no-op（execFn 零调用）。

**`test/unit/cdp-client.spec.ts` 增补**（机制三，2 例；既有 mock WS 惯例）：
21. `createBackgroundTarget` 发送 `Target.createTarget` 且 params 含 `background: true`，返回 targetId；
22. send reject → 返 null + warn（不抛）。

**`test/unit/config-file.spec.ts` 增补**（2 例）：
23. `LASSO_LAUNCH_MODE` 非法值（"minimized"）→ 回退 `"hidden"`；`LASSO_LAUNCH_IDLE_MS=0` → 0（禁用语义）；
24. config.json 文件层两键 number/string 形态均正确解析（loadConfigFileEnv 规范化路径）。

### 7.2 新增集成（~4）

**`test/integration/logged-in-bg-tab.spec.ts`**（mock fetchFn/closeFn/createFn）：
25. `/json/list` 零 page + hidden 台账 Chrome → `createBackgroundTarget("about:blank")` 被调（onChromeUse 与预建顺序：touch 先于建塔）；
26. 已有 page → 不预建；
27. `onChromeUse` 回调在 getMcpClient 成功路径被调（reaper touch 接线）。

**`test/integration/launch-config-layering.spec.ts`**：
28. config.json 设 `LASSO_LAUNCH_MODE:"visible"` → CLI 无 flag 时 opts.launchMode=visible（文件层生效）；argv `--mode hidden` 覆盖文件层（argv 最高）。

### 7.3 既有回归门禁

- 全量 `npm test`：1768 基线全绿 + 新增 ~28-30 → **~1796-1798**；
- `npm run check-invariants`：77 → **78**；
- 重点盯防：`launch-chrome.spec.ts` 既有用例（v1.9 断言的 4-arg 形态会因恒加三件套/mute 变化——**需同步更新既有断言**，属预期行为变更非回归；`chrome-ledger.spec.ts`（schema 新可选字段不破坏旧解析）；`tab-session.spec.ts`（零改动应零波动）。

### 7.4 e2e 手测清单（v1.10 acceptance，本机 macOS 可证；Windows 项标 #W-pending）

| # | 场景 | 预期 |
|---|---|---|
| A1 | 前台放 VS Code → `lasso-mcp launch-chrome --port 9225`（默认 hidden） | frontmost 保持 Code；窗口数 0；CDP /json/version 通；台账含 launchMode:"hidden" |
| A2 | A1 基础上 server 起 browse_logged_in（cdpPort=9225）navigate example.com | **V-18-1**：MCP 作用于预建 background tab；全程 frontmost 非 Chrome；`chrome_bg_tab_precreated` 日志 |
| A3 | A2 后等 75s 不动 | Chrome 进程消失（reaper）；台账空；`chrome_stop_result` 日志含 killed |
| A4 | A3 后立刻再 browse 一次 | logged_in spec 自愈重 spawn（closed→respawn 链），browse 成功 |
| A5 | `--idle-ms 3600000` 单发 launch | 75s 后 Chrome 仍在（per-record 覆盖） |
| A6 | `LASSO_LAUNCH_IDLE_MS=0` 起服务 | `chrome_idle_reaper_disabled` 日志；Chrome 常驻到 chrome-stop |
| A7 | `--mode visible` | v1.9 可见行为 + 后台 tab 不节流（E-量化基准脚本复跑：rAF 60fps） |
| A8 | hidden Chrome 上 `PUT /json/new` 手动开 tab（模拟未来回归） | 抢焦点——证明 lasso 代码路径必须绕开（INV-78d 的反例实证，记录进 acceptance） |
| A9 | Accessibility 授权机器跑 hidden launch | 保险丝 hide 生效（visible of PID=false）；`--` 无授权机器跑 | 降级 warn 不 fail |
| A10 | 停止 server（SIGTERM） | 既有停机收尾 + reaper.stop() 无错 |
| W1 | Windows：`--mode hidden` args 含 --start-minimized | #W-pending（CI shape 断言已有，真机留待） |

---

## 8. 03 审查预设（架构想法/03 对齐）

### 8.1 §1 六维逐维预设

| 维度 | 审查点 |
|---|---|
| 一致性 | kill 真源不增（chrome-stop 唯一验证杀路径，reaper 只是消费者）；idle 语义两键分工（LAUNCH=台账 Chrome / HEADLESS=MCP spec）注释与 KEY-GUIDE 双处一致；launchMode 在 config/CLI/ledger 三层同名同枚举 |
| 错误处理 | reaper 单条失败继续；hide 保险丝 TCC 缺失降级；createBackgroundTarget 失败返 null 走 MCP 自建（如实承担激活）；台账写失败不让 launch 失败（既有） |
| 资源清理 | 用完即关 ≤75s 上界；chrome-stop/停机/exit 三出口不变；reaper timer unref + stop() 幂等 |
| 并发 | touch 与 reaper tick 的读写竞态（单线程事件循环无 async 夹缝——touch 是同步 map 写）；台账 tmp+rename 原子性 vs reaper 并发读（既有容错解析兜底） |
| 可观测 | 新事件：`chrome_idle_reaped`/`chrome_bg_tab_precreated`/`chrome_hide_fuse_{ok,denied}`/`chrome_idle_reaper_disabled`/`launch_mode_fallback`（含重试档位） |
| 安全 | 红线机械化：INV-78c（零第二 kill）、78d（激活禁令）、78e（永不按名 hide）；台账 Chrome 恒隔离 profile（W1-DEF-7 既有）→ 杀无误伤面 |

### 8.2 §2 五阶段门禁

design（本文档）→ implement（Phase A-D 各跑三件套）→ test（§7）→ review（03 六维 + INV-78 grep 复核）→ acceptance（§7.4 A1-A10 + parse18-acceptance.md 落档）。

### 8.3 §1.7.7 跨边界同步对

1. **ledger schema 又扩**（launch-chrome 写 / chrome-stop 读 / reaper 读三方）：两可选字段前向兼容，但 KEY-GUIDE 与 schema 注释须同步。
2. **`LASSO_LAUNCH_MODE` 三来源优先级**（config.json < env < argv）：index.ts CLI 入口解析与 config.ts parse 函数的枚举一致性（单测 28 守）。
3. **上游契约（R-INT-08）**：`Target.createTarget background:true` 是 CDP target 级参数（Chrome 92+）——grep 测不到，A2 必须真机；`--no-startup-window` 未文档化——A1 + fallback 链真机。
4. **R-INT-07 自查**：touchMap 新增「reaper 读 / LoggedInChannel 经回调写」单写多读形态，与 SubprocessManager.lastUsedAt 同范式，无多消费者可变状态耦合（reaper 不写 touchMap，只读）。
5. **reaper 与 transport onclose 自愈链**是隐式契约（杀 Chrome → spec closed → 重 spawn）：A4 实测；若上游 transport onclose 时序变化，此链断裂的表现是「下次 browse 卡 spawn」——observ 的 subproc 事件可定位。

---

## 9. 版本裁决 1.10.0 + 实施顺序

**1.10.0 而非 1.9.1**：新增两个用户可见配置键 + 默认行为变化（hidden 默认 + 60s 自动关）+ 新 CLI flag + 台账 schema 扩展——语义面扩大是 minor 不是 patch（semver 语义；对照 v1.9.0 同为机制变更发 minor 的先例）。1.9.1 留给纯修复。

| Phase | 内容 | 门禁（真实跑） |
|---|---|---|
| **A**（机制一） | chrome-idle-reaper.ts + config 两键（parse/template/字段）+ index.ts 接线 + LoggedInChannel onChromeUse + ledger schema 两可选字段 + 单测 1-9/23-24 | build + test（1768→~1780，**含既有 launch-chrome 断言同步**）+ INV 77 |
| **B**（机制二） | launch-chrome args 分档 + fallback 链 + chrome-hide.ts + CLI --mode/--idle-ms + 单测 10-20/28 | build + test + INV 77 |
| **C**（机制三） | CdpClient.createBackgroundTarget + LoggedInChannel 预建 + 集成 25-27 | build + test（→~1798）+ INV 77 |
| **D**（收尾） | INV-78 + KEY-GUIDE 两键 + TROUBLESHOOTING（用户 Chrome flags 建议 + Windows 两段式方案）+ README（launchMode/idle 行为说明，user-facing）+ package.json 1.10.0 + acceptance A1-A10 | build + test + **INV 78** |

依赖：A 先行（C 的预建依赖「hidden 台账 Chrome」判定与 onChromeUse 注入点）；B/C 无相互依赖可并行。

---

## 10. 诚实判定

1. **「用完即关」是 75s 上界不是瞬时**：60s idle + 15s 周期的折中（§2.2 四条依据）；要逼近瞬时配 `LASSO_LAUNCH_IDLE_MS=1000`，代价是轻交互场景频繁重冷启（Chrome ~2s + npx 树 ~11s）——默认取折中，文档给出两个极端的配法。
2. **纯静默是分层的，不是绝对的**：lasso launched Chrome=可承诺（实测链完整）；用户可见 Chrome=低打扰不承诺（#1254 平台级）；desktop cgEvent=明确不静默（语义）。README 预期管理按这三层表述，不用「完全不影响用户」这类绝对化文案。
3. **hidden 档的 V-18-1 未定**：chrome-devtools-mcp 0.3.0 对「仅有 background tab」的 Chrome 的页集合行为只能真机验（A2）；last resort 是首建 tab 一次性激活（文档明示的降级，不默认）。
4. **fallback 链的代价不对称**：离屏窗口档有 <1s 焦点闪现 + 键盘焦点被夺直到保险丝 hide——比 primary 档差得多，但比 v1.9 的必然抢焦点好；这是对未文档化开关漂移的保险，不是等价选项。
5. **Windows 全链路是文档级置信**：flag shape 可 CI 断言，运行时行为（--start-minimized 是否被具体 Chrome 版本尊重）不可验证——#W-pending 范式如实标注，不假装已验证。
6. **三件套 flag 恒加改变了 visible 档的指纹面**：`--mute-audio` 与反节流 flag 进 cmdline 是自动化浏览器的常见信号（StealthEngine 不处理 cmdline 层）——visible 档用户若在意，可 `--extra-args` 无对冲（Chrome flag 无否定形态）。已知 trade-off，接受（agent 起的 Chrome 本就是自动化上下文）。
