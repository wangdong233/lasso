/**
 * RecordingStore —— SERP 录制回放存储（parse2 §3.5.3 v0.2 骨架 + parse10 §3.4 v0.9 实装）。
 *
 * **v0.9 Phase A 升级（parse10 §3.4 + INV-57..59）**：
 *  - **默认 OFF**（INV-57）：LASSO_RECORD_SEARCH=true 才录；CI 测试集不被污染。
 *  - **replay 实装**：按 (engine, query) 哈希回放录制过的 snapshot（F3.8.14 兜底链尾）。
 *  - **save 异步不阻塞 search 主路径**（INV-59）：新增 saveIfRecording() 是 **非 async**
 *    fire-and-forget 入口；内部 .catch 吞错；search 主路径不 await。
 *
 * 设计：
 *  - 文件位置：dir/<sha1(engine|query)[0:2]>/<full>.html（v0.2 骨架不变）
 *  - 内容：原始字符串（由 caller 决定是 HTML 还是 a11y 文本）
 *  - 同 engine + query 二次 save = 覆盖（保留最新；v0.7 加版本号区分历史录制）
 *
 * 回放链路 v0.9 接入（parse10 §3.4）：
 *  - 录制（LASSO_RECORD_SEARCH=true）：每次 search/browse SERP 抽到时 fire-and-forget 存一份
 *  - 回放（最后兜底档）：全源熔断 + 网断时，按 query 哈希查本地录制，命中则返历史 snapshot
 *    （tri-state：命中返 worked + served_by="recording_replay"；未命中返 didnt，不伪造）
 *
 * 铁律（INV-57..59）：
 *  - INV-57：录制回放必显式 opt-in（grep LASSO_RECORD_SEARCH env 字面量；默认 OFF）
 *  - INV-59：RecordingStore.save 异步不阻塞（grep saveIfRecording 内部不 await）
 *
 * 借鉴：parse2 §3.5.3；parse10 §3.4；08 §3.8 F3.8.14（录制回放）。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { logger } from "../util/logger.js";

export interface RecordingEntry {
  engine: string;
  query: string;
  /** 录制时刻 epoch ms。 */
  recorded_at: number;
  /** snapshot 字节长度（doctor 显示用，不暴露原文）。 */
  size: number;
}

// ============================================================
// 录制开关（INV-57）
// ============================================================
/**
 * 录制是否开启（INV-57：默认 OFF）。
 *
 * 进程启动时读一次 env，构造期固定（不让 search 主路径每次重新读 env）。
 * 单独导出便于 doctor / 单测引用。
 *
 * 值语义：
 *  - "true"（case-insensitive）→ 开启录制
 *  - 其他 / 缺失 → OFF（默认；CI 测试集不被污染）
 */
export function isRecordingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env.LASSO_RECORD_SEARCH;
  return v !== undefined && v.toLowerCase() === "true";
}

export class RecordingStore {
  /**
   * 录制开关（构造期固定；INV-57）。
   * 允许测试通过构造器注入显式 enabled 覆盖 env（不污染进程 env）。
   */
  private readonly recordingEnabled: boolean;

  constructor(
    private readonly dir: string,
    /**
     * 显式 enabled override（主要给单测用）：
     *  - undefined → 读 process.env.LASSO_RECORD_SEARCH（生产路径）
     *  - true/false → 显式覆盖（不读 env；测试可重现）
     */
    enabledOverride?: boolean,
  ) {
    this.recordingEnabled =
      enabledOverride !== undefined ? enabledOverride : isRecordingEnabled();
  }

  /** 录制是否开启（doctor / 单测用）。 */
  isEnabled(): boolean {
    return this.recordingEnabled;
  }

