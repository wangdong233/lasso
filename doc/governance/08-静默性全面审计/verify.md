# 27 · 静默性全面审计 —— 真机验证报告（verify.md）

- **日期**：2026-08-19
- **验证员**：独立真机验证 agent（零 src/test 改动；`git status --porcelain -- src test` = 0；仅新增本文件与 `verify-data/` 证据）
- **被测**：lasso-mcp v1.17.1（dist 构建 2026-08-18 20:20，src 无更新于 dist）
- **环境**：macOS 12.7.x（Darwin 21.6.0，Intel MBP）· Chrome 150.0.7871.182 · Node 24.12.0 · chrome-devtools-mcp@1.7.0（npx 缓存命中）
- **前台基线**：`Windows App`（用户 RDP 会话）——**全程未被打扰，结束已还原**（§8 清理纪律）
- **方法**：前台对照法（osascript System Events frontmost 前后采样 + 立即/1s 双采 + T2 全程 250ms 轮询）；窗口计数按 unix id 定向；Dock/cmd-tab 用 lsappinfo ASN type 作判据（`Foreground` 型 = Dock + cmd-tab 资格；`BackgroundOnly`/`UIElement` = 不可见）；资源三采样（进程树 ppid 闭包）；串行 + 2s 间隔；每轮 chrome-stop 收尾。
- **上游理论矩阵**：见同目录 `audit.md`（白盒）。本文件只写真机实测，并对其可疑点 S-1..S-15 逐条裁决。

---

## 1. 实测总矩阵（通道 × 六维）

图例：`零*` = 真机逐项实测无该维事件；`零(f)` = 靠进程 cmdline flag 实证；`●` = 实测确认发生；`△` = 结构性/条件性。

| 通道 | ①OS焦点 | ②窗口 | ③Dock/cmd-tab | ④音频 | ⑤通知 | ⑥资源（实测读数） |
|---|---|---|---|---|---|---|
| `search`（machine_mcp 实跑，10 结果） | 零* | 零 | 零 | 零 | 零 | 极低：server CPU 峰 55.6%（2.1s 一次性），RSS 峰 115MB |
| `fetch_url` / `fetch_feed` | 零* | 零 | 零 | 零 | 零 | 极低：CPU 峰 10.7% / 4.3% |
| `search_local`（mdfind，5 结果） | 零* | 零 | 零 | 零 | 零 | 极低：CPU 峰 9.7%，184ms；Chrome 无感 |
| `serp_http` 快探 | 零*（未直跑：本轮 machine_mcp 全程服务；与 fetch_url 同一 undici 底座，结构等价） | 零 | 零 | 零 | 零 | 低（turndown 进程内） |
| `browse_headless` 全生命周期 | **零***（33.5s 轮询 + 逐 op 采样，frontmost 恒 Windows App） | 零 | **零（S-1 裁决：无 Foreground ASN → 无 Dock 图标、无 cmd-tab 条目）** | 零(f)（活进程 cmdline `--mute-audio` 实证；连另一会话常驻 headless 6141 同 flag 交叉印证） | 零（无 OS 通知路径；stealth spoof 仅页内） | 中：**6 进程 / 393MB**（402,284KB），存活期受 idle reaper 约束；server 退出后树全灭（0 残留） |
| `launch-chrome hidden` + browse_logged_in | 零*（4 op 前后 + launch 全程） | 零（窗口恒 0） | **● Dock 残留（机制实证：hidden Chrome 注册 `type="Foreground"` ASN）** | 零(f)（`--mute-audio` 在 cmdline） | 零 | 中（v1x 实测同型 8 进程/511MB；server 内 60s idle / CLI 起常驻至 chrome-stop） |
| `launch-chrome visible` | **●**（launch 时 frontmost→Google Chrome，预期） | ●（1 窗口） | ● | **零(f)（visible 档也实测 `--mute-audio` + `--no-first-run` + `--no-default-browser-check`）** | 零 | 中 |
| **连"用户"Chrome**（9233 可见窗口替身 + cdm 1.7.0 --browser-url，lasso 同款上游） | **连接本身零抢焦；操作面全零**（navigate/click/fill/evaluate/screenshot/snapshot/wait/list/close_page{pageId}，立即+1s 双采均 Finder） | 零新窗口（tab 级操作） | 零 | △ 结构性：替身实测也带 mute（lasso 起的），**用户自起 Chrome 0 个 mute flag（实测 pid 2420 cmdline）** | 零观测 | 低-中（+1 npx/cdm node 链） |
| 同上·**激活类原语**（lasso 全零调用，INV-78d） | **●** `new_page`（默认前台）：Finder→**Google Chrome**，win 1→2；**●** 裸 `Target.createTarget`（不带 background）：Finder→**Google Chrome** | ●/tab 级 | — | — | — | — |
| 同上·`select_page{bringToFront:true}` | **零（实测不抢 OS frontmost）**——仅激活后台窗口内的 tab（内容层扰动） | 零 | 零 | — | — | — |
| `desktop`（对照，未跑——设计契约） | ● 设计上占用 | ● | n/a | 无白名单音频原语 | △ TCC 首次 | 极低 |

