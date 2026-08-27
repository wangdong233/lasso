# parse15 — Lasso v1.7 creepjs 回归门禁 + Stagehand 对齐 文件/函数级执行计划

> **作者**：Lasso 功能分析师（白盒源码审查 + creepjs/stagehand 真读，拒绝猜测）
> **基线**：v1.6（1593 TS 测试 + 74 invariants 全绿；`doctor.ts:131` `LASSO_VERSION="1.6.0"`）；Lasso MIT
> **上游**：doc/16 §5 P2 建议 3（Stagehand 对齐，L335-345）+ 建议 4（creepjs 回归门禁，L349-357）+ §7 v1.7 路线（L449）+ R-ECO-6/R-ECO-8（L507-509）/ 架构想法/03 审查清单
> **立场红线**：v1.6 零回归（1593 TS + 74 INV 不退步）；白盒——每条引源码/repo 证据；诚实——v1.7 范围据可行性判定调整，不值得做的明说。

---

## 1. v1.7 目标与范围

### 1.1 双主题的来源（doc/16 §5 + §7 白盒判定）

doc/16 §7 路线（L449）原文：「v1.7 doctor 集成 creepjs 回归门禁 + 对齐 StagehandChannel ← 可观测性 + 修正，2-3 天」。

两个主题分属两类工作：
- **creepjs 回归门禁**（建议 4，L349-357）：**可观测性增强**——给 StealthEngine 加一把度量衡，结束隐身能力盲改
- **Stagehand 对齐**（建议 3，L335-345）：**修正**——白盒审查发现 `StagehandChannel.ts:196-206` REST 契约 `api.stagehand.dev/{verify|extract}` 在上游 repo 无源码佐证（R-ECO-6），需 doctor 探测裁决

### 1.2 creepjs 可行性判定：**可行——但定位为「回归门禁」非「质量分数」**（关键诚实点）

**白盒证据**（abrahamjuliot/creepjs 真读）：

1. **可自动化**（creep.ts L 末段 + README「Interact with the fingerprint objects」段）：creepjs 计算完成后把完整指纹对象挂在 `window.Fingerprint`（loose）和 `window.Creep`（stable）两个全局变量上——这是**程序化访问入口**，不必截图人工看。creep.ts 原文：`window.Fingerprint = JSON.parse(JSON.stringify(fp))` / `window.Creep = JSON.parse(JSON.stringify(creep))`。

2. **lies 可量化**（`src/lies/index.ts` 真读）：`getLies()` 返回 `{ data: Record<string, string[]>, totalLies: number }`——每个被检出篡改的 API 是一个 key，value 是 lie 类型数组；`totalLies` 是总数。这正是回归门禁需要的量化信号。

3. **关键诚实约束（必须在 v1.7 文档显式承认）**：creepjs 的 `getPrototypeLies`（lies/index.ts）对 `Navigator` 显式搜 `webdriver / languages / plugins / vendor / hardwareConcurrency / userAgent / platform / Permissions.query / WebGLRenderingContext.getParameter / Math.* / CanvasRenderingContext2D.*` 等。**Lasso v1.5 的 16 路 evasion 正好命中这些检测点**——逐路映射（`stealth-profiles.ts:219-246` CORE 3 路 + `stealth-evasions/*.ts` 12 路 vendored）：

   | Lasso 路 | creepjs 检测点（lies/index.ts `searchLies` target） | 是否被检出 |
   |---|---|---|
   | 路 1 `navigator.webdriver` defineProperty | `Navigator.webdriver` + `failed undefined properties`（defineProperty 造 own property，原生在 prototype） | **是**（结构性） |
   | 路 2 `navigator.languages` defineProperty | `Navigator.languages` 同上 | **是** |
   | 路 3 `permissions.query` 重赋值 | `Permissions.query` + `failed toString`（Function.prototype.toString 不返 `[native code]`） | **是** |
   | 路 8 `navigator.plugins` defineProperty | `Navigator.plugins` + `getPluginLies`（MimeType constructor 校验） | **是**（高概率） |
   | 路 9 `navigator.vendor` defineProperty | `Navigator.vendor` | **是** |
   | 路 10 `hardwareConcurrency` defineProperty | `Navigator.hardwareConcurrency` | **是** |
   | 路 12 `webgl.vendor` getParameter proxy | `WebGLRenderingContext.getParameter` | **是** |

   doc/16 建议 6（Camoufox，L383-394）已明确这一上限：「Lasso 的 `STEALTH_INJECTION_SCRIPT` 正是这种被判为弱方案的范式」「把 Lasso 的 stealth 定位为『过 sannysoft / 基础 bot 检测，**不承诺过 CreepJS / Datadome / Kasada**』」。

   **因此 v1.7 creepjs 门禁的定位不是「跑出高 trust score」**（JS defineProperty 范式结构性过不了 prototype lie 检测）**，而是**：
   - **冻结 v1.7 时刻的 lies 基线**（characterization snapshot，03 §2.3 项5 golden suite 范式）
   - **后续 PR 不得使 lies 数恶化**（回归门禁 = 防退化，不是达标线）
   - **为 v1.8 Obscura（TLS 层 stealth）提供对照基线**——Obscura 不走 JS defineProperty，lies 数应显著低于 Lasso JS 路线，门禁能量化这一差异

