/**
 * bug08-e.spec.ts（BUG-08 决议 E，doc/bugs/08，2026-09-15）
 *
 * E-1 logged_in 端口三层解析（显式恒赢 → 运行时自动发现 → 原错误）：
 *  - 9222 attach 失败 + 台账 9223 非 render 记录探活通过 → spec 整 respaw 到
 *    9223 + retrieval_method 加法标注 auto_discovered_port:9223
 *  - 台账仅 render → 不发现（渲染档确定性红线）
 *  - 显式 LASSO_CDP_PORT（cdpPortExplicit）→ 永不发现
 *  - 候选口探活失败 → 原错误如实（不被自动发现污染）
 *  - 9222 探活实际健康 → 不介入（瞬态保护）
 *
 * E-2 fetch_url 失败细分（六 kind 真值表 + cause 缺失 other + AbortError）。
 *
 * 全 mock（fetch 探活 stubGlobal / 台账 env 隔离 / mock SubprocessManager）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// E-2 端到端用例：mock http-pool（hoisted vi.mock——fetch-url 顶层 import 的
// 命名空间绑定，spyOn 不可达）。公网 IP URL 需放行（fake-ip 198.18 段 + allowRanges）。
vi.mock("../../src/util/http-pool.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/util/http-pool.js")>();
  return {
    ...orig,
    acquireHttpClient: () => ({
      fetch: async () => {
        const e = new Error("fetch failed");
        (e as unknown as { cause: { code: string } }).cause = { code: "ENOTFOUND" };
        throw e;
      },
      close: async () => {},
    }),
  };
});
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";
import type { SubprocessManager, SpawnSpec } from "../../src/subprocess/SubprocessManager.js";
import { classifyFetchFailure } from "../../src/tools/fetch-url.js";
import type { LaunchedChromeRecord } from "../../src/launcher/chrome-ledger.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions, InteractResult } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
function makeMockSubproc(opts: { failFirst?: boolean } = {}) {
  const specs = new Map<string, SpawnSpec>();
  let ensureCalls = 0;
  const mockClient: McpClient = {
    pid: 555001,
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "- page: ok" }] }),
    close: async () => {},
  } as unknown as McpClient;
  return {
    specs,
    mockClient,
    registerSpec: vi.fn((name: string, spec: SpawnSpec) => {
      specs.set(name, spec);
    }),
    forgetSpec: vi.fn(async (name: string) => {
      specs.delete(name);
    }),
    ensureRunning: vi.fn(async (name: string): Promise<McpClient> => {
      ensureCalls++;
      // 第一次（默认 9222 spec）抛连接类失败——上游 chrome-devtools-mcp 连不上
      // CDP 即退出，_spawnWithBackoff 烧完退避后 throw 的形态
      if (opts.failFirst && ensureCalls === 1) {
        throw new Error("mcp_handshake_timeout: npx chrome-devtools-mcp@1.7.0 ... 未在 20000ms 内完成 initialize");
      }
      return mockClient;
    }),
    restart: vi.fn(async () => mockClient),
    touch: vi.fn(),
  };
}

type MockSubproc = ReturnType<typeof makeMockSubproc>;

function makeChannel(sub: MockSubproc, explicit = false, onChromeUse?: (port: number) => void) {
  return new LoggedInChannel(
    sub as unknown as SubprocessManager,
    9222,
    { getCurrent: () => ({ name: "current" }), list: () => [] } as never,
    () => ({}) as never,
    undefined,
    onChromeUse,
    explicit,
  );
}

/** fetch stub：按端口路由 /json/version 与 /json/list。 */
function stubFetch(alivePorts: Set<number>) {
  const fetchCalls: string[] = [];
  const fake = vi.fn(async (url: string) => {
    fetchCalls.push(url);
    const m = url.match(/^http:\/\/127\.0\.0\.1:(\d+)\/json\/(version|list)/);
    if (m && alivePorts.has(Number(m[1]))) {
      if (m[2] === "version") {
        return { ok: true, json: async () => ({ Browser: "Chrome/151" }) };
      }
      return { ok: true, json: async () => [] };
    }
    return { ok: false, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fake);
  return { fetchCalls };
}

let dir: string;
let ledgerPath: string;
let tempCache: string;

function writeLedger(recs: Partial<LaunchedChromeRecord>[]) {
  const full: LaunchedChromeRecord[] = recs.map((r, i) => ({
    port: 9223 + i,
    pid: 60000 + i,
    profileDir: `/tmp/p${i}`,
    launchedAt: Date.now() - 1000 * (recs.length - i), // 后写的更新
    status: "ready",
    launchMode: "hidden",
    ownerKind: "cli",
    ownerPid: 1,
    ...r,
  }));
  writeFileSync(ledgerPath, JSON.stringify(full), "utf8");
}

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  dir = mkdtempSync(path.join(os.tmpdir(), "lasso-b08e-"));
  ledgerPath = path.join(dir, "launched-chromes.json");
  process.env.LASSO_LAUNCHED_CHROMES_PATH = ledgerPath;
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-b08e-cache-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.LASSO_LAUNCHED_CHROMES_PATH;
  rmSync(dir, { recursive: true, force: true });
  rmSync(tempCache, { recursive: true, force: true });
});

