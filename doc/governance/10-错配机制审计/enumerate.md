# 29-错配机制审计 · 枚举官报告（enumerate.md）

日期：2026-08-19 · 范围：`src/` 全量白盒（v1.18.1 工作树，P26 已改 `DEFAULT_CALLER_CAP→Infinity` 未 commit）
范式定义（用户指令）：为不存在的威胁模型（多租户/远程/对抗性调用方）设计的守卫，在单用户本地 stdio MCP 的真实部署形态下惩罚正常业务。三子型：①无威胁模型的限额/锁 ②网络抖动/环境问题误分类为策略拦截（fail-closed 惩罚）③默认值从旧想象沿用未随现实校准。

枚举方法（已穷尽执行）：grep 全 src 四类范式——(A) 抛错/返 didnt 带 blocked/exceeded/forbidden/denied/timeout 词的分支；(B) setTimeout/窗口/上限常量（DEFAULT_*、*_MS、*_CAP、LIMIT、threshold）；(C)「防滥用/anti-gaming/防绕过/保守」注释；(D) fail-closed 默认。共 47 个文件命中，逐个白盒核对部署模型。种子 a-e 全核实，另发现种子外新机制（含失败风暴级联放大器）。

---

## 一、🔴 错配需修（4 项）

### F1. SSRF `dns_failed`/`dns_empty` → outcome=didnt（「策略拦截」语义）——种子 a 证实

- **锚点**：
  - 产生：`src/ssrf/ssrf-guard.ts:88-104` —— DNS 解析抛错 → `{allowed:false, reason:"dns_failed:..."}`；`records.length===0` → `dns_empty`。与 `private_ip`/`deny_range` 等真策略拒绝**共用同一返回形状**。
  - 消费（全部把 `!allowed` 一律映射成 `outcome:"didnt"` + `retrieval_method:"ssrf_blocked"`）：
    `src/tools/browse.ts:110-119`（ssrfBlocked()）、`fetch-url.ts:101-110`、`pdf.ts:129-132`、`network.ts:228-230`、`fetch-feed.ts:335-338`、`screenshot.ts:107-110`、`wayback.ts:131-134`、`steel.ts:83-86`、`browserbase.ts:86-89`。
  - 且 browse 工具的 SSRF 预检在 **decider 之前**（`browse.ts:204-207`）→ DNS 失败连 fallback 链（browse_headless→browse_logged_in）都不进，直接终答。
- **机制目的/设计的部署模型**：SSRF 守卫防的是对抗性调用方喂内网地址——SSRF CIDR 本体不在豁免之列、保留；但「DNS 解析不出来」在守卫语义里被当成「拒绝放行」的一种 reason，而它实际是**环境条件**（TUN 断网、DNS 间歇抖动、captive portal），不是策略判决。
- **单用户本地是否成立**：不成立。本地 stdio 无对抗调用方；DNS 抖动是用户自己的网络状态。
- **触发场景（实证）**：全量首跑 104 章，DNS 间歇失败 → 受影响 URL 返回 `ssrf_blocked:dns_failed:...` + `outcome:"didnt"` → CC 读到「政策拦截 + 明确否 + 不可重试」，既不重试也不换通道。didnt 语义在 `types.ts:19` 明写「语义否定（404/403/NXDOMAIN…明确否）」。
- **内部不自洽的证据**：`src/serp/http-serp.ts:242-243` 对同一守卫的 block 返回的是 `unknownResult(...)`（可重试语义）——同仓两套语义并存。
- **建议修法**：`SsrfCheckResult` 区分两类 reason——策略确定性 `{invalid_url, userinfo_present, protocol_not_allowed, deny_range, private_ip}` 维持 didnt；环境瞬态 `{dns_failed, dns_empty}` → `outcome:"unknown"` + `retrieval_method:"ssrf_dns_unresolved"`（isFallbackWorthy 天然放行 unknown），让 fallback 链与 CC 重试可介入。`ContentSecondHop.ts:343-347` 的 item 级折叠 `content_status:"fetch_failed"` 可不动（item 级观测，无损）。

