/**
 * cookie-restore-flow 集成测（parse9 §5.2 + §6.1 + §6.4 隐私边界）
 *
 * 端到端验证 admin action `cookie_restore`：
 *  - op=export：CdpClient.getAllCookies → CookieStore.export（AES-256-GCM 落盘 mode 0o600）
 *  - op=import：CookieStore.import（解密验 auth tag）→ CdpClient.setCookie 灌回
 *  - 全链 mock CDP WebSocket（vi.mock CdpClient）；真 AES-GCM round-trip（无 mock）
 *
 * 守 INV-48/49：AES-256-GCM + mode 0o600 / 目录 0o700 实落盘
 * 守 INV-51：master key 不硬编码（test 用 LASSO_COOKIE_PASSPHRASE）
 * 守 INV-52：cookie_restore **必经 admin action**（不直调 LoggedInChannel.exportCookies）
 * 守 INV-53：IV 每次唯一（export 两次 → 密文 buffer 不同）
 *
 * 与 unit/cookie-store.spec.ts 的分工（parse9 §5.1）：
 *  - 本文件（集成）：admin handler → LoggedInChannel → CdpClient + CookieStore 全链
 *  - unit：CookieStore 单元（AES round-trip / IV 唯一性）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs, statSync } from "node:fs";
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
import type { CdpCookie } from "../../src/logged-in/CdpClient.js";

// ============================================================
// mocks：CdpClient（隔离真 :9222 WebSocket；守「本机 Chrome 已开」假设）
// ============================================================
const TEST_PASSPHRASE = "test-passphrase-very-long-32+chars-safe";
const SET_COOKIE_CALLS: CdpCookie[] = [];
let MOCK_COOKIES: CdpCookie[] = [];

vi.mock("../../src/logged-in/CdpClient.js", () => {
  return {
    CdpClient: class {
      constructor(public cdpPort = 9222) {}
      async getAllCookies(): Promise<CdpCookie[]> {
        return MOCK_COOKIES;
      }
      async setCookie(params: {
        name: string;
        value: string;
        domain: string;
        path: string;
      }): Promise<boolean> {
        SET_COOKIE_CALLS.push(params as CdpCookie);
        return true;
      }
      async close(): Promise<void> {}
    },
  };
});

// ============================================================
// helpers
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

// Lazy import so vi.mock above applies（注：LoggedInChannel 也 import CdpClient）
async function loadLoggedInChannel() {
  return (await import("../../src/channels/LoggedInChannel.js")).LoggedInChannel;
}

// ============================================================
// setup / teardown
// ============================================================
let tmpCache: string;
let profileRegistry: ProfileRegistry;
let cookieStoreFactory: (name: string) => CookieStore;

beforeEach(async () => {
  _clearKeyCacheForTests();
  _internals.platform = () => "linux";
  process.env.LASSO_COOKIE_PASSPHRASE = TEST_PASSPHRASE;
  tmpCache = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-cookie-restore-"));
  profileRegistry = new ProfileRegistry(tmpCache);
  await profileRegistry.load();
  cookieStoreFactory = (name: string) => new CookieStore(tmpCache, name);
  SET_COOKIE_CALLS.length = 0;
  MOCK_COOKIES = [];
});

afterEach(async () => {
  _clearKeyCacheForTests();
  delete process.env.LASSO_COOKIE_PASSPHRASE;
  if (tmpCache) {
    try {
      await fs.rm(tmpCache, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================
// 测试用例
// ============================================================
describe("admin cookie_restore —— 端到端 flow（parse9 §5.2 + §6.1）", () => {
  it(
    "op=export：admin → LoggedInChannel.exportCookies → CdpClient.getAllCookies → " +
      "CookieStore.export（AES-256-GCM 加密落盘 mode 0o600）",
    async () => {
      // 准备：mock CDP 返 3 条 cookie
      MOCK_COOKIES = [
        {
          name: "session",
          value: "abc123token",
          domain: "github.com",
          path: "/",
          size: 13,
          httpOnly: true,
          secure: true,
          session: true,
        },
        {
          name: "user_session",
          value: "def456token",
          domain: "github.com",
          path: "/",
          size: 15,
          httpOnly: true,
          secure: true,
          session: true,
        },
        {
          name: "tz",
          value: "Asia/Shanghai",
          domain: "github.com",
          path: "/",
          size: 13,
          httpOnly: false,
          secure: false,
          session: false,
        },
      ];

      // 装配：admin tool 注入 LoggedInChannel 真实例（mock CdpClient）+ 真 CookieStore
      const server = makeMockServer();
      const tm = new ToolManager(server);
      const bag = new CapabilityBag(["browse_logged_in"]);
      const callerTier = new CallerTierTracker(100);
      const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

      const LoggedInChannel = await loadLoggedInChannel();
      // LoggedInChannel 构造需要 SubprocessManager；测试用最小桩（不触发 spawn）
      const noopSubproc = {
        registerSpec: () => {},
        forgetSpec: async () => {},
        ensureRunning: async () => ({
          callTool: async () => ({ content: [] }),
        }),
      } as unknown as Parameters<typeof LoggedInChannel>[0];
      const logged_in = new LoggedInChannel(
        noopSubproc,
        9222,
        profileRegistry,
        cookieStoreFactory,
      );

      registerAdminTool({
        bag,
        toolManager: tm,
        callerTier,
        registry,
        profiles: profileRegistry,
        cookieExport: () => logged_in.exportCookies(),
        cookieImport: () => logged_in.importCookies(),
      });

      // act：admin cookie_restore op=export（必传 reason，INV-52 显式 opt-in）
      const r = await callAdmin(tm, {
        action: "cookie_restore",
        op: "export",
        reason: "session persist before chrome restart",
      });

      // 断：返结构化 JSON
      expect(r.ok).toBe(true);
      expect(r.action).toBe("cookie_restore");
      expect(r.op).toBe("export");
      expect(r.profile).toBe("default");
      expect(typeof r.sha256).toBe("string");
      expect(r.sha256.length).toBe(64); // sha256 hex
      expect(r.bytes).toBeGreaterThan(0);
      expect(r.mode).toBe("0o600");

      // 断：加密包实落盘 + mode 0o600（INV-49）
      const pkgPath = path.join(
        tmpCache,
        "cookies",
        "default.cookies",
      );
      const stat = statSync(pkgPath);
      expect(stat.size).toBe(r.bytes);
      // mode 0o600：low 9 bit = 0o600
      const mode = stat.mode & 0o777;
      expect(mode.toString(8)).toBe("600");

      // 断：cookies/ 目录 mode 0o700（INV-49）
      const dirStat = statSync(path.join(tmpCache, "cookies"));
      const dirMode = dirStat.mode & 0o777;
      expect(dirMode.toString(8)).toBe("700");

      // 断：加密包内容不含明文 cookie value（INV-48 衍生）
      const buf = await fs.readFile(pkgPath);
      const bufHex = buf.toString("utf8");
      expect(bufHex).not.toContain("abc123token");
      expect(bufHex).not.toContain("def456token");
      // magic "LSCO" 是文件头，允许出现
      expect(bufHex.slice(0, 4)).toBe("LSCO");
    },
  );

  it(
    "op=import：admin → CookieStore.import（AES-256-GCM 解密验 tag）→ CdpClient.setCookie 灌回，" +
      "全链 round-trip 字段级一致",
    async () => {
      // 准备：先 export 一批 cookie（与上一测同形态；走真 CookieStore）
      MOCK_COOKIES = [
        {
          name: "session",
          value: "round-trip-token-xyz",
          domain: "github.com",
          path: "/",
          size: 20,
          httpOnly: true,
          secure: true,
          session: true,
        },
        {
          name: "tz",
          value: "UTC",
          domain: "github.com",
          path: "/",
          size: 3,
          httpOnly: false,
          secure: false,
          session: false,
        },
      ];

      const server = makeMockServer();
      const tm = new ToolManager(server);
      const bag = new CapabilityBag(["browse_logged_in"]);
      const callerTier = new CallerTierTracker(100);
      const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

      const LoggedInChannel = await loadLoggedInChannel();
      const noopSubproc = {
        registerSpec: () => {},
        forgetSpec: async () => {},
        ensureRunning: async () => ({
          callTool: async () => ({ content: [] }),
        }),
      } as unknown as Parameters<typeof LoggedInChannel>[0];
      const logged_in = new LoggedInChannel(
        noopSubproc,
        9222,
        profileRegistry,
        cookieStoreFactory,
      );

      registerAdminTool({
        bag,
        toolManager: tm,
        callerTier,
        registry,
        profiles: profileRegistry,
        cookieExport: () => logged_in.exportCookies(),
        cookieImport: () => logged_in.importCookies(),
      });

      // 先 export 落盘
      const exportR = await callAdmin(tm, {
        action: "cookie_restore",
        op: "export",
        reason: "persist before round-trip",
      });
      expect(exportR.ok).toBe(true);

      // 清 setCookie 调用记录 + 清 mock cookies（模拟 Chrome 重启空会话）
      SET_COOKIE_CALLS.length = 0;
      MOCK_COOKIES = [];

      // act：admin cookie_restore op=import（必传 reason，INV-52 显式 opt-in）
      const r = await callAdmin(tm, {
        action: "cookie_restore",
        op: "import",
        reason: "restore session after restart",
      });

      // 断：返结构化 JSON
      expect(r.ok).toBe(true);
      expect(r.action).toBe("cookie_restore");
      expect(r.op).toBe("import");
      expect(r.imported).toBe(2); // 2 条 cookie
      expect(r.failed).toBe(0);

      // 断：CdpClient.setCookie 调用次数 = cookie 数
      expect(SET_COOKIE_CALLS.length).toBe(2);

      // 断：round-trip 字段级一致（export 时的 cookies 已成功解密 + 灌回）
      const names = SET_COOKIE_CALLS.map((c) => c.name).sort();
      expect(names).toEqual(["session", "tz"]);
      const sessionCookie = SET_COOKIE_CALLS.find((c) => c.name === "session");
      expect(sessionCookie?.value).toBe("round-trip-token-xyz");
      expect(sessionCookie?.httpOnly).toBe(true);
      expect(sessionCookie?.secure).toBe(true);
    },
  );

  it("op=import 未 export 过 → fail with cookie_store_not_found（不静默成功）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_logged_in"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    const LoggedInChannel = await loadLoggedInChannel();
    const noopSubproc = {
      registerSpec: () => {},
      forgetSpec: async () => {},
      ensureRunning: async () => ({
        callTool: async () => ({ content: [] }),
      }),
    } as unknown as Parameters<typeof LoggedInChannel>[0];
    const logged_in = new LoggedInChannel(
      noopSubproc,
      9222,
      profileRegistry,
      cookieStoreFactory,
    );

    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      profiles: profileRegistry,
      cookieExport: () => logged_in.exportCookies(),
      cookieImport: () => logged_in.importCookies(),
    });

    const r = await callAdmin(tm, {
      action: "cookie_restore",
      op: "import",
      reason: "test not-found",
    });

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("cookie_store_not_found");
  });

  it("缺 op → fail（INV-52 显式 opt-in：op 是必填）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_logged_in"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      profiles: profileRegistry,
      cookieExport: async () => ({ sha256: "x", bytes: 0, profile: "default" }),
      cookieImport: async () => ({ imported: 0, failed: 0, profile: "default" }),
    });

    const r = await callAdmin(tm, {
      action: "cookie_restore",
      reason: "missing op test",
    });

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("field required: op");
  });

  it("缺 reason → fail（INV-52 红线：cookie 操作必传 reason 强制思考）", async () => {
    const server = makeMockServer();
    const tm = new ToolManager(server);
    const bag = new CapabilityBag(["browse_logged_in"]);
    const callerTier = new CallerTierTracker(100);
    const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

    registerAdminTool({
      bag,
      toolManager: tm,
      callerTier,
      registry,
      profiles: profileRegistry,
      cookieExport: async () => ({ sha256: "x", bytes: 0, profile: "default" }),
      cookieImport: async () => ({ imported: 0, failed: 0, profile: "default" }),
    });

    const r = await callAdmin(tm, {
      action: "cookie_restore",
      op: "export",
      // 故意不传 reason
    });

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("field required: reason");
  });

  it(
    "IV 唯一性（INV-53）：两次 export 同明文 cookie → 加密包 buffer 不同（密文 hex 不一致）",
    async () => {
      MOCK_COOKIES = [
        {
          name: "x",
          value: "fixed-token",
          domain: "x.com",
          path: "/",
          size: 11,
          httpOnly: false,
          secure: false,
          session: false,
        },
      ];

      const server = makeMockServer();
      const tm = new ToolManager(server);
      const bag = new CapabilityBag(["browse_logged_in"]);
      const callerTier = new CallerTierTracker(100);
      const registry = new ProviderRegistry(BUILTIN_PROVIDERS);

      const LoggedInChannel = await loadLoggedInChannel();
      const noopSubproc = {
        registerSpec: () => {},
        forgetSpec: async () => {},
        ensureRunning: async () => ({
          callTool: async () => ({ content: [] }),
        }),
      } as unknown as Parameters<typeof LoggedInChannel>[0];
      const logged_in = new LoggedInChannel(
        noopSubproc,
        9222,
        profileRegistry,
        cookieStoreFactory,
      );

      registerAdminTool({
        bag,
        toolManager: tm,
        callerTier,
        registry,
        profiles: profileRegistry,
        cookieExport: () => logged_in.exportCookies(),
        cookieImport: () => logged_in.importCookies(),
      });

      // 第一次 export
      const r1 = await callAdmin(tm, {
        action: "cookie_restore",
        op: "export",
        reason: "iv uniqueness test 1",
      });
      expect(r1.ok).toBe(true);
      const buf1 = (await fs.readFile(
        path.join(tmpCache, "cookies", "default.cookies"),
      )).toString("hex");

      // 第二次 export（同 cookies，应得不同密文因 IV 不同）
      const r2 = await callAdmin(tm, {
        action: "cookie_restore",
        op: "export",
        reason: "iv uniqueness test 2",
      });
      expect(r2.ok).toBe(true);
      const buf2 = (await fs.readFile(
        path.join(tmpCache, "cookies", "default.cookies"),
      )).toString("hex");

      // 断：两次密文 hex 不同（IV 在 buffer 偏移 4+16=20..32；不同 IV → 不同 buffer）
      expect(buf1).not.toEqual(buf2);
      // sha256 也不同
      expect(r1.sha256).not.toBe(r2.sha256);
    },
  );
});
