# parse15-acceptance — Lasso v1.7 creepjs 回归门禁 + Stagehand 探测 手测清单

> **版本**：v1.7.0（INV-63 三处对齐：package.json + index.ts + doctor.ts = "1.7.0"）
> **基线**：v1.6（1593 TS + 74 invariants + 179 Rust）→ v1.7（1636 TS + 75 invariants + 179 Rust）
> **零回归**：+43 TS 测试 / +1 INV / +0 Rust；rust-helper/ 零改；四通道运行时路径零改
> **上游**：parse15.md（v1.7 双主题执行计划）+ 架构想法/03 §1 六维度审查

---

## 0. 诚实定位声明（parse15 §1.2 + §8.1 核心诚实点）

### creepjs 回归门禁 = **回归门禁（防退化锚），不是 stealth 质量分数**

**白盒证据**（abrahamjuliot/creepjs 真读）：

1. Lasso v1.5 的 16 路 JS `defineProperty` evasion **结构性命中** creepjs prototype lie 检测点：
   - `Navigator.webdriver` / `Navigator.languages` / `Navigator.plugins` / `Navigator.vendor` / `Navigator.hardwareConcurrency`
   - `WebGLRenderingContext.getParameter`
   - `Permissions.query`
2. 这是 **JS defineProperty 范式的结构性上限，不是 bug**——`defineProperty` 造 own property，原生在 prototype，creepjs `getPrototypeLies` 检出这一差异。
3. 要跑出 creepjs 低 lies 数 = 需 C++ 源码级补丁 = Camoufox 范式 = **v2.0+ 架构扩张**，不在 v1.7。

**因此**：
- **v1.7 creepjs 门禁的定位**：冻结 v1.7 时刻的 lies 基线（characterization snapshot），后续 PR 不得使 lies 数恶化（tolerance.totalLiesDelta=0）。
- **不为「跑出高 trust score」而做**——Lasso JS 路线跑不出低 lies，这是范式上限。
- **为 v1.8 Obscura（TLS 层 stealth）提供对照基线**——Obscura 不走 JS defineProperty，lies 数应显著低于 Lasso JS 路线。

### Stagehand REST 契约 = **虚构确认（R-ECO-6），v1.7 探测+标记不重写**

- `StagehandChannel.ts:196-206` 的 `POST api.stagehand.dev/{verify|extract}` 在 stagehand 上游 repo（browserbase/stagehand）无源码佐证。
- Stagehand 实际是 Playwright-extension SDK（`page.act/extract/observe/verify`），非 REST 客户端。
- v1.7 的「对齐」= doctor #39 HEAD 探测裁决 R-ECO-6 + 头注释标记 + 留 v1.8 决删/重写。

---

## 1. CI 自动化覆盖（1636 TS + 75 invariants 全绿）

### 1.1 新增 TS 测试（+43）

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `test/unit/creepjs-probe.spec.ts` | ~25 | probeCreepjs 全路径（navigate/wait/evaluate 成功+失败；字段集契约；opts.timeoutMs；CREEPJS_LIES_EXTRACT_SCRIPT 顶级 const 守护） |
| `test/unit/doctor-v17-integration.spec.ts` | 18 | runDoctor #38 编排层（默认 skip / provider null / baseline pending / 退化 fail / 持平 pass / 改善 pass / fingerprintComputed=false warn / baseline 缺失 warn）+ #39 mock fetch（404 warn / 2xx pass / throw warn / 永不 fail）+ 结构对齐（#38/#39 存在 + version 1.7.0） |

### 1.2 新增 INV-75（7 条断言）

`INV-75-creepjs-gate-pure-doctor-side-zero-regression`：
- (a) creepjs-probe.ts 在 src/doctor/ 下（不在 src/channels/ 或 src/browse/）
- (b) CREEPJS_LIES_EXTRACT_SCRIPT 是顶级 const（不从 process.env / config 读）
- (c) creepjs-baseline.json fixture 存在含 totalLies + tolerance + rationale + _honest_positioning
- (d) probeCreepjs 仅 doctor/ 下 import（grep 守：不入运行时四通道）
- (e) runDoctor 默认 stealthCheck=false（warn-skip）
- (f) StagehandChannel.ts 头注释含 R-ECO-6 标记（前 30 行）
- (g) CreepjsLiesReport 含 reachable/fingerprintComputed/totalLies/liedModules 字段

### 1.3 mutation testing（03 §2.1 项4）

totalLies 比对逻辑 `report.totalLies > baselineTotalLies + tolerance`（doctor.ts:2610）：
- `>`→`>=` mutant 被「totalLies 持平 → pass」用例杀死（持平变 fail → 断言失败）
- `>`→`==` mutant 被「totalLies 退化 → fail」用例杀死（退化不再 fail）
- 覆盖在 `doctor-v17-integration.spec.ts` baseline 比对逻辑组

---

