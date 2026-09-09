/**
 * file-guard.spec.ts（BUG-05 决议 B，doc/bugs/05 §4 —— L-2 file:// 白名单）
 *
 * 覆盖（决议 §7 新增测试矩阵 + B2 绕过面表逐条）：
 *  1. 空白名单默认拒：reason 与旧 ssrfGuard 输出**逐字节相等**（INV-90 字节锚）
 *  2. ssrfGuard 本体零改动旁证：file:// 仍 protocol_not_allowed:file:；
 *     ALLOWED_PROTOCOLS 恒 {http:,https:}（源码字面量锚）
 *  3. loadColonDirAllowlist：冒号解析 / realpath 规范化（symlink 归一）/
 *     不存在条目丢弃 + dropped 清单
 *  4. checkFileUrl 绕过矩阵：%2E%2E 编码穿越 / 词法 ../ / symlink 逃逸 /
 *     host 注入 / localhost 归一空 host / 不存在目标 / allow 不吞 allowdev
 *  5. isPathInside path-boundary（前缀伪造封口）
 *  6. fileGuardHint：空白名单 opt-in 指引 / 非空未命中 n 目录 / 非 file reason 无 hint
 *  7. 工具入口端到端（registerBrowseTools，真 ssrfGuard 不 mock）：file:// 默认拒
 *     payload = ssrf_blocked + hint；白名单内 URL 放行到达 channel
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkFileUrl,
  isFileProtocol,
  isFileGuardReason,
  fileGuardHint,
} from "../../src/ssrf/file-guard.js";
import {
  loadColonDirAllowlist,
  isPathInside,
} from "../../src/ssrf/dir-allowlist.js";
import { ssrfGuard, ssrfDenial, loadSsrfConfig } from "../../src/ssrf/ssrf-guard.js";
import type { SsrfConfig } from "../../src/ssrf/ssrf-guard.js";
import { registerBrowseTools } from "../../src/tools/browse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FallbackDecider } from "../../src/fallback/FallbackDecider.js";
import { CircuitBreaker } from "../../src/fallback/CircuitBreaker.js";
import type { BrowseResult, InteractResult } from "../../src/types.js";
import type { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type { LoggedInChannel } from "../../src/channels/LoggedInChannel.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import { BrowseChannel } from "../../src/channels/BrowseChannel.js";

// ============================================================
// fixtures
// ============================================================
let root: string;
let allowDir: string;
let outsideDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "lasso-file-guard-"));
  allowDir = path.join(root, "allow");
  outsideDir = path.join(root, "outside");
  mkdirSync(allowDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(path.join(allowDir, "page.html"), "<html><body>ok</body></html>");
  writeFileSync(path.join(outsideDir, "secret.html"), "<html>secret</html>");
  writeFileSync(path.join(allowDir, "secret-sibling.html"), "<html>x</html>");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fileUrl = (p: string) => `file://${p}`;
/** realpath 规范化后的 allowDir（装载器产物形态——双侧同规范）。 */
const realAllow = () => loadColonDirAllowlist(allowDir).dirs[0]!;

// ============================================================
// 1. 空白名单默认拒（INV-90 字节锚）
// ============================================================
describe("BUG-05 B — 空白名单默认拒（默认行为不变）", () => {
  it("checkFileUrl 空白名单 → reason 逐字节等于 protocol_not_allowed:file:", () => {
    const r = checkFileUrl(fileUrl(path.join(allowDir, "page.html")), []);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("protocol_not_allowed:file:");
    // 与旧 ssrfGuard 对 file:// 的输出逐字节相等（字节锚）
    const legacy = { allowed: false, reason: "protocol_not_allowed:file:", resolvedIps: [] };
    expect(r).toEqual(legacy);
  });

  it("ssrfDenial 映射：policy 确定性拒 → didnt + ssrf_blocked（非 DNS 瞬态）", () => {
    for (const reason of [
      "protocol_not_allowed:file:",
      "file_not_in_allowlist",
      "file_url_not_found",
      "file_url_host_not_allowed:evil.com",
    ]) {
      const d = ssrfDenial(reason);
      expect(d.outcome).toBe("didnt");
      expect(d.retrieval_method).toBe("ssrf_blocked");
      expect(d.error).toBe(`ssrf_blocked:${reason}`);
    }
  });

  it("ssrfGuard 本体零改动旁证：file:// 仍走协议白名单拒（守卫不读 fileAllowFrom）", async () => {
    const cfg: SsrfConfig = { allowRanges: [], denyRanges: [], fileAllowFrom: [realAllow()] };
    const r = await ssrfGuard(fileUrl(path.join(allowDir, "page.html")), cfg);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("protocol_not_allowed:file:");
  });

  it("ALLOWED_PROTOCOLS 恒 {http:,https:}（源码字面量锚——file 白名单不在本体）", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/ssrf/ssrf-guard.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(/const ALLOWED_PROTOCOLS = new Set\(\["http:", "https:"\]\)/);
    expect(src).not.toMatch(/ALLOWED_PROTOCOLS[^=]*=[^;]*file:/);
  });
});

