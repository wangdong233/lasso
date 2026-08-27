# ft-round1 搜索域执行记录（R11，2026-08-18）

> **范围**：T-SEARCH 全组（35 条）+ T-QUALITY（5）+ T-CB（10）+ T-LOCAL（12）+ T-FEED（8）+ T-SERPHTTP（10）+ key 缺失面（T-CLI-08 Brave 假 key 422）。执行纪律沿用 doc/17 §0.2 全部 7 条：失败先判用例；串行执行 + 场景间 ≥2s 间隔；浏览器/子进程场景资源三采样；面板收尾清残留；每条 verdict 附关键输出。
> **执行器**：`doc/17-执行记录/ft1-run.mjs`（同会话批量 MCP 客户端，含 wall-clock 计时 / 自定义 env 注入 / lasso 特征进程树采样 / stderr 留证）。证据文件：`ft1-s*.jsonl`（每 call 一行 JSON）+ `ft1-s*-stderr.log`（server 结构化日志）。单测面证据：vitest 定向跑输出。
> **环境事实**：machine_mcp 命中（~/.claude.json web-search-prime → open.bigmodel.cn）；无 BRAVE/BROWSERBASE/STAGEHAND key；ClashX TUN 代理出口（ddg/brave SERP 今日被挡——见 T-SERPHTTP-01）；Chrome 运行中（Profile 1）；Node 24.12.0；本机 Chrome 仅 Profile 1。

---

## 0. 门禁基线（只增不减核验）

| 步骤 | 结果 | 关键输出 |
|---|---|---|
| `npm run build` | ✅ | tsc 零错误 |
| `npm test`（第 1 次） | ⚠️→✅ | 首跑 **9 failed** / 2217 passed（1 skipped），失败样例 `test/unit/expect-poll.spec.ts:276 expect(elapsed).toBeLessThan(80)` —— F-T1 类时序敏感 spec 在后台并行跑门禁时 CPU 争用超窗。**判定：用例侧时序 flake 非产品缺陷**（该桶 v1.8 F-T1 已知类）。串行复跑（不并行任何任务）：**Test Files 134 passed (134) / Tests 2226 passed + 1 skipped (2227)** 全绿 |
| `npm run check-invariants` | ✅ | **All 81 invariants passed**（含 INV-80 zhipu 墓碑 / INV-81 search_local 隐私红线，逐条 PASS 输出在档） |

门禁结论：基线保持（2227 + 81 INV）。首跑 flake 记录在案，建议后续轮门禁串行执行。

---

## 1. T-SEARCH 全组（35 条）

### 1.1 真机执行（ft1-s1 / s1b / s2 / s2b / s6 / s7 / s9 / s10）

