/**
 * bug09-chain-truth.spec.ts（§8.B 开放项 5，doc/bugs/09 尾款轮，2026-09-16）
 *
 * steps 链 final_url/did_navigate 真值化——dispatch 矩阵扩展：
 *   steps × {navigate 先导, 链内 navigate step, 残留页, url==当前页}
 *        × {final_url 来源真值断言, did_navigate 值, sd 双标注透传, 尾读失败省略}
 *
 * 消灭的谎言（R2-1 行为本体）：
 *  - StepEngine 旧恒写 `final_url: url`（请求串回显）——残留页形态链谎称目标页；
 *  - browse() 先导导航 partial 直接丢弃——final_url/sd 双标注链级不可见；
 *  - 链结果无 did_navigate——「url 是装饰」在链形态续存。
 *
 * 真值模型（§8.B 真值矩阵）：
 *   final_url 来源优先级 = 链尾真值读（applyChainUrlTruth）→ 种子（最后携带
 *   final_url 的 step partial / entryNav.final_url，经**种子等值守卫**：候选 ===
 *   请求串 ⇒ 视同缺席——doNavigate `extractFinalUrl(r) ?? url` 的请求串回退
 *   无法与真值区分）→ 省略。**永不回显请求串**。
 *   did_navigate = entryNav 在场 ∨ 任一 worked navigate step。
 *
 * 全 mock McpClient（bug09-b spec 同范式）——零真浏览器。值断言纪律：断言用
 * landing ≠ request 形态（页面真落于请求 URL 时尾读=请求串属真值——来源判据
 * 非值判据，INV-100 同措辞）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
function fencedEval(value: string) {
  return { content: [{ type: "text", text: "```\n" + value + "\n```" }], isError: false };
}
function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

const TOOLS_170 = [
  "navigate_page",
  "take_snapshot",
  "take_screenshot",
  "evaluate_script",
  "wait_for",
  "click",
  "fill_form",
  "list_pages",
  "select_page",
  "list_network_requests",
  "list_console_messages",
  "pdf",
];

/**
 * 可编程 client（链真值专用）：
 *  - hrefs：`() => location.href` 读（readCurrentHref）按序出队——doNavigate
 *    前读 + 链尾真值读共用该队列；耗尽后重复末位；
 *  - hrefReadThrows：该读全抛（模拟页面死亡/evaluate 不可用——尾读失败形态）；
 *  - navigateProse：navigate_page 第 n 次的散文回复（含/不含 http(s) 子串
 *    控制 extractFinalUrl 命中与否——种子等值守卫的对照面）。
 */
function makeChainClient(opts: {
  hrefs: string[];
  hrefReadThrows?: boolean;
  navigateProse?: (n: number) => string;
}) {
  const counts = new Map<string, number>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      if (name === "navigate_page") {
        const prose = opts.navigateProse?.(n) ?? "navigated";
        return textContent(prose) as never;
      }
      if (name === "evaluate_script") {
        const fn = String(args.function ?? "");
        if (fn.trim() === "() => location.href") {
          if (opts.hrefReadThrows) throw new Error("eval_upstream_error:dead page");
          const href = opts.hrefs[Math.min(n - 1, opts.hrefs.length - 1)];
          return fencedEval(JSON.stringify(href)) as never;
        }
        // quickSnapshot（body_text）/ verifyNavigatedPage 状态探针：benign 0
        return fencedEval("0") as never;
      }
      if (name === "take_snapshot") {
        return textContent("Example Domain\n\nWelcome to the page.") as never;
      }
      return textContent(`stubbed ${name}`) as never;
    }),
    listTools: vi.fn(async () => TOOLS_170.map((t) => ({ name: t, inputSchema: {} }))),
    close: vi.fn(async () => {}),
    pid: 99999,
    stderr: null,
    isConnected: true,
  } as unknown as McpClient;
  return { client, calls };
}

class TruthTestChannel extends BrowseChannel {
  readonly name = "browse_test_chain_truth";
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
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-b09truth-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
});

