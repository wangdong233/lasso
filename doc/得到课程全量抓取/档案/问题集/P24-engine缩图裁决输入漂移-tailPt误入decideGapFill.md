# P24 — engine 缩图裁决输入漂移：decideGapFill 误吃 tailPt/tailPct（契约=freePt/freePct）

- 日期：2026-08-19（全量启动准备官·引擎终检轮，419 章全量启动前）
- 组件：`.engine/engine.mjs`（targetsForHoles）vs `lasso/.dedao-extract/gapfill.mjs`（共享规则契约）
- 性质：产品缺陷（P23 修复的残留漂移）→ **已修复并验证**

## 现象

P23 把缩图/删图裁决抽成共享模块 gapfill.mjs（「单一规则权威，两管线同源，禁漂移」），engine `targetsForHoles` 改调 `decideGapFill`。但终检发现 engine 传入的量纲不是契约输入：

```js
// gapfill.mjs decideGapFill 契约（docstring）：
//   freePt = 该页版面自由空间(pt, holeReport freePt)   ← 加性保守模型
//     freePt = CONTENT_H − (文本跨距 + 页内图显示高 + 图间隙)   // 图在文本跨距内会被双计 → 保守
// engine.mjs targetsForHoles 实际传的（修复前）：
const d = decideGapFill({ freePt: h.tailPt, freePct: h.tailPct, ... });
//   tailPt = CONTENT_BOTTOM − textBottom   ← 纯文本尾距，忽略页内图 → 乐观偏置
```

同一裁决器吃两种量纲：合并渲染器 planGapFill 喂 `freePt/freePct`，engine 喂 `tailPt/tailPct`。当洞页自身带图（图在最后一段文字之下）时，tailPt 高估可用空间 → engine 会把次页顶图缩到比实际空缺更大的高度 → 缩后仍放不下、白缩一轮；big 档（≥35%）下还可能误入/误出删除档。

## 复现与白盒证据

- 源码行：engine.mjs targetsForHoles（P23 接入处）与 gapfill.mjs `decideGapFill` docstring、`planGapFill`（`p.freePt/p.freePct`）对照。
- 数学关系：`freePt = tailPt − imgPt − n×gapPt ≤ tailPt`（holeReport 逐页构造式），两输入对同一页恒有差，且图越多差越大——非等价重构，是量纲漂移。

## 判断

产品缺陷：P23 的「同源」只做到了**裁决逻辑**同源，没做到**输入测量**同源。共享契约（docstring 明写 freePt=holeReport freePt）被 engine 违反。

## 修复

engine.mjs targetsForHoles 改传契约输入：

```js
// P24 输入对齐：契约输入 = holeReport freePt/freePct（加性保守模型，与 planGapFill 同源）；
// 此前误传 tailPt/tailPct（纯文本尾距，忽略页内图 → 乐观偏置，engine 与合并渲染器漂移）。
const d = decideGapFill({ freePt: h.freePt, freePct: h.freePct, printHCss: t.printImgH });
```

（洞的**检测**门仍用 engine 自有的 tailPct>12∧fullness<0.88，比共享检测门严——检测从严、裁决同源，两者不冲突。）

## 修复记录与验证（2026-08-19）

- `node engine.mjs selftest`：16 fragments OK。
- `node engine.mjs produce --only 第005讲` 全绿（11.7s）：print#1 洞 p4:21.1% → 共享裁决 `gapfill/cosmetic` 缩 `201702031605152596913965.jpg` 336→172css → print#2 holes=[]；QC missing=[]/inOrder/promo=0/sikao=0/0；state 落 done（台账 6/419）。
- 证据文件：`.engine/scratch/e0007-targets-it1.json`（rule: gapfill/cosmetic, mh:172）。
- b′ 侧不涉及（planGapFill 一直用 freePt/freePct，本就是契约正源）。

## 工程教训

- 「同一实现」≠「同一行为」：共享函数只是合流的一半，**输入测量面**也必须在契约里写死并复查——同源审计要查到实参级。
- 全量启动前的终检清单应含「共享模块实参对照」一项（本条即其收益）。
