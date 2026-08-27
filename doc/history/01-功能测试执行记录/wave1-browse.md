# Wave1 执行记录：无头浏览 + 登录态探测（browse_headless / browse_logged_in / forest / screenshot / pdf / network / cookie）

- **执行时间**：2026-08-15 01:58 – 02:24 (CST)
- **执行环境**：macOS Darwin 21.6.0 / node v24.12.0 / lasso v1.7.0 (dist 已构建) / 代理 TUN fake-ip 环境 / chrome-devtools-mcp@0.3.0（SubprocessManager.ts:37 锁版，实测 npx 冷启动约 11-13s）
- **MCP 客户端**：`doc/17-执行记录/mcp.mjs`（共享版，被多面板并行改写）；本面板使用稳定私有副本 `doc/17-执行记录/mcp-wave1.mjs`（多调用同会话 + env 透传）。`tools/list` 自检通过（14 工具，含 search/browse_headless/browse_logged_in/desktop/fetch_url/screenshot/pdf/network/wayback_lookup/doctor/interact_roots/interact_observe/interact_act/admin）。
- **上游契约实测**（`doc/17-执行记录/upstream-probe.mjs` 直连 chrome-devtools-mcp@0.3.0 取 schema）：`take_screenshot` 无 `filePath` 参数（仅 format/uid/fullPage）；`wait_for.text` 要求 **string**；`evaluate_script.function` 要求**函数表达式**（IIFE 语句串返回 "fn is not a function"）；无 `pdf` 工具。下列多条 fail 的根因均锚定于此。

## 探测结论（文件头）

- **探测 B：PASS**。首次 `browse_headless {navigate https://example.com}` 成功：outcome=worked，final_url="https://example.com/"，npx 首启约 11-13s（at_ms=13482 内含导航）。
- **探测 D：PARTIAL-FAIL**。
  - `node dist/index.js launch-chrome`（默认无 --profile）：返回 `{ok:true, binaryPath, pid:27159, port:9222}`，但 **spawn 的 Chrome 立即退出**（默认 profile 单例转发给既有 Chrome 实例），且 `curl http://127.0.0.1:9222/json/version` **不通**（HTTP 404 空 body）。
  - 环境干扰：用户 2 天前启动的主 Chrome（**pid 4800**）占住 `127.0.0.1:9222`（IPv4），所有 DevTools HTTP 端点返 404（Chrome 136+ 默认 profile 禁远程调试的表现）。
  - 绕开方式：`launch-chrome --profile <隔离目录>` 可用——**保持运行的两个 Chrome**（按要求不杀，供修复重测）：
    - **pid 29428**：`--remote-debugging-port=9222 --user-data-dir=/tmp/lasso-chrome-test-profile`，监听 `[::1]:9222`（仅 IPv6）
    - **pid 31973**：`--port 9223 --user-data-dir=/tmp/lasso-chrome-profile-9223`，监听 `127.0.0.1:9223`（本面板登录态用例均以 `LASSO_CDP_PORT=9223` 执行）
- 按探测 D 结论，U-04/T-LI 组未整组 blocked，而是用 9223 通道执行（结论按实际执行判定）。

## 本面板新发现缺陷（不在 D1-D11 清单内，fail 根因锚点）