| ID | verdict | 关键输出（摘自 ft1-s*.jsonl） |
|---|---|---|
| T-SEARCH-01 | **pass** | s1a `search{query:"claude code mcp tutorial ft1a",limit:10}` → `outcome=worked served_by=search.machine_mcp quality=api` count=10，2367ms；engine=machine_mcp region=cn；无 brave key 时单源（served_by 不含 search.brave）✓ |
| T-SEARCH-02 | waived | zhipu 退役（v1.17 A3；s1z3 zod 拒实证，见 U-15-4） |
| T-SEARCH-03 | **pass** | ft1-s1-stderr.log 首行：`machine_search_mcp_detected","detected":true,"channel":"search.machine_mcp"` —— detected:true 且日志无 url/auth 值；doctor #36 `pass "已检测到机器 web-search-prime MCP（host=open.bigmodel.cn；Authorization 已配置…）"`。文件损坏不抛：单测 machine-mcp-detector.spec.ts（34 测全绿） |
| T-SEARCH-04 | **pass** | s1c engine=fallback_chain → `actions_and_results=[{ch:"search.machine_mcp",o:"worked"}]` 链首位 machine_mcp ✓（v1.17 后失败落 brave/serp_http，链序由 s2a/s6a/s10 佐证） |
| T-SEARCH-05 | ⏸ key缺失 | 零 key 剔除侧已证：s1h2 `engine:"brave"` 无 key → 链 `[serp_http:unknown(serp_http_empty) → browse_headless:worked]`，brave 层不出现 ✓；配 key 后行为待 key |
| T-SEARCH-06 | waived | bing 退役（doctor `bing_keys_retired` warn 实证见 T-SEARCH-28 行） |
| T-SEARCH-07 | **pass** | 审计链完整性：s1c（machine_mcp 直命中）/ s2a（`[serp_http:unknown(serp_http_empty), browse_headless:worked]`）/ s10e（`[serp_http:unknown(serp_http_ssrf_blocked), browse_headless:error(circuit_open)]`）三形态；全源熔断诚实 didnt：s10e `outcome=didnt retrieval_method=fallback_exhausted error=all_channels_failed_or_skipped` |
| T-SEARCH-08 | ⏸（brave 半边） | 单测侧：multi-source-fanout.spec.ts「一源 worked + 一源 unknown → 聚合 worked，记 partial_failures」「全源失败 → outcome=unknown + partial_failures 全记」等 20 测全绿 |
| T-SEARCH-09 | ⏸（brave 半边） | 单测侧：「CJK query → machine_mcp 容量 > brave（langBoost 0.7 vs 0.3）」「聚合后按 original_rank 排序 + 截断到 limit」全绿 |
| T-SEARCH-10 | **pass** | s1b3 `attributed:true` → 每条 results[0] keys=`title,url,snippet,served_by,original_rank`；**缓存命中后再 wrap**：s1b4 同参（写缓存后）`cached=true` 12ms 且 attributed 字段仍在 —— attribution 不入 cache key（search.ts:278-296 命中路径重 wrap 代码锚点核对一致） |
| T-SEARCH-11 | **pass** | L1：s1j（machine 在）→ machine_mcp worked（L1 ≤ 任何档位，U-08-7 口径）；L1 无 machine：s2d → `didnt served_by=none ret=free_only_filtered err="free_only=L1 excluded all search providers"`；L4：s1k2 正常 worked；缺省默认 L4（s1a 无 free_only 正常返回）✓ |
| T-SEARCH-12 | **pass** | s1b1 首次（写缓存）1754ms → s1b2 同参 `cached:true` **2ms**（data.cached=true）；s1h `no_cache:true` 强制真搜 2506ms；engine 变体 s1h2 不误命中（cache key 含 engine，search-cache.spec「不同 engine 不互相命中」单测在档）。**注意源码语义**：`no_cache:true` 既不读也不写（search.ts:278 `!noCache` 读门 + :426/:613 `!noCache` 写门）——首轮场景曾因带 no_cache 首调而误判 cache miss，判定为用例设计错误后修正 |
| T-SEARCH-13 | **pass**（单测） | search-fanout-rpm.spec.ts 5 测全绿：「defaultMax=1：第 1 次两源各跑 1 次；第 2 次两源 rpm_limited 跳过（channel.search 不再被调）」「零回归：rpmLimiter 未注入 → 连续两次 fanout 均正常执行」。注：§0.3 D6 行为 v1.7 基线陈旧表（v1.8 记录已标已修） |
| T-SEARCH-14 | **blocked(env)** | s9a（断 API 源 + browse 可用）`query:"Rust 异步编程教程"` → browse_headless worked 但 **count=0**（百度/ddg 验证码页，与 v1.15 在档 L-COST-04「0 条（验证码页）」同象）。机械侧证据：`replay-baseline` 6/6 pass（baidu fixture selector 抽取正确）+ serp-http.spec「baidu 单发：URL wd= + rn=…」。环境（TUN 出口被挡）非产品缺陷 |
| T-SEARCH-15 | **blocked(upstream)** | 快乐路径三次均 `didnt err=http_429`（s1q 641ms / s1b7 627ms / s9c 690ms / s9d 641ms）；裸 curl `https://archive.org/wayback/available` 同样首请 429（间隔 3s 第二请 200）——archive.org 对本出口 IP 限流，产品诚实 didnt 不伪造。**SSRF 侧 pass**：s1r2 `http://192.168.1.1/` → `didnt served_by=lasso.ssr_guard ret=ssrf_blocked` 2ms ✓ |
| T-SEARCH-16 | **pass**（单测+源码） | selectors.ts:47-61 BAIDU_SELECTORS 主备两档四件套（div.c-container/h3/h3 a/div.c-abstract → .result.c-container/.t a/.c-abstract）按序降级；selectorsFor() :106-113；serp-brave/serp-ddg spec 29 测全绿。**drift 注**：用例原文"baidu/google"——google selector 已清理（serp-ddg.spec 头注「GOOGLE_SELECTORS 零导出、selectorsFor("google") 不可达」），现行三引擎 baidu/ddg/brave |
| T-SEARCH-17 | **pass** | s1n admin serp_health：baidu `hit_rate=1, hit=0, miss=0`（零样本乐观默认 ✓）；「不自动重写 selector」单测 serp-health-monitor.spec:207「源文件无 setSelectors/upgradeVersion/rewriteSelector 调用」 |
| T-SEARCH-18 | **pass** | 真机 ddg `hit=0, miss=2, redesign_suspected=false`（样本<5 不告警 ✓）；单测 :144「样本 < 5 不触发 redesign_suspected（冷启动保护）」 |
| T-SEARCH-19 | **pass**（单测） | serp-health-monitor.spec:132「5 次 miss + 命中率 < 0.5 → redesign_suspected=true」+ :224「改版确认后只 logger.warn + recordings.save（不调 registry mutator）」+ :242「detectChange 内部抛错 → onResult 不抛（保守吞错）」 |
| T-SEARCH-20 | **pass** | s1n snapshot：`engines[].{engine,hit_rate,hit,miss,last_known_good,redesign_suspected}` + recent_alerts + recordings_count 结构齐全 |
| T-SEARCH-21 | **pass** | `LASSO_RECORD_SEARCH=true` → fixture 落盘 `~/.cache/lasso/search-recordings/41/4104b4…html`（3366B，含 10 条蓝链快照）；默认 OFF：S1-S6 各场景 recordings_count=0（serp_health 字段）+ 无录制日志（INV-57） |
| T-SEARCH-22 | **pass** | s7q1（machine 断开 + deny-all + PATH 破坏 npx）：`[serp_http:unknown(serp_http_ssrf_blocked), browse_headless:unknown(spawn npx ENOENT)]` → **replay 命中 `worked served_by=recording_replay quality=stale`** count=10；录制 OFF 仍可回放（该场景录制 env 未设）✓；stderr `fallback_chain_replay_hit","query_len":24` |
| T-SEARCH-23 | ⏸ key缺失 | QuotaLedger 需 BRAVE_API_KEYS 多 key |
| T-SEARCH-24 | **pass** | s1o breaker_status：`configured:true, breakers[].{channel,kind:short,state:closed,failure_count,opened_at}`；serp_http failure_count=1（unknown 后）可见。开态跳过见 T-SERPHTTP-07（s10 真机 open/half-open/circuit_open 全链路） |
| T-SEARCH-25 | **pass** | s1m doctor（41 checks）：`machine_search_mcp:pass`；`brave_keys:warn`（「search 扇出退化为 machine_mcp 单源…」+ next_step，不阻塞 ready 语义）✓；`zhipu_keys_retired:pass`（未配置常态）。ready=false 仅因 cdp_9222 fail（Chrome 未带调试口运行，与本组无关） |
| T-SEARCH-26 | **pass** | 只读无需 reason：s1n/s1o 直接 ok；mutation 缺 reason：s1p2 → `{"ok":false,"error":"field required: reason"}`；provider_add 传 keys：s1b6 → `{"ok":true,"name":"ft1-probe","keys_from_env":false}`（keys 载荷被剔除，keys_from_env=false 诚实标注） |
| T-SEARCH-27 | **pass** | `node dist/index.js replay-baseline` → `{"total":6,"pass":6,"warn":0,"fail":0}`（baidu×2/bing×2/google×2 fixture）；`--strict` exit 0；纯本地零触网 |
| T-SEARCH-28 | **pass** | config init → "Created config template" / 二次 "already exists (not overwritten)"；文件写假 ZHIPU_API_KEY+BING_API_KEYS → doctor：`zhipu_keys_retired:warn「该配置永远不被消费」` + `bing_keys_retired:warn「1 个 BING_API_KEYS 已配置…静默忽略、无功能影响」`；env 同名键等价生效（warn 态一致）；doctor #1 config 永不 fail ✓。搜索零消费：s9a 在 `ZHIPU_API_KEY=fake-zhipu-ft1 ZHIPU_ENDPOINT=https://fake.example.invalid` 下照常 worked（U-15-5） |
| T-SEARCH-29 | **pass** | s1z1 空 query → zod `String must contain at least 1 character(s) at query`；s1z2 limit=51 → `Number must be less than or equal to 50 at limit`；均为结构化 -32602 非真实搜索 ✓ |
| T-SEARCH-30 | **pass**（单测） | machine-mcp-search-channel.spec.ts 34 测全绿，含四形态：「真机现行形态：双重编码裸数组（JSON.stringify 两层）+ refer 键」「单次编码裸数组也接受」「三重以上病态编码：第 3 层起不再剥」「双重编码 + search_results 对象混合形态」（:463/:487/:500/:508） |
| T-SEARCH-31 | ③ **pass**；①② ⏸ | ③ 双无（`LASSO_MACHINE_CLAUDE_JSON_PATH=/nonexistent` 且无 key）：s2a/s2b1 链 `[serp_http:unknown → browse_headless:worked]`（serp_http 注入恒在，browse 免费兜底）——「一家不配也有搜索」保持 ✓；① machine+brave 双源 fanout / ② 仅 brave 需 key（单测 multi-source-fanout 覆盖聚合语义） |
| T-SEARCH-32 | **pass**（双面真机） | machine 在：s1k `free_only:"L2"` → machine_mcp 单源 worked（L1 ≤ 任何档位）✓；machine 断开：s2c 同参 → `didnt ret=free_only_filtered err="free_only=L2 excluded all search providers"`（search.ts free-only 分支诚实空结果）✓ |
| T-SEARCH-33 | **pass**（单测） | search-freshness.spec.ts：「freshness=day：2 天前的缓存 → 过期返 null」「12 小时前 → 仍命中」「week：6 天前 → 仍命中」「month：6 天前 → 仍命中（7 天封顶不变）」+「不传 freshness → key 与基线 byte-identical」全绿（effectiveTtlMs day→24h 语义） |
| T-SEARCH-34 | **pass**（真机双面） | 新鲜 fixture（刚录）：s7q2 freshness=day → 正常回放（worked recording_replay）；`touch -t` 回拨 3 天后：s7s1 → **拒回放** `didnt ret=fallback_exhausted`，stderr `fallback_chain_replay_stale_rejected","freshness":"day","age_ms":259264839,"window_ms":86400000`（3.0d > 24h）；同 fixture 不传 freshness（s7s2）→ 照常回放（门只对 freshness 查询生效）✓ |
| T-SEARCH-35 | **pass**（单测） | multi-source-fanout.spec:237「CJK langBoost 命中 machine_mcp 源名（v1.17 A3 改名回归锁：includes 检测 machine_mcp 非 zhipu）」+ :225「CJK query → machine_mcp 容量 > brave」全绿 |