### F2. 长熔断：1h 内 10 次任意 unknown → open 60min + `bag.disable` + 仅手工恢复——种子 c 证实，且是最大级联放大器

- **锚点**：
  - `src/fallback/LongCircuitBreaker.ts:35-52`（threshold=10 / windowMs=1h / resetMs=60min）、`:90-114` recordFailure **不分类失败成因**——DNS 断、超时、ECONNREFUSED、上游 5xx 一律计数。
  - `src/index.ts:1101-1131`：browse_headless / browse_logged_in / search.brave / desktop.* 全部接线；`onOpen → bag.disable`，经 onChange → `toolManager.disableChannel` + `subproc.shutdownOne`（**channel 子进程被杀**）。
  - 喂入点：`src/fallback/FallbackDecider.ts:247-252`（executor 抛错）与 `:315-316`（outcome=unknown）——**每次** unknown 都记长熔断失败。
  - 恢复断链：`LongCircuitBreaker.ts:19-22, 73-79` —— recordSuccess 关 breaker 但 **bag 仍 disabled**，需 admin `capability_enable` 显式恢复（`breaker_reset` 也只清状态不 enable，见 `CircuitBreaker.ts:76-85` 注释）。
- **机制目的/设计的部署模型**：文件头自述「持续故障 / **月配额耗尽**类」。月配额耗尽本已由 `QuotaLedger.markExhausted`（429 + Retry-After 专项）覆盖；长熔断实际捕获的是**用户自己的网络断连**——错配子型②。
- **单用户本地是否成立**：不成立。TUN/代理断 10 分钟（用户 MEMORY 实录场景）→ 10 次 unknown within 1h → browse_headless 先 open（其 fallback 对象 browse_logged_in 各自有独立 breaker，随后相继 open）→ 两通道全 disable + 子进程全杀 → 后续所有 browse 返回 `long_circuit_open` 跳过 → `fallback_exhausted`。网络恢复后仍需逐 channel 手工 `capability_enable`。
- **守卫互惩链（任务点名核查项）**：
  1. F4（spill 耗尽 throw）→ executor 抛错 → unknown → 长/短熔断双计数 → 本条 60min disable；
  2. 本条 open → bag.disable → `subproc.shutdownOne` 杀进程 → 60min 后 half-open probe 即使成功也只关 breaker，bag 仍 disabled——**守卫 A（breaker）调用守卫 B（bag），A 的恢复不联动 B 的恢复**，惩罚被二次放大；
  3. caller-cap 拒绝已验证**不**污染熔断（`browse.ts:200-202` / `search.ts:243-252` 在 decider 前早退，零 breaker 接触）——P26 后该链已断。
- **建议修法**（三选一或组合，按侵入度递增）：
  a. 喂入分类：长熔断只吃 provider 类失败（429/quota，即 ledger markExhausted 联动），网络类（DNS/timeout/ECONNREFUSED）只进短熔断（60s 自愈）——最小改动，语义对齐文件头自述；
  b. onOpen 降级为 logger.warn + doctor 可见（不 bag.disable、不杀进程），bag 联动改 opt-in；
  c. 至少修恢复断链：half-open probe 成功 → recordSuccess 时同步 `bag.enable`（或 breaker_reset 联动 enable），消除「网络恢复后仍禁 1h+手工」。

### F3. `budget_exceeded` → chain outcome=didnt（自限被当语义否定）+ 预算不可配置——种子 b 证实（语义半）

- **锚点**：
  - `src/browse/StepEngine.ts:133-139`：budget 耗尽 → `stop("budget_exceeded", ...)`；`stop()` 默认 `chainOutcome="didnt"`（`:318-321`，状态表 `:29` 同）。
  - `src/fallback/BudgetTracker.ts:35`（DEFAULT_CHAIN_BUDGET_MS=120_000）；`src/channels/BrowseChannel.ts:480` `new BudgetTracker()` —— **每 chain 写死默认，browseSchema 无 budget_ms 入参**，调用方无法为合法长任务放宽。
