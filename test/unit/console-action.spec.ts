/**
 * console-action.spec.ts（BUG-05 决议 C，doc/bugs/05 §5 —— L-3 console 暴露面）
 *
 * 事故形态（novel-engine 台账 L-3）：消费方排查渲染缺陷靠 window.onerror 注入
 * 绕路——实况是 console action 已实装（doConsole v1.11）但 descriptions 零暴露
 * + 零参数（CC 消费方不可见）。本 commit 补齐三面：参数化 + 描述暴露 + schema。
 *
 * 覆盖：
 *  1. filterConsoleMessages 纯函数：severity 四档阈值语义（pw 先例「档位含更
 *     严重档」）× limit 取最近 N（截尾保最新）
 *  2. doConsole 参数化：console_level/console_limit 消费（上游 mock）
 *  3. 描述暴露锚：BROWSE_HEADLESS_DESCRIPTION 含 console / network 行；
 *     logged_in「same action set」行含 console/network（INV-92 同 commit 锚）
 *  4. CONSUMED_OPTIONS console 表项 = [console_level, console_limit]（INV-91 联动）
 */
import { describe, it, expect, vi } from "vitest";
import {
  doConsole,
  filterConsoleMessages,
  type ConsoleLevel,
} from "../../src/browse/cdp-actions.js";
import {
  BROWSE_HEADLESS_DESCRIPTION,
  BROWSE_LOGGED_IN_DESCRIPTION,
} from "../../src/tools/descriptions.js";
import type { McpClient } from "../../src/subprocess/McpClient.js";
import type { BrowseOptions } from "../../src/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ============================================================
// helpers
// ============================================================
type Msg = { type: string; text: string };

const MSGS: Msg[] = [
  { type: "log", text: "m1" },
  { type: "error", text: "m2" },
  { type: "warn", text: "m3" },
  { type: "info", text: "m4" },
  { type: "debug", text: "m5" },
  { type: "verbose", text: "m6" },
  { type: "dir", text: "m7" },
  { type: "table", text: "m8" },
  { type: "issue", text: "m9" },
  { type: "error", text: "m10" },
];

function makeClient(text: string): McpClient {
  return {
    callTool: vi.fn(async () => ({
      content: [{ type: "text", text }],
    })),
    listTools: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    pid: 99999,
  } as unknown as McpClient;
}

const UPSTREAM_CONSOLE_TEXT = [
  "## Console messages",
  "msgid=1 [log] m1 (0 args)",
  "msgid=2 [error] m2 (1 args)",
  "msgid=3 [warn] m3 (2 args) [5 times]",
  "msgid=4 [info] m4 (0 args)",
  "msgid=5 [debug] m5 (0 args)",
  "msgid=6 [verbose] m6 (0 args)",
  "msgid=7 [dir] m7 (1 args)",
  "msgid=8 [table] m8 (2 args)",
  "msgid=9 [issue] m9 (0 args)",
  "msgid=10 [error] m10 (0 args)",
].join("\n");

