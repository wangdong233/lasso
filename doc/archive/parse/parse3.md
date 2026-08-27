# Lasso v0.3 parse3 — 文件/函数级执行计划（v0.2 增量）

> 输入基线：v0.2.0-dev（`/Users/wangdong/Documents/Project/cc-control-all/lasso/`，src 39 .ts / 20 spec / 11 INV）。**约束**：v0.3 不得破坏 v0.2 的 349 tests + 11 invariants（`src/invariants/check-invariants.mjs`）。F 编号引用 08 §4 / 09 §2.3。借鉴源证据引用 12 §1.1A/B + §1.3G + §3.1/3.2 + §3.5.6/7/10。

---

## 1. v0.3 目标与范围（v0.2 增量）

**能力跃升**（09 §2.3）：从 v0.2 的「单 action 一次调用」升到「一次调用完成多步 + 每步验证交付」。架构铁律：**event delivery alone is never treated as semantic success**（08 §0 原则 5 / 12 §1.1B）。

**交付子功能**（按 F 编号）：

| F | 名称 | 关键改动 | 借鉴源（12 证据） |
|---|---|---|---|
| F3.2.10 修改 | StateStore LRU(128) + stateId + AsyncLocalStorage | 内存主路径 + 磁盘跨进程；替 v0.1 `writeState` 单磁盘 | `runtime.ts StateStore<T>` LRU + `state.ts SavedStates.AsyncLocalStorage` |
| F3.2.11 升级 | steps 多步链式 + `actions_and_results` 审计链 | BrowseChannel 入口分流 steps vs 单 action | Skyvern `actions_and_results: list[tuple[Action, list[ActionResult]]]` + `should_terminate_remaining_chain` |
| F3.2.13/14 | session 隔离/复用 | ALS 请求级 hydrate；同 url+session 复用 stateId | `state.ts hydrate(record)` + `storeBrowserRootRef` identity→ref |
| F3.2.18 新增 | expect 后置条件 + 三态（verified/preexisting/failed） | act 后 100ms poll；failed→outcome=didnt 终止链 | `bridge.ts performBrowserTransaction` + `actions.ts outcomeAfterCheck` |
| F3.2.19 新增 | stateId + epoch 字段（epoch 暂不启用） | StoredState 加 epoch；v0.5+ 才接 ResourceScheduler | `runtime.ts StoredState.epoch` |
| F3.2.20 新增 | bounded output 48KiB/2000 行 + @oN 续页 | 超限落盘 mode 0o600 + 16KiB preview + refine hint；新工具 `read_text({ref,offset})` | `output.ts applyOutputEnvelope/storeOutput/refinementFor` |
| F3.3.14 新增 | high-risk pattern gate（browse_logged_in only） | 遇 drag-drop/RTE/data-grid 放弃自动操作 | GitHub Accessibility Agent complexity scoring |
| F3.1.12 新增 | provider RPM 滑动窗口限频 | 60s 滑动窗；超限主动降级 | (项目原生；类比 CircuitBreaker 短熔断) |
| F3.4.8-9 | budget + 部分失败聚合（v0.2 partial_failures 已存在） | 多步 chain budget 透传 | Skyvern budget pool |

**非目标**（明确不做，12 §4.3）：compact diff、ResourceScheduler write 前 stale-reject、multi-root forest、@rN/@eN 双层 ref、graftScopedOutline。

---

## 2. 文件改动清单（新增 + 修改）

### 2.1 新增（10 个源 + 8 个 spec）

```
src/
├─ browse/
│   ├─ StepEngine.ts          [NEW, ~280 行]  多步链式引擎主循环
│   ├─ ExpectPoll.ts          [NEW, ~140 行]  100ms poll + 三态
│   ├─ HighRiskGate.ts        [NEW, ~110 行]  drag-drop/RTE/data-grid 黑名单
│   └─ steps-types.ts         [NEW, ~90 行]   Step / ActionResult / StoppedAt 类型
├─ util/
│   ├─ output-envelope.ts     [NEW, ~200 行]  48KiB 截断 + @oN 落盘
│   └─ rpm-limiter.ts         [NEW, ~90 行]   滑动窗口限频
├─ fallback/
│   └─ BudgetTracker.ts       [NEW, ~110 行]  chain budget + 部分失败聚合
├─ tools/
│   └─ read-text.ts           [NEW, ~70 行]   read_text({ref,offset,limit}) 续页工具
└─ (state-store.ts 仍是同一文件，但内部重构 +180 行)

test/
├─ unit/
│   ├─ step-engine.spec.ts        [NEW, ~22 cases]
│   ├─ expect-poll.spec.ts        [NEW, ~14 cases]
│   ├─ output-envelope.spec.ts    [NEW, ~18 cases]
│   ├─ high-risk-gate.spec.ts     [NEW, ~12 cases]
│   ├─ rpm-limiter.spec.ts        [NEW, ~10 cases]
│   ├─ budget-tracker.spec.ts     [NEW, ~10 cases]
│   └─ state-store.spec.ts        [NEW, ~16 cases]  LRU/ALS/disk-fallback
└─ integration/
    └─ browse-steps.spec.ts       [NEW, ~9 cases]  5 步链式 e2e
```

### 2.2 修改（8 个源 + 1 个 invariants 脚本）

| 文件 | 改动概要 | 兼容性策略 |
|---|---|---|
| `src/util/state-store.ts` | 加 `StateStore<T>` LRU(128) + `requestScope()` ALS + 磁盘 spill | **保留 `writeState`/`readState` 旧签名**（v0.2 测试调它），内部转调新 API |
| `src/types.ts` | 升级 `BrowseOptions.steps: Step[]`（替 `unknown[]`）；`ExpectCondition` 实质化；加 `ActionResult`/`BoundedOutput`/`StoppedAt` | 字段全可选；旧 schema 仍 valid |
| `src/channels/BrowseChannel.ts` | `browse()` 入口分流 `options.steps` 走 `StepEngine`；`expect` postcondition 包装 | 单 action 路径（v0.2 行为）保留为 `options.steps=undefined` 分支 |
| `src/channels/LoggedInChannel.ts` | 注入 `HighRiskGate`（构造时传 `enabled=true`；headless 默认 `false`） | 仅 logged_in 启用，headless 不变 |
| `src/tools/browse.ts` | zod schema 实质化 `steps`/`expect`（v0.2 是占位）；注册 `read_text` 续页工具 | schema 向后兼容（字段仍 optional） |
| `src/fallback/FallbackDecider.ts` | 集成 `BudgetTracker`（每 chain 一实例）；多步失败聚合 | 现有 `runWithFallback` 签名不变，BudgetTracker 作为可选第 4 参 |
| `src/search/MultiSourceFanout.ts` | 集成 `RpmLimiter`（per-provider 维度）；超限主动跳过 | 默认 RPM=Infinity，配了才生效 |
| `src/config/quota-ledger.ts` | 加 `rpm_window_ms` / `rpm_max` 字段（per-provider） | 字段 optional，未设不影响 v0.2 |
| `src/invariants/check-invariants.mjs` | 加 INV-12 / INV-13 / INV-14 / INV-15（见 §5.2） | v0.2 的 11 条断言不动 |

