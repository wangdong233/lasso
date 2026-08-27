# 28 · 静默守则审计 —— 全工具面 × 「用户运行守则」流转比对（audit.md）

- **日期**：2026-08-19
- **被审**：lasso-mcp v1.17.3（2259 tests + 81 INV 基线）
- **宪法（用户运行守则，本轮审计唯一判据）**：
  > 「能够后台静默执行就尽量后台静默执行；不能完全静默则用户介入后**及时恢复**静默执行」
- **与 doc/governance/08 的分工**：doc/governance/08 审的是**打扰面**（六维：焦点/窗口/Dock/音频/通知/资源的静态矩阵）；本轮审的是**流转**（时间维度：一个任务从发起到收尾，静默态在哪里被打破、为什么、恢复得多快、恢复靠谁）。两者正交，互不替代。
- **方法**：逐工具从注册入口读源码到最后一层进程/CLI；关键流转补真机锤点（无 Chrome 失败路径时序，见 §2.2）；每条判定带 `file:line` 锚点。真机验证全程避开 9226 / dedao-profile / 在跑 Chrome（自有端口 9239，零进程触碰）。

---

## 0. 守则的可判定拆解

把守则拆成三个可机械化判定的子句，后续所有分类引用：

| 子句 | 判定问题 | 判据 |
|---|---|---|
| **S1 能静默则静默** | 该步骤存在零打扰实现路径时，实现是否选了非静默路径？ | 路径白盒：是否存在零 spawn / 零 UI / 零焦点原语可达同一结果 |
| **S2 介入最小化** | 必须介入时，介入是否**只在不可避免处**发生、信号是否**明确及时**（让上游一次就知道该找人）？ | 介入信号是否有专用 tri-state/错误码；介入面（弹窗数、确认轮数）是否最小 |
| **S3 及时恢复** | 介入完成后，静默态恢复得多快、靠谁？ | 恢复自动化三档：**L2**=系统自动（无人工，下一次调用/会话收尾即恢复）/ **L1**=CC 可调（MCP action，同一会话内可恢复）/ **L0**=人工（用户离开对话去终端跑命令） |

**分类定义**：

- **A 全程静默**：任务全链路零打扰（S1 满足，S2/S3 不触发）。
- **B 介入后恢复静默**：存在合法介入点（登录/2FA/高风险确认），介入后恢复及时性 ≥L1（理想 L2）。
- **C 设计边界**：物理/平台层面不可静默（cgEvent 键鼠合成、用户 Chrome 不静音等），已诚实文档化。
- **D 守则违例**：①可静默却不静默（S1 违例）；②介入后**长期滞留**非静默态（S3 违例）；③恢复依赖人工但**可自动化而未自动化**（S3 违例，L0 可升 L1/L2）；④介入信号缺失/弱化导致介入面放大（S2 违例）。

---

## 1. 全工具面 × 守则矩阵

17 个 `server.tool` 注册工具（`grep -A2 '\.tool(' src/tools/*.ts src/search-local/*.ts` 逐一清点）+ 2 个外围面（doctor 特例、admin 控制面）+ 4 个 CLI 子命令。通道六维静默性沿用 doc/governance/08 结论（不重复论证），本表只新增流转判定。

