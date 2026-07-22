/**
 * 60min 长熔断器（parse8 §3.1 / F3.4.5 / F3.4.10）
 *
 * 与短熔断 CircuitBreaker（v0.1，60s 连续失败窗口）并列，覆盖**持续故障 / 月配额耗尽**类：
 *  - 触发条件：滑动窗 windowMs 内失败数 ≥ threshold（不是"连续失败"）
 *  - open 持续：resetMs=60min（vs 短 60s）
 *  - 副作用：open 时经 onOpen 回调联动 CapabilityBag.disable（短熔断不联动）
 *
 * 关键设计（parse8 §3.1 R-INT-01/R-CI-02）：
 *  - **与 CircuitBreaker 并列在 src/fallback/ 目录**（INV-41 不开第二套熔断引擎模块）
 *  - **复用 BreakerState 类型**（不重定义；从 CircuitBreaker.ts import）
 *  - **CircuitBreaker 一行不改**（v0.6 短熔断零回归）
 *  - **不绕过 CapabilityBag**（INV-42）：open 时只调 onOpen 回调，由装配层（index.ts）
 *    调 bag.disable，走 v0.6 既有的 onChange → ToolManager.disableChannel + shutdownOne 链
 *
 * 与 CircuitBreaker 的状态机同形（closed/open/half-open）但触发语义独立 —— 二者在
 * FallbackDecider 双 breaker 串联检查（短先长后），互不污染状态（parse8 §3.1 末尾）。
 *
 * 长熔断只触发 disable，不自动 enable（保守设计）：
 *  - 60min 后 half-open probe 成功 → recordSuccess → state=closed
 *  - 但 bag 仍 disabled —— admin 手工 capability_enable 显式恢复
 *  - 理由：长熔断代表"月配额耗尽类"，自动恢复风险大（用户可能已超额），由 admin 显式安全。
 */
import type { BreakerState } from "./CircuitBreaker.js";

export class LongCircuitBreaker {
  state: BreakerState = "closed";
  /**
   * 滑动窗内的失败时间戳（push-only on failure；reset/recordSuccess 清零）。
   * 窗口外（now - t >= windowMs）的时间戳在 recordFailure 时被同步剔除。
   */
  private failureTimestamps: number[] = [];
  private openedAt = 0;

  constructor(
    /**
     * 滑动窗 windowMs 内失败数 ≥ threshold → 转 open。
     * 默认 10：1h 内 10 次失败视为持续故障。
     */
    private readonly threshold = 10,
    /** 滑动窗长度（默认 1h）。 */
    private readonly windowMs = 3_600_000,
    /** open 持续时长，到期转 half-open 放 probe（默认 60min）。 */
    private readonly resetMs = 3_600_000,
    /**
     * open 时回调（装配层注入 bag.disable 联动；守 INV-42 不绕过 CapabilityBag）。
     * 异步 —— recordFailure 是 async；onOpen 抛错不污染 breaker 内部状态（保守吞错）。
     */
    private readonly onOpen?: (name: string) => Promise<void>,
    /** channel / provider 名（onOpen 回调透传 + 日志用）。 */
    private readonly name = "unknown",
  ) {}

  /**
   * 是否放行本次请求（同 CircuitBreaker.allow 三态语义）。
   *  - closed    → true
   *  - open      → 看 resetMs 是否到；到则 half-open + 放 probe；否则拒
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
    return true; // half-open
  }

  /**
   * 成功：清零失败时间戳 + 回 closed（half-open probe 成功也走这里）。
   *
   * 注意：bag 仍 disabled（不自动 enable；保守设计，见文件头注释）。
   */
  recordSuccess(): void {
    this.failureTimestamps = [];
    this.state = "closed";
  }

  /**
   * 失败：累计时间戳 + 可能转 open。
   *  - half-open → 立即 open（重置 openedAt）+ onOpen
   *  - closed    → 滑动窗内 ≥ threshold → open + onOpen
   *  - open      → 幂等（不重复 onOpen；保留 openedAt）
   *
   * onOpen 抛错被 catch 不 rethrow（保守：breaker 状态成功，bag.disable 失败仅 log warn）。
   */
  async recordFailure(): Promise<void> {
    const now = Date.now();
    this.failureTimestamps.push(now);
    // 滑动窗：剔除 windowMs 之前的时间戳
    this.failureTimestamps = this.failureTimestamps.filter(
      (t) => now - t < this.windowMs,
    );

    if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = now;
      await this._safeOnOpen();
      return;
    }
    if (this.state === "open") {
      // 已 open（可能由短熔断先 open）；幂等不重发 onOpen（避免重复 disable）
      return;
    }
    // closed
    if (this.failureTimestamps.length >= this.threshold) {
      this.state = "open";
      this.openedAt = now;
      await this._safeOnOpen();
    }
  }

  /**
   * F3.4.10 熔断 reset —— admin action 手工唤醒（不动短熔断）。
   *
   * 设计：admin 显式 reset 后状态回 closed；但 bag 仍 disabled（reset 只清 breaker 状态，
   * 不自动 enable channel —— 仍需 admin capability_enable 显式恢复）。
   */
  reset(): void {
    this.state = "closed";
    this.failureTimestamps = [];
    this.openedAt = 0;
  }

  /** 滑动窗内当前失败数（监控 / doctor / admin breaker_status 用）。 */
  get windowFailureCount(): number {
    return this.failureTimestamps.length;
  }

  /** 上次 open 的时间戳（ms since epoch）；未 open 过为 0（监控 / doctor 用）。 */
  get openedAtReadOnly(): number {
    return this.openedAt;
  }

  /**
   * 测试用：手工快进 resetMs 窗口（不生产用）。
   *
   * 设计：parse8 §3.1 注释「同步老化 failureTimestamps」需实现为：
   *  - 直接把现有时间戳全部 backdate（减去 ms）→ 让下次 recordFailure 的 filter 真实剔除
   *  - 同时设 openedAt = Date.now() - ms（同 CircuitBreaker 范式）
   *
   * backdate 后立即触发一次 filter（不增计数），保证 windowFailureCount 反映"快进后剩余"。
   */
  _forceElapsedForTests(ms: number): void {
    this.openedAt = Date.now() - ms;
    // backdate 所有时间戳（让 filter 真实剔除超窗的）
    this.failureTimestamps = this.failureTimestamps.map((t) => t - ms);
    const now = Date.now();
    this.failureTimestamps = this.failureTimestamps.filter(
      (t) => now - t < this.windowMs,
    );
  }

  /**
   * onOpen 回调包装：抛错时仅 log warn 不 rethrow。
   *
   * 设计（parse8 §3.1 关键决策）：
   *  - breaker 转 open 是不可逆状态变更（已生效）；onOpen（bag.disable）失败仅是
   *    "副作用未完成"，不应让 breaker 回滚
   *  - 装配层 bag.disable 自身有 logger.error 兜底；这里二次 catch 是 defense-in-depth
   */
  private async _safeOnOpen(): Promise<void> {
    if (!this.onOpen) return;
    try {
      await this.onOpen(this.name);
    } catch {
      // 保守吞错：breaker 状态已 open（不可逆）；bag.disable 失败由装配层 log
    }
  }
}
