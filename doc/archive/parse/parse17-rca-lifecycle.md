# parse17 RCA — Lasso 浏览器/tab 全生命周期白盒审计

> 审计基线：lasso-mcp **v1.8.1**（1711 TS tests + 76 INV 全绿）。
> 触发背景：doc/17 wave1（129 例）/ wave2（53 例）功能测试期间浏览器大量积留（曾达 **52 个 chrome-devtools-mcp 进程** + 多个 Chrome 实例/窗口），用户要求 ①白盒根因彻查（禁黑盒猜测）②机制修复——工具运行完成/任务完成后关闭打开的浏览器；若用用户登录浏览器，则关闭 Lasso 打开的 tab 恢复原 tab 列表。
> 方法：逐路径读源码（SubprocessManager / HeadlessChannel / BrowseChannel / LoggedInChannel / logged-in/* / launcher/launch-chrome / index.ts）+ doc/17-执行记录 实测证据交叉验证（wave1-summary / wave2-summary / wave2-browse / mcp*.mjs harness 源码）。rust-helper 与本议题无关，跳过。

---

## 1. 浏览器/tab 全生命周期图

### 路径 A：headless Chromium（browse_headless）

```
触发点: CC 调 browse_headless 工具
  → BrowseChannel.browse()                     [BrowseChannel.ts:207]
  → HeadlessChannel.getMcpClient()             [HeadlessChannel.ts:69]
  → SubprocessManager.ensureRunning("headless") [SubprocessManager.ts:143]
     （懒启动/复用：已 alive → 仅刷 lastUsedAt；否则 _spawnWithBackoff）
  → McpClient.connectStdio → SDK StdioClientTransport 自带 spawn
     npx -y chrome-devtools-mcp@0.3.0 --headless --isolated --disable-blink-features=...
     [HeadlessChannel.ts:56-66 构造期 registerSpec]

进程树（三层，wave2 实证 ppid 链）:
  npm exec shim (ppid=server)                  ← procs["headless"].client.pid 追踪的就是它
   └─ node /tmp/npm-cache/_npx/.../chrome-devtools-mcp   (ppid=shim)
       └─ headless Chromium + helper 子进程               (ppid=node)

清理责任方: SubprocessManager（procs map + v1.8.1 lifecyclePids 永久登记）

实际清理时机:
  ① 每次 browse 调用完成 → 什么也不做（设计=懒复用，浏览器跨调用常驻）
 ② 闲置 >1h → zombieTimer(60s 周期) cleanupZombies → _kill
     ⚠ 但 _kill 只调 SDK client.close()（对 shim 发 SIGTERM，npm exec 不转发）
     → 树未死，仅 procs map 条目被删（见缺口 G5）
 ③ server 收 SIGTERM/SIGINT → index.ts:1143 killAllSync
     → pgrep -P 递归树杀 SIGKILL（v1.8.1 实证有效）✓
 ④ server 自然 exit / uncaughtException 后 exit → process.on("exit") killAllSync
     → v1.8.1 起 lifecyclePids 兜底历史 pid ✓（v1.8.0 前为空 map，见 G4）
```

### 路径 B：logged_in MCP 子进程 + 用户 Chrome 里的 tab（browse_logged_in）

```
触发点: CC 调 browse_logged_in 工具
  → LoggedInChannel.getMcpClient()             [LoggedInChannel.ts:132]
  → ensureProfileSpec()                        [LoggedInChannel.ts:105]
     （懒注册 spec "logged_in:<profile>"；profile 切换 → forgetSpec(old) → _kill 旧子进程）
  → ensureRunning → spawn
     npx -y chrome-devtools-mcp@0.3.0 --browser-url=http://localhost:<cdpPort>
     [LoggedInChannel.ts:120-128]

进程树:
  npm exec shim → node chrome-devtools-mcp（无自有 Chromium，经 CDP 附着用户 :9222 Chrome）

tab 的打开: navigate_page / 各 action 在**用户已登录 Chrome** 里操作 target；
  chrome-devtools-mcp 默认行为≈每 URL 留一个 tab（parse9 §4.3 防爆炸场景的出处）

tab 的清理（现状）:
  每次 getMcpClient 末尾 TabRegistry.reconcile(client)   [LoggedInChannel.ts:141-145]
  → list_pages 枚举 → 触达（MRU 提升）→ 仅当 size > cap(默认10, clamp[1,20])
    才 close_page 淘汰最老                                          [TabRegistry.ts:83-116]
  语义 = **数量上限 LRU**，不是「恢复原 tab 列表」：
  - 没有首附着的 tab 快照，不知道哪些 tab 是 Lasso 打开的
  - ≤cap 时 Lasso 打开的 tab 全部保留，browse 完成后原样留在用户 Chrome 里
  - 只识别 https?:// URL 的 tab（about:blank / 内部页不进 registry）
  - reconcile 抛错仅 warn（best-effort，不重试）[LoggedInChannel.ts:143-145]

清理责任方: 子进程=SubprocessManager（同路径 A ③④）；tab=TabRegistry（仅 LRU 上限）

外围: cookie admin 路径（exportCookies/importCookies）用 CdpClient 裸 WebSocket
  （9222 /json 列表 + Storage.getCookies），finally cdp.close() 释放——瞬态，无泄漏。
```

### 路径 C：launch-chrome 隔离 profile Chrome（CLI 子命令）

```
触发点: `lasso-mcp launch-chrome [--port N] [--profile <dir>]`   [index.ts:1233]
  → runLaunchChromeCli → launchChrome()      [launch-chrome.ts:336 / :168]
  → spawn(chromeBinary, [--remote-debugging-port=N, --user-data-dir=~/.cache/lasso/chrome-profile-default, ...],
          { detached: true, stdio: "ignore" })
     + child.unref()                          [launch-chrome.ts:258-280]
  → CDP 探活（3s/10 次 /json/version）→ 返回 {ok, pid, port, profileDir}
  → CLI process.exit()                        [launch-chrome.ts:342]

进程树: Chrome（ppid=1，detached）+ 其 helper 子进程

清理责任方: **没有人**。
  - 不在 SubprocessManager（specs/procs/rustProcs 都不认识它）
  - 不在 lifecyclePids（那里只登记 McpClient/RustProc spawn 的 pid）
  - 无任何磁盘/内存所有权台账记录「这个 pid 是 lasso 起的」
  - 设计注释明说「不接管 Chrome lifecycle」「cdp_not_ready 时……不代 kill」
    [launch-chrome.ts:11, :303, :331-332]
实际清理时机: 用户手动 kill / OS 关机。永不自动清理。

衍生路径: 这个 Chrome 起来后即成为路径 B 的 --browser-url 附着目标
（logged_in 在它里面开 tab）；Chrome 活多久，tab 就活多久。
```

### 路径 D：测试面板的 server 进程本身（doc/17 积留的放大器）

```
触发点: doc/17-执行记录/*.mjs harness
  - mcp.mjs:          StdioClientTransport({ command:"/bin/zsh", args:["-c",
                       "exec node dist/index.js 2>>server-stderr.log"] })   ← sh -c 包裹
  - mcp-wave1.mjs:    command: process.execPath, args:["dist/index.js"]     ← 直接 node
  - w2-browse-session.mjs: 同 mcp.mjs 的 zsh -c 包裹形态
语义: 每次工具调用 = 一个全新 server 进程 → 每次 browse 都 spawn 一棵新的 npx 树。
harness finally 里 transport.close() 关 stdin → server 走自然退出路径（exit 钩子）。
```

---

## 2. 缺口清单

### G1（核心·用户要求①）server 长活则 headless Chrome 永活——无「工具运行完成即关」语义

- **场景**：CC 会话内 server 常驻（一次 `claude mcp add` 整个会话一个 server 进程）。CC 调一次 `browse_headless screenshot`，headless Chromium 连同 npx shim→node 树一直活到 CC 会话结束。
- **为什么永不清理**：`browse()` 完成 handler 后直接写盘返回（BrowseChannel.ts:288-318），无任何 teardown 钩子；唯一的闲置回收是 zombie reaper，阈值 **1h**（index.ts:354 `subproc.startZombieReaper()` 用默认 `idleThresholdMs=3_600_000`，SubprocessManager.ts:184-187），且 `lastUsedAt` 只在 `ensureRunning` 命中复用时刷新（SubprocessManager.ts:146）——「最近 1 小时内用过任何一次 browse」就继续保活。工具粒度/任务粒度的关闭机制**不存在**。
- **源码锚点**：SubprocessManager.ts:143-150（ensureRunning 仅刷 lastUsedAt）、184-199（reaper 默认 1h）、202-214（cleanupZombies）；index.ts:354；BrowseChannel.ts:279-318（browse 主路径无 teardown）。

### G2（核心·用户要求①）launch-chrome 起的 Chrome 无人管——pid 返回后即失去所有权

- **场景**：用户/CC 跑 `lasso-mcp launch-chrome`（或未来等价 MCP 工具），拿到 `{ok:true, pid, port}`。CLI 进程随即 exit。Chrome 以 ppid=1 detached 常驻，占着 9222 口和内存，直到手动 kill。wave2 遗留 2 个 Chrome 窗口即此因（已由主循环手工清理）。
- **为什么永不清理**：spawn 用 `detached:true + stdio:"ignore" + unref()`（launch-chrome.ts:260-280），设计上「不接管 lifecycle」（文件头注释第 11 行、CLI 注释 :331-332）；`pid` 只写进返回 JSON 给调用方看，**没有任何代码把它登记进 SubprocessManager/lifecyclePids 或落盘台账**。探活失败的 `cdp_not_ready` 分支还显式承诺「不代 kill」（:302-303）——慢启动的 Chrome 稍后就绪后照样常驻（wave2 U-04-1 实测 pid 74620 即此形态）。
- **源码锚点**：launch-chrome.ts:148-153（detached 设计）、256-280（spawn+unref+pid）、302-312（cdp_not_ready 不 kill）、336-343（CLI exit）；index.ts:1231-1235（子命令路由，返回后无后续）。

### G3（核心·用户要求②）logged_in 用用户浏览器后不恢复原 tab 列表

- **场景**：用户 Chrome 带 `--remote-debugging-port=9222` 运行，browse_logged_in 在其中 navigate 了 5 个站点 → 用户浏览器里多 5 个 tab，任务完成后原样留着。
- **为什么永不清理**：TabRegistry 的唯一关闭时机是「reconcile 时 size > cap(10) 淘汰 LRU」（TabRegistry.ts:103-114）。它**没有首附着快照**——不知道进入前用户原有哪几个 tab，因此既无法判定「哪些 tab 是 Lasso 打开的」，也没有「会话/任务结束时关闭 Lasso 打开的 tab」的出口。cap≤10 时一个 tab 都不会关。另：reconcile 失败仅 warn 不补偿（LoggedInChannel.ts:141-145）；非 `https?://` 的 tab 不进 registry（TabRegistry.ts:91）。
- **源码锚点**：TabRegistry.ts:83-116（reconcile 全部关闭语义所在）；LoggedInChannel.ts:132-147（唯一调用点）。

### G4（历史·已被 v1.8.1 修复，解释积留成因）v1.8.0 及之前：server 被杀/退出时 exit 钩子空 map → 孤儿

- **场景**：测试面板每次调用 spawn 一个 server，server 退出时其 npx 树变孤儿。批量 182 次调用 → 几十个 shim+node 对。
- **为什么（v1.8.0 时）永不清理**：优雅退出路径 `shutdown() → _kill(name)` 先 `client.close()` 再 `procs.delete(name)`——exit 钩子 `killAllSync()` 遍历**空 map**，SIGKILL 永不发出；且 SDK close 只对 shim 发 SIGTERM，npm exec 不转发信号，node/Chromium 子树不死。wave2 T-BROWSE-24 受控实验实证：单次 server 生命周期前后 pid diff 95→97（净残留 2 进程），stderr 计数 74 次 lasso_start / 53 次 lasso_shutdown / **0 次 subproc_exit_kill**（登记为 W2-DEF-N2）。
- **修复现状**：v1.8.1 `lifecyclePids`（永不删除的 spawn pid 全集，SubprocessManager.ts:107）+ `killAllSync` 以它为真源（:325-347）+ `_killTreeSync` pgrep -P 递归 SIGKILL（:354-383）。SIGTERM 路径与 exit 钩子均实证有效（shim→node→Chrome 三层树杀）。
- **源码锚点**：SubprocessManager.ts:103-107（W2-DEF-N2 修复注释）、295-347、354-383。

### G5（现存·服务器存活期内泄漏）运行中「优雅 _kill」路径不树杀——泄漏推迟到 server 退出

- **场景**：长活 server 内，zombie reaper 1h 闲置回收 / LoggedInChannel profile 切换的 `forgetSpec` / CapabilityBag disable 的 `shutdownOne`——三者都走 `_kill`，只调 `m.client.close()`（SIGTERM 到 shim，不转发）然后 `procs.delete(name)`。shim→node→Chrome 树**在 server 还活着时就孤儿化**（ppid=1），要等到 server 最终 exit 时才被 lifecyclePids 兜底树杀；期间每次「回收→下次 ensureRunning 重 spawn」净增一棵完整树。
- **为什么**：`_kill` 没有 SIGKILL/树杀分支（SubprocessManager.ts:532-546）；树杀能力 `_killTreeSync` 只接在 `killAllSync` 上。lifecyclePids 只在 exit 时读。
- **源码锚点**：SubprocessManager.ts:532-546（_kill）、132-136（forgetSpec）、407-426（shutdownOne）、202-214（cleanupZombies）。

### G6（次要）HeadlessChannel 没接 TabRegistry——headless Chrome tab 随 URL 累积

- **场景**：单 server 会话内 headless browse 100 个不同 URL，Chromium 内 target 数无上限增长（parse9 §4.3 的防爆炸场景原文即是这个，但 v0.8 只把 TabRegistry 接进了 LoggedInChannel）。
- **为什么**：HeadlessChannel.ts 全文无 tabs 字段/无 reconcile 调用；TabRegistry 只在 LoggedInChannel.getMcpClient 末尾被调。
- **源码锚点**：HeadlessChannel.ts:69-71（getMcpClient 仅 ensureRunning）；LoggedInChannel.ts:138-145（对比）。
- 缓解因素：树随 server 退出被 killAllSync 收走，泄漏窗口=G1 的常驻期。

### G7（次要·观测）launch-chrome 端口预检识别不了「持口不应答」的僵尸

- 预检只认「/json/version 有 HTTP 响应」才算占口（launch-chrome.ts:220-237）；wave2 实证 9222 被不应答的僵尸 pid 4800 持口时被判「空闲」放行 spawn → 落 cdp_not_ready，且新 Chrome 不被 kill（叠加 G2）。W2-OBS-3 已登记。

---

## 3. 现场残留因果链（52 进程 + 2 窗口如何一步步积累）

```
wave1（129 例，v1.8.0 前后）
  面板 harness（mcp.mjs / mcp-wave1.mjs）每次工具调用 = 一个全新 server 进程
    └─ 每个 browse_headless/browse_logged_in 调用
        └─ server 内 SubprocessManager spawn npx -y chrome-devtools-mcp@0.3.0
            = npm exec shim → node → headless Chromium 三层树
  server 退出（harness finally transport.close() → stdin 关 → 自然退出）：
    v1.8.0 前：exit 钩子 killAllSync 遍历空 map（_kill 先 delete 了条目；
               W1-DEF-6 的修复在唯一常见路径上不可达）
    + SDK client.close() 对 npm exec shim 不致死（SIGTERM 不转发）
    ⇒ 每个跑过 browse 的 server 净残留 +2 个 mcp 进程（shim ppid=1 + node），
      Chromium 树挂在 node 下继续活
        ↓ 累积
wave2（53 例，v1.8.0 被测版）
  同款 harness（w2-*/mcp.mjs，/bin/zsh -c "exec node dist/index.js" 包裹形态）
  T-BROWSE-24 受控实验固化机理：before 95 → after 97，净 +2/次；
  全程 ppid=1 孤儿涨至 40+，测后按 "@0.3.0+disable-blink-features" 签名定向清理 42 个
        ↓ 合计
  ≈26 个泄漏的 shim+node 对 = 用户看到的 52 个 chrome-devtools-mcp 进程
 （另有本 CC 会话自带 55 个 --isolated 的同款进程，未计入清理）

