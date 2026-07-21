/**
 * Lasso v0.3 provider RPM 滑动窗口限频（parse3 §3.6，F3.1.12）
 *
 * 不是被动等 429，而是主动按 provider 维度降级：调用前看 60s 窗口内已成功调用数，
 * 超过 rpm_max 直接返回 false（不试）。让 Lasso 在「接近限频」时主动跳过该 provider，
 * 由 MultiSourceFanout 把它计入 partial_failures（reason=rpm_limited:*）。
 *
 * 滑动窗算法：
 *  - Map<provider, number[]>（时间戳数组，按插入序）
 *  - allow(provider, max) : 先清理过期（now - t >= windowMs）再判 length >= max
 *  - record(provider)     : 清理过期后 push(now)
 *  - currentUsage(provider): 清理过期后返 length（调试 / partial_failures reason 用）
 *
 * 与 QuotaLedger 的关系（parse3 §3.6）：
 *  - QuotaLedger 是**月配额**维度（按累计扣减），跨月重置；markExhausted 是 429 后的
 *    短期禁用（resetAt 来自 Retry-After header 或默认 60s）。
 *  - RpmLimiter 是**滑动窗**维度（主动预防），即使没收到 429 也按 rpm_max 节流。
 *  - 两者正交：QuotaLedger 看「总额度」；RpmLimiter 看「瞬时频率」。
 *
 * 与 BudgetTracker 的关系（parse3 §3.7）：正交。
 *  - RPM 是 per-provider **调用次数** 维度
 *  - BudgetTracker 是 per-chain **时间** 维度
 *
 * 简单性铁律（01 思想）：本类仅算滑动窗，不主动降级——降级决策归 MultiSourceFanout。
 *
 * 默认 windowMs=60_000（与「RPM = requests per minute」语义对齐），defaultMax=Infinity
 * （未显式传 max 即不限频，保持 v0.2 行为）。
 */

// ============================================================
// 默认值
// ============================================================
export const DEFAULT_RPM_WINDOW_MS = 60_000;

// ============================================================
// RpmLimiter
// ============================================================
/**
 * 单例（per-process）；多个 fanout 共享同一 limiter 才有正确计数。
 *
 * 用法（MultiSourceFanout.fanOutSearch 内）：
 *   const limiter = new RpmLimiter();
 *   for (const s of sources) {
 *     if (!limiter.allow(s.name, maxBySource[s.name])) {
 *       // 跳过此源 → 记 partial_failure reason=rpm_limited:N/M
 *       continue;
 *     }
 *     // 跑该源
 *     const r = await executor(s.name, s.capacity);
 *     if (r.outcome === "worked") limiter.record(s.name);
 *   }
 *
 * 测试友好：构造时 now() 可注入（避免依赖真实时钟）。
 */
export class RpmLimiter {
  /** provider → 时间戳数组（按时间升序；可能含未过期+过期混合，访问时懒清理） */
  private windows = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number = DEFAULT_RPM_WINDOW_MS,
    private readonly defaultMax: number = Number.POSITIVE_INFINITY,
    /** 时间戳源（默认 Date.now）—— 测试时注入固定值 */
    private readonly now: () => number = Date.now,
  ) {}

  // ============================================================
  // allow：调用前检查
  // ============================================================
  /**
   * 检查 provider 是否还能调用一次。
   *  - max 显式传入时优先用 max；否则用 defaultMax
   *  - defaultMax=Infinity 时永远 allow=true（v0.2 行为，parse3 §3.6）
   *  - allow=true 时**不**自动 record（成功调用后必须显式 record 才计数）
   *  - allow=false 时也应让 MultiSourceFanout 记 partial_failure 并跳过
   *
   * 副作用：清理 provider 窗口内过期时间戳（懒清理，避免单独 GC pass）。
   */
  allow(provider: string, max?: number): boolean {
    const cap = max ?? this.defaultMax;
    if (cap === Number.POSITIVE_INFINITY) return true;
    if (cap <= 0) return false; // 防御：cap=0 即禁用
    const arr = this._prune(provider);
    return arr.length < cap;
  }

  // ============================================================
  // record：成功调用后记账
  // ============================================================
  /**
   * 记一次成功调用（push 当前时间戳）。
   *  - 调用前未 allow 就 record：仍然 push（防御；但调用方应先 allow）
   *  - 多次 record 同一 provider：累积计数
   *
   * 注意：仅在调用**真正成功**后 record，避免 429/timeout 占用配额窗口。
   */
  record(provider: string): void {
    const arr = this._prune(provider);
    arr.push(this.now());
    this.windows.set(provider, arr);
  }

  // ============================================================
  // currentUsage：调试 / partial_failures reason 用
  // ============================================================
  /**
   * 当前窗口内已用配额（已清理过期）。
   * 用于 MultiSourceFanout 在 allow=false 时构造 reason 字符串
   * "rpm_limited:<currentUsage>/<cap>"。
   */
  currentUsage(provider: string): number {
    return this._prune(provider).length;
  }

  // ============================================================
  // reset：测试用（生产不应调）
  // ============================================================
  /** 清空所有 provider 的窗口（测试间隔离用）。 */
  reset(): void {
    this.windows.clear();
  }

  // ============================================================
  // 内部：懒清理过期 + 返回活跃窗口
  // ============================================================
  /**
   * 返回 provider 的活跃窗口（已剔除过期时间戳），并写回 map（避免下次重复扫）。
   *
   * 过期判定：now - t >= windowMs（>= 而非 >，边界一致：60s 窗口里 60s 前的算过期）。
   */
  private _prune(provider: string): number[] {
    const now = this.now();
    const arr = (this.windows.get(provider) ?? []).filter(
      (t) => now - t < this.windowMs,
    );
    this.windows.set(provider, arr);
    return arr;
  }
}