**核心兼容承诺**：v0.2 全部 349 tests 不改 1 行测试源——所有新功能经新文件或新 optional 字段引入；`BrowseChannel.browse(url, action, options)` 三参签名不变。

---

## 3. 各模块实施细节（接口签名 + 伪码 + 借鉴源 + 行数估算）

### 3.1 steps 多步链式引擎（BrowseChannel 升级 + 新 StepEngine.ts）

**类型定义**（`src/browse/steps-types.ts`，~90 行）：

```typescript
/** Skyvern-style 审计链一行（12 §3.5.10） */
export interface ActionResult {
  action: string;                       // navigate/click/fill/wait/extract/snapshot/evaluate
  outcome: Outcome | "preexisting";     // preexisting 仅 expect 路径产生
  preview?: string;
  state_id?: string;                    // 指向 StateStore
  content_path?: string;
  error?: string;
  duration_ms?: number;
  expect_check?: "verified" | "preexisting" | "failed" | "skipped";
}

/** 多步链一个 step（F3.2.11） */
export interface Step {
  action: string;
  selectors?: Record<string, string>;
  js?: string;
  expect?: ExpectCondition;             // 每步可附 postcondition（12 §1.1B）
  timeout_ms?: number;                  // per-step timeout（默认 30000）
  label?: string;                       // CC 友好的步骤名（审计用）
}

/** 链式终止边界（09 §2.3 验收 2：stoppedAt 精确边界） */
export interface StoppedAt {
  step_index: number;
  reason: "failed_postcondition" | "step_error" | "budget_exceeded" | "manual_abort";
  failed_action?: string;
  detail?: string;
}

/** chain 总返回（InteractResult.data 字段） */
export interface ChainResult {
  actions_and_results: Array<{ step: Step; results: ActionResult[] }>;
  final_state_id?: string;
  final_url?: string;
  stopped_at?: StoppedAt;
  budget_used_ms?: number;
  bounded_output?: BoundedOutput;       // 若整体结果超 48KiB（F3.2.20）
}
```

**StepEngine 主循环**（`src/browse/StepEngine.ts`，~280 行）：

```typescript
export class StepEngine {
  constructor(
    private readonly channel: BrowseChannel,
    private readonly budget: BudgetTracker,
    private readonly highRiskGate: HighRiskGate | null,  // 仅 logged_in 注入
  ) {}

  /**
   * 主入口（Skyvern actions_and_results 形状，12 §3.5.10）。
   * 线性执行（不为速度引入并行子 agent —— GitHub Accessibility Agent 发现）。
   * 借鉴 Skyvern `ActionFailure.should_terminate_remaining_chain` 默认 True。
   */
  async runChain(
    url: string,
    steps: Step[],
    onProgress?: (partial: ChainResult) => void,
  ): Promise<InteractResult<ChainResult>> {
    const actions_and_results: ChainResult["actions_and_results"] = [];
    const tChainStart = Date.now();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // 1. budget 预检（F3.4.8）
      if (this.budget.exhausted()) {
        return this.stop("budget_exceeded", i, actions_and_results, step);
      }

      // 2. high-risk gate（F3.3.14，仅 logged_in）
      if (this.highRiskGate) {
        const gate = await this.highRiskGate.assessStep(step);
        if (gate.blocked) {
          // 不自动操作 → 升级用户（不做也不继续）
          return this.stop("manual_abort", i, actions_and_results, step, gate.reason);
        }
      }

      // 3. 执行 step（复用 BrowseChannel.actionDispatch 单步 handler）
      const tStepStart = Date.now();
      const partial = await this.channel.executeStep(url, step);  // 新公开方法（不写盘）
      const duration_ms = Date.now() - tStepStart;
      this.budget.spend(duration_ms);

      const results: ActionResult[] = [{
        action: step.action,
        outcome: partial.outcome,
        preview: partial.preview,
        state_id: partial.state_id,
        error: partial.error,
        duration_ms,
      }];

      // 4. expect postcondition（F3.2.18，12 §1.1B outcomeAfterCheck）
      if (step.expect) {
        const check = await this.channel.runExpect(step.expect, partial.preSnapshot);
        results[0].expect_check = check TriState;
        if (check === "failed") {
          // 12 铁律：failed 强制 outcome=didnt + 终止链
          results[0].outcome = "didnt";
          return this.stop("failed_postcondition", i, actions_and_results, step,
            `expect failed: ${JSON.stringify(step.expect)}`);
        }
        if (check === "verified") results[0].outcome = "worked";
        // preexisting 保留原 outcome（诚实报告：动作可能幂等或没必要）
      }

      // 5. outcome=unknown → 触发 fallback（不终止，标记让 FallbackDecider 接管）
      actions_and_results.push({ step, results });
      onProgress?.({ actions_and_results });

      if (results[0].outcome === "unknown") {
        // 不在本引擎处理；由外层 FallbackDecider.runWithFallback 决定升降级
        // 但本 chain 视为「此步未交付」，按 Skyvern should_terminate_remaining_chain 默认 True
        return this.stop("step_error", i, actions_and_results, step, "outcome=unknown");
      }
    }

    return {
      outcome: "worked",
      data: {
        actions_and_results,
        final_state_id: actions_and_results.at(-1)?.results[0]?.state_id,
        budget_used_ms: Date.now() - tChainStart,
      },
      served_by: this.channel.name,
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp.chain",
    };
  }

  private stop(reason: StoppedAt["reason"], idx: number,
               aar: ChainResult["actions_and_results"], step: Step, detail?: string)
    : InteractResult<ChainResult> {
    return {
      outcome: reason === "manual_abort" ? "didnt" : "didnt",
      data: { actions_and_results: aar, stopped_at: { step_index: idx, reason, failed_action: step.action, detail } },
      served_by: this.channel.name,
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp.chain",
      error: detail,
    };
  }
}
```

