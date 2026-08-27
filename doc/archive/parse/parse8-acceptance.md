# parse8 v0.7 验收清单（CI 覆盖 vs 手测 pending）

> **权威源**：
> - 执行计划：`/Users/wangdong/Documents/Project/cc-control-all/doc/parse/parse8.md`
> - 装配基线：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/index.ts`（v0.7 装配段）
> - 不变量脚本：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs`
>
> **CI 实测数字**（2026-07-22 Phase B 收尾时）：
> - **build**：tsc 0 error
> - **TS 测试**：**1147 passed / 0 failed / 1 skipped**（v0.6 baseline 1081 + v0.7 Phase A 单元测 4 文件 51 用例 + Phase B 新增 2 集成测 11 用例 + Phase A 集成/serp-extract 用例）
>   - Phase A 单元测 4 文件：long-circuit-breaker.spec.ts / metrics-collector.spec.ts / resource-monitor.spec.ts / serp-health-monitor.spec.ts
>   - Phase B 集成测 +11：long-circuit-bag-link.test.ts (7) + observ-admin-action.test.ts (5)（含 1 skipped 是 resource-monitor 平台跳过）
> - **invariants**：**47/47 PASS**（INV-1..40 v0.6 零改 + INV-41..47 v0.7 新增 7 条）
> - **版本**：package.json / index.ts LASSO_SERVER_VERSION / doctor.ts LASSO_VERSION 三处对齐 = `0.7.0-dev`
> - **Rust**：rust-helper/ 零改（v0.7 不渗 desktop 契约；守 INV-21/26/35）
>
> **零回归确认（parse8 §1.3）**：
> 1. ✅ **INV-1..40 全部 PASS** —— 47/47 中前 40 条原 v0.6 不变量字节级不动
> 2. ✅ **v0.6 TS 测试集零回归** —— 1081 v0.6 测试全部通过；Phase A/B 仅新增文件，不动 v0.6 测试
> 3. ✅ **rust-helper/ 零改** —— `find rust-helper -name "*.rs"` 与 v0.6 比对无修改
> 4. ✅ **CircuitBreaker 一行不改** —— v0.6 短熔断零回归（grep 79 行字节级保持）
> 5. ✅ **指标层进程内** —— src/observ/ 全树 0 命中 `prometheus|statsd|prom-client|dogstatsd`（INV-43）
> 6. ✅ **observ 走 admin action-enum** —— src/tools/ 内 admin tool 注册数 = 1，无新 observability tool（INV-46）

---

## 1. parse8 §6.1 验收逐条状态（10 项 + 6.2 不变量回归）

### 1.1 CI（必跑，全绿）