| # | 工具/流转 | 注册锚点 | 静默路径 | 守则分类 | 判定要点（锚点） |
|---|---|---|---|---|---|
| 1 | `search` | search.ts:236 | 进程内 undici（machine_mcp/brave/serp_http/content_blocks）→ headless 兜底 | **A** | doc/governance/08 §2-§3 白盒零 spawn 零 UI；headless 兜底同 #2 |
| 2 | `browse_headless` | browse.ts:190 | headless Chromium 无窗口 | **A**（Dock 待真机项 S-1 沿袭 doc/governance/08） | puppeteer 默认 `--mute-audio`；INV-78d 禁激活原语零命中 |
| 3 | `browse_logged_in` | browse.ts:230 | hidden 台账 Chrome + 后台 tab + select_page 无 bringToFront | **A**（Chrome 已起时）/ **B**（需登录时）/ **D-1 D-2 D-3**（恢复链与信号，见 §2.1-2.2、§3） | LoggedInChannel.ts:189-211（precreate+snapshot+own-page 全零打扰原语） |
| 4 | `browserbase`（云） | browserbase.ts:124 | 远端云浏览器，本机零 UI | **A** | INV-25 双重解锁默认 OFF；进程本地只有 node shim |
| 5 | `steel`（自托管云） | steel.ts:122 | 本地 Docker 内 Chrome，无窗口系统 | **A** | SteelChannel.ts:1-37 头注：CDP 经 nginx 9223；容器内无 GUI |
| 6 | `desktop` observe（snapshot/find/wait） | desktop.ts:158 | AXAPI 只读 | **A** | DesktopChannel.ts:177-179：observe 不走 fallback，纯读 |
| 7 | `desktop` act（4 档） | desktop.ts:158 | ax → appleScript → cgEvent → screenshotVlm | **C**（档 3 物理边界）/ 档 1-2 **C-**（AXFocused 定焦点、白名单动作激活目标 app） | rust-helper/src/ax.rs:587（AXFocused=true→cmd+a）；DesktopChannel.ts:226-242 档序；doc/governance/08 已固化「设计上占用物理键鼠」 |
| 8 | `interact_roots` | interact.ts:188 | 枚举 roots（list_pages + AX 只读） | **A** | BrowseChannel.ts:600-618 失败返空数组，零打扰 |
| 9 | `interact_observe` | interact.ts:217 | 路由到 browse/desktop 只读面 | **A** | 同 #2/#6 |
| 10 | `interact_act` | interact.ts:235 | 路由 @pN→browse / @wN→desktop | 随路由目标（A 或 C）；INV-23 禁跨 surface fallback | interact.ts 描述路由表；browse/desktop 同款判定 |
| 11 | `fetch_url` | fetch-url.ts:349 | 进程内 undici，redirect:manual | **A** | doc/governance/08 §3；INV-23 禁 fetch↔browse 互 fallback |
| 12 | `fetch_feed` | fetch-feed.ts:448 | 同 doFetchUrl 底座 | **A** | 同上 |
| 13 | `wayback_lookup` | wayback.ts:248 | 同 doFetchUrl 底座 | **A** | 同上 |
| 14 | `screenshot` | screenshot.ts:177 | headless 截图 + 落盘 `/tmp/lasso-screenshot-<uuid>.png` | **A**（产物落盘 = 静默交付） | BrowseChannel.ts:803-848（PNG magic 校验后返路径） |
| 15 | `pdf` | pdf.ts:247 | headless printToPDF + >48KiB 溢盘 `/tmp/lasso-output/@oN`（0o600） | **A** | pdf.ts 头注；applyOutputEnvelope |
| 16 | `network` | network.ts:398 | headless 原生 list_network_requests | **A** | 1.7.0 原生工具直调 |
| 17 | `read_text` | read-text.ts:75 | 读本地溢盘文件分页 | **A** | 进程内 fs；ref 不跨进程 |
| 18 | `search_local` | register-search-local-tool.ts:126 | mdfind spawnSync ≤5s + SQLite 只读副本 | **A** | mdfind.ts:10-13（INV-81(d) 零网络） |
| — | `doctor`（MCP 工具） | doctor-tool.ts:26 | 只读探测（含 2s 超时 CDP 探针） | **A**（探测本身零打扰） | doctor.ts:538-545 /json/version GET |
| — | `admin` | admin.ts:208 | 控制面（capability/provider/profile/cookie_restore/tab_restore） | **B 面**：用户显式 opt-in 的介入接口 | admin.ts:83-86（cookie_restore/tab_restore 显式 opt-in；INV-52） |
| — | CLI `launch-chrome` | index.ts:1442 | hidden 档（默认）零窗口 | **A**（hidden）/ **B 入口**（visible 首登） | launch-chrome.ts:340-345（--no-startup-window）+ :338 恒 --mute-audio |
| — | CLI `chrome-stop` | index.ts:1454 | 归属验证后树杀 | 收尾出口（S3 的 L0 终止出口） | chrome-stop.ts 红线：只杀台账在案 pid |
| — | CLI `chrome-hide` / `chrome-show` | index.ts:1461-1462 | PID 定向 AppleScript 显/隐 | **B 的恢复出口（L0）** | chrome-hideshow-cli.ts:30-72；chrome-hide.ts:68-101 |
| — | CLI/工具 `doctor` 输出 | index.ts:1427 | stdout JSON | **守则不适用**：doctor 是**用户主动调用**的自检面（用户索要输出，不存在「后台打扰」语义）；同理 launch-chrome CLI 的 stdout——用户在终端等着看结果。区分判据：**输出由用户显式请求** ≠ agent 后台自作主张出声 | doctor-cli.ts |

