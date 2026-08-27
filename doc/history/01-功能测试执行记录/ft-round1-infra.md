# ft-round1 基建与治理域执行记录（R11）

> **范围**：T-CLI（--version/--help/未知参数/doctor/--deep 假 key/--stealth-check）/ T-CONFIG（init/path/文件生效/env 覆盖/坏 JSON/退役键）/ T-READ（@oN 续读/坏 ref/边界）/ T-OBS + T-RT（admin 治理组/caller cap/breaker_reset/metrics/SIGHUP）/ T-FOREST（@pN 路由/RootRegistry）/ T-SSRF + T-FALL。
> **纪律**：§0.2 全部沿用——失败先判用例再修产品；串行执行 + 用例间 ≥1.5-2s 间隔；资源三采样；面板结束清点自 spawn 进程。所有工具调用走真实 `dist/index.js` stdio server（`node` 用绝对路径 `$NVM.../v24.12.0/bin/node`，避开 nvm 懒加载函数污染 stdout 的 "Now using node v24" 行——该行曾污染一次 JSON 采样，已重测）。
> **数据文件**：本目录 `ft-*.{json,log,out,mjs}`；本机 HTTP 夹具 `ft-http-fixture.mjs`（127.0.0.1:18191，SSRF 设计放行段）。
> **执行日期**：2026-08-18。

---

## 0. 门禁基线（执行前确认）

| 门 | 结果 | 备注 |
|---|---|---|
| `npm run build` | ✅ 0 error | tsc + fixtures 拷贝 |
| `npm test` | ✅ **2227（2226 pass + 1 skip by design）exit 0** | **首轮全量在并行 sibling 面板（ft-r11-browse.mjs / ft-round1-perf-runA.mjs 等同机跑浏览器）负载下 12 条超时红；12 条全部单文件隔离复跑通过**（98+110 全绿），判定为负载 flake 非产品回归（§0.2 第 1 条用例判定流程留痕）；清载重跑全绿 |
| `npm run check-invariants` | ✅ 81/81 | 本轮修 INV-71 检测体后仍 81（只增不减 ✓） |
| `npm run inv-selftest` | ✅ 20/20 | INV-71 mutation 同步迁到 mergedEnv 新形状（详见 §3.1） |

---

## 1. 环境事实（先探测，后裁决）

| 事实 | 值 | 影响 |
|---|---|---|
| machine_mcp | **命中**（search served_by=search.machine_mcp，worked） | T-OBS-01/03、T-RT-06 用真搜索 |
| 9222 端口 | **被用户 Chrome 150（pid 2420，ppid=1，无调试参数）占据，/json/version 返 404 空 body**（Chrome 136+ 默认 data-dir 禁远程调试的形态） | doctor `cdp_9222_logged_in` **fail + blocker → ready:false → CLI exit 1**。**用例判定：产品行为符合源码设计**（doctor.ts:952-975：端口活但 CDP 死 → fail + next_step「重启 Chrome with --remote-debugging-port」），是环境条件非缺陷。本域所有 doctor exit code 断言按此解读 |
| TUN | ClashX TUN fake-ip 在效（`lookup("[::1]")` → 198.18.8.44） | 放大 FT-DEF-3（见 §3.3） |
| lasso 台账 | `~/.cache/lasso/launched-chromes.json` = `[]` | 无遗留 lasso Chrome |
| 并行面板 | 同机有其他执行员面板跑浏览器（ps 可见 ft-r11-browse.mjs 等父进程） | 资源采样含共存进程，判 released 用差值口径（resource-meter 文档自述语义） |

---

## 2. 用例结果总表

状态列：pass / fail / waived。每条附关键输出（截取自 ft-* 数据文件）。

### 2.1 T-CLI（7/7 pass）

