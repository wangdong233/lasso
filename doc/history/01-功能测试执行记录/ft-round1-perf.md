# ft-round1 R11「性能与架构判定域」执行记录

> **执行员**：R11（性能 + 简单架构判定域）｜**日期**：2026-08-18 19:05-20:05（本机）
> **基线**：lasso-mcp v1.17.0（commit 8112a5e + 并行执行轮工作树改动，见 §5 并行声明）
> **范围**：doc/17 §5 L-COST-01..14 实测回填（每项 3 次取中位）+ §6 简单架构 38 条逐条判定 + T-ELICIT 单测/真机降级/手测清单状态
> **纪律**：§0.2 全沿——串行执行 + 用例间 2s；资源三采样（lasso 特征进程树）；失败先判用例再修产品；面板收尾清残留；每条附关键输出。
> **测量工具**：本目录 `ft-round1-perf-lib.mjs`（MCP stdio 真实 dist/index.js 计时 + resource-meter 同特征采样）+ runA/A2/B/C/C2/D 脚本；日志 `/tmp/ft-r11-*.log`、server stderr `/tmp/ft-r11-server-stderr.log`。

---

## 1. 门禁与基线

| 项 | 结果 |
|---|---|
| npm run build | 0 error（修复前后各一次） |
| npm test（首轮，与本域白盒脚本并行跑） | 9 failed / 2217 passed / 1 skipped —— **5 个失败文件隔离重跑 134/134 全绿** → 判定：负载诱发 flaky（timing 敏感用例），非产品回归 |
| npm test（终轮，干净串行） | **134 files / 2239 passed + 1 skipped（2240）** ✅ |
| check-invariants | **81/81 PASS**（含本轮新增 FT-DEF-1 扩展断言） |
| inv-selftest | **20/20 钉全红于违例，工作树零污染** |
| 测试数口径 | 2227 → 2240：本域 +1（FT-DEF-1 回归钉）+ 并行执行轮 +13（tab-session/ssrf-guard 等，非本域改动）；只增不减 ✅ |

---

## 2. §5 L-COST 性能基线回填（本轮回填列）

