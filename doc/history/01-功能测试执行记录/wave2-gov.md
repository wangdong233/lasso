# Wave2 重测记录 — 治理面板（gov）fail 重测 + 全域抽样回归

- **执行日**：2026-08-15（stderr 日志时间戳 2026-08-14T20:2x UTC）
- **被测版本**：lasso-mcp **v1.8.0**（`npm run build` 含 chmod +x；server stderr `lasso_start version=1.8.0` 实证；`tool_manager_size=15`）
- **环境**：macOS Darwin 21.6.0 / Node v24.12.0 / TUN fake-ip 代理（本机对 example.com/httpbin 有间歇 `ERR_CONNECTION_CLOSED` 干扰，见观察 O3）
- **方法**：复用 `mcp.mjs`（单发）+ 本波次新建同会话脚本 `wave2-rt06.mjs` / `wave2-tools*.mjs` / `wave2-readtext.mjs` / `wave2-search.mjs` / `wave2-misc*.mjs`（SDK Client + StdioClientTransport 直连 `node dist/index.js`，支持 `_meta` 透传——T-RT-06 需要）
- **裁决口径**：同 wave1（ID / verdict / 实际观察 / 用例判定）；先对照 v1.8 修复记录的新预期再判。

---

## 1. 结果总计

| 类别 | 条目 | pass | fail | blocked | waived |
|---|---|---|---|---|---|
| gov fail 重测（wave1 §2.3 两条） | 2 | 2 | 0 | 0 | 0 |
| 抽样回归（含 U-07 六子条） | 18 | 18 | 0 | 0 | 0 |
| **合计** | **20** | **20** | **0** | **0** | **0** |

附加范围探针 1 条（T-RT-06 scope 边界，见观察 O1，不计数）。

---

## 2. fail 重测（wave1 §2.3）

### T-RT-06 — CallerTierTracker 配额接线（W1-DEF-10 修复验证）

- **verdict**: **pass**（wave1 fail → v1.8 修复生效）
- **v1.8 预期**：search/browse_headless/browse_logged_in 三 handler 入口 tryAcquire（`_meta.callerId` fallback anonymous）；超额 tri-state didnt + `caller_cap_exceeded`。
- **实际观察**（单会话，`wave2-rt06.mjs`）：
  1. `admin caller_cap_set {callerId:"t", cap:5}` → ok:true。
  2. 6 次 `search`（带 `_meta.callerId:"t"`）：#1-#5 全部放行（worked，served_by=browse_headless/serp_scrape_baidu）；**#6 → `outcome:"didnt", served_by:"lasso.caller_tier", retrieval_method:"caller_cap_exceeded", error:"caller_cap_exceeded:t used=5 cap=5 (60s sliding window)"`**。
  3. `caller_cap_list` → `[{callerId:"t", used:5, cap:5, windowMs:60000}]`（计数真实，wave1 恒 0 的问题消失）。
  4. `cap_set t=0` 后再调 → 立即 didnt `caller_cap_exceeded:t used=5 cap=0`（cap=0 封禁生效）。
  5. 不带 `_meta` 的调用走 anonymous：正常 worked，`cap_list` 显示 `anonymous used=1 cap=100`（与 t 隔离；DEFAULT_CALLER_CAP=100 实证）。
- **范围探针**（附加）：`cap_set anonymous=2` 后 3 次 `fetch_url` 无一被拒且不计数（cap_list used 仅含 2 次 search）——**fetch_url 不在 gate 范围**，与修复记录声明的三 handler 范围一致（见观察 O1）。
- **用例判定**：用例对。注意 wave1 形态（用 fetch_url 连调）在 v1.8 语义下测不到 gate——重测必须换成 search/browse 工具，清单再版时把「连调 6 次」的工具指定为 search（或 browse_headless）。

### U-08-3 — browse_headless navigate 404 → didnt（W1-DEF-5 + W1-DEF-1b 修复验证）

