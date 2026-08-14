# Wave1 执行记录 — 搜索/治理/安全面板（wave1-gov-search）

## 执行时间与环境

- 执行时间：2026-08-15 01:59 – 02:30（本地）；2026-08-14T17:59Z – 18:25Z（UTC）
- 执行者：Lasso 功能验证执行员（Claude subagent）
- 环境：macOS Darwin 21.6.0（Intel MacBookPro11,4）/ Node v24.12.0（nvm）/ lasso-mcp v1.7.0（dist 已构建，`node dist/index.js` 从仓库根启动）
- 网络：本机经 ClashX Pro 代理（fake-ip TUN，utun3；DEFAULT_ALLOW_RANGES 含 198.18.0.0/15 故 fake-ip 解析放行——本次全部公网 fetch 均真实成功，即为放行证据）
- 执行工具：本目录 `mcp.mjs`（单调用 CLI）+ `mcp-batch.mjs`（同会话多调用 + env 透传 + tools/list_changed 捕获）。SDK @modelcontextprotocol/sdk 1.29.0（node_modules 已装）。tools/list 自检通过：14 工具（search/browse_headless/browse_logged_in/desktop/fetch_url/screenshot/pdf/network/wayback_lookup/doctor/interact_roots/interact_observe/interact_act/admin），无 browserbase/steel/read_text/stagehand
- 原始证据文件（本目录）：`doctor-mcp.json`、`doctor-cli.json`、`ssrf.jsonl`、`ssrf2.jsonl`、`fetch1.jsonl`、`wayback.jsonl`/`wayback2.jsonl`、`search1.jsonl`、`search2.jsonl`、`u085.jsonl`、`u085b.mjs`+`u085d-stderr.log`、`admin1.jsonl`、`admin2.jsonl`、`caps.jsonl`、`t-entry-04.jsonl`+`t-entry-04-stderr.log`、`forest.jsonl`、`forest2.jsonl`
- 注意：nvm 的 node shim 会向前缀 PATH 重新注入 nvm bin 目录——env 前缀试验须用绝对路径 node（`/Users/wangdong/.nvm/versions/node/v24.12.0/bin/node` + `env -i`）才真正生效（u085 前两轮因此无效，第三轮修正后成功）

## 探测 A 结论（供后续裁决，先跑 doctor 一次定调）

| 探测项 | 结果 | 裁决 |
|---|---|---|
| zhipu_api_key | **fail「ZHIPU_API_KEY 未设置」**（~/.lasso/config.json 不存在） | 智谱通道本机不可用；search API 源缺位，search.zhipu 在链中记 unknown `ZHIPU_API_KEY missing` |
| doctor #36 machine_search_mcp | **pass：已检测到机器 web-search-prime MCP（host=open.bigmodel.cn；Authorization 已配置；fallback_chain 首选 search.machine_mcp）**，无 url/auth 值泄漏 | 机器 MCP 可用（仅 engine=fallback_chain 路径注入，engine=auto 不含——见 T-SEARCH-11/U-08-7 判定注） |
| ready 语义 | ready=false，blockers（fail 级）= zhipu_api_key + cdp_9222_logged_in；brave_keys/config_file/#38/#39 等 warn 均**不阻塞** ready | T-SEARCH-25 口径验证通过 |
| 其余 | #37 steel 默认 pass；#39 stagehand warn（fetch failed）；#38 stealth warn-skip（stealthCheck=false，D11 佐证）；CLI 模式 desktop 六项 warn-skip（desktopChecks=false 属设计）；MCP 模式 doctor desktopChecks=true（rust_helper_running pass、TCC 双授权 pass） | — |

## 逐条结果

