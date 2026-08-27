# parse10 v0.9 Phase B 验收清单

> 本文件由 v0.9 Phase B 实施产出（2026-07-22），对照 parse10 §6 验收标准 + §1 「search ≈永不失败」边界表 7 场景 tri-state 分类。
>
> Phase B 范围：search engine="fallback_chain" opt-in 接入 + index 装配 + version 0.9.0 + 集成测 + 验收。
> Phase A（前置）已完成：BingChannel + FallbackChain + wayback tool + RecordingStore + INV-54..59（详见各模块源码注释）。

## 0. CI 全绿基线

| 项 | 数字 | 说明 |
|---|---|---|
| `npm run build`（tsc） | PASS | 零 TS 错误 |
| `npm test`（vitest） | **1271 pass / 1 skip**（71 文件） | v0.8 基线 1260 + Phase B 新增 11 |
| `npm run check-invariants` | **59 / 59** | v0.8 的 INV-1..53 全保 + Phase A 新增 INV-54..59 |
| Rust helper | **零改**（144 tests 保持绿） | 守铁律「rust-helper/ 不动」 |
| Version 三处对齐 | **0.9.0-dev** | `package.json` / `src/index.ts:LASSO_SERVER_VERSION` / `src/doctor/doctor.ts:LASSO_VERSION` |

**零回归确认（parse10 §1 决策 4）**：
- `engine="auto"` 默认路径完全 byte-identical v0.8（MultiSourceFanout 多源扇出 + browse_headless cross_modal 兜底）。
- 新增 `engine="fallback_chain"` 是**显式 opt-in**，不动 `engine="auto"` / `"zhipu"` / `"brave"` 任一行代码。
- v0.8 的 1260 个测试 + 53 条 INV 全保绿，未改 1 行。

---

## 1. parse10 §6 验收逐条状态（V1-V10 CI + M1-M3 手测）

### CI 验收（V1-V10）

| ID | 验收点 | 状态 | 证据 |
|---|---|---|---|
| **V1** | `engine="fallback_chain"` 显式 opt-in 编译通过 + zhipu worked 路径不触发 fallback | ✅ PASS | `test/integration/search-fallback-chain.test.ts::V1` —— 直调 `runFallbackChainEngine`，zhipu worked → `served_by=search.zhipu` + `fallback_used=false` + brave/bing/browse 未被调 |
| **V2** | zhipu unknown → brave worked（fallback_used=true） | ✅ PASS | `::V2` —— 429 触发 brave 升档；审计链 `["search.zhipu","search.brave"]` |
| **V3** | zhipu + brave unknown → bing worked（fallback_used=true） | ✅ PASS | `::V3` —— 审计链 `[zhipu, brave, bing]`；bing 作第三源兜底 |
| **V4** | 全源 + browse_headless 全熔断 → tri-state didnt（诚实不伪造） | ✅ PASS | `::V4b` —— `outcome=didnt` + `retrieval_method=fallback_exhausted` + 完整审计链 4 channel；**未注入 recordingStore** 验回放不伪造 |
| **V4a** | 全 API 源 unknown → browse_headless SERP scrape 兜底 worked | ✅ PASS | `::V4a` —— baidu SERP 抽出 URL → `served_by=browse_headless` + `engine=baidu_serp` |
| **V4c** | 全源熔断 + RecordingStore 命中过去录制的 fixture → `served_by=recording_replay` | ✅ PASS | `::V4c` —— 预录 fixture → replay 命中 + 审计链保留原 fallback 全熔断 |
| **V4d** | 全源熔断 + recordingStore 未命中 → 仍返 didnt（不伪造） | ✅ PASS | `::V4d` —— 空 fixture 库 → `outcome=didnt` + `served_by != recording_replay` |
| **V5** | `engine="fallback_chain"` + `bing=null`（BING_API_KEYS 未配）→ 链缩短为 zhipu→brave→browse_headless | ✅ PASS | `test/integration/search-fallback-chain.test.ts > Bing key=[] 时跳过` —— bing 兜底层不存在；行为等价 v0.8 fallback 链 + 多一档 headless |
| **V6** | `free_only=L1` 过滤掉所有 search provider → channelOrder 仅含 browse_headless → 全熔断返 didnt | ✅ PASS | `::free_only=L1 排除所有 search provider` —— 三源 search 都未被调；browse_headless 被调（cross_modal 兜底不受 free_only 影响） |
| **V7** | `LASSO_RECORD_SEARCH=true` 时 worked → `saveIfRecording` fire-and-forget 落盘（INV-59） | ✅ PASS | `> 录制 + 回放语义 > worked 时若 LASSO_RECORD_SEARCH=true` —— 显式 `enabledOverride=true` + 50ms 等 fire-and-forget → fixture 落盘验证 |
| **V8** | `LASSO_RECORD_SEARCH` 默认 OFF → `saveIfRecording` 不落盘（INV-57） | ✅ PASS | `> 默认 OFF → 不落盘` —— 测试 env 默认未设 LASSO_RECORD_SEARCH → `isEnabled()=false` → `has()`=false |
| **V9** | INV-54..59 全部通过（59/59） | ✅ PASS | `npm run check-invariants` 全绿；Phase A 已建 + Phase B 不破坏 |
| **V10** | engine="auto" 默认 byte-identical v0.8（零回归） | ✅ PASS | 70 个 v0.8 测试文件 + Phase A 全绿（1260 v0.8/Phase A tests + 11 Phase B 新增 = 1271） |

