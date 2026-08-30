/**
 * search-local.spec.ts（v1.17 Phase D / B1 第四通道，doc/governance/06 裁决④ + parse24 §5）
 *
 * 守护面：
 *  1. Chrome History 源：临时 fixture db（真 node:sqlite 造库）→ 多 profile 合并
 *     排序截断 / LIKE 转义（% 通配注入）/ ASCII 大小写 / CJK 连续命中 / URL-only 命中
 *     / 0 命中诚实 didnt / profile 过滤 / 损坏库诚实跳过 / 临时目录清理
 *  2. tri-state 退化：非 darwin / 无 Chrome / node:sqlite 不可用 / 意外异常 unknown
 *  3. mdfind 源：execFn 注入 mock → 去重截断 / mtime / 非零退 / 0 行 / stat 失败省略
 *  4. notes：deferred 诚实 didnt（notes_deferred_v2）
 *  5. 隐私红线（INV-81 的测试面镜像）：
 *     - 命中字段白名单（无 content 全文）
 *     - 日志只记 query_len（spy stderr，查询原文零泄漏）
 *  6. MCP 装配：tools/list 含 search_local + callTool 往返 + limit>50 zod 拒绝
 *  7. 四处联动（grep 级，防 read_text D1「写好没装配」bug 类）
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  searchChromeHistory,
  chromeTimeToIso,
  escapeLikePattern,
  listHistoryProfiles,
  type SqliteOpener,
} from "../../src/search-local/chrome-history.js";
import { searchMdfind } from "../../src/search-local/mdfind.js";
import {
  doSearchLocal,
  registerSearchLocalTool,
} from "../../src/search-local/register-search-local-tool.js";

// node:sqlite 经 createRequire 取（vite 对 node:sqlite 动态 import 解析有坑；
// 与 src/search-local/chrome-history.ts loadDefaultOpener 同款手法，同真源）
const nodeRequire = createRequire(import.meta.url);
// CI-node20 修正：node:sqlite 于 Node 22.5+ 才存在——顶层裸 require 在 node20 直接
// 炸整个文件。守卫加载 + HAS_NODE_SQLITE 门（缺模块时跳过依赖 fixture db 的组，
// 纯函数/mdfind/装配组不依赖它，仍应跑）。
let DatabaseSync: (new (path: string, options?: { readOnly?: boolean }) => unknown) | null = null;
try {
  ({ DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => unknown;
  });
} catch {
  DatabaseSync = null;
}
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
// node:sqlite 稳定线：v23.4 起去旗标（22.x 能 require 但实验态 API 不完备——
// CI 实测 22 败 18 过混合，readOnly/open 行为漂移）。require 成功≠可用。
const HAS_NODE_SQLITE = DatabaseSync !== null && NODE_MAJOR >= 23;
// 整文件门控（CI 修正二轮）：node:sqlite 是实验模块——CI 矩阵 node20 无此模块、
// node22.x 需 --experimental-sqlite 旗标（不塞 CI 免脆弱）。缺它时 fixture db 造不出，
// 全组连带假失败，故整文件跳过；本地 node ≥ 23.4/24 稳定态承担全量覆盖。
const describeOrSkip = HAS_NODE_SQLITE ? describe : describe.skip;

const REPO_ROOT = join(__dirname, "..", "..");

// ============================================================
// fixture 工具（真 node:sqlite 造 Chrome History 形状的库）
// ============================================================

/** Unix ISO → Chrome 1601 纪元微秒（与 chromeTimeToIso 互逆） */
function isoToChromeUs(iso: string): number {
  return (Date.parse(iso) / 1000 + 11_644_473_600) * 1e6;
}

interface HistoryRow {
  url: string;
  title: string;
  t: string; // ISO
}

const SCRATCH: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(d);
  return d;
}
afterAll(() => {
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true });
});

async function makeChromeRoot(profiles: Array<{ name: string; rows: HistoryRow[] }>): Promise<string> {
  const root = scratchDir("lasso-sl-chrome-");
  for (const p of profiles) {
    const dir = join(root, p.name);
    mkdirSync(dir, { recursive: true });
    const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(join(dir, "History")) as {
      exec: (sql: string) => void;
      prepare: (sql: string) => { run: (...a: unknown[]) => unknown };
      close: () => void;
    };
    db.exec(
      "CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, " +
        "title TEXT NOT NULL, visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0, " +
        "last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0)",
    );
    const ins = db.prepare(
      "INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)",
    );
    // BigInt 绑定：Chrome 时间戳 ~1.33e16 超 MAX_SAFE_INTEGER——与真库同量级工况
    for (const r of p.rows) ins.run(r.url, r.title, BigInt(Math.round(isoToChromeUs(r.t))));
    db.close();
  }
  return root;
}

