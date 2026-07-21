/**
 * CallerTierTracker —— per-caller 滑动窗配额（parse7 §3.3 / F3.1.9）
 *
 * 设计：每个 caller（MCP request _meta.callerId；CC 不传则 fallback "anonymous"）
 * 在 60s 滑动窗内最多发起 defaultCap 次调用。超额时 tryAcquire 返 false。
 *
 * 铁律（INV-38 task v0.6）：
 *  - defaultCap 必须是模块顶级 const（DEFAULT_CALLER_CAP）；
 *    env LASSO_CALLER_CAP_DEFAULT 可覆盖（构造期一次性读，运行时不读）；
 *    禁硬编码魔法数（100）散落在调用点。
 *  - 滑动窗逻辑必须复用 QuotaLedger._refreshState 同范式（windowStart + used 衰减）；
 *    禁 token bucket / GCRA / leaky bucket（R-CI-02：不开第二套 rate limiter）。
 *
 * 铁律（INV-35 task v0.6）：
 *  - 本类不 import BrowseChannel/DesktopChannel internal；只持 callerId 字符串 + 内部 budget Map。
 *
 * 与 QuotaLedger / RpmLimiter 的边界（R-RT-9 parse7 §7.1）：
 *  - QuotaLedger      : per-key 月配额（429 限流恢复，月度重置）
 *  - RpmLimiter       : per-provider 滑动窗（同一 provider 跨 caller 的瞬时频率）
 *  - CallerTierTracker: per-caller 滑动窗（同一 caller 跨 provider 的总量）
 *  → 三者作用域正交，不冲突，R-CI-02 守住
 *
 * 持久化：进程内（v0.6 不持久化；v0.8+ cookie export 同期评估）
 *
 * 接入点（不在本类实装，守 INV-35）：
 *  - search.ts / browse.ts handler 入口处调 tryAcquire（parse7 §3.3 末尾示例）
 *  - 超额 → outcome="didnt" + retrieval_method="caller_cap_exceeded" 透明返回 CC
 */
import { logger } from "../util/logger.js";
import type { CallerBudget, CallerSnapshot } from "./runtime-types.js";

// ============================================================
// 模块顶级 const（INV-38 task v0.6 红线）
// ============================================================
/**
 * 默认 per-caller 60s 上限。
 *
 * INV-38：必须是模块顶级 const；env LASSO_CALLER_CAP_DEFAULT 可在构造期覆盖；
 *         调用点禁硬编码魔法数（100）。
 *
 * 选 100 的依据（parse7 §3.3）：
 *  - CC 默认不传 callerId → 全部归 "anonymous" 共享此配额
 *  - 100/min 对人驱动 LLM workflow 足够（典型 ≤10 calls/min）
 *  - 可经 env 调（实测后校准，parse7 §6.2 性能验收 + R-RT-5 风险缓解）
 */
export const DEFAULT_CALLER_CAP = 100;

/**
 * 滑动窗大小（默认 60s，与「per-minute」语义对齐）。
 * 模块顶级 const，无 env 覆盖（窗口大小是协议契约，不应被运维改）。
 */
export const DEFAULT_WINDOW_MS = 60_000;

/**
 * 从 process.env.LASSO_CALLER_CAP_DEFAULT 读覆盖值（构造期一次性读）。
 *
 * INV-38 衍生：runtime 不读 env（防 LLM 通过 channel 改 env 绕过）；
 *              仅本函数（构造期）+ index.ts 装配期调一次。
 *
 * 解析失败（非数字 / ≤0）→ fallback DEFAULT_CALLER_CAP，并 warn。
 */
export function readCallerCapFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.LASSO_CALLER_CAP_DEFAULT;
  if (!raw) return DEFAULT_CALLER_CAP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn({
      evt: "caller_cap_env_invalid",
      raw,
      fallback: DEFAULT_CALLER_CAP,
    });
    return DEFAULT_CALLER_CAP;
  }
  return n;
}

export class CallerTierTracker {
  private budgets = new Map<string, CallerBudget>();