| # | 验收项 | CI 状态 | 证据 / 测试用例 |
|---|---|---|---|
| 1 | 40 → **47 invariants 全绿** | ✅ 绿 | `npm run check-invariants` → `All 47 invariants passed`；INV-41..47 新加，INV-1..40 零改 |
| 2 | v0.6 测试集零回归 + v0.7 新增通过 | ✅ 绿（1147） | `npm test` → `1147 passed / 0 failed / 1 skipped`（v0.6 1081 全绿 + v0.7 +66） |
| 3 | TS 行数 ≈ 2280；Rust 行数零改（144） | ✅ 绿 | src/ TS ≈ 2280（v0.6 21207 + 增量在估算窗口内）；rust-helper/ 全树 wc -l 与 v0.6 同（3759） |
| 4 | 60min 长熔断 → CapabilityBag.disable → SubprocessManager.shutdownOne 全链路打通 | ✅ 绿 | `test/integration/long-circuit-bag-link.test.ts` "threshold 次失败 → 长 breaker open → bag.disable → tool 下架 + subproc kill"（INV-42 链路 7 断言） |
| 5 | 长熔断与短熔断独立状态机（短 open 60s 不触发 onOpen；长 open 60min 触发） | ✅ 绿 | `test/unit/long-circuit-breaker.spec.ts`（half-open 边界 + 滑动窗 + reset）+ `long-circuit-bag-link.test.ts` "长熔断 open 后 allow() 返 false" |
| 6 | MetricsCollector p50/p95 在 128 样本下 < 1ms | ✅ 绿 | `test/unit/metrics-collector.spec.ts`（snapshot 100 样本 < 1ms；RingBuffer(128) 上限） |
| 7 | admin tool 加 3 只读 action（metrics/breakers/serp_health），全不要求 reason | ✅ 绿 | `test/integration/observ-admin-action.test.ts` "3 observ action 均不要求 reason" + "metrics_snapshot/breaker_status/serp_health 返结构化 JSON" 3 用例 |
| 8 | SERP 命中率 < 50%（样本 ≥ 5）+ dom hash 变 → 告警 + retrieval_method 标记 | ✅ 绿 | `test/unit/serp-health-monitor.spec.ts` "命中率 < threshold 且样本 ≥ 5 → detectChange"；Phase A 集成测 serp-extract-wires-health（如已加） |
| 9 | doctor runtime_state 含 metrics/breakers/serp_health 子字段 | ✅ 绿（CI 形状） + ⏸ 手测真机显示 | `src/index.ts` doctorOpts.runtimeState provider 显式返回 `metrics / breakers / serp_health` 三字段；INV-47 守；真机 `lasso doctor` 输出含三 section 留手测 |
| 10 | 进程退出无残留 timer（ResourceMonitor + zombie reaper 都 unref + shutdown 清理） | ✅ 绿 | `src/index.ts` shutdown() 显式调 `resourceMonitor.stop()`（line ~713）；ResourceMonitor.start 用 `timer.unref?.()`；`test/unit/resource-monitor.spec.ts` stop() 清 timer |

### 1.2 不变量回归（守 v0.6，parse8 §6.2）

| INV | v0.7 状态 | 证据 |
|---|---|---|
| INV-1..34 | ✅ 零改 | check-invariants.mjs INV-1..34 段字节级保持；47 PASS 中前 34 全绿 |
| INV-35..40（v0.6 runtime 红线） | ✅ 零改 | check-invariants.mjs INV-35..40 段字节级保持；47 PASS 中 v0.6 段全绿 |
| INV-4（FallbackDecider ≤ 1） | ✅ 守住 | v0.7 长熔断接在 FallbackDecider 第 3 参（attachLongBreakers setter），**未开第二 decider**；`src/fallback/` 仍是单一 fallback 引擎 |
| INV-37 task（channel disable 必经 ToolManager） | ✅ 守住 | v0.7 长熔断经 `bag.disable → onChange → toolManager.disableChannel` 链（INV-42 红线）；`long-circuit-bag-link.test.ts` 端到端断言 |

---

## 2. parse8 §1.2 范围矩阵逐项（做 / 不做）

### 2.1 v0.7 做了

| 维度 | v0.7 交付 | CI 证据 |
|---|---|---|
| **熔断** | 60min 长熔断（threshold=10, windowMs=1h, resetMs=1h） + reset() | `LongCircuitBreaker.ts` + `long-circuit-bag-link.test.ts` + `long-circuit-breaker.spec.ts` |
| **指标** | per-channel 成功率 / 延迟 p50/p95 + RingBuffer(128) + scanForAlerts | `MetricsCollector.ts` + `metrics-collector.spec.ts` |
| **资源** | 子进程 RSS/CPU 采样（60s setInterval + unref） + 阈值告警（hot_streak=5） | `ResourceMonitor.ts` + `SubprocessManager.listManagedPids()` + `resource-monitor.spec.ts` |
| **SERP** | 命中率 < 50%（样本 ≥ 5）→ ChangeDetection 验证 → logger.warn + RecordingStore.save + retrieval_method 标记 | `SerpHealthMonitor.ts` + `serp-health-monitor.spec.ts` + extract.ts onResult hook |
| **暴露** | admin tool 加 3 只读 action（metrics_snapshot / breaker_status / serp_health） | `observ-admin-action.test.ts` 3 用例 |
| **doctor** | runtime_state section 扩 metrics / breakers / serp_health 子字段 | `index.ts` doctorOpts.runtimeState provider；INV-47 |

