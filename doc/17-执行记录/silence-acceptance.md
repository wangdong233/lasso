# 静默性验收执行记录（silence-acceptance.md）

- **日期**：2026-08-19
- **执行员**：Lasso 测试用例扩展与验收 agent（零 src/test 改动；仅新增本文件与 `silence-data/` 证据）
- **被测**：lasso-mcp v1.17.2 工作树（dist 构建 2026-08-19 11:13；含 doc/27 fix.md 三修复 F-1/F-2/F-3）
- **用例来源**：doc/17 §2.17（本轮新增，从 doc/27 终版矩阵回归化）
- **环境**：macOS 12.7.6（Darwin 21.6.0，Intel MBP）· Chrome 150.0.7871.182 · Node 24.12.0 · chrome-devtools-mcp@1.7.0（npx 暖缓存）
- **执行纪律**：串行 + 用例间 2s 间隔；每条前置记录前台基线；预存进程**全数零触碰**（清单见 §0）；结束清理零残留（§9 终态实录）
- **方法底座**：frontmost 立即+1s 双采（osascript System Events）+ PID 级 150-200ms 轮询（ts05b/ts06）+ Foreground ASN 计数（lsappinfo）+ 活进程 cmdline flag 断言（ps）+ ppid 闭包进程树三采样

## 0. 预存进程清单（执行前快照，全程零触碰）

| pid | 归属 | 处置 |
|---|---|---|
| 2420 | 用户自开 Chrome（执行开始时 0 窗口；期间用户自发使用，窗口 0→3，frontmost 多次为它——见 §5） | 零触碰 |
| 6141 | 另一会话 headless Chrome | 零触碰 |
| 3084→3200→3323 / 5517→5711→5735 | 两组其他会话 chrome-devtools-mcp 树（npm exec → cdm → node） | 零触碰（作为差集排除基线） |

前台基线：`Code`（用户 VSCode）——执行期间用户自发切换到自己的 Chrome（非 lasso 行为，§5 有 PID 级证据链）。

## 1. T-SILENCE-01 — search 全链纯查询零打扰：**pass**

- 执行：`silence-data/ts01-02.mjs`（StdioClientTransport 托管 dist server；结果 `ts01-02-result.json`）
- 关键输出：

| op | ms | frontmost（before→imm/1s） | Foreground ASN | lasso 树 |
|---|---|---|---|---|
| search（machine_mcp 服务） | 2247 | Code→Code/Code | 1→1 | 0 |
| （02a）fetch_url | 617 | Code→Code/Code | 1→1 | 0 |
| （02b）fetch_feed | 1535 | Code→Code/Code | 1→1 | 0 |
| （02c）search_local files | 1111 | Code→Code/Code | 1→1 | 0 |

- search worked 10 条（真搜非缓存路径直跑）；server 关闭后残留 cdm pid 差集 = []；stderr 全程零 `display notification`/`afplay`/`osascript`。
- 裁决：六维全零（①③⑤采样零变化 ②④结构+采样零 Chromium）。与 doc/27 T1 结论一致。

## 2. T-SILENCE-02 — fetch_url / fetch_feed / search_local：**pass**

同 §1 表（02a/02b/02c 行）。三 op 串行 2s 间隔全 worked，六维零变化。mdfind 路径（files 源 5 条）无 Spotlight 面板类 UI 事件（ASN/fm 零变化）。

## 3. T-SILENCE-03 — browse_headless 全生命周期：**pass**

- 执行：`silence-data/ts03.mjs`（结果 `ts03-result.json`）
- 关键输出：

| 断言 | 实测 |
|---|---|
| ① frontmost | navigate/extract/evaluate 三 op 全部 Code→Code/Code |
| ③ ASN 轮询（250ms × 59 样本，覆盖全生命周期） | max Foreground = **1**（恒基线，headless 实例未注册任何 Foreground ASN → 零 Dock 图标/零 cmd-tab/零闪现） |
| ② 窗口 | 树内 Chromium 全程无窗口（headless=new） |
| ⑥ 资源峰值 | **9 进程 / 798MB**（口径注：本轮树根含 npx shim + cdm node + 全部 Chrome helper 的 ppid 闭包；doc/27 T2 的 6 进程/393MB 只计 Chromium 树——两口径均如实记录，量级一致） |
| 退出残留 | client.close() 后 6.5s：自有树 **0 进程**（roots=[]）；预存 6 pid 差集零新增 |
| T-SILENCE-07（headless 侧） | 主进程 pid 83881 cmdline：`--mute-audio` ✓ `--headless=new` ✓（子 helper 83893 无 flag 属正常——mute 是浏览器主进程级 flag） |

## 4. T-SILENCE-04 — launch-chrome hidden：**pass（Dock +1 = 已知边界确认）**

- 执行：`silence-data/ts04.mjs`（port 9235；结果 `ts04-result.json`）
- 关键输出：

