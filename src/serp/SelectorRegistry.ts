/**
 * SelectorRegistry —— SERP selector 集中管理 + 版本化（parse2 §3.5.1 / F3.8.13）。
 *
 * v0.2 范围：仅骨架 + 启动时从 selectors.ts 静态表加载 + hit/miss 计数。
 *  - 启动：构造时从 BAIDU_SELECTORS / GOOGLE_SELECTORS 生成 v1 版本集
 *  - 命中反馈：recordHit / recordMiss（v0.7 告警链路接入前不主动消费，仅暴露 API）
 *  - last_known_good：v1 初值 = today（构造时）；v0.7 升级后由 ChangeDetection 写回
 *
 * 真正的命中率和告警链路 v0.7 接入（F3.8.10 + F3.7.5-12）；
 * 录制回放 v1.0 接入（F3.8.14，见 RecordingStore）。
 *
 * 集中管理目的（10 §D.1 + F3.8.13）：单点改，避免散落多处 selector 字面量。
 *
 * 借鉴：open-webSearch selector 级联；08 §3.8「SERP 是债不是资产」。
 */
import type { SerpEngine, SerpSelectorSet } from "./selectors.js";
import { BAIDU_SELECTORS, GOOGLE_SELECTORS } from "./selectors.js";

// ============================================================
// 类型
// ============================================================
/**
 * 版本化 selector 集（parse2 §3.5.1）。
 * - version：语义版本标签（"2026-07-21-v1"），便于改版后灰度切换
 * - last_known_good：上次验证可用的 ISO 日期
 * - hit_count / miss_count：累计命中 / 失败次数（HitRateStats 同源数据）
 */
export interface VersionedSelectorSet extends SerpSelectorSet {
  version: string;
  last_known_good: string;
  hit_count: number;
  miss_count: number;
}

const INITIAL_VERSION = "v1";

// ============================================================
// SelectorRegistry
// ============================================================
export class SelectorRegistry {
  private sets = new Map<SerpEngine, VersionedSelectorSet[]>();

  constructor() {
    this.sets.set("baidu", versionize(BAIDU_SELECTORS, INITIAL_VERSION));
    this.sets.set("google", versionize(GOOGLE_SELECTORS, INITIAL_VERSION));
  }

  /** 取某引擎的全部版本化 selector 集（主→备顺序保留）。 */
  get(engine: SerpEngine): VersionedSelectorSet[] {
    return this.sets.get(engine) ?? [];
  }

  /** 是否已注册（doctor 检查用）。 */
  has(engine: SerpEngine): boolean {
    return this.sets.has(engine);
  }

  /**
   * 记一次命中：找到 engine 下指定 version 的 set，hit_count++。
   * version 未匹配则忽略（v0.7 升级后容错）。
   */
  recordHit(engine: SerpEngine, version: string): void {
    const s = this._find(engine, version);
    if (s) s.hit_count++;
  }

  /** 记一次失败（miss）：同 recordHit 但 miss_count++。 */
  recordMiss(engine: SerpEngine, version: string): void {
    const s = this._find(engine, version);
    if (s) s.miss_count++;
  }

  /**
   * 命中率聚合（doctor + HitRateStats 用）。
   * 返回 engine 维度合并的 hit/miss/rate；无数据时 rate=1（乐观默认）。
   */
  hitRate(engine: SerpEngine): { hit: number; miss: number; rate: number } {
    const list = this.sets.get(engine) ?? [];
    let hit = 0;
    let miss = 0;
    for (const s of list) {
      hit += s.hit_count;
      miss += s.miss_count;
    }
    const total = hit + miss;
    return { hit, miss, rate: total === 0 ? 1 : hit / total };
  }

  /** 暴露所有已注册引擎（doctor 用）。 */
  engines(): SerpEngine[] {
    return Array.from(this.sets.keys());
  }

  private _find(engine: SerpEngine, version: string): VersionedSelectorSet | undefined {
    const list = this.sets.get(engine);
    if (!list) return undefined;
    return list.find((s) => s.version === version);
  }
}

// ============================================================
// 内部：从静态表生成 v1 版本化列表
// ============================================================
/**
 * 把 SerpSelectorSet[] 升级为 VersionedSelectorSet[]（parse2 §3.5.1）。
 * - 初值 hit_count / miss_count = 0
 * - last_known_good = 构造时刻 ISO（v1 是 baseline，默认"今天已知良好"）
 */
function versionize(list: readonly SerpSelectorSet[], version: string): VersionedSelectorSet[] {
  const today = new Date().toISOString();
  return list.map((s) => ({
    ...s,
    version,
    last_known_good: today,
    hit_count: 0,
    miss_count: 0,
  }));
}