| ID | 状态 | 关键输出（证据） |
|---|---|---|
| T-CLI-01 doctor 结构/exit 语义 | **pass**（附环境注 + 计数观察） | CLI 模式 34 checks（`pass:26 fail:1 warn:7`），blockers=[cdp_9222_logged_in]，ready:false → **exit=1（正确）**；MCP 模式 41 checks（+7 项 desktop 家族：rust_helper_signed/running、tcc_accessibility/screen_recording、ax_read_rate、vlm_endpoint_reachable、tcc_event_synthesizing——**实测 tcc 双授权 pass**）。CLI 模式 #desktop 段 warn-skip 属设计（desktopChecks=false）。**观察 O-1**：清单/简报写「doctor 39 项」「#15-#20 六项」，实测 MCP 模式 41 项、desktop 家族 7 项——清单计数陈旧（v1.7 基线），建议清单补充官回填 |
| T-CLI-03 replay-baseline | **pass** | `pass:6 fail:0`（baidu=2 bing=2 google=2），`--strict` 同样 exit 0；doctor `recording_baseline_count: pass "6 条 fixture"` 对齐 |
| T-CLI-04 版本三处一致 | **pass** | package.json:3=1.17.0；index.ts:224 `LASSO_SERVER_VERSION="1.17.0"`；doctor.ts:160 `LASSO_VERSION="1.17.0"`；运行时 `--version`→`1.17.0`、doctor JSON `lasso_version:1.17.0`（INV-63） |
| T-CLI-05 `--stealth-check`（D11 修复回归） | **pass** | **flag 真实生效**：`subproc_spawned name=headless pid=51005` + `stealth_injected profile=mac_chrome roads=16`（16 路注入真机再证）+ creepjs 实跑：#38 `stealth_creepjs_regression=warn "本次实跑：totalLies=0, navigatorLied=false, liedModules=[]"`——warn 是**首跑未 freeze 基线的设计语义**（next_step 给 freeze 指引），非 warn-skip。旧预期「flag 被忽略」已被 v1.8 D11 修复推翻，本条按现行为判。资源：spawn 树跑完即清（pid 消失，ps 复核）；wall 13.5s（首跑）/46.2s（高载复跑） |
| T-CLI-06 `--version`/`-v` | **pass** | 两者均输出 `1.17.0`，exit 0 |
| T-CLI-07 `--help`/`-h`/未知子命令 | **pass** | --help/-h → 完整 CLI_USAGE（含 `doctor [--stealth-check] [--deep]`、`launch-chrome --mode/--idle-ms`、`chrome-stop`、`replay-baseline`）exit 0；`badcmd` → stderr `unknown subcommand or flag: badcmd` + usage，stdout 空，**exit 1**（不挂起等 stdin） |
| T-CLI-08 `--deep` 三分叉 | **pass** | ① 默认 doctor 34 checks **无** brave_deep_probe（零网络副作用）✓；② `--deep` ≡ `LASSO_DOCTOR_DEEP=1`：两者均 35 checks、同文案「BRAVE_API_KEYS 未配置…无事可做」warn ✓；③ 假 key + --deep → 真打 Brave API：**`brave_deep_probe=fail "Brave API 422（SUBSCRIPTION_TOKEN_INVALID）：key 无效（凭证被拒）"`**——doc/21 F-2 的 422 误分类已修正为凭证拒。**微观察 O-2**：该分支 detail 仍带「（本探测消耗 1 次额度）」——422 凭证拒实际不消耗计划额度，措辞与分类自相矛盾（外观问题，不判 fail） |

### 2.2 T-CONFIG（6/6 pass；1 产品缺陷已修）

| ID | 状态 | 关键输出 |
|---|---|---|
| T-CONFIG-02（U-07-1/2）config init | **pass** | 模板 20 key（ZHIPU_API_KEY/BRAVE_API_KEYS/BING_API_KEYS/LASSO_ALLOW_CLOUD_BROWSER/BROWSERBASE_API_KEY/STAGEHAND_API_KEY/LASSO_COOKIE_PASSPHRASE/ZHIPU_ENDPOINT/LASSO_CDP_PORT/LASSO_CACHE_DIR/LASSO_SEARCH_FREE_ONLY/LASSO_VLM_ENDPOINT/LASSO_RECORD_SEARCH/LASSO_CALLER_CAP_DEFAULT/LASSO_PROVIDERS_FILE/LASSO_HEADLESS_IDLE_MS/LASSO_LAUNCH_MODE/LASSO_LAUNCH_IDLE_MS/LASSO_PROXY + _comment）≥15 ✓；二次 init → "already exists (not overwritten)" exit 0 ✓ |
| T-CONFIG-03 config path 三分叉 | **pass** | `config path` → `/Users/wangdong/.lasso/config.json (not found)`；`LASSO_CONFIG_PATH=/x/y.json` → `/x/y.json (not found)`；无参 `config` → usage + **exit 1** ✓ |
| T-CONFIG-01（U-07-4/5/6）文件生效/env 覆盖/坏 JSON | **pass（修复后）** | 修复前实测 **file 配 BRAVE_API_KEYS 对 doctor 不可见**（brave_keys=warn 未配置）而 env 可见 → **FT-DEF-1 产品缺陷**（§3.1）。修复后：file `BRAVE_API_KEYS:"filek1,filek2"` → `brave_keys=pass "2 Key 已配置（合并配额 ≈ 2000/月…）"`；file+env 同名 → env 赢（`1 Key 已配置`）✓；坏 JSON `{broken` → stderr `config_file_parse_error` warn + 报告完整输出不崩（34 checks）✓（**微观察 O-3**：坏 JSON 时该 warn 打 2 次——loadConfig 与 mergedEnv 各读一次文件，双读无害） |
| 退役键静默（ZHIPU/BING） | **pass（修复后）** | file `ZHIPU_API_KEY:"z-test"` → `zhipu_keys_retired=warn "…该配置永远不被消费"`；file `BING_API_KEYS:"b1"` → 修复前 pass（漏报）、修复后 `bing_keys_retired=warn "1 个 BING_API_KEYS 已配置，但 Bing Search APIs 已于 2025-08-11 全量退役…"` ✓（FT-DEF-1 覆盖） |
| T-CONFIG-07 运行参数 env 边界 | **pass** | `LASSO_SEARCH_FREE_ONLY=L9` + `LASSO_CDP_PORT=abc` → doctor 34 checks 正常输出不崩；CDP 端口 NaN 回落 9222（cdp_9222 检查仍探 9222，config.ts v1.11 T12 NaN 守卫）；L9 非法档静默回落 L4 语义锚 search.ts:205（`freeOnly ?? "L4"`），真搜索侧由 T-RT-06 六连发（均 worked）佐证不崩 |
| T-CONFIG-08/09 registry | **pass** | doctor `provider_registry_loadable=pass`、`quota_ledger_initialized=pass`；`BUILTIN_PROVIDERS` 实测 4（browse_headless/browse_logged_in/brave/tavily，dist 导入实跑）。**观察 O-4**：doctor 输出无 provider 计数字段，清单「doctor 输出 provider 数」的预期字段不存在——按 registry loadable + 表实跑判 |

