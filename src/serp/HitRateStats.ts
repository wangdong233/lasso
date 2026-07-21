/**
 * HitRateStats —— SERP selector 命中率统计（parse2 §3.5.3 / F3.8.10）。
 *
 * v0.2 范围：内存态计数器，doctor 可查；不主动接入主路径（告警链路 v0.7）。
 *  - key = `${engine}:${selectorVersion}`（与 SelectorRegistry 同源）
 *  - recordHit / recordMiss：累加 hit/miss
 *  - snapshot：返回所有 key 的 { hit, miss, rate }（doctor 显示用）
 *
 * 设计：
 *  - 纯内存态（进程重启清零）—— v0.2 简化，避免引入持久化复杂度
 *  - 与 SelectorRegistry 互补：SelectorRegistry 是版本化元数据（含静态 selector 表），
 *    HitRateStats 是运行时观测数据（runtime counters）
 *  - rate = hit / (hit + miss)；无数据时 rate=1（乐观默认，避免冷启动告警）
 *
 * 借鉴：parse2 §3.5.3；08 §3.8 F3.8.10（命中率统计）。
 */
import { logger } from "../util/logger.js";

export interface HitRateEntry {
  hit: number;
  miss: number;
  /** hit / (hit + miss)；hit+miss=0 时返 1（乐观默认）。 */
  rate: number;
}

export class HitRateStats {
  private hit = new Map<string, number>();
  private miss = new Map<string, number>();

  /** 记一次命中。 */
  recordHit(key: string): void {
    this.hit.set(key, (this.hit.get(key) ?? 0) + 1);
  }

  /** 记一次失败（miss）。 */
  recordMiss(key: string): void {
    this.miss.set(key, (this.miss.get(key) ?? 0) + 1);
  }

  /**
   * 取所有 key 的命中率快照（doctor 显示用）。
   * 返回对象 key 是 `${engine}:${selectorVersion}` 字符串。
   */
  snapshot(): Record<string, HitRateEntry> {
    const out: Record<string, HitRateEntry> = {};
    const keys = new Set<string>([...this.hit.keys(), ...this.miss.keys()]);
    for (const k of keys) {
      const hit = this.hit.get(k) ?? 0;
      const miss = this.miss.get(k) ?? 0;
      const total = hit + miss;
      out[k] = { hit, miss, rate: total === 0 ? 1 : hit / total };
    }
    return out;
  }

  /**
   * 命中率告警扫描（v0.2 仅 logger.warn；v0.7 接入主路径告警链路）。
   * 默认阈值 0.5：低于 50% 视为异常。
   */
  scanForAlerts(threshold = 0.5): Array<{ key: string } & HitRateEntry> {
    const snap = this.snapshot();
    const alerts: Array<{ key: string } & HitRateEntry> = [];
    for (const [k, v] of Object.entries(snap)) {
      if (v.hit + v.miss >= 5 && v.rate < threshold) {
        alerts.push({ key: k, ...v });
        logger.warn({
          evt: "hitrate_below_threshold",
          key: k,
          ...v,
          threshold,
        });
      }
    }
    return alerts;
  }

  /** 重置（测试用）。 */
  reset(): void {
    this.hit.clear();
    this.miss.clear();
  }
}
