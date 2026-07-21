/**
 * StagehandChannel 单测（parse5 §3.2.3 + §5.4 + task #7）
 *
 * 覆盖（mock httpClient）：
 *  - observe(verify) 200 + verified:true → outcome=worked + data.verified=true
 *  - observe(verify) 200 + verified:false → outcome=didnt（明确否，不 fallback）
 *  - observe(verify) 200 + 缺 verified → outcome=unknown（响应结构异常）
 *  - observe(extract) 200 + data:{...} → outcome=worked + data.data={...}
 *  - observe(extract) 200 + 缺 data → outcome=unknown
 *  - observe 无 key → outcome=didnt + retrieval_method=cloud_no_key
 *  - observe 401/403 → outcome=didnt + retrieval_method=stagehand_rest
 *  - observe 429 → outcome=unknown（限流，可重试）
 *  - observe 5xx → outcome=unknown（transient）
 *  - observe 网络错 → outcome=unknown
 *  - act(...) → outcome=didnt + retrieval_method=stagehand_observe_only（边界明示）
 *  - capabilities() canObserve=true, canAct=false
 *
 * 边界铁律（parse5 §3.2.3）：
 *  - stagehand **不 act**（agent loop 越界）
 *  - observe 仅 verify / extract，不支持其他 action
 *
 * mock 策略（parse5 §5.4）：
 *  - httpClient: vi.fn post 返 fixture JSON
 *  - CI 不跑真实 stagehand cloud（无 API key + 付费）
 */
import { describe, it, expect, vi } from "vitest";
import {
  StagehandChannel,
  parseObserveSuccess,
  defaultStagehandHttpClient,
  type StagehandHttpClient,
} from "../../src/channels/StagehandChannel.js";

// ============================================================
// mock httpClient
// ============================================================
function makeMockHttpClient(): {
  client: StagehandHttpClient;
  calls: Array<{
    url: string;
    body: unknown;
    headers: Record<string, string>;
    timeoutMs?: number;
  }>;
  setResponse: (r: {
    status: number;
    json?: unknown;
    text?: string;
  }) => void;
  setThrow: (err: Error) => void;
} {
  const calls: Array<{
    url: string;
    body: unknown;
    headers: Record<string, string>;
    timeoutMs?: number;
  }> = [];
  let response: { status: number; json?: unknown; text?: string } = {
    status: 200,
    json: {},
  };
  let throwErr: Error | null = null;
  const client: StagehandHttpClient = {
    async post(url, body, headers, timeoutMs) {
      calls.push({ url, body, headers, timeoutMs });
      if (throwErr) throw throwErr;
      return {
        status: response.status,
        json: response.json ?? null,
        text: response.text ?? "",
      };
    },
  };
  return {
    client,
    calls,
    setResponse: (r) => {
      response = r;
      throwErr = null;
    },
    setThrow: (err) => {
      throwErr = err;
    },
  };
}

// ============================================================
// 构造 + capabilities
// ============================================================
describe("StagehandChannel — 构造 + capabilities", () => {
  it("无 key 也允许构造（懒连接）", () => {
    const ch = new StagehandChannel("");
    expect(ch.name).toBe("browse_cloud_stagehand");
  });

  it("capabilities() canObserve=true, canAct=false（parse5 §3.2.3 边界）", () => {
    const ch = new StagehandChannel("fake-key");
    const caps = ch.capabilities();
    expect(caps.canObserve).toBe(true);
    expect(caps.canAct).toBe(false);
    expect(caps.dataModel).toBe("ai");
  });

  it("default endpoint = https://api.stagehand.dev", () => {
    const ch = new StagehandChannel("fake-key");
    expect(ch._testGetEndpoint()).toBe("https://api.stagehand.dev");
  });

  it("自定义 endpoint 透传", () => {
    const ch = new StagehandChannel("fake-key", {
      endpoint: "https://custom.stagehand.example",
    });
    expect(ch._testGetEndpoint()).toBe("https://custom.stagehand.example");
  });
});

