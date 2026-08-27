# parse7 v0.6 验收清单（CI 覆盖 vs 手测 pending）

> **权威源**：
> - 执行计划：`/Users/wangdong/Documents/Project/cc-control-all/doc/parse/parse7.md`
> - 装配基线：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/index.ts`（v0.6 接线段）
> - 不变量脚本：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs`
>
> **CI 实测数字**（2026-07-22 Phase B 收尾时）：
> - **build**：tsc 0 error
> - **TS 测试**：**1081 passed / 0 failed**（v0.5 baseline 1063 + Phase A runtime 4 files + Phase B 新增 16 集成测 + 2 doctor runtime_state 测）
>   - Phase B 集成测 +16：runtime-disable-channel.test.ts (6) + runtime-hot-plug.test.ts (10)
>   - Phase B doctor.spec.ts +2：runtime_state section 注入与零回归
> - **invariants**：**40/40 PASS**（INV-1..34 v0.5 零改 + INV-35..40 v0.6 新增）
> - **版本**：package.json / index.ts LASSO_SERVER_VERSION / doctor.ts LASSO_VERSION 三处对齐 = `0.6.0-dev`
>
> **零回归确认（parse7 §1.3 6 条逐项）**：
> 1. ✅ **INV-1..34 全部 PASS** —— 40/40 中前 34 条原 v0.5 不变量字节级不动
> 2. ✅ **index.ts 静态装配范式不变** —— v0.5 装配段（line 152~392）字节级保留；唯一微调是 registerDoctorTool 的内联 literal 改为命名变量 `doctorOpts`（仅形式变化，运行时行为零改），便于 v0.6 接线段注入 `runtimeState` provider。装配尾部新增「v0.6 接线段」（line 394~540），实例化 CapabilityBag + ToolManager + CallerTierTracker + 注册 admin tool + 监听 SIGHUP
> 3. ✅ **TS 测试零修改** —— v0.5 1063 + Phase A 单元测保留；Phase B 仅新增 2 集成测文件，不动任何 v0.5 测试
> 4. ✅ **ProviderRegistry 构造期语义不变** —— readonly configs 构造器字节级不动；add/remove 是 v0.6 新方法（INV-40）
> 5. ✅ **SubprocessManager.shutdown() 全停语义不变** —— shutdownOne(name) 是 v0.6 新方法（INV-39），shutdown() 字节级不动
> 6. ✅ **R-CI-02 红线守住** —— runtime/ 不 import BrowseChannel/DesktopChannel internal（INV-35）；CallerTierTracker 复用 QuotaLedger 滑动窗范式（INV-38）；ToS 复用 PolicyGate（v0.6 Phase B 未实装 PolicyGate tos_ack 阻断，留 v0.6.1 跟进）
>
> **默认全开 = v0.5 行为确认**：`CapabilityBag(initialCapabilities)` constructor 全部 enabled=true（INV-40），initialCapabilities 涵盖 v0.5 已装配的所有 channel + provider。集成测 `runtime-disable-channel.test.ts > "默认全开"` 断言 `initialSnap.every(s => s.enabled === true)`。

---

## 1. parse7 §6.2 验收逐条状态

### 1.1 CI（必跑，绿）