| ID | 场景 | 起步实测（在档） | **本轮回填（3 次取中位）** | 状态 | 判定 |
|---|---|---|---|---|---|
| L-COST-01 | 第一跳 machine_mcp | 1824ms / 10 条；区间 1.4-4.1s | **2439ms / 10 条**［1981, 2439, 9747］；run3 machine_mcp 瞬时 unknown → 级联 serp_http→browse（`actions:"search.machine_mcp:unknown,serp_http:unknown,browse_headless:worked"`，9.7s 含兜底） | pass | ✅ 区间内；served_by=search.machine_mcp、first_url=tokio.rs/tokio/tutorial |
| L-COST-02 | 第一跳 serp_http EN（brave 级联） | 1908ms / 20 条 | **命中不可复现**：三连 `serp_http_non_200 engine=brave status=429`（stderr 实录）→ 实测形态为兜底链 7588ms / 0 条［7734,7416,7588］；serp_http 跳本身 **1346-1418ms 快速失败** | fail-to-reproduce | ⚠️ **环境事实**（Brave 对本出口 IP 429 限流，非代码回归——链降级行为正确）；起步值待网络恢复复测 |
| L-COST-03 | 第一跳 serp_http CN（baidu） | 1134-2283ms / 17 条 | **795ms / 20 条**［1404,795,749］；served_by=`serp_http:baidu` | pass | ✅ 优于起步（当日 CDN 快）；首条 passport.baidu.com 壳=L1 已知限制 |
| L-COST-04 | 第一跳 browse_headless 兜底 | 5304-5856ms / 0 条（npx 预热） | **10549ms / 0 条**［12692,10549,10021］（触发=SSRF 拒路径 `LASSO_SSRF_DENY_RANGES=0.0.0.0/0,::/0`；served_by=browse_headless）；资源：b 0/0KB → 峰值期树起 → 终态 0/0 | pass-with-note | ⚠️ 高于起步 +79%：当日机器负载（npx 树冷启 + TUN）+ Brave 429 双跳叠加；快速失败纪律仍守住（serp_http ssrf 拒 10-13ms 级） |
| L-COST-05 | 第二跳增量 EN cb=3 | p50 ≈ +1.4s；区间 +0.7~+2.6s | **+2661ms**［+4133, +2661, +1823］；cs=3×ok；6836 字符 | pass | ✅-note 中位略超起步区间上沿 4%（网络抖动主导；方法论修正后数据，见 §3.2） |
| L-COST-06 | 第二跳增量 EN cb=5 | ~+900ms（warp 场景） | **+2368ms**［+1735,+3328,+2368］；cs=5×ok；9873 字符（并发 3 摊薄可见：5 条仅比 3 条多 +47% 时长） | pass-with-note | ⚠️ 高于起步 warp 值（不同查询/网络日；cb=5 单位产出 1975 字符/条） |
| L-COST-07 | 第二跳增量 CN cb=3 | ~+3-5s | **+3530ms**［+3530,+4641,+1177］；cs=[extract_failed,ok,ok]（百度 link?url= 壳 → extract_failed=诚实标注） | pass | ✅ 与起步一致 |
| L-COST-08 | fetch_feed（GitHub atom） | 2025ms / 5 条 | **1580ms / 5 条全对**［180000\*,1580,305］（\*run1 客户端 180s 超时——机器负载期 stdio 停摆；**隔离复测 1644ms 不可复现**；server 侧 30s 硬超时在位 fetch-url.ts:49/:139，产品面不可能 >60s 挂起） | pass | ✅ 中位 1580ms；超时样本判环境抖动（清单外观察 §6.3） |
| L-COST-09 | fetch_feed（全内容 feed 抢救） | 758ms + truncated_input | **70ms / 1 条 + truncated_input:true**［252,70,67］；首条「科技爱好者周刊（第 408 期）」头字段抢救 ✓ | pass | ✅ 今日 feed 形态下 1 完整条目入 16KiB preview；远快于起步（CDN/网络） |
| L-COST-10 | search_local history | 64ms / 5 条 | **26ms / 5 条**［40,26,21］；profiles_searched=1 | pass | ✅ 优于起步 |
| L-COST-11 | search_local files（mdfind） | 571ms / 5 条 | **605ms / 5 条**［997,605,530］ | pass | ✅ 与起步一致（Spotlight 查询主导） |
| L-COST-12 | launch-chrome hidden 冷启动 | 本轮建立 | **blocked（环境）**：9222 被会话前进程 pid 2420 占用（18:26 启动早于本面板；`lsof` LISTEN 但 `/json/version` 404 空体=不服务 CDP HTTP）→ CLI 三次诚实失败（2×cdp_not_ready + 1×chrome_exited，wall 3619-3633ms 稳定）；**台账外进程不动（§0.2 第 7 条红线）** | blocked | ⚠️ 冷启动真值未取得；旁证：9223 空闲口 launch→UP ≤2s（runD 实录 `9223 UP (lasso-launched hidden, poll 2 s)`）——3s 探活窗在空闲口充裕，L12 失败主因是端口被占 |
| L-COST-13 | read_text 续页（spill 翻页） | 本轮建立 | **14ms 中位**［14,16,13］；offset+16384 翻页 10-12ms；spill 源=fetch_url 1.2MB 纯文本（pg2701.txt）→ `@o1` + truncated:true | pass | ✅ 基线建立：本地文件切片近零开销（姿势注：browse 单 action 不走 48KiB 信封，@oN 真源在 tools 层 fetch_url/chain——见 §3.3） |
| L-COST-14 | include_refs 抽取开销 | 本轮建立 | **中位 diff −242ms**（refs 534-557ms vs 无 refs 776-888ms；附录 50 refs/3613 字符、`Interactive refs` 标题在位、正文=无 refs 版同源 4022 字符） | pass | ✅ 开销在噪声内≈0——顺序效应（第二次 extract 恒快 200-300ms）盖过增量，与「仅 evaluate 表达式顺带、无第二跳」预期一致 |

**判读纪律四条**（doc/17 §5）：

1. **第一跳 ≫ 第二跳？** 本轮 EN：第一跳 2.4s vs 增量 2.4-2.7s——比值从起步 ~2:1 收窄至 ~1:1（当日整体网络变慢：serp/CN/feed 同因），**未反转**；CN 增量 3.5s 仍低于其完整链。
2. **serp_http 2.8× 优势**：CN 侧 795ms vs browse 兜底 10.5s = **13× 保持**；EN 侧因 Brave 429 命中不可复现，优势断言本轮无法验证（环境待复测）。
3. **快速失败不拖尾**：serp_http 429 路径 1.3-1.4s、SSRF 拒 10-13ms 级、第二跳失败条 fetch_failed/extract_failed 即回 ✅；例外观察 1 例（L08 run1 客户端侧 180s stdio 停摆，server 30s 硬超时在位，隔离不复现）。
4. **资源释放**：终态盘点 lasso 特征树 **0 进程 / 0 KB**、launched-chromes 台账空 ✅（测量窗口内的 1-2 进程残留为 server teardown 滞后，最终清零）。

---

## 3. 测量过程异常判定（§0.2「先判用例」实录）

### 3.1 L02 三连 unknown → Brave 429（环境事实）

stderr 实录（/tmp/ft-r11-server-stderr.log）：
```
{"evt":"serp_http_non_200","engine":"brave","status":429}
{"evt":"metrics_failure","channel":"serp_http","outcome":"unknown","latency_ms":1346}
```
判定：**用例无误、产品无误**——链按设计降级（serp_http unknown → browse_headless worked 0 条诚实返回）；429 是出口 IP 被 Brave HTML 档限流（运营环境变化，L-OP 面）。起步 1908ms 值待网络侧恢复后复测。

