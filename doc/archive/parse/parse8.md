# Lasso v0.7 功能分析师 parse8 —— 文件/函数级执行计划（可观测完善 + 长熔断）

> 上游：[09 §2.8 v0.7](09-media-interact-实施排期.md) + [08 F3.4.5,10/F3.5.12/F3.7.5-12/F3.8.9-12/F3.12.10](08-media-interact-功能架构.md) + [13 全交互重设计](13-全交互抓手重设计.md)。
> v0.6 基线：**40 invariants + 1081 TS + 144 Rust**（零回归承诺；新 INV 编号 ≥41）。
> 简单性守门（架构想法/01/02）：长熔断复用 `CircuitBreaker` 范式（同文件加类，不开第二套熔断引擎模块）；指标层复用 `logger.ts` JSON 行级日志（进程内，禁 Prometheus / 禁远程遥测）；SERP 检测复用 v0.2 骨架（SelectorRegistry/HitRateStats/ChangeDetection/RecordingStore 已就位，仅实例化 + 主路径接入）；长熔断联动 v0.6 `CapabilityBag.disable`（不绕过 INV-37 task）。

---

## 1. v0.7 目标与范围（v0.6 增量）

### 1.1 能力跃升（09 §2.8 原文）
**v0.6（已交付）**：运行时加减通道/provider（CapabilityBag + ToolManager + admin tool action-enum）。
**v0.7（本 parse）**：从「能加减」升到「能观测」——Lasso 自身与 CC 都能看见 channel/provider 的健康、负载、改版风险，并能在月配额耗尽类故障时自动停摆而非反复重试。

### 1.2 范围矩阵（做 / 不做）

| 维度 | 做（v0.7） | 不做（推迟 / NO-GO） |
|---|---|---|
| **熔断** | 60min 长熔断（F3.4.5）+ reset（F3.4.10） | 跨 channel 联合熔断（v0.8+）；外部 Prometheus exporter（NO-GO，进程内） |
| **指标** | per-channel/provider 成功率 / 延迟 p50/p95 / count；进程内 RingBuffer(128) | RRF 融合 / corpus 持久化（NO-GO，08 §0）；远程指标后端（NO-GO） |
| **资源** | 子进程 RSS / CPU 采样（60s）+ 阈值告警 | 进程级 OOM-kill 自动恢复（v0.8+）；cgroup 集成（NO-GO） |
| **SERP** | 命中率 <50% 触发 ChangeDetection 验证 → 告警 + retrieval_method 标记 | 自动重写 selector 表（NO-GO，保守人工升级 INV-47）；录制回放回归（v1.0 F3.8.14） |
| **暴露** | admin tool 加 3 只读 action（metrics/breakers/serp_health） | 新 `observability` tool（NO-GO，守 INV-17 单 tool + action-enum 范式） |
| **doctor** | runtime_state section 扩 metrics/breakers/serp 子节 | 新 doctor 顶级 section（不开第二套 doctor，INV-4 衍生） |

### 1.3 量化目标（验收锚点）
- v0.7 收尾 TS 行数 ≈ **1081 + ~1200**（≈ 2280），Rust 行数零改（v0.7 不动 Rust helper）
- INV 总数 **40 → 47**（加 INV-41..47，全部为 v0.7 新加，不重写 v0.6 INV-35..40）
- CI 闸门：`npm run check-invariants` 报 **47 条全绿**；`npm test` 通过率 100%（v0.6 测试集零回归）

---

## 2. 文件结构（lasso/src/ 改动；零回归 v0.6）

### 2.1 新增文件（5 个；总 ≈ 880 行 TS）

```
src/
├── fallback/
│   └── LongCircuitBreaker.ts        ★ 新（~150 行）60min 长熔断状态机
├── observ/                           ★ 新目录
│   ├── MetricsCollector.ts          ★ 新（~210 行）per-channel 成功率/p95
│   └── ResourceMonitor.ts           ★ 新（~160 行）子进程 RSS/CPU 采样
└── serp/
    └── SerpHealthMonitor.ts          ★ 新（~200 行）改版检测协调器
```

### 2.2 修改文件（7 个；增量改动，v0.6 行为零差异）

| 文件 | 改动要点 | 行数增量 |
|---|---|---|
| `src/fallback/FallbackDecider.ts` | `breakers: Map<string, CircuitBreaker>` 旁加 `longBreakers: Map<string, LongCircuitBreaker>`；`runWithFallback` 主循环双 breaker 串联检查 | +~45 |
| `src/runtime/CapabilityBag.ts` | 不动 disable/enable 语义；**装配期**（index.ts）由 LongCircuitBreaker.onOpen 调 `bag.disable(name, {reason})` —— 本类一行不改 | 0 |
| `src/runtime/runtime-types.ts` | `AdminAction` 加 3 个 union 成员 | +~5 |
| `src/tools/admin.ts` | `adminSchema.action` enum 加 3 项；handler switch 加 3 个 case | +~120 |
| `src/serp/extract.ts` | `serpScrapeFallback` 末尾按命中数调 `registry.recordHit/recordMiss` + `hitRate.recordHit/recordMiss` | +~30 |
| `src/doctor/doctor.ts` | `runtime_state` section 扩 `metrics` / `breakers` / `serp_health` 子字段（数据源 provider 注入；不改 #1-#26 检查） | +~30 |
| `src/index.ts` | 装配段：实例化 4 件 SERP + MetricsCollector + ResourceMonitor + LongCircuitBreaker Map；串到 bag.onChange / FallbackDecider / doctorOpts | +~80 |
| `src/invariants/check-invariants.mjs` | 加 INV-41..47 共 7 条新 INV（不改 v0.6 INV-1..40） | +~150 |

**总增量**：新增 ~880 行 + 修改 ~460 行 ≈ **1340 行 TS + 150 行 INV 脚本**（落 §1.3 估算窗口内）。

### 2.3 Rust 改动
**零改**（`lasso/src/desktop/rust-helper/` 一行不动）。v0.7 是可观测层，不渗 desktop 契约（守 INV-21/26/35）。

---

## 3. 各模块实施细节（接口签名 + 伪码 + 借鉴源 + 行数估算）

### 3.1 60min 长熔断（LongCircuitBreaker；区别 60s 短；channel 级；联动 CapabilityBag.disable）