- **机制目的/设计的部署模型**：「给 CC 一个确定性边界：chain 不会无限烧时间」（BudgetTracker 头注）。边界本身合理（🟢），错在**终止语义**：自己设的闹钟响了被报告成「内容不存在（明确否）」。
- **单用户本地是否成立**：不成立。慢站/长 SPA 渲染/多步表单是正常业务，120s 自限是自身策略，不是页面的语义否定。
- **触发场景**：慢站多步 chain 累计 >120s → `budget_exceeded` + outcome=didnt → FallbackDecider `:302-312` 视 didnt 为「channel 健康、答案为否」→ **breaker.recordSuccess（双熔断都记健康）** → 终答 CC「没有」。方向双重错：调用方被告知不可重试的「否」；熔断被喂假健康信号（诊断被掩）。
- **建议修法**：`budget_exceeded` → `chainOutcome:"unknown"`（自限=瞬态，可重试，让 decider 试下一 channel、CC 可拆步重试）；同时 browse options 增加可选 `budget_ms`（钳制上限如 10min）让合法长链可显式放宽。120s 默认值本身见 Y1。

### F4. 【种子外·新发现】输出 spill 仓：零淘汰 + 64MiB 总 cap → 直接 throw（长会话炸弹 + F2 级联源）

- **锚点**：
  - `src/util/output-envelope.ts:36-37`（STORE_CAP_BYTES=64MiB）、`:45-48` 注释自认「v0.3 简单实现：**暂不淘汰**，只在总量超 cap 时拒绝新 spill」——**没有任何淘汰/释放路径**（read_text 不删，无 evict API，totalBytes 单调递增）。
  - `:158-165` `spillToDisk`：`totalBytes >= STORE_CAP_BYTES` → **throw** `output store exhausted`。
  - **未捕获路径**（tool 直接抛错）：`BrowseChannel.ts:518`（wrapChainResult 裸调）、`fetch-url.ts:293`（裸调）。
  - **误分类路径**（捕获但判 didnt）：`pdf.ts:184-197`、`network.ts:302-315` —— catch 后 `outcome:"didnt"` + `envelope_cap_exceeded`，把「PDF/资源列表**已成功抓到**、只是投递信封耗尽」报告成「明确否」。
- **机制目的/设计的部署模型**：磁盘防炸（16MiB 单条 + 64MiB 总量），injaneity 借鉴源有淘汰，这里砍掉了淘汰只留 cap——为偶发异常数据设计的硬闸。
- **单用户本地是否成立**：部分。防炸合理；但 MCP server 是**长命进程**（单用户连开数天），64MiB 累计≈1365 个 >48KiB 的 spill（PDF 是 base64，膨胀 1.33×，全量批次场景一天可撞）——撞后**所有**大输出永久失败直至重启（重启才清内存计数）。
- **触发场景**：长会话累计 spill ≥64MiB → browse chain 大结果 → applyOutputEnvelope throw → decider 视 executor 抛错为 unknown → **短+长熔断双 recordFailure** → 10 次即触发 F2 的 60min disable + 手工恢复。pdf/network 路径则静默变「内容为否」。一次资源泄漏式故障升级成通道级封禁。
- **建议修法**：兑现注释承诺的淘汰——超 STORE_CAP 时按插入序淘汰最老 ref（同步删文件）再写；无法淘汰时**降级不抛**（返回 preview-only envelope + refine_hint「spill store full」）；把「单条 >16MiB」（数据异常，可保留 didnt/throw）与「总量耗尽」（会话状态，必须自愈）区分。单条 cap 路径 pdf/network 现行 catch 可保留，但 error 前缀应区分 `single_cap` vs `store_exhausted`。

---

## 二、🟡 默认值待校准（5 项）

