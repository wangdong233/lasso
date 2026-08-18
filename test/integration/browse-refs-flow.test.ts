/**
 * browse include_refs / ref 句柄集成测（v1.17 Phase F，parse24 §6.2 C2）
 *
 * 硬验收（parse24 §6.2 测试清单 + 冲突 #8）：
 *  - 缺省关 byte-identical：include_refs 未传 / false → 与 v1.16 markdown 输出
 *    完全一致（无附录、expr 无注入、data 无新字段）
 *  - markdown + include_refs → "## Interactive refs" 附录 + refs 注入 expr
 *  - raw + include_refs → 运行时忽略 + data.ignored_include_refs:true（schema 不拒）
 *  - click by ref 往返：evaluate_script 定位 JS click（不走上游 click 工具）
 *  - ref 失效 → outcome=didnt + ref_stale_re_snapshot（不猜不自动重试）
 *  - fill by ref：预检 → native setter 填充；混合表 uid 部分照旧 fill_form；
 *    纯 uid 表 = 现行 fill_form 路径 byte-identical
 *
 * 测试策略：HeadlessChannel + stub McpClient（evaluate_script 按 expr 特征路由），
 * 不 spawn 真实 chrome-devtools-mcp（与 markdown-extract-flow.test.ts 同范式）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import { HeadlessChannel } from "../../src/channels/HeadlessChannel.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { SubprocessManager } from "../../src/subprocess/SubprocessManager.js";
import type { BrowseOptions } from "../../src/types.js";
import { mockEvalResponse } from "../helpers/upstream-mock.js";

// ============================================================
// fixtures
// ============================================================
const HTML_FIXTURE =
  `<html><head><title>Ref Page</title></head><body>` +
  `<nav><a href="/home">Home</a> | <a href="/about">About</a></nav>` +
  `<article><h1>Ref Page</h1><p>Main content.</p>` +
  `<button>Submit</button>` +
  `<input type="search" placeholder="Search…" />` +
  `</article></body></html>`;

/** stub extract-refs expr 返回的 refs（与 HTML_FIXTURE 的交互元素对应）。 */
const REFS_FIXTURE = [
  { ref: "r1", tag: "a", text: "Home", href: "/home" },
  { ref: "r2", tag: "a", text: "About", href: "/about" },
  { ref: "r3", tag: "button", text: "Submit" },
  { ref: "r4", tag: "input", type: "search", text: "Search…" },
];

/** ref 操作的 stub 应答（按 expr 特征路由）。 */
interface RefStubs {
  click?: { ok: boolean; reason?: string; tag?: string };
  locate?: { ok: boolean; missing?: string[] };
  fill?: { ok: boolean; filled?: string[]; errors?: string[] };
}

function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

/**
 * stub McpClient：
 *  - take_snapshot → a11y 文本树（raw 路径）
 *  - evaluate_script 按 expr 特征路由：
 *      · 含 data-lasso-uid 注入（extract refs expr）→ {html,url,title,refs}
 *      · 含 el.click()（ref click）→ stubs.click
 *      · 含 var missing（locate 预检）→ stubs.locate
 *      · 含 var filled（ref fill）→ stubs.fill
 *      · 其余（缺省 extract expr）→ {html,url,title}
 *  - click / fill_form 上游工具记录调用（ref 路径必须 NOT 调）
 */
function makeStubClient(stubs: RefStubs = {}): {
  client: McpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const stub: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "take_snapshot") {
        return textContent("Ref Page\n\nMain content. Submit Search…");
      }
      if (name === "evaluate_script") {
        const fn = String(args.function ?? "");
        if (fn.includes("data-lasso-uid") && fn.includes("querySelectorAll")) {
          return mockEvalResponse({
            html: HTML_FIXTURE,
            url: "https://example.com/",
            title: "Ref Page",
            refs: REFS_FIXTURE,
          });
        }
        if (fn.includes("el.click()")) {
          return mockEvalResponse(stubs.click ?? { ok: true, tag: "button" });
        }
        if (fn.includes("var missing")) {
          return mockEvalResponse(stubs.locate ?? { ok: true, missing: [] });
        }
        if (fn.includes("var filled")) {
          return mockEvalResponse(stubs.fill ?? { ok: true, filled: ["r1"], errors: [] });
        }
        // 缺省 extract expr（无 refs）
        return mockEvalResponse({
          html: HTML_FIXTURE,
          url: "https://example.com/",
          title: "Ref Page",
        });
      }
      return textContent(`stubbed ${name}`);
    }),
    listTools: vi.fn(async () => [{ name: "take_snapshot", inputSchema: {} }]),
    close: vi.fn(async () => {}),
    pid: 12345,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client: stub, calls };
}

