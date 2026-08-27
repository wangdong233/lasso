# v1.10 静默浏览器 真机验证执行记录（v1x-silent-verify）

- **日期**：2026-08-15
- **验证员**：独立真机验证 agent（parse18 实施后复核；未改任何 src/test 代码，仅新增本记录与 `v1x-data/` 证据文件）
- **被测**：lasso-mcp v1.10.0（工作树未提交态，`4fda181` v1.9.0 之上的 v1.10 改动集）
- **环境**：macOS 12（Darwin 21.6.0，Intel）· Chrome 150.0.7871.182 · Node 24.12.0 · 前台基线 app = VSCode（Code）
- **对照需求**（用户原始四条）：
  ① 新开浏览器用完即关（不等 5min；5min idle 配置保留给用户且 `~/.lasso/config.json` 可配）；
  ② 新开浏览器默认隐藏/最小化（macOS 重点，Windows 适配）；
  ③ 调研回答：切屏后项目操作是否阻断/影响用户；能否纯静默；
  ④ 白盒调研（开源+前沿）——由 parse18 调研文档承担，本记录验证其结论在真机成立。
- **证据文件**：均在本目录 `v1x-data/` 下（文中逐项引用）。

---

## 0. 门禁输出（终态真跑；验证员全程零 src/test 改动，中途加过临时资源采样 spec、跑完即删）

```
npm run build            → BUILD_OK（tsc 0 errors）
npm test                 → Test Files 111 passed (111) | Tests 1801 passed | 1 skipped (1802)
                           （基线 v1.9 1768 → v1.10 1801，+33，零回归；删临时 spec 后计数回落一致）
npm run check-invariants → All 78 invariants passed（INV-1..77 原样 + INV-78 新增）
rust-helper/             → 零改动（本次不涉及）
```

---

## 1. 验证结果表（全部真机实测）

| # | 验证项 | 方法（真机） | 结果 | 证据 |
|---|--------|--------------|------|------|
| V1 | **隐藏模式默认档** | 前台保持 VSCode → `node dist/index.js launch-chrome --port 9225`（无任何 flag）→ 3s 后采样 | **PASS**：frontmost 保持 `Code`；该 PID 窗口数 **0**；CDP `/json/version` 通（Chrome/150）；台账含 `launchMode:"hidden", idleMs:60000`；`/json/list` **0 targets**（零窗口零页） | `v1x-data/v1-launch.json`、`v1-launch-stderr.log`、`v1-screen.png`（screencapture 取证） |
| V2 | **visible 档回归** | `LASSO_LAUNCH_MODE=visible` 起 9229 | **PASS**：窗口数 **1**；frontmost 变为 `Google Chrome`（v1.9 老行为保留）；台账 `launchMode:"visible"` | 终端记录（本文件 §4 复核段） |
| V3a | **用完即关（reaper）** | 起 9226（`--idle-ms 2000`）+ server 进程 `LASSO_LAUNCH_IDLE_MS=2000` → 0/10/20/35s 采样 | **PASS**：t=10 存活、t=20 **台账清空 + 进程灭**（reap 延迟 ≤20s = idle 2s + 15s tick，符合设计上界）；stderr 实录 `chrome_stop_result{action:"killed", tree_kill:false}` + `chrome_idle_reaped{idle_ms:2000, idle_for_ms:15680}`（SIGTERM 优雅步即死，无需树杀） | `v1x-data/v3-idle-reap.json`、`v3-server-stderr.log` |
| V3b | **per-record idle 覆盖（A5 严格版）** | 新起 9227（rec `idleMs:60000`，launchedAt=now）+ server 全局 2000 → 20s 观察 | **PASS**：跨过首个 15s tick 后**仍存活**（20s 年龄 < 60s；若 reaper 误用全局 2000 则首 tick 即死）→ per-record 覆盖实证 | `v1x-data/v3b-a5-and-stop.json`、`v3b-server-stderr.log` |
| V3c | **chrome-stop 显式出口** | 纯 CLI：起 9228 → `chrome-stop --port 9228` | **PASS**：`stopped:[{pid:62126, action:"killed"}]`；台账 `[]`；`pgrep` **0**；端口 9228 **RELEASED** | 终端实录（§4） |
| V3d | **server 停机收尾出口** | V3b 结束时 `server.kill()`（SIGTERM） | **PASS**：停机钩子自动清台账+灭进程（其后 chrome-stop 幂等返 `stopped:[]`，exit 0）——三出口（reaper / 停机 / 显式 stop）齐 | `v1x-data/v3b-a5-and-stop.json` |
| V4a | **config.json 文件层生效** | `LASSO_CONFIG_PATH=/tmp/.../config.json` 写 `{"LASSO_LAUNCH_MODE":"visible","LASSO_LAUNCH_IDLE_MS":123456}`（无 env 覆盖）起 9230 | **PASS**：窗口 1（visible 生效）；台账 `visible / 123456`——**~/.lasso/config.json 对 CLI 生效实证** | 终端实录（§4） |
| V4b | **优先级 env > file** | 同一 config 文件 + `LASSO_LAUNCH_MODE=hidden LASSO_LAUNCH_IDLE_MS=70000` 起 9231 | **PASS**：窗口 0、frontmost 不变；台账 `hidden / 70000` | 同上 |
| V4c | **优先级 argv > env** | `LASSO_LAUNCH_IDLE_MS=70000` + `--idle-ms 5000` 起 9232 | **PASS**：台账 `idleMs:5000` | 同上 |
| V4d | **`lasso config init` 模板含新键** | `LASSO_CONFIG_PATH=/tmp/... node dist/index.js config init` | **PASS**：模板含 `LASSO_LAUNCH_MODE:"hidden"`、`LASSO_LAUNCH_IDLE_MS:60000`、且 **`LASSO_HEADLESS_IDLE_MS:300000` 保留**（需求①"5min 配置保留给用户"达成——用户改文件即配，0=禁用 reaper 常驻） | 终端实录（§4） |
| V5 | **静默 tab（操作不扰民）** | 对 V1 的 hidden Chrome 直连 CDP WS，6 步操作（`Target.createTarget{background:true}` → navigate → click → fill → evaluate → closeTarget），每步前后采 frontmost+窗口数 | **PASS**：**6/6 步 `focusStolen:false`、窗口数恒 0**；frontmost 全程 `Code`；targetId 正常创建、`document.title="Example Domains"` 读回、closeTarget success——**纯静默操作实证（需求③答案：不阻断、不影响）** | `v1x-data/v5-silent-tab.json`、`v5-silent-tab.mjs` |
| V6 | **headless 回归 + stealth** | MCP `browse_headless {url, action:"navigate", options.steps:[evaluate]}` | **PASS**：`outcome:"worked"`（chrome_devtools_mcp）；evaluate 返回 `{"webdriver":"undefined", "uaHead":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/13x", plugins:5}`——stealth 引擎仍生效（真 macOS 上 UA 已伪装 Windows） | `v1x-data/v6-headless.json`、`v6-headless-stderr.log` |
| V7 | **清理纪律（零残留）** | 全部验证后采样 | **PASS**：台账 `[]`；`pgrep -f 'user-data-dir.*lasso'` = **0**；端口 9225-9236 LISTEN = **0**；8 个 /tmp 临时 profile + 临时 config 全删；`git status` 仅含实施者的 v1.10 改动 + 本验证的 doc 新文件；用户无标记 Chrome 全程未动（chrome-stop 只杀 cmdline 验证 `--user-data-dir` 归属的 pid） | §4 终端实录 |