- **verdict**: **pass**（wave1 fail → v1.8 修复生效）
- **v1.8 预期**：navigate 后 NAV_ERROR_SIGNATURES + HTTP responseStatus（performance API）双校验，404 命中 throw `http_404` → didnt。注意修复记录明示：本机 httpbin.org 被代理拦成中文错误页（坏测试目标），改用 `example.com/404`。
- **实际观察**：
  - `browse_headless {url:"https://example.com/404", action:"navigate"}` → **`outcome:"didnt", error:"Error: http_404:client_error"`**，actions_and_results 同步 didnt。（对照组）`https://example.com` → worked，final_url=`https://example.com/`（校验 best-effort 不误伤正常页）。
  - **NXDOMAIN 侧**（W1-DEF-5 另一分支）：`https://nonexistent-lasso-test-9x7q.invalid` → **didnt `dns_or_nav_error:net::ERR_CONNECTION_CLOSED at …`**——签名匹配生效（TUN fake-ip 使错误码呈 CONNECTION_CLOSED 而非 NAME_NOT_RESOLVED，签名族仍命中）。
- **用例判定**：用例对；清单再版把用例 URL 从 httpbin.org/status/404 改为 example.com/404（本机代理环境下 httpbin 是坏目标，修复记录已预告）。

---

## 3. 抽样回归（wave1 pass 项防修复引入回归）

### T-SSRF-01 — ssrfGuard 五场景
- **verdict**: **pass**
- 实测（单会话 mcp-batch）：`192.168.1.1`→didnt `ssrf_blocked:private_ip:192.168.1.1`；`10.0.0.1`→didnt private_ip；`evil.com@trusted.com`→didnt `userinfo_present`；`ftp://x/`→didnt `protocol_not_allowed:ftp:`；`127.0.0.1:9222/json/version`→**放行到达 HTTP 层**（error=http_404，body_kind=html，非 ssrf_blocked）——与 wave1 逐字一致，D10 设计行为维持，无回归。

### T-TOOLS-08 — fetch_url 四场景
- **verdict**: **pass**
- ① `example.com`→worked，body_kind=html，body_bytes=559；② `httpbin.org/redirect/2`→didnt + `redirect_not_followed` + body_kind=redirect + location=/relative-redirect/1；③ markdown 模式（**正确形态 `options:{extract_mode:"markdown"}`**——extract_mode/max_bytes 是 `options` 嵌套键，首测误传顶层被 zod strip 返 html，是我方调用形态错非产品）→worked `body_kind="markdown:defuddle+turndown"`，preview 为正文 markdown；④ wikipedia/China markdown 档（1937251B 源页）→worked，envelope `truncated:true ref=@o1 total_bytes=133309`，落盘 `$TMPDIR/lasso-output/@o1.txt`（mode 100600，非 /tmp）。
- 用例判定：用例对；四场景与 wave1 全一致，无回归。

### T-SEARCH-11 — free_only 分级
- **verdict**: **pass**
- L1→didnt `free_only=L1 excluded all search providers`（retrieval_method=free_only_filtered）；L4→worked；省略→worked 且命中 L4 侧缓存（cached:true，默认未过滤得证）——与 wave1 一致。

### T-SEARCH-12 — 搜索缓存
- **verdict**: **pass**
- 同参第二次 cached:true；`no_cache:true` 重搜（cached 消失）；limit 3→5 不误命中；engine 改 zhipu 不误命中（本机无 key 落 serp_scrape_baidu）——与 wave1 一致。

### T-SEARCH-29 — zod 边界
- **verdict**: **pass**
- `query:""`→MCP -32602 `too_small minimum:1`；`limit:51`→`too_big maximum:50`；均结构化拒绝未触发真实搜索——与 wave1 一致。

### T-CLI-01 — doctor CLI 全量
- **verdict**: **pass**
- `node dist/index.js doctor`：lasso_version=**1.8.0**、ready:false、**checks=33**（pass 24/fail 2/warn 7，desktop 六项缺席属设计——wave1 判定维持）、blockers=[zhipu_api_key, cdp_9222_logged_in]（环境性）、exit 1 语义正确。MCP doctor 模式 39 项在 T-TOOLS-14 侧证。变化点：`stealth_profile_self_check` 现 pass（wave1 v1.7 为 warn 语境）——v1.8 stealth 修复的正向副产物，非回归。

### T-CLI-03 — replay-baseline
- **verdict**: **pass**
- `replay-baseline` → `{"total":6,"pass":6,"warn":0,"fail":0}`，exit 0；doctor #26 `recording_baseline_count: pass "6 条 fixture（baidu=2 bing=2 google=2…）"` 对齐——与 wave1 一致。

