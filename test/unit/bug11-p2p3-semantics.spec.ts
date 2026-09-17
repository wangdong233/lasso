/**
 * bug11-p2p3-semantics.spec.ts（决议 D，doc/bugs/11，2026-09-17）
 *
 * P2（fill 时序）+ P3（no_reload 语义）的语义钉——描述与行为从此被测试
 * 钉死为一体（下午实机报告《输入保护层拦截》P2/P3 处置）：
 *
 *  - D-1（P2）：「fill 赶在引擎初始化前执行导致值被覆盖」**无 reproducer**
 *    （白盒受控重析 uid 路 fill 当天全链路成功——证伪登记，不写防御代码）。
 *    真修复 1 = wait 超时错误的 window.open 观察面教学句（本 spec B 组）；
 *    真修复 2 = TROUBLESHOOTING §2.19 链配方（文档面，不在本 spec）。
 *  - D-2（P3）：no_reload 行为矩阵四行语义钉（本 spec A 组）+ describe
 *    mandated 澄清句锚（本 spec C 组）。行为零变更——本 spec 对旧代码即绿
 *    （U-D 先合的合并序依据，决议 §5）。
 *
 * 全 mock McpClient（bug09-b spec 同范式）——零真浏览器。
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
import { browseSchema } from "../../src/tools/browse.js";

// ============================================================
// helpers（bug09-b 同范式）
// ============================================================
function fencedEval(value: string) {
  return { content: [{ type: "text", text: "```\n" + value + "\n```" }], isError: false };
}
function textContent(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

type Handler = (n: number, args: Record<string, unknown>) => unknown;

/** 1.7.0 实测工具面（P10 探测门用——含 pdf 防 upstream_unsupported 假拒）。 */
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
 * 可编程 client：handlers 按 tool 名分发（n = 该 tool 第几次调用）。
 * evaluate_script 未提供时默认返回 fenced href（D-1 probe 真实形态）。
 */
function makeClient(handlers: Record<string, Handler>, defaultHref: string | null) {
  const counts = new Map<string, number>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const h = handlers[name];
      if (h) return h(n, args) as never;
      if (name === "evaluate_script" && defaultHref !== null) {
        return fencedEval(JSON.stringify(defaultHref)) as never;
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

class Bug11TestChannel extends BrowseChannel {
  readonly name = "browse_test_bug11d";
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
  tempCache = mkdtempSync(path.join(os.tmpdir(), "lasso-b11d-"));
  setStateStoreContext({ runId: newRunId(), cacheDir: tempCache });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempCache, { recursive: true, force: true });
});

function names(calls: Array<{ name: string }>, tool: string) {
  return calls.filter((c) => c.name === tool);
}

function unwrap(z: any): any {
  let f = z;
  while (
    f &&
    f._def &&
    (f._def.typeName === "ZodOptional" ||
      f._def.typeName === "ZodDefault" ||
      f._def.typeName === "ZodNullable")
  ) {
    f = f._def.innerType;
  }
  return f;
}

/** 决议 D-1 mandated 教学句（verbatim 锚——改写即红）。 */
const WAIT_NEW_TAB_TEACHING =
  "; if the action opened a NEW tab (window.open), the original page URL never changes and this wait cannot succeed — inspect open pages or use the desktop channel";