### 1.3 Stagehand 对齐必要性判定：**R-ECO-6 确认——REST 契约虚构，但 v1.7 范围 = 探测+文档，不重写**

**白盒证据**：
- Lasso 现状：`StagehandChannel.ts:122` endpoint 默认 `https://api.stagehand.dev`；`:196-206` `POST ${endpoint}/${action}`（action ∈ verify|extract）；依赖 `STAGEHAND_API_KEY`（`:118` 构造参数）。
- Stagehand 上游真相（npm `@browserbasehq/stagehand` + stagehand.dev + 搜索结果一致）：Stagehand 是 **Playwright-extension SDK**（repo `browserbase/stagehand`，非 `browserbasehq/stagehand`——后者 zread 404 的原因），核心 API 是 `page.act() / page.extract() / page.observe() / page.verify()`，**进程内 SDK 调 Playwright，不是 REST 客户端**。doc/16 R-ECO-6（L507）「StagehandChannel REST 契约不存在 / 高概率 / doctor 探测」判定成立。

**v1.7 对齐的三选项裁决**：

| 选项 | 内容 | 代价 | v1.7 取舍 |
|---|---|---|---|
| A. 探测 + 文档标记（**推荐**） | doctor HEAD 探 `api.stagehand.dev/verify` 确认 404；StagehandChannel.ts 头注释标记「REST 契约未验证，待用户需求驱动」 | ~0.5 天 | ✅ 取 |
| B. 重写为 SDK 直连 | `npm i @browserbasehq/stagehand` + SubprocessManager 起本地 Stagehand（Playwright 进程） | 高：Stagehand 依赖 Playwright（非 chrome-devtools-mcp@0.3.0 CDP 路径），与 Lasso 全栈架构冲突（同 Camoufox 范式冲突，doc/16 §6.3 L425）；且零用户需求 | ❌ 不取（03 §1.6 项3 过工程化拒绝——「只解已知问题；未来问题等它真正到来」） |
| C. 删除 StagehandChannel | 移除 `StagehandChannel.ts` + STAGEHAND provider | 中：改 index.ts 装配 + INV-23/INV-25 守护 + 测试 | ❌ v1.7 不取（无用户报障先保留；留 v1.8 据探测结果决） |

### 1.4 v1.7 范围（M = 必须 / O = 可选）

| 子功能 | 优先级 | 落到模块 | 来源 |
|---|---|---|---|
| doctor #38 `stealth_creepjs_regression`（opt-in 浏览器实跑 + lies 解析 + 基线比对） | M | `src/doctor/doctor.ts` 新增 check + `src/doctor/creepjs-probe.ts`（新文件） | 建议 4 |
| creepjs lies 基线 fixture（v1.7 freeze 一次实跑捕获） | M | `src/doctor/fixtures/creepjs-baseline.json`（新文件） | 03 §2.3 项5 golden suite |
| doctor #39 `stagehand_rest_contract_probe`（HEAD 探测确认 R-ECO-6） | M | `src/doctor/doctor.ts` 新增 check | 建议 3 + R-ECO-6 |
| StagehandChannel.ts 头注释 + deprecation 标记 | M | `src/channels/StagehandChannel.ts:1-25` | 建议 3 动作 B |
| DoctorOptions 加 `stealthCheck?: boolean` + `stealthCheckProfile?: StealthProfileName` | M | `src/doctor/doctor.ts:241-398`（DoctorOptions 接口） | 建议 4 |
| INV-75（creepjs 门禁零回归守护） | M | `src/invariants/check-invariants.mjs` | R-CI-02 |

**v1.7 不做**：Stagehand SDK 重写（选项 B）/ StagehandChannel 删除（选项 C）/ creepjs 本地 vendor（R-ECO-8 缓解留 v1.8+ 若在线依赖证 fragil）。

---

## 2. 文件结构

### 2.1 新增文件（2 个）

```
src/doctor/creepjs-probe.ts                    # creepjs 回归探测逻辑（navigate + evaluate + parse），~220 行
src/doctor/fixtures/creepjs-baseline.json      # v1.7 freeze 基线（lies 快照 + 字段集 + creepjs commit SHA），~60 行
```