**T-SEARCH-31③ 补充**：链序权威口径 `machine_mcp → brave → serp_http → browse_headless → recording_replay` 在本面板 5 个场景中分段全见（machine 直命中 s1c / brave 剔除 s1h2 / serp_http→browse s2a / 全熔→replay s7q / 熔断跳过 s10e）。

### 1.2 U-15 质量轴旅程（搜索域相关步）

| step | verdict | 关键输出 |
|---|---|---|
| U-15-1 | **pass** | s1b `no_cache:true` → `served_by="search.machine_mcp" quality:"api"` 1509ms/10 条（另样本 s1b8 1415ms） |
| U-15-2 | **pass** | s2b（machine 断开）→ `served_by="serp_http:baidu" quality:"scrape"`；s2a EN 侧落 browse_headless `quality:"scrape"` |
| U-15-3 | **pass** | s7q1 全链熔断+录制 → `served_by="recording_replay" quality:"stale"`（freshness 门见 T-SEARCH-34） |
| U-15-4 | **pass** | s1z3 `engine:"zhipu"` → zod `Invalid enum value. Expected 'auto' | 'brave' | 'fallback_chain', received 'zhipu' at engine`（合法值列出，诚实破坏） |
| U-15-5 | **pass** | s9a 假 ZHIPU key+endpoint 下搜索照常 worked（键零消费）；doctor `zhipu_keys_retired:warn`「该配置永远不被消费」；未配 → pass（s1m） |
| U-15-6 | **pass** | 即 T-SEARCH-32 双面 |
| U-15-7 | ⏸（brave 半边） | 单测 quality-tag.spec「fanout 聚合串：全同档 → 该档」「混档 → undefined（宁缺毋假）」 |

---

## 2. T-QUALITY（质量轴三态）

| ID | verdict | 关键输出 |
|---|---|---|
| T-QUALITY-01 | **pass**（单测） | quality-tag.spec.ts 13 测全绿：「api 档：search.machine_mcp / search.brave」「scrape 档：browse_headless / browse_logged_in / browse_cloud_*」「serp_http 带引擎后缀变体（serp_http:ddg）——声明式前缀」「stale 档：recording_replay」（零启发式，顶级 const 映射 QualityTag.ts） |
| T-QUALITY-02 | **pass**（三路径真机各一） | api：s1a/s1b（machine_mcp）；scrape：s2b（serp_http:baidu 单源）/ s2a（browse）；stale：s7q1（recording_replay）。三条出口均带 quality ✓。**清单预期修正**：「didnt 路径不带 quality」与实现相反——quality 是**路径轴**：s10e `didnt served_by=browse_headless` 仍带 `quality:"scrape"`；单测「didnt/unknown outcome 也按 served_by 打标（quality 是路径轴不是成功轴）」钉死；仅 served_by=none（如 s2c free_only_filtered）才 undefined。**判定：用例预期文本错误，产品行为正确**（清单 F 项回填建议） |
| T-QUALITY-03 | **pass**（单测） | 「fanout 聚合串：全同档 → 该档（v1.17 A3 后唯一组合是双 api）」「混档 → undefined」「任一段未知 → undefined」 |
| T-QUALITY-04 | **pass**（单测） | 「未知 served_by → undefined（不标；含 v1.17 A3 已删的 search.zhipu——执行序约束）」「防御值：空串 / undefined / 空聚合 → undefined」 |
| T-QUALITY-05 | **pass** | `grep -rn "search\.zhipu" src/ --include="*.ts"` → 6 命中**全部为注释**（index.ts:588/:1001/:1090、tools/search.ts:4/:755、config/providers.ts:24 —— 逐行核验均为 `//` 或 `*` 历史注记/INV-80 墓碑守卫），stripComments 后零命中 ✓ |