### 补充语义澄清（验证中澄清的两条非缺陷）

- **V3a 中 9225 也被回收**：其记录 `idle_for_ms:192347`（3.2min）已超自身 `idleMs:60000`，属正确回收（日志 `idle_ms:60000` 证明用的是 per-record 值而非全局 2000）；与 V3b 的"未超时不误杀"合成完整判定。
- **evaluate 的 js 契约**：`doEvaluate` 把 js 包进 `() => { … }` 函数体（W1-DEF-1b），裸表达式返回 `undefined`、须 `return …`——已记录契约，非本次缺陷。

---

## 2. 资源表（三采样纪律，`test/helpers/resource-meter.ts`，真机）

临时 spec（跑完即删，不入库）：`before()` → launch hidden(9236) + `Target.createTarget{background:true}` + navigate → `peak()` → `chrome-stop` → `after()` → `released()`。

| 采样点 | 特征进程树进程数 | RSS 总和 | CPU 时间总和 |
|--------|-----------------|----------|--------------|
| before（基线） | 0 | 0 KB | 0 s |
| **duringOperationPeak**（hidden Chrome + 1 静默 tab + 导航中） | **8** | **523,056 KB（≈511 MB）** | **2.65 s** |
| after（chrome-stop 后 1.5s） | 0 | 0 KB | 0 s |

- `released(before, after) = true`（进程数与 RSS 双双回基线；Chromium helper 子进程靠 ppid 闭包全数归属）
- 读数：hidden 档 Chrome 空跑≈一个常驻浏览器底噪（~0.5GB、8 进程），**60s 默认 idle 用完即关**把这个底噪的存在窗口压到分钟级——这正是需求①的资源意义。反节流三件套（occluded-windows/timer-throttling/renderer-backgrounding 恒加）保证后台不被钳档，代价包含在上述读数内。
- 证据：`v1x-data/resource-sampling.json`

---

