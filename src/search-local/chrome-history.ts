/**
 * search_local 源 1：Chrome History（B1 第四通道，parse24 §5.2 / doc/25 裁决④）
 *
 * **为什么存在**：「我上周看过的那篇文章在哪」——CC 此前完全无法回答
 * （doc/24 decision-B §0：整类缺失）。Chrome History 是 SQLite（urls 表），
 * FTS 路径 <10ms / $0 / 零后台进程（decision-B F2）。
 *
 * **隐私红线（INV-81 钉死，零妥协）**：
 *  - 本模块对源库**零写 API**——唯一写面是 copyFileSync 把源库复制进
 *    mkdtempSync 随机临时目录（INV-81(a) 白名单），查完 finally rmSync 只删临时目录；
 *  - 输出只有 {profile, title?, url, visited_at?, snippet?}——**无 content 全文字段**，
 *    不 join visits 明细表（v1 只查 urls 表；INV-81(b)）；
 *  - 日志只记 query_len，永不记查询原文与结果集（INV-81(e)）；
 *  - 零网络调用（INV-81(d)）：纯本地是架构属性，grep 可守。
 *
 * **WAL 锁规避（decision-B 技术要点 4）**：Chrome 运行时对 History 持 WAL 锁——
 * 禁直开原库；每库 copyFile 到临时目录后以 node:sqlite readOnly 打开。
 * 代价（诚实文档化）：WAL 未 checkpoint 的最近访问可能不在主库文件里，
 * 复制快照可能落后几分钟——对「找上周看过的文章」场景无影响。
 *
 * **多 profile**：`~/Library/Application Support/Google/Chrome/<profile>/History`
 * （Default + Profile 1..N；本机实证只有 Profile 1 存在、Default 反而缺位——
 * 写死 Default 的实现在这台机器上会颗粒无收，parse24 §1 F-B 已核）。
 *
 * **tri-state 退化（parse24 §5.1）**：无网络面无 fallback 语义——
 * 查不到/不可用就是 didnt（no_matches / chrome_history_not_found /
 * chrome_history_darwin_only / node_sqlite_unavailable），unknown 仅意外异常。
 */