**总回答（用户原始问题）**：五条纯网络路径完全静默（实测）；browse_headless 接近纯静默（Dock/焦点/窗口/音频/通知五维实测全零，唯资源 ~393MB 存活期内底噪）；launch-chrome hidden 唯一可见残留是 Dock 图标（+CLI 起无 idle 回收）；连用户自开 Chrome **操作面真机实测零抢焦**（KEY-GUIDE"个别操作可能抢一次焦点"在 1.7.0 + v1.17.1 下未复现，应更新表述），其真实非零项是 **S-7 tab 内容劫持 / S-9 音频+焦点仿真 / 上游激活类原语的潜在面**；desktop 设计上不可静默。

---

## 2. T1 · 纯查询四工具（search / fetch_url / fetch_feed / search_local）

单 server MCP stdio 串行 4 op，每 op 前后采 frontmost / 用户 Chrome 窗口数 / ASN 计数 / lasso Chromium 树，CPU+RSS 峰值采样（120ms）：

| op | ms | frontmost | 用户 Chrome 窗口 | ASN 计数 | Chromium 树 | server CPU 峰 | 结果 |
|---|---|---|---|---|---|---|---|
| search（machine_mcp 服务） | 2076 | Windows App→Windows App | 0→0 | 不变（raw3/fg1/cdm4） | 0 进程 | 55.6% / 115MB | worked，10 结果 |
| fetch_url（example.com） | 392 | 同上 | 0→0 | 不变 | 0 | 10.7% / 95MB | worked |
| fetch_feed（hnrss.org） | 1846 | 同上 | 0→0 | 不变 | 0 | 4.3% | worked |
| search_local | 184 | 同上 | 0→0 | 不变 | 0 | 9.7% | worked，5 结果 |

- server 关闭后 0 残留进程（`t1-result.json.residual`）。
- **六维全零**；唯一维度⑥读数是一次性 CPU 峰（55.6% 为单核口径、2 秒内），对整机无可感争抢。
- 证据：`verify-data/t1-result.json` / `t1-network.mjs` / `t1-server-stderr.log`。

## 3. T2 · browse_headless 全生命周期（S-1 / S-2 / S-4 / S-5 / 退出路径）

`browse_headless{url:example.com}` navigate（含 npx 冷启）→ extract → evaluate → server 关闭。全程 250ms 轮询 lsappinfo + frontmost（33.5s 窗口）。

| 阶段 | 实测 |
|---|---|
| navigate（含 npx spawn） | 14,187ms，worked；**进程树 6 进程 / 402,284KB（393MB）**，CPU 合计 1.1% |
| 活 cmdline flags | `--headless=new` ✓ `--mute-audio` ✓ `--remote-debugging-pipe` ✓ puppeteer 临时 profile ✓ |
| extract / evaluate | 19ms / 227ms，均 worked |
| **S-1 Dock/cmd-tab** | 轮询期 `Foreground` 型 Chrome ASN 恒 =1（仅用户 Chrome）；我的 headless 实例**未注册任何 Foreground ASN**（T2b 全量 lsappinfo：现存条目 = 用户 Chrome FG / 另一会话 headless BackgroundOnly / Helper UIElement）→ **无 Dock 图标、无 cmd-tab 条目、无闪现** |
| frontmost | 33.5s 全部样本 = `Windows App` |
| 退出 | server close 后 6.5s：新起 Chrome **0 存活**（killAllSync 钩子实证）；**基线 Chrome/其他会话进程全数未动** |
| stderr | 22 行结构化日志全部收进 harness 日志文件，零终端泄漏 |