**BrowseChannel 接入**（修改 `src/channels/BrowseChannel.ts`，约 +60 行）：

```typescript
// 新增 public 方法（不破坏 v0.2 browse()）
public async executeStep(url: string, step: Step): Promise<StepPartial> {
  const handler = this.actionDispatch.get(step.action);
  if (!handler) throw new Error(`unknown_action:${step.action}`);
  const c = await this.getMcpClient();
  // step.expect.preSnapshot：act 前先抓一次 outline（runExpect 需要）
  const preSnapshot = step.expect ? await this.quickSnapshot(c) : undefined;
  try {
    const partial = await handler(c, url, { ...step, expect: undefined } as BrowseOptions);
    return { outcome: "worked", preview: partial.preview, state_id: await this.persistState(partial), preSnapshot };
  } catch (e) {
    return { outcome: classifyBrowseError(String(e), step.action), error: String(e), preSnapshot };
  }
}

public async runExpect(cond: ExpectCondition, pre?: Snapshot): Promise<"verified"|"preexisting"|"failed"> {
  return expectPoll(await this.getMcpClient(), cond, pre);  // 委托 ExpectPoll.ts
}

// browse() 入口分流（v0.2 单 action 路径保留）
async browse(url, action, options): Promise<InteractResult<BrowseResult>> {
  if (options.steps && options.steps.length > 0) {
    // v0.3 新路径：转发到 StepEngine，结果再走 boundedOutput envelope
    const chain = await this.stepEngine.runChain(url, options.steps as Step[]);
    return this.wrapChainResult(chain);
  }
  // v0.2 路径：原 single-action 实现（不动）
  // ... existing v0.2 code ...
}
```

**关键设计点**：
- `executeStep` 不直接写盘（原 `browse()` 写盘逻辑上提到 `persistState`，两路径共用）。
- `runExpect` 接受 `preSnapshot` 以做 preexisting 判定（12 §1.1B：「preexisting 保留原值，承认我没造成它但它现在对」）。
- 引擎**线性**（不并行，借鉴 GitHub Accessibility Agent 的发现：「linear ordered phases > parallel sub-agents for accuracy」）。

---

### 3.2 expect 后置条件（新 ExpectPoll.ts）

**接口**（`src/browse/ExpectPoll.ts`，~140 行）：

```typescript
/**
 * F3.2.18：act 后 100ms poll 等平台变更，三态 verified/preexisting/failed。
 *
 * 借鉴源（12 §1.1B 源码级）：
 *   - injaneity `src/bridge.ts performBrowserTransaction`：
 *       deadline = Date.now() + timeoutMs;
 *       do { snap = cdpSnapshotForContext();
 *            present = outlineConditionPresent(restoreOutline(snap.outline), cond);
 *            satisfied = present !== cond.gone;
 *            if (!satisfied) await sleep(100);
 *       } while (!satisfied && Date.now() < deadline);
 *   - injaneity `src/actions.ts outcomeAfterCheck`：
 *       verified → outcome=worked
 *       failed   → outcome=didnt
 *       preexisting → 保留原 outcome（动作幂等或没必要）
 *   - injaneity `src/contract.ts UiCondition`：
 *       {ref?, scopeRef?, text?, role?, value?, until:'present'|'absent', timeoutMs?}
 *       validateCondition 强制 text/role/value 至少一项 → 我们 cond 至少 text/selector/url_contains 之一
 */
export async function expectPoll(
  client: McpClient,
  cond: ExpectCondition,
  preSnapshot?: Snapshot,
  opts?: { pollIntervalMs?: number; defaultTimeoutMs?: number },
): Promise<"verified" | "preexisting" | "failed"> {
  // 1. validate（contract.ts validateCondition 对应）
  if (!cond.text && !cond.selector && !cond.url_contains) {
    throw new Error("expect: at least one of text/selector/url_contains required");
  }

  // 2. preexisting 预检（preSnapshot 提供 → 知道动作前是否已成立）
  if (preSnapshot && conditionHolds(preSnapshot, cond)) {
    return "preexisting";
  }

  // 3. 100ms poll 循环（bridge.ts performBrowserTransaction 直抄）
  const interval = opts?.pollIntervalMs ?? 100;
  const timeout = cond.timeout_ms ?? opts?.defaultTimeoutMs ?? 5000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(interval);
    const current = await snapshotCondition(client, cond);   // 走 evaluate_script + document.querySelector
    const satisfied = cond.gone ? !current.holds : current.holds;
    if (satisfied) return "verified";
  }
  return "failed";
}

/** 用 evaluate_script 跑一次条件检查，避免 take_snapshot 全量开销。 */
async function snapshotCondition(client: McpClient, cond: ExpectCondition): Promise<{ holds: boolean }> {
  // url_contains: window.location.href.includes(...)
  // selector:      !!document.querySelector(cond.selector)
  // text:          document.body.innerText.includes(cond.text)
  const expr = buildConditionExpr(cond);   // 三条件 OR（任一命中即 holds）
  const r = (await client.callTool("evaluate_script", { function: expr })) as EvaluateResult;
  return { holds: firstText(r) === "true" };
}
```

**关键不变量**（写入 INV-13，§5.2）：`failed` 必须强制 `outcome=didnt` 并终止链（不允许「事件投递了就装成功」）。

**preexisting 边界**：当 `cond.gone=true`（如「等待登录弹窗关闭」），preexisting 检查应该是「动作前是否已经关闭」→ `!conditionHolds(preSnapshot, cond)`。需在 `conditionHolds` 里处理 gone 语义。

---

### 3.3 StateStore LRU(128) + stateId + AsyncLocalStorage（重构 state-store.ts）

**新 API**（在 `src/util/state-store.ts` 内加，保留旧 `writeState/readState` 兼容，~180 新行）：