### 2.2 修改文件（4 个，全部增量、零回归）

```
src/doctor/doctor.ts                # 加 #38/#39 check + DoctorOptions 字段 + runDoctor 装配（~+120 行）
src/channels/StagehandChannel.ts    # 头注释加 R-ECO-6 标记（~+8 行注释，零代码改动）
src/invariants/check-invariants.mjs # 加 INV-75（creepjs 门禁零回归守护）（~+25 行）
src/browse/StealthEngine.ts         # 暴露 `injectProfileForProbe` test-only 入口（~+15 行，复用既有 injectProfile）
```

### 2.3 不动的文件（零回归承诺）

`stealth-profiles.ts` / `stealth-evasions/*.ts` / `BrowserbaseChannel.ts` / `SteelChannel.ts` / `HeadlessChannel.ts` / `index.ts`（装配） / 四通道运行时路径——**全部不动**。creepjs 门禁纯 doctor 侧（不入运行时；doc/16 建议 4 原文「完全绕开四通道，不碰运行时路径」）。

---

## 3. 各模块实施细节

### 3.1 `src/doctor/creepjs-probe.ts`（新文件，核心）

**职责**：给定一个 McpClient（已连 chrome-devtools-mcp 且 StealthEngine 已注入），驱动一次 creepjs 回归探测，返回结构化 lies 报告。

**函数签名**：
```typescript
export interface CreepjsLiesReport {
  reachable: boolean;                // creepjs 页面是否加载成功
  fingerprintComputed: boolean;      // window.Fingerprint 是否非空（计算完成）
  totalLies: number;                 // getLies().totalLies
  liedModules: string[];             // 被检出 lie 的模块名（keys of fingerprint.*.lied=true）
  navigatorLied: boolean;            // fingerprint.navigator?.lied（最关键，Lasso defineProperty 主战场）
  screenLied: boolean;
  canvasWebglLied: boolean;
  canvas2dLied: boolean;
  permissionsLied: boolean;
  webglGetParameterLied: boolean;
  creepjsVersion: string;            // 页面 footer / hash 标识（判 creepjs 上游升级）
  elapsedMs: number;
  rawSample: string;                 // JSON.stringify(window.Fingerprint.lies).slice(0,500)（诊断用）
}

export async function probeCreepjs(
  client: McpClient,
  opts: { url?: string; timeoutMs?: number },
): Promise<CreepjsLiesReport>
```

**实施步骤（逐跳值级 trace）**：

1. `client.callTool("navigate_page", { type: "url", url: opts.url ?? "https://abrahamjuliot.github.io/creepjs/" })` → 等页面加载（producer 契约：chrome-devtools-mcp navigate_page 返 content blocks；`doctor.ts` 既有 `checkCdpMcpPdfToolAvailable` 同 callTool 范式）

2. `client.callTool("wait_for", { text: ["FP ID:"], timeout: 15000 })` → 等 creepjs 计算 完成（creep.ts 渲染 `FP ID: <hash>` 标志计算完成；`StealthEngine.ts:104-124` detectCloudflareChallenge 已用 `wait_for`/evaluate 范式）。**这是关键 producer 契约验证点**（03 §1.2 项1）：creep.ts 末段 `patch(document.getElementById('creep-fingerprint'), ...)` 在 fingerprint 完成后才渲染 "FP ID:"，故 wait_for "FP ID:" 命中即 `window.Fingerprint` 已 populate。

3. `client.callTool("evaluate_script", { function: CREEPJS_LIES_EXTRACT_SCRIPT })` → 读 `window.Fingerprint`。脚本（顶级 const，本文件内）：
   ```javascript
   (function(){
     try {
       var fp = window.Fingerprint;
       if (!fp) return JSON.stringify({fingerprintComputed:false});
       var nav = fp.navigator || {}, scr = fp.screen || {}, c2d = fp.canvas2d || {},
           cgl = fp.canvasWebgl || {}, lies = fp.lies || {};
       return JSON.stringify({
         fingerprintComputed: true,
         totalLies: lies.totalLies || 0,
         liedModules: Object.keys(fp).filter(function(k){ return fp[k] && fp[k].lied; }),
         navigatorLied: !!nav.lied,
         screenLied: !!scr.lied,
         canvas2dLied: !!c2d.lied,
         canvasWebglLied: !!cgl.lied,
         creepjsVersion: (document.querySelector('.fingerprint-header .time')||{}).textContent || ''
       });
     } catch(e) { return JSON.stringify({fingerprintComputed:false, error:String(e).slice(0,200)}); }
   })();
   ```

4. 解析 evaluate_script 返（`firstText()` 解 content[0].text，复用 `StealthEngine.ts:223-229` firstText 范式）→ JSON.parse → CreepjsLiesReport