// ============================================================
// E-1 三层解析
// ============================================================
describe("BUG-08 E-1 — logged_in 端口三层解析", () => {
  it("9222 失败 + 台账 9223 非 render 活 → 整 respaw 到 9223 + note 标注", async () => {
    writeLedger([{ port: 9223, launchMode: "hidden" }]);
    const { fetchCalls } = stubFetch(new Set([9223])); // 9222 不在活集
    const sub = makeMockSubproc({ failFirst: true });
    const ch = makeChannel(sub);
    const r = await ch.browse("https://example.com/", "snapshot", {});
    expect(r.outcome).toBe("worked");
    // spec 切到发现口
    const spec = sub.specs.get("logged_in:current")!;
    expect(spec).toBeTruthy();
    expect(spec.args).toContain("--browser-url=http://localhost:9223");
    // retrieval_method 加法标注（调用方可见）
    expect(r.retrieval_method).toContain("auto_discovered_port:9223");
    // 探活真实发生（9222 确认死 + 9223 确认活）
    expect(fetchCalls.some((u) => u.includes("127.0.0.1:9222/json/version"))).toBe(true);
    expect(fetchCalls.some((u) => u.includes("127.0.0.1:9223/json/version"))).toBe(true);
  });

  it("台账仅 render → 不发现（渲染档确定性红线）→ 原错误如实", async () => {
    writeLedger([{ port: 9223, launchMode: "render" }]);
    stubFetch(new Set([9223]));
    const sub = makeMockSubproc({ failFirst: true });
    const ch = makeChannel(sub);
    const r = await ch.browse("https://example.com/", "snapshot", {});
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("mcp_handshake_timeout");
    expect(r.retrieval_method).not.toContain("auto_discovered_port");
  });

  it("显式 LASSO_CDP_PORT（cdpPortExplicit=true）→ 永不发现", async () => {
    writeLedger([{ port: 9223, launchMode: "hidden" }]);
    const { fetchCalls } = stubFetch(new Set([9223]));
    const sub = makeMockSubproc({ failFirst: true });
    const ch = makeChannel(sub, true);
    const r = await ch.browse("https://example.com/", "snapshot", {});
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("mcp_handshake_timeout");
    // 显式恒赢：探活根本不发生
    expect(fetchCalls.filter((u) => u.includes("/json/version"))).toHaveLength(0);
  });

  it("候选口探活失败 → 原错误如实（不被自动发现污染）", async () => {
    writeLedger([{ port: 9223, launchMode: "hidden" }]);
    stubFetch(new Set()); // 全死
    const sub = makeMockSubproc({ failFirst: true });
    const ch = makeChannel(sub);
    const r = await ch.browse("https://example.com/", "snapshot", {});
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("mcp_handshake_timeout");
  });

  it("9222 探活实际健康（瞬态 spawn 失败）→ 不介入，原错误", async () => {
    writeLedger([{ port: 9223, launchMode: "hidden" }]);
    stubFetch(new Set([9222, 9223]));
    const sub = makeMockSubproc({ failFirst: true });
    const ch = makeChannel(sub);
    const r = await ch.browse("https://example.com/", "snapshot", {});
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("mcp_handshake_timeout");
    expect(r.retrieval_method).not.toContain("auto_discovered_port");
  });

  it("userTakenAt 记录允许被发现（attach 非生命周期操作）", async () => {
    writeLedger([{ port: 9223, launchMode: "hidden", userTakenAt: Date.now() }]);
    stubFetch(new Set([9223]));
    const sub = makeMockSubproc({ failFirst: true });
    const ch = makeChannel(sub);
    const r = await ch.browse("https://example.com/", "snapshot", {});
    expect(r.outcome).toBe("worked");
    expect(r.retrieval_method).toContain("auto_discovered_port:9223");
  });

  it("健康 9222 路径零变化：无失败零探活零换口（byte-identical 语义）", async () => {
    writeLedger([{ port: 9223, launchMode: "hidden" }]);
    const { fetchCalls } = stubFetch(new Set([9222]));
    const sub = makeMockSubproc(); // 不 fail
    const ch = makeChannel(sub);
    const r = await ch.browse("https://example.com/", "snapshot", {});
    expect(r.outcome).toBe("worked");
    expect(r.retrieval_method).not.toContain("auto_discovered_port");
    // 失败未发生 → 自动发现分支未进入（/json/version 探活零调用；TabSession 的
    // /json/list 属既有路径不在断言域）
    expect(fetchCalls.filter((u) => u.includes("/json/version"))).toHaveLength(0);
  });

  it("onChromeUse 收到生效端口（发现后 touch 9223——reaper 误杀防线）", async () => {
    writeLedger([{ port: 9223, launchMode: "hidden" }]);
    stubFetch(new Set([9223]));
    const sub = makeMockSubproc({ failFirst: true });
    const touched: number[] = [];
    const ch = makeChannel(sub, false, (port) => touched.push(port));
    await ch.browse("https://example.com/", "snapshot", {});
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((p) => p === 9223)).toBe(true);
  });
});