### 2.3 T-READ（5/5 pass + L-COST-13）

触发方式：本机夹具 `http://127.0.0.1:18191/big.txt`（190,399 B）经 fetch_url 触发 envelope spill（单 server 连接内续页，`ft-read-flow.mjs`）。

| ID | 状态 | 关键输出 |
|---|---|---|
| spill 触发（T-READ-02 前半） | **pass** | `truncated:true, ref:"@o1", total_bytes:190399, continue_hint:"read_text({ref:\"@o1\", offset:16384})", preview 16384B`；fetch 157ms。tools/list 17 工具中 fetch_url/screenshot/pdf/network 的 description 均含 read_text 指引（descriptions.ts 6 处 grep）——D1 修复后指引闭环 ✓ |
| T-READ-01 @oN 续页 | **pass** | `read_text {ref:@o1, offset:16384}` → 16384B，**与源文件字节 16384..32767 精确相等（match:true）**，eof:false |
| T-READ-02 hint 接线 | **pass** | 同上 continue_hint 精确形态 + 4 个工具 description 指路 |
| T-READ-03 ref 进程级失效 | **pass** | 重启 server 后同 ref → `{error:"Error: unknown ref: @o1"}` JSON payload，不抛裸异常 |
| T-READ-04 未知 ref | **pass** | `@o99` → JSON 带 error 字段（`unknown ref: @o99`） |
| T-READ-05 边界 | **pass** | offset=0 首页 match ✓；offset=999999 超尾 → `text:"", eof:true, total_bytes:190399`（诚实空页）；尾页 offset=180224 → 10175B eof:true 尾行匹配 ✓；`limit:65537` → zod `-32602 "Number must be less than or equal to 65536"`；`ref:"@x1"` → `-32602 "ref must match @oN"`；`offset:-5` → `-32602 ≥0`（SDK 以 isError content 呈现，非 exception） |
| **L-COST-13** | **回填** | read_text 续页 wall-clock：**4 / 2 / 4 ms**（3 次，200ms 间隔）——纯本地文件切片，符合「无第二跳」预期；§5 起步值空白，本轮回填建立基线 |

### 2.4 T-OBS + T-RT（治理组 9/9 pass；1 产品缺陷已修）

单 server 连接 `ft-admin-flow.mjs`（+ 3 个补充 probe）。

| ID | 状态 | 关键输出 |
|---|---|---|
| T-RT-02 tool_list | **pass** | `total_tools:17`，channel 分组：search/browse_headless/browse_logged_in/desktop/fetch/screenshot/pdf/network/read_text/search_local/wayback/fetch_feed/doctor 各 1、forest 3、admin 1 |
| T-OBS-01 metrics_snapshot | **pass** | 冷启动 `configured:true`（admin 通道 total=1）；2 次真搜索后 `search.machine_mcp total=2 success_rate=1`，字段族 `channel/total/success_count/failure_count/success_rate/latency_ms_p50/latency_ms_p95`（MetricsCollector.ts:38-39/146-147——**注意字段名是 latency_ms_p50 非 p50_ms**，清单表述按此对齐）。search1 2475ms / search2 1744ms（10 条结果，machine_mcp 命中） |
| T-OBS-03 serp_health | **pass** | `configured:true`，engines `baidu:hit=1, ddg:hit=1`（冷启动=1 ✓） |
| T-OBS-02 ResourceMonitor/退出 | **pass** | 每个测试 harness transport.close() 后 server 进程即退（面板末 ps 清点：本面板零残留 dist/index.js / chrome-devtools-mcp / lasso Chrome）；SIGINT/stdin-EOF 路径由 `stdin-eof-shutdown.spec.ts`（timing-sensitive 桶）在门禁覆盖 |
| T-RT-01 CapabilityBag 启停 | **pass** | `capability_disable browse_headless(reason)` → ok/changed:true，tools/list 中工具消失，**`notifications/tools/list_changed` 到达 1 次**（SDK 1.30 需以 `ToolListChangedNotificationSchema` 注册 handler——旧式字符串 method 会抛 `Schema is missing a method literal`，首测误报，换 schema 后实证 disable 1 次 + enable 再 1 次）；enable → 恢复 ✓ |
| T-RT-04 provider 热插拔 | **pass** | provider_add 带 `keys:["SHOULD_BE_STRIPPED"]` → `keys_from_env:false`（keys 剔除，只认 env，INV-10）✓；重名 add → `ok:false "registry.add failed: already registered"` ✓；set_tos ✓；remove → removed:true；再 remove → ok:true removed:false（诚实 no-op）✓ |
| T-RT-05 观测三件套 | **pass** | metrics_snapshot/breaker_status/serp_health 均无 reason 直接返回 |
| T-FALL-02/03 breaker_status | **pass** | `configured:true`，**short×10 + long×10**（search.brave/search.machine_mcp/fanout/serp_http/browse_headless/browse_logged_in/desktop.×4 + 条件 cloud 项），全部 closed，state/failure_count/opened_at 字段在 |
| D7 回归 breaker_reset | **pass** | unknown name → `ok:false "unknown breaker channel: no.such.channel (run breaker_status to list…)"`；真名 `search.brave` → `ok:true reset_short:true before{short:closed,long:closed} after{closed,closed}` + note「不自动 capability_enable」（保守设计自述） |
| T-RT-06 caller cap | **pass** | `caller_cap_set {callerId:anonymous, cap:5}` → 同窗先前已用 2（初始 2 搜索）→ 再 3 次 worked 后第 4-6 次 `didnt/caller_cap_exceeded`（`used=5 cap=5 windowMs=60000`，**60s 滑窗语义正确**）；`cap=0` → `ft-banned {used:0,cap:0}` 封禁条目在册；caller_cap_list ✓；测试后恢复 cap 防 spill |
| T-RT-08 admin 错误面 | **pass** | mutation 缺 reason → `ok:false "field required: reason"`；未知 action → `-32602 Invalid enum value`（结构化，不抛）；无参 → `-32602 Required at action`；全程无未捕获异常 |
| T-RT-03 SIGHUP 热更新 | **pass（修复后）** | `LASSO_PROVIDERS_FILE` 设 → `hot_reload_installed`；写 `ft-hot-1` + HUP → **修复前 `hot_plug_provider_error: TypeError: Cannot read properties of undefined (reading 'length')`（added:0，加不动）→ FT-DEF-2**；修复后 `hot_reload_applied added:1` + capability_list 见 ft-hot-1 ✓；坏 JSON + HUP → server 存活（serp_health 正常响应）+ `hot_reload_error` 日志 ✓；清空文件 + HUP → removed:1（hot_unplug）✓。**语义观察 O-5**：providers 文件是**全量替换语义**（existing−incoming 即 disable：首 HUP 时我的最小文件把 browse_headless/browse_logged_in 等 3 项 `removed_from_providers_file`）——代码即文档（hot-reload.ts applyHotReload diff 注释），但运维侧写最小文件会关停内置通道，KEY-GUIDE/ops 文档应明示「文件=权威全量集」 |
| T-RT-07 profile/cookie（无 Chrome 侧） | **pass（partial）** | `profile_list → {ok:true, configured:true, current:"default", profiles:1}`；cookie_restore 全链路需活 CDP 会话，归 logged_in 域执行员（9222 被 squat 的本机环境本轮不具备） |