5. 错误路径（每条显式，03 §1.2 项7）：
   - navigate 失败（网络错 / timeout）→ `reachable:false` + 其余字段 false/0
   - wait_for timeout（15s 内未出现 "FP ID:"）→ `reachable:true, fingerprintComputed:false`（creepjs 脚本未跑完或被 CSP/扩展拦）
   - evaluate 返非 JSON / fingerprintComputed:false → 同上
   - evaluate 抛错 → catch 返 `fingerprintComputed:false, error`

**CREEPJS_LIES_EXTRACT_SCRIPT 顶级 const**（INV-30 衍生：脚本数据走顶级 const，不从 env/config 读——防 LLM 改探测脚本伪造分数）。

### 3.2 `src/doctor/fixtures/creepjs-baseline.json`（新文件，v1.7 freeze 一次捕获）

**形态**（03 §2.3 项5 golden snapshot；非确定性字段 normalize 后比较）：
```json
{
  "frozenAt": "2026-08-10T00:00:00Z",
  "lassoVersion": "1.7.0",
  "creepjsPageSha": "<abrahamjuliot.github.io/creepjs index.html sha256, 检测上游变动>",
  "profile": "windows_chrome_120",
  "baseline": {
    "totalLies": <N>,
    "navigatorLied": true,
    "screenLied": <bool>,
    "canvasWebglLied": <bool>,
    "liedModules": [...]
  },
  "tolerance": { "totalLiesDelta": 0 },
  "rationale": "v1.7 freeze: Lasso JS defineProperty 范式结构性被 creepjs prototype lie 检测命中（doc/16 建议 6 Camoufox 批评成立）。本基线是回归门禁的退化检测锚点，不是质量达标线。"
}
```

**freeze 流程**（v1.7 实施期一次性）：
1. 实装 creepjs-probe.ts + doctor #38
2. `lasso doctor --stealth-check --stealth-profile windows_chrome_120` 跑一次（本机 Chrome 9222 已开）
3. 把返出的 CreepjsLiesReport 写进 baseline.json（`totalLies / liedModules / navigatorLied` 等字段）
4. `creepjsPageSha` = 对 `https://abrahamjuliot.github.io/creepjs/` 的 index.html 算 sha256（判 creepjs 上游升级致基线漂移）

**tolerance.totalLiesDelta=0**（零容忍退化）：后续 PR 若 totalLies 增加（新引入 lie / 破坏既有 evasion）→ #38 fail。若 creepjs 上游升级致 totalLies 变（creepjsPageSha 变）→ #38 warn（提示重 freeze 基线，不是 Lasso 回归）。

### 3.3 doctor #38 `stealth_creepjs_regression`（doctor.ts 新增 check）

**装配位置**：`runDoctor` 内 L656-663（Steel #37 push）之后、L665（blockers filter）之前。

**DoctorOptions 新字段**（`doctor.ts:241-398` DoctorOptions 接口）：
```typescript
/** v1.7：opt-in creepjs 隐身回归探测（默认 false——需浏览器实跑，重） */
stealthCheck?: boolean;
/** 探测用 stealth profile（默认 windows_chrome_120） */
stealthCheckProfile?: StealthProfileName;
/** 注入已连 9222 的 McpClient provider（CLI 模式不注入 → warn skip） */
stealthCheckClientProvider?: () => Promise<McpClient | null>;
```

**check 逻辑**（仿 #28-30 profilesChecksProvider 注入范式 + #37 Steel 双重解锁范式）：
```typescript
// 1. 默认 false → warn skip（doctor CLI 不实跑浏览器；零回归）
if (!opts.stealthCheck) {
  checks.push({ name: "stealth_creepjs_regression", status: "warn",
    detail: "skipped (stealthCheck=false；--stealth-check 显式开)" });
} else if (!opts.stealthCheckClientProvider) {
  // 2. flag 开但无 provider（CLI 模式）→ warn
  checks.push({ name: "stealth_creepjs_regression", status: "warn",
    detail: "stealthCheck=true 但 clientProvider 未注入（doctor tool 经 index.ts v1.7 装配注入）" });
} else {
  // 3. provider 注入 → 实跑
  checks.push(await checkStealthCreepjsRegression({
    clientProvider: opts.stealthCheckClientProvider,
    profile: opts.stealthCheckProfile ?? "windows_chrome_120",
    skipNetwork: opts.skipNetwork,
  }));
}
```