import {
  existsSync,
  readdirSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { InteractResult } from "../types.js";
import { logger } from "../util/logger.js";

// ============================================================
// 输出形状（隐私红线落地：字段白名单，无 content）
// ============================================================

/** 单条历史命中 —— INV-81(b)：字段只有这五个，禁加全文类字段 */
export interface ChromeHistoryHit {
  /** 命中来自哪个 Chrome profile（"Default" / "Profile 1"…） */
  profile: string;
  /** 页面标题（Chrome 可能存空串→省略） */
  title?: string;
  /** 页面 URL */
  url: string;
  /** 最后访问时间（ISO 8601；Chrome 1601 纪元微秒换算；0/非法时间→省略） */
  visited_at?: string;
  /** title 匹配片段 ≤200 字符（只来自 title 本身，非页面内容） */
  snippet?: string;
}

export interface ChromeHistoryData {
  source: "history";
  /** 返回条数（≤ limit） */
  count: number;
  /** 实际查过的 profile 名单（0 命中时 CC 据此分辨「查了没有」vs「没查到」） */
  profiles_searched: string[];
  /** 复制/打开失败被诚实跳过的 profile（含原因；不伪装成空结果） */
  profiles_skipped: Array<{ profile: string; reason: string }>;
  results: ChromeHistoryHit[];
}

// ============================================================
// node:sqlite 只读 opener（动态 import：Node 20/21 诚实降级）
// ============================================================

/** 只读打开所需的语句最小面（与 loadDefaultOpener 的 require cast 同形契约） */
export interface SqliteStatementLike {
  all(...params: unknown[]): unknown[];
  /** 大整数读取开关（Node 22.5+ 语句级 API；见 SqliteDbLike.setReadBigInts 注释） */
  setReadBigInts?(enabled: boolean): void;
}

export interface SqliteDbLike {
  prepare(sql: string): SqliteStatementLike;
  /**
   * node:sqlite 大整数读取开关（DB 级，Node 22.x 形态；可选——注入 mock 可不带）。
   *
   * 必开的原因：Chrome last_visit_time 是 1601 纪元微秒 ≈ 1.33e16，超
   * Number.MAX_SAFE_INTEGER（9.01e15）——不开则每行读取直接 throw
   * "Value is too large to be represented as a JavaScript number"（真机实测抓到）。
   *
   * API 形态跨版本（Node 24.12 实测）：DB 级 setReadBigInts 已移除，语句级
   * statement.setReadBigInts(true) 仍在 + 构造项 { readBigInts: true } 新增。
   * 三路双兼容：构造项（loadDefaultOpener）+ DB 级（22.x）+ 语句级（24.x），
   * 全部 optional-chaining 调用——任一生效即可。
   */
  setReadBigInts?(enabled: boolean): void;
  close(): void;
}

/** opener 契约：必须以 readOnly 打开（源库永不写是 INV-81(a) 语义） */
export type SqliteOpener = (path: string) => SqliteDbLike;

let defaultOpenerCache: SqliteOpener | null = null;

/** CJS require 句柄（node:sqlite 经 require 取——见 loadDefaultOpener 注释） */
const nodeRequire = createRequire(import.meta.url);

/**
 * 默认 opener：node:sqlite DatabaseSync（readOnly）。
 *
 * 取法用 createRequire().require("node:sqlite") 而非动态 import()：
 *  - vite/vitest 对 node:sqlite 的动态 import 解析有坑（resolved id 丢 node:
 *    前缀 → vitest 下误判模块不存在）；require 形态在 vitest 与生产 dist 同一真源，
 *    单测可直测默认路径；
 *  - Node 20/21（engines>=20 下限，node:sqlite 自 22.5 才内建）require 抛
 *    MODULE_NOT_FOUND → 上层捕获 → 诚实 didnt + node_sqlite_unavailable
 *    （server 进程不崩，向后兼容承诺不破）。
 */
async function loadDefaultOpener(): Promise<SqliteOpener> {
  if (defaultOpenerCache) return defaultOpenerCache;
  const mod = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean; readBigInts?: boolean },
    ) => SqliteDbLike;
  };
  // readBigInts 构造项：Node 24 形态（22.x 忽略未知项不报错；语句级兜底再补一路）
  defaultOpenerCache = (path) =>
    new mod.DatabaseSync(path, { readOnly: true, readBigInts: true });
  return defaultOpenerCache;
}

// ============================================================
// 时间换算 / LIKE 转义（纯函数，单测直测）
// ============================================================

/** Chrome/Windows 1601 纪元 → Unix 纪元的秒差 */
const CHROME_EPOCH_DELTA_SECONDS = 11_644_473_600;

/** Chrome last_visit_time（1601 纪元微秒）→ ISO 8601；0/非法 → undefined */
export function chromeTimeToIso(t: number | bigint): string | undefined {
  const us = typeof t === "bigint" ? Number(t) : t;
  if (!Number.isFinite(us) || us <= 0) return undefined;
  const ms = (us / 1e6 - CHROME_EPOCH_DELTA_SECONDS) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return undefined;
  return d.toISOString();
}

/** LIKE 转义：`\` `%` `_` 三元字符前加 `\`（配 ESCAPE '\' 子句；防通配注入） */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** snippet：title 内 query 首次命中处的 ≤200 字符窗口（只切 title，不碰页面内容） */
export function titleSnippet(title: string | undefined, query: string): string | undefined {
  if (!title) return undefined;
  const lower = title.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) {
    // 命中来自 url 而非 title —— 给 title 头部窗口作定位线索（仍是 title 文本）
    return title.length > 200 ? `${title.slice(0, 200)}…` : title;
  }
  const window = 200;
  const start = Math.max(0, idx - Math.floor(window / 4));
  const end = Math.min(title.length, start + window);
  const clipped = title.slice(start, end);
  return end < title.length ? `${clipped}…` : clipped;
}

// ============================================================
// profile 发现
// ============================================================

/** Chrome 用户数据根目录（可注入覆盖供测试；默认 macOS 惯例路径） */
export function defaultChromeRoot(): string {
  return join(homedir(), "Library", "Application Support", "Google", "Chrome");
}