**矩阵结论**：17 工具里 14 个纯 A；`browse_logged_in` 是唯一横跨 A/B/D 的工具（登录态流转的宿主）；desktop act 是唯一 C（物理）。**全部 D 类违例集中在「登录态流转」这一条链上**——这正是守则第二句「介入后及时恢复」管辖的领地。

---

## 2. 关键流转白盒

### 2.1 登录流转（launch visible → 用户登录 → chrome-hide）

现状链（全 L0 人工）：

```
用户终端: lasso launch-chrome --mode visible     (launch-chrome.ts:325 模块默认保守 visible；
                                                  config 层默认 hidden——KEY-GUIDE.md:135)
   → Chrome 可见窗口出现（用户登录，2FA 自己解）
用户终端: lasso chrome-hide [--port N]            (chrome-hideshow-cli.ts:30)
   → 台账+归属验证 → hideChromeByPid PID 定向隐藏 (chrome-hide.ts:57-62)
   → 登录态留 profile，CDP 照常 → 恢复静默
```

**守则视角判定**：

1. **介入本身合法**（S2）：登录墙是「不能完全静默」的物理时刻，visible 弹窗是最小介入面——正确。
2. **恢复是 L0 且无自动化候选在位**（S3）：登录完成后，系统**没有任何自动恢复路径**：
   - idle reaper 对 visible 台账 Chrome `continue` 跳过（chrome-idle-reaper.ts，P1 裁决锚点：`launchMode === "visible") continue`）；
   - server 停机收尾 `modes:["hidden"]` 同样豁免 visible（index.ts:1314-1316，P1 v1.17.3 实战根因：曾把用户登录窗口砸掉）；
   - P1 两处豁免**本身正确**（kill 是破坏性出口，用户拥有的窗口不能被后台杀）——但副作用是：**恢复静默的唯一出口是用户记得跑 `lasso chrome-hide`**，且该命令在 README.md / KEY-GUIDE.md / TROUBLESHOOTING.md **零记载**（grep 全零命中，2026-08-19）。见 D-2 / D-4。
3. **「及时」缺锚**：登录完成时刻系统可感知（CDP 在线、快照可 grep 登录墙消失、cookie 集稳定），但无任何组件订阅这个时刻。候选自动化判据与风险评估见 §3 D-2。
4. **保险丝只防出生不打扰收尾**：`scheduleHideFuse` 仅在 spawn 成功瞬间对 hidden 档立即执行（launch-chrome.ts:399-407，F1 修复后为同步执行）——它服务 S1（出生即静默），不服务 S3（登录后转静默）。

### 2.2 browse_logged_in 无可用 Chrome 的失败路径（含真机锤点）

**真机锤点**（自有端口 9239，npx chrome-devtools-mcp@1.7.0 --browser-url，零 Chrome 在跑；2026-08-19 实测，脚本 `/tmp/lasso-audit-nochrome.mjs`）：

```
[t+9064ms] initialize OK   ← MCP server 无 Chrome 也照常起来（npx 冷启动 9s）
[t+57ms]    navigate_page 返回 isError=true:
            "Could not connect to Chrome. Check if Chrome is running.
             Cause: Failed to fetch browser webSocket URL from
             http://localhost:9239/json/version: fetch failed"
```

**lasso 侧路径**（BrowseChannel.ts:304-368）：`getMcpClient()` 各辅助探针（precreate/snapshot/own-page/reconcile）全部 warn 降级不阻断 → `doNavigate` 收到 isError → 不命中 NAV_ERROR_SIGNATURES（BrowseChannel.ts:698-699 无 "connect"/"chrome" 签名）→ throw `nav_error:Could not connect to Chrome...` → `classifyBrowseError` 落 **outcome=unknown**（BrowseChannel.ts:1159-1174）→ CC 收到 unknown + 裸错误串。

**守则视角判定**：

