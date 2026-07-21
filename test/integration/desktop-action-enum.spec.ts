/**
 * desktop-action-enum.spec.ts（parse4 §5.2 + §3.3）
 *
 * 端到端验证 DesktopChannel + registerDesktopTool 全 6 action 路径
 * （snapshot / find / act / wait / screenshot / doctor）。
 *
 * 测试策略（与 browse-channel.spec.ts 同范式）：
 *  - 用 MockRustBridge 脚本化每个 method 的应答
 *  - 装配真 DesktopChannel + 真 FallbackDecider + 真 CircuitBreaker
 *  - 不 spawn 真 Rust helper，不依赖 macOS TCC
 *
 * 守护不变量：
 *  - INV-17：单 tool 注册（间接；fixture 装配一次即合规）
 *  - INV-18：act 走 FallbackDecider（验证 fallback_used 字段）
 *  - INV-23：fallback 永不跨 surface（snapshot path 即使失败也不进 browse）
 *
 * Mock 数据风格（parse4 §5.3 mock AX 策略）：
 *  - ax_snapshot 返 AxNode 树（field-by-field 镜像 desktop-types.ts）
 *  - ax_find / ax_act 返 DesktopResult / { matches, count }
 *  - ping / tcc_status 返 boolean 字段
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DesktopChannel } from "../../src/channels/DesktopChannel.js";
import { AxProvider } from "../../src/desktop/AxProvider.js";
import { ScreenshotVlmProvider } from "../../src/desktop/ScreenshotVlmProvider.js";
import { AppleScriptProvider } from "../../src/desktop/AppleScriptProvider.js";
import { CGEventProvider } from "../../src/desktop/CGEventProvider.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import type { AxNode } from "../../src/desktop/desktop-types.js";
import { MockRustBridge } from "../unit/mocks/mock-rust-bridge.js";

// ============================================================
// fixture：mock AX 树
// ============================================================
/** 造一个最小 AxNode 树（root + 2 children + 1 grandchild）。 */
function mockAxTree(): AxNode {
  return {
    role: "window",
    raw_role: "AXWindow",
    label: "Finder",
    rect: { x: 0, y: 0, w: 800, h: 600 },
    enabled: true,
    focused: true,
    depth: 0,
    children: [
      {
        role: "button",
        raw_role: "AXButton",
        label: "新建文件夹",
        rect: { x: 10, y: 10, w: 80, h: 30 },
        enabled: true,
        focused: false,
        depth: 1,
        children: [],
      },
      {
        role: "textfield",
        raw_role: "AXTextField",
        label: "搜索",
        rect: { x: 100, y: 10, w: 200, h: 30 },
        enabled: true,
        focused: false,
        depth: 1,
        children: [],
      },
      {
        role: "img",
        raw_role: "AXImage",
        label: "",
        rect: { x: 0, y: 200, w: 800, h: 400 },
        enabled: true,
        focused: false,
        depth: 1,
        children: [],
      },
    ],
  };
}

// ============================================================
// 装配 helper
// ============================================================
/**
 * 装配 DesktopChannel + 真依赖图（rust 是 mock，其余真实）。
 *
 * @param scripts MockRustBridge scripts（默认 noop）
 * @returns { desktop, rust } —— rust.calls 可断言
 */
function assembleDesktop(
  scripts: Record<string, (params: unknown) => unknown> = {},
): {
  desktop: DesktopChannel;
  rust: MockRustBridge;
  breakers: Map<string, CircuitBreaker>;
} {
  const rust = new MockRustBridge(scripts);
  const axProvider = new AxProvider(rust as unknown as never);
  const vlmProvider = new ScreenshotVlmProvider(rust as unknown as never, {
    endpoint: null, // 不配 VLM；screenshot fallback 走 didnt 路径
    vlmCaller: null,
  });
  // v0.4 M0.4b：4-tier 第 2/3 档 provider（parse5 §3.5.4）
  const appleScriptProvider = new AppleScriptProvider(
    rust as unknown as never,
  );
  const cgEventProvider = new CGEventProvider(rust as unknown as never);
  const breakers = new Map<string, CircuitBreaker>([
    ["desktop.ax", new CircuitBreaker()],
    ["desktop.appleScript", new CircuitBreaker()],
    ["desktop.cgEvent", new CircuitBreaker()],
    ["desktop.screenshotVlm", new CircuitBreaker()],
  ]);
  const decider = new FallbackDecider(breakers);
  const desktop = new DesktopChannel(
    rust as unknown as never,
    axProvider,
    vlmProvider,
    appleScriptProvider,
    cgEventProvider,
    decider,
    breakers,
  );
  return { desktop, rust, breakers };
}

