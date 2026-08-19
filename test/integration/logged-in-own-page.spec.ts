/**
 * logged-in-own-page 集成测（v1.17.2 doc/27-静默性全面审计 S-7 修复）
 *
 * 端到端验证 LoggedInChannel.ensureOwnPageSelected 装配链（连「用户自开 Chrome」
 * 时把 lasso 操作面从 pages[0] 挪到自建后台 tab）：
 *  - S7-1 无台账（用户 Chrome）→ createBackgroundTarget("about:blank") 被调 →
 *        id-diff 归因 → `select_page {pageId}` 被调且**不带 bringToFront**
 *  - S7-2 顺序：TabSession 快照先于建塔（自建 tab 属快照后新增 → 会话收尾
 *        restore 会关它 → 用户 tab 栏零残留）
 *  - S7-3 幂等：同 client 第二次 getMcpClient → 不再建塔/不再 select
 *  - S7-4 判定门：台账 Chrome（hidden/visible）→ 不建塔不 select
 *  - S7-5 降级：id-diff 归因不唯一（用户同刻手开 tab 竞态）→ 放弃 select
 *  - S7-6 降级：list_pages 空响应 → 不建塔（保守 no-op，维持现状）
 *  - S7-7 上游 respawn（client 实例变更）→ 重新建塔 + select（归因重置）
 *
 * 模式同 logged-in-bg-tab.spec.ts：真 LoggedInChannel + noop subproc 桩 +
 * mock CdpClient 模块 + mock /json/list。getMcpClient 是 protected——经
 * bracket 访问直测装配链。list_pages 桩用**上游 1.7.0 真实文本格式**
 * （`## Pages` / `<id>: <title> (<url>) [selected]`）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 调用序台账（CdpClient mock 与 fetch 桩共用；vi.mock 工厂延迟执行，
// 闭包捕获的 binding 在 beforeEach 重置安全）
const orderLog: string[] = [];
const createBgCalls: string[] = [];
vi.mock("../../src/logged-in/CdpClient.js", () => ({
  CdpClient: class {
    constructor(public port: number) {}
    async createBackgroundTarget(url: string): Promise<string | null> {
      createBgCalls.push(url);
      orderLog.push("create_bg");
      return "target-own-mock-001";
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

beforeEach(async () => {
  tmpCache = await fs.mkdtemp(path.join(os.tmpdir(), "lasso-own-page-"));
  process.env.LASSO_COOKIE_PASSPHRASE = "test-passphrase-very-long-32+chars-safe";
  // 台账指 tmp（不污染 ~/.cache/lasso/；无台账场景 = 文件不存在/空）
  ledgerPath = path.join(tmpCache, "launched-chromes.json");
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
  createBgCalls.length = 0;
  orderLog.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/json/list")) {
        orderLog.push("tab_snapshot_list");
        return { ok: true, json: async () => [] }; // 快照基线：零 page target
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

function writeLedger(port: number, launchMode: "hidden" | "visible"): void {
  writeFileSync(
    ledgerPath,
    JSON.stringify([
      {
        port,
        pid: 424242,
        profileDir: "/tmp/lasso-profile-own-test",
        launchedAt: Date.now(),
        status: "ready",
        launchMode,
      },
    ]),
  );
}

/**
 * 动态上游桩：list_pages 第 N 轮返回 linesFor(listCalls)（1.7.0 真实格式）；
 * select_page 记录 wire 调用形。
 */
function makeDynamicClient(linesFor: (listCalls: number) => string[]): {
  client: unknown;
  selectCalls: Array<Record<string, unknown>>;
} {
  let listCalls = 0;
  const selectCalls: Array<Record<string, unknown>> = [];
  return {
    client: {
      callTool: async (method: string, params: any) => {
        if (method === "list_pages") {
          listCalls++;
          orderLog.push("upstream_list");
          return {
            content: [{ type: "text", text: linesFor(listCalls).join("\n") }],
          };
        }
        if (method === "select_page") {
          selectCalls.push({ ...params });
          return { content: [{ type: "text", text: "selected" }] };
        }
        return { content: [] }; // take_snapshot（2FA 探测）等
      },
      listTools: async () => ({ content: [] }),
    },
    selectCalls,
  };
}

