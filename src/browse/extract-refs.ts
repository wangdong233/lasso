/**
 * extract-refs（v1.17 Phase F，parse24 §6.2 C2 裁决⑤）
 *
 * 抽取产物交互句柄：browse extract 的 include_refs opt-in 三件套——
 *  ① doExtract 既有 evaluate_script **顺带**产出 refs（改 expr 返回
 *     {html,url,title,refs}，注入 data-lasso-uid="r1".. 属性）——与
 *     HighRiskGate.buildAssessExpr 第 1 步的 data-lasso-uid 查找预留
 *     （HighRiskGate.ts「Lasso 未来在 snapshot 注入」自注）同属性名闭环。
 *  ② markdown 末尾追加 "## Interactive refs" 附录表（正文零内嵌标记，
 *     既有 markdown 黄金断言主文结构不受扰）。
 *  ③ click/fill 接 ref：selectors.click 匹配 ^r\d+$ → evaluate_script 定位后
 *     JS click / 设 value + dispatch input/change。**ref 失效诚实语义**：
 *     querySelector miss → throw ref_stale_re_snapshot → didnt（不猜不自动重试）。
 *
 * 路线定案（parse24 §6.2，替代方案否决理由白盒）：不走上游 take_snapshot 的
 * uid 透传——markdown 档本就不跑 take_snapshot，走上游 uid 需额外一跳 snapshot，
 * 恰是 C2 要消灭的成本；且上游 uid 文本树契约无本机实测样例（不可依未验契约设计）。
 *
 * 纯函数模块（expr 构造 + 附录格式化），无 SDK 依赖、无 IO——可单测
 * （expr 用 mock document eval 验证，照 buildAssessExpr 导出先例）。
 */

// ============================================================
// 顶级 const
// ============================================================
/** 交互元素 selector（refs 只收交互元素，parse24 §6.2；a/button/input/select/textarea/[role=button] 等）。 */
export const REF_SELECTOR =
  'a, button, input, select, textarea, summary, [role="button"], [role="link"], ' +
  '[role="tab"], [role="checkbox"], [role="radio"], [role="switch"], ' +
  '[role="menuitem"], [role="option"], [role="textbox"], [contenteditable="true"]';

/** 每页 refs 硬顶（token 经济 + 注入面收敛；超出不注入——诚实 cap）。 */
export const REFS_CAP = 50;

/** ref 句柄形态：r + 十进制序号（r1..r50，1-based，document order）。 */
export const REF_PATTERN = /^r\d+$/;

/** ref 文本标签截断（附录单行可读性）。 */
const REF_TEXT_MAX = 80;

/** ref 属性名（与 HighRiskGate.buildAssessExpr 的查找预留同属性名闭环）。 */
export const REF_ATTR = "data-lasso-uid";

// ============================================================
// 类型
// ============================================================
/** 单条交互 ref（expr 返回 + 附录输入）。 */
export interface ExtractRef {
  /** "r1".."r50"（与注入的 data-lasso-uid 同值） */
  ref: string;
  /** 小写标签名（"a" / "button" / "input"…） */
  tag: string;
  /** input 的 type（若有） */
  type?: string;
  /** 显式 role（若有） */
  role?: string;
  /** 可读标签（aria-label/title/placeholder/innerText，空白折叠 + ≤80 字符） */
  text?: string;
  /** a 标签的 href（绝对/原样；供 CC 直接判断去向） */
  href?: string;
}

// ============================================================
// ① buildExtractRefsExpr：doExtract 的 include_refs 档 expr
// ============================================================
/**
 * 构造 evaluate_script 函数表达式（W1-DEF-1 上游契约）：注入 data-lasso-uid
 * 属性 + 返回 JSON 字符串 {html, url, title, refs}。
 *
 * 与 doExtract 缺省 expr 的差异：仅多 refs 注入/收集（html 在注入后取——
 * data-lasso-uid 是 HTML 属性，turndown 转 markdown 时不可见，正文零内嵌标记）。
 * 超出 REFS_CAP 的元素不注入（cap 诚实，不静默改号）。
 */
export function buildExtractRefsExpr(): string {
  // 常量预序列化嵌入（照 buildAssessExpr 手法：避免运行时跨闭包取值 + injection）
  return `() => {
    try {
      var SEL = ${JSON.stringify(REF_SELECTOR)};
      var CAP = ${REFS_CAP};
      var ATTR = ${JSON.stringify(REF_ATTR)};
      var TEXT_MAX = ${REF_TEXT_MAX};
      var nodes = document.querySelectorAll(SEL);
      var refs = [];
      var n = 0;
      for (var i = 0; i < nodes.length && n < CAP; i++) {
        var el = nodes[i];
        var id = "r" + (n + 1);
        try { el.setAttribute(ATTR, id); } catch (e) { continue; }
        n = n + 1;
        var tag = (el.tagName || "").toLowerCase();
        var text = el.getAttribute("aria-label") || el.getAttribute("title") ||
          el.getAttribute("placeholder") || (el.innerText || el.textContent || "");
        text = String(text).replace(/\\s+/g, " ").trim();
        if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX);
        var item = { ref: id, tag: tag };
        var type = el.getAttribute("type");
        if (type) item.type = type;
        var role = el.getAttribute("role");
        if (role) item.role = role;
        if (text) item.text = text;
        if (tag === "a") {
          var href = el.getAttribute("href") || "";
          if (href) item.href = href;
        }
        refs.push(item);
      }
      return JSON.stringify({
        html: document.documentElement.outerHTML,
        url: window.location.href,
        title: document.title || "",
        refs: refs
      });
    } catch (e) {
      return JSON.stringify({ html: "", url: "", title: "", refs: [] });
    }
  }`;
}

