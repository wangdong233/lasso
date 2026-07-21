/**
 * forest-root-registry.spec.ts（parse5 §5.1 + §6.1 #2/#3）
 *
 * 守护 RootRegistry 的核心契约：
 *  1. nextRootRefIndex 单计数器（@p/@w 共享；@p0/@w1/@p2/@w3 交替递增）
 *  2. identity 复用：同 identity 二次 getOrCreate → 返回同 ref（不分配新计数器）
 *  3. lookup 返 RootInfo + 不存在的 ref 返 undefined
 *  4. list 排序：@pN 在前 @wN 在后；同前缀按 N 升序
 *  5. evictStale 淘汰过期 ref
 *
 * INV-24：RootRegistry 单一真源（grep 断言在 check-invariants.mjs）。
 */
import { describe, it, expect } from "vitest";
import { RootRegistry, compareRootInfo } from "../../src/forest/RootRegistry.js";
import type { RootIdentity, RootInfo } from "../../src/forest/forest-types.js";

// ============================================================
// helpers
// ============================================================
function makeIdent(s: string, kind: "browser_page" | "window" = "browser_page"): RootIdentity {
  return { kind, identity: s };
}

function makeFactory(source: string) {
  return (kind: "browser_page" | "window", newRef: string): RootInfo => ({
    rootRef: newRef,
    kind,
    title: `${source}-${newRef}`,
    source,
  });
}

// ============================================================
// 单计数器（核心契约，parse5 §3.1.2 + §6.1 #2）
// ============================================================
describe("RootRegistry — nextRootRefIndex 单计数器（@p/@w 共享）", () => {
  it("交替 kind 递增：@p0 → @w1 → @p2 → @w3", async () => {
    const r = new RootRegistry();
    const factory = makeFactory("s");
    const p0 = await r.getOrCreate(makeIdent("a", "browser_page"), factory);
    const w1 = await r.getOrCreate(makeIdent("b", "window"), factory);
    const p2 = await r.getOrCreate(makeIdent("c", "browser_page"), factory);
    const w3 = await r.getOrCreate(makeIdent("d", "window"), factory);
    expect(p0).toBe("@p0");
    expect(w1).toBe("@w1");
    expect(p2).toBe("@p2");
    expect(w3).toBe("@w3");
    expect(r.getNextRootRefIndexForTest()).toBe(4);
  });

  it("同 kind 连续分配：@p0 → @p1 → @p2", async () => {
    const r = new RootRegistry();
    const factory = makeFactory("s");
    const p0 = await r.getOrCreate(makeIdent("a"), factory);
    const p1 = await r.getOrCreate(makeIdent("b"), factory);
    const p2 = await r.getOrCreate(makeIdent("c"), factory);
    expect([p0, p1, p2]).toEqual(["@p0", "@p1", "@p2"]);
  });

  it("全 desktop：@w0 → @w1 → @w2", async () => {
    const r = new RootRegistry();
    const factory = makeFactory("s");
    const w0 = await r.getOrCreate(makeIdent("a", "window"), factory);
    const w1 = await r.getOrCreate(makeIdent("b", "window"), factory);
    const w2 = await r.getOrCreate(makeIdent("c", "window"), factory);
    expect([w0, w1, w2]).toEqual(["@w0", "@w1", "@w2"]);
  });
});

// ============================================================
// identity 复用（parse5 §3.1.2 + §6.1 #3）
// ============================================================
describe("RootRegistry — identity 复用（同 identity → 同 ref）", () => {
  it("同 identity 二次 getOrCreate → 返回同 ref（计数器不递增）", async () => {
    const r = new RootRegistry();
    const factory = makeFactory("s");
    const first = await r.getOrCreate(makeIdent("same-url"), factory);
    const second = await r.getOrCreate(makeIdent("same-url"), factory);
    expect(first).toBe(second);
    expect(r.getNextRootRefIndexForTest()).toBe(1); // 只分配一次
    expect(r.size).toBe(1);
  });

  it("不同 identity → 不同 ref", async () => {
    const r = new RootRegistry();
    const factory = makeFactory("s");
    const a = await r.getOrCreate(makeIdent("a"), factory);
    const b = await r.getOrCreate(makeIdent("b"), factory);
    expect(a).not.toBe(b);
    expect(r.size).toBe(2);
  });

  it("同 url 不同 channel：identity 同 → ref 同（接受 V1 边界）", async () => {
    // parse5 §4.1 V1：cdpContextId 不可得时 identity 退化为 sha1(url)
    // 同 url 在 headless + logged_in 都开 → 都命中同 identity → 复用 ref
    // 这是接受的 trade-off（M0.4a 不阻断）
    const r = new RootRegistry();
    const f1 = makeFactory("browse_headless");
    const f2 = makeFactory("browse_logged_in");
    const a = await r.getOrCreate(makeIdent("url-x"), f1);
    const b = await r.getOrCreate(makeIdent("url-x"), f2);
    expect(a).toBe(b);
    // source 字段是首次 factory 写入的（headless）—— 接受
    expect(r.lookup(a)?.source).toBe("browse_headless");
  });

  it("kind 不同但 identity 字符串撞 → 仍复用（identity 是唯一 key）", async () => {
    // 极端边界：identity 哈希撞 + kind 不同。实际 channel 不会构造此 case
    // （channel 自己保证 identity 唯一性），但 RootRegistry 行为应确定。
    const r = new RootRegistry();
    const factory = makeFactory("s");
    const a = await r.getOrCreate(
      { kind: "browser_page", identity: "x" },
      factory,
    );
    const b = await r.getOrCreate(
      { kind: "window", identity: "x" },
      factory,
    );
    expect(a).toBe(b);
  });
});