**借鉴源**：
- `src/fallback/CircuitBreaker.ts`（v0.1 短熔断状态机：closed/open/half-open）—— **复用三态 + allow/recordSuccess/recordFailure API 形状**
- Argus 60min 长熔断（08 §2.6 + 13）—— **借鉴 window tracking 思路**
- `config/quota-ledger.ts:111` `markExhausted`（resetAt 取较大值防回滚）—— **借鉴不回滚语义**

**关键决策（简单性 R-INT-01/R-CI-02）**：
- **不开第二套熔断引擎模块**（守 INV-41 新加）。`LongCircuitBreaker` 同在 `src/fallback/` 目录，与 `CircuitBreaker` 并列，**复用 `BreakerState` 类型**（不重定义）。
- **不修改 `CircuitBreaker` 一行**（v0.6 短熔断零回归）。长熔断是新类，旧类不渗新参数。
- **不绕过 CapabilityBag**（守 INV-42 新加，INV-37 task 衍生）。长熔断 open 时经 `onOpen` 回调，由装配层（index.ts）调 `bag.disable(name, {reason: "long_circuit_open"})` —— 联动走 v0.6 既有的 `bag.onChange` handler 链，复用 ToolManager.disableChannel + SubprocessManager.shutdownOne。

**接口签名（src/fallback/LongCircuitBreaker.ts）**：

```ts
import type { BreakerState } from "./CircuitBreaker.js";  // 复用类型，不开第二套

/**
 * 60min 长熔断（F3.4.5 / F3.4.10）—— 月配额耗尽 / 持续故障类。
 *
 * 与 CircuitBreaker（60s 短熔断）的区别：
 *  - 触发条件：滑动窗口（windowMs 内失败数 ≥ threshold），非"连续失败"
 *  - open 持续：resetMs=60min（vs 短 60s）
 *  - 副作用：onOpen 回调联动 CapabilityBag.disable（短熔断不联动，仅跳过当次）
 *
 * 状态机复用 BreakerState（closed/open/half-open）—— INV-41 不开第二套语义。
 */
export class LongCircuitBreaker {
  state: BreakerState = "closed";
  private failureTimestamps: number[] = [];   // 滑动窗口内的失败时间戳
  private openedAt = 0;

  constructor(
    private readonly threshold = 10,           // 1h 内 10 次失败 → open
    private readonly windowMs = 3_600_000,     // 1h 滑动窗
    private readonly resetMs = 3_600_000,      // open 持续 60min
    /** open 时回调（装配层注入 bag.disable 联动） */
    private readonly onOpen?: (name: string) => Promise<void>,
    private readonly name = "unknown",
  ) {}

  allow(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this.openedAt > this.resetMs) {
        this.state = "half-open";
        return true;  // probe 放行
      }
      return false;   // 仍 open
    }
    return true;      // half-open
  }

  recordSuccess(): void {
    this.failureTimestamps = [];
    this.state = "closed";
  }

  async recordFailure(): Promise<void> {
    const now = Date.now();
    this.failureTimestamps.push(now);
    // 滑动窗：丢弃 windowMs 之前的失败
    this.failureTimestamps = this.failureTimestamps.filter(
      (t) => now - t < this.windowMs,
    );
    if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = now;
      await this.onOpen?.(this.name);
      return;
    }
    if (this.failureTimestamps.length >= this.threshold) {
      this.state = "open";
      this.openedAt = now;
      await this.onOpen?.(this.name);
    }
  }

  /** F3.4.10 熔断 reset —— admin action 手工唤醒（不动短熔断） */
  reset(): void {
    this.state = "closed";
    this.failureTimestamps = [];
    this.openedAt = 0;
  }

  get windowFailureCount(): number { return this.failureTimestamps.length; }
  get openedAtReadOnly(): number { return this.openedAt; }

  _forceElapsedForTests(ms: number): void {
    this.openedAt = Date.now() - ms;
    // 同步老化 failureTimestamps（便于窗口测试）
    this.failureTimestamps = this.failureTimestamps.filter(
      (t) => Date.now() - t < this.windowMs,
    );
  }
}
```

**FallbackDecider 接入（双 breaker 串联）**：

```ts
// src/fallback/FallbackDecider.ts 改动（~45 行增量）
export class FallbackDecider {
  constructor(
    private readonly breakers: Map<string, CircuitBreaker>,
    private readonly policyGate?: PolicyGate | null,
    /** v0.7 新增：长熔断 Map（与 breakers 同 key，独立状态机） */
    private readonly longBreakers?: Map<string, LongCircuitBreaker> | null,
  ) {}

  // runWithFallback 主循环内，breaker 检查段：
  const shortB = this.breakers.get(channelName);
  const longB = this.longBreakers?.get(channelName);
  if ((shortB && !shortB.allow()) || (longB && !longB.allow())) {
    actions_and_results.push({
      channel: channelName,
      outcome: "error",
      error: (longB && !longB.allow()) ? "long_circuit_open" : "circuit_open",
    });
    budget?.recordPartial({ channel: channelName, error: "circuit_open" });
    continue;
  }
  // ...
  // executor 失败/unknown 分支（既有 breaker?.recordFailure() 旁加）：
  shortB?.recordFailure();
  await longB?.recordFailure();   // 异步：可能触发 onOpen → bag.disable
```

**零回归保证**：`longBreakers` 缺省 `null`，未注入时 `longB` 永远 `undefined`，主循环条件 `(longB && !longB.allow())` 永远 `false` —— 行为等价 v0.6（同 v0.4 PolicyGate 缺省 null 的零回归范式）。

**index.ts 装配**：

```ts
// 长熔断 onOpen 联动 bag.disable（经既有 onChange 链 → ToolManager + shutdownOne）
const longBreakers = new Map<string, LongCircuitBreaker>();
for (const name of ["search.zhipu", "search.brave", "browse_headless",
                    "browse_logged_in", "desktop.ax", "desktop.appleScript",
                    "desktop.cgEvent", "desktop.screenshotVlm"]) {
  longBreakers.set(name, new LongCircuitBreaker(
    10, 3_600_000, 3_600_000,
    async (n) => {
      logger.warn({ evt: "long_circuit_opened", channel: n });
      await bag.disable(n, { callerId: "system", reason: "long_circuit_open" });
    },
    name,
  ));
}
// 注入 decider（FallbackDecider 第 3 参；新增可选）
const decider = new FallbackDecider(breakers, policyGate, longBreakers);
```