### 2.5 T-FOREST（2/2 pass）

| ID | 状态 | 关键输出 |
|---|---|---|
| T-FOREST-01 RootRegistry 复用/共享计数器 | **pass** | 真机：navigate example.com → roots `@p0`；再 navigate 同 url → roots 仍 `@p0`（**REUSE_SAME_REF:true**）。**共享单计数器实证**：一进程内序列 `@p0(browse_headless) @p1(browse_logged_in) @w2(desktop) @p3(browse_headless)`——@p/@w 交替递增（RootRegistry.ts:34-36 单计数器设计）。LRU 256 上限为单测面（DEFAULT_MAX_ROOTS=256, RootRegistry.ts:32）。首启 headless 冷启动 navigate 14.2s（npx 拉起），二次 976ms |
| T-FOREST-02 前缀路由 | **pass** | 冷启动 roots（无浏览器）：`@p0/browse_logged_in`（title 诚实为 "Could not connect to Chrome…"）+ `@w1/desktop`（"访赖: 下载"——**rust-helper AXAPI 真窗口**）。`interact_observe {root_ref:@p0}` → `worked/chrome_devtools_mcp`（@p→browse 路由 ✓，preview 即"连不上 Chrome"错误页内容——见观察 O-6）；`@w1` → `worked/ax_snapshot`（@w→desktop 路由 ✓，真 AX 快照）；`@p99` → `didnt/stale_root_ref "unknown_root:@p99"` ✓；`@x0` → **schema 层 `-32602 "root_ref must be @pN or @wN"`**（dispatcher unknown_prefix 分支 InteractDispatcher.ts:114-115 经 MCP 不可达，为纵深防御——清单预期按实测定为 zod 拒绝）。注意 schema 参数名是 **`root_ref`**（interact.ts:50）非 rootRef |
| 资源三采样（浏览器场景） | pass | before 18 procs/1424MB（含 sibling 面板共存）→ **peak 39 procs/3738MB**（headless 树 +21 procs/+2.3GB）→ **after 4 procs/272MB，released:true**——退出清零（本面板 spawn 的 chrome-devtools-mcp 树全灭，ps 复核） |

### 2.6 T-SSRF + T-FALL（8/8 pass；1 安全缺陷已修）