  /**
   * @param defaultCap 模块顶级 const 默认值（INV-38）；env 覆盖由调用方在构造期传入
   * @param windowMs  滑动窗大小（默认 60s）
   */
  constructor(
    private readonly defaultCap: number = DEFAULT_CALLER_CAP,
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
  ) {}

  /**
   * 尝试为 caller 计一次调用。
   *
   * @returns true=放行；false=超额（调用方据 retrieval_method="caller_cap_exceeded" 透明返回）
   *
   * INV-38：滑动窗逻辑必须复用 QuotaLedger._refreshState 同范式
   *         （windowStart + used 衰减；windowMs 过期 → 重置 used + windowStart）。
   *
   * 与 QuotaLedger.pickKey 的差异（parse7 §3.3）：
   *  - pickKey 是贪心选 key；这里是单 caller 累计
   *  - pickKey 是事后扣（recordSuccess）；这里是事前 gate（tryAcquire）
   */
  tryAcquire(callerId: string, cost: number = 1): boolean {
    this._refreshWindow(callerId);
    const b = this._getOrCreate(callerId);
    if (b.used + cost > b.cap) {
      b.lastExceeded = Date.now();
      logger.warn({
        evt: "caller_cap_exceeded",
        caller: callerId,
        used: b.used,
        cap: b.cap,
        cost,
      });
      return false;
    }
    b.used += cost;
    return true;
  }

  /**
   * per-caller override（admin caller_cap_set 用）。
   *
   * cap=0 等价禁用该 caller（parse7 §3.3）。负数被 clamp 到 0。
   */
  setCap(callerId: string, cap: number): void {
    const b = this._getOrCreate(callerId);
    const safe = Math.max(0, Math.floor(cap));
    b.cap = safe;
    logger.info({
      evt: "caller_cap_set",
      caller: callerId,
      cap: safe,
      by: "admin",
    });
  }

  /**
   * 取某 caller 当前 used（doctor + 测试用，不影响计数）。
   * 窗口已过期则返 0（先 refresh 再读）。
   */
  currentUsage(callerId: string): number {
    this._refreshWindow(callerId);
    return this.budgets.get(callerId)?.used ?? 0;
  }

  /** 取某 caller 当前 cap（未注册返 defaultCap）。 */
  currentCap(callerId: string): number {
    return this.budgets.get(callerId)?.cap ?? this.defaultCap;
  }

  /**
   * admin caller_cap_list / doctor 用：列出所有 caller 当前状态（脱敏 snapshot）。
   *
   * 窗口已过期的 caller used 显示为 0（避免误导 doctor）。
   */
  snapshot(): CallerSnapshot[] {
    const now = Date.now();
    return Array.from(this.budgets.values()).map((b) => ({
      callerId: b.callerId,
      used: now - b.windowStart > this.windowMs ? 0 : b.used,
      cap: b.cap,
      windowMs: this.windowMs,
    }));
  }

  /** 测试用：重置内部状态（v0.6 不暴露给 admin；便于单测 reset）。 */
  reset(): void {
    this.budgets.clear();
  }

  // ============================================================
  // 私有
  // ============================================================
  /**
   * 获取或创建 caller 的 budget（首次访问时初始化）。
   */
  private _getOrCreate(callerId: string): CallerBudget {
    let b = this.budgets.get(callerId);
    if (!b) {
      b = {
        callerId,
        windowStart: Date.now(),
        used: 0,
        cap: this.defaultCap,
      };
      this.budgets.set(callerId, b);
    }
    return b;
  }

  /**
   * 滑动窗刷新：窗口过期则重置 windowStart + used。
   *
   * INV-38：与 QuotaLedger._refreshState 同范式（窗口衰减 + reset）；
   *         禁另起 token bucket / GCRA / leaky bucket。
   *
   * 与 QuotaLedger._refreshState 的差异：
   *  - QuotaLedger 看月度 rollover + exhaustedAt 过期（双轨）
   *  - 本类只看单窗口过期（无 rollover 概念，每窗口独立）
   */
  private _refreshWindow(callerId: string): void {
    const b = this.budgets.get(callerId);
    if (!b) return;
    const now = Date.now();
    if (now - b.windowStart > this.windowMs) {
      b.windowStart = now;
      b.used = 0;
    }
  }
}