- 失败**诚实且快**（热路径 57ms），无重试风暴（initialize 成功故 `_spawnWithBackoff` 的 5 次退避不触发，SubprocessManager.ts:494-557）——这部分合格。
- 但**恢复链是 L0 且断在对话外**（D-1）：
  1. 错误结果**无 next_step**——doctor 有（doctor.ts:552-553 `next_step: "重启 Chrome with --remote-debugging-port=..."`），browse 结果没有；CC 只能靠描述文本自己回忆（descriptions.ts:205-207 只有 REQUIREMENTS 两行，未给修复命令）。
  2. **launch-chrome 是 CLI-only**（index.ts:1442-1443）；admin 的 19 个 action 无 launch/chrome 生命周期项（admin.ts:63-87 枚举）→ 任何 MCP 客户端（含 CC 自身若无 shell 权限）都无法在会话内拉起 Chrome。修复动作「起一个 hidden 档 Chrome」本身是 **S1 可静默**的（零窗口零焦点零声音，KEY-GUIDE.md:135），却被推给用户终端。
  3. 「无 Chrome→自动起 hidden→探测登录墙→自动切 visible 等登录→检测登录完成→自动 hide 回静默」全链自动化**裁决**见 §4-C4：**分阶段 DECISION，不建议本轮整链实施**。

### 2.3 C1 elicitation 确认后同轮继续（守则完美案例，确认）

链路：StepEngine → `HighRiskGate.assessStep`（HighRiskGate.ts:147-249）命中 pattern → `elicitationPort.confirmHighRisk`（:203）→ `SdkElicitationPort`（ElicitationPort.ts，SDK `elicitInput` 回合内表单）→ 用户三选一：

- **accept** → `blocked=false` + `reason="high_risk_elicited:<kind>"`（:217-226）→ **同一轮、同一 chain 内**该步继续执行——介入面 = 一次表单，恢复时延 = 0，恢复档位 = **L2**（无人工重启/重试）。
- **decline/cancel** → 现行 blocked 路径 byte-identical（:233-237）；unavailable/异常 → fail-closed（:207-216）。
- 装配锚点：index.ts:809 `logged_in.setElicitationPort(new SdkElicitationPort(server))`。

**确认结论**：这是守则第二句的标杆实现——「介入（一次确认）→ 及时恢复（同轮继续）」。且 accept 无记忆（INV-14 anti-gaming 延伸）保证介入最小化不会被稀释成永久授权。FT-DEF-1（HighRiskGate.ts:42-47）修复后真机有效。**全系统应以 C1 为范式评估其它 B 类流转的恢复档位。**

### 2.4 2FA/登录墙：用户过一次后恢复

- 铁律：不解 2FA/不自动登录（LoggedInChannel.ts:8-10）——S2 正确（介入不可避免处交给用户）。
- **恢复检测是自动的（L2）**：`_detect2FA` 在**每次** getMcpClient 重探（LoggedInChannel.ts:198——注释写「首次」但代码无条件执行），用户在本机 Chrome 完成登录后，**下一次 browse 调用即清除** twoFaPending（:416-418），无需重启会话。
- **但信号到不了 CC（S2 违例面）**：twoFaPending 只进 `status().note`（:429-436），而 status() 只被 doctor/内部健康检查消费；browse 工具结果**从未携带** NEEDS_MANUAL_2FA。描述承诺的「returns outcome=didnt + error='NEEDS_MANUAL_2FA'」（descriptions.ts:212-214）**无生产者**——全 src grep 无任何路径 throw/return 该错误串（消费端全是死的：classifyBrowseError BrowseChannel.ts:1161、outcome.ts:111 stop-word 均等一个不存在的 producer）。→ D-3。
- **tab_restore（S3 收尾）**：快照+diff 只关自增 tab（TabSession.ts 红线：关闭目标只来自 diff）；三触发口全在位——admin 显式（admin.ts:566）/ idle 回收 hook（index.ts:500-505）/ server 停机（index.ts:1314-1316 区段）——**L2 自动收尾，合格**。

### 2.5 desktop 四档（如实分类）

