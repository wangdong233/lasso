/**
 * profile-switch 集成测（parse9 §5.2 + §6.2 多 profile + 隔离边界）
 *
 * 验证：
 *  - admin profile_list → 返所有 profile + 标 isCurrent
 *  - admin profile_switch → ProfileRegistry.switch 改 current 指针
 *  - LoggedInChannel.getMcpClient 切 profile → SubprocessManager.forgetSpec(旧) + registerSpec(新)
 *  - 每 profile 独立 spec name（logged_in:work / logged_in:personal）
 *
 * 守 INV-49（衍生）：profile 物理隔离（独立 user-data-dir + 独立 spec name）
 * 守 INV-52：cookie_restore 不被 profile_switch 触发（admin 路径分离）
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

// ============================================================
// setup / teardown
// ============================================================
let tmpCache: string;

beforeEach(async () => {
  _clearKeyCacheForTests();
  _internals.platform = () => "linux";
  process.env.LASSO_COOKIE_PASSPHRASE = "test-passphrase-very-long-32+chars-safe";
  tmpCache = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-profile-switch-"));
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
describe("admin profile_list / profile_switch（parse9 §3 + §6.2）", () => {
  it("profile_list：返所有 profile + 标 current（首启动只有 default）", async () => {
    const profileRegistry = new ProfileRegistry(tmpCache);
    await profileRegistry.load();

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
    });

    const r = await callAdmin(tm, { action: "profile_list" });

    expect(r.ok).toBe(true);
    expect(r.action).toBe("profile_list");
    expect(r.configured).toBe(true);
    expect(r.current).toBe("default");
    expect(Array.isArray(r.profiles)).toBe(true);
    expect((r.profiles as Array<{ name: string }>).length).toBe(1);
    expect((r.profiles as Array<{ name: string }>)[0].name).toBe("default");
  });

  it("profile_list：未注入 profiles → configured:false（零回归）", async () => {
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
      // 故意不注入 profiles
    });

    const r = await callAdmin(tm, { action: "profile_list" });
    expect(r.ok).toBe(true);
    expect(r.configured).toBe(false);
  });

  it("profile_switch：work → personal → current 改 + list 含 2 个", async () => {
    const profileRegistry = new ProfileRegistry(tmpCache);
    await profileRegistry.load();
    // 加 work / personal profile
    await profileRegistry.add("work");
    await profileRegistry.add("personal");

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
    });

    // 先切到 work
    const r1 = await callAdmin(tm, {
      action: "profile_switch",
      profile: "work",
      reason: "switching to work account",
    });
    expect(r1.ok).toBe(true);
    expect(r1.profile).toBe("work");

    // 列一次验证
    const list1 = await callAdmin(tm, { action: "profile_list" });
    expect(list1.current).toBe("work");
    expect((list1.profiles as Array<{ name: string }>).length).toBe(3); // default + work + personal

    // 切到 personal
    const r2 = await callAdmin(tm, {
      action: "profile_switch",
      profile: "personal",
      reason: "switching to personal account",
    });
    expect(r2.ok).toBe(true);
    expect(r2.profile).toBe("personal");

    // 验证 current 已改
    expect(profileRegistry.currentName()).toBe("personal");
  });

  it("profile_switch：缺 profile / 缺 reason → fail（mutation 必填校验）", async () => {
    const profileRegistry = new ProfileRegistry(tmpCache);
    await profileRegistry.load();

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
    });

    // 缺 profile
    const r1 = await callAdmin(tm, {
      action: "profile_switch",
      reason: "missing profile field",
    });
    expect(r1.ok).toBe(false);
    expect(String(r1.error)).toContain("field required: profile");

    // 缺 reason
    const r2 = await callAdmin(tm, {
      action: "profile_switch",
      profile: "default",
    });
    expect(r2.ok).toBe(false);
    expect(String(r2.error)).toContain("field required: reason");
  });

  it("profile_switch：unknown profile → fail with profile_unknown", async () => {
    const profileRegistry = new ProfileRegistry(tmpCache);
    await profileRegistry.load();

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
    });

    const r = await callAdmin(tm, {
      action: "profile_switch",
      profile: "nonexistent",
      reason: "test unknown profile",
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("profile_unknown");
  });
});

describe("LoggedInChannel 多 profile spec 隔离（parse9 §3.2 + §6.2 INV-49 衍生）", () => {
  it(
    "getMcpClient：profile=default → 注册 spec logged_in:default；" +
      "profile 切到 work → forgetSpec(logged_in:default) + registerSpec(logged_in:work)",
    async () => {
      const profileRegistry = new ProfileRegistry(tmpCache);
      await profileRegistry.load();
      await profileRegistry.add("work");

      // Mock SubprocessManager：记录 registerSpec / forgetSpec 调用
      const registeredSpecs = new Map<string, unknown>();
      let forgetCalls: string[] = [];
      const mockSubproc = {
        registerSpec: vi.fn((name: string, spec: unknown) => {
          registeredSpecs.set(name, spec);
        }),
        forgetSpec: vi.fn(async (name: string) => {
          forgetCalls.push(name);
          registeredSpecs.delete(name);
        }),
        ensureRunning: vi.fn(async (name: string) => {
          // 返最小 client stub（take_snapshot / list_pages / close_page 都返空）
          return {
            callTool: async () => ({ content: [] }),
          };
        }),
      } as unknown as Parameters<
        typeof import("../../src/channels/LoggedInChannel.js").LoggedInChannel
      >[0];

      const cookieStoreFactory = (name: string) => new CookieStore(tmpCache, name);
      const { LoggedInChannel } = await import(
        "../../src/channels/LoggedInChannel.js"
      );
      const logged_in = new LoggedInChannel(
        mockSubproc,
        9222,
        profileRegistry,
        cookieStoreFactory,
      );

      // 触发 default profile 的 spec 注册（lazy 在 getMcpClient）
      await (logged_in as unknown as { getMcpClient: () => Promise<unknown> }).getMcpClient();

      // 断：注册了 logged_in:default
      expect(registeredSpecs.has("logged_in:default")).toBe(true);
      expect(forgetCalls.length).toBe(0);

      // 切到 work
      await profileRegistry.switch("work");

      // 再次 getMcpClient → 触发 forgetSpec(logged_in:default) + registerSpec(logged_in:work)
      await (logged_in as unknown as { getMcpClient: () => Promise<unknown> }).getMcpClient();

      // 断：旧 spec 被 forget，新 spec 被 register
      expect(forgetCalls).toContain("logged_in:default");
      expect(registeredSpecs.has("logged_in:work")).toBe(true);
      expect(registeredSpecs.has("logged_in:default")).toBe(false);

      // 断：spec name 物理隔离（INV-49 衍生：每 profile 独立 spec name）
      const specNames = Array.from(registeredSpecs.keys());
      expect(specNames).toEqual(["logged_in:work"]);
    },
  );

  it("profile 名校验：bad_name 拒（防路径穿越）", async () => {
    const profileRegistry = new ProfileRegistry(tmpCache);
    await profileRegistry.load();

    // 路径穿越攻击名
    await expect(profileRegistry.add("../etc")).rejects.toThrow(
      /profile_bad_name/,
    );
    // 特殊字符
    await expect(profileRegistry.add("Work;ls")).rejects.toThrow(
      /profile_bad_name/,
    );
    // 大写字母
    await expect(profileRegistry.add("Work")).rejects.toThrow(
      /profile_bad_name/,
    );
    // 超长
    await expect(
      profileRegistry.add("a".repeat(33)),
    ).rejects.toThrow(/profile_bad_name/);

    // 合法名应通过
    const ok1 = await profileRegistry.add("work");
    expect(ok1.name).toBe("work");
    const ok2 = await profileRegistry.add("personal-test_1");
    expect(ok2.name).toBe("personal-test_1");
  });
});
