/**
 * QuotaLedger —— 单 provider 多 Key 配额账本（parse2 §3.2.1 + parse3 §3.6 v0.3 RPM 字段）。
 *
 * 选 Key 策略（F3.1.7 limit 跨源分配前置）：
 *  - pickKey() 返回余量最多且未 exhausted 的 Key（贪心）
 *  - 余量 <50（验收 #2）时 logger.warn，外层可降级
 *  - 全部 exhausted → 返回 null → channel.isAvailable()=false → fallback
 *
 * 配额模型适配（10 §2.8）：
 *  - monthly   → resetAt 月初，余量 = quota_per_month - used
 *  - rpm       → resetAt = now + 60s（v0.2 不实装精确窗口，留 schema）；
 *               **v0.3 升级**：rpm_max + rpm_window_ms 字段暴露给 MultiSourceFanout 用，
 *               配合 RpmLimiter 主动按滑动窗限频（parse3 §3.6 F3.1.12）。
 *  - token     → v0.2 退化成 monthly（按请求计数，近似）；v0.3 升级 token 精确计
 *  - request   → 同 monthly（按请求计）
 *
 * 多 Key 配额合并（10 §4.2 / 验收 #2）：2 Key × 2000/月 = 4000/月
 *  - channel 内部按 Key 轮转（pickKey 贪心）
 *  - doctor 报告合并视图：search.brave 总余量 = totalRemaining() = Σ(key.remaining)
 *
 * 持久化：v0.2 内存态（进程重启清零，免费层配额足够）；v0.6+ 可选落盘 ~/.cache/lasso/quota/。
 *
 * 借鉴：10 §2.8 provider schema 扩展；04 §4.2 Brave 多 Key 扩容路径；parse3 §3.6 RPM 字段。
 */
import { logger } from "../util/logger.js";

interface KeyState {
  key: string;
  remaining: number; // 本月剩余
  resetAt: number; // 下次重置 epoch ms（月初 UTC）
  exhaustedAt?: number; // 429 时点 timestamp
  totalUsed: number; // 累计成功调用数
}

export class QuotaLedger {
  private states: KeyState[] = [];
  private currentMonthStart: number;

  constructor(
    public readonly providerName: string,
    keys: readonly string[],
    private readonly quotaPerMonth: number,
    private readonly model: "monthly" | "rpm" | "token" | "request" = "monthly",
    /**
     * v0.3 Phase D（parse3 §3.6，F3.1.12）：60s 滑动窗内最大调用数。
     *  - undefined / 未传 → 不限频（v0.2 行为，兼容）
     *  - 0                → 禁用该 provider（不允许任何调用）
     *  - 正整数            → MultiSourceFanout 走 RpmLimiter 主动降级
     *
     * 与 monthly 配额正交：rpm_max 看「瞬时频率」，quotaPerMonth 看「月总额度」。
     *
     * 注：字段名加下划线前缀避免与 public getter（rpmMax / rpmWindowMs）重名。
     */
    private readonly _rpmMax?: number,
    /**
     * 滑动窗大小（默认 60000ms = 1 分钟，与「RPM」语义对齐）。
     * 仅当 rpmMax 设了才有意义。
     */
    private readonly _rpmWindowMs: number = 60_000,
  ) {
    this.currentMonthStart = startOfMonthUTC(Date.now());
    for (const k of keys) {
      this.states.push({
        key: k,
        remaining: quotaPerMonth,
        resetAt: this.currentMonthStart,
        totalUsed: 0,
      });
    }
  }

  /** 是否还有可用 Key（未 exhausted 且 remaining > 0） */
  hasAvailableKey(): boolean {
    this._refreshState();
    return this.states.some((s) => s.remaining > 0 && !this._isExhausted(s));
  }

  /**
   * 选余量最多且未 exhausted 的 Key（贪心）。
   * 全部 exhausted → 返回 null，外层 channel.isAvailable() 返 false 触发 fallback。
   */
  pickKey(): string | null {
    this._refreshState();
    const avail = this.states
      .filter((s) => s.remaining > 0 && !this._isExhausted(s))
      .sort((a, b) => b.remaining - a.remaining);
    return avail[0]?.key ?? null;
  }

  /**
   * 记一次成功调用，扣减余量。
   * 余量 <50 时 logger.warn（验收 #2 硬指标）。
   */
  recordSuccess(key: string, cost: number): void {
    const s = this.states.find((x) => x.key === key);
    if (!s) return;
    s.remaining = Math.max(0, s.remaining - cost);
    s.totalUsed += cost;
    if (s.remaining < 50) {
      logger.warn({
        evt: "quota_low",
        provider: this.providerName,
        remaining: s.remaining,
        key_hash: hashKey(s.key),
      });
    }
  }

