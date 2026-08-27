# 第 1 轮最优性审查 —— 03 审查测试（六维 + 五阶段）

> 审查测试员：round1-review03。日期：2026-08-17。
> 依据：《架构想法/03_审查测试清单.md》§1 六维度 + §2 五阶段。
> 对象：round1 全部 16 项（T1-T16，v1.10.0 → v1.11.0，66 文件 +2644/-431）。
> 独立证据基线：审查者自行下载 chrome-devtools-mcp@1.7.0 tarball 白盒核对（非采信实施报告转述）+ 本机（macOS 12）真机实测。

---

## 0. 独立证据（不采信转述，03 §0.3 证据阶梯）

| # | 验证项 | 方法 | 结果 |
|---|---|---|---|
| E-1 | 1.7.0 CLI 契约：`--no-usage-statistics` / `--wsEndpoint`(与 browserUrl conflicts) / `--viewport=WxH`(coerce) / `chromeArg`(array) / `proxyServer` | tarball `build/src/bin/chrome-devtools-mcp-cli-options.js` 逐行读 | ✅ 全部属实；`--proxy-server` kebab 形态经 yargs camel-case 展开有效（上游 help 自身示例 `--chrome-arg`/`--user-data-dir` 即 kebab）；**yargs 无 `.strict()`**——flag 拼错会静默哑弹，flag 名精度是硬要求（实测全部正确） |
| E-2 | **`wait_for.text` = `zod.array(zod.string()).min(1)`**（争议点） | tarball `build/src/tools/snapshot.js:46-49` 原文 | ✅ **实施者对裁决官预检的纠错正确**；传 string 必被 zod 拒。真机双验证：array 被接受 / string 被拒 |
| E-3 | network 行格式 `reqid=N METHOD url [status]`（+` [selected …]` 后缀） | tarball `formatters/NetworkFormatter.js:182` 原文 | ✅ 与 parseNetworkRequestLines 正则一致；真机实跑 example.com 输出 `reqid=1 GET https://example.com/ [200]` 被 dist 解析器正确解析 |
| E-4 | console 行格式 `msgid=N [type] text (N args)` + `[N times]` 后缀 | tarball `formatters/ConsoleFormatter.js:193-194` 原文 | ✅ 与 parseConsoleMessageLines 一致（含 `args?` 单复数、`[N times]` 可选组） |
| E-5 | list_network_requests `resourceTypes` 枚举含 xhr/fetch/image | tarball `tools/network.js` FILTERABLE_RESOURCE_TYPES | ✅ 映射表合法 |
| E-6 | Safari 27 真实 UA 形态 | 外部检索（Apple Safari 26 Release Notes / nielsleenheer 实测文） | ❌ **T4 写错**：真实 Safari/` token 冻结在 605.1.15，`Version/27.0 Safari/27.0` 是真机从不发出的伪造组合 → **F3** |
| E-7 | 真机 headless 冒烟（v1.11 全套 spec flags 实跑 1.7.0） | `round1-smoke-headless.mjs` | ✅ 14/14 PASS（UA flag 到 navigator、viewport 1920x1080、wait_for 数组契约、network/console 真输出解析、screenshot 回归） |
| E-8 | B3 服务器端 UA 回显 | httpbin.org/user-agent 真跑 | ✅ **HTTP 层 UA 头逐字节 = profile UA**（launch flag 真到网络层——T2 的最强证据形态） |
| E-9 | 真机 desktop 编号一致性（VSCode/Electron） | rust helper 实跑 find vs act 计数 | ❌→✅ **F2 实锤后修复复测**：修复前 find 12 vs act 14 / snapshot 26 vs act 27；修复后 12==12 / 24==24 |

---

## 1. 六维结论

### 1.1 代码规范 ✅（1 处卫生修）
build/tsc 全绿；注释解释 WHY；`number_refs`/`collect_matches` 领域命名一致。
- **修**：`rust-helper/src/windows.rs:25` 预存 `use crate::tcc;` unused import（1.7-1 铁律）→ 删除。

### 1.2 数据逻辑 ✅（2 处实质缺陷修复）
- **producer 契约（1.2-1/2/3）**：1.7.0 全部 flag/工具 schema/文本行格式经 tarball 独立白盒（E-1..E-5）+ 真机（E-7/E-8）双确认。智谱 `search_recency_filter` 枚举 oneDay/oneWeek/oneMonth/oneYear 与裁决官同款 MCP schema 一致；Brave pd/pw/pm/py、Bing Day/Week/Month（year 档诚实不传）✅。字段缺失语义：parseCdpPort NaN→9222+warn（T12）✅；doNetwork/doConsole 解析失败→空数组不炸 ✅。
- **🔴 F3（已修）**：T4 Safari profile `Safari/27.0` 伪造 token（E-6）——数据正确性缺陷，且恰好违背 T4 自身"降低指纹年龄信号"的目标（一行 regex 即识破的硬指纹）。修为 `Version/27.0 Safari/605.1.15`；**INV-73 (d) 增必要条件 9b**（Safari/ token 只许冻结值 605.1.15 / 537.36）机械化拦截同类错误（03 §3.2 escape→补清单项），mutation 实测该条件由绿转红。
- **🔵 F5（已修）**：非 CJK query 走 DDG 但 `SearchResult.region` 硬编码 "cn"——字段撒谎。修为按引擎语言 cn/us。
- praise：T1 对裁决官预检的 wait_for 契约纠错**准确且必要**（不传数组必挂）；T13 selftest 10/10 是「pin 真在守护」的制度化证据。

### 1.3 业务逻辑 ✅
- tri-state 映射链自洽：partial ok → worked（per-item 错误可见）/ 全败+stale_ref → didnt 短路（旧 ref 再试无意义）/ 全败无 stale → unknown 链继续（press/hotkey 归档3）——真机负向验证 press→ax_unsupported_action、bad-ref→invalid_params、out-of-range→stale_ref ✓。
- T15 expect 语义正确（非 worked 不验后置；text/role 缺失诚实 expect_needs_text_or_role）。
- 边界：skeleton 默认关 byte-identical、freshness optional 无 default byte-identical 均有单测钉死 ✓。

### 1.4 端到端接通 ✅（1 处 🔴 修复 + 1 处诚实性修复）
- **🔴 F2（已修，本轮最重要发现）**：值级 trace（1.4-1）抓出——snapshot/find 的 @eN 编号消费 `walk()` 产物（T8 后含 wrapper 深度中和 + 防环占位），而 act 的 `collect_resolved` 是独立严格深度遍历（无中和/无防环）→ **同 app 同 where 同 depth 下两套编号序列漂移**。真机 VSCode（Electron）实测：find 12 命中 vs act 14 编号；snapshot 26 vs act 27（E-9）。后果：wrapper 密集 app（恰是 T8 要修的对象）上 @eN 错位解析 → **点错元素或伪 stale_ref**；且 act 无防环 → 环树挂死 helper。修复：删独立遍历，act 改为 `walk()` 单一真源 + live 元素前序锁步编号（`number_refs`），cycle 占位编号保留位置但拒绝执行；stale 基线同时升级为真 walk 期值。复测 12==12 / 24==24。**这是 T3 与 T8 同轮落地互相作用的回归——两份各自正确的 diff 在接缝上错配，diff 内部自洽看不见（03 §1.7-7 diff 闸门原理同款）。**
- **🟡 F1（已修）**：descriptions.ts/network.ts 用户向文案指向 `get_network_request` follow-up，但 Lasso 无该 action 入口（dispatch Map 无 entry）——T15 消灭「schema 承诺未兑现」裂缝的同款问题以**散文形态**复发。措辞改为诚实（reqid 已保留、network_get 未接线）。
- 真机 e2e：E-7/E-8 冒烟全绿；文档面（README/KEY-GUIDE/8 语言）实施时已同步，review 修复无 desync（grep 验证）。

### 1.5 性能 + 生产就绪 ✅（1 处修复）
- **🟡 F4（已修）**：`walk` 防环 `Vec::contains` O(n²)——dense app（T8 的目标场景，数万节点）是延迟地雷，裁决书 T8 明确点名 FxHashSet。修为 `std::collections::HashSet`（零新依赖）；desktop-skeleton.spec 源码级断言同步收紧（insert/HashSet/非 push）。
- 回滚/开关：版本锁单常量回滚；skeleton/LASSO_PROXY opt-in（logged_in 永不读有源码级+行为级双负向测试）；rust helper 子进程不阻塞 TS 事件循环。无时序敏感插桩引入。

### 1.6 简单架构 ✅（净改善）
- F2 修复**减少**了重复（删第二套遍历，R-CI 单一真源化）；wrapHandler 守住三件事边界、v0.5 静态 17 工具字节等价有测试钉死；T7 逻辑按钮名双端拒 raw code（INV-28 面）；AxBackend.act 签名扩参三平台同形（INV-61 守护在）。零新依赖（HashSet 是 std）。
- T8 web wrapper 深度中和默认生效改变 Electron app 默认输出——属裁决书明示的"可达性缺陷修复"，fixture 已固化。可接受。

### 1.7 冗余与废弃 ✅
GOOGLE_SELECTORS 删除零残留（有测试钉）；PerformanceObserver 注入路径删除零残留（grep 测试钉）；同步对（desktop-skeleton.spec ↔ ax.rs visited 形态）随 F4 更新；一处预存 unused import 清理。无注释掉的代码、无 tracked 构建产物新增。

---

## 2. §2 五阶段抽查

| 阶段 | 抽查内容 | 结果 |
|---|---|---|
| 2.1 单测 | rust `cargo test` 全量（含 ax_act/cgevent/tcc 新测）；**mutation 抽查 4/4 killed**：①删 `--no-usage-statistics`→migration spec 红 ②版本锁改 0.3.0→红 ③network 行正则破坏→cdp-actions-native 2 红 ④cache key 去 freshness→search-freshness 2 红 | ✅ 193 pass；测试真能失败 |
| 2.2 集成/契约 | browse-upstream-contract / cdp-mcp-170-migration / steel-channel-flow 全绿；契约证据升级为 tarball 白盒 + 真机（强于 fixture-only） | ✅ |
| 2.3 冒烟 | 真机 1.7.0 全套 spec 实跑 14/14（E-7）；B3 服务器端 UA 回显逐字节一致（E-8）；真机 desktop 编号一致性 + 三条负向路径（E-9）。**E1-E5 真实 AXPress/AXSetValue 执行未做**——活跃用户会话上无法无害执行（点击/输入会动用户 UI），保持诚实 ⏳ | ✅（desktop 执行项例外，如实记录） |
| 2.4 性能 | 本轮无新增 SLO 面；F4 即性能审查产出（O(n²)→O(1)） | ✅ |
| 2.5 用户验收 | 单人项目，manual checklist 即验收工具；review03 已关闭 B3/B4 + T1 核心项 + T5 解析器 L2（见 checklist 增补段）。本报告即非作者 sign-off（03 §3.4 Reviewed-by） | ✅ 部分，余项 ⏳ |

---

## 3. 发现并修复的问题（全部已修 + 复跑门禁）

| # | 级别 | 维度 | 问题 | 修复 | 文件 |
|---|---|---|---|---|---|
| F2 | 🔴 | 1.2/1.4 | act 独立遍历与 walk() 编号漂移（真机 12v14/26v27；Electron 上错位点击 + 环树挂死风险） | 单一真源重构：walk() + live 锁步 `number_refs`；cycle 占位拒执行 | rust-helper/src/ax.rs |
| F3 | 🔴(数据) | 1.2 | Safari profile `Safari/27.0` 伪造 token（真机从不发出） | 冻结 token `Safari/605.1.15` + INV-73 9b 机械化（mutation 验红） | stealth-profiles.ts / check-invariants.mjs / stealth-profiles.spec.ts |
| F1 | 🟡 | 1.4/1.7 | 用户向文案指向不可达的 get_network_request action | 措辞诚实化（reqid 保留、network_get 未接线） | descriptions.ts / network.ts |
| F4 | 🟡 | 1.5 | 防环 Vec::contains O(n²)（dense app 延迟地雷） | HashSet + 源码级断言收紧 | ax.rs / desktop-skeleton.spec.ts |
| F5 | 🔵 | 1.2 | ddg_serp region 硬编码 "cn" | 按引擎语言 cn/us | serp/extract.ts |
| F6 | 🔵 | 1.7 | windows.rs 预存 unused import | 删除 | rust-helper/src/windows.rs |

## 4. 门禁终跑（修复后）

```
npm run build            → 0 error
npm test                 → Test Files 120 passed (120) / Tests 1905 passed | 1 skipped（基线不减）
npm run check-invariants → All 79 invariants passed（INV-73 含新 9b 条件）
npm run inv-selftest     → 10/10 sampled pins flipped red（工作树零污染）
cargo test（rust-helper）→ 193 passed
真机复测                 → headless 冒烟 14/14；httpbin UA 回显一致；find/act 编号 12==12、24==24
```

## 5. 遗留（下轮调优输入）

1. **E1-E5**（ax_act 真实执行：AXPress/AXSetValue 写后读回/AXScrollToVisible/stale 时序/secure 豁免）——需用户在可控窗口（计算器/TextEdit）手测回填。
2. **C1-C5**（CGEvent 鼠标真机）+ **B1/B2/B5**（sannysoft 整页 / Safari profile 变体）——同上 ⏳。
3. **T11 macOS 15+ 路径**——本机 12 N/A，D1 待 15+ 真机。
4. `is_web_wrapper` 的 `has_value` 语义（AXValue 存在但为 null 时 `is_ok()` 真 → 判非 wrapper）：与 agent-desktop 的"值非空"判定可能有偏差，E1-E5 真机时顺带在 Electron app 上核对深度中和是否如预期生效。
5. `network_get` action 未接线（文案已诚实化）：若真实出现"要看响应体"需求，作下轮小项（上游工具已在 doctor 契约里钉住）。
6. app_bundle_map 缺 "Code" 人名别名（"vscode" 可用）——微小 UX 项。
7. yargs 无 strict：上游 flag 拼错静默哑弹——现有 INV-79 已钉住当前五个 flag 字面量，未来加 flag 时保持「新增必进 INV」纪律即可。

## 6. 裁决

**ROUND-PASS（修复后）**。16/16 项实施质量整体扎实（T1 契约纠错、T13 selftest、T11 保守三态、T15 接线均超预期），但存在 2 个 🔴（F2 编号漂移、F3 伪造 UA token）+ 4 个次要缺陷，全部由本次审查发现并修复，门禁与真机复测全绿。F2 的教训入库：**同轮多个各自正确的 diff 在跨 diff 接缝上错配，只有值级 trace + 真机能抓**（03 §1.4-1 / §2.3-3 的直接验证）。

- Reviewed-by: round1-review03（六维 + 五阶段 + 独立 producer 白盒 + 真机）
- 承接：遗留 7 项入下轮调优输入清单（§5）