---

## 3. T-CB（content_blocks 第二跳，中英各一 + 四态 + 缓存纪律）

执行：ft1-s3（machine 在，蓝链走 machine_mcp；第二跳裸 HTTP）。

| ID | verdict | 关键输出 |
|---|---|---|
| T-CB-01 | **pass** | s3f `content_blocks:0` → zod `Number must be greater than or equal to 1`；`:6` → `less than or equal to 5`；`:2.5` → `Expected integer, received float`（1-5 硬界三态全拒） |
| T-CB-02 | **pass** | 不传 content_blocks：s1a/s3a1 条目字段仅 `title,url,snippet`（零增强字段零新字段，INV-66 缺省关基线）；单测「不传 content_blocks → 条目零增强字段 + 第二跳零 fetch」在档 |
| T-CB-03 | **pass**（四态真机各现） | EN cb=3（s3e）：`[not_html, ok(41208), ok(1458)]`（首条 PDF 直链 → not_html）；EN cb=3 cache 命中（s3a2）：`[fetch_failed, ok(5332), ok(1535)]`；EN cb=5（s3b2）：`[extract_failed, fetch_failed, okT(6184), okT(2484), okT(6101)]`；CN cb=3（s3c2）：`[extract_failed, extract_failed, fetch_failed]`；CN cb=5（s3d）：`[fetch_failed, ok(215), okT(6380), ok(3088), okT(48)]`。**ok / fetch_failed / not_html / extract_failed 四态全部真机出现**；top N 外条目零标注（s3a2 第 4 条起 `-`）✓ |
| T-CB-04 | **pass**（tri-state 红线） | s3c2 三条全失败：主信封 `outcome=worked served_by=search.machine_mcp quality=api` 不变、蓝链字段保留（title/url/snippet 完整）；s3a2 首条 fetch_failed 不拖垮其余（search.ts:647 兜底锚点核对） |
| T-CB-05 | **pass**（单测+真机） | search-content-blocks.spec「先无 content_blocks 入缓存 → cache 文件零 content 字段…」等 9 测全绿（scoreAndTrim 五性质）；真机：okT(6184)/okT(6380) ≈ 6k 预算内（导语 200 + 段落配额），`truncated:true` 出现于长文条目 |
| T-CB-06 | **pass**（单测） | 「contentDeps 未注入 → 传 content_blocks 也被诚实忽略」+ ContentSecondHop 单测护栏（5s AbortController / 256KB 两段式 / ssrfGuard / acquireHttpClient）全绿 |
| T-CB-07 | **pass**（单测） | 并发 3 信号量 + 15s 软预算（CONTENT_HOP_DEFAULTS :104-108 源码锚点核对）spec 在档 |
| T-CB-08 | **pass**（真机+磁盘双证） | s3a2/s3b2/s3c2 均蓝链 `cached:true`（2-12ms 级）**且** content 各次实抓（耗时秒级、内容非缓存时效）；**磁盘侧**：`grep -rl "content_status" ~/.cache/lasso/search-cache/` = 0 文件、`grep -rl '"content":'` = 0 文件（35 个缓存文件零污染）——cache.set 恒在富化前（search.ts:426/:613） |
| T-CB-09 | **pass** | 反爬站 fetch_failed 如实标注（s3a2/s3b2 首条）且**不启浏览器**：ft1-s3-stderr.log `grep -c "subproc\|chrome"` = **0**（整个 content_blocks 面板零子进程痕迹；裸 HTTP 第二跳，重站不升浏览器） |
| T-CB-10 | **pass**（回填） | 见 §4 L-COST-05/06/07 行 |

U-13 旅程同步覆盖：U-13-1（=s3a2 top3 带 content/content_status、第 4/5 无标注）✓；U-13-2（fetch_failed 蓝链保留）✓；U-13-3（not_html）✓；U-13-4（extract_failed）✓；U-13-5（truncated + 6k）✓；U-13-6（缺省 byte-identical）✓；U-13-7（=T-CB-08）✓；U-13-8（快速失败不拖尾：s3c2 全失败总耗时 465ms，单条远低于 5s 硬超时；主结果 worked）✓。

---

## 4. §5 性能基线表回填（L-COST 搜索域行）

> 口径：MCP stdio 真实 dist/index.js server；每场景独立进程；串行 + ≥2s 间隔；涉及浏览器场景附资源三元组（count/RSS KB before→peak→after；after 为 transport 关闭前采样，**关闭后外测 pgrep 为权威释放证据**——执行器采样时序限制已注明）。