**`checkStealthCreepjsRegression` 实装**：
1. skipNetwork=true → warn-skip（同 #3/#4/#21 范式）
2. `const client = await opts.clientProvider()` → null → warn（9222 未开 / HeadlessChannel 未就绪）
3. `await stealthEngine.injectProfile(client, opts.profile)`（复用 `StealthEngine.ts:65` injectProfile；**这是为什么 StealthEngine 要暴露 test-only 入口**——doctor 探测须注入与运行时一致的 16 路 evasion，否则测的不是 Lasso stealth）
4. `const report = await probeCreepjs(client, { timeoutMs: 30000 })`
5. 读 baseline fixture（`fs.readFile` creepjs-baseline.json）
6. 比对：
   - `!report.fingerprintComputed` → warn（creepjs 页面未跑完；非 Lasso 回归）
   - `report.totalLies > baseline.totalLies + tolerance.totalLiesDelta` → **fail**（退化）
   - `report.totalLies === baseline.totalLies` 且 liedModules 一致 → **pass**
   - creepjsPageSha 变（上游升级）→ warn（重 freeze 基线）
7. detail 含：`totalLies=${report.totalLies} (baseline ${baseline.totalLies}); navigatorLied=${report.navigatorLied}; modules=[${report.liedModules.join(',')}]`

### 3.4 doctor #39 `stagehand_rest_contract_probe`（doctor.ts 新增 check）

**目的**：用运行时证据（L2 真实流量）确认/否定 R-ECO-6（doc/16 L507），而非依赖白盒推断。

**实装**（仿 #21 `probeCloudEndpoint` / #37 Steel GET /health 范式，纯 fetch 不需浏览器）：
```typescript
async function checkStagehandRestContract(opts: {
  skipNetwork?: boolean;
}): Promise<DoctorCheck> {
  // 1. skipNetwork → warn-skip
  if (opts.skipNetwork) return { name:"stagehand_rest_contract_probe", status:"warn",
    detail:"skipped (skipNetwork=true)" };
  // 2. HEAD https://api.stagehand.dev/verify（3s 超时）
  try {
    const resp = await fetch("https://api.stagehand.dev/verify", {
      method: "HEAD", signal: AbortSignal.timeout(3000), redirect: "manual" });
    // 404 / 连接拒 → 契约不存在（R-ECO-6 确认）→ warn（不 fail：StagehandChannel 仍可降级保留）
    if (resp.status === 404 || resp.status === 0) {
      return { name:"stagehand_rest_contract_probe", status:"warn",
        detail:`api.stagehand.dev/verify → ${resp.status}（REST 契约不存在；R-ECO-6 确认；StagehandChannel 为 v0.4 设计期假设，observe 调用将失败）`,
        next_step:"v1.8 据用户需求决：删 StagehandChannel 或改 SDK 直连（成本高，架构冲突）" };
    }
    // 2xx → 契约存在（R-ECO-6 反驳）→ pass
    return { name:"stagehand_rest_contract_probe", status:"pass",
      detail:`api.stagehand.dev/verify → ${resp.status}（REST 契约存在；StagehandChannel 可用）` };
  } catch (e) {
    return { name:"stagehand_rest_contract_probe", status:"warn",
      detail:`api.stagehand.dev/verify 探测失败：${String(e).slice(0,100)}（按不存在处理）` };
  }
}
```

**永不 fail**（同 #37 Steel 范式）：契约不存在是已知状态，不是 Lasso ready 阻断项。

### 3.5 StagehandChannel.ts 头注释 R-ECO-6 标记（`StagehandChannel.ts:1-25`）

在既有头注释块（L1-25）追加（零代码改动）：
```
 * ⚠️ R-ECO-6（doc/16 §5 建议 3）：本通道 REST 契约 api.stagehand.dev/{verify|extract}
 *    在 stagehand 上游 repo（browserbase/stagehand）无源码佐证——Stagehand 实际是
 *    Playwright-extension SDK（page.act/extract/observe/verify），非 REST 客户端。
 *    doctor #39 stagehand_rest_contract_probe 将 HEAD 探测裁决。v1.7 不删不重写，
 *    据探测结果 + 用户需求在 v1.8 决。
```

### 3.6 INV-75（`src/invariants/check-invariants.mjs` 新增）

**守护内容**（零回归红线）：
```
INV-75-creepjs-gate-zero-runtime-regression:
  (a) creepjs-probe.ts 的 CREEPJS_LIES_EXTRACT_SCRIPT 是顶级 const（grep 守：不从 process.env / config 读）
  (b) creepjs-baseline.json 存在且含 totalLies 字段（防误删 fixture 致门禁失效）
  (c) checkStealthCreepjsRegression 默认 stealthCheck=false（grep 守：runDoctor 内默认 push warn-skip，不开浏览器）
  (d) creepjs 探测不经运行时四通道（grep 守：probeCreepjs 仅 doctor 调用，不出现在 src/channels/ / src/browse/StepEngine.ts）
```