## 2. 手测清单（CI 无法代劳：需本机 Chrome 9222 + 真网）

### 2.1 creepjs 页面实跑（parse15 §5.4 步骤 1-3）

**前置**：本机 Chrome 已开 `--remote-debugging-port=9222`

- [ ] **#1 doctor 默认 → #38 warn-skip**
  ```
  lasso doctor
  ```
  预期：`stealth_creepjs_regression` status=warn，detail 含 `stealthCheck=false`

- [ ] **#2 doctor --stealth-check → #38 实跑 creepjs**
  ```
  lasso doctor --stealth-check
  ```
  预期：`stealth_creepjs_regression` status=warn（baseline pending freeze），detail 含实跑数值 `totalLies=N, navigatorLied=true, liedModules=[...]`

- [ ] **#3 首次 freeze baseline**
  把 #2 实跑结果写入 `src/doctor/fixtures/creepjs-baseline.json`：
  - `frozenAt` → 当前 ISO 时间
  - `baseline.totalLies` → 实跑 N
  - `baseline.navigatorLied` → 实跑 bool
  - `baseline.liedModules` → 实跑数组
  - `creepjsPageSha` → 对 creepjs index.html 算 sha256
  - `_freeze_status` → `"frozen"`

- [ ] **#4 二次跑 → #38 pass（totalLies 持平 baseline）**
  ```
  lasso doctor --stealth-check
  ```
  预期：`stealth_creepjs_regression` status=pass，detail 含 `持平/改善`

### 2.2 回归检测验证（parse15 §5.4 步骤 5）

- [ ] **#5 手动破坏一路 evasion → #38 fail**
  临时改 `src/browse/stealth-evasions/navigator-vendor.ts`（注入 bug / 删除一路）→ 跑 `lasso doctor --stealth-check` → 预期 `stealth_creepjs_regression` status=fail，detail 含 `退化`（totalLies 增加）
  验证后 **git checkout** 还原

### 2.3 Stagehand REST 探测（parse15 §3.4）

- [ ] **#6 doctor（默认含 #39）→ stagehand_rest_contract_probe**
  ```
  lasso doctor
  ```
  预期：`stagehand_rest_contract_probe` status=warn（404）或 pass（2xx）；detail 含 R-ECO-6 裁决文案

  **注**：预期大概率 warn（404 / DNS 不解析）——REST 契约虚构。若实跑返 pass（2xx），说明 stagehand 上游新加了 REST endpoint → R-ECO-6 反驳 → 需更新文档。

### 2.4 creepjs 上游升级检测

- [ ] **#7 creepjsPageSha 变 → warn（提示重 freeze）**
  若 creepjs 上游升级（页面 HTML 结构变）→ `creepjsPageSha` 不匹配 → #38 warn 提示重 freeze（不是 Lasso 回归）
  **注**：此项仅在 creepjs 上游发版后才能验；当前 skip

---

## 3. 六维度审查结果（架构想法/03 §1）

### 3.1 审查范围

