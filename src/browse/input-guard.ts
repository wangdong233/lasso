/**
 * input-guard（doc/bugs/11 决议 B.1，2026-09-17）
 *
 * type action ref 路的 focus expr（extract-refs.ts 同范式纯函数模块——expr
 * 构造，无 SDK 依赖、无 IO）。决议 C 的三探针（G1/G2/G3）后续 commit 扩入
 * 本模块（值守区 = doFill/doType ref 路；BrowseChannel 消费）。
 */

/**
 * 决议 B.1 ref 路 focus expr：定位 → el.focus() → 回读
 * document.activeElement === el 作 focus 回执（上游 type_text 的文档化前置
 * 「previously focused input」）。miss → { ok:false, reason:"ref_stale" }。
 *
 * 注意：focus() 打在**目标自身**上（键入前置），不是探测行为——决议 §C.3
 * 禁的是「为探测合成 blur / focus 别处」。
 */
export function buildRefFocusExpr(ref: string): string {
  return `() => {
    try {
      var ref = ${JSON.stringify(ref)};
      var el = null;
      try { el = document.querySelector('[data-lasso-uid="' + CSS.escape(ref) + '"]'); } catch (e) { el = null; }
      if (!el) return JSON.stringify({ ok: false, reason: "ref_stale" });
      el.focus();
      return JSON.stringify({
        ok: true,
        focused: document.activeElement === el,
        tag: (el.tagName || "").toLowerCase()
      });
    } catch (e) {
      return JSON.stringify({ ok: false, reason: "eval_error:" + String(e) });
    }
  }`;
}