- npx 说明：1.7.0 已在 npx 缓存，本测为**暖解析**计时；真冷启动只多 npm 下载（网络+磁盘，无 UI，白盒 S-5）。
- S-4 资源结论：393MB/6 进程为存活期底噪（idle 5min 默认回收，server 退出即灭）——与用户历史"多实例卡顿"记忆的对照结论：**单实例可接受，并行多实例是资源风险主源**。
- 证据：`t2-result.json` / `t2-asn-poll.jsonl` / `t2b-lsappinfo-during.txt` / `t2-server-stderr.log`。

## 4. T3 · launch-chrome hidden 复核（v1.17.1 上复现 v1.10 结论）

| 项 | 实测 |
|---|---|
| launch（CLI，默认档） | 5,052ms → pid、**窗口 0**、`/json/list` page targets **0**（仅扩展 background_page/service_worker 内部 target）、frontmost 不变 |
| flags（活 cmdline） | `--no-startup-window` ✓ `--mute-audio` ✓ `--no-first-run` ✓ `--no-default-browser-check` ✓ 反节流三件套 ✓ `--remote-debugging-port=9225` ✓ 默认 profile ✓ |
| **③Dock 残留机制** | hidden Chrome 注册 `type="Foreground"` ASN（lsappinfo 实证）→ Dock 图标 + cmd-tab 条目存在但**零窗口零页面**——与 headless（无 Foreground ASN）形成机制级对照：**Dock 残留的根因是"有头二进制注册 Foreground 应用"而非窗口** |
| chrome-stop | pid 灭、台账 `[]`、端口释放（curl exit 7 连接拒绝；脚本 portReleased=false 为探针 lsof 误报，手工复核已修正） |

- 证据：`t3-result.json`。

## 5. T4 · S-8 焦点逐操作（重点）+ S-7 / S-9 / S-10

### 5a. hidden Chrome + lasso 出厂路径（browse_logged_in，T4a）

hidden Chrome 9223（隔离 profile）→ `LASSO_CDP_PORT=9223` 起 server → 4 op：

| op | ms | frontmost | 窗口 | targets 变化 |
|---|---|---|---|---|
| navigate | 10,470（含 cdm npx 冷启） | WA→WA | 0→0 | 2→3（**precreate 后台 tab +1 = lasso 自建页，非劫持**） |
| extract | 32 | WA→WA | 0→0 | 3 |
| evaluate | 229 | WA→WA | 0→0 | 3 |
| screenshot | 637 | WA→WA | 0→0 | 还原为 2（会话收尾） |

server 关闭后 lasso 自建 tab 全数关闭（无残留）；chrome-stop 干净。**precreateBackgroundTabIfHidden 在 v1.17.1 实际生效**。

### 5b. 可见窗口 Chrome 替身（T4b/c/d/e/e2，S-8 主实验）

`LASSO_LAUNCH_MODE=visible` 起 9233（1 窗口，launch 时 frontmost→Chrome 为预期）→ 预置 tabA(example.com 窗口内活动页) + tabB(example.org 后台页) → 前台切 Finder → 连 `npx chrome-devtools-mcp@1.7.0 --browser-url`（lasso 同款上游）→ 逐操作（每步前重置 Finder，立即+1s 双采）：

| 操作 | frontmost（Finder→imm/late） | 窗口 | 裁决 |
|---|---|---|---|
| **cdp connect 本身**（11.7s） | Finder→Finder | 1 | 不抢焦 |
| navigate_page ×3（example.com/?s8、DDG） | Finder→Finder | 1→1 | 零抢焦 |
| take_snapshot ×4 | Finder→Finder | 1→1 | 零抢焦 |
| **click**（uid=1_3 "Learn more"→iana.org，真跳转验证） | Finder→Finder | 1→1 | 零抢焦（trusted 事件无需 OS 焦点） |
| **fill**（uid=1_4 DDG combobox，"Successfully filled"） | Finder→Finder | 1→1 | 零抢焦 |
| evaluate_script（含取值回读） | Finder→Finder | 1→1 | 零抢焦 |
| take_screenshot | Finder→Finder | 1→1 | 零抢焦 |
| wait_for | Finder→Finder | 1→1 | 零抢焦 |
| list_pages | Finder→Finder | 1→1 | 零抢焦 |
| close_page{pageId:2}（正确形态） | Finder→Finder | 1→1（页 2→1） | 零抢焦 |
| **阳性对照：new_page（上游默认前台；lasso 零调用）** | Finder→**Google Chrome**（imm+late 持续） | **1→2** | **真抢焦** |
| **阳性对照：裸 Target.createTarget（无 background）** | Finder→**Google Chrome** | 1→1（前台 tab） | **真抢焦** |
| 阴性对照：裸 Target.createTarget{background:true}（lasso precreate 同款） | Finder→Finder | 1→1 | 零抢焦 |
| select_page{bringToFront:true}（INV-78d 禁用原语） | Finder→Finder | 1→1 | **实测不抢 OS frontmost**（仅激活后台窗口内 tab） |

