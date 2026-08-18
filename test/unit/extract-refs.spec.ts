/**
 * extract-refs 单测（v1.17 Phase F，parse24 §6.2 C2）
 *
 * 覆盖（parse24 §6.2 测试清单）：
 *  - expr 真跑（mock document eval，照 buildAssessExpr 导出先例）：
 *    · buildExtractRefsExpr：document order 注入 r1..rN / cap 50 / 文本折叠+截断
 *      / href 仅 a / type+role 透传 / 空页 refs=[]
 *    · buildRefClickExpr：命中 → el.click() + ok；miss → ref_stale（不猜）
 *    · buildRefLocateExpr：全在 → ok；miss → missing 列表
 *    · buildRefFillExpr：input native setter + input/change 事件 / select /
 *      contenteditable / miss → ref_stale error
 *  - formatRefsAppendix 黄金格式（正文零内嵌——附录独立于 markdown 主文）
 *  - 常量：REFS_CAP=50 / REF_PATTERN / REF_SELECTOR 交互元素集
 *
 * 无 jsdom 依赖（禁新 npm 依赖红线）：expr 在 Node eval + 手搓 fake DOM 上跑。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildExtractRefsExpr,
  buildRefClickExpr,
  buildRefFillExpr,
  buildRefLocateExpr,
  formatRefLine,
  formatRefsAppendix,
  REF_APPENDIX_HEADING,
  REF_ATTR,
  REF_PATTERN,
  REF_SELECTOR,
  REFS_CAP,
  type ExtractRef,
} from "../../src/browse/extract-refs.js";

// ============================================================
// fake DOM（expr 运行的最小宿主）
// ============================================================
class FakeEvent {
  type: string;
  constructor(type: string) {
    this.type = type;
  }
}

class FakeEl {
  tagName: string;
  attrs: Record<string, string> = {};
  textContent: string;
  innerText: string;
  value = "";
  clicked = 0;
  events: string[] = [];
  constructor(tagName: string, opts: { text?: string; attrs?: Record<string, string> } = {}) {
    this.tagName = tagName.toUpperCase();
    this.textContent = opts.text ?? "";
    this.innerText = opts.text ?? "";
    for (const [k, v] of Object.entries(opts.attrs ?? {})) this.attrs[k] = v;
  }
  getAttribute(n: string): string | null {
    return this.attrs[n] ?? null;
  }
  setAttribute(n: string, v: string): void {
    this.attrs[n] = v;
  }
  click(): void {
    this.clicked++;
  }
  dispatchEvent(e: FakeEvent): void {
    this.events.push(e.type);
  }
  get isContentEditable(): boolean {
    return this.attrs["contenteditable"] === "true";
  }
}

/** input/textarea native value setter 记录器（React/Vue 拦截绕过的关键路径）。 */
const nativeSetterCalls: Array<{ el: FakeEl; value: string }> = [];
const INPUT_PROTO: Record<string, PropertyDescriptor> = {};
Object.defineProperty(INPUT_PROTO, "value", {
  set(this: FakeEl, v: string) {
    nativeSetterCalls.push({ el: this, value: v });
  },
});

function installFakeDom(elems: FakeEl[]): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    querySelectorAll: () => elems.slice(),
    querySelector: (sel: string) => {
      const m = sel.match(/^\[data-lasso-uid="(.+)"\]$/);
      if (!m) return null;
      return elems.find((e) => e.attrs[REF_ATTR] === m[1]) ?? null;
    },
    documentElement: { outerHTML: "<html><body>fixture</body></html>" },
    title: "Fixture Title",
  };
  g.CSS = { escape: (s: string) => s };
  g.Event = FakeEvent as unknown as EventConstructor;
  g.window = {
    location: { href: "https://example.com/page" },
    HTMLInputElement: { prototype: INPUT_PROTO },
    HTMLTextAreaElement: { prototype: {} },
  };
}
type EventConstructor = new (type: string) => FakeEvent;

function uninstallFakeDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.CSS;
  delete g.Event;
  delete g.window;
}

/** eval 表达式串 → 调用 → JSON.parse 返回值（W1-DEF-1 函数表达式契约）。 */
function runExpr(expr: string): unknown {
  // eslint-disable-next-line no-eval
  const fn = eval(`(${expr})`) as () => string;
  return JSON.parse(fn());
}

let cleanup: Array<() => void> = [];
beforeEach(() => {
  nativeSetterCalls.length = 0;
  cleanup = [];
});
afterEach(() => {
  for (const fn of cleanup) fn();
  uninstallFakeDom();
});

