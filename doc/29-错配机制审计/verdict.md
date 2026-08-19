# 29-错配机制审计 · 审查官裁决（verdict.md）

日期：2026-08-20 · 审查对象：v1.18.2 工作树（fixes.md 声称的 4🔴 全修 + 4🟡 实施 + 19🟢 保留）
审查方法：03_审查测试清单 §1 六维全过 + 独立枚举复核（审查官自行 grep 部署模型核对，不只信修复报告）+ 门禁终跑 + inv-selftest。

## 裁决：✅ **PASS——批准交付 v1.18.2**

4🔴 / 4🟡 修复全部属实且语义正确；19🟢 保留理由复核成立；安全守卫本体（SSRF CIDR/协议/userinfo、2FA 红线、HighRisk fail-closed、防注入白名单）零弱化（对抗测试钉死）。审查官补 3 处小修（注释漂移 / flaky 缓解 / 部署模型文档），门禁四件套终跑全绿。

---

## 一、03 §1 六维审查结论

### 1.2 数据逻辑（重点维度）——**通过，误分类修复的 outcome 语义证据链完整**

- **F1 语义二分**：`src/ssrf/ssrf-guard.ts:55-85` 单一语义源 `ssrfDenial()`——`isSsrfEnvTransientReason()` 只认 `dns_empty`/`dns_failed:*` 前缀 → `unknown + ssrf_dns_unresolved`；其余（invalid_url/userinfo_present/protocol_not_allowed:*/deny_range:*/private_ip:*）→ `didnt + ssrf_blocked`。**9 个消费点全部 import 同一 helper**（grep 验：browse/steel/browserbase/fetch-url/pdf/network/fetch-feed/screenshot/wayback 各 1 处调用，零手搓分支）——R-CI-08 单一真源达成。
- **值级 trace（1.4 项 1）**：DNS 瞬态路径 `ssrfGuard→{allowed:false,reason:"dns_failed:..."}`→`ssrfDenial→{outcome:"unknown",retrieval_method:"ssrf_dns_unresolved"}`→`InteractResult.outcome="unknown"`→`isFallbackWorthy("unknown",err)`=true→fallback 链继续。字段缺失语义：`r.error ?? r.outcome` 喂长熔断时裸 unknown 落 `isSustainedFailureError("unknown")=false`→不计数——每一跳有 producer 源码锚点，无 L0 证据。
- **F2 喂入分类契约**：`CapabilityBag.disable(n,{reason:"long_circuit_open"})` 写入 → `snapshot()[i].reason` 读出（CapabilityBag.ts L77/L82 producer 链核实）；`bag.enable` 签名 `{callerId}`（L93）匹配两处调用。reason 为 undefined（手工 disable 无 reason）时 `undefined==="long_circuit_open"`=false→不越权恢复——字段缺失语义保守正确（1.2 项 2 ✅）。
- **F4 数学保证核实**：`applyOutputEnvelope` 在 `bytes>SINGLE_CAP_BYTES(16MiB)` 时先 throw、不达 `spillToDisk`→进入 spill 的 text 必 ≤16MiB<STORE_CAP(64MiB)→「淘汰光后必放得下」成立；防御分支确实不可达但保留防常量漂移（合理防御，非死代码）。`readOutputPage` 的 LRU touch（delete+set）在 existsSync 检查前——被续页读的 ref 不先被淘汰（真 LRU）。ref 被淘汰后 `read_text` 已有 try/catch 友好降级（read-text.ts:82-99，JSON payload 带 error 字段，不崩 tool）。
- **F3/Y3 状态机**：`stop()` 显式 `chainOutcome` 参数（StepEngine.ts:343-352）覆盖默认 didnt；budget_exceeded 与 expect_error 都传 `unknown`；`expect_check:"error"` 联合类型扩展——src 内无其他消费点（grep 验），下游 CC 侧为信息展示，无穷举 switch 崩溃面。

### 1.6 简单架构（重点维度）——**通过，安全守卫零误削弱（对抗证据）**

- **SSRF 本体拦截行为零改动**：diff 内 guard 主流程（步骤 1-5）一字未动，只新增语义映射层。对抗测试三层钉死不漂移：
  - guard 层（ssrf-guard.spec）：10.x/192.168/**169.254.169.254 AWS metadata**/127.0.0.2（/8 非 /32）/IPv6 ULA fc00::/IPv6 loopback **[::1] 括号剥离（FT-DEF-3）**/IPv4-mapped hex 形式 [::ffff:7f00:1]→全部仍拒；
  - 消费层真路径（fetch-url.spec:124-168）：私网→`didnt+ssrf_blocked` 且 **fetch 不被调**；dns_failed/dns_empty→`unknown+ssrf_dns_unresolved`——policy→didnt 钉死；
  - 级联层（misfit-cascade-regression 8 用例）：DNS 风暴零长熔断计数 / 429 真持续故障照常 open（**长熔断语义未拆除，只是不再误伤**——这是本修复最重要的对称性证明）。