**关键边界**：
- 长熔断只触发 `disable`，不自动 `enable`（reset 60min 后 half-open probe 成功 → `recordSuccess` 自然回 closed；但 bag 仍 disabled，需 admin 手工 `capability_enable`）—— **保守设计**：长熔断代表"月配额耗尽类"，自动恢复风险大（用户可能已超额），由 admin 显式 enable 安全。
- shortB 与 longB 独立状态机：短熔断 3 次连续失败 open 60s（瞬时毛刺），长熔断 1h 内 10 次 open 60min（持续故障）—— 互不污染。

---

### 3.2 指标层（MetricsCollector：per-channel 成功率 / 延迟 p95；结构化输出）

**借鉴源**：
- `src/util/logger.ts`（v0.1 JSON 行级日志）—— **复用 emit 范式，不引入 pino/winston**
- `src/runtime/CapabilityBag.ts` snapshot() 模式（返回深拷贝防外部 mutate）—— **复用不可变快照**
- `src/util/state-store.ts` LRU(128) —— **复用 RingBuffer 容量上限范式**

**关键决策（R-CI-02 + 08 §0 非目标）**：
- **不开 Prometheus exporter**（守 INV-43 新加）。指标只在进程内 + JSON 日志，禁远程遥测（08 §5.1 隐私 + 09 §2.8 不在范围）。
- **不引入新依赖**（`p80/p95` 算法自实装 ~20 行，禁 prom-client）。
- **不开第二套 logger**（守 INV-4 衍生）。MetricsCollector 内部 emit 仍经既有 `logger.info`。

**接口签名（src/observ/MetricsCollector.ts）**：

```ts
import { logger } from "../util/logger.js";

export interface ChannelMetrics {
  channel: string;
  total: number;
  success_count: number;          // outcome=worked or didnt（channel 正常）
  failure_count: number;          // outcome=unknown/error
  success_rate: number;           // success / total
  latency_ms_p50: number;
  latency_ms_p95: number;
  last_error?: string;
  last_error_at?: number;
}

/**
 * 进程内指标聚合（F3.7.5-12）—— per-channel/provider 维度。
 *
 * 设计：
 *  - 滑动窗口 RingBuffer(128)：每 channel 存最近 128 次 {outcome, latency_ms, ts}
 *  - p50/p95 就地排序计算（128 样本 O(n log n) < 1ms）
 *  - 不持久化（重启清零，与 HitRateStats 同范式）
 *  - 主路径低开销：record() 仅 push 到 RingBuffer，p95 只在 snapshot() 算
 */
export class MetricsCollector {
  private windows = new Map<string, RingBuffer<{outcome: string; latency_ms: number; ts: number}>>();

  constructor(private readonly windowSize = 128) {}

  /** 主路径记录 —— FallbackDecider 每次 InteractResult 返回时调。同步，无 await。 */
  record(
    channel: string,
    outcome: "worked" | "didnt" | "unknown" | "error",
    latencyMs: number,
  ): void {
    let buf = this.windows.get(channel);
    if (!buf) {
      buf = new RingBuffer<{outcome: string; latency_ms: number; ts: number}>(this.windowSize);
      this.windows.set(channel, buf);
    }
    buf.push({ outcome, latency_ms: latencyMs, ts: Date.now() });
    if (outcome === "error" || outcome === "unknown") {
      logger.info({
        evt: "metrics_failure",
        channel,
        outcome,
        latency_ms: latencyMs,
      });
    }
  }

  /** 取所有 channel 快照（doctor + admin metrics_snapshot 用） */
  snapshot(): ChannelMetrics[] {
    return Array.from(this.windows.entries()).map(([ch, buf]) => {
      const samples = buf.toArray();
      const total = samples.length;
      const success = samples.filter((s) => s.outcome === "worked" || s.outcome === "didnt").length;
      const failure = total - success;
      const latencies = samples.map((s) => s.latency_ms).sort((a, b) => a - b);
      const lastFail = samples.slice().reverse().find((s) => s.outcome === "error" || s.outcome === "unknown");
      return {
        channel: ch,
        total,
        success_count: success,
        failure_count: failure,
        success_rate: total === 0 ? 1 : success / total,
        latency_ms_p50: percentile(latencies, 0.5),
        latency_ms_p95: percentile(latencies, 0.95),
        last_error: lastFail ? lastFail.outcome : undefined,
        last_error_at: lastFail?.ts,
      };
    });
  }

  /** 告警扫描：success_rate < 0.5 且样本 ≥ 10 → logger.warn（admin/doctor 调） */
  scanForAlerts(threshold = 0.5): ChannelMetrics[] {
    const alerts = this.snapshot().filter(
      (m) => m.total >= 10 && m.success_rate < threshold,
    );
    for (const a of alerts) {
      logger.warn({ evt: "metrics_low_success_rate", ...a, threshold });
    }
    return alerts;
  }
}

// RingBuffer + percentile 为模块私有 helper（各 ~25 行）
```

**FallbackDecider 集成**：在 `runWithFallback` 末尾 `return` 前（worked/didnt/unknown 各 terminal 分支），调 `metrics?.record(channelName, outcome, Date.now() - start)`。`metrics` 通过构造器注入（同 budget 可选模式，缺省 null 零回归）。

---

### 3.3 子进程资源监控（SubprocessManager RSS/CPU 采样；告警阈值）

**借鉴源**：
- `src/subprocess/SubprocessManager.ts`（v0.1 已追踪 `pid / spawnedAt / lastUsedAt / restartCount`）—— **复用既有 procs/rustProcs Map，不另起追踪**
- `startZombieReaper` 60s setInterval 模式 —— **复用定时器模式**

**关键决策**：
- **不引入 `pidusage` / `process.execArgv` 第三方依赖**（守简单性）。用 Node 原生：
  - RSS：`fs.readFile(\`/proc/${pid}/statm\`)`（Linux）/ `process.memoryUsage()` 仅自身（macOS 不暴露子进程 RSS，降级记 `host_rss`）。
  - CPU：`fs.readFile(\`/proc/${pid}/stat\`)`（Linux）/ macOS 跳过（不报 cpu，仅 rss）。
