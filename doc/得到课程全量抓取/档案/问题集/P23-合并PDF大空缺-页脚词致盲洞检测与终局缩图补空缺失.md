# P23 — 路线 b 合并 PDF 第 13 页大空缺：页脚页码词钉死洞检测 + 终局渲染器无缩图补空机制

- 日期：2026-08-19（渲染工程师轮，用户裁决「路线 b 确认」后复验发现）
- 组件：`lasso/.dedao-extract/analyze.mjs`（holeReport）、`lasso/.dedao-extract/gapfill.mjs`（新增共享规则）、`合并演示/render-merge-b.mjs`、`.engine/engine.mjs`（同源接入）
- 用户规则原文（裁决）：**空缺足够大且下方有图片→尝试缩小放入；不行则删除该图；文字绝不丢**。

## 现象

`三章合一-路线b.pdf` 第 13 页：正文止于「这是一个很重要的故事。」（y=545.85pt，内容底界 813.12pt），下方留 267.3pt（34.1% 内容高）空缺；次页 p14 顶部是本应补入的图 `201702192348580647273494.jpg`（1080×532，打印高 354.7css）。合并 QC 却报 `holes: []`，智能续排也从未触发（flowChapters 恒空）。

## 根因（两处叠加，缺一不可）

1. **检测全盲（analyze.mjs holeReport）**：路线 b 的 `Page.printToPDF` 带 `displayHeaderFooter` 页码页脚（y≈821-827pt，低于内容底界 813.12）。`holeReport` 的 `textBottom = max(词.y1)` 把页脚页码也计入 → 每页 textBottom 恒 827.2 → `tailPt` 恒负 → **tailPct 恒 0，任何洞都检不出来**；fullness 同步虚高（1.018+）。单章管线（engine）无页脚，故其 3 章全绿掩盖了该缺陷——同一检测器两种 PDF 形态，带页脚的形态从未被测过。
2. **机制缺失（render-merge-b.mjs）**：终局合并渲染器只有「智能续排」（章级）这一种填空手段，从未移植 engine 的缩图补空闭环（alignFigures + targetsForHoles + JS_FIX_PRINT）。即便检测正常，也没有任何代码会缩 p14 顶的图。

（候选根因逐一排除：阈值不是问题——34.1% 在 12% 门内；测量时机不是问题——pass2 已渲染完成；跨页边界测量失真不是问题——bbox 精确。就是「检测被页脚致盲 + 无缩图机制」两刀。）

## 修复（同一实现，两管线同源）

**① analyze.mjs**：holeReport 过滤 `y1 > CONTENT_BOTTOM + 0.75` 的词（页脚域）再算 textTop/textBottom；并新增 `freePt/freePct`（版面自由空间，加性保守模型：文本跨距+图高+图间隙）。单章 PDF 无页脚 → 行为不变（回归无损）。

**② 新增 `lasso/.dedao-extract/gapfill.mjs`（共享规则单一权威，禁两套漂移）**：
- `RULES`：GAP_BIG_PCT=35（「空缺足够大」）、GAP_ASSERT_PCT=40（复验断言）、IMG_MIN_CSS=200（big 档缩图下限）、IMG_MIN_COSMETIC_CSS=120（cosmetic 档，engine v2 传承灵敏度）、FIG_VMARGIN_CSS=38 + SAFETY_CSS=10（figure 边距+碎片化安全垫）。
- `decideGapFill`（纯函数）：avail = 空缺css − 48；图可缩进（avail≥档位下限）→ shrink；**big 档缩不进 → delete（记日志）**；cosmetic 档缩不进 → leave。文字块永不出现在决策面。
- `matchFigsToPdf`（engine alignFigures 泛化：文档序+自然尺寸对齐 PDF 图像页）、`planGapFill`（每页扫描：空缺达标 ∧ 次页非章首 ∧ 次页文档序第一图为候选；**上轮已缩仍被推到次页顶 → 缩后仍溢出 → 删**）、`assertNoUnfilledGaps`（复验断言）、`inkTailScan`（墨迹终扫，页脚区裁除）。

**③ render-merge-b.mjs**：buildHtml 增 `figOps`（shrink: Map<figKey,maxCss> / deleted: Set），图块带 `data-fk`；cdpRender 就绪后探测全部 `document.images`（文档序+自然尺寸）供对齐；pass2 后进入补空闭环（≤3 轮：测→计划→施加→重渲染），终局 TOC 页码随最终落页修正；QC 增三道门（CJK 多重集零丢失 + 词级保序 + assertNoUnfilledGaps）+ 墨迹终扫。

**④ engine.mjs 同源接入**：`targetsForHoles` 内部改调 `decideGapFill`（阈值/下限/边距全部来自共享 RULES）；迭代环新增删除档（JS_DEL_FIGS，只删无文字 figure，删后 innerText 不变量断言）。

## 复验证据（2026-08-19，路径均在 `合并演示/`）

| 页 | 前（pass2 态）tailBlank% | 后 tailBlank% | 说明 |
|---|---|---|---|
| **p13** | **34.7** | **2.5** | 用户指认缺陷：`201702192348580647273494.jpg` 缩至 308css（等比，≥200 下限）补入；p13 文字止点 545.85 逐字节不变 |
| p9 | 25.0 | 2.5 | cosmetic 附带修复：`201702141406296037049506.jpg` 缩至 207css |
| p11 | 4.8 | 42.3 | 章尾刻意留白（ch3 起新页），豁免 |
| p14 | 3.3 | 40.8 | 全书末页，豁免 |

- 前后对照图：`合并演示/.qc/p13-before.png` / `p13-after.png`（及 p12/p14 对）；墨迹数值表如上（inkTailScan 36dpi，页脚裁除）。
- `merge-b-report.json`：passes=3、pages=14、`qc.zeroLossCjk.missingTotal=0`、`qc.zeroLossWordLevel={missingEmpty:true,inOrder:true}`（词级保序）、`qc.assertNoUnfilledGaps.hardFail=false`（仅 TOC 页与章尾两处豁免）、`qc.inkTailScanOver40=[]`；`gapFill.shrunk` 记录两笔（章/图/页/缩后高/tier），`gapFill.deleted=[]`（本次两图均缩得进，删除档未触发）。
- p13 图像实证：`pdfimages -list` p13 行 `1080×532 @166ppi`（打印高 307.6css ≈ 目标 308）。
- 单章管线同步实证：`engine.mjs produce --only 第002讲 --force` 重跑全绿（print#1 hole p1:19.4% → 共享 cosmetic 缩 → print#2 holes=[]；QC missing=[]/inOrder/promo=0/sikao=0/0；14.1s；chromeGuard 复隐正常）。

## 工程教训

- **同一检测器跨 PDF 形态必须各测一次**：页脚页码是「内容区外的文字」，对 bbox 类分析器是隐形毒饵——本例它不是被漏检的洞，而是把所有洞都盖住的盖子（tailPct 恒 0 连带 flow 决策全灭）。
- **规则只有一份实现才算规则**：engine 的缩图闭环（v2 三章全绿）与终局合并渲染器之间就是「两套漂移」的活证——能力存在≠能力可用。本次抽成 gapfill.mjs 单一权威（阈值+裁决+对齐+断言），两条管线 import 同一模块，419 章全量前完成合流。
- 删除档的触发面：35%+ 空缺的 avail 必 ≥318css > 200 下限，故「放不下→删」的主通道是**缩后仍溢出**（如 break-after:avoid 标题随图占位），由第二轮复查捕获——这就是「渲染后必须复查」的机械理由，一轮预处理永远不够。
