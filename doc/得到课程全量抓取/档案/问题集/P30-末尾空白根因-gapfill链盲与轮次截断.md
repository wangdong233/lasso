# P30：末尾/页尾大空白根因——gapfill「链盲」与轮次截断（共享规则模块升级）

## 现象
终局成品《薛兆丰的经济学课-全419讲.pdf》QC 报告（终局成书/merge-final-report.json，2026-08-20 09:56）G2 门禁 20 处页尾墨迹空白 ≥40% FAIL；另 10 处 ≥40% 空白被「结构性边界」豁免（前言页/各模块末页，含全书末页 p1360 的 71.4%）。用户就此前的冒烟版亦提过「末尾大段空白」（P29 连续流式改版的直接动因）。

## 根因（两问分开答）

### 问一：末页/模块末页的大空白（豁免区 10 页，含 p1360 全书末页 71.4%）
**预期行为（结构性边界，非缺陷）**：
- gapfill.mjs:77 `p.isLast → continue`——每片末页在片内没有「次页第一图」可拉，补图机制天然无对象；这是架构正确行为（拉图只能从次页往上拉）。
- merge.mjs G2 豁免 `moduleEnds`（各模块末页=全书末页）与 `p < firstStart`（前言/目录页）——P29 连续流式版式的设计边界：模块末页留白是模块收束的自然呼吸。
- 结论：这 10 页无可拉内容、属版式设计边界。要压缩只能「反向」让前文撑满（如放大末页前的图），与「缩图补空」规则方向相反，不做。

### 问二：正文中的 20 处 ≥40% 页尾空白（FAIL 区，真正缺陷）
**管线缺陷（gapfill 规则两处，本条修复）**：

**根因 1：decideGapFill 可用空间模型「链盲」（12/20 处）**
- `printHCss <= availCss → leave:fits` 只比较图高 vs 空位，不计算图前方经 `break-after:avoid` 绑定的标题链头（版式 CSS：`h2,h3,h4 { break-after:avoid }` ≈70css；`.ch-head { break-after:avoid }` ≈135css）。
- 铁证（shard13 线下活动茶歇模块终态复扫，`.engine/selftest-gapfill.mjs` A 组）：10 处 big 档空白（p16/19/33/38/43/51/59/63/68/75，对成品 p1237/1240/1254/1259/1264/1272/1280/1284/1289/1296 的全部 G2 fail 贡献页）里，图已被缩到 **printHCss 恰好= availCss**（428=428、436=436、916vs915、645=645、541=541、537=537、691=691）仍留在次页顶——「恰好放下却不回流」= 前方有未计高的 `## 人名` 标题随行（MD 结构 `## 人名` 后紧跟竖版合影 3024×4031）。
- 每轮都 skip `leave:fits` → 空白永不被处理，assertNoUnfilledGaps 如实报 hardFail 但 planner 无动作。

**根因 2：收敛轮次 3 轮截断（4/20 处）**
- merge.mjs `for round<=3` 硬上限；7/14 片（s3,4,5,6,8,12,13）第 3 轮仍有动作时退出（s5 衰减 67→26→11 未归零）。
- 终态 round-4 模拟：s4p42/s4p116/s5p59/s12p110 仍有可执行 shrink/delete，直接对上成品 G2 fail p254/p328/p431/p1181（40.8-49.2%，均周问答章）。

## 修复（只改规则模块与调用侧；当前课程不重处理，成品未动）
`lasso/.dedao-extract/gapfill.mjs`（共享规则权威）+ `.engine/merge.mjs`（接线）：

