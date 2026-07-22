/**
 * MetricsCollector —— 进程内 per-channel 指标聚合（parse8 §3.2 / F3.7.5-12）
 *
 * 设计原则（parse8 §3.2 R-CI-02 + 08 §0 非目标）：
 *  - **进程内 only**：禁 Prometheus exporter、禁远程遥测（守 INV-43）
 *  - **不引入新依赖**：RingBuffer + percentile 算法本模块自实装（禁 prom-client）
 *  - **不开第二套 logger**：内部 emit 仍走既有 logger.info/warn（INV-4 衍生）
 *  - **主路径低开销**：record() 仅 push 到 RingBuffer（O(1)）；p50/p95 仅 snapshot() 时算
 *
 * 维度（INV-44）：**per-channel**（"search.zhipu" / "browse_headless" / "desktop.ax" / ...）。
 *  - record 必带 channel 名（无 channel 不入窗）
 *  - 同一 channel 的样本累积在同一 RingBuffer
 *
 * 滑动窗 RingBuffer(128)：
 *  - 每 channel 存最近 128 次 { outcome, latency_ms, ts }（与 state-store LRU(128) 同范式）
 *  - 超容量丢弃最老（FIFO；保证内存上限）
 *  - 不持久化（进程重启清零；与 HitRateStats 同范式）
 *
 * 借鉴源（parse8 §3.2）：
 *  - logger.ts JSON 行级日志（复用 emit 范式）
 *  - CapabilityBag.snapshot() 模式（深拷贝防外部 mutate）
 *  - state-store.ts LRU(128)（容量上限范式）
 */
import { logger } from "../util/logger.js";

// ============================================================
// 类型
// ============================================================
export interface ChannelMetrics {
  channel: string;
  total: number;
  /** outcome=worked or didnt（channel 正常） */
  success_count: number;
  /** outcome=unknown or error（channel 故障） */
  failure_count: number;
  /** success / total；total=0 时返 1（乐观默认，防冷启动误报） */
  success_rate: number;
  latency_ms_p50: number;
  latency_ms_p95: number;
  /** 最近一次失败的 outcome 字符串（无失败则 undefined） */
  last_error?: string;
  /** 最近一次失败的 epoch ms */
  last_error_at?: number;
}

interface Sample {
  outcome: string;
  latency_ms: number;
  ts: number;
}

// ============================================================
// RingBuffer（模块私有；容量上限环形缓冲）
// ============================================================
/**
 * 定容环形缓冲：超容量丢弃最老（FIFO）。
 *
 * 借鉴 state-store LRU(128) 范式但**简化为 FIFO**（无 LRU touch 语义）——
 * 指标样本时间顺序敏感，无"最近访问"语义。
 */
class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) {
      // 丢弃最老（FIFO）
      this.buf.shift();
    }
  }
  toArray(): T[] {
    // 浅拷贝防外部 mutate 内部
    return this.buf.slice();
  }
  get length(): number {
    return this.buf.length;
  }
}

// ============================================================
// MetricsCollector
// ============================================================
export class MetricsCollector {
  private windows = new Map<string, RingBuffer<Sample>>();

  constructor(private readonly windowSize = 128) {}

  /**
   * 主路径记录（FallbackDecider 在每次 InteractResult 终端分支调）。
   *
   * 设计：同步、无 await；O(1)（push 到 RingBuffer，超容量才 shift）。
   * 失败样本额外 emit logger.info（便于日志侧 grep 统计）。
   */
  record(
    channel: string,
    outcome: "worked" | "didnt" | "unknown" | "error",
    latencyMs: number,
  ): void {
    let buf = this.windows.get(channel);
    if (!buf) {
      buf = new RingBuffer<Sample>(this.windowSize);
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

  /**
   * 所有 channel 快照（doctor runtime_state.metrics + admin metrics_snapshot 用）。
   *
   * 返回新数组 + 每条 deep-copy（外部 mutate 不污染内部 RingBuffer）。
   * p50/p95 在此处就地为每 channel 排序（O(n log n), n≤128，<1ms）。
   */
  snapshot(): ChannelMetrics[] {
    const out: ChannelMetrics[] = [];
    for (const [channel, buf] of this.windows.entries()) {
      const samples = buf.toArray();
      const total = samples.length;
      const success = samples.filter(
        (s) => s.outcome === "worked" || s.outcome === "didnt",
      ).length;
      const failure = total - success;
      const latencies = samples.map((s) => s.latency_ms).sort((a, b) => a - b);
      // 逆序找最近一次失败（last_error / last_error_at）
      let lastError: Sample | undefined;
      for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i];
        if (s.outcome === "error" || s.outcome === "unknown") {
          lastError = s;
          break;
        }
      }
      out.push({
        channel,
        total,
        success_count: success,
        failure_count: failure,
        success_rate: total === 0 ? 1 : success / total,
        latency_ms_p50: percentile(latencies, 0.5),
        latency_ms_p95: percentile(latencies, 0.95),
        last_error: lastError?.outcome,
        last_error_at: lastError?.ts,
      });
    }
    return out;
  }

  /**
   * 告警扫描：success_rate < threshold 且样本 ≥ 10 → logger.warn。
   * 返回告警列表（admin / doctor 调）。
   *
   * 样本下限 10：避免冷启动期少量失败误告警（与 HitRateStats 阈值 5 同思路，但更保守）。
   */
  scanForAlerts(threshold = 0.5): ChannelMetrics[] {
    const alerts = this.snapshot().filter(
      (m) => m.total >= 10 && m.success_rate < threshold,
    );
    for (const a of alerts) {
      logger.warn({
        evt: "metrics_low_success_rate",
        channel: a.channel,
        total: a.total,
        success_rate: a.success_rate,
        threshold,
      });
    }
    return alerts;
  }
}

// ============================================================
// percentile（模块私有）
// ============================================================
/**
 * 就地 percentile 计算（已排序数组）。
 *
 * 采用 "lower rank" 算法（最近邻索引；不插值）：
 *  - rank = p * (n - 1)，向下取整
 *  - 空数组返 0
 *
 * 与 prom-client / pino 默认算法差异 <1%（128 样本规模可忽略）；
 * 选择本算法为简单性（无浮点插值；20 行内）。
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = Math.floor(p * (sortedAsc.length - 1));
  return sortedAsc[rank];
}