// ============================================================
// lookup（反查）
// ============================================================
describe("RootRegistry — lookup", () => {
  it("已注册的 ref → 返 RootInfo", async () => {
    const r = new RootRegistry();
    const ref = await r.getOrCreate(
      makeIdent("a"),
      (kind, newRef) => ({
        rootRef: newRef,
        kind,
        title: "test",
        source: "browse_headless",
      }),
    );
    const info = r.lookup(ref);
    expect(info).toBeDefined();
    expect(info?.rootRef).toBe(ref);
    expect(info?.source).toBe("browse_headless");
  });

  it("未注册的 ref → undefined", () => {
    const r = new RootRegistry();
    expect(r.lookup("@p999")).toBeUndefined();
    expect(r.lookup("@w999")).toBeUndefined();
    expect(r.lookup("garbage")).toBeUndefined();
  });

  it("未知前缀 ref → undefined（不抛异常）", () => {
    const r = new RootRegistry();
    expect(r.lookup("@x0")).toBeUndefined();
  });
});

// ============================================================
// list（排序，parse5 §3.1.2）
// ============================================================
describe("RootRegistry — list 排序", () => {
  it("空 registry → 空数组", () => {
    const r = new RootRegistry();
    expect(r.list()).toEqual([]);
  });

  it("@pN 在前 @wN 在后；同前缀按 N 升序", async () => {
    const r = new RootRegistry();
    const factory = makeFactory("s");
    // 故意以乱序 kind 注册：window / page / page / window / page
    await r.getOrCreate(makeIdent("a", "window"), factory); // @w0
    await r.getOrCreate(makeIdent("b", "browser_page"), factory); // @p1
    await r.getOrCreate(makeIdent("c", "browser_page"), factory); // @p2
    await r.getOrCreate(makeIdent("d", "window"), factory); // @w3
    await r.getOrCreate(makeIdent("e", "browser_page"), factory); // @p4
    const refs = r.list().map((info) => info.rootRef);
    // 排序：@p1 @p2 @p4 在前（按 N 升序）；@w0 @w3 在后
    expect(refs).toEqual(["@p1", "@p2", "@p4", "@w0", "@w3"]);
  });

  it("按 kind 过滤：只返 browser_page", async () => {
    const r = new RootRegistry();
    const factory = makeFactory("s");
    await r.getOrCreate(makeIdent("a", "browser_page"), factory);
    await r.getOrCreate(makeIdent("b", "window"), factory);
    await r.getOrCreate(makeIdent("c", "browser_page"), factory);
    const pages = r.list({ kind: "browser_page" });
    expect(pages.length).toBe(2);
    expect(pages.every((info) => info.kind === "browser_page")).toBe(true);
    const windows = r.list({ kind: "window" });
    expect(windows.length).toBe(1);
    expect(windows[0].kind).toBe("window");
  });
});

// ============================================================
// compareRootInfo（排序函数导出）
// ============================================================
describe("compareRootInfo（排序函数）", () => {
  const mk = (ref: string): RootInfo => ({
    rootRef: ref,
    kind: ref.startsWith("@p") ? "browser_page" : "window",
    title: ref,
    source: "s",
  });

  it("@p 在 @w 之前", () => {
    expect(compareRootInfo(mk("@p5"), mk("@w0"))).toBeLessThan(0);
    expect(compareRootInfo(mk("@w0"), mk("@p5"))).toBeGreaterThan(0);
  });

  it("同前缀按 N 升序", () => {
    expect(compareRootInfo(mk("@p2"), mk("@p10"))).toBeLessThan(0);
    expect(compareRootInfo(mk("@p10"), mk("@p2"))).toBeGreaterThan(0);
    expect(compareRootInfo(mk("@w3"), mk("@w100"))).toBeLessThan(0);
  });

  it("同 ref → 0", () => {
    expect(compareRootInfo(mk("@p5"), mk("@p5"))).toBe(0);
  });
});

// ============================================================
// evictStale（LRU 淘汰）
// ============================================================
describe("RootRegistry — evictStale", () => {
  it("刚注册的 root 不被淘汰（maxAge=30min 默认）", async () => {
    const r = new RootRegistry();
    const factory = makeFactory("s");
    await r.getOrCreate(makeIdent("a"), factory);
    const evicted = r.evictStale();
    expect(evicted).toEqual([]);
    expect(r.size).toBe(1);
  });

  it("过期 root 被淘汰", async () => {
    const r = new RootRegistry();
    const factory = makeFactory("s");
    await r.getOrCreate(makeIdent("a"), factory);
    // maxAge=-1 → 任何 lastTouchedAt 都视为过期（now - lastTouchedAt ≥ 0 > -1）
    const evicted = r.evictStale(-1);
    expect(evicted.length).toBe(1);
    expect(r.size).toBe(0);
  });
});

// ============================================================
// 容量守护
// ============================================================
describe("RootRegistry — 容量守护", () => {
  it("超 maxRoots 自动淘汰最老", async () => {
    const r = new RootRegistry(3); // 容量 3
    const factory = makeFactory("s");
    await r.getOrCreate(makeIdent("a"), factory); // @p0
    await r.getOrCreate(makeIdent("b"), factory); // @p1
    await r.getOrCreate(makeIdent("c"), factory); // @p2
    expect(r.size).toBe(3);
    // 第 4 个触发淘汰（最老 = @p0）
    await r.getOrCreate(makeIdent("d"), factory); // @p3
    expect(r.size).toBe(3);
    expect(r.lookup("@p0")).toBeUndefined();
    expect(r.lookup("@p3")).toBeDefined();
  });
});
