/**
 * ContentSecondHop 单元测（v1.17 Phase C / A2′ 自研第二跳，parse24 §3.3 + §3.4）。
 *
 * 覆盖面（parse24 §3.4 测试定案逐条）：
 *  - 裁剪黄金用例：CJK bigram / 拉丁词项 / 导语保留 / 长度归一 / cap3
 *  - mock fetch 四态：200 HTML / 403 / 超时 / 非 HTML（+ 3xx 未跟随 / extract 态）
 *  - 并发 3 断言（in-flight 峰值 ≤ 3）
 *  - 256KB 两段式字节闸（CL 预检拒 + 流式截断 truncated）
 *  - wall-clock 预算跳过（now() 注入确定性断言：未开始的条目 fetch_failed）
 *  - tri-state 诚实：部分/全失败标注 + 主 outcome/served_by/quality 不变
 *  - 纯函数性：enrich 不改写入参（cache 零污染）
 *  - 缺省关（content_blocks 未传）的 byte-identical 基线在集成测
 *    search-content-blocks.spec.ts 钉（工具层）
 */
import { describe, it, expect, vi } from "vitest";
import {
  tokenizeQuery,
  scoreParagraph,
  scoreAndTrim,
  fetchContentBlocks,
  enrichWithContentBlocks,
  SCORE_CAP_PER_TERM,
  LEDE_KEEP_CHARS,
  CONTENT_HOP_DEFAULTS,
} from "../../src/search/ContentSecondHop.js";
import type {
  ContentSecondHopDeps,
  ContentBlockOutcome,
} from "../../src/search/ContentSecondHop.js";
import type { InteractResult, SearchResult } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
function item(url: string): { title: string; url: string; snippet: string } {
  return { title: `t-${url}`, url, snippet: "s" };
}