1. **链头建模**：RULES 增 `CHAIN_H_CSS:70 / CHAIN_CHHEAD_CSS:135 / CHAIN_FALLBACK_CSS:96 / MAX_ROUNDS:6`（高度由版式 CSS 实算，非拍脑袋：12pt×1.7 行盒+1.9em/.8em margin≈52.8pt≈70css；.ch-head≈101pt≈135css）。
2. **decideGapFill 增可选参 chainHeadCss**（默认 0 = 行为与旧版逐点全同，engine.mjs 单章管线零改动）；availCss 先扣链头再判 fits/定 maxCss——「图放下还得把绑定的标题一起放下」才是物理真相。
3. **新增 figChainAnnotations(chapters)**：按 buildHtml figKey 同序扫 blocks，给每个可寻址图标注链头高（h2-h4 前邻→70；章首块→135；h1 渲染前被滤除；行内图不占键）。
4. **planGapFill 链感知（只作用于 big 档 ≥35%；cosmetic 档保持 P23 原语义，冒烟行为零漂移）**：
   - 链扣除：候选图有链头标注 → 先扣再判；
   - fits 悖论兜底：big 档判 fits 但图已有 prev 缩放记录（被缩到 printH≈avail 仍没回流）或已知链头 → 按 CHAIN_FALLBACK_CSS 补扣重判（无标注路径也能自救）；
   - big 档链感知重试优先于删：链感知目标 maxCss < prev 时先再缩（旧版直接删——链盲时代的 prev 本身是被高估的目标）；只有 maxCss ≥ prev 才按用户规则删图（删图仍是最后手段）。
5. **merge.mjs 轮次策略**：`round <= RULES.MAX_ROUNDS(6)` + 动作数严格递减守卫（未递减=振荡前兆，本轮执行后收手）+ meta.gapFill 增 `stoppedBy`（converged/stalled/max-rounds）与每轮 `actions` 计数（收敛曲线可审计）。

## 验证（.engine/selftest-gapfill.mjs，只读复扫、可重复跑、零渲染）
以 git e5dde99 旧版为基线，同输入喂新旧两版（shard 终态 PDF + meta 重建 round-N 输入态，含 startsForGap 章首豁免精算复刻）：
- **A 新规则生效**：shard13 十处 leave:fits 全部转动作（另 p93 36% 同获动作，共 11 shrink 0 delete）——fig12 428→358、fig14 436→366、fig24 915→846、fig26/43 960→901、fig29 645→575、fig34 541→471、fig41 537→467、fig45 691→621、fig50 645→575（链标注命中 h2=70 抽检 3/3）；旧版同页零动作（链盲复现）。shard13 贡献的 10 个成品 G2 fail 页全覆盖。
- **B 轮次截断复现**：s4p42→426、s4p116→389(链感知)、s5p59→302(链感知)、s12p110 旧版 delete→新版先缩 455（重试优先于删）；**s5p278（成品 p650，第179讲 ch-head+图同型）旧版连 round-4 都无动作（leave:fits 515=515），新版 paradox 兜底 shrink 445**。
- **C 冒烟兼容**：shard02-flow（冒烟-合并6章-flow 实分片）新旧 plan 三元组零 diff（全 cosmetic 档，big 档触发面=0）；assertNoUnfilledGaps hardFail=false 与既有冒烟报告一致。
- **D 单元回归**：154 网格点（freePct×printH×natDisplay）chainHeadCss=0 时 action/maxCss/availCss/tier 与 e5dde99 全同（plain shrink 的 reason 由 undefined→'fits-after-cap'，仅审计文案）。
- **F 断言侧未动**：assertNoUnfilledGaps 对 shard13 仍报 hardFail=true（10 violations）——断言一直看得见，是 planner 修不动；语义未变。
- 结果：**ALL PASS**。

## 阈值数据依据
- 链头 70/135css：由 merge.mjs 版式 CSS 实算（见上）；F2 兜底 96 取 h2(70) 与章头(135) 之间，覆盖舍入/孤行绑定。
- 只动 big 档：20 个 G2 fail 全部 ≥40%（≥35% big 档全覆盖）；冒烟 shard02-flow 全部 <35%（cosmetic），故链规则零触发面。
- 轮次 6：s5 收敛曲线 67→26→11→(模拟 r4=2)——4 轮归零；6 留振荡余量且每轮只多一次整片重渲（341 页片实测秒-分钟级）。

## 影响面与门禁
- gapfill.mjs 在 lasso 仓库工作树内但 src/test 零引用（grep 证）——`npm run build/test/check-invariants` 结构性不受影响，未动 82 INV 基线。
- 当前课程**不重处理**（用户明示）：本优化只对未来渲染生效；若后续允许，`render --force` + re-assemble 即可按新规则收敛（预期消灭 20 个 G2 fail 中 ≥16 个；s12p110 类一图可能多一轮后才删）。
- 相关：P23（gapfill 诞生）/P24（输入对齐）/P29（连续流式版式与 G2 新标准）/P31（同轮发现的缺章事故）。