| 断言 | 实测 |
|---|---|
| ① frontmost | Code→Code（launch 前后） |
| ② 窗口 | windowsOfPid(84902) = **0**；`/json/list` page targets = **0** |
| ④ flags（活 cmdline） | `--no-startup-window` ✓ `--mute-audio` ✓ `--no-first-run` ✓ `--no-default-browser-check` ✓ `--remote-debugging-port=9235` ✓（T-SILENCE-07 hidden 侧） |
| ③ Dock | Foreground ASN 1→**2**（hidden Chrome 注册 Foreground ASN——**已知诚实边界**，doc/27 §2 机制固化：根因是有头二进制注册前台应用而非窗口；chrome-stop 后回到 1） |
| 收尾 | chrome-stop exit 0 `killed`；pid 死；台账 `[]`；端口 free；fm 终态 Code |

## 5. T-SILENCE-05 — 连「用户 Chrome」不劫持 pages[0]（F-1 验收）：**pass**

- 执行：`silence-data/ts05.mjs`（首跑，结果 `ts05-result.json`）+ `ts05b.mjs`（PID 级复核轮，结果 `ts05b-result.json` + `ts05b-stderr.log`）
- 环境：替身用户 Chrome（临时 profile + `--no-startup-window` + `--mute-audio`，**不经 lasso 起 = 无台账** → 走 F-1 `ensureOwnPageSelected` 路径）+ CDP WS 预置 2 用户 tab（example.org / example.com，均 background:true）
- F-1 断言全过：

| 断言 | 首跑（ts05） | 复核（ts05b） |
|---|---|---|
| 用户 tab URL 逐 targetId 不变 | a/b 双 tab 全不变 ✓ | ✓ |
| navigate 落 lasso 自建后台 tab | own tab = `…?silence=05` ✓ | ✓（05b） |
| tab 数 | 2→3（仅 +own）✓ | 2→3 ✓ |
| stderr `logged_in_own_page_selected` | ✓（pageId=3, targetId=C6B13397…） | ✓ |
| SIGTERM restore 只关 own | ✓（回到 2 用户 tab） | ✓ |
| 端口/清理 | freed ✓ | freed ✓ |

- **焦点专项（首跑表面异常 → 复核裁决为环境事件，非产品缺陷）**：首跑 fm 出现 `Code→Google Chrome`（立即+1s+final）。ts05b 以 **PID 级 150-200ms 轮询**复核：baseline pid=2420（此时用户已自发切到自己的 Chrome），nav 全生命周期 18 样本 **零 foreign pid、零 test pid（替身 89768 / server 89788）成为 frontmost**；替身窗口全程 0；用户 Chrome 窗口同期 0→3（用户自发使用，非任何 lasso 路径可触达——测试全部操作仅指向替身 9233）。**裁决：首跑转移 = 用户自发活动（同窗口开 Chrome），lasso browse_logged_in 全链零抢焦。**
- **执行勘误（记入用例，防复跑误判）**：首跑曾以 `/json/list` 列表序 [0] 近似 pages[0]——实测 Chrome 会把**新建 target 头插**列表（own tab 创建后列表序变化），该近似不成立；正确断言 = 按 targetId 键控逐用户 tab 对照（两轮均按此通过）。§2.17 表 T-SILENCE-05 状态列已加注。
- 与 doc/27 fix.md L3（s7fix-l3.mjs 直调上游）互补：本轮经**真 dist server MCP 全链**（含 2FA probe / verifyNavigatedPage / reconcile / StateStore），F-1 在完整产品路径上行为一致。

## 6. T-SILENCE-06 — close_page 登记制所有权（F-2 验收）：**pass**

- 执行：`silence-data/ts06.mjs`（port 9234；结果 `ts06-result.json` + `ts06-stderr.log`）
- 环境：替身 + **12 个用户 tab**（example.org/?u=1..12）→ 两轮 navigate 触发 reconcile（总 tab 13 > LRU cap 10）
- 关键输出：

| 断言 | 实测 |
|---|---|
| 12 用户 tab 存活 | navigate×2 + reconcile 后 **12→12**；restore 后 12 ✓ |
| 12 用户 tab URL 不变 | 逐 targetId 位对位 `urls_unchanged_check` = **true** ✓ |
| 自建 tab 是唯一可 close 对象 | own tab 幂等复用 1 个（`logged_in_own_page_selected` 计 1 次）；restore 只关 own（`restore_own_tabs_gone` ✓） |
| 焦点 | 51 样本 PID 级轮询零偏移（baseline 2420 恒定）✓ |
| 清理 | port freed ✓ 临时 profile 删除 ✓ |

- 裁决：13 tab > cap 场景下 reconcile 未关任何用户 tab——**登记制所有权（ownPages 集合 + noteOwnPage 唯一登记路径）行为级验证**，S-10 预言的「淘汰关用户 tab」事故面在修复后不存在。

## 7. T-SILENCE-07 — flag 在位性：**pass**

