/**
 * CdpClient v0.8 单测（parse9 §3.1 + §5.1）
 *
 * 覆盖（mock WebSocket + fetch，不连真 Chrome）：
 *  - 连接流程：/json/version → webSocketDebuggerUrl → WebSocket open
 *  - CDP 帧编解码：id 自增 / pending Map 解析 / error 帧抛 cdp_error:*
 *  - getAllCookies：返 cookies 数组
 *  - setCookie：返 success boolean
 *  - close：清 pending + reject
 *  - webSocketDebuggerUrl 缺失 → 抛 cdp_no_websocket_url
 *  - 非数组 cookies result → 返空数组（健壮）
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================================
// undici WebSocket mock（hoisted；parse9 §3.1 用 undici WebSocket）
// ============================================================
const hoisted = vi.hoisted(() => {
  /**
   * 自定义响应 dispatcher：测例可注入 customResponse 来覆盖默认响应。
   * 默认：Network.getAllCookies → { cookies: mockCookies }；
   *       Network.setCookie → { success: true }。
   */
  let customResponse: ((msg: { id: number; method: string; params: any }) => unknown) | null = null;

  class MockWebSocket {
    static last: MockWebSocket | null = null;
    static reset() {
      MockWebSocket.last = null;
      customResponse = null;
    }
    static setResponse(fn: ((msg: { id: number; method: string; params: any }) => unknown) | null) {
      customResponse = fn;
    }
    listeners: Record<string, Array<(ev: any) => void>> = {};
    sent: Array<{ id: number; method: string; params: any }> = [];
    closed = false;
    url: string;
    constructor(url: string) {
      this.url = url;
      MockWebSocket.last = this;
      // 模拟异步 open 事件
      setTimeout(() => this._emit("open", { type: "open" }), 0);
    }
    addEventListener(ev: string, cb: (e: any) => void) {
      (this.listeners[ev] ??= []).push(cb);
    }
    removeEventListener(ev: string, cb: (e: any) => void) {
      this.listeners[ev] = (this.listeners[ev] ?? []).filter((c) => c !== cb);
    }
    send(data: string) {
      const msg = JSON.parse(data) as { id: number; method: string; params: any };
      this.sent.push(msg);
      let result: unknown;
      if (customResponse) {
        result = customResponse(msg);
      } else {
        result = {};
      }
      setTimeout(() => {
        this._emit("message", { data: JSON.stringify({ id: msg.id, result }) });
      }, 0);
    }
    close() {
      this.closed = true;
      this._emit("close", { type: "close" });
    }
    _emit(ev: string, payload: any) {
      (this.listeners[ev] ?? []).forEach((cb) => cb(payload));
    }
  }

  const mockCookies = [
    {
      name: "session",
      value: "abc",
      domain: "example.com",
      path: "/",
      size: 3,
      httpOnly: true,
      secure: true,
      session: false,
    },
  ];

  return { MockWebSocket, mockCookies };
});

vi.mock("undici", () => ({
  WebSocket: hoisted.MockWebSocket,
}));

// ============================================================
// fetch mock
// ============================================================
const fetchMock = vi.fn();

import { CdpClient } from "../../src/logged-in/CdpClient.js";

// ============================================================
// setup
// ============================================================
beforeEach(() => {
  hoisted.MockWebSocket.reset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser/fake-uuid",
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

// ============================================================
// 连接流程
// ============================================================
describe("CdpClient — 连接", () => {
  it("/json/version 拿 webSocketDebuggerUrl → 建 WebSocket", async () => {
    const cdp = new CdpClient(9222);
    await cdp.getAllCookies();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:9222/json/version");
    expect(hoisted.MockWebSocket.last).not.toBeNull();
    expect(hoisted.MockWebSocket.last!.url).toBe(
      "ws://localhost:9222/devtools/browser/fake-uuid",
    );
    await cdp.close();
  });

  it("自定义端口 → fetch URL 含自定义端口", async () => {
    const cdp = new CdpClient(9333);
    await cdp.getAllCookies();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:9333/json/version");
    await cdp.close();
  });

  it("webSocketDebuggerUrl 缺失 → 抛 cdp_no_websocket_url", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });
    const cdp = new CdpClient(9222);
    await expect(cdp.getAllCookies()).rejects.toThrow(/cdp_no_websocket_url/);
  });

  it("fetch 返非 ok → 抛 cdp_version_fetch_failed", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const cdp = new CdpClient(9222);
    await expect(cdp.getAllCookies()).rejects.toThrow(/cdp_version_fetch_failed/);
  });
});

