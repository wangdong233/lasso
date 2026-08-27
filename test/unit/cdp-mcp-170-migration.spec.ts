/**
 * T1/T2（v1.11 round1，doc/governance/01-最优性审查轮次/round1-verdict.md §2）：
 * chrome-devtools-mcp 0.3.0 → 1.7.0 迁移 + launch 级 UA/viewport 回归守护
 *
 * 上游 1.7.0 契约锚点（tarball build 白盒，与 INV-79 同源）：
 *  - 1.7.0 默认采集使用统计（README L45 "Data collection is enabled by default"）
 *    → 全部四个通道 spec（headless / logged_in:<profile> / steel / browserbase）
 *    必须含 --no-usage-statistics（漏一处 = 隐私倒退）
 *  - --wsEndpoint 与 --browserUrl 互斥（cliOptions conflicts）；Browserbase 返回
 *    wss:// 端点 → 必须用 --wsEndpoint
 *  - --chromeArg 数组透传 Chromium flag；--viewport=WxH 初始视口
 *
 * T2：HeadlessChannel spec 经 --chromeArg=--user-agent=<profile UA> 消除网络层
 * HeadlessChrome UA 头（JS defineProperty 改不了 HTTP 头；UA 头↔navigator 不一致
 * 即 bot 标记）；--viewport 与 profile.viewport 同源。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import { SteelChannel } from "../../src/channels/SteelChannel.js";
import { BrowserbaseChannel } from "../../src/channels/BrowserbaseChannel.js";
import { LockedInSpecCapture } from "../helpers/spec-capture.js";
import { StealthEngine } from "../../src/browse/StealthEngine.js";
import { STEALTH_PROFILES } from "../../src/browse/stealth-profiles.js";
import { LOCKED_CDP_MCP_VERSION } from "../../src/subprocess/SubprocessManager.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { IProfileRegistry } from "../../src/logged-in/ProfileRegistry.js";

// ============================================================
// helpers
// ============================================================
const stubClient = {
  callTool: vi.fn(async () => ({ content: [] })),
  listTools: vi.fn(async () => []),
  close: vi.fn(async () => {}),
  pid: 99999,
} as unknown as McpClient;

/** 最小 IProfileRegistry stub（LoggedInChannel 构造 + ensureProfileSpec 用）。 */
function makeStubProfiles(): IProfileRegistry {
  return {
    getCurrent: () => ({ name: "default" }),
    currentName: () => "default",
    list: () => [],
    add: vi.fn(async () => {}),
    switch: vi.fn(async () => {}),
  } as unknown as IProfileRegistry;
}

let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-t1t2-"));
  setStateStoreContext({ runId, cacheDir: tempCache });
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    /* teardown 尽力而为 */
  }
});

// ============================================================
// T1：版本锁 + 四通道 --no-usage-statistics
// ============================================================
describe("T1 — chrome-devtools-mcp 1.7.0 迁移（版本锁 + 全 spec 关遥测）", () => {
  it("LOCKED_CDP_MCP_VERSION === 1.7.0（版本锁单点）", () => {
    expect(LOCKED_CDP_MCP_VERSION).toBe("1.7.0");
  });

  it("HeadlessChannel spec：含 --no-usage-statistics（1.7.0 默认采集遥测 → 显式关）", () => {
    const cap = new LockedInSpecCapture();
    new HeadlessChannel(cap.subproc as unknown as SubprocessManager);
    const spec = cap.get("headless");
    expect(spec.args).toContain("--no-usage-statistics");
  });

  it("LoggedInChannel spec：含 --no-usage-statistics", async () => {
    const cap = new LockedInSpecCapture();
    const { LoggedInChannel } = await import(
      "../../src/channels/LoggedInChannel.js"
    );
    const ch = new LoggedInChannel(
      cap.subproc as unknown as SubprocessManager,
      9222,
      makeStubProfiles(),
      () => ({}) as never,
    );
    // 触发 ensureProfileSpec（spec 注册在 getMcpClient 前）
    await (ch as unknown as { getMcpClient(): Promise<unknown> }).getMcpClient();
    const spec = cap.get("logged_in:default");
    expect(spec.args).toContain("--no-usage-statistics");
    expect(spec.args).toContain("--browser-url=http://localhost:9222");
  });

  it("SteelChannel spec：含 --no-usage-statistics", async () => {
    const cap = new LockedInSpecCapture();
    const ch = new SteelChannel(
      cap.subproc as unknown as SubprocessManager,
      "http://localhost:3000",
      new StealthEngine(),
      {
        sessionProvider: vi.fn(async () => ({
          sessionId: "s-1",
          status: "live",
        })),
      },
    );
    await (ch as unknown as { getMcpClient(): Promise<unknown> }).getMcpClient();
    const spec = cap.get("steel");
    expect(spec.args).toContain("--no-usage-statistics");
    expect(spec.args).toContain("--browser-url=http://localhost:9223");
  });

  it("BrowserbaseChannel spec：--wsEndpoint（非 --browser-url）+ --no-usage-statistics", async () => {
    const cap = new LockedInSpecCapture();
    const ch = new BrowserbaseChannel(
      cap.subproc as unknown as SubprocessManager,
      "test-key",
      new StealthEngine(),
      {
        sessionProvider: vi.fn(async () => ({
          sessionId: "bb-1",
          wsUrl: "wss://connect.browserbase.com/?sid=bb-1",
        })),
      },
    );
    await (ch as unknown as { getMcpClient(): Promise<unknown> }).getMcpClient();
    const spec = cap.get("browserbase");
    // 1.7.0 --wsEndpoint 与 --browserUrl 互斥；wss 端点必须走 wsEndpoint
    expect(spec.args).toContain("--wsEndpoint=wss://connect.browserbase.com/?sid=bb-1");
    expect(spec.args.some((a: string) => a.startsWith("--browser-url="))).toBe(false);
    expect(spec.args).toContain("--no-usage-statistics");
  });
});