- **不渗协议帧**（守 INV-46 新加，INV-7 衍生）。ResourceMonitor 只读 OS 文件，不与子进程 stdin/stdout 交互。
- **不阻塞主路径**（旁路采样）。

**接口签名（src/observ/ResourceMonitor.ts）**：

```ts
import { logger } from "../util/logger.js";

export interface SubprocResourceSnapshot {
  name: string;
  pid: number | null;
  rss_mb: number | null;          // Linux 有；macOS 降级 null
  cpu_percent: number | null;     // Linux 有；macOS 降级 null
  sampled_at: number;
}

/**
 * 子进程资源采样器（F3.5.12）—— 旁路监控 SubprocessManager 的所有子进程。
 *
 * 设计：
 *  - 60s 周期采样（与 zombie reaper 同 interval，但独立 timer）
 *  - 仅 Linux 暴露 /proc；macOS RSS 降级为 host process.memoryUsage()
 *  - 告警阈值：RSS > 1024MB OR CPU > 80% 持续 N 次 → logger.warn
 *  - 不 kill 进程（仅告警；admin 决策）
 *  - 守 INV-46：不读子进程 stdin/stdout（INV-7 协议帧纯净性衍生）
 */
export class ResourceMonitor {
  private timer: NodeJS.Timeout | null = null;
  private hotStreak = new Map<string, number>();  // 连续超阈值次数

  constructor(
    /** SubprocessManager 的 procs/rustProcs 快照 provider（注入） */
    private readonly listPids: () => Array<{ name: string; pid: number | null }>,
    private readonly threshold = { rss_mb: 1024, cpu_percent: 80, hot_streak: 5 },
  ) {}

  start(intervalMs = 60_000): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.sample().catch((e) =>
        logger.error({ evt: "resource_monitor_error", error: String(e) }),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  async sample(): Promise<SubprocResourceSnapshot[]> {
    const out: SubprocResourceSnapshot[] = [];
    for (const { name, pid } of this.listPids()) {
      const snap = await this._sampleOne(name, pid);
      out.push(snap);
      this._checkThreshold(snap);
    }
    return out;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async _sampleOne(name: string, pid: number | null): Promise<SubprocResourceSnapshot> {
    if (pid === null || process.platform !== "linux") {
      // macOS 降级：host RSS（不报子进程）
      const mem = process.memoryUsage();
      return {
        name, pid,
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        cpu_percent: null,
        sampled_at: Date.now(),
      };
    }
    // Linux /proc/<pid>/statm[1] (resident pages × page_size)
    try {
      const statm = await fs.readFile(`/proc/${pid}/statm`, "utf8");
      const residentPages = Number(statm.split(" ")[1]);
      const rss_mb = Math.round((residentPages * 4096) / 1024 / 1024);
      return { name, pid, rss_mb, cpu_percent: null, sampled_at: Date.now() };
    } catch {
      return { name, pid, rss_mb: null, cpu_percent: null, sampled_at: Date.now() };
    }
  }

  private _checkThreshold(s: SubprocResourceSnapshot): void {
    const hot =
      (s.rss_mb !== null && s.rss_mb > this.threshold.rss_mb) ||
      (s.cpu_percent !== null && s.cpu_percent > this.threshold.cpu_percent);
    if (!hot) {
      this.hotStreak.delete(s.name);
      return;
    }
    const n = (this.hotStreak.get(s.name) ?? 0) + 1;
    this.hotStreak.set(s.name, n);
    if (n >= this.threshold.hot_streak) {
      logger.warn({
        evt: "resource_threshold_exceeded",
        name: s.name,
        rss_mb: s.rss_mb,
        cpu_percent: s.cpu_percent,
        hot_streak: n,
      });
    }
  }
}
```

**index.ts 装配**：

```ts
const resourceMonitor = new ResourceMonitor(() => {
  // SubprocessManager 暴露 listManagedPids()（v0.7 加只读 accessor，~10 行）
  return subproc.listManagedPids();
});
resourceMonitor.start();  // 60s 周期；timer.unref 不阻 exit
```

**关键边界**：macOS 开发环境 RSS 是 host 进程，仅作"是否内存泄漏"的相对参考；告警阈值的绝对值（1024MB）需运维校准 —— doctor 报告里显式标注"linux 精确 / macos 近似"。

---

### 3.4 SERP 改版检测实装（SelectorRegistry + HitRateStats + ChangeDetection 真联动；命中率下降→检测→告警）

**借鉴源**：v0.2 骨架已就位 —— **本节做"骨架 → 主路径"的接入工作**。
- `src/serp/SelectorRegistry.ts` recordHit/recordMiss（已就位，未实例化）
- `src/serp/HitRateStats.ts` scanForAlerts（已就位）
- `src/serp/ChangeDetection.ts` detectChange（已就位）
- `src/serp/RecordingStore.ts` save/load/list（已就位）

**当前现状（grep 实证）**：4 件骨架**全部未实例化**（`new SelectorRegistry` 等在 `src/` 内 0 命中）—— v0.7 首次装配。

**关键决策（守简单性 + R-CI-02）**：
- **不重写骨架**（守 INV-45 新加）。4 件骨架一行不改，v0.7 加第 5 个文件 `SerpHealthMonitor` 做协调器（粘合层）。
- **不自动重写 selector 表**（守 INV-47 新加）。改版确认后只 `logger.warn` + `retrieval_method="serp_degraded_after_redesign"`，由人工 v1.0 走 RecordingStore fixture 升级。
- **不阻塞主路径**。改版检测在 `extract.ts` 抽完结果后异步触发。

**接口签名（src/serp/SerpHealthMonitor.ts）**：