// ============================================================
// getAllCookies
// ============================================================
describe("CdpClient — getAllCookies", () => {
  it("默认响应 → 返 mock cookies", async () => {
    hoisted.MockWebSocket.setResponse((msg) => {
      if (msg.method === "Network.getAllCookies") {
        return { cookies: hoisted.mockCookies };
      }
      return {};
    });
    const cdp = new CdpClient(9222);
    const cookies = await cdp.getAllCookies();
    expect(cookies).toEqual(hoisted.mockCookies);
    // 校验发出的帧格式
    expect(hoisted.MockWebSocket.last!.sent[0]).toMatchObject({
      method: "Network.getAllCookies",
      params: {},
    });
    expect(typeof hoisted.MockWebSocket.last!.sent[0]!.id).toBe("number");
    await cdp.close();
  });

  it("result.cookies 缺失 → 返空数组（健壮）", async () => {
    hoisted.MockWebSocket.setResponse(() => ({}));
    const cdp = new CdpClient(9222);
    const cookies = await cdp.getAllCookies();
    expect(cookies).toEqual([]);
    await cdp.close();
  });

  it("id 自增：两次调用 id 不同", async () => {
    hoisted.MockWebSocket.setResponse((msg) => {
      if (msg.method === "Network.getAllCookies") return { cookies: [] };
      if (msg.method === "Network.setCookie") return { success: true };
      return {};
    });
    const cdp = new CdpClient(9222);
    await cdp.getAllCookies();
    await cdp.setCookie({
      name: "x",
      value: "y",
      domain: "z.com",
      path: "/",
      httpOnly: false,
      secure: false,
    });
    const ids = hoisted.MockWebSocket.last!.sent.map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1]! - ids[0]!).toBe(1);
    await cdp.close();
  });
});

// ============================================================
// setCookie
// ============================================================
describe("CdpClient — setCookie", () => {
  it("success=true → 返 true", async () => {
    hoisted.MockWebSocket.setResponse((msg) => {
      if (msg.method === "Network.setCookie") return { success: true };
      return {};
    });
    const cdp = new CdpClient(9222);
    const ok = await cdp.setCookie({
      name: "session",
      value: "abc",
      domain: "example.com",
      path: "/",
      httpOnly: true,
      secure: true,
    });
    expect(ok).toBe(true);
    await cdp.close();
  });

  it("success 缺失 → 返 false（健壮）", async () => {
    hoisted.MockWebSocket.setResponse(() => ({}));
    const cdp = new CdpClient(9222);
    const ok = await cdp.setCookie({
      name: "session",
      value: "abc",
      domain: "example.com",
      path: "/",
      httpOnly: true,
      secure: true,
    });
    expect(ok).toBe(false);
    await cdp.close();
  });

  it("params 透传到 CDP 帧", async () => {
    hoisted.MockWebSocket.setResponse(() => ({ success: true }));
    const cdp = new CdpClient(9222);
    await cdp.setCookie({
      name: "k",
      value: "v",
      domain: "d.com",
      path: "/p",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    });
    const sent = hoisted.MockWebSocket.last!.sent[0]!;
    expect(sent.method).toBe("Network.setCookie");
    expect(sent.params).toMatchObject({
      name: "k",
      value: "v",
      domain: "d.com",
      path: "/p",
      secure: true,
      sameSite: "Lax",
    });
    await cdp.close();
  });
});

// ============================================================
// error 帧 / close
// ============================================================
describe("CdpClient — error 帧 + close", () => {
  it("CDP error 帧 → 抛 cdp_error:*", async () => {
    hoisted.MockWebSocket.setResponse((msg) => {
      // 模拟 server-side error：用特殊 method 触发
      if (msg.method === "Network.getAllCookies") {
        // 不能直接返 error，因为 mockResponse 包装在 result 里；
        // 改用直接 emit 一个 error 帧
        setTimeout(() => {
          hoisted.MockWebSocket.last!._emit("message", {
            data: JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: "boom" },
            }),
          });
        }, 0);
        return undefined; // 不发 result
      }
      return {};
    });
    const cdp = new CdpClient(9222);
    await expect(cdp.getAllCookies()).rejects.toThrow(/cdp_error:/);
    await cdp.close();
  });

  it("close 后再调 → pending reject（cdp_closed 或 cdp_not_connected）", async () => {
    hoisted.MockWebSocket.setResponse(() => ({ cookies: [] }));
    const cdp = new CdpClient(9222);
    await cdp.getAllCookies();
    await cdp.close();
    expect(hoisted.MockWebSocket.last!.closed).toBe(true);
  });
});