/** 真 Response 构造（Node 24 内建；body 流式 → readBodyCapped 走真路径）。 */
function htmlResponse(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

/** 固定假抽取器（隔离 defuddle；markdown 可控做裁剪断言）。 */
const fakeExtract = async (_html: string) => ({
  markdown:
    "# Title\n\nAlpha paragraph mentions wasm runtime.\n\nBeta paragraph about gardening.\n\nGamma also mentions wasm briefly.",
});

function workedResult(urls: string[]): InteractResult<SearchResult> {
  return {
    outcome: "worked",
    data: {
      query: "wasm",
      results: urls.map((u) => ({ title: `t-${u}`, url: u, snippet: "s" })),
      count: urls.length,
      engine: "machine_mcp",
      region: "cn",
    },
    served_by: "search.machine_mcp",
    fallback_used: false,
    retrieval_method: "machine_mcp_api",
    quality: "api",
  };
}

// ============================================================
// §3.3 查询分词（tokenizeQuery）
// ============================================================
describe("tokenizeQuery（parse24 §3.3 分词定案）", () => {
  it("拉丁：空白切分 + lowercase + 去重", () => {
    expect(tokenizeQuery("Rust async rust  WASM")).toEqual(["rust", "async", "wasm"]);
  });

  it("CJK：连续段两两 bigram（「架构思想」→ 架构/构思/思想）", () => {
    expect(tokenizeQuery("架构思想")).toEqual(["架构", "构思", "思想"]);
  });

  it("CJK 孤立单字回退 unigram", () => {
    expect(tokenizeQuery("图")).toEqual(["图"]);
  });

  it("混合 token 按码位切段分别产出（MCP架构 → mcp + 架构）", () => {
    expect(tokenizeQuery("MCP架构")).toEqual(["mcp", "架构"]);
  });

  it("多词混合：CJK 词与拉丁词并存", () => {
    expect(tokenizeQuery("wasm 运行时")).toEqual(["wasm", "运行", "行时"]);
  });
});

// ============================================================
// §3.3 打分（scoreParagraph：cap3 + 长度归一）
// ============================================================
describe("scoreParagraph（cap3 + 长度归一）", () => {
  it("单词项命中超过 SCORE_CAP_PER_TERM 按 cap 计（10 次命中只计 3）", () => {
    const para = "rust rust rust rust rust rust rust rust rust rust"; // 10 hits, len 49
    const capped = scoreParagraph(para, ["rust"]);
    expect(capped).toBeCloseTo(SCORE_CAP_PER_TERM / Math.sqrt(49), 10);
  });

  it("长度归一：短段 1 命中 > 长段 3 命中（cap 后 1/2 > 3/sqrt(50)）", () => {
    expect(scoreParagraph("rust", ["rust"])).toBe(0.5);
    expect(scoreParagraph("rust", ["rust"])).toBeGreaterThan(
      scoreParagraph(
        "rust rust rust rust rust rust rust rust rust rust",
        ["rust"],
      ),
    );
  });

  it("零命中 / 空段 → 0", () => {
    expect(scoreParagraph("nothing here", ["rust"])).toBe(0);
    expect(scoreParagraph("", ["rust"])).toBe(0);
  });
});

// ============================================================
// §3.3 裁剪（scoreAndTrim 黄金用例）
// ============================================================
describe("scoreAndTrim（保留策略黄金用例）", () => {
  it("导语定律：正文前 LEDE_KEEP_CHARS 字符覆盖的段落无条件保留（零命中也留）", () => {
    const lede = "Lede without any query term.";
    const body = Array.from(
      { length: 5 },
      (_, i) => `Body ${i} mentions wasm target paragraph.`,
    ).join("\n\n");
    // 预算只够导语 + 一段：导语必留
    const r = scoreAndTrim(`${lede}\n\n${body}`, "wasm", lede.length + 36);
    expect(r.content.startsWith(lede)).toBe(true);
  });

  it("cap3 判别用例：10 命中长段被 cap 压分，1 命中短段胜出入选", () => {
    // 导语段 = 210 字符（≥ LEDE_KEEP_CHARS=200）→ 后续段不享受导语豁免
    const lede = "L".repeat(210);
    const a = "rust rust rust rust rust rust rust rust rust rust"; // 50 chars, 10 hits → capped 3/sqrt(50)≈0.42
    const b = "rust"; // 4 chars, 1 hit → 0.5（cap 后反超）
    // 文档序：A 在前 B 在后；预算 214 = lede(210) + b(4)：B 恰好入选、A 被裁
    const doc = `${lede}\n\n${a}\n\n${b}`;
    const r = scoreAndTrim(doc, "rust", 214);
    expect(r.content).toBe(`${lede}\n\nrust`); // B 入选、A 被裁（cap3 生效；输出文档序）
    expect(r.truncated).toBe(true);
  });

  it("预算充足：全段收录 → truncated=false 且 content 等于原文块拼接", () => {
    const doc = "Para one about wasm.\n\nPara two.\n\nPara three.";
    const r = scoreAndTrim(doc, "wasm", 10_000);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe(doc);
  });

  it("输出按文档序（分数序只决定收录，不重排段落）", () => {
    const doc = "first para plain.\n\nsecond mentions wasm strongly wasm.\n\nthird plain.";
    const r = scoreAndTrim(doc, "wasm", 10_000);
    expect(r.content).toBe(doc);
  });

  it("空 markdown → content 空 + truncated=false", () => {
    expect(scoreAndTrim("", "x", 100)).toEqual({ content: "", truncated: false });
    expect(scoreAndTrim("\n\n  \n\n", "x", 100)).toEqual({
      content: "",
      truncated: false,
    });
  });

  it("LEDE_KEEP_CHARS 常量 = 200（parse24 §3.3 定案值）", () => {
    expect(LEDE_KEEP_CHARS).toBe(200);
  });
});

// ============================================================
// fetchContentBlocks（mock fetch 四态 + 护栏）
// ============================================================
describe("fetchContentBlocks（mock fetch 态机）", () => {
  it("200 HTML → ok + content（真 Response 流式 body 路径）", async () => {
    const fetchImpl = vi.fn(async () =>
      htmlResponse("<html><body><article><p>Alpha mentions wasm.</p></article></body></html>"),
    );
    const deps: ContentSecondHopDeps = { fetchImpl, extractImpl: fakeExtract };
    const out = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      1,
      {},
      deps,
    );
    expect(out[0]!.content_status).toBe("ok");
    expect(out[0]!.content).toContain("wasm");
    expect(out[0]!.truncated).toBeUndefined(); // 小页无裁剪
  });

  it("403 → fetch_failed，无 content 字段", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } }),
    );
    const out = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      1,
      {},
      { fetchImpl, extractImpl: fakeExtract },
    );
    expect(out[0]).toEqual({ content_status: "fetch_failed" });
  });

  it("3xx → 不跟随（SSRF 红线）→ fetch_failed", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.test/x", "content-type": "text/html" },
      }),
    );
    const out = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      1,
      {},
      { fetchImpl, extractImpl: fakeExtract },
    );
    expect(out[0]).toEqual({ content_status: "fetch_failed" });
  });

  it("超时（AbortController 5s 硬超时；测试收 30ms）→ fetch_failed", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("This operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    ) as unknown as typeof fetch;
    const out = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      1,
      { timeoutMs: 30 },
      { fetchImpl, extractImpl: fakeExtract },
    );
    expect(out[0]).toEqual({ content_status: "fetch_failed" });
  });

  it("非 HTML（application/json）→ not_html", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"a":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const out = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      1,
      {},
      { fetchImpl, extractImpl: fakeExtract },
    );
    expect(out[0]).toEqual({ content_status: "not_html" });
  });

  it("抽取器 throw → extract_failed；空 markdown → extract_failed", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("boom");
    });
    const out1 = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      1,
      {},
      { fetchImpl: async () => htmlResponse("<html></html>"), extractImpl: throwing },
    );
    expect(out1[0]).toEqual({ content_status: "extract_failed" });

    const out2 = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      1,
      {},
      {
        fetchImpl: async () => htmlResponse("<html></html>"),
        extractImpl: async () => ({ markdown: "   " }),
      },
    );
    expect(out2[0]).toEqual({ content_status: "extract_failed" });
  });

  it("SSRF：私网 IP（127.0.0.2，loopback 但不在 DEFAULT_ALLOW 的 /32 逃生口）→ fetch_failed 且 fetch 未被调", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("<html></html>"));
    const out = await fetchContentBlocks(
      [item("http://127.0.0.2/secret")],
      "wasm",
      1,
      {},
      { fetchImpl, extractImpl: fakeExtract, ssrfConfig: { allowRanges: [], denyRanges: [] } },
    );
    expect(out[0]).toEqual({ content_status: "fetch_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("256KB 两段式之一：content-length 预检超限 → fetch_failed（不下载 body）", async () => {
    const fetchImpl = vi.fn(async () =>
      htmlResponse("<html><body>x</body></html>", {
        "content-length": String(256 * 1024 + 1),
      }),
    );
    const out = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      1,
      { maxBytes: 256 * 1024 },
      { fetchImpl, extractImpl: fakeExtract },
    );
    expect(out[0]).toEqual({ content_status: "fetch_failed" });
  });

  it("256KB 两段式之二：无 CL 但流式 body 超 cap → 截断后仍抽取 + truncated=true", async () => {
    const bigHtml = `<html><body><article><p>${"wasm ".repeat(200)}</p></article></body></html>`;
    expect(bigHtml.length).toBeGreaterThan(200); // 超 maxBytes=120
    const fetchImpl = vi.fn(async () =>
      new Response(bigHtml, {
        status: 200,
        headers: { "content-type": "text/html" }, // 不设 CL → 走流式闸
      }),
    );
    // spy 抽取器：断言拿到的输入确被截断到 cap 字节内
    const spyExtract = vi.fn(async (htmlIn: string) => ({
      markdown: `trimmed page (${htmlIn.length} chars) about wasm`,
    }));
    const out = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      1,
      { maxBytes: 120 },
      { fetchImpl, extractImpl: spyExtract },
    );
    expect(out[0]!.content_status).toBe("ok");
    expect(out[0]!.truncated).toBe(true); // 字节级截断的诚实标注
    expect(spyExtract).toHaveBeenCalledTimes(1);
    expect(spyExtract.mock.calls[0]![0].length).toBeLessThanOrEqual(120);
  });

  it("并发 3：5 条慢 fetch，in-flight 峰值 = 3（自实现池）", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return htmlResponse("<html><body><p>wasm</p></body></html>");
    }) as unknown as typeof fetch;
    const urls = Array.from({ length: 5 }, (_, i) => `https://127.0.0.1/${i}`);
    const out = await fetchContentBlocks(
      urls.map((u) => item(u)),
      "wasm",
      5,
      { timeoutMs: 2_000 },
      { fetchImpl, extractImpl: fakeExtract },
    );
    expect(peak).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(out.every((o) => o!.content_status === "ok")).toBe(true);
  });

  it("wall-clock 预算：超时未开始的条目如实 fetch_failed 且不进网络（now 注入确定性）", async () => {
    let calls = 0;
    const now = () => (++calls <= 2 ? 0 : 10_000); // start=0；worker1 首查=0 过，其后全部 10000
    const fetchImpl = vi.fn(async () => htmlResponse("<html><body><p>wasm</p></body></html>"));
    const urls = Array.from({ length: 5 }, (_, i) => `https://127.0.0.1/${i}`);
    const out = await fetchContentBlocks(
      urls.map((u) => item(u)),
      "wasm",
      5,
      { budgetMs: 5_000, timeoutMs: 2_000 },
      { fetchImpl, extractImpl: fakeExtract, now },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 只有 item0 进网络
    expect(out[0]!.content_status).toBe("ok");
    expect(out.slice(1).every((o) => o!.content_status === "fetch_failed")).toBe(true);
  });

  it("N 超过 results 长度 → 全量尝试，返回与入参等长", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("<html><body><p>wasm</p></body></html>"));
    const out = await fetchContentBlocks(
      [item("https://127.0.0.1/1")],
      "wasm",
      5, // > 1
      {},
      { fetchImpl, extractImpl: fakeExtract },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content_status).toBe("ok");
  });

  it("topN=0 → 全 null（零网络）", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("<html></html>"));
    const out = await fetchContentBlocks([item("https://127.0.0.1/1")], "wasm", 0, {}, { fetchImpl });
    expect(out).toEqual([null]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ============================================================
// enrichWithContentBlocks（信封级 tri-state 诚实 + 纯函数性）
// ============================================================
describe("enrichWithContentBlocks（tri-state 诚实 + cache 零污染）", () => {
  it("部分失败：失败条目保留蓝链字段 + content_status，主信封逐字节不动", async () => {
    const input = workedResult(["https://127.0.0.1/ok", "https://127.0.0.1/bad"]);
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes("/bad")) {
        return new Response("nope", { status: 403, headers: { "content-type": "text/html" } });
      }
      return htmlResponse("<html><body><p>wasm alpha</p></body></html>");
    }) as unknown as typeof fetch;
    const out = await enrichWithContentBlocks(input, "wasm", 2, {}, {
      fetchImpl,
      extractImpl: fakeExtract,
    });
    // 主信封不动（tri-state 诚实红线：enrichment 不是 fallback）
    expect(out.outcome).toBe("worked");
    expect(out.served_by).toBe("search.machine_mcp");
    expect(out.quality).toBe("api");
    expect(out.fallback_used).toBe(false);
    expect(out.retrieval_method).toBe("machine_mcp_api");
    // 条目级：成功条 ok + content；失败条保留蓝链 + fetch_failed、无 content
    expect(out.data!.results[0]!.content_status).toBe("ok");
    expect(typeof out.data!.results[0]!.content).toBe("string");
    expect(out.data!.results[1]!.title).toBe("t-https://127.0.0.1/bad");
    expect(out.data!.results[1]!.url).toBe("https://127.0.0.1/bad");
    expect(out.data!.results[1]!.snippet).toBe("s");
    expect(out.data!.results[1]!.content_status).toBe("fetch_failed");
    expect(out.data!.results[1]!.content).toBeUndefined();
  });

  it("全失败：所有条目 fetch_failed，主 outcome 仍 worked（不伪装不吞）", async () => {
    const input = workedResult(["https://127.0.0.1/1", "https://127.0.0.1/2"]);
    const fetchImpl = vi.fn(async () =>
      new Response("no", { status: 503, headers: { "content-type": "text/html" } }),
    );
    const out = await enrichWithContentBlocks(input, "wasm", 2, {}, {
      fetchImpl,
      extractImpl: fakeExtract,
    });
    expect(out.outcome).toBe("worked");
    expect(out.data!.results.every((r) => r.content_status === "fetch_failed")).toBe(true);
    expect(out.data!.count).toBe(2); // 蓝链计数不动
  });

  it("非 worked（didnt）→ 原样返回，零网络", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse("<html></html>"));
    const input: InteractResult<SearchResult> = {
      outcome: "didnt",
      data: null,
      served_by: "none",
      fallback_used: false,
      retrieval_method: "free_only_filtered",
    };
    const out = await enrichWithContentBlocks(input, "wasm", 3, {}, { fetchImpl });
    expect(out).toBe(input);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("纯函数性：入参对象树不被改写（cache 写入对象零污染）", async () => {
    const input = workedResult(["https://127.0.0.1/1"]);
    const snapshot = JSON.parse(JSON.stringify(input));
    const fetchImpl = vi.fn(async () => htmlResponse("<html><body><p>wasm</p></body></html>"));
    await enrichWithContentBlocks(input, "wasm", 1, {}, {
      fetchImpl,
      extractImpl: fakeExtract,
    });
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it("top N 之外的条目原对象保留（不带增强字段）", async () => {
    const input = workedResult(["https://127.0.0.1/1", "https://127.0.0.1/2", "https://127.0.0.1/3"]);
    const fetchImpl = vi.fn(async () => htmlResponse("<html><body><p>wasm</p></body></html>"));
    const out = await enrichWithContentBlocks(input, "wasm", 2, {}, {
      fetchImpl,
      extractImpl: fakeExtract,
    });
    expect(out.data!.results[0]!.content_status).toBe("ok");
    expect(out.data!.results[1]!.content_status).toBe("ok");
    expect(out.data!.results[2]).toEqual({
      title: "t-https://127.0.0.1/3",
      url: "https://127.0.0.1/3",
      snippet: "s",
    }); // 无 content/content_status/truncated 键
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("缺省护栏常量 = parse24 §3.2 定案值（5s / 256KB / 15s / 并发3 / 6k）", () => {
    expect(CONTENT_HOP_DEFAULTS.timeoutMs).toBe(5_000);
    expect(CONTENT_HOP_DEFAULTS.maxBytes).toBe(256 * 1024);
    expect(CONTENT_HOP_DEFAULTS.budgetMs).toBe(15_000);
    expect(CONTENT_HOP_DEFAULTS.concurrency).toBe(3);
    expect(CONTENT_HOP_DEFAULTS.budgetChars).toBe(6_000);
  });
});

// ============================================================
// 类型形状静态断言（ContentBlockOutcome 只有三字段——四态输出轴）
// ============================================================
describe("ContentBlockOutcome 形状", () => {
  it("ok 态字段集合 ⊆ {content_status, content, truncated}", () => {
    const o: ContentBlockOutcome = { content_status: "ok", content: "x", truncated: true };
    expect(Object.keys(o).sort()).toEqual(["content", "content_status", "truncated"]);
  });
  it("失败态字段集合 = {content_status}（无 content 伪装）", () => {
    const o: ContentBlockOutcome = { content_status: "fetch_failed" };
    expect(Object.keys(o)).toEqual(["content_status"]);
  });
});