function makeTmpRoot(): string {
  return scratchDir("lasso-sl-tmp-");
}

// 两个 profile 的标准 fixture 数据（时间交错，验合并排序）
const T1 = "2026-08-10T08:00:00.000Z";
const T2 = "2026-08-12T09:30:00.000Z";
const T3 = "2026-08-15T10:00:00.000Z";
const T4 = "2026-08-16T11:20:00.000Z";
const T5 = "2026-08-17T12:45:00.000Z";

async function standardFixture() {
  const chromeRoot = await makeChromeRoot([
    {
      name: "Default",
      rows: [
        { url: "https://example.com/lasso-intro", title: "lasso-mcp 介绍", t: T2 },
        { url: "https://example.com/lasso-docs", title: "lasso docs", t: T4 },
        { url: "https://example.com/unrelated", title: "别的页面", t: T5 },
      ],
    },
    {
      name: "Profile 1",
      rows: [
        { url: "https://example.com/lasso-github", title: "lasso-mcp GitHub", t: T1 },
        { url: "https://example.com/lasso-blog", title: "架构设计与 lasso", t: T3 },
        { url: "https://example.com/lasso-newest", title: "lasso 最新发布", t: T5 },
      ],
    },
  ]);
  return { chromeRoot, tmpRoot: makeTmpRoot() };
}

// ============================================================
// 纯函数：时间换算 / LIKE 转义
// ============================================================
describeOrSkip("search_local / chrome-history 纯函数", () => {
  it("chromeTimeToIso 与 isoToChromeUs 互逆（1601 纪元微秒 → ISO）", () => {
    expect(chromeTimeToIso(isoToChromeUs("2026-08-17T00:00:00.000Z"))).toBe("2026-08-17T00:00:00.000Z");
    // 真实样本量级：1.32e16 微秒 ≈ 2019-04（Chrome 时间戳超 MAX_SAFE_INTEGER 的实况）
    expect(chromeTimeToIso(13200000000000000n)).toMatch(/^2019-04-17T/);
  });

  it("chromeTimeToIso：0 / 非法 / 负 Unix 时间 → undefined（不 throw）", () => {
    expect(chromeTimeToIso(0)).toBeUndefined();
    expect(chromeTimeToIso(-5)).toBeUndefined();
    expect(chromeTimeToIso(Number.NaN)).toBeUndefined();
  });

  it("escapeLikePattern：\\ % _ 三元字符转义（配 ESCAPE '\\' 子句防通配注入）", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("c\\d")).toBe("c\\\\d");
    expect(escapeLikePattern("plain")).toBe("plain");
  });
});

