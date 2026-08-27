# 29-错配机制审计 · 修复官报告（fixes.md）

日期：2026-08-19 · 基线：v1.18.1 工作树（含未 commit 的 P26 `DEFAULT_CALLER_CAP→Infinity`）→ 本次交付版本 **v1.18.2**
输入：`enumerate.md`（47 命中文件逐个白盒：🔴4 + 🟡5 + 🟢19 + 级联总图）
裁决原则（用户指令逐字）：「正中要害——这个机制的存在本身就是错配……是不是还有类似问题，都要一并修复。」审计对象是**错配**（为不存在的威胁模型设计的守卫惩罚单用户本地 stdio 部署的正常业务），不是安全本身——SSRF 本体 / 2FA 红线 / HighRisk 全部保留原强度。

---

## 一、🔴 逐项修复（4/4 全修）

### F1. SSRF `dns_failed`/`dns_empty` → unknown 可重试（9 个消费点全改）

**裁决**：证实。DNS 解析不出是**环境条件**（TUN 断网/DNS 抖动/captive portal），不是策略判决；旧实现把它混进 `ssrf_blocked` + `didnt` 终答「政策拦截、明确否、不可重试」（104 章批跑实证）。安全本体（CIDR/userinfo/协议/deny）零弱化——只二分**语义**，不二分**拦截**。

**实施**：
- `src/ssrf/ssrf-guard.ts`：新增 `isSsrfEnvTransientReason()` + **`ssrfDenial(reason)`** —— 单一语义源：策略确定性（invalid_url/userinfo/protocol/deny_range/private_ip）→ `didnt + ssrf_blocked`；环境瞬态（dns_failed/dns_empty）→ `unknown + ssrf_dns_unresolved`。9 个消费点共用此 helper，禁各自手搓。
- 9 个消费点改造：`tools/browse.ts`、`steel.ts`、`browserbase.ts`（各自 `ssrfBlocked()` helper 内二分）+ `fetch-url.ts`、`pdf.ts`、`network.ts`、`fetch-feed.ts`、`screenshot.ts`、`wayback.ts`（内联块二分）。
- 仓内不自洽消除：`serp/http-serp.ts` 原本就返 unknown（枚举报引用的「正确参照」），保持不动——现在全仓 DNS 语义一致。

**测试**：`ssrf-guard.spec.ts`（helper 二分 7 用例：dns_failed/dns_empty→unknown；invalid_url/userinfo/protocol/deny/private→didnt 不漂移）+ `fetch-url.spec.ts`（真实 ssrfGuard 路径：DNS 失败→`unknown + ssrf_dns_unresolved`，私网仍 `didnt + ssrf_blocked`）。

### F2. 长熔断：喂入分类 + 恢复闭环（a+c 组合，b 不需要）

**裁决**：证实，最大级联放大器。`recordFailure` 从不看成因——文件头自述的部署想象「月配额耗尽类」早已被 QuotaLedger 专项覆盖，实际捕获的是用户自己断网（TUN 断 10 分钟 = 10 次 unknown within 1h → 60min disable → `bag.disable` → 杀子进程 → 手工恢复）。

**实施**（子型①：默认值从旧想象沿用未随现实校准 → 喂入收紧；恢复断链修复）：
- **F2a 喂入分类**：`fallback/outcome.ts` 新增 `isSustainedFailureError(error)` 白名单——仅 429/rate limit/quota/billing/credit/api key/unauthorized/authentication/upstream_unsupported 计数；DNS/timeout/ECONNREFUSED/裸 unknown **一次都不计**（归 60s 短熔断管）。`LongCircuitBreaker.recordFailure(error?)` 内置分类（无信号按持续计，兼容 no-arg 调用方与既有单测）。`FallbackDecider.ts:252,319` 两个喂入点传 error 字符串。
- **F2c 恢复闭环**：`LongCircuitBreaker` 新增 `onClose` 回调——**open/half-open → closed 的恢复转换**触发（closed 态常规成功不触发）。`index.ts` 装配：`onClose → bag.enable`，带 **reason 守卫**（仅恢复 `reason==="long_circuit_open"` 的 disable，不越权恢复 admin 手工 disable）。`admin.ts breaker_reset` 同守卫条件联动 enable。
- **F2b（onOpen 降级 warn-only）不实施**：喂入分类后 onOpen 只在真持续故障（配额耗尽/凭据失效）触发——此时 disable+杀子进程**是正确语义**（人须修配置），降级反而丢信号。

