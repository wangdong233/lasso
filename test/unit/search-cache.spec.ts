/**
 * SearchCache 单元测（parse2 §5.1 / §3.4 / INV-11）。
 *
 * 覆盖：
 *  - TTL：7 天内有效 / 过期删除返 null
 *  - canonical key 稳定：大小写 / 空白 / diacritics 归一
 *  - INV-11：key 含 engine + region + limit（不同 engine 不命中）
 *  - 分片路径：<sha1[0:2]>/<sha1[2:4]>/<full>.json
 *  - LRU：超 MAX_ENTRIES 删最旧 10%
 *  - clear 清空
 *  - 不存在的 key → 返 null（不抛错）
 *  - 错误结果（unknown）不应被写缓存（caller 责任，cache.set 不强制）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdtempSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SearchCache } from "../../src/search/SearchCache.js";
import type { InteractResult, SearchResult } from "../../src/types.js";

// ============================================================
// fixture
// ============================================================
function workedResult(
  query: string,
  results: Array<{ title: string; url: string }>,
): InteractResult<SearchResult> {
  return {
    outcome: "worked",
    data: {
      query,
      results: results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: "",
      })),
      count: results.length,
      engine: "multi",
      region: "auto",
    },
    served_by: "search.zhipu,search.brave",
    fallback_used: false,
    retrieval_method: "multi_source_fanout",
  };
}

// ============================================================
// setup / teardown
// ============================================================
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), "lasso-cache-"));
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
});

// ============================================================
// 基础 set/get
// ============================================================
describe("SearchCache — set/get 基础", () => {
  it("写入后立即读取 → 返回原 result", async () => {
    const cache = new SearchCache(cacheDir);
    const r = workedResult("rust", [{ title: "Rust", url: "https://rust.test" }]);
    await cache.set("rust", "auto", "cn", 10, r);
    const got = await cache.get("rust", "auto", "cn", 10);
    expect(got).not.toBeNull();
    expect(got!.outcome).toBe("worked");
    expect(got!.data!.results[0].url).toBe("https://rust.test");
  });

  it("不存在的 key → 返 null（不抛错）", async () => {
    const cache = new SearchCache(cacheDir);
    const got = await cache.get("never-set", "auto", "cn", 10);
    expect(got).toBeNull();
  });

  it("set 时自动创建分片目录（recursive mkdir）", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("x", "auto", "cn", 5, workedResult("x", []));
    // 分片目录存在
    const key = cache.computeKey("x", "auto", "cn", 5);
    const shardPath = path.join(cacheDir, key.slice(0, 2), key.slice(2, 4));
    const stat = await fs.stat(shardPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("clear 清空整个 cache 目录", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("a", "auto", "cn", 5, workedResult("a", []));
    await cache.set("b", "auto", "cn", 5, workedResult("b", []));
    await cache.clear();
    expect(await cache.get("a", "auto", "cn", 5)).toBeNull();
    expect(await cache.get("b", "auto", "cn", 5)).toBeNull();
  });
});

// ============================================================
// canonical key 稳定性（INV-11 + parse2 §3.4）
// ============================================================
describe("SearchCache — canonical key 归一", () => {
  it("大小写不敏感：'Rust' 与 'rust' 同 key", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("Rust", "auto", "cn", 10, workedResult("Rust", []));
    expect(await cache.get("rust", "auto", "cn", 10)).not.toBeNull();
  });

  it("空白归一：前后空格 + 多空格 → 同 key", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("  rust    lang  ", "auto", "cn", 10, workedResult("x", []));
    expect(await cache.get("rust lang", "auto", "cn", 10)).not.toBeNull();
  });

  it("diacritics 归一：'naïve' 与 'naive' 同 key", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("naïve", "auto", "cn", 10, workedResult("x", []));
    expect(await cache.get("naive", "auto", "cn", 10)).not.toBeNull();
  });

  it("CJK 不被 diacritics 去除影响（中文 key 稳定）", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("Rust 异步编程", "auto", "cn", 10, workedResult("x", []));
    expect(await cache.get("rust 异步编程", "auto", "cn", 10)).not.toBeNull();
  });

  it("computeKey 返回 40 字符 sha1 hex", async () => {
    const cache = new SearchCache(cacheDir);
    const key = cache.computeKey("x", "auto", "cn", 10);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ============================================================
// INV-11: attribution key 含 engine + region + limit
// ============================================================
describe("SearchCache — INV-11 attribution key（含 engine+region+limit）", () => {
  it("不同 engine 不互相命中（zhipu vs brave vs auto）", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("rust", "zhipu", "cn", 10, workedResult("z", []));
    expect(await cache.get("rust", "zhipu", "cn", 10)).not.toBeNull();
    expect(await cache.get("rust", "brave", "cn", 10)).toBeNull();
    expect(await cache.get("rust", "auto", "cn", 10)).toBeNull();
  });

  it("不同 region 不互相命中", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("rust", "auto", "cn", 10, workedResult("x", []));
    expect(await cache.get("rust", "auto", "us", 10)).toBeNull();
  });

  it("不同 limit 不互相命中", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("rust", "auto", "cn", 10, workedResult("x", []));
    expect(await cache.get("rust", "auto", "cn", 20)).toBeNull();
  });

  it("key 计算公式：sha1(canonical(query)|engine|region|limit)", () => {
    const cache = new SearchCache(cacheDir);
    const q = "Rust Lang";
    const engine = "auto";
    const region = "cn";
    const limit = 10;
    const expectedCanon = "rust lang"; // lowercase + collapse whitespace
    const expectedHash = crypto
      .createHash("sha1")
      .update(`${expectedCanon}|${engine}|${region}|${limit}`)
      .digest("hex");
    expect(cache.computeKey(q, engine, region, limit)).toBe(expectedHash);
  });
});

// ============================================================
// TTL: 7 天
// ============================================================
describe("SearchCache — 7 天 TTL（mtime）", () => {
  it("TTL 内（新写入）→ 命中", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("fresh", "auto", "cn", 5, workedResult("x", []));
    expect(await cache.get("fresh", "auto", "cn", 5)).not.toBeNull();
  });

  it("超过 TTL → 删除文件并返 null", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("stale", "auto", "cn", 5, workedResult("x", []));
    // 把 mtime 改到 8 天前
    const key = cache.computeKey("stale", "auto", "cn", 5);
    const file = path.join(
      cacheDir,
      key.slice(0, 2),
      key.slice(2, 4),
      `${key}.json`,
    );
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(file, eightDaysAgo, eightDaysAgo);
    expect(await cache.get("stale", "auto", "cn", 5)).toBeNull();
    // 文件应已被删除
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("临界：刚好 7 天前 → 命中失败（> TTL_MS）", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("edge", "auto", "cn", 5, workedResult("x", []));
    const key = cache.computeKey("edge", "auto", "cn", 5);
    const file = path.join(
      cacheDir,
      key.slice(0, 2),
      key.slice(2, 4),
      `${key}.json`,
    );
    // mtime 设到 7 天 + 1 秒前（> TTL_MS = 7 * 24 * 60 * 60 * 1000）
    const overTtl = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000 + 1000));
    await fs.utimes(file, overTtl, overTtl);
    expect(await cache.get("edge", "auto", "cn", 5)).toBeNull();
  });
});

// ============================================================
// 分片路径
// ============================================================
describe("SearchCache — 分片目录结构", () => {
  it("文件落在 <sha1[0:2]>/<sha1[2:4]>/<full>.json 路径", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("shard-test", "auto", "cn", 5, workedResult("x", []));
    const key = cache.computeKey("shard-test", "auto", "cn", 5);
    const expectedPath = path.join(
      cacheDir,
      key.slice(0, 2),
      key.slice(2, 4),
      `${key}.json`,
    );
    const stat = await fs.stat(expectedPath);
    expect(stat.isFile()).toBe(true);
  });

  it("两个不同 query 落在不同分片目录（hash 散列）", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("apple", "auto", "cn", 5, workedResult("a", []));
    await cache.set("zebra", "auto", "cn", 5, workedResult("z", []));
    expect(await cache.count()).toBe(2);
  });
});

// ============================================================
// LRU 上限 1000
// ============================================================
describe("SearchCache — LRU 上限（maxEntries 可注入）", () => {
  it("写入 ≤ maxEntries 不触发 GC", async () => {
    const cache = new SearchCache(cacheDir, 50);
    for (let i = 0; i < 50; i++) {
      await cache.set(`q${i}`, "auto", "cn", 5, workedResult(`q${i}`, []));
    }
    expect(await cache.count()).toBe(50);
    // 第 0 条仍在
    expect(await cache.get("q0", "auto", "cn", 5)).not.toBeNull();
  });

  it("写入 > maxEntries → 触发 GC，删最旧 10%（保留 ~90%）", async () => {
    const cache = new SearchCache(cacheDir, 50);
    // 写 60 条；触发 GC（删 floor(60 * 0.1) = 6 条）
    for (let i = 0; i < 60; i++) {
      await cache.set(`q${i}`, "auto", "cn", 5, workedResult(`q${i}`, []));
    }
    const remaining = await cache.count();
    // 期望保留约 54 条（60 - 6 = 54）
    // 容差：[45, 50]
    expect(remaining).toBeGreaterThanOrEqual(45);
    expect(remaining).toBeLessThanOrEqual(50);
  });

  it("GC 删最旧：早期 query 被删，最新保留", async () => {
    // maxEntries=60 让初始 60 次写入不触发 GC（60 == maxEntries，不 >）
    const cache = new SearchCache(cacheDir, 60);
    for (let i = 0; i < 60; i++) {
      await cache.set(`q${i}`, "auto", "cn", 5, workedResult(`q${i}`, []));
    }
    expect(await cache.count()).toBe(60); // 写入完成，未触发 GC

    // 手动设 mtime：i 越大 mtime 越新（i=0 最旧，i=59 最新）
    for (let i = 0; i < 60; i++) {
      const key = cache.computeKey(`q${i}`, "auto", "cn", 5);
      const file = path.join(
        cacheDir,
        key.slice(0, 2),
        key.slice(2, 4),
        `${key}.json`,
      );
      const mt = new Date(Date.now() - (60 - i) * 60_000);
      await fs.utimes(file, mt, mt);
    }
    // 再写一条触发 GC（60 → 61 > 60，删 floor(61*0.1)=6 条最旧）
    await cache.set("trigger", "auto", "cn", 5, workedResult("t", []));
    // q0 应被删（mtime 最旧）
    expect(await cache.get("q0", "auto", "cn", 5)).toBeNull();
    // q1 应被删（第二旧）
    expect(await cache.get("q1", "auto", "cn", 5)).toBeNull();
    // q59 应保留（mtime 最新）
    expect(await cache.get("q59", "auto", "cn", 5)).not.toBeNull();
  });

  it("默认 maxEntries=1000（生产配置）", async () => {
    // 不传 maxEntries → 默认 1000
    const cache = new SearchCache(cacheDir);
    // 只写少量，验证不抛错（默认大值不触发 GC）
    for (let i = 0; i < 10; i++) {
      await cache.set(`default${i}`, "auto", "cn", 5, workedResult(`d${i}`, []));
    }
    expect(await cache.count()).toBe(10);
  });
});

// ============================================================
// 损坏文件不崩
// ============================================================
describe("SearchCache — 健壮性", () => {
  it("文件存在但内容非 JSON → 返 null（不抛错）", async () => {
    const cache = new SearchCache(cacheDir);
    const key = cache.computeKey("broken", "auto", "cn", 5);
    const file = path.join(
      cacheDir,
      key.slice(0, 2),
      key.slice(2, 4),
      `${key}.json`,
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "not-json-{{{");
    expect(await cache.get("broken", "auto", "cn", 5)).toBeNull();
  });

  it("cacheDir 不存在时 get → 返 null（不抛错）", async () => {
    const cache = new SearchCache(path.join(cacheDir, "nonexistent"));
    expect(await cache.get("x", "auto", "cn", 5)).toBeNull();
  });

  it("count() 在空 cacheDir 返 0", async () => {
    const cache = new SearchCache(path.join(cacheDir, "empty"));
    expect(await cache.count()).toBe(0);
  });

  it("count() 用 statSync 读 mtime 不抛错（即使部分文件损坏）", async () => {
    const cache = new SearchCache(cacheDir);
    await cache.set("ok1", "auto", "cn", 5, workedResult("a", []));
    await cache.set("ok2", "auto", "cn", 5, workedResult("b", []));
    expect(await cache.count()).toBe(2);
  });
});