// ============================================================
// Chrome History 源（真 node:sqlite fixture）
// ============================================================
describeOrSkip("search_local / history 源（fixture db；node<22.5 无 node:sqlite 跳过）", () => {
  it("多 profile 合并：两库命中按 visited_at 降序、profiles_searched 双库齐", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    const r = await searchChromeHistory({ query: "lasso", limit: 10 }, { chromeRoot, tmpRoot });
    expect(r.outcome).toBe("worked");
    expect(r.data?.source).toBe("history");
    expect(r.data?.profiles_searched.sort()).toEqual(["Default", "Profile 1"]);
    expect(r.data?.count).toBe(5);
    const times = r.data!.results.map((h) => h.visited_at);
    expect(times).toEqual([T5, T4, T3, T2, T1]); // 全局降序（跨 profile 合并）
    expect(r.served_by).toBe("search_local");
    expect(r.retrieval_method).toBe("chrome_history_sqlite");
  });

  it("limit 截断：5 命中 limit=2 → 只留最新 2 条", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    const r = await searchChromeHistory({ query: "lasso", limit: 2 }, { chromeRoot, tmpRoot });
    expect(r.data?.count).toBe(2);
    expect(r.data?.results.map((h) => h.visited_at)).toEqual([T5, T4]);
  });

  it("ASCII LIKE 大小写不敏感：query 大写命中小写 title", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    const r = await searchChromeHistory({ query: "LASSO", limit: 10 }, { chromeRoot, tmpRoot });
    expect(r.outcome).toBe("worked");
    expect(r.data?.count).toBe(5);
  });

  it("CJK 连续子串命中：query「架构」命中含「架构」的 title", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    const r = await searchChromeHistory({ query: "架构", limit: 10 }, { chromeRoot, tmpRoot });
    expect(r.outcome).toBe("worked");
    expect(r.data?.count).toBe(1);
    expect(r.data?.results[0]?.title).toBe("架构设计与 lasso");
  });

  it("LIKE 转义：query '100%' 只命中字面 100%（100x 不命中——% 未当通配符）", async () => {
    const chromeRoot = await makeChromeRoot([
      {
        name: "Default",
        rows: [
          { url: "https://e.com/a", title: "profit 100% done", t: T1 },
          { url: "https://e.com/b", title: "profit 100x done", t: T2 },
        ],
      },
    ]);
    const r = await searchChromeHistory({ query: "100%", limit: 10 }, { chromeRoot, tmpRoot: makeTmpRoot() });
    expect(r.outcome).toBe("worked");
    expect(r.data?.count).toBe(1);
    expect(r.data?.results[0]?.title).toBe("profit 100% done");
  });

  it("URL-only 命中：title 空、url 含 query → 返回且无 snippet", async () => {
    const chromeRoot = await makeChromeRoot([
      { name: "Default", rows: [{ url: "https://specialhost.io/deep/path", title: "", t: T1 }] },
    ]);
    const r = await searchChromeHistory({ query: "specialhost", limit: 10 }, { chromeRoot, tmpRoot: makeTmpRoot() });
    expect(r.outcome).toBe("worked");
    expect(r.data?.results[0]?.url).toBe("https://specialhost.io/deep/path");
    expect(r.data?.results[0]?.title).toBeUndefined();
    expect(r.data?.results[0]?.snippet).toBeUndefined();
  });

  it("0 命中 → 诚实 didnt + no_matches（profiles_searched 非空供 CC 分辨「查了没有」）", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    const r = await searchChromeHistory({ query: "zzz-not-there", limit: 10 }, { chromeRoot, tmpRoot });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("no_matches");
    expect(r.data?.count).toBe(0);
    expect(r.data?.profiles_searched.length).toBe(2);
  });

  it("profile 过滤：只查指定 profile；未知 profile → didnt + profile_not_found", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    const r = await searchChromeHistory({ query: "lasso", limit: 10, profile: "Profile 1" }, { chromeRoot, tmpRoot });
    expect(r.outcome).toBe("worked");
    expect(r.data?.profiles_searched).toEqual(["Profile 1"]);
    expect(r.data?.results.every((h) => h.profile === "Profile 1")).toBe(true);

    const bad = await searchChromeHistory({ query: "lasso", limit: 10, profile: "Nope" }, { chromeRoot, tmpRoot });
    expect(bad.outcome).toBe("didnt");
    expect(bad.error).toBe("profile_not_found:Nope");
  });

  it("无 Chrome 目录 → didnt + chrome_history_not_found（不伪装空结果）", async () => {
    const empty = scratchDir("lasso-sl-empty-");
    const r = await searchChromeHistory({ query: "x", limit: 10 }, { chromeRoot: empty });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("chrome_history_not_found");
  });

  it("非 darwin → didnt + chrome_history_darwin_only", async () => {
    const { chromeRoot } = await standardFixture();
    const r = await searchChromeHistory({ query: "x", limit: 10 }, { chromeRoot, platform: "win32" });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("chrome_history_darwin_only");
  });

  it("node:sqlite 不可用（Node 20/21 工况）→ didnt + node_sqlite_unavailable", async () => {
    const { chromeRoot } = await standardFixture();
    const r = await searchChromeHistory(
      { query: "x", limit: 10 },
      { chromeRoot, loadOpener: () => Promise.reject(new Error("module not found")) },
    );
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("node_sqlite_unavailable");
  });

  it("损坏库诚实跳过：一库垃圾字节、一库正常 → worked + profiles_skipped 记原因", async () => {
    const chromeRoot = await makeChromeRoot([
      { name: "Default", rows: [{ url: "https://ok.com/lasso", title: "lasso ok", t: T1 }] },
    ]);
    // 造第二个带 History 文件但非 SQLite 的 profile
    mkdirSync(join(chromeRoot, "Profile 1"), { recursive: true });
    writeFileSync(join(chromeRoot, "Profile 1", "History"), Buffer.from("this is not a sqlite database at all"));
    const r = await searchChromeHistory({ query: "lasso", limit: 10 }, { chromeRoot, tmpRoot: makeTmpRoot() });
    expect(r.outcome).toBe("worked");
    expect(r.data?.profiles_searched).toEqual(["Default"]);
    expect(r.data?.profiles_skipped.length).toBe(1);
    expect(r.data?.profiles_skipped[0]?.profile).toBe("Profile 1");
    expect(r.data?.profiles_skipped[0]?.reason).toMatch(/^history_db_error:/);
  });

  it("全库损坏 → didnt + all_profiles_unreadable", async () => {
    const chromeRoot = scratchDir("lasso-sl-corrupt-");
    mkdirSync(join(chromeRoot, "Default"), { recursive: true });
    writeFileSync(join(chromeRoot, "Default", "History"), Buffer.from("garbage"));
    const r = await searchChromeHistory({ query: "x", limit: 10 }, { chromeRoot, tmpRoot: makeTmpRoot() });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("all_profiles_unreadable");
  });

  it("临时目录生命周期：查完 finally 删除（tmpRoot 无 lasso-search-local-* 残留）", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    await searchChromeHistory({ query: "lasso", limit: 10 }, { chromeRoot, tmpRoot });
    const leftovers = readdirSync(tmpRoot).filter((n) => n.startsWith("lasso-search-local-"));
    expect(leftovers).toEqual([]);
  });

  it("隐私字段白名单：命中对象只有 profile/title/url/visited_at/snippet —— 无 content 全文", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    const r = await searchChromeHistory({ query: "lasso", limit: 10 }, { chromeRoot, tmpRoot });
    const allowed = new Set(["profile", "title", "url", "visited_at", "snippet"]);
    for (const hit of r.data!.results) {
      for (const key of Object.keys(hit)) expect(allowed.has(key)).toBe(true);
    }
    expect(JSON.stringify(r.data)).not.toContain('"content"');
  });

  it("snippet ≤200 字符窗口且来自 title 文本", async () => {
    const longTitle = `${"前".repeat(50)}lasso${"后".repeat(300)}`;
    const chromeRoot = await makeChromeRoot([
      { name: "Default", rows: [{ url: "https://e.com/long", title: longTitle, t: T1 }] },
    ]);
    const r = await searchChromeHistory({ query: "lasso", limit: 10 }, { chromeRoot, tmpRoot: makeTmpRoot() });
    const snip = r.data?.results[0]?.snippet;
    expect(snip).toBeTruthy();
    expect(snip!.length).toBeLessThanOrEqual(202); // 200 窗口 + 省略号
    expect(snip).toContain("lasso");
  });

  it("listHistoryProfiles：只列带 History 文件的目录（排除无 History 的杂目录）", async () => {
    const root = scratchDir("lasso-sl-profiles-");
    mkdirSync(join(root, "Default"), { recursive: true });
    writeFileSync(join(root, "Default", "History"), Buffer.from("x"));
    mkdirSync(join(root, "Crashpad"), { recursive: true });
    expect(listHistoryProfiles(root)).toEqual(["Default"]);
  });

  it("真 node:sqlite opener：readOnly 打开（写语句被 SQLite 拒绝——源库只读语义）", async () => {
    const chromeRoot = await makeChromeRoot([
      { name: "Default", rows: [{ url: "https://e.com/a", title: "t", t: T1 }] },
    ]);
    const opener: SqliteOpener = (p) =>
      new (DatabaseSync as NonNullable<typeof DatabaseSync>)(p, { readOnly: true }) as unknown as {
        prepare: (sql: string) => { run: (...a: unknown[]) => unknown };
        close: () => void;
      };
    const dbPath = join(chromeRoot, "Default", "History");
    let threw = false;
    try {
      opener(dbPath).prepare("INSERT INTO urls (url, title, last_visit_time) VALUES ('x','y',1)").run();
    } catch {
      threw = true; // readOnly 模式下 INSERT 被拒
    }
    expect(threw).toBe(true);
  });
});