// ============================================================
// T2：headless launch 级 UA / viewport
// ============================================================
describe("T2 — headless 通道 launch 级 UA/viewport（经 1.7.0 chromeArg 透传）", () => {
  it("默认 profile（v1.12 宿主对齐：darwin→mac_chrome / 其他→windows_chrome_120）：spec 含 --chromeArg=--user-agent=<UA> 且 UA 值来自 STEALTH_PROFILES", () => {
    const cap = new LockedInSpecCapture();
    new HeadlessChannel(cap.subproc as unknown as SubprocessManager);
    const spec = cap.get("headless");
    // v1.12（round2 T2-1）：默认 profile 平台感知——按当前宿主取期望值
    const expectedProfile =
      process.platform === "darwin"
        ? STEALTH_PROFILES.mac_chrome
        : STEALTH_PROFILES.windows_chrome_120;
    const expected = `--chromeArg=--user-agent=${expectedProfile.userAgent}`;
    expect(spec.args).toContain(expected);
  });

  it("UA 不再是 HeadlessChrome（网络层头号检测点消除）", () => {
    const cap = new LockedInSpecCapture();
    new HeadlessChannel(cap.subproc as unknown as SubprocessManager);
    const spec = cap.get("headless");
    const uaArg = (spec.args as string[]).find((a) =>
      a.startsWith("--chromeArg=--user-agent="),
    );
    expect(uaArg).toBeTruthy();
    expect(uaArg!.toLowerCase()).not.toContain("headless");
  });

  it("viewport 与默认 profile.viewport 同源（v1.12 平台感知默认）", () => {
    const cap = new LockedInSpecCapture();
    new HeadlessChannel(cap.subproc as unknown as SubprocessManager);
    const spec = cap.get("headless");
    const p =
      process.platform === "darwin"
        ? STEALTH_PROFILES.mac_chrome.viewport
        : STEALTH_PROFILES.windows_chrome_120.viewport;
    expect(spec.args).toContain(`--viewport=${p.width}x${p.height}`);
  });

  it("--disable-blink-features=AutomationControlled 经 --chromeArg 包装（非 0.3.0 裸哑 flag）", () => {
    const cap = new LockedInSpecCapture();
    new HeadlessChannel(cap.subproc as unknown as SubprocessManager);
    const spec = cap.get("headless");
    expect(spec.args).toContain(
      "--chromeArg=--disable-blink-features=AutomationControlled",
    );
    // 裸形态（0.3.0 unknown-flag 哑弹）禁回潮
    expect(spec.args).not.toContain("--disable-blink-features=AutomationControlled");
  });

  it("自定义 profile（mac_safari_17）：UA flag 跟随 profile 值", () => {
    const cap = new LockedInSpecCapture();
    new HeadlessChannel(
      cap.subproc as unknown as SubprocessManager,
      new StealthEngine(),
      "mac_safari_17",
    );
    const spec = cap.get("headless");
    expect(spec.args).toContain(
      `--chromeArg=--user-agent=${STEALTH_PROFILES.mac_safari_17.userAgent}`,
    );
  });
});