// ============================================================
// 矩阵 §8.B：navigate 先导族
// ============================================================
describe("§8.B 链真值矩阵 — action:navigate + steps（先导导航）", () => {
  it("尾读成功 → final_url = 链尾真值（覆盖先导 nav final_url）；did_navigate=true；无 sd 标注", async () => {
    const REQUEST = "https://target.test/";
    const { client } = makeChainClient({
      // hrefs[0] = 先导 doNavigate 前读（about:blank → 非同文档 → 正常导航）
      // hrefs[1] = 链尾真值读（链内 snapshot 后页面真实落点——与 nav 落点不同，
      //            断言「尾读覆盖种子」用的是 landing ≠ nav-landing 形态）
      hrefs: ["about:blank", "https://target.test/after-steps"],
      navigateProse: () => "Navigated to https://target.test/real.",
    });
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "navigate", {
      steps: [{ action: "snapshot" }],
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data?.action).toBe("chain");
    // 尾读真值 ≠ nav 落点 ≠ 请求串——三级可区分形态下断言取地面真值
    expect(r.data?.final_url).toBe("https://target.test/after-steps");
    expect(r.data?.did_navigate).toBe(true);
    expect(r.data?.same_document_navigated).toBeUndefined();
    // data.url 同步为真值（旧形态=请求串装饰回显）
    expect(r.data?.url).toBe("https://target.test/after-steps");
  });

  it("先导导航 hash-only → sd 双标注透传（含补 reload 事实）+ did_navigate=true", async () => {
    const REQUEST = "https://example.com/page#x";
    const { client } = makeChainClient({
      // 前读 = 同页面（hash 前）→ isSameDocumentNavigation 命中 → 默认补 reload
      hrefs: ["https://example.com/page", "https://example.com/page#x"],
      navigateProse: () => "Navigated to https://example.com/page#x.",
    });
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "navigate", {
      steps: [{ action: "snapshot" }],
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data?.same_document_navigated).toBe(true);
    expect(r.data?.same_document_reloaded).toBe(true);
    expect(r.data?.did_navigate).toBe(true);
    expect(r.data?.final_url).toBe("https://example.com/page#x");
  });

  it("尾读失败 → final_url = 先导 nav final_url 种子（landing ≠ 请求串形态）", async () => {
    const REQUEST = "https://target.test/";
    const { client } = makeChainClient({
      hrefs: ["about:blank"],
      hrefReadThrows: true, // 页面死亡——尾读失败形态
      navigateProse: () => "Navigated to https://target.test/real.",
    });
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "navigate", {
      steps: [{ action: "snapshot" }],
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // 种子 = 先导 nav 落点（真值来自 navigate 往返）
    expect(r.data?.final_url).toBe("https://target.test/real");
    expect(r.data?.did_navigate).toBe(true);
  });

  it("尾读失败 ∧ 上游散文无 http(s) 子串（extractFinalUrl miss → doNavigate 回退请求串）→ data.final_url 缺席（种子等值守卫——请求串回显不得洗白进链级真值）", async () => {
    const REQUEST = "https://target.test/";
    const { client } = makeChainClient({
      hrefs: ["about:blank"],
      hrefReadThrows: true,
      navigateProse: () => "some opaque upstream prose without any url",
    });
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "navigate", {
      steps: [{ action: "snapshot" }],
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // 守卫本体：种子候选 === 请求串 ⇒ 视同缺席（省略而非回显）
    expect(r.data?.final_url).toBeUndefined();
    expect(JSON.stringify(r.data)).not.toContain('"final_url":"https://target.test/"');
    // 导航事实仍在（did_navigate 不受回显档影响）
    expect(r.data?.did_navigate).toBe(true);
  });
});

// ============================================================
// 矩阵 §8.B：链内 navigate step 族
// ============================================================
describe("§8.B 链真值矩阵 — 链内 worked navigate step", () => {
  it("navigate step worked → did_navigate=true（无先导导航也成立）+ 尾读真值", async () => {
    const REQUEST = "https://target.test/";
    const { client } = makeChainClient({
      // hrefs[0] = 链内 navigate step 的 doNavigate 前读；hrefs[1] = 尾读
      hrefs: ["about:blank", "https://target.test/step-landing"],
      navigateProse: () => "Navigated to https://target.test/step-landing.",
    });
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "extract", {
      steps: [{ action: "navigate" }, { action: "snapshot" }],
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data?.did_navigate).toBe(true);
    expect(r.data?.final_url).toBe("https://target.test/step-landing");
  });

  it("navigate step 非 worked（didnt 终止链）→ did_navigate=false（导航未发生——不虚报）", async () => {
    const REQUEST = "https://target.test/";
    // navigate_page 抛错 → executeStep classify → didnt → 链终止
    const counts = new Map<string, number>();
    const client: McpClient = {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
        const n = (counts.get(name) ?? 0) + 1;
        counts.set(name, n);
        if (name === "navigate_page") throw new Error("dns_or_nav_error:boom");
        if (name === "evaluate_script") {
          const fn = String(args.function ?? "");
          if (fn.trim() === "() => location.href") {
            return fencedEval(JSON.stringify("https://target.test/")) as never;
          }
          return fencedEval("0") as never;
        }
        return textContent(`stubbed ${name}`) as never;
      }),
      listTools: vi.fn(async () => TOOLS_170.map((t) => ({ name: t, inputSchema: {} }))),
      close: vi.fn(async () => {}),
      pid: 99999,
      stderr: null,
      isConnected: true,
    } as unknown as McpClient;
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "extract", {
      steps: [{ action: "navigate" }],
    } as unknown as BrowseOptions);
    // dns_or_nav_error → classify 落 unknown（通道/网络层瞬态——可重试档）
    expect(r.outcome).toBe("unknown");
    expect(r.data?.stopped_at?.reason).toBe("step_error");
    // 导航失败 ⇒ did_navigate=false（诚实：失败的导航不算导航发生——
    // 行 outcome=unknown 非 worked，不满足 did_navigate 的 worked 判据）
    expect(r.data?.did_navigate).toBe(false);
  });
});

