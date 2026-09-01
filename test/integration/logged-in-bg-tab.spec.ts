/**
 * logged-in-bg-tab 集成测（v1.10 parse18 §7.2 机制三，例 25-27）
 *
 * 端到端验证 LoggedInChannel 的 background tab 预建 + reaper touch 接线：
 *  25. /json/list 零 page + hidden 台账 Chrome → createBackgroundTarget("about:blank")
 *      被调（onChromeUse touch 先于建塔——回收判定输入必须最先落）
 *  26. 已有 page → 不预建（复用用户可见 Chrome 零行为变化）
 *  27. onChromeUse 回调在 getMcpClient 成功路径被调（chrome-idle-reaper touch 接线）
 *
 * 模式同 admin-tab-restore.spec.ts：真 LoggedInChannel + noop subproc 桩 +
 * mock /json/list + mock CdpClient 模块。getMcpClient 是 protected——经
 * bracket 访问直测装配链（不绕完整 browse 参数 schema）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// CdpClient 模块 mock（预建路径专用 spy；cookie 路径不在本文件覆盖面）
const createBgCalls: string[] = [];
vi.mock("../../src/logged-in/CdpClient.js", () => ({
  CdpClient: class {
    constructor(public port: number) {}
    async createBackgroundTarget(url: string): Promise<string | null> {
      createBgCalls.push(url);
      return "target-bg-mock-001";
    }
    async close(): Promise<void> {}
  },
}));

import { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";
import { ProfileRegistry } from "../../src/logged-in/ProfileRegistry.js";
import { CookieStore } from "../../src/logged-in/CookieStore.js";
import { writeFileSync } from "node:fs";

// ============================================================
// setup / teardown
// ============================================================
let tmpCache: string;
let ledgerPath: string;
let jsonListTargets: Array<{ id: string; type: string; url: string }>;
let orderLog: string[];

beforeEach(async () => {
  tmpCache = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-bg-tab-"));
  process.env.LASSO_COOKIE_PASSPHRASE = "test-passphrase-very-long-32+chars-safe";
  // 台账指 tmp（不污染 ~/.cache/lasso/）
  ledgerPath = path.join(tmpCache, "launched-chromes.json");
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
  createBgCalls.length = 0;
  orderLog = [];
  jsonListTargets = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/json/list")) {
        return { ok: true, json: async () => jsonListTargets };
      }
      return { ok: false, json: async () => ({}) };
    }),
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

function writeHiddenLedger(port: number, launchMode: "hidden" | "visible" | "render"): void {
  writeFileSync(
    ledgerPath,
    JSON.stringify([
      {
        port,
        pid: 424242,
        profileDir: "/tmp/lasso-profile-bg-test",
        launchedAt: Date.now(),
        status: "ready",
        launchMode,
      },
    ]),
  );
}

async function makeChannel(onChromeUse?: () => void): Promise<LoggedInChannel> {
  const profileRegistry = new ProfileRegistry(tmpCache);
  await profileRegistry.load();
  const cookieStoreFactory = (name: string) => new CookieStore(tmpCache, name);
  const noopSubproc = {
    registerSpec: () => {},
    forgetSpec: async () => {},
    ensureRunning: async () => ({
      callTool: async () => ({ content: [] }),
      listTools: async () => ({ content: [] }),
    }),
    touch: () => {},
  } as unknown as Parameters<typeof LoggedInChannel>[0];
  return new LoggedInChannel(
    noopSubproc,
    9222,
    profileRegistry,
    cookieStoreFactory,
    undefined,
    onChromeUse,
  );
}

/** 直测 protected getMcpClient 装配链（bracket 访问；不绕 browse schema）。 */
async function callGetMcpClient(ch: LoggedInChannel): Promise<void> {
  await (ch as unknown as { getMcpClient: () => Promise<unknown> }).getMcpClient();
}

// ============================================================
// cases
// ============================================================
describe("LoggedInChannel —— background tab 预建 + reaper touch 接线（parse18 §4.3）", () => {
  it("25. /json/list 零 page + hidden 台账 Chrome → createBackgroundTarget 被调；touch 先于建塔", async () => {
    writeHiddenLedger(9222, "hidden");
    const ch = await makeChannel(() => orderLog.push("touch"));
    await callGetMcpClient(ch);
    expect(createBgCalls).toEqual(["about:blank"]);
    expect(orderLog[0]).toBe("touch"); // 回收判定输入最先落
  });

  it("26. 已有 page target → 不预建（零行为变化）", async () => {
    writeHiddenLedger(9222, "hidden");
    jsonListTargets = [{ id: "P1", type: "page", url: "https://user.example/tab" }];
    const ch = await makeChannel();
    await callGetMcpClient(ch);
    expect(createBgCalls).toEqual([]);
  });

  it("26b. 台账 launchMode=visible（或无台账）→ 不预建（判定门：仅 hidden 档）", async () => {
    writeHiddenLedger(9222, "visible");
    const ch = await makeChannel();
    await callGetMcpClient(ch);
    expect(createBgCalls).toEqual([]);
  });

  // v1.19（渲染档设计决议 3.1 落点 4 回归锚）：render 档不进日常档预建 tab
  // 判定门——渲染档 Chrome 是确定性 headless 资源（外部消费方经 CDP attach），
  // 不参与 LoggedInChannel 的 about:blank 预建（那是 headed 日常档的零打扰语义）。
  it("26c. 台账 launchMode=render → 不预建（渲染档不进日常档判定门；边界 6）", async () => {
    writeHiddenLedger(9222, "render");
    const ch = await makeChannel();
    await callGetMcpClient(ch);
    expect(createBgCalls).toEqual([]);
  });

  it("27. onChromeUse 回调在 getMcpClient 成功路径被调（无台账也调——touch 与台账无关）", async () => {
    let touched = 0;
    const ch = await makeChannel(() => touched++);
    await callGetMcpClient(ch);
    expect(touched).toBe(1);
  });
});