// ============================================================
// observe(verify)
// ============================================================
describe("StagehandChannel.observe — verify 路径", () => {
  it("200 + verified:true → outcome=worked + data.verified=true", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 200, json: { verified: true } });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });

    const r = await ch.observe("verify", { prompt: "is login button visible?" });
    expect(r.outcome).toBe("worked");
    expect(r.data?.verified).toBe(true);
    expect(r.retrieval_method).toBe("stagehand_rest");
    expect(r.served_by).toBe("browse_cloud_stagehand");
  });

  it("200 + verified:false → outcome=didnt（明确否，不 fallback）", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 200, json: { verified: false } });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });

    const r = await ch.observe("verify", { prompt: "is logged in?" });
    expect(r.outcome).toBe("didnt");
    expect(r.data?.verified).toBe(false);
    // retrieval_method 仍是 stagehand_rest（区分 cloud_no_key 路径）
    expect(r.retrieval_method).toBe("stagehand_rest");
  });

  it("200 + 缺 verified 字段 → outcome=unknown（响应结构异常）", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 200, json: { foo: "bar" } });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });

    const r = await ch.observe("verify", { prompt: "test" });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("missing_verified_field");
  });

  it("调用 httpClient.post 时 endpoint 是 /verify + Authorization Bearer", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 200, json: { verified: true } });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });

    await ch.observe("verify", { prompt: "test prompt" });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.stagehand.dev/verify");
    expect(mock.calls[0]!.headers.Authorization).toBe("Bearer fake-key");
    expect(mock.calls[0]!.body).toEqual({ prompt: "test prompt" });
  });
});

// ============================================================
// observe(extract)
// ============================================================
describe("StagehandChannel.observe — extract 路径", () => {
  it("200 + data:{...} → outcome=worked + data.data={...}", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({
      status: 200,
      json: { data: { price: "$19.99", title: "Widget" } },
    });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });

    const r = await ch.observe("extract", {
      prompt: "extract price and title",
      schema: { price: "string", title: "string" },
    });
    expect(r.outcome).toBe("worked");
    expect(r.data?.data).toEqual({ price: "$19.99", title: "Widget" });
  });

  it("extract 调用 body 含 schema 字段", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 200, json: { data: {} } });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });

    await ch.observe("extract", {
      prompt: "extract",
      schema: { key: "string" },
    });
    expect(mock.calls[0]!.url).toBe("https://api.stagehand.dev/extract");
    expect(mock.calls[0]!.body).toEqual({
      prompt: "extract",
      schema: { key: "string" },
    });
  });

  it("extract 不传 schema → body 不含 schema 字段", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 200, json: { data: {} } });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });

    await ch.observe("extract", { prompt: "extract without schema" });
    expect(mock.calls[0]!.body).toEqual({ prompt: "extract without schema" });
  });

  it("200 + 缺 data 字段 → outcome=unknown", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 200, json: { foo: "bar" } });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });

    const r = await ch.observe("extract", { prompt: "extract" });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("missing_data_field");
  });
});

// ============================================================
// 无 key 路径
// ============================================================
describe("StagehandChannel — 无 key 短路", () => {
  it("observe 无 key → outcome=didnt + retrieval_method=cloud_no_key（不触网）", async () => {
    const mock = makeMockHttpClient();
    const ch = new StagehandChannel("", { httpClient: mock.client });
    const r = await ch.observe("verify", { prompt: "test" });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("cloud_no_key");
    expect(r.error).toContain("STAGEHAND_API_KEY");
    expect(mock.calls).toHaveLength(0); // 不触网
  });

  it("status() 无 key → available=false + note=cloud_no_key", async () => {
    const ch = new StagehandChannel("");
    const s = await ch.status();
    expect(s.available).toBe(false);
    expect(s.note).toBe("cloud_no_key");
  });

  it("isAvailable() 无 key → false", async () => {
    const ch = new StagehandChannel("");
    expect(await ch.isAvailable()).toBe(false);
  });

  it("healthCheck() 无 key → down", async () => {
    const ch = new StagehandChannel("");
    expect(await ch.healthCheck()).toBe("down");
  });
});