**方法灵敏度**由三个阳性对照证明（检测手段真实可测出抢焦）。未直跑：pdf / network / console 采集器（白盒判被动；与已测只读类同构，如实标注未实测）。

### 5c. S-7 tab 内容劫持（实测确认）

T4b：navigate_page 前后 `/json/list` diff —— `[example.org(后台), example.com]` → `[example.com, example.com/?s8=nav]`：**被换内容的是 pages[0]（用户第一个 tab，此处为后台的 example.org），无焦点变化**。T4c 干净复现：`[example.com, example.org]` → `[example.com, example.com]`。与白盒（McpContext.selectPage(pages[0])）一致。lasso 侧仅 hidden 台账 Chrome 有 precreate 保护（T4a 实证），**连用户可见 Chrome 无保护**。

### 5d. S-9 焦点仿真 + 音频（机制级分辨）

| 测点 | 结果 |
|---|---|
| 连接前 tabB（后台）`document.hasFocus()` | false |
| cdm 连接后 2s（两轮） | **仍 false**（白盒"连接即全 tab 仿真"未复现；上游 stderr 无报错） |
| 手工裸 CDP `Emulation.setFocusEmulationEnabled{true}` | tabB 立即 **true**，且 **frontmost 仍 Finder**（仿真本身不抢 OS 焦点）→ 机制在 Chrome 150 有效 |
| cdm 对该页执行 evaluate_script/fill 等带 session 操作后 | 该页 `hasFocus()` = **true**（前台仍是 Finder）→ **仿真确实落地，但为活动触发而非连接即发**（疑似 puppeteer 状态栈在 session attach 后重放） |
| cdm 断开后 | false（未观测到残留；样本量 1，如实标注） |
| 音频 | lasso 起的 Chrome 两档实测 `--mute-audio`；**用户自起 Chrome（pid 2420）cmdline 0 个 mute/首跑 flag**——S-9(b) 结构性确认：browse 到自动播放页会真出声（未播放实测以免打扰用户） |

### 5e. S-10 close_page 契约错配（wire 级实测）

| 形态 | wire 结果 | 净效果 |
|---|---|---|
| `close_page{url:...}`（lasso TabRegistry 现行形态） | **MCP -32602 Input validation error**（上游 schema 是 `pageId:number`） | 页未关（lasso catch 吞错 → 良性） |
| `close_page{pageId:999}` | "Error: No page found" | 页未关 |
| `close_page{pageId:2}` | 成功，页 2→1，零抢焦 | 关掉指定页——**若 TabRegistry 未来改传真实 pageId 且映射到用户 tab，将关用户的页**（修复向注意） |

---

## 6. T5 · 音频 / 通知 flag 面

- **`--mute-audio` 在位性**：hidden（T3 cmdline）、headless（T2 活进程 + 常驻 6141 交叉）、**visible（T5 独立 5s 实测：`--mute-audio` + `--no-first-run` + `--no-default-browser-check` 并 `--remote-debugging-port`）** —— 三形态全覆盖。
- **通知原语**：src grep `display notification / afplay / say / new Notification / Notification.requestPermission` **零命中**；osascript 全 src 仅 4 个受控文件（chrome-hide 静默保险丝 / launch-chrome / desktop AppleScriptProvider 白名单 / check-invariants 守卫）。
- 测试期间（全新临时 profile，零站点授权）无任何通知产生；headless 的 stealth Notification spoof 为页内 JS（白盒 + 无系统通知观测）。