// ============================================================
// 常量
// ============================================================
describe("常量 — cap / pattern / selector", () => {
  it("REFS_CAP = 50（每页硬顶）", () => {
    expect(REFS_CAP).toBe(50);
  });

  it("REF_PATTERN 匹配 r1..r99，不匹配 uid/空/r0x", () => {
    expect(REF_PATTERN.test("r1")).toBe(true);
    expect(REF_PATTERN.test("r50")).toBe(true);
    expect(REF_PATTERN.test("uid1")).toBe(false);
    expect(REF_PATTERN.test("")).toBe(false);
    expect(REF_PATTERN.test("r")).toBe(false);
    expect(REF_PATTERN.test("R1")).toBe(false);
  });

  it("REF_SELECTOR 覆盖交互元素集（a/button/input/select/textarea/[role=button] 等）", () => {
    expect(REF_SELECTOR).toContain("a");
    expect(REF_SELECTOR).toContain("button");
    expect(REF_SELECTOR).toContain("input");
    expect(REF_SELECTOR).toContain("select");
    expect(REF_SELECTOR).toContain("textarea");
    expect(REF_SELECTOR).toContain('[role="button"]');
    expect(REF_SELECTOR).toContain('[contenteditable="true"]');
  });
});

// ============================================================
// buildExtractRefsExpr
// ============================================================
describe("buildExtractRefsExpr — 注入 + 收集（mock DOM 真跑）", () => {
  it("document order 注入 r1..rN + 返回 refs 数组（html/url/title 同缺省 expr）", () => {
    const els = [
      new FakeEl("a", { text: "Home", attrs: { href: "/home" } }),
      new FakeEl("button", { text: "提交" }),
      new FakeEl("input", { attrs: { type: "search", placeholder: "Search…" } }),
    ];
    installFakeDom(els);
    const out = runExpr(buildExtractRefsExpr()) as {
      html: string;
      url: string;
      title: string;
      refs: ExtractRef[];
    };
    expect(out.url).toBe("https://example.com/page");
    expect(out.title).toBe("Fixture Title");
    expect(out.html).toContain("fixture");
    // 注入属性（r1..r3，document order）
    expect(els[0].attrs[REF_ATTR]).toBe("r1");
    expect(els[1].attrs[REF_ATTR]).toBe("r2");
    expect(els[2].attrs[REF_ATTR]).toBe("r3");
    // refs 数组与注入一致
    expect(out.refs.map((r) => r.ref)).toEqual(["r1", "r2", "r3"]);
    expect(out.refs[0]).toEqual({ ref: "r1", tag: "a", text: "Home", href: "/home" });
    expect(out.refs[1]).toEqual({ ref: "r2", tag: "button", text: "提交" });
    expect(out.refs[2]).toEqual({ ref: "r3", tag: "input", type: "search", text: "Search…" });
  });

  it("href 仅 a 标签收集（button/input 无 href 字段）", () => {
    const els = [new FakeEl("button", { text: "Go" })];
    installFakeDom(els);
    const out = runExpr(buildExtractRefsExpr()) as { refs: ExtractRef[] };
    expect(out.refs[0].href).toBeUndefined();
  });

  it("role 透传（[role=button] div 收 role=button）", () => {
    const els = [new FakeEl("div", { text: "Tab", attrs: { role: "tab" } })];
    installFakeDom(els);
    const out = runExpr(buildExtractRefsExpr()) as { refs: ExtractRef[] };
    expect(out.refs[0].role).toBe("tab");
  });

  it("文本空白折叠 + 截断 ≤80 字符", () => {
    const els = [
      new FakeEl("a", { text: "  multi \n line \t spaced  " }),
      new FakeEl("button", { text: "x".repeat(200) }),
    ];
    installFakeDom(els);
    const out = runExpr(buildExtractRefsExpr()) as { refs: ExtractRef[] };
    expect(out.refs[0].text).toBe("multi line spaced");
    expect(out.refs[1].text!.length).toBe(80);
  });

  it("aria-label 优先于 innerText（可读标签优先）", () => {
    const els = [new FakeEl("button", { text: "noise", attrs: { "aria-label": "Close" } })];
    installFakeDom(els);
    const out = runExpr(buildExtractRefsExpr()) as { refs: ExtractRef[] };
    expect(out.refs[0].text).toBe("Close");
  });

  it("cap 50：第 51 个元素不注入不收集（诚实 cap）", () => {
    const els = Array.from({ length: 60 }, (_, i) => new FakeEl("a", { text: `L${i}` }));
    installFakeDom(els);
    const out = runExpr(buildExtractRefsExpr()) as { refs: ExtractRef[] };
    expect(out.refs).toHaveLength(50);
    expect(out.refs.at(-1)!.ref).toBe("r50");
    expect(els[49].attrs[REF_ATTR]).toBe("r50");
    expect(els[50].attrs[REF_ATTR]).toBeUndefined();
    expect(els[59].attrs[REF_ATTR]).toBeUndefined();
  });

  it("空页（无交互元素）→ refs=[]（不报错）", () => {
    installFakeDom([]);
    const out = runExpr(buildExtractRefsExpr()) as { refs: ExtractRef[] };
    expect(out.refs).toEqual([]);
  });

  it("表达式是函数表达式（W1-DEF-1 上游契约）", () => {
    const expr = buildExtractRefsExpr();
    expect(expr.trim().startsWith("() =>")).toBe(true);
    // eslint-disable-next-line no-eval
    expect(typeof eval(`(${expr})`)).toBe("function");
  });
});