2 个 Chrome 窗口：
  wave2 U-04-1/T-LI-11 launch-chrome 三场景实测：
    - 9225 手动 / 9226 launch-chrome(pid 75159)：测后有记录 kill，但——
    - 9222 场景 cdp_not_ready 分支 spawn 出的 pid 74620（慢启动 Chrome）
      按「不接管 lifecycle/不代 kill」设计被留下（launch-chrome.ts:302-303）
    - 加上 chrome_exited 单例转发场景的残影
  ⇒ detached Chrome 无主（G2），遗留 2 窗口，最终由主循环手工清理

v1.8.1 之后：lifecyclePids + 树杀已堵住「server 退出」这个最大泄漏口
  ——但 G1（长活常驻）/ G2（launch-chrome 无主）/ G3（tab 不恢复）/ G5（运行中优雅 kill 不树杀）
  四个缺口仍在，即用户提出的机制修复目标。
```

---

## 4. 可复用的既有机制（机制设计阶段直接复用，不重造）

| 机制 | 位置 | 现状 | 复用方向 |
|---|---|---|---|
| `lastUsedAt` 字段 | SubprocessManager.ts:60/:90/:146/:244（MCP+Rust 双轨） | 已有，仅 1h reaper 消费 | 空闲看门狗的直接数据源：加可配置短阈值（如工具级 idle TTL），到期走**树杀**而非 `_kill` |
| `_killTreeSync`（pgrep -P 递归 SIGKILL） | SubprocessManager.ts:354-383 | v1.8.1 实证有效（shim→node→Chrome 三层） | 唯一可靠的致死原语：G1 工具完成关闭、G5 运行中回收、launch-chrome Chrome 关闭都应调它（对 launch-chrome 的 Chrome 根 pid 同样适用，pgrep -P 枚举其 helper） |
| `lifecyclePids` 永久登记 | SubprocessManager.ts:107/:496 | MCP/Rust spawn 即登记、exit 时消费 | 所有权台账范式：launch-chrome 的 Chrome pid 应进同款登记（或提供 `registerExternalPid`），exit 钩子自动覆盖；亦可落盘供跨进程关闭 |
| `TabRegistry` LRU + `reconcile`（list_pages/close_page） | TabRegistry.ts:83-116；LoggedInChannel.ts:141-145 | 已有枚举/触达/关闭全套原语 | 「恢复原 tab 列表」= 首次附着时 `list_pages` 快照基线；teardown 时 list_pages 与基线 diff，仅对**新增** tab 调既有 close_page 路径——不需要新协议，只加快照+diff 语义 |
| `shutdownOne` 单 spec 停 | SubprocessManager.ts:407-426 | 已接 CapabilityBag disable 链 | 任务完成关闭 headless 的现成入口（补树杀即可，不必新造 API） |
| `forgetSpec`（profile 切换 kill 旧进程） | SubprocessManager.ts:132-136 | 已有 | 同上，属 G5 修复面 |
| `zombieTimer` 调度基础设施 | SubprocessManager.ts:114/:184-199 | setInterval + unref，重复调用覆盖 | 空闲看门狗直接挂进现有 timer，不新增调度器 |
| `healthProbe` / `listManagedPids` | SubprocessManager.ts:158-172/:441-452 | 只读枚举 | 「浏览器生命周期」admin 工具（列当前 pid/tab、显式关闭）的观测底座 |
| `cleanupZombies(threshold)` 手动触发口 | SubprocessManager.ts:202-214 | 已是公开 API | 工具完成/任务完成的即时回收可复用此入口（改阈值+改 `_kill`→树杀） |

**机制修复的最小落点归纳**（供设计阶段）：
1. headless（用户要求①-a）：工具调用完成后按需/按 idle TTL 走「树杀 + closed 标记」，复用 `lastUsedAt + _killTreeSync + shutdownOne`。
2. launch-chrome Chrome（用户要求①-b）：spawn 后把 pid 登记进 SubprocessManager 台账（lifecyclePids 同款），提供关闭出口；`cdp_not_ready` 分支改为代 kill（改 launch-chrome.ts:302-303 的「不代 kill」承诺需同步设计文档）。
3. logged_in tab（用户要求②）：TabRegistry 加「首附着基线快照 + teardown diff 关闭新增 tab」，全部走既有 list_pages/close_page。
4. 运行中泄漏（G5）：`_kill` 在 `client.close()` 后补树杀（或直接 SIGKILL 优先），消除「回收即孤儿化」。

---

## 附：审计范围内的负向确认（查过、确认无隐藏路径）

- `src/tools/*.ts` 无 launch-chrome 的 MCP 工具封装（仅 CLI 子命令，index.ts:1233）——launch-chrome 目前不经 MCP 协议暴露。
- 全仓 `close_page` 调用仅 TabRegistry.ts:110 一处（check-invariants 亦以此守 INV）——不存在其他 tab 关闭路径。
- `CdpClient`（cookie admin）WebSocket 在 finally close，瞬态无泄漏。
- `McpClient.close()` 幂等且置 `stdioTransport=null`，二次清理安全。
- 小瑕疵备忘：`ManagedProc.closed` 注释声称「transport onclose 触发置 true」（SubprocessManager.ts:62-63），但代码从未注册 onclose 监听——远端关闭实际只靠 `_isAlive` kill(pid,0) 兜底判定。机制设计时若依赖 closed 标志需补接线。