### U-07-1..6 — config 全套（6 子条全 pass）
| 子条 | 实际观察 |
|---|---|
| U-07-1 init | `Created config template at: /tmp/lasso-w2t/config.json`，exit 0；模板 15 key + _comment（ZHIPU_API_KEY/BRAVE/BING/LASSO_ALLOW_CLOUD_BROWSER/BROWSERBASE/STAGEHAND/LASSO_COOKIE_PASSPHRASE/ZHIPU_ENDPOINT/LASSO_CDP_PORT/LASSO_CACHE_DIR/LASSO_SEARCH_FREE_ONLY/LASSO_VLM_ENDPOINT/LASSO_RECORD_SEARCH/LASSO_CALLER_CAP_DEFAULT/LASSO_PROVIDERS_FILE） |
| U-07-2 再 init | `Config file already exists (not overwritten)`，文件未改写 |
| U-07-3 path | `/tmp/lasso-w2t/config.json (exists)` |
| U-07-4 file key | doctor `zhipu_api_key: pass 已配置（有效性未深测）`；`config_file: pass …加载 15 个 key`；key 明文全文零泄漏 |
| U-07-5 env 覆盖 | file LASSO_CDP_PORT=9225 → server 启动 `cdp_port:9225`；叠 env 9226 → `cdp_port:9226`（真实 server stderr 证实） |
| U-07-6 坏 JSON | doctor 正常输出 33 项不崩（config_file pass「加载 0 个 key」）；stderr 落 `config_file_parse_error` warn |

### T-RT-05 — 观测三件套
- **verdict**: **pass**
- metrics_snapshot / breaker_status / serp_health 三 action 不传 reason 均 ok:true 且带数据（metrics 含 per-channel success_rate/p50；breaker **short=11 + long=12** 两类齐全；serp_health 含 engines[].hit_rate/redesign_suspected）——与 wave1 一致。

### T-FOREST-02 — 前缀路由
- **verdict**: **pass**
- 同会话先 `browse_headless navigate example.com`（mint @p0）→ `interact_roots` 列出 @p0(browse_headless)/@p1(browse_logged_in)/@w1(window, source=desktop)；`@p0 observe snapshot`→worked（preview 为 a11y 快照 `RootWebArea "Example Domain"`）；`@w1 observe`→worked **served_by=desktop.ax**（@w→desktop 路由实证）；`@p99 act`→didnt `unknown_root:@p99`（stale 分支）；`@x0`→zod -32602 `root_ref must be @pN (browse page) or @wN (desktop window)`（regex `^@[pw]\d+$` 层拒绝）；全程无未捕获异常——与 wave1 一致。
- 用例判定注：observe 需带 `action:"snapshot"`（schema 无 default），首测漏参被 zod 拒是我方调用形态错非产品。

### U-01-4 — 机器 MCP 搜索（wave1 未实测，本波次首测）
- **verdict**: **pass**
- `search {query:"lasso mcp 是什么", limit:5, engine:"fallback_chain"}` → outcome=worked、served_by=browse_headless；审计链完整：`search.machine_mcp(unknown) → search.zhipu(unknown, ZHIPU_API_KEY missing) → browse_headless(worked)`——machine_mcp 首位注入 ✓（doctor #36 detected 的运行时佐证），未命中后按预期降级 zhipu→SERP；actions_and_results 完整 ✓。
- 观察见 O2。

### T-TOOLS-14 — doctor MCP 工具（runtime_state）
- **verdict**: **pass**
- MCP `doctor {}`：**checks=39**（desktop 六项全在场）；runtime_state 七键齐：capabilities / caller_caps / tool_manager / metrics / breakers / serp_health / profiles；caller_caps 实时反映调用（本会话 anonymous used=1 cap=100）；breakers 23 条；profiles 仅 stat 元数据（name/isCurrent/userDataDir/userDataDirExists/userDataDirMode/encryptedPackage），全文无 cookie 字段——与 wave1 一致。