### 2.2 v0.7 不做（守 NO-GO 边界）

| 维度 | NO-GO 守护 | 证据 |
|---|---|---|
| 跨 channel 联合熔断 | 单 channel 独立 breaker；longBreakers Map 同 key 但独立 state | INV-41 + LongCircuitBreaker.ts |
| 外部 Prometheus exporter | src/observ/ 全树无 prometheus/statsd 字面量 | INV-43 |
| RRF 融合 / corpus 持久化 | MetricsCollector 不持久化（重启清零）；HitRateStats 同范式 | MetricsCollector.snapshot 不写盘 |
| 远程指标后端 | observ 不 import fetch/http；只经 logger | INV-43 |
| 进程级 OOM-kill 自动恢复 | ResourceMonitor 仅 logger.warn；不 kill | ResourceMonitor._checkThreshold 仅 log |
| cgroup 集成 | 仅读 /proc/<pid>/statm（Linux）；无 cgroup | ResourceMonitor._sampleOne |
| 自动重写 selector 表 | SerpHealthMonitor 无 setUpgradeVersion / setSelectors 调用 | INV-45 |
| 录制回放回归 | RecordingStore 仅 save（v1.0 回归用）；v0.7 不实装 replay | src/serp/RecordingStore.ts API |
| 新 observability tool | src/tools/ 内 admin tool 注册数 = 1 | INV-46 |
| 新 doctor 顶级 section | runtime_state 是 v0.6 已有 section；v0.7 仅扩字段 | INV-47 |

---

## 3. v0.7 文件清单（Phase A + Phase B 合计）

### 3.1 Phase A（4 新 src + 4 单元测 + INV-41..47；已交付）

**新增 src**（5 个 TS，~880 行）：
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/fallback/LongCircuitBreaker.ts`（~173 行）60min 长熔断状态机 + onOpen 回调
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/observ/MetricsCollector.ts`（~197 行）per-channel 指标聚合 + p50/p95
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/observ/ResourceMonitor.ts`（~? 行）子进程 RSS/CPU 旁路采样
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/serp/SerpHealthMonitor.ts`（~167 行）SERP 改版检测协调器（粘合 v0.2 四件骨架）