| # | 缺陷 | 证据 | 涉及用例 |
|---|---|---|---|
| W1-DEF-1 | `evaluate_script` 全部以 IIFE 语句串调用（BrowseChannel.ts:646 doExtract、:460 quickSnapshot、StealthEngine.ts:172 全部 stealth 脚本、network 注入），上游 0.3.0 需函数表达式 → 返回 "fn is not a function"，**markdown/markdown_cited 抽取、network 工具、stealth 16 路注入全部静默失效**；且 StealthEngine 不检 isError → 日志误报 `stealth_injected` 成功 | IIFE→"fn is not a function"、`() => ...`→正常、`() => navigator.webdriver`→**true** | U-02-3/4、T-BROWSE-04/05/09/11/20/29、T-TOOLS-11 |
| W1-DEF-2 | `doWait` 传 `{text:[text]}` 数组（BrowseChannel.ts:722），上游 wait_for 要 string → wait action 恒失败 | 上游 zod 错误原文 "Expected string, received array" | T-BROWSE-08 |
| W1-DEF-3 | `doScreenshot` 传 filePath（BrowseChannel.ts:619-626），上游 0.3.0 take_screenshot 无此参数被 zod strip → **PNG 永不落盘但返回 worked+path**（不校验落盘） | 上游 schema 实测；`ls /tmp/lasso-screenshot-*.png` 不存在（复测 2 次） | U-02-5、T-BROWSE-13、T-TOOLS-09 |
| W1-DEF-4 | CdpClient 用 `Network.getAllCookies`（CdpClient.ts:131），Chrome 150 已移除该方法 → cookie export 恒 `cdp_error:-32601 wasn't found` | admin cookie_restore export 实测失败原文 | U-04-4/5、T-LI-04/05/06 |
| W1-DEF-5 | navigate 不等待加载完成也不校验导航错误：404 页、NXDOMAIN（TUN fake-ip 下 Chrome 错误页）、delay/60 慢页全部返回 worked="navigated"；紧接的 snapshot 竞态取到**上一页**内容 | httpbin 404→worked；NXDOMAIN→worked+错误页快照；wikipedia snapshot 取到前一页 | T-BROWSE-27（及 U-09-2 观察） |
| W1-DEF-6 | lasso 退出不清理 chrome-devtools-mcp 子进程 → **孤儿泄漏**（ppid=1）。受控实验：单会话前 15 个存量、会话退出后 +1（pid 21129，parent=1）。存量 15 个含并行面板会话产物，归因以受控 +1 为准 | pgrep/ps 实测 | T-BROWSE-24 |
| W1-DEF-7 | launch-chrome 默认不带 `--user-data-dir`：Chrome 136+ 对默认 profile 禁用远程调试 + 已有实例单例导致 spawn 进程退出 → 默认命令下 9222 永不可用；产品不检测子进程退出/端口被占即返 ok:true | 探测 D 实测 | U-04-1、T-LI-11 |

观察项（不计 fail）：interact_roots 出现 browse_logged_in 伪条目（title/subtitle="http://localhost:9222/json/version:"，9222 无可用 Chrome 时仍列出）；fill 传空 selectors `{}` 返 "filled 0 fields" 不报错（完全不传才报错）；fill 传不存在的 uid 也返 worked（上游不校验）；短熔断 3 连败即 open（batch2 内 unknown×3 后 circuit_open）；两套 tmp 根（清单已知观察）；snapshot 首行实为 "# take_snapshot response"（清单对上游快照格式的假设过时）。

---

## 1. U-02 无头抓取旅程

| ID | verdict | 实际观察（关键输出摘录） | 用例判定 |
|---|---|---|---|
| U-02-1 | **pass** | `{outcome:"worked", data.final_url:"https://example.com/", preview:"navigated", retrieval_method:"chrome_devtools_mcp"}`；首启 npx 耗时在 13.5s 内完成 | — |
| U-02-2 | **pass** | extract 默认档 worked；preview 为 take_snapshot a11y 树含 "Example Domain"；data 字段仅 url/action/state_id/content_path/preview/title/final_url——**无 byline/citations/markdown_engine** | — |
| U-02-3 | **fail** | outcome=didnt + fallback_exhausted；链内 headless/browse_logged_in 均 unknown，error=`SyntaxError: Unexpected token 'n', "fn is not a function" is not valid JSON`（markdown 档 evaluate_script IIFE 失败，W1-DEF-1） | **用例正确**：预期 markdown_engine=="defuddle+turndown" 是源码意图；产品缺陷 W1-DEF-1 |
| U-02-4 | **fail** | markdown_cited（news.ycombinator.com）同样 didnt + "fn is not a function"（W1-DEF-1） | **用例正确**；产品缺陷 W1-DEF-1 |
| U-02-5 | **fail** | 返回 worked + `path:"/tmp/lasso-screenshot-<uuid>.png"`，但 **`ls` 该文件不存在**（复测 2 次均不存在；/tmp 与 /private/tmp 均无；上游 schema 无 filePath 参数，W1-DEF-3） | **用例正确**（预期"文件存在且为 PNG"）；产品缺陷 W1-DEF-3（路径系伪造） |
| U-02-6 | **pass** | pdf → `outcome=didnt + retrieval_method="upstream_unsupported:pdf" + next_step="chrome-devtools-mcp@LOCKED 不暴露 pdf 工具…"`（命中"若不支持"分支；上游 tools/list 实测无 pdf 工具） | — |

