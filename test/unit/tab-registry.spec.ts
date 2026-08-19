/**
 * TabRegistry 单测（parse9 §3.3 + §5.1；v1.17.3 doc/27 S-10 契约重订）
 *
 * 覆盖（mock McpClient.callTool，不连真 Chrome；list_pages 桩用**真实上游 1.7.0
 * 文本格式** `## Pages` / `<id>: <title> (<url>) [selected]`，兼作 parser 覆盖）：
 *  - cap clamp [1, 20]：构造 -1 → 1；999 → 20
 *  - 所有权边界（S-10 核心）：只有 `[selected]` 页入册；无 selected 标记的用户 tab
 *    永不入册、close_page 永不被调
 *  - close_page 契约（S-10）：wire 形态 = { pageId: number }（非 { url }）
 *  - LRU ≤10 hard cap + MRU 提升 + 陈旧修剪（自然关闭的页移出册）
 *  - 列表不可解析 → 保守 no-op（reaped 空、不 close）
 *  - reconcile 返 reaped / kept 字段
 *  - parseUpstreamPageEntries：真实格式样例（含 Note 行 / 无 title 形态 / 扩展页段）
 */
import { describe, it, expect, vi } from "vitest";
import {
  TabRegistry,
  TAB_CAP_DEFAULT,
  parseUpstreamPageEntries,
} from "../../src/logged-in/TabRegistry.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

// ============================================================
// helpers
// ============================================================
/** 上游 1.7.0 list_pages 页行（`<id>: <title> (<url>)` + 可选 ` [selected]`）。 */
function pageLine(
  pageId: number,
  url: string,
  opts: { selected?: boolean; title?: string } = {},
): string {
  const title = opts.title ?? `Tab ${pageId}`;
  const sel = opts.selected ? " [selected]" : "";
  return `${pageId}: ${title} (${url})${sel}`;
}

/**
 * 造一个 stub McpClient：list_pages 返给定行列表；close_page 记录 wire 调用形。
 */
function makeStubClient(lines: string[]): {
  client: McpClient;
  closeCalls: Array<Record<string, unknown>>;
  setLines: (l: string[]) => void;
} {
  let current = lines;
  const closeCalls: Array<Record<string, unknown>> = [];
  const client = {
    callTool: vi.fn(async (method: string, params: any) => {
      if (method === "list_pages") {
        return { content: [{ type: "text", text: current.join("\n") }] };
      }
      if (method === "close_page") {
        closeCalls.push(params);
        // 模拟 Chrome 关 tab 后 list 不再含此页
        current = current.filter(
          (l) => !l.startsWith(`${params?.pageId}:`),
        );
        return { content: [{ type: "text", text: "closed" }] };
      }
      return {};
    }),
  } as unknown as McpClient;
  return { client, closeCalls, setLines: (l) => (current = l) };
}

// ============================================================
// parseUpstreamPageEntries —— 真实 1.7.0 文本格式
// ============================================================
describe("parseUpstreamPageEntries —— 1.7.0 list_pages 文本解析", () => {
  it("标准格式（## Pages 段 + title (url) + [selected] 标记）", () => {
    const text = [
      "## Pages",
      "1: Example Domain (https://example.com/) [selected]",
      "2: News (https://news.ycombinator.com/)",
    ].join("\n");
    const r = parseUpstreamPageEntries(text);
    expect(r).toEqual([
      { pageId: 1, url: "https://example.com/", selected: true },
      { pageId: 2, url: "https://news.ycombinator.com/", selected: false },
    ]);
  });

  it("title 自带括号 → url 取最后一个 scheme 括号组", () => {
    const r = parseUpstreamPageEntries(
      "3: Foo (bar) (https://x.com/a?q=1) [selected]",
    );
    expect(r).toEqual([
      { pageId: 3, url: "https://x.com/a?q=1", selected: true },
    ]);
  });

  it("无 title 形态（about:blank 裸 url）+ Note 行 + 扩展页段共存", () => {
    const text = [
      "Note: the previously selected page was closed. Page 2 is now selected.",
      "## Pages",
      "2: about:blank",
      "## Extension Pages",
      "5: Service worker (chrome-extension://abc/background.js)",
    ].join("\n");
    const r = parseUpstreamPageEntries(text);
    expect(r).toEqual([
      { pageId: 2, url: "about:blank", selected: false },
      { pageId: 5, url: "chrome-extension://abc/background.js", selected: false },
    ]);
  });

  it("空文本 / 无页行 → null（调用方保守降级）", () => {
    expect(parseUpstreamPageEntries("")).toBeNull();
    expect(parseUpstreamPageEntries("## Pages")).toBeNull();
    expect(parseUpstreamPageEntries("no ids here")).toBeNull();
  });
});

