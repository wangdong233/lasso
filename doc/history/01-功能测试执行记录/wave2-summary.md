# Wave2 汇总（fail 重测 + 解锁项 + 抽样回归）

- **被测版本**：lasso-mcp **v1.8.0**（三面板各自当次 `npm run build`，server stderr `lasso_start version=1.8.0` 实证；1711 tests + 76 INV 全绿源码）
- **子记录**：`wave2-browse.md`（browse/登录态面板）、`wave2-desktop-cli.md`（desktop+CLI 面板）、`wave2-gov.md`（治理面板 + 全域抽样回归）
- **环境**：macOS Darwin 21.6.0 / Node v24.12.0 / TUN fake-ip 代理（对 example.com/httpbin 有间歇 `ERR_CONNECTION_CLOSED` 干扰）；chrome-devtools-mcp@0.3.0 上游
- **裁决口径**：先对照 v1.8 修复记录的新预期，再实测；仍 fail 判用例/产品，附关键输出

---

## 1. wave1 24 fail 重测结果（逐条）

### 1.1 browse / 登录态面板（wave2-browse，20 条 fail 重测）

| ID | wave1 fail 原因 | v1.8 修复 | wave2 verdict | 仍 fail 的原因与判定 |
|---|---|---|---|---|
| U-02-3 | W1-DEF-1/1b：evaluate IIFE 语句串被上游拒，`fn is not a function` + fallback_exhausted | 全部调用点改函数表达式 + parseEvalResult | **pass** | — |
| U-02-4 | 同上（markdown_cited 链路） | 同上 | **pass** | 角标 `⟨N⟩` 14 处、References 去重、citations 非空全中 |
| U-02-5 | W1-DEF-3：take_screenshot filePath 被 zod strip → 返 worked 但文件不存在 | 上游返 base64 自行落盘 + fs.stat 校验 | **pass** | 真实 PNG（magic 89504e47）2095B |
| T-BROWSE-04 | 同 U-02-3 | 同上 | **pass** | markdown_engine="defuddle+turndown" |
| T-BROWSE-05 | 同 U-02-3 | 同上 | **pass** | 同 U-02-4 |
| T-BROWSE-08 | W1-DEF-2：wait_for.text 传数组被上游 `-32602 Expected string` 拒 | 改单 string 透传 | **pass** | waited for "Example Domain"；缺 expect.text → didnt |
| T-BROWSE-09 | W1-DEF-1（半）：evaluate js 语句体不可执行；stealth 误报 | `js` 语句体自动包函数体（toFnExpression） | **pass** | 语句体可执行；缺 js → didnt |
| T-BROWSE-11 | W1-DEF-1b：network `upstream_network_error:fn is not a function` | 同 W1-DEF-1 修复 | **fail** | 底层修复已生效（同会话 22 entries），但暴露**新缺陷 W2-DEF-N1**：`network` 工具独立调用不导航，doNetwork 在 about:blank 上 evaluate，恒 0 entries + 误导性 next_step。判定：用例对 → 产品缺陷 |
| T-BROWSE-13 | W1-DEF-3：截图永不落盘 | 同 U-02-5 修复 | **pass** | full_page 真实 PNG；region 静默忽略=清单既定边界 |
| T-BROWSE-20 | W1-DEF-1/1c：stealth 16 路全静默失效（navigator.webdriver=true） | afterNavigate 注入 + isError 检查后才记 stealth_injected | **pass** | webdriver=undefined、languages/UA/hardwareConcurrency 全为伪装值；16 路自 v1.5 起首次真机可验生效 |
| T-BROWSE-24 | W1-DEF-6：子进程孤儿清理缺失 | killAllSync + exit 钩子（W1-DEF-6 修复） | **fail** | **W1-DEF-6 修复无效，登记 W2-DEF-N2**：优雅退出路径 `_kill` 先 `client.close()` 再 `procs.delete(name)`，exit 钩子遍历空 map，SIGKILL 永不发出（stderr 0 次 subproc_exit_kill）；单次退出净残留 2 进程（npm shim 沦 ppid=1 孤儿）。判定：用例对 → 产品缺陷 |
| T-BROWSE-27 | W1-DEF-5：404/NXDOMAIN 假阳性 worked | NAV_ERROR_SIGNATURES + responseStatus 双校验 | **pass** | 404/NXDOMAIN → didnt 双中；unknown_action:foo 逐字命中。附观察 W2-OBS-2：TUN 断连下 404 分类为 dns_or_nav_error 而非 http_404（粒度受环境限制，不判 fail） |
| T-BROWSE-29 | 传导自 T-BROWSE-11 | 同上 | **fail** | 过滤与计数逻辑本身完全正确（同会话 6/6 全 third-party）；fail 仅因独立调用继承 W2-DEF-N1 不导航（standalone 实测 entries=0）。修复 N1 后应自然转 pass |
| T-TOOLS-09 | 同 U-02-5 | 同上 | **pass** | data.path 绝对路径可直读 |
| T-TOOLS-11 | 同 T-BROWSE-11 | 同上 | **fail** | 同 W2-DEF-N1 |
| U-04-1 | W1-DEF-7：launch-chrome 假 ok:true + Chrome 秒退 + 9222 永不通 | 默认注入隔离 `--user-data-dir` + 3s 探活 + 错误码三档 | **pass** | 干净口 ok:true + /json/version 通；cdp_not_ready/chrome_exited 两档诚实可达。附环境注释 W2-OBS-3（僵尸持口者被预判「空闲」，port_in_use 档本机不可达） |
| U-04-4 | W1-DEF-4：`Network.getAllCookies wasn't found`（Chrome 150 移除） | 改 Storage.getCookies | **pass** | bytes=728、sha256、mode 0600、magic "LSCO" 全中 |
| U-04-5 | W1-DEF-4 传导（import 恒不可达） | 同上 | **pass** | imported:2 failed:0 |
| T-LI-04 | 同 U-04-4 | 同上 | **pass** | 同 U-04-4 采证 |
| T-LI-11 | W1-DEF-7 | 同 U-04-1 修复 | **pass** | stdout JSON 三元组 ✓；CLI 退出后 Chrome 仍 LISTEN（detached 语义 lsof 实证） |