### Y1. `DEFAULT_CHAIN_BUDGET_MS=120_000` 不可覆盖
锚点 `BudgetTracker.ts:35` + `BrowseChannel.ts:480`。F3 修语义后，合法长链仍撞默认。建议：browse options 增 `budget_ms`（默认 120s 维持，钳制上限 600s）。触发场景：50 步表单链 × 平均 3s/步 = 150s > 120s。

### Y2. `NOT_FALLBACK_WORTHY_PATTERNS` 把 `enotfound`/`nxdomain` 判为链终止
锚点 `src/fallback/outcome.ts:104-120`。DNS 错在代理/TUN 环境高频瞬态（用户 MEMORY：fake-ip 拦 SSH/DNS 实录）；现行语义让 browse_headless 的 DNS 失败**直接终止**链、不再试 browse_logged_in（Chrome 走系统栈/DoH，解析路径不同，可能成功）。建议：把 `enotfound`/`nxdomain` 移出终止集（下一 channel 成本极低，单用户无滥用面）；或至少 browse 家族如此。与 F1 同族（DNS 误判确定性）。

### Y3. expect 校验抛错 → 强制 "failed" → didnt
锚点 `src/browse/StepEngine.ts:211-235`（注释自举反例「client 断开」）。INV-13「宁可不假装成功」论证的是不虚报 worked；把**基础设施异常**（CDP 断连/页面销毁）也判成「后置条件为假」的语义否定，与 F3 同病。建议：runExpect 抛错（非 wait_timeout——那条 `BrowseChannel.ts:1144-1151` 已正确落 unknown）→ verdict 保留 partial 原 outcome + 终止为 unknown，仅显式 false 判 didnt。

### Y4. `tcc_denied` → didnt 短路 desktop 降级链
锚点 `src/desktop/AxProvider.ts:24-70`、`AppleScriptProvider.ts:38`。AX 的 Accessibility TCC 与 AppleScript 的 Automation TCC 是**两份不同权限**；ax 被拒 ≠ appleScript 被拒，didnt 却让 FallbackDecider 立即短路（`FallbackDecider.ts:302-312`），永不试下一档。建议：tcc_denied → unknown（链继续），或 error_kind 细分 per-permission。

### Y5. 短熔断 threshold=3 连续失败（低优先级）
锚点 `src/fallback/CircuitBreaker.ts:21-24`。browse_headless 冷启动探针 ~1s（`index.ts:610` 注释），3 次毛刺即 open 60s。60s 自动 half-open 自愈快，伤害有限——记录待校准，不强制改。

---

## 三、🟢 合理保留（已逐个核对部署模型）