### 手测（M1-M3，需真实 API key + 网络）

> 未在 CI 自动跑；本节给出**可复现的手测步骤** + 预期输出，便于发版前人工核对。

#### M1 — Bing 真 key search（验证 BingChannel 真协议层）

**前置**：
1. 申请 Azure Bing Web Search v7 F0 免费层 key（或付费 S0 key）。
2. `export BING_API_KEYS="<your-key>"`（多 key 用 CSV）。
3. `npm run build`。

**步骤**：
```bash
# 启动 lasso-mcp server（CC 自动连）
node dist/index.js

# 在 CC 里直接调（或用 MCP inspector）
# 1. 单源 bing 直调（用 search engine=fallback_chain + 让 zhipu/brave 故意失败）
ZHIPU_API_KEY="" node dist/index.js doctor  # 期望 brave/bing 都 wired
```

**预期**：
- `doctor` 报告 `brave_channel_wired` + `bing_channel_wired` 都出现（log JSON 行）。
- search 调用 `engine="fallback_chain"` 时，zhipu unavailable → brave unavailable → bing worked。
- `result.served_by="search.bing"` + `result.data.engine="bing"` + `result.data.results[0].source` 是 host（如 `tokio.rs`）。

**失败排查**：
- `bing_channel_skipped: no_keys_or_endpoint` → 检查 `BING_API_KEYS` env 是否真的注入了（print env）。
- bing 429 → Azure F0 配额（1000 req/月）已耗尽，换 key 或等下月。

#### M2 — 三源真降级（模拟限流验证 fallback 链）

**前置**：
1. 三源 key 都配：`ZHIPU_API_KEY` / `BRAVE_API_KEYS` / `BING_API_KEYS`。
2. 用 admin tool 临时 disable zhipu + brave：`lasso-mcp admin capability_disable name="search.zhipu" reason="manual_test"` + `capability_disable name="search.brave" reason="manual_test"`。

**步骤**：
```bash
node dist/index.js
# 在 CC 里调：
# search(query="rust tokio", engine="fallback_chain")
```