| ID | 状态 | 关键输出 |
|---|---|---|
| T-SSRF-01 拦截矩阵 | **pass（修复后全绿）** | 默认 config：`192.168.1.1` → `didnt/ssrf_blocked:private_ip:192.168.1.1`（14ms）；`10.0.0.1` ✓；`evil.com@trusted.com` → `ssrf_blocked:userinfo_present` ✓；`ftp://x/` → `ssrf_blocked:protocol_not_allowed:ftp:` ✓；`169.254.169.254`（metadata，bonus）✓；**`127.0.0.1:18191` → worked/200（D10 放行设计 ✓）**；`198.18.5.5` → guard 放行（30s 连接超时 AbortError，非 ssrf_blocked）✓。**修复前 `[::1]`/`[fc00::1]`/`[fe80::1]`/`[::ffff:127.0.0.1]` 全部 ALLOWED → FT-DEF-3（§3.3）**；修复后全 BLOCKED（private_ip），公网 IPv6 `2606:4700:4700::1111` 仍 ALLOWED |
| T-SSRF-02 deny 扩展 | **pass** | `LASSO_SSRF_DENY_RANGES=203.0.113.0/24` → `203.0.113.9` → `ssrf_blocked:deny_range:203.0.113.9`（deny 优先 ✓）；同 server `127.0.0.1` 仍放行；doctor `ssrf_config=pass "allow=0 deny=1 (DEFAULT_ALLOW_RANGES 内置 2 条)"` ✓ |
| T-FALL-01 三态引擎 | **pass（成功侧实证 + 锚点）** | search `actions_and_results:[{channel:search.machine_mcp, outcome:worked}]`，final worked/fallback_used:false；didnt/unknown 立即返回不降级由 outcome.ts:104-119 NOT_FALLBACK_WORTHY_PATTERNS 单一真源守（404/403/nxdomain/needs_manual_2fa 等）；多 channel 失败链路在 npm test 的 fallback 系 spec 覆盖（本机唯一活上游=machine_mcp，无可安全击穿的第二上游，不强造） |
| T-FALL-06 outcome 归一化 | **pass** | 本地 `/404` → `didnt "http_404"` 8ms 立即返回（standalone 工具无链）；`/500` → `unknown "http_500"`（transient 语义 ✓）；`/redir`（302）→ `didnt/redirect_not_followed + location:"/big.txt"`（拒跟随防 SSRF 绕过 ✓）；`/empty200` → `worked body_bytes:0`（2xx=worked 设计） |
| T-FALL-04 PolicyGate cloud | **pass（锚点侧）** | 无 key 时 tools/list 无 browserbase/steel（17 工具实测）；policy 双重解锁源锚 index.ts:245-249（manual-switch AND key）；audit 链 `policy_blocked:cloud_browser_requires_manual_switch` 的触发需解锁侧配置，归 cloud 域用例 |
| T-FALL-05 BudgetTracker/partial_failures | **waived（本机不可达，锚点+单测在册）** | 多 channel 失败需击穿 machine_mcp（唯一活上游）；BudgetTracker 120s 链预算与 partial_failures(channel+error) 形状由 fallback/ 系 spec 门禁覆盖；不强造失败（守「不与用户环境争资源」） |

---

## 3. 缺陷与修复（3 个产品缺陷，全部「先判用例→再修产品→回归钉」）

### 3.1 FT-DEF-1 doctor 不感知 config 文件键（brave/bing/zhipu/proxy）——已修

- **现象**：file 配 `BRAVE_API_KEYS` → doctor `brave_keys=warn 未配置`；file 配 `BING_API_KEYS` → `bing_keys_retired=pass`（漏退役提示）；env 同名则一切正常。
- **用例判定**：预期正确——index.ts:270-272 注释自述「doctor CLI 也走 loadConfig（file→env 合成）」、模板 `_comment` 承诺「Env variables override this file」；产品违反自述契约 → 产品缺陷。
- **根因**：runDoctor 内 `opts.braveKeysCsv ?? process.env.BRAVE_API_KEYS`（doctor.ts:562-566）、`bingKeysCsv`（:580-584）、`LASSO_PROXY`（:548）、`ZHIPU_ENDPOINT`（:511）直读裸 env；runDoctorCli 只显式接了 zhipuKey 一家（index.ts:283-285），MCP doctorOpts（index.ts:838-861）连 zhipuKey 都没接。**运行时 BraveChannel 却按 loadConfig 合并后 env 装配（config.ts:346→index.ts:497-507）——医生与运行时各说各话。**
- **修复**（守 R-CI-02 单一真源）：config.ts 新增导出 `mergedEnv()`（file→env 合并抽出，loadConfig 同源改用）；index.ts 两调用点（runDoctorCli + doctorOpts）经 mergedEnv 传 `zhipuKey/zhipuEndpoint/braveKeysCsv/bingKeysCsv/proxy`；doctor.ts DoctorOptions 增 `zhipuEndpoint?`。
- **边界裁决（不做半吊子扩面）**：cloud 家族键（LASSO_ALLOW_CLOUD_BROWSER/BROWSERBASE/STAGEHAND/STEEL_ENDPOINT）**不改**——运行时双重解锁（index.ts:245-249 `shouldEnableCloud`）同样直读裸 env，doctor 直读与运行时一致=诚实；「模板含 cloud 键但 file 配置不解锁」是模板承诺缺口，记观察 O-7 留产品 owner 裁决（改运行时会动安全闸门，超出本轮最小修复面）。
- **回归钉**：doctor-cli-config-file.spec.ts +3 用例（file BRAVE 2 key → "2 Key"；file+env → env 赢 "1 Key"；file BING → bing_keys_retired warn）。**INV-71 检测体同步**（内联合并 or mergedEnv 单源两形态任一）+ **inv-selftest mutation 迁形**（原 mutation 串已不存在 → 假绿，selftest 首跑抓出、即改）。7/7 绿。

### 3.2 FT-DEF-2 SIGHUP 热插拔 keys-less provider 抛 TypeError——已修

- **现象**：`LASSO_PROVIDERS_FILE` 内 `{"providers":[{name,type,endpoint_url}]}`（无 keys 字段）+ HUP → `hot_plug_provider_error: TypeError: Cannot read properties of undefined (reading 'length')`，added:0。
- **用例判定**：T-RT-03「加 provider 生效」预期正确；产品缺陷。
- **根因**：provider-registry.ts:176（add）与 :69（constructor）`config.keys.length` 对 undefined 抛；admin 路径有 buildProviderConfig 归一化（keys:[]）幸免，SIGHUP 路径 untyped JSON 直进 → 同一入口两种命运（信任边界缺校验）。
- **修复**：两处 `(config.keys?.length ?? 0) > 0`（registry 是 INV-40 唯一 add 入口=正确 choke point）；缺 keys → ledger=null（channel 自报 unavailable，与设计语义一致）。
- **回归钉**：runtime-hot-plug.test.ts +2 用例（add + constructor 双路径）。12/12 绿；真机复跑 `added:1` ✓。
- **清单外观察 O-8**：SIGHUP 文件里写 keys 数组会被 registry.add 消费创建 ledger——**违反 INV-10「keys 只从 env」的精神**（admin 路径强制剔除 body keys，SIGHUP 路径不剔）。修法需决策（SIGHUP 路径也走 env 归一化 or 文档禁写），非本轮最小面，留产品 owner。

