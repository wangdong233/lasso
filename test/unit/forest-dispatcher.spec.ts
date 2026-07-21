/**
 * forest-dispatcher.spec.ts（parse5 §5.1 + §6.1 #4）
 *
 * 守护 InteractDispatcher 的核心契约：
 *  1. @pN 前缀 → 调 BrowseChannel.browse(url, action, options)
 *  2. @wN 前缀 → 调 DesktopChannel.observe / act / wait
 *  3. rootRef 不存在 → outcome=didnt + retrieval_method=stale_root_ref
 *  4. channel 不存在 → outcome=didnt + retrieval_method=channel_unavailable
 *  5. 未知前缀 → outcome=didnt + retrieval_method=unknown_prefix
 *  6. dispatcher 永不抛异常（错误走 InteractEnvelope）
 *
 * INV-26：dispatcher 不 import channel internal（grep 在 check-invariants.mjs）。
 */
import { describe, it, expect, vi } from "vitest";
import { RootRegistry } from "../../src/forest/RootRegistry.js";
import { InteractDispatcher } from "../../src/forest/InteractDispatcher.js";
import type { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import type { DesktopChannel } from "../../src/channels/DesktopChannel.js";
import type {
  RootInfo,
  InteractTask,
} from "../../src/forest/forest-types.js";

// ============================================================
// mock helpers
// ============================================================
/**
 * 造一个最小 mock BrowseChannel（不继承 abstract 类，仅 stub browse 方法）。
 * dispatcher 仅用 `channel.browse(...)`，不调其他方法。
 */
function makeMockBrowse(
  name: string,
  browseImpl: (
    url: string,
    action: string,
    opts: Record<string, unknown>,
  ) => Promise<unknown>,
): BrowseChannel {
  return {
    name,
    browse: browseImpl,
  } as unknown as BrowseChannel;
}

function makeMockDesktop(
  name: string,
  impls: {
    observe?: (...args: unknown[]) => Promise<unknown>;
    act?: (...args: unknown[]) => Promise<unknown>;
    wait?: (...args: unknown[]) => Promise<unknown>;
  },
): DesktopChannel {
  return {
    name,
    observe: impls.observe ?? (async () => ({ outcome: "didnt" })),
    act: impls.act ?? (async () => ({ outcome: "didnt" })),
    wait: impls.wait ?? (async () => ({ outcome: "didnt" })),
  } as unknown as DesktopChannel;
}

/** 在 registry 预置一个 root（绕过 channel 直接 set map）。 */
async function registerRoot(
  registry: RootRegistry,
  kind: "browser_page" | "window",
  source: string,
  identStr: string,
  title: string,
  subtitle?: string,
): Promise<string> {
  return registry.getOrCreate(
    { kind, identity: identStr },
    (_k, newRef) =>
      ({
        rootRef: newRef,
        kind,
        title,
        subtitle,
        source,
      }) as RootInfo,
  );
}

// ============================================================
// @pN 路由（→ BrowseChannel.browse）
// ============================================================
describe("InteractDispatcher — @pN 路由到 BrowseChannel", () => {
  it("@pN + action=snapshot → channel.browse(url, 'snapshot', opts)", async () => {
    const registry = new RootRegistry();
    const browseSpy = vi.fn(async () => ({
      outcome: "worked",
      data: { preview: "page text" },
      served_by: "browse_headless",
      fallback_used: false,
      retrieval_method: "chrome_devtools_mcp",
    }));
    const browse = makeMockBrowse("browse_headless", browseSpy);
    const dispatcher = new InteractDispatcher(registry, new Map([
      ["browse_headless", browse],
    ]));
    const ref = await registerRoot(
      registry,
      "browser_page",
      "browse_headless",
      "url-a",
      "Page A",
      "https://a.example",
    );
    const task: InteractTask = {
      rootRef: ref,
      action: "snapshot",
      options: { foo: 1 },
    };
    const r = await dispatcher.dispatch(task);
    expect(r.outcome).toBe("worked");
    expect(browseSpy).toHaveBeenCalledOnce();
    expect(browseSpy).toHaveBeenCalledWith(
      "https://a.example",
      "snapshot",
      { foo: 1 },
    );
  });

  it("subtitle 缺失 → browse 用 about:blank 兜底", async () => {
    const registry = new RootRegistry();
    const browseSpy = vi.fn(async () => ({
      outcome: "worked",
      data: null,
      served_by: "x",
      fallback_used: false,
      retrieval_method: "x",
    }));
    const browse = makeMockBrowse("x", browseSpy);
    const dispatcher = new InteractDispatcher(registry, new Map([["x", browse]]));
    const ref = await registerRoot(
      registry,
      "browser_page",
      "x",
      "ident",
      "no url",
      undefined,
    );
    await dispatcher.dispatch({
      rootRef: ref,
      action: "snapshot",
      options: {},
    });
    expect(browseSpy.mock.calls[0][0]).toBe("about:blank");
  });

  it("browse 抛异常 → outcome=unknown + retrieval_method=dispatch_browse_threw", async () => {
    const registry = new RootRegistry();
    const browse = makeMockBrowse("x", async () => {
      throw new Error("net down");
    });
    const dispatcher = new InteractDispatcher(registry, new Map([["x", browse]]));
    const ref = await registerRoot(registry, "browser_page", "x", "i", "t");
    const r = await dispatcher.dispatch({
      rootRef: ref,
      action: "snapshot",
      options: {},
    });
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("dispatch_browse_threw");
    expect(r.error).toContain("net down");
  });
});

// ============================================================
// @wN 路由（→ DesktopChannel.observe/act/wait）
// ============================================================
describe("InteractDispatcher — @wN 路由到 DesktopChannel", () => {
  it("action=snapshot → dc.observe('snapshot', opts)", async () => {
    const registry = new RootRegistry();
    const observeSpy = vi.fn(async () => ({
      outcome: "worked",
      data: { root: {} },
      served_by: "desktop.ax",
      fallback_used: false,
      retrieval_method: "ax_snapshot",
    }));
    const desktop = makeMockDesktop("desktop", { observe: observeSpy });
    const dispatcher = new InteractDispatcher(registry, new Map([
      ["desktop", desktop],
    ]));
    const ref = await registerRoot(
      registry,
      "window",
      "desktop",
      "win-a",
      "Finder: Library",
    );
    const r = await dispatcher.dispatch({
      rootRef: ref,
      action: "snapshot",
      options: { app: "Finder" },
    });
    expect(r.outcome).toBe("worked");
    expect(observeSpy).toHaveBeenCalledOnce();
    expect(observeSpy).toHaveBeenCalledWith("snapshot", { app: "Finder" });
  });

  it("action=find → dc.observe('find', opts)", async () => {
    const registry = new RootRegistry();
    const observeSpy = vi.fn(async () => ({ outcome: "worked" }));
    const desktop = makeMockDesktop("desktop", { observe: observeSpy });
    const dispatcher = new InteractDispatcher(registry, new Map([
      ["desktop", desktop],
    ]));
    const ref = await registerRoot(registry, "window", "desktop", "w", "t");
    await dispatcher.dispatch({
      rootRef: ref,
      action: "find",
      options: { where: { text: "x" } },
    });
    expect(observeSpy).toHaveBeenCalledWith("find", { where: { text: "x" } });
  });

  it("action=act → dc.act(opts)", async () => {
    const registry = new RootRegistry();
    const actSpy = vi.fn(async () => ({ outcome: "worked" }));
    const desktop = makeMockDesktop("desktop", { act: actSpy });
    const dispatcher = new InteractDispatcher(registry, new Map([
      ["desktop", desktop],
    ]));
    const ref = await registerRoot(registry, "window", "desktop", "w", "t");
    await dispatcher.dispatch({
      rootRef: ref,
      action: "act",
      options: { actions: [{ kind: "click", ref: "@e0" }] },
    });
    expect(actSpy).toHaveBeenCalledWith({
      actions: [{ kind: "click", ref: "@e0" }],
    });
  });

  it("action=wait → dc.wait(opts, timeoutMs)", async () => {
    const registry = new RootRegistry();
    const waitSpy = vi.fn(async () => ({ outcome: "worked" }));
    const desktop = makeMockDesktop("desktop", { wait: waitSpy });
    const dispatcher = new InteractDispatcher(registry, new Map([
      ["desktop", desktop],
    ]));
    const ref = await registerRoot(registry, "window", "desktop", "w", "t");
    await dispatcher.dispatch({
      rootRef: ref,
      action: "wait",
      options: { timeout_ms: 5000, where: { text: "Saved" } },
    });
    expect(waitSpy).toHaveBeenCalledWith(
      { timeout_ms: 5000, where: { text: "Saved" } },
      5000,
    );
  });

  it("action=wait 无 timeout_ms → dc.wait 第二参 undefined", async () => {
    const registry = new RootRegistry();
    const waitSpy = vi.fn(async () => ({ outcome: "worked" }));
    const desktop = makeMockDesktop("desktop", { wait: waitSpy });
    const dispatcher = new InteractDispatcher(registry, new Map([
      ["desktop", desktop],
    ]));
    const ref = await registerRoot(registry, "window", "desktop", "w", "t");
    await dispatcher.dispatch({
      rootRef: ref,
      action: "wait",
      options: {},
    });
    expect(waitSpy).toHaveBeenCalledWith({}, undefined);
  });

  it("desktop 不支持的 action（如 navigate）→ outcome=didnt + retrieval_method=unknown_action_for_desktop", async () => {
    const registry = new RootRegistry();
    const desktop = makeMockDesktop("desktop", {});
    const dispatcher = new InteractDispatcher(registry, new Map([
      ["desktop", desktop],
    ]));
    const ref = await registerRoot(registry, "window", "desktop", "w", "t");
    const r = await dispatcher.dispatch({
      rootRef: ref,
      action: "navigate",
      options: {},
    });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("unknown_action_for_desktop");
  });

  it("desktop 抛异常 → outcome=unknown + retrieval_method=dispatch_desktop_threw", async () => {
    const registry = new RootRegistry();
    const desktop = makeMockDesktop("desktop", {
      observe: async () => {
        throw new Error("ax crash");
      },
    });
    const dispatcher = new InteractDispatcher(registry, new Map([
      ["desktop", desktop],
    ]));
    const ref = await registerRoot(registry, "window", "desktop", "w", "t");
    const r = await dispatcher.dispatch({
      rootRef: ref,
      action: "snapshot",
      options: {},
    });
    expect(r.outcome).toBe("unknown");
    expect(r.retrieval_method).toBe("dispatch_desktop_threw");
    expect(r.error).toContain("ax crash");
  });
});

// ============================================================
// 错误路径
// ============================================================
describe("InteractDispatcher — 错误路径", () => {
  it("rootRef 不存在 → outcome=didnt + retrieval_method=stale_root_ref", async () => {
    const registry = new RootRegistry();
    const dispatcher = new InteractDispatcher(registry, new Map());
    const r = await dispatcher.dispatch({
      rootRef: "@p999",
      action: "snapshot",
      options: {},
    });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("stale_root_ref");
    expect(r.error).toContain("unknown_root");
    expect(r.served_by).toBe("interact_dispatcher");
  });

  it("source 对应 channel 不在 Map → channel_unavailable", async () => {
    const registry = new RootRegistry();
    // 直接在 registry 写一个 source="browse_cloud_browserbase"（Map 中无此 channel）
    const ref = await registry.getOrCreate(
      { kind: "browser_page", identity: "x" },
      (_k, newRef) => ({
        rootRef: newRef,
        kind: "browser_page",
        title: "x",
        source: "browse_cloud_browserbase",
      }),
    );
    const dispatcher = new InteractDispatcher(registry, new Map());
    const r = await dispatcher.dispatch({
      rootRef: ref,
      action: "snapshot",
      options: {},
    });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("channel_unavailable");
    expect(r.error).toContain("source_not_registered");
  });

  it("dispatcher 永不抛异常（兜底防御）", async () => {
    const registry = new RootRegistry();
    const dispatcher = new InteractDispatcher(registry, new Map());
    // 各种奇怪 rootRef 都不抛
    await expect(
      dispatcher.dispatch({
        rootRef: "",
        action: "snapshot",
        options: {},
      }),
    ).resolves.toBeDefined();
    await expect(
      dispatcher.dispatch({
        rootRef: "@x5",
        action: "snapshot",
        options: {},
      }),
    ).resolves.toBeDefined();
  });
});

// ============================================================
// 装配 / 诊断 API
// ============================================================
describe("InteractDispatcher — 装配 / 诊断 API", () => {
  it("getRegistry() 返注入的 registry 引用", () => {
    const registry = new RootRegistry();
    const dispatcher = new InteractDispatcher(registry, new Map());
    expect(dispatcher.getRegistry()).toBe(registry);
  });

  it("listChannelSources() 返所有注入 channel 名", () => {
    const registry = new RootRegistry();
    const browse = makeMockBrowse("browse_headless", async () => ({ outcome: "worked" }));
    const desktop = makeMockDesktop("desktop", {});
    const dispatcher = new InteractDispatcher(
      registry,
      new Map([
        ["browse_headless", browse],
        ["desktop", desktop],
      ]),
    );
    expect(dispatcher.listChannelSources().sort()).toEqual([
      "browse_headless",
      "desktop",
    ]);
  });
});