**预期**：
- CapabilityBag 跳过 disabled 的 zhipu/brave（bag.onChange → FallbackDecider 内 breaker 视为 circuit_open）。
- 直接落到 bing：`result.served_by="search.bing"` + `result.actions_and_results` 审计链含 `search.zhipu(circuit_open)` + `search.brave(circuit_open)` + `search.bing(worked)`。

**降级到 M1**：若 Bing F0 不可用（parse10 §4 已记录此风险），M2 至少验 brave disable → bing 兜底（三源变两源）；或 zhipu+bing disable → brave 兜底。

#### M3 — Wayback 真死链救援

**前置**：无需 key（archive.org availability API 是公开 GET）。

**步骤**：
```bash
node dist/index.js
# 在 CC 里调：
# wayback_lookup(url="https://this-domain-does-not-exist-12345.com/")
```

**预期**：
- archive.org availability API 返回 `archived_snapshots: {}` 或无 closest。
- `result.outcome="worked"` + `result.data.archived=false` + `result.data.error="no_snapshot_available"`。
- 然后试一个**真实存在的 archive** URL（如 `https://example.com/`）：`result.data.archived=true` + `result.data.snapshot_url` 形如 `http://web.archive.org/web/20240101000000/http://example.com`。
- 二次调 `fetch_url(url=result.data.snapshot_url)` 应返 worked + archived 页面内容。

**SSRF 守门验证**：
- `wayback_lookup(url="http://127.0.0.1:9222/json")` → `outcome="didnt"` + `error="ssrf_blocked:..."`（INV-56）。
- `wayback_lookup(url="http://192.168.1.1/")` → 同样 ssrf_blocked。

#### M3-补充 — 录制回放真测

**前置**：
1. `export LASSO_RECORD_SEARCH=true`（INV-57 显式 opt-in）。
2. `node dist/index.js` 启动。

**步骤**：
1. 调 `search(query="important query", engine="fallback_chain")` → 某 source worked → fixture 落盘 `~/.cache/lasso/search-recordings/<sha1[0:2]>/<sha1>.html`。
2. 关闭 server，unset 三源 key 让全源熔断：`unset ZHIPU_API_KEY BRAVE_API_KEYS BING_API_KEYS`。
3. 重启 server（`LASSO_RECORD_SEARCH` 可不设 —— 回放与录制开关独立）。
4. 调 `search(query="important query", engine="fallback_chain")`。

**预期**：
- 三源 + browse_headless 都不可用 → fallback_exhausted。
- RecordingStore.replay 命中 step 1 录制的 fixture → `result.served_by="recording_replay"` + `result.retrieval_method="recording_replay"`。
- `result.actions_and_results` 完整保留原 fallback 全熔断审计链。

---

## 2. parse10 §1 「search ≈永不失败」边界表 7 场景 tri-state 分类

> 「search ≈永不失败」是**目标非绝对**：全源熔断 + 全网断时仍**诚实**返 tri-state didnt（不伪造结果）。

| # | 场景 | 期望 outcome | 期望 served_by / retrieval_method | 实施状态 |
|---|---|---|---|---|
| **S1** | zhipu worked | `worked` | `search.zhipu` / `zhipu_api` | ✅ V1 验证 |
| **S2** | zhipu unknown（429/timeout/empty）→ brave worked | `worked` | `search.brave` / `brave_api`（`fallback_used=true`） | ✅ V2 验证 |
| **S3** | zhipu + brave 全 unknown → bing worked | `worked` | `search.bing` / `bing_api`（`fallback_used=true`） | ✅ V3 验证 |
| **S4** | 三 API 源全 unknown → browse_headless SERP scrape 抽到 URL | `worked` | `browse_headless` / `serp_scrape_baidu`（`fallback_used=true`，cross_modal） | ✅ V4a 验证 |
| **S5** | 三源 + browse_headless 全熔断 + recordingStore 命中过去 fixture | `worked` | `recording_replay` / `recording_replay`（最后兜底档；审计链保留原 fallback_exhausted） | ✅ V4c 验证 |
| **S6** | 三源 + browse_headless 全熔断 + recordingStore **未**注入或未命中 | `didnt` | `browse_headless` / `fallback_exhausted`（**诚实**不伪造；tri-state red signal） | ✅ V4b + V4d 验证 |
| **S7** | 全网断（DNS fail / TCP timeout）| `didnt` | `browse_headless` / `fallback_exhausted`（与 S6 同语义；M3-补充手测可模拟） | ✅ 设计覆盖（FallbackDecider.runWithFallback 所有 channel 抛异常 → fallback_exhausted） |