// ============================================================
// mdfind 源
// ============================================================
describeOrSkip("search_local / files 源（mdfind）", () => {
  it("命中解析：去空行 + 去重 + 截 limit；modified_at 来自 stat mtime", async () => {
    const dir = scratchDir("lasso-sl-files-");
    const f1 = join(dir, "a.pdf");
    const f2 = join(dir, "b.md");
    writeFileSync(f1, "x");
    writeFileSync(f2, "y");
    const r = searchMdfind(
      { query: "invoice", limit: 2 },
      { execFn: () => ({ status: 0, stdout: `${f1}\n${f2}\n\n${f1}\n${dir}/c.pdf\n` }) },
    );
    expect(r.outcome).toBe("worked");
    expect(r.data?.source).toBe("files");
    expect(r.data?.count).toBe(2); // 去重后 3 条，limit=2 截断
    expect(r.data?.results.map((h) => h.path)).toEqual([f1, f2]);
    expect(r.data?.results[0]?.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.retrieval_method).toBe("spotlight_mdfind");
  });

  it("mdfind 非零退 → didnt + mdfind_exit_*", () => {
    const r = searchMdfind({ query: "x", limit: 5 }, { execFn: () => ({ status: 1, stdout: "" }) });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("mdfind_exit_1");
  });

  it("0 行输出 → didnt + no_matches（诚实，不 worked 空数组）", () => {
    const r = searchMdfind({ query: "x", limit: 5 }, { execFn: () => ({ status: 0, stdout: "\n\n" }) });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("no_matches");
  });

  it("非 darwin → didnt + mdfind_darwin_only", () => {
    const r = searchMdfind({ query: "x", limit: 5 }, { platform: "linux", execFn: () => ({ status: 0, stdout: "p" }) });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("mdfind_darwin_only");
  });

  it("stat 失败 → 条目保留、modified_at 省略（不吞条目不伪装时间）", () => {
    const r = searchMdfind(
      { query: "x", limit: 5 },
      {
        execFn: () => ({ status: 0, stdout: "/gone/file.txt\n" }),
        statFn: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(r.outcome).toBe("worked");
    expect(r.data?.results[0]).toEqual({ path: "/gone/file.txt" });
  });

  it("隐私字段白名单：文件命中只有 path/modified_at —— 无内容读取", () => {
    const r = searchMdfind(
      { query: "x", limit: 5 },
      { execFn: () => ({ status: 0, stdout: "/a/b.txt\n" }) },
    );
    const allowed = new Set(["path", "modified_at"]);
    for (const hit of r.data!.results) {
      for (const key of Object.keys(hit)) expect(allowed.has(key)).toBe(true);
    }
  });
});

// ============================================================
// doSearchLocal 分发 + notes deferred
// ============================================================
describeOrSkip("search_local / doSearchLocal 分发", () => {
  it("source=notes → 诚实 didnt + notes_deferred_v2（enum 可见但未开放）", async () => {
    const r = await doSearchLocal({ query: "x", limit: 10, source: "notes" });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("notes_deferred_v2");
    expect(r.retrieval_method).toBe("notes_deferred_v2");
  });

  it("source=files → 走 mdfind（deps 注入透传）", async () => {
    const r = await doSearchLocal(
      { query: "x", limit: 5, source: "files" },
      { files: { execFn: () => ({ status: 0, stdout: "/f.txt\n" }) } },
    );
    expect(r.outcome).toBe("worked");
    expect(r.data?.source).toBe("files");
  });

  it("意外异常 → unknown（tri-state：unknown 仅意外）", async () => {
    // mkdtempSync 在不存在的 tmpRoot 上抛 ENOENT —— searchChromeHistory 不吞该路径
    //（chromeRoot 用 fixture 保 profile 发现成功——跨机器确定性）
    const { chromeRoot } = await standardFixture();
    const r = await doSearchLocal(
      { query: "x", limit: 5, source: "history" },
      { history: { chromeRoot, tmpRoot: join(tmpdir(), "lasso-sl-definitely-missing-xyz") } },
    );
    expect(r.outcome).toBe("unknown");
    expect(r.error).toMatch(/^unexpected:/);
  });

  it("日志隐私：stderr 只记 query_len，查询原文零泄漏（INV-81(e) 测试面）", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      const r = await doSearchLocal(
        { query: "ZZSECRETQUERY", limit: 5, source: "history" },
        { history: { chromeRoot, tmpRoot } },
      );
      expect(r.outcome).toBe("didnt"); // fixture 无此词 → no_matches（同时覆盖 0 命中日志路径）
    } finally {
      console.error = orig;
    }
    const logLines = lines.filter((l) => l.includes("search_local"));
    expect(logLines.length).toBeGreaterThanOrEqual(1);
    expect(logLines.some((l) => l.includes("query_len"))).toBe(true);
    for (const l of logLines) expect(l.includes("ZZSECRETQUERY")).toBe(false);
  });
});

