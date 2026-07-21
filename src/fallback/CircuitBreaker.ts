/**
 * 60s 短熔断器（parse1 §3.7 + 08 §2.6）
 *
 * 三态状态机：
 *  - closed    : 正常放行；连续失败数累计到 threshold 即转 open
 *  - open      : 拒所有请求；经过 resetMs 后转 half-open（放一个 probe）
 *  - half-open : 只放一个探测请求；成功 → closed，失败 → open（重置计时）
 *
 * 设计注记：60s 短熔断对应"限流 / 瞬时网络毛刺"窗口；60min 长熔断
 * （Argus 风格）在 v0.7 加，现在不做。threshold=3 来自 parse1 §3.7。
 *
 * 单 channel 一个 breaker（见 FallbackDecider 构造），不跨 channel 共享。
 */
export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  state: BreakerState = "closed";
  private failureCount = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = 3,
    private readonly resetMs = 60_000,
  ) {}

  /**
   * 是否放行本次请求。
   *  - closed    → true
   *  - open      → 看 resetMs 是否到；到则 half-open + 放行，否则拒
   *  - half-open → 放行（只允许一次 probe，由 recordSuccess/Failure 推动状态）
   */
  allow(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this.openedAt > this.resetMs) {
        this.state = "half-open";
        return true;
      }
      return false;
    }
    // half-open
    return true;
  }

  /** 成功：清零失败计数 + 回到 closed（half-open 的 probe 成功也走这里）。 */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  /**
   * 失败：累计 + 可能转 open。
   *  - closed    → 失败计数 +1，到 threshold 转 open
   *  - half-open → 失败立即转 open（重置 openedAt）
   *  - open      → 幂等（保持 open，刷新 openedAt 以延长窗口）
   */
  recordFailure(): void {
    this.failureCount++;
    if (this.state === "half-open" || this.failureCount >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  /** 测试 / 监控用：当前失败计数。 */
  get failureCountReadOnly(): number {
    return this.failureCount;
  }

  /** 测试 / 监控用：上次 open 的时间戳（ms since epoch）；未 open 过为 0。 */
  get openedAtReadOnly(): number {
    return this.openedAt;
  }

  /** 测试用：手工快进 resetMs 窗口（不生产用）。 */
  _forceElapsedForTests(ms: number): void {
    this.openedAt = Date.now() - ms;
  }
}
