/**
 * SerpHealthMonitor —— SERP 改版检测协调器（parse8 §3.4 / F3.8.9-12 实装）
 *
 * 粘合 v0.2 四件骨架（**一行不改**，parse8 §3.4 守 INV-45）：
 *  - SelectorRegistry：版本化 selector 集（recordHit/recordMiss）
 *  - HitRateStats：运行时命中率（recordHit/recordMiss + scanForAlerts）
 *  - ChangeDetection：dom hash 对比（detectChange）
 *  - RecordingStore：fixture 落盘（save；v1.0 回归用）
 *
 * 触发链路（被动，由 extract.ts 在抽完结果后调 onResult）：
 *   1. extract 抽完一次 → registry.recordHit/recordMiss + hitRate.recordHit/recordMiss
 *   2. 命中率 < threshold（默认 0.5）且样本 ≥ 5 → 异步 ChangeDetection.detectChange 验证
 *   3. dom hash 变 → 确认改版：
 *      a) logger.warn（admin / doctor 可见）
 *      b) RecordingStore.save 落盘 fixture（v1.0 回归用）
 *      c) extract.ts 通过 onResult 返回值标记 retrieval_method（外层装配）
 *
 * **不做**（INV-45）：自动重写 selector 表（保守人工升级；selector 是低频高破坏事件）
 * **不做**：实时告警推送（仅进程内 + logger）
 * **不阻塞主路径**：onResult 内 detectChange 异步触发不 await extract 主流程
 */
import type { SerpEngine } from "./selectors.js";
import type { SelectorRegistry } from "./SelectorRegistry.js";
import type { HitRateStats } from "./HitRateStats.js";
import type { ChangeDetection } from "./ChangeDetection.js";
import type { RecordingStore } from "./RecordingStore.js";
import { logger } from "../util/logger.js";

// ============================================================
// 类型
// ============================================================
export interface SerpHealthSnapshot {
  engines: Array<{
    engine: string;
    /** 命中率（hit / (hit + miss)）；无数据时 1（乐观默认） */
    hit_rate: number;
    hit: number;
    miss: number;
    /** 最近一次已知良好的 ISO 日期（SelectorRegistry last_known_good） */
    last_known_good: string;
    /** rate < threshold 且 (hit + miss) ≥ 5 时为 true */
    redesign_suspected: boolean;
  }>;
  /** 最近一次告警（命中率 < threshold 触发） */
  recent_alerts: Array<{ key: string; hit: number; miss: number; rate: number; at: number }>;
  /** RecordingStore 录制数量（doctor 显示用；同步列略重，0 占位由外层按需调） */
  recordings_count: number;
}

// ============================================================
// SerpHealthMonitor
// ============================================================
export class SerpHealthMonitor {
  constructor(
    private readonly registry: SelectorRegistry,
    private readonly hitRate: HitRateStats,
    private readonly change: ChangeDetection,
    private readonly recordings: RecordingStore,
    /** 命中率阈值（默认 0.5；< 50% 触发 ChangeDetection 验证） */
    private readonly threshold = 0.5,
  ) {}

  /**
   * extract.ts 在抽完结果后调（**不抛错**；失败保守 no-op）。
   *
   * @param engine           "baidu" | "google"
   * @param selectorVersion  "v1"（当前静态版本；未来 ChangeDetection 升级时换 v2）
   * @param query            用户查询词（ChangeDetection baseline 文件名组分）
   * @param dom              抽取时拿到的 a11y 树文本 / HTML（dom hash 源）
   * @param hit              true=抽到 ≥1 条结果；false=0 结果
   * @returns                "serp_layout_changed" 改版确认（外层 extract 标 retrieval_method 用）；
   *                          无改版或样本不足时返回 null
   */
  onResult(
    engine: SerpEngine,
    selectorVersion: string,
    query: string,
    dom: string,
    hit: boolean,
  ): "serp_layout_changed" | null {
    const key = `${engine}:${selectorVersion}`;
    if (hit) {
      this.registry.recordHit(engine, selectorVersion);
      this.hitRate.recordHit(key);
    } else {
      this.registry.recordMiss(engine, selectorVersion);
      this.hitRate.recordMiss(key);
    }
    // 异步验证（不阻 extract 主路径；保守吞错）
    let redesignConfirmed: "serp_layout_changed" | null = null;
    void this._maybeDetectRedesign(engine, query, dom)
      .then((changed) => {
        if (changed) redesignConfirmed = "serp_layout_changed";
      })
      .catch(() => {
        /* 保守吞错：改版检测失败不影响主路径 */
      });
    return redesignConfirmed;
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
        redesign_suspected:
          rate.rate < this.threshold && rate.hit + rate.miss >= 5,
      };
    });
    return {
      engines,
      recent_alerts: alerts.map((a) => ({
        key: a.key,
        hit: a.hit,
        miss: a.miss,
        rate: a.rate,
        at: Date.now(),
      })),
      recordings_count: 0,
    };
  }

  /**
   * 异步触发改版检测（命中率 < threshold 且样本 ≥ 5）。
   *
   * 触发条件层级（保守）：
   *   1. 样本 ≥ 5（HitRateStats 既有阈值；防冷启动误报）
   *   2. rate < threshold（默认 0.5）
   *   3. ChangeDetection.detectChange hash 对比 confirmed
   *
   * 任一不满足 → 不告警；都满足 → logger.warn + RecordingStore.save。
   *
   * INV-45：本方法**禁**写 selector 表（无 registry.set / upgradeVersion 调用）。
   */
  private async _maybeDetectRedesign(
    engine: SerpEngine,
    query: string,
    dom: string,
  ): Promise<boolean> {
    const snap = this.registry.hitRate(engine);
    if (snap.hit + snap.miss < 5) return false; // 样本不足
    if (snap.rate >= this.threshold) return false; // 命中率仍 OK
    const result = await this.change.detectChange(engine, query, dom);
    if (!result.changed) return false;
    logger.warn({
      evt: "serp_redesign_confirmed",
      engine,
      query_len: query.length,
      baseline_hash: result.baseline_hash?.slice(0, 8),
      current_hash: result.current_hash.slice(0, 8),
      hit_rate: snap.rate,
    });
    // 落盘 fixture（v1.0 回归用；保守 no-op on error）
    await this.recordings.save(engine, query, dom).catch(() => {
      /* 保守吞错：录制失败不影响告警链路 */
    });
    return true;
  }
}