### 3.2 L05/L06 首测零增量 → 缓存污染（用例方法缺陷，已修正重测）

首测 run1 的 browse 兜底 0 结果 entry 写入**持久化**搜索缓存（~/.cache/lasso/search-cache，7 天 TTL），后续 run 的 cache 命中路径拿到 0 结果 → enrich 合法跳过（ContentSecondHop.ts:531-540 gating `results.length===0 → 原样返回`）→ 增量 ≈0ms。**判定：用例方法缺陷**（no_cache 填充不落缓存、无法覆盖既有毒 entry）。修正：每轮 `rm -rf search-cache` + warm（真取）→ base（命中）→ cb（命中+第二跳）三段法（runA2）。修正后数据即 §2 表 L05/L06/L07。产品侧无缺陷；enrich 对空结果跳过是正确行为。

### 3.3 L13 两次无 spill → extract 语义 + 信封真源（用例姿势修正）

- 首测直接 `action:"extract"`：extract 不属 `NAV_FIRST_ACTIONS={network,screenshot,pdf}`（BrowseChannel.ts:1143）——作用于**当前页**（about:blank）→ 空 markdown。判定：用例姿势错误（应先 navigate）。
- 二测 navigate→extract(markdown)：`data.markdown` 恒 4022 字符——markdown 档正文即 4000 字预览契约（PREVIEW_MAX_CHARS=4000，BrowseChannel.ts:96/:347 v1.14 别名字段），**browse 单 action 不走 48KiB 信封**（applyOutputEnvelope 仅 chain 结果 BrowseChannel.ts:420 与 tools 层）。@oN 真源=fetch_url/chain。
- 终测 fetch_url 1.2MB 纯文本 → `@o1`+truncated → read_text 翻页 ✓（§2 L13）。三段过程本身是白盒收获：**「大输出落盘」承诺的实际触发面=fetch_url/wayback/feed/chain，不含 browse 单 action extract（其自限 4000 字）**——建议后续清单官在 U-16 加注。

### 3.4 L12 → 9222 会话前占用（环境，保守处置）

pid 2420（18:26:26 启动，早于本面板 19:00+）LISTEN 9222 但不服务 CDP HTTP（404 空体）。台账无此进程 → **不杀**（§0.2 第 7 条）。改 9223 完成场景 0（§4）。

### 3.5 L08 run1 180s → 客户端传输停摆（环境，不可复现）

隔离复测 1644ms；server 侧 doFetchUrl 30s 硬超时（fetch-url.ts:49 max 60s + :139 controller.abort）在位 → 产品面不可能 >60s 无响应。判：机器高负载期 stdio 停摆（本机已知 IPC 饱和问题）。清单外观察记录。

---

## 4. T-ELICIT（降级四态 + 真机 + 手测清单）

### 4.1 单测面（T-ELICIT-01..06）

| 用例 | 载体（本轮实跑） | 结果 |
|---|---|---|
| T-ELICIT-01 能力守卫四态 deep-equal | high-risk-gate-elicitation.spec（caps=undefined/{}/有 elicitation 无 form/url 有 form 无 四 it） | ✅ |
| T-ELICIT-02 能力未声明零请求 | 同上 + elicitInput spy 断言零调用 | ✅ |
| T-ELICIT-03 异常不放行 | 同上（RequestTimeout/传输错/SDK 同步 throw 三 it） | ✅ |
| T-ELICIT-04 accept 无记忆 | elicitation-port.spec + gate-elicitation（连续命中两步） | ✅ |
| T-ELICIT-05 未命中不调用 | gate-elicitation「未命中 → port 不被调用」 | ✅ |
| T-ELICIT-06 port 违约 fail-closed | elicitation-port.spec（非法值/throw） | ✅ |
| 汇总 | elicitation-port 16 + gate-elicitation 13 + gate 29 = **68/68 pass**（本轮两轮实跑：FT-DEF-1 修复前 6 红 → 修复后全绿） | ✅ |

### 4.2 场景 0 真机降级红线（c1-真机手测.md §0）——**修复后 PASS**

夹具：本地 HTTP（127.0.0.1 放行带内）`role="textbox" contenteditable="true"` 聚焦页 + `draggable="true"` 内按钮页；9223 lasso 自起 hidden Chrome；MCP 客户端（SDK Client）不声明 elicitation 能力。