**tri-state 红线（parse10 §1 + §3）**：
- `worked` → 立即返回真实数据（任何源 worked 即返回）。
- `didnt` → 诚实「我们试了所有源，都没结果」（不伪造；S6/S7 落此档）。
- `unknown` → 跨档信号（某源 transient failure，FallbackDecider 内部用，不直接返 caller）。

---

## 3. 关键设计决策落地确认（parse10 §1 决策 1-6）

| 决策 | parse10 立场 | Phase B 实施确认 |
|---|---|---|
| **决策 1** Bing 第三源：独立 `BingChannel` class，不抽 `OpenSearchChannel` | 保两独立 class，代码相似度容忍 | ✅ Phase A 已交付 `src/channels/BingChannel.ts`（独立 class + Ocp-Apim-Subscription-Key 认证 + webPages.value 解析） |
| **决策 2** 三层 fallback 不开第二套串行 fallback 引擎（INV-55） | FallbackChain 是 plan 构造器，仍走 `FallbackDecider.runWithFallback` | ✅ `src/search/FallbackChain.ts::runFallbackChain` 只调一次 `decider.runWithFallback`；INV-55 grep 守；本 Phase B `tools/search.ts::runFallbackChainEngine` 同样不在自造循环里调 executor |
| **决策 3** wayback 死链救援是独立 tool（INV-58） | 不自动探测 search result 死链；CC 显式调 | ✅ `src/tools/wayback.ts::registerWaybackTool` 注册独立 tool；INV-58 grep 验 `search.ts` + `MultiSourceFanout.ts` 都不调 wayback |
| **决策 4** 不替换 fanout 默认（零回归） | `engine="fallback_chain"` 显式 opt-in；`engine="auto"` 默认 byte-identical v0.8 | ✅ `tools/search.ts` 加 `else if (engine === "fallback_chain")` 早返分支；`canFanout` + 单源路径完全保留；v0.8 的 1260 tests 全绿 |
| **决策 5** 录制回放默认 OFF（INV-57） | `LASSO_RECORD_SEARCH=true` 才录；replay 是最后兜底档 | ✅ `RecordingStore.isRecordingEnabled` 读 env 默认 OFF；`saveIfRecording` 内部检查；V7/V8 测试覆盖 |
| **决策 6** Bing key 可选：key=[] 时 ProviderRegistry 跳过 Bing | Azure F0 免费层不强依赖（graceful degrade） | ✅ `config/config.ts` 解析 `BING_API_KEYS` → keys=[] 时**不**加进 providers map（保 `byCap("search")` 不含 bing → 等价 v0.8）；V5 测试 bing=null 路径 |

---

## 4. Phase B 交付清单

### 新增（v0.9 Phase B）

| 文件 | 行数 | 说明 |
|---|---|---|
| `test/integration/search-fallback-chain.test.ts` | ~530 | 11 个集成测（V1-V4d + Bing key=[] + free_only + 录制/回放语义） |

### 修改（v0.9 Phase B）