// ============================================================
// 2. loadColonDirAllowlist
// ============================================================
describe("BUG-05 B — loadColonDirAllowlist 装载", () => {
  it("冒号分隔解析 + realpath 规范化（symlink 前缀归一：macOS /tmp 类）", () => {
    const a = mkdtempSync(path.join(os.tmpdir(), "fg-a-"));
    const b = mkdtempSync(path.join(os.tmpdir(), "fg-b-"));
    const { dirs, dropped } = loadColonDirAllowlist(`${a} : ${b} ::`);
    expect(dirs).toHaveLength(2);
    expect(dropped).toEqual([]);
    // 每条都是 realpath 形态（mkdtemp 目录自身即真实目录，realpath 幂等）
    for (const d of dirs) expect(checkFileUrl(`file://${d}/x.html`, [d]).reason).toBe("file_url_not_found");
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  it("不存在条目丢弃 + dropped 清单（绝不静默含糊）", () => {
    const { dirs, dropped } = loadColonDirAllowlist(
      `${path.join(root, "no-such-dir")}:${allowDir}`,
    );
    expect(dirs).toEqual([realAllow()]);
    expect(dropped).toEqual([path.join(root, "no-such-dir")]);
  });

  it("空串 / 纯空白 → 空表", () => {
    expect(loadColonDirAllowlist(undefined)).toEqual({ dirs: [], dropped: [] });
    expect(loadColonDirAllowlist("  :  :")).toEqual({ dirs: [], dropped: [] });
  });

  it("loadSsrfConfig：LASSO_ALLOW_FILE_FROM → fileAllowFrom（realpath 形态）；缺省省略字段", () => {
    const withFile = loadSsrfConfig({ LASSO_ALLOW_FILE_FROM: allowDir });
    expect(withFile.fileAllowFrom).toEqual([realAllow()]);
    const without = loadSsrfConfig({});
    expect(without.fileAllowFrom).toBeUndefined();
    // 既有字段形状零变化（12 个调用点无感）
    expect(without.allowRanges).toEqual([]);
    expect(without.denyRanges).toEqual([]);
  });
});

// ============================================================
// 3. checkFileUrl 绕过矩阵（B2 表逐条）
// ============================================================
describe("BUG-05 B — checkFileUrl 判定矩阵", () => {
  it("白名单内命中 → allowed", () => {
    const r = checkFileUrl(fileUrl(path.join(allowDir, "page.html")), [realAllow()]);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("词法 ../ 出根 → realpath 归一后失配拒（file_not_in_allowlist）", () => {
    const url = fileUrl(`${allowDir}/../outside/secret.html`);
    const r = checkFileUrl(url, [realAllow()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("file_not_in_allowlist");
  });

  it("%2E%2E 编码穿越出根 → 拒（WHATWG 解析期归一，B2 表锚）", () => {
    // 解析期归一：/allow/%2E%2E/outside/secret.html → /root/outside/secret.html
    //（node 实测 new URL 归一 %2E%2E 为 ..）→ 穿越目标真实存在 → realpath 失配拒
    const url = `file://${allowDir}/%2E%2E/outside/secret.html`;
    expect(new URL(url).pathname).toBe(`${outsideDir}/secret.html`);
    const r = checkFileUrl(url, [realAllow()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("file_not_in_allowlist");
  });

  it("%2F 编码斜杠穿越（解析期不归一）→ realpath-then-match 封口拒", () => {
    // %2E%2E%2F 解析期保持字面（node 实测）→ decodeURIComponent 还原 ../ →
    // realpathSync 解析后出根 → 边界匹配拒（realpath-then-match 兜底编码层差异）
    mkdirSync(path.join(allowDir, "sub"));
    const url = `file://${allowDir}/sub/%2E%2E%2F..%2F%2Foutside%2Fsecret.html`;
    const r = checkFileUrl(url, [realAllow()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("file_not_in_allowlist");
  });

  it("编码穿越到真实存在的外部目标 → file_not_in_allowlist（realpath-then-match 封口）", () => {
    // 构造：allow/sub 存在，穿越目标 outside/secret.html 存在
    mkdirSync(path.join(allowDir, "sub"));
    const url = `file://${allowDir}/sub/../../outside/secret.html`;
    const r = checkFileUrl(url, [realAllow()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("file_not_in_allowlist");
  });

  it("symlink 逃逸 → 拒（realpath 解引用）", () => {
    symlinkSync(outsideDir, path.join(allowDir, "esc"));
    const r = checkFileUrl(fileUrl(path.join(allowDir, "esc", "secret.html")), [realAllow()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("file_not_in_allowlist");
  });

  it("host 注入（file://evil.com/x）→ file_url_host_not_allowed:evil.com", () => {
    const r = checkFileUrl("file://evil.com/etc/passwd", [realAllow()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("file_url_host_not_allowed:evil.com");
  });

  it("file://localhost 归一为空 host（WHATWG 语义）→ 走路径判定不因 host 拒", () => {
    const r = checkFileUrl(`file://localhost${path.join(allowDir, "page.html")}`, [realAllow()]);
    // host 归一为空 → 不命中 host 拒（存在则 allowed；此处文件存在应放行）
    expect(r.reason).not.toMatch(/^file_url_host_not_allowed/);
    expect(r.allowed).toBe(true);
  });

  it("不存在目标 → file_url_not_found（诚实前置，Chrome 本也会错误页）", () => {
    const r = checkFileUrl(fileUrl(path.join(allowDir, "nope.html")), [realAllow()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("file_url_not_found");
  });

  it("allow 不吞 allowdev（path-boundary，前缀伪造封口）", () => {
    const devDir = path.join(root, "allowdev");
    mkdirSync(devDir);
    writeFileSync(path.join(devDir, "x.html"), "x");
    const r = checkFileUrl(fileUrl(path.join(devDir, "x.html")), [realAllow()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("file_not_in_allowlist");
  });

  it("URL 解析失败（空白名单外路径不可达，函数全量性）→ invalid_url", () => {
    const r = checkFileUrl("not-a-url", [realAllow()]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("invalid_url");
  });
});

// ============================================================
// 4. isPathInside / isFileProtocol / hint
// ============================================================
describe("BUG-05 B — helpers", () => {
  it("isPathInside：相等命中 / 子树命中 / 前缀伪造拒 / 根目录边界", () => {
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/b/c.png", "/a/b")).toBe(true);
    expect(isPathInside("/a/bdev/c.png", "/a/b")).toBe(false);
    expect(isPathInside("/x", "/a/b")).toBe(false);
    expect(isPathInside("/etc/passwd", "/")).toBe(true);
  });

  it("isFileProtocol：file:// true / http false / 垃圾串 false", () => {
    expect(isFileProtocol("file:///etc/passwd")).toBe(true);
    expect(isFileProtocol("https://example.com/")).toBe(false);
    expect(isFileProtocol("not-a-url")).toBe(false);
  });

  it("fileGuardHint：空白名单 → opt-in 指引；非空未命中 → 目录数指引；非 file reason → undefined", () => {
    const emptyHint = fileGuardHint("protocol_not_allowed:file:", []);
    expect(emptyHint).toContain("LASSO_ALLOW_FILE_FROM");
    const missHint = fileGuardHint("file_not_in_allowlist", ["/a", "/b"]);
    expect(missHint).toContain("2 configured");
    expect(fileGuardHint("protocol_not_allowed:ftp:", [])).toBeUndefined();
    expect(fileGuardHint("private_ip:10.0.0.1", [])).toBeUndefined();
  });

  it("isFileGuardReason 识别 file: 族", () => {
    expect(isFileGuardReason("protocol_not_allowed:file:")).toBe(true);
    expect(isFileGuardReason("file_not_in_allowlist")).toBe(true);
    expect(isFileGuardReason("file_url_not_found")).toBe(true);
    expect(isFileGuardReason("file_url_host_not_allowed:x")).toBe(true);
    expect(isFileGuardReason("protocol_not_allowed:ftp:")).toBe(false);
  });
});

// ============================================================
// 5. 工具入口端到端（registerBrowseTools；真 ssrfGuard 不 mock）
// ============================================================
/** 真 BrowseChannel 子类（fake McpClient）——file:// 放行后应到达 channel。 */
class EntryTestChannel extends BrowseChannel {
  readonly name = "browse_entry_test";
  constructor(private readonly c: McpClient) {
    super();
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.c);
  }
}

function makeCaptureServer() {
  const captured: Array<{
    name: string;
    handler: (args: never) => Promise<unknown>;
  }> = [];
  const server = {
    tool: vi.fn(
      (
        name: string,
        _desc: string,
        _schema: unknown,
        _ann: unknown,
        handler: (args: never) => Promise<unknown>,
      ) => {
        captured.push({ name, handler });
        return { enabled: true, disable() {}, enable() {}, remove() {}, update() {} };
      },
    ),
    sendToolListChanged: vi.fn(),
  } as unknown as McpServer;
  return { server, captured };
}

import { vi } from "vitest";

function makeFakeClient(): McpClient {
  return {
    callTool: vi.fn(async (name: string) => ({
      content: [{ type: "text", text: `stubbed ${name}` }],
    })),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
  } as unknown as McpClient;
}

function makeStubChannels() {
  const client = makeFakeClient();
  const headless = new EntryTestChannel(client) as unknown as HeadlessChannel;
  const logged_in = new EntryTestChannel(client) as unknown as LoggedInChannel;
  return { headless, logged_in };
}

function makeDecider() {
  return new FallbackDecider(
    new Map<string, CircuitBreaker>([
      ["browse_headless", new CircuitBreaker()],
      ["browse_logged_in", new CircuitBreaker()],
    ]),
  );
}

describe("BUG-05 B — 工具入口端到端（file: 路由）", () => {
  it("默认（无 env 白名单）：file:// → didnt + ssrf_blocked:protocol_not_allowed:file: + hint；channel 零调用", async () => {
    const { server, captured } = makeCaptureServer();
    const { headless, logged_in } = makeStubChannels();
    const decider = makeDecider();
    registerBrowseTools(server, headless, logged_in, decider, {
      allowRanges: [],
      denyRanges: [],
    });
    const handler = captured.find((c) => c.name === "browse_headless")!.handler;
    const res = (await handler({
      url: fileUrl(path.join(allowDir, "page.html")),
      action: "snapshot",
    } as never)) as { content: Array<{ text: string }> };
    const payload = JSON.parse(res.content[0]!.text) as InteractResult<never> & {
      hint?: string;
    };
    expect(payload.outcome).toBe("didnt");
    expect(payload.error).toBe("ssrf_blocked:protocol_not_allowed:file:");
    expect(payload.hint).toContain("LASSO_ALLOW_FILE_FROM");
  });

  it("白名单命中：file:// → 放行到达 channel（worked 响应来自 fake client）", async () => {
    const { server, captured } = makeCaptureServer();
    const { headless, logged_in } = makeStubChannels();
    const decider = makeDecider();
    registerBrowseTools(server, headless, logged_in, decider, {
      allowRanges: [],
      denyRanges: [],
      fileAllowFrom: [realAllow()],
    });
    const handler = captured.find((c) => c.name === "browse_headless")!.handler;
    const res = (await handler({
      url: fileUrl(path.join(allowDir, "page.html")),
      action: "snapshot",
    } as never)) as { content: Array<{ text: string }> };
    const payload = JSON.parse(res.content[0]!.text) as InteractResult<BrowseResult>;
    expect(payload.outcome).toBe("worked");
  });

  it("白名单非空未命中：file:// → didnt + file_not_in_allowlist + 目录数 hint", async () => {
    const { server, captured } = makeCaptureServer();
    const { headless, logged_in } = makeStubChannels();
    const decider = makeDecider();
    registerBrowseTools(server, headless, logged_in, decider, {
      allowRanges: [],
      denyRanges: [],
      fileAllowFrom: [realAllow()],
    });
    const handler = captured.find((c) => c.name === "browse_headless")!.handler;
    const res = (await handler({
      url: fileUrl(path.join(outsideDir, "secret.html")),
      action: "snapshot",
    } as never)) as { content: Array<{ text: string }> };
    const payload = JSON.parse(res.content[0]!.text) as InteractResult<never> & {
      hint?: string;
    };
    expect(payload.outcome).toBe("didnt");
    expect(payload.error).toBe("ssrf_blocked:file_not_in_allowlist");
    expect(payload.hint).toContain("1 configured");
  });

  it("browse_logged_in 入口同路由（file: 默认拒 + hint）", async () => {
    const { server, captured } = makeCaptureServer();
    const { headless, logged_in } = makeStubChannels();
    const decider = makeDecider();
    registerBrowseTools(server, headless, logged_in, decider, {
      allowRanges: [],
      denyRanges: [],
    });
    const handler = captured.find((c) => c.name === "browse_logged_in")!.handler;
    const res = (await handler({
      url: "file:///etc/passwd",
      action: "snapshot",
    } as never)) as { content: Array<{ text: string }> };
    const payload = JSON.parse(res.content[0]!.text) as InteractResult<never> & {
      hint?: string;
    };
    expect(payload.outcome).toBe("didnt");
    expect(payload.error).toBe("ssrf_blocked:protocol_not_allowed:file:");
    expect(payload.hint).toContain("LASSO_ALLOW_FILE_FROM");
  });
});