```
rte      steps → outcome=didnt  stopped_at={"step_index":0,"reason":"manual_abort","failed_action":"click","detail":"high_risk_pattern:rte"}
drag_drop steps → outcome=didnt  stopped_at={... "detail":"high_risk_pattern:drag_drop"}
stderr: {"evt":"high_risk_elicit_unavailable","reason":"elicitation_form_not_declared"}
        {"evt":"high_risk_elicited_blocked","kind":"rte|drag_drop","decision":"unavailable"}
```
与 c1 清单 0.1/0.2 预期逐项一致（byte-identical didnt + 无 elicitation/create 请求）。toast pattern 未单独真机跑（与 rte/drag_drop 同一代码路径，5 pattern 单测面全绿）。

### 4.3 手测清单状态（T-ELICIT-07/08 真机弹窗三分支）

| c1 场景 | 状态 |
|---|---|
| 场景 0 降级红线（0.1/0.2） | **done**（本记录 §4.2） |
| 场景 1 RTE 弹窗继续/终止/超时（1.2-1.6） | **pending-manual**：需 CC ≥2.1.76 交互客户端人工点选（子代理不可替代）；**FT-DEF-1 修复前该面全灭（gate 永不触发），修复后方可测** |
| 场景 2 drag_drop / 场景 3 toast | pending-manual（同上） |

---

## 5. FT-DEF-1：HighRiskGate 未走上游契约适配器（真机 C1 红线全失效）——已修复闭环