---

## 7. 可疑点清单裁决（对照 audit.md §7）

| # | 裁决 | 实测依据 |
|---|---|---|
| S-1 headless Dock | **PASS（无 Dock/cmd-tab）** | 全程 Foreground ASN 恒 1；T2b 全量 lsappinfo 无新 Foreground 条目 |
| S-2 headless 音频 | **PASS（flag 在位）** | 活 cmdline `--mute-audio`；升级上游时回归 |
| S-3 headless 通知 | PASS（无路径） | 无观测 + 白盒 |
| S-4 headless 资源 | 量化 | 6 进程/393MB/存活期；退出 0 残留 |
| S-5 npx stderr | PASS | 22 行结构化日志全收 harness 文件 |
| S-6 search 链末隐式起浏览器 | 未真机（白盒维持） | 伪造全源熔断需侵入配置，本轮不做；建议文档化 |
| S-7 tab 劫持 | **确认（两轮复现）** | pages[0] 内容被换、零焦点变化 |
| S-8 逐操作焦点 | **PASS：操作面全零抢焦**（含 connect） | §5b 表；阳性对照证明测法灵敏 |
| S-9 音频+焦点仿真 | **细化**：连接不即发、操作后落地（hasFocus=true 但不抢 OS 焦点）；用户 Chrome 不静音（结构） | §5d |
| S-10 close_page 错配 | **细化**：wire 级是 -32602 校验错（非静默），净效果用户 tab 不被关 | §5e |
| S-11 离屏 fallback 闪现 | 未测（TCC 已授权机器走主路径） | 白盒维持 |
| S-12 CLI 无 reaper | 边界确认（本轮全部显式 chrome-stop 收尾干净） | §8 |
| S-13 desktop 设计占用 | 未跑（设计契约） | — |
| S-14 search_local | **PASS** | T1 四维零 |
| S-15 redirect 升级 | 无需验证（白盒穷尽） | — |

**对 KEY-GUIDE 的修正建议**：连用户 Chrome 的边界表述应从"个别操作可能抢一次焦点"升级为——①操作面（navigate/click/fill/evaluate/screenshot/snapshot/wait/list）真机零抢焦；②真实非零项 = pages[0] tab 内容劫持（S-7）+ 用户 Chrome 不静音（S-9b）+ 操作后该 tab hasFocus 仿真（S-9a，不抢焦点但影响后台 tab 行为）；③抢焦仅存在于 lasso 零调用的激活原语（new_page 默认前台 / 裸 createTarget 默认——本机实证均真抢焦；select_page bringToFront 本机不抢 OS 焦点但换活动 tab）。

---

## 8. 清理纪律（终态实录）

```
frontmost = Windows App（已还原）
台账 ~/.cache/lasso/launched-chromes.json = []
lasso 起 Chrome 存活 = 0（pgrep user-data-dir.*lasso = 0）
/tmp/lasso-t4*/t5*-profile 全删
端口 9223/9225/9233 = free（curl 连接拒绝）
预存进程全数未动：用户 Chrome 2420 / 另一会话 headless 6141 / cdm 对 3084+3200、5517+5711
git：src/test 0 改动；新增仅 doc/governance/08-静默性全面审计/{verify.md,verify-data/}
```

## 9. 证据文件索引（`verify-data/`）

`probe.mjs`（采样库）· `t1-network.mjs`/`t1-result.json`（T1）· `t2-headless.mjs`/`t2-result.json`/`t2-asn-poll.jsonl`/`t2b-asn-type.mjs`/`t2b-lsappinfo-during.txt`（T2/S-1）· `t3-result.json`（T3）· `t4a-hidden-loggedin.mjs`/`t4a-result.json`（5a）· `t4b-focus.mjs`/`t4b-result.json`（5b/S-7）· `t4c-gaps.mjs`/`t4c-result.json`/`t4c-snapshot-*.txt`（5c/5d/5e）· `t4d-final.mjs`/`t4d-result.json`/`t4d-snapshot.txt`（close_page 三形态/S-9）· `t4e-clickfill.mjs`/`t4e-*-snapshot-*-full.txt`/`t4e2-fill.mjs`/`t4e2-result.json`（click/fill 真效）· 各轮 server/cdm stderr 日志。