**设计自洽性**：provider 级（search.brave）disable 只摘 fallback 链不摘 MCP tool → 60min 后 half-open probe 有真实流量 → probe 成功 onClose 自动恢复（月配额重置场景全自动闭环）；channel 级（browse/cloud）disable 摘 tool → 无 probe 流量，但该级现在只有「人须修配置」类故障才会 open——手工恢复是正确成本。

**测试**：`long-circuit-breaker.spec.ts` +8（瞬态风暴×40 零计数、裸 unknown 不计、429 正常计数 open、no-arg 零回归、half-open 瞬态不 re-open、onClose 触发/不触发/吞错）；`outcome.spec.ts` +17（分类器持续/瞬态矩阵）；`admin-breaker-reset.test.ts` +2（条件恢复/不越权）；级联专项见 §三。

### F3+Y1. `budget_exceeded` → unknown + `budget_ms` 显式放宽（钳 600s）

**裁决**：证实（语义半）。边界本身 🟢（「chain 不会无限烧时间」的确定性护栏）；错在**终止语义**——自己设的闹钟响了被报成「内容不存在」，且 decider 把 didnt 当「channel 健康」双熔断 `recordSuccess`（假健康反向掩蔽诊断）。

**实施**：
- `StepEngine.ts`：budget 耗尽 → `chainOutcome:"unknown"`（自限=瞬态：decider 试下一通道，CC 可拆步/放宽 budget_ms 重试）。状态表注释同步。
- `BudgetTracker.ts`：新增 `MAX_CHAIN_BUDGET_MS=600_000` + `clampChainBudgetMs()`（非法值回落默认；超上限截断——防 1e9 误配把边界变成没有边界）。
- `BrowseChannel.runChain(url, steps, budgetMs=DEFAULT_CHAIN_BUDGET_MS)` 第三参；`browse()` 分流处经 `clampChainBudgetMs(options.budget_ms)` 透传。
- `types.ts BrowseOptions.budget_ms` + `tools/browse.ts` schema `budget_ms: int().positive().max(600_000).optional()`。

**测试**：`budget-tracker.spec.ts` +3（钳制矩阵）；`browse-steps.spec.ts` +3（options.budget_ms=5 到达 chain（detail 报 cap=5ms）、runChain 直传 budgetMs=0、缺省 120s 长链跑完）；`step-engine.spec.ts` 2 处断言改 unknown。

### F4. spill 仓 LRU 淘汰 + 耗尽不抛 + single_cap/store 二分（种子外新发现）

**裁决**：证实（长会话定时炸弹 + F2 级联源）。注释自认「v0.3 简单实现：暂不淘汰」——64MiB 单调递增，长命 server 会话一天可撞（PDF base64 1.33× 膨胀），撞后**所有**大输出永久 throw 直至重启。

**实施**：
- `util/output-envelope.ts` `spillToDisk`：超 cap 时 **LRU 淘汰最老 spill（删 Map 头 + `rmSync` 删文件）** 直到放得下，不再 throw。数学保证：SINGLE_CAP(16MiB) < STORE_CAP(64MiB) → 淘汰光后必放得下；防御分支保留（不可达，防常量漂移）。淘汰失败计数 `getEvictedCount()` 观测。
- `readOutputPage` **读即 touch**（delete+set 移到最新端）——正被续页读的 ref 不先被淘汰（真 LRU 而非 FIFO）。
- 未捕获路径降级：`BrowseChannel.wrapChainResult` 与 `fetch-url.ts` 的 `applyOutputEnvelope` 包 try/catch——单条 >16MiB（数据异常）时返回 preview-only envelope（truncated=true + 无 ref + 诚实 refine_hint），不 throw 不崩 tool。
- 误分类路径二分：`pdf.ts` / `network.ts` catch 按 `store exhausted` 前缀二分——single_cap 保留 didnt（数据异常，调方缩范围，`retrieval_method:"envelope_single_cap_exceeded"`）；store（防御分支）→ unknown（`envelope_store_degraded`）。

**测试**：`output-envelope.spec.ts` 重写 store-cap 组 +3（第 9 次 spill 淘汰 @o1 不抛、@o1 unknown ref 而 @o2 可读、LRU touch 保护被续页读的 ref、200×1MiB 连续 spill 零 throw 回归）；级联专项 §三链 4。

---

## 二、🟡 逐项裁决（Y1 已随 F3 实施；Y2/Y3/Y4 实施修；Y5 记录不动）