| ID | verdict | 实际观察（关键输出摘录） | 用例判定（fail 时必填） |
|---|---|---|---|
| T-SSRF-01 | pass | 5 URL 实测：`192.168.1.1`→didnt `ssrf_blocked:private_ip:192.168.1.1`；`10.0.0.1`→同；`evil.com@trusted.com`→didnt `ssrf_blocked:userinfo_present`；`ftp://x/`→didnt `ssrf_blocked:protocol_not_allowed:ftp:`；`http://127.0.0.1:9222/json/version`→**放行**（到达 HTTP 层，err=http_404，非 ssrf_blocked）——D10 预期命中 | — |
| T-SSRF-02 | pass | `LASSO_SSRF_DENY_RANGES="203.0.113.0/24"` 子进程（env 前缀+显式 env 透传）：fetch `203.0.113.1`→didnt `ssrf_blocked:deny_range:203.0.113.1`（deny 优先）；doctor ssrf_config pass `allow=0 deny=1`。TUN fake-ip 段放行由全部公网 fetch 真实成功佐证（198.18.x 解析未被拦） | — |
| T-FALL-06 | pass | `fetch_url https://httpbin.org/status/404`→outcome=didnt、error=http_404、立即返回（fetch_url 无 fallback 链，didnt 语义成立） | — |
| T-TOOLS-08 | pass | ① example.com→worked body_kind=html body_bytes=559；② httpbin.org/redirect/2→didnt + retrieval_method=redirect_not_followed + body_kind=redirect + location=/relative-redirect/1（3xx 不跟随）；③ markdown 模式→body_kind=`markdown:defuddle+turndown`，preview 为正文 markdown；④ >48KiB（wikipedia 442538B）→envelope truncated:true ref=@o1 total_bytes=442538，落盘 `$TMPDIR/lasso-output/@o1.txt`（mode 0600，UTF-8 HTML，非 /tmp ✓）；continue_hint 指向 read_text（read_text 缺席=D1 缺陷证据再采集） | — |
| T-SEARCH-15 | blocked | 场景①info.cern.ch：archive.org availability API 对 node/undici 客户端恒 429（同 IP curl 却 200；裸 node fetch 任意 UA/headers 均 429——TLS 指纹级拦截，多次退避重试无效）→ lasso 诚实返 didnt/http_429；场景②no-such-page：同 429；场景③私网 192.168.1.1→didnt `ssrf_blocked:private_ip` ✓ | 场景①②为外部上游反爬所致（环境阻断非产品缺陷；错误语义诚实）。场景③ pass。回归条件：换出口 IP 或上游解除 undici 拦截 |
| T-SEARCH-11 | pass | L1→didnt + retrieval_method=free_only_filtered + `free_only=L1 excluded all search providers`；L2→worked（zhipu 剔除后落 SERP baidu）；L4→worked；**省略→worked 且行为=L4**（且命中 L2 写入的同 key 缓存，cached:true——证明默认未过滤，`freeOnly ?? "L4"` 得证） | — |
| T-SEARCH-12 | pass | 同参第二次→顶层 `cached:true`（磁盘缓存 ~/.cache/lasso/search-cache/76/f9/…，LRU 目录结构可见）；no_cache:true→重新真搜（cached 无）；limit 5→6 不误命中；engine 改 zhipu / region 改 us 均不误命中。观察：free_only 不入 cache key（L2 结果被 L4 查询命中，与 INV-11 描述一致，非违规） | — |
| T-SEARCH-17 | pass | 冷启动 serp_health：engines=[baidu,google] 均 hit_rate=1（hit=0/miss=0 乐观默认）、redesign_suspected=false、recent_alerts=[]、last_known_good 有值；不自动重写 selector | — |
| T-SEARCH-25 | pass | doctor：#36 machine_search_mcp 本机=pass（detected）；brave_keys=warn 且**不在 fail blockers**（blockers 仅 zhipu_api_key、cdp_9222）；确认无 "info" 级（仅 pass/fail/warn） | — |
| T-SEARCH-29 | pass | `query:""`→MCP -32602 zod `too_small minimum:1`；`limit:51`→`too_big maximum:50`；均结构化错误、未触发真实搜索 | — |
| T-RT-01 | pass | capability_disable browse_headless（带 reason）→ok:true changed:true + **new_notifications:1（tools/list_changed）**，tools/list count 14→13 且 browse_headless 消失；capability_enable→通知再来 1 次，count 恢复 14 | — |
| T-RT-02 | pass | admin tool_list：12 channel 分组（search/browse_headless/browse_logged_in/desktop/fetch/screenshot/pdf/network/wayback/doctor/forest/admin），total_tools=14 与 tools/list 一致；admin 可被调用（自身在表中）且 disable("admin") 因不在 bag 返 false（源码注释自证） | — |
| T-RT-04 | pass | provider_add（config.type=api_key 必填，首测漏 type 被 zod 拒——补 type 后）：ok:true + **keys_from_env:false**（body 传 keys:["literal-key-should-be-ignored"] 被完全忽略，仅读 T1_API_KEYS env）；重名 add→ok:false `registry.add failed: t1 already registered`；provider_set_tos→ok（未注册名→ok:false provider not found）；provider_remove→ok:true；admin_audit 日志（callerId/reason/动作载荷）落 stderr 结构化日志 | — |
| T-RT-05 | pass | metrics_snapshot / breaker_status / serp_health 三只读 action 均不传 reason 且 ok:true；breaker_status 含 short+long 两类（见 T-FALL-02/03） | — |
| T-RT-06 | **fail** | caller_cap_set {callerId:"t",cap:5}→ok:true；随后 6 次真实工具调用（fetch_url）**全部成功、无一被拒**；caller_cap_list 显示 `used:0 cap:5`——6 次调用后 used 仍 0，证明根本无计数；cap=0 后 list 记录 cap:0 同样无封禁效果 | **用例对，产品错（接线缺口）**。源码 CallerTierTracker.ts:26 自证设计意图「search.ts / browse.ts handler 入口处调 tryAcquire」，但全仓 grep `tryAcquire` 零调用点（src/ 与 dist/ 均无）——caller-tier 配额完全未接线到任何工具入口，set/list 只是空转状态存储 |
| T-RT-08 | pass | mutation 缺 reason→ok:false `field required: reason`；未知 action `definitely_not_an_action`→MCP -32602 zod invalid_enum_value 结构化错误；空参 `{}`→zod required 错误（列出合法 enum）；全程无未捕获异常 | — |
| T-OBS-01 | pass | 跑过 search 后 metrics_snapshot：search.zhipu total=4 success_rate=0（真实失败，last_error/last_error_at 有值）、browse_headless total=4 success_rate=1 含 latency_ms_p50=4/p95=7；冷会话 channels:[] | — |
| T-OBS-03 | pass | serp_health 冷启动 hit_rate=1（T-SEARCH-17 同源证据）；search 后 hit/miss 计数仍 0（本机 SERP 抽取结果为空未记 hit/miss，见观察） | — |
| T-FALL-01 | pass | 三态实测：SSRF/404 类 didnt 立即返回（fetch 404→didnt 短路）；unknown（`ZHIPU_API_KEY missing`）触发降级（actions_and_results: zhipu unknown→browse_headless）；链耗尽→didnt + retrieval_method=fallback_exhausted + error=all_channels_failed_or_skipped（u085d 完整审计链）；2FA 终止分支 needs_manual_2fa→didnt（源码 BrowseChannel.ts:803 分类器验证，本机无 2FA 页未实测） | — |
| T-FALL-02 | pass | breaker_status：kind=short 条目 13 个；搜索失败后实测 search.zhipu short **state=open failure_count=3 opened_at=<ts>**（search1 会话）；state 值域 closed/open/half-open（源码） | — |
| T-FALL-03 | pass | kind=long 条目 13 个（含 browse_cloud_* 三条），long 条目含 **window_failure_count:0** + opened_at；确认无 breaker_reset action（D7 维持——admin action enum 无此值，zod 即拒） | — |
| T-FALL-04 | pass | 阻断侧（零配置）：启动日志 `cloud_browser_channels_skipped reason=manual_switch_off_default manual_switch=false`（u085b-stderr.log 实录）+ listTools 无云工具。注：`policy_blocked:cloud_browser_requires_manual_switch` 出现于审计链需「已接线但被 gate」状态（LASSO_ALLOW_CLOUD_BROWSER=true+key），本机无 key 不可达——阻断侧证据已按清单「阻断侧见 T-CLOUD-01」口径覆盖 | — |
| T-FALL-05 | pass | 多 channel 失败审计链：actions_and_results 每项含 channel+outcome+error（`search.zhipu unknown "ZHIPU_API_KEY missing"`、`browse_headless unknown "spawn npx ENOENT"`）；链预算 DEFAULT_CHAIN_BUDGET_MS=120_000（BudgetTracker.ts:35 源码锚定；实测 spawn 退避 ~35s 链仍在预算内完成）。注：fanout 路径 partial_failures 字段（types.ts:49）需双源才可达，本机无 brave key 未触达——以 fallback 链 actions_and_results 为等价审计证据 | — |
| T-CLOUD-01 | pass | 默认启动 stderr：`{"evt":"cloud_browser_channels_skipped","reason":"manual_switch_off_default","manual_switch":false,"has_browserbase_key":false,"has_stagehand_key":false,"has_steel_endpoint":false}`；listTools 无 browserbase/steel/stagehand 工具 | — |
| T-STEEL-06 | pass | 三态中两态实测：①开关关→#37 pass「Steel 通道未启用；PolicyGate 将阻断」；②开关开无 endpoint→#37 **warn** + next_step=`export STEEL_ENDPOINT=http://localhost:3000…`；均无 fail。③全配（容器健康检查）需 Steel Docker 容器——**waived（需服务⏸）** | — |
| T-SH-02 | pass | vitest `test/unit/stagehand-channel.spec.ts` 34/34 绿（0 网络调用）：`act(...) → outcome=didnt + retrieval_method=stagehand_observe_only`、error 含 `does_not_act`、`act(...) 永远不触网`、`act 不返 worked/unknown` | — |
| T-SH-03 | pass | doctor #39 warn：`api.stagehand.dev/verify 探测失败：TypeError: fetch failed（按 R-ECO-6 不存在处理）`；旁证 `curl -I` HTTP_CODE=000（拒连，非 404——契约端点不存在，R-ECO-6 虚构确认）；该 warn 不在 fail blockers | — |
| T-SH-04 | pass | 默认 OFF→#21 cloud_browser_manual_switch pass「LASSO_ALLOW_CLOUD_BROWSER=false（默认；PolicyGate 将阻断）」；开关开+key 缺→warn + next_step=`export BROWSERBASE_API_KEY=<key> 或 STAGEHAND_API_KEY=<key>…`（T-STEEL-06 第二态同会话实录） | — |
| T-FOREST-01 | pass | 两次 interact_roots 完全一致：@p0=example.com(browse_headless)、@p1(browse_logged_in)、@w2/@w3(desktop 窗口)——同 url 复用同 @pN ✓；@p/@w 共享计数器（@p0,@p1,@w2,@w3 连续交替递增）✓；LRU 256 上限为源码值（doctor forest_ref_counter_strategy pass 旁证） | — |
| T-FOREST-02 | pass | @p0 observe→worked served_by=browse_headless（preview 为 a11y 快照）；@w2 observe→worked **served_by=desktop.ax method=ax_snapshot**（@w→desktop 路由实证）；@p99 act→didnt `stale_root_ref` error=unknown_root:@p99；@x0→zod 结构化错误 `root_ref must be @pN (browse page) or @wN (desktop window)`；永不抛异常 | 用例小修正：未知前缀在 **zod schema 层被拒**（regex ^@pN|^@wN），到不了 dispatcher 的 channel_unavailable 分支——结构化拒绝强于运行时分支，预期实质达成，判 pass |
| T-ENTRY-04 | pass | 时间线实证（t-entry-04-stderr.log）：desktop doctor→rust_proc_spawned pid=38805；随后 disable desktop.cgEvent/ax/appleScript/screenshotVlm 四档（18:20:24.707–.713）**均无 shutdown 事件（helper 存活）**；.714 disable "desktop" channel→.715 `subproc_shutdown_one name=rust-helper`→SIGTERM 退出 | 用例措辞修正：源码（index.ts onChange）中 provider 级 disable 永不 kill helper；kill 触发条件=**disable desktop channel 且四档 provider 全 down**。清单「disable 全部 4 档才 kill」字面与源码不符——产品行为符合 R-RT-2 共享守护设计意图，判 pass，建议修订清单表述 |
| T-ENTRY-05 | pass | breaker_status 含 13 条 kind=long，均带 window_failure_count:0 + opened_at（admin2.jsonl） | — |
| U-01-2 | pass | MCP doctor：lasso_version=1.7.0、ready:false（语义可读，blockers 为 fail 级 2 项）、checks 33+ 项；key 缺失项 fail/warn 不崩溃，正常返报告；runtime_state 含 capabilities/caller_caps/tool_manager/metrics/breakers/serp_health/profiles 七段 | — |
| U-01-3 | pass | CLI `node dist/index.js doctor`（仓库根）：同构报告；#36 detected pass ✓；exit code 1（ready=false）语义正确；CLI 模式 desktop 六项 warn-skip 属设计（desktopChecks=false），未误判 | — |
| U-01-5 | pass | admin tool_list：total_tools=14 == tools/list 14 ✓，channel→tools 映射完整 | — |
| U-07-1 | pass | `LASSO_CONFIG_PATH=/tmp/lasso-t/config.json … config init`→"Created config template"；文件含 ZHIPU_API_KEY/BRAVE_API_KEYS/BING_API_KEYS/LASSO_ALLOW_CLOUD_BROWSER/LASSO_CDP_PORT 等全部占位（实测 15 key，含 LASSO_COOKIE_PASSPHRASE） | — |
| U-07-2 | pass | 重跑→"Config file already exists (not overwritten)"；前后 md5 相同（7ef6fed4…） | — |
| U-07-3 | pass | config path→`/tmp/lasso-t/config.json (exists)` exit 0 | — |
| U-07-4 | pass | 文件写 `{"ZHIPU_API_KEY":"x"}`→doctor zhipu_api_key 从 fail「未设置」转 **pass「已配置（有效性未深测）」**；config_file detail「存在；加载 1 个 key」 | — |
| U-07-5 | pass | 用 endpoint 做可观测差分：文件配 `https://bogus.invalid.example`→zhipu_endpoint_reachable **fail**（fetch failed）；同文件+env `ZHIPU_ENDPOINT=https://open.bigmodel.cn`→**pass**（HTTP 200）——env 覆盖文件实证 | — |
| U-07-6 | pass | 坏 JSON `{broken json!!!`→doctor 不崩、33 checks 正常输出；stderr `warn config_file_parse_error SyntaxError…`；config_file check 本身 pass「加载 0 个 key」 | 「warn」落点是结构化日志而非 check 状态（check 仍 pass/0 key）——不崩要求满足，判 pass 并记录落点差异 |
| U-08-1 | pass | fetch_url 192.168.1.1→didnt `ssrf_blocked:private_ip`（同 T-SSRF-01） | — |
| U-08-2 | pass | fetch_url 127.0.0.1:9222→放行（到达 HTTP 层 http_404，非 ssrf_blocked）——D10 设计行为命中 | — |
| U-08-3 | **fail** | `browse_headless {url:"https://httpbin.org/status/404", action:"navigate"}`→**outcome=worked**（method=chrome_devtools_mcp，无 error），非预期 didnt | **用例对，产品行为不符**。源码 BrowseChannel.ts:795-805 注释明确「404/403→didnt」，classifier 也写了 `m.includes("404")→didnt`，但该分支依赖上游工具报错文本；chrome-devtools-mcp 的 navigate_page 对 HTTP 404 页面正常成功（404 有响应体，导航本身成功），从不产生含 "404" 的错误消息 → browse 路径 404 检测实际不可达。属产品级检测缺口（或至少源码注释/清单承诺与实际不符），非用例写错 |
| U-08-4 | pass | fetch_url httpbin 500→outcome=**unknown** error=http_500（5xx 可 fallback 语义） | — |
| U-08-5 | pass | 全源失败构造（env -i + PATH=/usr/bin:/bin 断 npx + LASSO_MACHINE_CLAUDE_JSON_PATH=/nonexistent.json + 全新 query 防缓存）：outcome=didnt、retrieval_method=**fallback_exhausted**、error=all_channels_failed_or_skipped；actions_and_results=[zhipu unknown "ZHIPU_API_KEY missing", browse_headless unknown "spawn npx ENOENT"]；spawn 退避 2s/4s/8s/16s 共 5 次尝试后放弃（subproc_spawn_retry 日志实录）。注：期望的 partial_failures 数组形态在本路径为 actions_and_results（channel+error 等价） | — |
| U-08-6 | pass | breaker_status configured:true + breakers 数组（kind short/long，见 T-FALL-02/03） | — |
| U-08-7 | pass | `search {query:"测试",free_only:"L1"}`（auto 与 fallback_chain 两种 engine 均）→didnt + retrieval_method=free_only_filtered 空结果 ✓ | 用例括注修正：「machine_mcp 属 L1 不滤」与实现不符——search.ts:219-251 的 free_only 全排除**早返回**发生在 fallback_chain 分支（machine_mcp 注入处）之前，L1 永远到不了 machine_mcp；且 machine_mcp 仅 fallback_chain 路径注入（engine=auto 不含）。与 search.ts:146-147 注释（machine_mcp 不参与 free_only 剔除）自相矛盾——主断言 pass，括注预期与源码相反，建议修清单+理顺源码注释 |
| U-10-1 | pass | 见 T-OBS-01（search.zhipu total=4 / browse_headless total=4 success_rate=1 + p50/p95） | — |
| U-10-2 | pass | disable→ok:true + tools/list_changed 通知×1 + 工具消失（14→13）；enable→恢复（13→14）+ 通知×1 | — |
| U-10-3 | pass | provider_add 传 keys:["k"]→ok:true keys_from_env:false（字面量 key 被剔除忽略，仅 env 读） | — |
| U-10-4 | pass | capability_disable 缺 reason→ok:false `field required: reason` | — |
| U-10-5 | pass | serp_health：engines[] 含 hit_rate=1（冷启动）、redesign_suspected=false | — |

## 统计

- **pass: 47 / fail: 2 / blocked: 1 / waived(随附): 1**（T-STEEL-06 第三态「全配+容器健康检查」需 Steel Docker 容器，随条目标注 waived；T-SEARCH-15 场景①② blocked）
- fail 项：**T-RT-06**（caller-tier 配额 tryAcquire 零调用点，完全未接线）、**U-08-3**（browse 路径 404 检测不可达，navigate 404 返 worked）
- 随附观察（不改 verdict）：
  1. SERP baidu 兜底在本机对所有 query 返 count=0 的 worked（T-SEARCH-14 属他面板，此处仅记录）
  2. search.zhipu 无 key 仍进链并累计失败致短熔断 open（行为可解释但值得复核）
  3. 会话结束后系统内仍存在多条 chrome-devtools-mcp 相关进程（pgrep 73 条，含其他并行面板/历史残留——T-BROWSE-24 属他面板，未处置以免干扰并行执行）
  4. fetch_url envelope 的 continue_hint 指向 read_text（D1：工具未注册，缺陷证据再采集）
