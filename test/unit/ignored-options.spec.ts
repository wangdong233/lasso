/**
 * ignored-options.spec.ts（BUG-05 决议 D1，doc/bugs/05 §6 —— L-1 静默失效根治）
 *
 * 事故形态（novel-engine 台账 L-1）：action=navigate + options.screenshot →
 * worked 但零文件零告警（「schema 接受 → channel 零消费」静默失效，违
 * 「空输出≠空属性」）。裁决 A：navigate 不接线 screenshot（一步形态 =
 * action=screenshot 本身 NAV_FIRST）；D1：泛化 ignored_options 诚实标注。
 *
 * 覆盖：
 *  1. navigate 传 screenshot → worked + data.ignored_options=["screenshot"]
 *     （L-1 事故形态的直接回归锚——不再静默）
 *  2. 单 action 路径传 budget_ms（仅 steps 路径消费）→ 进 ignored_options
 *  3. 无死键 → 响应无 ignored_options 字段（byte-identical 基线）
 *  4. snapshot 传 include_refs → 进 ignored_options（超集标注；
 *     ignored_include_refs 仍只由 extract raw 档设置——两机制不冲突）
 *  5. evaluate 传 selectors → ignored_options=["selectors"]
 *  6. 【r1 锚】network 传 network_include_bodies（channel 直调注入）→ 进
 *     ignored_options；network_filter 是真消费键不进（消费表=实际消费键纪律）
 *  7. screenshot 传 screenshot+no_cache（NAV_FIRST 消费）→ 无 ignored_options
 *  8. steps 链路径 → 无 ignored_options（StepEngine 域，决议 D3 边界）
 *  9. CONSUMED_OPTIONS 与 actionDispatch 键集一致（INV-91 同源锚的测试面）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BrowseChannel,
  computeIgnoredOptions,
} from "../../src/channels/BrowseChannel.js";
import { setStateStoreContext } from "../../src/util/state-store.js";
import { _resetRunIdForTests, newRunId } from "../../src/util/run-id.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions, BrowseResult, InteractResult } from "../../src/types.js";

// ============================================================
// helpers
// ============================================================
const NETWORK_TEXT = [
  "## Network requests",
  "Showing 1 of 1 requests",
  "reqid=1 GET https://example.com/ [200]",
].join("\n");

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

function makeClient(toolNames: string[] = []): McpClient {
  return {
    callTool: vi.fn(async (name: string, _args: Record<string, unknown>) => {
      if (name === "list_network_requests") {
        return { content: [{ type: "text", text: NETWORK_TEXT }] };
      }
      if (name === "take_screenshot") {
        // image-block 形态（0.3.0 契约）——doScreenshot 路径 2 解码落盘
        return {
          content: [
            { type: "text", text: "# take_screenshot response" },
            {
              type: "image",
              data: pngBytes().toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      }
      return { content: [{ type: "text", text: `stubbed ${name}` }] };
    }),
    listTools: vi.fn(async () => toolNames.map((n) => ({ name: n }))),
    close: vi.fn(async () => {}),
    pid: 99999,
  } as unknown as McpClient;
}

class TestChannel extends BrowseChannel {
  readonly name = "browse_ignored_test";
  constructor(private readonly c: McpClient) {
    super();
  }
  protected getMcpClient(): Promise<McpClient> {
    return Promise.resolve(this.c);
  }
}

let tempCache: string;

beforeEach(() => {
  _resetRunIdForTests();
  newRunId();
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-ignored-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(async () => {
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
});

// ============================================================
// tests
// ============================================================
describe("BUG-05 D1 — ignored_options 诚实标注", () => {
  it("L-1 事故形态回归锚：navigate 传 options.screenshot → worked + ignored_options=[screenshot]（不再静默）", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "navigate", {
      screenshot: { filePath: "/tmp/should-not-exist.png", full: true },
      no_cache: true,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_options).toEqual(["screenshot"]);
    // 决议 A：navigate 不接线 screenshot——零文件是诚实语义（一步形态=screenshot action）
  });

  it("单 action 路径传 budget_ms（仅 steps 路径消费）→ 进 ignored_options", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "navigate", {
      budget_ms: 5000,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_options).toEqual(["budget_ms"]);
  });

  it("无死键 → 响应无 ignored_options 字段（byte-identical 基线）", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "navigate", {
      no_cache: true,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_options).toBeUndefined();
    // 序列化面也不出现该字段（省略而非空数组）
    expect(JSON.stringify(r.data)).not.toContain("ignored_options");
  });

  it("snapshot 传 include_refs → 进 ignored_options（超集标注）；ignored_include_refs 不设（extract raw 专属）", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "snapshot", {
      include_refs: true,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_options).toEqual(["include_refs"]);
    expect(r.data!.ignored_include_refs).toBeUndefined();
  });

  it("evaluate 传 selectors → ignored_options=[selectors]", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "evaluate", {
      js: "() => document.title",
      selectors: { click: "e1" },
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_options).toEqual(["selectors"]);
  });

  it("【r1 锚】network 传 network_include_bodies（channel 直调）→ 进 ignored_options；network_filter 真消费不进", async () => {
    const ch = new TestChannel(makeClient(["list_network_requests"]));
    const r = await ch.browse("https://example.com/", "network", {
      network_filter: "xhr",
      network_include_bodies: true,
      network_timeout_ms: 3000,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_options).toEqual([
      "network_include_bodies",
      "network_timeout_ms",
    ]);
    // 死键不被消费表豁免（表项=实际消费键，决议 r1 纪律）
  });

  it("screenshot 传 screenshot+no_cache（NAV_FIRST 消费）→ 无 ignored_options（no_cache 不误标）", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "screenshot", {
      screenshot: { full: true },
      no_cache: true,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.ignored_options).toBeUndefined();
    // 管理路径落盘物清理（真机纪律：测试不留残骸）
    const m = r.data!.preview.match(/(\/tmp\/lasso-screenshot-\S+\.png)/);
    if (m) await fs.rm(m[1], { force: true });
  });

  it("steps 链路径 → 无 ignored_options（StepEngine 域，决议 D3 边界）", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "navigate", {
      steps: [{ action: "navigate" }],
      budget_ms: 60000,
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data!.action).toBe("chain");
    expect(JSON.stringify(r.data)).not.toContain("ignored_options");
  });

  it("didnt 路径不标 ignored_options（unknown_action 自解释）", async () => {
    const ch = new TestChannel(makeClient());
    const r = await ch.browse("https://example.com/", "no_such_action", {
      js: "() => 1",
    } as BrowseOptions);
    expect(r.outcome).toBe("didnt");
    expect(r.error).toContain("unknown_action");
    expect(JSON.stringify(r)).not.toContain("ignored_options");
  });
});

// ============================================================
// INV-91 测试面：CONSUMED_OPTIONS 与 actionDispatch 键集一致
// ============================================================
describe("BUG-05 D1 — CONSUMED_OPTIONS 完备性（INV-91 测试面）", () => {
  it("computeIgnoredOptions 纯函数：消费键过滤 + 未注册 action 全量标", () => {
    expect(
      computeIgnoredOptions("navigate", {
        no_cache: true,
        js: "x",
      } as BrowseOptions),
    ).toEqual(["js"]);
    expect(computeIgnoredOptions("evaluate", {} as BrowseOptions)).toEqual([]);
  });

  it("消费表键集 === actionDispatch 键集（同源维护，INV-91）", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/channels/BrowseChannel.ts", import.meta.url)),
      "utf8",
    );
    const dispatchBlock = src.match(
      /protected readonly actionDispatch = new Map[\s\S]*?\n  \]\);/,
    )![0];
    const dispatchKeys = [...dispatchBlock.matchAll(/\["(\w+)",/g)].map(
      (m) => m[1],
    );
    const consumedBlock = src.match(
      /const CONSUMED_OPTIONS[\s\S]*?\n\}\);/,
    )![0];
    const consumedKeys = [...consumedBlock.matchAll(/^ {2}(\w+): \[/gm)].map(
      (m) => m[1],
    );
    expect(new Set(consumedKeys)).toEqual(new Set(dispatchKeys));
    // r1 锚：network 表项含 network_filter、不含死键
    const networkLine = consumedBlock.match(/^ {2}network: \[([^\]]*)\]/m)![1];
    expect(networkLine).toContain('"network_filter"');
    expect(networkLine).not.toContain("network_include_bodies");
    expect(networkLine).not.toContain("network_timeout_ms");
  });
});