## 2. T-BROWSE 技术用例

| ID | verdict | 实际观察 | 用例判定 |
|---|---|---|---|
| T-BROWSE-01 | **pass** | 同 U-02-1；final_url 一致 | — |
| T-BROWSE-02 | **pass** | snapshot worked；preview 全文含 "Example Domain" 正文；title 实为 `"# take_snapshot response"`（上游 0.3.0 快照首行格式） | 用例"title=快照首行 'Example Domain'"对上游格式假设过时——按源码 extractSnapshot（取首行）产品行为一致，title 断言按源码口径判用例笔误；主断言 preview 含正文命中 |
| T-BROWSE-03 | **pass** | extract 不传 mode 与 snapshot 输出同构（同走 take_snapshot 路径，INV-66 raw 档零改）；无 byline/citations 字段 | — |
| T-BROWSE-04 | **fail** | markdown 档 didnt，"fn is not a function"（W1-DEF-1） | 用例正确；W1-DEF-1 |
| T-BROWSE-05 | **fail** | markdown_cited（HN）同上（W1-DEF-1），citations/角标路径未达 | 用例正确；W1-DEF-1 |
| T-BROWSE-06 | **pass** | `click {selectors:{click:"1_3"}}` → worked + preview=`"clicked 1_3"`；缺 selectors.click → 链内 unknown（error="click: opts.selectors.click (uid) required"），顶层 envelope=didnt/fallback_exhausted | 主断言命中；"缺参→unknown"按审计链口径命中（顶层 envelope 因双通道同败为 didnt——口径差异记录为观察） |
| T-BROWSE-07 | **pass** | `fill {selectors:{uid1:"Alice",uid2:"12345"}}` → preview=`"filled 2 fields"`；空 selectors `{}` → worked "filled 0 fields"（不报错） | 主断言命中；用例"空 selectors 报错"表述不准——源码 doFill 仅完全不传 selectors 才 throw；{} 穿透为 0 字段（判用例笔误） |
| T-BROWSE-08 | **fail** | `wait {expect:{text:"Example Domain"}}` → 链内 unknown，error=`McpError -32602: Invalid arguments for tool wait_for: "Expected string, received array"`（doWait 传数组，W1-DEF-2）；缺 expect.text → error="wait: opts.expect.text required" 命中 | 用例正确（预期 worked）；产品缺陷 W1-DEF-2 |
| T-BROWSE-09 | **fail** | `js:"return navigator.webdriver"` → preview=`"Unexpected token 'return'"`（上游要求函数表达式，return 语句体不可执行）；改写 `js:"() => navigator.webdriver"` 可执行但返回 **true** | 用例半错：js 形态对上游 0.3.0 契约不适配（产品未包装也未文档化）；但等价改写后证实 stealth 未生效 → 产品缺陷 W1-DEF-1 成立 |
| T-BROWSE-11 | **fail** | `network {filter:"all"}`（example.com 与 news.ycombinator.com）→ 均 `didnt + retrieval_method="upstream_unsupported:network" + error="upstream_network_error:is_error:fn is not a function"` + next_step（W1-DEF-1；entries=0） | 用例正确；W1-DEF-1 |
| T-BROWSE-12 | **pass** | console → worked + preview=`"console action: v0.5 M0.5b placeholder (M0.5c will implement evaluate_script injection)"` | — |
| T-BROWSE-13 | **fail** | full_page:true 与 region:{x,y,width,height} 两版均返 worked + /tmp 路径，但**文件均不存在**（W1-DEF-3）；region 是否被忽略因此不可判（上游无裁剪透传，filePath 已被 strip） | 用例正确（预期 /tmp 下真实 PNG）；W1-DEF-3 |
| T-BROWSE-16 | **blocked** | 无法构造"headless 单侧 unknown"：404/delay-60/NXDOMAIN 在 headless 均 worked（W1-DEF-5 不报错）；wait/markdown 等 action 级缺陷对两通道同害（logged_in 同败），无法出现"headless 败+logged_in 成"组合 | blocked 原因：无可用的单侧故障注入手段（404-didnt 不触发 fallback 的负分支同样不可达） |
| T-BROWSE-18 | **pass** | `~/.cache/lasso/<run_id>/browse_headless-<state_id>.json` 存在，含 channel/state_id/saved_at/url/action/title/preview；每次响应返 state_id + content_path | — |
| T-BROWSE-19（不在本面板，随 18 带过） | — | spill 目录 `$TMPDIR/lasso-output` 因 pdf/network 均未产生 >48KiB 输出而无样本 | — |
| T-BROWSE-20 | **fail** | navigate 后 `() => navigator.webdriver` → 返回 **true**（预期 undefined）；且服务器日志出现 `stealth_injected` 成功事件（StealthEngine 不检上游 isError，误报） | 用例正确（16 路注入生效佐证）；产品缺陷 W1-DEF-1（注入静默失效+日志误报） |
| T-BROWSE-23 | **pass** | `PATH=/nonexistent-dir node …`：`subproc_spawn_retry` attempt1-4 backoff_ms=**2000/4000/8000/16000** → attempt5 `subproc_spawn_failed`（spawn npx ENOENT）；最终 envelope didnt/fallback_exhausted，链内 unknown；logged_in 通道同样退避 | 主断言命中；退避序列实为 2/4/8/16s（源码 SubprocessManager.ts:436 `1000*2**attempt` 注释即 2s 起）——清单写"1s/2s/4s/8s/16s"首档笔误 |
| T-BROWSE-24 | **fail** | 受控实验：会话前 15 个 chrome-devtools-mcp@0.3.0 进程 → 单会话（browse 1 次）退出后 16 个（新增 pid 21129，**ppid=1 孤儿**，ELAPSED 持续增长）；存量 15 含并行面板产物，受控 +1 为准 | 用例正确（预期无残留）；产品缺陷 W1-DEF-6 |
| T-BROWSE-25 | **pass** | `interact_roots {}` → worked，roots 含 @p0（browser_page, browse_headless）+ @p1（browse_logged_in 伪条目，见观察）+ @w2/@w3（desktop 窗口） | — |
| T-BROWSE-27 | **fail** | 404（httpbin/status/404）→ **worked**；NXDOMAIN → **worked**（随后 snapshot 是 Chrome 错误页"无法访问此网站"）；未知 action "foo" → didnt + error="unknown_action:foo" ✓ | 用例正确（预期 404/NXDOMAIN→didnt）；产品缺陷 W1-DEF-5（navigate 不校验结果；NXDOMAIN 分支受 TUN fake-ip 环境放大——DNS 被 fake-ip 接管后连接失败也不上报）。unknown_action 分支命中 |
| T-BROWSE-28 | **pass** | wikipedia 长条目 snapshot：preview JS 长度 4022 = 4000 正文 + `\n…[truncated by lasso]` 尾标（源码 truncatePreview 行为） | — |
| T-BROWSE-29 | **fail** | `network {filter:"3rd-party"}` → 同 T-BROWSE-11 失败（fn is not a function，W1-DEF-1） | 用例正确；W1-DEF-1 |