// ============================================================
// ② formatRefsAppendix：markdown 附录（正文零内嵌标记）
// ============================================================
/** 附录标题（固定文本，黄金断言锚点）。 */
export const REF_APPENDIX_HEADING = "## Interactive refs";

/** 单条 ref 的附录行（纯函数）：`- [r1] a "Home" → https://…` / `- [r2] button "提交"`。 */
export function formatRefLine(r: ExtractRef): string {
  const tagPart =
    r.tag +
    (r.type ? `[type=${r.type}]` : "") +
    (r.role ? `[role=${r.role}]` : "");
  let line = `- [${r.ref}] ${tagPart}`;
  if (r.text) line += ` "${r.text}"`;
  if (r.href) line += ` → ${r.href}`;
  return line;
}

/**
 * 组装附录：`\n\n## Interactive refs\n\n- [r1] …\n- [r2] …`。
 * refs 为空 → 返回空串（调用方判空跳过，不产空附录节）。
 */
export function formatRefsAppendix(refs: ExtractRef[]): string {
  if (!refs || refs.length === 0) return "";
  const lines = refs.map(formatRefLine);
  return `${REF_APPENDIX_HEADING}\n\n${lines.join("\n")}`;
}

// ============================================================
// ③ click/fill by ref：expr 构造
// ============================================================
/** 按 data-lasso-uid 定位单元素的页面侧 helper 片段（click/locate/fill 共用）。 */
function refQuerySnippet(refVar: string): string {
  return `document.querySelector('[' + ${JSON.stringify(REF_ATTR)} + '="' + CSS.escape(${refVar}) + '"]')`;
}

/**
 * click by ref：定位 → el.click()（JS click 与 trusted CDP click 的差异如实
 * 文档化——个别框架不响应 → CC 回退快照 uid 路径，两条路径并存）。
 * miss → { ok:false, reason:"ref_stale" }（不猜不自动重试）。
 */
export function buildRefClickExpr(ref: string): string {
  return `() => {
    try {
      var ref = ${JSON.stringify(ref)};
      var el = null;
      try { el = ${refQuerySnippet("ref")}; } catch (e) { el = null; }
      if (!el) return JSON.stringify({ ok: false, reason: "ref_stale" });
      el.click();
      return JSON.stringify({ ok: true, tag: (el.tagName || "").toLowerCase() });
    } catch (e) {
      return JSON.stringify({ ok: false, reason: "eval_error:" + String(e) });
    }
  }`;
}

/**
 * fill 前置预检：全部 ref 必须在 DOM（副作用前查 precondition——miss 时不产生
 * 部分填充副作用）。返回 { ok, missing }。
 */
export function buildRefLocateExpr(refs: string[]): string {
  return `() => {
    try {
      var refs = ${JSON.stringify(refs)};
      var missing = [];
      for (var i = 0; i < refs.length; i++) {
        var el = null;
        try { el = ${refQuerySnippet("refs[i]")}; } catch (e) { el = null; }
        if (!el) missing.push(refs[i]);
      }
      return JSON.stringify({ ok: missing.length === 0, missing: missing });
    } catch (e) {
      return JSON.stringify({ ok: false, missing: refs, reason: "eval_error:" + String(e) });
    }
  }`;
}

/**
 * fill by ref：input/textarea 走 native value setter（绕过 React/Vue 的值拦截）
 * + dispatch input/change；select 直设 value；contenteditable 设 textContent。
 * 返回 { ok, filled, errors }（errors 形如 "r3:ref_stale"）。
 * 调用方须先过 buildRefLocateExpr 预检（本 expr 内仍防御性复查 miss）。
 */
export function buildRefFillExpr(entries: Array<{ ref: string; value: string }>): string {
  return `() => {
    try {
      var entries = ${JSON.stringify(entries)};
      var filled = [];
      var errors = [];
      for (var i = 0; i < entries.length; i++) {
        var ref = entries[i].ref;
        var value = entries[i].value;
        var el = null;
        try { el = ${refQuerySnippet("ref")}; } catch (e) { el = null; }
        if (!el) { errors.push(ref + ":ref_stale"); continue; }
        try {
          if (el.tagName === "SELECT") {
            el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            var proto = el.tagName === "TEXTAREA"
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
            var d = Object.getOwnPropertyDescriptor(proto, "value");
            if (d && d.set) { d.set.call(el, value); } else { el.value = value; }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          filled.push(ref);
        } catch (e2) { errors.push(ref + ":" + String(e2)); }
      }
      return JSON.stringify({ ok: errors.length === 0, filled: filled, errors: errors });
    } catch (e) {
      return JSON.stringify({ ok: false, filled: [], errors: ["eval_error:" + String(e)] });
    }
  }`;
}
