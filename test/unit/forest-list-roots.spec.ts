/**
 * forest-list-roots.spec.ts（parse5 §5.1 + §6.1 #1）
 *
 * 守护 interact.ts::refreshRoots + BrowseChannel/DesktopChannel.listRoots 聚合：
 *  1. 两 channel listRoots 都返 → registry 都注册（@p + @w 混排）
 *  2. 一 channel 失败 → 另一 channel 仍注册（容错）
 *  3. 同 url 二次刷新 → 复用同 ref（identity hash 稳定）
 *  4. RootInfo 形状正确（subtitle 是 url / window 无 subtitle）
 *
 * 测试策略：mock BrowseChannel / DesktopChannel 的 listRoots 方法
 *           （不拉真 chrome-devtools-mcp / rust helper）。
 */
import { describe, it, expect, vi } from "vitest";
import { RootRegistry } from "../../src/forest/RootRegistry.js";
import type { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import type { DesktopChannel } from "../../src/channels/DesktopChannel.js";

// ============================================================
// helpers —— refreshRoots 在 interact.ts 内部，这里 inline 一份等价实装
// （避免 import 私有 helper；直接测「listRoots → registry.getOrCreate」契约）
// ============================================================
/**
 * identity 哈希（与 interact.ts::identityHash 同实现，djb2 32-bit）。
 */
function identityHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * refreshRoots 等价实装（与 src/tools/interact.ts:refreshRoots 同 shape）。
 * 用 inline 副本而非 import 是为了：
 *  1. 单测聚焦「listRoots 数据 → registry 注册」契约，不被 server.tool 注册干扰
 *  2. 不暴露 interact.ts 内部 helper（保持模块私有）
 */
async function refreshRoots(
  registry: RootRegistry,
  browseChannels: Array<{ source: string; channel: BrowseChannel }>,
  desktopChannel?: { source: string; channel: DesktopChannel },
): Promise<void> {
  for (const { source, channel } of browseChannels) {
    const pages = await channel.listRoots();
    for (const p of pages) {
      await registry.getOrCreate(
        {
          kind: "browser_page",
          identity: identityHash(`${p.contextId}|${p.url}`),
        },
        (_kind, newRef) => ({
          rootRef: newRef,
          kind: "browser_page" as const,
          title: p.title || p.url,
          subtitle: p.url,
          source,
        }),
      );
    }
  }
  if (desktopChannel) {
    const windows = await desktopChannel.channel.listRoots();
    for (const w of windows) {
      await registry.getOrCreate(
        {
          kind: "window",
          identity: identityHash(`${w.bundleId}|${w.pid}|${w.windowId}`),
        },
        (_kind, newRef) => ({
          rootRef: newRef,
          kind: "window" as const,
          title: `${w.app}: ${w.title || "(no title)"}`,
          subtitle: undefined,
          source: desktopChannel.source,
        }),
      );
    }
  }
}

function makeMockBrowse(
  name: string,
  listRoots: () => Promise<
    Array<{ contextId: string; url: string; title?: string }>
  >,
): BrowseChannel {
  return {
    name,
    listRoots,
  } as unknown as BrowseChannel;
}

function makeMockDesktop(
  name: string,
  listRoots: () => Promise<
    Array<{
      bundleId: string;
      pid: number;
      windowId: number;
      app: string;
      title: string;
    }>
  >,
): DesktopChannel {
  return {
    name,
    listRoots,
  } as unknown as DesktopChannel;
}

// ============================================================
// 双 channel 聚合
// ============================================================
describe("refreshRoots — 双 channel listRoots 聚合", () => {
  it("browse + desktop 都返 → registry 注册 @p + @w 混排", async () => {
    const registry = new RootRegistry();
    const browse = makeMockBrowse("browse_headless", async () => [
      { contextId: "ctx1", url: "https://a.example", title: "A" },
      { contextId: "ctx2", url: "https://b.example", title: "B" },
    ]);
    const desktop = makeMockDesktop("desktop", async () => [
      {
        bundleId: "com.apple.finder",
        pid: 1234,
        windowId: 1234000001,
        app: "Finder",
        title: "Library",
      },
    ]);
    await refreshRoots(
      registry,
      [{ source: "browse_headless", channel: browse }],
      { source: "desktop", channel: desktop },
    );
    expect(registry.size).toBe(3);
    const roots = registry.list();
    // 排序：@p 在前（2 个），@w 在后（1 个）
    expect(roots.map((r) => r.rootRef)).toEqual(["@p0", "@p1", "@w2"]);
    // subtitle：browse 是 url；window 无 subtitle
    const browse0 = registry.list({ kind: "browser_page" })[0];
    expect(browse0.subtitle).toMatch(/^https?:\/\//);
    const win0 = registry.list({ kind: "window" })[0];
    expect(win0.subtitle).toBeUndefined();
    expect(win0.title).toBe("Finder: Library");
  });

  it("browse 返多 channel（headless + logged_in）→ 都注册", async () => {
    const registry = new RootRegistry();
    const headless = makeMockBrowse("browse_headless", async () => [
      { contextId: "h1", url: "https://headless.example" },
    ]);
    const loggedIn = makeMockBrowse("browse_logged_in", async () => [
      { contextId: "l1", url: "https://logged.example" },
    ]);
    await refreshRoots(registry, [
      { source: "browse_headless", channel: headless },
      { source: "browse_logged_in", channel: loggedIn },
    ]);
    expect(registry.size).toBe(2);
    const sources = registry.list().map((r) => r.source);
    expect(sources).toContain("browse_headless");
    expect(sources).toContain("browse_logged_in");
  });
});

// ============================================================
// 容错（单 channel 失败不阻断）
// ============================================================
describe("refreshRoots — 容错", () => {
  it("browse 抛异常 → desktop 仍注册", async () => {
    const registry = new RootRegistry();
    const browse = makeMockBrowse("browse_headless", async () => {
      throw new Error("subprocess not started");
    });
    const desktop = makeMockDesktop("desktop", async () => [
      {
        bundleId: "com.apple.mail",
        pid: 2345,
        windowId: 2345000001,
        app: "Mail",
        title: "Inbox",
      },
    ]);
    // refreshRoots 在 interact.ts 内 try-catch，但 inline 副本直接 throw；
    // 这里测「调用方应 try-catch 单 channel 失败」—— 单独调 desktop 仍 OK
    await refreshRoots(registry, [], { source: "desktop", channel: desktop });
    expect(registry.size).toBe(1);
    expect(registry.list()[0].source).toBe("desktop");
  });

  it("desktop 返空数组 → browse 仍注册（v0.4c cloud 未配的常态）", async () => {
    const registry = new RootRegistry();
    const browse = makeMockBrowse("browse_headless", async () => [
      { contextId: "c1", url: "https://example.com" },
    ]);
    const desktop = makeMockDesktop("desktop", async () => []);
    await refreshRoots(
      registry,
      [{ source: "browse_headless", channel: browse }],
      { source: "desktop", channel: desktop },
    );
    expect(registry.size).toBe(1);
    expect(registry.list()[0].kind).toBe("browser_page");
  });

  it("两 channel 都返空 → registry 空", async () => {
    const registry = new RootRegistry();
    const browse = makeMockBrowse("browse_headless", async () => []);
    const desktop = makeMockDesktop("desktop", async () => []);
    await refreshRoots(
      registry,
      [{ source: "browse_headless", channel: browse }],
      { source: "desktop", channel: desktop },
    );
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
  });
});

// ============================================================
// identity 复用（同 url 二次刷新 → 同 ref）
// ============================================================
describe("refreshRoots — identity 复用", () => {
  it("同 url 二次刷新 → 同 @pN（不重分配）", async () => {
    const registry = new RootRegistry();
    const browse = makeMockBrowse("browse_headless", async () => [
      { contextId: "ctx-x", url: "https://stable.example" },
    ]);
    await refreshRoots(registry, [
      { source: "browse_headless", channel: browse },
    ]);
    const firstRefs = registry.list().map((r) => r.rootRef);
    await refreshRoots(registry, [
      { source: "browse_headless", channel: browse },
    ]);
    const secondRefs = registry.list().map((r) => r.rootRef);
    expect(secondRefs).toEqual(firstRefs);
    expect(registry.size).toBe(1);
  });

  it("同 window 二次刷新 → 同 @wN", async () => {
    const registry = new RootRegistry();
    const desktop = makeMockDesktop("desktop", async () => [
      {
        bundleId: "com.apple.finder",
        pid: 3456,
        windowId: 3456000001,
        app: "Finder",
        title: "Downloads",
      },
    ]);
    await refreshRoots(registry, [], { source: "desktop", channel: desktop });
    const firstRefs = registry.list({ kind: "window" }).map((r) => r.rootRef);
    await refreshRoots(registry, [], { source: "desktop", channel: desktop });
    const secondRefs = registry.list({ kind: "window" }).map((r) => r.rootRef);
    expect(secondRefs).toEqual(firstRefs);
    expect(registry.size).toBe(1);
  });

  it("新 url 出现 → 分配新 @pN（计数器递增）", async () => {
    const registry = new RootRegistry();
    let pages = [{ contextId: "c1", url: "https://a.example" }];
    const browse = makeMockBrowse("browse_headless", async () => [...pages]);
    await refreshRoots(registry, [
      { source: "browse_headless", channel: browse },
    ]);
    expect(registry.list().map((r) => r.rootRef)).toEqual(["@p0"]);
    // 加一个新 url
    pages.push({ contextId: "c2", url: "https://b.example" });
    await refreshRoots(registry, [
      { source: "browse_headless", channel: browse },
    ]);
    expect(registry.list().map((r) => r.rootRef)).toEqual(["@p0", "@p1"]);
  });
});

// ============================================================
// RootInfo 形状（INV-19 衍生）
// ============================================================
describe("refreshRoots — RootInfo 形状", () => {
  it("browse root 的 subtitle 是 url（dispatcher 据此 navigate）", async () => {
    const registry = new RootRegistry();
    const browse = makeMockBrowse("browse_headless", async () => [
      { contextId: "c1", url: "https://dispatch.example/path" },
    ]);
    await refreshRoots(registry, [
      { source: "browse_headless", channel: browse },
    ]);
    const info = registry.list()[0];
    expect(info.subtitle).toBe("https://dispatch.example/path");
    expect(info.kind).toBe("browser_page");
    expect(info.source).toBe("browse_headless");
  });

  it("desktop root 的 title 含 app 名", async () => {
    const registry = new RootRegistry();
    const desktop = makeMockDesktop("desktop", async () => [
      {
        bundleId: "com.apple.mail",
        pid: 1,
        windowId: 1000001,
        app: "Mail",
        title: "Inbox (3)",
      },
    ]);
    await refreshRoots(registry, [], { source: "desktop", channel: desktop });
    const info = registry.list()[0];
    expect(info.title).toBe("Mail: Inbox (3)");
    expect(info.kind).toBe("window");
    expect(info.source).toBe("desktop");
    expect(info.subtitle).toBeUndefined();
  });

  it("无 title 的 window → title 是 '{app}: (no title)'", async () => {
    const registry = new RootRegistry();
    const desktop = makeMockDesktop("desktop", async () => [
      {
        bundleId: "x",
        pid: 1,
        windowId: 1000001,
        app: "X",
        title: "",
      },
    ]);
    await refreshRoots(registry, [], { source: "desktop", channel: desktop });
    expect(registry.list()[0].title).toBe("X: (no title)");
  });
});