## 3. T-TOOLS 工具面

| ID | verdict | 实际观察 | 用例判定 |
|---|---|---|---|
| T-TOOLS-09 | **fail** | 同 T-BROWSE-13/U-02-5：worked+绝对路径但文件不存在（W1-DEF-3） | 用例正确；W1-DEF-3 |
| T-TOOLS-10 | **pass** | pdf → didnt + upstream_unsupported:pdf + next_step（上游不支持分支命中） | — |
| T-TOOLS-11 | **fail** | 同 T-BROWSE-11（W1-DEF-1） | 用例正确；W1-DEF-1 |

## 4. U-09 forest 统一入口

| ID | verdict | 实际观察 | 用例判定 |
|---|---|---|---|
| U-09-1 | **pass** | interact_roots → roots 含 @p0（headless 页）+ @w2/@w3（desktop 可用）；@p1 为 browse_logged_in 伪条目（title="http://localhost:9222/json/version:"，此时 9222 并无可用 Chrome）——记观察 | — |
| U-09-2 | **pass** | `interact_observe {@p0, snapshot}` → worked，preview 为对应页面 a11y 树（uid=2_0 RootWebArea …） | 附观察：navigate+snapshot 同调用竞态可能取到前一页（W1-DEF-5 家族） |
| U-09-3 | **pass** | `interact_act {@p0, navigate, options.url}` → worked + preview="navigated" + rm=chrome_devtools_mcp（路由到 BrowseChannel） | 附观察：final_url 回显为旧 URL（extractFinalUrl 宽松正则抓到 navigate 结果文本中的旧链接） |
| U-09-5 | **pass** | 同会话两次 interact_roots：@p0 同 url（wikipedia）同 ref 复用，@p/@w 计数器一致递增（@w2/@w3） | — |