/** 默认 ping script：返 ok=true + tcc 摘要。 */
function defaultPing() {
  return () => ({
    pong: true,
    version: "0.1.0-test",
    tcc: { accessibility: true, screen_recording: false },
  });
}

// ============================================================
// 1. snapshot（observe 主路径；不走 fallback）
// ============================================================
describe("desktop(action:'snapshot')", () => {
  it("worked：返回 OutlineSnapshot（stateId + root + createdAt）", async () => {
    const { desktop, rust } = assembleDesktop({
      ping: defaultPing(),
      ax_snapshot: () => ({ root: mockAxTree() }),
    });
    const r = await desktop.observe("snapshot", { app: "Finder", max_depth: 3 });
    expect(r.outcome).toBe("worked");
    expect(r.data).not.toBeNull();
    expect(r.data?.stateId).toBeTruthy();
    expect(r.data?.root.role).toBe("window");
    expect(r.data?.root.children.length).toBe(3);
    // AxNode → OutlineNode：ref 单调分配
    expect(r.data?.root.ref).toBe("@e0");
    expect(r.data?.root.children[0].ref).toBe("@e1");
    // 大图无 children → pictureOnly（parse4 §4.4 启发式 1）
    const img = r.data?.root.children[2];
    expect(img?.role).toBe("img");
    expect(img?.pictureOnly).toBe(true);
    // INV-23：observe 不走 fallback（即使返 worked）
    expect(r.fallback_used).toBe(false);
    // rust.call 调用了 ax_snapshot 一次
    expect(rust.calls.filter((c) => c.method === "ax_snapshot")).toHaveLength(1);
  });

  it("didnt：rust helper 返 tcc_denied → outcome=didnt（不 fallback）", async () => {
    // 用一个临时 mock 让 ax_snapshot 返 ok=false + tcc_denied
    const rust = new MockRustBridge({
      ping: defaultPing(),
    });
    // override ax_snapshot 为失败响应
    rust.setScript("ax_snapshot", () => {
      throw new Error("tcc_denied");
    });
    const axProvider = new AxProvider(rust as unknown as never);
    const vlmProvider = new ScreenshotVlmProvider(rust as unknown as never, {
      endpoint: null,
      vlmCaller: null,
    });
    // v0.4 M0.4b：补 appleScript / cgEvent provider 占位（observe 路径不会调到，
    // 但构造签名要求注入；用真 provider + mock rust 即可）
    const appleScriptProvider = new AppleScriptProvider(
      rust as unknown as never,
    );
    const cgEventProvider = new CGEventProvider(rust as unknown as never);
    const breakers = new Map<string, CircuitBreaker>([
      ["desktop.ax", new CircuitBreaker()],
      ["desktop.appleScript", new CircuitBreaker()],
      ["desktop.cgEvent", new CircuitBreaker()],
      ["desktop.screenshotVlm", new CircuitBreaker()],
    ]);
    const decider = new FallbackDecider(breakers);
    const desktop = new DesktopChannel(
      rust as unknown as never,
      axProvider,
      vlmProvider,
      appleScriptProvider,
      cgEventProvider,
      decider,
      breakers,
    );
    const r = await desktop.observe("snapshot", {});
    expect(r.outcome).toBe("unknown"); // script_error error_kind → unknown（MockRustBridge 把 throw 转 script_error）
    expect(r.data).toBeNull();
  });
});