| 机制 | 锚点 | 保留理由 |
|---|---|---|
| CallerTierTracker 默认 cap | `runtime/CallerTierTracker.ts:92` | P26 已修（Infinity + opt-in + 计数保留）；cap 拒绝在 decider 前早退，**已验证不污染熔断** |
| RpmLimiter 默认 | `util/rpm-limiter.ts:61` | defaultMax=Infinity；providers.ts 现无任何 rpm_max 配置 → 全放行。种子 d 证实**非**错配 |
| PolicyGate cloud 双重解锁 | `fallback/PolicyGate.ts:113-170` | 真实成本/政策边界 + 用户显式 opt-in（LASSO_ALLOW_CLOUD_BROWSER + key），非想象威胁 |
| QuotaLedger markExhausted | `config/quota-ledger.ts:104-127` | 真实 provider 429 语义，Retry-After 驱动，remaining/exhausted 双轨正交（好设计） |
| SSRF CIDR/userinfo/协议核心 | `ssrf/ssrf-guard.ts:60-125` | 安全守卫本体，不在豁免反向之列（审计的是 dns_failed 语义，非本体） |
| HighRiskGate + ElicitationPort fail-closed | `browse/HighRiskGate.ts:35,208`、`interact/ElicitationPort.ts:156` | 2FA/高风险红线，豁免；且 elicitation 已 opt-in 化（v1.17），port 异常 fail-closed 是安全方向正确 |
| preview 4000/48KiB spill | `browse/BrowseChannel.ts:101,1247-1262`、`util/output-envelope.ts:32-35` | 种子 e 证实为合理 token 经济：有 read_text 续页闭环（v1.8 已装配，index.ts:113-115）、附录钉尾防 ref 不可达。错配仅在总量 cap（F4），不在分级本身 |
| Brave Retry-After 缺省 60s | `channels/BraveChannel.ts:179-184` | 真实上游限流，保守合理 |
| free_only 分级过滤 | `search/FreeTierRouter.ts` | 用户 opt-in（args/env），空结果诚实返回 free_only_filtered |
| ResourceMonitor | `observ/ResourceMonitor.ts` | warn-only、不 kill、旁路采样 |
| MetricsCollector(128 环)/SerpHealthMonitor/HitRateStats | observ/、serp/ | 纯观测，不阻塞主路径（INV-45 不自动重写 selector） |
| SearchCache TTL 7d+LRU 1000 | `search/SearchCache.ts` | 缓存正确性；TTL×freshness 已耦合修复（ZB-3） |
| StateStore LRU 128 | `util/state-store.ts:82` | 有 spillPath 磁盘 fallback，内存逐出非硬失败 |
| RootRegistry 256/30min | `forest/RootRegistry.ts:41-44` | lookup/dispatch 刷新 lastTouchedAt，活跃 root 永不过期 |
| TabRegistry cap clamp 20 | `logged-in/TabRegistry.ts:42` | 防 LLM 误配过大的输入卫生钳制；淘汰侧保守 no-op（失败方向良性） |
| chrome idle reaper | `launcher/chrome-idle-reaper.ts:132-136` | visible Chrome 永不进 stopFn（N4 红线）；autoHide opt-in 默认 off |
| CGEvent raw-keycode 禁止 / AppleScript 白名单 / stealth 顶级 const | CGEventProvider.ts:31 等 | INV-28/30 安全红线，豁免 |
| http-serp 5s 超时→unknown | `serp/http-serp.ts:221,242-243` | 超时落 unknown 可重试，方向正确（且是 F1 修法的仓内参照） |
| 2FA 关键词探测 | `channels/LoggedInChannel.ts:44-52,467-509` | 仅 status().note，**不入 outcome**；今日无害。ℹ️ 备注：全文 grep「verification code」等词假阳性面大，若未来升级为 outcome 判据须先收紧为 URL/表单 selector 判据 |

---

## 四、级联放大器总图（守卫互惩链）

```
网络断 10min ──(每次 unknown)──► 长熔断×2 通道 open ──► bag.disable ──► 杀子进程
                                  │                        │
                                  ▼                        ▼
                            60min half-open          probe 成功也不 enable
                            （breaker 恢复）         （须 admin capability_enable）
                                                     ←—— 恢复断链（F2 核心）

spill 仓 64MiB 满 ──throw──► executor 抛错=unknown ──► 双熔断计数 ──► 喂 F2
                  └─(pdf/network catch)─► didnt「内容为否」（F4 误分类）

DNS 抖动 ──► ssrf dns_failed ──► didnt 终答（不重试/不 fallback/零观测）(F1)
         └─► enotfound 命中终止集 ──► 链终止 (Y2)

慢站 chain ──► budget_exceeded ──► didnt ──► breaker 记「健康」（反向掩蔽）(F3)
```

已验证无级联：caller-cap 拒绝（P26 后）在 handler 入口早退，零 breaker 接触。

## 五、修法优先序建议

1. **F2**（伤害最大：60min+手工恢复+杀进程，网络抖动即触发）——最小改：喂入分类（a）+ 恢复断链（c）。
2. **F1**（伤害面最广：9 个工具的 DNS 误判终答；104 章实证）。
3. **F4**（长会话定时炸弹 + F2 级联源）。
4. **F3+Y1**（同一次改：语义 + budget_ms 入参）。
5. Y2/Y3/Y4 随批；Y5 记录不动。
