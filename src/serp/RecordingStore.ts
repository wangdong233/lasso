/**
 * RecordingStore —— SERP 录制回放存储骨架（parse2 §3.5.3 / F3.8.14）。
 *
 * v0.2 范围：仅存原始快照（key = engine|query），不做回放。
 *  - save(engine, query, snapshot)：把 SERP HTML / a11y 文本落盘到 dir
 *  - load(engine, query)：读回（v1.0 回放回归测试用）
 *  - list(engine?)：列已有 fixture（doctor 用）
 *
 * 设计：
 *  - 文件位置：dir/<sha1(engine|query)[0:2]>/<full>.html
 *  - 内容：原始字符串（由 caller 决定是 HTML 还是 a11y 文本）
 *  - 同 engine + query 二次 save = 覆盖（保留最新；v0.7 加版本号区分历史录制）
 *
 * 回放链路 v1.0 接入（F3.8.14）：每次 browse_headless 兜底抽到 SERP 时存一份 fixture；
 *   selector 改版后用 fixture 跑离线回归测试，无需真实网络。
 *
 * 借鉴：parse2 §3.5.3；08 §3.8 F3.8.14（录制回放）。
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

export class RecordingStore {
  constructor(private readonly dir: string) {}

  /**
   * 保存一次 SERP 抽取的原始快照（HTML / a11y 文本）。
   * 同 engine+query 二次保存 = 覆盖。
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
   * 读回录制的快照（v1.0 回放回归测试用）。
   * 不存在 → null（不抛错，回放端优雅降级）。
   */
  async load(engine: string, query: string): Promise<string | null> {
    const file = this._file(engine, query);
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return null;
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