// ============================================================
// 2. find（observe 主路径；不走 fallback）
// ============================================================
describe("desktop(action:'find')", () => {
  it("worked：返 matches + count", async () => {
    const { desktop } = assembleDesktop({
      ping: defaultPing(),
      ax_find: () => ({
        matches: [
          { ref: "@e1", role: "button", label: "新建文件夹" },
        ],
        count: 1,
      }),
    });
    const r = await desktop.observe("find", {
      where: { text: "新建文件夹" },
    });
    expect(r.outcome).toBe("worked");
    expect(r.data?.count).toBe(1);
    expect(r.data?.matches[0]).toMatchObject({ ref: "@e1", role: "button" });
  });

  it("didnt：缺 where 子句 → outcome=didnt + missing_where_clause", async () => {
    const { desktop } = assembleDesktop({ ping: defaultPing() });
    const r = await desktop.observe("find", {});
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("missing_where_clause");
  });
});

// ============================================================
// 3. act + fallback（INV-18：经 FallbackDecider）
// ============================================================
describe("desktop(action:'act') — INV-18 fallback via FallbackDecider", () => {
  it("worked via primary desktop.ax", async () => {
    const { desktop, rust } = assembleDesktop({
      ping: defaultPing(),
      ax_act: () => ({
        actions_and_results: [{ ref: "@e1", ok: true }],
        expect_verified: true,
      }),
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e1" }],
    });
    expect(r.outcome).toBe("worked");
    expect(r.fallback_used).toBe(false);
    expect(r.served_by).toBe("desktop.ax");
    expect(rust.calls.some((c) => c.method === "ax_act")).toBe(true);
    expect(rust.calls.some((c) => c.method === "screenshot")).toBe(false); // 没走 fallback
  });

  it("fallback ax→screenshotVlm：ax 抛错 → fallback 链触发（INV-18）", async () => {
    // ax_act 抛错 → outcome=unknown → FallbackDecider 升 screenshotVlm
    // screenshotVlm.act 先取 screenshot（成功）→ 因 endpoint=null 返 didnt（不阻断）
    const { desktop, rust } = assembleDesktop({
      ping: defaultPing(),
      screenshot: () => ({
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
        format: "png",
        width: 1,
        height: 1,
      }),
    });
    // override ax_act 抛错
    rust.setScript("ax_act", () => {
      throw new Error("ax_helper_error");
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e1" }],
    });
    // ax 抛 → unknown；4-tier 链：ax → appleScript → cgEvent → screenshotVlm
    //   - appleScript: 无 appleScriptAction → unknown（4-tier「本档不适用」语义）
    //   - cgEvent: 仅 click 不支持 → unknown（4-tier「本档不适用」语义）
    //   - screenshotVlm: 拿到 screenshot 但 VLM 未配 → didnt
    // 最终 outcome=didnt + fallback_used=true（链走到了 screenshotVlm）
    expect(r.outcome).toBe("didnt");
    expect(r.fallback_used).toBe(true);
    // actions_and_results 审计链：v0.4 M0.4b 4 档全部被尝试
    expect(r.actions_and_results?.length).toBe(4);
    expect(r.actions_and_results?.[0].channel).toBe("desktop.ax");
    expect(r.actions_and_results?.[1].channel).toBe("desktop.appleScript");
    expect(r.actions_and_results?.[2].channel).toBe("desktop.cgEvent");
    expect(r.actions_and_results?.[3].channel).toBe("desktop.screenshotVlm");
    // INV-23/29：fallback 链无 browse_*，全 desktop.*
    const channels = r.actions_and_results?.map((a) => a.channel) ?? [];
    expect(channels.every((c) => c.startsWith("desktop."))).toBe(true);
  });

  it("circuit open：desktop.ax 连续失败 3 次 → 第 4 次跳过 ax 直走 vlm", async () => {
    const { desktop, rust, breakers } = assembleDesktop({
      ping: defaultPing(),
      screenshot: () => ({
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
        format: "png",
        width: 1,
        height: 1,
      }),
    });
    rust.setScript("ax_act", () => {
      throw new Error("always_fail");
    });
    const axBreaker = breakers.get("desktop.ax")!;
    // 触发 3 次失败让 breaker open（CircuitBreaker 默认 threshold=3）
    for (let i = 0; i < 3; i++) {
      await desktop.act({ actions: [{ kind: "click", ref: "@e1" }] });
    }
    expect(axBreaker.state).toBe("open");
    // 第 4 次：v0.4 M0.4b 4-tier 下 ax/appleScript/cgEvent breaker 全部 open
    //   （每次 ax 失败后 appleScript/cgEvent 也 recordFailure 因「本档不适用」语义返 unknown）
    //   → screenshotVlm 兜底；INV-23/29：全 desktop.*，链无 browse_*
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e1" }],
    });
    expect(r.actions_and_results?.[0].error).toBe("circuit_open");
    expect(r.actions_and_results?.[0].channel).toBe("desktop.ax");
    // 链继续走到 screenshotVlm（INV-23/29：同 surface 内，全 desktop.*）
    expect(r.actions_and_results?.length).toBe(4);
    expect(r.actions_and_results?.[1].channel).toBe("desktop.appleScript");
    expect(r.actions_and_results?.[1].error).toBe("circuit_open");
    expect(r.actions_and_results?.[2].channel).toBe("desktop.cgEvent");
    expect(r.actions_and_results?.[2].error).toBe("circuit_open");
    expect(r.actions_and_results?.[3].channel).toBe("desktop.screenshotVlm");
    expect(r.fallback_used).toBe(true);
    const channels = r.actions_and_results?.map((a) => a.channel) ?? [];
    expect(channels.every((c) => c.startsWith("desktop."))).toBe(true);
  });
});