headless 侧（§3）：主进程 `--mute-audio` + `--headless=new` 在位。hidden 侧（§4）：`--mute-audio` + `--no-startup-window` + `--no-first-run` + `--no-default-browser-check` + 端口 flag 在位。**回归钩子**：headless 静音依赖 puppeteer 默认注入（上游升级必回归本条——S-2）。

## 8. T-SILENCE-08 / 09 — 设计边界与激活原语禁令：**pass**

- **T-SILENCE-08**（不真机执行 desktop act——物理键鼠会打扰用户，违反纪律；按设计声明用例断言锚点）：
  - `rust-helper/src/cgevent.rs:410-464`：六处 `.post(CGEventTapLocation::HID)`（键盘 down/up、鼠标 click/drag/scroll）——物理键鼠合成功能本体在位；
  - `rust-helper/src/ax.rs:587-599`：AXFocused 置位（不可设则 `ax_focus_unsupported` 诚实失败）；
  - `src/desktop/apple-script-whitelist.ts`：音频/通知原语 grep **零命中**；
  - 文档四件一致：README.md:308/:388（"设计上占用键鼠/没有静默形态"）、doc/KEY-GUIDE.md:135、ARCHITECTURE.md:293、doc/TROUBLESHOOTING.md:292。
  - 执行勘误：用例原文锚点写 `CGEventPost`（raw FFI 符号）——实装为 core-graphics wrapper `CGEvent::new_keyboard_event/new_mouse_event` + `.post(HID)`，§2.17 表已改写锚点。
- **T-SILENCE-09**：`node src/invariants/check-invariants.mjs` → **All 81 invariants passed**（含 INV-78(d)：bringToFront token 级零命中 + `"new_page"` quoted 禁令 + select_page 实装锚）；raw grep `bringToFront` 10 命中逐条核对 = check-invariants.mjs 8（注释 7 + 守卫正则 1）+ LoggedInChannel.ts 注释 2，**零代码调用**。

## 9. 清理纪律（终态实录）

```
前台 = Google Chrome pid 2420（用户自己的会话——执行期间用户自发使用，非测试改变；测试从未激活任何自有进程，ts05b/ts06 PID 级轮询在档）
台账 ~/.cache/lasso/launched-chromes.json = []（ts04 chrome-stop 后）
测试自起 Chrome/替身 = 0（pgrep lasso-ts05/05b/06 = 0；ts03 自有树 roots=[]）
测试自起 cdm = 0（pgrep chrome-devtools-mcp 与预存 6 pid 差集 = []）
端口 9233/9234/9235 = free（curl 连接拒绝）
临时 profile（lasso-ts05-*/ts05b-*/ts06-*）= 已删
预存进程全数未动：2420 / 6141 / 3084+3200+3323 / 5517+5711+5735
git：src/test 零改动；新增仅 doc/17 §2.17 + 本目录
```

## 10. 结论与 verdict 总表

| ID | verdict | 关键依据 |
|---|---|---|
| T-SILENCE-01 | **pass** | fm/ASN/树/残留四零 |
| T-SILENCE-02 | **pass** | 三 op 六维零变化 |
| T-SILENCE-03 | **pass** | 59 样本 ASN 恒 1、fm 恒基线、退出树 0 |
| T-SILENCE-04 | **pass**（Dock 边界确认） | 窗口 0/flags 五全/ASN 1→2→1（预期边界） |
| T-SILENCE-05 | **pass** | F-1 五断言全过；焦点 PID 级零抢焦（首跑转移判用户活动） |
| T-SILENCE-06 | **pass** | 12/12 用户 tab 超 cap 存活；own 唯一可 close |
| T-SILENCE-07 | **pass** | headless+hidden 双侧活进程 flag 在位 |
| T-SILENCE-08 | **pass** | 四组锚点 + 文档四件一致（设计契约确认） |
| T-SILENCE-09 | **pass** | INV-78 PASS（81/81）+ raw grep 全注释 |

**9/9 pass，0 fail，0 blocked。** 缺陷：零（两处执行勘误均为用例侧锚点/断言方法修正——`/json/list` 序不可作 pages[0] 键控、CGEventPost 符号名——已回写 §2.17，不动产品）。F-1/F-2 修复在真 dist server 全链复验通过。门禁（build/test/check-invariants 2253+81）见本目录 `gate-output.txt`。

## 11. 证据文件索引（`silence-data/`）

`ts01-02.mjs`/`ts01-02-result.json`（§1/§2）· `ts03.mjs`/`ts03-result.json`（§3/§7）· `ts04.mjs`/`ts04-result.json`（§4/§7）· `ts05.mjs`/`ts05-result.json` + `ts05b.mjs`/`ts05b-result.json`/`ts05b-stderr.log`（§5）· `ts06.mjs`/`ts06-result.json`/`ts06-stderr.log`（§6）· `gate-output.txt`（门禁）。采样库复用 doc/27 `verify-data/probe.mjs`（import 路径引用，零复制）。