- **发现路径**：§4.2 场景 0 首跑（11:51）steps 恒 worked 无拦截 → stderr `high_risk_gate_eval_failed: SyntaxError: Unexpected token 'S', "Script ran"... is not valid JSON`。
- **根因（L1 锚点）**：`src/browse/HighRiskGate.ts:182`（修复前）自带本地 `firstText`（:315 重复实现）+ 裸 `JSON.parse(text)`——chrome-devtools-mcp 1.7.0 的 evaluate_script 真实响应是 ```json 围栏包裹（upstream-response.ts 头注 2026-08-15 裸探契约），`JSON.parse("Script ran...")` 必炸 → catch → `gate_error:eval` **保守放行**。W1-DEF-1b 统一了 7 个消费点，HighRiskGate 是漏网第 8 点。
- **影响**：高风险步（RTE/拖拽/树/表格/toast 点击/填充）真机**直接执行**——C1 确认红线端到端失效（比误拦更严重的安全缺口）；2227 单测全绿放过（mock 裸 JSON 形状）。
- **分类回溯（03 §3.2）**：interface/contract → 1.2 项 1（producer 契约验证缺失，L0 mock 冒充证据）+ 1.4 项 1（值级 trace 缺失）；V-1/V-2/F-2 同型第 3 例 → **R-CHG-03 趋势警示成立**。
- **修复（TDD）**：
  1. 红：两 spec 的 mock 单点 helper 换真机围栏形状（`mockEvalResponse`，test/helpers/upstream-mock.ts）→ gate spec 6 例红（复现真机）。
  2. 修：HighRiskGate.ts 改 `parseEvalResult`（import ./upstream-response.js），删本地 firstText 重复（R-CI-08/R-DEP-05 附带清偿）。
  3. 绿：gate 面 4 spec 113/113 → 全套件 2240 全绿。
  4. 防复发：INV-76(m) 扩展——HighRiskGate 必含 parseEvalResult + 禁 `JSON.parse(text)` 旧范式回潮（check-invariants.mjs 81/81）；新增具名回归钉「FT-DEF-1 回归钉：真机 1.7.0 围栏形状→gate 必须命中而非 gate_error 放行」。
  5. 真机复验：§4.2 rte+drag_drop 双中。
- **本域改动文件**：`src/browse/HighRiskGate.ts`、`src/invariants/check-invariants.mjs`（只增）、`test/unit/high-risk-gate.spec.ts`（+1 测）、`test/unit/high-risk-gate-elicitation.spec.ts`（mock 对齐）。

**工作树并行声明**：本轮执行期间同工作树有并行执行轮改动（BrowseChannel/TabSession/ssrf-guard/config/doctor/admin-flow 等 + 13 测），非本域所为；终态门禁为合流后全绿。

---

## 6. §6 简单架构对齐判定（02 清单 38 条逐条，白盒锚点 + 实测佐证）

> 判定值：✅ 合规/有守护 ｜ ⚠️ 命中阈值需审视（附差距与建议）｜ ❌ 违反（仅 R-FF-01/02/04 可用）。
> **阈值校准声明（02 §0.3 / §E #9）**：本表全部阈值为起点值，未经本仓库事故 PR 回测校准。
> 证据底座：L1 源码锚点 + 本轮 grep/AST 实跑 + 真机实测；L0 注释不单独承载结论（引用处均为锚点定位）。

| 规则 | 级 | 判定 | 证据（锚点 + 本轮实跑） | 差距/建议（⚠️ 项） |
|---|---|---|---|---|
| R-INT-01 纯函数性 | 🟡 | ✅ | QUALITY_BY_SERVED_BY 顶级 Readonly const（QualityTag.ts:31）；ContentSecondHop deps 注入 fetchImpl/now（:71-72）；模块级 `let` 全仓 6 处均单消费者缓存（keychain/run-id/state-store/output-envelope 计数/chrome-history opener）——零多消费者可变态 | — |
| R-INT-02 开闭违反 | 🟡 | ⚠️ | 新增 tool 修改点=4（注册器+index.ts 注册+V5_TOOL_TO_CHANNEL+descriptions，INV-81(f)/INV-76(k) 原文）≥3 命中 | 有 INV 机械守护（漏一处即红）；建议长期收敛为注册器单点（v1.17 A3「可选源注入」风格已是方向） |
| R-INT-03 接口过胖 | 🟡 | ⚠️ | BrowseChannel public 8 方法（:196-620 实数）>7；DesktopChannel 构造 7 参（:86-99）>4；LoggedInChannel 6 参（:104-113）>4；HeadlessChannel 4 参（:51-62，3 可选）=边界 | 02 §B-2 上下文：3 席是 BaseChannel 生命周期契约、构造参多为依赖/测试注入位；建议 doctor/listRoots 类探针拆 trait 或按刻度容忍（satisficing） |
| R-INT-04 业务规则散布 | 🔵 | ✅ | 三组规则全单文件单一真源：NOT_FALLBACK_WORTHY_PATTERNS（fallback/outcome.ts:104，消费 :119 单点）、NAV_ERROR_SIGNATURES（BrowseChannel.ts:698）、HIGH_RISK_PATTERNS（HighRiskGate.ts:77 顶级 const INV-14）；grep 跨无关文件命中 0 | — |
| R-INT-05 PR blast radius | 🟡 | ⚠️ | `git log --stat` 15 个 feature commit 实测：13/15 触 ≥5 src 文件；>10 文件 6/15（v1.8=40 / v1.11=40 / v1.17=34 五裁决合批；v1.17 A3 单裁决 ≈20 仍 >10） | 版本合批放大；按 feature 拆 commit 可让度量生效（观测口径问题优先于结构问题） |
| R-INT-06 函数多抽象层缠绕 | 🔵 | ⚠️ | browseSingle 职责类标注：IO（callTool）/业务规则（classifyBrowseError）/校验（NAV/404 签名）/日志/错误处理 ≥4 类 ≥3 阈值；已部分拆（doNavigate/doExtract/dispatch Map） | BrowseChannel 1160 行仍为汇聚点；建议 browseSingle 的「导航校验」段（verifyNavigatedPage :734-798）独立成 nav-verify 模块（纯函数化+单测面收窄） |
| R-INT-07 运行时同源耦合 | 🟡 | ✅ | SubprocessManager 池共享但每 channel 独立 breaker+tri-state 逐跳独立降级（not_a_symptom ③）；**真机佐证**：L01 run3/L02 链 `machine_mcp:unknown→serp_http:unknown→browse_headless:worked` 逐跳独立降级可见；chrome ledger 单写者；TabSession per-channel | — |
| R-INT-08 外部命名空间契约耦合 | 🟡 | ✅ | DEFAULT_CDP_PORT=9222 命名常量（config.ts:142）；~/.claude.json 读取 INV-72（key 不落日志）；上游契约收敛 upstream-response.ts（FT-DEF-1 后 **8/8** 消费点统一：creepjs-probe/ExpectPoll/StealthEngine/cdp-actions/BrowseChannel/HighRiskGate+types）；chrome-devtools-mcp 版本锁（SubprocessManager.ts:34） | 历史违例样本 V-1/FT-DEF-1 已修复+INV 钉；建议把「新增 evaluate_script 消费点必经适配器」写进 PR checklist（review 三问挂点） |
| R-DEP-01 public API 过大 | 🟡 | ⚠️ | 同 R-INT-03 数据（DesktopChannel public 10：isAvailable/status/healthCheck/capabilities/observe/act/wait/screenshot/doctor/listRoots） | 同 R-INT-03 |
| R-DEP-02 模块深度过低 | 🟡 | ✅ | chrome-stop.ts 248 行/6 导出（depth≈41+，五步流程厚实现）；QualityTag 91/2；kill-tree 56/1；无 depth<5 热点 | — |
| R-DEP-03 穿堂式=0 | 🔴 | ⚠️（字面 1，定性边界） | AST 启发式全仓扫（137 模块）：候选 2、真命中 1——`TabSession.listPageTargets() → return this.listPages()`（TabSession.ts:203-205；public 只读探针别名，v1.10 机制三，单 caller LoggedInChannel.ts:228）；SearchCache._file 为正则误报 | **建议**：listPages 直接 public 化删别名（1 caller 改名）；不判 ❌ 的理由：机械规则将「有文档化契约的同类可见性别名」与「跨层无语义转发」同权，且 02 §C 要求人定性——保守 ⚠️ 留裁夺 |
| R-DEP-04 相邻层抽象重复 | 🟡 | ⚠️ | tools/browse.ts browseSchema（:50-90）与 types.ts BrowseOptions（:165-195）字段逐一镜像 >60% 命中；**事故实证** W1-DEF-8（screenshot_region 键名漂移=两层失同步）；无奇偶守护 | 建议加「schema↔interface 字段奇偶」INV（枚举两表键集合 diff=∅）或 zod-infer 单向真源 |
| R-DEP-05 信息泄漏 | 🟡 | ✅ | 围栏正则全仓唯一（upstream-response.ts:41）；上游形状字面量零外泄（grep ``` 与 image/mimeType 跨界命中=消费点 import 而非重实现）；FT-DEF-1 即本条违例的第 8 点已清+INV-76(m) 禁回潮 | — |
| R-DEP-06 注释稀释度 | 🔵 | ✅ | 工具面 description 长（descriptions.ts 869 行）属 MCP schema 自述 API reference（接口即文档），非「需注释才能说清」；源码注释多为 WHY（裁决/parse 引用号） | — |
| R-CHG-01 touches-per-change | 🟡 | ⚠️ | 同 R-INT-05 数据（周期级 feature 聚合 13/15 ≥5 文件） | 同 R-INT-05 |
| R-CHG-02 认知负荷代理 | 🔵 | ✅ | 134 spec/36128 行（均值 269 行）；helpers 复用（upstream-mock/resource-meter）压 setup；spawn 型 7 spec 有 15s 独立桶（F-T1） | — |
| R-CHG-03 回归逃逸率 | 🔵 | ⚠️（趋势警示） | 实证样本 4 例：V-1/V-2/F-2 + **FT-DEF-1（本轮，2227 全绿下 C1 红线真机失效）**——mock≠真契约同类复发 | 同型缺陷再现说明该风险面未收敛；本轮已按 03 §3.2 回溯补 INV-76(m)；建议 mock 全部经 upstream-mock 构造（铁律已有，新增消费点时 PR 检查） |
| R-CI-01 术语一致性 | 🟡 | ✅ | served_by/retrieval_method/outcome 三词 types.ts 单点浇筑全仓统一；句柄四前缀 @oN/@pN/@wN/rN 各有 regex+注释区分（read-text.ts:58/extract-refs REF_PATTERN）；同义词组扫描无同概念混用 | — |
| R-CI-02 横切关注点变体 | 🟡 | ✅ | 单 fallback 引擎（INV-4/55）；ssrfGuard 单源 10 文件消费；连接池 acquireHttpClient 单源 8 文件（ContentSecondHop.ts:17-18 明示不 new Agent）；kill-tree 单源 6 消费（INV-77a）；cross-ref R-INT-07：多读法=独立容错非违例 | — |
| R-CI-03 同名实体多义 | 🟡 | ✅ | InteractResult 跨 channel 同名同形（types.ts 单点，无分叉定义） | — |
| R-CI-04 翻译逻辑越界 | 🔵 | ✅ | upstream-response.ts=ACL 合规解；search engine 分支是路由非字段翻译；FT-DEF-1 清零越界样本 | — |
| R-CI-05 测试名读作领域行为 | 🔵 | ✅ | 抽样实抓：「clientCapabilities === undefined → unavailable 且 elicitInput 零调用」「FT-DEF-1 回归钉：真机 1.7.0 围栏形状→gate 必须命中而非 gate_error 放行」；零 test1 类 | — |
| R-CI-06 rejected-by-design 存在 | 🔵 | ✅ | doc/24-颠覆性调研/verdict.md §4 D-NOGO 9 项（触发条件写死）+ round1-verdict R1-R11 拒绝清单 | — |
| R-CI-07 新概念准入门槛 | 🔵 | ⚠️ | parse24 §7 冲突清单 10 条存在（doc/25/parse24.md:277）但非 PR 模板强制字段 | 判「机制存在、模板缺」：冲突清单是事后裁决产物；建议进 PR 模板 checkbox |
| R-CI-08 知识重复 | 🔵 | ⚠️ | 正例 kill-tree 单源；**反例实锤：两套 tmp 根**——SPILL_ROOT=os.tmpdir()/lasso-output（output-envelope.ts:39）vs 硬编码 `/tmp/lasso-screenshot-<uuid>.png`（BrowseChannel.ts:835）；macOS 上二者物理不同目录（TMPDIR=/var/folders/...），同一决策（临时文件放哪）两处实现 | 建议统一走 SPILL_ROOT 常量（Windows 兼容性顺带修：/tmp 字面量在 win 不存在） |
| R-ABS-01 参数蔓延/按 caller 分流 | 🔵 | ✅ | LaunchChromeOptions 13 字段中 6 个明示「测试注入」（launch-chrome.ts:61-91，02 注：测试注入位不算）→ 语义字段 7 个；无 boolean flag ≥2 分流形态 | 附观察：platform/programFiles* 3 字段为 win 探测专用，可归组嵌套（ cosmetic） |
| R-ABS-02 内联差异率过低 | 🔵 | ✅ | ContentSecondHop 护栏栈（timeout+maxBytes+budget+concurrency+budgetChars，:103-109）vs http-serp 护栏栈（host 白名单+ssrf 同函数+AbortSignal+headers+状态分诊，http-serp.ts:221-270）：共享部分=ssrfGuard 单源 ✓；仅 5_000 超时字面量两处重复 | 小注：5s 默认值字面量两处（同决策弱重复），可提共享常量或互引注释 |
| R-FF-01 分层方向 | 🔴 | ✅ | import 图实跑（137 模块/467 边）：tools→channels 10 文件正向；channels/search/fallback/browse/launcher→tools 反向 **0**；runtime/→channels 内部 **0**（INV-35 面）；browse→channels 唯一 StepEngine type-only（:45） | — |
| R-FF-02 循环依赖 | 🔴 | ✅（附注） | 值级环 **0**（排除 import type 严格扫描）；含 type 边环 3（StepEngine↔BrowseChannel / doctor↔desktop-doctor-checks / DesktopChannel→doctor→InteractDispatcher→DesktopChannel）——三环回边全 type-only（:45/:29/:26），运行时零环 | 建议未来接 dependency-cruiser 时配 `notToOnlyTypes` 豁免并把此 3 环留档，防误报 |
| R-FF-03 圈复杂度/传入耦合 | 🟡 | ⚠️ | 未接复杂度扫描工具（外部评级未接=R-FF-05 同因）；行数代理热点：BrowseChannel 1160 / search.ts 915 / descriptions 869（文档）/ admin 757；doctor.ts 斜率叙事已收敛（doc/19 R9 趋零） | 声明「未度量」；起步最小集不依赖本条 |
| R-FF-04 ≡R-DEP-03 | 🔴 | ⚠️（1 边界命中） | 同 R-DEP-03（结论共享行） | 同 R-DEP-03 |
| R-FF-05 可维护性评级 | 🟡 | ⏸ 声明 | SonarQube 类未接入；起点未校准（02 §0.3） | 接入或持续声明 |
| R-FF-06 趋势告警 | 🟡 | ✅ | 门禁基线单调递增实数列：1801→1961（doc/19 §0）→2218→2227（doc/17 §v1.17）→**2240（本轮实测）**；门禁脚本存在且本轮全绿实跑（81 INV + 20/20 selftest） | — |
| R-DRIFT-01 依赖图偏移 | 🟡 | ✅ | `npm outdated` 实跑：运行时 7 依赖全在声明 semver 带内（undici 7.28→wanted 7.29 一 patch 落后）；6 devDeps major 落后（ts 7/vitest 4/zod 4/uuid 14/@types 26/undici 8）=演进迁移非熵退化（02 §6.2 注）；chrome-devtools-mcp 1.7.0=锁版 latest 政策内；SDK v1 死线 2027-01 挂账（W-3/R10） | — |
| R-DRIFT-02 上下文地图偏移 | 🔵 | ✅ | 17 工具 tools/list 与 §0.4 矩阵一致；search_local 为显式裁决新增（doc/24 decision-B=演进迁移）；四通道+forest 入口五轮零漂移结论未被本轮推翻 | — |
| review#1 第二套做法 | 🔵 | ⚠️ | 真实第二套 1 项：两套 tmp 根（同 R-CI-08，在档）；click 双路径（ref vs 上游 uid）为**有意并存**（冲突 #8 定案+R-REFS-09 并存语义）；chrome-stop vs SubprocessManager 收尾对象不同（detached Chrome vs MCP 树）且共享 kill-tree 单源 | 同 R-CI-08 建议 |
| review#2 what vs how | 🔵 | ✅ | content_blocks（what：拿 N 条正文，隐藏并发/裁剪/预算——本轮 cb=3/5 实测行为证实）；launch-chrome（what：起 Chrome，隐藏台账/探活/五步收尾）；browse uid 体系 how 泄漏已由 include_refs 补救（50 refs 附录实测） | — |
| review#3 参数蔓延前摄面 | 🔵 | ✅ | 同 R-ABS-01 | — |
| review#4 运行时同源前摄面 | 🔵 | ✅ | 同 R-INT-07（真机独立降级证据 L01run3/L02） | — |