function subprocReturning(client: unknown): unknown {
  return {
    registerSpec: () => {},
    forgetSpec: async () => {},
    ensureRunning: async () => client,
    touch: () => {},
  };
}

async function makeChannel(subproc: unknown): Promise<LoggedInChannel> {
  const profileRegistry = new ProfileRegistry(tmpCache);
  await profileRegistry.load();
  const cookieStoreFactory = (name: string) => new CookieStore(tmpCache, name);
  return new LoggedInChannel(subproc as never, 9222, profileRegistry, cookieStoreFactory as never);
}

async function callGetMcpClient(ch: LoggedInChannel): Promise<void> {
  await (ch as unknown as { getMcpClient: () => Promise<unknown> }).getMcpClient();
}

/** 用户 Chrome 场景行（1.7.0 真实格式）。 */
const USER_TAB = "1: Example (https://user.example/first-tab)";
const OWN_TAB = "2: about:blank";

// ============================================================
// cases
// ============================================================
describe("LoggedInChannel —— ensureOwnPageSelected（S-7 修复装配链）", () => {
  it("S7-1 无台账（用户 Chrome）→ 建塔 + select_page{pageId}（无 bringToFront）", async () => {
    // 第一轮 list：仅用户 tab（selected）；建塔后第二轮：+ 自建 about:blank
    const { client, selectCalls } = makeDynamicClient((n) =>
      n >= 2 ? ["## Pages", USER_TAB, OWN_TAB] : ["## Pages", `${USER_TAB} [selected]`],
    );
    const ch = await makeChannel(subprocReturning(client));
    await callGetMcpClient(ch);
    expect(createBgCalls).toEqual(["about:blank"]);
    // wire 形态精确匹配：唯一键 pageId，无 bringToFront（激活开关）
    expect(selectCalls).toEqual([{ pageId: 2 }]);
  });

  it("S7-2 顺序：TabSession 快照先于建塔（restore 才能关自建 tab → 零残留）", async () => {
    const { client } = makeDynamicClient((n) =>
      n >= 2 ? ["## Pages", USER_TAB, OWN_TAB] : ["## Pages", `${USER_TAB} [selected]`],
    );
    const ch = await makeChannel(subprocReturning(client));
    await callGetMcpClient(ch);
    const snapIdx = orderLog.indexOf("tab_snapshot_list");
    const createIdx = orderLog.indexOf("create_bg");
    expect(snapIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(snapIdx).toBeLessThan(createIdx);
  });

  it("S7-3 幂等：同 client 二次 getMcpClient → 不再建塔/不再 select", async () => {
    // 第二轮起 selected 挪到自建页（模拟上游 context 指针已指 own）
    const { client, selectCalls } = makeDynamicClient((n) =>
      n >= 2
        ? ["## Pages", USER_TAB, `${OWN_TAB} [selected]`]
        : ["## Pages", `${USER_TAB} [selected]`],
    );
    const subproc = subprocReturning(client);
    const ch = await makeChannel(subproc);
    await callGetMcpClient(ch);
    expect(createBgCalls).toHaveLength(1);
    expect(selectCalls).toHaveLength(1);
    await callGetMcpClient(ch);
    expect(createBgCalls).toHaveLength(1); // 幂等：不再建塔
    expect(selectCalls).toHaveLength(1); // 幂等：不再 select
  });

  it("S7-4 判定门：台账 Chrome → ensureOwnPageSelected 不建塔不 select（hidden 的建塔来自既有 precreate 路径）", async () => {
    // visible 档：precreate 跳过（非 hidden）+ ensureOwnPageSelected 跳过（台账）→ 全零
    createBgCalls.length = 0;
    writeLedger(9222, "visible");
    const vis = makeDynamicClient(() => ["## Pages", `${USER_TAB} [selected]`]);
    const chVis = await makeChannel(subprocReturning(vis.client));
    await callGetMcpClient(chVis);
    expect(createBgCalls).toEqual([]);
    expect(vis.selectCalls).toEqual([]);

    // hidden 档：既有 precreateBackgroundTabIfHidden 建塔（零 page 时，E7 路径）
    // —— 但 ensureOwnPageSelected 仍不调 select_page（上游零页时绑定即 pages[0]=自建页）
    createBgCalls.length = 0;
    writeLedger(9222, "hidden");
    const hid = makeDynamicClient(() => ["## Pages", `${USER_TAB} [selected]`]);
    const chHid = await makeChannel(subprocReturning(hid.client));
    await callGetMcpClient(chHid);
    expect(createBgCalls).toEqual(["about:blank"]); // precreate（既有行为，非本修复路径）
    expect(hid.selectCalls).toEqual([]); // select_page 零调用
  });

  it("S7-5 降级：id-diff 出现两个新页（归因不唯一）→ 放弃 select（不赌）", async () => {
    const { client, selectCalls } = makeDynamicClient((n) =>
      n >= 2
        ? ["## Pages", USER_TAB, OWN_TAB, "3: New (https://user.example/just-opened)"]
        : ["## Pages", `${USER_TAB} [selected]`],
    );
    const ch = await makeChannel(subprocReturning(client));
    await callGetMcpClient(ch);
    expect(createBgCalls).toEqual(["about:blank"]); // 建塔已发生
    expect(selectCalls).toEqual([]); // 归因不唯一 → 不 select（诚实降级）
  });

  it("S7-6 降级：list_pages 空响应 → 不建塔（保守 no-op）", async () => {
    const client = {
      callTool: async () => ({ content: [] }),
      listTools: async () => ({ content: [] }),
    };
    const ch = await makeChannel(subprocReturning(client));
    await callGetMcpClient(ch);
    expect(createBgCalls).toEqual([]);
  });

  it("S7-7 上游 respawn（client 实例变更）→ 重新建塔 + select（归因重置）", async () => {
    let generation = 0;
    const selectCalls: Array<Record<string, unknown>> = [];
    const makeClient = () => {
      const gen = ++generation;
      const own = `${gen + 1}: about:blank`;
      return {
        callTool: async (method: string, params: any) => {
          if (method === "list_pages") {
            // 自建页「可见性」由建塔计数驱动（本代建塔后列表才含 own 页），
            // 模拟上游 targetCreated 事件后 id 出现
            const ownVisible = createBgCalls.length >= gen;
            const lines = ownVisible
              ? ["## Pages", USER_TAB, own]
              : ["## Pages", `${USER_TAB} [selected]`];
            return { content: [{ type: "text", text: lines.join("\n") }] };
          }
          if (method === "select_page") {
            selectCalls.push({ ...params });
            return { content: [{ type: "text", text: "selected" }] };
          }
          return { content: [] };
        },
        listTools: async () => ({ content: [] }),
      };
    };
    let current = makeClient();
    const subproc = {
      registerSpec: () => {},
      forgetSpec: async () => {},
      ensureRunning: async () => current,
      touch: () => {},
    };
    const ch = await makeChannel(subproc);
    await callGetMcpClient(ch);
    expect(createBgCalls).toHaveLength(1);
    expect(selectCalls).toEqual([{ pageId: 2 }]);
    // respawn：新 client 实例（上游 id 计数器重置）
    current = makeClient();
    await callGetMcpClient(ch);
    expect(createBgCalls).toHaveLength(2); // 重新建塔
    expect(selectCalls).toEqual([{ pageId: 2 }, { pageId: 3 }]); // 重新归因（gen2 的自建页 id=3）
  });
});