### 1.2 desktop + CLI 面板（wave2-desktop-cli）

| ID | wave1 fail 原因 | v1.8 修复 | wave2 verdict | 仍 fail 的原因与判定 |
|---|---|---|---|---|
| T-DESKTOP-09 | W1-DEF-8：screenshot_region wire 键名漂移，裁剪被吞返全屏 | v1.8 键名修复 + width/height 透出 data | **pass** | region 真实生效：`{0,0,800,600}` → PNG IHDR **1600×1200**（@2x Retina = 800×600 pt 精确） |
| T-DESKTOP-18 | W1-DEF-9：helper spawn ENOENT 只打日志，pending 烧满 3s 超时 | proc.on("error") reject 全部 pending + closed 标记 | **pass** | ENOENT **21-28ms** reject（<1.5s 达标 70 倍余量），归因 `rust_helper_crashed:subproc_spawn_failed` 逐字命中；二次调用同速 |
| F-CLI-01 | argv 白名单外静默落 MCP server 模式，stdout 0 字节挂起 | --version/-v、--help/-h、未知子命令三分支 | **pass** | 三分支全落地；未知子命令 usage→stderr + exit 1 不挂起 |
| T-CLI-05 | D11：`--stealth-check` flag 被 CLI 忽略，#38 恒 warn-skip | flag 真实解析 + stealthCheckClientProvider 注入 | **pass**（附新缺陷 W2-DEF-1） | flag 不再被忽略，#38 拉起 headless + 16 路注入 + probeCreepjs 实跑（totalLies=0）；但 **W2-DEF-1**：纯 tsc build 不复制 creepjs-baseline.json 进 dist，clean build 下门禁止步 baseline-read warn（一行 build script 修复，不推翻主断言） |
| T-BROWSE-14 | D2：options.steps 被 zod strip，链式经 MCP 不可达 | schema 补 steps 键 | **pass** | 经 MCP 真实可达：actions_and_results/budget_used_ms 齐全；负向链 didnt + stopped_at 精确边界（第三步未执行） |
| U-03-1 | 同 D2 | 同上 | **pass** | 旧「证明 D2」预期已被 v1.8 修复记录取代，按新预期裁决 |
| T-BROWSE-09（复测） | 同 1.1 | 同上 | **pass** | 单会话 navigate→evaluate：`return navigator.webdriver` → undefined |
| T-BROWSE-20（复测） | 同 1.1 | 同上 | **pass** | 多探针一次全中：`undefined | en-US,en | 4 | 5 | Windows UA`；与 doctor #38 creepjs totalLies=0 互证 |
| U-08-3（复测） | W1-DEF-5：404 假成功 | performance API responseStatus 权威路径 | **pass** | `example.com/404` → **didnt + http_404:client_error**（419ms）；httpbin 在本机是坏目标（代理拦成中文错误页），用例 URL 已按修复记录换目标 |
| T-BROWSE-27（复测） | 同 1.1 | 同上 | **pass** | NXDOMAIN → didnt + dns_or_nav_error；unknown_action 维持 |