function makeChannel(client: McpClient): HeadlessChannel {
  const fakeSubproc = {
    registerSpec: vi.fn(),
    touch: vi.fn(),
    ensureRunning: vi.fn(async () => client),
    shutdown: vi.fn(async () => {}),
    healthProbe: vi.fn(async () => "healthy"),
  } as unknown as SubprocessManager;
  return new HeadlessChannel(fakeSubproc);
}

function makeHeadless(stubs: RefStubs = {}): {
  channel: HeadlessChannel;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const { client, calls } = makeStubClient(stubs);
  return { channel: makeChannel(client), calls };
}

// ============================================================
// setup
// ============================================================
let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-refs-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(async () => {
  try {
    await fs.rm(tempCache, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function extract(channel: HeadlessChannel, opts: BrowseOptions) {
  return channel.browse("https://example.com/", "extract", opts);
}

// ============================================================
// 缺省关 byte-identical（INV-66 手法）
// ============================================================
describe("include_refs 缺省关 — byte-identical 基线", () => {
  it("markdown 档：include_refs 未传 vs false → 输出 byte-identical，无附录", async () => {
    const { channel: ch1 } = makeHeadless();
    const r1 = await extract(ch1, { extract_mode: "markdown" });
    const { channel: ch2 } = makeHeadless();
    const r2 = await extract(ch2, { extract_mode: "markdown", include_refs: false });

    expect(r1.outcome).toBe("worked");
    expect(r1.data!.preview).toBe(r2.data!.preview);
    // 无附录
    expect(r1.data!.preview).not.toContain("## Interactive refs");
    // 无新字段
    expect(r1.data!.ignored_include_refs).toBeUndefined();
    expect(r2.data!.ignored_include_refs).toBeUndefined();
  });

  it("markdown 档缺省：expr 无 refs 注入（不含 data-lasso-uid setAttribute）", async () => {
    const { channel, calls } = makeHeadless();
    await extract(channel, { extract_mode: "markdown" });
    const evalCalls = calls.filter((c) => c.name === "evaluate_script");
    expect(evalCalls).toHaveLength(1);
    const fn = String(evalCalls[0].args.function);
    expect(fn).not.toContain("data-lasso-uid");
    expect(fn).toContain("outerHTML");
  });

  it("raw 档缺省：无 ignored_include_refs 字段（v1.0 byte-identical）", async () => {
    const { channel } = makeHeadless();
    const r = await extract(channel, {});
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_include_refs).toBeUndefined();
  });
});

// ============================================================
// markdown + include_refs
// ============================================================
describe("extract_mode=markdown + include_refs=true — refs 附录", () => {
  it("preview 末尾追加 '## Interactive refs' 附录（正文零内嵌）", async () => {
    const { channel } = makeHeadless();
    const r = await extract(channel, { extract_mode: "markdown", include_refs: true });
    expect(r.outcome).toBe("worked");
    const p = r.data!.preview;
    // 附录存在且在末尾
    expect(p).toContain("## Interactive refs");
    expect(p.indexOf("## Interactive refs")).toBeGreaterThan(p.indexOf("Main content"));
    // 黄金行格式
    expect(p).toContain(`- [r1] a "Home" → /home`);
    expect(p).toContain(`- [r2] a "About" → /about`);
    expect(p).toContain(`- [r3] button "Submit"`);
    expect(p).toContain(`- [r4] input[type=search] "Search…"`);
    // 正文零内嵌标记（无 [r1] 出现在附录行之外）
    expect(p.match(/\[r\d+\]/g)?.length).toBe(4);
  });

  it("expr 走注入路径（含 data-lasso-uid setAttribute + refs 收集）", async () => {
    const { channel, calls } = makeHeadless();
    await extract(channel, { extract_mode: "markdown", include_refs: true });
    const evalCalls = calls.filter((c) => c.name === "evaluate_script");
    expect(evalCalls).toHaveLength(1);
    const fn = String(evalCalls[0].args.function);
    expect(fn).toContain("data-lasso-uid");
    expect(fn).toContain("setAttribute");
    expect(fn).toContain("refs");
  });

  it("markdown 别名字段（data.markdown）同含附录", async () => {
    const { channel } = makeHeadless();
    const r = await extract(channel, { extract_mode: "markdown", include_refs: true });
    expect(r.data!.markdown).toBeTruthy();
    expect(r.data!.markdown).toContain("## Interactive refs");
  });

  it("refs 空（页面无交互元素）→ 无附录节（诚实，不产空节）", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const inner = makeStubClient();
    const wrapped: McpClient = {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "evaluate_script") {
          return mockEvalResponse({
            html: HTML_FIXTURE,
            url: "https://example.com/",
            title: "Ref Page",
            refs: [],
          });
        }
        return (
          inner.client as unknown as {
            callTool: (n: string, a: Record<string, unknown>) => Promise<unknown>;
          }
        ).callTool(name, args);
      }),
      listTools: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    } as unknown as McpClient;
    const channel = makeChannel(wrapped);
    const r = await extract(channel, { extract_mode: "markdown", include_refs: true });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).not.toContain("## Interactive refs");
  });

  it("markdown_cited 档 + include_refs → 附录同样追加", async () => {
    const { channel } = makeHeadless();
    const r = await extract(channel, {
      extract_mode: "markdown_cited",
      include_refs: true,
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toContain("## Interactive refs");
  });
});

