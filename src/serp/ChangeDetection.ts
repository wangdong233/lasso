/**
 * ChangeDetection —— SERP 改版检测骨架（parse2 §3.5.2 / F3.8.9）。
 *
 * v0.2 范围：仅 baseline 存取 + hash 比对，不主动接入主路径。
 *  - captureBaseline(engine, query, dom) → sha1(dom) 落盘到 baselineDir
 *  - detectChange(engine, query, currentDom) → 对比 baseline，hash 变则 changed=true
 *
 * 真正的告警链路（命中率先降 → 触发 ChangeDetection → 自动升 selector 版本）v0.7 接入；
 * 录制回放（fixture 驱动改版回归）v1.0 接入（见 RecordingStore）。
 *
 * 设计（10 §D.1「SERP 是债不是资产」）：
 *  - dom_hash 是抽样哈希（外层传 dom 字符串，本类不抽 DOM 节点，保持职责单一）
 *  - 文件位置：baselineDir/<sha1(engine|query)[0:2]>/<full>.json（分片避免大目录）
 *  - 无 baseline（首次） → changed=false（不告警；baseline 一次后才开始对比）
 *
 * 借鉴：open-webSearch selector 级联；08 §3.8「SERP 是债不是资产」。
 */
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { logger } from "../util/logger.js";

// ============================================================
// 类型
// ============================================================
export interface SerpSnapshot {
  engine: string;
  query: string;
  /** sha1(dom 字符串)，用于检测改版 */
  dom_hash: string;
  /** epoch ms */
  captured_at: number;
}

export interface ChangeDetectionResult {
  changed: boolean;
  /** 之前 baseline 的 hash（无 baseline 时省略） */
  baseline_hash?: string;
  /** 本次 currentDom 的 hash */
  current_hash: string;
}

// ============================================================
// ChangeDetection
// ============================================================
export class ChangeDetection {
  constructor(private readonly baselineDir: string) {}

  /**
   * 写入 / 更新 baseline（parse2 §3.5.2）。
   * 同 engine + query 二次写入 = 覆盖（v0.2 简化；v0.7 可加版本号区分历史 baseline）。
   */
  async captureBaseline(
    engine: string,
    query: string,
    dom: string,
  ): Promise<SerpSnapshot> {
    const snapshot: SerpSnapshot = {
      engine,
      query,
      dom_hash: sha1(dom),
      captured_at: Date.now(),
    };
    const file = this._file(engine, query);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(snapshot));
    logger.info({
      evt: "serp_baseline_captured",
      engine,
      query_len: query.length,
      dom_hash: snapshot.dom_hash.slice(0, 8),
    });
    return snapshot;
  }

  /**
   * 对比 currentDom 与 baseline（parse2 §3.5.2）。
   *  - baseline 缺失 → changed=false（首次，不告警）
   *  - hash 一致 → changed=false
   *  - hash 不一致 → changed=true（外层 v0.7 可触发告警 + selector 升级）
   *
   * 读 baseline 失败（IO 错 / JSON 解析错）→ changed=false（保守不告警）。
   */
  async detectChange(
    engine: string,
    query: string,
    currentDom: string,
  ): Promise<ChangeDetectionResult> {
    const currentHash = sha1(currentDom);
    const file = this._file(engine, query);
    try {
      const raw = await fs.readFile(file, "utf8");
      const baseline = JSON.parse(raw) as SerpSnapshot;
      const changed = baseline.dom_hash !== currentHash;
      if (changed) {
        logger.warn({
          evt: "serp_change_detected",
          engine,
          baseline_hash: baseline.dom_hash.slice(0, 8),
          current_hash: currentHash.slice(0, 8),
        });
      }
      return {
        changed,
        baseline_hash: baseline.dom_hash,
        current_hash: currentHash,
      };
    } catch {
      // 文件不存在 / 解析失败 → 视为无 baseline，不告警
      return { changed: false, current_hash: currentHash };
    }
  }

  /** 暴露 baseline 文件路径（doctor + 测试用）。 */
  baselinePath(engine: string, query: string): string {
    return this._file(engine, query);
  }

  private _file(engine: string, query: string): string {
    const h = sha1(`${engine}|${query}`);
    return path.join(this.baselineDir, h.slice(0, 2), `${h}.json`);
  }
}

// ============================================================
// 私有：sha1 hex
// ============================================================
function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}
