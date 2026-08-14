/**
 * v1.8 Phase E / D3：vlmCaller 接线单测。
 *
 * 缺陷（wave1 D3 采证）：index.ts 装配 ScreenshotVlmProvider 时 opts.vlmCaller
 * 恒缺省 null → 即便配了 LASSO_VLM_ENDPOINT，screenshotVlm 档 act() 也恒走
 * `vlm_unavailable`（设计承诺的「转 media-gen-mcp vlm provider」不可达）。
 *
 * 修复：ScreenshotVlmProvider.ts 新增生产工厂 createMcpVlmCaller()
 * （connectHttp → callTool("vlm") → close + timeout race）；index.ts 装配时
 * LASSO_VLM_ENDPOINT 已配 → 注入，未配 → 不注入（诚实 unavailable）。
 *
 * 本文件验证：
 *  1. createMcpVlmCaller happy path：connectHttp(endpoint) + callTool("vlm",
 *     {image: data URI, prompt,...}) + close，返回透传
 *  2. callTool 抛错 → 透传 reject 且 close 仍被调（连接不泄漏）
 *  3. timeoutMs 兜底：callTool 悬挂 → reject vlm_timeout:*ms 且 close 仍被调
 *  4. index.ts 装配 grep：注入调用 + endpoint 条件都在（未配不注入的守卫）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// McpClient mock：工厂必须 hoisted（vi.mock 自动提升到 import 之前）
const connectHttpMock = vi.fn();
const callToolMock = vi.fn();
const closeMock = vi.fn();
vi.mock("../../src/subprocess/McpClient.js", () => ({
  McpClient: {
    connectHttp: (...a: unknown[]) => connectHttpMock(...a),
  },
}));
connectHttpMock.mockImplementation(() => ({
  callTool: (...a: unknown[]) => callToolMock(...a),
  close: () => closeMock(),
}));

import {
  createMcpVlmCaller,
  DEFAULT_VLM_TOOL,
  LASSO_VLM_ENDPOINT_ENV,
} from "../../src/desktop/ScreenshotVlmProvider.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

beforeEach(() => {
  connectHttpMock.mockClear();
  callToolMock.mockClear();
  closeMock.mockClear();
});

function baseReq(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: "https://media-gen.example/mcp",
    base64: "aGVsbG8=",
    width: 2880,
    height: 1800,
    prompt: "describe_interactive_elements",
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe("createMcpVlmCaller（D3 生产 vlmCaller）", () => {
  it("happy path：connectHttp(endpoint) + callTool(vlm, dataURI) + close，结果透传", async () => {
    callToolMock.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
    const caller = createMcpVlmCaller();
    const out = await caller(baseReq());

    expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
    // connectHttp：endpoint 透传；headers 空（无鉴权头——media-gen-mcp 本地/内网假设）
    expect(connectHttpMock).toHaveBeenCalledTimes(1);
    const [opts, endpoint, headers] = connectHttpMock.mock.calls[0];
    expect(endpoint).toBe("https://media-gen.example/mcp");
    expect(opts.name).toBe("lasso-vlm");
    expect(headers).toEqual({});
    // callTool：默认工具名 + image data URI + prompt + 尺寸
    expect(callToolMock).toHaveBeenCalledTimes(1);
    const [toolName, args] = callToolMock.mock.calls[0];
    expect(toolName).toBe(DEFAULT_VLM_TOOL);
    expect(toolName).toBe("vlm");
    expect(args.image).toBe("data:image/png;base64,aGVsbG8=");
    expect(args.prompt).toBe("describe_interactive_elements");
    expect(args.width).toBe(2880);
    expect(args.height).toBe(1800);
    // close（连接不泄漏）
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("callTool 抛错 → reject 透传 + close 仍被调", async () => {
    callToolMock.mockRejectedValueOnce(new Error("boom"));
    const caller = createMcpVlmCaller();
    await expect(caller(baseReq())).rejects.toThrow("boom");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("timeoutMs 兜底：callTool 悬挂 → reject vlm_timeout:*ms + close 仍被调", async () => {
    callToolMock.mockImplementationOnce(() => new Promise(() => {})); // 永不 resolve
    const caller = createMcpVlmCaller();
    await expect(caller(baseReq({ timeoutMs: 30 }))).rejects.toThrow(
      /^vlm_timeout:30ms$/,
    );
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

describe("index.ts 装配（D3 接线 grep 断言）", () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, "src/index.ts"), "utf-8");

  it("装配处注入 createMcpVlmCaller（此前 vlmCaller 恒缺省 null）", () => {
    expect(indexSrc).toMatch(/vlmCaller:\s*createMcpVlmCaller\(\)/);
  });

  it("注入有 LASSO_VLM_ENDPOINT 条件守卫（未配不注入，保持 unavailable 诚实语义）", () => {
    // 条件展开 + env 常量都来自 ScreenshotVlmProvider 导出（单一真源）
    expect(indexSrc).toMatch(
      /process\.env\[LASSO_VLM_ENDPOINT_ENV\]/,
    );
    expect(indexSrc).toMatch(/import\s*\{[^}]*LASSO_VLM_ENDPOINT_ENV[^}]*\}/s);
  });
});