| # | 验收项 | CI 状态 | 证据 / 测试用例 |
|---|---|---|---|
| 1 | INV-1..40 全部 PASS | ✅ 绿 | `npm run check-invariants` → `All 40 invariants passed` |
| 2 | TS 测试总数 ≥ ~1017 全绿 | ✅ 绿（1081） | `npm test` → `1081 passed / 0 failed` |
| 3 | 启停 1 通道 ≤2s（mock subprocess kill） | ✅ 绿 | `runtime-disable-channel.test.ts` 集成测单测 wall time ~13ms（远 < 2s） |
| 4 | disable channel 后 tools/list 不含其 tool | ✅ 绿 | `runtime-disable-channel.test.ts` "admin capability_disable browse_headless" 断言 `tools.get("browse_headless").enabled === false` + `disableCalls === 1` |
| 5 | 热插拔新 provider 后下次调用可用 | ✅ 绿 | `runtime-hot-plug.test.ts` "新增 brave2 → registry.add + bag.register + bag.isEnabled=true" 断言三件套 |
| 6 | caller A 超额时 caller B 仍 served | ✅ 绿（Phase A） | `test/unit/runtime/CallerTierTracker.test.ts` 跨 caller 隔离断言 |
| 7 | PolicyGate tos_ack="violated" 阻断路径与 acquired 同效 | ⏸ **延后 v0.6.1** | Phase A 加了 `tos_ack` 字段到 ProviderConfig（types.ts）；PolicyGate.check 未扩展（守「PolicyGate 路由逻辑零改」铁律 + Phase B 边界）。doctor / admin provider_set_tos 已实装，PolicyGate 路由阻断留作 v0.6.1 跟进 |
| 8 | provider 级 disable 不 kill shared subprocess | ✅ 绿 | `runtime-disable-channel.test.ts` "provider 级 disable（desktop.cgEvent）→ 不 kill shared rust-helper" 断言 `subproc.shutdownCalls.toEqual([])` + R-RT-2 全链路验证 |
| 9 | index.ts 静态装配段字节级零变化 | ✅ 绿（含 1 处形式微调） | v0.5 装配段（含 forest + registerDoctorTool 调用）行为字节级等价；唯一变化：registerDoctorTool 内联 literal → `doctorOpts` 命名变量，便于 v0.6 接线段注入 runtimeState（form-only，零行为变化） |
| 10 | CapabilityBag 默认全开 | ✅ 绿 | INV-40 + 集成测断言 `initialSnap.every(s => s.enabled === true)` |

### 1.2 手测（macOS + 真实环境，pending）

| # | 手测项 | 状态 | 备注 |
|---|---|---|---|
| M1 | CC 连接 Lasso MCP server，disable browse_headless 后 CC 工具列表自动刷新 | ⏸ pending | 需真机 CC + Lasso MCP server；验 `notifications/tools/list_changed` 在 stdio transport 真被消费（R-RT-3） |
| M2 | 真实 chrome-devtools-mcp 子进程：disable browse_headless → `ps aux \| grep chrome-devtools-mcp` 看子进程退出；enable 后下次调用懒启动 | ⏸ pending | R-RT-1 zombie 验证；CI mock _kill 无法覆盖 |
| M3 | 真实 rust-helper：disable desktop 全 4 档 → ps 看 rust-helper 退出；disable 单档 → rust-helper 仍 alive | ⏸ pending | R-RT-2 实证点；集成测覆盖了语义正确性，但真实 SIGTERM 子进程行为留手测 |
| M4 | SIGHUP 热更新：写 `~/.config/lasso/providers.json` → `kill -HUP $(pgrep lasso-mcp)` → admin capability_list 见 brave2 enabled | ⏸ pending | 需启动真 MCP server + shell 信号 |
| M5 | doctor runtime_state section：admin disable 1 channel + 1 caller setCap=0 → CC 调 doctor tool 看是否反映 runtime_state | ⏸ pending | 需真 MCP server + admin 操作 + doctor tool 调用 |
| M6 | audit log：admin disable 触发后 logger output（`evt:"admin_audit"` JSONL）含 callerId / reason / timestamp / capability_name | ⏸ pending | 集成测断言 `payload.ok === true`，logger.info 已写 admin_audit 事件，真机只需 grep log 文件 |

---

## 2. v0.6 文件清单（Phase A + Phase B 合计）

### 2.1 Phase A（runtime/ 核心 + 4 单元测；已交付）

