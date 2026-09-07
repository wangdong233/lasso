/**
 * e2-screenshot-dual-path.spec.ts（BUG-03 决议 E②，doc/bugs/03 §4 E，消费方②根治）
 *
 * 事故形态（cc-control 实战，当日两次失败残骸 2.67MB screenshot.png×2 取证）：
 * 上游 chrome-devtools-mcp ≥2MB 截图只落上游临时文件不回 image block，而 lasso
 * 只实现 image-block 单路径 → 大截图必失败（0.3.0 即有，非 1.7.0 漂移）。
 *
 * 修复（doScreenshot 双路径）：
 *  1. 路径 1（优先）：传 filePath 给上游（1.7.0 已支持）——上游直写盘绕过
 *     image-block 大小限制；落盘校验 + PNG magic 保留（W1-DEF-3 禁伪造）
 *  2. 路径 2（回退）：上游未兑现写盘（0.3.0 形态）→ 既有 image-block 解码落盘
 *  3. 会话内截图通路：options.screenshot.filePath 指定输出路径（browse_headless/
 *     browse_logged_in 的 screenshot action 原本只能拿 /tmp 默认路径）
 *
 * 全 mock McpClient（BrowseChannel 子类注入）——零真浏览器。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
/** >100 字节的合法 PNG 头缓冲（magic + 填充；最终校验只看头 8 字节）。 */
function pngBytes(minSize = 200): Buffer {
  const buf = Buffer.alloc(minSize, 0xab);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  return buf;
}

function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function imageResult(data: string) {
  return {
    content: [
      { type: "text", text: "# take_screenshot response" },
      { type: "image", data, mimeType: "image/png" },
    ],
  };
}

type ScreenshotHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

function makeClient(takeScreenshot: ScreenshotHandler): McpClient {
  return {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "take_screenshot") return takeScreenshot(args) as never;
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
}

class TestBrowseChannel extends BrowseChannel {
  readonly name = "browse_test_e2";
  constructor(private readonly c: McpClient) {
    super();
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.c);
  }
}

let tempCache: string;
let shotDir: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-e2-shot-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
  shotDir = mkdtempSync(path.join(os.tmpdir(), "lasso-e2-out-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
  rmSync(shotDir, { recursive: true, force: true });
});

// ============================================================
// tests
// ============================================================
describe("E② · doScreenshot 双路径", () => {
  it("1. 上游兑现 filePath（1.7.0 契约）：直写盘文件被采纳，无 image block 也成功", async () => {
    const target = path.join(shotDir, "direct.png");
    const seenArgs: Array<Record<string, unknown>> = [];
    const ch = new TestBrowseChannel(
      makeClient((args) => {
        seenArgs.push({ ...args });
        // 上游模拟：直接写盘（不回 image block）
        writeFileSync(String(args.filePath), pngBytes());
        return textContent("# take_screenshot response\n(no image content)");
      }),
    );
    const r = await ch.browse("https://example.com/", "screenshot", {} as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // filePath 已传给上游（1.7.0 参数面）
    expect(seenArgs[0]!.filePath).toMatch(/^\/tmp\/lasso-screenshot-.*\.png$/);
    expect(String(r.data?.preview)).toMatch(/screenshot saved to/);
  });

  it("2. 上游忽略 filePath（0.3.0 形态）→ 回退 image-block 解码落盘（PNG magic 校验）", async () => {
    const ch = new TestBrowseChannel(
      makeClient((_args) => imageResult(pngBytes(500).toString("base64"))),
    );
    const r = await ch.browse("https://example.com/", "screenshot", {} as BrowseOptions);
    expect(r.outcome).toBe("worked");
    const m = String(r.data?.preview).match(/screenshot saved to (\S+)/);
    expect(m).not.toBeNull();
    const written = readFileSync(m![1]!);
    expect(written.length).toBe(500);
    expect(written[0]).toBe(0x89);
    expect(written[1]).toBe(0x50);
  });

  it("3. options.screenshot.filePath 透传（会话内截图通路）：上游忽略时落到用户指定路径", async () => {
    const target = path.join(shotDir, "user-path.png");
    const seenArgs: Array<Record<string, unknown>> = [];
    const ch = new TestBrowseChannel(
      makeClient((args) => {
        seenArgs.push({ ...args });
        return imageResult(pngBytes(300).toString("base64")); // 忽略 filePath（0.3.0）
      }),
    );
    const r = await ch.browse("https://example.com/", "screenshot", {
      screenshot: { filePath: target },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(seenArgs[0]!.filePath).toBe(target); // 透传上游
    expect(existsSync(target)).toBe(true); // 回退路径也写用户指定位置
    expect(readFileSync(target).length).toBe(300);
  });

  it("4. 上游兑现 filePath 但写了非 PNG 占位（错误占位文件）→ 终验拒绝（禁伪造）", async () => {
    const target = path.join(shotDir, "placeholder.png");
    const ch = new TestBrowseChannel(
      makeClient((args) => {
        writeFileSync(String(args.filePath), "Page failed to capture");
        return textContent("# take_screenshot response");
      }),
    );
    const r = await ch.browse("https://example.com/", "screenshot", {
      screenshot: { filePath: target },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toMatch(/not_a_valid_png/);
  });

  it("5. 回退路径 base64 非 PNG（<100B 垃圾）→ not_a_valid_png（W1-DEF-3 保留）", async () => {
    const ch = new TestBrowseChannel(
      makeClient(() => imageResult(Buffer.from("tiny-garbage").toString("base64"))),
    );
    const r = await ch.browse("https://example.com/", "screenshot", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toMatch(/not_a_valid_png/);
  });

  it("6. 上游 isError → screenshot_write_failed:upstream_is_error", async () => {
    const ch = new TestBrowseChannel(
      makeClient(() => textContent("Screenshot failed: page crashed", true)),
    );
    const r = await ch.browse("https://example.com/", "screenshot", {} as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toMatch(/screenshot_write_failed:upstream_is_error/);
  });

  it("7. schema：browse options.screenshot.filePath 可入参（zod wire 面）", async () => {
    const src = readFileSync("src/tools/browse.ts", "utf8");
    expect(src).toMatch(/filePath: z\.string\(\)\.min\(1\)\.optional\(\)/);
    const types = readFileSync("src/types.ts", "utf8");
    expect(types).toMatch(/filePath\?: string;/);
  });
});
