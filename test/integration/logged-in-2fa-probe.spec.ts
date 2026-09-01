/**
 * PERF-3（2026-09-02 perf/acc 轮 2）：_detect2FA 探测幂等化集成测。
 *
 * 白盒证据（真机基准，dist 通道 + 本地重页面 file://）：
 *  - _detect2FA 每次调用付一次全量 take_snapshot 往返——重内容页实测 ~3.3s/次
 *    （1.49MB stdio 载荷），about:blank 地板 ~2-3ms；
 *  - 旧实现无幂等门：getMcpClient 每 action / 每 step（executeStep）/每 expect
 *    轮询（runExpect）各调一次 → 5 步链在重页面上白付 ~16s 纯 2FA 探测。
 *
 * 修法语义（与 LoggedInChannel.getMcpClient 注释「首次拿到 client 后探一次」
 * 原始意图对齐）：
 *  - P3-1 同一 McpClient 实例多次 getMcpClient → take_snapshot 恰 1 次
 *  - P3-2 client 实例变更（respawn / profile 切换）→ 重探（2 次）
 *  - P3-3 命中关键词 → status().note = "NEEDS_MANUAL_2FA"（既有语义保持）
 *  - P3-4 未命中 → note 无 NEEDS_MANUAL_2FA
 *
 * 模式同 logged-in-own-page.spec.ts：真 LoggedInChannel + noop subproc 桩 +
 * mock CdpClient 模块 + mock /json/list。getMcpClient 是 protected——经 bracket
 * 访问直测装配链。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../src/logged-in/CdpClient.js", () => ({
  CdpClient: class {
    constructor(public port: number) {}
    async createBackgroundTarget(): Promise<string | null> {
      return null; // 降级路径——不干扰 2FA 探测计数
    }
    async close(): Promise<void> {}
  },
}));

import { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";
import { ProfileRegistry } from "../../src/logged-in/ProfileRegistry.js";
import { CookieStore } from "../../src/logged-in/CookieStore.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";

// ============================================================
// setup / teardown
// ============================================================
let tmpCache: string;
let ledgerPath: string;

beforeEach(async () => {
  tmpCache = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-2fa-probe-"));
  process.env.LASSO_COOKIE_PASSPHRASE = "test-passphrase-very-long-32+chars-safe";
  ledgerPath = path.join(tmpCache, "launched-chromes.json");
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })), // /json/list 空页
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.LASSO_COOKIE_PASSPHRASE;
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  if (tmpCache) {
    try {
      await fs.rm(tmpCache, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

/**
 * 探测计数桩：take_snapshot 记录每次返回文本；list_pages 回上游 1.7.0 格式
 * （无 selected 页 → ensureOwnPageSelected 走 createBackgroundTarget=null 降级，
 * 不影响探测计数）。
 */
function makeProbeClient(snapshotText: string): {
  client: McpClient;
  snapshotCalls: () => number;
} {
  let calls = 0;
  const client = {
    callTool: async (method: string) => {
      if (method === "take_snapshot") {
        calls++;
        return { content: [{ type: "text", text: snapshotText }] };
      }
      if (method === "list_pages") {
        return { content: [{ type: "text", text: "## Pages\n(no pages)" }] };
      }
      return { content: [] };
    },
    listTools: async () => ({ content: [] }),
    close: async () => {},
    pid: 424242,
  } as unknown as McpClient;
  return { client, snapshotCalls: () => calls };
}

function subprocReturning(getClient: () => unknown): unknown {
  return {
    registerSpec: () => {},
    forgetSpec: async () => {},
    ensureRunning: async () => getClient(),
    touch: () => {},
  };
}

async function makeChannel(subproc: unknown): Promise<LoggedInChannel> {
  const profileRegistry = new ProfileRegistry(tmpCache);
  await profileRegistry.load();
  const cookieStoreFactory = (name: string) => new CookieStore(tmpCache, name);
  return new LoggedInChannel(
    subproc as never,
    9222,
    profileRegistry,
    cookieStoreFactory as never,
  );
}

async function callGetMcpClient(ch: LoggedInChannel): Promise<void> {
  await (ch as unknown as { getMcpClient: () => Promise<unknown> }).getMcpClient();
}

// ============================================================
// cases
// ============================================================
describe("LoggedInChannel —— _detect2FA 探测幂等化（PERF-3）", () => {
  it("P3-1 同 client 实例 3 次 getMcpClient → take_snapshot 恰 1 次", async () => {
    const probe = makeProbeClient("Welcome back — you are logged in.");
    let current = probe.client;
    const ch = await makeChannel(subprocReturning(() => current));
    await callGetMcpClient(ch);
    await callGetMcpClient(ch);
    await callGetMcpClient(ch);
    expect(probe.snapshotCalls()).toBe(1);
  });

  it("P3-2 client 实例变更（respawn）→ 重探一次（新会话态）", async () => {
    const probe1 = makeProbeClient("logged in page");
    const probe2 = makeProbeClient("logged in page");
    let current = probe1.client;
    const ch = await makeChannel(subprocReturning(() => current));
    await callGetMcpClient(ch);
    current = probe2.client; // 模拟 ensureRunning respawn 返回新实例
    await callGetMcpClient(ch);
    await callGetMcpClient(ch);
    expect(probe1.snapshotCalls()).toBe(1);
    expect(probe2.snapshotCalls()).toBe(1);
  });

  it("P3-3 命中 2FA 关键词 → status().note = NEEDS_MANUAL_2FA", async () => {
    const probe = makeProbeClient(
      "Sign in\nEnter the verification code we sent you",
    );
    const ch = await makeChannel(subprocReturning(() => probe.client));
    await callGetMcpClient(ch);
    const s = await ch.status();
    expect(s.note).toBe("NEEDS_MANUAL_2FA");
  });

  it("P3-4 无关键词 → status().note 无 NEEDS_MANUAL_2FA", async () => {
    const probe = makeProbeClient("Dashboard — everything looks fine");
    const ch = await makeChannel(subprocReturning(() => probe.client));
    await callGetMcpClient(ch);
    const s = await ch.status();
    expect(s.note).not.toBe("NEEDS_MANUAL_2FA");
  });

  it("P3-3b status() 自身经 getMcpClient 也不触发二次探测", async () => {
    const probe = makeProbeClient(
      "Sign in\nEnter the verification code we sent you",
    );
    const ch = await makeChannel(subprocReturning(() => probe.client));
    await ch.status();
    await ch.status();
    expect(probe.snapshotCalls()).toBe(1);
  });
});