// ============================================================
// HTTP 错误路由
// ============================================================
describe("StagehandChannel — HTTP 错误 → outcome 路由", () => {
  it("401 → outcome=didnt + retrieval_method=stagehand_rest（apiKey 错）", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 401, text: "unauthorized" });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });
    const r = await ch.observe("verify", { prompt: "x" });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("stagehand_rest");
    expect(r.error).toContain("stagehand_unauthorized");
  });

  it("403 → outcome=didnt", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 403, text: "forbidden" });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });
    const r = await ch.observe("verify", { prompt: "x" });
    expect(r.outcome).toBe("didnt");
  });

  it("429 → outcome=unknown（限流，可重试）", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 429, text: "rate limited" });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });
    const r = await ch.observe("verify", { prompt: "x" });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("rate_limited");
  });

  it("500 → outcome=unknown（transient）", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 500, text: "internal error" });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });
    const r = await ch.observe("verify", { prompt: "x" });
    expect(r.outcome).toBe("unknown");
  });

  it("503 → outcome=unknown", async () => {
    const mock = makeMockHttpClient();
    mock.setResponse({ status: 503, text: "service unavailable" });
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });
    const r = await ch.observe("verify", { prompt: "x" });
    expect(r.outcome).toBe("unknown");
  });

  it("网络错 / timeout → outcome=unknown", async () => {
    const mock = makeMockHttpClient();
    mock.setThrow(new Error("fetch timeout"));
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });
    const r = await ch.observe("verify", { prompt: "x" });
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("network_error");
  });
});

// ============================================================
// act 边界
// ============================================================
describe("StagehandChannel.act — observe-only 边界（parse5 §3.2.3）", () => {
  it("act(...) → outcome=didnt + retrieval_method=stagehand_observe_only", async () => {
    const ch = new StagehandChannel("fake-key", {
      httpClient: makeMockHttpClient().client,
    });
    const r = await ch.act("click", { selector: "button" });
    expect(r.outcome).toBe("didnt");
    expect(r.retrieval_method).toBe("stagehand_observe_only");
    expect(r.error).toContain("does_not_act");
  });

  it("act(...) 永远不触网（即使有 endpoint 也不调）", async () => {
    const mock = makeMockHttpClient();
    const ch = new StagehandChannel("fake-key", { httpClient: mock.client });
    await ch.act("fill", {});
    await ch.act("navigate", {});
    await ch.act("click", {});
    expect(mock.calls).toHaveLength(0);
  });

  it("act(...) 不返 worked / unknown（明确「不」语义，caller 不应重试）", async () => {
    const ch = new StagehandChannel("fake-key", {
      httpClient: makeMockHttpClient().client,
    });
    const r = await ch.act("click", {});
    expect(r.outcome).not.toBe("worked");
    expect(r.outcome).not.toBe("unknown");
  });
});

// ============================================================
// parseObserveSuccess 纯函数
// ============================================================
describe("parseObserveSuccess — 纯函数", () => {
  it("verify + verified:true → worked", () => {
    const r = parseObserveSuccess("verify", { verified: true });
    expect(r.outcome).toBe("worked");
    expect(r.data?.verified).toBe(true);
  });

  it("verify + verified:false → didnt", () => {
    const r = parseObserveSuccess("verify", { verified: false });
    expect(r.outcome).toBe("didnt");
    expect(r.data?.verified).toBe(false);
  });

  it("verify + 缺 verified → unknown", () => {
    const r = parseObserveSuccess("verify", {});
    expect(r.outcome).toBe("unknown");
  });

  it("verify + null → unknown", () => {
    const r = parseObserveSuccess("verify", null);
    expect(r.outcome).toBe("unknown");
  });

  it("extract + data:{...} → worked", () => {
    const r = parseObserveSuccess("extract", { data: { a: 1 } });
    expect(r.outcome).toBe("worked");
    expect(r.data?.data).toEqual({ a: 1 });
  });

  it("extract + data:null → unknown", () => {
    const r = parseObserveSuccess("extract", { data: null });
    expect(r.outcome).toBe("unknown");
  });

  it("extract + 缺 data → unknown", () => {
    const r = parseObserveSuccess("extract", { foo: "bar" });
    expect(r.outcome).toBe("unknown");
  });

  it("始终返 retrieval_method=stagehand_rest + served_by=browse_cloud_stagehand", () => {
    const r1 = parseObserveSuccess("verify", { verified: true });
    const r2 = parseObserveSuccess("extract", { data: {} });
    const r3 = parseObserveSuccess("verify", {});
    for (const r of [r1, r2, r3]) {
      expect(r.retrieval_method).toBe("stagehand_rest");
      expect(r.served_by).toBe("browse_cloud_stagehand");
    }
  });
});

// ============================================================
// defaultStagehandHttpClient 契约（不触网）
// ============================================================
describe("defaultStagehandHttpClient — 契约形状（不触网）", () => {
  it("暴露 post 方法", () => {
    expect(typeof defaultStagehandHttpClient.post).toBe("function");
  });
  // 不做真实 fetch（会触网 + 付费）；契约校验留给手测清单（parse5 §6.3 #19）
});