### 6.1 汇总分布（39 行 = 38 规则，R-FF-04≡R-DEP-03 共享结论）

- **✅ 26** ｜ **⚠️ 12**（R-INT-02/03/05/06、R-DEP-01/03/04、R-CHG-01/03、R-CI-07/08、R-FF-03、R-FF-04≡R-DEP-03、review#1 —— 计 13 行，其中 R-DEP-03/R-FF-04 同一命中计 1 处实体）｜ **❌ 0** ｜ **⏸ 1**（R-FF-05 未接入声明）。
- **🔴 硬不变量 3 条**：R-FF-01 ✅ / R-FF-02 ✅（值级 0 环，3 个 type-only 环留档）/ R-FF-04≡R-DEP-03 ⚠️（1 处边界命中：TabSession.listPageTargets 同类别名，建议直接修——非跨层无语义转发，不判 ❌ 的定性依据已附）。
- **起步最小集（02 §1 六条）达标**：R-FF-01 ✅、R-FF-02 ✅、R-DEP-03 ⚠️（1 边界）、R-CHG-01 ⚠️（命中+合批口径注）、R-CI-01 ✅、review 三问 ⚠️（#1 命中 1 项 tmp 根）。
- **跨刻度主题**（清单外观察汇总，不冒充 finding）：① mock-真机契约漂移是本仓系统性风险面（4 例实证）；② 两套 tmp 根 + /tmp 硬编码的跨平台隐患；③ 版本合批使 R-INT-05/R-CHG-01 度量失真（观测口径）。