| ID | 场景 | 起步实测（在档） | 本轮回填 | 判读 |
|---|---|---|---|---|
| L-COST-01 | 第一跳 machine_mcp | 1824ms/10 条；区间 1.4-4.1s | **1509ms / 1415ms**（s1b/s1b8，各 10 条） | 区间内 ✓ |
| L-COST-02 | 第一跳 serp_http EN | 1908ms/20 条 | **N/A（env）**——ddg 202 + brave 429（裸 curl 证据），serp_http_empty 升级 browse；非产品回归 | 环境变化在档 |
| L-COST-03 | 第一跳 serp_http CN | 1134-2283ms/17 条 | **932ms / 18 条**（s2b） | 快于起步 18%，区间邻域 ✓ |
| L-COST-04 | browse_headless 兜底 | 5304-5856ms/0 条（验证码页） | **7671 / 8012 / 15952 / 17542ms，均 0 条**（s9a/s2a/s6a/s2b1；验证码页 + npx 冷暖差异） | 超起步上限 ~2-3×，判**环境**（TUN 出口今日被挡更重 + 首启 npx 解析）；与起步同象（0 条验证码页），链语义正确。s6a 资源三元组：14→24→23 procs / 1127→1757→1665 MB，关闭后外测 chrome-devtools-mcp=0、lasso-chrome=0 ✓ |
| L-COST-05 | 第二跳增量 EN cb=3 | p50≈+1.4s；区间 +0.7~+2.6s | **+3676ms**（s3a2：蓝链 cache 命中 2-12ms 级 + 富化净耗时 ≈ 总 3678ms；构成 = 1×fetch_failed 快败 + 2×ok(5332/1535 字符)） | 超起步上限 44%（<50% 判读线），记**偏慢样本**：网络 TUN + 单条失败重试；非硬违规，持续观察 |
| L-COST-06 | 第二跳增量 EN cb=5 | ~+900ms（并发 3 摊薄） | **+4513ms**（s3b2：2 失败 + 3 okT 各 ~6k 字符，成功条字符量 ≈ 起步场景 1.5×） | 超 50% 判读线 → **判用例/场景**：起步为 warp 轻文场景，本场景 3×6k 长文 + 2 次失败握手，单位产出对齐（~6k 字符/成功条）；无产品侧回归证据（并发 3 生效：5 条未串行 5×单条耗时） |
| L-COST-07 | 第二跳增量 CN cb=3 | ~+3-5s | **+463ms**（s3c2 全失败快败）/ **+3900ms**（s3d 混合 4ok+1fail，含首跳共 5461ms） | 两样本均落入合理域；全失败路径快速失败优于起步口径 ✓ |
| L-COST-08 | fetch_feed GitHub atom | 2025ms/5 条 | **1878ms / 10 条**（s5a，首条 v2.1.234 published 2026-08-17，summary 截断帽生效） | ✓ |
| L-COST-09 | fetch_feed 73KB 抢救 | 758ms + truncated_input | **364ms + truncated_input:true**，头字段抢救出最新 1 条（408 期 2026-08-13） | ✓ |
| L-COST-10 | search_local history | 64ms/5 条 | **131ms / 24ms / 20ms**（s4a/s4b/s4i，各 5 条） | 同数量级 ✓ |
| L-COST-11 | search_local files | 571ms/5 条 | **712ms / 650ms**（s4c/s4f，mdfind） | ✓ |

---

## 5. T-LOCAL（本地私有搜索 + 隐私红线）

执行：ft1-s4（Chrome 运行中——WAL 真实工况）。

| ID | verdict | 关键输出 |
|---|---|---|
| T-LOCAL-01 | **pass** | s4a `query:"lasso"` → 5 条，`visited_at="2026-08-18T10:27:22.626Z"`（ISO，与 Chrome 内该页当日访问吻合；1601 纪元换算正确）；结果按新→旧排序 ✓ |
| T-LOCAL-02 | **pass** | 查询期间 Chrome RUNNING（pid 2420 持有 History 文件句柄 lsof 在档）；查询成功返回 + 源库零锁零写（见 T-LOCAL-10）；copyFile→mkdtemp 只读打开路径（chrome-history.ts）+ 单测「临时目录生命周期：查完 finally 删除」 |
| T-LOCAL-03 | **pass**（单 profile 注） | 定向 s4b `profiles_searched:["Profile 1"]`；缺省 s4a 同为 `["Profile 1"]`（本机仅 Profile 1，按清单本机事实注不判 fail）；合并排序/截断语义单测「多 profile 合并：两库命中按 visited_at 降序、profiles_searched 双库齐」「limit 截断：5 命中 limit=2 → 只留最新 2 条」全绿 |
| T-LOCAL-04 | **pass** | 命中对象 keys 精确 = `profile,title,url,visited_at,snippet`——无 content 全文字段、不 join visits 明细（INV-81(b)）✓ |
| T-LOCAL-05 | **pass** | s4c `source:"files"` → 5 条，字段仅 `path,modified_at`（stat 元数据）；ret=spotlight_mdfind；非 darwin 降级单测「非 darwin → didnt + mdfind_darwin_only」 |
| T-LOCAL-06 | **pass** | s4d `source:"notes"` → `didnt ret=notes_deferred_v2 err=notes_deferred_v2`（3ms，诚实推迟不伪装空结果）✓ |
| T-LOCAL-07 | **pass** | s4g limit=51 → zod `less than or equal to 50`；s4h limit=0 → `greater than or equal to 1` |
| T-LOCAL-08 | **pass** | `grep -nE "ssrf-guard|acquireHttpClient|fetch\(" src/search-local/*.ts` → **零命中**（模块零网络，INV-81(d) 三禁机械成立） |
| T-LOCAL-09 | **pass** | ft1-s4-stderr.log：仅 `search_local_query","source":"history","query_len":5,"limit":5` 等 4 条；**查询原文零泄漏**（`grep -c "lasso mcp\|架构\|zzqqxxylrt9182"` = 0） |
| T-LOCAL-10 | **pass** | History 文件 stat 前后一致：`mtime=1787052160 size=11501568`（before）= after（同一值，零写）✓ |
| T-LOCAL-11 | **pass**（单测） | 「无 Chrome 目录 → didnt + chrome_history_not_found」「非 darwin → chrome_history_darwin_only」「node:sqlite 不可用 → node_sqlite_unavailable」「损坏库诚实跳过」「全库损坏 → all_profiles_unreadable」全绿 |
| T-LOCAL-12 | **pass** | s4e（history）/s4f（files）零命中随机串 → 均 `didnt err=no_matches`；s4e `profiles_searched:["Profile 1"]` 保留（供 CC 分辨「查过哪些库」）✓ |