---

## 4. 不明确点调研结论

### 4.1 creepjs 自动化解析可行性：**可行**（已验证）

| 问题 | 结论 | 证据 |
|---|---|---|
| 是否要截图人工看 trust score？ | **否**，程序化可读 | creep.ts 末段 `window.Fingerprint = ...` / `window.Creep = ...` 暴露完整对象 |
| 有无数字 trust score API？ | **无单一数字**（issues 说的 trust score 是页面展示，程序化访问是 per-module `lied` bool + `totalLies`） | lies/index.ts `getLies()` 返 `{data, totalLies}`；用 `totalLies` 作量化信号 |
| navigate + wait + evaluate 可行？ | **可行**，chrome-devtools-mcp 三工具齐全 | navigate_page / wait_for / evaluate_script（doctor.ts 既有 checkCdpMcpPdfToolAvailable 同 callTool 范式） |
| 在线依赖脆弱性？ | **中低**（R-ECO-8） | 官方页 abrahamjuliot.github.io/creepjs 稳定运行多年；opt-in flag + warn-on-unreachable 缓解；本地 vendor 留 v1.8+ |

### 4.2 Stagehand 上游变化：**架构根本冲突，不值得对齐**

| 问题 | 结论 | 证据 |
|---|---|---|
| Stagehand 是 REST 还是 SDK？ | **SDK**（Playwright extension） | npm `@browserbasehq/stagehand` / stagehand.dev「The SDK for browser agents」/ 搜索结果一致 |
| Lasso REST 契约真实吗？ | **不真实**（R-ECO-6 确认） | StagehandChannel.ts:196-206 `POST api.stagehand.dev/{action}` 在上游无对应 |
| Lasso v0.4 StagehandChannel 有无价值？ | **observe-only stub，契约虚构** | StagehandChannel.ts:131-138 capabilities canObserve=true/canAct=false；:270-282 act 显式返 didnt |
| 值得改 SDK 直连吗？ | **否** | Stagehand 依赖 Playwright（非 Lasso chrome-devtools-mcp@0.3.0 CDP），架构冲突同 Camoufox（doc/16 §6.3 L425）；零用户需求；03 §1.6 项3 过工程化拒绝 |
| v1.7 怎么对齐？ | **探测确认 + 文档标记，不重写不删** | #39 HEAD 探测 + 头注释 R-ECO-6 标记；删/重写留 v1.8 据用户需求 |

### 4.3 集成代价 vs 收益

| 主题 | 代价 | 收益 | 判定 |
|---|---|---|---|
| creepjs 门禁 | ~1.5 天（probe + check + baseline freeze + 测试） | 结束 stealth 盲改；为 v1.8 Obscura 对照奠基；防 16 路 evasion 意外破坏 | **值得做** |
| Stagehand 探测 | ~0.5 天（HEAD check + 头注释） | 用 L2 证据闭环 R-ECO-6；防后续维护者误信 REST 契约 | **值得做**（轻量） |
| Stagehand SDK 重写 | ~1-2 周 + 架构冲突 | 零新能力（Lasso 已有 chrome-devtools-mcp evaluate_script 等价 verify/extract） | **不值得** |

---

## 5. 测试计划

### 5.1 单元测试（`test/doctor/creepjs-probe.test.ts` 新文件）

| 用例 | 断言 |
|---|---|
| `probeCreepjs` navigate 失败 → reachable=false | mock McpClient navigate_page throw → report.reachable=false |
| `probeCreepjs` wait_for timeout → fingerprintComputed=false | mock wait_for throw → report.fingerprintComputed=false |
| `probeCreepjs` evaluate 返完整 lies → 各字段正确解析 | mock evaluate_script 返 fixture JSON → report.totalLies / navigatorLied 匹配 |
| `probeCreepjs` evaluate 返 fingerprintComputed=false（window.Fingerprint 未就绪） | report.fingerprintComputed=false |
| `probeCreepjs` evaluate 返非 JSON → 不崩 | report.fingerprintComputed=false + rawSample 含 error |
| `checkStealthCreepjsRegression` skipNetwork → warn-skip | status=warn |
| `checkStealthCreepjsRegression` totalLies 退化 → fail | report.totalLies=baseline+1 → status=fail |
| `checkStealthCreepjsRegression` totalLies 持平 → pass | report.totalLies=baseline → status=pass |
| `checkStealthCreepjsRegression` creepjsPageSha 变 → warn | status=warn（重 freeze 提示） |
| `checkStagehandRestContract` 404 → warn + R-ECO-6 文案 | mock fetch 404 → status=warn + detail 含 "R-ECO-6" |
| `checkStagehandRestContract` 2xx → pass | mock fetch 200 → status=pass |
| `checkStagehandRestContract` 网络错 → warn | mock fetch throw → status=warn |