## 3. 03 审查（/Users/wangdong/Documents/Project/架构想法/03_审查测试清单.md §1 六维度）

> 审查对象：v1.10 改动集（chrome-hide.ts / chrome-idle-reaper.ts / launch-chrome.ts / chrome-ledger.ts / config.ts / index.ts / CdpClient.ts / TabSession.ts / LoggedInChannel.ts + 5 个新 spec + INV-78）。验证员逐维度给结论：

| 维度 | 结论 | 要点 |
|------|------|------|
| 1.1 代码规范 | **PASS** | tsc 全绿（noUnusedLocals 等）；新命名（launchMode/idleMs/reaper/touch）与台账 schema 一致；注释解释 WHY（红线、裁决编号可回溯），无 WHAT 复述 |
| 1.2 数据逻辑 | **PASS（1 🟡 见 F1）** | 台账 JSON 是跨进程契约（CLI 写 / server reaper 读）：字段缺失语义明确（`rec.idleMs ?? defaultIdleMs`、`launchMode` 可选前向兼容）；错误路径显式（reap 单条失败 log 后继续、tick 容错、hide 降级不 fail）。**宿主契约（1.2 项 8）已 L3 真机验证**：`--no-startup-window` 零窗口、`background:true` 建塔零抢焦，均为真机实证非注释推断——这是本次最关键的 1.2 项 8 达标项 |
| 1.3 业务逻辑 | **PASS** | 状态机边界枚举齐：idle≤0 三态（record 级 0 跳过 / 全局 0 不启 timer / 正常值）；`ticking` 守卫防 async stop 叠 tick；`stopped` 幂等；port_in_use / chrome_exited / cdp_not_ready tri-state 诚实。设计 artifact = parse18 文档（裁决 1-8），语义不从 diff 重建 |
| 1.4 端到端接通 | **PASS** | 值级 trace 三条全通：①argv/env/file→`mergeLaunchDefaults`→台账（V4a/b/c 实测落账值）；②台账→reaper tick→`stopLaunchedChromes`→SIGTERM→删账（V3a stderr 值级实录 `idle_for_ms:15680`）；③browse→`onChromeUse`→`touch(port)`（代码接线 + 单测；V5 旁证 CDP 路径无激活）。文档面 README/KEY-GUIDE/TROUBLESHOOTING 已同步（git status 可见四处修改） |
| 1.5 性能+生产就绪 | **PASS** | reaper 15s 读小 JSON 定时器开销可忽略（§2 实测无感）；**disable switch 就位**（`LASSO_LAUNCH_IDLE_MS=0` / `--mode visible` 双回退面）；**rollback** = chrome-stop 显式出口 + 停机收尾（V3c/d 实证）；metrics = 结构化 stderr 事件（reaped/reap_error/fuse_ok/fuse_denied/fallback） |
| 1.6 简单架构 | **PASS（含亮点+1 发现）** | 亮点：reaper 是"第二消费者不是第二套调度"——零新 kill 原语，杀 100% 经 chrome-stop 归属验证路径（INV-78c grep 守"函数体不含 process.kill"）；touchMap 单写多读（R-INT-07 合规）。**F1（🟡）见下** |
| 1.7 冗余与废弃 | **PASS（1 🔵 见 F2）** | 无死代码（hide 非 mac no-op 是显式平台契约非死分支）；跨边界同步对（CLI defaults ↔ mergeLaunchDefaults ↔ INV-78a flag 集 ↔ TROUBLESHOOTING §8.2）已逐对核对一致且 INV 机械化 |

### 审查发现（按 03 §3.3 标签）

| # | 级别 | 发现 | 机理（真机证据） | 建议 |
|---|------|------|------------------|------|
| F1 | 🟡 issue（非阻断） | **macOS hide 保险丝在生产路径永不触发** | `launchChrome` 的 fuse 是 1.5s 延迟 `setTimeout(...).unref()`，而唯一生产 launch 入口是短命 CLI：`runLaunchChromeCli` 打印后立即 `process.exit()`（V1 实测 spawn→exit <1.5s，stderr **无** `chrome_hide_fuse_*` 事件）；MCP server 未暴露 launch_chrome 工具 → fuse 只在单测（注入 hideFn）里跑过。**实际影响有限**：primary `--no-startup-window` 真机零窗口（V1），fuse 兜的是离屏 fallback 档的 <1s 闪现——而 fallback 恰好只可能发生在 CLI 场景（E5），即"最需要保险丝的路径恰好没有保险丝" | 三选一：① CLI hidden 模式 exit 前等 fuse 到期（1.5s 一次性成本）；② fuse 改为 spawn 探活成功后同步执行；③ server 侧暴露 launch 工具使 fuse 有宿主。任一均可关 🟡 |
| F2 | 🔵 note | 同默认 profile 并行二次 launch → `chrome_exited`（Chrome 单例转发） | V3 首跑实录：9225 占用 `chrome-profile-default` 时起 9226 立即退出（error:"chrome_exited"）；换 `--profile` 隔离后正常。TROUBLESHOOTING 记了手动命令但未记"多开须 --profile 隔离"这一 gotcha | TROUBLESHOOTING 补一行（或 chrome_exited error 文案提示"并行多开请 --profile 隔离"） |
| F3 | 🔵 note | CLI 起的 Chrome 无 reaper（parse18 §5.1 已诚实声明） | 验证为真：无 server 运行时 CLI Chrome 常驻至显式 chrome-stop。这是文档化边界非缺陷，但用户若只用 CLI 将感知不到"用完即关" | 可在 launch-chrome 成功输出里加一行 hint（"idle reaper 只在 lasso server 进程内；纯 CLI 场景请 chrome-stop"） |