U-12 旅程 8 步同步覆盖：U-12-1（=s4a）✓ U-12-2（=s4b）✓ U-12-3（=s4c）✓ U-12-4（=s4d）✓ U-12-5（=s4g）✓ U-12-6（=T-LOCAL-02）✓ U-12-7（=T-LOCAL-09）✓ U-12-8（=T-LOCAL-10）✓。

---

## 6. T-FEED（fetch_feed）

执行：ft1-s5。

| ID | verdict | 关键输出 |
|---|---|---|
| T-FEED-01 | **pass**（单测） | fetch-feed.spec「解析 channel 元数据 + item 条目（CDATA / 实体解码）」「limit 截断」全绿 |
| T-FEED-02 | **pass**（真机） | s5a GitHub releases.atom → worked，10 条 `{title,url,published,summary}` 结构化（首条 v2.1.234 / 2026-08-17T20:20:58Z）；L-COST-08 1878ms |
| T-FEED-03 | **pass**（单测） | 「解析 items（url / date_published / content_text）」+「application/feed+json → worked + json 解析」 |
| T-FEED-04 | **pass**（真机） | s5d ruanyifeng 73KB 全内容 feed → `truncated_input:true` + 头字段抢救出最新 1 条完整条目（408 期），364ms；截断零半条假条目（单测「body 在第二条 item 中间被切断 → 只出完整条目」） |
| T-FEED-05 | **pass**（边界观察） | 单测 summary ≤500 帽；真机 summary lens = `[501,501,501,141,501,…]`——500 字符窗口 + 1 字符省略号标记（fetch-feed.ts:137 `slice(0,500)+"…"`）。判定：**标记符非内容，非缺陷**；口径建议清单注明（见观察 O-1） |
| T-FEED-06 | **pass**（单测） | 「application/rss+xml → worked + rss 解析」「text/xml → worked」「application/feed+json → worked + json 解析」 |
| T-FEED-07 | **pass**（真机） | s5e `http://192.168.1.1/feed.xml` → `didnt served_by=lasso.ssr_guard ret=ssrf_blocked err=ssrf_blocked:private_ip:192.168.1.1`（3ms；INV-56 家族复用同 ssrfGuard） |
| T-FEED-08 | **pass** | s5b example.com（非 XML）→ `didnt ret=feed_parse err=not_a_feed`；s5c NXDOMAIN → `unknown err="TypeError: fetch failed"`（诚实 unknown 可 fallback 语义）。**口径注**：U-14-6 写「feed_has_no_entries」对应**空 feed 骨架**场景（单测「有 feed 骨架但 0 条 item → 转 didnt feed_has_no_entries」）；HTML 页正确错误码是 `not_a_feed`——用例预期文本需按 fetch-feed.ts:408-414 双分支校正（清单 F 项） |

U-14 相关：U-14-1（=s5a）✓ U-14-2（=s5d）✓ U-14-5（=s5e）✓ U-14-6（=s5b，口径注）。

---

## 7. T-SERPHTTP（裸 HTTP 快探）

| ID | verdict | 关键输出 |
|---|---|---|
| T-SERPHTTP-01 | **blocked(env)** | s2b1（machine 断开，query "rust tokio tutorial" 原文）→ `[serp_http:unknown(serp_http_empty) → browse_headless:worked(0 条)]` 17542ms。**环境取证**：裸 curl `https://html.duckduckgo.com/html/?q=…` → **HTTP 202**（挑战页，0 result 链接）；`https://search.brave.com/search?q=…` → **HTTP 429**（SvelteKit 错误页）。判定：本机 TUN 出口今日被 ddg/brave 双挡（v1.15 在档时 brave 200 直供），非产品回归；serp_http 层诚实 unknown + 升级语义正确（正是 T-SERPHTTP-06 断言的行为）。L-COST-02 本轮 N/A(env) |
| T-SERPHTTP-02 | **pass** | s2b CN → `worked served_by=serp_http:baidu quality=scrape` **18 条** 932ms，链 `[serp_http:worked]` 单跳直达；已知限制 L1（link?url= 跳转壳）与清单口径一致 |
| T-SERPHTTP-03 | **pass**（单测） | 「ddg 202 挑战 → brave 200 有结果 → 返 brave」「ddg 200 空 → 也级联 brave」「brave 也失败 → 原样返 ddg 结果」「baidu 单发…零级联」全绿 |
| T-SERPHTTP-04 | **pass**（单测） | 「stripNonContentBlocks：style/script/noscript 整块删除（含字体 URL）」「dropMarkdownImages：![alt](url) 整体删除」「真机形态 brave HTML：字体 URL / 缩略图 URL 不进结果」 |
| T-SERPHTTP-05 | **pass**（单测） | 「baidu 302 → wappass 域 → unknown serp_http_redirect_blocked」「退回首页壳 → 同」「同 host 同 path 合法重定向 → 不误拦」「Response 无 url 字段 → 跳过检查不炸」 |
| T-SERPHTTP-06 | **pass**（真机） | s6a `LASSO_SSRF_DENY_RANGES=0.0.0.0/0,::/0` + machine 断开 → 链 `[serp_http:unknown(serp_http_ssrf_blocked), browse_headless:worked]` 15952ms——链序与升级语义真机可见（serp_http 过 ssrfGuard 而内部 HeadlessChannel 不经，deny 只挡前者）✓ |
| T-SERPHTTP-07 | **pass**（真机全链路） | s10 三连失败后 breaker_status：`serp_http {kind:short, state:open, failure_count:3, opened_at:…}`；第 4 次（s10e，>60s 后）：`serp_http:unknown(serp_http_ssrf_blocked)`（**half-open probe 放行**→ 失败 → 重开）+ `browse_headless:error(circuit_open)`（其 breaker 仍在 open 窗口内被跳过）；终态 `didnt fallback_exhausted`。open→skip 与 half-open→probe 两语义一次可见 ✓ |
| T-SERPHTTP-08 | **pass**（单测） | 「未注入 byte-identical（注入式装配，集成测试 3 条钉死）」（serp-http.spec 注入性测试组） |
| T-SERPHTTP-09 | **pass**（单测） | brave HTML 档不拼 df 参数（spec「三引擎 serpUrlFor 输出 host ⊆ SERP_HTTP_ALLOWED_HOSTS」组覆盖；ddg 档**有** df=d 契约——「freshness=day → ddg URL 拼 df=d」，两引擎契约区分正确） |
| T-SERPHTTP-10 | **pass**（单测） | 「[title](url) → 确定性归一化」+ SELF_HOST_RE 排除断言；已知缺口 F-6（裸域/页脚 promo escape）按清单记潜伏项 |