export interface ChromeHistoryDeps {
  /** 平台覆盖（默认 process.platform；非 darwin → 诚实 didnt） */
  platform?: string;
  /** Chrome 用户数据根目录覆盖（默认 defaultChromeRoot()） */
  chromeRoot?: string;
  /** 临时目录根覆盖（默认 os.tmpdir()；复制快照落在这里） */
  tmpRoot?: string;
  /** sqlite opener 注入（默认动态 import node:sqlite；测试/降级注入点） */
  loadOpener?: () => Promise<SqliteOpener>;
}

/** 列出带 History 库的 profile 目录名（按名排序保确定性；无 → []） */
export function listHistoryProfiles(chromeRoot: string): string[] {
  try {
    const entries = readdirSync(chromeRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && existsSync(join(chromeRoot, e.name, "History")))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // 目录不存在 / 不可读 —— 诚实上层 didnt:not_found
  }
}

// ============================================================
// 查询参数形状（与 register 层解耦；tool 层负责 zod）
// ============================================================

export interface ChromeHistoryQuery {
  query: string;
  limit: number;
  /** 只查指定 profile（缺省扫全部） */
  profile?: string;
}

/** urls 表查询 SQL（参数化；只碰 urls 表，禁 join visits 明细——隐私红线） */
const HISTORY_SQL =
  "SELECT url, title, last_visit_time FROM urls " +
  "WHERE (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') " +
  "ORDER BY last_visit_time DESC LIMIT ?";

// ============================================================
// 核心查询（单 profile；复制→只读开→参数化查→关）
// ============================================================

interface ProfileQueryOutcome {
  hits?: ChromeHistoryHit[];
  skipReason?: string;
}

function queryProfileHistory(
  dbPath: string,
  profile: string,
  q: ChromeHistoryQuery,
  opener: SqliteOpener,
): ProfileQueryOutcome {
  let db: SqliteDbLike | null = null;
  try {
    db = opener(dbPath);
    // Chrome 时间戳超 MAX_SAFE_INTEGER——大整数读取必须开（三路双兼容见接口注释）
    db.setReadBigInts?.(true);
    const pattern = `%${escapeLikePattern(q.query)}%`;
    const stmt = db.prepare(HISTORY_SQL);
    stmt.setReadBigInts?.(true);
    const rows = stmt.all(pattern, pattern, q.limit) as Array<{
      url: string;
      title: string | null;
      last_visit_time: number | bigint;
    }>;
    return {
      hits: rows.map((r) => ({
        profile,
        title: r.title && r.title.length > 0 ? r.title : undefined,
        url: r.url,
        visited_at: chromeTimeToIso(r.last_visit_time),
        snippet: titleSnippet(
          r.title && r.title.length > 0 ? r.title : undefined,
          q.query,
        ),
      })),
    };
  } catch (e) {
    return { skipReason: `history_db_error:${String(e instanceof Error ? e.message : e).slice(0, 120)}` };
  } finally {
    try {
      db?.close();
    } catch {
      // 关库失败不影响只读结果（临时副本随即删除）
    }
  }
}

// ============================================================
// 入口：searchChromeHistory（多 profile 合并 + 临时目录生命周期）
// ============================================================