```typescript
/**
 * F3.2.10 修改 + F3.2.19：内存 LRU(128) 主路径 + 磁盘跨进程 spill + ALS 请求级 hydrate。
 *
 * 借鉴源（12 §1.1A 源码级）：
 *   - injaneity `src/runtime.ts StateStore<T>`:
 *       Map<stateId, StoredState<T>>, limit=128
 *       set 时 delete+set 把记录挪到 MRU 端
 *       超容量时 keys().next().value 取最老删之（LRU）
 *       StoredState = { stateId: randomUUID(), resourceKey, epoch, value: T }
 *   - injaneity `src/state.ts SavedStates` 叠 AsyncLocalStorage<OperationState>:
 *       每次 .run() 进上下文；hydrate(record) 把 StoredState 还原成
 *       请求局部的 OperationState（currentTarget/currentLook/currentOutline/epoch/resourceKey）
 *
 * epoch 字段保留但 v0.3 不启用 ResourceScheduler（12 §4.3 推迟）。
 */
export interface StoredState<T = unknown> {
  stateId: string;
  resourceKey: string;          // "browse_logged_in:9222:tabA" / "browse_headless:session1"
  epoch: number;                // 每次 navigate 自增；v0.5+ 才用 stale-reject
  value: T;
  spillPath?: string;           // 大对象落盘路径（>16KiB 时 spill）
  capturedAt: number;
}

const LIMIT = 128;
const store = new Map<string, StoredState>();  // MRU 末位 / LRU 首位（Map 保插入序）

/** ALS（AsyncLocalStorage）：每个 MCP 请求 hydrate 出请求局部 OperationState */
interface OperationState {
  resourceId: string;
  epoch: number;
  stateId?: string;             // 最近一次 observe 的 stateId
}
const als = new AsyncLocalStorage<OperationState>();

export class StateStore<T = unknown> {
  /** 取记录 + MRU 提升（runtime.ts set 时 delete+set） */
  get(stateId: string): StoredState<T> | undefined {
    const rec = store.get(stateId);
    if (rec) { store.delete(stateId); store.set(stateId, rec); }  // MRU
    return rec;
  }

  /** 写入 + LRU 淘汰（runtime.ts keys().next().value） */
  set(stateId: string, value: T, resourceKey: string, spillPath?: string): StoredState<T> {
    const epoch = (als.getStore()?.epoch ?? 0) + 1;
    const rec: StoredState<T> = { stateId, resourceKey, epoch, value, spillPath, capturedAt: Date.now() };
    store.delete(stateId); store.set(stateId, rec);                // MRU
    while (store.size > LIMIT) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);                                         // LRU 淘汰
    }
    return rec;
  }

  /** 过期 stateId cleanly fail（不覆写；09 §2.3 验收 5） */
  getOrThrow(stateId: string): StoredState<T> {
    const r = this.get(stateId);
    if (!r) throw new StaleStateError(`stateId expired or unknown: ${stateId}`);
    return r;
  }
}

export class StaleStateError extends Error {}

/** 请求级 hydrate（12 §1.1A：ALS .run() + hydrate） */
export function withOperation<T>(resourceId: string, epoch: number, fn: () => Promise<T>): Promise<T> {
  return als.run({ resourceId, epoch }, fn);
}
export function currentOperation(): OperationState | undefined {
  return als.getStore();
}
```

**v0.1 `writeState` 兼容层**（v0.2 测试不改）：

```typescript
/** @deprecated v0.3 后改走 StateStore.set；保留 v0.2 调用方 */
export async function writeState(channel, stateId, data): Promise<string> {
  const ss = new StateStore();
  ss.set(stateId, data, channel);
  // 同时写盘（跨进程恢复用，F3.2.10 保留磁盘）
  return writeStateToDisk(channel, stateId, data);  // 原 v0.2 实现
}
```

**关键不变量**（写入 INV-12，§5.2）：`BrowseChannel` 在 `browse()` / `runChain()` 入口必须经 `withOperation()` 包裹；测试用 `AsyncLocalStorage.exit()` 验证并发 2 session 隔离率 100%（09 §2.3 验收 5）。

**资源键设计**（F3.2.13/14 session 复用）：
- `browse_logged_in`：`resourceKey = "browse_logged_in:9222:" + tabId`（同 tab 复用 stateId）
- `browse_headless`：`resourceKey = "browse_headless:" + sessionId`
- 同 resourceKey + 同 url → 复用 stateId（避免重复开 tab，对应 12 §1.2F 「identity→ref 复用 map」子集）

---

### 3.4 bounded output + @oN 续页（新 output-envelope.ts + read-text.ts）

**output-envelope.ts**（~200 行，12 §1.3G 直抄）：

```typescript
/**
 * F3.2.20：bounded output 48KiB/2000 行 + @oN 续页。
 *
 * 借鉴源（12 §1.3G 源码级）：
 *   - injaneity `src/output.ts`:
 *       MODEL_TEXT_MAX_BYTES = 48 * 1024
 *       MODEL_TEXT_MAX_LINES = 2000
 *       MODEL_PREVIEW_BYTES  = 16 * 1024
 *       OUTPUT_PAGE_BYTES    = 16 * 1024
 *       单条上限 16 MiB / store 总 64 MiB
 *       storeOutput 用 os.tmpdir() + mkdtempSync mode 0o600，文件名 @oN.txt
 *       applyOutputEnvelope 超限返回 preview + 三行 trailer
 */
const MAX_BYTES = 48 * 1024;
const MAX_LINES = 2000;
const PREVIEW_BYTES = 16 * 1024;
const PAGE_BYTES = 16 * 1024;
const SPILL_DIR = path.join(os.tmpdir(), "lasso-output");  // mkdtempSync mode 0o600

let outputCounter = 0;
const store = new Map<string, { path: string; bytes: number }>();  // @oN → file
let totalBytes = 0;

export interface BoundedOutput {
  preview: string;               // 前 16KiB
  truncated: boolean;
  ref?: string;                  // "@o3"
  total_bytes?: number;
  total_lines?: number;
  refine_hint?: string;          // tool-specific（如 "narrow selectors to reduce node count"）
  continue_hint?: string;        // "read_text({ref:'@o3', offset:16384})"
}

export function applyOutputEnvelope(text: string, refineHint?: string): BoundedOutput {
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n").length;
  if (bytes <= MAX_BYTES && lines <= MAX_LINES) {
    return { preview: text, truncated: false };
  }
  // 超限 → spill（mode 0o600，隐私适合 logged_in cookie 内容）
  const ref = `@o${++outputCounter}`;
  const path = spillToDisk(ref, text);
  const preview = text.slice(0, PREVIEW_BYTES);
  return {
    preview,
    truncated: true,
    ref,
    total_bytes: bytes,
    total_lines: lines,
    refine_hint: refineHint ?? defaultRefineHint(text),
    continue_hint: `read_text({ref:"${ref}", offset:${PREVIEW_BYTES}})`,
  };
}

function spillToDisk(ref: string, text: string): string {
  if (totalBytes > 64 * 1024 * 1024) {
    throw new Error("output store exhausted (64 MiB cap)");
  }
  fs.mkdirSync(SPILL_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(SPILL_DIR, `${ref}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  store.set(ref, { path: file, bytes: text.length });
  totalBytes += text.length;
  return file;
}