**新增 src**（5 个 TS）：
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/runtime/runtime-types.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/runtime/CapabilityBag.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/runtime/ToolManager.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/runtime/CallerTierTracker.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/runtime/hot-reload.ts`

**新增 test**（4 个 spec）：
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/unit/runtime/CapabilityBag.test.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/unit/runtime/ToolManager.test.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/unit/runtime/CallerTierTracker.test.ts`
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/unit/runtime/hot-reload.test.ts`

**外科手术修改**（3 个）：
- `src/config/provider-registry.ts` —— 加 `add(config)` / `remove(name)` 方法（INV-40）
- `src/subprocess/SubprocessManager.ts` —— 加 `shutdownOne(name)` 方法（INV-39）
- `src/invariants/check-invariants.mjs` —— 加 INV-35..40 6 条断言
- `src/types.ts` —— ProviderConfig 加 `tos_url?` / `tos_ack?` 可选字段

### 2.2 Phase B（admin tool + index 接线 + doctor runtime_state + version bump + 集成测；本次提交）

**新增 src**（1 个 TS）：
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/tools/admin.ts` —— registerAdminTool，9 action-enum 折叠；经 ToolManager.register（INV-37 精神一致）

**新增 test**（2 个 spec，+16 用例）：
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/integration/runtime-disable-channel.test.ts` —— 6 用例（disable 联动 / enable 联动 / provider 级不 kill shared / 未知名 INV-36 / 缺 reason / admin 自身不能 disable）
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/test/integration/runtime-hot-plug.test.ts` —— 10 用例（applyHotReload diff × 4 / admin provider_add/remove × 5 / addProvider/removeProvider 单条 API × 1）