### read_text 新工具实测（D1 修复验证，替代 wave1 的 T-TOOLS-13 缺席采证）
- **verdict**: **pass**（wave1 时为缺陷证据采集项）
- **实际观察**（单会话 `wave2-readtext.mjs`）：
  1. `tools/list` **含 read_text**（15 工具；启动日志 `tool_manager_size=15`），D1「已定义未装配」修复实证。
  2. 造 spill：`fetch_url {url:"https://en.wikipedia.org/wiki/China", options:{extract_mode:"markdown"}}` → envelope `truncated:true, ref:@o1, total_bytes:133309`，continue_hint=`read_text({ref:"@o1", offset:16384})`；落盘 `$TMPDIR/lasso-output/@o1.txt` size=133309 **mode=100600**（与 fs.stat 完全一致）。
  3. `read_text {ref:"@o1"}` → `{text_head:"**China**,[8](#fn:8) officially the **People's Republic of C…", text_len:16342, eof:false, total_bytes:133309}`。
  4. `{ref, offset:100000}` → 16104 字节续页，内容与 10 万偏移处衔接（"nstructeurs d'Automobiles…"）。
  5. `{ref, offset:130000}` → 3233 字节 eof:true（尾页）；`offset:200000` 超 EOF → 空文本 eof:true（优雅）。
  6. 坏 ref `@o999` → 结构化 payload `{text:"", eof:true, total_bytes:0, error:"Error: unknown ref: @o999"}`，无未捕获异常。
- **用例判定**：用例对；6 处 description 指向（wave1 T-TOOLS-13 采集）在 v1.8 全部落到真工具。

---

## 4. 观察项（不扣分，供清单再版/后续波次）

- **O1（caller cap 范围）**：gate 仅接 search / browse_headless / browse_logged_in 三 handler；fetch_url / read_text / wayback 等不计数不拦截（实测 anonymous cap=2 时 3 次 fetch_url 全放行且 used 不增）。与修复记录声明范围一致，判设计范围非缺陷；但 wave1 T-RT-06 用 fetch_url 探测的形态已失效，**清单再版必须把该用例的连调工具改为 search**。是否应把 fetch_url 纳入 caller-tier 管控，留给产品决策。
- **O2（machine_mcp 可观测性薄）**：fallback_chain 审计链中 `search.machine_mcp` 条目仅 `outcome:"unknown"` 无 error/detail 字段——为何未命中（上游 5xx？空结果？超时？）外部不可判。建议链项补 error 摘要。
- **O3（TUN 瞬态网络）**：本波次两次 `ERR_CONNECTION_CLOSED` 瞬态：browse_headless navigate example.com 一次 didnt（重试即 worked）、fetch_url example.com 连续 3 次 unknown。均为本机 TUN fake-ip 出口抖动（环境），非产品回归；navigate 场景恰好实证 W1-DEF-5 的签名校验对真实网络错误正确分类（didnt `dns_or_nav_error:net::ERR_CONNECTION_CLOSED`）。
- **O4（用例形态备忘）**：fetch_url 的 extract_mode/max_bytes 是 `options` 嵌套键（首测顶层透传被 zod strip 静默按 raw 处理——strip 无告警是 MCP zod 默认行为，记录在案防止后续误判「markdown 模式失效」）；interact_observe 的 action 无 default 必须显式传。
- **O5（U-01-4 定位更正）**：U-01-4 在 wave1 未执行（仅探测 #36），本波次为首测基线，非「回归」。

---

## 5. 执行物清单（本目录）

- 脚本：`wave2-rt06.mjs`（T-RT-06 主测）、`wave2-rt06b.mjs`（范围探针）、`wave2-tools.mjs`/`wave2-tools2.mjs`/`wave2-tools3.mjs`/`wave2-tools4.mjs`（T-TOOLS-08 迭代）、`wave2-readtext.mjs`（read_text 分页）、`wave2-search.mjs`/`wave2-zod.mjs`（T-SEARCH 组）、`wave2-misc.mjs`/`wave2-misc2.mjs`/`wave2-misc3.mjs`（T-RT-05/T-FOREST-02/U-01-4/T-TOOLS-14）
- stderr：`wave2-rt06-stderr.log` / `wave2-tools-stderr.log` / `wave2-search-stderr.log` / `wave2-misc-stderr.log`
- 临时物：`/tmp/wave2-doctor-cli.json`、`/tmp/w2d*.json`（doctor 输出）、`/tmp/lasso-w2t/`（U-07 config）、spill `$TMPDIR/lasso-output/@o1.txt`