```ts
import { SelectorRegistry, type VersionedSelectorSet } from "./SelectorRegistry.js";
import { HitRateStats } from "./HitRateStats.js";
import { ChangeDetection } from "./ChangeDetection.js";
import { RecordingStore } from "./RecordingStore.js";
import { logger } from "../util/logger.js";

export interface SerpHealthSnapshot {
  engines: Array<{
    engine: string;
    hit_rate: number;
    hit: number;
    miss: number;
    last_known_good: string;
    redesign_suspected: boolean;
  }>;
  recent_alerts: Array<{ key: string; rate: number; at: number }>;
  recordings_count: number;
}

/**
 * SERP 改版检测协调器（F3.8.9-12 实装）。
 *
 * 粘合 v0.2 四件骨架：SelectorRegistry（版本化 selector）+ HitRateStats（命中率）+
 * ChangeDetection（dom hash 对比）+ RecordingStore（fixture 落盘）。
 *
 * 触发链路（被动，由 extract.ts 调 onResult）：
 *   1. extract 抽完一次 → registry.recordHit/recordMiss + hitRate.recordHit/recordMiss
 *   2. 命中率 < 50%（样本 ≥ 5）→ 异步 ChangeDetection.detectChange 验证
 *   3. dom hash 变 → 确认改版：
 *      a) logger.warn（admin/doctor 可见）
 *      b) RecordingStore.save 落盘 fixture（v1.0 回归用）
 *      c) 返回 retrieval_method 标记 "serp_degraded_after_redesign" 给 extract
 *
 * 不做（INV-47）：自动重写 selector 表（保守人工升级）。
 * 不做：实时告警推送（仅进程内 + logger）。
 */
export class SerpHealthMonitor {
  constructor(
    private readonly registry: SelectorRegistry,
    private readonly hitRate: HitRateStats,
    private readonly change: ChangeDetection,
    private readonly recordings: RecordingStore,
    private readonly threshold = 0.5,
  ) {}

  /**
   * extract.ts 在抽完结果后调（不抛错；失败保守 no-op）。
   * - hit=true（抽到结果）→ registry.recordHit + hitRate.recordHit
   * - hit=false（0 结果）→ registry.recordMiss + hitRate.recordMiss
   * - 命中率触发阈值 → 异步 detectChange（不 await extract 主路径）
   */
  onResult(
    engine: "baidu" | "google",
    selectorVersion: string,
    query: string,
    dom: string,
    hit: boolean,
  ): void {
    const key = `${engine}:${selectorVersion}`;
    if (hit) {
      this.registry.recordHit(engine, selectorVersion);
      this.hitRate.recordHit(key);
    } else {
      this.registry.recordMiss(engine, selectorVersion);
      this.hitRate.recordMiss(key);
    }
    // 异步验证（不阻 extract）
    void this._maybeDetectRedesign(engine, query, dom).catch(() => {/* 保守吞错 */});
  }

  /** doctor + admin serp_health 调 */
  snapshot(): SerpHealthSnapshot {
    const alerts = this.hitRate.scanForAlerts(this.threshold);
    const engines = this.registry.engines().map((engine) => {
      const rate = this.registry.hitRate(engine);
      const list = this.registry.get(engine);
      const last_known_good = list[0]?.last_known_good ?? "unknown";
      return {
        engine,
        hit_rate: rate.rate,
        hit: rate.hit,
        miss: rate.miss,
        last_known_good,
        redesign_suspected: rate.rate < this.threshold && (rate.hit + rate.miss) >= 5,
      };
    });
    return {
      engines,
      recent_alerts: alerts.map((a) => ({ key: a.key, rate: a.rate, at: Date.now() })),
      recordings_count: 0,  // 同步列略重，doctor 按需调 recordings.list().length
    };
  }

  private async _maybeDetectRedesign(
    engine: "baidu" | "google",
    query: string,
    dom: string,
  ): Promise<void> {
    const snap = this.registry.hitRate(engine);
    if (snap.hit + snap.miss < 5) return;        // 样本不足
    if (snap.rate >= this.threshold) return;      // 命中率仍 OK
    const result = await this.change.detectChange(engine, query, dom);
    if (result.changed) {
      logger.warn({
        evt: "serp_redesign_confirmed",
        engine,
        baseline_hash: result.baseline_hash?.slice(0, 8),
        current_hash: result.current_hash.slice(0, 8),
      });
      // 落盘 fixture（v1.0 回归用；保守 no-op on error）
      await this.recordings.save(engine, query, dom).catch(() => {});
    }
  }
}
```

**extract.ts 改动（~30 行）**：

```ts
// serpScrapeFallback 末尾（在 return worked 前）：
const hit = results.count > 0;
serpHealth?.onResult("baidu", "v1", query, preview, hit);  // 注入 SerpHealthMonitor | null

// BrowseExec signature 扩展（加可选第 2 参 serpHealth，缺省 null 零回归）
export type BrowseExec = (url: string) => Promise<{...}>;
export async function serpScrapeFallback(
  query: string,
  limit: number,
  browseExec: BrowseExec,
  serpHealth?: SerpHealthMonitor | null,  // v0.7 新增可选
): Promise<InteractResult<SearchResult>> { ... }
```

**index.ts 装配**：

```ts
const serpRegistry = new SelectorRegistry();
const serpHitRate = new HitRateStats();
const serpChange = new ChangeDetection(path.join(cacheDir, "serp-baseline"));
const serpRecordings = new RecordingStore(path.join(cacheDir, "serp-recordings"));
const serpHealth = new SerpHealthMonitor(serpRegistry, serpHitRate, serpChange, serpRecordings);

// 修改 browseHeadlessExec 注入 serpHealth 给 serpScrapeFallback
// 修改 search tool 注册时注入 serpHealth
```

**关键边界**：
- 不解 2FA / 不绕反爬（08 §7.3）。
- 改版检测的 dom 字符串是 a11y 树文本（chrome-devtools-mcp take_snapshot 输出），不是 HTML —— 与 v0.1 extract.ts 现有 URL 正则范式一致。
- baseline 首次缺失时 `detectChange` 返 `changed=false`（保守不告警，v0.2 ChangeDetection 既有语义）。

---

### 3.5 observability tool（暴露指标 + 熔断 + SERP 健康）

**借鉴源**：
- `src/tools/admin.ts`（v0.6 单 tool + action-enum 折叠 9 action）—— **扩展 enum，不开新 tool**
- INV-17（desktop action-enum）/ INV-37 task（admin 经 ToolManager）—— **同范式守 INV-44 新加**

**关键决策（R-INT-02 + R-CI-02）**：
- **不开新 `observability` tool**（守 INV-44 新加，INV-17 衍生）。在 admin tool 加 3 个**只读** action。
- **全部只读**（无 mutation 风险）。不破坏 admin mutation action 强制 reason 的纪律。

**runtime-types.ts 改动（5 行）**：