v1.7 全部改动：
- 新文件：`src/doctor/creepjs-probe.ts`（326 行）+ `src/doctor/fixtures/creepjs-baseline.json`（21 行）
- 改文件：`src/doctor/doctor.ts`（+~280 行：#38/#39 check + DoctorOptions + 装配）+ `src/channels/StagehandChannel.ts`（+8 行头注释）+ `src/invariants/check-invariants.mjs`（+~120 行 INV-75）
- 新测试：`test/unit/creepjs-probe.spec.ts`（426 行 ~25 用例）+ `test/unit/doctor-v17-integration.spec.ts`（18 用例）
- 零改：rust-helper/ + 四通道运行时路径 + stealth-profiles.ts + stealth-evasions/*.ts

### 3.2 六维度过审

| 03 维度 | 结果 | 证据 |
|---|---|---|
| **§1.1 代码规范** | ✅ pass | 命名/格式同既有范式（CHECK_NAME / DoctorCheck pattern）；注释解释 WHY（parse15 引源 + 诚实定位）；测试名读作领域行为 |
| **§1.2 数据逻辑** | ✅ pass | **producer 契约**：navigate_page/wait_for/evaluate_script 引 chrome-devtools-mcp 既有范式（doctor.ts checkCdpMcpPdfToolAvailable 同 callTool）；window.Fingerprint 引 creep.ts 末段 L1 证据；lies.totalLies 引 lies/index.ts L1 证据。**字段缺失语义**：每字段 typeof/Array.isArray/`!!` 守卫。**错误处理**：navigate/wait/evaluate/parse/baseline-read 五条 try/catch 显式 graceful 不抛。**宿主执行**：creepjs 在真 Chrome 跑（非 spec），window.Fingerprint 是 L3 证据 |
| **§1.3 业务逻辑** | ✅ pass | **edge cases**：totalLies=0 / baseline pending / fingerprintComputed=false / baseline 文件缺失 / clientProvider null 全覆盖。**业务规则不散布**：creepjs 逻辑全部在 creepjs-probe.ts + doctor #38 |
| **§1.4 端到端接通** | ✅ pass | **值级 trace**：navigate → wait "FP ID:" → evaluate → JSON.parse → CreepjsLiesReport → baseline 比对 → pass/fail/warn。**producer → first-consumer 接缝**：firstText extraction（同 StealthEngine.ts:223 范式）。**集成测试**：doctor-v17-integration.spec.ts 18 用例覆盖 #38/#39 全判定矩阵 |
| **§1.5 性能 + 生产就绪** | ✅ pass | **Heisenbug 纪律**：creepjs 异步计算（spawnWorker + Promise.all）用 wait_for 而非 sleep。**feature flag**：stealthCheck 默认 false。**rollback**：stealthCheck=false 即禁。**永不 fail 范式**：#38/#39 非阻断 check（warn 不进 blockers 除退化） |
| **§1.6 简单架构** | ✅ pass | **代码健康**：纯增量（新文件 + 新 check），不动既有 stealth/四通道。**过工程化拒绝**：Stagehand SDK 重写明否决（架构冲突 + 零需求）；creepjs 本地 vendor 留 v1.8。**02 静态规则**：INV-75 grep 守 creepjs 不入运行时 |
| **§1.7 冗余与废弃** | ✅ pass | **死代码**：无。**废弃文档**：StagehandChannel 头注释更新 R-ECO-6。**跨边界同步对**（§1.7.7）：CreepjsLiesReport 接口 ↔ CREEPJS_LIES_EXTRACT_SCRIPT 输出 ↔ creepjs-baseline.json 字段 ↔ checkStealthCreepjsRegression 读取——四处字段集显式枚举配对（probe 接口 doc 注释明示） |

### 3.3 审查发现的问题（0 阻断 / 0 强制审视 / 全过）

六维度审查未发现 🔴 阻断项或 🟡 强制审视项。Phase A 实现质量高，Phase B 补的集成测试覆盖了 parse15 §5.2 要求的全部编排层用例 + mutation killer。

---

## 4. 文件清单

### 新增（4 个）
- `src/doctor/creepjs-probe.ts` — creepjs 回归探测核心（probeCreepjs + CREEPJS_LIES_EXTRACT_SCRIPT）
- `src/doctor/fixtures/creepjs-baseline.json` — v1.7 回归基线（pending-realrun freeze）
- `test/unit/creepjs-probe.spec.ts` — probeCreepjs 单测（~25 用例）
- `test/unit/doctor-v17-integration.spec.ts` — #38/#39 集成测（18 用例；Phase B 补）

### 修改（4 个，零回归）
- `src/doctor/doctor.ts` — #38 stealth_creepjs_regression + #39 stagehand_rest_contract_probe + DoctorOptions 字段
- `src/channels/StagehandChannel.ts` — 头注释 R-ECO-6 标记（零代码改动）
- `src/invariants/check-invariants.mjs` — INV-75（7 条断言）
- `package.json` — version 1.7.0

### 零改（红线）
- `rust-helper/` — 零改
- `src/browse/StealthEngine.ts` / `stealth-profiles.ts` / `stealth-evasions/*.ts` — 零改
- 四通道运行时路径（`src/channels/` BrowseChannel / HeadlessChannel / BrowserbaseChannel / SteelChannel）— 零改

---

## 5. 验收矩阵

| 项 | 通过标准 | 状态 |
|---|---|---|
| npm run build | tsc 零错 | ✅ pass |
| npm test | 1636 pass + 1 skip（v1.6 的 1593 全绿 + 43 新增） | ✅ pass |
| npm run check-invariants | 75/75（INV-75 新增 + 既有 74 不退步） | ✅ pass |
| INV-63 三处版本对齐 | package.json + index.ts + doctor.ts = "1.7.0" | ✅ pass |
| rust-helper/ 零改 | git 无 diff | ✅ pass |
| #38 默认 warn-skip | stealthCheck=false → warn | ✅ pass（CI + 手测 #1） |
| #38 baseline 比对 | 退化→fail / 持平→pass / 改善→pass | ✅ pass（CI 集成测） |
| #39 永不 fail | 404/throw → warn | ✅ pass（CI mock fetch） |
| creepjs 页面实跑 | --stealth-check 返 totalLies + liedModules | ⏳ 待手测 #2（pending freeze） |
| Stagehand 探测实跑 | #39 返 warn（404 预期）或 pass | ⏳ 待手测 #6 |
| creepjs 回归检测 | 破坏 evasion → #38 fail | ⏳ 待手测 #5 |

---

**parse15-acceptance 结束。** CI 全绿 + 手测清单 7 条（4 条待真机 Chrome 9222 实跑）。creepjs 门禁的诚实定位（防退化锚，非质量分数）须在用户期待管理中显式承认。