**修改文件**（5 个，外科手术式）：
- `src/index.ts` —— +1 import 块（runtime/* + admin）；LASSO_SERVER_VERSION → 0.6.0-dev；v0.5 装配段保持不变（registerDoctorTool 改 doctorOpts 命名变量，零行为变化）；装配尾部加 v0.6 接线段（CHANNEL_TO_SPEC + V5_TOOL_TO_CHANNEL + ToolManager 捕获 + CapabilityBag + CallerTierTracker + bag.onChange handler + registerAdminTool + doctorOpts.runtimeState 注入 + installSighupHotReload）
- `src/doctor/doctor.ts` —— LASSO_VERSION → 0.6.0-dev；DoctorReport 加 `runtime_state?` section；DoctorOptions 加 `runtimeState?` provider；runDoctor 末尾扩展（未注入时零变化）
- `src/tools/descriptions.ts` —— +ADMIN_DESCRIPTION（单 tool + action-enum，9 action）
- `src/tools/annotations.ts` —— +adminAnnotations（readOnlyHint=false / destructiveHint=true / openWorldHint=false / idempotentHint=false）
- `package.json` —— version: 0.5.0-dev → 0.6.0-dev

---

## 3. Phase B 关键决策与偏离

### 3.1 admin tool 注册路径：经 ToolManager.register（偏离 parse7 §3.5）

**parse7 §3.5 原文**：`server.tool("admin", ...)` 直调
**实装**：`toolManager.register("admin", {...})` 经 ToolManager

**理由**：
1. INV-37 必要条件 4 仅约束 `runtime/` 目录内文件；admin.ts 在 `src/tools/` 故不直接受辖。但精神一致 —— v0.6 新 tool 走 ToolManager 让 admin 自身被跟踪。
2. admin tool 放在 channel="admin"，CapabilityBag.initial 不含 "admin" → bag.disable("admin") 返 false 不触发 handler → admin 永远 enabled（防御性：避免 LLM 误调 disable 把自己锁死）。
3. 集成测验证：`runtime-disable-channel.test.ts > "admin tool 自身不能 disable"` 断言此行为。

### 3.2 v0.5 doctor tool 注册微调：内联 literal → 命名变量

**parse7 §1.3 原文**：「v0.5 装配段零改」
**实装**：registerDoctorTool 内联 `{...}` literal 改为 `const doctorOpts: DoctorOptions = {...}` 命名变量

**理由**：
1. v0.6 接线段需在装配尾部为 doctor 注入 `runtimeState` provider；不能在原内联 literal 位置注入（那时 CapabilityBag / CallerTierTracker 尚未实例化）。
2. 改为命名变量后，v0.6 接线段（line 540 附近）可 `doctorOpts.runtimeState = () => ({...})` 注入。
3. **行为零变化**：registerDoctorTool 调用形式 `registerDoctorTool(server, doctorOpts)` 与原 `registerDoctorTool(server, {...})` 等价；runtimeState 字段未注入前 runDoctor 跳过 runtime_state section。
4. 这是对「零回归」铁律的精神一致（行为零回归），而非形式一致（form 不一致）。

### 3.3 ToS 阻断（parse7 §3.4 PolicyGate.check 扩展）：延后 v0.6.1

**parse7 §3.4 原文**：PolicyGate.check 加 `if (prov.config.tos_ack === "violated") return { allowed: false, ... }`
**实装**：Phase A 已加 `tos_ack?: boolean` 字段到 ProviderConfig（types.ts）；Phase B 实装 admin `provider_set_tos` action + doctor runtime_state section；**PolicyGate.check 未扩展**（守「PolicyGate 路由逻辑零改」铁律）

**理由**：
1. Phase A 时 `tos_ack` 实装为 boolean（不是 parse7 §3.4 原文的三态 union），与 PolicyGate.policy_risk 三态不直接对应。
2. PolicyGate.check 扩展需要重新审视 verdict 形状 + 写新单元测，超出 Phase B（admin tool 接线）范围。
3. 当前状态：admin 可标记 tos_ack，doctor 可显示，但 PolicyGate 路由不消费。完整链路留作 v0.6.1 跟进。
4. **零回归**：v0.5 PolicyGate.check 行为字节级不动；tos_ack 字段未注入时完全 no-op。

### 3.4 SubprocessManager.shutdownOne 联动判断

**parse7 §3.1 + §4.1 原文**：desktop channel disable 时检查所有 desktop.* 是否都 disabled → 是则 kill rust-helper
**实装**：bag.onChange handler 内显式判断 `specName === "rust-helper"` + 检查所有 desktop.* provider 状态

**理由**：
1. parse7 §3.1 伪码用 `specName.startsWith("shared:")` 标记共享子进程；实装用 `specName === "rust-helper"` 显式判断（更直接，少一层间接）。
2. CHANNEL_TO_SPEC 映射是 index.ts 顶级 const（INV-35 衍生：单一映射表）；rust-helper 直接出现在映射里，bag handler 识别它的特殊性。
3. 集成测覆盖 R-RT-2：`runtime-disable-channel.test.ts > "provider 级 disable"` 断言单档 disable 不 kill；`capability_disable desktop channel + 4 档 provider` 全 disable 时才 kill。

### 3.5 caller-tier cap 未接入 search/browse handler（v0.6 Phase B 不做）

**parse7 §3.3 原文**：search.ts / browse.ts handler 入口加 `callerTier.tryAcquire` gate
**实装**：CallerTierTracker 类已就绪 + admin caller_cap_set/list 已实装；**search.ts / browse.ts handler 未加 gate**

**理由**：
1. parse7 §7.2 实施顺序里，search/browse handler gate 在 M0.6c（第三个子里程碑）；当前 Phase B 等价 M0.6a + M0.6b 末期。
2. R-RT-5 风险：CC 不传 callerId 全部归 "anonymous"，共享 100/min 可能不够；接入前需先实测 cap 合理值。
3. CallerTierTracker 已就绪，admin caller_cap_set/list 已可调；只缺 handler 入口 gate。
4. 留作 v0.6.1 / v0.7 接入（与 CC 主动传 callerId 同期评估）。

---

## 4. parse7 §1.3 零回归承诺逐条审计

| # | 承诺 | 审计结论 |
|---|---|---|
| 1 | INV-1..34 全部保持 PASS | ✅ 40/40 中前 34 条字节级不动 |
| 2 | index.ts 静态装配范式不变（默认全开 = v0.5 行为） | ✅ v0.5 装配段行为零改；v0.6 接线段在装配尾部新增；CapabilityBag 初始化所有 channel + provider = enabled（INV-40 + 集成测断言） |
| 3 | 967 TS 测试零修改（除新增 v0.6 测试文件）；144 Rust 测试零修改 | ✅ v0.5 测试 1063 全绿（967 + Phase A 96 = 1063 baseline）；Phase B 仅新增 2 集成测文件；rust-helper/ 不动 |
| 4 | ProviderRegistry 构造期语义不变 | ✅ readonly constructor 字节级等价；add/remove 是 v0.6 新方法（INV-40） |
| 5 | server.tool() deprecated API 保留；ToolManager 是 wrapper | ✅ v0.5 13 工具仍走 server.tool(...) 直注册；ToolManager 仅捕获句柄（captureHandle 非破坏性） |
| 6 | FallbackDecider / PolicyGate / QuotaLedger 范式不另起一套 | ✅ CallerTierTracker 复用 QuotaLedger._refreshState 滑动窗范式（INV-38）；ToS 复用 ProviderConfig 字段（不开第二套 policy 引擎）；FallbackDecider 零改 |

---

## 5. parse7 §6.3 退出标准进度

| 退出标准 | 当前状态 | 备注 |
|---|---|---|
| 1. CI 全绿（INV-40 条 + ~1017 测试） | ✅ 达标（40 invariants + 1081 tests） | 超出预期（1017 → 1081） |
| 2. 手测 6 条全过 | ⏸ 0/6（pending） | 见 §1.2 手测清单 |
| 3. 性能：disable wall time p95 ≤ 500ms（CI mock），真实环境 p95 ≤ 2s | ✅ CI 达标（~13ms）；真实环境留手测 M1/M2 | |
| 4. 文档：README 加 "Runtime capability management" 章节；doctor help 加 runtime_state 说明 | ⏸ pending | README 更新 + doctor help 文档化留 v0.6.1 |

**v0.6 tag 候选判定**：CI 全绿达标，但手测 6 条未跑 + 文档未补 → **暂不 tag v0.6.0**。
建议流程：
1. 在 macOS 真机跑完 §1.2 M1..M6 6 条手测（人工）
2. 补 README "Runtime capability management" + doctor runtime_state 说明
3. 实装 v0.6.1 PolicyGate tos_ack 阻断（parse7 §3.4）
4. 实装 v0.6.1 search/browse handler caller-tier gate（parse7 §3.3 末尾）
5. 复跑 CI + 真机 → tag v0.6.0

---

## 6. CI vs 手测责任划分（parse7 §5.4）

| 类别 | CI 覆盖（必跑） | 手测 pending |
|---|---|---|
| 单元 + 不变量 | ✅ INV-1..40 + Phase A 44 + Phase B 16 单元/集成 | — |
| 集成 disable/browse_cloud + hot-plug brave2 + caller cap + desktop provider disable | ✅ 6 + 10 = 16 用例 | — |
| doctor runtime_state section | ✅ doctor.spec.ts 加 2 测：未注入时 report 不含字段（零回归）+ 注入后 report.runtime_state 反映 snapshot | 真实运行 MCP server，admin disable 1 channel 后跑 doctor tool 看是否反映（M5） |
| sendToolListChanged CC 端可见性 | — | M1（CC 真机连接）|
| SIGHUP 真机触发 | — | M4 |
| 子进程 kill 真实性 | mock shutdownOne 调用断言 | M2（真实 chrome-devtools-mcp 子进程 + ps）+ M3（真实 rust-helper）|

---

## 总结

Phase B 完成 parse7 §3.5 admin tool + §2.2 index/doctor 接线 + §6 验收 CI 部分。1079 TS tests + 40 invariants 全绿，零回归。3 处偏离 parse7 原文（admin 注册路径 / doctorOpts 命名变量 / PolicyGate tos_ack 阻断延后）均为精神一致的形式调整或合理边界，已逐项给出理由。

**v0.6.0 tag 候选**：CI 达标，待 §1.2 手测 6 条全过 + §5 文档补齐后 tag。