// ============================================================
// formatRefsAppendix（黄金格式）
// ============================================================
describe("formatRefsAppendix / formatRefLine — 附录格式", () => {
  it("黄金格式：`- [r1] a \"Home\" → https://…` / `- [r2] button \"提交\"`", () => {
    expect(
      formatRefLine({ ref: "r1", tag: "a", text: "Home", href: "https://example.com/" }),
    ).toBe(`- [r1] a "Home" → https://example.com/`);
    expect(formatRefLine({ ref: "r2", tag: "button", text: "提交" })).toBe(`- [r2] button "提交"`);
  });

  it("type/role 以 [type=x]/[role=y] 后缀呈现；无 text/href 仍可读", () => {
    expect(
      formatRefLine({ ref: "r3", tag: "input", type: "search", role: "searchbox" }),
    ).toBe(`- [r3] input[type=search][role=searchbox]`);
  });

  it("附录 = 标题 + 空行 + 行列表（正文零内嵌——独立追加块）", () => {
    const md = formatRefsAppendix([
      { ref: "r1", tag: "a", text: "Docs", href: "https://docs.example.com" },
      { ref: "r2", tag: "button", text: "Save" },
    ]);
    expect(md).toBe(
      `${REF_APPENDIX_HEADING}\n\n` +
        `- [r1] a "Docs" → https://docs.example.com\n` +
        `- [r2] button "Save"`,
    );
    expect(md.startsWith("## Interactive refs")).toBe(true);
  });

  it("refs 空 → 空串（调用方跳过，不产空附录节）", () => {
    expect(formatRefsAppendix([])).toBe("");
  });
});