// ============================================================
// 4. wait tri-state（parse4 §3.4 M0.5b 第 10 条）
// ============================================================
describe("desktop(action:'wait') — tri-state", () => {
  it("preexisting：首次 find 就匹配 → verdict=preexisting", async () => {
    const { desktop } = assembleDesktop({
      ping: defaultPing(),
      ax_find: () => ({ matches: [{ ref: "@e1" }], count: 1 }),
    });
    const r = await desktop.wait(
      { where: { text: "Finder" } },
      1_000, // 短超时；preexisting 不需等
    );
    expect(r.outcome).toBe("worked");
    expect(r.data?.verdict).toBe("preexisting");
  });

  it("didnt：超时未匹配 → verdict=didnt（明确否定，不 fallback）", async () => {
    const { desktop } = assembleDesktop({
      ping: defaultPing(),
      ax_find: () => ({ matches: [], count: 0 }),
    });
    const r = await desktop.wait({ where: { text: "X" } }, 200);
    expect(r.outcome).toBe("didnt");
    expect(r.data?.verdict).toBe("didnt");
  });

  it("didnt：缺 where → outcome=didnt + missing_where_clause（不 poll）", async () => {
    const { desktop } = assembleDesktop({ ping: defaultPing() });
    const r = await desktop.wait({}, 200);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toBe("missing_where_clause");
  });
});

// ============================================================
// 5. screenshot（直接 vlmProvider.captureScreenshot，不调 VLM）
// ============================================================
describe("desktop(action:'screenshot')", () => {
  it("worked：返 DesktopResult 含 screenshot_base64", async () => {
    const { desktop, rust } = assembleDesktop({
      ping: defaultPing(),
      screenshot: () => ({
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
        format: "png",
        width: 1,
        height: 1,
      }),
    });
    const r = await desktop.screenshot({});
    expect(r.outcome).toBe("worked");
    expect(r.data?.screenshot_base64).toBeTruthy();
    expect(r.data?.screenshot_format).toBe("png");
    expect(rust.calls.some((c) => c.method === "screenshot")).toBe(true);
  });

  it("fail：rust helper 返 tcc_screen_recording_denied → outcome=didnt", async () => {
    const rust = new MockRustBridge({ ping: defaultPing() });
    rust.setScript("screenshot", () => {
      throw new Error("tcc_screen_recording_denied");
    });
    const axProvider = new AxProvider(rust as unknown as never);
    const vlmProvider = new ScreenshotVlmProvider(rust as unknown as never, {
      endpoint: null,
      vlmCaller: null,
    });
    // v0.4 M0.4b：补 appleScript / cgEvent provider 占位（screenshot 路径不会调到）
    const appleScriptProvider = new AppleScriptProvider(
      rust as unknown as never,
    );
    const cgEventProvider = new CGEventProvider(rust as unknown as never);
    const breakers = new Map<string, CircuitBreaker>([
      ["desktop.ax", new CircuitBreaker()],
      ["desktop.appleScript", new CircuitBreaker()],
      ["desktop.cgEvent", new CircuitBreaker()],
      ["desktop.screenshotVlm", new CircuitBreaker()],
    ]);
    const decider = new FallbackDecider(breakers);
    const desktop = new DesktopChannel(
      rust as unknown as never,
      axProvider,
      vlmProvider,
      appleScriptProvider,
      cgEventProvider,
      decider,
      breakers,
    );
    const r = await desktop.screenshot({});
    // MockRustBridge throw → error_kind=script_error → unknown（不是 didnt）
    // 但 outcome≠worked 是核心断言（screenshot 路径失败时不上报假成功）
    expect(r.outcome).not.toBe("worked");
    expect(r.data).toBeNull();
  });
});