### 1.3 治理面板（wave2-gov）

| ID | wave1 fail 原因 | v1.8 修复 | wave2 verdict | 仍 fail 的原因与判定 |
|---|---|---|---|---|
| T-RT-06 | W1-DEF-10：CallerTierTracker 未接线，计数恒 0 | search/browse_headless/browse_logged_in 三 handler 入口 tryAcquire | **pass** | #6 次 didnt `caller_cap_exceeded`；cap_list 计数真实；cap=0 封禁；anonymous 默认 100 隔离。注意：wave1 用 fetch_url 连调的形态在 v1.8 语义下测不到 gate（fetch_url 不在 gate 范围），清单再版须把连调工具改为 search |
| U-08-3（复测） | 同 1.2 | 同上 | **pass** | didnt + http_404:client_error；对照组正常页 worked 不误伤 |

**重测小结**：wave1 24 fail 对应条目全部重测，**20 转 pass / 4 仍 fail**。4 条仍 fail 全部「用例对 → 产品缺陷」，归并为 3 个缺陷编号：W2-DEF-N1（×3：T-BROWSE-11、T-TOOLS-11、T-BROWSE-29）、W2-DEF-N2（×1：T-BROWSE-24）。

---

## 2. 解锁项与新增验证结果

| 项 | 来源 | verdict | 关键证据 |
|---|---|---|---|
| T-LI-05 cookie import（解锁） | W1-DEF-4 修复后双分支可达 | **pass** | 未 export 先 import → cookie_store_not_found ✓；export 后 import → imported:2 failed:0 ✓（wave1 传导性 blocked 全解除） |
| T-LI-06 CookieStore 加密格式（解锁） | 同上 | **pass** | mode 0600/目录 0700/magic "LSCO" 全中；头部以下截短→cookie_bad_length；改 magic→cookie_bad_magic；篡改密文→cookie_auth_tag_failed；恢复原件→imported:2。附注：对半截断（仍长于头部）落 auth_tag_failed 而非 bad_length（GCM 兜底），用例表述宜收窄为「头部以下截短」 |
| steps 链式（T-BROWSE-14/U-03-1，D2 解锁） | v1.8 schema 补 steps | **pass** | 正向链 snapshot/wait/evaluate 三步齐全（wait tri-state 判 preexisting ✓）；负向链 stopped_at={step_index:1, reason:failed_postcondition}，第三步精确未执行（Skyvern 边界语义）；W1-DEF-2b 隐含验证（snapshot 步拿到的已是目标页） |
| stealth 16 路（T-BROWSE-09/20 + doctor #38） | W1-DEF-1/1c 修复 | **pass** | navigator.webdriver=undefined；languages=en-US,en；UA=Windows Chrome；hardwareConcurrency=4；plugins.length=5；stealth_injected profile=windows_chrome_120 roads=16；第三方指纹引擎 creepjs 实跑 totalLies=0 / navigatorLied=false——自 v1.5 起首次真实生效 |
| read_text（T-TOOLS-13，D1 解锁） | v1.8 装配 read_text（tool_manager_size=15） | **pass** | tools/list 含 read_text；spill @o1.txt 133309B mode 0600；分页 offset 100000/130000 衔接正确、尾页 eof:true；超 EOF 空文本优雅；坏 ref 结构化 error 无未捕获异常。wave1 采集的 6 处 description 指向全部落到真工具 |
| U-01-4 机器 MCP 搜索（wave1 未实测，本波次首测） | — | **pass** | fallback_chain 审计链 `search.machine_mcp(unknown) → search.zhipu(缺 key) → browse_headless(worked)`，machine_mcp 首位注入 ✓（doctor #36 的运行时佐证）。观察 O2：machine_mcp 链项仅 outcome:unknown 无 error 摘要 |