## 5. U-04 / T-LI 登录态通道（经 LASSO_CDP_PORT=9223 + pid 31973 Chrome 执行）

| ID | verdict | 实际观察 | 用例判定 |
|---|---|---|---|
| U-04-1 | **fail** | `node dist/index.js launch-chrome` → `{ok:true, binaryPath, pid:27159, port:9222}`（第一断言 ✓）但 pid 27159 **立即退出**（默认 profile 单例），`curl http://127.0.0.1:9222/json/version` **404 空 body 不通**（用户旧 Chrome pid 4800 占 IPv4 9222 且禁调试） | 用例正确（承诺 curl 返回版本 JSON）；产品缺陷 W1-DEF-7（默认不带 --user-data-dir + 不检测退出/占口）+ 环境干扰（pid 4800 占口）。带 `--profile` 的隔离版可用 |
| U-04-2 | **pass** | 9223 下 `browse_logged_in {snapshot example.com}`（先 navigate 后 snapshot）→ worked，preview=Example Domain a11y 树，served_by=browse_logged_in，真实 Chrome 会话 | 单调用 snapshot 竞态取到新标签页（W1-DEF-5 家族）记观察；另注意 LoggedInChannel 连 `localhost:9222` 在本机解析到 IPv4 坏端点——须 9223 干净端口 |
| U-04-4 | **fail** | `admin cookie_restore export` → `ok:false, error="cookie_restore(export) failed: cdp_error:{code:-32601, 'Network.getAllCookies' wasn't found}"`；无文件生成 | 用例正确；产品缺陷 W1-DEF-4（Chrome 150 已移除该方法） |
| U-04-5 | **fail** | export 后 import：import → `ok:false, error="cookie_store_not_found"`（因 export 从未产出加密包；"未 export → cookie_store_not_found" 分支字面命中，imported>0 主断言不可达） | 用例正确；根因 W1-DEF-4 传导 |
| T-LI-01 | **pass** | 同 U-04-2（9223）；另实测 9222 默认场景：worked 但 preview="Failed to fetch browser webSocket URL from http://localhost:9222/json/version: HTTP Not Found"——"9222 无（可用）Chrome → 明确连接错误"以错误文本形态可见（记观察：outcome 仍 worked，错误只出现在 preview） | — |
| T-LI-02 | **pass** | 2FA 页（本地 http 服务 "Enter your verification code"）为活动 tab 时首连：日志 `logged_in_2fa_detected keyword:"verification code"`；不自动登录/解 2FA ✓；非登录页无 note ✓（后续会话无 detected 日志） | 附判定说明：`status.note=NEEDS_MANUAL_2FA` 只存在于 channel.status()（LoggedInChannel.ts:193），**MCP 工具输出面不透出 note**——用例写法在 MCP 面不可直接观察，以日志证据+不自动解 2FA 判命中；2FA 检测仅在通道首连快照（非每次 navigate 后）记观察 |
| T-LI-04 | **fail** | 同 U-04-4（W1-DEF-4） | 用例正确；W1-DEF-4 |
| T-LI-05 | **blocked** | import 主路径（imported/failed 计数）因 export 断链不可达；"未 export → cookie_store_not_found" 字面命中 | blocked 原因：W1-DEF-4 传导（需先修 export） |
| T-LI-06 | **blocked** | 无加密包产物，mode 0600/"LSCO" magic/篡改密文三断言均无样本 | blocked 原因：同上 |
| T-LI-07（Keychain，随 13 一并） | **pass** | `security find-generic-password -s lasso-cookie -a master` 命中（login.keychain-db，2026-07-22 创建）；只读未删 | — |
| T-LI-08 | **pass** | curl 9223 /json/version 返版本 JSON ✓；程序化：非 ok HTTP → `cdp_version_fetch_failed:404`（对 python http 404 实测）✓；死端口 → 裸 "fetch failed"（未包装，记观察）；close 后 pending 全 reject `cdp_closed`（CdpClient.ts:156 源码确认） | — |
| T-LI-09 | **pass** | 连续 11 次 navigate（example.com/?1..?11）后 /json/list page targets = **1**（单 tab 复用导航，≤10 ✓；LRU 驱逐路径未被激活——覆盖浅，记观察） | — |
| T-LI-11 | **fail** | JSON 三元组 ✓（ok/binaryPath/pid/port）；detached ✓（CLI 退出后 Chrome 29428/31973 存活）；但 `curl 127.0.0.1:9222/json/version` 断言不通（同 U-04-1，W1-DEF-7） | 用例正确；W1-DEF-7 |
| T-LI-12 | **pass** | doctor（MCP）：`chrome_binary` pass（路径）✓；`cdp_9222_logged_in` pass（"1 tabs on CDP port 9223"，有 tab 无 next_step）✓；`profile_registry_loadable` pass（1 profile default）/`profile_user_data_dir_exists` pass（mode 0700）/`cookie_store_stat_only` pass（仅 stat，无 cookie 字段）✓；39 项 checks，blockers=[zhipu_api_key] | — |
| T-LI-13 | **pass**（①+优先级；②③④受阻） | ① Keychain 条目存在（见上）；优先级实证：设 `LASSO_COOKIE_PASSPHRASE=<32字符>` 后 `getKeychainKey()` 仍返回 44 字符 Keychain key（env 被忽略）→ **Keychain > env 命中**（keychain.ts 优先级）；② export/import 全链路被 W1-DEF-4 阻断；③④ 需删除 Keychain 条目（本面板只读纪律禁止） | ①命中即 pass；② blocked=W1-DEF-4；③④ blocked=只读纪律（另测：MIN_PASSPHRASE_LEN 拒绝分支需 Keychain 缺席才可达，本机不可达） |