  /**
   * 标记某 Key 在 429 / quota exceeded 时进入 exhausted 态。
   * resetAt 取「现有 resetAt」与「传入 resetAt」的较大值，避免短重置回滚长熔断。
   *
   * v0.2 Phase B 设计偏离 parse2 §3.2.1 伪码：**不**把 remaining 置 0。
   * 理由：parse2 §4.2「短期禁用到 retryAfter；其他 key 仍可用」语义明确 429 是
   * transient 限流，与 monthly quota 余量是**两套独立状态**。若 markExhausted 把
   * remaining=0，过了 resetAt 后该 Key 仍因 remaining=0 不可用，违反 §4.2 恢复语义。
   * 短期阻塞只由 exhaustedAt + resetAt 表达；月配额耗尽由 remaining 自然到 0 表达。
   * snapshot/docter 显示仍能区分（exhausted: exhaustedAt&&now<resetAt；月耗尽：remaining==0&&!exhaustedAt）。
   */
  markExhausted(key: string, resetAt: number): void {
    const s = this.states.find((x) => x.key === key);
    if (!s) return;
    s.exhaustedAt = Date.now();
    s.resetAt = Math.max(s.resetAt, resetAt);
    logger.warn({
      evt: "quota_exhausted",
      provider: this.providerName,
      key_hash: hashKey(s.key),
      reset_at: s.resetAt,
    });
  }

  /** 合并视图（doctor 用）：所有 Key 的剩余总和。 */
  totalRemaining(): number {
    this._refreshState();
    return this.states.reduce((sum, s) => sum + Math.max(0, s.remaining), 0);
  }

  /** 配额模型（doctor 显示用）。 */
  get quotaModel(): string {
    return this.model;
  }

  /**
   * v0.3 Phase D（parse3 §3.6）：RPM 滑动窗最大调用数。
   *  - undefined → 不限频（v0.2 行为）
   *  - 正整数    → MultiSourceFanout 据此调 RpmLimiter.allow(name, rpmMax)
   */
  get rpmMax(): number | undefined {
    return this._rpmMax;
  }

  /**
   * v0.3 Phase D：RPM 滑动窗大小（ms，默认 60000）。
   * MultiSourceFanout 可据此构造 RpmLimiter(windowMs = rpmWindowMs)。
   */
  get rpmWindowMs(): number {
    return this._rpmWindowMs;
  }

  /** 暴露 Key 数量（doctor + 测试用）。 */
  get keyCount(): number {
    return this.states.length;
  }

  /** 未导出内部状态快照（doctor + 测试用，不暴露真实 key 字符串）。 */
  snapshot(): Array<{ remaining: number; resetAt: number; totalUsed: number; exhausted: boolean }> {
    this._refreshState();
    return this.states.map((s) => ({
      remaining: s.remaining,
      resetAt: s.resetAt,
      totalUsed: s.totalUsed,
      exhausted: this._isExhausted(s),
    }));
  }

  private _isExhausted(s: KeyState): boolean {
    if (!s.exhaustedAt) return false;
    // resetAt 之后视为已恢复
    return Date.now() < s.resetAt;
  }

  /**
   * 综合状态刷新：①月初 rollover（月配额重置）；②短期 429 熔断过期恢复（parse2 §4.2）。
   *
   * v0.2 Phase B：短期 429 熔断（markExhausted）在 resetAt 过期后清空 exhaustedAt。
   * remaining 不动（保持月配额扣减独立），符合 parse2 §4.2 "短期禁用到 retryAfter" 语义。
   */
  private _refreshState(): void {
    this._maybeRollover();
    const now = Date.now();
    for (const s of this.states) {
      if (s.exhaustedAt && now >= s.resetAt) {
        s.exhaustedAt = undefined;
      }
    }
  }

  private _maybeRollover(): void {
    const m = startOfMonthUTC(Date.now());
    if (m > this.currentMonthStart) {
      this.currentMonthStart = m;
      for (const s of this.states) {
        s.remaining = this.quotaPerMonth;
        s.exhaustedAt = undefined;
      }
      logger.info({
        evt: "quota_monthly_rollover",
        provider: this.providerName,
      });
    }
  }
}

/** 月初 UTC epoch ms（用 UTC 避免时区漂移）。 */
function startOfMonthUTC(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** 日志安全：只打前 4 + 后 4，不打全 key（parse2 §4.2）。 */
export function hashKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "short";
}