// ============================================================
// A. 决议 D-2 —— no_reload 行为矩阵四行语义钉（行为零变更，对旧代码即绿）
// ============================================================
describe("决议 D-2 — no_reload 行为矩阵（TROUBLESHOOTING §2.20 表互为锚）", () => {
  const CURRENT = "https://tm.aliyun.com/#/search?q=dada";
  const HASH_TARGET = "https://tm.aliyun.com/#/search?q=wengweng";
  const OTHER_TARGET = "https://www.aliyun.com/search/?k=Agent";

  it("矩阵行 1：URL 规范化后全等（含 hash）→ 零导航直执行（did_navigate:false）+ no_reload 死键进 ignored_options", async () => {
    const { client, calls } = makeClient(
      { evaluate_script: () => fencedEval(JSON.stringify(CURRENT)) },
      null,
    );
    const ch = new Bug11TestChannel(client);
    const r = await ch.browse(CURRENT, "evaluate", {
      js: "() => 1",
      no_reload: true,
    } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    expect(names(calls, "navigate_page")).toHaveLength(0); // 规则 2：零导航
    expect(r.data!.did_navigate).toBe(false);
    expect(r.data!.ignored_options ?? []).toContain("no_reload"); // 死键如实标注
  });

  it("矩阵行 2：hash-only 差异，默认 → 导航 + 补 reload（sd_navigated:true, sd_reloaded:true）", async () => {
    const { client, calls } = makeClient(
      {
        evaluate_script: () => fencedEval(JSON.stringify(CURRENT)),
        navigate_page: (n) =>
          textContent(n === 1 ? `Navigated to ${HASH_TARGET}` : "Reloaded"),
        take_snapshot: () => textContent("- page: ok"),
      },
      null,
    );
    const ch = new Bug11TestChannel(client);
    const r = await ch.browse(HASH_TARGET, "navigate", {});
    expect(r.outcome).toBe("worked");
    const navCalls = names(calls, "navigate_page");
    expect(navCalls).toHaveLength(2); // type:url + type:reload（默认补 reload）
    expect(navCalls[0]!.args.type).toBe("url");
    expect(navCalls[1]!.args.type).toBe("reload");
    expect(r.data!.did_navigate).toBe(true);
    expect(r.data!.same_document_navigated).toBe(true);
    expect(r.data!.same_document_reloaded).toBe(true);
  });

  it("矩阵行 3：hash-only 差异 + no_reload:true → 导航但跳过补 reload（sd_reloaded:false，消费不谎报 ignored）", async () => {
    const { client, calls } = makeClient(
      {
        evaluate_script: () => fencedEval(JSON.stringify(CURRENT)),
        navigate_page: () => textContent(`Navigated to ${HASH_TARGET}`),
        take_snapshot: () => textContent("- page: ok"),
      },
      null,
    );
    const ch = new Bug11TestChannel(client);
    const r = await ch.browse(HASH_TARGET, "navigate", { no_reload: true } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    const navCalls = names(calls, "navigate_page");
    expect(navCalls).toHaveLength(1); // 仅 type:url——补 reload 被跳过
    expect(navCalls[0]!.args.type).toBe("url");
    expect(r.data!.did_navigate).toBe(true);
    expect(r.data!.same_document_navigated).toBe(true);
    expect(r.data!.same_document_reloaded).toBe(false);
    expect(r.data!.ignored_options ?? []).not.toContain("no_reload"); // 实际消费
  });

  it("矩阵行 4：实质不同 URL → 恒导航（no_reload 消费但无 same-document 分支——「期权」语义非「跳过导航」旗标）", async () => {
    const { client, calls } = makeClient(
      {
        evaluate_script: () => fencedEval(JSON.stringify(CURRENT)),
        navigate_page: () => textContent(`Navigated to ${OTHER_TARGET}`),
        take_snapshot: () => textContent("- page: ok"),
      },
      null,
    );
    const ch = new Bug11TestChannel(client);
    const r = await ch.browse(OTHER_TARGET, "navigate", { no_reload: true } as BrowseOptions);
    expect(r.outcome).toBe("worked");
    const navCalls = names(calls, "navigate_page");
    expect(navCalls).toHaveLength(1); // 无 reload 可跳
    expect(r.data!.did_navigate).toBe(true); // 下午报告 P3 误会本体：此处恒 true
    expect(r.data!.same_document_navigated).toBeUndefined();
    expect(r.data!.same_document_reloaded).toBeUndefined();
    expect(r.data!.ignored_options ?? []).not.toContain("no_reload"); // 消费（期权语义）
  });
});

// ============================================================
// B. 决议 D-1 —— wait 超时的 window.open 观察面教学句（两 throw 点）
// ============================================================
describe("决议 D-1 — wait_timeout 教学句（真修复 1）", () => {
  it("text 快路（wait_for isError）→ error 带 wait_timeout 前缀 + NEW tab 教学句（verbatim）", async () => {
    const { client } = makeClient(
      { wait_for: () => textContent("Timed out waiting for text", true) },
      null,
    );
    const ch = new Bug11TestChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { text: "Never Appears", timeout_ms: 3000 },
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown"); // 可重试档不变（classify 缺省）
    expect(String(r.error)).toContain("wait_timeout:");
    expect(String(r.error)).toContain(WAIT_NEW_TAB_TEACHING);
  });

  it("ExpectPoll 失败路（selector 超时）→ 同款教学句（两 throw 点一致）", async () => {
    const { client } = makeClient(
      { evaluate_script: () => fencedEval("false") },
      null,
    );
    const ch = new Bug11TestChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { selector: "input", timeout_ms: 50 },
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(String(r.error)).toContain("wait_timeout:");
    expect(String(r.error)).toContain(WAIT_NEW_TAB_TEACHING);
  });

  it("教学句不污染 classify：wait_timeout 仍落 unknown（可重试——页面慢语义不变）", async () => {
    const { client } = makeClient(
      { wait_for: () => textContent("Timed out", true) },
      null,
    );
    const ch = new Bug11TestChannel(client);
    const r = await ch.browse("https://example.com/", "wait", {
      expect: { text: "x", timeout_ms: 3000 },
    } as BrowseOptions);
    expect(r.outcome).toBe("unknown");
    expect(r.outcome).not.toBe("didnt"); // 教学句零关键词命中（"404"/"not_found"/…）
  });
});

// ============================================================
// C. 决议 D-2 —— describe mandated 澄清句锚（描述与行为钉死为一体）
// ============================================================
describe("决议 D-2 — NO_RELOAD_DESCRIBE mandated 澄清句（A 组行为的描述面）", () => {
  const describeOf = (f: any): string => (f && typeof f.description === "string" ? f.description : "");

  it("no_reload describe 含「不是跳过导航旗标」整句（verbatim——改写即红，与 A 组矩阵互为锚）", () => {
    const d = describeOf(
      (unwrap((browseSchema as any).options) as any).shape.no_reload,
    );
    expect(d).toContain(
      "this is NOT a skip-navigation flag — navigation still happens whenever the url differs; identical-URL targets never navigate at all",
    );
    // 作用域前缀保留（hash-only 才有补 reload 可跳）
    expect(d).toContain("hash-only same-document opt-out");
  });
});
