/**
 * SearchCache —— 7 天 TTL + sha1 attribution key + LRU 1000（parse2 §3.4 / F3.1.4）。
 *
 * 存储：cacheDir/<sha1[0:2]>/<sha1[2:4]>/<full-hash>.json
 *  - 分片目录避免单目录万级文件 ls 慢（EXT4/APFS 目录索引限制）
 *  - 文件内容 = SearchCacheEntry JSON（含 result 完整）
 *  - TTL 用 mtime（fs.stat.mtimeMs）判断，不读自身 created_at（更可靠）
 *
 * attribution key（不变量 INV-11）：
 *  - 输入：canonical(query) | engine | region | limit
 *  - canonical：trim + lowercase + 去多余空白 + NFD + 去 diacritics（naïve → naive）
 *  - sha1 → hex（40 字符，足够避免碰撞）
 *  - 必须含 engine + region + limit —— 防同 query 不同 engine 误命中（智谱 ≠ Brave ≠ auto）
 *
 * LRU 1000：v0.2 简化懒清理（每次 set 后若总量 > MAX_ENTRIES，扫一遍删最旧 ~10%）；
 *   v0.3 升级为精确 mtime 排序 + 异步 GC。
 *
 * 不破坏 v0.1：cache 是 search 专属，不动 browse 的 state-store。
 *
 * 借鉴：parse2 §3.4 / §4.3；05 §4.4 DDG 静默空响应场景（cache 命中保留原 served_by）。
 */
import { promises as fs, statSync, type Dirent } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  InteractResult,
  SearchCacheEntry,
  SearchResult,
} from "../types.js";
import { logger } from "../util/logger.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const DEFAULT_MAX_ENTRIES = 1000; // LRU 上限
const GC_EVICT_RATIO = 0.1; // 超 MAX 时删最旧 10%

export class SearchCache {
  private readonly maxEntries: number;

  /**
   * @param cacheDir    cache 落盘根目录（~/.cache/lasso/search-cache/）
   * @param maxEntries   LRU 上限（默认 1000；测试可注小值以触发 GC）
   */
  constructor(
    private readonly cacheDir: string,
    maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {
    this.maxEntries = maxEntries;
  }

  /**
   * 取缓存。TTL 过期 → 删除并返 null；文件不存在 / 解析失败 → 返 null（不抛错）。
   */
  async get(
    query: string,
    engine: string,
    region: string,
    limit: number,
  ): Promise<InteractResult<SearchResult> | null> {
    const key = this._key(query, engine, region, limit);
    const file = this._file(key);
    try {
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs > TTL_MS) {
        await fs.unlink(file).catch(() => {});
        return null;
      }
      const raw = await fs.readFile(file, "utf8");
      const entry = JSON.parse(raw) as SearchCacheEntry<
        InteractResult<SearchResult>
      >;
      return entry.result;
    } catch {
      return null;
    }
  }

  /**
   * 写缓存。仅 worked 路径写（unknown/didnt 不缓存，避免缓存错误）。
   * 写完后同步触发 _maybeGc（v0.2 简化；v0.3 升级为异步 worker）。
   */
  async set(
    query: string,
    engine: string,
    region: string,
    limit: number,
    result: InteractResult<SearchResult>,
  ): Promise<void> {
    const key = this._key(query, engine, region, limit);
    const file = this._file(key);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const entry: SearchCacheEntry<InteractResult<SearchResult>> = {
        key,
        query,
        engine,
        region,
        limit,
        result,
        created_at: Date.now(),
        hits: 0,
      };
      await fs.writeFile(file, JSON.stringify(entry));
    } catch (e) {
      // 写失败不阻塞主流程（cache 是优化不是正确性）
      logger.warn({
        evt: "search_cache_write_error",
        error: String(e),
      });
      return;
    }
    // v0.2 同步 GC（每次 set 后扫一遍，超 max 删最旧 10%）；
    // 简单可靠：测试 / 生产都不需要担心 GC 与读的竞态。
    // v0.3 升级为异步 worker（不阻塞 set 返回）。
    try {
      await this._maybeGc();
    } catch (e) {
      logger.warn({ evt: "search_cache_gc_error", error: String(e) });
    }
  }

  /** 清空整个 cache 目录（测试用）。 */
  async clear(): Promise<void> {
    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  /**
   * 暴露 cache key（测试 + doctor 用）。INV-11 守：含 engine+region+limit。
   */
  computeKey(
    query: string,
    engine: string,
    region: string,
    limit: number,
  ): string {
    return this._key(query, engine, region, limit);
  }

  /** 当前 cache 文件总数（测试 + doctor 用；非递归只到分片根）。 */
  async count(): Promise<number> {
    return (await this._listAllFiles()).length;
  }

  // ============================================================
  // 私有
  // ============================================================
  /**
   * attribution key：sha1(canonical(query) | engine | region | limit)。
   *
   * INV-11：必须含 engine + region + limit；缺一即违反不变量。
   * canonical：trim + lowercase + 单空格 + NFD + 去 combining diacritics。
   */
  private _key(
    q: string,
    engine: string,
    region: string,
    limit: number,
  ): string {
    const canon = q
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    return crypto
      .createHash("sha1")
      .update(`${canon}|${engine}|${region}|${limit}`)
      .digest("hex");
  }

  /** 分片路径：<cacheDir>/<sha1[0:2]>/<sha1[2:4]>/<full>.json */
  private _file(key: string): string {
    return path.join(
      this.cacheDir,
      key.slice(0, 2),
      key.slice(2, 4),
      `${key}.json`,
    );
  }

  /** 列出 cacheDir 下所有 .json 文件（递归扫分片目录）。 */
  private async _listAllFiles(): Promise<string[]> {
    const out: string[] = [];
    let top: Dirent[];
    try {
      top = await fs.readdir(this.cacheDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const shard1 of top) {
      if (!shard1.isDirectory()) continue;
      const p1 = path.join(this.cacheDir, shard1.name);
      let inner: Dirent[];
      try {
        inner = await fs.readdir(p1, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const shard2 of inner) {
        if (!shard2.isDirectory()) continue;
        const p2 = path.join(p1, shard2.name);
        let leafs: string[];
        try {
          leafs = await fs.readdir(p2);
        } catch {
          continue;
        }
        for (const leaf of leafs) {
          if (leaf.endsWith(".json")) out.push(path.join(p2, leaf));
        }
      }
    }
    return out;
  }

  /**
   * 简化 LRU：超 MAX_ENTRIES 则按 mtime 升序删最旧 GC_EVICT_RATIO 比例。
   * v0.2 同步实现（小规模 OK）；v0.3 异步 + worker。
   */
  private async _maybeGc(): Promise<void> {
    let files: string[];
    try {
      files = await this._listAllFiles();
    } catch {
      return;
    }
    if (files.length <= this.maxEntries) return;

    // mtime 扫描（同步 statSync 简单可靠；1000 文件 < 50ms）
    const stamped = files
      .map((f) => {
        try {
          return { f, mt: statSync(f).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { f: string; mt: number } => x !== null);
    stamped.sort((a, b) => a.mt - b.mt);

    const evictCount = Math.max(
      1,
      Math.floor(stamped.length * GC_EVICT_RATIO),
    );
    const victims = stamped.slice(0, evictCount);
    for (const v of victims) {
      await fs.unlink(v.f).catch(() => {});
    }
    logger.info({
      evt: "search_cache_gc",
      total: stamped.length,
      evicted: victims.length,
      max: this.maxEntries,
    });
  }
}