// ============================================================
// 矩阵 §8.B：残留页族（R2-1 本体复现）
// ============================================================
describe("§8.B 链真值矩阵 — 残留页（无任何导航）", () => {
  it("extract+steps+url 于残留页 → final_url = 残留页真实 href（不再谎称目标页——R2-1 本体）+ did_navigate=false", async () => {
    const REQUEST = "https://requested.test/page";
    const RESIDUAL = "https://residual.test/old-page";
    const { client } = makeChainClient({
      // 无先导导航、无 navigate step → 唯一 href 读 = 链尾真值读 → 残留页
      hrefs: [RESIDUAL],
    });
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "extract", {
      steps: [{ action: "extract" }],
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // 消谎本体：旧形态此处谎称 final_url=REQUEST；现在暴露链实际跑在残留页
    expect(r.data?.final_url).toBe(RESIDUAL);
    expect(r.data?.did_navigate).toBe(false);
    expect(r.data?.url).toBe(RESIDUAL);
  });

  it("残留页 ∧ 尾读失败 → final_url 省略（无种子——诚实 prefers 缺席，非请求串）", async () => {
    const REQUEST = "https://requested.test/page";
    const { client } = makeChainClient({
      hrefs: ["https://residual.test/old-page"],
      hrefReadThrows: true,
    });
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "extract", {
      steps: [{ action: "extract" }],
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(r.data?.final_url).toBeUndefined();
    expect(r.data?.did_navigate).toBe(false);
    // data.url 缺真值时为空串（不再装饰回显请求串）
    expect(r.data?.url).toBe("");
  });
});

// ============================================================
// 矩阵 §8.B：url == 当前页族
// ============================================================
describe("§8.B 链真值矩阵 — url == 当前页（尾读=请求串的真值形态）", () => {
  it("页面真落于请求 URL → 尾读=请求串属真值（来源判据非值判据——INV-100 措辞）+ did_navigate=false", async () => {
    const REQUEST = "https://example.com/";
    const { client } = makeChainClient({
      hrefs: [REQUEST], // 尾读 = 请求串（页面真在那里）
    });
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "extract", {
      steps: [{ action: "extract" }],
    } as unknown as BrowseOptions);
    expect(r.outcome).toBe("worked");
    // 值=请求串但来源=尾读真值——合法形态（种子路径的请求串才被守卫排除）
    expect(r.data?.final_url).toBe(REQUEST);
    expect(r.data?.did_navigate).toBe(false);
  });
});

// ============================================================
// 链内 data.chain 同步（小链直传形态）
// ============================================================
describe("§8.B 链真值矩阵 — data.chain 同步", () => {
  it("小链 data.chain.final_url/did_navigate 与外层同值（单一真源镜像）", async () => {
    const REQUEST = "https://target.test/";
    const { client } = makeChainClient({
      hrefs: ["about:blank", "https://target.test/after"],
      navigateProse: () => "Navigated to https://target.test/real.",
    });
    const ch = new TruthTestChannel(client);
    const r = await ch.browse(REQUEST, "navigate", {
      steps: [{ action: "snapshot" }],
    } as unknown as BrowseOptions);
    expect(r.data?.chain?.final_url).toBe("https://target.test/after");
    expect(r.data?.chain?.did_navigate).toBe(true);
  });
});