| 文件 | 改动 |
|---|---|
| `src/tools/search.ts` | engine enum 加 `fallback_chain`；新增 `runFallbackChainEngine` helper（plan 构造 + FallbackChain 调用 + RecordingStore 录制/回放）；registerSearchTool 加 2 可选参 `bing` + `recordingStore` |
| `src/tools/descriptions.ts` | `SEARCH_DESCRIPTION` 扩 fallback_chain engine 说明；新增 `WAYBACK_DESCRIPTION` |
| `src/tools/annotations.ts` | 新增 `waybackAnnotations`（readOnly=true, openWorld=true） |
| `src/tools/wayback.ts` | 改用 `WAYBACK_DESCRIPTION` + `waybackAnnotations`（去除内联字面量） |
| `src/config/config.ts` | 解析 `BING_API_KEYS` env；keys=[] 时不加进 providers map（零回归守） |
| `src/index.ts` | BingChannel 条件装配（key=[] 时 bing=undefined）+ RecordingStore 实例化 + `registerWaybackTool` + 三处 `search.bing` 入 breaker/longBreaker/initialCapabilities + version bump |
| `src/doctor/doctor.ts` | `LASSO_VERSION = "0.9.0-dev"` |
| `package.json` | `"version": "0.9.0-dev"` |

### 零改（铁律守）

- `rust-helper/` —— 零改（144 Rust tests 保绿）
- `src/channels/SearchChannel.ts` / `BraveChannel.ts` —— 零改（Phase A 已交付 `BingChannel.ts`）
- `src/fallback/FallbackDecider.ts` —— 零改（FallbackChain 复用单一引擎）
- `src/serp/extract.ts` / `SerpHealthMonitor.ts` —— 零改（fallback_chain 不叠 SerpHealth hook）
- v0.8 的 53 个 INV + 1260 tests 全部保绿

---

## 5. 偏离 parse10 的决策及理由

**无偏离。** Phase B 严格按 parse10 §3 + §6 + §1 决策 1-6 实施。

具体核对：
- 「FallbackChain（注入 channel map）」（task 步骤 5 原话）：parse10 §3.2 把 FallbackChain 设计为**纯函数 plan 构造器**（非 class），「channel map」概念在 `tools/search.ts::runFallbackChainEngine` 的 executor 闭包内实现（`channelName → channel.search` 映射）。这是 Phase A 既定设计，Phase B 不偏离。
- Bing market code 映射：parse10 §3.1 没显式钉死 region→market 映射；本实施按 `region === "cn" ? "zh-CN" : "en-US"`（与 Brave 的 `region === "cn" ? "CN" : "US"` 同风格），是合理默认，可在 v0.9.1 调整。
- `serpHealth` 不传 fallback_chain 路径：parse10 §3 没要求 fallback_chain 叠 SerpHealth hook；本实施在 `runFallbackChainEngine` 内 `serpScrapeFallback(query, limit, browseHeadlessExec, null)` 显式传 null（fallback_chain 是 caller-tier 显式 opt-in，不再叠加 SERP 计数；守简单性 02 §5）。

---

## 6. 后续（v0.9.1+ / v1.0 推迟项）

| 项 | 状态 | 推迟到 |
|---|---|---|
| Bing market 多 region 支持（jp-JP / ko-KR / ...） | 简化 en-US/zh-CN 双档 | v0.9.1（按需） |
| search-recordings GC（避免盘满） | RecordingStore 当前无 GC | v1.0（与 cache GC 一并） |
| fallback_chain 多源真 A/B benchmark（与 auto fanout 比 latency/quality） | 未跑 | v1.0（benchmark runner 扩） |
| Bing Azure F0 免费层对新订阅可用性实测 | 基于既有知识（parse10 §4 已记录） | 用户配 key 后手测 M1 验证 |
| recording replay freshness 检查（过期 fixture 视为 miss） | 当前无 TTL | v1.0（与 SearchCache 7 天 TTL 对齐） |

---

**生成**：2026-07-22 Phase B 实施完成
**对照**：parse10.md §1 + §3 + §6
**测试基线**：build PASS / 1271 tests + 1 skip / 59 invariants 全绿 / version 0.9.0-dev 三处对齐