**mutation testing**（03 §2.1 项4）：对 totalLies 比对逻辑注入 `>`→`>=` mutant，确认 fail 用例能抓（killer criterion）。

### 5.2 集成测试（`test/doctor/doctor-v17.test.ts` 新文件）

| 用例 | 断言 |
|---|---|
| runDoctor 默认（stealthCheck 不传）→ #38 warn-skip | checks 含 stealth_creepjs_regression status=warn |
| runDoctor stealthCheck=true 无 provider → #38 warn | status=warn + detail 含 clientProvider |
| runDoctor stealthCheck=true + provider mock → #38 实跑 | 调用 injectProfile + probeCreepjs（mock） |
| runDoctor 含 #39（默认跑，不需 flag） | checks 含 stagehand_rest_contract_probe |
| 全 check 数 = v1.6 的 37 + 2 = 39 | checks.length 验证 |

### 5.3 既有回归套件（零回归门禁）

- `npm run check-invariants`：74 → 75 INV 全绿（INV-75 新增 + 既有 74 不退步）
- `npm test`：1593 + 新增 ~14 用例 = ~1607 全绿；既有 1593 用例 byte-identical v1.6 行为
- INV-23/INV-25（Stagehand 不进 desktop fallback / 双重解锁）仍守（StagehandChannel.ts 零代码改动）

### 5.4 e2e 手测（v1.7 acceptance 清单，类比 parse14-acceptance）

1. `lasso doctor`（默认）→ #38 warn-skip + #39 探测（实跑或 warn）
2. `lasso doctor --stealth-check`（本机 Chrome 9222 已开）→ #38 实跑 creepjs，返 totalLies + liedModules
3. 首次 freeze：把实跑结果写进 creepjs-baseline.json
4. 二次跑：#38 pass（totalLies 持平 baseline）
5. 手动破坏一路 evasion（临时改 stealth-evasions/navigator-vendor.ts 注入 bug）→ #38 fail（totalLies 增加）

---

## 6. 验收标准 + 03 预设

### 6.1 功能验收

| 项 | 通过标准 |
|---|---|
| creepjs 门禁 opt-in 实跑 | `--stealth-check` 返 totalLies + liedModules（非空结构化数据） |
| 基线 fixture freeze | creepjs-baseline.json 含 totalLies + creepjsPageSha |
| 回归检测 | 故意破坏 evasion → #38 fail（totalLies 退化） |
| Stagehand 探测 | #39 返 warn（404）或 pass（2xx），detail 含 R-ECO-6 裁决 |
| 默认零回归 | 不传 stealthCheck → #38 warn-skip；既有 37 check 行为 byte-identical v1.6 |

### 6.2 03 审查清单对齐

| 03 维度 | 本 plan 如何满足 |
|---|---|
| §1.2 项1 producer 契约验证 | wait_for "FP ID:" 的 producer 契约引 creep.ts 末段 patch('creep-fingerprint') 渲染时机（L1 证据）；evaluate_script 返 content[0].text 引 StealthEngine.ts:223 firstText 范式 |
| §1.2 项8 宿主执行环境 | creepjs 在 chrome-devtools-mcp 控制的真实 Chrome 跑（非 spec），window.Fingerprint 是真机 L3 证据 |
| §1.5 项2 Heisenbug | creepjs 计算是异步（spawnWorker + Promise.all），wait_for 而非 sleep 等（不靠时序猜测） |
| §1.6 项1 代码健康 | creepjs 门禁纯增量（新文件 + 新 check），不动既有 stealth/四通道；StagehandChannel 零代码改 |
| §1.6 项3 过工程化拒绝 | Stagehand SDK 重写明否决（无需求 + 架构冲突）；creepjs 本地 vendor 留 v1.8（先验在线依赖稳定性） |
| §1.7 项7 跨边界同步对 | creepjs-baseline.json 字段 ↔ checkStealthCreepjsRegression 读取 ↔ probeCreepjs 返回——三处字段集显式枚举配对 |
| §2.3 项5 golden snapshot | creepjs-baseline.json 是 characterization test baseline；非确定性字段（creepjs 版本）normalize 比较 |
| §2.1 项4 mutation | totalLies 比对 `>` mutant 注入测试 |

---

## 7. 风险 + 实施顺序