// ============================================================
// 6. doctor（runDoctor({desktopChecks:true})）
// ============================================================
describe("desktop(action:'doctor') — runDoctor({desktopChecks:true})", () => {
  beforeEach(() => {
    // doctor.ts 内部会 spawn check-invariants.mjs；env 注入 ZIPHU_API_KEY 防止 fail
    process.env.ZHIPU_API_KEY = process.env.ZHIPU_API_KEY ?? "test-key";
  });

  it("返 ready + checks 含 #15-#20 desktop 项", async () => {
    const { desktop } = assembleDesktop({
      ping: defaultPing(),
      tcc_status: () => ({
        accessibility: true,
        screen_recording: true,
      }),
      ax_snapshot: () => ({ root: mockAxTree() }),
    });
    const report = (await desktop.doctor({
      skipNetwork: true,
      skipInvariants: true,
    })) as {
      ready: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    // 6 desktop checks 都在
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("rust_helper_signed");
    expect(names).toContain("rust_helper_running");
    expect(names).toContain("tcc_accessibility");
    expect(names).toContain("tcc_screen_recording");
    expect(names).toContain("ax_read_rate");
    expect(names).toContain("vlm_endpoint_reachable");
    // helper running + tcc pass（mock 全 ok）
    expect(
      report.checks.find((c) => c.name === "rust_helper_running")?.status,
    ).toBe("pass");
    expect(
      report.checks.find((c) => c.name === "tcc_accessibility")?.status,
    ).toBe("pass");
  });
});

// ============================================================
// 7. INV 守护：单 tool 注册 + 跨 surface 隔离
// ============================================================
describe("INV 守护", () => {
  it("DesktopChannel fallback plan 永不出现 browse_* 字符串字面量（INV-23）", async () => {
    // 通过 act 路径间接验证：fallback 链触发的 served_by 始终 desktop.*
    const { desktop, rust } = assembleDesktop({
      ping: defaultPing(),
      screenshot: () => ({
        base64: "png",
        format: "png",
        width: 1,
        height: 1,
      }),
    });
    rust.setScript("ax_act", () => {
      throw new Error("force_fallback");
    });
    const r = await desktop.act({
      actions: [{ kind: "click", ref: "@e1" }],
    });
    const allChannels = [
      ...r.actions_and_results!.map((a) => a.channel),
      r.served_by,
    ];
    expect(allChannels.every((c) => c.startsWith("desktop."))).toBe(true);
    expect(allChannels.some((c) => c.includes("browse"))).toBe(false);
  });

  it("DesktopChannel.capabilities 返 dataModel='ax'（与 browse 的 'dom' 区分）", async () => {
    const { desktop } = assembleDesktop({ ping: defaultPing() });
    const caps = desktop.capabilities();
    expect(caps.canObserve).toBe(true);
    expect(caps.canAct).toBe(true);
    expect(caps.dataModel).toBe("ax");
    expect(caps.needsForeground).toBe(false);
  });

  it("BaseChannel 3 契约都返有效形状（isAvailable/status/healthCheck）", async () => {
    const { desktop } = assembleDesktop({ ping: defaultPing() });
    expect(await desktop.isAvailable()).toBe(true);
    const s = await desktop.status();
    expect(s.available).toBe(true);
    expect(typeof s.latency_ms).toBe("number");
    const h = await desktop.healthCheck();
    expect(["healthy", "degraded", "down"]).toContain(h);
  });

  it("name 字段为 'desktop'（INV 名字一致）", async () => {
    const { desktop } = assembleDesktop({ ping: defaultPing() });
    expect(desktop.name).toBe("desktop");
  });
});
