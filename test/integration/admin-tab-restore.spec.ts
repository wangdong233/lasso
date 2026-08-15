/**
 * admin-tab-restore 集成测（v1.9 parse17 §7.2 机制三，例 27-29）
 *
 * 端到端验证 admin action `tab_restore`：
 *  27. 无 reason → fail（mutation 强制，同 capability_disable 惯例）
 *  28. 带 reason → ok + 注入的 restore 被调（registerAdminTool opts.tabRestore 注入链，
 *      模式同 cookie-restore-flow.test.ts：真 LoggedInChannel + mock /json/list）
 *  29. 未注入 tabRestore → configured:false（零回归形态）
 *
 * 守红线：tab_restore 只关快照后新增的 tab（不关用户原有 tab）——由
 * unit/tab-session.spec.ts 红线用例守护；本文件验 admin 注入链。
 * 守 INV-52：tab_restore 与 cookie action 同为 admin opt-in 入口。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CapabilityBag } from "../../src/runtime/CapabilityBag.js";
import { ToolManager } from "../../src/runtime/ToolManager.js";
import { CallerTierTracker } from "../../src/runtime/CallerTierTracker.js";
import { ProviderRegistry } from "../../src/config/provider-registry.js";
import { BUILTIN_PROVIDERS } from "../../src/config/providers.js";
import { registerAdminTool } from "../../src/tools/admin.js";
import { ProfileRegistry } from "../../src/logged-in/ProfileRegistry.js";
import { CookieStore } from "../../src/logged-in/CookieStore.js";
import {
  _internals,
  _clearKeyCacheForTests,
} from "../../src/logged-in/keychain.js";

// ============================================================
// helpers（模式同 cookie-restore-flow.test.ts / profile-switch.test.ts）
// ============================================================
function makeMockServer(): McpServer {
  const server = {
    tool: vi.fn((_name: string) => {
      return {
        enabled: true,
        disable: () => {},
        enable: () => {},
        remove: () => {},
        update: () => {},
        handler: vi.fn(),
      } as unknown as RegisteredTool;
    }),
    sendToolListChanged: vi.fn(() => {}),
  } as unknown as McpServer;
  return server;
}

async function callAdmin(
  tm: ToolManager,
  args: Record<string, unknown>,
): Promise<{
  ok: boolean;
  action: string;
  [k: string]: unknown;
}> {
  const adminRec = (tm as unknown as {
    tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
  }).tools.get("admin")!;
  const result = (await adminRec.handler(args)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    action: string;
    [k: string]: unknown;
  };
}

let tmpCache: string;
let profileRegistry: ProfileRegistry;
let cookieStoreFactory: (name: string) => CookieStore;
/** /json/list 当前返回（global fetch stub 用）。 */
let jsonListTargets: Array<{ id: string; type: string; url: string }>;

beforeEach(async () => {
  _clearKeyCacheForTests();
  _internals.platform = () => "linux";
  process.env.LASSO_COOKIE_PASSPHRASE = "test-passphrase-very-long-32+chars-safe";
  tmpCache = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-tab-restore-"));
  profileRegistry = new ProfileRegistry(tmpCache);
  await profileRegistry.load();
  cookieStoreFactory = (name: string) => new CookieStore(tmpCache, name);
  jsonListTargets = [
    { id: "A", type: "page", url: "https://user.example/start" },
    { id: "B", type: "page", url: "https://user.example/mail" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/json/list")) {
        return { ok: true, json: async () => jsonListTargets };
      }
      if (u.includes("/json/close/")) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
});

afterEach(async () => {
  _clearKeyCacheForTests();
  vi.unstubAllGlobals();
  delete process.env.LASSO_COOKIE_PASSPHRASE;
  if (tmpCache) {
    try {
      await fs.rm(tmpCache, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

/** 装配：真 LoggedInChannel（noop subproc 桩）+ registerAdminTool。 */
async function makeLoggedIn() {
  const { LoggedInChannel } = await import("../../src/channels/LoggedInChannel.js");
  const noopSubproc = {
    registerSpec: () => {},
    forgetSpec: async () => {},
    ensureRunning: async () => ({
      callTool: async () => ({ content: [] }),
      listTools: async () => ({ content: [] }),
    }),
    touch: () => {},
  } as unknown as Parameters<typeof LoggedInChannel>[0];
  return new LoggedInChannel(noopSubproc, 9222, profileRegistry, cookieStoreFactory);
}

// ============================================================
// cases
// ============================================================
describe("admin tab_restore —— 注入链（parse17 §4.4）", () => {
  it("无 reason → fail（mutation 强制）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const logged_in = await makeLoggedIn();
    registerAdminTool({
      bag: new CapabilityBag(["browse_logged_in"]),
      toolManager: tm,
      callerTier: new CallerTierTracker(100),
      registry: new ProviderRegistry(BUILTIN_PROVIDERS),
      profiles: profileRegistry,
      cookieExport: () => logged_in.exportCookies(),
      cookieImport: () => logged_in.importCookies(),
      tabRestore: () => logged_in.restoreTabs(),
    });
    const r = await callAdmin(tm, { action: "tab_restore" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("reason");
  });

  it("带 reason → ok + LoggedInChannel.restoreTabs 全链（真 TabSession + mock /json/list：只关快照后新增 tab）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const logged_in = await makeLoggedIn();
    registerAdminTool({
      bag: new CapabilityBag(["browse_logged_in"]),
      toolManager: tm,
      callerTier: new CallerTierTracker(100),
      registry: new ProviderRegistry(BUILTIN_PROVIDERS),
      profiles: profileRegistry,
      cookieExport: () => logged_in.exportCookies(),
      cookieImport: () => logged_in.importCookies(),
      tabRestore: () => logged_in.restoreTabs(),
    });

    // 首附着：getMcpClient 触发 takeSnapshotIfAbsent（快照 [A,B]）
    await (logged_in as unknown as { getMcpClient: () => Promise<unknown> }).getMcpClient();
    // 任务期间 Lasso 开了 2 个新 tab
    jsonListTargets = [
      ...jsonListTargets,
      { id: "C", type: "page", url: "https://lasso.example/1" },
      { id: "D", type: "page", url: "https://lasso.example/2" },
    ];

    const r = await callAdmin(tm, {
      action: "tab_restore",
      reason: "task finished, restore my tab list",
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("tab_restore");
    expect(r.configured).toBe(true);
    expect((r as unknown as { closed: string[] }).closed.sort()).toEqual(["C", "D"]);
  });

  it("未注入 tabRestore → configured:false（零回归形态）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    registerAdminTool({
      bag: new CapabilityBag(["admin"]),
      toolManager: tm,
      callerTier: new CallerTierTracker(100),
      registry: new ProviderRegistry(BUILTIN_PROVIDERS),
      profiles: profileRegistry,
    });
    const r = await callAdmin(tm, {
      action: "tab_restore",
      reason: "probe wiring",
    });
    expect(r.ok).toBe(true);
    expect(r.configured).toBe(false);
  });
});
