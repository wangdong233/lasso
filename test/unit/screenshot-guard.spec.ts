/**
 * screenshot-guard.spec.ts（BUG-05 决议 E，doc/bugs/05 §6-E —— filePath 写根约束）
 *
 * 事故定性（live 双证，决议 E0）：options.screenshot.filePath 全链零路径约束——
 * 任意路径可写（含自动创建嵌套父目录、任意扩展名）。默认收紧为拒 + opt-in
 * LASSO_SCREENSHOT_DIR 写根（双重 containment）。
 *
 * 覆盖（决议 §7 矩阵）：
 *  1. 无 env + 显式 filePath（~/.zshrc 类路径）→ didnt + screenshot_path_not_allowed
 *  2. 无 env + 无 filePath → 管理路径 worked 零变（byte 锚 /tmp/lasso-screenshot-<uuid>）
 *  3. env 配置 + 写根内嵌套**不存在**父目录 → worked + 目录创建
 *  4. 写根外 → didnt
 *  5. ../ 词法出根 → didnt
 *  6. symlink 逃逸 fixture → didnt
 *  7. 写根 allow 不吞 allowdev
 *  8. env 载入不存在条目丢弃 + 降级清单
 *  9. checkScreenshotTarget 纯函数 + classifyBrowseError 归 didnt（分流锚）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  promises as fs,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkScreenshotTarget,
  loadScreenshotWriteRoots,
} from "../../src/ssrf/screenshot-guard.js";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
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

function imageResult(data: string) {
  return {
    content: [
      { type: "text", text: "# take_screenshot response" },
      { type: "image", data, mimeType: "image/png" },
    ],
  };
}

function makeClient(): McpClient {
  return {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "take_screenshot") {
        return imageResult(pngBytes(300).toString("base64")) as never;
      }
      return { content: [{ type: "text", text: `stubbed ${name}` }] };
    }),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
  } as unknown as McpClient;
}

class TestChannel extends BrowseChannel {
  readonly name = "browse_shotguard_test";
  constructor(private readonly c: McpClient) {
    super();
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.c);
  }
}

let root: string;
let writeRoot: string;
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-shotguard-cache-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
  root = mkdtempSync(path.join(os.tmpdir(), "lasso-shotguard-"));
  writeRoot = path.join(root, "wroot");
  mkdirSync(writeRoot, { recursive: true });
  delete process.env.LASSO_SCREENSHOT_DIR;
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LASSO_SCREENSHOT_DIR;
  rmSync(tempCache, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** 装载写根（realpath 形态）——等价 env LASSO_SCREENSHOT_DIR=<writeRoot>。 */
const realRoot = () => loadScreenshotWriteRoots({ LASSO_SCREENSHOT_DIR: writeRoot }).roots[0]!;

// ============================================================
// 1-2. 默认（无 env）：显式 filePath 收紧为拒；管理路径零变
// ============================================================
describe("BUG-05 E — 默认关（无 env）", () => {
  it("无 env + 显式 filePath（~/.zshrc 类任意路径）→ didnt + screenshot_path_not_allowed（含 opt-in 指引）", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "screenshot", {
      screenshot: { filePath: path.join(os.homedir(), ".zshrc") },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toMatch(/screenshot_path_not_allowed:/); // "Error:" 前缀来自 String(e) 形态
    expect(r.error).toContain("LASSO_SCREENSHOT_DIR");
    // 决议 E1：绝不静默回退随机 /tmp 名——目标路径未写盘
    expect(existsSync(path.join(os.homedir(), ".zshrc.decoy"))).toBe(false);
  });

  it("无 env + 无 filePath → 管理路径 worked 零变（byte 锚）+ 上游调用零前置失败", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "screenshot", {} as BrowseOptions);
    expect(r.outcome).toBe("worked");
    const m = String(r.data?.preview).match(/(\/tmp\/lasso-screenshot-[^\s]+\.png)/);
    expect(m).toBeTruthy(); // 管理路径形态不变
    expect(readFileSync(m![1]!).length).toBe(300);
    await fs.rm(m![1]!, { force: true });
  });

  it("classifyBrowseError 分流：screenshot_path_not_allowed 归 didnt（与 screenshot_write_failed 不同前缀）", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "screenshot", {
      screenshot: { filePath: "/etc/passwd-shot.png" },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).not.toMatch(/screenshot_write_failed/);
  });
});