  /**
   * 保存一次 SERP 抽取的原始快照（HTML / a11y 文本）。
   * 同 engine+query 二次保存 = 覆盖。
   *
   * 这是低层 async API（落盘）—— search 主路径**不应直接 await 本方法**（INV-59）；
   * 应通过 saveIfRecording() fire-and-forget。
   */
  async save(engine: string, query: string, snapshot: string): Promise<RecordingEntry> {
    const file = this._file(engine, query);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, snapshot, "utf8");
    const entry: RecordingEntry = {
      engine,
      query,
      recorded_at: Date.now(),
      size: snapshot.length,
    };
    logger.info({
      evt: "serp_recording_saved",
      engine,
      query_len: query.length,
      size: entry.size,
    });
    return entry;
  }

  /**
   * v0.9 Phase A 新增（parse10 §3.4 + INV-57 + INV-59）：
   *  - **非 async**（同步入口）：search 主路径直接调，**不 await**，不阻塞主路径。
   *  - 录制 OFF 时立即返回（INV-57）。
   *  - 录制 ON 时 fire-and-forget 内部 save() Promise，.catch 吞错（INV-59：单次落盘失败
   *    不影响 search 结果）。
   *
   * **INV-59 grep 红线**：本函数体内禁 await（save 是 async 但不 await）。
   */
  saveIfRecording(engine: string, query: string, snapshot: string): void {
    if (!this.recordingEnabled) return;
    // fire-and-forget：不 await（INV-59）；.catch 吞错（避免 unhandled rejection）
    void this.save(engine, query, snapshot).catch((e) => {
      logger.warn({
        evt: "serp_recording_save_failed",
        engine,
        query_len: query.length,
        error: String(e),
      });
    });
  }

  /**
   * 读回录制的快照（v1.0 回放回归测试用；v0.9 Phase A search 兜底也用）。
   * 不存在 → null（不抛错，回放端优雅降级）。
   *
   * 这就是 v0.9 的「replay」入口（parse10 §3.4）：按 (engine, query) 哈希读盘。
   */
  async load(engine: string, query: string): Promise<string | null> {
    const file = this._file(engine, query);
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * v0.9 Phase A 新增（parse10 §3.4）：replay 入口。
   *
   * 按 (engine, query) 哈希查本地录制。命中返 worked + 录制原文 + served_by="recording_replay"；
   * 未命中返 didnt（**不伪造**——tri-state 诚实）。
   *
   * 用于全源熔断 / 网断时的最后兜底档（fallback 链尾）。
   * 注意：本方法 **不检查 LASSO_RECORD_SEARCH** —— 回放与录制是独立开关
   * （parse10 §3.4：即便录制关了，过去落盘的 fixture 仍可回放）。
   *
   * @param engine 录制时的 engine 名（如 "zhipu" / "brave" / "browse_headless"）
   * @param query  原始 query 字符串
   * @returns tri-state InteractResult，data.snapshot 是录制原文
   */
  async replay(
    engine: string,
    query: string,
  ): Promise<{
    outcome: "worked" | "didnt";
    snapshot: string | null;
    engine: string;
    query: string;
    recorded_at?: number;
    note: string;
  }> {
    const file = this._file(engine, query);
    try {
      const stat = await fs.stat(file);
      const snapshot = await fs.readFile(file, "utf8");
      return {
        outcome: "worked",
        snapshot,
        engine,
        query,
        recorded_at: stat.mtimeMs,
        note: "recording_replay_hit",
      };
    } catch {
      return {
        outcome: "didnt",
        snapshot: null,
        engine,
        query,
        note: "recording_replay_miss",
      };
    }
  }

  /** 是否存在录制（doctor + 测试用）。 */
  async has(engine: string, query: string): Promise<boolean> {
    try {
      await fs.access(this._file(engine, query));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出已录制的 fixture（doctor 显示用）。
   * 返回 engine / query / recorded_at / size 的元数据列表，不暴露原文。
   * v0.2 简化：扫一层分片目录，stat 文件取 mtime + size。
   */
  async list(): Promise<RecordingEntry[]> {
    const out: RecordingEntry[] = [];
    let shards: import("node:fs").Dirent[];
    try {
      shards = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const shardPath = path.join(this.dir, shard.name);
      let files: string[];
      try {
        files = await fs.readdir(shardPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".html")) continue;
        const full = path.join(shardPath, f);
        try {
          const st = await fs.stat(full);
          out.push({
            engine: "(indexed)",
            query: "(indexed)",
            recorded_at: st.mtimeMs,
            size: st.size,
          });
        } catch {
          // skip
        }
      }
    }
    return out;
  }

  /** 暴露录制文件路径（测试用）。 */
  pathOf(engine: string, query: string): string {
    return this._file(engine, query);
  }

  private _file(engine: string, query: string): string {
    const h = crypto
      .createHash("sha1")
      .update(`${engine}|${query}`)
      .digest("hex");
    return path.join(this.dir, h.slice(0, 2), `${h}.html`);
  }
}