// ============================================================
// MCP 装配往返
// ============================================================
async function startLocalServer(deps?: Parameters<typeof registerSearchLocalTool>[1]) {
  const server = new McpServer({ name: "lasso-test", version: "0.1.0-test" });
  registerSearchLocalTool(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    shutdown: async () => {
      await client.close();
      await server.close();
    },
  };
}

describeOrSkip("search_local / MCP 装配", () => {
  it("tools/list 含 search_local（注册生效）", async () => {
    const { client, shutdown } = await startLocalServer();
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain("search_local");
    } finally {
      await shutdown();
    }
  });

  it("callTool notes → didnt + notes_deferred_v2 JSON payload", async () => {
    const { client, shutdown } = await startLocalServer();
    try {
      const resp = (await client.callTool({
        name: "search_local",
        arguments: { query: "x", source: "notes" },
      })) as { content: Array<{ type: string; text: string }> };
      const payload = JSON.parse(resp.content[0]!.text) as { outcome: string; error?: string };
      expect(payload.outcome).toBe("didnt");
      expect(payload.error).toBe("notes_deferred_v2");
    } finally {
      await shutdown();
    }
  });

  it("callTool history（deps 注入 fixture）→ worked 且往返形状完整", async () => {
    const { chromeRoot, tmpRoot } = await standardFixture();
    const { client, shutdown } = await startLocalServer({ history: { chromeRoot, tmpRoot } });
    try {
      const resp = (await client.callTool({
        name: "search_local",
        arguments: { query: "架构", limit: 5 },
      })) as { content: Array<{ type: string; text: string }> };
      const payload = JSON.parse(resp.content[0]!.text) as {
        outcome: string;
        data: { count: number; results: Array<{ title?: string }> };
      };
      expect(payload.outcome).toBe("worked");
      expect(payload.data.count).toBe(1);
      expect(payload.data.results[0]?.title).toBe("架构设计与 lasso");
    } finally {
      await shutdown();
    }
  });

  it("limit 51 被 zod 拒绝（硬顶 50 = INV-81(c) 的传输面证据）", async () => {
    const { client, shutdown } = await startLocalServer();
    try {
      const resp = (await client.callTool({
        name: "search_local",
        arguments: { query: "x", limit: 51 },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      // SDK 1.30 实测形态：zod 校验失败 → isError:true + 错误文本（不 throw）
      expect(resp.isError).toBe(true);
      expect(resp.content[0]?.text).toMatch(/less than or equal to 50|validation/i);
    } finally {
      await shutdown();
    }
  });
});

// ============================================================
// 四处联动（grep 级镜像，防「写好没装配」；INV-81(f) 测试面）
// ============================================================
describeOrSkip("search_local / 四处联动装配", () => {
  const indexSrc = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");
  const descSrc = readFileSync(join(REPO_ROOT, "src", "tools", "descriptions.ts"), "utf8");
  const annoSrc = readFileSync(join(REPO_ROOT, "src", "tools", "annotations.ts"), "utf8");
  const regSrc = readFileSync(join(REPO_ROOT, "src", "search-local", "register-search-local-tool.ts"), "utf8");

  it("index.ts：import + registerSearchLocalTool(server) 调用", () => {
    expect(indexSrc).toContain('from "./search-local/register-search-local-tool.js"');
    expect(indexSrc).toMatch(/registerSearchLocalTool\(server/);
  });

  it("index.ts：V5_TOOL_TO_CHANNEL 含 search_local 项（ToolManager caller-tier 隔离）", () => {
    expect(indexSrc).toMatch(/search_local:\s*"search_local"/);
  });

  it("descriptions.ts：SEARCH_LOCAL_DESCRIPTION 导出且含 notes_deferred_v2（CC 可见诚实）", () => {
    expect(descSrc).toContain("SEARCH_LOCAL_DESCRIPTION");
    expect(descSrc).toContain("notes_deferred_v2");
  });

  it("annotations.ts：searchLocalAnnotations 只读 + 非 openWorld（纯本地档）", () => {
    expect(annoSrc).toContain("searchLocalAnnotations");
    const block = annoSrc.match(/export const searchLocalAnnotations[\s\S]*?\};/)?.[0] ?? "";
    expect(block).toContain("readOnlyHint: true");
    expect(block).toContain("openWorldHint: false");
  });

  it("注册器：server.tool(\"search_local\") 且 schema limit 硬顶 50", () => {
    expect(regSrc).toMatch(/server\.tool\(\s*\n?\s*"search_local"/);
    expect(regSrc).toMatch(/limit\s*:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\(50\)/);
  });
});
