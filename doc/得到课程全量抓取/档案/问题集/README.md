# 问题集 README —— 得到·薛兆丰的经济学课抽取（2026-08-19）

每条记录五段式：现象 / 复现 / 白盒证据（源码行 / DOM / 网络）/ 判断 /（缺陷则）修复记录。
判断三分法：**产品缺陷→修复优化（跑门禁）** / **预期行为→结论** / **环境限制→结论**。禁止黑盒推测。

## 统计

| 类别 | 数量 | 条目 | 去向 |
|---|---|---|---|
| 产品缺陷 | **6** | P1 P4 P5 P6 P8 P10 | **修复 6/6** |
| 预期行为 | **3+2** | P3 P7 P11（+P14 P15，见下） | 结论在案（工作流方法论 / 打印分页机制） |
| 环境 / 平台限制 | **4** | P2 P9 P12 P13 | 结论在案 |
| 合计 | 13 | | |

修复版本分布：v1.17.3（P1）→ v1.18.0（P4，doc/28 静默守则审计工作流同日实施）→ **v1.18.1（P5/P6/P8/P10，本轮质检裁决官实施）**。

> 索引新鲜度注记（2026-08-19 三轮实施官）：本表统计行未含 P12 之后的探察/实施记录（P14 探察+实施补记、P15 分页判定已补入预期行为节；P16 可见事件有三轮增补；P17-P19 未入索引，待后续统一补录）。
>
> 课程侧工具增补（2026-08-19 架构师轮，合并演示）：P21（新版 Chrome `/json/new` 忽略 url 参数→须 WS `Page.navigate`，已修入 render-merge-b.mjs）、P22（MD 图径 slice 差一位致全图 404，被就绪门拦截，已修+图完整性门入证据链）——均为 `得到_*` 侧管线问题，非 lasso 产品缺陷，不动 lasso 门禁。
>
> 渲染工程师轮（2026-08-19 用户裁决「路线 b 确认」后）：P23（三章合一 p13 大空缺：①analyze.mjs holeReport 被页脚页码词致盲——textBottom 恒 827→tailPct 恒 0，带页脚 PDF 形态从未被测；②终局合并渲染器从未移植 engine 缩图补空闭环。修复=页脚域词过滤 + 新增共享规则模块 gapfill.mjs（大空缺≥35%→等比缩入下限 200px/缩后仍溢出→删图/文字绝不动）+ render-merge-b 补空闭环 + engine 同源接入。复验 p13 34.7%→2.5%、p9 25%→2.5%、词级零丢失、无未处理大空缺；单章 --force 重跑全绿）。
>
> 全量启动准备官轮（2026-08-19，419 章点火前终检）：P24（P23 残留漂移——engine `targetsForHoles` 给共享裁决器 `decideGapFill` 误传 `tailPt/tailPct`，契约输入是 holeReport `freePt/freePct`（加性保守模型）；裁决逻辑同源了、输入测量没同源。已对齐修复，第005讲 dry 全绿实证（cosmetic 缩 336→172css 清洞）；同轮交付 `.engine/merge.mjs`（b′ 分片终局渲染器，6 章 partial 冒烟五门禁+G6 墨迹全过）与 `.engine/RUNBOOK.md` 全量启动包）。
>
> gapfill 优化实施员轮（2026-08-20，末尾空白专项调查收束）：**P30**（20 处 G2 页尾大空白双根因：①decideGapFill「链盲」——不计算图前 break-after:avoid 标题链头，shard13 八处图被缩到 printH 恰=availCss 仍不回流；②收敛 3 轮截断。修复=链头建模 70/135css + figChainAnnotations + fits 悖论兜底 + big 档链感知重试优先于删 + 轮次 6 带严格递减守卫；`.engine/selftest-gapfill.mjs` 只读复扫 ALL PASS，含 154 点新旧全同网格回归与 shard02-flow 冒烟零 diff）；**P31**（P0 意外发现：已交付「全419讲」实缺模块01 共 105 节——Aug19 的 5 章 shard02 旧片被「已存在跳过」放行 + QC FAIL 无交付阻断；修复=render/assemble 双陈旧守卫 + QC-fail 改名隔离；当前成品未动，重处理待用户裁决）。末页/模块末页 10 处豁免空白定性为结构性边界（片末页无次页图可拉），结论在案。

门禁终态（v1.18.1，lasso 工作树）：`npm run build` ✅ / `npm test` 2308 passed + 1 skipped（140 文件）✅ / `npm run check-invariants` 82/82 ✅。

## 索引

### 产品缺陷（6，全修复）