// ============================================================
// E-2 fetch_url 失败细分
// ============================================================
describe("BUG-08 E-2 — classifyFetchFailure 六 kind 真值表", () => {
  function errWithCause(code: string): Error {
    const e = new Error("fetch failed");
    (e as unknown as { cause: { code: string } }).cause = { code };
    return e;
  }

  it("dns_failed（ENOTFOUND / EAI_AGAIN）", () => {
    expect(classifyFetchFailure(errWithCause("ENOTFOUND"))).toBe("fetch_failed:dns_failed:ENOTFOUND");
    expect(classifyFetchFailure(errWithCause("EAI_AGAIN"))).toBe("fetch_failed:dns_failed:EAI_AGAIN");
  });

  it("connect_refused（ECONNREFUSED）", () => {
    expect(classifyFetchFailure(errWithCause("ECONNREFUSED"))).toBe("fetch_failed:connect_refused:ECONNREFUSED");
  });

  it("connect_timeout（ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT）", () => {
    expect(classifyFetchFailure(errWithCause("ETIMEDOUT"))).toBe("fetch_failed:connect_timeout:ETIMEDOUT");
    expect(classifyFetchFailure(errWithCause("UND_ERR_CONNECT_TIMEOUT"))).toBe(
      "fetch_failed:connect_timeout:UND_ERR_CONNECT_TIMEOUT",
    );
  });

  it("tls_failed（CERT_* / SELF_SIGNED_* / ERR_TLS_*）", () => {
    expect(classifyFetchFailure(errWithCause("CERT_HAS_EXPIRED"))).toBe("fetch_failed:tls_failed:CERT_HAS_EXPIRED");
    expect(classifyFetchFailure(errWithCause("SELF_SIGNED_CERT_IN_CHAIN"))).toBe(
      "fetch_failed:tls_failed:SELF_SIGNED_CERT_IN_CHAIN",
    );
    expect(classifyFetchFailure(errWithCause("ERR_TLS_CERT_ALTNAME_INVALID"))).toBe(
      "fetch_failed:tls_failed:ERR_TLS_CERT_ALTNAME_INVALID",
    );
  });

  it("aborted_timeout（AbortError——timeout_ms 到点；无 cause）", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(classifyFetchFailure(abort)).toBe("fetch_failed:aborted_timeout:opts.timeout_ms reached");
  });

  it("other：cause 缺失 → 原文截断不猜；未知 code → 带码", () => {
    expect(classifyFetchFailure(new Error("TypeError: fetch failed"))).toBe(
      "fetch_failed:other:Error: TypeError: fetch failed",
    );
    expect(classifyFetchFailure(errWithCause("ECONNRESET"))).toBe("fetch_failed:other:ECONNRESET");
  });

  it("doFetchUrl 网络失败路径 error 前缀化 + outcome 保持 unknown（Y2 零变化）", async () => {
    const { doFetchUrl } = await import("../../src/tools/fetch-url.js");
    // http-pool 已被模块 mock（文件头 vi.mock）——SSRF 对 fake-ip 198.18.x 放行
    const r = await doFetchUrl(
      "https://198.18.1.1/data.json",
      { method: "GET", headers: undefined, timeout_ms: 2000, max_bytes: 1024, no_cache: false },
      { allowRanges: [], denyRanges: [] },
    );
    expect(r.outcome).toBe("unknown");
    expect(r.error).toBe("fetch_failed:dns_failed:ENOTFOUND");
  });
});