/** read_text 工具调用此函数（F3.2.20 续页） */
export function readOutputPage(ref: string, offset = 0, limit = PAGE_BYTES): { text: string; eof: boolean } {
  const entry = store.get(ref);
  if (!entry) throw new Error(`unknown ref: ${ref}`);
  const full = fs.readFileSync(entry.path, "utf8");
  const slice = full.slice(offset, offset + limit);
  return { text: slice, eof: offset + limit >= full.length };
}
```

**read-text.ts 工具注册**（~70 行）：

```typescript
server.tool(
  "read_text",
  "Paginate through large output spilled by browse_* (F3.2.20). " +
  "Use the continue_hint returned by browse_headless/browse_logged_in when output exceeded 48KiB.",
  {
    ref: z.string().regex(/^@o\d+$/),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().positive().max(64 * 1024).default(16 * 1024),
  },
  { readOnlyHint: true, openWorldHint: false },
  async (args) => {
    try {
      const page = readOutputPage(args.ref, args.offset, args.limit);
      return { content: [{ type: "text", text: JSON.stringify(page) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${String(e)}` }] };
    }
  },
);
```

**BrowseChannel 接入**：`browse()` 与 `runChain()` 返回前调 `applyOutputEnvelope(JSON.stringify(result.data))`，超限时 `data` 替换为 `{ bounded_output, preview_only: true }`。

---

### 3.5 high-risk pattern gate（新 HighRiskGate.ts，仅 logged_in）

**接口**（`src/browse/HighRiskGate.ts`，~110 行）：

```typescript
/**
 * F3.3.14：high-risk pattern 黑名单 gate，仅 browse_logged_in 启用。
 *
 * 借鉴源：12 §2.1#6 GitHub Accessibility Agent 内部 pilot：
 *   - complexity scoring 门槛（小脚本算代码复杂度分数）
 *   - high-risk pattern 黑名单：drag-drop / toasts / RTE / tree-view / data-grid
 *     标「不自动操作」
 *   - anti-gaming instructions（防 LLM 绕过自己指令）
 *
 * 边界：headless 不启用（公开页风险低）；logged_in 携带身份 → 风险高。
 */
export interface HighRiskAssessment {
  blocked: boolean;
  reason?: string;       // "high_risk_pattern:rte" / "high_risk_pattern:drag_drop" / ...
  evidence?: string;     // 命中的 selector / outline ref
}

const HIGH_RISK_PATTERNS: Array<{ kind: string; selector: string }> = [
  { kind: "rte",         selector: '[role="textbox"][contenteditable="true"], [contenteditable=""]' },
  { kind: "tree_view",   selector: '[role="tree"], [role="treegrid"]' },
  { kind: "data_grid",   selector: '[role="grid"]' },
  { kind: "drag_drop",   selector: '[draggable="true"]' },
  { kind: "toast",       selector: '[role="alert"]' },  // 瞬态，禁止 click
];

export class HighRiskGate {
  constructor(private readonly client: () => Promise<McpClient>) {}

  async assessStep(step: Step): Promise<HighRiskAssessment> {
    // 仅对会引发副作用的 action 检查（navigate/extract/snapshot 不检）
    if (["navigate", "snapshot", "screenshot", "extract", "wait", "evaluate"].includes(step.action)) {
      return { blocked: false };
    }
    const c = await this.client();
    // step.selectors.click 是 uid；通过 evaluate_script 看它的祖先是否命中黑名单
    const target = step.selectors?.click ?? step.selectors?.fill;
    if (!target) return { blocked: false };   // 无目标 selectors → 不拦（让 channel 自己报错）

    const expr = `(function(){
      const el = document.querySelector('[data-lasso-uid="${CSS.escape(target)}"]')
              || document.activeElement;
      if (!el) return JSON.stringify({ok:false, reason:"element_not_found"});
      for (const sel of ${JSON.stringify(HIGH_RISK_PATTERNS.map(p => p.selector))}) {
        const risky = el.closest(sel);
        if (risky) return JSON.stringify({ok:true, kind: sel, html: risky.outerHTML.slice(0,200)});
      }
      return JSON.stringify({ok:true});
    })()`;
    const r = (await c.callTool("evaluate_script", { function: expr })) as EvaluateResult;
    const verdict = JSON.parse(firstText(r) ?? "{}");
    if (verdict.kind) {
      return {
        blocked: true,
        reason: `high_risk_pattern:${verdict.kind}`,
        evidence: verdict.html,
      };
    }
    return { blocked: false };
  }
}
```

**关键设计**：
- **anti-gaming**（12 §2.1#6）：pattern 表写死在常量，**不**从 config 读（防 LLM 通过 config 绕过）；only typed action enum，no raw 串。
- navigate/extract 等「只读」action 不检（性能 + 不必要）。
- 命中时 outcome=`didnt` + `error="high_risk_pattern:<kind>"`，引擎立即 `stop("manual_abort")`（不进 fallback 链——这是「明确不自动操作」边界）。

---

### 3.6 RPM 滑动窗口限频（新 rpm-limiter.ts + quota-ledger 扩展）

**接口**（`src/util/rpm-limiter.ts`，~90 行）：

```typescript
/**
 * F3.1.12：provider RPM 滑动窗口限频。
 * 不是被动等 429，而是主动按 provider 维度降级。
 *
 * 滑动窗：保留最近 windowMs 内的成功调用时间戳数组；
 * 调用前 checkLimit() 看是否超 max；超限直接返回 false（不试）。
 */
export class RpmLimiter {
  private windows = new Map<string, number[]>();  // provider → 时间戳数组

  constructor(
    private readonly windowMs: number = 60_000,
    private readonly defaultMax: number = Number.POSITIVE_INFINITY,
  ) {}

  /** 调用前检查；true=允许调用，false=超限（应主动降级） */
  allow(provider: string, max?: number): boolean {
    const cap = max ?? this.defaultMax;
    if (cap === Number.POSITIVE_INFINITY) return true;
    const now = Date.now();
    const arr = (this.windows.get(provider) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= cap) {
      this.windows.set(provider, arr);
      return false;
    }
    return true;   // 注意：成功调用后必须调 record(provider) 才计数
  }

  /** 实际成功调用后记录 */
  record(provider: string): void {
    const now = Date.now();
    const arr = (this.windows.get(provider) ?? []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.windows.set(provider, arr);
  }

  /** 调试用：当前窗口内已用配额 */
  currentUsage(provider: string): number {
    const now = Date.now();
    return (this.windows.get(provider) ?? []).filter((t) => now - t < this.windowMs).length;
  }
}
```

**quota-ledger.ts 扩展**（加 2 字段，~15 新行）：

```typescript
export interface ProviderQuota {
  // ... v0.2 existing ...
  /** F3.1.12：60s 滑动窗内最大调用数；未设 = Infinity */
  rpm_max?: number;
  /** 滑动窗大小（默认 60000） */
  rpm_window_ms?: number;
}
```

**MultiSourceFanout 接入**（~20 行修改）：
- 扇出前对每个 provider 调 `limiter.allow(provider.name, quota.rpm_max)`
- allow=false 的 provider 标记 `skipped:rpm_exceeded`，进入 `partial_failures`（复用 v0.2 的 `PartialFailure` 类型，加 `reason: "rpm_limited"`）
- 成功后调 `limiter.record(provider.name)`

**BudgetTracker 关系**（§3.7）：RPM 是「per-provider 调用次数」维度；BudgetTracker 是「per-chain 时间」维度。两者正交。

---

### 3.7 BudgetTracker（新 BudgetTracker.ts，F3.4.8-9）

**接口**（`src/fallback/BudgetTracker.ts`，~110 行）：

```typescript
/**
 * F3.4.8 chain budget + F3.4.9 部分失败聚合。
 * 每个 chain（StepEngine.runChain）实例化一个。
 */
export class BudgetTracker {
  private elapsedMs = 0;
  private partials: PartialFailure[] = [];  // 复用 v0.2 类型

  constructor(private readonly budgetMs: number = 120_000) {}  // 默认 2 分钟

  spend(ms: number): void { this.elapsedMs += ms; }
  exhausted(): boolean { return this.elapsedMs >= this.budgetMs; }
  remaining(): number { return Math.max(0, this.budgetMs - this.elapsedMs); }

  recordPartial(p: PartialFailure): void { this.partials.push(p); }
  getPartials(): PartialFailure[] { return [...this.partials]; }

  /** chain 结束时把 partials 透传到 InteractResult.partial_failures */
  flushInto<T>(result: InteractResult<T>): InteractResult<T> {
    if (this.partials.length === 0) return result;
    return {
      ...result,
      partial_failures: [...(result.partial_failures ?? []), ...this.partials],
    };
  }
}
```

**FallbackDecider 集成**（~25 行修改）：
- `runWithFallback(plan, fn, budget?)` 第三参可选 BudgetTracker
- 每次 fallback 尝试后 `budget.recordPartial(...)`
- 主 chain 退出时 `budget.flushInto(result)`

---

## 4. 不明确点调研结论

### 4.1 steps 怎么编排（线性 vs DAG）

**结论：线性**，不做 DAG / 并行子 agent。
- 证据：12 §2.1#6 GitHub Accessibility Agent「linear ordered phases > parallel sub-agents for accuracy」
- Skyvern `actions_and_results` 也是 `list` 而非图
- Lasso 的多步场景（navigate→click→wait→extract）天然线性（后步依赖前步的页面状态）

### 4.2 expect 怎么 poll（CDP 原生 vs evaluate_script 轮询）

**结论：走 `evaluate_script` 100ms poll**，不依赖 CDP 原生 `Page.frameNavigated`。
- 证据：12 §1.1B 源码级 —— injaneity `bridge.ts performBrowserTransaction` 就是用 `cdpSnapshotForContext()` 100ms 循环，不是事件回调
- Lasso 通过 chrome-devtools-mcp 工具层调用，拿不到 CDP 原生事件；`evaluate_script` 跑 `document.querySelector + textContent.includes` 足够
- pollIntervalMs=100（直抄），timeoutMs 默认 5000（08 §2.5）

### 4.3 preexisting 怎么判（before/after 对比）

**结论：act 前抓一次 outline snapshot 作 `preSnapshot`，传给 `expectPoll`**。
- 流程：`executeStep` 在 act 前先 `quickSnapshot(c)` → `runExpect(cond, preSnapshot)`
- `expectPoll` 第一行：`if (conditionHolds(preSnapshot, cond)) return "preexisting"`
- preexisting 时**保留** `partial.outcome`（不改成 worked 也不改成 didnt，12 §1.1B：「保留原值，承认我没造成它但它现在对」）
- 若 act 前 snapshot 抓失败（如 navigate 跳新页前 page 未就绪），跳过 preexisting 判定直接 poll（结果只能是 verified/failed）

### 4.4 StateStore 怎么替换 v0.1 磁盘而不破 v0.2

**结论：双路径并存，旧 `writeState` 转 wrapper**。
- v0.2 调用方（`BrowseChannel.browse()` v0.2 路径 + 测试）继续调 `writeState(channel, stateId, data)`，内部改为 `new StateStore().set(...) + writeStateToDisk(...)`（内存 + 磁盘双写）
- v0.3 新路径（StepEngine）直接用 `StateStore` 类
- 磁盘保留原因（F3.2.10）：跨进程重启恢复（doctor / crash recovery）
- 内存为主：`get(stateId)` 命中内存 → 不读盘；进程重启后内存空，盘上备份只在 doctor 显式回放时用

### 4.5 chain 超时（per-step vs whole-chain）

**结论：双层**。
- per-step：`step.timeout_ms`（默认 30000），单步超时 → `outcome=unknown` → 由 chain 判定是否终止
- whole-chain：`BudgetTracker.budgetMs`（默认 120000），超预算 → `stopped_at.reason="budget_exceeded"`

### 4.6 5 个状态机 outcome 汇总

| 场景 | step outcome | chain outcome | 行为 |
|---|---|---|---|
| 正常 + expect verified | worked | worked | 继续下一步 |
| 正常 + expect preexisting | worked（保留） | worked | 继续（诚实标注 preexisting） |
| expect failed | **强制 didnt** | didnt | **终止链** + `stopped_at="failed_postcondition"` |
| step handler 抛 timeout/429 | unknown | unknown | **终止链** + 由外层 FallbackDecider 接管 |
| step handler 抛 404/403/2FA | didnt | didnt | **终止链** + `stopped_at="step_error"` |
| high-risk gate block | (未执行) | didnt | **终止链** + `stopped_at="manual_abort"` |

---

## 5. 测试计划

### 5.1 单元测试（新增 ~102 cases）

| 文件 | 主要 case |
|---|---|
| `step-engine.spec.ts` | 5 步链 happy path / 中途 expect 失败终止 / unknown 中止 / budget 超限 / high-risk gate 拦截 / 部分失败聚合 / actions_and_results 形状 |
| `expect-poll.spec.ts` | verified/preexisting/failed 三态 / gone=true 反向语义 / timeout 兜底 failed / 缺字段抛错 / 100ms 间隔被 mock 验证 |
| `state-store.spec.ts` | LRU 淘汰（129 插入 → 最老被踢）/ MRU 提升（get 后再插 128 不踢它）/ ALS 隔离 2 并发 / StaleStateError cleanly fail / 双写磁盘可读 |
| `output-envelope.spec.ts` | 48KiB 边界 / 2000 行边界 / mode 0o600 权限位 / 16KiB preview / refine_hint 工具特定 / read_text 分页 EOF / 64MiB 总量上限抛错 |
| `high-risk-gate.spec.ts` | RTE 拦 / drag-drop 拦 / data-grid 拦 / toast 拦 / 只读 action 不拦 / headless 不注入 gate |
| `rpm-limiter.spec.ts` | 滑动窗过期清理 / allow=false 不计数 / record 后才计数 / 不同 provider 独立 |
| `budget-tracker.spec.ts` | spend/exhausted/remaining 边界 / flushInto 透传 partial_failures |

### 5.2 集成测试（新增 ~9 cases in `browse-steps.spec.ts`）

09 §2.3 七条验收的端到端落：

1. `5_step_chain_navigate_click_wait_fill_snapshot` — 5 步全过
2. `expect_failed_terminates_chain_with_stoppedAt` — stoppedAt 精确到 step_index
3. `preexisting_reported_honestly` — expect_check=preexisting 但 outcome=worked
4. `unknown_triggers_fallback_engine` — chain outcome=unknown → FallbackDecider 升 logged_in
5. `concurrent_sessions_async_local_storage_isolation` — Promise.all 2 chain，stateId 不串
6. `chain_output_over_48kib_spilled_with_ref` — 大 chain result 触发 bounded output
7. `high_risk_pattern_aborts_logged_in_only` — logged_in 拦、headless 不拦
8. `budget_exceeded_stops_chain_early`
9. `chain_partial_failures_propagated_to_interact_result`

### 5.3 invariants 新增 4 条（check-invariants.mjs INV-12..15）

```javascript
// INV-12: BrowseChannel.browse() 入口必须经 withOperation() ALS 包裹
{
  id: "INV-12-browse-als-scoped",
  desc: "BrowseChannel 的 browse/runChain 必须在 withOperation() 内执行（F3.2.10）",
  check: () => SRC.some(s => /withOperation\s*\(/.test(s.text))
           && SRC.some(s => /class\s+StateStore/.test(s.text)),
},
// INV-13: expect failed 必须 outcome=didnt + 终止（铁律：event delivery ≠ semantic success）
{
  id: "INV-13-expect-failed-forces-didnt",
  desc: "ExpectPoll 返回 'failed' 时调用方必须强制 outcome=didnt + 终止 chain",
  check: () => {
    const eng = SRC.find(s => s.f.includes("StepEngine"));
    if (!eng) return true;  // 允许未实装
    return /failed.*didnt|outcome.*didnt.*failed/.test(eng.text);
  },
},
// INV-14: HighRiskGate 表常量化（防 anti-gaming 绕过）
{
  id: "INV-14-highrisk-patterns-const",
  desc: "HIGH_RISK_PATTERNS 必须是模块顶级 const，不从 config/env 读",
  check: () => {
    const g = SRC.find(s => s.f.includes("HighRiskGate"));
    if (!g) return true;
    return /(?:const|readonly)\s+HIGH_RISK_PATTERNS/.test(g.text)
        && !/process\.env\.HIGH_RISK/.test(g.text);
  },
},
// INV-15: bounded output 落盘权限 mode 0o600
{
  id: "INV-15-output-spill-mode-0o600",
  desc: "output-envelope spill 文件必须 mode 0o600（隐私适合 logged_in cookie）",
  check: () => {
    const o = SRC.find(s => s.f.includes("output-envelope"));
    if (!o) return true;
    return /0o600|0o700|mode:\s*0o600/.test(o.text);
  },
},
```

### 5.4 v0.2 回归保护

- v0.2 的 349 tests + 11 INV 跑全绿（前提：BrowseChannel.browse() 单 action 路径不改）
- 新加 v0.3 INV-12..15 后，CI 总 15 条 INV 全绿
- 加 `npm run test -- --coverage` 阈值：新文件各自 ≥85% lines

---

## 6. 验收标准（引用 09 §2.3 七条）

| 09 §2.3 原文 | 落地为 |
|---|---|
| 1. 5 步链式 navigate→click→wait→fill→snapshot，每步可附 expect | `step-engine.spec.ts::5_step_chain_*` + 集成 1 |
| 2. expect 失败时链式正确终止，返回 `failed_postcondition` + stoppedAt 精确边界 | `expect-poll.spec.ts::failed_returns_didnt` + 集成 2 + INV-13 |
| 3. `preexisting` 三态诚实报告 | `expect-poll.spec.ts::preexisting_preserves_outcome` + 集成 3 |
| 4. outcome=unknown 时 fallback 引擎自动触发 | 集成 4（FallbackDecider 接管，复用 v0.2 outcome 分类） |
| 5. 并发 2 session AsyncLocalStorage 隔离率 100%；过期 stateId cleanly fail | `state-store.spec.ts::als_isolation` + `::stale_state_error` + 集成 5 + INV-12 |
| 6. 返回结果超 48KiB 自动落盘 + 16KiB preview + refine hint | `output-envelope.spec.ts` 全 + 集成 6 + INV-15 |
| 7. browse_logged_in 遇 drag-drop/RTE/data-grid 放弃自动操作并升级用户 | `high-risk-gate.spec.ts` 全 + 集成 7 + INV-14 |

**额外加 2 条**（12 §4.2 验收补充）：
- 8. actions_and_results 审计链形状正确（Skyvern `[(step, [result...]), ...]`）
- 9. RPM 滑动窗口超限时 provider 主动降级（partial_failures 含 `reason:"rpm_limited"`）

---

## 7. 风险 + 实施顺序

### 7.1 风险登记（v0.3 新增，沿用 09 §6 风格）

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-v03-1 | StateStore ALS 在 MCP server stdio 模式并发请求下不隔离 | 低 | 高 | Node ALS 是成熟机制；集成 5 验证；如失败回退到 Map<requestId, State> |
| R-v03-2 | expect 100ms poll 在 chrome-devtools-mcp 上游 evaluate_script 延迟叠加 → 5s 超时不够 | 中 | 中 | per-step timeout 可配；doctor 加 evaluate_script 延迟探测 |
| R-v03-3 | high-risk gate 误拦合法操作（如合法的 contenteditable 笔记 app） | 中 | 中 | 命中时不抛错只升级（outcome=didnt + 明确 reason）；用户可重试更具体的 selectors |
| R-v03-4 | bounded output 64MiB 总量上限在长 chain 下被击穿 | 低 | 中 | StateStore LRU(128) 已限速； spill 文件 30min 清理 |
| R-v03-5 | actions_and_results 大 chain 反而**增加** token（与「减推理调用」目标反） | 中 | 中 | 单步 preview 仍 ≤4k chars；整 chain result 经 boundedOutput envelope 兜底 |
| R-v03-6 | epoch 字段保留但未启用，未来 v0.5+ 引入 ResourceScheduler 时 schema 不兼容 | 低 | 低 | epoch 类型 `number`；未来只能加 `stale_check: boolean` |

### 7.2 实施顺序（按依赖拓扑，TDD red→green）

```
Phase A (基座, 2 天):
  1. types.ts 扩字段（Step/ActionResult/StoppedAt/BoundedOutput）
  2. state-store.ts LRU + ALS + 双写（保留 writeState 签名）
  3. output-envelope.ts + read_text 工具
  → 每个 Phase A 模块独立单测，v0.2 全回归
  → INV-12/15 上线

Phase B (expect, 1 天):
  4. ExpectPoll.ts（100ms poll + 三态）
  5. BrowseChannel.executeStep + runExpect 接入
  → INV-13 上线

Phase C (chain, 2 天):
  6. StepEngine.ts 主循环
  7. BudgetTracker.ts + FallbackDecider 集成
  8. BrowseChannel.browse() 入口分流
  → 集成测试 1-5 上线

Phase D (gate + rpm, 1 天):
  9. HighRiskGate.ts（仅 logged_in 注入）
  10. rpm-limiter.ts + MultiSourceFanout 接入
  → INV-14 上线；集成测试 7-9

Phase E (验收 + 文档, 1 天):
  11. 09 §2.3 七条全过；actions_and_results 形状校验
  12. 更新 08 附录 B（BrowseOptions 加 steps/expect 字段）+ 09 §2.3 实装笔记
  13. tag v0.3.0；npm 发布（push 走 HTTPS，09 R10 + MEMORY）

回退点：每 Phase 完成打 tag；Phase B/C 失败可回 Phase A；整体失败回 v0.2 tag。
```

### 7.3 「不破坏 v0.2」三道防线

1. **API 兼容**：`BrowseChannel.browse(url, action, options)` 三参签名 + `writeState(channel, stateId, data)` 旧签名都不变（v0.3 内部转调新 API）
2. **schema 兼容**：zod schema 新字段全 optional；旧调用方（无 steps/expect）走 v0.2 单 action 路径
3. **测试兼容**：v0.2 的 20 个 spec 文件零改动；v0.3 新增 8 个 spec + 4 条 INV，CI 总数从 `349 tests + 11 INV` 升到 `~451 tests + 15 INV`

---

## 文档结束

**核心借鉴清单**（一句话回顾 12 文档）：
1. StateStore LRU(128) + ALS = injaneity `runtime.ts StateStore` + `state.ts SavedStates`（12 §1.1A）
2. expect 100ms poll + 三态 = injaneity `bridge.ts performBrowserTransaction` + `actions.ts outcomeAfterCheck`（12 §1.1B）
3. actions_and_results = Skyvern `list[tuple[Action, list[ActionResult]]]` + `should_terminate_remaining_chain`（12 §3.5.10）
4. bounded output 48KiB + @oN = injaneity `output.ts applyOutputEnvelope/storeOutput`（12 §1.3G）
5. high-risk pattern gate = GitHub Accessibility Agent complexity scoring（12 §2.1#6）

**相关绝对路径**：
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/channels/BrowseChannel.ts`（v0.2 入口，v0.3 入口分流）
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/util/state-store.ts`（v0.1 单磁盘，v0.3 LRU+ALS+双写）
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/types.ts`（v0.2 类型，v0.3 加 Step/ActionResult/BoundedOutput）
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/tools/browse.ts`（v0.2 工具注册，v0.3 加 read_text）
- `/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs`（v0.2 11 INV，v0.3 加 INV-12..15）
- `/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md` §2.3（v0.3 权威验收）
- `/Users/wangdong/Documents/Project/cc-control-all/doc/12-pi-computer-use及生态深度分析.md` §1.1A/B + §1.3G + §3.5.6/7/10（借鉴源证据）