| 项 | 裁决 | 实施 |
|---|---|---|
| **Y1** budget_ms 不可覆盖 | 修（随 F3） | `options.budget_ms`（默认 120s 维持、钳 600s）；慢站/50 步表单链可显式放宽 |
| **Y2** `enotfound/nxdomain` 在 NOT_FALLBACK_WORTHY 终止集 | 修 | `outcome.ts` 移出二词（DNS 瞬态可 fallback——真实 Chrome 走系统栈/DoH 解析路径不同）；连带同族三处：`fetch-url.ts outcomeFromFetchError` 全部 fetch 异常→unknown（ENOTFOUND/ECONNREFUSED 不再 didnt）、`BrowseChannel.classifyBrowseError` 的 `dns_or_nav_error` 家族与 enotfound/nxdomain→unknown（W1-DEF-5 的「不再假 worked」保留——只是从 didnt 改判 unknown）。`needs_manual_2fa/404/403` 终止集不动 |
| **Y3** expect 抛错→强制 failed→didnt | 修 | `StepEngine`：runExpect **自身抛错**（CDP 断连/页面销毁）与「后置条件为假」分离——`expect_check:"error"`（steps-types 联合类型扩展）+ 保留 partial 原 outcome + 终止 `unknown`；仅**显式 false** 判 didnt（INV-13 铁律原义：不虚报 worked——现在也不虚报「否」）。wait_timeout 路径本就 unknown，不动 |
| **Y4** `tcc_denied`→didnt 短路 desktop 降级链 | 修 | AX 的 Accessibility TCC ≠ AppleScript 的 Automation TCC ≠ cgEvent 的 Input Monitoring——三 provider（`AxProvider`/`AppleScriptProvider`/`ScreenshotVlmProvider`）的 `tcc_denied`/`tcc_screen_recording_denied` 移出 DIDNT 集→unknown 链继续；`app_not_found`/`invalid_params`/白名单注入类保留 didnt（跨档确定性/防注入红线） |
| **Y5** 短熔断 threshold=3 | **记录不动** | 60s 自动 half-open 自愈快、伤害有界；无实证伤害不预改（U 型曲线：过度约束同样更差） |

---

## 三、级联放大器专项验证（守卫互惩链逐条断开）

新增 `test/unit/misfit-cascade-regression.spec.ts`（8 用例，逐链构造失败风暴）：

| 级联链（enumerate §四） | 断言 | 结果 |
|---|---|---|
| 网络断 10min→长熔断 open→bag.disable→杀子进程 | 12 轮 DNS-unknown（结果路径 + throw 路径）→ 长熔断 closed、onOpen 零调用 | ✅ 断开 |
| （对照）429 真持续故障 | 10 轮（含短熔断 60s 快进真实时序）→ open + onOpen 每通道一次——**长熔断语义未拆除，只是不再误伤** | ✅ 保留 |
| probe 成功也不 enable（恢复断链） | open→快进 60min→probe 成功→onClose 被调（装配层条件 bag.enable 契约）；admin breaker_reset 条件恢复/不越权两路径 | ✅ 闭合 |
| spill 满 throw→executor 崩→unknown→双熔断计数→喂 F2 | 82×2MiB（164MiB > 64MiB cap）连续 spill **零 throw**，totalBytes 封顶 ≤cap，淘汰计数 >0 | ✅ 断开 |
| DNS 抖动→ssrf dns_failed→didnt 终答 | dns_failed→`unknown + ssrf_dns_unresolved`（可重试）；对照 private_ip/deny/userinfo/protocol→didnt（安全本体零弱化） | ✅ 断开 |
| 慢站 budget_exceeded→didnt→breaker 假健康 | budget_exceeded(unknown)→两熔断记 FAILURE（failureCount>0），不再 recordSuccess 掩蔽 | ✅ 断开 |
| caller-cap 拒绝污染熔断 | （P26 已验证 decider 前早退零接触——枚举官已核实，本次回归覆盖） | ✅ 维持 |

---

## 四、🟢 保留清单确认（19 项逐一复核，零改动）