```ts
export type AdminAction =
  | "capability_list"
  | "capability_disable"
  | "capability_enable"
  | "tool_list"
  | "provider_add"
  | "provider_remove"
  | "provider_set_tos"
  | "caller_cap_set"
  | "caller_cap_list"
  // v0.7 新增 3 个只读 observability action（F3.12.10 + F3.7.5-12）
  | "metrics_snapshot"    // per-channel 成功率 / p95
  | "breaker_status"      // 短/长熔断状态
  | "serp_health";        // SERP 命中率 / 改版告警
```

**admin.ts 改动（~120 行）**：

```ts
// adminSchema.action enum 加 3 项（与 AdminAction 对齐）
action: z.enum([
  ..., "metrics_snapshot", "breaker_status", "serp_health",
]),

// AdminToolDeps 加 3 个注入
export interface AdminToolDeps {
  bag: CapabilityBag;
  toolManager: ToolManager;
  callerTier: CallerTierTracker;
  registry: ProviderRegistry;
  // v0.7 新增（全部可选；零回归：未注入时 3 个 action 返 "not_configured"）
  metrics?: MetricsCollector;
  breakers?: Map<string, CircuitBreaker>;
  longBreakers?: Map<string, LongCircuitBreaker>;
  serpHealth?: SerpHealthMonitor;
}

// handler switch 加 3 个 case（只读，不写 audit log）
case "metrics_snapshot":
  return ok(action, {
    channels: deps.metrics ? deps.metrics.snapshot() : [],
    alerts: deps.metrics ? deps.metrics.scanForAlerts() : [],
    configured: !!deps.metrics,
  });
case "breaker_status": {
  const short_ = deps.breakers
    ? Array.from(deps.breakers.entries()).map(([name, b]) => ({
        channel: name, kind: "short" as const,
        state: b.state, failure_count: b.failureCountReadOnly,
        opened_at: b.openedAtReadOnly,
      }))
    : [];
  const long_ = deps.longBreakers
    ? Array.from(deps.longBreakers.entries()).map(([name, b]) => ({
        channel: name, kind: "long" as const,
        state: b.state, window_failure_count: b.windowFailureCount,
        opened_at: b.openedAtReadOnly,
      }))
    : [];
  return ok(action, { breakers: [...short_, ...long_] });
}
case "serp_health":
  return ok(action, deps.serpHealth ? deps.serpHealth.snapshot() : { configured: false });
```

**doctor.ts 改动（~30 行）**：`runtime_state` section 扩 `metrics` / `breakers` / `serp_health` 子字段（数据源 provider 注入；守 INV-35 不 import runtime/ 句柄，仅注入 snapshot 函数 —— 同 v0.6 runtime_state 范式）。

---

## 4. 不明确点调研结论

### 4.1 长熔断与短熔断怎么协同？
**结论**：**双 breaker 串联**（短/长独立状态机 + 同 key Map + allow() AND 串联）。
- 证据：`FallbackDecider.ts:147` 既有 `if (breaker && !breaker.allow())` 模式，加同构 longB 检查是最低熵变更（R-INT-02 ≤ 2 处改动：构造器注入 + 主循环检查）。
- 拒绝方案 A（合并到 CircuitBreaker 单类多参数）：会破坏 v0.6 短熔断零回归承诺。
- 拒绝方案 B（长熔断独立 decider）：违 INV-4（FallbackDecider ≤ 1）。

### 4.2 指标暴露是 admin tool 扩展还是新 tool？
**结论**：**admin action-enum 扩展 3 个只读 action**。
- 证据：admin tool 是 v0.6 虚拟 channel，action-enum 折叠范式已立（INV-17 / INV-37 task）；新 tool 会污染 CC tool palette 且违 INV-17 同构。
- 09 §2.8 + 08 §3.7 原文 "`channel_health` admin 工具" —— 设计意图就是 admin tool 内。
- 全部只读 → 不破坏 admin mutation 的 `reason` 强制纪律。

### 4.3 SERP 改版检测的触发与降级策略？
**结论**：**被动触发 + 三段保守降级**。
- 触发：`HitRateStats` 命中率 < 50%（样本 ≥ 5，v0.2 既有阈值）→ 异步 `ChangeDetection.detectChange`（dom hash 对比）→ 改版确认。
- 降级三段：
  1. `logger.warn`（admin/doctor 可见）
  2. `RecordingStore.save` 落盘 fixture（v1.0 回归用）
  3. `retrieval_method="serp_degraded_after_redesign"` 透传给 CC（CC 看到标记会主动换策略，如改用 search.brave）
- 拒绝方案（自动重写 selector 表）：**NO-GO**（守 INV-47）。selector 改版是低频高破坏事件（08 §3.8 "债不是资产"），自动重写风险大于收益。

### 4.4 长熔断联动 bag.disable 后，bag.onChange handler 是否会 kill 子进程？
**结论**：**会，但这是设计意图，不是 bug**。
- 证据：`index.ts:503-538` bag.onChange handler 在 channel disable 时调 `subproc.shutdownOne(specName)`（INV-37 task / INV-39 task）。
- 长熔断代表"月配额耗尽类持续故障"，kill 子进程是合理的（避免持续打挂的 endpoint 浪费连接）。
- 恢复路径：60min 后 half-open probe 成功 → `recordSuccess` → state=closed；但 bag 仍 disabled → admin 手工 `capability_enable` 显式恢复（保守设计，见 §3.1 关键边界）。

---

## 5. 测试计划

### 5.1 单元测试（CI 主路径，~500 行）

