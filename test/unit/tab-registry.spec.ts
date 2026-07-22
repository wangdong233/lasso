/**
 * TabRegistry v0.8 单测（parse9 §3.3 + §5.1）
 *
 * 覆盖（mock McpClient.callTool，不连真 Chrome）：
 *  - LRU ≤10 hard cap：15 url reconcile 后 size=10、最老 5 个 close_page 被调
 *  - MRU 提升：再触达老 url 不被淘汰
 *  - cap clamp [1, 20]：构造 -1 → 1；999 → 20
 *  - reconcile 返 reaped / kept 字段
 *  - close_page 抛错不阻断（已自然关闭的 tab 静默从 Map 删）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TabRegistry,
  TAB_CAP_DEFAULT,
} from "../../src/logged-in/TabRegistry.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

// ============================================================
// helpers
// ============================================================
/**
 * 造一个 stub McpClient：list_pages 返给定 url 列表；close_page 记录调用。
 */
function makeStubClient(urls: string[]): {
  client: McpClient;
  closedUrls: string[];
  setUrls: (u: string[]) => void;
} {
  let currentUrls = urls;
  const closedUrls: string[] = [];
  const client = {
    callTool: vi.fn(async (method: string, params: any) => {
      if (method === "list_pages") {
        const text = currentUrls
          .map((u, i) => `Tab ${i + 1}: ${u} (active)`)
          .join("\n");
        return { content: [{ type: "text", text }] };
      }
      if (method === "close_page") {
        closedUrls.push(params?.url);
        // 模拟 Chrome 关 tab 后 list 不再含此 url
        currentUrls = currentUrls.filter((u) => u !== params?.url);
        return { content: [{ type: "text", text: "closed" }] };
      }
      return {};
    }),
  } as unknown as McpClient;
  return {
    client,
    closedUrls,
    setUrls: (u: string[]) => {
      currentUrls = u;
    },
  };
}

beforeEach(() => {
  // 各 test 自建 stub client
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
    const r = new TabRegistry(-1);
    expect(r.getCap()).toBe(1);
  });

  it("cap = 0 → clamp 到 1", () => {
    const r = new TabRegistry(0);
    expect(r.getCap()).toBe(1);
  });

  it("cap = 999 → clamp 到 20", () => {
    const r = new TabRegistry(999);
    expect(r.getCap()).toBe(20);
  });

  it("cap = 5 → 保留 5", () => {
    const r = new TabRegistry(5);
    expect(r.getCap()).toBe(5);
  });

  it("cap = 15.7 → trunc 到 15（整数化）", () => {
    const r = new TabRegistry(15.7);
    expect(r.getCap()).toBe(15);
  });
});

// ============================================================
// reconcile — LRU 淘汰
// ============================================================
describe("TabRegistry — reconcile LRU 淘汰", () => {
  it("15 url reconcile（cap=10）→ size=10、最老 5 个 close_page 被调", async () => {
    const urls = Array.from({ length: 15 }, (_, i) => `https://example.com/page${i}`);
    const { client, closedUrls } = makeStubClient(urls);
    const r = new TabRegistry(10);
    const result = await r.reconcile(client);
    expect(r.size()).toBe(10);
    expect(result.kept).toBe(10);
    expect(result.reaped).toHaveLength(5);
    expect(closedUrls).toHaveLength(5);
    // 最老 5 个被淘汰（page0..page4）
    expect(closedUrls.sort()).toEqual(
      Array.from({ length: 5 }, (_, i) => `https://example.com/page${i}`).sort(),
    );
  });

  it("≤ cap 不淘汰（5 url cap=10）", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://example.com/p${i}`);
    const { client, closedUrls } = makeStubClient(urls);
    const r = new TabRegistry(10);
    const result = await r.reconcile(client);
    expect(r.size()).toBe(5);
    expect(result.reaped).toHaveLength(0);
    expect(closedUrls).toHaveLength(0);
  });

  it("close_page 抛错不阻断（已自然关闭的 tab 静默从 Map 删）", async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://x.com/p${i}`);
    const closedUrls: string[] = [];
    const client = {
      callTool: vi.fn(async (method: string, params: any) => {
        if (method === "list_pages") {
          return {
            content: [
              { type: "text", text: urls.map((u) => u).join("\n") },
            ],
          };
        }
        if (method === "close_page") {
          // 模拟 tab 已关闭 → close_page 抛错
          if (params?.url.endsWith("p0") || params?.url.endsWith("p1")) {
            throw new Error("no_such_page");
          }
          closedUrls.push(params?.url);
          return {};
        }
        return {};
      }),
    } as unknown as McpClient;
    const r = new TabRegistry(10);
    const result = await r.reconcile(client);
    expect(r.size()).toBe(10);
    expect(result.reaped).toHaveLength(2); // 仍统计为 reaped（即使 close 抛错）
  });
});