| 档 | 原语 | 守则分类 | 锚点 |
|---|---|---|---|
| 1 ax | AXAPI performAction | **C-**（AXFocused=true 定焦点等最小 UI 介入；部分动作激活目标 app） | rust-helper/src/ax.rs:587 |
| 2 appleScript | osascript 白名单（三层纵深，脚本字面量只在 Rust 端） | **C-**（白名单动作激活目标 app 是功能本体） | apple-script-whitelist.ts:1-35 |
| 3 cgEvent | 物理键鼠事件合成 | **C**（物理占用，无静默形态——KEY-GUIDE.md:135 诚实声明） | DesktopChannel.ts:226-242 档序 |
| 4 screenshotVlm | 截图 + VLM | **A**（只读） | ScreenshotVlmProvider.ts |
| observe 全档 | AXAPI 只读 | **A** | DesktopChannel.ts:177-179（observe 不走 fallback） |

desktop 的「介入」不适用守则第二句的「恢复」语义——它不是流程性介入而是**持续占用**，分类如实落 C。

### 2.6 云浏览器 / Steel

- Steel：本地 Docker 容器内 Chrome，经 nginx 9223→9222 CDP（SteelChannel.ts:28-37）；容器无窗口系统 → **A**。cookie 不出本地。
- Browserbase：远端云 → **A**（本机只有 node shim 子进程）。
- 两者默认 OFF（INV-25 双重解锁）——「不用时零存在感」本身就是 S1。

### 2.7 screenshot / pdf / 落盘产物

产物 = 文件路径/溢盘引用，交付方式静默：`/tmp/lasso-screenshot-<uuid>.png`（BrowseChannel.ts:835）、`/tmp/lasso-output/@oN`（0o600，pdf.ts 头注）。**A**。产物消费（read_text 分页）亦 A。

### 2.8 doctor / CLI 输出（守则不适用，说明）

doctor（工具与 CLI）、launch-chrome/chrome-stop/chrome-hide CLI 的 stdout/stderr JSON 是**用户显式请求的输出**——用户在终端主动运行命令并等待结果，不存在「后台 agent 打扰用户」的语义前提，守则（约束 agent 对用户的不必要打扰）**不适用**。判据固化：**输出由用户显式发起的调用产生** ≠ agent 自作主张出声。注意边界：server 进程内的结构化日志走 stderr→CC 的 MCP 日志文件（util/logger.ts:4），同样不达用户终端——两路径均不构成守则违例。

---

## 3. D 类违例清单

> 每条：现状锚点 / 违反守则哪一句 / 修复方案 / 风险评估。定级见 §4。

### D-1 browse_logged_in 无 Chrome：静默可做的恢复被推给人工终端（S1+S3）

- **现状锚点**：真机锤点 §2.2（57ms isError + outcome=unknown 裸错误）；descriptions.ts:205-207（REQUIREMENTS 无修复命令）；doctor.ts:552-553（next_step 只存在于 doctor 面）；admin.ts:63-87（19 action 无 Chrome 生命周期项）；index.ts:1442（launch-chrome CLI-only）。
- **违反**：S1「能够后台静默执行就尽量后台静默执行」——修复动作（起 hidden 档 Chrome）零窗口/零焦点/恒静音（launch-chrome.ts:334-345），静默可行却必须由用户离开对话去终端执行；S3——恢复档位 L0，且**可自动化而未自动化**。
- **修复方案（分层）**：
  - **a（低风险）**：`BROWSE_LOGGED_IN_DESCRIPTION` 补一段「Chrome not running」运行手册：`outcome=unknown + "Could not connect to Chrome"` → 跑 `lasso launch-chrome`（首登 `--mode visible`，登录后 `lasso chrome-hide`）——CC 读了描述就知道下一步，无 shell 的客户端也知道该请用户做什么。
  - **b（中风险）**：admin 新增 `chrome_launch` action（mutation 必传 reason；默认 hidden 档；台账+归属验证复用）——恢复档位 L0→L1（CC 会话内可恢复）。
  - **c（整链自动）**：见 C4，DECISION。
- **风险评估**：a 零行为变化（无描述快照测试，grep 证实）；b 中——agent 获得 spawn GUI 进程能力，需 reason 审计 + 仅 hidden 默认 + 端口冲突预检（P3：非 CDP 占口 port_in_use_non_cdp 已有诚实拒绝，launch-chrome.ts:312-321）；c 高（登录墙检测假阳/假阴 + 焦点抢占时机 + 并行工作流端口冲突面）。

