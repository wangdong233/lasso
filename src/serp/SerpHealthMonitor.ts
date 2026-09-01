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
 *
 * ACC-1②（2026-09-02 性能/准确率轮）：hit 路径自动首录 baseline——生产环境此前
 * 零 captureBaseline 调用点，detectChange 恒「无 baseline 不告警」，改版检测链
 * 整体死路。命中路径（DOM 可信）且该 engine|query 无 baseline 时落一份（幂等）。
 *
 * **不做**（INV-45）：自动重写 selector 表（保守人工升级；selector 是低频高破坏事件）
 * **不做**：实时告警推送（仅进程内 + logger）
 * **不阻塞主路径**：onResult 内 detectChange/baseline 首录均异步触发不 await extract 主流程
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
  /**
   * ACC-1②（2026-09-02）：per-engine baseline 盘点（count + 最新一条 age_ms）——
   * doctor serp_health 的 baseline 陈旧度可见面（自动首录后改版对比是否还「活着」）。
   * 无 baseline 时为空数组。
   */
  baselines: Array<{ engine: string; count: number; newest_age_ms: number }>;
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
   * @param engine           "baidu" | "ddg"（v1.11 round1 T9 起非 CJK 走 DDG；
   *                         round2 T2-5 顺手修正陈旧注释——旧文写 "google" 从未实现）
   * @param selectorVersion  "v1"（当前静态版本；未来 ChangeDetection 升级时换 v2）
   * @param query            用户查询词（ChangeDetection baseline 文件名组分）
   * @param dom              抽取时拿到的 a11y 树文本 / HTML（dom hash 源）
   * @param hit              true=抽到 ≥1 条结果；false=0 结果
   *
   * ACC-1①（2026-09-02 性能/准确率轮）：返回 **void**——旧签名同步返
   * "serp_layout_changed" | null 是死契约（内部 detectChange 是异步竞态，同步
   * return 时 Promise 恒未决 → 恒 null；且五处调用点 extract.ts:157/:176、
   * http-serp.ts:280/:345/:365 全为语句位置弃值）。改版确认通路 = logger.warn
   * （serp_redesign_confirmed）+ RecordingStore.save；进程内状态查询走 snapshot()。
   */
  onResult(
    engine: SerpEngine,
    selectorVersion: string,
    query: string,
    dom: string,
    hit: boolean,
  ): void {
    const key = `${engine}:${selectorVersion}`;
    if (hit) {
      this.registry.recordHit(engine, selectorVersion);
      this.hitRate.recordHit(key);
      // ACC-1②：命中路径自动首录（幂等：无既有 baseline 才写；失败保守吞错）
      void this._maybeCaptureBaseline(engine, query, dom);
    } else {
      this.registry.recordMiss(engine, selectorVersion);
      this.hitRate.recordMiss(key);
    }
    // 异步验证（不阻 extract 主路径；保守吞错）
    void this._maybeDetectRedesign(engine, query, dom).catch(() => {
      /* 保守吞错：改版检测失败不影响主路径 */
    });
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
    // ACC-1②：baseline 陈旧度（同步盘点——仅 doctor 按需，不在抽取热路径）
    const now = Date.now();
    const baselineStats = this.change.baselineStatsSync();
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
      baselines: [...baselineStats.entries()].map(([engine, s]) => ({
        engine,
        count: s.count,
        newest_age_ms: Math.max(0, now - s.newest_captured_at),
      })),
    };
  }

  /**
   * ACC-1②（2026-09-02 性能/准确率轮）：命中路径自动首录 baseline（幂等 + 保守吞错）。
   *
   * 根因：captureBaseline 此前全仓仅测试调用（生产零调用点）→ detectChange 恒走
   * 「无 baseline → changed:false」分支 → 改版检测链在生产双重失效（①返回契约死、
   * ②对比基线缺）。修法 = 命中（DOM 可信）且该 engine|query 无 baseline 时落一份。
   *
   * 诚实边界：首次运行即已改版的场景会把新布局录为基线（该场景现状本就永不告警，
   * 不劣化）；落地后改版检出延迟 = 「改版发生 → 下次同 query 查询报警」≤1 次。
   */
  private async _maybeCaptureBaseline(
    engine: SerpEngine,
    query: string,
    dom: string,
  ): Promise<void> {
    try {
      if (await this.change.hasBaseline(engine, query)) return; // 幂等：不覆盖既有
      await this.change.captureBaseline(engine, query, dom);
      logger.info({
        evt: "serp_baseline_auto_captured",
        engine,
        query_len: query.length,
      });
    } catch {
      /* 保守吞错：首录失败不影响主路径 */
    }
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