---

## 7. 03 清单视角（审查测试域内交叉）

- **1.2 项 1/2（producer 契约）**：FT-DEF-1 即违例实锤（L0 mock 冒充 L2）→ 已修+INV 补条（闭环）。
- **1.5 性能四问**：本轮 §2 表回答 (d) 单操作 latency budget（各层实测在档）；(a-c) 容量/天花板/10x 属容量规划面，超出本域（清单外）。
- **2.4 项 3/5**：时序注入（machine_mcp 抖动/Brave 429）下的独立容错实测（tri-state 逐跳）✅；Heisenbug 纪律——L08 超时样本隔离复测（不复现→判环境）✓。
- **3.2 缺陷分类回溯**：FT-DEF-1 → 1.2/1.4 维 + INV-76(m) 新断言（防复发清单项已补）✓。
- **3.6 双盲**：本域修复由真机（场景 0）与单测（契约 mock）双面验证；后续轮可派新 agent 复查 INV-76(m) 抓获力。

---

## 8. 残留清理（§0.2 第 7 条）

| 项 | 终态 |
|---|---|
| lasso 特征进程树 | **0 进程 / 0 KB**（sampleLasso 实测） |
| launched-chromes 台账 | `[]`（空） |
| 9223（本面板自起） | chrome-stop exit=0，端口释放 |
| 9222（会话前 pid 2420） | **保留不杀**（台账外、先于本面板存在；虽不服务 CDP HTTP 但非本面板资产） |
| 用户会话 chrome-devtools-mcp（claude-vscode entrypoint pid 3084/3200/3323） | 保留（用户 CC 会话自身设施） |
| ~/.cache/lasso/search-cache | 测量期间每轮清除（可再生缓存），终态为空——后续用例自会重建 |