### 3.3 FT-DEF-3 IPv6 字面量 URL 绕过 SSRF 守卫——已修（安全级）

- **现象**（真机，TUN 环境）：`ssrfGuard("http://[::1]:9222/...")` → **ALLOWED**；`[fc00::1]`/`[fe80::1]`/`[fd12::1]`/`[::ffff:127.0.0.1]`/`[::ffff:10.0.0.1]` 全部 ALLOWED——PRIVATE_RANGES 明明含 `::1/128`、`fc00::/7`、`fe80::/10`。
- **用例判定**：defaults.ts 私网表含 IPv6 段=意图明确；判定产品缺陷（且 cidr.ts 本身判得对：`isPrivateIp("::1")=true`）。
- **根因链**（值级 trace）：Node 24 `new URL("http://[::1]:80/").hostname` 返回**带方括号的 "[::1]"**（实测）→ guard 把带括号串当 hostname 送 `dns.lookup` → 非法字面量走域名解析 → **ClashX TUN fake-ip 把它"解析"成 198.18.x.x** → 命中 DEFAULT_ALLOW_RANGES（fake-ip 放行段）→ ALLOWED。直连环境则 lookup 抛错 → dns_failed（误拒路径，也是错但不放大）。单测没抓到是因为 vi.mock 的 lookup 忽略 hostname 参数（mock 按 producer 假设写死——03 §1.2/2.1 的教科书案例）。
- **修复**：ssrf-guard.ts lookup 前剥括号 `hostname.replace(/^\[(.+)\]$/, "$1")`——剥后 "::1" 被 node:dns 识别为字面量直接返回，进 isPrivateIp → 拒。
- **回归钉**：ssrf-guard.spec.ts mock 增 `gotHost` 记录 + 3 用例（[::1] → lookup 收到 "::1" 且拒；[::ffff:7f00:1] hex 形式拒；公网 IPv6 字面量不误拒）。31/31 绿。**真机复验（TUN 开启的最 harsh 环境）**：6 类 IPv6 私网/映射全 BLOCKED，公网 IPv6 与 127.0.0.1 设计放行不变。

### 3.4 缺陷汇总

| # | 级别 | 一句话 | 状态 |
|---|---|---|---|
| FT-DEF-1 | 🟡 | doctor（CLI+MCP）直读裸 env，file 配置的 BRAVE/BING/ZHIPU/PROXY 键不可见而运行时却装配 | **已修+钉**（mergedEnv 单源；+3 测；INV-71/selftest 迁形） |
| FT-DEF-2 | 🟡 | SIGHUP 热插拔 keys-less provider 在 registry.add 抛 TypeError（admin 路径幸免） | **已修+钉**（两处 null-safe；+2 测） |
| FT-DEF-3 | 🔴（安全） | IPv6 字面量 URL 经 TUN fake-ip 绕过 SSRF（loopback/ULA/IPv4-mapped 全放行） | **已修+钉**（剥括号；mock 补 gotHost 断言 +3 测；真机复验） |

---

## 4. 性能数据（§5 表格式回填 + 本域补充）

### 4.1 §5 正式行

| ID | 场景 | 指标 | 本轮回填 | 状态 |
|---|---|---|---|---|
| L-COST-13 | read_text 续页（spill 命中后翻页） | wall-clock | **4 / 2 / 4 ms**（3 次，190KB spill 文件 16KiB 页） | pass（基线建立） |

### 4.2 本域补充时序（非 §5 行，供后续轮对照）

| 场景 | 实测 | 备注 |
|---|---|---|
| doctor CLI 全量（34 checks） | ~7-9s | 含 stagehand HEAD 探测超时项 |
| doctor --stealth-check | 13.5s（低载）/ 46.2s（sibling 高载） | 含 headless spawn + creepjs 实跑 |
| search machine_mcp 第一跳 | 2475ms / 1744ms（2 次） | 与 §5 L-COST-01 起步区间 1.4-4.1s 一致 |
| admin 治理 action（metrics/breaker 等） | 2-5ms | in-process 只读 |
| fetch_url 本地 190KB | 157ms | spill 含 0o600 落盘 |
| browse_headless 首启 navigate | 14162ms（冷 npx）/ 二次 976ms | 与 U-02-1 的 10-60s 口径相容 |
| SSRF 拒绝路径 | 2-14ms | guard 快速失败不拖尾 |

---

## 5. 02 简单架构对齐判定（R11 域内证据行；锚点= v1.17.0 工作树 + 本轮 diff）

> 判定纪律：证据 L1+（grep 实跑/真机）；阈值均为起点值未校准；只有 R-FF-01/02/04 可 ❌。本表只填 R11（基建与治理域）证据最硬的行，其余行留给对应域执行员，避免重复劳动（守 R-CI-02）。