- **F2b 不实施**的裁决复核成立：喂入分类后 onOpen 只剩真持续故障（配额/凭据），此时 disable+杀进程是正确语义（人须修配置），降级反而丢信号——不是偷懒，是分类后语义闭合。
- **Y4 白名单边界正确**：`tcc_denied`/`tcc_screen_recording_denied`（档级权限）移出 DIDNT 集，但 `script_not_in_whitelist`/`param_*`/`invalid_params`/`app_not_found`（跨档确定性/防注入红线）保留 didnt——注入防线未动。
- 代码健康：修复呈「单一语义源 + 喂入收紧 + 恢复闭环」三处正交小改，无新抽象层、无参数蔓延。`outcomeFromFetchError` 退化为常函数 `return "unknown"` 保留形状有注释契约说明（上游 isFallbackWorthy 对称）——可接受。

### 1.1 / 1.3 / 1.4 / 1.5——通过

- 1.1：注释全部 WHY 向（设计反转背景 + 指令溯源）；抓到 1 处注释漂移（fetch-url.spec 头注释仍写「ENOTFOUND→didnt」与 Y2 后行为矛盾）→ 审查官已修（见 §四）。
- 1.3：熔断状态机边界枚举完整——half-open 态瞬态失败不 re-open（保持 half-open 留下次 probe，LongCircuitBreaker.ts:113-117）、open 态幂等不重发 onOpen、closed 常规成功不触发 onClose（recordSuccess 的 `recovering` 守卫）；admin breaker_reset 与 onClose 恢复不会双触发（reset 后 state=closed，recordSuccess 的 recovering=false）——组合行为无双重 enable 竞态。
- 1.4：producer→first-consumer 接缝（ssrfGuard reason → ssrfDenial；bag.reason → onClose 守卫）均有值级证据；受影响文档面 ARCHITECTURE/KEY-GUIDE 由审查官补齐（见 §四）。
- 1.5：无热路径新增开销（LRU 淘汰仅 cap 满时触发）；1 处测试 flaky 归因+缓解（见 §四，非产品代码）。

---

## 二、独立枚举复核（审查官自行 grep，不只信报告）

按任务枚举方法重跑四类 grep（blocked/exceeded/forbidden/denied 分支、DEFAULT_* 常量、防滥用注释、fail-closed 默认），38 个 src 文件命中。逐个部署模型核对，**报告 47 命中面无遗漏**；报告外命中项复核结论：

| 命中 | 部署模型核对 | 结论 |
|---|---|---|
| `DEFAULT_CALLER_CAP` | P26 在树内：`CallerTierTracker.ts:92 = Number.POSITIVE_INFINITY` + opt-in env `LASSO_CALLER_CAP_DEFAULT`（构造期一次读，运行时不可改——防 LLM 绕过，保留正确） | ✅ 已修维持 |
| `ElicitationPort` fail-closed | 2FA/HighRisk 红线：恶意网页诱导高风险操作在单用户本地**成立** | ✅ 豁免区，保留 |
| `PolicyGate` cloud 双重解锁 | 真实付费成本边界 + 用户显式 opt-in（成本威胁真实存在） | ✅ 保留 |
| `quota-ledger.markExhausted` | 真实 429 + Retry-After，与长熔断正交（F2 后边界更清：ledger 管 key 级短期） | ✅ 保留 |
| `ContentSecondHop` content_hop_ssrf_blocked | SSRF 拒（含 DNS 瞬态）→ item 级 `content_status:"fetch_failed"`，主搜索结果照常返回——**无工具级 didnt 终答、无熔断喂入**，不构成错配伤害 | ✅ 不属错配（记录观察项：粒度粗于 F1 二分，未来若 item 级需要区分可复用 ssrfDenial） |
| `http-serp` SSRF→unknownResult | serp 降级层，policy 拒也返 unknown（保守可重试）——不惩罚业务；与 9 消费点语义粒度不一致属统一化后续项，非错配 | ✅ 保留（观察项） |
| `launch-chrome` hide_fuse_denied / `ResourceMonitor` threshold | 本地原语结果回显 / 旁路采样观测，非拦截 | ✅ 非错配 |

---

## 三、分类统计与修复核验

**输入**：47 命中文件 → 28 项裁决（🔴4 + 🟡5 + 🟢19）。

### 🔴 4/4 全修核验