---

## 9. 本轮 fail/blocked 清单（移交下轮或用户）

| # | 项 | 性质 | 处置 |
|---|---|---|---|
| 1 | L-COST-02 serp_http EN 命中不可复现（Brave 429×3） | 环境事实 | 待网络/IP 侧恢复复测；doctor serp_health 可监控 |
| 2 | L-COST-12 冷启动真值未取得 | 环境（9222 会话前占用） | 下轮换 9223+ 口径重测（旁证 ≤2s UP 已在档） |
| 3 | T-ELICIT-07/08 弹窗三分支（c1 场景 1-3） | 人工 | **FT-DEF-1 修复后方可测**——建议用户在 CC ≥2.1.76 客户端按 c1 清单执行（场景 0 已由本记录覆盖） |
| 4 | TabSession.listPageTargets 穿堂边界命中 | 产品微整（R-DEP-03） | 建议 listPages public 化删别名（1 caller） |
| 5 | 两套 tmp 根 + /tmp 硬编码 | 产品微整（R-CI-08/review#1；win 兼容隐患） | 建议统一 SPILL_ROOT |
| 6 | tools↔channels 字段镜像无奇偶守护 | 结构（R-DEP-04；W1-DEF-8 前科） | 建议 schema↔interface 奇偶 INV |
| 7 | 首轮 npm test 9 例负载诱发 flaky | 测试基建 | timing 敏感用例建议迁移 timing-sensitive 桶或放宽断言窗（expect-poll 80ms→宽松） |

**本域结论**：L-COST 14 项中 11 项有效回填（10 pass/1 pass-with-note）、2 项环境受阻（L02 复现待网络、L12 端口被占）、1 项观察（L08 传输停摆）；§6 38 条判定完成（✅26/⚠️12/❌0/⏸1，硬不变量 2✅+1 边界）；T-ELICIT 单测 68/68 + 场景 0 真机 PASS；抓出并闭环 **FT-DEF-1**（C1 红线真机失效，TDD 修复+INV 防复发+真机复验）；门禁终态 **2240 tests + 81 INV + selftest 20/20**（只增不减）。