| # | 条目 | 一句话 | 修复 | 版本 |
|---|---|---|---|---|
| P1 | [登录窗口被 server 退出关闭](P1-登录窗口被server退出关闭.md) | 停机路径无条件关台账全部 Chrome，杀死用户登录中的 visible 窗口 | chrome-stop `modes` 过滤 + 停机传 `["hidden"]` + reaper visible 豁免（注：exit 钩子漏口见 P4） | v1.17.3 |
| P4 | [exit 钩子 stopLaunchedChromesSync 无 modes 过滤](P4-exit钩子stopLaunchedChromesSync无modes过滤.md) | P1 免疫只覆盖优雅停机；exit 钩子同步路径仍整树 SIGKILL visible | Sync 版同款 modes 过滤 + 注入面 + 6 测 + INV-82(a)（doc/28 工作流实施，质检官验证） | v1.18.0 |
| P5 | [evaluate 上游错误假成功 outcome=worked](P5-evaluate上游错误假成功-outcome-worked.md) | isError 不检，超时/零页/脚本堆栈全被当 preview 返回 | doEvaluate 补 isError throw + 窄签名兜底（doWait 同范式）+ 5 测 | v1.18.1 |
| P6 | [零 tab hidden Chrome 首 navigate 报 No page selected](P6-零tab-hidden-Chrome首navigate报No-page-selected.md) | 遗留 Chrome（台账空）零页时两条预建路径全漏（判定门跳过 + 零页列表 parse null silent bail） | browseSingle 自愈钩子（No page selected → CDP 预建 background tab + select_page → 原样重试一次）+ 8 测 | v1.18.1 |
| P8 | [launch-chrome visible 冷启动探活竞态误报 cdp_not_ready](P8-launch-chrome-visible冷启动探活竞态误报-cdp_not_ready.md) | 3s 探活窗口对可见档冷启动不充分，慢启动被判死 | visible 档窗口 3s→12s（40 次）+ `mayStillBeStarting:true` 诚实标注 + probeAttempts 注入 + 4 测 | v1.18.1 |
| P10 | [lasso pdf action 上游工具缺失](P10-lasso-pdf-action-upstream-tool-missing.md) | 锁定的 chrome-devtools-mcp@1.7.0 无 `pdf` 工具；白导航一次后 unknown 假可重试 | browseSingle 导航前 listTools 前置门（per-client 缓存）→ 诚实 didnt + upstream_unsupported；classify 认 tool-not-found → didnt + 5 测 | v1.18.1 |

### 预期行为（3，结论在案）

| # | 条目 | 一句话 | 结论 |
|---|---|---|---|
| P3 | [server 停机收尾杀 hidden 台账 Chrome](P3-server停机收尾杀hidden台账Chrome.md) | 短命 MCP server 退出即杀台账 Chrome | hidden「用完即关」是设计语义；短命脚本接力工作流的正确模式 = 每批 launch→干活→退出→重来（登录态在磁盘 profile 不丢）。附带优化机会（stop 先于 restore 致日志 cdp_unreachable）记录未实施 |
| P7 | [得到侧栏虚拟列表——远端回收与 DOM 顺序不稳定](P7-得到侧栏虚拟列表-远端回收与DOM顺序不稳定.md) | 静态 DOM 拿不到全量章节树 | SPA 虚拟列表设计使然；正确枚举 = 慢滚动 + 每步快照 + 按章节名合并去重（scout6.mjs 范式），幂等键用 header 文本 |
| P11 | [打印空白尾页——尾部 margin](P11-print-blank-trailing-page-tail-margin.md) | 发刊词 15 页末页全空白 | 浏览器打印按布局高度分页，尾部 margin/零高覆盖层顶过页边界即空白尾页；已在抽取脚本内置根治（尾部 margin 归零，15→14 页，前后末页 md5 一致零损失） |
| P14 | [二轮探察+实施：宣传图判据/分页断点/全量预研（含 §7 实施补记）](P14-探察-二轮.md) | 尾部宣传图判据（M2∧M3∧M4+md5 金标）、分页洞测量、S-A/S-A' 修复配方设计与实施 | 判据 4/4 章验证；v2 管线 3/3 章洞清零+零丢失+promo 零出现；scale 参数实测否决；超页高图 break-inside 实测无效→条带化根治 |
| P15 | [分页断点行为判定：产品 or 管线](P15-分页断点行为判定-产品or管线.md) | 图放不下整块推页留洞 / 超页高图锁定页边界切片 / 屏幕≠打印落位 | 三者皆产品侧（Chrome CSS 碎片化规范行为，非 bug）；修复杠杆全在管线侧（缩放+条带化+打印反馈闭环），配方已落地验证 |

### 环境 / 平台限制（4，结论在案）

| # | 条目 | 一句话 | 结论 |
|---|---|---|---|
| P2 | [日常浏览器不能复用](P2-日常浏览器不能复用.md) | 用户已开的 Chrome 连不上 | Chrome 无 CDP 端口不可事后附加 + 136+ 禁默认 profile 调试；独立 profile + 一次性登录已是限制下最优 |
| P9 | [既有 Chrome wedge 致 CDP 会话全超时](P9-既有Chrome-wedge致CDP会话调用全部超时.md) | HTTP 层活但所有页级调用 60s 超时 | Chrome 侧 wedge（长时间运行 + 未完成停机收尾后），未再复现；遇此形态直接判死重启（profile 登录态无损） |
| P12 | [Read 工具对 PDF/PNG 无视觉呈现](P12-read-pdf-visual-not-available.md) | 校验环节 Read 只回 CDN 回执 | 沙箱无图像呈现通道；两段式机械化校验替代（pdftoppm 渲染 + VLM 问询 + 页级 md5 对比） |
| P13 | [台账陈旧条目 port9222/pid42](P13-台账陈旧条目-port9222-pid42.md) | 本批窗口内台账冒出非本管线条目 | pid 已死 + 停机归属验证会跳过，无实害；台账路径被并行会话共享写入——下批以 `curl :9226/json/version` + pgrep 实测为准，勿信台账判归属 |

## 相关文件

- 探察总报告：`00-探察报告.md`（同目录）
- 抽取产物：`../课前必读(1讲)/`、`../01-经济学本源之一：东西不够(110讲)/`、章节树 `../章节树.json`
- 抽取脚本（含 CDP 直连打印参考实现）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/.dedao-extract/`
- lasso 并行工作流（P4 + v1.18.0 全量）：`/Users/wangdong/Documents/Project/cc-control-all/lasso/doc/28-静默守则审计/`