// ============================================================
// cap clamp [1, 20]
// ============================================================
describe("TabRegistry — cap clamp [1, 20]", () => {
  it("默认 cap = TAB_CAP_DEFAULT = 10", () => {
    const r = new TabRegistry();
    expect(r.getCap()).toBe(10);
    expect(TAB_CAP_DEFAULT).toBe(10);
  });

  it("cap = -1 → clamp 到 1", () => {
    expect(new TabRegistry(-1).getCap()).toBe(1);
  });

  it("cap = 0 → clamp 到 1", () => {
    expect(new TabRegistry(0).getCap()).toBe(1);
  });

  it("cap = 999 → clamp 到 20", () => {
    expect(new TabRegistry(999).getCap()).toBe(20);
  });

  it("cap = 5 → 保留 5；cap = 15.7 → trunc 到 15", () => {
    expect(new TabRegistry(5).getCap()).toBe(5);
    expect(new TabRegistry(15.7).getCap()).toBe(15);
  });
});

// ============================================================
// reconcile — S-10 所有权边界（核心：noteOwnPage 登记制）
// ============================================================
describe("TabRegistry — S-10 所有权边界（只认已登记 own 页）", () => {
  it("未登记页（= 用户 tab）永不入册、close_page 永不被调——即使被上游标记 selected", async () => {
    const { client, closeCalls } = makeStubClient([
      "## Pages",
      pageLine(1, "https://user.example/tab-a"),
      pageLine(2, "https://user.example/tab-b", { selected: true }), // 退化态：selected 落在用户页
      pageLine(3, "https://user.example/tab-c"),
    ]);
    const r = new TabRegistry(2); // 故意小 cap——若旧逻辑（全量入册）会触发淘汰
    const result = await r.reconcile(client);
    expect(r.size()).toBe(0); // 无登记 → 册为空
    expect(result.reaped).toHaveLength(0);
    expect(closeCalls).toHaveLength(0); // 用户 tab 一次都没碰
  });

  it("已登记 selected 页入册；同列表内未登记页不入册", async () => {
    const { client, closeCalls } = makeStubClient([
      "## Pages",
      pageLine(1, "https://user.example/tab-a"),
      pageLine(2, "https://lasso.example/work", { selected: true }),
    ]);
    const r = new TabRegistry(10);
    r.noteOwnPage(2); // ensureOwnPageSelected 创建并选中后登记
    await r.reconcile(client);
    expect(r._hasForTests(2)).toBe(true); // lasso 自建页入册
    expect(r._hasForTests(1)).toBe(false); // 用户 tab 不入册
    expect(closeCalls).toHaveLength(0);
  });

  it("resetOwnPages 后旧登记失效（上游 respawn id 重置联动：旧 id 不在新列表 → 修剪）", async () => {
    const r = new TabRegistry(10);
    // 第一代：own 页 2 在列表且 selected → 入册
    const client1 = {
      callTool: vi.fn(async () => ({
        content: [
          { type: "text", text: ["## Pages", pageLine(2, "https://lasso.example/work", { selected: true })].join("\n") },
        ],
      })),
    } as unknown as McpClient;
    r.noteOwnPage(2);
    await r.reconcile(client1);
    expect(r.size()).toBe(1);
    // respawn：登记清空 + 新列表无旧 id（上游 id 计数器重置）→ 条目被修剪
    r.resetOwnPages();
    const client2 = {
      callTool: vi.fn(async () => ({
        content: [
          { type: "text", text: ["## Pages", pageLine(1, "https://user.example/tab", { selected: true })].join("\n") },
        ],
      })),
    } as unknown as McpClient;
    await r.reconcile(client2);
    expect(r.size()).toBe(0); // 旧登记失效 + 修剪
  });

  it("列表不可解析（空响应）→ 保守 no-op（不淘汰、不 close）", async () => {
    const client = {
      callTool: vi.fn(async () => ({ content: [] })),
    } as unknown as McpClient;
    const r = new TabRegistry(10);
    r.noteOwnPage(7);
    r._touchForTests(7, "https://x.com/p7"); // 预置一个条目验证「不动册」
    const result = await r.reconcile(client);
    expect(result).toEqual({ reaped: [], kept: 1 });
    expect(r.size()).toBe(1);
  });
});