### D-2 登录完成后无任何自动恢复静默的出口（S3）

- **现状锚点**：chrome-hideshow-cli.ts:30-72（唯一恢复出口，L0 人工 CLI）；chrome-idle-reaper.ts visible 跳过 + index.ts:1314-1316 停机 modes:["hidden"]（P1 v1.17.3 双豁免——**kill 类出口的正确裁决，但 hide 类出口从未建设**）；launch-chrome.ts:399-407 保险丝只管出生。
- **违反**：S3「介入后**及时恢复**静默执行」——介入（登录）完成后系统进入**无限期非静默驻留**：可见窗口 + Dock 常驻 + 用户前台可抢，直到用户主动想起 chrome-hide。恢复可自动化（登录完成检测在 CDP 层可观测）而未自动化。
- **修复方案（候选判据）**：仅对**台账在案 visible 档** Chrome（永不触碰用户自开 Chrome——chrome-hide.ts:4-7 红线）：①登录墙消失（快照 grep TWOFA_KEYWORDS 清零 + URL 离开登录域）+ ②cookie 集稳定 N 秒 + ③无 CDP in-flight 操作 → 自动 hideChromeByPid（非 kill，登录态无损，chrome-show 可逆）。配置 `LASSO_AUTO_HIDE_AFTER_LOGIN`，**默认 off**。
- **风险评估**：中高。假阳性（用户登录后正在看页面/多步登录中途）会把窗口从用户眼前收走——虽可 chrome-show 恢复但体验突兀；cookie 稳定判据站点差异大（滚动刷新 token 的站点永不「稳定」）；判据①复用 D-3 的检测器，依赖 D-3 先落地。**必须 opt-in + 默认关**，交用户裁决。

### D-3 NEEDS_MANUAL_2FA「承诺未实装」——介入信号缺失（S2）

- **现状锚点**：descriptions.ts:212-214（向 CC 承诺 didnt + NEEDS_MANUAL_2FA）；LoggedInChannel.ts:397-427（_detect2FA 只写 twoFaPending）+ :429-436（唯一消费者 status().note，browse 结果不可见）；全 src grep 无该错误串生产者；死消费端三处：BrowseChannel.ts:1161 / outcome.ts:111 / browse.ts:249-251 注释。
- **违反**：S2「介入最小化」——登录墙是合法介入点，守则要求此刻给上游**明确、及时、一次到位**的介入信号。现状 CC 收 worked + 登录页快照，需自行从内容推断，可能在登录页上继续 click/fill 试探（甚至触发 HighRiskGate 逐次 elicitation）——介入决策被稀释、介入面被放大、轮次被浪费。
- **修复方案**：navigate 后对目标页快照做登录墙判定（词表复用 TWOFA_KEYWORDS + URL pattern + 密码输入框 selector 组合）→ throw `needs_manual_2fa` → classifyBrowseError 既有分支接住 → didnt 终止（fallback 引擎 stop-word 已在位，outcome.ts:111）。
- **风险评估**：中。词表粗筛假阳性（正文讨论 "verification code" 的普通文章页被误判 didnt）——LoggedInChannel.ts:43 注释自认「粗筛，v0.3 升级 selector-based 探测」；需组合判据 + 仅 navigate 后首屏判定 + didnt 文案带「确认后在 Chrome 完成登录再重试」提示。行为变化（worked→didnt）影响下游，需用户拍板判据。

### D-4 B 级恢复出口零测试 + 零用户文档（S3 的可维护性/可发现性）