// ============================================================
// reconcile — MRU 提升
// ============================================================
describe("TabRegistry — MRU 提升", () => {
  it("再触达老 url → 老 url 不被淘汰（提到 MRU）", async () => {
    // 第一轮：12 个 url，cap=10 → 淘汰最老 2 个（p0/p1）
    const urls1 = Array.from({ length: 12 }, (_, i) => `https://x.com/p${i}`);
    const { client, closedUrls, setUrls } = makeStubClient(urls1);
    const r = new TabRegistry(10);
    await r.reconcile(client);
    expect(r.size()).toBe(10);
    // 验证 p0 / p1 被淘汰
    expect(closedUrls).toContain("https://x.com/p0");

    // 第二轮：list_pages 顺序决定触达顺序。
    //   关键：把 p2 放在已存在 url 的【最后】→ p2 最后被触达 → 提到 MRU 端。
    //   再加 2 个新 url（new1/new2）→ size=12，cap=10 → 淘汰最老 2 个（应为 p3/p4）。
    //   若无 MRU 提升，p2 是最老（首位）会被淘汰；提升后 p2 处 MRU 不被淘汰。
    closedUrls.length = 0;
    setUrls([
      // 已存在 9 个先被触达（顺序旋转后回到原位）
      ...Array.from({ length: 9 }, (_, i) => `https://x.com/p${i + 3}`), // p3..p11
      "https://x.com/p2", // 最后被触达 → 提到 MRU
      "https://x.com/new1", // 新增（最 MRU）
      "https://x.com/new2", // 新增
    ]);
    await r.reconcile(client);
    // p2 应仍在 registry（因 MRU 提升）
    expect(r._hasForTests("https://x.com/p2")).toBe(true);
    // 淘汰的应是 p3/p4（被 p2 的 MRU 提升挤到 LRU 端的两个）
    expect(closedUrls.sort()).toEqual(["https://x.com/p3", "https://x.com/p4"]);
  });

  it("同 url 多次触达 → size 不重复计", async () => {
    const { client } = makeStubClient([
      "https://same.com/",
      "https://same.com/",
      "https://same.com/",
    ]);
    const r = new TabRegistry(10);
    await r.reconcile(client);
    // 同 url 哈希一致 → 只占 1 槽
    expect(r.size()).toBe(1);
  });
});

// ============================================================
// reconcile — 返回值字段
// ============================================================
describe("TabRegistry — reconcile 返回值", () => {
  it("返回 { reaped, kept } 形状正确", async () => {
    const { client } = makeStubClient(["https://a.com", "https://b.com"]);
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
  it("_touchForTests + _hasForTests（不经 list_pages）", () => {
    const r = new TabRegistry(10);
    r._touchForTests("https://touched.com");
    expect(r._hasForTests("https://touched.com")).toBe(true);
    expect(r._hasForTests("https://other.com")).toBe(false);
  });
});