---

## 统计

| verdict | 计数 |
|---|---|
| pass | 24 |
| fail | 20 |
| blocked | 3 |
| waived | 0 |

**fail 逐条**（根因见上表 W1-DEF-1..7）：
- W1-DEF-1（evaluate IIFE 不兼容上游 0.3.0）：U-02-3、U-02-4、T-BROWSE-04、T-BROWSE-05、T-BROWSE-09（另含 stealth 失效证据）、T-BROWSE-11、T-BROWSE-20（stealth 未生效+日志误报）、T-BROWSE-29、T-TOOLS-11
- W1-DEF-2（wait_for text 数组）：T-BROWSE-08
- W1-DEF-3（screenshot filePath 被 strip，文件伪造）：U-02-5、T-BROWSE-13、T-TOOLS-09
- W1-DEF-4（Network.getAllCookies 已移除）：U-04-4、U-04-5、T-LI-04
- W1-DEF-5（navigate 不校验结果）：T-BROWSE-27（404/NXDOMAIN 均 worked）
- W1-DEF-6（子进程孤儿泄漏）：T-BROWSE-24
- W1-DEF-7（launch-chrome 默认版 9222 不可用）：U-04-1、T-LI-11

**blocked 逐条**：T-BROWSE-16（无单侧故障注入手段）、T-LI-05、T-LI-06（均 W1-DEF-4 传导）。

**遗留运行物**（按要求保持）：Chrome pid **29428**（[::1]:9222，/tmp/lasso-chrome-test-profile）、Chrome pid **31973**（127.0.0.1:9223，/tmp/lasso-chrome-profile-9223）；本地 8765 端口 python http server（2FA 测试页 /tmp/lasso-2fa-test.html，复测用勿删）；既有 chrome-devtools-mcp 孤儿进程 15+1 个（W1-DEF-6 证据，未清理）。