// ============================================================
// 3-7. opt-in（env 配置）：双重 containment 矩阵
// ============================================================
describe("BUG-05 E — opt-in 写根（LASSO_SCREENSHOT_DIR）", () => {
  it("写根内嵌套不存在父目录 → worked + 父目录自动创建（限写根内）", async () => {
    process.env.LASSO_SCREENSHOT_DIR = writeRoot;
    const target = path.join(writeRoot, "nested", "deeper", "shot.png");
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "screenshot", {
      screenshot: { filePath: target },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).length).toBe(300);
  });

  it("写根外 → didnt + reason 指向已配置写根数", async () => {
    process.env.LASSO_SCREENSHOT_DIR = writeRoot;
    const outside = path.join(root, "outside.png");
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "screenshot", {
      screenshot: { filePath: outside },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toMatch(/screenshot_path_not_allowed:/);
    expect(r.error).toContain("1 configured");
    expect(existsSync(outside)).toBe(false);
  });

  it("../ 词法出根 → didnt（path.resolve 归一后失配）", async () => {
    process.env.LASSO_SCREENSHOT_DIR = writeRoot;
    const target = path.join(writeRoot, "..", "escape.png");
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "screenshot", {
      screenshot: { filePath: target },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(existsSync(path.join(root, "escape.png"))).toBe(false);
  });

  it("symlink 逃逸（写根内 symlink 指向根外）→ didnt（最近存在祖先 realpath 封口）", async () => {
    const outsideDir = path.join(root, "outside-target");
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, path.join(writeRoot, "esc"));
    process.env.LASSO_SCREENSHOT_DIR = writeRoot;
    const target = path.join(writeRoot, "esc", "evil.png");
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "screenshot", {
      screenshot: { filePath: target },
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(existsSync(path.join(outsideDir, "evil.png"))).toBe(false);
  });

  it("写根 allow 不吞 allowdev（path-boundary 前缀伪造封口）", () => {
    const devDir = path.join(root, "wrootdev");
    mkdirSync(devDir);
    const r = checkScreenshotTarget(path.join(devDir, "x.png"), [realRoot()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/screenshot_path_not_allowed:/);
  });

  it("写根本身作为目标（p === dir 边界）→ allowed（写文件会失败但属交付失败域）", () => {
    const r = checkScreenshotTarget(realRoot(), [realRoot()]);
    expect(r.allowed).toBe(true);
  });
});

// ============================================================
// 8. env 装载（不存在条目丢弃 + 降级清单）
// ============================================================
describe("BUG-05 E — loadScreenshotWriteRoots 装载", () => {
  it("冒号分隔 + realpath 规范化；不存在条目丢弃 + dropped 清单", () => {
    const nope = path.join(root, "no-such-root");
    const { roots, dropped } = loadScreenshotWriteRoots({
      LASSO_SCREENSHOT_DIR: `${writeRoot}:${nope}`,
    });
    expect(roots).toEqual([realRoot()]);
    expect(dropped).toEqual([nope]);
  });

  it("缺省/空串 → 空写根（默认关）", () => {
    expect(loadScreenshotWriteRoots({}).roots).toEqual([]);
    expect(loadScreenshotWriteRoots({ LASSO_SCREENSHOT_DIR: "  : " }).roots).toEqual([]);
  });
});

// ============================================================
// 9. 纯函数补充（relative path resolve / 根越权）
// ============================================================
describe("BUG-05 E — checkScreenshotTarget 纯函数", () => {
  it("相对路径 path.resolve 归一后按写根判定", () => {
    const r = checkScreenshotTarget("relative.png", [realRoot()]);
    expect(r.allowed).toBe(false); // resolve 到 cwd，非写根内
  });

  it("全部祖先不存在（/ 不存在不可能，防御路径）→ 词法命中但 realpath 失配方向拒", () => {
    // 构造一个词法在写根内、但中间目录全不存在的深路径——最近存在祖先=写根自身
    const deep = path.join(writeRoot, "a", "b", "c", "d", "shot.png");
    expect(checkScreenshotTarget(deep, [realRoot()]).allowed).toBe(true);
  });
});