| 模块 | 测试集 | 关键 case |
|---|---|---|
| LongCircuitBreaker | `test/long-circuit-breaker.test.ts`（~120 行） | ① windowMs 内 threshold-1 次失败仍 closed；② threshold 次触发 open + onOpen 回调；③ windowMs 外的失败被丢弃；④ reset() 回 closed；⑤ half-open probe 成功回 closed；⑥ half-open probe 失败回 open + onOpen；⑦ onOpen 抛错不污染状态 |
| MetricsCollector | `test/metrics-collector.test.ts`（~100 行） | ① RingBuffer(128) 超容量丢弃最老；② p50/p95 算法正确性（已知样本）；③ success_rate=0/1 边界；④ scanForAlerts 阈值；⑤ snapshot 不可变（外部 mutate 不污染） |
| ResourceMonitor | `test/resource-monitor.test.ts`（~80 行） | ① Linux /proc/<pid>/statm 解析（mock fs）；② macOS 降级返 host rss；③ hot_streak 计数 + 5 次触发 logger.warn；④ stop() 清 timer |
| SerpHealthMonitor | `test/serp-health-monitor.test.ts`（~150 行） | ① onResult(hit=true) 计 hit；② onResult(hit=false) 计 miss；③ 命中率 < 50% 且样本 ≥ 5 触发 detectChange；④ ChangeDetection 返 changed=true → logger.warn + RecordingStore.save；⑤ snapshot 形状正确 |
| admin observ action | `test/admin-observ.test.ts`（~80 行） | ① metrics_snapshot 返 channels 列表；② breaker_status 含短+长；③ serp_health 含 engines；④ deps 不注入时返 configured:false（零回归） |

### 5.2 集成测试（~150 行）

| 测试 | 验证点 |
|---|---|
| `test/integration/long-circuit-triggers-bag-disable.test.ts` | 长熔断 open → bag.disable → toolManager.disableChannel + subproc.shutdownOne 全链路；守 INV-42 |
| `test/integration/fallback-with-long-breaker.test.ts` | 双 breaker 串联：短 open 跳过当次、长 open 持续跳过 60min；longBreakers=null 时完全等价 v0.6 |
| `test/integration/serp-extract-wires-health.test.ts` | serpScrapeFallback 抽 0 结果 → HitRateStats.miss++；连续 5 次 → redesign_suspected=true |

### 5.3 不变量测试（INV-41..47，~150 行 in check-invariants.mjs）

| INV | 断言形式 |
|---|---|
| **INV-41** | `src/` 全树只有一个熔断引擎模块目录：`src/fallback/` 含 CircuitBreaker.ts + LongCircuitBreaker.ts；禁 `src/observ/CircuitBreaker.ts` 等第二套 |
| **INV-42** | `LongCircuitBreaker` 的 onOpen 回调体（grep `onOpen\|long_circuit_open`）必经 `bag.disable`（不绕过 INV-37 task 链） |
| **INV-43** | `src/observ/` 全树禁 `prom-client\|prometheus\|statsd\|dogstatsd` 字面量；守进程内承诺 |
| **INV-44** | `src/tools/` 全树只有一个 admin tool 注册（grep `registerAdminTool` 计数 = 1）；禁 `registerObservTool` 等第二 tool |
| **INV-45** | SelectorRegistry/HitRateStats/ChangeDetection/RecordingStore 类定义只在 `src/serp/`（grep `export class` 计数 = 1 each） |
| **INV-46** | ResourceMonitor 类不 import `McpClient\|RustBridge\|StdioClientTransport`（不渗协议帧） |
| **INV-47** | `src/serp/SerpHealthMonitor.ts` 全文禁 `recordHit.*v2\|upgradeVersion\|rewriteSelector\|setSelectors`（保守不自动升级 selector） |

---

## 6. 验收标准（引用 09 §2.8 + 细化）

### 6.1 量化标准

| # | 标准 | 引用 | CI/手测 |
|---|---|---|---|
| 1 | 40 → **47 invariants 全绿**（INV-41..47 新加，v0.6 INV-1..40 零改） | 09 §2.8 + 本 parse §5.3 | CI: `npm run check-invariants` |
| 2 | v0.6 测试集 **零回归**（v0.7 测试集增量通过） | 09 §2.8 | CI: `npm test` |
| 3 | TS 行数 ≈ **2280**（v0.6 1081 + v0.7 ~1200）；Rust 行数零改（144） | 本 parse §2 | CI: `wc -l` |
| 4 | 60min 长熔断触发 → CapabilityBag.disable → SubprocessManager.shutdownOne 全链路打通 | 09 §2.8 + F3.4.5 | CI: 集成测试（§5.2） |
| 5 | 长熔断与短熔断**独立状态机**（短 open 60s 不触发 onOpen；长 open 60min 触发） | 08 §2.6 | CI: LongCircuitBreaker 单测 |
| 6 | MetricsCollector 算 p50/p95 在 128 样本下 < 1ms | F3.7.5-12 | CI: 单测 + 基准 |
| 7 | admin tool 加 3 个只读 action（metrics/breakers/serp_health），全部不要求 reason | F3.12.10 | CI: admin-observ 单测 |
| 8 | SERP 命中率 < 50%（样本 ≥ 5）+ dom hash 变 → 告警 + retrieval_method 标记 | F3.8.9-12 | CI: 集成测试（§5.2） |
| 9 | doctor runtime_state 含 metrics / breakers / serp_health 子字段 | F3.7.6 | 手测: `lasso doctor` |
| 10 | 进程退出无残留 timer（ResourceMonitor + zombie reaper 都 unref + shutdown 清理） | 08 §5.3 | CI: 内存泄漏测试 |

### 6.2 不变量回归（守 v0.6）
- INV-1..40 全部不动一条（INV-35..40 是 v0.6 加的 runtime 红线，v0.7 在它们之上叠加）
- 特别是 INV-4（FallbackDecider ≤ 1）—— v0.7 长熔断接在 FallbackDecider 第 3 参，**不开第二 decider**
- INV-37 task（channel disable 必经 ToolManager）—— v0.7 长熔断经 bag.disable → onChange → ToolManager 链，**不绕过**

---

## 7. 风险 + 实施顺序（分 phase）

### 7.1 风险 Register（v0.7 新增）

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R13 | 长熔断与短熔断状态机协同 bug（误 open） | 中 | 高 | 双 breaker 同 key Map 但独立 state；先单测覆盖 half-open 边界再集成 |
| R14 | MetricsCollector 主路径开销超预期（p95 排序） | 低 | 低 | RingBuffer(128) 上限；record() 仅 push；p95 仅 snapshot 时算 |
| R15 | macOS 不暴露子进程 RSS → ResourceMonitor 降级为 host rss 失真 | 高 | 低 | doctor 标注"linux 精确 / macos 近似"；告警阈值运维校准 |
| R16 | SERP 改版误告警（用户偶发空结果触发） | 中 | 中 | 样本 ≥ 5 + dom hash 双确认；retrieval_method 标记是软降级非硬切 |
| R17 | admin action enum 扩展破坏 zod schema 兼容 | 低 | 中 | enum 扩展是加法，旧 CC 调用不影响；契约测试守 |