---

## 3. 抽样回归结果（wave1 pass 项防修复引入回归）

共 20 条回归/旁证（gov 18 + desktop 2），**全部 pass，未发现修复引入的回归**：

| ID | verdict | 备注 |
|---|---|---|
| T-SSRF-01 | **pass** | 五场景与 wave1 逐字一致（127.0.0.1 放行到达 HTTP 层，D10 设计维持） |
| T-TOOLS-08 | **pass** | fetch_url 四场景全一致；markdown 档 body_kind="markdown:defuddle+turndown"；大页 envelope truncated+ref+落盘 $TMPDIR |
| T-SEARCH-11 | **pass** | free_only L1 滤空 / L4 全允许 / 默认未过滤，一致 |
| T-SEARCH-12 | **pass** | cached:true / no_cache / limit、engine 不误命中，一致 |
| T-SEARCH-29 | **pass** | zod too_small/too_big 结构化拒绝，一致 |
| T-CLI-01 | **pass** | doctor 33 项（CLI 模式 desktop 六项缺席属设计）；**变化点**：`stealth_profile_self_check` 由 warn 转 pass——v1.8 stealth 修复的正向副产物，非回归 |
| T-CLI-03 | **pass** | replay-baseline total:6 pass:6，与 doctor #26 对齐 |
| U-07-1..6 | **pass** ×6 | config init/不覆盖/path/file key/env 覆盖（9225→9226 实证）/坏 JSON 不崩，全套一致 |
| T-RT-05 | **pass** | 观测三件套 ok 且带数据（breaker short=11+long=12 齐全） |
| T-FOREST-02 | **pass** | @p→browse、@w→desktop（served_by=desktop.ax 实证）、@p99 stale、@x0 regex 拒，一致 |
| T-TOOLS-14 | **pass** | MCP doctor 39 项；runtime_state 七键齐；profiles 仅 stat 无 cookie 字段 |
| T-DESKTOP-01 | **pass** | Finder snapshot 形状与 wave1 一致（root @e0「访达」树） |
| T-DESKTOP-02 | **pass** | find {text:"文件"} worked，count=9 |

---

## 4. 总结

### 4.1 计数

| 面板 | 执行 | pass | fail | blocked | waived |
|---|---|---|---|---|---|
| browse/登录态（20 fail 重测 + 2 解锁） | 22 | 18 | 4 | 0 | 0 |
| desktop+CLI（6 fail 重测 + 4 跨面板复测 + 1 回归对） | 11 | 11 | 0 | 0 | 0 |
| 治理（2 fail 重测 + 18 回归/首测） | 20 | 20 | 0 | 0 | 0 |
| **合计（执行口径）** | **53** | **49** | **4** | **0** | **0** |

> 跨面板复测重复条目（T-BROWSE-09/20/27、U-08-3 在两个面板各执行一次，结论一致）；附加范围探针 1 条（T-RT-06 fetch_url 范围，不计数）。wave1 24 fail 去重后全部覆盖：**20 转 pass / 4 仍 fail（3 个缺陷编号）**。