**sign-off**：六维 PASS；F1 🟡 建议下版处理（不阻断 ship——primary 路径真机已证零打扰）；F2/F3 🔵 文档级。

---

## 4. Windows 适配结论（代码级审查 + 可编译性，无 Windows 真机——沿用 #W-pending 范式不伪造已验证）

- **flag 组**：`hidden` 档 win 分支双发 `--start-minimized` + `--no-startup-window`（`launch-chrome.ts` §4 构造处，INV-78a grep 钉死不漂移）；`--start-minimized` 对部分 Chrome 版本被忽略（Puppeteer#852 先例）故双发兜底——**shape 由 CI 单测断言（platform:"win" 注入）**。
- **hide 保险丝**：`chrome-hide.ts` 非 darwin 显式 no-op（返 `{ok:false, reason:"non_mac_noop"}`），零 osascript 调用——Windows 保险丝本版不实现，两段式 `ShowWindowAsync(SW_SHOWMINNOACTIVE)` + `SetWindowPos(HWND_BOTTOM)` PowerShell 方案完整落在 `doc/TROUBLESHOOTING.md` §8.2（#W-pending）。
- **idle reaper / 台账 / chrome-stop**：平台无关纯 Node 路径（ps 归属验证在 win 走 tasklist 形态，v1.9 已有实现+单测）。
- **可编译性**：tsc 全绿（win 类型注入路径全覆盖）。
- **结论**：Windows 适配在"代码审查 + 单测 shape 断言 + 文档 + 可编译"四级成立；真机行为留 #W-pending 用户反馈，诚实边界与 v1.9 #W7 一致。

---

## 5. 需求对照裁决

| 需求 | 裁决 | 依据 |
|------|------|------|
| ① 用完即关不等 5min；5min 可配保留；config.json 可配 | **达成** | 默认 `LASSO_LAUNCH_IDLE_MS=60000` 真机 20s 内回收（V3a）；`LASSO_HEADLESS_IDLE_MS=300000` 模板保留（V4d）；`~/.lasso/config.json` 文件层实测改变行为（V4a）且 argv>env>file 优先级实测（V4b/c）；0=禁用回常驻 |
| ② 默认隐藏/最小化，不影响正常使用 | **达成（mac 真机）** | 默认 hidden：0 窗口 + frontmost 不变 + 0 targets（V1）；visible 老行为保留（V2）；Windows 代码级成立（§4） |
| ③ 切屏后操作不阻断/不影响用户；纯静默 | **达成** | 6 步 CDP 操作（建塔/导航/点击/填充/求值/关塔）全程 focusStolen:false、窗口恒 0（V5）；已有浏览器新开 tab 同样零影响（`background:true` 建塔是唯一钥匙，`select_page/bringToFront/PUT /json/new` 激活路径被 INV-78d 禁令 grep 钉死为零命中） |
| ④ 白盒调研 | 由 parse18 调研文档承担；本记录抽其在真机可证的核心断言（no-startup-window 零窗口 / background:true 零抢焦 / 反节流三件套对齐 puppeteer defaultArgs）**全部复现为真** | V1/V5 + 源码比对 |

---

## 6. 验证后现场（清理纪律复核）

```
台账 ~/.cache/lasso/launched-chromes.json = []
pgrep -f 'user-data-dir.*lasso' = 0
lsof :9225-9236 LISTEN = 0
/tmp/lasso-v110-profile-* / lasso-v110-cfg* / 临时 spec = 已全删
git 工作树 = 实施者 v1.10 改动集原样 + 本记录 + v1x-data/（验证证据）
```

用户日常在用的（无 `--user-data-dir=…lasso` 标记的）Chrome 全程未被触碰——chrome-stop / reaper 的杀路径 100% 经 ps 归属验证（INV-77e + V3c 实证）。