---

## 8. key 缺失面（T-CLI-08 Brave 假 key 422）

| 项 | verdict | 关键输出 |
|---|---|---|
| T-CLI-08 ① 默认无 deep | **pass** | `node dist/index.js doctor` → checks 34 项**无 brave_deep_probe**（零网络副作用）；`brave_keys:warn`（未配提示 + 免费兜底链指引） |
| T-CLI-08 ② env 等价 | **pass** | `LASSO_DOCTOR_DEEP=1` → brave_deep_probe 出现，无 key → warn「无事可做」 |
| T-CLI-08 ③ 假 key 真契约 | **pass** | `BRAVE_API_KEYS=BSAfake-… doctor --deep` → `brave_deep_probe:fail「Brave API 422（SUBSCRIPTION_TOKEN_INVALID）：key 无效（凭证被拒）（本探测消耗 1 次额度）」`——**422 按 key 无效桶分类**（doc/21 F-2 误分类已修的现行行为实证）+ 探测消耗额度的诚实披露 |
| T-SEARCH-05/08/09/23、U-15-7、T-SEARCH-31①② | ⏸ key缺失⏸ | 单测侧语义全绿（multi-source-fanout 20 测 / quota 逻辑）；配真 key 后回归 |

---

## 9. 观察项（不改产品，白盒记录）

| # | 观察 | 证据 | 判定 |
|---|---|---|---|
| O-1 | **截断帽边界语义**：snippet ≤200 帽实测最长 **201**（chrome-history.ts:163 `slice(0,200)+"…"`）、fetch_feed summary ≤500 帽实测 **501**（fetch-feed.ts:137 同构）——省略号为标记符非内容 | s4a snippet lens `[50,201,24,33,201]`；s5a summary lens `[501,501,…]` | 非缺陷；建议清单/文档口径注明「≤N 窗口 + 1 字符省略号」或统一改 `slice(0,N-1)+"…"`（两处同构，改则同改——R-CI-08 同决策同步） |
| O-2 | **attribution 字段随缓存写入外溢**：attributed 调用写入的缓存条目携带 served_by/original_rank，后续**非 attributed** 同 key 调用命中后仍返回这些字段（wrap 在 cache.set 之前：search.ts fallback 路径 :405-421 / auto 路径同构） | s1b3（attributed 写）→ s1b5（不带 attributed）`cached:true` 且 firstAttrs 含 `served_by,original_rank` | 语义为「追加准确溯源信息」非错误数据；不违既有 INV/清单预期（T-SEARCH-10 只断言不入 key + 命中重 wrap）。记录为白盒观察，可裁决：cache.set 前剥离或文档化「缓存命中可能附带溯源字段」 |
| O-3 | **第二跳视频页内容降级为裸图片 markdown**：YouTube watch 页 content=`![](url)`（48 字符，truncated:true，status ok） | s3d 第 5 条 | 提取层诚实但内容质量低；ContentSecondHop 未复用 serp 层 dropMarkdownImages。低成本改进候选（非本轮范围） |
| O-4 | **serp_health brave 引擎 miss 不计数**：ddg miss=2 计入，brave 429 级联失败不计（engines 仅 baidu/ddg 两行） | s2f/s2b2 serp_health 输出 | 观测盲点（brave 仅 hit 计数）；改版检测对 brave 引擎零样本保护，无红线影响 |
| O-5 | **fetch_feed NXDOMAIN 错误未归一化**：`error:"TypeError: fetch failed"`（原始异常串，非 code 风格） | s5c | 诚实 unknown + JSON 结构化，CC 可读；风格统一性小项 |
| O-6 | **两套时序 flake 源**：门禁首跑 9 failed（expect-poll 等 timing-sensitive 桶在并行负载下超窗），串行复跑全绿 | §0 门禁记录 | 用例侧；建议门禁串行跑（本轮已如此） |

**清单侧修正建议（F 项，改 doc/17 非改产品）**：
- F-a：T-QUALITY-02 预期「didnt 路径不带 quality」→ 应为「quality 是路径轴：有 served_by 即打标（含 didnt）；仅 served_by=none 不标」（单测 + s10e/s2c 双证）。
- F-b：T-FEED-08/U-14-6 错误码口径：HTML 页 = `not_a_feed`；`feed_has_no_entries` 仅空 feed 骨架场景（fetch-feed.ts:408-414 双分支）。
- F-c：T-SEARCH-16「baidu/google」→ 现行 baidu/ddg/brave 三引擎（google selector 已清理，serp-ddg.spec 钉）。
- F-d：§0.3 D6 行标注陈旧（v1.8 记录已修 rpmOptions 接线，search-fanout-rpm.spec 5 测在档）——建议 §0.3 表加「已修」回填标记防误导。

---

## 10. §6 简单架构对齐判定（搜索域锚点，对照 02_简单架构清单）

> 本节为 R11 搜索域责任锚点判定（全表 38 条由架构面板汇总；此处填我域内可机械化举证的行）。证据均为 L1+（grep 实跑 / 单测 / 真机）。