| 规则 | 级别 | 判定 | 证据（L1+） |
|---|---|---|---|
| R-FF-01 分层方向 | 🔴 | **✅** | `grep "from \"../channels/" src/runtime/ src/forest/` → **0 运行时边**（forest 仅 2 处 `import type`——InteractDispatcher.ts:25-26，类型边编译期擦除，README §34-36 文档化该纪律）；runtime/ 禁 channel internal 由 INV-35 门禁（check-invariants 81/81 实跑） |
| R-FF-02 循环依赖 | 🔴 | **✅** | channels→tools 反向 import grep = 0；src 内 import index = 0；tsc 单项目全量编译 0 error（机器检查） |
| R-DEP-03/R-FF-04 穿堂式=0 | 🔴 | **✅（域内抽验）** | 域内 wrapper 抽验：read-text.ts handler 含错误归一化逻辑（catch→JSON payload）；doctor-tool.ts handler = runDoctor + JSON 序列化（适配器边界加语义，非裸转发）；admin.ts 620 行 action-enum handler（实质分派+audit+requireArgs 校验）。tools/*.ts 共 6048 行对 17 工具，非穿堂形态 |
| R-CI-02 横切单源 | 🟡 | **✅** | ssrfGuard 实调 7 处（fetch-url/wayback/network/screenshot/pdf/browserbase/steel/fetch-feed）同一函数同 config 族（INV-31）；本轮 FT-DEF-1 修复正是消第二实现（file→env 合并收敛 mergedEnv 单源）；连接池 acquireHttpClient 同族（INV-32）。**反例在案（O-8）**：keys 读取 env-only 铁律在 SIGHUP 路径漏一刀 → ⚠️ 面（已记录待裁决，不构成本行 ❌：错误处理范式仍单源，是 intake 校验缺口） |
| R-INT-07 运行时同源耦合 | 🟡 | **✅（共享态有界+独立降级）** | SubprocessManager 消费者：index.ts（MCP client 池）+ launcher 家族（chrome ledger/stop/reaper）+ observ + fetch-url（http client 池）——共享 mutable 态存在但**各 channel 独立 breaker**（实测 10 short + 10 long 全 closed，per-channel 独立降级）；idle reaper/chrome-stop 共享 kill-tree 单源（INV-77a） |
| R-INT-08 外部命名空间契约 | 🟡 | **✅** | chrome-devtools-mcp@1.7.0 锁版（SubprocessManager + package-lock 双锁）；upstream-response.ts 单一权威解析（markdown 围栏/base64 双层编码收敛一处，W1-DEF-1b 修复物）；**本轮 FT-DEF-3 是本行的活教材**：`URL.hostname` 括号行为=宿主平台契约，靠真机 L3 抓出、mock 放过——契约常量已带实测注释钉住 |
| R-DEP-02 模块深度 | 🟡 | **✅（域内样本）** | chrome-stop.ts 248 行 / 5 个导出函数（接口 2 参 CLI 形状，实现=五步流程）depth ≫ 阈值；反例候选未在域内发现（admin wrapper 层 620 行带校验/audit 语义） |
| R-CI-06 rejected-by-design | 🔵 | **✅** | doc/24-颠覆性调研/ decision-*.md 三件在册（decision-search-layer/local-search/interaction-upgrade，含触发条件写死的 D-NOGO 项） |
| R-ABS-02 内联差异率 | 🔵 | **✅（域内样本）** | fetch_feed 完全复用 doFetchUrl（fetch-feed.ts:19-21 注释 + 实装），无第二套 fetch 护栏 |
| R-INT-02 开闭违反（新增 tool 修改点） | 🟡 | **⚠️（有 INV 守护）** | 新增 tool 四处联动（注册器+index 注册+V5_TOOL_TO_CHANNEL+descriptions，INV-81(f) 自述）；本轮未新增 tool 不新增样本；阈值命中但 INV-81 系机械化守护在册，按 02 §E #2 降级说明 |
| R-CI-03 同名实体多义 | 🟡 | **⚠️→✅（文档化区分在案）** | @oN/@pN/@wN/rN 四套句柄前缀各有单一入口与 description 自述（read-text.ts:24-26 自述进程级失效）；本轮实测四套行为互不串（@o1 续读/@p0 路由/@w1 路由/rN 抽取句柄归 browse 域） |

**02 起步最小集达标情况（R11 域内可见部分）**：R-FF-01 ✅ / R-FF-02 ✅ / R-DEP-03 ✅（域内抽验）/ R-CHG-01（本轮 diff 触 6 文件、每缺陷 2-4 文件，未超 10 文件阈值）/ R-CI-01（served_by/outcome/retrieval_method 三词全程一致，本轮 40+ 条响应零拼写漂移）/ review 三问（双 tmp 根等属 browse 域，不在本域取证）。
**声明**：以上阈值为起点值未校准（02 §0.3）；R11 只覆盖基建与治理域，全仓 38 条完整判定需各域执行员汇齐。

---

## 6. 03 审查测试清单自检（R11 域）

| 03 条目 | 本轮命中与处置 |
|---|---|
| §0.3 证据阶梯 | 全部 verdict 附 L1（源码锚点）/L2（真机响应 JSON）/L3（TUN 下 FT-DEF-3 无插桩复现）；清单旧预期「--stealth-check 被忽略」按 L3 新证据推翻（D11 已修的历史演进） |
| §1.2 项 1 producer 契约 | FT-DEF-3 正是违反样本（mock lookup 忽略 hostname=按假设写死）；修复时把 mock 升级为记录 gotHost 的契约断言（producer→consumer 接缝钉住） |
| §1.5 项 2 Heisenbug | SSRF/时序全部真机 stdio server 复现；无同步插桩 |
| §2.1 项 3 测试必须能失败 | 3 个缺陷各带回归钉；INV-71 假绿被 inv-selftest 抓出并迁形（20/20 恢复） |
| §3.1 闭环 | 3 缺陷全部「判用例→修产品→钉回归→门禁重跑」闭环；§3.2 回溯：FT-DEF-1→1.4（接线陈述≠运行时证据，doctor 与运行时两半各自为真整体为假）；FT-DEF-2/3→1.2（信任边界缺校验/mock 假设） |
| flaky 政策 | 首轮 12 红=并行 sibling 面板负载超时（隔离全绿）；根因是执行编排（多执行员同机跑浏览器）非产品，记录在案供主循环排程参考 |

---

## 7. 残留清理（§0.2 第 7 条）

- 本面板自 spawn：headless chrome-devtools-mcp 树 ×3（stealth×2 + forest×1）——**全部随进程退出清零**（ps 复核：本面板 spawn 的 pid 51005/53305/forest 树全部消失；after 采样 4 procs/272MB released:true）。
- 本地夹具 127.0.0.1:18191（ft-http-fixture pid 70418）已 kill、/tmp/lasso-ft 与 /tmp/ft-* 临时件已删。
- **收尾全量 ps 清点**：现存 3 棵 chrome-devtools-mcp 树（根 ppid=2924/5057/7515）逐一归属判定——父进程均为**活跃的 claude agent 会话**（其一 = 本轮主会话 90cc10fb 的 sibling 执行面板，另两个 = 其他 CC 会话），ppid 活着非孤儿、cmdline 无 lasso user-data-dir → **不属本面板、不清理**（宽匹配批量击杀禁令 + 各面板自理）。
- 台账 launched-chromes.json 恒 `[]`（本面板未 launch Chrome）；caller cap 测试后已恢复（且进程退出即清零）。
- **9222 squat Chrome（pid 2420，用户 Chrome 150，无调试参数）不动**——判明非 lasso 产物。

---

## 8. 观察清单（不构成 finding，供主循环/清单官处置）

| # | 观察 | 建议 |
|---|---|---|
| O-1 | doctor 检查计数：CLI 34 / MCP 41（desktop 家族 7 项非 6）；清单「39 项」「#15-#20」为 v1.7 陈旧计数 | 清单补充官回填 |
| O-2 | brave_deep_probe 422 分支 detail 仍写「消耗 1 次额度」——凭证拒不消耗计划额度，措辞与已修正的分类矛盾 | 措辞修（低优） |
| O-3 | 坏 JSON 时 config_file_parse_error warn 打 2 次（loadConfig + mergedEnv 双读） | 无害；如要消除可在 mergedEnv 加读缓存（不建议——增状态） |
| O-4 | doctor 无 provider 计数输出，T-CONFIG-09 预期字段不存在 | 清单措辞对齐 |
| O-5 | providers 文件=全量替换语义（最小文件会 disable 内置通道）；KEY-GUIDE/README 未明示 | 文档补一句「文件是权威全量集」 |
| O-6 | logged_in 通道对死 CDP 的 snapshot 返 worked，内容是"Could not connect to Chrome"错误页文本（9222 squat 环境实测；W1-DEF-5 的 navigate 校验不覆盖 snapshot 路径） | 归 logged_in 域：snapshot 加 NAV_ERROR_SIGNATURES 二次校验的候补评估 |
| O-7 | config 模板含 cloud 键（BROWSERBASE/STAGEHAND/LASSO_ALLOW_CLOUD_BROWSER）但运行时双重解锁只读 env——file 配置不解锁 | 产品 owner 裁决：模板删键 or shouldEnableCloud 走 mergedEnv（动安全闸门，未纳入本轮） |
| O-8 | SIGHUP 路径接受文件内 keys（违反 INV-10 env-only 精神；admin 路径剔除） | 同上裁决（本轮已修 TypeError，键语义留档） |
| O-9 | interact_observe/act 的 MCP 参数名是 root_ref（snake_case），description 用 rootRef 字样——模型偶发传 rootRef 会 -32602 | description 统一示例拼写（低优） |

---

## 9. 门禁终态

| 门 | 终态 |
|---|---|
| build | ✅ 0 error |
| npm test | ✅ **2239（2238 pass + 1 skip by design）exit 0**——2227 基线 + 本域新增 8 用例（doctor-config×3 / hot-plug×2 / ssrf×3）+ 并行 sibling 面板同工作树新增 4 用例（tab-session/browse-upstream-contract，git status 佐证共享工作树的并发编辑）；只增不减 ✓ |
| check-invariants | ✅ 81/81（INV-71 检测体迁形后仍 81） |
| inv-selftest | ✅ 20/20（INV-71 mutation 同步迁到 mergedEnv 形状——原 mutation 串不存在时被 selftest 抓出假绿，即改即验） |

**本域修改文件清单**（供主循环 review）：src/config/config.ts（mergedEnv 导出）/ src/config/provider-registry.ts（keys null-safe ×2）/ src/doctor/doctor.ts（zhipuEndpoint opt）/ src/index.ts（两 doctor 调用点接线）/ src/ssrf/ssrf-guard.ts（IPv6 剥括号）/ src/invariants/check-invariants.mjs（INV-71 检测体）/ scripts/inv-selftest.mjs（INV-71 mutation）/ test 三文件 +8 用例。