### 7.1 风险登记

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-15-1 | creepjs 上游升级致 lies 检测逻辑变 → baseline 漂移致误报 | 中 | 中 | creepjsPageSha 检测 → warn 提示重 freeze（不 fail）；不是 Lasso 回归 |
| R-15-2 | abrahamjuliot.github.io 不可达（R-ECO-8） | 低 | 低 | opt-in flag + warn-on-unreachable；本地 vendor 留 v1.8+ |
| R-15-3 | Lasso JS stealth 全模块被检出 lie → totalLies 高 → 门禁无区分度 | 中 | 中 | 门禁是**防退化**不是达标；totalLies 持平即 pass；关键是模块集 + 数量稳定 |
| R-15-4 | creepjs 计算耗时长（>30s）致 doctor 超时 | 低 | 低 | timeoutMs=30000 + warn-on-timeout（不 fail）；实测 creep.ts 计算 ~1-3s |
| R-15-5 | StagehandChannel 留着误导用户以为可用 | 中 | 低 | 头注释 R-ECO-6 标记 + #39 warn；capabilities canObserve 仅 true 当 apiKey 配（无 apiKey 短路，StagehandChannel.ts:143-147） |

### 7.2 实施顺序（~2 天）

```
Day 1 上午：creepjs-probe.ts + 单测（mock McpClient）
Day 1 下午：doctor #38 check + DoctorOptions 字段 + StealthEngine test-only 入口 + 集成测
Day 2 上午：首次 freeze baseline（实跑本机 Chrome）+ INV-75 + Stagehand #39 + 头注释
Day 2 下午：全回归套件 + mutation test + e2e 手测 + parse15-acceptance 归档
```

---

## 8. 诚实判定

### 8.1 creepjs 门禁：**值得做，但范围诚实缩减**

doc/16 建议 4 原文「解析 window.Fingerprint/window.Creep 返回的 lies 数量，作为隐身回归门禁」——**白盒核实可行**，creepjs 确实程序化暴露这些对象（creep.ts 末段证据）。**但** doc/16 同篇 建议 6（Camoufox）已承认 Lasso JS defineProperty 范式**结构性过不了 creepjs prototype lie 检测**。两处建议合在一起的诚实结论：

- **creepjs 门禁不能定位为「隐身质量分数」**（Lasso JS 路线跑不出低 lies，这是范式上限不是 bug）
- **正确定位是「回归防退化锚」**——冻结 v1.7 基线，后续 PR 不得使 lies 数恶化；为 v1.8 Obscura（TLS 层）提供对照
- **若用户期待「creepjs 高分」**——明说做不到（需 C++ 源码级补丁 = Camoufox 范式 = v2.0+ 架构扩张，不在 v1.7）

**判定：做**，但 baseline.json 的 `rationale` 字段必须写明这一上限（已含于 §3.2 fixture 模板），防 CC/用户误判 Lasso stealth 能力边界。

### 8.2 Stagehand 对齐：**值得做（轻量探测），不值得重写**

doc/16 建议 3「对齐 StagehandChannel 集成方式」的白盒结论比原文更严峻：**REST 契约虚构确认**（Stagehand 是 Playwright SDK，非 REST）。v1.7 的「对齐」= 用 doctor #39 的 L2 证据闭环 R-ECO-6 + 头注释标记 + 留 v1.8 决删/重写。

**明说 v1.7 范围缩减**：
- **不做** Stagehand SDK 直连（选项 B）——架构冲突（Playwright ≠ chrome-devtools-mcp@0.3.0 CDP）+ 零用户需求，符合 03 §1.6 项3「只解已知问题」
- **不做** StagehandChannel 删除（选项 C）——v1.7 先探测 + 标记，让 #39 的运行时证据驱动 v1.8 决策，不在 v1.7 凭推断删代码

### 8.3 整体 v1.7 价值

| 维度 | v1.7 贡献 |
|---|---|
| StealthEngine 可观测性 | **首次有量化度量**（之前 16 路 evasion 全盲改；doc/16 建议 4 原文「隐身能力全是盲改」） |
| 架构债清理 | R-ECO-6 用 L2 证据闭环（之前是白盒推断） |
| v1.8 Obscura 奠基 | creepjs 基线 = Obscura TLS 路线的对照锚（能量化「JS 路线 lies=N，TLS 路线 lies=?」） |
| 零回归风险 | 纯 doctor 侧增量 + opt-in；四通道/运行时/既有 74 INV 零触碰 |

**结论：v1.7 范围合理，值得做**（~2 天），但必须带着 §1.2 + §8.1 的诚实定位（防退化锚，非质量达标线）。若团队期待 creepjs 门禁能让 Lasso 跑出「高 trust score」——**明说做不到，那是 v2.0+ Camoufox 范式扩张的事**。

---

**parse15 结束。** 下游执行者据 §2 文件结构 + §3 函数级实施细节 + §5 测试计划落地；§7.2 实施顺序排期；§8 诚实判定交用户裁决（特别是 creepjs 门禁的定位预期管理）。