### 4.2 遗留问题清单

**产品缺陷（3 个，wave2 新登记）**：

1. **W2-DEF-N1**（3 条 fail 根因）：`network`（及同范式 URL 驱动单 action）独立调用不导航——doNetwork 在 about:blank 上 evaluate，恒 0 entries + 误导性 next_step；设计注释承诺「URL → navigate + 注入」未实现。修复点：URL 驱动工具 browse 前先 navigate。涉及 T-BROWSE-11、T-TOOLS-11、T-BROWSE-29（修 N1 后 29 应自然转 pass）。
2. **W2-DEF-N2**（W1-DEF-6 修复无效）：优雅退出路径 `_kill` 先 `client.close()` 再 `procs.delete(name)`，exit 钩子 `killAllSync()` 遍历空 map，SIGKILL 永不发出；且 SDK close 对 `npm exec` shim 树不致死——每次 server 退出净残留 2 进程（ppid=1 孤儿；wave2 全程累计 40+，测后已定向清理 42 个）。修复点：先 SIGKILL 后删 map / `kill(-pgid)` / 直接 spawn node 绕过 npx shim。
3. **W2-DEF-1**（轻，一行修复）：纯 tsc build 不复制 `src/doctor/fixtures/creepjs-baseline.json` 进 dist（`__dirname/fixtures` 解析 dist 路径），clean build / npm 安装下 `--stealth-check` 门禁止步 baseline-read warn，freeze/比对路径不可达。修复点：build script 追加 cp。

**观察项（不判 fail，供清单再版/产品组）**：

- W2-OBS-1 / O-1（stealth 语义边界）：stealth 注入时机是 afterNavigate；新会话直接调 `evaluate`/`extract`/`network`（不先 navigate）在 about:blank 上执行且未注入。建议 README/KEY-GUIDE 注明「须跟在同会话 navigate 之后」或前置导航。
- O-2（wait 步 timeout_ms 未透传）：doWait 只传 `{text}`，负向链烧上游默认超时（整链 34.4s 而非 3s）——与 W1-DEF-9 同类的延迟可观测性问题（轻）。
- W2-OBS-2（404 分类粒度）：TUN 断连下 404 分类为 `dns_or_nav_error`（ERR_CONNECTION_CLOSED）而非 `http_404`——responseStatus 权威检测在连接被断时不可达；outcome 正确。
- W2-OBS-3（launch-chrome 预检）：对「持口不应答」的僵尸进程判「空闲」放行 spawn → 落 cdp_not_ready（诚实失败）；port_in_use 档本机不可达，预检可加 TCP connect 级检测。另：连续两次默认 profile 启动因 Chrome 单例转发报 chrome_exited（共用 profileDir，一次性场景可接受）。
- O1（caller cap 范围）：gate 仅 search/browse_headless/browse_logged_in 三 handler；fetch_url/read_text/wayback 不计数不拦截——与修复记录声明一致，是否纳入管控留产品决策。
- O2（machine_mcp 可观测性薄）：fallback 审计链 machine_mcp 条目仅 `outcome:"unknown"` 无 error/detail，未命中原因外部不可判；建议链项补 error 摘要。
- O-3（undefined preview 回退）：evaluate 返 undefined 时 preview 回退上游原文（含围栏噪声），值仍可读；纯观感项。

**清单再版事项**（回填 17-功能测试清单.md 已同步，再版时建议）：

- U-08-3 / T-BROWSE-27 用例 URL 从 httpbin.org/status/404 改为 `example.com/404`（本机代理环境下 httpbin 是坏目标）。
- T-RT-06 连调工具从 fetch_url 改为 search（fetch_url 不在 gate 范围）。
- T-LI-06「截断→bad_length」表述收窄为「头部以下截短」。
- 备忘：fetch_url 的 extract_mode/max_bytes 是 `options` 嵌套键（顶层透传被 zod strip 静默按 raw 处理）；interact_observe 的 action 无 default 必须显式传。