### 7.2 实施顺序（6 phase，每 phase 可独立交付）

```
Phase A (M0.7a) 基础：长熔断 + CapabilityBag 联动  ★ 最关键
  ├─ src/fallback/LongCircuitBreaker.ts（新）
  ├─ src/fallback/FallbackDecider.ts 改（双 breaker 串联）
  ├─ src/invariants/check-invariants.mjs 加 INV-41/42
  └─ test/long-circuit-breaker.test.ts + test/integration/long-circuit-triggers-bag-disable.test.ts
  验收：长熔断 open → bag.disable → shutdownOne 全链路；INV-41/42 绿
   ↓
Phase B (M0.7b) 指标层
  ├─ src/observ/MetricsCollector.ts（新）
  ├─ src/fallback/FallbackDecider.ts 改（record 钩子）
  ├─ src/invariants/check-invariants.mjs 加 INV-43
  └─ test/metrics-collector.test.ts
  验收：p50/p95 正确；零回归（metrics=null 时 FallbackDecider 等价 v0.6）
   ↓
Phase C (M0.7c) 子进程资源监控
  ├─ src/observ/ResourceMonitor.ts（新）
  ├─ src/subprocess/SubprocessManager.ts 加 listManagedPids()（~10 行只读 accessor）
  ├─ src/invariants/check-invariants.mjs 加 INV-46
  └─ test/resource-monitor.test.ts
  验收：Linux /proc 解析 + macOS 降级 + hot_streak 告警
   ↓
Phase D (M0.7d) SERP 改版检测实装
  ├─ src/serp/SerpHealthMonitor.ts（新）
  ├─ src/serp/extract.ts 改（onResult 钩子）
  ├─ src/invariants/check-invariants.mjs 加 INV-45/47
  └─ test/serp-health-monitor.test.ts + test/integration/serp-extract-wires-health.test.ts
  验收：骨架 4 件首次实例化 + 主路径联动；改版 → 告警 + 落盘 fixture
   ↓
Phase E (M0.7e) observability admin action 扩展 + doctor 扩展
  ├─ src/runtime/runtime-types.ts 改（AdminAction +3）
  ├─ src/tools/admin.ts 改（schema + handler +3 case）
  ├─ src/doctor/doctor.ts 改（runtime_state 扩字段）
  ├─ src/invariants/check-invariants.mjs 加 INV-44
  └─ test/admin-observ.test.ts
  验收：admin metrics_snapshot/breaker_status/serp_health 3 action 返结构化 JSON
   ↓
Phase F (M0.7f) 装配 + 文档
  ├─ src/index.ts 装配 5 件（LongCircuitBreaker Map + MetricsCollector + ResourceMonitor + SerpHealthMonitor + serp 4 件）
  ├─ doctor_opts.runtimeState 扩 metrics/breakers/serp_health
  └─ README v0.7 章节 + 09 §2.8 实际验收打勾
  验收：真机 boot `lasso doctor` 报 runtime_state 三新字段全显；6.1 全部 ✅
```

### 7.3 关键依赖
- Phase A 是后 5 phase 的根（longBreakers Map 在 index.ts 装配后，metrics/serp/admin 才有数据源）。
- Phase D 依赖 Phase A（SERP 告警的"软降级"路径可选择性标记 `retrieval_method="serp_degraded_after_redesign"`，但即使无 Phase A，SERP 改版检测仍可独立工作 —— onResult 不依赖 metrics）。
- Phase E 依赖 Phase A/B/D（admin action 是只读查询，需先有 metrics + breakers + serp 数据源）。

### 7.4 任意阶段失败的回退
- 每 phase 打 tag（v0.7a / v0.7b / ...），失败回退到上一 tag。
- Phase A 失败 → 回 v0.6 tag，长熔断延后 v0.8（其他 phase 可降级独立交付）。
- Phase D 失败 → SERP 骨架保持 v0.2 状态（不实例化），其余 phase 仍可交付。

---

## 文档结束

本 parse8 是 Lasso v0.7 文件/函数级执行计划（在 parse7 v0.6 CapabilityBag 之上增量）。守简单性：长熔断复用 CircuitBreaker 范式（同模块加类，INV-41 不开第二引擎）、指标层复用 logger（INV-43 禁 Prometheus）、SERP 复用 v0.2 骨架（INV-45 不重造）、长熔断联动 v0.6 CapabilityBag（INV-42 不绕过）。**v0.6 零回归承诺：1081 TS + 144 Rust + 40 invariants 一行不改**，新加 INV-41..47 共 7 条。实施分 6 phase，Phase A 长熔断是根，每 phase 可独立交付与验证。

---

**相关文件路径**（绝对路径，供下游 implementer 直接读）：
- 排期：`/Users/wangdong/Documents/Project/cc-control-all/doc/09-media-interact-实施排期.md`（§2.8 v0.7）
- 架构：`/Users/wangdong/Documents/Project/cc-control-all/doc/08-media-interact-功能架构.md`（§2.6 双层熔断 / §3.7 可观测 / §3.8 SERP）
- v0.1 短熔断（复用范式）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/fallback/CircuitBreaker.ts`（79 行，第 9-10 行注释明示"v0.7 在同模块加长熔断"）
- v0.1 fallback 引擎（双 breaker 串联处）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/fallback/FallbackDecider.ts:147-158`
- v0.6 CapabilityBag（onOpen 联动目标）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/runtime/CapabilityBag.ts`
- v0.1 logger（指标层复用）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/util/logger.ts`
- v0.2 SERP 骨架（4 件全未实例化，v0.7 首次装配）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/serp/{SelectorRegistry,HitRateStats,ChangeDetection,RecordingStore}.ts`
- v0.6 admin tool（action-enum 扩展点）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/tools/admin.ts:55-65`（schema）+ `:157-306`（handler switch）
- v0.6 index.ts 装配（bag.onChange 联动链）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/index.ts:503-538`
- v0.6 INV 脚本（v0.7 加 INV-41..47）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/invariants/check-invariants.mjs:1098-1365`（INV-35..40 范式参考）
- v0.6 doctor（runtime_state section）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/src/doctor/doctor.ts:369-382`