# P11 — 发刊词 PDF 出现整页空白尾页：不可见溢出（尾部 margin）把打印高度顶过页边界

- 时间：2026-08-19 13:44-14:05（extract-batch2 首版 → diag-tail → extract-batch3 两轮修复）
- 影响面：长文按「删评论区/封面后接近整数页边界」的概率性触发（本批 3 讲中 1 讲）。

## 现象

batch2 首版：发刊词 PDF 15 页，第 15 页**全空白**；实际内容在第 14 页自然结束（课程表 + 品牌宣传 + 版权行）。第001/002讲无此问题（8/5 页，末页有内容）。

## 复现

DOM 清理（删 `.article-cover` / `.dd-audio` / `.article-time-info` 起后缀、隐藏 `.iget-header`/`.course-nav` 等）后直接 `Page.printToPDF`。

## 白盒证据（diag-tail.mjs，产物 `.dedao-extract/b4-diag.json`）

- `document.documentElement.scrollHeight = 14654`，而内容主体 `div.article` 的 `getBoundingClientRect().bottom = 14634` —— 差 20px。
- rect 诊断 `gap=0`（没有任何可见元素的 border-box 超过 scrollHeight），且三个 h=0 覆盖层 `.article-note-editor` / `aside.notes-wrap` / `.iget-global-prompt` 的 bottom 恰为 14654（零高度、不进 rect.bottom 但参与布局高度）。
- **第一轮修复（隐藏三个覆盖层 + html/body/iget-pc/iget-articles/article/wrap height/min-height 归一化）无效**：docH 14654 → 14654（`b3-a1-cleanup.json`）。
- **第二轮修复命中**：对 wrap 内「最后可见后代链」（tailChain 实测 = `article-body-wrap > article-body > .iget_rich-text-panel--container > .editor-show > figure > img.big-image`）做 `margin-bottom/padding-bottom: 0 !important` → docH 14654 → **14644**，页数 15 → **14**；修复后第 14 页渲染与修复前逐字节一致（pdftoppm PNG md5 相同），证明只削掉了不可见尾距、零内容损失。

结论：溢出真身 = 正文最后一个 `figure` 的尾部 margin（rect 诊断法天然不可见——`getBoundingClientRect()` 不含 margin）。

## 判断

**预期行为（浏览器打印分页机制）→ 结论**：网页打印按布局高度分页，尾部 margin/零高覆盖层会把高度顶过页边界产生空白尾页。已在抽取脚本内置根治步骤（extract-batch3.mjs JS_CLEANUP 的「尾部 margin 归零」段），后续批次直接沿用该脚本，不再出现。

## 附带核实（防误裁）

- 修复后三份 PDF 页数 14/8/5，末页均为真实内容（版权行收尾）；
- 001/002 末页与修复前渲染 md5 一致（margin 归零只影响第 002 讲等末页尾部空白，不删内容）。