export async function searchChromeHistory(
  q: ChromeHistoryQuery,
  deps: ChromeHistoryDeps = {},
): Promise<InteractResult<ChromeHistoryData>> {
  const platform = deps.platform ?? process.platform;
  const chromeRoot = deps.chromeRoot ?? defaultChromeRoot();
  const tmpBase = deps.tmpRoot ?? tmpdir();
  const notReady = (error: string, data: ChromeHistoryData | null = null): InteractResult<ChromeHistoryData> => ({
    outcome: "didnt",
    data,
    served_by: "search_local",
    fallback_used: false,
    retrieval_method: "chrome_history_sqlite",
    error,
  });

  // ---------- 平面守卫（诚实 didnt，不伪装空结果） ----------
  if (platform !== "darwin") {
    return notReady("chrome_history_darwin_only");
  }

  // ---------- profile 发现 ----------
  let profiles = listHistoryProfiles(chromeRoot);
  if (q.profile) {
    if (!profiles.includes(q.profile)) {
      return notReady(`profile_not_found:${q.profile}`);
    }
    profiles = [q.profile];
  }
  if (profiles.length === 0) {
    return notReady("chrome_history_not_found");
  }

  // ---------- node:sqlite 可用性（Node 20/21 诚实降级） ----------
  let opener: SqliteOpener;
  try {
    opener = deps.loadOpener ? await deps.loadOpener() : await loadDefaultOpener();
  } catch {
    return notReady("node_sqlite_unavailable");
  }

  // ---------- 复制快照 → 查 → finally 删（唯一写面；INV-81(a) 白名单） ----------
  // mkdtempSync 随机后缀 == parse24 §5.2 的 lasso-search-local-<uuid> 语义
  //（OS 级随机目录名，物理上不可能撞进源路径）。
  const tmpDir = mkdtempSync(join(tmpBase, "lasso-search-local-"));
  const profilesSkipped: Array<{ profile: string; reason: string }> = [];
  const allHits: ChromeHistoryHit[] = [];
  const profilesSearched: string[] = [];
  try {
    for (const profile of profiles) {
      const src = join(chromeRoot, profile, "History");
      const snapshot = join(tmpDir, `${profile.replace(/[^A-Za-z0-9_. -]/g, "_")}.History`);
      try {
        copyFileSync(src, snapshot); // 读源 → 写临时副本（源零写）
      } catch (e) {
        profilesSkipped.push({
          profile,
          reason: `history_copy_failed:${String(e instanceof Error ? e.message : e).slice(0, 120)}`,
        });
        continue;
      }
      const outcome = queryProfileHistory(snapshot, profile, q, opener);
      if (outcome.skipReason) {
        profilesSkipped.push({ profile, reason: outcome.skipReason });
        continue;
      }
      profilesSearched.push(profile);
      allHits.push(...(outcome.hits ?? []));
    }
  } finally {
    // 只删 mkdtemp 出来的临时目录本身（recursive+force：幂等，不抛）
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // ---------- 诚实出口 ----------
  if (profilesSearched.length === 0) {
    return {
      outcome: "didnt",
      data: {
        source: "history",
        count: 0,
        profiles_searched: [],
        profiles_skipped: profilesSkipped,
        results: [],
      },
      served_by: "search_local",
      fallback_used: false,
      retrieval_method: "chrome_history_sqlite",
      error: "all_profiles_unreadable",
    };
  }

  // 多 profile 合并：按 visited_at（数值时间）降序再截 limit
  allHits.sort((a, b) => (b.visited_at ?? "").localeCompare(a.visited_at ?? ""));
  const results = allHits.slice(0, q.limit);

  logger.info({
    evt: "search_local_history_done",
    query_len: q.query.length,
    profiles: profilesSearched.length,
    skipped: profilesSkipped.length,
    hits: results.length,
  });

  if (results.length === 0) {
    // 查了、没有 —— didnt + no_matches（data 保留 profiles_searched 供 CC 分辨）
    return {
      outcome: "didnt",
      data: {
        source: "history",
        count: 0,
        profiles_searched: profilesSearched,
        profiles_skipped: profilesSkipped,
        results: [],
      },
      served_by: "search_local",
      fallback_used: false,
      retrieval_method: "chrome_history_sqlite",
      error: "no_matches",
    };
  }

  return {
    outcome: "worked",
    data: {
      source: "history",
      count: results.length,
      profiles_searched: profilesSearched,
      profiles_skipped: profilesSkipped,
      results,
    },
    served_by: "search_local",
    fallback_used: false,
    retrieval_method: "chrome_history_sqlite",
  };
}

// ============================================================
// 导出诊断面（只读元数据；doctor/测试可安全调用；不读 urls 内容）
// ============================================================
/** 源库文件存在性 + 大小（bytes）——只 stat，不开库 */
export function chromeHistoryStat(
  deps: Pick<ChromeHistoryDeps, "chromeRoot"> = {},
): Array<{ profile: string; bytes: number }> {
  const root = deps.chromeRoot ?? defaultChromeRoot();
  return listHistoryProfiles(root).flatMap((p) => {
    try {
      return [{ profile: p, bytes: statSync(join(root, p, "History")).size }];
    } catch {
      return [];
    }
  });
}