- **现状锚点**：test/ 全树 grep `chrome-show|showChromeByPid|chrome-hideshow` 零命中；chrome-hide.spec.ts 仅 3 用例全测 hide 方向；README.md / doc/usage/01-KEY-GUIDE.md / doc/usage/02-TROUBLESHOOTING.md grep `chrome-hide` 零命中；README.md:290-296 首登指引仍是 v1.8 语境「第一次在这个窗口登录你的账号」——但 v1.10 起默认 hidden 档**零窗口**，用户照文档找不到「这个窗口」（KEY-GUIDE.md:135 同题）。
- **违反**：S3——「及时恢复」的唯一出口（chrome-hide/show）无回归防护：上游一次重构（AppleScript 片段、台账 schema、verifyOwnership 签名）即可让它静默失效，B 类流转退化成永久非静默（D-2 恶化）；文档缺失让恢复出口对用户**不可发现**，「及时」无从谈起。README 首登指引与 hidden 默认矛盾直接制造 S2 介入混乱（用户不知道该在哪登录）。
- **修复方案**：①补 `chrome-hideshow` spec（showChromeByPid 与 hide 的脚本极性/平台 no-op/TCC 降级对称性 + CLI 归属验证白盒锚点，全 mock 注入零真机）；②README「抓登录态页」小节改写为 P4 三步（`--mode visible` 首登 → 登录 → `chrome-hide` 转后台 + `chrome-show` 可逆）；KEY-GUIDE §B 同步。
- **风险评估**：低（纯测试 + 文档，零行为变化）。

---

## 4. 自动化候选分级

### GO（本轮做，已实施）

| # | 项 | 对应 | 内容 | 理由 |
|---|---|---|---|---|
| G1 | chrome-hideshow 测试 + 用户文档 | D-4 | 新 spec 覆盖 show 方向 + CLI 白盒锚点；README/KEY-GUIDE 补 P4 登录三步 | 零行为变化、保护唯一恢复出口、让「及时恢复」可发现 |
| G2 | browse_logged_in 描述补「Chrome not running」运行手册 | D-1a | 描述内嵌失败签名→修复命令映射（含首登 visible→hide 流） | CC 在 tool-selection 面即可自愈/准确转告，零代码行为变化 |

### DECISION（交用户裁决）

| # | 项 | 对应 | 价值 | 风险 | 建议 |
|---|---|---|---|---|---|
| C1 | admin `chrome_launch` action | D-1b | 恢复档位 L0→L1（CC 会话内拉起 hidden Chrome，全程静默闭环） | agent 可 spawn GUI 进程；需 reason 审计 + hidden 默认 + P3 端口预检 | 建议做，但走独立裁决轮（新增 mutation action 面） |
| C2 | visible 台账 Chrome 登录后自动 hide | D-2 | S3 的 L2 闭环（介入→自动恢复静默） | 假阳性抢窗口；判据依赖 C3 | opt-in `LASSO_AUTO_HIDE_AFTER_LOGIN` 默认 off，依赖 C3 落地后再议 |
| C3 | NEEDS_MANUAL_2FA 生产者实装 | D-3 | S2 信号闭环；C2 的判定前置件 | 词表假阳性（需 selector+URL 组合判据）；worked→didnt 行为变化 | 建议做，判据设计需单独评审（描述已承诺，属还债） |
| C4 | 无 Chrome 全自动恢复链（自动起 hidden→探墙→自动 visible→等登录→检测完成→自动 hide） | D-1c | 把 ~5 分钟人工往返压到 ~30s「窗口弹-登录-窗口自隐」 | 叠加 C1-C3 全部风险 + 焦点抢占时机 + 与并行工作流端口冲突 | **整链不建议本轮做**；C1-C3 各自落地后链路自然成形，届时再验收 |

### NO-GO（不做，理由）

| # | 项 | 理由 |
|---|---|---|
| N1 | desktop cgEvent「静默化」 | 物理边界（C 类）：CGEvent 合成的就是物理键鼠事件，静默即失能（KEY-GUIDE.md:135 诚实声明；doc/governance/08 fix.md 固化） |
| N2 | 自动登录 / 解 2FA | 铁律（LoggedInChannel.ts:8-10）+ 凭证安全边界 |
| N3 | hide/kill 用户自开（非台账）Chrome | 红线：永不按进程名操作（chrome-hide.ts:4-7 E8 实测事故级结论）；P1 精神——用户拥有的窗口后台无权处置 |
| N4 | visible Chrome 的自动 kill 出口（idle/停机再纳入） | P1（v1.17.3）实战根因已裁决反对：短命 server 退出砸掉用户登录窗口；恢复静默只能用 **hide**（无损可逆），永远不能用 kill |

---

## 5. 门禁与实施记录

- GO 项 G1/G2 实施与验证见同目录 `fix.md`。
- 门禁：`npm run build` ✅ / `npm test`（基线 2259 不减）✅ / `npm run check-invariants`（81/81 不减）✅——详见 fix.md。