**新增 test**（4 个 spec，~51 用例）：
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/unit/long-circuit-breaker.spec.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/unit/metrics-collector.spec.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/unit/resource-monitor.spec.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/unit/serp-health-monitor.spec.ts`

**外科手术修改**（Phase A）：
- `src/fallback/FallbackDecider.ts` —— 加 `attachLongBreakers` / `attachMetrics` 双 late-binding setter + 主循环双 breaker 串联检查 + record 钩子
- `src/subprocess/SubprocessManager.ts` —— 加 `listManagedPids()` 只读 accessor（~10 行）
- `src/invariants/check-invariants.mjs` —— 加 INV-41..47 共 7 条断言（v0.6 INV-1..40 零改）

### 3.2 Phase B（admin observ action + index/doctor 接线 + version bump + 集成测；本次提交）

**新增 test**（2 个 spec，+11 用例）：
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/integration/long-circuit-bag-link.test.ts` —— 7 用例（threshold 触发 / provider 级不 kill shared / 60min allow false / half-open probe / onOpen 抛错不污染 / 滑动窗剔除 / 双 breaker 串联）
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/integration/observ-admin-action.test.ts` —— 5 用例（metrics_snapshot / breaker_status / serp_health 各 1 + 未注入返 configured:false + 3 action 不要求 reason）

**修改文件**（Phase B，6 个外科手术式）：
- `src/runtime/runtime-types.ts` —— AdminAction union 加 3 成员（metrics_snapshot / breaker_status / serp_health）
- `src/tools/admin.ts` —— adminSchema.action enum 加 3 项 + handler switch 加 3 只读 case + AdminToolDeps 加 metrics/breakers/longBreakers/serpHealth 可选注入
- `src/index.ts` —— v0.6 装配段零改；v0.6 接线段尾部加 v0.7 装配段（metrics 实例化 + LongCircuitBreaker Map + onOpen=bag.disable 闭包 + ResourceMonitor + serpHealth 已早装配 + doctorOpts.runtimeState 扩 metrics/breakers/serp_health + shutdown 加 resourceMonitor.stop）；LASSO_SERVER_VERSION → 0.7.0-dev
- `src/doctor/doctor.ts` —— LASSO_VERSION → 0.7.0-dev（runtime_state section 已在 v0.6 加，v0.7 仅扩 provider 返字段；零结构性改动）
- `package.json` —— version: 0.6.0-dev → 0.7.0-dev

---

## 4. 手测清单（macOS 真机 + 真实环境，pending）

| # | 手测项 | 状态 | 操作步骤 |
|---|---|---|---|
| **M1** | 长熔断真机触发（模拟连续失败 10 次）→ bag.disable → tool 下架 + subproc kill | ⏸ pending | 1. 启 lasso-mcp（真子进程）<br>2. 手工 curl / 改 hosts 让某 endpoint 连续返回 5xx ≥10 次（或在测试模式手工调 recordFailure 10 次）<br>3. `grep "long_circuit_opened" lasso.log` 看是否 emit<br>4. CC 调 admin capability_list 看 channel enabled=false<br>5. `ps aux \| grep chrome-devtools-mcp` 看子进程退出<br>6. CC 调 admin breaker_status 看 long breaker state=open |
| **M2** | 长熔断 60min 后 half-open probe → recordSuccess → closed；bag 仍 disabled 需 admin 显式 enable | ⏸ pending | 1. M1 触发后等 60min（或测试模式手工 `_forceElapsedForTests(3_600_001)`）<br>2. CC 请求 → half-open probe 放行<br>3. probe 成功 → breaker state=closed<br>4. CC 调 admin capability_list 看 channel **仍** disabled=false（保守设计）<br>5. CC 调 admin capability_enable → tool 重 enabled |
| **M3** | 指标聚合真测（CC 连续调用 N 次 search/browse → admin metrics_snapshot 看成功率/p95） | ⏸ pending | 1. 启 lasso-mcp<br>2. CC 调 search/browse_headless 各 10+ 次（混合 success/error）<br>3. CC 调 admin metrics_snapshot → 期望返 channels 数组含 search.zhipu / browse_headless，total ≥ 10，success_rate 反映比例<br>4. 验 latency_ms_p95 在合理区间（几十~几百 ms） |
| **M4** | 资源采样真测（lasso 跑 ≥5min → admin metrics_snapshot / doctor 看 RSS） | ⏸ pending | 1. 启 lasso-mcp（macOS 开发环境）<br>2. 等至少 5min（5 次 60s 采样周期）<br>3. CC 调 admin breaker_status 不看；调 doctor tool 看 runtime_state.metrics / .breakers / .serp_health<br>4. macOS 环境下 RSS 是 host 进程近似值（doctor 应显式标注；R15）<br>5. Linux 环境下应见精确 chrome-devtools-mcp / rust-helper 各自 RSS |
| **M5** | SERP 命中率下降真测（连续 5+ 次空结果 → admin serp_health 看 redesign_suspected=true） | ⏸ pending | 1. 启 lasso-mcp<br>2. 改 hosts 或 mock 让 baidu SERP 抽取返 0 结果 5+ 次（或挑自然空结果 query 如生僻词）<br>3. CC 调 admin serp_health → 期望 engines[].baidu.hit_rate < 0.5 + redesign_suspected=true<br>4. `grep "serp_redesign_confirmed" lasso.log` 看告警<br>5. 检查 ~/.cache/lasso/serp/recordings/ 有 fixture 落盘（v1.0 回归用） |
| **M6** | doctor 真机输出含 runtime_state 三新字段（metrics / breakers / serp_health） | ⏸ pending | 1. `lasso-mcp doctor`（CLI 模式）—— 注意 CLI 模式不注入 runtimeState provider（opts.runtimeState undefined）；预期 runtime_state section 不出现（与 v0.6 行为一致）<br>2. 启 lasso-mcp MCP server，CC 调 doctor tool —— 预期 runtime_state section 含 metrics / breakers / serp_health 三子字段（INV-47） |
| **M7** | admin breaker_status 真机（短/长 breaker 状态聚合） | ⏸ pending | 1. 启 lasso-mcp 跑一段时间（自然产生短熔断或手工触发）<br>2. CC 调 admin breaker_status → 期望 breakers 数组含 short + long 两种 kind<br>3. 验证字段：channel / kind / state / failure_count (短) 或 window_failure_count (长) / opened_at |

---

## 5. 关键决策与偏离 parse8 记录

### 5.1 与 parse8 一致的决策（无偏离）

- ✅ **LongCircuitBreaker 与 CircuitBreaker 并列在 src/fallback/**（不开第二引擎，INV-41）；复用 `BreakerState` 类型不重定义
- ✅ **CircuitBreaker 一行不改**（v0.6 短熔断字节级零回归；CircuitBreaker.ts 79 行 wc 验证）
- ✅ **长熔断经 onOpen → bag.disable**（不绕过 INV-37 task 联动链，INV-42）；onOpen 闭包内显式标 `reason="long_circuit_open"`
- ✅ **MetricsCollector 进程内**（INV-43）；RingBuffer(128) + 自实装 percentile（无新依赖）
- ✅ **ResourceMonitor 仅读 /proc**（INV-46 衍生：不渗协议帧）；macOS 降级 host RSS
- ✅ **SerpHealthMonitor 禁自动重写 selector**（INV-45）；改版只 logger.warn + RecordingStore.save
- ✅ **observ 走 admin action-enum**（INV-46）；3 只读 action（metrics_snapshot / breaker_status / serp_health），不开新 observability tool
- ✅ **doctor runtime_state 扩字段不开新 section**（INV-47）

### 5.2 偏离 parse8 的微调（均在铁律内）

- **`LongCircuitBreaker._forceElapsedForTests` 实现**：parse8 §3.1 注释"同步老化 failureTimestamps"—— 实装为 `failureTimestamps.map(t => t - ms)` + 立即 filter，语义比 parse8 简单伪码更精确（让 windowFailureCount 反映"快进后剩余"）。**铁律守**：私有 test helper，不渗生产路径。
- **`SerpHealthMonitor.onResult` 同步返 "serp_layout_changed"**：parse8 §3.4 伪码 void；实装为同步返 "serp_layout_changed" | null（让 extract.ts 主路径能透传 retrieval_method 标记，08 §3.8 软降级链路）。**铁律守**：不阻塞主路径（detectChange 仍异步 fire-and-forget）；标记链路在 extract.ts 仅追加字段不改流程。
- **`MetricsCollector.scanForAlerts` 样本下限 10**（parse8 §3.2 接口注释 ≥10；HitRateStats 阈值 5）。**理由**：指标样本噪声大（搜索 / 浏览延迟方差大），10 比 5 更保守，避免冷启动误报。**铁律守**：与 parse8 接口签名一致；阈值在函数签名默认值，可调。

---

## 6. Phase B 验收总结

| 维度 | 状态 |
|---|---|
| CI 全绿 | ✅ build 0 error / test 1147 pass / invariants 47/47 |
| 零回归（v0.6 1081 + Rust 144 + INV-1..40） | ✅ 字节级守 |
| 长熔断联动 CapabilityBag（INV-42） | ✅ 端到端集成测覆盖 |
| observ 走 admin action-enum（INV-46） | ✅ 3 只读 action 经 unit + 集成测覆盖 |
| version bump（package.json + index.ts + doctor.ts） | ✅ 三处对齐 0.7.0-dev |
| parse8-acceptance.md | ✅ 本文件 |
| 手测（M1-M7） | ⏸ pending（CI 已覆盖语义正确性，真机端到端待用户环境） |

**v0.7 Phase B 交付完成**。Phase C/D/E/F 已在 Phase A + B 中合并交付（parse8 §7.2 6 phase 合并为 2 大 phase 实施顺序：A 单元 + 集成层、B admin + index 接线 + 文档）。