| 刻度 | 规则 | 判定 | 证据（源码锚点 + L1 证据） |
|---|---|---|---|
| 交织度 | R-INT-01 纯函数性 | ✅ | QualityTag.ts 顶级 const QUALITY_BY_SERVED_BY 纯映射（quality-tag.spec 13 测同输入同输出）；ContentSecondHop.scoreAndTrim 纯函数（content-blocks spec 五性质）；deps 注入范式（fetchImpl/时间源）——machine-mcp/serp-http spec 均 mock 注入。可变状态单一真源：SearchCache（search-cache.spec 键归一/TTL 全绿） |
| 交织度 | R-INT-07 运行时同源耦合 | ✅（搜索域侧） | 每 channel 独立 breaker（s10 真机：serp_http open 而 browse 独立计数独立 open）；SubprocessManager 共享但链语义独立降级（s7q 双 unknown 并存审计链） |
| 交织度 | R-INT-08 外部命名空间静态契约耦合 | ✅ | machine_mcp：~/.claude.json 探测 + web_search_prime 双重编码契约注释**带实抓证据**（MachineMcpSearchChannel.ts:40-46 v1.12 T2-5 实证注记 + spec :463 真机形态回归钉——V-1 教训已闭环）；BRAVE 端点钉死 providers.ts:93；上游参数名就近持有注释（:40）。命名常量 + 文档化契约 + 回归钉三件齐 |
| 模块深度 | R-DEP-03 / R-FF-04 穿堂式=0（🔴） | ✅（搜索域工具面） | tools/wayback.ts 258 行 / fetch-feed.ts 463 行 / search.ts 800+ 行均厚模块（schema+缓存+富化+审计多职责）；admin 只读 action 包装含 audit 语义非原样转发。无「方法体仅原样转发」样本 |
| 模块深度 | R-DEP-05 信息泄漏 | ✅ | 上游 machine_mcp 双重编码/markdown 围栏解析收敛于 MachineMcpSearchChannel.parseMachineMcpContent（四形态单测钉）；wire 层 snake_case 统一（served_by/retrieval_method 40 文件），内部 camelCase 标识符不越 wire（grep 51 处均为内部标识符） |
| 概念完整 | R-CI-01 术语一致性 | ✅ | served_by/retrieval_method/outcome 三轴真机输出全场景一致（本报告全部 jsonl）；同义词组扫描 wire 层零变体 |
| 概念完整 | R-CI-02 横切关注点 | ✅ | ssrfGuard 单一真源跨 fetch_url/fetch_feed/wayback/第二跳（s1r2/s5e/s6a 真机同 reason 格式）；单 fallback 引擎 INV-4/55（check-invariants 81 全 PASS 机械证据）；连接池 acquireHttpClient（INV-32） |
| 概念完整 | R-CI-06 rejected-by-design | ✅ | doc/24 D-NOGO 9 项 + 墓碑体系（INV-80 zhipu / INV-54 bing）doctor 可见退役提示（T-SEARCH-28 真机） |
| 适应度 | R-FF-01 分层方向（🔴） | ✅（搜索域侧） | search_local 纯本地工具不进 channel 层（INV-81 + 零网络 grep 零命中）；replay/freshness 门在 tools/search.ts 单点 |
| 漂移度量 | R-DRIFT-02 上下文地图 | ✅ | 第四通道 search_local 为显式裁决新增（doc/24 decision-B，演进迁移非熵退化——02 §E #11 口径）；zhipu 删除同为显式裁决（INV-80） |

**汇总**：搜索域责任锚点 10/10 ✅，零 ❌（🔴 三条中搜索域相关 R-FF-01/R-DEP-03 均合规）；阈值未校准声明沿 02 §0.3。

---

## 11. 残留清理（§0.2 第 7 条）

| 时点 | chrome-devtools-mcp 计数 | lasso 自起 Chrome（user-data-dir 含 lasso） | 端口 9222-9224 |
|---|---|---|---|
| S6/S9 浏览器面板后 | **0** | **0** | 9222 为用户自起 Chrome（pid 2420，非本面板 spawn，不动）；9223/9224 空 |

- 本面板自 spawn 的全部 server 进程（ft1-s* 各场景）均已随 transport.close 退出；唯一在跑 `node dist/index.js`（pid 83553）经 ppid 归属验证属**并行执行器 ft-r11-e2.mjs**，非本面板资产，不清理。
- 临时产物清理：/tmp/lasso-ft1（config 测试）、/tmp/ft1-*.txt 已删；replay fixture（search-recordings/41/4104b4…）为产品语义内录制资产（7 天语义、键隔离 ft7rq 专查询），保留并已恢复真实 mtime。
- search-cache 新增条目为产品缓存语义（7 天 TTL 自动过期），不手动清除。

---

## 12. 统计

| 组 | 总数 | pass | fail | blocked | waived | ⏸ key缺失 |
|---|---|---|---|---|---|---|
| T-SEARCH | 35 | 27（T-SEARCH-31 记 ③ pass，①② 半边随 §8 ⏸ 不另计） | 0 | 2（T-SEARCH-14 env / T-SEARCH-15 upstream-429） | 2（02/06 退役） | 4（05/08/09/23；另 31①② 见 §8） |
| T-QUALITY | 5 | 5 | 0 | 0 | 0 | 0 |
| T-CB | 10 | 10 | 0 | 0 | 0 | 0 |
| T-LOCAL | 12 | 12 | 0 | 0 | 0 | 0 |
| T-FEED | 8 | 8 | 0 | 0 | 0 | 0 |
| T-SERPHTTP | 10 | 9 | 0 | 1（01 env） | 0 | 0 |
| T-CLI-08（key 面） | 3 子项 | 3 | 0 | 0 | 0 | 0 |
| **合计** | **83 + 门禁** | **74** | **0** | **3** | **2** | **4** |

- **fail：0 条**（无产品缺陷新增）。
- blocked 3 条均有第三方取证（裸 curl 202/429、archive.org 429 直测），非产品行为问题；其中 T-SEARCH-15 的 SSRF 负向分支已 pass。
- 单测面新增证据：定向 12 spec 252 测 + serp-brave/ddg 29 测 + 全量 2227 复跑全绿。
- 清单修正建议 4 条（F-a..F-d）+ 观察项 6 条（O-1..O-6），均为文档/口径/低优先改进，零产品 red-line。
- 02 简单架构搜索域锚点 10/10 ✅。

**结论：R11 搜索域 round1 零 fail；3 blocked（环境/上游）+ 4 key缺失⏸ 留回归条件；建议 round2 复核项 = L-COST-05/06 偏慢样本持续观察 + O-2 attribution 缓存外溢裁决。**