// ============================================================
// reconcile — close_page wire 契约 + LRU 淘汰 + 修剪
// ============================================================
describe("TabRegistry — close_page {pageId} 契约 + LRU", () => {
  it("超 cap → 最老 own 页按 { pageId } 关（S-10 wire 形态修复）", async () => {
    // 场景：列表恒含 11 个 own 页，selected 逐轮后移（模拟 lasso 自建页累积），
    // cap=10 → 第 11 个入册时最老 pageId=1 被淘汰
    const { client, closeCalls, setLines } = makeStubClient(["## Pages"]);
    const r = new TabRegistry(10);
    for (let i = 1; i <= 11; i++) {
      r.noteOwnPage(i);
      const lines = ["## Pages"];
      for (let j = 1; j <= 11; j++) {
        lines.push(pageLine(j, `https://x.com/p${j}`, { selected: j === i }));
      }
      setLines(lines);
      await r.reconcile(client);
    }
    expect(r.size()).toBe(10);
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]).toEqual({ pageId: 1 }); // wire 形态 = pageId（非 url）
  });

  it("已关页修剪计入 reaped（close 路径不触发）", async () => {
    const r = new TabRegistry(10);
    // 第一轮：own 页 1 在列表且 selected → 入册
    const client1 = {
      callTool: vi.fn(async (method: string) => {
        if (method === "list_pages") {
          return {
            content: [
              { type: "text", text: ["## Pages", pageLine(1, "https://x.com/p1", { selected: true })].join("\n") },
            ],
          };
        }
        return {};
      }),
    } as unknown as McpClient;
    r.noteOwnPage(1);
    await r.reconcile(client1);
    expect(r.size()).toBe(1);
    // 第二轮：own 页 1 已不在列表（自然关闭）→ 修剪移除
    const client2 = {
      callTool: vi.fn(async (method: string) => {
        if (method === "list_pages") {
          return {
            content: [
              { type: "text", text: ["## Pages", pageLine(2, "https://x.com/p2", { selected: true })].join("\n") },
            ],
          };
        }
        if (method === "close_page") throw new Error("unexpected_close");
        return {};
      }),
    } as unknown as McpClient;
    r.noteOwnPage(2);
    const result = await r.reconcile(client2);
    expect(r.size()).toBe(1);
    expect(result.reaped).toEqual(["1"]); // 修剪计入 reaped
  });

  it("close_page 抛错不阻断（已自然关闭的 tab 静默从 Map 删）", async () => {
    const closed: Array<Record<string, unknown>> = [];
    const client = {
      callTool: vi.fn(async (method: string, params: any) => {
        if (method === "list_pages") {
          const lines = ["## Pages"];
          for (let i = 1; i <= 3; i++) lines.push(pageLine(i, `https://x.com/p${i}`));
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        if (method === "close_page") {
          if (params?.pageId === 1) throw new Error("no_such_page");
          closed.push(params);
          return {};
        }
        return {};
      }),
    } as unknown as McpClient;
    // 直接构造超限态：cap=2、三个已登记条目（_touchForTests 预置）
    const r = new TabRegistry(2);
    for (let i = 1; i <= 3; i++) {
      r.noteOwnPage(i);
      r._touchForTests(i, `https://x.com/p${i}`);
    }
    const result = await r.reconcile(client);
    expect(r.size()).toBe(2);
    expect(result.reaped).toEqual(["1"]); // 仍统计为 reaped（即使 close 抛错）
    expect(closed).toHaveLength(0); // pageId=1 的 close 抛错被吞
  });

  it("MRU 提升：超 cap 前重选老 own 页 → 淘汰落在次老（非重选页）", async () => {
    // 列表恒含 11 个 own 页，selected 逐轮后移；第 10 轮后重选最老的 page1
    // （MRU 提升）→ 第 11 页入册超 cap 时淘汰 LRU 头 = page2（page1 已被提升）
    const { client, closeCalls, setLines } = makeStubClient(["## Pages"]);
    const r = new TabRegistry(10);
    const setSel = (sel: number) => {
      const lines = ["## Pages"];
      for (let j = 1; j <= 11; j++) {
        lines.push(pageLine(j, `https://x.com/p${j}`, { selected: j === sel }));
      }
      setLines(lines);
    };
    for (let i = 1; i <= 10; i++) {
      r.noteOwnPage(i);
      setSel(i);
      await r.reconcile(client);
    }
    expect(closeCalls).toHaveLength(0); // 未超 cap
    setSel(1); // 重选 page1 → MRU 提升
    await r.reconcile(client);
    r.noteOwnPage(11);
    setSel(11);
    await r.reconcile(client);
    expect(closeCalls).toEqual([{ pageId: 2 }]); // 淘汰 page2（page1 已提升）
    expect(r._hasForTests(1)).toBe(true);
  });

  it("同 pageId 多次触达 → size 不重复计", async () => {
    const { client } = makeStubClient([
      "## Pages",
      pageLine(5, "https://same.com/", { selected: true }),
    ]);
    const r = new TabRegistry(10);
    r.noteOwnPage(5);
    await r.reconcile(client);
    await r.reconcile(client);
    expect(r.size()).toBe(1);
  });
});

// ============================================================
// reconcile — 返回值字段
// ============================================================
describe("TabRegistry — reconcile 返回值", () => {
  it("返回 { reaped, kept } 形状正确", async () => {
    const { client } = makeStubClient([
      "## Pages",
      pageLine(1, "https://a.com", { selected: true }),
    ]);
    const r = new TabRegistry(10);
    const result = await r.reconcile(client);
    expect(result).toHaveProperty("reaped");
    expect(result).toHaveProperty("kept");
    expect(Array.isArray(result.reaped)).toBe(true);
    expect(typeof result.kept).toBe("number");
  });
});

// ============================================================
// _touchForTests / _hasForTests（测试辅助 API 自检）
// ============================================================
describe("TabRegistry — 测试辅助 API", () => {
  it("_touchForTests(pageId) + _hasForTests(pageId)（不经 list_pages）", () => {
    const r = new TabRegistry(10);
    r._touchForTests(42, "https://touched.com");
    expect(r._hasForTests(42)).toBe(true);
    expect(r._hasForTests(43)).toBe(false);
  });
});