// ============================================================
// buildRefClickExpr
// ============================================================
describe("buildRefClickExpr — click by ref", () => {
  it("命中 → el.click() 调用 + {ok:true, tag}", () => {
    const el = new FakeEl("button", { text: "Go" });
    el.attrs[REF_ATTR] = "r2";
    installFakeDom([el]);
    const out = runExpr(buildRefClickExpr("r2")) as { ok: boolean; tag: string };
    expect(out.ok).toBe(true);
    expect(out.tag).toBe("button");
    expect(el.clicked).toBe(1);
  });

  it("miss → {ok:false, reason:'ref_stale'}（不猜不自动重试）", () => {
    installFakeDom([]);
    const out = runExpr(buildRefClickExpr("r9")) as { ok: boolean; reason: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("ref_stale");
  });
});

// ============================================================
// buildRefLocateExpr
// ============================================================
describe("buildRefLocateExpr — fill 前置预检", () => {
  it("全在 → ok=true", () => {
    const a = new FakeEl("input");
    a.attrs[REF_ATTR] = "r1";
    const b = new FakeEl("input");
    b.attrs[REF_ATTR] = "r2";
    installFakeDom([a, b]);
    const out = runExpr(buildRefLocateExpr(["r1", "r2"])) as { ok: boolean; missing: string[] };
    expect(out.ok).toBe(true);
    expect(out.missing).toEqual([]);
  });

  it("部分 miss → ok=false + missing 列表（副作用前预检）", () => {
    const a = new FakeEl("input");
    a.attrs[REF_ATTR] = "r1";
    installFakeDom([a]);
    const out = runExpr(buildRefLocateExpr(["r1", "r5"])) as { ok: boolean; missing: string[] };
    expect(out.ok).toBe(false);
    expect(out.missing).toEqual(["r5"]);
  });
});

// ============================================================
// buildRefFillExpr
// ============================================================
describe("buildRefFillExpr — fill by ref", () => {
  it("input → native value setter + input/change 事件（React/Vue 拦截绕过）", () => {
    const el = new FakeEl("input", { attrs: { type: "text" } });
    el.attrs[REF_ATTR] = "r1";
    installFakeDom([el]);
    const out = runExpr(buildRefFillExpr([{ ref: "r1", value: "hello" }])) as {
      ok: boolean;
      filled: string[];
      errors: string[];
    };
    expect(out.ok).toBe(true);
    expect(out.filled).toEqual(["r1"]);
    expect(nativeSetterCalls).toEqual([{ el, value: "hello" }]);
    expect(el.events).toEqual(["input", "change"]);
  });

  it("select → 直设 value + change", () => {
    const el = new FakeEl("select");
    el.attrs[REF_ATTR] = "r2";
    installFakeDom([el]);
    const out = runExpr(buildRefFillExpr([{ ref: "r2", value: "opt1" }])) as {
      ok: boolean;
      filled: string[];
    };
    expect(out.ok).toBe(true);
    expect(el.value).toBe("opt1");
    expect(el.events).toEqual(["input", "change"]);
    expect(nativeSetterCalls).toHaveLength(0);
  });

  it("contenteditable → textContent + input 事件", () => {
    const el = new FakeEl("div", { attrs: { contenteditable: "true" } });
    el.attrs[REF_ATTR] = "r3";
    installFakeDom([el]);
    const out = runExpr(buildRefFillExpr([{ ref: "r3", value: "typed" }])) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(el.textContent).toBe("typed");
    expect(el.events).toEqual(["input"]);
  });

  it("miss → errors 含 ref_stale（防御性复查，调用方预检后不应到达）", () => {
    installFakeDom([]);
    const out = runExpr(buildRefFillExpr([{ ref: "r7", value: "x" }])) as {
      ok: boolean;
      filled: string[];
      errors: string[];
    };
    expect(out.ok).toBe(false);
    expect(out.filled).toEqual([]);
    expect(out.errors).toEqual(["r7:ref_stale"]);
  });
});

// ============================================================
// v1.17 verify ⑤ 回归钉：refs 附录感知截断（真机 books.toscrape 实证）
// ============================================================
// 长页正文 > PREVIEW_MAX_CHARS(4000) 时，朴素截断会把缀在末尾的
// "## Interactive refs" 附录整段切掉 → include_refs 经 MCP 响应不可达。
// truncatePreviewKeepingRefs：正文截断 + 附录钉尾。
import { truncatePreviewKeepingRefs } from "../../src/channels/BrowseChannel.js";
import { REF_APPENDIX_HEADING as HEADING } from "../../src/browse/extract-refs.js";

describe("truncatePreviewKeepingRefs — refs 附录感知截断（verify ⑤ 回归）", () => {
  const appendix =
    `${HEADING}\n\n- [r1] a "Home" → index.html\n- [r2] a "Books" → catalogue/books_1/index.html`;

  it("无附录 → 与朴素截断同语义（超限截断 + 标记）", () => {
    const long = "x".repeat(5000);
    const out = truncatePreviewKeepingRefs(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith("…[truncated by lasso]")).toBe(true);
  });

  it("无附录且未超限 → 原样返回（byte-identical）", () => {
    const short = "hello world";
    expect(truncatePreviewKeepingRefs(short)).toBe("hello world");
  });

  it("长正文 + 附录 → 正文截断但附录完整可见（真机缺陷场景）", () => {
    const body = "y".repeat(5500); // > 4000 上限（真机 books.toscrape 5529 实测同量级）
    const out = truncatePreviewKeepingRefs(`${body}\n\n${appendix}`);
    expect(out).toContain(HEADING);
    expect(out).toContain('- [r1] a "Home" → index.html');
    expect(out.indexOf("…[truncated by lasso]")).toBeGreaterThan(0);
    expect(out.indexOf("…[truncated by lasso]")).toBeLessThan(out.indexOf(HEADING));
    // 附录钉尾：HEADING 之后到结尾 === 原 appendix
    expect(out.slice(out.indexOf(HEADING))).toBe(appendix);
  });

  it("短正文 + 附录 → 全文原样（不触发截断）", () => {
    const short = `# Title\n\npara\n\n${appendix}`;
    expect(truncatePreviewKeepingRefs(short)).toBe(short);
  });

  it("正文恰好超限但附录存在 → 正文保留截断标记且附录不丢", () => {
    const body = "z".repeat(4001);
    const out = truncatePreviewKeepingRefs(`${body}\n\n${appendix}`);
    expect(out).toContain(HEADING);
    expect(out.startsWith("z".repeat(4000))).toBe(true);
  });
});