| 机制 | 保留理由（复核后） |
|---|---|
| CallerTierTracker | P26 已修（默认 Infinity + opt-in + 计数保留）；本次补齐其遗留 3 个旧断言单测（cap=100→Infinity），28/28 绿 |
| RpmLimiter 默认 | defaultMax=Infinity，providers.ts 无 rpm_max 配置→全放行（种子 d 证实非错配） |
| PolicyGate cloud 双重解锁 | 真实成本边界 + 用户显式 opt-in |
| QuotaLedger markExhausted | 真实 429 语义，Retry-After 驱动；与长熔断正交（本次 F2 后边界更清晰：ledger 管 key 级短期，长熔断管 channel 级持续） |
| SSRF CIDR/userinfo/协议核心 | 安全守卫本体，零弱化（F1 只改 DNS 语义，分类器测试钉死 policy→didnt 不漂移） |
| HighRiskGate + ElicitationPort fail-closed | 2FA/高风险红线，豁免 |
| preview 4000/48KiB 分级 | token 经济合理（read_text 续页闭环 + 附录钉尾）；错配只在总量 cap，已由 F4 修 |
| Brave Retry-After 缺省 60s | 真实上游限流 |
| free_only 分级 / ResourceMonitor / Metrics 环 / SerpHealth / HitRateStats / SearchCache / StateStore LRU / RootRegistry / TabRegistry clamp / chrome idle reaper / CGEvent 红线 / http-serp 超时 unknown / 2FA 关键词探测（仅 status note） | 与枚举报 §三一致，逐项复核无新证据推翻 |

ℹ️ 备注（沿用枚举报）：2FA 关键词探测若未来升级为 outcome 判据，须先收紧为 URL/表单 selector 判据（当前仅 note 无害）。

---

## 五、交付物清单

**源码**（14 文件）：
- `src/ssrf/ssrf-guard.ts`（+ssrfDenial/isSsrfEnvTransientReason）
- `src/fallback/outcome.ts`（Y2 移词 + F2a isSustainedFailureError）
- `src/fallback/LongCircuitBreaker.ts`（喂入分类 + onClose）
- `src/fallback/FallbackDecider.ts`（error 透传长熔断）
- `src/fallback/BudgetTracker.ts`（MAX + clamp）
- `src/browse/StepEngine.ts`（F3 unknown + Y3 expect_error）
- `src/browse/steps-types.ts`（expect_check "error"）
- `src/channels/BrowseChannel.ts`（budget_ms 管道 + classifyBrowseError Y2 + wrapChainResult F4 降级）
- `src/util/output-envelope.ts`（LRU 淘汰 + touch + 计数）
- `src/tools/{browse,steel,browserbase,fetch-url,pdf,network,fetch-feed,screenshot,wayback}.ts`（F1 二分；pdf/network 另含 F4 二分）
- `src/tools/admin.ts`（breaker_reset 条件恢复）
- `src/index.ts`（onClose 接线）
- `src/types.ts`（BrowseOptions.budget_ms）
- `src/desktop/{AxProvider,AppleScriptProvider,ScreenshotVlmProvider}.ts`（Y4）

**测试**（16 文件改动/新增）：`misfit-cascade-regression.spec.ts`（新）、`ssrf-guard.spec.ts`、`fetch-url.spec.ts`、`outcome.spec.ts`、`long-circuit-breaker.spec.ts`、`budget-tracker.spec.ts`、`step-engine.spec.ts`、`browse-upstream-contract.spec.ts`、`browse-steps.spec.ts`、`output-envelope.spec.ts`、`desktop-act-4-tier.spec.ts`、`ax-backend-contract.spec.ts`、`desktop-ax-act.spec.ts`、`admin-breaker-reset.test.ts`、`CallerTierTracker.test.ts`（P26 遗留断言补齐）、`mocks/mock-rust-bridge.ts`（errorKind 注入支持）；另版本镜像三处随 1.18.2 同步（`doctor-v10-phase-cd` / `doctor-v17-integration` / `doctor-cli-config-file`——INV-63 的测试侧字面量）

**门禁**（v1.18.2，2026-08-19 终跑）：
- `npm run build` ✅
- `npm test` ✅ 141 文件 / 2364 passed / 1 skipped（全绿；content-second-hop 并发峰值断言曾在全量负载下偶发 flaky 一次，隔离 3/3 绿且终跑全量绿——与本次改动无关联面）
- `npm run check-invariants` ✅ 82/82

**版本**：package.json 1.18.1→1.18.2 + INV-63 三处真源同步（`src/index.ts LASSO_SERVER_VERSION`、`src/doctor/doctor.ts LASSO_VERSION`）+ 测试侧镜像三处（P26 注释已在树内自称 v1.18.2，本次对齐）。
