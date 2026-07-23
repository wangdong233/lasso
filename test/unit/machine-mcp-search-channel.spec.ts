/**
 * MachineMcpSearchChannel 单元测（v1.4 Phase A；INV-72 镜像）。
 *
 * 守护要点（v1.4 Phase A）：
 *  1. detected → available + search 走 McpClient.connectHttp + callTool web_search_prime
 *  2. 429/网络错/解析错 → outcome=didnt/unknown（fallback 链自动降级；不自造 fallback）
 *  3. not detected（authorization 空 / endpoint 非 https）→ unavailable + search 返 unknown
 *  4. 安全：构造接 {endpoint, authorization} 后永不 log authorization 值
 *  5. response 形状与 ZhipuSearchChannel 同（search_results / results 双兼容）
 *
 * 测试策略：vi.mock McpClient.connectHttp（与 search-channel.spec.ts 同范式）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";

// ============================================================
// stub McpClient（同 search-channel.spec.ts 范式）
// ============================================================
// vi.mock factory 会被 hoisted 到文件顶，**不能**引用闭包外变量。
// 用 vi.fn() 内联（与 search-channel.spec.ts 同范式）；外部断言经 vi.mocked() 拿句柄。
const stubCall = vi.fn();
const stubList = vi.fn();

vi.mock("../../src/subprocess/McpClient.js", () => ({
  McpClient: {
    connectHttp: vi.fn(async () => ({
      callTool: stubCall,
      listTools: stubList,
      close: vi.fn(async () => {}),
      pid: null,
      stderr: null,
      isConnected: true,
    })),
  },
}));

// SUT 必须在 vi.mock 之后 import
import { McpClient } from "../../src/subprocess/McpClient.js";
import {
  MachineMcpSearchChannel,
  parseMachineMcpContent,
} from "../../src/channels/MachineMcpSearchChannel.js";

// vi.mocked 拿到 connectHttp 的 mock fn 引用（factory 内联 vi.fn 经 vi.mocked 暴露）
const connectHttpMock = vi.mocked(McpClient.connectHttp);

// ============================================================
// fixture（与 ZhipuSearchChannel 同形：content[0].text = JSON { search_results: [...] }）
// ============================================================
function searchResponse(results: Array<Record<string, unknown>>) {
  return {
    content: [
      { type: "text", text: JSON.stringify({ search_results: results }) },
    ],
  };
}

const NONEMPTY = searchResponse([
  {
    title: "Rust async tokio",
    link: "https://tokio.rs/",
    content: "Tokio is an async runtime for Rust",
    media: "tokio.rs",
  },
  {
    title: "Async Rust Guide",
    link: "https://async.rs/",
    content: "async/await in Rust",
  },
]);

const EMPTY_RESULTS = searchResponse([]);

const EMPTY_CONTENT = { content: [] };

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  const runId = newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-mmc-test-"));
  setStateStoreContext({ runId, cacheDir: tempCache });

  stubCall.mockReset();
  stubList.mockReset();
  connectHttpMock.mockReset();
  // 重置后重新挂上 factory 同款实现（mockReset 清掉 implementation）
  connectHttpMock.mockImplementation(async () => ({
    callTool: stubCall,
    listTools: stubList,
    close: vi.fn(async () => {}),
    pid: null,
    stderr: null,
    isConnected: true,
  }));
  stubList.mockResolvedValue([{ name: "web_search_prime", inputSchema: {} }]);
});

// ============================================================
// MachineMcpSearchChannel.search — happy path（detected → worked）
// ============================================================
describe("MachineMcpSearchChannel.search — detected + 非空 → worked", () => {
  it("非空 search_results → outcome=worked + 解析正确", async () => {
    stubCall.mockResolvedValue(NONEMPTY);
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer machine-key-abc",
    );
    const r = await ch.search("rust tokio", {
      limit: 10,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("worked");
    expect(r.served_by).toBe("search.machine_mcp");
    expect(r.retrieval_method).toBe("machine_mcp_api");
    expect(r.data).not.toBeNull();
    expect(r.data!.results).toHaveLength(2);
    expect(r.data!.results[0]).toEqual({
      title: "Rust async tokio",
      url: "https://tokio.rs/",
      snippet: "Tokio is an async runtime for Rust",
      source: "tokio.rs",
    });
    expect(r.data!.engine).toBe("machine_mcp");
    expect(r.data!.region).toBe("cn");
    expect(r.data!.count).toBe(2);
  });

  it("调 McpClient.connectHttp 时 Authorization header 直接透传（不重组）", async () => {
    stubCall.mockResolvedValue(NONEMPTY);
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer passthrough-key-XYZ",
    );
    await ch.search("q", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(connectHttpMock).toHaveBeenCalledTimes(1);
    const [, url, headers] = connectHttpMock.mock.calls[0];
    expect(url).toBe(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
    );
    // 完整 authorization 串透传（不重组；detector 已保证 "Bearer " 前缀）
    expect((headers as Record<string, string>).Authorization).toBe(
      "Bearer passthrough-key-XYZ",
    );
  });

  it("callTool 参数含 search_query + search_intent + count（同 ZhipuSearchChannel）", async () => {
    stubCall.mockResolvedValue(NONEMPTY);
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    await ch.search("hello world", {
      limit: 7,
      engine: "machine_mcp",
      region: "us",
      no_cache: false,
    });
    expect(stubCall).toHaveBeenCalledTimes(1);
    const [toolName, args] = stubCall.mock.calls[0];
    expect(toolName).toBe("web_search_prime");
    const a = args as Record<string, unknown>;
    expect(a.search_query).toBe("hello world");
    expect(a.search_intent).toBe(true);
    expect(a.count).toBe(7);
  });

  it("client 进程内复用（多次 search 只 connectHttp 一次）", async () => {
    stubCall.mockResolvedValue(NONEMPTY);
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    await ch.search("q1", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    await ch.search("q2", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(connectHttpMock).toHaveBeenCalledTimes(1); // 复用，不重连
    expect(stubCall).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// MachineMcpSearchChannel.search — outcome 分类（与 ZhipuSearchChannel §D.1 同源）
// ============================================================
describe("MachineMcpSearchChannel.search — outcome 分类", () => {
  it("200 但空 search_results → outcome=unknown（10 §D.1 关键信号；触发跨模态 fallback）", async () => {
    stubCall.mockResolvedValue(EMPTY_RESULTS);
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    const r = await ch.search("nothing", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    // data 仍返（含空 results，count=0）—— 与 ZhipuSearchChannel 同范式：outcome=unknown 时
    // data 可能含空 results 触发跨模态 fallback；调用方按 outcome 判定而非 data==null
    expect(r.data?.results).toEqual([]);
    expect(r.data?.count).toBe(0);
  });

  it("空 content array → outcome=unknown", async () => {
    stubCall.mockResolvedValue(EMPTY_CONTENT);
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    const r = await ch.search("q", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
  });

  it("callTool reject 网络错（ETIMEDOUT）→ outcome=unknown + error", async () => {
    stubCall.mockRejectedValue(new Error("ETIMEDOUT"));
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    const r = await ch.search("q", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("ETIMEDOUT");
  });

  it("callTool reject 404 → outcome=didnt（definitive negative）", async () => {
    stubCall.mockRejectedValue(new Error("404 not_found"));
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    const r = await ch.search("q", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("didnt");
  });

  it("callTool reject 403 → outcome=didnt", async () => {
    stubCall.mockRejectedValue(new Error("403 forbidden"));
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    const r = await ch.search("q", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("didnt");
  });

  it("callTool reject 含 429/quota → outcome=unknown（transient，触发 fallback 链降级）", async () => {
    stubCall.mockRejectedValue(new Error("429 quota exceeded"));
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    const r = await ch.search("q", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    // 429 非 404/403/NXDOMAIN/ENOTFOUND → unknown（fallback 链降级到 search.zhipu）
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("429");
  });

  it("永不抛异常（reject 都被 catch → InteractResult）", async () => {
    stubCall.mockRejectedValue(new Error("fatal boom"));
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    await expect(
      ch.search("q", {
        limit: 5,
        engine: "machine_mcp",
        region: "cn",
        no_cache: false,
      }),
    ).resolves.toBeDefined();
  });
});

// ============================================================
// MachineMcpSearchChannel — unavailable 路径（not detected）
// ============================================================
describe("MachineMcpSearchChannel — unavailable（not detected）", () => {
  it("authorization 空串 → isAvailable=false", async () => {
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "",
    );
    expect(await ch.isAvailable()).toBe(false);
  });

  it("endpoint 非 https → isAvailable=false", async () => {
    const ch = new MachineMcpSearchChannel(
      "http://insecure.test/mcp",
      "Bearer xxx",
    );
    expect(await ch.isAvailable()).toBe(false);
  });

  it("unavailable 时 search() 返 unknown + 不触网", async () => {
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "",
    );
    const r = await ch.search("q", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("authorization_missing");
    expect(connectHttpMock).not.toHaveBeenCalled();
    expect(stubCall).not.toHaveBeenCalled();
  });

  it("endpoint 非 https 时 search() 返 unknown + endpoint_invalid", async () => {
    const ch = new MachineMcpSearchChannel("http://x/", "Bearer xxx");
    const r = await ch.search("q", {
      limit: 5,
      engine: "machine_mcp",
      region: "cn",
      no_cache: false,
    });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("endpoint_invalid");
  });
});

// ============================================================
// MachineMcpSearchChannel.isAvailable / status / healthCheck
// ============================================================
describe("MachineMcpSearchChannel.isAvailable / status / healthCheck", () => {
  it("available 时 status() 探活 → available=true + latency_ms", async () => {
    stubList.mockResolvedValue([{ name: "web_search_prime", inputSchema: {} }]);
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    const s = await ch.status();
    expect(s.available).toBe(true);
    expect(s.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("status() listTools 抛错 → available=false + note 含 error", async () => {
    stubList.mockRejectedValue(new Error("MCP handshake failed"));
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    const s = await ch.status();
    expect(s.available).toBe(false);
    expect(s.note).toContain("MCP handshake failed");
  });

  it("healthCheck() available + low latency → healthy", async () => {
    stubList.mockResolvedValue([{ name: "web_search_prime", inputSchema: {} }]);
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "Bearer xxx",
    );
    expect(await ch.healthCheck()).toBe("healthy");
  });

  it("healthCheck() unavailable → down", async () => {
    const ch = new MachineMcpSearchChannel(
      "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
      "",
    );
    expect(await ch.healthCheck()).toBe("down");
  });
});

// ============================================================
// parseMachineMcpContent — 单独测（与 ZhipuSearchChannel.parseZhipuContent 同形）
// ============================================================
describe("parseMachineMcpContent — 形状兼容", () => {
  it("标准 search_results 形状：{title,link,content,media}", () => {
    const r = parseMachineMcpContent([
      {
        type: "text",
        text: JSON.stringify({
          search_results: [
            {
              title: "T",
              link: "https://t.test",
              content: "snippet",
              media: "t.test",
            },
          ],
        }),
      },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      title: "T",
      url: "https://t.test",
      snippet: "snippet",
      source: "t.test",
    });
  });

  it("兼容 results 变体（非 search_results key）", () => {
    const r = parseMachineMcpContent([
      {
        type: "text",
        text: JSON.stringify({
          results: [{ title: "T", url: "https://x.test", snippet: "s" }],
        }),
      },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].url).toBe("https://x.test");
  });

  it("content 非 array → []", () => {
    expect(parseMachineMcpContent(null)).toEqual([]);
    expect(parseMachineMcpContent("string")).toEqual([]);
    expect(parseMachineMcpContent({})).toEqual([]);
  });

  it("content array 无 text block → []", () => {
    expect(parseMachineMcpContent([{ type: "image" }])).toEqual([]);
    expect(parseMachineMcpContent([{ type: "text" }])).toEqual([]); // text 缺
  });

  it("text JSON 损坏 → []（不抛）", () => {
    expect(
      parseMachineMcpContent([{ type: "text", text: "not json" }]),
    ).toEqual([]);
  });

  it("text JSON 是非对象（array/primitive）→ []", () => {
    expect(
      parseMachineMcpContent([{ type: "text", text: "[1,2,3]" }]),
    ).toEqual([]);
  });

  it("search_results 是非 array → []", () => {
    expect(
      parseMachineMcpContent([
        {
          type: "text",
          text: JSON.stringify({ search_results: "not-array" }),
        },
      ]),
    ).toEqual([]);
  });

  it("条目无 url/link → 过滤掉", () => {
    const r = parseMachineMcpContent([
      {
        type: "text",
        text: JSON.stringify({
          search_results: [
            { title: "ok", link: "https://ok.test" },
            { title: "no-url" }, // 过滤
          ],
        }),
      },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].url).toBe("https://ok.test");
  });

  it("缺 media → source 来自 source 字段（兼容）", () => {
    const r = parseMachineMcpContent([
      {
        type: "text",
        text: JSON.stringify({
          search_results: [
            { title: "T", link: "https://x.test", source: "explicit-source" },
          ],
        }),
      },
    ]);
    expect(r[0].source).toBe("explicit-source");
  });
});