// ============================================================
// raw + include_refs（冲突 #8：宽松进严格出）
// ============================================================
describe("extract_mode=raw + include_refs=true — 运行时忽略 + 诚实标注", () => {
  it("走 take_snapshot（不走 evaluate_script）+ data.ignored_include_refs=true", async () => {
    const { channel, calls } = makeHeadless();
    const r = await extract(channel, { include_refs: true });
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_include_refs).toBe(true);
    const names = calls.map((c) => c.name);
    expect(names).toContain("take_snapshot");
    expect(names).not.toContain("evaluate_script");
    // preview 与 raw 基线一致（忽略 = 不改变输出内容本身）
    const { channel: chBase } = makeHeadless();
    const base = await extract(chBase, {});
    expect(r.data!.preview).toBe(base.data!.preview);
  });

  it("extract_mode 显式 'raw' + include_refs=true → 同款忽略标注", async () => {
    const { channel } = makeHeadless();
    const r = await extract(channel, { extract_mode: "raw", include_refs: true });
    expect(r.data!.ignored_include_refs).toBe(true);
  });
});

// ============================================================
// click by ref 往返
// ============================================================
describe("click by ref — 往返", () => {
  it("selectors.click='r3' → evaluate_script JS click（不走上游 click 工具）", async () => {
    const { channel, calls } = makeHeadless({ click: { ok: true, tag: "button" } });
    const r = await channel.browse("https://example.com/", "click", {
      selectors: { click: "r3" },
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toContain("clicked r3");
    expect(r.data!.preview).toContain("lasso ref");
    // 不走上游 click 工具（ref 路径独立）
    expect(calls.some((c) => c.name === "click")).toBe(false);
    // 走 evaluate_script 且 expr 定位 data-lasso-uid
    const evalCalls = calls.filter((c) => c.name === "evaluate_script");
    expect(evalCalls).toHaveLength(1);
    expect(String(evalCalls[0].args.function)).toContain("data-lasso-uid");
    expect(String(evalCalls[0].args.function)).toContain("r3");
  });

  it("普通 uid 照旧走上游 click（现行路径 byte-identical）", async () => {
    const { channel, calls } = makeHeadless();
    const r = await channel.browse("https://example.com/", "click", {
      selectors: { click: "abc123" },
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("clicked abc123");
    expect(calls.some((c) => c.name === "click" && c.args.uid === "abc123")).toBe(true);
  });

  it("ref 失效 → outcome=didnt + ref_stale_re_snapshot（不猜不自动重试）", async () => {
    const { channel, calls } = makeHeadless({ click: { ok: false, reason: "ref_stale" } });
    const r = await channel.browse("https://example.com/", "click", {
      selectors: { click: "r9" },
    });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("ref_stale_re_snapshot");
    expect(r.error).toContain("r9");
    // 无上游 click 调用（未盲试）
    expect(calls.some((c) => c.name === "click")).toBe(false);
  });
});

// ============================================================
// fill by ref
// ============================================================
describe("fill by ref — 预检 + native setter", () => {
  it("纯 ref 表 → locate 预检 + fill expr（不走 fill_form）", async () => {
    const { channel, calls } = makeHeadless({
      locate: { ok: true, missing: [] },
      fill: { ok: true, filled: ["r4"], errors: [] },
    });
    const r = await channel.browse("https://example.com/", "fill", {
      selectors: { r4: "query text" },
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("filled 1 fields (1 via lasso ref)");
    expect(calls.some((c) => c.name === "fill_form")).toBe(false);
    // 两次 evaluate（locate → fill）
    const evals = calls.filter((c) => c.name === "evaluate_script");
    expect(evals).toHaveLength(2);
    expect(String(evals[0].args.function)).toContain("var missing");
    expect(String(evals[1].args.function)).toContain("var filled");
  });

  it("混合表（ref + uid）→ ref 走 expr，uid 部分照旧 fill_form", async () => {
    const { channel, calls } = makeHeadless({
      locate: { ok: true, missing: [] },
      fill: { ok: true, filled: ["r4"], errors: [] },
    });
    const r = await channel.browse("https://example.com/", "fill", {
      selectors: { r4: "query", uidX: "name" },
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("filled 2 fields (1 via lasso ref)");
    const fillForm = calls.find((c) => c.name === "fill_form");
    expect(fillForm).toBeTruthy();
    expect(fillForm!.args.elements).toEqual([{ uid: "uidX", value: "name" }]);
  });

  it("ref 预检 miss → didnt + ref_stale_re_snapshot，无任何填充副作用", async () => {
    const { channel, calls } = makeHeadless({
      locate: { ok: false, missing: ["r5"] },
    });
    const r = await channel.browse("https://example.com/", "fill", {
      selectors: { r5: "x", uidX: "y" },
    });
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("ref_stale_re_snapshot");
    expect(r.error).toContain("r5");
    // 副作用零：无 fill expr、无 fill_form
    expect(calls.some((c) => c.name === "fill_form")).toBe(false);
    expect(
      calls.some((c) => c.name === "evaluate_script" && String(c.args.function).includes("var filled")),
    ).toBe(false);
  });

  it("纯 uid 表（无 ref 键）→ 现行 fill_form 路径 byte-identical", async () => {
    const { channel, calls } = makeHeadless();
    const r = await channel.browse("https://example.com/", "fill", {
      selectors: { uidA: "v1", uidB: "v2" },
    });
    expect(r.outcome).toBe("worked");
    expect(r.data!.preview).toBe("filled 2 fields");
    const fillForm = calls.find((c) => c.name === "fill_form");
    expect(fillForm!.args.elements).toEqual([
      { uid: "uidA", value: "v1" },
      { uid: "uidB", value: "v2" },
    ]);
    // 无 evaluate（不经 ref 路径）
    expect(calls.some((c) => c.name === "evaluate_script")).toBe(false);
  });

  it("fill expr 返回 errors（非 stale 的填充异常）→ unknown 档（不伪装）", async () => {
    const { channel } = makeHeadless({
      locate: { ok: true, missing: [] },
      fill: { ok: false, filled: [], errors: ["r4:TypeError: boom"] },
    });
    const r = await channel.browse("https://example.com/", "fill", {
      selectors: { r4: "x" },
    });
    // ref_fill_failed 不属 didnt 签名集 → unknown（classifyBrowseError 默认档）
    expect(r.outcome).toBe("unknown");
    expect(r.error).toContain("ref_fill_failed");
  });
});