// ============================================================
// 1. filterConsoleMessages 纯函数
// ============================================================
describe("BUG-05 C — filterConsoleMessages（severity 阈值 × limit）", () => {
  it("level 缺省 = 不过滤（现行为兼容）", () => {
    expect(filterConsoleMessages(MSGS)).toHaveLength(MSGS.length);
  });

  it("error 档 = 仅 error", () => {
    const out = filterConsoleMessages(MSGS, "error");
    expect(out.map((m) => m.text)).toEqual(["m2", "m10"]);
  });

  it("warn 档 = error + warn（档位含更严重档——pw 语义先例）", () => {
    const out = filterConsoleMessages(MSGS, "warn");
    expect(out.map((m) => m.text)).toEqual(["m2", "m3", "m10"]);
  });

  it("info 档 = error/warn + info/log/dir/table/issue 等非 verbose 档", () => {
    const out = filterConsoleMessages(MSGS, "info");
    expect(out.map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4", "m7", "m8", "m9", "m10"]);
  });

  it("debug 档 = 全部（含 debug/verbose）", () => {
    const out = filterConsoleMessages(MSGS, "debug");
    expect(out).toHaveLength(MSGS.length);
  });

  it("limit 取最近 N（截尾保最新——preview 截断丢尾部的补形）", () => {
    const out = filterConsoleMessages(MSGS, "error", 1);
    expect(out.map((m) => m.text)).toEqual(["m10"]);
    const out3 = filterConsoleMessages(MSGS, undefined, 3);
    expect(out3.map((m) => m.text)).toEqual(["m8", "m9", "m10"]);
  });

  it("limit 大于结果数 = 全量（不扩造）", () => {
    const out = filterConsoleMessages(MSGS, "error", 500);
    expect(out).toHaveLength(2);
  });

  it("空数组 / 空档输入零异常", () => {
    expect(filterConsoleMessages([], "error")).toEqual([]);
    expect(filterConsoleMessages([], "debug", 5)).toEqual([]);
  });
});

// ============================================================
// 2. doConsole 参数化（上游 mock）
// ============================================================
describe("BUG-05 C — doConsole 参数化", () => {
  it("无参数 = 全量 JSON（现行为兼容——preview 形态不变）", async () => {
    const c = makeClient(UPSTREAM_CONSOLE_TEXT);
    const r = await doConsole(c, "https://example.com/", {} as BrowseOptions);
    const parsed = JSON.parse(r.preview as string) as Array<{ type: string }>;
    expect(parsed).toHaveLength(10);
  });

  it("console_level=error → 仅 error 消息", async () => {
    const c = makeClient(UPSTREAM_CONSOLE_TEXT);
    const r = await doConsole(c, "https://example.com/", {
      console_level: "error",
    } as BrowseOptions);
    const parsed = JSON.parse(r.preview as string) as Array<{ type: string; text: string }>;
    expect(parsed.map((m) => m.text)).toEqual(["m2", "m10"]);
  });

  it("console_level=warn + console_limit=1 → 最近 1 条 warn 档消息", async () => {
    const c = makeClient(UPSTREAM_CONSOLE_TEXT);
    const r = await doConsole(c, "https://example.com/", {
      console_level: "warn",
      console_limit: 1,
    } as BrowseOptions);
    const parsed = JSON.parse(r.preview as string) as Array<{ text: string }>;
    expect(parsed.map((m) => m.text)).toEqual(["m10"]);
  });
});

// ============================================================
// 3. 描述暴露锚（INV-92 测试面）
// ============================================================
describe("BUG-05 C — 描述暴露（两处 description 的 action 列表）", () => {
  it("BROWSE_HEADLESS_DESCRIPTION 含 console 行（当前页语义 + 参数说明）", () => {
    expect(BROWSE_HEADLESS_DESCRIPTION).toMatch(/console\s+— read THIS page's console messages/);
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain("console_level");
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain("console_limit");
  });

  it("BROWSE_HEADLESS_DESCRIPTION 含 network 行（粗览 + 独立工具指引）", () => {
    expect(BROWSE_HEADLESS_DESCRIPTION).toMatch(/network\s+— coarse per-page resource list/);
    expect(BROWSE_HEADLESS_DESCRIPTION).toContain("network_filter");
  });

  it("描述不宣传 pdf 行（上游 1.7.0 无 pdf 工具——诚实化，决议 C）", () => {
    expect(BROWSE_HEADLESS_DESCRIPTION).not.toMatch(/^\s{2}pdf\s+—/m);
  });

  it("BROWSE_LOGGED_IN_DESCRIPTION same-action-set 行含 console/network", () => {
    expect(BROWSE_LOGGED_IN_DESCRIPTION).toMatch(
      /Same action set \+ options as browse_headless \(navigate \/ snapshot \/ console \//,
    );
  });
});

// ============================================================
// 4. CONSUMED_OPTIONS console 表项（INV-91/92 联动锚）
// ============================================================
describe("BUG-05 C — CONSUMED_OPTIONS console 表项", () => {
  it("console 表项 = [console_level, console_limit]（与 doConsole 消费同 commit）", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/channels/BrowseChannel.ts", import.meta.url)),
      "utf8",
    );
    const consoleLine = src
      .match(/const CONSUMED_OPTIONS[\s\S]*?\n\}\);/)![0]
      .match(/^ {2}console: \[([^\]]*)\]/m)![1];
    expect(consoleLine).toContain('"console_level"');
    expect(consoleLine).toContain('"console_limit"');
  });

  it("ConsoleLevel 类型 = 四档（severity 阈值语义）", () => {
    const levels: ConsoleLevel[] = ["error", "warn", "info", "debug"];
    expect(levels).toHaveLength(4);
  });
});