| # | 修复 | 源码锚点（L1 证据） | 核验 |
|---|---|---|---|
| F1 | SSRF DNS 语义二分 | ssrf-guard.ts:55-85（ssrfDenial）；9 消费点各 1 处调用 | ✅ 单一真源；对抗测试钉死 policy→didnt |
| F2 | 长熔断喂入分类+恢复闭环 | outcome.ts:143-165（isSustainedFailureError 白名单）；LongCircuitBreaker.ts:113-117（瞬态不计数）/91-98（onClose 恢复转换）；FallbackDecider.ts:250,318（error 透传）；index.ts:1132-1140（条件 bag.enable，reason 守卫）；admin.ts:548-561（breaker_reset 条件恢复） | ✅ 12 轮 DNS 风暴零计数+429 照常 open 双向断言 |
| F3 | budget_exceeded→unknown + budget_ms | StepEngine.ts:133-144（chainOutcome:"unknown"）；BudgetTracker.ts:42-50（MAX 600s + clamp）；BrowseChannel.ts:281-287/484-494（管道透传）；browse.ts:65（schema max 600_000） | ✅ 假健康 recordSuccess 掩蔽消除（级联回归断言 failureCount>0） |
| F4 | spill LRU 淘汰+不抛+二分 | output-envelope.ts:170-215（LRU 淘汰+rmSync）/136-140（touch）；BrowseChannel.ts:529-549（降级 preview-only）；pdf/network catch 二分 | ✅ 164MiB 连续 spill 零 throw；SINGLE<STORE 数学保证核实 |

### 🟡 5 项裁决

Y1 修（随 F3，budget_ms 钳 600s）· Y2 修（nxdomain/enotfound/ECONNREFUSED→unknown，三处同族连带）· Y3 修（expect 抛错≠后置条件假，expect_check:"error"+unknown，INV-13 重新论证正确：不虚报 worked 也不虚报「否」）· Y4 修（三 provider tcc_denied→unknown，白名单注入类保留 didnt）· Y5 记录不动（短熔断 60s 自愈快、伤害有界——U 型曲线裁决成立）。

### 🟢 19 项保留（fixes.md §四表复核成立，抽查记录）

CallerTierTracker（P26）/ RpmLimiter 默认 Infinity（种子 d 证实非错配）/ PolicyGate 双重解锁 / QuotaLedger / **SSRF CIDR/userinfo/协议本体（零弱化）** / HighRiskGate+Elicitation fail-closed / preview 4000/48KiB（token 经济，错配只在总量 cap 已由 F4 修）/ Brave Retry-After 60s / free_only / ResourceMonitor / Metrics / SerpHealth / HitRateStats / SearchCache / StateStore LRU / RootRegistry / TabRegistry clamp / chrome idle reaper / CGEvent 红线 / http-serp timeout unknown / 2FA 关键词探测（仅 note）——逐项与部署模型核对无新证据推翻。

---

## 四、审查官补充修复（3 处，本裁决轮直接实施）

1. **注释漂移**：`test/unit/fetch-url.spec.ts:10` 头注释「ENOTFOUND → didnt」与 Y2 修复后行为矛盾 → 改「ENOTFOUND → unknown（v1.18.2 doc/29 Y2）」。
2. **flaky 缓解**：`test/unit/doctor-v17-integration.spec.ts` baseline 比对组全量并发下偶发超默认 15s（首终跑 1 failed；隔离 3/3 绿 1.4s 级；doctor.ts 本次仅版本号一行、零行为关联面）→ 组级显式 `timeout: 45_000` + WHY 注释。属测试基础设施脆弱性，非产品回归。
3. **部署模型文档**（任务项 2）：`ARCHITECTURE.md` §1 新增「部署模型声明（守卫设计判据）」——单用户本地 stdio + 四条判据（多租户想象默认放开 / 瞬态≠策略拦截 / 瞬态不得升级惩罚 / 豁免区清单）；`doc/KEY-GUIDE.md` §E 表新增 `LASSO_CALLER_CAP_DEFAULT` 行（默认不限制、opt-in 自控、计数保留观测）。

---

## 五、门禁终跑（2026-08-20，含审查官 3 处补充后）

| 门禁 | 结果 |
|---|---|
| `npm run build` | ✅ |
| `npm test` | ✅ 141 文件 / 2364 passed / 1 skipped / 0 failed（flaky 缓解后终跑全绿） |
| `npm run check-invariants` | ✅ 82/82 |
| `npm run inv-selftest` | ✅ 23 sampled pins 全翻转红 / 工作树零污染 |

版本三处（package.json / index.ts LASSO_SERVER_VERSION / doctor.ts LASSO_VERSION）= 1.18.2 对齐 + 测试侧镜像 7 处命中（INV-63）。

## 六、遗留观察项（非阻断，无行动要求）

1. `ContentSecondHop` item 级 SSRF 折叠粒度粗（不区分 policy/瞬态）——当前无伤害；若未来 item 级需要语义，复用 `ssrfDenial` 即可。
2. `http-serp` 对 policy 拒返 unknown（粒度粗于 9 消费点二分）——降级层保守可重试，无伤害；语义统一化可后续做。
3. `BrowseChannel.wrapChainResult` 降级分支 `json.slice(0,16*1024)` 硬编码且未走 utf8ByteSlice（切多字节字符可能出乱码尾）——仅 >16MiB 异常数据触发的 preview 展示瑕疵。
4. 2FA 关键词探测（仅 status note）若升级为 outcome 判据，须先收紧为 URL/selector 判据（沿用枚举报备注）。
